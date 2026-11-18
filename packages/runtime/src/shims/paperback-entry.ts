/**
 * Paperback extensions, as a converted plugin.
 *
 * ## What one of these is
 *
 * A single already-bundled script whose tail is
 *
 * ```js
 * var source=(function(e){ …; return e.ExampleExtension=Example, e })({});
 * ```
 *
 * so the exported namespace is a bag of classes. Nothing here translates the
 * script; the whole job is the `Application` global its classes call, which is
 * the host surface the Paperback app would have supplied.
 *
 * ## Why the shim is this large and still refuses
 *
 * `Application` is not a small surface. Measured across the published corpus it
 * is dominated by `Selector`, the state store, `scheduleRequest` and the HTML
 * helpers — every one of them reached by ordinary sources, not by a minority —
 * and the dozen names after those (`fetchDocument`, `createRequest`,
 * `crypto_md5Hash`, `executeInWebView`) are what make the rest of the corpus
 * convert rather than throw. So they are implemented.
 *
 * What is *not* implemented throws with its own name. An `Application` that
 * answered an unknown member with `undefined` would let a source load, then
 * fail three frames later inside its own parser with "undefined is not a
 * function", which names neither this build nor the member it lacks.
 *
 * `executeInWebView` is the one deliberate refusal: a WebView is a second
 * JavaScript realm with a DOM and a network of its own, and answering it with
 * a plain function would silently run the injected script against the wrong
 * document. The twelve sources that use it are refused by name at call time
 * instead of being wrong quietly.
 *
 * ## Selectors
 *
 * The ecosystem passes callbacks between a class and the app as *selector
 * tokens*: `Application.Selector(instance, "name")` stores the bound method and
 * returns an opaque id, and `SelectorRegistry.selector(id)` looks it back up.
 * Both are needed because the bundles use the pair to register interceptors and
 * form handlers, and the shim's request path honours the first.
 *
 * ## Chapters
 *
 * The ABI's three manga methods are dispatched to whichever export carries the
 * matching interface members (`getSearchResults`, `getChapters`,
 * `getChapterDetails`). No export is required to carry all three: a source that
 * implements search only still converts and lists.
 *
 * The export is the *instance* the bundle builds under the extension's own id
 * when there is one — `e.Example = new class extends Base { constructor() {
 * super({ domain: … }) } }` is how a template-built source is published, and
 * the app reads that object. Constructing a class instead loses whatever the
 * bundle passed its constructor, and an instance-only bundle had no class to
 * construct at all. A class is the fallback, built with no arguments.
 *
 * ## Paging
 *
 * A search answers `{ items, metadata }`: `metadata` is the source's own
 * cursor, opaque here, and the next page is asked for by handing it back. The
 * first page is asked for with `undefined`, as the app does — a source writes
 * `metadata?.page ?? 1`, and one that sends the cursor straight to its API
 * sent the object this shim made up instead. So the cursor each page returned
 * is kept, per query, and page N is asked for with page N-1's; a page asked
 * for out of order walks forward to it. A missing cursor is the last page.
 *
 * `items` is what this format's 0.9 toolchain returns. `results` is the older
 * toolchain's spelling of the same page, read when `items` is absent.
 */

import { JS_RUNTIME } from './js-runtime';
import { DIGESTS } from './digests';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';

export interface PaperbackEntrypointOptions {
	/** The converted plugin's id, which must equal the manifest's. */
	readonly pluginId: string;
	/**
	 * The extension's own id, which the bundle publishes its instance under.
	 * Absent, the export is chosen by the interface it carries alone.
	 */
	readonly foreignId?: string;
	/** The extension's published bundle, verbatim. */
	readonly script: string;
}

