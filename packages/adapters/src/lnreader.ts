/**
 * Plugin repositories published for LNReader.
 *
 * Technically the easiest format here: each plugin is one already-bundled
 * CommonJS file, and the index is a flat array naming it. It is `browse-only`
 * purely because every entry is a novel source, and `AGENTS.md` scopes the
 * product to anime — `contract/plugin-api/FOREIGN.md` §4.3.
 *
 * Adapting it anyway costs a page and buys two things: pasting one of these
 * URLs explains itself instead of failing as unrecognised, and the day a
 * reading surface exists the conversion work is a shim, not a format study.
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

export const lnreaderAdapter: ForeignAdapter = {
	format: 'lnreader',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// Published on a `plugins` branch, under a version directory. Only the
		// undated shapes are guessable; somebody with a versioned URL pastes it
		// directly, and the file check above returns it untouched.
		return ['.dist/plugins.min.json', 'plugins.min.json'].flatMap((path) =>
			rawCandidates(repository, path, ['plugins', ...DEFAULT_REFS])
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
			throw new ForeignFormatError('not an LNReader plugin index');
		}

		// `site` plus a `.js` url is the shape no other adapted ecosystem has.
		const rows = decoded.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return typeof row['site'] === 'string' && typeof row['url'] === 'string';
		});
		if (rows.length === 0) throw new ForeignFormatError('not an LNReader plugin index');

		const plugins = rows.map((row) => {
			const id = String(row['id'] ?? row['name']);
			const script = new URL(String(row['url']), indexUrl).toString();
			return foreignListing({
				id: convertedPluginId('lnreader', id),
				name: String(row['name'] ?? id),
				description: '',
				version: String(row['version'] ?? '0'),
				author: '',
				language: typeof row['lang'] === 'string' ? row['lang'].trim() : null,
				hosts: hostsFromUrls([String(row['site']), script]),
				origin: {
					format: 'lnreader',
					artifactUrl: script,
					foreignId: id,
					foreignVersion: String(row['version'] ?? '0'),
					mediaKind: 'novel',
					isNsfw: false
				}
			});
		});

		return keepAnimeOnly({
			name: 'LNReader plugins',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'lnreader'
		});
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('lnreader');
	}
};
