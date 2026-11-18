/**
 * A Mana source, wrapped as a Yorozo plugin bundle.
 *
 * Two shapes reach this file and they are not variations on one theme: a built
 * `.mana` is self-contained and needs a *host*, while a bare entry file needs
 * the base class it was written against. `manaEntrypoint` emits one or the
 * other, and the two halves share nothing but the ABI skeleton below.
 *
 * ## The bridge, and why it is the whole of the built path
 *
 * A `.mana` is minified CommonJS from the ecosystem's own toolchain. It embeds
 * its own `@mana-app/types`, including the HTTP client, and its own polyfills.
 * The one thing it expects and does not carry is `globalThis.__manaHTTPBridge`,
 * which is where the app puts its transport. So the bridge is our only insertion
 * point and it is a good one: every request the bundle makes arrives here as a
 * plain object and leaves through `ctx.http`, which means the manifest's host
 * allowlist is enforced exactly as it is for any other plugin.
 *
 * The bridge protocol is the bundle's, not ours: `operation` numbers, a
 * `bodyID` handle for a response body, and `Read` to pull text or base64 out of
 * it. Bodies are buffered whole here rather than streamed, because `ctx.http`
 * already has the bytes by the time it answers — the app's own bridge streams,
 * and reproducing that would buy nothing but a second lifetime to get wrong.
 *
 * ## What a built bundle still cannot do, stated rather than hidden
 *
 * `getCoverTransport` and `getPageTransport` hand the app a *client* for image
 * bytes. The ABI has no image-fetching plugin hook, so a source that gates an
 * image URL behind `this.covers.has(...)` is honoured for the URL and the host
 * fetches it plainly. Where an image needs a per-request header the source
 * declared on that transport, this build does not carry it yet, and the page
 * fails at the image rather than at the chapter.
 *
 * ## The source path
 *
 * A bare entry file is TypeScript against `@mana-app/types` — at runtime the
 * enums, `HttpClient`, and the `Source` base with `client`, `requestManager`,
 * `request`, `getBaseUrl`, `Manga`, `Chapter`, `SourceInfo` and `ContentRating`.
 * All of it is supplied here, and a name that is *not* supplied answers a stub
 * that throws with its own name when it is used — never an empty object, which
 * would fail later somewhere unrelated.
 */

import { BOOT_CONTEXT } from './boot-context';
import { CHEERIO_SOURCE } from './cheerio';
import { DIGESTS } from './digests';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { JS_LIBRARIES_SOURCE } from './js-libraries';
import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

export type ManaArtifact =
	/** A built `.mana`: minified CommonJS ending in `globalThis.Target = …`. */
	| { readonly kind: 'bundle'; readonly script: string }
	/**
	 * A source tree, already stripped and linked into one script, with the
	 * third-party packages it imports that the runtime supplies.
	 */
	| { readonly kind: 'source'; readonly script: string; readonly packages?: readonly string[] };

export interface ManaEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	readonly artifact: ManaArtifact;
}

/**
 * The ABI, once, over whichever entry the shim found.
 *
 * `__source()` is the only difference between the halves, so the mapping is
 * written once and both feed it. The manga pair is the whole surface: a Mana
 * source has no episode list and nothing playable.
 */
