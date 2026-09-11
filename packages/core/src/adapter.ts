/**
 * What every foreign-format adapter is, and the few things they all need.
 *
 * `contract/plugin-api/FOREIGN.md` §2 is normative. The shape is deliberately
 * narrow: an adapter resolves URLs, parses one index into **our**
 * `RepositoryIndex`, and — if its tier allows — turns one listing into bundle
 * bytes. It never stores anything, never installs anything, and never decides
 * whether something is safe.
 *
 * Returning our own index type is the whole trick. A converted repository is
 * not a special kind of repository, so the browse list, the consent sheet and
 * the update path need no knowledge that foreign formats exist.
 */

import type { ObstacleSite } from './obstacles';
import type { FileLister } from './source-repo';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { formatProfile, refusalFor, type ForeignFormat, type ForeignOrigin } from './formats';
import type { WasmLoader, WorkerFactory } from '@plugin-bridge/host/host';
import { plausibleTld } from '@plugin-bridge/host/host-names';

/** Fetches one artifact. Injected so adapters never reach the network alone. */
export type ArtifactFetcher = (url: string) => Promise<Uint8Array>;

/** Fetches one sibling document, for the formats whose index is split in two. */
export type TextFetcher = (url: string) => Promise<string>;

export class ForeignFormatError extends Error {
	/**
	 * What blocked the conversion, named the way the translator names it.
	 *
	 * Carried beside the sentence rather than only inside it, because the two
	 * have different readers. The sentence is for a person deciding whether to
	 * try something else; this is for the scoreboard (ADR-0004 §5), which ranks
	 * refusals **by listings unblocked** — and doing that from prose would mean
	 * a measurement whose accuracy depends on nobody rewording an error.
	 *
	 * Empty for a refusal with nothing structured to say, which is most of them:
	 * a repository that names no source, an artifact that is not there.
	 */
	readonly obstacles: readonly string[];

	/**
	 * The same obstacles, each with the file, member and line it sits on.
	 *
	 * `obstacles` answers *what to build next*, ranked across a catalogue;
	 * this answers *where to start*, and the two are kept apart because only
	 * the first is a measurement. Nothing reads this to decide anything — see
	 * `obstacles.ts` — so an adapter with nothing to say leaves it empty and
	 * loses no behaviour.
	 */
	readonly sites: readonly ObstacleSite[];

	constructor(
		message: string,
		obstacles: readonly string[] = [],
		sites: readonly ObstacleSite[] = []
	) {
		super(message);
		this.name = 'ForeignFormatError';
		this.obstacles = obstacles;
		this.sites = sites;
	}
}

/**
 * Thrown when a body *is* this format and is broken anyway.
 *
 * Separate from `ForeignFormatError` because detection treats that one as "not
 * mine, try the next adapter", which is the wrong answer here: the index was
 * recognised, so moving on can only end in "no repository found there" — a
 * sentence that sends the user looking for a URL problem they do not have.
 */
export class ForeignIndexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ForeignIndexError';
	}
}

const INVALID_PRETRANSLATED =
	'This repository publishes an invalid pretranslated archive descriptor, so the ' +
	'prebuilt implementation it offers cannot be trusted or installed.';

/**
 * What a converter is allowed to reach for.
 *
 * One byte-fetcher was enough while every convertible format shipped a single
 * artifact. Converting from *source* is a different shape: the extension's own
 * files, the template it extends and the modules it depends on are spread
 * across a repository, and finding them means listing directories as well as
 * reading files.
 *
 * Passed as one object rather than three parameters so that adding a capability
 * later does not re-order every adapter's signature — and so an adapter that
 * needs none of them, which is four of the six, keeps ignoring the argument
 * entirely.
 */
