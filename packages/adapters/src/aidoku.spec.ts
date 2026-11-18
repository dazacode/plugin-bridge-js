/**
 * What an Aidoku source index becomes, and what it refuses.
 *
 * Both published document shapes are pinned, because both are still served and
 * a viewer cannot choose which one a repository uses. The rest is about the
 * facts a row carries: the resolved artifact, the first language, the rating
 * that becomes `isNsfw` while staying visible as a number, and the client
 * version it was built for.
 */
import { describe, expect, it } from 'vitest';

import { aidokuAdapter } from './aidoku';
import { ForeignFormatError, type ConversionServices } from '@plugin-bridge/core/adapter';
import { formatProfile } from '@plugin-bridge/core/formats';

const INDEX_URL = 'https://sources.example.invalid/repo/index.min.json';

const MODERN = JSON.stringify({
	name: 'Example sources',
	sources: [
		{
			id: 'en.alpha',
			name: 'Example Alpha',
			version: 3,
			iconURL: 'icons/en.alpha-v3.png',
			downloadURL: 'sources/en.alpha-v3.aix',
			languages: ['en'],
			contentRating: 0,
			baseURL: 'https://alpha.example.invalid',
			minAppVersion: '0.8.3'
		},
		{
			id: 'en.beta',
			name: 'Example Beta',
			version: 12,
			iconURL: 'icons/en.beta-v12.png',
			// Absolute, because one repository publishes them so.
			downloadURL: 'https://cdn.example.invalid/en.beta-v12.aix',
			languages: ['en', 'fr'],
			contentRating: 2,
			baseURL: 'https://beta.example.invalid',
			minAppVersion: '0.7.0'
		},
		{
			id: 'multi.gamma',
			name: 'Example Gamma',
			version: 1,
			iconURL: '',
			downloadURL: 'sources/multi.gamma-v1.aix',
			languages: ['ja'],
			contentRating: 1,
			baseURL: 'https://gamma.example.invalid',
			minAppVersion: ''
		}
	]
});

// The older document: a bare array, `file` rather than `downloadURL`, `nsfw`
// rather than `contentRating`, and no base address at all.
const LEGACY = JSON.stringify([
	{
		id: 'zh.delta',
		name: 'Example Delta',
		file: 'zh.delta-v2.aix',
		icon: 'zh.delta-v2.png',
		lang: 'zh',
		version: 2,
		nsfw: 2
	}
]);

const FIXED = {
	license: '',
	yorozoPluginApi: 1,
	minimumYorozoVersion: '0.0.0',
	platforms: ['android', 'ios', 'macos', 'windows', 'linux', 'web'],
	capabilities: ['search', 'episodes', 'resolve'],
	permissions: ['network'],
	sha256: '',
	size: 0
};

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

