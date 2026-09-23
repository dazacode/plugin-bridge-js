/**
 * A Stremio addon, wrapped as a Yorozo plugin bundle.
 *
 * ## The one format with nothing to translate
 *
 * Every other adapter in this package ports a *program*: an APK's classes, a
 * module's JavaScript, a source file's Dart. `FOREIGN.md` §4.1 puts the cost
 * plainly — "neither gets you the classpath, and the classpath is the work".
 *
 * An addon is not a program. It is an HTTP service with a published protocol:
 * `/manifest.json` says what it serves, and `/{resource}/{type}/{id}.json`
 * serves it. So conversion produces a **client for the protocol**, generated
 * here, parameterised by the addon's base URL — not a port of anyone's code.
 * Nothing of the author's is embedded, which is why this is the only format
 * whose bundles carry no upstream licence: there is no upstream artifact.
 *
 * That has a consequence worth stating, because it is easy to assume
 * otherwise: **this file is the same for every addon.** A hundred installed
 * addons are a hundred bundles of identical code with different constants, and
 * a bug fixed here is fixed for all of them at the next re-conversion.
 *
 * ## Addressed by id, not searched by title
 *
 * The protocol is keyed on IMDB ids — `tt0944947` for a series, and
 * `tt0944947:1:5` for one episode of it. The host already holds that id, so
 * the ordinary search-and-score path is not merely unnecessary here, it is
 * unavailable: a stream-only addon publishes `catalogs: []` and cannot be
 * asked for a title at all. `searchCatalog` below answers from the addon's own
 * catalogue when it has one and otherwise returns nothing, and binding happens
 * through `ConversionRecord.idKinds` instead.
 *
 * ## What the protocol returns that we cannot play
 *
 * A `Stream` object names its content in one of several mutually exclusive
 * ways, and only one of them is a thing a browser can open:
 *
 * - `url` — an http(s) link. The only playable case.
 * - `infoHash` — a torrent. `FOREIGN.md` §4.2 already settles this: Yorozo's
 *   players take an HTTP url, neither can play a magnet, and there is no
 *   torrent client in the product. Measured against one live addon, this was
 *   **132 of 132** streams returned, so this is the common case and not an
 *   edge: a viewer's own debrid configuration is what turns those into `url`,
 *   and the addon does that itself, in the URL the viewer pasted.
 * - `externalUrl` — a link to somebody's web player or a shop page. Measured
 *   at 12 of 12 on another live addon. Not a stream; opening one would leave
 *   the app.
 * - `ytId` — a YouTube id, which needs an embed this player does not host.
 *
 * All four are *dropped silently here* rather than reported, because a source
 * that returned thirty torrents and one url has not failed — it answered, and
 * the url is the answer. `resolve` returning an empty list is what the
 * playback layer already reads as "this source had nothing playable", and that
 * sentence is true.
 */

import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

export interface StremioEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/**
	 * Everything before `/manifest.json`, including any configuration segment.
	 *
	 * Addons are configured by *path* — a viewer pastes a URL that already
	 * carries their own key or preferences in it — so treating the base as an
	 * opaque prefix is what makes a configured addon work with no special
	 * handling. It is also why nothing here parses or logs it.
	 */
	readonly baseUrl: string;
	/** `movie`, `series`, and whatever else the manifest declared. */
	readonly types: readonly string[];
	/**
	 * What the manifest says this addon answers: `stream`, `meta`, `catalog`.
	 *
	 * Load-bearing rather than descriptive. An addon that declares only
	 * `stream` — which every torrent indexer is — has no episode list and
	 * never claimed one, and asking anyway produced an empty answer the host
	 * read as "this source does not have that episode".
	 */
	readonly resources: readonly string[];
	/** Catalogue ids this addon will answer a `search` extra for. */
	readonly searchable: readonly { readonly type: string; readonly id: string }[];
	/**
	 * The addon's own configuration fields, as the host stores them.
	 *
	 * `id` is what `ctx.settings` answers to; `key` is what the addon spelled
	 * it, and the difference matters because the segment sent back has to be
	 * keyed the addon's way. Empty for an addon that declares no configuration,
	 * which is most of them.
	 */
	readonly config: readonly {
		readonly id: string;
		readonly key: string;
		readonly type: string;
	}[];
	/** `behaviorHints.configurable` — this addon has a page to set it up on. */
	readonly configurable?: boolean;
	/** Whether the address the viewer pasted already carries their settings. */
	readonly baseConfigured?: boolean;
	/** That page's address, empty for an addon that declares none. */
	readonly configureUrl?: string;
}

