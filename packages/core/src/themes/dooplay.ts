/**
 * A WordPress video theme, as a `Theme`.
 *
 * One off-the-shelf WordPress theme backs the largest single group of
 * template-generated extensions in the adapted catalogue — 23 of them at the
 * time of writing. They share a page shape and nothing else: a search page of
 * result cards, a details page carrying an accordion of seasons each holding a
 * list of episodes, and an episode page carrying a row of player options with
 * a box of embed markup behind each one. Dozens of unrelated sites produce
 * that shape because they installed the same theme, which is exactly what
 * `contract/plugin-api/FOREIGN.md` §4.1.3 means by a template being a *shape*
 * rather than a place.
 *
 * ## Rule 9
 *
 * There is no hostname in this file, in its identifiers, in its comments or in
 * its tests, and there is not going to be one. Every URL below is built from
 * `ctx.config.baseUrl`, which arrives at runtime from the extension being
 * converted on the viewer's own device. Every selector is either the theme's
 * own default — a class name the theme's PHP writes, the same on every install
 * — or an override the extension itself supplied.
 *
 * The upstream template stops at the embed URL and hands it to a per-host
 * extractor chosen by hostname. Those extractors are made of hostnames, so
 * none of that is ported: `streams()` returns the URLs the page exposes and
 * stops, which is the boundary the engine's `ThemeStream` doc describes.
 *
 * ## What "never throws" buys
 *
 * Selectors arrive from config and pages arrive from the network, so both are
 * assumed hostile and neither is assumed to match. A page that no longer has
 * the shape this file expects produces an empty list, and an empty list is
 * what `FOREIGN.md` §6 turns into a refusal naming the step that found
 * nothing. A thrown selector error, by contrast, would surface as a stack
 * trace from a file the reader never chose.
 */

import type { KDocument, KElement } from '@plugin-bridge/runtime/shims/dom';
import type {
	Theme,
	ThemeCatalogEntry,
	ThemeContext,
	ThemeEpisode,
	ThemePage,
	ThemeStream
} from './engine';
import { absolute, registerTheme, setting } from './engine';

/* -------------------------------------------------------------------------
 * The template's own defaults
 *
 * Each of these is the value the shared base class declares. An extension that
 * overrode one supplies it through `ThemeConfig.overrides` under the *same*
 * member name, which is why the keys below are spelled the way the base class
 * spells them rather than the way this file would have named them.
 * ---------------------------------------------------------------------- */

/** Cards on a name-search result page. Each is the anchor itself. */
const SEARCH_SELECTOR = 'div.result-item div.image a';

/** Cards on a filtered or front-page listing. Each wraps its own anchor. */
const LISTING_SELECTOR = 'div.content article > div.poster';

/** The front page's own card shape, which differs from the listing's. */
const POPULAR_SELECTOR = 'article.w_item_a > a';

/** Present only while a further page exists; its absence is the last page. */
const NEXT_PAGE_SELECTOR = 'div.resppages > a > span.fa-chevron-right';

/** One collapsible season on a details page. */
const SEASON_SELECTOR = 'div#seasons > div';

/** One episode row inside a season. */
const EPISODE_SELECTOR = 'ul.episodios > li';

/** The trailing number of `1 - 12`, which is how the theme writes an episode. */
const EPISODE_NUMBER_REGEX = '(\\d+)$';

/**
 * The "all episodes" item in an episode page's pager.
 *
 * Its presence means the document in hand is an episode page rather than a
 * details page, and its parent anchor points at the details page.
 */
const ANIME_MENU_SELECTOR = 'div.pag_episodes div.item a[href] i.fa-bars';

/**
 * One player option's markup on an episode page.
 *
 * The base class leaves this to each extension — it declares the member and
 * throws — so the default here is the theme's own markup rather than a value
 * recovered from upstream. An extension that supplies its own wins.
 */
const VIDEO_LIST_SELECTOR = 'div.source-box';

/** The tab strip naming the player options, in the same order as the boxes. */
const PLAYER_OPTION_SELECTOR = '#playeroptionsul > li, li.dooplay_player_option';

/**
 * Attributes an embed URL hides behind, most specific first.
 *
 * `src` comes late deliberately: a lazily-loaded frame carries a placeholder
 * there and the real URL in one of the data attributes, so preferring `src`
 * would find the placeholder every time.
 */
const URL_ATTRIBUTES = [
	'data-src',
	'data-litespeed-src',
	'data-lazy-src',
	'data-url',
	'src',
	'href'
];

