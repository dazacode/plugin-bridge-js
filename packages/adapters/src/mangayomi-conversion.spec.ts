/**
 * Converting a Mangayomi JavaScript source, and running the bundle.
 *
 * The sibling of `conversion.spec.ts`, and it asserts the same three things
 * for the second format that converts: that the output is an ordinary bundle,
 * that conversion is deterministic, and that the shim actually works when the
 * bundle is imported and driven.
 *
 * What is different here, and what most of this file is about: this format
 * hands a source **globals it expects to already exist** — a jsoup-shaped
 * `Document`, a `Client`, an `MProvider` base — where the first converted
 * format only needed `fetch`. So the interesting failures are not in the
 * adapter but in that runtime, and the source below is written to touch all of
 * it: parsed markup, property-shaped element access, a preference read, and a
 * stream list with a sentinel in it.
 *
 * The source under test is written inline, in the format's own idiom, against
 * a fake host. Nothing here touches the network and no real source appears
 * (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { listingRefusal, type ConversionServices } from '@plugin-bridge/core/adapter';
import { mangayomiAdapter } from '@plugin-bridge/adapters/mangayomi';
import { extractorNames } from '@plugin-bridge/runtime/shims/mangayomi-entry';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/* ── the foreign source, in its own idiom ─────────────────────────────────── */

const SOURCE = `
const mangayomiSources = [{
  "name": "Example", "id": 1, "lang": "en",
  "baseUrl": "https://watch.example.invalid",
  "apiUrl": "https://api.example.invalid",
  "itemType": 1, "version": "0.1.0", "isManga": false, "isNsfw": false
}];

class DefaultExtension extends MProvider {
  constructor() {
    super();
    this.client = new Client();
  }

  async getPopular(page) {
    const res = await this.client.get(this.source.baseUrl + "/popular?p=" + page, {});
    const doc = new Document(res.body);
    const list = [];
    for (const item of doc.select("li.card")) {
      const anchor = item.selectFirst("a");
      list.push({
        name: anchor.text,
        link: anchor.getHref,
        imageUrl: item.selectFirst("img").getSrc
      });
    }
    return { list, hasNextPage: true };
  }

  async search(query, page, filters) {
    const res = await this.client.get(this.source.baseUrl + "/s?q=" + query, {});
    const doc = new Document(res.body);
    const list = [];
    for (const item of doc.select("li.card")) {
      const anchor = item.selectFirst("a");
      list.push({ name: anchor.text, link: anchor.getHref });
    }
    return { list, hasNextPage: false };
  }

  async getDetail(url) {
    const res = await this.client.get(this.source.baseUrl + url, {});
    const doc = new Document(res.body);
    const episodes = [];
    // Newest first, which is what most of these sites render.
    for (const row of doc.select("ul.eps li a")) {
      episodes.push({ name: row.text, url: row.getHref });
    }
    return { description: doc.selectFirst("p.syn").text, episodes };
  }

  async getVideoList(url) {
    const server = this.getPreference("example_server");
    return [
      { url: "https://cdn.example.invalid/a/index.m3u8", originalUrl: url, quality: server + " 1080p" },
      { url: "https://cdn.example.invalid/a/low.mp4", originalUrl: url, quality: "HD" },
      // A source that has given up: a bare origin, no path.
      { url: "https://cdn.example.invalid", originalUrl: url, quality: "broken" }
    ];
  }

  getSourcePreferences() {
    return [{
      key: "example_server",
      listPreference: {
        title: "Server", summary: "", valueIndex: 1,
        entries: ["Alpha", "Beta"], entryValues: ["alpha", "beta"]
      }
    }];
  }
}
`;

const PAGES: Record<string, string> = {
	'https://watch.example.invalid/popular?p=1':
		'<ul><li class="card"><a href="/anime/one">One &amp; Only</a><img src="/img/1.jpg"></li>' +
		'<li class="card"><a href="/anime/two">Two</a><img src="/img/2.jpg"></li></ul>',
	'https://watch.example.invalid/s?q=one':
		'<ul><li class="card"><a href="/anime/one">One &amp; Only</a></li></ul>',
	'https://watch.example.invalid/anime/one':
		'<p class="syn">A synopsis.</p>' +
		'<ul class="eps"><li><a href="/anime/one/3">Episode 3</a></li>' +
		'<li><a href="/anime/one/2">Episode 2</a></li>' +
		'<li><a href="/anime/one/1">Episode 1</a></li></ul>'
};

