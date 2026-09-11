/**
 * The sidebar-grid template, against markup written here.
 *
 * Every fixture in this file is hand-written and every host in one is
 * `example.invalid`, which RFC 6761 reserves and which resolves nowhere. No
 * real source is named, linked or implied, in the fixtures or anywhere else —
 * `AGENTS.md` rule 9 — and the first test in the file is a check that the
 * module under test cannot have acquired one either.
 *
 * What is being pinned, beyond "the selectors work":
 *
 * - a page that does not match produces **nothing**, never an exception. The
 *   install-time verification in `FOREIGN.md` §6 turns "found nothing" into a
 *   refusal naming the step that found nothing, and that is the failure mode
 *   this whole design is built around. A throw from three frames down is not.
 * - an override actually replaces the template's default, under the exact key
 *   a converter would write it as.
 * - markup that is not valid HTML — unquoted attributes, unclosed elements, a
 *   stray end tag — parses and reads anyway, because scraped markup is never
 *   valid and never will be.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { base64Encode } from '../extract/patterns';
import { parseHtml } from '@plugin-bridge/runtime/shims/dom';

import type { ThemeContext } from './engine';
import { themeById } from './engine';
import { wcoTheme } from './wcotheme';

/* -------------------------------------------------------------------------
 * Harness
 * ---------------------------------------------------------------------- */

const BASE = 'https://example.invalid/';

interface Recorded {
	readonly url: string;
	readonly method: string;
	readonly body: string | undefined;
	readonly headers: Record<string, string> | undefined;
}

function contextFor(
	pages: Readonly<Record<string, string>>,
	overrides: Readonly<Record<string, string>> = {},
	log: Recorded[] = []
): ThemeContext {
	return {
		config: { baseUrl: BASE, lang: 'en', overrides },
		http: {
			async text(url, request) {
				log.push({
					url,
					method: request?.method ?? 'GET',
					body: request?.body,
					headers: request?.headers
				});
				const body = pages[url];
				if (body === undefined) throw new Error(`the test declared no page at ${url}`);
				return body;
			}
		},
		parse: (html, baseUrl) => parseHtml(html, baseUrl ?? '')
	};
}

const HOME_URL = 'https://example.invalid/';
const SEARCH_URL = 'https://example.invalid/search';

/* -------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------- */

const HOME_PAGE = `<!doctype html>
<html><head><title>Home</title></head><body>
	<div id="sidebar_right2">
		<ul class="items">
			<li>
				<div class="recent-release-episodes">
					<a href="/series/first-title">First Title<span>Dub</span></a>
				</div>
				<img src="/art/first.jpg" alt="First Title art">
			</li>
			<li>
				<div class="img"><a href="/series/second-title"><img src="/art/second.jpg" alt="Second Title"></a></div>
			</li>
		</ul>
	</div>

	<div class="recent-release">Recent Releases</div>
	<div>
		<ul>
			<li><a href="/watch/third-title-episode-1">Third Title Episode 1</a></li>
		</ul>
	</div>

	<div class="recent-release">Recently Added</div>
	<div>
		<ul>
			<li><div class="img"><a href="/series/fourth-title"><img src="/art/fourth.jpg" alt="Fourth Title"></a></div></li>
		</ul>
	</div>
</body></html>`;

const SEARCH_PAGE = `<!doctype html>
<html><body>
	<div id="sidebar_right2">
		<li><a href="/series/searched-one">Searched One</a></li>
		<li><a href="/series/searched-two">Searched Two</a></li>
	</div>
</body></html>`;

const SERIES_PAGE = `<!doctype html>
<html><body>
	<div class="video-title"><a href="/series/show">Show</a></div>
	<div class="cat-eps"><a href="/watch/show-episode-2"><span>Episode 2 Second Steps</span></a></div>
	<div class="cat-eps"><a href="/watch/show-episode-1"><span>Episode 1 Beginnings</span></a></div>
	<div class="cat-eps"><a href="/watch/show-season-2"><span>Season 2 Episode 3 Later</span></a></div>
	<div id="episodeList">
		<a class="dark-episode-item" href="/watch/show-dub-1"><span>Episode 1 Dub Version</span></a>
	</div>
</body></html>`;

