/**
 * The module wrapper, and the one property of it that is load-bearing.
 *
 * These modules are written for a runtime that evaluates them as a classic
 * script. Spliced into an ES module they get strict mode and no receiver, and a
 * bundled UMD library's `root.CryptoJS = factory()` throws before a single
 * request is made — five modules of one live library, on that one cause.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { soraEntrypoint } from './sora-entry';

/** Evaluates a generated entrypoint the way a sandbox would: as a module. */
async function load(script: string): Promise<Record<string, unknown>> {
	const directory = await mkdtemp(join(tmpdir(), 'sora-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		soraEntrypoint({
			pluginId: 'test.sora',
			script,
			baseUrl: 'https://example.invalid/',
			container: 'hls',
			softsub: false
		})
	);
	return (await import(`file://${file}`)) as Record<string, unknown>;
}

/** The header every UMD build opens with, reduced to the line that matters. */
const UMD = `
(function (root) {
  root.CryptoJS = { hashIt: function (s) { return 'hashed:' + s; } };
})(this);

function searchResults(html) { return JSON.stringify([{ title: CryptoJS.hashIt('x'), href: '/a' }]); }
function extractDetails() { return '[]'; }
function extractEpisodes() { return '[]'; }
function extractStreamUrl() { return ''; }
`;

describe('a module that expects a classic script', () => {
	it('loads, where an IIFE with no receiver threw on the first line', async () => {
		// The assertion is that this resolves at all. Before the receiver was
		// passed it rejected with "Cannot set properties of undefined (setting
		// 'CryptoJS')" — at load, which is why it cost five modules outright.
		await expect(load(UMD)).resolves.toBeDefined();
	});

	it('leaves the library reachable as a free variable afterwards', async () => {
		// The half a stand-in object would have lost: the library assigns onto
		// the receiver and the module's own code then reads it unqualified.
		const module = await load(UMD);
		const plugin = module['default'] as {
			searchCatalog: (q: string, p: number, ctx: unknown) => Promise<{ entries: unknown[] }>;
		};
		const found = await plugin.searchCatalog('x', 1, {
			http: { text: async () => '<html></html>' },
			log: { debug() {}, warn() {} }
		});
		expect(found.entries).toHaveLength(1);
		expect((found.entries[0] as { title: string }).title).toBe('hashed:x');
	});
});
