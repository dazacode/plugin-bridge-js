/**
 * The template is only interesting where a page is not what it claims to be.
 *
 * Every fixture below is written by hand, and every host in every one of them
 * is `example.invalid` — `AGENTS.md` rule 9. Nothing here was copied off a
 * site, and the markup shapes are the ones the WordPress theme's own PHP
 * emits: a grid of result cards, a season accordion, a strip of player options
 * over a stack of embed boxes.
 *
 * The happy path is the smallest part of what is asserted. What matters is
 * that a page which no longer has the expected shape produces an empty list
 * rather than a throw, because `FOREIGN.md` §6 turns "found nothing" into a
 * refusal naming the step and turns a throw into a stack trace.
 */

import { describe, expect, it } from 'vitest';

import { parseHtml } from '@plugin-bridge/runtime/shims/dom';
import type { ThemeContext } from './engine';
import { themeById } from './engine';
import { dooplayTheme } from './dooplay';

const BASE = 'https://example.invalid/';

/** Everything the theme asked the host to fetch, in order. */
interface Call {
	readonly url: string;
	readonly method: string;
	readonly body: string | undefined;
	readonly headers: Readonly<Record<string, string>>;
}

/** A fixture that wants to see the form fields before it answers. */
type Responder = (fields: Record<string, string>) => string;

/**
 * The host, faked.
 *
 * A `pages` entry may be keyed by a URL for a GET, or by `POST <url>` for the
 * AJAX endpoint. Anything unmapped rejects, which is how a source that is
 * merely down is spelled.
 */
function makeContext(
	pages: Readonly<Record<string, string | Responder>>,
	overrides: Readonly<Record<string, string>> = {},
	lang = 'en'
): { ctx: ThemeContext; requested: string[]; calls: Call[] } {
	const requested: string[] = [];
	const calls: Call[] = [];
	const ctx: ThemeContext = {
		config: { baseUrl: BASE, lang, overrides },
		http: {
			text(url, request): Promise<string> {
				const method = request?.method ?? 'GET';
				requested.push(url);
				calls.push({
					url,
					method,
					body: request?.body,
					headers: { ...(request?.headers ?? {}) }
				});
				const body = pages[method === 'GET' ? url : `${method} ${url}`];
				if (typeof body === 'function') return Promise.resolve(body(formFields(request?.body)));
				if (typeof body !== 'string') return Promise.reject(new Error('no fixture'));
				return Promise.resolve(body);
			}
		},
		parse: (html: string, baseUrl?: string) => parseHtml(html, baseUrl ?? BASE)
	};
	return { ctx, requested, calls };
}

/** A header lookup that does not care how the header was capitalised. */
function header(call: Call, name: string): string {
	const wanted = name.toLowerCase();
	for (const key of Object.keys(call.headers)) {
		if (key.toLowerCase() === wanted) return call.headers[key] ?? '';
	}
	return '';
}

/** A form body, back as pairs, so an assertion does not depend on field order. */
function formFields(body: string | undefined): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const pair of (body ?? '').split('&')) {
		if (pair.length === 0) continue;
		const cut = pair.indexOf('=');
		const name = cut < 0 ? pair : pair.slice(0, cut);
		const value = cut < 0 ? '' : pair.slice(cut + 1);
		fields[decodeURIComponent(name.replace(/\+/g, ' '))] = decodeURIComponent(
			value.replace(/\+/g, ' ')
		);
	}
	return fields;
}

function page(body: string): string {
	return `<!DOCTYPE html><html><head><title>Fixture</title></head><body>${body}</body></html>`;
}

/* ── search fixtures ─────────────────────────────────────────────────────── */

const NEXT_PAGE = `
	<div class="pagination">
		<div class="resppages">
			<a href="/page/2/?s=blue"><span class="fa fa-chevron-right"></span></a>
		</div>
	</div>`;