export interface ConversionServices {
	/** The artifact a listing points at, as bytes. */
	readonly fetchArtifact: ArtifactFetcher;
	/** Any https document, as text. Bounded by the caller, not by the adapter. */
	readonly getText: TextFetcher;
	/**
	 * Every file under a directory URL.
	 *
	 * Raw file hosting has no directory index, so this is backed by a forge's
	 * tree API — see `git-trees.ts`, and `FOREIGN.md` §0 for the host that
	 * required naming.
	 */
	readonly listFiles: FileLister;
	/**
	 * A second isolate to translate in, when the host has one.
	 *
	 * Optional, and its absence is a supported state rather than a degraded
	 * one: `translateKotlin` does the same work inline and returns the same
	 * answer, which is the contract that lets the specs, the Kotlin survey and
	 * server-side rendering all convert without a `Worker`. What it buys where
	 * it exists is a main thread that keeps painting through a repository
	 * check — see `kotlin/translate-host.ts` for the measurement.
	 *
	 * Here rather than reached for inside the adapter because constructing an
	 * isolate is the host's business (`HOST.md` §5), and because a capability
	 * that arrives with the job cannot be silently different between the
	 * install path and the check path.
	 */
	readonly createTranslateWorker?: WorkerFactory;
	/**
	 * The host's reader for the runtime's own vendored parser artefacts.
	 *
	 * Only the format that translates Kotlin asks for it, and only when it has
	 * to build a parser. Optional for the same reason the isolate is: its
	 * absence is a state a host is allowed to be in, and what it costs is that
	 * one ecosystem refuses by name (`HOST.md` §2.0) rather than that the app
	 * fails to start.
	 *
	 * Here rather than resolved inside `kotlin/grammar.ts` because a runtime
	 * that can locate its own assets has taken a capability nobody granted it —
	 * `HOST.md` §7.1 recorded that as the last one outstanding, and this is it
	 * being granted instead.
	 */
	readonly loadWasm?: WasmLoader;
}

export interface ForeignAdapter {
	readonly format: ForeignFormat;

	/**
	 * Index URLs to try for whatever was pasted, best first.
	 *
	 * Returns an empty array when this adapter has nothing to try for that URL,
	 * which is normal — most adapters have nothing to say about most URLs.
	 */
	candidates(pasted: URL): string[];

	/**
	 * One foreign index, as one of ours.
	 *
	 * **Must throw** `ForeignFormatError` when the body is not this format.
	 * Detection tries adapters in order and takes the first that parses, so an
	 * adapter that politely returns an empty index makes every later adapter
	 * unreachable.
	 */
	parseIndex(body: string, indexUrl: string): RepositoryIndex;

	/**
	 * The same, for a format whose index is genuinely split across two
	 * documents — a metadata file beside the listings, or a manifest that only
	 * points at where the listings are.
	 *
	 * Optional, and defaulted to `parseIndex` by `loadForeignIndex`. Two of the
	 * six formats need it; making every adapter async to serve them would put a
	 * fetcher into parsers that have nothing to fetch.
	 */
	loadIndex?(body: string, indexUrl: string, getText: TextFetcher): Promise<RepositoryIndex>;

	/**
	 * One listing, as `.yorozoplugin` bytes.
	 *
	 * `browse-only` adapters throw their format's refusal sentence. The caller
	 * is expected to have disabled the button already; this is the second door,
	 * for the case where it did not.
	 */
	convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array>;
}

/**
 * A listing that ships a prebuilt implementation, so the converter is not asked
 * to read the published artifact at all.
 */
export interface PretranslatedDescriptor {
	readonly archiveUrl: string;
	readonly sha256: string;
	readonly pluginId: string;
	readonly pluginVersion: string;
}

/**
 * Reads the descriptor a repository publishes beside a listing.
 *
 * Shape only. Whether the descriptor describes *this* listing — its id and its
 * version — is a question the installer asks, because only the installer knows
 * the converted id a bundle will be stored under. Here the job is narrower: a
 * repository that writes the field at all has to have written it properly,
 * checked once where the index is read rather than at each place that later
 * believes it.
 */
export function pretranslatedDescriptor(value: unknown): PretranslatedDescriptor | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== 'object' || Array.isArray(value)) {
		throw new ForeignIndexError(INVALID_PRETRANSLATED);
	}
	const descriptor = value as Record<string, unknown>;
	const archiveUrl = descriptor['archiveUrl'];
	const sha256 = descriptor['sha256'];
	const pluginId = descriptor['pluginId'];
	const pluginVersion = descriptor['pluginVersion'];
	if (
		typeof archiveUrl !== 'string' ||
		// Plain http would let whoever carries the bytes choose the code that
		// runs, and a digest checked over an attacker-chosen archive proves
		// nothing about it.
		!archiveUrl.startsWith('https://') ||
		typeof sha256 !== 'string' ||
		!/^[0-9a-f]{64}$/i.test(sha256) ||
		typeof pluginId !== 'string' ||
		pluginId.length === 0 ||
		typeof pluginVersion !== 'string' ||
		pluginVersion.length === 0
	) {
		throw new ForeignIndexError(INVALID_PRETRANSLATED);
	}
	// Lower-cased here so that every later comparison — against a digest of the
	// downloaded bytes, or against the key a cache was written under — is a
	// comparison of the same spelling.
	return { archiveUrl, sha256: sha256.toLowerCase(), pluginId, pluginVersion };
}

