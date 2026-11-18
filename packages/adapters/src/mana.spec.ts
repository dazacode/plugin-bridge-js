/**
 * What the Mana adapter makes of an index, and of both artifact shapes.
 *
 * The decisions worth pinning are the ones that would be silently wrong: which
 * address a listing resolves to, which rows are skipped, and whether the second
 * hop happens at all. Nothing here reaches the network and no real repository
 * appears in it (AGENTS.md rule 9), so every host is `example.invalid`.
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { manaAdapter } from './mana';

const INDEX_URL = 'https://repo.example.invalid/mana/main/sources.json';

function index(sources: unknown[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ repositoryName: 'Example Sources', ...extra, sources });
}

const ONE = [
	{
		id: 'Example',
		name: 'Example',
		version: '1.2.3',
		website: 'https://site.example.invalid',
		thumbnail: 'Example.png',
		rating: 2,
		description: 'An example.',
		supportedLanguages: ['en_US'],
		path: 'Example',
		environment: 'source',
		intents: 106961928,
		hash: 'f'.repeat(96),
		developers: [{ name: 'Someone' }]
	}
];

/** A built bundle, in the shape the ecosystem's toolchain emits. */
const BUNDLE = `var __polyfill__=(()=>({}))();
class Target {
  constructor() {
    this.info = { id: 'Example', name: 'Example', version: '1.2.3', website: 'https://site.example.invalid' };
  }
  async search(request) {
    return { results: [{ id: 'one', title: 'One', cover: 'https://cdn.example.invalid/1.jpg' }], isLastPage: true };
  }
  async getChapters(id) {
    return [{ chapterId: 'c1', number: 1, title: 'Chapter 1', date: new Date(0) }];
  }
  async getChapterData(id, chapterId) {
    return { pages: [{ url: 'https://img.example.invalid/1.jpg' }] };
  }
}
globalThis.Target=Target;
`;

/** A source tree entry, for the repositories that were never built. */
const SOURCE = `
import { Chapter, ContentRating, SourceInfo } from '@mana-app/types';

const DOMAIN = 'https://site.example.invalid';
const API = atob('aHR0cHM6Ly9hcGkuZXhhbXBsZS5pbnZhbGlk');

export class Target {
  info: SourceInfo = { id: 'Example', name: 'Example', version: '1.2.3' };

  async getSearchResults(query: string, page: number) {
    return [];
  }
}
`;

function services(overrides: Partial<ConversionServices> = {}): ConversionServices {
	return {
		fetchArtifact: async () => {
			throw new Error('no bundle');
		},
		getText: async () => {
			throw new Error('no sibling');
		},
		listFiles: () => {
			throw new Error('nothing here lists');
		},
		...overrides
	};
}

function listing() {
	return manaAdapter.parseIndex(index(ONE), INDEX_URL).plugins[0];
}