const SEARCH_RESULTS = page(`
	<div class="search-page">
		<div class="result-item">
			<article>
				<div class="image">
					<a href="/tvshows/blue-hour/">
						<img src="/wp-content/uploads/blue.jpg" alt="Blue Hour">
					</a>
				</div>
			</article>
		</div>
		<div class="result-item">
			<article>
				<div class="image">
					<a href="/tvshows/second-light/">
						<img data-src="/wp-content/uploads/second.jpg" alt="Second Light">
					</a>
				</div>
			</article>
		</div>
	</div>
	${NEXT_PAGE}`);

const SEARCH_LAST_PAGE = page(`
	<div class="search-page">
		<div class="result-item">
			<article>
				<div class="image">
					<a href="/tvshows/only-one/"><img src="/img/one.jpg" alt="Only One"></a>
				</div>
			</article>
		</div>
	</div>
	<div class="pagination"><div class="resppages"><a href="/page/1/"><span class="fa fa-chevron-left"></span></a></div></div>`);

const SEARCH_EMPTY = page(`
	<div class="search-page">
		<div class="not-found">
			<h2>Nothing found</h2>
			<p>Sorry, no results matched.</p>
		</div>
	</div>`);

/** Truncated mid-tag, with an unclosed list and a stray close. */
const SEARCH_MALFORMED = `<html><body><div class=search-page><div class="result-item"><article><div class=image
	<a href=/tvshows/broken><img alt=Broken</div></div></article></p></div>`;

const FRONT_PAGE = page(`
	<div class="content">
		<article>
			<div class="poster">
				<a href="/tvshows/front-runner/">
					<img srcset="/img/front-480.jpg 480w, /img/front-960.jpg 960w" alt="Front Runner">
				</a>
			</div>
		</article>
	</div>`);

/** A front page that uses the theme's other card shape and nothing else. */
const FRONT_PAGE_ALTERNATE = page(`
	<div class="module">
		<article class="w_item_a">
			<a href="/tvshows/side-runner/">
				<img src="/img/side.jpg" alt="Side Runner">
			</a>
		</article>
	</div>`);

/* ── episode fixtures ────────────────────────────────────────────────────── */

function season(name: string, rows: readonly string[]): string {
	return `
		<div class="se-c">
			<div class="se-q"><span class="se-t">${name}</span><span class="title">Season ${name}</span></div>
			<div class="se-a"><ul class="episodios">${rows.join('')}</ul></div>
		</div>`;
}

function row(numbering: string, href: string, title: string): string {
	return `
		<li>
			<div class="numerando">${numbering}</div>
			<div class="episodiotitle">
				<a href="${href}">${title}</a>
				<span class="date">Jan. 04, 2021</span>
			</div>
		</li>`;
}

const DETAILS = page(`
	<div class="sheader"><div class="data"><h1>Blue Hour</h1></div></div>
	<div id="seasons">
		${season('1', [row('1 - 1', '/episodes/blue-hour-1x1/', 'Pilot'), row('1 - 2', '/episodes/blue-hour-1x2/', 'Second Light')])}
		${season('2', [row('2 - 1', '/episodes/blue-hour-2x1/', 'Return')])}
	</div>`);

const MOVIE_DETAILS = page(`
	<div class="sheader"><div class="data"><h1>A Single Thing</h1></div></div>
	<div id="info"><p>No seasons here.</p></div>`);

const EPISODE_PAGE = page(`
	<div class="pag_episodes">
		<div class="item"><a href="/episodes/blue-hour-1x1/"><i class="fa fa-chevron-left"></i></a></div>
		<div class="item"><a href="/tvshows/blue-hour/"><i class="fa fa-bars"></i></a></div>
		<div class="item"><a href="/episodes/blue-hour-1x3/"><i class="fa fa-chevron-right"></i></a></div>
	</div>`);

/* ── stream fixtures ─────────────────────────────────────────────────────── */

