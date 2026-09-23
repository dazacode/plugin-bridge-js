/**
 * The runtime a converted JavaScript module is given, as source.
 *
 * Emitted into the bundle rather than imported by it, because a plugin bundle
 * is one self-contained ES2020 module (`ABI.md` §1) — there is no module
 * resolution inside the sandbox and nothing for an import to resolve against.
 *
 * ## What it is for
 *
 * Foreign modules were written against globals their own host provides: a
 * `fetchv2` that takes headers and a body, `atob`/`btoa`, sometimes a
 * CommonJS-ish `require`. The sandbox provides none of those — it deletes
 * `fetch` and every other ambient network global on load, and gives a plugin
 * exactly one capability, `ctx`.
 *
 * So each of those names is redefined here at **module scope**, where it
 * shadows the global of the same name for everything inside the bundle, and
 * routed through `ctx.http`. The plugin's code is unchanged and the host still
 * decides every request: `ctx.http` refuses a host the manifest did not
 * declare, before a packet leaves.
 *
 * ## Why the context is a module-scoped variable
 *
 * `ctx` arrives per call, and the foreign code expects a global that is simply
 * there. `__enter` sets it at the top of every ABI method. A module call that
 * somehow ran outside one gets a named error rather than a null dereference,
 * which is the difference between a bug report that says what happened and one
 * that says "undefined is not an object".
 *
 * ## The engine subset
 *
 * ES2020 only, and none of `Intl`, regex lookbehind, `structuredClone`,
 * `Array.prototype.at` or `Object.groupBy` (`ABI.md` §6) — this source runs on
 * QuickJS and JavaScriptCore as well as in a browser.
 */

/**
 * Shared by every JavaScript-format converter.
 *
 * Written as one string constant rather than assembled, so that what ships in
 * a bundle is exactly what is reviewable here.
 */
