/**
 * The image medium's base class, and the one contract it shares with the
 * translator.
 *
 * `SUPER_MEMBERS_IMAGE` decides what a written `super.x(…)` is allowed to
 * compile to; `shims/mihon-entry.ts` decides what `__super` actually holds. A
 * name in one and not the other is `__super.x is not a function` inside a
 * sandbox on a viewer's device, which is why this check runs inside a real
 * bundle rather than over the driver's source text — the video side has made
 * the same argument since it was written, and this is its other half.
 *
 * It exists because the halves were not merely out of step, one of them did
 * not exist: every name in `SUPER_MEMBERS` was an anime one, so a manga
 * extension calling `super.imageRequest(page)` was refused by name while the
 * driver had implemented that member all along. Measured over 300 listings of
 * a real catalogue, that single refusal was the *sole* remaining blocker on 32
 * of them — against 14 that converted at all.
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { SUPER_MEMBERS_IMAGE } from '@plugin-bridge/core/kotlin/subset';
import { mihonEntrypoint } from '@plugin-bridge/runtime/shims/mihon-entry';
import { formatProfile } from '@plugin-bridge/core/formats';
import { namesCookieJar, packageBundle } from '@plugin-bridge/core/package';

const PLUGIN_ID = 'app.yorozo.converted.mihon.example';
const BASE_URL = 'https://read.example.invalid';

async function convert(
	translated: string,
	resources: Record<string, string> = {},
	keiSource = false
): Promise<Uint8Array> {
	return await packageBundle({
		id: PLUGIN_ID,
		name: 'Example',
		description: 'Converted Mihon extension.',
		version: '1.4.1',
		author: 'owner',
		hosts: ['read.example.invalid', 'cdn.example.invalid'],
		origin: {
			format: 'mihon',
			artifactUrl: 'https://raw.githubusercontent.com/owner/repo/main/apk/example.apk',
			foreignId: 'example',
			foreignVersion: '1.4.1',
			mediaKind: 'manga',
			isNsfw: false
		},
		entrypointSource: mihonEntrypoint({
			pluginId: PLUGIN_ID,
			translatedSource: translated,
			className: 'Extension',
			baseUrl: BASE_URL,
			lang: 'en',
			name: 'Example',
			resources,
			keiSource
		}),
		usesCookies: formatProfile('mihon').implicitCookies || namesCookieJar(translated),
		license: 'Apache-2.0',
		repository: 'https://github.com/owner/repo'
	});
}

interface Page {
	entries: { title: string }[];
	hasMore?: boolean;
}

interface Loaded {
	id: string;
	listChapters(id: string, ctx: unknown): Promise<{ sourceChapterId: string; title?: string }[]>;
	readChapter(
		id: string,
		chapter: { number: number; sourceChapterId?: string },
		ctx: unknown
	): Promise<{ pages: { index: number; url: string }[] }>;
	browse(shelf: string, page: number, ctx: unknown): Promise<Page>;
	searchCatalog(query: string, page: number, ctx: unknown): Promise<Page>;
}

async function load(
	translated: string,
	resources: Record<string, string> = {},
	keiSource = false
): Promise<Loaded> {
	const bundle = await openPluginArchive(await convert(translated, resources, keiSource));
	// A file rather than a `data:` URL: this bundle carries a whole runtime and
	// is far past the length a data URL can be imported at.
	const { writeFileSync, mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const file = join(mkdtempSync(join(tmpdir(), 'yorozo-')), 'bundle.mjs');
	writeFileSync(file, bundle.entrypointSource, 'utf8');
	return (await import(/* @vite-ignore */ `file:///${file.replace(/\\/g, '/')}`)).default as Loaded;
}

/** A context stub: this suite never lets a request leave, because the member
 * under test throws before returning. */
