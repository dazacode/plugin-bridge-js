/**
 * A translated Kotlin extension, wrapped as a Yorozo plugin bundle.
 *
 * The third and last of the entry shims, and the only one that has to supply a
 * *base class* rather than just globals. `sora-entry.ts` and
 * `mangayomi-entry.ts` wrap sources that are complete programs; an extension in
 * this ecosystem is a **subclass**, and most of what makes it work lives in the
 * class it extends — which is not in the file, and which we therefore have to
 * provide.
 *
 * ## What this file is, precisely
 *
 * It is a reimplementation of the driver half of that base class: the part that
 * turns "here is a selector and a way to read one element" into "here is a page
 * of results". That is a *shape* — a request, a list of elements, a next-page
 * check — and `FOREIGN.md` §4.1.3 is explicit that a shape is ordinary
 * machinery a host may ship, because it can be written without naming a single
 * site. Everything site-specific arrives from the translated subclass at
 * runtime, read off the extension on the viewer's own device.
 *
 * The distinction that matters, and the one this file sits exactly on top of: a
 * *template* is shippable, a *per-host stream extractor* is not. There are no
 * hostnames here and there never may be.
 *
 * ## Why the driver has to be here rather than translated
 *
 * The base class is Kotlin too, and in principle the transpiler could translate
 * it. It is not translated, for two reasons. It lives in a different repository
 * from the extension — the app's own, not the catalogue's — so fetching it is a
 * second discovery problem nobody has solved. And it is the same code for every
 * extension, so translating it 254 times to get 254 identical results is work
 * done per conversion that could be done once.
 *
 * ## Overrides win, always
 *
 * Every method below is called *through* the translated instance when it
 * defines one, and falls back to the default only when it does not. That
 * ordering is the whole correctness argument: an extension overrides its
 * template's behaviour far more often than it merely configures it
 * (`FOREIGN.md` §4.1.4 measured exactly that), so a driver that preferred its
 * own implementation would silently ignore the code we went to the trouble of
 * translating.
 *
 * ## Read the program, not the build output
 *
 * The base class is published, readable Kotlin under Apache-2.0, and this file
 * is written against it rather than against a guess at it. That is what the
 * repo-root `NOTICE` records, and it is the reason the defaults below are the
 * defaults they are — `sortVideos()` delegating to the deprecated `sort()`,
 * `videoListRequest(hoster)` addressing the *hoster's* url rather than the
 * episode's, `resolveVideo` answering null to mean "this one is gone" — none of
 * which is guessable and all of which extensions rely on.
 *
 * ## Two video paths, because upstream has two
 *
 * The published API moved: an episode yields **hosters**, and a hoster yields
 * videos. `videoListParse(response)` is the path kept for the extensions that
 * predate the change. Both are implemented here, and the hoster one is tried
 * first, because an extension written against the current API declares nothing
 * the legacy path can call and would otherwise fail at `resolve` with a message
 * about a member it was right not to declare.
 *
 * Kotlin tells the two apart by overload resolution and JavaScript has no
 * overloads, so once a class is translated `videoListParse` is *one* name for
 * two methods. Where that matters the driver decides from what the extension
 * declares — a class that declares any hoster member is hoster-shaped — and,
 * where that is not enough, from arity: the legacy parse takes a response, the
 * hoster parse takes a response and the hoster.
 *
 * ## What is deliberately not supported
 *
 * Filters, preferences and pagination *state*. The ABI has no filter surface
 * (`ABI.md` §1, "no UI"), a converted bundle declares no settings, and page
 * tokens are not part of `searchCatalog`. Each of those is a stated limit
 * rather than a silent one: an extension that only works with a filter applied
 * will fail the install check at `search`, which is the honest outcome.
 *
 * And one that is refused rather than merely absent. `createHttpServer()` is
 * an extension asking to run a **local web server on the device** and have the
 * player point at it — `ADR-0002` §2.1's observation, promoted into the
 * upstream API. This build structurally cannot supply one: a plugin gets no
 * ambient capability (rule 13) and the host executes a declarative byte
 * pipeline instead. So an extension that overrides it fails at `resolve` with
 * `UnsupportedError` naming the member (`ABI.md` §5), rather than being quietly
 * ignored and handing back stream urls that address a server nobody started.
 */

import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { JS_RUNTIME } from './js-runtime';
import { kotlinRuntime } from './kotlin-runtime';
import { STREAM_GUARDS } from './stream-guards';
import { synchronyPrelude } from './synchrony';
import { measurementPrelude } from './measurement';

export interface AniyomiEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/**
	 * The translated extension, as JavaScript.
	 *
	 * Must declare a class named by `className` whose constructor takes no
	 * arguments. This is `emit.ts`'s output, embedded verbatim so that a
	 * conversion can be audited by reading it.
	 */
	readonly translatedSource: string;
	/** The class the translated source declares. */
	readonly className: string;
	/**
	 * The extension's own base URL, read from its constants.
	 *
	 * Passed in as well as being on the instance, because ids have to be
	 * absolutised before the class exists and after it is gone.
	 */
	readonly baseUrl: string;
	/**
	 * Foreign preference key to manifest setting id, for what the manifest
	 * declares.
	 *
	 * Empty for an extension that declares no preferences this build could read
	 * statically, and the bundle then behaves as it did before settings existed:
	 * every read answers whatever default its own call site carried.
	 */
	readonly settingIds?: Readonly<Record<string, string>>;
	/**
	 * `lib/synchrony`'s prebuilt script, when the conversion calls the
	 * deobfuscator (`adapters/src/library-shims.ts`). Absent otherwise, and
	 * the bundle is then byte-identical to one built before it existed.
	 */
	readonly synchronyScript?: string;
}

