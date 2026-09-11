/**
 * The contract between the emitter and the runtime, written down once.
 *
 * Two halves of the Kotlin converter are built against each other: `emit.ts`
 * produces JavaScript that calls helpers, and `shims/kotlin-runtime.ts` defines
 * them as bundle source. Neither can import the other — one emits text, the
 * other *is* text — so nothing but a shared list stops them drifting apart, and
 * a drift shows up as `__k.foo is not a function` at the far end of a
 * conversion, inside a sandbox, on somebody's phone.
 *
 * So the list lives here, and `kotlin-runtime.spec.ts` asserts that the runtime
 * source defines every name in it. Adding a helper means adding it here first;
 * emitting a call to something absent fails a test rather than a viewer.
 *
 * ## Why one namespace object
 *
 * Everything hangs off `__k`. The emitted code shares a scope with the
 * *converted source's own* identifiers, and Kotlin extensions are full of
 * short names — `headers`, `client`, `json`, `page`, `element`. A bare
 * `substringAfter` helper would be shadowed by any local with that name, and
 * the failure would be a wrong value rather than an error.
 *
 * The types that a scraper writes by name — `SAnime`, `SEpisode`, `Video`,
 * `Jsoup`, `GET`, `POST`, `Headers`, `FormBody` — are the exception: those are
 * spelled the way the Kotlin spells them, because the emitter passes them
 * through unchanged rather than rewriting every construction site.
 */

/**
 * Helpers the emitter may call on `__k`.
 *
 * Grouped by what forced them into existence. A name here is a promise the
 * runtime keeps; a name missing here is one the emitter may not emit.
 */
