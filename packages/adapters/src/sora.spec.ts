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

	it('still keeps a manga catalogue out of the browse list', () => {
		const body = JSON.stringify([{ ...manifest('Comics', 'x/x.js'), type: 'mangas' }]);
		const { plugins, filteredOut } = soraAdapter.parseIndex(
			body,
			'https://example.invalid/modules.json'
		);
		expect(plugins).toHaveLength(0);
		expect(filteredOut).toBe(1);
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
