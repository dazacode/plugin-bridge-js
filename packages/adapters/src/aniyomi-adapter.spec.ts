/**
 * Converting an Aniyomi listing, from the repository its extensions are built
 * from.
 *
 * The sibling of `aniyomi-conversion.spec.ts`, and deliberately the other half
 * of it: that file starts from already-translated JavaScript and drives the
 * runtime the bundle carries, so it never asks where the Kotlin came from.
 * This one asks only that, and stops at the archive — the adapter's own job is
 * finding an extension's source in somebody else's repository, deciding
 * whether what it found is worth packaging, and saying why when it is not.
 *
 * ## Why the services are fake and the translation is real
 *
 * `ConversionServices` is the whole of the adapter's reach: one byte-fetcher,
 * one text-fetcher, one directory lister. Supplying all three from a map makes
 * the entire path — the branch probe, the build file, the directory listing,
 * the licence hunt — run exactly as it does in the product, with no network
 * and no forge. The Kotlin below is then genuinely parsed and translated,
 * because the four outcomes this file pins are outcomes of the *pipeline's*
 * verdict, and stubbing that would leave them asserting a mock.
 *
 * The byte-fetcher throws, on purpose. The published artifact for this format
 * is an Android APK whose classpath is not in the file; an adapter that
 * reached for it would be reading the one thing it cannot use, and here that
 * is a failed test rather than a quiet download.
 *
 * ## The four outcomes
 *
 * A conversion refuses in three distinguishable ways and succeeds in one, and
 * the distinction is the product: "we do not know where the source is", "the
 * source is a shell whose real methods are in a base class we could not read",
 * and "this member uses something we cannot translate, and here is which"
 * are three different things for a person to do next.
 *
 * Nothing here touches the network and no real repository or streaming host
 * appears (AGENTS.md rule 9); `example.invalid` is reserved by RFC 2606.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { aniyomiAdapter, forgetCachedLicences } from '@plugin-bridge/adapters/aniyomi';
import type { ConversionServices } from '@plugin-bridge/core/adapter';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** The vendored parser artefacts, read the way a host reads them. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url)))
	);
}

/* ── the repository the extensions are built from ─────────────────────────── */

/**
 * A self-hosted forge rather than the one everybody uses.
 *
 * `git-hosts.ts` builds two raw-path shapes for an origin it does not
 * recognise and one for GitHub, and the unrecognised case is both the harder
 * one and the one nothing else exercises end to end.
 */
const FORGE = 'https://forge.example.invalid';
const REPOSITORY = `${FORGE}/owner/animeextensions`;

/** The raw prefix this fake forge serves, at the branch that answers. */
const RAW = `${REPOSITORY}/raw/branch/main/`;

const PACKAGE = 'org.example.animeextension.en.example';

/**
 * A build file with nothing shared in it.
 *
 * No `themePkg` and no `project(':lib:…')`, so the conversion reads this
 * extension and stops. A themed extension is a different measurement — one
 * that `FOREIGN.md` §4.1 makes and this file would only re-make badly.
 */
const BUILD_GRADLE = `
ext {
    extName = 'Example Anime'
    extClass = '.ExampleAnime'
    extVersionCode = 3
}

apply from: "$rootDir/common.gradle"
`;

/** An extension that declares something the host actually calls. */
const EXTENSION_KT = `
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl = "https://watch.example.invalid"
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun popularAnimeNextPageSelector() = "a.next"
}
`;

/**
 * The same extension with every method taken away.
 *
 * This is what a themed extension's own file looks like: two constants and a
 * flag, with every method it runs inherited from a template that is not in the
 * directory. Everything it declares translates, so a converter that asked only
 * "did anything fail" would package it.
 */
const SHELL_KT = `
package ${PACKAGE}

class ExampleAnime : AnimeStream(
    "en",
    "Example Anime",
    "https://watch.example.invalid",
) {
    override val supportsLatest = false
}
`;

/** An extension whose stream path needs a browser. */
const UNTRANSLATABLE_KT = `
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl = "https://watch.example.invalid"
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun videoListParse(response: Response): List<Video> {
        val view = WebView(context)
        return parseFrom(view)
    }
}
`;

