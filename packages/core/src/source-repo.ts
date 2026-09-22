/**
 * Finding the *source* an extension was built from, and reading it.
 *
 * `contract/plugin-api/FOREIGN.md` §4.1 is why this file exists. The artifact
 * one of these repositories publishes is Android bytecode with the classpath
 * missing, and no amount of work on the container gets the classpath back. The
 * same repository's metadata document, however, routinely points at the
 * repository the artifacts were *built* from — public, and full of readable
 * Kotlin. Reaching that instead of the binary is the difference between
 * "convert this by writing an Android runtime in JavaScript" and "convert this
 * by reading a file", so the link is worth resolving carefully.
 *
 * ## The layout this file knows
 *
 * A stable convention across the ecosystem, and the only thing assumed here:
 *
 * ```
 * src/<lang>/<directory>/build.gradle[.kts]    extName, pkgNameSuffix, themePkg/theme
 * src/<lang>/<directory>/src/…/<Class>.kt      the extension itself
 * lib-multisrc/<theme>/                        the shared template, when there is one
 * lib/<name>/                                  shared helper modules
 * ```
 *
 * `themePkg` is the load-bearing field. An extension that declares one is a
 * thin subclass of a template that dozens of others also subclass, which is
 * precisely the case FOREIGN.md §4.1 identifies as tractable: port the
 * template once by hand, and every extension generated from it converts by
 * reading constants.
 *
 * The two directories beside `src/` are not decoration. `lib-multisrc/<theme>/`
 * holds the method bodies a themed extension inherits and therefore never
 * restates, and `lib/<name>/` holds the stream extractors that `videoListParse`
 * and `getVideoList` delegate to — between them the two commonest reasons a
 * conversion has nothing to convert. Both are named by the extension's own
 * build file: the template by the `themePkg` assignment, the modules by
 * `implementation(project(':lib:<name>'))` calls. Fetching only the extension
 * yields a subclass with no superclass, calling functions that are not there.
 *
 * ## What that costs, and the three things that bound it
 *
 * Fetching three groups instead of one multiplies requests twice over, and both
 * multipliers are closed here rather than left to the caller.
 *
 * The branch is settled once, by probing `build.gradle`, and every template and
 * module URL is built from the ref that answered. Left implicit, a dozen
 * modules would each re-probe two refs across two forge shapes — roughly fifty
 * requests whose only possible outcome is 404.
 *
 * The three groups draw down one shared budget rather than one cap each,
 * because separate caps multiply: a fat template beside a dozen modules is
 * exactly the shape that would multiply them.
 *
 * Transitive module dependencies stop at depth 1. A module may name another in
 * its own build file; following that chain to its end would make this client's
 * request count a property of somebody else's repository. A symbol still
 * unresolved past that depth is the transpiler's to refuse, not this module's
 * to chase.
 *
 * And a shared directory is read **once per repository**, not once per listing,
 * when the caller passes a `SharedCache`. That is the third multiplier and by
 * far the largest: measured over a 254-extension catalogue, the extensions
 * declare 862 module dependencies and 60 templates between them, but only 58
 * distinct modules and 7 distinct templates — so every module's files were
 * being fetched an average of fifteen times to produce the same bytes. With
 * the cache a whole-catalogue conversion pass costs 1,068 file requests
 * instead of 3,268.
 *
 * ## Injection, and why nothing here fetches
 *
 * Every network call arrives as a parameter. The caller owns size caps, https
 * enforcement and the CORS-proxy fallback that a self-hosted forge needs, and a
 * module that reached for `fetch` itself would bypass all three. What is
 * enforced *here* is the part a fetcher cannot enforce: that no URL this
 * module constructs is anything but https, and that a package name out of a
 * foreign index cannot steer a path out of the directory it names.
 *
 * ## Rule 9
 *
 * No repository, site or content source is named. `github.com` and
 * `raw.githubusercontent.com` reach this file only through `git-hosts.ts`,
 * which already names them, and nothing here recognises a host: a source
 * repository is addressed by whatever origin its own metadata gave.
 */

import { DEFAULT_REFS, parseRepositoryUrl, rawCandidates, type GitRepository } from './git-hosts';
import { TreeError } from './git-trees';
import type { TextFetcher } from './adapter';

/** Where one extension's sources sit, in the parts the layout convention fixes. */
export interface SourceLocation {
	/** The source repository, https, normalised to origin/owner/repo. */
	readonly repositoryUrl: string;
	readonly lang: string;
	/** The extension's own directory name under `src/<lang>/`. */
	readonly directory: string;
}

/** One extension's sources, as far as they could be read. */
export interface ExtensionSource {
	readonly buildGradle: string | null;
	/** Path relative to the extension directory → file contents. */
	readonly kotlinFiles: ReadonlyMap<string, string>;
	/** The shared template this extension is generated from, if any. */
	readonly themePackage: string | null;
	/** The template's own Kotlin, keyed relative to `lib-multisrc/<themePkg>/`. */
	readonly themeFiles: ReadonlyMap<string, string>;
	/** Module name → that module's Kotlin, keyed relative to `lib/<name>/`. */
	readonly libModules: ReadonlyMap<string, ReadonlyMap<string, string>>;
	/**
	 * The non-Kotlin files an extension is built *with*, keyed as the classpath
	 * names them: `assets/i18n/messages_en.properties` and its siblings.
	 *
	 * Merged across the template and the extension the way the Android build
	 * merges them — the extension's own copy of a path wins over the library's —
	 * because that is what the artifact a viewer would otherwise install
	 * contains.
	 */
	readonly resources: ReadonlyMap<string, string>;
	/**
	 * The branch that answered, or null when none did.
	 *
	 * Surfaced rather than kept implicit because it is what every template and
	 * module URL was built from, and a caller that fetches anything further from
	 * the same repository should build from it too.
	 */
	readonly resolvedRef: string | null;
}

