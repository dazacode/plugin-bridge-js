/**
 * IReader repositories — the novel ecosystem this build reaches through the
 * Kotlin front-end, by way of a shim that speaks its dialect.
 *
 * ## Why this file is a translation adapter and not a port
 *
 * IReader's extensions are Kotlin against a Tachiyomi-*shaped* API that is not
 * Tachiyomi: `MangaInfo` rather than `SManga`, `MangasPageInfo` rather than
 * `MangasPage`, a Ktor client rather than okhttp, and a `SourceFactory` that
 * hands back `Text` pages for a chapter rather than image urls. None of that is
 * a different way of describing a site — finding the titles, the chapters and
 * the reading order is the same job — so the front-end reads it and only the
 * names differ.
 *
 * The names are therefore **aliased, not re-implemented**: `ireader-shim.ts`
 * carries the API as Kotlin, which the translator then translates with the
 * extension like any other dependency. That is why `mihon-entry.ts` gained a
 * `dialect` option rather than this file growing a driver of its own: the
 * driver's job (which member to call, in what order, and how to normalise the
 * answer) is exactly the same, and only the spelling of the calls changes.
 *
 * Three aliases are textual and belong in this file, because they are shapes
 * the emitter reads but does not resolve:
 *
 * - `Command.Detail.Fetch()` and its two siblings are nested constructors;
 *   they become top-level `CommandDetailFetch()`.
 * - `Log.error { … }` is a lambda passed to a nested object; it becomes the
 *   top-level `logError { … }`.
 * - `<Class>SourceId.ID` is a KSP-generated object that does not exist in the
 *   tree at all. The index publishes the same number, so it is substituted
 *   from the listing.
 *
 * ## The index is two catalogues in one document
 *
 * Its published `index.json` is an object with `extensions` (Android APKs) and
 * a `js` block whose `sources` carry a `file` and an `initFunction`. The second
 * document, `js-index.json`, is `{version, sources}` with the same entries.
 * Both are read; a listing carrying an `initFunction` is compiled Kotlin for
 * an iOS JavaScriptCore runtime this build has no front-end for, so it is
 * carried as a listing and refused at conversion, by name, rather than handed
 * to the Kotlin path to fail obscurely.
 *
 * ## Where the source is, and why the index does not say
 *
 * An entry names its `pkg` and `sourceDir` but no repository: the index is
 * published on a branch of the *same* repository it is built from. So the
 * source repository is the repository the pasted index lives in, and the
 * directory is `sources/<lang>/<sourceDir>` — or, for a template-built entry,
 * `sources/multisrc/<theme>/<dir>` beside a `main/` that holds the base class.
 * `assetsDir` is what says which, because it is a path and it is published.
 *
 * ## Rule 9
 *
 * No hostname here: `github.com` and `raw.githubusercontent.com` arrive through
 * `git-hosts.ts`, and `example.invalid` appears only in the spec.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates,
	type GitRepository
} from '@plugin-bridge/core/git-hosts';
import { obstacleSites } from '@plugin-bridge/core/obstacles';
import { packageBundle } from '@plugin-bridge/core/package';
import { attributionFrom } from '@plugin-bridge/core/attribution';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** A pasted URL that already names an index file. */
const INDEX_FILE = /(?:^|\/)(?:js-)?index(?:\.min)?\.json$/i;

/** The branch this ecosystem publishes its built catalogue on. */
const INDEX_BRANCH = 'repov2';

/** `ireader.<directory>.<lang>`, which is the whole negative for a row. */
const IREADER_PACKAGE = /^ireader\.[a-z0-9_]+\.[a-z0-9-]+$/i;

interface IreaderRow {
	readonly pkg: string;
	readonly name: string;
	readonly lang: string;
	readonly version: string;
	readonly description: string;
	readonly nsfw: boolean;
	readonly apk: string | null;
	/** The directory under `sources/`, as published. */
	readonly sourceDir: string | null;
	/** `<multisrc>/<theme>/<dir>/assets`, when the entry is template-built. */
	readonly assetsDir: string | null;
	/** Present only on an iOS build, which has no Kotlin front-end here. */
	readonly jsFile: string | null;
	readonly jsInit: string | null;
	readonly id: string | null;
}

function text(value: unknown): string {
	return typeof value === 'string' ? value : '';
}