/** A refusal with more than four distinct obstacles, for its full explanation. */
const MANY_OBSTACLES_KT = `
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl = "https://watch.example.invalid"
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun videoListParse(response: Response): List<Video> {
        val view = WebView(context)
        val thread = Thread.currentThread()
        val cipher = Cipher.getInstance("AES")
        val engine = QuickJs()
        val file = FileInputStream("fixture")
        return parseFrom(view)
    }
}
`;

/* ── a shared module, and the two directions reachability has to get right ── */

/** The module name the build file below names, and its directory. */
const MODULE = 'examplehostextractor';

/**
 * The same build file, plus one `lib/` dependency.
 *
 * `FOREIGN.md` §4.1.3: a per-host stream extractor may not be shipped here, so
 * it is fetched out of the catalogue and translated on the device. The name is
 * deliberately not a real one — nothing in this repository may name a video
 * host, in code, comments, tests or fixtures alike (AGENTS.md rule 9).
 */
const BUILD_GRADLE_WITH_MODULE = `
ext {
    extName = 'Example Anime'
    extClass = '.ExampleAnime'
    extVersionCode = 3
}

dependencies {
    implementation(project(':lib:${MODULE}'))
}

apply from: "$rootDir/common.gradle"
`;

/**
 * An extension whose stream path delegates to that module.
 *
 * This is the majority shape of the catalogue and the reason this whole path
 * exists: `videoListParse` is two lines, and both of them are somebody else's
 * file.
 */
const EXTENSION_WITH_MODULE_KT = `
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl = "https://watch.example.invalid"
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun popularAnimeNextPageSelector() = "a.next"

    override fun videoListParse(response: Response): List<Video> {
        return ExampleHostExtractor().videosFromPage(response.asJsoup())
    }
}
`;

/**
 * The module, with one member the extension calls and one it never does.
 *
 * `deepProbe` needs a browser, which nothing in a sandbox can supply. Nothing
 * reachable names it, so whether it blocks is the whole question this fixture
 * asks — and the answer has to be no, or 84 extensions stay refused for a
 * method they do not call.
 */
const MODULE_KT = `
package eu.example.lib.${MODULE}

class ExampleHostExtractor {
    fun videosFromPage(document: Document): List<Video> {
        val src = document.selectFirst("source")!!.attr("src")
        return listOf(Video(src, "Default", src))
    }

    fun deepProbe(url: String): List<Video> {
        val view = WebView(context)
        return parseFrom(view)
    }
}
`;

/**
 * The same module with the member the extension *does* call made
 * untranslatable.
 *
 * The other direction, and the one that matters more. A converted bundle whose
 * extractor silently returned nothing would resolve to a placeholder and fail
 * at the fifth install step, on somebody's phone, instead of here.
 */
const MODULE_UNREACHABLE_OK_KT = `
package eu.example.lib.${MODULE}

class ExampleHostExtractor {
    fun videosFromPage(document: Document): List<Video> {
        val view = WebView(context)
        return parseFrom(view)
    }

    fun deepProbe(url: String): List<Video> {
        val src = url
        return listOf(Video(src, "Default", src))
    }
}
`;

/* ── an `AnimeSourceFactory`: several languages, one class, no baseUrl on it ── */

const BUILD_GRADLE_FACTORY = `
ext {
    extName = 'Example Anime'
    extClass = '.ExampleAnimeFactory'
    extVersionCode = 3
}

apply from: "$rootDir/common.gradle"
`;

/** Names which class it builds; declares no `baseUrl` of its own. */
const EXTENSION_FACTORY_KT = `
package ${PACKAGE}

class ExampleAnimeFactory : AnimeSourceFactory {
    override fun createSources() = listOf(
        ExampleAnime("en"),
        ExampleAnime("fr"),
    )
}
`;

/** What the factory above actually builds, one instance per language. */
const EXTENSION_FACTORY_TARGET_KT = `
package ${PACKAGE}

class ExampleAnime(override val lang: String) : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl = "https://watch.example.invalid"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun popularAnimeNextPageSelector() = "a.next"
}
`;

function repositoryFactory(): Map<string, string> {
	return new Map([
		['LICENSE', LICENCE],
		['src/en/example/build.gradle', BUILD_GRADLE_FACTORY],
		['src/en/example/ExampleAnimeFactory.kt', EXTENSION_FACTORY_KT],
		['src/en/example/ExampleAnime.kt', EXTENSION_FACTORY_TARGET_KT]
	]);
}

