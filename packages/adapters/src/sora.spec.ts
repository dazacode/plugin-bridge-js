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
});
