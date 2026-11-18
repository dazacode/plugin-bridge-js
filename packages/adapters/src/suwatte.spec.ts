/**
 * What the Suwatte adapter makes of a registration document and of a source.
 *
 * Two things here are the adapter's whole risk surface: claiming a document
 * that belongs to a sibling format, and packaging a module the engine will not
 * parse. So the refusals are pinned tightly and the conversion runs against a
 * two-module source whose TypeScript has to be stripped before the bundle can
 * even be read back.
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { suwatteAdapter } from './suwatte';

const BASE = 'https://raw.example.invalid/owner/repo/main/src';
const INDEX_URL = `${BASE}/index.json`;

const INFO = `
import { ContentRating, SourceInfo } from "@suwatte/toolchain";
import { BASE_URL } from "./constants";

export const info: SourceInfo = {
  id: "en.example.alpha",
  name: "Alpha",
  version: 1.0,
  website: BASE_URL,
  languages: ["en"],
  rating: ContentRating.MATURE
};
`;

const CONSTANTS = `export const BASE_URL = "https://site.example.invalid";`;

const INDEX = `
import { Chapter, Content, PagedItemList, SearchRequest, SourceInfo } from "@suwatte/toolchain";
import { info } from "./info";
import { parse } from "./parsers";

export default class Alpha {
  static info: SourceInfo = info;

  async getSearchResults(request: SearchRequest, page: number): Promise<PagedItemList> {
    return parse(await this.client.get("/search", { params: { q: request.query } }), page);
  }

  async getChapters(contentId: string): Promise<Chapter[]> {
    return [{ id: contentId + "/1", number: 1 }] as Chapter[];
  }

  async getChapterPages(contentId: string, chapterId: string): Promise<{ url: string }[]> {
    return [{ url: chapterId }];
  }
}
`;

const PARSERS = `
export function parse(body: unknown, page: number) {
  return { items: [{ id: "/one", title: "One" }], isLastPage: true };
}
`;

function servicesFor(files: Record<string, string>): ConversionServices {
	return {
		fetchArtifact: async (url) => {
			const found = files[url];
			if (found === undefined) throw new Error(`nothing at ${url}`);
			return new TextEncoder().encode(found);
		},
		getText: async (url) => {
			const found = files[url];
			if (found === undefined) throw new Error(`nothing at ${url}`);
			return found;
		},
		listFiles: () => {
			throw new Error('nothing here lists');
		}
	};
}

function sourceFiles(): Record<string, string> {
	return {
		[`${BASE}/alpha/info.ts`]: INFO,
		[`${BASE}/alpha/constants.ts`]: CONSTANTS,
		[`${BASE}/alpha/index.ts`]: INDEX,
		[`${BASE}/alpha/parsers.ts`]: PARSERS
	};
}

describe('a Suwatte registration document', () => {
	it('accepts a bare array of sources', () => {
		const parsed = suwatteAdapter.parseIndex(
			JSON.stringify([{ id: 'alpha', name: 'Alpha', version: '1.0.0' }]),
			INDEX_URL
		);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(`${BASE}/alpha/index.ts`);
	});

	it('accepts an object with a sources array', () => {
		const parsed = suwatteAdapter.parseIndex(
			JSON.stringify({ sources: [{ id: 'alpha', name: 'Alpha', version: '1.0.0' }] }),
			INDEX_URL
		);
		expect(parsed.plugins).toHaveLength(1);
		// The plan, not a single file, is what conversion needs.
		expect(parsed.plugins[0].origin?.detail).toEqual({
			directory: `${BASE}/alpha/`,
			entry: 'index.ts',
			info: 'info.ts'
		});
	});

	it('refuses an LNReader document', () => {
		const lnreader = JSON.stringify([
			{ id: 'x', name: 'X', site: 'https://example.invalid', url: 'x.js' }
		]);
		expect(() => suwatteAdapter.parseIndex(lnreader, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => suwatteAdapter.parseIndex('{"scrapers":[]}', INDEX_URL)).toThrow(
			ForeignFormatError
		);
	});
});

describe('what a converted Suwatte bundle declares', () => {
	it('declares the site and the API the source reaches', async () => {
		const listing = suwatteAdapter.parseIndex(
			JSON.stringify([{ id: 'alpha', name: 'Alpha', version: '1.0.0' }]),
			INDEX_URL
		).plugins[0];
		const bundle = await suwatteAdapter.convert(listing, servicesFor(sourceFiles()));
		const opened = await openPluginArchive(bundle);
		const hosts = (opened.manifest['network'] as { hosts: string[] }).hosts;
		expect(hosts).toContain('site.example.invalid');
		expect(hosts).toContain('*.example.invalid');
		expect(hosts).not.toContain('raw.example.invalid');
	});

	it('packages a readable bundle under the converted id', async () => {
		const listing = suwatteAdapter.parseIndex(
			JSON.stringify([{ id: 'alpha', name: 'Alpha', version: '1.0.0' }]),
			INDEX_URL
		).plugins[0];
		const bundle = await suwatteAdapter.convert(listing, servicesFor(sourceFiles()));
		const opened = await openPluginArchive(bundle);
		expect(opened.id).toBe('app.yorozo.converted.suwatte.alpha');
		expect(opened.manifest['id']).toBe(opened.id);
		// The runner's own TypeScript must be gone, not merely tolerated.
		expect(opened.entrypointSource).toContain('export default {');
		expect(opened.entrypointSource).toContain('getChapterPages');
		expect(opened.entrypointSource).not.toContain('SourceInfo = {');
		expect(opened.entrypointSource).not.toContain('from "@suwatte/toolchain"');

		// …and the result has to parse and evaluate, or it installs and dies.
		const run = new Function(
			opened.entrypointSource.replace('export default', 'globalThis.__suwatte =')
		);
		run();
		const scope = globalThis as unknown as { __suwatte: { id: string } };
		expect(scope.__suwatte.id).toBe(opened.id);
	});

	it('refuses a settings view it cannot express rather than dropping it', async () => {
		const files = sourceFiles();
		files[`${BASE}/alpha/settings.ts`] =
			`export function form() { return UIStepper({ id: "n", title: "N" }); }`;
		files[`${BASE}/alpha/index.ts`] = `${INDEX}\nimport "./settings";`;
		const listing = suwatteAdapter.parseIndex(
			JSON.stringify([{ id: 'alpha', name: 'Alpha', version: '1.0.0' }]),
			INDEX_URL
		).plugins[0];
		await expect(suwatteAdapter.convert(listing, servicesFor(files))).rejects.toThrow(/UIStepper/);
	});

	it('refuses a missing sibling by the address', async () => {
		const files = sourceFiles();
		delete files[`${BASE}/alpha/constants.ts`];
		const listing = suwatteAdapter.parseIndex(
			JSON.stringify([{ id: 'alpha', name: 'Alpha', version: '1.0.0' }]),
			INDEX_URL
		).plugins[0];
		await expect(suwatteAdapter.convert(listing, servicesFor(files))).rejects.toThrow(
			/constants\.ts/
		);
	});
});

/**
 * The catalogue a Suwatte repository actually serves: built by the toolchain in
 * CI, deployed to the repository's site, one `.stt` bundle per row. It shares a
 * row field with Mana's index (`path`), which is why both directions of the
 * claim are pinned.
 */
