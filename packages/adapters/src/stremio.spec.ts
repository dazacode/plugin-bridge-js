/**
 * What this adapter makes of a manifest, and the three things it must refuse.
 *
 * Rule 9: every address here is `example.invalid`, and detection is asserted
 * on document *shape* — an adapter that recognised its format by hostname is
 * the failure this file exists to prevent.
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError } from '@plugin-bridge/core/adapter';
import { stremioAdapter } from './stremio';

const URL_ = 'https://addon.example.invalid/config=abc/manifest.json';

function manifest(over: Record<string, unknown> = {}) {
	return JSON.stringify({
		id: 'invalid.example.addon',
		version: '1.4.0',
		name: 'Example Addon',
		types: ['movie', 'series'],
		resources: ['stream'],
		...over
	});
}

describe('reading an addon manifest', () => {
	it('produces one listing, because one manifest is one addon', () => {
		const index = stremioAdapter.parseIndex(manifest(), URL_);

		expect(index.format).toBe('stremio');
		expect(index.plugins).toHaveLength(1);
		expect(index.plugins[0].name).toBe('Example Addon');
	});

	it('declares it can be addressed by id, which is what lets it be bound', () => {
		const [plugin] = stremioAdapter.parseIndex(manifest(), URL_).plugins;

		expect(plugin.origin?.idKinds).toEqual(['imdb']);
	});

	it('grants the addon’s own host and nothing else', () => {
		// Where a stream points is decided per request and is not knowable from
		// a manifest, so it is learned at runtime rather than guessed at here.
		const [plugin] = stremioAdapter.parseIndex(manifest(), URL_).plugins;

		expect(plugin.hosts).toContain('addon.example.invalid');
		expect(plugin.hosts.every((host) => host.includes('example.invalid'))).toBe(true);
	});

	it('classifies movie and series as live-action, and an anime type as both', () => {
		const [plain] = stremioAdapter.parseIndex(manifest(), URL_).plugins;
		expect(plain.origin?.mediaKinds).toEqual(['live-action']);

		const [mixed] = stremioAdapter.parseIndex(
			manifest({ types: ['movie', 'series', 'anime'] }),
			URL_
		).plugins;
		expect(mixed.origin?.mediaKinds).toEqual(['anime', 'live-action']);
	});

	it('records only the catalogues that accept a search', () => {
		const [plugin] = stremioAdapter.parseIndex(
			manifest({
				resources: ['stream', 'catalog'],
				catalogs: [
					{ type: 'movie', id: 'searchable', extra: [{ name: 'search' }] },
					{ type: 'movie', id: 'also', extraSupported: ['search'] },
					// Asking an unsearchable catalogue for a title returns its own
					// unfiltered list, which would bind whatever is trending.
					{ type: 'series', id: 'unsearchable' }
				]
			}),
			URL_
		).plugins;

		expect(plugin.origin?.detail?.['searchable']).toEqual([
			{ type: 'movie', id: 'searchable' },
			{ type: 'movie', id: 'also' }
		]);
	});

	it('reads the resource list in either spelling the protocol allows', () => {
		const index = stremioAdapter.parseIndex(
			manifest({ resources: [{ name: 'stream', types: ['movie'] }] }),
			URL_
		);

		expect(index.plugins).toHaveLength(1);
	});
});

describe('what it refuses', () => {
	it('refuses a manifest that serves no streams', () => {
		// Metadata and subtitle addons are real and useful to Stremio; this
		// client has its own metadata stack and a source that cannot produce a
		// stream is not a source.
		expect(() =>
			stremioAdapter.parseIndex(manifest({ resources: ['catalog', 'meta'] }), URL_)
		).toThrow(/serves no streams/);
	});

	it('refuses a document that is not a manifest at all', () => {
		expect(() => stremioAdapter.parseIndex(JSON.stringify([{ a: 1 }]), URL_)).toThrow(
			ForeignFormatError
		);
		expect(() => stremioAdapter.parseIndex(JSON.stringify({ id: 'x' }), URL_)).toThrow(
			ForeignFormatError
		);
	});

	it('refuses to install an addon that has not been configured yet', async () => {
		const [plugin] = stremioAdapter.parseIndex(
			manifest({ behaviorHints: { configurable: true, configurationRequired: true } }),
			URL_
		).plugins;

		await expect(
			stremioAdapter.convert(plugin, {
				fetchArtifact: () => Promise.reject(new Error('nothing to fetch')),
				getText: () => Promise.reject(new Error('nothing to read')),
				listFiles: () => Promise.reject(new Error('nothing to list'))
			})
		).rejects.toThrow(/configured on its own page/);
	});
});

describe('converting one', () => {
	const services = {
		// The property that makes this format cheap: there is no artifact, so a
		// conversion that fetched anything would be fetching something it had no
		// reason to want.
		fetchArtifact: () => {
			throw new Error('a Stremio conversion must fetch no artifact');
		},
		getText: () => {
			throw new Error('a Stremio conversion must read no text');
		},
		listFiles: () => {
			throw new Error('a Stremio conversion must list no files');
		}
	};

	it('builds a bundle without fetching anything', async () => {
		const [plugin] = stremioAdapter.parseIndex(manifest(), URL_).plugins;

		const bytes = await stremioAdapter.convert(plugin, services);

		expect(bytes.byteLength).toBeGreaterThan(0);
	});

	it('keeps the configuration segment in the address it will call', async () => {
		// A configured addon carries the viewer's own settings in its path, and
		// dropping that segment would silently install the unconfigured addon.
		const [plugin] = stremioAdapter.parseIndex(manifest(), URL_).plugins;

		expect(plugin.origin?.detail?.['base']).toBe('https://addon.example.invalid/config=abc');
	});
});

describe('the URL a viewer pastes', () => {
	it('accepts the directory above the manifest', () => {
		expect(stremioAdapter.candidates(new URL('https://addon.example.invalid/config=abc'))).toEqual([
			'https://addon.example.invalid/config=abc/manifest.json'
		]);
	});

	it('accepts the manifest itself, untouched', () => {
		expect(stremioAdapter.candidates(new URL(URL_))).toEqual([URL_]);
	});
});