export function paperbackEntrypoint(options: PaperbackEntrypointOptions): string {
	return `${DOM_RUNTIME_SOURCE}
${DIGESTS}
${JS_RUNTIME}

const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};
const __FOREIGN_ID = ${JSON.stringify(options.foreignId ?? '')};

/** Whether this realm has a node-shaped global; both have \`globalThis\`. */
var __root = globalThis;

/* --- the Application global ---------------------------------------------- */

var __dom = __root.__yorozoRuntime;

/*
 * Redeclared over the shared runtime's versions, which decode through the host
 * and therefore need a \`ctx\`. A source that calls \`atob\` from a property
 * initialiser does so while the module is being imported, before any plugin
 * call has started, and the host-backed pair throws there. These two are pure
 * functions of their input, so they need no host at all.
 */
atob = function (value) { return __dom.base64Decode(String(value)); };
btoa = function (value) { return __dom.base64Encode(String(value)); };

var __state = new Map();
var __secure = new Map();
var __selectors = new Map();
var __selectorSeq = 0;
var __interceptors = new Map();
var __redirectHandler = null;
var __boundCheerio = null;
var __userAgent = null;

/**
 * A selector token for 'target[key]'.
 *
 * Bound to its target now rather than at call time: the bundles register a
 * method once and then call the token later, and an unbound call would lose
 * 'this' and read the class's own fields from undefined.
 */
function __selector(target, key) {
  var fn = typeof target === 'function' ? target : target[key];
  if (typeof fn !== 'function') {
    throw new Error('Application.Selector(target, "' + String(key) + '"): that member is not a function.');
  }
  var id = 'selector-' + (++__selectorSeq);
  __selectors.set(id, fn.bind(target));
  return id;
}

function __resolveSelector(token) {
  if (typeof token === 'function') return token;
  var found = __selectors.get(token);
  if (found === undefined) {
    throw new Error('Application.SelectorRegistry.selector("' + String(token) + '"): no such selector.');
  }
  return found;
}

/** A cheerio-shaped selection over the bundle's own DOM. */
function __selection(nodes, doc) {
  var api = {
    length: nodes.length,
    __nodes: nodes,
    toArray: function () { return nodes.slice(); },
    get: function (i) { return i === undefined ? nodes.slice() : nodes[i < 0 ? nodes.length + i : i]; },
    eq: function (i) { var at = i < 0 ? nodes.length + i : i; return __selection(at >= 0 && at < nodes.length ? [nodes[at]] : [], doc); },
    first: function () { return api.eq(0); },
    last: function () { return api.eq(nodes.length - 1); },
    slice: function (a, b) { return __selection(nodes.slice(a, b), doc); },
    find: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) out = out.concat(nodes[i].select(String(selector)));
      return __selection(out, doc);
    },
    children: function (selector) {
      var kids = [];
      for (var i = 0; i < nodes.length; i++) kids = kids.concat(nodes[i].children);
      var out = __selection(kids, doc);
      return selector === undefined ? out : out.filter(selector);
    },
    parent: function () {
      var up = [];
      for (var i = 0; i < nodes.length; i++) {
        var parent = nodes[i].parent;
        if (parent !== null && parent !== undefined && up.indexOf(parent) === -1) up.push(parent);
      }
      return __selection(up, doc);
    },
    next: function () {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var next = nodes[i].nextElementSibling();
        if (next !== null) out.push(next);
      }
      return __selection(out, doc);
    },
    prev: function () {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var previous = nodes[i].previousElementSibling();
        if (previous !== null) out.push(previous);
      }
      return __selection(out, doc);
    },
    text: function () {
      var value = '';
      for (var i = 0; i < nodes.length; i++) value += nodes[i].text();
      return value;
    },
    html: function () { return nodes.length === 0 ? null : nodes[0].html(); },
    attr: function (name) {
      if (nodes.length === 0) return undefined;
      var value = nodes[0].attr(String(name));
      return value === '' && !nodes[0].hasAttr(String(name)) ? undefined : value;
    },
    removeAttr: function (name) {
      for (var i = 0; i < nodes.length; i++) nodes[i].removeAttr(String(name));
      return api;
    },
    val: function () { return nodes.length === 0 ? undefined : nodes[0].val(); },
    is: function (selector) {
      for (var i = 0; i < nodes.length; i++) {
        var owner = nodes[i].ownerDocument();
        if (owner !== null && owner.select(String(selector)).indexOf(nodes[i]) !== -1) return true;
      }
      return false;
    },
    hasClass: function (name) {
      for (var i = 0; i < nodes.length; i++) if (nodes[i].hasClass(String(name))) return true;
      return false;
    },
    each: function (fn) {
      for (var i = 0; i < nodes.length; i++) fn.call(nodes[i], i, nodes[i]);
      return api;
    },
    map: function (fn) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) out.push(fn.call(nodes[i], i, nodes[i]));
      return { length: out.length, get: function () { return out; }, toArray: function () { return out; } };
    },
    filter: function (test) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var keep = typeof test === 'function'
          ? test.call(nodes[i], i, nodes[i])
          : __selection([nodes[i]], doc).is(test);
        if (keep) out.push(nodes[i]);
      }
      return __selection(out, doc);
    },
    closest: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var found = nodes[i].closest(String(selector));
        if (found !== null && out.indexOf(found) === -1) out.push(found);
      }
      return __selection(out, doc);
    },
    remove: function () {
      for (var i = 0; i < nodes.length; i++) nodes[i].remove();
      return api;
    }
  };
  return api;
}

/** \`cheerio.load(html)\`, which is the only entry point this ecosystem uses. */
function __cheerioLoad(html) {
  var doc = __dom.parseHtml(String(html === null || html === undefined ? '' : html));
  var $ = function (what, context) {
    if (what === null || what === undefined) return __selection([], doc);
    if (typeof what === 'object') {
      return __selection(what.__nodes !== undefined ? what.__nodes : [what], doc);
    }
    var roots = context === undefined
      ? [doc]
      : (typeof context === 'object' && context.__nodes !== undefined ? context.__nodes : [context]);
    var out = [];
    for (var i = 0; i < roots.length; i++) out = out.concat(roots[i].select(String(what)));
    return __selection(out, doc);
  };
  $.html = function (node) { return node === undefined ? doc.html() : __selection([node], doc).html(); };
  $.root = function () { return __selection([doc], doc); };
  $.xml = function () { return $.apply(null, arguments); };
  return $;
}

/** Cookies in a response's 'set-cookie', in the shape interceptors expect. */
function __cookiesOf(headers) {
  var out = [];
  for (var key in headers) {
    if (key.toLowerCase() !== 'set-cookie') continue;
    var raw = headers[key];
    var list = Array.isArray(raw) ? raw : String(raw).split(/\\n/);
    for (var i = 0; i < list.length; i++) {
      var pair = String(list[i]).split(';')[0];
      var cut = pair.indexOf('=');
      if (cut <= 0) continue;
      out.push({ name: pair.slice(0, cut).trim(), value: pair.slice(cut + 1).trim() });
    }
  }
  return out;
}

/**
 * One request through the registered interceptors and the host's network.
 *
 * The interceptor chain is honoured rather than stubbed: the corpus installs
 * cookie stores, rate limiters and Cloudflare handlers through it, and a
 * request that skipped them would carry no session and pace nothing.
 */
async function __scheduleRequest(init) {
  var call = init || {};
  var url = String(call.url || '') + String(call.param || '');
  if (url.length === 0) throw new Error('Application.scheduleRequest: the request names no url.');

  var request = {
    url: url,
    method: String(call.method || 'GET').toUpperCase(),
    headers: call.headers || {},
    body: call.body === undefined ? call.data : call.body,
    cookies: call.cookies || {}
  };

  var chain = [];
  __interceptors.forEach(function (pair) { chain.push(pair); });
  for (var i = 0; i < chain.length; i++) {
    if (chain[i].request === null) continue;
    var next = await chain[i].request(request);
    if (next !== undefined && next !== null) request = next;
  }

  var headers = {};
  for (var name in request.headers || {}) headers[name] = request.headers[name];
  var cookieHeader = [];
  var cookies = request.cookies || {};
  for (var cookie in cookies) cookieHeader.push(cookie + '=' + cookies[cookie]);
  if (cookieHeader.length > 0 && headers['cookie'] === undefined) headers['cookie'] = cookieHeader.join('; ');

  var options = { method: request.method, headers: headers, body: request.body === undefined ? null : request.body };
  if (request.follow === false) options.redirect = 'manual';

  var raw = await fetchv2(request.url, options);
  var data = new Uint8Array(await (await raw.text(), raw.text === undefined ? '' : raw.text()));
  // \`text()\` is repeatable on the host response, but reading it twice through
  // the async surface is cheap and keeps this exact for a body the shim's
  // interceptors then rewrite.
  data = new TextEncoder().encode(await raw.text());

  var response = {
    status: raw.status,
    url: raw.url,
    headers: raw.headers || {},
    request: request,
    cookies: __cookiesOf(raw.headers || {})
  };

  if (__redirectHandler !== null && response.status >= 300 && response.status < 400) {
    var followed = await __redirectHandler(response, request);
    if (followed !== undefined && followed !== null) {
      return __scheduleRequest(typeof followed === 'string' ? { url: followed } : followed);
    }
  }

  var body = data;
  for (var j = 0; j < chain.length; j++) {
    if (chain[j].response === null) continue;
    var rewritten = await chain[j].response(request, response, body);
    if (rewritten !== undefined && rewritten !== null) body = rewritten;
  }
  return [response, body];
}

function __required(member) {
  return function () {
    throw new Error(
      'This converted Paperback source called Application.' + member +
        ', which this build does not implement.'
    );
  };
}

var Application = {
  /* state, in the ecosystem's (value, key) order */
  getState: function (key) { return __state.get(key); },
  setState: function (value, key) {
    if (value === undefined || value === null) __state.delete(key);
    else __state.set(key, value);
  },
  getSecureState: function (key) { return __secure.get(key); },
  setSecureState: function (value, key) {
    if (value === undefined || value === null) __secure.delete(key);
    else __secure.set(key, value);
  },
  resetAllState: function () { __state.clear(); __secure.clear(); },
  isResourceLimited: false,

  /* selectors */
  Selector: __selector,
  selector: __selector,
  SelectorRegistry: { selector: __resolveSelector },

  /* lifecycle */
  formDidChange: function () {},
  invalidateDiscoverSections: function () {},
  invalidateSearchFilters: function () {},
  sleep: function (ms) { return new Promise(function (done) { setTimeout(done, Number(ms) || 0); }); },
  setTimeout: function (fn, ms) { return setTimeout(fn, ms); },
  global_setTimeout: function (fn, ms) { return setTimeout(fn, ms); },

  /* network */
  scheduleRequest: __scheduleRequest,
  createRequest: function (init) {
    return {
      url: String(init.url || '') + String(init.param || ''),
      method: String(init.method || 'GET').toUpperCase(),
      headers: init.headers || {},
      data: init.body,
      cookies: init.cookies || {}
    };
  },
  fetchText: async function (init) {
    var pair = await __scheduleRequest(init);
    return new TextDecoder().decode(pair[1]);
  },
  fetchJSON: async function (init) {
    return JSON.parse(await Application.fetchText(init));
  },
  loadDocument: function (html) {
    if (__boundCheerio !== null && typeof __boundCheerio.load === 'function') {
      return __boundCheerio.load(html);
    }
    return __cheerioLoad(html);
  },
  fetchDocument: async function (init) {
    return Application.loadDocument(await Application.fetchText(init));
  },
  registerInterceptor: function (id, request, response) {
    __interceptors.set(id, {
      request: request === undefined || request === null ? null : __resolveSelector(request),
      response: response === undefined || response === null ? null : __resolveSelector(response)
    });
  },
  unregisterInterceptor: function (id) { __interceptors.delete(id); },
  setRedirectHandler: function (token) {
    __redirectHandler = token === undefined || token === null ? null : __resolveSelector(token);
  },
  getDefaultUserAgent: async function () {
    if (__userAgent !== null) return __userAgent;
    __userAgent = 'Yorozo/1.0 (Paperback conversion)';
    return __userAgent;
  },
  bind: function (manager, cheerio) {
    if (manager && typeof manager.schedule === 'function') __boundCheerio = cheerio || null;
  },
  createRequestManager: function (options) {
    return {
      interceptor: options && options.interceptor,
      requestTimeout: options && options.requestTimeout,
      requestsPerSecond: options && options.requestsPerSecond,
      schedule: __scheduleRequest,
      getDefaultUserAgent: Application.getDefaultUserAgent
    };
  },
  createSourceStateManager: function () {
    return {
      keychain: {
        store: async function (key, value) { Application.setSecureState(value, key); },
        retrieve: async function (key) { return Application.getSecureState(key); }
      },
      store: async function (key, value) { Application.setState(value, key); },
      retrieve: async function (key) { return Application.getState(key); }
    };
  },

  /* encoding and text */
  arrayBufferToUTF8String: function (buffer) {
    return new TextDecoder().decode(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
  },
  arrayBufferToASCIIString: function (buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
    return out;
  },
  utf8Decode: function (bytes) { return new TextDecoder().decode(Uint8Array.from(bytes)); },
  base64Decode: function (value) { return __dom.base64Decode(String(value)); },
  base64DecodeBytes: function (value) { return new TextEncoder().encode(__dom.base64Decode(String(value))); },
  base64Encode: function (value) { return __dom.base64Encode(String(value)); },
  decodeHTMLEntities: function (value) { return __dom.unescapeEntities(String(value)); },
  crypto_md5Hash: function (buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return __digestMd5(bytes).buffer;
  },

  /* discovery */
  filterAdultTitles: function (items) { return items; },
  filterMatureTitles: function (items) { return items; },

  /**
   * A WebView is a realm this shim does not carry. Refused by name rather than
   * answered with a promise of the wrong document.
   */
  executeInWebView: function () {
    throw new Error(
      'This converted Paperback source called Application.executeInWebView, which needs a WebView ' +
        'this build does not provide.'
    );
  }
};

/* \`createDUI*\` is the ecosystem's helper for a UI view type: a decorator that
 * stamps 'type' on the view object. */
[ 'DUITextField', 'DUISection', 'DUIButton', 'DUISelect', 'DUIToggle', 'DUIStepper', 'DUIWebView' ]
  .forEach(function (name) {
    var type = name.slice(3);
    Application[name] = function (view) {
      if (view && typeof view === 'object') {
        Object.defineProperty(view, 'type', { enumerable: true, value: type.charAt(0).toLowerCase() + type.slice(1) });
      }
      return view;
    };
  });

/*
 * An unknown member throws by its own name. A source reaching for one this
 * build does not implement would otherwise fail inside its own code with
 * "undefined is not a function", naming neither the member nor this build.
 */
Application = new Proxy(Application, {
  get: function (target, member) {
    if (member in target) return target[member];
    if (typeof member !== 'string') return undefined;
    return __required(member);
  }
});

globalThis.Application = Application;

/* --- the extension -------------------------------------------------------- */

var source = (function () {
  var module = { exports: {} };
  var exports = module.exports;
${options.script}
  if (typeof source !== 'undefined' && source !== null && typeof source === 'object') return source;
  return module.exports;
})();

/* --- the ABI -------------------------------------------------------------- */

/** How much of the interface a prototype or instance carries; 0 is none. */
function __interfaceScore(target) {
  var score = 0;
  if (typeof target.getSearchResults === 'function') score += 1;
  if (typeof target.getChapters === 'function') score += 2;
  if (typeof target.getChapterDetails === 'function') score += 4;
  return score;
}

/**
 * The export to run: an instance the bundle built, or else a class to build.
 * An instance outranks a class carrying the same interface, and one published
 * under the extension's own id outranks both.
 */
function __exported() {
  var best = null;
  var bestScore = 0;
  for (var key in source) {
    var candidate = source[key];
    var score = 0;
    var instance = false;
    if (typeof candidate === 'function' && candidate.prototype !== undefined) {
      score = __interfaceScore(candidate.prototype);
      // The 'Extension' alias is the interface-bearing class rather than the
      // implementation base it extends, so it breaks a tie.
      if (score > 0 && /Extension$/.test(key)) score += 0.5;
    } else if (candidate !== null && typeof candidate === 'object') {
      score = __interfaceScore(candidate);
      instance = true;
      if (score > 0) score += 1000;
      if (score > 0 && __FOREIGN_ID.length > 0 && key === __FOREIGN_ID) score += 1000;
    }
    if (score > bestScore) { best = { value: candidate, instance: instance }; bestScore = score; }
  }
  return best;
}

var __runner = null;

async function __instance() {
  if (__runner !== null) return __runner;
  var found = __exported();
  if (found === null) {
    throw new Error('This converted source exports nothing implementing a catalogue, chapter or page interface.');
  }
  var runner = found.instance ? found.value : new found.value();
  if (typeof runner.initialise === 'function') await runner.initialise();
  __runner = runner;
  return __runner;
}

function __mangaInfo() {
  return {
    thumbnailUrl: '',
    synopsis: '',
    primaryTitle: '',
    secondaryTitles: [],
    contentRating: 0
  };
}

/** A paged answer, in the ABI's shape rather than this format's. */
function __page(value) {
  var decoded = value || {};
  var rows = Array.isArray(decoded.items) ? decoded.items : Array.isArray(decoded.results) ? decoded.results : [];
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== 'object') continue;
    var id = String(row.mangaId || row.id || '');
    var title = String(row.title || '').trim();
    if (id.length === 0 || title.length === 0) continue;
    entries.push({
      sourceMediaId: id,
      title: title,
      alternativeTitles: row.subtitle ? [String(row.subtitle)] : [],
      posterImageUrl: row.imageUrl === undefined || row.imageUrl === null || row.imageUrl === '' ? undefined : String(row.imageUrl)
    });
  }
  return { entries: entries, hasMore: entries.length > 0 && decoded.metadata !== undefined && decoded.metadata !== null };
}

/*
 * The cursor each search page answered with, by query: \`cursors[q][n]\` is
 * what page n returned, which is what page n+1 is asked for with. Only the
 * latest query is kept — a new one starts again from page 1.
 */
var __cursorQuery = null;
var __cursors = [];

async function __searchPage(runner, request, query, page) {
  if (__cursorQuery !== query) { __cursorQuery = query; __cursors = []; }
  var wanted = Math.max(1, Math.floor(Number(page) || 1));
  // Walk forward from the furthest page already read, up to the one before.
  for (var n = 1; n < wanted; n++) {
    if (__cursors[n] !== undefined) continue;
    var before = n === 1 ? undefined : __cursors[n - 1];
    if (n > 1 && (before === undefined || before === null)) return { entries: [], hasMore: false };
    var walked = (await runner.getSearchResults(request, before)) || {};
    __cursors[n] = walked.metadata === undefined ? null : walked.metadata;
  }
  var metadata = wanted === 1 ? undefined : __cursors[wanted - 1];
  if (wanted > 1 && (metadata === undefined || metadata === null)) return { entries: [], hasMore: false };
  var answered = (await runner.getSearchResults(request, metadata)) || {};
  __cursors[wanted] = answered.metadata === undefined ? null : answered.metadata;
  return __page(answered);
}

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    var runner = await __instance();
    if (typeof runner.getSearchResults !== 'function') return { entries: [] };
    var request = { title: String(query), includedTags: [], excludedTags: [], parameters: {} };
    return await __searchPage(runner, request, String(query), page);
  },

  async listChapters(sourceMediaId, ctx) {
    __enter(ctx);
    var runner = await __instance();
    if (typeof runner.getChapters !== 'function') return [];
    var manga = { mangaId: String(sourceMediaId), mangaInfo: __mangaInfo() };
    var rows = await runner.getChapters(manga);
    var chapters = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var id = String(row.chapterId || row.id || '');
      if (id.length === 0) continue;
      chapters.push({
        sourceChapterId: id,
        number: Number.isFinite(Number(row.chapNum)) ? Number(row.chapNum) : chapters.length + 1,
        title: typeof row.title === 'string' && row.title.length > 0 ? row.title : undefined,
        volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : undefined
      });
    }
    chapters.sort(function (a, b) { return a.number - b.number; });
    return chapters;
  },

  async readChapter(sourceMediaId, chapter, ctx) {
    __enter(ctx);
    var runner = await __instance();
    if (typeof runner.getChapterDetails !== 'function') return { pages: [] };
    var chapterId = chapter && chapter.sourceChapterId ? String(chapter.sourceChapterId) : '';
    if (chapterId.length === 0) throw new Error('This chapter has no source id to read.');
    var details = await runner.getChapterDetails({
      chapterId: chapterId,
      sourceManga: { mangaId: String(sourceMediaId), mangaInfo: __mangaInfo() },
      chapNum: chapter && chapter.number !== undefined ? Number(chapter.number) : 0,
      langCode: 'en'
    });
    // A novel chapter is one HTML document, \`{ type: 'html', html }\`, and has
    // no page urls at all. It is carried as a \`data:\` url, as the Kotlin
    // family's text chapters are, so it is still an ordered page list.
    if (details && details.type === 'html' && typeof details.html === 'string') {
      return { pages: [{ index: 0, url: 'data:text/html;charset=utf-8,' + encodeURIComponent(details.html) }] };
    }
    var urls = details && Array.isArray(details.pages) ? details.pages : [];
    var pages = [];
    for (var i = 0; i < urls.length; i++) pages.push({ index: pages.length, url: String(urls[i]) });
    return { pages: pages };
  }
};
`;
}
