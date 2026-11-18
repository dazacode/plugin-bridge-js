/**
 * Which format a pasted URL turns out to be.
 *
 * The two properties that matter are both about precedence. The native format
 * must win everywhere, because reading a Yorozo repository as a foreign one
 * would convert something that needs no conversion and lose its signature
 * doing it. And the *body* must decide, because several of these ecosystems
 * publish a file called `index.json` and mean different things by it.
 */

import { FOREIGN_ADAPTERS } from '@plugin-bridge/adapters';
import { describe, expect, it } from 'vitest';

import { ForeignFormatError, ForeignIndexError, type ForeignAdapter } from './adapter';

import fixtures from '../../../fixtures/indexes.json';
import { detectRepository, detectionCandidates } from './detect';

type Fixture = { indexUrl: string; body: unknown; repoJson?: unknown };
const catalogue = fixtures as unknown as Record<string, Fixture>;

/** Serves exactly one document, and 404s everything else. */
function serve(documents: Record<string, unknown>) {
	return async (url: string) => {
		if (url in documents) return JSON.stringify(documents[url]);
		throw new Error(`nothing at ${url}`);
	};
}

const NATIVE_INDEX = {
	schemaVersion: 1,
	name: 'A Yorozo repository',
	updatedAt: '2026-09-08',
	signingKey: null,
	plugins: [
		{
			id: 'com.example.plugins.demo',
			name: 'Demo',
			version: '1.0.0',
			download: 'https://example.invalid/demo.yorozoplugin',
			sha256: 'ab'.repeat(32),
			permissions: ['network'],
			hosts: ['api.example.com']
		}
	]
};

describe('what gets tried, and in what order', () => {
	it('puts the native candidates first', () => {
		const { candidates } = detectionCandidates('https://github.com/owner/repo', FOREIGN_ADAPTERS);

		expect(candidates[0]).toBe('https://raw.githubusercontent.com/owner/repo/main/index.json');
		expect(candidates).toContain(
			'https://raw.githubusercontent.com/owner/repo/repo/index.min.json'
		);
	});

	it('tries each URL once even though four adapters offer some of them', () => {
		const { candidates } = detectionCandidates('https://github.com/owner/repo', FOREIGN_ADAPTERS);
		expect(new Set(candidates).size).toBe(candidates.length);
	});

	it('accepts the owner/repo shorthand and refuses anything not https', () => {
		expect(detectionCandidates('owner/repo', FOREIGN_ADAPTERS).candidates[0]).toMatch(
			/^https:\/\/raw\.githubusercontent\.com\/owner\/repo\//
		);
		expect(() =>
			detectionCandidates('http://example.invalid/index.json', FOREIGN_ADAPTERS)
		).toThrow(/https/);
		expect(() => detectionCandidates('   ', FOREIGN_ADAPTERS)).toThrow(/Paste a repository URL/);
	});
});

describe('the body decides, not the path', () => {
	it('reads a Yorozo index as native even where a foreign adapter also looks', async () => {
		const url = 'https://raw.githubusercontent.com/owner/repo/main/index.json';
		const found = await detectRepository(
			'https://github.com/owner/repo',
			serve({ [url]: NATIVE_INDEX }),
			FOREIGN_ADAPTERS
		);

		expect(found.index.format).toBe('yorozo');
		expect(found.index.plugins[0].origin).toBeUndefined();
	});

	it.each(['aniyomi', 'hayase', 'lnreader', 'mangayomi'])(
		'recognises a %s index by its contents',
		async (format) => {
			const fixture = catalogue[format];
			const documents: Record<string, unknown> = {
				[fixture.indexUrl]: fixture.body
			};
			const found = await detectRepository(fixture.indexUrl, serve(documents), FOREIGN_ADAPTERS);

			expect(found.index.format).toBe(format);
			expect(found.indexUrl).toBe(fixture.indexUrl);
		}
	);

	it('reports every URL it tried when nothing is there', async () => {
		await expect(
			detectRepository('https://github.com/owner/repo', serve({}), FOREIGN_ADAPTERS)
		).rejects.toThrow(/raw\.githubusercontent\.com\/owner\/repo/);
	});

	it('refuses a native index from a newer schema instead of guessing a format', async () => {
		// A repository relying on a field this build ignores must fail loudly.
		// Falling through to a foreign adapter would be the worst kind of guess.
		const url = 'https://example.invalid/index.json';
		await expect(
			detectRepository(
				url,
				serve({ [url]: { ...NATIVE_INDEX, schemaVersion: 2 } }),
				FOREIGN_ADAPTERS
			)
		).rejects.toThrow(/index format 2/);
	});

	it('does not read a foreign index as a broken native one', async () => {
		// The other half of the rule above, and the half that was wrong. A body
		// with no `schemaVersion` at all is not claiming to be ours — several
		// foreign indexes are plain JSON objects — but the native parser raises
		// the same "index format" error for it, and rethrowing that stopped
		// detection dead at the first candidate. An entire format could not be
		// added, with an error naming a field its repository never claimed.
		const fixture = catalogue['cloudstream'] as Fixture & {
			pluginList: { url: string; body: unknown };
		};
		const found = await detectRepository(
			fixture.indexUrl,
			serve({
				[fixture.indexUrl]: fixture.body,
				[fixture.pluginList.url]: fixture.pluginList.body
			}),
			FOREIGN_ADAPTERS
		);

		expect(found.index.format).toBe('cloudstream');
	});
});

