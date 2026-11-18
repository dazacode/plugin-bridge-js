/**
 * Source indexes published for Aidoku.
 *
 * Two documents, one ecosystem, and both are supported because both are still
 * served. The current shape is an object naming the repository and a `sources`
 * array; a handful of older repositories publish a bare array of `{ id, name,
 * file, … }` rows under `public/index.json`. A pasted URL says which one it is,
 * so the parser reads either rather than making a viewer find the other.
 *
 * `browse-only`, and for an unusually concrete reason: an artifact here is an
 * `.aix`, a WebAssembly module. Wasm is the one artifact shape a browser can
 * already run, which makes this the most promising of the refused formats — and
 * it still does not run, because every module imports `aidoku-rs`'s own host
 * surface and nothing here supplies it. Recording the artifact, its language
 * and the client version it was built for is what makes the index worth showing
 * until that surface exists.
 *
 * A reader is told the source's name, its first language, and whether it is
 * adult. `contentRating` is carried in `detail` as well as collapsed into
 * `isNsfw`, because the two readings a viewer might want differ: the flag is a
 * yes/no for a filter, where 1 is "suggestive" and 2 is "adult", and a person
 * deciding about a 17+ source deserves the distinction a boolean throws away.
 * Both count as a warning, the same restraint `mihon.ts` applies to `mixed`:
 * treating a suggestive source as safe exposes somebody who opted out.
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
import type { RepositoryIndex } from '@plugin-bridge/core/repository-index';

interface AidokuSource {
	readonly id: string;
	readonly name: string;
	readonly version: string;
	readonly artifact: string;
	readonly language: string | null;
	readonly rating: number;
	readonly minAppVersion: string | null;
}

/**
 * One row, normalised, or null when it is not usable as a listing.
 *
 * `downloadURL` in the current shape and `file` in the old one are the same
 * fact, so both are read here and resolved by the same rule: relative to the
 * index document. A relative artifact is the norm in both shapes and never
 * survives as a relative address.
 */
function sourceOf(row: Record<string, unknown>, indexUrl: string): AidokuSource | null {
	const id = typeof row['id'] === 'string' ? row['id'].trim() : '';
	const name = typeof row['name'] === 'string' ? row['name'].trim() : '';
	if (id.length === 0 || name.length === 0) return null;

	const link = row['downloadURL'] ?? row['file'];
	if (typeof link !== 'string' || link.trim().length === 0) return null;

	let artifact: string;
	try {
		artifact = new URL(link.trim(), indexUrl).toString();
	} catch {
		return null;
	}
	// An https index makes this academic; a source that writes plain http still
	// gets a listing, because an artifact host that never moved is not a reason
	// to hide the source.
	if (artifact.startsWith('http://')) artifact = `https://${artifact.slice('http://'.length)}`;
	if (!artifact.startsWith('https://')) return null;

	const languages = Array.isArray(row['languages']) ? row['languages'] : [];
	const declared = languages.find((one): one is string => typeof one === 'string');
	const legacy = typeof row['lang'] === 'string' ? row['lang'].trim() : '';
	const language = declared?.trim() || legacy || null;

	// The old shape spells the rating `nsfw` on the same 0/1/2 scale.
	const rating = Number(row['contentRating'] ?? row['nsfw']);

	return {
		id,
		name,
		version: String(row['version'] ?? '0'),
		artifact,
		language,
		rating: Number.isFinite(rating) ? rating : 0,
		minAppVersion: typeof row['minAppVersion'] === 'string' ? row['minAppVersion'] : null
	};
}

export const aidokuAdapter: ForeignAdapter = {
	format: 'aidoku',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// Repositories of this shape publish under `public/`, which a static
		// host serves at its root, and the older ones name the array document
		// without the `.min`. Both spellings are tried because the page a
		// person copies either URL from does not say which version it is.
		return ['index.min.json', 'public/index.min.json', 'index.json', 'public/index.json'].flatMap(
			(path) => rawCandidates(repository, path, DEFAULT_REFS)
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		// An `id` beside a `downloadURL` (or its older spelling, `file`) is the
		// row shape, and no sibling format's rows have either. `kotatsu` rows
		// carry a `baseUrl` and no id; `lnreader` rows carry `site` and `url`.
		const isRow = (entry: unknown): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return (
				typeof row['id'] === 'string' &&
				typeof row['name'] === 'string' &&
				(typeof row['downloadURL'] === 'string' || typeof row['file'] === 'string')
			);
		};

		let name = 'Aidoku sources';
		let raw: unknown[];
		if (Array.isArray(decoded)) {
			raw = decoded;
		} else if (typeof decoded === 'object' && decoded !== null) {
			const document = decoded as Record<string, unknown>;
			if (!Array.isArray(document['sources'])) {
				throw new ForeignFormatError('not an Aidoku source index');
			}
			raw = document['sources'];
			if (typeof document['name'] === 'string' && document['name'].length > 0) {
				name = document['name'];
			}
		} else {
			throw new ForeignFormatError('not an Aidoku source index');
		}

		if (raw.length === 0) throw new ForeignFormatError('not an Aidoku source index');
		const rows = raw.filter(isRow);
		if (rows.length === 0) throw new ForeignFormatError('not an Aidoku source index');

		const plugins = rows.flatMap((row) => {
			const source = sourceOf(row, indexUrl);
			if (source === null) return [];

			return [
				foreignListing({
					id: convertedPluginId('aidoku', source.id),
					name: source.name,
					description: '',
					version: source.version,
					author: '',
					language: source.language,
					hosts: hostsFromUrls([source.artifact, String(row['baseURL'] ?? '')]),
					origin: {
						format: 'aidoku',
						artifactUrl: source.artifact,
						foreignId: source.id,
						foreignVersion: source.version,
						mediaKind: 'manga',
						isNsfw: source.rating >= 1,
						detail: {
							contentRating: source.rating,
							minAppVersion: source.minAppVersion
						}
					}
				})
			];
		});

		return {
			name,
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'aidoku',
			// Rows of the right format that had no id, no name or no address,
			// and rows whose address would not resolve. Counted so that a
			// repository that reads to nothing can say why rather than read as
			// a failed fetch. No row is dropped for its medium: every source in
			// this ecosystem is a manga source, and nothing here installs.
			filteredOut: raw.length - plugins.length
		};
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('aidoku');
	}
};