describe('the Mana index', () => {
	it('resolves the bundle beside the index it was listed in', () => {
		const parsed = manaAdapter.parseIndex(index(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://repo.example.invalid/mana/main/sources/Example.mana'
		);
		// The source layouts are carried for the second hop, best first after the
		// bundle, and never guessed at conversion time.
		expect(parsed.plugins[0].origin?.detail?.['alternates']).toEqual([
			'https://repo.example.invalid/mana/main/src/sources/Example/index.ts',
			'https://repo.example.invalid/mana/main/src/Example/main.ts',
			'https://repo.example.invalid/mana/main/src/Example/index.ts'
		]);
	});

	it('reads the bare array an unbuilt repository publishes', () => {
		const parsed = manaAdapter.parseIndex(JSON.stringify(ONE), INDEX_URL);
		expect(parsed.plugins.map((one) => one.origin?.foreignId)).toEqual(['Example']);
	});

	it('skips a tracker and counts it', () => {
		// A tracker shares the array and has no catalogue; a row that silently
		// disappears is indistinguishable from a parser that dropped it.
		const parsed = manaAdapter.parseIndex(
			index([
				...ONE,
				{ id: 'Tracking', name: 'Tracking', path: 'Tracking', environment: 'tracker' }
			]),
			INDEX_URL
		);
		expect(parsed.plugins.map((one) => one.origin?.foreignId)).toEqual(['Example']);
		expect(parsed.filteredOut).toBe(1);
	});

	it('marks only an adult rating as such', () => {
		const adult = manaAdapter.parseIndex(index(ONE), INDEX_URL).plugins[0];
		const mixed = manaAdapter.parseIndex(index([{ ...ONE[0], rating: 1 }]), INDEX_URL).plugins[0];
		expect(adult.origin?.isNsfw).toBe(true);
		// A mixed catalogue is not a claim that everything behind it is adult.
		expect(mixed.origin?.isNsfw).toBe(false);
	});

	it('refuses a document that is not one of these', () => {
		const mangayomi = JSON.stringify([
			{ id: 'x', name: 'x', sourceCodeUrl: 'https://example.invalid/x.js' }
		]);
		expect(() => manaAdapter.parseIndex(mangayomi, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => manaAdapter.parseIndex('{"sources":[]}', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => manaAdapter.parseIndex('{"schemaVersion":1}', INDEX_URL)).toThrow(
			ForeignFormatError
		);
		expect(() => manaAdapter.parseIndex('not json', INDEX_URL)).toThrow(ForeignFormatError);
	});
});

describe('what a converted Mana source is', () => {
	it('runs a built bundle on the host bridge and keeps it byte for byte', async () => {
		const bundle = await manaAdapter.convert(
			listing(),
			services({ fetchArtifact: async () => new TextEncoder().encode(BUNDLE) })
		);

		const opened = await openPluginArchive(bundle);
		expect(opened.id).toBe('app.yorozo.converted.mana.example');
		expect(opened.entrypointSource).toContain('globalThis.Target=Target;');
		expect(opened.entrypointSource).toContain('globalThis.__manaHTTPBridge = {');
		// The entrypoint must be a module body a sandbox can parse, not just a
		// string that reads plausibly.
		expect(
			() => new Function(opened.entrypointSource.replace('export default', 'return'))
		).not.toThrow();
		// The bundle's own hosts, and the site the index named.
		expect(opened.hosts).toContain('site.example.invalid');
		expect(opened.hosts).toContain('cdn.example.invalid');
	});

	it('falls back to the source file, stripped, when nothing was built', async () => {
		const source = 'https://repo.example.invalid/mana/main/src/sources/Example/index.ts';
		const bundle = await manaAdapter.convert(
			listing(),
			services({ getText: async (url) => (url === source ? SOURCE : Promise.reject()) })
		);

		const opened = await openPluginArchive(bundle);
		const payload = opened.entrypointSource;
		expect(opened.id).toBe('app.yorozo.converted.mana.example');
		// The types package is resolved to the shim's module, and the class the
		// source declares is what the adapter runs.
		expect(payload).toContain('const { Chapter, ContentRating, SourceInfo } = __manaTypes;');
		expect(payload).toContain("return typeof Target === 'function' ? Target : null;");
		// No type annotation survives into the bundle.
		expect(payload).not.toContain('query: string');
	});

	it('declares a host the source only wrote in base64', async () => {
		const source = 'https://repo.example.invalid/mana/main/src/sources/Example/index.ts';
		const opened = await openPluginArchive(
			await manaAdapter.convert(
				listing(),
				services({ getText: async (url) => (url === source ? SOURCE : Promise.reject()) })
			)
		);
		expect(opened.hosts).toContain('api.example.invalid');
	});

	it('refuses a source file that imports a sibling, naming it', async () => {
		const source = 'https://repo.example.invalid/mana/main/src/sources/Example/index.ts';
		const entry = `
			import { Base } from './ExampleBase';
			export class Target extends Base {}
		`;
		const failure = await manaAdapter
			.convert(
				listing(),
				services({ getText: async (url) => (url === source ? entry : Promise.reject()) })
			)
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ForeignFormatError);
		expect((failure as ForeignFormatError).obstacles).toEqual(['relativeModuleImports']);
		expect((failure as ForeignFormatError).message).toContain('"./ExampleBase"');
	});

	it('refuses when nothing at all was published', async () => {
		const failure = await manaAdapter
			.convert(listing(), services())
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ForeignFormatError);
		expect((failure as ForeignFormatError).obstacles).toEqual(['missingArtifact']);
	});
});