/**
 * The install links an ecosystem's own documentation tells people to copy.
 *
 * One publishes them under its own scheme, formed by swapping `https` for it
 * and changing nothing else. Pasting one used to fail with "a repository must
 * be https" — true about the scheme, and useless as advice to somebody who
 * copied the link they were given.
 */
describe('a pasted install link under another scheme', () => {
	it('is read as the https address it always named', () => {
		const { url } = detectionCandidates('stremio://addon.example.invalid/lite/manifest.json', []);

		expect(url.toString()).toBe('https://addon.example.invalid/lite/manifest.json');
	});

	it('still fetches over https, which is the rule that mattered', () => {
		const { candidates } = detectionCandidates(
			'stremio://addon.example.invalid/lite/manifest.json',
			[]
		);

		expect(candidates.every((candidate) => candidate.startsWith('https://'))).toBe(true);
	});

	it('leaves every other scheme refused', () => {
		expect(() => detectionCandidates('http://addon.example.invalid/manifest.json', [])).toThrow(
			/must be https/
		);
		expect(() => detectionCandidates('ftp://addon.example.invalid/manifest.json', [])).toThrow(
			/must be https/
		);
	});
});

describe('an index that is not text', () => {
	/** An adapter that only reads bytes, standing in for the real one. */
	function binaryAdapter(seen: { bytes?: Uint8Array; text?: string }): ForeignAdapter {
		return {
			format: 'mangayomi',
			candidates: () => [],
			parseIndexBytes(bytes, indexUrl) {
				seen.bytes = bytes;
				if (bytes[0] !== 0x1f) throw new ForeignFormatError('not this format');
				return {
					name: 'From bytes',
					updatedAt: '',
					signingKey: null,
					plugins: [],
					format: 'mangayomi',
					indexUrl
				} as never;
			},
			parseIndex(body) {
				seen.text = body;
				throw new ForeignFormatError('not this format either');
			},
			convert: () => Promise.reject(new Error('not used'))
		};
	}

	it('hands the adapter raw bytes when a byte fetcher was supplied', async () => {
		const seen: { bytes?: Uint8Array; text?: string } = {};
		const raw = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);

		const found = await detectRepository(
			'https://example.invalid/index.pb',
			() => Promise.reject(new Error('text should not be fetched separately')),
			[binaryAdapter(seen)],
			() => Promise.resolve(raw)
		);

		expect(found.index.name).toBe('From bytes');
		expect(seen.bytes).toEqual(raw);
		// One fetch: the text an adapter would see is decoded from these bytes
		// rather than requested again.
		expect(seen.text).toBeUndefined();
	});

	it('falls through to the same adapter’s text door when the bytes are not its format', async () => {
		// A format may publish two spellings of its index, and only the adapter
		// knows both. Falling through to the *next* adapter would lose the
		// refusal the right one wanted to give.
		const seen: { bytes?: Uint8Array; text?: string } = {};
		const raw = new TextEncoder().encode('[{"not":"gzip"}]');

		await expect(
			detectRepository(
				'https://example.invalid/index.json',
				() => Promise.resolve('unused'),
				[binaryAdapter(seen)],
				() => Promise.resolve(raw)
			)
		).rejects.toThrow();

		expect(seen.bytes).toEqual(raw);
		expect(seen.text).toBe('[{"not":"gzip"}]');
	});

	it('leaves a text-only host exactly as it was', async () => {
		// The byte fetcher is optional. A host without one cannot see a binary
		// index, which is a gap rather than a break.
		const seen: { bytes?: Uint8Array; text?: string } = {};

		await expect(
			detectRepository('https://example.invalid/index.json', () => Promise.resolve('[]'), [
				binaryAdapter(seen)
			])
		).rejects.toThrow();

		expect(seen.bytes).toBeUndefined();
		expect(seen.text).toBe('[]');
	});
});

