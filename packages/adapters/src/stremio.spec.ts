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

/**
 * What people actually copy.
 *
 * An addon's own page and every directory listing it hand out a link to the
 * *web client* with the manifest as a parameter, not the manifest. A viewer
 * pasting what they were given is pasting a link to somebody else's app, and
 * before this it had `/manifest.json` appended to it and failed.
 */
describe('an install link rather than a manifest', () => {
	const MANIFEST = 'https://addon.example.invalid/lite/manifest.json';

	it('unwraps the manifest out of the fragment', () => {
		// The `?` is after the `#`, so this parameter is in the fragment and
		// `searchParams` cannot see it. That is the entire trap.
		expect(
			stremioAdapter.candidates(new URL(`https://web.example.invalid/#/addons?addon=${MANIFEST}`))
		).toEqual([MANIFEST]);
	});

	it('unwraps it percent-encoded too, because both forms circulate', () => {
		expect(
			stremioAdapter.candidates(
				new URL(`https://web.example.invalid/#/addons?addon=${encodeURIComponent(MANIFEST)}`)
			)
		).toEqual([MANIFEST]);
	});

	it('appends the manifest when the link carries only a directory', () => {
		expect(
			stremioAdapter.candidates(
				new URL('https://web.example.invalid/#/addons?addon=https://addon.example.invalid/lite')
			)
		).toEqual([MANIFEST]);
	});

	it('is matched by shape, so a self-hosted web client works the same', () => {
		// No hostname is written down here or in the adapter — any host serving
		// that route means the same thing.
		expect(
			stremioAdapter.candidates(
				new URL(`https://someone-elses-host.example.invalid/#/addons?addon=${MANIFEST}`)
			)
		).toEqual([MANIFEST]);
	});

	it('ignores a fragment that carries no addon at all', () => {
		expect(
			stremioAdapter.candidates(new URL('https://addon.example.invalid/lite/#/board'))
		).toEqual(['https://addon.example.invalid/lite/#/board/manifest.json']);
	});

	it('offers nothing when the link names an addon it cannot use', () => {
		// An install link must not become a way around the transport rule, and
		// a link whose addon is unusable has no candidate worth a request.
		expect(
			stremioAdapter.candidates(
				new URL(
					'https://web.example.invalid/#/addons?addon=http://addon.example.invalid/manifest.json'
				)
			)
		).toEqual([]);
	});
});

/**
 * A whole addon list in one paste.
 *
 * This is the only document in this format that lists more than one source,
 * and it is what a person moving across already has — the list their client
 * saved. Without it they bring their addons one at a time.
 */
describe('a collection rather than a single addon', () => {
	function descriptor(id: string, over: Record<string, unknown> = {}) {
		return {
			transportUrl: `https://${id}.example.invalid/manifest.json`,
			flags: { official: false },
			manifest: {
				id: `invalid.example.${id}`,
				version: '1.0.0',
				name: id,
				types: ['movie', 'series'],
				resources: ['stream'],
				...over
			}
		};
	}

	it('produces one listing per addon in the list', () => {
		const index = stremioAdapter.parseIndex(
			JSON.stringify([descriptor('one'), descriptor('two')]),
			'https://someone.example.invalid/collection.json'
		);

		expect(index.format).toBe('stremio');
		expect(index.plugins.map((row) => row.name)).toEqual(['one', 'two']);
	});

	it('points each listing at its own address, not at the collection', () => {
		const index = stremioAdapter.parseIndex(
			JSON.stringify([descriptor('one')]),
			'https://someone.example.invalid/collection.json'
		);

		expect(index.plugins[0].origin?.detail?.['base']).toBe('https://one.example.invalid');
		expect(index.plugins[0].hosts).toContain('one.example.invalid');
	});

	it('drops the metadata and subtitle providers a real list carries, and counts them', () => {
		// Refusing the whole document because it contains a subtitle provider
		// would reject an entirely ordinary collection.
		const index = stremioAdapter.parseIndex(
			JSON.stringify([
				descriptor('streams'),
				descriptor('subs', { resources: ['subtitles'] }),
				descriptor('meta', { resources: ['catalog', 'meta'] })
			]),
			'https://someone.example.invalid/collection.json'
		);

		expect(index.plugins.map((row) => row.name)).toEqual(['streams']);
		expect(index.filteredOut).toBe(2);
	});

	it('keeps one listing when the same addon is named twice', () => {
		// Two configurations of one service share an id, and two listings
		// sharing an id share a keyed-each key.
		const index = stremioAdapter.parseIndex(
			JSON.stringify([descriptor('one'), descriptor('one')]),
			'https://someone.example.invalid/collection.json'
		);

		expect(index.plugins).toHaveLength(1);
	});

	/**
	 * The risk this format introduces. A bare JSON array is not a distinctive
	 * document — another adapted ecosystem publishes its entire extension list
	 * as one — so recognising "an array" would claim somebody else's index and
	 * shadow it for every repository, which is the property
	 * `adapters.spec.ts` defends across all seven.
	 */
	it('refuses an array that is not a collection', () => {
		expect(() =>
			stremioAdapter.parseIndex(
				JSON.stringify([{ name: 'Something', pkg: 'com.example.thing', apk: 'thing.apk' }]),
				'https://someone.example.invalid/index.json'
			)
		).toThrow(ForeignFormatError);
	});

	it('refuses entries that carry an address but no manifest', () => {
		expect(() =>
			stremioAdapter.parseIndex(
				JSON.stringify([{ transportUrl: 'https://one.example.invalid/manifest.json' }]),
				'https://someone.example.invalid/collection.json'
			)
		).toThrow(ForeignFormatError);
	});

	it('refuses an empty list rather than showing an empty repository', () => {
		expect(() =>
			stremioAdapter.parseIndex('[]', 'https://someone.example.invalid/collection.json')
		).toThrow(ForeignFormatError);
	});
});

