/**
 * What a Hayase listing may pull in, and what it may not.
 *
 * The resolver exists because eight of the measured extensions split a helper
 * into a sibling file. The refusals exist because "fetch whatever this file
 * imports" is one careless resolution away from letting a listing run code
 * from a repository nobody added.
 */
import { describe, expect, it, vi } from 'vitest';

import { hayaseAdapter } from './hayase';
import type { ConversionServices } from '@plugin-bridge/core/adapter';

const ARTIFACT = 'https://raw.githubusercontent.com/owner/repo/main/src/nyaa.js';

const INDEX = JSON.stringify([
	{
		id: 'demo.nyaa',
		name: 'Demo',
		version: '1.0.0',
		manifestVersion: 1,
		type: 'torrent',
		code: 'https://raw.githubusercontent.com/owner/repo/main/src/nyaa.js'
	}
]);

function servicesFor(entry: string, files: Record<string, string>) {
	const getText = vi.fn(async (url: string) => {
		const found = files[url];
		if (found === undefined) throw new Error(`nothing at ${url}`);
		return found;
	});
	return {
		services: {
			fetchArtifact: async () => new TextEncoder().encode(entry),
			getText,
			listFiles: async () => []
		} as unknown as ConversionServices,
		getText
	};
}

async function convert(entry: string, files: Record<string, string> = {}) {
	const index = hayaseAdapter.parseIndex(
		INDEX,
		'https://raw.githubusercontent.com/owner/repo/repo/index.json'
	);
	const { services, getText } = servicesFor(entry, files);
	const bundle = await hayaseAdapter.convert(index.plugins[0], services);
	return { bundle, asked: getText.mock.calls.map((one) => one[0] as string) };
}

describe('repository-local modules', () => {
	it('fetches a sibling from the same repository and ref', async () => {
		const { asked } = await convert(
			`import { made } from './utils.js'\nexport default new class {}()`,
			{
				'https://raw.githubusercontent.com/owner/repo/main/src/utils.js': 'export const made = 1'
			}
		);

		expect(asked).toEqual(['https://raw.githubusercontent.com/owner/repo/main/src/utils.js']);
	});

	it('follows a helper that imports its own helper, deepest declared first', async () => {
		const { asked } = await convert(
			`import { a } from './lib/one.js'\nexport default new class {}()`,
			{
				'https://raw.githubusercontent.com/owner/repo/main/src/lib/one.js':
					"import { b } from './two.js'\nexport const a = b",
				'https://raw.githubusercontent.com/owner/repo/main/src/lib/two.js': 'export const b = 2'
			}
		);

		expect(asked).toEqual([
			'https://raw.githubusercontent.com/owner/repo/main/src/lib/one.js',
			'https://raw.githubusercontent.com/owner/repo/main/src/lib/two.js'
		]);
	});

	it('refuses a specifier that climbs out of the repository', async () => {
		// Resolves to a real URL on the same forge. Fetching it would let one
		// listing pull code from a repository nobody added.
		const { asked } = await convert(
			`import { x } from '../../../elsewhere/evil/main/x.js'\nexport default new class {}()`,
			{ 'https://raw.githubusercontent.com/elsewhere/evil/main/x.js': 'export const x = 1' }
		);

		expect(asked).toEqual([]);
	});

	it('refuses a bare specifier, which is a dependency this runtime has not', async () => {
		const { asked } = await convert(`import fs from 'node:fs'\nexport default new class {}()`, {});
		expect(asked).toEqual([]);
	});

	it('asks for each module once, however many import it', async () => {
		const { asked } = await convert(
			`import { a } from './one.js'\nimport { b } from './two.js'\nexport default new class {}()`,
			{
				'https://raw.githubusercontent.com/owner/repo/main/src/one.js':
					"import { s } from './shared.js'\nexport const a = s",
				'https://raw.githubusercontent.com/owner/repo/main/src/two.js':
					"import { s } from './shared.js'\nexport const b = s",
				'https://raw.githubusercontent.com/owner/repo/main/src/shared.js': 'export const s = 1'
			}
		);

		expect(asked.filter((one) => one.endsWith('shared.js'))).toHaveLength(1);
	});

	it('never fetches the base class it defines itself', async () => {
		const { asked } = await convert(
			`import AbstractSource from './abstract.js'\nexport default new class extends AbstractSource {}()`,
			{
				'https://raw.githubusercontent.com/owner/repo/main/src/abstract.js':
					'export default class {}'
			}
		);

		expect(asked).toEqual([]);
	});

	it('converts anyway when a helper cannot be read', async () => {
		// The entry module then refuses by the missing symbol's own name, which
		// says more than "a file this build expected was not there".
		const { bundle } = await convert(
			`import { gone } from './gone.js'\nexport default new class {}()`,
			{}
		);
		expect(bundle.byteLength).toBeGreaterThan(0);
	});
});
