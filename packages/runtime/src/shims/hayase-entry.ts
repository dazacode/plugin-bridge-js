/**
 * Hayase torrent sources, as a converted plugin.
 *
 * ## What one of these is
 *
 * A single ES module, self-contained, exporting one object with four methods.
 * The canonical shape is the ecosystem's own published base class:
 *
 * ```js
 * export default new class extends AbstractSource {
 *   async single ({ titles, episode, resolution, exclusions }) { … }
 *   batch = this.single
 *   movie = this.single
 *   async test () { return true }
 * }()
 * ```
 *
 * `single` is one episode, `batch` a whole run, `movie` a film. Each answers
 * with rows carrying a torrent — `{ title, link, hash, size, seeders, … }` —
 * and nothing else. There is **no catalogue and no episode list**: the source
 * is asked about a title the caller already knows, which is the same shape as
 * a stream-only addon in the other torrent ecosystem, and is handled the same
 * way here.
 *
 * ## Why this is a conversion and no longer a refusal
 *
 * This format was `browse-only` on one stated ground: *"Yorozo has no torrent
 * client"*. That stopped being true. `ABI.md` §1 carries `TorrentDescriptor`,
 * a resolve answering with descriptors and no direct link is a pass rather
 * than a failure, and the host owns acquisition behind `TorrentAcquisition`
 * with its own pairing and consent. So a row's info hash is **returned, not
 * dropped** — exactly as the Stremio shim already returns one — and whether it
 * can become a stream is the host's question rather than this bundle's.
 *
 * Nothing here acquires anything. This file has no torrent client in it, must
 * never grow one, and reaches the swarm through no path of its own: it hands
 * back an info hash and stops, which is the same division that keeps a plugin
 * from knowing what device it runs on.
 *
 * ## Measured against the ecosystem, not against one extension
 *
 * Over 77 published extensions from 15 repositories:
 *
 * - 56 import nothing, 13 import only the published `abstract.js`, and 8 pull
 *   in a sibling helper. The first two work by embedding; `AbstractSource` is
 *   therefore defined below rather than fetched, and the third group is left
 *   to refuse for a named reason rather than be half-supported.
 * - 51 are `export default new class`, 13 `export default class`, 14 a plain
 *   object. All three are handled — a class *expression* has to be constructed
 *   and an already-constructed instance must not be.
 * - The row's hash is spelled `hash` in 36, and reachable only through `link`
 *   or `magnet` in 25 more. Both are read, and a bare 40-hex `link` — which the
 *   ecosystem's own public-domain example uses — counts as a hash.
 * - `exclusions` and `resolution` are touched by well over half of them, so
 *   both are always passed, as an array and a string, never as `undefined`. A
 *   destructure that lands on `undefined.includes` is a source that reports a
 *   fault in this build.
 */

import { JS_RUNTIME } from './js-runtime';

export interface HayaseEntrypointOptions {
	readonly pluginId: string;
	/** The extension's own source, verbatim. */
	readonly script: string;
	/**
	 * Repository-local modules the extension imports, in dependency order —
	 * deepest first, so a helper is declared before whatever reads it.
	 *
	 * Resolved and fetched by the adapter, which is the half that knows where
	 * the entry module came from. Empty for the 56 of 77 that import nothing.
	 */
	readonly modules?: readonly { readonly specifier: string; readonly source: string }[];
}

/**
 * A helper module's body, with its exports turned into ordinary declarations.
 *
 * Inlining is the whole mechanism: `import { parseFeed } from './utils.js'`
 * becomes `parseFeed` already being in scope, because the helper's own
 * `export function parseFeed` is emitted as `function parseFeed` above it.
 * That is sound here and would not be in general — these are single-author
 * repositories whose helpers were written to be read by one entry module, not
 * a package graph with colliding names.
 *
 * A helper's own `export default` has nowhere to go, so it is bound to a name
 * nothing reads rather than dropped: dropping it would silently delete a
 * declaration whose *side effects* the helper may rely on.
 */