describe('an Aidoku source index', () => {
	it('produces a row for each source, exactly', () => {
		expect(aidokuAdapter.parseIndex(MODERN, INDEX_URL)).toEqual({
			name: 'Example sources',
			updatedAt: '',
			signingKey: null,
			format: 'aidoku',
			filteredOut: 0,
			plugins: [
				{
					...FIXED,
					id: 'app.yorozo.converted.aidoku.en_alpha',
					name: 'Example Alpha',
					description: '',
					version: '3',
					author: '',
					language: 'en',
					hosts: ['*.example.invalid', 'alpha.example.invalid', 'sources.example.invalid'],
					download: 'https://sources.example.invalid/repo/sources/en.alpha-v3.aix',
					origin: {
						format: 'aidoku',
						artifactUrl: 'https://sources.example.invalid/repo/sources/en.alpha-v3.aix',
						foreignId: 'en.alpha',
						foreignVersion: '3',
						mediaKind: 'manga',
						isNsfw: false,
						detail: { contentRating: 0, minAppVersion: '0.8.3' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.aidoku.en_beta',
					name: 'Example Beta',
					description: '',
					version: '12',
					author: '',
					language: 'en',
					hosts: ['*.example.invalid', 'beta.example.invalid', 'cdn.example.invalid'],
					download: 'https://cdn.example.invalid/en.beta-v12.aix',
					origin: {
						format: 'aidoku',
						artifactUrl: 'https://cdn.example.invalid/en.beta-v12.aix',
						foreignId: 'en.beta',
						foreignVersion: '12',
						mediaKind: 'manga',
						isNsfw: true,
						detail: { contentRating: 2, minAppVersion: '0.7.0' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.aidoku.multi_gamma',
					name: 'Example Gamma',
					description: '',
					version: '1',
					author: '',
					language: 'ja',
					hosts: ['*.example.invalid', 'gamma.example.invalid', 'sources.example.invalid'],
					download: 'https://sources.example.invalid/repo/sources/multi.gamma-v1.aix',
					origin: {
						format: 'aidoku',
						artifactUrl: 'https://sources.example.invalid/repo/sources/multi.gamma-v1.aix',
						foreignId: 'multi.gamma',
						foreignVersion: '1',
						mediaKind: 'manga',
						// Suggestive, not adult: a warning either way, and the number
						// survives in `detail` so a reader can tell the two apart.
						isNsfw: true,
						detail: { contentRating: 1, minAppVersion: '' }
					}
				}
			]
		});
	});

	it('reads the older bare-array document the same way', () => {
		const index = aidokuAdapter.parseIndex(LEGACY, INDEX_URL);

		expect(index.name).toBe('Aidoku sources');
		expect(index.plugins).toHaveLength(1);
		expect(index.plugins[0]).toEqual({
			...FIXED,
			id: 'app.yorozo.converted.aidoku.zh_delta',
			name: 'Example Delta',
			description: '',
			version: '2',
			author: '',
			language: 'zh',
			hosts: ['*.example.invalid', 'sources.example.invalid'],
			download: 'https://sources.example.invalid/repo/zh.delta-v2.aix',
			origin: {
				format: 'aidoku',
				artifactUrl: 'https://sources.example.invalid/repo/zh.delta-v2.aix',
				foreignId: 'zh.delta',
				foreignVersion: '2',
				mediaKind: 'manga',
				isNsfw: true,
				detail: { contentRating: 2, minAppVersion: null }
			}
		});
	});

	it('counts a row with no address instead of inventing one', () => {
		const body = JSON.stringify({
			sources: [{ id: 'en.gone', name: 'Gone', languages: ['en'] }]
		});

		// No usable row at all, so the document is refused rather than returned
		// as an empty catalogue that reads like a failed fetch.
		expect(() => aidokuAdapter.parseIndex(body, INDEX_URL)).toThrow(ForeignFormatError);

		const partial = JSON.stringify({
			sources: [
				{ id: 'en.gone', name: 'Gone' },
				{ id: 'en.kept', name: 'Kept', downloadURL: 'sources/kept.aix' }
			]
		});
		const index = aidokuAdapter.parseIndex(partial, INDEX_URL);
		expect(index.plugins.map((plugin) => plugin.origin?.foreignId)).toEqual(['en.kept']);
		expect(index.filteredOut).toBe(1);
	});

	it('refuses an index of another format', () => {
		const kotatsu = JSON.stringify([
			{ name: 'A', contentType: 'MANGA', baseUrl: 'https://a.example.invalid' }
		]);
		const shosetsu = JSON.stringify({
			scripts: [{ id: 1, name: 'A', fileName: 'A', type: 'LuaScript' }]
		});
		const nuvio = JSON.stringify({ scrapers: [{ name: 'A', filename: 'a.js' }] });

		expect(() => aidokuAdapter.parseIndex(kotatsu, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => aidokuAdapter.parseIndex(shosetsu, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => aidokuAdapter.parseIndex(nuvio, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => aidokuAdapter.parseIndex('<html></html>', INDEX_URL)).toThrow(ForeignFormatError);
	});

	it('refuses conversion with the profile’s sentence', async () => {
		const listing = aidokuAdapter.parseIndex(MODERN, INDEX_URL).plugins[0];

		await expect(aidokuAdapter.convert(listing, NOTHING_REACHABLE)).rejects.toThrow(
			formatProfile('aidoku').refusal ?? ''
		);
	});
});
