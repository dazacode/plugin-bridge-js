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

	it('sends each page image with what the registered interceptors add to a request', async () => {
		const listing = paperbackAdapter.parseIndex(registration(ONE), INDEX_URL).plugins[0];
		const source = `var source=(function(e){
  class Alpha {
    constructor() {
      Application.registerInterceptor('main', Application.Selector(this, 'interceptRequest'), Application.Selector(this, 'interceptResponse'));
    }
    async interceptRequest(request) {
      request.headers = Object.assign({}, request.headers, { referer: 'https://site.example.invalid/' });
      request.cookies = { session: 'abc' };
      return request;
    }
    async interceptResponse(response) { return response; }
    async getSearchResults() { return { items: [] }; }
    async getMangaDetails() { return {}; }
    async getChapters() { return []; }
    async getChapterDetails() { return { pages: ['https://img.example.invalid/1.jpg'] }; }
  }
  e.Alpha = Alpha;
  return e;
})({});`;
		const opened = await openPluginArchive(
			await paperbackAdapter.convert(listing, services(source))
		);
		const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			readChapter(id: string, chapter: unknown, ctx: unknown): Promise<{ pages: unknown[] }>;
		};
		const read = await module.readChapter('m1', { number: 1, sourceChapterId: 'c1' }, {});
		expect(read.pages).toEqual([
			{
				url: 'https://img.example.invalid/1.jpg',
				headers: { referer: 'https://site.example.invalid/', cookie: 'session=abc' },
				index: 0
			}
		]);
	});
});