/**
 * One row, either flavour, or null when it is not a row at all.
 *
 * The two catalogues disagree about `apk` versus `file`, and share `pkg`
 * (`id` on the JavaScript side) plus `name` and `lang`. A row without an
 * identifier is not something an install can be matched against later, and one
 * malformed row must not sink the rest of a catalogue.
 */
function readRow(value: unknown, javascript: boolean): IreaderRow | null {
	if (typeof value !== 'object' || value === null) return null;
	const row = value as Record<string, unknown>;
	const pkg = text(row['pkg']) || text(row['id']);
	if (pkg.length === 0) return null;

	const apk = text(row['apk']) || null;
	const jsFile = text(row['file']) || null;
	const jsInit = text(row['initFunction']) || null;
	if (!javascript && apk === null) return null;
	if (javascript && (jsFile === null || jsInit === null)) return null;

	return {
		pkg,
		name: text(row['name']) || pkg,
		lang: text(row['lang']),
		version: text(row['version']) || text(row['code']) || '0',
		description: text(row['description']),
		nsfw: row['nsfw'] === true || row['nsfw'] === 1,
		apk,
		sourceDir: text(row['sourceDir']) || null,
		assetsDir: text(row['assetsDir']) || null,
		jsFile,
		jsInit,
		id: row['id'] === undefined ? null : String(row['id'])
	};
}

/** The directory name a package implies, when the row names none. */
function directoryOf(pkg: string): string | null {
	const segments = pkg.split('.').filter((segment) => segment.length > 0);
	return segments.length >= 2 ? (segments[1] ?? null) : null;
}

/**
 * Where one entry's Kotlin lives, relative to the repository root.
 *
 * `assetsDir` is the published authority — a template-built entry spells
 * `multisrc/<theme>/<dir>/assets`, and the extension is beside that, with the
 * template's own `main/` next to it. Everything else is
 * `sources/<lang>/<sourceDir>`, and `sourceDir` is preferred over the package
 * segment because a renamed module publishes the directory it is really in.
 */
function sourceDirectory(
	row: IreaderRow
): { readonly directory: string; readonly theme: string | null } | null {
	const published = row.assetsDir;
	if (published !== null) {
		const match = /^multisrc\/([^/]+)\/([^/]+)\/assets\/?$/.exec(published);
		if (match !== null) {
			return { directory: `sources/multisrc/${match[1]}/${match[2]}`, theme: match[1] };
		}
		const home = /^([^/]+)\/([^/]+)\/[^/]+\/assets\/?$/.exec(published);
		if (home !== null) {
			return { directory: `sources/${home[1]}/${home[2]}`, theme: null };
		}
	}
	const directory = row.sourceDir ?? directoryOf(row.pkg);
	if (directory === null) return null;
	return { directory: `sources/${row.lang || 'all'}/${directory}`, theme: null };
}

