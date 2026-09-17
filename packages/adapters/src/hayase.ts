/**
 * Extension packs published for Hayase, and for the client it forked from.
 *
 * These are plain JavaScript — no bytecode, no packaging — so this is the one
 * `browse-only` format that is browse-only for a *product* reason rather than a
 * technical one. `contract/plugin-api/FOREIGN.md` §4.2: extensions here declare
 * `"type": "torrent"` and return magnet links. Yorozo's players take an HTTP
 * url; neither shaka nor libmpv can play a magnet, and there is no torrent
 * client in the product.
 *
 * **That stopped being true, and this format converts now.** `ABI.md` §1 has
 * `TorrentDescriptor`; a resolve answering with descriptors and no direct link
 * is a pass; and the host owns acquisition behind `TorrentAcquisition`, with
 * its own pairing and consent. So a row's info hash is handed back and the
 * host decides what it can do with it — the same division the Stremio adapter
 * already relies on. Nothing here acquires anything.
 *
 * The index's `url` field is base64 of the source's own address. It is decoded
 * only to derive the host list a consent screen would show; nothing here stores
 * or displays it, and no such address is written into this repository.
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
import { packageBundle } from '@plugin-bridge/core/package';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { hayaseEntrypoint } from '@plugin-bridge/runtime/shims/hayase-entry';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/** Base64 that never throws: an undecodable field simply grants no host. */
function decodeUrl(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	try {
		const decoded = atob(value);
		return decoded.startsWith('http') ? decoded : null;
	} catch {
		return null;
	}
}

/**
 * The modules an extension imports from its own repository, fetched.
 *
 * Eight of the measured extensions split a helper out — `./utils.js`,
 * `./lib/shared.js` — and without it the entry module converts, loads, and
 * throws `parseFeed is not defined` at the first search. Resolving them is
 * therefore part of reading the extension, not an extra.
 *
 * ## What is refused, and why each rule is here
 *
 * - **Only relative specifiers.** A bare one (`node:fs`, a package name) is a
 *   dependency this runtime does not have, and inventing a fetch for it would
 *   turn a named refusal into a mystery at call time.
 * - **Only under the same repository, at the same ref.** Resolution is against
 *   the artifact's own URL, and the result must still begin with the
 *   `<owner>/<repo>/<ref>/` the artifact came from. `../../../other/repo/x.js`
 *   resolves to a real URL on the same forge, and fetching it would let one
 *   listing pull code from a repository nobody added — provenance laundering,
 *   not a module system.
 * - **Bounded.** Depth and count are capped, because how many requests one
 *   conversion costs must not be a property of somebody else's repository.
 *
 * `abstract.js` is skipped rather than fetched: the runtime defines that base
 * class itself, so fetching it would be a request whose answer is discarded.
 *
 * Deepest first, so a helper is declared before whatever reads it, and each
 * URL appears once however many modules import it — which is also what stops a
 * cycle.
 */
/**
 * The hosts a source names, including the ones it wrote in base64.
 *
 * This ecosystem habitually stores its own address encoded —
 * `url = atob("aHR0cHM6Ly8…")` — and a scanner reading the source as text sees
 * a meaningless string. The consequence is not cosmetic: `hosts` is the
 * allowlist the sandbox enforces, so an address nobody could see is an address
 * the plugin is refused at request time, reported as *"tried to reach X, which
 * it did not declare"*. Measured on a live repository, that is exactly what
 * happened.
 *
 * So every base64-looking literal is decoded and scanned too. Decoding is
 * discovery, not trust: whatever is found still has to be shown to a viewer as
 * a declared host, and a plugin still cannot reach anything outside the list.
 * A literal that is not base64, or decodes to nothing url-shaped, contributes
 * nothing and costs one failed parse.
 */
