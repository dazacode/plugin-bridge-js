/**
 * What a Hayase source has to survive, written against the shapes a real
 * corpus actually contains rather than against the one in the documentation.
 *
 * Every case here failed at least once during the measurement pass that
 * produced this shim, and each is a *class* of extension rather than one
 * source: a class field that decodes its own address, a module that awaits at
 * its top level, a helper split into a sibling file, a row whose hash is only
 * inside a magnet.
 */
import { describe, expect, it } from 'vitest';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hayaseEntrypoint } from './hayase-entry';

let counter = 0;

const ctx = {
	http: {
		send: async (url: string) => ({
			status: 200,
			url,
			headers: {},
			text: () => '',
			json: () => ({})
		})
	},
	settings: { string: () => '', boolean: () => false, number: () => 0 },
	text: {
		encode: (value: string) => new TextEncoder().encode(value),
		decode: (value: BufferSource) => new TextDecoder().decode(value)
	},
	bytes: {
		toBase64: (value: Uint8Array) => Buffer.from(value).toString('base64'),
		fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
	},
	log: { info: () => {}, warn: () => {}, error: () => {} }
};

interface Loaded {
	resolve(
		id: string,
		episode: unknown,
		context: unknown
	): Promise<{ torrent: { infoHash: string } }[]>;
	searchCatalog(query: string, page: number, context: unknown): Promise<{ entries: unknown[] }>;
}

async function load(
	script: string,
	modules: { specifier: string; source: string }[] = []
): Promise<Loaded> {
	const source = hayaseEntrypoint({ pluginId: 'test.hayase', script, modules });
	const dir = join(tmpdir(), 'hayase-spec');
	await mkdir(dir, { recursive: true });
	const path = join(dir, `bundle-${(counter += 1)}.mjs`);
	await writeFile(path, source);
	return (await import(path)).default as Loaded;
}

const rows = (body: string) => `export default new class { async single () { return ${body} } }()`;