/* ── the listing, built through the adapter's own parser ──────────────────── */

const INDEX_URL = 'https://raw.githubusercontent.com/owner/repo/main/anime_index.json';

function indexBody(sourceCodeLanguage: 0 | 1, itemType = 1): string {
	return JSON.stringify([
		{
			name: 'Example',
			id: 'example',
			lang: 'en',
			baseUrl: 'https://watch.example.invalid',
			apiUrl: 'https://api.example.invalid',
			itemType,
			version: '0.1.0',
			isNsfw: false,
			sourceCodeLanguage,
			sourceCodeUrl: 'https://raw.githubusercontent.com/owner/repo/main/js/example.js'
		}
	]);
}

function listingOf(sourceCodeLanguage: 0 | 1, itemType = 1): RepositoryPlugin {
	const index = mangayomiAdapter.parseIndex(indexBody(sourceCodeLanguage, itemType), INDEX_URL);
	return index.plugins[0];
}

/**
 * The services a conversion is given, carrying only the one this format uses.
 *
 * A source in this format is the single script its listing names, so the
 * byte-fetcher is the whole of it. The other two exist for the format that
 * converts from a source tree, and they throw rather than answer emptily: an
 * adapter that quietly started listing directories would otherwise read an
 * empty repository here and report it as a source with nothing in it.
 */
function servicesFor(script: string): ConversionServices {
	return {
		fetchArtifact: async () => new TextEncoder().encode(script),
		getText: () => {
			throw new Error('this format converts one artifact and reads no sibling file');
		},
		listFiles: () => {
			throw new Error('this format converts one artifact and lists no directory');
		}
	};
}

async function convert(listing = listingOf(1)): Promise<Uint8Array> {
	return await mangayomiAdapter.convert(listing, servicesFor(SOURCE));
}

/* ── the fake host ────────────────────────────────────────────────────────── */

function context(settings: Record<string, string> = {}): {
	ctx: unknown;
	requested: string[];
} {
	const requested: string[] = [];
	const ctx = {
		http: {
			async send(url: string) {
				requested.push(url);
				const body = PAGES[url] ?? '';
				return {
					status: 200,
					url,
					headers: {},
					text: async () => body,
					json: async () => JSON.parse(body || '{}')
				};
			}
		},
		settings: {
			string: (id: string) => settings[id] ?? '',
			boolean: () => false,
			list: () => []
		},
		text: {
			encode: (value: string) => new TextEncoder().encode(value),
			decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		},
		bytes: {
			toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
			fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
		}
	};
	return { ctx, requested };
}

interface LoadedModule {
	id: string;
	searchCatalog(
		query: string,
		page: number,
		ctx: unknown
	): Promise<{
		entries: {
			sourceMediaId: string;
			title: string;
			posterImageUrl?: string;
		}[];
	}>;
	browse(
		shelf: string,
		page: number,
		ctx: unknown
	): Promise<{
		entries: {
			sourceMediaId: string;
			title: string;
			posterImageUrl?: string;
		}[];
	}>;
	listEpisodes(
		id: string,
		ctx: unknown
	): Promise<{ number: number; sourceEpisodeId: string; title?: string }[]>;
	resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
}

async function loadModule(): Promise<LoadedModule> {
	const bundle = await openPluginArchive(await convert());
	const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
	return (await import(/* @vite-ignore */ url)).default as LoadedModule;
}

/* ── the tests ────────────────────────────────────────────────────────────── */

