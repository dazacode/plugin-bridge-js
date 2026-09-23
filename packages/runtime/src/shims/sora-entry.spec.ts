/**
 * The module wrapper, and the one property of it that is load-bearing.
 *
 * These modules are written for a runtime that evaluates them as a classic
 * script. Spliced into an ES module they get strict mode and no receiver, and a
 * bundled UMD library's `root.CryptoJS = factory()` throws before a single
 * request is made — five modules of one live library, on that one cause.
 */
import { webcrypto } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { soraEntrypoint } from './sora-entry';

/** Evaluates a generated entrypoint the way a sandbox would: as a module. */
async function load(script: string): Promise<Record<string, unknown>> {
	const directory = await mkdtemp(join(tmpdir(), 'sora-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		soraEntrypoint({
			pluginId: 'test.sora',
			script,
			baseUrl: 'https://example.invalid/',
			container: 'hls',
			softsub: false
		})
	);
	return (await import(`file://${file}`)) as Record<string, unknown>;
}

/** The header every UMD build opens with, reduced to the line that matters. */
const UMD = `
(function (root) {
  root.CryptoJS = { hashIt: function (s) { return 'hashed:' + s; } };
})(this);

function searchResults(html) { return JSON.stringify([{ title: CryptoJS.hashIt('x'), href: '/a' }]); }
function extractDetails() { return '[]'; }
function extractEpisodes() { return '[]'; }
function extractStreamUrl() { return ''; }
`;

describe('a module that expects a classic script', () => {
	it('loads, where an IIFE with no receiver threw on the first line', async () => {
		// The assertion is that this resolves at all. Before the receiver was
		// passed it rejected with "Cannot set properties of undefined (setting
		// 'CryptoJS')" — at load, which is why it cost five modules outright.
		await expect(load(UMD)).resolves.toBeDefined();
	});

	it('leaves the library reachable as a free variable afterwards', async () => {
		// The half a stand-in object would have lost: the library assigns onto
		// the receiver and the module's own code then reads it unqualified.
		const module = await load(UMD);
		const plugin = module['default'] as {
			searchCatalog: (q: string, p: number, ctx: unknown) => Promise<{ entries: unknown[] }>;
		};
		const found = await plugin.searchCatalog('x', 1, {
			http: { text: async () => '<html></html>' },
			log: { debug() {}, warn() {} }
		});
		expect(found.entries).toHaveLength(1);
		expect((found.entries[0] as { title: string }).title).toBe('hashed:x');
	});
});

/* ── what the host lends in place of the globals ─────────────────────────── */

/**
 * The host's crypto port, as \`packages/host/src/crypto.ts\` implements it, but
 * over node's WebCrypto taken by import: the drive below removes the global for
 * the bundle's sake, and the host — which is outside the sandbox — must keep it.
 */
const HOST_CRYPTO = {
	randomBytes: (length: number) => webcrypto.getRandomValues(new Uint8Array(length)),
	async aes(
		direction: 'encrypt' | 'decrypt',
		mode: string,
		key: Uint8Array,
		iv: Uint8Array,
		data: Uint8Array,
		tagBits?: number
	) {
		const imported = await webcrypto.subtle.importKey('raw', key, { name: mode }, false, [
			direction
		]);
		const algorithm =
			mode === 'AES-GCM' ? { name: mode, iv, tagLength: tagBits ?? 128 } : { name: mode, iv };
		return new Uint8Array(
			direction === 'encrypt'
				? await webcrypto.subtle.encrypt(algorithm, imported, data)
				: await webcrypto.subtle.decrypt(algorithm, imported, data)
		);
	},
	async hmac(hash: string, key: Uint8Array, data: Uint8Array) {
		const imported = await webcrypto.subtle.importKey('raw', key, { name: 'HMAC', hash }, false, [
			'sign'
		]);
		return new Uint8Array(await webcrypto.subtle.sign('HMAC', imported, data));
	}
};

interface Sent {
	url: string;
	request: Record<string, unknown>;
}

