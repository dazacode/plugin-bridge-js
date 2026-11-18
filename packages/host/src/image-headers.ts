/**
 * Image headers a host applies itself — `ABI.md` §9.1, API level 3.
 *
 * A page's `headers`, a chapter's `headersByHost`, a catalogue entry's
 * `posterImageHeaders` and a catalogue page's `imageHeadersByHost` are what a
 * plugin declares for the images it names; this module is the host's half:
 * reading those values as a host must (refusing a bad one with the field named
 * rather than applying part of it), and answering, for one image URL, the
 * headers that request carries.
 *
 * The rules are the request policy's (`net/request-policy.ts`, §2.1) and the
 * stream pipeline's (§4.1), on purpose: one header vocabulary, one host-pattern
 * vocabulary, one precedence — a request's own headers win — and a second
 * spelling of any of those would be two answers to one question. Two rules
 * are the image's own: headers ride `https:` images only, and the names that
 * describe a connection rather than a request are refused.
 */

import { ValidationFailure } from '@plugin-bridge/core/errors';

import { hostMatches } from './host-match';
import { mostSpecific, readHeaders, readPattern } from './net/request-policy';

/** Names that describe the connection the host owns, not the image asked for. */
const CONNECTION_HEADERS = new Set([
	'host',
	'content-length',
	'connection',
	'keep-alive',
	'transfer-encoding',
	'te',
	'trailer',
	'upgrade'
]);

const MAX_HOST_RULES = 32;

export type ImageHeaders = Readonly<Record<string, string>>;
export type ImageHeadersByHost = Readonly<Record<string, ImageHeaders>>;

function refuse(what: string): never {
	throw new ValidationFailure(`Image headers: ${what}.`);
}

/** One header map, as the request policy reads one, without connection names. */
export function readImageHeaders(value: unknown, what: string): ImageHeaders {
	let headers: Record<string, string>;
	try {
		headers = readHeaders(value, what);
	} catch (error) {
		// The request policy's reader words its refusal for a policy; the rule is
		// the same one, so only the sentence is changed.
		refuse(
			String((error as Error).message)
				.replace(/^Not a request policy: /, '')
				.replace(/\.$/, '')
		);
	}
	for (const name of Object.keys(headers)) {
		if (CONNECTION_HEADERS.has(name) || name.startsWith('proxy-')) {
			refuse(`${what} sets "${name}", which belongs to the connection the host makes`);
		}
	}
	return headers;
}

/** A `…ByHost` map: `network.hosts` patterns to header maps. */
export function readImageHeadersByHost(value: unknown, what: string): ImageHeadersByHost {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		refuse(`${what} must be an object of host patterns`);
	}
	const keys = Object.keys(value);
	if (keys.length > MAX_HOST_RULES) refuse(`${what} names more than ${MAX_HOST_RULES} hosts`);
	const out: Record<string, ImageHeaders> = {};
	for (const key of keys) {
		let pattern: string;
		try {
			pattern = readPattern(key, what);
		} catch (error) {
			refuse(
				String((error as Error).message)
					.replace(/^Not a request policy: /, '')
					.replace(/\.$/, '')
			);
		}
		out[pattern] = readImageHeaders((value as Record<string, unknown>)[key], `${what}["${key}"]`);
	}
	return out;
}

/**
 * The headers one image request carries.
 *
 * `https:` only, so a header never rides a downgrade. The image's own headers
 * win over the most specific matching `…ByHost` entry, name by name — §2.1 rule
 * 7, applied to images. An entry for a host outside the plugin's grant is
 * inert here as it is in a request policy: the grant refuses the request
 * itself, elsewhere.
 */
export function imageHeadersFor(
	url: string,
	own: ImageHeaders | undefined,
	byHost: ImageHeadersByHost | undefined
): ImageHeaders {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return {};
	}
	if (parsed.protocol !== 'https:') return {};
	const out: Record<string, string> = {};
	if (byHost !== undefined) {
		const pattern = mostSpecific(Object.keys(byHost), parsed.hostname.toLowerCase());
		if (pattern !== null && hostMatches(parsed.hostname.toLowerCase(), pattern)) {
			Object.assign(out, byHost[pattern]);
		}
	}
	for (const [name, value] of Object.entries(own ?? {})) out[name.toLowerCase()] = value;
	return out;
}

/** A `readChapter` answer's image fields, read as a level-3 host must. */
export interface ChapterImages {
	readonly pages: readonly {
		readonly index: number;
		readonly url: string;
		readonly headers?: ImageHeaders;
	}[];
	readonly headersByHost?: ImageHeadersByHost;
}