export const ireaderAdapter: ForeignAdapter = {
	format: 'ireader',

	candidates(pasted: URL): string[] {
		if (looksLikeFile(pasted) || INDEX_FILE.test(pasted.pathname)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// `index.json` first: it is the merged catalogue. `js-index.json` is the
		// iOS-only document, tried after it, and `repo/index.json` the path an
		// older publishing pipeline used.
		return ['index.json', 'js-index.json', 'repo/index.json'].flatMap((path) =>
			rawCandidates(repository, path, [INDEX_BRANCH, ...DEFAULT_REFS])
		);
	},

	/**
	 * Both documented shapes, and nothing else.
	 *
	 * The flat `index.min.json` array is accepted too, recognised by the
	 * `ireader.` package prefix — which is also what keeps an Aniyomi fixture
	 * from being read as one of these. An array whose first row is not an
	 * ireader package is a format refusal, so detection moves on.
	 */
	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		const rows: IreaderRow[] = [];
		if (Array.isArray(decoded)) {
			for (const entry of decoded) {
				const row = readRow(entry, false);
				if (row !== null) rows.push(row);
			}
			if (rows.length === 0 || !IREADER_PACKAGE.test(rows[0].pkg)) {
				throw new ForeignFormatError('not an IReader extension index');
			}
		} else if (typeof decoded === 'object' && decoded !== null) {
			const document = decoded as Record<string, unknown>;
			const extensions = document['extensions'];
			const js = document['js'];
			const javascript = js as Record<string, unknown> | undefined;
			const jsSources = javascript === undefined ? undefined : javascript['sources'];

			if (!Array.isArray(extensions) && !Array.isArray(jsSources)) {
				// `{version, sources}` with no `extensions` is the second document.
				const sources = document['sources'];
				if (!Array.isArray(sources) || document['version'] === undefined) {
					throw new ForeignFormatError('not an IReader extension index');
				}
				for (const entry of sources) {
					const row = readRow(entry, true);
					if (row !== null) rows.push(row);
				}
			} else {
				for (const entry of Array.isArray(extensions) ? extensions : []) {
					const row = readRow(entry, false);
					if (row !== null) rows.push(row);
				}
				for (const entry of Array.isArray(jsSources) ? jsSources : []) {
					const row = readRow(entry, true);
					if (row !== null) rows.push(row);
				}
			}
			if (rows.length === 0) throw new ForeignFormatError('not an IReader extension index');
		} else {
			throw new ForeignFormatError('not an IReader extension index');
		}

		// The source repository is the repository the index is served from. The
		// built catalogue lives on its own branch; the source is on the
		// repository's default one, which `fetchExtensionSource` settles.
		let repository: string | null = null;
		try {
			const parsed = parseRepositoryUrl(new URL(indexUrl));
			if (parsed !== null) repository = `${parsed.origin}/${parsed.owner}/${parsed.repo}`;
		} catch {
			repository = null;
		}

		const apkBase = new URL('apk/', indexUrl);
		const plugins: RepositoryPlugin[] = [];
		for (const row of rows) {
			if (row.apk === null && row.jsFile === null) continue;
			const location = sourceDirectory(row);
			const artifactUrl =
				row.apk === null
					? new URL(row.jsFile ?? '', new URL('js/', indexUrl)).toString()
					: new URL(row.apk, apkBase).toString();

			plugins.push(
				foreignListing({
					id: convertedPluginId('ireader', row.pkg),
					name: row.name,
					description: row.description,
					version: row.version,
					author: '',
					language: row.lang.length > 0 ? row.lang : null,
					hosts: hostsFromUrls([]),
					origin: {
						format: 'ireader',
						artifactUrl,
						foreignId: row.pkg,
						foreignVersion: row.version,
						mediaKind: 'manga',
						mediaKinds: ['manga', 'novel'],
						isNsfw: row.nsfw,
						detail: {
							sourceRepository: repository,
							directory: location?.directory ?? null,
							theme: location?.theme ?? null,
							sourceId: row.id,
							// Set only for the iOS catalogue: the Kotlin path has
							// nothing to read for one of these.
							javascript:
								row.jsInit === null ? null : { file: row.jsFile, initFunction: row.jsInit }
						}
					}
				})
			);
		}

		return keepMediums({
			name: 'IReader extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'ireader'
		});
	},

	/**
	 * Reads the extension's own tree, aliases its dialect, and translates it.
	 *
	 * The template base class is fetched beside the extension when the entry is
	 * template-built: an extension there is a handful of constants over a
	 * `ReadNovelFullScraper` that holds every method, and converting without it
	 * produces a class with no superclass.
	 *
	 * Nothing is guessed past that. A tree with no Kotlin is refused by the file
	 * that is there — a `.js` bundle, or a `.java` source — because handing
	 * either to the Kotlin front-end would fail on a construct rather than on
	 * the fact that the language is wrong.
	 */
	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'ireader') {
			throw new ForeignFormatError('That listing did not come from an IReader repository.');
		}
		const detail = origin.detail ?? {};

		const javascript = detail['javascript'] as Record<string, unknown> | null | undefined;
		if (javascript !== undefined && javascript !== null) {
			throw new ForeignFormatError(
				`${listing.name} is an iOS build: its entry is ${String(javascript['file'] ?? 'a JavaScript bundle')}, ` +
					`initialised by ${String(javascript['initFunction'] ?? 'an init function')}. It is compiled Kotlin ` +
					'for a JavaScriptCore runtime, and this build has no front-end for that artefact.',
				[`a JavaScript bundle (${String(javascript['file'] ?? 'unknown')})`]
			);
		}

		const repositoryUrl =
			typeof detail['sourceRepository'] === 'string' ? detail['sourceRepository'] : '';
		const directory = typeof detail['directory'] === 'string' ? detail['directory'] : '';
		if (repositoryUrl.length === 0 || directory.length === 0) {
			throw new ForeignFormatError(
				`The index does not say where ${listing.name} is built from, and the published artifact ` +
					'is Android bytecode this build cannot read.'
			);
		}

		const repository = parseRepositoryUrl(new URL(repositoryUrl));
		if (repository === null)
			throw new ForeignFormatError(`Where ${listing.name} is built from could not be read.`);

		// The extension, then its template. A tree is listed once per directory
		// and read only for `.kt`: `res/` is hundreds of run-length XML files
		// that nothing reads, and the icons live in the index already.
		const own = await listKotlin(services, repository, directory);
		if (own.length === 0) {
			const flavour = await describeNonKotlin(services, repository, directory);
			throw new ForeignFormatError(
				`${listing.name} carries no Kotlin at ${directory}${flavour === null ? '' : `: ${flavour}`}.`,
				flavour === null ? [] : [flavour]
			);
		}

		const theme = typeof detail['theme'] === 'string' ? detail['theme'] : null;
		const template =
			theme === null
				? []
				: await listKotlin(services, repository, `sources/multisrc/${theme}/main`);

		const sourceId = typeof detail['sourceId'] === 'string' ? detail['sourceId'] : null;
		const files = [...rankEntry(own), ...template, ...shimFiles()].map((file) => ({
			path: file.path,
			source: ireaderAliases(file.source, sourceId)
		}));

		const { translateKotlin } = await import('@plugin-bridge/core/kotlin/translate-host');
		const conversion = await translateKotlin(files, {
			wasm: services.loadWasm,
			createWorker: services.createTranslateWorker
		});

		if (conversion.className === null) {
			throw new ForeignFormatError(
				`No extension class could be read out of ${listing.name}'s source.`
			);
		}
		if (!conversion.complete) {
			const kinds = new Set<string>();
			for (const refusal of conversion.blocking) {
				for (const obstacle of refusal.obstacles) kinds.add(obstacle.kind);
			}
			throw new ForeignFormatError(
				`${listing.name} could not be translated: ${[...kinds].sort().join(', ')}.`,
				[...kinds].sort(),
				obstacleSites(conversion, files)
			);
		}
		if (!conversion.substantive) {
			throw new ForeignFormatError(
				`${listing.name} translates, but none of what it declares is a member this build would ever call.`
			);
		}

		// A standalone source declares `override val baseUrl`; a template-built
		// one passes its site to the template as a constructor argument, one
		// line into the class header. Both are literals this can read, and the
		// header is tried second so a declared override always wins.
		const baseUrl =
			conversion.constants.stringConstants['baseUrl'] ||
			baseUrlFromSupertype(files[0]?.source ?? '');
		if (!baseUrl.startsWith('https://')) {
			throw new ForeignFormatError(
				`${listing.name} declares no https base URL that can be read without running it.`
			);
		}

		const { mihonEntrypoint } = await import('@plugin-bridge/runtime/shims/mihon-entry');
		const entrypointSource = mihonEntrypoint({
			pluginId: listing.id,
			translatedSource: conversion.js,
			className: conversion.className,
			baseUrl,
			lang: conversion.constants.stringConstants['lang'] ?? listing.language ?? '',
			name: conversion.constants.stringConstants['name'] ?? listing.name,
			dialect: 'ireader'
		});

		const hosts = [
			...new Set([...hostsFromUrls([baseUrl]), ...hostsInSource(conversion.js)])
		].sort();
		const credit = attributionFrom({
			sourceRepositoryUrl: repositoryUrl,
			licenseText: null,
			fallbackAuthor: listing.author
		});

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description: 'Converted IReader source.',
			version: listing.version,
			author: credit.author,
			hosts,
			origin,
			entrypointSource,
			usesCookies: true,
			repository: credit.repository,
			authorUrl: credit.authorUrl
		});
	}
};

