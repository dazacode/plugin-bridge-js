/**
 * The template whose base class is mostly the part that could not come across.
 *
 * Every fixture here is hand-written and every host in one is
 * `example.invalid`, reserved by RFC 6761 and resolving nowhere. Nothing in
 * this file names a content source, and the first block checks that the module
 * under test has not grown one either (`AGENTS.md` rule 9).
 *
 * Two properties are worth the length. The first is the one the Kotlin makes
 * explicit and nothing else would: **search reuses the popular listing's
 * selectors**, so an extension that overrode only the popular one gets that
 * value on both paths. The second is that everything degrades to empty — a
 * page that does not match, a selector that will not compile, an attribute
 * that is neither a URL nor base64 — because `FOREIGN.md` §6 turns "found
 * nothing" into a refusal naming the step, and turns an exception into noise.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { base64Encode } from '../extract/patterns';
import { parseHtml } from '@plugin-bridge/runtime/shims/dom';

import type { ThemeContext } from './engine';
import { themeById } from './engine';
import { fetchUrls, languageTag, pelisPlusTheme } from './pelisplus';

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

const BASE = 'https://example.invalid/';

interface Recorded {
	readonly url: string;
	readonly method: string;
}

function contextFor(
	pages: Readonly<Record<string, string>>,
	overrides: Readonly<Record<string, string>> = {},
	log: Recorded[] = []
): ThemeContext {
	return {
		config: { baseUrl: BASE, lang: 'es', overrides },
		http: {
			async text(url, request) {
				log.push({ url, method: request?.method ?? 'GET' });
				const body = pages[url];
				if (body === undefined) throw new Error(`the test declared no page at ${url}`);
				return body;
			}
		},
		parse: (html, baseUrl) => parseHtml(html, baseUrl ?? '')
	};
}

const HOME_URL = 'https://example.invalid/';
const SEARCH_URL = 'https://example.invalid/search?s=hero';

/**
 * Two embed urls for the tests that go through `REGEX_LINK`.
 *
 * They are addresses rather than names because the pattern being exercised
 * refuses a top-level domain of more than six characters, and `.invalid` is
 * seven — see the test that pins exactly that. `192.0.2.0/24` is TEST-NET-1,
 * reserved by RFC 5737 for documentation and routed nowhere, so this stays
 * what every other fixture in the file is: an address belonging to no one.
 */
const EMBED_A = 'https://192.0.2.10/embed/a';
const EMBED_B = 'http://192.0.2.11/embed/b';

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const LISTING_PAGE = `<!doctype html>
<html><head><title>Listado</title></head><body>
	<div class="grid">
		<a href="/title/one" title="One Title"><img src="/poster/one.jpg" alt="One"></a>
		<a href="/title/two"><img src="/poster/two.jpg" alt="Two Title"></a>
		<a href="/title/three"><img data-src="/poster/three.jpg" alt=""><h3>Three Title</h3></a>
	</div>
	<div class="pagination"><a rel="next" href="/search?s=hero&amp;page=2">Siguiente</a></div>
</body></html>`;

const LAST_LISTING_PAGE = `<!doctype html>
<html><body>
	<div class="grid"><a href="/title/last"><img src="/poster/last.jpg" alt="Last Title"></a></div>
</body></html>`;

const SERIES_PAGE = `<!doctype html>
<html><body>
	<ul class="episodios">
		<li><a href="/title/one/episodio-1" title="Episodio 1">1</a></li>
		<li><a href="/title/one/episodio-2" title="Episodio 2">2</a></li>
		<li><a href="/title/one/episodio-2">duplicate</a></li>
	</ul>
</body></html>`;

const FILM_PAGE = `<!doctype html>
<html><body>
	<div class="player"><iframe src="/embed/film"></iframe></div>
</body></html>`;

const EMPTY_PAGE = `<!doctype html><html><head><title>Nada</title></head><body><p>Nada.</p></body></html>`;

/**
 * Markup as it arrives: unquoted values, an unclosed list item, a stray end
 * tag, an attribute with no value at all.
 */
const MALFORMED_PAGE = `<html><body><div class=grid>
	<a href=/title/loose title=Loose><img src=/poster/loose.jpg>
	</span></a>
	<p>trailing`;

