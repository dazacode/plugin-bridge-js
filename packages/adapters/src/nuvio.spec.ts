/**
 * What the Nuvio adapter makes of an index and of a scraper's source.
 *
 * The decisions worth pinning are the ones that would be silently wrong: which
 * addresses a bundle declares, which settings reach the manifest, and which
 * listings are offered at all. Nothing here reaches the network and no real
 * repository appears in it (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { readZip } from '@plugin-bridge/core/zip';
import { nuvioAdapter } from './nuvio';

const INDEX_URL = 'https://example.invalid/nuvio/manifest.json';

function index(scrapers: unknown[], extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ name: 'Example Scrapers', version: '1.0.0', scrapers, ...extra });
}

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

/** The bundle's manifest, read back out of the zip it was packaged into. */
async function manifestOf(bundle: Uint8Array): Promise<Record<string, unknown>> {
	const entries = await readZip(bundle);
	const found = entries.find((entry) => entry.name === 'plugin.json');
	expect(found).toBeDefined();
	return JSON.parse(new TextDecoder().decode(found!.bytes)) as Record<string, unknown>;
}

const ONE = [
	{ id: 'example', name: 'Example', version: '1.0.0', filename: 'providers/example.js' }
];

describe('the Nuvio index', () => {
	it('resolves each entry against the base the index names', () => {
		const parsed = nuvioAdapter.parseIndex(
			index(ONE, { base: 'https://example.invalid/code' }),
			INDEX_URL
		);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://example.invalid/code/providers/example.js'
		);
	});

	it('resolves against the index itself when no base is named', () => {
		const parsed = nuvioAdapter.parseIndex(index(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.artifactUrl).toBe(
			'https://example.invalid/nuvio/providers/example.js'
		);
	});

	it('leaves out an entry its publisher has withdrawn', () => {
		// `enabled: false` is the index's own word that a row is not on offer.
		// Listing it anyway puts something on screen that was taken down.
		const parsed = nuvioAdapter.parseIndex(
			index([...ONE, { id: 'gone', filename: 'providers/gone.js', enabled: false }]),
			INDEX_URL
		);
		expect(parsed.plugins.map((one) => one.origin?.foreignId)).toEqual(['example']);
	});

	it('declares the TMDB namespace, which is why it needs no catalogue search', () => {
		const parsed = nuvioAdapter.parseIndex(index(ONE), INDEX_URL);
		expect(parsed.plugins[0].origin?.idKinds).toEqual(['tmdb']);
	});

	it('refuses a document that is not one of these', () => {
		expect(() => nuvioAdapter.parseIndex('[]', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => nuvioAdapter.parseIndex('{"scrapers":[]}', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => nuvioAdapter.parseIndex('not json', INDEX_URL)).toThrow(ForeignFormatError);
	});
});

describe('what a converted Nuvio bundle declares', () => {
	const listing = () => nuvioAdapter.parseIndex(index(ONE), INDEX_URL).plugins[0];

	it('declares the addresses the scraper reaches', async () => {
		const source = `
			const API = 'https://api.example.invalid/v1';
			async function getStreams(id) { return (await fetch('https://cdn.example.invalid/' + id)).json(); }
			module.exports = { getStreams };
		`;
		const manifest = await manifestOf(await nuvioAdapter.convert(listing(), services(source)));
		const hosts = (manifest['network'] as { hosts: string[] }).hosts;
		expect(hosts).toContain('api.example.invalid');
		expect(hosts).toContain('cdn.example.invalid');
	});

	it('does not declare the address its own code was downloaded from', async () => {
		// A scraper never fetches its own file at runtime, so granting that host
		// is authority nothing ever uses.
		const source = `async function getStreams() { return []; }
			const A = 'https://api.example.invalid/x'; module.exports = { getStreams };`;
		const manifest = await manifestOf(await nuvioAdapter.convert(listing(), services(source)));
		expect((manifest['network'] as { hosts: string[] }).hosts).not.toContain('example.invalid');
	});

	it('reads the settings a scraper declares into the manifest', async () => {
		const source = `
			const API = 'https://api.example.invalid/v1';
			async function getStreams() { return []; }
			async function onSettings() {
				return [
					{ type: 'header', label: 'Group' },
					{ type: 'select', key: 'sortBy', label: 'Sort By',
						options: [{ label: 'Quality', value: 'quality' }, { label: 'Size', value: 'size' }],
						default: 'quality' },
					{ type: 'toggle', key: 'forceHd', label: 'Force HD', default: true },
					{ type: 'text', key: 'apiKey', label: 'API Key', description: 'Your key.' }
				];
			}
			module.exports = { getStreams, onSettings };
		`;
		const manifest = await manifestOf(await nuvioAdapter.convert(listing(), services(source)));
		const settings = manifest['settings'] as { id: string; type: string; key: string }[];
		// The header carries no key and stores nothing, so it is not a setting:
		// emitting one puts a control on screen that cannot be answered.
		expect(settings.map((one) => `${one.key}:${one.type}`)).toEqual([
			'sortBy:select',
			'forceHd:switch',
			'apiKey:text'
		]);
	});

	it('finds the schema inside onSettings, not the first array after its name', async () => {
		// The locator this replaced took `return [` from wherever it first
		// appeared after the word, which in a file that *mentions* onSettings
		// before defining it is a different array — and a different array
		// parses, so the mistake arrives as a plausible settings screen.
		const source = `
			const API = 'https://api.example.invalid/v1';
			const advertised = ['onSettings'];
			function unrelated() { return [{ type: 'select', key: 'wrong', options: [{ value: 'x' }] }]; }
			async function getStreams() { return []; }
			async function onSettings() {
				return [{ type: 'toggle', key: 'right', label: 'Right', default: false }];
			}
			module.exports = { getStreams, onSettings };
		`;
		const manifest = await manifestOf(await nuvioAdapter.convert(listing(), services(source)));
		const settings = manifest['settings'] as { key: string }[];
		expect(settings.map((one) => one.key)).toEqual(['right']);
	});

	it('gives the scraper its own scope, so its polyfills do not collide', async () => {
		/*
		 * Measured: one scraper carries its own `atob`, which this runtime also
		 * declares. Two top-level `var`s of one name in a module is a *parse*
		 * error, so the bundle failed to load with "Identifier 'atob' has
		 * already been declared" — naming neither the scraper nor the
		 * collision. Inside a function its polyfill shadows the runtime's for
		 * that scraper and nothing else notices.
		 */
		const source = `
			const API = 'https://api.example.invalid/v1';
			var atob = function (value) { return value; };
			async function getStreams() { return []; }
			module.exports = { getStreams };
		`;
		const bundle = await nuvioAdapter.convert(listing(), services(source));
		const entries = await readZip(bundle);
		const payload = new TextDecoder().decode(
			entries.find((entry) => entry.name === 'payload/source.js')!.bytes
		);
		// The runtime's own declaration is still there, and the scraper's is
		// inside a wrapper rather than beside it.
		expect(payload).toContain('function atob(');
		expect(payload).toContain('(function (module, exports, require) {');
		const wrapper = payload.indexOf('(function (module, exports, require) {');
		expect(payload.indexOf('var atob = function (value)')).toBeGreaterThan(wrapper);
	});

	it('hands each value to the scraper under the key the scraper wrote', async () => {
		/*
		 * `ctx.settings` answers one id at a time, by the manifest's id, and
		 * these scrapers read one object under their own arbitrary keys —
		 * counted across the corpus as `global[...]` 12 times, `window[...]`
		 * 8 and `globalThis[...]` 5, never as a bare name. Both halves of that
		 * mapping are decided here, so both travel into the bundle.
		 */
		const source = `
			const API = 'https://api.example.invalid/v1';
			async function getStreams() { return []; }
			async function onSettings() {
				return [{ type: 'select', key: 'sortBy', label: 'Sort',
					options: [{ label: 'Q', value: 'quality' }], default: 'quality' }];
			}
			module.exports = { getStreams, onSettings };
		`;
		const bundle = await nuvioAdapter.convert(listing(), services(source));
		const entries = await readZip(bundle);
		const payload = new TextDecoder().decode(
			entries.find((entry) => entry.name === 'payload/source.js')!.bytes
		);
		expect(payload).toContain('"id":"sortby"');
		expect(payload).toContain('"key":"sortBy"');
		// Onto the global object, which is the only place they look.
		expect(payload).toContain('globalThis.SCRAPER_SETTINGS = chosen;');
	});

	it('declares nothing rather than guessing when the schema does not parse', async () => {
		const source = `
			async function getStreams() { return []; }
			async function onSettings() { return buildSettings(); }
			const A = 'https://api.example.invalid/x';
			module.exports = { getStreams, onSettings };
		`;
		const manifest = await manifestOf(await nuvioAdapter.convert(listing(), services(source)));
		// Every scraper reads its values as `SETTINGS[key] || <default>`, so an
		// absent setting is the case they already handle.
		expect(manifest['settings'] ?? []).toEqual([]);
	});
});