/** The template and modules one extension shares with the rest of its repository. */
export interface SharedSources {
	readonly themeFiles: ReadonlyMap<string, string>;
	readonly libModules: ReadonlyMap<string, ReadonlyMap<string, string>>;
	/** The shared directories' own `assets/`, merged; see `ExtensionSource`. */
	readonly resources: ReadonlyMap<string, string>;
}

/** Lists every file under one directory URL. See `fetchExtensionSource`. */
export type FileLister = (url: string) => Promise<readonly string[]>;

/** The directory each extension gets its own subdirectory of. */
const EXTENSION_ROOT = 'src';

/** Where the shared templates live. */
const THEME_ROOT = 'lib-multisrc';

/** Where the shared helper modules — the stream extractors — live. */
const LIB_ROOT = 'lib';

/**
 * Build files to probe, in order. The first is the convention; the second
 * exists because a fork that migrated to the Kotlin DSL is still the same
 * layout, and one extra miss is cheaper than not finding the theme.
 */
const BUILD_FILES = ['build.gradle', 'build.gradle.kts'] as const;

/**
 * How many `.kt` files one extension may cost.
 *
 * The caller caps the size of each response; the *count* of responses is
 * decided here, so the cap belongs here too. An extension is a handful of
 * files — a listing that names hundreds is a listing that walked further than
 * it was meant to, and fetching all of it would be this module's fault.
 */
export const MAX_KOTLIN_FILES = 64;

/**
 * How many message files one directory may cost.
 *
 * A template carries one per language it has been translated into; the largest
 * in the measured catalogue carries four. Twelve is room for a repository that
 * translates further, and a bound on one that puts something unexpected under
 * `assets/i18n/`.
 */
export const MAX_RESOURCE_FILES = 12;

/**
 * The resource paths worth a request. See `fetchResourceDirectory`.
 *
 * Anchored at the start so it is `assets/i18n/` *of this directory*, not any
 * path that happens to contain those segments, and the filename is matched
 * whole so a `.properties.bak` beside it is not fetched.
 */
const RESOURCE_PATHS = /^assets\/i18n\/[\w.-]+\.properties$/;

/**
 * The per-group caps, and the shared budget that stops them multiplying.
 *
 * Every number below is provisional until measured against a real catalogue —
 * they are sized from what the layout convention looks like, not from a survey,
 * and the survey is the thing that should replace them.
 *
 * The per-group caps say what one *kind* of directory may reasonably cost: a
 * template is a handful of files more than an extension, a helper module fewer.
 * They are not the safety property. The safety property is `MAX_SOURCE_FILES`,
 * which is smaller than the caps summed, so that a fat template beside a dozen
 * modules costs what one extension is allowed to cost rather than the product
 * of three separate permissions. `MAX_SOURCE_BYTES` is the same argument for
 * response size: the caller caps each response, only this module can cap
 * their total.
 */
export const MAX_THEME_FILES = 48;
export const MAX_LIB_MODULES = 12;
export const MAX_LIB_FILES = 16;
export const MAX_SOURCE_FILES = 160;
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * What is left of the shared budget: responses still allowed, bytes still
 * allowed.
 *
 * Mutable on purpose. The extension, its template and each module are read one
 * after another, and a budget that is copied between them is not a budget.
 * `files` counts *attempts*, not successes — a listing full of names that 404
 * costs requests just the same, and it is the requests that need bounding.
 */
export interface SourceBudget {
	files: number;
	bytes: number;
}

/** A full budget, for a caller reading shared sources on its own. */
export function newSourceBudget(): SourceBudget {
	return { files: MAX_SOURCE_FILES, bytes: MAX_SOURCE_BYTES };
}

/** One shared directory, as far as it was read. */
export interface SharedModule {
	/** Path relative to the directory → file contents. */
	readonly files: ReadonlyMap<string, string>;
	/** The same directory's `assets/`, keyed relative to it. */
	readonly resources: ReadonlyMap<string, string>;
	/** `project(':lib:…')` names in its own build file; empty when it has none. */
	readonly dependencies: readonly string[];
}

/**
 * Shared directories already read, by their raw URL.
 *
 * A template and a module belong to the *repository*, not to the listing that
 * happened to name one first — 254 listings declaring 862 dependencies between
 * them resolve to 58 distinct directories, so a cache turns fifteen identical
 * reads into one. The promise is stored rather than the result, so listings
 * converting concurrently share one read instead of racing into the same
 * requests.
 *
 * Held by the caller rather than by this module, because its lifetime is the
 * caller's: it is a fact about somebody else's repository at one ref, and a
 * module-level one here would outlive the registry that wanted it and would
 * have to be reset from a test.
 */
export type SharedCache = Map<string, Promise<SharedModule>>;

export function newSharedCache(): SharedCache {
	return new Map();
}

/**
 * How many distinct shared directories one cache may remember.
 *
 * Sized above what a real catalogue holds — 58 modules and 7 templates in the
 * measured one — so the cap is a ceiling on a repository that is not one of
 * these rather than a limit the ordinary case runs into. Oldest first, which
 * `Map` gives free through insertion order.
 */