const ABI = `
/* --- chapters and pages -------------------------------------------------- */

/** One catalogue row, or null when it carries nothing a reader could open. */
function __entry(row) {
  if (!row || typeof row !== 'object') return null;
  var id = String(row.id || row.url || '');
  var title = String(row.title || row.name || '').trim();
  if (id.length === 0 || title.length === 0) return null;
  var entry = { sourceMediaId: id, title: title, alternativeTitles: [] };
  var cover = String(row.cover || row.image || '');
  if (cover.length > 0) entry.posterImageUrl = cover;
  return entry;
}

/**
 * A chapter's number, from the row or from its own label.
 *
 * Fractional, because 10.5 is a published chapter and not "chapter 10, part 2".
 * The label is read only when the row states nothing, and the word "chapter" is
 * removed first so a title carrying a volume number is not read as one.
 */
function __number(row, fallback) {
  var stated = Number(row.number !== undefined ? row.number : row.chapter);
  if (Number.isFinite(stated)) return stated;
  var name = String(row.title || row.name || '');
  var found = /(\\d+(?:\\.\\d+)?)/.exec(name.replace(/chapter/i, ''));
  if (found !== null) return Number(found[1]);
  var index = Number(row.index);
  return Number.isFinite(index) ? index : fallback;
}

function __chapter(row, fallback) {
  if (!row || typeof row !== 'object') return null;
  var id = String(row.chapterId || row.id || '');
  if (id.length === 0) return null;
  var number = __number(row, fallback);
  var chapter = {
    sourceChapterId: id,
    number: Number.isFinite(number) ? number : fallback
  };
  var title = String(row.title || row.name || '').trim();
  if (title.length > 0) chapter.title = title;
  var volume = Number(row.volume);
  if (Number.isFinite(volume) && volume > 0) chapter.volume = volume;
  if (typeof row.scanlator === 'string' && row.scanlator.length > 0) chapter.scanlator = row.scanlator;
  // Absent rather than epoch: a date of 1970 in a reader sorts every chapter to
  // the top of its own list.
  var when = row.date instanceof Date ? row.date : new Date(String(row.date || ''));
  if (!Number.isNaN(when.getTime()) && when.getTime() > 0) chapter.publishedAt = when.toISOString();
  return chapter;
}

/* --- the page transport, resolved before the host fetches ----------------- */

/** The app's origin tags for an image request: 1 a cover, 2 a page. */
var __ORIGIN_PAGE = 2;
var __IMAGE_DISPATCH = Symbol.for('mana.http.image.v1');

/**
 * While set, an image request is recorded instead of sent.
 *
 * Only an image request — one the transport dispatches with a cover or page
 * origin. A request a transport's own interceptor makes on the way (one
 * source fetches a viewer page to learn the image's address) goes out for
 * real, because its answer is what the image request is built from.
 */
var __capture = null;

/** Headers the host owns on any request, never the page's to set. */
var __HOST_HEADERS = { 'content-length': 1, host: 1, connection: 1, 'transfer-encoding': 1, 'accept-encoding': 1 };

function __interceptorCount(list) { return Array.isArray(list) ? list.length : 0; }

/**
 * A page as the source's transport would have requested it.
 *
 * The app does not fetch a Mana page image itself: it hands the request to
 * the client \`getPageTransport\` returns, whose request interceptors add a
 * Referer, an Origin, a signed address — and the ABI's page carries headers to
 * the byte fetch (§8.3) but cannot run a client. So the transport is run here,
 * once per page, with its send intercepted: what it would have sent becomes
 * the page's address and headers, and nothing is fetched twice.
 *
 * Response interceptors run too, on an empty stand-in for the image. One that
 * passes an image response through untouched — the common case, a status
 * check scoped to ordinary requests — costs nothing. One that **reads** the
 * image's body is transforming or inspecting bytes the host will fetch and
 * this code never sees, so the page is refused by name rather than handed to
 * the reader untransformed.
 */
async function __throughTransport(source, result) {
  if (typeof source.getPageTransport !== 'function') return result;
  var pages = [];
  for (var i = 0; i < result.pages.length; i++) {
    var page = result.pages[i];
    var transport = source.getPageTransport({ url: page.url, origin: __ORIGIN_PAGE });
    if (!transport || typeof transport !== 'object') { pages.push(page); continue; }
    var sent = await __dispatchImage(transport, page.url);
    var resolved = { index: page.index, url: sent === null ? page.url : sent.url };
    var headers = {};
    var has = false;
    var own = page.headers || {};
    for (var key in own) { headers[key] = own[key]; has = true; }
    if (sent !== null) {
      for (var name in sent.headers) {
        if (__HOST_HEADERS[String(name).toLowerCase()] === 1) continue;
        headers[name] = String(sent.headers[name]);
        has = true;
      }
    }
    if (has) resolved.headers = headers;
    pages.push(resolved);
  }
  return { pages: pages };
}

/** What the transport would have sent for one page, or null if it sent nothing. */
async function __dispatchImage(transport, url) {
  __capture = { request: null, bodyID: null, bodyRead: false };
  try {
    try {
      if (typeof transport[__IMAGE_DISPATCH] === 'function') {
        await transport[__IMAGE_DISPATCH]({ url: url, origin: __ORIGIN_PAGE }, undefined);
      } else if (typeof transport.__dispatchImage === 'function') {
        await transport.__dispatchImage(url, __ORIGIN_PAGE);
      } else {
        return null;
      }
    } catch (error) {
      if (__capture.request === null) throw error;
      throw __unreadable(String((error && error.message) || error));
    }
    if (__capture.bodyRead) throw __unreadable('it reads the image response itself');
    return __capture.request;
  } finally {
    __capture = null;
  }
}

function __unreadable(why) {
  return new Error(
    'This source loads its page images through a client that processes the image response (' + why + '). ' +
    'The host fetches page images itself, so that step cannot run, and the page would arrive untransformed.'
  );
}

/** One page list, from the shapes these sources return: strings or \`{url}\`. */
function __pages(value) {
  var rows = __array(value && value.pages !== undefined ? value.pages : value);
  var pages = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var url = typeof row === 'string' ? row : String((row && (row.url || row.imageUrl)) || '');
    if (url.length === 0 || !__isPlayable(url)) continue;
    var page = { index: pages.length, url: url };
    if (row && typeof row === 'object' && row.headers && typeof row.headers === 'object') {
      page.headers = row.headers;
    }
    pages.push(page);
  }
  return { pages: pages };
}

/**
 * A page from whatever the source answered, as the ABI's page.
 *
 * These sources state "more pages" as \`isLastPage\`, on the page rather than on
 * a row, and one of them may also answer a bare array.
 */
function __normalise(list) {
  var rows = list && Array.isArray(list.results) ? list.results : __array(list);
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var entry = __entry(rows[i]);
    if (entry !== null) entries.push(entry);
  }
  return {
    entries: entries,
    hasMore: list !== null && typeof list === 'object' && list.isLastPage === false
  };
}

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    var source = __source();
    var asked = String(query === null || query === undefined ? '' : query);
    var wanted = Number(page) > 0 ? Number(page) : 1;
    __checkout(source);
    return __search(source, asked, wanted);
  },

  async listChapters(sourceMediaId, ctx) {
    __enter(ctx);
    var source = __source();
    __checkout(source);
    await __prepare(source, String(sourceMediaId));
    var rows = __array(await __call(source, ['getChapters'], String(sourceMediaId)));

    var chapters = [];
    for (var i = 0; i < rows.length; i++) {
      var chapter = __chapter(rows[i], i + 1);
      if (chapter !== null) chapters.push(chapter);
    }
    // Ascending, oldest first: the number is the source's statement and the
    // order is a consequence of it, never the array's own.
    chapters.sort(function (a, b) { return a.number - b.number; });
    return chapters;
  },

  async readChapter(sourceMediaId, chapter, ctx) {
    __enter(ctx);
    var source = __source();
    __checkout(source);
    var target = chapter && chapter.sourceChapterId ? String(chapter.sourceChapterId) : '';
    if (target.length === 0) {
      throw new Error('This source listed no chapter id, so there is nothing to open.');
    }
    // The row the source minted travels back with the id. Some sources validate
    // it against the current list and refuse a descriptor that disagrees, which
    // is why the number here is the one that was handed out.
    var descriptor = { chapterId: target, id: target };
    if (chapter && Number.isFinite(Number(chapter.number))) descriptor.number = Number(chapter.number);
    if (chapter && typeof chapter.title === 'string') descriptor.title = chapter.title;

    await __prepare(source, String(sourceMediaId));
    // The older method is addressed by the chapter alone; the newer one by the
    // title and the chapter together, plus the row it handed out.
    var data = typeof source.getChapterDetails === 'function'
      ? await source.getChapterDetails(target)
      : await __call(source, ['getChapterData'], String(sourceMediaId), target, descriptor);
    return __throughTransport(source, __pages(data));
  }
};
`;

