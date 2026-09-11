/**
 * A template that is almost entirely *not* a page shape, and what is left when
 * the part rule 9 forbids is taken out of it.
 *
 * ## What the Kotlin actually contains
 *
 * Three extensions are generated from this one, and reading the base class is
 * a surprise: it declares no card selector, no episode selector and no video
 * selector. Every one of those is left abstract for the extension to supply.
 * What the base class holds instead is
 *
 * 1. a dispatch table mapping seventeen video-host names onto seventeen
 *    per-host extractors,
 * 2. a URL-shaped regular expression and a `fetchUrls` helper that rakes URLs
 *    out of an inline script,
 * 3. a language tagger that turns a `0` / `1` / `2` — or a `lat` / `cast` /
 *    `sub` — into a `[LAT]`, `[CAST]` or `[SUB]` prefix,
 * 4. the fact that **search reuses the popular listing's selectors verbatim**,
 * 5. preference-driven server and quality sorting.
 *
 * (1) is precisely what `FOREIGN.md` §4.1.3 refuses: it is made of hostnames
 * and cannot be described without naming sites, so it is not here, in any
 * form — not the names, not the table, not a comment listing them. `streams()`
 * stops at the embed URL, which is what the interface asks for anyway. (5) is
 * the host's job (`ABI.md` §6). (2), (3) and (4) are host-free and are ported
 * faithfully below; (4) in particular is implemented as a real fallback chain,
 * so an extension that overrides only the popular selectors gets the search
 * behaviour the Kotlin gives it.
 *
 * ## The defaults, and why they are shaped the way they are
 *
 * Because the base class declares none, the defaults here cannot be "the
 * Kotlin's default" — there is no such thing to copy. They are instead written
 * to describe the *structure* every card grid of this kind has (a link
 * wrapping a poster) rather than any particular site's class names, and every
 * one of them is overridable under the Kotlin member name a converter would
 * recover the override as. An extension that supplies its own selectors never
 * sees these; an extension that does not gets a best-effort structural read,
 * and where that finds nothing the install-time smoke test (`FOREIGN.md` §6)
 * refuses rather than installing something silently blank.
 *
 * Three keys — `searchPath`, `searchQueryParam` and `pageQueryParam` — have no
 * counterpart in the base class at all, because the base class leaves the
 * whole search request to each extension. They are the URL shape, parameterised
 * so it can be supplied rather than hard-coded, which is the only way a
 * template is allowed to know a URL at all.
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
 * Defaults
 * ---------------------------------------------------------------------- */

/** A link wrapping a poster: what a card is, in every grid of this shape. */
const DEFAULT_POPULAR_SELECTOR = 'a[href]:has(img)';
const DEFAULT_POPULAR_NEXT_SELECTOR = 'a[rel=next]';
const DEFAULT_EPISODE_LIST_SELECTOR = 'ul.episodios li a[href], a[href][class*=episod]';
const DEFAULT_VIDEO_LIST_SELECTOR = 'iframe[src], [data-video], [data-server], [data-url]';
const DEFAULT_SEARCH_PATH = 'search';
const DEFAULT_SEARCH_QUERY_PARAM = 's';
const DEFAULT_PAGE_QUERY_PARAM = 'page';

/**
 * Attributes a server row spells its audio track in.
 *
 * Not settings: the Kotlin reads this off whatever short token the extension
 * hands `getLang`, so there is no overridable member to recover a key from.
 * Deliberately *not* including the URL — `getLang` matches on a bare `"0"`,
 * `"1"` and `"2"`, and nearly every URL contains one of those digits.
 */
const LANGUAGE_ATTRIBUTES = ['data-lang', 'data-idioma', 'data-audio', 'lang'];

/** Attributes an embed row carries its URL in, plain or base64-wrapped. */
const EMBED_ATTRIBUTES = ['src', 'data-video', 'data-url', 'data-src', 'href'];

const EMPTY_PAGE: ThemePage = { entries: [], hasMore: false };

/* -------------------------------------------------------------------------
 * The template's two portable helpers
 * ---------------------------------------------------------------------- */

