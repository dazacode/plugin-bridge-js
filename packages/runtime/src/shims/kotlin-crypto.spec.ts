/**
 * `ctx.crypto`, from the Kotlin that asks for it to the bytes that come back.
 *
 * ## Why this file goes all the way through
 *
 * The crypto surface is the one capability whose two halves cannot be checked
 * apart. `emit.spec.ts` proves the emitter *translates* `cipher.doFinal(bytes)`
 * and `kotlin-runtime.spec.ts` proves the runtime *has* a `Cipher` — and both
 * would still pass if the emitter forgot the `await`, because a Promise is a
 * perfectly good object right up until somebody reads bytes off it. So each
 * test here compiles a Kotlin snippet, evaluates the emitted module against the
 * real runtime source and a real WebCrypto, and asserts the **value**: a
 * round-trip that comes back equal to what went in, a digest that matches a
 * published vector, a signature that verifies.
 *
 * The host is this spec's own — vitest on Node — and `CRYPTO` is the same
 * module `sandbox.worker.ts` puts on `ctx`, not a second implementation of it.
 * A stub would prove the two halves agree with the stub.
 *
 * ## What it deliberately also asserts
 *
 * Refusals. AES-ECB, DES and raw RSA have no WebCrypto equivalent, and the one
 * outcome worse than refusing them is answering with a neighbouring mode: an
 * extension that believes it is doing ECB and is in fact doing CBC decrypts to
 * rubbish and reports nothing. So the tests that prove a refusal happens, and
 * that the message names the algorithm the author wrote, are load-bearing.
 *
 * Every fixture is Kotlin written for this test; no source is named anywhere
 * (AGENTS.md rule 9).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { emitKotlin } from '@plugin-bridge/core/kotlin/emit';
import { loadKotlinGrammar, type KotlinParser } from '@plugin-bridge/core/kotlin/grammar';
import { CRYPTO } from '@plugin-bridge/host/crypto';
import { JS_RUNTIME } from './js-runtime';
import { kotlinRuntime } from './kotlin-runtime';

/** The vendored parser artefacts, read the way this host reads a file. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(
			fileURLToPath(new URL(`../../../core/src/kotlin/vendor/${name}`, import.meta.url))
		)
	);
}

let parse: KotlinParser;

beforeAll(async () => {
	parse = await loadKotlinGrammar(vendorWasm);
}, 60_000);

/** The `ctx` a converted bundle is handed, with the real capability on it. */
function context() {
	return {
		text: {
			encode: (value: string) => new TextEncoder().encode(value),
			decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		},
		bytes: {
			toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
			fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
		},
		crypto: CRYPTO,
		log: { debug: () => undefined, warn: () => undefined }
	};
}

/** A fixture, one line per argument, so the line breaks are visible. */
function kt(...lines: string[]): string {
	return lines.join('\n');
}

