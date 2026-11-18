/**
 * What a Kotatsu parser index becomes, row by row.
 *
 * The behaviours pinned here are the ones that would be silently wrong: which
 * medium a `contentType` claims, that a broken row survives, that an empty
 * base address still produces an address, and that a foreign document is
 * refused rather than partly believed. Everything reaches no network.
 */
import { describe, expect, it } from 'vitest';

import { kotatsuAdapter } from './kotatsu';
import {
	listingRefusal,
	ForeignFormatError,
	type ConversionServices
} from '@plugin-bridge/core/adapter';
import { formatProfile } from '@plugin-bridge/core/formats';

const INDEX_URL = 'https://plugins.example.invalid/repo/index/example.json';

const BODY = JSON.stringify([
	{
		name: 'EXAMPLE_MANGA',
		title: 'Example Manga',
		lang: 'en',
		contentType: 'MANGA',
		nsfw: 0,
		isBroken: true,
		baseUrl: 'https://manga.example.invalid',
		iconUrl: 'https://cdn.example.invalid/icon.png'
	},
	{
		name: 'EXAMPLE_ADULT',
		title: 'Example Adult',
		lang: 'ja',
		contentType: 'HENTAI',
		nsfw: 1,
		isBroken: false,
		baseUrl: '',
		iconUrl: ''
	},
	{
		name: 'EXAMPLE_ANIME',
		title: 'Example Anime',
		lang: 'ar',
		contentType: 'ANIME',
		nsfw: 0,
		isBroken: false,
		baseUrl: 'https://anime.example.invalid',
		iconUrl: ''
	},
	{
		name: 'EXAMPLE_NOVEL',
		title: 'Example Novel',
		lang: 'en',
		contentType: 'NOVEL',
		nsfw: 0,
		isBroken: false,
		baseUrl: 'https://novel.example.invalid',
		iconUrl: ''
	},
	// Not a row: no name, so nothing can be filed under it. The other rows must
	// still parse, and this one must be counted rather than silently vanish.
	{
		title: 'Nameless',
		contentType: 'MANGA',
		baseUrl: 'https://nameless.example.invalid'
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

describe('a Kotatsu parser index', () => {
	it('produces a row for each parser, exactly', () => {
		expect(kotatsuAdapter.parseIndex(BODY, INDEX_URL)).toEqual({
			name: 'Kotatsu parsers',
			updatedAt: '',
			signingKey: null,
			format: 'kotatsu',
			filteredOut: 1,
			plugins: [
				{
					...FIXED,
					id: 'app.yorozo.converted.kotatsu.example_manga',
					name: 'Example Manga',
					description: 'Kotatsu marks this parser as broken.',
					version: '0',
					author: '',
					language: 'en',
					hosts: ['*.example.invalid', 'manga.example.invalid'],
					download: 'https://manga.example.invalid',
					origin: {
						format: 'kotatsu',
						artifactUrl: 'https://manga.example.invalid',
						foreignId: 'EXAMPLE_MANGA',
						foreignVersion: '0',
						mediaKind: 'manga',
						mediaKinds: ['manga'],
						isNsfw: false,
						detail: { parser: 'EXAMPLE_MANGA', contentType: 'MANGA' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.kotatsu.example_adult',
					name: 'Example Adult',
					description: '',
					version: '0',
					author: '',
					language: 'ja',
					hosts: [],
					download: INDEX_URL,
					origin: {
						format: 'kotatsu',
						artifactUrl: INDEX_URL,
						foreignId: 'EXAMPLE_ADULT',
						foreignVersion: '0',
						mediaKind: 'manga',
						mediaKinds: ['manga'],
						isNsfw: true,
						detail: { parser: 'EXAMPLE_ADULT', contentType: 'HENTAI' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.kotatsu.example_anime',
					name: 'Example Anime',
					description: '',
					version: '0',
					author: '',
					language: 'ar',
					hosts: ['*.example.invalid', 'anime.example.invalid'],
					download: 'https://anime.example.invalid',
					origin: {
						format: 'kotatsu',
						artifactUrl: 'https://anime.example.invalid',
						foreignId: 'EXAMPLE_ANIME',
						foreignVersion: '0',
						// Filed under manga — a listing names no episodes — while
						// keeping the anime claim the contentType made.
						mediaKind: 'manga',
						mediaKinds: ['manga', 'anime'],
						isNsfw: false,
						detail: { parser: 'EXAMPLE_ANIME', contentType: 'ANIME' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.kotatsu.example_novel',
					name: 'Example Novel',
					description: '',
					version: '0',
					author: '',
					language: 'en',
					hosts: ['*.example.invalid', 'novel.example.invalid'],
					download: 'https://novel.example.invalid',
					origin: {
						format: 'kotatsu',
						artifactUrl: 'https://novel.example.invalid',
						foreignId: 'EXAMPLE_NOVEL',
						foreignVersion: '0',
						mediaKind: 'novel',
						mediaKinds: ['novel'],
						isNsfw: false,
						detail: { parser: 'EXAMPLE_NOVEL', contentType: 'NOVEL' }
					}
				}
			]
		});
	});

	it('keeps a broken row, because the row is the only thing there is to show', () => {
		const listing = kotatsuAdapter.parseIndex(BODY, INDEX_URL).plugins[0];
		expect(listing.description).toBe('Kotatsu marks this parser as broken.');
	});

	it('keeps a novel row and lets the medium refuse it', () => {
		const index = kotatsuAdapter.parseIndex(BODY, INDEX_URL);
		const novel = index.plugins.find((plugin) => plugin.origin?.foreignId === 'EXAMPLE_NOVEL');

		// Nothing here installs anyway, so hiding the novel row would hide the
		// one thing it has to say. The medium refusal is `refusalFor`'s, and is
		// not written a second time in the adapter.
		expect(novel?.origin?.mediaKind).toBe('novel');
		expect(listingRefusal(novel!)).toBe(
			'This is a novel source. Yorozo does not support that yet.'
		);

		// One row was not a row at all; that is the only loss.
		expect(index.filteredOut).toBe(1);
	});

	it('leaves the format refusal to the profile', () => {
		expect(formatProfile('kotatsu').refusal).toMatch(/compiled into the Kotatsu client/);

		const listing = kotatsuAdapter.parseIndex(BODY, INDEX_URL).plugins[0];
		expect(listingRefusal(listing)).toBe(formatProfile('kotatsu').refusal);
	});

	it('refuses an index of another format', () => {
		// The adapter is chosen by body, so anything permissive would shadow the
		// adapter that owns these documents.
		const aidoku = JSON.stringify({
			name: 'Elsewhere',
			sources: [{ id: 'en.a', name: 'A', downloadURL: 'sources/a.aix' }]
		});
		const lnreader = JSON.stringify([
			{ name: 'A', site: 'https://a.example.invalid', url: 'x.js' }
		]);

		expect(() => kotatsuAdapter.parseIndex(aidoku, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => kotatsuAdapter.parseIndex(lnreader, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => kotatsuAdapter.parseIndex('<html></html>', INDEX_URL)).toThrow(ForeignFormatError);

		// An empty list is the one exception, and only on this format's own path
		// convention — one published repository really is an empty `index/*.json`
		// and reading it as a parse failure blames the adapter for the site.
		expect(kotatsuAdapter.parseIndex('[]', INDEX_URL).plugins).toEqual([]);
		expect(() =>
			kotatsuAdapter.parseIndex('[]', 'https://plugins.example.invalid/repo/index.json')
		).toThrow(ForeignFormatError);
	});

	it('refuses conversion with the profile’s sentence', async () => {
		const listing = kotatsuAdapter.parseIndex(BODY, INDEX_URL).plugins[0];

		await expect(kotatsuAdapter.convert(listing, NOTHING_REACHABLE)).rejects.toThrow(
			formatProfile('kotatsu').refusal ?? ''
		);
	});
});
