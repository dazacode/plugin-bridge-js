/**
 * `html-entities` and the part of `crypto-js` a measured corpus reaches, as
 * bundle source.
 *
 * Both are packages a source's own toolchain would have bundled, and a source
 * converted from its tree arrives without them. These are compatible subsets,
 * written here and kept to what the census shows is called (Mana closures,
 * 139 entry files):
 *
 * - `html-entities`: `decode` (10 call sites) — over the parser's own entity
 *   table, so a page and a decoded string agree — and `encode` in its default
 *   mode, which is five characters.
 * - `crypto-js`: imported by 52 closures, almost all through one template
 *   that decrypts a protected chapter, and by one shared AES helper. The
 *   encoders (`enc.Hex`, `enc.Base64`, `enc.Utf8`, `enc.Latin1`), `WordArray`,
 *   `CipherParams` and the keyless digests (`MD5`, `SHA1`, `SHA256`) are
 *   supplied; the digests are the bundle's own (`digests.ts`).
 *
 * **What is not supplied, and fails by name when reached:** every keyed
 * operation — `AES`, `HmacSHA256` and their kin. `ABI.md` §2 keeps a key on the
 * host's WebCrypto, which answers asynchronously, and `crypto-js` answers
 * synchronously; writing a cipher into the bundle to bridge that is the trade
 * `digests.ts` already refuses. So a source loads and runs, and the one call
 * that needs a cipher — a protected chapter, say — throws naming it, rather
 * than the whole source refusing at conversion over a branch most of its
 * chapters never take.
 *
 * Exposes `__htmlEntities` and `__cryptoJs`. Needs `DIGESTS` and the DOM
 * engine evaluated first.
 */
