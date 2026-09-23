/**
 * What each adapter makes of its own format's index.
 *
 * The behaviours worth pinning are not "it parses JSON" — they are the three
 * decisions that would be silently wrong: which format a body is, which
 * listings survive the supported-mediums filter, and why a row that cannot
 * be installed says so.
 *
 * Fixtures come from `contract/fixtures/foreign/indexes.json`, hand-written to
 * each format's shape. Nothing here reaches the network and no real repository
 * appears in it (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import fixtures from '../../../fixtures/indexes.json';
import {
	listingRefusal,
	loadForeignIndex,
	ForeignFormatError,
	type ConversionServices,
	ForeignIndexError
} from '@plugin-bridge/core/adapter';
import { FOREIGN_ADAPTERS, adapterFor } from './index';
import { CERTIFICATE_KEY_PREFIX } from '@plugin-bridge/adapters/aniyomi';
import type { ForeignFormat } from '@plugin-bridge/core/formats';

type Fixture = {
	indexUrl: string;
	body: unknown;
	repoJson?: unknown;
	pluginList?: { url: string; body: unknown };
};

const catalogue = fixtures as unknown as Record<string, Fixture>;

function bodyOf(format: ForeignFormat): { body: string; url: string } {
	const fixture = catalogue[format];
	return { body: JSON.stringify(fixture.body), url: fixture.indexUrl };
}

/** Serves the sibling documents the two split formats fetch, and nothing else. */
function siblings(format: ForeignFormat): (url: string) => Promise<string> {
	const fixture = catalogue[format];
	return async (url: string) => {
		if (fixture.repoJson !== undefined && url.endsWith('/repo.json')) {
			return JSON.stringify(fixture.repoJson);
		}
		if (fixture.pluginList !== undefined && url === fixture.pluginList.url) {
			return JSON.stringify(fixture.pluginList.body);
		}
		throw new Error(`nothing at ${url}`);
	};
}

/**
 * Services that answer nothing, for the conversions this file expects to be
 * refused before anything is fetched.
 *
 * Throwing rather than returning empties is what makes the assertion mean
 * something: a refusal that arrived after a request would be a refusal reached
 * by a different route than the one under test.
 */
const NOTHING_REACHABLE: ConversionServices = {
	fetchArtifact: () => {
		throw new Error('nothing here should be fetched');
	},
	getText: () => {
		throw new Error('nothing here should be read');
	},
	listFiles: () => {
		throw new Error('nothing here should be listed');
	}
};

describe('each adapter recognises only its own format', () => {
	const formats = FOREIGN_ADAPTERS.map((adapter) => adapter.format);

	// The load-bearing property behind detection: adapters are tried in order
	// and the first that parses wins, so an adapter that accepted a body
	// belonging to another format would shadow it for every repository.
	/**
	 * The one pair where this property does not hold, stated rather than
	 * quietly excluded.
	 *
	 * The manga format's only text document is a deprecated stub, and its shape
	 * is *identical* to the sibling format's real index — same array, same
	 * `{name, pkg, apk, lang, version, sources}` rows. The sibling cannot tell
	 * them apart and should not be taught to: that would be one format's
	 * knowledge living in another's parser.
	 *
	 * What protects a viewer instead is ordering plus the kind of refusal, and
	 * both are asserted below rather than left to this exclusion.
	 */
	const AMBIGUOUS: readonly (readonly [string, string])[] = [['aniyomi', 'mihon']];

	it.each(formats)('%s refuses the other formats’ indexes', (format) => {
		const adapter = adapterFor(format);
		for (const other of formats) {
			if (other === format) continue;
			if (AMBIGUOUS.some(([one, two]) => one === format && two === other)) continue;
			const { body, url } = bodyOf(other);
			expect(() => adapter.parseIndex(body, url)).toThrow();
		}
	});

	it('answers the ambiguous document with a sentence instead of a wrong success', () => {
		const { body, url } = bodyOf('mihon');

		// Left to itself, the sibling takes it and produces a catalogue of two
		// rows called "Outdated App" and "Update to Mihon 0.20.1+".
		const sibling = adapterFor('aniyomi').parseIndex(body, url);
		expect(sibling.plugins.length).toBeGreaterThan(0);

		// The right adapter refuses with an *index* error, which detection
		// propagates rather than swallowing, and says where the real index is.
		expect(() => adapterFor('mihon').parseIndex(body, url)).toThrow(ForeignIndexError);
		expect(() => adapterFor('mihon').parseIndex(body, url)).toThrow(/index\.pb/);
	});

	it('asks the adapter that can answer before the one that cannot', () => {
		// Ordering is what turns that refusal into the one a viewer sees.
		const order = FOREIGN_ADAPTERS.map((adapter) => adapter.format);
		expect(order.indexOf('mihon')).toBeLessThan(order.indexOf('aniyomi'));
	});

	it.each(formats)('%s refuses a body that is not JSON', (format) => {
		expect(() =>
			adapterFor(format).parseIndex('<html></html>', 'https://example.invalid/x.json')
		).toThrow(ForeignFormatError);
	});
});