/** A context whose network answers `body` for every request and records each. */
function contextFor(body = '[]'): { ctx: unknown; sent: Sent[] } {
	const sent: Sent[] = [];
	const ctx = {
		http: {
			async send(url: string, request: Record<string, unknown>) {
				sent.push({ url, request });
				return {
					status: 200,
					url,
					headers: {},
					text: async () => body,
					json: async () => JSON.parse(body) as unknown
				};
			}
		},
		crypto: HOST_CRYPTO,
		log: { debug() {}, warn() {} }
	};
	return { ctx, sent };
}

/**
 * Runs `body` as the inside of an async `searchResults`, and answers what it
 * assigned to `probe` — or the error it threw.
 */
async function drive(body: string, context = contextFor()): Promise<unknown> {
	const module = await load(`
async function searchResults(keyword) {
  const probe = {};
  ${body}
  globalThis.__soraProbe = probe;
  return '[]';
}
`);
	const plugin = module['default'] as {
		searchCatalog: (q: string, p: number, ctx: unknown) => Promise<unknown>;
	};
	// The sandbox deletes the global before a bundle runs, and node has one, so
	// it is taken away here too — otherwise a module's free \`crypto\` would find
	// node's and these specs would pass with no façade at all.
	const ambient = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
	delete (globalThis as Record<string, unknown>)['crypto'];
	try {
		await plugin.searchCatalog('x', 1, context.ctx);
	} finally {
		if (ambient !== undefined) Object.defineProperty(globalThis, 'crypto', ambient);
	}
	return (globalThis as Record<string, unknown>)['__soraProbe'];
}

describe('crypto, as a WebCrypto-shaped façade over ctx.crypto', () => {
	it('digests the way WebCrypto does, for every hash it names', async () => {
		const out = (await drive(`
      const data = new Uint8Array([1, 2, 3, 250]);
      for (const name of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
        probe[name] = Array.from(new Uint8Array(await crypto.subtle.digest(name, data)));
      }
      probe.byObject = Array.from(new Uint8Array(await crypto.subtle.digest({ name: 'sha-256' }, data.buffer)));
    `)) as Record<string, number[]>;
		const data = new Uint8Array([1, 2, 3, 250]);
		for (const name of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
			const expected = new Uint8Array(await webcrypto.subtle.digest(name, data));
			expect(out[name], name).toEqual(Array.from(expected));
		}
		expect(out['byObject']).toEqual(out['SHA-256']);
	});

	it('decrypts AES-GCM and AES-CBC with a raw key, as WebCrypto would', async () => {
		const key = new Uint8Array(32).fill(9);
		const iv = new Uint8Array(12).fill(4);
		const cbcIv = new Uint8Array(16).fill(5);
		const gcmKey = await webcrypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
		const cbcKey = await webcrypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
		const plain = new TextEncoder().encode('a module payload');
		const gcm = new Uint8Array(
			await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, gcmKey, plain)
		);
		const cbc = new Uint8Array(
			await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv: cbcIv }, cbcKey, plain)
		);

		const out = await drive(`
      const raw = new Uint8Array(${JSON.stringify(Array.from(key))});
      const gcmKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
      const cbcKey = await crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
      const gcm = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(${JSON.stringify(Array.from(iv))}) }, gcmKey,
        new Uint8Array(${JSON.stringify(Array.from(gcm))}));
      const cbc = await crypto.subtle.decrypt(
        { name: 'AES-CBC', iv: new Uint8Array(${JSON.stringify(Array.from(cbcIv))}) }, cbcKey,
        new Uint8Array(${JSON.stringify(Array.from(cbc))}));
      probe.gcm = String.fromCharCode.apply(null, new Uint8Array(gcm));
      probe.cbc = String.fromCharCode.apply(null, new Uint8Array(cbc));
    `);
		expect(out).toEqual({ gcm: 'a module payload', cbc: 'a module payload' });
	});

	it('signs and verifies HMAC the way WebCrypto does', async () => {
		const key = new TextEncoder().encode('hmac key');
		const data = new TextEncoder().encode('signed text');
		const reference = await webcrypto.subtle.importKey(
			'raw',
			key,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const expected = Array.from(
			new Uint8Array(await webcrypto.subtle.sign('HMAC', reference, data))
		);

		const out = (await drive(`
      const key = await crypto.subtle.importKey('raw', new Uint8Array(${JSON.stringify(Array.from(key))}),
        { name: 'HMAC', hash: { name: 'SHA-256' } }, false, ['sign', 'verify']);
      const data = new Uint8Array(${JSON.stringify(Array.from(data))});
      const signature = await crypto.subtle.sign('HMAC', key, data);
      probe.signature = Array.from(new Uint8Array(signature));
      probe.good = await crypto.subtle.verify('HMAC', key, signature, data);
      probe.bad = await crypto.subtle.verify('HMAC', key, new Uint8Array(32), data);
    `)) as { signature: number[]; good: boolean; bad: boolean };
		expect(out.signature).toEqual(expected);
		expect(out.good).toBe(true);
		expect(out.bad).toBe(false);
	});

	it('fills random values and makes a version 4 uuid', async () => {
		const out = (await drive(`
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      probe.same = bytes instanceof Uint8Array;
      probe.nonZero = bytes.some(function (b) { return b !== 0; });
      probe.uuid = crypto.randomUUID();
    `)) as { same: boolean; nonZero: boolean; uuid: string };
		expect(out.same).toBe(true);
		expect(out.nonZero).toBe(true);
		expect(out.uuid).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
		);
	});

	it('refuses by name what the host does not lend, rather than mapping it', async () => {
		for (const call of [
			`await crypto.subtle.importKey('jwk', {}, 'AES-GCM', false, ['decrypt'])`,
			`await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-CTR', false, ['decrypt'])`,
			`await crypto.subtle.deriveKey({ name: 'PBKDF2' }, null, null, false, [])`,
			`await crypto.subtle.digest('MD5', new Uint8Array(1))`,
			`await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(1) },
         await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-GCM', false, ['decrypt']), new Uint8Array(32))`
		]) {
			await expect(drive(`${call};`), call).rejects.toThrow(/does not offer/);
		}
	});

	it('keeps WebCrypto’s own checks on a key’s algorithm and usages', async () => {
		await expect(
			drive(`
        const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-CBC', false, ['encrypt']);
        await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, new Uint8Array(16));
      `)
		).rejects.toThrow(/not imported for decrypt/);
		await expect(
			drive(`
        const key = await crypto.subtle.importKey('raw', new Uint8Array(16), 'AES-CBC', false, ['decrypt']);
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(16));
      `)
		).rejects.toThrow(/key is for AES-CBC/);
	});
});