/**
 * The first paragraph of a real licence, which is all `spdxFromLicenseText`
 * reads. Carrying the whole of one here would be four hundred lines of fixture
 * asserting nothing the first line does not.
 */
const LICENCE = `                                 Apache License
                           Version 2.0, January 2004

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
`;

/* ── the fake forge ───────────────────────────────────────────────────────── */

/**
 * One repository, as paths, at one branch.
 *
 * Only `main` answers. `master` is tried first for some repositories and
 * second for others, and a fake that served both would hide a candidate order
 * that had started asking for the wrong branch.
 */
function repositoryFiles(extension: string): Map<string, string> {
	return new Map([
		['LICENSE', LICENCE],
		['src/en/example/build.gradle', BUILD_GRADLE],
		['src/en/example/ExampleAnime.kt', extension]
	]);
}

/** The same repository with a `lib/` module beside it, and a build file naming it. */
function repositoryWithModule(module: string): Map<string, string> {
	return new Map([
		['LICENSE', LICENCE],
		['src/en/example/build.gradle', BUILD_GRADLE_WITH_MODULE],
		['src/en/example/ExampleAnime.kt', EXTENSION_WITH_MODULE_KT],
		[`lib/${MODULE}/ExampleHostExtractor.kt`, module]
	]);
}

/**
 * Services backed by that map, and by nothing else.
 *
 * `listFiles` returns absolute URLs on the host it was asked about, because
 * that is what `createTreeLister` returns and what `source-repo.ts` checks its
 * answers against — handing back bare names would pass here and fail against
 * the real lister.
 */
function services(
	files: Map<string, string>,
	fetched: string[] = [],
	/** The raw prefix this fake serves, so a GitHub-shaped one can be tried too. */
	raw: string = RAW
): ConversionServices {
	const pathOf = (url: string): string | null =>
		url.startsWith(raw) ? url.slice(raw.length) : null;

	return {
		// The host's job, not the runtime's: `loadKotlinGrammar` takes a loader
		// and this spec is its own host (`HOST.md` §2.2). Without it the
		// translator refuses by name, which is what a host with no copy of the
		// grammar should see.
		loadWasm: vendorWasm,
		fetchArtifact: () => {
			// The APK is Android bytecode with its classpath missing. Reaching
			// for it is the mistake this format's whole design avoids, so it is
			// a failure here rather than a wasted request in the product.
			throw new Error('the published artifact must never be fetched for this format');
		},
		getText: async (url: string) => {
			fetched.push(url);
			const path = pathOf(url);
			const body = path === null ? undefined : files.get(path);
			if (body === undefined) throw new Error(`nothing at ${url}`);
			return body;
		},
		listFiles: async (url: string) => {
			const prefix = pathOf(url);
			if (prefix === null) return [];
			return [...files.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => `${raw}${path}`);
		}
	};
}

/* ── the listing, built through the adapter's own parsers ─────────────────── */

const INDEX_URL = 'https://repo.example.invalid/repo/index.min.json';

const INDEX_BODY = JSON.stringify([
	{
		name: 'Aniyomi: Example Anime',
		pkg: PACKAGE,
		apk: 'example-anime-v14.3.apk',
		lang: 'en',
		code: 3,
		version: '14.3',
		nsfw: 0,
		sources: [
			{
				name: 'Example Anime',
				lang: 'en',
				baseUrl: 'https://watch.example.invalid'
			}
		]
	}
]);

const PRETRANSLATED = {
	archiveUrl: 'https://bundle.example.invalid/example.yorozoplugin',
	sha256: 'AB'.repeat(32),
	pluginId: 'org.example.yorozo.example',
	pluginVersion: '1.2.3'
};

/**
 * The listing as the browse list would hold it: parsed, then enriched by the
 * sibling metadata that names the source repository.
 *
 * Built through `loadIndex` rather than hand-written so that the field the
 * converter depends on gets there the way it does in the product. A fixture
 * that set `sourceRepository` directly would still pass if `loadIndex` stopped
 * recording it.
 */
async function listing(repository: string = REPOSITORY): Promise<RepositoryPlugin> {
	const index = await aniyomiAdapter.loadIndex!(INDEX_BODY, INDEX_URL, async (url: string) => {
		if (!url.endsWith('/repo.json')) throw new Error(`nothing at ${url}`);
		return JSON.stringify({
			meta: { name: 'Example extensions', website: repository }
		});
	});
	return index.plugins[0];
}