export const MAX_CACHED_SHARED = 128;

/** One path segment that cannot climb out of the directory it names. */
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeSegment(segment: string): boolean {
	return SAFE_SEGMENT.test(segment) && segment !== '.' && segment.indexOf('..') === -1;
}

/** A repository URL, as its parts, or null when it is not https or not one. */
function repositoryOf(url: string): GitRepository | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;
	return parseRepositoryUrl(parsed);
}

/**
 * The canonical form of a repository URL: origin, owner, repo, and the branch
 * it named if it named one.
 *
 * Round-tripping through `parseRepositoryUrl` rather than passing the original
 * string along means a website field pointing at a file, a subdirectory or a
 * branch listing inside the repository still yields the repository — and the
 * branch survives, because somebody who linked a branch meant that branch.
 */
function canonicalUrl(repository: GitRepository): string {
	const base = `${repository.origin}/${repository.owner}/${repository.repo}`;
	return repository.ref === null ? base : `${base}/tree/${repository.ref}`;
}

/**
 * Reads `meta.website` out of a repository metadata document.
 *
 * Null when it names no repository — which is the common case worth being
 * relaxed about, since that field is a free-text homepage as often as it is a
 * source link, and the caller's next move is the same either way.
 */
export function sourceRepositoryOf(repoJsonBody: string): string | null {
	let decoded: unknown;
	try {
		decoded = JSON.parse(repoJsonBody);
	} catch {
		return null;
	}
	if (typeof decoded !== 'object' || decoded === null) return null;

	const meta = (decoded as { meta?: unknown }).meta;
	if (typeof meta !== 'object' || meta === null) return null;

	const website = (meta as { website?: unknown }).website;
	if (typeof website !== 'string' || website.length === 0) return null;

	const repository = repositoryOf(website.trim());
	return repository === null ? null : canonicalUrl(repository);
}

/** The path of one extension's directory, relative to the repository root. */
export function extensionDirectory(location: SourceLocation): string {
	return `${EXTENSION_ROOT}/${location.lang}/${location.directory}`;
}

/** The path of one shared template's directory, relative to the repository root. */
export function themeDirectory(themePackage: string): string {
	return `${THEME_ROOT}/${themePackage}`;
}

/** The path of one shared helper module's directory, relative to the repository root. */
export function libDirectory(name: string): string {
	return `${LIB_ROOT}/${name}`;
}

/**
 * The directory names worth trying for one package, best first.
 *
 * The last segment of a package name usually *is* the directory name, and the
 * ways it is not are small and enumerable: the directory is lowercase where the
 * package segment is not, or one of them separates words the other runs
 * together. Each variant costs a request, so the list is short on purpose —
 * when it misses, `matchDirectory` against a real listing is the answer, not a
 * longer list of guesses.
 */
function directoryCandidates(pkg: string): string[] {
	const segments = pkg.split('.').filter((segment) => segment.length > 0);
	if (segments.length === 0) return [];

	// Checked before the variants are derived rather than after. Stripping a
	// segment down to its letters and digits would launder an unsafe one into a
	// plausible directory name, and a guess made out of input that was already
	// wrong is not a guess worth spending a request on.
	const last = segments[segments.length - 1];
	if (!isSafeSegment(last)) return [];

	const lower = last.toLowerCase();
	return dedupe([last, lower, lower.replace(/[^a-z0-9]+/g, '')]);
}