/** Attributes a poster hides behind, in the order the template tries them. */
const IMAGE_ATTRIBUTES = ['data-src', 'data-lazy-src', 'srcset', 'src'];

/** Values that occupy a URL attribute without being a URL. */
const NON_URLS = ['#', 'about:blank', 'javascript:void(0)', 'javascript:;'];

/* -------------------------------------------------------------------------
 * Total helpers
 * ---------------------------------------------------------------------- */

/** `select`, minus the throw an unparseable configured selector would cause. */
function selectAll(root: KElement, selector: string): KElement[] {
	try {
		return root.select(selector);
	} catch {
		return [];
	}
}

/** `selectFirst`, with the same guarantee. */
function selectOne(root: KElement, selector: string): KElement | null {
	try {
		return root.selectFirst(selector);
	} catch {
		return null;
	}
}

/** The first of several attributes that holds something URL-shaped. */
function firstUrlAttribute(
	element: KElement,
	names: readonly string[]
): { name: string; value: string } | null {
	for (const name of names) {
		const raw = element.attr(name).trim();
		if (raw.length === 0) continue;
		// A `srcset` is a comma-separated list of `url descriptor` pairs; the
		// template takes everything before the first space of the first entry.
		const value = raw.split(/[\s,]+/)[0] ?? '';
		if (value.length === 0) continue;
		if (NON_URLS.indexOf(value.toLowerCase()) >= 0) continue;
		return { name, value };
	}
	return null;
}

/**
 * One of those attributes, made absolute.
 *
 * The shim's `abs:` prefix resolves against the *document's* URL, which is the
 * right base for a relative link on a page that is not the site root, so it is
 * preferred wherever the attribute holds nothing but a URL. A `srcset` holds
 * more than that, and `abs:` on one would resolve the descriptors along with
 * it, so a value taken out of a list falls back to the configured base.
 */
function resolveAttribute(ctx: ThemeContext, element: KElement, names: readonly string[]): string {
	const found = firstUrlAttribute(element, names);
	if (found === null) return '';
	if (element.attr(found.name).trim() === found.value) {
		const resolved = element.attr(`abs:${found.name}`).trim();
		if (resolved.length > 0) return absolute(ctx, resolved);
	}
	return absolute(ctx, found.value);
}

/**
 * The template's poster resolution, which tries four attributes in order.
 *
 * Returns `undefined` rather than an empty string so that a card with no
 * usable image omits the field instead of carrying a blank one.
 */
function imageUrl(ctx: ThemeContext, image: KElement | null): string | undefined {
	if (image === null) return undefined;
	const resolved = resolveAttribute(ctx, image, IMAGE_ATTRIBUTES);
	return resolved.length === 0 ? undefined : resolved;
}

/** An anchor's target, absolute, or `''` when there is not one. */
function hrefOf(ctx: ThemeContext, element: KElement | null): string {
	if (element === null) return '';
	return resolveAttribute(ctx, element, ['href']);
}

/** Fetches a page and parses it against its own URL, so `abs:` resolves. */
async function load(ctx: ThemeContext, url: string): Promise<KDocument> {
	const html = await ctx.http.text(url, {
		headers: { Referer: ctx.config.baseUrl }
	});
	return ctx.parse(html, url);
}

/**
 * A language-dependent default, the way the base class writes one.
 *
 * The template hard-codes a Portuguese wording alongside its English one and
 * picks between them on the source's declared language. Nothing else in it
 * varies by language.
 */
function byLanguage(ctx: ThemeContext, portuguese: string, english: string): string {
	return ctx.config.lang.trim().toLowerCase() === 'pt-br' ? portuguese : english;
}

/** A configured pattern, or the template's own when it will not compile. */
function episodeNumberPattern(ctx: ThemeContext): RegExp {
	const configured = setting(ctx, 'episodeNumberRegex', EPISODE_NUMBER_REGEX);
	try {
		return new RegExp(configured);
	} catch {
		return new RegExp(EPISODE_NUMBER_REGEX);
	}
}

/** A page number that is a positive integer, whatever arrived. */
function pageNumber(page: number): number {
	if (typeof page !== 'number' || !isFinite(page) || page < 1) return 1;
	return Math.floor(page);
}