/** The same listing with the one field the converter needs taken back off. */
function withoutSourceRepository(one: RepositoryPlugin): RepositoryPlugin {
	const origin = one.origin!;
	const detail = { ...(origin.detail ?? {}) };
	delete detail['sourceRepository'];
	return { ...one, origin: { ...origin, detail } };
}

/** One listing through one shared set of services, so caches persist. */
async function convertWith(one: RepositoryPlugin, shared: ConversionServices): Promise<void> {
	try {
		await aniyomiAdapter.convert(one, shared);
	} catch {
		// Counting requests, not asserting the conversion.
	}
}

async function convert(extension: string, fetched: string[] = []): Promise<Uint8Array> {
	return await aniyomiAdapter.convert(
		await listing(),
		services(repositoryFiles(extension), fetched)
	);
}

/* ── the tests ────────────────────────────────────────────────────────────── */

/**
 * A licence is cached per source repository for the session, which is right in
 * the product — one repository, one licence, however many listings — and wrong
 * inside a test file, where the next case would see a fetch the previous one
 * already made and conclude it never happened.
 */
beforeEach(() => {
	forgetCachedLicences();
});

describe('finding the source at all', () => {
	it('preserves a valid pretranslated archive descriptor', () => {
		const body = JSON.stringify([
			{
				...JSON.parse(INDEX_BODY)[0],
				pretranslated: PRETRANSLATED
			}
		]);

		const origin = aniyomiAdapter.parseIndex(body, INDEX_URL).plugins[0].origin;
		expect(origin?.detail?.['pretranslated']).toEqual({
			...PRETRANSLATED,
			sha256: PRETRANSLATED.sha256.toLowerCase()
		});
	});

	it.each([
		['archiveUrl', { ...PRETRANSLATED, archiveUrl: 'http://bundle.example.invalid/plugin' }],
		['sha256', { ...PRETRANSLATED, sha256: 'not-a-digest' }],
		['pluginId', { ...PRETRANSLATED, pluginId: '' }],
		['pluginVersion', { ...PRETRANSLATED, pluginVersion: '' }],
		['object', 'not-an-object']
	])('rejects a malformed pretranslated descriptor (%s)', (_field, descriptor) => {
		const body = JSON.stringify([
			{
				...JSON.parse(INDEX_BODY)[0],
				pretranslated: descriptor
			}
		]);

		expect(() => aniyomiAdapter.parseIndex(body, INDEX_URL)).toThrow(
			/invalid pretranslated archive descriptor/
		);
	});

	it('records where the extensions are built from, off the sibling metadata', async () => {
		expect((await listing()).origin?.detail?.['sourceRepository']).toBe(REPOSITORY);
	});

	it('refuses a repository that never said where its source is', async () => {
		const bare = withoutSourceRepository(await listing());

		// The honest refusal for the common case. The listing is perfectly
		// good — it browses, it says what exists — and the only thing missing
		// is the one fact that would make it convertible, so that is what the
		// sentence names rather than the format or the artifact.
		await expect(
			aniyomiAdapter.convert(bare, services(repositoryFiles(EXTENSION_KT)))
		).rejects.toThrow(/does not say where its extensions are built from/);
	});

	it('refuses when the repository holds no source for this package', async () => {
		const empty = new Map([['LICENSE', LICENCE]]);

		await expect(aniyomiAdapter.convert(await listing(), services(empty))).rejects.toThrow(
			/could not be found in the repository it is built from/
		);
	});
});