const FILM_PAGE = `<!doctype html>
<html><body>
	<div class="video-title">Episode 1 A Film</div>
	<iframe src="/embed/film"></iframe>
</body></html>`;

const EMPTY_PAGE = `<!doctype html><html><head><title>Nothing</title></head><body><p>Nothing here.</p></body></html>`;

const EPISODE_PAGE = `<!doctype html>
<html><body>
	<div class="video-title">Show Episode 1</div>
	<iframe src="/embed/one?pid=abc"></iframe>
	<iframe src="https://frames.example.invalid/two/index.m3u8"></iframe>
	<iframe></iframe>
</body></html>`;

/**
 * Markup of the kind that actually arrives: unquoted attribute values, an
 * unclosed list item, an end tag for an element nobody opened.
 */
const MALFORMED_PAGE = `<html><body>
	<div id=sidebar_right2>
		<ul class=items>
			<li><a href=/series/loose>Loose</a>
			<li><div class=img><a href=/series/other><img src=/art/other.jpg alt=Other
	</span></div></div>
	<p>trailing
</body>`;

/** The old player: a base64 array, a numeric shift, and one character each. */
function oldPlayerPage(markup: string, shift: number): string {
	const parts = markup
		.split('')
		.map((character) => `"${base64Encode(String(character.charCodeAt(0) + shift))}"`)
		.join(',');
	return `<!doctype html>
<html><body>
	<div class="video-title">Show Episode 1</div>
	<script>
		var terms = [${parts}];
		var out = decodeURIComponent(terms.map(function (t) { return String.fromCharCode(parseInt(atob(t)) - ${shift}); }).join(""));
		document.write(out);
	</script>
</body></html>`;
}

/* -------------------------------------------------------------------------
 * Rule 9
 * ---------------------------------------------------------------------- */

describe('the module itself', () => {
	const source = readFileSync(fileURLToPath(new URL('./wcotheme.ts', import.meta.url)), 'utf8');

	it('names no site', () => {
		const hostShaped =
			/\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|tv|io|co|me|to|cc|ru|se|it|is|xyz|club|site|online|sx|nu|la|pw|biz|info|ws|st|live|fun)\b/i;
		expect(hostShaped.test(source)).toBe(false);
	});

	it('hard-codes no url', () => {
		expect(source.indexOf('://')).toBe(-1);
	});

	it('registers itself under its template directory name', () => {
		expect(themeById('wcotheme')).toBe(wcoTheme);
		expect(wcoTheme.id).toBe('wcotheme');
	});

	it('declares every key it reads, and reads every key it declares', () => {
		for (const key of wcoTheme.settings) {
			expect(source.indexOf(`'${key}'`)).toBeGreaterThan(-1);
		}
		expect([...wcoTheme.settings].sort()).toEqual([
			'episodeListSelector',
			'episodeTitleRegex',
			'latestUpdatesNextPageSelector',
			'latestUpdatesSelector',
			'popularAnimeSelector',
			'searchAnimeSelector',
			'useOldIframeExtractor'
		]);
	});
});

/* -------------------------------------------------------------------------
 * search
 * ---------------------------------------------------------------------- */