/** Reads an index through whichever of the two methods the adapter provides. */
export function loadForeignIndex(
	adapter: ForeignAdapter,
	body: string,
	indexUrl: string,
	getText: TextFetcher
): Promise<RepositoryIndex> {
	if (adapter.loadIndex !== undefined) return adapter.loadIndex(body, indexUrl, getText);
	return Promise.resolve(adapter.parseIndex(body, indexUrl));
}

/**
 * Drops listings that are not anime, and counts what it dropped.
 *
 * Applied by each adapter as the last step rather than centrally, so that an
 * adapter which cannot tell what medium a listing serves has to say so by
 * choosing a fallback, instead of inheriting a guess made elsewhere.
 */
export function keepAnimeOnly(index: Omit<RepositoryIndex, 'filteredOut'>): RepositoryIndex {
	const anime = index.plugins.filter((listing) => listing.origin?.mediaKind === 'anime');
	return {
		...index,
		plugins: anime,
		filteredOut: index.plugins.length - anime.length
	};
}

/**
 * The refusal a `browse-only` adapter throws, so all six say it the same way.
 */
export function refuseConversion(format: ForeignFormat): never {
	throw new ForeignFormatError(formatProfile(format).refusal ?? 'This format cannot be installed.');
}

/**
 * Whether a listing may be offered for installation at all.
 *
 * Both halves of the answer live in `formats.ts`; this is where a listing is
 * matched against them.
 */
export function listingRefusal(listing: RepositoryPlugin): string | null {
	const origin = listing.origin;
	if (origin === undefined) return null;
	return refusalFor(origin.format, origin.mediaKind, origin.detail);
}

/**
 * The plugin id a converted bundle gets.
 *
 * `app.yorozo.converted.<format>.<sanitised foreign id>`, because:
 *
 * - it is written into stored `SourceBinding`s and so may never change for a
 *   given input, which is why the sanitisation is specified here once rather
 *   than left to each adapter;
 * - two formats carrying a same-named source must not collide;
 * - `converted` in the middle means a converted plugin is visibly converted in
 *   any log that prints only an id.
 *
 * `bundle-store.ts` validates ids against a reverse-DNS pattern whose segments
 * must start with a letter, so a foreign id beginning with a digit gets one.
 */
export function convertedPluginId(format: ForeignFormat, foreignId: string): string {
	const segments = foreignId
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => (/^[0-9]/.test(segment) ? `s${segment}` : segment));

	if (segments.length === 0) {
		throw new ForeignFormatError(`"${foreignId}" has nothing usable as an id.`);
	}
	return `app.yorozo.converted.${format}.${segments.join('_')}`;
}

/**
 * The hosts a converted plugin declares, derived from what the foreign
 * manifest names.
 *
 * This is what the consent screen renders and what `ctx.http` later enforces,
 * so it is deliberately built from *declared* URLs only. It cannot be complete
 * — a scraper reaches wherever its markup points — and the honest consequence
 * is that a converted plugin fails at the host boundary rather than silently
 * reaching somewhere undeclared. Failing there is the point.
 *
 * A wildcard sibling is added per host because content sites move assets and
 * streams onto subdomains constantly, and a plugin that can read a page but not
 * the CDN it references is a plugin that never plays anything.
 */
export function hostsFromUrls(urls: readonly (string | null | undefined)[]): string[] {
	const hosts = new Set<string>();
	for (const raw of urls) {
		if (typeof raw !== 'string' || raw.length === 0) continue;
		let host: string;
		try {
			host = new URL(raw).hostname.toLowerCase();
		} catch {
			continue;
		}
		if (host.length === 0) continue;
		hosts.add(host);
		const wildcard = wildcardFor(host);
		if (wildcard !== null) hosts.add(wildcard);
	}
	return [...hosts].sort();
}

