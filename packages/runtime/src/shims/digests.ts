/**
 * Message digests, as bundle source, for the JavaScript formats that need one.
 *
 * Emitted into a bundle rather than imported by it, like the rest of the
 * conversion runtime, because a plugin cannot import from the host (`ABI.md`
 * §1).
 *
 * ## Why these are computed here and a cipher never is
 *
 * `ctx.crypto` (`ABI.md` §2) has no digest, and it does not need one: a hash is
 * a pure function of its bytes, with no key and so no capability to grant. The
 * Kotlin runtime's `MessageDigest` is computed in the bundle for exactly that
 * reason, and so are these. Everything with a key — AES, HMAC, ECDSA — stays on
 * the host's WebCrypto, and nothing in this file may grow one.
 *
 * Two formats read this:
 *
 * - **Mangayomi**, whose CryptoJS-compatible helpers derive a key and IV from a
 *   passphrase with OpenSSL's `EVP_BytesToKey`, which is MD5. WebCrypto has no
 *   MD5 at all, so there is no host operation this could have been.
 * - **Sora**, whose modules call `crypto.subtle.digest` and are given the
 *   WebCrypto-shaped façade in `web-crypto.ts`, which answers from here.
 *
 * ## Correctness
 *
 * Each function is checked against `node:crypto` on the standard test vectors
 * and on random inputs across the block-boundary lengths (55, 56, 63, 64, 111,
 * 112, 127, 128 bytes) in `digests.spec.ts`. SHA-384 and SHA-512 use `BigInt`,
 * which is ES2020 and on every surface `ABI.md` §6 names; the 32-bit ones use
 * ordinary integer arithmetic.
 *
 * Every function takes a `Uint8Array` (or anything array-like of bytes) and
 * answers a new `Uint8Array`.
 */
