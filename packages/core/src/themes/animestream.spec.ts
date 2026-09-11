/**
 * The template is only interesting where a page disagrees with it.
 *
 * Every fixture below is hand-written markup shaped like the page the upstream
 * selectors were aimed at: a poster grid, an episode list whose number cells are
 * not all numbers, a mirror picker carrying one embedded document and one URL to
 * fetch another from. The assertions are about what survives a page that has
 * drifted — a missing title, an item with no number, a selector override that
 * does not parse — because that is what a converted plugin meets in the field.
 *
 * Rule 9: every host here is `example.invalid`, every path is invented, and
 * there is no content source in this file.
 */

import { describe, expect, it } from 'vitest';

import { base64Encode } from '../extract/patterns';
import { parseHtml } from '@plugin-bridge/runtime/shims/dom';
import { animeStreamTheme } from './animestream';
import type { ThemeContext } from './engine';

const BASE = 'https://example.invalid/';

/** Every request a test made, so an assertion can be about the URL as well. */
interface Recorder extends ThemeContext {
	readonly requested: string[];
}

function context(pages: Record<string, string>, overrides: Record<string, string> = {}): Recorder {
	const requested: string[] = [];
	return {
		config: { baseUrl: BASE, lang: 'en', overrides },
		http: {
			text(url: string): Promise<string> {
				requested.push(url);
				const body = pages[url];
				return body === undefined ? Promise.reject(new Error('no route')) : Promise.resolve(body);
			}
		},
		parse: parseHtml,
		requested
	};
}

const GRID = `<!DOCTYPE html><html><body>
<div class="listupd">
	<article class="bs">
		<a class="tip" href="/anime/first/">
			<div class="limit"><img src="/img/first.jpg" alt=""></div>
			<div class="tt">First Series<h2>hidden</h2></div>
		</a>
	</article>
	<article class="bs">
		<a class="tip" href="/anime/second/">
			<div class="limit"><img data-src="/img/second.jpg?resize=320" alt=""></div>
			<div class="ttl">Second Series</div>
		</a>
	</article>
	<article class="bs">
		<a class="tip" href="/anime/nameless/"><div class="limit"><img src="/img/x.jpg"></div></a>
	</article>
</div>
<div class="pagination"><a class="next" href="/page/2/?s=series">Next</a></div>
</body></html>`;

const LAST_PAGE = `<html><body>
<div class="listupd">
	<article><a class="tip" href="/anime/only/"><div class="tt">Only Series</div></a></article>
</div>
<div class="pagination"><span class="current">2</span></div>
</body></html>`;

const NOTHING = '<html><body><div class="listupd"></div><p>No results</p></body></html>';

/** Unclosed tags, a stray close, an unquoted attribute: an ordinary bad page. */
const MALFORMED = `<html><body><div class=listupd>
	<article><a class="tip" href=/anime/broken/>
		<div class="tt">Broken Series
	</article>
	</div></div>
	<article><a class="tip"><div class="tt">No link at all</div></a>
</body>`;

const EPISODES = `<html><body>
<div class="eplister"><ul>
	<li><a href="/watch/first-12/">
		<div class="epl-num">12 END</div><div class="epl-title">Finale</div>
		<div class="epl-sub">Sub</div><div class="epl-date">January 2, 2020</div>
	</a></li>
	<li><a href="/watch/first-11/"><div class="epl-num">11</div></a></li>
	<li><a href="/watch/first-special/"><div class="epl-num">Special</div></a></li>
	<li><a href="/watch/first-none/"><div class="epl-title">no number cell</div></a></li>
</ul></div>
</body></html>`;

const EMBED_DOCUMENT =
	'<div><iframe src="https://example.invalid/embed/alpha/" allowfullscreen></iframe></div>';
const RELATIVE_EMBED_DOCUMENT = '<div><iframe src="//example.invalid/embed/beta/"></iframe></div>';

const MIRRORS = `<html><body>
<select class="mirror">
	<option value="">Choose a mirror</option>
	<option data-index="0" value="${base64Encode(EMBED_DOCUMENT)}">Mirror A 720p</option>
	<option data-index="1" value="${base64Encode(RELATIVE_EMBED_DOCUMENT)}">Mirror B 1080p</option>
	<option data-index="2" value="${base64Encode(EMBED_DOCUMENT)}">Mirror A again</option>
</select>
<ul class="mirror"><li><a data-em="https://example.invalid/mirror-page/">Mirror C</a></li></ul>
</body></html>`;