export function readChapterImages(value: unknown): ChapterImages {
	if (typeof value !== 'object' || value === null) refuse('a chapter must be an object');
	const chapter = value as Record<string, unknown>;
	if (!Array.isArray(chapter['pages'])) refuse('a chapter must carry a pages array');
	const pages = (chapter['pages'] as unknown[]).map((page, at) => {
		if (typeof page !== 'object' || page === null) refuse(`pages[${at}] must be an object`);
		const row = page as Record<string, unknown>;
		if (typeof row['url'] !== 'string') refuse(`pages[${at}].url must be a string`);
		if (!(row['url'] as string).startsWith('https://')) refuse(`pages[${at}].url must be https`);
		const index = Number(row['index']);
		if (!Number.isInteger(index) || index < 0) refuse(`pages[${at}].index must be a whole number`);
		return {
			index,
			url: row['url'] as string,
			...(row['headers'] === undefined
				? {}
				: { headers: readImageHeaders(row['headers'], `pages[${at}].headers`) })
		};
	});
	return {
		pages,
		...(chapter['headersByHost'] === undefined
			? {}
			: { headersByHost: readImageHeadersByHost(chapter['headersByHost'], 'headersByHost') })
	};
}

/** A catalogue page's poster fields, read as a level-3 host must. */
export interface CatalogImages {
	readonly entries: readonly {
		readonly posterImageUrl?: string;
		readonly posterImageHeaders?: ImageHeaders;
	}[];
	readonly imageHeadersByHost?: ImageHeadersByHost;
}

export function readCatalogImages(value: unknown): CatalogImages {
	if (typeof value !== 'object' || value === null) refuse('a catalogue page must be an object');
	const page = value as Record<string, unknown>;
	if (!Array.isArray(page['entries'])) refuse('a catalogue page must carry an entries array');
	const entries = (page['entries'] as unknown[]).map((entry, at) => {
		const row = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
			string,
			unknown
		>;
		const poster = row['posterImageUrl'];
		if (poster !== undefined && typeof poster !== 'string') {
			refuse(`entries[${at}].posterImageUrl must be a string`);
		}
		return {
			...(poster === undefined ? {} : { posterImageUrl: poster as string }),
			...(row['posterImageHeaders'] === undefined
				? {}
				: {
						posterImageHeaders: readImageHeaders(
							row['posterImageHeaders'],
							`entries[${at}].posterImageHeaders`
						)
					})
		};
	});
	return {
		entries,
		...(page['imageHeadersByHost'] === undefined
			? {}
			: {
					imageHeadersByHost: readImageHeadersByHost(
						page['imageHeadersByHost'],
						'imageHeadersByHost'
					)
				})
	};
}

/**
 * What a host may apply image headers for: the plugin's grant.
 *
 * An `<img>` loads without asking anybody, so the grant cannot refuse a plain
 * image. What it decides is whether the host makes the request *on the
 * plugin's behalf* — through its relay, carrying headers a browser will not
 * send — and outside it an image keeps its own url and carries nothing (§9.1:
 * "the image request itself is still refused by the grant").
 */
export interface ImageGrant {
	/** The plugin's `network.hosts` patterns. */
	readonly declared: readonly string[];
}

/** Header names that carry a credential, which a wildcard never hands out. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

function withoutCredentials(headers: ImageHeaders): ImageHeaders {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase()))
	);
}

/**
 * The headers a host sends with one plugin image, or null when it sends none.
 *
 * The one answer to "what does this image go out with", so that a reader and
 * a check asking it get the same one: `https:` only, inside the grant, the
 * image's own headers over the most specific `…ByHost` entry — and a
 * credential only through an exact-host pattern or the image's own map, since
 * `*.cdn.example` names every host that ever answers under it (engine
 * ADR-0005 §3c).
 */
export function grantedImageHeaders(
	url: string,
	own: ImageHeaders | undefined,
	byHost: ImageHeadersByHost | undefined,
	grant: ImageGrant
): ImageHeaders | null {
	let host: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') return null;
		host = parsed.hostname.toLowerCase();
	} catch {
		return null;
	}
	if (!grant.declared.some((pattern) => hostMatches(host, pattern))) return null;
	const scoped =
		byHost === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(byHost).map(([pattern, headers]) => [
						pattern,
						pattern.startsWith('*.') ? withoutCredentials(headers) : headers
					])
				);
	const headers = imageHeadersFor(url, own, scoped);
	return Object.keys(headers).length === 0 ? null : headers;
}