/**
 * A container for an embed URL.
 *
 * Most of what this template exposes is a player page rather than a media
 * file, and `ThemeStream` has no word for that, so the extension is read where
 * there is one and `mp4` stands in where there is not. The host resolves the
 * embed either way; the field only tells it what to expect if the URL turns
 * out to be a manifest.
 */
function containerOf(url: string): ThemeStream['container'] {
	const path = url.split('#')[0].split('?')[0].toLowerCase();
	if (path.indexOf('.m3u8') >= 0) return 'hls';
	if (path.indexOf('.mpd') >= 0) return 'dash';
	return 'mp4';
}

/* -------------------------------------------------------------------------
 * Catalogue
 * ---------------------------------------------------------------------- */

/** A search card: the anchor is the element, and the poster is inside it. */
function entryFromAnchor(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const url = hrefOf(ctx, element);
	if (url.length === 0) return null;
	const image = selectOne(element, 'img');
	const title = image === null ? '' : image.attr('alt').trim();
	return {
		sourceMediaId: url,
		title: title.length > 0 ? title : element.text().trim(),
		posterImageUrl: imageUrl(ctx, image)
	};
}

/** A listing card: the anchor is inside the element, or is the element. */
function entryFromCard(ctx: ThemeContext, element: KElement): ThemeCatalogEntry | null {
	const anchor = selectOne(element, 'a[href]');
	const url = anchor === null ? hrefOf(ctx, element) : hrefOf(ctx, anchor);
	if (url.length === 0) return null;
	const image = selectOne(element, 'img');
	const title = image === null ? '' : image.attr('alt').trim();
	return {
		sourceMediaId: url,
		title: title.length > 0 ? title : element.text().trim(),
		posterImageUrl: imageUrl(ctx, image)
	};
}

function collect(
	document: KDocument,
	selector: string,
	shape: (element: KElement) => ThemeCatalogEntry | null
): ThemeCatalogEntry[] {
	const entries: ThemeCatalogEntry[] = [];
	for (const element of selectAll(document, selector)) {
		const entry = shape(element);
		if (entry !== null && entry.title.length > 0) entries.push(entry);
	}
	return entries;
}

/**
 * The next-page selector, with the delegation the base class declares.
 *
 * Upstream, the search page's selector *is* the listing page's selector — one
 * method returning the other's result — so an extension that overrode only the
 * listing one has overridden both, and reading them independently would drop
 * that override on the floor.
 */
function nextPageSelector(ctx: ThemeContext): string {
	return setting(
		ctx,
		'searchAnimeNextPageSelector',
		setting(ctx, 'latestUpdatesNextPageSelector', NEXT_PAGE_SELECTOR)
	);
}

/**
 * The front page, which is what a blank query asks for.
 *
 * The upstream request for this case ignores the page number entirely, so
 * every page past the first would re-fetch and re-return page one. Reporting
 * no further pages is the honest form of that: one page exists, and asking for
 * a second is answered rather than looped.
 */
async function frontPage(ctx: ThemeContext, page: number): Promise<ThemePage> {
	if (page > 1) return { entries: [], hasMore: false };
	const document = await load(ctx, ctx.config.baseUrl);
	const listing = collect(
		document,
		setting(ctx, 'latestUpdatesSelector', LISTING_SELECTOR),
		(element) => entryFromCard(ctx, element)
	);
	if (listing.length > 0) return { entries: listing, hasMore: false };
	// The front page and the paginated listings do not share a card shape on
	// every install, and the template carries a selector for each. Falling
	// through to the second one costs a pass over a parsed document and turns
	// an empty first screen into a populated one.
	const popular = collect(
		document,
		setting(ctx, 'popularAnimeSelector', POPULAR_SELECTOR),
		(element) => entryFromAnchor(ctx, element)
	);
	return { entries: popular, hasMore: false };
}

/* -------------------------------------------------------------------------
 * Episodes
 * ---------------------------------------------------------------------- */

/**
 * The details page for whatever page is in hand.
 *
 * An episode page carries a pager whose middle item links back to the show, so
 * an id that turned out to be an episode still yields an episode list. A
 * failure on that second hop is not fatal: the page already fetched is
 * returned, and the caller gets whatever it can be made to yield.
 */
async function detailsDocument(
	ctx: ThemeContext,
	document: KDocument,
	url: string
): Promise<{ document: KDocument; url: string }> {
	const menu = selectOne(document, setting(ctx, 'animeMenuSelector', ANIME_MENU_SELECTOR));
	const anchor = menu === null ? null : menu.parent;
	const target = hrefOf(ctx, anchor);
	if (target.length === 0 || target === url) return { document, url };
	try {
		return { document: await load(ctx, target), url: target };
	} catch {
		return { document, url };
	}
}

