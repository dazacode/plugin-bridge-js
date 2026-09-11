/**
 * The browser half of the security boundary, tested against the same hostile
 * archives as `test/core/plugins/plugin_archive_test.dart`.
 *
 * Deliberately the *same* cases. Two implementations of one security check is
 * two chances to leave a gap, and the only way that stays true is if both are
 * held to the same list — a browser client that accepted a zip-slip entry the
 * Flutter client refused would be a hole nobody would think to look for,
 * because "we tested that" would be true of the other one.
 *
 * Archives are built here rather than read from disk, so the suite is
 * self-contained and a malicious fixture never touches a real filesystem.
 */

import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { openPluginArchive, PluginArchiveError, isSafeEntryName } from './archive';

const encoder = new TextEncoder();

/** Builds an archive the way `yorozo package` does, so the reader meets the real format. */
async function buildArchive(
	options: {
		manifest?: Record<string, unknown>;
		extraFiles?: Record<string, Uint8Array>;
		corruptFile?: string;
		forceDigest?: string;
		omit?: string[];
		signWith?: CryptoKeyPair;
	} = {}
): Promise<Uint8Array> {
	const manifest = options.manifest ?? {
		schemaVersion: 1,
		id: 'com.example.plugins.demo',
		name: 'Demo',
		version: '1.0.0',
		entrypoint: 'demo',
		permissions: ['network'],
		network: { hosts: ['api.example.com'] }
	};

	const files = new Map<string, Uint8Array>([
		['plugin.json', encoder.encode(JSON.stringify(manifest))],
		['payload/demo.js', encoder.encode('export default {};\n')],
		['licenses/LICENSE', encoder.encode('Apache-2.0\n')],
		...Object.entries(options.extraFiles ?? {})
	]);

	const hashes: Record<string, string> = {};
	for (const path of [...files.keys()].sort()) hashes[path] = await sha256Hex(files.get(path)!);
	const canonical = Object.keys(hashes)
		.sort()
		.map((path) => `${path}:${hashes[path]}`)
		.join('\n');
	const digest = options.forceDigest ?? (await sha256Hex(encoder.encode(canonical)));

	files.set(
		'integrity.json',
		encoder.encode(JSON.stringify({ algorithm: 'sha256', files: hashes, digest }))
	);

	if (options.signWith === undefined) {
		files.set('signature.json', encoder.encode(JSON.stringify({ signed: false })));
	} else {
		const signature = await crypto.subtle.sign(
			'Ed25519',
			options.signWith.privateKey,
			fromHex(digest) as BufferSource
		);
		files.set(
			'signature.json',
			encoder.encode(
				JSON.stringify({
					signed: true,
					algorithm: 'ed25519',
					digest,
					signature: toBase64(new Uint8Array(signature))
				})
			)
		);
	}

	// Applied last so the corruption survives the integrity record built above,
	// which is exactly the situation the reader has to catch.
	if (options.corruptFile !== undefined) {
		files.set(options.corruptFile, encoder.encode('tampered'));
	}
	for (const path of options.omit ?? []) files.delete(path);

	return writeZip(files);
}

/** The pinned form an index carries: base64 SPKI. */
async function spkiOf(pair: CryptoKeyPair): Promise<string> {
	return toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
}

async function newKeyPair(): Promise<CryptoKeyPair> {
	return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify'
	])) as CryptoKeyPair;
}

describe('a well-formed archive', () => {
	it('opens, and exposes what a consent screen needs', async () => {
		const bundle = await openPluginArchive(await buildArchive());

		expect(bundle.id).toBe('com.example.plugins.demo');
		expect(bundle.version).toBe('1.0.0');
		expect(bundle.permissions).toEqual(['network']);
		expect(bundle.hosts).toEqual(['api.example.com']);
		expect(bundle.entrypointSource).toContain('export default');
		expect(bundle.signedBy).toBeNull();
	});
});

