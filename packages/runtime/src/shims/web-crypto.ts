/**
 * A WebCrypto-shaped `crypto`, for the Sora modules that were written against
 * one, answered from `ctx.crypto` and nothing else.
 *
 * ## Why a façade and not the global
 *
 * `ABI.md` §6 keeps the `crypto` global out of a bundle, and the reason is a
 * capability one: `crypto.subtle` grants whatever algorithms the engine
 * happens to ship, including the ones a converter's refusals are about. That
 * reason is untouched by this file. What it declares is a module-scope binding
 * named `crypto` that reaches **only** the operations `ctx.crypto` already
 * lends, spelled the way WebCrypto spells them — so a module that says
 * `crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)` gets the host's
 * AES-GCM, and a module that says anything the host does not lend gets a
 * sentence naming what it asked for.
 *
 * Counted on a live Sora library: seven modules call `crypto.subtle`, and
 * each stopped at that line with "crypto is not defined", because the sandbox
 * deletes the global and nothing stood in its place.
 *
 * It is a module-scope binding and deliberately not a global: a module reads
 * `crypto` as a free variable and finds it, and `globalThis.crypto` stays as
 * absent as §6 says. A module that reaches for `globalThis.crypto` or
 * `window.crypto` by name still finds nothing, which is the one gap left, and
 * it fails there as loudly as before.
 *
 * ## What is offered, exactly
 *
 * | WebCrypto | Answered by |
 * | --- | --- |
 * | `getRandomValues(typedArray)` | `ctx.crypto.randomBytes` |
 * | `randomUUID()` | the same, as an RFC 4122 version 4 id |
 * | `subtle.digest` SHA-1/256/384/512 | `digests.ts` — a hash has no key |
 * | `subtle.importKey('raw', …)` for AES-CBC, AES-GCM, HMAC | held in the bundle |
 * | `subtle.exportKey('raw', key)` of an extractable key | the bytes it was given |
 * | `subtle.encrypt` / `decrypt`, AES-CBC and AES-GCM | `ctx.crypto.aes` |
 * | `subtle.sign` / `verify`, HMAC | `ctx.crypto.hmac` |
 *
 * Everything else — another key format, `generateKey`, `deriveKey`,
 * `deriveBits`, PBKDF2, AES-CTR, RSA, ECDSA through `subtle`, and GCM's
 * `additionalData`, which `ctx.crypto.aes` has no parameter for — rejects with
 * a named error. Mapping one onto a neighbour would be the plausible wrong
 * answer this runtime exists to prevent.
 *
 * WebCrypto's argument checks are kept where a module could come to depend on
 * them: an algorithm that does not match the key's, a usage the key was not
 * imported for, a CBC IV that is not 16 bytes. Results are `ArrayBuffer`s, as
 * WebCrypto's are, so `new Uint8Array(await crypto.subtle.digest(...))` works.
 *
 * Requires `DIGESTS` and `JS_RUNTIME` (for `__host`) before it.
 */
