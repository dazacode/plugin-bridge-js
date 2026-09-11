/**
 * A Mangayomi JavaScript source, wrapped as a Yorozo plugin bundle.
 *
 * The counterpart to `sora-entry.ts`, and built the same way: the shared
 * runtime, the foreign script inside a closure, and an adapter presenting its
 * methods as the three ABI ones. The script itself is embedded **verbatim**,
 * which is what lets a conversion be audited by diffing against the original.
 *
 * ## Why this format converts and its sibling does not
 *
 * A listing in this ecosystem points at a *source file*, not a package, and
 * names the language it is written in. Roughly a third of a typical anime
 * catalogue is JavaScript and the rest Dart. The JavaScript third needs no
 * translation at all — only the globals its own host provides — which is what
 * this file supplies. The Dart majority still needs an interpreter and still
 * refuses.
 *
 * ## The globals the format provides, and where each comes from
 *
 * | Foreign global | Answered by |
 * | --- | --- |
 * | `Document` | `shims/dom.ts`, inlined as source (`generated/dom-source.ts`) |
 * | `Client` | `ctx.http`, via `__host()` |
 * | `MProvider` | declared here; carries `source` and `getPreference` |
 * | `SharedPreferences` | the same lookup, over the manifest's own `settings` |
 * | `unpackJs` | `extract/patterns.ts`, inlined by the same generator |
 * | `__episodeNumber` | `foreign/episode-recognition.ts`, as its own `toString()` |
 *
 * `Document` is the reason this file needs a generated source blob at all. A
 * bundle is one self-contained ES2020 module (`ABI.md` §1) with no module
 * resolution inside the sandbox, so the parser cannot be imported — it has to
 * travel *into* the bundle. `tool/gen-plugin-runtime.ts` is what puts it there.
 *
 * ## Three mismatches this file absorbs
 *
 * **Episode numbers do not exist.** The format returns an ordered list of named
 * episodes and nothing else. The name is asked first, through
 * `foreign/episode-recognition.ts` — the ecosystem's own numbering algorithm,
 * which removes the show's title before reading a number and so does *not*
 * renumber a season whose title contains a digit, which is what made naive
 * name-parsing unusable. A row whose name states nothing is then placed
 * *between* the rows whose names did, rather than counted, because a count
 * collides with them. Only a list where no name states anything falls back to
 * the position, counted from the end. `__numberEpisodes` is where all of that
 * lives, and its doc-comment is the argument for it.
 *
 * **Quality is a free string.** `1080p`, `HD` and `Server 3` are all in
 * circulation. It becomes the label verbatim, and `heightPx` is set only when
 * the string actually states a height — inventing one puts a wrong number in
 * the player's quality menu, which is worse than an absent one.
 *
 * **Details and episodes arrive together.** `getDetail` returns both, where the
 * ABI asks for episodes alone. The adapter calls it and takes the half it was
 * asked for; there is no metadata path here by design (`ABI.md` §1, "no
 * metadata methods" — a source does not get to say what a show is).
 */

import { EPISODE_RECOGNITION_SOURCE } from '@plugin-bridge/core/episode-recognition';
import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';

export interface MangayomiEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/** The source file, embedded verbatim. */
	readonly script: string;
	/**
	 * The listing's own row, as a fallback for `this.source`.
	 *
	 * Most of these files declare `mangayomiSources` themselves, and that copy
	 * is preferred because it is what the author tested against. This is what a
	 * file that omits it gets instead.
	 */
	readonly source: Readonly<Record<string, unknown>>;
	/**
	 * Foreign preference key to manifest setting id, for what the manifest
	 * declares.
	 *
	 * Empty for a source that declares nothing this build could read, and the
	 * bundle then behaves exactly as it did before settings existed: every read
	 * falls through to the source's own declared default.
	 */
	readonly settingIds?: Readonly<Record<string, string>>;
}

/**
 * The format's own globals, as bundle source.
 *
 * Exported separately from the entrypoint so its spec can evaluate it directly
 * rather than through a whole conversion.
 */
