/**
 * Source repositories published for Mangayomi.
 *
 * An unusual ecosystem: a listing points at a **source file**, not a package,
 * and names the language it is written in. Roughly two-thirds of a typical
 * catalogue is Dart and the rest JavaScript, so converting it is really two
 * jobs — and only one of them is done here.
 *
 * **The JavaScript half converts.** Those files need no translation at all,
 * only the globals their own host provides: a jsoup-shaped `Document`, a
 * `Client` over HTTP, and an `MProvider` base class. `shims/mangayomi-entry.ts`
 * supplies all three and embeds the source verbatim. **The Dart half refuses**,
 * by name, because it needs an interpreter that does not exist here.
 *
 * The published catalogues under this format's own name are manga and novel
 * sources, which `keepMediums` filters out regardless of language
 * (`contract/plugin-api/FOREIGN.md` §4.3). Third-party anime catalogues are
 * what this converter is for, and `itemType` is what tells them apart.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepMediums,
	refuseConversion,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';
import { packageBundle } from '@plugin-bridge/core/package';
import { mangayomiPreferences, settingKeyMap } from '@plugin-bridge/core/preferences';
import { mangayomiEntrypoint } from '@plugin-bridge/runtime/shims/mangayomi-entry';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** `itemType` as the ecosystem numbers it: manga, anime, novel. */
function mediumOf(row: Record<string, unknown>): ForeignMedium {
	const itemType = row['itemType'];
	if (itemType === 1) return 'anime';
	if (itemType === 2) return 'novel';
	if (itemType === 0) return 'manga';
	// Older entries carry only `isManga`, and a missing flag defaults to manga
	// the same way the ecosystem's own reader defaults it.
	return row['isManga'] === false ? 'anime' : 'manga';
}

/**
 * The listing's own row, carried through to conversion.
 *
 * A converted source reads `this.source.baseUrl` and `this.source.apiUrl`
 * constantly, and a few read the date-format fields. Most source files declare
 * their own copy of this record and that copy is preferred — see
 * `mangayomi-entry.ts` — so this is the fallback for a file that omits it.
 *
 * `sourceCodeUrl` is dropped: it is where the file came from, and a converted
 * bundle has no business fetching its own source at runtime.
 */
function sourceRecord(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(row)) {
		if (key === 'sourceCodeUrl') continue;
		const value = row[key];
		if (value === null) continue;
		const kind = typeof value;
		if (kind === 'string' || kind === 'number' || kind === 'boolean') out[key] = value;
	}
	return out;
}

export const mangayomiAdapter: ForeignAdapter = {
	format: 'mangayomi',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		return ['anime_index.json', 'index.json', 'novel_index.json'].flatMap((path) =>
			rawCandidates(repository, path, DEFAULT_REFS)
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (!Array.isArray(decoded) || decoded.length === 0) {
			throw new ForeignFormatError('not a Mangayomi source index');
		}

		// `sourceCodeUrl` is the field unique to this ecosystem — a listing that
		// points at source rather than at a build.
		const rows = decoded.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			return typeof (entry as Record<string, unknown>)['sourceCodeUrl'] === 'string';
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Mangayomi source index');

		const plugins = rows.map((row) => {
			const id = String(row['id'] ?? row['name']);
			const source = new URL(String(row['sourceCodeUrl']), indexUrl).toString();
			return foreignListing({
				id: convertedPluginId('mangayomi', id),
				name: String(row['name'] ?? id),
				description: '',
				version: String(row['version'] ?? '0'),
				author: '',
				language: typeof row['lang'] === 'string' ? row['lang'] : null,
				hosts: hostsFromUrls([
					typeof row['baseUrl'] === 'string' ? row['baseUrl'] : null,
					typeof row['apiUrl'] === 'string' ? row['apiUrl'] : null,
					source
				]),
				origin: {
					format: 'mangayomi',
					artifactUrl: source,
					foreignId: id,
					foreignVersion: String(row['version'] ?? '0'),
					mediaKind: mediumOf(row),
					isNsfw: row['isNsfw'] === true,
					// `0` is Dart and `1` JavaScript, and it is what decides
					// whether this listing converts at all. Not recoverable from
					// the file alone, so it is recorded while the index is in
					// hand — `refusalFor` reads it back per listing.
					detail: {
						sourceCodeLanguage: row['sourceCodeLanguage'] === 1 ? 'js' : 'dart',
						source: sourceRecord(row)
					}
				}
			});
		});

		return keepMediums({
			name: 'Mangayomi sources',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'mangayomi'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const { fetchArtifact } = services;
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'mangayomi') {
			throw new ForeignFormatError('That listing did not come from a Mangayomi repository.');
		}
		const detail = origin.detail ?? {};

		// The Dart majority. `refuseConversion` throws this format's own
		// refusal, which names the language rather than the format — the
		// JavaScript half of the same repository installs fine.
		if (detail['sourceCodeLanguage'] !== 'js') refuseConversion('mangayomi');

		const script = new TextDecoder().decode(await fetchArtifact(origin.artifactUrl));

		// The index names where the source lives; the code names everywhere else
		// it goes — the API host, the embed host, the CDN the stream actually
		// comes from. Declaring only the first produces a plugin that searches
		// and is then refused the moment it resolves, which reads as a broken
		// source rather than as our under-declaration.
		const hosts = [...new Set([...listing.hosts, ...hostsInSource(script)])].sort();

		const record = detail['source'];

		// What the source says it can be configured with, read out of its own
		// 'getSourcePreferences()'. These sources choose a base URL or a
		// preferred server this way, so a bundle that declared none turned a
		// working source into whichever mirror the author happened to list
		// first. Nothing is invented: a declaration this build cannot read
		// statically produces no settings and the old fallback answers.
		const settings = mangayomiPreferences(script);

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description: 'Converted Mangayomi source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			settings,
			entrypointSource: mangayomiEntrypoint({
				pluginId: listing.id,
				script,
				// Which pair of terminal methods the bundle declares, taken from
				// what the *listing* said it serves rather than from the script.
				// A source for books defines `getPageList` where one for video
				// defines `getVideoList`, and the rest of the file looks alike —
				// so the index row is the only thing here that actually knows.
				serves: origin.mediaKind === 'manga' ? 'manga' : 'video',
				settingIds: settingKeyMap(settings),
				source:
					record !== null && typeof record === 'object' ? (record as Record<string, unknown>) : {}
			})
		});
	}
};