function episodeFromRow(
	ctx: ThemeContext,
	row: KElement,
	seasonName: string,
	pattern: RegExp,
	prefix: string
): ThemeEpisode | null {
	const anchor = selectOne(row, 'a[href]');
	const url = hrefOf(ctx, anchor);
	if (anchor === null || url.length === 0) return null;

	const numbering = selectOne(row, 'div.numerando');
	const text = numbering === null ? '' : numbering.text().trim();
	// `lastIndex` is not carried between rows: a configured `g` flag would make
	// every other row miss, which is a bug that reads as a flaky source.
	pattern.lastIndex = 0;
	const found = pattern.exec(text);
	const captured = found === null ? '' : (found[found.length - 1] ?? '');
	const number = parseFloat(captured);

	const name = anchor.ownText().trim();
	const label = `${prefix} ${seasonName} x ${captured.length > 0 ? captured : '0'} - ${name}`;
	return {
		number: isFinite(number) ? number : 0,
		sourceEpisodeId: url,
		title: label.trim()
	};
}

/* -------------------------------------------------------------------------
 * Streams
 * ---------------------------------------------------------------------- */

/** The label on each player option, in the order the tab strip lists them. */
function optionLabels(options: readonly KElement[]): string[] {
	return options.map((option) => {
		const parts: string[] = [];
		for (const selector of ['span.title', 'span.server']) {
			const part = selectOne(option, selector);
			const text = part === null ? '' : part.text().trim();
			if (text.length > 0) parts.push(text);
		}
		if (parts.length > 0) return parts.join(' - ');
		return option.text().trim();
	});
}

/**
 * The embed URL a player box holds.
 *
 * The box is normally a wrapper around a frame, but an extension may have
 * pointed the selector straight at the frame or at a link, so the element
 * itself is tried before its descendants.
 */
function embedUrl(ctx: ThemeContext, box: KElement): string {
	const direct = resolveAttribute(ctx, box, URL_ATTRIBUTES);
	if (direct.length > 0) return direct;
	for (const child of selectAll(box, 'iframe, a[href], [data-src], [data-url], [src]')) {
		const value = resolveAttribute(ctx, child, URL_ATTRIBUTES);
		if (value.length > 0) return value;
	}
	return '';
}

/**
 * Which player option an element belongs to.
 *
 * The theme numbers an option's id and its box's id with the same ordinal —
 * `…-1` against `…-1` — which is the only thing tying the two lists together
 * when one of them is shorter than the other. Position is the fallback, and it
 * is what an extension that pointed the selector at unnumbered markup gets.
 */
function ordinalOf(element: KElement, index: number): number {
	const numbered = /(\d+)\s*$/.exec(element.id);
	if (numbered !== null) {
		const parsed = parseInt(numbered[1] ?? '', 10);
		if (isFinite(parsed) && parsed > 0) return parsed;
	}
	return index + 1;
}

/** A name for one mirror, taken from the option that ordinal belongs to. */
function labelFor(labels: readonly string[], ordinal: number, index: number): string {
	const byOrdinal = labels[ordinal - 1];
	if (typeof byOrdinal === 'string' && byOrdinal.length > 0) return byOrdinal;
	const byIndex = labels[index];
	if (typeof byIndex === 'string' && byIndex.length > 0) return byIndex;
	return `Player ${ordinal}`;
}

/* -------------------------------------------------------------------------
 * The AJAX fallback
 *
 * Not every install renders its frames into the page. The commoner
 * configuration renders the tab strip only, each option carrying the three
 * values the CMS needs to look the mirror up, and fetches the markup on click
 * with a form POST to the CMS's own AJAX endpoint. That endpoint is part of
 * the CMS's shape — the same path on every install of it, the way the class
 * names above are the same on every install — so it is template knowledge and
 * lives here as a *path*, resolved against `ctx.config.baseUrl` like every
 * other URL in this file. There is no hostname in it, and there cannot be.
 * ---------------------------------------------------------------------- */

/** The CMS's own AJAX entry point, relative to the site root. */
const AJAX_PATH = 'wp-admin/admin-ajax.php';

/** The handler the theme registers there. */
const AJAX_ACTION = 'doo_player_ajax';

/** Keys the response is known to carry the mirror under, best first. */
const AJAX_EMBED_KEYS = ['embed_url', 'embed', 'url'];