export const MANGAYOMI_RUNTIME = `
/* --- the DOM engine, inlined ---------------------------------------------- */
${DOM_RUNTIME_SOURCE}
const __rt = globalThis.__yorozoRuntime;

/* --- the format's globals -------------------------------------------------- */

/** Wraps a parsed node in the property-shaped API these sources expect. */
class __El {
  constructor(node) { this.__node = node; }

  select(selector) {
    const out = [];
    for (const node of this.__node.select(selector)) out.push(new __El(node));
    return out;
  }
  selectFirst(selector) {
    const node = this.__node.selectFirst(selector);
    return node === null ? null : new __El(node);
  }
  attr(name) { return this.__node.attr(name); }
  hasAttr(name) { return this.__node.hasAttr(name); }

  // Properties, not methods. This format reads '.text' where the parser
  // underneath exposes '.text()', and a scraper written against the former
  // gets a function object out of the latter rather than an error.
  get text() { return this.__node.text(); }
  get ownText() { return this.__node.ownText(); }
  get html() { return this.__node.html(); }
  get outerHtml() { return this.__node.outerHtml(); }
  get className() { return this.__node.className; }
  get id() { return this.__node.id; }

  // Deliberately the raw attribute, not an absolutised one: these sources
  // concatenate the base url themselves, and resolving here would produce a
  // doubled origin everywhere they do.
  get getHref() { return this.__node.attr('href'); }
  get getSrc() { return this.__node.attr('src'); }
}

class Document extends __El {
  constructor(html) {
    super(__rt.parseHtml(html === null || html === undefined ? '' : String(html), __BASE_URL));
  }
}

/** The response shape these sources read: '.body', and sometimes a status. */
async function __send(method, url, headers, body) {
  const raw = await __host().http.send(String(url), {
    method: method,
    headers: headers && typeof headers === 'object' ? headers : {},
    body: body === undefined || body === null
      ? null
      : (typeof body === 'string' ? body : JSON.stringify(body))
  });
  return {
    body: await raw.text(),
    statusCode: raw.status,
    headers: raw.headers,
    url: raw.url,
    hasError: !(raw.status >= 200 && raw.status < 300)
  };
}

class Client {
  async get(url, headers) { return __send('GET', url, headers, null); }
  async post(url, headers, body) { return __send('POST', url, headers, body); }
  async request(options) {
    const o = options || {};
    return __send(o.method || 'GET', o.url, o.headers, o.body);
  }
}

/* String helpers the format adds to every string. */
String.prototype.substringAfter = function (d) {
  const i = this.indexOf(d); return i === -1 ? '' : this.slice(i + String(d).length);
};
String.prototype.substringAfterLast = function (d) {
  const i = this.lastIndexOf(d); return i === -1 ? '' : this.slice(i + String(d).length);
};
String.prototype.substringBefore = function (d) {
  const i = this.indexOf(d); return i === -1 ? '' : this.slice(0, i);
};
String.prototype.substringBeforeLast = function (d) {
  const i = this.lastIndexOf(d); return i === -1 ? '' : this.slice(0, i);
};
String.prototype.substringBetween = function (a, b) {
  return String(this).substringAfter(a).substringBefore(b);
};

function unpackJs(source) { return __rt.unpackDeanEdwards(String(source)); }

/**
 * A per-host extractor this build does not have, as a function that says so.
 *
 * Throws only when called, so a source that merely captures or replaces the
 * name still loads, searches and lists episodes.
 */
function __noExtractor(name) {
  return function () {
    throw new Error(
      'This source resolves streams with ' + name + ', one of the per-host extractors its ' +
      'own app provides. Yorozo does not include those, so it can browse this source but ' +
      'not play it.'
    );
  };
}

/** The base every source extends. */
class MProvider {
  constructor() { this.source = __SOURCE; }

  /**
   * A preference's value: the viewer's, or the source's own declared default.
   *
   * The conversion reads 'getSourcePreferences()' statically and declares what
   * it found as manifest settings, so the host has something to draw and
   * something to store. Reading the source's own declared default is still the
   * last step, and it is the whole answer for a bundle that declares nothing —
   * which keeps a source whose base url or preferred server is a preference
   * working rather than reading an empty string and failing far from the cause.
   */
  getPreference(key) { return __preference(key, this); }

  getSourcePreferences() { return []; }
  getFilterList() { return []; }
  getHeaders() { return {}; }
  get supportsLatest() { return true; }
}

/**
 * The other way these sources read a preference, and it is the commoner one.
 *
 * Measured across a real catalogue of 24 sources: 67 uses of this class against
 * 6 of \`getPreference\`. It is reached from module scope as often as from a
 * method, which is why the default lookup below cannot depend on having an
 * instance in hand.
 *
 * \`set\` writes to a per-run overlay and does **not** reach the host. A
 * viewer's settings are the viewer's: \`ABI.md\` §1 has the host draw them and
 * the plugin read them, and a plugin that could write one back would be editing
 * a screen it is not allowed to draw. But these sources write a preference to
 * remember a resolved mirror or a chosen server and then read it again moments
 * later, so a write that vanishes is a read contradicting the line above it.
 * The overlay makes a session self-consistent without making it persistent, and
 * it dies with the sandbox.
 */
class SharedPreferences {
  get(key) { return __preference(key, null); }
  getString(key, fallback) {
    const value = __preference(key, null);
    return typeof value === 'string' && value.length > 0 ? value : (fallback === undefined ? '' : fallback);
  }
  getBoolean(key, fallback) {
    const value = __preference(key, null);
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback === undefined ? false : fallback;
  }
  getStringSet(key, fallback) {
    const value = __preference(key, null);
    if (Array.isArray(value)) return value;
    return fallback === undefined ? [] : fallback;
  }
  set(key, value) { __written[String(key)] = value; }
  setString(key, value) { __written[String(key)] = value; }
  setStringSet(key, value) { __written[String(key)] = value; }
  setBool(key, value) { __written[String(key)] = value === true; }
  remove(key) { delete __written[String(key)]; }
  clear() { for (const key of Object.keys(__written)) delete __written[key]; }
}

/** What this run wrote. Never persisted; see \`SharedPreferences.set\`. */
const __written = Object.create(null);

/**
 * A foreign preference key, as the manifest setting id the host stores under.
 *
 * The conversion emits the exact map, because two keys can normalise to the
 * same id and the second would otherwise read the first one's value. The
 * normalisation stays as the fallback, for a key the conversion never saw — a
 * source that reads a preference it never declared.
 */
const __SETTING_IDS = __SETTING_ID_MAP;
function __settingId(key) {
  const mapped = __SETTING_IDS[String(key)];
  if (typeof mapped === 'string') return mapped;
  return String(key).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 48);
}

/**
 * A preference's value, in the order that makes a source work.
 *
 * 1. What this run wrote, so a mirror the source just resolved reads back.
 * 2. What the viewer chose, through the manifest \`settings\` this conversion
 *    derived and the host drew.
 * 3. The source's own declared default, which is the whole answer for a bundle
 *    that declares nothing — one installed before this existed, or one whose
 *    preferences are assembled at runtime and so could not be read statically.
 */
function __preference(key, provider) {
  const name = String(key);
  if (Object.prototype.hasOwnProperty.call(__written, name)) return __written[name];

  const id = __settingId(name);
  const chosen = __host().settings.string(id);
  if (typeof chosen === 'string' && chosen.length > 0) return chosen;
  const list = __host().settings.list(id);
  if (Array.isArray(list) && list.length > 0) return list;
  if (__host().settings.boolean(id) === true) return true;

  return __declaredDefault(provider === null ? __declaredPrefs() : __sourcePrefsOf(provider), key);
}

function __sourcePrefsOf(provider) {
  try {
    return provider.getSourcePreferences() || [];
  } catch (error) {
    return [];
  }
}

/**
 * The declared preferences, for a caller with no instance in hand.
 *
 * Built once, by instantiating the source. Two ways that can fail, and neither
 * may be cached as an answer:
 *
 * - **Too early.** These sources read preferences at their own module scope,
 *   which runs while the closure below is still evaluating — so \`__Extension\`
 *   is still in its temporal dead zone and even \`typeof\` on it throws. That is
 *   a "not yet", not an "empty".
 * - **Reentrantly.** A constructor that reads a preference would otherwise
 *   recurse forever, so a build already in progress answers empty *without*
 *   storing it.
 *
 * Caching either case would make every later read return nothing, which is the
 * silent-wrongness this whole layer is built to avoid.
 */
let __prefsCache = null;
let __prefsBuilding = false;
function __declaredPrefs() {
  if (__prefsCache !== null) return __prefsCache;
  if (__prefsBuilding) return [];
  __prefsBuilding = true;
  try {
    __prefsCache = __sourcePrefsOf(new __Extension());
  } catch (error) {
    return [];
  } finally {
    __prefsBuilding = false;
  }
  return __prefsCache;
}

function __declaredDefault(declared, key) {
  for (const entry of declared) {
    if (!entry || entry.key !== key) continue;
    const list = entry.listPreference;
    if (list) {
      const values = list.entryValues || [];
      const index = Number(list.valueIndex);
      return values[Number.isFinite(index) && index >= 0 ? index : 0] || '';
    }
    if (entry.editTextPreference) return entry.editTextPreference.value || '';
    if (entry.switchPreferenceCompat) return entry.switchPreferenceCompat.value === true;
    if (entry.multiSelectListPreference) return entry.multiSelectListPreference.values || [];
  }
  return '';
}
`;

