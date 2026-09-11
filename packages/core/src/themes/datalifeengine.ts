/**
 * A general-purpose CMS's listing shape, as two extensions in the catalogue use
 * it: a content column of card divs, a numbered pager beside it, and a search
 * endpoint the CMS ships rather than the site.
 *
 * This is the smallest template of the group — the upstream class is barely two
 * hundred lines and most of them are preferences and filters. What it actually
 * defines is the catalogue: the card selector, the pager selector, and how a
 * card becomes a title, a poster and a link. Everything below is that.
 *
 * ## What the template does not define, and what that costs
 *
 * The upstream class leaves the episode list and the mirror list abstract: each
 * extension supplies its own selectors for them, because this CMS's themes do
 * not agree on how a player page is laid out. There is therefore no honest
 * default for `episodeListSelector`, and it is left empty — an extension that
 * supplies one gets episodes, and one that does not finds nothing, which the
 * install-time smoke test turns into a refusal rather than an empty screen.
 * `videoListSelector` does get a default, because an embedded player in a frame
 * is a property of embedding rather than of any site. The note on the exported
 * theme at the bottom of this file says what that costs in practice, and it is
 * more than it looks.
 *
 * ## The search request is a form post
 *
 * Text search here is not a URL the CMS answers to, it is a form: the endpoint
 * takes `do`, `subaction` and `story` in a `application/x-www-form-urlencoded`
 * body, and page two onwards adds the paging triple. `ThemeContext.http` carries
 * a method and a body, so that is sent as written rather than folded into a
 * query string — a GET that happens to work on some installs of a CMS is not the
 * same request, and the difference would surface as a template that searches
 * fine against one site and returns an empty page against the next.
 *
 * Filters, quality and server preferences are the host's (`ABI.md` §6), and the
 * details page has no method on `Theme` to feed. Nothing here names a site.
 * Rule 9.
 */

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

/* ── the template's own defaults ──────────────────────────────────────────── */

const DEFAULT_ITEM_SELECTOR = 'div#dle-content > div.mov';
const DEFAULT_NEXT_SELECTOR = 'span.navigation > span:not(.nav_ext) + a';
/** The template declares none; see this file's header. */
const DEFAULT_EPISODE_SELECTOR = '';
const DEFAULT_VIDEO_SELECTOR = 'iframe[src]';

/** Written into the card markup rather than exposed as an overridable member. */
const CARD_LINK_SELECTOR = 'a[href]';
const CARD_IMAGE_SELECTOR = 'img[src]';
const CARD_BADGE_SELECTOR = 'span.block-sai';

/**
 * The CMS refuses a shorter query itself, with a message about the search being
 * suspended. Upstream raises that as an error; a theme returns nothing instead,
 * because a refusal is the host's sentence to write and not a template's.
 */
const MIN_QUERY_LENGTH = 4;

/** Bounds an untrusted page's idea of how many players it has. */
const MAX_MIRRORS = 32;

/* ── small helpers ────────────────────────────────────────────────────────── */

/** `select`, with a selector that came out of a config file treated as input. */
function selectAll(root: KElement, selector: string): KElement[] {
	if (selector.trim().length === 0) return [];
	try {
		return root.select(selector);
	} catch {
		return [];
	}
}

function selectOne(root: KElement, selector: string): KElement | null {
	if (selector.trim().length === 0) return null;
	try {
		return root.selectFirst(selector);
	} catch {
		return null;
	}
}

/** One request, parsed. Null when the host refused it or it failed. */
async function fetchDocument(
	ctx: ThemeContext,
	url: string,
	request?: {
		headers?: Record<string, string>;
		method?: 'GET' | 'POST';
		body?: string;
	}
): Promise<KDocument | null> {
	if (url.length === 0) return null;
	try {
		return ctx.parse(await ctx.http.text(url, request), url);
	} catch {
		return null;
	}
}

