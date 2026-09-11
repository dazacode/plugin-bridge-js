/**
 * A translated Kotlin extension, packaged and driven.
 *
 * The third end-to-end conversion spec, after `conversion.spec.ts` and
 * `mangayomi-conversion.spec.ts`, and the one with the most moving parts: this
 * format's bundle carries a jsoup engine, a Kotlin standard library, an okhttp
 * facade and a reimplementation of the base class's driver, and every one of
 * them has to agree with the others inside a single self-contained module.
 *
 * ## Why the translated source here is written by hand
 *
 * `emit.ts` produces it in the product. Pinning that output *here* would make
 * this spec fail whenever the emitter's formatting changed, which is the
 * failure mode that produces four hundred tests nobody trusts. So this spec
 * owns the **contract between the translated code and everything around it** —
 * what the driver calls, in what order, and what it does with the answers —
 * and the emitter's own specs own whether it produces this shape from Kotlin.
 *
 * The class below is written the way a translated `ParsedAnimeHttpSource`
 * subclass looks: selectors for the listing, an overridden `episodeListParse`,
 * an overridden `getVideoList`. That mixture is deliberate, because it is the
 * mixture the catalogue actually contains — `FOREIGN.md` §4.1.4 measured that
 * extensions override their template's *behaviour* far more often than they
 * merely configure it, and a driver that only handled the configured case
 * would look correct here and fail on the real ecosystem.
 *
 * Nothing here touches the network and no real source appears (rule 9).
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { SUPER_MEMBERS } from '@plugin-bridge/core/kotlin/subset';
import { aniyomiEntrypoint } from '@plugin-bridge/runtime/shims/aniyomi-entry';
import { namesCookieJar, packageBundle } from '@plugin-bridge/core/package';

const PLUGIN_ID = 'app.yorozo.converted.aniyomi.example';
const BASE_URL = 'https://watch.example.invalid';

const TRANSLATED = `
class Extension {
  constructor() {
    this.baseUrl = '${BASE_URL}';
    this.name = 'Example';
    this.lang = 'en';
  }

  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return 'li.card'; }
  popularAnimeNextPageSelector() { return 'a.next'; }
  popularAnimeFromElement(element) {
    const anime = SAnime.create();
    anime.setUrlWithoutDomain(__k.nn(element.selectFirst('a'), 'a').attr('href'));
    anime.title = __k.nn(element.selectFirst('h3'), 'h3').text();
    const img = element.selectFirst('img');
    anime.thumbnail_url = img === null ? null : img.attr('abs:src');
    return anime;
  }

  searchAnimeRequest(page, query, filters) { return GET(this.baseUrl + '/search?q=' + query, {}); }
  searchAnimeSelector() { return 'li.card'; }
  searchAnimeFromElement(element) { return this.popularAnimeFromElement(element); }

  async episodeListParse(response) {
    const doc = response.asJsoup();
    return __k.map(doc.select('ul.eps li'), (el) => {
      const ep = SEpisode.create();
      ep.name = el.text();
      ep.episode_number = __k.toFloatOrNull(el.attr('data-num')) ?? 0;
      ep.setUrlWithoutDomain(__k.nn(el.selectFirst('a'), 'a').attr('href'));
      return ep;
    });
  }

  async getVideoList(episode) {
    const doc = (await client.newCall(GET(this.baseUrl + episode.url, {})).execute()).asJsoup();
    return __k.mapNotNull(doc.select('source'), (s) => {
      const src = s.attr('src');
      return src === '' ? null : Video(src, s.attr('label') || 'default', src, {});
    });
  }
}
`;

const PAGES: Record<string, string> = {
	[`${BASE_URL}/popular?page=1`]:
		'<ul><li class="card"><a href="/anime/one">x</a><h3>One &amp; Only</h3><img src="/p1.jpg"></li>' +
		'<li class="card"><a href="/anime/two">y</a><h3>Two</h3></li></ul>' +
		'<a class="next" href="?p=2">next</a>',
	[`${BASE_URL}/search?q=one`]:
		'<ul><li class="card"><a href="/anime/one">x</a><h3>One &amp; Only</h3></li></ul>',
	[`${BASE_URL}/anime/one`]:
		'<ul class="eps"><li data-num="1"><a href="/anime/one/1">Episode 1</a></li>' +
		'<li data-num="2"><a href="/anime/one/2">Episode 2</a></li></ul>',
	[`${BASE_URL}/anime/one/1`]:
		'<video><source src="https://cdn.example.invalid/a/index.m3u8" label="1080p">' +
		'<source src="" label="broken"></video>',

	// The hoster path: an episode page lists *places to get it from*, and each
	// of those is a second page carrying the streams.
	[`${BASE_URL}/anime/hosted/1`]:
		'<a class="host" href="/host/a">Alpha</a><a class="host" href="/host/b">Beta</a>',
	[`${BASE_URL}/host/a`]:
		'<video><source src="https://cdn.example.invalid/a/1080.mp4" label="1080p"></video>',
	[`${BASE_URL}/host/b`]:
		'<video><source src="https://cdn.example.invalid/b/720.mp4" label="720p"></video>'
};

/** The shape of a class translated from the current API, reused by several tests. */
function hosterExtension(extra = ''): string {
	return `
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }

  hosterListRequest(episode) { return GET(this.baseUrl + episode.url, {}); }
  hosterListParse(response) {
    return __k.map(response.asJsoup().select('a.host'), (el) =>
      Hoster(this.baseUrl + el.attr('href'), el.text()));
  }

  // The hoster overload: one place, opened. Kotlin tells this apart from the
  // episode overload by type; after translation only the class's shape does.
  async getVideoList(hoster) {
    const doc = (await client.newCall(GET(hoster.hosterUrl, {})).execute()).asJsoup();
    return __k.map(doc.select('source'), (s) =>
      Video(s.attr('src'), s.attr('label'), s.attr('src'), {}));
  }
${extra}
}
`;
}