/**
 * Extractor-shaped names a source expects its own app to have provided.
 *
 * This ecosystem's runtime ships a large family of built-in **per-host stream
 * extractors**, and a source reaches them as bare globals. Two patterns are in
 * circulation, and both fail without a declaration:
 *
 * ```js
 * const videos = await someExtractor(url);      // plain call
 * _someExtractor = someExtractor;               // capture, then replace
 * someExtractor = async (url) => { ... };
 * ```
 *
 * A bundle is a module and modules are strict, so the second pattern throws on
 * the *assignment* to an undeclared name before it ever reaches a call.
 *
 * Yorozo does not have these and may not grow them: they are named after
 * specific video hosts and are made of their hostnames and URL patterns, and
 * `FOREIGN.md` §4.1.3 draws its line exactly there — a template is a shape and
 * may ship, a per-host extractor is a content source and may not.
 *
 * So each name is declared as a stub that **throws when called, naming
 * itself**. The names come out of the source being converted, on the viewer's
 * own device; this repository contains no list of them and cannot, which is the
 * whole point. A source that needs one still converts, still searches and still
 * lists episodes — it fails at `resolve`, which is the step `verify.ts` runs
 * before recording an install, so the refusal reaches a person as a sentence
 * naming what was missing rather than as a black screen.
 */