function context(): unknown {
	return {
		http: {
			request: async () => ({ status: 200, headers: {}, body: new Uint8Array(), url: BASE_URL })
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
}

describe('the base class a manga extension reaches through super', () => {
	it('declares every member the translator is willing to emit a super call to', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularMangaRequest(page) {
    const names = ${JSON.stringify([...SUPER_MEMBERS_IMAGE])};
    const missing = names.filter((name) => typeof __super[name] !== 'function');
    throw new Error('absent from the driver: [' + missing.join(', ') + ']');
  }
}
`);

		await expect(module.browse('popular', 1, context())).rejects.toThrow(
			'absent from the driver: []'
		);
	});

	it('runs the extension’s own fetchX rather than the base request it never wrote', async () => {
		// Most of this catalogue overrides the request/parse pair, which is what
		// the driver was built for. A large minority overrides the older
		// Observable API instead — 271 members named `fetchSearchManga` in one
		// catalogue — and for those the pair is *not* what the author wrote.
		// Running it anyway sends the base class's request to a site whose
		// extension implements something else, which is a wrong page rather than
		// a missing one, and nothing reports it.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  fetchSearchManga(page, query, filters) {
    return Observable.just({
      mangas: [{ url: '/manga/from-fetch', title: 'From fetchSearchManga' }],
      hasNextPage: false
    });
  }
}
`);

		const page = await module.searchCatalog('anything', 1, context());
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0].title).toBe('From fetchSearchManga');
	});

	it('supplies the generated name, lang and baseUrl before the constructor runs', async () => {
		// The generated subclass is the most-derived class, so what it supplies
		// is there while the classes above it initialise. A single-series
		// template builds its catalogue from both in a property initialiser;
		// attached after construction, every entry read \`undefined/manga/…\`.
		const module = await load(`
class Template {
  constructor() { this.sourceList = [[this.name, this.baseUrl + '/manga/one/', this.lang]]; }
  fetchPopularManga(page) {
    return Observable.just(MangasPage(this.sourceList.map((it) => ({ title: it[0] + ' ' + it[2], url: it[1] })), false));
  }
}
class Extension extends Template {}
`);

		const page = await module.browse('popular', 1, context());
		expect(page.entries.map((entry) => entry.title)).toEqual(['Example en']);
		expect((page.entries[0] as { sourceMediaId?: string }).sourceMediaId).toBe(
			`${BASE_URL}/manga/one/`
		);
	});

	it('has the base class’s client, network and headers while the constructor runs', async () => {
		// `override val client = network.client.newBuilder()…` and `private val
		// apiHeaders = headers.newBuilder()…` are property initialisers. With
		// these attached after `new`, the first died at load on
		// `this.network.client` and the second built from nothing.
		const module = await load(
			`
class Extension {
  constructor() {
    this.ownClient = this.network.client.newBuilder().build();
    this.apiHeaders = this.headers.newBuilder().set('X-Api', '1').build();
  }
  fetchPopularManga(page) {
    const referer = this.apiHeaders.get('Referer');
    return Observable.just(MangasPage([{ title: referer + ' ' + this.apiHeaders.get('X-Api'), url: '/x' }], false));
  }
}
`,
			{},
			true
		);

		const page = await module.browse('popular', 1, context());
		expect(page.entries[0].title).toBe(`${BASE_URL}/ 1`);
	});

	it('answers the base class’s empty getFilterList when the extension calls it undeclared', async () => {
		// `getSearchMangaList(page, "", getFilterList(null))` in an extension
		// that declares no filters: KeiSource's answers an empty FilterList.
		const module = await load(
			`
class Extension {
  async getPopularManga(page) {
    const filters = this.getFilterList(null);
    return MangasPage([{ title: 'filters: ' + filters.length, url: '/x' }], false);
  }
}
`,
			{},
			true
		);

		const page = await module.browse('popular', 1, context());
		expect(page.entries[0].title).toBe('filters: 0');
	});

	it('leaves a base URL the extension declares itself to win over the generated one', async () => {
		// A constructor parameter or field lands on the instance and shadows the
		// prototype; a getter is found in the chain and nothing is put beside it.
		const module = await load(`
class Extension {
  get baseUrl() { return 'https://mirror.example.invalid'; }
  constructor() { this.name = 'Own name'; }
  fetchPopularManga(page) {
    return Observable.just(MangasPage([{ title: this.name, url: this.baseUrl + '/x' }], false));
  }
}
`);

		const page = await module.browse('popular', 1, context());
		expect(page.entries[0].title).toBe('Own name');
		expect((page.entries[0] as { sourceMediaId?: string }).sourceMediaId).toBe(
			'https://mirror.example.invalid/x'
		);
	});

	it('awaits a fetchX that suspends, rather than handing back the Observable', async () => {
		// `__observable` is thenable so `await` unwraps it, and the deferring
		// constructors matter: `fromCallable` must not run until it is asked.
		// Unawaited, `__normalisePage` would read `mangas` off the wrapper and
		// answer an empty page — a source that silently finds nothing.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  fetchPopularManga(page) {
    return Observable.fromCallable(async function () {
      return { mangas: [{ url: '/manga/deferred', title: 'Deferred' }], hasNextPage: true };
    });
  }
}
`);

		const page = await module.browse('popular', 1, context());
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0].title).toBe('Deferred');
		expect(page.hasMore).toBe(true);
	});

	it('awaits a parse member that suspends, rather than normalising its Promise', async () => {
		// The request/parse pair had the bug the test above guards on the
		// fetchX path. A parse that makes a request of its own — one measured source reads
		// the JSON file its search page names — is emitted `async`, and its
		// Promise has no `mangas`: every result was dropped, nothing reported.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  popularMangaRequest(page) { return GET(this.baseUrl + '/popular'); }
  async popularMangaParse(response) {
    await Promise.resolve();
    return MangasPage([{ url: '/manga/second-request', title: 'After a second request' }], true);
  }
}
`);

		const sending = {
			...(context() as object),
			http: {
				policy: async () => undefined,
				send: async (url: string) => ({
					status: 200,
					url,
					headers: {},
					text: async () => '',
					json: async () => ({})
				})
			}
		};
		const page = await module.browse('popular', 1, sending);
		expect(page.entries.map((entry) => entry.title)).toEqual(['After a second request']);
		expect(page.hasMore).toBe(true);
	});

	it('runs the extension’s own suspend getX, which is the API upstream has now', async () => {
		// The generation after `fetchX`, and by a distance the commonest: 332 of
		// this repository's ~800 Kotlin sources declare `getPopularManga`, 331
		// `getLatestUpdates`, 330 `getPageList`. An extension that overrides one
		// of these usually declares no request/parse pair at all — Madara, the
		// largest template in the catalogue, is exactly that — so running the
		// pair sent the *base class's* request to a source whose author wrote
		// something else. A wrong page rather than a missing one, and nothing
		// reported it.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  async getPopularManga(page) {
    return { mangas: [{ url: '/manga/coroutine', title: 'From getPopularManga' }], hasNextPage: false };
  }
}
`);

		const page = await module.browse('popular', 1, context());
		expect(page.entries).toHaveLength(1);
		expect(page.entries[0].title).toBe('From getPopularManga');
	});

	it('prefers the coroutine override to the Rx one when an extension wrote both', async () => {
		// Upstream's own base delegates `fetchX` to `getX`, so where both are
		// present the coroutine one is the implementation and the other is the
		// wrapper. Reading them the other way round would run a deprecated path
		// its author had already stopped maintaining.
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  async getSearchMangaList(page, query, filters) {
    return { mangas: [{ url: '/a', title: 'coroutine' }], hasNextPage: false };
  }
  fetchSearchManga(page, query, filters) {
    return Observable.just({ mangas: [{ url: '/b', title: 'rx' }], hasNextPage: false });
  }
}
`);

		const page = await module.searchCatalog('anything', 1, context());
		expect(page.entries[0].title).toBe('coroutine');
	});

	it('names no member the video driver happens to share, by accident', () => {
		// The three genuinely common to both media mean the same thing in each,
		// and are the only overlap there should be. A fourth appearing here is
		// worth looking at rather than waving through: it is more likely a name
		// copied across than a member two different base classes both grew.
		const video = new Set([
			'popularAnimeParse',
			'searchAnimeParse',
			'latestUpdatesParse',
			'episodeListParse',
			'animeDetailsParse',
			'headersBuilder',
			'latestUpdatesRequest'
		]);
		const shared = [...SUPER_MEMBERS_IMAGE].filter((name) => video.has(name));
		expect(shared.sort()).toEqual(['headersBuilder', 'latestUpdatesParse', 'latestUpdatesRequest']);
	});
});

