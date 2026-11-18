import { readFileSync, writeFileSync } from 'node:fs';

const path = 'fixtures/indexes.json';
let text = readFileSync(path, 'utf8').replace(/\s*$/, '');
text = text.slice(0, -1).replace(/\s*$/, '');

const added = {
	kotatsu: {
		indexUrl: 'https://example.invalid/kotatsu/index.json',
		body: [
			{
				name: 'EXAMPLE_PARSER',
				title: 'Example Parser',
				lang: 'en',
				contentType: 'MANGA',
				nsfw: 0,
				isBroken: false,
				baseUrl: 'https://manga.example.invalid',
				iconUrl: 'https://manga.example.invalid/icon.png'
			},
			{
				name: 'EXAMPLE_WEBTOON',
				title: 'Example Webtoon',
				lang: 'en',
				contentType: 'HENTAI',
				nsfw: 1,
				isBroken: true,
				baseUrl: 'https://webtoon.example.invalid',
				iconUrl: 'https://webtoon.example.invalid/icon.png'
			}
		]
	},
	aidoku: {
		indexUrl: 'https://example.invalid/aidoku/index.min.json',
		body: {
			name: 'Example Sources',
			sources: [
				{
					id: 'en.example',
					name: 'Example',
					version: 3,
					iconURL: 'icons/en.example-v3.png',
					downloadURL: 'sources/en.example-v3.aix',
					languages: ['en'],
					contentRating: 1,
					baseURL: 'https://example.invalid',
					minAppVersion: '0.8.3'
				},
				{
					id: 'en.adult',
					name: 'Example Adult',
					version: 1,
					downloadURL: 'sources/en.adult-v1.aix',
					languages: ['ja'],
					contentRating: 2,
					baseURL: 'https://adult.example.invalid'
				}
			]
		}
	},
	shosetsu: {
		indexUrl: 'https://example.invalid/shosetsu/index.json',
		body: {
			authors: [{ id: 1, name: 'Example Author', desc: '', imageURL: '', website: '' }],
			libraries: [{ name: 'Example Novels', ver: '1.0.0', url: null, hash: 'a'.repeat(64) }],
			scripts: [
				{
					id: 1,
					name: 'Example Novels',
					fileName: 'ExampleNovels',
					imageURL: 'https://example.invalid/shosetsu/icons/ExampleNovels.png',
					lang: 'en',
					ver: '3.0.1',
					libVer: '1.0.0',
					md5: 'b'.repeat(64),
					type: 'LuaScript'
				},
				{
					id: 2,
					name: 'Example Script',
					fileName: 'ExampleScript',
					imageURL: '',
					lang: 'en',
					ver: '1.0.0',
					libVer: '1.0.0',
					md5: 'c'.repeat(64),
					type: 'JavaScript'
				}
			],
			styles: [],
			js: []
		}
	}
};

let out = text;
for (const [key, value] of Object.entries(added)) {
	out +=
		',\n\t' + JSON.stringify(key) + ': ' + JSON.stringify(value, null, 1).replace(/\n/g, '\n\t');
}
out += '\n}\n';

writeFileSync(path, out);
console.log('keys', Object.keys(JSON.parse(out)).length);