/** `application/x-www-form-urlencoded`, which is not `encodeURIComponent`. */
function formEncode(value: string): string {
	return encodeURIComponent(value)
		.replace(/%20/g, '+')
		.replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The POST body one option asks for, or `null` when it is not an AJAX option.
 *
 * A box that already holds a frame never reaches this, and an option missing
 * the identifiers is not one the endpoint could answer for, so both decline
 * rather than sending a request that cannot succeed.
 */
function ajaxBody(ctx: ThemeContext, option: KElement): string | null {
	const post = option.attr('data-post').trim();
	const nume = option.attr('data-nume').trim();
	if (post.length === 0 || nume.length === 0) return null;

	const fields: [string, string][] = [
		[setting(ctx, 'videoAjaxActionField', 'action'), setting(ctx, 'videoAjaxAction', AJAX_ACTION)],
		[setting(ctx, 'videoAjaxPostField', 'post'), post],
		[setting(ctx, 'videoAjaxNumeField', 'nume'), nume],
		[setting(ctx, 'videoAjaxTypeField', 'type'), option.attr('data-type').trim()]
	];
	return fields.map(([name, value]) => `${formEncode(name)}=${formEncode(value)}`).join('&');
}

/** Whether a string is shaped like something that could be fetched. */
function looksLikeUrl(value: string): boolean {
	if (value.length === 0 || /\s/.test(value)) return false;
	return (
		/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.slice(0, 2) === '//' || value.charAt(0) === '/'
	);
}

/**
 * The mirror inside an AJAX response.
 *
 * Three answers are in circulation and all three arrive here: a JSON object
 * carrying the URL, a JSON object carrying a fragment of iframe markup instead,
 * and — from an install that failed the lookup — a bare `0`, a stack trace, or
 * an error page. Only the first two produce anything; everything else is junk,
 * and junk is worth exactly an empty string.
 */
function embedFromAjax(ctx: ThemeContext, body: string): string {
	const trimmed = body.trim();
	if (trimmed.length === 0) return '';

	let value = '';
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (typeof parsed === 'string') {
			value = parsed.trim();
		} else if (parsed !== null && typeof parsed === 'object') {
			const record = parsed as Record<string, unknown>;
			for (const key of AJAX_EMBED_KEYS) {
				const candidate = record[key];
				if (typeof candidate === 'string' && candidate.trim().length > 0) {
					value = candidate.trim();
					break;
				}
			}
		}
	} catch {
		// Some installs answer with the markup itself and no JSON around it.
		value = trimmed;
	}
	if (value.length === 0) return '';

	if (value.charAt(0) === '<' || value.indexOf('<iframe') >= 0) {
		const document = ctx.parse(value, ctx.config.baseUrl);
		const frame = selectOne(document, 'iframe, a[href], [data-url], [src]');
		return frame === null ? '' : resolveAttribute(ctx, frame, URL_ATTRIBUTES);
	}
	return looksLikeUrl(value) ? absolute(ctx, value) : '';
}

/** One AJAX lookup. Total: any failure at all is reported as no mirror. */
async function ajaxEmbed(ctx: ThemeContext, option: KElement): Promise<string> {
	const body = ajaxBody(ctx, option);
	if (body === null) return '';

	const endpoint = absolute(ctx, setting(ctx, 'videoAjaxPath', AJAX_PATH));
	if (endpoint.length === 0) return '';

	try {
		const response = await ctx.http.text(endpoint, {
			method: 'POST',
			headers: {
				Referer: ctx.config.baseUrl,
				'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
				'x-requested-with': 'XMLHttpRequest'
			},
			body
		});
		return embedFromAjax(ctx, response);
	} catch {
		return '';
	}
}

/* -------------------------------------------------------------------------
 * The theme
 * ---------------------------------------------------------------------- */