/**
 * The wildcard sibling for a host, or null when granting one would be absurd.
 *
 * Content sites move assets and streams onto subdomains constantly, so a
 * plugin that can read a page but not the CDN it references is a plugin that
 * never plays anything. One wildcard for the registrable parent fixes that:
 * `www.example.com` also grants `*.example.com`.
 *
 * The parent has to actually *be* a registrable domain, though, and the last
 * two labels are not always it. A module seen in the wild reaches a helper
 * endpoint at `<name>.<account>.workers.dev`, and taking its last two labels
 * grants `*.workers.dev` — every Cloudflare Worker anyone has ever deployed.
 * The same goes for `github.io`, `co.uk` and the rest of the shared suffixes.
 * So where the parent is one of those, the wildcard is taken one label deeper,
 * and where there is no deeper label there is no wildcard at all — a bare
 * `workers.dev` names no one and `*.workers.dev` names everyone.
 *
 * Not a full public-suffix list, and it does not need to be. Missing an entry
 * leaves the old over-grant for that one suffix; the list covers the shared
 * hosting domains a scraper actually lands on, which is where the damage is.
 */
export function wildcardFor(host: string): string | null {
	const labels = host.split('.');
	if (labels.length < 2) return null;

	const parent = labels.slice(-2).join('.');
	if (!SHARED_SUFFIXES.has(parent)) {
		return labels.length > 2 ? `*.${parent}` : `*.${host}`;
	}
	// The parent is shared, so the name that means something is one deeper.
	return labels.length > 3 ? `*.${labels.slice(-3).join('.')}` : null;
}

/**
 * Suffixes under which anyone may register, so the label above them is the
 * first one that identifies a party rather than a platform.
 */
const SHARED_SUFFIXES = new Set([
	// Shared application hosting, which is where a scraper's helper endpoints
	// and passthrough proxies actually live.
	'workers.dev',
	'pages.dev',
	'r2.dev',
	'fly.dev',
	'web.app',
	'firebaseapp.com',
	'appspot.com',
	'herokuapp.com',
	'vercel.app',
	'netlify.app',
	'onrender.com',
	'glitch.me',
	'repl.co',
	'surge.sh',
	'github.io',
	'gitlab.io',
	'blogspot.com',
	'sourceforge.io',
	'amazonaws.com',
	'cloudfront.net',
	'azurewebsites.net',
	// Country-code second levels, the long-standing case.
	'co.uk',
	'org.uk',
	'ac.uk',
	'gov.uk',
	'co.jp',
	'ne.jp',
	'or.jp',
	'co.kr',
	'co.in',
	'co.za',
	'co.nz',
	'co.id',
	'co.il',
	'com.au',
	'com.br',
	'com.cn',
	'com.mx',
	'com.ar',
	'com.tr',
	'com.tw',
	'com.hk',
	'com.sg',
	'com.my',
	'com.ph',
	'com.vn',
	'com.pl',
	'com.ua',
	'com.ru'
]);

/**
 * Hostnames a module's own code demonstrably reaches.
 *
 * The manifest names where a source lives; it does not name the half-dozen
 * other places a scraper goes — the API subdomain, the embed host, the CDN the
 * player actually streams from. Deriving the allowlist from the manifest alone
 * therefore produces a plugin that searches fine and is refused the moment it
 * resolves, and the refusal reads as a broken source rather than as our
 * under-declaration.
 *
 * So the module's source is read for the hosts it names and those are declared
 * too. Three properties make this a widening of the consent screen rather than
 * a hole in it:
 *
 * - it is **static**: only hosts written in the code that is about to be
 *   installed, never anything inferred from elsewhere;
 * - it is **shown**: every host and every wildcard lands on the sheet the
 *   viewer approves, in full, before anything is installed;
 * - it is **bounded**: a cap on how many the code may contribute, because a
 *   minified bundle full of unrelated URLs should not turn into a hundred-line
 *   consent screen nobody reads.
 *
 * ## Why it reads more than `https://` literals
 *
 * The first version matched complete absolute URLs only, and that turned out
 * to be most of the reason converted modules were being reported as broken.
 * These modules build their URLs, and there are four shapes of that:
 *
 * 1. `` `https://${server}.example.com/…` `` — an interpolated subdomain. The
 *    literal tail is real and is what the allowlist needs.
 * 2. `const host = "cdn.example.com"` then `"https://" + host` — a bare
 *    hostname in a string, never adjacent to a scheme.
 * 3. `//cdn.example.com/x.m3u8` — protocol-relative, as scraped markup writes
 *    it and as these modules copy it.
 * 4. A subdomain chosen at runtime from a page's contents. Unknowable by
 *    reading, and the reason every host found here now also contributes its
 *    `*.registrable` sibling — which is exactly what `hostsFromUrls` has
 *    always done for the manifest's hosts, and this had inconsistently not
 *    done for the code's.
 *
 * Shapes 1–3 are read; shape 4 is covered by the wildcard where it is a
 * sibling of something named, and missed otherwise. That last case is the
 * honest limit of reading rather than running, and it surfaces as a refusal
 * naming the host rather than as silence.
 */
