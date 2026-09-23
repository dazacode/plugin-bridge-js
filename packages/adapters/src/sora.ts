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
 *   manifest's container ahead of anything its extension suggests — the module
 *   author knows what their source serves. It is read case-insensitively by
 *   the shared rule every shim uses (`__streamContainer`).
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
	keepMediums,
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
import type { ForeignMedium } from '@plugin-bridge/core/formats';

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
 * Every medium a module is for, from the manifest or from the library that
 * listed it.
 *
 * **These declarations are sets, and returning one value threw the rest
 * away.** `movies/shows/anime` is the single most common `type` in the
 * measured library, and it claims three mediums, not a first one. Collapsing
 * it to `anime` on first mention filed KissAsian — a Korean/Chinese/Japanese
 * drama site whose own description says *doramas asiáticos y películas* —
 * under anime, after which the one filter that reads the medium never asked
 * it for a live-action title again. The source looked broken; it was never
 * asked.
 *
 * So this returns all of them, and `mediaKindOf` takes the first for the one
 * place that genuinely needs a single value (which row a listing is filed
 * under). Precedence for that first value is unchanged.
 *
 * **Both fields are free text and neither is an enum.** Measured across one
 * live library of 69: manifests declare `type` as `anime`, but also
 * `shows/movies/anime`, `anime/movies`, `movies/shows`, `mangas`, `novels`. The
 * library's own `category` is written the same way. So every value is read as
 * a *mention* of a medium rather than matched exactly.
 *
 * This is not a stylistic choice. Matching `type === 'anime'` exactly and
 * treating every other non-empty value as `manga` dropped **22 anime modules
 * of 56** from that library — they said `movies/shows/anime`, and a module
 * that is filtered out is a module nothing ever explains. The same reasoning
 * is why an unrecognised word — no anime, no manga, no novel, none of the
 * live-action words either — reads as `live-action` rather than falling into
 * `manga` by elimination: Sora is a general video-streaming ecosystem, and
 * "no medium word matched" described a live-action provider a great deal more
 * often than it described a manga one.
 *
 * Defaulting to anime when neither field says anything is the existing
 * behaviour and stays: this client has always had somewhere to put anime, so a
 * wrong `anime` shows a row that explains itself, where a wrong `manga` or
 * `novel` would have hidden a module silently before either of those could be
 * shown at all.
 */
function mediaKindsOf(manifest: SoraManifest, category?: string): ForeignMedium[] {
	const said = [manifest.type, category].filter(
		(one): one is string => typeof one === 'string' && one.length > 0
	);
	if (said.length === 0) return ['anime'];

	const found: ForeignMedium[] = [];
	if (said.some((one) => /anime/i.test(one))) found.push('anime');
	// `movies`, `shows`, `series`, `dramas`, `tv`: the words these manifests
	// actually use for live-action. Matched explicitly rather than inferred
	// from the absence of the others, because a declaration that names both
	// anime *and* shows has to produce both, and "nothing else matched" cannot
	// say that.
	if (said.some((one) => /movie|show|series|drama|\btv\b|film/i.test(one))) {
		found.push('live-action');
	}
	if (said.some((one) => /manga|comic/i.test(one))) found.push('manga');
	if (said.some((one) => /novel/i.test(one))) found.push('novel');

	// Something was declared and no medium word matched it. Sora is a general
	// video-streaming ecosystem, so an unrecognised word described a
	// live-action provider far more often than anything else — see above.
	return found.length === 0 ? ['live-action'] : found;
}