const PLAYER_PAGE = page(`
	<div class="player_nav">
		<ul id="playeroptionsul">
			<li id="player-option-1" class="dooplay_player_option" data-type="tv" data-post="42" data-nume="1">
				<span class="title">Option A</span>
			</li>
			<li id="player-option-2" class="dooplay_player_option" data-type="tv" data-post="42" data-nume="2">
				<span class="title">Option B</span><span class="server">Backup</span>
			</li>
		</ul>
	</div>
	<div id="player-container">
		<div id="source-player-1" class="source-box">
			<div class="pframe"><iframe class="metaframe rptss" src="https://frames.example.invalid/e/aaa"></iframe></div>
		</div>
		<div id="source-player-2" class="source-box">
			<div class="pframe">
				<iframe class="metaframe rptss" src="about:blank" data-src="https://frames.example.invalid/e/bbb"></iframe>
			</div>
		</div>
		<div id="source-player-3" class="source-box">
			<div class="pframe"><iframe class="metaframe rptss" src="/hls/ccc.m3u8"></iframe></div>
		</div>
		<div id="source-player-4" class="source-box">
			<div class="pframe"><iframe class="metaframe rptss" src="https://frames.example.invalid/e/aaa"></iframe></div>
		</div>
	</div>`);

const PLAYER_PAGE_ALTERNATE = page(`
	<div class="mirrors">
		<a class="mirror" href="https://frames.example.invalid/m/one">Mirror one</a>
		<a class="mirror" href="https://frames.example.invalid/m/two">Mirror two</a>
	</div>`);

const PLAYER_PAGE_EMPTY = page(
	`<div id="player-container"><p>This episode has no player.</p></div>`
);

/** The commoner shape: a tab strip and no frames until something asks. */
const PLAYER_PAGE_AJAX = page(`
	<div class="player_nav">
		<ul id="playeroptionsul">
			<li id="player-option-1" class="dooplay_player_option" data-type="tv" data-post="512" data-nume="1">
				<span class="title">Option A</span>
			</li>
			<li id="player-option-2" class="dooplay_player_option" data-type="tv" data-post="512" data-nume="2">
				<span class="title">Option B</span>
			</li>
		</ul>
	</div>
	<div id="player-container"></div>`);

/** One frame rendered into the page, one option left for the endpoint. */
const PLAYER_PAGE_MIXED = page(`
	<div class="player_nav">
		<ul id="playeroptionsul">
			<li id="player-option-1" class="dooplay_player_option" data-type="tv" data-post="512" data-nume="1">
				<span class="title">Option A</span>
			</li>
			<li id="player-option-2" class="dooplay_player_option" data-type="tv" data-post="512" data-nume="2">
				<span class="title">Option B</span>
			</li>
		</ul>
	</div>
	<div id="player-container">
		<div id="source-player-2" class="source-box">
			<div class="pframe"><iframe class="metaframe rptss" src="https://frames.example.invalid/e/rendered"></iframe></div>
		</div>
	</div>`);

const AJAX_ENDPOINT = 'POST https://example.invalid/wp-admin/admin-ajax.php';

/* ── the suite ───────────────────────────────────────────────────────────── */

describe('registration', () => {
	it('registers itself under the template directory name', () => {
		expect(themeById('dooplay')).toBe(dooplayTheme);
	});

	it('declares only keys it reads', () => {
		expect(dooplayTheme.settings).toContain('searchAnimeSelector');
		expect(dooplayTheme.settings).toContain('episodeListSelector');
		expect(dooplayTheme.settings).toContain('videoListSelector');
		expect(dooplayTheme.settings).toContain('videoAjaxPath');
		expect(dooplayTheme.settings).toContain('videoAjaxAction');
		expect(dooplayTheme.settings).toContain('videoAjaxPostField');
		expect(dooplayTheme.settings).toContain('videoAjaxNumeField');
		expect(dooplayTheme.settings).toContain('videoAjaxTypeField');
		expect(new Set(dooplayTheme.settings).size).toBe(dooplayTheme.settings.length);
	});
});