/** The first attribute of the given ones that carries something. */
function firstUrl(ctx: ThemeContext, element: KElement, attributes: readonly string[]): string {
	for (const attribute of attributes) {
		const absolutely = element.attr(`abs:${attribute}`).trim();
		if (absolutely.length > 0) return absolutely;
		const raw = element.attr(attribute).trim();
		if (raw.length > 0) return absolute(ctx, raw);
	}
	return '';
}

function containerOf(url: string): 'hls' | 'mp4' | 'dash' {
	const path = url.split('?')[0].split('#')[0].toLowerCase();
	if (/\.m3u8?$/.test(path)) return 'hls';
	if (/\.mpd$/.test(path)) return 'dash';
	return 'mp4';
}

/** The first number in a label, which is how an episode announces itself. */
function numberIn(text: string, fallback: number): number {
	const match = /\d+(?:\.\d+)?/.exec(text);
	if (match === null) return fallback;
	const parsed = Number.parseFloat(match[0]);
	return Number.isFinite(parsed) ? parsed : fallback;
}

/* ── the three methods ────────────────────────────────────────────────────── */

/**
 * The form post a text search is.
 *
 * Page one posts to the site root and later pages to the search endpoint with
 * the paging triple added, which is the split upstream makes. A space is `+`
 * and everything else is percent-encoded, because that is what a form encoding
 * puts on the wire; the body is built here rather than by the host, which is
 * what `body` being sent verbatim means.
 */
function searchRequest(
	ctx: ThemeContext,
	query: string,
	page: number
): {
	url: string;
	headers: Record<string, string>;
	method: 'POST';
	body: string;
} {
	const story = encodeURIComponent(query).replace(/%20/g, '+');
	const paging = page > 1 ? `&search_start=${page}&full_search=0&result_from=11` : '';
	const origin = absolute(ctx, '/');

	return {
		url: page > 1 ? absolute(ctx, 'index.php?do=search') : origin,
		method: 'POST',
		// The `Host` header upstream also sets belongs to the transport, and a
		// plugin does not get to choose it; the rest are the request's own.
		headers: {
			accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
			'content-type': 'application/x-www-form-urlencoded',
			origin: origin.replace(/\/+$/, ''),
			referer: origin
		},
		body: `do=search&subaction=search${paging}&story=${story}`
	};
}

function entryFrom(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const link = selectOne(element, CARD_LINK_SELECTOR);
	if (link === null) return null;

	const href = firstUrl(ctx, link, ['href']);
	if (href.length === 0) return null;

	const badge = selectOne(element, CARD_BADGE_SELECTOR);
	const title = `${link.text().trim()} ${badge === null ? '' : badge.text().trim()}`.trim();
	if (title.length === 0) return null;

	const image = selectOne(element, CARD_IMAGE_SELECTOR);
	const poster = image === null ? '' : firstUrl(ctx, image, ['src']);

	return {
		sourceMediaId: href,
		title,
		posterImageUrl: poster.length > 0 ? poster : undefined
	};
}

async function search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage> {
	const text = query.trim();
	const wanted = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
	if (text.length > 0 && text.length < MIN_QUERY_LENGTH) return { entries: [], hasMore: false };

	// A query is a form post; no query is the plain paginated listing, which is
	// the pagination shape the template's own filter branches build on.
	let document: KDocument | null;
	if (text.length > 0) {
		const request = searchRequest(ctx, text, wanted);
		document = await fetchDocument(ctx, request.url, {
			method: request.method,
			headers: request.headers,
			body: request.body
		});
	} else {
		document = await fetchDocument(ctx, absolute(ctx, `page/${wanted}/`));
	}

	if (document === null) return { entries: [], hasMore: false };

	// Upstream's search selectors are its popular selectors; an extension may
	// have overridden either name, so both are consulted in that order.
	const popularItem = setting(ctx, 'popularAnimeSelector', DEFAULT_ITEM_SELECTOR);
	const popularNext = setting(ctx, 'popularAnimeNextPageSelector', DEFAULT_NEXT_SELECTOR);
	const itemSelector =
		text.length > 0 ? setting(ctx, 'searchAnimeSelector', popularItem) : popularItem;
	const nextSelector =
		text.length > 0 ? setting(ctx, 'searchAnimeNextPageSelector', popularNext) : popularNext;

	const entries: ThemeCatalogEntry[] = [];
	for (const element of selectAll(document, itemSelector)) {
		const entry = entryFrom(ctx, element);
		if (entry !== null) entries.push(entry);
	}

	return {
		entries,
		hasMore: entries.length > 0 && selectOne(document, nextSelector) !== null
	};
}

