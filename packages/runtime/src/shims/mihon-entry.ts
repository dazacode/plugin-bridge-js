/**
 * A translated manga extension, wrapped as a Yorozo plugin bundle.
 *
 * The sibling of `aniyomi-entry.ts`, and it exists for the same reason: an
 * extension in this ecosystem is a **subclass**, and most of what makes it work
 * lives in the class it extends, which is not in the file being converted.
 *
 * ## What is shared with the video half, and what is not
 *
 * The two ecosystems are one fork apart, so the *shapes* are the same — a
 * request, a list of elements, a next-page check — and `FOREIGN.md` §4.1.3's
 * argument applies unchanged: a template is ordinary machinery a host may ship,
 * because it can be written without naming a single site. There are no
 * hostnames here and there never may be.
 *
 * What differs is everything below a title. An episode yields hosters and a
 * hoster yields videos; a chapter yields **pages**, and a page is an image with
 * headers. That difference is why this is a second file rather than a parameter
 * on the first: the two would share their outer third and disagree everywhere
 * that matters, and a driver that is right about half a medium is the failure
 * `ABI.md` §8.5 refuses at load.
 *
 * ## The two base classes, and the overloads that come with them
 *
 * Upstream has `HttpSource` (fetch and parse it yourself) and
 * `ParsedHttpSource` (declare selectors, let the base walk the document).
 * Three members are declared on **both**, taking a `Response` on one and a
 * `Document` on the other: `mangaDetailsParse`, `pageListParse` and
 * `imageUrlParse`.
 *
 * Kotlin tells those apart by overload resolution. JavaScript has none, so once
 * a class is translated each is *one* name for two methods, and the driver has
 * to decide what to hand it. It does not decide: it passes a value that answers
 * **both** protocols — the response, widened with the document's selector
 * methods. See `__both`. That is a widening rather than a guess, which is the
 * distinction that makes it allowed here: guessing wrong would hand a JSON
 * parser an HTML document, and the symptom is an empty chapter list out of a
 * bundle that reported nothing refused.
 *
 * ## Overrides win, always
 *
 * Every member below is called *through* the translated instance when it
 * defines one, and falls back to the default only when it does not — the same
 * ordering, and for the same measured reason, as the video driver.
 */

import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { JS_RUNTIME } from './js-runtime';
import { kotlinRuntime } from './kotlin-runtime';
import { STREAM_GUARDS } from './stream-guards';

export interface MihonEntrypointOptions {
	/** Must equal the manifest id, or the sandbox refuses to load the bundle. */
	readonly pluginId: string;
	/** `emit.ts`'s output, embedded verbatim so a conversion can be read. */
	readonly translatedSource: string;
	/** The class the translated source declares. */
	readonly className: string;
	/** The extension's own base URL, from its build file or its constants. */
	readonly baseUrl: string;
	/** The language this listing serves, which the generated subclass supplies. */
	readonly lang?: string;
	/** Foreign preference key to manifest setting id. */
	readonly settingIds?: Readonly<Record<string, string>>;
	/**
	 * The non-Kotlin files fetched beside the source, keyed as the classpath
	 * names them — `assets/i18n/messages_en.properties` and its siblings.
	 *
	 * Embedded rather than fetched at run time because the plugin has no way to
	 * reach the source repository, and because the conversion already listed
	 * the directory they sit in. Absent for a conversion whose repository had
	 * none, which the runtime reads as an empty classpath.
	 */
	readonly resources?: Readonly<Record<string, string>>;
	/**
	 * Whether the class descends from keiyoushi's `KeiSource`, the repository's
	 * own base between the extension and `HttpSource`.
	 *
	 * It is a different base class, not a style: it makes `headersBuilder` and
	 * `client` final and builds them itself — `Referer` and `Origin` on every
	 * request, then the extension's `configureHeaders`; the extension's
	 * `configureClient` on a copy of the shared client, which is where its
	 * rate limit is declared — and it owns `getMangaUpdate`. None of that is in
	 * the translated source, because none of it is in the extension. The
	 * adapter reads the class hierarchy it fetched and says so here.
	 */
	readonly keiSource?: boolean;
}