function playerPage(encoded: string): string {
	return `<!doctype html>
<html><body>
	<ul class="servers">
		<li data-lang="lat" data-video="${encoded}" title="Opcion 1"></li>
		<li data-lang="2" data-url="/embed/subtitled/index.m3u8" title="Opcion 2"></li>
		<li data-video="not a url and not base64 either" title="Opcion 3"></li>
	</ul>
	<iframe src="https://frames.example.invalid/frame" data-lang="cast"></iframe>
</body></html>`;
}

/* -------------------------------------------------------------------------
 * Rule 9
 * ---------------------------------------------------------------------- */

describe('the module itself', () => {
	const source = readFileSync(fileURLToPath(new URL('./pelisplus.ts', import.meta.url)), 'utf8');

	it('names no site', () => {
		const hostShaped =
			/\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|tv|io|co|me|to|cc|ru|se|it|is|xyz|club|site|online|sx|nu|la|pw|biz|info|ws|st|live|fun)\b/i;
		expect(hostShaped.test(source)).toBe(false);
	});

	it('carries no url of its own, only a pattern that matches any of them', () => {
		// The one `://` in the file belongs to `REGEX_LINK`, which is escaped.
		expect(source.indexOf('://')).toBe(-1);
	});

	it('registers itself under its template directory name', () => {
		expect(themeById('pelisplus')).toBe(pelisPlusTheme);
		expect(pelisPlusTheme.id).toBe('pelisplus');
	});

	it('declares every key it reads', () => {
		for (const key of pelisPlusTheme.settings) {
			expect(source.indexOf(`'${key}'`)).toBeGreaterThan(-1);
		}
		expect([...pelisPlusTheme.settings].sort()).toEqual([
			'episodeListSelector',
			'pageQueryParam',
			'popularAnimeNextPageSelector',
			'popularAnimeSelector',
			'searchAnimeNextPageSelector',
			'searchAnimeSelector',
			'searchPath',
			'searchQueryParam',
			'videoListSelector'
		]);
	});
});

/* -------------------------------------------------------------------------
 * The two helpers the base class actually contributes
 * ---------------------------------------------------------------------- */

describe('fetchUrls', () => {
	it('rakes every url out of a script body, in order', () => {
		const script = `var a = "${EMBED_A}?y=1"; var b = '${EMBED_B}';`;
		expect(fetchUrls(script)).toEqual([`${EMBED_A}?y=1`, EMBED_B]);
	});

	/**
	 * A real limitation of the pattern, pinned rather than papered over.
	 *
	 * `REGEX_LINK` allows one to six characters after the final dot, which was
	 * true of every top-level domain when it was written and is not true now.
	 * It is ported as it stands — a template that quietly matched *more* than
	 * the extension it was generated from would be a different scraper — and
	 * this is the test that says so out loud.
	 */
	it('ignores a top-level domain longer than six characters', () => {
		expect(fetchUrls('see https://example.invalid/x for details')).toEqual([]);
	});

	it('answers nothing for nothing', () => {
		expect(fetchUrls('')).toEqual([]);
		expect(fetchUrls(null)).toEqual([]);
		expect(fetchUrls(undefined)).toEqual([]);
		expect(fetchUrls('no links in here at all')).toEqual([]);
	});
});

describe('languageTag', () => {
	it('reads the three markers the template knows', () => {
		expect(languageTag('lat')).toBe('[LAT]');
		expect(languageTag('0')).toBe('[LAT]');
		expect(languageTag('Castellano')).toBe('[CAST]');
		expect(languageTag('1')).toBe('[CAST]');
		expect(languageTag('sub')).toBe('[SUB]');
		expect(languageTag('2')).toBe('[SUB]');
	});

	it('says nothing about a value it does not recognise', () => {
		expect(languageTag('')).toBe('');
		expect(languageTag('desconocido')).toBe('');
	});
});

/* -------------------------------------------------------------------------
 * search
 * ---------------------------------------------------------------------- */