describe('search', () => {
	it('reads every grid on the home page when there is no query', async () => {
		const page = await wcoTheme.search('', 1, contextFor({ [HOME_URL]: HOME_PAGE }));

		expect(page.hasMore).toBe(false);
		expect(page.entries.map((entry) => entry.title)).toEqual([
			'First Title',
			'Second Title',
			'Third Title Episode 1',
			'Fourth Title'
		]);
		expect(page.entries[0].sourceMediaId).toBe('https://example.invalid/series/first-title');
		expect(page.entries[0].posterImageUrl).toBe('https://example.invalid/art/first.jpg');
	});

	it('posts the query as a form, and reads the sidebar list back', async () => {
		const log: Recorded[] = [];
		const ctx = contextFor({ [SEARCH_URL]: SEARCH_PAGE }, {}, log);

		const page = await wcoTheme.search('spirited', 1, ctx);

		expect(log).toHaveLength(1);
		expect(log[0].url).toBe(SEARCH_URL);
		expect(log[0].method).toBe('POST');
		expect(log[0].body).toBe('catara=spirited&konuara=series');
		expect(page.entries.map((entry) => entry.sourceMediaId)).toEqual([
			'https://example.invalid/series/searched-one',
			'https://example.invalid/series/searched-two'
		]);
	});

	it('never asks for a second page, because the template has none', async () => {
		const log: Recorded[] = [];
		const page = await wcoTheme.search('spirited', 2, contextFor({}, {}, log));

		expect(page).toEqual({ entries: [], hasMore: false });
		expect(log).toHaveLength(0);
	});

	it('finds nothing on a page that does not match, and does not throw', async () => {
		const page = await wcoTheme.search('', 1, contextFor({ [HOME_URL]: EMPTY_PAGE }));
		expect(page).toEqual({ entries: [], hasMore: false });
	});

	it('reads broken markup rather than refusing it', async () => {
		const page = await wcoTheme.search('', 1, contextFor({ [HOME_URL]: MALFORMED_PAGE }));

		expect(page.entries.map((entry) => entry.sourceMediaId)).toEqual([
			'https://example.invalid/series/loose',
			'https://example.invalid/series/other'
		]);
	});

	it('survives a selector override that will not compile', async () => {
		const page = await wcoTheme.search(
			'',
			1,
			contextFor({ [HOME_URL]: HOME_PAGE }, { popularAnimeSelector: 'div:nonsense(' })
		);

		// The two release strips still read; only the broken one is silent.
		expect(page.entries.map((entry) => entry.title)).toEqual([
			'Third Title Episode 1',
			'Fourth Title'
		]);
	});

	it('takes an overridden grid selector under its Kotlin member name', async () => {
		const markup = `<html><body><div id="rebuilt"><span class="card">
			<a href="/series/rebuilt"><img src="/art/rebuilt.jpg" alt="Rebuilt Title"></a>
		</span></div></body></html>`;

		const page = await wcoTheme.search(
			'',
			1,
			contextFor({ [HOME_URL]: markup }, { popularAnimeSelector: 'div#rebuilt span.card' })
		);

		expect(page.entries).toEqual([
			{
				sourceMediaId: 'https://example.invalid/series/rebuilt',
				title: 'Rebuilt Title',
				posterImageUrl: 'https://example.invalid/art/rebuilt.jpg'
			}
		]);
	});

	it('takes an overridden search selector for the posted response', async () => {
		const markup = `<html><body><ol id="hits"><li><a href="/series/hit">A Hit</a></li></ol></body></html>`;

		const page = await wcoTheme.search(
			'hit',
			1,
			contextFor({ [SEARCH_URL]: markup }, { searchAnimeSelector: 'ol#hits li' })
		);

		expect(page.entries).toEqual([
			{ sourceMediaId: 'https://example.invalid/series/hit', title: 'A Hit' }
		]);
	});
});

/* -------------------------------------------------------------------------
 * episodes
 * ---------------------------------------------------------------------- */