/** No iframe: the template falls back to the embed-url meta tag. */
const MIRROR_PAGE = `<html><head>
<meta itemprop="embedUrl" content="//example.invalid/media/gamma.m3u8">
</head><body></body></html>`;

const SEARCH_URL = 'https://example.invalid/page/1/?s=series';
const LIST_URL = 'https://example.invalid/anime/?page=1&order=popular';
const MEDIA_URL = 'https://example.invalid/anime/first/';
const EPISODE_URL = 'https://example.invalid/watch/first-12/';

describe('searching the grid', () => {
	it('reads a page of items, their posters and the next-page link', async () => {
		const ctx = context({ [SEARCH_URL]: GRID });
		const page = await animeStreamTheme.search('series', 1, ctx);

		expect(ctx.requested).toEqual([SEARCH_URL]);
		expect(page.entries.map((entry) => entry.title)).toEqual(['First Series', 'Second Series']);
		expect(page.entries[0].sourceMediaId).toBe(MEDIA_URL);
		expect(page.entries[0].posterImageUrl).toBe('https://example.invalid/img/first.jpg');
		// The lazy-loading attribute wins, and the resize parameter is dropped.
		expect(page.entries[1].posterImageUrl).toBe('https://example.invalid/img/second.jpg');
		expect(page.hasMore).toBe(true);
	});

	it('reports no further pages when the pager has no next link', async () => {
		const ctx = context({ [SEARCH_URL]: LAST_PAGE });
		const page = await animeStreamTheme.search('series', 1, ctx);
		expect(page.entries.length).toBe(1);
		expect(page.hasMore).toBe(false);
	});

	it('encodes the query and asks for the page the caller wanted', async () => {
		const ctx = context({});
		await animeStreamTheme.search('two words', 3, ctx);
		expect(ctx.requested).toEqual(['https://example.invalid/page/3/?s=two%20words']);
	});

	it('asks the listing page for the popular ordering when there is no query', async () => {
		const ctx = context({ [LIST_URL]: GRID });
		const page = await animeStreamTheme.search('', 1, ctx);
		expect(ctx.requested).toEqual([LIST_URL]);
		expect(page.entries.length).toBe(2);
	});

	it('takes the listing url from config, absolute or relative', async () => {
		const ctx = context({}, { animeListUrl: 'https://example.invalid/series/' });
		await animeStreamTheme.search('', 2, ctx);
		expect(ctx.requested).toEqual(['https://example.invalid/series/?page=2&order=popular']);

		const relative = context({}, { animeListUrl: 'catalogue' });
		await animeStreamTheme.search('', 1, relative);
		expect(relative.requested).toEqual(['https://example.invalid/catalogue/?page=1&order=popular']);
	});

	it('returns nothing rather than throwing on an empty page', async () => {
		const ctx = context({ [SEARCH_URL]: NOTHING });
		await expect(animeStreamTheme.search('series', 1, ctx)).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('returns nothing rather than throwing when the request fails', async () => {
		const ctx = context({});
		await expect(animeStreamTheme.search('series', 1, ctx)).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('keeps what it can out of malformed markup and drops the rest', async () => {
		const ctx = context({ [SEARCH_URL]: MALFORMED });
		const page = await animeStreamTheme.search('series', 1, ctx);
		expect(page.entries.map((entry) => entry.sourceMediaId)).toEqual([
			'https://example.invalid/anime/broken/'
		]);
	});

	it('uses an overridden item selector, and an unparseable one finds nothing', async () => {
		const overridden = context(
			{ [SEARCH_URL]: GRID },
			{ searchAnimeSelector: 'div.listupd article:eq(1) a.tip' }
		);
		const page = await animeStreamTheme.search('series', 1, overridden);
		expect(page.entries.map((entry) => entry.title)).toEqual(['Second Series']);

		const broken = context({ [SEARCH_URL]: GRID }, { searchAnimeSelector: 'div.listupd[' });
		await expect(animeStreamTheme.search('series', 1, broken)).resolves.toEqual({
			entries: [],
			hasMore: false
		});
	});

	it('prefers a popular selector override for the no-query listing', async () => {
		const ctx = context(
			{ [LIST_URL]: GRID },
			{ popularAnimeSelector: 'div.listupd article:eq(0) a.tip' }
		);
		const page = await animeStreamTheme.search('', 1, ctx);
		expect(page.entries.map((entry) => entry.title)).toEqual(['First Series']);
	});
});

describe('reading the episode list', () => {
	it('numbers the rows, keeping the number cell as the title', async () => {
		const ctx = context({ [MEDIA_URL]: EPISODES });
		const found = await animeStreamTheme.episodes(MEDIA_URL, ctx);

		expect(found.map((episode) => episode.number)).toEqual([12, 11, 0]);
		expect(found.map((episode) => episode.title)).toEqual([
			'Episode 12 END',
			'Episode 11',
			'Episode Special'
		]);
		expect(found[0].sourceEpisodeId).toBe(EPISODE_URL);
	});

	it('uses the configured episode prefix', async () => {
		const ctx = context({ [MEDIA_URL]: EPISODES }, { episodePrefix: 'Folge' });
		const found = await animeStreamTheme.episodes(MEDIA_URL, ctx);
		expect(found[1].title).toBe('Folge 11');
	});

	it('uses an overridden list selector', async () => {
		const ctx = context(
			{ [MEDIA_URL]: EPISODES },
			{ episodeListSelector: 'div.eplister li:eq(1) > a' }
		);
		const found = await animeStreamTheme.episodes(MEDIA_URL, ctx);
		expect(found.map((episode) => episode.number)).toEqual([11]);
	});

	it('finds nothing on a page with no episode list, and does not throw', async () => {
		const ctx = context({ [MEDIA_URL]: NOTHING });
		await expect(animeStreamTheme.episodes(MEDIA_URL, ctx)).resolves.toEqual([]);
	});

	it('finds nothing when the page could not be fetched', async () => {
		await expect(animeStreamTheme.episodes(MEDIA_URL, context({}))).resolves.toEqual([]);
	});
});

describe('reading the mirror list', () => {
	it('decodes embedded mirrors, fetches linked ones, and drops duplicates', async () => {
		const ctx = context({
			[EPISODE_URL]: MIRRORS,
			'https://example.invalid/mirror-page/': MIRROR_PAGE
		});
		const found = await animeStreamTheme.streams(EPISODE_URL, ctx);

		expect(found.map((stream) => stream.url)).toEqual([
			'https://example.invalid/embed/alpha/',
			'https://example.invalid/embed/beta/',
			'https://example.invalid/media/gamma.m3u8'
		]);
		expect(found.map((stream) => stream.label)).toEqual([
			'Mirror A 720p',
			'Mirror B 1080p',
			'Mirror C'
		]);
		expect(found.map((stream) => stream.container)).toEqual(['mp4', 'mp4', 'hls']);
	});

	it('skips a mirror whose page could not be fetched', async () => {
		const ctx = context({ [EPISODE_URL]: MIRRORS });
		const found = await animeStreamTheme.streams(EPISODE_URL, ctx);
		expect(found.map((stream) => stream.url)).toEqual([
			'https://example.invalid/embed/alpha/',
			'https://example.invalid/embed/beta/'
		]);
	});

	it('uses an overridden mirror selector and iframe selector', async () => {
		const ctx = context(
			{ [EPISODE_URL]: MIRRORS },
			{
				videoListSelector: 'select.mirror > option[data-index]:lt(3)',
				getEpisodeIframeSelector: 'iframe[allowfullscreen]'
			}
		);
		const found = await animeStreamTheme.streams(EPISODE_URL, ctx);
		// The list override reaches both embedded mirrors; the iframe override
		// then matches only the one document carrying that attribute.
		expect(found.map((stream) => stream.url)).toEqual(['https://example.invalid/embed/alpha/']);
	});

	it('finds nothing on a page with no mirrors, and does not throw', async () => {
		const ctx = context({ [EPISODE_URL]: NOTHING });
		await expect(animeStreamTheme.streams(EPISODE_URL, ctx)).resolves.toEqual([]);
	});

	it('finds nothing when the mirror selector does not parse', async () => {
		const ctx = context({ [EPISODE_URL]: MIRRORS }, { videoListSelector: 'select.mirror > (' });
		await expect(animeStreamTheme.streams(EPISODE_URL, ctx)).resolves.toEqual([]);
	});
});

describe('what the template declares', () => {
	it('names itself after its template directory and lists what it reads', () => {
		expect(animeStreamTheme.id).toBe('animestream');
		expect([...animeStreamTheme.settings].sort()).toEqual([
			'animeListUrl',
			'episodeListSelector',
			'episodePrefix',
			'getEpisodeIframeSelector',
			'popularAnimeNextPageSelector',
			'popularAnimeSelector',
			'searchAnimeNextPageSelector',
			'searchAnimeSelector',
			'videoListSelector'
		]);
	});
});
