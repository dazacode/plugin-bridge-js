/**
 * What the Paperback adapter makes of a registration document and of a source.
 *
 * The decisions worth pinning are the negatives: which bodies are refused, and
 * which addresses a bundle declares. Both are easy to be quietly wrong about —
 * a parser that claims a sibling format breaks detection for it, and a bundle
 * whose allowlist is the download host searches and then cannot read the page.
 * No real repository appears here (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { paperbackAdapter } from './paperback';

const INDEX_URL = 'https://raw.example.invalid/owner/repo/main/0.9/stable/versioning.json';

function registration(sources: unknown[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		buildTime: '2026-01-02T03:04:05.000Z',
		builtWith: { toolchain: '1.0.0-alpha.1', types: '1.0.0-alpha.1' },
		repository: { name: 'Example extensions', description: 'Example repository.' },
		sources,
		...extra
	});
}

const ONE = [
	{
		id: 'Alpha',
		name: 'Alpha',
		description: 'An example source.',
		version: '1.2.3',
		icon: 'icon.png',
		language: 'en',
		contentRating: 'MATURE',
		capabilities: [1, 64],
		developers: [{ name: 'Example Author', website: null }]
	}
];

function services(source: string): ConversionServices {
	return {
		fetchArtifact: async () => new TextEncoder().encode(source),
		getText: () => {
			throw new Error('nothing here reads a sibling');
		},
		listFiles: () => {
			throw new Error('nothing here lists');
		}
	};
}

async function manifestOf(bundle: Uint8Array): Promise<Record<string, unknown>> {
	const opened = await openPluginArchive(bundle);
	return opened.manifest;
}

describe('a Paperback registration document', () => {
	it('resolves each artifact beside the index that named it', () => {
		const parsed = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://raw.example.invalid/owner/repo/main/0.9/stable/Alpha/index.js'
		);
	});

	it('reads the repository’s own name, description and build time', () => {
		const parsed = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL);
		expect(parsed.name).toBe('Example extensions');
		expect(parsed.description).toBe('Example repository.');
		expect(parsed.updatedAt).toBe('2026-01-02T03:04:05.000Z');
	});

	it('carries the capability flags without interpreting them', () => {
		const parsed = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.detail).toEqual({ capabilities: [1, 64] });
	});

	it('takes the adult flag from the rating, and the author from the developer', () => {
		const parsed = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.isNsfw).toBe(true);
		expect(parsed.plugins[0].author).toBe('Example Author');
	});

	it('accepts the older flat array, whose rows carry their own file', () => {
		const parsed = paperbackAdapter.parseIndex(
			JSON.stringify([{ id: 'Beta', name: 'Beta', version: '1.0.0', filename: 'Beta/index.js' }]),
			INDEX_URL
		);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://raw.example.invalid/owner/repo/main/0.9/stable/Beta/index.js'
		);
		// Some of the older registries spell the file `url`.
		const other = paperbackAdapter.parseIndex(
			JSON.stringify([{ id: 'Gamma', name: 'Gamma', version: '1', url: 'Gamma/index.js' }]),
			INDEX_URL
		);
		expect(other.plugins[0].origin?.artifactUrl).toBe(
			'https://raw.example.invalid/owner/repo/main/0.9/stable/Gamma/index.js'
		);
	});

	it('refuses an Aidoku document, which is a sources array and no repository', () => {
		const aidoku = JSON.stringify({
			name: 'Example',
			sources: [{ id: 'x', name: 'X', downloadURL: 'sources/x.aix' }]
		});
		expect(() => paperbackAdapter.parseIndex(aidoku, INDEX_URL)).toThrow(ForeignFormatError);
	});

	it('refuses every other array index', () => {
		// Hayase: a code address and a manifest version, no file.
		expect(() =>
			paperbackAdapter.parseIndex(
				JSON.stringify([{ id: 'x', name: 'X', version: '1', manifestVersion: 1, code: 'x.js' }]),
				INDEX_URL
			)
		).toThrow(ForeignFormatError);
		// LNReader: a site and a url.
		expect(() =>
			paperbackAdapter.parseIndex(
				JSON.stringify([{ id: 'x', name: 'X', site: 'https://example.invalid', url: 'x.js' }]),
				INDEX_URL
			)
		).toThrow(ForeignFormatError);
		expect(() => paperbackAdapter.parseIndex('not json', INDEX_URL)).toThrow(ForeignFormatError);
	});
});

describe('what a converted Paperback bundle declares', () => {
	it('declares the hosts its code reaches, not the host it came from', async () => {
		const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
		const script = `
			var source=(function(e){
				var api='https://api.example.invalid/v1';
				var x=class{async getSearchResults(){return (await Application.scheduleRequest({url:api})).data}};
				return e.AlphaExtension=x,e
			})({});
		`;
		const bundle = await paperbackAdapter.convert(listing, services(script));
		const manifest = await manifestOf(bundle);
		const hosts = (manifest['network'] as { hosts: string[] }).hosts;
		expect(hosts).toContain('api.example.invalid');
		expect(hosts).not.toContain('raw.example.invalid');
	});

	it('packages a readable bundle under the converted id', async () => {
		const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
		const bundle = await paperbackAdapter.convert(
			listing,
			services(`var source=(function(e){var api='https://api.example.invalid/';return e})({});`)
		);
		const opened = await openPluginArchive(bundle);
		expect(opened.id).toBe('app.yorozo.converted.paperback.alpha');
		expect(opened.manifest['id']).toBe(opened.id);
		// The shim must not be, say, a template with `${}` left in it.
		expect(opened.entrypointSource).toContain('export default {');
	});

	it('throws by name for a member it does not implement', async () => {
		const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
		const bundle = await paperbackAdapter.convert(
			listing,
			services(`var source=(function(e){var api='https://api.example.invalid/';return e})({});`)
		);
		const opened = await openPluginArchive(bundle);
		// eslint-disable-next-line @typescript-eslint/no-implied-eval
		const run = new Function(
			opened.entrypointSource.replace('export default', 'globalThis.__plugin =')
		);
		run();
		const scope = globalThis as unknown as {
			Application: Record<string, () => unknown>;
			__plugin: { id: string };
		};
		expect(scope.__plugin.id).toBe(opened.id);
		expect(() => scope.Application['fetchRSS']!()).toThrow(/fetchRSS/);
		expect(() => scope.Application['executeInWebView']!()).toThrow(/executeInWebView/);
	});

	it('gives the shim the Application surface instead of an empty global', async () => {
		const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
		const bundle = await paperbackAdapter.convert(
			listing,
			services(`var source=(function(e){var api='https://api.example.invalid/';return e})({});`)
		);
		const opened = await openPluginArchive(bundle);
		for (const member of [
			'Selector:',
			'scheduleRequest:',
			'fetchDocument:',
			'crypto_md5Hash:',
			'createSourceStateManager:'
		]) {
			expect(opened.entrypointSource).toContain(member);
		}
		// A WebView is a realm this shim does not carry, so it is named.
		expect(opened.entrypointSource).toContain('executeInWebView:');
		expect(opened.entrypointSource).toContain('globalThis.Application = Application;');
	});
});

/* ── what a converted Paperback bundle does when it is searched ─────────── */