describe('episodes', () => {
	const SERIES_URL = 'https://example.invalid/series/show';

	it('reads all three episode markups, subbed before dubbed', async () => {
		const episodes = await wcoTheme.episodes(SERIES_URL, contextFor({ [SERIES_URL]: SERIES_PAGE }));

		expect(
			episodes.map((episode) => [episode.title, episode.number, episode.sourceEpisodeId])
		).toEqual([
			['Episode 1: Beginnings', 1, 'https://example.invalid/watch/show-episode-1'],
			['Episode 2: Second Steps', 2, 'https://example.invalid/watch/show-episode-2'],
			['Season 2 - Episode 3: Later', 103, 'https://example.invalid/watch/show-season-2'],
			['Episode 1: Dub Version', 1, 'https://example.invalid/watch/show-dub-1']
		]);
	});

	it('treats a page with a heading and no list as one episode', async () => {
		const url = 'https://example.invalid/film/one';
		const episodes = await wcoTheme.episodes(url, contextFor({ [url]: FILM_PAGE }));

		expect(episodes).toEqual([{ number: 1, sourceEpisodeId: url, title: 'Episode 1: A Film' }]);
	});

	it('finds nothing on a page with neither a list nor a heading', async () => {
		const url = 'https://example.invalid/series/gone';
		expect(await wcoTheme.episodes(url, contextFor({ [url]: EMPTY_PAGE }))).toEqual([]);
	});

	it('takes an overridden episode list selector', async () => {
		const url = 'https://example.invalid/series/moved';
		const markup = `<html><body><table id="eps">
			<tr><td><a href="/watch/moved-1"><span>Episode 1 Moved</span></a></td></tr>
		</table></body></html>`;

		const episodes = await wcoTheme.episodes(
			url,
			contextFor({ [url]: markup }, { episodeListSelector: 'table#eps tr' })
		);

		expect(episodes).toEqual([
			{
				number: 1,
				sourceEpisodeId: 'https://example.invalid/watch/moved-1',
				title: 'Episode 1: Moved'
			}
		]);
	});

	it('takes an overridden title pattern', async () => {
		const url = 'https://example.invalid/series/show';
		const episodes = await wcoTheme.episodes(
			url,
			contextFor({ [url]: SERIES_PAGE }, { episodeTitleRegex: '()()(\\d+)\\s+(.*)' })
		);

		expect(episodes.map((episode) => episode.title)).toEqual([
			'Episode 1: Beginnings',
			'Episode 2: Second Steps',
			'Episode 2: Episode 3 Later',
			'Episode 1: Dub Version'
		]);
	});

	it('falls back to the template pattern when an override will not compile', async () => {
		const url = 'https://example.invalid/series/show';
		const episodes = await wcoTheme.episodes(
			url,
			contextFor({ [url]: SERIES_PAGE }, { episodeTitleRegex: '(unclosed' })
		);

		expect(episodes[0].title).toBe('Episode 1: Beginnings');
	});

	it('refuses to fetch anything for an empty id', async () => {
		const log: Recorded[] = [];
		expect(await wcoTheme.episodes('   ', contextFor({}, {}, log))).toEqual([]);
		expect(log).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------
 * streams
 * ---------------------------------------------------------------------- */

describe('streams', () => {
	const EPISODE_URL = 'https://example.invalid/watch/show-episode-1';

	it('returns the embed urls the page exposes, and stops there', async () => {
		const streams = await wcoTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: EPISODE_PAGE })
		);

		expect(streams).toEqual([
			{
				url: 'https://example.invalid/embed/one?pid=abc',
				container: 'mp4',
				label: 'Server 1',
				headers: { Referer: 'https://example.invalid/' }
			},
			{
				url: 'https://frames.example.invalid/two/index.m3u8',
				container: 'hls',
				label: 'Server 2',
				headers: { Referer: 'https://example.invalid/' }
			}
		]);
	});

	it('reconstructs the older player from its base64 array and shift', async () => {
		const page = oldPlayerPage('<iframe src="/embed/reconstructed"></iframe>', 37);

		const streams = await wcoTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: page }, { useOldIframeExtractor: 'true' })
		);

		expect(streams.map((stream) => stream.url)).toEqual([
			'https://example.invalid/embed/reconstructed'
		]);
	});

	it('does not run the old extractor unless the extension asked for it', async () => {
		const page = oldPlayerPage('<iframe src="/embed/reconstructed"></iframe>', 37);
		expect(await wcoTheme.streams(EPISODE_URL, contextFor({ [EPISODE_URL]: page }))).toEqual([]);
	});

	it('finds nothing when the old player script is not there', async () => {
		const streams = await wcoTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: EPISODE_PAGE }, { useOldIframeExtractor: 'true' })
		);
		expect(streams).toEqual([]);
	});

	it('finds nothing rather than throwing on a page with no player at all', async () => {
		expect(await wcoTheme.streams(EPISODE_URL, contextFor({ [EPISODE_URL]: EMPTY_PAGE }))).toEqual(
			[]
		);
	});

	it('finds nothing when the old player script is unreadable', async () => {
		const broken = `<html><body><script>
			var terms = ["not base64 at all", "@@@@"];
			var out = decodeURIComponent(terms.join("") - 4);
		</script></body></html>`;

		const streams = await wcoTheme.streams(
			EPISODE_URL,
			contextFor({ [EPISODE_URL]: broken }, { useOldIframeExtractor: 'true' })
		);
		expect(streams).toEqual([]);
	});
});
