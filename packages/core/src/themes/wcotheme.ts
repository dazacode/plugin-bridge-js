/**
 * A template whose pages are one long sidebar of grids, and whose player is an
 * iframe it sometimes spells out one character at a time.
 *
 * ## What this template is
 *
 * Six extensions in the adapted catalogue are generated from it. The shape is:
 *
 * - a **home page** carrying three separate card grids — a sidebar list, a
 *   "recent releases" strip and a "recently added" strip — all built out of the
 *   same `ul.items > li` card;
 * - a **series page** carrying an episode list, in any of three markups the
 *   template's default selector unions together;
 * - an **episode page** whose player is an `<iframe>`, either written into the
 *   markup directly or assembled at runtime from a base64 array and a numeric
 *   shift.
 *
 * Every one of those is a page *layout*. None of it names a site, and the base
 * URL and every selector arrive in `ThemeConfig` — which is what makes this
 * ordinary machinery rather than a bundled source (`FOREIGN.md` §4.1.3, and
 * `AGENTS.md` rule 9).
 *
 * ## What deliberately did not come across
 *
 * The Kotlin's `iframeParse` is a per-host stream extractor: it is made of two
 * hostname tests, a vendor-specific handshake and a vendor-specific JSON shape.
 * §4.1.3 forbids porting that here in as many words, so `streams()` stops at
 * the embed URL the page exposes and hands it back. Resolving an embed to a
 * manifest is a plugin's job, not a template's.
 *
 * The *old* extractor is a different case and it is ported in full: a base64
 * array plus a per-document numeric shift is a generic obfuscation, of exactly
 * the kind §4.1.3 lists as host-free and shippable. It reconstructs markup, and
 * the markup contains an iframe; nothing in it knows where that iframe points.
 *
 * ## Searching, and browsing, which are two different requests
 *
 * A query is a **form POST** to a search endpoint, and the response is a
 * sidebar list rather than a grid — a different selector, which is why the
 * template declares both. An empty query is the home page instead, and there
 * the interface's one listing surface stands in for three: the Kotlin's
 * popular list and its two "latest" strips are all grids on that same page, and
 * a browse that returned only the first would be showing a third of what the
 * page has. Neither request paginates — both of the template's next-page
 * selectors are `null` — so page two is empty rather than a second copy of
 * page one.
 */

import { base64Decode } from '../extract/patterns';
import type { KDocument, KElement } from '@plugin-bridge/runtime/shims/dom';

import {
	absolute,
	registerTheme,
	setting,
	type Theme,
	type ThemeCatalogEntry,
	type ThemeContext,
	type ThemeEpisode,
	type ThemePage,
	type ThemeStream
} from './engine';

/* -------------------------------------------------------------------------
 * The template's own defaults
 *
 * Keyed by the Kotlin member name they came from, because that is the name an
 * extension's override is recovered under. Renaming one here would not fail —
 * it would silently ignore the override, which is worse.
 * ---------------------------------------------------------------------- */

const DEFAULT_POPULAR_SELECTOR = 'div#sidebar_right2 ul.items > li';
const DEFAULT_SEARCH_SELECTOR = 'div#sidebar_right2 li';
const DEFAULT_LATEST_SELECTOR = 'div.recent-release:contains(Recent Releases) + div > ul > li';
const DEFAULT_LATEST_NEXT_SELECTOR = 'div.recent-release:contains(Recently Added) + div > ul > li';
const DEFAULT_EPISODE_LIST_SELECTOR =
	'div.cat-eps, div#episodeList a.dark-episode-item, nav#sidebarEpisodeList a.sidebar-episode-item';
const DEFAULT_EPISODE_TITLE_REGEX = '(Season (\\d+) )?Episode (\\d+) (.*)';
const DEFAULT_USE_OLD_IFRAME_EXTRACTOR = 'false';

