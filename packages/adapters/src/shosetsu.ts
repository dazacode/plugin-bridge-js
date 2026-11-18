/**
 * Extension indexes published for Shosetsu.
 *
 * One document for the whole ecosystem: `authors`, `libraries`, `scripts`,
 * `styles` and `js` sit beside each other, and only `scripts` is a listing.
 * A script names no URL at all — it carries a `fileName`, and the artifact is
 * `<index directory>/<fileName>.lua`. That is the one resolution rule this
 * format has, and it is derived rather than guessed.
 *
 * `browse-only` twice over, which is why the profile refuses rather than this
 * adapter: every listing here is a novel, and even if there were somewhere to
 * show one, nothing in this build runs Lua. A reader is told the script's name,
 * its language, its version and the version of the shared library it was
 * written against — which is the whole of what a repository of Lua scrapers can
 * honestly say about itself here.
 *
 * An entry whose `type` is not `LuaScript` is refused as a listing rather than
 * shown. The address derived above ends in `.lua`, so a row of another type
 * would be listed at an address its own file name does not describe; refusing
 * it says so, where showing it would produce a row that looks exactly like a
 * working one and points at a file that is not there. `styles` and `js` are not
 * scripts at all and are not read for the same reason.
 *
 * `type` is optional in practice: three of the five published indexes read
 * while this was written omit it entirely, so absence means the ordinary script
 * of a `scripts` array and only a *present*, different type is refused. Reading
 * absence as "unknown" would empty most of this ecosystem's repositories.
 *
 * No row is dropped for its medium, though every one of them is a novel.
 * `keepMediums` would take the whole repository and leave an empty list with a
 * count — a reader would learn a number instead of the sixty sites — while the
 * refusal that matters is already written: `refusalFor` refuses a novel in a
 * sentence of its own, per row. Showing the rows is the point of adapting a
 * format nothing can install.
 */

import {
	convertedPluginId,
	foreignListing,
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

export const shosetsuAdapter: ForeignAdapter = {
	format: 'shosetsu',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// The index sits at the repository root, beside the `icons` and `src`
		// directories it describes.
		return ['index.json'].flatMap((path) => rawCandidates(repository, path, DEFAULT_REFS));
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
			throw new ForeignFormatError('not a Shosetsu extension index');
		}

		const document = decoded as Record<string, unknown>;
		if (!Array.isArray(document['scripts']) || document['scripts'].length === 0) {
			throw new ForeignFormatError('not a Shosetsu extension index');
		}

		// `fileName` beside an `id` is the row shape; the id is what makes it
		// addressable across releases. `scripts` on the document is what
		// separates this from every object-shaped sibling format.
		const scripts = document['scripts'];
		const rows = scripts.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return (
				(typeof row['id'] === 'number' || typeof row['id'] === 'string') &&
				typeof row['name'] === 'string' &&
				typeof row['fileName'] === 'string' &&
				row['fileName'].length > 0
			);
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Shosetsu extension index');

		const plugins = rows.flatMap((row) => {
			// Absence is the ordinary script; only a present, other type is
			// something the `.lua` address below would misdescribe.
			if (typeof row['type'] === 'string' && row['type'] !== 'LuaScript') return [];

			const id = String(row['id']);
			const fileName = String(row['fileName']);
			const artifact = new URL(
				fileName.endsWith('.lua') ? fileName : `${fileName}.lua`,
				indexUrl
			).toString();

			return [
				foreignListing({
					id: convertedPluginId('shosetsu', id),
					name: String(row['name']),
					description: '',
					version: String(row['ver'] ?? '0'),
					author: '',
					language:
						typeof row['lang'] === 'string' && row['lang'].trim().length > 0
							? row['lang'].trim()
							: null,
					// A script names no address of its own; the only hosts here are
					// the repository that serves the script and its icons, which is
					// not a content host. An empty pair is the truthful answer and
					// would be shown as such on a consent sheet.
					hosts: [],
					origin: {
						format: 'shosetsu',
						artifactUrl: artifact,
						foreignId: id,
						foreignVersion: String(row['ver'] ?? '0'),
						mediaKind: 'novel',
						isNsfw: false,
						detail: {
							// `md5` is a misnomer the ecosystem has kept: the value is
							// 64 hex characters and is a sha256. It is carried here so
							// that a converter can verify the script it fetched rather
							// than trust the transport, and is *not* copied into the
							// listing's `sha256`, which is the digest of a bundle that
							// does not exist yet.
							md5:
								typeof row['md5'] === 'string' && row['md5'].trim().length > 0
									? row['md5'].trim()
									: null,
							// The shared library version the script was written
							// against, which is what a Lua host would have to provide.
							libVer: typeof row['libVer'] === 'string' ? row['libVer'] : null
						}
					}
				})
			];
		});

		return {
			name: 'Shosetsu extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'shosetsu',
			// Every row of another type, plus any that was not shaped like a
			// row at all. The medium drops none, so this is the whole of it.
			filteredOut: scripts.length - plugins.length
		};
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('shosetsu');
	}
};
