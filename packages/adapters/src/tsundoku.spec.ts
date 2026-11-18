/**
 * `tsundokuAdapter`, against a keiyoushi-shaped tree.
 *
 * The format is mihon's schema with a fork field, so the negative is the one
 * fact its package names carry: `novelextension`. The two foreign fixtures are
 * the two arrays most likely to be mistaken for it — an Aniyomi index and a
 * Mihon stub — and both must be refused, because `adapters.spec.ts` runs that
 * check in both directions.
 *
 * Rule 9: `example.invalid` throughout, and the forge's own raw host, which
 * `git-hosts.ts` already names.
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { ForeignFormatError } from '@plugin-bridge/core/adapter';
import type { ConversionServices } from '@plugin-bridge/core/adapter';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { tsundokuAdapter, forgetTsundokuCaches } from './tsundoku';

const INDEX_URL = 'https://raw.githubusercontent.com/owner/novels/repo/index.min.json';
const REPOSITORY = 'https://github.com/owner/novels';
const RAW = 'https://raw.githubusercontent.com/owner/novels/main/';
const DIRECTORY = 'src/en/demo';
const PACKAGE = 'eu.kanade.tachiyomi.novelextension.en.demo';

const ROW = {
	pkg: PACKAGE,
	apk: 'novel-en-demo-v2.apk',
	name: 'Demo Novel',
	lang: 'en',
	version: '2',
	sources: [{ name: 'Demo', lang: 'en', baseUrl: 'https://read.example.invalid' }],
	nsfw: false
};

const BUILD = `keiyoushi {
    name = "Demo Novel"
    versionCode = 7
    contentWarning = ContentWarning.SAFE
    source {
        lang = "en"
        baseUrl = "https://read.example.invalid"
    }
}
`;

const KOTLIN = `package eu.kanade.tachiyomi.novelextension.en.demo

import eu.kanade.tachiyomi.source.online.HttpSource
import keiyoushi.annotation.Source

@Source
abstract class Demo : HttpSource() {
    override val name = "Demo"
    override val baseUrl = "https://read.example.invalid"
    override val lang = "en"

    override suspend fun getPopularManga(page: Int): MangasPage =
        MangasPage(listOf(SManga.create()), false)

    override suspend fun getChapterList(manga: SManga): List<SChapter> = emptyList()

    override suspend fun fetchPageText(page: Page): String = "<p>one</p>"
}
`;

async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url)))
	);
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

function listing(): RepositoryPlugin {
	forgetTsundokuCaches();
	const [row] = tsundokuAdapter.parseIndex(JSON.stringify([ROW]), INDEX_URL).plugins;
	return row;
}

describe('candidates', () => {
	it('tries the publishing branch first, and both index spellings', () => {
		const candidates = tsundokuAdapter.candidates(new URL(REPOSITORY));
		expect(candidates[0]).toContain('/repo/');
		expect(candidates.some((url) => url.endsWith('index.pb'))).toBe(true);
		expect(candidates.some((url) => url.endsWith('index.min.json'))).toBe(true);
	});

	it('uses a pasted file as given', () => {
		const pasted = new URL(INDEX_URL);
		expect(tsundokuAdapter.candidates(pasted)).toEqual([pasted.toString()]);
	});
});

describe('parseIndex', () => {
	it('reads a novel row, and derives its host and address', () => {
		const index = tsundokuAdapter.parseIndex(JSON.stringify([ROW]), INDEX_URL);
		const [row] = index.plugins;

		expect(row.name).toBe('Demo Novel');
		expect(row.hosts).toContain('read.example.invalid');
		expect(row.origin?.mediaKind).toBe('novel');
		expect(row.origin?.mediaKinds).toEqual(['novel']);
		expect(row.origin?.artifactUrl).toBe(
			'https://raw.githubusercontent.com/owner/novels/repo/apk/novel-en-demo-v2.apk'
		);
		expect(row.origin?.detail?.['sourceRepository']).toBe(REPOSITORY);
		expect(row.origin?.detail?.['sourceDir']).toBe(DIRECTORY);
	});

	it('refuses an Aniyomi or Mihon array, neither of which has the segment', () => {
		const aniyomi = JSON.stringify([
			{ name: 'Anime: Demo', pkg: 'eu.kanade.tachiyomi.animeextension.en.demo', apk: 'a.apk' }
		]);
		const mihon = JSON.stringify([
			{ name: 'Manga', pkg: 'eu.kanade.tachiyomi.extension.en.demo', apk: 'm.apk' }
		]);
		expect(() => tsundokuAdapter.parseIndex(aniyomi, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => tsundokuAdapter.parseIndex(mihon, INDEX_URL)).toThrow(ForeignFormatError);
	});

	it('does not name the medium as a reason to drop the row', () => {
		// `novel` is unsupported, so a format that filtered on it would browse
		// to an empty page and explain nothing.
		const index = tsundokuAdapter.parseIndex(JSON.stringify([ROW]), INDEX_URL);
		expect(index.plugins).toHaveLength(1);
		expect(index.filteredOut).toBe(0);
	});
});

describe('convert', () => {
	it('translates the Kotlin and hands the driver the novel page member', async () => {
		const files = new Map([
			[`${DIRECTORY}/build.gradle.kts`, BUILD],
			[`${DIRECTORY}/src/demo/Demo.kt`, KOTLIN]
		]);
		const bytes = await tsundokuAdapter.convert(listing(), services(files));

		const bundle = await openPluginArchive(bytes);
		expect(bundle.id).toBe(listing().id);
		expect(bundle.entrypointSource).toContain('__DIALECT = "tsundoku"');
		expect(bundle.entrypointSource).toContain('fetchPageText');
	});

	it('refuses a Java-only directory by the file', async () => {
		const files = new Map([
			[`${DIRECTORY}/build.gradle.kts`, BUILD],
			[`${DIRECTORY}/src/demo/Demo.java`, 'package demo;\n']
		]);
		await expect(tsundokuAdapter.convert(listing(), services(files))).rejects.toThrow(
			/`Demo\.java` is the entry/
		);
	});

	it('refuses a directory that builds another package', async () => {
		const files = new Map([
			[`${DIRECTORY}/build.gradle.kts`, 'keiyoushi {\n pkgName = "en.other"\n}\n'],
			[`${DIRECTORY}/src/demo/Demo.kt`, KOTLIN]
		]);
		await expect(tsundokuAdapter.convert(listing(), services(files))).rejects.toThrow(
			/builds a different extension/
		);
	});
});