/** Every `.kt` under one repository directory, listed through the tree API. */
async function listKotlin(
	services: ConversionServices,
	repository: GitRepository,
	directory: string
): Promise<{ path: string; source: string }[]> {
	for (const ref of DEFAULT_REFS) {
		const base = rawCandidates(repository, `${directory}/`, [ref])[0];
		if (base === undefined) continue;
		let listed: readonly string[];
		try {
			listed = await services.listFiles(base);
		} catch {
			continue;
		}
		const wanted = listed
			.filter((url) => /\.kt$/i.test(new URL(url).pathname))
			.map((url) => ({ path: url.slice(base.length), url }))
			.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		if (wanted.length === 0) continue;

		const out: { path: string; source: string }[] = [];
		for (const entry of wanted.slice(0, 64)) {
			try {
				out.push({ path: entry.path, source: await services.getText(entry.url) });
			} catch {
				// One unreadable file is not a reason to lose the rest.
			}
		}
		if (out.length > 0) return out;
	}
	return [];
}

/** The files at that path, named, when none of them is Kotlin. */
async function describeNonKotlin(
	services: ConversionServices,
	repository: GitRepository,
	directory: string
): Promise<string | null> {
	const base = rawCandidates(repository, `${directory}/`, DEFAULT_REFS)[0];
	if (base === undefined) return null;
	let listed: readonly string[];
	try {
		listed = await services.listFiles(base);
	} catch {
		return null;
	}
	const js = listed.find((url) => /\.js$/i.test(new URL(url).pathname));
	if (js !== undefined) return `\`${new URL(js).pathname.split('/').pop()}\` is JavaScript`;
	const java = listed.find((url) => /\.java$/i.test(new URL(url).pathname));
	if (java !== undefined) return `\`${new URL(java).pathname.split('/').pop()}\` is Java`;
	return null;
}