describe('search', () => {
	it('builds the search url from its three parameters', async () => {
		const log: Recorded[] = [];
		await pelisPlusTheme.search('hero', 1, contextFor({ [SEARCH_URL]: LISTING_PAGE }, {}, log));

		expect(log).toEqual([{ url: SEARCH_URL, method: 'GET' }]);
	});

	it('takes overridden url parameters', async () => {
		const url = 'https://example.invalid/buscar?q=hero&p=3';
		const log: Recorded[] = [];

		await pelisPlusTheme.search(
			'hero',
			3,
			contextFor(
				{ [url]: LISTING_PAGE },
				{ searchPath: '/buscar', searchQueryParam: 'q', pageQueryParam: 'p' },
				log
			)
		);

		expect(log[0].url).toBe(url);
	});

	it('reads the cards, in every shape a card takes', async () => {
		const page = await pelisPlusTheme.search('hero', 1, contextFor({ [SEARCH_URL]: LISTING_PAGE }));

		expect(page.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/title/one',
				title: 'One Title',
				posterImageUrl: 'https://example.invalid/poster/one.jpg'
			},
			{
				sourceMediaId: 'https://example.invalid/title/two',
				title: 'Two Title',
				posterImageUrl: 'https://example.invalid/poster/two.jpg'
			},
			{
				sourceMediaId: 'https://example.invalid/title/three',
				title: 'Three Title',
				posterImageUrl: 'https://example.invalid/poster/three.jpg'
			}
		]);
		expect(page.hasMore).toBe(true);
	});

	it('stops when there is no next link', async () => {
		const page = await pelisPlusTheme.search(
			'hero',
			1,
			contextFor({ [SEARCH_URL]: LAST_LISTING_PAGE })
		);
		expect(page.hasMore).toBe(false);
		expect(page.entries).toHaveLength(1);
	});

	it('browses the home page when there is no query, and pages it', async () => {
		const log: Recorded[] = [];
		const pages = {
			[HOME_URL]: LISTING_PAGE,
			'https://example.invalid/?page=2': LAST_LISTING_PAGE
		};

		await pelisPlusTheme.search('', 1, contextFor(pages, {}, log));
		await pelisPlusTheme.search('   ', 2, contextFor(pages, {}, log));

		expect(log.map((entry) => entry.url)).toEqual([HOME_URL, 'https://example.invalid/?page=2']);
	});

	it('finds nothing on a page that does not match, and does not throw', async () => {
		const page = await pelisPlusTheme.search('hero', 1, contextFor({ [SEARCH_URL]: EMPTY_PAGE }));
		expect(page).toEqual({ entries: [], hasMore: false });
	});

	it('reads broken markup rather than refusing it', async () => {
		const page = await pelisPlusTheme.search(
			'hero',
			1,
			contextFor({ [SEARCH_URL]: MALFORMED_PAGE })
		);

		expect(page.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/title/loose',
				title: 'Loose',
				posterImageUrl: 'https://example.invalid/poster/loose.jpg'
			}
		]);
	});

	it('survives a selector override that will not compile', async () => {
		const page = await pelisPlusTheme.search(
			'hero',
			1,
			contextFor({ [SEARCH_URL]: LISTING_PAGE }, { popularAnimeSelector: 'a:nonsense(' })
		);
		expect(page).toEqual({ entries: [], hasMore: false });
	});

	it('gives the search path the popular selector, which is what the Kotlin does', async () => {
		const markup = `<html><body><div id="rebuilt">
			<article><a href="/title/rebuilt">Rebuilt Title</a></article>
		</div></body></html>`;

		const page = await pelisPlusTheme.search(
			'hero',
			1,
			contextFor({ [SEARCH_URL]: markup }, { popularAnimeSelector: 'div#rebuilt article' })
		);

		expect(page.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/title/rebuilt',
				title: 'Rebuilt Title'
			}
		]);
	});

	it('lets a search-specific override win over the popular one', async () => {
		const markup = `<html><body>
			<div id="rebuilt"><article><a href="/title/popular">Popular</a></article></div>
			<div id="hits"><article><a href="/title/searched">Searched</a></article></div>
		</body></html>`;

		const page = await pelisPlusTheme.search(
			'hero',
			1,
			contextFor(
				{ [SEARCH_URL]: markup },
				{
					popularAnimeSelector: 'div#rebuilt article',
					searchAnimeSelector: 'div#hits article'
				}
			)
		);

		expect(page.entries.map((entry) => entry.title)).toEqual(['Searched']);
	});
});