describe('integrity', () => {
	it('refuses a tampered file', async () => {
		// The bytes that run must be the bytes that were packaged. This is what
		// makes a compromised mirror useless.
		await expect(
			openPluginArchive(await buildArchive({ corruptFile: 'payload/demo.js' }))
		).rejects.toMatchObject({ rejection: 'corruptFile' });
	});

	it('refuses a rewritten digest', async () => {
		// Recomputing rather than trusting the field is what stops a tampered
		// archive from simply agreeing with itself.
		await expect(
			openPluginArchive(await buildArchive({ forceDigest: 'deadbeef' }))
		).rejects.toMatchObject({ rejection: 'corruptDigest' });
	});

	it('refuses a missing required member', async () => {
		await expect(
			openPluginArchive(await buildArchive({ omit: ['signature.json'] }))
		).rejects.toMatchObject({ rejection: 'incomplete' });
	});

	it('refuses an entrypoint the archive does not carry', async () => {
		await expect(
			openPluginArchive(await buildArchive({ omit: ['payload/demo.js'] }))
		).rejects.toBeInstanceOf(PluginArchiveError);
	});
});

describe('unsafe paths', () => {
	// Zip slip. Names are checked raw and never normalised, because "normalise
	// then check" is how every one of these bugs was written.
	for (const name of [
		'../escape.js',
		'a/../../escape.js',
		'/etc/passwd',
		'..\\windows.js',
		'C:\\windows.js',
		'./hidden.js'
	]) {
		it(`refuses "${name}"`, async () => {
			await expect(
				openPluginArchive(await buildArchive({ extraFiles: { [name]: encoder.encode('x') } }))
			).rejects.toMatchObject({ rejection: 'unsafePath' });
		});
	}

	it('agrees with the Dart reader on what is safe', () => {
		expect(isSafeEntryName('payload/demo.js')).toBe(true);
		expect(isSafeEntryName('licenses/LICENSE')).toBe(true);
		expect(isSafeEntryName('a\u0000b')).toBe(false);
		expect(isSafeEntryName('')).toBe(false);
	});
});

describe('size limits', () => {
	it('refuses an entry larger than a plugin may be', async () => {
		// A zip bomb is small on disk and enormous in memory, so the cap is on
		// the declared inflated size and is applied before inflating.
		await expect(
			openPluginArchive(
				await buildArchive({ extraFiles: { 'assets/big.bin': new Uint8Array(9 * 1024 * 1024) } })
			)
		).rejects.toMatchObject({ rejection: 'tooLarge' });
	});
});

describe('signatures', () => {
	it('verifies a correctly signed archive against the pinned key', async () => {
		const pair = await newKeyPair();
		const bundle = await openPluginArchive(await buildArchive({ signWith: pair }), {
			pinnedKey: await spkiOf(pair)
		});
		expect(bundle.signedBy).toBe(await spkiOf(pair));
	});

	it('refuses a different key', async () => {
		// A rotation and a compromise look identical, so this is an error, not
		// a prompt with a default.
		const pair = await newKeyPair();
		const other = await newKeyPair();
		await expect(
			openPluginArchive(await buildArchive({ signWith: other }), {
				pinnedKey: await spkiOf(pair)
			})
		).rejects.toMatchObject({ rejection: 'badSignature' });
	});

	it('refuses an unsigned archive from a signed repository', async () => {
		const pair = await newKeyPair();
		await expect(
			openPluginArchive(await buildArchive(), { pinnedKey: await spkiOf(pair) })
		).rejects.toMatchObject({ rejection: 'unsigned' });
	});

	it('still opens an unsigned archive from an unpinned repository', async () => {
		// A legitimate choice for a repository somebody runs themselves.
		// Refusing outright would make self-hosting impossible.
		expect((await openPluginArchive(await buildArchive())).signedBy).toBeNull();
	});
});

