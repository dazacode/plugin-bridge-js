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
	searchable: { type: string; id: string }[] = [{ type: 'series', id: 'example' }],
	config: { id: string; key: string; type: string }[] = [],
	resources: string[] = ['catalog', 'meta', 'stream']
): Promise<Plugin> {
	const directory = await mkdtemp(join(tmpdir(), 'stremio-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		stremioEntrypoint({
			pluginId: 'test.stremio',
			baseUrl: BASE,
			types: ['movie', 'series'],
			resources,
			searchable,
			config
		})
	);
	const module = (await import(`file://${file}`)) as Record<string, unknown>;
	return module['default'] as Plugin;
}

/** A context whose network answers from a table, and records what was asked. */
function context(
	routes: Record<string, unknown>,
	asked: string[] = [],
	values: Record<string, unknown> = {}
) {
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
			settings: {
				string: (id: string) => (values[id] === undefined ? '' : String(values[id])),
				boolean: (id: string) => values[id] === true,
				list: () => []
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

/**
 * The case a torrent indexer is, and the one this got wrong for as long as it
 * existed.
 *
 * Such an addon declares `stream` and nothing else. It holds no idea of what a
 * series contains — only which files exist for an id somebody hands it — and
 * the protocol's whole design is that some *other* addon supplies the meta.
 * Asked for a list it has none, and reading that silence as "this source does
 * not have episode 577" blames it for a question it never claimed to answer.
 */
describe('an addon that serves streams and nothing else', () => {
	it('is not asked for a list it never advertised', async () => {
		const plugin = await load(undefined, undefined, ['stream']);
		const { ctx, asked } = context({ '/meta/series/tt1.json': META });

		expect(await plugin.listEpisodes('series:tt1', ctx)).toEqual([]);
		// Not merely empty — never asked. The round trip is the cost of
		// treating an addon's own manifest as decoration.
		expect(asked).toEqual([]);
	});

	it('is asked for the episode by the id the protocol defines', async () => {
		// No list, so the host passes the number and the season it holds, and
		// this builds the `<imdb>:<season>:<episode>` every Stremio client
		// sends. Getting here is the difference between "no torrent for this"
		// and a refusal invented one layer up.
		const plugin = await load(undefined, undefined, ['stream']);
		const { ctx, asked } = context({
			'/stream/series/tt1:5:14.json': { streams: [{ url: 'https://cdn.example.invalid/a.mp4' }] }
		});

		const sources = await plugin.resolve('series:tt1', { number: 14, season: 5 }, ctx);

		expect(asked).toEqual([`${BASE}/stream/series/tt1%3A5%3A14.json`]);
		expect(sources).toHaveLength(1);
	});

	it('asks for the bare id when nobody could say which season', async () => {
		// A film has no season and needs none. A series whose catalogue could
		// not say would be a guess, and a guessed season plays the wrong
		// episode — which is worse than not playing.
		const plugin = await load(undefined, undefined, ['stream']);
		const { ctx, asked } = context({ '/stream/series/tt1.json': { streams: [] } });

		await plugin.resolve('series:tt1', { number: 14 }, ctx);

		expect(asked).toEqual([`${BASE}/stream/series/tt1.json`]);
	});

	it('still prefers an id the addon gave us, when one did', async () => {
		const plugin = await load(undefined, undefined, ['stream']);
		const { ctx, asked } = context({ '/stream/series/tt1:1:2.json': { streams: [] } });

		await plugin.resolve('series:tt1', { number: 99, season: 7, sourceEpisodeId: 'tt1:1:2' }, ctx);

		expect(asked).toEqual([`${BASE}/stream/series/tt1%3A1%3A2.json`]);
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

	/** The direct link is at index 1: a torrent precedes it in `STREAMS`. */
	async function resolved(ctx: unknown) {
		return await plugin!.resolve('series:tt1', { number: 1, sourceEpisodeId: 'tt1:1:1' }, ctx);
	}
	let plugin: Plugin | null = null;

	it('keeps the direct link, and the torrent beside it', async () => {
		// Both are real answers. Which of them this device can act on is the
		// host's question, and a bundle that decided it here would be deciding
		// for every device the same bundle runs on.
		plugin = await load();
		const { ctx } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		const sources = await resolved(ctx);

		expect(sources).toHaveLength(2);
		expect(sources[0].torrent).toEqual({ infoHash: 'abc' });
		expect(sources[1].url).toBe('https://cdn.example.invalid/one.m3u8');
		expect(sources[1].container).toBe('hls');
	});

	it('lowercases the infohash, so one torrent is not two engines', async () => {
		plugin = await load();
		const { ctx } = context({
			'/stream/movie/tt2.json': { streams: [{ infoHash: 'ABCDEF', fileIdx: 3, sources: ['tr'] }] }
		});

		const sources = await plugin.resolve('movie:tt2', null, ctx);

		expect(sources[0].torrent).toEqual({ infoHash: 'abcdef', fileIdx: 3, sources: ['tr'] });
	});

	it('leaves out a file index the source did not state', async () => {
		// Absent is a real answer: an engine picking the largest video beats a
		// source guessing an index it never read.
		plugin = await load();
		const { ctx } = context({ '/stream/movie/tt2.json': { streams: [{ infoHash: 'aa' }] } });

		const sources = await plugin.resolve('movie:tt2', null, ctx);

		expect(sources[0].torrent).not.toHaveProperty('fileIdx');
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

		expect(sources[1].headers).toEqual({ Referer: 'https://player.example.invalid/' });
	});

	it('keeps the addon’s own subtitle language rather than calling it unknown', async () => {
		const plugin = await load();
		const { ctx } = context({ '/stream/series/tt1:1:1.json': STREAMS });

		const sources = await plugin.resolve(
			'series:tt1',
			{ number: 1, sourceEpisodeId: 'tt1:1:1' },
			ctx
		);

		expect(sources[1].subtitles).toEqual([
			expect.objectContaining({ languageCode: 'eng', format: 'vtt' })
		]);
	});

	/**
	 * The distinction the whole failure vocabulary rests on. An addon returning
	 * sixty-seven torrents has answered; reporting that as "returned no stream"
	 * blames it for working as designed.
	 */
	it('returns torrents rather than refusing, even when they are all there is', async () => {
		// This used to throw "no torrent client", which was a bundle answering a
		// question about the device it happened to be running on.
		const plugin = await load();
		const { ctx } = context({
			'/stream/movie/tt2.json': { streams: [{ infoHash: 'a' }, { infoHash: 'b' }] }
		});

		const sources = await plugin.resolve('movie:tt2', null, ctx);

		expect(sources.map((one) => (one.torrent as { infoHash: string }).infoHash)).toEqual([
			'a',
			'b'
		]);
	});

	it('still says what it got when none of it is actionable at all', async () => {
		// A link to somebody else's player is not a stream on any device, so
		// there is nothing for a host to decide and the sentence still belongs
		// here.
		const plugin = await load();
		const { ctx } = context({
			'/stream/movie/tt2.json': {
				streams: [{ externalUrl: 'https://elsewhere.example.invalid/watch' }]
			}
		});

		await expect(plugin.resolve('movie:tt2', null, ctx)).rejects.toThrow(/another site/);
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

/**
 * The addon's own configuration, set inside this app rather than on its
 * website. The ecosystem's SDK parses one path segment as JSON
 * (`getRouter.js`), which is what makes the values applyable at all — without
 * that, rendering the form would be drawing a control that does nothing.
 */
describe('a configured addon', () => {
	const CONFIG = [
		{ id: 'api_key', key: 'apiKey', type: 'text' },
		{ id: 'dubbed', key: 'dubbed', type: 'switch' }
	];

	it('sends what the viewer set, keyed the way the addon spelled it', async () => {
		const plugin = await load([], CONFIG);
		const { ctx, asked } = context({}, [], { api_key: 'secret-value', dubbed: true });

		await plugin.listEpisodes('series:tt1', ctx).catch(() => undefined);

		const segment = encodeURIComponent(JSON.stringify({ apiKey: 'secret-value', dubbed: true }));
		expect(asked[0]).toBe(`${BASE}/${segment}/meta/series/tt1.json`);
	});

	it('leaves the address untouched when nothing is set', async () => {
		// The common case, and the one that would break: an addon configured on
		// its own page already carries its settings in the URL, and appending an
		// empty segment would change an address that was working.
		const plugin = await load([], CONFIG);
		const { ctx, asked } = context({}, [], {});

		await plugin.listEpisodes('series:tt1', ctx).catch(() => undefined);

		expect(asked[0]).toBe(`${BASE}/meta/series/tt1.json`);
	});

	it('leaves out a switch the viewer left off', async () => {
		const plugin = await load([], CONFIG);
		const { ctx, asked } = context({}, [], { dubbed: false, api_key: 'k' });

		await plugin.listEpisodes('series:tt1', ctx).catch(() => undefined);

		expect(asked[0]).toContain(encodeURIComponent(JSON.stringify({ apiKey: 'k' })));
	});

	it('adds no segment for an addon that declares no configuration', async () => {
		const plugin = await load([], []);
		const { ctx, asked } = context({}, [], { anything: 'ignored' });

		await plugin.listEpisodes('series:tt1', ctx).catch(() => undefined);

		expect(asked[0]).toBe(`${BASE}/meta/series/tt1.json`);
	});
});

/**
 * An addon that answers nothing until it has been set up.
 *
 * The case that made this necessary was measured on a live addon and is worth
 * stating, because every instinct says the opposite: it declares
 * `configurable: true`, `configurationRequired: false` and **no** `config[]`,
 * and then answers 403 to every stream request against its bare address — with
 * a browser's own user agent as readily as with ours — while returning 200 for
 * *any* configuration segment at all. Read as a status, that is an anti-bot
 * wall; read as a fact about the addon, it is a setup step nobody has taken.
 *
 * So these tests are about which of the two the bundle claims, and the whole
 * distinction rests on evidence the status does not carry.
 */
describe('an addon nobody has set up', () => {
	/** Answers one status to everything, so the branch is the only variable. */
	function refusing(status: number, asked: string[] = []) {
		return {
			asked,
			ctx: {
				http: {
					send: async (url: string) => {
						asked.push(url);
						return { status, url, headers: {}, text: async () => 'Forbidden' };
					}
				},
				settings: { string: () => '', boolean: () => false, list: () => [] },
				log: { debug() {}, warn() {} }
			}
		};
	}

	async function loadWith(over: Record<string, unknown>) {
		const directory = await mkdtemp(join(tmpdir(), 'stremio-entry-'));
		const file = join(directory, 'entry.mjs');
		await writeFile(
			file,
			stremioEntrypoint({
				pluginId: 'test.stremio',
				baseUrl: 'https://addon.example.invalid',
				types: ['movie', 'series'],
				resources: ['stream'],
				searchable: [],
				config: [],
				...over
			})
		);
		const module = (await import(`file://${file}`)) as Record<string, unknown>;
		return module['default'] as Plugin;
	}

	it('names the setup step rather than the status it was refused with', async () => {
		const plugin = await loadWith({
			configurable: true,
			baseConfigured: false,
			configureUrl: 'https://addon.example.invalid/configure'
		});
		const { ctx } = refusing(403);

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(
			/has not been set up/i
		);
	});

	it('points at the page that hands back the address to paste', async () => {
		const plugin = await loadWith({
			configurable: true,
			baseConfigured: false,
			configureUrl: 'https://addon.example.invalid/configure'
		});
		const { ctx } = refusing(403);

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(
			/addon\.example\.invalid\/configure/
		);
	});

	it('says nothing about a status, because a status is what misled this before', async () => {
		// The host classifies on these words. A `403` left in the sentence is
		// matched by its anti-bot pattern and the verdict reverts to the wrong
		// one with the right text underneath it.
		const plugin = await loadWith({
			configurable: true,
			configureUrl: 'https://x.example.invalid/configure'
		});
		const { ctx } = refusing(403);

		const error = await plugin.resolve('movie:tt1', undefined, ctx).catch((e: Error) => e);
		expect(String((error as Error).message)).not.toMatch(/403|forbidden|blocked/i);
	});

	it('accepts 401 as the same fact, because addons use both', async () => {
		const plugin = await loadWith({ configurable: true, configureUrl: '' });
		const { ctx } = refusing(401);

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(
			/has not been set up/i
		);
	});

	it('does not accuse an addon whose address already carries a configuration', async () => {
		// The pasted URL had a segment, so somebody *has* set this up and the
		// refusal is about something else. Telling them to configure a configured
		// addon is the mirror image of the bug this fixes.
		const plugin = await loadWith({ configurable: true, baseConfigured: true });
		const { ctx } = refusing(403);

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(/answered 403/);
	});

	it('does not accuse an addon the viewer configured inside this app', async () => {
		// Declared fields, filled in here: the address carries no segment and the
		// addon is configured all the same. Baking "unconfigured" in at
		// conversion time would have got this one wrong.
		const directory = await mkdtemp(join(tmpdir(), 'stremio-entry-'));
		const file = join(directory, 'entry.mjs');
		await writeFile(
			file,
			stremioEntrypoint({
				pluginId: 'test.stremio',
				baseUrl: 'https://addon.example.invalid',
				types: ['movie'],
				resources: ['stream'],
				searchable: [],
				config: [{ id: 'api_key', key: 'apiKey', type: 'text' }],
				configurable: true,
				baseConfigured: false,
				configureUrl: 'https://addon.example.invalid/configure'
			})
		);
		const module = (await import(`file://${file}`)) as Record<string, unknown>;
		const plugin = module['default'] as Plugin;

		const asked: string[] = [];
		const ctx = {
			http: {
				send: async (url: string) => {
					asked.push(url);
					return { status: 403, url, headers: {}, text: async () => '' };
				}
			},
			settings: {
				string: (id: string) => (id === 'api_key' ? 'filled-in' : ''),
				boolean: () => false,
				list: () => []
			},
			log: { debug() {}, warn() {} }
		};

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(/answered 403/);
	});

	it('leaves an addon that is not configurable at all alone', async () => {
		const plugin = await loadWith({ configurable: false });
		const { ctx } = refusing(403);

		await expect(plugin.resolve('movie:tt1', undefined, ctx)).rejects.toThrow(/answered 403/);
	});
});
