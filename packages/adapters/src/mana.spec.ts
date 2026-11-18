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
import { type ReaderOptions } from '../../lib/reader.ts';
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
		expect(asked).not.toContain(`${REPO}lib/reader.ts`);
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
			[`${REPO}lib/text.ts`]: `import moment from 'moment';\nexport const tidy = moment;\nexport const LABEL = 'x';`
		};
		for (const [files, name] of [
			[required, 'left-pad'],
			[imported, 'moment']
		] as const) {
			const failure = await manaAdapter
				.convert(sourceListing(), served(files))
				.catch((error: unknown) => error);
			expect((failure as ForeignFormatError).obstacles).toEqual(['packageImports']);
			expect((failure as ForeignFormatError).message).toContain(`"${name}"`);
		}
	});

	it("answers the three packages the corpus imports with the runtime's own", async () => {
		const files = {
			...FILES,
			[`${REPO}lib/text.ts`]: `
import { load } from 'cheerio';
import { decode } from 'html-entities';
import CryptoJS from 'crypto-js';
export function tidy(value: string): string {
  const $ = load('<p class="t"> ' + value + ' &amp; <b>x</b></p>');
  return decode($('p.t').text().trim()) + ':' + CryptoJS.SHA256('abc').toString().slice(0, 8);
}
export const LABEL = 'one';`
		};
		const module = await load(files);
		const page = await module.searchCatalog('q', 1, { http: {} });
		// Text as written: the two spaces either side of the entity both survive.
		expect(page.entries[0].sourceMediaId).toBe('one  & x:ba7816bf');
	});

	it('loads a source that builds its search form at module scope', async () => {
		const files = {
			...FILES,
			[`${REPO}lib/text.ts`]: `
import { SearchMenuPicker, SearchMultiPicker, SearchPicker, SearchListSection } from '@mana-app/types';
const FORM = SearchListSection({ children: [
  SearchMenuPicker({ id: 'sort', title: 'Sort', options: [] }),
  SearchMultiPicker({ id: 'genre', title: 'Genre', options: [] }),
  SearchPicker({ id: 'status', title: 'Status', options: [] })
] });
export const tidy = (value: string) => value.trim() + ':' + FORM.children.map((one: { type: number; presentation?: string }) => one.type + (one.presentation ?? '')).join(',');
export const LABEL = 'x';`
		};
		const module = await load(files);
		const page = await module.searchCatalog('q', 1, { http: {} });
		// The published factories' own tags: SELECT is 1, MULTISELECT 2.
		expect(page.entries[0].sourceMediaId).toBe('one:1menu,2,1');
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

	it('reads a typed arrow whose parameter is itself a function type', () => {
		expect(
			run(`const hits = (r: { t: string }, match: (b: string, t: string) => boolean): boolean =>
  match(r.t, 'x');
const result = hits({ t: 'x' }, (b, t) => b === t);`)
		).toBe(true);
	});

	it('strips an object type handed to a generic call', () => {
		expect(
			run(`const store = { get: (key: string) => ({ at: 1, value: key }) };
const hit = store.get<{
  at: number;
  value: string;
}>('k');
const parsed = JSON.parse<{ status: number; result: string }>('{"status":1}');
const result = [hit.value, parsed.status];`)
		).toEqual(['k', 1]);
	});

	it('strips the type of a second declarator in a list', () => {
		expect(
			run(`const seen = new Set<string>(), items: string[] = [], total: number | undefined = 2;
const result = [items.length, total];`)
		).toEqual([0, 2]);
	});

	it('keeps an object literal whose key follows an `as const`', () => {
		expect(
			run(`const author = { href: '', name: 'n' };
const result = { type: 'staff' as const, id: author.href || author.name };`)
		).toEqual({ type: 'staff', id: 'n' });
	});

	it('reads a type that continues on the next line after `as`', () => {
		expect(
			run(`const filters: Record<string, unknown> = { a: { included: [1] } };
const value = filters['a'] as
  | { included?: unknown[] }
  | undefined;
const result = value?.included;`)
		).toEqual([1]);
	});

	it('ends an assertion at a ternary colon, and chains `as unknown as T`', () => {
		expect(
			run(`const item: unknown = { a: 1 };
const page = item ? item as { a: number } : {};
const scope = globalThis as unknown as {
  nothing: string;
};
const result = [page, typeof scope];`)
		).toEqual([{ a: 1 }, 'object']);
	});

	it('does not read `as` inside a longer name', () => {
		expect(
			run(`const sourceCanvas = 3;
let resultCanvas = sourceCanvas;
const result = resultCanvas;`)
		).toBe(3);
	});

	it('strips a type predicate', () => {
		expect(
			run(`const rows = [{ title: 'a' }, null].filter((row): row is { title: string } => row !== null);
const result = rows.length;`)
		).toBe(1);
	});

	it('strips an angle-bracket assertion and a generic arrow', () => {
		expect(
			run(`const variables: Record<string, unknown> = { a: 'x' };
const first = <T>(list: T[]): T => list[0];
const result = [(<string>variables['a']).length, first<number>([4])];`)
		).toEqual([1, 4]);
	});

	it('assigns a parameter property, before and after super', () => {
		expect(
			run(`class Base { constructor(protected readonly name: string) {} }
class Cache extends Base {
  constructor(private readonly load: () => number, name: string) {
    super(name);
  }
  read() { return this.load() + ':' + this.name; }
}
const result = new Cache(() => 7, 'n').read();`)
		).toBe('7:n');
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

/**
 * The page transport: the client a source hands the app for its images, run
 * here so that what it would have sent travels on the page (ABI §8.3).
 */
describe('a Mana page transport', () => {
	const sent: { url: string; headers: Record<string, string>; method?: string }[] = [];
	const sentBodies: unknown[] = [];
	function context() {
		sent.length = 0;
		sentBodies.length = 0;
		return {
			http: {
				send: async (
					url: string,
					init: { headers?: Record<string, string>; body?: unknown; method?: string }
				) => {
					sent.push({ url, headers: init.headers ?? {}, method: init.method });
					sentBodies.push(init.body);
					const body = url.includes('/viewer/')
						? `<img id="img" src="https://img.example.invalid${url.slice(url.indexOf('/viewer/') + 7)}.jpg">`
						: '{}';
					return {
						status: 200,
						url,
						headers: { 'content-type': 'text/html' },
						text: async () => body,
						json: async () => ({}),
						bytes: async () => new TextEncoder().encode(body)
					};
				}
			},
			text: {
				encode: (v: string) => new TextEncoder().encode(v),
				decode: (b: Uint8Array) => new TextDecoder().decode(b)
			},
			bytes: {
				toBase64: (b: Uint8Array) => Buffer.from(b).toString('base64'),
				fromBase64: (v: string) => new Uint8Array(Buffer.from(v, 'base64'))
			}
		};
	}

	async function loadBundle(bundle: string) {
		const opened = await openPluginArchive(
			await manaAdapter.convert(
				listing(),
				services({ fetchArtifact: async () => new TextEncoder().encode(bundle) })
			)
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

	/**
	 * A built bundle whose image client works the way the published one does:
	 * request interceptors in order, then a send through the app's bridge at
	 * the page origin. Its interceptor reads a viewer page through the
	 * ordinary client first — a real request — to learn the image address.
	 */
	const TRANSPORT_BUNDLE = (reads: boolean) => `
class Client {
  constructor(interceptors, responses) { this.requests = interceptors; this.responses = responses; }
  async get(url) {
    const answer = await globalThis.__manaHTTPBridge.send({ operation: 0, url: url, method: 0, headers: {}, origin: 0 });
    const read = await globalThis.__manaHTTPBridge.send({ operation: 1, bodyID: answer.bodyID, reader: 0 });
    return read.value;
  }
  async [Symbol.for('mana.http.image.v1')](request) {
    let current = { url: request.url, headers: {} };
    for (const one of this.requests) current = await one(current, { origin: request.origin });
    let response = await globalThis.__manaHTTPBridge.send({ operation: 0, url: current.url, method: 0, headers: current.headers, origin: request.origin });
    for (const one of this.responses) response = await one(response, { origin: request.origin });
    return response;
  }
}
class Target {
  constructor() {
    this.info = { id: 'Example', name: 'Example', version: '1.0.0', website: 'https://site.example.invalid' };
    this.client = new Client([], []);
    this.images = new Client([async (request) => {
      const html = await this.client.get(request.url);
      const url = /src="([^"]+)"/.exec(html)[1];
      return { url: url, headers: Object.assign({}, request.headers, { referer: 'https://site.example.invalid/', 'content-length': '0' }) };
    }], [
      // A status check scoped to ordinary requests, which passes an image through.
      async (response, context) => (context.origin === 0 && response.status !== 200 ? Promise.reject(new Error('blocked')) : response),
      ${reads ? 'async (response) => { await globalThis.__manaHTTPBridge.send({ operation: 1, bodyID: response.bodyID, reader: 1 }); return response; },' : ''}
    ]);
  }
  async getChapterData() { return { pages: [{ url: 'https://site.example.invalid/viewer/7' }] }; }
  getPageTransport() { return this.images; }
}
globalThis.Target = Target;
`;

	it('sends each page as its transport would have: rewritten, with the headers it added', async () => {
		const module = await loadBundle(TRANSPORT_BUNDLE(false));
		const read = await module.readChapter('one', { number: 1, sourceChapterId: 'c1' }, context());
		expect(read.pages).toEqual([
			{
				index: 0,
				url: 'https://img.example.invalid/7.jpg',
				headers: { referer: 'https://site.example.invalid/' }
			}
		]);
		// The viewer page went out for real; the image request did not.
		expect(sent.map((one) => one.url)).toEqual(['https://site.example.invalid/viewer/7']);
	});

	it('refuses a transport that reads the image response, and passes one that does not', async () => {
		const module = await loadBundle(TRANSPORT_BUNDLE(true));
		await expect(
			module.readChapter('one', { number: 1, sourceChapterId: 'c1' }, context())
		).rejects.toThrow(/reads the image response itself/);
	});

	it('runs a source tree’s async interceptors and takes what they answer', async () => {
		const REPO = 'https://repo.example.invalid/mana/main/';
		const entry = `
import { Body, HttpClient } from '@mana-app/types';
export class Target {
  info = { id: 'Example', name: 'Example', version: '1.0.0', website: 'https://site.example.invalid' };
  client = new HttpClient().addRequestInterceptor(async (request: any) => { request.headers.set('x-signed', 'yes'); return request; });
  images = new HttpClient().addRequestInterceptor(async (request: any) => ({ ...request, url: request.url + '?sig=1' }))
    .addRequestInterceptor(async (request: any) => { if (!request.headers.has('referer')) request.headers.set('Referer', 'https://site.example.invalid/'); return request; });
  async getSearchResults(query: string) {
    await this.client.get('https://api.example.invalid/search');
    await this.client.request({ url: 'https://api.example.invalid/graphql', method: 'POST', body: Body.json({ q: query }) });
    return [];
  }
  async getChapterData() { return { pages: [{ url: 'https://img.example.invalid/1.jpg' }] }; }
  getPageTransport() { return this.images; }
}`;
		const sourceListing = manaAdapter.parseIndex(
			JSON.stringify([
				{ id: 'Example', name: 'Example', path: 'Example', website: 'https://site.example.invalid' }
			]),
			`${REPO}sources.json`
		).plugins[0];
		const opened = await openPluginArchive(
			await manaAdapter.convert(
				sourceListing,
				services({
					getText: async (url) =>
						url === `${REPO}src/Example/main.ts` ? entry : Promise.reject(new Error(url))
				})
			)
		);
		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			searchCatalog(q: string, p: number, ctx: unknown): Promise<unknown>;
			readChapter(id: string, chapter: unknown, ctx: unknown): Promise<{ pages: unknown[] }>;
		};
		const ctx = context();
		await module.searchCatalog('q', 1, ctx);
		expect(sent[0].headers['x-signed']).toBe('yes');
		// A published body builder goes on the wire as the published client puts it.
		expect(sent[1].headers['content-type']).toBe('application/json');
		expect(sentBodies[1]).toBe('{"q":"q"}');
		const read = await module.readChapter('one', { number: 1, sourceChapterId: 'c1' }, ctx);
		expect(read.pages).toEqual([
			{
				index: 0,
				url: 'https://img.example.invalid/1.jpg?sig=1',
				headers: { referer: 'https://site.example.invalid/' }
			}
		]);
	});

	it('speaks the published client: numeric methods, a base URL, header methods, ObjectStore', async () => {
		const REPO = 'https://repo.example.invalid/mana/main/';
		const entry = `
import { HttpClient, HttpMethod } from '@mana-app/types';
export class Target {
  info = { id: 'Example', name: 'Example', version: '1.0.0', website: 'https://site.example.invalid' };
  client = new HttpClient().setBaseURL('https://api.example.invalid/v1/').addHeader('x-key', 'k');
  async getSearchResults(query: string) {
    const response = await this.client.request({ url: 'search', method: HttpMethod.Post });
    await ObjectStore.set('seen', response.headers.get('Content-Type'));
    return [{ id: 'one', title: String(await ObjectStore.get('seen')) }];
  }
}`;
		const sourceListing = manaAdapter.parseIndex(
			JSON.stringify([
				{ id: 'Example', name: 'Example', path: 'Example', website: 'https://site.example.invalid' }
			]),
			`${REPO}sources.json`
		).plugins[0];
		const opened = await openPluginArchive(
			await manaAdapter.convert(
				sourceListing,
				services({
					getText: async (url) =>
						url === `${REPO}src/Example/main.ts` ? entry : Promise.reject(new Error(url))
				})
			)
		);
		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			searchCatalog(q: string, p: number, ctx: unknown): Promise<{ entries: { title: string }[] }>;
		};
		const page = await module.searchCatalog('q', 1, context());
		expect(sent[0]).toEqual({
			url: 'https://api.example.invalid/v1/search',
			method: 'POST',
			headers: { 'x-key': 'k' }
		});
		expect(page.entries[0].title).toBe('text/html');
	});

	it('sends a built bundle’s numbered method by the published numbering', async () => {
		const module = (await loadBundle(`
class Target {
  constructor() { this.info = { id: 'Example', name: 'Example', version: '1.0.0', website: 'https://site.example.invalid' }; }
  async search() {
    await globalThis.__manaHTTPBridge.send({ operation: 0, url: 'https://site.example.invalid/a', method: 1, headers: {}, origin: 0 });
    await globalThis.__manaHTTPBridge.send({ operation: 0, url: 'https://site.example.invalid/b', method: 2, headers: {}, origin: 0 });
    return { results: [], isLastPage: true };
  }
}
globalThis.Target = Target;
`)) as unknown as { searchCatalog(q: string, p: number, ctx: unknown): Promise<unknown> };
		await module.searchCatalog('q', 1, context());
		// 1 is Head and 2 is Post; an older table here sent 1 as a GET.
		expect(sent.map((one) => one.method)).toEqual(['HEAD', 'POST']);
	});
});
