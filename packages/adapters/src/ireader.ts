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
	// `sourceDir` is either the module's own directory (a renamed module
	// publishes the one it is really in) or — for most entries the current
	// toolchain builds — Gradle's default source set, `main`, *inside* the
	// module beside its `build.gradle.kts`. Read as the module, it sent 63
	// listings of one catalogue to `sources/<lang>/main`, which exists for none
	// of them. Then the package names the module.
	const module = directoryOf(row.pkg);
	const lang = row.lang || 'all';
	if (row.sourceDir === 'main' && module !== null) {
		return { directory: `sources/${lang}/${module}/${row.sourceDir}`, theme: null };
	}
	const directory = row.sourceDir ?? module;
	if (directory === null) return null;
	return { directory: `sources/${lang}/${directory}`, theme: null };
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
			// A module's test source sets are not the extension: their
			// backtick-named test functions are not JavaScript names, and one
			// such file failed a whole bundle at load.
			.filter((url) => !/\/src\/(?:test|androidTest|[a-zA-Z]*Test)\//.test(new URL(url).pathname))
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
import com.fleeksoft.ksoup.nodes.Element
import ireader.core.source.model.BaseExploreFetcher
import ireader.core.source.model.ChapterInfo
import ireader.core.source.model.Command
import ireader.core.source.model.CommandChapterFetch
import ireader.core.source.model.CommandContentFetch
import ireader.core.source.model.CommandDetailFetch
import ireader.core.source.model.CommandList
import ireader.core.source.model.Filter
import ireader.core.source.model.FilterList
import ireader.core.source.model.Listing
import ireader.core.source.model.MangaInfo
import ireader.core.source.model.MangasPageInfo
import ireader.core.source.model.Page
import ireader.core.source.model.Text

class Headers

class HttpRequestBuilder(var url: String) {
    var body: String = ""
    fun header(name: String, value: String): HttpRequestBuilder = this
    fun headers(block: HeadersBuilder.() -> Unit): HttpRequestBuilder = this
    // The base class's \`HttpRequestBuilder.headersBuilder { … }\`, which a
    // request block calls on the builder it is given. Headers are not carried
    // by this client yet (\`Ktor.get\` sends the url), so the block is not run.
    fun headersBuilder(block: HeadersBuilder.() -> Unit = {}): HttpRequestBuilder = this
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

/*
 * Ktor's client over the runtime's OkHttp one, which the source hands it.
 * Inside a class a bare \`client\` is that class's own member and \`Ktor\` has
 * none, so every request this shim made went to an undefined client and
 * nothing reached a site at all.
 */
class Ktor(val http: OkHttpClient) {
    suspend fun submitForm(
        url: String,
        formParameters: Parameters,
        block: HttpRequestBuilder.() -> Unit = {}
    ): KtorResponse {
        val builder = HttpRequestBuilder(url)
        builder.block()
        return KtorResponse(ireaderSend(http, POST(url, null, null)))
    }
    suspend fun get(builder: HttpRequestBuilder): KtorResponse {
        return KtorResponse(ireaderSend(http, GET(builder.url, null)))
    }
}

suspend fun ireaderSend(http: OkHttpClient, request: Request): String {
    val response = http.newCall(request).execute()
    return response.body.string()
}

class BrowserResult(val isSuccess: Boolean, val responseBody: String)

// A plain request where the ecosystem renders the page in a WebView: the
// same document for a site that does not need its scripts run.
class Browser {
    var http: OkHttpClient? = null
    suspend fun fetch(url: String, selector: String = "", timeout: Int = 0): BrowserResult {
        val through = http
        if (through == null) return BrowserResult(false, "")
        return BrowserResult(true, ireaderSend(through, GET(url, null)))
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

/*
 * The base class's \`String.toPage()\` and \`List<String>.toPage()\`: a string
 * is one text page, a list one page each. One function for both receivers,
 * because two file-scope functions of one name cannot share a module.
 */
fun Any.toPage(): Any {
    if (this is List<*>) return this.map { Text(it.toString()) }
    return Text(this.toString())
}

fun logError(message: () -> String) {
    println(message())
}

fun logInfo(message: () -> String) {
    println(message())
}

/*
 * The ecosystem's declarative base, ported member for member from its own
 * \`SourceFactory\`: an extension that declares \`exploreFetchers\`,
 * \`detailFetcher\`, \`chapterFetcher\` and \`contentFetcher\` and overrides
 * nothing else is a whole source, and one that calls \`super.getMangaList\`
 * leans on exactly this. Every default here used to answer an empty list, so
 * those extensions translated, loaded and searched to nothing.
 *
 * Written in the plain Kotlin this build translates (loops and \`if\` where the
 * original reaches for \`buildList\` and \`runCatching\`); the behaviour, the
 * member names and the parameter names are the original's, because subclasses
 * override these members and call them by name.
 */
abstract class SourceFactory(val deps: Dependencies = Dependencies()) {
    var client: Ktor = Ktor(network.client)

    init {
        deps.httpClients.browser.http = network.client
    }
    abstract val lang: String
    abstract val baseUrl: String
    abstract val id: Long
    abstract val name: String

    enum class Type {
        Search,
        Detail,
        Chapters,
        Content,
        Others
    }

    open val exploreFetchers: List<BaseExploreFetcher> get() = emptyList()
    open val detailFetcher: Detail get() = Detail()
    open val chapterFetcher: Chapters get() = Chapters()
    open val contentFetcher: Content get() = Content()

    open fun getFilters(): FilterList = emptyList()
    open fun getCommands(): CommandList = emptyList()
    open fun getListings(): List<Listing> = emptyList()
    open fun getUserAgent(): String = ""
    open fun getCustomBaseUrl(): String = baseUrl

    fun requestBuilder(url: String): HttpRequestBuilder = HttpRequestBuilder(url)

    /* --- lists ------------------------------------------------------------ */

    open fun bookListParse(
        document: Document,
        elementSelector: String,
        baseExploreFetcher: BaseExploreFetcher,
        parser: (Element) -> MangaInfo,
        page: Int
    ): MangasPageInfo {
        val books = mutableListOf<MangaInfo>()
        for (element in document.select(elementSelector)) {
            var book: MangaInfo? = null
            try {
                book = parser(element)
            } catch (e: Exception) {
                book = null
            }
            if (book != null && book.isValid()) books.add(book)
        }
        return MangasPageInfo(books, determineHasNextPage(document, baseExploreFetcher, page))
    }

    fun determineHasNextPage(document: Document, fetcher: BaseExploreFetcher, page: Int): Boolean {
        if (fetcher.infinitePage) return true
        if (fetcher.maxPage != -1) return page < fetcher.maxPage
        val nextPageText = selectorReturnerStringType(document, fetcher.nextPageSelector, fetcher.nextPageAtt).trim()
        val expected = fetcher.nextPageValue
        if (expected != null) return expected == nextPageText
        return nextPageText.isNotBlank()
    }

    open suspend fun getListRequest(
        baseExploreFetcher: BaseExploreFetcher,
        page: Int,
        query: String = ""
    ): Document {
        val url = buildFetcherUrl(baseExploreFetcher, page, query)
        return client.get(requestBuilder(url)).asJsoup()
    }

    fun buildFetcherUrl(fetcher: BaseExploreFetcher, page: Int, query: String = ""): String {
        val endpoint = fetcher.endpoint ?: ""
        val processedQuery = fetcher.onQuery(query)
        val processedPage = fetcher.onPage(page.toString())
        return getCustomBaseUrl() + endpoint.replace("{page}", processedPage).replace("{query}", processedQuery)
    }

    open suspend fun getLists(
        baseExploreFetcher: BaseExploreFetcher,
        page: Int,
        query: String = "",
        filters: FilterList
    ): MangasPageInfo {
        val selector = baseExploreFetcher.selector
        if (selector == null) return MangasPageInfo(emptyList(), false)
        val document = getListRequest(baseExploreFetcher, page, query)
        return bookListParse(document, selector, baseExploreFetcher, { element -> parseMangaFromElement(element, baseExploreFetcher) }, page)
    }

    open fun parseMangaFromElement(element: Element, fetcher: BaseExploreFetcher): MangaInfo {
        val title = fetcher.onName(selectorReturnerStringType(element, fetcher.nameSelector, fetcher.nameAtt).trim(), fetcher.key)
        val link = fetcher.onLink(selectorReturnerStringType(element, fetcher.linkSelector, fetcher.linkAtt).trim(), fetcher.key)
        val url = if (fetcher.addBaseUrlToLink) buildAbsoluteUrl(link) else link
        val image = fetcher.onCover(selectorReturnerStringType(element, fetcher.coverSelector, fetcher.coverAtt).trim(), fetcher.key)
        val cover = if (fetcher.addBaseurlToCoverLink) buildAbsoluteUrl(image) else image
        return MangaInfo(key = url, title = title, cover = cover)
    }

    fun buildAbsoluteUrl(path: String): String {
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        if (path.startsWith("//")) return "https:" + path
        if (baseUrl.isBlank()) return path
        val base = if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://")) baseUrl else "https://" + baseUrl
        if (path.startsWith("/")) return base + path
        if (base.endsWith("/")) return base + path
        return base + "/" + path
    }

    open suspend fun getMangaList(filters: FilterList, page: Int): MangasPageInfo {
        val titleFilter = filters.findInstance<Filter.Title>()
        val sortFilter = filters.findInstance<Filter.Sort>()
        val fetchers = exploreFetchers

        val searched = titleFilter?.value
        if (searched != null && searched.isNotBlank()) {
            val searchFetcher = fetchers.firstOrNull { it.type == Type.Search }
            if (searchFetcher == null) return emptyMangaPage()
            return getLists(searchFetcher, page, searched, filters)
        }

        val sortIndex = sortFilter?.value?.index
        if (sortIndex != null) {
            val sortFetcher = fetchers.filter { it.type != Type.Search }.getOrNull(sortIndex)
            if (sortFetcher == null) return emptyMangaPage()
            return getLists(sortFetcher, page, "", filters)
        }

        // The listing door, \`getMangaList(sort, page)\`: the first fetcher
        // that is not the search one. The driver reaches the shelf through
        // this member with no title, which is the same request.
        val shelf = fetchers.firstOrNull { it.type != Type.Search }
        if (shelf == null) return emptyMangaPage()
        return getLists(shelf, page, "", filters)
    }

    fun emptyMangaPage(): MangasPageInfo = MangasPageInfo(emptyList(), false)

    /* --- chapters --------------------------------------------------------- */

    open fun chapterFromElement(element: Element): ChapterInfo {
        val fetcher = chapterFetcher
        val linked = fetcher.onLink(selectorReturnerStringType(element, fetcher.linkSelector, fetcher.linkAtt).trim())
        val link = if (fetcher.addBaseUrlToLink) buildAbsoluteUrl(linked) else linked
        val name = fetcher.onName(selectorReturnerStringType(element, fetcher.nameSelector, fetcher.nameAtt).trim())
        val translator = fetcher.onTranslator(selectorReturnerStringType(element, fetcher.translatorSelector, fetcher.translatorAtt).trim())
        val releaseDate = fetcher.uploadDateParser(selectorReturnerStringType(element, fetcher.uploadDateSelector, fetcher.uploadDateAtt).trim())
        val numberText = fetcher.onNumber(selectorReturnerStringType(element, fetcher.numberSelector, fetcher.numberAtt).trim())
        val number = numberText.toFloatOrNull() ?: ChapterInfo.extractChapterNumber(name)
        return ChapterInfo(name = name, key = link, number = number, dateUpload = releaseDate, scanlator = translator)
    }

    open fun chaptersParse(document: Document): List<ChapterInfo> {
        val selector = chapterFetcher.selector
        if (selector == null) return emptyList()
        val chapters = mutableListOf<ChapterInfo>()
        for (element in document.select(selector)) {
            var chapter: ChapterInfo? = null
            try {
                chapter = chapterFromElement(element)
            } catch (e: Exception) {
                chapter = null
            }
            if (chapter != null && chapter.isValid()) chapters.add(chapter)
        }
        return chapters
    }

    open suspend fun getChapterListRequest(manga: MangaInfo, commands: List<Command<*>>): Document {
        return client.get(requestBuilder(manga.key)).asJsoup()
    }

    open suspend fun getChapterList(manga: MangaInfo, commands: List<Command<*>>): List<ChapterInfo> {
        val fetched = commands.findInstance<CommandChapterFetch>()
        if (fetched != null) return applyChapterSorting(chaptersParse(Jsoup.parse(fetched.html)))
        val document = getChapterListRequest(manga, commands)
        return applyChapterSorting(chaptersParse(document))
    }

    open fun applyChapterSorting(chapters: List<ChapterInfo>): List<ChapterInfo> {
        if (chapterFetcher.reverseChapterList) return chapters
        return chapters.reversed()
    }

    /* --- details ---------------------------------------------------------- */

    open fun statusParser(text: String): Long = detailFetcher.onStatus(text)

    open fun detailParse(document: Document): MangaInfo {
        val fetcher = detailFetcher
        val title = fetcher.onName(selectorReturnerStringType(document, fetcher.nameSelector, fetcher.nameAtt).trim())
        val image = fetcher.onCover(selectorReturnerStringType(document, fetcher.coverSelector, fetcher.coverAtt).trim())
        val cover = if (fetcher.addBaseurlToCoverLink) buildAbsoluteUrl(image) else image
        val author = fetcher.onAuthor(selectorReturnerStringType(document, fetcher.authorBookSelector, fetcher.authorBookAtt).trim())
        val status = statusParser(selectorReturnerStringType(document, fetcher.statusSelector, fetcher.statusAtt).trim())
        val description = fetcher.onDescription(selectorReturnerListType(document, fetcher.descriptionSelector, fetcher.descriptionBookAtt))
            .filter { it.isNotBlank() }
            .joinToString("\\n\\n")
        val genres = fetcher.onCategory(selectorReturnerListType(document, fetcher.categorySelector, fetcher.categoryAtt))
            .filter { it.isNotBlank() }
        return MangaInfo(key = "", title = title, cover = cover, description = description, author = author, genres = genres, status = status.toInt())
    }

    open suspend fun getMangaDetailsRequest(manga: MangaInfo, commands: List<Command<*>>): Document {
        return client.get(requestBuilder(manga.key)).asJsoup()
    }

    open suspend fun getMangaDetails(manga: MangaInfo, commands: List<Command<*>>): MangaInfo {
        // \`.copy(key = …)\` in the original; \`key\` is a \`var\` here, and setting
        // it is the same value without a named call the two \`copy\`s of this
        // model would leave ambiguous.
        val fetched = commands.findInstance<CommandDetailFetch>()
        val document = if (fetched != null) Jsoup.parse(fetched.html) else getMangaDetailsRequest(manga, commands)
        val details = detailParse(document)
        details.key = manga.key
        return details
    }

    /* --- content ---------------------------------------------------------- */

    open suspend fun getContentRequest(chapter: ChapterInfo, commands: List<Command<*>>): Document {
        return client.get(requestBuilder(chapter.key)).asJsoup()
    }

    open suspend fun getContents(chapter: ChapterInfo, commands: List<Command<*>>): List<Page> {
        return pageContentParse(getContentRequest(chapter, commands))
    }

    open fun pageContentParse(document: Document): List<Page> {
        val fetcher = contentFetcher
        val content = fetcher.onContent(selectorReturnerListType(document, fetcher.pageContentSelector, fetcher.pageContentAtt))
            .filter { it.isNotBlank() }
        val title = fetcher.onTitle(selectorReturnerStringType(document, fetcher.pageTitleSelector, fetcher.pageTitleAtt).trim())
        val pages = mutableListOf<Page>()
        if (title.isNotBlank()) pages.add(Text(title))
        for (paragraph in content) pages.add(Text(paragraph))
        return pages
    }

    open suspend fun getPageList(chapter: ChapterInfo, commands: List<Command<*>>): List<Page> {
        val fetched = commands.findInstance<CommandContentFetch>()
        if (fetched != null) return pageContentParse(Jsoup.parse(fetched.html))
        return getContents(chapter, commands)
    }

    /* --- selectors -------------------------------------------------------- */

    open fun selectorReturnerStringType(element: Element, selector: String? = null, att: String? = null): String {
        try {
            if (selector.isNullOrBlank() && !att.isNullOrBlank()) return element.attr(att)
            if (!selector.isNullOrBlank() && att.isNullOrBlank()) return element.select(selector).text()
            if (!selector.isNullOrBlank() && !att.isNullOrBlank()) return element.select(selector).attr(att)
            return ""
        } catch (e: Exception) {
            return ""
        }
    }

    open fun selectorReturnerListType(element: Element, selector: String? = null, att: String? = null): List<String> {
        try {
            if (selector.isNullOrBlank() && !att.isNullOrBlank()) {
                val value = element.attr(att)
                if (value.isNotBlank()) return listOf(value)
                return emptyList()
            }
            if (!selector.isNullOrBlank() && att.isNullOrBlank()) {
                return element.select(selector).eachText().filter { it.isNotBlank() }
            }
            if (!selector.isNullOrBlank() && !att.isNullOrBlank()) {
                val value = element.select(selector).attr(att)
                if (value.isNotBlank()) return listOf(value)
                return emptyList()
            }
            return emptyList()
        } catch (e: Exception) {
            return emptyList()
        }
    }

    fun chapterUrl(chapter: ChapterInfo): String = chapter.key

    fun chapterName(chapter: ChapterInfo): String = chapter.name

    fun bookUrl(manga: MangaInfo): String = manga.key

    fun bookName(manga: MangaInfo): String = manga.title

    /* --- the declarations ------------------------------------------------- */

    open class Detail(
        val addBaseurlToCoverLink: Boolean = false,
        val nameSelector: String? = null,
        val nameAtt: String? = null,
        val onName: (String) -> String = { it },
        val coverSelector: String? = null,
        val coverAtt: String? = null,
        val onCover: (String) -> String = { it },
        val descriptionSelector: String? = null,
        val descriptionBookAtt: String? = null,
        val onDescription: (List<String>) -> List<String> = { it },
        val authorBookSelector: String? = null,
        val authorBookAtt: String? = null,
        val onAuthor: (String) -> String = { it },
        val categorySelector: String? = null,
        val categoryAtt: String? = null,
        val onCategory: (List<String>) -> List<String> = { it },
        val statusSelector: String? = null,
        val statusAtt: String? = null,
        val onStatus: (String) -> Long = { 0L },
        val type: Type = Type.Detail
    )

    open class Chapters(
        val selector: String? = null,
        val addBaseUrlToLink: Boolean = false,
        val reverseChapterList: Boolean = false,
        val linkSelector: String? = null,
        val onLink: (String) -> String = { it },
        val linkAtt: String? = null,
        val nameSelector: String? = null,
        val nameAtt: String? = null,
        val onName: (String) -> String = { it },
        val numberSelector: String? = null,
        val numberAtt: String? = null,
        val onNumber: (String) -> String = { it },
        val uploadDateSelector: String? = null,
        val uploadDateAtt: String? = null,
        val uploadDateParser: (String) -> Long = { 0L },
        val translatorSelector: String? = null,
        val translatorAtt: String? = null,
        val onTranslator: (String) -> String = { it },
        val type: Type = Type.Chapters
    )

    open class Content(
        val pageTitleSelector: String? = null,
        val pageTitleAtt: String? = null,
        val onTitle: (String) -> String = { it },
        val pageContentSelector: String? = null,
        val pageContentAtt: String? = null,
        val onContent: (List<String>) -> List<String> = { it },
        val type: Type = Type.Content
    )
}

/*
 * The ecosystem writes \`SourceFactory.Detail(…)\` with named arguments, and
 * \`ireaderAliases\` rewrites that spelling to these — in every file, this one
 * included. So the body names the nested class bare: written qualified, it
 * was rewritten into a call to itself, and the first source to read its
 * declarations recursed until the stack ran out.
 */
fun ireaderDetail(
    addBaseurlToCoverLink: Boolean = false,
    nameSelector: String? = null,
    nameAtt: String? = null,
    onName: (String) -> String = { it },
    coverSelector: String? = null,
    coverAtt: String? = null,
    onCover: (String) -> String = { it },
    descriptionSelector: String? = null,
    descriptionBookAtt: String? = null,
    onDescription: (List<String>) -> List<String> = { it },
    authorBookSelector: String? = null,
    authorBookAtt: String? = null,
    onAuthor: (String) -> String = { it },
    categorySelector: String? = null,
    categoryAtt: String? = null,
    onCategory: (List<String>) -> List<String> = { it },
    statusSelector: String? = null,
    statusAtt: String? = null,
    onStatus: (String) -> Long = { 0L },
    type: SourceFactory.Type = SourceFactory.Type.Detail
): SourceFactory.Detail = Detail(
    addBaseurlToCoverLink, nameSelector, nameAtt, onName, coverSelector, coverAtt, onCover,
    descriptionSelector, descriptionBookAtt, onDescription, authorBookSelector, authorBookAtt,
    onAuthor, categorySelector, categoryAtt, onCategory, statusSelector, statusAtt, onStatus, type
)

fun ireaderChapters(
    selector: String? = null,
    addBaseUrlToLink: Boolean = false,
    reverseChapterList: Boolean = false,
    linkSelector: String? = null,
    onLink: (String) -> String = { it },
    linkAtt: String? = null,
    nameSelector: String? = null,
    nameAtt: String? = null,
    onName: (String) -> String = { it },
    numberSelector: String? = null,
    numberAtt: String? = null,
    onNumber: (String) -> String = { it },
    uploadDateSelector: String? = null,
    uploadDateAtt: String? = null,
    uploadDateParser: (String) -> Long = { 0L },
    translatorSelector: String? = null,
    translatorAtt: String? = null,
    onTranslator: (String) -> String = { it },
    type: SourceFactory.Type = SourceFactory.Type.Chapters
): SourceFactory.Chapters = Chapters(
    selector, addBaseUrlToLink, reverseChapterList, linkSelector, onLink, linkAtt, nameSelector,
    nameAtt, onName, numberSelector, numberAtt, onNumber, uploadDateSelector, uploadDateAtt,
    uploadDateParser, translatorSelector, translatorAtt, onTranslator, type
)

fun ireaderContent(
    pageTitleSelector: String? = null,
    pageTitleAtt: String? = null,
    onTitle: (String) -> String = { it },
    pageContentSelector: String? = null,
    pageContentAtt: String? = null,
    onContent: (List<String>) -> List<String> = { it },
    type: SourceFactory.Type = SourceFactory.Type.Content
): SourceFactory.Content = Content(
    pageTitleSelector, pageTitleAtt, onTitle, pageContentSelector, pageContentAtt, onContent, type
)
`;

const IREADER_MODEL = `package ireader.core.source.model

import ireader.core.source.SourceFactory

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

    fun isValid(): Boolean = key.isNotBlank() && title.isNotBlank()

    companion object {
        const val UNKNOWN: Int = 0
        const val ONGOING: Int = 1
        const val COMPLETED: Int = 2
        const val ON_HIATUS: Int = 3
        const val CANCELLED: Int = 4
    }
}

// \`mangas\`, as the ecosystem's own model and the driver's \`__normalisePage\`
// both spell it. Declared \`list\`, every page reached the driver with no
// \`mangas\` on it and every search answered empty.
class MangasPageInfo(val mangas: List<MangaInfo>, val hasNextPage: Boolean)

open class ChapterInfo(
    var name: String = "",
    var key: String = "",
    var number: Float = -1f,
    var dateUpload: Long = 0L,
    var type: Int = 0,
    var scanlator: String = ""
) {
    fun copy(
        name: String = this.name,
        key: String = this.key,
        number: Float = this.number,
        dateUpload: Long = this.dateUpload
    ): ChapterInfo = ChapterInfo(name, key, number, dateUpload, type, scanlator)

    fun isValid(): Boolean = key.isNotBlank() && name.isNotBlank()

    companion object {
        // The ecosystem's own patterns, in its order.
        fun extractChapterNumber(name: String): Float {
            val patterns = listOf(
                Regex("""(?:chapter|ch\\.?|episode|ep\\.?)\\s*(\\d+(?:\\.\\d+)?)""", RegexOption.IGNORE_CASE),
                Regex("""^(\\d+(?:\\.\\d+)?)(?:\\s*[-:.]|\\s+)"""),
                Regex("""第\\s*(\\d+(?:\\.\\d+)?)\\s*[章话]"""),
                Regex("""(\\d+(?:\\.\\d+)?)\\s*화"""),
                Regex("""(\\d+(?:\\.\\d+)?)\\s*話""")
            )
            for (pattern in patterns) {
                val match = pattern.find(name)
                if (match != null) return match.groupValues[1].toFloatOrNull() ?: -1f
            }
            return -1f
        }
    }
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
    val key: String,
    val endpoint: String? = null,
    val selector: String? = null,
    val addBaseUrlToLink: Boolean = false,
    val nextPageSelector: String? = null,
    val nextPageAtt: String? = null,
    val nextPageValue: String? = null,
    val addBaseurlToCoverLink: Boolean = false,
    val linkSelector: String? = null,
    val linkAtt: String? = null,
    val onLink: (String, String) -> String = { url, _ -> url },
    val nameSelector: String? = null,
    val nameAtt: String? = null,
    val onName: (String, String) -> String = { url, _ -> url },
    val coverSelector: String? = null,
    val coverAtt: String? = null,
    val onCover: (String, String) -> String = { url, _ -> url },
    val onQuery: (String) -> String = { query -> query },
    val onPage: (String) -> String = { page -> page },
    val infinitePage: Boolean = false,
    val maxPage: Int = -1,
    val type: SourceFactory.Type = SourceFactory.Type.Others
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