/**
 * Where a card's clickable title lives, in preference order.
 *
 * Not a setting: the Kotlin holds these inside a method body rather than
 * exposing them as an overridable member, so there is no override for a
 * converter to recover and declaring a key for them would invent one.
 */
const CARD_TITLE_SELECTOR = '.recent-release-episodes a, .img a';

/** The heading an episode page falls back to when it lists no episodes. */
const PAGE_TITLE_SELECTOR = '.video-title';

/**
 * The search endpoint and its two form fields.
 *
 * Path fragments and parameter names, not a host — the same category of thing
 * as a selector, and hard-coded in the Kotlin for the same reason: they are
 * part of the template rather than part of any one site. `konuara` names the
 * kind of record being searched for and is fixed by the template.
 */
const SEARCH_PATH = 'search';
const SEARCH_QUERY_FIELD = 'catara';
const SEARCH_KIND_FIELD = 'konuara';
const SEARCH_KIND_VALUE = 'series';

const EMPTY_PAGE: ThemePage = { entries: [], hasMore: false };

/* -------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------- */

/**
 * `select`, but a malformed override is an empty result rather than a throw.
 *
 * The selector engine rejects a selector it cannot parse, and the selectors
 * here are partly user-supplied config. A bad one has to degrade into "found
 * nothing" — which the install-time smoke test (`FOREIGN.md` §6) turns into a
 * refusal naming the step — instead of an exception from three frames down.
 */
function safeSelect(root: KElement, selector: string): KElement[] {
	try {
		return root.select(selector);
	} catch {
		return [];
	}
}

function safeSelectFirst(root: KElement, selector: string): KElement | null {
	try {
		return root.selectFirst(selector);
	} catch {
		return null;
	}
}

/** The site's home page: the base url, with exactly one trailing slash. */
function homeUrl(ctx: ThemeContext): string {
	return absolute(ctx, './');
}

/**
 * The headers the Kotlin's `headersBuilder` puts on every request.
 *
 * Derived from the configured base url, so this names no host of its own. The
 * user agent the Kotlin also sets is left to the host: it is the host that
 * knows what it is willing to claim to be.
 */
function pageHeaders(ctx: ThemeContext): Record<string, string> {
	return { Referer: homeUrl(ctx) };
}

async function loadDocument(ctx: ThemeContext, url: string): Promise<KDocument> {
	const html = await ctx.http.text(url, { headers: pageHeaders(ctx) });
	return ctx.parse(html, url);
}