/**
 * The base class's `REGEX_LINK`, verbatim.
 *
 * It matches any absolute http(s) URL, which is the point: it is run over an
 * inline script to find whatever embeds that script builds. It knows nothing
 * about what it will find.
 */
const LINK_PATTERN =
	/https?:\/\/(www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&/=]*)/g;

/** Text this refuses to scan, and results it refuses to exceed. */
const MAX_SCAN = 512 * 1024;
const MAX_URLS = 200;

/** Both ends, and only when both match. Kotlin's `removeSurrounding`. */
function unquote(value: string): string {
	return value.length >= 2 && value.charAt(0) === '"' && value.charAt(value.length - 1) === '"'
		? value.slice(1, value.length - 1)
		: value;
}

/** Every URL in a blob of text, in order. The base class's `fetchUrls`. */
export function fetchUrls(text: string | null | undefined): string[] {
	if (typeof text !== 'string' || text.length === 0 || text.length > MAX_SCAN) return [];

	const found: string[] = [];
	LINK_PATTERN.lastIndex = 0;
	let match = LINK_PATTERN.exec(text);
	while (match !== null && found.length < MAX_URLS) {
		if (match[0] === '') {
			LINK_PATTERN.lastIndex += 1;
		} else {
			found.push(unquote(match[0].trim()));
		}
		match = LINK_PATTERN.exec(text);
	}
	LINK_PATTERN.lastIndex = 0;
	return found;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
	for (const needle of needles) {
		if (haystack.indexOf(needle) >= 0) return true;
	}
	return false;
}

/**
 * The base class's `getLang`: an audio-track marker, or nothing.
 *
 * The three token sets are the Kotlin's, including the bare digits, and the
 * order matters — a value carrying both `1` and `sub` is `[CAST]` there and is
 * `[CAST]` here.
 */
export function languageTag(value: string): string {
	const token = value.toLowerCase();
	if (token === '') return '';
	if (containsAny(token, ['0', 'lat'])) return '[LAT]';
	if (containsAny(token, ['1', 'cast'])) return '[CAST]';
	if (containsAny(token, ['2', 'eng', 'sub'])) return '[SUB]';
	return '';
}

/* -------------------------------------------------------------------------
 * Small helpers
 * ---------------------------------------------------------------------- */

/** `select`, with a malformed override degrading to "found nothing". */
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

function homeUrl(ctx: ThemeContext): string {
	return absolute(ctx, './');
}

function pageHeaders(ctx: ThemeContext): Record<string, string> {
	return { Referer: homeUrl(ctx) };
}

async function loadDocument(ctx: ThemeContext, url: string): Promise<KDocument> {
	const html = await ctx.http.text(url, { headers: pageHeaders(ctx) });
	return ctx.parse(html, url);
}

function containerOf(url: string): ThemeStream['container'] {
	const path = url.split('#')[0].split('?')[0].toLowerCase();
	if (path.endsWith('.m3u8')) return 'hls';
	if (path.endsWith('.mpd')) return 'dash';
	return 'mp4';
}

/** The last run of digits in a string — an episode number, where there is one. */
function lastNumber(value: string): number | null {
	const digits = value.match(/\d+/g);
	if (digits === null || digits.length === 0) return null;
	const parsed = parseInt(digits[digits.length - 1], 10);
	return Number.isFinite(parsed) ? parsed : null;
}

function anchorOf(element: KElement): KElement | null {
	return element.tagName.toLowerCase() === 'a' ? element : safeSelectFirst(element, 'a[href]');
}

/* -------------------------------------------------------------------------
 * Selector resolution
 *
 * `searchAnimeSelector() = popularAnimeSelector()` in the Kotlin, so an
 * extension that overrode only the popular one must get that value here too.
 * ---------------------------------------------------------------------- */

function popularSelector(ctx: ThemeContext): string {
	return setting(ctx, 'popularAnimeSelector', DEFAULT_POPULAR_SELECTOR);
}

function popularNextSelector(ctx: ThemeContext): string {
	return setting(ctx, 'popularAnimeNextPageSelector', DEFAULT_POPULAR_NEXT_SELECTOR);
}

function searchSelector(ctx: ThemeContext): string {
	return setting(ctx, 'searchAnimeSelector', popularSelector(ctx));
}

