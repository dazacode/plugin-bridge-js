/**
 * The generated addon client, driven the way a sandbox drives it.
 *
 * Every response here is canned: the protocol is the thing under test, not any
 * addon's health, and rule 9 means no real addon appears in this file. The
 * routes are the four the protocol defines and the bodies are the shapes its
 * own documentation gives.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { stremioEntrypoint } from './stremio-entry';

interface Plugin {
	searchCatalog: (q: string, p: number, ctx: unknown) => Promise<{ entries: unknown[] }>;
	listEpisodes: (
		id: string,
		ctx: unknown
	) => Promise<{ number: number; sourceEpisodeId: string }[]>;
	resolve: (id: string, episode: unknown, ctx: unknown) => Promise<Record<string, unknown>[]>;
}

const BASE = 'https://addon.example.invalid/config=abc';

async function load(
	searchable: { type: string; id: string }[] = [{ type: 'series', id: 'example' }]
): Promise<Plugin> {
	const directory = await mkdtemp(join(tmpdir(), 'stremio-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		stremioEntrypoint({
			pluginId: 'test.stremio',
			baseUrl: BASE,
			types: ['movie', 'series'],
			searchable
		})
	);
	const module = (await import(`file://${file}`)) as Record<string, unknown>;
	return module['default'] as Plugin;
}

/** A context whose network answers from a table, and records what was asked. */
function context(routes: Record<string, unknown>, asked: string[] = []) {
	return {
		asked,
		ctx: {
			http: {
				send: async (url: string) => {
					asked.push(url);
					// Looked up decoded, so the table reads as the protocol's own
					// paths. The encoding itself is asserted separately — an id
					// carries colons and they must reach the addon escaped.
					const body = routes[decodeURIComponent(url.replace(BASE, ''))];
					if (body === undefined) return { status: 404, url, headers: {}, text: async () => '' };
					const text = JSON.stringify(body);
					return {
						status: 200,
						url,
						headers: {},
						text: async () => text,
						json: async () => JSON.parse(text) as unknown
					};
				}
			},
			log: { debug() {}, warn() {} }
		}
	};
}

const META = {
	meta: {
		id: 'tt1',
		type: 'series',
		name: 'Example Series',
		videos: [
			{ id: 'tt1:1:1', season: 1, episode: 1, title: 'One' },
			{ id: 'tt1:1:2', season: 1, episode: 2, title: 'Two' },
			// Specials live in season 0 and would collide with the real run.
			{ id: 'tt1:0:1', season: 0, episode: 1, title: 'A trailer' }
		]
	}
};

describe('listing what an addon has', () => {
	it('reads episodes from the protocol’s own metadata route', async () => {
		const plugin = await load();
		const { ctx, asked } = context({ '/meta/series/tt1.json': META });

		const episodes = await plugin.listEpisodes('series:tt1', ctx);

		expect(asked).toEqual([`${BASE}/meta/series/tt1.json`]);
		expect(episodes.map((row) => row.number)).toEqual([1, 2]);
		expect(episodes[0].sourceEpisodeId).toBe('tt1:1:1');
	});

	it('leaves season zero out, so a trailer is not episode one', async () => {
		const plugin = await load();
		const { ctx } = context({ '/meta/series/tt1.json': META });

		const episodes = await plugin.listEpisodes('series:tt1', ctx);

		expect(episodes.some((row) => row.sourceEpisodeId === 'tt1:0:1')).toBe(false);
	});

	it('gives a film the one episode the playback layer asks it for', async () => {
		// A movie has no episode list and no metadata route worth a request.
		// Returning nothing would make every film unplayable.
		const plugin = await load();
		const { ctx, asked } = context({});

		const episodes = await plugin.listEpisodes('movie:tt2', ctx);

		expect(episodes).toEqual([{ number: 1, sourceEpisodeId: 'tt2' }]);
		expect(asked).toEqual([]);
	});
});

