/**
 * Parser indexes published for Kotatsu.
 *
 * An array per repository, and every row is metadata about a parser rather than
 * an artifact: a `name`, a display `title`, a `contentType`, a base address, an
 * icon, and two flags. What is missing each time is the parser itself — the
 * class behind a name is compiled into the Kotatsu client, so the index says
 * which sites a client already knows and nothing about how to read one. That is
 * the whole of why this format is `browse-only`: there is no code here to
 * translate, and no amount of translator work changes it.
 *
 * Adapting it anyway is worth a page. A repository of several thousand parsers
 * is a real catalogue of sites, and a person pasting one deserves to see it:
 * every title, the language it is for, whether it is adult, and whether the
 * ecosystem itself has given up on it. That last one is why `isBroken` rows are
 * still listed. The flag is Kotatsu's own admission and it is the single most
 * useful thing a reader can be told about a parser with no code to inspect;
 * dropping the row would hide exactly the parsers somebody might fix.
 *
 * `artifactUrl` is the row's base address because it is the only address the
 * row has. `detail` carries the parser name and the content type beside it — a
 * `name` is what a future converter would have to resolve against the client's
 * classpath, and a `contentType` is what it would have to branch on. Neither is
 * guessable from a title.
 *
 * Nothing is dropped for its medium. `keepMediums` is right for a format whose
 * rows can install, where a listing this build cannot use would be a button
 * that never lights; here nothing installs, so a novel row is exactly as
 * useful to look at as a manga one and `refusalFor` already refuses it in a
 * sentence of its own. Filtering would hide the only thing the row has to say.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
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
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import type { RepositoryIndex } from '@plugin-bridge/core/repository-index';

/**
 * The mediums a row claims.
 *
 * `contentType` is the only medium signal a Kotatsu index carries, and it is
 * one value, so `mediaKinds` is built from it here and collapsed by the caller.
 * `NOVEL` is the only member this build has nowhere to show.
 *
 * A handful of published rows say `ANIME`. They stay filed under `manga`:
 * `mediaKind` is the medium a row is filed under, a Kotatsu listing names a
 * base address and nothing about episodes, and the client keeps them in the
 * same catalogue as the rest. The anime claim is kept beside it so that a
 * consumer routing by medium can still see what the ecosystem said, instead of
 * having to infer it from a title.
 */
function mediumsOf(contentType: string): ForeignMedium[] {
	if (contentType === 'NOVEL') return ['novel'];
	return contentType === 'ANIME' ? ['manga', 'anime'] : ['manga'];
}

/**
 * The address a listing points at, forced to https.
 *
 * An empty base is not a broken row: 150 of the 5,834 published rows leave it
 * blank, and Kotatsu reads that as "the client's own default". Those parsers
 * still exist and still deserve a row, but a listing needs an address, so the
 * index document itself is used — it is the one https URL this parse can name
 * and the only place the parser is recorded at all. A plain-http base is
 * upgraded rather than dropped, for the reason an index may not be cleartext:
 * rewriting it in transit is enough to choose what a client reads.
 */
function artifactOf(baseUrl: unknown, indexUrl: string): string {
	const base = typeof baseUrl === 'string' ? baseUrl.trim() : '';
	const absolute = base.startsWith('//')
		? `https:${base}`
		: base.replace(/^http:\/\//i, 'https://');
	return absolute.startsWith('https://') ? absolute : indexUrl;
}

function isNsfw(row: Record<string, unknown>): boolean {
	return row['nsfw'] === 1 || row['nsfw'] === true;
}

export const kotatsuAdapter: ForeignAdapter = {
	format: 'kotatsu',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// The multi-parser repositories published in this shape keep one array
		// per owner under `index/`, and some forks publish a merged document
		// beside it. A pasted index URL is the common case and is returned
		// above; these are what a bare repository URL can be guessed at.
		return ['index/index.json', 'index.json', 'index/parsers.json'].flatMap((path) =>
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
		if (!Array.isArray(decoded)) {
			throw new ForeignFormatError('not a Kotatsu parser index');
		}
		/*
		 * An empty list is accepted only on this format's own path convention,
		 * `index/<name>.json`, and never on a bare `[]`.
		 *
		 * One published repository really is empty — its index file is `[]` —
		 * and refusing it reports a repository that parsed fine as a parse
		 * failure. But a bare empty array has no row shape to identify it, so
		 * accepting one unconditionally would let this adapter claim any empty
		 * array at all. The path is the only evidence available, so it is what
		 * decides, and the shape still decides every non-empty document.
		 */
		if (decoded.length === 0) {
			if (!/(?:^|\/)index\/[^/]+\.json$/.test(indexUrl)) {
				throw new ForeignFormatError('not a Kotatsu parser index');
			}
			return {
				name: 'Kotatsu parsers',
				updatedAt: '',
				signingKey: null,
				plugins: [],
				format: 'kotatsu',
				filteredOut: 0
			};
		}

		// `baseUrl` beside a `name` and a `contentType` is the row shape.
		// `baseUrl` is accepted when empty, because an empty one is a real row;
		// it is the *key* that has to be there. `contentType` is required
		// because it is the only medium signal, and a row without one would be
		// filed by guesswork.
		const rows = decoded.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return (
				typeof row['name'] === 'string' &&
				row['name'].length > 0 &&
				typeof row['baseUrl'] === 'string' &&
				typeof row['contentType'] === 'string'
			);
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Kotatsu parser index');

		const plugins = rows.map((row) => {
			const parser = String(row['name']);
			const contentType = String(row['contentType']);
			const mediums = mediumsOf(contentType);

			return foreignListing({
				id: convertedPluginId('kotatsu', parser),
				name: String(row['title'] ?? '') || parser,
				// The only place a broken flag can reach a reader. It changes
				// nothing about installability — nothing here installs — and
				// that is the point: it is a fact about the site.
				description: row['isBroken'] === true ? 'Kotatsu marks this parser as broken.' : '',
				version: '0',
				author: '',
				language:
					typeof row['lang'] === 'string' && row['lang'].trim().length > 0
						? row['lang'].trim()
						: null,
				hosts: hostsFromUrls([String(row['baseUrl'])]),
				origin: {
					format: 'kotatsu',
					artifactUrl: artifactOf(row['baseUrl'], indexUrl),
					foreignId: parser,
					foreignVersion: '0',
					mediaKind: mediums[0],
					mediaKinds: mediums,
					isNsfw: isNsfw(row),
					detail: { parser, contentType }
				}
			});
		});

		return {
			name: 'Kotatsu parsers',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'kotatsu',
			// Rows that were the right format but not the right shape. Nothing
			// is dropped for its medium, so this is the whole of the loss.
			filteredOut: decoded.length - rows.length
		};
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('kotatsu');
	}
};
