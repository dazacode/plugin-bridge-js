/**
 * A Sora module, wrapped as a Yorozo plugin bundle.
 *
 * Produces the whole entrypoint: the shared runtime, the foreign script inside
 * a closure, and an adapter that presents its four functions as the three ABI
 * methods. Nothing rewrites the module's own code — it is embedded verbatim,
 * which is what makes a conversion auditable by diffing against the original.
 *
 * ## The three mismatches this file absorbs
 *
 * **Return types.** Every Sora entry point returns a JSON *string*, and not
 * consistently. `__decode` in the runtime parses defensively rather than
 * assuming, because a plugin returning a string where the ABI says object
 * fails at the boundary with a message about none of the right things.
 *
 * **Pagination.** Sora has none: `searchResults` takes a keyword and returns
 * one page. Asking for page two therefore returns nothing rather than the
 * first page again, which is what a caller paginating would otherwise loop on
 * forever.
 *
 * **Container.** `streamType` is declared once per module, not per stream, so
 * every resolved url inherits it. That is better than it sounds: sniffing a
 * container from a url's extension is how a player ends up with a black screen
 * and no error, and the module author knows what their source serves.
 *
 * ## Identity
 *
 * The `id` is the converted plugin id, injected at conversion time, because
 * `PluginSandbox.start` refuses a bundle whose code disagrees with its
 * manifest — a mismatch would otherwise produce bindings under an id nothing
 * else uses.
 */

import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

export interface SoraEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/** The module's own script, embedded verbatim. */
	readonly script: string;
	readonly baseUrl: string;
	readonly container: 'hls' | 'mp4';
	readonly softsub: boolean;
}

/**
 * The global some Sora modules require before they will do their job.
 *
 * A number of these modules carry a check of the shape:
 *
 * ```js
 * function _0xCheck() {
 *   var a = typeof _0xB4F2 === 'function';   // supplied by the host
 *   var b = typeof _0x7E9A === 'function';   // defined in the module
 *   return a && b ? _0x7E9A(_0xB4F2()) : false;
 * }
 * if (!_0xCheck()) return 'https://…/placeholder.mp4';
 * ```
 *
 * `_0x7E9A` is an obfuscated predicate that accepts a **16-character string
 * containing the letters of `cranci`** — the handle of Sora's author. It is a
 * host-identification gate: the module is asking which app is running it, and
 * returning a hardcoded placeholder to anything that is not Sora.
 *
 * ## Why this is here, and what it is not
 *
 * It is not a circumvention of content protection. Nothing here is encrypted,
 * no licence is being obtained, and the check guards no rights-holder's
 * material — it guards which *client application* may run a community-written
 * scraper. It is answered because the alternative is worse for a viewer in a
 * specific way: without it these modules do not fail, they *succeed* and
 * return a working URL to a zero-byte file, which the reach probe then had to
 * be taught to catch (`web-plugin-registry.ts`). A module that silently
 * resolves to nothing is the failure mode this whole conversion path exists
 * to make legible.
 *
 * The value says who we actually are rather than impersonating Sora's build:
 * `kuro-cranci-0001` is sixteen characters, carries this client's own name,
 * and satisfies the predicate. If the gate is ever tightened into something
 * that identifies a specific application build, that is a different question
 * and this should not be quietly extended to answer it.
 *
 * Modules without the check never call this and are unaffected.
 */
const HOST_GATE = `
/* --- the host-identification gate ---------------------------------------- */

function _0xB4F2() { return 'kuro-cranci-0001'; }
`;