export function extractorNames(script: string): string[] {
	const found = new Set<string>();
	const pattern = /\b[A-Za-z_$][A-Za-z0-9_$]*[Ee]xtractor\b/g;
	let match = pattern.exec(script);
	while (match !== null && found.size < 64) {
		found.add(match[0]);
		match = pattern.exec(script);
	}
	return [...found].sort();
}

export function mangayomiEntrypoint(options: MangayomiEntrypointOptions): string {
	const constants = [
		`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`,
		`const __FALLBACK_SOURCE = ${JSON.stringify(options.source)};`,
		`const __BASE_URL = String(__FALLBACK_SOURCE.baseUrl || '');`,
		`const __SETTING_ID_MAP = ${JSON.stringify(options.settingIds ?? {})};`
	].join('\n');

	// `let`, at module scope, so a source that reassigns one of these is
	// assigning to a declared binding rather than throwing in strict mode.
	const stubs = extractorNames(options.script)
		.map((name) => `let ${name} = __noExtractor(${JSON.stringify(name)});`)
		.join('\n');

	return `${JS_RUNTIME}
${STREAM_GUARDS}
${EPISODE_RECOGNITION_SOURCE}
${constants}

// Declared before the runtime, because MProvider's constructor reads it, and
// reassigned below if the source carries its own copy — the one its author
// actually tested against.
var __SOURCE = __FALLBACK_SOURCE;

${MANGAYOMI_RUNTIME}

/* --- extractors this build does not have ----------------------------------- */
${stubs}

/* --- the source, verbatim -------------------------------------------------- */

const __Extension = (function () {
${options.script}

  if (typeof mangayomiSources !== 'undefined' && Array.isArray(mangayomiSources) && mangayomiSources.length > 0) {
    __SOURCE = mangayomiSources[0];
  }
  return typeof DefaultExtension === 'function' ? DefaultExtension : null;
})();

/* --- the adapter ----------------------------------------------------------- */

function __provider() {
  if (__Extension === null) {
    throw new Error('This converted source does not declare a DefaultExtension class.');
  }
  return new __Extension();
}

function __need(provider, name) {
  if (typeof provider[name] !== 'function') {
    throw new Error('This converted source does not implement ' + name + '.');
  }
  return provider[name].bind(provider);
}

function __wanted(page) {
  const requested = Number(page);
  return Number.isFinite(requested) && requested > 0 ? requested : 1;
}

/**
 * The form a source expects one of its own ids back in.
 *
 * A media id is stored, so it has to be absolute — a relative one stops
 * resolving the moment it leaves this process. But these sources emit *relative*
 * links and then concatenate their own base url when they are handed one back,
 * so passing the absolute form straight through produces a doubled origin and a
 * request that can only 404.
 *
 * So the id is absolutised on the way out and reduced again on the way in. A
 * link that was already absolute, or that points somewhere other than the base,
 * is passed through untouched: only the prefix this shim added is removed.
 */
function __foreign(id) {
  const value = String(id === null || id === undefined ? '' : id);
  if (__BASE_URL.length === 0) return value;
  const base = __BASE_URL.replace(/\\/+$/, '');
  if (value.indexOf(base) !== 0) return value;
  const rest = value.slice(base.length);
  if (rest.length === 0) return '/';
  return rest.charAt(0) === '/' ? rest : '/' + rest;
}

/** A listing row, as a catalogue entry. */
function __entry(row) {
  if (!row || typeof row !== 'object') return null;
  const link = __absolute(String(row.link || row.url || ''), __BASE_URL);
  const title = String(row.name || row.title || '').trim();
  if (link.length === 0 || title.length === 0) return null;
  return {
    sourceMediaId: link,
    title: title,
    alternativeTitles: [],
    posterImageUrl: __absolute(String(row.imageUrl || row.cover || ''), __BASE_URL) || undefined
  };
}

function __page(value) {
  const decoded = __decode(value);
  if (!decoded || typeof decoded !== 'object') return { entries: [] };
  const rows = Array.isArray(decoded.list) ? decoded.list : [];
  const entries = [];
  for (const row of rows) {
    const entry = __entry(row);
    if (entry !== null) entries.push(entry);
  }
  return { entries: entries, hasMore: decoded.hasNextPage === true };
}

/**
 * Numbers for one list of episode names, in the order the source stated them.
 *
 * Three rules, and the second and third exist because of the first.
 *
 * **A name that states its own number is believed.** It is not a guess, and it
 * is the number every other client in this ecosystem shows for the same
 * episode. \`__episodeNumber\` returns -1 when a name states nothing; zero is an
 * answer, because a prologue numbered zero is a real episode.
 *
 * **A row whose name states nothing is placed between the rows that do.** It
 * may not simply be counted, because a count collides: eleven named episodes
 * plus one unnamed extra, counted from the end, hands that extra the number
 * one — which episode one already has, and two rows claiming the same episode
 * is a wrong number in front of a viewer. So it takes its number from its
 * stated neighbours, shared out by its position in the list, and continues the
 * sequence by one step past either end. The list's own order survives and
 * nothing can land on a stated number.
 *
 * **Only when nothing in the list states a number does the old answer apply.**
 * This format states an order and no numbers, and these sites list newest first
 * far more often than not, so count from the end. That is still a guess about
 * which way the list runs, and for a nameless list it is still the honest one.
 *
 * Rows the caller could not use — no url — are dropped before any of this, so a
 * count is over rows a viewer will actually see rather than over rows the
 * source sent.
 */
function __numberEpisodes(showTitle, names) {
  const count = names.length;
  const stated = [];
  let firstStated = -1;
  let lastStated = -1;

  for (let i = 0; i < count; i += 1) {
    const read = names[i].length > 0 ? __episodeNumber(showTitle, names[i]) : -1;
    stated.push(read >= 0 ? read : null);
    if (read >= 0) {
      if (firstStated === -1) firstStated = i;
      lastStated = i;
    }
  }

  const numbers = [];

  if (firstStated === -1) {
    for (let i = 0; i < count; i += 1) numbers.push(count - i);
    return numbers;
  }

  // Which way the stated numbers run in the list's own order: descending for a
  // newest-first listing, ascending for the other kind. Read from the first and
  // last statement rather than assumed, and falling back to newest-first when
  // there is only one statement to read.
  const step = stated[lastStated] > stated[firstStated] ? 1 : -1;

  const taken = [];
  for (let i = 0; i < count; i += 1) {
    numbers.push(stated[i]);
    if (stated[i] !== null) taken.push(stated[i]);
  }

  for (let i = 0; i < count; i += 1) {
    if (stated[i] !== null) continue;

    let before = -1;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (stated[j] !== null) { before = j; break; }
    }
    let after = -1;
    for (let j = i + 1; j < count; j += 1) {
      if (stated[j] !== null) { after = j; break; }
    }

    let local;
    let value;
    if (before !== -1 && after !== -1) {
      // Share the distance between two statements out by position, so a run of
      // unnamed rows stays in order and stays between them.
      let span = stated[after] - stated[before];
      // Two rows claiming the same number. Still move, or the fill lands on it.
      if (span === 0) span = step;
      local = span / (after - before);
      value = stated[before] + local * (i - before);
    } else if (before !== -1) {
      local = step;
      value = stated[before] + step * (i - before);
    } else {
      local = step;
      value = stated[after] - step * (after - i);
    }

    const placed = __freeEpisodeNumber(value, local, taken);
    numbers[i] = placed;
    taken.push(placed);
  }

  return numbers;
}

/**
 * \`value\`, moved off any number another row already has.
 *
 * Reachable only from a list the source made strange — two rows naming the same
 * episode with an unnamed one between them, say. The shift is halves of the
 * local step, so the row creeps toward the row after it without ever reaching
 * or passing it: each try is a new number, the sequence converges, and the
 * list's order survives the repair.
 */
function __freeEpisodeNumber(value, local, taken) {
  let candidate = value;
  let shift = local / 2;
  for (let guard = 0; guard < 24; guard += 1) {
    if (taken.indexOf(candidate) === -1) return candidate;
    candidate = candidate + shift;
    shift = shift / 2;
  }
  return candidate;
}

/**
 * A height, only when the source actually stated one.
 *
 * "1080p" and "1920x1080" state a height. "HD", "Server 3" and "Auto" do not,
 * and turning them into a number would put a confident wrong value in the
 * quality menu.
 */
function __height(quality) {
  const labelled = /(\\d{3,4})\\s*p\\b/i.exec(quality);
  const sized = /\\d{3,4}\\s*[x\\u00d7]\\s*(\\d{3,4})/i.exec(quality);
  const match = labelled || sized;
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 144 && value <= 4320 ? value : undefined;
}

function __tracks(value) {
  if (!Array.isArray(value)) return undefined;
  const out = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const track = __subtitleTrack(
      __absolute(String(row.file || row.url || ''), __BASE_URL),
      String(row.label || ''),
      String(row.language || '')
    );
    if (track !== null) out.push(track);
  }
  return out.length > 0 ? out : undefined;
}

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    const provider = __provider();
    return __page(await __need(provider, 'search')(String(query), __wanted(page), []));
  },

  async browse(shelf, page, ctx) {
    __enter(ctx);
    const provider = __provider();
    // Two shelves is all this format states: what is popular, and what changed.
    const method = shelf === 'latest' && typeof provider.getLatestUpdates === 'function'
      ? 'getLatestUpdates'
      : 'getPopular';
    return __page(await __need(provider, method)(__wanted(page)));
  },

  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    const provider = __provider();
    const detail = __decode(await __need(provider, 'getDetail')(__foreign(sourceMediaId)));
    if (!detail || typeof detail !== 'object') return [];

    const rows = Array.isArray(detail.episodes)
      ? detail.episodes
      : (Array.isArray(detail.chapters) ? detail.chapters : []);

    // Removed from every episode name before a number is read out of it, so
    // that a show whose own title carries digits is not renumbered by them.
    const showTitle = typeof detail.name === 'string'
      ? detail.name
      : (typeof detail.title === 'string' ? detail.title : '');

    // Collected in the source's own order first, because numbering is a
    // decision about the list rather than about each row: what a row gets when
    // its name says nothing depends on what its neighbours' names said.
    const urls = [];
    const names = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== 'object') continue;
      const url = __absolute(String(row.url || ''), __BASE_URL);
      if (url.length === 0) continue;
      urls.push(url);
      names.push(typeof row.name === 'string' ? row.name : '');
    }

    const numbers = __numberEpisodes(showTitle, names);

    const episodes = [];
    for (let index = 0; index < urls.length; index += 1) {
      episodes.push({
        number: numbers[index],
        sourceEpisodeId: urls[index],
        title: names[index].length > 0 ? names[index] : undefined
      });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    const provider = __provider();
    const target = episode && episode.sourceEpisodeId ? episode.sourceEpisodeId : sourceMediaId;
    const rows = __array(await __need(provider, 'getVideoList')(__foreign(target)));

    const sources = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const url = __absolute(String(row.url || row.originalUrl || ''), __BASE_URL);
      if (!__isPlayable(url)) continue;
      const quality = String(row.quality || '').trim();
      sources.push({
        url: url,
        // Read from the url rather than declared per stream: this format says
        // nothing about the container, and a wrong guess is a player error.
        container: /\\.m3u8(\\?|$)/i.test(url) ? 'hls' : (/\\.mpd(\\?|$)/i.test(url) ? 'dash' : 'mp4'),
        label: quality.length > 0 ? quality : 'Source',
        quality: quality.length > 0 ? quality : undefined,
        heightPx: __height(quality),
        headers: row.headers && typeof row.headers === 'object' ? row.headers : undefined,
        subtitles: __tracks(row.subtitles)
      });
    }
    return sources;
  }
};
`;
}