describe('fetchv2, with all six of its arguments', () => {
	it('asks the host not to follow when the module passes redirect false', async () => {
		const context = contextFor();
		await drive(`await fetchv2('https://example.invalid/go', {}, 'GET', null, false);`, context);
		expect(context.sent[0].request['follow']).toBe(false);
	});

	it('follows by default and when the module passes true', async () => {
		const context = contextFor();
		await drive(
			`await fetchv2('https://example.invalid/a');
       await fetchv2('https://example.invalid/b', {}, 'GET', null, true, 'utf-8');`,
			context
		);
		expect(context.sent.map((one) => one.request['follow'])).toEqual([undefined, undefined]);
	});

	it("reads fetch's redirect: 'manual' as the same request", async () => {
		const context = contextFor();
		await drive(`await fetch('https://example.invalid/go', { redirect: 'manual' });`, context);
		expect(context.sent[0].request['follow']).toBe(false);
	});

	it('hands over an ASCII body in an ASCII-compatible charset, which is exact', async () => {
		const out = await drive(
			`probe.text = await (await fetchv2('https://example.invalid/a', {}, 'GET', null, true, 'windows-1251')).text();`,
			contextFor('plain ascii')
		);
		expect(out).toEqual({ text: 'plain ascii' });
	});

	it('refuses a non-ASCII body it was asked to read in another charset', async () => {
		// The host has already read it as UTF-8, so the text is not the text the
		// module asked for; handing it over anyway is the silent wrong answer.
		await expect(
			drive(
				`await (await fetchv2('https://example.invalid/a', {}, 'GET', null, true, 'iso-8859-1')).text();`,
				contextFor('café')
			)
		).rejects.toThrow(/iso-8859-1/);
	});

	it('refuses a charset that does not agree with ASCII before asking', async () => {
		const context = contextFor();
		await expect(
			drive(
				`await fetchv2('https://example.invalid/a', {}, 'GET', null, true, 'utf-16le');`,
				context
			)
		).rejects.toThrow(/utf-16le charset/);
		expect(context.sent).toHaveLength(0);
	});
});