/** A class body wrapped in the declaration every extension has. */
function inClass(...lines: string[]): string {
	return kt('class Demo : Source() {', ...lines, '}');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Compiles a fixture and returns an instance of its class, entered.
 *
 * The module is built the way a converted bundle is: the shared JavaScript
 * runtime first (it declares `__host`), then the Kotlin runtime (it declares
 * `__k` and the bundle-scope names), then the translation.
 */
async function instantiate(source: string): Promise<any> {
	const emission = emitKotlin(parse(source));
	expect(emission.fileRefusal).toBeNull();
	expect(emission.refusals).toEqual([]);

	const module = [
		JS_RUNTIME,
		kotlinRuntime(),
		emission.js,
		`export const make = function (ctx) { __enter(ctx); return new ${emission.className}(); };`
	].join('\n');
	const url = `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`;
	const loaded = (await import(/* @vite-ignore */ url)) as { make(ctx: unknown): any };
	return loaded.make(context());
}

/** The obstacle names a fixture is refused for. */
function refusalNames(source: string): string[] {
	const emission = emitKotlin(parse(source));
	return emission.refusals.flatMap((one) => one.obstacles.map((obstacle) => obstacle.kind));
}

/** A Kotlin ByteArray — signed numbers — as the unsigned bytes to compare. */
function unsigned(value: unknown): number[] {
	return Array.from(value as number[], (byte) => byte & 0xff);
}

function hex(value: unknown): string {
	return unsigned(value)
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/* ── AES ──────────────────────────────────────────────────────────────────── */

describe('javax.crypto.Cipher', () => {
	it('round-trips AES/CBC/PKCS5Padding through the emitted JavaScript', async () => {
		// The whole point of the capability in one fixture: what the Kotlin
		// encrypted, the Kotlin decrypts. Asserting the ciphertext against a
		// fixed vector would also pass if both halves were wrong the same way.
		const demo = await instantiate(
			inClass(
				'    fun key() = ByteArray(16)',
				'    fun iv() = ByteArray(16)',
				'    fun seal(text: String): ByteArray {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(), "AES"), IvParameterSpec(iv()))',
				'        return cipher.doFinal(text.toByteArray())',
				'    }',
				'    fun open(data: ByteArray): String {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(), "AES"), IvParameterSpec(iv()))',
				'        return String(cipher.doFinal(data))',
				'    }'
			)
		);

		const sealed = await demo.seal('the quick brown fox');

		// PKCS#5 pads to the block, so 19 bytes of plaintext is 32 of cipher —
		// which is also what says the padding was applied rather than skipped.
		expect(unsigned(sealed)).toHaveLength(32);
		expect(await demo.open(sealed)).toBe('the quick brown fox');
	});

	it('decrypts a vector a JVM produced, so the padding is the same padding', async () => {
		// A round trip proves the two halves agree with each other. This proves
		// they agree with the JCE: key, IV and ciphertext below are AES-128-CBC
		// with PKCS#5, and a build that padded differently answers rubbish here
		// rather than answering nothing.
		const demo = await instantiate(
			inClass(
				'    fun open(keyHex: String, ivHex: String, data: String): String {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        val key = SecretKeySpec(keyHex.decodeHex(), "AES")',
				'        cipher.init(Cipher.DECRYPT_MODE, key, IvParameterSpec(ivHex.decodeHex()))',
				'        return String(cipher.doFinal(Base64.decode(data, Base64.DEFAULT)))',
				'    }'
			)
		);

		const plain = await demo.open(
			'000102030405060708090a0b0c0d0e0f',
			'101112131415161718191a1b1c1d1e1f',
			'kzCT1QYThoIjeAR/UoElDg=='
		);

		expect(plain).toBe('portable');
	});

	it('round-trips AES/GCM/NoPadding, tag and all', async () => {
		const demo = await instantiate(
			inClass(
				'    fun key() = ByteArray(32)',
				'    fun nonce() = ByteArray(12)',
				'    fun seal(text: String): ByteArray {',
				'        val cipher = Cipher.getInstance("AES/GCM/NoPadding")',
				'        val spec = GCMParameterSpec(128, nonce())',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(), "AES"), spec)',
				'        return cipher.doFinal(text.toByteArray())',
				'    }',
				'    fun open(data: ByteArray): String {',
				'        val cipher = Cipher.getInstance("AES/GCM/NoPadding")',
				'        val spec = GCMParameterSpec(128, nonce())',
				'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(), "AES"), spec)',
				'        return String(cipher.doFinal(data))',
				'    }'
			)
		);

		const sealed = await demo.seal('attested');

		// GCM appends the 16-byte tag, which is what makes it authenticated and
		// what a build that quietly used CTR instead would be missing.
		expect(unsigned(sealed)).toHaveLength('attested'.length + 16);
		expect(await demo.open(sealed)).toBe('attested');
	});

	it('refuses a tampered GCM message rather than answering its plaintext', async () => {
		const demo = await instantiate(
			inClass(
				'    fun key() = ByteArray(32)',
				'    fun nonce() = ByteArray(12)',
				'    fun seal(text: String): ByteArray {',
				'        val cipher = Cipher.getInstance("AES/GCM/NoPadding")',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key(), "AES"), GCMParameterSpec(128, nonce()))',
				'        return cipher.doFinal(text.toByteArray())',
				'    }',
				'    fun open(data: ByteArray): String {',
				'        val cipher = Cipher.getInstance("AES/GCM/NoPadding")',
				'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(), "AES"), GCMParameterSpec(128, nonce()))',
				'        return String(cipher.doFinal(data))',
				'    }'
			)
		);

		const sealed = (await demo.seal('attested')) as number[];
		sealed[0] ^= 0x01;

		await expect(demo.open(sealed)).rejects.toThrow();
	});
});