export function soraEntrypoint(options: SoraEntrypointOptions): string {
	const constants = [
		`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`,
		`const __BASE_URL = ${JSON.stringify(options.baseUrl)};`,
		`const __CONTAINER = ${JSON.stringify(options.container)};`,
		`const __SOFTSUB = ${JSON.stringify(options.softsub)};`
	].join('\n');

	return `${JS_RUNTIME}
${STREAM_GUARDS}
${constants}
${HOST_GATE}

/* --- the module, verbatim ------------------------------------------------ */

const __module = (function () {
${options.script}

  // Collected by name. A module declaring only some of these is a module that
  // does only some of the job, and the adapter below reports which part is
  // missing rather than throwing on an undefined call.
  return {
    searchResults: typeof searchResults === 'function' ? searchResults : null,
    extractDetails: typeof extractDetails === 'function' ? extractDetails : null,
    extractEpisodes: typeof extractEpisodes === 'function' ? extractEpisodes : null,
    extractStreamUrl: typeof extractStreamUrl === 'function' ? extractStreamUrl : null
  };
})();

/* --- the adapter --------------------------------------------------------- */

function __need(name) {
  const fn = __module[name];
  if (typeof fn !== 'function') {
    throw new Error('This converted module does not implement ' + name + '.');
  }
  return fn;
}

/** A Sora search row, as a catalogue entry. */
function __entry(row) {
  if (!row || typeof row !== 'object') return null;
  const href = __absolute(row.href || row.url || '', __BASE_URL);
  const title = String(row.title || row.name || '').trim();
  if (href.length === 0 || title.length === 0) return null;
  return {
    sourceMediaId: href,
    title: title,
    alternativeTitles: [],
    posterImageUrl: __absolute(row.image || row.poster || row.cover || '', __BASE_URL) || undefined
  };
}

/**
 * Episode numbering, which these modules are inconsistent about.
 *
 * Some carry a number, some only an order. Falling back to position keeps the
 * list usable, and it stays in the module's own order because that order is
 * the only statement of sequence a source without numbers makes.
 */
function __episode(row, index) {
  if (!row || typeof row !== 'object') return null;
  const href = __absolute(row.href || row.url || '', __BASE_URL);
  if (href.length === 0) return null;
  const declared = Number(row.number);
  return {
    number: Number.isFinite(declared) && declared > 0 ? declared : index + 1,
    sourceEpisodeId: href,
    title: typeof row.title === 'string' && row.title.length > 0 ? row.title : undefined
  };
}

/** A subtitle sidecar, when the module is one that returns them. */
function __subtitles(url) {
  const value = __absolute(url || '', __BASE_URL);
  if (value.length === 0) return undefined;
  const format = /\\.srt(\\?|$)/i.test(value) ? 'srt' : /\\.ass(\\?|$)/i.test(value) ? 'ass' : 'vtt';
  return [
    {
      // The module says nothing about which language this is, and inventing
      // one would put a wrong label in the player's track menu.
      languageCode: 'und',
      label: 'Subtitles',
      format: format,
      url: value,
      isEmbedded: false,
      isDefault: true
    }
  ];
}

/**
 * Every shape these modules return a stream in.
 *
 * There are more of them than the format's documentation suggests, and getting
 * this wrong is silent: a shape this function does not recognise becomes an
 * empty list, which the install check reports as "that source returned no
 * stream" — blaming the module's author for a key this shim did not read.
 *
 * Measured across a real library of 28 modules: 18 return the location as
 * "streamUrl" and only 6 as "url"; 11 name subtitles "subtitle" and 6
 * "subtitles"; 15 attach per-stream "headers". An earlier version of this
 * function read "url" and "subtitles" alone, and so dropped the streams of
 * roughly two thirds of them.
 */
function __location(item) {
  if (!item || typeof item !== 'object') return '';
  // In the order the ecosystem prefers them.
  const value = item.streamUrl || item.url || item.file || item.link || item.src || '';
  return typeof value === 'string' ? value : '';
}

function __label(item) {
  if (!item || typeof item !== 'object') return '';
  const value = item.title || item.quality || item.label || item.name || '';
  return typeof value === 'string' ? value : '';
}

/**
 * Request headers a stream needs, carried through to the player.
 *
 * Dropping these is not cosmetic: a source that checks "Referer" serves the
 * manifest and then refuses every segment, which looks like a working plugin
 * that plays nothing. PlaybackSource.headers is exactly the field the host
 * exists to satisfy, on whichever surface it is running (ABI.md 4.1).
 */
function __headers(item) {
  if (!item || typeof item !== 'object') return undefined;
  const raw = item.headers;
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  let any = false;
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** Either spelling, and either a string or a list. */
function __subtitleOf(container) {
  if (!container || typeof container !== 'object') return '';
  const value = container.subtitles !== undefined ? container.subtitles : container.subtitle;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length > 0) {
    const first = value[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object') {
      return typeof first.url === 'string' ? first.url : typeof first.file === 'string' ? first.file : '';
    }
  }
  return '';
}

function __streams(value) {
  const decoded = __decode(value);
  if (typeof decoded === 'string') {
    return decoded.length > 0 ? [{ url: decoded, subtitles: '' }] : [];
  }
  if (!decoded || typeof decoded !== 'object') return [];

  // A subtitle declared once, beside the list, applies to all of them.
  const shared = __subtitleOf(decoded);
  const out = [];

  if (Array.isArray(decoded.streams)) {
    for (let i = 0; i < decoded.streams.length; i += 1) {
      const item = decoded.streams[i];
      if (typeof item === 'string') {
        if (!/^https?:/i.test(item)) continue;
        // Sometimes [label, url, label, url, …].
        const previous = decoded.streams[i - 1];
        const label = typeof previous === 'string' && !/^https?:/i.test(previous) ? previous : '';
        out.push({ url: item, label: label, subtitles: shared });
        continue;
      }
      const url = __location(item);
      if (url.length === 0) continue;
      out.push({
        url: url,
        label: __label(item),
        headers: __headers(item),
        subtitles: __subtitleOf(item) || shared
      });
    }
  }

  // A single stream may sit beside the list, or stand alone.
  const single = typeof decoded.stream === 'string' ? decoded.stream : __location(decoded);
  if (typeof single === 'string' && single.length > 0) {
    out.push({
      url: single,
      label: __label(decoded),
      headers: __headers(decoded),
      subtitles: shared
    });
  }
  return out;
}

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    // Sora modules are single-page by construction; see this file's header.
    if (Number(page) > 1) return { entries: [] };

    const rows = __array(await __need('searchResults')(String(query)));
    const entries = [];
    for (const row of rows) {
      const entry = __entry(row);
      if (entry !== null) entries.push(entry);
    }
    return { entries: entries };
  },

  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    const rows = __array(await __need('extractEpisodes')(String(sourceMediaId)));
    const episodes = [];
    for (let index = 0; index < rows.length; index += 1) {
      const episode = __episode(rows[index], index);
      if (episode !== null) episodes.push(episode);
    }
    // Ascending, because a source listing newest first is common and an
    // episode grid that counts down is not what anyone means by episode one.
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    const target = episode && episode.sourceEpisodeId ? episode.sourceEpisodeId : sourceMediaId;
    const found = __streams(await __need('extractStreamUrl')(String(target)));

    const sources = [];
    for (const item of found) {
      const url = __absolute(item.url, __BASE_URL);
      if (!__isPlayable(url)) continue;
      sources.push({
        url: url,
        container: __CONTAINER,
        label: item.label && item.label.length > 0 ? item.label : 'Source',
        headers: item.headers,
        // The manifest's "softsub" flag says the module *can* return subtitles,
        // not that this particular result did. Reading the result is the more
        // reliable signal, and a module that returns one while its manifest
        // says otherwise should not have it thrown away.
        subtitles: __subtitles(item.subtitles)
      });
    }
    return sources;
  }
};
`;
}
