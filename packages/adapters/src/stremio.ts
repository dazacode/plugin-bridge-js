/**
 * Addons published for Stremio, read as a plugin repository.
 *
 * ## One manifest is one addon, and that is the whole index
 *
 * Every other adapter here parses a *list*: a repository document naming
 * dozens of extensions, each with its own artifact to fetch. This ecosystem
 * has no such document. An addon is a URL, and its `/manifest.json` describes
 * exactly one source — so `parseIndex` returns a single listing, and the
 * "repository" a viewer pastes is the addon itself.
 *
 * That is not a degenerate case to apologise for; it is what makes the format
 * cheap. There is no artifact to download, no bytecode to translate and no
 * classpath to provide. `stremio-entry.ts` generates a client for the
 * published protocol and the manifest supplies its four constants.
 *
 * ## Configuration is part of the URL
 *
 * Addons that need a key or a preference set say so with
 * `behaviorHints.configurable`, and the viewer configures them on the addon's
 * own page, which hands back a URL with their settings encoded as a path
 * segment. So a configured addon and a plain one differ only in the string
 * pasted, and this adapter treats everything before `/manifest.json` as an
 * opaque base. Nothing here parses that segment, and nothing logs it — it may
 * carry a viewer's own account key.
 *
 * `configurationRequired: true` is the one refusal: that addon answers nothing
 * useful until it has been configured, so installing the unconfigured URL
 * would produce a source that is permanently empty and look like our fault.
 *
 * ## Rule 9
 *
 * No addon URL appears in this file, its tests or its history. The viewer
 * supplies one, exactly as they supply a repository URL for every other
 * format, and detection is by document shape — a JSON body with `id`, `version`
 * and `resources` — never by hostname.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { looksLikeFile } from '@plugin-bridge/core/git-hosts';
import { packageBundle } from '@plugin-bridge/core/package';
import { stremioEntrypoint } from '@plugin-bridge/runtime/shims/stremio-entry';
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** The manifest fields this adapter reads. Everything else is ignored. */
interface StremioManifest {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly version?: unknown;
	readonly description?: unknown;
	readonly types?: unknown;
	readonly resources?: unknown;
	readonly catalogs?: unknown;
	readonly behaviorHints?: unknown;
	readonly logo?: unknown;
	readonly contactEmail?: unknown;
}

/**
 * Whether a parsed document is a manifest at all.
 *
 * Shape, not hostname. `id`, `version` and `resources` are the three the
 * protocol requires of every addon, and a document carrying all three is one
 * whatever it is served from.
 */
function isManifest(value: unknown): value is StremioManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row['id'] === 'string' &&
		typeof row['version'] === 'string' &&
		Array.isArray(row['resources'])
	);
}

/**
 * The resources an addon serves, as plain names.
 *
 * The protocol permits two spellings — `"stream"` and
 * `{ name: "stream", types: [...] }` — and an addon may use both in one list.
 */
function resourceNames(manifest: StremioManifest): string[] {
	if (!Array.isArray(manifest.resources)) return [];
	const names: string[] = [];
	for (const entry of manifest.resources) {
		if (typeof entry === 'string') names.push(entry);
		else if (typeof entry === 'object' && entry !== null) {
			const name = (entry as Record<string, unknown>)['name'];
			if (typeof name === 'string') names.push(name);
		}
	}
	return names;
}

function typeNames(manifest: StremioManifest): string[] {
	if (!Array.isArray(manifest.types)) return [];
	return manifest.types.filter((one): one is string => typeof one === 'string' && one.length > 0);
}

/**
 * The catalogues this addon will answer a title search against.
 *
 * A catalogue declares what extra arguments it accepts, in either of two
 * spellings, and one that does not accept `search` returns its own unfiltered
 * list for any query — which would bind whatever happened to be trending. So
 * only catalogues that say they are searchable are recorded, and an addon with
 * none is searched not at all.
 */
function searchableCatalogues(manifest: StremioManifest): { type: string; id: string }[] {
	if (!Array.isArray(manifest.catalogs)) return [];
	const out: { type: string; id: string }[] = [];
	for (const entry of manifest.catalogs) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const type = row['type'];
		const id = row['id'];
		if (typeof type !== 'string' || typeof id !== 'string') continue;

		const extra = Array.isArray(row['extra']) ? row['extra'] : [];
		const named = extra.some(
			(one) =>
				typeof one === 'object' &&
				one !== null &&
				(one as Record<string, unknown>)['name'] === 'search'
		);
		const supported = Array.isArray(row['extraSupported'])
			? row['extraSupported'].includes('search')
			: false;
		if (named || supported) out.push({ type, id });
	}
	return out;
}

/**
 * What an addon serves, from the types it declares.
 *
 * `movie` and `series` are the protocol's own names for live-action film and
 * television, and `anime` appears as a non-standard fourth that several addons
 * use. `tv` is live channels and `channel` is a publisher's own feed; neither
 * is a medium this maps, and an addon declaring only those classifies as
 * live-action rather than being dropped — it serves video, and the install
 * check is a better judge of whether it serves anything useful than a guess
 * made from a type list.
 */
