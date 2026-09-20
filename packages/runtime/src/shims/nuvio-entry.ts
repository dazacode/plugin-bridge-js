/**
 * Nuvio scrapers, as a converted plugin.
 *
 * ## What one of these is
 *
 * A single CommonJS module exporting one function:
 *
 * ```js
 * async function getStreams(tmdbId, mediaType, season, episode) { … }
 * module.exports = { getStreams };
 * ```
 *
 * `mediaType` is `'movie'` or `'tv'`, and `season`/`episode` are absent for a
 * film. It answers with rows carrying a direct address —
 * `{ name, title, url, quality, headers }` — and nothing else. There is **no
 * catalogue and no episode list**: the source is handed an id it already knows
 * how to address, which is the same shape two other stream-only ecosystems
 * already take here, and is handled the same way.
 *
 * ## Why this one is addressed rather than searched
 *
 * Every other adapted ecosystem is a site scraper whose ids are its own slugs,
 * so a title has to be searched for and the result scored. These are keyed on
 * TMDB, which the host already holds — for live action because that is what
 * the catalogue is keyed by, and for anime because the mapping payload fetched
 * for a logo carries it. So there is nothing to search and nothing to score.
 * `ExternalIdKind` gained `'tmdb'` for exactly this and nothing else.
 *
 * The reference is `<endpoint>:<id>` — `movie:603`, `tv:1399` — because TMDB's
 * two endpoints reuse numbers, and a bare one addresses a real but unrelated
 * work. That is the failure this shim cannot detect and must not cause.
 *
 * ## The runtime these were written for
 *
 * React Native, which is neither a browser nor Node. It has `window` (aliased
 * to the global object) and a `navigator` announcing itself, and it has no
 * `document`, no `localStorage` and no Node builtins at all. Modelling it
 * loosely in either direction is a measurement error: granting Node's module
 * resolution lets bundled polyfill paths run that the real host refuses, and
 * withholding `window` makes a scraper that merely mentions it look broken.
 * Measured: 12 of 61 name `window`, and one failed outright without it.
 *
 * ## Two libraries, and only two
 *
 * The ecosystem's own published contract names `cheerio-without-node-native`
 * for HTML and says to avoid Node's modules. 12 of 61 take the first and 3 take
 * `crypto-js`; everything else is refused by name, which is what tells a reader
 * that a scraper wanted something this build does not have rather than leaving
 * it to fail later somewhere else.
 *
 * The cheerio façade below is over this bundle's own parser. It is not a
 * reimplementation of that library — it is the fifteen members the measured
 * corpus actually calls, and a call to a sixteenth throws by name rather than
 * returning something empty that reads as a page with nothing in it.
 */

import { JS_RUNTIME } from './js-runtime';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';

export interface NuvioEntrypointOptions {
	/** The converted plugin's id, which must equal the manifest's. */
	readonly pluginId: string;
	/** The scraper's source, already unpacked if it was obfuscated. */
	readonly script: string;
}

/**
 * `module.exports` is a statement these modules end with, and this bundle has
 * no module system to receive it. Rather than rewrite the assignment — which
 * appears in several spellings, and in one case inside a conditional — the
 * wrapper below *provides* `module` and reads what was put on it.
 */
