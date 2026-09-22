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
	resources: Record<string, string> = {}
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
			resources
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
	browse(shelf: string, page: number, ctx: unknown): Promise<Page>;
	searchCatalog(query: string, page: number, ctx: unknown): Promise<Page>;
}

async function load(translated: string, resources: Record<string, string> = {}): Promise<Loaded> {
	const bundle = await openPluginArchive(await convert(translated, resources));
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