function mediaKindsOf(manifest: StremioManifest): ForeignMedium[] {
	const types = typeNames(manifest).map((one) => one.toLowerCase());
	const found: ForeignMedium[] = [];
	if (types.some((one) => one.includes('anime'))) found.push('anime');
	if (
		types.some((one) => one === 'movie' || one === 'series' || one === 'tv' || one === 'channel')
	) {
		found.push('live-action');
	}
	return found.length === 0 ? ['live-action'] : found;
}

/** Everything before `/manifest.json`, configuration segment included. */
function baseOf(manifestUrl: string): string {
	return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, '').replace(/\/+$/, '');
}

function listingOf(manifest: StremioManifest, manifestUrl: string): RepositoryPlugin {
	const name =
		typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : 'Addon';
	const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
	const base = baseOf(manifestUrl);
	const resources = resourceNames(manifest);
	const hints =
		typeof manifest.behaviorHints === 'object' && manifest.behaviorHints !== null
			? (manifest.behaviorHints as Record<string, unknown>)
			: {};

	return foreignListing({
		// The addon's own id, not its name: two addons may share a display name
		// and the protocol's id is what distinguishes them.
		id: convertedPluginId('stremio', String(manifest.id)),
		name,
		description: typeof manifest.description === 'string' ? manifest.description : '',
		version,
		author: '',
		language: null,
		// The addon's own host, and nothing else. Where a stream ends up
		// pointing is not knowable from a manifest — it is decided per request,
		// per title, often by a CDN — so it is learned at runtime through the
		// host's own mechanism rather than guessed at here.
		hosts: hostsFromUrls([base]),
		origin: {
			format: 'stremio',
			// There is no artifact. The manifest *is* what conversion reads, and
			// recording it here is what lets an update check re-read it.
			artifactUrl: manifestUrl,
			foreignId: String(manifest.id),
			foreignVersion: version,
			mediaKind: mediaKindsOf(manifest)[0],
			mediaKinds: mediaKindsOf(manifest),
			// The whole reason this format is worth having: the host holds an
			// IMDB id already, so nothing about this source has to be found by
			// searching its catalogue for a title.
			idKinds: ['imdb'],
			isNsfw: false,
			detail: {
				base,
				types: typeNames(manifest),
				resources,
				searchable: searchableCatalogues(manifest),
				configurationRequired: hints['configurationRequired'] === true
			}
		}
	});
}

export const stremioAdapter: ForeignAdapter = {
	format: 'stremio',

	/**
	 * What to try for a pasted URL.
	 *
	 * A viewer pastes whatever their addon's configure page gave them, which is
	 * sometimes the manifest itself and sometimes the directory above it. The
	 * configuration segment is preserved either way, because it is part of the
	 * path and nothing here rewrites paths — only appends one.
	 *
	 * A URL that is already a file is used as given, the same rule every other
	 * adapter follows: appending `/manifest.json` to a `.json` produces a URL
	 * that cannot exist, and buries "that was not a manifest" — which is a
	 * sentence a viewer can act on — under a guaranteed 404.
	 */
	candidates(pasted: URL): string[] {
		const raw = pasted.toString();
		if (looksLikeFile(pasted)) return [raw];
		return [`${raw.replace(/\/+$/, '')}/manifest.json`];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (!isManifest(decoded)) {
			throw new ForeignFormatError('not a Stremio addon manifest');
		}
		// An addon that serves neither streams nor catalogues is a metadata or
		// subtitle provider. Those are real and useful to Stremio itself, and
		// there is nothing this client can do with one: it has its own metadata
		// stack, and a source that cannot produce a stream is not a source.
		const resources = resourceNames(decoded);
		if (!resources.includes('stream')) {
			throw new ForeignFormatError(
				'this addon serves no streams — it provides ' +
					(resources.join(', ') || 'nothing this client can use')
			);
		}

		return keepMediums({
			name: typeof decoded.name === 'string' ? decoded.name : 'Stremio addon',
			updatedAt: '',
			signingKey: null,
			plugins: [listingOf(decoded, indexUrl)],
			format: 'stremio'
		});
	},

	// eslint-disable-next-line @typescript-eslint/require-await
	async convert(listing: RepositoryPlugin, _services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'stremio') {
			throw new ForeignFormatError('That listing did not come from a Stremio addon.');
		}
		const detail = origin.detail ?? {};
		if (detail['configurationRequired'] === true) {
			throw new ForeignFormatError(
				'This addon has to be configured on its own page first. Configuring it there ' +
					'produces a second URL, with your settings in it, and that is the one to paste here.'
			);
		}

		const base = typeof detail['base'] === 'string' ? detail['base'] : '';
		if (base.length === 0) {
			throw new ForeignFormatError('That listing carries no addon address.');
		}

		// No artifact is fetched, because there is none: the bundle is a client
		// for a protocol, and every addon-specific fact it needs was read from
		// the manifest when the listing was made.
		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0 ? `Stremio addon. ${listing.description}` : 'Stremio addon.',
			version: listing.version,
			author: listing.author,
			hosts: listing.hosts,
			origin,
			entrypointSource: stremioEntrypoint({
				pluginId: listing.id,
				baseUrl: base,
				types: Array.isArray(detail['types']) ? (detail['types'] as string[]) : [],
				searchable: Array.isArray(detail['searchable'])
					? (detail['searchable'] as { type: string; id: string }[])
					: []
			}),
			settings: []
		});
	}
};