describe('the archive is held to what the index claimed', () => {
	// The consent screen renders the INDEX's claims, because it runs before the
	// download. Without this, an index could ask for one thing and ship another.
	const truthful = {
		id: 'com.example.plugins.demo',
		version: '1.0.0',
		permissions: ['network'],
		hosts: ['api.example.com']
	};

	it('passes a truthful index', async () => {
		const bytes = await buildArchive();
		const bundle = await openPluginArchive(bytes, {
			expected: { ...truthful, sha256: await sha256Hex(bytes) }
		});
		expect(bundle.id).toBe(truthful.id);
	});

	it('refuses a download that is not what the index hashed', async () => {
		await expect(
			openPluginArchive(await buildArchive(), {
				expected: { ...truthful, sha256: 'aa'.repeat(32) }
			})
		).rejects.toMatchObject({ rejection: 'hashMismatch' });
	});

	it('refuses a plugin asking for more permissions than listed', async () => {
		const bytes = await buildArchive({
			manifest: {
				schemaVersion: 1,
				id: 'com.example.plugins.demo',
				name: 'Demo',
				version: '1.0.0',
				entrypoint: 'demo',
				permissions: ['network', 'webview'],
				network: { hosts: ['api.example.com'] }
			}
		});
		await expect(
			openPluginArchive(bytes, { expected: { ...truthful, sha256: await sha256Hex(bytes) } })
		).rejects.toMatchObject({ rejection: 'manifestMismatch' });
	});

	it('refuses a plugin reaching hosts the index did not list', async () => {
		const bytes = await buildArchive({
			manifest: {
				schemaVersion: 1,
				id: 'com.example.plugins.demo',
				name: 'Demo',
				version: '1.0.0',
				entrypoint: 'demo',
				permissions: ['network'],
				network: { hosts: ['api.example.com', 'tracker.invalid'] }
			}
		});
		await expect(
			openPluginArchive(bytes, { expected: { ...truthful, sha256: await sha256Hex(bytes) } })
		).rejects.toThrowError(/tracker\.invalid/);
	});
});

describe('junk', () => {
	it('refuses a file that is not a zip, without crashing', async () => {
		await expect(
			openPluginArchive(encoder.encode('this is not a zip file at all'))
		).rejects.toMatchObject({ rejection: 'unreadable' });
	});
});

// ---- helpers ---------------------------------------------------------------

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

/** A ZIP writer matching `yorozo package`'s, so the reader is tested on the real shape. */
function writeZip(files: Map<string, Uint8Array>): Uint8Array {
	const entries = [...files].sort(([a], [b]) => (a < b ? -1 : 1));
	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const [path, content] of entries) {
		const name = encoder.encode(path);
		const crc = crc32(content);
		const deflated = new Uint8Array(deflateRawSync(content, { level: 9 }));
		const useDeflate = deflated.length < content.length;
		const stored = useDeflate ? deflated : content;
		const method = useDeflate ? 8 : 0;

		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true);
		local.setUint16(8, method, true);
		local.setUint32(14, crc, true);
		local.setUint32(18, stored.length, true);
		local.setUint32(22, content.length, true);
		local.setUint16(26, name.length, true);
		locals.push(new Uint8Array(local.buffer), name, stored);

		const central = new DataView(new ArrayBuffer(46));
		central.setUint32(0, 0x02014b50, true);
		central.setUint16(4, 20, true);
		central.setUint16(6, 20, true);
		central.setUint16(10, method, true);
		central.setUint32(16, crc, true);
		central.setUint32(20, stored.length, true);
		central.setUint32(24, content.length, true);
		central.setUint16(28, name.length, true);
		central.setUint32(42, offset, true);
		centrals.push(new Uint8Array(central.buffer), name);

		offset += 30 + name.length + stored.length;
	}

	const centralBytes = concat(centrals);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, centralBytes.length, true);
	end.setUint32(16, offset, true);

	return concat([...locals, centralBytes, new Uint8Array(end.buffer)]);
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Uint8Array): number {
	if (CRC_TABLE === null) {
		CRC_TABLE = new Uint32Array(256);
		for (let i = 0; i < 256; i += 1) {
			let value = i;
			for (let bit = 0; bit < 8; bit += 1) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			CRC_TABLE[i] = value >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