describe('search', () => {
	it('reads a page of result cards', async () => {
		const url = 'https://example.invalid/page/1/?s=blue%20hour';
		const { ctx, requested } = makeContext({ [url]: SEARCH_RESULTS });

		const result = await dooplayTheme.search('blue hour', 1, ctx);

		expect(requested).toEqual([url]);
		expect(result.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/tvshows/blue-hour/',
				title: 'Blue Hour',
				posterImageUrl: 'https://example.invalid/wp-content/uploads/blue.jpg'
			},
			{
				sourceMediaId: 'https://example.invalid/tvshows/second-light/',
				title: 'Second Light',
				posterImageUrl: 'https://example.invalid/wp-content/uploads/second.jpg'
			}
		]);
		expect(result.hasMore).toBe(true);
	});

	it('asks for the page it was given', async () => {
		const url = 'https://example.invalid/page/3/?s=blue';
		const { ctx, requested } = makeContext({ [url]: SEARCH_LAST_PAGE });

		const result = await dooplayTheme.search('blue', 3, ctx);

		expect(requested).toEqual([url]);
		expect(result.entries).toHaveLength(1);
		// A left chevron is not a right one, so this is the last page.
		expect(result.hasMore).toBe(false);
	});

	it('returns an empty page rather than throwing when nothing matched', async () => {
		const url = 'https://example.invalid/page/1/?s=nothing';
		const { ctx } = makeContext({ [url]: SEARCH_EMPTY });

		const result = await dooplayTheme.search('nothing', 1, ctx);

		expect(result.entries).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it('survives markup that was cut off mid-tag', async () => {
		const url = 'https://example.invalid/page/1/?s=broken';
		const { ctx } = makeContext({ [url]: SEARCH_MALFORMED });

		const result = await dooplayTheme.search('broken', 1, ctx);

		// The card has no readable title, so it is dropped rather than listed
		// as an untitled entry — and nothing thrown on the way.
		expect(result.entries).toEqual([]);
		expect(result.hasMore).toBe(false);
	});

	it('does not throw when a configured selector will not parse', async () => {
		const url = 'https://example.invalid/page/1/?s=blue';
		const { ctx } = makeContext({ [url]: SEARCH_RESULTS }, { searchAnimeSelector: 'div[' });

		const result = await dooplayTheme.search('blue', 1, ctx);

		expect(result.entries).toEqual([]);
	});

	it("takes an extension's overridden card selector", async () => {
		const url = 'https://example.invalid/page/1/?s=blue';
		const { ctx } = makeContext(
			{ [url]: SEARCH_RESULTS },
			{ searchAnimeSelector: 'div.result-item div.image a[href*="second"]' }
		);

		const result = await dooplayTheme.search('blue', 1, ctx);

		expect(result.entries.map((entry) => entry.title)).toEqual(['Second Light']);
	});

	it("takes an extension's overridden next-page selector through the delegation", async () => {
		const url = 'https://example.invalid/page/1/?s=blue';
		const { ctx } = makeContext(
			{ [url]: SEARCH_LAST_PAGE },
			// Upstream, the search selector *is* the listing selector, so an
			// extension that overrode only the listing one overrode both.
			{
				latestUpdatesNextPageSelector: 'div.resppages > a > span.fa-chevron-left'
			}
		);

		const result = await dooplayTheme.search('blue', 1, ctx);

		expect(result.hasMore).toBe(true);
	});

	it('answers a blank query from the front page', async () => {
		const { ctx, requested } = makeContext({ [BASE]: FRONT_PAGE });

		const result = await dooplayTheme.search('   ', 1, ctx);

		expect(requested).toEqual([BASE]);
		expect(result.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/tvshows/front-runner/',
				title: 'Front Runner',
				// The first entry of a srcset, without its width descriptor.
				posterImageUrl: 'https://example.invalid/img/front-480.jpg'
			}
		]);
		// The upstream request ignores the page number, so a second page would
		// return the first one again.
		expect(result.hasMore).toBe(false);
	});

	it('falls through to the other front-page card shape', async () => {
		const { ctx } = makeContext({ [BASE]: FRONT_PAGE_ALTERNATE });

		const result = await dooplayTheme.search('', 1, ctx);

		expect(result.entries.map((entry) => entry.sourceMediaId)).toEqual([
			'https://example.invalid/tvshows/side-runner/'
		]);
	});

	it('does not re-fetch the front page for a second page of a blank query', async () => {
		const { ctx, requested } = makeContext({ [BASE]: FRONT_PAGE });

		const result = await dooplayTheme.search('', 2, ctx);

		expect(requested).toEqual([]);
		expect(result).toEqual({ entries: [], hasMore: false });
	});
});