describe('which listings this format offers', () => {
	it('offers a JavaScript anime source', () => {
		expect(listingRefusal(listingOf(1))).toBeNull();
	});

	it('refuses a Dart source by naming the language, not the format', () => {
		const refusal = listingRefusal(listingOf(0));
		expect(refusal).toMatch(/written in Dart/);
		// The point of the per-listing refusal: the same repository's JavaScript
		// sources install, so a format-wide sentence would be a lie.
		expect(refusal).not.toMatch(/manga and novel/);
	});

	it('refuses to convert a Dart source rather than producing a broken bundle', async () => {
		await expect(convert(listingOf(0))).rejects.toThrow(/written in Dart/);
	});

	it('filters a manga listing out of the catalogue entirely', () => {
		const index = mangayomiAdapter.parseIndex(indexBody(1, 0), INDEX_URL);
		expect(index.plugins).toHaveLength(0);
	});
});

describe('the bundle a conversion produces', () => {
	it('is an ordinary bundle, read by the ordinary reader', async () => {
		const bundle = await openPluginArchive(await convert());
		expect(bundle.manifest.id).toBe(listingOf(1).id);
		expect(bundle.entrypointSource.length).toBeGreaterThan(0);
	});

	it('converts the same input to the same bytes', async () => {
		const [first, second] = [await convert(), await convert()];
		expect(Array.from(first)).toEqual(Array.from(second));
	});

	it('declares the hosts the code names, not only the ones the index did', async () => {
		const bundle = await openPluginArchive(await convert());
		// The index names where the source lives; the CDN appears only in the
		// code, and a plugin refused that host resolves nothing.
		const network = bundle.manifest.network as { hosts: string[] };
		expect(network.hosts).toContain('cdn.example.invalid');
	});
});

describe('the generated entrypoint, run', () => {
	it('identifies as the id its manifest declares', async () => {
		const module = await loadModule();
		expect(module.id).toBe(listingOf(1).id);
	});

	it('parses markup through the inlined DOM engine', async () => {
		const module = await loadModule();
		const { ctx, requested } = context();

		const page = await module.browse('popular', 1, ctx);

		expect(requested).toEqual(['https://watch.example.invalid/popular?p=1']);
		expect(page.entries).toHaveLength(2);
		// `.text` is a property in this format and a method on the parser
		// underneath; getting that wrong yields a function object, not an error.
		expect(page.entries[0].title).toBe('One & Only');
		// Relative in the markup, absolute in the entry: a media id is stored,
		// and a relative one stops resolving the moment it is.
		expect(page.entries[0].sourceMediaId).toBe('https://watch.example.invalid/anime/one');
		expect(page.entries[0].posterImageUrl).toBe('https://watch.example.invalid/img/1.jpg');
	});

	it('searches through the source’s own search method', async () => {
		const module = await loadModule();
		const { ctx } = context();

		const page = await module.searchCatalog('one', 1, ctx);
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0].title).toBe('One & Only');
	});

	it('numbers a newest-first episode list so that episode one is episode one', async () => {
		const module = await loadModule();
		const { ctx } = context();

		const episodes = await module.listEpisodes('https://watch.example.invalid/anime/one', ctx);

		// The format states no numbers, only an order, and these sites list
		// newest first. Counting from the end is what makes the grid agree.
		expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
		expect(episodes[0].sourceEpisodeId).toBe('https://watch.example.invalid/anime/one/1');
		expect(episodes[0].title).toBe('Episode 1');
	});

	it('resolves streams, sniffing the container and refusing the sentinel', async () => {
		const module = await loadModule();
		const { ctx } = context();

		const sources = await module.resolve(
			'https://watch.example.invalid/anime/one',
			{ sourceEpisodeId: 'https://watch.example.invalid/anime/one/1' },
			ctx
		);

		// Three were returned; the bare origin is a source saying it failed.
		expect(sources).toHaveLength(2);
		expect(sources[0].container).toBe('hls');
		expect(sources[1].container).toBe('mp4');
	});

	it('reads a height only from a quality string that states one', async () => {
		const module = await loadModule();
		const { ctx } = context();

		const sources = await module.resolve('x', { sourceEpisodeId: 'y' }, ctx);

		expect(sources[0].heightPx).toBe(1080);
		// "HD" states no height, and inventing one puts a confident wrong
		// number in the player's quality menu.
		expect(sources[1].heightPx).toBeUndefined();
		expect(sources[1].label).toBe('HD');
	});

	it('falls back to the source’s own declared preference default', async () => {
		const module = await loadModule();
		const { ctx } = context();

		const sources = await module.resolve('x', { sourceEpisodeId: 'y' }, ctx);
		// valueIndex 1 of ["alpha","beta"]. A converted bundle declares no
		// settings, so without this the source reads an empty string and fails
		// somewhere far from the cause.
		expect(sources[0].label).toBe('beta 1080p');
	});

	it('prefers the viewer’s stored value over the declared default', async () => {
		const module = await loadModule();
		const { ctx } = context({ example_server: 'alpha' });

		const sources = await module.resolve('x', { sourceEpisodeId: 'y' }, ctx);
		expect(sources[0].label).toBe('alpha 1080p');
	});
});