export const RUNTIME_HELPERS = [
	/* Null handling. Kotlin's `!!` and `?.` do not survive as JavaScript's `?.`
	   alone: `!!` must *throw*, and it must say which expression was null. */
	'nn',

	/* Numbers. Kotlin `Int` division truncates and `"abc".toInt()` throws where
	   `Number("abc")` is silently NaN — both are wrong-value bugs, not errors. */
	'toIntOrNull',
	'toInt',
	'toFloatOrNull',
	'toFloat',
	'toLongOrNull',
	'toLong',
	'countLeadingZeroBits',
	'intDiv',
	'bitwiseAnd',
	'bitwiseOr',
	'bitwiseXor',
	'toByte',

	/* Strings. The `substring*` family's two-argument forms return the *whole*
	   string when the delimiter is absent, which no JavaScript builtin does. */
	'substringAfter',
	'substringAfterLast',
	'substringBefore',
	'substringBeforeLast',
	'removePrefix',
	'removeSuffix',
	'removeSurrounding',
	'trimIndent',
	'ifEmpty',
	'ifBlank',
	'isNullOrEmpty',
	'isNullOrBlank',
	'replaceString',
	'split',
	'lowercase',
	'uppercase',
	'padStart',
	'contains',
	'startsWith',
	'endsWith',
	'isNotBlank',
	'isBlank',
	'isNotEmpty',
	'isEmpty',
	'toStringOf',
	'trim',
	'formatBytes',
	'now',
	'digitToIntOrNull',
	'toIntArray',
	'toJsonString',
	'asQueryPart',
	'withLock',
	'elementAt',
	'iterator',
	'trimMargin',
	'encodeToString',
	'rateLimit',
	'rateLimitHost',
	'stop',

	/* Thrown by an extension that declares a member it does not implement.
	   Measured in 134 of 254 extensions, so it is ordinary control flow here
	   rather than an edge case, and it must survive translation as a throw. */
	'unsupported',

	/* `List<Video>.toHosterList()` — the base class's own bridge from the legacy
	   video API to the hoster API, which a source with no hoster concept calls
	   to answer `getHosterList`. A companion extension function, so it takes its
	   receiver first like the rest of this list. */
	'toHosterList',

	/* Indexing. `[]` is syntax rather than a method, and it is the one piece of
	   syntax whose JavaScript namesake is wrong for the runtime's own types: a
	   Map is a real `Map`, and `map['k']` reads a property of it. */
	'index',
	'setIndex',
	/* `.get(k)`, which is the same operation written as a call. */
	'getAt',
	/* Kotlin's arithmetic, spelled as methods. */
	'times',
	'divide',
	'subtract',
	/* `ByteArray.toHexString()`, which a nonce is spelled with. */
	'toHexString',
	/* `delay(…)`, which suspends — see AWAITING_HELPERS. */
	'delay',
	/* `String.format(…)` and `"%s".format(…)`, one formatter either way. */
	'format',

	/* Collections. `mapNotNull` is not `map().filter()`, and every one of these
	   may be handed a suspending lambda — see `awaitAll`. */
	'map',
	'mapNotNull',
	'filter',
	'filterNot',
	'flatMap',
	'flatMapIndexed',
	'firstOrNull',
	'first',
	'lastOrNull',
	'last',
	'find',
	'any',
	'all',
	'none',
	'sortedBy',
	'sortedByDescending',
	'reversed',
	'distinct',
	'take',
	'drop',
	'joinToString',
	'toList',
	'toSet',
	'toMutableMap',
	'forEach',
	'indexOfFirst',
	'groupBy',
	'associate',
	'associateBy',
	'indices',
	'associateWith',
	'sumOf',
	'count',
	'withIndex',
	'zip',
	'chunked',
	'plus',
	'listOfNotNull',
	'emptyList',

	/* `kotlin.math`. Written as a method on the number — `base.toFloat().pow(i)`
	   — so it takes its receiver first like everything else here. */
	'pow',
	'unpack',

	/* Scope functions. Each expands to a temp binding or an IIFE; they are
	   helpers rather than inline expansions so the emitted text stays readable
	   enough to debug. */
	'let',
	'also',
	'apply',
	'run',
	'takeIf',
	'takeUnless',
	'runCatching',

	/* Coroutines, flattened. The sandbox is single-threaded, so a dispatcher is
	   a no-op and `awaitAll` is `Promise.all`. `synchronized` is the same fact
	   said about locks: one thread, so the block is the whole of it. */
	'awaitAll',
	'async',
	'synchronized',

	/* Regex. Kotlin's `Regex` is `java.util.regex`, which has possessive
	   quantifiers and lookbehind — the latter forbidden by `ABI.md` §6. The
	   translation refuses what it cannot express rather than emitting a pattern
	   that throws on one engine and not another. */
	'regex',
	'groupValues',
	'destructured',

	/* Serialization. A `@Serializable` class becomes a field descriptor, not a
	   class: `@SerialName` renames and declared defaults fill absent keys. */
	'decode',

	/* Preferences. `pref` is the read — one helper for all four getters,
	   because what separates them is the type of the answer and the call
	   site's fallback already states it. `prefs` is the store itself, which
	   `by getPreferencesLazy()` resolves to and `.edit()` is reached through. */
	'pref',
	'prefs',

	/* jsoup's `Elements`, which `shims/dom.ts` deliberately does not model:
	   `select()` there returns a bare array, and scraper code calls `.text()`
	   and `.attr()` on the collection itself. */
	'els',

	/* Property backing. A Kotlin `val` initialiser runs once; a JavaScript
	   getter runs on every read, and `val client = ...newBuilder().build()`
	   read twice is two clients. `lazy` is also what `by lazy` becomes. */
	'lazy',

	/* Safe call onto a helper. `a?.substringAfter("x")` cannot use JavaScript's
	   own `?.`, because the helper takes the receiver as its first argument and
	   would be handed the null. Emitting a conditional instead would evaluate
	   the receiver twice. */
	'sc',

	/* Types. `is`, `as` and `as?` against a runtime with no classes to ask;
	   `cast` throws where `castOrNull` yields null, as Kotlin does. */
	'isType',
	'cast',
	'castOrNull',

	/* Collection construction. `listOf` is not `[...]`: a converted list is
	   the same shape the collection helpers above expect, and `mutableListOf`
	   has `add`, which a JavaScript array does not. */
	'listOf',
	'byteArray',
	'mutableListOf',
	'mapOf',
	'mutableMapOf',
	'setOf',
	'add',
	'addAll',
	'remove',
	'size',
	'flatten',
	'mapIndexed',
	'getOrNull',
	'getOrDefault',
	'getOrElse',
	'to',

	/* Ranges. `for (i in 1..n)` and `0 until n` are objects in Kotlin and
	   nothing at all in JavaScript. */
	'range',
	'until',
	'downTo',

	/* The environment the host supplies, reached through extension functions
	   rather than through methods: `"…".toHttpUrl()`, `response.asJsoup()`,
	   `call.await()`. Each is an extension on a type the runtime owns, so none
	   of them can be a method without patching a prototype. */
	'httpUrl',
	'asJsoup',
	'await',
	/* `call.execute()` and `call.awaitSuccess()`, both of which suspend. */
	'executeCall',
	'awaitSuccess',

	/* Throwing. `error("…")` is Kotlin's, and an extension that throws a plain
	   exception should surface as a plugin error rather than as a refusal. */
	'error',

	/* `orEmpty()` on a null list or string, and the `response.body.string()`
	   shorthand this ecosystem writes as `bodyString()`. */
	'orEmpty',
	'bodyString',

	/* This ecosystem's own `parallelCatchingFlatMap`: map or flat-map a list,
	   **skipping** any element whose lambda threw. The skipping is the whole
	   point — a page with one dead mirror should lose that mirror, not the
	   page — so it cannot be flattened onto `map`. Concurrency is dropped;
	   the sandbox has one thread. */
	'catchingMap',
	'catchingFlatMap',

	/* jsoup's `Elements.eachText()` / `eachAttr()`, which return every match's
	   text at once — the shortcut scraper code reaches for instead of a `map`. */
	'eachText',
	'eachAttr',

	/* `filterIsInstance<T>()`, which is `filter` plus the type test `isType`
	   already performs. */
	'filterIsInstance',

	/* `buildString { append(…) }`: the block is called with a string
	   accumulator as its receiver, and the accumulated text comes back. */
	'buildString',

	/* Chars. Kotlin's `Char` is a type this runtime models as a one-character
	   string, and every one of these is Unicode-wide where the obvious ASCII
	   spelling is not — `isDigit()` is every `Nd`, not `'0'..'9'`. */
	'isDigit',
	'isLetter',
	'isLetterOrDigit',
	'isWhitespace',
	'digitToInt',
	'titlecase',
	'replaceFirstChar',

	/* More strings. `String(bytes)` is a *decode*: JavaScript's `String()` on a
	   byte array answers '104,101,...', which is a string, so nothing errors
	   and the value is nonsense. `replaceFirst` replaces one where `replace`
	   replaces all, and `equalsTo` is structural where `===` is identity. */
	'stringOf',
	'toByteArray',
	'decodeToString',
	'toCharArray',
	'contentEquals',
	'equalsTo',
	'compareTo',
	'replaceFirst',
	'repeat',
	'lines',

	/* More numbers, each of which rounds or clamps the way Kotlin does rather
	   than the way the nearest `Math` call would. */
	'roundToInt',
	'coerceAtLeast',
	'coerceAtMost',
	'coerceIn',
	'minus',
	'not',

	/* More collections. `distinctBy` keeps the first of each key, `single`
	   throws unless there is exactly one, and `random` picks an element rather
	   than answering a float. */
	'distinctBy',
	'sortedWith',
	'sorted',
	'sortedDescending',
	'compareBy',
	'compareByDescending',
	'thenBy',
	'thenByDescending',
	'asSequence',
	'asReversed',
	'forEachIndexed',
	'mapIndexedNotNull',
	'filterIndexed',
	'firstNotNullOfOrNull',
	'onEach',
	'indexOfLast',
	'single',
	'singleOrNull',
	'subList',
	'slice',
	'dropLast',
	'takeLast',
	'takeWhile',
	'dropWhile',
	'minOrNull',
	'maxOrNull',
	'minOfOrNull',
	'maxOfOrNull',
	'minByOrNull',
	'maxByOrNull',
	'reduce',
	'fold',
	'random',
	'removeAll',

	/* `runCatching`'s Result past `getOrNull()`. `onFailure` answers the same
	   Result so the chain after it keeps working. */
	'onFailure',
	'onSuccess',

	/* The shapes this ecosystem builds by hand, and the date helper keiyoushi
	   adds to `SimpleDateFormat`. */
	'triple',
	'stringBuilder',
	'dateOf',
	'tryParse',

	/* Request bodies. `__bodyOf` already understands the shape; these two build
	   it from the extension's own side. */
	'toMediaType',
	'toRequestBody',
	'toJsonBody',
	'toJsonRequestBody',

	/* jsoup's `closest()` and `ownerDocument()`, the two calls that go up rather
	   than down — `shims/dom.ts` defines them and these reach them. */
	'closest',
	'ownerDocument',

	/* `Throwable.printStackTrace()`, which is what `onFailure { … }` almost
	   always contains. It logs; it must not rethrow. */
	'printStackTrace',

	/* The builders whose block is handed a receiver, like `buildString`. The
	   accumulator arrives as `this`, and what comes back is the thing built —
	   not the block's own last value, which for `buildList { add(a) }` is the
	   boolean `add` answered. */
	'buildList',
	'buildMap',
	'buildJsonObject',
	'buildJsonArray',
	'jsonArrayOf',
	'jsonPrimitiveOf',

	/* `require(x) { "…" }`, which throws where a boolean would let an empty
	   page through and report a source with nothing on it. */
	'require',
	'requireNotNull',

	/* `Int.toChar()` and `Char(code)`: the character AT that code, where
	   `String(n)` would answer the digits of the number. */
	'toChar',

	/* The bare `repeat(n) { … }`, which is a loop — the same name Kotlin gives
	   `String.repeat`, and a different function. */
	'repeatBlock',
	'randomOrNull',

	/* `AnimeFilter.Sort.Selection(index, ascending)`, and the `isDefault()`
	   this ecosystem declares identically on every Select filter. */
	'selection',
	'isDefault',

	/* android's `Uri.getQueryParameter`, which okhttp spells `queryParameter`.
	   Assigned in the http section, where the url parser lives. */
	'getQueryParameter',

	/* `java.net.URI`, which is deliberately NOT okhttp's `HttpUrl`: that one
	   refuses a scheme it does not model, and an extractor testing for `blob:`
	   needs the parse to succeed so it can reject the value itself. */
	'uri',

	/* RFC 3986 reference resolution, over a `URI` or an `HttpUrl`. Joining the
	   strings is not this: `../b` pops a segment and `?q` keeps the path. */
	'resolve',

	/* Kotlin's `trimStart`/`trimEnd` take a vararg of Chars and JavaScript's
	   take none, so a passthrough trims whitespace where the source asked for a
	   delimiter — the same latent bug `trim` had. */
	'trimStart',
	'trimEnd',

	/* org.json, which Android ships and a good part of this ecosystem reads
	   responses with. The values are plain here, so the whole surface is
	   readers: the opt- forms answer a fallback and the get- forms throw. */
	'jsonObject',
	'jsonArray',
	'jsonTokener',
	'optString',
	'optInt',
	'optLong',
	'optDouble',
	'optBoolean',
	'optJSONObject',
	'optJSONArray',
	'getJSONObject',
	'getJSONArray',
	'jsonHas',
	'jsonLength',
	'jsonKeys',
	// The long tail: each of these refused an extension by name while the
	// behaviour it needed was already spelled elsewhere in this runtime.
	'toUrl',
	'digitToChar',
	'isLowerCase',
	'isUpperCase',
	'containsKey',
	'intersect',
	'partition',
	'sortedArray',
	'clearAll',
	'stackTraceToString',
	'lineSequence',
	'arrayList',
	'listOfSize',
	'elementsOf',
	'decodeWith',
	'shape',
	'plusAssign',
	'minusAssign',
	'initialized',
	'decodeHex',
	'decodeHexToString',
	'jsonOpt',
	'jsonGetString',
	'jsonGetInt',
	'jsonGetLong',
	'jsonGetDouble',
	'jsonGetBoolean'
] as const;

