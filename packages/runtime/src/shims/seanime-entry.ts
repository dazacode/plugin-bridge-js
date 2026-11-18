/**
 * A Seanime provider, wrapped as a Yorozo plugin bundle.
 *
 * ## Three provider families, one ABI
 *
 * A marketplace entry's `type` says which of these a manifest is, and the API
 * changed shape underneath the ecosystem without the marketplace ever saying
 * so. All three occur in the same document:
 *
 * | Manifest type | Catalogue | Terminal methods |
 * | --- | --- | --- |
 * | `manga-provider` | `search({ query })` | `findChapters` / `findChapterPages`, or the older `getChapters` / `getChapterDetails` |
 * | `onlinestream-provider` | `search({ query, media })` | `findEpisodes` / `findEpisodeServer`, or the older `getEpisodes` / `getStreamUrl` |
 * | `anime-torrent-provider` | `search({ query, media })` | `search` again, for torrents |
 *
 * Which family a provider belongs to is decided by **which members it has**, not
 * by a version number, because these payloads carry none. `getChapters`,
 * `getChapterDetails`, `getEpisodes` and `getStreamUrl` were the older spelling;
 * the newer one is `find…` and speaks in objects. The family decides how
 * `search` is called too — a string for one, an options object for the other —
 * because those two are never both present and getting it wrong is silent
 * (a URL built from `q=undefined`).
 *
 * ## What it reaches for, and what it does not
 *
 * `fetch` is the payload's only transport, and `shims/js-runtime.ts` supplies
 * it over `ctx.http`, so every request passes the manifest's allowlist. There
 * is no `cheerio`: these providers carry their own parsing or read JSON, and
 * the ones that bundle anything bundle it into the payload.
 *
 * ## A torrent provider answers in hashes
 *
 * `ABI.md` §1 has `TorrentDescriptor`, so `resolve` answers with one — info
 * hash and trackers, no URL — and the host owns acquisition. A payload that
 * mints magnet links itself is read through `getTorrentMagnetLink`/`infoHash`
 * rather than by parsing the magnet here, which is the same division the Nuvio
 * and Hayase shims make.
 *
 * ## What is deliberately not supplied
 *
 * `ctx.dom`, `ctx.tray` and `$ui` — the plugin-only surfaces — are absent, so a
 * *provider* that also draws UI will lose it, and a payload of `type: "plugin"`
 * never reaches this file at all because it has no catalogue to convert.
 */

import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { EPISODE_NUMBERING } from './episode-numbering';
import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

export interface SeanimeEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/** The payload, verbatim. */
	readonly script: string;
	/** Which pair of terminal methods this bundle declares. */
	readonly serves: 'anime' | 'manga' | 'torrent';
	/**
	 * The manifest's `userConfig` fields, as the settings they became: the key
	 * the payload asks `$getUserPreference` for, the manifest setting id the host
	 * stores it under, and the type that decides how it reads back.
	 */
	readonly preferences?: readonly SeanimePreference[];
}

export interface SeanimePreference {
	readonly key: string;
	readonly id: string;
	readonly type: 'text' | 'select' | 'switch';
}

/**
 * Whether a payload reaches for the document API, so the parser is carried.
 *
 * The engine is sixty-odd kilobytes and most providers read JSON; a payload
 * that names neither `LoadDoc` nor `Doc` cannot reach it, because both are
 * globals and a global is reached by name.
 */
export function seanimeUsesDocuments(script: string): boolean {
	return /\bLoadDoc\b|\bnew\s+Doc\b/.test(script);
}

/**
 * `LoadDoc` and `Doc`: the host's goquery selection, over the shared parser.
 *
 * Seanime hands a provider goquery through its Goja bindings, so these follow
 * goquery rather than jsoup wherever the two disagree:
 *
 * - `find` is descendants only. The parser's `select` includes the element
 *   it is asked from when that element matches, which is jsoup's rule.
 * - `text()` is every text node *as written*, script and style bodies
 *   included and comments not, concatenated across the selection — not jsoup's
 *   whitespace-normalised text. Providers trim it themselves.
 * - `attr` answers `undefined` for an attribute that is not there, not `''`,
 *   so `attr("href") ?? fallback` behaves as its author tested it.
 * - `length()` is a method, and `eq` counts back from the end when negative.
 * - Matches are collected per element in selection order and de-duplicated,
 *   which is goquery's order — not re-sorted into document order.
 *
 * A member goquery has and this does not is absent, so calling it fails with
 * its own name rather than answering something empty.
 */