const HOSTED = { sourceEpisodeId: `${BASE_URL}/anime/hosted/1` };

function context(): { ctx: unknown; requested: string[] } {
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
					json: async () => ({})
				};
			}
		},
		settings: { string: () => '', boolean: () => false, list: () => [] },
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

interface Page {
	entries: { sourceMediaId: string; title: string; posterImageUrl?: string }[];
	hasMore?: boolean;
}

interface Loaded {
	id: string;
	searchCatalog(query: string, page: number, ctx: unknown): Promise<Page>;
	browse(shelf: string, page: number, ctx: unknown): Promise<Page>;
	listEpisodes(
		id: string,
		ctx: unknown
	): Promise<{ number: number; sourceEpisodeId: string; title?: string }[]>;
	resolve(id: string, episode: unknown, ctx: unknown): Promise<Stream[]>;
}

interface Stream {
	url: string;
	container: string;
	label: string;
	quality?: string;
	/** What the request for this stream must carry — a `Referer`, usually. */
	headers?: Record<string, string>;
}

async function convert(translated = TRANSLATED): Promise<Uint8Array> {
	return await packageBundle({
		id: PLUGIN_ID,
		name: 'Example',
		description: 'Converted Aniyomi extension.',
		version: '14.5',
		author: 'owner',
		hosts: ['watch.example.invalid', 'cdn.example.invalid'],
		origin: {
			format: 'aniyomi',
			artifactUrl: 'https://raw.githubusercontent.com/owner/repo/main/apk/example.apk',
			foreignId: 'example',
			foreignVersion: '14.5',
			mediaKind: 'anime',
			isNsfw: false
		},
		entrypointSource: aniyomiEntrypoint({
			pluginId: PLUGIN_ID,
			translatedSource: translated,
			className: 'Extension',
			baseUrl: BASE_URL
		}),
		// Asked of the translated module, exactly as `aniyomi.ts` asks it.
		usesCookies: namesCookieJar(translated),
		license: 'Apache-2.0',
		repository: 'https://github.com/owner/repo'
	});
}