describe('episodes', () => {
	const detailsUrl = 'https://example.invalid/tvshows/blue-hour/';

	it('walks the season accordion, newest last', async () => {
		const { ctx } = makeContext({ [detailsUrl]: DETAILS });

		const episodes = await dooplayTheme.episodes(detailsUrl, ctx);

		expect(episodes).toEqual([
			{
				number: 1,
				sourceEpisodeId: 'https://example.invalid/episodes/blue-hour-2x1/',
				title: 'Season 2 x 1 - Return'
			},
			{
				number: 2,
				sourceEpisodeId: 'https://example.invalid/episodes/blue-hour-1x2/',
				title: 'Season 1 x 2 - Second Light'
			},
			{
				number: 1,
				sourceEpisodeId: 'https://example.invalid/episodes/blue-hour-1x1/',
				title: 'Season 1 x 1 - Pilot'
			}
		]);
	});

	it('hops from an episode page to the details page first', async () => {
		const episodeUrl = 'https://example.invalid/episodes/blue-hour-1x2/';
		const { ctx, requested } = makeContext({
			[episodeUrl]: EPISODE_PAGE,
			[detailsUrl]: DETAILS
		});

		const episodes = await dooplayTheme.episodes(episodeUrl, ctx);

		expect(requested).toEqual([episodeUrl, detailsUrl]);
		expect(episodes).toHaveLength(3);
	});

	it('keeps the page in hand when the hop fails', async () => {
		const episodeUrl = 'https://example.invalid/episodes/orphan/';
		const { ctx } = makeContext({ [episodeUrl]: EPISODE_PAGE });

		const episodes = await dooplayTheme.episodes(episodeUrl, ctx);

		// No accordion on the page that was kept, so it reads as single-entry.
		expect(episodes).toEqual([{ number: 1, sourceEpisodeId: episodeUrl, title: 'Movie' }]);
	});

	it('treats a page with no accordion as one entry', async () => {
		const url = 'https://example.invalid/movies/a-single-thing/';
		const { ctx } = makeContext({ [url]: MOVIE_DETAILS });

		expect(await dooplayTheme.episodes(url, ctx)).toEqual([
			{ number: 1, sourceEpisodeId: url, title: 'Movie' }
		]);
	});

	it('uses the language the extension declares for that wording', async () => {
		const url = 'https://example.invalid/movies/a-single-thing/';
		const { ctx } = makeContext({ [url]: MOVIE_DETAILS }, {}, 'pt-BR');

		expect((await dooplayTheme.episodes(url, ctx))[0]?.title).toBe('Filme');
	});

	it('takes an overridden wording over the language default', async () => {
		const url = 'https://example.invalid/movies/a-single-thing/';
		const { ctx } = makeContext({ [url]: MOVIE_DETAILS }, { episodeMovieText: 'Feature' });

		expect((await dooplayTheme.episodes(url, ctx))[0]?.title).toBe('Feature');
	});

	it("takes an extension's overridden row selector", async () => {
		const { ctx } = makeContext(
			{ [detailsUrl]: DETAILS },
			{ episodeListSelector: 'ul.episodios > li:has(a[href*="1x1"])' }
		);

		const episodes = await dooplayTheme.episodes(detailsUrl, ctx);

		expect(episodes.map((episode) => episode.title)).toEqual(['Season 1 x 1 - Pilot']);
	});

	it("takes an extension's overridden season prefix and numbering pattern", async () => {
		const { ctx } = makeContext(
			{ [detailsUrl]: DETAILS },
			{ episodeSeasonPrefix: 'S', episodeNumberRegex: '^(\\d+)' }
		);

		const episodes = await dooplayTheme.episodes(detailsUrl, ctx);

		// `^(\d+)` reads the season half of `1 - 2` rather than the episode half.
		expect(episodes.map((episode) => episode.title)).toEqual([
			'S 2 x 2 - Return',
			'S 1 x 1 - Second Light',
			'S 1 x 1 - Pilot'
		]);
	});

	it('falls back to the template pattern when the configured one will not compile', async () => {
		const { ctx } = makeContext({ [detailsUrl]: DETAILS }, { episodeNumberRegex: '(' });

		const episodes = await dooplayTheme.episodes(detailsUrl, ctx);

		expect(episodes.map((episode) => episode.number)).toEqual([1, 2, 1]);
	});

	it('returns nothing for markup with neither an accordion nor a page', async () => {
		const url = 'https://example.invalid/tvshows/broken/';
		const { ctx } = makeContext({
			[url]: '<div id=seasons><div><ul class=episodios><li><div'
		});

		// One season, no readable row: an empty list, not a throw.
		expect(await dooplayTheme.episodes(url, ctx)).toEqual([]);
	});

	it('refuses an id that resolves to nothing', async () => {
		const { ctx, requested } = makeContext({});

		expect(await dooplayTheme.episodes('   ', ctx)).toEqual([]);
		expect(requested).toEqual([]);
	});
});