export const DIGESTS = `
/* --- digests ------------------------------------------------------------ */

function __digestBytes(value) {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value[i] & 0xff;
  return out;
}

/**
 * The Merkle-Damgard padding: a 0x80 byte, zeros, then the bit length, in a
 * block of 'block' bytes whose last 'lengthBytes' carry the length.
 */
function __digestPad(bytes, block, lengthBytes, littleEndian) {
  const total = Math.ceil((bytes.length + 1 + lengthBytes) / block) * block;
  const out = new Uint8Array(total);
  out.set(bytes);
  out[bytes.length] = 0x80;
  // Bit length. A bundle never hashes 2^53 bits, so a double holds it exactly;
  // the high words of the length field stay zero.
  const bits = bytes.length * 8;
  const low = bits >>> 0;
  const high = Math.floor(bits / 0x100000000) >>> 0;
  for (let i = 0; i < 4; i += 1) {
    if (littleEndian) {
      out[total - lengthBytes + i] = (low >>> (8 * i)) & 0xff;
      out[total - lengthBytes + 4 + i] = (high >>> (8 * i)) & 0xff;
    } else {
      out[total - 1 - i] = (low >>> (8 * i)) & 0xff;
      out[total - 5 - i] = (high >>> (8 * i)) & 0xff;
    }
  }
  return out;
}

const __MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];
const __MD5_K = (function () {
  const out = [];
  for (let i = 0; i < 64; i += 1) out.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0);
  return out;
})();

function __digestMd5(input) {
  const padded = __digestPad(__digestBytes(input), 64, 8, true);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  const m = new Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      const p = offset + j * 4;
      m[j] = padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + __MD5_K[i] + m[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << __MD5_S[i]) | (sum >>> (32 - __MD5_S[i])))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i += 1) {
    for (let j = 0; j < 4; j += 1) out[i * 4 + j] = (words[i] >>> (8 * j)) & 0xff;
  }
  return out;
}

function __digestWordsOut(words) {
  const out = new Uint8Array(words.length * 4);
  for (let i = 0; i < words.length; i += 1) {
    out[i * 4] = (words[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 3] = words[i] & 0xff;
  }
  return out;
}

function __digestSha1(input) {
  const padded = __digestPad(__digestBytes(input), 64, 8, false);
  const h = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476, 0xc3d2e1f0 | 0];
  const w = new Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      const p = offset + j * 4;
      w[j] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3];
    }
    for (let j = 16; j < 80; j += 1) {
      const x = w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16];
      w[j] = (x << 1) | (x >>> 31);
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (let j = 0; j < 80; j += 1) {
      let f;
      let k;
      if (j < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (j < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (j < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[j]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
  }
  return __digestWordsOut(h);
}

const __SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function __digestSha256(input) {
  const padded = __digestPad(__digestBytes(input), 64, 8, false);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  const w = new Array(64);
  const rotr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) {
      const p = offset + j * 4;
      w[j] = (padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3];
    }
    for (let j = 16; j < 64; j += 1) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let j = 0; j < 64; j += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + __SHA256_K[j] + w[j]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
  return __digestWordsOut(h);
}

/* SHA-512 and SHA-384: one compression function, two initial states. */
const __SHA512_K = (function () {
  const hex = [
    '428a2f98d728ae22', '7137449123ef65cd', 'b5c0fbcfec4d3b2f', 'e9b5dba58189dbbc',
    '3956c25bf348b538', '59f111f1b605d019', '923f82a4af194f9b', 'ab1c5ed5da6d8118',
    'd807aa98a3030242', '12835b0145706fbe', '243185be4ee4b28c', '550c7dc3d5ffb4e2',
    '72be5d74f27b896f', '80deb1fe3b1696b1', '9bdc06a725c71235', 'c19bf174cf692694',
    'e49b69c19ef14ad2', 'efbe4786384f25e3', '0fc19dc68b8cd5b5', '240ca1cc77ac9c65',
    '2de92c6f592b0275', '4a7484aa6ea6e483', '5cb0a9dcbd41fbd4', '76f988da831153b5',
    '983e5152ee66dfab', 'a831c66d2db43210', 'b00327c898fb213f', 'bf597fc7beef0ee4',
    'c6e00bf33da88fc2', 'd5a79147930aa725', '06ca6351e003826f', '142929670a0e6e70',
    '27b70a8546d22ffc', '2e1b21385c26c926', '4d2c6dfc5ac42aed', '53380d139d95b3df',
    '650a73548baf63de', '766a0abb3c77b2a8', '81c2c92e47edaee6', '92722c851482353b',
    'a2bfe8a14cf10364', 'a81a664bbc423001', 'c24b8b70d0f89791', 'c76c51a30654be30',
    'd192e819d6ef5218', 'd69906245565a910', 'f40e35855771202a', '106aa07032bbd1b8',
    '19a4c116b8d2d0c8', '1e376c085141ab53', '2748774cdf8eeb99', '34b0bcb5e19b48a8',
    '391c0cb3c5c95a63', '4ed8aa4ae3418acb', '5b9cca4f7763e373', '682e6ff3d6b2b8a3',
    '748f82ee5defb2fc', '78a5636f43172f60', '84c87814a1f0ab72', '8cc702081a6439ec',
    '90befffa23631e28', 'a4506cebde82bde9', 'bef9a3f7b2c67915', 'c67178f2e372532b',
    'ca273eceea26619c', 'd186b8c721c0c207', 'eada7dd6cde0eb1e', 'f57d4f7fee6ed178',
    '06f067aa72176fba', '0a637dc5a2c898a6', '113f9804bef90dae', '1b710b35131c471b',
    '28db77f523047d84', '32caab7b40c72493', '3c9ebe0a15c9bebc', '431d67c49c100d4c',
    '4cc5d4becb3e42b6', '597f299cfc657e2a', '5fcb6fab3ad6faec', '6c44198c4a475817'
  ];
  const out = [];
  for (let i = 0; i < hex.length; i += 1) out.push(BigInt('0x' + hex[i]));
  return out;
})();

function __digestSha512Family(input, initial, outBytes) {
  const padded = __digestPad(__digestBytes(input), 128, 16, false);
  const mask = BigInt('0xffffffffffffffff');
  const rotr = function (x, n) {
    return ((x >> BigInt(n)) | (x << BigInt(64 - n))) & mask;
  };
  const h = [];
  for (let i = 0; i < 8; i += 1) h.push(BigInt('0x' + initial[i]));
  const w = new Array(80);
  for (let offset = 0; offset < padded.length; offset += 128) {
    for (let j = 0; j < 16; j += 1) {
      let word = BigInt(0);
      for (let k = 0; k < 8; k += 1) word = (word << BigInt(8)) | BigInt(padded[offset + j * 8 + k]);
      w[j] = word;
    }
    for (let j = 16; j < 80; j += 1) {
      const s0 = rotr(w[j - 15], 1) ^ rotr(w[j - 15], 8) ^ (w[j - 15] >> BigInt(7));
      const s1 = rotr(w[j - 2], 19) ^ rotr(w[j - 2], 61) ^ (w[j - 2] >> BigInt(6));
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) & mask;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let j = 0; j < 80; j += 1) {
      const S1 = rotr(e, 14) ^ rotr(e, 18) ^ rotr(e, 41);
      const ch = (e & f) ^ (~e & mask & g);
      const t1 = (hh + S1 + ch + __SHA512_K[j] + w[j]) & mask;
      const S0 = rotr(a, 28) ^ rotr(a, 34) ^ rotr(a, 39);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) & mask;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & mask;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & mask;
    }
    h[0] = (h[0] + a) & mask;
    h[1] = (h[1] + b) & mask;
    h[2] = (h[2] + c) & mask;
    h[3] = (h[3] + d) & mask;
    h[4] = (h[4] + e) & mask;
    h[5] = (h[5] + f) & mask;
    h[6] = (h[6] + g) & mask;
    h[7] = (h[7] + hh) & mask;
  }
  const out = new Uint8Array(outBytes);
  for (let i = 0; i < outBytes; i += 1) {
    const word = h[Math.floor(i / 8)];
    out[i] = Number((word >> BigInt(56 - 8 * (i % 8))) & BigInt(0xff));
  }
  return out;
}

function __digestSha512(input) {
  return __digestSha512Family(input, [
    '6a09e667f3bcc908', 'bb67ae8584caa73b', '3c6ef372fe94f82b', 'a54ff53a5f1d36f1',
    '510e527fade682d1', '9b05688c2b3e6c1f', '1f83d9abfb41bd6b', '5be0cd19137e2179'
  ], 64);
}

function __digestSha384(input) {
  return __digestSha512Family(input, [
    'cbbb9d5dc1059ed8', '629a292a367cd507', '9159015a3070dd17', '152fecd8f70e5939',
    '67332667ffc00b31', '8eb44a8768581511', 'db0c2e0d64f98fa7', '47b5481dbefa4fa4'
  ], 48);
}
`;