async function load(translated = TRANSLATED): Promise<Loaded> {
	const bundle = await openPluginArchive(await convert(translated));
	// A file rather than a `data:` URL: this bundle carries a whole runtime and
	// is far past the length a data URL can be imported at.
	const { writeFileSync, mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const file = join(mkdtempSync(join(tmpdir(), 'yorozo-')), 'bundle.mjs');
	writeFileSync(file, bundle.entrypointSource, 'utf8');
	return (await import(/* @vite-ignore */ `file:///${file.replace(/\\/g, '/')}`)).default as Loaded;
}

describe('the bundle a translated extension becomes', () => {
	it('is an ordinary bundle carrying its upstream licence', async () => {
		const bundle = await openPluginArchive(await convert());
		expect(bundle.manifest.id).toBe(PLUGIN_ID);
		expect((bundle.manifest as Record<string, unknown>).license).toBe('Apache-2.0');
	});

	it('identifies as the id its manifest declares', async () => {
		// The sandbox refuses a bundle whose code disagrees with its manifest.
		expect((await load()).id).toBe(PLUGIN_ID);
	});

	it('asks for cookies only when the translated module says it needs them', async () => {
		// The jar is authority a viewer is shown before installing, so it is a
		// declared permission rather than something every conversion gets. The
		// question is asked of the *translated* module: an entrypoint carries
		// our own runtime, and our own runtime contains the jar shims, so
		// reading the whole bundle would answer yes for everything ever built.
		const plain = await openPluginArchive(await convert());
		expect(plain.permissions).toEqual(['network']);

		const jarred = await openPluginArchive(
			await convert(
				`${TRANSLATED}\nconst __uses = (c, u, r) => c.cookieJar.saveFromResponse(u, r);\n`
			)
		);
		expect(jarred.permissions).toEqual(['network', 'cookies']);
	});
});

describe('the driver this build supplies in place of the base class', () => {
	it('reads a listing page from selectors the extension only declares', async () => {
		const module = await load();
		const { ctx } = context();

		const page = await module.browse('popular', 1, ctx);

		expect(page.entries).toHaveLength(2);
		expect(page.entries[0].title).toBe('One & Only');
		// Stored, so absolute — a relative media id stops resolving the moment
		// it leaves this process.
		expect(page.entries[0].sourceMediaId).toBe(`${BASE_URL}/anime/one`);
		expect(page.entries[0].posterImageUrl).toBe(`${BASE_URL}/p1.jpg`);
	});

	it('reports another page only when the next-page selector matches', async () => {
		const module = await load();
		const { ctx } = context();

		expect((await module.browse('popular', 1, ctx)).hasMore).toBe(true);
		// The search page carries no `a.next`, and claiming otherwise makes a
		// caller paginate forever.
		expect((await module.searchCatalog('one', 1, ctx)).hasMore).toBe(false);
	});

	it('treats an empty query as the shelf rather than as a search for nothing', async () => {
		const module = await load();
		const { ctx, requested } = context();

		await module.searchCatalog('', 1, ctx);
		// The browse screen asks for a catalogue before anybody has typed.
		expect(requested).toEqual([`${BASE_URL}/popular?page=1`]);
	});

	it('prefers the extension’s own override to the default it would have used', async () => {
		const module = await load();
		const { ctx } = context();

		// `episodeListParse` is overridden here, and an extension overrides its
		// template's behaviour far more often than it configures it. A driver
		// preferring its own implementation would ignore the translated code.
		const episodes = await module.listEpisodes(`${BASE_URL}/anime/one`, ctx);
		expect(episodes.map((episode) => episode.number)).toEqual([1, 2]);
		expect(episodes[0].title).toBe('Episode 1');
		expect(episodes[0].sourceEpisodeId).toBe(`${BASE_URL}/anime/one/1`);
	});

	it('hands an extension its own id back in the form it emitted', async () => {
		const module = await load();
		const { ctx, requested } = context();

		await module.listEpisodes(`${BASE_URL}/anime/one`, ctx);
		// These extensions call `setUrlWithoutDomain` and then concatenate their
		// own base url. Passing the stored absolute id straight through builds a
		// doubled origin and a request that can only 404.
		expect(requested.every((url) => url.split('https://').length === 2)).toBe(true);
	});

	it('resolves a stream and refuses the failure sentinel', async () => {
		const module = await load();
		const { ctx } = context();

		const sources = await module.resolve(
			`${BASE_URL}/anime/one`,
			{ sourceEpisodeId: `${BASE_URL}/anime/one/1` },
			ctx
		);

		// Two `<source>` elements; the empty one is the source saying it failed.
		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/a/index.m3u8');
		expect(sources[0].container).toBe('hls');
		expect(sources[0].quality).toBe('1080p');
	});
});

describe('super, which is the single largest blocker in the catalogue', () => {
	// Measured across all 254 extensions: an explicit `super.` call blocks 100
	// of them — more than any other construct. It is answerable here and only
	// here, because this file *is* the base class those calls refer to.
	//
	// This does not contradict the rule that a refused override never falls back
	// to the base implementation. That rule guards against guessing when we
	// could not read a member. An explicit `super.` call is the extension
	// stating, in its own source, that the base behaviour belongs at this point.
	const WRAPPING = `
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }

  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return 'li.card'; }
  popularAnimeNextPageSelector() { return 'a.next'; }
  popularAnimeFromElement(element) {
    const anime = SAnime.create();
    anime.setUrlWithoutDomain(__k.nn(element.selectFirst('a'), 'a').attr('href'));
    anime.title = __k.nn(element.selectFirst('h3'), 'h3').text();
    return anime;
  }

  // The idiom this exists for: take the base result, then adjust it.
  popularAnimeParse(response) {
    const page = __super.popularAnimeParse(response);
    return { animes: __k.filter(page.animes, (a) => a.title !== 'Two'), hasNextPage: false };
  }
}
`;

	it('lets an extension call through to the base implementation and adjust it', async () => {
		const module = await load(WRAPPING);
		const { ctx } = context();

		const page = await module.browse('popular', 1, ctx);

		// The base parser found two; the override dropped one and overrode the
		// paging flag. Both halves of that have to survive.
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0].title).toBe('One & Only');
		expect(page.hasMore).toBe(false);
	});

	it('reads the same markup whether the base parser is reached directly or through super', async () => {
		const direct = await load();
		const wrapped = await load(WRAPPING);

		const first = await direct.browse('popular', 1, context().ctx);
		const second = await wrapped.browse('popular', 1, context().ctx);

		// One code path, two entry points. An extension that wraps the base
		// parser and one that never mentions it must not get two different
		// readings of the same page. Compared on what both classes populate —
		// the wrapping one declares no thumbnail, which is a difference between
		// the two extensions rather than between the two paths.
		expect(second.entries[0].title).toBe(first.entries[0].title);
		expect(second.entries[0].sourceMediaId).toBe(first.entries[0].sourceMediaId);
	});

	it('refuses a super call the base class genuinely does not implement', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return 'li.card'; }
  popularAnimeFromElement(e) { const a = SAnime.create(); a.url = '/x'; a.title = 'x'; return a; }
  animeDetailsParse(doc) { return __super.animeDetailsParse(doc); }
}
`);
		const { ctx } = context();
		// `animeDetailsParse` is abstract upstream. Saying so beats returning an
		// empty record that reads as "this show has no details".
		await expect(module.listEpisodes(`${BASE_URL}/anime/one`, ctx)).rejects.toThrow();
	});
});

describe('what the driver refuses, and how loudly', () => {
	it('names the missing member when nothing knows how to find a stream', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return 'li.card'; }
  popularAnimeFromElement(element) { const a = SAnime.create(); a.url = '/x'; a.title = 'x'; return a; }
}
`);
		const { ctx } = context();

		// A refusal naming the step beats a black screen — this is the failure
		// the five-step install check is built to surface.
		await expect(
			module.resolve(`${BASE_URL}/a`, { sourceEpisodeId: `${BASE_URL}/a/1` }, ctx)
		).rejects.toThrow(/getVideoList|videoListParse/);
	});

	it('says so when an extension declares no way to read a listing', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
}
`);
		const { ctx } = context();
		await expect(module.browse('popular', 1, ctx)).rejects.toThrow(/no popularAnimeSelector/);
	});

	it('does not report a selector that threw as a selector that is absent', async () => {
		// The shape of a themed extension whose template was not part of the
		// conversion: it *does* declare the selector, and the member it
		// delegates to is in the other file. Reporting "declares none" sends
		// whoever reads the failure to the wrong file — and four of the eight
		// catalogue extensions that load and cannot answer are exactly this,
		// so it is the difference between a work queue and a wild goose chase.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return this.latestUpdatesSelector(); }
}
`);
		const { ctx } = context();
		await expect(module.browse('popular', 1, ctx)).rejects.toThrow(
			/declares popularAnimeSelector, but calling it failed/
		);
	});

	it('says which half is missing when an episode list cannot be read', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  episodeListSelector() { return this.fromTheTemplate(); }
}
`);
		const { ctx } = context();
		await expect(module.listEpisodes(`${BASE_URL}/anime/one`, ctx)).rejects.toThrow(
			/declares episodeListSelector, but calling it failed/
		);
	});
});

describe('hosters, which is where the base class went', () => {
	// The published API moved: an episode yields hosters, and a hoster yields
	// videos. `videoListParse(response)` is the path it kept for the extensions
	// that predate the change. Until the driver implemented the first of those,
	// an extension written against the current API could not convert at all — it
	// declares nothing the legacy path knows how to call.

	it('opens each hoster an episode offers and returns every stream behind them', async () => {
		const module = await load(hosterExtension());
		const { ctx, requested } = context();

		const sources = await module.resolve(`${BASE_URL}/anime/hosted`, HOSTED, ctx);

		expect(sources.map((source) => source.url)).toEqual([
			'https://cdn.example.invalid/a/1080.mp4',
			'https://cdn.example.invalid/b/720.mp4'
		]);
		// Three requests, in order: the episode page, then one per hoster.
		expect(requested).toEqual([
			`${BASE_URL}/anime/hosted/1`,
			`${BASE_URL}/host/a`,
			`${BASE_URL}/host/b`
		]);
	});

	it('names the hoster beside the quality, because both are what is being chosen between', async () => {
		const module = await load(hosterExtension());
		const sources = await module.resolve(`${BASE_URL}/anime/hosted`, HOSTED, context().ctx);

		expect(sources[0].label).toBe('Alpha · 1080p');
		expect(sources[0].quality).toBe('1080p');
	});

	it('does not fetch a hoster that already carried its videos', async () => {
		// `videoList` is null when the hoster has not been opened and a list when
		// the extension already had the streams in hand. Null is what makes the
		// driver fetch, and re-fetching a populated one is a request the source
		// never asked for.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  getHosterList(episode) {
    return [Hoster('', Hoster.NO_HOSTER_LIST, [
      Video('https://cdn.example.invalid/x/a.mp4', '480p', 'https://cdn.example.invalid/x/a.mp4', {})
    ])];
  }
}
`);
		const { ctx, requested } = context();

		const sources = await module.resolve(`${BASE_URL}/anime/hosted`, HOSTED, ctx);

		expect(requested).toEqual([]);
		expect(sources).toHaveLength(1);
		// The sentinel a source with no hoster concept wraps its videos under is
		// not a host, and must not reach a viewer as one.
		expect(sources[0].label).toBe('480p');
	});

	it('falls back to the legacy path when the hoster list came back empty', async () => {
		// A source can keep both surfaces. Upstream would have reached the legacy
		// parser, so refusing here would report an episode with no streams when
		// one of its two paths was never tried.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  hosterListRequest(episode) { return GET(this.baseUrl + episode.url, {}); }
  hosterListParse(response) { return []; }
  videoListParse(response) {
    return __k.mapNotNull(response.asJsoup().select('source'), (s) => {
      const src = s.attr('src');
      return src === '' ? null : Video(src, s.attr('label'), src, {});
    });
  }
}
`);
		const { ctx } = context();

		const sources = await module.resolve(
			`${BASE_URL}/anime/one`,
			{ sourceEpisodeId: `${BASE_URL}/anime/one/1` },
			ctx
		);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/a/index.m3u8');
	});

	it('names both paths when the extension implements neither', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
}
`);
		const { ctx } = context();
		await expect(module.resolve(`${BASE_URL}/anime/one`, HOSTED, ctx)).rejects.toThrow(
			/getHosterList[\s\S]*getVideoList/
		);
	});
});