describe('the module, evaluated', () => {
	it('defers a class field that decodes its own address', async () => {
		// The cluster that cost the most: `url = atob("…")` runs when the
		// instance is made, and `export default new class {…}()` makes it at
		// the assignment — so evaluating the module on load reached the host's
		// codecs before any call had handed one over. 37 of 77 failed here.
		const plugin = await load(
			`export default new class {
        url = atob("aHR0cHM6Ly9leGFtcGxlLmludmFsaWQv")
        async single () { return [{ title: this.url, hash: '${'a'.repeat(40)}' }] }
      }()`
		);

		const found = await plugin.resolve('Demo', { number: 1 }, ctx);
		expect(found).toHaveLength(1);
	});

	it('allows a module that awaits at its top level', async () => {
		// Legal in an ES module, a parse error inside a plain function — so the
		// deferred body is async and every entry point awaits it once.
		const plugin = await load(
			`const ready = await Promise.resolve(true)
       export default new class { async single () { return ready ? [{ hash: '${'b'.repeat(40)}' }] : [] } }()`
		);

		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('constructs a class that was exported unconstructed, and does not reconstruct an instance', async () => {
		const asClass = await load(
			`export default class { async single () { return [{ hash: '${'c'.repeat(40)}' }] } }`
		);
		expect(await asClass.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);

		const asObject = await load(
			`export default { async single () { return [{ hash: '${'d'.repeat(40)}' }] } }`
		);
		expect(await asObject.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('answers `navigator.onLine`, which many guard their first line with', async () => {
		const plugin = await load(
			`export default new class { async single () { return navigator.onLine ? [{ hash: '${'e'.repeat(40)}' }] : [] } }()`
		);
		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('passes a fetch inside the query, for the sources that take it that way', async () => {
		const plugin = await load(
			`export default new class { async single ({ fetch: given }) { return typeof given === 'function' ? [{ hash: '${'f'.repeat(40)}' }] : [] } }()`
		);
		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('always passes exclusions and resolution with the right type', async () => {
		// An absent `exclusions` is the difference between a source that finds
		// nothing and one that throws inside its own destructure, and the
		// second reads to a viewer as this build being broken.
		const plugin = await load(
			`export default new class { async single ({ exclusions, resolution }) {
        return exclusions.length === 0 && typeof resolution === 'string' ? [{ hash: '${'1'.repeat(40)}' }] : []
      } }()`
		);
		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});
});

describe('repository-local modules', () => {
	it('declares a helper before the module that reads it', async () => {
		const plugin = await load(
			`import { made } from './utils.js'
       export default new class { async single () { return made() } }()`,
			[
				{
					specifier: './utils.js',
					source: `export function made () { return [{ hash: '${'2'.repeat(40)}' }] }`
				}
			]
		);
		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('reads a helper whose import is written across several lines', async () => {
		const plugin = await load(
			`import {
         made
       } from './utils.js'
       export default new class { async single () { return made() } }()`,
			[
				{
					specifier: './utils.js',
					source: `export const made = () => [{ hash: '${'3'.repeat(40)}' }]`
				}
			]
		);
		expect(await plugin.resolve('Demo', { number: 1 }, ctx)).toHaveLength(1);
	});
});

describe('what a row has to carry', () => {
	const hex = '0'.repeat(39);

	it('reads the declared hash, a magnet, and a link that is itself a hash', async () => {
		const declared = await load(rows(`[{ hash: '${hex}1' }]`));
		expect((await declared.resolve('x', { number: 1 }, ctx))[0].torrent.infoHash).toBe(`${hex}1`);

		const magnet = await load(
			rows(`[{ link: 'magnet:?xt=urn:btih:${hex}2&tr=http%3A%2F%2Ftracker.invalid%2Fa' }]`)
		);
		const fromMagnet = await magnet.resolve('x', { number: 1 }, ctx);
		expect(fromMagnet[0].torrent.infoHash).toBe(`${hex}2`);
		expect(fromMagnet[0].torrent).toMatchObject({ sources: ['http://tracker.invalid/a'] });

		// The ecosystem's own public-domain example publishes `link` this way.
		const bare = await load(rows(`[{ link: '${hex}3' }]`));
		expect((await bare.resolve('x', { number: 1 }, ctx))[0].torrent.infoHash).toBe(`${hex}3`);
	});

	it('returns one entry per hash, however many times it was listed', async () => {
		const plugin = await load(rows(`[{ hash: '${hex}4' }, { hash: '${hex.toUpperCase()}4' }]`));
		expect(await plugin.resolve('x', { number: 1 }, ctx)).toHaveLength(1);
	});

	it('refuses a `.torrent` url rather than guessing a hash out of it', async () => {
		// The hash lives inside bencode behind a SHA-1 of the info dictionary,
		// which is a parser this build does not have. Named, not invented.
		const plugin = await load(rows(`[{ link: 'https://example.invalid/a.torrent' }]`));
		await expect(plugin.resolve('x', { number: 1 }, ctx)).rejects.toThrow(/no info hash/i);
	});
});

describe('identity the host holds', () => {
	it('hands over only the ids the ref carries, under each ecosystem name', async () => {
		const plugin = await load(
			`export default new class { async single (q) { return [{ title: JSON.stringify([q.anilistId, q.idMal, q.tmdbId, q.anidbEid]), hash: '${'5'.repeat(40)}' }] } }()`
		);
		const found = await plugin.resolve('anilist:21|One Piece', { number: 1 }, ctx);
		expect(found[0]).toMatchObject({ label: '[21,null,null,null]' });
	});

	it('leaves an id the host does not know absent rather than substituting one', async () => {
		// An AniDB id is not an AniList id, and a number from the wrong
		// namespace answers for the wrong show.
		const plugin = await load(
			`export default new class { async single (q) { return [{ title: String('anidbEid' in q), hash: '${'6'.repeat(40)}' }] } }()`
		);
		const found = await plugin.resolve('anilist:21|One Piece', { number: 1 }, ctx);
		expect(found[0]).toMatchObject({ label: 'false' });
	});
});
