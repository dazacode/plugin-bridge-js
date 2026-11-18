/**
 * A Seanime marketplace, as a repository this build can read.
 *
 * ## Two documents, and a listing that reaches one hop
 *
 * The index is an array of marketplace entries; each one names a `manifestURI`
 * and nothing else of use. The manifest names the version, the language and a
 * `payloadURI`, which is the code. So a listing here carries the *first* hop in
 * `origin.detail.manifestURI` and `convert` walks the second — the same shape
 * Nuvio's and Sora's shims already take, and the same reason the origin's
 * `detail` is JSON-only: conversion has to stay a function of the listing.
 *
 * ## The type field is the whole filter
 *
 * Three of the six published `type` values are providers with a catalogue, and
 * three are not:
 *
 * - `manga-provider` and `onlinestream-provider` — a search, a chapter or
 *   episode list, and pages or a stream. Both convert.
 * - `anime-torrent-provider` — a search that answers torrents. Converts, with
 *   `TorrentDescriptor` as the resolve value.
 * - `plugin` — a client plugin: hooks and UI, no catalogue. **Skipped and
 *   counted.** Listing one would put a row on screen that cannot be searched.
 * - `custom-source` — a metadata source, addressed by a title the client
 *   already holds rather than by a search of its own. Skipped for the same
 *   reason.
 *
 * Anything else is skipped and counted too, rather than guessed at, because a
 * type this build has not seen is more likely a new kind of non-provider than a
 * provider that happens to be spelled differently.
 *
 * ## Language
 *
 * `javascript` and `typescript` both convert — the second through the same type
 * stripper the Mana source path uses. Anything else is refused **by name**, at
 * conversion rather than at parse, so the row stays browsable and its refusal
 * says which language it wanted.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { packageBundle } from '@plugin-bridge/core/package';
import { hostsInEncoded, stripTypescript } from './mana';
import { seanimeEntrypoint } from '@plugin-bridge/runtime/shims/seanime-entry';
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/** Where a marketplace might be published, most specific first. */
const MARKETPLACE_PATHS = ['marketplace/main.json', 'marketplace.json', 'main.json'];

/** The three types that are a catalogue, and the medium each serves. */
const PROVIDER_TYPES: Readonly<Record<string, ForeignMedium>> = {
	'manga-provider': 'manga',
	'onlinestream-provider': 'anime',
	'anime-torrent-provider': 'anime'
};

/** Whether a manifest's `language` is one this build can run. */
function runnableLanguage(value: unknown): boolean {
	return value === 'javascript' || value === 'typescript';
}

/** The manifest fields conversion reads. */
interface Manifest {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly version?: unknown;
	readonly author?: unknown;
	readonly description?: unknown;
	readonly language?: unknown;
	readonly type?: unknown;
	readonly payloadURI?: unknown;
}

