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
import { createCipheriv, randomBytes, webcrypto } from 'node:crypto';
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

/**
 * Produced once, by `openssl enc -aes-256-cbc -md md5 -S <salt> -base64`, which
 * is OpenSSL's own EVP_BytesToKey and so an oracle that shares no code with the
 * port. OpenSSL 3 omits the `Salted__` header when the salt is given on the
 * command line, so the spec puts it back; the plaintext carries non-ASCII so
 * the UTF-8 half is exercised too.
 */
const OPENSSL = {
	plaintext: 'Some plaintext, with \u00fcn\u00efcode',
	passphrase: 'secret-pass',
	salt: '0102030405060708',
	ciphertext: 'xVmEctHQHvg8a/IgFvRf1aN7+V1cKKHL2fESAbQwgmE='
};

/**
 * The same, with a passphrase whose one non-ASCII character is given to OpenSSL
 * as the single byte 0xE9. Upstream takes a passphrase's bytes as its code
 * units truncated to eight bits, not as UTF-8, and this is the vector that
 * tells the two apart: UTF-8 would make that character two bytes.
 */
const OPENSSL_LATIN1 = {
	plaintext: 'hello',
	passphrase: 'cl\u00e9',
	salt: '1112131415161718',
	ciphertext: 'a9yYePQQObc1EBnW/tmXSA=='
};

function salted(vector: { salt: string; ciphertext: string }): string {
	return Buffer.concat([
		Buffer.from('Salted__', 'latin1'),
		Buffer.from(vector.salt, 'hex'),
		Buffer.from(vector.ciphertext, 'base64')
	]).toString('base64');
}

describe('the CryptoJS passphrase helpers', () => {
	it('decrypts what OpenSSL encrypted, key and IV by EVP_BytesToKey', async () => {
		const out = await probe(`
      probe.value = await decryptAESCryptoJS(${JSON.stringify(salted(OPENSSL))}, ${JSON.stringify(OPENSSL.passphrase)});
    `);
		expect(out).toEqual({ value: OPENSSL.plaintext });
	});

	it('takes a passphrase as code units, the way upstream does, not as UTF-8', async () => {
		const out = await probe(`
      probe.value = await decryptAESCryptoJS(${JSON.stringify(salted(OPENSSL_LATIN1))}, ${JSON.stringify(OPENSSL_LATIN1.passphrase)});
    `);
		expect(out).toEqual({ value: 'hello' });
	});

	it('trims both sides before it starts, as upstream does', async () => {
		const out = await probe(`
      probe.value = await decryptAESCryptoJS(${JSON.stringify(' ' + salted(OPENSSL) + '\n')}, ' secret-pass ');
    `);
		expect(out).toEqual({ value: OPENSSL.plaintext });
	});

	it('encrypts to the Salted__ format with a salt drawn from 1 to 245', async () => {
		const out = (await probe(`
      probe.sealed = await encryptAESCryptoJS('  round trip  ', 'pw');
      probe.opened = await decryptAESCryptoJS(probe.sealed, 'pw');
    `)) as { sealed: string; opened: string };
		const bytes = Buffer.from(out.sealed, 'base64');
		expect(bytes.subarray(0, 8).toString('latin1')).toBe('Salted__');
		for (const byte of bytes.subarray(8, 16)) {
			expect(byte).toBeGreaterThanOrEqual(1);
			expect(byte).toBeLessThanOrEqual(245);
		}
		// The plaintext is trimmed before it is encrypted, so that is what comes back.
		expect(out.opened).toBe('round trip');
	});

	it('throws for a wrong passphrase, where upstream rethrows', async () => {
		await expect(
			probe(`probe.value = await decryptAESCryptoJS(${JSON.stringify(salted(OPENSSL))}, 'wrong');`)
		).rejects.toThrow();
	});
});

describe('cryptoHandler', () => {
	const key = 'k'.repeat(16);
	const iv = 'i'.repeat(16);
	const sealed = (() => {
		const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(iv));
		return Buffer.concat([cipher.update('payload \u00e9', 'utf8'), cipher.final()]).toString(
			'base64'
		);
	})();

	it('decrypts AES-CBC under the UTF-8 bytes of a key and IV string', async () => {
		const out = await probe(`
      probe.value = await cryptoHandler(${JSON.stringify(sealed)}, '${iv}', '${key}', false);
    `);
		expect(out).toEqual({ value: 'payload \u00e9' });
	});

	it('encrypts to the same base64 node produces', async () => {
		const out = await probe(`
      probe.value = await cryptoHandler('payload \u00e9', '${iv}', '${key}', true);
    `);
		expect(out).toEqual({ value: sealed });
	});

	it('hands the input back on any failure, which is what a source checks for', async () => {
		const out = await probe(`
      probe.badKey = await cryptoHandler(${JSON.stringify(sealed)}, '${iv}', 'short', false);
      probe.badIv = await cryptoHandler(${JSON.stringify(sealed)}, 'short', '${key}', false);
      probe.notBase64 = await cryptoHandler('%%%', '${iv}', '${key}', false);
    `);
		expect(out).toEqual({ badKey: sealed, badIv: sealed, notBase64: '%%%' });
	});

	it('names the missing await when a source uses the answer synchronously', async () => {
		// Upstream answers at once and the only real caller in its own catalogue
		// does not await. That source cannot run here, and it must say why
		// rather than parse "[object Promise]".
		await expect(
			probe(`probe.value = JSON.parse(cryptoHandler('x', '${iv}', '${key}', false));`)
		).rejects.toThrow(/without awaiting it/);
		await expect(
			probe(`probe.value = cryptoHandler('x', '${iv}', '${key}', false).length;`)
		).rejects.toThrow(/cryptoHandler\(\) without awaiting it/);
	});
});