describe('an extension that translates', () => {
	it('produces a bundle the ordinary archive reader opens', async () => {
		const one = await listing();
		const bundle = await openPluginArchive(await convert(EXTENSION_KT));

		expect(bundle.id).toBe(one.id);
		expect(bundle.entrypointSource.length).toBeGreaterThan(0);
		// From the extension's own `baseUrl`, which is the only host the index
		// named and the one `ctx.http` will be asked about first.
		expect(bundle.hosts).toContain('watch.example.invalid');

		// And nothing out of the runtime wrapped around it. The hosts used to be
		// read from the whole entrypoint, which is the extension plus every shim
		// this build ships — and the deobfuscator matches on the literal strings
		// `"String.fromCharCode"` and `"String.fromCodePoint"`, so a viewer's
		// consent screen listed `string.fromcharcode` as a host the plugin
		// wanted to reach. Nothing this build writes is ever a host.
		expect(bundle.hosts.filter((host) => host.includes('string.from'))).toEqual([]);
	}, 60_000);

	it('reads a base url that lives in a preference default', async () => {
		// `override val baseUrl by lazy { preferences.getString(KEY, DEFAULT)!! }`
		// is how a growing number of these let a viewer follow a source that
		// moves. There is no literal on the line, so the token reader saw no base
		// url at all and the listing was refused for declaring none — while the
		// Kotlin declares one perfectly well, one name along. The default is the
		// right answer: the converted plugin reads the same preference through
		// the same default at run time, so the manifest and the runtime agree.
		const bundle = await openPluginArchive(
			await convert(`
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    override val name = "Example Anime"
    override val baseUrl by lazy { preferences.getString(PREF_DOMAIN_KEY, PREF_DOMAIN_DEFAULT)!! }
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun popularAnimeNextPageSelector() = "a.next"

    companion object {
        private const val PREF_DOMAIN_KEY = "preferred_domain"
        private const val PREF_DOMAIN_DEFAULT = "https://watch.example.invalid"
    }
}
`)
		);

		expect(bundle.hosts).toContain('watch.example.invalid');
	}, 60_000);

	it('reads a base url off the class an AnimeSourceFactory builds', async () => {
		// A factory extension hands back several language variants of the same
		// source, and the factory class itself declares no `baseUrl` at all — it
		// lives on the class `createSources()` instantiates instead. The entry
		// file is the factory (`extClass` in the build file names it), so the
		// straightforward reads all look at the wrong file; only tracing
		// `createSources()` to the class it builds finds the real one.
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(repositoryFactory()))
		);

		expect(bundle.hosts).toContain('watch.example.invalid');
	}, 60_000);

	it('reads a base url off the class the conversion chose, below a factory in one file', async () => {
		// The token reader describes the first class in the entry file; here that
		// is the factory, with no base url, and the class the emitter picks sits
		// under it in the same file.
		const files = new Map(repositoryFactory());
		files.delete('src/en/example/ExampleAnime.kt');
		files.set(
			'src/en/example/ExampleAnimeFactory.kt',
			[
				`package ${PACKAGE}`,
				'',
				'class ExampleAnimeFactory : AnimeSourceFactory {',
				'    override fun createSources() = listOf(ExampleAnime())',
				'}',
				'',
				'class ExampleAnime : ParsedAnimeHttpSource() {',
				'    override val name = "Example Anime"',
				'    override val lang = "en"',
				'    override val baseUrl = "https://watch.example.invalid"',
				'    override val supportsLatest = false',
				'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)',
				'    override fun popularAnimeSelector() = "li.card"',
				'    override fun popularAnimeNextPageSelector() = "a.next"',
				'}'
			].join('\n')
		);
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(files))
		);

		expect(bundle.hosts).toContain('watch.example.invalid');
	}, 60_000);

	it('falls back to the base url the index publishes when the Kotlin computes it', async () => {
		// A template's shape: the url is built at run time from a list the
		// extension passes in, so no reader finds a literal. The repository's
		// build instantiated the source and wrote its `baseUrl` into the index,
		// which is the default the running code starts from.
		const bundle = await openPluginArchive(
			await convert(`
package ${PACKAGE}

class ExampleAnime : ParsedAnimeHttpSource() {
    private val domains = listOf("watch.example.invalid", "mirror.example.invalid")
    override val name = "Example Anime"
    override val baseUrl: String get() = "https://${'$'}{domains.first()}"
    override val lang = "en"
    override val supportsLatest = false

    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)

    override fun popularAnimeSelector() = "li.card"

    override fun popularAnimeNextPageSelector() = "a.next"
}
`)
		);

		expect(bundle.entrypointSource).toContain(
			'const __BASE_URL = "https://watch.example.invalid";'
		);
	}, 60_000);

	it('keeps no published base url for a listing that declares several sources', async () => {
		// Which of several the converted class is cannot be read off the index,
		// so none of them is offered as its url.
		const body = JSON.parse(INDEX_BODY);
		body[0].sources.push({ name: 'Mirror', lang: 'en', baseUrl: 'https://mirror.example.invalid' });
		const index = await aniyomiAdapter.loadIndex!(JSON.stringify(body), INDEX_URL, async () =>
			JSON.stringify({ meta: { name: 'Example extensions', website: REPOSITORY } })
		);
		const single = await listing();

		expect(single.origin?.detail?.['publishedBaseUrl']).toBe('https://watch.example.invalid');
		expect(index.plugins[0].origin?.detail?.['publishedBaseUrl']).toBeUndefined();
	});

	it('carries the upstream licence, read and identified rather than guessed', async () => {
		const bundle = await openPluginArchive(await convert(EXTENSION_KT));

		// A conversion is a derived work, so the terms it was published under
		// travel with it — hashed like every other member, so stripping the
		// file breaks the integrity check.
		expect(bundle.manifest['license']).toBe('Apache-2.0');
		const carried = bundle.files.get('licenses/UPSTREAM.txt');
		expect(carried).toBeDefined();
		expect(new TextDecoder().decode(carried!)).toContain('Apache License');
	}, 60_000);

	it('credits the repository owner, not this project', async () => {
		const bundle = await openPluginArchive(await convert(EXTENSION_KT));

		expect((bundle.manifest['author'] as { name: string }).name).toBe('owner');
		expect(bundle.manifest['repository']).toBe(REPOSITORY);
	}, 60_000);

	it('reads the source and never the artifact', async () => {
		const fetched: string[] = [];
		await convert(EXTENSION_KT, fetched);

		// `fetchArtifact` throws, so reaching the APK would have failed the
		// conversion outright. What is asserted here is the positive half: the
		// Kotlin was actually read, from the branch that answered.
		expect(fetched).toContain(`${RAW}src/en/example/ExampleAnime.kt`);
		expect(fetched).toContain(`${RAW}LICENSE`);
	}, 60_000);
});

