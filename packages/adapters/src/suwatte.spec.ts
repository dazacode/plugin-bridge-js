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