describe('headers, which the base class owns and the extension reads bare', () => {
	// Nothing defined `headers` on the source, so `Video(url, q, url, headers)`
	// carried `undefined` and every request the extension built by hand went out
	// bare. A CDN behind a hotlink guard answers that with 403, which reads as a
	// dead source and is not one — the same URL with the `Referer` the extension
	// had already built in `headersBuilder()` answers 206.

	const READS_HEADERS = `
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  headersBuilder() { return __k.add(__super.headersBuilder(), 'Referer', this.baseUrl); }
  getHosterList(episode) { return [Hoster('${BASE_URL}/host/a', 'Alpha')]; }
  async getVideoList(hoster) {
    const doc = (await client.newCall(GET(hoster.hosterUrl, this.headers)).execute()).asJsoup();
    return __k.map(doc.select('source'), (s) =>
      Video(s.attr('src'), s.attr('label'), s.attr('src'), this.headers));
  }
}
`;

	it('builds it from the extension’s own headersBuilder, and puts it on the stream', async () => {
		const module = await load(READS_HEADERS);
		const sources = await module.resolve('x', HOSTED, context().ctx);

		expect(sources[0].headers).toEqual({ Referer: BASE_URL });
	});

	it('supplies one to an extension that only calls it', async () => {
		// `headersBuilder()` is an *open method on the base class*, so an
		// extension wanting one extra header writes
		// `headersBuilder().add(…).build()` and declares nothing. That emits as
		// `this.headersBuilder()` — the member table says the base class has it —
		// and the driver defined `headers` without defining the method it is
		// built from, so the first search died with
		// `this.headersBuilder is not a function`.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  getHosterList(episode) { return [Hoster('${BASE_URL}/host/a', 'Alpha')]; }
  async getVideoList(hoster) {
    const built = __k.add(this.headersBuilder(), 'X-Requested-With', 'XMLHttpRequest').build();
    const doc = (await client.newCall(GET(hoster.hosterUrl, built)).execute()).asJsoup();
    return __k.map(doc.select('source'), (s) =>
      Video(s.attr('src'), s.attr('label'), s.attr('src'), built));
  }
}
`);
		const sources = await module.resolve('x', HOSTED, context().ctx);

		expect(sources[0].headers).toEqual({
			'X-Requested-With': 'XMLHttpRequest'
		});
	});

	it('reads it once, because Kotlin declares it `by lazy`', async () => {
		// The count rides in the header itself, because the module is imported
		// as a real ES module and there is nothing to inject a spy through. The
		// class below reads `this.headers` three times in one resolve — once for
		// the request and once per video — so a getter that rebuilt every time
		// would answer `/2` and `/3`.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; this.built = 0; }
  headersBuilder() {
    this.built = this.built + 1;
    return __k.add(__super.headersBuilder(), 'Referer', this.baseUrl + '/' + this.built);
  }
  getHosterList(episode) { return [Hoster('${BASE_URL}/host/a', 'Alpha')]; }
  async getVideoList(hoster) {
    const doc = (await client.newCall(GET(hoster.hosterUrl, this.headers)).execute()).asJsoup();
    return __k.map(doc.select('source'), (s) =>
      Video(s.attr('src'), s.attr('label'), s.attr('src'), this.headers));
  }
}
`);
		const sources = await module.resolve('x', HOSTED, context().ctx);

		expect(sources[0].headers).toEqual({ Referer: `${BASE_URL}/1` });
	});
});