describe('what is refused, and in which words', () => {
	it('refuses a shell, naming the base class it could not read', async () => {
		// Everything this file declares translates. A converter that asked only
		// "did anything fail" would package it, and the result would install,
		// search, and answer with silence — which reads as a broken source
		// rather than as a conversion that should not have happened.
		await expect(convert(SHELL_KT)).rejects.toThrow(/base class/);
		await expect(convert(SHELL_KT)).rejects.toThrow(/would ever call/);
	}, 60_000);

	it('names the members that blocked a conversion, not a category', async () => {
		// "Uses unsupported Kotlin" is unactionable. The member is the unit
		// somebody can look at in the upstream source, so the member is what
		// the sentence has to carry.
		const refusal = await convert(UNTRANSLATABLE_KT).catch((error: Error) => error.message);

		expect(refusal).toContain('videoListParse');
		expect(refusal).toContain('WebView');
		expect(refusal).toMatch(/looks like it works and does not/);
	}, 60_000);

	it('shows every distinct obstacle in the refusal', async () => {
		const refusal = await convert(MANY_OBSTACLES_KT).catch((error: Error) => error.message);

		expect(refusal).toContain('WebView');
		expect(refusal).toContain('a background thread');
		// The algorithm rather than the package: `ctx.crypto` answers AES-CBC
		// and AES-GCM, and a bare `"AES"` is ECB by the JCE's own default — so
		// what is refused here is the mode, and the sentence has to say which.
		expect(refusal).toContain('the `AES` cipher');
		expect(refusal).toContain('an embedded JavaScript engine');
		expect(refusal).toContain('the filesystem');
	}, 60_000);
});