/**
 * The base url a multisrc extension passes its template.
 *
 * Read off the class header, and only when it carries exactly one https
 * literal: this value becomes the plugin's declared host, and picking one of
 * several on the extension's behalf is a guess worth refusing.
 */
function baseUrlFromSupertype(source: string): string {
	// A subclasses-only extension is a header and no body at all, so the scan
	// stops at the class body *or* the end of the file.
	const header = /\bclass\s+\w+\s*(?:\([^)]*\))?\s*:([\s\S]{0,800}?)(?:\{|$)/.exec(source);
	if (header === null) return '';
	const found = [...header[1].matchAll(/"(https:\/\/[^"\s$]+)"/g)].map((one) => one[1]);
	return found.length === 1 ? found[0] : '';
}

/** The file whose class the translator should treat as the extension. */
function rankEntry(files: { path: string; source: string }[]): { path: string; source: string }[] {
	const at = files.findIndex((file) => /@Extension\b/.test(file.source));
	if (at <= 0) return files;
	return [files[at], ...files.filter((_, index) => index !== at)];
}

/* ── the dialect ──────────────────────────────────────────────────────────── */

/**
 * The names the emitter reads but does not resolve, rewritten before it does.
 *
 * Every one is a shape rather than a meaning: a nested constructor, a lambda
 * passed to a nested object, and a KSP-generated id object that is not in the
 * tree. The id is the index's own number — the listing publishes it and the
 * annotation would have hashed it into the same value at build time.
 */