/**
 * The classpath, end to end, because the two halves are in different packages.
 *
 * `source-repo.ts` fetches `assets/i18n/*.properties`, the adapter hands them
 * to `mihonEntrypoint`, the entry point declares `__RESOURCES`, and the
 * runtime's `__k.classLoader()` reads it. Each half has a unit test and none of
 * them crosses a package boundary, so what this asserts is the join: an option
 * that stops being passed anywhere along that chain fails here and nowhere
 * else, which was checked by removing it.
 *
 * Both fixtures read the classpath in a class PROPERTY rather than in a method,
 * because that is where the template that matters reads it — `MadaraBase`
 * builds its filter options from `intl[…]` at construction, so anything that
 * throws there costs the whole extension rather than one label.
 */
describe('the files a converted extension reads beside its own source', () => {
	it('reads a message file the conversion fetched, at construction time', async () => {
		const module = await load(
			`
class Extension {
  constructor() {
    this.baseUrl = '${BASE_URL}';
    // A class property, which is where the template that matters reads it.
    this.label = __k.jsonGetString(
      new PropertyResourceBundle(
        new InputStreamReader(
          __k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties'),
          'UTF-8'
        )
      ),
      'author_filter_title'
    );
  }
  async getPopularManga(page) {
    return { mangas: [{ url: '/a', title: this.label }], hasNextPage: false };
  }
}
`,
			{ 'assets/i18n/messages_en.properties': 'author_filter_title=Author\n' }
		);

		const page = await module.browse('popular', 1, context());
		expect(page.entries[0].title).toBe('Author');
	});

	it('still loads when the repository had no message files at all', async () => {
		// Most of this catalogue has none, and the video half declares no
		// `__RESOURCES` whatsoever. An empty bundle degrades to upstream's own
		// `[key]`; a throw here would be a dead extension for a missing
		// translation, at construction, taking every entry point with it.
		const module = await load(`
class Extension {
  constructor() {
    this.baseUrl = '${BASE_URL}';
    this.bundle = new PropertyResourceBundle(
      new InputStreamReader(
        __k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties'),
        'UTF-8'
      )
    );
  }
  async getPopularManga(page) {
    const key = 'author_filter_title';
    const label = __k.containsKey(this.bundle, key) ? __k.jsonGetString(this.bundle, key) : '[' + key + ']';
    return { mangas: [{ url: '/a', title: label }], hasNextPage: false };
  }
}
`);

		const page = await module.browse('popular', 1, context());
		expect(page.entries[0].title).toBe('[author_filter_title]');
	});
});

