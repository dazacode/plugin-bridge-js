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
import { manaAdapter, stripTypescript } from './mana';

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

	it('refuses a source file whose sibling is not there, naming it', async () => {
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
		expect((failure as ForeignFormatError).obstacles).toEqual(['relativeModuleMissing']);
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

/**
 * The source path across files: an entry that extends a template in its own
 * repository, the way every unbuilt source in the measured corpus is written.
 */
describe('a Mana source that imports its own repository', () => {
	const REPO = 'https://repo.example.invalid/mana/main/';
	const ENTRY = `${REPO}src/Example/main.ts`;

	const FILES: Record<string, string> = {
		[ENTRY]: `
import { ContentRating, type SourceInfo } from '@mana-app/types';
import type { ClientOptions } from '../../lib/client.ts';
import { TemplateSource } from '../../lib/source.ts';
import { tidy, LABEL } from '../../lib/forms';
import shout from './shout.js';

export class Target extends TemplateSource {
  info: SourceInfo = { id: 'Example', name: 'Example', version: '1.0.0' };
  label(): string {
    return shout(tidy(LABEL)) + ':' + ContentRating.MATURE;
  }
}
`,
		[`${REPO}lib/source.ts`]: `
import { tidy as clean } from './text';
export abstract class TemplateSource {
  abstract label(): string;
  async getSearchResults(query: string, page: number) {
    return { results: [{ id: clean(' one '), title: this.label() + '/' + query }], isLastPage: true };
  }
}
`,
		[`${REPO}lib/text.ts`]: `
export function tidy(value: string): string {
  return value.trim();
}
const LOUD = 'example';
export { LOUD as LABEL };
`,
		[`${REPO}lib/forms/index.ts`]: `
export * from './query.ts';
export { LABEL } from '../text.ts';
`,
		[`${REPO}lib/forms/query.ts`]: `
export { tidy } from '../text';
`,
		[`${REPO}src/Example/shout.ts`]: `
export default function shout(value: string): string {
  return value.toUpperCase();
}
`
	};

	function served(files: Record<string, string>, asked: string[] = []) {
		return services({
			getText: async (url) => {
				asked.push(url);
				const body = files[url];
				return body === undefined ? Promise.reject(new Error(`no ${url}`)) : body;
			}
		});
	}

	function sourceListing() {
		return manaAdapter.parseIndex(
			JSON.stringify([
				{ id: 'Example', name: 'Example', path: 'Example', website: 'https://site.example.invalid' }
			]),
			`${REPO}sources.json`
		).plugins[0];
	}

	async function load(files: Record<string, string>) {
		const opened = await openPluginArchive(
			await manaAdapter.convert(sourceListing(), served(files))
		);
		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		return (await import(/* @vite-ignore */ url)).default as {
			searchCatalog(
				query: string,
				page: number,
				ctx: unknown
			): Promise<{ entries: { sourceMediaId: string; title: string }[] }>;
		};
	}

	it('links every module it imports, and runs as one source', async () => {
		const module = await load(FILES);
		const page = await module.searchCatalog('q', 1, { http: {} });
		// Each piece of that title came through a different link: a base class
		// two directories up, a renamed re-export, a wholesale re-export through
		// a barrel, a default import spelled `.js` for a `.ts` file, and the
		// shim's own types package.
		expect(page.entries).toEqual([
			{ sourceMediaId: 'one', title: 'EXAMPLE:2/q', alternativeTitles: [] }
		]);
	});

	it('imports nothing for a list of types, even from a package it does not have', async () => {
		const files = {
			...FILES,
			[ENTRY]: `import { type CheerioAPI } from 'cheerio';\n${FILES[ENTRY]}`
		};
		const module = await load(files);
		const page = await module.searchCatalog('q', 1, { http: {} });
		expect(page.entries).toHaveLength(1);
	});

	it('never fetches what an import only uses as a type', async () => {
		const asked: string[] = [];
		await manaAdapter.convert(sourceListing(), served(FILES, asked));
		expect(asked).not.toContain(`${REPO}lib/client.ts`);
	});

	it('refuses a sibling that climbs out of the repository, without fetching it', async () => {
		const asked: string[] = [];
		const files = {
			...FILES,
			[`${REPO}lib/text.ts`]: `import { x } from '../../../../elsewhere/x.ts';\nexport const tidy = x;`
		};
		const failure = await manaAdapter
			.convert(sourceListing(), served(files, asked))
			.catch((error: unknown) => error);
		expect((failure as ForeignFormatError).obstacles).toEqual(['relativeModuleEscapes']);
		expect(asked.some((one) => one.includes('elsewhere'))).toBe(false);
	});

	it('refuses modules that import each other', async () => {
		const files = {
			...FILES,
			[`${REPO}lib/text.ts`]: `import { TemplateSource } from './source.ts';\nexport const tidy = (v: string) => v;\nexport const LABEL = 'x';`
		};
		const failure = await manaAdapter
			.convert(sourceListing(), served(files))
			.catch((error: unknown) => error);
		expect((failure as ForeignFormatError).obstacles).toEqual(['relativeModuleCycle']);
	});

	it('refuses a package a sibling imports, not only one the entry does', async () => {
		const required = {
			...FILES,
			[`${REPO}lib/text.ts`]: `const helper = require('left-pad');\nexport const tidy = helper;\nexport const LABEL = 'x';`
		};
		const imported = {
			...FILES,
			[`${REPO}lib/text.ts`]: `import { load } from 'cheerio';\nexport const tidy = load;\nexport const LABEL = 'x';`
		};
		for (const [files, name] of [
			[required, 'left-pad'],
			[imported, 'cheerio']
		] as const) {
			const failure = await manaAdapter
				.convert(sourceListing(), served(files))
				.catch((error: unknown) => error);
			expect((failure as ForeignFormatError).obstacles).toEqual(['packageImports']);
			expect((failure as ForeignFormatError).message).toContain(`"${name}"`);
		}
	});

	it('scans every module it carries for the hosts it reaches', async () => {
		const files = {
			...FILES,
			[`${REPO}lib/text.ts`]: `${FILES[`${REPO}lib/text.ts`]}\nexport const API = 'https://api.example.invalid/v1';`
		};
		const opened = await openPluginArchive(
			await manaAdapter.convert(sourceListing(), served(files))
		);
		expect(opened.hosts).toContain('api.example.invalid');
	});
});

/**
 * Type syntax the measured sources write, each of which the stripper once left
 * in or cut too far. Each is checked by *running* the output: a stripper that
 * leaves a type behind produces a syntax error, and one that cuts too far
 * produces a different value.
 */
describe('stripping TypeScript', () => {
	function run(source: string): unknown {
		const code = stripTypescript(source).code;
		return new Function(`${code}\nreturn result;`)();
	}

	it('keeps an object type that is the second half of a union', () => {
		expect(
			run(`function f(request: string | { filters?: Record<string, number> }) { return 1; }
const result = f('x');`)
		).toBe(1);
	});

	it('keeps an object type behind a type operator', () => {
		expect(
			run(`function f(options: readonly { id: string; isDefault?: boolean }[], fallback = 'z') {
  return options.length + fallback;
}
const result = f([]);`)
		).toBe('0z');
	});

	it('reads a function type in a parameter as one type', () => {
		expect(
			run(`async function attempt<T>(read: () => Promise<T | null>, fallback: T) { return fallback; }
const result = typeof attempt;`)
		).toBe('function');
	});

	it('does not read the second ? of ?? as a ternary', () => {
		expect(
			run(`function f(title: { tags?: string[] }) {
  const name = title.tags ?? undefined;
  const tags: string[] = (title.tags ?? []).map((one) => one);
  return tags.length;
}
const result = f({ tags: ['a'] });`)
		).toBe(1);
	});

	it('reads a regex after return as a regex', () => {
		expect(
			run(`function f(url: string): boolean {
  return /^https?:\\/\\//.test(url);
}
const result = f('https://x');`)
		).toBe(true);
	});

	it('strips a generic whose argument is an object type', () => {
		expect(
			run(`const cache = new Map<string, { at: number; page: string }>();
cache.set('a', { at: 1, page: 'p' });
const result = cache.size;`)
		).toBe(1);
	});

	it('strips a non-null assertion before an operator', () => {
		expect(
			run(`const w: number[] = [1, 2];
const result = (w[0]! + w[1]!) >>> 0;`)
		).toBe(3);
	});

	it('strips an abstract class and drops its abstract members', () => {
		expect(
			run(`abstract class Base {
  abstract name(): string;
  protected abstract readonly kind: string;
  greet(): string { return 'hi ' + this.name(); }
}
class One extends Base { name() { return 'one'; } }
const result = new One().greet();`)
		).toBe('hi one');
	});

	it('reads a union whose members are documented between them as one type', () => {
		expect(
			run(`type Field =
  | { type: "text"; key: string }
  /**
   * An action, so it carries no key of its own.
   */
  | { type: "button"; id: string };
const result = 'kept';`)
		).toBe('kept');
	});

	it('reads a generic alias split over lines as one type', () => {
		expect(
			run(`type Picked = Pick<
  Record<string, number>,
  "a" | "b"
>;
const result = 'kept';`)
		).toBe('kept');
	});

	it('keeps the else branch of a ternary written without spaces', () => {
		expect(
			run(`const author = '';
const result = [...(author?['x']:[])].length;`)
		).toBe(0);
	});

	it('does not read the letters of a string as a declarator', () => {
		expect(
			run(`const result: { id: string; title: string }[] = [
  { id: "let", title: "Enabled" },
];`)
		).toEqual([{ id: 'let', title: 'Enabled' }]);
	});

	it('does not read the start of a longer name as a declarator', () => {
		expect(
			run(`const letters = 'a';
const result: { id: string; title: string }[] = [
  { id: letters, title: "Enabled" },
];`)
		).toEqual([{ id: 'a', title: 'Enabled' }]);
	});
});