describe('the settings the conversion declares on the source’s behalf', () => {
	it('puts the source’s own preference in the manifest, for the host to draw', async () => {
		const bundle = await openPluginArchive(await convert());
		expect(bundle.settings).toEqual([
			{
				id: 'example_server',
				key: 'example_server',
				type: 'select',
				label: 'Server',
				options: [
					{ value: 'alpha', label: 'Alpha' },
					{ value: 'beta', label: 'Beta' }
				],
				default: 'beta'
			}
		]);
	});

	it('declares nothing for a source that declares nothing, and that source still runs', async () => {
		// The regression that matters most: every converted bundle installed
		// before settings existed declares none, and must keep reading its own
		// fallback rather than an empty string.
		const bare = SOURCE.replace(/ {2}getSourcePreferences\(\) \{[\s\S]*?\n {2}\}\n/, '');
		const bytes = await mangayomiAdapter.convert(listingOf(1), servicesFor(bare));
		const bundle = await openPluginArchive(bytes);
		expect(bundle.settings).toEqual([]);
		expect(bundle.manifest['settings']).toBeUndefined();

		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as LoadedModule;
		const { ctx } = context();
		const sources = await module.resolve('x', { sourceEpisodeId: 'y' }, ctx);
		// `getPreference` on a source declaring nothing answers '', which is
		// what it answered before any of this existed.
		expect(sources[0].label).toBe('1080p');
	});
});

describe('a source that needs a per-host extractor', () => {
	// The capture-and-replace pattern this ecosystem actually uses. In a module
	// — and a bundle is a module — the assignment on the first line throws
	// before any call is reached, unless the name is declared.
	const WRAPPING = `
const mangayomiSources = [{ "name": "E", "baseUrl": "https://watch.example.invalid", "itemType": 1 }];
_someHostExtractor = someHostExtractor;
someHostExtractor = async (url) => { return await _someHostExtractor(url); };

class DefaultExtension extends MProvider {
  async search(query, page, filters) { return { list: [{ name: "One", link: "/one" }], hasNextPage: false }; }
  async getDetail(url) { return { episodes: [{ name: "Episode 1", url: "/one/1" }] }; }
  async getVideoList(url) { return await someHostExtractor("https://embed.example.invalid/v"); }
}
`;

	async function loadWrapping(): Promise<LoadedModule> {
		const listing = listingOf(1);
		const bytes = await mangayomiAdapter.convert(listing, servicesFor(WRAPPING));
		const bundle = await openPluginArchive(bytes);
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		return (await import(/* @vite-ignore */ url)).default as LoadedModule;
	}

	it('finds both spellings the pattern uses', () => {
		expect(extractorNames(WRAPPING)).toEqual(['_someHostExtractor', 'someHostExtractor']);
	});

	it('names no extractor in this repository — the names come from the source', () => {
		// FOREIGN.md §4.1.3: a per-host extractor is made of a content source's
		// hostnames, so it may not live here. The stub list is derived from the
		// file being converted, on the viewer's own device.
		expect(extractorNames('const a = 1;')).toEqual([]);
	});

	it('still loads, searches and lists episodes', async () => {
		const module = await loadWrapping();
		const { ctx } = context();

		const page = await module.searchCatalog('one', 1, ctx);
		expect(page.entries[0].title).toBe('One');

		const episodes = await module.listEpisodes('https://watch.example.invalid/one', ctx);
		expect(episodes).toHaveLength(1);
	});

	it('fails at resolve, naming the extractor rather than throwing on undefined', async () => {
		const module = await loadWrapping();
		const { ctx } = context();

		// This is the step `verify.ts` runs before recording an install, so the
		// refusal reaches a person as a sentence instead of a black screen.
		await expect(
			module.resolve('https://watch.example.invalid/one', { sourceEpisodeId: '/one/1' }, ctx)
		).rejects.toThrow(/someHostExtractor/);
	});
});