/** The search request: a form POST, which is the only shape this endpoint takes. */
async function postSearch(ctx: ThemeContext, url: string, query: string): Promise<KDocument> {
	const body =
		`${SEARCH_QUERY_FIELD}=${encodeURIComponent(query)}` +
		`&${SEARCH_KIND_FIELD}=${encodeURIComponent(SEARCH_KIND_VALUE)}`;
	const html = await ctx.http.text(url, {
		method: 'POST',
		headers: {
			...pageHeaders(ctx),
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body
	});
	return ctx.parse(html, url);
}

/**
 * A container guess for a URL that is usually not a media URL at all.
 *
 * `ThemeStream` has three containers and an embed page is none of them, so the
 * extension decides where it can and `mp4` is the answer where it cannot. The
 * plugin that resolves the embed replaces this with the truth.
 */
function containerOf(url: string): ThemeStream['container'] {
	const path = url.split('#')[0].split('?')[0].toLowerCase();
	if (path.endsWith('.m3u8')) return 'hls';
	if (path.endsWith('.mpd')) return 'dash';
	return 'mp4';
}

function toInt(value: string): number | null {
	if (!/^-?\d+$/.test(value.trim())) return null;
	const parsed = parseInt(value.trim(), 10);
	return Number.isFinite(parsed) ? parsed : null;
}

/** A regular expression from config, or the template's own when it will not compile. */
function compileTitleRegex(source: string): RegExp | null {
	try {
		return new RegExp(source);
	} catch {
		try {
			return new RegExp(DEFAULT_EPISODE_TITLE_REGEX);
		} catch {
			return null;
		}
	}
}

/* -------------------------------------------------------------------------
 * Cards
 * ---------------------------------------------------------------------- */

/**
 * One grid card, as a catalogue entry.
 *
 * The Kotlin prefers the anchor's *own* text so that a trailing badge span —
 * a dub marker, a quality marker — does not end up inside the title, then
 * falls back to the poster's `alt` and finally to the whole card's text.
 */
function cardToEntry(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const anchor = safeSelectFirst(element, CARD_TITLE_SELECTOR) ?? safeSelectFirst(element, 'a');
	if (anchor === null) return null;

	const sourceMediaId = absolute(ctx, anchor.attr('href'));
	if (sourceMediaId === '') return null;

	let title = anchor.ownText().trim();
	if (title === '') title = (safeSelectFirst(element, 'img[alt]')?.attr('alt') ?? '').trim();
	if (title === '') title = element.text().trim();
	if (title === '') return null;

	const poster = safeSelectFirst(element, 'img[src]')?.attr('abs:src') ?? '';
	const posterImageUrl = poster === '' ? '' : absolute(ctx, poster);

	return posterImageUrl === ''
		? { sourceMediaId, title }
		: { sourceMediaId, title, posterImageUrl };
}

/* -------------------------------------------------------------------------
 * Episodes
 * ---------------------------------------------------------------------- */

interface ParsedEpisodeTitle {
	readonly name: string;
	readonly number: number;
}

/**
 * A season/episode title, as a display name and a sortable number.
 *
 * A season is worth 100 episodes, which is the Kotlin's arithmetic and the
 * reason a season-two episode never collides with a season-one one. A title
 * the pattern does not match keeps its own text and sorts as episode 1.
 */
function parseEpisodeTitle(title: string, pattern: RegExp | null): ParsedEpisodeTitle {
	const match = pattern === null ? null : pattern.exec(title);
	if (match === null) return { name: title, number: 1 };

	const seasonNumber = toInt(match[2] ?? '');
	const episodeNumber = toInt(match[3] ?? '');
	const rest = (match[4] ?? '').trim();

	let name = '';
	if (seasonNumber !== null) name += `Season ${seasonNumber} - `;
	if (episodeNumber !== null) name += `Episode ${episodeNumber}: `;
	name += rest;

	return {
		name: name.trim() === '' ? title : name,
		number: ((seasonNumber ?? 1) - 1) * 100 + (episodeNumber ?? 1)
	};
}

interface DraftEpisode extends ThemeEpisode {
	/** Dubbed entries sort after subbed ones, which is the template's ordering. */
	readonly dubbed: boolean;
}

/**
 * One episode row.
 *
 * The row is either the anchor itself — two of the three markups the default
 * selector unions are anchors — or a block wrapping one. Its label is the
 * anchor's `<span>` where there is one, because these markups put the title in
 * a span and the episode number in a sibling.
 */
function rowToEpisode(
	ctx: ThemeContext,
	element: KElement,
	pattern: RegExp | null
): DraftEpisode | null {
	const anchor = element.tagName.toLowerCase() === 'a' ? element : safeSelectFirst(element, 'a');
	if (anchor === null) return null;

	const sourceEpisodeId = absolute(ctx, anchor.attr('href'));
	if (sourceEpisodeId === '') return null;

	const label = safeSelectFirst(anchor, 'span')?.text() ?? element.text();
	const parsed = parseEpisodeTitle(label.trim(), pattern);

	return {
		number: parsed.number,
		sourceEpisodeId,
		title: parsed.name,
		dubbed: /dub/i.test(parsed.name)
	};
}

/* -------------------------------------------------------------------------
 * The two iframe extractors
 * ---------------------------------------------------------------------- */

function iframeLinks(ctx: ThemeContext, document: KDocument): string[] {
	const links: string[] = [];
	for (const frame of safeSelect(document, 'iframe')) {
		const source = frame.attr('abs:src').trim();
		if (source === '') continue;
		links.push(absolute(ctx, source));
	}
	return links;
}

/** The text between the first `[` and the `]` that follows it. */
function bracketedList(script: string): string | null {
	const open = script.indexOf('[');
	if (open < 0) return null;
	const close = script.indexOf(']', open + 1);
	if (close < 0) return null;
	return script.slice(open + 1, close);
}

/**
 * The older player, which spells its iframe out one character at a time.
 *
 * A base64 array, a shift written into the same script, and one character per
 * entry: decode, keep the digits, subtract the shift, and the code points spell
 * markup. This is a generic obfuscation — base64 and an integer offset — and
 * carries no knowledge of any host, which is why `FOREIGN.md` §4.1.3 lets it
 * ship here while it refuses the extractor further down the same file.
 *
 * Every failure is `[]`. There is no input that makes this throw.
 */
function oldIframeLinks(ctx: ThemeContext, document: KDocument): string[] {
	for (const element of safeSelect(document, 'script')) {
		const script = element.html();
		if (script.indexOf('decodeURIComponent') < 0) continue;

		const body = bracketedList(script);
		if (body === null) continue;

		let parts: unknown;
		try {
			parts = JSON.parse(`[${body.trim().replace(/,$/, '')}]`);
		} catch {
			continue;
		}
		if (!Array.isArray(parts) || parts.length === 0) continue;

		const shift = toInt(script.slice(script.lastIndexOf('- ') + 2).split(');')[0] ?? '');
		if (shift === null) continue;

		let markup = '';
		let readable = true;
		for (const part of parts) {
			if (typeof part !== 'string') {
				readable = false;
				break;
			}
			const digits = base64Decode(part).replace(/\D/g, '');
			const code = toInt(digits);
			if (code === null) {
				readable = false;
				break;
			}
			const point = code - shift;
			if (point < 0 || point > 0x10ffff) {
				readable = false;
				break;
			}
			markup += String.fromCharCode(point);
		}
		if (!readable || markup === '') continue;

		const source = safeSelectFirst(ctx.parse(markup, homeUrl(ctx)), 'iframe')?.attr('src') ?? '';
		if (source.trim() === '') continue;
		return [absolute(ctx, source)];
	}
	return [];
}

/* -------------------------------------------------------------------------
 * The theme
 * ---------------------------------------------------------------------- */

export const wcoTheme: Theme = {
	id: 'wcotheme',

	settings: [
		'popularAnimeSelector',
		'searchAnimeSelector',
		'latestUpdatesSelector',
		'latestUpdatesNextPageSelector',
		'episodeListSelector',
		'episodeTitleRegex',
		'useOldIframeExtractor'
	],

	/**
	 * A query, POSTed to the search endpoint; or the whole home page when there
	 * is none.
	 *
	 * `page > 1` is empty because the template has no pagination at all: both
	 * of its next-page selectors are `null` in the Kotlin, and a second request
	 * would return the same page again.
	 */
	async search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage> {
		if (page > 1) return EMPTY_PAGE;

		const trimmed = query.trim();
		let cards: KElement[];

		if (trimmed === '') {
			const document = await loadDocument(ctx, homeUrl(ctx));
			// Every grid the home page carries, in the Kotlin's own order:
			// the sidebar list first, then the two release strips.
			cards = [];
			for (const grid of [
				setting(ctx, 'popularAnimeSelector', DEFAULT_POPULAR_SELECTOR),
				setting(ctx, 'latestUpdatesSelector', DEFAULT_LATEST_SELECTOR),
				setting(ctx, 'latestUpdatesNextPageSelector', DEFAULT_LATEST_NEXT_SELECTOR)
			]) {
				cards = cards.concat(safeSelect(document, grid));
			}
		} else {
			const document = await postSearch(ctx, absolute(ctx, SEARCH_PATH), trimmed);
			cards = safeSelect(document, setting(ctx, 'searchAnimeSelector', DEFAULT_SEARCH_SELECTOR));
		}

		const seen = new Set<string>();
		const entries: ThemeCatalogEntry[] = [];

		for (const card of cards) {
			const entry = cardToEntry(ctx, card);
			if (entry === null || seen.has(entry.sourceMediaId)) continue;
			seen.add(entry.sourceMediaId);
			entries.push(entry);
		}

		return { entries, hasMore: false };
	},

	/**
	 * Every episode on a series page, subbed before dubbed.
	 *
	 * The Kotlin renumbers the sorted list `size - index` so that its client
	 * displays it in that order; the number that survives here is the one
	 * parsed out of the title, because a stored episode number that means
	 * "third from the bottom of the page as it looked on Tuesday" is not a
	 * number the host can key anything on. The *order* is the Kotlin's.
	 *
	 * A page with no episode list but a video heading is a single-episode
	 * entry — a film — and yields one episode pointing at itself. A page with
	 * neither yields nothing, which is the outcome a markup change has to
	 * produce.
	 */
	async episodes(sourceMediaId: string, ctx: ThemeContext): Promise<readonly ThemeEpisode[]> {
		const url = absolute(ctx, sourceMediaId);
		if (url === '') return [];

		const document = await loadDocument(ctx, url);
		const pattern = compileTitleRegex(
			setting(ctx, 'episodeTitleRegex', DEFAULT_EPISODE_TITLE_REGEX)
		);

		const drafts: DraftEpisode[] = [];
		for (const row of safeSelect(
			document,
			setting(ctx, 'episodeListSelector', DEFAULT_EPISODE_LIST_SELECTOR)
		)) {
			const episode = rowToEpisode(ctx, row, pattern);
			if (episode !== null) drafts.push(episode);
		}

		if (drafts.length === 0) {
			const heading = safeSelect(document, PAGE_TITLE_SELECTOR)
				.map((element) => element.text())
				.join(' ')
				.trim();
			if (heading === '') return [];
			const parsed = parseEpisodeTitle(heading, pattern);
			return [{ number: parsed.number, sourceEpisodeId: url, title: parsed.name }];
		}

		drafts.sort((left, right) => {
			const byDub = (left.dubbed ? 1 : 0) - (right.dubbed ? 1 : 0);
			return byDub !== 0 ? byDub : left.number - right.number;
		});

		return drafts.map((draft) => ({
			number: draft.number,
			sourceEpisodeId: draft.sourceEpisodeId,
			title: draft.title
		}));
	},

	/**
	 * The embed urls an episode page exposes, and no further.
	 *
	 * Turning one of these into a manifest means knowing the host it points
	 * at, and a template that knew that would be a content source in this
	 * repository. `FOREIGN.md` §4.1.3 draws the line here on purpose.
	 */
	async streams(sourceEpisodeId: string, ctx: ThemeContext): Promise<readonly ThemeStream[]> {
		const url = absolute(ctx, sourceEpisodeId);
		if (url === '') return [];

		const document = await loadDocument(ctx, url);
		const useOld =
			setting(ctx, 'useOldIframeExtractor', DEFAULT_USE_OLD_IFRAME_EXTRACTOR)
				.trim()
				.toLowerCase() === 'true';

		const links = useOld ? oldIframeLinks(ctx, document) : iframeLinks(ctx, document);

		const seen = new Set<string>();
		const streams: ThemeStream[] = [];
		for (const link of links) {
			if (link === '' || seen.has(link)) continue;
			seen.add(link);
			streams.push({
				url: link,
				container: containerOf(link),
				label: `Server ${streams.length + 1}`,
				headers: { Referer: homeUrl(ctx) }
			});
		}
		return streams;
	}
};

registerTheme(wcoTheme);