function hostsInEncodedSource(source: string): string[] {
	const found = new Set<string>();
	for (const match of source.matchAll(/['"`]([A-Za-z0-9+/]{16,}={0,2})['"`]/g)) {
		let decoded: string;
		try {
			decoded = Buffer.from(match[1], 'base64').toString('utf8');
		} catch {
			continue;
		}
		// Read as a URL rather than handed back to the source scanner: that one
		// looks for addresses written inside string literals, and what comes
		// out of a decode is a bare address with no literal around it.
		for (const address of decoded.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
			try {
				const host = new URL(address[0]).hostname.toLowerCase();
				if (host.includes('.')) found.add(host);
			} catch {
				// Not an address after all; a decode that happens to contain
				// "://" is not evidence of one.
			}
		}
	}
	return [...found];
}

const MAX_MODULES = 12;
const MAX_DEPTH = 3;

/** `https://host/owner/repo/ref/` — everything a sibling must stay inside. */
function repositoryRoot(artifactUrl: string): string | null {
	let url: URL;
	try {
		url = new URL(artifactUrl);
	} catch {
		return null;
	}
	const segments = url.pathname.split('/').filter((one) => one.length > 0);
	if (segments.length < 4) return null;
	return `${url.origin}/${segments.slice(0, 3).join('/')}/`;
}

async function repositoryModules(
	script: string,
	artifactUrl: string,
	getText: TextFetcher
): Promise<{ specifier: string; source: string }[]> {
	const found = repositoryRoot(artifactUrl);
	if (found === null) return [];
	// Bound outside the closure: narrowing does not reach into one, and the
	// prefix check is the whole provenance guarantee.
	const root: string = found;

	const seen = new Set<string>([artifactUrl]);
	const collected: { specifier: string; source: string }[] = [];

	async function walk(source: string, base: string, depth: number): Promise<void> {
		if (depth > MAX_DEPTH) return;
		for (const match of source.matchAll(/^[ \t]*import\s[\s\S]*?\sfrom\s*['"](\.[^'"]*)['"]/gm)) {
			if (collected.length >= MAX_MODULES) return;
			const specifier = match[1];
			if (/abstract\.js$/.test(specifier)) continue;

			let resolved: string;
			try {
				resolved = new URL(specifier, base).toString();
			} catch {
				continue;
			}
			if (!resolved.startsWith(root) || seen.has(resolved)) continue;
			seen.add(resolved);

			let body: string;
			try {
				body = await getText(resolved);
			} catch {
				// Left out rather than fatal: the entry module then refuses by
				// the missing symbol's own name, which says more than "a file
				// this build expected was not there".
				continue;
			}
			await walk(body, resolved, depth + 1);
			collected.push({ specifier, source: body });
		}
	}

	await walk(script, artifactUrl, 0);
	return collected;
}

export const hayaseAdapter: ForeignAdapter = {
	format: 'hayase',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		return ['hayase/index.json', 'index.json'].flatMap((path) =>
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
			throw new ForeignFormatError('not a Hayase extension index');
		}

		// `manifestVersion` on the entries themselves is what distinguishes this
		// from the several other ecosystems that publish an array in index.json.
		const rows = decoded.filter(
			(entry): entry is Record<string, unknown> =>
				typeof entry === 'object' &&
				entry !== null &&
				typeof (entry as Record<string, unknown>)['manifestVersion'] === 'number' &&
				typeof (entry as Record<string, unknown>)['code'] === 'string'
		);
		if (rows.length === 0) throw new ForeignFormatError('not a Hayase extension index');

		const plugins = rows.map((row) => {
			const id = String(row['id'] ?? row['name']);
			const code = new URL(String(row['code']), indexUrl).toString();
			return foreignListing({
				id: convertedPluginId('hayase', id),
				name: String(row['name'] ?? id),
				description: String(row['description'] ?? ''),
				version: String(row['version'] ?? '0'),
				author: '',
				language: Array.isArray(row['languages']) ? String(row['languages'][0] ?? '') : null,
				hosts: hostsFromUrls([decodeUrl(row['url']), code]),
				origin: {
					format: 'hayase',
					artifactUrl: code,
					foreignId: id,
					foreignVersion: String(row['version'] ?? '0'),
					// Every extension in this ecosystem is an anime torrent source.
					// Classified as anime so the row explains the *real* obstacle —
					// no torrent client — rather than the wrong one.
					mediaKind: 'anime',
					// These sources have no catalogue to search — they answer
					// about a title the caller already names. Several of them
					// additionally *require* an AniList id and refuse without
					// one, which the host holds for an AniList-keyed show. See
					// `ExternalIdKind`: the id is handed over, never derived.
					idKinds: ['anilist'],
					isNsfw: row['nsfw'] === true
				}
			});
		});

		return keepMediums({
			name: 'Hayase extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'hayase'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'hayase') {
			throw new ForeignFormatError('That listing did not come from a Hayase repository.');
		}
		const script = new TextDecoder().decode(await services.fetchArtifact(origin.artifactUrl));
		const modules = await repositoryModules(script, origin.artifactUrl, services.getText);

		// The index names the source's own address; the code names everywhere
		// else it goes — an indexer's API, a mirror, whatever a helper module
		// reaches for. Declaring only the first produces a plugin refused the
		// moment it searches, which reads as a broken source rather than as our
		// under-declaration.
		const hosts = [
			...new Set([
				...listing.hosts,
				...hostsInSource(script),
				...hostsInEncodedSource(script),
				...modules.flatMap((one) => [
					...hostsInSource(one.source),
					...hostsInEncodedSource(one.source)
				])
			])
		].sort();

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0
					? `Converted Hayase source. ${listing.description}`
					: 'Converted Hayase source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource: hayaseEntrypoint({ pluginId: listing.id, script, modules }),
			settings: []
		});
	}
};