describe('numbering an episode list', () => {
	// Five listings, because the numbering question has that many different
	// right answers and the shim has to tell them apart.
	const LISTS = `
const mangayomiSources = [{ "name": "E", "baseUrl": "https://watch.example.invalid", "itemType": 1 }];

class DefaultExtension extends MProvider {
  async getDetail(url) {
    if (url === "/oldest-first") {
      return { name: "Steins;Gate 0", episodes: [
        { name: "Steins;Gate 0 - Episode 1", url: "/s/1" },
        { name: "Steins;Gate 0 - Episode 2", url: "/s/2" },
        { name: "Steins;Gate 0 - Episode 3", url: "/s/3" }
      ] };
    }
    if (url === "/nameless") {
      return { name: "Nameless", episodes: [
        { url: "/n/c" }, { url: "/n/b" }, { url: "/n/a" }
      ] };
    }
    if (url === "/season-plus-extra") {
      // Eleven named episodes, newest first, and one unnamed extra after them.
      const episodes = [];
      for (let n = 11; n >= 1; n -= 1) {
        episodes.push({ name: "Show - Episode " + n, url: "/p/" + n });
      }
      episodes.push({ url: "/p/extra" });
      return { name: "Show", episodes: episodes };
    }
    if (url === "/gap") {
      return { name: "Show", episodes: [
        { name: "Show - Episode 1", url: "/g/1" },
        { url: "/g/x" },
        { name: "Show - Episode 3", url: "/g/3" }
      ] };
    }
    if (url === "/twins") {
      return { name: "Show", episodes: [
        { name: "Show - Episode 5", url: "/t/5a" },
        { url: "/t/x" },
        { name: "Show - Episode 5", url: "/t/5b" }
      ] };
    }
    if (url === "/out-of-order") {
      return { name: "Show", episodes: [
        { name: "Show - Episode 1", url: "/o/1" },
        { url: "/o/x" },
        { name: "Show - Episode 3", url: "/o/3" },
        { name: "Show - Episode 2", url: "/o/2" }
      ] };
    }
    return { name: "Show", episodes: [
      { name: "[Group] Show - S02E07 (1080p)", url: "/x/7" },
      { name: "Show - 06.5 Recap", url: "/x/65" }
    ] };
  }
}
`;

	async function loadLists(): Promise<LoadedModule> {
		const bytes = await mangayomiAdapter.convert(listingOf(1), servicesFor(LISTS));
		const bundle = await openPluginArchive(bytes);
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		return (await import(/* @vite-ignore */ url)).default as LoadedModule;
	}

	it('reads the number out of the name, so an oldest-first season is not reversed', async () => {
		const module = await loadLists();
		const { ctx } = context();

		const episodes = await module.listEpisodes('https://watch.example.invalid/oldest-first', ctx);

		// Counting from the end of the list would pair episode one with three.
		// That is the gap `KNOWN_GAPS.md` recorded, and this is the listing
		// shape that used to fail.
		expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
		expect(episodes.map((episode) => episode.sourceEpisodeId)).toEqual([
			'https://watch.example.invalid/s/1',
			'https://watch.example.invalid/s/2',
			'https://watch.example.invalid/s/3'
		]);
	});

	it('does not let a show whose title has digits renumber its own season', async () => {
		const module = await loadLists();
		const { ctx } = context();

		// "Steins;Gate 0" — the zero is part of the title. Reading a number out
		// of the raw name gives every episode a zero, which is exactly why
		// naive name-parsing was rejected in favour of counting. The title is
		// removed first, and the detail's own `name` is where it comes from.
		const episodes = await module.listEpisodes('https://watch.example.invalid/oldest-first', ctx);
		expect(episodes.every((episode) => episode.number > 0)).toBe(true);
	});

	it('falls back to the position when a name states no number', async () => {
		const module = await loadLists();
		const { ctx } = context();

		const episodes = await module.listEpisodes('https://watch.example.invalid/nameless', ctx);

		// Nothing to read, so the honest answer is still the old one: this
		// format states an order, these sites list newest first, count from the
		// end. Nothing here fixes a nameless list that runs the other way.
		expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
		expect(episodes[0].sourceEpisodeId).toBe('https://watch.example.invalid/n/a');
	});

	it('reads the lookbehind and the decimal, so a season marker and a recap both land', async () => {
		const module = await loadLists();
		const { ctx } = context();

		const episodes = await module.listEpisodes('https://watch.example.invalid/mixed', ctx);

		// Seven from the lookbehind — `s02` must not win over `e07` — and
		// six-and-a-half from the decimal, which is a recap sitting between two
		// episodes rather than displacing one of them.
		expect(episodes.map((episode) => episode.number)).toEqual([6.5, 7]);
		expect(episodes[1].sourceEpisodeId).toBe('https://watch.example.invalid/x/7');
	});

	it('never gives an unnamed row a number one of the names already claimed', async () => {
		const module = await loadLists();
		const { ctx } = context();

		// Eleven named episodes newest-first, then one unnamed extra. Counting
		// that extra from the end of the list gives it 1 — which episode one
		// already has, and two rows claiming the same episode is a wrong number
		// in front of a viewer. It is placed past the end of the run instead.
		const episodes = await module.listEpisodes(
			'https://watch.example.invalid/season-plus-extra',
			ctx
		);
		const numbers = episodes.map((episode) => episode.number);

		expect(numbers).toHaveLength(12);
		expect(new Set(numbers).size).toBe(numbers.length);
		expect(numbers).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

		// And the source's order survives: the extra sat next to episode one in
		// the newest-first list, and it is still next to episode one after the
		// list has been turned the right way round.
		expect(episodes[0].sourceEpisodeId).toBe('https://watch.example.invalid/p/extra');
		expect(episodes[0].title).toBeUndefined();
		expect(episodes[1].title).toBe('Show - Episode 1');
	});

	it('places an unnamed row between the named ones that surround it', async () => {
		const module = await loadLists();
		const { ctx } = context();

		const episodes = await module.listEpisodes('https://watch.example.invalid/gap', ctx);

		// One, then something, then three. The something is two — taken from
		// where it sits between its neighbours, not from a count that knows
		// nothing about them.
		expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 3]);
		expect(episodes[1].sourceEpisodeId).toBe('https://watch.example.invalid/g/x');
	});

	it('still moves an unnamed row when both its neighbours claim the same number', async () => {
		const module = await loadLists();
		const { ctx } = context();

		// Two rows both named "Episode 5" with something between them. There is
		// no distance to share out, so the row would land on 5 as well. It
		// steps off instead.
		const episodes = await module.listEpisodes('https://watch.example.invalid/twins', ctx);
		const numbers = episodes.map((episode) => episode.number);

		expect(numbers).toEqual([4.5, 5, 5]);
		expect(episodes[0].sourceEpisodeId).toBe('https://watch.example.invalid/t/x');
		// The bound of the guarantee, stated: a filled row never takes a number
		// a name claimed. Two *names* claiming one number is the source's own
		// doing and is left exactly as the source said it.
		expect(episodes[1].title).toBe('Show - Episode 5');
		expect(episodes[2].title).toBe('Show - Episode 5');
	});

	it('moves a filled number off a name that claimed it elsewhere in the list', async () => {
		const module = await loadLists();
		const { ctx } = context();

		// One, something, three, two — a list the source made strange. The
		// something interpolates to 2, which the fourth row's name already has,
		// so it creeps toward the row after it without passing it.
		const episodes = await module.listEpisodes('https://watch.example.invalid/out-of-order', ctx);
		const numbers = episodes.map((episode) => episode.number);

		expect(new Set(numbers).size).toBe(numbers.length);
		expect(numbers).toEqual([1, 2, 2.5, 3]);
		// Still strictly between the two names that surround it in the list.
		expect(episodes[2].sourceEpisodeId).toBe('https://watch.example.invalid/o/x');
	});
});