/**
 * The driver, as bundle source.
 *
 * Exported so its spec can evaluate it against a hand-written stand-in class
 * rather than through a whole conversion.
 */
export const ANIYOMI_DRIVER = `
/* --- the base class's driver half ------------------------------------------ */

/**
 * \`headers\`, which the base class owns and the extension reads bare.
 *
 * \`AnimeHttpSource\` declares it \`by lazy { headersBuilder().build() }\`, and
 * an extension reaches for it constantly — \`GET(url, headers)\`, and
 * \`Video(url, quality, url, headers)\`, which is how a stream carries the
 * \`Referer\` its CDN insists on. Nothing defined it here, so every one of
 * those read \`undefined\`: requests went out bare, and a resolved stream
 * reached the player with no headers at all. A CDN behind a hotlink guard
 * answers that with 403 — which reads as a dead source, and is not one. The
 * same URL with the \`Referer\` the extension had already built answers 206.
 *
 * Memoised, because Kotlin's \`by lazy\` is, and because \`headersBuilder()\`
 * is the extension's own code and may not be cheap. Defined only when the
 * translated class did not declare \`headers\` itself: an extension that did
 * means its own.
 */
if (!('headers' in __source)) {
  var __headerCache = null;
  Object.defineProperty(__source, 'headers', {
    get: function () {
      if (__headerCache === null) __headerCache = __headers();
      return __headerCache;
    }
  });
}

/**
 * \`headersBuilder()\`, which the base class owns and an extension *calls*.
 *
 * \`AnimeHttpSource\` declares it as an open method returning a
 * \`Headers.Builder\`, so an extension that wants one extra header writes
 * \`headersBuilder().add("X-Requested-With", "XMLHttpRequest").build()\` and
 * never declares anything. That is emitted as \`this.headersBuilder()\` — the
 * member table says the base class supplies it — and nothing here did, so the
 * first search died with \`this.headersBuilder is not a function\`.
 *
 * Only when the extension has none of its own: one that overrides it means its
 * own, and \`__headers()\` goes on reading whichever is there.
 */
if (typeof __source.headersBuilder !== 'function') {
  __source.headersBuilder = function () { return Headers.Builder(); };
}

/**
 * The rest of what the base class owns and an extension reads bare.
 *
 * \`AnimeHttpSource\` declares \`client\`, \`network\`, \`json\` and
 * \`preferences\`, so an extension writes \`client.newCall(request)\` and
 * declares nothing. That emits as \`this.client\` — the member table says the
 * base class supplies it, and \`emit.ts\` says in as many words that this file
 * attaches them. It attached \`headers\` and nothing else, so
 * \`client.newCall(…)\` was
 * \`Cannot read properties of undefined (reading 'newCall')\` on the first
 * search of any extension that did not override the client itself.
 *
 * Each is defined only when the translated class has none of its own: an
 * extension that overrides \`client\` with its own interceptor chain means
 * that one, and it is already on the object by the time this runs.
 */
for (const __own of [
  ['client', client],
  ['network', network],
  ['json', Json],
  ['preferences', getPreferences()]
]) {
  if (!(__own[0] in __source)) __source[__own[0]] = __own[1];
}

/** Calls the extension's own member when it has one. */
function __declares(name) {
  return typeof __source[name] === 'function';
}

/**
 * Whether the extension overrides one of the base class's suspend entry points
 * — 'getVideoList(episode)', 'getEpisodeList(anime)' — rather than merely
 * declaring something under the same name.
 *
 * Kotlin keeps overloads apart by their parameters and JavaScript keeps one
 * slot per name, so a template's own helper can sit where the entry point
 * would: AnimeStream declares 'protected open suspend fun getVideoList(url:
 * String, name: String)', the per-mirror hook its subclasses fill in, and
 * nothing else under that name. The driver took it for the override, called it
 * with the episode and no name, and the template's default answered an empty
 * list without fetching anything — eight of nine loaded listings of that
 * template resolved to no videos, reporting nothing.
 *
 * An override has exactly the entry point's parameters (Kotlin allows it no
 * defaults), so its emitted 'length' is that count. A dispatcher over several
 * declarations is '(...args)', length 0, and routes a one-argument call to the
 * declaration that takes one — see '__k.overload' — so it counts too.
 */
function __overrides(name, arity) {
  if (!__declares(name)) return false;
  const declared = __source[name].length;
  return declared === arity || declared === 0;
}

async function __call(name, ...args) {
  return await __source[name](...args);
}

/** Why the last call to each selector member came back with nothing. */
var __selectorFailure = {};

/**
 * A selector the extension declares, or '' when it declares none.
 *
 * Why the failure is recorded rather than swallowed: a themed extension writes
 * \`popularAnimeSelector() = latestUpdatesSelector()\`, and the member it
 * delegates to lives in the template class, which is a different file. If that
 * file was not part of the conversion the call throws, and reporting "declares
 * no selector" for it is a diagnosis that sends the reader to the wrong file —
 * the extension does declare one. Measured on the catalogue: four of the eight
 * extensions that load and cannot answer are exactly this, and all four read as
 * "declares nothing" when the truth is "its template was not converted".
 */
function __selector(name) {
  delete __selectorFailure[name];
  if (!__declares(name)) return '';
  try {
    const value = __source[name]();
    return typeof value === 'string' ? value : '';
  } catch (error) {
    __selectorFailure[name] = error && error.message ? String(error.message) : String(error);
    return '';
  }
}

/** Why a selector came back empty, phrased for whoever reads the plugin error. */
function __selectorReason(name) {
  const failure = __selectorFailure[name];
  if (failure === undefined) return 'declares no ' + name;
  return 'declares ' + name + ', but calling it failed (' + failure + ')';
}

/**
 * The base class's own implementations, reachable as \`super\`.
 *
 * The single largest blocker to translating this ecosystem, measured across the
 * whole catalogue, is an explicit \`super.\` call — **100 of 254 extensions**
 * make one. An extension writes \`super.popularAnimeParse(response)\` to mean
 * "do the standard thing here, then let me adjust it", and until this object
 * existed there was nothing for that to compile to.
 *
 * It is worth being precise about why this does not violate the rule that a
 * *refused* override never silently falls back to the base implementation.
 * That rule exists because we cannot know whether a member we failed to read
 * was adding to the base behaviour or replacing it, so guessing would ship a
 * plugin that looks right and is not. An explicit \`super.\` call is the
 * opposite situation: the extension is *telling us in its own source* that the
 * base behaviour belongs at this point. Honouring a written instruction and
 * inventing one to paper over a failure are different acts.
 */
const __super = {
  popularAnimeParse: function (response) { return __parsePage('popularAnime', response); },
  searchAnimeParse: function (response) { return __parsePage('searchAnime', response); },
  latestUpdatesParse: function (response) { return __parsePage('latestUpdates', response); },

  episodeListParse: function (response) { return __defaultEpisodeList(response); },

  animeDetailsParse: function (document) {
    // The base class has no default here — it is abstract — so a \`super\` call
    // to it is an extension calling something that does not exist. Saying so
    // beats returning an empty record that reads as "this show has no details".
    throw new Error(
      'This extension calls super.animeDetailsParse, which its base class does not implement.'
    );
  },

  // The suspend entry points, which fetch *and* parse. An extension calls one
  // of these to mean "do the whole standard thing", usually so it can adjust
  // the page afterwards. Each goes back through the overridable parse member
  // rather than straight to the default, because that is what the base class
  // does — an extension that overrode the parser and then called
  // 'super.getSearchAnime' expects its own parser to run.
  getPopularAnime: async function (page) {
    return await __fetchPage('popularAnime', await __listingRequest('popularAnime', page));
  },
  getLatestUpdates: async function (page) {
    return await __fetchPage('latestUpdates', await __listingRequest('latestUpdates', page));
  },
  getSearchAnime: async function (page, query, filters) {
    if (!__declares('searchAnimeRequest')) {
      throw new Error('This extension calls super.getSearchAnime but declares no search request.');
    }
    const request = await __call('searchAnimeRequest', page, query, filters);
    return await __fetchPage('searchAnime', request);
  },

  getAnimeDetails: async function (anime) {
    const response = await client.newCall(__detailsRequest(anime)).execute();
    if (!__declares('animeDetailsParse')) {
      throw new Error('This extension calls super.getAnimeDetails but declares no details parser.');
    }
    // The parsed template hands its subclass a Document and the plain base
    // class hands it a Response. Kotlin picks between the two by type and
    // JavaScript cannot, so the document is offered first — it is the shape the
    // overwhelming majority of these extensions declare — and the response only
    // when that call could not read what it was given.
    const parsed = await __eitherShape('animeDetailsParse', response);
    if (parsed && typeof parsed === 'object') parsed.initialized = true;
    return parsed;
  },
  getEpisodeList: async function (anime) {
    const response = await client.newCall(__episodeRequest(anime)).execute();
    return __declares('episodeListParse')
      ? await __call('episodeListParse', response)
      : await __defaultEpisodeList(response);
  },

  headersBuilder: function () { return Headers.Builder(); },
  /*
   * Resolved rather than concatenated.
   *
   * The base class writes \`baseUrl + anime.url\`, and that only works when the
   * base is an origin and the stored url is a path. Neither holds generally:
   * a source whose \`baseUrl\` carries a path (\`https://host/anime\`) stores
   * root-relative urls through \`setUrlWithoutDomain\`, and an id that has been
   * round-tripped through this host comes back absolute. Both concatenated
   * produce a doubled origin — \`https://host/animehttps://host/serial/…\` —
   * which can only 404, and did.
   *
   * \`__absolute\` answers an absolute url unchanged, resolves \`/path\` against
   * the origin and \`path\` against the base, which is what each of those three
   * spellings means.
   */
  animeDetailsRequest: function (anime) { return GET(__absolute(anime.url, __BASE_URL), __headers()); },
  episodeListRequest: function (anime) { return __super.animeDetailsRequest(anime); },

  // Selector defaults: the base declares these abstract, so an extension
  // calling through to one is asking for something that was never there.
  popularAnimeNextPageSelector: function () { return ''; },
  searchAnimeNextPageSelector: function () { return ''; },
  latestUpdatesNextPageSelector: function () { return ''; },

  /* -- the hoster API, which is the direction the base class moved ---------- */

  // Not '__hosterList': that one prefers the extension's own 'getHosterList',
  // and an extension whose 'getHosterList' calls through to here would recurse
  // until the stack ran out. Upstream's base implementation goes to the two
  // overridable halves, and so does this.
  getHosterList: async function (episode) { return await __hosterListDefault(episode); },
  hosterListRequest: function (episode) { return GET(__absolute(episode.url, __BASE_URL), __headers()); },
  hosterListParse: async function (response) { return await __defaultHosterList(response); },

  // One name, two methods, because Kotlin's overloads collapse in translation.
  // A hoster addresses its own url; an episode addresses the site.
  videoListRequest: function (source) {
    return __isHoster(source)
      ? GET(source.hosterUrl, __headers())
      : GET(__absolute(source.url, __BASE_URL), __headers());
  },
  getVideoList: async function (source) { return await __videoListDefault(source); },
  videoListParse: async function (response) { return await __defaultVideoList(response); },

  /* -- ordering, which is where a quality preference is applied ------------- */

  sortHosters: function (hosters) { return hosters; },
  // Upstream's default is not the identity: it delegates to the deprecated
  // 'sort()', which is *also* overridable. An extension that overrode only
  // 'sort' and then called 'super.sortVideos()' is relying on exactly that.
  sortVideos: function (videos) {
    return __declares('sort') ? __source.sort(videos) : __super.sort(videos);
  },
  sort: function (videos) { return videos; },

  /* -- resolving one stream ------------------------------------------------ */

  // Identity, and null means the video is gone rather than unchanged.
  resolveVideo: async function (video) { return video; },
  getVideoUrl: async function (video) { return await __videoUrlDefault(video); },
  videoUrlRequest: function (video) { return GET(video.url, __headers()); },
  videoUrlParse: function () {
    throw new Error(
      'This extension calls super.videoUrlParse, which its base class does not implement.'
    );
  },

  /* -- seasons, which this ABI has no surface for -------------------------- */

  // Implemented anyway. A 'super.seasonListParse' sits inside a member we *do*
  // call often enough that refusing the whole extension over a branch which
  // never runs would lose a source for nothing.
  seasonListRequest: function (anime) { return GET(__absolute(anime.url, __BASE_URL), __headers()); },
  seasonListParse: async function (response) { return await __defaultSeasonList(response); },

  /* -- the remainder of the published surface ------------------------------ */

  episodeVideoParse: function () {
    throw new Error(
      'This extension calls super.episodeVideoParse, which its base class does not implement.'
    );
  },
  getHomeUrl: function () { return __BASE_URL; },
  // A request's url is an HttpUrl; the member answers the String upstream's does.
  getAnimeUrl: function (anime) { return String(__detailsRequest(anime).url); },
  getEpisodeUrl: function (episode) { return episode.url; },
  // Deprecated upstream and a no-op there too: everything it used to do is
  // expected to happen while the episode is being constructed.
  prepareNewEpisode: function () {},
  // Upstream's default, which is "this source does not want a local server".
  // An extension that *overrides* it is refused by name at 'resolve' — see this
  // file's header — but calling through to the default is not that.
  createHttpServer: function () { return null; },
  getVideoThumbnails: async function () { return null; },
  getImageTile: function () {
    throw __unsupported(
      'This extension calls super.getImageTile, which decodes a bitmap on the ' +
      'device. Yorozo has no bitmap surface for a plugin to draw into, so there ' +
      'is nothing here for that to return.'
    );
  },
  generateId: function () {
    // The published implementation is the first eight bytes of an MD5 read as a
    // signed 64-bit integer. JavaScript's number cannot hold that value, and a
    // rounded id is a wrong answer that looks like a right one — the failure it
    // produces is two sources colliding, much later, with nothing pointing here.
    throw __unsupported(
      'This extension calls generateId, whose result is a 64-bit source id. ' +
      'Yorozo identifies a plugin by its own manifest id and cannot represent ' +
      'that value exactly, so it refuses it rather than round it.'
    );
  }
};

/**
 * One listing page, from a response.
 *
 * Split out from the request half so that \`super.<kind>Parse(response)\` and
 * the default path are the same code: an extension that wraps the base parser
 * and one that never mentions it must not get two different readings of the
 * same markup.
 */
function __parsePage(kind, response) {
  const document = response.asJsoup();
  const selector = __selector(kind + 'Selector');
  if (selector.length === 0) {
    throw new Error(
      'This extension ' + __selectorReason(kind + 'Selector') + ' and no ' + kind + 'Parse, so ' +
      'there is nothing to read a results page with.'
    );
  }

  const animes = [];
  for (const element of document.select(selector)) {
    animes.push(__source[kind + 'FromElement'](element));
  }

  const next = __selector(kind + 'NextPageSelector');
  const hasNextPage = next.length > 0 && document.selectFirst(next) !== null;

  // The plain record rather than the runtime's constructor. A Kotlin
  // 'AnimesPage' is a two-field data class and this is that shape, so
  // translated code reading '.animes' off a 'super' call gets what it expects
  // — and the driver does not acquire a load-order dependency on a runtime
  // section it does not otherwise need.
  return { animes: animes, hasNextPage: hasNextPage };
}

/**
 * One listing page, from a request.
 *
 * The two halves are separately overridable and usually only one of them is:
 * an extension that rewrites '<kind>Parse' has taken over the whole page, and
 * one that only declares selectors has not.
 */
async function __page(kind, request) {
  return __normalisePage(await __fetchPage(kind, request));
}

/**
 * Fetch and parse, in the ecosystem's own shape rather than the ABI's.
 *
 * Split from '__page' because 'super.getSearchAnime(…)' hands the extension
 * back an 'AnimesPage' it can inspect and adjust, where the adapter wants
 * catalogue entries. One code path, two shapes at the ends of it.
 */
async function __fetchPage(kind, request) {
  const response = await client.newCall(request).execute();
  const parse = kind + 'Parse';
  return __declares(parse) ? await __call(parse, response) : __parsePage(kind, response);
}

/**
 * The listing request an extension declares, or a refusal naming what is absent.
 *
 * Not '__request': the shared JavaScript runtime already declares one with a
 * different shape, and a second declaration at module scope is a SyntaxError
 * that takes the whole bundle down at load rather than failing where it was
 * written. (Backticks are deliberately absent from this comment: it lives
 * inside a template literal, and one would end the string.)
 */
async function __listingRequest(kind, page) {
  if (!__declares(kind + 'Request')) {
    throw new Error('This extension declares no ' + kind + 'Request.');
  }
  return await __call(kind + 'Request', page);
}

/**
 * One shelf page — popular or latest — through the member the host calls.
 *
 * The host calls 'getPopularAnime(page)', and the request/parse pair is only
 * what the base class's default of it does. An extension overrides the suspend
 * member when a page takes more than one request, or is an API call with no
 * parse step at all, and then very often writes the pair as
 * 'throw UnsupportedOperationException()'. Going straight to the pair ignored
 * the code that was translated — this file's own rule, "overrides win" — and
 * either threw or, worse, fetched the default page the author had replaced.
 * The manga driver has asked for the override first all along.
 */
async function __shelf(kind, page) {
  const override = 'get' + kind.charAt(0).toUpperCase() + kind.slice(1);
  if (__overrides(override, 1)) return __normalisePage(await __call(override, page));
  if (!__declares(kind + 'Request')) return { entries: [] };
  return await __page(kind, await __call(kind + 'Request', page));
}

/** A page the extension parsed itself, in whatever shape it returned it. */
function __normalisePage(value) {
  const rows = Array.isArray(value) ? value : (value && value.animes) || [];
  const entries = [];
  for (const anime of rows) {
    const entry = __entryOf(anime);
    if (entry !== null) entries.push(entry);
  }
  const hasMore = value && typeof value === 'object' && !Array.isArray(value)
    ? value.hasNextPage === true
    : false;
  return { entries: entries, hasMore: hasMore };
}

function __entryOf(anime) {
  if (!anime || typeof anime !== 'object') return null;
  const url = __absolute(String(anime.url || ''), __BASE_URL);
  const title = String(anime.title || '').trim();
  if (url.length === 0 || title.length === 0) return null;
  return {
    sourceMediaId: url,
    title: title,
    alternativeTitles: [],
    posterImageUrl: __absolute(String(anime.thumbnail_url || ''), __BASE_URL) || undefined
  };
}

/**
 * The form an extension expects one of its own ids back in.
 *
 * These sources call 'setUrlWithoutDomain' and then concatenate their own base
 * url when handed one back, so a stored absolute id has to be reduced again on
 * the way in — otherwise every request is built with a doubled origin and can
 * only 404.
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

/** The default request shapes, used when the extension declares none. */
function __detailsRequest(anime) {
  return __declares('animeDetailsRequest')
    ? __source.animeDetailsRequest(anime)
    : GET(__absolute(anime.url, __BASE_URL), __headers());
}

function __episodeRequest(anime) {
  return __declares('episodeListRequest')
    ? __source.episodeListRequest(anime)
    : __detailsRequest(anime);
}

function __headers() {
  try {
    return __declares('headersBuilder') ? __source.headersBuilder().build() : {};
  } catch (error) {
    return {};
  }
}

/**
 * A member the extension declares in one of two shapes, offered both.
 *
 * The document form first, because the parsed template is what nearly every
 * extension in this ecosystem extends. The original failure is what gets
 * thrown when neither shape reads: the second attempt is a disambiguation, not
 * a diagnosis, and reporting its error would name the wrong argument.
 */
async function __eitherShape(name, response) {
  try {
    return await __call(name, response.asJsoup());
  } catch (first) {
    try {
      return await __call(name, response);
    } catch (second) {
      throw first;
    }
  }
}

/* --- streams: hosters, then videos ----------------------------------------- */

/**
 * 'ABI.md' section 5's UnsupportedError, which the host maps to a failure that
 * says this surface cannot do what the source needs.
 *
 * A named error rather than a plain one because the name is the only thing that
 * crosses the worker boundary alongside the message, and it is what decides
 * whether a viewer is told to retry.
 */
function __unsupported(message) {
  const error = new Error(message);
  error.name = 'UnsupportedError';
  return error;
}

function __isHoster(value) {
  return value instanceof Hoster;
}

function __arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Whether the extension is written against the hoster API at all.
 *
 * Any one of these members is enough. They only exist on that path, so
 * declaring one is the extension saying which API it targets — which is the
 * signal that survives translation, unlike the argument types Kotlin used.
 */
function __hasHosters() {
  return __overrides('getHosterList', 1) || __declares('hosterListRequest') ||
    __declares('hosterListParse') || __declares('hosterListSelector') ||
    __declares('hosterFromElement');
}

/** Whether anything here knows how to get videos from an episode directly. */
function __hasEpisodeVideos() {
  return __overrides('getVideoList', 1) || __declares('videoListParse') ||
    __declares('videoListSelector') || __declares('videoFromElement');
}

/**
 * Whether the extension's video parser is the *legacy* one.
 *
 * Arity is the only thing left once the overloads have collapsed into one
 * JavaScript name: upstream's legacy parse takes a response, and the hoster one
 * takes a response and the hoster it came from. A selector-driven extension
 * has no parse member at all and is legacy by construction.
 */
function __hasLegacyVideoParse() {
  if (__declares('videoListParse') && __source.videoListParse.length <= 1) return true;
  return __declares('videoListSelector') || __declares('videoFromElement');
}

/** The base class's own hoster list: request, then parse, both overridable. */
async function __hosterListDefault(episode) {
  const request = __declares('hosterListRequest')
    ? await __call('hosterListRequest', episode)
    : __super.hosterListRequest(episode);
  const response = await client.newCall(request).execute();
  return __declares('hosterListParse')
    ? await __call('hosterListParse', response)
    : await __defaultHosterList(response);
}

/** The hoster list, with the extension's own override preferred. */
async function __hosterList(episode) {
  return __arrayOf(
    __overrides('getHosterList', 1)
      ? await __call('getHosterList', episode)
      : await __hosterListDefault(episode)
  );
}

/** The parsed template's hoster list, for an extension that only declares selectors. */
async function __defaultHosterList(response) {
  const document = response.asJsoup();
  const selector = __selector('hosterListSelector');
  if (selector.length === 0) {
    throw new Error(
      'This extension declares no hosterListParse, and ' + __selectorReason('hosterListSelector') +
      ', so there is nothing to read a hoster list with.'
    );
  }
  if (!__declares('hosterFromElement')) {
    throw new Error(
      'This extension declares hosterListSelector but no hosterFromElement, so nothing ' +
      'knows how to read one hoster out of the page.'
    );
  }
  const out = [];
  for (const element of document.select(selector)) {
    out.push(await __call('hosterFromElement', element));
  }
  return out;
}

/**
 * The base class's own video list, for a hoster or for an episode.
 *
 * Both overridable halves are consulted, which is what makes
 * 'super.getVideoList(...)' behave the way the extension that wrote it expects:
 * its own request builder and its own parser still run.
 */
async function __videoListDefault(source) {
  const hoster = __isHoster(source);
  const request = __declares('videoListRequest')
    ? await __call('videoListRequest', source)
    : __super.videoListRequest(source);
  const response = await client.newCall(request).execute();
  if (!__declares('videoListParse')) return await __defaultVideoList(response);
  // The hoster is passed as a second argument on the hoster path and nowhere
  // else. A legacy parser declared with one parameter simply ignores it.
  return hoster
    ? await __call('videoListParse', response, source)
    : await __call('videoListParse', response);
}

/** The videos one hoster offers, fetched only when it did not carry them. */
async function __hosterVideos(hoster) {
  if (Array.isArray(hoster.videoList)) return hoster.videoList;
  return __arrayOf(
    __overrides('getVideoList', 1)
      ? await __call('getVideoList', hoster)
      : await __videoListDefault(hoster)
  );
}

/**
 * The videos an episode offers directly — the legacy path.
 *
 * 'getVideoList' is only preferred here when the extension is *not*
 * hoster-shaped: on a hoster-shaped class that same name is the hoster
 * overload, and handing it an episode would call the right member with the
 * wrong argument, which fails somewhere inside the extension rather than here.
 */
async function __episodeVideos(episode) {
  return __arrayOf(
    __overrides('getVideoList', 1) && !__hasHosters()
      ? await __call('getVideoList', episode)
      : await __videoListDefault(episode)
  );
}

/** The parsed template's video list, for an extension that only declares selectors. */
async function __defaultVideoList(response) {
  const document = response.asJsoup();
  const selector = __selector('videoListSelector');
  if (selector.length === 0) {
    throw new Error(
      'This extension declares no videoListParse, and ' + __selectorReason('videoListSelector') +
      ', so there is nothing to read a video list with.'
    );
  }
  if (!__declares('videoFromElement')) {
    throw new Error(
      'This extension declares videoListSelector but no videoFromElement, so nothing ' +
      'knows how to read one stream out of the page.'
    );
  }
  const out = [];
  for (const element of document.select(selector)) {
    out.push(await __call('videoFromElement', element));
  }
  return out;
}

/** The parsed template's season list. Never reached by this ABI; reachable by super. */
async function __defaultSeasonList(response) {
  const document = response.asJsoup();
  const selector = __selector('seasonListSelector');
  if (selector.length === 0) {
    throw new Error(
      'This extension declares no seasonListParse, and ' + __selectorReason('seasonListSelector') +
      ', so there is nothing to read a season list with.'
    );
  }
  if (!__declares('seasonFromElement')) {
    throw new Error(
      'This extension declares seasonListSelector but no seasonFromElement, so nothing ' +
      'knows how to read one season out of the page.'
    );
  }
  const out = [];
  for (const element of document.select(selector)) {
    out.push(await __call('seasonFromElement', element));
  }
  return out;
}

/** The extension's hoster ordering, or the base class's, which keeps source order. */
function __sortHosters(hosters) {
  if (!__declares('sortHosters')) return hosters;
  const sorted = __source.sortHosters(hosters);
  return Array.isArray(sorted) ? sorted : hosters;
}

/**
 * The extension's video ordering.
 *
 * This is where a quality preference is applied, and extensions override it
 * constantly — a driver without it hands back streams in whatever order the
 * page listed them, so the viewer gets 360p on a connection that would have
 * carried 1080p and nothing anywhere says why.
 *
 * Both spellings are honoured, in upstream's own order: 'sortVideos' first,
 * and the deprecated 'sort' when only that was overridden, because upstream's
 * own 'sortVideos' default is a call to it.
 */
function __sortVideos(videos) {
  const ordered = __declares('sortVideos')
    ? __source.sortVideos(videos)
    : (__declares('sort') ? __source.sort(videos) : videos);
  return Array.isArray(ordered) ? ordered : videos;
}

/** The stream url a video already carries, absolutised. */
function __videoUrlOf(video) {
  return __absolute(String(video.videoUrl || video.url || ''), __BASE_URL);
}

/** The base class's two-step url resolution, for a video that arrived without one. */
async function __videoUrlDefault(video) {
  const request = __declares('videoUrlRequest')
    ? await __call('videoUrlRequest', video)
    : __super.videoUrlRequest(video);
  const response = await client.newCall(request).execute();
  if (!__declares('videoUrlParse')) {
    throw new Error('This extension declares no videoUrlParse, so a stream url cannot be read.');
  }
  return String(await __eitherShape('videoUrlParse', response) || '');
}

/**
 * One video, made playable, or null when nothing here can make it so.
 *
 * Upstream defers this until somebody presses play; this ABI answers an episode
 * with every stream at once, so it happens here. It is therefore deliberately
 * *lazy in the other direction*: a video that already carries a playable url is
 * returned untouched, so a source that hands back finished urls still makes
 * exactly the requests it made before.
 *
 * A null from 'resolveVideo' is upstream's way of saying the stream is gone,
 * and it is dropped rather than passed on as a url that cannot play.
 */
async function __playable(video) {
  let current = video;
  let url = __videoUrlOf(current);
  if (__isPlayable(url)) return { video: current, url: url };

  if (__declares('resolveVideo')) {
    const resolved = await __call('resolveVideo', current);
    if (resolved === null || resolved === undefined) return null;
    current = resolved;
    url = __videoUrlOf(current);
    if (__isPlayable(url)) return { video: current, url: url };
  }

  if (__declares('getVideoUrl') || __declares('videoUrlParse')) {
    const answered = __declares('getVideoUrl')
      ? String(await __call('getVideoUrl', current) || '')
      : await __videoUrlDefault(current);
    url = __absolute(answered, __BASE_URL);
    if (__isPlayable(url)) return { video: current, url: url };
  }

  return null;
}

/**
 * Every video an episode offers, in the order the extension wants them.
 *
 * The ordering is the whole of this function. Hosters first, because an
 * extension written against the current API declares nothing the legacy path
 * can call; the legacy path second, and only when the extension's own parser is
 * the legacy shape, so that a hoster-shaped class is never handed an episode
 * where it expected a hoster. A class with neither is a refusal naming both.
 */
async function __videosFor(episode) {
  if (__hasHosters()) {
    const hosters = __sortHosters(await __hosterList(episode));
    const found = [];
    for (const hoster of hosters) {
      if (!hoster || typeof hoster !== 'object') continue;
      const name = String(hoster.hosterName || '');
      const videos = __sortVideos(__arrayOf(await __hosterVideos(hoster)));
      for (const video of videos) {
        if (!video || typeof video !== 'object') continue;
        // The sentinel a source with no hoster concept wraps its videos under.
        // It is not a host and must not reach a viewer as a label.
        found.push({ video: video, hoster: name === Hoster.NO_HOSTER_LIST ? '' : name });
      }
    }
    if (found.length > 0) return found;

    // A hoster list that came back empty, on an extension that also kept the
    // legacy parser. Upstream would have reached that parser; refusing here
    // would report an episode with no streams when one path was never tried.
    if (!__hasLegacyVideoParse()) return found;
  } else if (!__hasEpisodeVideos()) {
    throw new Error(
      'This extension implements neither the hoster path (getHosterList, hosterListParse) ' +
      'nor the episode path (getVideoList, videoListParse), so nothing here knows how to ' +
      'find a stream for an episode.'
    );
  }

  const videos = __sortVideos(await __episodeVideos(episode));
  const out = [];
  for (const video of videos) {
    if (video && typeof video === 'object') out.push({ video: video, hoster: '' });
  }
  return out;
}

/** What a viewer sees in the stream picker: the host, the quality, or both. */
function __streamLabel(quality, hoster) {
  if (quality.length > 0 && hoster.length > 0) return hoster + ' \\u00b7 ' + quality;
  if (quality.length > 0) return quality;
  return hoster.length > 0 ? hoster : 'Source';
}
`;