describe('streams', () => {
	const episodeUrl = 'https://example.invalid/episodes/blue-hour-1x1/';

	it('returns the embed URLs the page exposes, named by their options', async () => {
		const { ctx } = makeContext({ [episodeUrl]: PLAYER_PAGE });

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		expect(streams).toEqual([
			{
				url: 'https://frames.example.invalid/e/aaa',
				container: 'mp4',
				label: 'Option A'
			},
			{
				// The placeholder in `src` is skipped for the real URL beside it.
				url: 'https://frames.example.invalid/e/bbb',
				container: 'mp4',
				label: 'Option B - Backup'
			},
			{
				// Relative, and resolved against the page rather than the root.
				url: 'https://example.invalid/hls/ccc.m3u8',
				container: 'hls',
				label: 'Player 3'
			}
		]);
	});

	it('returns an empty list for a page with no player at all', async () => {
		const { ctx } = makeContext({ [episodeUrl]: PLAYER_PAGE_EMPTY });

		expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
	});

	it('survives markup that was cut off mid-tag', async () => {
		const { ctx } = makeContext({
			[episodeUrl]: '<div class="source-box"><div class=pframe><iframe src='
		});

		expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
	});

	it("takes an extension's overridden player selector", async () => {
		const { ctx } = makeContext(
			{ [episodeUrl]: PLAYER_PAGE_ALTERNATE },
			{ videoListSelector: 'a.mirror' }
		);

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		expect(streams).toEqual([
			{
				url: 'https://frames.example.invalid/m/one',
				container: 'mp4',
				label: 'Player 1'
			},
			{
				url: 'https://frames.example.invalid/m/two',
				container: 'mp4',
				label: 'Player 2'
			}
		]);
	});

	it('does not throw when a configured selector will not parse', async () => {
		const { ctx } = makeContext({ [episodeUrl]: PLAYER_PAGE }, { videoListSelector: 'div[' });

		expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
	});

	it('never posts for a page that rendered its own frames', async () => {
		const { ctx, calls } = makeContext({ [episodeUrl]: PLAYER_PAGE });

		await dooplayTheme.streams(episodeUrl, ctx);

		expect(calls.map((call) => call.method)).toEqual(['GET']);
	});
});