export function ireaderAliases(source: string, sourceId: string | null): string {
	let out = source
		.replaceAll('Command.Detail.Fetch', 'CommandDetailFetch')
		.replaceAll('Command.Chapter.Fetch', 'CommandChapterFetch')
		.replaceAll('Command.Content.Fetch', 'CommandContentFetch')
		.replaceAll('SourceFactory.Detail(', 'ireaderDetail(')
		.replaceAll('SourceFactory.Chapters(', 'ireaderChapters(')
		.replaceAll('SourceFactory.Content(', 'ireaderContent(')
		.replace(/Log\.error\s*\{/g, 'logError {')
		.replace(/Log\.info\s*\{/g, 'logInfo {')
		.replace(/([A-Za-z0-9_.\])]+)\.encodeURLParameter\(\)/g, 'encodeURLParameter($1)')
		.replace(/Parameters\.build\s*\{/g, 'ireaderParameters {');
	if (sourceId !== null && /^\d+$/.test(sourceId)) {
		out = out.replace(/\b[A-Za-z0-9_]+SourceId\.ID\b/g, `${sourceId}L`);
	}
	return out;
}

/**
 * IReader's source API, as Kotlin the translator can read.
 *
 * This is the whole divergence, and it is deliberately written in the
 * ecosystem's own language rather than in JavaScript: forms the extension
 * already writes (`MangaInfo(key = …, title = …)`, `filters.findInstance<T>()`,
 * `SourceFactory.Detail(…)`) resolve against declarations here, so the emitter
 * emits them instead of refusing them by name.
 *
 * Everything that is behaviour is a one-line delegation onto the runtime this
 * bundle already carries: `Ksoup` is jsoup, `client.get` is
 * `client.newCall(GET(…)).execute()`, `Text` pages are carried by the driver.
 * Nothing invents a site and nothing names one.
 *
 * `SourceFactory` also declares the ABI-shaped members the mihon driver calls
 * under its `ireader` dialect (`getChapterList`, `getPageList`), which is why
 * no separate driver exists.
 */
const IREADER_SHIM = `package ireader.core.source

import com.fleeksoft.ksoup.nodes.Document
import ireader.core.source.model.BaseExploreFetcher
import ireader.core.source.model.ChapterInfo
import ireader.core.source.model.Command
import ireader.core.source.model.CommandList
import ireader.core.source.model.Filter
import ireader.core.source.model.FilterList
import ireader.core.source.model.Listing
import ireader.core.source.model.MangaInfo
import ireader.core.source.model.MangasPageInfo
import ireader.core.source.model.Page

class Headers

class HttpRequestBuilder(var url: String) {
    var body: String = ""
    fun header(name: String, value: String): HttpRequestBuilder = this
    fun headers(block: HeadersBuilder.() -> Unit): HttpRequestBuilder = this
    fun url(value: String): HttpRequestBuilder {
        url = value
        return this
    }
    fun setBody(value: String): HttpRequestBuilder {
        body = value
        return this
    }
}

class KtorResponse(val text: String) {
    suspend fun bodyAsText(): String = text
    fun asJsoup(): Document = Jsoup.parse(text)
}

class Ktor {
    suspend fun submitForm(
        url: String,
        formParameters: Parameters,
        block: HttpRequestBuilder.() -> Unit = {}
    ): KtorResponse {
        val builder = HttpRequestBuilder(url)
        builder.block()
        val response = client.newCall(POST(url, null, null)).execute()
        return KtorResponse(response.body.string())
    }
    suspend fun get(builder: HttpRequestBuilder): KtorResponse {
        val response = client.newCall(GET(builder.url, null)).execute()
        return KtorResponse(response.body.string())
    }
}

class BrowserResult(val isSuccess: Boolean, val responseBody: String)

class Browser {
    suspend fun fetch(url: String, selector: String = "", timeout: Int = 0): BrowserResult {
        val response = client.newCall(GET(url, null)).execute()
        return BrowserResult(true, response.body.string())
    }
}

class HttpClients {
    val browser: Browser = Browser()
}

class Dependencies(val httpClients: HttpClients = HttpClients())

inline fun <reified T> List<*>.findInstance(): T? {
    for (item in this) if (item is T) return item
    return null
}

fun ireaderParameters(block: FormBuilder.() -> Unit): Parameters {
    val builder = FormBuilder()
    builder.block()
    return Parameters()
}

fun ireaderFilters(query: String): FilterList {
    val filters = mutableListOf<Filter>()
    val title = Filter.Title()
    title.value = query
    filters.add(title)
    return filters
}

fun encodeURLParameter(value: String): String = value

fun logError(message: () -> String) {
    println(message())
}

fun logInfo(message: () -> String) {
    println(message())
}

abstract class SourceFactory(val deps: Dependencies) {
    var client: Ktor = Ktor()
    abstract val lang: String
    abstract val baseUrl: String
    abstract val id: Long
    abstract val name: String

    object Type {
        val Search: Int = 0
        val Popular: Int = 1
        val Latest: Int = 2
    }

    open val exploreFetchers: List<BaseExploreFetcher> get() = emptyList()
    open val detailFetcher: Detail get() = Detail()
    open val chapterFetcher: Chapters get() = Chapters()
    open val contentFetcher: Content get() = Content()

    open fun getFilters(): FilterList = emptyList()
    open fun getCommands(): CommandList = emptyList()
    open fun getListings(): List<Listing> = emptyList()
    open fun getUserAgent(): String = ""

    fun requestBuilder(url: String): HttpRequestBuilder = HttpRequestBuilder(url)

    open suspend fun getMangaList(filters: FilterList, page: Int): MangasPageInfo {
        val found = exploreFetchers
        if (found.isEmpty()) return MangasPageInfo(emptyList(), false)
        return MangasPageInfo(emptyList(), false)
    }

    open suspend fun getMangaDetails(manga: MangaInfo, commands: List<Command<*>>): MangaInfo = manga

    open suspend fun getChapterList(manga: MangaInfo, commands: List<Command<*>>): List<ChapterInfo> =
        emptyList()

    open suspend fun getPageList(chapter: ChapterInfo, commands: List<Command<*>>): List<Page> =
        emptyList()

    open suspend fun getMangaDetailsRequest(
        manga: MangaInfo,
        commands: List<Command<*>>
    ): Document = Jsoup.parse("")

    open fun chapterFromElement(element: com.fleeksoft.ksoup.nodes.Element): ChapterInfo = ChapterInfo()

    open fun parseMangaFromElement(element: com.fleeksoft.ksoup.nodes.Element): MangaInfo = MangaInfo()

    fun chapterUrl(chapter: ChapterInfo): String = chapter.key

    fun chapterName(chapter: ChapterInfo): String = chapter.name

    fun bookUrl(manga: MangaInfo): String = manga.key

    fun bookName(manga: MangaInfo): String = manga.title

    open class Detail(
        val nameSelector: String = "",
        val authorBookSelector: String = "",
        val authorBookAtt: String = "",
        val categorySelector: String = "",
        val categoryAtt: String = "",
        val descriptionSelector: String = "",
        val coverSelector: String = "",
        val coverAtt: String = "",
        val statusSelector: String = "",
        val statusAtt: String = "",
        val addBaseurlToCoverLink: Boolean = false,
        val onCover: (String) -> String = { it },
        val onCategory: (String) -> String = { it },
        val onDescription: (String) -> String = { it },
        val onStatus: (String) -> Int = { 0 }
    )

    open class Chapters(
        val selector: String = "",
        val nameSelector: String = "",
        val nameAtt: String = "",
        val linkSelector: String = "",
        val linkAtt: String = "",
        val numberSelector: String = "",
        val uploadDateSelector: String = "",
        val reverseChapterList: Boolean = false,
        val addBaseUrlToLink: Boolean = false,
        val onLink: (String) -> String = { it },
        val onName: (String) -> String = { it }
    )

    open class Content(
        val pageTitleSelector: String = "",
        val pageContentSelector: String = "",
        val onTitle: (String) -> String = { it },
        val onContent: (String) -> String = { it }
    )
}

fun ireaderDetail(
    nameSelector: String = "",
    authorBookSelector: String = "",
    authorBookAtt: String = "",
    categorySelector: String = "",
    categoryAtt: String = "",
    descriptionSelector: String = "",
    coverSelector: String = "",
    coverAtt: String = "",
    statusSelector: String = "",
    statusAtt: String = "",
    addBaseurlToCoverLink: Boolean = false,
    onCover: (String) -> String = { it },
    onCategory: (String) -> String = { it },
    onDescription: (String) -> String = { it },
    onStatus: (String) -> Int = { 0 }
): SourceFactory.Detail = SourceFactory.Detail(
    nameSelector, authorBookSelector, authorBookAtt, categorySelector, categoryAtt,
    descriptionSelector, coverSelector, coverAtt, statusSelector, statusAtt,
    addBaseurlToCoverLink, onCover, onCategory, onDescription, onStatus
)

fun ireaderChapters(
    selector: String = "",
    nameSelector: String = "",
    nameAtt: String = "",
    linkSelector: String = "",
    linkAtt: String = "",
    numberSelector: String = "",
    uploadDateSelector: String = "",
    reverseChapterList: Boolean = false,
    addBaseUrlToLink: Boolean = false,
    onLink: (String) -> String = { it },
    onName: (String) -> String = { it }
): SourceFactory.Chapters = SourceFactory.Chapters(
    selector, nameSelector, nameAtt, linkSelector, linkAtt, numberSelector,
    uploadDateSelector, reverseChapterList, addBaseUrlToLink, onLink, onName
)

fun ireaderContent(
    pageTitleSelector: String = "",
    pageContentSelector: String = "",
    onTitle: (String) -> String = { it },
    onContent: (String) -> String = { it }
): SourceFactory.Content = SourceFactory.Content(
    pageTitleSelector, pageContentSelector, onTitle, onContent
)
`;

const IREADER_MODEL = `package ireader.core.source.model

open class MangaInfo(
    var key: String = "",
    var title: String = "",
    var cover: String = "",
    var description: String = "",
    var author: String = "",
    var status: Int = 0,
    var genres: List<String> = emptyList()
) {
    fun copy(
        key: String = this.key,
        title: String = this.title,
        cover: String = this.cover,
        description: String = this.description,
        author: String = this.author,
        status: Int = this.status,
        genres: List<String> = this.genres
    ): MangaInfo = MangaInfo(key, title, cover, description, author, status, genres)

    companion object {
        const val UNKNOWN: Int = 0
        const val ONGOING: Int = 1
        const val COMPLETED: Int = 2
        const val ON_HIATUS: Int = 3
        const val CANCELLED: Int = 4
    }
}

class MangasPageInfo(val list: List<MangaInfo>, val hasNextPage: Boolean)

open class ChapterInfo(
    var name: String = "",
    var key: String = "",
    var number: Float = -1f,
    var dateUpload: Long = 0L,
    var type: Int = 0
) {
    fun copy(
        name: String = this.name,
        key: String = this.key,
        number: Float = this.number,
        dateUpload: Long = this.dateUpload
    ): ChapterInfo = ChapterInfo(name, key, number, dateUpload)
}

open class Page

class Text(val text: String) : Page()

class ImageUrl(val url: String) : Page()

open class Command<T> {
    var html: String = ""
}

open class CommandDetailFetch : Command<String>()

open class CommandChapterFetch : Command<String>()

open class CommandContentFetch : Command<String>()

typealias CommandList = List<Command<*>>

open class IndexedValue(var index: Int = 0)

open class Filter {
    class Title : Filter() {
        var value: String = ""
    }
    class Sort(val name: String = "", val values: Array<String> = emptyArray()) : Filter() {
        var value: IndexedValue? = null
    }
    class Select(val name: String = "", val values: Array<String> = emptyArray()) : Filter() {
        var value: Int = 0
    }
    class CheckBox(val name: String = "") : Filter() {
        var value: Boolean = false
    }
}

typealias FilterList = List<Filter>

open class Listing(val name: String = "")

open class BaseExploreFetcher(
    val name: String = "",
    val endpoint: String = "",
    val selector: String = "",
    val nameSelector: String = "",
    val nameAtt: String = "",
    val linkSelector: String = "",
    val linkAtt: String = "",
    val coverSelector: String = "",
    val coverAtt: String = "",
    val nextPageSelector: String = "",
    val nextPageValue: String = "",
    val type: Int = 0,
    val maxPage: Int = 1,
    val addBaseUrlToLink: Boolean = false,
    val addBaseurlToCoverLink: Boolean = false,
    val onPage: (String) -> String = { it },
    val onQuery: (String) -> String = { it },
    val onCover: (String) -> String = { it }
)
`;

/**
 * The shim files a conversion carries, beside the extension's own.
 *
 * `Ksoup`, the Ktor header builder and `DateParser` are separate files only
 * because Kotlin puts one package in one file; each is a one-line delegation
 * onto the runtime, and every one of them exists because a real extension
 * imports it by name.
 */
function shimFiles(): { path: string; source: string }[] {
	return [
		{ path: 'ireader-shim/source.kt', source: IREADER_SHIM },
		{ path: 'ireader-shim/model.kt', source: IREADER_MODEL },
		{
			path: 'ireader-shim/ksoup.kt',
			source: `package com.fleeksoft.ksoup

import com.fleeksoft.ksoup.nodes.Document

object Ksoup {
    fun parse(html: String): Document = Jsoup.parse(html)
}
`
		},
		{
			path: 'ireader-shim/http.kt',
			source: `package io.ktor.http

class Parameters {
    companion object {
        fun build(block: FormBuilder.() -> Unit): Parameters {
            val builder = FormBuilder()
            builder.block()
            return Parameters()
        }
    }
}

class FormBuilder {
    fun append(name: String, value: String) {}
}

object HttpHeaders {
    const val UserAgent: String = "User-Agent"
    const val CacheControl: String = "Cache-Control"
    const val Referrer: String = "Referer"
    const val Accept: String = "Accept"
    const val Cookie: String = "Cookie"
    const val ContentType: String = "Content-Type"
}

class HeadersBuilder {
    fun append(name: String, value: String) {}
    fun build(): Headers = Headers()
}

class Headers

fun headers(block: HeadersBuilder.() -> Unit): Headers {
    val builder = HeadersBuilder()
    builder.block()
    return builder.build()
}
`
		},
		{
			path: 'ireader-shim/datetime.kt',
			source: `package kotlinx.datetime

fun LocalDate.atStartOfDayIn(zone: TimeZone): Instant = atStartOfDay(zone).toInstant()
`
		},
		{
			path: 'ireader-shim/date.kt',
			source: `package ireader.core.source.helpers

object DateParser {
    fun parse(value: String): Long = Instant.parse(value).toEpochMilli()
}
`
		}
	];
}
