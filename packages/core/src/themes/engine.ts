/**
 * What a converted template is, and the only thing it is allowed to know.
 *
 * A large minority of extensions in the adapted ecosystems are generated from
 * a shared *template*: a page shape — a grid of results, a paginated listing,
 * an episode table — that dozens of unrelated sites happen to share because
 * they all run the same off-the-shelf CMS or player theme. The template is the
 * part worth implementing once.
 *
 * ## Rule 9 lives in this file's shape
 *
 * A template is a shape, not a place. Everything site-specific — the base URL,
 * any selector the extension overrode — arrives in `ThemeConfig` at runtime,
 * read out of the extension being converted on the viewer's own device. So a
 * `Theme` implementation contains selectors and page structure and **never a
 * hostname**, which is what makes it ordinary machinery this repository may
 * ship (`contract/plugin-api/FOREIGN.md` §4.1.3).
 *
 * The test is simple and worth applying to every line: if it could not be
 * written without naming a site, it does not belong in a theme. It belongs in
 * a plugin repository.
 *
 * ## Why a theme takes a context rather than importing one
 *
 * A theme performs no I/O of its own. It is handed `http` and `parse`, both of
 * which the host owns, so the plugin's declared network allowlist is enforced
 * on every request a theme makes without the theme being able to opt out — the
 * same reason `ABI.md` §2 gives a plugin a `ctx` and no ambient `fetch`.
 */

import type { KDocument } from '@plugin-bridge/runtime/shims/dom';

/** The site-specific half, read from the extension at conversion time. */
export interface ThemeConfig {
	/** Always absolute, always https, and always with a trailing slash. */
	readonly baseUrl: string;
	/** BCP-47-ish, as the source ecosystem spells it. */
	readonly lang: string;
	/**
	 * Values the extension overrode on its template.
	 *
	 * A template declares defaults; an extension may replace any of them. These
	 * are what the Kotlin reader recovered — a selector, a path fragment, a
	 * query parameter name. A theme reads them through `setting()` so that a
	 * missing override falls back to the template's own default rather than
	 * producing an empty selector, which would match everything.
	 */
	readonly overrides: Readonly<Record<string, string>>;
}

/** The only capabilities a theme has. */
export interface ThemeContext {
	readonly config: ThemeConfig;
	/**
	 * Host-mediated. Refuses any host the plugin did not declare.
	 *
	 * `method` and `body` are here because a GET-only context turned out to be
	 * unusable for a whole family of templates: several render an empty player
	 * and fetch the real embed with a form POST to a CMS endpoint. Without a
	 * body those pages cannot be read at all, and the template returns nothing
	 * — which the install check correctly refuses, for a reason that is our
	 * limitation rather than the source's.
	 *
	 * Both are optional and default to a plain GET, so a template that needs
	 * neither says nothing about either.
	 */
	readonly http: {
		text(
			url: string,
			request?: {
				headers?: Record<string, string>;
				method?: 'GET' | 'POST';
				/** Already encoded by the caller; sent verbatim. */
				body?: string;
			}
		): Promise<string>;
	};
	/** The DOM shim, injected so a theme never reaches for a global. */
	readonly parse: (html: string, baseUrl?: string) => KDocument;
}

export interface ThemeCatalogEntry {
	/** Absolute URL. It becomes the plugin's own media id, so it must be stable. */
	readonly sourceMediaId: string;
	readonly title: string;
	readonly posterImageUrl?: string;
}

export interface ThemeEpisode {
	readonly number: number;
	/** Absolute URL, and the id `streams()` is later called with. */
	readonly sourceEpisodeId: string;
	readonly title?: string;
}

/**
 * One playable mirror.
 *
 * A theme returns the *page-level* result: the URLs a template exposes. Turning
 * a host-specific embed into a manifest is a different job, deliberately not
 * done here — see this file's header on where that may live.
 */
export interface ThemeStream {
	readonly url: string;
	readonly container: 'hls' | 'mp4' | 'dash';
	readonly label: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface ThemePage {
	readonly entries: readonly ThemeCatalogEntry[];
	readonly hasMore: boolean;
}

/**
 * One template, as a pure function of its config and its context.
 *
 * The three methods map one-to-one onto `ABI.md` §1, so a converted template
 * needs no adapter of its own — which is the point of making them agree.
 */
export interface Theme {
	/** Stable id, matching the template's directory name in its source repo. */
	readonly id: string;
	/**
	 * Config keys this template understands, for the converter to look for.
	 *
	 * Declared rather than discovered so that an extension overriding something
	 * a template does not read is a visible mismatch instead of a value that is
	 * silently ignored.
	 */
	readonly settings: readonly string[];

	search(query: string, page: number, ctx: ThemeContext): Promise<ThemePage>;
	episodes(sourceMediaId: string, ctx: ThemeContext): Promise<readonly ThemeEpisode[]>;
	streams(sourceEpisodeId: string, ctx: ThemeContext): Promise<readonly ThemeStream[]>;
}

/**
 * An overridden value, or the template's default.
 *
 * Never returns an empty string for a present-but-blank override: an empty CSS
 * selector matches nothing in some engines and throws in others, and either
 * way the failure surfaces far from the config that caused it.
 */
export function setting(ctx: ThemeContext, key: string, fallback: string): string {
	const value = ctx.config.overrides[key];
	return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

/**
 * Resolves a possibly-relative URL against the configured base.
 *
 * Hand-rolled rather than `new URL`, because this runs on embedded engines that
 * ship without it (`ABI.md` §6), and because a template that emitted a relative
 * id would produce media ids that stop resolving the moment they are stored.
 */
export function absolute(ctx: ThemeContext, url: string): string {
	const value = url.trim();
	if (value.length === 0) return '';
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;

	const base = ctx.config.baseUrl.replace(/\/+$/, '');
	if (value.startsWith('//')) return `https:${value}`;
	if (value.startsWith('/')) {
		const origin = base.replace(/^(https?:\/\/[^/]+).*$/i, '$1');
		return `${origin}${value}`;
	}
	return `${base}/${value.replace(/^\.\//, '')}`;
}

/** Every template this build carries, by id. */
const REGISTRY = new Map<string, Theme>();

export function registerTheme(theme: Theme): void {
	REGISTRY.set(theme.id, theme);
}

export function themeById(id: string): Theme | null {
	return REGISTRY.get(id.toLowerCase()) ?? null;
}

export function registeredThemes(): readonly string[] {
	return [...REGISTRY.keys()].sort();
}