interface SearchPage {
	entries: { sourceMediaId: string; title: string }[];
	hasMore?: boolean;
}

/** Converts `script` under the fixture's listing and imports the module. */
async function loadSearch(script: string): Promise<{
	searchCatalog(query: string, page: number, ctx: unknown): Promise<SearchPage>;
}> {
	const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
	// A host for the manifest to declare; none of these sources requests it.
	const hosted = `var __site='https://api.example.invalid/';\n${script}`;
	const opened = await openPluginArchive(await paperbackAdapter.convert(listing, services(hosted)));
	const { writeFileSync, mkdtempSync } = await import('node:fs');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const file = join(mkdtempSync(join(tmpdir(), 'paperback-')), 'bundle.mjs');
	writeFileSync(file, opened.entrypointSource, 'utf8');
	return (await import(/* @vite-ignore */ `file:///${file.replace(/\\/g, '/')}`)).default;
}

const CONTEXT = { log: { debug() {}, warn() {} } };

describe('a converted Paperback source, searched', () => {
	it('reads the rows of a page this toolchain names `items`', async () => {
		// The current toolchain's page is `{ items, metadata }`. Only the older
		// `results` was read, so every search of every source answered empty.
		const module = await loadSearch(`
			var source=(function(e){
				var x=class{async getSearchResults(q,m){
					return {items:[{mangaId:'m1',title:'Found '+q.title,imageUrl:''}],metadata:{page:2}};
				}};
				return e.AlphaExtension=x,e
			})({});
		`);
		const page = await module.searchCatalog('one', 1, CONTEXT);
		expect(page.entries.map((entry) => entry.title)).toEqual(['Found one']);
		expect(page.entries[0].sourceMediaId).toBe('m1');
		expect(page.hasMore).toBe(true);
	});

	it('asks for page one with no cursor, and for each next page with the cursor before it', async () => {
		// A source reads `metadata?.page ?? 1`, or sends the cursor to its API
		// as it is. A made-up `{ offset: 0 }` on the first page went straight
		// into one source's GraphQL `$page` and the server refused it.
		const module = await loadSearch(`
			var seen=[];
			globalThis.__paperbackSeen=seen;
			var source=(function(e){
				var x=class{async getSearchResults(q,m){
					seen.push(m===undefined?'undefined':JSON.stringify(m));
					var page=m&&m.page?m.page:1;
					return {items:[{mangaId:'m'+page,title:'Page '+page}],metadata:page<3?{page:page+1}:undefined};
				}};
				return e.AlphaExtension=x,e
			})({});
		`);
		const seen = (globalThis as unknown as { __paperbackSeen: string[] }).__paperbackSeen;

		expect((await module.searchCatalog('q', 1, CONTEXT)).entries[0].title).toBe('Page 1');
		expect((await module.searchCatalog('q', 2, CONTEXT)).entries[0].title).toBe('Page 2');
		expect(seen).toEqual(['undefined', '{"page":2}']);

		// Out of order under a new query: walked to from page one.
		seen.length = 0;
		const third = await module.searchCatalog('other', 3, CONTEXT);
		expect(third.entries[0].title).toBe('Page 3');
		expect(third.hasMore).toBe(false);
		expect(seen).toEqual(['undefined', '{"page":2}', '{"page":3}']);

		// Past the last page there is no cursor to ask with.
		expect((await module.searchCatalog('other', 4, CONTEXT)).entries).toEqual([]);
	});

	it('runs the instance the bundle published under its id, as it was constructed', async () => {
		// A template-built source is published as an instance whose constructor
		// passes the template its site. There is no class export to build, and
		// building one with no arguments would lose the site regardless.
		const module = await loadSearch(`
			var source=(function(e){
				var Base=class{constructor(o){this.domain=o&&o.domain}
					async getSearchResults(q,m){return {items:[{mangaId:'m1',title:String(this.domain)}]}}};
				return e.Alpha=new class extends Base{constructor(){super({domain:'configured'})}},e
			})({});
		`);
		const page = await module.searchCatalog('x', 1, CONTEXT);
		expect(page.entries.map((entry) => entry.title)).toEqual(['configured']);
	});
});