/* -------------------------------------------------------------------------
 * episodes
 * ---------------------------------------------------------------------- */

describe('episodes', () => {
	const SERIES_URL = 'https://example.invalid/title/one';

	it('reads the episode rows, numbered and deduplicated', async () => {
		const episodes = await pelisPlusTheme.episodes(
			SERIES_URL,
			contextFor({ [SERIES_URL]: SERIES_PAGE })
		);

		expect(episodes).toEqual([
			{
				number: 1,
				sourceEpisodeId: 'https://example.invalid/title/one/episodio-1',
				title: 'Episodio 1'
			},
			{
				number: 2,
				sourceEpisodeId: 'https://example.invalid/title/one/episodio-2',
				title: 'Episodio 2'
			}
		]);
	});

	it('treats a page with a player and no rows as a single-episode title', async () => {
		const url = 'https://example.invalid/title/film';
		expect(await pelisPlusTheme.episodes(url, contextFor({ [url]: FILM_PAGE }))).toEqual([
			{ number: 1, sourceEpisodeId: url }
		]);
	});

	it('finds nothing on a page with neither rows nor a player', async () => {
		const url = 'https://example.invalid/title/gone';
		expect(await pelisPlusTheme.episodes(url, contextFor({ [url]: EMPTY_PAGE }))).toEqual([]);
	});

	it('takes an overridden episode list selector', async () => {
		const url = 'https://example.invalid/title/moved';
		const markup = `<html><body><table id="eps">
			<tr><td><a href="/title/moved/capitulo-4">Capitulo 4</a></td></tr>
		</table></body></html>`;

		expect(
			await pelisPlusTheme.episodes(
				url,
				contextFor({ [url]: markup }, { episodeListSelector: 'table#eps tr' })
			)
		).toEqual([
			{
				number: 4,
				sourceEpisodeId: 'https://example.invalid/title/moved/capitulo-4',
				title: 'Capitulo 4'
			}
		]);
	});

	it('refuses to fetch anything for an empty id', async () => {
		const log: Recorded[] = [];
		expect(await pelisPlusTheme.episodes('  ', contextFor({}, {}, log))).toEqual([]);
		expect(log).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------
 * streams
 * ---------------------------------------------------------------------- */

describe('streams', () => {
	const EPISODE_URL = 'https://example.invalid/title/one/episodio-1';

	it('returns every embed url, tagged with its audio track', async () => {
		const encoded = base64Encode(EMBED_A);
		const streams = await pelisPlusTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: playerPage(encoded) })
		);

		expect(streams).toEqual([
			{
				url: EMBED_A,
				container: 'mp4',
				label: '[LAT] Opcion 1',
				headers: { Referer: 'https://example.invalid/' }
			},
			{
				url: 'https://example.invalid/embed/subtitled/index.m3u8',
				container: 'hls',
				label: '[SUB] Opcion 2',
				headers: { Referer: 'https://example.invalid/' }
			},
			{
				url: 'https://frames.example.invalid/frame',
				container: 'mp4',
				label: '[CAST] Server 3',
				headers: { Referer: 'https://example.invalid/' }
			}
		]);
	});

	it('rakes a script body when the extension points the selector at one', async () => {
		const markup = `<html><body><div class="player"><script>
			var sources = ["${EMBED_A}", "${EMBED_B}"];
		</script></div></body></html>`;

		const streams = await pelisPlusTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: markup }, { videoListSelector: 'div.player script' })
		);

		expect(streams.map((stream) => stream.url)).toEqual([EMBED_A, EMBED_B]);
	});

	it('finds nothing rather than throwing on a page with no player', async () => {
		expect(
			await pelisPlusTheme.streams(EPISODE_URL, contextFor({ [EPISODE_URL]: EMPTY_PAGE }))
		).toEqual([]);
	});

	it('survives a video selector that will not compile', async () => {
		const encoded = base64Encode(EMBED_A);
		expect(
			await pelisPlusTheme.streams(
				EPISODE_URL,
				contextFor({ [EPISODE_URL]: playerPage(encoded) }, { videoListSelector: 'li:nonsense(' })
			)
		).toEqual([]);
	});
});