/**
 * Three facts the manifest states about itself that this adapter used to
 * either hardcode or ignore. Each is declared at install time, which is the
 * point: a host can disclose and gate on them before anybody presses play.
 */
describe('what the manifest declares about itself', () => {
	it('takes the adult flag from the manifest instead of assuming false', () => {
		const clean = stremioAdapter.parseIndex(manifest(), URL_).plugins[0];
		expect(clean.origin?.isNsfw).toBe(false);

		const adult = stremioAdapter.parseIndex(manifest({ behaviorHints: { adult: true } }), URL_)
			.plugins[0];
		expect(adult.origin?.isNsfw).toBe(true);
	});

	it('records that a source acquires over peer-to-peer', () => {
		// Declared, not discovered at play time — which is what lets a host say
		// "this needs a native client" on the row rather than after a failure.
		const p2p = stremioAdapter.parseIndex(manifest({ behaviorHints: { p2p: true } }), URL_)
			.plugins[0];

		expect(p2p.origin?.usesP2p).toBe(true);
		expect(stremioAdapter.parseIndex(manifest(), URL_).plugins[0].origin?.usesP2p).toBe(false);
	});
});

describe('the addon’s own configuration form', () => {
	const CONFIG = {
		behaviorHints: { configurable: true },
		config: [
			{ key: 'apiKey', type: 'password', title: 'Debrid key', required: true },
			{ key: 'dubbed', type: 'checkbox', default: 'checked', title: 'Prefer dubbed' },
			{ key: 'quality', type: 'select', options: ['1080p', '720p'], title: 'Quality' },
			{ key: 'limit', type: 'number', title: 'Results' }
		]
	};

	function settingsOf(over: Record<string, unknown> = CONFIG) {
		const [plugin] = stremioAdapter.parseIndex(manifest(over), URL_).plugins;
		return (plugin.origin?.detail?.['config'] ?? []) as { id: string; key: string; type: string }[];
	}

	it('maps every field type this schema has somewhere to put', () => {
		expect(settingsOf().map((one) => [one.key, one.type])).toEqual([
			// No secret type exists here, so a key is drawn in the clear — a real
			// loss, and better than dropping the only field that makes the addon
			// usable.
			['apiKey', 'text'],
			['dubbed', 'switch'],
			['quality', 'select'],
			// Costs the keyboard, nothing else.
			['limit', 'text']
		]);
	});

	it('keeps the addon’s own spelling beside the normalised id', () => {
		// The segment sent back is keyed the addon's way; the id is what this
		// host stores under. Losing either breaks a configured request.
		const [first] = settingsOf();
		expect(first.id).toBe('apikey');
		expect(first.key).toBe('apiKey');
	});

	it('drops a select with nothing to select from', () => {
		const rows = settingsOf({
			behaviorHints: { configurable: true },
			config: [{ key: 'empty', type: 'select', options: [] }]
		});
		expect(rows).toEqual([]);
	});

	it('drops a field type the schema cannot represent', () => {
		const rows = settingsOf({
			behaviorHints: { configurable: true },
			config: [{ key: 'weird', type: 'colorpicker' }]
		});
		expect(rows).toEqual([]);
	});

	it('declares nothing for an addon with no configuration', () => {
		expect(settingsOf({})).toEqual([]);
	});
});
