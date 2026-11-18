import { readFileSync, writeFileSync } from 'node:fs';

const path = 'fixtures/indexes.json';
let text = readFileSync(path, 'utf8').replace(/\s*$/, '');
text = text.slice(0, -1).replace(/\s*$/, '');

const added = {
	paperback: {
		indexUrl: 'https://example.invalid/paperback/0.9/stable/versioning.json',
		body: {
			buildTime: '2026-01-02T03:04:05.000Z',
			builtWith: { toolchain: '1.0.0-alpha.1', types: '1.0.0-alpha.1' },
			repository: { name: 'Example extensions', description: 'Example repository.' },
			sources: [
				{
					id: 'Alpha',
					name: 'Alpha',
					description: 'Example source',
					version: '1.0.0-alpha.4',
					icon: 'icon.png',
					language: 'en',
					contentRating: 'MATURE',
					badges: [],
					capabilities: [1, 64],
					developers: [
						{ name: 'Example', website: null, github: 'https://example.invalid/example' }
					]
				}
			]
		}
	},
	mana: {
		indexUrl: 'https://example.invalid/mana/sources.json',
		body: {
			repositoryName: 'Example sources',
			thumbnail: 'https://example.invalid/mana/thumb.png',
			sources: [
				{
					id: 'Beta',
					name: 'Beta',
					version: '0.0.1-alpha.3',
					website: 'https://site.example.invalid',
					thumbnail: 'Beta.png',
					rating: 1,
					description: 'Example source',
					supportedLanguages: ['en_US'],
					badges: [],
					developers: [{ name: 'Example', github: 'https://example.invalid/example' }],
					path: 'Beta',
					environment: 'source',
					intents: 106961928,
					hash: 'd'.repeat(96)
				}
			]
		}
	},
	suwatte: {
		indexUrl: 'https://example.invalid/suwatte/index.json',
		body: {
			sources: [
				{
					id: 'en.example.gamma',
					name: 'Gamma',
					version: 4,
					website: 'https://gamma.example.invalid',
					languages: ['en'],
					rating: 'MATURE',
					thumbnail: 'gamma.jxl',
					fileName: 'en.example.gamma.tjs'
				}
			]
		}
	},
	seanime: {
		indexUrl: 'https://example.invalid/seanime/marketplace/main.json',
		body: [
			{
				id: 'delta',
				name: 'Delta',
				description: 'Example provider',
				manifestURI: 'https://example.invalid/seanime/src/anime/delta/manifest.json',
				author: 'Example',
				type: 'anime-provider',
				language: 'javascript',
				lang: 'en',
				icon: 'https://example.invalid/seanime/public/delta.png',
				website: '',
				tags: []
			},
			{
				id: 'delta-plugin',
				name: 'Delta Plugin',
				description: 'A client plugin with no catalogue',
				manifestURI: 'https://example.invalid/seanime/plugins/delta-plugin/manifest.json',
				author: 'Example',
				type: 'plugin',
				language: 'typescript',
				lang: 'en',
				icon: '',
				website: '',
				tags: []
			}
		]
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