const DOCUMENTS = `
/* --- the DOM engine, inlined ---------------------------------------------- */
${DOM_RUNTIME_SOURCE}
const __rt = globalThis.__yorozoRuntime;

function __isElement(node) { return node !== null && typeof node === 'object' && node.kind === 'element'; }

/** goquery's text: text and script bodies as written, comments left out. */
function __nodeText(node) {
  if (node === null || typeof node !== 'object') return '';
  if (node.kind === 'text' || node.kind === 'data') return String(node.wholeText);
  if (node.kind === 'comment') return '';
  var out = '';
  var children = node.childNodes();
  for (var i = 0; i < children.length; i++) out += __nodeText(children[i]);
  return out;
}

function __unique(nodes) {
  var out = [];
  for (var i = 0; i < nodes.length; i++) if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
  return out;
}

function __matches(node, selector) {
  return __isElement(node) && node.is(String(selector));
}

class DocSelection {
  constructor(nodes, previous) {
    this.__nodes = nodes;
    this.__previous = previous === undefined ? null : previous;
  }

  __chain(nodes) { return new DocSelection(__unique(nodes), this); }
  __each(fn) {
    var out = [];
    for (var i = 0; i < this.__nodes.length; i++) {
      var node = this.__nodes[i];
      if (__isElement(node)) out.push.apply(out, fn(node));
    }
    return out;
  }
  __filtered(nodes, selector) {
    if (selector === undefined || selector === null || selector === '') return this.__chain(nodes);
    return this.__chain(nodes.filter(function (node) { return __matches(node, selector); }));
  }
  __test(selector) {
    if (typeof selector === 'function') {
      var self = this;
      return function (node, index) { return Boolean(selector(index, new DocSelection([node], self))); };
    }
    return function (node) { return __matches(node, selector); };
  }

  length() { return this.__nodes.length; }
  text() {
    var out = '';
    for (var i = 0; i < this.__nodes.length; i++) out += __nodeText(this.__nodes[i]);
    return out;
  }
  html() {
    var node = this.__nodes[0];
    return __isElement(node) ? node.html() : null;
  }
  attr(name) {
    var node = this.__nodes[0];
    if (!__isElement(node) || !node.hasAttr(String(name))) return undefined;
    return node.attr(String(name));
  }
  attrs() {
    var node = this.__nodes[0];
    var out = {};
    if (!__isElement(node)) return out;
    var list = node.attributes();
    for (var i = 0; i < list.length; i++) out[list[i].key] = list[i].value;
    return out;
  }
  data(name) {
    var node = this.__nodes[0];
    if (name === undefined) {
      var out = {};
      if (__isElement(node)) node.dataset().forEach(function (value, key) { out[key] = value; });
      return out;
    }
    return __isElement(node) && node.hasAttr('data-' + name) ? node.attr('data-' + name) : undefined;
  }

  each(callback) {
    for (var i = 0; i < this.__nodes.length; i++) callback(i, new DocSelection([this.__nodes[i]], this));
    return this;
  }
  map(callback) {
    var out = [];
    for (var i = 0; i < this.__nodes.length; i++) out.push(callback(i, new DocSelection([this.__nodes[i]], this)));
    return out;
  }

  find(selector) {
    return this.__chain(this.__each(function (node) {
      return node.select(String(selector)).filter(function (found) { return found !== node; });
    }));
  }
  first() { return this.__chain(this.__nodes.slice(0, 1)); }
  last() { return this.__chain(this.__nodes.slice(-1)); }
  eq(index) {
    var at = Number(index) < 0 ? this.__nodes.length + Number(index) : Number(index);
    return this.__chain(at >= 0 && at < this.__nodes.length ? [this.__nodes[at]] : []);
  }
  end() { return this.__previous === null ? new DocSelection([], null) : this.__previous; }

  filter(selector) {
    var test = this.__test(selector);
    return this.__chain(this.__nodes.filter(function (node, index) { return test(node, index); }));
  }
  not(selector) {
    var test = this.__test(selector);
    return this.__chain(this.__nodes.filter(function (node, index) { return !test(node, index); }));
  }
  is(selector) {
    var test = this.__test(selector);
    for (var i = 0; i < this.__nodes.length; i++) if (test(this.__nodes[i], i)) return true;
    return false;
  }
  has(selector) {
    return this.__chain(this.__nodes.filter(function (node) {
      return __isElement(node) && node.select(String(selector)).some(function (found) { return found !== node; });
    }));
  }

  children(selector) {
    return this.__filtered(this.__each(function (node) { return node.children.slice(); }), selector);
  }
  contents() {
    return this.__chain(this.__each(function (node) { return node.childNodes(); }));
  }
  contentsFiltered(selector) {
    return this.__filtered(this.__each(function (node) { return node.childNodes(); }), selector);
  }
  parent(selector) {
    return this.__filtered(this.__each(function (node) { return __isElement(node.parent) ? [node.parent] : []; }), selector);
  }
  parents(selector) {
    return this.__filtered(this.__each(function (node) { return node.parents(); }), selector);
  }
  parentsUntil(selector, until) { return this.__until(function (node) { return node.parents(); }, selector, until); }
  closest(selector) {
    return this.__chain(this.__each(function (node) {
      if (selector === undefined) return [node];
      var found = node.closest(String(selector));
      return found === null ? [] : [found];
    }));
  }
  next(selector) {
    return this.__filtered(this.__each(function (node) {
      var found = node.nextElementSibling();
      return found === null ? [] : [found];
    }), selector);
  }
  prev(selector) {
    return this.__filtered(this.__each(function (node) {
      var found = node.previousElementSibling();
      return found === null ? [] : [found];
    }), selector);
  }
  nextAll(selector) {
    return this.__filtered(this.__each(function (node) { return node.nextElementSiblings(); }), selector);
  }
  prevAll(selector) {
    return this.__filtered(this.__each(function (node) { return node.previousElementSiblings(); }), selector);
  }
  nextUntil(selector, until) { return this.__until(function (node) { return node.nextElementSiblings(); }, selector, until); }
  prevUntil(selector, until) { return this.__until(function (node) { return node.previousElementSiblings(); }, selector, until); }
  siblings(selector) {
    return this.__filtered(this.__each(function (node) {
      var parent = node.parent;
      if (!__isElement(parent)) return [];
      return parent.children.filter(function (one) { return one !== node; });
    }), selector);
  }

  /**
   * goquery's two spellings: \`…Until(stop)\` walks until \`stop\` matches, and
   * \`…FilteredUntil(filter, stop)\` does the same keeping only \`filter\`.
   */
  __until(walk, selector, until) {
    var stop = until === undefined ? selector : until;
    var keep = until === undefined ? undefined : selector;
    return this.__filtered(this.__each(function (node) {
      var out = [];
      var list = walk(node);
      for (var i = 0; i < list.length; i++) {
        if (__matches(list[i], stop)) break;
        out.push(list[i]);
      }
      return out;
    }), keep);
  }
}

class Doc extends DocSelection {
  constructor(html) {
    super([__rt.parseHtml(html === null || html === undefined ? '' : String(html), '')], null);
  }
}

/** goquery's document function: \`$(selector)\` finds below the document. */
function LoadDoc(html) {
  var doc = new Doc(html);
  return function (selector) { return doc.find(selector); };
}
`;