describe('sortVideos, which is where a quality preference is applied', () => {
	// Extensions override this constantly. A driver without it hands back
	// streams in whatever order the page listed them, so a viewer gets the
	// lowest quality on a connection that would have carried the highest, and
	// nothing anywhere says why.

	const TWO_QUALITIES = `
  getHosterList(episode) { return [Hoster('${BASE_URL}/host/a', 'Alpha')]; }
  async getVideoList(hoster) {
    return [
      Video('https://cdn.example.invalid/a/480.mp4', '480p', 'https://cdn.example.invalid/a/480.mp4', {}),
      Video('https://cdn.example.invalid/a/1080.mp4', '1080p', 'https://cdn.example.invalid/a/1080.mp4', {})
    ];
  }
`;

	async function ordering(extra: string): Promise<(string | undefined)[]> {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
${TWO_QUALITIES}${extra}
}
`);
		const sources = await module.resolve('x', HOSTED, context().ctx);
		return sources.map((source) => source.quality as string | undefined);
	}

	it('keeps source order when the extension states no preference', async () => {
		// The base class's own default, which is the identity.
		expect(await ordering('')).toEqual(['480p', '1080p']);
	});

	it('applies the extension’s own ordering rather than the page’s', async () => {
		expect(await ordering('  sortVideos(__recv) { return __k.reversed(__recv); }')).toEqual([
			'1080p',
			'480p'
		]);
	});

	it('honours the deprecated spelling when that is the one the extension overrode', async () => {
		// Upstream's `sortVideos()` default is not the identity — it delegates to
		// the deprecated `sort()`, which is itself overridable. An extension that
		// only overrode `sort` is relying on exactly that, and a driver that
		// stopped at `sortVideos` would silently drop its ordering.
		expect(await ordering('  sort(__recv) { return __k.reversed(__recv); }')).toEqual([
			'1080p',
			'480p'
		]);
	});

	it('gives super.sortVideos the list it was called on', async () => {
		// These are extension functions on the list upstream, so the receiver is
		// implicit in Kotlin and explicit here. A base default called on nothing
		// would hand the extension back `undefined` and lose the list.
		expect(
			await ordering('  sortVideos(__recv) { return __k.reversed(__super.sortVideos(__recv)); }')
		).toEqual(['1080p', '480p']);
	});
});

describe('createHttpServer, which this build refuses by name', () => {
	// ADR-0002 §2.1's local-web-server observation, promoted into the upstream
	// API: the extension starts a web server on the device and points the player
	// at it. This build structurally cannot supply one — a plugin gets no
	// ambient capability (rule 13), and StreamPipeline is the answer here.

	const SERVING = `
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  createHttpServer() { return null; }
  async getVideoList(episode) {
    return [Video('https://cdn.example.invalid/a/1080.mp4', '1080p', 'https://cdn.example.invalid/a/1080.mp4', {})];
  }
}
`;

	it('refuses at resolve, naming the member, rather than ignoring the override', async () => {
		const module = await load(SERVING);
		const { ctx, requested } = context();

		await expect(module.resolve('x', HOSTED, ctx)).rejects.toThrow(/createHttpServer/);
		// The answer does not depend on a request, so none is made — and the
		// stream the extension would have handed back is never even built.
		expect(requested).toEqual([]);
	});

	it('refuses as an UnsupportedError, which is the taxonomy for this', async () => {
		// `ABI.md` §5: `UnsupportedError` means this surface cannot do what the
		// source needs. The name is the only thing that crosses the worker
		// boundary beside the message, and it is what decides whether the viewer
		// is told to retry — which here they must not be.
		const module = await load(SERVING);
		const failure = await module.resolve('x', HOSTED, context().ctx).catch((error) => error);

		expect((failure as Error).name).toBe('UnsupportedError');
	});

	it('leaves everything that is not playback working', async () => {
		// The refusal belongs at `resolve` and nowhere earlier: the browse list
		// then marks the listing Broken with a reason, rather than Not testable.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  createHttpServer() { return null; }
  popularAnimeRequest(page) { return GET(this.baseUrl + '/popular?page=' + page, {}); }
  popularAnimeSelector() { return 'li.card'; }
  popularAnimeFromElement(element) {
    const anime = SAnime.create();
    anime.setUrlWithoutDomain(__k.nn(element.selectFirst('a'), 'a').attr('href'));
    anime.title = __k.nn(element.selectFirst('h3'), 'h3').text();
    return anime;
  }
}
`);

		expect((await module.browse('popular', 1, context().ctx)).entries).toHaveLength(2);
	});
});

