/**
 * A context for a bundle's own load, before the host's first call arrives.
 *
 * Built bundles from two ecosystems decode constants while their module
 * evaluates — an obfuscated API address, an HTML entity table — through the
 * runtime's `atob` and text codecs, which reach the host's context, and that
 * context only arrives with the first call. So the runtime is given a boot
 * context carrying the two codecs those decodes need, written here in plain
 * JavaScript, and nothing else. A request before the first call still fails,
 * because there is no transport in it; the first `__enter(ctx)` replaces it.
 *
 * Must follow `JS_RUNTIME`, which declares `__ctx`.
 */
export const BOOT_CONTEXT = `
/* --- a context for the load itself --------------------------------------- */

/**
 * Several sources decode a constant while the module evaluates — an obfuscated
 * API address, usually — and the host's own context only arrives with the first
 * call. So the runtime is given a boot context carrying the two codecs those
 * decodes need and nothing else. A request before the first call still fails by
 * name, because there is no transport in it.
 */
const __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function __b64encode(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 3) {
    var a = bytes[i];
    var b = i + 1 < bytes.length ? bytes[i + 1] : -1;
    var c = i + 2 < bytes.length ? bytes[i + 2] : -1;
    out += __B64.charAt(a >> 2);
    out += __B64.charAt(((a & 3) << 4) | ((b < 0 ? 0 : b) >> 4));
    out += b < 0 ? '=' : __B64.charAt(((b & 15) << 2) | ((c < 0 ? 0 : c) >> 6));
    out += c < 0 ? '=' : __B64.charAt(c & 63);
  }
  return out;
}

function __b64decode(value) {
  var clean = String(value).replace(/[^A-Za-z0-9+/]/g, '');
  var out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  var at = 0;
  var buffer = 0;
  var bits = 0;
  for (var i = 0; i < clean.length; i++) {
    buffer = (buffer << 6) | __B64.indexOf(clean.charAt(i));
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (buffer >> bits) & 0xff;
    }
  }
  return out.slice(0, at);
}

__ctx = {
  text: {
    encode: function (value) { return new TextEncoder().encode(String(value)); },
    decode: function (bytes) { return new TextDecoder().decode(bytes); }
  },
  bytes: { toBase64: __b64encode, fromBase64: __b64decode }
};
`;