export const WEB_CRYPTO = `
/* --- a WebCrypto-shaped crypto, over ctx.crypto --------------------------- */

const crypto = (function () {
  const OFFERED = 'digest (SHA-1, SHA-256, SHA-384, SHA-512), importKey and exportKey in the raw ' +
    'format, AES-CBC and AES-GCM encrypt and decrypt, HMAC sign and verify, getRandomValues and ' +
    'randomUUID';

  function refuse(what) {
    return new Error('This module asked WebCrypto for ' + what + ', which this build does not offer. ' +
      'It offers ' + OFFERED + '.');
  }

  function nameOf(algorithm) {
    const name = typeof algorithm === 'string' ? algorithm : (algorithm && algorithm.name);
    if (typeof name !== 'string') throw new TypeError('A WebCrypto algorithm needs a name.');
    return name.toUpperCase();
  }

  const HASHES = {
    'SHA-1': __digestSha1,
    'SHA-256': __digestSha256,
    'SHA-384': __digestSha384,
    'SHA-512': __digestSha512
  };

  function hashOf(algorithm) {
    const name = nameOf(algorithm);
    if (HASHES[name] === undefined) throw refuse('the ' + name + ' hash');
    return name;
  }

  /** A BufferSource, copied, because WebCrypto copies it too. */
  function bytesOf(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    throw new TypeError('WebCrypto takes an ArrayBuffer or a typed array.');
  }

  function bufferOf(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  function keyFor(key, name, usage) {
    if (!key || key.__yorozoKey !== true) throw new TypeError('That is not a key this build imported.');
    if (key.algorithm.name !== name) {
      throw new Error('InvalidAccessError: the key is for ' + key.algorithm.name + ', not ' + name + '.');
    }
    if (key.usages.indexOf(usage) === -1) {
      throw new Error('InvalidAccessError: the key was not imported for ' + usage + '.');
    }
    return key.__bytes;
  }

  const USAGES = {
    'AES-CBC': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    'AES-GCM': ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'],
    HMAC: ['sign', 'verify']
  };

  function aesParameters(algorithm, name) {
    const iv = bytesOf(algorithm.iv);
    if (name === 'AES-CBC') {
      if (iv.length !== 16) throw new Error('OperationError: an AES-CBC iv is 16 bytes; this one is ' + iv.length + '.');
      return { iv: iv, tagBits: undefined };
    }
    if (algorithm.additionalData !== undefined) throw refuse('AES-GCM with additionalData');
    const tagBits = algorithm.tagLength === undefined ? 128 : Number(algorithm.tagLength);
    if ([32, 64, 96, 104, 112, 120, 128].indexOf(tagBits) === -1) {
      throw new Error('OperationError: ' + tagBits + ' is not an AES-GCM tag length.');
    }
    return { iv: iv, tagBits: tagBits };
  }

  async function aes(direction, algorithm, key, data) {
    const name = nameOf(algorithm);
    if (name !== 'AES-CBC' && name !== 'AES-GCM') throw refuse(direction + ' with ' + name);
    const raw = keyFor(key, name, direction);
    const parameters = aesParameters(algorithm, name);
    const out = await __host().crypto.aes(direction, name, raw, parameters.iv, bytesOf(data), parameters.tagBits);
    return bufferOf(out);
  }

  async function hmac(algorithm, key, data) {
    const name = nameOf(algorithm);
    if (name !== 'HMAC') throw refuse('a signature with ' + name);
    const raw = keyFor(key, 'HMAC', 'sign');
    return __host().crypto.hmac(key.algorithm.hash.name, raw, bytesOf(data));
  }

  const subtle = {
    async digest(algorithm, data) {
      return bufferOf(HASHES[hashOf(algorithm)](bytesOf(data)));
    },

    async importKey(format, keyData, algorithm, extractable, usages) {
      if (format !== 'raw') throw refuse('importKey in the ' + String(format) + ' format');
      const name = nameOf(algorithm);
      if (USAGES[name] === undefined) throw refuse('a ' + name + ' key');
      const list = Array.isArray(usages) ? usages.slice() : [];
      if (list.length === 0) throw new Error('SyntaxError: a secret key needs at least one usage.');
      for (const usage of list) {
        if (USAGES[name].indexOf(usage) === -1) {
          throw new Error('SyntaxError: a ' + name + ' key cannot be used to ' + usage + '.');
        }
      }
      const bytes = bytesOf(keyData);
      let described;
      if (name === 'HMAC') {
        if (algorithm.hash === undefined) throw new TypeError('An HMAC key needs a hash.');
        if (algorithm.length !== undefined && Number(algorithm.length) !== bytes.length * 8) {
          throw refuse('an HMAC key whose length is not its whole key data');
        }
        described = { name: 'HMAC', hash: { name: hashOf(algorithm.hash) }, length: bytes.length * 8 };
      } else {
        if (bytes.length !== 16 && bytes.length !== 24 && bytes.length !== 32) {
          throw new Error('DataError: an AES key is 16, 24 or 32 bytes; this one is ' + bytes.length + '.');
        }
        described = { name: name, length: bytes.length * 8 };
      }
      return {
        __yorozoKey: true,
        __bytes: bytes,
        type: 'secret',
        extractable: extractable === true,
        algorithm: described,
        usages: list
      };
    },

    async exportKey(format, key) {
      if (format !== 'raw') throw refuse('exportKey in the ' + String(format) + ' format');
      if (!key || key.__yorozoKey !== true) throw new TypeError('That is not a key this build imported.');
      if (key.extractable !== true) throw new Error('InvalidAccessError: the key is not extractable.');
      return bufferOf(key.__bytes);
    },

    async encrypt(algorithm, key, data) { return aes('encrypt', algorithm, key, data); },
    async decrypt(algorithm, key, data) { return aes('decrypt', algorithm, key, data); },

    async sign(algorithm, key, data) {
      return bufferOf(await hmac(algorithm, key, data));
    },

    async verify(algorithm, key, signature, data) {
      const name = nameOf(algorithm);
      if (name !== 'HMAC') throw refuse('verify with ' + name);
      const raw = keyFor(key, 'HMAC', 'verify');
      const expected = await __host().crypto.hmac(key.algorithm.hash.name, raw, bytesOf(data));
      const given = bytesOf(signature);
      if (given.length !== expected.length) return false;
      let difference = 0;
      for (let i = 0; i < given.length; i += 1) difference |= given[i] ^ expected[i];
      return difference === 0;
    },

    async generateKey() { throw refuse('generateKey'); },
    async deriveKey() { throw refuse('deriveKey'); },
    async deriveBits() { throw refuse('deriveBits'); },
    async wrapKey() { throw refuse('wrapKey'); },
    async unwrapKey() { throw refuse('unwrapKey'); }
  };

  const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array];

  function getRandomValues(array) {
    let integer = false;
    for (const kind of INTEGER_ARRAYS) if (array instanceof kind) integer = true;
    if (typeof BigInt64Array !== 'undefined' && (array instanceof BigInt64Array || array instanceof BigUint64Array)) integer = true;
    if (!integer) throw new TypeError('TypeMismatchError: getRandomValues takes an integer typed array.');
    if (array.byteLength > 65536) {
      throw new Error('QuotaExceededError: getRandomValues gives at most 65536 bytes at once.');
    }
    const random = __host().crypto.randomBytes(array.byteLength);
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(random);
    return array;
  }

  function randomUUID() {
    const bytes = __host().crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = '';
    for (let i = 0; i < 16; i += 1) hex += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  }

  return { subtle: subtle, getRandomValues: getRandomValues, randomUUID: randomUUID };
})();
`;
