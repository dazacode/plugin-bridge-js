/**
 * What this template promises is a catalogue, and that is where the assertions
 * are: the card selector, the pager, and the form post a text search is —
 * method, body and content type, because a search sent as a query string would
 * pass a shallow test and fail against a real install.
 *
 * The episode list is asserted the other way round — that it finds nothing until
 * an extension supplies a selector — because the upstream template genuinely
 * declares none, and a theme that invented one would produce a plugin that
 * installs and then shows the wrong rows.
 *
 * Rule 9: every host here is `example.invalid`. Nothing in this file is a real
 * site, and the markup is written by hand.
 */

import { describe, expect, it } from 'vitest';

import { parseHtml } from '@plugin-bridge/runtime/shims/dom';
import { dataLifeEngineTheme } from './datalifeengine';
import type { ThemeContext } from './engine';

const BASE = 'https://example.invalid/';

/** Everything one request carried, so the form post can be asserted whole. */
interface Sent {
	readonly url: string;
	readonly method: string;
	readonly body: string | undefined;
	readonly headers: Record<string, string>;
}

interface Recorder extends ThemeContext {
	readonly sent: Sent[];
	/** The URLs alone, which is all most assertions are about. */
	readonly requested: string[];
}

function context(pages: Record<string, string>, overrides: Record<string, string> = {}): Recorder {
	const sent: Sent[] = [];
	const requested: string[] = [];
	return {
		config: { baseUrl: BASE, lang: 'fr', overrides },
		http: {
			text(
				url: string,
				request?: {
					headers?: Record<string, string>;
					method?: 'GET' | 'POST';
					body?: string;
				}
			): Promise<string> {
				sent.push({
					url,
					method: request?.method ?? 'GET',
					body: request?.body,
					headers: request?.headers ?? {}
				});
				requested.push(url);
				const body = pages[url];
				return body === undefined ? Promise.reject(new Error('no route')) : Promise.resolve(body);
			}
		},
		parse: parseHtml,
		sent,
		requested
	};
}

const LISTING = `<!DOCTYPE html><html><body>
<div id="dle-content">
	<div class="mov">
		<a href="https://example.invalid/series/first.html">First Series</a>
		<img src="/uploads/first.jpg" alt="">
		<span class="block-sai">Season 2</span>
	</div>
	<div class="mov">
		<a href="/series/second.html">Second Series</a>
		<img src="/uploads/second.jpg" alt="">
	</div>
	<div class="mov"><span>a card with no link</span></div>
</div>
<span class="navigation">
	<span class="nav_ext">...</span>
	<span>1</span>
	<a href="/page/2/">2</a>
</span>
</body></html>`;

const LAST_PAGE = `<html><body>
<div id="dle-content">
	<div class="mov"><a href="/series/only.html">Only Series</a></div>
</div>
<span class="navigation"><span class="nav_ext">...</span><span>3</span></span>
</body></html>`;

const NOTHING = '<html><body><div id="dle-content"></div></body></html>';

/** An unclosed card, an unquoted attribute, and a close tag with no opening. */
const MALFORMED = `<html><body><div id=dle-content>
	<div class="mov"><a href=/series/broken.html>Broken Series
	<div class="mov"><a href="/series/after.html">After Series</a></div>
</div></span>
</body>`;

const EPISODE_PAGE = `<html><body>
<div class="mov-desc"><span itemprop="description">A description</span></div>
<div class="mov-links">
	<a href="/series/first/episode-1.html">Episode 1</a>
	<a href="/series/first/episode-2.html">Episode 2</a>
	<span>not a link</span>
</div>
</body></html>`;

const PLAYER_PAGE = `<html><body>
<div class="player">
	<iframe src="https://example.invalid/embed/one/" title="Server One"></iframe>
	<iframe src="//example.invalid/embed/two.m3u8"></iframe>
	<iframe></iframe>
	<a data-src="/embed/three/">Server Three</a>
</div>
</body></html>`;

const LIST_URL = 'https://example.invalid/page/1/';
/** The first page of a text search is posted to the site root. */
const SEARCH_URL = 'https://example.invalid/';
const SEARCH_PAGE_URL = 'https://example.invalid/index.php?do=search';
const MEDIA_URL = 'https://example.invalid/series/first.html';
const EPISODE_URL = 'https://example.invalid/series/first/episode-1.html';