export function stremioEntrypoint(options: StremioEntrypointOptions): string {
	const constants = [
		`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`,
		`const __BASE_URL = ${JSON.stringify(options.baseUrl.replace(/\/+$/, ''))};`,
		`const __TYPES = ${JSON.stringify(options.types)};`,
		`const __RESOURCES = ${JSON.stringify(options.resources ?? [])};`,
		`const __SEARCHABLE = ${JSON.stringify(options.searchable)};`,
		`const __CONFIG = ${JSON.stringify(options.config)};`,
		`const __CONFIGURABLE = ${JSON.stringify(options.configurable === true)};`,
		`const __BASE_CONFIGURED = ${JSON.stringify(options.baseConfigured === true)};`,
		`const __CONFIGURE_URL = ${JSON.stringify(options.configureUrl ?? '')};`
	].join('\n');

	return `${JS_RUNTIME}
${STREAM_GUARDS}
${constants}

/* --- the protocol -------------------------------------------------------- */

/**
 * One request against the addon, as JSON.
 *
 * Every route of this protocol is a GET returning JSON, and a 404 is a
 * legitimate "I have nothing for that" rather than a failure — an addon is
 * explicitly allowed to serve only the ids it knows. So a bad status yields
 * null and the caller treats it as empty, while a genuinely broken response
 * (unreachable, unparseable) throws and is reported.
 */
/**
 * The viewer's own configuration, as the one path segment this protocol sends
 * it back in.
 *
 * The ecosystem's SDK parses that segment as JSON, so this builds the object
 * the addon declared — keyed the way *it* spelled each field, not the way this
 * host's schema had to normalise the id — and encodes it.
 *
 * Empty when nothing is set, and then the address is untouched. That matters
 * for the common case: an addon configured on its own page carries its settings
 * in the URL already, and appending a second, empty segment would change an
 * address that was working.
 */
function __configSegment() {
  if (!Array.isArray(__CONFIG) || __CONFIG.length === 0) return '';

  const chosen = {};
  let any = false;
  for (const field of __CONFIG) {
    if (field.type === 'switch') {
      const on = __host().settings.boolean(field.id);
      if (on === true) { chosen[field.key] = true; any = true; }
      continue;
    }
    const value = __host().settings.string(field.id);
    if (typeof value === 'string' && value.length > 0) { chosen[field.key] = value; any = true; }
  }
  if (!any) return '';
  return '/' + encodeURIComponent(JSON.stringify(chosen));
}

/**
 * Whether this addon has a setup step nobody has taken.
 *
 * Asked at request time rather than baked in, because two of the three
 * conditions are decided after conversion: a viewer who fills in the addon's
 * declared fields has configured it without changing its address, and that has
 * to count. All three must hold — it says it is configurable, the address
 * carries no segment, and nothing was entered here — so an addon that is
 * merely *configurable* and works perfectly well on its defaults is never
 * accused of being unset.
 */
function __unconfigured() {
  return __CONFIGURABLE === true && __BASE_CONFIGURED !== true && __configSegment() === '';
}

/**
 * The refusal an addon gives when it has nothing to answer *with*.
 *
 * 401 and 403 are what this ecosystem's addons return for a request carrying
 * no configuration, and read as a status alone they are indistinguishable from
 * an anti-bot wall — which is what the host classified them as, telling a
 * viewer a working addon had "refused an automated request". Measured on a
 * live one: 403 for every stream request against the bare address, with a
 * browser's own user agent as readily as with ours, and 200 the moment any
 * configuration segment is present.
 *
 * So the *status is not the evidence* — the addon having a setup step nobody
 * has taken is. This sentence says that, names the page, and deliberately does
 * not contain the number: the host reads these strings, and a status in the
 * text is what made it guess wrong in the first place.
 */
function __unconfiguredError() {
  return new Error(
    'This addon has not been set up yet. It has to be configured on its own page' +
      (__CONFIGURE_URL.length > 0 ? ' — ' + __CONFIGURE_URL : '') +
      ', which hands back a second address with your settings in it. Paste that one here.'
  );
}

async function __ask(path) {
  const res = await fetchv2(__BASE_URL + __configSegment() + path, { Accept: 'application/json' });
  if (res.status === 404) return null;
  if ((res.status === 401 || res.status === 403) && __unconfigured()) {
    throw __unconfiguredError();
  }
  if (!res.ok) throw new Error('The addon answered ' + res.status + '.');
  return await res.json();
}

/** The protocol escapes each path segment, and ids contain \`:\`. */
function __segment(value) {
  return encodeURIComponent(String(value));
}

/**
 * The type half of a source media id.
 *
 * Ids here are stored as \`<type>:<imdbId>\` because the protocol needs both and
 * the host's binding carries one string. Splitting on the first colon keeps
 * the imdb id intact whatever it contains.
 */
/**
 * Whether the addon said it answers this resource.
 *
 * An empty list means the manifest was read before this was recorded, and the
 * old behaviour — ask and see — is what those bundles get until they are
 * converted again. \`resources\` is the addon's own statement of what it
 * answers, so believing it costs nothing and doubting it costs a round trip.
 */
function __serves(name) {
  return __RESOURCES.length === 0 || __RESOURCES.indexOf(name) >= 0;
}

/**
 * The id to ask for streams with.
 *
 * Three cases, and only the first is the addon's own word. A source that
 * enumerated its episodes gave us ids and we use them verbatim. A source that
 * enumerated nothing is a stream-only addon, and the protocol's own convention
 * is the id: \`<imdb>:<season>:<episode>\`, which is what every Stremio client
 * sends and what these addons are built to answer.
 *
 * Without a season there is no id to build — a film has none and needs none,
 * and a series whose catalogue could not say would be a guess that plays the
 * wrong episode. The bare id is the honest ask in both cases.
 */
function __target(ref, episode) {
  if (episode && episode.sourceEpisodeId) return episode.sourceEpisodeId;
  if (ref.type !== 'series') return ref.id;
  const season = episode && Number(episode.season);
  const number = episode && Number(episode.number);
  if (!Number.isFinite(season) || !Number.isFinite(number) || number <= 0) return ref.id;
  return ref.id + ':' + season + ':' + number;
}

function __split(sourceMediaId) {
  const raw = String(sourceMediaId);
  const at = raw.indexOf(':');
  if (at < 0) return { type: __TYPES[0] || 'movie', id: raw };
  return { type: raw.slice(0, at), id: raw.slice(at + 1) };
}

/** A catalogue row, as a catalogue entry. */
function __entry(row) {
  if (!row || typeof row !== 'object') return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const title = String(row.name || '').trim();
  if (id.length === 0 || title.length === 0) return null;
  const type = typeof row.type === 'string' && row.type.length > 0 ? row.type : __TYPES[0] || 'movie';
  const year = Number(String(row.releaseInfo || row.year || '').slice(0, 4));
  return {
    sourceMediaId: type + ':' + id,
    title: title,
    alternativeTitles: [],
    posterImageUrl: typeof row.poster === 'string' && row.poster.length > 0 ? row.poster : undefined,
    // Corroboration the matcher can actually use. A catalogue that states a
    // year lets a weaker title match earn its place instead of resting on the
    // name alone.
    year: Number.isFinite(year) && year > 1800 ? year : undefined
  };
}

/**
 * A stream object, as a playable source — or null.
 *
 * The null cases are the point, and they are the majority: see this file's
 * header for what each of the other content fields means and why none of them
 * is something this player can open.
 */
function __playable(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.url !== 'string' || row.url.length === 0) return null;
  if (!__isPlayable(row.url)) return null;

  const hints = row.behaviorHints && typeof row.behaviorHints === 'object' ? row.behaviorHints : {};
  const headers =
    hints.proxyHeaders && typeof hints.proxyHeaders === 'object' && hints.proxyHeaders.request
      ? hints.proxyHeaders.request
      : undefined;

  // The protocol has no container field, but it states one twice over:
  // \`behaviorHints.filename\` names the file — the only place a debrid link's
  // container is written, since its url is an opaque token — and
  // \`notWebReady\` is defined as "not https, or not an mp4". Both go to the
  // shared reading (\`__streamContainer\`), with the url between them. The
  // fallback is \`mp4\` because a stream that states nothing is, by that same
  // definition, one the addon calls web-ready.
  const label = String(row.name || row.title || '').trim();
  return {
    url: row.url,
    label: label.length > 0 ? label : 'Addon',
    headers: headers,
    container: __streamContainer(
      {
        filename: typeof hints.filename === 'string' ? hints.filename : undefined,
        url: row.url,
        webReady: hints.notWebReady !== true
      },
      'mp4'
    ),
    subtitles: __sidecars(row.subtitles)
  };
}

/**
 * A stream object that names a torrent, as an acquisition descriptor.
 *
 * \`sources\` carries this protocol's trackers and DHT nodes verbatim. The
 * hash is read by the shared \`__torrentOf\`, which answers 40 lowercase hex
 * whether the addon wrote hex in either case or base32 — one spelling, so one
 * torrent is never two engines — and answers nothing for a value that is not
 * an info hash at all, which a torrent engine could not have joined.
 */
function __torrent(row) {
  if (!row || typeof row !== 'object') return null;
  if (typeof row.infoHash !== 'string' || row.infoHash.length === 0) return null;
  const found = __torrentOf({ infoHash: row.infoHash });
  if (found === null) return null;

  const label = String(row.name || row.title || '').trim();
  const idx = Number(row.fileIdx);
  return {
    torrent: {
      infoHash: found.infoHash,
      ...(Number.isFinite(idx) && idx >= 0 ? { fileIdx: idx } : {}),
      ...(Array.isArray(row.sources)
        ? { sources: row.sources.filter(function (one) { return typeof one === 'string'; }) }
        : {})
    },
    label: label.length > 0 ? label : 'Torrent',
    subtitles: __sidecars(row.subtitles)
  };
}

/**
 * Sidecar subtitle tracks, which this protocol carries per stream.
 *
 * Unlike the scraped formats, these arrive with a real language tag, so the
 * player's track menu gets the language the addon stated rather than the
 * honest \`und\` a source that says nothing has to be given. Every track is
 * kept: the viewer picks, and dropping all but the first would decide for
 * them.
 */
function __sidecars(list) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const out = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const language = String(row.lang || '').trim();
    const track = __subtitleTrack(row.url, language, language, __BASE_URL);
    if (track !== null) out.push(track);
  }
  return out.length > 0 ? out : undefined;
}

/* --- the adapter --------------------------------------------------------- */

export default {
  id: __PLUGIN_ID,

  /**
   * Searched only where the addon says it can be.
   *
   * A stream-only addon declares no catalogues and is not searchable at all;
   * returning nothing is the honest answer for it, and the host binds it by id
   * instead. Where catalogues exist, each is asked and the results merged,
   * because a manifest routinely declares one per type.
   */
  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    // The protocol paginates with a \`skip\` extra in multiples of 100; a first
    // page is the common case and the only one every addon implements.
    if (Number(page) > 1) return { entries: [] };
    if (__SEARCHABLE.length === 0) return { entries: [] };

    const entries = [];
    const seen = {};
    for (const catalogue of __SEARCHABLE) {
      let body = null;
      try {
        body = await __ask(
          '/catalog/' + __segment(catalogue.type) + '/' + __segment(catalogue.id) +
            '/search=' + __segment(query) + '.json'
        );
      } catch (error) {
        // One catalogue refusing must not empty the others. A total failure is
        // still reported: every catalogue throwing leaves \`entries\` empty and
        // the host reads that as "nothing found", which is the one answer this
        // cannot distinguish — and with no catalogue at all it is also true.
        continue;
      }
      const rows = body && Array.isArray(body.metas) ? body.metas : [];
      for (const row of rows) {
        const entry = __entry(row);
        if (entry === null || seen[entry.sourceMediaId] === true) continue;
        seen[entry.sourceMediaId] = true;
        entries.push(entry);
      }
    }
    return { entries: entries };
  },

  /**
   * The episodes of a series, from the addon's own metadata.
   *
   * A movie has none, and says so with an empty list rather than a failure —
   * the playback layer asks for episode 1 of a film and this is what makes
   * that resolve. Episodes are addressed by the protocol's own
   * \`<imdb>:<season>:<episode>\` id, kept verbatim as the source episode id so
   * that \`resolve\` never has to rebuild one.
   *
   * **An addon that declares no \`meta\` resource has no list to give**, and
   * that is not a failure either. A torrent indexer is exactly that: it knows
   * which files exist for an id somebody hands it and nothing whatever about
   * what a series contains. Asking it anyway produced an empty list, which the
   * host read as "this source does not have episode 577" — an accusation about
   * a question the addon never claimed to answer. It returns empty here too,
   * and \`resolve\` builds the id instead.
   */
  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    const ref = __split(sourceMediaId);
    if (ref.type !== 'series') {
      return [{ number: 1, sourceEpisodeId: ref.id }];
    }

    // Nothing to ask: the manifest never advertised this resource, and a
    // request it did not advertise is a round trip spent to be told no.
    if (!__serves('meta', ref.type)) return [];

    const body = await __ask('/meta/' + __segment(ref.type) + '/' + __segment(ref.id) + '.json');
    const videos = body && body.meta && Array.isArray(body.meta.videos) ? body.meta.videos : [];

    const episodes = [];
    for (const video of videos) {
      if (!video || typeof video !== 'object') continue;
      const id = typeof video.id === 'string' && video.id.length > 0 ? video.id : null;
      const number = Number(video.episode);
      if (id === null || !Number.isFinite(number) || number <= 0) continue;
      // Season 0 is where these catalogues put specials, recaps and trailers.
      // Numbered alongside the real run they would collide with it — two
      // "episode 1" rows, one of them a trailer — so they are left out.
      if (Number(video.season) === 0) continue;
      episodes.push({
        number: number,
        sourceEpisodeId: id,
        title: typeof video.title === 'string' && video.title.length > 0 ? video.title : undefined,
        season: Number.isFinite(Number(video.season)) ? Number(video.season) : undefined
      });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);
    const ref = __split(sourceMediaId);
    const target = __target(ref, episode);

    const body = await __ask('/stream/' + __segment(ref.type) + '/' + __segment(target) + '.json');
    const rows = body && Array.isArray(body.streams) ? body.streams : [];

    const sources = [];
    const dropped = { external: 0, youtube: 0, other: 0 };
    for (const row of rows) {
      const source = __playable(row);
      if (source !== null) {
        sources.push(source);
        continue;
      }
      // A torrent is **returned, not dropped**. It is a real answer this
      // client may or may not be able to act on, and which of those is true is
      // the host's question rather than this bundle's — the same division that
      // keeps a plugin from knowing what device it runs on.
      const torrent = __torrent(row);
      if (torrent !== null) {
        sources.push(torrent);
        continue;
      }
      if (row && typeof row === 'object') {
        if (typeof row.externalUrl === 'string') dropped.external += 1;
        else if (typeof row.ytId === 'string') dropped.youtube += 1;
        else dropped.other += 1;
      }
    }

    // **Answering with things we cannot play is not the same as answering with
    // nothing**, and returning an empty list for both told the viewer the
    // second when the first was true. A measured addon returns 67 torrents for
    // a film and no url at all: reported as "returned no stream", that reads as
    // a broken source, when what actually happened is that it works exactly as
    // designed and this client has no torrent client (FOREIGN.md §4.2). The
    // sentence names the count and the remedy, and reaches the viewer verbatim
    // through the check's own \`detail\`.
    if (sources.length === 0 && rows.length > 0) {
      const parts = [];
      if (dropped.external > 0) parts.push(dropped.external + ' link to another site');
      if (dropped.youtube > 0) parts.push(dropped.youtube + ' YouTube');
      const said = parts.length > 0 ? parts.join(', ') : rows.length + ' unrecognised';
      throw new Error(
        'This addon answered with ' + said + ' stream(s) and nothing this player can open.'
      );
    }
    return sources;
  }
};
`;
}