export const seanimeAdapter: ForeignAdapter = {
	format: 'seanime',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const base = pasted.toString().replace(/\/+$/, '');
		const direct = MARKETPLACE_PATHS.map((path) => `${base}/${path}`);
		const repository = parseRepositoryUrl(pasted);
		const forged =
			repository === null
				? []
				: MARKETPLACE_PATHS.flatMap((path) => rawCandidates(repository, path, DEFAULT_REFS));

		return [...new Set([...direct, ...forged])];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		// An array, always. A marketplace is never an object, and that is most of
		// the negative: the formats that publish one here all publish an object.
		if (!Array.isArray(decoded) || decoded.length === 0) {
			throw new ForeignFormatError('not a Seanime marketplace');
		}

		const rows = decoded.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return (
				typeof row['id'] === 'string' &&
				typeof row['name'] === 'string' &&
				typeof row['manifestURI'] === 'string'
			);
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Seanime marketplace');

		const plugins: RepositoryPlugin[] = [];
		let skipped = 0;

		for (const row of rows) {
			const type = typeof row['type'] === 'string' ? row['type'] : '';
			const medium = PROVIDER_TYPES[type];
			if (medium === undefined) {
				skipped += 1;
				continue;
			}

			let manifestURI: string;
			try {
				manifestURI = new URL(String(row['manifestURI']), indexUrl).toString();
			} catch {
				skipped += 1;
				continue;
			}
			// The origin's `artifactUrl` is https or the listing cannot be
			// installed at all; discovering that at convert time instead would be
			// a row whose button fails rather than one that never appeared.
			if (!manifestURI.startsWith('https://')) {
				skipped += 1;
				continue;
			}

			const id = String(row['id']);
			const language = typeof row['lang'] === 'string' ? row['lang'] : null;

			plugins.push(
				foreignListing({
					id: convertedPluginId('seanime', id),
					name: String(row['name']),
					description: String(row['description'] ?? ''),
					// The marketplace rarely states a version; the manifest does,
					// and conversion copies it across before packaging.
					version: String(row['version'] ?? '0'),
					author: String(row['author'] ?? ''),
					language,
					// The site the provider scrapes — which is what the consent
					// sheet is for — plus the icon. Neither the manifest nor the
					// payload is fetched at runtime, so neither host is granted.
					hosts: hostsFromUrls([
						typeof row['website'] === 'string' ? row['website'] : null,
						typeof row['icon'] === 'string' ? row['icon'] : null
					]),
					origin: {
						format: 'seanime',
						// The first hop. Convert walks to the payload from here.
						artifactUrl: manifestURI,
						foreignId: id,
						foreignVersion: String(row['version'] ?? '0'),
						mediaKind: medium,
						// A torrent provider is the one kind that will never hand
						// back a URL; this is what tells a viewer before they
						// install it that a peer-to-peer client is involved.
						...(type === 'anime-torrent-provider' ? { declaredP2p: true } : {}),
						isNsfw: row['nsfw'] === true,
						detail: {
							manifestURI,
							providerType: type,
							// Carried from the marketplace so the row can be refused
							// by language before any second fetch happens.
							payloadLanguage: typeof row['language'] === 'string' ? row['language'] : ''
						}
					}
				})
			);
		}

		const kept = keepMediums({
			name: 'Seanime marketplace',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'seanime'
		});
		return { ...kept, filteredOut: (kept.filteredOut ?? 0) + skipped };
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'seanime') {
			throw new ForeignFormatError('That listing did not come from a Seanime marketplace.');
		}
		const manifestURI = String(origin.detail?.['manifestURI'] ?? '');
		if (!manifestURI.startsWith('https://')) {
			throw new ForeignFormatError(
				`"${listing.name}" names no https manifest, so there is nothing safe to fetch.`,
				['missingManifest']
			);
		}

		let manifest: Manifest;
		try {
			const decoded: unknown = JSON.parse(await services.getText(manifestURI));
			if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
				throw new Error('not an object');
			}
			manifest = decoded as Manifest;
		} catch {
			throw new ForeignFormatError(
				`The manifest "${listing.name}" points at was not a readable Seanime manifest.`,
				['unreadableManifest']
			);
		}

		// The type is re-read rather than trusted from the index: a row can be
		// edited into a provider in one document and left alone in the other, and
		// the manifest is the file the client itself obeys.
		const type = typeof manifest.type === 'string' ? manifest.type : '';
		const medium = PROVIDER_TYPES[type];
		if (medium === undefined) {
			throw new ForeignFormatError(
				`"${listing.name}" has a manifest of type "${type || 'unstated'}", which has no catalogue ` +
					'to convert.',
				['nonProviderManifest']
			);
		}

		// By name, and before the payload is fetched: what blocks this is the
		// language, not the code.
		const language = typeof manifest.language === 'string' ? manifest.language : '';
		if (!runnableLanguage(language)) {
			throw new ForeignFormatError(
				`"${listing.name}" is written in ${language.length > 0 ? language : 'an unstated language'}. ` +
					'Only JavaScript and TypeScript providers convert; this one needs a runtime this ' +
					'build does not have.',
				['payloadLanguage']
			);
		}

		const payloadURI = new URL(String(manifest.payloadURI ?? ''), manifestURI).toString();
		if (!payloadURI.startsWith('https://')) {
			throw new ForeignFormatError(
				`"${listing.name}" has a manifest that names no https payload.`,
				['missingPayload']
			);
		}

		const payload = await services.getText(payloadURI);

		const script =
			language === 'typescript'
				? // `require` is the runtime's own registry, which throws by name for
					// anything it does not hold — so a payload that imports a sibling
					// module refuses at load instead of arriving as `undefined`.
					stripTypescript(payload, (one) => `require(${JSON.stringify(one)})`).code
				: payload;

		const hosts = [
			...new Set([...listing.hosts, ...hostsInSource(payload), ...hostsInEncoded(payload)])
		].sort();

		return packageBundle({
			id: listing.id,
			name: typeof manifest.name === 'string' ? manifest.name : listing.name,
			description:
				typeof manifest.description === 'string' && manifest.description.length > 0
					? `Converted Seanime provider. ${manifest.description}`
					: 'Converted Seanime provider.',
			version: typeof manifest.version === 'string' ? manifest.version : listing.version,
			author: typeof manifest.author === 'string' ? manifest.author : listing.author,
			hosts,
			origin,
			entrypointSource: seanimeEntrypoint({
				pluginId: listing.id,
				script,
				serves:
					type === 'manga-provider'
						? 'manga'
						: type === 'anime-torrent-provider'
							? 'torrent'
							: 'anime'
			})
		});
	}
};
