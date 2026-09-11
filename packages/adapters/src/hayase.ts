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
 * The adapter ships anyway so that pasting one of these repositories gives a
 * catalogue and a sentence, rather than "no plugin repository was found there"
 * — which would be indistinguishable from a typo. When a torrent client exists,
 * only `formats.ts` and `convert` below change.
 *
 * The index's `url` field is base64 of the source's own address. It is decoded
 * only to derive the host list a consent screen would show; nothing here stores
 * or displays it, and no such address is written into this repository.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	keepAnimeOnly,
	refuseConversion,
	ForeignFormatError,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';
import type { RepositoryIndex } from '@plugin-bridge/core/repository-index';

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
					isNsfw: row['nsfw'] === true
				}
			});
		});

		return keepAnimeOnly({
			name: 'Hayase extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'hayase'
		});
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('hayase');
	}
};