/**
 * What the base class owns and the extension reaches through bare.
 *
 * `client`, `headers` and the rest were never on the instance, so every
 * request a translated member made itself — `client.newCall(…)`, and the
 * whole of the current API's `client.get(url)` — died on the first search of a
 * bundle that had imported cleanly and been counted as working.
 */
describe('the members a manga extension inherits', () => {
	/** A context that records what was sent and what policy was declared. */
	function recording() {
		const sent: { url: string; headers: Record<string, string> }[] = [];
		const policies: unknown[] = [];
		const ctx = {
			...(context() as Record<string, unknown>),
			http: {
				policy: async (declared: unknown) => {
					policies.push(declared);
				},
				send: async (url: string, request: { headers: Record<string, string> }) => {
					sent.push({ url, headers: request.headers });
					return {
						status: 200,
						url,
						headers: {},
						text: async () => '<html><body><a class="ch" href="/c/1">One</a></body></html>',
						json: async () => ({})
					};
				}
			}
		};
		return { ctx, sent, policies };
	}

	it('gives the extension a client and headers to send with', async () => {
		const module = await load(`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  async getPopularManga(page) {
    const response = await this.client.newCall(GET(this.baseUrl + '/p', this.headers)).execute();
    return { mangas: [{ url: '/m', title: String(response.code) }], hasNextPage: false };
  }
}
`);
		const { ctx, sent } = recording();
		const page = await module.browse('popular', 1, ctx);
		expect(page.entries[0].title).toBe('200');
		expect(sent[0].url).toBe(`${BASE_URL}/p`);
	});

	it('builds KeiSource headers with Referer and Origin, then the extension hook', async () => {
		const module = await load(
			`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  configureHeaders(builder) { return builder.add('X-Extra', 'yes'); }
  async getPopularManga(page) {
    await __k.okhttp(this.client, 'get', [this.baseUrl + '/p'], {});
    return { mangas: [], hasNextPage: false };
  }
}
`,
			{},
			true
		);
		const { ctx, sent } = recording();
		await module.browse('popular', 1, ctx);
		expect(sent[0].headers).toMatchObject({
			Referer: `${BASE_URL}/`,
			Origin: BASE_URL,
			'X-Extra': 'yes'
		});
	});

	it('runs configureClient, which is where a KeiSource declares its rate limit', async () => {
		const module = await load(
			`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  configureClient(builder) { return __k.rateLimit(builder, 2, 1000); }
  async getPopularManga(page) {
    await __k.okhttp(this.client, 'get', [this.baseUrl + '/p'], {});
    return { mangas: [], hasNextPage: false };
  }
}
`,
			{},
			true
		);
		const { ctx, policies } = recording();
		await module.browse('popular', 1, ctx);
		expect(policies).toContainEqual(
			expect.objectContaining({ rateLimit: { permits: 2, periodMs: 1000 } })
		);
	});

	it('sends the cookies a configureClient `addCookie { … }` block answers', async () => {
		// The block form, exactly as the emitter writes
		// `configureClient() = addCookie { listOf("age" to "18") }` — a function
		// asked per request, on the builder that is the implicit receiver.
		const module = await load(
			`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  configureClient(__recv) {
    return __recv.addCookie((it) => { return __k.listOf(__k.to('confirm_age', '1')); });
  }
  async getPopularManga(page) {
    await __k.okhttp(this.client, 'get', [this.baseUrl + '/p'], {});
    return { mangas: [], hasNextPage: false };
  }
}
`,
			{},
			true
		);
		const { ctx, sent } = recording();
		await module.browse('popular', 1, ctx);
		expect(sent[0].headers.Cookie).toBe('confirm_age=1');
	});

	it('lists chapters through fetchMangaUpdate, asking for chapters only', async () => {
		// The current API's one member for both, which the host calls through
		// the base class's final getMangaUpdate. An extension that implements
		// it declares no chapter member of any older generation.
		const module = await load(
			`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; this.asked = null; }
  async fetchMangaUpdate(manga, chapters, fetchDetails, fetchChapters) {
    const chapter = SChapter.create();
    chapter.url = manga.url + '/1';
    chapter.name = 'details=' + fetchDetails + ' chapters=' + fetchChapters;
    return SMangaUpdate(manga, [chapter]);
  }
}
`,
			{},
			true
		);
		const { ctx } = recording();
		const chapters = await module.listChapters('/m', ctx);
		expect(chapters).toHaveLength(1);
		expect(chapters[0].sourceChapterId).toBe('/m/1');
		expect(chapters[0].title).toBe('details=false chapters=true');
	});

	it('hands a chapter its memo back when it is opened', async () => {
		// Upstream persists a chapter's memo with the chapter. Madara keeps the
		// title's path there and builds the chapter url from it, so a memo lost
		// between listing and opening made every chapter it listed answer
		// "Refresh the chapter list." The id is the only thing that survives,
		// so the memo rides in it — and only when there is one.
		const module = await load(
			`
class Extension {
  constructor() { this.baseUrl = '${BASE_URL}'; }
  async fetchMangaUpdate(manga, chapters, fetchDetails, fetchChapters) {
    const kept = SChapter.create();
    kept.url = 'chapter-1#top';
    kept.chapter_number = 1;
    kept.memo = { mangaPath: '/manga/a b#c' };
    const plain = SChapter.create();
    plain.url = '/c/2';
    plain.chapter_number = 2;
    return SMangaUpdate(manga, [kept, plain]);
  }
  async getPageList(chapter) {
    const path = chapter.memo.mangaPath === undefined ? '' : chapter.memo.mangaPath;
    return [{ index: 0, url: '', imageUrl: 'https://cdn.example.invalid' + path + '|' + chapter.url }];
  }
}
`,
			{},
			true
		);
		const { ctx } = recording();
		const chapters = await module.listChapters('/m', ctx);
		// A chapter without a memo keeps its url as its id, exactly as before.
		expect(chapters[1].sourceChapterId).toBe('/c/2');
		const kept = await module.readChapter(
			'/m',
			{ number: 1, sourceChapterId: chapters[0].sourceChapterId },
			ctx
		);
		expect(kept.pages[0].url).toBe('https://cdn.example.invalid/manga/a b#c|chapter-1#top');
		const plain = await module.readChapter(
			'/m',
			{ number: 2, sourceChapterId: chapters[1].sourceChapterId },
			ctx
		);
		expect(plain.pages[0].url).toBe('https://cdn.example.invalid|/c/2');
		// An id this driver did not write is read as a url, whatever it holds.
		const foreign = await module.readChapter(
			'/m',
			{ number: 3, sourceChapterId: '/c/3#yorozo-memo=nope' },
			ctx
		);
		expect(foreign.pages[0].url).toBe('https://cdn.example.invalid|/c/3#yorozo-memo=nope');
	});
});