export const JS_RUNTIME = `
/* --- Yorozo conversion runtime ------------------------------------------ */

var __ctx = null;

function __enter(ctx) { __ctx = ctx; return ctx; }

/**
 * The host, or the sentence that says why there is not one yet.
 *
 * This guards every capability the host lends — 'http', but also 'text',
 * 'bytes' and 'crypto' — and the message used to name only the first. So a
 * converted extension whose class property encoded a constant to UTF-8 died at
 * load being told it had called out to the network, which it had not: the
 * reader goes looking for a request that does not exist, in a file that never
 * makes one.
 *
 * The emitter now defers such a property to first use — see HOST_BACKED_HELPERS
 * — so this should be rarer than it was. What still reaches it deserves a
 * sentence that is true.
 */
function __host() {
  if (__ctx === null) {
    throw new Error(
      'This converted module used a capability the host lends (network, text, bytes or crypto) ' +
        'before any plugin call had started.'
    );
  }
  return __ctx;
}

/**
 * Normalises the several call shapes foreign hosts accept for one request.
 *
 * The positional shape is Sora's, and it has six arguments, not four:
 * \`fetchv2(url, headers, method, body, redirect, encoding)\`. The last two used
 * to be read by nobody, which is the one outcome neither of them may have:
 *
 * - **\`redirect\`** is whether to follow one. \`false\` is a module asking to
 *   read the 3xx itself — the \`Location\` is the answer it wants — and a
 *   request that followed anyway handed it the page the redirect pointed at.
 *   The host port says exactly this with \`follow: false\` (\`ABI.md\` §2), so
 *   it is passed through. The fetch-shaped call spells it \`redirect:
 *   'manual'\`, and means the same.
 * - **\`encoding\`** is the charset to read the body in. See \`__charset\`.
 */
function __request(url, a, b, c, d, e) {
  var headers = {};
  var method = 'GET';
  var body = null;
  var follow = true;
  var charset = null;

  if (a && typeof a === 'object' && (a.headers || a.method || a.body || a.redirect)) {
    // fetch(url, { method, headers, body, redirect })
    headers = a.headers || {};
    method = a.method || 'GET';
    body = a.body === undefined ? null : a.body;
    if (a.redirect !== undefined && a.redirect !== 'follow') {
      if (a.redirect !== 'manual') {
        throw new Error('This module asked fetch for redirect: "' + String(a.redirect) + '", which this build does not implement.');
      }
      follow = false;
    }
  } else {
    // fetchv2(url, headers, method, body, redirect, encoding)
    headers = a || {};
    method = b || 'GET';
    body = c === undefined ? null : c;
    if (d !== undefined && d !== null) {
      if (typeof d !== 'boolean') {
        throw new Error('This module passed fetchv2 a redirect argument that is not true or false: ' + String(d) + '.');
      }
      follow = d;
    }
    charset = __charset(e);
  }

  if (body !== null && typeof body !== 'string') body = JSON.stringify(body);
  var request = { method: String(method).toUpperCase(), headers: headers, body: body };
  if (follow === false) request.follow = false;
  return { request: request, charset: charset };
}

/**
 * The charset a module asked the body to be read in, or null for UTF-8.
 *
 * The host reads every body as UTF-8 before a plugin sees it (\`ctx.http\`
 * hands over text, not bytes), so a body in another charset has already been
 * decoded the wrong way by the time this runs, and nothing here can undo that.
 * What *can* be said exactly is when it made no difference: every charset below
 * agrees with ASCII on bytes under 0x80, so a body that came through as pure
 * ASCII is the same text in all of them. \`__response\` checks for that and
 * throws, naming the charset, when it is not so.
 *
 * A charset outside the list is refused before the request is made. UTF-16 and
 * ISO-2022-JP are the reason there is a list: neither agrees with ASCII, so not
 * even an all-ASCII body could be vouched for.
 */
function __charset(value) {
  if (value === undefined || value === null || value === '') return null;
  var label = String(value).trim().toLowerCase();
  if (label === 'utf-8' || label === 'utf8' || label === 'unicode-1-1-utf-8') return null;
  if (/^(?:us-ascii|ascii|iso-?8859-\\d{1,2}|iso_8859-\\d{1,2}|latin-?[1-9]|l[1-9]|windows-12[5][0-8]|cp12[5][0-8]|windows-874|koi8-[ru]|ibm866|cp866|macintosh|x-mac-cyrillic|shift[_-]?jis|sjis|euc-jp|euc-kr|gbk|gb2312|gb18030|big5)$/.test(label)) {
    return label;
  }
  throw new Error(
    'This module asked for its response in the ' + String(value) + ' charset, which this build ' +
      'cannot read: the host decodes every response as UTF-8.'
  );
}

/**
 * The body, checked against the charset the module asked for.
 *
 * Only reached for a charset \`__charset\` accepted, and only an all-ASCII body
 * passes, because that is the one case where the host's UTF-8 reading is
 * provably the text the module asked for.
 */
function __inCharset(text, charset) {
  if (charset === null) return text;
  if (!/[^\\u0000-\\u007f]/.test(text)) return text;
  throw new Error(
    'This module asked for its response in ' + charset + ', and the response has characters ' +
      'outside ASCII. The host reads every response as UTF-8, so this text would be wrong, and ' +
      'it is refused rather than handed over.'
  );
}

/**
 * The response shape these modules expect: text() and json() as promises,
 * plus the status they occasionally branch on.
 */
function __response(raw, charset) {
  return {
    status: raw.status,
    url: raw.url,
    headers: raw.headers,
    ok: raw.status >= 200 && raw.status < 300,
    text: async function () { return __inCharset(await raw.text(), charset); },
    json: async function () {
      if (charset === null) return raw.json();
      return JSON.parse(__inCharset(await raw.text(), charset));
    }
  };
}

async function fetchv2(url, a, b, c, d, e) {
  var asked = __request(url, a, b, c, d, e);
  var raw = await __host().http.send(String(url), asked.request);
  return __response(raw, asked.charset);
}

/** Some modules were written against a plain fetch, and mean the same thing. */
async function fetch(url, init) {
  return fetchv2(url, init);
}

/** A few modules use the framework helper rather than the global. */
async function fetchApi(url, init) {
  return fetchv2(url, init);
}

function atob(value) { return __host().text.decode(__host().bytes.fromBase64(String(value))); }
function btoa(value) { return __host().bytes.toBase64(__host().text.encode(String(value))); }

/**
 * Enough of a module registry for the handful of names these bundles import.
 *
 * Anything else throws by name. A converted module that quietly received an
 * empty object for a library it depends on would fail later, somewhere else,
 * with a message about the wrong thing.
 */
function require(name) {
  if (name === '@libs/fetch') return { fetchApi: fetchApi, fetchText: async function (u, i) { return (await fetchv2(u, i)).text(); } };
  if (name === '@libs/defaultCover') return { defaultCover: '' };
  throw new Error('This converted module needs "' + name + '", which Yorozo does not provide.');
}

/** Absolutises a possibly relative url against the module's own base. */
function __absolute(url, base) {
  var value = String(url === null || url === undefined ? '' : url);
  if (value.length === 0) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  try { return new URL(value, base).toString(); } catch (error) { return value; }
}

/**
 * These modules return JSON *strings* from every entry point, but not all of
 * them, and not always. Parsing defensively is what keeps a plugin that
 * already returned an object from failing at the boundary.
 */
function __decode(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (error) { return value; }
}

function __array(value) {
  var decoded = __decode(value);
  if (Array.isArray(decoded)) return decoded;
  if (decoded && typeof decoded === 'object') return [decoded];
  return [];
}

/* ------------------------------------------------------------------------ */
`;