function searchNextSelector(ctx: ThemeContext): string {
	return setting(ctx, 'searchAnimeNextPageSelector', popularNextSelector(ctx));
}

/* -------------------------------------------------------------------------
 * URLs
 * ---------------------------------------------------------------------- */

function browseUrl(ctx: ThemeContext, page: number): string {
	if (page <= 1) return homeUrl(ctx);
	const parameter = setting(ctx, 'pageQueryParam', DEFAULT_PAGE_QUERY_PARAM);
	return absolute(ctx, `./?${encodeURIComponent(parameter)}=${page}`);
}

function searchUrl(ctx: ThemeContext, query: string, page: number): string {
	const path = setting(ctx, 'searchPath', DEFAULT_SEARCH_PATH).replace(/^\/+/, '');
	const queryParameter = setting(ctx, 'searchQueryParam', DEFAULT_SEARCH_QUERY_PARAM);
	const pageParameter = setting(ctx, 'pageQueryParam', DEFAULT_PAGE_QUERY_PARAM);

	let url = `${path}?${encodeURIComponent(queryParameter)}=${encodeURIComponent(query)}`;
	if (page > 1) url += `&${encodeURIComponent(pageParameter)}=${page}`;
	return absolute(ctx, url);
}

/* -------------------------------------------------------------------------
 * Cards
 * ---------------------------------------------------------------------- */

function cardToEntry(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const anchor = anchorOf(element);
	if (anchor === null) return null;

	const sourceMediaId = absolute(ctx, anchor.attr('href'));
	if (sourceMediaId === '') return null;

	let title = anchor.attr('title').trim();
	if (title === '') title = (safeSelectFirst(element, 'img[alt]')?.attr('alt') ?? '').trim();
	if (title === '') title = (safeSelectFirst(element, 'h1, h2, h3, h4')?.text() ?? '').trim();
	if (title === '') title = anchor.text().trim();
	if (title === '') return null;

	const image = safeSelectFirst(element, 'img');
	const raw =
		image === null ? '' : image.attr('abs:src').trim() || image.attr('abs:data-src').trim();
	const posterImageUrl = raw === '' ? '' : absolute(ctx, raw);

	return posterImageUrl === ''
		? { sourceMediaId, title }
		: { sourceMediaId, title, posterImageUrl };
}

/* -------------------------------------------------------------------------
 * Embeds
 * ---------------------------------------------------------------------- */

/**
 * Every URL one server row points at.
 *
 * A row is an `<iframe>`, an element carrying the embed in a data attribute,
 * or an inline `<script>` an extension pointed the selector at. A data
 * attribute that is not a URL is tried as base64 — that transform is generic
 * and host-free, which is why §4.1.3 lets it ship — and whatever URLs fall out
 * of the decoded text are taken.
 */
function embedUrls(element: KElement): string[] {
	if (element.tagName.toLowerCase() === 'script') return fetchUrls(element.html());

	const found: string[] = [];
	for (const name of EMBED_ATTRIBUTES) {
		const raw = element.attr(name).trim();
		if (raw === '') continue;
		if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(raw) || raw.charAt(0) === '/') {
			found.push(raw);
			continue;
		}
		const decoded = base64Decode(raw);
		if (decoded !== '') found.push(...fetchUrls(decoded));
	}
	return found;
}

function languageOf(element: KElement): string {
	for (const name of LANGUAGE_ATTRIBUTES) {
		const value = element.attr(name).trim();
		if (value !== '') return languageTag(value);
	}
	return '';
}

/* -------------------------------------------------------------------------
 * The theme
 * ---------------------------------------------------------------------- */