const MIHON_DRIVER = String.raw`
/* --- the base class this build supplies ------------------------------------ */

/**
 * 'headers' and 'headersBuilder()', which the base class owns and the extension
 * reads bare.
 *
 * Nothing defined either on the instance, so 'GET(url, headers)' sent
 * 'undefined' as its headers — a request with no Referer, which an image host
 * answers 403 — and a bare 'headersBuilder()' was not a function. The video
 * driver closed the same gap long ago; this is its other half.
 *
 * Under 'KeiSource' both are the base class's and final: the builder is the
 * plain one with 'Referer' and 'Origin' set from 'baseUrl', then handed to the
 * extension's own 'configureHeaders' when it declares one. And 'headers' is
 * deliberately NOT lazy there — the base class replaces the delegate so a
 * preference that changes the base url changes the next request — so it is
 * rebuilt on each read rather than memoised as 'HttpSource' does.
 */
if (__KEI_SOURCE) {
  __source.headersBuilder = function () {
    var base = String(__source.baseUrl || __BASE_URL);
    var builder = Headers.Builder().set('Referer', base + '/').set('Origin', base);
    if (typeof __source.configureHeaders !== 'function') return builder;
    var configured = __source.configureHeaders(builder);
    return configured === undefined || configured === null ? builder : configured;
  };
} else if (typeof __source.headersBuilder !== 'function') {
  __source.headersBuilder = function () { return Headers.Builder(); };
}
if (!('headers' in __source)) {
  var __headerCache = null;
  Object.defineProperty(__source, 'headers', {
    configurable: true,
    get: function () {
      if (__KEI_SOURCE) return __headers();
      if (__headerCache === null) __headerCache = __headers();
      return __headerCache;
    }
  });
}

/**
 * 'client', 'network', 'json' and 'preferences', which the base class owns
 * and an extension reaches through bare: 'client.newCall(…)', 'network.client',
 * 'json.decodeFromString(…)'.
 *
 * None was on the instance, so 'this.client' was undefined and every request a
 * translated member made itself died on the first search — while the bundle
 * imported cleanly and was counted as working. Each is defined only when the
 * class has none of its own: an extension that overrides 'client' with its own
 * interceptor chain means that one.
 *
 * Under 'KeiSource' the client is final and lazy: the shared client, rebuilt
 * with whatever the extension's 'configureClient' adds. That hook is where the
 * catalogue declares its rate limits — 'configureClient() = rateLimit(3)' — so
 * a client that skipped it would send as fast as it liked on behalf of a source
 * that asked it not to.
 */
if (__KEI_SOURCE && !('client' in __source)) {
  var __keiClient = null;
  Object.defineProperty(__source, 'client', {
    configurable: true,
    get: function () {
      if (__keiClient === null) {
        var builder = network.client.newBuilder();
        if (typeof __source.configureClient === 'function') {
          var configured = __source.configureClient(builder);
          if (configured !== undefined && configured !== null) builder = configured;
        }
        __keiClient = builder.build();
      }
      return __keiClient;
    }
  });
}
for (const __own of [
  ['client', client],
  ['network', network],
  ['json', Json],
  ['preferences', getPreferences()]
]) {
  if (!(__own[0] in __source)) __source[__own[0]] = __own[1];
}

/** Whether the translated class actually defines a member. */
function __declares(name) {
  return typeof __source[name] === 'function';
}

/** Why the last call to each selector member came back with nothing. */
var __selectorFailure = {};

/**
 * A selector the extension declares, or '' when it declares none.
 *
 * The failure is recorded rather than swallowed for the reason the video
 * driver records it: a themed extension writes one selector in terms of
 * another, that other lives in the template file, and if the template was not
 * part of the conversion the call throws. "Declares no selector" would send
 * whoever reads the error to the wrong file.
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

function __selectorReason(name) {
  const failure = __selectorFailure[name];
  if (failure === undefined) return 'declares no ' + name;
  return 'declares ' + name + ', but calling it failed (' + failure + ')';
}

/**
 * A response that also answers as a document.
 *
 * The overload problem, solved by widening rather than by choosing. Three
 * members upstream take a Response on one base class and a Document on the
 * other, and after translation each is one function. This hands it an object
 * that satisfies whichever protocol the body actually uses.
 *
 * **The document is parsed lazily**, which is the part that makes this safe
 * rather than merely convenient: an extension that reads JSON never causes an
 * HTML parse, so a JSON body is not run through a parser that would quietly
 * succeed on it and produce an empty selection.
 *
 * Response members win where the names would collide. Nothing on a jsoup
 * Document is called 'body', 'code' or 'headers', so in practice they do not.
 */
function __both(response) {
  let document = null;
  const asDocument = function () {
    if (document === null) document = response.asJsoup();
    return document;
  };

  const widened = Object.create(response);
  const forward = [
    'select', 'selectFirst', 'getElementById', 'getElementsByTag',
    'getElementsByClass', 'getElementsByAttribute', 'text', 'html', 'outerHtml',
    'attr', 'hasAttr', 'children', 'parent', 'ownText', 'data', 'title'
  ];
  for (const name of forward) {
    widened[name] = (function (member) {
      return function () {
        const target = asDocument();
        if (typeof target[member] !== 'function') {
          throw new Error('The parsed document has no ' + member + '().');
        }
        return target[member].apply(target, arguments);
      };
    })(name);
  }
  widened.asJsoup = asDocument;
  return widened;
}

/**
 * The base class's own implementations, reachable as 'super'.
 *
 * An explicit 'super.' call is the extension telling us in its own source that
 * the base behaviour belongs at this point, which is a different act from
 * inventing a fallback for a member we failed to read. The video driver's
 * header argues this at length and the argument is unchanged here.
 */
const __super = {
  popularMangaParse: function (response) { return __parsePage('popularManga', response); },
  searchMangaParse: function (response) { return __parsePage('searchManga', response); },
  latestUpdatesParse: function (response) { return __parsePage('latestUpdates', response); },

  chapterListParse: function (response) { return __defaultChapterList(response); },

  mangaDetailsParse: function (value) {
    const document = value && typeof value.asJsoup === 'function' ? value.asJsoup() : value;
    const manga = SManga.create();
    manga.title = __textOf(document, 'h1');
    manga.description = __textOf(document, 'p');
    manga.initialized = true;
    return manga;
  },

  pageListParse: function () {
    throw new Error(
      'This extension declares no pageListParse, so nothing here knows how to read the ' +
      'images out of a chapter.'
    );
  },

  imageUrlParse: function () {
    throw new Error('This extension declares no imageUrlParse.');
  },

  headersBuilder: function () { return Headers.Builder(); },

  popularMangaRequest: function (page) { return GET(__BASE_URL + '/?page=' + page, __headers()); },
  latestUpdatesRequest: function (page) { return GET(__BASE_URL + '/?page=' + page, __headers()); },
  searchMangaRequest: function (page, query) {
    return GET(__BASE_URL + '/?q=' + encodeURIComponent(String(query || '')), __headers());
  },

  mangaDetailsRequest: function (manga) { return GET(__absolute(manga.url, __BASE_URL), __headers()); },
  chapterListRequest: function (manga) { return __super.mangaDetailsRequest(manga); },
  pageListRequest: function (chapter) { return GET(__absolute(chapter.url, __BASE_URL), __headers()); },
  imageUrlRequest: function (page) { return GET(__absolute(page.url, __BASE_URL), __headers()); },

  /* The one request whose headers are load-bearing. 'ABI.md' §8.3: an image
     host answers 403 without a Referer on a page whose chapter loaded fine, and
     this is the hook upstream added for exactly that. */
  imageRequest: function (page) {
    return GET(__absolute(page.imageUrl || page.url, __BASE_URL), __headers());
  },

  popularMangaNextPageSelector: function () { return ''; },
  searchMangaNextPageSelector: function () { return ''; },
  latestUpdatesNextPageSelector: function () { return ''; },

  getMangaUrl: function (manga) { return __absolute(manga.url, __BASE_URL); },
  getChapterUrl: function (chapter) { return __absolute(chapter.url, __BASE_URL); },

  /* The Rx-era half of the base class.
   *
   * Upstream's older API is 'fetchX(): Observable<T>', and it is still what
   * most of this catalogue overrides: 271 members named 'fetchSearchManga',
   * 122 'fetchChapterList'. An extension that overrides one of these
   * routinely also calls 'super' on it — wrapping the base behaviour rather
   * than replacing it — so the base has to have one.
   *
   * Each is the request/parse pair this driver already runs, wrapped in an
   * Observable. They answer the *Kotlin* shape, not the ABI's: the caller is
   * translated Kotlin that will '.map' over a MangasPage, and normalising
   * early would hand it an object with different field names.
   *
   * 'fetchPopularManga' used to return the *request* rather than the page,
   * which nothing could have mapped over. */
  fetchPopularManga: function (page) {
    return Observable.fromCallable(async function () {
      return __call('popularMangaParse', [await __send(__call('popularMangaRequest', [page]))]);
    });
  },
  fetchLatestUpdates: function (page) {
    return Observable.fromCallable(async function () {
      return __call('latestUpdatesParse', [await __send(__call('latestUpdatesRequest', [page]))]);
    });
  },
  fetchSearchManga: function (page, query, filters) {
    return Observable.fromCallable(async function () {
      const request = __call('searchMangaRequest', [page, query, filters || []]);
      return __call('searchMangaParse', [await __send(request)]);
    });
  },
  fetchMangaDetails: function (manga) {
    return Observable.fromCallable(async function () {
      return __call('mangaDetailsParse', [await __send(__call('mangaDetailsRequest', [manga]))]);
    });
  },
  fetchChapterList: function (manga) {
    return Observable.fromCallable(async function () {
      return __call('chapterListParse', [await __send(__call('chapterListRequest', [manga]))]);
    });
  },
  fetchPageList: function (chapter) {
    return Observable.fromCallable(async function () {
      return __call('pageListParse', [__both(await __send(__call('pageListRequest', [chapter])))]);
    });
  },

  /* The coroutine half, which is the API upstream actually has now.
   *
   * 'suspend fun getPopularManga(page): MangasPage' and its siblings replaced
   * the Rx generation, and the catalogue has moved: 332 of this repository's
   * source files declare 'getPopularManga', 331 'getLatestUpdates', 330
   * 'getPageList', and about 300 'getSearchMangaList'. An extension that
   * overrides one of these calls 'super' on it as readily as it does the Rx
   * one, so the base has to answer.
   *
   * Each unwraps the Observable the pair above already builds, which is what
   * upstream's own default does in the other direction ('fetchX' delegates to
   * 'getX' there, and the deprecated half is the wrapper). Written this way
   * round because the request/parse pair is what this driver implements, and
   * one description of it is better than two. */
  getPopularManga: async function (page) { return await __super.fetchPopularManga(page); },
  getLatestUpdates: async function (page) { return await __super.fetchLatestUpdates(page); },
  getSearchMangaList: async function (page, query, filters) {
    return await __super.fetchSearchManga(page, query, filters);
  },
  /* The spelling before it was renamed. Both are live upstream and an
     extension writes one or the other, never both. */
  getSearchManga: async function (page, query, filters) {
    return await __super.fetchSearchManga(page, query, filters);
  },
  getMangaDetails: async function (manga) { return await __super.fetchMangaDetails(manga); },
  getChapterList: async function (manga) { return await __super.fetchChapterList(manga); },
  getPageList: async function (chapter) { return await __super.fetchPageList(chapter); },
  getImageUrl: async function (page) {
    return __call('imageUrlParse', [await __send(__call('imageRequest', [page]))]);
  },

  /* The current API's final entry point, and all it does upstream: check it
   * was asked for something, run the extension's own 'fetchMangaUpdate', and
   * mark the title initialised. Nothing is composed out of the older members
   * for an extension that has no 'fetchMangaUpdate' — the base class only
   * ever calls that one, and inventing a fallback is a request the author
   * never wrote. */
  getMangaUpdate: async function (manga, chapters, fetchDetails, fetchChapters) {
    if (!fetchDetails && !fetchChapters) {
      throw new Error('getMangaUpdate was called with nothing to fetch.');
    }
    if (!__declares('fetchMangaUpdate')) {
      throw new Error('This extension declares no fetchMangaUpdate for getMangaUpdate to run.');
    }
    const update = await __source.fetchMangaUpdate(manga, chapters, fetchDetails, fetchChapters);
    if (update === null || update === undefined || update.manga === null || update.manga === undefined) {
      throw new Error('The fetchMangaUpdate of this extension answered no manga.');
    }
    update.manga.initialized = true;
    return SMangaUpdate(update.manga, update.chapters);
  },

  setupPreferenceScreen: function () {}
};

/** The first text a selector finds, or '' — used only by the default details. */
function __textOf(document, selector) {
  try {
    const found = document.selectFirst(selector);
    return found === null || found === undefined ? '' : String(found.text());
  } catch (error) {
    return '';
  }
}

function __headers() {
  if (__declares('headersBuilder')) {
    try {
      const built = __source.headersBuilder();
      if (built && typeof built.build === 'function') return built.build();
      if (built && typeof built === 'object') return built;
    } catch (error) {
      /* An extension whose header builder throws still gets to make requests. */
    }
  }
  return {};
}

/**
 * One list page, read with the selectors the extension declares.
 *
 * The two halves are separately overridable and usually only one of them is: an
 * extension that rewrites '<kind>Parse' has taken over the whole page, and one
 * that only declares selectors has not.
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

  const mangas = [];
  for (const element of document.select(selector)) {
    mangas.push(__source[kind + 'FromElement'](element));
  }

  const next = __selector(kind + 'NextPageSelector');
  const hasNextPage = next.length > 0 && document.selectFirst(next) !== null;

  // The plain record rather than the runtime's constructor, so translated code
  // reading '.mangas' off a 'super' call gets the shape it expects.
  return { mangas: mangas, hasNextPage: hasNextPage };
}

/** A chapter list, read with 'chapterListSelector' and 'chapterFromElement'. */
function __defaultChapterList(response) {
  const document = response.asJsoup();
  const selector = __selector('chapterListSelector');
  if (selector.length === 0) {
    throw new Error(
      'This extension ' + __selectorReason('chapterListSelector') + ' and no chapterListParse, ' +
      'so there is nothing to read a chapter list with.'
    );
  }
  if (!__declares('chapterFromElement')) {
    throw new Error('This extension declares a chapterListSelector but no chapterFromElement.');
  }
  const chapters = [];
  for (const element of document.select(selector)) {
    chapters.push(__source.chapterFromElement(element));
  }
  return chapters;
}

/** Calls the override when there is one, the base implementation otherwise. */
function __call(name, args) {
  const target = __declares(name) ? __source[name] : __super[name];
  if (typeof target !== 'function') {
    throw new Error('This extension does not implement ' + name + '.');
  }
  return target.apply(__source, args);
}

/**
 * One request, sent through the extension's own client.
 *
 * 'client.newCall(request).execute()' rather than a bare fetch, because that is
 * what the translated code itself calls and it is where the declared request
 * policy is applied — the rate limit an extension set to protect a source.
 * Sending around it would convert an extension that throttles itself into one
 * that does not, which 'FOREIGN.md' §4.1.8 records as the reason the policy
 * exists at all.
 */
async function __send(pending) {
  // A request member may suspend — it reads a token first — and hands back a
  // Promise of the request rather than the request.
  const request = await pending;
  if (request === null || request === undefined) {
    throw new Error('This extension built no request.');
  }
  const call = typeof request === 'string' ? GET(request, __headers()) : request;
  // The instance's client, not the runtime's shared one: an extension that
  // overrides 'client' — or configures it under KeiSource — declared its rate
  // limit and interceptors there, and this is the path every request/parse
  // pair takes.
  const through = __source.client && typeof __source.client.newCall === 'function'
    ? __source.client
    : client;
  return await through.newCall(call).execute();
}

function __normalisePage(value) {
  const decoded = value && typeof value === 'object' ? value : {};
  const rows = Array.isArray(decoded.mangas) ? decoded.mangas : [];
  const entries = [];
  for (const row of rows) {
    const entry = __entryOf(row);
    if (entry !== null) entries.push(entry);
  }
  return { entries: entries, hasMore: decoded.hasNextPage === true };
}

/**
 * One catalogue entry.
 *
 * 'url' is kept **verbatim** as the source minted it. 'ABI.md' §1 says a
 * sourceMediaId is the source's own id, and it is handed straight back to this
 * same extension's detail request — which builds an absolute url from it
 * itself. Rewriting it here and undoing that on the way back is lossy in one
 * direction, and the symptom is a request for a path the gate refuses.
 */
function __entryOf(manga) {
  if (!manga || typeof manga !== 'object') return null;
  const url = String(manga.url || '');
  const title = String(manga.title || '').trim();
  if (url.length === 0 || title.length === 0) return null;
  return {
    sourceMediaId: url,
    title: title,
    alternativeTitles: [],
    posterImageUrl: __absolute(String(manga.thumbnail_url || ''), __BASE_URL) || undefined
  };
}

/** A stub carrying the manga url, which is all the request members read. */
function __mangaRef(sourceMediaId) {
  const manga = SManga.create();
  manga.url = String(sourceMediaId);
  return manga;
}

/**
 * A chapter's 'memo' travels inside its id.
 *
 * Upstream persists a chapter's memo with the chapter, and a source that wrote
 * one reads it back when the chapter is opened: Madara keeps the title's path
 * there and builds the chapter url from it, so without it every chapter it
 * lists answers "Refresh the chapter list." This host keeps nothing between
 * 'listChapters' and 'readChapter' except the id — which 'ABI.md' §8.2 makes
 * the source's own opaque string, handed back verbatim — so the memo rides in
 * it, after the url, and is taken off again here.
 *
 * Only a non-empty memo is carried, so every other source's ids are exactly
 * its urls, as before. The encoded part cannot contain '#', so the last marker
 * is always the one this wrote, whatever the url itself contains.
 *
 * A title's memo is deliberately not carried the same way: it is not stable
 * (Madara's holds the genres), and a title's id is what the matching layer
 * binds, so a title whose memo changed would become a different title.
 */
const __MEMO_MARK = '#yorozo-memo=';

function __chapterIdOf(url, memo) {
  if (!memo || typeof memo !== 'object' || Array.isArray(memo)) return url;
  let text;
  try {
    text = JSON.stringify(memo);
  } catch (e) {
    return url;
  }
  if (typeof text !== 'string' || text === '{}') return url;
  return url + __MEMO_MARK + encodeURIComponent(text);
}

function __chapterRef(sourceChapterId) {
  const chapter = SChapter.create();
  const id = String(sourceChapterId);
  const at = id.lastIndexOf(__MEMO_MARK);
  if (at > 0) {
    try {
      const memo = JSON.parse(decodeURIComponent(id.slice(at + __MEMO_MARK.length)));
      if (memo && typeof memo === 'object' && !Array.isArray(memo)) {
        chapter.url = id.slice(0, at);
        chapter.memo = memo;
        return chapter;
      }
    } catch (e) {
      // Not one this driver wrote: the id is the url, verbatim.
    }
  }
  chapter.url = id;
  return chapter;
}

/** One list page, fetched and normalised. */
/**
 * One catalogue page, through whichever half of the API this extension wrote.
 *
 * Most of the catalogue overrides the request/parse pair, and this driver was
 * built for that. A large minority overrides 'fetchX' instead — the older
 * Observable API — and for those the pair below is *not* what the extension
 * implements: calling it runs the base class's request against a source whose
 * author wrote something else entirely, which is a wrong page rather than a
 * missing one.
 *
 * So the override wins when there is one. 'await' handles the Observable
 * because '__observable' is thenable, and it handles a plain value too, which
 * is what an extension that ignored the Rx wrapper returns.
 */
function __overrideName(names) {
  for (let i = 0; i < names.length; i += 1) if (__declares(names[i])) return names[i];
  return null;
}

async function __page(kind, coroutine, args) {
  const override = __overrideName(
    coroutine.concat(['fetch' + kind.charAt(0).toUpperCase() + kind.slice(1)])
  );
  if (override !== null) {
    return __normalisePage(await __source[override].apply(__source, args));
  }
  const response = await __send(__call(kind + 'Request', args));
  // Awaited: a parse member that makes a request of its own — one measured source reads a
  // JSON file named in the page it was handed — is emitted 'async', and the
  // Promise it answers has no 'mangas'. Normalised unawaited, every result on
  // the page was dropped and the page came back empty, reporting nothing.
  return __normalisePage(await __call(kind + 'Parse', [response]));
}
`;