describe('the extractor modules an extension delegates to', () => {
	// FOREIGN.md §4.1.6 recorded feeding these in as a negative result: the
	// count went from 4 to 0, because a conversion is complete or it is not and
	// every extension naming an extractor then failed on the extractor's own
	// refusals. `pipeline.ts` now walks the call graph, so the question is no
	// longer "did anything in these files fail" but "did anything the host can
	// reach fail". These two cases are that distinction, in both directions.

	it('fetches and translates the module its build file names', async () => {
		const fetched: string[] = [];
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(
				await listing(),
				services(repositoryWithModule(MODULE_KT), fetched)
			)
		);

		expect(fetched).toContain(`${RAW}lib/${MODULE}/ExampleHostExtractor.kt`);
		// Translated *into* the bundle, on the device, out of the catalogue's own
		// code — never shipped from here.
		expect(bundle.entrypointSource).toContain('videosFromPage');
	}, 60_000);

	it('does not refuse an extension for a module member it never calls', async () => {
		// `deepProbe` needs a browser and will never translate. Nothing reachable
		// names it, so it must not count — this is the 84 extensions.
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(repositoryWithModule(MODULE_KT)))
		);

		expect(bundle.entrypointSource).not.toContain('deepProbe');
	}, 60_000);

	it('refuses when the module member it does call cannot be translated', async () => {
		// The direction that matters more. A bundle that packaged anyway would
		// resolve a stream to a placeholder, which is exactly what the five-step
		// install check exists to catch — and catching it there means catching it
		// on somebody's phone rather than here.
		const refusal = await aniyomiAdapter
			.convert(await listing(), services(repositoryWithModule(MODULE_UNREACHABLE_OK_KT)))
			.catch((error: Error) => error.message);

		expect(refusal).toContain('videosFromPage');
		expect(refusal).toContain('WebView');
	}, 60_000);
});

describe('what a repository costs to check', () => {
	// The failure this guards: a check makes the same requests an install makes,
	// to somebody else's server, for every listing in a repository. Guessing a
	// directory and probing two build-file names across two branches is eight
	// requests per listing of which at most one can succeed — two thousand
	// requests to read two hundred and fifty-four files. The tree already lists
	// every path, and it is already cached per repository, so a guess can be
	// confirmed or discarded without asking.

	it('pays for the tree and the licence once, not once per listing', async () => {
		const fetched: string[] = [];
		const files = repositoryFiles(EXTENSION_KT);
		const shared = services(files, fetched);

		const index = await aniyomiAdapter.loadIndex!(INDEX_BODY, INDEX_URL, shared.getText);
		const first = index.plugins[0];

		await convertWith(first, shared);
		const afterFirst = fetched.length;

		await convertWith(first, shared);
		const second = fetched.length - afterFirst;

		// The second conversion of the same repository re-reads only what is
		// specific to the listing: its build file and its Kotlin. No tree, no
		// licence, and no branch probing.
		expect(second).toBeLessThanOrEqual(3);
		expect(fetched.slice(afterFirst).some((url) => url.endsWith('LICENSE'))).toBe(false);
	});

	it('reads a shared extractor once for the repository, not once per listing', async () => {
		// The module is the same file for every listing that names it. In the
		// measured catalogue 254 extensions declare 862 dependencies between them
		// and resolve to 58 distinct directories, so re-reading one per listing
		// is fifteen identical requests to somebody else's server for the same
		// bytes — 3,268 file requests across a catalogue rather than 1,068.
		const fetched: string[] = [];
		const shared = services(repositoryWithModule(MODULE_KT), fetched);
		const one = await listing();

		await convertWith(one, shared);
		const afterFirst = fetched.length;
		await convertWith(one, shared);

		const later = fetched.slice(afterFirst);
		expect(later.some((url) => url.indexOf('/lib/') !== -1)).toBe(false);
		// What is left is the listing's own: its build file and its Kotlin.
		expect(later.length).toBeLessThanOrEqual(3);
	}, 60_000);

	it('asks GitHub for the branch it has, rather than guessing two', async () => {
		// `main` then `master` is two requests to learn one fact, one of which
		// 404s in the viewer's console for every repository on the other name —
		// and it fails outright for a repository on neither. `HEAD` is whatever
		// the repository calls its default branch, and GitHub resolves it on the
		// tree API and the raw host alike.
		const fetched: string[] = [];
		const github = 'https://github.com/owner/animeextensions';
		const raw = 'https://raw.githubusercontent.com/owner/animeextensions/HEAD/';
		const shared = services(repositoryFiles(EXTENSION_KT), fetched, raw);

		await convertWith(await listing(github), shared);

		expect(fetched.length).toBeGreaterThan(0);
		expect(fetched.some((url) => url.includes('/main/') || url.includes('/master/'))).toBe(false);
		expect(fetched.some((url) => url.endsWith('LICENSE'))).toBe(true);
	});

	it('asks for a licence file the tree lists, and for no other', async () => {
		// Four names across two branches is eight requests of which at most one
		// can succeed. The tree names the file, so the misses are avoidable —
		// and every one of them was a 404 in the console of somebody who had
		// done nothing wrong.
		const fetched: string[] = [];
		const files = repositoryFiles(EXTENSION_KT);
		files.delete('LICENSE');
		const shared = services(files, fetched);

		await convertWith(await listing(), shared);

		expect(fetched.some((url) => /LICENSE|COPYING/.test(url))).toBe(false);
	});

	it('never probes a branch that the tree already settled', async () => {
		const fetched: string[] = [];
		const files = repositoryFiles(EXTENSION_KT);
		const shared = services(files, fetched);

		const index = await aniyomiAdapter.loadIndex!(INDEX_BODY, INDEX_URL, shared.getText);
		await convertWith(index.plugins[0], shared);
		const afterFirst = fetched.length;
		await convertWith(index.plugins[0], shared);

		// `main` and `master` were tried once, for the whole repository. A second
		// listing asking again is 254 wasted round trips on a real catalogue.
		const later = fetched.slice(afterFirst);
		expect(later.filter((url) => url.includes('/master/')).length).toBe(0);
	});
});