export function nuvioEntrypoint(options: NuvioEntrypointOptions): string {
	const constants = `const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`;

	return `${DOM_RUNTIME_SOURCE}
${JS_RUNTIME}
${constants}

/* --- the runtime these were written for ---------------------------------- */

/**
 * React Native aliases 'window' to the global object and defines a 'navigator'
 * that names itself. Neither is a browser's: there is no document behind them,
 * and a scraper reaching for one gets the same undefined it would get at home.
 */
var window = typeof globalThis === 'object' ? globalThis : this;
var navigator = { product: 'ReactNative', userAgent: 'Yorozo' };

/** Where this ecosystem's scrapers read their configured values from. */
var SCRAPER_SETTINGS = {};

/* --- cheerio, over this bundle's own parser ------------------------------ */

var __dom = globalThis.__yorozoRuntime;

/** Every element under 'root' matching 'selector', document order, no repeats. */
function __select(roots, selector) {
  var out = [];
  var seen = [];
  for (var i = 0; i < roots.length; i++) {
    var found = roots[i].select(selector);
    for (var j = 0; j < found.length; j++) {
      if (seen.indexOf(found[j]) === -1) { seen.push(found[j]); out.push(found[j]); }
    }
  }
  return out;
}

/**
 * A cheerio-shaped selection over KElement.
 *
 * Deliberately a small, closed set. cheerio's real surface is large and a
 * façade that answered everything with an empty selection would turn "this
 * build does not implement .closest()" into "that page had no links", which is
 * the wrong answer arriving quietly.
 */
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
    find: function (selector) { return __selection(__select(nodes, String(selector)), doc); },
    children: function (selector) {
      var kids = [];
      for (var i = 0; i < nodes.length; i++) kids = kids.concat(nodes[i].children);
      var out = __selection(kids, doc);
      return selector === undefined ? out : out.filter(selector);
    },
    parent: function () {
      var up = [];
      for (var i = 0; i < nodes.length; i++) { var p = nodes[i].parent; if (p !== null && up.indexOf(p) === -1) up.push(p); }
      return __selection(up, doc);
    },
    next: function () {
      var out = [];
      for (var i = 0; i < nodes.length; i++) { var n = nodes[i].nextElementSibling(); if (n !== null) out.push(n); }
      return __selection(out, doc);
    },
    prev: function () {
      var out = [];
      for (var i = 0; i < nodes.length; i++) { var n = nodes[i].previousElementSibling(); if (n !== null) out.push(n); }
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
      // cheerio answers 'undefined' for an attribute that is not there, and the
      // parser answers ''. A scraper testing '.attr("href")' for truthiness
      // reads the two the same way, but one that assigns it does not.
      var value = nodes[0].attr(String(name));
      return value === '' && !nodes[0].hasAttr(String(name)) ? undefined : value;
    },
    is: function (selector) {
      for (var i = 0; i < nodes.length; i++) {
        var doc2 = nodes[i].ownerDocument();
        if (doc2 !== null && doc2.select(String(selector)).indexOf(nodes[i]) !== -1) return true;
      }
      return false;
    },
    each: function (fn) {
      for (var i = 0; i < nodes.length; i++) fn.call(nodes[i], i, nodes[i]);
      return api;
    },
    map: function (fn) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) out.push(fn.call(nodes[i], i, nodes[i]));
      // cheerio's map answers a selection whose 'get()' is the plain array, and
      // the corpus always calls '.get()' straight after. Values that are not
      // elements are carried as they are, which is what that idiom expects.
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
    }
  };
  return api;
}

/** 'cheerio.load(html)' — the one entry point this ecosystem uses. */
function __cheerioLoad(html) {
  var doc = __dom.parseHtml(String(html === null || html === undefined ? '' : html));
  var $ = function (what, context) {
    if (what === null || what === undefined) return __selection([], doc);
    if (typeof what === 'object') return __selection(what.__nodes !== undefined ? what.__nodes : [what], doc);
    var roots = context === undefined
      ? [doc]
      : (typeof context === 'object' && context.__nodes !== undefined ? context.__nodes : [context]);
    return __selection(__select(roots, String(what)), doc);
  };
  $.html = function (node) { return node === undefined ? doc.html() : __selection([node], doc).html(); };
  $.root = function () { return __selection([doc], doc); };
  return $;
}

/**
 * The two libraries the ecosystem's own contract names, and nothing else.
 *
 * Node's builtins are absent here exactly as they are absent at home. Handing
 * one over would let a bundled polyfill path run that the real host refuses,
 * which produces a source that works in this harness and not on a device.
 */
var __baseRequire = require;
require = function (name) {
  var id = String(name);
  if (id === 'cheerio' || id === 'cheerio-without-node-native') {
    return { load: __cheerioLoad, default: { load: __cheerioLoad } };
  }
  // 'crypto-js' is deliberately *not* answered. This build does not carry it,
  // and handing back an empty object — or a free variable that is not there —
  // produces "Cannot read properties of undefined (reading 'SHA256')" at the
  // first call, which reads as a broken scraper rather than as a library this
  // build does not have. The base registry refuses it by name instead.
  return __baseRequire(id);
};

/* --- the scraper --------------------------------------------------------- */

var module = { exports: {} };
var exports = module.exports;

${options.script}

/** Whichever way this scraper published itself. */
function __entry(name) {
  if (module.exports && typeof module.exports[name] === 'function') return module.exports[name];
  if (typeof globalThis[name] === 'function') return globalThis[name];
  return null;
}

/* --- the ABI ------------------------------------------------------------- */

/** '<endpoint>:<id>', as 'referenceFor' spells a TMDB reference. */
function __reference(sourceMediaId) {
  var raw = String(sourceMediaId || '');
  var cut = raw.indexOf(':');
  if (cut < 0) return { type: 'movie', id: raw };
  var endpoint = raw.slice(0, cut);
  // 'series' is the other namespace's word for it and arrives when a host
  // spells the reference the way an IMDB one is spelled. Accepted rather than
  // refused: the id beside it is still a TMDB id, and refusing would lose a
  // binding over vocabulary.
  return { type: endpoint === 'tv' || endpoint === 'series' ? 'tv' : 'movie', id: raw.slice(cut + 1) };
}

/** Which container an address plays as, read from the address. */
function __container(url) {
  var value = String(url || '').toLowerCase();
  if (value.indexOf('.m3u8') !== -1) return 'hls';
  if (value.indexOf('.mpd') !== -1) return 'dash';
  return 'mp4';
}

/** One row as a playback source, or null when it carries nothing playable. */
function __playable(row) {
  if (!row || typeof row !== 'object') return null;
  var url = String(row.url || row.link || '');
  if (url.length === 0) return null;

  var label = String(row.title || row.name || '').split('\\n')[0].trim();
  var quality = row.quality === undefined || row.quality === null ? '' : String(row.quality).trim();

  // A magnet is a URL-shaped value no fetch can open. It travels as a torrent
  // descriptor or not at all — the same division the other two ecosystems use.
  var magnet = /^magnet:\\?/i.test(url) ? /xt=urn:btih:([0-9a-zA-Z]+)/i.exec(url) : null;
  if (magnet !== null) {
    var hash = String(magnet[1]).toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) return null;
    return { torrent: { infoHash: hash }, label: label.length > 0 ? label : 'Torrent' };
  }
  if (!/^https?:/i.test(url)) return null;

  var source = {
    url: url,
    container: __container(url),
    label: label.length > 0 ? label : (quality.length > 0 ? quality : 'Source')
  };
  if (quality.length > 0) source.quality = quality;
  if (row.headers && typeof row.headers === 'object') source.headers = row.headers;
  return source;
}

export default {
  id: __PLUGIN_ID,

  /**
   * Nothing. These sources hold no catalogue and cannot be asked about a title.
   *
   * Answering with the query — which the other stream-only shim does, because
   * its sources *can* be asked — would claim every title for every scraper and
   * bind rows whose every episode then fails. A source addressed by id is bound
   * by that id or not at all.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    return { entries: [] };
  },

  /**
   * One episode, which is "ask me" rather than a guess at the run.
   *
   * The host's own catalogue supplies the real numbering and drives 'resolve'
   * with it; nothing here invents a count, a title or a season, which would be
   * this bundle owning metadata it is forbidden to own.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    return [{ number: 1, sourceEpisodeId: String(sourceMediaId || '') }];
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    SCRAPER_SETTINGS = (ctx && ctx.settings && typeof ctx.settings.all === 'function')
      ? ctx.settings.all()
      : SCRAPER_SETTINGS;

    const getStreams = __entry('getStreams');
    if (getStreams === null) {
      throw new Error('This converted source does not export getStreams.');
    }

    const ref = __reference(sourceMediaId);
    const number = episode && Number(episode.number) > 0 ? Number(episode.number) : null;
    // Only where the host supplied one. A season this shim invented would send
    // the source to a real but different episode, which answers rather than
    // failing — see 'ResolveTarget' for when the host does and does not know.
    const season = episode && Number(episode.season) > 0 ? Number(episode.season) : null;

    const rows = ref.type === 'tv'
      ? await getStreams(ref.id, 'tv', season === null ? 1 : season, number === null ? 1 : number)
      : await getStreams(ref.id, 'movie');

    const list = Array.isArray(rows) ? rows : (rows && typeof rows === 'object' ? [rows] : []);
    const sources = [];
    const seen = {};
    for (const row of list) {
      const source = __playable(row);
      if (source === null) continue;
      const key = source.url || (source.torrent && source.torrent.infoHash);
      if (seen[key] === true) continue;
      seen[key] = true;
      sources.push(source);
    }
    return sources;
  }
};
`;
}