export function mihonEntrypoint(options: MihonEntrypointOptions): string {
	const constants = [
		`const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};`,
		`const __BASE_URL = ${JSON.stringify(options.baseUrl.replace(/\/+$/, ''))};`,
		`const __LANG = ${JSON.stringify(options.lang ?? '')};`,
		`const __KEI_SOURCE = ${options.keiSource === true};`
	].join('\n');

	// Before the runtime, for the reason the video entry gives: the preference
	// section reads this map while it is being evaluated.
	const settingIds = `var __SETTING_ID_MAP = ${JSON.stringify(options.settingIds ?? {})};`;

	// Beside it, and declared here rather than in the runtime because its
	// contents are a property of this conversion rather than of the runtime.
	//
	// The position is NOT load-bearing the way the line above is, and the test
	// that was written to pin it does not: `var` hoists, and the only read is
	// inside `__k.classLoader()`, which nothing calls before the extension is
	// constructed — well after both. It is here because that is where a reader
	// looking for "what did this conversion carry" will look.
	const resources = `var __RESOURCES = ${JSON.stringify(options.resources ?? {})};`;

	return `${JS_RUNTIME}
${STREAM_GUARDS}
${DOM_RUNTIME_SOURCE}
const __rt = globalThis.__yorozoRuntime;
${settingIds}
${resources}
${kotlinRuntime()}
${constants}

/* --- the translated extension ---------------------------------------------- */

${options.translatedSource}

/**
 * The instance, with what the generated subclass would have supplied.
 *
 * Upstream's build step generates a concrete class carrying \`name\`, \`lang\`,
 * \`id\` and \`baseUrl\`; the class in the source tree is abstract and has none
 * of them. \`mihon-build-file.ts\` reads those from the module's build file and
 * they are attached here, because a source that builds every request from
 * \`baseUrl\` gets \`undefined/manga/1\` without them.
 */
const __source = new ${options.className}();
if (!__source.baseUrl) __source.baseUrl = __BASE_URL;
if (!__source.lang && __LANG.length > 0) __source.lang = __LANG;

${MIHON_DRIVER}

/* --- the adapter ----------------------------------------------------------- */

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    const wanted = Number(page) > 0 ? Number(page) : 1;
    const text = String(query || '');

    // An empty query is the shelf, not a search for nothing: the browse screen
    // asks for a catalogue before anybody has typed.
    if (text.length === 0) {
      return await __page('popularManga', ['getPopularManga'], [wanted]);
    }
    return await __page(
      'searchManga',
      ['getSearchMangaList', 'getSearchManga'],
      [wanted, text, []]
    );
  },

  async browse(shelf, page, ctx) {
    __enter(ctx);
    const wanted = Number(page) > 0 ? Number(page) : 1;
    const latest =
      shelf === 'latest' &&
      (__declares('latestUpdatesRequest') ||
        __declares('fetchLatestUpdates') ||
        __declares('getLatestUpdates'));
    const kind = latest ? 'latestUpdates' : 'popularManga';
    const coroutine = latest ? ['getLatestUpdates'] : ['getPopularManga'];
    return await __page(kind, coroutine, [wanted]);
  },

  async listChapters(sourceMediaId, ctx) {
    __enter(ctx);
    const manga = __mangaRef(sourceMediaId);
    // Same rule as '__page': the override wins, because an extension that
    // wrote 'fetchChapterList' may not have written the pair at all.
    //
    // 'fetchMangaUpdate' first, because under the current API it is the one
    // the host calls: details and chapters from one request, asked here for
    // the chapters only. An extension that implements it usually declares no
    // chapter member of any other generation, so the pair below would be the
    // base class's request sent to a site whose author wrote something else.
    let rows;
    if (__declares('fetchMangaUpdate')) {
      rows = (await __super.getMangaUpdate(manga, [], false, true)).chapters;
    } else {
      const chapterOverride = __overrideName(['getChapterList', 'fetchChapterList']);
      rows = chapterOverride !== null
        ? await __source[chapterOverride](manga)
        : __call('chapterListParse', [await __send(__call('chapterListRequest', [manga]))]);
    }

    const chapters = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      const url = String(row.url || '');
      if (url.length === 0) continue;
      const number = Number(row.chapter_number);
      const name = String(row.name || '');
      const date = Number(row.date_upload) || 0;
      chapters.push({
        // Verbatim, and handed back to this extension's own page request.
        // Plus its memo, when it wrote one: see '__chapterIdOf'.
        sourceChapterId: __chapterIdOf(url, row.memo),
        // Upstream's unset value is -1, which is not a chapter number. A list
        // that states none is numbered by its own order, newest first, which
        // is how these sites render.
        number: Number.isFinite(number) && number >= 0 ? number : chapters.length + 1,
        title: name.length > 0 ? name : undefined,
        scanlator: typeof row.scanlator === 'string' && row.scanlator.length > 0
          ? row.scanlator
          : undefined,
        publishedAt: date > 0 ? new Date(date).toISOString() : undefined
      });
    }
    chapters.sort(function (a, b) { return a.number - b.number; });
    return chapters;
  },

  async readChapter(sourceMediaId, chapter, ctx) {
    __enter(ctx);
    const target = chapter && chapter.sourceChapterId
      ? String(chapter.sourceChapterId)
      : String(sourceMediaId);
    const reference = __chapterRef(target);
    // The widened value, so whichever overload this extension wrote is the one
    // that answers. See '__both'.
    const pageOverride = __overrideName(['getPageList', 'fetchPageList']);
    const rows = pageOverride !== null
      ? await __source[pageOverride](reference)
      : __call('pageListParse', [__both(await __send(__call('pageListRequest', [reference])))]);

    const pages = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== 'object') continue;
      let image = String(row.imageUrl || '');

      // A page that carries only a url resolves its image separately — the
      // second request upstream's 'imageUrlParse' exists for. Skipped rather
      // than guessed when the extension declares no way to do it.
      // 'getImageUrl(page)' is the coroutine spelling of the same second
      // request, and the one an extension written against the current API
      // declares instead of 'imageUrlParse'.
      const urlOverride = __overrideName(['getImageUrl', 'fetchImageUrl']);
      if (image.length === 0 && String(row.url || '').length > 0 && urlOverride !== null) {
        try {
          image = String((await __source[urlOverride]({ index: pages.length, url: row.url, imageUrl: '' })) || '');
        } catch (error) {
          image = '';
        }
      }
      if (image.length === 0 && String(row.url || '').length > 0 && __declares('imageUrlParse')) {
        try {
          const resolved = await __send(__call('imageUrlRequest', [row]));
          // Awaited for the same reason as '__page': unawaited, a suspending
          // imageUrlParse made every page's image the text "[object Promise]".
          image = String((await __call('imageUrlParse', [__both(resolved)])) || '');
        } catch (error) {
          image = '';
        }
      }
      if (image.length === 0) continue;

      // The headers the extension asks for on an *image*, which is the whole
      // reason 'imageRequest' is a separate member upstream and the whole
      // reason 'PageImage.headers' is in the ABI.
      let headers;
      if (__declares('imageRequest')) {
        try {
          const request = __source.imageRequest({ index: pages.length, url: row.url || '', imageUrl: image });
          if (request && typeof request === 'object') {
            if (request.url) image = String(request.url);
            if (request.headers && typeof request.headers === 'object') headers = request.headers;
          }
        } catch (error) {
          /* A builder that throws leaves the page reachable without headers. */
        }
      }

      pages.push({
        index: pages.length,
        url: __absolute(image, __BASE_URL),
        headers: headers
      });
    }
    return { pages: pages };
  }
};
`;
}