/**
 * The built-bundle half: the host bridge, then the bundle, then the ABI.
 *
 * The bundle runs at module scope, and it must, because that is where it assigns
 * `globalThis.Target` — inside a function its `var` declarations would be
 * scoped and the class would never appear. Nothing in it collides with this
 * runtime: it is minified to single letters plus `__polyfill__`, and every
 * global it wants it installs itself.
 */
function bundleEntrypoint(pluginId: string, script: string): string {
	return `${JS_RUNTIME}
${STREAM_GUARDS}
const __PLUGIN_ID = ${JSON.stringify(pluginId)};

/* --- the app's transport, as the bundle expects to find it ---------------- */

/** Response bodies, by the handle the bundle was given. */
var __bodies = Object.create(null);
var __nextBody = 0;

function __storeBody(bytes) {
  __nextBody += 1;
  var id = 'b' + __nextBody;
  __bodies[id] = bytes;
  return id;
}

/** The published \`HttpMethod\` numbering: Get 0, Head 1, Post 2, and on. */
var __METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * One bridge operation.
 *
 * Every unknown operation answers \`{}\` rather than throwing: the bundle has no
 * catch around most of these, and a lifetime hook that answers nothing is
 * invisible, where a rejection from one aborts a page load that was working.
 */
async function __bridgeSend(payload) {
  var operation = Number(payload && payload.operation);

  if (operation === 0) {
    var request = payload || {};
    var origin = Number(request.origin);
    if (__capture !== null && (origin === 1 || origin === 2)) {
      __capture.request = {
        url: String(request.url),
        method: __METHODS[Number(request.method)] || String(request.method || 'GET'),
        headers: request.headers && typeof request.headers === 'object' ? request.headers : {}
      };
      // An empty stand-in, so the transport completes. A response
      // interceptor that reads it is noticed (operation 1, below).
      __capture.bodyID = __storeBody(new Uint8Array(0));
      return { status: 200, url: String(request.url), headers: {}, bodyID: __capture.bodyID, sessionID: '' };
    }
    var init = {
      method: __METHODS[Number(request.method)] || 'GET',
      headers: request.headers && typeof request.headers === 'object' ? request.headers : {}
    };
    if (request.body !== undefined && request.body !== null) init.body = request.body;
    var raw = await __host().http.send(String(request.url), init);
    var bytes = await raw.bytes();
    return {
      status: raw.status,
      url: raw.url,
      headers: raw.headers,
      bodyID: __storeBody(bytes),
      sessionID: ''
    };
  }

  if (operation === 1) {
    if (__capture !== null && String(payload && payload.bodyID) === __capture.bodyID) __capture.bodyRead = true;
    var body = __bodies[String(payload && payload.bodyID)];
    if (body === undefined) throw new Error('This source read a response body that is no longer held.');
    // 1 is base64, 0 is text. The bundle reads images through the first.
    return { value: Number(payload.reader) === 1 ? __host().bytes.toBase64(body) : __host().text.decode(body) };
  }

  if (operation === 2) {
    delete __bodies[String(payload && payload.bodyID)];
    return {};
  }

  if (operation === 4) {
    var decoded = __host().bytes.fromBase64(String((payload && payload.value) || ''));
    return { bodyID: __storeBody(decoded), sessionID: '' };
  }

  return {};
}

globalThis.__manaHTTPBridge = {
  // No operation context is opened per call, so the bundle must not require one;
  // it opens one itself only when this flag says to.
  requiresOperation: false,
  metadataOnly: false,
  now: function () { return Date.now(); },
  get signal() { return __ctx === null ? undefined : __ctx.signal; },
  send: function (payload) { return __bridgeSend(payload); }
};

${BOOT_CONTEXT}

/* --- the source --------------------------------------------------------- */

${script}

function __target() {
  var found = globalThis.Target;
  if (typeof found !== 'function') {
    throw new Error('This converted source did not define a Target class.');
  }
  return found;
}

var __instance = null;

function __source() {
  if (__instance === null) __instance = new (__target())();
  return __instance;
}

/** Nothing to check out: the bundle's own base class owns its client. */
function __checkout() {}

/**
 * The details call a chapter list depends on.
 *
 * This ecosystem's sources cache a content policy and a revision from
 * \`getContent\` and refuse to list or open a chapter until it has run — one
 * measured source throws "Open details before reading" outright. The ABI has no
 * details step, so it is run here, once per title, and its result is discarded:
 * what the source kept is the point.
 */
var __prepared = Object.create(null);
function __prepare(source, id) {
  if (typeof source.getContent !== 'function') return Promise.resolve();
  if (__prepared[id] === undefined) {
    __prepared[id] = source.getContent(id).catch(function (error) {
      delete __prepared[id];
      throw error;
    });
  }
  return __prepared[id];
}

function __call(source, names, a, b, c) {
  for (var i = 0; i < names.length; i++) {
    if (typeof source[names[i]] === 'function') return source[names[i]](a, b, c);
  }
  throw new Error('This converted source does not implement ' + names.join(' or ') + '.');
}

async function __search(source, query, page) {
  // An empty query is the "browse" case the ABI cannot otherwise express; these
  // sources expose it as the home shelves.
  if (query.length === 0) {
    if (typeof source.getPopular === 'function') return __normalise(await source.getPopular(page));
    if (typeof source.getLatestUpdates === 'function') return __normalise(await source.getLatestUpdates(page));
  }
  return __normalise(
    await __call(source, ['getSearchResults', 'search'], { query: query, page: page, filters: {} })
  );
}

${ABI}`;
}