describe('Sora', () => {
	const { body, url } = bodyOf('sora');

	it('keeps both modules now that manga is a medium this build shows', () => {
		const index = adapterFor('sora').parseIndex(body, url);

		expect(index.format).toBe('sora');
		expect(index.plugins).toHaveLength(2);
		expect(index.filteredOut).toBe(0);
		expect(index.plugins.map((listing) => listing.name)).toContain('Example Anime');
	});

	it('resolves a relative scriptUrl against the index it came from', () => {
		// What matters is that a relative url never survives as a relative url.
		// Both modules are kept now, so both are checked.
		const index = adapterFor('sora').parseIndex(body, url);
		expect(index.plugins.map((listing) => listing.origin?.artifactUrl)).toEqual([
			'https://example.invalid/modules/example/script.js',
			'https://example.invalid/modules/comics/script.js'
		]);
	});

	it('carries everything conversion needs on the listing itself', () => {
		// Conversion must be a pure function of the listing: a module held
		// across a reload, or replayed by a test, has to convert identically.
		const detail = adapterFor('sora').parseIndex(body, url).plugins[0].origin?.detail;

		expect(detail).toEqual({
			baseUrl: 'https://watch.example.invalid/',
			searchBaseUrl: 'https://watch.example.invalid/search?q=%s',
			streamType: 'HLS',
			softsub: false
		});
	});

	it('grants the module its own site and a wildcard for its subdomains', () => {
		const hosts = adapterFor('sora').parseIndex(body, url).plugins[0].hosts;

		expect(hosts).toContain('watch.example.invalid');
		expect(hosts).toContain('*.example.invalid');
		// A consent list is only meaningful if it is finite and derived from
		// what was declared. Nothing else may creep in.
		expect(hosts).not.toContain('*');
	});

	it('offers no refusal for an anime module', () => {
		const listing = adapterFor('sora').parseIndex(body, url).plugins[0];
		expect(listingRefusal(listing)).toBeNull();
	});
});

describe('Aniyomi', () => {
	const { body, url } = bodyOf('aniyomi');

	it('classifies by package, and keeps both mediums it can show', async () => {
		// The classification is what is under test and it is unchanged. Before
		// ADR-0013 the manga row was dropped here; it is now kept, so this
		// asserts the *classification* rather than the survivor count.
		const index = await loadForeignIndex(adapterFor('aniyomi'), body, url, siblings('aniyomi'));

		expect(index.plugins).toHaveLength(2);
		expect(index.filteredOut).toBe(0);
		expect(index.plugins.map((listing) => listing.origin?.mediaKind)).toEqual(['anime', 'manga']);
	});

	it('resolves the artifact into the apk directory beside the index', () => {
		const index = adapterFor('aniyomi').parseIndex(body, url);
		expect(index.plugins[0].origin?.artifactUrl).toBe(
			'https://example.invalid/repo/apk/example-anime-v14.3.apk'
		);
	});

	it('pins the certificate fingerprint under its own prefix', async () => {
		const index = await loadForeignIndex(adapterFor('aniyomi'), body, url, siblings('aniyomi'));

		expect(index.name).toBe('Example extensions');
		// Namespaced, because this is compared the same way as a native
		// repository's Ed25519 SPKI and verified by entirely different
		// machinery. The two must never share a value space.
		expect(index.signingKey).toBe(
			`${CERTIFICATE_KEY_PREFIX}3b1f9a7c2d5e4806af13bc90de2457681a9c0f3e5d7b28419ac6de035f81720b`
		);
	});

	it('still adds the repository when the sibling metadata is missing', async () => {
		const index = await loadForeignIndex(adapterFor('aniyomi'), body, url, async () => {
			throw new Error('404');
		});

		// Metadata only. A repository that does not publish it is usable.
		expect(index.plugins).toHaveLength(2);
		expect(index.signingKey).toBeNull();
	});

	it('offers the listing, and refuses at conversion with the fact that can be fixed', async () => {
		const listing = adapterFor('aniyomi').parseIndex(body, url).plugins[0];

		// No format-wide refusal any more. This format converts from *source*,
		// so whether a given extension installs is a question about that
		// extension and cannot be answered by its format — which is what the
		// four check states in `FOREIGN.md` §6.1 are for. A row nobody has run
		// is Unchecked, not refused.
		expect(listingRefusal(listing)).toBeNull();
		// `parseIndex` alone, so nothing has read the sibling metadata that says
		// where the extensions are built from — and this format converts source,
		// never the published artifact. The refusal names that missing fact
		// rather than the format, because it is the one that can be fixed.
		await expect(adapterFor('aniyomi').convert(listing, NOTHING_REACHABLE)).rejects.toThrow(
			/does not say where its extensions are built from/
		);
	});
});

