/**
 * Sora modules — the one adapted format that converts.
 *
 * A module is two files: a small JSON manifest naming the script, the site and
 * the stream container, and a plain ES5-ish `.js` exporting four async
 * functions. There is no bytecode, no packaging and no build step, which is
 * why this is the format stage one converts and the others browse.
 *
 * The mapping onto `contract/plugin-api/ABI.md` §1 is close to one to one:
 *
 * | Sora | Yorozo |
 * | --- | --- |
 * | `searchResults(keyword)` | `searchCatalog(query, page, ctx)` |
 * | `extractDetails(url)` + `extractEpisodes(url)` | `listEpisodes(ref, ctx)` |
 * | `extractStreamUrl(url)` | `resolve(ref, episode, ctx)` |
 *
 * The differences that matter, and where they are absorbed:
 *
 * - A module reaches the network through a `fetchv2` global, not through a
 *   context object. `shims/js-runtime.ts` provides it over `ctx.http`, so the
 *   host still decides every request and the module still cannot open a socket.
 * - A module returns JSON *strings* from every function, not objects. The
 *   entry shim parses them, because a plugin that returns a string where the
 *   ABI says object is a plugin that fails at the boundary with a useless
 *   message.
 * - `streamType` is per module, not per stream, so a resolved url inherits the
 *   manifest's container rather than being sniffed from its extension —
 *   sniffing is how you get a black screen and no error.
 *
 * ## Two index shapes
 *
 * A single module publishes one `module.json`. A library publishes an array of
 * them, or of `{ metadata }` wrappers pointing at them. Both are accepted:
 * people paste whichever they were given.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepAnimeOnly,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter,
	type TextFetcher
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';
import { packageBundle } from '@plugin-bridge/core/package';
import { soraEntrypoint } from '@plugin-bridge/runtime/shims/sora-entry';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** The manifest fields this adapter reads. Everything else is ignored. */
interface SoraManifest {
	readonly sourceName?: unknown;
	readonly author?: unknown;
	readonly version?: unknown;
	readonly language?: unknown;
	readonly streamType?: unknown;
	readonly baseUrl?: unknown;
	readonly searchBaseUrl?: unknown;
	readonly scriptUrl?: unknown;
	readonly type?: unknown;
	readonly asyncJS?: unknown;
	readonly streamAsyncJS?: unknown;
	readonly softsub?: unknown;
}

function isManifest(value: unknown): value is SoraManifest {
	if (typeof value !== 'object' || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row['sourceName'] === 'string' && typeof row['scriptUrl'] === 'string';
}

/** A library entry may wrap the manifest one level down. */
function unwrap(value: unknown): SoraManifest | null {
	if (isManifest(value)) return value;
	if (typeof value === 'object' && value !== null) {
		const inner = (value as Record<string, unknown>)['metadata'];
		if (isManifest(inner)) return inner;
	}
	return null;
}

function authorName(value: unknown): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'object' && value !== null) {
		const name = (value as Record<string, unknown>)['name'];
		if (typeof name === 'string') return name;
	}
	return 'unknown';
}

/**
 * `streamType` to a container we play.
 *
 * Defaults to HLS rather than MP4 because that is what these modules
 * overwhelmingly return, and because an adaptive manifest opened as
 * progressive fails immediately and legibly, where the reverse buffers
 * forever.
 */
/**
 * What a module is for, from the manifest or from the library that listed it.
 *
 * **Both fields are free text and neither is an enum.** Measured across one
 * live library of 69: manifests declare `type` as `anime`, but also
 * `shows/movies/anime`, `anime/movies`, `movies/shows`, `mangas`, `novels`. The
 * library's own `category` is written the same way. So both are read as a
 * *mention* of anime rather than matched exactly.
 *
 * This is not a stylistic choice. Matching `type === 'anime'` exactly and
 * treating every other non-empty value as manga dropped **22 anime modules of
 * 56** from that library — they said `movies/shows/anime`, and a module that is
 * filtered out is a module nothing ever explains.
 *
 * Defaulting to anime when neither field says anything is the existing
 * behaviour and stays: this client has nowhere to put anything else, so a wrong
 * `anime` shows a row that explains itself, and a wrong `manga` hides a module
 * silently.
 */
function mediaKindOf(manifest: SoraManifest, category?: string): 'anime' | 'manga' {
	const said = [manifest.type, category].filter(
		(one): one is string => typeof one === 'string' && one.length > 0
	);
	if (said.length === 0) return 'anime';
	return said.some((one) => /anime/i.test(one)) ? 'anime' : 'manga';
}

function containerOf(streamType: unknown): 'hls' | 'mp4' {
	return String(streamType ?? '').toLowerCase() === 'mp4' ? 'mp4' : 'hls';
}