/**
 * The source half: the format's own runtime, then the file, then the ABI.
 *
 * Everything below is supplied because a source file calls it and nothing else
 * does. Where the ecosystem has more than one spelling of the same thing — a
 * client method called positionally and by object — both are read, because the
 * caller is whichever author wrote the file, not us.
 */
function sourceEntrypoint(pluginId: string, script: string, packages: readonly string[]): string {
	// The parser and the libraries over it are carried only when the source
	// imports one of them: they are most of a bundle's size, and a source that
	// reads JSON never reaches them.
	const libraries =
		packages.length === 0
			? ''
			: `${DOM_RUNTIME_SOURCE}
${DIGESTS}
${CHEERIO_SOURCE}
${JS_LIBRARIES_SOURCE}`;
	return `${JS_RUNTIME}
${STREAM_GUARDS}
${libraries}
const __PLUGIN_ID = ${JSON.stringify(pluginId)};

/* --- @mana-app/types, as the values a source can use --------------------- */

/**
 * A name this build does not provide, as a stub that names itself when called.
 *
 * Deferred rather than thrown at load: most of what a source imports from the
 * types package is a *type*, and only stripping types that happen to be spelled
 * one way would leave a source unable to load over a name nothing executes. A
 * stub is a function, so an unhelpful \`typeof Temphasis === 'function'\` check
 * would say yes — accepted, because the alternative is a load failure that
 * names no construct.
 */
function __manaMissing(name) {
  var stub = function () {
    throw new Error(
      'This converted source uses "' + name + '" from @mana-app/types, which Yorozo does not provide.'
    );
  };
  stub.__name = name;
  return stub;
}

function __manaEnum(names) {
  var value = {};
  for (var i = 0; i < names.length; i++) {
    value[names[i]] = i;
    value[i] = names[i];
  }
  return value;
}

var __HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/**
 * A response, in the shape these sources read: \`.text()\`, \`.json()\`, \`.ok\`,
 * and headers they ask with \`.get(name)\` as the published client's answer.
 */
function __manaResponse(raw, request) {
  return {
    status: raw.status,
    url: raw.url,
    headers: new __ManaHeaders(raw.headers || {}),
    request: request,
    get ok() { return raw.status >= 200 && raw.status < 300; },
    text: function () { return raw.text(); },
    json: function () { return raw.json(); },
    bytes: function () { return raw.bytes(); },
    requireOk: function () {
      if (raw.status < 200 || raw.status >= 300) {
        throw new Error('HTTP ' + raw.status + ' from ' + raw.url);
      }
      return this;
    }
  };
}

/**
 * The client a source builds with \`new HttpClient()\`.
 *
 * The builder members all answer \`this\`, which is what makes a chained
 * initialiser work; the rate limit and timeout are declared to the host rather
 * than enforced here. Interceptors run in the order they were added, on every
 * request, because a source that installs one expects its headers to be there.
 */
/**
 * A request's headers, as the types package hands them to an interceptor.
 *
 * Both spellings a source writes work: the methods (\`headers.has\`,
 * \`headers.set\`) the published \`HttpHeaders\` has, and plain property reads
 * and writes, because that class keeps each header as an own property too.
 * Names are matched case-insensitively and stored lowercased.
 */
/**
 * A body as the published \`Body\` builders describe one — \`{ kind, value,
 * contentType }\` — onto the wire, as the published client puts it there; a
 * plain string or bytes as written; anything else as JSON, which is what the
 * older sources hand \`request\` directly.
 */
function __wireBody(body, headers) {
  if (typeof body === 'string' || body instanceof Uint8Array) return body;
  if (body && typeof body === 'object' && typeof body.kind === 'number' && 'value' in body) {
    if (body.contentType && !Object.keys(headers).some(function (name) { return name.toLowerCase() === 'content-type'; })) {
      headers['content-type'] = body.contentType;
    }
    if (body.kind === 0) return JSON.stringify(body.value);
    if (body.kind === 1) {
      var pairs = [];
      for (var key in body.value || {}) {
        var values = Array.isArray(body.value[key]) ? body.value[key] : [body.value[key]];
        for (var i = 0; i < values.length; i++) pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(values[i])));
      }
      return pairs.join('&');
    }
    if (body.kind === 2) return String(body.value);
    if (body.kind === 3) return new Uint8Array(body.value);
  }
  return JSON.stringify(body);
}

/** The published body builders: a description the client puts on the wire. */
var __manaBody = {
  json: function (value) { return { kind: 0, value: JSON.parse(JSON.stringify(value)), contentType: 'application/json' }; },
  form: function (value) { return { kind: 1, value: JSON.parse(JSON.stringify(value)), contentType: 'application/x-www-form-urlencoded' }; },
  text: function (value, contentType) { return { kind: 2, value: value, contentType: contentType || 'text/plain; charset=utf-8' }; },
  bytes: function (value, contentType) { return { kind: 3, value: new Uint8Array(value), contentType: contentType || 'application/octet-stream' }; }
};

class __ManaHeaders {
  constructor(initial) {
    var from = initial || {};
    if (typeof from.toJSON === 'function') from = from.toJSON();
    for (var key in from) if (from[key] !== undefined && from[key] !== null) this.set(key, from[key]);
  }
  get(name) { var value = this[String(name).toLowerCase()]; return value === undefined ? null : String(value); }
  has(name) { return this.get(name) !== null; }
  set(name, value) {
    this.delete(name);
    Object.defineProperty(this, String(name).toLowerCase(), { value: String(value), writable: true, enumerable: true, configurable: true });
    return this;
  }
  setAll(headers) { for (var key in headers || {}) this.set(key, headers[key]); return this; }
  delete(name) {
    var wanted = String(name).toLowerCase();
    for (var key of Object.keys(this)) if (key.toLowerCase() === wanted) delete this[key];
    return this;
  }
  entries() { return Object.entries(this)[Symbol.iterator](); }
  keys() { return Object.keys(this)[Symbol.iterator](); }
  forEach(fn) { for (var key of Object.keys(this)) fn(this[key], key); }
  toJSON() { return Object.assign({}, this); }
}

class HttpClient {
  constructor() {
    this.interceptors = [];
    this.responseInterceptors = [];
    this.headers = {};
  }
  setRateLimit() { return this; }
  setRateLimiter() { return this; }
  setTimeoutMs() { return this; }
  setRetryPolicy() { return this; }
  setRetry() { return this; }
  setBaseURL(url) { this.baseURL = String(url); return this; }
  addHeader(name, value) { this.headers[String(name)] = String(value); return this; }
  removeHeader(name) {
    for (var key in this.headers) if (key.toLowerCase() === String(name).toLowerCase()) delete this.headers[key];
    return this;
  }
  addHeaders(headers) { Object.assign(this.headers, headers || {}); return this; }
  setHeaders(headers) { this.headers = Object.assign({}, headers); return this; }
  addRequestInterceptor(fn) { if (typeof fn === 'function') this.interceptors.push(fn); return this; }
  addResponseInterceptor(fn) { if (typeof fn === 'function') this.responseInterceptors.push(fn); return this; }
  removeRequestInterceptor(fn) { this.interceptors = this.interceptors.filter(function (one) { return one !== fn; }); return this; }
  removeResponseInterceptor(fn) { this.responseInterceptors = this.responseInterceptors.filter(function (one) { return one !== fn; }); return this; }
  close() {}

  async request(a, b, c, d) {
    // Two call shapes: '\`request({ url, method, headers, body })\`' and the
    // positional '\`request(url, method, headers, body)\`'. The second is what the
    // older sources in this ecosystem write.
    var request = null;
    var positional = typeof a === 'string';
    if (positional) {
      request = { url: a, method: typeof b === 'string' ? b : 'GET', headers: c, body: d };
    } else {
      request = Object.assign({}, a || {});
      if (b && typeof b === 'object' && b.headers) request.headers = Object.assign({}, b.headers, request.headers || {});
    }
    return this.__execute(request, 0);
  }

  /**
   * One request, through the interceptors in order.
   *
   * An interceptor may change the request in place or answer a new one, and
   * may be async — the published client awaits each and takes what it
   * answers; a version that called them synchronously and ignored the answer
   * dropped every header an async interceptor set.
   */
  async __execute(input, origin) {
    var request = Object.assign({}, input);
    // A method is the published enum's number or a name; '0' on the wire is
    // what a number read as a name became.
    request.method = typeof request.method === 'number'
      ? (__HTTP_METHODS[request.method] || 'GET')
      : String(request.method || 'GET').toUpperCase();
    if (this.baseURL && !/^[a-z][a-z0-9+.-]*:/i.test(String(request.url))) {
      request.url = new URL(String(request.url), this.baseURL).toString();
    }
    request.headers = new __ManaHeaders(Object.assign({}, this.headers, (request.headers && typeof request.headers.toJSON === 'function') ? request.headers.toJSON() : (request.headers || {})));
    var context = { origin: origin, attempt: 1, metadata: {} };

    for (var i = 0; i < this.interceptors.length; i++) {
      var changed = await this.interceptors[i](request, context);
      if (changed && typeof changed === 'object') request = changed;
    }
    var headers = request.headers && typeof request.headers.toJSON === 'function' ? request.headers.toJSON() : Object.assign({}, request.headers || {});

    var response;
    if (__capture !== null && (origin === 1 || origin === 2)) {
      __capture.request = { url: String(request.url), method: request.method, headers: headers };
      var capture = __capture;
      var read = function (value) { return async function () { capture.bodyRead = true; return value; }; };
      response = __manaResponse({ status: 200, url: String(request.url), headers: {}, text: read(''), json: read(null), bytes: read(new Uint8Array(0)) }, request);
      for (var k = 0; k < this.responseInterceptors.length; k++) {
        var passed = await this.responseInterceptors[k](response, context);
        if (passed && typeof passed === 'object') response = passed;
      }
      return response;
    }

    var init = { method: request.method, headers: headers };
    if (request.body !== undefined && request.body !== null) {
      init.body = __wireBody(request.body, headers);
    }
    var raw = await __host().http.send(String(request.url), init);
    response = __manaResponse(raw, request);
    for (var j = 0; j < this.responseInterceptors.length; j++) {
      var answered = await this.responseInterceptors[j](response, context);
      if (answered && typeof answered === 'object') response = answered;
    }
    return response;
  }

  /** The app's image path: a GET at a cover or page origin. */
  __dispatchImage(url, origin) { return this.__execute({ url: url, method: 'GET' }, origin); }

  get(url, options) { return this.request({ url: url, method: 'GET', headers: options && options.headers }); }
  post(url, body, options) {
    return this.request({ url: url, method: 'POST', body: body, headers: options && options.headers });
  }
}

/**
 * \`ObjectStore\`, the app's per-source key-value store, as a global.
 *
 * Held for the isolate's lifetime. The app keeps it across launches; the ABI's
 * persistent store is a permission a converted bundle does not ask for, so a
 * cached catalogue or a remembered mirror is re-learned once per run instead
 * — slower, never wrong, since every measured use is a cache in front of a
 * request the source can make again.
 */
var __objectStore = new Map();
globalThis.ObjectStore = {
  get: async function (key) { return __objectStore.has(String(key)) ? __objectStore.get(String(key)) : null; },
  set: async function (key, value) { __objectStore.set(String(key), value); },
  remove: async function (key) { __objectStore.delete(String(key)); },
  string: async function (key) { var v = __objectStore.get(String(key)); return typeof v === 'string' ? v : null; },
  boolean: async function (key) { return __objectStore.get(String(key)) === true; },
  number: async function (key) { var v = __objectStore.get(String(key)); return typeof v === 'number' ? v : null; }
};

/** The request manager the framework would have handed a source. */
var __requestManager = {
  schedule: function (work) { return typeof work === 'function' ? work() : work; },
  getDefaultUserAgent: function () { return 'Yorozo'; },
  setUserAgent: function () {},
  registerInterceptor: function () { return function () {}; },
  setCookieHeaderProvider: function () {},
  resetRateLimitState: function () {},
  resetImageFastWindowForGallery: function () {},
  resetCoverPacing: function () {},
  setSyncGG: function () {},
  cookieStore: { get: function () { return null; }, set: function () {} }
};

/** The base a source extends. */
class Source {
  constructor() {
    this.client = new HttpClient();
  }
  get requestManager() { return __requestManager; }

  async getBaseUrl() {
    return String((this.info && this.info.website) || '');
  }

  /** '\`request(path, method, { params, query, body })\`', against the base url. */
  request(path, method, options) {
    var base = String((this.info && this.info.website) || '').replace(/\\/+$/, '');
    var url = path.startsWith('http') ? path : base + (path.charAt(0) === '/' ? path : '/' + path);
    var chosen = options || {};
    for (var key in chosen.params || {}) {
      url = url.replace('{' + key + '}', encodeURIComponent(String(chosen.params[key])));
    }
    if (chosen.query) {
      var pairs = [];
      for (var name in chosen.query) {
        var value = chosen.query[name];
        if (value === undefined || value === null) continue;
        pairs.push(encodeURIComponent(name) + '=' + encodeURIComponent(String(value)));
      }
      if (pairs.length > 0) url += (url.indexOf('?') < 0 ? '?' : '&') + pairs.join('&');
    }
    return this.client.request({
      url: url,
      method: method || 'GET',
      headers: chosen.headers,
      body: chosen.body
    });
  }
}

/** Types these sources use in value positions. */
class Manga {
  constructor(fields) { Object.assign(this, fields || {}); }
}
class Chapter {
  constructor(fields) { Object.assign(this, fields || {}); }
}
class SourceInfo {
  constructor(fields) { Object.assign(this, fields || {}); }
}

const __manaKnown = {
  HttpClient: HttpClient,
  HttpHeaders: __ManaHeaders,
  Body: __manaBody,
  Source: Source,
  Manga: Manga,
  Chapter: Chapter,
  SourceInfo: SourceInfo,
  UPSTREAM_SOURCE: 'upstream',
  // The two ratings differ in name only and in scale; both are read as the
  // number the ecosystem's own bundles carry.
  ContentRating: __manaEnum(['SAFE', 'SUGGESTIVE', 'MATURE', 'EXPLICIT']),
  CatalogRating: __manaEnum(['SAFE', 'MIXED', 'EXPLICIT']),
  ContentType: __manaEnum(['MANGA', 'MANHWA', 'MANHUA', 'COMIC', 'NOVEL']),
  PublicationStatus: __manaEnum(['UNKNOWN', 'ONGOING', 'COMPLETED', 'HIATUS', 'CANCELLED']),
  ReadingMode: __manaEnum(['PAGED_MANGA', 'PAGED_COMIC', 'WEBTOON']),
  HttpMethod: __manaEnum(['Get', 'Head', 'Post', 'Put', 'Patch', 'Delete', 'Options']),
  // The published limiter factories. The client below hands pacing to the host
  // rather than running a limiter, so these only need to build what a source
  // passes to setRateLimiter.
  RateLimit: {
    spaced: function (options) { return { tryAcquire: function () { return { action: 0 }; }, options: options }; },
    tokenBucket: function (options) { return { tryAcquire: function () { return { action: 0 }; }, options: options }; }
  },
  SectionStyle: __manaEnum([
    'SimpleSingleRow', 'SimpleDoubleRow', 'SimpleHero', 'SimpleHeroPaged',
    'DetailedSingleRowPaged', 'DetailedDoubleRowPaged', 'DetailedVerticalList',
    'DetailedVerticalListGrouped'
  ]),
  AdditionalInfoType: __manaEnum(['Highlights', 'Tags', 'Staff', 'Links']),
  // The search-form builders, as the published @mana-app/types defines them:
  // each returns its props with a type tag (and a presentation for the menu
  // and sheet spellings). They describe a filter form the ABI never draws —
  // a search here is a query and a page — so the form is built and goes
  // unread, exactly as it does when the same source runs from its built
  // bundle, which carries these same factories.
  FilterType: __manaEnum(['TOGGLE', 'SELECT', 'MULTISELECT', 'EXCLUDABLE_MULTISELECT', 'TEXT', 'STEPPER', 'DATEPICKER']),
  SearchSectionType: __manaEnum(['LIST', 'TAGS', 'SORT']),
  SearchToggle: function (props) { return Object.assign({}, props, { type: 0 }); },
  SearchPicker: function (props) { return Object.assign({}, props, { type: 1 }); },
  SearchMenuPicker: function (props) { return Object.assign({}, props, { type: 1, presentation: 'menu' }); },
  SearchPickerSheet: function (props) { return Object.assign({}, props, { type: 1, presentation: 'sheet' }); },
  SearchMultiPicker: function (props) { return Object.assign({}, props, { type: 2 }); },
  SearchMultiPickerSheet: function (props) { return Object.assign({}, props, { type: 2, presentation: 'sheet' }); },
  SearchExcludableMultiPicker: function (props) { return Object.assign({}, props, { type: 3 }); },
  SearchExcludableMultiPickerSheet: function (props) { return Object.assign({}, props, { type: 3, presentation: 'sheet' }); },
  SearchTextField: function (props) { return Object.assign({}, props, { type: 4 }); },
  SearchStepper: function (props) { return Object.assign({}, props, { type: 5 }); },
  SearchDatePicker: function (props) { return Object.assign({}, props, { type: 6 }); },
  SearchGroup: function (props) {
    if (!props || !props.children || props.children.length === 0) throw new Error('SearchGroup requires at least one child');
    if (props.children.some(function (child) { return child && child.kind === 'group'; })) {
      throw new Error('SearchGroup cannot contain another SearchGroup');
    }
    return Object.assign({}, props, { kind: 'group' });
  },
  SearchListSection: function (props) {
    var children = [];
    var groups = [];
    for (var i = 0; i < props.children.length; i++) {
      var item = props.children[i];
      if (!(item && item.kind === 'group')) { children.push(item); continue; }
      groups.push({ id: item.id, title: item.title, fieldIds: item.children.map(function (child) { return child.id; }) });
      children.push.apply(children, item.children);
    }
    return Object.assign({ type: 0, header: props.header, footer: props.footer, children: children }, groups.length > 0 ? { groups: groups } : {});
  },
  SearchTagsSection: function (props) { return Object.assign({}, props, { type: 1 }); },
  SearchSortSection: function (props) { return Object.assign({}, props || {}, { type: 2 }); },
  BasicAuthenticationUIIdentifier: __manaEnum(['EMAIL', 'USERNAME']),
  HttpBodyKind: __manaEnum(['Json', 'Form', 'Text', 'Bytes']),
  // The published numbering: General 0, Cover 1, Page 2. 'Default' is the
  // older spelling of the first.
  RequestOrigin: { General: 0, Default: 0, Cover: 1, Page: 2, 0: 'General', 1: 'Cover', 2: 'Page' },
  RateLimitAction: __manaEnum(['Allow', 'Wait']),
  // Error classes only need a name to be caught or constructed.
  CloudflareError: class extends Error {},
  NetworkError: class extends Error {},
  TimeoutError: class extends Error {},
  HttpStatusError: class extends Error {},
  AbortError: class extends Error {}
};

/** The types package, with a stub for every name not listed above. */
var __manaTypes = new Proxy(__manaKnown, {
  get: function (known, key) {
    if (key in known) return known[key];
    if (typeof key !== 'string') return undefined;
    var made = __manaMissing(key);
    known[key] = made;
    return made;
  }
});

var __baseRequire = require;
require = function (name) {
  var id = String(name);
  if (id.indexOf('@mana-app/types') === 0) return __manaTypes;
  if (id === 'cheerio' && typeof __cheerio !== 'undefined') return __cheerio;
  if (id === 'html-entities' && typeof __htmlEntities !== 'undefined') return __htmlEntities;
  if (id === 'crypto-js' && typeof __cryptoJs !== 'undefined') return __cryptoJs;
  return __baseRequire(id);
};

/* --- the source --------------------------------------------------------- */

const __Extension = (function () {
${script}

  return typeof Target === 'function' ? Target : null;
})();

var __instance = null;

function __source() {
  if (__instance === null) {
    if (__Extension === null) {
      throw new Error('This converted source does not declare a Target class.');
    }
    __instance = new __Extension();
  }
  return __instance;
}

/** The base url is stateful here, so it is refreshed before each call. */
async function __checkout(source) {
  if (typeof source.getBaseUrl !== 'function') return;
  var base = await source.getBaseUrl();
  if (typeof base === 'string' && base.length > 0) source.baseUrl = base;
}

/**
 * The details call a chapter list depends on, where the source has one.
 *
 * A sixth-of-a-second request that establishes state the chapter list reads,
 * run once per title and discarded — see the bundle half's note.
 */
var __prepared = Object.create(null);
function __prepare(source, id) {
  if (typeof source.getMangaDetails !== 'function') return Promise.resolve();
  if (__prepared[id] === undefined) {
    __prepared[id] = source.getMangaDetails(id).catch(function (error) {
      delete __prepared[id];
      throw error;
    });
  }
  return __prepared[id];
}

function __call(source, names, a, b, c) {
  for (var i = 0; i < names.length; i++) {
    if (typeof source[names[i]] === 'function') return source[names[i]](a, b, c);
  }
  throw new Error('This converted source does not implement ' + names.join(' or ') + '.');
}

async function __search(source, query, page) {
  if (query.length === 0) {
    if (typeof source.getPopular === 'function') return __normalise(await source.getPopular(page));
    if (typeof source.getLatestUpdates === 'function') return __normalise(await source.getLatestUpdates(page));
  }
  if (typeof source.getSearchResults === 'function') {
    return __normalise(await source.getSearchResults(query, page));
  }
  return __normalise(await __call(source, ['search'], query, page));
}

${ABI}`;
}

export function manaEntrypoint(options: ManaEntrypointOptions): string {
	return options.artifact.kind === 'bundle'
		? bundleEntrypoint(options.pluginId, options.artifact.script)
		: sourceEntrypoint(options.pluginId, options.artifact.script, options.artifact.packages ?? []);
}
