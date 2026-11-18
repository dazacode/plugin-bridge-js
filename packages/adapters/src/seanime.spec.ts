/**
 * What the Seanime adapter makes of a marketplace, and of a manifest two hops
 * away from it.
 *
 * The load-bearing facts are the filter — a `plugin` has no catalogue and must
 * not be listed — and that conversion refuses a language by name instead of
 * packaging something that cannot run. No real repository appears here
 * (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { seanimeAdapter } from './seanime';

const INDEX_URL = 'https://market.example.invalid/seanime/marketplace/main.json';
const MANIFEST = 'https://market.example.invalid/providers/example/manifest.json';
const PAYLOAD = 'https://market.example.invalid/providers/example/provider.js';

function marketplace(entries: unknown[]): string {
	return JSON.stringify(entries);
}

const MANGA = {
	id: 'example',
	name: 'Example',
	description: 'An example manga provider.',
	manifestURI: MANIFEST,
	author: 'Someone',
	type: 'manga-provider',
	language: 'javascript',
	lang: 'en',
	icon: 'https://cdn.example.invalid/example.png',
	website: 'https://site.example.invalid'
};

const ANIME = {
	...MANGA,
	id: 'example-anime',
	name: 'Example Anime',
	type: 'onlinestream-provider'
};
const PLUGIN = { ...MANGA, id: 'example-plugin', name: 'Example Plugin', type: 'plugin' };

const PAYLOAD_SOURCE = `
class Provider {
  async search(opts) {
    return [{ id: 'one', title: 'One', image: 'https://cdn.example.invalid/1.jpg' }];
  }
  async findChapters(id) {
    return [{ id: 'c1', chapter: '1', index: 0, title: 'Chapter 1' }];
  }
  async findChapterPages(id) {
    return [{ url: 'https://img.example.invalid/1.jpg', index: 0, headers: {} }];
  }
}
`;

function services(overrides: Partial<ConversionServices> = {}): ConversionServices {
	return {
		fetchArtifact: async () => {
			throw new Error('the manifest is a text hop here');
		},
		getText: async (url) => {
			if (url === MANIFEST) {
				return JSON.stringify({
					id: 'example',
					name: 'Example',
					version: '3.4.5',
					language: 'javascript',
					type: 'manga-provider',
					payloadURI: PAYLOAD
				});
			}
			if (url === PAYLOAD) return PAYLOAD_SOURCE;
			throw new Error(`no ${url}`);
		},
		listFiles: () => {
			throw new Error('nothing here lists');
		},
		...overrides
	};
}

function listing() {
	return seanimeAdapter.parseIndex(marketplace([MANGA]), INDEX_URL).plugins[0];
}

describe('the Seanime marketplace', () => {
	it('lists providers and carries the manifest hop on the listing', () => {
		const parsed = seanimeAdapter.parseIndex(marketplace([MANGA, ANIME]), INDEX_URL);
		expect(parsed.plugins.map((one) => one.origin?.foreignId)).toEqual([
			'example',
			'example-anime'
		]);
		// The artifact is the first hop; the payload is found from the manifest.
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(MANIFEST);
		expect(parsed.plugins[0].origin?.detail?.['manifestURI']).toBe(MANIFEST);
		expect(parsed.plugins[1].origin?.mediaKind).toBe('anime');
	});

	it('skips a client plugin, which has no catalogue, and counts it', () => {
		const parsed = seanimeAdapter.parseIndex(marketplace([MANGA, PLUGIN]), INDEX_URL);
		expect(parsed.plugins.map((one) => one.origin?.foreignId)).toEqual(['example']);
		expect(parsed.filteredOut).toBe(1);
	});

	it('marks a torrent provider as peer-to-peer before it is installed', () => {
		const torrent = { ...MANGA, id: 'example-torrent', type: 'anime-torrent-provider' };
		const parsed = seanimeAdapter.parseIndex(marketplace([torrent]), INDEX_URL);
		expect(parsed.plugins[0].origin?.declaredP2p).toBe(true);
	});

	it('resolves a relative manifest against the marketplace', () => {
		const relative = { ...MANGA, manifestURI: 'providers/example/manifest.json' };
		const parsed = seanimeAdapter.parseIndex(marketplace([relative]), INDEX_URL);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://market.example.invalid/seanime/marketplace/providers/example/manifest.json'
		);
	});

	it('refuses a document that is not one of these', () => {
		expect(() => seanimeAdapter.parseIndex('{"sources":[]}', INDEX_URL)).toThrow(
			ForeignFormatError
		);
		expect(() => seanimeAdapter.parseIndex('[]', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => seanimeAdapter.parseIndex(marketplace([{ id: 'x' }]), INDEX_URL)).toThrow(
			ForeignFormatError
		);
		expect(() => seanimeAdapter.parseIndex('not json', INDEX_URL)).toThrow(ForeignFormatError);
	});
});

describe('what a converted Seanime provider is', () => {
	it('walks the manifest to the payload and packages it', async () => {
		const bundle = await seanimeAdapter.convert(listing(), services());

		const opened = await openPluginArchive(bundle);
		expect(opened.id).toBe('app.yorozo.converted.seanime.example');
		expect(opened.version).toBe('3.4.5');
		expect(opened.entrypointSource).toContain('class Provider {');
		// A manga provider declares the chapter pair and no episode pair.
		expect(opened.entrypointSource).toContain('async readChapter(sourceMediaId, chapter, ctx)');
		expect(opened.entrypointSource).not.toContain('async resolve(sourceMediaId, episode, ctx)');
		expect(opened.hosts).toContain('site.example.invalid');
		expect(opened.hosts).toContain('img.example.invalid');
		expect(
			() => new Function(opened.entrypointSource.replace('export default', 'return'))
		).not.toThrow();
	});

	it('refuses a payload in a language it cannot run, naming it', async () => {
		const manifest = JSON.stringify({
			id: 'example',
			name: 'Example',
			language: 'dart',
			type: 'manga-provider',
			payloadURI: PAYLOAD
		});
		const failure = await seanimeAdapter
			.convert(listing(), services({ getText: async () => manifest }))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ForeignFormatError);
		expect((failure as ForeignFormatError).obstacles).toEqual(['payloadLanguage']);
		expect((failure as ForeignFormatError).message).toContain('dart');
	});

	it('refuses a manifest that is not a provider at all', async () => {
		const manifest = JSON.stringify({
			id: 'example',
			name: 'Example',
			language: 'javascript',
			type: 'plugin',
			payloadURI: PAYLOAD
		});
		const failure = await seanimeAdapter
			.convert(listing(), services({ getText: async () => manifest }))
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ForeignFormatError);
		expect((failure as ForeignFormatError).obstacles).toEqual(['nonProviderManifest']);
	});

	it('strips a TypeScript payload rather than refusing it', async () => {
		const typed = `class Provider {\n  async search(opts: { query: string }): Promise<unknown[]> {\n    return [];\n  }\n}`;
		const manifest = JSON.stringify({
			id: 'example',
			name: 'Example',
			language: 'typescript',
			type: 'onlinestream-provider',
			payloadURI: PAYLOAD
		});
		const opened = await openPluginArchive(
			await seanimeAdapter.convert(
				listing(),
				services({
					getText: async (url) => {
						if (url === MANIFEST) return manifest;
						if (url === PAYLOAD) return typed;
						throw new Error(url);
					}
				})
			)
		);

		expect(opened.entrypointSource).toContain('async search(opts)');
		expect(opened.entrypointSource).not.toContain('Promise<unknown[]>');
	});
});
