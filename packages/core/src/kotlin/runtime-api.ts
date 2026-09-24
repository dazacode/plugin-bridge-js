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
	/* ByteArray.inputStream() and a source's inputStream(): see the runtime. */
	'inputStream',
	/* A catch clause's type test over the Kotlin type an error carries. */
	'caught',
	'nn',

	/* Numbers. Kotlin `Int` division truncates and `"abc".toInt()` throws where
	   `Number("abc")` is silently NaN — both are wrong-value bugs, not errors. */
	'toIntOrNull',
	'toInt',
	'toFloatOrNull',
	'toFloat',
	'toDouble',
	'toBigDecimal',
	'toBigDecimalOrNull',
	'toLongOrNull',
	'toLong',
	'countLeadingZeroBits',
	'intDiv',
	'bitwiseAnd',
	'bitwiseOr',
	'bitwiseXor',
	'toByte',
	'toUByte',
	'toBoolean',
	'toBooleanStrict',
	'toBooleanStrictOrNull',

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
	/* `indexOf`/`lastIndexOf` called with a named argument — `ignoreCase` —
	   which JavaScript's own would drop. See `KNOWN_SIGNATURES`. */
	'indexOf',
	'lastIndexOf',
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
	/* A call among same-named declarations, resolved when it is made: Kotlin
	   overloads by count and type and a JavaScript class has one slot per
	   name. See `Declared.overloads` in emit.ts. */
	'overload',
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
	'sortBy',
	'sortByDescending',
	'sortWith',
	'sortDescending',
	'getOrPut',
	'buildSet',
	'reversed',
	'distinct',
	'take',
	'drop',
	'joinToString',
	/* The same, with a buffer to append into — see the helper. Every
	   `Keyoapp` extension calls it, which is 18 of one catalogue. */
	'joinTo',
	/* `map` with a destination, same shape as `joinTo`. */
	'mapTo',
	/* The same with no transform: every element added to a collection the
	   caller already holds, and that collection answered. */
	'toCollection',
	/* keiyoushi's readers for a heterogeneous list. `filters.firstInstance<
	   GenreFilter>()` is how every filter panel in the image ecosystem reads
	   the filter it cares about out of the list the host hands back. */
	'firstInstance',
	'firstInstanceOrNull',
	'toList',
	'toSet',
	'toMutableMap',
	'forEach',
	'indexOfFirst',
	'groupBy',
	'associate',
	'associateBy',
	'indices',
	'lastIndex',
	/* kotlinx's JsonElement accessors, read as properties — see `jeObject`. */
	'jeObject',
	'jeArray',
	'jePrimitive',
	'jeNull',
	'jeContent',
	'jeContentOrNull',
	'jeIsString',
	'jeInt',
	'jeIntOrNull',
	'jeLong',
	'jeLongOrNull',
	'jeDouble',
	'jeDoubleOrNull',
	'jeFloat',
	'jeFloatOrNull',
	'jeBoolean',
	'jeBooleanOrNull',
	/* keiyoushi core's shorter spellings of four of them — see
	   `KEIYOUSHI_JSON_PROPERTIES` in `subset.ts`. */
	'jeObj',
	'jeArr',
	'jeString',
	'jeStringOrNull',
	/* An exception built as a value, not thrown — see `exception`. */
	'exception',
	/* MutableList.removeAt/reverse and Map.getValue — see each in the runtime. */
	'padEnd',
	'collectionMin',
	'collectionMax',
	'average',
	'capitalize',
	'runningFold',
	'mapIndexedTo',
	'containsAll',
	'retainAll',
	'replaceAfterLast',
	'windowed',
	'toByteString',
	'toStringWith',
	'findAnyOf',
	'okioDecodeBase64',
	'hashMap',
	'hashSet',
	'component1',
	'component2',
	'component3',
	'component4',
	'component5',
	'removeAt',
	'reverseInPlace',
	'mapGetValue',
	/* keiyoushi's keyed JsonObject readers from core/ — see `jeGetStringOrNull`. */
	'jeGetStringOrNull',
	'jeGetIntOrNull',
	'jeGetLongOrNull',
	'jeGetBooleanOrNull',
	'jeGetArrayOrNull',
	'jeGetObjectOrNull',
	'jeGetArray',
	'jeGetObject',
	/* A Kotlin Map's views and transforms — see `__mapPart` in the runtime. */
	'kKeys',
	'kValues',
	'kEntries',
	'mapValues',
	'mapKeys',
	'filterKeys',
	'filterValues',
	/* Typed decoding: a '@Serializable' class, and a JsonTransformingSerializer. */
	'serial',
	'transforms',
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
	/* A lambda written where a parameter of type `R.() -> T` is expected: its
	   receiver arrives as the first argument, the shape Kotlin itself gives
	   such a value when it is passed where `(R) -> T` is wanted. */
	'receiverLambda',

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
	/* `0 until n step 2`, over the array the three above answer. */
	'step',
	/* The infix `matches`, which Kotlin declares on both sides: `regex
	   matches text` and `text matches regex` mean the same whole-string test. */
	'regexMatches',

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
	/* keiyoushi's `client.get(url)` and its three siblings, which build the
	   request, send it and await it in one suspend call. See `clientVerb`. */
	'okhttp',
	/* keiyoushi core's Next.js Flight and page-data extraction. */
	'extractNextJs',
	'extractNextJsRsc',

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

	/* The error an interceptor's cut-off recovery becomes: the pass-through
	   before it translates, the part that needed a boundary (the WebView's
	   cookie store, a WebView) does not, and reaching it says so by name.
	   See `recoveryCut` in `emit.ts`. */
	'recoveryRefused',

	/* A call a helper class makes back into the source object through a typed
	   property, emitted without an await because the source class did not
	   start out async there — and checked, because that class's emitter can
	   still make it async while emitting. A promise here is a loud error, not
	   a value. See `typedMemberOwner` in `emit.ts`. */
	'notSuspended',

	/* jsoup's `Elements.eachText()` / `eachAttr()`, which return every match's
	   text at once — the shortcut scraper code reaches for instead of a `map`. */
	'eachText',

	/* `Int.inc()`/`dec()` by name, and `groupingBy { }` with `eachCount()`. */
	'inc',
	'dec',
	'groupingBy',
	/* java.text's StringCharacterIterator. */
	'charIterator',
	'eachAttr',

	/* `filterIsInstance<T>()`, which is `filter` plus the type test `isType`
	   already performs. */
	'filterIsInstance',

	/* The body of the `Symbol.hasInstance` an emitted `interface` carries: does
	   this object have the members the interface declares? See
	   `interfaceDeclaration` for why a Kotlin interface becomes a membership
	   test rather than a base class. */
	'hasMembers',

	/* kotlinx's encoder, the direction `decode` already goes: a JsonElement is
	   a plain JavaScript value here, so this is a copy with the `@SerialName`
	   renames put back. See the helper for what it matches on. */
	'toJsonElement',

	/* Kotlin's **non-local return**, which JavaScript has no statement for:
	   `map { x?.let { y ?: return@map null } }` leaves the `map` block from
	   inside the `let` block. `jump` throws a private marker carrying the
	   value, and the callback the label named catches it — `isJump` tells it
	   from a real error and `jumpValue` unwraps it. Emitted only where a jump
	   actually crosses a callback, so nothing else pays for it. */
	'jump',
	'isJump',
	'jumpValue',

	/* `scope.launch { … }`: a block started and not awaited, on a scope that
	   remembers whether a failure has cancelled it. See the helpers. */
	'coroutineScope',
	'launch',

	/* `x ?: throw e` where no statement can hold the `throw`: throws its argument. */
	'raise',

	/* `UUID.randomUUID()`, as the text of a version-4 UUID. */
	'randomUUID',

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
	'comparatorOf',
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
	/* `tryParse`'s replacement. keiyoushi deprecated the name above in favour
	   of `tryParseDate`/`tryParseDateTime`/`tryParseZonedDateTime`, and the
	   catalogue moved: the whole `MangaThemesia` template (112 instances) and
	   every `Keyoapp` one (18) call the new spelling, so being one rename
	   behind refused both templates entirely. */
	/* And its two siblings, which are NOT the same helper: upstream separates
	   them by what the text must carry — a date, a date and a time, or its own
	   offset — and `tryParseZonedDateTime` has to FAIL on a text with no offset
	   so the `?:` chain after it runs. Folding all three onto one reader parsed
	   such a text as UTC and stopped the chain a zone early. */
	'tryParseDate',
	'tryParseDateTime',
	'tryParseZonedDateTime',
	/* kotlin.time: a unit property on a non-literal (`(n * 7).days`), a
	   Duration's `inWhole…` readers, and an Instant's millisecond reading —
	   each dispatched on the receiver, because a Duration is milliseconds here
	   and `Clock.System.now() - d` is already a number. See `kotlin-time.ts`. */
	'durationOf',
	'inWhole',
	'toEpochMilliseconds',
	'toJavaInstant',
	/* keiyoushi's `Element?.textOrNull()` — `text()` with blank read as
	   absent. The same template reads its description through it. */
	'textOrNull',
	'attrOrNull',

	/* Request bodies. `__bodyOf` already understands the shape; these two build
	   it from the extension's own side. */
	'toMediaType',
	'toRequestBody',
	'toJsonBody',
	'toJsonRequestBody',
	/* keiyoushi core's GraphQL helpers (`utils/GraphQL.kt`): the builders, the
	   builder extension and the envelope reader. */
	'graphQLPost',
	'graphQLBody',
	'graphQLGet',
	'appendGraphQLParams',
	'persistedQueryExtension',
	'parseGraphQLAs',
	/* The response-side twin, which an interceptor hands to
	   `response.newBuilder().body(…)` when it replaces what came back. */
	'toResponseBody',

	/* jsoup's `closest()` and `ownerDocument()`, the two calls that go up rather
	   than down — `shims/dom.ts` defines them and these reach them. */
	'closest',
	'ownerDocument',
	/* jsoup's `before(…)`/`after(…)` share their names with java.util.Date's
	   comparisons, and the receiver's type is not known here — the helper
	   asks the value which one it is. */
	'before',
	'after',
	/* `.head()`: okhttp's HEAD method or jsoup's <head>, by the value. */
	'head',

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
	'check',
	'checkNotNull',

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

	/* `java.net.URL`, for its parts: URI's parse with URL's readers, which
	   answer the raw path and '' for a missing host. Assigned in the http
	   section beside `uri`. */
	'javaUrl',

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
	'copyOfRange',
	'clearAll',
	'stackTraceToString',
	'lineSequence',
	'arrayList',
	'listOfSize',
	'elementsOf',
	'decodeWith',
	/* A reified type argument, as the text a decoder reads — see
	   `Emitter.decodeType`. */
	'typeText',
	/* A data class's `copy`, and the record that knows how to answer it. */
	'copy',
	'dataRecord',
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
	'jsonGetBoolean',

	/* The classpath. `__k.classLoader()` answers a loader over the files the
	   conversion fetched from the extension's own repository — see
	   `CLASS_LOADER` in `subset.ts` for the two spellings that reach it, and
	   `__RESOURCES` in the entry point for where the files come from. */
	'classLoader',
	/* java.lang.String.CASE_INSENSITIVE_ORDER, a Comparator — see the runtime. */
	'caseInsensitiveOrder',
	'filterNotNull',
	'maxOf',
	'minOf',
	'reduceIndexed',
	'prependIndent',
	'replaceAll',
	'mapNotNullTo',
	'toMap',
	/* A class's simple name — see `SIMPLE_NAME` in `subset.ts` for the two
	   chains that reach it and why a value only reaches it inside a log line. */
	'simpleName',
	/* A call whose name is both a stdlib helper and a method some converted
	   class declares: the receiver's own method when it has one. See
	   `__k.ownOr` and the helper path of `methodCall` in `emit.ts`. */
	'ownOr',
	/* `.code`: a Char's code unit, or the property of that name on anything
	   else. See `EXTENSION_PROPERTIES` in `subset.ts`. */
	'code',
	/* kotlin.math's free functions, and the free maxOf/minOf; see the table in
	   `subset.ts`. Kept apart from the collection helpers by the prefix. */
	'mathAbs',
	'mathMin',
	'mathMax',
	'mathCeil',
	'mathFloor',
	'mathRound',
	'mathSqrt',
	'mathLog10',
	'mathSign',
	'mathMaxOf',
	'mathMinOf'
] as const;