export function aniyomiEntrypoint(options: AniyomiEntrypointOptions): string {
	const constants = [
		`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`,
		`const __BASE_URL = ${JSON.stringify(options.baseUrl.replace(/\/+$/, ''))};`
	].join('\n');

	// Before the runtime rather than beside the other constants: the preference
	// section reads this map while it is being evaluated, and a `const` declared
	// after it would still be in its temporal dead zone — which `typeof` does
	// not survive either.
	const settingIds = `var __SETTING_ID_MAP = ${JSON.stringify(options.settingIds ?? {})};`;

	return `${JS_RUNTIME}
${STREAM_GUARDS}
${DOM_RUNTIME_SOURCE}
const __rt = globalThis.__yorozoRuntime;
${settingIds}
${kotlinRuntime()}
${constants}
${synchronyPrelude(options.synchronyScript)}
${measurementPrelude()}

/* --- the translated extension ---------------------------------------------- */

${options.translatedSource}

/*
 * The source a class named by 'extClass' stands for.
 *
 * Usually the class itself. An AnimeSourceFactory is not a source: it is
 * 'createSources() = listOf(Example("en"), Example("ja"), Example("zh"))', one
 * source per language. Constructed as though it were one, the driver asked a
 * class with a single member for 'popularAnimeRequest', found nothing, and
 * every browse came back empty with nothing refused - two measured sources
 * both loaded that way.
 *
 * One plugin is one source here, so it is the FIRST one the factory makes: the
 * extension's own ordering, and the same variant the adapter already reads
 * this plugin's base url from (baseUrlFromFactoryTarget). A factory that makes
 * none is an error with its name on it, not an empty source.
 */
function __firstSource(made) {
  if (made === null || typeof made !== 'object' || typeof made.createSources !== 'function') {
    return made;
  }
  const all = __arr(made.createSources());
  if (all.length === 0) {
    throw new Error('This converted extension is a source factory that creates no sources.');
  }
  return all[0];
}

const __source = __firstSource(new ${options.className}());
${ANIYOMI_DRIVER}

/* --- the adapter ----------------------------------------------------------- */

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    const wanted = Number(page) > 0 ? Number(page) : 1;
    const text = String(query || '');

    // An empty query is the shelf, not a search for nothing: the browse screen
    // asks for a catalogue before anybody has typed, and an extension's popular
    // request is the only thing that answers that.
    if (text.length === 0) return await __shelf('popularAnime', wanted);

    // Filters are not part of this ABI, so the extension sees its own default
    // filter state — which is what it would have had before anybody touched a
    // control (see this file's header).
    const filters = __declares('getFilterList') ? __source.getFilterList() : [];
    if (__overrides('getSearchAnime', 3)) {
      return __normalisePage(await __call('getSearchAnime', wanted, text, filters));
    }
    if (!__declares('searchAnimeRequest')) return { entries: [] };
    return await __page('searchAnime', await __call('searchAnimeRequest', wanted, text, filters));
  },

  async browse(shelf, page, ctx) {
    __enter(ctx);
    const wanted = Number(page) > 0 ? Number(page) : 1;
    const latest =
      shelf === 'latest' &&
      (__declares('latestUpdatesRequest') || __overrides('getLatestUpdates', 1));
    return await __shelf(latest ? 'latestUpdates' : 'popularAnime', wanted);
  },

  async listEpisodes(sourceMediaId, ctx) {
    __enter(ctx);
    const anime = SAnime.create();
    anime.url = __foreign(sourceMediaId);

    // The override first, for the reason '__shelf' gives: a source that wrote
    // its own 'getEpisodeList' usually wrote 'episodeListRequest' as a throw.
    let parsed;
    if (__overrides('getEpisodeList', 1)) {
      parsed = await __call('getEpisodeList', anime);
    } else {
      const response = await client.newCall(__episodeRequest(anime)).execute();
      parsed = __declares('episodeListParse')
        ? await __call('episodeListParse', response)
        : await __defaultEpisodeList(response);
    }

    const rows = Array.isArray(parsed) ? parsed : [];
    const episodes = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || typeof row !== 'object') continue;
      const url = __absolute(String(row.url || ''), __BASE_URL);
      if (url.length === 0) continue;
      const declared = Number(row.episode_number);
      episodes.push({
        // The extension's own number when it stated one. Otherwise positional
        // and counted from the end, because these sites list newest first and
        // the numbering has to agree with the order the source gave.
        number: Number.isFinite(declared) && declared > 0 ? declared : rows.length - index,
        sourceEpisodeId: url,
        title: typeof row.name === 'string' && row.name.length > 0 ? row.name : undefined
      });
    }
    episodes.sort(function (a, b) { return a.number - b.number; });
    return episodes;
  },

  async resolve(sourceMediaId, episode, ctx) {
    __enter(ctx);

    // Before any request, because the answer does not depend on one. An
    // extension that overrides 'createHttpServer' plays by starting a local web
    // server on the device and pointing the player at it — the observation
    // ADR-0002 section 2.1 made, promoted into the upstream API. This build has
    // no such thing to give it and never will: a plugin gets no ambient
    // capability, and StreamPipeline is the answer here. Ignoring the override
    // would leave the extension handing back urls addressing a server nobody
    // started, which fails much later and says nothing about why.
    if (__declares('createHttpServer')) {
      throw __unsupported(
        'This extension plays by running a local web server on the device ' +
        '(createHttpServer) and pointing the player at it. Yorozo runs plugins ' +
        'with no ambient capability and no local server, so there is nothing ' +
        'here for that to bind to, and this source cannot be played by this build.'
      );
    }

    const target = episode && episode.sourceEpisodeId ? episode.sourceEpisodeId : sourceMediaId;

    const item = SEpisode.create();
    item.url = __foreign(target);

    const found = await __videosFor(item);
    const sources = [];
    for (const entry of found) {
      const made = await __playable(entry.video);
      if (made === null) continue;
      const url = made.url;
      // 'videoTitle' is the current spelling and 'quality' the deprecated one
      // that still reads it. Both are checked because a translated class may
      // have been written against either.
      const quality = String(made.video.videoTitle || made.video.quality || '').trim();
      sources.push({
        url: url,
        // A Video declares no container; the url is read by the shared rule.
        container: __streamContainer({ url: url }, 'mp4'),
        label: __streamLabel(quality, entry.hoster),
        quality: quality.length > 0 ? quality : undefined,
        headers: made.video.headers && typeof made.video.headers === 'object'
          ? made.video.headers
          : undefined,
        subtitles: __subtitlesOf(made.video)
      });
    }
    return sources;
  }
};

/** The base class's own episode list, for an extension that only declares selectors. */
async function __defaultEpisodeList(response) {
  const document = response.asJsoup();
  const selector = __selector('episodeListSelector');
  if (selector.length === 0) {
    throw new Error(
      'This extension declares no episodeListParse, and ' + __selectorReason('episodeListSelector') +
      ', so there is nothing to read an episode list with.'
    );
  }
  const out = [];
  for (const element of document.select(selector)) {
    out.push(await __call('episodeFromElement', element));
  }
  return out;
}

function __subtitlesOf(video) {
  const tracks = video.subtitleTracks || video.subtitles;
  if (!Array.isArray(tracks)) return undefined;
  const out = [];
  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue;
    const made = __subtitleTrack(
      track.url,
      String(track.lang || track.label || ''),
      '',
      __BASE_URL
    );
    if (made !== null) out.push(made);
  }
  return out.length > 0 ? out : undefined;
}
`;
}