/**
 * `$getUserPreference`, over `ctx.settings`.
 *
 * Seanime answers a string, or `undefined` for a key nothing set and nothing
 * defaulted; providers write `$getUserPreference("x") ?? "fallback"`, so an
 * unset text field answers `undefined` rather than the host's `''` — the
 * fallback is the author's, and `''` would skip it. A switch reads back as
 * the string Seanime stores, `"true"` or `"false"`. A key the manifest never
 * declared answers `undefined`, as it does there.
 */
function preferencesRuntime(preferences: readonly SeanimePreference[]): string {
	return `
var __PREFERENCES = ${JSON.stringify(preferences)};

function $getUserPreference(key) {
  var wanted = String(key);
  for (var i = 0; i < __PREFERENCES.length; i++) {
    var one = __PREFERENCES[i];
    if (one.key !== wanted) continue;
    var settings = __host().settings;
    if (!settings) return undefined;
    if (one.type === 'switch') return settings.boolean(one.id) ? 'true' : 'false';
    var value = settings.string(one.id);
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  return undefined;
}
`;
}

/**
 * The `Media` shape a provider is handed, and the reference the host binds by.
 *
 * Seanime's `Media.id` *is* an AniList id — that client is keyed on AniList
 * throughout — so a torrent provider is declared addressed by `anilist`
 * (`ExternalIdKind`), and a host holding the show's AniList id binds it
 * without a search and hands over `anilist:<id>|<title>`: the same reference
 * the Hayase shim reads. That id becomes `media.id` here.
 *
 * A bare title is still read, because a host holding no AniList id falls back
 * to searching by title, and then the id stays zero — which is what it was
 * before, and a provider keying on it searches by `query` instead. Zero
 * rather than a guess: an id from another namespace, or one matched from a
 * title, would be results for the wrong show.
 */