function helperBody(source: string, index: number): string {
	return source
		.replace(/^[ \t]*import\s[\s\S]*?\sfrom\s*['"][^'"]+['"];?[ \t]*$/gm, '')
		.replace(/^[ \t]*export\s+default\s+/m, `var __hayaseHelper${index} = `)
		.replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '')
		.replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
}

/**
 * The module, with its module-ness taken off.
 *
 * `export default` is a declaration and cannot appear inside the wrapper this
 * bundle evaluates the source in, so it becomes an assignment. Imports go with
 * it: the only one this build answers is the published base class, which is
 * defined below, and any other is a sibling file that was never fetched — so
 * leaving the statement in would fail at parse rather than at the call, hiding
 * which of the two happened.
 *
 * Deliberately textual, and deliberately narrow. This is not a module system;
 * it is two rewrites whose shapes were counted across a real corpus.
 */
function moduleBody(script: string): string {
	return script
		.replace(/^[ \t]*import\s[\s\S]*?\sfrom\s*['"][^'"]+['"];?[ \t]*$/gm, '')
		.replace(/^[ \t]*export\s+default\s+/m, '__hayaseDefault = ');
}

export function hayaseEntrypoint(options: HayaseEntrypointOptions): string {
	const constants = [`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`].join('\n');

	return `${JS_RUNTIME}
${constants}

/**
 * 'navigator.onLine', which 19 of the 77 guard their first line with.
 *
 * They were written for a browser and ask the page whether it has a network
 * before spending a request. There is no page here and the question has one
 * honest answer: a plugin call only happens when the host has handed over an
 * http capability, so the answer is yes. Absent, the global is a
 * ReferenceError on the first line of 'single' and reads as this build being
 * broken; stubbed false, every one of them returns nothing and reads as the
 * source being empty. Neither is true.
 */
var navigator = typeof navigator === 'object' && navigator !== null ? navigator : { onLine: true };

/* --- the base class the ecosystem publishes ------------------------------ */

/**
 * Its own 'abstract.js', reimplemented rather than fetched.
 *
 * Every method throws the sentence the published class throws, so an extension
 * that inherits one and never overrides it fails exactly where it would have
 * failed at home, with the same words. Thirteen of the measured extensions
 * extend this and nothing else.
 */
class AbstractSource {
  single () { throw new Error("Source doesn't implement single"); }
  batch () { throw new Error("Source doesn't implement batch"); }
  movie () { throw new Error("Source doesn't implement movie"); }
  test () { throw new Error("Source doesn't implement test"); }
}

/* --- the module, verbatim but for its imports and its default ------------ */

var __hayaseDefault = null;
var __evaluated = false;
var __ready = null;

/**
 * The deferred body is **async**, because these are ES modules and a module
 * may await at its top level — two of the measured extensions do. Wrapped in a
 * plain function that is a parse error, which fails the whole bundle rather
 * than the one call. Started once and awaited by every entry point.
 */
function __ensure() {
  if (__ready === null) __ready = __evaluate();
  return __ready;
}

/**
 * The module body, run on first use rather than on load.
 *
 * Not a nicety. 'export default new class {…}()' — 51 of the 77 measured
 * extensions — *constructs at the assignment*, and this ecosystem routinely
 * writes its own address as a class field, 'url = atob("…")'. Evaluated at
 * module scope that reaches the host's codecs before any plugin call has
 * handed one over, and 37 of 77 failed to load for exactly that. Deferring
 * only the construction is not enough, because the construction is part of the
 * expression; the whole body has to wait. Everything the module declares stays
 * in scope with it, which is where it was anyway.
 */
async function __evaluate() {
  if (__evaluated) return;
  __evaluated = true;
${(options.modules ?? []).map((one, index) => `  /* ${one.specifier} */\n${helperBody(one.source, index)}`).join('\n')}
${moduleBody(options.script)}
}

/**
 * The source object, however the module spelled it — built on first use.
 *
 * 'export default new class {…}()' is already an instance; 'export default
 * class {…}' is a constructor and has to be called. Telling them apart by
 * 'typeof' is enough, because the first is an object and the second a function,
 * and a plain object literal is neither constructed nor rejected.
 *
 * **Lazily, and that is the load-bearing part.** A class *field* runs when the
 * instance is made, and this ecosystem routinely writes its own address as one
 * — 'url = atob("…")' — so constructing at module scope reaches the host's
 * codecs before any plugin call has handed one over. Measured: 37 of 77
 * extensions failed to load for exactly that, and every one of them is fine
 * once construction happens inside the call. Nothing else about the module is
 * changed; it is the same expression, evaluated later.
 */
var __instance = null;
function __sourceOf() {
  if (__instance === null) {
    const value = __hayaseDefault;
    __instance = typeof value === 'function' ? new value() : value;
  }
  return __instance;
}

/* --- the adapter --------------------------------------------------------- */

function __method(name) {
  const source = __sourceOf();
  const fn = source && source[name];
  return typeof fn === 'function' ? fn.bind(source) : null;
}

/** Base32, for the info hashes a magnet may carry instead of hex. */
function __base32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let acc = 0;
  const out = [];
  const text = String(value).toUpperCase().replace(/=+$/, '');
  for (let i = 0; i < text.length; i += 1) {
    const index = alphabet.indexOf(text.charAt(i));
    if (index < 0) return null;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 20) return null;
  let hex = '';
  for (let i = 0; i < out.length; i += 1) hex += ('0' + out[i].toString(16)).slice(-2);
  return hex;
}

function __hex40(value) {
  const text = String(value == null ? '' : value).trim();
  return /^[0-9a-fA-F]{40}$/.test(text) ? text.toLowerCase() : null;
}

/**
 * One row's info hash, from whichever field carries it.
 *
 * Three real spellings, in the order they are trusted: the declared 'hash';
 * the 'xt=urn:btih:' of a magnet, hex or base32; and a 'link' that is itself a
 * bare hash, which is what the ecosystem's public-domain example publishes.
 * A '.torrent' URL carries its hash only inside bencode behind a SHA-1 of the
 * info dictionary — that is a parser this build does not have, and it refuses
 * by returning nothing rather than by guessing.
 */
function __infoHash(row) {
  const declared = __hex40(row.hash) || __base32(String(row.hash || ''));
  if (declared !== null) return declared;
  const link = String(row.link || row.magnet || '');
  const found = /xt=urn:btih:([0-9a-zA-Z]+)/i.exec(link);
  if (found !== null) {
    const hex = __hex40(found[1]) || __base32(found[1]);
    if (hex !== null) return hex;
  }
  return __hex40(link);
}

/** The trackers a magnet names, which a swarm can be joined faster with. */
function __trackers(row) {
  const link = String(row.link || row.magnet || '');
  const out = [];
  const pattern = /[?&]tr=([^&]+)/g;
  let match = pattern.exec(link);
  while (match !== null) {
    try { out.push(decodeURIComponent(match[1])); } catch (error) { /* skip */ }
    match = pattern.exec(link);
  }
  return out;
}

/** One row as a playback source, or null when it carries no torrent. */
function __playable(row) {
  if (!row || typeof row !== 'object') return null;
  const infoHash = __infoHash(row);
  if (infoHash === null) return null;
  const trackers = __trackers(row);
  const label = String(row.title || row.name || '').trim();
  return {
    torrent: {
      infoHash: infoHash,
      ...(trackers.length > 0 ? { sources: trackers } : {})
    },
    label: label.length > 0 ? label : 'Torrent'
  };
}

/**
 * The query one of these sources expects.
 *
 * Every field the measured corpus reads, with a value of the right *type* even
 * when the host has nothing to put in it. An absent 'exclusions' is the
 * difference between a source that finds nothing and a source that throws
 * inside a destructure, and the second reads to a viewer as this build being
 * broken.
 */
function __ref(sourceMediaId) {
  const raw = String(sourceMediaId || '');
  const bar = raw.indexOf('|');
  if (bar < 0) return { title: raw, ids: {} };
  const ids = {};
  for (const pair of raw.slice(0, bar).split(',')) {
    const at = pair.indexOf(':');
    if (at <= 0) continue;
    const value = Number(pair.slice(at + 1));
    if (Number.isFinite(value) && value > 0) ids[pair.slice(0, at).trim()] = value;
  }
  return { title: raw.slice(bar + 1), ids: ids };
}

function __query(titles, episode, episodeCount, ids) {
  const known = ids || {};
  return {
    titles: Array.isArray(titles) ? titles : [String(titles || '')],
    // Only what the host actually holds, under the name each ecosystem uses.
    // Absent stays absent: a source that needs an id this catalogue has never
    // heard of must refuse by name, and inventing one — or handing it an id
    // from a different namespace that happens to be a number — produces
    // results for the wrong show, which is worse than none.
    ...(known.anilist !== undefined ? { anilistId: known.anilist, id: known.anilist } : {}),
    ...(known.mal !== undefined ? { idMal: known.mal, malId: known.mal } : {}),
    ...(known.tmdb !== undefined ? { tmdbId: known.tmdb } : {}),
    episode: Number(episode) > 0 ? Number(episode) : 1,
    episodeCount: Number(episodeCount) > 0 ? Number(episodeCount) : 0,
    resolution: '',
    exclusions: [],
    // Some of them take the network *from the query* rather than from scope —
    // 'single({ titles, fetch: fetchFn })' — because their own host hands one
    // over that way. The same function either way; passing it costs nothing and
    // its absence is a 'fetchFn is not a function' from inside the source.
    fetch: fetch
  };
}

async function __rows(kind, query) {
  const fn = __method(kind) || __method('single');
  if (fn === null) return [];
  const answered = await fn(query);
  return Array.isArray(answered) ? answered : [];
}

/* --- the ABI ------------------------------------------------------------- */

export default {
  id: __PLUGIN_ID,

  /**
   * There is no catalogue to search, so the source is asked the only question
   * it answers and the *query* is the entry when it says yes.
   *
   * A source with nothing for a title must not claim it: binding one that
   * answers nothing would put a row on screen whose every episode then fails,
   * which is worse than not appearing. So this costs one request and reports
   * what that request found.
   */
  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    await __ensure();
    const title = String(query || '').trim();
    if (title.length === 0 || Number(page) > 1) return { entries: [] };

    const rows = await __rows('single', __query([title], 1, 0, {}));
    if (rows.length === 0) return { entries: [] };

    return {
      entries: [{ sourceMediaId: title, title: title, alternativeTitles: [] }]
    };
  },

  /**
   * Nothing. These sources do not publish an episode list and never claimed
   * to; the host's own catalogue has one, and answering with a guessed run
   * would be this bundle inventing metadata it is forbidden to own.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    return [];
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    await __ensure();
    const ref = __ref(sourceMediaId);
    const title = ref.title;
    const number = episode && Number(episode.number) > 0 ? Number(episode.number) : 0;

    // A film is asked for as a film. The distinction is the source's, and the
    // absence of an episode number is the only evidence this side has of it.
    const kind = number > 0 ? 'single' : 'movie';
    const rows = await __rows(kind, __query([title], number, 0, ref.ids));

    const sources = [];
    const seen = {};
    let dropped = 0;
    for (const row of rows) {
      const source = __playable(row);
      if (source === null) { dropped += 1; continue; }
      // The same release is listed by several indexers constantly. One entry
      // per hash, because the host tries them in order and a duplicate spends
      // a whole acquisition attempt to reach the same swarm.
      if (seen[source.torrent.infoHash] === true) continue;
      seen[source.torrent.infoHash] = true;
      sources.push(source);
    }

    if (sources.length === 0 && dropped > 0) {
      throw new Error(
        'This source answered with ' + dropped + ' result(s) carrying no info hash this build could read.'
      );
    }
    return sources;
  }
};
`;
}
