/**
 * A stream-listing template: a poster grid, a numbered episode list, and a
 * mirror picker that hands out one embed URL per entry.
 *
 * It is the second-largest template group in the catalogue measured by
 * `FOREIGN.md` §4.1 — around twenty extensions share this page shape because
 * they run the same off-the-shelf theme. Everything site-specific about them is
 * a base URL and a handful of selector constants, which is exactly what
 * `ThemeConfig` carries, so the shape can be implemented once here and named
 * nowhere.
 *
 * ## What is deliberately not here
 *
 * - **Filters.** The template fetches its own filter lists off the listing page
 *   and builds a query string from them. The host renders filters itself
 *   (`ABI.md` §6), so the filter fetch is dropped; the listing page it fetched
 *   is the same page `search()` reads for the no-query case, so nothing the
 *   catalogue needs is lost with it.
 * - **Quality preferences and mirror sorting.** Settings are the host's job,
 *   and the template's sort is a substring test against a preference value.
 * - **Per-host extractors.** The template's own `getVideoList` returns nothing
 *   and leaves extraction to the extension. `FOREIGN.md` §4.1.3 forbids porting
 *   those here, so `streams()` stops at the embed URL the page exposed and lets
 *   a later stage decide what it is.
 * - **Details.** `Theme` has no details method; the description, genre and
 *   status selectors the template declares have nothing to feed.
 * - **Episode scanlator and air date.** `ThemeEpisode` carries neither.
 *
 * Nothing below names a site, a CDN or an extractor. Rule 9.
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

/* ── the template's own defaults ──────────────────────────────────────────── */

/** Relative to the base URL, and overridable as a whole URL. */
const DEFAULT_LIST_PATH = 'anime';
const DEFAULT_ITEM_SELECTOR = 'div.listupd article a.tip';
const DEFAULT_NEXT_SELECTOR = 'div.pagination a.next, div.hpage > a.r';
const DEFAULT_EPISODE_SELECTOR = 'div.eplister > ul > li > a';
const DEFAULT_VIDEO_SELECTOR = 'select.mirror > option[data-index], ul.mirror a[data-em]';
const DEFAULT_IFRAME_SELECTOR = 'iframe[src~=.]';
const DEFAULT_EPISODE_PREFIX = 'Episode';

/** Written into the item markup rather than exposed as an overridable member. */
const ITEM_TITLE_SELECTOR = 'div.tt, div.ttl';
const EPISODE_NUMBER_SELECTOR = '.epl-num';
/** The fallback the template uses when a mirror page carries no iframe. */
const EMBED_META_SELECTOR = 'meta[content~=.][itemprop=embedUrl]';

/**
 * How many mirrors one episode page is read for.
 *
 * The template reads every one of them, in parallel, and some of them cost a
 * request each. A page is untrusted input, so the count it declares is an input
 * too: a bound here is the difference between a slow episode and a page that
 * can spend a plugin's whole network budget.
 */
const MAX_MIRRORS = 32;

/* ── small helpers ────────────────────────────────────────────────────────── */

/**
 * `select` over a selector that may have come out of a config file.
 *
 * The selector engine throws on a selector it cannot parse, and a theme that
 * throws turns a bad override into a crash somewhere far away. Returning
 * nothing makes it a smoke-test refusal instead, which is what §6 of
 * `FOREIGN.md` wants to see.
 */
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

/** A parsed page, or null when the host refused the request or it failed. */
async function fetchDocument(ctx: ThemeContext, url: string): Promise<KDocument | null> {
	if (url.length === 0) return null;
	try {
		return ctx.parse(await ctx.http.text(url), url);
	} catch {
		return null;
	}
}

/**
 * The template's image-url reader: whichever lazy-loading attribute this build
 * of the theme happens to use, with the resize parameter trimmed off.
 */
function imageUrl(element: KElement | null): string | undefined {
	if (element === null) return undefined;
	let value: string;
	if (element.hasAttr('data-src')) {
		value = element.attr('abs:data-src');
	} else if (element.hasAttr('data-lazy-src')) {
		value = element.attr('abs:data-lazy-src');
	} else if (element.hasAttr('srcset')) {
		value = element.attr('abs:srcset').split(' ')[0];
	} else {
		value = element.attr('abs:src');
	}
	const cut = value.indexOf('?resize');
	const trimmed = (cut < 0 ? value : value.slice(0, cut)).trim();
	return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * The template's url-from-attribute reader, kept because scraped markup writes
 * a scheme-relative URL as often as an absolute one.
 */
function safeUrl(ctx: ThemeContext, element: KElement, attribute: string): string {
	const value = element.attr(attribute).trim();
	if (value.length === 0) return '';
	if (value.slice(0, 4).toLowerCase() === 'http') return value;
	if (value.slice(0, 2) === '//') return `https:${value}`;
	const resolved = element.attr(`abs:${attribute}`);
	return resolved.length > 0 ? resolved : absolute(ctx, value);
}

/** Trailing slashes removed, so a list URL and a query join with one of them. */
function trimSlashes(url: string): string {
	return url.replace(/\/+$/, '');
}

/**
 * What a URL says it is.
 *
 * An embed URL is a page, not a manifest, so this is nearly always the fallback
 * — which is correct: what a mirror really serves is settled downstream, and
 * guessing harder here would only be guessing more confidently.
 */
function containerOf(url: string): 'hls' | 'mp4' | 'dash' {
	const path = url.split('?')[0].split('#')[0].toLowerCase();
	if (/\.m3u8?$/.test(path)) return 'hls';
	if (/\.mpd$/.test(path)) return 'dash';
	return 'mp4';
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value.trim());
}

