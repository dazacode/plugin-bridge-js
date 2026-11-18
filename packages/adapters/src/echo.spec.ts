/**
 * `echoAdapter`, against a releases document.
 *
 * There is no index document in this ecosystem, so the fixture is GitHub's own
 * releases array — the one address that is always true of an extension
 * repository — and the negative is `tag_name` plus `assets`, which no other
 * adapter here publishes. A foreign array without both must be refused, or
 * detection would stop on an Aniyomi repository and file its extensions as
 * Echo plugins.
 *
 * Rule 9: `example.invalid` for content, `api.github.com` for the forge API.
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError } from '@plugin-bridge/core/adapter';
import type { ConversionServices } from '@plugin-bridge/core/adapter';
import { echoAdapter } from './echo';

const REPOSITORY = 'https://github.com/owner/extensions';
const API = 'https://api.github.com/repos/owner/extensions/releases';
const ASSET = 'https://github.com/owner/extensions/releases/download/v1.2.0/demo.apk';

const RELEASES = [
	{
		tag_name: 'v1.2.0',
		name: 'Demo release',
		prerelease: false,
		published_at: '2026-01-01T00:00:00Z',
		html_url: 'https://github.com/owner/extensions/releases/tag/v1.2.0',
		url: 'https://api.github.com/repos/owner/extensions/releases/1',
		assets: [
			{
				id: 99,
				name: 'demo.apk',
				browser_download_url: ASSET
			},
			// A source jar is not installable and must not become a row.
			{ id: 100, name: 'demo.jar', browser_download_url: `${ASSET}.jar` }
		]
	}
];

function services(): ConversionServices {
	return {
		fetchArtifact: async () => {
			throw new Error('the artifact is dex, and nothing here reads it');
		},
		getText: async () => '',
		listFiles: async () => []
	};
}

describe('candidates', () => {
	it('asks the releases API for a repository, bounded', () => {
		expect(echoAdapter.candidates(new URL(REPOSITORY))).toEqual([API, `${API}?per_page=100`]);
	});

	it('uses a pasted releases URL or document as given', () => {
		expect(echoAdapter.candidates(new URL(API))).toEqual([API]);
		const document = new URL('https://raw.example.invalid/list.json');
		expect(echoAdapter.candidates(document)).toEqual([document.toString()]);
	});

	it('has nothing to say about a non-forge URL', () => {
		expect(echoAdapter.candidates(new URL('https://site.example.invalid/'))).toEqual([]);
	});
});

describe('parseIndex', () => {
	it('lists one plugin per APK asset, and derives the repository and host', () => {
		const index = echoAdapter.parseIndex(JSON.stringify(RELEASES), API);
		expect(index.plugins).toHaveLength(1);

		const [row] = index.plugins;
		expect(row.origin?.artifactUrl).toBe(ASSET);
		expect(row.hosts).toContain('github.com');
		expect(row.origin?.detail?.['repository']).toBe(REPOSITORY);
		expect(row.origin?.detail?.['asset']).toBe('demo.apk');
		expect(row.origin?.foreignVersion).toBe('1.2.0');
		expect(row.origin?.mediaKind).toBe('anime');
		expect(row.origin?.mediaKinds).toEqual(['anime', 'live-action']);
	});

	it('refuses an array that is not a release list', () => {
		const aniyomi = JSON.stringify([
			{ name: 'Anime: Demo', pkg: 'eu.kanade.tachiyomi.animeextension.en.demo', apk: 'a.apk' }
		]);
		expect(() => echoAdapter.parseIndex(aniyomi, API)).toThrow(ForeignFormatError);
		expect(() => echoAdapter.parseIndex('{"releases":[]}', API)).toThrow(ForeignFormatError);
		expect(() => echoAdapter.parseIndex('[]', API)).toThrow(ForeignFormatError);
	});

	it('refuses a release with no installable asset', () => {
		const empty = JSON.stringify([{ ...RELEASES[0], assets: [] }]);
		expect(() => echoAdapter.parseIndex(empty, API)).toThrow(ForeignFormatError);
	});
});

describe('convert', () => {
	it('refuses, naming the asset and the dex loader rather than the format', async () => {
		const [row] = echoAdapter.parseIndex(JSON.stringify(RELEASES), API).plugins;

		const error = await echoAdapter.convert(row, services()).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(ForeignFormatError);
		const refused = error as ForeignFormatError;
		expect(refused.message).toContain('demo.apk');
		expect(refused.message).toContain('DexLoader');
		// The source is named too, so the sentence says where the work is.
		expect(refused.message).toContain(REPOSITORY);
		expect(refused.obstacles[0]).toContain('DexLoader');
	});
});