export const pelisPlusTheme: Theme = {
	id: 'pelisplus',

	settings: [
		'popularAnimeSelector',
		'popularAnimeNextPageSelector',
		'searchAnimeSelector',
		'searchAnimeNextPageSelector',
		'episodeListSelector',
		'videoListSelector',
		'searchPath',
		'searchQueryParam',
		'pageQueryParam'
	],

	/**
	 * A page of the search listing, or of the browse listing when there is no
	 * query — which is the split the Kotlin makes by having search reuse the
	 * popular selectors rather than declaring its own.
	 */
	async search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage> {
		const trimmed = query.trim();
		const url = trimmed === '' ? browseUrl(ctx, page) : searchUrl(ctx, trimmed, page);
		if (url === '') return EMPTY_PAGE;

		const document = await loadDocument(ctx, url);
		const cards = safeSelect(document, trimmed === '' ? popularSelector(ctx) : searchSelector(ctx));

		const seen = new Set<string>();
		const entries: ThemeCatalogEntry[] = [];
		for (const card of cards) {
			const entry = cardToEntry(ctx, card);
			if (entry === null || seen.has(entry.sourceMediaId)) continue;
			seen.add(entry.sourceMediaId);
			entries.push(entry);
		}

		if (entries.length === 0) return EMPTY_PAGE;

		const nextSelector = trimmed === '' ? popularNextSelector(ctx) : searchNextSelector(ctx);
		return {
			entries,
			hasMore: safeSelectFirst(document, nextSelector) !== null
		};
	},

	/**
	 * The episode rows on a title's page.
	 *
	 * A page with no rows but a player on it is a single-episode title — a
	 * film, which is most of what this family carries — and answers with one
	 * episode pointing at itself. A page with neither rows nor a player answers
	 * with nothing, so a markup change reads as "found nothing" rather than as
	 * one unplayable episode.
	 */
	async episodes(sourceMediaId: string, ctx: ThemeContext): Promise<readonly ThemeEpisode[]> {
		const url = absolute(ctx, sourceMediaId);
		if (url === '') return [];

		const document = await loadDocument(ctx, url);
		const rows = safeSelect(
			document,
			setting(ctx, 'episodeListSelector', DEFAULT_EPISODE_LIST_SELECTOR)
		);

		const seen = new Set<string>();
		const episodes: ThemeEpisode[] = [];
		for (const row of rows) {
			const anchor = anchorOf(row);
			if (anchor === null) continue;

			const sourceEpisodeId = absolute(ctx, anchor.attr('href'));
			if (sourceEpisodeId === '' || seen.has(sourceEpisodeId)) continue;
			seen.add(sourceEpisodeId);

			const label = (anchor.attr('title').trim() || anchor.text().trim()).trim();
			const number = lastNumber(label) ?? lastNumber(sourceEpisodeId) ?? episodes.length + 1;

			episodes.push(
				label === '' ? { number, sourceEpisodeId } : { number, sourceEpisodeId, title: label }
			);
		}

		if (episodes.length > 0) return episodes;

		const hasPlayer =
			safeSelectFirst(document, setting(ctx, 'videoListSelector', DEFAULT_VIDEO_LIST_SELECTOR)) !==
			null;
		return hasPlayer ? [{ number: 1, sourceEpisodeId: url }] : [];
	},

	/**
	 * The embed urls the player exposes, tagged with their audio track.
	 *
	 * The Kotlin hands each of these to a host-specific extractor chosen by
	 * hostname. That table is the thing `FOREIGN.md` §4.1.3 says may not live
	 * in this repository, so the chain ends here and the embed url is the
	 * result — which is exactly what `ThemeStream` is documented to be.
	 */
	async streams(sourceEpisodeId: string, ctx: ThemeContext): Promise<readonly ThemeStream[]> {
		const url = absolute(ctx, sourceEpisodeId);
		if (url === '') return [];

		const document = await loadDocument(ctx, url);
		const rows = safeSelect(
			document,
			setting(ctx, 'videoListSelector', DEFAULT_VIDEO_LIST_SELECTOR)
		);

		const seen = new Set<string>();
		const streams: ThemeStream[] = [];
		for (const row of rows) {
			const tag = languageOf(row);
			const name = (row.attr('title').trim() || row.ownText().trim()).trim();

			for (const candidate of embedUrls(row)) {
				const resolved = absolute(ctx, candidate);
				if (resolved === '' || seen.has(resolved)) continue;
				seen.add(resolved);

				const label = `${tag} ${name === '' ? `Server ${streams.length + 1}` : name}`.trim();
				streams.push({
					url: resolved,
					container: containerOf(resolved),
					label,
					headers: { Referer: homeUrl(ctx) }
				});
			}
		}
		return streams;
	}
};

registerTheme(pelisPlusTheme);