const MEDIA = `function __ref(sourceMediaId) {
  var raw = String(sourceMediaId || '');
  var bar = raw.indexOf('|');
  if (bar < 0 || !/^[a-z]+:/.test(raw)) return { title: raw, ids: {} };
  var ids = {};
  var pairs = raw.slice(0, bar).split(',');
  for (var i = 0; i < pairs.length; i++) {
    var at = pairs[i].indexOf(':');
    if (at <= 0) continue;
    var value = Number(pairs[i].slice(at + 1));
    if (Number.isFinite(value) && value > 0) ids[pairs[i].slice(0, at).trim()] = value;
  }
  return { title: raw.slice(bar + 1), ids: ids };
}

function __media(query, ids) {
  var known = ids || {};
  var media = {
    id: known.anilist !== undefined ? known.anilist : 0,
    synonyms: [],
    isAdult: false,
    romajiTitle: query,
    englishTitle: query
  };
  if (known.mal !== undefined) media.idMal = known.mal;
  return media;
}`;

const MANGA_METHODS = `  async listChapters(sourceMediaId, ctx) {
    __enter(ctx);
    var provider = __provider();
    var rows = __array(await __call(provider, ['getChapters', 'findChapters'], String(sourceMediaId)));

    var chapters = [];
    for (var i = 0; i < rows.length; i++) {
      var chapter = __chapter(rows[i], i + 1);
      if (chapter !== null) chapters.push(chapter);
    }
    chapters.sort(function (a, b) { return a.number - b.number; });
    return chapters;
  },

  async readChapter(sourceMediaId, chapter, ctx) {
    __enter(ctx);
    var provider = __provider();
    var target = chapter && chapter.sourceChapterId ? String(chapter.sourceChapterId) : '';
    if (target.length === 0) {
      throw new Error('This provider listed no chapter id, so there is nothing to open.');
    }
    // The row goes back with its id: the older method takes the chapter's own
    // record as a second argument, and some providers read its number.
    var descriptor = { id: target, chapterId: target };
    if (chapter && Number.isFinite(Number(chapter.number))) descriptor.number = Number(chapter.number);
    var data = await __call(provider, ['getChapterDetails', 'findChapterPages'], target, descriptor);
    return __pages(data);
  }`;

const VIDEO_METHODS = `  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    var provider = __provider();
    var rows = __array(await __call(provider, ['getEpisodes', 'findEpisodes'], String(sourceMediaId)));

    // A row with no number of its own is placed between the rows that state
    // one, never counted by position: a count lands on a number another row
    // already holds, and two rows claiming one episode is a wrong episode in
    // front of a viewer. Seanime's own lists run oldest first, so a list that
    // states no number anywhere counts from the start.
    var kept = [];
    var stated = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var id = String(row.id || row.url || '');
      if (id.length === 0) continue;
      var raw = row.number !== undefined ? row.number : row.episode;
      var number = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
      kept.push({ id: id, title: row.title });
      stated.push(Number.isFinite(number) ? number : null);
    }
    var numbers = __placeEpisodeNumbers(stated, 'ascending');

    var episodes = [];
    for (var k = 0; k < kept.length; k++) {
      episodes.push({
        number: numbers[k],
        sourceEpisodeId: kept[k].id,
        title: typeof kept[k].title === 'string' && kept[k].title.length > 0 ? kept[k].title : undefined
      });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    var provider = __provider();
    var target = episode && episode.sourceEpisodeId ? String(episode.sourceEpisodeId) : String(sourceMediaId);
    var number = episode && Number(episode.number) > 0 ? Number(episode.number) : 1;

    // Two shapes: the older method answers the episode's address directly, the
    // newer one answers a server with its sources and its own headers.
    if (typeof provider.getStreamUrl === 'function') {
      return __sources(await provider.getStreamUrl(target, ''));
    }
    var server = await provider.findEpisodeServer({ id: target, number: number, url: target });
    var sources = __sources(server);
    if (server && server.headers && typeof server.headers === 'object') {
      for (var i = 0; i < sources.length; i++) {
        if (sources[i].headers === undefined) sources[i].headers = server.headers;
      }
    }
    return sources;
  }`;