describe('a built Suwatte catalogue', () => {
	const SITE = 'https://owner.example.invalid/catalogue/';
	const CATALOGUE_URL = `${SITE}sources.json`;
	const CATALOGUE = JSON.stringify({
		catalogVersion: 2,
		generatedAt: '2026-01-01T00:00:00.000Z',
		listName: 'Example Sources',
		sources: [
			{
				id: 'en.example.alpha',
				name: 'Alpha',
				version: 1.6,
				website: 'https://site.example.invalid',
				languages: ['en'],
				rating: 2,
				thumbnail: 'alpha.png',
				path: 'alpha',
				variantId: 'en.example.alpha',
				sourceId: 'alpha',
				environment: 'jsc'
			},
			{
				id: 'en.example.beta',
				name: 'Beta',
				version: 1,
				website: 'https://beta.example.invalid',
				languages: ['en'],
				rating: 1,
				path: 'beta',
				environment: 'jsc'
			}
		]
	});

	/** A bundle in the shape the toolchain's build emits, cut to what the shim touches. */
	const STT = `"use httpclient";
var global = globalThis;
"use strict";
var SourcePackage = (() => {
  class Alpha {
    constructor() { this.client = new HttpClient({ baseUrl: 'https://api.example.invalid' }); }
    async getSearchResults(request, page) {
      return { items: [{ id: 'one', title: 'Found ' + request.query, coverImage: 'https://img.example.invalid/1.jpg' }], isLastPage: true };
    }
  }
  return {
    SourceMetadata: { id: 'en.example.alpha', name: 'Alpha', version: 1.6 },
    SourceConfiguration: null,
    bootstrap: function bootstrap() { return new Alpha(); }
  };
})();
`;

	it('lists each row at the bundle beside the catalogue', () => {
		const parsed = suwatteAdapter.parseIndex(CATALOGUE, CATALOGUE_URL);
		expect(parsed.plugins.map((one) => one.origin?.artifactUrl)).toEqual([
			`${SITE}sources/alpha.stt`,
			`${SITE}sources/beta.stt`
		]);
		expect(parsed.plugins[0].hosts).toContain('site.example.invalid');
		// The build writes the toolchain's rating ordinal: MATURE is 2.
		expect(parsed.plugins.map((one) => one.origin?.isNsfw)).toEqual([true, false]);
	});

	it('is not claimed by Mana, whose rows also carry a path', async () => {
		const { manaAdapter } = await import('./mana');
		expect(() => manaAdapter.parseIndex(CATALOGUE, CATALOGUE_URL)).toThrow(ForeignFormatError);
	});

	it('still leaves a Mana index alone', () => {
		const mana = JSON.stringify({
			repositoryName: 'Example',
			sources: [
				{
					id: 'Example',
					name: 'Example',
					version: '1.0.0',
					path: 'Example',
					environment: 'source',
					intents: 1
				}
			]
		});
		expect(() => suwatteAdapter.parseIndex(mana, CATALOGUE_URL)).toThrow(ForeignFormatError);
	});

	it('runs the bundle the row names, through the shim', async () => {
		const listing = suwatteAdapter.parseIndex(CATALOGUE, CATALOGUE_URL).plugins[0];
		const bundle = await suwatteAdapter.convert(listing, {
			fetchArtifact: async (url) => {
				if (url !== `${SITE}sources/alpha.stt`) throw new Error(url);
				return new TextEncoder().encode(STT);
			},
			getText: async (url) => {
				throw new Error(`nothing else is read: ${url}`);
			},
			listFiles: () => {
				throw new Error('nothing here lists');
			}
		});
		const opened = await openPluginArchive(bundle);
		expect(opened.hosts).toContain('api.example.invalid');

		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			searchCatalog(
				query: string,
				page: number,
				ctx: unknown
			): Promise<{ entries: { sourceMediaId: string; title: string }[] }>;
		};
		const page = await module.searchCatalog('x', 1, { settings: undefined });
		expect(page.entries.map((one) => [one.sourceMediaId, one.title])).toEqual([['one', 'Found x']]);
	});

	/** Converts and loads a bundle for the first catalogue row. */
	async function loadBuilt(stt: string) {
		const listing = suwatteAdapter.parseIndex(CATALOGUE, CATALOGUE_URL).plugins[0];
		const opened = await openPluginArchive(
			await suwatteAdapter.convert(listing, {
				fetchArtifact: async () => new TextEncoder().encode(stt),
				getText: async () => '',
				listFiles: async () => []
			})
		);
		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		return (await import(/* @vite-ignore */ url)).default as {
			readChapter(
				id: string,
				chapter: unknown,
				ctx: unknown
			): Promise<{ pages: { url: string; headers?: Record<string, string> }[] }>;
		};
	}

	it('decodes at load, before the host has made a call', async () => {
		// An HTML entity table decoded from base64 while the module evaluates,
		// which is what a bundled parser does.
		const stt = STT.replace(
			'var SourcePackage = (() => {',
			"var TABLE = atob('aGVsbG8=');\nvar SourcePackage = (() => {"
		).replace("title: 'Found ' + request.query", "title: TABLE + ' ' + request.query");
		const module = (await loadBuilt(stt)) as unknown as {
			searchCatalog(q: string, p: number, ctx: unknown): Promise<{ entries: { title: string }[] }>;
		};
		const page = await module.searchCatalog('x', 1, { settings: undefined });
		expect(page.entries[0].title).toBe('hello x');
	});

	it("sends the image Referer the source's configuration declares, unless a page set its own", async () => {
		const stt = STT.replace(
			'async getSearchResults(request, page) {',
			`getConfiguration() { return { imageReferer: 'https://site.example.invalid/' }; }
    async getChapterPages() {
      return [{ url: 'https://img.example.invalid/1.jpg' }, { url: 'https://img.example.invalid/2.jpg', headers: { referer: 'https://own.example.invalid/' } }];
    }
    async getSearchResults(request, page) {`
		);
		const module = await loadBuilt(stt);
		const read = await module.readChapter('one', { number: 1, sourceChapterId: 'c1' }, {});
		expect(read.pages.map((one) => one.headers)).toEqual([
			{ Referer: 'https://site.example.invalid/' },
			{ referer: 'https://own.example.invalid/' }
		]);
	});

	it('refuses a file at the bundle path that is not a toolchain bundle', async () => {
		const listing = suwatteAdapter.parseIndex(CATALOGUE, CATALOGUE_URL).plugins[0];
		const failure = await suwatteAdapter
			.convert(listing, {
				fetchArtifact: async () => new TextEncoder().encode('<html>not found</html>'),
				getText: async () => '',
				listFiles: async () => []
			})
			.catch((error: unknown) => error);
		expect((failure as ForeignFormatError).obstacles).toEqual(['suwatte:not-a-bundle']);
	});

	it("asks a GitHub repository's site for the catalogue it deploys there", () => {
		const candidates = suwatteAdapter.candidates(new URL('https://github.com/Owner/repo'));
		expect(candidates).toContain('https://owner.github.io/repo/sources.json');
		// A forge whose site address is not a function of the repository asks no site.
		expect(
			suwatteAdapter.candidates(new URL('https://forge.example.invalid/owner/repo'))
		).not.toContain('https://owner.github.io/repo/sources.json');
	});
});