/** The one medium a listing is filed under: its first declared mention. */
function mediaKindOf(manifest: SoraManifest, category?: string): ForeignMedium {
	return mediaKindsOf(manifest, category)[0];
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
		// `scriptUrl` is deliberately **not** here. It is where the module is
		// downloaded from, not anywhere it goes: `convert` fetches it once
		// through `services.fetchArtifact`, which is the host's own fetcher and
		// runs before any sandbox exists, and a converted bundle has no business
		// fetching its own source at runtime (`mangayomi.ts` drops
		// `sourceCodeUrl` for exactly this reason). Including it granted every
		// module published on GitHub raw a standing read of
		// `raw.githubusercontent.com` — and, via the wildcard, of every file
		// GitHub serves for every public repository — for a request none of them
		// makes.
		hosts: hostsFromUrls([
			typeof manifest.baseUrl === 'string' ? manifest.baseUrl : null,
			typeof manifest.searchBaseUrl === 'string' ? manifest.searchBaseUrl : null
		]),
		origin: {
			format: 'sora',
			artifactUrl: scriptUrl,
			foreignId: name,
			foreignVersion: String(manifest.version ?? '1.0.0'),
			// The medium the row is filed under, and then everything the module
			// actually claimed — these manifests routinely name three.
			mediaKind: mediaKindOf(manifest, category),
			mediaKinds: mediaKindsOf(manifest, category),
			isNsfw: false,
			// Everything `convert` needs, resolved now while the manifest is in
			// hand. Conversion then depends on the listing alone.
			detail: {
				baseUrl: typeof manifest.baseUrl === 'string' ? manifest.baseUrl : '',
				searchBaseUrl: typeof manifest.searchBaseUrl === 'string' ? manifest.searchBaseUrl : '',
				// Verbatim, and read in the bundle by the shared container rule
				// (`__streamContainer` in stream-guards). Collapsing it here used to
				// send every value but exactly "mp4" to HLS — `MKV` included.
				streamType: typeof manifest.streamType === 'string' ? manifest.streamType : '',
				softsub: manifest.softsub === true
			}
		}
	});
}

/**
 * A live library has listed the same declared name twice — two quality tiers
 * of one site, or a plain duplicate entry — and `convertedPluginId` collapsed
 * both onto one id, the one shape this format's id scheme did not plan for.
 * Undetected, two rows share a Svelte keyed-each id and the render throws for
 * the whole list, not just the pair.
 *
 * Rewritten from each colliding listing's own script URL rather than its
 * position in the array, so the result does not depend on fetch order — and
 * left untouched for every name that is not colliding, so this cannot move an
 * id already written into a stored `SourceBinding`.
 *
 * That still leaves one case: a library entry published twice, byte for byte
 * — same name, same script. There is nothing about the second one to key an
 * id on, so it is dropped rather than given one indistinguishable from the
 * first. Whichever the source array names first survives; a true duplicate
 * has no other listing to prefer over it.
 */
function disambiguateIds(plugins: readonly RepositoryPlugin[]): RepositoryPlugin[] {
	const byId = new Map<string, number>();
	for (const plugin of plugins) byId.set(plugin.id, (byId.get(plugin.id) ?? 0) + 1);

	const rewritten = plugins.map((plugin) => {
		if ((byId.get(plugin.id) ?? 0) <= 1) return plugin;
		const artifactUrl = plugin.origin?.artifactUrl ?? '';
		return { ...plugin, id: convertedPluginId('sora', `${plugin.name} ${artifactUrl}`) };
	});

	const seen = new Set<string>();
	return rewritten.filter((plugin) => {
		if (seen.has(plugin.id)) return false;
		seen.add(plugin.id);
		return true;
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

		const plugins = disambiguateIds(found.map((manifest) => listingOf(manifest, indexUrl)));

		return keepMediums({
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

		return keepMediums({
			name: 'Sora modules',
			updatedAt:
				typeof (decoded as Record<string, unknown>)['lastUpdated'] === 'string'
					? String((decoded as Record<string, unknown>)['lastUpdated'])
					: '',
			signingKey: null,
			// Resolved against the manifest's own URL, not the library's: a
			// manifest names its script relative to itself, and they sit in
			// different directories.
			plugins: disambiguateIds(
				manifests.map((one) => listingOf(one.manifest, one.url, one.category))
			),
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
				// A listing parsed before `streamType` was carried has the old
				// collapsed `container` instead, which is still a declaration.
				streamType:
					typeof detail['streamType'] === 'string'
						? detail['streamType']
						: typeof detail['container'] === 'string'
							? detail['container']
							: '',
				softsub: detail['softsub'] === true
			})
		});
	}
};