export const JS_LIBRARIES_SOURCE = `
/* --- html-entities -------------------------------------------------------- */

var __htmlEntities = {
  decode: function (text) {
    return globalThis.__yorozoRuntime.unescapeEntities(String(text === null || text === undefined ? '' : text), false);
  },
  encode: function (text, options) {
    var mode = options && options.mode;
    if (mode !== undefined && mode !== 'specialChars') {
      throw new Error('html-entities.encode in mode "' + mode + '" is not supplied by this build.');
    }
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
};
__htmlEntities.default = __htmlEntities;

/* --- crypto-js, the keyless part ------------------------------------------ */

function __cjsWordArray(words, sigBytes) {
  this.words = words || [];
  this.sigBytes = sigBytes === undefined ? this.words.length * 4 : sigBytes;
}
__cjsWordArray.prototype.toString = function (encoder) { return (encoder || __cjsHex).stringify(this); };
__cjsWordArray.prototype.concat = function (other) {
  var bytes = __cjsBytes(this);
  var more = __cjsBytes(other);
  var joined = new Uint8Array(bytes.length + more.length);
  joined.set(bytes, 0);
  joined.set(more, bytes.length);
  var made = __cjsFromBytes(joined);
  this.words = made.words;
  this.sigBytes = made.sigBytes;
  return this;
};
__cjsWordArray.prototype.clone = function () { return new __cjsWordArray(this.words.slice(), this.sigBytes); };

function __cjsBytes(wordArray) {
  var out = new Uint8Array(wordArray.sigBytes);
  for (var i = 0; i < wordArray.sigBytes; i++) out[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
  return out;
}

function __cjsFromBytes(bytes) {
  var words = [];
  for (var i = 0; i < bytes.length; i++) words[i >>> 2] |= (bytes[i] & 0xff) << (24 - (i % 4) * 8);
  return new __cjsWordArray(words, bytes.length);
}

var __cjsHex = {
  stringify: function (wordArray) {
    var bytes = __cjsBytes(wordArray);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  },
  parse: function (text) {
    var value = String(text);
    var bytes = new Uint8Array(value.length >>> 1);
    for (var i = 0; i < bytes.length; i++) bytes[i] = parseInt(value.substr(i * 2, 2), 16);
    return __cjsFromBytes(bytes);
  }
};

var __cjsLatin1 = {
  stringify: function (wordArray) {
    var bytes = __cjsBytes(wordArray);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  },
  parse: function (text) {
    var value = String(text);
    var bytes = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i) & 0xff;
    return __cjsFromBytes(bytes);
  }
};

var __cjsUtf8 = {
  stringify: function (wordArray) {
    // crypto-js decodes strictly and throws "Malformed UTF-8 data" on bytes
    // that are not UTF-8, which is how a source learns a key was wrong.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(__cjsBytes(wordArray));
    } catch (error) {
      throw new Error('Malformed UTF-8 data');
    }
  },
  parse: function (text) { return __cjsFromBytes(new TextEncoder().encode(String(text))); }
};

var __cjsB64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var __cjsBase64 = {
  stringify: function (wordArray) {
    var bytes = __cjsBytes(wordArray);
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : -1, c = i + 2 < bytes.length ? bytes[i + 2] : -1;
      out += __cjsB64.charAt(a >> 2);
      out += __cjsB64.charAt(((a & 3) << 4) | ((b < 0 ? 0 : b) >> 4));
      out += b < 0 ? '=' : __cjsB64.charAt(((b & 15) << 2) | ((c < 0 ? 0 : c) >> 6));
      out += c < 0 ? '=' : __cjsB64.charAt(c & 63);
    }
    return out;
  },
  parse: function (text) {
    var clean = String(text).replace(/[^A-Za-z0-9+/]/g, '');
    var bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
    var at = 0, buffer = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      buffer = (buffer << 6) | __cjsB64.indexOf(clean.charAt(i));
      bits += 6;
      if (bits >= 8) { bits -= 8; bytes[at++] = (buffer >> bits) & 0xff; }
    }
    return __cjsFromBytes(bytes.slice(0, at));
  }
};

function __cjsInput(value) {
  if (value instanceof __cjsWordArray) return __cjsBytes(value);
  return __cjsBytes(__cjsUtf8.parse(value));
}

function __cjsDigest(fn) {
  return function (message) { return __cjsFromBytes(fn(__cjsInput(message))); };
}

function __cjsKeyed(name) {
  var refuse = function () {
    throw new Error(
      'This converted source called crypto-js ' + name + ', a keyed operation. A key stays on the host ' +
      "(ABI section 2), whose cipher is asynchronous, so this build does not carry a synchronous one."
    );
  };
  return { encrypt: refuse, decrypt: refuse, create: refuse, __refuse: refuse };
}

function __cjsCipherParams(fields) { Object.assign(this, fields || {}); }
__cjsCipherParams.prototype.toString = function (formatter) {
  if (formatter && typeof formatter.stringify === 'function') return formatter.stringify(this);
  return this.ciphertext ? __cjsBase64.stringify(this.ciphertext) : '';
};

var __cryptoJs = {
  lib: {
    WordArray: { create: function (words, sigBytes) {
      if (words instanceof Uint8Array) return __cjsFromBytes(words);
      return new __cjsWordArray(words, sigBytes);
    } },
    CipherParams: { create: function (fields) { return new __cjsCipherParams(fields); } }
  },
  enc: { Hex: __cjsHex, Base64: __cjsBase64, Utf8: __cjsUtf8, Latin1: __cjsLatin1 },
  MD5: __cjsDigest(__digestMd5),
  SHA1: __cjsDigest(__digestSha1),
  SHA256: __cjsDigest(__digestSha256),
  SHA512: __cjsDigest(__digestSha512),
  AES: __cjsKeyed('AES'),
  TripleDES: __cjsKeyed('TripleDES'),
  DES: __cjsKeyed('DES'),
  RC4: __cjsKeyed('RC4'),
  HmacMD5: __cjsKeyed('HmacMD5').__refuse,
  HmacSHA1: __cjsKeyed('HmacSHA1').__refuse,
  HmacSHA256: __cjsKeyed('HmacSHA256').__refuse,
  HmacSHA512: __cjsKeyed('HmacSHA512').__refuse,
  PBKDF2: __cjsKeyed('PBKDF2').__refuse,
  EvpKDF: __cjsKeyed('EvpKDF').__refuse,
  // Named tokens a source passes as options; only a keyed call reads them,
  // and that call refuses.
  mode: { CBC: 'CBC', ECB: 'ECB', CTR: 'CTR', CFB: 'CFB', OFB: 'OFB' },
  pad: { Pkcs7: 'Pkcs7', NoPadding: 'NoPadding', ZeroPadding: 'ZeroPadding', AnsiX923: 'AnsiX923', Iso10126: 'Iso10126', Iso97971: 'Iso97971' },
  format: { OpenSSL: { stringify: function (params) { return params.toString(); }, parse: function (text) { return new __cjsCipherParams({ ciphertext: __cjsBase64.parse(text) }); } } }
};
__cryptoJs.default = __cryptoJs;
`;
