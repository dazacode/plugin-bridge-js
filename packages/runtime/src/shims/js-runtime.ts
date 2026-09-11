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

function __host() {
  if (__ctx === null) {
    throw new Error('This converted module called out to the network outside a plugin call.');
  }
  return __ctx;
}

/** Normalises the several call shapes foreign hosts accept for one request. */
function __request(url, a, b, c) {
  var headers = {};
  var method = 'GET';
  var body = null;

  if (a && typeof a === 'object' && (a.headers || a.method || a.body)) {
    // fetch(url, { method, headers, body })
    headers = a.headers || {};
    method = a.method || 'GET';
    body = a.body === undefined ? null : a.body;
  } else {
    // fetchv2(url, headers, method, body)
    headers = a || {};
    method = b || 'GET';
    body = c === undefined ? null : c;
  }

  if (body !== null && typeof body !== 'string') body = JSON.stringify(body);
  return { method: String(method).toUpperCase(), headers: headers, body: body };
}

/**
 * The response shape these modules expect: text() and json() as promises,
 * plus the status they occasionally branch on.
 */
function __response(raw) {
  return {
    status: raw.status,
    url: raw.url,
    headers: raw.headers,
    ok: raw.status >= 200 && raw.status < 300,
    text: function () { return raw.text(); },
    json: function () { return raw.json(); }
  };
}

async function fetchv2(url, a, b, c) {
  var raw = await __host().http.send(String(url), __request(url, a, b, c));
  return __response(raw);
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
