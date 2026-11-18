/**
 * What a Shosetsu extension index becomes.
 *
 * The document holds five arrays and only `scripts` is a listing, so the first
 * thing pinned is that the other four are ignored. The rest is the one address
 * rule the format has — a `.lua` file beside the index, derived from
 * `fileName` — the digest carried for a future check, and the refusal of a
 * script of another type.
 */
import { describe, expect, it } from 'vitest';

import { shosetsuAdapter } from './shosetsu';
import {
	listingRefusal,
	ForeignFormatError,
	type ConversionServices
} from '@plugin-bridge/core/adapter';
import { formatProfile } from '@plugin-bridge/core/formats';

const INDEX_URL = 'https://extensions.example.invalid/extensions/index.json';

const DIGEST_ONE = 'dce25cabb03979607acc13b46fd466fa3437492f3ecf6cd1b505ea6717bdde6f';
const DIGEST_TWO = 'a0228dfdf25f952e37667b1477d9152e27a5395cbd9976d525ed6e934d00028e';

const BODY = JSON.stringify({
	authors: [{ id: 1550377221, name: 'An Author', desc: 'Wrote one', imageURL: '', website: '' }],
	libraries: [{ id: 2, name: 'A Library', fileName: 'ALibrary', ver: '1.0.0' }],
	scripts: [
		{
			id: 1,
			name: 'Example One',
			fileName: 'ExampleOne',
			imageURL: 'https://extensions.example.invalid/icons/ExampleOne.png',
			lang: 'en',
			ver: '3.0.1',
			libVer: '1.0.0',
			md5: DIGEST_ONE,
			type: 'LuaScript'
		},
		{
			id: 70,
			name: 'Example Two',
			// Already spelled with its extension: it must not become `.lua.lua`.
			fileName: 'ExampleTwo.lua',
			imageURL: '',
			lang: 'ru',
			ver: '1.0.1',
			libVer: '1.0.0',
			md5: DIGEST_TWO,
			type: 'LuaScript'
		},
		{
			id: 71,
			name: 'Example Untyped',
			fileName: 'ExampleUntyped',
			imageURL: '',
			lang: 'pt',
			ver: '1.0.0',
			libVer: '1.0.0',
			md5: '',
			// No `type`: three of the five published indexes omit it, so an
			// absent one is the ordinary script rather than an unknown type.
			type: undefined
		},
		{
			id: 12,
			name: 'Example Script',
			fileName: 'ExampleScript',
			imageURL: '',
			lang: 'en',
			ver: '2.0.0',
			libVer: '1.0.0',
			md5: DIGEST_ONE,
			// Not Lua, so the `.lua` address below would be a guess.
			type: 'JavaScriptScript'
		},
		// Not a row: no name. Counted rather than silently lost.
		{ id: 13, fileName: 'Nameless', lang: 'en', ver: '1.0.0', type: 'LuaScript' }
	],
	styles: [{ id: 1, name: 'A Style', fileName: 'AStyle', type: 'Style' }],
	js: [{ id: 1, name: 'A Script', fileName: 'AScript', type: 'JavaScript' }]
});

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

describe('a Shosetsu extension index', () => {
	it('produces a row for each Lua script, exactly', () => {
		expect(shosetsuAdapter.parseIndex(BODY, INDEX_URL)).toEqual({
			name: 'Shosetsu extensions',
			updatedAt: '',
			signingKey: null,
			format: 'shosetsu',
			filteredOut: 2,
			plugins: [
				{
					...FIXED,
					id: 'app.yorozo.converted.shosetsu.s1',
					name: 'Example One',
					description: '',
					version: '3.0.1',
					author: '',
					language: 'en',
					hosts: [],
					download: 'https://extensions.example.invalid/extensions/ExampleOne.lua',
					origin: {
						format: 'shosetsu',
						artifactUrl: 'https://extensions.example.invalid/extensions/ExampleOne.lua',
						foreignId: '1',
						foreignVersion: '3.0.1',
						mediaKind: 'novel',
						isNsfw: false,
						detail: { md5: DIGEST_ONE, libVer: '1.0.0' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.shosetsu.s70',
					name: 'Example Two',
					description: '',
					version: '1.0.1',
					author: '',
					language: 'ru',
					hosts: [],
					download: 'https://extensions.example.invalid/extensions/ExampleTwo.lua',
					origin: {
						format: 'shosetsu',
						artifactUrl: 'https://extensions.example.invalid/extensions/ExampleTwo.lua',
						foreignId: '70',
						foreignVersion: '1.0.1',
						mediaKind: 'novel',
						isNsfw: false,
						detail: { md5: DIGEST_TWO, libVer: '1.0.0' }
					}
				},
				{
					...FIXED,
					id: 'app.yorozo.converted.shosetsu.s71',
					name: 'Example Untyped',
					description: '',
					version: '1.0.0',
					author: '',
					language: 'pt',
					hosts: [],
					download: 'https://extensions.example.invalid/extensions/ExampleUntyped.lua',
					origin: {
						format: 'shosetsu',
						artifactUrl: 'https://extensions.example.invalid/extensions/ExampleUntyped.lua',
						foreignId: '71',
						foreignVersion: '1.0.0',
						mediaKind: 'novel',
						isNsfw: false,
						// An empty digest stays empty rather than becoming a value.
						detail: { md5: null, libVer: '1.0.0' }
					}
				}
			]
		});
	});

	it('keeps the rows and refuses each one by its medium', () => {
		const index = shosetsuAdapter.parseIndex(BODY, INDEX_URL);

		// Dropping every row for its medium would leave an empty list and a
		// number, which is nothing to browse. The refusal is per row instead.
		for (const listing of index.plugins) {
			expect(listingRefusal(listing)).toBe(
				'This is a novel source. Yorozo does not support that yet.'
			);
		}
	});

	it('refuses a script of another type, and counts it', () => {
		const index = shosetsuAdapter.parseIndex(BODY, INDEX_URL);
		const foreignIds = index.plugins.map((plugin) => plugin.origin?.foreignId);

		expect(foreignIds).toEqual(['1', '70', '71']);
		// The non-Lua script and the nameless row.
		expect(index.filteredOut).toBe(2);
	});

	it('refuses an index of another format', () => {
		const aidoku = JSON.stringify({
			sources: [{ id: 'en.a', name: 'A', downloadURL: 'sources/a.aix' }]
		});
		const kotatsu = JSON.stringify([
			{ name: 'A', contentType: 'MANGA', baseUrl: 'https://a.example.invalid' }
		]);
		// An index whose only arrays are the non-listing ones.
		const noScripts = JSON.stringify({ authors: [], libraries: [], scripts: [] });

		expect(() => shosetsuAdapter.parseIndex(aidoku, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => shosetsuAdapter.parseIndex(kotatsu, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => shosetsuAdapter.parseIndex(noScripts, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => shosetsuAdapter.parseIndex('<html></html>', INDEX_URL)).toThrow(
			ForeignFormatError
		);
	});

	it('refuses conversion with the profile’s sentence', async () => {
		const listing = shosetsuAdapter.parseIndex(BODY, INDEX_URL).plugins[0];

		await expect(shosetsuAdapter.convert(listing, NOTHING_REACHABLE)).rejects.toThrow(
			formatProfile('shosetsu').refusal ?? ''
		);
	});
});