/* ── digests and MACs ─────────────────────────────────────────────────────── */

describe('java.security.MessageDigest and javax.crypto.Mac', () => {
	it('answers the published SHA-256 of "abc"', async () => {
		const demo = await instantiate(
			inClass(
				'    fun hash(text: String): String {',
				'        return MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).toHexString()',
				'    }'
			)
		);

		// FIPS 180-4's own worked example.
		expect(await demo.hash('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('answers RFC 4231 case 1 for HmacSHA256', async () => {
		const demo = await instantiate(
			inClass(
				'    fun tag(keyHex: String, text: String): String {',
				'        val mac = Mac.getInstance("HmacSHA256")',
				'        mac.init(SecretKeySpec(keyHex.decodeHex(), "HmacSHA256"))',
				'        return mac.doFinal(text.toByteArray()).toHexString()',
				'    }'
			)
		);

		expect(await demo.tag('0b'.repeat(20), 'Hi There')).toBe(
			'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
		);
	});

	it('accumulates Mac.update, whose JCE form really does return nothing', async () => {
		// Buffering is exact here and is NOT exact for Cipher.update, which
		// answers the blocks completed so far — hence the refusal below.
		const demo = await instantiate(
			inClass(
				'    fun tag(keyHex: String): String {',
				'        val mac = Mac.getInstance("HmacSHA256")',
				'        mac.init(SecretKeySpec(keyHex.decodeHex(), "HmacSHA256"))',
				'        mac.update("Hi ".toByteArray())',
				'        return mac.doFinal("There".toByteArray()).toHexString()',
				'    }'
			)
		);

		expect(await demo.tag('0b'.repeat(20))).toBe(
			'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7'
		);
	});

	it('refuses a streaming Cipher.update rather than buffering it', async () => {
		const demo = await instantiate(
			inClass(
				'    fun half(data: ByteArray): ByteArray {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(ByteArray(16), "AES"), IvParameterSpec(ByteArray(16)))',
				'        return cipher.update(data)',
				'    }'
			)
		);

		expect(() => demo.half([1, 2, 3])).toThrow(/Cipher\.update/);
	});
});

/* ── EC keys and signatures ───────────────────────────────────────────────── */

describe('java.security.KeyPairGenerator and Signature', () => {
	it('generates a P-256 pair whose JWK has the shape a JWK has', async () => {
		const demo = await instantiate(
			inClass(
				'    fun jwk(): List<String> {',
				'        val generator = KeyPairGenerator.getInstance("EC")',
				'        generator.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())',
				'        val pair = generator.generateKeyPair()',
				'        val key = pair.public',
				'        return listOf(key.kty, key.crv, key.x, key.y)',
				'    }'
			)
		);

		const [kty, crv, x, y] = (await demo.jwk()) as string[];

		expect(kty).toBe('EC');
		expect(crv).toBe('P-256');
		// base64url of a 32-byte coordinate: 43 characters, unpadded, and none
		// of `+`, `/` or `=`. A JWK carrying standard base64 is rejected by
		// every peer that reads one.
		for (const coordinate of [x, y]) {
			expect(coordinate).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
	});

	it('signs and verifies, and the signature is the DER a JVM would emit', async () => {
		const demo = await instantiate(
			inClass(
				'    fun pair() = KeyPairGenerator.getInstance("EC").let {',
				'        it.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())',
				'        it.generateKeyPair()',
				'    }',
				'    fun signed(text: String): ByteArray {',
				'        val signature = Signature.getInstance("SHA256withECDSA")',
				'        val keys = pair()',
				'        signature.initSign(keys.private)',
				'        signature.update(text.toByteArray())',
				'        val out = signature.sign()',
				'        val check = Signature.getInstance("SHA256withECDSA")',
				'        check.initVerify(keys.public)',
				'        check.update(text.toByteArray())',
				'        return if (check.verify(out)) out else ByteArray(0)',
				'    }'
			)
		);

		const signature = unsigned(await demo.signed('a nonce from the far end'));

		// Non-empty means `verify` said yes. The rest is the JCE's encoding:
		// a DER SEQUENCE of two INTEGERs, which is what a peer expecting a JVM
		// signature parses — WebCrypto's own raw `r ‖ s` would be 64 bytes with
		// no tag at all and would simply fail to verify at the far end.
		expect(signature.length).toBeGreaterThan(0);
		expect(signature[0]).toBe(0x30);
		expect(signature[1]).toBe(signature.length - 2);
		expect(signature[2]).toBe(0x02);
	});

	it('answers false for a signature over different bytes', async () => {
		const demo = await instantiate(
			inClass(
				'    fun tampered(): Boolean {',
				'        val generator = KeyPairGenerator.getInstance("EC")',
				'        generator.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())',
				'        val keys = generator.generateKeyPair()',
				'        val signer = Signature.getInstance("SHA256withECDSA")',
				'        signer.initSign(keys.private)',
				'        signer.update("one".toByteArray())',
				'        val out = signer.sign()',
				'        val check = Signature.getInstance("SHA256withECDSA")',
				'        check.initVerify(keys.public)',
				'        check.update("two".toByteArray())',
				'        return check.verify(out)',
				'    }'
			)
		);

		expect(await demo.tampered()).toBe(false);
	});

	it('answers the affine coordinate the hand-assembled JWK is built from', async () => {
		// The Kotlin in the wild does not call `exportKey`; it reads
		// `publicKey.w.affineX`, calls `toByteArray()` and pads the result to
		// the coordinate width. Java's `toByteArray` is two's complement, so a
		// coordinate whose top bit is set carries a leading zero — and the
		// padding code downstream is written around exactly that byte.
		const demo = await instantiate(
			inClass(
				'    fun coordinates(): List<Int> {',
				'        val generator = KeyPairGenerator.getInstance("EC")',
				'        generator.initialize(ECGenParameterSpec("secp256r1"), SecureRandom())',
				'        val key = generator.generateKeyPair().public',
				'        val x = key.w.affineX.toByteArray()',
				'        val y = key.w.affineY.toByteArray()',
				'        return listOf(x.size, y.size)',
				'    }'
			)
		);

		for (const size of (await demo.coordinates()) as number[]) {
			// 32 bytes, or 33 when the leading zero is there, or fewer on the
			// rare coordinate with leading zero bytes of its own.
			expect(size).toBeGreaterThan(28);
			expect(size).toBeLessThanOrEqual(33);
		}
	});
});

/* ── randomness ───────────────────────────────────────────────────────────── */

describe('java.security.SecureRandom', () => {
	it('fills the array it was handed, in place, as Kotlin does', async () => {
		const demo = await instantiate(
			inClass(
				'    fun fingerprint(): String {',
				'        val bytes = ByteArray(16)',
				'        SecureRandom().nextBytes(bytes)',
				'        return bytes.toHexString()',
				'    }'
			)
		);

		const first = (await demo.fingerprint()) as string;
		const second = (await demo.fingerprint()) as string;

		expect(first).toHaveLength(32);
		// Two draws from a real generator are not equal. `Random` next door is
		// `Math.random` and is a separate name precisely so that this one can
		// promise something.
		expect(first).not.toBe(second);
	});
});

/* ── RC4 ──────────────────────────────────────────────────────────────────── */

describe('RC4, which the runtime computes itself', () => {
	// The idiom as the catalogue writes it, `cipher.parameters` and all: RC4
	// has none, the JCE answers null, and init is handed that null back.
	const rc4 = () =>
		instantiate(
			inClass(
				'    fun run(keyHex: String, data: ByteArray, mode: Int): ByteArray {',
				'        val key = SecretKeySpec(keyHex.decodeHex(), "RC4")',
				'        val cipher = Cipher.getInstance("RC4")',
				'        cipher.init(mode, key, cipher.parameters)',
				'        return cipher.doFinal(data)',
				'    }',
				'    fun text(key: String, plain: String): ByteArray {',
				'        val cipher = Cipher.getInstance("ARCFOUR")',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key.toByteArray(), "ARCFOUR"), cipher.getParameters())',
				'        return cipher.doFinal(plain.toByteArray())',
				'    }'
			)
		);

	it('produces RFC 6229’s keystream for its 40-bit key', async () => {
		// Encrypting zeros yields the keystream itself; offsets 0 and 16 of the
		// vector for key 0x0102030405.
		const demo = await rc4();
		const stream = await demo.run('0102030405', new Array(32).fill(0), 1);

		expect(hex(stream)).toBe(
			'b2396305f03dc027ccc3524a0a1118a8' + '6982944f18fc82d589c403a47a0d0919'
		);
	});

	it('matches the classic plaintext vectors and decrypts what it encrypts', async () => {
		const demo = await rc4();

		// The textbook `Key`/`Plaintext` vector is three bytes of key, which
		// SunJCE rejects (40 bits is its floor), and so does this.
		await expect(demo.text('Key', 'Plaintext')).rejects.toThrow(/3-byte key/);
		expect(hex(await demo.text('Secret', 'Attack at dawn'))).toBe('45a01f645fc35b383552544b9bf5');

		// Decryption is the same XOR, and each doFinal starts from the key's
		// initial state, so the second call is not a continuation of the first.
		const sealed = await demo.text('Secret', 'Attack at dawn');
		const opened = await demo.run(Buffer.from('Secret').toString('hex'), sealed, 2);
		expect(Buffer.from(unsigned(opened)).toString()).toBe('Attack at dawn');
	});
});

/* ── what still refuses ───────────────────────────────────────────────────── */

describe('the algorithms that have no WebCrypto equivalent', () => {
	it.each([
		['AES-ECB', 'AES/ECB/PKCS5Padding', 'the `AES/ECB/PKCS5Padding` cipher'],
		// A bare `"AES"` is ECB by the JCE's own provider default, so it has to
		// refuse for the same reason the explicit spelling does.
		['a bare AES', 'AES', 'the `AES` cipher'],
		['DES', 'DES/CBC/PKCS5Padding', 'the `DES/CBC/PKCS5Padding` cipher'],
		['triple DES', 'DESede/CBC/PKCS5Padding', 'the `DESede/CBC/PKCS5Padding` cipher'],
		['RC4 with a mode', 'RC4/CBC/NoPadding', 'the `RC4/CBC/NoPadding` cipher'],
		['raw RSA', 'RSA/ECB/NoPadding', 'the `RSA/ECB/NoPadding` cipher'],
		['CBC without padding', 'AES/CBC/NoPadding', 'the `AES/CBC/NoPadding` cipher'],
		['CTR', 'AES/CTR/NoPadding', 'the `AES/CTR/NoPadding` cipher']
	])('refuses %s by the name the author wrote', (_label, transformation, expected) => {
		const source = inClass(
			'    fun open(data: ByteArray): ByteArray {',
			`        val cipher = Cipher.getInstance("${transformation}")`,
			'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(ByteArray(16), "AES"), IvParameterSpec(ByteArray(16)))',
			'        return cipher.doFinal(data)',
			'    }'
		);

		expect(refusalNames(source)).toContain(expected);
	});

	it('refuses an RSA signature, which is not the ECDSA it resembles', () => {
		const source = inClass(
			'    fun sign(data: ByteArray): ByteArray {',
			'        val signature = Signature.getInstance("SHA256withRSA")',
			'        signature.update(data)',
			'        return signature.sign()',
			'    }'
		);

		expect(refusalNames(source)).toContain('the `SHA256withRSA` signature');
	});

	it('refuses a curve one character away from a curve it has', () => {
		const source = inClass(
			'    fun keys() = KeyPairGenerator.getInstance("EC").also {',
			'        it.initialize(ECGenParameterSpec("secp256k1"), SecureRandom())',
			'    }'
		);

		expect(refusalNames(source)).toContain('the `secp256k1` curve');
	});

	it('still refuses the derivations and key stores, as javax.crypto', () => {
		const source = inClass('    fun key() = KeyGenerator.getInstance("AES").generateKey()');

		expect(refusalNames(source)).toContain('javax.crypto');
	});

	it('refuses a transformation it cannot read at conversion, at run time', async () => {
		// A transformation assembled from a variable has no string literal for
		// the scanner to read, so the refusal has to be the runtime's. It throws
		// rather than answering null — null is the JCE's own "no provider" signal
		// and the caller is written to carry on past it — but it is an ordinary
		// Error, so a `runCatching` around `getInstance` can still swallow it.
		// This is the backstop; the conversion-time refusal above is the one that
		// actually stops a build.
		const demo = await instantiate(
			inClass(
				'    fun open(name: String, data: ByteArray): ByteArray {',
				'        val cipher = Cipher.getInstance(name)',
				'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(ByteArray(16), "AES"), IvParameterSpec(ByteArray(16)))',
				'        return cipher.doFinal(data)',
				'    }'
			)
		);

		await expect(demo.open('AES/ECB/PKCS5Padding', [])).rejects.toThrow(/AES\/ECB\/PKCS5Padding/);
	});
});

/* ── the await ────────────────────────────────────────────────────────────── */

describe('the await the asynchrony forces', () => {
	it('makes a member that decrypts async, and awaits it from its caller', async () => {
		// The failure this prevents: `String(promise)` is `[object Promise]`,
		// which is a plausible string that travels a long way before anything
		// notices. `blockingMembers` carries the mark outward from `doFinal`,
		// so `label` here is awaited by `describe` without either saying
		// `suspend` in the Kotlin.
		const demo = await instantiate(
			inClass(
				'    fun label(data: ByteArray): String {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(ByteArray(16), "AES"), IvParameterSpec(ByteArray(16)))',
				'        return String(cipher.doFinal(data))',
				'    }',
				'    fun describe(data: ByteArray) = "title: " + label(data)'
			)
		);

		const cipher = await instantiate(
			inClass(
				'    fun seal(text: String): ByteArray {',
				'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
				'        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(ByteArray(16), "AES"), IvParameterSpec(ByteArray(16)))',
				'        return cipher.doFinal(text.toByteArray())',
				'    }'
			)
		);

		const sealed = await cipher.seal('episode 1');

		expect(await demo.describe(sealed)).toBe('title: episode 1');
	});
});

/* ── the vector above, produced ───────────────────────────────────────────── */

describe('the JCE vector this file decrypts', () => {
	it('is what WebCrypto produces for the same key, IV and plaintext', async () => {
		// Keeps the fixed vector honest: if the ciphertext above ever stops
		// being AES-128-CBC/PKCS#5 over these inputs, this fails next to it
		// rather than leaving a magic string nobody can re-derive.
		const key = new Uint8Array(16);
		for (let i = 0; i < 16; i += 1) key[i] = i;
		const iv = new Uint8Array(16);
		for (let i = 0; i < 16; i += 1) iv[i] = 0x10 + i;

		const out = await CRYPTO.aes(
			'encrypt',
			'AES-CBC',
			key,
			iv,
			new TextEncoder().encode('portable')
		);

		expect(Buffer.from(out).toString('base64')).toBe('kzCT1QYThoIjeAR/UoElDg==');
		expect(hex(Array.from(out))).toHaveLength(32);
	});
});

describe('the stdlib the crypto code slices key material with', () => {
	it('copies a range out of a byte array, and refuses one that runs off the end', async () => {
		// `copyOfRange` is plain Kotlin stdlib rather than a capability, and it
		// is tested here because it is what this code slices key material with:
		// three extensions reached `ctx.crypto` and then stopped on it, which is
		// the shape of a capability that was granted one call short of useful.
		const demo = await instantiate(
			inClass(
				'    fun middle(bytes: ByteArray): ByteArray = bytes.copyOfRange(1, 3)',
				'    fun past(bytes: ByteArray): ByteArray = bytes.copyOfRange(0, 99)'
			)
		);

		const source = new Uint8Array([9, 8, 7, 6]);
		expect(unsigned(demo.middle(source))).toEqual([8, 7]);

		// A copy, not a view: writing into the result must not reach the source.
		const copy = demo.middle(source);
		copy[0] = 0;
		expect(source[1]).toBe(8);

		// Kotlin throws; JavaScript's `slice` would clamp, and a clamped copy is
		// a short key that decrypts to rubbish with nothing reporting it.
		expect(() => demo.past(source)).toThrow(/copyOfRange/);
	});
});
