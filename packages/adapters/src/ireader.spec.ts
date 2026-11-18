/**
 * `ireaderAdapter`, against the two documents the ecosystem publishes and a
 * source tree this file owns.
 *
 * Rule 9: every content URL is `example.invalid`. `raw.githubusercontent.com`
 * and `api.github.com` appear because they are the forge's own hosts, which
 * `git-hosts.ts` already names.
 *
 * ## Why the Kotlin below is written out rather than captured
 *
 * The adapter's job is to resolve a row to a directory, alias three textual
 * shapes, and refuse what the front-end cannot read. Pinning a real extension's
 * text would make these fail whenever somebody edited that extension, and prove
 * only the shape it happened to have. The class here is deliberately ordinary —
 * one listing, one chapter, one text page — so a break in the *plumbing* (the
 * shim not fetched, the alias not applied, the page kind not carried) fails
 * here and nowhere else.
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { ForeignFormatError } from '@plugin-bridge/core/adapter';
import type { ConversionServices } from '@plugin-bridge/core/adapter';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { ireaderAdapter } from './ireader';

const INDEX_URL = 'https://raw.githubusercontent.com/owner/novels/repov2/index.json';
const REPOSITORY = 'https://github.com/owner/novels';
const RAW = 'https://raw.githubusercontent.com/owner/novels/main/';
const DIRECTORY = 'sources/en/demo';

/** The vendored parser, read the way a host reads it. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url)))
	);
}

const DOCUMENT = {
	extensions: [
		{
			pkg: 'ireader.demo.en',
			apk: 'ireader-en-demo-v1.0.apk',
			name: 'Demo',
			id: 42,
			lang: 'en',
			version: '1.0',
			description: 'Demo source',
			nsfw: false,
			sourceDir: 'demo'
		}
	],
	js: {
		note: 'needs runtime.js',
		sources: [
			{
				id: 'demokmp',
				name: 'Demo KMP',
				lang: 'en',
				file: 'sources-bundle.js',
				initFunction: 'initDemoKmp'
			}
		]
	}
};

const KOTLIN = `package ireader.demo

import ireader.core.source.Dependencies
import ireader.core.source.SourceFactory
import ireader.core.source.findInstance
import ireader.core.source.ireaderFilters
import ireader.core.source.model.ChapterInfo
import ireader.core.source.model.Command
import ireader.core.source.model.FilterList
import ireader.core.source.model.MangaInfo
import ireader.core.source.model.MangasPageInfo
import ireader.core.source.model.Page
import ireader.core.source.model.Text
import tachiyomix.annotations.Extension

@Extension
abstract class Demo(private val deps: Dependencies) : SourceFactory(deps = deps) {
    override val lang: String get() = "en"
    override val baseUrl: String get() = "https://read.example.invalid"
    override val id: Long get() = DemoSourceId.ID
    override val name: String get() = "Demo"

    override fun getFilters(): FilterList = listOf(ireaderFilters(""))

    override suspend fun getMangaList(filters: FilterList, page: Int): MangasPageInfo =
        MangasPageInfo(listOf(MangaInfo(key = "$baseUrl/m/1", title = "One")), false)

    override suspend fun getChapterList(manga: MangaInfo, commands: List<Command<*>>): List<ChapterInfo> =
        listOf(ChapterInfo(name = "One", key = manga.key + "/1"))

    override suspend fun getPageList(chapter: ChapterInfo, commands: List<Command<*>>): List<Page> =
        listOf(Text("hello"))
}
`;

function listing(indexUrl = INDEX_URL): RepositoryPlugin {
	const index = ireaderAdapter.parseIndex(JSON.stringify(DOCUMENT), indexUrl);
	const found = index.plugins.find((row) => row.origin?.detail?.['javascript'] === null);
	if (found === undefined) throw new Error('the fixture has no Kotlin row');
	return found;
}

function services(files: Map<string, string>): ConversionServices {
	return {
		loadWasm: vendorWasm,
		fetchArtifact: async () => {
			throw new Error('an APK must not be fetched by this format');
		},
		getText: async (url: string) => {
			const path = url.startsWith(RAW) ? url.slice(RAW.length) : null;
			const body = path === null ? undefined : files.get(path);
			if (body === undefined) throw new Error(`nothing at ${url}`);
			return body;
		},
		listFiles: async (url: string) => {
			if (!url.startsWith(RAW)) return [];
			const prefix = url.slice(RAW.length);
			return [...files.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => `${RAW}${path}`);
		}
	};
}

describe('candidates', () => {
	it('tries the merged index before the iOS one, on the publishing branch', () => {
		const candidates = ireaderAdapter.candidates(new URL(REPOSITORY));
		const merged = candidates.findIndex((url) => url.endsWith('/index.json'));
		const ios = candidates.findIndex((url) => url.endsWith('/js-index.json'));
		expect(merged).toBeGreaterThanOrEqual(0);
		expect(ios).toBeGreaterThan(merged);
		expect(candidates[0]).toContain('/repov2/');
	});

	it('uses a pasted file as given', () => {
		const pasted = new URL(INDEX_URL);
		expect(ireaderAdapter.candidates(pasted)).toEqual([pasted.toString()]);
	});
});

describe('parseIndex', () => {
	it('reads both catalogues, and marks the iOS rows as such', () => {
		const index = ireaderAdapter.parseIndex(JSON.stringify(DOCUMENT), INDEX_URL);
		expect(index.plugins).toHaveLength(2);

		const kotlin = index.plugins[0];
		expect(kotlin.name).toBe('Demo');
		expect(kotlin.origin?.artifactUrl).toBe(
			'https://raw.githubusercontent.com/owner/novels/repov2/apk/ireader-en-demo-v1.0.apk'
		);
		expect(kotlin.origin?.detail?.['directory']).toBe(DIRECTORY);
		expect(kotlin.origin?.detail?.['sourceRepository']).toBe(REPOSITORY);
		expect(kotlin.origin?.detail?.['javascript']).toBeNull();

		const ios = index.plugins[1];
		expect(ios.origin?.detail?.['javascript']).toEqual({
			file: 'sources-bundle.js',
			initFunction: 'initDemoKmp'
		});
	});

	it('reads the second documented shape, and the flat legacy array', () => {
		const ios = ireaderAdapter.parseIndex(
			JSON.stringify({
				version: 1,
				sources: [
					{ id: 'demo', name: 'Demo', lang: 'en', file: 'demo.js', initFunction: 'initDemo' }
				]
			}),
			'https://raw.githubusercontent.com/owner/novels/repov2/js-index.json'
		);
		expect(ios.plugins).toHaveLength(1);

		const flat = ireaderAdapter.parseIndex(
			JSON.stringify([
				{ pkg: 'ireader.demo.en', apk: 'demo.apk', name: 'Demo', lang: 'en', version: '1' }
			]),
			INDEX_URL
		);
		expect(flat.plugins).toHaveLength(1);
	});

	it('refuses another format’s array rather than reading it as novels', () => {
		const aniyomi = JSON.stringify([
			{ name: 'Anime: Demo', pkg: 'eu.kanade.tachiyomi.animeextension.en.demo', apk: 'a.apk' }
		]);
		expect(() => ireaderAdapter.parseIndex(aniyomi, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => ireaderAdapter.parseIndex('{"extensions":[]}', INDEX_URL)).toThrow(
			ForeignFormatError
		);
		expect(() => ireaderAdapter.parseIndex('[]', INDEX_URL)).toThrow(ForeignFormatError);
	});

	it('sets manga first and carries novel beside it, so a row survives', () => {
		const [row] = ireaderAdapter.parseIndex(JSON.stringify(DOCUMENT), INDEX_URL).plugins;
		expect(row.origin?.mediaKind).toBe('manga');
		expect(row.origin?.mediaKinds).toEqual(['manga', 'novel']);
	});
});

describe('convert', () => {
	it('refuses an iOS row by the file and its init function', async () => {
		const index = ireaderAdapter.parseIndex(JSON.stringify(DOCUMENT), INDEX_URL);
		const ios = index.plugins.find((row) => row.origin?.detail?.['javascript'] !== null)!;

		await expect(ireaderAdapter.convert(ios, services(new Map()))).rejects.toThrow(
			/sources-bundle\.js.*initDemoKmp/s
		);
	});

	it('translates a Kotlin row through the shim and packages an installable bundle', async () => {
		const files = new Map([[`${DIRECTORY}/main/src/ireader/demo/Demo.kt`, KOTLIN]]);
		const bytes = await ireaderAdapter.convert(listing(), services(files));

		const bundle = await openPluginArchive(bytes);
		expect(bundle.id).toBe(listing().id);
		expect(bundle.manifest['name']).toBe('Demo');
		// The shim's declaration is what made the dialect readable; the driver
		// is what calls it.
		expect(bundle.entrypointSource).toContain('class SourceFactory');
		expect(bundle.entrypointSource).toContain('getMangaList');
		expect(bundle.entrypointSource).toContain('data:text/plain');
	});

	it('searches with the title filter and the nested search type the shim declares', async () => {
		// The two shapes an ordinary listing member writes against the shim:
		// `filters.findInstance<Filter.Title>()` (a reified extension declared
		// in the shim's file) and `SourceFactory.Type.Search` (an `object`
		// nested in the shim's base class). Both translated without a refusal
		// and then failed at the first search — the first with "__recv is not
		// iterable", the second reading `Search` off undefined.
		const searching = KOTLIN.replace(
			'import ireader.core.source.model.FilterList',
			'import ireader.core.source.model.Filter\nimport ireader.core.source.model.FilterList'
		).replace(
			'MangasPageInfo(listOf(MangaInfo(key = "$baseUrl/m/1", title = "One")), false)',
			'MangasPageInfo(listOf(MangaInfo(key = "$baseUrl/m/1", title = ' +
				'(filters.findInstance<Filter.Title>()?.value ?: "none") + "/" + SourceFactory.Type.Search)), false)'
		);
		expect(searching).toContain('findInstance<Filter.Title>()');
		const files = new Map([[`${DIRECTORY}/main/src/ireader/demo/Demo.kt`, searching]]);
		const bundle = await openPluginArchive(
			await ireaderAdapter.convert(listing(), services(files))
		);

		const { writeFileSync, mkdtempSync } = await import('node:fs');
		const { tmpdir } = await import('node:os');
		const { join } = await import('node:path');
		const file = join(mkdtempSync(join(tmpdir(), 'yorozo-')), 'bundle.mjs');
		writeFileSync(file, bundle.entrypointSource, 'utf8');
		const module = (await import(/* @vite-ignore */ `file:///${file.replace(/\\/g, '/')}`))
			.default as {
			searchCatalog(
				query: string,
				page: number,
				ctx: unknown
			): Promise<{ entries: { title: string }[] }>;
		};

		const found = await module.searchCatalog('needle', 1, {
			log: { debug() {}, warn() {} }
		});
		expect(found.entries.map((entry) => entry.title)).toEqual(['needle/0']);
	});

	it('refuses a directory that is Java, naming the file', async () => {
		const files = new Map([
			[`${DIRECTORY}/main/src/ireader/demo/Demo.java`, 'package ireader.demo;\n']
		]);
		await expect(ireaderAdapter.convert(listing(), services(files))).rejects.toThrow(
			/`Demo\.java` is Java/
		);
	});
});