export type RuntimeHelper = (typeof RUNTIME_HELPERS)[number];

/**
 * Names the runtime defines at bundle scope, spelled as the Kotlin spells them.
 *
 * These are constructed by the converted code directly, so renaming them would
 * mean rewriting every construction site for no gain.
 */
export const RUNTIME_GLOBALS = [
	'GET',
	'POST',
	'Request',
	'Headers',
	'FormBody',
	'Jsoup',
	'SAnime',
	'SEpisode',
	'Video',
	'Track',
	'AnimeFilter',
	'Json',

	/* `Hoster`, which is where the base class went. An episode now yields
	   hosters and a hoster yields videos; `videoListParse(response)` is the path
	   kept for the extensions that predate the change. An extension written
	   against the current API names this type in its own signatures, so without
	   it the conversion refuses for naming its own return type. */
	'Hoster',

	/* Returned rather than constructed by the host, but a scraper builds them
	   by hand on every list page: `AnimesPage(list, hasNextPage)` is what
	   `popularAnimeParse` returns, and `AnimeFilterList` is what a filter
	   override hands back. Without these two, a fifth of the catalogue refuses
	   for naming its own return type. */
	'AnimesPage',
	'AnimeFilterList',

	/* `Regex(pattern, RegexOption.IGNORE_CASE)`. The options are constants the
	   runtime maps onto flags; a scraper never constructs one. */
	'RegexOption',

	/* Dates. `episodeFromElement` parses an upload date on nearly every list
	   page, and `SimpleDateFormat("dd MMM yyyy", Locale.ENGLISH).parse(text)`
	   is how all of them do it. */
	'SimpleDateFormat',
	'Locale',

	/* `Calendar.getInstance().get(Calendar.YEAR)` builds a year filter on nine
	   extensions, and the field constants are read off the type itself — so it
	   has to be a name the emitter passes through rather than a helper call. */
	'Calendar',

	/* `android.util.Base64`, whose flags are read as `Base64.NO_WRAP` at the
	   call site. Its bytes come from `ctx.text.encode` / `ctx.bytes.toBase64`. */
	'Base64',

	/* `Charsets.UTF_8` / `StandardCharsets.UTF_8`, named as an argument to
	   `String(bytes, …)` and `toByteArray(…)`. UTF-8 is the only one the host
	   offers; the others are declared so that naming one is a named failure
	   rather than a decode that quietly produces mojibake. */
	'Charsets',
	'StandardCharsets',
	'JsonObject',
	'LruCache',
	'Log',
	/* kotlin.random.Random. `SecureRandom` is a different promise and stays
	   refused. */
	'Random',
	/* java.net.URLEncoder/URLDecoder — form encoding, not encodeURIComponent. */
	'URLEncoder',
	'URLDecoder',
	/* java.security.MessageDigest — MD5, SHA-1, SHA-256. A hash is a pure
	   function of its bytes, which is what separates it from javax.crypto. */
	'MessageDigest',
	'ConnectionPool',
	'Mutex',

	/* android's `Uri`, whose `parse(url).getQueryParameter(name)` is the same
	   two operations okhttp spells `toHttpUrl().queryParameter(name)`. A
	   capitalised receiver is passed through rather than refused, so without
	   the name the bundle loads and then dies with `Uri is not defined`. */
	'Uri',

	/* `System.currentTimeMillis()`, the cache-buster in the shared extractor
	   modules. Named for the same reason `Uri` is: the emitter passes a
	   capitalised receiver through, so an absent name is a runtime death rather
	   than a refusal. */
	'System',

	/* `connectTimeout(30, TimeUnit.SECONDS)`. The timeout is the host
	   transport's business and the unit changes nothing here, but the enum has
	   to resolve: one unnameable identifier was refusing an extension whose
	   only other obstacle was the call it sits inside. */
	'TimeUnit',

	/* `java.util.concurrent.atomic`, which shared utility code reaches for to
	   number a request or to record that something has happened once. On one
	   thread they are a mutable box, and the box has to exist: a capitalised
	   receiver is passed through, so an absent name is `AtomicInteger is not
	   defined` at load rather than a refusal. */
	'AtomicInteger',
	'AtomicLong',
	'AtomicBoolean',
	'AtomicReference',

	/* `private val lock = Any()`, which is constructed for one purpose in this
	   ecosystem: something to `synchronized` on. */
	'Any',

	/* `java.lang.Character`'s statics, which an id parser reaches for instead
	   of a regex, and okhttp's `Protocol`, which is only ever an argument to
	   `protocols(…)`. Both are names before they are behaviour: the emitter
	   passes a capitalised receiver through, so an absent one is a
	   `ReferenceError` at run time rather than a refusal. */
	'Character',
	'Protocol',
	'Unpacker',
	'JsUnpacker',
	'Unbaser',

	/* The boxed numeric limits, which this ecosystem reads to mean "last" and
	   "first" in a sort. `Math` is JavaScript's own and is named here so the
	   emitter stops refusing it as a capitalised name nothing declares. */
	'Float',
	'Double',
	'Int',
	'Long',
	'Math',

	/* `java.text.Normalizer` for accent-stripping, `android.text.Html` for a
	   synopsis that arrives as markup, and java.time's instants for an upload
	   date — each of them a name an extension writes and this refused. */
	'Normalizer',
	'Html',
	/* `AnimeFilter.TriState` and `.CheckBox` under the bare names nine sources
	   import them by. */
	'TriState',
	'CheckBox',
	'Instant',
	'OffsetDateTime',
	'ZonedDateTime',
	'LocalDateTime'
] as const;

/** Everything the runtime source must define, for the spec that checks it. */
export function requiredRuntimeNames(): string[] {
	return [...RUNTIME_HELPERS, ...RUNTIME_GLOBALS];
}