describe('decryptAESGCM', () => {
	const key = Buffer.alloc(32, 7);
	const nonce = Buffer.alloc(12, 3);
	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const body = Buffer.concat([cipher.update('gcm text', 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();

	it('decrypts with the tag given beside the ciphertext', async () => {
		const out = await probe(`
      probe.value = await decryptAESGCM('${body.toString('base64')}', '${key.toString('hex')}', '${nonce.toString('hex')}', '${tag.toString('hex')}');
    `);
		expect(out).toEqual({ value: 'gcm text' });
	});

	it('decrypts with the tag already on the end, and no fourth argument', async () => {
		const joined = Buffer.concat([body, tag]).toString('base64');
		const out = await probe(`
      probe.value = await decryptAESGCM('${joined}', '${key.toString('hex')}', '${nonce.toString('hex')}');
    `);
		expect(out).toEqual({ value: 'gcm text' });
	});

	it('hands the ciphertext back when the tag does not verify', async () => {
		const out = await probe(`
      probe.value = await decryptAESGCM('${body.toString('base64')}', '${key.toString('hex')}', '${nonce.toString('hex')}', '${'00'.repeat(16)}');
    `);
		expect(out).toEqual({ value: body.toString('base64') });
	});
});

describe('deobfuscateJsPassword', () => {
	it('reads digits from brackets and a dot from parentheses', async () => {
		// Worked through upstream's loop by hand:
		//   [!+[]+!+[]+!+[]]  three '!+[]'          -> '3'
		//   (![]+[])          a parenthesis        -> '.', and the '[+[]]' right
		//                     after it is skipped
		//   [+!+[]]           one '!+[]'           -> '1'
		//   [+[]]             no '!+[]', one '+[]' -> '0'
		const out = await probe(`
      probe.value = deobfuscateJsPassword('[!+[]+!+[]+!+[]](![]+[])[+[]][+!+[]][+[]]');
    `);
		expect(out).toEqual({ value: '3.10' });
	});

	it("answers '-' for a bracket that is not a digit", async () => {
		const out = await probe(`probe.value = deobfuscateJsPassword('[[]]x[]');`);
		// '[[]]' has neither '!+[]' nor exactly one '+[]', and nor has '[]'.
		expect(out).toEqual({ value: '--' });
	});

	it('throws on an unbalanced bracket, where upstream indexes out of range', async () => {
		await expect(probe(`probe.value = deobfuscateJsPassword('[!+[]');`)).rejects.toThrow(
			/unbalanced/
		);
	});
});

describe('unpackJsAndCombine', () => {
	const packed = (payload: string, count: number, words: string) =>
		`eval(function(p,a,c,k,e,d){return p}('${payload}',36,${count},'${words}'.split('|'),0,{}))`;

	it('unpacks every packed block and joins them with a space', async () => {
		const script = packed('0 1=2;', 3, 'var|x|3') + '\n' + packed('0(1)', 2, 'log|y');
		const out = await probe(`probe.value = unpackJsAndCombine(${JSON.stringify(script)});`);
		expect(out).toEqual({ value: 'var x=3; log(y)' });
	});

	it('keeps a word whose dictionary entry is empty', async () => {
		const out = await probe(
			`probe.value = unpackJsAndCombine(${JSON.stringify(packed('0 1', 2, 'var|'))});`
		);
		expect(out).toEqual({ value: 'var 1' });
	});

	it('skips a block whose dictionary is not the claimed size', async () => {
		const out = await probe(
			`probe.value = unpackJsAndCombine(${JSON.stringify(packed('0 1', 5, 'var|x'))});`
		);
		expect(out).toEqual({ value: '' });
	});

	it("answers '' for a script with nothing packed in it", async () => {
		const out = await probe(`probe.value = unpackJsAndCombine('var plain = 1;');`);
		expect(out).toEqual({ value: '' });
	});
});

describe('the helpers that do not answer', () => {
	it('parseDates answers null, as the format host with no handler does', async () => {
		const out = await probe(`probe.value = parseDates(['2024-01-01'], 'yyyy-MM-dd', 'en');`);
		expect(out).toEqual({ value: null });
	});

	it('evaluateJavascriptViaWebview refuses by name', async () => {
		await expect(
			probe(`probe.value = await evaluateJavascriptViaWebview('https://example.invalid', {}, []);`)
		).rejects.toThrow(/no browser to lend/);
	});
});