describe('an index file pasted beside a sibling format’s stub', () => {
	const PASTED = 'https://raw.example.invalid/owner/novels/repo/index.pb';
	const STUB = 'https://raw.example.invalid/owner/novels/repo/index.min.json';

	/** A format that derives a sibling `index.min.json` and recognises it as a stub. */
	const stubbed: ForeignAdapter = {
		format: 'mihon',
		candidates: (pasted) => [new URL('index.min.json', pasted).toString()],
		parseIndex(body) {
			if (body.includes('placeholder')) {
				throw new ForeignIndexError('This is the deprecated stub; the real index is beside it.');
			}
			throw new ForeignFormatError('not this format');
		},
		convert: () => Promise.reject(new Error('not used'))
	};

	/** A format whose index is the binary file itself, offered as pasted. */
	const binary: ForeignAdapter = {
		format: 'tsundoku',
		candidates: (pasted) => (pasted.pathname.endsWith('.pb') ? [pasted.toString()] : []),
		parseIndexBytes(bytes, indexUrl) {
			if (bytes[0] !== 0x1f) throw new ForeignFormatError('not gzip');
			return {
				name: 'The real index',
				description: '',
				updatedAt: '',
				signingKey: null,
				plugins: [],
				format: 'tsundoku',
				indexUrl
			} as never;
		},
		parseIndex() {
			throw new ForeignFormatError('not text');
		},
		convert: () => Promise.reject(new Error('not used'))
	};

	it('fetches the pasted file first, before anything derived from the repository', async () => {
		// The pasted `index.pb` was the twenty-first URL tried: not a `.json`,
		// so the native resolver derived paths under it, and other formats
		// derived theirs from the repository — one of them the stub, whose
		// refusal ended detection before the pasted URL was requested at all.
		expect(detectionCandidates(PASTED, FOREIGN_ADAPTERS).candidates[0]).toBe(PASTED);

		const fetched: string[] = [];
		const found = await detectRepository(
			PASTED,
			() => Promise.reject(new Error('text is decoded from the bytes')),
			[stubbed, binary],
			async (url) => {
				fetched.push(url);
				if (url === PASTED) return new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
				if (url === STUB) return new TextEncoder().encode('["placeholder"]');
				throw new Error(`nothing at ${url}`);
			}
		);

		expect(found.indexUrl).toBe(PASTED);
		expect(found.index.name).toBe('The real index');
		expect(fetched).toEqual([PASTED]);
	});

	it('keeps looking past a stub it derived, and finds the real index after it', async () => {
		// A repository pasted bare. The stub is recognised and refused by the
		// format it belongs to — and that refusal is about a document nobody
		// asked for, so it no longer stops the candidates after it.
		const repository = 'https://github.com/owner/novels';
		const stub = 'https://raw.githubusercontent.com/owner/novels/main/index.min.json';
		const real = 'https://raw.githubusercontent.com/owner/novels/repo/index.min.json';
		const { candidates } = detectionCandidates(repository, FOREIGN_ADAPTERS);
		expect(candidates.indexOf(stub)).toBeLessThan(candidates.indexOf(real));

		const found = await detectRepository(
			repository,
			serve({ [stub]: catalogue['mihon'].body, [real]: catalogue['tsundoku'].body }),
			FOREIGN_ADAPTERS
		);

		expect(found.indexUrl).toBe(real);
		expect(found.index.format).toBe('tsundoku');
	});

	it('still gives the stub’s sentence when nothing else is there', async () => {
		// Not loosened: the stub is still never read as a catalogue, and with
		// no real index found its refusal is the answer rather than "nothing".
		const stub = 'https://raw.githubusercontent.com/owner/novels/main/index.min.json';
		await expect(
			detectRepository(
				'https://github.com/owner/novels',
				serve({ [stub]: catalogue['mihon'].body }),
				FOREIGN_ADAPTERS
			)
		).rejects.toThrow(/index\.pb/);
		await expect(
			detectRepository(stub, serve({ [stub]: catalogue['mihon'].body }), FOREIGN_ADAPTERS)
		).rejects.toThrow(ForeignIndexError);
	});
});