describe('Cloudstream', () => {
	const { body, url } = bodyOf('cloudstream');

	it('follows the manifest to its plugin lists', async () => {
		const index = await loadForeignIndex(
			adapterFor('cloudstream'),
			body,
			url,
			siblings('cloudstream')
		);

		expect(index.name).toBe('Example providers');
		// Both survive: the film provider is `live-action`, a medium this
		// build now has somewhere to show, not a reading medium it does not.
		// Neither installs regardless — Cloudstream's own tier (compiled JVM
		// bytecode, no converter yet) refuses both alike.
		expect(index.plugins).toHaveLength(2);
		expect(index.plugins.map((plugin) => plugin.name).sort()).toEqual([
			'ExampleAnimeProvider',
			'ExampleFilmProvider'
		]);
		expect(index.plugins.map((plugin) => plugin.origin?.mediaKind).sort()).toEqual([
			'anime',
			'live-action'
		]);
		expect(index.filteredOut).toBe(0);
		for (const plugin of index.plugins) {
			expect(listingRefusal(plugin)).toMatch(/compiled Java/);
		}
	});

	it('records the JVM twin for a converter that does not exist yet', async () => {
		const index = await loadForeignIndex(
			adapterFor('cloudstream'),
			body,
			url,
			siblings('cloudstream')
		);

		expect(index.plugins[0].origin?.detail?.['jarUrl']).toBe(
			'https://example.invalid/cs/builds/ExampleAnimeProvider.jar'
		);
	});

	it('declares no hosts, because a provider declares none', async () => {
		const index = await loadForeignIndex(
			adapterFor('cloudstream'),
			body,
			url,
			siblings('cloudstream')
		);
		// An empty list is the truthful answer, and it is also why nothing here
		// could be installed even if the bytecode ran.
		expect(index.plugins[0].hosts).toEqual([]);
	});
});

describe('the formats that browse for a product reason', () => {
	it('no longer refuses Hayase for a torrent client this host now has', () => {
		// It was refused with "Yorozo has no torrent client", and that premise
		// stopped being true: `TorrentDescriptor`, `TorrentAcquisition`, a
		// companion behind it and `P2pConsent` in front. The row converts, and
		// says it is addressed by an AniList id — which is what lets a source
		// with no catalogue be bound at all.
		const { body, url } = bodyOf('hayase');
		const index = adapterFor('hayase').parseIndex(body, url);

		expect(index.plugins).toHaveLength(1);
		expect(listingRefusal(index.plugins[0])).toBeNull();
		expect(index.plugins[0].origin?.idKinds).toEqual(['anilist']);
	});

	it('filters LNReader novels out and counts them', () => {
		const { body, url } = bodyOf('lnreader');
		const index = adapterFor('lnreader').parseIndex(body, url);

		expect(index.plugins).toHaveLength(0);
		expect(index.filteredOut).toBe(1);
	});

	it('reads Mangayomi’s itemType, and records which language a source is', () => {
		const { body, url } = bodyOf('mangayomi');
		const before = JSON.parse(body) as unknown[];
		const index = adapterFor('mangayomi').parseIndex(body, url);

		expect(before).toHaveLength(2);
		// Both are kept now. `itemType` still decides which medium each is, and
		// that — not the survivor count — is what this test is about.
		expect(index.plugins).toHaveLength(2);
		expect(index.plugins.map((listing) => listing.origin?.mediaKind)).toEqual(['anime', 'manga']);
		expect(index.plugins[0].name).toBe('Example Anime');
		expect(index.plugins[0].origin?.detail?.['sourceCodeLanguage']).toBe('js');
	});
});
