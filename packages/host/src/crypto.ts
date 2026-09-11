/**
 * `ctx.crypto` — the primitives a plugin may not reach for itself.
 *
 * A module of its own rather than a block inside `sandbox.worker.ts`, for two
 * reasons. It is the only part of `ctx` whose behaviour a test can assert
 * without standing up a worker, and a second host — the headless isolate of
 * `HOST.md` §8 — has to hand a plugin the same operations rather than a second
 * implementation of them.
 *
 * `ABI.md` §6 forbids a bundle the `crypto` global, and §2 says the surface a
 * plugin has is `ctx` and nothing else. That is a capability decision rather
 * than an engine one — every host in `HOST.md` §7 has WebCrypto — so this is
 * where WebCrypto is granted, named operation by named operation, in the same
 * place and for the same reason `ctx.text` and `ctx.bytes` are.
 *
 * ## Why the surface is this shape and not `subtle`
 *
 * Handing a plugin `crypto.subtle` would grant every algorithm the engine
 * happens to ship, including the ones whose *absence* is what the converter
 * refuses on. Each entry here is an operation somebody asked for, spelled in
 * WebCrypto's vocabulary; anything else is not reachable, and a caller naming
 * an algorithm outside the lists below gets a refusal that says which one.
 *
 * The translation from a foreign ecosystem's spelling — JCE transformation
 * strings, DER signatures, PKCS#5 padding — is **not** here. It belongs to
 * whichever runtime shim is doing the translating, because it is a fact about
 * that ecosystem rather than about this host.
 *
 * ## Asynchronous, unavoidably
 *
 * `crypto.subtle` is promise-returning and nothing here pretends otherwise.
 * The alternative — a synchronous hand-rolled cipher — is a reimplementation
 * of AES in a security-sensitive path, which is a worse trade than an `await`.
 */

/** A generated key pair, with its public half already exported as a JWK. */
export interface EcKeyPair {
	readonly curve: string;
	readonly publicJwk: Readonly<Record<string, string>>;
	readonly privateKey: CryptoKey;
	readonly publicKey: CryptoKey;
}

/** The hashes every host's WebCrypto implements, and no others. */
const HASHES: ReadonlySet<string> = new Set(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']);

/** The named curves WebCrypto's ECDSA offers. There are exactly three. */
const CURVES: ReadonlySet<string> = new Set(['P-256', 'P-384', 'P-521']);

/**
 * The AES modes with an authenticated or chained WebCrypto equivalent.
 *
 * ECB, CTR-with-a-reused-counter and the stream ciphers are absent on purpose:
 * WebCrypto has no ECB at all, and mapping one mode onto another would produce
 * a plugin that looks like it works and decrypts to rubbish.
 */
const AES_MODES: ReadonlySet<string> = new Set(['AES-CBC', 'AES-GCM']);

function named(what: string, value: string, allowed: ReadonlySet<string>): string {
	if (!allowed.has(value)) {
		throw new Error(
			`This host does not offer ${what} ${value}. It offers ${[...allowed].join(', ')}.`
		);
	}
	return value;
}

function aesKeyBytes(key: Uint8Array): Uint8Array {
	if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
		throw new Error(`An AES key is 16, 24 or 32 bytes; this one is ${key.length}.`);
	}
	return key;
}

/**
 * A caller's bytes, copied into a buffer this module owns.
 *
 * Two things at once. WebCrypto's `BufferSource` will not take a view onto a
 * `SharedArrayBuffer` and a plain `Uint8Array` might be one, which is the type
 * error; and a copy means the caller cannot mutate the plaintext out from under
 * an operation that has already started. Both point the same way, so the copy
 * is taken rather than the type asserted away.
 */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(bytes.length);
	out.set(bytes);
	return out;
}

export const CRYPTO = {
	/** `crypto.getRandomValues`, which is the one synchronous primitive here. */
	randomBytes(length: number): Uint8Array {
		if (!Number.isInteger(length) || length < 0 || length > 65536) {
			throw new Error(`Asked for ${length} random bytes, which is not a length.`);
		}
		const out = new Uint8Array(length);
		crypto.getRandomValues(out);
		return out;
	},

	/** One-shot AES. `iv` is the CBC IV or the GCM nonce; `tagBits` is GCM's. */
	async aes(
		direction: 'encrypt' | 'decrypt',
		mode: string,
		key: Uint8Array,
		iv: Uint8Array,
		data: Uint8Array,
		tagBits?: number
	): Promise<Uint8Array> {
		const name = named('the AES mode', mode, AES_MODES);
		const imported = await crypto.subtle.importKey(
			'raw',
			owned(aesKeyBytes(key)),
			{ name },
			false,
			['encrypt', 'decrypt']
		);
		const algorithm =
			name === 'AES-GCM'
				? { name, iv: owned(iv), tagLength: tagBits ?? 128 }
				: { name, iv: owned(iv) };
		const out =
			direction === 'encrypt'
				? await crypto.subtle.encrypt(algorithm, imported, owned(data))
				: await crypto.subtle.decrypt(algorithm, imported, owned(data));
		return new Uint8Array(out);
	},

	/** HMAC, which WebCrypto spells as a signature over a symmetric key. */
	async hmac(hash: string, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
		const imported = await crypto.subtle.importKey(
			'raw',
			owned(key),
			{ name: 'HMAC', hash: named('the hash', hash, HASHES) },
			false,
			['sign']
		);
		return new Uint8Array(await crypto.subtle.sign('HMAC', imported, owned(data)));
	},

	/**
	 * A fresh ECDSA key pair, with the public half exported once, here.
	 *
	 * Exported eagerly because the caller's next move is always to read the
	 * coordinates out of it, and `exportKey` is asynchronous: doing it now is
	 * what lets the shim above answer `x`, `y`, `crv` and `kty` as plain
	 * property reads rather than as promises nobody would await.
	 */
	async generateEcKeyPair(curve: string): Promise<EcKeyPair> {
		const namedCurve = named('the curve', curve, CURVES);
		const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve }, true, [
			'sign',
			'verify'
		]);
		const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
		const publicJwk: Record<string, string> = {};
		for (const field of ['kty', 'crv', 'x', 'y'] as const) {
			const value = jwk[field];
			if (typeof value === 'string') publicJwk[field] = value;
		}
		return {
			curve: namedCurve,
			publicJwk,
			privateKey: pair.privateKey,
			publicKey: pair.publicKey
		};
	},

	/** ECDSA over a digest, answering the raw `r ‖ s` WebCrypto produces. */
	async ecdsaSign(keys: EcKeyPair, hash: string, data: Uint8Array): Promise<Uint8Array> {
		const signed = await crypto.subtle.sign(
			{ name: 'ECDSA', hash: named('the hash', hash, HASHES) },
			keys.privateKey,
			owned(data)
		);
		return new Uint8Array(signed);
	},

	/** The other half, taking the same raw `r ‖ s` shape. */
	async ecdsaVerify(
		keys: EcKeyPair,
		hash: string,
		signature: Uint8Array,
		data: Uint8Array
	): Promise<boolean> {
		return crypto.subtle.verify(
			{ name: 'ECDSA', hash: named('the hash', hash, HASHES) },
			keys.publicKey,
			owned(signature),
			owned(data)
		);
	}
};
