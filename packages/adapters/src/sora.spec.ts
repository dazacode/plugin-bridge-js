/**
 * A library that lists the same declared source name twice — two quality
 * tiers of one site, or a plain duplicate entry, both observed on a live
 * library (AGENTS.md rule 9: no name or URL from it appears here) — used to
 * collapse onto one id. Two `RepositoryPlugin`s sharing an id share a Svelte
 * keyed-each key, and the render throws for the whole list, not just the pair.
 */

import { describe, expect, it } from 'vitest';

import { soraAdapter } from './sora';

function manifest(sourceName: string, scriptPath: string) {
	return {
		sourceName,
		scriptUrl: scriptPath,
		version: '1.0.0',
		language: 'English',
		streamType: 'HLS',
		baseUrl: `https://example.invalid/${scriptPath}`
	};
}

describe('a library that names two different modules alike', () => {
	it('still gives each a distinct id', () => {
		const body = JSON.stringify([
			manifest('Same Name', 'one/one.js'),
			manifest('Same Name', 'two/two.js')
		]);

		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');

		expect(plugins).toHaveLength(2);
		expect(plugins[0].id).not.toBe(plugins[1].id);
	});

	it('leaves every non-colliding id exactly as before', () => {
		const body = JSON.stringify([manifest('Only One', 'only/one.js')]);

		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');

		expect(plugins[0].id).toBe('app.yorozo.converted.sora.only_one');
	});

	it('drops a listing published twice, byte for byte, rather than fake a second id', () => {
		const body = JSON.stringify([
			manifest('Same Name', 'one/one.js'),
			manifest('Same Name', 'one/one.js')
		]);

		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');

		expect(plugins).toHaveLength(1);
	});
});

describe('classifying a module Sora describes only in free text', () => {
	it('defaults to anime when the manifest says nothing at all', () => {
		const body = JSON.stringify([manifest('Unlabelled', 'x/x.js')]);
		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');
		expect(plugins[0].origin?.mediaKind).toBe('anime');
	});

	it('reads a mention of anime wherever it sits in the type string', () => {
		const body = JSON.stringify([{ ...manifest('Mixed', 'x/x.js'), type: 'shows/movies/anime' }]);
		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');
		expect(plugins[0].origin?.mediaKind).toBe('anime');
	});

	/**
	 * The regression this guards. Matching only `/anime/i` and treating every
	 * other non-empty value as `manga` dropped 22 anime modules of 56 from a
	 * live library that said things like `movies/shows/anime` — and separately
	 * mislabelled every module that genuinely served live-action film as a
	 * manga source, which is now supported and deserves its own kind rather
	 * than the wrong one by elimination.
	 */
	it("classifies plain 'shows/movies' as live-action, not manga by elimination", () => {
		const body = JSON.stringify([{ ...manifest('Film Site', 'x/x.js'), type: 'shows/movies' }]);
		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');
		expect(plugins[0].origin?.mediaKind).toBe('live-action');
	});

	it('now keeps a manga catalogue, classified from the same free text', () => {
		// The classification is unchanged; what changed under ADR-0013 is that
		// `manga` is a medium this build can show. This module is kept for the
		// same reason it used to be dropped — the word it filed itself under.
		const body = JSON.stringify([{ ...manifest('Comics', 'x/x.js'), type: 'mangas' }]);
		const { plugins, filteredOut } = soraAdapter.parseIndex(
			body,
			'https://example.invalid/modules.json'
		);
		expect(plugins).toHaveLength(1);
		expect(filteredOut).toBe(0);
		expect(plugins[0].origin?.mediaKind).toBe('manga');
	});

	it('still keeps a novel catalogue out of the browse list', () => {
		const body = JSON.stringify([{ ...manifest('Novels', 'x/x.js'), type: 'novels' }]);
		const { plugins, filteredOut } = soraAdapter.parseIndex(
			body,
			'https://example.invalid/modules.json'
		);
		expect(plugins).toHaveLength(0);
		expect(filteredOut).toBe(1);
	});
});

/**
 * The failure these guard, seen on a live install. KissAsian declares
 * `movies/shows/anime` — a set — and was filed under `anime` on the first
 * mention, after which the medium filter skipped it for every live-action
 * title and the viewer's only installed source reported "No installed plugin
 * serves that kind of media". A superset declaration is not an exclusion.
 */
describe('a module that declares more than one medium', () => {
	it('keeps every medium it named, not just the one it is filed under', () => {
		const body = JSON.stringify([
			{ ...manifest('Drama Site', 'x/x.js'), type: 'movies/shows/anime' }
		]);

		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');

		expect(plugins[0].origin?.mediaKinds).toContain('anime');
		expect(plugins[0].origin?.mediaKinds).toContain('live-action');
	});

	it('files it under the first medium named, exactly as before', () => {
		const body = JSON.stringify([
			{ ...manifest('Drama Site', 'x/x.js'), type: 'movies/shows/anime' }
		]);

		const { plugins } = soraAdapter.parseIndex(body, 'https://example.invalid/modules.json');

		expect(plugins[0].origin?.mediaKind).toBe('anime');
		expect(plugins[0].origin?.mediaKinds?.[0]).toBe('anime');
	});

	it('reads the library category as well as the manifest', async () => {
		// The live case exactly: the manifest's own `type` and the library's
		// `category` both say `movies/shows/anime`, and both are free text.
		const body = JSON.stringify({
			modules: [{ category: 'movies/shows/anime', manifestUrl: 'x/x.json' }]
		});
		const getText = async () =>
			JSON.stringify({ ...manifest('Drama Site', 'x/x.js'), type: 'movies/shows/anime' });

		const { plugins } = await soraAdapter.loadIndex!(
			body,
			'https://example.invalid/modules.json',
			getText
		);

		expect(plugins[0].origin?.mediaKinds).toEqual(['anime', 'live-action']);
	});

	it('keeps a listing whose supported medium is not the one it is filed under', () => {
		// `mangas/shows`: filed under live-action by precedence, but the point
		// is that naming an unsupported medium first never drops it.
		const body = JSON.stringify([{ ...manifest('Mixed Site', 'x/x.js'), type: 'mangas/shows' }]);

		const { plugins, filteredOut } = soraAdapter.parseIndex(
			body,
			'https://example.invalid/modules.json'
		);

		expect(plugins).toHaveLength(1);
		expect(filteredOut).toBe(0);
		expect(plugins[0].origin?.mediaKinds).toContain('live-action');
	});
});

describe('the hosts a converted module is granted', () => {
	it('does not grant the host it was downloaded from', () => {
		// `scriptUrl` is fetched once by the host, before any sandbox exists.
		// Granting it gave every module published on GitHub raw a standing read
		// of GitHub's user content for a request it never makes.
		const body = JSON.stringify([
			{
				sourceName: 'Hosted On GitHub',
				scriptUrl: 'https://raw.githubusercontent.com/someone/modules/main/x/x.js',
				version: '1.0.0',
				streamType: 'HLS',
				baseUrl: 'https://example.invalid/'
			}
		]);

		const { plugins } = soraAdapter.parseIndex(
			body,
			'https://raw.githubusercontent.com/someone/modules/main/modules.json'
		);

		expect(plugins[0].hosts).toContain('example.invalid');
		expect(plugins[0].hosts.some((host) => host.includes('githubusercontent'))).toBe(false);
	});
});