/* ── the three methods ────────────────────────────────────────────────────── */

function listUrl(ctx: ThemeContext): string {
	return trimSlashes(absolute(ctx, setting(ctx, 'animeListUrl', DEFAULT_LIST_PATH)));
}

function entryFrom(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const href = safeUrl(ctx, element, 'href');
	if (href.length === 0) return null;

	// The template dereferences this without checking. An item with no title is
	// an item nobody could pick out of a grid, so it is dropped rather than
	// taking the rest of the page down with it.
	const titleElement = selectOne(element, ITEM_TITLE_SELECTOR);
	const title = titleElement === null ? '' : titleElement.ownText().trim();
	if (title.length === 0) return null;

	return {
		sourceMediaId: href,
		title,
		posterImageUrl: imageUrl(selectOne(element, 'img'))
	};
}

async function search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage> {
	const text = query.trim();
	const wanted = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;

	// With a query the template searches; without one it asks the listing page
	// for the popular ordering, which is the same request its filter fetch made.
	const url =
		text.length > 0
			? absolute(ctx, `page/${wanted}/?s=${encodeURIComponent(text)}`)
			: `${listUrl(ctx)}/?page=${wanted}&order=popular`;

	const document = await fetchDocument(ctx, url);
	if (document === null) return { entries: [], hasMore: false };

	const itemSelector =
		text.length > 0
			? setting(ctx, 'searchAnimeSelector', DEFAULT_ITEM_SELECTOR)
			: setting(
					ctx,
					'popularAnimeSelector',
					setting(ctx, 'searchAnimeSelector', DEFAULT_ITEM_SELECTOR)
				);
	const nextSelector =
		text.length > 0
			? setting(ctx, 'searchAnimeNextPageSelector', DEFAULT_NEXT_SELECTOR)
			: setting(
					ctx,
					'popularAnimeNextPageSelector',
					setting(ctx, 'searchAnimeNextPageSelector', DEFAULT_NEXT_SELECTOR)
				);

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
	const document = await fetchDocument(ctx, absolute(ctx, sourceMediaId));
	if (document === null) return [];

	const prefix = setting(ctx, 'episodePrefix', DEFAULT_EPISODE_PREFIX);
	const found: ThemeEpisode[] = [];

	for (const element of selectAll(
		document,
		setting(ctx, 'episodeListSelector', DEFAULT_EPISODE_SELECTOR)
	)) {
		const href = safeUrl(ctx, element, 'href');
		if (href.length === 0) continue;

		// The template requires the number cell and dereferences it. It is also
		// the only thing that distinguishes one row from another, so a row
		// without one is skipped.
		const numberElement = selectOne(element, EPISODE_NUMBER_SELECTOR);
		if (numberElement === null) continue;
		const label = numberElement.text().trim();

		// `12 END` is episode 12; anything unparseable is zero, as upstream.
		const parsed = Number.parseFloat(label.split(' ')[0]);
		found.push({
			number: Number.isFinite(parsed) ? parsed : 0,
			sourceEpisodeId: href,
			title: `${prefix} ${label}`.trim()
		});
	}

	return found;
}

/**
 * One mirror entry to the embed URL behind it.
 *
 * A mirror carries either a base64 document or a URL to fetch one from, and
 * either way the document holds an iframe or an embed-url meta tag. That is
 * where this stops: what the embed *is* belongs to a per-host extractor, and
 * per `FOREIGN.md` §4.1.3 those do not live in this repository.
 */
async function hosterUrl(ctx: ThemeContext, element: KElement): Promise<string> {
	const tag = element.tagName.toLowerCase();
	const encoded =
		tag === 'option' ? element.attr('value') : tag === 'a' ? element.attr('data-em') : '';
	if (encoded.trim().length === 0) return '';

	const document = isHttpUrl(encoded)
		? await fetchDocument(ctx, encoded.trim())
		: ctx.parse(base64Decode(encoded.trim()), ctx.config.baseUrl);
	if (document === null) return '';

	const frame = selectOne(
		document,
		setting(ctx, 'getEpisodeIframeSelector', DEFAULT_IFRAME_SELECTOR)
	);
	if (frame !== null) {
		const url = safeUrl(ctx, frame, 'src');
		if (url.length > 0) return url;
	}

	const meta = selectOne(document, EMBED_META_SELECTOR);
	return meta === null ? '' : safeUrl(ctx, meta, 'content');
}

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
		const label = element.text().trim();
		let url: string;
		try {
			url = await hosterUrl(ctx, element);
		} catch {
			url = '';
		}
		if (url.length === 0 || seen.has(url)) continue;
		seen.add(url);
		found.push({
			url,
			container: containerOf(url),
			label: label.length > 0 ? label : `Mirror ${found.length + 1}`
		});
	}

	return found;
}

export const animeStreamTheme: Theme = {
	id: 'animestream',
	settings: [
		'animeListUrl',
		'popularAnimeSelector',
		'popularAnimeNextPageSelector',
		'searchAnimeSelector',
		'searchAnimeNextPageSelector',
		'episodeListSelector',
		'episodePrefix',
		'videoListSelector',
		'getEpisodeIframeSelector'
	],
	search,
	episodes,
	streams
};

registerTheme(animeStreamTheme);