export const dooplayTheme: Theme = {
	id: 'dooplay',

	settings: [
		'popularAnimeSelector',
		'searchAnimeSelector',
		'searchAnimeNextPageSelector',
		'latestUpdatesSelector',
		'latestUpdatesNextPageSelector',
		'seasonListSelector',
		'episodeListSelector',
		'episodeNumberRegex',
		'episodeSeasonPrefix',
		'episodeMovieText',
		'animeMenuSelector',
		'videoListSelector',
		'videoAjaxPath',
		'videoAjaxAction',
		'videoAjaxActionField',
		'videoAjaxPostField',
		'videoAjaxNumeField',
		'videoAjaxTypeField'
	],

	async search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage> {
		const wanted = query.trim();
		const wantedPage = pageNumber(page);
		if (wanted.length === 0) return frontPage(ctx, wantedPage);

		const document = await load(
			ctx,
			absolute(ctx, `page/${wantedPage}/?s=${encodeURIComponent(wanted)}`)
		);
		const entries = collect(
			document,
			setting(ctx, 'searchAnimeSelector', SEARCH_SELECTOR),
			(element) => entryFromAnchor(ctx, element)
		);
		return {
			entries,
			hasMore: selectOne(document, nextPageSelector(ctx)) !== null
		};
	},

	async episodes(sourceMediaId: string, ctx: ThemeContext): Promise<readonly ThemeEpisode[]> {
		const start = absolute(ctx, sourceMediaId);
		if (start.length === 0) return [];

		const fetched = await load(ctx, start);
		const details = await detailsDocument(ctx, fetched, start);

		const seasons = selectAll(
			details.document,
			setting(ctx, 'seasonListSelector', SEASON_SELECTOR)
		);
		if (seasons.length === 0) {
			// No season accordion means a single-entry title, which the template
			// represents as one episode pointing at the page itself.
			return [
				{
					number: 1,
					sourceEpisodeId: details.url,
					title: setting(ctx, 'episodeMovieText', byLanguage(ctx, 'Filme', 'Movie'))
				}
			];
		}

		const rowSelector = setting(ctx, 'episodeListSelector', EPISODE_SELECTOR);
		const prefix = setting(ctx, 'episodeSeasonPrefix', byLanguage(ctx, 'Temporada', 'Season'));
		const pattern = episodeNumberPattern(ctx);

		const episodes: ThemeEpisode[] = [];
		for (const season of seasons) {
			const heading = selectOne(season, 'span.se-t');
			const seasonName = heading === null ? '' : heading.text().trim();
			for (const row of selectAll(season, rowSelector)) {
				const episode = episodeFromRow(ctx, row, seasonName, pattern, prefix);
				if (episode !== null) episodes.push(episode);
			}
		}
		// The page lists seasons and episodes newest-first; the host wants the
		// order a viewer would watch them in.
		episodes.reverse();
		return episodes;
	},

	async streams(sourceEpisodeId: string, ctx: ThemeContext): Promise<readonly ThemeStream[]> {
		const url = absolute(ctx, sourceEpisodeId);
		if (url.length === 0) return [];

		const document = await load(ctx, url);
		const options = selectAll(document, PLAYER_OPTION_SELECTOR);
		const labels = optionLabels(options);
		const boxes = selectAll(document, setting(ctx, 'videoListSelector', VIDEO_LIST_SELECTOR));

		const found: { ordinal: number; url: string; label: string }[] = [];
		/** Ordinals the page answered for itself; those never trigger a POST. */
		const served: number[] = [];

		for (let index = 0; index < boxes.length; index += 1) {
			const box = boxes[index];
			if (box === undefined) continue;
			const embed = embedUrl(ctx, box);
			if (embed.length === 0) continue;
			const ordinal = ordinalOf(box, index);
			if (served.indexOf(ordinal) < 0) served.push(ordinal);
			found.push({
				ordinal,
				url: embed,
				label: labelFor(labels, ordinal, index)
			});
		}

		for (let index = 0; index < options.length; index += 1) {
			const option = options[index];
			if (option === undefined) continue;
			const ordinal = ordinalOf(option, index);
			if (served.indexOf(ordinal) >= 0) continue;
			const embed = await ajaxEmbed(ctx, option);
			if (embed.length === 0) continue;
			found.push({
				ordinal,
				url: embed,
				label: labelFor(labels, ordinal, index)
			});
		}

		// Both passes are in page order within themselves, but a page that mixes
		// the two would otherwise list every rendered frame ahead of every fetched
		// one. The tab strip's own numbering is the order a viewer sees.
		found.sort((left, right) => left.ordinal - right.ordinal);

		const streams: ThemeStream[] = [];
		const seen: string[] = [];
		for (const candidate of found) {
			if (seen.indexOf(candidate.url) >= 0) continue;
			seen.push(candidate.url);
			streams.push({
				url: candidate.url,
				container: containerOf(candidate.url),
				label: candidate.label
			});
		}
		return streams;
	}
};

registerTheme(dooplayTheme);