const TORRENT_METHODS = `  /**
   * One synthetic episode, as the stream-only shims do: a torrent provider has
   * no episode list, and everything it can answer for is the title.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    return [{ number: 1, sourceEpisodeId: String(sourceMediaId) }];
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    var provider = __provider();
    // The title is the show's, from the reference the host bound — never the
    // episode's own name, which is "Episode 5" and finds nothing.
    var ref = __ref(sourceMediaId);
    var query = ref.title;
    var rows = __array(await provider.search({ query: query, media: __media(query, ref.ids) }));

    var sources = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var infoHash = String(row.infoHash || '');
      if (infoHash.length === 0 && typeof provider.getTorrentInfoHash === 'function') {
        try {
          infoHash = String(await provider.getTorrentInfoHash(row));
        } catch (error) {
          infoHash = '';
        }
      }
      var magnet = String(row.magnetLink || row.link || row.downloadUrl || '');
      if (magnet.length > 0 && !__isPlayable(magnet)) {
        var torrent = __torrentOf({ magnet: magnet });
        if (torrent !== null) infoHash = torrent.infoHash;
      }
      if (!/^[0-9a-f]{40}$/i.test(infoHash) && !/^[a-z2-7]{32}$/i.test(infoHash)) continue;
      var source = { torrent: { infoHash: infoHash.toLowerCase() }, label: String(row.name || 'Torrent') };
      if (Array.isArray(row.trackers) && row.trackers.length > 0) source.torrent.sources = row.trackers;
      sources.push(source);
    }
    return sources;
  }`;