/* ── lib/synchrony, embedded from the repository ──────────────────────────── */

/** The module's Kotlin wrapper, in the shape upstream writes it: QuickJS. */
const SYNCHRONY_KT = `
package keiyoushi.lib.synchrony

import app.cash.quickjs.QuickJs

object Deobfuscator {
    fun deobfuscateScript(source: String): String? {
        val script = javaClass.getResource("/assets/synchrony-v0.0.0.js")?.readText() ?: return null
        return QuickJs.create().use { engine ->
            engine.evaluate(script)
            engine.evaluate("new Deobfuscator().deobfuscateSource(" + source + ")") as? String
        }
    }
}
`;

/** A stand-in for the prebuilt script: see `shims/synchrony.spec.ts`. */
const SYNCHRONY_JS =
	'var Hf = class { deobfuscateSource(e) { return "clean:" + e; } };var me = class {};export{Hf as Deobfuscator,me as Transformer};';

function repositoryWithSynchrony(): Map<string, string> {
	return new Map([
		['LICENSE', LICENCE],
		[
			'src/en/example/build.gradle',
			BUILD_GRADLE.replace(
				'ext {',
				"dependencies {\n    implementation(project(':lib:synchrony'))\n}\n\next {"
			)
		],
		[
			'src/en/example/ExampleAnime.kt',
			EXTENSION_KT.replace(
				'override fun popularAnimeSelector() = "li.card"',
				'override fun popularAnimeSelector() = Deobfuscator.deobfuscateScript("li.card") ?: "li.card"'
			).replace(
				`package ${PACKAGE}`,
				`package ${PACKAGE}\n\nimport keiyoushi.lib.synchrony.Deobfuscator`
			)
		],
		['lib/synchrony/src/keiyoushi/lib/synchrony/Deobfuscator.kt', SYNCHRONY_KT],
		['lib/synchrony/assets/synchrony-v0.0.0.js', SYNCHRONY_JS]
	]);
}

describe("an extension that calls lib/synchrony's deobfuscator", () => {
	it('converts, and carries the repository script in place of QuickJS', async () => {
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(repositoryWithSynchrony()))
		);

		// The QuickJS wrapper was read as the runtime's engine, not refused…
		expect(bundle.entrypointSource).toContain('SynchronyEngine.deobfuscate');
		// …and the script it runs is the repository's, embedded, not fetched.
		expect(bundle.entrypointSource).toContain('__synchronyFactory = function () {');
		expect(bundle.entrypointSource).toContain('deobfuscateSource(e) { return "clean:" + e; }');
	}, 60_000);

	it('says what it embedded, and asserts no terms for it', async () => {
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(repositoryWithSynchrony()))
		);

		const notice = bundle.files.get('licenses/EMBEDDED.txt');
		expect(notice).toBeDefined();
		const text = new TextDecoder().decode(notice!);
		expect(text).toContain('lib/synchrony/assets/synchrony-v0.0.0.js');
		expect(text).toContain('neither restates nor asserts');
	}, 60_000);

	it('embeds nothing for an extension built without the module', async () => {
		const bundle = await openPluginArchive(
			await aniyomiAdapter.convert(await listing(), services(repositoryFiles(EXTENSION_KT)))
		);

		expect(bundle.entrypointSource).not.toContain('__synchronyFactory = function');
		expect(bundle.files.has('licenses/EMBEDDED.txt')).toBe(false);
	}, 60_000);
});
