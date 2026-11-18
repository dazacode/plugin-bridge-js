/**
 * A catalogue check of a listing that serves its own stream.
 *
 * `checkListing` is the engine's answer to "would this work if installed", so
 * it has to run the bundle under exactly what an install grants — and a
 * bundle's manifest permissions are part of that. A converted extension that
 * runs a local server gets `segment-transform-js` in its manifest; the check
 * built the plugin without its permissions, so the sandbox refused the served
 * stream at `resolve` and the listing was reported broken while an install of
 * the same bundle played.
 *
 * Driven through the real Aniyomi adapter and the headless isolate. Every
 * fixture is written here; hosts are `example.invalid` (AGENTS.md rule 9).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { aniyomiAdapter, forgetCachedLicences } from '@plugin-bridge/adapters/aniyomi';
import { checkListing } from '@plugin-bridge/host/catalogue';
import { headlessPluginHost } from './headless-plugin-host';

const FORGE = 'https://forge.example.invalid';
const REPOSITORY = `${FORGE}/owner/animeextensions`;
const RAW = `${REPOSITORY}/raw/branch/main/`;
const INDEX_URL = 'https://repo.example.invalid/repo/index.min.json';
const PACKAGE = 'org.example.animeextension.en.example';

/** An extension that resolves one stream through its own local server, and one direct. */
const EXTENSION_KT =
	'package org.example.animeextension.en.example\n\nclass ExampleAnime : ParsedAnimeHttpSource() {\n    override val name = "Example Anime"\n    override val baseUrl = "https://watch.example.invalid"\n    override val lang = "en"\n    override val supportsLatest = false\n\n    private val server by lazy { LocalServer().also { it.start() } }\n\n    override suspend fun getSearchAnime(page: Int, query: String, filters: AnimeFilterList): AnimesPage {\n        val anime = SAnime.create().apply {\n            url = "/anime/one"\n            title = "One"\n        }\n        return AnimesPage(listOf(anime), false)\n    }\n\n    override suspend fun getEpisodeList(anime: SAnime): List<SEpisode> = listOf(\n        SEpisode.create().apply {\n            url = "/anime/one/1"\n            name = "Episode 1"\n            episode_number = 1f\n        },\n    )\n\n    override suspend fun getVideoList(episode: SEpisode): List<Video> = listOf(\n        Video(server.urlFor("index.m3u8"), "Served", server.urlFor("index.m3u8")),\n        Video("https://cdn.example.invalid/one.mp4", "Direct", "https://cdn.example.invalid/one.mp4"),\n    )\n}\n\nclass LocalServer : NanoHTTPD("127.0.0.1", 0) {\n    fun urlFor(path: String): String = "http://127.0.0.1:$listeningPort/$path"\n\n    override fun serve(session: IHTTPSession): Response = newFixedLengthResponse(Status.OK, "application/vnd.apple.mpegurl", "#EXTM3U\\nseg.ts\\n")\n}\n\n';

const FILES = new Map([
	['LICENSE', 'Apache License\nVersion 2.0\n'],
	[
		'src/en/example/build.gradle',
		"ext {\n    extName = 'Example Anime'\n    extClass = '.ExampleAnime'\n    extVersionCode = 3\n}\n"
	],
	['src/en/example/ExampleAnime.kt', EXTENSION_KT]
]);

const INDEX_BODY = JSON.stringify([
	{
		name: 'Aniyomi: Example Anime',
		pkg: PACKAGE,
		apk: 'example-anime-v14.3.apk',
		lang: 'en',
		code: 3,
		version: '14.3',
		nsfw: 0,
		sources: [{ name: 'Example Anime', lang: 'en', baseUrl: 'https://watch.example.invalid' }]
	}
]);

const getText = async (url: string): Promise<string> => {
	if (url === new URL('repo.json', INDEX_URL).toString()) {
		return JSON.stringify({ meta: { name: 'Example extensions', website: REPOSITORY } });
	}
	const body = url.startsWith(RAW) ? FILES.get(url.slice(RAW.length)) : undefined;
	if (body === undefined) throw new Error(`nothing at ${url}`);
	return body;
};

const listFiles = async (url: string): Promise<readonly string[]> => {
	if (!url.startsWith(RAW)) return [];
	const prefix = url.slice(RAW.length);
	return [...FILES.keys()].filter((path) => path.startsWith(prefix)).map((path) => `${RAW}${path}`);
};

const scratch = mkdtempSync(join(tmpdir(), 'yorozo-catalogue-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('a catalogue check of a listing that serves its own stream', () => {
	it('runs it under the permissions its bundle declares, as an install does', async () => {
		forgetCachedLicences();
		const vendor = (name: string) =>
			new Uint8Array(
				readFileSync(
					fileURLToPath(new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url))
				)
			);
		const host = headlessPluginHost({
			dataDir: scratch,
			log: () => {},
			// Nothing in this check leaves the machine: the extension answers from
			// its own code, and no reach probe is offered.
			fetch: (async (input: RequestInfo | URL) => {
				throw new Error(`no network in this test: ${String(input)}`);
			}) as unknown as typeof fetch
		});
		const index = await aniyomiAdapter.loadIndex!(INDEX_BODY, INDEX_URL, getText);

		const result = await checkListing(index.plugins[0], {
			host: { ...host, wasm: async (name: string) => vendor(name) },
			download: async () => {
				throw new Error('the published artifact must never be fetched for this format');
			},
			getText,
			listFiles
		});

		expect(result.detail).toBeNull();
		expect(result.status).toBe('works');
		expect(result.streamCount).toBe(1);
	}, 60_000);
});