export function seanimeEntrypoint(options: SeanimeEntrypointOptions): string {
	const terminal =
		options.serves === 'manga'
			? MANGA_METHODS
			: options.serves === 'torrent'
				? TORRENT_METHODS
				: VIDEO_METHODS;

	return `${JS_RUNTIME}
${STREAM_GUARDS}
const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};
const __SERVES = ${JSON.stringify(options.serves)};
${seanimeUsesDocuments(options.script) ? DOCUMENTS : ''}
${preferencesRuntime(options.preferences ?? [])}

${MEDIA}

${EPISODE_NUMBERING}

/* --- rows ---------------------------------------------------------------- */

function __entry(row) {
  if (!row || typeof row !== 'object') return null;
  var id = String(row.id || row.url || '');
  var title = String(row.title || '').trim();
  if (id.length === 0 || title.length === 0) return null;
  var entry = { sourceMediaId: id, title: title, alternativeTitles: [] };
  var image = String(row.image || row.posterImageUrl || '');
  if (image.length > 0) entry.posterImageUrl = image;
  return entry;
}

/** A chapter's number, from the row or its label; fractional, as they are. */
function __number(row, fallback) {
  var stated = Number(row.number !== undefined ? row.number : row.chapter);
  if (Number.isFinite(stated)) return stated;
  var found = /(\\d+(?:\\.\\d+)?)/.exec(String(row.title || row.name || ''));
  if (found !== null) return Number(found[1]);
  return fallback;
}

function __entries(rows) {
  var list = __array(rows);
  var entries = [];
  for (var i = 0; i < list.length; i++) {
    var entry = __entry(list[i]);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function __chapter(row, fallback) {
  if (!row || typeof row !== 'object') return null;
  var id = String(row.id || row.chapterId || row.url || '');
  if (id.length === 0) return null;
  var chapter = { sourceChapterId: id, number: __number(row, fallback) };
  var title = String(row.title || '').trim();
  if (title.length > 0) chapter.title = title;
  if (typeof row.scanlator === 'string' && row.scanlator.length > 0) chapter.scanlator = row.scanlator;
  return chapter;
}

/** A page list from strings, \`{ url }\` rows, or a wrapper carrying \`pages\`. */
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
 * A playback source from a URL, or from a server object that holds one.
 *
 * The container is read from the URL by the shared rule: these providers state
 * a type sometimes (\`m3u8\`, \`mp4\`) and it is cheaper and more reliable to let
 * the address say it than to map three spellings of "unknown".
 */
function __source(row, fallbackHeaders) {
  if (typeof row === 'string') {
    if (!__isPlayable(row)) return null;
    return { url: row, container: __streamContainer({ url: row }, 'mp4'), label: 'Source' };
  }
  if (!row || typeof row !== 'object') return null;
  var url = String(row.url || row.link || '');
  if (url.length === 0 || !__isPlayable(url)) return null;
  var source = {
    url: url,
    container: __streamContainer({ url: url, type: row.type }, 'mp4'),
    label: String(row.label || row.quality || 'Source')
  };
  if (row.quality !== undefined) source.quality = String(row.quality);
  if (row.headers && typeof row.headers === 'object') source.headers = row.headers;
  return source;
}

/** Everything playable in whatever the provider answered. */
function __sources(value) {
  var rows = Array.isArray(value)
    ? value
    : value && Array.isArray(value.sources)
      ? value.sources
      : [value];
  var headers = value && typeof value === 'object' && !Array.isArray(value) ? value.headers : undefined;
  var sources = [];
  for (var i = 0; i < rows.length; i++) {
    var source = __source(rows[i], headers);
    if (source === null) continue;
    if (source.headers === undefined && headers !== undefined) source.headers = headers;
    sources.push(source);
  }
  return sources;
}

/* --- the payload --------------------------------------------------------- */

/*
 * These are Goja modules, and the older ones publish through CommonJS while the
 * newer ones declare a top-level \`Provider\` class and export nothing. Both are
 * read: the wrapper is given a \`module\` so the first shape has something to
 * assign to, and whatever the second shape leaves in scope is returned.
 */
var __module = { exports: {} };
var __Extension = (function (module, exports) {
${options.script}

  if (module.exports && typeof module.exports === 'object' && Object.keys(module.exports).length > 0) {
    return module.exports;
  }
  if (module.exports && typeof module.exports === 'function') return module.exports;
  if (typeof Provider === 'function') return Provider;
  if (typeof DefaultExtension === 'function') return DefaultExtension;
  return null;
})(__module, __module.exports);

var __instance = null;

function __provider() {
  if (__instance === null) {
    if (__Extension === null) {
      throw new Error('This converted provider declares no class and exports nothing.');
    }
    __instance = typeof __Extension === 'function' ? new __Extension() : __Extension;
  }
  return __instance;
}

/** The first of the names the provider implements. */
function __call(provider, names, a, b, c) {
  for (var i = 0; i < names.length; i++) {
    if (typeof provider[names[i]] === 'function') return provider[names[i]](a, b, c);
  }
  throw new Error('This converted provider does not implement ' + names.join(' or ') + '.');
}

/**
 * Whether this payload predates the options-object API.
 *
 * Read from the terminal methods rather than from \`search\`'s own signature,
 * which is identical in both families by arity and different only in what it
 * expects to be handed.
 */
function __legacy(provider) {
  return (
    typeof provider.getManga === 'function' ||
    typeof provider.getMangaDetails === 'function' ||
    typeof provider.getChapterDetails === 'function' ||
    typeof provider.getStreamUrl === 'function' ||
    typeof provider.getEpisodes === 'function'
  );
}

async function __search(provider, query, page) {
  // These providers page nowhere: one search is one page of results, and
  // claiming otherwise would ask for a page the payload answers again.
  if (Number(page) > 1) return { entries: [], hasMore: false };

  // Which shape \`search\` expects is the family's, but the family is read from
  // other members and a payload can mix them, so the other shape is tried when
  // the first yields nothing. A string handed to an options-object provider
  // builds \`q=undefined\`; an object handed to a string provider is
  // \`[object Object]\`. Neither throws, so trying is the only way to tell.
  var legacy = __legacy(provider);
  var entries = __entries(
    await __call(provider, ['search'], legacy ? query : { query: query, media: __media(query) })
  );
  if (entries.length === 0) {
    entries = __entries(
      await __call(provider, ['search'], legacy ? { query: query, media: __media(query) } : query)
    );
  }
  return { entries: entries, hasMore: false };
}

export default {
  id: __PLUGIN_ID,

  /**
   * A torrent provider's catalogue *is* its torrent list, so this reports the
   * title itself once rather than searching for something it will not use.
   */
  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    var provider = __provider();
    var asked = String(query === null || query === undefined ? '' : query);
    if (__SERVES === 'torrent') {
      if (asked.length === 0) return { entries: [], hasMore: false };
      return {
        entries: [{ sourceMediaId: asked, title: asked, alternativeTitles: [] }],
        hasMore: false
      };
    }
    if (asked.length === 0) return { entries: [], hasMore: false };
    return __search(provider, asked, page);
  },

${terminal}
};
`;
}
