/**
 * The globals a Mangayomi JavaScript source is handed, checked against the
 * format's own host rather than against their names.
 *
 * Each helper here has an upstream body — the format's JavaScript utils, and
 * the Dart bridge those forward to — and the expected values below are what
 * that body answers, worked through by hand from its source. A helper that
 * "does roughly what its name says" is exactly the thing these specs exist to
 * catch: the string helpers used to return '' where upstream returns the whole
 * string, and every source that relied on the difference read an empty id.
 *
 * The bundle is built and imported the way a sandbox would, as a module, and
 * driven through `searchCatalog` because that is the first call that sets the
 * context the crypto helpers need.
 */
import { randomBytes, webcrypto } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mangayomiEntrypoint } from './mangayomi-entry';

/** A context carrying the codecs and the crypto port, and no network. */
function context(): unknown {
	return {
		http: {
			send() {
				throw new Error('these specs make no request');
			}
		},
		settings: { string: () => '', boolean: () => false, list: () => [] },
		text: {
			encode: (value: string) => new TextEncoder().encode(value),
			decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		},
		bytes: {
			toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
			fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64')),
			toHex: (bytes: Uint8Array) => Buffer.from(bytes).toString('hex'),
			fromHex: (value: string) => new Uint8Array(Buffer.from(value, 'hex'))
		},
		crypto: {
			randomBytes: (length: number) => new Uint8Array(randomBytes(length)),
			async aes(
				direction: 'encrypt' | 'decrypt',
				mode: string,
				key: Uint8Array,
				iv: Uint8Array,
				data: Uint8Array,
				tagBits?: number
			) {
				const imported = await webcrypto.subtle.importKey('raw', key, { name: mode }, false, [
					'encrypt',
					'decrypt'
				]);
				const algorithm =
					mode === 'AES-GCM' ? { name: mode, iv, tagLength: tagBits ?? 128 } : { name: mode, iv };
				const out =
					direction === 'encrypt'
						? await webcrypto.subtle.encrypt(algorithm, imported, data)
						: await webcrypto.subtle.decrypt(algorithm, imported, data);
				return new Uint8Array(out);
			}
		}
	};
}

/**
 * Runs `body` inside a source's `search`, and answers what it assigned to
 * `probe`. `body` is the text of an async function with `probe` in scope.
 */
async function probe(body: string): Promise<unknown> {
	const script = `
class DefaultExtension extends MProvider {
  async search(query, page, filters) {
    const probe = {};
    ${body}
    globalThis.__mangayomiProbe = probe;
    return { list: [], hasNextPage: false };
  }
}
`;
	const directory = await mkdtemp(join(tmpdir(), 'mangayomi-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		mangayomiEntrypoint({
			pluginId: 'test.mangayomi',
			script,
			source: { baseUrl: 'https://example.invalid', lang: 'en' }
		})
	);
	const loaded = (await import(`file://${file}`)) as {
		default: { searchCatalog(q: string, p: number, ctx: unknown): Promise<unknown> };
	};
	await loaded.default.searchCatalog('q', 1, context());
	return (globalThis as Record<string, unknown>)['__mangayomiProbe'];
}

describe('the string helpers, as the format itself defines them', () => {
	it('leaves the whole string when the delimiter is not there', async () => {
		const out = await probe(`
      probe.after = 'no-query'.substringAfter('?id=');
      probe.before = 'no-query'.substringBefore('?');
      probe.afterLast = 'no-query'.substringAfterLast('/');
      probe.beforeLast = 'no-query'.substringBeforeLast('/');
    `);
		// Upstream: `if (startIndex === -1) return this.substring(0);`, and
		// `split(pattern).pop()` of a string with no delimiter is the string.
		expect(out).toEqual({
			after: 'no-query',
			before: 'no-query',
			afterLast: 'no-query',
			beforeLast: 'no-query'
		});
	});

	it('cuts at the first or last occurrence when there is one', async () => {
		const out = await probe(`
      const s = 'a/b/c';
      probe.after = s.substringAfter('/');
      probe.before = s.substringBefore('/');
      probe.afterLast = s.substringAfterLast('/');
      probe.beforeLast = s.substringBeforeLast('/');
    `);
		expect(out).toEqual({ after: 'b/c', before: 'a', afterLast: 'c', beforeLast: 'a/b' });
	});

	it('keeps split().pop() for an empty delimiter, as upstream wrote it', async () => {
		// The one input where lastIndexOf and split disagree. Upstream's body is
		// the split, which answers the last character.
		const out = await probe(`probe.value = 'abc'.substringAfterLast('');`);
		expect(out).toEqual({ value: 'c' });
	});

	it('answers substringBetween with nothing when either side is missing', async () => {
		// Not the composition of the other two any more: with the whole-string
		// rule, composing them would hand back the input.
		const out = await probe(`
      probe.both = 'x[inner]y'.substringBetween('[', ']');
      probe.noLeft = 'inner]y'.substringBetween('[', ']');
      probe.noRight = 'x[inner'.substringBetween('[', ']');
    `);
		expect(out).toEqual({ both: 'inner', noLeft: '', noRight: '' });
	});
});