describe('streams over the AJAX endpoint', () => {
	const episodeUrl = 'https://example.invalid/episodes/blue-hour-1x1/';

	it('asks the endpoint for options that carry only identifiers', async () => {
		const { ctx, calls } = makeContext({
			[episodeUrl]: PLAYER_PAGE_AJAX,
			[AJAX_ENDPOINT]: (fields) =>
				JSON.stringify({
					type: 'iframe',
					embed_url: `https://frames.example.invalid/e/${fields['nume'] ?? ''}`
				})
		});

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		expect(streams).toEqual([
			{
				url: 'https://frames.example.invalid/e/1',
				container: 'mp4',
				label: 'Option A'
			},
			{
				url: 'https://frames.example.invalid/e/2',
				container: 'mp4',
				label: 'Option B'
			}
		]);

		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(2);
		for (const post of posts) {
			// Resolved against the configured base, never against a hostname.
			expect(post.url).toBe('https://example.invalid/wp-admin/admin-ajax.php');
			expect(header(post, 'content-type')).toBe('application/x-www-form-urlencoded; charset=UTF-8');
		}
		expect(formFields(posts[0]?.body)).toEqual({
			action: 'doo_player_ajax',
			post: '512',
			nume: '1',
			type: 'tv'
		});
		expect(formFields(posts[1]?.body)).toEqual({
			action: 'doo_player_ajax',
			post: '512',
			nume: '2',
			type: 'tv'
		});
	});

	it('posts only for the options the page did not answer itself', async () => {
		const { ctx, calls } = makeContext({
			[episodeUrl]: PLAYER_PAGE_MIXED,
			[AJAX_ENDPOINT]: () =>
				JSON.stringify({
					type: 'iframe',
					embed_url: 'https://frames.example.invalid/e/fetched'
				})
		});

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(1);
		// The rendered frame belongs to option two, so option one is the one asked for.
		expect(formFields(posts[0]?.body)['nume']).toBe('1');
		// And the tab strip's numbering, not the order the two were found in,
		// decides which comes first.
		expect(streams).toEqual([
			{
				url: 'https://frames.example.invalid/e/fetched',
				container: 'mp4',
				label: 'Option A'
			},
			{
				url: 'https://frames.example.invalid/e/rendered',
				container: 'mp4',
				label: 'Option B'
			}
		]);
	});

	it('reads a mirror out of a fragment of markup', async () => {
		const { ctx } = makeContext({
			[episodeUrl]: PLAYER_PAGE_AJAX,
			[AJAX_ENDPOINT]: () =>
				JSON.stringify({
					type: 'iframe',
					embed_url: "<iframe class='metaframe' src='/hls/one.m3u8' allowfullscreen></iframe>"
				})
		});

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		// Both options answer with the same mirror, so it is listed once.
		expect(streams).toEqual([
			{
				url: 'https://example.invalid/hls/one.m3u8',
				container: 'hls',
				label: 'Option A'
			}
		]);
	});

	it('returns an empty list when the endpoint answers with junk', async () => {
		for (const junk of ['0', '', 'not json at all', '<html><body>Fatal error</body></html>']) {
			const { ctx } = makeContext({
				[episodeUrl]: PLAYER_PAGE_AJAX,
				[AJAX_ENDPOINT]: () => junk
			});

			expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
		}
	});

	it('returns an empty list when the endpoint refuses the request', async () => {
		const { ctx, calls } = makeContext({ [episodeUrl]: PLAYER_PAGE_AJAX });

		expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(2);
	});

	it('does not post for options with no identifiers on them', async () => {
		const { ctx, calls } = makeContext({
			[episodeUrl]: page(
				`<ul id="playeroptionsul"><li id="player-option-1"><span class="title">Nothing</span></li></ul>`
			)
		});

		expect(await dooplayTheme.streams(episodeUrl, ctx)).toEqual([]);
		expect(calls.map((call) => call.method)).toEqual(['GET']);
	});

	it("takes an extension's overridden endpoint path and field names", async () => {
		const { ctx, calls } = makeContext(
			{
				[episodeUrl]: PLAYER_PAGE_AJAX,
				'POST https://example.invalid/ajax/player.php': () =>
					JSON.stringify({
						embed_url: 'https://frames.example.invalid/e/custom'
					})
			},
			{
				videoAjaxPath: 'ajax/player.php',
				videoAjaxAction: 'player_lookup',
				videoAjaxPostField: 'entry',
				videoAjaxNumeField: 'slot',
				videoAjaxTypeField: 'kind'
			}
		);

		const streams = await dooplayTheme.streams(episodeUrl, ctx);

		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts[0]?.url).toBe('https://example.invalid/ajax/player.php');
		expect(formFields(posts[0]?.body)).toEqual({
			action: 'player_lookup',
			entry: '512',
			slot: '1',
			kind: 'tv'
		});
		expect(streams.map((stream) => stream.url)).toEqual([
			'https://frames.example.invalid/e/custom'
		]);
	});
});