function listingOf(manifest: SoraManifest, indexUrl: string, category?: string): RepositoryPlugin {
	const scriptUrl = new URL(String(manifest.scriptUrl), indexUrl).toString();
	const name = String(manifest.sourceName);

	return foreignListing({
		id: convertedPluginId('sora', name),
		name,
		description: typeof manifest.language === 'string' ? String(manifest.language) : '',
		version: String(manifest.version ?? '1.0.0'),
		author: authorName(manifest.author),
		language: typeof manifest.language === 'string' ? manifest.language : null,
		hosts: hostsFromUrls([
			typeof manifest.baseUrl === 'string' ? manifest.baseUrl : null,
			typeof manifest.searchBaseUrl === 'string' ? manifest.searchBaseUrl : null,
			scriptUrl
		]),
		origin: {
			format: 'sora',
			artifactUrl: scriptUrl,
			foreignId: name,
			foreignVersion: String(manifest.version ?? '1.0.0'),
			// A module declares `type`, and `anime` is the only value this client
			// has anywhere to put. Anything else is classified as what it says it
			// is so the row can explain itself.
			mediaKind: mediaKindOf(manifest, category),
			isNsfw: false,
			// Everything `convert` needs, resolved now while the manifest is in
			// hand. Conversion then depends on the listing alone.
			detail: {
				baseUrl: typeof manifest.baseUrl === 'string' ? manifest.baseUrl : '',
				searchBaseUrl: typeof manifest.searchBaseUrl === 'string' ? manifest.searchBaseUrl : '',
				container: containerOf(manifest.streamType),
				softsub: manifest.softsub === true
			}
		}
	});
}

export const soraAdapter: ForeignAdapter = {
	format: 'sora',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		return ['modules.json', 'index.json', 'module.json'].flatMap((path) =>
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

		const entries = Array.isArray(decoded) ? decoded : [decoded];
		const found = entries.map(unwrap).filter((m): m is SoraManifest => m !== null);
		if (found.length === 0) throw new ForeignFormatError('not a Sora module or library');

		const plugins = found.map((manifest) => listingOf(manifest, indexUrl));

		return keepAnimeOnly({
			name: plugins.length === 1 ? plugins[0].name : 'Sora modules',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'sora'
		});
	},

	/**
	 * A library index that *points at* manifests rather than embedding them.
	 *
	 * The third shape this format is published in, and the one a repository of
	 * many modules actually uses: `{ modules: [{ manifestUrl, category, … }] }`,
	 * where each entry names a manifest one fetch away. `parseIndex` handles the
	 * two shapes that need no fetching — a pasted manifest, and a list with the
	 * manifests inline — and this handles the one that does, which is why the
	 * core's optional `loadIndex` hook exists at all.
	 *
	 * Delegating to `parseIndex` first is deliberate: that is the cheap answer,
	 * it is the shape a person gets when they paste a single module, and a
	 * library index never parses as one, so trying costs a JSON parse and
	 * settles the question.
	 */
	async loadIndex(body: string, indexUrl: string, getText: TextFetcher): Promise<RepositoryIndex> {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		const modules =
			typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
				? (decoded as Record<string, unknown>)['modules']
				: undefined;
		const entries = Array.isArray(modules)
			? modules.filter(
					(one): one is Record<string, unknown> =>
						typeof one === 'object' && one !== null && typeof one['manifestUrl'] === 'string'
				)
			: [];
		if (entries.length === 0) return soraAdapter.parseIndex(body, indexUrl);

		// Fetched a few at a time. A library of seventy modules is seventy
		// requests to one host, and asking for them all at once is the shape
		// that gets a repository to rate-limit a viewer who only wanted a list.
		const manifests: { manifest: SoraManifest; url: string; category?: string }[] = [];
		const failed: string[] = [];
		const queue = [...entries];
		const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
			for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
				const url = new URL(String(next['manifestUrl']), indexUrl).toString();
				try {
					const found = unwrap(JSON.parse(await getText(url)));
					// A manifest that does not parse is skipped, not fatal. One
					// broken entry in a library of seventy is the repository's
					// problem with that module, and refusing the whole list for it
					// would make every other module unreachable.
					if (found === null) failed.push(url);
					else
						manifests.push({
							manifest: found,
							url,
							category: typeof next['category'] === 'string' ? next['category'] : undefined
						});
				} catch {
					failed.push(url);
				}
			}
		});
		await Promise.all(workers);

		if (manifests.length === 0) {
			throw new ForeignFormatError('no module in this library had a readable manifest');
		}

		return keepAnimeOnly({
			name: 'Sora modules',
			updatedAt:
				typeof (decoded as Record<string, unknown>)['lastUpdated'] === 'string'
					? String((decoded as Record<string, unknown>)['lastUpdated'])
					: '',
			signingKey: null,
			// Resolved against the manifest's own URL, not the library's: a
			// manifest names its script relative to itself, and they sit in
			// different directories.
			plugins: manifests.map((one) => listingOf(one.manifest, one.url, one.category)),
			format: 'sora'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const { fetchArtifact } = services;
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'sora') {
			throw new ForeignFormatError('That listing did not come from a Sora repository.');
		}
		const detail = origin.detail ?? {};

		const script = new TextDecoder().decode(await fetchArtifact(origin.artifactUrl));

		// The manifest names where the source lives; the code names everywhere
		// else it goes — the API subdomain, the embed host, the CDN the stream
		// actually comes from. Declaring only the first produces a plugin that
		// searches and is then refused the moment it resolves, which reads as a
		// broken source rather than as our under-declaration.
		const hosts = [...new Set([...listing.hosts, ...hostsInSource(script)])].sort();

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0
					? `Converted Sora module. ${listing.description}`
					: 'Converted Sora module.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource: soraEntrypoint({
				pluginId: listing.id,
				script,
				baseUrl: String(detail['baseUrl'] ?? ''),
				container: detail['container'] === 'mp4' ? 'mp4' : 'hls',
				softsub: detail['softsub'] === true
			})
		});
	}
};