export type RuntimeHelper = (typeof RUNTIME_HELPERS)[number];

/**
 * The helpers that cannot run before a plugin call has entered.
 *
 * Each reaches `__host()` — the host's `text`, `bytes` or `http` — and `__host`
 * throws when no call is in flight. That matters at exactly one place: a class
 * *property*, which runs inside the constructor, and the driver constructs the
 * extension at module load with no context entered. `emit.ts` defers such a
 * property to a memoised getter for the same reason it already defers one that
 * reads a base member, and this is the list it asks.
 *
 * `val salted = "Salted__".toByteArray(Charsets.UTF_8)` is the measured shape —
 * a constant that happens to need an encoder — and it was 7 of the bundles that
 * converted cleanly and then died on import.
 *
 * Kept honest by `kotlin-runtime.spec.ts`, which calls each one with no context
 * and asserts it throws: a helper that stops needing the host, or a new one that
 * starts, is a name in the wrong list rather than a bundle that dies at load.
 */
export const HOST_BACKED_HELPERS: ReadonlySet<RuntimeHelper> = new Set([
	'contentEquals',
	'decodeHexToString',
	'decodeToString',
	'encodeToString',
	'stringOf',
	'toByteArray',
	'toJsonBody',
	'toRequestBody',
	'toResponseBody',
	'toStringWith',
	'okioDecodeBase64',
	'toByteString',
	'uri'
]);

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
	/* jsoup's statics and its one hand-built node — see `KOTLIN_JSOUP`. */
	'Parser',
	'Entities',
	'TextNode',
	'Evaluator',
	'SAnime',
	'SEpisode',
	'Video',
	'Track',
	/* ext-lib 16's skip markers on a Video. Built and carried; the ABI has no
	   field for them, so nothing a viewer sees depends on them. */
	'TimeStamp',
	'ChapterType',
	'AnimeFilter',
	'Json',

	/* `Hoster`, which is where the base class went. An episode now yields
	   hosters and a hoster yields videos; `videoListParse(response)` is the path
	   kept for the extensions that predate the change. An extension written
	   against the current API names this type in its own signatures, so without
	   it the conversion refuses for naming its own return type. */
	'Hoster',

	/* `Application`, which is how this ecosystem spells "my settings store".

	   It is never used as a context: measured across four repositories, every
	   occurrence is `Injekt.get<Application>().getSharedPreferences("source_$id",
	   MODE_PRIVATE)` or the `by injectLazy()` form of the same thing. The
	   dependency-injection container stays out of reach — `Injekt.get<T>()` for
	   any other `T` is still refused — but the one object it is asked for here
	   is one the runtime already owns.

	   `getSourcePreferences()` was removed in ext-lib 16 and this is the
	   spelling that replaced it, so the count rises as repositories migrate. */
	'Application',

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
	/* The two model types the image ecosystem added after the fork.
	   `UpdateStrategy` is a library-refresh hint carried on a title;
	   `SMangaUpdate` is details and chapters from one request. */
	/* RxJava's one type, as this ecosystem uses it. */
	'Observable',
	'UpdateStrategy',
	/* Aniyomi's spelling of the same library-refresh hint. */
	'AnimeUpdateStrategy',
	'SMangaUpdate',
	/* okhttp's HttpUrl, for `HttpUrl.Builder()` — a url built from nothing.
	   Everything else on it is an instance member the runtime already has. */
	'HttpUrl',
	/* androidx's preference types, as declarations (see `KOTLIN_PREFS`). A
	   plugin never draws them — the manifest's settings are derived from
	   `setupPreferenceScreen` before packaging — but a helper that builds one
	   is ordinary code: MangaThemesia's `MangaThemesiaPaidChapterHelper`
	   constructs a `SwitchPreferenceCompat` in a member the template's own
	   screen calls, and every instance refused on that constructor while the
	   runtime already defined the type. Running one records its default,
	   which is the one thing it does here. */
	'PreferenceCategory',
	'SwitchPreferenceCompat',
	'SwitchPreference',
	'CheckBoxPreference',
	'EditTextPreference',
	'ListPreference',
	'DropDownPreference',
	'MultiSelectListPreference',
	'SeekBarPreference',
	'SimpleDateFormat',
	/* The `java.time` formatter the same helpers are called on —
	   `DateTimeFormatter.ofPattern("yyyy-MM-dd").tryParseDate(date)`. Shimmed
	   onto the pattern reader `SimpleDateFormat` already has rather than a
	   second one: the two pattern languages agree on everything a scraper
	   writes, and disagreeing about a letter nobody uses is cheaper than
	   maintaining two parsers. */
	'DateTimeFormatter',
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
	/* `SoftReference(map)` / `WeakReference(x)`, then `.get()`. See the runtime
	   for why holding the value strongly is exact rather than approximate. */
	'SoftReference',
	'WeakReference',
	'Log',
	/* kotlin.random.Random, which is `Math.random` and promises nothing. Its
	   neighbour `SecureRandom` is the one that does, and is separate below. */
	'Random',
	/* java.util.Arrays, reached statically the way Java spells it. Named for the
	   reason `Uri` and `System` are: a capitalised receiver is passed through,
	   so an absent name is a death in the sandbox rather than a refusal here. */
	'Arrays',
	/* okhttp's `Interceptor`, named as a supertype or as a type argument. The
	   runtime calls `intercept` by name — see `__proceed` — so the value here
	   carries no behaviour and exists so that naming the type resolves. */
	'Interceptor',
	/* okhttp's `CacheControl`, named as the third argument of `GET`. Carried
	   rather than refused; see the value for why. */
	'CacheControl',
	/* keiyoushi.utils.commonEmptyHeaders — the default `headers` of the shared
	   extractor modules' constructors. A lowercase name the emitter would
	   otherwise read as a member of the source, which is undefined. */
	'commonEmptyHeaders',
	/* `TimeZone.getTimeZone("UTC")`, which 115 sources set on a date format,
	   and `Regex.escape(literal)`, which is the companion rather than the
	   constructor. Both are capitalised receivers the emitter passes through, so
	   an absent name is a death at load rather than a refusal. */
	'TimeZone',
	'Regex',
	/* java.net.URLEncoder/URLDecoder — form encoding, not encodeURIComponent. */
	'URLEncoder',
	'URLDecoder',
	/* java.security.MessageDigest — MD5, SHA-1, SHA-256. A hash is a pure
	   function of its bytes, so it is computed in the runtime itself and stays
	   synchronous; everything below has a key and cannot be. */
	'MessageDigest',

	/* javax.crypto and the keyed half of java.security, answered by
	   `ctx.crypto` (ABI.md §2) rather than implemented in the bundle. Each is a
	   name an extension writes at a construction site — `SecretKeySpec(key,
	   "AES")`, `SecureRandom()` — so it has to be a bundle-scope name rather
	   than a `__k` helper, exactly as `Base64` and `MessageDigest` are.

	   The operations that touch a key are asynchronous, because `crypto.subtle`
	   is: see `AWAITED_HOST_METHODS` in `subset.ts` for the four method names
	   the emitter awaits, and `cryptoObstacle` for the algorithms that are
	   still refused by name because WebCrypto does not have them. */
	'SecureRandom',
	'SecretKeySpec',
	'IvParameterSpec',
	'GCMParameterSpec',
	'ECGenParameterSpec',
	'Cipher',
	'Mac',
	'Signature',
	'KeyPairGenerator',
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
	// `lib/synchrony`'s deobfuscator, answered by the script the bundle embeds
	// from the extension's own repository (`shims/synchrony.ts`).
	'SynchronyEngine',
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

	/* The manga half. `SManga`, `Filter` and `FilterList` are the names the
	   video ecosystem renamed rather than changed, and the runtime aliases
	   them for that reason; `SChapter`, `Page` and `MangasPage` are its own.

	   These were the top of the refusal list the first time the translator was
	   run over a manga catalogue: `MangasPage(…)`, `SManga` and `Page(…)`
	   between them accounted for more blocked members than every genuinely
	   hard construct put together. Nothing about the front-end needed to
	   change — it refuses a name it has never been told about, and these are
	   the names. */
	'SManga',
	'SChapter',
	'Page',
	'MangasPage',
	'Filter',
	'FilterList',
	/* The nested filter types, under the bare names an
	   `import …model.Filter.Select` produces — the same reason `TriState` and
	   `CheckBox` are spelled out above. */
	'Select',
	'Text',
	'Group',
	'Sort',
	'Header',
	'Separator',
	'Instant',
	'OffsetDateTime',
	'ZonedDateTime',
	'LocalDateTime',
	/* okhttp's MultipartBody: `MultipartBody.Builder().setType(MultipartBody
	   .FORM)` reads a constant off the type, so it has to be a name. */
	'MultipartBody',
	/* The rest of the java.time subset `kotlin-time.ts` implements, and
	   kotlin.time's `Clock` and `Duration`. Each is a capitalised receiver the
	   emitter passes through — `ZoneId.of(…)` in a property initialiser died at
	   load as `ZoneId is not defined` in six bundles that had refused nothing. */
	'LocalDate',
	'ZoneId',
	'ZoneOffset',
	'ChronoUnit',
	'ChronoField',
	/* `DateTimeFormatterBuilder().appendPattern(…).parseDefaulting(YEAR, …)
	   .toFormatter(locale)` — a pattern whose text leaves the year out. */
	'DateTimeFormatterBuilder',
	/* java.nio's Charset by name — `defaultCharset()` is Android's UTF-8. */
	'Charset',
	'DayOfWeek',
	'Month',
	'TextStyle',
	'Year',
	'Clock',
	'Duration',

	/* `keiyoushi.lib.i18n.Intl`, which is one small Kotlin file in the shared
	   `lib/` directory and the largest single blocker the manga half had: 95 of
	   300 measured listings refused on something inside it. It reads its
	   strings out of a `.properties` file with `PropertyResourceBundle`, wraps
	   the byte stream in an `InputStreamReader`, and sorts with a `Collator`.
	   Each is a capitalised receiver the emitter passes through, so an absent
	   name is a death at load with nothing refused — which is why they are
	   declared here rather than left to translate and fail. */
	'PropertyResourceBundle',
	'InputStreamReader',
	'Collator',

	/* kotlinx.serialization's names a hand-written KSerializer declares, and
	   JsonNull, which is JSON's null — see the typed decoder in the runtime. */
	'PrimitiveSerialDescriptor',
	'PrimitiveKind',
	'JsonNull',

	/* okhttp's Credentials.basic, a Basic `Authorization` header value. */
	'Credentials',

	/* java.math.BigDecimal over a BigInt, and the rounding modes it divides
	   with. */
	'BigDecimal',
	'RoundingMode',

	/* java.io.File, as far as `File.createTempFile` goes: see `JSOUP_STATICS`. */
	'File',

	/* A local HTTP server with no port. An extension that extends NanoHTTPD
	   gets a server the runtime registers under a stand-in port and answers
	   in-realm: a request the plugin itself makes to that origin runs the
	   extension's own `handle`/`serve`, and a stream url addressing it is
	   reported as plugin-served rather than handed to a player that could not
	   reach it. The response factories are imported bare
	   (`import …Response.newFixedLengthResponse`), `Status` is its enum, and
	   `MIME_PLAINTEXT` and `SOCKET_READ_TIMEOUT` are statics a subclass reads
	   without qualifying — `init { start(SOCKET_READ_TIMEOUT, true) }`. */
	'NanoHTTPD',
	'newFixedLengthResponse',
	'newChunkedResponse',
	'Status',
	'MIME_PLAINTEXT',
	'SOCKET_READ_TIMEOUT',
	/* okio's ForwardingSource, the base a byte-transforming Source extends,
	   and its Buffer, the scratch space one reads a chunk into. */
	'ForwardingSource',
	'Buffer',
	/* java.io's two byte streams, which a server builds a body out of. */
	'ByteArrayInputStream',
	'ByteArrayOutputStream',
	/* `OkHttpClient()` and `OkHttpClient.Builder()`: a client made from
	   nothing, which here is the same client as `network.client`. */
	'OkHttpClient'
] as const;

/** Everything the runtime source must define, for the spec that checks it. */
export function requiredRuntimeNames(): string[] {
	return [...RUNTIME_HELPERS, ...RUNTIME_GLOBALS];
}