export function hostsInSource(source: string, limit = 24): string[] {
	const found = new Set<string>();
	// Comments first, and this is not a nicety. A real module carries a block
	// comment documenting the JSON its extractor returns, complete with five
	// invented `https://…example/stream1.m3u8` URLs — which arrived on the
	// consent screen as five hosts and five wildcards, next to the real ones,
	// with nothing to tell a viewer which were which. Prose about a host is not
	// a host.
	source = withoutComments(source);
	const add = (raw: string | undefined): void => {
		if (raw === undefined || found.size >= limit) return;
		const host = raw.toLowerCase().replace(/\.$/, '');
		// A single label is not a host worth granting, and a bare `example.js`
		// is a filename that happens to be shaped like one.
		if (host.split('.').length < 2) return;
		if (!plausibleTld(host)) return;
		found.add(host);
	};

	// An absolute URL, with `${…}` tolerated in the leading labels so an
	// interpolated subdomain still yields its literal tail.
	const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
	const absolute = new RegExp(
		`https?:\\/\\/(?:\\$\\{[^}]*\\}|${label})(?:\\.(?:\\$\\{[^}]*\\}|${label}))*`,
		'gi'
	);
	// Protocol-relative, as scraped markup writes it. Anchored on a quote so a
	// `//` comment or a `http://` already matched above cannot start one.
	const relative = new RegExp(`["'\`]\\/\\/(${label}(?:\\.${label})+)`, 'gi');
	// A quoted string that is nothing but a hostname — `const host =
	// "cdn.example.com"`, which a source then builds a URL out of.
	const bare = new RegExp(`["'\`](${label}(?:\\.${label})+)["'\`]`, 'gi');
	/**
	 * …except when the string is being handed to a selector.
	 *
	 * `selectFirst("div.description")` and `select("font.ep")` are quoted
	 * strings shaped exactly like hostnames, and a scraper is made of them, so
	 * they arrived on the consent screen as hosts. There is no reading of
	 * `div.description` that tells you it is a CSS selector; what tells you is
	 * the call it sits inside, which is why this looks left rather than at the
	 * string.
	 */
	const selectorCall = /\.\s*(?:select|selectFirst|closest|is|has|not|matches)\s*\($/;

	for (const match of source.matchAll(absolute)) {
		add(literalTail(match[0].replace(/^https?:\/\//i, '')));
	}
	for (const match of source.matchAll(relative)) add(match[1]);
	for (const match of source.matchAll(bare)) {
		if (selectorCall.test(source.slice(Math.max(0, match.index - 24), match.index))) continue;
		add(match[1]);
	}

	// The same wildcard expansion the manifest's hosts get. A source that names
	// `cdn.example.com` in its code reaches `cdn2.example.com` the moment the
	// page it scraped says so, and refusing that reads as a broken source.
	const hosts = new Set<string>();
	for (const host of found) {
		hosts.add(host);
		const wildcard = wildcardFor(host);
		if (wildcard !== null) hosts.add(wildcard);
	}
	return [...hosts].sort();
}

/**
 * The same source with its comments blanked out.
 *
 * ## Why it is a scanner and not a regex
 *
 * A regex cannot tell `//` inside a string from the start of a comment, and
 * these modules are made of URLs. So the text is walked, tracking the things
 * that suspend comment syntax.
 *
 * ## Why the damage is bounded to one line
 *
 * The one thing this must never do is desync. A first attempt tracked quotes
 * across the whole file and met this, which is ordinary scraper code:
 *
 * ```js
 * const re = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
 * ```
 *
 * Three double quotes inside a regex literal. Odd parity, so a whole-file
 * scanner enters a string it never leaves, and every `//` in every URL after
 * that line reads as a comment. It silently ate two thirds of the file.
 *
 * Properly telling a regex literal from a division needs the previous
 * significant token, which is most of a JavaScript lexer. Rather than write
 * one, this leans on the grammar: **a single- or double-quoted string may not
 * contain a raw newline**, so that state is reset at every line ending. A line
 * that confuses the scanner therefore confuses it for that line and no
 * further. Template literals and block comments genuinely do span lines, so
 * those two states — and only those — are carried across.
 *
 * The residue is that a line holding a regex with an odd number of quotes may
 * lose a host that shares it. That is the pre-existing under-declaration
 * failure, which surfaces as a refusal naming the host, and is the direction
 * to be wrong in.
 */
function withoutComments(source: string): string {
	const out: string[] = [];
	// Carried across lines, because these two constructs really do span them.
	let inBlock = false;
	let inTemplate = false;

	for (const line of source.split('\n')) {
		// Reset at every line: JavaScript forbids a raw newline inside a '' or
		// "" string, so an unclosed one is a misread rather than a continuation.
		let quote: string | null = null;

		for (let i = 0; i < line.length; i += 1) {
			const char = line[i];

			if (inBlock) {
				if (char === '*' && line[i + 1] === '/') {
					inBlock = false;
					i += 1;
				}
				continue;
			}

			if (inTemplate) {
				out.push(char);
				if (char === '\\') {
					if (i + 1 < line.length) out.push(line[i + 1]);
					i += 1;
				} else if (char === '`') {
					inTemplate = false;
				}
				continue;
			}

			if (quote !== null) {
				out.push(char);
				if (char === '\\') {
					// An escape consumes the next character, so `\"` cannot close.
					if (i + 1 < line.length) out.push(line[i + 1]);
					i += 1;
				} else if (char === quote) {
					quote = null;
				}
				continue;
			}

			if (char === '`') {
				inTemplate = true;
				out.push(char);
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				out.push(char);
				continue;
			}
			if (char === '/' && line[i + 1] === '/') break;
			if (char === '/' && line[i + 1] === '*') {
				inBlock = true;
				i += 1;
				continue;
			}

			out.push(char);
		}

		out.push('\n');
	}

	return out.join('');
}

/**
 * The part of an interpolated host that is actually written down.
 *
 * `${server}.example.com` grants nothing about `${server}`, but `example.com`
 * is a literal in the source and its wildcard sibling covers whatever the
 * placeholder becomes. Leading placeholders are therefore dropped; a *trailing*
 * one leaves nothing nameable, and returns undefined.
 */
function literalTail(host: string): string | undefined {
	const labels = host.split('.');
	while (labels.length > 0 && labels[0].includes('${')) labels.shift();
	if (labels.some((one) => one.includes('${'))) return undefined;
	return labels.length >= 2 ? labels.join('.') : undefined;
}

/**
 * A listing, as an adapter builds one.
 *
 * `sha256` is empty for a foreign listing and the parser tolerates that, since
 * these ecosystems publish no digest. That is a real loss of integrity
 * checking against the artifact host, and `FOREIGN.md` §5 is where the
 * consequence is stated: what a converted install verifies is that the bundle
 * matches the converter's own declaration, not that the artifact matched a
 * publisher's promise.
 */
export function foreignListing(input: {
	id: string;
	name: string;
	description: string;
	version: string;
	author: string;
	language: string | null;
	hosts: readonly string[];
	origin: ForeignOrigin;
	size?: number;
}): RepositoryPlugin {
	return {
		id: input.id,
		name: input.name,
		description: input.description,
		version: input.version,
		author: input.author,
		license: '',
		yorozoPluginApi: 1,
		minimumYorozoVersion: '0.0.0',
		platforms: ['android', 'ios', 'macos', 'windows', 'linux', 'web'],
		capabilities: ['search', 'episodes', 'resolve'],
		permissions: ['network'],
		hosts: input.hosts,
		language: input.language,
		download: input.origin.artifactUrl,
		sha256: '',
		size: input.size ?? 0,
		origin: input.origin
	};
}