function dedupe(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (value.length === 0 || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

/**
 * Candidate locations for one extension, best first.
 *
 * Language-major, because the language is the stronger signal: it is stated by
 * the index rather than derived from a package name. `all` is always tried
 * after the stated language, since an extension serving several languages is
 * filed under `all` however its individual sources are labelled.
 *
 * Empty when the repository URL is not an https repository, or when the
 * package name yields no directory name that is safe to put in a path.
 */
export function locationCandidates(
	repositoryUrl: string,
	pkg: string,
	lang: string
): SourceLocation[] {
	const repository = repositoryOf(repositoryUrl);
	if (repository === null) return [];

	const directories = directoryCandidates(pkg);
	if (directories.length === 0) return [];

	const canonical = canonicalUrl(repository);
	// The stated language first, then the two places that disagree with it.
	//
	// An index states `pt-BR` and `zh-hant` where the repository files under
	// `src/pt/` and `src/zh/`, so the stated language alone found nothing and
	// 31 listings — most of one language — were reported as having no source in
	// a repository that was holding it. The base subtag recovers those, and the
	// *package's* own language segment recovers the rest: `…animeextension.pt.
	// animefire` is what the build itself compiled under, which makes it the
	// stronger evidence of the two whenever they differ.
	//
	// Only ever additional candidates, and each is checked against the
	// repository's own file list before a request is spent on it, so a wrong
	// guess costs nothing.
	const langs = dedupe([lang.trim(), baseSubtag(lang), packageLanguage(pkg), 'all']).filter(
		isSafeSegment
	);

	const out: SourceLocation[] = [];
	for (const candidateLang of langs) {
		for (const directory of directories) {
			out.push({ repositoryUrl: canonical, lang: candidateLang, directory });
		}
	}
	return out;
}

/** `pt-BR` and `zh-hant` file under `pt` and `zh`; anything else is itself. */
function baseSubtag(lang: string): string {
	return lang.trim().split(/[-_]/)[0] ?? '';
}

/**
 * The language segment of a package name — `…animeextension.pt.animefire`.
 *
 * Second from the end, because the last is the extension's own directory. An
 * empty string when the name is too short to have one, which `dedupe` drops.
 */
function packageLanguage(pkg: string): string {
	const segments = pkg.split('.').filter((segment) => segment.length > 0);
	return segments.length >= 2 ? segments[segments.length - 2] : '';
}

/** Lowercased and stripped of everything that is not a letter or a digit. */
function normalise(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * The directory in a real listing that belongs to one package, or null.
 *
 * This is the recovery path for the extensions `locationCandidates` cannot
 * guess. Given the names actually present under `src/<lang>/`, it matches
 * exactly, then case-insensitively, then on letters and digits alone, and
 * finally on one name being a prefix or suffix of the other — which is what
 * "the directory carries a suffix the package does not" looks like from here.
 *
 * Ordered by confidence and never by convenience: a merely-overlapping name is
 * only returned when nothing better exists, and the shortest such name wins,
 * because a shorter overlap means less that was ignored to reach it.
 */
export function matchDirectory(names: readonly string[], pkg: string): string | null {
	const segments = pkg.split('.').filter((segment) => segment.length > 0);
	if (segments.length === 0) return null;

	const last = segments[segments.length - 1];
	const wanted = normalise(last);
	if (wanted.length === 0) return null;

	const exact = names.find((name) => name === last);
	if (exact !== undefined) return exact;

	const insensitive = names.find((name) => name.toLowerCase() === last.toLowerCase());
	if (insensitive !== undefined) return insensitive;

	const equivalent = names.find((name) => normalise(name) === wanted);
	if (equivalent !== undefined) return equivalent;

	let overlap: string | null = null;
	for (const name of names) {
		const candidate = normalise(name);
		if (candidate.length === 0) continue;
		if (!candidate.startsWith(wanted) && !wanted.startsWith(candidate)) continue;
		if (overlap === null || name.length < overlap.length) overlap = name;
	}
	return overlap;
}

/** Cuts a known filename off the end of a URL, leaving the directory it is in. */
function directoryOf(fileUrl: string, filename: string): string {
	return fileUrl.slice(0, fileUrl.length - filename.length);
}

const EMPTY_SOURCE: ExtensionSource = {
	buildGradle: null,
	kotlinFiles: new Map(),
	themePackage: null,
	themeFiles: new Map(),
	libModules: new Map(),
	resources: new Map(),
	resolvedRef: null
};

/**
 * Every raw-file URL worth trying for one path, paired with the ref it names.
 *
 * `rawCandidates` knows the forge shapes and deliberately does not report which
 * ref produced which URL; asking it one ref at a time recovers that without
 * this file learning a raw-path layout of its own. The ref the pasted URL named
 * is passed explicitly rather than left on the repository, because
 * `rawCandidates` would otherwise re-prepend it on every call.
 */
function refCandidates(repository: GitRepository, path: string): { ref: string; url: string }[] {
	const refs = dedupe(
		repository.ref === null ? [...DEFAULT_REFS] : [repository.ref, ...DEFAULT_REFS]
	);
	const unpinned: GitRepository = { ...repository, ref: null };

	const out: { ref: string; url: string }[] = [];
	for (const ref of refs) {
		for (const url of rawCandidates(unpinned, path, [ref])) {
			if (!url.startsWith('https://')) continue;
			out.push({ ref, url });
		}
	}
	return out;
}

/**
 * One listed name as a path under `base`, or null when it is not under it.
 *
 * The single place the path-safety rule lives, so that the extension, its
 * template and every module get the same treatment rather than three
 * hand-written approximations of it. A listing is a claim about what is in one
 * directory; an entry that resolves anywhere else — cleartext, another origin,
 * or a climb up the tree — is a URL somebody else chose, and is dropped rather
 * than repaired, because a repaired path is still a path this module did not
 * decide to visit.
 */
function relativeUnder(base: string, name: string): string | null {
	let resolved: URL;
	try {
		resolved = new URL(name, base);
	} catch {
		return null;
	}
	if (resolved.protocol !== 'https:') return null;

	const href = resolved.toString();
	if (!href.startsWith(base)) return null;

	const path = href.slice(base.length);
	return path.length === 0 ? null : path;
}

/**
 * The URL of one directory inside a repository, or null when the path it was
 * built from is not one this module will visit.
 *
 * Every segment comes from a foreign build file, so every segment is checked —
 * before the URL is built, not after, since a name that failed the check has
 * already told you it was not a directory name. The `startsWith` afterwards is
 * belt and braces against a segment rule that ever loosens.
 */
function subdirectoryUrl(rootUrl: string, path: string): string | null {
	const segments = path.split('/');
	if (segments.length === 0 || !segments.every(isSafeSegment)) return null;

	let resolved: URL;
	try {
		resolved = new URL(`${path}/`, rootUrl);
	} catch {
		return null;
	}
	if (resolved.protocol !== 'https:') return null;

	const href = resolved.toString();
	return href.startsWith(rootUrl) ? href : null;
}

/**
 * Reads every `.kt` file under one directory, in order, within two caps.
 *
 * `listing` is what `listFiles` already returned for `base`, when the caller
 * had a reason to list it first — settling a ref, or looking for a build file.
 * Null means list it here. Either way the entries are resolved against `base`
 * and anything not under it is dropped.
 *
 * Sorted before the caps are applied so that the same directory read twice
 * produces the same map in the same order, and so that a cap drops a
 * predictable set rather than whichever files the forge happened to list last.
 */
/**
 * Whether a path inside a shared module is test source rather than the module.
 *
 * Gradle puts tests in their own source root and the extension is not built
 * against them, but this read was "every `.kt` under the directory" — so a
 * library's unit tests were handed to the translator as if they were library
 * code. Three of them declared the same `PACKED_CALL`, which is nothing in
 * Kotlin (separate compilations, and `private` besides) and
 * "Identifier 'PACKED_CALL' has already been declared" once they are emitted
 * into one module. The extension converted with no refusals and died at load.
 *
 * The rest of the damage was quieter: every construct in a test file counted
 * as an obstacle against the extension that merely depended on the library,
 * so the measured blocker ranking was partly a ranking of test code.
 *
 * Matched on a whole segment, so `TestUtils.kt` and a `latest/` directory are
 * untouched — only a source root actually named `test`, `androidTest` or
 * `testFixtures`.
 */
function isTestSource(path: string): boolean {
	return path.split('/').some((segment) => TEST_ROOTS.has(segment));
}

const TEST_ROOTS: ReadonlySet<string> = new Set(['test', 'androidTest', 'testFixtures']);

async function fetchKotlinDirectory(
	base: string,
	listing: readonly string[] | null,
	listFiles: FileLister,
	getText: TextFetcher,
	limit: number,
	budget: SourceBudget
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	if (limit <= 0 || budget.files <= 0 || budget.bytes <= 0) return files;

	let names: readonly string[];
	if (listing === null) {
		// **Not caught.** This used to answer an empty map for any failure at
		// all, and an empty map reaches the adapter as `kotlinFiles.size === 0`
		// — which it reports as "the source could not be found in the repository
		// it is built from". That sentence is about somebody else's repository
		// and it was wrong every time it was produced this way: the forge
		// rate-limiting this address, a tree document past the size cap, the
		// network being down. `TreeError` has carried a `rateLimited` flag for
		// exactly this since the video half hit it, and it never reached a
		// viewer here because of these three lines.
		//
		// A directory that genuinely is not there does not throw — the lister
		// filters a tree it read by prefix and answers `[]` — so everything that
		// reaches here is a failure worth a sentence of its own.
		names = await listFiles(base);
	} else {
		names = listing;
	}

	const wanted: { path: string; url: string }[] = [];
	const seen = new Set<string>();

	for (const name of names) {
		if (!/\.kt$/i.test(name)) continue;
		const path = relativeUnder(base, name);
		if (path === null || seen.has(path) || isTestSource(path)) continue;
		seen.add(path);
		wanted.push({ path, url: `${base}${path}` });
	}

	wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	for (const entry of wanted) {
		if (files.size >= limit || budget.files <= 0 || budget.bytes <= 0) break;
		budget.files -= 1;
		let body: string;
		try {
			body = await getText(entry.url);
		} catch {
			// One unreadable file is not a reason to abandon the rest. The map is
			// what was readable, which may be short of what the listing named.
			continue;
		}
		files.set(entry.path, body);
		budget.bytes -= body.length;
	}
	return files;
}

/**
 * The files a directory holds that are not Kotlin and are still part of it.
 *
 * One pattern, `assets/i18n/*.properties`, and it is deliberately not "every
 * asset". An extension's `assets/` may hold anything its author put there, and
 * an unbounded read of somebody else's directory is the multiplication the
 * header of this file exists to close. What earns its place is the one group
 * the translator can actually use: `keiyoushi.lib.i18n.Intl` reads
 * `assets/i18n/messages_<lang>.properties` through the classloader, and without
 * them the largest template in the catalogue draws every filter label as
 * `[order_by_filter_title]`.
 *
 * They are read at the same time as the Kotlin, out of the same listing, on the
 * same budget — so a directory with no `assets/i18n` costs nothing at all, and
 * one with four languages costs four responses of about two kilobytes.
 */
async function fetchResourceDirectory(
	base: string,
	listing: readonly string[],
	getText: TextFetcher,
	budget: SourceBudget
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	if (budget.files <= 0 || budget.bytes <= 0) return files;

	const wanted: { path: string; url: string }[] = [];
	const seen = new Set<string>();
	for (const name of listing) {
		const path = relativeUnder(base, name);
		if (path === null || seen.has(path) || !RESOURCE_PATHS.test(path)) continue;
		seen.add(path);
		wanted.push({ path, url: `${base}${path}` });
	}
	wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

	for (const entry of wanted) {
		if (files.size >= MAX_RESOURCE_FILES || budget.files <= 0 || budget.bytes <= 0) break;
		budget.files -= 1;
		let body: string;
		try {
			body = await getText(entry.url);
		} catch {
			// As for the Kotlin beside it: one unreadable file is not a reason to
			// abandon the rest. A message file that did not arrive reads as an
			// absent translation, which is a label in brackets rather than a
			// failure — see `PropertyResourceBundle` in the runtime.
			continue;
		}
		files.set(entry.path, body);
		budget.bytes -= body.length;
	}
	return files;
}

/**
 * The build file of an already-listed directory, without probing for it.
 *
 * Reading a module's dependencies is only worth doing when the module's own
 * listing already says it has a build file. Probing both spellings blind would
 * cost two requests per module for the sole purpose of learning nothing, which
 * across a queue of modules is the multiplication this file exists to avoid.
 */
async function readListedBuildFile(
	base: string,
	listing: readonly string[],
	getText: TextFetcher,
	budget: SourceBudget
): Promise<string | null> {
	const paths = new Set<string>();
	for (const name of listing) {
		const path = relativeUnder(base, name);
		if (path !== null) paths.add(path);
	}

	for (const filename of BUILD_FILES) {
		if (!paths.has(filename)) continue;
		if (budget.files <= 0) return null;
		budget.files -= 1;
		try {
			return await getText(`${base}${filename}`);
		} catch {
			return null;
		}
	}
	return null;
}

const EMPTY_MODULE: SharedModule = { files: new Map(), resources: new Map(), dependencies: [] };

/**
 * One shared directory — a template or a module — read once and remembered.
 *
 * The build file is read whatever depth the directory was reached at, which is
 * a change of shape rather than of cost: with the cache it is one request per
 * directory for the whole repository, and it is what lets a module reached
 * first at depth 1 answer for a later listing that reaches it at depth 0
 * without a second read. The *depth bound* stays where it belongs, on whether
 * the dependencies it names are followed.
 *
 * A read that ran out of budget is not remembered. What it produced is a
 * property of one listing's budget rather than of the directory, and caching it
 * would make every later listing inherit a truncation it did not cause.
 */
async function readSharedDirectory(
	base: string,
	limit: number,
	listFiles: FileLister,
	getText: TextFetcher,
	budget: SourceBudget,
	cache: SharedCache | null
): Promise<SharedModule> {
	const cached = cache?.get(base);
	if (cached !== undefined) return await cached;

	const pending = (async (): Promise<SharedModule> => {
		let listing: readonly string[];
		try {
			listing = await listFiles(base);
		} catch (error) {
			// A `themePkg` naming a directory this convention does not put where
			// it is looked for is the ordinary case, and an absent shared module
			// is not a reason to lose the extension.
			//
			// A `TreeError` is not that. It says the forge refused, or the tree
			// document could not be read — facts about the *host*, not about
			// this directory — and swallowing one here loses the template
			// silently, which surfaces as the extension refusing for members the
			// template declares. That is a sentence about the extension that is
			// really about the network.
			if (error instanceof TreeError) throw error;
			return EMPTY_MODULE;
		}

		const files = await fetchKotlinDirectory(base, listing, listFiles, getText, limit, budget);
		const resources = await fetchResourceDirectory(base, listing, getText, budget);
		const declared = await readListedBuildFile(base, listing, getText, budget);
		return {
			files,
			resources,
			dependencies: declared === null ? [] : libDependencies(declared)
		};
	})();

	if (cache !== null) {
		if (cache.size >= MAX_CACHED_SHARED) {
			const oldest = cache.keys().next();
			if (oldest.done !== true) cache.delete(oldest.value);
		}
		cache.set(base, pending);
	}

	const module = await pending;
	// Checked after the read rather than before it: the budget is what this read
	// spent, so only afterwards is it known whether the result is the whole
	// directory or as much of it as this listing could afford.
	if (cache !== null && (budget.files <= 0 || budget.bytes <= 0)) cache.delete(base);
	return module;
}

/**
 * Reads the shared template and helper modules an extension was built against.
 *
 * `rootUrl` is the repository root as raw files, with a trailing slash, at the
 * ref that already answered — never re-probed here, because the whole point of
 * settling the branch on `build.gradle` is that nothing after it has to guess.
 *
 * The queue starts at what the extension declared and at what its template
 * declared — a template's own extractors are the extension's extractors, since
 * the inherited method bodies are the ones that call them — and then grows by
 * exactly one level. What a module found at that level declares is read and
 * not followed: the bound is on the *edge*, not on the read, so the same module
 * reached at depth 0 by the next listing answers from the cache instead of
 * costing a second look at its build file.
 */
export async function fetchSharedSources(
	rootUrl: string,
	themePackage: string | null,
	libNames: readonly string[],
	listFiles: FileLister,
	getText: TextFetcher,
	budget: SourceBudget = newSourceBudget(),
	cache: SharedCache | null = null
): Promise<SharedSources> {
	const themeFiles = new Map<string, string>();
	const libModules = new Map<string, ReadonlyMap<string, string>>();
	const resources = new Map<string, string>();

	const pending: { name: string; depth: number }[] = [];
	const queued = new Set<string>();
	const enqueue = (names: readonly string[], depth: number) => {
		for (const name of names) {
			// Checked here as well as in `libDependencies`, because this function
			// is exported and the names may not have come through it.
			if (!isSafeSegment(name) || queued.has(name)) continue;
			queued.add(name);
			pending.push({ name, depth });
		}
	};
	enqueue(libNames, 0);

	if (themePackage !== null && isSafeSegment(themePackage)) {
		const base = subdirectoryUrl(rootUrl, themeDirectory(themePackage));
		if (base !== null) {
			const template = await readSharedDirectory(
				base,
				MAX_THEME_FILES,
				listFiles,
				getText,
				budget,
				cache
			);
			for (const [path, body] of template.files) themeFiles.set(path, body);
			for (const [path, body] of template.resources) resources.set(path, body);
			enqueue(template.dependencies, 0);
		}
	}

	// Indexed rather than shifted, because `enqueue` appends while this runs and
	// the index is what makes that breadth-first instead of a mutation race.
	for (let index = 0; index < pending.length; index += 1) {
		if (index >= MAX_LIB_MODULES || budget.files <= 0 || budget.bytes <= 0) break;

		const entry = pending[index];
		const base = subdirectoryUrl(rootUrl, libDirectory(entry.name));
		if (base === null) continue;

		const module = await readSharedDirectory(
			base,
			MAX_LIB_FILES,
			listFiles,
			getText,
			budget,
			cache
		);
		if (module.files.size > 0) libModules.set(entry.name, module.files);
		// A module's own assets do not overwrite the template's: the template is
		// read first and is the more specific of the two, exactly as it is for
		// the Kotlin.
		for (const [path, body] of module.resources) {
			if (!resources.has(path)) resources.set(path, body);
		}
		if (entry.depth === 0) enqueue(module.dependencies, 1);
	}

	return { themeFiles, libModules, resources };
}

/**
 * Reads one located extension: its build file, the Kotlin beside it, the
 * template it subclasses and the modules it calls into.
 *
 * `listFiles` is handed the https URL of a directory, with a trailing slash,
 * and must return every file *under* it — recursively, since the sources sit
 * several packages deep — either as paths relative to that URL or as absolute
 * https URLs. Both are accepted; each is resolved against the directory URL and
 * anything that does not come out https is dropped.
 *
 * Finding the build file is also how the branch is settled. The refs are
 * probed once, for `build.gradle`, and every later URL — including every
 * template and module URL — is built from whichever one answered, so a
 * repository on a differently-named default branch costs one extra request
 * rather than one per file across three directory trees.
 *
 * The build file is read twice over for two different things: `themePkg` names
 * the template, and the `project(':lib:…')` calls name the modules. Neither
 * name is trusted — both are foreign strings about to become path segments —
 * and a name that fails is dropped, leaving the rest of the extension readable.
 *
 * Never throws for an extension that is not there. A location that does not
 * exist comes back as an empty result, because the caller's response to that is
 * to try the next candidate, and an exception per miss would make the ordinary
 * path the exceptional one.
 */
export async function fetchExtensionSource(
	location: SourceLocation,
	listFiles: FileLister,
	getText: TextFetcher,
	/**
	 * Shared directories this repository has already given up, if the caller is
	 * keeping any. Null reads every template and module afresh, which is right
	 * for one conversion and wrong for a catalogue of them.
	 */
	cache: SharedCache | null = null
): Promise<ExtensionSource> {
	const repository = repositoryOf(location.repositoryUrl);
	if (repository === null) return EMPTY_SOURCE;
	if (!isSafeSegment(location.lang) || !isSafeSegment(location.directory)) return EMPTY_SOURCE;

	const directory = extensionDirectory(location);

	let buildGradle: string | null = null;
	let directoryUrl: string | null = null;
	let resolvedRef: string | null = null;

	for (const filename of BUILD_FILES) {
		for (const candidate of refCandidates(repository, `${directory}/${filename}`)) {
			try {
				buildGradle = await getText(candidate.url);
			} catch {
				continue;
			}
			directoryUrl = directoryOf(candidate.url, filename);
			resolvedRef = candidate.ref;
			break;
		}
		if (directoryUrl !== null) break;
	}

	let names: readonly string[] = [];

	// A failure aimed at the *host* rather than at one ref, kept while the other
	// refs are tried and thrown if none of them answers. `aniyomi.ts` does the
	// same thing at its own probe, and for the same reason: a branch that does
	// not exist is the ordinary case for one of two candidates, and only both
	// failing means anything — but the forge refusing this address is not that,
	// and reporting it as "no ref worked" is a sentence about the repository.
	let refused: TreeError | null = null;

	if (directoryUrl === null) {
		// No build file. The extension may still be there — the layout only
		// promises one for extensions the build system generates — so the refs
		// get probed a second time, by listing instead of by fetching.
		for (const candidate of refCandidates(repository, `${directory}/`)) {
			let listed: readonly string[];
			try {
				listed = await listFiles(candidate.url);
			} catch (error) {
				if (error instanceof TreeError) refused = error;
				continue;
			}
			if (listed.length === 0) continue;
			directoryUrl = candidate.url;
			resolvedRef = candidate.ref;
			names = listed;
			break;
		}
		if (directoryUrl === null && refused !== null) throw refused;
	} else {
		// **Not caught.** This answered `[]`, and an empty listing reaches the
		// adapter as `kotlinFiles.size === 0`, which it reports as "the source
		// could not be found in the repository it is built from" — a sentence
		// about somebody else's repository that was wrong every time this
		// produced it. One tree document serves every listing in a repository,
		// so when reading it fails they all fail together, and a viewer is told
		// the whole catalogue is missing from a repository it is sitting in.
		//
		// A directory that genuinely is not there does not throw: the lister
		// filters a tree it read by prefix and answers none. Everything that
		// reaches here is a failure that deserves its own sentence — the forge
		// rate-limiting this address (60 requests an hour, unauthenticated,
		// counted per address, and in a browser that address is the viewer's),
		// a tree document past the size cap, the network being down.
		names = await listFiles(directoryUrl);
	}

	if (directoryUrl === null) return EMPTY_SOURCE;

	// The budget is not spent on the ref probe above: that is bounded by the ref
	// list and the forge shapes, both of which are this module's own. What needs
	// bounding is everything a foreign build file can ask for.
	const budget = newSourceBudget();
	const kotlinFiles = await fetchKotlinDirectory(
		directoryUrl,
		names,
		listFiles,
		getText,
		MAX_KOTLIN_FILES,
		budget
	);
	const ownResources = await fetchResourceDirectory(directoryUrl, names, getText, budget);

	const declared = buildGradle === null ? {} : readBuildGradle(buildGradle);
	// Two spellings of one field. The video ecosystem writes `themePkg` in a
	// Groovy `build.gradle`; the manga one writes `theme` in a Kotlin DSL
	// `build.gradle.kts`. Both name a directory under `lib-multisrc/`, both are
	// read the same way, and the layout around them is identical — which is why
	// this file serves both rather than being copied for the second.
	const theme = declared['themePkg'] ?? declared['theme'];
	const themePackage = typeof theme === 'string' && theme.length > 0 ? theme : null;
	const libNames = buildGradle === null ? [] : libDependencies(buildGradle);

	// The extension directory URL ends in the path that built it, so cutting
	// that off is the repository root at the ref that answered. Derived rather
	// than rebuilt, because rebuilding it would mean this file knowing a raw-path
	// layout per forge, which is the knowledge `git-hosts.ts` exists to hold.
	const suffix = `${directory}/`;
	const rootUrl = directoryUrl.endsWith(suffix)
		? directoryUrl.slice(0, directoryUrl.length - suffix.length)
		: null;

	let shared: SharedSources = {
		themeFiles: new Map(),
		libModules: new Map(),
		resources: new Map()
	};
	if (rootUrl !== null && (themePackage !== null || libNames.length > 0)) {
		shared = await fetchSharedSources(
			rootUrl,
			themePackage,
			libNames,
			listFiles,
			getText,
			budget,
			cache
		);
	}

	// The extension's own copy of a path wins, which is the order the Android
	// build merges assets in: an extension that ships its own
	// `messages_en.properties` beside a template's is overriding it, not adding
	// a second one.
	const resources = new Map(shared.resources);
	for (const [path, body] of ownResources) resources.set(path, body);

	return {
		buildGradle,
		kotlinFiles,
		themePackage,
		themeFiles: shared.themeFiles,
		libModules: shared.libModules,
		resources,
		resolvedRef
	};
}

/**
 * Every `name = value` a build file assigns, as strings.
 *
 * Not a Gradle parser and not trying to be. These files are declarative to the
 * point of being a properties list — `extName`, `pkgNameSuffix`,
 * `extVersionCode`, `themePkg` — and everything this module wants is one of
 * those. Values are returned verbatim apart from their quotes, including
 * numbers and `$`-interpolations, because deciding what an unevaluated Gradle
 * expression means is exactly the job this is avoiding.
 *
 * Later assignments win, as they do in Gradle. `ext.` is stripped, so a value
 * set inside an `ext` block and one set through the `ext` object land under the
 * same name.
 */
/**
 * A build file with its comments removed.
 *
 * Shared by both readers, because both have the same failure to avoid: a line
 * somebody commented out is a line somebody decided not to run, and reading it
 * anyway means declaring a field that was retired or fetching a module that was
 * dropped. The `[^:]` before `//` is what keeps a `https://…` inside a string
 * intact — and it is written as a consumed-and-restored group rather than a
 * lookbehind, which ES2020 does not have.
 */
function stripComments(body: string): string {
	return body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

export function readBuildGradle(body: string): Record<string, string> {
	const source = stripComments(body);

	const assignment =
		/(?:^|[\s{;(])(?:(?:def|val|var)\s+)?(?:ext\.)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*('[^']*'|"[^"]*"|[^\s,;})\n]+)/g;

	const out: Record<string, string> = {};
	let match = assignment.exec(source);
	while (match !== null) {
		const value = match[2];
		const quoted = value.length >= 2 && (value[0] === "'" || value[0] === '"');
		out[match[1]] = quoted ? value.slice(1, -1) : value;
		match = assignment.exec(source);
	}
	return out;
}

/**
 * Every helper module a build file declares, as directory names.
 *
 * A reader of its own rather than a use of `readBuildGradle`, because that one
 * matches `name = value` and a dependency is not an assignment: it is a call,
 * inside a block, whose name is an argument. Running the assignment regex over
 * a `dependencies` block finds nothing, which is what the existing test showing
 * exactly that block yielding `{}` records.
 *
 * As unambitious as its neighbour, on purpose. Only the argument is matched —
 * not the configuration it is passed to, not whether the enclosing block is
 * `dependencies`, not whether Gradle would evaluate the line at all. The two
 * spellings differ only in their quotes: Groovy writes
 * `implementation project(':lib:name')` and the Kotlin DSL writes
 * `implementation(project(":lib:name"))`, so matching the argument covers both
 * without this file describing either.
 *
 * A name that is not a single safe path segment is dropped, never repaired.
 * These strings become directory names in a URL, and a module named `../../etc`
 * is a foreign repository asking this client to fetch somewhere of its
 * choosing; trimming it down to something plausible would grant the request in
 * a shape nobody reviewed.
 */
export function libDependencies(buildGradle: string): string[] {
	const source = stripComments(buildGradle);
	const dependency = /project\s*\(\s*['"]:lib:([^'"]*)['"]\s*\)/g;

	const names: string[] = [];
	let match = dependency.exec(source);
	while (match !== null) {
		names.push(match[1]);
		match = dependency.exec(source);
	}
	return dedupe(names).filter(isSafeSegment);
}