describe('the base class an extension reaches through super', () => {
	it('declares every member the translator is willing to emit a super call to', async () => {
		// One contract in two files: `SUPER_MEMBERS` decides what compiles to
		// `__super.x(…)` and the driver decides what `__super` holds. A name added
		// to one and forgotten in the other is `__super.x is not a function`
		// inside a sandbox, on a viewer's device — so the check runs inside a real
		// bundle rather than over the driver's source text.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularAnimeRequest(page) {
    const names = ${JSON.stringify([...SUPER_MEMBERS])};
    const missing = names.filter((name) => typeof __super[name] !== 'function');
    throw new Error('absent from the driver: [' + missing.join(', ') + ']');
  }
}
`);

		await expect(module.browse('popular', 1, context().ctx)).rejects.toThrow(
			'absent from the driver: []'
		);
	});

	it('awaits a super call that fetches, so its result is a list and not a promise', async () => {
		// Kotlin's `suspend` is invisible at the call site. In JavaScript the same
		// text is a promise, and a promise that is filtered rather than awaited
		// does not fail — it walks nothing and answers an empty list, which is a
		// source that silently plays nothing.
		const module = await load(
			hosterExtension(`
  async getHosterList(episode) {
    const all = await __super.getHosterList(episode);
    return __k.filter(all, (hoster) => hoster.hosterName !== 'Beta');
  }
`)
		);

		const sources = await module.resolve(`${BASE_URL}/anime/hosted`, HOSTED, context().ctx);

		expect(sources).toHaveLength(1);
		expect(sources[0].label).toBe('Alpha · 1080p');
	});
});
