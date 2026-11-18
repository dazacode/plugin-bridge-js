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

import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

export interface SeanimeEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/** The payload, verbatim. */
	readonly script: string;
	/** Which pair of terminal methods this bundle declares. */
	readonly serves: 'anime' | 'manga' | 'torrent';
}

/**
 * The `Media` shape an `AnimeTorrentProvider` is handed.
 *
 * Built from what this build actually knows, which is a title and nothing else:
 * the id is zero because an AniList id would be a claim the host already holds
 * and this shim cannot see. A provider keying on `media.id` therefore searches
 * on its own results rather than on the host's metadata, and one keying on the
 * title — every provider measured — is unaffected.
 */
const MEDIA = `function __media(query) {
  return {
    id: 0,
    synonyms: [],
    isAdult: false,
    romajiTitle: query,
    englishTitle: query
  };
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

    var episodes = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var id = String(row.id || row.url || '');
      if (id.length === 0) continue;
      var number = Number(row.number !== undefined ? row.number : row.episode);
      episodes.push({
        number: Number.isFinite(number) ? number : episodes.length + 1,
        sourceEpisodeId: id,
        title: typeof row.title === 'string' && row.title.length > 0 ? row.title : undefined
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
    var query = String((episode && episode.title) || sourceMediaId);
    var rows = __array(await provider.search({ query: query, media: __media(query) }));

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

${MEDIA}

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
    typeof provider.getChapters === 'function' ||
    typeof provider.getChapterDetails === 'function' ||
    typeof provider.getStreamUrl === 'function' ||
    typeof provider.getEpisodes === 'function'
  );
}

async function __search(provider, query, page) {
  // These providers page nowhere: one search is one page of results, and
  // claiming otherwise would ask for a page the payload answers again.
  if (Number(page) > 1) return { entries: [], hasMore: false };
  var rows = __legacy(provider)
    ? await __call(provider, ['search'], query)
    : await __call(provider, ['search'], { query: query, media: __media(query) });

  var list = __array(rows);
  var entries = [];
  for (var i = 0; i < list.length; i++) {
    var entry = __entry(list[i]);
    if (entry !== null) entries.push(entry);
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