async function episodes(
	sourceMediaId: string,
	ctx: ThemeContext
): Promise<readonly ThemeEpisode[]> {
	const selector = setting(ctx, 'episodeListSelector', DEFAULT_EPISODE_SELECTOR);
	if (selector.trim().length === 0) return [];

	const document = await fetchDocument(ctx, absolute(ctx, sourceMediaId));
	if (document === null) return [];

	const found: ThemeEpisode[] = [];
	for (const element of selectAll(document, selector)) {
		const link =
			element.tagName.toLowerCase() === 'a' ? element : selectOne(element, CARD_LINK_SELECTOR);
		if (link === null) continue;

		const href = firstUrl(ctx, link, ['href']);
		if (href.length === 0) continue;

		const label = link.text().trim();
		found.push({
			number: numberIn(label, found.length + 1),
			sourceEpisodeId: href,
			title: label.length > 0 ? label : undefined
		});
	}

	return found;
}

/**
 * The players an episode page embeds.
 *
 * As with every template here, this stops at the URL the page exposed: turning
 * an embed into a manifest is a per-host job and `FOREIGN.md` §4.1.3 keeps
 * those out of this repository entirely.
 */
async function streams(
	sourceEpisodeId: string,
	ctx: ThemeContext
): Promise<readonly ThemeStream[]> {
	const document = await fetchDocument(ctx, absolute(ctx, sourceEpisodeId));
	if (document === null) return [];

	const items = selectAll(document, setting(ctx, 'videoListSelector', DEFAULT_VIDEO_SELECTOR));
	const found: ThemeStream[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < items.length && i < MAX_MIRRORS; i++) {
		const element = items[i];
		const url = firstUrl(ctx, element, ['src', 'data-src', 'href']);
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);

		const label = element.text().trim() || element.attr('title').trim();
		found.push({
			url,
			container: containerOf(url),
			label: label.length > 0 ? label : `Mirror ${found.length + 1}`
		});
	}

	return found;
}

/**
 * Registered, correct, and — today — unreachable. Read this before trusting it.
 *
 * The template leaves the episode list and the mirror list **abstract**: every
 * extension built on it supplies its own, and it supplies them as
 * `override fun episodeListSelector() = "…"` rather than as a `val`. The Kotlin
 * reader declines every function body it meets (`kotlin/reader.ts`: a function
 * is named in `unreadableOverrides`, never resolved to a constant), and
 * `convert.ts` counts `episodeList*` and `videoList*` among the members our ABI
 * must have. So an extension that supplies those selectors is refused at match
 * time, and one that somehow did not would arrive here with no selector to use.
 * Either way this template converts nothing.
 *
 * That is not a reason to delete the implementation. It is the shape a
 * translator would target — the day the reader can read a single-expression
 * function, or an interpreter fills in for one, these selectors arrive as
 * overrides and the code below is what consumes them. It is a reason not to
 * count this template towards coverage, and not to read an empty episode list
 * from it as a site having changed its markup.
 */
export const dataLifeEngineTheme: Theme = {
	id: 'datalifeengine',
	settings: [
		'popularAnimeSelector',
		'popularAnimeNextPageSelector',
		'searchAnimeSelector',
		'searchAnimeNextPageSelector',
		'episodeListSelector',
		'videoListSelector'
	],
	search,
	episodes,
	streams
};

registerTheme(dataLifeEngineTheme);