describe('resolving a stream', () => {
	const STREAMS = {
		streams: [
			{ infoHash: 'abc', name: 'A torrent' },
			{
				url: 'https://cdn.example.invalid/one.m3u8',
				name: '1080p',
				behaviorHints: {
					proxyHeaders: { request: { Referer: 'https://player.example.invalid/' } }
				},
				subtitles: [{ url: 'https://cdn.example.invalid/one.vtt', lang: 'eng' }]
			},
			{ externalUrl: 'https://elsewhere.example.invalid/watch' }
		]
	};

	it('escapes the colons an episode id carries', async () => {
		// `tt1:1:1` is one path segment, and a raw colon in it is a different
		// request. Verified against a live addon, which answers the escaped form.
		const plugin = await load();
		const { ctx, asked } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		await plugin.resolve('series:tt1', { number: 1, sourceEpisodeId: 'tt1:1:1' }, ctx);

		expect(asked[0]).toBe(`${BASE}/stream/series/tt1%3A1%3A1.json`);
	});

	it('keeps the direct link and drops what cannot be played', async () => {
		const plugin = await load();
		const { ctx } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		const sources = await plugin.resolve(
			'series:tt1',
			{ number: 1, sourceEpisodeId: 'tt1:1:1' },
			ctx
		);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/one.m3u8');
		expect(sources[0].container).toBe('hls');
	});

	it('carries the headers the addon says the stream needs', async () => {
		// A CDN that checks Referer serves nothing without it, and the host's
		// proxy is what sets a header JavaScript may not.
		const plugin = await load();
		const { ctx } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		const sources = await plugin.resolve(
			'series:tt1',
			{ number: 1, sourceEpisodeId: 'tt1:1:1' },
			ctx
		);

		expect(sources[0].headers).toEqual({ Referer: 'https://player.example.invalid/' });
	});

	it('keeps the addon’s own subtitle language rather than calling it unknown', async () => {
		const plugin = await load();
		const { ctx } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		const sources = await plugin.resolve(
			'series:tt1',
			{ number: 1, sourceEpisodeId: 'tt1:1:1' },
			ctx
		);

		expect(sources[0].subtitles).toEqual([
			expect.objectContaining({ languageCode: 'eng', format: 'vtt' })
		]);
	});

	/**
	 * The distinction the whole failure vocabulary rests on. An addon returning
	 * sixty-seven torrents has answered; reporting that as "returned no stream"
	 * blames it for working as designed.
	 */
	it('says what it got when none of it is playable, rather than returning empty', async () => {
		const plugin = await load();
		const { ctx } = context({
			'/stream/movie/tt2.json': { streams: [{ infoHash: 'a' }, { infoHash: 'b' }] }
		});

		await expect(plugin.resolve('movie:tt2', null, ctx)).rejects.toThrow(/2 torrent/);
		await expect(plugin.resolve('movie:tt2', null, ctx)).rejects.toThrow(/debrid/);
	});

	it('returns empty for an addon that genuinely has nothing', async () => {
		// Distinct from the case above: nothing to explain, and throwing would
		// turn "this addon does not carry that title" into a source failure.
		const plugin = await load();
		const { ctx } = context({ '/stream/movie/tt2.json': { streams: [] } });

		await expect(plugin.resolve('movie:tt2', null, ctx)).resolves.toEqual([]);
	});
});

describe('searching an addon', () => {
	it('asks only the catalogues that said they accept a search', async () => {
		const plugin = await load([{ type: 'series', id: 'example' }]);
		const { ctx, asked } = context({
			'/catalog/series/example/search=thing.json': {
				metas: [{ id: 'tt1', type: 'series', name: 'Example Series', releaseInfo: '2015' }]
			}
		});

		const page = await plugin.searchCatalog('thing', 1, ctx);

		expect(asked).toEqual([`${BASE}/catalog/series/example/search=thing.json`]);
		expect(page.entries).toEqual([
			expect.objectContaining({ sourceMediaId: 'series:tt1', title: 'Example Series', year: 2015 })
		]);
	});

	it('asks nothing at all of a stream-only addon', async () => {
		// The measured shape: `catalogs: []`. A request here would be a request
		// to a route the addon never claimed to serve.
		const plugin = await load([]);
		const { ctx, asked } = context({});

		const page = await plugin.searchCatalog('thing', 1, ctx);

		expect(page.entries).toEqual([]);
		expect(asked).toEqual([]);
	});
});