describe('searching the catalogue', () => {
	it('reads the cards, their posters and the pager', async () => {
		const ctx = context({ [SEARCH_URL]: LISTING });
		const page = await dataLifeEngineTheme.search('blue', 1, ctx);

		expect(ctx.requested).toEqual([SEARCH_URL]);
		expect(page.entries.map((entry) => entry.title)).toEqual([
			'First Series Season 2',
			'Second Series'
		]);
		expect(page.entries[0].sourceMediaId).toBe(MEDIA_URL);
		expect(page.entries[0].posterImageUrl).toBe('https://example.invalid/uploads/first.jpg');
		expect(page.entries[1].sourceMediaId).toBe('https://example.invalid/series/second.html');
		expect(page.hasMore).toBe(true);
	});

	it('reports no further pages when the pager ends', async () => {
		const ctx = context({ [SEARCH_URL]: LAST_PAGE });
		const page = await dataLifeEngineTheme.search('blue', 1, ctx);
		expect(page.entries.length).toBe(1);
		expect(page.hasMore).toBe(false);
	});

	it('posts the search as a form, not as a query string', async () => {
		const ctx = context({ [SEARCH_URL]: LISTING });
		await dataLifeEngineTheme.search('blue', 1, ctx);

		expect(ctx.sent).toEqual([
			{
				url: SEARCH_URL,
				method: 'POST',
				body: 'do=search&subaction=search&story=blue',
				headers: {
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
					'content-type': 'application/x-www-form-urlencoded',
					origin: 'https://example.invalid',
					referer: 'https://example.invalid/'
				}
			}
		]);
	});

	it('sends the paging parameters, and the search endpoint, from page two on', async () => {
		const ctx = context({});
		await dataLifeEngineTheme.search('blue sky', 2, ctx);

		expect(ctx.sent.length).toBe(1);
		expect(ctx.sent[0].url).toBe(SEARCH_PAGE_URL);
		expect(ctx.sent[0].method).toBe('POST');
		// A space is a `+`; everything else is percent-encoded.
		expect(ctx.sent[0].body).toBe(
			'do=search&subaction=search&search_start=2&full_search=0&result_from=11&story=blue+sky'
		);
		expect(ctx.sent[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
	});

	it('leaves the no-query listing a plain GET with no body', async () => {
		const ctx = context({ [LIST_URL]: LISTING });
		await dataLifeEngineTheme.search('', 1, ctx);
		expect(ctx.sent).toEqual([{ url: LIST_URL, method: 'GET', body: undefined, headers: {} }]);
	});

	it('does not ask at all for a query the CMS would refuse', async () => {
		const ctx = context({ [SEARCH_URL]: LISTING });
		const page = await dataLifeEngineTheme.search('abc', 1, ctx);
		expect(ctx.requested).toEqual([]);
		expect(page).toEqual({ entries: [], hasMore: false });
	});

	it('browses the paginated listing when there is no query', async () => {
		const ctx = context({ [LIST_URL]: LISTING });
		const page = await dataLifeEngineTheme.search('', 1, ctx);
		expect(ctx.requested).toEqual([LIST_URL]);
		expect(page.entries.length).toBe(2);
	});

	it('returns nothing rather than throwing on an empty page', async () => {
		const ctx = context({ [SEARCH_URL]: NOTHING });
		await expect(dataLifeEngineTheme.search('blue', 1, ctx)).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('returns nothing rather than throwing when the request fails', async () => {
		await expect(dataLifeEngineTheme.search('blue', 1, context({}))).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('keeps what it can out of malformed markup', async () => {
		const ctx = context({ [SEARCH_URL]: MALFORMED });
		const page = await dataLifeEngineTheme.search('blue', 1, ctx);
		expect(page.entries.map((entry) => entry.sourceMediaId)).toContain(
			'https://example.invalid/series/broken.html'
		);
	});

	it('uses an overridden card selector, and an unparseable one finds nothing', async () => {
		const overridden = context(
			{ [SEARCH_URL]: LISTING },
			{ searchAnimeSelector: 'div#dle-content > div.mov:eq(1)' }
		);
		const page = await dataLifeEngineTheme.search('blue', 1, overridden);
		expect(page.entries.map((entry) => entry.title)).toEqual(['Second Series']);

		const broken = context({ [SEARCH_URL]: LISTING }, { searchAnimeSelector: 'div#dle-content[' });
		await expect(dataLifeEngineTheme.search('blue', 1, broken)).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('falls back to the popular selectors the search path inherits', async () => {
		const ctx = context(
			{ [SEARCH_URL]: LISTING },
			{ popularAnimeSelector: 'div#dle-content > div.mov:eq(0)' }
		);
		const page = await dataLifeEngineTheme.search('blue', 1, ctx);
		expect(page.entries.map((entry) => entry.title)).toEqual(['First Series Season 2']);
	});
});

describe('reading the episode list', () => {
	it('finds nothing until an extension supplies a selector', async () => {
		const ctx = context({ [MEDIA_URL]: EPISODE_PAGE });
		const found = await dataLifeEngineTheme.episodes(MEDIA_URL, ctx);
		expect(found).toEqual([]);
		// The template declares none, so there is nothing to fetch either.
		expect(ctx.requested).toEqual([]);
	});

	it('reads the rows an overridden selector names', async () => {
		const ctx = context(
			{ [MEDIA_URL]: EPISODE_PAGE },
			{ episodeListSelector: 'div.mov-links > a[href]' }
		);
		const found = await dataLifeEngineTheme.episodes(MEDIA_URL, ctx);

		expect(found.map((episode) => episode.number)).toEqual([1, 2]);
		expect(found.map((episode) => episode.sourceEpisodeId)).toEqual([
			EPISODE_URL,
			'https://example.invalid/series/first/episode-2.html'
		]);
		expect(found[0].title).toBe('Episode 1');
	});

	it('returns nothing rather than throwing when the page cannot be read', async () => {
		const ctx = context({}, { episodeListSelector: 'div.mov-links > a[href]' });
		await expect(dataLifeEngineTheme.episodes(MEDIA_URL, ctx)).resolves.toEqual([]);
	});

	it('returns nothing rather than throwing on an unparseable selector', async () => {
		const ctx = context({ [MEDIA_URL]: EPISODE_PAGE }, { episodeListSelector: 'div.mov-links >' });
		await expect(dataLifeEngineTheme.episodes(MEDIA_URL, ctx)).resolves.toEqual([]);
	});
});

describe('reading the players an episode page embeds', () => {
	it('takes each frame it can find, and skips the ones with no source', async () => {
		const ctx = context({ [EPISODE_URL]: PLAYER_PAGE });
		const found = await dataLifeEngineTheme.streams(EPISODE_URL, ctx);

		expect(found.map((stream) => stream.url)).toEqual([
			'https://example.invalid/embed/one/',
			'https://example.invalid/embed/two.m3u8'
		]);
		expect(found.map((stream) => stream.label)).toEqual(['Server One', 'Mirror 2']);
		expect(found.map((stream) => stream.container)).toEqual(['mp4', 'hls']);
	});

	it('uses an overridden player selector', async () => {
		const ctx = context(
			{ [EPISODE_URL]: PLAYER_PAGE },
			{ videoListSelector: 'div.player a[data-src]' }
		);
		const found = await dataLifeEngineTheme.streams(EPISODE_URL, ctx);
		expect(found).toEqual([
			{
				url: 'https://example.invalid/embed/three/',
				container: 'mp4',
				label: 'Server Three'
			}
		]);
	});

	it('finds nothing on a page with no player, and does not throw', async () => {
		const ctx = context({ [EPISODE_URL]: NOTHING });
		await expect(dataLifeEngineTheme.streams(EPISODE_URL, ctx)).resolves.toEqual([]);
	});

	it('finds nothing when the request fails', async () => {
		await expect(dataLifeEngineTheme.streams(EPISODE_URL, context({}))).resolves.toEqual([]);
	});
});

describe('what the template declares', () => {
	it('names itself after its template directory and lists what it reads', () => {
		expect(dataLifeEngineTheme.id).toBe('datalifeengine');
		expect([...dataLifeEngineTheme.settings].sort()).toEqual([
			'episodeListSelector',
			'popularAnimeNextPageSelector',
			'popularAnimeSelector',
			'searchAnimeNextPageSelector',
			'searchAnimeSelector',
			'videoListSelector'
		]);
	});
});
