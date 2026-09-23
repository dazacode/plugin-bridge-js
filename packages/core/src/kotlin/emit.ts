/**
 * Kotlin, lowered onto the host's runtime — and members named rather than
 * half-translated when it cannot be done.
 *
 * ## What this is translating, and why source-to-source is the right shape
 *
 * An Aniyomi extension ships as an APK, but it is *built* from public Kotlin
 * (`FOREIGN.md` §4.1.1), and what that Kotlin says is small: build a request,
 * walk the response. The host already owns the network, the sandbox, the proxy
 * and playback, so the only thing missing is the request-and-parse layer. This
 * file lowers that layer onto `__k` — nothing here tries to be a Kotlin
 * compiler, and the moment one is needed the answer is the interpreter §4.1
 * calls the fallback, not more of this.
 *
 * The previous approach — reading constants out of the source and pouring them
 * into hand-ported templates — converted **1 extension in 254** (§4.1.4),
 * because the median extension rewrites its template's methods rather than
 * configuring them. The eight families that blocked it are all method *bodies*:
 * `videoListParse`, `popularAnimeRequest`, `searchAnimeRequest`,
 * `getVideoList`, `animeDetailsParse`, `episodeListParse`,
 * `episodeFromElement`, `latestUpdatesRequest`. Translating bodies is the only
 * thing that moves that number, and a survey of the catalogue says the
 * constructs in them are mainstream: calls, navigation, lambdas, string
 * interpolation, `if`/`when`/elvis. Nothing exotic, and only about seventy
 * distinct node kinds in the whole corpus.
 *
 * ## The invariant, which is the whole file
 *
 * `reader.ts` never drops a member: it either resolves one or names it in
 * `unreadableOverrides`. This is that rule one level down, and it has four
 * parts, each of which exists because of a specific way a converter lies:
 *
 * 1. **Every node reaches a handler.** `expr` and `stmt` end in a `default:`
 *    that records the node's kind and abandons the member. An emitter whose
 *    `default:` returns `''` produces a body that runs and is wrong.
 * 2. **A member translates fully or is refused by name.** `scanObstacles` runs
 *    over the whole member subtree *before* a line is emitted, so a refusal can
 *    list three problems instead of the first one, and so there is never a
 *    partial body. Half a `videoListParse` is a plugin that installs, searches,
 *    and plays the wrong file.
 * 3. **A refused override never falls back to the base class.** The emitted
 *    class extends nothing. Whether an override replaced the base behaviour or
 *    added to it is not knowable from the subclass, so inheriting is a guess
 *    with a silent failure mode. This is also why `super.` is refused.
 * 4. **An `ERROR` or `MISSING` node refuses its member; one in a class header
 *    refuses the file.** tree-sitter is error-*tolerant*: it recovers by
 *    guessing and a recovered subtree looks structurally fine. A selector read
 *    out of a guess is a wrong selector, not a missing one.
 *
 * ## Shapes chosen, and what each one costs
 *
 * - **A plain class with a constructor, not class fields.** `ABI.md` §6 pins
 *   the bundle to ES2020 across QuickJS, JavaScriptCore and a browser; class
 *   fields are ES2022. Property initialisers therefore become constructor
 *   assignments, which also gets Kotlin's semantics right for free: a `val`
 *   initialiser runs once, where a getter would re-run
 *   `network.client.newBuilder().build()` on every read.
 * - **`by lazy` becomes `__k.lazy(this, name, …)`**, memoised per instance.
 * - **`apply`/`run` lambdas become `function () {}`**, called with the receiver
 *   as `this`, because the whole idiom is bare assignment to receiver fields.
 *   Reads inside them are the hard part; see `BASE_SOURCE_MEMBERS`, which is
 *   the largest correctness risk in this file and is written down rather than
 *   hidden.
 * - **A non-local `return` inlines the block it is in, or is refused.**
 *   Kotlin's bare `return` inside an inlined lambda returns from the *enclosing
 *   function*; the same text in JavaScript returns from the lambda. Rerouting
 *   it into the lambda would change which value the method produced, silently.
 *   So where the block belongs to a scope function Kotlin itself inlines —
 *   `let`, `use`, `also`, `apply`, `run`, `with`, `forEach`, and the
 *   `runCatching {} .getOrElse {}` pair — and the surrounding position is a
 *   statement, the block is emitted *into* the method and the `return` stays a
 *   real `return`; `return@forEach` becomes `continue` and `return@let` a
 *   labelled `break`. `INLINE_SCOPES` and `lowerScope` are that, and
 *   `crossesBlock` is the gate: a block with no jump leaving it is still
 *   emitted as an ordinary callback. Anywhere else — a `mapNotNull` predicate,
 *   a bare `runCatching` whose `Result` is the value — the refusal stands,
 *   because there is no statement position to inline into and no honest
 *   sentinel that is not a guess. This was the largest single obstacle in the
 *   catalogue, blocking 34 extensions of 254; it now blocks 12.
 * - **`suspend` becomes `async`**, and `await` propagates outward: any frame
 *   that emits an `await` is marked `async`, and a call whose lambda came back
 *   `async` is itself awaited. A `filter` handed an un-awaited promise would
 *   test an always-truthy object and quietly keep every element — the exact
 *   plausible-but-wrong output this whole design is built to avoid.
 * - **`throw UnsupportedOperationException(…)` translates.** It is not an edge
 *   case in this ecosystem; it is how an extension writes down that a member is
 *   unused, and it appears in over half the catalogue. Refusing it would refuse
 *   them for documenting themselves.
 *
 * ## Rule 9
 *
 * No hostname appears here or in this file's spec. The tables are Kotlin,
 * jsoup and okhttp method names, which `FOREIGN.md` §0 permits naming; the
 * fixtures use `example.invalid`.
 */

import { walk, type KNode, type KotlinTree } from './ast';
import {
	AWAITED_HOST_METHODS,
	COMMENT_KINDS,
	DECODING_METHODS,
	EXTENSION_METHODS,
	EXTENSION_PROPERTIES,
	FREE_FUNCTIONS,
	GLOBAL_NAMES,
	JSOUP_STATICS,
	HOST_METHODS,
	RUNTIME_STATIC_REFERENCES,
	HOST_PROPERTY_METHODS,
	KNOWN_SIGNATURES,
	OUT_OF_SCOPE_KINDS,
	RECOVERY_BOUNDARIES,
	swallowedWhenElse,
	SUPER_BASE_PROPERTIES,
	SUPER_MEMBERS,
	SUPER_RECEIVER_MEMBERS,
	SUPER_SUSPEND_MEMBERS,
	BASE_CONSTANTS,
	ARGUMENT_LAMBDA_METHODS,
	CLASS_LOADER,
	SIMPLE_NAME,
	BUILDER_LAMBDA_METHODS,
	TOLERATED_JSON_FLAGS,
	VARARG_OPTIONS,
	VIDEO_V16_ONLY,
	VIDEO_V16_PARAMETERS,
	iterableDelegateOf,
	scanObstacles,
	thrownHelper,
	type Refusal,
	type Untranslatable
} from './subset';
import { HOST_BACKED_HELPERS, type RuntimeHelper } from './runtime-api';

/**
 * One member, and every name its source text mentions.
 *
 * Deliberately **syntactic and over-approximate**: it is every identifier
 * under the member, not the calls the emitter resolved. Three reasons, and
 * all three point the same way.
 *
 * A refused member emits nothing, so a graph built from emission would have
 * no edges out of it — and a member reachable only from a refused one has to
 * count as reachable, because nobody knows what that member would have
 * called had it translated. Reading the text gives those edges anyway.
 *
 * A call through a receiver this build cannot resolve — `extractor.foo(url)`
 * — still mentions `foo`, so `foo` stays reachable. Pruning something that
 * is in fact called does not produce a refusal; it produces `undefined is
 * not a function` inside a sandbox, which is a worse failure than the one it
 * replaced.
 *
 * And a name mentioned in a branch that never runs costs one member kept.
 * The asymmetry is the whole design: over-approximating loses coverage,
 * under-approximating loses correctness.
 */
export interface MemberEdges {
	/** As it appears in `translated` and in a `Refusal`. */
	readonly member: string;
	/** The class or object that declared it, if any. */
	readonly owner: string | null;
	/** True for a property: it runs whenever its owner is constructed. */
	readonly construction: boolean;
	/**
	 * True for a `by lazy` property that overrides nothing.
	 *
	 * Counted as construction above, because reachability over-approximates;
	 * but its initialiser does not in fact run at construction — it runs on
	 * the first read — and nothing outside the Kotlin can read it, the driver
	 * included, since it overrides nothing the driver asks for. `pipeline.ts`
	 * uses this to stop a refused one blocking when no translated code names
	 * it. Absent on members this was never worked out for.
	 */
	readonly lazy?: boolean;
	/** Every identifier under the member, deduplicated. */
	readonly references: readonly string[];
	/** Call targets, with unresolved receivers kept as conservative edges. */
	readonly calls: readonly CallEdge[];
}

export interface CallEdge {
	readonly member: string;
	/** True when the receiver was an invocation or otherwise could not be named. */
	readonly unresolvedReceiver: boolean;
}

/** What one file translated into. */
export interface Emission {
	/** The emitted module body, or `''` when the file was refused outright. */
	readonly js: string;
	readonly className: string | null;
	readonly superClass: string | null;
	/** Members that translated completely, in declaration order. */
	readonly translated: readonly string[];
	readonly refusals: readonly Refusal[];
	/** `__k` helper names the emitted code calls. */
	readonly usedRuntime: readonly string[];
	/** Set when the class header itself could not be read; nothing is emitted. */
	readonly fileRefusal: string | null;
	/**
	 * What each member mentions, translated or not.
	 *
	 * `pipeline.ts` walks this from the members the host actually calls, so a
	 * refusal in a shared file that nothing reachable names stops counting
	 * against the extension that merely sits beside it.
	 */
	readonly graph: readonly MemberEdges[];
	/**
	 * Members that translated with a tail cut off, and what the tail needed.
	 *
	 * Not refusals — the member is in `translated` and the host calls it — and
	 * not silence either: each names the boundary the cut-off part reached for,
	 * so a caller can still say what the converted plugin cannot do. See
	 * `recoveryCut`.
	 */
	readonly deferred: readonly Refusal[];
}

/**
 * Members of the base source class that an `apply {}` body reads rather than
 * writes.
 *
 * Inside `SAnime.create().apply { url = "$baseUrl/x" }` there are two implicit
 * receivers — the `SAnime` and the extension itself — and nothing in the text
 * says which one `baseUrl` belongs to. The rule used here is: **writes go to
 * the receiver, reads go to whichever one declares the name.** Names the
 * extension declares are known exactly, so this list only has to cover the ones
 * it inherits.
 *
 * Deliberately excluded: `name`, `url`, `title`, `description`,
 * `thumbnail_url` and the rest of the model fields, which the source and the
 * model both spell the same way. Those resolve to the receiver, which is right
 * for the `apply` idiom and wrong for the rare body that reads the *source's*
 * own `name`. That is the residual risk, and it produces a wrong string rather
 * than a crash — the kind of failure this file otherwise refuses, kept only
 * because refusing every `apply {}` would refuse most of the catalogue.
 */
const BASE_SOURCE_MEMBERS: ReadonlySet<string> = new Set([
	'baseUrl',
	'lang',
	'client',
	'headers',
	'json',
	'network',
	'preferences',
	'supportsLatest',
	'docHeaders',
	'versionId'
]);

/**
 * Names a source has and a model type does not, for the one exception to
 * `BASE_SOURCE_MEMBERS`'s rule that a model field name read inside `apply {}`
 * is the receiver's.
 *
 * That rule costs a wrong string whenever the body means the *source's* own
 * `name` — `SManga.create().apply { title = "$name ($year)" }` titled every
 * comic of one source "undefined (2026)". Where the receiver is visibly
 * built as a model type (`modelTypeOf`), whether that type has the field is
 * a fact rather than a guess: an `SManga` has a title and no name. Kept to
 * the names and types where it is certain; an `SChapter` *does* have a
 * `name`, and a receiver whose type is not written keeps the old rule.
 */
const MODEL_LACKS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['SManga', new Set(['name', 'id'])],
	['SAnime', new Set(['name', 'id'])]
]);

/**
 * The fields each model type declares — the other half of the same fact.
 *
 * Kotlin resolves an implicit receiver innermost first, so inside
 * `SChapter.create().apply { … }` a bare `name` is the *chapter's* even
 * though every extension also declares its own `name`. `BASE_SOURCE_MEMBERS`'
 * rule sent it to whichever declared it, and the extension always does, so
 * `chapter_number = name.substringAfter("Ch.")` read the source's name.
 * Only used positively: a name listed here is the receiver's; a name missing
 * from it is left to the old rule, so an incomplete list costs nothing new.
 */
const MODEL_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		'SManga',
		new Set([
			'url',
			'title',
			'artist',
			'author',
			'description',
			'genre',
			'status',
			'thumbnail_url',
			'update_strategy',
			'initialized'
		])
	],
	[
		'SAnime',
		new Set([
			'url',
			'title',
			'artist',
			'author',
			'description',
			'genre',
			'status',
			'thumbnail_url',
			'update_strategy',
			'initialized'
		])
	],
	['SChapter', new Set(['url', 'name', 'date_upload', 'chapter_number', 'scanlator'])],
	[
		'SEpisode',
		new Set([
			'url',
			'name',
			'date_upload',
			'episode_number',
			'scanlator',
			'fillermark',
			'summary',
			'preview_url'
		])
	]
]);

/** `SManga.create()` as `SManga`: the model type a receiver expression visibly builds. */
function modelTypeOf(node: KNode): string | null {
	const match = /^(SManga|SAnime|SChapter|SEpisode)\.create\(\)$/.exec(
		node.text.replace(/\s+/g, '')
	);
	return match === null ? null : match[1];
}

/** Reserved in JavaScript, legal in Kotlin. Renamed rather than refused. */
const RESERVED: ReadonlySet<string> = new Set([
	'arguments',
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'eval',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'implements',
	'import',
	'in',
	'instanceof',
	'interface',
	'let',
	'new',
	'null',
	'package',
	'private',
	'protected',
	'public',
	'return',
	'static',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield'
]);

/** Scope functions whose lambda takes the receiver as `this`, not as `it`. */
const RECEIVER_SCOPE: ReadonlySet<string> = new Set(['apply', 'run', 'runCatching']);

/**
 * The free builders, whose block is handed an accumulator as its receiver.
 *
 * `buildJsonObject { put("page", 1) }` writes `put` with no receiver at all,
 * because in Kotlin the block's receiver is the builder. Emitted as an ordinary
 * lambda that bare call fell through to `this.put(…)` — a call on the *source
 * object*, which has no `put` — so every one of these converted cleanly and
 * died at its first use with `this.put is not a function`. The runtime has
 * always called the block with the accumulator as both `this` and its argument
 * (see `__k.buildJsonObject`); this is the emitter agreeing.
 */
const RECEIVER_BUILDERS: ReadonlySet<string> = new Set([
	'buildList',
	'buildSet',
	'buildMap',
	'buildJsonObject',
	'buildJsonArray'
]);

/** Helpers whose result is a promise, so the call site has to await. */
/**
 * The calls that make an ordinary Kotlin `fun` suspend once it is JavaScript.
 *
 * okhttp's three spellings of "send this now". Everything else an extension
 * blocks on reaches the network through one of them.
 */
/** The first segment of a package path, never a name a source declares. */
const PACKAGE_ROOTS: ReadonlySet<string> = new Set(['java', 'javax', 'android', 'okhttp3', 'okio']);

/** `java.net.URLEncoder`, and the other packages written out in full. */
const QUALIFIED_GLOBAL = /^(?:java|javax|kotlin|android|okhttp3|okio|rx)\.[\w.]*?\.?(\w+)$/;

/** `Filter.Sort.Selection` and the video fork's `AnimeFilter.Sort.Selection`. */
const SORT_SELECTION = /^(?:Anime)?Filter\.Sort\.Selection$/;

/** A package path and nothing else: `java.net`, `java.text`, `rx` — lowercase segments. */
const PACKAGE_PATH = /^(?:java|javax|kotlin|android|okhttp3|okio|rx)(?:\.[a-z_][a-z0-9_]*)*$/;

/**
 * `Injekt.get<T>()`, whitespace already squeezed out of the text.
 *
 * Only the no-argument form, because that is the whole of what this ecosystem
 * writes — a keyed `Injekt.get(qualifier)` asks a different question and is
 * left to the refusal.
 */
const INJEKT_GET = /^Injekt\.get<(\w+)>\(\)$/;

/**
 * File annotations that say something to the compiler or the IDE and nothing
 * at run time: warning suppression, an opt-in to an experimental API, and the
 * JVM's name for the file's facade class — which a module has no use for.
 */
const INERT_FILE_ANNOTATION = /^@file:(?:Suppress|OptIn|JvmName|JvmMultifileClass|SuppressLint)\b/;

/**
 * `android.util.Log` at any of its levels, whitespace squeezed out.
 *
 * The runtime's `Log` writes to the host log and returns 0, so what is passed
 * to it is text nobody reads back. That is what licenses `inLogLine`.
 */
const LOG_CALL = /^Log\.(?:v|d|i|w|e|wtf)$/;

/**
 * The calls that make a member `async` whether or not it said `suspend`.
 *
 * `.execute()` blocks in Kotlin and cannot here; the crypto four and an
 * interceptor chain's `.proceed()` are `AWAITED_HOST_METHODS`, which the runtime shim implements over
 * `crypto.subtle` and which are therefore promises. `blockingMembers` reads
 * this off a member's *source text* and propagates to a fixpoint, so a helper
 * that decrypts makes its callers `async` too.
 */
const BLOCKING_CALLS =
	/\.(?:execute|awaitSuccess|await|doFinal|generateKeyPair|verify|proceed)\s*\(|(?<!\bMath)\.sign\s*\(|\bThread\s*\.\s*sleep\s*\(|\b(?:client|[a-z]\w*Client)\s*\.\s*(?:get|post|put|head)\s*\(/;

/** `BLOCKING_CALLS` less `.proceed(`, for a member called from another file. */
const CROSS_FILE_BLOCKING_CALLS = new RegExp(
	BLOCKING_CALLS.source.replace('|verify|proceed)', '|verify)'),
	BLOCKING_CALLS.flags
);
// Derived from the text above, so an edit there must not silently keep
// `proceed` in: fail at load, where it is seen, rather than refuse listings.
if (CROSS_FILE_BLOCKING_CALLS.source === BLOCKING_CALLS.source) {
	throw new Error(
		'CROSS_FILE_BLOCKING_CALLS no longer removes `.proceed(`; update it with BLOCKING_CALLS.'
	);
}

/**
 * keiyoushi's suspend verbs on an okhttp client, and what they are called on.
 *
 * See `clientVerb`. The receiver is read by name because that is all the call
 * site has: the base class's `client`, `network.client`, or a property the
 * extension named for what it is — `apiClient`, `imageClient`,
 * `noRedirectClient`. The runtime checks the value really is a client before
 * sending anything, so the name decides only that the call is awaited.
 */
const CLIENT_VERBS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'head']);
// Any chain of lowercase properties in front of the client, not only
// `network.`: a template's helper class holds the source and requests through
// it — `theme.client.get(url, headers)` — and with the prefix fixed that call
// fell through to a plain `.get(…)` on the runtime client, which has none, so
// every server lookup in the helper threw. `BLOCKING_CALLS` already read the
// same text as a request and made the member async; only the call was missed.
const CLIENT_RECEIVER = /^(?:(?:this|[a-z_]\w*)\.)*(?:client|cloudflareClient|[a-z]\w*Client)$/;
/** Every parameter any overload of the four declares, by the name core/ gives it. */
const CLIENT_VERB_PARAMETERS: ReadonlySet<string> = new Set([
	'url',
	'headers',
	'body',
	'cacheControl',
	'ensureSuccess'
]);

/**
 * The SharedPreferences readers, which share four names with org.json.
 *
 * Told apart by arity at the call site, not here — see the check in
 * `methodCall`.
 */
/**
 * The compound assignments Kotlin routes through a *mutating* operator.
 *
 * `list += x` is `plusAssign` on a `MutableList` and `list = list + x` on a
 * `var`. The distinction is the receiver's mutability, which is why only a
 * `val` takes this path.
 */
const COLLECTION_ASSIGN: ReadonlyMap<string, string> = new Map([
	['+=', 'plusAssign'],
	['-=', 'minusAssign']
]);

const PREFERENCE_GETTERS: ReadonlySet<string> = new Set([
	'getString',
	'getBoolean',
	'getInt',
	'getLong'
]);

/**
 * The same four names, read the org.json way: one argument and no fallback.
 *
 * These THROW where the `opt` forms answer a default, which is the distinction
 * an extension is making when it writes one rather than the other — a `get`
 * says the field is required, and answering undefined there would carry it into
 * a title or a url instead of failing where the data is wrong.
 */
const JSON_GETTERS: ReadonlyMap<string, string> = new Map([
	['getString', 'jsonGetString'],
	['getBoolean', 'jsonGetBoolean'],
	['getInt', 'jsonGetInt'],
	['getLong', 'jsonGetLong'],
	['getDouble', 'jsonGetDouble']
]);

const AWAITING_HELPERS: ReadonlySet<string> = new Set([
	'await',
	'awaitAll',
	'executeCall',
	'awaitSuccess',
	'delay'
]);

/**
 * `kotlin.time` units, as milliseconds.
 *
 * `delay(300.milliseconds)` is how this ecosystem spells a pause, and
 * `300.milliseconds` is a property read on an integer literal — emitted as
 * written it is `300.milliseconds`, which is not JavaScript at all and fails at
 * load with "Invalid or unexpected token".
 *
 * Applied only when the receiver is a literal number. `row.seconds` is a field
 * on somebody's DTO and has to stay one, and the two are indistinguishable by
 * name alone.
 */
const DURATION_UNITS: ReadonlyMap<string, number> = new Map([
	['nanoseconds', 1 / 1_000_000],
	['microseconds', 1 / 1000],
	['milliseconds', 1],
	['seconds', 1000],
	['minutes', 60_000],
	['hours', 3_600_000],
	['days', 86_400_000]
]);

/** `Duration.inWholeSeconds` and its siblings — see `__k.inWhole`. */
const DURATION_READERS: ReadonlySet<string> = new Set([
	'inWholeNanoseconds',
	'inWholeMicroseconds',
	'inWholeMilliseconds',
	'inWholeSeconds',
	'inWholeMinutes',
	'inWholeHours',
	'inWholeDays'
]);

/**
 * `java.util.concurrent.TimeUnit`, as milliseconds.
 *
 * The same table one enum over, and it exists for one caller: `rateLimitPeriod`
 * needs the unit a rate limit was written in, and it needs it *here* — by the
 * time the runtime sees the call the enum is an object with a `toMillis`, and
 * asking that object at run time would be asking after the number it was meant
 * to scale has already been taken for something else. The sub-millisecond two
 * are listed so that a period written in them is refused by its period rather
 * than by its unit being unrecognised.
 */
const TIME_UNITS: ReadonlyMap<string, number> = new Map([
	['NANOSECONDS', 1 / 1_000_000],
	['MICROSECONDS', 1 / 1000],
	['MILLISECONDS', 1],
	['SECONDS', 1000],
	['MINUTES', 60_000],
	['HOURS', 3_600_000],
	['DAYS', 86_400_000]
]);

/**
 * `AnimeFilter` members an extension subclasses, spelled as the runtime spells
 * them.
 *
 * This ecosystem's own idiom is a `UriPartFilter : AnimeFilter.Select<String>`
 * carrying a `toUriPart()`, declared in the extension's own file and named by
 * `searchAnimeRequest` — it is the single most common blocked construct in the
 * catalogue. Listed rather than accepted by prefix so a filter kind the runtime
 * does not define is refused instead of extending `undefined`.
 */
/**
 * Kotlin functions whose block takes **no parameter**, so `it` is not theirs.
 *
 * `element.attr("data-lazy-src").ifEmpty { it.attr("src") }` is the shape:
 * `ifEmpty` takes a `() -> R`, so the `it` inside is still the one the
 * enclosing `let` bound — the image element. Emitted as `(it) => …` the
 * parameter shadowed it with the nothing `ifEmpty` passes, and the browse died
 * with `undefined is not an object (evaluating 'it.attr')`.
 *
 * A list rather than a rule, for the reason the rest of this file keeps lists:
 * the alternative is deciding by whether the body happens to mention `it`,
 * which guesses in exactly the cases that matter.
 */
const NO_BLOCK_PARAMETER: ReadonlySet<string> = new Set([
	'ifEmpty',
	'ifBlank',
	'getOrPut',
	'lazy',
	'synchronized',
	'check',
	'require',
	'requireNotNull',
	'runCatching',
	'measureTimeMillis'
]);

/**
 * Helpers whose reified type argument is the point of the call.
 *
 * Each takes the type as its last parameter, and without one answers
 * something other than what was asked: `filterIsInstance` everything, and
 * `firstInstance`/`firstInstanceOrNull` nothing — the filter a search reads
 * its sort from came back null, so `firstInstanceOrNull<SortFilter>()?.state
 * = 1` set nothing and `firstInstance<OrderFilter>().value` threw on a list
 * that held one. A dropped type is a wrong value either way.
 */
const TYPED_HELPERS: ReadonlySet<string> = new Set([
	'filterIsInstance',
	'firstInstance',
	'firstInstanceOrNull'
]);

const ANIME_FILTER_KINDS: ReadonlySet<string> = new Set([
	'Header',
	'Separator',
	'Select',
	'Text',
	'CheckBox',
	'TriState',
	'Group',
	'Sort'
]);

/**
 * Binary operator tokens, by the node kind the grammar gives them.
 *
 * Looked up by kind rather than by position, because `ast.ts` wraps each raw
 * node afresh on every access: two reads of the same child are two objects, and
 * identity comparison between `children` and `allChildren` silently picks the
 * wrong node.
 */
const BINARY_TOKENS: ReadonlySet<string> = new Set([
	'+',
	'-',
	'*',
	'/',
	'%',
	'<',
	'>',
	'<=',
	'>=',
	'==',
	'!=',
	'===',
	'!==',
	'&&',
	'||'
]);

/**
 * Where a value-producing construct puts its value.
 *
 * `null` drops it (statement position), `'return'` returns it, and a target
 * assigns it. See `deliver` for why this exists rather than an IIFE.
 */
type Sink = null | 'return' | { readonly target: string };

/** Kinds that are Kotlin expressions and JavaScript statements. */
const DELIVERABLE: ReadonlySet<string> = new Set([
	'if_expression',
	'when_expression',
	'try_expression'
]);

/**
 * Kotlin's inlining scope functions, and what each one's block means.
 *
 * These are the functions whose block Kotlin *inlines into the caller*, which
 * is why a bare `return` inside one returns from the enclosing function. This
 * emitter can reproduce that only by inlining too, so this table says what an
 * inlined block binds and what the construct's value then is.
 *
 * `forEach` is the loop of the set: `for…of` is the only translation under
 * which `return` returns from the member and `return@forEach` skips an element.
 *
 * The measured shapes this covers, across one 254-extension catalogue's 133
 * non-local returns: `let` 42, `use` 24, `run` 9, `forEach` 9, `apply` 2,
 * `also` and `with` in ones. What it deliberately leaves refused is below.
 */
const INLINE_SCOPES: ReadonlyMap<
	string,
	{
		readonly receiver: boolean;
		readonly yields: 'block' | 'subject';
		readonly loop: boolean;
	}
> = new Map([
	['let', { receiver: false, yields: 'block', loop: false }],
	// `use` closes a resource and yields the block's value; the shim has nothing
	// to close, so it is `let` with a different name — the same reading
	// `EXTENSION_METHODS` already takes.
	['use', { receiver: false, yields: 'block', loop: false }],
	['also', { receiver: false, yields: 'subject', loop: false }],
	['apply', { receiver: true, yields: 'subject', loop: false }],
	['run', { receiver: true, yields: 'block', loop: false }],
	['forEach', { receiver: false, yields: 'subject', loop: true }]
]);

/**
 * The `Result` accessors that make `runCatching { … }` a `try`/`catch`.
 *
 * Each pairs the block with one thing to do when it throws, and each of those
 * is a `catch` clause — which is why the pair is read as one construct rather
 * than as a block that has to produce a `Result` object for a second call to
 * unwrap. `onSuccess`/`onFailure` are absent: they answer with the `Result`
 * itself, so they are not this shape.
 */
const RECOVERIES: ReadonlySet<string> = new Set([
	'getOrElse',
	'getOrNull',
	'getOrDefault',
	'getOrThrow'
]);

/** `runCatching { … }` and the accessor that says what a failure becomes. */
interface Recoverable {
	readonly attempt: KNode;
	/** `getOrElse { … }`'s block. */
	readonly recover: KNode | null;
	/** `getOrDefault(x)`'s value. */
	readonly fallback: KNode | null;
	/** `getOrThrow()`, which has no `catch` at all. */
	readonly rethrows: boolean;
}

/** One scope-function call, as `lowerScope` needs to read it. */
interface Inlinable {
	readonly name: string;
	/** What the block runs on, or null for a bare `run { … }`. */
	readonly subject: KNode | null;
	/** True for `?.let { … }`, where a null receiver skips the block. */
	readonly safe: boolean;
	readonly lambda: KNode;
	/** True when `this` inside the block is the subject rather than a parameter. */
	readonly receiverForm: boolean;
	/** Whether the construct answers with the block's value or the subject's. */
	readonly yields: 'block' | 'subject';
	readonly loop: boolean;
	/** Kotlin's implicit label, which is the function's own name. */
	readonly label: string;
}

/** Thrown to abandon a member the moment it stops being translatable. */
class Refused extends Error {}

/**
 * One name bound in a scope, and whether Kotlin would let it be assigned.
 *
 * The mutability is not decoration: it is what decides where a bare write
 * inside an `apply {}` lands. See `assignable`.
 */
interface Local {
	readonly text: string;
	readonly mutable: boolean;
	/**
	 * Set on a parameter typed `R.(…) -> T`: how many arguments it takes
	 * *besides* its receiver. See `invokeReceiverLocal`.
	 */
	readonly receiverArity?: number;
	/** On such a parameter: whether its type is `suspend`, so a call is awaited. */
	readonly receiverSuspends?: boolean;
	/**
	 * Set on a parameter declared with a type that has no `invoke` — see
	 * `VALUE_ONLY_TYPES`. Kotlin resolves `name(…)` to a local only when the
	 * local can be invoked, so a call through this name is a member's.
	 */
	readonly valueOnly?: boolean;
}

/**
 * Parameter types that cannot be called, so `name(…)` never means the parameter.
 *
 * keiyoushi's `fetchMangaUpdate(manga, chapters, fetchDetails: Boolean,
 * fetchChapters: Boolean)` is overridden by Madara and others, and its body
 * calls the source's own `fetchChapters(path, id)` with the Boolean in scope.
 * Kotlin resolves that to the member, because a Boolean has no `invoke`;
 * emitted as a bare call it called the Boolean — "fetchChapters is not a
 * function" on the first library refresh, with nothing refused. Only the
 * standard library's value types are listed: a user type could declare an
 * `operator fun invoke`, and a function type obviously can.
 */
const VALUE_ONLY_TYPES: ReadonlySet<string> = new Set([
	'Boolean',
	'String',
	'Int',
	'Long',
	'Short',
	'Byte',
	'Float',
	'Double',
	'Char'
]);

/** One `function`-ish emission in progress. */
interface Frame {
	/**
	 * `function` and `receiver` rebind `this`; `lambda` (an arrow) does not.
	 *
	 * `inline` is the fourth and the odd one: a Kotlin block emitted *into* its
	 * caller's own JavaScript function rather than as a callback, so that a
	 * `return` written inside it is the enclosing function's `return`, which is
	 * what Kotlin meant. See `lowerScope`. Nothing about JavaScript's `this`
	 * changes across one, which is why every question below skips it.
	 */
	readonly kind: 'function' | 'receiver' | 'lambda' | 'inline';
	/** For `return@label`. */
	readonly label: string | null;
	usesAwait: boolean;
	usesSelf: boolean;
	/** On an `inline` frame: how the block's own receiver is spelled, if it has one. */
	readonly alias?: string | null;
	/**
	 * On a receiver block: the model type its receiver was built as, when the
	 * text says so — `SManga.create().apply { … }`. See `MODEL_LACKS`.
	 */
	readonly model?: string | null;
	/** On an `inline` frame: where the block's value goes, for `return@label`. */
	readonly sink?: Sink;
	/** On an `inline` frame: the JavaScript label a `return@label` leaves by. */
	readonly exit?: string;
	/** On an `inline` frame: true when it is a loop, so `return@label` continues. */
	readonly loop?: boolean;
	/** Set when a `return@label` actually used `exit`, so the label is emitted. */
	broke?: boolean;
	/**
	 * This callback's identity, for a `return@label` written inside a *nested*
	 * callback — Kotlin's non-local return, which JavaScript has no statement
	 * for. Assigned on first use and answered by a `try`/`catch` around this
	 * frame's body; see `nonLocalTarget`.
	 */
	jumpId?: number;
	/** Set when a non-local jump actually named this frame, so the catch is emitted. */
	catchesJump?: boolean;
	/**
	 * On a `receiver` frame: the `const` its `this` is captured in, set when a
	 * `this@label` from inside a *nested* receiver block named it. The inner
	 * `function () {}` has rebound `this`, so the outer one's has to be held
	 * the way `__self` holds the source's. See `labelledThis`.
	 */
	capture?: string;
}

interface Emitted {
	readonly text: string;
	readonly isAsync: boolean;
	readonly usesSelf: boolean;
}

/** One statement being emitted, and the `?: return` guards hoisted in front of it. */
interface GuardFrame {
	/**
	 * The guards under this statement that may move to statement level.
	 *
	 * Decided by identity over the parse tree, which holds because every node
	 * the emitter reaches comes from the memoised `children`/`allChildren` of
	 * the node above it — the same object the pre-walk saw.
	 */
	readonly hoistable: ReadonlySet<KNode>;
	/** Emitted guards, in evaluation order, to be placed before the statement. */
	readonly lines: string[];
}

/**
 * Translates one parsed file.
 *
 * `tree.hasError` is not by itself fatal: a survey of the catalogue found a
 * recovered node somewhere in about one file in twenty, usually in a member
 * nothing needs. The error is fatal to whichever member contains it, and to the
 * file only when it sits in a class header.
 */
export function emitKotlin(
	tree: KotlinTree,
	neighbours: Declared = EMPTY_DECLARED,
	/**
	 * Names this file writes out under a different one.
	 *
	 * Only ever what the file itself declares and the runtime already defines
	 * — `Video`, `Track`, `SAnime`. See `Emitter.safe` and the caller that
	 * works out which files a rename applies to.
	 */
	renames: ReadonlyMap<string, string> = new Map(),
	/**
	 * Whether this is the extension's *own* first file.
	 *
	 * The class that claims to be the extension is normally the one that
	 * constructs a base this build does not supply — an Aniyomi source class
	 * extending `ParsedAnimeHttpSource`. That rule breaks on a multisrc theme:
	 * `class Example : WcoTheme()` resolves its base, because the theme is a
	 * neighbouring file this build *does* convert, so the concrete extension
	 * declined the name and the abstract theme took it. The driver then built
	 * the theme, and every `baseUrl` the theme reads was the one the subclass
	 * never got to set — `undefined/search`.
	 *
	 * The adapter already knows which file is the extension: it sorts the
	 * class named by `build.gradle`'s `extClass` first. This carries that fact
	 * the one step further it needed to travel.
	 */
	entryFile = false,
	/**
	 * Names this file's own *declaration* is written under where its
	 * references are renamed — a class named after the class it imports and
	 * extends. See `keepsDeclaration` in `pipeline.ts`.
	 */
	declaredAs: ReadonlyMap<string, string> = new Map()
): Emission {
	return new Emitter(neighbours, renames, entryFile, declaredAs).file(tree.root);
}

/**
 * The types and methods one file declares, for the files beside it.
 *
 * An extension's filters live in `SomethingFilters.kt` and are named from
 * `Something.kt`: `params.getQuery()` is a method on a class one file over, and
 * a per-file emitter has no way to tell that from a call on a shim that has
 * never heard of it. Collecting the declarations across every file first is
 * what makes the difference visible, and it costs one extra walk of a tree
 * already parsed.
 */
export interface Declared {
	readonly types: ReadonlySet<string>;
	readonly methods: ReadonlySet<string>;
	readonly suspends: ReadonlySet<string>;
	/** The subset of `types` that needs `new` at a construction site. */
	readonly newable: ReadonlySet<string>;
	/** Parameter names for declarations whose calls can be resolved across files. */
	readonly signatures: ReadonlyMap<string, readonly string[]>;
	/**
	 * Every member name each class declares directly, and what each class
	 * extends — together, the class hierarchy across the whole unit.
	 *
	 * Both exist for one question, asked at a `super.` call: **is this
	 * extension's superclass one this build translated?** A multisrc template
	 * is, and it is emitted as a real `class` the extension really `extends`
	 * — so `super.chapterFromElement()` there is ordinary JavaScript, and
	 * emitting the driver's `__super.chapterFromElement` instead would reach
	 * past the template to a base class that has never heard of it. Kept per
	 * class rather than merged into `methods`, because the merged set cannot
	 * tell which class a name came from and that is the whole question.
	 */
	readonly classMembers: ReadonlyMap<string, ReadonlySet<string>>;
	readonly classBases: ReadonlyMap<string, string>;
	/**
	 * The *properties* each class declares, as against `classMembers`, which
	 * holds everything.
	 *
	 * One question needs the distinction: `list.distinctBy(GenreRoute::slug)`
	 * is Kotlin's unbound reference to a property and becomes `(r) => r.slug`,
	 * where the same form over a method becomes `(r, …a) => r.slug(…a)`.
	 * Getting it the wrong way round puts a function where a value belongs, and
	 * a de-duplication keyed on a function keeps one row out of every hundred.
	 */
	readonly classFields: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * File-scope `fun`s and `val`s, which are values rather than types.
	 *
	 * Only the types crossed a file boundary before this, and every emitted
	 * file joins **one module** — so a shared `fun unpack(source: String)` was
	 * invisible to the extension that called it, fell through to the "a bare
	 * lowercase name is a member the base class supplies" fallback, and came out
	 * as `this.unpack(…)`. The conversion then reported complete, packaged,
	 * installed, and died at the first call with `this.unpack is not a
	 * function`. A capitalised one — a shared `ALPHABET` table — was refused
	 * instead, which at least said so.
	 */
	readonly values: ReadonlySet<string>;
	/** The subset of `values` that suspends, so a call to one is awaited. */
	readonly valueSuspends: ReadonlySet<string>;
	/**
	 * The subset of `values` written as `val X get() = …`, which are functions.
	 *
	 * A Kotlin property with a custom getter is *evaluated at every read*, and
	 * this ecosystem leans on that: a file-scope `val FILTERS: AnimeFilterList
	 * get() = AnimeFilterList(OrderByFilter(), …)` hands out a fresh, unticked
	 * set of filters each time it is asked. So it is emitted as a function and
	 * every read of it becomes a call — which the file next door has to know,
	 * or it reads the function object instead of the value.
	 */
	readonly getters: ReadonlySet<string>;
	/**
	 * Nested types under their *qualified* spelling — `Filters.TypeFilter`.
	 *
	 * A nested type is hoisted to module scope under its bare name, and that
	 * bare name already crosses a file boundary in `types`. The qualified name
	 * did not, and the qualified name is how this ecosystem writes it: an
	 * `object Filters { class TypeFilter … }` in one file, and
	 * `AnimeFilterList(Filters.TypeFilter(), …)` in the next. Without it the
	 * call read a property off an `Object.freeze({})` and answered undefined,
	 * and `is Filters.TypeFilter` compared against the *string*
	 * "Filters.TypeFilter", which is false for every value there has ever been.
	 */
	readonly qualified: ReadonlyMap<string, string>;
	/**
	 * Member extension functions, as `Owner.name`.
	 *
	 * `protected open fun Element.getImageUrl(): String?` on a multisrc theme,
	 * called as `element.getImageUrl()` from the extension that extends it.
	 * `registerTypes` deliberately keeps extension functions out of `methods` —
	 * they take their receiver as the first argument, so they are not
	 * passthrough methods — and nothing else carried them across a file, so the
	 * call was refused as a method no declaration in reach defines.
	 *
	 * Kept under the declaring class rather than by bare name: two unrelated
	 * classes may each declare `fun Element.getInfo()`, and emitting
	 * `__self.getInfo(x)` for the wrong one is a TypeError in the sandbox. The
	 * call site checks it against the class it is actually inside.
	 */
	readonly extensions: ReadonlySet<string>;
	/**
	 * File-scope extension functions — `fun Element.imgAttr()` written beside
	 * the class rather than inside it.
	 *
	 * `extensions` above cannot hold these: it is keyed by the declaring
	 * *class*, and these have none. They are module-scope functions taking
	 * their receiver first, and every emitted file joins one module, so the
	 * name is in scope at a call in any of them by its own spelling — the same
	 * argument `values` makes for a file-scope `fun`.
	 *
	 * Left out, a template that keeps its helpers in a second file refused
	 * every call to them. Measured: `GalleryAdultsUtils.kt` declares
	 * `Element.imgAttr()` and `GalleryAdults.kt` calls it six times, which
	 * refused 21 listings of 300 for a function this build had already
	 * translated.
	 */
	readonly moduleExtensions: ReadonlySet<string>;
	/**
	 * Signatures keyed by the declaring class, as `Owner.method`.
	 *
	 * The bare name cannot carry these: this ecosystem declares `videosFromUrl`
	 * 37 times over incompatible parameter lists, so the unqualified entry is
	 * dropped as ambiguous the moment two files disagree — which is precisely
	 * when a named argument needs one.
	 */
	readonly qualifiedSignatures: ReadonlyMap<string, readonly string[]>;
	/** Of `types`, the ones declared `object` — see `declaredObjects`. */
	readonly objects: ReadonlySet<string>;
	/**
	 * Members with `reified` type parameters, as `Owner.name` → their names.
	 *
	 * `inline fun <reified R> AnimeFilterList.parseCheckbox(…)` declared in a
	 * shared `object` and imported by the extension next door takes its type
	 * as a carried argument (see `reifiedFunctions`); a call site in another
	 * file has to know to pass it, or `it is R` asks about a type called "R".
	 */
	readonly reified: ReadonlyMap<string, readonly string[]>;
	/**
	 * Every signature a class member function is declared with, by name.
	 *
	 * Kotlin resolves a call among same-named functions by the arguments'
	 * count and *static* types; a JavaScript class has one slot per name, and
	 * the second declaration simply replaces the first. So a template writing
	 * `searchMangaUrl(page, query)` beside `searchMangaUrl(page, query,
	 * filters)` emitted a three-argument method that called itself for ever,
	 * and `mangaDetailsParse(response)` beside `mangaDetailsParse(document)` —
	 * the shape of Madara, the largest template in the catalogue — kept
	 * whichever came second and handed it the other one's argument. Measured
	 * over two real catalogues: 109 loaded listings carried the first shape
	 * and 328 the second, all converting and importing cleanly, all wrong.
	 *
	 * Collected across every file, because an override and the declaration it
	 * overrides are usually in two of them. See `overloadsOf` for what is done
	 * with it.
	 */
	readonly overloads: ReadonlyMap<string, readonly OverloadSignature[]>;
	/**
	 * The *functions* each class declares — `classMembers` less its
	 * properties, except that a name which is both stays here as well, which
	 * is the one case `classMembers` minus `classFields` loses and the one
	 * `overloadsOf` needs.
	 */
	readonly classFunctions: ReadonlyMap<string, ReadonlySet<string>>;
	/**
	 * Which parameters of each function are typed `R.() -> T`, by name — or
	 * null where two declarations of the name disagree. See `ReceiverSlots`.
	 */
	readonly receiverLambdas: ReadonlyMap<string, ReceiverSlots | null>;
	/**
	 * The declared type of each class's properties, where the declaration
	 * writes one — `class AnikotoExtractor(private val theme: AnikotoTheme)`
	 * records `theme` → `AnikotoTheme` under `AnikotoExtractor`.
	 *
	 * Kept per class, never by bare name: `theme` in one class and `theme` in
	 * the next are unrelated, and the only question asked of this is "what is
	 * *this* class's `theme`", at a call written on it. See `typedMemberOwner`.
	 */
	readonly propertyTypes: ReadonlyMap<string, ReadonlyMap<string, string>>;
	/**
	 * The entry-shaped classes' members that are `async` in JavaScript, as
	 * `Owner.name`: the ones the entry emitter itself starts from (`suspend`,
	 * and `BLOCKING_CALLS` to a fixpoint — see `suspendMembers`).
	 *
	 * `suspends` deliberately leaves an entry class out, because its members
	 * are reached as `this.name()` inside it and nothing passes them through.
	 * A shared template does hand itself to a helper, though — `AnikotoExtractor
	 * (this)` — and the helper's `theme.getServerDisplayName(…)` has to know
	 * whether to await, from another file.
	 */
	readonly entrySuspends: ReadonlySet<string>;
}

/**
 * A function's parameters that take a receiver lambda — `block:
 * HttpUrl.Builder.() -> Unit` — out of how many it declares.
 *
 * A lambda written for one of these reads its receiver as `this` and its bare
 * calls as calls on it: `searchUrl(page) { addQueryParameter("q", query) }`
 * adds to the *builder*. Emitted as an ordinary arrow, the same lambda has no
 * receiver at all, and the bare call lands on the source object instead — a
 * wrong request, or `this.addQueryParameter is not a function`, depending on
 * which name it was. So the call site has to know, and knowing is a fact about
 * the callee's declaration, which may be in the file next door.
 */
interface ReceiverSlots {
	readonly count: number;
	readonly at: readonly number[];
	/** The same parameters by name, for a call that passes one by name. */
	readonly names: readonly string[];
}

/**
 * One declared parameter list, as the overload dispatcher needs it.
 *
 * `key` is the parameter types' simple names, and it is what the method is
 * emitted under (`mangaDetailsParse$Response`): an override in a subclass has
 * the same parameter types by Kotlin's own rule, so it lands on the same
 * JavaScript name and JavaScript's prototype chain does the virtual dispatch.
 * `total` is -1 for a `vararg`. A receiver, for `fun Element.x()`, is the
 * first parameter here exactly as it is in the emitted function.
 */
export interface OverloadSignature {
	readonly key: string;
	readonly required: number;
	readonly total: number;
	readonly types: readonly string[];
	readonly nullable: readonly boolean[];
	/**
	 * Which positions have a default. Not implied by `required`: a default may
	 * sit *before* a required parameter (`referer = …` then `masterHeaders:
	 * Headers`), and a call with named arguments arrives with `undefined` in
	 * every slot it skipped. Without this the dispatcher took `undefined` for a
	 * `Headers` nobody passed — see `__overloadAccepts`.
	 */
	readonly defaults: readonly boolean[];
	/** The parameters' names, receiver excluded — what a named argument names. */
	readonly params: readonly string[];
	/**
	 * The classes and objects that declare this signature. The dispatch table
	 * is by name across the whole unit, which is harmless there (a signature an
	 * object does not have is never picked from it); placing named arguments is
	 * not, because `videoFromUrl` is declared by dozens of unrelated
	 * extractors, and only the callee's own overloads may decide a slot.
	 */
	readonly owners: readonly string[];
}

const EMPTY_DECLARED: Declared = {
	types: new Set(),
	methods: new Set(),
	suspends: new Set(),
	newable: new Set(),
	signatures: new Map(),
	classMembers: new Map(),
	classBases: new Map(),
	classFields: new Map(),
	values: new Set(),
	valueSuspends: new Set(),
	getters: new Set(),
	qualified: new Map(),
	extensions: new Set(),
	moduleExtensions: new Set(),
	qualifiedSignatures: new Map(),
	objects: new Set(),
	reified: new Map(),
	overloads: new Map(),
	classFunctions: new Map(),
	receiverLambdas: new Map(),
	propertyTypes: new Map(),
	entrySuspends: new Set()
};

/** What one parsed file declares, without translating any of it. */
export function declaredIn(tree: KotlinTree): Declared {
	return new Emitter(EMPTY_DECLARED).declarations(tree.root);
}

/** Every declaration across a set of files, as one table. */
export function mergeDeclared(parts: readonly Declared[]): Declared {
	const types = new Set<string>();
	const methods = new Set<string>();
	const suspends = new Set<string>();
	const newable = new Set<string>();
	const values = new Set<string>();
	const valueSuspends = new Set<string>();
	const getters = new Set<string>();
	const signatures = new Map<string, readonly string[]>();
	const qualified = new Map<string, string>();
	const extensions = new Set<string>();
	const moduleExtensions = new Set<string>();
	const qualifiedSignatures = new Map<string, readonly string[]>();
	const objects = new Set<string>();
	const reified = new Map<string, readonly string[]>();
	const classMembers = new Map<string, Set<string>>();
	const classFields = new Map<string, Set<string>>();
	const classBases = new Map<string, string>();
	const overloads = new Map<string, Map<string, OverloadSignature>>();
	const classFunctions = new Map<string, Set<string>>();
	const ambiguous = new Set<string>();
	const receiverLambdas = new Map<string, ReceiverSlots | null>();
	const propertyTypes = new Map<string, Map<string, string>>();
	const entrySuspends = new Set<string>();
	for (const part of parts) {
		for (const [owner, typed] of part.propertyTypes) {
			const into = propertyTypes.get(owner) ?? new Map<string, string>();
			for (const [property, type] of typed) {
				// Two classes of one name in two files, disagreeing about a
				// property's type, are two classes: the property is then of no
				// type anyone can call through.
				const known = into.get(property);
				into.set(property, known === undefined || known === type ? type : '');
			}
			propertyTypes.set(owner, into);
		}
		for (const name of part.entrySuspends) entrySuspends.add(name);
		for (const [name, slots] of part.receiverLambdas) {
			mergeReceiverSlots(receiverLambdas, name, slots);
		}
		for (const [owner, names] of part.classFunctions) {
			const into = classFunctions.get(owner) ?? new Set<string>();
			for (const name of names) into.add(name);
			classFunctions.set(owner, into);
		}
		for (const [name, shapes] of part.overloads) {
			const into = overloads.get(name) ?? new Map<string, OverloadSignature>();
			for (const shape of shapes) {
				const known = into.get(shape.key);
				into.set(
					shape.key,
					known === undefined
						? shape
						: { ...known, owners: [...new Set([...known.owners, ...shape.owners])] }
				);
			}
			overloads.set(name, into);
		}
		for (const [owner, members] of part.classMembers) {
			// Unioned rather than replaced: the same class name in two files is
			// two classes, and a `super.` that finds either is better than one
			// that finds whichever was surveyed last. The cost of the union is
			// a `super.` allowed through that JavaScript then resolves on the
			// prototype chain — which is the same answer Kotlin gave.
			const into = classMembers.get(owner) ?? new Set<string>();
			for (const member of members) into.add(member);
			classMembers.set(owner, into);
		}
		for (const [owner, fields] of part.classFields) {
			const into = classFields.get(owner) ?? new Set<string>();
			for (const field of fields) into.add(field);
			classFields.set(owner, into);
		}
		for (const [owner, base] of part.classBases) {
			if (!classBases.has(owner)) classBases.set(owner, base);
		}
		for (const name of part.objects) objects.add(name);
		for (const [name, params] of part.reified) reified.set(name, params);
		for (const [name, shape] of part.qualifiedSignatures) qualifiedSignatures.set(name, shape);
		for (const name of part.extensions) extensions.add(name);
		for (const name of part.moduleExtensions) moduleExtensions.add(name);
		for (const [name, hoisted] of part.qualified) qualified.set(name, hoisted);
		for (const name of part.types) types.add(name);
		for (const name of part.methods) methods.add(name);
		for (const name of part.suspends) suspends.add(name);
		for (const name of part.newable) newable.add(name);
		for (const name of part.values) values.add(name);
		for (const name of part.valueSuspends) valueSuspends.add(name);
		for (const name of part.getters) getters.add(name);
		for (const [name, signature] of part.signatures) {
			if (ambiguous.has(name)) continue;
			const existing = signatures.get(name);
			if (existing === undefined) signatures.set(name, signature);
			else if (!sameNames(existing, signature)) {
				signatures.delete(name);
				ambiguous.add(name);
			}
		}
	}
	return {
		types,
		methods,
		suspends,
		newable,
		signatures,
		classMembers,
		classFields,
		classBases,
		values,
		valueSuspends,
		getters,
		qualified,
		extensions,
		moduleExtensions,
		qualifiedSignatures,
		objects,
		reified,
		overloads: new Map([...overloads].map(([name, shapes]) => [name, [...shapes.values()]])),
		classFunctions,
		receiverLambdas,
		propertyTypes,
		entrySuspends
	};
}

/**
 * Records `slots` for `name`, or null when a declaration already recorded
 * disagrees — the call site then cannot tell which lambda it is writing, and
 * refuses rather than guessing.
 */
function mergeReceiverSlots(
	into: Map<string, ReceiverSlots | null>,
	name: string,
	slots: ReceiverSlots | null
): void {
	if (!into.has(name)) {
		into.set(name, slots);
		return;
	}
	const existing = into.get(name) ?? null;
	const same =
		existing !== null &&
		slots !== null &&
		existing.count === slots.count &&
		existing.at.join(',') === slots.at.join(',') &&
		existing.names.join(',') === slots.names.join(',');
	if (!same) into.set(name, null);
}

class Emitter {
	constructor(
		neighbours: Declared,
		private readonly renames: ReadonlyMap<string, string> = new Map(),
		private readonly entryFile = false,
		private readonly declaredAs: ReadonlyMap<string, string> = new Map()
	) {
		for (const name of neighbours.types) {
			this.declaredTypes.add(name);
			// Every file's emission joins one module, so a type declared in the
			// file next door is in scope by its own name.
			this.moduleNames.add(name);
		}
		for (const name of neighbours.methods) this.declaredMethods.add(name);
		for (const name of neighbours.suspends) this.declaredSuspends.add(name);
		for (const name of neighbours.newable) this.newableTypes.add(name);
		// A file-scope `fun` or `val` next door. Every emitted file joins one
		// module, so the name is in scope here by its own spelling — see
		// `Declared.values` for what it cost to have left these out.
		for (const name of neighbours.values) {
			this.moduleNames.add(name);
			this.moduleValues.add(name);
		}
		for (const name of neighbours.valueSuspends) this.moduleSuspends.add(name);
		// A `val X get() = …` next door is a function here, and a read of it is
		// a call. Left out, the name resolved and the *function* was the value.
		for (const name of neighbours.getters) this.moduleGetters.add(name);
		for (const [name, signature] of neighbours.signatures) {
			this.addSignatureCandidate(name, signature);
			this.signatures.set(name, signature);
		}
		for (const [name, hoisted] of neighbours.qualified) this.qualifiedTypes.set(name, hoisted);
		for (const name of neighbours.extensions) this.neighbourExtensions.add(name);
		for (const name of neighbours.moduleExtensions) this.neighbourModuleExtensions.add(name);
		for (const [name, shape] of neighbours.qualifiedSignatures) {
			this.qualifiedSignatures.set(name, shape);
		}
		for (const name of neighbours.objects) this.declaredObjects.add(name);
		for (const [name, slots] of neighbours.receiverLambdas) {
			mergeReceiverSlots(this.receiverLambdas, name, slots);
		}
		for (const [name, params] of neighbours.reified) this.reifiedMembers.set(name, params);
		for (const [owner, members] of neighbours.classMembers) {
			const into = this.classMemberIndex.get(owner) ?? new Set<string>();
			for (const member of members) into.add(member);
			this.classMemberIndex.set(owner, into);
		}
		for (const [owner, fields] of neighbours.classFields) {
			const into = this.classFieldIndex.get(owner) ?? new Set<string>();
			for (const field of fields) into.add(field);
			this.classFieldIndex.set(owner, into);
		}
		for (const [owner, typed] of neighbours.propertyTypes) {
			const into = this.classPropertyTypes.get(owner) ?? new Map<string, string>();
			for (const [property, type] of typed) into.set(property, type);
			this.classPropertyTypes.set(owner, into);
		}
		for (const name of neighbours.entrySuspends) this.entrySuspends.add(name);
		for (const [owner, base] of neighbours.classBases) this.classBaseIndex.set(owner, base);
		for (const [name, shapes] of neighbours.overloads) {
			for (const shape of shapes) this.rememberOverload(name, shape);
		}
		for (const [owner, names] of neighbours.classFunctions) {
			const into = this.classFunctionIndex.get(owner) ?? new Set<string>();
			for (const name of names) into.add(name);
			this.classFunctionIndex.set(owner, into);
		}
	}

	private used = new Set<string>();
	private readonly refusals: Refusal[] = [];
	private readonly translated: string[] = [];
	private pending: Untranslatable[] = [];
	private memberName = '';
	/**
	 * The property whose initialiser is being emitted as a constructor
	 * assignment, and whether it read its own base value through `super.`.
	 * See the `super_expression` branch of `navigation`.
	 */
	private initialising: string | null = null;
	private superSelfRead = false;

	private readonly scopes: Map<string, Local>[] = [];
	private readonly frames: Frame[] = [];
	private temporaries = 0;
	/** The backing field `field` means in the accessor being emitted, if any. */
	private backing: string | null = null;
	/** Whether a property accessor is being emitted, where `field` is a keyword. */
	private inAccessor = false;
	/** What an unlabelled `break` here would land on; see `loopBody`. */
	private readonly loops: ('loop' | 'barrier')[] = [];
	/** Bumped per captured receiver; see `Frame.capture`. */
	private captures = 0;
	/** Bumped per inlined Kotlin block, for the label a `return@x` leaves by. */
	private exits = 0;
	/** The statement being emitted, and where a hoisted `?: return` guard goes. */
	private guards: GuardFrame | null = null;
	/** Bumped whenever a lambda came back `async`, so its call site can await. */
	private asyncLambdas = 0;
	/** Local `fun`s in the member being emitted whose body came back `async`. */
	private readonly localSuspends = new Set<string>();

	/**
	 * Names resolvable at module scope: hoisted constants, factories, objects.
	 *
	 * Registered *before* emission so a method above a companion object can
	 * still see its constants, which is where a Kotlin class puts them.
	 */
	private readonly moduleNames = new Set<string>();
	/** Names actually written out, so a genuine collision is still caught. */
	private readonly emittedNames = new Set<string>();
	/** Declarations lifted out of a function body, in the order they were met. */
	private readonly hoisted: string[] = [];
	/** File-scope `fun`s and `val`s, this file's and its neighbours'. */
	private readonly moduleValues = new Set<string>();
	/** The subset of those that suspends, so a bare call to one is awaited. */
	private readonly moduleSuspends = new Set<string>();
	/** The subset of those written with a custom getter; see `Declared.getters`. */
	private readonly moduleGetters = new Set<string>();
	/**
	 * A valueless `return`/`throw` inside an elvis, and the call that is its
	 * value. See `rejoinJumps`.
	 */
	private readonly jumpValues = new Map<KNode, KNode>();
	/**
	 * A property's name and the class it holds, where the declaration says so.
	 *
	 * `private val hostExtractor by lazy { HostExtractor(client) }` is how
	 * this ecosystem keeps an extractor, and `hostExtractor.videoFromUrl(…)`
	 * is how it calls one — so without this the receiver is just a name and the
	 * declaring class is unknowable at the call site.
	 */
	private readonly propertyTypes = new Map<string, string>();
	/** Signatures under the class that declares them, as `Owner.method`. */
	private readonly qualifiedSignatures = new Map<string, readonly string[]>();
	/**
	 * The parameters without a default, under `Owner.method`; `null` for an
	 * overloaded name. This file's classes only — a neighbour's are not needed,
	 * because a bare `::name` can only name a member of the class it is in.
	 */
	private readonly requiredArities = new Map<string, number | null>();
	/**
	 * Types declared with `object`, whose `::member` is bound and not unbound.
	 *
	 * `Obj::method` in Kotlin already has its receiver — the object — so it is
	 * the bound form. Reading it as unbound would consume the first argument as
	 * a receiver and silently drop it.
	 */
	private readonly declaredObjects = new Set<string>();
	/**
	 * Top-level functions and values this file imports from keiyoushi's shared
	 * `core/`, by name, with the package. See the last branch of `bareCall`.
	 */
	private readonly keiyoushiImports = new Map<string, string>();
	/** Member extension functions this file declares, as `Owner.name`. */
	private readonly declaredExtensions = new Set<string>();
	private readonly declaredModuleExtensions = new Set<string>();
	/** The same, from the files beside it. */
	private readonly neighbourExtensions = new Set<string>();
	/** See `Declared.moduleExtensions`. */
	private readonly neighbourModuleExtensions = new Set<string>();
	/** See `Declared.classMembers`. Named apart from the `classMembers` set
	 * above, which is the members of the class being emitted right now. */
	private readonly classMemberIndex = new Map<string, Set<string>>();
	/** See `Declared.propertyTypes`. */
	private readonly classPropertyTypes = new Map<string, Map<string, string>>();
	/** See `Declared.entrySuspends`. */
	private readonly entrySuspends = new Set<string>();
	/** See `Declared.classFields`. */
	private readonly classFieldIndex = new Map<string, Set<string>>();
	/** Identities handed out to callbacks that catch a non-local `return@label`. */
	private jumpIds = 1;
	private readonly classBaseIndex = new Map<string, string>();
	/** The base class of the class being emitted, for the check above. */
	private ownerBase: string | null = null;
	/** `Owner.Nested` → the module-scope name that nested type was emitted as. */
	private readonly qualifiedTypes = new Map<string, string>();
	/** A locally declared type's name, and the module-scope name it got. */
	private readonly localTypes = new Map<string, string>();
	/**
	 * Type names already written at module scope, so a nested one can be told
	 * apart from the one that got there first. See `scopeNestedTypes`.
	 */
	private readonly emittedTypes = new Set<string>();
	/** See `nestedRenames`. */
	private readonly nestedRenameCache = new Map<KNode, ReadonlyMap<string, string>>();
	/**
	 * The types this file declares at its top level, by name.
	 *
	 * Reserved before anything is emitted, because a nested type is usually
	 * written *above* its top-level namesake: `LibGroupDto.kt` nests
	 * `Chapter.Branch` and declares a top-level `Branch` sixty lines further
	 * down. `emittedTypes` only knows what has been written so far, so the
	 * nested one took the bare name, the top-level one was written under it
	 * too, and the module was "Branch has already been declared" at load —
	 * converted, nothing refused, and two listings dead. The top-level type is
	 * the one the rest of the file and the files next door name bare, so it is
	 * the one that keeps the name; the nested one is renamed apart.
	 */
	private readonly topLevelTypes = new Set<string>();
	/**
	 * `typealias A = B`, as `A → B`.
	 *
	 * A type alias has no runtime existence in either language — Kotlin erases
	 * it at compile time and JavaScript has no types to erase — so the
	 * declaration emits nothing and this is the whole of what survives it.
	 * Almost every one in this ecosystem names a function type or a
	 * parameterised collection and is used only in signatures, which are
	 * dropped; the map is here for the minority that is then *constructed* or
	 * extended by its alias, where the name has to resolve to the real one.
	 *
	 * Only the head of the aliased type is kept: `typealias Rows =
	 * List<Row>` records `List`, which resolves to nothing and leaves any value
	 * use of `Rows` refused by name — the same answer as before, and the right
	 * one, because a bare `Rows(...)` is not something this build can build.
	 */
	private readonly typeAliases = new Map<string, string>();
	/**
	 * Types this file declares, registered before anything is emitted.
	 *
	 * A Kotlin class puts its nested `UriPartFilter` at the *bottom* and
	 * constructs it near the top, so registering a name only as it is emitted
	 * makes every forward reference a capitalised bare call and refuses it as
	 * an untranslated constructor. The names are also what decides whether a
	 * `: Base(…)` supertype is one this file supplies.
	 */
	private readonly declaredTypes = new Set<string>();
	/**
	 * Methods those types declare, and which of them suspend.
	 *
	 * The receiver of `typeFilter.toUriPart()` is not something this build can
	 * type, but the *name* resolves: it is declared on a class in the same
	 * source, a few lines further down. That is a resolved symbol rather than
	 * the fallback the file header refuses — passthrough onto a shim that never
	 * heard of the method — so it is emitted as written.
	 *
	 * The entry class is deliberately excluded. Its members are reached as
	 * `this.name()` through `classMembers`, and letting them in here would turn
	 * a call on any *other* receiver that happens to share a name into a
	 * passthrough, which is the guess this table exists to avoid.
	 */
	/**
	 * The `kotlin.time` unit properties this file imports —
	 * `import kotlin.time.Duration.Companion.days` — which make `n.days` on a
	 * NUMBER mean a Duration. See `navigation` for the read, and
	 * `__k.durationOf` for why the receiver still decides.
	 */
	private readonly durationImports = new Set<string>();

	/**
	 * `import eu.kanade.tachiyomi.source.model.SManga.Companion.COMPLETED`,
	 * then `status = COMPLETED` — a companion constant of a type the runtime
	 * defines by name, imported so it can be written bare. Name to the
	 * qualified read. Only for a runtime global (`GLOBAL_NAMES`): anything
	 * else is a class this build may not have, and stays refused by name.
	 */
	private readonly companionImports = new Map<string, string>();
	private readonly declaredMethods = new Set<string>();
	private readonly declaredSuspends = new Set<string>();
	/**
	 * Of those types, the ones emitted as an ES6 `class`.
	 *
	 * A `data class` becomes a factory function and an `object` becomes a frozen
	 * literal, so both are called as written; a plain class is a class, and
	 * calling one without `new` is a `TypeError` at the first search rather than
	 * at load — late enough to look like the site changed.
	 */
	private readonly newableTypes = new Set<string>();
	/** Names bound by a destructured lambda parameter, awaiting their scope. */
	private readonly destructuredParts: string[] = [];
	/** What each member mentions; see `MemberEdges`. */
	private readonly graph: MemberEdges[] = [];
	/**
	 * The extension properties the class being emitted declares on the
	 * settings store, by name. See `extensionProperty`.
	 */
	private extensionProperties = new Set<string>();
	/** The subset of `extensionProperties` with a setter to write through. */
	private extensionSetters = new Set<string>();
	/** What the settings store is called in the class being emitted. */
	private preferenceStores = new Set<string>(['preferences']);
	/** Members translated with a boundary-reaching tail cut off; see `recoveryCut`. */
	private readonly deferred: Refusal[] = [];
	/**
	 * The cut the *next* function body is emitted under, consumed on entry.
	 * Set only around the one `functionDeclaration` call that asked for it.
	 */
	private cut: RecoveryCut | null = null;
	/** The class or object whose members are being emitted. */
	private owner: string | null = null;
	/**
	 * What `javaClass.simpleName` means here: the Kotlin name of the class
	 * whose `this` is in scope, and whether that name is the whole answer.
	 *
	 * Not `owner`, for three reasons that each gave a wrong name. `owner` can be
	 * a module-scope *rename* of a nested type, where Kotlin's simple name is
	 * the identifier as written; it survives into a companion, whose members
	 * are hoisted out and whose `javaClass` is `Companion`; and it survives into
	 * an anonymous `object :`, whose simple name is empty. Null in all of those,
	 * so the chain is refused there rather than answered with a neighbour's.
	 *
	 * `exact` is false for an open or abstract class, where the instance may be
	 * a subclass's — a template's `tag` is the extension's name — and the
	 * runtime is asked instead. See `SIMPLE_NAME` in `subset.ts`.
	 */
	private selfClass: { readonly name: string; readonly exact: boolean } | null = null;
	/**
	 * True while the arguments of an `android.util.Log` call are being emitted.
	 *
	 * The one place a value's class name is answered with whatever the runtime
	 * has, because text that only ever reaches the host log cannot change what
	 * a plugin does. See `SIMPLE_NAME`.
	 */
	private inLogLine = false;
	/**
	 * Extension functions declared in this file, and where they live.
	 *
	 * `fun Element.getInfo(key: String)` is a function whose first argument is
	 * spelled as a receiver. It becomes exactly that — `getInfo(__recv, key)` —
	 * which is the same shape every `__k` helper already has, and the call site
	 * `element.getInfo("x")` moves the receiver into first position.
	 */
	private readonly extensionFunctions = new Map<string, 'method' | 'module'>();
	/**
	 * The `object` an extension function was declared in, where there was one.
	 *
	 * A Kotlin `object` becomes a frozen literal rather than a set of module
	 * bindings, so its members are reached through the object's name. Without
	 * this the call emitted a bare `parseCheckbox(…)` against a name nothing
	 * declares — and this whole ecosystem keeps its filter helpers in an
	 * `object XFilters`, so it was every one of them.
	 */
	private readonly extensionOwners = new Map<string, string>();
	/**
	 * An `object`'s own members, and the object they are reached through.
	 *
	 * A Kotlin `object` becomes a frozen literal, so its members are `F.NAME`
	 * and not module bindings — and a nested class inside it names them bare:
	 * `class OrderFilter : SelectFilter("Ordina per", ORDER_LIST)` with
	 * `ORDER_LIST` declared two hundred lines below. Registered before the body
	 * is walked, for the reason `registerCompanionNames` exists one scope out.
	 */
	private readonly objectMembers = new Map<string, string>();
	/**
	 * The object whose *property* is being emitted, while one is.
	 *
	 * A property of the literal cannot reach a sibling through the literal's own
	 * name — `const F = Object.freeze({ a: 1, b: F.a })` throws before `F` is
	 * bound. A method or a hoisted class can, because it runs later. So the
	 * resolution below is switched off exactly there, leaving the honest refusal
	 * that was already the answer.
	 */
	private emittingObjectProperty: string | null = null;
	private readonly lazyCaches = new Set<string>();
	/**
	 * An `object`'s constants that another of its properties reads, hoisted.
	 *
	 * `object Data { val EVERY = Pair(…); val GENRES = arrayOf(EVERY, …) }` is
	 * ordinary Kotlin — an object initialises its properties top to bottom — and
	 * the frozen literal has no way to say it: `const F = Object.freeze({ EVERY:
	 * …, GENRES: [F.EVERY] })` reads `F` before it is bound. So a constant a
	 * sibling needs becomes a module `const` in declaration order and the
	 * literal carries that name, which is what a companion's members already do.
	 */
	private readonly objectAliases = new Map<string, string>();
	/**
	 * Declared functions with a `reified` type parameter, and what it is called.
	 *
	 * `inline fun <reified R> AnimeFilterList.parseCheckbox()` is monomorphised
	 * by the Kotlin compiler, so `it is R` inside it means the type written at
	 * the call site. Nothing carries that here unless it is passed, and the
	 * emitted `__k.isType(it, "R")` asked the runtime's type table about a type
	 * called "R", got `false` for every element, and answered an empty filter
	 * list with nothing refused anywhere.
	 */
	private readonly reifiedFunctions = new Map<string, readonly string[]>();
	/** The reified parameters in scope, bound to the arguments carrying them. */
	private reifiedTypes: ReadonlyMap<string, string> | null = null;
	/** See `Declared.reified`. */
	private readonly reifiedMembers = new Map<string, readonly string[]>();
	/**
	 * The enum whose body is being emitted, and its entries' names.
	 *
	 * Inside an enum a bare `SINGLE` is an entry, a bare `entries` its list and
	 * a bare `values()` its copy — all reached through the class here.
	 */
	private enumScope: { owner: string; entries: ReadonlySet<string> } | null = null;
	/**
	 * Companion members written out under a name other than their own, while
	 * the class holding them is emitted. See `registerCompanionNames`.
	 */
	private companionRenames: ReadonlyMap<string, string> = new Map();
	/** Companion member names some class in this file already holds. */
	private readonly companionClaims = new Set<string>();
	/**
	 * What each companion emitted since the class holding it began, to be
	 * reachable through the class's name. See `companionStatics`.
	 */
	private companionMembers: CompanionMember[] = [];
	/**
	 * Members of a declared `object` this file imports by name, and the
	 * object each is reached through.
	 *
	 * `import …AnimeStreamFilters.getPairListByIndex` then a bare
	 * `getPairListByIndex(0)` inside another object is a call on
	 * `AnimeStreamFilters`. With nothing recording the import it fell through
	 * to "a bare lowercase call is a member of the source" and came out as
	 * `this.getPairListByIndex(…)` — on the *calling* object, which has no
	 * such member: a TypeError at the first search, with nothing refused. An
	 * imported extension (`filters.parseCheckbox<GenresFilter>(…)`) was
	 * refused instead, as a method nothing in reach declares.
	 *
	 * Only a member of an `object` this unit declares is recorded: that is
	 * the one case where the import names a value this module holds. Kotlin
	 * lets a member of the scope being emitted shadow an import, and so do
	 * the call sites that read this — see `importedOwner`.
	 */
	private readonly importedMembers = new Map<string, string>();
	/**
	 * What a reified function's type parameter is *read off*, when a call site
	 * names no type argument: its declared return type, or its receiver.
	 *
	 * `inline fun <reified T> Document.extractAstroProp(key): T` is called as
	 * `val data: MangaDto = doc.extractAstroProp("manga")` — Kotlin infers `T`
	 * from the type the value is going to, and `inline fun <reified T : Any>
	 * T.toJsonRequestBody()` infers it from the value it is called on. Only a
	 * return type or receiver that *is* the parameter, written bare, is kept:
	 * `List<T>` would need unifying, and that is a type checker.
	 */
	private readonly reifiedFrom = new Map<string, { returns: boolean; receiver: boolean }>();
	/**
	 * The type a call's value is going to, where the source writes it down.
	 *
	 * `val list: List<MangaDto> = response.parseAs()` names the shape once, on
	 * the left, and Kotlin carries it into the call as its type argument. This
	 * is that inference and nothing more general: the positions a declared type
	 * reaches a value *by being written there* — a typed `val`, a function's
	 * declared return type (its expression body, or a `return` in its block
	 * body), an `as`, an assignment to a typed local, and an argument to a
	 * function this file declares. Each is followed through the constructs that
	 * hand a value on unchanged — parentheses, `!!`, both sides of `?:`, each
	 * branch of an `if`/`when`/`try` — and stops everywhere else.
	 *
	 * Keyed by line, kind and text rather than by node, because `ast.ts` wraps
	 * a node afresh on each access. Two positions with the same key and
	 * different types record `null`, which the reader treats as unknown and
	 * refuses — a guessed shape drops fields without saying so.
	 */
	private readonly expectedTypes = new Map<string, string | null>();
	/** The receiver parameter of the extension function being emitted. */
	private receiverParam: string | null = null;
	/**
	 * That function's own name, which is the label Kotlin gives its receiver:
	 * `this@toSManga` inside `fun Dto.toSManga() = SManga.create().apply { … }`
	 * is the DTO, reached past the `apply` whose own `this` is the model.
	 */
	private receiverLabel: string | null = null;
	/**
	 * And the type it extends, as the class index spells it, for the one
	 * question only the declaration can answer: does a bare name inside the
	 * function belong to the extension receiver? See `receiverDeclares`.
	 */
	private receiverType: string | null = null;
	/**
	 * The Kotlin name of the class `owner` is emitting, which `owner` is not
	 * once a nested type has been renamed apart from a namesake — see
	 * `scopeNestedTypes`. `this@Book` names the class as it was written.
	 */
	private ownerLabel: string | null = null;
	private classMembers = new Set<string>();
	private suspendMembers = new Set<string>();
	private readonly signatures = new Map<string, readonly string[]>(KNOWN_SIGNATURES);
	private readonly ambiguousSignatures = new Set<string>();
	/** See `ReceiverSlots`. Declared here and next door, merged by name. */
	private readonly receiverLambdas = new Map<string, ReceiverSlots | null>();
	/**
	 * Every parameter list this build has seen under a name, including the ones
	 * `signatures` had to give up on.
	 *
	 * A name is ambiguous when two declarations disagree about it, and the
	 * honest answer at most call sites is to refuse. But the call site is not
	 * always silent about which one it means: **an argument passed by name is a
	 * parameter of the callee**, so a candidate that does not declare that name
	 * is not the function being called. Where exactly one candidate survives
	 * that test the call is not ambiguous at all, and refusing it throws away a
	 * fact the source stated.
	 *
	 * Measured: `WordSet.startsWith(dateString)` in two shared templates
	 * collides with Kotlin's own `String.startsWith(prefix, ignoreCase)`, which
	 * deleted the known signature and refused every
	 * `date.startsWith(it, ignoreCase = true)` in the catalogue — 21 of 300
	 * listings, none of which had written anything ambiguous.
	 */
	private readonly signatureCandidates = new Map<string, readonly (readonly string[])[]>(
		[...KNOWN_SIGNATURES].map(([name, signature]): [string, readonly (readonly string[])[]] => [
			name,
			[signature]
		])
	);

	private className: string | null = null;
	private superClass: string | null = null;
	/** Whether the class holding `className` constructs its base, or only names one. */
	private entryConstructsBase = false;
	private fileRefusal: string | null = null;

	/* ── files ───────────────────────────────────────────────────────────── */

	/** The pre-pass on its own, so the files can be surveyed before any is emitted. */
	declarations(root: KNode): Declared {
		this.registerTypes(kids(root), true);
		this.registerSignatures(kids(root));
		return {
			types: this.declaredTypes,
			methods: this.declaredMethods,
			suspends: this.declaredSuspends,
			newable: this.newableTypes,
			signatures: this.signatures,
			values: this.moduleValues,
			valueSuspends: this.moduleSuspends,
			getters: this.moduleGetters,
			qualified: this.qualifiedTypes,
			extensions: this.declaredExtensions,
			moduleExtensions: this.declaredModuleExtensions,
			qualifiedSignatures: this.qualifiedSignatures,
			objects: this.declaredObjects,
			reified: this.reifiedMembers,
			classMembers: this.classMemberIndex,
			classFields: this.classFieldIndex,
			classBases: this.classBaseIndex,
			overloads: new Map(
				[...this.overloadIndex].map(([name, shapes]) => [name, [...shapes.values()]])
			),
			classFunctions: this.classFunctionIndex,
			receiverLambdas: this.receiverLambdas,
			propertyTypes: this.classPropertyTypes,
			entrySuspends: this.entrySuspends
		};
	}

	private registerSignatures(
		declarations: readonly KNode[],
		owner: string | null = null,
		ownerIsClass = false
	): void {
		for (const child of declarations) {
			if (child.type === 'function_declaration') {
				const name = this.nameOf(child);
				// Only a plain class's members: those are the ones
				// `classDeclaration` emits as methods and can give a dispatcher.
				// An `object`'s members, a data class's and an enum's are
				// emitted elsewhere and keep one name each.
				if (name !== null && ownerIsClass && owner !== null) {
					this.rememberOverload(name, { ...this.signatureOf(child), owners: [owner] });
				}
				const slots = receiverSlots(child);
				if (name !== null && slots !== null) mergeReceiverSlots(this.receiverLambdas, name, slots);
				if (name !== null && receiverOf(child) === null) {
					this.rememberSignature(name, this.parameterNames(child));
					// Also under the class that declares it.
					//
					// `videosFromUrl` is declared 37 times across this ecosystem
					// over incompatible parameter lists, so the bare name is
					// ambiguous by construction and `rememberSignature` drops it
					// the moment a second file disagrees — which is exactly when
					// a named argument needs it. Keyed by the declaring class it
					// is an exact fact, and the call site knows which class it is
					// calling whenever the receiver is a construction of one.
					if (owner !== null) {
						this.qualifiedSignatures.set(`${owner}.${name}`, this.parameterNames(child));
						// And how many of those a caller must supply, for a bare
						// `::name` handed on as a value; see `callableReference`.
						// Two declarations under one key are an overload, and an
						// overload has no one arity — kept as `null`.
						const key = `${owner}.${name}`;
						const required = requiredParameterCount(child);
						const seen = this.requiredArities.get(key);
						this.requiredArities.set(
							key,
							seen === undefined || seen === required ? required : null
						);
					}
				}
				continue;
			}
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
			const name = this.nameOf(child);
			if (name !== null && child.type === 'class_declaration') {
				this.rememberSignature(
					name,
					this.primaryConstructorParams(child).map((param) => param.name)
				);
			}
			const body = kids(child).find(
				(part) => part.type === 'class_body' || part.type === 'enum_class_body'
			);
			// The hierarchy, for `super.` — see `Declared.classMembers`. Read off
			// the *Kotlin* here rather than the emitted text, because this runs
			// in the survey pass before anything has been emitted; whether the
			// supertype turns into a real `extends` is settled later by
			// `resolvedBase`, and asking `classMembers` about a name it never
			// recorded answers no, which is the safe direction.
			if (name !== null) {
				const base = this.baseInvocation(child)?.type ?? null;
				if (base !== null) this.classBaseIndex.set(name, base);
				const members = this.classMemberIndex.get(name) ?? new Set<string>();
				const fields = this.classFieldIndex.get(name) ?? new Set<string>();
				const functions = this.classFunctionIndex.get(name) ?? new Set<string>();
				// A `val` in the primary constructor is a property of the class
				// exactly as one in the body is, and for the DTOs this ecosystem
				// writes it is the *only* place they are declared.
				const typed = this.classPropertyTypes.get(name) ?? new Map<string, string>();
				for (const param of this.primaryConstructorParams(child)) {
					if (param.isProperty) {
						members.add(param.name);
						fields.add(param.name);
						if (param.type !== null) typed.set(param.name, param.type);
					}
				}
				for (const member of kids(body)) {
					if (member.type !== 'property_declaration') continue;
					const held = this.propertyName(member);
					const type = declaredTypeName(
						kids(kids(member).find((part) => part.type === 'variable_declaration'))
					);
					if (held !== null && type !== null) typed.set(held, type);
				}
				if (typed.size > 0) this.classPropertyTypes.set(name, typed);
				for (const member of kids(body)) {
					// A property's name sits one level down, in its
					// `variable_declaration`, where `nameOf` does not look — so
					// until this read it, a class's `val`s written in the body
					// were missing from both tables and only its constructor
					// `val`s were recorded. `overloadsOf` is what noticed: a
					// `val` and a `fun` sharing a name cannot share a JavaScript
					// slot, and the `val` half was invisible.
					const memberName =
						member.type === 'property_declaration'
							? this.propertyName(member)
							: this.nameOf(member);
					if (
						memberName !== null &&
						(member.type === 'function_declaration' || member.type === 'property_declaration')
					) {
						members.add(memberName);
						if (member.type === 'property_declaration') fields.add(memberName);
						else functions.add(memberName);
					}
				}
				this.classMemberIndex.set(name, members);
				this.classFieldIndex.set(name, fields);
				this.classFunctionIndex.set(name, functions);
			}
			// An `object`'s functions too: its literal has one key per name, so
			// `JsUnpacker.unpack(String)` beside `unpack(Collection)` kept the
			// last and every extractor that unpacks one script got the list
			// version run over its characters.
			this.registerSignatures(
				kids(body),
				name,
				isPlainClass(child) || child.type === 'object_declaration'
			);
		}
	}

	/** See `Declared.overloads`: name, then signature key. */
	private readonly overloadIndex = new Map<string, Map<string, OverloadSignature>>();
	/** See `Declared.classFunctions`. */
	private readonly classFunctionIndex = new Map<string, Set<string>>();
	private fieldNameCache: Set<string> | null = null;

	private rememberOverload(name: string, shape: OverloadSignature): void {
		const into = this.overloadIndex.get(name) ?? new Map<string, OverloadSignature>();
		const known = into.get(shape.key);
		into.set(
			shape.key,
			known === undefined
				? shape
				: { ...known, owners: [...new Set([...known.owners, ...shape.owners])] }
		);
		this.overloadIndex.set(name, into);
	}

	/**
	 * A declared parameter list, read off the Kotlin.
	 *
	 * Types by simple name — `okhttp3.Response` and `Response` are one type
	 * written two ways, and an override may spell it either — with generics
	 * and nullability dropped from the key and nullability kept beside it, so
	 * the dispatcher can let a `null` through to the parameter that takes one.
	 */
	private signatureOf(node: KNode): OverloadSignature {
		const types: string[] = [];
		const nullable: boolean[] = [];
		const defaults: boolean[] = [];
		const params: string[] = [];
		let required = 0;
		let total = 0;
		let spread = false;
		const receiver = receiverOf(node);
		if (receiver !== null) {
			types.push(simpleTypeName(receiver));
			nullable.push(false);
			defaults.push(false);
			required += 1;
			total += 1;
		}
		const list = kids(node).find((child) => child.type === 'function_value_parameters');
		const parts = (list?.allChildren ?? []).filter((child) => !COMMENT_KINDS.has(child.type));
		let vararg = false;
		for (const [index, part] of parts.entries()) {
			if (part.type === 'parameter_modifiers' && /\bvararg\b/.test(part.text)) vararg = true;
			if (part.type !== 'parameter') continue;
			const written = kids(part).find((child) => child.type.endsWith('type'));
			// A function type keeps its arrow — `(Headers,String)->Headers` — so
			// the runtime can recognise it as one; its dots are not a package.
			const spelled = typeName(written);
			types.push(spelled.includes('->') ? spelled : simpleTypeName(spelled));
			nullable.push(written !== undefined && written.text.trim().endsWith('?'));
			const hasDefault = parts[index + 1]?.type === '=';
			defaults.push(hasDefault || vararg);
			params.push(this.nameOf(part) ?? '');
			total += 1;
			if (vararg) {
				spread = true;
				vararg = false;
			} else if (!hasDefault) required += 1;
		}
		return {
			key: types.map((type) => type.replace(/\W/g, '_')).join('_'),
			required,
			total: spread ? -1 : total,
			types,
			nullable,
			defaults,
			params,
			owners: []
		};
	}

	/**
	 * Every name that is a property in one class and a function in the same
	 * class or one related to it by inheritance — the only place Kotlin lets
	 * the two share a name *and* JavaScript cannot.
	 *
	 * Unrelated classes are left alone on purpose: a DTO's `val tag` and some
	 * other class's `fun tag()` never meet on one prototype chain, and moving
	 * the function behind a dispatcher there would change nothing but its
	 * spelling.
	 */
	private fieldNames(): Set<string> {
		if (this.fieldNameCache !== null) return this.fieldNameCache;
		const found = new Set<string>();
		const chain = (owner: string): string[] => {
			const seen: string[] = [];
			let at: string | undefined = owner;
			while (at !== undefined && !seen.includes(at)) {
				seen.push(at);
				at = this.classBaseIndex.get(at);
			}
			return seen;
		};
		for (const [owner, functions] of this.classFunctionIndex) {
			for (const name of functions) {
				// A function here, and a property on this class, on an ancestor,
				// or on a class that has this one as an ancestor.
				const related = [...this.classFieldIndex].some(
					([other, otherFields]) =>
						otherFields.has(name) && (chain(owner).includes(other) || chain(other).includes(owner))
				);
				if (related) found.add(name);
			}
		}
		this.fieldNameCache = found;
		return found;
	}

	/**
	 * The signatures of `name` when it cannot keep one JavaScript name, and
	 * null when it can.
	 *
	 * Two reasons it cannot. Two parameter lists — see `Declared.overloads`.
	 * Or one, beside a *property* of the same name: Kotlin keeps a `val` and a
	 * `fun` apart and JavaScript does not, so Madara's `val useLoadMoreRequest
	 * = LoadMoreStrategy.AutoDetect` next to its `fun useLoadMoreRequest():
	 * Boolean` left the instance holding the strategy where the method was
	 * meant to be, and `this.useLoadMoreRequest()` threw on every page of 47
	 * listings.
	 *
	 * Either way each declaration is emitted under `name$key` and the plain
	 * name becomes a dispatcher — unless a property holds it, in which case
	 * calls go through `__k.overload` directly (`overloadCall`).
	 */
	private overloadsOf(name: string): readonly OverloadSignature[] | null {
		const shapes = this.overloadIndex.get(name);
		if (shapes === undefined || shapes.size === 0) return null;
		if (shapes.size === 1 && !this.fieldNames().has(name)) return null;
		return [...shapes.values()];
	}

	/**
	 * A call routed through the runtime's overload resolution.
	 *
	 * `target` is where the candidates are looked up and `self` is what they
	 * run on. They differ for exactly one caller: a `super.` call looks them up
	 * on the *parent's* prototype, because looking them up on the instance
	 * would find the subclass's own override — the one making the call — and
	 * recurse. The last argument lets a call that matches none of the
	 * translated declarations reach the driver's base class, which is where
	 * Kotlin would have found `mangaDetailsParse(response)` for an extension
	 * that declared only the `Document` half.
	 */
	private overloadCall(
		target: string,
		self: string,
		name: string,
		args: readonly string[],
		shapes: readonly OverloadSignature[]
	): string {
		return `${this.helper('overload')}(${target}, ${self}, ${JSON.stringify(name)}, [${args.join(', ')}], ${overloadTable(name, shapes)}, () => __super)`;
	}

	/**
	 * Whether a capitalised name is declared anywhere this module can see it:
	 * a local, a member, any file in the unit, or the runtime.
	 */
	private knownCapital(name: string): boolean {
		return (
			this.lookup(name) !== null ||
			this.classMembers.has(name) ||
			this.declaredTypes.has(name) ||
			this.moduleNames.has(name) ||
			this.declaredObjects.has(name) ||
			this.qualifiedTypes.has(name) ||
			GLOBAL_NAMES.has(name) ||
			BASE_CONSTANTS.has(name) ||
			this.companionImports.has(name) ||
			this.aliased(name) !== name
		);
	}

	/** A class and every base above it, nearest first. */
	private lineage(owner: string): string[] {
		const seen: string[] = [];
		let at: string | undefined = owner;
		while (at !== undefined && !seen.includes(at)) {
			seen.push(at);
			at = this.classBaseIndex.get(at);
		}
		return seen;
	}

	/**
	 * Whether `base`, or anything it extends, declares `name`.
	 *
	 * Walks the chain because a template hierarchy is two deep in this
	 * ecosystem — `MangaThemesiaAlt : MangaThemesia` is the shape — and a
	 * member declared at the top is still reachable from the bottom by
	 * JavaScript's prototype chain, which is what the emitted `extends`
	 * builds.
	 *
	 * Bounded by the number of classes: a Kotlin hierarchy cannot be circular,
	 * but this table is read off a parse that may have recovered from
	 * something, and a cycle here would otherwise hang the emitter rather than
	 * refuse a member.
	 */
	private baseDeclares(base: string, name: string): boolean {
		const seen = new Set<string>();
		let at: string | undefined = base;
		while (at !== undefined && !seen.has(at)) {
			seen.add(at);
			if (this.classMemberIndex.get(at)?.has(name) === true) return true;
			at = this.classBaseIndex.get(at);
		}
		return false;
	}

	private rememberSignature(name: string, signature: readonly string[]): void {
		// Before the ambiguity check, not after: a name this build gave up on is
		// exactly the one whose other spellings are worth keeping.
		this.addSignatureCandidate(name, signature);
		if (this.ambiguousSignatures.has(name)) return;
		const existing = this.signatures.get(name);
		if (existing === undefined || sameNames(existing, signature))
			this.signatures.set(name, signature);
		else {
			this.signatures.delete(name);
			this.ambiguousSignatures.add(name);
		}
	}

	private addSignatureCandidate(name: string, signature: readonly string[]): void {
		const known = this.signatureCandidates.get(name) ?? [];
		if (known.some((candidate) => sameNames(candidate, signature))) return;
		this.signatureCandidates.set(name, [...known, signature]);
	}

	/**
	 * The one parameter list under `name` that could have taken these argument
	 * names, or null where none or several could.
	 */
	private onlyCandidate(name: string, written: readonly string[]): readonly string[] | null {
		const candidates = (this.signatureCandidates.get(name) ?? []).filter((candidate) =>
			written.every((one) => candidate.includes(one))
		);
		return candidates.length === 1 ? candidates[0] : null;
	}

	private parameterNames(node: KNode): string[] {
		const list = kids(node).find((child) => child.type === 'function_value_parameters');
		return kids(list)
			.filter((child) => child.type === 'parameter')
			.map((child) => this.nameOf(child))
			.filter((name): name is string => name !== null);
	}

	file(root: KNode): Emission {
		const parts: string[] = [];
		for (const list of kids(root).filter((child) => child.type === 'import_list')) {
			for (const found of list.text.matchAll(/kotlin\.time\.Duration\.Companion\.(\w+|\*)/g)) {
				if (found[1] === '*')
					for (const unit of DURATION_UNITS.keys()) this.durationImports.add(unit);
				else this.durationImports.add(found[1]);
			}
			for (const found of list.text.matchAll(
				/^\s*import\s+[\w.]*?\b([A-Z]\w*)\.Companion\.([A-Z][A-Z0-9_]*)\s*$/gm
			)) {
				if (GLOBAL_NAMES.has(found[1]))
					this.companionImports.set(found[2], `${found[1]}.${found[2]}`);
			}
		}
		// Registered before anything is emitted: an extension function is
		// usually declared below the members that call it, and so is the nested
		// filter class the members above it construct.
		this.registerExtensions(kids(root), 'module');
		this.registerTypes(kids(root), true);
		this.registerSignatures(kids(root));
		this.registerExpectedTypes(root);
		this.registerImports(kids(root).find((child) => child.type === 'import_list'));

		const top = kids(root);
		for (const child of top) {
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
			const declared = this.nameOf(child);
			if (declared !== null && declared !== undefined) this.topLevelTypes.add(declared);
		}
		for (const [index, child] of top.entries()) {
			if (child.type === 'package_header' || child.type === 'import_list') continue;
			const piece = this.declaration(child, top[index + 1]);
			if (this.fileRefusal !== null) {
				return {
					js: '',
					className: this.className,
					superClass: this.superClass,
					translated: [],
					refusals: this.refusals,
					usedRuntime: [],
					fileRefusal: this.fileRefusal,
					graph: this.graph,
					deferred: []
				};
			}
			if (piece !== null && piece.length > 0) parts.push(piece);
		}

		this.auditMembers();

		// Declarations lifted out of a function body go first: a local `object`
		// becomes a `const`, which does not hoist the way a function does.
		return {
			js: orderClasses([...this.hoisted, ...parts]).join('\n\n'),
			className: this.className,
			superClass: this.superClass,
			translated: this.translated,
			refusals: this.refusals,
			usedRuntime: [...this.used].sort(),
			fileRefusal: null,
			graph: this.graph,
			deferred: this.deferred
		};
	}

	/**
	 * One top-level declaration, with the refusals its *header* can raise caught.
	 *
	 * A class body's members are each wrapped in `member()`, which turns a
	 * refusal into a named entry. A class **header** is not a member and has
	 * nowhere to land: a default argument on a constructor parameter, or the
	 * arguments a base constructor is handed, are ordinary expressions that can
	 * refuse, and the refusal escaped all the way out of `emitKotlin`. The
	 * pipeline then reported the whole file as unparseable — seven extensions in
	 * one catalogue, each losing every other class it declared for one
	 * expression in one header.
	 */
	private declaration(node: KNode, next?: KNode): string | null {
		return this.caught(node, () => this.topLevel(node, next));
	}

	/** Runs a declaration, turning a refusal it raises into one naming it. */
	private caught(node: KNode, run: () => string | null): string | null {
		const scopeDepth = this.scopes.length;
		const frameDepth = this.frames.length;
		try {
			return run();
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			const name = this.nameOf(node) ?? node.type;
			this.refusals.push({
				member: name,
				obstacles:
					this.pending.length > 0
						? this.pending
						: [{ kind: spoken(node), line: node.line, memberName: name }]
			});
			this.pending = [];
			this.scopes.length = scopeDepth;
			this.frames.length = frameDepth;
			return null;
		}
	}

	private topLevel(node: KNode, next?: KNode): string | null {
		switch (node.type) {
			// A `typealias` is a compile-time name and nothing else: Kotlin has
			// erased it before the bytecode exists, and the emitted module has
			// no types to give it. `registerTypeNames` has already recorded what
			// it points at, so there is nothing left to write out — and nothing
			// left to refuse, which is what this used to do. It refused the
			// *file's* alias as a member, and the extension with it.
			case 'type_alias':
				return null;
			// `@file:Suppress("SpellCheckingInspection")` is an instruction to the
			// IDE and the compiler's warnings, and has no existence at run time —
			// and it refused the whole file as a member named after itself, which
			// took a filter list or a theme with it for a spell-checker hint.
			// Only the annotations known to be inert are skipped. The one other
			// that occurs, `@file:UseSerializers(X::class)`, changes how every
			// matching type in the file *decodes*, and the decoder here has no
			// custom serializers to switch to — so it stays refused, by name.
			case 'file_annotation':
				return INERT_FILE_ANNOTATION.test(node.text.replace(/\s+/g, ''))
					? null
					: this.declineMember(this.nameOf(node) ?? spoken(node), node, spoken(node));
			case 'class_declaration':
				return this.classDeclaration(node);
			case 'object_declaration':
				return this.objectDeclaration(node, this.nameOf(node) ?? 'object');
			case 'function_declaration': {
				const name = this.nameOf(node) ?? 'fun';
				return this.member(name, node, () => {
					this.moduleNames.add(name);
					return this.functionDeclaration(node, 'module');
				});
			}
			case 'property_declaration': {
				const name = this.propertyName(node) ?? 'val';
				return this.member(name, node, () => {
					const accessor = this.moduleGetter(node, next, name);
					this.moduleNames.add(name);
					if (accessor !== null) {
						this.moduleGetters.add(name);
						return `function ${this.safe(name)}() ${accessor}`;
					}
					return `const ${this.safe(name)} = ${this.propertyValue(node, name)};`;
				});
			}
			// Consumed by the property above it; see `accessorOf`. Reached on its
			// own, a `get()` is not a declaration and refused the whole file.
			case 'getter':
			case 'setter':
				return null;
			default:
				if (node.type === 'ERROR' || node.isMissing) {
					// A declaration that failed to parse at file scope took its
					// whole class with it, so there is no member to refuse — only
					// a file.
					this.fileRefusal =
						'This extension has a declaration Yorozo could not parse. Yorozo will not ' +
						'translate members it read out of a guessed parse.';
					return null;
				}
				return this.declineMember(this.nameOf(node) ?? spoken(node), node, spoken(node));
		}
	}

	/* ── classes ─────────────────────────────────────────────────────────── */

	/**
	 * An `interface`, emitted as the one thing it is used for here.
	 *
	 * Every interface in this ecosystem is a **capability marker with no
	 * bodies** — `interface UriFilter { fun addToUri(builder: HttpUrl.Builder) }`
	 * and thirty near-copies of it — and every use is the same line:
	 * `filters.filterIsInstance<UriFilter>().forEach { it.addToUri(url) }`. So
	 * what the interface has to do at runtime is answer *is this one*, and
	 * nothing else: the implementing classes carry the method already, because
	 * they declare it themselves.
	 *
	 * JavaScript cannot express what Kotlin means here. A class can extend one
	 * class, and the filters already extend `Filter.Select` or `Filter.Text`,
	 * so an implementer cannot also extend this. `Symbol.hasInstance` is the
	 * expression that fits: `x instanceof UriFilter` becomes "does x have the
	 * members the interface declares", which is what the Kotlin type test
	 * decided too and is decided over the same set of objects. `__isType`
	 * already routes a declared type through `instanceof`, so `filterIsInstance`
	 * and `is` both answer correctly with nothing else changed.
	 *
	 * A member **with a body** is refused rather than dropped. Kotlin lets an
	 * interface carry a default implementation, and nothing here would inherit
	 * it — the implementer would silently answer `undefined` from a method the
	 * source had written out. None occur in the measured catalogue; this is the
	 * floor under that.
	 */
	private interfaceDeclaration(node: KNode, name: string): string | null {
		const body = kids(node).find((child) => child.type === 'class_body');
		const members: string[] = [];
		for (const member of kids(body)) {
			if (member.type === 'function_declaration') {
				if (kids(member).some((child) => child.type === 'function_body')) {
					return this.declineMember(
						name,
						node,
						`an \`interface\` member \`${this.nameOf(member) ?? '?'}\` with a body`
					);
				}
				const method = this.nameOf(member);
				if (method !== null) members.push(method);
				continue;
			}
			if (member.type === 'property_declaration') {
				const held = this.propertyName(member);
				if (held !== null) members.push(held);
			}
		}
		const test = `${this.helper('hasMembers')}(__v, ${JSON.stringify(members)})`;
		return `class ${this.safe(name)} { static [Symbol.hasInstance](__v) { return ${test}; } }`;
	}

	private classDeclaration(node: KNode, rename?: string): string | null {
		const name = rename ?? this.nameOf(node) ?? 'class';
		const kinds = new Set(node.allChildren.map((child) => child.type));
		const modifiers = new Set(
			kids(kids(node).find((child) => child.type === 'modifiers')).map((m) => m.text)
		);

		if (kinds.has('interface')) return this.interfaceDeclaration(node, name);
		// An enum is a class with a fixed set of instances — see `enumTail`.
		const isEnum = kinds.has('enum_class_body');

		// A `@Serializable` class registers what kotlinx knows about it — its
		// fields' wire names, types and defaults, and any custom serializer it
		// names — so a decode that names its type builds it the way kotlinx
		// does. See `serialRegistration`. A custom serializer this build cannot
		// run faithfully is refused here, by name, and graphed, so it blocks
		// exactly the members that reach the class and no others: read past,
		// it decoded the JSON the serializer existed to reshape, and converted,
		// loaded and answered wrong with nothing refused.
		const serial = this.serialRegistration(node, name, modifiers.has('data'), isEnum);
		if (serial !== null && 'refusal' in serial) {
			this.graph.push({
				member: name,
				owner: this.owner,
				construction: false,
				references: mentions(node),
				calls: callEdges(node)
			});
			return this.declineMember(name, node, serial.refusal);
		}
		const registration = serial === null ? null : serial.text;
		if (modifiers.has('data')) {
			const data = this.dataDeclaration(node, name);
			return data === null || registration === null ? data : `${data}\n${registration}`;
		}

		// The header — everything but the body — must parse cleanly. A recovered
		// base-class name or constructor call means every member below it is
		// being read against a guess, so the whole file goes.
		for (const child of kids(node)) {
			if (child.type === 'class_body' || child.type === 'enum_class_body') continue;
			if (child.hasError) {
				this.fileRefusal =
					`This extension's \`${name}\` class header did not parse. Yorozo will not ` +
					'translate members against a guessed class declaration.';
				return null;
			}
		}

		// A supertype this file supplies is emitted as a real `extends`; one it
		// does not is the extension's own base class, which lives in
		// `shims/aniyomi-entry.ts` and is attached by the driver. Dropping the
		// first kind is the failure mode this resolution exists to stop: a
		// `class TypeFilter : UriPartFilter("…", arrayOf(…))` emitted as `class
		// TypeFilter {}` translates, packages, loads, and answers every call on
		// it with `undefined` — the plugin that looks like it works.
		const invoked = this.baseInvocation(node);
		const base = invoked === null ? null : this.resolvedBase(invoked.type);
		// A class named after the class it imports and extends: every other
		// spelling of the name in this file means the import, so only the
		// header is written under the declared name. What else would name the
		// class itself — a companion's statics, an enum's entries — reads it
		// through the renamed spelling, so those shapes are refused rather than
		// written against the wrong class.
		const ownSpelling = rename === undefined ? this.declaredAs.get(name) : undefined;
		if (
			ownSpelling !== undefined &&
			(isEnum ||
				kids(kids(node).find((child) => child.type === 'class_body')).some(
					(child) => child.type === 'companion_object'
				))
		) {
			return this.declineMember(
				name,
				node,
				'a class with a companion, named after the class it imports'
			);
		}

		// A class that *constructs* an unreachable base is the extension. One
		// that merely lists an interface — `class SomethingFactory :
		// AnimeSourceFactory` — is not, and it sits above the real source in a
		// third of the files that have both, so it takes the name only until
		// something with a constructed base turns up.
		// `base === null` is the usual test: a class constructing a base this
		// build does not supply is the extension. It is wrong for an extension
		// built on a multisrc theme — `class Example : WcoTheme()` resolves,
		// because the theme is a neighbouring file this build converts — so the
		// concrete class declined the name and the abstract theme took it. The
		// driver then built the theme, whose every `baseUrl` read was the one
		// the subclass never got to set.
		//
		// In the extension's own first file the first class IS the extension:
		// the adapter sorts the class `build.gradle` names there. Elsewhere the
		// old rule stands.
		const claims =
			!isEnum &&
			rename === undefined &&
			(base === null || this.entryFile) &&
			(this.className === null || (invoked !== null && !this.entryConstructsBase));
		if (claims) {
			this.className = name;
			this.superClass = this.superClassOf(node);
			this.entryConstructsBase = invoked !== null;
		} else if (base === null && invoked !== null) {
			return this.declineMember(name, node, `a base class \`${invoked.type}\` this build has not`);
		}

		const body =
			kids(node).find((child) => child.type === 'class_body' || child.type === 'enum_class_body') ??
			null;
		const members = body === null ? [] : kids(body).filter((child) => child.type !== 'enum_entry');
		const enumEntries =
			body === null ? [] : kids(body).filter((child) => child.type === 'enum_entry');
		const outerOwner = this.owner;
		const outerBase = this.ownerBase;
		const outerEnum = this.enumScope;
		if (isEnum) {
			this.enumScope = {
				owner: name,
				entries: new Set(enumEntries.map((entry) => this.nameOf(entry) ?? ''))
			};
		}
		// Saved with them, and for the same reason. A nested class — this
		// ecosystem writes `protected class SMangaDto(…)` inside the template it
		// belongs to — replaced the enclosing class's member table and never
		// put it back, so from the nested declaration to the end of the file
		// `this.somethingTheClassDeclares()` was a member of a four-field DTO.
		// `isSourceMember` then said no and the call was refused as a
		// passthrough onto a shim, naming a method the source had declared
		// forty lines further down.
		const outerMembers = this.classMembers;
		const outerSuspends = this.suspendMembers;
		const outerLabel = this.ownerLabel;
		const outerSelf = this.selfClass;
		const outerExtensionProperties = this.extensionProperties;
		const outerSetters = this.extensionSetters;
		const outerStores = this.preferenceStores;
		this.owner = name;
		this.ownerLabel = this.nameOf(node) ?? name;
		this.ownerBase = base;
		this.selfClass = {
			name: this.nameOf(node) ?? name,
			exact: !modifiers.has('open') && !modifiers.has('abstract') && !modifiers.has('sealed')
		};

		// An extension property is not a member of the instance: `private val
		// SharedPreferences.quality get() = …` is read as `preferences.quality`,
		// and naming it here made `this.quality` look like a field. See
		// `extensionProperty`.
		this.extensionProperties = new Set(
			members
				.filter(
					(child) =>
						child.type === 'property_declaration' &&
						extensionReceiverOf(child) === 'SharedPreferences'
				)
				.map((child) => this.propertyName(child))
				.filter((found): found is string => found !== null)
		);
		this.extensionSetters = new Set(
			members
				.filter(
					(child, at) =>
						child.type === 'property_declaration' &&
						extensionReceiverOf(child) === 'SharedPreferences' &&
						(accessorOf(child, undefined, 'setter') !== undefined ||
							members.slice(at + 1, at + 3).some((next) => next.type === 'setter') ||
							preferenceDelegateOf(child) !== null)
				)
				.map((child) => this.propertyName(child))
				.filter((found): found is string => found !== null)
		);
		// The names the settings store goes by here: `preferences`, which is
		// also what an inherited one is called, and any property this class
		// builds from `getPreferencesLazy()`/`getPreferences()` or types as a
		// `SharedPreferences` — one measured source's is `preference`.
		this.preferenceStores = new Set(['preferences']);
		for (const child of members) {
			if (child.type !== 'property_declaration' || extensionReceiverOf(child) !== null) continue;
			const declared = this.propertyName(child);
			if (declared === null) continue;
			const shape = child.text.replace(/\s+/g, ' ');
			if (/(?:\bby getPreferencesLazy\b|= getPreferences\(|: SharedPreferences\b)/.test(shape)) {
				this.preferenceStores.add(declared);
			}
		}
		this.classMembers = new Set(
			members
				.map((child) =>
					child.type === 'function_declaration'
						? this.nameOf(child)
						: child.type === 'property_declaration' &&
							  extensionReceiverOf(child) !== 'SharedPreferences'
							? this.propertyName(child)
							: null
				)
				.filter((found): found is string => found !== null)
		);
		this.suspendMembers = new Set(
			members
				.filter(
					(child) => child.type === 'function_declaration' && this.hasModifier(child, 'suspend')
				)
				.map((child) => this.nameOf(child))
				.filter((found): found is string => found !== null)
		);
		for (const name of this.blockingMembers(members)) this.suspendMembers.add(name);

		this.registerExtensions(members, 'method');
		// A companion's members hoist to module scope, so an extension function
		// declared there is a *module* one — and it has to be known before the
		// members above it are emitted, because that is where it is called from.
		// `private fun String.hexBytes()` sits at the bottom of Madara's
		// companion and is used two hundred lines higher up; registered only as
		// it was emitted, the call site had never heard of it and the whole
		// template refused.
		for (const member of members) {
			if (member.type !== 'companion_object') continue;
			const inner = kids(member).find((part) => part.type === 'class_body');
			this.registerExtensions(kids(inner), 'module');
		}

		const constructorParams = this.primaryConstructorParams(node);
		for (const param of constructorParams) this.classMembers.add(param.name);

		/**
		 * The parameters that are *only* parameters, which a property
		 * initialiser reads as itself rather than off `this`.
		 *
		 * `class Intl(language: String, private val baseLanguage: String)` gives
		 * the class one field and two names. Both went into `classMembers`
		 * above, so both resolved to `this.x` — and for the half that is not a
		 * property there is no such field. `Intl`'s own
		 * `chosenLanguage = when (language) { in availableLanguages -> … }`
		 * therefore compared `undefined` against `undefined` and answered the
		 * base language every time: an extension in Spanish drew its filters in
		 * English, with nothing refused and nothing thrown.
		 *
		 * Only the non-property half is declared, and only around an
		 * initialiser. A `val` that is both parameter and property must keep
		 * resolving to the field, because a getter written below it reads the
		 * field and the parameter is long gone by then — and Kotlin forbids a
		 * getter or a method from naming the other half at all, which is what
		 * makes this scope exactly as wide as the language allows.
		 */
		const initialiserOnly = constructorParams.filter((param) => !param.isProperty);

		this.emittedTypes.add(name);
		const nested = this.scopeNestedTypes(members, name);

		const outerRenames = this.companionRenames;
		const outerCompanion = this.companionMembers;
		this.companionRenames = this.registerCompanionNames(members, name);
		this.companionMembers = [];

		const hoisted: string[] = [];
		const enumCompanion: string[] = [];
		const ctorLines: string[] = [
			...(isEnum ? ['this.name = __name;', 'this.ordinal = __ordinal;'] : []),
			...constructorParams
				.filter((param) => param.isProperty)
				.map((param) => `this.${param.name} = ${this.safe(param.name)};`)
		];
		const memberLines: string[] = [];
		const dispatched = new Set<string>();

		for (const [index, child] of members.entries()) {
			switch (child.type) {
				case 'property_declaration': {
					// A getter written on its own line — `override val baseUrl:
					// String` then `get() = "…"` — is a *sibling* of the property
					// here, not a child of it. Reading them apart refuses both.
					// Both of them, where there are both: `var x: T` then `get() = …`
					// then `set(v) = …` are three siblings.
					const detached: KNode[] = [];
					for (const next of members.slice(index + 1, index + 3)) {
						if (next.type !== 'getter' && next.type !== 'setter') break;
						detached.push(next);
					}
					this.pushScope();
					let emitted;
					try {
						for (const param of initialiserOnly) this.declare(param.name);
						emitted = this.classProperty(child, detached);
					} finally {
						this.popScope();
					}
					if (emitted === null) break;
					if (emitted.kind === 'assign') ctorLines.push(emitted.text);
					else memberLines.push(emitted.text);
					if (emitted.ctor !== undefined) ctorLines.push(emitted.ctor);
					break;
				}
				case 'getter':
				case 'setter':
					// Consumed by the property above; see `property_declaration`.
					break;
				case 'function_declaration': {
					const fnName = this.nameOf(child) ?? 'fun';
					// `protected abstract fun getInfoSelector(tag: String): String`
					// — a member this class deliberately does not define, because
					// the subclass is required to. There is nothing to emit and
					// nothing missing: JavaScript finds the subclass's own method
					// on the prototype, which is where Kotlin was going to look
					// too. Refusing it as a body-less declaration refused the
					// *template* over the one member that was never meant to have
					// one, and with it every extension built on that template.
					if (this.hasModifier(child, 'abstract')) break;
					// See `overloadsOf`: a name that cannot keep one JavaScript
					// slot is emitted under its signature, and gets a dispatcher
					// below.
					const mangled =
						this.overloadsOf(fnName) === null ? null : `${fnName}$${this.signatureOf(child).key}`;
					const candidate =
						fnName === 'intercept' && implementsInterceptor(node)
							? recoveryCandidate(child, this.nameOf(node) ?? name)
							: null;
					const emitted = this.memberWithRecovery(fnName, child, candidate, () =>
						this.functionDeclaration(child, 'method', mangled)
					);
					if (emitted !== null) {
						memberLines.push(emitted);
						if (mangled !== null) dispatched.add(fnName);
					}
					break;
				}
				case 'type_alias':
					// Erased, exactly as at file scope. Registered there too:
					// `registerTypeNames` walks class bodies.
					this.registerAlias(child);
					break;
				case 'anonymous_initializer': {
					// An `init` block is constructor code, and it lands in
					// `ctorLines` at the position it was written — which is what
					// makes it exact. Kotlin runs initialisers and `init` blocks
					// in declaration order, and a property declared *below* an
					// `init` block cannot be read inside it (the compiler refuses
					// it), so appending in source order reproduces the order of
					// effects rather than guessing at one.
					//
					// This used to be refused outright, on the grounds that an
					// `init` would run before the members it reads are assigned.
					// That is true of an `init` hoisted to the top and false of
					// one left where its author put it.
					const emitted = this.member(`${name}.${child.type}`, child, () =>
						this.initialiserBody(child, constructorParams)
					);
					if (emitted !== null && emitted.length > 0) ctorLines.push(emitted);
					break;
				}
				case 'companion_object':
					// An enum's companion is initialised after its entries, and
					// commonly reads one (`val default = SINGLE`), so it follows
					// them rather than preceding the class.
					(isEnum ? enumCompanion : hoisted).push(...this.companion(child));
					break;
				case 'object_declaration': {
					const declared = this.nameOf(child) ?? 'object';
					const emitted = this.objectDeclaration(child, nested.renames.get(declared) ?? declared);
					if (emitted !== null) hoisted.push(emitted);
					break;
				}
				case 'class_declaration': {
					// Caught here as well as at file scope: a nested class's own
					// header can refuse, and letting that escape would refuse the
					// class holding it — which is the extension.
					const under = nested.renames.get(this.nameOf(child) ?? '');
					const emitted = this.caught(child, () => this.classDeclaration(child, under));
					if (emitted !== null) hoisted.push(emitted);
					break;
				}
				default:
					this.declineMember(`${name}.${child.type}`, child, child.type);
			}
		}

		// Iterable, made iterable here too. See `iterationMembers`.
		memberLines.push(...this.iterationMembers(node, members, constructorParams, false));

		// The plain name of an overloaded method, for everything that calls it
		// by that name — this file's own `this.x(…)`, the files next door, and
		// the driver. It resolves against the *instance*, so an override a
		// subclass wrote under the same signature is the one that runs, which
		// is Kotlin's virtual dispatch. Not written where this class's own
		// property holds the name: the property is what a read of it means, and
		// calls to the function go through `overloadCall` instead.
		const ownFields = this.classFieldIndex.get(name) ?? new Set<string>();
		for (const fnName of dispatched) {
			if (ownFields.has(fnName)) continue;
			const shapes = this.overloadsOf(fnName) ?? [];
			memberLines.push(
				`${fnName}(...__a) { return ${this.helper('overload')}(this, this, ${JSON.stringify(fnName)}, __a, ${overloadTable(fnName, shapes)}, () => __super); }`
			);
		}

		// The super call is emitted with the constructor's parameters in scope
		// and nothing else: `UriPartFilter(displayName, val vals) :
		// Select(displayName, vals.map { … })` reads `vals` as the argument it
		// was handed, and reading it as `this.vals` would be `this` before
		// `super`, which throws at construction rather than at conversion.
		const superLine =
			base === null || invoked === null
				? []
				: [`super(${this.baseArguments(invoked, constructorParams).join(', ')});`];

		// A constructor parameter's default is not decoration. This emitted the
		// names alone, so `PlaylistUtils(client, headers, redirect = true)` came
		// out as `constructor(client, headers, redirect)` and a caller that
		// omitted the last argument got `undefined` where Kotlin gives `true` —
		// a *wrong value* rather than a missing one, which is the failure this
		// file exists to refuse rather than emit. `dataDeclaration` already did
		// this; a plain class did not.
		const ctorParams = [
			...(isEnum ? ['__name', '__ordinal'] : []),
			...this.constructorSignature(constructorParams)
		];

		const ctor =
			superLine.length > 0 || constructorParams.length > 0 || ctorLines.length > 0
				? [`constructor(${ctorParams.join(', ')}) ` + block([...superLine, ...ctorLines])]
				: [];
		if (isEnum) memberLines.push(...enumMethods(this.classMembers));
		// Built before the scope is taken down: an entry's arguments are read
		// with the enum's own names in reach, as Kotlin reads them.
		const enumLines = isEnum ? this.enumTail(name, node, enumEntries, members) : [];

		nested.restore();
		this.owner = outerOwner;
		this.ownerLabel = outerLabel;
		this.ownerBase = outerBase;
		this.enumScope = outerEnum;
		this.selfClass = outerSelf;
		this.classMembers = outerMembers;
		this.suspendMembers = outerSuspends;
		this.extensionProperties = outerExtensionProperties;
		this.extensionSetters = outerSetters;
		this.preferenceStores = outerStores;
		const companionMembers = this.companionMembers;
		this.companionRenames = outerRenames;
		this.companionMembers = outerCompanion;
		const heritage = base === null ? '' : `extends ${base} `;
		const statics = this.companionStatics(name, companionMembers);
		if (isEnum) {
			// One piece, in Kotlin's initialisation order: the class, its
			// entries, then its companion — and frozen last, so nothing
			// reassigns an entry.
			const cls = `class ${this.safe(name)} ${heritage}${block([...ctor, ...memberLines])}`;
			return orderClasses([
				...hoisted,
				[
					cls,
					...enumLines,
					...enumCompanion,
					...(statics.length > 0 ? [statics] : []),
					`Object.freeze(${this.safe(name)});`
				].join('\n')
			]).join('\n\n');
		}
		const cls =
			`class ${ownSpelling ?? this.safe(name)} ${heritage}${block([...ctor, ...memberLines])}` +
			(statics.length > 0 ? `\n${statics}` : '');
		// A `@Serializable` class is a *shape* as well as a class: the decoder
		// answers plain JSON, so a field the source renamed and a property it
		// computes are both absent from what a member then reads. Registered
		// beside the class so the runtime can recognise a decoded object as one
		// — see `shape` in the runtime for why the match has to be exact.
		const shape = this.serialisableShape(node, name);
		const tail = [shape, registration].filter((line) => line !== null).join('\n');
		return orderClasses([...hoisted, tail.length === 0 ? cls : `${cls}\n${tail}`]).join('\n\n');
	}

	/**
	 * An `init` block's statements, as constructor lines.
	 *
	 * The constructor's own parameters are declared in scope, because that is
	 * where Kotlin says they are: a parameter that is not a `val` exists *only*
	 * inside the constructor, and reading it as `this.size` — which is what a
	 * bare name falls back to — would be `undefined` at construction with
	 * nothing to say so.
	 *
	 * A block that suspends is refused rather than awaited: a constructor
	 * cannot await, and the value the extension is building would be handed on
	 * before its `init` finished.
	 */
	private initialiserBody(node: KNode, params: readonly { readonly name: string }[]): string {
		const statements = kids(node).find((child) => child.type === 'statements');
		if (statements === undefined) return '';
		this.pushScope();
		try {
			for (const param of params) this.declare(param.name);
			const emitted = this.functionScope('function', null, [], () =>
				this.statementList(statements, null).join('\n')
			);
			if (emitted.isAsync) this.refuse(node, 'a suspending `init` block');
			// A receiver block inside the `init` — `something.apply { … }` —
			// captures the object as `__self`, and an arrow keeps `this`.
			if (!emitted.usesSelf) return emitted.text;
			return `(() => ${block(['const __self = this;', emitted.text])})();`;
		} finally {
			this.popScope();
		}
	}

	/**
	 * `data class D(val a: String)` → a factory, because there is no identity to
	 * model.
	 *
	 * A body is allowed, but only the two shapes a DTO actually uses: a computed
	 * `val` with a getter, and a small method. Both become members of the object
	 * literal, so `this` inside them is the record — which is what the Kotlin
	 * meant. Anything else in a body (an `init`, a companion, a nested class) is
	 * refused, because a factory cannot reproduce it.
	 */
	/**
	 * Module-scope names for the types a class body nests, scoped to that class.
	 *
	 * Kotlin scopes a nested type to the class holding it, so one file may
	 * declare `EpisodeListResponse.EpisodeObject` and
	 * `PagePropsObject.EpisodeObject` and mean two different shapes. Both are
	 * hoisted into one module scope here, and the second `function
	 * EpisodeObject` is "Identifier 'EpisodeObject' has already been declared"
	 * in an ES module — a SyntaxError before a line of it runs. It converted
	 * with no refusals and failed at load; the measured file declares three such
	 * pairs (`EpisodeObject`, `PropsObject`, `PagePropsObject`).
	 *
	 * Two decisions, both deliberate:
	 *
	 * - **The first keeps the bare name.** A reference this emitter cannot
	 *   attribute to an owner then still resolves to something real, which is
	 *   what it resolved to before any of this.
	 * - **The mapping is installed for the owner's body and taken back
	 *   afterwards**, through `localTypes` — the map every reference path
	 *   already consults — so a name inside `PagePropsObject` means its own and
	 *   the same name in the next class means the next one's. Leaving it
	 *   installed would point the whole rest of the file at the *second*
	 *   declaration, which is the wrong answer rather than a failing one.
	 */
	private scopeNestedTypes(
		members: readonly KNode[],
		owner: string
	): { renames: ReadonlyMap<string, string>; restore: () => void } {
		const renames = this.nestedRenames(members, owner);
		const saved = new Map<string, string | undefined>();
		for (const [declared, candidate] of renames) {
			saved.set(declared, this.localTypes.get(declared));
			this.localTypes.set(declared, candidate);
		}

		return {
			renames,
			restore: (): void => {
				for (const [declared, previous] of saved) {
					if (previous === undefined) this.localTypes.delete(declared);
					else this.localTypes.set(declared, previous);
				}
			}
		};
	}

	/**
	 * Which of a class body's nested types are renamed apart, decided once.
	 *
	 * Split out of `scopeNestedTypes` because the class's `@Serializable`
	 * registration is written *before* its body is scoped, and it names the
	 * nested types too: `Chapter(val branches: List<Branch>)` over a nested
	 * `Chapter.Branch` renamed to `Chapter_Branch` registered its field as
	 * `List<Branch>` — the top-level namesake — and a decode built every
	 * branch as the wrong class, missing the fields its own methods read.
	 * Cached by the body's first member, so both callers see one answer and
	 * the names are reserved once.
	 */
	private nestedRenames(members: readonly KNode[], owner: string): ReadonlyMap<string, string> {
		const first = members[0];
		if (first === undefined) return new Map();
		const cached = this.nestedRenameCache.get(first);
		if (cached !== undefined) return cached;
		const renames = new Map<string, string>();
		for (const child of members) {
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
			const declared = this.nameOf(child);
			if (declared === null || declared === undefined) continue;
			if (!this.emittedTypes.has(declared) && !this.topLevelTypes.has(declared)) {
				this.emittedTypes.add(declared);
				continue;
			}
			let candidate = `${owner}_${declared}`;
			while (this.emittedTypes.has(candidate) || this.topLevelTypes.has(candidate)) {
				candidate = `${candidate}_`;
			}
			this.emittedTypes.add(candidate);
			renames.set(declared, candidate);
			// `Chapter.Branch` spelled out names this one, not the namesake.
			this.qualifiedTypes.set(`${owner}.${declared}`, candidate);
		}
		this.nestedRenameCache.set(first, renames);
		return renames;
	}

	/**
	 * A type as written, with every nested type renamed apart spelled the way
	 * it was emitted — for the text handed to the typed decoder, which looks
	 * a class up by its registered name rather than through `safe`.
	 */
	private scopedTypeText(text: string, own: ReadonlyMap<string, string> = new Map()): string {
		return text.replace(/\b[A-Z]\w*(?:\.[A-Z]\w*)*/g, (written) => {
			if (written.includes('.')) return this.qualifiedTypes.get(written) ?? written;
			return own.get(written) ?? this.localTypes.get(written) ?? written;
		});
	}

	/**
	 * Members that are not `suspend` in Kotlin and must be awaited here anyway.
	 *
	 * Kotlin lets an ordinary `fun` block on a request — `client.newCall(…)
	 * .execute()` is the whole idiom — and JavaScript has no blocking. The
	 * emitter therefore writes that member as an `async function`, and a caller
	 * that does not await it gets a Promise where the Kotlin had a value.
	 *
	 * Nothing said so. `suspendMembers` was the set of members carrying the
	 * `suspend` modifier, and a plain helper like
	 *
	 *     private fun getRealDoc(document: Document): Document {
	 *         …
	 *         return client.newCall(GET(url, headers)).execute().useAsJsoup()
	 *     }
	 *
	 * came out as `async getRealDoc(…)` called as `this.getRealDoc(…)`. The
	 * next line read `document.selectFirst(…)` off a Promise and died with
	 * "selectFirst is not a function" — one member away from the thing that
	 * actually suspended, which is what made it hard to see.
	 *
	 * Read off the member's source text rather than its emission, because a
	 * Kotlin class puts its helpers at the bottom and the call sites above them
	 * are emitted first. Transitive, to a fixpoint: a member that calls a
	 * member that blocks, blocks. Deliberately over-approximate — awaiting a
	 * value that was never a Promise costs nothing, and the failure this
	 * replaces is silent.
	 */
	private blockingMembers(
		members: readonly KNode[],
		pattern: RegExp = BLOCKING_CALLS
	): Set<string> {
		const bodies = new Map<string, string>();
		for (const child of members) {
			if (child.type !== 'function_declaration') continue;
			const name = this.nameOf(child);
			if (name !== null) bodies.set(name, child.text);
		}

		const blocking = new Set<string>();
		for (const [name, text] of bodies) {
			if (pattern.test(text)) blocking.add(name);
		}

		for (let grew = true; grew;) {
			grew = false;
			for (const [name, text] of bodies) {
				if (blocking.has(name)) continue;
				for (const other of blocking) {
					if (!new RegExp(`\\b${other}\\s*\\(`).test(text)) continue;
					blocking.add(name);
					grew = true;
					break;
				}
			}
		}
		return blocking;
	}

	/**
	 * Companion members, declared before anything in the body is translated.
	 *
	 * Companion members hoist to module scope, and a Kotlin class puts its
	 * companion at the *bottom* — so registering the names only as they are
	 * emitted leaves every member above it unable to resolve `PREF_QUALITY_KEY`,
	 * which is where the constants in this ecosystem live.
	 *
	 * Shared with `dataDeclaration` because a `data class` is emitted down a
	 * different path — a factory function rather than an ES6 class — and that
	 * path walked the body in source order with no pre-pass at all. The vendored
	 * `Unbaser` is exactly that shape: an `internal data class` whose `dict`
	 * reads `ALPHABET[selector]` twenty lines above the companion holding
	 * `ALPHABET`. It was refused as "a capitalised name this file did not
	 * declare" — and the file declares it, three lines down. Ranked across a
	 * 254-listing catalogue, that one omission was the single most common
	 * blocker in the set.
	 */
	/**
	 * A companion's member names, registered before the class body is emitted,
	 * and renamed where an earlier companion in this file already took one.
	 *
	 * Companion members hoist to module scope, where two classes' `private val
	 * options = arrayOf(…)` are one name — and a filters file declares a dozen
	 * classes that each keep their options in a companion. The second was
	 * refused as a collision, which refused every filter after the first.
	 * Kotlin scopes each to its own class, and so does this: the later one is
	 * written out as `Owner_options`, and while that class and its companion
	 * are being emitted `safe` maps the bare name onto it — the scope Kotlin
	 * resolves a bare companion name in, nested classes included.
	 *
	 * Answers the renames to install, which the caller takes back afterwards.
	 */
	private registerCompanionNames(members: readonly KNode[], owner: string): Map<string, string> {
		const renames = new Map(this.companionRenames);
		for (const child of members) {
			if (child.type !== 'companion_object') continue;
			const inner = kids(child).find((part) => part.type === 'class_body');
			const parts = kids(inner);
			for (const [index, part] of parts.entries()) {
				const declared =
					part.type === 'property_declaration'
						? this.propertyName(part)
						: part.type === 'function_declaration'
							? this.nameOf(part)
							: null;
				if (declared === null) continue;
				// A companion getter is a hoisted function, including when the
				// grammar puts its accessor beside the property. Mark it before
				// earlier class members are emitted so their reads call it.
				if (
					part.type === 'property_declaration' &&
					accessorOf(part, parts[index + 1], 'getter') !== undefined
				) {
					this.moduleGetters.add(declared);
				}
				if (this.emittedNames.has(declared) || this.companionClaims.has(declared)) {
					let binding = `${plainName(owner)}_${plainName(declared)}`;
					while (this.emittedNames.has(binding) || this.moduleNames.has(binding)) binding += '_';
					renames.set(declared, binding);
				} else {
					renames.delete(declared);
				}
				this.companionClaims.add(declared);
				this.moduleNames.add(declared);
			}
		}
		return renames;
	}

	/**
	 * Every companion member emitted for `owner`, reachable as `Owner.name`.
	 *
	 * Inside the class a companion member is a bare name and resolves
	 * lexically to its hoisted binding. From anywhere else Kotlin writes it
	 * through the class — `Holder.KEY`, `Layout.fromKey(…)` — and the emitted
	 * class had no such property, so the read answered `undefined` with
	 * nothing refused. A getter rather than a copy, so a companion `var`
	 * written after load is still the value read.
	 *
	 * `name`, `length` and `prototype` are a function's own, and not
	 * overwritten: a companion member spelled that way stays reachable bare.
	 */
	private companionStatics(owner: string, members: readonly CompanionMember[]): string {
		const lines: string[] = [];
		for (const member of members) {
			if (FUNCTION_OWN_NAMES.has(member.name)) continue;
			const value = member.getter ? `${member.binding}()` : member.binding;
			const write = member.mutable === true ? `, set: (__v) => { ${member.binding} = __v; }` : '';
			lines.push(
				`Object.defineProperty(${this.safe(owner)}, ${JSON.stringify(member.name)}, { get: () => ${value}${write}, enumerable: true, configurable: true });`
			);
		}
		return lines.join('\n');
	}

	private dataDeclaration(node: KNode, name: string): string | null {
		return this.member(name, node, () => {
			const params = this.primaryConstructorParams(node);
			this.signatures.set(
				name,
				params.map((param) => param.name)
			);
			this.moduleNames.add(name);

			// A DTO's own method reaches past an `apply {}` with `this@Dto.title`
			// — the record's field, shadowed by the model's field of the same
			// name. That label only resolves if the record is a named owner
			// here, and without it the member was refused for saying which of
			// two receivers it meant, which is the one thing that made it clear.
			const outerOwner = this.owner;
			const outerLabel = this.ownerLabel;
			const outerSelf = this.selfClass;
			this.owner = name;
			this.ownerLabel = this.nameOf(node) ?? name;
			// A `data class` is final, so its own name is the whole answer.
			this.selfClass = { name: this.nameOf(node) ?? name, exact: true };
			this.pushScope();
			// Declared out here because `finally` has to give the nested-type
			// names back, and a `const` inside the `try` is not in its scope.
			let scoped: {
				renames: ReadonlyMap<string, string>;
				restore: () => void;
			} | null = null;
			let outerRenames = this.companionRenames;
			let outerCompanion = this.companionMembers;
			try {
				const args = params.map((param) => {
					this.declare(param.name);
					return param.fallback === null
						? this.safe(param.name)
						: `${this.safe(param.name)} = ${this.expr(param.fallback)}`;
				});
				const fields = params.map(
					(param) => `${JSON.stringify(fieldName(param.name))}: ${this.safe(param.name)}`
				);

				const body = kids(node).find((child) => child.type === 'class_body');
				this.emittedTypes.add(name);
				scoped = this.scopeNestedTypes(kids(body), name);
				outerRenames = this.companionRenames;
				outerCompanion = this.companionMembers;
				this.companionRenames = this.registerCompanionNames(kids(body), name);
				this.companionMembers = [];
				const nested: string[] = [];
				const bodyMembers = kids(body);
				for (const [index, child] of bodyMembers.entries()) {
					if (child.type === 'getter' || child.type === 'setter') continue;
					if (child.type === 'function_declaration') {
						fields.push(this.functionDeclaration(child, 'method'));
						continue;
					}
					// A DTO's companion holds its own constants, and a nested
					// `data class` or `enum` is the shape of one of its fields.
					// All three hoist to module scope, as they do on a class.
					if (child.type === 'companion_object') {
						nested.push(...this.companion(child));
						continue;
					}
					if (child.type === 'class_declaration' || child.type === 'object_declaration') {
						const declared = this.nameOf(child) ?? 'object';
						const under = scoped?.renames.get(declared);
						const inner =
							child.type === 'class_declaration'
								? this.classDeclaration(child, under)
								: this.objectDeclaration(child, under ?? declared);
						if (inner !== null) nested.push(inner);
						continue;
					}
					if (child.type !== 'property_declaration') {
						this.refuse(child, `a \`${child.type}\` on a \`data class\``);
					}
					const member = this.propertyName(child);
					if (member === null) this.refuse(child, 'an unnamed property');
					const getter = accessorOf(child, bodyMembers[index + 1], 'getter');
					if (getter === undefined) {
						fields.push(`${JSON.stringify(member)}: ${this.propertyValue(child, member)}`);
						continue;
					}
					const inner = kids(getter).find((part) => part.type === 'function_body');
					if (inner === undefined) this.refuse(getter, 'a getter with no body');
					const emitted = this.functionScope('function', null, [], () => this.functionBody(inner));
					if (emitted.isAsync) this.refuse(getter, 'a suspending getter');
					fields.push(`get ${member}() ${emitted.text}`);
				}

				// Iterable, made iterable here too — see `iterationMembers`. The
				// parameters are this factory's own, in scope as locals.
				fields.push(...this.iterationMembers(node, bodyMembers, params, true));

				// Handed to `dataRecord` with its own factory and field order, so
				// `copy(count = 3)` can rebuild it: a computed property here
				// closes over the *parameters*, and a record copied field by
				// field would keep answering from the old ones.
				const record = `${this.helper('dataRecord')}(${block(fields.map(comma))}, ${this.safe(name)}, ${JSON.stringify(params.map((param) => fieldName(param.name)))})`;
				const factory = `function ${this.safe(name)}(${args.join(', ')}) ${block([`return ${record};`])}`;
				const statics = this.companionStatics(name, this.companionMembers);
				return [...nested, statics.length > 0 ? `${factory}\n${statics}` : factory].join('\n\n');
			} finally {
				this.companionRenames = outerRenames;
				this.companionMembers = outerCompanion;
				scoped?.restore();
				this.popScope();
				this.owner = outerOwner;
				this.ownerLabel = outerLabel;
				this.selfClass = outerSelf;
			}
		});
	}

	/**
	 * An enum's entries, and the three things Kotlin gives every enum class.
	 *
	 * `enum class Layout(val prefix: String) { SLUG(""), ROOT("/") ; fun
	 * url(slug) = … }` is a class with a fixed set of instances, and is emitted
	 * as one: each entry is `new Layout("SLUG", 0, "")`, so a method or a
	 * computed property on the enum is an ordinary method on the class. It was
	 * a frozen map of frozen records before, which could hold state but no
	 * behaviour — every member was refused — and which had no `entries`,
	 * `values()` or `valueOf()` either: `Layout.entries.map { … }` read
	 * undefined and mapped over nothing, in extensions that loaded and
	 * reported nothing refused.
	 *
	 * An entry with a body of its own is a subclass per entry, and is refused.
	 * So is one whose arguments read the enum's companion: Kotlin initialises
	 * entries first, and a companion `const` it inlined would here be a binding
	 * not yet written.
	 */
	private enumTail(
		name: string,
		node: KNode,
		entries: readonly KNode[],
		members: readonly KNode[]
	): string[] {
		const owner = this.safe(name);
		const companionNames = new Set<string>();
		for (const member of members) {
			if (member.type !== 'companion_object') continue;
			const inner = kids(member).find((part) => part.type === 'class_body');
			for (const part of kids(inner)) {
				const declared =
					part.type === 'property_declaration'
						? this.propertyName(part)
						: part.type === 'function_declaration'
							? this.nameOf(part)
							: null;
				if (declared !== null) companionNames.add(declared);
			}
		}
		// Under the enum's own name, so a refusal here is one the members that
		// mention the enum are held to.
		const emitted = this.member(name, node, () => {
			const lines: string[] = [];
			for (const [ordinal, entry] of entries.entries()) {
				const entryName = this.nameOf(entry);
				if (entryName === null) this.refuse(entry, 'an enum entry with no name');
				if (kids(entry).some((part) => part.type === 'class_body')) {
					this.refuse(entry, 'an enum entry with a body of its own');
				}
				const args = kids(kids(entry).find((part) => part.type === 'value_arguments')).filter(
					(part) => part.type === 'value_argument'
				);
				for (const arg of args) {
					for (const found of walk(arg)) {
						if (found.type === 'simple_identifier' && companionNames.has(found.text)) {
							this.refuse(found, 'an enum entry reading its own companion');
						}
					}
				}
				const passed = this.plainArguments(name, args);
				lines.push(
					`${owner}.${entryName} = new ${owner}(${[JSON.stringify(entryName), String(ordinal), ...passed].join(', ')});`
				);
			}
			const listed = entries.map((entry) => `${owner}.${this.nameOf(entry) ?? ''}`);
			lines.push(`${owner}.entries = Object.freeze([${listed.join(', ')}]);`);
			lines.push(`${owner}.values = function () { return ${owner}.entries.slice(); };`);
			lines.push(
				`${owner}.valueOf = function (value) { for (const entry of ${owner}.entries) if (entry.name === value) return entry; throw new Error(${JSON.stringify(`No enum constant ${name}.`)} + value); };`
			);
			return lines.join('\n');
		});
		return emitted === null ? [] : [emitted];
	}

	/** `object X { … }` → a frozen literal at module scope. */
	/**
	 * `object Helper { … }` → a frozen literal, one member at a time.
	 *
	 * Per member, exactly as a class body is, and that is the whole point.
	 * Refusing the object as a unit meant one `Injekt.get` in one method of a
	 * shared helper deleted the *object* — and the extension next door, whose
	 * only reachable method called `Helper.readEpisodes(response)`, still
	 * emitted that call against a name nothing declared any more. It converted,
	 * packaged, installed, and threw `Helper is not defined` at the first
	 * episode list. The member that could not be translated is the member that
	 * goes; whatever the object declares beside it is unaffected, which is what
	 * the class path has always done.
	 */
	private objectDeclaration(node: KNode, name: string): string | null {
		return this.declared(name, () => {
			const body = kids(node).find((child) => child.type === 'class_body');
			const members = kids(body);
			const fields: string[] = [];
			this.moduleNames.add(name);

			// Before the loop, so a member declared below the one calling it still
			// resolves — the order inside an `object XFilters` is helpers last as
			// often as helpers first.
			this.registerExtensions(members, 'module', name);
			this.registerObjectMembers(members, name);
			// Which of this object's constants another of its properties reads.
			// Those become module `const`s, in declaration order, because the
			// literal cannot refer to itself while it is being built.
			const sharedConstants = this.siblingConstants(members);

			const outerOwner = this.owner;
			const outerSelf = this.selfClass;
			this.owner = name;
			const dispatched = new Set<string>();
			// An `object` is its own only instance.
			this.selfClass = { name: this.nameOf(node) ?? name, exact: true };
			try {
				for (const [index, child] of members.entries()) {
					if (child.type === 'property_declaration') {
						const key = this.propertyName(child) ?? 'val';
						const outerProperty = this.emittingObjectProperty;
						this.emittingObjectProperty = name;
						let emitted: string | null;
						try {
							emitted = this.member(key, child, () => {
								const accessor = this.moduleGetter(child, members[index + 1], key);
								// An object's getter is a member of the literal, where
								// JavaScript has a `get` of its own to say it with. Its
								// body runs on read, so it may reach a sibling.
								if (accessor !== null) {
									this.emittingObjectProperty = outerProperty;
									return `get ${JSON.stringify(key)}() ${accessor}`;
								}
								// `private val GENRES_LIST by lazy { getPairListByIndex(0) }`
								// — inside an `object`, `lazy` is load-bearing rather than
								// decorative. The block reads a `lateinit` that the first
								// *search* assigns, so running it where the literal is built
								// runs it before there is anything to read; and the thunk
								// was called with no receiver at all, which is
								// "Cannot read properties of undefined" at LOAD, taking
								// every member of the bundle with it.
								//
								// A getter has the object as its `this` and runs on first
								// read. `lazy` also memoises, and a frozen literal has
								// nowhere to memoise *into*, so the cache is hoisted beside
								// it: a block with a side effect must still run once.
								const delegate = kids(child).find((part) => part.type === 'property_delegate');
								if (delegate !== undefined && this.nameOf(kids(delegate)[0]) === 'lazy') {
									this.emittingObjectProperty = outerProperty;
									const cache = this.lazyCache(name);
									const thunk = this.delegateValue(delegate, child, key);
									return `get ${JSON.stringify(key)}() { return ${cache}.${fieldName(key)} ??= (${thunk}).call(this); }`;
								}
								if (sharedConstants.has(key)) {
									// Built rather than resolved: this is the emitter's own name,
									// so it does not go through `safe`, which exists to keep a
									// name read out of Kotlin from colliding with one of these.
									const alias = `__const_${plainName(name)}_${plainName(key)}`;
									this.objectAliases.set(`${name}.${key}`, alias);
									// Pushed before the literal, and in declaration order, so a
									// constant reading the one above it still reads it.
									this.hoisted.push(`const ${alias} = ${this.propertyValue(child, key)};`);
									return `${JSON.stringify(key)}: ${alias}`;
								}
								return `${JSON.stringify(key)}: ${this.propertyValue(child, key)}`;
							});
						} finally {
							this.emittingObjectProperty = outerProperty;
						}
						if (emitted !== null) fields.push(emitted);
						continue;
					}
					// Consumed by the property above it; see `accessorOf`.
					if (child.type === 'getter' || child.type === 'setter') continue;
					if (child.type === 'function_declaration') {
						const fnName = this.nameOf(child) ?? 'fun';
						// See `overloadsOf`, and the dispatcher written after the loop.
						const key =
							this.overloadsOf(fnName) === null
								? fnName
								: `${fnName}$${this.signatureOf(child).key}`;
						const emitted = this.member(
							fnName,
							child,
							() => `${JSON.stringify(key)}: ${this.functionDeclaration(child, 'anonymous')}`
						);
						if (emitted !== null) {
							fields.push(emitted);
							if (key !== fnName) dispatched.add(fnName);
						}
						continue;
					}
					// A `object Filters { class GenreFilter … }` holds types, not
					// values. They hoist to module scope, as they do on a class.
					if (child.type === 'class_declaration' || child.type === 'object_declaration') {
						const inner =
							child.type === 'class_declaration'
								? this.classDeclaration(child)
								: this.objectDeclaration(child, this.nameOf(child) ?? 'object');
						if (inner !== null) this.hoisted.push(inner);
						continue;
					}
					this.refuse(child, spoken(child));
				}
			} finally {
				this.owner = outerOwner;
				this.selfClass = outerSelf;
			}

			// The object's plain names, resolved against the object itself
			// rather than `this`: a function taken off it as a value — passed to
			// `map`, say — arrives with no receiver, and the object is a
			// singleton, so naming it is exact.
			const self = this.safe(name);
			const ownFields = this.classFieldIndex.get(name) ?? new Set<string>();
			for (const fnName of dispatched) {
				if (ownFields.has(fnName)) continue;
				const shapes = this.overloadsOf(fnName) ?? [];
				fields.push(
					`${JSON.stringify(fnName)}: function (...__a) { return ${this.helper('overload')}(${self}, ${self}, ${JSON.stringify(fnName)}, __a, ${overloadTable(fnName, shapes)}, () => __super); }`
				);
			}

			const literal = `const ${self} = Object.freeze(${block(fields.map(comma))});`;
			// `object X : JsonTransformingSerializer<T>(ListSerializer(Item.serializer()))`
			// — the typed decoder runs X's `transformDeserialize` and then the
			// base serializer, which it can only do as "decode as this type".
			// That is exact when the base is built from default serializers,
			// so only that is accepted, and the type it decodes is recorded.
			const invoked = this.baseInvocation(node);
			if (invoked?.type !== 'JsonTransformingSerializer') return literal;
			const written = invoked.args.find((arg) => arg.type === 'value_argument');
			const decodes =
				written === undefined ||
				invoked.args.filter((a) => a.type === 'value_argument').length !== 1
					? null
					: defaultSerializerType(written.text.replace(/\s+/g, ''));
			if (decodes === null) {
				this.refuse(node, `a \`JsonTransformingSerializer\` over \`${describe(written ?? node)}\``);
			}
			return `${literal}\n${this.helper('transforms')}(${self}, ${JSON.stringify(decodes)});`;
		});
	}

	/**
	 * A companion object's members, hoisted to module scope.
	 *
	 * Kotlin code refers to them by bare name from inside the class, so hoisting
	 * to a module `const` makes that resolve lexically with no rewriting. Two
	 * companions in one file declaring the same name would collide; the second
	 * is refused rather than silently shadowing the first.
	 */
	private companion(node: KNode): string[] {
		// Hoisted to module scope, with no `this` of the class's: see `selfClass`.
		const outerSelf = this.selfClass;
		this.selfClass = null;
		try {
			return this.companionBody(node);
		} finally {
			this.selfClass = outerSelf;
		}
	}

	private companionBody(node: KNode): string[] {
		const body = kids(node).find((child) => child.type === 'class_body');
		const out: string[] = [];
		const members = kids(body);

		for (const [index, child] of members.entries()) {
			if (child.type === 'getter' || child.type === 'setter') continue;
			if (child.type === 'property_declaration') {
				const name = this.propertyName(child) ?? 'val';
				const binding = this.companionRenames.get(name) ?? name;
				const emitted = this.member(name, child, () => {
					if (this.emittedNames.has(binding)) {
						this.refuse(child, `a second companion member named \`${name}\``);
					}
					// `private val LATEST_PREF_ENTRIES get() = arrayOf(…)` — a
					// computed property, which is a *function* at module scope and
					// not a value. Read as a value it has no initialiser at all,
					// and the companion refused for a member the class computes
					// on every read. `moduleGetters` is what makes the call sites
					// add the parentheses back.
					const getter = accessorOf(child, members[index + 1], 'getter');
					if (getter !== undefined) {
						const body = kids(getter).find((part) => part.type === 'function_body');
						if (body === undefined) this.refuse(getter, 'a getter with no body');
						const emittedBody = this.functionScope('function', null, [], () =>
							this.functionBody(body)
						);
						this.moduleNames.add(name);
						this.moduleGetters.add(name);
						this.emittedNames.add(binding);
						this.companionMembers.push({ name, binding: this.safe(name), getter: true });
						const prefix = emittedBody.isAsync ? 'async ' : '';
						return `${prefix}function ${this.safe(name)}() ${emittedBody.text}`;
					}
					const value = this.propertyValue(child, name);
					this.moduleNames.add(name);
					this.emittedNames.add(binding);
					// A companion `var` is assigned after load — `counter += 1`,
					// a cache filled on first use — and a `const` throws there.
					const mutable = kids(child).some(
						(part) => part.type === 'binding_pattern_kind' && part.text === 'var'
					);
					this.companionMembers.push({ name, binding: this.safe(name), getter: false, mutable });
					return `${mutable ? 'let' : 'const'} ${this.safe(name)} = ${value};`;
				});
				if (emitted !== null) out.push(emitted);
				continue;
			}
			if (child.type === 'function_declaration') {
				const name = this.nameOf(child) ?? 'fun';
				const emitted = this.member(name, child, () => {
					this.moduleNames.add(name);
					const text = this.functionDeclaration(child, 'module');
					// An extension function takes its receiver first, and is not
					// something a caller reaches as `Owner.name(…)`.
					if (receiverOf(child) === null) {
						this.companionMembers.push({ name, binding: this.safe(name), getter: false });
					}
					return text;
				});
				if (emitted !== null) out.push(emitted);
				continue;
			}
			// A companion holding a nested DTO or object hoists it too: it is
			// already at module scope as far as the emitted code is concerned.
			if (child.type === 'class_declaration' || child.type === 'object_declaration') {
				const emitted =
					child.type === 'class_declaration'
						? this.classDeclaration(child)
						: this.objectDeclaration(child, this.nameOf(child) ?? 'object');
				if (emitted !== null) out.push(emitted);
				continue;
			}
			this.declineMember(this.nameOf(child) ?? spoken(child), child, spoken(child));
		}

		return out;
	}

	/* ── members ─────────────────────────────────────────────────────────── */

	/**
	 * Translates one member, or records why it will not be.
	 *
	 * The pre-scan is why a refusal can list every obstacle in a member: it
	 * walks the whole subtree before anything is emitted. Whatever the emitter
	 * itself then trips over — a non-local `return`, an unlisted method name —
	 * arrives one at a time, which is enough, because by then the member is
	 * already lost.
	 */
	/**
	 * Every member this file began is in exactly one of the two lists.
	 *
	 * The invariant the whole layer rests on, checked rather than trusted.
	 * `member()` records a member in `graph` before it attempts anything and
	 * then either translates it or refuses it, so a name in `graph` and in
	 * neither list is a member that vanished — the failure `reader.ts`'s header
	 * describes, one level down, and the one failure a converted bundle cannot
	 * report because there is nothing left to report it. A refusal here costs
	 * the extension; a silent omission costs whoever installs it.
	 */
	private auditMembers(): void {
		const accounted = new Set(this.translated);
		for (const refusal of this.refusals) accounted.add(refusal.member);
		for (const edges of this.graph) {
			if (accounted.has(edges.member)) continue;
			accounted.add(edges.member);
			this.refusals.push({
				member: edges.member,
				obstacles: [
					{
						kind: 'a member this build neither translated nor named',
						line: 1,
						memberName: edges.member
					}
				]
			});
		}
	}

	/**
	 * A declaration whose *members* are the unit of refusal, like a class body.
	 *
	 * `member()` scans its whole node for obstacles before running, which is
	 * right for one method and wrong for a declaration that holds several: one
	 * out-of-scope call anywhere inside deleted the lot. So there is no wrapper
	 * here — the members inside supply their own — and the name is registered
	 * before the body runs, because a member of the object can name the object.
	 */
	private declared(name: string, run: () => string): string | null {
		this.moduleNames.add(name);
		return run();
	}

	private member(
		name: string,
		node: KNode,
		run: () => string,
		/**
		 * A property's accessors when they are its siblings rather than its
		 * children — see `classProperty`. What a setter calls is as much the
		 * property's edge as what its initialiser does, and an edge left out
		 * lets reachability prune a refusal the setter still calls into.
		 */
		accessors: readonly KNode[] = [],
		/**
		 * The parts of `node` that will actually be emitted, when that is not
		 * all of it — only ever a `recoveryCut`. Edges and the obstacle scan are
		 * read off these alone: the cut-off tail is never emitted, so what it
		 * would have called is not reachable from here and what it would have
		 * refused for is not this member's to answer.
		 */
		scope: readonly KNode[] | null = null
	): string | null {
		const parts = scope ?? [node, ...accessors];
		// Recorded before anything is attempted, so a refused member still has
		// edges — a member reachable only from one has to stay reachable.
		this.graph.push({
			member: name,
			owner: this.owner,
			construction: node.type === 'property_declaration',
			lazy:
				node.type === 'property_declaration' &&
				!this.hasModifier(node, 'override') &&
				kids(node).some(
					(child) => child.type === 'property_delegate' && /^by\s+lazy\b/.test(child.text)
				),
			references: [...new Set(parts.flatMap((one) => mentions(one)))],
			calls: parts.flatMap((one) => callEdges(one))
		});

		const previousName = this.memberName;
		const previousPending = this.pending;
		this.memberName = name;
		this.pending = [];

		// The node alone when there is no cut, as before it: a setter written
		// beside its property is scanned where it is emitted, not here.
		const obstacles = (scope ?? [node]).flatMap((one) => scanObstacles(one, name));
		if (obstacles.length > 0) {
			this.refusals.push({ member: name, obstacles });
			this.memberName = previousName;
			this.pending = previousPending;
			return null;
		}

		const usedBefore = new Set(this.used);
		const scopeDepth = this.scopes.length;
		const frameDepth = this.frames.length;
		const hoistedBefore = this.hoisted.length;
		// A `fun Element.x()` declared *inside* a member is in scope for that
		// member and nowhere else. Left registered, the member next door would
		// emit `x(element)` for a name that is no longer declared anywhere — a
		// ReferenceError inside a sandbox, which is the failure this whole file
		// converts into refusals.
		const extensionsBefore = new Map(this.extensionFunctions);
		try {
			const emitted = run();
			this.translated.push(name);
			return emitted;
		} catch (error) {
			if (!(error instanceof Refused)) throw error;
			// Helpers a refused member would have called are not promises the
			// runtime has to keep, and a type it lifted out of itself has nothing
			// left to reference it, so both are rolled back.
			this.used = usedBefore;
			this.hoisted.length = hoistedBefore;
			this.refusals.push({
				member: name,
				obstacles:
					this.pending.length > 0
						? this.pending
						: [{ kind: spoken(node), line: node.line, memberName: name }]
			});
			return null;
		} finally {
			this.memberName = previousName;
			this.pending = previousPending;
			this.scopes.length = scopeDepth;
			this.frames.length = frameDepth;
			this.localSuspends.clear();
			this.extensionFunctions.clear();
			for (const [name, shape] of extensionsBefore) this.extensionFunctions.set(name, shape);
		}
	}

	/**
	 * `member`, with one second chance: an interceptor whose only trouble is in
	 * the recovery it runs after a pass-through guard.
	 *
	 * The shape, from a shared video-host extractor's `DdosGuardInterceptor`:
	 *
	 *     val response = chain.proceed(originalRequest)
	 *     if (response.code !in ERROR_CODES || response.header("Server") !in SERVER_CHECK) {
	 *         return response
	 *     }
	 *     …read the WebView's cookie store for a clearance cookie…
	 *
	 * Refused whole, that one member refused every extension that installs the
	 * extractor — sixteen in one catalogue that never reach the tail unless the
	 * hoster answers with a DDoS-Guard challenge — because an interceptor's
	 * `intercept` is reached the moment the class is (see `reach` in
	 * `pipeline.ts`) and a refused one cannot be pruned. Dropping it and letting
	 * the client call through would be the base-class fallback this project does
	 * not make: a challenged answer handed to the extractor as if it were the
	 * video page.
	 *
	 * So the member is emitted up to and including the guard, and the tail
	 * becomes `throw __k.recoveryRefused(…)` naming what it needed. Every answer
	 * the guard passes through behaves exactly as the Kotlin does; the one the
	 * Kotlin would have recovered from is an error with a name on it, raised
	 * where the recovery would have started. What the extension does with that
	 * error is its own business — the same as any other failed request.
	 *
	 * Taken only when the first attempt was refused, every obstacle it found
	 * sits in the tail, and at least one of them is a `RECOVERY_BOUNDARIES`
	 * name. A tail refused only for an ordinary translator gap stays refused,
	 * because that is ours to fix and a cut would hide it; a guard or prefix
	 * that does not translate stays refused, because then the pass-through is
	 * not what would run. The member is reported in `deferred` either way it
	 * is cut, so the boundary is still named.
	 */
	private memberWithRecovery(
		name: string,
		node: KNode,
		candidate: RecoveryCandidate | null,
		run: () => string
	): string | null {
		const refusalsBefore = this.refusals.length;
		const graphAt = this.graph.length;
		const first = this.member(name, node, run);
		if (first !== null || candidate === null) return first;

		const refusal = this.refusals[this.refusals.length - 1];
		if (this.refusals.length !== refusalsBefore + 1 || refusal.member !== name) return null;
		const late = refusal.obstacles.every((one) => one.line >= candidate.tailLine);
		const kinds = [
			...new Set(
				refusal.obstacles
					.map((one) => RECOVERY_BOUNDARIES.get(one.kind))
					.filter((one): one is string => one !== undefined)
			)
		];
		if (!late || kinds.length === 0) return null;

		const firstEdges = this.graph[graphAt];
		this.refusals.pop();
		this.graph.splice(graphAt, 1);
		this.cut = { body: candidate.body, keep: candidate.keep, owner: candidate.owner, kinds };
		const secondAt = this.graph.length;
		let second: string | null;
		try {
			second = this.member(name, node, run, [], candidate.kept);
		} finally {
			this.cut = null;
		}
		if (second !== null) {
			this.deferred.push(refusal);
			return second;
		}
		// The pass-through itself did not translate, so the cut buys nothing:
		// put back what the whole member was refused for, which is the more
		// useful thing to read.
		this.graph.splice(secondAt, 1);
		this.graph.splice(graphAt, 0, firstEdges);
		this.refusals.pop();
		this.refusals.push(refusal);
		return null;
	}

	private declineMember(name: string, node: KNode, kind: string): null {
		// Named the way its author would recognise it wherever there is a name;
		// a bare grammar kind in a message helps nobody read their own source.
		const spoken = OUT_OF_SCOPE_KINDS.get(kind) ?? kind;
		this.refusals.push({
			member: name,
			obstacles: [{ kind: spoken, line: node.line, memberName: name }]
		});
		return null;
	}

	private classProperty(
		node: KNode,
		detached: readonly KNode[] = []
	): { kind: 'assign' | 'member'; text: string; ctor?: string } | null {
		const name = this.propertyName(node);
		if (name === null) return this.declineMember('val', node, 'an unnamed property');

		const receiver = extensionReceiverOf(node);
		if (receiver === 'SharedPreferences' && this.extensionProperties.has(name)) {
			const text = this.extensionProperty(node, name, detached);
			return text === null ? null : { kind: 'member', text };
		}

		// `protected abstract val isHentaiSite: Boolean` — a property this class
		// deliberately does not define, because the subclass is required to.
		// The same argument the abstract *function* above makes: there is
		// nothing to emit and nothing missing, and refusing it refused the
		// template over the one member that was never meant to have a value.
		if (this.hasModifier(node, 'abstract')) return null;

		const delegate = kids(node).find((child) => child.type === 'property_delegate');
		const getter =
			accessorOf(node, undefined, 'getter') ?? detached.find((one) => one.type === 'getter');
		const setter =
			accessorOf(node, undefined, 'setter') ?? detached.find((one) => one.type === 'setter');

		// `private lateinit var filterList: AnimeFilterList` — declared here,
		// assigned before anything reads it. There is no value to emit, and in
		// JavaScript a field that has not been assigned is simply not there yet,
		// which is the same state `lateinit` describes.
		//
		// The one difference is what a read *before* the assignment does: Kotlin
		// throws `UninitializedPropertyAccessException` and this answers
		// `undefined`. That path does not exist in a compiled extension — the
		// declaration is `lateinit` precisely because its author knew the
		// assignment came first — and the alternative is refusing a class for a
		// property it fills in one line later.
		if (this.hasModifier(node, 'lateinit')) return null;

		if (delegate !== undefined) {
			const text = this.member(name, node, () => {
				const initialiser = this.delegateValue(delegate, node, name);
				return this.overridable(
					name,
					`get ${name}() ${block([`return ${this.helper('lazy')}(this, ${JSON.stringify(name)}, ${initialiser});`])}`
				);
			});
			return text === null ? null : { kind: 'member', text };
		}

		const mutableProperty = kids(node).some(
			(child) => child.type === 'binding_pattern_kind' && child.text === 'var'
		);
		const backed = this.backedAccessors(node, getter, setter, mutableProperty);
		if (backed !== undefined) return backed;

		if (getter !== undefined) {
			const text = this.member(
				name,
				node,
				() => {
					const body = kids(getter).find((child) => child.type === 'function_body');
					if (body === undefined) this.refuse(getter, 'a getter with no body');
					const emitted = this.accessorScope(null, () =>
						this.functionScope('function', null, [], () => this.functionBody(body))
					);
					if (emitted.isAsync) this.refuse(getter, 'a suspending getter');
					return this.overridable(name, `get ${name}() ${emitted.text}`);
				},
				[getter]
			);
			return text === null ? null : { kind: 'member', text };
		}

		// `private val apiHeaders = headers.newBuilder()…` reads a member the
		// *base class* owns, and the driver attaches the base after the
		// subclass's constructor has run — so a constructor assignment reads
		// `undefined` and the bundle dies at load, naming JavaScript rather than
		// the extension. A memoised getter defers the read to the first use and
		// still evaluates once, which is what the Kotlin `val` promised; it is
		// the same shape `by lazy` already gets, for the same reason.
		//
		// The second reason is the same argument about the same moment.
		// `val salted = "Salted__".toByteArray(Charsets.UTF_8)` is a constant
		// that happens to need the host's encoder, and no context has been
		// entered while a constructor is running — so it threw at load, in 7 of
		// the measured bundles, with a message about the network.
		//
		// Which helpers those are is not guessed from the text: the set of
		// helpers this initialiser reached is the difference `propertyValue`
		// makes to `used`, and `HOST_BACKED_HELPERS` is the list the runtime's
		// own spec keeps honest.
		const initialiser = kids(node).find((child) => !PROPERTY_PARTS.has(child.type));
		const mutable = kids(node).some(
			(child) => child.type === 'binding_pattern_kind' && child.text === 'var'
		);
		const readsBase = !mutable && initialiser !== undefined && this.readsBaseMember(initialiser);

		let deferred = readsBase;
		const text = this.member(name, node, () => {
			const before = new Set(this.used);
			const outerInitialising = this.initialising;
			const outerSelfRead = this.superSelfRead;
			this.initialising = name;
			this.superSelfRead = false;
			let value: string;
			let readItsBase: boolean;
			try {
				value = this.propertyValue(node, name);
				readItsBase = this.superSelfRead;
			} finally {
				this.initialising = outerInitialising;
				this.superSelfRead = outerSelfRead;
			}
			if (!mutable && !deferred) {
				for (const helper of this.used) {
					if (before.has(helper)) continue;
					if (!HOST_BACKED_HELPERS.has(helper as RuntimeHelper)) continue;
					deferred = true;
					break;
				}
			}
			// A getter runs after the template's constructor assignment has
			// already been replaced by this one's setter, so `this.name` there
			// is not the base value any more. See `navigation`.
			if (deferred && readItsBase) this.refuse(node, '`super.` used as a property');
			return deferred
				? this.overridable(
						name,
						`get ${name}() ${block([
							`return ${this.helper('lazy')}(this, ${JSON.stringify(name)}, () => ${value});`
						])}`
					)
				: `this.${name} = ${value};`;
		});
		return text === null ? null : { kind: deferred ? 'member' : 'assign', text };
	}

	/**
	 * `private val SharedPreferences.quality get() = getString(KEY, DEFAULT)!!`
	 * — a property of the settings store, declared inside the extension.
	 *
	 * This ecosystem keeps every setting behind one of these, and reads it as
	 * `preferences.quality`. The receiver used to be dropped: the property was
	 * emitted as the *extension's* own getter, `getString` inside it resolved
	 * to the extension, and the read went to the store object, which has no
	 * such field. Every setting read answered `undefined` with nothing refused
	 * — one source sorted its videos by `undefined`, another never knew whether
	 * adult titles were allowed, a third put the string "undefined" in the
	 * URL where the debrid token goes. The delegated spelling on its own line
	 * did not parse at all (see `delegateOnNextLine` in `grammar.ts`).
	 *
	 * Now it is a method taking its receiver, `__ext_quality(__recv)`, and a
	 * read through the store calls it (`extensionPropertyRead`). Three bodies:
	 *
	 * - a getter, run with `this` meaning the receiver, exactly as an extension
	 *   function's body is — and a setter beside it becomes
	 *   `__ext_set_quality(__recv, value)`, which a write through the store
	 *   calls (`preferences.slugMap += more` reads, adds and writes);
	 * - `by preferences.delegate(KEY, DEFAULT)`, the store's own delegate, read
	 *   on every access as Kotlin reads it — the receiver is not consulted,
	 *   because the delegate was bound to `preferences` where it was declared;
	 * - `by lazy { … }` / `by LazyMutable { … }`, whose one delegate object
	 *   lives in the extension instance, so the value is computed once per
	 *   instance whatever receiver it is read through — memoised on `this`.
	 *
	 * Only on `SharedPreferences`, which is the receiver every read can be
	 * recognised by (`isPreferencesStore`). A write with no setter to call, a
	 * delegated one, and a bare read through an implicit receiver are refused.
	 *
	 * **Not done: any other receiver.** `private val Element.imgSrc get() = …`
	 * read as `img.imgSrc` still goes out the way it always did — as the
	 * extension's own getter, read off the element, which answers `undefined`.
	 * Telling `chapter.id` (the extension property on `SChapter`) from `tag.id`
	 * (a DTO's field) needs the receiver's type, which this build does not
	 * have. Refusing them instead would drop the handful of listings that load
	 * today with one wrong field, and that is a decision, not a fix.
	 */
	private extensionProperty(node: KNode, name: string, detached: readonly KNode[]): string | null {
		const getter =
			accessorOf(node, undefined, 'getter') ?? detached.find((one) => one.type === 'getter');
		const setter =
			accessorOf(node, undefined, 'setter') ?? detached.find((one) => one.type === 'setter');
		const delegate = kids(node).find((child) => child.type === 'property_delegate');
		const method = `__ext_${name}`;
		return this.member(
			name,
			node,
			() => {
				if (delegate !== undefined) {
					if (setter !== undefined) this.refuse(setter, 'a setter beside a `by` delegate');
					const thunk = this.delegateValue(delegate, node, name);
					const memoised = /^by\s+(?:lazy|LazyMutable)\b/.test(delegate.text);
					const value = memoised
						? `${this.helper('lazy')}(this, ${JSON.stringify(method)}, ${thunk})`
						: `(${thunk})()`;
					const read = `${method}(__recv) ${block([`return ${value};`])}`;
					// `private var SharedPreferences.latestId by preferences
					// .delegate(KEY, DEFAULT)`, then `preferences.latestId = id`:
					// keiyoushi's delegate writes the key it reads, so the write
					// goes through the store's editor to the same key — the per-run
					// overlay every `edit().put…()` lands in — and the next read,
					// which is not memoised, answers it.
					const key = preferenceDelegateOf(node);
					if (key === null) return read;
					const written = this.expr(kids(key)[0] ?? key);
					return `${read}\n__ext_set_${name}(__recv, __v) ${block([
						`${this.helper('prefs')}().edit().putString(${written}, __v).apply();`
					])}`;
				}
				if (getter === undefined) this.refuse(node, 'an extension property with no getter');
				const read = this.extensionAccessor(getter, name, []);
				if (setter === undefined) return `${method}(__recv) ${read}`;
				// `set(map) { cache = map; edit().putString(KEY, …).apply() }`: the
				// setter's own parameter, and the receiver as `this`, as the getter.
				const parameter = [...walk(setter)].find((one) => one.type === 'simple_identifier')?.text;
				if (parameter === undefined) this.refuse(setter, 'a setter with no parameter');
				const write = this.extensionAccessor(setter, name, [parameter]);
				return `${method}(__recv) ${read}\n__ext_set_${name}(__recv, ${this.safe(parameter)}) ${write}`;
			},
			[...(getter === undefined ? [] : [getter]), ...(setter === undefined ? [] : [setter])]
		);
	}

	/** A getter or setter body, run with the receiver as `this`. */
	private extensionAccessor(accessor: KNode, name: string, params: readonly string[]): string {
		const body = kids(accessor).find((child) => child.type === 'function_body');
		if (body === undefined) this.refuse(accessor, 'an accessor with no body');
		const previousReceiver = this.receiverParam;
		const previousLabel = this.receiverLabel;
		const previousType = this.receiverType;
		this.receiverParam = '__recv';
		this.receiverLabel = name;
		this.receiverType = 'SharedPreferences';
		let emitted;
		try {
			emitted = this.accessorScope(null, () =>
				this.functionScope('function', null, ['__recv', ...params], () => this.functionBody(body))
			);
		} finally {
			this.receiverParam = previousReceiver;
			this.receiverLabel = previousLabel;
			this.receiverType = previousType;
		}
		if (emitted.isAsync) this.refuse(accessor, 'a suspending accessor');
		return emitted.text;
	}

	/**
	 * `preferences.quality`, where `quality` is an extension property this
	 * class declares on the store: a call of the method it became. Null when
	 * the read is not one of those.
	 *
	 * The receiver has to be the store for the rewrite, and the Kotlin says it
	 * is: the source compiled, and a `SharedPreferences` has no member of its
	 * own by these names, so `preferences.quality` resolving to the extension
	 * is what made it compile. Any other receiver reading the same name is
	 * some other object's field — `video.quality` — and is left alone, unless
	 * it looks like a store this build cannot type, which is refused rather
	 * than read off the wrong object.
	 */
	private extensionPropertyRead(node: KNode): string | null {
		const parts = kids(node);
		if (parts.length !== 2 || parts[1].type !== 'navigation_suffix') return null;
		const name = kids(parts[1]).find((child) => child.type === 'simple_identifier')?.text;
		if (name === undefined || !this.extensionProperties.has(name)) return null;
		const receiver = parts[0];
		if (this.isPreferencesStore(receiver)) {
			// The receiver first: emitting it is what marks a receiver block as
			// needing `__self`, which `selfReference` then answers with.
			const store = this.expr(receiver);
			return `${this.selfReference()}.__ext_${name}(${store})`;
		}
		if (/pref/i.test(receiver.text)) {
			this.refuse(node, `a read of extension property \`${name}\` this build cannot type`);
		}
		return null;
	}

	/** A name in `preferenceStores`, bare or through `this.`, meaning the class's store. */
	private isPreferencesStore(receiver: KNode): boolean {
		const text = receiver.text.replace(/\s+/g, '');
		const named = text.startsWith('this.') ? text.slice(5) : text;
		if (!this.preferenceStores.has(named)) return false;
		return text !== named || this.lookup(named) === null;
	}
	/**
	 * A property whose accessors need a backing field, or that has a setter.
	 *
	 * `var buildId = "" get() { if (field == "") field = fetch(); return field }`
	 * is how this ecosystem memoises, and `var fontSize: Int get() = … set(v)
	 * = prefs.put(v)` how it stores a setting. Kotlin gives the first a
	 * backing field because an accessor names `field`, and any property whose
	 * getter or setter is left at its default has one too. The field is a
	 * plain property of the instance here, `__field_<name>`, assigned its
	 * initial value in the constructor where Kotlin assigns it, and `field`
	 * inside either accessor reads and writes it.
	 *
	 * Answers `undefined` for a property this is not — a getter alone that
	 * never names `field`, which keeps the overridable shape above — so the
	 * caller carries on. An accessor with no body (`private set`) is the
	 * default one with a narrower visibility, and is emitted as the default.
	 */
	private backedAccessors(
		node: KNode,
		getter: KNode | undefined,
		setter: KNode | undefined,
		mutable: boolean
	): { kind: 'member'; text: string; ctor?: string } | null | undefined {
		const usesField = [getter, setter].some((one) => one !== undefined && namesField(one));
		if (setter === undefined && !usesField) return undefined;
		const name = this.propertyName(node);
		if (name === null) return undefined;
		const storage = `__field_${plainName(name)}`;
		const getterBody = kids(getter).find((child) => child.type === 'function_body');
		const setterBody = kids(setter).find((child) => child.type === 'function_body');
		// Kotlin's own rule: a default accessor reads or writes the field.
		const hasField = usesField || getterBody === undefined || (mutable && setterBody === undefined);
		let ctor: string | undefined;
		const text = this.member(
			name,
			node,
			() => {
				const initialiser = kids(node).find((child) => !PROPERTY_PARTS.has(child.type));
				if (hasField && initialiser !== undefined) {
					// Assigned in the constructor, and so run before the driver has
					// attached the base class: an initial value that reads one of its
					// members cannot be deferred the way a plain `val` is, because the
					// accessors own the field from the first read.
					if (this.readsBaseMember(initialiser)) {
						this.refuse(initialiser, 'a backing field whose initial value reads the base class');
					}
					ctor = `this.${storage} = ${this.propertyValue(node, name)};`;
				}
				const read = hasField ? storage : null;
				const get =
					getterBody === undefined
						? `get ${name}() ${block([`return this.${storage};`])}`
						: `get ${name}() ${this.accessorBody(getter ?? node, getterBody, read, [])}`;
				let set: string;
				if (setter !== undefined && setterBody !== undefined) {
					const param = kids(setter).find((child) => child.type === 'parameter_with_optional_type');
					const value = param === undefined ? 'value' : boundName(param);
					set = `set ${name}(${this.safe(value)}) ${this.accessorBody(setter, setterBody, read, [value])}`;
				} else if (mutable) {
					set = `set ${name}(__v) ${block([`this.${storage} = __v;`])}`;
				} else {
					// A `val`: nothing in Kotlin assigns it but an override, which is
					// what `overridable` is for.
					return this.overridable(name, get);
				}
				return `${get}\n${set}`;
			},
			[getter, setter].filter((one): one is KNode => one !== undefined)
		);
		if (text === null) return null;
		return ctor === undefined ? { kind: 'member', text } : { kind: 'member', text, ctor };
	}

	/** One accessor's body, with `field` meaning the backing field if there is one. */
	private accessorBody(
		accessor: KNode,
		body: KNode,
		storage: string | null,
		params: readonly string[]
	): string {
		const emitted = this.accessorScope(storage, () =>
			this.functionScope('function', null, params, () => this.functionBody(body))
		);
		if (emitted.isAsync) {
			this.refuse(
				accessor,
				accessor.type === 'setter' ? 'a suspending setter' : 'a suspending getter'
			);
		}
		return emitted.text;
	}

	/** Runs an accessor's emission with `field` bound to its storage, or to nothing. */
	private accessorScope<T>(storage: string | null, run: () => T): T {
		const outerBacking = this.backing;
		const outerIn = this.inAccessor;
		this.backing = storage;
		this.inAccessor = true;
		try {
			return run();
		} finally {
			this.backing = outerBacking;
			this.inAccessor = outerIn;
		}
	}

	/**
	 * A getter a subclass is allowed to overwrite with a plain value.
	 *
	 * `protected open val mangaSubString get() = "manga"` on a template, and
	 * `override val mangaSubString = "comics-new"` on the extension built from
	 * it, is ordinary Kotlin: the override has a backing field where the base
	 * had a computed value. Emitted as written, the second is
	 * `this.mangaSubString = "comics-new"` against a prototype accessor with no
	 * setter — which in an ES module is strict mode, so it **throws**:
	 * "Attempted to assign to readonly property", inside the constructor, at
	 * load, taking the whole bundle.
	 *
	 * It is not a rare shape. Measured over 300 listings of a real catalogue it
	 * was 30 of the 47 bundles that converted cleanly and then died on import —
	 * which is why it is fixed here, where every getter this emitter writes
	 * passes, rather than at the assignment: the base and the subclass are
	 * routinely in different files, and the one that has to know is the one
	 * being assigned to.
	 *
	 * `defineProperty` rather than a backing field, because the own property it
	 * creates is what every later read finds — the same thing Kotlin's backing
	 * field does to the inherited getter. A `val` is never assigned in valid
	 * Kotlin except by an override, so nothing else can reach this.
	 */
	private overridable(name: string, getter: string): string {
		return `${getter}\nset ${name}(__v) ${block([
			`Object.defineProperty(this, ${JSON.stringify(name)}, ` +
				`{ value: __v, writable: true, enumerable: true, configurable: true });`
		])}`;
	}

	/**
	 * True when this initialiser reads something the base class supplies.
	 *
	 * `headers`, `client`, `json`, `preferences` — the members
	 * `shims/aniyomi-entry.ts` attaches, which do not exist yet while the
	 * subclass's own constructor is running. A name the class declares itself is
	 * not one of them, whatever it is called.
	 */
	private readsBaseMember(node: KNode): boolean {
		for (const found of walk(node)) {
			if (found.type !== 'simple_identifier') continue;
			// `private val imageHeaders = headersBuilder().set(…).build()` — a
			// member the driver's base supplies, called rather than read. The
			// call lands on `__super`, which the bundle declares after the
			// source is constructed, so run in the constructor it was
			// "Cannot access '__super' before initialization" at load. An
			// override the class declares itself is no different: it is
			// written to call `super.headersBuilder()`, which is the same
			// `__super`. Deferring one that does not is only later, not wrong.
			if (SUPER_MEMBERS.has(found.text)) return true;
			if (!BASE_SOURCE_MEMBERS.has(found.text)) continue;
			if (this.classMembers.has(found.text)) continue;
			return true;
		}
		return false;
	}

	/**
	 * The three `by` delegates this ecosystem actually uses, as a thunk.
	 *
	 * `by lazy { … }` is Kotlin's. The other two are dependency injection —
	 * `by injectLazy<Json>()` and `by getPreferencesLazy()` — and they are the
	 * second most common obstacle in the whole catalogue, because almost every
	 * extension gets its JSON parser and its settings store that way. Both ask
	 * for something the host already owns, so both resolve to it rather than
	 * being refused with the rest of Injekt: the container is out of reach, but
	 * these two particular things are not.
	 *
	 * A preferences store resolves to the runtime's own, which reads the
	 * manifest `settings` the conversion derived and writes to a per-run overlay
	 * (`KOTLIN_PREFS`). It used to resolve to `null` — the argument `__k.pref`
	 * ignores — which was right while a converted bundle declared no settings
	 * and wrong the moment one could, because `preferences.edit()` is how these
	 * extensions remember a mirror and `null.edit()` is not a fallback.
	 */
	private delegateValue(delegate: KNode, node: KNode, name: string): string {
		const call = kids(delegate)[0];
		const called = call === undefined ? null : this.nameOf(call);

		// LazyMutable computes once like lazy, then lets the property's
		// overridable setter replace the memoised value.
		if (called === 'lazy' || called === 'LazyMutable') {
			const lambda = this.lambdaOf(call);
			if (lambda === null) this.refuse(delegate, `a \`${called}\` without a block`);
			const body = this.functionScope('lambda', called, [], () => block(this.lambdaLines(lambda)));
			return `${body.isAsync ? 'async ' : ''}() => ${body.text}`;
		}

		if (called === 'getPreferencesLazy' || called === 'getPreferences') {
			return '() => __k.prefs()';
		}

		// `preferences.delegate(…)` is a call on a receiver, so its callee is a
		// navigation and the plain name lookup above answers the receiver.
		const trailing =
			call === undefined
				? null
				: (kids(kids(call).find((child) => child.type === 'navigation_expression'))
						.flatMap((part) => kids(part))
						.filter((part) => part.type === 'simple_identifier')
						.pop()?.text ?? null);

		if ((called === 'delegate' || trailing === 'delegate') && call !== undefined) {
			// `by preferences.delegate(PREF_DOMAIN, DEFAULT)` — keiyoushi's own
			// property delegate over the settings store. It is how an extension
			// lets a viewer move it to a new domain, so it is the `baseUrl` of a
			// growing number of these.
			//
			// Read through `__k.pref`, which is where `preferences.getString`
			// already goes, so the delegate and the explicit call answer the same
			// value from the same place.
			//
			// Memoised, like every other `by` delegate here: the value is read
			// once per instance rather than on each access as Kotlin's would be.
			// The difference is visible only if a viewer changes the setting
			// while the plugin is loaded, and it is the same bargain `by lazy`
			// already makes — stated here because it is a difference, not
			// because it is hidden.
			const suffix = kids(call).find((child) => child.type === 'call_suffix');
			const passed = kids(kids(suffix).find((child) => child.type === 'value_arguments'));
			if (passed.length < 2) this.refuse(delegate, 'a `delegate` without a key and a default');
			// The expression inside each `value_argument`, not the wrapper.
			const args = passed.map((argument) => this.expr(kids(argument)[0] ?? argument));
			return `() => ${this.helper('pref')}(${this.helper('prefs')}(), ${args.join(', ')})`;
		}

		if (called === 'injectLazy' || called === 'inject') {
			// The type is on the call in `by injectLazy<Json>()` and on the
			// property in `private val json: Json by injectLazy()`; both spell
			// the same thing, so both are looked at.
			const wanted = kids(kids(call).find((child) => child.type === 'call_suffix')).find(
				(child) => child.type === 'type_arguments'
			);
			const asked = wanted === undefined ? this.declaredType(node) : typeName(kids(wanted)[0]);
			if (asked === null || !GLOBAL_NAMES.has(asked)) {
				this.refuse(delegate, `\`by injectLazy<${asked ?? '?'}>()\``);
			}
			return `() => ${asked}`;
		}

		this.refuse(delegate, `a \`by\` delegate on \`${name}\` other than \`lazy\``);
	}

	/**
	 * Notes every type this file declares and the methods it carries.
	 *
	 * Recurses through class, object and companion bodies, because every one of
	 * those hoists to module scope when it is emitted — but never into a
	 * function body, where `hoistLocal` does the registering and needs to see
	 * an unclaimed name in order to detect a collision.
	 *
	 * `topLevel` is true for the file's own children; the first class among
	 * them is the extension itself, whose members belong to `classMembers` and
	 * not to the passthrough table. See `declaredMethods`.
	 */
	private registerTypes(declarations: readonly KNode[], topLevel: boolean): void {
		// Names first, in full, because whether a class is the *extension* is
		// decided by whether its base class is one of these — and a Kotlin file
		// puts the base it declares itself below the class extending it.
		if (topLevel) {
			this.registerTypeNames(declarations);

			// File-scope `const val`s and functions, for the same reason the
			// companion's members are declared before anything is translated:
			// a Kotlin file puts its `private const val DEFAULT_REFERER = …` at
			// the *bottom*, and registering the name only as it is emitted left
			// every member above it reading an unresolved capital and refusing.
			// An extension function is deliberately not here — `registerExtensions`
			// claims those, and they are called with their receiver moved.
			for (const [index, child] of declarations.entries()) {
				if (child.type === 'property_declaration') {
					const declared = this.propertyName(child);
					if (declared === null) continue;
					this.moduleNames.add(declared);
					this.moduleValues.add(declared);
					// Before emission, for the same reason the name is: a member
					// above the declaration reads it, and reading it is a call.
					if (accessorOf(child, declarations[index + 1], 'getter') !== undefined) {
						this.moduleGetters.add(declared);
					}
					continue;
				}
				if (child.type === 'function_declaration' && receiverOf(child) !== null) {
					// Not a module *value* — it takes its receiver first, so the
					// bare name is not what a reader of it writes — but it is a
					// module-scope function, and a file next door has to be able
					// to find it. `moduleSuspends` for the same reason a
					// file-scope `suspend fun` needs it: the await is invisible
					// at the call and a promise is not.
					const declared = this.nameOf(child);
					if (declared === null) continue;
					this.declaredModuleExtensions.add(declared);
					if (this.hasModifier(child, 'suspend') || BLOCKING_CALLS.test(child.text)) {
						this.moduleSuspends.add(declared);
					}
					continue;
				}
				if (child.type === 'function_declaration' && receiverOf(child) === null) {
					const declared = this.nameOf(child);
					if (declared === null) continue;
					this.moduleNames.add(declared);
					this.moduleValues.add(declared);
					// Kotlin's `suspend` is invisible at the call site and a
					// promise is not: `val body = fetchBody(url)` assigned the
					// promise itself, and the extension played `[object
					// Promise]`. Class methods were already tracked this way;
					// a file-scope `suspend fun` was not tracked at all.
					//
					// `BLOCKING_CALLS` for the same reason it is consulted for
					// class members (`blockingMembers`): a file-scope helper
					// that fetches or decrypts is `async` here whatever Kotlin
					// called it, and the shared extractor files this ecosystem
					// carries are written as file-scope functions rather than
					// as classes — so without this the whole crypto surface
					// would be awaited inside a class and not outside one.
					if (this.hasModifier(child, 'suspend') || BLOCKING_CALLS.test(child.text)) {
						this.moduleSuspends.add(declared);
					}
				}
			}

			// A companion's members hoist to module scope too, and until this
			// they were not *declared* anywhere the cross-file rename could see.
			// Two shared libraries in one bundle each declaring a companion
			// `QUALITY_REGEX` — one an HLS height, one an `[xX]` dimension — both
			// hoisted under that name, and `"QUALITY_REGEX" has already been
			// declared` took the whole bundle down at load.
			for (const child of declarations) {
				if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
				const body = kids(child).find((part) => part.type === 'class_body');
				if (body === undefined) continue;
				for (const member of kids(body)) {
					if (member.type !== 'companion_object') continue;
					const inner = kids(member).find((part) => part.type === 'class_body');
					for (const part of kids(inner)) {
						const declared =
							part.type === 'property_declaration'
								? this.propertyName(part)
								: part.type === 'function_declaration'
									? this.nameOf(part)
									: null;
						if (declared === null) continue;
						this.moduleNames.add(declared);
						this.moduleValues.add(declared);
					}
				}
			}
		}

		for (const child of declarations) {
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;

			// The extension class is reached as `this.name()` through
			// `classMembers`, never as a passthrough on some other receiver.
			const isEntry = topLevel && child.type === 'class_declaration' && this.isEntryShaped(child);

			const body = kids(child).find(
				(part) => part.type === 'class_body' || part.type === 'enum_class_body'
			);
			// A plain `fun` that blocks on a request is async in JavaScript — see
			// `blockingMembers` — and a class next door calls it too. Recorded
			// only for the `suspend` modifier, PlaylistUtils' `fixSubtitles`
			// (which blocks inside `parallelMapNotNullBlocking`) was called
			// unawaited from every extractor file: ChillxExtractor handed a
			// Promise on as a subtitle list, and a shared extractor's
			// `.let(playlistUtils::fixSubtitles)` inside `runCatching` threw, so
			// its hoster answered no videos. The same fixpoint, crossing the file.
			//
			// Without `.proceed(`: it is only ever called inside an interceptor,
			// which the runtime invokes on each request, never a caller in the
			// next file. Counted, `SiteDecrypt.createInterceptor()` — which
			// *returns* the lambda that proceeds — became a suspending call, and
			// `override val client = …addInterceptor(SiteDecrypt
			// .createInterceptor())…` a suspending property initialiser, refused.
			if (!isEntry) {
				for (const name of this.blockingMembers(kids(body), CROSS_FILE_BLOCKING_CALLS)) {
					this.declaredSuspends.add(name);
				}
			} else {
				// The entry emitter's own starting set, computed the same way —
				// `suspend`, then `BLOCKING_CALLS` to a fixpoint — so a helper
				// class calling back into it through a typed property awaits
				// exactly what the class itself would. See `entrySuspends`.
				const owner = this.nameOf(child);
				if (owner !== null) {
					const members = kids(body);
					for (const member of members) {
						const method = member.type === 'function_declaration' ? this.nameOf(member) : null;
						if (method !== null && this.hasModifier(member, 'suspend')) {
							this.entrySuspends.add(`${owner}.${method}`);
						}
					}
					for (const name of this.blockingMembers(members)) {
						this.entrySuspends.add(`${owner}.${name}`);
					}
				}
			}
			for (const member of kids(body)) {
				if (member.type === 'function_declaration') {
					const method = this.nameOf(member);
					const owner = this.nameOf(child);
					const reified = reifiedParams(member);
					if (method !== null && owner !== null && reified.length > 0) {
						this.reifiedMembers.set(`${owner}.${method}`, reified);
					}
					// An extension function is called with its receiver moved
					// into first position, so it is not a passthrough method —
					// but it still has to cross a file boundary, under the name
					// of the class that declares it.
					if (method !== null && receiverOf(member) !== null) {
						if (owner !== null) this.declaredExtensions.add(`${owner}.${method}`);
					} else if (method !== null && !isEntry) {
						this.declaredMethods.add(method);
						if (this.hasModifier(member, 'suspend')) this.declaredSuspends.add(method);
					}
					continue;
				}
				if (member.type === 'property_declaration') {
					// What this property holds, when the declaration says so — a
					// type annotation, or a construction in the initialiser
					// (`= X(…)`, `by lazy { X(…) }`). Read off the text because
					// all three spellings put the type name in front of a `(`.
					const held = this.propertyName(member);
					const built = /\b([A-Z][\w]*)\s*\(/.exec(member.text);
					if (held !== null && built !== null) this.propertyTypes.set(held, built[1]);
					continue;
				}
				if (member.type === 'companion_object') {
					this.registerTypes(kids(kids(member).find((part) => part.type === 'class_body')), false);
					continue;
				}
				this.registerTypes([member], false);
			}
		}
	}

	/** Every type name under these declarations, nested ones included. */
	private registerTypeNames(declarations: readonly KNode[], owner: string | null = null): void {
		for (const child of declarations) {
			if (child.type === 'type_alias') {
				this.registerAlias(child);
				continue;
			}
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
			const name = this.nameOf(child);
			if (name !== null) {
				this.declaredTypes.add(name);
				this.moduleNames.add(name);
				if (child.type === 'object_declaration') this.declaredObjects.add(name);
				if (isNewable(child)) this.newableTypes.add(name);
				// Both spellings: a nested type is hoisted to module scope under
				// the bare one and *written* under the qualified one.
				if (owner !== null) this.qualifiedTypes.set(`${owner}.${name}`, name);
			}
			const body = kids(child).find(
				(part) => part.type === 'class_body' || part.type === 'enum_class_body'
			);
			for (const member of kids(body)) {
				if (member.type === 'companion_object') {
					// A companion's members hoist to the *enclosing* name, never
					// to `Owner.Companion`.
					this.registerTypeNames(
						kids(kids(member).find((part) => part.type === 'class_body')),
						name
					);
					continue;
				}
				this.registerTypeNames([member], name);
			}
		}
	}

	/**
	 * Notes `typealias A = B`, which is the only trace the declaration leaves.
	 *
	 * The head of the aliased type is what is kept — `List` out of
	 * `List<Row>` — because the type arguments are erased with everything else
	 * and the head is the only part that could ever name something emitted. A
	 * function type has no head, so nothing is recorded and the alias resolves
	 * to nothing, which is what a function type is worth at run time.
	 */
	private registerAlias(node: KNode): void {
		const name = this.nameOf(node);
		const target = kids(node).find((child) => child.type === 'user_type');
		const head = kids(target).find((child) => child.type === 'type_identifier');
		if (name === null || head === undefined || head.text === name) return;
		this.typeAliases.set(name, head.text);
	}

	/**
	 * The declared name behind an alias, following a chain of them.
	 *
	 * Bounded rather than cycle-checked: `typealias A = B` and `typealias B = A`
	 * do not compile in Kotlin, so a cycle here means a file this build is
	 * already reading wrongly, and the bound keeps that from becoming a hang.
	 */
	private aliased(name: string): string {
		let current = name;
		for (let hops = 0; hops < 8; hops += 1) {
			const next = this.typeAliases.get(current);
			if (next === undefined || next === current) break;
			current = next;
		}
		return current;
	}

	/**
	 * True for a class whose base class is not one this build can reach.
	 *
	 * That is exactly the extension itself: it extends a source class living in
	 * the catalogue's own `lib-multisrc`, which is why the driver supplies one.
	 * A filter or a DTO in a sibling file extends `AnimeFilter.Select` or
	 * nothing at all, and its methods are ordinary members other files call.
	 */
	private isEntryShaped(node: KNode): boolean {
		const invoked = this.baseInvocation(node);
		if (invoked === null) return false;
		return this.resolvedBase(invoked.type) === null;
	}

	/**
	 * The module-scope object an `object`'s `by lazy` members memoise into.
	 *
	 * Declared once per object and hoisted above it, because the literal itself
	 * is frozen and a `lazy` that re-ran on every read would not be one.
	 */
	private lazyCache(owner: string): string {
		const name = `__lazy_${owner}`;
		if (!this.lazyCaches.has(owner)) {
			this.lazyCaches.add(owner);
			this.hoisted.push(`const ${name} = {};`);
		}
		return name;
	}

	/**
	 * What kotlinx knows about a `@Serializable` class, for the typed decoder,
	 * or a refusal, or null for a class that is not one.
	 *
	 * The runtime used to recognise a decoded record by its field set, which is
	 * a guess, and a class whose fields are all optional fits every record — so
	 * one such DTO made the rest unrecognisable and a record came back with no
	 * methods. A decode that names its type needs no guess: this writes down
	 * the class's constructor (in declaration order), each field's wire names
	 * (`@SerialName`, `@JsonNames`), declared type, whether it has a default,
	 * whether it is `@Transient`, and which custom serializer it names — on
	 * the field, on a type argument inside it, or on the class. See
	 * `__serialDecode` in the runtime.
	 *
	 * A custom serializer is accepted only when it is an `object` this build
	 * declares, built on `JsonTransformingSerializer` (whose base is checked
	 * where the object is emitted) or on the `KSerializer` interface alone.
	 * A generic serializer class, `@Contextual`, or any other base is refused.
	 * An enum or a polymorphic class is not registered — it keeps the
	 * structural walk it had — and one naming a serializer is refused.
	 */
	private serialRegistration(
		node: KNode,
		name: string,
		isData: boolean,
		isEnum: boolean
	): { text: string } | { refusal: string } | null {
		const annotations = kids(node).find((child) => child.type === 'modifiers');
		const found = customSerializer(node);
		if (annotations === undefined || !/@Serializable\b/.test(annotations.text)) {
			return found === null
				? null
				: { refusal: `a custom serializer \`${found.name}\` ${found.placement}` };
		}
		const polymorphic = /\b(?:sealed|abstract)\b/.test(annotations.text);
		if (isEnum || polymorphic) {
			return found === null
				? null
				: { refusal: `a custom serializer \`${found.name}\` ${found.placement}` };
		}

		const serializers = new Set<string>();
		const named = (written: string | undefined): string | null => {
			const hit = written?.match(SERIALIZER_ANNOTATION)?.[1] ?? null;
			if (hit !== null) serializers.add(hit);
			return hit;
		};
		const wires = (declared: string, written: string): string[] => {
			const out = [declared];
			for (const annotation of written.matchAll(/@(SerialName|JsonNames)\s*\(([^)]*)\)/g)) {
				const quoted = [...annotation[2].matchAll(/"([^"]*)"/g)].map((one) => one[1]);
				if (annotation[1] === 'SerialName' && quoted.length > 0) out[0] = quoted[0];
				else out.push(...quoted);
			}
			return out;
		};
		let contextual = false;
		// This class's own nested types, as they will be emitted — see
		// `nestedRenames` for what reading them bare decoded.
		const own = this.nestedRenames(
			kids(
				kids(node).find((child) => child.type === 'class_body' || child.type === 'enum_class_body')
			),
			name
		);
		const typeOf = (holder: KNode | undefined): string => {
			const written = kids(holder).find(
				(part) => part.type.endsWith('type') && part.type !== 'binding_pattern_kind'
			);
			if (written === undefined) return 'Any';
			if (/@Contextual\b/.test(written.text)) contextual = true;
			for (const marker of written.text.matchAll(new RegExp(SERIALIZER_ANNOTATION, 'g'))) {
				serializers.add(marker[1]);
			}
			return this.scopedTypeText(serialType(written.text), own);
		};

		const fields: unknown[] = [];
		const constructor = kids(node).find((child) => child.type === 'primary_constructor');
		for (const parameter of kids(constructor)) {
			if (parameter.type !== 'class_parameter') continue;
			const declared = kids(parameter).find((part) => part.type === 'simple_identifier')?.text;
			if (declared === undefined) continue;
			const written = kids(parameter).find((part) => part.type === 'modifiers')?.text ?? '';
			fields.push([
				fieldName(declared),
				wires(fieldName(declared), written),
				typeOf(parameter),
				parameter.allChildren.some((part) => part.type === '='),
				CONTEXTUAL.test(written) ? CONTEXTUAL_FIELD : named(written),
				/@Transient\b/.test(written)
			]);
		}

		// A property in the body with a backing field is serialised too — one
		// with an initialiser, and no getter or delegate. Set after the
		// constructor, when the payload carries it.
		const body: unknown[] = [];
		const members = kids(kids(node).find((child) => child.type === 'class_body'));
		members.forEach((member, index) => {
			if (member.type !== 'property_declaration') return;
			const declared = this.propertyName(member);
			if (declared === null) return;
			if (accessorOf(member, members[index + 1], 'getter') !== undefined) return;
			if (kids(member).some((part) => part.type === 'property_delegate')) return;
			if (!member.allChildren.some((part) => part.type === '=')) return;
			const written = kids(member).find((part) => part.type === 'modifiers')?.text ?? '';
			if (/@Transient\b/.test(written)) return;
			body.push([
				fieldName(declared),
				wires(fieldName(declared), written),
				typeOf(kids(member).find((part) => part.type === 'variable_declaration')),
				true,
				CONTEXTUAL.test(written) ? CONTEXTUAL_FIELD : named(written),
				false
			]);
		});

		// `List<@Contextual Date>` decodes each element through the Json's
		// `serializersModule`, which this runtime does not have and cannot
		// read around. On a property it is only consulted when the payload
		// carries the key — see `CONTEXTUAL_FIELD` — but on a type argument
		// it is every element.
		if (contextual) return { refusal: '`@Contextual` on a type argument' };

		const params = kids(kids(node).find((child) => child.type === 'type_parameters'))
			.filter((child) => child.type === 'type_parameter')
			.map((child) => kids(child).find((part) => part.type === 'type_identifier')?.text ?? '?');
		const ownSerializer = named(annotations.text);

		const custom: string[] = [];
		for (const serializer of serializers) {
			const bare = serializer.replace(/^.*\./, '');
			if (!this.declaredObjects.has(bare)) {
				return { refusal: `a custom serializer \`${serializer}\` that is not an \`object\`` };
			}
			const base = this.classBaseIndex.get(bare);
			if (base !== undefined && base !== 'JsonTransformingSerializer') {
				return { refusal: `a custom serializer \`${serializer}\` built on \`${base}\`` };
			}
			custom.push(`${JSON.stringify(serializer)}: () => ${this.safe(bare)}`);
		}

		const meta = { params, fields, body, with: ownSerializer };
		const make = `(__a) => ${isData ? '' : 'new '}${this.safe(name)}(...__a)`;
		const map = custom.length === 0 ? 'null' : `{ ${custom.join(', ')} }`;
		return {
			text: `${this.helper('serial')}(${JSON.stringify(name)}, ${make}, ${JSON.stringify(meta)}, ${map});`
		};
	}

	/**
	 * The registration a `@Serializable` class needs, or null.
	 *
	 * Two things are lost between the JSON and the Kotlin, and both are silent:
	 * a `@SerialName`/`@JsonNames` rename, so `imgPath` never becomes `image`;
	 * and a computed `val vid get() = key ?: contxt`, which lives on the class
	 * and not on the decoded record. Measured: an extension whose ids all came
	 * back `undefined` while its search reported 32 results.
	 *
	 * Only classes that carry something the decoder would otherwise lose are
	 * registered. A plain DTO whose names already match needs nothing.
	 */
	private serialisableShape(node: KNode, name: string): string | null {
		const annotations = kids(node).find((child) => child.type === 'modifiers');
		if (annotations === undefined || !/@Serializable\b/.test(annotations.text)) return null;

		const constructor = kids(node).find((child) => child.type === 'primary_constructor');
		if (constructor === undefined) return null;

		const fields: string[] = [];
		const optional: string[] = [];
		const aliases: Record<string, string> = {};
		for (const parameter of kids(constructor)) {
			if (parameter.type !== 'class_parameter') continue;
			const declared = kids(parameter).find((part) => part.type === 'simple_identifier')?.text;
			if (declared === undefined) continue;
			fields.push(declared);
			// A nullable field, or one with a default, may simply be absent.
			const nullable = kids(parameter).some((part) => part.type === 'nullable_type');
			if (nullable || parameter.allChildren.some((part) => part.type === '=')) {
				optional.push(declared);
			}
			const written = kids(parameter).find((part) => part.type === 'modifiers')?.text ?? '';
			for (const found of written.matchAll(/@(?:SerialName|JsonNames)\s*\(([^)]*)\)/g)) {
				for (const quoted of found[1].matchAll(/"([^"]+)"/g)) aliases[quoted[1]] = declared;
			}
		}
		if (fields.length === 0) return null;

		const computed = kids(kids(node).find((child) => child.type === 'class_body'))
			.filter((child) => child.type === 'property_declaration')
			.some((child) => this.moduleGetter(child, undefined, 'val') !== null);
		if (Object.keys(aliases).length === 0 && !computed) return null;

		return `${this.helper('shape')}(${this.safe(name)}, ${JSON.stringify(fields)}, ${JSON.stringify(optional)}, ${JSON.stringify(aliases)});`;
	}

	/** An object's property names that another of its properties reads. */
	private siblingConstants(declarations: readonly KNode[]): Set<string> {
		const properties = declarations.filter((child) => child.type === 'property_declaration');
		const names = new Set<string>();
		for (const child of properties) {
			const declared = this.propertyName(child);
			if (declared !== null) names.add(declared);
		}
		const shared = new Set<string>();
		for (const child of properties) {
			const own = this.propertyName(child);
			for (const mentioned of mentions(child)) {
				if (mentioned !== own && names.has(mentioned)) shared.add(mentioned);
			}
		}
		return shared;
	}

	/** Notes an `object`'s own members, so one declared below another resolves. */
	private registerObjectMembers(declarations: readonly KNode[], owner: string): void {
		for (const child of declarations) {
			const declared =
				child.type === 'property_declaration'
					? this.propertyName(child)
					: child.type === 'function_declaration'
						? this.nameOf(child)
						: null;
			if (declared !== null && !this.objectMembers.has(declared)) {
				this.objectMembers.set(declared, owner);
			}
		}
	}

	/** Notes which of these declarations are extension functions, before use. */
	private registerExtensions(
		declarations: readonly KNode[],
		shape: 'method' | 'module',
		owner: string | null = null
	): void {
		for (const child of declarations) {
			if (child.type !== 'function_declaration') continue;
			const name = this.nameOf(child);
			if (name === null) continue;
			const reified = reifiedParams(child);
			if (reified.length > 0) this.reifiedFunctions.set(name, reified);
			if (receiverOf(child) === null) continue;
			this.extensionFunctions.set(name, shape);
			if (owner !== null) this.extensionOwners.set(name, owner);
		}
	}

	/** See `importedMembers`. */
	private registerImports(list: KNode | undefined): void {
		for (const header of kids(list)) {
			if (header.type !== 'import_header') continue;
			// `import a.B.c as d` renames, and `import a.B.*` names nothing.
			if (kids(header).some((child) => child.type !== 'identifier')) continue;
			if (header.allChildren.some((child) => child.type === '*' || child.type === '.*')) continue;
			const path = (kids(header)[0]?.text ?? '').replace(/\s+/g, '').split('.');
			if (path.length < 2) continue;
			const member = path[path.length - 1];
			if (path[0] === 'keiyoushi' && /^[a-z]/.test(member)) {
				this.keiyoushiImports.set(member, path.slice(0, -1).join('.'));
			}
			const owner = path[path.length - 2];
			// A nested type imported this way is a type, and already resolves.
			if (!this.declaredObjects.has(owner) || this.declaredTypes.has(member)) continue;
			this.importedMembers.set(member, owner);
			const reified = this.reifiedMembers.get(`${owner}.${member}`);
			if (reified !== undefined && !this.reifiedFunctions.has(member)) {
				this.reifiedFunctions.set(member, reified);
			}
		}
	}

	/** A bare name inside an enum's body or companion that means the enum's own. */
	private enumMember(name: string): string | null {
		const scope = this.enumScope;
		if (scope === null || this.lookup(name) !== null) return null;
		if (this.classMembers.has(name)) return null;
		const known = scope.entries.has(name) || ENUM_STATICS.has(name);
		return known ? `${this.safe(scope.owner)}.${name}` : null;
	}

	/** The object an imported `name` is reached through, unless something closer declares it. */
	private importedOwner(name: string): string | null {
		const owner = this.importedMembers.get(name);
		if (owner === undefined || owner === this.owner) return null;
		if (this.isSourceMember(name) || this.objectMembers.has(name)) return null;
		if (this.extensionFunctions.has(name) || this.lookup(name) !== null) return null;
		return owner;
	}

	/* ── expected types ─────────────────────────────────────────────────── */

	/** See `expectedTypes`. One walk over the file, before anything is emitted. */
	private registerExpectedTypes(root: KNode): void {
		// Parameter types of the functions and classes this file declares, by
		// name — dropped the moment two declarations disagree, because an
		// argument to the wrong overload would be given the wrong shape.
		const parameterTypes = new Map<string, (string | null)[] | null>();
		const note = (name: string | null, types: (string | null)[] | null): void => {
			if (name === null || types === null) return;
			const known = parameterTypes.get(name);
			if (known === undefined) parameterTypes.set(name, types);
			else if (known === null || known.join('|') !== types.join('|')) {
				parameterTypes.set(name, null);
			}
		};
		for (const node of walk(root)) {
			if (node.type === 'function_declaration') {
				note(this.nameOf(node), parameterTypesOf(kids(node).find(isValueParameters)));
				const name = this.nameOf(node);
				const reified = reifiedParams(node);
				if (name !== null && reified.length === 1) {
					const [only] = reified;
					this.reifiedFrom.set(name, {
						returns: returnTypeText(node) === only,
						receiver: receiverOf(node) === only && !/[<?]/.test(receiverText(node) ?? '')
					});
				}
			} else if (node.type === 'class_declaration') {
				const constructor = kids(node).find((child) => child.type === 'primary_constructor');
				const parameters = kids(constructor).find((child) => child.type === 'class_parameters');
				if (parameters !== undefined) note(this.nameOf(node), parameterTypesOf(parameters));
			}
		}

		for (const node of walk(root)) {
			switch (node.type) {
				case 'property_declaration': {
					const declaration = kids(node).find((child) => child.type === 'variable_declaration');
					const type = typeText(kids(declaration).find((child) => child.type.endsWith('type')));
					if (type === null) break;
					const delegate = kids(node).find((child) => child.type === 'property_delegate');
					if (delegate !== undefined) {
						// `val covers: Map<…> by lazy { … .parseAs() }` — the block's
						// last value is the property's value.
						const lazy = lazyBlock(delegate);
						if (lazy !== null) this.expectLast(lazy, type);
						break;
					}
					const getter = kids(node).find((child) => child.type === 'getter');
					if (getter !== undefined) {
						this.expectBody(
							kids(getter).find((child) => child.type === 'function_body'),
							type
						);
						break;
					}
					this.expect(
						kids(node).find((child) => !PROPERTY_PARTS.has(child.type)),
						type
					);
					break;
				}
				case 'function_declaration':
					this.expectBody(
						kids(node).find((child) => child.type === 'function_body'),
						returnTypeText(node)
					);
					break;
				case 'as_expression': {
					const [value, type] = [kids(node)[0], kids(node)[kids(node).length - 1]];
					if (value !== type) this.expect(value, typeText(type));
					break;
				}
				case 'call_expression': {
					const callee = kids(node)[0];
					if (callee?.type !== 'simple_identifier') break;
					const types = parameterTypes.get(callee.text);
					if (types === undefined || types === null) break;
					const suffix = kids(node)[1];
					const values = kids(kids(suffix).find((child) => child.type === 'value_arguments'));
					for (const [index, arg] of values.entries()) {
						if (arg.type !== 'value_argument') continue;
						if (arg.allChildren.some((child) => child.type === '=')) break;
						const value = kids(arg)[kids(arg).length - 1];
						this.expect(value, types[index] ?? null);
					}
					break;
				}
				case 'statements':
					this.expectAssignments(node);
					break;
			}
		}
	}

	/**
	 * `x = …` where `x` is a local declared with a type in the same block.
	 *
	 * `lateinit var dto: ChapterListDto` then `dto = if (…) response.parseAs()
	 * else …` is the shape. Only a plain name declared among the *same*
	 * statements is followed; anything else answers nothing.
	 */
	private expectAssignments(statements: KNode): void {
		const locals = new Map<string, string | null>();
		for (const statement of kids(statements)) {
			if (statement.type !== 'property_declaration') continue;
			const declaration = kids(statement).find((child) => child.type === 'variable_declaration');
			const name = kids(declaration).find((child) => child.type === 'simple_identifier')?.text;
			const type = typeText(kids(declaration).find((child) => child.type.endsWith('type')));
			if (name === undefined) continue;
			locals.set(name, locals.has(name) ? null : type);
		}
		if (locals.size === 0) return;
		for (const node of walk(statements)) {
			if (node.type !== 'assignment') continue;
			const operator = node.allChildren.find((child) => child.type.endsWith('='));
			if (operator?.type !== '=') continue;
			const target = kids(node)[0];
			const name = target?.type === 'directly_assignable_expression' ? kids(target) : [];
			if (name.length !== 1 || name[0].type !== 'simple_identifier') continue;
			const type = locals.get(name[0].text);
			if (type === undefined || type === null) continue;
			this.expect(kids(node)[kids(node).length - 1], type);
		}
	}

	/** A function body's value: its expression, or every unlabelled `return` in it. */
	private expectBody(body: KNode | undefined, type: string | null): void {
		if (body === undefined || type === null) return;
		if (!body.allChildren.some((child) => child.type === '{')) {
			this.expect(kids(body)[0], type);
			return;
		}
		const visit = (node: KNode): void => {
			for (const child of kids(node)) {
				// A nested function, class or object returns to itself.
				if (EXPECTATION_BARRIERS.has(child.type)) continue;
				if (child.type === 'jump_expression' && /^return(?![@\w])/.test(child.text)) {
					this.expect(kids(child)[0], type);
				}
				visit(child);
			}
		};
		visit(body);
	}

	/** The last statement of a block-shaped node, which is its value. */
	private expectLast(node: KNode, type: string): void {
		const statements = kids(node).find((child) => child.type === 'statements');
		const all = kids(statements);
		this.expect(all[all.length - 1], type);
	}

	private expect(node: KNode | undefined, type: string | null): void {
		if (node === undefined || type === null) return;
		switch (node.type) {
			case 'parenthesized_expression':
				this.expect(kids(node)[0], type);
				return;
			case 'postfix_expression':
				if (node.allChildren.some((child) => child.type === '!!')) this.expect(kids(node)[0], type);
				return;
			case 'elvis_expression':
				this.expect(kids(node)[0], type);
				this.expect(kids(node)[kids(node).length - 1], type);
				return;
			case 'control_structure_body':
				if (node.allChildren.some((child) => child.type === '{')) this.expectLast(node, type);
				else this.expect(kids(node)[0], type);
				return;
			case 'if_expression':
				for (const child of kids(node)) {
					if (child.type === 'control_structure_body') this.expect(child, type);
				}
				return;
			case 'when_expression':
				for (const entry of kids(node)) {
					if (entry.type !== 'when_entry') continue;
					this.expect(
						kids(entry).find((child) => child.type === 'control_structure_body'),
						type
					);
				}
				return;
			case 'try_expression':
				this.expectLast(node, type);
				for (const child of kids(node)) {
					if (child.type === 'catch_block') this.expectLast(child, type);
				}
				return;
			case 'call_expression': {
				const key = expectationKey(node);
				const known = this.expectedTypes.get(key);
				this.expectedTypes.set(key, known === undefined || known === type ? type : null);
				// `= use { json.decodeFromString(it.body.string()) }` — a scope
				// function whose value IS its block's, so Kotlin infers the
				// block's result from the same expected type. Only the three that
				// answer the block: `also`/`apply` answer their receiver, and a
				// type pushed into their block would be a wrong one.
				const block = valueScopeBlock(node);
				if (block !== null) this.expectLast(block, type);
				return;
			}
		}
	}

	/** The type a call's value is going to, if `registerExpectedTypes` found one. */
	private expectedOf(node: KNode): string | null {
		return this.expectedTypes.get(expectationKey(node)) ?? null;
	}

	/**
	 * A type as a decoder is handed it: the text, or — inside `inline fun
	 * <reified T>` — the argument carrying the type the call site named.
	 *
	 * `json.decodeFromString<T>(text)` in a reified helper used to hand the
	 * runtime the *letter* `T`, which names nothing, so a helper called as
	 * `parseAs<List<String>>()` decoded as "whatever the payload holds" and
	 * lost the container. The carried argument is text when the call site
	 * wrote a type the runtime reads by name and a class when it wrote one this
	 * module declares; `typeText` answers the text of either.
	 */
	private decodeType(type: string): string {
		const bare = type.replace(/\?$/, '');
		const bound = this.reifiedTypes?.get(bare);
		if (bound !== undefined) return `${this.helper('typeText')}(${bound})`;
		return JSON.stringify(this.scopedTypeText(type));
	}

	/** The type annotation on a property declaration, if it carries one. */
	private declaredType(node: KNode): string | null {
		const declaration = kids(node).find((child) => child.type === 'variable_declaration');
		const written = kids(declaration).find((child) => child.type.endsWith('type'));
		return written === undefined ? null : typeName(written);
	}

	/**
	 * A file-scope `val X get() = …`, as the body of the function it becomes.
	 *
	 * A class property with a getter is emitted as a real JavaScript `get`;
	 * module scope has no such thing, so the property becomes a function and
	 * `read` turns every mention of the name into a call to it. Evaluating the
	 * body once into a `const` would be the shorter emission and the wrong one:
	 * a getter is *re-evaluated at every read*, and the declaration this exists
	 * for hands out filter objects whose state a search then ticks.
	 *
	 * Null when the property has no getter, which is the ordinary case.
	 */
	private moduleGetter(node: KNode, next: KNode | undefined, name: string): string | null {
		const setter = accessorOf(node, next, 'setter');
		if (setter !== undefined) this.refuse(setter, 'a custom property setter');
		const getter = accessorOf(node, next, 'getter');
		if (getter === undefined) return null;
		const body = kids(getter).find((child) => child.type === 'function_body');
		if (body === undefined) this.refuse(getter, `\`${name}\` with a getter and no body`);
		const emitted = this.functionScope('function', null, [], () => this.functionBody(body));
		if (emitted.isAsync) this.refuse(getter, 'a suspending getter');
		return emitted.text;
	}

	/** The initialiser of a `val`/`var`, as an expression. */
	private propertyValue(node: KNode, name: string): string {
		const delegate = kids(node).find((child) => child.type === 'property_delegate');
		if (delegate !== undefined) {
			// A companion's `private val DATE_FORMATTER by lazy { … }` is hoisted to
			// a module `const`, where there is nothing to memoise against — so the
			// thunk is called once, here, which is what `lazy` promised anyway.
			return `(${this.delegateValue(delegate, node, name)})()`;
		}

		const initialiser = kids(node).find((child) => !PROPERTY_PARTS.has(child.type));
		if (initialiser === undefined) {
			this.refuse(node, `\`${name}\` with no value this build can read`);
		}
		const emitted = this.functionScope('function', null, [], () => this.expr(initialiser));
		// A property initialiser runs inside a constructor, which cannot await.
		if (emitted.isAsync) this.refuse(initialiser, 'a suspending property initialiser');
		if (!emitted.usesSelf) return emitted.text;
		return `(() => ${block(['const __self = this;', `return ${emitted.text};`])})()`;
	}

	private functionDeclaration(
		node: KNode,
		shape: 'method' | 'module' | 'anonymous' | 'local',
		emittedName: string | null = null
	): string {
		const name = this.nameOf(node) ?? 'fun';

		// `fun Element.getInfo(key)` puts its receiver type before the name. A
		// receiver is not a parameter in Kotlin and is one here, so it becomes
		// the first argument — the shape every `__k` helper already has — and the
		// call site moves the receiver into it. Emitting the signature as written
		// would produce a function that silently ignored the value it was called
		// on, which is why this was refused before there was somewhere to put it.
		const receiverType = receiverOf(node);

		const body = kids(node).find((child) => child.type === 'function_body');
		if (body === undefined) this.refuse(node, `\`${name}\` declared with no body`);

		const params = this.parameters(node);
		// A reified type parameter is carried as an argument, ahead of the
		// receiver and of everything declared: a value parameter with a default
		// may be left out at a call site, and a slot after one is not a slot.
		const reified = reifiedParams(node);
		const carried = reified.map(reifiedBinding);
		const names = [
			...carried,
			...(receiverType === null ? params.names : ['__recv', ...params.names])
		];
		const text = [
			...carried,
			...(receiverType === null ? params.text : ['__recv', ...params.text])
		];

		const previousReceiver = this.receiverParam;
		const previousLabel = this.receiverLabel;
		const previousType = this.receiverType;
		const previousReified = this.reifiedTypes;
		if (receiverType !== null) {
			this.receiverParam = '__recv';
			this.receiverLabel = name;
			this.receiverType = receiverType.split('.').pop() ?? receiverType;
		}
		if (reified.length > 0) {
			this.reifiedTypes = new Map(reified.map((one) => [one, reifiedBinding(one)]));
		}
		// The parameters typed `R.() -> T`, so a call of one inside the body is
		// given its receiver. See `invokeReceiverLocal`.
		const list = kids(node).find((child) => child.type === 'function_value_parameters');
		const receiverParams = kids(list)
			.filter((child) => child.type === 'parameter')
			.map((child) => ({
				name: this.nameOf(child),
				arity: receiverArity(child),
				suspends: /^suspend\b/.test(
					kids(child).find((part) => part.type === 'type_modifiers')?.text ?? ''
				)
			}))
			.filter(
				(one): one is { name: string; arity: number; suspends: boolean } =>
					one.name !== null && one.arity !== null
			);
		const valueParams = kids(list)
			.filter((child) => child.type === 'parameter')
			.filter((child) => {
				const type = kids(child).find(
					(part) => part.type === 'user_type' || part.type === 'nullable_type'
				);
				return type !== undefined && VALUE_ONLY_TYPES.has(type.text.replace(/\?$/, ''));
			})
			.map((child) => this.nameOf(child))
			.filter((one): one is string => one !== null);
		let emitted;
		try {
			emitted = this.functionScope('function', null, names, () => {
				for (const one of receiverParams) {
					this.declareReceiverLocal(one.name, one.arity, one.suspends);
				}
				for (const one of valueParams) this.markValueOnly(one);
				return this.functionBody(body);
			});
		} finally {
			this.receiverParam = previousReceiver;
			this.receiverLabel = previousLabel;
			this.receiverType = previousType;
			this.reifiedTypes = previousReified;
		}
		if (receiverType !== null) {
			this.extensionFunctions.set(name, shape === 'method' ? 'method' : 'module');
		}
		const prefix = emitted.isAsync || this.hasModifier(node, 'suspend') ? 'async ' : '';
		const signature = `(${text.join(', ')})`;

		if (shape === 'method') return `${prefix}${emittedName ?? name}${signature} ${emitted.text}`;
		if (shape === 'anonymous') return `${prefix}function ${signature} ${emitted.text}`;
		// A local function is an arrow so that `this` keeps meaning the source:
		// a `function` here would rebind it and every member the body reads
		// would resolve to undefined at the first call.
		if (shape === 'local') return `${prefix}${signature} => ${emitted.text}`;
		return `${prefix}function ${this.safe(name)}${signature} ${emitted.text}`;
	}

	private functionBody(node: KNode): string {
		const cut = this.cut;
		if (cut !== null && node.line === cut.body.line && node.text === cut.body.text) {
			// See `recoveryCut`: the statements up to and including the
			// pass-through guard, then the error the tail would have become.
			this.cut = null;
			const statements = kids(node).find((child) => child.type === 'statements');
			return block([
				...(statements === undefined ? [] : this.statementList(statements, null, cut.keep)),
				`throw ${this.helper('recoveryRefused')}(${JSON.stringify(cut.owner)}, ${JSON.stringify(cut.kinds)});`
			]);
		}
		if (node.allChildren.some((child) => child.type === '{')) {
			const statements = kids(node).find((child) => child.type === 'statements');
			return block(statements === undefined ? [] : this.statementList(statements, null));
		}
		const value = kids(node)[0];
		if (value === undefined) this.refuse(node, 'an empty function body');
		if (value.type === 'jump_expression') return block([this.stmt(value)]);
		return block(this.rooted(value, () => this.deliver(value, 'return')));
	}

	/**
	 * A value-producing node, put wherever the surrounding position wants it:
	 * dropped, returned, or assigned to a name.
	 *
	 * `if`, `when` and `try` are *expressions* in Kotlin and statements in
	 * JavaScript, and the obvious bridge — wrap one in an arrow IIFE -- is a
	 * trap. A `return` written inside such a construct means "return from the
	 * enclosing function"; inside an IIFE it returns from the IIFE, and the
	 * method carries on with a value its author never meant it to have. So
	 * wherever the position allows — a function's tail, a local's initialiser —
	 * the construct is emitted as a statement that delivers its own branches, and
	 * there is no IIFE for a `return` to be caught by. `expr` still wraps one
	 * where nothing else is possible, and a `return` inside *that* is refused
	 * rather than mistranslated.
	 */
	private deliver(node: KNode, sink: Sink): string[] {
		if (sink !== null && DELIVERABLE.has(node.type)) return [this.tail(node, sink)];
		if (sink === null) return [this.stmt(node)];

		const guarded = this.elvisJump(node);
		if (guarded !== null) {
			const temporary = this.temporary();
			return [
				`const ${temporary} = ${this.expr(guarded.value)};`,
				`if (${temporary} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`,
				...this.deliverValue(temporary, sink)
			];
		}

		const lowered = this.lowered(node, sink);
		if (lowered !== null) return lowered;

		return this.deliverValue(this.expr(node), sink);
	}

	/** `if`/`when`/`try` as a statement that delivers its branches itself. */
	private tail(node: KNode, sink: Sink): string {
		if (node.type === 'when_expression') return this.whenChain(node, sink);
		if (node.type === 'try_expression') return this.tryBlock(node, sink);
		return this.ifStatement(node, sink);
	}

	/** What a branch that produces nothing delivers: Kotlin's absent value. */
	private deliverNull(sink: Sink): string[] {
		return this.deliverValue('null', sink);
	}

	/** An already-emitted expression, put where the surrounding position wants it. */
	private deliverValue(text: string, sink: Sink): string[] {
		if (sink === null) return [];
		return [sink === 'return' ? `return ${text};` : `${sink.target} = ${text};`];
	}

	/**
	 * A function's parameters, with their default values attached to the right
	 * ones.
	 *
	 * The grammar does **not** nest a default inside the parameter it belongs
	 * to. `fun f(prefix: String = "")` gives a `parameter` and then, as
	 * *siblings*, an `=` token and a `string_literal`. So the association has to
	 * be made by reading the `=`, and this walks `allChildren` rather than
	 * `kids` to do it.
	 *
	 * That distinction is the whole function. `kids` drops punctuation — so the
	 * `=` disappears and the pairing becomes positional — and it *appends* the
	 * unnamed `null` token to the end of the list, because `null` is the one
	 * value this grammar gives no named node (see `kids`). Both together meant
	 * that `fun f(a: String, b: String? = null, c: Boolean = true)` paired
	 * `true` with `b`, gave `b` no default at all, and then met the trailing
	 * `null` where a parameter was expected and refused the member on the
	 * grammar kind `null`. Measured against one catalogue with its shared
	 * modules wired in, that single mispairing was the **largest blocker in
	 * the whole corpus, at 104 extensions** — because every per-host extractor
	 * writes `fun videoFromUrl(url: String, prefix: String? = null, …)`.
	 *
	 * A single-parameter default happened to work, which is why it survived:
	 * with one appended `null` and one parameter, the positions coincide.
	 */
	private parameters(node: KNode): { names: string[]; text: string[] } {
		const list = kids(node).find((child) => child.type === 'function_value_parameters');
		const names: string[] = [];
		const text: string[] = [];

		// The parameter being built, held open until the `=` after it has been
		// read — or until the next comma says there was not one.
		let pending: { name: string; spread: boolean; node: KNode } | null = null;
		let spread = false;
		let expectingDefault = false;
		let spreadAt = -1;

		const flush = (fallback: KNode | null): void => {
			if (pending === null) return;
			if (pending.spread) {
				// `vararg xs: T` arrives as an array in Kotlin and as a rest
				// parameter here, which is the same value from the same call —
				// `f("a", "b")` binds both. A default alongside it is not
				// expressible and never occurs with one.
				if (fallback !== null) this.refuse(pending.node, 'a `vararg` with a default value');
				spreadAt = names.length;
				text.push(`...${this.safe(pending.name)}`);
			} else {
				// `block: Headers.Builder.() -> Unit = {}` — a default that is itself
				// a receiver block, and has to be one for the same reason a block
				// written at the call does. See `ReceiverSlots`.
				const receiverDefault =
					fallback !== null &&
					fallback.type === 'lambda_literal' &&
					receiverArity(pending.node) !== null;
				text.push(
					fallback === null
						? this.safe(pending.name)
						: `${this.safe(pending.name)} = ${
								receiverDefault
									? this.receiverLambdaValue(fallback, pending.name)
									: this.expr(fallback)
							}`
				);
			}
			names.push(pending.name);
			// In scope for the defaults after it. `fun extractFromHls(playlistUrl:
			// String, referer: String = playlistUrl.toDefaultReferer())` is how
			// PlaylistUtils — the module most extractors share — writes its
			// signature, and a default reads the parameters *before* it. Without
			// this the name resolved as a member and came out
			// `this.toDefaultReferer(this.playlistUrl)`: a field nothing sets, so
			// every stream went out with an empty Referer and nothing refused.
			// JavaScript defaults see earlier parameters exactly as Kotlin's do.
			this.declare(pending.name);
			pending = null;
		};

		// Its own scope, so the names declared above end with the signature;
		// the body declares them again inside `functionScope`.
		this.pushScope();
		try {
			for (const child of list?.allChildren ?? []) {
				if (COMMENT_KINDS.has(child.type)) continue;
				if (child.type === '(' || child.type === ')') continue;
				if (child.type === ',') {
					flush(null);
					continue;
				}
				if (expectingDefault) {
					expectingDefault = false;
					flush(child);
					continue;
				}
				if (child.type === '=') {
					expectingDefault = true;
					continue;
				}
				if (child.type === ':') continue;
				if (child.type.endsWith('type') || child.type === 'type_arguments') continue;
				if (child.type === 'parameter_modifiers') {
					// A modifier list is a sibling too, and it comes *before* the
					// parameter it modifies.
					spread = this.readParameterModifiers(child);
					continue;
				}
				if (child.type !== 'parameter') this.refuse(child, spoken(child));

				flush(null);
				const name = this.nameOf(child);
				if (name === null) this.refuse(child, 'an unnamed parameter');
				pending = { name, spread, node: child };
				spread = false;
			}
			flush(null);
		} finally {
			this.popScope();
		}

		// Kotlin lets a `vararg` sit anywhere and names the parameters after it
		// at the call site; JavaScript's rest parameter has to be last, and
		// emitting one that is not silently swallows every argument the later
		// parameters were meant to receive.
		if (spreadAt !== -1 && spreadAt !== names.length - 1) {
			this.refuse(node, 'a `vararg` followed by another parameter');
		}
		return { names, text };
	}

	/**
	 * A parameter's modifier list, and whether it made one a `vararg`.
	 *
	 * Three of the four things that appear here are compile-time only:
	 * `@Suppress("…")` is an annotation, and `noinline`/`crossinline` describe
	 * what the Kotlin compiler may do with a lambda it is inlining — which this
	 * build does not do, because it does not inline. `vararg` is the one that
	 * changes the value the body sees, so it is the one that is answered.
	 */
	private readParameterModifiers(node: KNode): boolean {
		let spread = false;
		for (const modifier of kids(node)) {
			if (modifier.type === 'annotation') continue;
			if (modifier.type !== 'parameter_modifier') this.refuse(modifier, spoken(modifier));
			if (modifier.text === 'vararg') {
				spread = true;
				continue;
			}
			if (!ERASED_PARAMETER_MODIFIERS.has(modifier.text)) {
				this.refuse(modifier, `the parameter modifier \`${modifier.text}\``);
			}
		}
		return spread;
	}

	/**
	 * A primary constructor's parameter list, defaults included.
	 *
	 * Each default is read with the parameters *before* it in scope, because
	 * Kotlin lets a later default name an earlier parameter and because reading
	 * one as `this.x` would be `this` before `super`.
	 */
	private constructorSignature(
		params: readonly { name: string; fallback: KNode | null }[]
	): string[] {
		if (params.every((param) => param.fallback === null)) {
			return params.map((param) => this.safe(param.name));
		}
		this.pushScope();
		try {
			return params.map((param) => {
				this.declare(param.name);
				return param.fallback === null
					? this.safe(param.name)
					: `${this.safe(param.name)} = ${this.expr(param.fallback)}`;
			});
		} finally {
			this.popScope();
		}
	}

	private primaryConstructorParams(
		node: KNode
	): { name: string; isProperty: boolean; fallback: KNode | null; type: string | null }[] {
		const primary = kids(node).find((child) => child.type === 'primary_constructor');
		const out: {
			name: string;
			isProperty: boolean;
			fallback: KNode | null;
			type: string | null;
		}[] = [];
		for (const param of kids(primary)) {
			if (param.type !== 'class_parameter') continue;
			const name = kids(param).find((child) => child.type === 'simple_identifier')?.text;
			if (name === undefined) continue;
			// The default is whatever follows the `=`, read by position. It was
			// read by *kind* — the first child that was not a modifier, a type
			// or an identifier — and so a default that IS an identifier vanished:
			// `class PlaylistUtils(client, headers: Headers = commonEmptyHeaders)`
			// came out `constructor(client, headers)`, and `PlaylistUtils(client)`
			// — how most extractors build it — handed every request an undefined
			// `headers`. `data class D(val a: String, val b: String = a)` the same.
			const all = param.allChildren;
			const equals = all.findIndex((child) => child.type === '=');
			const fallback =
				equals === -1
					? null
					: (all.slice(equals + 1).find((child) => !COMMENT_KINDS.has(child.type)) ?? null);
			out.push({
				name,
				isProperty: kids(param).some((child) => child.type === 'binding_pattern_kind'),
				fallback,
				type: declaredTypeName(kids(param))
			});
		}
		return out;
	}

	/* ── statements ──────────────────────────────────────────────────────── */

	private statementList(node: KNode, sink: Sink, limit?: number): string[] {
		const children = this.rejoinJumps(kids(node).slice(0, limit));
		const out: string[] = [];
		children.forEach((entry, index) => {
			const tail =
				sink !== null &&
				index === children.length - 1 &&
				entry.value === undefined &&
				this.isValueShaped(entry.node);
			out.push(
				...this.rooted(entry.node, () =>
					tail ? this.deliver(entry.node, sink) : [this.stmt(entry.node, entry.value)]
				)
			);
		});
		return out;
	}

	/**
	 * Puts `return f()` back together.
	 *
	 * The vendored grammar splits `return emptyList()` — a `return` followed by
	 * a bare call with an *empty* argument list — into a valueless
	 * `jump_expression` and a sibling `call_expression`, while `return
	 * listOf(1)` and `return x.y()` stay whole. Emitting the pieces as written
	 * gives `return; emptyList();`, which compiles, runs, and returns
	 * `undefined` where a list was meant: a plugin that installs, searches, and
	 * shows nothing, with nothing anywhere reporting an error.
	 *
	 * The join is deliberately narrow — the jump must carry no value of its own
	 * and the next statement must begin on the same line — so an ordinary
	 * `return` followed by unreachable code is left alone.
	 */
	private rejoinJumps(children: readonly KNode[]): { type: string; node: KNode; value?: KNode }[] {
		const out: { type: string; node: KNode; value?: KNode }[] = [];
		for (let index = 0; index < children.length; index += 1) {
			const child = children[index];
			const next = children[index + 1];
			const bare =
				child.type === 'jump_expression' &&
				kids(child).every((part) => part.type === 'label') &&
				/^(?:return|throw)\b/.test(child.text.trim());
			if (bare && next !== undefined && next.line === child.line) {
				out.push({ type: child.type, node: child, value: next });
				index += 1;
				continue;
			}

			// The same split, one level in: `val id = x ?: return emptyList()`.
			//
			// Here the jump is the fallback of an elvis and not a child of this
			// block at all, so the pairing above cannot see it — while the
			// orphaned `emptyList()` *is* a sibling statement. The join was
			// therefore made at statement level and missed in elvis position,
			// where it emitted `if (id == null) return;` followed by a dangling
			// `__k.emptyList();`: `undefined` where a list was meant, which is
			// the same "installs, searches and shows nothing" this function was
			// written to prevent.
			// The same split again, inside a branch: `if (x) return emptyList()`
			// leaves the bare jump in the `if` and the call beside the `if`. The
			// pairing above cannot see it — the child here is the `if` — and the
			// orphan is a sibling statement, so without this the branch returned
			// `undefined` and the list was evaluated and dropped.
			const branch = danglingBranchJump(child);
			if (branch !== null && next !== undefined && next.line === branch.line) {
				this.jumpValues.set(branch, next);
				out.push({ type: child.type, node: child });
				index += 1;
				continue;
			}

			const dangling = this.danglingElvisJump(child);
			if (dangling !== null && next !== undefined && next.line === dangling.line) {
				this.jumpValues.set(dangling, next);
				out.push({ type: child.type, node: child });
				index += 1;
				continue;
			}

			out.push({ type: child.type, node: child });
		}
		return out;
	}

	/**
	 * A valueless `return`/`throw` standing as an elvis fallback, or null.
	 *
	 * Only the shape `rejoinJumps` can repair: the jump carries nothing of its
	 * own, so the sibling statement on the same line is its value. Anything else
	 * is left alone.
	 */
	private danglingElvisJump(node: KNode): KNode | null {
		for (const found of walk(node)) {
			if (found.type !== 'elvis_expression') continue;
			const fallback = kids(found)[1];
			if (fallback === undefined || fallback.type !== 'jump_expression') continue;
			if (!kids(fallback).every((part) => part.type === 'label')) continue;
			if (!/^(?:return|throw)\b/.test(fallback.text.trim())) continue;
			return fallback;
		}
		return null;
	}

	/** Whether a statement in tail position is the block's value. */
	private isValueShaped(node: KNode): boolean {
		switch (node.type) {
			case 'property_declaration':
			case 'assignment':
			case 'for_statement':
			case 'while_statement':
			case 'do_while_statement':
			case 'jump_expression':
			case 'function_declaration':
				return false;
			default:
				return true;
		}
	}

	private stmt(node: KNode, detached?: KNode): string {
		switch (node.type) {
			case 'property_declaration':
				return this.localProperty(node);
			case 'assignment':
				return this.assignment(node);
			case 'for_statement':
				return this.forStatement(node);
			case 'while_statement': {
				const test = this.expr(kids(node)[0]);
				return `while (${test}) ${block(this.loopBody(kids(node)[1] ?? null))}`;
			}
			case 'do_while_statement': {
				const body = kids(node).find((child) => child.type === 'control_structure_body') ?? null;
				return `do ${block(this.loopBody(body))} while (${this.expr(kids(node)[kids(node).length - 1])});`;
			}
			case 'jump_expression':
				return this.jump(node, detached);
			case 'if_expression':
				return this.ifStatement(node);
			case 'when_expression':
				return this.whenChain(node, null);
			case 'try_expression':
				return this.tryBlock(node, null);
			case 'class_declaration':
			case 'object_declaration':
				return this.hoistLocal(node);
			case 'function_declaration':
				return this.localFunction(node);
			default: {
				const lowered = this.lowered(node, null);
				if (lowered !== null) return lowered.join('\n');
				const guarded = this.elvisJump(node);
				if (guarded !== null) {
					const temporary = this.temporary();
					return block([
						`const ${temporary} = ${this.expr(guarded.value)};`,
						`if (${temporary} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`
					]);
				}
				return `${this.expr(node)};`;
			}
		}
	}

	/**
	 * A class or `object` declared inside a function body, lifted out of it.
	 *
	 * Usually a `@Serializable` DTO written next to the one method that
	 * decodes into it. It is a *declaration*, not a statement — nothing about
	 * it depends on the enclosing call — so it belongs at module scope with
	 * every other type, and the statement it stood in becomes nothing.
	 *
	 * The one thing that could go wrong is a name collision with a type of the
	 * same name elsewhere in the file, so the hoisted name carries the member
	 * it came from. A local class that closes over a local variable would be
	 * broken by this; Kotlin allows it and no DTO does it, and the emitter
	 * refuses anything in the body it cannot read anyway.
	 */
	private hoistLocal(node: KNode): string {
		const declared = this.nameOf(node) ?? 'local';
		const hoisted = this.moduleNames.has(declared) ? `${this.memberName}_${declared}` : declared;
		this.localTypes.set(declared, hoisted);
		if (isNewable(node)) this.newableTypes.add(declared);

		const emitted =
			node.type === 'class_declaration'
				? this.classDeclaration(node, hoisted)
				: this.objectDeclaration(node, hoisted);
		if (emitted === null) this.refuse(node, `\`${declared}\`, declared inside a function`);
		this.hoisted.push(emitted);
		return '';
	}

	/**
	 * `fun helper(x: String) = …`, written inside a method body.
	 *
	 * Emitted where it stands, as an arrow bound to a `const`. Two things make
	 * that the right shape rather than the hoist a local *class* gets. An arrow
	 * keeps `this`, so a local function reading `baseUrl` still reads the
	 * source's; and a `const` in place keeps the enclosing locals it closes
	 * over, which this ecosystem's local functions routinely do — a hoisted one
	 * would have lost them silently, because the names would then resolve to
	 * members of the class instead of failing.
	 *
	 * Kotlin requires a local function to be declared above its first call, so
	 * there is nothing a `const` fails to hoist for.
	 */
	private localFunction(node: KNode): string {
		const name = this.nameOf(node) ?? 'fun';
		if (this.lookup(name) !== null) this.refuse(node, `a second local \`${name}\``);
		const text = this.functionDeclaration(node, 'local');
		this.declare(name);
		// A suspending local is awaited at its call sites, the same way a
		// suspending member is; an un-awaited one hands the next line a promise.
		if (text.startsWith('async ')) this.localSuspends.add(name);
		return `const ${this.safe(name)} = ${text};`;
	}

	/**
	 * `X ?: return …` and `X ?: throw …`, which are statements pretending to be
	 * expressions.
	 *
	 * There is no JavaScript expression that returns from its enclosing
	 * function, so the elvis is unwrapped into a temporary and a guard wherever
	 * the surrounding position allows it, and refused where it does not.
	 */
	private elvisJump(node: KNode): { value: KNode; jump: KNode } | null {
		if (node.type !== 'elvis_expression') return null;
		const fallback = kids(node)[1];
		if (fallback === undefined || fallback.type !== 'jump_expression') return null;
		return { value: kids(node)[0], jump: fallback };
	}

	/**
	 * Emits one statement with a place in front of it for guards to land.
	 *
	 * `a ?: return` buried inside an expression — `Track(fixUrl(x) ?: return,
	 * lang)` — has no statement position of its own, and JavaScript has no
	 * expression that returns from the enclosing function. The guard therefore
	 * has to move *out* to statement level, which changes when its left-hand
	 * side is evaluated. `hoistableGuards` decides, before a line is emitted,
	 * which guards in this statement can move without changing what the
	 * statement means; everything else still refuses in `expr`.
	 *
	 * Frames nest and are restored rather than stacked-by-count, because a
	 * branch body and a lambda body each open their own statement list and a
	 * guard found in one belongs in front of *its* statement, not the outer one.
	 */
	private rooted(root: KNode, emit: () => string[]): string[] {
		const outer = this.guards;
		const frame: GuardFrame = { hoistable: hoistableGuards(root), lines: [] };
		this.guards = frame;
		try {
			const body = emit();
			return frame.lines.length === 0 ? body : [...frame.lines, ...body];
		} finally {
			this.guards = outer;
		}
	}

	/**
	 * `x ?: return` in an expression position, hoisted in front of its
	 * statement — or refused.
	 *
	 * Hoisting is exact only under the two conditions `hoistableGuards` checks,
	 * and both failures are wrong *values* rather than errors: a guard moved
	 * past a side effect reorders the effect, and a guard moved out of a
	 * conditional runs where Kotlin would not have run it at all.
	 */
	/**
	 * `x.ifEmpty { return@map null }`, hoisted in front of its statement.
	 *
	 * The same move as `hoistedGuard` below and under the same conditions — the
	 * difference is only the test. Kept apart rather than folded in because the
	 * two read differently at the call site and merging them would mean a
	 * parameterised guard that says less than either.
	 */
	private hoistedEmptyGuard(
		node: KNode,
		guarded: { value: KNode; jump: KNode; detached?: KNode; test: string }
	): string {
		const frame = this.guards;
		if (frame === null || !frame.hoistable.has(node)) {
			// A `throw` needs no statement position: it leaves by propagating,
			// which it does out of a callback exactly as out of the member. So
			// `ifEmpty { throw … }` where no hoist can reach is the ordinary
			// call, with a block that throws.
			const raised = this.raisedBy(guarded);
			if (raised !== null) {
				const helper = guarded.test === 'isEmpty' ? 'ifEmpty' : 'ifBlank';
				return `${this.helper(helper)}(${this.expr(guarded.value)}, () => ${raised})`;
			}
			this.refuse(
				node,
				`an \`${guarded.test === 'isEmpty' ? 'ifEmpty' : 'ifBlank'}\` that jumps, used as a value`
			);
		}
		const value = this.expr(guarded.value);
		const holder = this.temporary();
		frame.lines.push(
			`const ${holder} = ${value};`,
			`if (${this.helper(guarded.test)}(${holder})) ${block([this.stmt(guarded.jump, guarded.detached ?? this.jumpValues.get(guarded.jump))])}`
		);
		return holder;
	}

	/**
	 * A `throw` jump as an expression that throws, or null for any other jump.
	 *
	 * `thrown` answers either a helper call that throws on its own (`__k.error`)
	 * or a value to be thrown (a caught error, rethrown); `raise` throws the
	 * latter and is never reached by the former.
	 */
	private raisedBy(guarded: { jump: KNode; detached?: KNode }): string | null {
		const jump = guarded.jump;
		if (jump.allChildren[0]?.type !== 'throw') return null;
		const value =
			kids(jump).find((child) => child.type !== 'label') ??
			guarded.detached ??
			this.jumpValues.get(jump);
		if (value === undefined) return null;
		return `${this.helper('raise')}(${this.thrown(value)})`;
	}

	private hoistedGuard(
		node: KNode,
		guarded: { value: KNode; jump: KNode; detached?: KNode }
	): string {
		const frame = this.guards;
		if (frame === null || !frame.hoistable.has(node)) {
			// `x ?: return@map null` in an argument, inside a block nested in the
			// `map`. There is no statement position to hoist to that would leave
			// the right function — but a non-local jump is a *call* that throws,
			// and a call is an expression. See `nonLocalTarget`.
			const nonLocal = this.nonLocalGuard(guarded);
			if (nonLocal !== null) return nonLocal;
			// `.set("X-Token", token() ?: throw Exception("…"))` — a `throw` is
			// the one jump that is an expression once it is a call, so it stays
			// where it was written and is evaluated when Kotlin would have: only
			// when the left side is null, after everything before it.
			const raised = this.raisedBy(guarded);
			if (raised !== null) return `(${this.expr(guarded.value)} ?? ${raised})`;
			this.refuse(node, 'a `?: return` used as a value');
		}
		// Emitted before the temporary is claimed and before the lines are
		// pushed: a guard nested inside this one's left-hand side pushes its own
		// lines during this call, and they have to land in front of it.
		const value = this.expr(guarded.value);
		const holder = this.temporary();
		frame.lines.push(
			`const ${holder} = ${value};`,
			// Braced, unlike the three statement-position guards: the jump can
			// deliver over several lines — `?: return if (a) b else c` — and an
			// unbraced `if` would take only the first of them and run the rest
			// unconditionally.
			`if (${holder} == null) ${block([this.stmt(guarded.jump, guarded.detached ?? this.jumpValues.get(guarded.jump))])}`
		);
		return holder;
	}

	/**
	 * `x ?: return@label v` where the label names a callback further out, as an
	 * expression: `(x ?? __k.jump(id, v))`.
	 *
	 * Only for a labelled jump that `nonLocalTarget` accepts. An unlabelled
	 * `?: return` still refuses here, because what it means is a return from
	 * the *member*, and the frame that would have to catch it is not one this
	 * has decided to wrap.
	 */
	private nonLocalGuard(guarded: { value: KNode; jump: KNode; detached?: KNode }): string | null {
		const jump = guarded.jump;
		const keyword = jump.allChildren[0]?.type;
		if (keyword !== 'return@' && keyword !== 'return') return null;
		const carriedValue =
			kids(jump).find((child) => child.type !== 'label') ?? guarded.detached ?? null;
		const label = kids(jump).find((child) => child.type === 'label')?.text ?? null;
		// `x ?: return null`, where hoisting the guard to statement level would
		// have reordered it past a side effect. What Kotlin returns from is the
		// member — whether the guard sits inside an inline lambda or directly in
		// the member's own body — and the member is what catches. This is the
		// last resort: `hoistedGuard` prefers the plain `if`/`return`, which
		// costs nothing, and only an expression position no move can reach gets
		// here.
		if (label === null) {
			const member = this.memberJumpTarget();
			if (member === null) return null;
			const value = carriedValue === null ? 'undefined' : this.expr(carriedValue);
			return `(${this.expr(guarded.value)} ?? ${this.helper('jump')}(${member}, ${value}))`;
		}
		// An inlined block leaves by a JavaScript label, which is a statement —
		// so it is no use here and the guard still refuses.
		if (this.inlinedFrameLabelled(label) !== null) return null;
		// `mustCross` is off: even a jump to the callback this code is already
		// inside needs the throw, because the position it is written in is an
		// argument and JavaScript has no `return` there.
		const target = this.nonLocalTarget(label, false);
		if (target === null) return null;
		const value = carriedValue === null ? 'undefined' : this.expr(carriedValue);
		return `(${this.expr(guarded.value)} ?? ${this.helper('jump')}(${target}, ${value}))`;
	}

	private localProperty(node: KNode): string {
		const mutable = kids(node).some(
			(child) => child.type === 'binding_pattern_kind' && child.text === 'var'
		);
		const keyword = mutable ? 'let' : 'const';

		const destructuring = kids(node).find((child) => child.type === 'multi_variable_declaration');
		const initialiser = kids(node).find((child) => !PROPERTY_PARTS.has(child.type));
		if (initialiser === undefined) {
			// `var packed: String` on one line and the assignment on the next,
			// which is how this ecosystem writes a value produced by a loop or
			// by a `try`. Kotlin's definite-assignment rule makes a read before
			// that assignment a compile error *there*, so the undefined the
			// declaration leaves behind can never be observed — which is what
			// makes `let` with no initialiser exact rather than a guess.
			//
			// `const` is not available even for a `val` declared this way: it is
			// the JavaScript for "initialised here", and the assignment is a
			// line further down. So the binding is mutable in the emitted code
			// and Kotlin is the one that guaranteed it is written once.
			if (destructuring !== undefined) this.refuse(node, 'a destructuring with no value');
			const bare = this.propertyName(node);
			if (bare === null) this.refuse(node, 'an unnamed local');
			const unset = this.localBinding(bare);
			this.declareAs(bare, unset, true);
			return `let ${unset};`;
		}

		if (destructuring !== undefined) {
			// Kotlin destructuring is `component1()`, `component2()` — positional
			// over a Pair, a data class, a list or a regex match. The runtime is
			// asked for the components rather than the emitter guessing a shape.
			// Each component is bound the way a single local is — see
			// `localBinding` — because `val (manga, chapters) = …` inside
			// `fetchMangaUpdate(manga, chapters, …)` redeclares two parameters,
			// which is a SyntaxError in the function's own body.
			const value = this.expr(initialiser);
			const names = kids(destructuring).map(boundName);
			const bindings = names.map((name) => (name === '_' ? '' : this.localBinding(name)));
			names.forEach((name, index) => {
				if (name !== '_') this.declareAs(name, bindings[index], mutable);
			});
			return `${keyword} [${bindings.join(', ')}] = ${this.helper('destructured')}(${value});`;
		}

		const name = this.propertyName(node);
		if (name === null) this.refuse(node, 'an unnamed local');
		const binding = this.localBinding(name);
		// The two paths below write the value into the binding from *inside*
		// the initialiser, and an initialiser may declare its own local of the
		// same name — `val url = if (q) { val url = …; url } else …`. The inner
		// one is bound first (the outer does not exist yet), so the branch's
		// write came out as `url = url` against the inner `const`, which is
		// "assignment to constant" at import. The outer takes a fresh spelling
		// whenever the initialiser rebinds its name.
		const target =
			[...walk(initialiser)].some(
				(child) => child.type === 'variable_declaration' && boundName(child) === name
			) && binding === this.safe(name)
				? `${binding}$${(this.temporaries += 1)}`
				: binding;

		const guarded = this.elvisJump(initialiser);
		if (guarded !== null) {
			const value = this.expr(guarded.value);
			this.declareAs(name, binding, mutable);
			return [
				`${keyword} ${binding} = ${value};`,
				`if (${binding} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`
			].join('\n');
		}

		if (DELIVERABLE.has(initialiser.type)) {
			// `val x = try { … } catch { return … }`: the `return` belongs to the
			// enclosing function, so the `try` becomes a statement that assigns and
			// the `return` stays a real return.
			// Declared after the value is written, because the value is emitted
			// in the scope *before* the name exists: in Kotlin a local's own
			// initialiser sees whatever it shadows.
			const lines = this.tail(initialiser, { target });
			this.declareAs(name, target, mutable);
			return [`let ${target};`, lines].join('\n');
		}

		if (this.needsInlining(initialiser)) {
			// `val x = response.use { … return … }`: same argument as the `try`
			// above, one construct along. The block is emitted into this function
			// rather than into a callback, so the `return` is this function's.
			const lines = this.deliver(initialiser, { target });
			this.declareAs(name, target, mutable);
			return [`let ${target};`, ...lines].join('\n');
		}

		const value = this.expr(initialiser);
		this.declareAs(name, binding, mutable);
		return `${keyword} ${binding} = ${value};`;
	}

	/**
	 * The JavaScript name a new local is bound under.
	 *
	 * Its own name, unless something already in scope has it. Kotlin lets a
	 * local shadow a parameter or an outer local — `suspend fun
	 * fetchMangaUpdate(manga: SManga, chapters: …)` goes on to declare `val
	 * manga = createManga()` and `val chapters = if (…) … else chapters` —
	 * and JavaScript does not: a `const` naming a parameter in the function's
	 * own body is a SyntaxError, so the whole bundle failed to build. Where it
	 * did build, in a nested block, the `else chapters` read the new binding
	 * in its dead zone instead of the parameter it meant. A fresh spelling —
	 * `$` cannot occur in a Kotlin name — is what keeps both readings apart.
	 */
	private localBinding(name: string): string {
		if (this.lookupLocal(name) === null) return this.safe(name);
		this.temporaries += 1;
		return `${this.safe(name)}$${this.temporaries}`;
	}

	private assignment(node: KNode): string {
		const target = kids(node)[0];
		const value = kids(node)[kids(node).length - 1];
		const operator = node.allChildren.find((child) => ASSIGN_OPS.has(child.type))?.type ?? '=';
		// `preferences.token = value` — a write through an extension property,
		// which `extensionProperty` does not give a setter. Refused by name:
		// read as an ordinary assignment it would set a field on the store
		// object that nothing ever reads back.
		const written = kids(target);
		const writtenName = kids(written[written.length - 1])
			.filter((child) => child.type === 'simple_identifier')
			.pop()?.text;
		if (
			written.length === 2 &&
			written[1].type === 'navigation_suffix' &&
			writtenName !== undefined &&
			this.extensionProperties.has(writtenName)
		) {
			if (!this.isPreferencesStore(written[0]) || !this.extensionSetters.has(writtenName)) {
				this.refuse(target, `a write to extension property \`${writtenName}\``);
			}
			const store = this.expr(written[0]);
			const self = this.selfReference();
			const given = this.expr(value);
			// `preferences.slugMap += more` on a read-only `Map` is `slugMap =
			// slugMap + more`: Kotlin's `+`, read and written through the
			// accessors, the way a rebound `var` takes it.
			if (operator !== '=' && operator !== '+=' && operator !== '-=') {
				this.refuse(node, `\`${operator}\` on extension property \`${writtenName}\``);
			}
			const next =
				operator === '='
					? given
					: `${this.helper(operator === '+=' ? 'plus' : 'minus')}(${self}.__ext_${writtenName}(${store}), ${given})`;
			return `${self}.__ext_set_${writtenName}(${store}, ${next});`;
		}

		// **The `if` that swallowed its own assignment.**
		//
		// `if (date.isNotEmpty()) chapters.first().date_upload = parse(date)`
		// parses as `(if …) = parse(date)`: Kotlin's assignable rule does not
		// reach over a call, so the grammar takes the whole `if` as the left
		// side rather than the property inside its branch. `assignable` has
		// described this recovery since it was written and refused it, which
		// was right — handing it to `expr` put an immediately-invoked function
		// on the left of an `=` and produced a bundle that would not load.
		//
		// Refusing it is not the only honest answer, though, because the
		// association is recoverable: the target is the branch body, and the
		// assignment belongs inside the `if` rather than around it. Put back
		// where it was written, this is an ordinary conditional write.
		//
		// Worth the re-association because it is not rare. The line above is in
		// `MangaThemesia`, a template with **112 instances** in one catalogue,
		// and a template's blocker is every instance's blocker.
		//
		// Only the `else`-less form. `if (c) a = x else b = y` is two writes
		// with one value and the grammar gives no honest way to tell which
		// branch the parser kept, so it stays refused by `assignable` below.
		// Narrow on purpose: a plain `=`, a target that is not indexed, and a
		// value that is an ordinary expression. Each of the three excluded
		// shapes needs machinery further down this method that this early
		// return would skip, and skipping it silently is how a write ends up
		// pointing at the wrong container. They keep the refusal they had.
		const swallowedIf =
			target !== undefined && target.type === 'directly_assignable_expression'
				? kids(target).find((child) => child.type === 'if_expression')
				: undefined;
		if (swallowedIf !== undefined && operator === '=') {
			const branches = kids(swallowedIf).filter((child) => child.type === 'control_structure_body');
			const condition = kids(swallowedIf)[0];
			const swallowed = branches.length === 1 ? kids(branches[0])[0] : undefined;
			if (
				condition !== undefined &&
				swallowed !== undefined &&
				!this.isIndexedTarget(swallowed) &&
				this.elvisJump(value) === null
			) {
				// `if (x) headers["k"] = v` — the swallowed target is an *index*,
				// which inside the `if` the grammar reads as an ordinary
				// `indexing_expression` rather than an assignable one. Handed to
				// `assignable` it became `__k.index(headers, 'k') = v`, which is
				// not JavaScript: the bundle would not load.
				const write =
					swallowed.type === 'indexing_expression'
						? this.swallowedIndexWrite(swallowed, value)
						: `${this.assignable(swallowed)} = ${this.expr(value)};`;
				return `if (${this.expr(condition)}) ${block([write])}`;
			}
		}

		// `map[key] = value` goes through the runtime for the same reason a read
		// of `map[key]` does: a Kotlin Map is a real `Map` here, and a plain
		// indexed write would hang a property off the map object that no read of
		// it will ever find. A compound `map[k] += v` is refused rather than
		// expanded — the receiver and the key would be evaluated twice, and one
		// of the two is usually a call.
		// `val items = mutableListOf(); items += more` — Kotlin's `plusAssign`,
		// which MUTATES the collection rather than rebinding the name. A `val`
		// cannot be rebound in Kotlin at all, so a `+=` onto one is always this
		// operator and never an addition; that is what makes the two safe to tell
		// apart here, where no types are known.
		//
		// Emitted as written it was `episodes += …` against a `const`, which is a
		// JavaScript syntax error — so the bundle did not load at all, and took
		// every other member with it, out of a conversion that reported nothing
		// refused.
		const rebound = COLLECTION_ASSIGN.get(operator);
		if (rebound !== undefined) {
			// A bare name only. `map[k] += v` is a different question — the
			// receiver and the key would be evaluated twice — and is refused just
			// below, as it was before this.
			const parts = target.type === 'directly_assignable_expression' ? kids(target) : [target];
			const inner = parts.length === 1 ? parts[0] : undefined;
			const local =
				inner !== undefined && inner.type === 'simple_identifier'
					? this.lookupLocal(inner.text)
					: null;
			// `mutableListOf(…).apply { this += more }`: `this` can no more be
			// rebound than a `val` can, so it is `plusAssign` for the same
			// reason. Read as a rebinding it was `this = __k.plus(this, …)`,
			// which is not JavaScript at all — the bundle failed to parse.
			const receiverSelf = inner !== undefined && inner.type === 'this_expression';
			if (receiverSelf || (local !== null && !local.mutable)) {
				const receiver = this.assignable(target);
				// `all += page.entries ?: throw Exception("…")` — the elvis guard
				// below, on the one path that returned before reaching it. The
				// guard is a statement in front of the mutation, which is where
				// Kotlin evaluates it: the right-hand side is read in full before
				// `plusAssign` runs, so a throw leaves the list untouched either
				// way. Left out, this refused a multisrc template's chapter list
				// and every one of the 33 listings built on it.
				const guarded = this.elvisJump(value);
				if (guarded !== null) {
					const temporary = this.temporary();
					return [
						`const ${temporary} = ${this.expr(guarded.value)};`,
						`if (${temporary} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`,
						`${this.helper(rebound)}(${receiver}, ${temporary});`
					].join('\n');
				}
				return `${this.helper(rebound)}(${receiver}, ${this.expr(value)});`;
			}
		}

		const indexed = this.isIndexedTarget(target);
		if (indexed && operator !== '=') this.refuse(node, `an indexed \`${operator}\``);

		// **A safe assignment.** `firstOrNull()?.date_upload = time` writes when
		// the receiver is there and does nothing at all when it is null — the
		// value is not even evaluated. It was emitted as a plain `.` write, which
		// throws on the empty list Kotlin was written to tolerate. Read into a
		// temporary once, and the write goes behind the null test.
		const steps = target.type === 'directly_assignable_expression' ? kids(target) : [];
		if (!indexed && steps.slice(1).some(isSafeStep)) {
			if (steps[steps.length - 1]?.type !== 'navigation_suffix') {
				this.refuse(node, 'a safe assignment this build cannot read');
			}
			// The last step is `.name` or `?.name`, and a name has no dot in it.
			const whole = this.assignable(target);
			const dot = whole.lastIndexOf('.');
			const property = whole.slice(dot + 1);
			const receiver = whole.slice(0, whole.charAt(dot - 1) === '?' ? dot - 1 : dot);
			const temporary = this.temporary();
			return [
				`const ${temporary} = ${receiver};`,
				`if (${temporary} != null) ${temporary}.${property} ${operator} ${this.expr(value)};`
			].join('\n');
		}

		const write = (text: string): string => {
			if (indexed)
				return `${this.helper('setIndex')}(${this.indexedTarget(target).join(', ')}, ${text});`;
			const written = this.assignable(target);
			// `var genres = listOf(…); genres += more` rebinds the name to
			// `genres + more`, and that `+` is Kotlin's — a list concatenation —
			// where JavaScript's `+=` made it one long string. The same `+` as
			// `additive`, and for the same reason: the target's type is what
			// decides it, and nothing here can see one. A `val` local that
			// mutates in place took `plusAssign` above.
			if (rebound !== undefined) {
				const helper = operator === '+=' ? 'plus' : 'minus';
				return `${written} = ${this.helper(helper)}(${written}, ${text});`;
			}
			return `${written} ${operator} ${text};`;
		};

		// `title = element.selectFirst(x)?.text() ?: return@mapNotNull null` is
		// the single most common shape of `?: return` in this catalogue, and it
		// is a statement dressed as an expression exactly the way `localProperty`
		// already unwraps one. Assignment is a statement position too, so the
		// guard has somewhere to go.
		const guarded = this.elvisJump(value);
		if (guarded !== null) {
			const temporary = this.temporary();
			return [
				`const ${temporary} = ${this.expr(guarded.value)};`,
				`if (${temporary} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`,
				write(temporary)
			].join('\n');
		}

		return write(this.expr(value));
	}

	/** `receiver[key] = value` where the target arrived as an `indexing_expression`. */
	private swallowedIndexWrite(target: KNode, value: KNode): string {
		const receiver = kids(target)[0];
		const key = kids(kids(target)[1])[0];
		if (receiver === undefined || key === undefined) this.refuse(target, 'an empty index');
		return `${this.helper('setIndex')}(${this.expr(receiver)}, ${this.expr(key)}, ${this.expr(value)});`;
	}

	/** True when an assignment target's last step is `[…]` rather than `.name`. */
	private isIndexedTarget(node: KNode): boolean {
		if (node.type !== 'directly_assignable_expression') return false;
		const parts = kids(node);
		return parts.length > 1 && parts[parts.length - 1]?.type === 'indexing_suffix';
	}

	/**
	 * An indexed target as the receiver and key `__k.setIndex` takes.
	 *
	 * The receiver is *read*, not written, so its identifier resolves through
	 * `expr` rather than through `assignable`'s write rules — `map` in
	 * `map[k] = v` is the same `map` an expression would have meant.
	 */
	private indexedTarget(node: KNode): [string, string] {
		const parts = kids(node);
		const suffix = parts[parts.length - 1];
		const key = kids(suffix)[0];
		if (key === undefined) this.refuse(suffix, 'an empty index');

		const head = parts[0];
		if (head === undefined) this.refuse(node, 'an empty assignment target');
		let base = this.expr(head);
		for (const step of parts.slice(1, -1)) {
			if (step.type === 'navigation_suffix') {
				const name = kids(step)[0]?.text ?? step.text.replace(/^[.?]+/, '');
				if (name.length === 0) this.refuse(step, 'an assignment to an unnamed property');
				base = `${base}.${name}`;
				continue;
			}
			if (step.type === 'indexing_suffix') {
				const inner = kids(step)[0];
				if (inner === undefined) this.refuse(step, 'an empty index');
				base = `${this.helper('index')}(${base}, ${this.expr(inner)})`;
				continue;
			}
			this.refuse(step, `an assignment target this build cannot read (\`${step.type}\`)`);
		}
		return [base, this.expr(key)];
	}

	/**
	 * The left-hand side of an assignment.
	 *
	 * The grammar does **not** nest a qualified target: `anime.description` is a
	 * `directly_assignable_expression` holding a `simple_identifier` and a
	 * `navigation_suffix` as *siblings*, and `a.b.c` holds one identifier and
	 * two suffixes. Reading only the first child therefore emitted
	 * `anime = …` for `anime.description = …` — dropping the property and
	 * assigning over the object.
	 *
	 * That was worth finding: it only threw here because the receiver happened
	 * to be a `val`. Against a `var` it silently replaces an `SAnime` with a
	 * string, and the failure surfaces much later as a show with no title rather
	 * than as an error — the exact silent wrongness this layer refuses to ship.
	 */
	private assignable(node: KNode): string {
		// Every assignment in every source measured has a
		// `directly_assignable_expression` here, so anything else is the parser
		// having recovered from something it could not read — and the one shape
		// it recovers into is an `if`/`when` swallowing the target:
		// `if (m) episodes.first().name = "x"` parses as `(if …) = "x"` because
		// the assignable rule does not reach over a call. Handing that to `expr`
		// emitted an immediately-invoked function on the left of an `=`, which is
		// a JavaScript syntax error in a bundle that reported nothing refused.
		if (node.type !== 'directly_assignable_expression') {
			// Only the two shapes whose emitted text is itself assignable. An
			// index or a call emits a helper call, and a call on the left of an
			// `=` is a SyntaxError that takes the whole bundle down at load.
			if (node.type !== 'simple_identifier' && node.type !== 'navigation_expression') {
				this.refuse(node, `an assignment target this build cannot read (\`${node.type}\`)`);
			}
			return this.expr(node);
		}
		const parts = kids(node);
		const inner = parts[0];
		if (inner === undefined) this.refuse(node, 'an empty assignment target');
		// A name, `this`, or a parenthesised receiver — and nothing else, because
		// nothing else is assignable in Kotlin. What arrives here instead is the
		// parser having recovered from something it could not read, and it
		// recovers into one shape in particular: the assignable rule does not
		// reach over a call, so `if (m) episodes.first().name = "x"` parses as
		// `(if …) = "x"`. Handed to `expr` that emitted an immediately-invoked
		// function on the left of an `=` — a JavaScript syntax error, in a bundle
		// that reported nothing refused and took every other member down with it.
		if (!ASSIGNABLE_HEADS.has(inner.type)) {
			this.refuse(inner, `an assignment target this build cannot read (\`${inner.type}\`)`);
		}

		let target: string;
		if (
			inner.type === 'simple_identifier' &&
			parts.length > 1 &&
			this.lookup(inner.text) === null &&
			!this.isSourceMember(inner.text) &&
			(this.declaredTypes.has(inner.text) || this.moduleNames.has(inner.text))
		) {
			// `Holder.counter = 0` — the head is a declared type or a module
			// binding being *read*, and the write is to its member. Read as the
			// name being assigned, it came out as `this.Holder.counter`.
			target = this.read(inner.text, inner);
		} else if (inner.type === 'simple_identifier') {
			const local = this.lookup(inner.text);
			const backing = local === null ? this.fieldReference(inner.text, inner) : null;
			// Writes inside `apply {}` go to the receiver: that is the idiom, and
			// Kotlin agrees — an inner lambda's implicit receiver outranks an
			// outer function's parameter. The emitter cannot ask whether the
			// receiver has the member, so it asks the one question that settles
			// the case without knowing: **a `val` or a parameter cannot be
			// assigned in Kotlin at all**, so a write whose name resolves to one
			// of those must have meant the receiver. A `var` stays genuinely
			// ambiguous and keeps the local, which is where an accumulator lives.
			//
			// Getting this backwards is not a crash: `SAnime.create().apply {
			// title = this@Dto.title }` writes the *parameter* instead, and the
			// show installs, searches and lists with no title.
			const receiver = this.receiverAlias();
			if (backing !== null) {
				target = backing;
			} else if (
				local !== null &&
				(receiver === null || this.lookupLocal(inner.text)?.mutable === true)
			) {
				target = local;
			} else if (receiver !== null) {
				target = `${receiver}.${inner.text}`;
			} else if (this.receiverParam !== null && !this.isSourceMember(inner.text)) {
				target = `${this.receiverParam}.${inner.text}`;
			} else if (
				local === null &&
				this.companionClaims.has(inner.text) &&
				!this.isSourceMember(inner.text)
			) {
				// A companion `var`, which is a module binding here: written as
				// `this.counter` it set a field on the instance and left the
				// companion's value where it was.
				target = this.safe(inner.text);
			} else {
				target = `this.${inner.text}`;
			}
		} else {
			target = this.expr(inner);
		}

		for (const suffix of parts.slice(1)) {
			// `chapters[0].date_upload = x` — an index on the way to the property
			// being written is a *read*, and reads through the runtime's `index`
			// like any other. Only the final step is the write, and a final index
			// never reaches here: `isIndexedTarget` sends it to `setIndex`.
			if (suffix.type === 'indexing_suffix') {
				const key = kids(suffix)[0];
				if (key === undefined) this.refuse(suffix, 'an empty index');
				target = `${this.helper('index')}(${target}, ${this.expr(key)})`;
				continue;
			}
			// Only a property write. An indexed write (`map["k"] = v`) needs the
			// runtime's own map semantics rather than JavaScript's, and guessing
			// between them writes to the wrong container.
			if (suffix.type !== 'navigation_suffix') {
				this.refuse(suffix, `an assignment target this build cannot read (\`${suffix.type}\`)`);
			}
			const name = kids(suffix)[0]?.text ?? suffix.text.replace(/^[.?]+/, '');
			if (name.length === 0) this.refuse(suffix, 'an assignment to an unnamed property');
			// `a?.b.c = x`: a safe step on the way to the target is a safe *read*,
			// and JavaScript's own `?.` is exactly that for a property. The last
			// step is the write, and its guard is `assignment`'s — see there.
			target = `${target}${isSafeStep(suffix) ? '?.' : '.'}${name}`;
		}
		return target;
	}

	private forStatement(node: KNode): string {
		const binding = kids(node)[0];
		const iterable = kids(node)[1];
		const body = kids(node)[2] ?? null;
		if (binding === undefined || iterable === undefined) {
			this.refuse(node, 'a `for` this build could not read');
		}

		const sequence = this.expr(iterable);
		this.pushScope();
		try {
			let head: string;
			// `boundName`, not `.text`: Kotlin lets a `for` binding carry its type
			// — `for (item: MatchResult in matches)` — and the annotation is part
			// of the declaration node's own text. Passed through it produced
			// `for (const item: MatchResult of …)`, a JavaScript SyntaxError that
			// surfaces when the *bundle* is imported and takes every member with
			// it rather than the one that was written with a type.
			if (binding.type === 'multi_variable_declaration') {
				const names = kids(binding).map(boundName);
				for (const name of names) this.declare(name);
				head = `const ${this.pattern(names)}`;
			} else {
				const name = boundName(binding);
				this.declare(name);
				head = `const ${this.safe(name)}`;
			}
			return `for (${head} of ${sequence}) ${block(this.loopBody(body))}`;
		} finally {
			this.popScope();
		}
	}

	private jump(node: KNode, detached?: KNode): string {
		const keyword = node.allChildren[0]?.type ?? '';
		const value =
			kids(node).find((child) => child.type !== 'label') ?? detached ?? this.jumpValues.get(node);

		if (keyword === 'throw') {
			if (value === undefined) this.refuse(node, 'a `throw` with nothing to throw');
			return `throw ${this.thrown(value)};`;
		}

		if (keyword === 'break' || keyword === 'continue') {
			// Answered by what encloses it most closely, not by whether a lambda
			// encloses it anywhere: `forEach { for (x in xs) { … break } }` breaks
			// a loop inside the lambda, which is ordinary, and was refused as
			// crossing one. What must not happen is a JavaScript `break` landing
			// on a loop Kotlin did not mean — past a callback, which is a syntax
			// error, or out of an inlined `forEach`, which is a `for…of` here and
			// a lambda in Kotlin. See `loopBody`.
			if (this.loops[this.loops.length - 1] !== 'loop') {
				this.refuse(node, `a \`${keyword}\` crossing a lambda`);
			}
			return `${keyword};`;
		}

		if (keyword === 'return' || keyword === 'return@') {
			const label = kids(node).find((child) => child.type === 'label')?.text ?? null;
			if (label !== null) {
				// `return@forEach` inside a block this emitter inlined leaves that
				// block rather than the member — a `continue` for a loop, a
				// labelled `break` for anything else. There is no callback left
				// for a plain `return` to have returned from.
				const inlined = this.inlinedFrameLabelled(label);
				if (inlined !== null) return this.inlineExit(inlined, value);
			}
			if (this.inLambda()) {
				// A bare `return` inside a Kotlin inline lambda returns from the
				// *enclosing function*. The same text in JavaScript returns from
				// the lambda, and the method then produces a different value with
				// nothing anywhere reporting an error — so it leaves by the same
				// throw a labelled non-local return uses, and the member catches
				// it. Kotlin only permits this inside an *inline* lambda, so a
				// source that compiles and writes one has said which function it
				// meant: the enclosing member.
				if (label === null) {
					const member = this.memberJumpTarget();
					if (member === null) this.refuse(node, 'a non-local `return` from a lambda');
					const carried = value === undefined ? 'undefined' : this.expr(value);
					return `throw ${this.helper('jump')}(${member}, ${carried});`;
				}
				// The label is compared against the innermost *callback*, not the
				// innermost frame: an inlined block sits inside the callback it
				// was written in, so `map { x.apply { return@map … } }` names the
				// `map` this code is already inside of.
				if (label !== this.enclosingCallbackLabel()) {
					const target = this.nonLocalTarget(label);
					if (target === null) this.refuse(node, `a \`return@${label}\` crossing a lambda`);
					const carried = value === undefined ? 'undefined' : this.expr(value);
					return `throw ${this.helper('jump')}(${target}, ${carried});`;
				}
			}
			if (value === undefined) return 'return;';
			return this.deliver(value, 'return').join('\n');
		}

		this.refuse(node, spoken(node));
	}

	private thrown(node: KNode): string {
		// `catch (e: Exception) { …; throw e }` and `onFailure { throw it }` —
		// rethrowing what was caught, which is a local holding the very error
		// the runtime threw. Only a local: a name that is not one is not
		// something this can know is an exception at all.
		if (node.type === 'simple_identifier') {
			const local = this.lookup(node.text);
			if (local !== null) return local;
		}
		const isCall = node.type === 'call_expression';
		const callee = isCall ? kids(node)[0] : node;
		const typeName = callee?.text ?? '';
		const helper = thrownHelper(typeName);
		if (helper === null) this.refuse(node, `\`throw ${typeName}\``);

		const args = isCall
			? kids(kids(kids(node)[1]).find((child) => child.type === 'value_arguments'))
			: [];
		const message = args.length === 0 ? '' : this.expr(this.argumentValue(args[0]));
		return `${this.helper(helper)}(${message})`;
	}

	private ifStatement(node: KNode, sink: Sink = null): string {
		const condition = kids(node)[0];
		const all = kids(node).filter((child) => child.type === 'control_structure_body');
		// The `when`'s own `else` branch, mis-attached to this `if` by the
		// grammar — always the last one, because the shape it is recognised by
		// puts it after the `else`. `whenChain` picks it up from the same
		// recogniser and emits it where it was written; here it is simply not an
		// else. Dropped by position rather than by identity: the two child
		// accessors wrap the same tree-sitter node in different objects.
		const branches = swallowedWhenElse(node) === null ? all : all.slice(0, -1);
		const head = `if (${this.expr(condition)}) ${block(this.branchLines(branches[0] ?? null, sink))}`;
		if (branches.length < 2) {
			// An `if` with no `else`, used as a value, is absent when it misses.
			return sink === null ? head : `${head} else ${block(this.deliverNull(sink))}`;
		}
		const otherwise = branches[1];
		const single = kids(otherwise)[0];
		if (
			kids(otherwise).length === 1 &&
			single !== undefined &&
			single.type === 'if_expression' &&
			!otherwise.allChildren.some((child) => child.type === '{')
		) {
			return `${head} else ${this.ifStatement(single, sink)}`;
		}
		return `${head} else ${block(this.branchLines(otherwise, sink))}`;
	}

	/**
	 * `when`, as an if/else chain.
	 *
	 * The `sink` is what makes the same code serve every position: as a
	 * statement each branch is emitted plainly, and as a value each branch
	 * returns or assigns its tail.
	 */
	private whenChain(node: KNode, sink: Sink): string {
		const subject = kids(node).find((child) => child.type === 'when_subject');
		// `when (val e = m.groupValues[1]) { … }` binds the subject to a name
		// the branches read. The grammar gives the binding first and the value
		// second; read as the subject, the binding was an undeclared `e`.
		const binding = kids(subject)[0]?.type === 'variable_declaration' ? kids(subject)[0] : null;
		const subjectValue = binding === null ? kids(subject)[0] : kids(subject)[1];
		const bound =
			binding === null
				? null
				: (kids(binding).find((child) => child.type === 'simple_identifier')?.text ?? null);
		if (binding !== null && (bound === null || subjectValue === undefined)) {
			this.refuse(binding, 'a `when` subject binding this build could not read');
		}
		const name = subjectValue === undefined ? null : this.temporary();

		const lines: string[] = [];
		if (name !== null && subjectValue !== undefined) {
			lines.push(`const ${name} = ${this.expr(subjectValue)};`);
		}
		// The name is in scope for the branches and nowhere else, as Kotlin's.
		if (bound !== null && name !== null) {
			this.pushScope();
			this.declareAs(bound, name, false);
		}
		try {
			return this.whenBranches(node, sink, name, lines);
		} finally {
			if (bound !== null && name !== null) this.popScope();
		}
	}

	private whenBranches(node: KNode, sink: Sink, name: string | null, lines: string[]): string {
		const clauses: string[] = [];
		let fallback: string | null = null;
		for (const entry of kids(node)) {
			if (entry.type !== 'when_entry') continue;
			const body = kids(entry).find((child) => child.type === 'control_structure_body') ?? null;
			const branch = block(this.branchLines(body, sink));
			const test = this.whenTest(entry, name);
			if (test === null) fallback = branch;
			else clauses.push(`if (${test}) ${branch}`);
			// This entry's body may have eaten the `else ->` that follows it —
			// see `swallowedWhenElse`. The branch belongs to this `when`, and
			// this is the only place that can put it back.
			const stolen = this.swallowedElse(body);
			if (stolen !== null) fallback = block(this.branchLines(stolen, sink));
		}

		// A `when` used as a value with no `else` is absent when nothing matches.
		if (fallback === null && sink !== null) fallback = block(this.deliverNull(sink));

		let chain = clauses.join(' else ');
		if (fallback !== null) chain = chain.length === 0 ? fallback : `${chain} else ${fallback}`;
		if (chain.length === 0) chain = '{}';
		if (name === null) return chain;
		lines.push(chain);
		return block(lines);
	}

	/**
	 * The `when` `else` branch a `when` entry's body swallowed, if it did.
	 *
	 * Searched rather than read off a fixed position: the `if` that took it is
	 * the last statement of the entry, but it may be nested one deep inside a
	 * `control_structure_body` or an inner `if`/`else` chain, and only the last
	 * one in source order can be the `when`'s.
	 */
	private swallowedElse(body: KNode | null): KNode | null {
		if (body === null) return null;
		let found: KNode | null = null;
		for (const node of walk(body)) {
			const swallowed = swallowedWhenElse(node);
			if (swallowed !== null) found = swallowed.branch;
		}
		return found;
	}

	private tryBlock(node: KNode, sink: Sink): string {
		const body = kids(node).find((child) => child.type === 'statements');
		const written = kids(node).filter((child) => child.type === 'catch_block');
		const ensure = kids(node).find((child) => child.type === 'finally_block');
		const catches = this.reachableCatches(written);

		let text = `try ${block(body === undefined ? [] : this.statementList(body, sink))}`;
		if (catches.length === 1) {
			const clause = catches[0];
			const name = kids(clause).find((child) => child.type === 'simple_identifier')?.text ?? 'e';
			const inner = kids(clause).find((child) => child.type === 'statements');
			this.pushScope();
			this.declare(name);
			const lines = inner === undefined ? [] : this.statementList(inner, sink);
			this.popScope();
			// A non-local `return` crosses a callback by throwing — see
			// `nonLocalTarget` — and a `catch` the source wrote must not swallow
			// it. Kotlin's `return` is not an exception there, so a `try` around
			// it never sees one; here it would, and the member would answer the
			// handler's value instead of the one the source returned. Emitted
			// in every translated `catch` rather than only where a jump is known
			// to be in flight: whether one is depends on code emitted *after*
			// this line, and a guard that is sometimes absent is the kind of
			// conditional correctness this converter has been bitten by before.
			// It costs one comparison on a path that is already an error.
			const guard = [`if (${this.helper('isJump')}(${this.safe(name)})) throw ${this.safe(name)};`];
			text += ` catch (${this.safe(name)}) ${block([...guard, ...lines])}`;
		}
		if (ensure !== undefined) {
			const inner = kids(ensure).find((child) => child.type === 'statements');
			// A `finally` never produces the value, so it never returns one.
			text += ` finally ${block(inner === undefined ? [] : this.statementList(inner, null))}`;
		}
		return text;
	}

	/**
	 * The `catch` clauses that can run here, or a refusal.
	 *
	 * JavaScript has one `catch` and no type to dispatch on, and this runtime
	 * throws plain `Error`s, so a Kotlin clause list can be kept only where the
	 * type tests would not have decided anything. The shape this ecosystem
	 * writes is exactly that: `catch (e: CancellationException) { throw e }`
	 * and then `catch (e: Exception) { … }`. Nothing here cancels a coroutine
	 * — there is no dispatcher to do it — so the first clause can never run,
	 * and the catch-all is the whole of what is left. Any other list would need
	 * the type of an error this runtime does not carry, and is refused.
	 */
	private reachableCatches(clauses: readonly KNode[]): readonly KNode[] {
		if (clauses.length <= 1) return clauses;
		const typeOf = (clause: KNode): string =>
			typeName(kids(clause).find((child) => child.type.endsWith('type')))
				.split('.')
				.pop() ?? '';
		const last = clauses[clauses.length - 1];
		const unreachable = clauses.slice(0, -1).every((one) => NEVER_THROWN.has(typeOf(one)));
		if (!unreachable || !CATCH_ALL.has(typeOf(last))) {
			this.refuse(clauses[1], 'more than one `catch` clause');
		}
		return [last];
	}

	private bodyLines(node: KNode | null): string[] {
		return this.branchLines(node, null);
	}

	/**
	 * A Kotlin loop's body, with the loop recorded as what a `break` inside it
	 * leaves.
	 *
	 * `loops` is the innermost-last list of the constructs an unlabelled
	 * `break` or `continue` could land on: a Kotlin loop, or a barrier — a
	 * callback, which JavaScript's `break` cannot cross, and an inlined
	 * `forEach`, which is a JavaScript loop where Kotlin had a lambda. Only a
	 * Kotlin loop on top is a `break` that means what it says.
	 */
	private loopBody(node: KNode | null): string[] {
		this.loops.push('loop');
		try {
			return this.bodyLines(node);
		} finally {
			this.loops.pop();
		}
	}

	/** One branch of an `if`/`when`/`try`, delivering its tail to the sink. */
	private branchLines(node: KNode | null, sink: Sink): string[] {
		if (node === null) return [];
		if (node.type !== 'control_structure_body') {
			return this.rooted(node, () => this.deliver(node, sink));
		}
		const statements = kids(node).find((child) => child.type === 'statements');
		if (statements !== undefined) return this.statementList(statements, sink);
		const single = kids(node)[0];
		if (single === undefined) return [];
		return this.rooted(single, () =>
			this.isValueShaped(single) ? this.deliver(single, sink) : [this.stmt(single)]
		);
	}

	private whenTest(entry: KNode, subject: string | null): string | null {
		const conditions = kids(entry).filter((child) => child.type === 'when_condition');
		if (conditions.length === 0) return null;

		const tests = conditions.map((condition) => {
			const inner = kids(condition)[0];
			if (inner === undefined) this.refuse(condition, 'an empty `when` branch');

			if (inner.type === 'type_test') {
				if (subject === null) this.refuse(inner, 'an `is` branch in a subjectless `when`');
				const test = `${this.helper('isType')}(${subject}, ${this.typeReference(typeName(kids(inner)[0]))})`;
				return inner.allChildren[0]?.type === '!is' ? `!${test}` : test;
			}
			if (inner.type === 'range_test') {
				if (subject === null) this.refuse(inner, 'an `in` branch in a subjectless `when`');
				const test = `${this.helper('contains')}(${this.expr(kids(inner)[0])}, ${subject})`;
				return inner.allChildren[0]?.type === '!in' ? `!${test}` : test;
			}
			const value = this.expr(inner);
			return subject === null ? value : `${subject} === ${value}`;
		});

		return tests.length === 1 ? tests[0] : `(${tests.join(' || ')})`;
	}

	/* ── expressions ─────────────────────────────────────────────────────── */

	private expr(node: KNode): string {
		switch (node.type) {
			case 'call_expression':
				return this.call(node);
			case 'navigation_expression':
				return this.navigation(node);
			case 'indexing_expression': {
				const index = kids(kids(node)[1])[0];
				if (index === undefined) this.refuse(node, 'an empty index');
				// Through the runtime rather than as `a[b]`: this runtime models
				// a Kotlin Map as a real `Map`, where JavaScript indexing reads a
				// property of the map object and answers `undefined` for every
				// key. See `__k.index`.
				return `${this.helper('index')}(${this.expr(kids(node)[0])}, ${this.expr(index)})`;
			}
			case 'simple_identifier':
			case 'interpolated_identifier':
				return this.read(node.text, node);
			case 'string_literal':
				return this.stringLiteral(node);
			case 'character_literal':
				return jsString(decodeEscapes(node.text.slice(1, -1)));
			case 'integer_literal':
			case 'hex_literal':
			case 'bin_literal':
				return node.text.replace(/_/g, '');
			case 'long_literal':
				return node.text.replace(/_/g, '').replace(/[lL]$/, '');
			case 'unsigned_literal':
				return node.text.replace(/_/g, '').replace(/[uU][lL]?$/, '');
			case 'real_literal':
				return node.text.replace(/_/g, '').replace(/[fF]$/, '');
			case 'boolean_literal':
				return node.text;
			case 'null':
				return 'null';
			case 'super_expression':
				this.refuse(node, '`super` used on its own');
				break;
			case 'this_expression': {
				// `this@Outer` names an outer receiver by label. When the label is
				// the class being emitted, that is the class instance — exactly
				// what `selfReference` already reaches past an `apply {}` block
				// for, and what the Kotlin means: escape the receiver, address the
				// source. A label naming anything else is a receiver this build no
				// longer has, and guessing which one it was is how a scraper reads
				// a selector off the wrong object.
				const label = /^this@(\w+)$/.exec(node.text)?.[1] ?? null;
				if (label === null) {
					if (node.text !== 'this') this.refuse(node, `\`${node.text}\``);
					// Inside an `apply {}`, a bare `this` is the receiver — which
					// is JavaScript's `this` when the block is a `function () {}`
					// and a named `const` when the block was inlined.
					//
					// Inside `fun String.fixLink()` it is the *extension
					// receiver*, which this emitter moved into a parameter. Left
					// as `this` it meant the source object: `"https:$this"` came
					// out as the class rather than the string it was prefixing.
					return this.receiverAlias() ?? this.receiverParam ?? 'this';
				}
				return this.labelledThis(label, node);
			}
			case 'parenthesized_expression': {
				const inner = kids(node)[0];
				if (inner === undefined) this.refuse(node, 'empty parentheses');
				return `(${this.expr(inner)})`;
			}
			case 'elvis_expression': {
				const guarded = this.elvisJump(node);
				if (guarded !== null) return this.hoistedGuard(node, guarded);
				return `(${this.expr(kids(node)[0])} ?? ${this.expr(kids(node)[1])})`;
			}
			case 'equality_expression': {
				const operands = kids(node);
				const nullable = operands.some((part) => part.type === 'null' || part.text === 'null');
				return this.binary(node, (operator) => {
					if (nullable) return operator.startsWith('==') ? '==' : '!=';
					return operator.startsWith('==') ? '===' : '!==';
				});
			}
			case 'comparison_expression': {
				const generic = this.genericReference(node);
				if (generic !== null) return generic;
				return this.binary(node, (operator) => operator);
			}
			case 'additive_expression':
				return this.additive(node);
			case 'multiplicative_expression':
				return this.binary(node, (operator) => operator);
			case 'conjunction_expression':
				return this.binary(node, () => '&&');
			case 'disjunction_expression':
				return this.binary(node, () => '||');
			case 'range_expression':
				return `${this.helper('range')}(${this.expr(kids(node)[0])}, ${this.expr(kids(node)[1])})`;
			case 'infix_expression':
				return this.infix(node);
			case 'check_expression':
				return this.check(node);
			case 'as_expression':
				return this.cast(node);
			case 'prefix_expression': {
				const operator = node.allChildren[0]?.type ?? '';
				// `if (++iterations > MAX) break` — increment, then read. The grammar
				// hangs the operator over the whole comparison, as it does `-` and
				// `!`, so it goes through `prefixOver` to reach its operand; see
				// there for what it may apply to.
				if (
					operator !== '-' &&
					operator !== '+' &&
					operator !== '!' &&
					operator !== '++' &&
					operator !== '--'
				) {
					this.refuse(node, `a prefix \`${operator}\``);
				}
				return this.prefixOver(operator, kids(node)[0]);
			}
			case 'postfix_expression':
				return this.postfix(node);
			case 'if_expression':
				return this.ifExpression(node);
			case 'when_expression':
				return this.iife(() => [this.whenChain(node, 'return'), 'return null;']);
			case 'try_expression':
				return this.iife(() => [this.tryBlock(node, 'return')]);
			case 'lambda_literal':
				return this.lambda(node, false);
			case 'callable_reference':
				return this.callableReference(node);
			case 'object_literal':
				return this.objectLiteral(node);
			case 'spread_expression': {
				const value = kids(node)[0];
				if (value === undefined) this.refuse(node, 'an empty `*` vararg spread');
				return `...${this.expr(value)}`;
			}
			case 'jump_expression':
				this.refuse(node, 'a `return` or `throw` used as a value');
				break;
			default:
				this.refuse(node, LOCAL_DECLARATIONS.get(node.type) ?? spoken(node));
		}
		this.refuse(node, spoken(node));
	}

	private binary(node: KNode, map: (operator: string) => string, prefix = ''): string {
		const operator = node.allChildren.find((child) => BINARY_TOKENS.has(child.type));
		if (operator === undefined) {
			this.refuse(node, `an operator this build could not read, in ${spoken(node)}`);
		}
		const left = kids(node)[0];
		const right = kids(node)[kids(node).length - 1];
		const head = prefix.length === 0 ? this.expr(left) : this.prefixOver(prefix, left);
		return `(${head} ${map(operator.type)} ${this.expr(right)})`;
	}

	/**
	 * `a + b` and `a - b`, which are JavaScript's operators only for numbers
	 * and strings.
	 *
	 * Kotlin resolves `+` on the left operand's type, and most of what an
	 * extension adds is not a number: `listOf(a) + listOf(b)`, `EVERY +
	 * getPairList(n)`, `map + (k to v)`, `ids - seen`. JavaScript's `+` reads
	 * every one of those as text — `"1,2"` where a list was meant — and its
	 * `-` answers NaN, with nothing refused and nothing thrown. So an operand
	 * this cannot *prove* is a number or a string goes through `__k.plus` or
	 * `__k.minus`, which dispatch on the value at run time the way Kotlin
	 * dispatched on its type.
	 *
	 * Proof is the left operand's shape, because that is the one Kotlin reads:
	 * a numeric literal or arithmetic, or a string literal or template. `x + 1`
	 * proves nothing — `x` may be a list — so it takes the helper, which adds
	 * two numbers exactly as the operator would.
	 *
	 * A `Char` literal on the left is the one type a value cannot reveal at run
	 * time, since a Char is a one-character string here and `'a' + 1` would
	 * concatenate. Kotlin has no other `Char.plus`, so it is code arithmetic.
	 */
	private additive(node: KNode, prefix = ''): string {
		const operator = node.allChildren.find((child) => child.type === '+' || child.type === '-');
		if (operator === undefined) {
			this.refuse(node, `an operator this build could not read, in ${spoken(node)}`);
		}
		const left = kids(node)[0];
		const right = kids(node)[kids(node).length - 1];
		const head = prefix.length === 0 ? this.expr(left) : this.prefixOver(prefix, left);
		const tail = this.expr(right);
		const shape = prefix === '-' || prefix === '+' ? 'number' : primitiveShape(left);
		if (shape === 'number' || (shape === 'string' && operator.type === '+')) {
			return `(${head} ${operator.type} ${tail})`;
		}
		if (shape === 'char' && prefix.length === 0) {
			const code = `${head}.charCodeAt(0)`;
			return operator.type === '+'
				? `String.fromCharCode(${code} + ${tail})`
				: `${this.helper('minus')}(${head}, ${tail})`;
		}
		const helper = operator.type === '+' ? 'plus' : 'minus';
		return `${this.helper(helper)}(${head}, ${tail})`;
	}

	/**
	 * A prefix operator applied to its operand — which is not what the tree says.
	 *
	 * The vendored grammar parses `!a && b` as `prefix(conjunction(a, b))`: the
	 * operand of `!` is the whole binary expression. Emitting that faithfully
	 * gives `!(a && b)`, and Kotlin means `(!a) && b`. Prefix binds tighter than
	 * every binary operator in Kotlin — multiplicative, additive, range,
	 * comparison, equality, conjunction, disjunction — so the operator belongs
	 * to the LEFTMOST operand and the structure around it is unchanged.
	 *
	 * Measured, because the failure is silent: `!a && b` answered the negation
	 * of the whole condition, `-x + y` answered `-(x + y)`, and nothing
	 * anywhere said so. One extension's search read
	 * `if (!filter.isDefault() && query.isBlank())` and therefore dropped the
	 * query on every search that had one.
	 *
	 * Recursive, so `!a && !b && !c` re-associates all the way down rather than
	 * only at the top.
	 */
	private prefixOver(operator: string, node: KNode): string {
		switch (node.type) {
			case 'equality_expression':
				return this.binary(node, (token) => (token.startsWith('==') ? '===' : '!=='), operator);
			case 'additive_expression':
				return this.additive(node, operator);
			case 'comparison_expression':
			case 'multiplicative_expression':
				return this.binary(node, (token) => token, operator);
			case 'conjunction_expression':
				return this.binary(node, () => '&&', operator);
			case 'disjunction_expression':
				return this.binary(node, () => '||', operator);
			case 'range_expression': {
				const parts = kids(node);
				const from = parts[0];
				const to = parts[parts.length - 1];
				return `${this.helper('range')}(${this.prefixOver(operator, from)}, ${this.expr(to)})`;
			}
			default: {
				const operand = this.expr(node);
				// `++`/`--` need a place, which JavaScript's operator shares with
				// Kotlin's provided the operand is still one after translation: a
				// local or a plain property path. A property the emitter reads
				// through a getter call is not, and `++this.count()` is a
				// SyntaxError that takes the whole bundle down at load.
				if (
					(operator === '++' || operator === '--') &&
					!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(operand)
				) {
					this.refuse(node, `a prefix \`${operator}\` on something that is not a variable`);
				}
				return operator === '++' || operator === '--'
					? `(${operator}${operand})`
					: `${operator}${operand}`;
			}
		}
	}

	private infix(node: KNode): string {
		const [left, name, right] = kids(node);
		if (name === undefined || right === undefined) {
			this.refuse(node, `an infix call this build could not read, in ${spoken(node)}`);
		}
		if (name.text === 'to') {
			return `${this.helper('to')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'until') {
			return `${this.helper('until')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'downTo') {
			return `${this.helper('downTo')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		// `for (i in 0 until len step 2)` — left-associative, so the left side is
		// already the progression, whichever of the three built it. `step` is
		// Kotlin's only way to stride a loop, and a decrypt routine walking a
		// byte array two at a time is where this ecosystem writes it.
		if (name.text === 'step') {
			return `${this.helper('step')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'matches') {
			return `${this.helper('regexMatches')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'and') {
			return `${this.helper('bitwiseAnd')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'or') {
			return `${this.helper('bitwiseOr')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'xor') {
			return `${this.helper('bitwiseXor')}(${this.expr(left)}, ${this.expr(right)})`;
		}
		if (name.text === 'shl') return `(${this.expr(left)} << ${this.expr(right)})`;
		if (name.text === 'shr') return `(${this.expr(left)} >> ${this.expr(right)})`;
		if (name.text === 'ushr') return `(${this.expr(left)} >>> ${this.expr(right)})`;
		this.refuse(node, `the infix function \`${name.text}\``);
	}

	/**
	 * The type arguments a call to a reified function has to carry.
	 *
	 * Refused rather than guessed when the call site names none: the parameter
	 * would arrive `undefined`, `__isType` would answer false for every value,
	 * and the filter list the helper was reading would come back empty with
	 * nothing anywhere saying so.
	 */
	private reifiedArguments(
		at: KNode,
		name: string,
		typed: string | null,
		expected: string | null = null,
		receiverType: string | null = null
	): string[] {
		const reified = this.reifiedFunctions.get(name);
		if (reified === undefined || reified.length === 0) return [];
		// Kotlin infers an omitted argument; this follows it only where the
		// parameter *is* the return type or the receiver type — see
		// `reifiedFrom` — and the other side of it is written down.
		const from = this.reifiedFrom.get(name);
		const written =
			typed ??
			(from?.returns === true ? expected : null) ??
			(from?.receiver === true ? receiverType : null);
		if (written === null) {
			this.refuse(at, `\`.${name}()\` with no type argument for its \`reified\` parameter`);
		}
		const parts = written.split(',').map((one) => one.trim());
		if (parts.length !== reified.length) {
			this.refuse(at, `\`.${name}()\` with ${parts.length} type arguments for ${reified.length}`);
		}
		return parts.map((one) => this.typeReference(one));
	}

	/**
	 * What an `is Foo` hands the runtime: the class itself, or its name.
	 *
	 * `__isType` answers a constructor with `instanceof` and a *string* by
	 * looking it up in its own small table of framework shapes. Every `is`
	 * used to emit the string, so `when (filter) { is OrderByFilter -> … }`
	 * asked that table about a class the converted module declares four lines
	 * above — got nothing, took no branch, and searched with every filter
	 * silently ignored. Nothing refused and nothing threw; the request simply
	 * went out without the parameters the viewer had chosen.
	 *
	 * Only a type emitted as a real ES6 `class` can be handed over: a `data
	 * class` is a factory function and an `object` is a frozen literal, and
	 * `instanceof` is false for both. Those keep the name, and the table keeps
	 * answering for the framework's own types.
	 */
	private typeReference(written: string): string {
		// `it is R` inside `inline fun <reified R>` means the type written at the
		// call site, which arrives as an argument.
		const bound = this.reifiedTypes?.get(written);
		if (bound !== undefined) return bound;
		const name = this.aliased(written);
		// `is Filters.TypeFilter` — the qualified spelling of a nested type.
		// Read as a name it is the *string* "Filters.TypeFilter", which
		// `__isType` looks up in its small table of framework shapes, does not
		// find, and answers false for — so the branch never ran and no refusal
		// said so.
		const nested = this.qualifiedTypes.get(name);
		if (nested !== undefined && this.moduleNames.has(nested)) return this.safe(nested);
		const hoisted = this.localTypes.get(name) ?? name;
		if (this.newableTypes.has(name) && this.moduleNames.has(hoisted)) return this.safe(hoisted);
		return JSON.stringify(name);
	}

	private check(node: KNode): string {
		const operator = node.allChildren.find((child) => CHECK_OPS.has(child.type));
		if (operator === undefined) {
			this.refuse(node, `an \`is\`/\`in\` this build could not read, in ${spoken(node)}`);
		}
		const left = kids(node)[0];
		const right = kids(node)[kids(node).length - 1];

		if (operator.type === 'is' || operator.type === '!is') {
			const test = `${this.helper('isType')}(${this.expr(left)}, ${this.typeReference(typeName(right))})`;
			return operator.type === 'is' ? test : `!${test}`;
		}
		const test = `${this.helper('contains')}(${this.expr(right)}, ${this.expr(left)})`;
		return operator.type === 'in' ? test : `!${test}`;
	}

	private cast(node: KNode): string {
		const operator = node.allChildren.find((child) => child.type === 'as' || child.type === 'as?');
		const helper = operator?.type === 'as?' ? 'castOrNull' : 'cast';
		const value = this.expr(kids(node)[0]);
		const target = JSON.stringify(typeName(kids(node)[kids(node).length - 1]));
		return `${this.helper(helper)}(${value}, ${target})`;
	}

	private postfix(node: KNode): string {
		const operator = node.allChildren[node.allChildren.length - 1]?.type ?? '';
		const inner = kids(node)[0];
		if (operator === '!!') {
			// `!!` must throw, and the message must name which expression was
			// null: a converted plugin failing with "null" names nothing.
			return `${this.helper('nn')}(${this.expr(inner)}, ${JSON.stringify(describe(inner))})`;
		}
		if (operator === '++' || operator === '--') return `${this.expr(inner)}${operator}`;
		this.refuse(node, `a postfix \`${operator}\``);
	}

	private ifExpression(node: KNode): string {
		const condition = kids(node)[0];
		const branches = kids(node).filter((child) => child.type === 'control_structure_body');
		const inlineable =
			branches.length === 2 &&
			branches.every(
				(branch) =>
					kids(branch).length === 1 &&
					!branch.allChildren.some((child) => child.type === '{') &&
					this.isValueShaped(kids(branch)[0])
			);
		if (inlineable) {
			return `(${this.expr(condition)} ? ${this.expr(kids(branches[0])[0])} : ${this.expr(kids(branches[1])[0])})`;
		}
		return this.iife(() => {
			const lines = [
				`if (${this.expr(condition)}) ${block(this.branchLines(branches[0] ?? null, 'return'))}`
			];
			if (branches.length > 1) lines.push(`else ${block(this.branchLines(branches[1], 'return'))}`);
			lines.push('return null;');
			return lines;
		});
	}

	/**
	 * `::member`, `Type::member`, and the one form that is reflection.
	 *
	 * `::class` is refused — nothing in the sandbox can answer it. The other two
	 * are ordinary: `.map(::wrap)` calls a member of the source, and
	 * `.filter(String::isNotBlank)` names a standard-library function on
	 * whatever it is given. The receiver type is *discarded* in the second case
	 * rather than checked, because there is no type system here to check it
	 * against; what decides the translation is the member name, exactly as it
	 * would for `it.isNotBlank()`.
	 */
	/**
	 * `List<String>::isNotEmpty` — an unbound reference whose receiver type
	 * carries type arguments, which the grammar reads as arithmetic.
	 *
	 * `List < String > (::isNotEmpty)` is a valid parse of those characters and
	 * the one tree-sitter takes, so the reference arrives as a comparison whose
	 * last operand is a bare `::member`. Nothing else produces that shape: a
	 * real comparison cannot have a callable reference on its right, because
	 * Kotlin has no ordering on functions.
	 *
	 * The type before the `<` is read back out of the text, so a declared DTO
	 * still resolves to its own member and the runtime's tables still answer
	 * for `List`, `Set` and `Map` — the three this ecosystem writes it with.
	 */
	private genericReference(node: KNode): string | null {
		const parts = node.allChildren;
		const reference = parts[parts.length - 1];
		if (reference === undefined || reference.type !== 'callable_reference') return null;
		const member = kids(reference)[0];
		if (kids(reference).length !== 1 || member?.type !== 'simple_identifier') return null;
		const owner = /^([A-Za-z_]\w*)\s*</.exec(node.text.trim())?.[1] ?? null;
		if (owner === null) return null;

		const name = member.text;
		if (
			this.declaredTypes.has(owner) &&
			!this.declaredObjects.has(owner) &&
			this.qualifiedSignatures.has(`${owner}.${name}`) &&
			!this.declaredSuspends.has(name)
		) {
			return `(__recv, ...__a) => __recv.${this.safe(name)}(...__a)`;
		}
		if (this.classFieldIndex.get(owner)?.has(name) === true) {
			return `(__recv) => __recv.${this.safe(name)}`;
		}
		const helper = EXTENSION_METHODS.get(name);
		if (helper !== undefined) return `(__a) => ${this.helper(helper)}(__a)`;
		const property = EXTENSION_PROPERTIES.get(name);
		if (property !== undefined) return `(__a) => ${this.helper(property)}(__a)`;
		if (HOST_PROPERTY_METHODS.has(name)) return `(__a) => __a.${name}`;
		if (HOST_METHODS.has(name)) return `(__a) => __a.${name}()`;
		return null;
	}

	private callableReference(node: KNode): string {
		if (node.allChildren.some((child) => child.type === 'class')) {
			this.refuse(node, '`::class` reflection');
		}
		const parts = kids(node);
		const member = parts[parts.length - 1];
		if (member === undefined || member.type !== 'simple_identifier') {
			this.refuse(node, 'a `::` reference to something with no name');
		}

		if (parts.length === 1) {
			// `video?.let(::listOf)` names Kotlin's own `listOf`, which lives on
			// the runtime. `read` has no table of those, so it fell through to
			// `this.listOf` — a method the emitted class does not have — and the
			// failure lands inside a `let` at the first playback rather than at
			// load. Locals and the source's own members still win, as they do in
			// Kotlin and as they do for a bare call.
			if (this.lookup(member.text) === null && !this.isSourceMember(member.text)) {
				const free = FREE_FUNCTIONS.get(member.text);
				if (free !== undefined && !this.moduleNames.has(member.text)) {
					return `((...__a) => ${this.helper(free)}(...__a))`;
				}
				const extension = EXTENSION_METHODS.get(member.text);
				if (extension !== undefined) {
					return `(...__a) => ${this.helper(extension)}(...__a)`;
				}
			}
			// As many arguments as the function needs, and no more.
			//
			// One was the rule, and it is right for the commonest use —
			// `.map(::fixUrl)` — where the runtime's collection helpers pass an
			// index as well, and forwarding every argument would hand it to a
			// parameter with a default. It is wrong for a reference that stands
			// in for a wider function type: PlaylistUtils writes
			// `masterHeadersGen: (Headers, String) -> Headers =
			// ::generateMasterHeaders`, and with one argument forwarded every
			// HLS request that took the default went out built from `referer =
			// undefined`. Nothing refused it. The required count is exact for
			// both: the function type supplies at least that many, and a
			// parameter with a default is one Kotlin fills in itself.
			const arity =
				this.owner !== null && this.classMembers.has(member.text)
					? (this.requiredArities.get(`${this.owner}.${member.text}`) ?? null)
					: null;
			if (arity !== null && arity > 1) {
				const names = Array.from({ length: arity }, (_, index) => `__a${index}`).join(', ');
				return `(${names}) => ${this.read(member.text, member)}(${names})`;
			}
			return `(__a) => ${this.read(member.text, member)}(__a)`;
		}

		// `extractor::videosFromDocument` and `Jsoup::parse` are *bound*
		// references: the thing on the left is a value, and the reference calls
		// the method on it. Reading either as `Type::method` — an unbound
		// reference, whose argument becomes the receiver — hands `parse` a
		// string it then calls `.parse()` on, which is a method a string does
		// not have. So the left side is resolved before it is discarded.
		// The grammar reads whatever is left of `::` as a *type* whether it is one
		// or not, so `helper::wrap` and `String::isNotBlank` arrive identically
		// and only what the name resolves to tells them apart.
		const owner = parts[0];
		const named = owner.type === 'simple_identifier' || owner.type === 'type_identifier';
		// `sortedByDescending(SChapter::chapter_number)` and
		// `filter(Genre::state)` — an unbound reference to a property the
		// *framework* declares: a field of one of the four models, or the
		// `state` of a filter class that extends the framework's. Nothing in
		// the file set declares either, so the two branches below cannot see
		// them; `SChapter` is a runtime global, which the next branch reads as
		// a bound receiver and refuses. Named rather than inferred, and only
		// where no translated class in the chain declares the name itself.
		if (
			named &&
			FRAMEWORK_PROPERTIES.has(member.text) &&
			(MODEL_TYPES.has(owner.text) ||
				(this.declaredTypes.has(owner.text) && !this.baseDeclares(owner.text, member.text)))
		) {
			return `(__recv) => __recv.${member.text}`;
		}
		// `File::deleteOnExit` — a type the runtime defines by name, referenced
		// unbound: the argument is the receiver. Read through `isValueName`, a
		// global is a value, and the member was called on the type itself.
		const partial = named ? JSOUP_STATICS.get(owner.text) : undefined;
		if (partial !== undefined && !partial.has(member.text) && !this.moduleNames.has(owner.text)) {
			if (!HOST_METHODS.has(member.text)) this.refuse(node, `\`${owner.text}::${member.text}\``);
			return `(__recv, ...__a) => __recv.${member.text}(...__a)`;
		}
		if (named && this.isValueName(owner.text)) {
			const receiver = this.read(owner.text, owner);
			const helper = EXTENSION_METHODS.get(member.text);
			if (helper !== undefined) {
				return `(...__a) => ${this.helper(helper)}(${[receiver, '...__a'].join(', ')})`;
			}
			if (
				!this.declaredMethods.has(member.text) &&
				!HOST_METHODS.has(member.text) &&
				RUNTIME_STATIC_REFERENCES.get(owner.text)?.has(member.text) !== true
			) {
				this.refuse(node, `\`::${member.text}\` on \`${owner.text}\``);
			}
			// A runtime type's own function, `createdAt?.let(Instant::parseOrNull)`:
			// one argument, not all of them. A collection helper hands a lambda the
			// index too, and `Instant.parse(text, format)` would take it as the
			// format.
			if (RUNTIME_STATIC_REFERENCES.get(owner.text)?.has(member.text) === true) {
				return `(__a) => ${receiver}.${member.text}(__a)`;
			}
			// A member that suspends here — PlaylistUtils' `fixSubtitles` blocks on
			// the network in Kotlin and is async in JavaScript — answers a Promise.
			// The written call `playlistUtils.fixSubtitles(x)` is awaited; the
			// reference was not, so `.let(playlistUtils::fixSubtitles)` handed a
			// Promise on, and a surrounding `runCatching { }.getOrDefault(…)` read
			// its member off the Promise. The reference is an async function, and
			// the block it sits in is counted as suspending, as a lambda that
			// awaits is.
			if (this.declaredSuspends.has(member.text)) {
				this.asyncLambdas += 1;
				return `async (...__a) => (await ${receiver}.${member.text}(...__a))`;
			}
			return `(...__a) => ${receiver}.${member.text}(...__a)`;
		}

		// `PopularAnimeDto::toSAnime` — Kotlin's *unbound* reference, whose
		// argument becomes the receiver. `parsed.data.map(Dto::toSAnime)` is how
		// this ecosystem maps a list of DTOs, and it had no implementation at
		// all: the bound branch above is skipped because a declared type is
		// deliberately not a value name, and the fallbacks below want a helper.
		//
		// Only where the file set proves it: that type declares that method.
		// An `object` is excluded because `Obj::member` is the *bound* form —
		// the object is the receiver — and reading it as unbound would eat the
		// first argument. A suspending method is excluded because `__k.map`
		// would then collect promises.
		if (
			named &&
			this.declaredTypes.has(owner.text) &&
			!this.declaredObjects.has(owner.text) &&
			this.qualifiedSignatures.has(`${owner.text}.${member.text}`) &&
			!this.declaredSuspends.has(member.text)
		) {
			return `(__recv, ...__a) => __recv.${member.text}(...__a)`;
		}

		// `hls.let(UrlUtils::fixUrl)` — a member of a declared `object`, which is
		// the *bound* form: the object is the receiver and every argument is the
		// function's. The branch above excludes objects for exactly that reason,
		// and nothing took them up, so the reference was refused while the
		// object sat translated beside it. Arguments forwarded by the rule the
		// bare `::name` form uses, and for its reason: a collection helper hands
		// the lambda an index too, which a second overload — `fixUrl(url,
		// baseUrl)` — would take as its base url.
		if (
			named &&
			this.declaredObjects.has(owner.text) &&
			this.classFunctionIndex.get(owner.text)?.has(member.text) === true &&
			this.classFieldIndex.get(owner.text)?.has(member.text) !== true
		) {
			const target = `${this.read(owner.text, owner)}.${member.text}`;
			const arity = this.requiredArities.get(`${owner.text}.${member.text}`) ?? null;
			const names =
				arity !== null && arity > 1
					? Array.from({ length: arity }, (_, index) => `__a${index}`).join(', ')
					: '__a';
			if (this.declaredSuspends.has(member.text)) {
				this.asyncLambdas += 1;
				return `async (${names}) => (await ${target}(${names}))`;
			}
			return `(${names}) => ${target}(${names})`;
		}

		// The same unbound form over a *property*: `distinctBy(GenreRoute::slug)`
		// and `sortedBy(Chapter::number)`. Kotlin's reference to a property is a
		// function of one argument that reads it, which is the shape every
		// caller of these — `distinctBy`, `sortedBy`, `groupBy`, `map` — is
		// about to call. Read off the declaration rather than guessed: the
		// method branch above has already claimed anything the file set says is
		// a method.
		if (named && this.classFieldIndex.get(owner.text)?.has(member.text) === true) {
			return `(__recv) => __recv.${member.text}`;
		}

		// Everything below reads the left side as a *type*: `Type::method`, whose
		// argument becomes the receiver. A lowercase name is a value — Kotlin's
		// types are capitalised — and one the checks above could not resolve.
		// Read as a type it came out as `(__a) => __a.parseToJsonElement()`:
		// `jsonInstance::parseToJsonElement` called the method on the string it
		// was handed, and never mentioned `jsonInstance`, so the graph could not
		// see that the value it names was refused. Refused by name instead.
		if (named && /^[a-z_]/.test(owner.text)) {
			this.refuse(node, `\`${owner.text}::${member.text}\` on a value this build did not resolve`);
		}

		const helper = EXTENSION_METHODS.get(member.text);
		if (helper !== undefined) return `(__a) => ${this.helper(helper)}(__a)`;
		// `sumOf(ByteArray::size)` — a reference to one of the properties the
		// runtime answers rather than JavaScript. Read as a bare property it
		// would be `__a.size` on an array, which is `undefined`, and the sum of
		// a list of those is `NaN` with nothing refused.
		const property = EXTENSION_PROPERTIES.get(member.text);
		if (property !== undefined) return `(__a) => ${this.helper(property)}(__a)`;
		if (HOST_PROPERTY_METHODS.has(member.text)) return `(__a) => __a.${member.text}`;
		if (HOST_METHODS.has(member.text)) return `(__a) => __a.${member.text}()`;
		this.refuse(node, `\`::${member.text}\``);
	}

	/**
	 * `object : Callback { … }` — Kotlin's anonymous implementation of an
	 * interface, which is a JavaScript object literal and nothing more.
	 *
	 * This is how the ecosystem writes a callback, an okhttp `Interceptor`, a
	 * `Comparator` and a one-off filter: a supertype with no state, and a
	 * method or two. JavaScript has the same expression, so the members are
	 * emitted into a literal under their own names and whatever receives it
	 * calls them exactly as the Kotlin did.
	 *
	 * **Arrow functions, not methods.** The bodies here reach outward far more
	 * often than inward — an interceptor reads `baseUrl`, a callback reads a
	 * preference — and a `function` would rebind `this` to the literal, so
	 * every one of those reads would answer `undefined` with nothing thrown.
	 * An arrow keeps `this` meaning the source object, which is what the
	 * emitter does for every other nested function for the same reason.
	 *
	 * Two shapes are refused rather than approximated:
	 *
	 * - **A constructed supertype** (`object : Filter.Select<String>("x", a)`).
	 *   That object is the base plus an override, and a literal carrying only
	 *   the override is missing everything the base was going to supply.
	 * - **A body that writes a bare `this`**, which in Kotlin means the
	 *   anonymous object and here would mean the enclosing source. The two are
	 *   different objects and nothing would say which one answered.
	 */
	private objectLiteral(node: KNode): string {
		const invoked = this.baseInvocation(node);
		if (invoked !== null) {
			// An empty anonymous subclass adds nothing to a constructed base;
			// creating that base gives the same fields and methods. A body needs
			// its own inherited scope, which this emitter cannot represent.
			const base = this.resolvedBase(invoked.type);
			const members = kids(kids(node).find((child) => child.type === 'class_body'));
			if (base !== null && members.length === 0) {
				return `new ${base}(${this.plainArguments(invoked.type, [...invoked.args]).join(', ')})`;
			}
			this.refuse(node, `an anonymous \`object : ${invoked.type}(…)\` over a constructed base`);
		}
		const body = kids(node).find((child) => child.type === 'class_body');
		if (body === undefined) this.refuse(node, 'an anonymous `object :` with no body');
		if (/(^|[^.@\w])this([^.@\w]|$)/.test(body.text)) {
			this.refuse(node, 'a bare `this` inside an anonymous `object :`');
		}
		const fields: string[] = [];
		// An anonymous class has no simple name to give; see `selfClass`.
		const outerSelf = this.selfClass;
		this.selfClass = null;
		try {
			for (const child of kids(body)) {
				if (child.type === 'getter' || child.type === 'setter') continue;
				if (child.type === 'function_declaration') {
					const name = this.nameOf(child) ?? 'fun';
					fields.push(`${JSON.stringify(name)}: ${this.functionDeclaration(child, 'local')}`);
					continue;
				}
				if (child.type === 'property_declaration') {
					const name = this.propertyName(child) ?? 'val';
					fields.push(`${JSON.stringify(name)}: ${this.propertyValue(child, name)}`);
					continue;
				}
				this.refuse(child, spoken(child));
			}
		} finally {
			this.selfClass = outerSelf;
		}
		return `(${block(fields.map(comma))})`;
	}

	/* ── calls ───────────────────────────────────────────────────────────── */

	private call(node: KNode): string {
		// `Log.w(TAG, "…${e.javaClass.simpleName}…")`: the arguments are text
		// for the host log and nothing else. See `inLogLine`. Only the runtime's
		// own `Log` — an extension that declares something called `Log` gets
		// no such licence.
		if (
			!this.inLogLine &&
			LOG_CALL.test(kids(node)[0]?.text.replace(/\s+/g, '') ?? '') &&
			this.lookup('Log') === null &&
			!this.moduleNames.has('Log') &&
			!this.declaredTypes.has('Log')
		) {
			this.inLogLine = true;
			try {
				return this.call(node);
			} finally {
				this.inLogLine = false;
			}
		}

		// `Injekt.get<Application>()` — the container reached for the one object
		// the runtime already owns. `subset.ts` lets exactly this idiom past the
		// Injekt refusal; here it resolves to the same bundle-scope name that
		// `private val context: Application by injectLazy()` yields, so the two
		// spellings of "my settings store" converge on one object.
		//
		// Guarded by `GLOBAL_NAMES` rather than by the type's spelling: a `T`
		// the runtime does not define falls through to the refusal below, which
		// is what should happen to a container reached for anything else.
		const injected = INJEKT_GET.exec(node.text.replace(/\s+/g, ''));
		if (injected !== null && GLOBAL_NAMES.has(injected[1])) return injected[1];
		// `val jsonInstance: Json = Injekt.get()` — keiyoushi core's spelling,
		// with the type on the property rather than the call. Only `Json`,
		// which the scanner lets past for the same reason: see `INJECTED_JSON`.
		if (node.text.replace(/\s+/g, '') === 'Injekt.get()' && this.expectedOf(node) === 'Json') {
			return 'Json';
		}

		// `x.ifEmpty { return@map null }` before anything else looks at the call:
		// its lambda is a jump out of the *enclosing* lambda, which only reads
		// correctly with the callback taken away.
		const empty = emptyGuard(node);
		if (empty !== null) return this.hoistedEmptyGuard(node, empty);

		// `x.let { it ?: return emptyList() }` for the same reason: the jump is
		// out of the *member*, and only reads correctly with the callback gone.
		const letGuarded = letGuard(node);
		if (letGuarded !== null) return this.hoistedGuard(node, letGuarded);

		// `formatter()(key)` — a call whose value is itself called. Kotlin's
		// function types are JavaScript functions here (a lambda is an arrow, a
		// `::ref` is an arrow), so invoking the result is invoking it: the inner
		// call is emitted exactly as it would be on its own and the outer list
		// is applied to what it answered. A function type takes no named
		// arguments in Kotlin, so the list is positional by construction.
		//
		// Not reached for a statement that begins with `(` under a line ending
		// in a call — that is two statements, and `grammar.ts` splits them
		// before the tree gets here; see `lineInitialCalls`.
		const invoked = this.invokedResult(node);
		if (invoked !== null) return invoked;

		const { callee, args, lambda, labelled, typeArgument } = this.flatten(node);
		const expected = typeArgument === null ? this.expectedOf(node) : null;
		// `Filter.Sort.Selection(1, false)` — the qualified spelling of the
		// `Selection(…)` the runtime already answers bare. Read as a method
		// call it was a member `Selection` of the value `Filter.Sort`, which is
		// no member anything defines, so it was refused; it is one constructor
		// written two ways, and both now reach the same helper with the same
		// named-argument signature.
		if (
			callee.type === 'navigation_expression' &&
			SORT_SELECTION.test(callee.text.replace(/\s+/g, '')) &&
			!this.moduleNames.has('Filter') &&
			!this.moduleNames.has('AnimeFilter') &&
			!this.declaredTypes.has('Selection')
		) {
			if (lambda !== null) this.refuse(lambda, 'a lambda passed to `Selection`');
			const tail = this.callArguments('Selection', args, null, labelled, false);
			return `${this.helper('selection')}(${tail.join(', ')})`;
		}
		if (callee.type === 'navigation_expression') {
			return this.methodCall(callee, args, lambda, labelled, typeArgument, expected);
		}
		if (callee.type === 'simple_identifier') {
			return this.bareCall(callee, args, lambda, labelled, typeArgument, expected);
		}
		if (callee.type === 'callable_reference') {
			if (lambda !== null) this.refuse(lambda, 'a lambda passed to a callable reference');
			return `(${this.callableReference(callee)})(${this.plainArguments('', args).join(', ')})`;
		}
		// `(f)(x)` and `map[k](x)`: a call through something with no name, whose
		// signature is not knowable from here.
		this.refuse(callee, `a call through ${spoken(callee)}`);
	}

	/** `f(a)(b)`, as the value of `f(a)` called with `b` — or null for any other call. */
	private invokedResult(node: KNode): string | null {
		const inner = kids(node)[0];
		const suffix = kids(node)[1];
		if (inner?.type !== 'call_expression' || suffix === undefined) return null;
		const values = kids(suffix).find((child) => child.type === 'value_arguments');
		if (values === undefined) return null;
		// Only when the callee is a call that already has its own argument list.
		// `f { … }(x)` and `f<T>(x)` are not this shape.
		const own = kids(inner)[1];
		if (own === undefined || !kids(own).some((child) => child.type === 'value_arguments')) {
			return null;
		}
		if (kids(suffix).some((child) => child.type !== 'value_arguments')) {
			this.refuse(suffix, 'a call returning a callable, given a lambda or type arguments');
		}
		const args = kids(values).filter((child) => child.type === 'value_argument');
		if (args.some((arg) => this.argumentName(arg) !== null)) {
			this.refuse(suffix, 'a named argument to a callable a call returned');
		}
		return `(${this.expr(inner)})(${args.flatMap((arg) => this.argumentExpressions(arg)).join(', ')})`;
	}

	/**
	 * Unwinds `f(a) { … }`, which parses as a call whose callee is a call.
	 *
	 * Two argument lists mean `f(a)(b)` — a returned function being invoked,
	 * whose signature we cannot know — so that is refused rather than merged.
	 */
	private flatten(node: KNode): {
		callee: KNode;
		args: KNode[];
		lambda: KNode | null;
		labelled: string | null;
		typeArgument: string | null;
	} {
		const suffixes: KNode[] = [];
		let current = node;
		while (current.type === 'call_expression') {
			const suffix = kids(current)[1];
			if (suffix === undefined) this.refuse(current, 'a call with no argument list');
			suffixes.unshift(suffix);
			current = kids(current)[0];
		}

		let args: KNode[] | null = null;
		let lambda: KNode | null = null;
		let labelled: string | null = null;
		let typeArgument: string | null = null;

		for (const suffix of suffixes) {
			const types = kids(suffix).find((child) => child.type === 'type_arguments');
			if (types !== undefined) {
				// Generics are kept here, unlike everywhere else a type is read:
				// `decodeFromString<List<Foo>>` and `decodeFromString<Foo>` want
				// different descriptors, and stripping the arguments makes the
				// runtime build the wrong one without noticing.
				typeArgument = kids(types)
					.map((child) => child.text.replace(/\s+/g, ''))
					.join(', ');
			}
			const values = kids(suffix).find((child) => child.type === 'value_arguments');
			if (values !== undefined) {
				if (args !== null) this.refuse(suffix, 'a call returning a callable');
				args = kids(values).filter((child) => child.type === 'value_argument');
			}
			const annotated = kids(suffix).find((child) => child.type === 'annotated_lambda');
			if (annotated !== undefined) {
				labelled = kids(annotated).find((child) => child.type === 'label')?.text ?? null;
				lambda = kids(annotated).find((child) => child.type === 'lambda_literal') ?? null;
			} else {
				lambda = kids(suffix).find((child) => child.type === 'lambda_literal') ?? lambda;
			}
		}

		return {
			callee: current,
			args: args ?? [],
			lambda,
			labelled: labelled === null ? null : labelled.replace(/@$/, ''),
			typeArgument
		};
	}

	private methodCall(
		callee: KNode,
		args: KNode[],
		lambda: KNode | null,
		labelled: string | null,
		typeArgument: string | null,
		expected: string | null = null
	): string {
		const receiver = kids(callee)[0];
		const suffix = kids(callee)[kids(callee).length - 1];
		const written = kids(suffix).find((child) => child.type === 'simple_identifier')?.text ?? null;
		if (written === null) this.refuse(callee, 'a call through something with no name');
		// jsoup's `element.\`val\`()` — backticked only because `val` is a
		// Kotlin keyword. The quoting is not part of the name, and every table
		// below is keyed by the name: left on, a method the DOM shim implements
		// was refused as one nobody had heard of. A name JavaScript cannot take
		// after a dot at all is still refused, rather than emitted as a syntax
		// error.
		const name = fieldName(written);
		if (!JS_IDENTIFIER.test(name)) this.refuse(suffix, `\`.${written}()\``);
		const safe = suffix.allChildren[0]?.type === '?.';

		// `java.net.URI(url)` and `java.text.SimpleDateFormat(…)` — a constructor
		// written with its package, which is the bare constructor the imported
		// spelling already reaches. Only a package path in front and only a
		// name the bare path knows (`FREE_FUNCTIONS`, or a runtime global), so
		// an unknown qualified class still refuses.
		if (
			!safe &&
			/^[A-Z]/.test(name) &&
			PACKAGE_PATH.test(receiver.text.replace(/\s+/g, '')) &&
			(FREE_FUNCTIONS.has(name) || GLOBAL_NAMES.has(name))
		) {
			const bare = kids(suffix).find((child) => child.type === 'simple_identifier');
			if (bare !== undefined) {
				return this.bareCall(bare, args, lambda, labelled, typeArgument, expected);
			}
		}

		// `newBuilder().block()` — a parameter typed `R.() -> T`, invoked on an
		// explicit receiver. Kotlin resolves a member of the receiver first, and
		// no receiver type this ecosystem uses has a member called what these
		// parameters are called (`block`, `query`, `configure`).
		const receiverLocal = receiver.type === 'super_expression' ? null : this.lookupLocal(name);
		if (receiverLocal?.receiverArity !== undefined) {
			const target = this.expr(receiver);
			if (!safe) return this.invokeReceiverLocal(suffix, receiverLocal, target, args, lambda);
			const inner = this.invokeReceiverLocal(suffix, receiverLocal, '__r', args, lambda);
			return `${this.helper('sc')}(${target}, (__r) => ${inner})`;
		}

		if (receiver.type === 'super_expression') {
			// **A superclass this build translated is a real JavaScript one.**
			//
			// A multisrc template is emitted as a `class` and the extension
			// really does `extends` it (`orderByInheritance` exists to order
			// the two), so `super.chapterFromElement()` inside such an
			// extension is ordinary JavaScript and means the template's method.
			// Emitting `__super.chapterFromElement` instead would reach past
			// the template to the driver's base class, which has never heard of
			// it — and every such call was refused by name instead, which took
			// the whole extension with it.
			//
			// Checked against the hierarchy rather than assumed from the
			// presence of a base: a class extending a template may still call
			// `super.headersBuilder()`, which the template does not declare and
			// the driver does. That one has to keep going to `__super`, and
			// asking `classMembers` is what tells the two apart.
			//
			// It also fixes a silent wrongness in the other direction. Where a
			// template *does* override a driver member, `__super.x()` ran the
			// driver's version and skipped the override the extension asked
			// for — no error, just the wrong behaviour.
			if (this.ownerBase !== null && this.baseDeclares(this.ownerBase, name)) {
				if (lambda !== null) this.refuse(lambda, `a lambda passed to \`super.${name}()\``);
				const shapes = this.overloadsOf(name);
				const inherited =
					shapes === null || this.owner === null
						? `super.${name}(${this.plainArguments(name, args).join(', ')})`
						: this.overloadCall(
								`Object.getPrototypeOf(${this.safe(this.owner)}.prototype)`,
								this.selfReference(),
								name,
								this.plainArguments(name, args),
								shapes
							);
				// Awaited on the same rule the driver's half uses: the emitter
				// marks a translated member `async` when it suspends, so a call
				// to one is a promise and a promise that is filtered rather
				// than awaited walks nothing and answers an empty list.
				return this.declaredSuspends.has(name) ? this.awaited(inherited) : inherited;
			}
			// The base class is real — `shims/aniyomi-entry.ts` declares it — so a
			// written `super.foo(x)` is honoured rather than refused. See
			// `SUPER_MEMBERS` for why that leaves rule 3 intact.
			if (!SUPER_MEMBERS.has(name)) this.refuse(suffix, `\`super.${name}()\``);
			if (lambda !== null) this.refuse(lambda, `a lambda passed to \`super.${name}()\``);
			const passed = this.plainArguments(name, args);
			if (SUPER_RECEIVER_MEMBERS.has(name)) {
				// `super.sortVideos()` is written inside `override fun
				// List<Video>.sortVideos()`, where the list is the implicit
				// receiver. This emitter makes a receiver explicit and first, so
				// the implicit one has to be made explicit here too — otherwise
				// the base ordering runs on `undefined` and the extension loses
				// the list it was sorting.
				if (this.receiverParam === null) {
					this.refuse(suffix, `\`super.${name}()\` outside an extension function`);
				}
				passed.unshift(this.receiverParam);
			}
			const call = `__super.${name}(${passed.join(', ')})`;
			// The suspending half of the base class. `super.getHosterList(episode)`
			// is written in Kotlin as a value and used as one — filtered, mapped,
			// indexed — so handing back an unawaited promise would not fail, it
			// would produce an empty list.
			return SUPER_SUSPEND_MEMBERS.has(name) ? this.awaited(call) : call;
		}

		if (name === 'copy' && lambda === null && !this.declaredMethods.has('copy')) {
			// A data class's `copy(field = value)`: a new record with the fields
			// named replaced and the rest carried over. The receiver's class is
			// not knowable here, so the record answers for itself — a data
			// class this build emitted rebuilds through its own factory (see
			// `dataRecord`), and the framework's `MangasPage`, `AnimesPage` and
			// `Video` are known to the runtime.
			const positional: string[] = [];
			const named: string[] = [];
			for (const arg of args) {
				const argName = this.argumentName(arg);
				const value = this.expr(this.argumentValue(arg));
				if (argName === null) {
					if (named.length > 0) this.refuse(arg, 'a positional argument after a named one');
					positional.push(value);
				} else {
					named.push(`${JSON.stringify(fieldName(argName))}: ${value}`);
				}
			}
			const tail = `{ ${named.join(', ')} }, [${positional.join(', ')}]`;
			const receiverText = this.expr(receiver);
			if (!safe) return `${this.helper('copy')}(${receiverText}, ${tail})`;
			return `${this.helper('sc')}(${receiverText}, (__r) => ${this.helper('copy')}(__r, ${tail}))`;
		}

		if (
			CLIENT_VERBS.has(name) &&
			lambda === null &&
			args.length > 0 &&
			!safe &&
			CLIENT_RECEIVER.test(receiver.text.replace(/\s+/g, ''))
		) {
			return this.clientVerb(receiver, name, args);
		}

		// `scope.launch { … }`: a block started and never awaited. See
		// `__k.launch` for what that means here and what it deliberately does
		// not. A bare `launch` inside `coroutineScope { }` is a different
		// thing — a child the scope waits for — and stays refused by the
		// scanner; only a launch on a named scope reaches this.
		if (name === 'launch' && lambda !== null && receiver.type !== 'super_expression') {
			const context = args.map((arg) => arg.text.replace(/\s+/g, ''));
			if (context.length > 1 || context.some((part) => !/^Dispatchers\.\w+$/.test(part))) {
				this.refuse(suffix, 'a `launch` given a context this build does not model');
			}
			const started = this.lambda(lambda, false, labelled ?? name, false);
			if (receiver.text.trim() === 'GlobalScope')
				return `${this.helper('launch')}(null, ${started})`;
			const scope = this.expr(receiver);
			return safe
				? `${this.helper('sc')}(${scope}, (__r) => ${this.helper('launch')}(__r, ${started}))`
				: `${this.helper('launch')}(${scope}, ${started})`;
		}

		if (name === 'not' && args.length === 0 && lambda === null && !safe) {
			// `Boolean.not()` is the operator written as a call, which this
			// ecosystem reaches for when negating something already parenthesised:
			// `text.contains(x).not()`.
			return `!(${this.expr(receiver)})`;
		}

		if (
			(name === 'extractNextJs' || name === 'extractNextJsRsc') &&
			!this.extensionFunctions.has(name)
		) {
			// The core helper reads either an HTML page or React Flight rows, then
			// decodes the first predicate match as T. With no predicate it derives
			// required fields from T's translated @Serializable shape; an unknown
			// shape cannot be guessed without selecting the wrong page object.
			const shape = typeArgument ?? expected;
			if (shape === null) this.refuse(suffix, `\`.${name}()\` with no type argument`);
			const predicate = this.callArguments(name, args, lambda, labelled, false);
			if (predicate.length > 1) this.refuse(suffix, `\`.${name}()\` with a deserializer`);
			if (predicate.length === 0) {
				const element = /^(?:List|MutableList)<(.+)>\??$/.exec(shape)?.[1] ?? shape;
				const bare = element.replace(/\?$/, '').replace(/^.*\./, '');
				if (!this.declaredTypes.has(bare)) {
					this.refuse(
						suffix,
						`\`.${name}()\` inferring a predicate from a type this build did not read`
					);
				}
			}
			const value = this.expr(receiver);
			const call = (target: string) =>
				`${this.helper(name)}(${[target, JSON.stringify(shape), ...predicate].join(', ')})`;
			return safe ? `${this.helper('sc')}(${value}, (__r) => ${call('__r')})` : call(value);
		}

		if (DECODING_METHODS.has(name)) {
			// The shape being decoded is named in the type argument, not the
			// arguments. Without one the runtime would have to guess a
			// descriptor, and a guessed descriptor silently drops fields.
			//
			// Kotlin infers an omitted one from where the value is going —
			// `val list: List<Foo> = response.parseAs()` — and so does this,
			// through `expectedTypes`, which only answers where the type is
			// written down. Nowhere to read it from is still a refusal.
			const shape = typeArgument ?? expected;
			if (shape === null) this.refuse(suffix, `\`.${name}()\` with no type argument`);
			if (lambda !== null) {
				// `parseAs<T> { it.substringAfter("…") }` — the block runs BEFORE
				// the parse, and what it digs out is a JSON document embedded in
				// an HTML attribute. Dropping it would hand the parser a page.
				const withBlock = this.callArguments(name, args, lambda, labelled, false);
				return `${this.helper('decodeWith')}(${[this.expr(receiver), this.decodeType(shape), ...withBlock].join(', ')})`;
			}
			// `response.parseAs<Manga>(transform = ::transformJsonResponse)` —
			// core's overload that runs the text through a function before the
			// parse, named rather than trailing. The same `decodeWith` the block
			// form takes; `json =` names a parser the runtime is already, and
			// anything else keeps the refusal.
			if (name === 'parseAs' && args.length > 0) {
				const named = args.map((arg) => this.argumentName(arg));
				const transform = args.find((arg) => this.argumentName(arg) === 'transform');
				if (
					transform !== undefined &&
					named.every((one) => one === 'transform' || one === 'json')
				) {
					const fn = this.expr(this.argumentValue(transform));
					return `${this.helper('decodeWith')}(${[this.expr(receiver), this.decodeType(shape), fn].join(', ')})`;
				}
			}

			// `json.decodeFromStream(body.byteStream())` reads the whole body as
			// the document, which is what the body's text already is here. Only
			// that argument, read straight off a body: `.byteStream()` anywhere
			// else is a stream of image bytes this runtime does not keep.
			const streamed =
				name === 'decodeFromStream' && args.length === 1
					? okioStreamOf(this.argumentValue(args[0]), 'byteStream')
					: null;
			const tail =
				streamed !== null ? [`${this.expr(streamed)}.string()`] : this.plainArguments(name, args);
			return `${this.helper('decode')}(${[this.expr(receiver), this.decodeType(shape), ...tail].join(', ')})`;
		}

		if (RESULT_MEMBERS.has(name) && !safe && runCatchingOf(receiver) !== null) {
			// `runCatching { … }.getOrNull()` — the receiver is a `Result`, not a
			// collection, and both spellings of `getOrNull` sit in
			// `EXTENSION_METHODS` pointing at the *collection* helper, which
			// reads `result[undefined]` and answers `null` for every `Result` it
			// is ever handed. So a `runCatching` that succeeded reported failure,
			// in 145 places across one catalogue, with nothing anywhere saying
			// so. The runtime's own `Result` declares these five; they are
			// emitted on it directly.
			//
			// A block that suspends makes `runCatching` answer a Promise of the
			// Result, so the Result is awaited *before* the member is read off it.
			// Awaiting the whole call read `getOrDefault` off the Promise: a shared extractor's
			// `runCatching { … .let(playlistUtils::fixSubtitles) }
			// .getOrDefault(emptyList())` threw "getOrDefault is not a function"
			// the moment fixSubtitles converted, and the hoster's own catch
			// dropped every video it found with it. The tail's own lambda — a
			// suspending `getOrElse { }` — is awaited separately.
			const before = this.asyncLambdas;
			const receiverText = this.expr(receiver);
			const receiverSuspends = this.asyncLambdas > before;
			const middle = this.asyncLambdas;
			const tail = this.callArguments(name, args, lambda, labelled, false);
			const tailSuspends = this.asyncLambdas > middle;
			const target = receiverSuspends ? this.awaited(receiverText) : receiverText;
			const call = `${target}.${name}(${tail.join(', ')})`;
			return tailSuspends ? this.awaited(call) : call;
		}

		const qualified = this.qualifiedTypes.get(`${receiver.text.trim()}.${name}`);
		if (qualified !== undefined && this.moduleNames.has(qualified) && lambda === null) {
			// `Filters.TypeFilter()` — constructing a nested type by its
			// qualified name. It is hoisted to module scope, and the object that
			// held it is emitted as a frozen literal that does not carry it, so
			// reading it off the object answered undefined and the call died
			// with "Filters.TypeFilter is not a function" on the first search.
			//
			// Emitted against the hoisted binding rather than through the owner,
			// which also supplies the `new` an ES6 class needs and a property
			// read never would.
			const build = this.newableTypes.has(qualified) ? 'new ' : '';
			return `${build}${this.safe(qualified)}(${this.plainArguments(qualified, args).join(', ')})`;
		}

		if (
			name === 'sleep' &&
			receiver.type === 'simple_identifier' &&
			receiver.text === 'Thread' &&
			lambda === null &&
			args.length === 1
		) {
			// `Thread.sleep(5100L)` between retries. JavaScript has no blocking
			// sleep, and the runtime's `delay` is the same wait — so the member
			// holding it becomes `async`, which `blockingMembers` accounts for.
			//
			// A no-op would be the rude answer: the pause is there to be polite
			// to the source, and dropping it turns a spaced-out retry into a
			// source being hammered.
			return this.awaited(`${this.helper('delay')}(${this.plainArguments(name, args).join(', ')})`);
		}

		// `UUID.randomUUID()` — a session id, in the one shape this ecosystem
		// writes, and always turned straight into its text. Passed through as
		// written it named a `UUID` nothing defines and died at load.
		if (
			name === 'randomUUID' &&
			receiver.type === 'simple_identifier' &&
			receiver.text === 'UUID' &&
			args.length === 0 &&
			lambda === null
		) {
			return `${this.helper('randomUUID')}()`;
		}

		if (
			name === 'format' &&
			receiver.type === 'simple_identifier' &&
			receiver.text === 'String' &&
			lambda === null
		) {
			// `String.format(Locale.US, "%.1f", x)` is Java's static, and `String`
			// is a *type* — reading it as a value is refused by name, which is the
			// right answer everywhere else and turned this call into a refused
			// member. The formatter takes its pattern from the arguments, so the
			// receiver is dropped rather than resolved.
			const tail = this.callArguments(name, args, lambda, labelled, false);
			return `${this.helper('format')}(${['null', ...tail].join(', ')})`;
		}

		// A SharedPreferences getter always names a key AND a fallback.
		//
		// `getString`, `getBoolean`, `getInt` and `getLong` map onto the
		// preferences helper, and org.json spells four of its readers the same
		// way — `json.getString("url")`. Routed through the helper, that reads
		// the *plugin's settings store* under a setting id made from "url" and
		// answers undefined, with no refusal anywhere: today it is masked only
		// because `JSONObject(…)` refuses first in the same member, and it would
		// stop being masked the moment org.json is supported.
		//
		// Arity separates them cleanly. Every SharedPreferences call in this
		// ecosystem passes a default (`getString(KEY, DEFAULT)!!`); every
		// org.json read passes only the field.
		// `n.toString(16)` and `bytes.toString(Charsets.UTF_8)`: toString WITH an
		// argument is a radix or a charset, never the plain one — see
		// `toStringWith`. The plain helper ignored the argument.
		if (
			name === 'toString' &&
			args.length === 1 &&
			lambda === null &&
			!this.extensionFunctions.has(name) &&
			!this.declaredMethods.has(name)
		) {
			const value = this.expr(receiver);
			const argument = this.plainArguments(name, args)[0];
			const call = (target: string) => `${this.helper('toStringWith')}(${target}, ${argument})`;
			return safe ? `${this.helper('sc')}(${value}, (__r) => ${call('__r')})` : call(value);
		}

		// `Filter.Sort.Selection(3, false)` — the sort state written qualified,
		// which is the same value the bare `Selection(…)` already builds
		// through `__k.selection`. The receiver is the framework's nested type,
		// not a value, so it is dropped rather than passed through.
		if (
			name === 'Selection' &&
			lambda === null &&
			!safe &&
			/^(?:Anime)?Filter\.Sort$/.test(receiver.text.replace(/\s+/g, ''))
		) {
			return `${this.helper('selection')}(${this.callArguments(name, args, null, labelled, false).join(', ')})`;
		}

		// `body.source().asResponseBody(type)` — okio's spelling of "the same
		// bytes under another content type", which is how an interceptor fixes a
		// host that serves its pages as `application/octet-stream`. A response
		// here is the text the host read, so the same body is its `string()`,
		// handed to `toResponseBody` with the new type. Only this whole chain:
		// `.source()` on its own is an okio stream (`readByteArray`,
		// `cipherSource`) over bytes this runtime does not keep, and stays
		// refused, as does the two-argument form, which also asserts a length.
		if (name === 'asResponseBody' && args.length === 1 && lambda === null) {
			const body = okioSourceOf(receiver);
			if (body !== null) {
				const type = this.plainArguments(name, args)[0];
				return `${this.helper('toResponseBody')}(${this.expr(body)}.string(), ${type})`;
			}
		}

		const jsonGetter = JSON_GETTERS.get(name);
		if (jsonGetter !== undefined && args.length === 1 && lambda === null) {
			return `${this.helper(jsonGetter)}(${[this.expr(receiver), ...this.plainArguments(name, args)].join(', ')})`;
		}
		if (PREFERENCE_GETTERS.has(name) && args.length < 2 && lambda === null) {
			this.refuse(callee, `\`.${name}()\` with no fallback, which is not the preferences getter`);
		}

		// `editor.apply()` is not `x.apply { … }`. The scope function always
		// carries a block; the SharedPreferences editor's commit never does, and
		// routed through the scope helper it called `undefined` as its block.
		// The two are told apart by the block, which is the only thing that
		// distinguishes them at the call site.
		const scopeFunction = !(name === 'apply' && lambda === null && args.length === 0);

		// `list.get(i)` and `map.get(k)` are Kotlin's indexing spelled as a call,
		// and a JavaScript array has no `get`. `Injekt.get()` is a different
		// method that shares the name and takes no argument at all — it is
		// refused, and must stay refused — so the argument is what tells them
		// apart, the same way the block tells `editor.apply()` from
		// `x.apply { … }` two lines up.
		const indexed = name === 'get' && lambda === null && args.length === 1;
		// A name this file declares as an extension function is a resolved symbol
		// and not a standard-library helper that happens to share it. Two
		// extensions in this catalogue declare `fun AnimeFilterList.asQueryPart()`
		// and the runtime has an `asQueryPart` that URL-encodes a string, so the
		// helper won and the search went out with an encoded *filter list* where
		// the chosen option should have been — a wrong value, with the declared
		// function emitted beside it and never called.
		//
		// The block is what tells the two apart, as it already does for
		// `editor.apply()` against `x.apply { … }`. Six sources here declare
		// `private fun Array<String>.any(url: String)` and call the stdlib
		// `this.any { … }` from inside it: same name, and only the lambda says
		// which. A declaration cannot shadow a helper at a call site carrying one.
		//
		// An extension imported by name from a shared `object` shadows it the
		// same way — the one that caused it: `filters.asQueryPart<TypeFilter>()`
		// imported from a multisrc template's filters object came out as the
		// URL-encoder applied to the whole filter list, type argument dropped.
		const importedExtension = this.importedOwner(name);
		//
		// And a member of a declared `object`, called through the object's
		// name: `LocalFilters.sorted(2)` is that object's `sorted`, which
		// Kotlin resolves before any extension — the runtime's collection
		// `sorted` would have been handed the object as a list.
		//
		// A construction of a declared class is the same fact one step on:
		// `TypeFilter().count()` is that class's `count`, not the collection
		// helper handed an instance.
		const declaredOwner =
			receiver.type === 'simple_identifier' && this.declaredObjects.has(receiver.text)
				? receiver.text
				: receiver.type === 'call_expression'
					? this.receiverTypeOf(receiver)
					: null;
		const objectMember =
			declaredOwner !== null && this.classMemberIndex.get(declaredOwner)?.has(name) === true;
		const shadowed =
			objectMember ||
			(lambda === null &&
				(this.extensionFunctions.has(name) ||
					(importedExtension !== null &&
						this.neighbourExtensions.has(`${importedExtension}.${name}`))));
		// The two rate-limit helpers take their period as a *unit plus a number*,
		// and the emitter is the only half of this converter that can still see
		// which unit was written. Handled before the generic path because that
		// path erases the distinction it needs. See `rateLimitCall`.
		if (
			(name === 'rateLimit' || name === 'rateLimitHost') &&
			(lambda === null || name === 'rateLimit') &&
			!this.extensionFunctions.has(name)
		) {
			return this.rateLimitCall(suffix, this.expr(receiver), name, args, lambda);
		}
		// The same two limits, installed as the shared libraries' own interceptor
		// objects rather than through the extension function. Only those two: a
		// null answer falls through to the passthrough refusal, which is where
		// every other interceptor — including an arbitrary lambda — belongs.
		if (
			(name === 'addInterceptor' || name === 'addNetworkInterceptor') &&
			lambda === null &&
			args.length === 1
		) {
			const declarative = this.declarativeInterceptor(suffix, receiver, args[0]);
			if (declarative !== null) return declarative;
		}
		// A named argument to `indexOf`/`lastIndexOf` is `ignoreCase` or
		// `startIndex`, which only Kotlin's own reads: see `KNOWN_SIGNATURES`.
		const namedSearch =
			(name === 'indexOf' || name === 'lastIndexOf') &&
			args.some((arg) => arg.allChildren.some((child) => child.type === '='));
		const helper = indexed
			? 'getAt'
			: scopeFunction && !shadowed
				? namedSearch
					? name
					: EXTENSION_METHODS.get(name)
				: undefined;
		if (helper !== undefined) {
			const before = this.asyncLambdas;
			const receiverText = this.expr(receiver);
			const tail = this.provenance(
				helper,
				this.callArguments(
					name,
					args,
					lambda,
					labelled,
					RECEIVER_SCOPE.has(name),
					RECEIVER_SCOPE.has(name) ? modelTypeOf(receiver) : null
				),
				1
			);
			// `filters.filterIsInstance<OrderFilter>()` — the type is the whole
			// argument, and it was dropped. The runtime helper takes one and
			// passes everything through when it has none, so the list came back
			// whole and the `.first()` after it answered whichever filter
			// happened to be first: a wrong filter, silently, in every extension
			// reading one this way.
			if (TYPED_HELPERS.has(helper) && typeArgument !== null && args.length === 0) {
				tail.push(this.typeReference(typeArgument));
			}
			// A class in this conversion declares a method under the same name,
			// so the receiver may be one of its instances — and a member beats an
			// extension in Kotlin. `parser.substringBefore("',")` on the unpacker
			// module's own `SubstringExtractor` went to the string helper, which
			// read the extractor as "[object Object]" and unpacked nothing. The
			// receiver's type is not known here, so the runtime asks it: see
			// `__k.ownOr`. Only for names something declares, so no other call
			// changes.
			const ambiguous = !indexed && this.declaredMethods.has(name);
			const invoke = (subject: string): string =>
				ambiguous
					? `${this.helper('ownOr')}(${[subject, JSON.stringify(name), JSON.stringify(helper), ...tail].join(', ')})`
					: `${this.helper(helper)}(${[subject, ...tail].join(', ')})`;
			if (ambiguous) this.helper(helper);
			const call = safe
				? // `a?.substringAfter("x")` cannot use JavaScript's own `?.`: the
					// helper takes the receiver as an argument and would be handed
					// the null, and a conditional would evaluate it twice.
					`${this.helper('sc')}(${receiverText}, (__r) => ${invoke('__r')})`
				: invoke(receiverText);
			const suspends =
				AWAITING_HELPERS.has(helper) ||
				this.asyncLambdas > before ||
				(ambiguous && this.declaredSuspends.has(name));
			return suspends ? this.awaited(call) : call;
		}

		// The receiver is translated before the method name is judged, so
		// `AlphaExtractor(client).videosFromUrl(url)` is refused for the
		// extractor it constructs rather than for the method it calls on it —
		// the first of those is the thing a reader can do something about.
		// A capitalised receiver may be an object declared in a neighbouring
		// source file. The pipeline resolves its member through the call graph;
		// refusing the receiver here would erase a valid cross-file call before
		// reachability had a chance to inspect it.
		//
		// But only a name something in the unit — or the runtime — actually
		// declares. Every file's declarations are merged before this one is
		// emitted, so a capitalised receiver nobody declares is not a neighbour
		// waiting to be resolved: it is a module this conversion never fetched.
		// `keiyoushi.utils.UrlUtils` lives in a directory the source fetcher
		// did not read, and `UrlUtils.fixUrl(…)` passed through here to become
		// `UrlUtils is not defined` on every HLS extraction, with the conversion
		// reporting complete. Refused by name instead, it says what is missing.
		if (
			receiver.type === 'simple_identifier' &&
			/^[A-Z]/.test(receiver.text) &&
			!this.knownCapital(receiver.text)
		) {
			this.refuse(receiver, `\`${receiver.text}\``);
		}
		const receiverText =
			receiver.type === 'simple_identifier' && /^[A-Z]/.test(receiver.text)
				? this.safe(receiver.text)
				: this.expr(receiver);

		let extension = this.extensionFunctions.get(name);
		if (extension === undefined && this.ownerBase !== null) {
			// Declared on the base class, in the file next door. Emitted as a
			// method there, so `__self.getImageUrl(element)` finds it through the
			// prototype chain the `extends` already set up — which is also why
			// an override in this class keeps winning.
			if (this.neighbourExtensions.has(`${this.ownerBase}.${name}`)) extension = 'method';
		}
		// Declared at file scope next door. Asked last, so a helper this build
		// implements and a declaration on the class both still win: what is
		// filled here is only the gap where nothing else answered at all.
		if (extension === undefined && this.neighbourModuleExtensions.has(name)) extension = 'module';
		// Imported by name from a shared `object` — see `importedMembers`.
		const importedFrom = extension === undefined ? this.importedOwner(name) : null;
		if (importedFrom !== null && this.neighbourExtensions.has(`${importedFrom}.${name}`)) {
			extension = 'module';
		}
		if (extension !== undefined) {
			// `element.getInfo("x")` calls `getInfo(element, "x")`: the receiver
			// is the first argument, which is where the declaration put it. A
			// trailing lambda is an ordinary last parameter under the same
			// rule — `response.retryOn419 { req -> … }` calls `retryOn419(response,
			// (req) => …)` — and `callArguments` already knows how to convert one;
			// `receiverForm` is false because a locally declared extension's own
			// function-type parameter is never itself a receiver lambda in any
			// source measured (`fun Response.retryOn419(onRetry: (Request) ->
			// Response)`, not `onRetry: Request.() -> Response`).
			// `selfReference`, not a literal `this`: inside `SAnime.create().apply
			// { … }` the block is a real `function` whose `this` is the *record*,
			// so `this.fixLink(…)` looked for the extension on the SAnime and the
			// converted extension died with `this.fixLink is not a function` on
			// its first search. The source is `__self` there, captured by the
			// enclosing member — which is what this asks for.
			const owner = this.extensionOwners.get(name) ?? importedFrom ?? undefined;
			const callee =
				extension === 'method'
					? `${this.selfReference()}.${name}`
					: owner === undefined
						? this.safe(name)
						: `${this.safe(owner)}.${name}`;
			const types = this.reifiedArguments(
				suffix,
				name,
				typeArgument,
				expected,
				this.receiverTypeOf(receiver)
			);
			const tail = this.callArguments(name, args, lambda, labelled, false);
			const call = `${callee}(${[...types, receiverText, ...tail].join(', ')})`;
			if (!safe) {
				const suspends = this.suspendMembers.has(name) || this.moduleSuspends.has(name);
				return suspends ? this.awaited(call) : call;
			}
			const inner = `${callee}(${[...types, '__r', ...tail].join(', ')})`;
			return `${this.helper('sc')}(${receiverText}, (__r) => ${inner})`;
		}

		// A capitalised receiver is passed through, and a fully-qualified one
		// names the same thing: `java.net.URLEncoder.encode(…)` and the imported
		// `URLEncoder.encode(…)` are one call written two ways, and only the
		// second was reaching the passthrough.
		const qualifiedReceiver = QUALIFIED_GLOBAL.exec(receiver.text.replace(/\s+/g, ''));
		const crossFileObject =
			(receiver.type === 'simple_identifier' && /^[A-Z]/.test(receiver.text)) ||
			(qualifiedReceiver !== null && GLOBAL_NAMES.has(qualifiedReceiver[1]));
		// A method this file declares on one of its own classes is a resolved
		// symbol, not the fallback the header refuses: `typeFilter.toUriPart()`
		// names a member of the `UriPartFilter` a few lines below it, and that
		// class is emitted into the same module.
		// `this.pageListParseAlternative(document)` — the receiver is the source
		// object and the name is a member of it, which is a resolved call and
		// not the passthrough the header refuses. Written out rather than left
		// implicit all over this ecosystem, and refused every time: the implicit
		// form takes the `bareCall` path, which consults `classMembers`, and
		// nothing on this path did.
		//
		// Narrow on purpose. Inside `apply {}` a bare `this` is the *applied*
		// record, and the emitted receiver text says so — only a `this` that
		// came out as the source object counts.
		const ownReceiver =
			// Both spellings. A `this` reaches this emitter as a
			// `this_expression` in most positions and as a plain identifier in
			// others — the same split the identifier case above documents.
			(receiver.type === 'this_expression' || receiver.text === 'this') &&
			(receiverText === 'this' || receiverText === this.selfReference());
		const ownMember = ownReceiver && this.isSourceMember(name);
		// `theme.getServerDisplayName(name)`, inside `class AnikotoExtractor(
		// private val theme: AnikotoTheme)` — a helper handed the source
		// object, calling one of its members. The entry class's methods are
		// kept out of `declaredMethods` on purpose (they are `this.name()`
		// inside it, never a passthrough), so the call was refused as a method
		// nothing declares, while the method sat translated on the class the
		// property holds. The declared type is what resolves it: the member is
		// looked up on that class and its bases, exactly as Kotlin did.
		const typedOwner =
			this.declaredMethods.has(name) || ownMember
				? null
				: this.typedMemberOwner(receiver, receiverText, name);
		const declared = this.declaredMethods.has(name) || ownMember || typedOwner !== null;
		// jsoup's statics pass through as a capitalised receiver, which checks no
		// member at all — and the runtime defines only the ones in the table.
		// `Parser.xmlParser()` in particular must not reach a runtime whose
		// `Jsoup.parse` would quietly build an HTML tree from the XML.
		const statics = JSOUP_STATICS.get(receiver.text);
		if (statics !== undefined && !statics.has(name) && !this.moduleNames.has(receiver.text)) {
			this.refuse(suffix, `\`${receiver.text}.${name}()\``);
		}
		// java.util.Base64's coders: `Base64.getDecoder().decode(text)`. `decode`
		// and `withoutPadding` are not on the allowlist — the first is too common
		// a word to pass through on any receiver — so they pass here only on the
		// accessor that returns one of the runtime's coders.
		const javaCoder =
			(name === 'decode' || name === 'withoutPadding' || name === 'encodeToString') &&
			/\.get(?:Url|Mime)?(?:Decoder|Encoder)\(\)(?:\.withoutPadding\(\))?$/.test(
				receiver.text.replace(/\s+/g, '')
			);
		if (!HOST_METHODS.has(name) && !crossFileObject && !declared && scopeFunction && !javaCoder) {
			// Passthrough is an allowlist. See the file header: a fallback turns
			// an unrecognised Kotlin helper into a call on a shim that has never
			// heard of it, and the failure then happens inside a sandbox rather
			// than here, where a sentence can be written about it.
			this.refuse(suffix, `\`.${name}()\``);
		}
		const argumentLambda = ARGUMENT_LAMBDA_METHODS.has(name);
		const builderLambda = lambda !== null && (BUILDER_LAMBDA_METHODS.has(name) || argumentLambda);
		const trailing =
			lambda !== null && !builderLambda && declared
				? this.trailingLambdaArguments(name, receiver, args, lambda, labelled)
				: null;
		if (lambda !== null && !builderLambda && trailing === null) {
			this.refuse(lambda, `a lambda passed to \`.${name}()\``);
		}

		const argumentsText =
			trailing !== null
				? trailing
				: builderLambda
					? this.callArguments(
							name,
							args,
							lambda,
							labelled,
							!argumentLambda,
							argumentLambda ? null : modelTypeOf(receiver)
						)
					: this.plainArguments(name, args, this.receiverTypeOf(receiver));
		// `element.parent()` is a jsoup call and a runtime field; see
		// `HOST_PROPERTY_METHODS` for what emitting it as written cost.
		if (argumentsText.length === 0 && HOST_PROPERTY_METHODS.has(name) && !declared) {
			return `${receiverText}${safe ? '?.' : '.'}${name}`;
		}
		// A property of the same name holds the plain slot; see `overloadsOf`.
		const collided = ownMember && this.fieldNames().has(name) ? this.overloadsOf(name) : null;
		const call =
			collided !== null
				? this.overloadCall(receiverText, receiverText, name, argumentsText, collided)
				: `${receiverText}${safe ? '?.' : '.'}${name}(${argumentsText.join(', ')})`;
		// A runtime method that returns a promise where the Kotlin returned a
		// value. Asked before `declaredSuspends`, because a file that declares
		// its own `sign` has already taken the `declared` branch above.
		if (!declared && AWAITED_HOST_METHODS.has(name)) return this.awaited(call);
		if (ownMember && this.suspendMembers.has(name)) return this.awaited(call);
		if (typedOwner !== null) {
			if (this.entrySuspends.has(`${typedOwner}.${name}`)) return this.awaited(call);
			// Not awaited, because the class's own emitter starts from the same
			// set and did not make it `async` — but that emitter can still make
			// a member `async` for an await it meets while emitting, which no
			// survey sees. A promise used as a string is the silent failure,
			// so the call says so the moment it happens rather than handing
			// `[object Promise]` on. See `__k.notSuspended`.
			return `${this.helper('notSuspended')}(${call}, ${JSON.stringify(`${typedOwner}.${name}`)})`;
		}
		return declared && this.declaredSuspends.has(name) ? this.awaited(call) : call;
	}

	private bareCall(
		callee: KNode,
		args: KNode[],
		lambda: KNode | null,
		labelled: string | null,
		typeArgument: string | null = null,
		expected: string | null = null
	): string {
		const name = callee.text;
		// `File(path)`: a path on a filesystem a plugin does not have. The one
		// `File` the runtime makes is `File.createTempFile` — see `JSOUP_STATICS`.
		if (name === 'File' && !this.moduleNames.has(name) && this.lookup(name) === null) {
			this.refuse(callee, '`File(…)`');
		}

		// `withContext(dispatcher) { … }` is a thread hop, and the sandbox has
		// one thread. The dispatcher is dropped and the block is awaited.
		if (name === 'withContext') {
			if (lambda === null) this.refuse(callee, 'a `withContext` with no block');
			// Labelled, like every other block that becomes a real callback.
			// `withContext` is not one of Kotlin's inline scope functions, so a
			// bare `return` inside it is a compile error there and the only
			// return an extension can write is `return@withContext` — which
			// leaves exactly this arrow, and is what the async IIFE yields.
			// Without the label it was compared against `null` and refused as
			// "crossing a lambda" while crossing nothing at all.
			const body = this.functionScope('lambda', labelled ?? name, [], () =>
				block(this.lambdaLines(lambda))
			);
			return this.awaited(`(async () => ${body.text})()`);
		}
		if (name === 'with') {
			if (lambda === null || args.length !== 1) this.refuse(callee, 'a `with` of an unusual shape');
			const before = this.asyncLambdas;
			const subject = this.expr(this.argumentValue(args[0]));
			const call = `${this.helper('run')}(${subject}, ${this.lambda(lambda, true, labelled ?? name)})`;
			return this.asyncLambdas > before ? this.awaited(call) : call;
		}
		if (name === 'synchronized' && lambda !== null && args.length === 1) {
			// Mutual exclusion in a runtime that has one thread. `ABI.md` §1
			// makes a plugin a single-threaded module in a Worker, and Kotlin
			// will not let a `synchronized` block suspend, so there is not even
			// an `await` inside one for the event loop to interleave at: running
			// the block is what the lock was asking for. The lock itself is
			// evaluated, once, because it is sometimes a call.
			//
			// A block carrying a non-local `return` takes the inlining path
			// instead — see `scopeShape`, which knows this shape too.
			const before = this.asyncLambdas;
			const lock = this.expr(this.argumentValue(args[0]));
			const call = `${this.helper('synchronized')}(${lock}, ${this.lambda(lambda, false, labelled ?? name)})`;
			return this.asyncLambdas > before ? this.awaited(call) : call;
		}
		// `Interceptor { chain -> … }` — Kotlin's SAM constructor, written where
		// the lambda is not already in an `addInterceptor` position. The
		// interceptor *is* the function, and the runtime calls a function and an
		// object with `intercept` the same way, so the constructor is the
		// identity and the lambda is the whole value.
		if (name === 'Interceptor' && lambda !== null && args.length === 0) {
			return this.lambda(lambda, false, labelled ?? name);
		}
		if (name === 'async') {
			if (lambda === null) this.refuse(callee, 'an `async` with no block');
			return `${this.helper('async')}(${this.lambda(lambda, false, labelled ?? name)})`;
		}
		// `coroutineScope { … }` and `supervisorScope { … }` are structured
		// concurrency: the block runs, its children run, and the scope does not
		// finish until they all have. In a runtime with one thread that is
		// exactly "run the block and await it" — which is what `withContext` and
		// `runBlocking` above already do, and the `async` below is what makes
		// the children run at all.
		//
		// The difference between the two is failure handling: `coroutineScope`
		// cancels its siblings when one child throws and `supervisorScope` does
		// not. There is nothing to cancel here — an `async` is a promise already
		// in flight — so both become the same await, and a throw propagates out
		// of the scope in either, which is the behaviour every use in this
		// catalogue is written against.
		if (name === 'coroutineScope' || name === 'supervisorScope') {
			if (lambda === null) this.refuse(callee, `a \`${name}\` with no block`);
			const body = this.functionScope('lambda', labelled ?? name, [], () =>
				block(this.lambdaLines(lambda))
			);
			return this.awaited(`(async () => ${body.text})()`);
		}
		if (name === 'runBlocking') {
			// The sandbox has one thread and no way to block on a promise, so the
			// only honest translation is to await — which makes the enclosing
			// member async. That is a visible change to its signature rather than
			// a silent one: a caller gets a promise where Kotlin had a value, and
			// every caller inside a converted bundle awaits.
			if (lambda === null) this.refuse(callee, 'a `runBlocking` with no block');
			const body = this.functionScope('lambda', labelled ?? name, [], () =>
				block(this.lambdaLines(lambda))
			);
			return this.awaited(`(async () => ${body.text})()`);
		}
		if (name === 'run' && lambda !== null && args.length === 0) {
			// A *bare* `run { … }` has no receiver: it runs the block and yields
			// its value. `x.run { … }` is the receiver form and goes through
			// `EXTENSION_METHODS`. Because Kotlin inlines it, a `return` inside
			// belongs to the enclosing function — which the lambda frame refuses
			// rather than quietly rerouting into the wrapper.
			//
			// Labelled with the block's own name, as every other callback is:
			// `return@run x` leaves exactly this block with `x`, which is what
			// the arrow's `return` does. Unlabelled, the label had no frame to
			// name and a plain early exit out of a `for` inside the block was
			// refused as crossing a lambda it never left.
			return this.iife(() => this.lambdaLines(lambda), labelled ?? name);
		}
		if (name === 'buildString') {
			// The block is called with a string accumulator as its receiver, so
			// its bare `append(…)` calls land on something that has one.
			if (lambda === null) this.refuse(callee, 'a `buildString` with no block');
			return `${this.helper('buildString')}(${this.lambda(lambda, true, labelled ?? name)})`;
		}
		if (name === 'Json' && lambda !== null) {
			// `Json { ignoreUnknownKeys = true }` configures a parser the shim is
			// already permanently lenient about, so the block collapses. A block
			// that sets anything else changes behaviour this build does not model.
			this.checkJsonBuilder(lambda);
			return 'Json';
		}

		// `CoroutineScope(Dispatchers.IO + SupervisorJob())` — what a `launch`
		// is started on. The dispatcher names a thread pool, and there is one
		// thread here, so it is dropped; the Job decides what a failure does to
		// the scope, so it is kept. See `__k.coroutineScope`. Anything else in
		// the context — an exception handler, a name — is behaviour this does
		// not model, and keeps the refusal it had.
		if (name === 'CoroutineScope' && lambda === null && args.length === 1) {
			const parts = args[0].text.replace(/\s+/g, '').split('+');
			if (parts.every((part) => COROUTINE_CONTEXT.test(part))) {
				return `${this.helper('coroutineScope')}(${parts.includes('SupervisorJob()')})`;
			}
		}

		// A name the source declares for itself — a local, a member, a file-scope
		// `fun`, or a member of the enclosing class or object — outranks the
		// standard library's, as it does in Kotlin: an extension's own
		// `check(url)` is not `kotlin.check`, and `JsUnpacker`'s own
		// `unpack(vararg)` called bare from `unpackAndCombine` is not the
		// runtime's one-argument `unpack` (read as that, every extractor built
		// on it answered garbage with nothing refused).
		//
		// kotlin.math never takes a block: a bare `maxOf { … }` inside a
		// receiver block is the receiver's collection `maxOf`, not the free one.
		const listed =
			this.lookup(name) === null &&
			!this.isSourceMember(name) &&
			!this.moduleNames.has(name) &&
			!this.declaresOwn(name)
				? FREE_FUNCTIONS.get(name)
				: undefined;
		const free = listed?.startsWith('math') === true && lambda !== null ? undefined : listed;
		if (free !== undefined) {
			const before = this.asyncLambdas;
			const tail = this.provenance(
				free,
				this.callArguments(name, args, lambda, labelled, RECEIVER_BUILDERS.has(name)),
				0
			);
			const call = `${this.helper(free)}(${tail.join(', ')})`;
			const suspends = AWAITING_HELPERS.has(free) || this.asyncLambdas > before;
			return suspends ? this.awaited(call) : call;
		}

		const receiverLocal = this.lookupLocal(name);
		if (receiverLocal?.receiverArity !== undefined) {
			return this.invokeReceiverLocal(callee, receiverLocal, null, args, lambda);
		}

		if ((name === 'values' || name === 'valueOf') && lambda === null) {
			const inEnum = this.enumMember(name);
			if (inEnum !== null) return `${inEnum}(${this.plainArguments(name, args).join(', ')})`;
		}
		// A parameter that cannot be invoked does not hide a member of the same
		// name from a call — see `VALUE_ONLY_TYPES`. Asked only when something
		// the source declares answers to the name, so the call still goes
		// somewhere real.
		const bound = this.lookupLocal(name);
		const local =
			bound?.valueOnly === true && this.callableMember(name) ? null : (bound?.text ?? null);
		if (local !== null) {
			const call = `${local}(${this.callArguments(name, args, lambda, labelled, false).join(', ')})`;
			return this.localSuspends.has(name) ? this.awaited(call) : call;
		}

		// `typealias Filters = FilterList` then `Filters()`: the alias is the
		// name the source constructs and the target is the name that exists.
		const declared = this.aliased(name);
		const hoisted = this.localTypes.get(declared);
		if (GLOBAL_NAMES.has(declared) || this.moduleNames.has(declared) || hoisted !== undefined) {
			if (lambda !== null) this.refuse(lambda, `a lambda passed to \`${name}\``);
			const callee = hoisted ?? declared;
			// Kotlin spells construction and invocation the same way. A class
			// emitted as an ES6 class throws when called without `new`, and it
			// throws on the first search rather than at load.
			const build = this.newableTypes.has(declared) ? 'new ' : '';
			// A getter's name is a function here, so calling the *value* it
			// returns takes the extra pair: `f()` in Kotlin reads `f` and then
			// invokes what it read.
			const named = this.moduleGetters.has(declared) ? `${this.safe(callee)}()` : this.safe(callee);
			const made = `${build}${named}(${this.plainArguments(callee, args).join(', ')})`;
			// A file-scope `suspend fun` is an `async function` here, and its
			// call site says nothing about that in either language.
			return this.moduleSuspends.has(declared) ? this.awaited(made) : made;
		}

		// Imported by name from a shared `object`: a call on that object, not on
		// whatever `this` is here. See `importedMembers`.
		const importedFrom = this.importedOwner(name);
		if (
			importedFrom !== null &&
			!this.neighbourExtensions.has(`${importedFrom}.${name}`) &&
			this.classMemberIndex.get(importedFrom)?.has(name) === true
		) {
			const tail = this.callArguments(name, args, lambda, labelled, false);
			const types = this.reifiedArguments(callee, name, typeArgument, expected);
			const call = `${this.safe(importedFrom)}.${fieldName(name)}(${[...types, ...tail].join(', ')})`;
			return this.declaredSuspends.has(name) ? this.awaited(call) : call;
		}

		// `Observable.error(Exception("Licensed"))` — an exception built as a
		// value rather than thrown on the spot. `throw` already reads the same
		// names (`thrownHelper`); here the error is made and handed on, which
		// is `__k.exception`. Only a type this build did not see declared: an
		// extension's own `class LoginRequired : Exception()` is a class like
		// any other, and a name nothing declares that does not end in
		// Exception/Error/Throwable is not this.
		if (
			thrownHelper(name) === 'error' &&
			lambda === null &&
			args.length <= 2 &&
			!this.classMembers.has(name) &&
			!this.declaredTypes.has(name) &&
			!this.moduleNames.has(name)
		) {
			return `${this.helper('exception')}(${this.plainArguments(name, args).join(', ')})`;
		}

		// A capitalised bare call is a constructor of a class this build has not
		// translated — an extractor, a DTO from a shared module, an injected
		// service. Rewriting it as a method on the source would run and be wrong.
		// Unless the class being translated declares it, which makes it a member
		// call like any other — see `read` for the same distinction.
		if (/^[A-Z]/.test(name) && !this.classMembers.has(name)) {
			this.refuse(callee, `\`${name}(…)\``);
		}

		const tail = this.plainArguments(name, args);

		// Inside `apply { … }` or `fun Element.getInfo()`, a bare call is a call
		// on the implicit receiver: `trim()` there means `this.trim()` in Kotlin
		// and `__k.trim(receiver)` here. Reading it as a member of the *source*
		// gives `this.trim is not a function` at the far end of a conversion.
		const implicit = this.receiverAlias() ?? this.receiverParam;

		// A name this file declares as an extension function, called on the
		// implicit receiver: `getFirst<R>()` inside `asUriPart`, and
		// `isValidUrl("src")` inside `fun Element.getImageUrl()`. The receiver is
		// the first argument, exactly as it is where the receiver is written out
		// — emitted as a member of the receiver instead, it produced
		// `__recv.getFirst is not a function` on the first search, out of a
		// conversion that reported nothing refused.
		//
		// Lambda-free, for the reason the explicit-receiver site gives: a block
		// at the call is what tells a declared `any(url)` from the stdlib's
		// `any { … }`.
		//
		// Asked before `isSourceMember`, not after: an extension function
		// declared in the class body IS a member of it, and the member path
		// emits `this.isValidUrl('data-src')` — dropping the receiver, so
		// `__recv` took the first argument's value and the argument took
		// undefined. Nothing threw; the wrong attribute was read.
		const declaredExtension = lambda === null ? this.extensionFunctions.get(name) : undefined;
		if (implicit !== null && declaredExtension !== undefined) {
			const owner = this.extensionOwners.get(name);
			const target =
				declaredExtension === 'method'
					? `${this.selfReference()}.${name}`
					: owner === undefined
						? this.safe(name)
						: `${this.safe(owner)}.${name}`;
			const types = this.reifiedArguments(callee, name, typeArgument, expected);
			const call = `${target}(${[...types, implicit, ...tail].join(', ')})`;
			return this.suspendMembers.has(name) ? this.awaited(call) : call;
		}

		// A method the extension receiver's own class declares, called bare —
		// `url = getUrl()` inside `fun Dto.toSManga() = SManga.create().apply
		// { … }`. The model built by the `apply` has no such method and the
		// source does not either, so Kotlin resolved it to the DTO; read as a
		// member of the source it was `this.getUrl is not a function` at the
		// first browse. A name a framework shim also answers is left to the
		// paths below, because then the innermost receiver may well be the one.
		if (
			this.receiverParam !== null &&
			lambda === null &&
			this.receiverDeclares(name) &&
			!(implicit !== this.receiverParam && HOST_METHODS.has(name))
		) {
			const call = `${this.receiverParam}.${name}(${tail.join(', ')})`;
			return this.declaredSuspends.has(name) ? this.awaited(call) : call;
		}

		if (implicit !== null && lambda !== null && BUILDER_LAMBDA_METHODS.has(name)) {
			const withLambda = this.callArguments(name, args, lambda, labelled, true);
			return `${implicit}.${name}(${withLambda.join(', ')})`;
		}
		// `configureClient() = addCookie { listOf("age" to "18") }` — the same
		// call the written-receiver form already makes, on the builder that is
		// the implicit receiver, with the block as an ordinary argument (the
		// cookies, asked for per request). Only `addCookie`: the other
		// argument-lambda method is `addInterceptor`, and an interceptor lambda
		// is a boundary this path must not open by the back door.
		if (
			implicit !== null &&
			lambda !== null &&
			name === 'addCookie' &&
			!this.isSourceMember(name)
		) {
			const withLambda = this.callArguments(name, args, lambda, labelled, false);
			return `${implicit}.${name}(${withLambda.join(', ')})`;
		}
		// `configureClient() = rateLimit(3)`: the builder is the implicit
		// receiver, and the period has to be resolved here exactly as it is for
		// the written-out `.rateLimit(3)` — the generic helper path below passes
		// the arguments through, and the runtime is then handed no period at all.
		if (
			implicit !== null &&
			(name === 'rateLimit' || name === 'rateLimitHost') &&
			!this.isSourceMember(name) &&
			!this.extensionFunctions.has(name)
		) {
			return this.rateLimitCall(callee, implicit, name, args, lambda);
		}
		// `x?.runCatching { parseAs<JsonObject>() }` — a decode whose receiver
		// is the implicit one. Read as a member of the source it was
		// `__self.parseAs()`: no type, the extension object as its payload, a
		// throw that `runCatching` turned into null — and every Madara
		// extension's view-count ping silently never went out. Decoded exactly
		// as the written-receiver form `x.parseAs<T>()` is.
		if (
			implicit !== null &&
			DECODING_METHODS.has(name) &&
			!this.isSourceMember(name) &&
			!this.extensionFunctions.has(name) &&
			lambda === null
		) {
			const shape = typeArgument ?? expected;
			if (shape === null) this.refuse(callee, `\`${name}()\` with no type argument`);
			return `${this.helper('decode')}(${[implicit, this.decodeType(shape), ...tail].join(', ')})`;
		}
		if (implicit !== null && !this.isSourceMember(name)) {
			const helper = EXTENSION_METHODS.get(name);
			if (helper !== undefined) {
				// With its trailing lambda, which this dropped.
				//
				// `fun List<String>.keep() = filter { it.isNotBlank() }` reaches
				// here with the receiver implicit, and `tail` above is
				// `plainArguments` — arguments only. So the predicate was thrown
				// away and `__k.filter(__recv)` went out with nothing to filter
				// by. `filter` and `map` at least throw; `first`, `firstOrNull`
				// and `last` answer element 0, which is a wrong value and says
				// nothing. The same call written `this.filter { … }` was always
				// emitted correctly — only the implicit form lost it.
				const before = this.asyncLambdas;
				const withLambda = this.provenance(
					helper,
					this.callArguments(name, args, lambda, labelled, RECEIVER_SCOPE.has(name)),
					1
				);
				// The type, as the written-receiver path passes it — see
				// `TYPED_HELPERS`. `apply { firstInstanceOrNull<SortFilter>() }` is
				// the implicit spelling of the same call.
				if (TYPED_HELPERS.has(helper) && typeArgument !== null && args.length === 0) {
					withLambda.push(this.typeReference(typeArgument));
				}
				const call = `${this.helper(helper)}(${[implicit, ...withLambda].join(', ')})`;
				const suspends = AWAITING_HELPERS.has(helper) || this.asyncLambdas > before;
				return suspends ? this.awaited(call) : call;
			}
			if (implicit !== 'this' || HOST_METHODS.has(name)) {
				// A passthrough onto a shim cannot carry a block: the shim was
				// written for the call it knows, and handing it one more argument
				// than it takes is the drop above by another route.
				if (lambda !== null) this.refuse(lambda, `a lambda passed to \`${name}\``);
				if (tail.length === 0 && HOST_PROPERTY_METHODS.has(name)) return `${implicit}.${name}`;
				return `${implicit}.${name}(${tail.join(', ')})`;
			}
		}

		// A base-class member nothing in this bundle overrides.
		//
		// `searchAnimeParse` in a shared theme ends `return popularAnimeParse(…)`
		// — a bare call to a member the *framework* supplies, which in Kotlin
		// resolves to the nearest override and here has to resolve to the driver.
		// Emitted as `this.popularAnimeParse(…)` it was
		// `this.popularAnimeParse is not a function` on the first search, in six
		// listings that shared the theme. The driver cannot simply put these on
		// the source: `__declares` asks the source whether a member exists, and a
		// source that answered yes to all of them would stop degrading around the
		// ones an extension really does leave out.
		//
		// Only when nothing converted declares it, because an override wins — the
		// same order Kotlin resolves in.
		if (
			SUPER_MEMBERS.has(name) &&
			!SUPER_RECEIVER_MEMBERS.has(name) &&
			!this.isSourceMember(name) &&
			!this.declaredMethods.has(name) &&
			lambda === null
		) {
			// Awaited by the same rule the written `super.` uses, so the two
			// spellings of one call do not disagree about what they answer — and
			// so a `headersBuilder()` in a property initialiser stays synchronous.
			const call = `__super.${name}(${tail.join(', ')})`;
			return SUPER_SUSPEND_MEMBERS.has(name) ? this.awaited(call) : call;
		}

		// A name nothing here declares is taken to be the extension's base
		// class's, and called on the source. That is wrong for a name the file
		// *imports*: one source's `import keiyoushi.utils.getLocalStorage` is a
		// top-level function in core's `WebView.kt` — a WebView boundary — which
		// the conversion never read, so it came out as
		// `this.getLocalStorage(…)`, converted as complete, loaded, and failed on
		// the first chapter with nothing refused. Refused by name instead.
		// Only a name nothing in this build answers: `parseAs` or `rateLimit`
		// imported from the same package is the runtime's, and reaches here
		// through a receiver the paths above did not claim.
		const imported = this.keiyoushiImports.get(name);
		if (
			imported !== undefined &&
			!RUNTIME_KNOWN_CALLS.some((table) => table.has(name)) &&
			!this.isSourceMember(name) &&
			!this.declaredMethods.has(name) &&
			!this.moduleNames.has(name) &&
			!(this.ownerBase !== null && this.baseDeclares(this.ownerBase, name))
		) {
			this.refuse(callee, `\`${name}\` from \`${imported}\`, which this build did not read`);
		}

		// Inside an `object`, nothing is the base class's. A Kotlin object — a
		// companion included — has no outer instance to call into, so a bare
		// name that is not the object's own member (or its translated base's)
		// is one this build never read. The fallback below wrote it as
		// `this.name(…)` all the same: in a property initialiser that is
		// `this` at module scope, which is undefined, and the whole bundle died
		// at load — `override val descriptor = buildClassSerialDescriptor("X")`
		// on a hand-written KSerializer did exactly that — and in a function
		// member it was a TypeError at the first call. Both converted as
		// complete. Refused by name instead.
		if (
			this.owner !== null &&
			this.declaredObjects.has(this.owner) &&
			!this.baseDeclares(this.owner, name)
		) {
			this.refuse(callee, `\`${name}(…)\`, which nothing this build read declares`);
		}

		// The source object, reached from wherever this call sits: inside a
		// receiver block that is `__self`, and everywhere else it is `this`.
		// Written as a literal `this`, a call to a member of the extension made
		// from inside an `apply {}` landed on the record being built.
		const self = this.selfReference();
		const collided = this.fieldNames().has(name) ? this.overloadsOf(name) : null;
		const call =
			collided === null
				? `${self}.${name}(${tail.join(', ')})`
				: this.overloadCall(self, self, name, tail, collided);
		// Declared by the class being emitted, or by a translated base class it
		// really `extends` — `launchIO { countViews(document) }` in an extension
		// on a theme that declares `launchIO`. Either way the method exists on
		// the prototype chain and takes the block as its last parameter; only
		// a name nothing in reach declares is the passthrough that cannot
		// carry one.
		const inherited = this.ownerBase !== null && this.baseDeclares(this.ownerBase, name);
		if (lambda !== null && (this.isSourceMember(name) || inherited)) {
			const withLambda = `${this.callArguments(name, args, lambda, labelled, false).join(', ')}`;
			return `${self}.${name}(${withLambda})`;
		}
		if (lambda !== null) this.refuse(lambda, `a lambda passed to \`${name}\``);
		return this.suspendMembers.has(name) ? this.awaited(call) : call;
	}

	/**
	 * Tells `__k.regex` which declaration it was built from.
	 *
	 * The runtime defers a pattern it cannot express — `ABI.md` §6 forbids
	 * lookbehind, and Kotlin's `Regex` is `java.util.regex`, which has it — from
	 * construction to first use, because this ecosystem declares its patterns as
	 * top-level and companion `val`s and throwing during module initialisation
	 * loses every member rather than the one that used the pattern. The message
	 * it eventually writes quotes the *engine's* escaping of the pattern, which
	 * is not what a maintainer would grep for, so the name of the declaration is
	 * the part that makes it findable.
	 */
	private provenance(helper: string, args: readonly string[], preceding: number): string[] {
		if (helper !== 'regex') return [...args];
		const out = [...args];
		// `declaredAt` is the third parameter, so an absent `options` has to be
		// written out rather than left off the end.
		while (preceding + out.length < 2) out.push('null');
		out.push(JSON.stringify(this.memberName.length > 0 ? this.memberName : 'this extension'));
		return out;
	}

	/**
	 * A call's arguments, with a trailing lambda appended.
	 *
	 * `receiverForm` is passed in rather than derived from the name, because
	 * `x.runCatching {}` binds `this` to `x` and a bare `runCatching {}` binds
	 * nothing. Deriving it from the name alone gives the bare form a `this` the
	 * runtime never sets, and every member read inside it reads `undefined`.
	 */
	private callArguments(
		name: string,
		args: KNode[],
		lambda: KNode | null,
		labelled: string | null,
		receiverForm: boolean,
		model: string | null = null
	): string[] {
		const slots = receiverForm ? undefined : this.receiverLambdas.get(name);
		if (slots === null && lambda !== null) {
			this.refuse(
				lambda,
				`a lambda passed to \`${name}\`, declared both with and without a receiver`
			);
		}
		const out = this.plainArguments(name, args);
		// An unlabelled lambda carries an implicit label: the name of the
		// function it was passed to. `return@map` inside `.map {}` is ordinary
		// Kotlin, and it is a return from the lambda, which translates.
		if (lambda !== null) {
			// A trailing lambda is the last parameter, and when that parameter is
			// typed `R.() -> T` the block is a receiver block. See `ReceiverSlots`.
			const last = slots === undefined || slots === null ? -1 : slots.count - 1;
			if (slots !== undefined && slots !== null && slots.at.includes(last)) {
				out.push(this.receiverLambdaValue(lambda, labelled ?? name));
			} else {
				out.push(
					this.lambda(lambda, receiverForm, labelled ?? name, !NO_BLOCK_PARAMETER.has(name), model)
				);
			}
		}
		return out;
	}

	/**
	 * `VidHideExtractor(client, headers).videosFromUrl(url) { quality -> quality }`
	 * — a trailing lambda to a method this unit declares, on a receiver whose
	 * class is known. Null when either is not the case, and the caller refuses.
	 *
	 * Kotlin binds a trailing lambda to the *last* parameter, whatever sits
	 * between: `videosFromUrl(url, prefix = "", videoNameGen)` called as
	 * `videosFromUrl(url) { … }` leaves `prefix` at its default. So the lambda
	 * goes in the last slot of the declared signature and every slot skipped on
	 * the way is `undefined`, which is what makes a JavaScript default parameter
	 * — the emitted declaration's own — apply. The signature is the receiver
	 * class's own (`qualifiedSignatures`), never the name's across the unit:
	 * this ecosystem declares `videosFromUrl` in forty extractors, with forty
	 * parameter lists.
	 *
	 * Positional arguments only. A named argument before the block is a
	 * placement question `plainArguments` answers for plain calls and this does
	 * not try to.
	 */
	private trailingLambdaArguments(
		name: string,
		receiver: KNode,
		args: KNode[],
		lambda: KNode,
		labelled: string | null
	): string[] | null {
		if (args.some((arg) => arg.allChildren.some((child) => child.type === '='))) return null;
		const owner = this.receiverTypeOf(receiver);
		if (owner === null) return null;
		const signature = this.qualifiedSignatures.get(`${owner}.${name}`);
		if (signature === undefined || signature.length === 0) return null;
		if (args.length > signature.length - 1) return null;
		const out = this.callArguments(name, args, lambda, labelled, false);
		const given = out.slice(0, -1);
		if (given.length !== args.length || given.some((one) => one.startsWith('...'))) {
			this.refuse(lambda, `a lambda passed to \`.${name}()\` after a spread`);
		}
		const skipped = signature.length - 1 - given.length;
		return [...given, ...Array.from({ length: skipped }, () => 'undefined'), out[out.length - 1]];
	}

	/**
	 * A block for a parameter typed `R.() -> T`, in the shape such a value
	 * travels in here: a receiver function, taking its receiver first. See
	 * `receiverLambda` in the runtime for why the two shapes meet there.
	 */
	private receiverLambdaValue(lambda: KNode, label: string): string {
		return `${this.helper('receiverLambda')}(${this.lambda(lambda, true, label, false)})`;
	}

	/**
	 * Refuses the receiver-lambda call shapes this build does not write.
	 *
	 * Only a *trailing* block is converted as a receiver block. A lambda passed
	 * inside the parentheses to a receiver parameter would take the ordinary
	 * arrow path and lose its receiver without a word, so it is refused; so is
	 * any lambda to a name declared twice with different receiver parameters,
	 * where which one this call means is not something the text says. Asked
	 * of every argument list, because a call with no trailing block never
	 * reaches `callArguments` at all.
	 */
	private checkReceiverArguments(name: string, args: KNode[]): void {
		const slots = this.receiverLambdas.get(name);
		if (slots === undefined) return;
		const literal = (arg: KNode): boolean =>
			kids(arg).some((part) => part.type === 'lambda_literal' || part.type === 'annotated_lambda');
		if (slots === null) {
			const found = args.find(literal);
			if (found !== undefined) {
				this.refuse(
					found,
					`a lambda passed to \`${name}\`, declared both with and without a receiver`
				);
			}
			return;
		}
		args.forEach((arg, index) => {
			if (!literal(arg)) return;
			const named = this.argumentName(arg);
			if (named === null ? slots.at.includes(index) : slots.names.includes(named)) {
				this.refuse(arg, `a receiver lambda passed to \`${name}\` inside its parentheses`);
			}
		});
	}

	/**
	 * The class a call's receiver is an instance of, or null.
	 *
	 * Only where it is a *fact* rather than an inference: the receiver is a
	 * construction of a declared type, or a property whose declaration names
	 * one. Anything else answers null and the caller falls back to the bare
	 * name — which refuses a named argument rather than guessing at an order.
	 */
	/**
	 * The class declaring `name` when `receiver` is a property of the class
	 * being emitted whose declared type is a class of this unit — or null.
	 *
	 * Asked only of a property, never of a local: the emitted receiver text
	 * has to be the property read (`this.theme`), so a parameter or a `val`
	 * that shadows it is not mistaken for it. The type is walked up its bases,
	 * because the method a template helper calls is usually declared by the
	 * template and only overridden, if at all, by the extension extending it.
	 *
	 * A name one of those classes also holds as a *property* answers null: the
	 * JavaScript class then has one slot for two things, and which one a plain
	 * `.name(…)` reaches is `overloadsOf`'s question, not this one's.
	 */
	private typedMemberOwner(receiver: KNode, receiverText: string, name: string): string | null {
		if (this.owner === null) return null;
		const property =
			receiver.type === 'simple_identifier'
				? receiver.text
				: receiver.type === 'navigation_expression' &&
					  kids(receiver)[0]?.type === 'this_expression' &&
					  kids(receiver).length === 2
					? (kids(kids(receiver)[1]).find((child) => child.type === 'simple_identifier')?.text ??
						null)
					: null;
		if (property === null) return null;
		if (
			receiverText !== `this.${property}` &&
			receiverText !== `${this.selfReference()}.${property}`
		) {
			return null;
		}
		const type = this.classPropertyTypes.get(this.owner)?.get(property);
		if (type === undefined || type === '' || !this.declaredTypes.has(type)) return null;
		const seen = new Set<string>();
		let found: string | null = null;
		for (let at: string | undefined = type; at !== undefined && !seen.has(at);) {
			seen.add(at);
			if (this.classFieldIndex.get(at)?.has(name) === true) return null;
			if (found === null && this.classFunctionIndex.get(at)?.has(name) === true) found = at;
			at = this.classBaseIndex.get(at);
		}
		return found;
	}

	private receiverTypeOf(receiver: KNode): string | null {
		if (receiver.type === 'call_expression') {
			const callee = kids(receiver)[0];
			if (callee !== undefined && callee.type === 'simple_identifier') {
				return this.declaredTypes.has(callee.text) ? callee.text : null;
			}
			return null;
		}
		const named =
			receiver.type === 'simple_identifier'
				? receiver.text
				: receiver.type === 'navigation_expression'
					? (kids(kids(receiver)[kids(receiver).length - 1]).find(
							(child) => child.type === 'simple_identifier'
						)?.text ?? null)
					: null;
		if (named === null) return null;
		const known = this.propertyTypes.get(named);
		return known !== undefined && this.declaredTypes.has(known) ? known : null;
	}

	/** The name a named argument was written under, or null for a positional one. */
	private argumentName(arg: KNode): string | null {
		const children = arg.allChildren;
		const marker = children.findIndex((child) => child.type === '=');
		if (marker <= 0) return null;
		const written = children[marker - 1];
		return written.type === 'simple_identifier' ? written.text : null;
	}

	private plainArguments(name: string, args: KNode[], owner: string | null = null): string[] {
		this.checkReceiverArguments(name, args);
		const named = args.filter((arg) => arg.allChildren.some((child) => child.type === '='));
		if (named.length === 0) return args.flatMap((arg) => this.argumentExpressions(arg));

		// Kotlin permits named arguments in any order; reordering them needs the
		// callee's signature. Guessing is how a converted request ends up with
		// its headers in the URL.
		//
		// The declaring class first, where the call site could work out which
		// one it is calling. A name this ecosystem reuses over incompatible
		// parameter lists — `videosFromUrl` is declared 37 times — is ambiguous
		// under its bare spelling and gets dropped, which is exactly when this
		// is needed.
		const named_ = named
			.map((arg) => this.argumentName(arg))
			.filter((one): one is string => one !== null);

		// `Video` is two constructors under one name, and this is the only place
		// that can tell them apart — see `VIDEO_V16_PARAMETERS`.
		if (name === 'Video' && named_.some((one) => VIDEO_V16_ONLY.has(one))) {
			return this.videoV16Arguments(args, named_);
		}
		// An overloaded name is placed by the overloads that could be the callee,
		// never by whichever parameter list the table happened to keep last —
		// `extractFromDash` puts `referer` third in one overload and fifth in
		// the other, and slotting it by the wrong one sends a referer where a
		// headers object belongs.
		// The callee's own overloads when the receiver's class is known, and
		// otherwise every overload of the name — but then only as an offer:
		// where they disagree the ordinary path below still gets its say.
		const everywhere = [...(this.overloadIndex.get(name)?.values() ?? [])];
		const callee = owner ?? (this.isSourceMember(name) ? this.owner : null);
		const lineage = callee === null ? [] : this.lineage(callee);
		const own = everywhere.filter((shape) => shape.owners.some((one) => lineage.includes(one)));
		if (own.length >= 2) {
			const placed = this.overloadPlacement(name, args, named_, own, true);
			if (placed !== null) return placed;
		} else if (callee === null && everywhere.length >= 2) {
			const placed = this.overloadPlacement(name, args, named_, everywhere, false);
			if (placed !== null) return placed;
		}
		const qualified = owner === null ? undefined : this.qualifiedSignatures.get(`${owner}.${name}`);
		// The qualified signature only when it actually accounts for what was
		// written. An argument the Kotlin passes by name is a parameter of the
		// callee — if this signature does not have it, the receiver was resolved
		// to the wrong class, and the bare name is the better answer rather than
		// a refusal. (Measured: a `masterHeaders` argument refused an extension
		// that had been converting, because a same-named method on a different
		// class won.)
		const usable =
			qualified !== undefined && named_.every((one) => qualified.includes(one))
				? qualified
				: undefined;
		const bare = usable ?? this.signatures.get(name);
		// A list that does not declare what the call names cannot be the callee,
		// and neither can a name this build marked ambiguous and then dropped.
		// `signatureCandidates` still holds every spelling; where exactly one of
		// them accounts for the names written, that one is the answer.
		const signature =
			bare !== undefined && named_.every((one) => bare.includes(one))
				? bare
				: (this.onlyCandidate(name, named_) ?? bare);
		if (signature === undefined) {
			const options = VARARG_OPTIONS.get(name);
			if (options === undefined) this.refuse(named[0], `a named argument to \`${name}\``);
			return this.varargOptions(name, args, options);
		}

		const slots: (string | null)[] = signature.map(() => null);
		let position = 0;
		for (const arg of args) {
			if (!arg.allChildren.some((child) => child.type === '=')) {
				if (position >= slots.length) this.refuse(arg, `too many arguments to \`${name}\``);
				const values = this.argumentExpressions(arg);
				if (values.length !== 1 || values[0]?.startsWith('...')) {
					this.refuse(arg, 'a spread mixed with named arguments');
				}
				slots[position] = values[0];
				position += 1;
				continue;
			}
			const key = kids(arg)[0]?.text ?? '';
			const index = signature.indexOf(key);
			if (index === -1) this.refuse(arg, `the argument name \`${key}\` on \`${name}\``);
			const values = this.argumentExpressions(arg);
			if (values.length !== 1 || values[0]?.startsWith('...')) {
				this.refuse(arg, 'a spread mixed with named arguments');
			}
			slots[index] = values[0];
		}

		let last = slots.length - 1;
		while (last >= 0 && slots[last] === null) last -= 1;
		return slots.slice(0, last + 1).map((slot) => slot ?? 'undefined');
	}

	/**
	 * Named arguments to an overloaded function, placed the way Kotlin chooses.
	 *
	 * The candidates are the overloads that declare every name written and get
	 * every parameter without a default from the call. Where they all put each
	 * argument in the same slot, that placement is the answer whichever of them
	 * runs — and which one runs is `__k.overload`'s question, which it answers
	 * from the same defaults: a slot left `undefined` rules out an overload
	 * that required it. Where they disagree, the call is refused rather than
	 * placed by a guess. Null when no overload accounts for the call, so the
	 * ordinary path can say why.
	 */
	private overloadPlacement(
		name: string,
		args: KNode[],
		named: readonly string[],
		shapes: readonly OverloadSignature[],
		certain: boolean
	): string[] | null {
		const positional = args.filter((arg) => !arg.allChildren.some((child) => child.type === '='));
		const fits = shapes.filter((shape) => {
			const offset = shape.types.length - shape.params.length;
			if (positional.length > shape.params.length && shape.total !== -1) return false;
			if (!named.every((one) => shape.params.includes(one))) return false;
			return shape.params.every(
				(param, index) =>
					shape.defaults[index + offset] === true ||
					index < positional.length ||
					named.includes(param)
			);
		});
		if (fits.length === 0) return null;
		const layout = (shape: OverloadSignature): string =>
			named.map((one) => shape.params.indexOf(one)).join(',');
		if (fits.some((shape) => layout(shape) !== layout(fits[0]))) {
			if (!certain) return null;
			this.refuse(args[0] ?? args[args.length - 1], `named arguments to an overloaded \`${name}\``);
		}
		const signature = fits[0].params;
		const slots: (string | null)[] = signature.map(() => null);
		let position = 0;
		for (const arg of args) {
			const values = this.argumentExpressions(arg);
			if (values.length !== 1 || values[0]?.startsWith('...')) {
				this.refuse(arg, 'a spread mixed with named arguments');
			}
			if (!arg.allChildren.some((child) => child.type === '=')) {
				slots[position] = values[0];
				position += 1;
				continue;
			}
			slots[signature.indexOf(kids(arg)[0]?.text ?? '')] = values[0];
		}
		let last = slots.length - 1;
		while (last >= 0 && slots[last] === null) last -= 1;
		return slots.slice(0, last + 1).map((slot) => slot ?? 'undefined');
	}

	/**
	 * A `Video(…)` written against the ext-lib 16 primary constructor.
	 *
	 * Emitted as a **single options object** — `Video({ videoUrl: …,
	 * videoTitle: … })` — rather than slotted into positions, because the two
	 * constructors share four parameter names at different indices and a
	 * position is exactly what cannot be shared. The runtime reads one plain
	 * object argument as this constructor and everything else as the ext-lib 14
	 * one, so the two never have to be told apart by arity.
	 *
	 * Mixing is refused rather than resolved. A positional argument alongside a
	 * v16 name, or `url`/`quality` alongside one, would mean the call is not
	 * cleanly either constructor, and the wrong choice publishes a page url as
	 * a stream — silently, since both produce a `Video` that converts and
	 * loads. Neither shape occurs anywhere in the measured catalogue, so this
	 * refuses nothing that exists today and will refuse loudly if that changes.
	 */
	private videoV16Arguments(args: KNode[], named_: readonly string[]): string[] {
		const positional = args.filter((arg) => !arg.allChildren.some((child) => child.type === '='));
		if (positional.length > 0) {
			this.refuse(positional[0], '`Video(…)` mixing positional and ext-lib 16 named arguments');
		}
		const legacy = named_.find((one) => one === 'url' || one === 'quality');
		if (legacy !== undefined) {
			this.refuse(args[0], `\`Video(…)\` naming both \`${legacy}\` and an ext-lib 16 parameter`);
		}
		const fields: string[] = [];
		for (const arg of args) {
			const key = kids(arg)[0]?.text ?? '';
			if (!VIDEO_V16_PARAMETERS.includes(key)) {
				this.refuse(arg, `the argument name \`${key}\` on \`Video\``);
			}
			const values = this.argumentExpressions(arg);
			if (values.length !== 1 || values[0]?.startsWith('...')) {
				this.refuse(arg, 'a spread mixed with named arguments');
			}
			fields.push(`${key}: ${values[0]}`);
		}
		return [`{ ${fields.join(', ')} }`];
	}

	/**
	 * `client.get(url)`, `client.post(url, body = …)` and the rest of the
	 * repository's own suspend verbs on an okhttp client.
	 *
	 * keiyoushi's shared `core/` declares `get`, `post`, `put` and `head` as
	 * extension functions on `OkHttpClient`, each twice over: once taking
	 * `headers`, and once reading them off the `HttpSource` context receiver.
	 * They are how the current half of the catalogue makes every request —
	 * 1,647 `client.get(` in one repository — and with nothing recognising them
	 * a one-argument `client.get(url)` went down the `list.get(i)` path and came
	 * out as `__k.getAt(this.client, url)`: an index into the client, no
	 * request, no await, and a bundle that loaded clean and could not fetch.
	 *
	 * Two overloads under one name cannot be slotted by a signature, because
	 * the second positional argument is `headers` in one and `cacheControl` or
	 * `body` in the other. So the call is handed over as written — positional
	 * arguments in order, named ones as an object — and `__k.okhttp` tells the
	 * values apart by what they are, which is a fact at run time and a guess
	 * here. It also checks the receiver really is a client and otherwise calls
	 * the receiver's own `get`, so an extension class that happens to be named
	 * `ApiClient` with a `get` of its own is still called, not requested.
	 *
	 * Always awaited: every one of these suspends.
	 */
	private clientVerb(receiver: KNode, name: string, args: KNode[]): string {
		const positional: string[] = [];
		const named: string[] = [];
		for (const arg of args) {
			const key = this.argumentName(arg);
			if (key === null) {
				if (named.length > 0)
					this.refuse(arg, `a positional argument after a named one on \`${name}\``);
				positional.push(...this.argumentExpressions(arg));
				continue;
			}
			if (!CLIENT_VERB_PARAMETERS.has(key)) {
				this.refuse(arg, `the argument name \`${key}\` on \`${name}\``);
			}
			named.push(`${key}: ${this.expr(this.argumentValue(arg))}`);
		}
		if (positional.some((one) => one.startsWith('...'))) {
			this.refuse(args[0], `a spread passed to \`${name}\``);
		}
		return this.awaited(
			`${this.helper('okhttp')}(${this.expr(receiver)}, '${name}', [${positional.join(', ')}], ${named.length > 0 ? `{ ${named.join(', ')} }` : '{}'})`
		);
	}

	/**
	 * A vararg call's arguments, with its trailing named ones as one object.
	 *
	 * `text.split(",", limit = 2)` → `__k.split(text, ",", { limit: 2 })`. See
	 * `VARARG_OPTIONS` for why these cannot be slotted positionally, and
	 * `__splitOptions` for how the runtime tells the object from a delimiter.
	 */
	private varargOptions(name: string, args: KNode[], options: ReadonlySet<string>): string[] {
		const positional: string[] = [];
		const fields: string[] = [];
		for (const arg of args) {
			if (!arg.allChildren.some((child) => child.type === '=')) {
				positional.push(...this.argumentExpressions(arg));
				continue;
			}
			const key = kids(arg)[0]?.text ?? '';
			if (!options.has(key)) this.refuse(arg, `the argument name \`${key}\` on \`${name}\``);
			fields.push(`${key}: ${this.expr(this.argumentValue(arg))}`);
		}
		return [...positional, `{ ${fields.join(', ')} }`];
	}

	/**
	 * `.rateLimit(…)` and `.rateLimitHost(…)`, the two declarative helpers the
	 * ecosystem's shared libraries offer in place of writing an interceptor.
	 *
	 * Emitted with the period already resolved to **whole milliseconds**,
	 * because this is the last place that can do it. Both signatures exist in
	 * the wild —
	 *
	 *     rateLimit(permits: Int, period: Long = 1, unit: TimeUnit = SECONDS)
	 *     rateLimit(permits: Int, period: Duration = 1.seconds)
	 *
	 * — and `300.milliseconds` is erased to the number `300` before any runtime
	 * helper sees it (`DURATION_UNITS`). So `rateLimit(1, 2)` and
	 * `rateLimit(1, 2.seconds)` arrive at `__k` as the same two numbers meaning
	 * 2000ms and 2ms respectively, and the runtime has no way back. Resolving it
	 * here is not an optimisation; it is the difference between honouring a
	 * source's limit and exceeding it by a thousand.
	 *
	 * A period this cannot read exactly is **refused**. The wrong answer is a
	 * converted extension that asks a source for more than it promised, which
	 * costs a viewer their access rather than throwing anything anybody sees.
	 *
	 * **A trailing `shouldLimit` block is honoured by applying the limit to
	 * every request.** keiyoushi's own `rateLimit(permits, period) { url -> … }`
	 * scopes a rule to the requests its predicate accepts — nearly always "not
	 * the image uploads" or "only the site's own host". The host's policy is
	 * per plugin or per host, and cannot run a predicate; applying the rule to
	 * everything the plugin sends is stricter than the author asked, never
	 * looser, which is the direction that cannot cost a viewer their access.
	 * Image requests are the host's own and are not throttled by it either way.
	 * The predicate is not emitted, so nothing it reads has to translate.
	 *
	 * The receiver arrives as text because a bare `rateLimit(3)` inside
	 * `configureClient()` has no receiver node — it is the builder the base
	 * class passes in.
	 */
	private rateLimitCall(
		suffix: KNode,
		receiver: string,
		name: string,
		args: KNode[],
		predicate: KNode | null = null
	): string {
		if (predicate !== null && name !== 'rateLimit') {
			this.refuse(predicate, `a lambda passed to \`${name}\``);
		}
		if (args.some((arg) => arg.allChildren.some((child) => child.type === '='))) {
			// Reordering named arguments needs the callee's signature, which is in
			// a library this converter does not read. `plainArguments` guesses in
			// that position and is right often enough; here a guess is a wrong
			// rate rather than a wrong value somebody notices.
			this.refuse(suffix, `\`.${name}()\` with named arguments`);
		}
		// `rateLimitHost` takes the url first; everything after is the same.
		const first = name === 'rateLimitHost' ? 1 : 0;
		if (args.length < first + 1 || args.length > first + 3) {
			this.refuse(suffix, `\`.${name}()\` with ${args.length} arguments`);
		}
		const periodMs = this.rateLimitPeriod(suffix, name, args[first + 1], args[first + 2]);
		const parts = [receiver];
		if (first === 1) parts.push(...this.argumentExpressions(args[0]));
		parts.push(...this.argumentExpressions(args[first]));
		parts.push(String(periodMs));
		return `${this.helper(name)}(${parts.join(', ')})`;
	}

	/** The period of a rate limit, in milliseconds, or a refusal. */
	private rateLimitPeriod(
		suffix: KNode,
		name: string,
		period: KNode | undefined,
		unit: KNode | undefined
	): number {
		// One second, which is the default in both signatures above. The single
		// commonest spelling in the catalogue is the bare `.rateLimit(3)`.
		if (period === undefined) return 1000;

		const written = this.argumentValue(period).text.replace(/\s+/g, '');
		const duration = /^([0-9][0-9_]*)\.([A-Za-z]+)$/.exec(written);
		if (duration !== null) {
			if (unit !== undefined) {
				this.refuse(suffix, `\`.${name}()\` with both a \`Duration\` and a \`TimeUnit\``);
			}
			const factor = DURATION_UNITS.get(duration[2]);
			if (factor === undefined) this.refuse(suffix, `\`.${name}()\` in \`${duration[2]}\``);
			return this.wholeMillis(suffix, name, Number(duration[1].replace(/_/g, '')) * factor);
		}

		const plain = /^([0-9][0-9_]*)[Ll]?$/.exec(written);
		if (plain === null) this.refuse(suffix, `\`.${name}()\` with a period that is not a literal`);
		const count = Number(plain[1].replace(/_/g, ''));
		// No unit written means the `TimeUnit` overload's default, which is
		// seconds. The `Duration` overload cannot be reached by a bare integer —
		// Kotlin would not compile it — so this is not a guess between the two.
		if (unit === undefined) return this.wholeMillis(suffix, name, count * 1000);

		const named = /^TimeUnit\.([A-Za-z]+)$/.exec(this.argumentValue(unit).text.replace(/\s+/g, ''));
		if (named === null)
			this.refuse(suffix, `\`.${name}()\` with a unit that is not a \`TimeUnit\``);
		const factor = TIME_UNITS.get(named[1]);
		if (factor === undefined) this.refuse(suffix, `\`.${name}()\` in \`TimeUnit.${named[1]}\``);
		return this.wholeMillis(suffix, name, count * factor);
	}

	/**
	 * A period the host can actually wait out, or a refusal naming it.
	 *
	 * Sub-millisecond units land here as a fraction and a period longer than the
	 * call deadline lands here as a number nothing could honour. Both are
	 * refused rather than rounded: `AGENTS.md`'s standing rule is that a
	 * conservative refusal beats a silent wrong behaviour, and a rounded rate
	 * limit is silent by construction.
	 */
	private wholeMillis(suffix: KNode, name: string, millis: number): number {
		if (!Number.isInteger(millis) || millis < 1) {
			this.refuse(suffix, `\`.${name}()\` over a period shorter than a millisecond`);
		}
		if (millis > 600_000) {
			this.refuse(suffix, `\`.${name}()\` over a period of ${millis}ms`);
		}
		return millis;
	}

	/**
	 * `.addInterceptor(…)` where the argument is a *named* declarative one.
	 *
	 * The shared libraries this ecosystem depends on ship two rate limiters as
	 * constructors, and an extension may install either directly rather than
	 * through the `.rateLimit()` extension function. Those have a fixed meaning
	 * given by their own signature, so they translate onto the request policy
	 * exactly as the extension function does.
	 *
	 * Returning null rather than refusing is the point: **everything else stays
	 * refused** by the passthrough rule below, which is where a hand-written
	 * `addInterceptor { chain -> … }` lands. `adr/0006-local-http-server.md` §5
	 * is the rule — recognising what an arbitrary body *means* is exactly the
	 * intent-recognition this converter will not do, and the measured value of
	 * doing it anyway is zero listings, because a body that does something
	 * worth recognising also reaches for `.proceed()` and a cookie.
	 */
	private declarativeInterceptor(suffix: KNode, receiver: KNode, arg: KNode): string | null {
		const value = this.argumentValue(arg);
		if (value.type !== 'call_expression') return null;
		const call = this.flatten(value);
		if (call.lambda !== null || call.callee.type !== 'simple_identifier') return null;
		if (call.callee.text === 'RateLimitInterceptor') {
			return this.rateLimitCall(suffix, this.expr(receiver), 'rateLimit', call.args);
		}
		if (call.callee.text === 'SpecificHostRateLimitInterceptor') {
			return this.rateLimitCall(suffix, this.expr(receiver), 'rateLimitHost', call.args);
		}
		return null;
	}

	private argumentExpressions(arg: KNode): string[] {
		const value = this.argumentValue(arg);
		if (value.type !== 'spread_expression') return [this.expr(value)];
		const inner = kids(value)[0];
		if (inner === undefined) this.refuse(value, 'an empty `*` vararg spread');
		return [`...${this.expr(inner)}`];
	}

	private checkJsonBuilder(lambda: KNode): void {
		const statements = kids(lambda).find((child) => child.type === 'statements');
		for (const statement of kids(statements)) {
			const flag =
				statement.type === 'assignment' ? (kids(statement)[0]?.text ?? '') : statement.text;
			if (!TOLERATED_JSON_FLAGS.has(flag)) {
				this.refuse(statement, `\`Json { ${flag} }\``);
			}
		}
	}

	private argumentValue(arg: KNode): KNode {
		const value = arg.type === 'value_argument' ? kids(arg)[kids(arg).length - 1] : arg;
		if (value === undefined) this.refuse(arg, 'an empty argument');
		return value;
	}

	/* ── navigation ──────────────────────────────────────────────────────── */

	private navigation(node: KNode): string {
		// `java.net.URLEncoder.encode(…)` — the same class an import would have
		// named, written out in full instead. Kotlin lets either, and this
		// ecosystem writes both; read as a navigation chain the leading `java`
		// is an unresolvable name and the whole call refused, while the imported
		// spelling converted.
		//
		// Only a package this build knows the shape of, and only when the tail
		// is something the runtime actually defines — so an unknown qualified
		// name still refuses rather than being silently shortened to its last
		// segment.
		const qualified = QUALIFIED_GLOBAL.exec(node.text.replace(/\s+/g, ''));
		if (qualified !== null && GLOBAL_NAMES.has(qualified[1])) return qualified[1];
		// `java.lang.String.format(…)` is the `String.format(…)` a bare `String`
		// receiver already reaches: Kotlin's String type, which this runtime
		// spells as JavaScript's.
		const spelled = node.text.replace(/\s+/g, '');
		if (spelled === 'java.lang.String' || spelled === 'kotlin.String') return 'String';

		// The one thing this ecosystem asks the JVM class object for, and the
		// only reflection in the catalogue that has an answer here.
		//
		// `Intl(classLoader = this::class.java.classLoader!!)` is how a source
		// reaches the `.properties` files its own repository keeps beside its
		// Kotlin, and `CLASS_LOADER` is both spellings of it — the `::class`
		// form, which arrives as a navigation suffix holding a keyword and no
		// name, and the `javaClass` form, which is a named obstacle everywhere
		// else and stays one. Matched on the whole chain rather than on either
		// half, so `javaClass.simpleName` is untouched: a class *name* is what
		// `subset.ts` refuses reflection for, and this is a class *path*.
		if (CLASS_LOADER.test(node.text.replace(/\s+/g, ''))) return `${this.helper('classLoader')}()`;

		// The other chain through the class object with an answer: a class's
		// simple name. See `SIMPLE_NAME` in `subset.ts` for both halves.
		const simple = SIMPLE_NAME.exec(node.text.replace(/\s+/g, ''));
		if (simple !== null) return this.simpleName(node, simple[1] ?? null);

		const extension = this.extensionPropertyRead(node);
		if (extension !== null) return extension;

		const receiver = kids(node)[0];
		if (receiver.type === 'super_expression') {
			// `override val client = super.client.newBuilder()…` — by far the
			// commonest `super.` property in this ecosystem, and the one place
			// where reading it off `this` would be wrong twice over: `client` is
			// the member being declared, so `this.client` is either undefined or
			// itself. What the Kotlin means is the base class's, and the base
			// class's *is* the runtime's — one object, reached bare.
			const base = kids(node)[kids(node).length - 1];
			const property = kids(base).find((child) => child.type === 'simple_identifier')?.text;
			if (property !== undefined && SUPER_BASE_PROPERTIES.has(property)) return property;
			// **A property a translated template declares is on the instance**,
			// and there are exactly two moments at which reading it there is
			// reading the base's value:
			//
			// - the subclass does not declare it at all, so nothing has replaced
			//   what the template put there;
			// - it is the very property being initialised, in the constructor,
			//   after `super()` — `override val genres = super.genres + "yaoi"`.
			//   The template's assignment has run and the subclass's has not, so
			//   the instance still holds the base value, which is what Kotlin's
			//   `super.genres` reads. `classProperty` refuses it after all if it
			//   turns out to be emitted as a deferred getter instead, where that
			//   stops being true.
			//
			// Anything else — a sibling property the subclass also overrides —
			// has lost its base value by the time it could be read, and stays
			// refused.
			if (
				property !== undefined &&
				this.ownerBase !== null &&
				this.baseDeclares(this.ownerBase, property)
			) {
				if (this.initialising === property) {
					this.superSelfRead = true;
					return `${this.selfReference()}.${property}`;
				}
				if (!this.classMembers.has(property)) return `${this.selfReference()}.${property}`;
			}
			// Everything else: `__super` holds methods, not fields, and the rest
			// of the base's state lives on the source object, which `this`
			// already reaches.
			this.refuse(node, '`super.` used as a property');
		}
		const suffix = kids(node)[kids(node).length - 1];
		const name = kids(suffix).find((child) => child.type === 'simple_identifier')?.text ?? null;
		if (name === null) this.refuse(node, 'a property access with no name');
		const safe = suffix.allChildren[0]?.type === '?.';

		// `this::filterList.isInitialized` — Kotlin asking whether a `lateinit`
		// has been assigned yet. It is the guard in front of every lazily-built
		// filter list in this ecosystem, and it has exactly one meaning.
		//
		// The grammar drops the `::` from the qualified form, so what arrives is
		// indistinguishable from a real read of a property called
		// `isInitialized` — and there is no such property on anything here, so
		// the name decides. Emitted as written it was
		// `this.filterList.isInitialized`, which on a property never assigned is
		// a read off `undefined`: "Cannot read properties of undefined", on the
		// first search, in seven listings that had reported nothing refused.
		if (name === 'isInitialized') {
			const target =
				receiver.type === 'callable_reference'
					? this.read(kids(receiver)[0]?.text ?? '', kids(receiver)[0] ?? receiver)
					: this.expr(receiver);
			return `${this.helper('initialized')}(${target})`;
		}

		const helper = EXTENSION_PROPERTIES.get(name);
		if (helper !== undefined) {
			if (!safe) return `${this.helper(helper)}(${this.expr(receiver)})`;
			return `${this.helper('sc')}(${this.expr(receiver)}, (__r) => ${this.helper(helper)}(__r))`;
		}

		// `File.separator` — a static read off a type the runtime defines only
		// in part (`JSOUP_STATICS`). Passed through, it answered undefined.
		const partial =
			receiver.type === 'simple_identifier' ? JSOUP_STATICS.get(receiver.text) : undefined;
		if (partial !== undefined && !partial.has(name) && !this.moduleNames.has(receiver.text)) {
			this.refuse(node, `\`${receiver.text}.${name}\``);
		}

		// Property *reads* are passthrough where method calls are not: a DTO's
		// fields are unbounded — `item.file`, `item.label` — and an allowlist of
		// them could only ever be a list of the ones already seen.
		const unit = DURATION_UNITS.get(name);
		if (unit !== undefined && /^[0-9][0-9_]*$/.test(receiver.text.trim())) {
			return String(Number(receiver.text.trim().replace(/_/g, '')) * unit);
		}
		// The same unit on anything that is not a literal — `(amount * 7).days`,
		// `number.seconds` — which read as a plain property was `undefined` on a
		// number, and the relative upload date built from it was NaN. Only where
		// the file imports that unit, because only there can the Kotlin mean it;
		// and through the runtime even then, because Kotlin resolves a member
		// before an extension and a DTO field called `seconds` is still a field.
		if (unit !== undefined && this.durationImports.has(name) && !safe) {
			return `${this.helper('durationOf')}(${this.expr(receiver)}, ${jsString(name)}, ${unit})`;
		}
		// A Duration's `inWhole…` readers, over the milliseconds a Duration is
		// here. Truncated toward zero, as Kotlin's are.
		if (DURATION_READERS.has(name)) {
			const target = safe ? '__r' : this.expr(receiver);
			const read = `${this.helper('inWhole')}(${target}, ${jsString(name)})`;
			return safe ? `${this.helper('sc')}(${this.expr(receiver)}, (__r) => ${read})` : read;
		}

		return this.propertyAccess(this.expr(receiver), name, safe);
	}

	/**
	 * A property read, in whichever notation the name allows.
	 *
	 * Kotlin lets an identifier be spelled in backticks, and this ecosystem uses
	 * that for names JavaScript cannot take: `it.\`info-src\`` is a field on a
	 * DTO whose JSON key carries a hyphen. Emitted as written it is
	 * `it.\`info-src\``, which is not a property access at all — the module
	 * failed to parse and the extension died at load naming a template string.
	 *
	 * So a name that is not a JavaScript identifier is read with brackets, which
	 * is what it means. `?.[…]` is the optional form and needs no special case.
	 */
	private propertyAccess(receiver: string, name: string, safe: boolean): string {
		// `fieldName`, not `safeName`: this is a *read off an object*, so the
		// name has to stay the one the data carries. Sanitising it here would
		// look for `info_src` on a payload whose key is `info-src`, and a
		// reserved word is a perfectly good property name in JavaScript.
		const plain = fieldName(name);
		if (JS_IDENTIFIER.test(plain)) return `${receiver}${safe ? '?.' : '.'}${plain}`;
		return `${receiver}${safe ? '?.' : ''}[${JSON.stringify(plain)}]`;
	}

	/* ── lambdas ─────────────────────────────────────────────────────────── */

	private lambda(
		node: KNode,
		receiver: boolean,
		labelled: string | null = null,
		implicit = true,
		model: string | null = null
	): string {
		const params = kids(node).find((child) => child.type === 'lambda_parameters');
		const names: string[] = [];
		// `{ (key, value) -> … }` binds the components of one argument, not two
		// arguments. Emitting them as a parameter list would silently shift every
		// later argument along by one.
		const unpack: string[] = [];
		if (params !== undefined) {
			for (const declared of kids(params)) {
				if (declared.type === 'variable_declaration') {
					// Kotlin's `_` means "ignore this one", and a lambda may have
					// several: `{ _, _ -> … }` is ordinary in this ecosystem, and
					// `extractFromHls(url, referer) { _, _ -> … }` is where it was
					// measured. JavaScript forbids a repeated parameter name
					// outright — `(_, _) =>` is a SyntaxError before a line of the
					// module runs, which converted clean and failed at load. Each
					// one gets a name of its own instead, and nothing can refer to
					// them because Kotlin does not let anything refer to `_`.
					const bound = boundName(declared);
					names.push(bound === '_' ? `__ignored${names.length + 1}` : bound);
					continue;
				}
				if (declared.type !== 'multi_variable_declaration') {
					this.refuse(declared, `a \`${declared.type}\` lambda parameter`);
				}
				const parts = kids(declared).map(boundName);
				const holder = `__p${names.length + 1}`;
				names.push(holder);
				unpack.push(
					`const ${this.pattern(parts)} = ${this.helper('destructured')}(${this.safe(holder)});`
				);
				this.destructuredParts.push(...parts);
			}
		} else if (!receiver && implicit) {
			names.push('it');
		}

		const bound = this.destructuredParts.splice(0);
		const emitted = this.functionScope(
			receiver ? 'receiver' : 'lambda',
			labelled,
			names,
			() => {
				for (const part of bound) this.declare(part);
				return block([...unpack, ...this.lambdaLines(node)]);
			},
			receiver ? model : null
		);
		if (emitted.isAsync) this.asyncLambdas += 1;

		const head = `(${names.map((part) => this.safe(part)).join(', ')})`;
		const prefix = emitted.isAsync ? 'async ' : '';
		return receiver
			? `${prefix}function ${head} ${emitted.text}`
			: `${prefix}${head} => ${emitted.text}`;
	}

	private lambdaLines(node: KNode, sink: Sink = 'return'): string[] {
		const statements = kids(node).find((child) => child.type === 'statements');
		return statements === undefined ? [] : this.statementList(statements, sink);
	}

	private lambdaOf(node: KNode): KNode | null {
		const suffix = kids(node).find((child) => child.type === 'call_suffix');
		const annotated = kids(suffix).find((child) => child.type === 'annotated_lambda');
		return (
			kids(annotated).find((child) => child.type === 'lambda_literal') ??
			kids(suffix).find((child) => child.type === 'lambda_literal') ??
			null
		);
	}

	/* ── blocks emitted into their caller ────────────────────────────────── */

	/**
	 * The scope function this call is, when its block can be emitted inline.
	 *
	 * Deliberately narrow: exactly one argument list, exactly one trailing
	 * lambda, and a name from `INLINE_SCOPES`. Anything else answers null and
	 * takes the ordinary callback path, because a shape this does not
	 * recognise is one whose semantics nobody here has written down.
	 */
	private scopeShape(node: KNode): Inlinable | null {
		// `with(x) { … }` parses as a call whose *callee* is a call, the same way
		// `flatten` unwinds it — so reading two children is not enough.
		const unwound = unwindCall(node);
		if (unwound === null) return null;
		const { callee, args, lambda, label } = unwound;

		if (callee.type === 'simple_identifier') {
			// A *bare* `run { … }` has no receiver at all, and `with(x) { … }`
			// takes one as its only argument. Both are ordinary Kotlin and both
			// inline the same way as their receiver-form siblings.
			if (callee.text === 'run' && args.length === 0) {
				return {
					name: 'run',
					subject: null,
					safe: false,
					lambda,
					receiverForm: false,
					yields: 'block',
					loop: false,
					label: label.length > 0 ? label : 'run'
				};
			}
			// `synchronized(lock) { … }` is mutual exclusion, and this runtime
			// is one thread: `ABI.md` §1 makes a plugin a single-threaded module
			// in a Worker, so the block already cannot be interleaved with
			// another copy of itself. Kotlin will not let a `synchronized` block
			// suspend either, so there is not even an `await` inside one for the
			// event loop to interleave at. Inlining it is therefore exact rather
			// than a weakening — and it keeps a `return` inside the block a
			// return from the member, which it is.
			//
			// The lock is still evaluated, once, and discarded. It is nearly
			// always `this` or a field; making it the subject rather than
			// dropping the argument means a `synchronized(lockFor(id)) { … }`
			// keeps the call its author wrote.
			if (callee.text === 'synchronized' && args.length === 1) {
				const lock = argumentOf(args[0]);
				if (lock === null) return null;
				return {
					name: 'synchronized',
					subject: lock,
					safe: false,
					lambda,
					receiverForm: false,
					yields: 'block',
					loop: false,
					label: label.length > 0 ? label : 'synchronized'
				};
			}
			if (callee.text === 'with' && args.length === 1) {
				const subject = argumentOf(args[0]);
				if (subject === null) return null;
				return {
					name: 'with',
					subject,
					safe: false,
					lambda,
					receiverForm: true,
					yields: 'block',
					loop: false,
					label: label.length > 0 ? label : 'with'
				};
			}
			return null;
		}

		if (callee.type !== 'navigation_expression' || args.length > 0) return null;
		const navigation = kids(callee)[kids(callee).length - 1];
		const name = kids(navigation).find((child) => child.type === 'simple_identifier')?.text ?? null;
		if (name === null) return null;
		const form = INLINE_SCOPES.get(name);
		if (form === undefined) return null;
		return {
			name,
			subject: kids(callee)[0],
			safe: navigation.allChildren[0]?.type === '?.',
			lambda,
			receiverForm: form.receiver,
			yields: form.yields,
			loop: form.loop,
			label: label.length > 0 ? label : name
		};
	}

	/**
	 * `runCatching { … }.getOrElse { … }`, which is a `try`/`catch` spelled sideways.
	 *
	 * Worth recognising as one construct rather than two: as two, the `Result`
	 * in the middle has to be a real object, and a `return` inside either half
	 * has nowhere to go. As one, it is exactly the `try`/`catch` the Kotlin
	 * means, and a `return` in either half is the enclosing function's — which
	 * is also what Kotlin does, because a non-local return is not an exception
	 * and `runCatching` never sees it.
	 */
	private recoverShape(node: KNode): Recoverable | null {
		if (node.type !== 'call_expression') return null;
		const parts = kids(node);
		if (parts.length !== 2) return null;
		const [callee, suffix] = parts;
		if (callee.type !== 'navigation_expression') return null;
		const navigation = kids(callee)[kids(callee).length - 1];
		const name = kids(navigation).find((child) => child.type === 'simple_identifier')?.text ?? null;
		if (name === null || navigation.allChildren[0]?.type === '?.') return null;
		if (!RECOVERIES.has(name)) return null;

		const attempt = runCatchingOf(kids(callee)[0]);
		if (attempt === null) return null;

		const given = kids(kids(suffix).find((child) => child.type === 'value_arguments'));
		const recover = trailingLambda(suffix);

		// One shape each, and anything else takes the ordinary path. A
		// `getOrElse` with a positional argument, say, is not this construct.
		if (name === 'getOrElse') {
			if (recover === null || given.length > 0) return null;
			return { attempt, recover, fallback: null, rethrows: false };
		}
		if (recover !== null) return null;
		if (name === 'getOrDefault') {
			if (given.length !== 1) return null;
			const fallback = argumentOf(given[0]);
			return fallback === null ? null : { attempt, recover: null, fallback, rethrows: false };
		}
		if (given.length > 0) return null;
		// `getOrThrow` is the block and nothing else: a failure propagates
		// exactly as it would have without the `runCatching` around it.
		return {
			attempt,
			recover: null,
			fallback: null,
			rethrows: name === 'getOrThrow'
		};
	}

	/**
	 * Whether this expression holds a block that has to be inlined to be right.
	 *
	 * The gate on all of it. Inlining is only reached for a block containing a
	 * jump that leaves it — which is exactly the code that used to be refused —
	 * so nothing that already translated changes shape.
	 */
	private needsInlining(node: KNode): boolean {
		if (node.type === 'elvis_expression') {
			const value = kids(node)[0];
			const fallback = kids(node)[1];
			return (
				(value !== undefined && this.needsInlining(value)) ||
				(fallback !== undefined && this.needsInlining(fallback))
			);
		}
		const recover = this.recoverShape(node);
		if (recover !== null) {
			return (
				crossesBlock(recover.attempt, 'runCatching') ||
				(recover.recover !== null && crossesBlock(recover.recover, 'getOrElse'))
			);
		}
		const shape = this.scopeShape(node);
		return shape !== null && crossesBlock(shape.lambda, shape.label);
	}

	/** The statements this expression becomes when its block is inlined, or null. */
	private lowered(node: KNode, sink: Sink): string[] | null {
		if (!this.needsInlining(node)) return null;
		if (node.type === 'elvis_expression') return this.lowerElvis(node, sink);
		const recover = this.recoverShape(node);
		if (recover !== null) return this.lowerRecover(recover, sink);
		const shape = this.scopeShape(node);
		return shape === null ? null : this.lowerScope(shape, sink);
	}

	/**
	 * `x ?: run { … return … }`, which is a guard rather than an operator.
	 *
	 * `elvisJump` already unwraps `x ?: return y`. This is the same shape with a
	 * block on the right instead of a bare jump, and it needs the same
	 * treatment for the same reason: there is no JavaScript expression that
	 * returns from its enclosing function.
	 */
	private lowerElvis(node: KNode, sink: Sink): string[] {
		const value = kids(node)[0];
		const fallback = kids(node)[1];

		// `runCatching { … return … }.getOrNull() ?: default` — the block that
		// has to be inlined is on the *left*. It becomes a statement assigning a
		// temporary, and the elvis is then an ordinary `??` over that.
		if (this.needsInlining(value)) {
			const holder = this.temporary();
			return [
				`let ${holder};`,
				...this.deliver(value, { target: holder }),
				...this.deliverValue(`(${holder} ?? ${this.expr(fallback)})`, sink)
			];
		}

		const holder = this.temporary();
		const otherwise = block(this.deliver(fallback, sink));
		if (sink === null) {
			return [`const ${holder} = ${this.expr(value)};`, `if (${holder} == null) ${otherwise}`];
		}
		return [
			`const ${holder} = ${this.expr(value)};`,
			`if (${holder} == null) ${otherwise} else ${block(this.deliverValue(holder, sink))}`
		];
	}

	private lowerRecover(shape: Recoverable, sink: Sink): string[] {
		this.exits += 1;
		const exit = `__x${this.exits}`;

		// `getOrDefault(x)` evaluates `x` as an argument — *after* the receiver,
		// which is the block, and whether or not the block threw. So the value
		// travels through a temporary and the argument is emitted where Kotlin
		// evaluates it rather than where it is used. Emitting it inside the
		// `catch` would skip it on success; emitting it above the `try` would
		// run it before the block. Both are observable, and this ecosystem
		// writes `getOrDefault(emptyList())`, which is a call.
		if (shape.fallback !== null) {
			const holder = this.temporary();
			const failed = this.temporary();
			const error = this.temporary();
			const attempt = this.inlineFrame(
				{ label: 'runCatching', sink: { target: holder }, exit },
				() => this.lambdaLines(shape.attempt, { target: holder })
			);
			const guarded = `try ${block(attempt.lines)} catch (${error}) ${block([`${failed} = true;`])}`;
			const fallbackValue = this.temporary();
			return [
				`let ${holder};`,
				`let ${failed} = false;`,
				attempt.broke ? `${exit}: ${block([guarded])}` : guarded,
				`const ${fallbackValue} = ${this.expr(shape.fallback)};`,
				`if (${failed}) ${holder} = ${fallbackValue};`,
				...this.deliverValue(holder, sink)
			];
		}

		const attempt = this.inlineFrame({ label: 'runCatching', sink, exit }, () =>
			this.lambdaLines(shape.attempt, sink)
		);

		if (shape.rethrows) {
			// `runCatching { … }.getOrThrow()` is the block and nothing else: a
			// failure propagates exactly as it would have without the
			// `runCatching` around it.
			return [attempt.broke ? `${exit}: ${block(attempt.lines)}` : block(attempt.lines)];
		}

		const error = this.temporary();
		let recovered: { lines: string[]; broke: boolean };
		if (shape.recover === null) {
			// `getOrNull()` answers Kotlin's absent value.
			recovered = { lines: this.deliverNull(sink), broke: false };
		} else {
			const bound = this.inlineParams(shape.recover, false);
			if (bound.names.length > 1) {
				this.refuse(shape.recover, `a \`getOrElse\` block taking ${bound.names.length} parameters`);
			}
			const written = shape.recover;
			recovered = this.inlineFrame({ label: 'getOrElse', sink, exit, bound: bound.bound }, () => [
				...bound.names.map((name) => `const ${this.safe(name)} = ${error};`),
				...bound.unpack,
				...this.lambdaLines(written, sink)
			]);
		}

		const text = `try ${block(attempt.lines)} catch (${error}) ${block(recovered.lines)}`;
		// A `return@runCatching` leaves by a label, and `try` takes a block
		// rather than a labelled statement — so the label goes around both.
		return [attempt.broke || recovered.broke ? `${exit}: ${block([text])}` : text];
	}

	private lowerScope(shape: Inlinable, sink: Sink): string[] {
		const bound = this.inlineParams(shape.lambda, shape.receiverForm);
		if (bound.names.length > 1) {
			this.refuse(
				shape.lambda,
				`a \`${shape.name}\` block taking ${bound.names.length} parameters`
			);
		}

		const out: string[] = [];
		let subject: string | null = null;
		if (shape.subject !== null) {
			subject = this.temporary();
			out.push(`const ${subject} = ${this.expr(shape.subject)};`);
		}

		this.exits += 1;
		const exit = `__x${this.exits}`;

		if (shape.loop) {
			if (subject === null) this.refuse(shape.lambda, `a \`${shape.name}\` with nothing to walk`);
			const item = this.safe(bound.names[0] ?? 'it');
			const body = this.inlineFrame(
				{
					label: shape.label,
					sink: null,
					exit,
					loop: true,
					bound: bound.bound
				},
				() => [...bound.unpack, ...this.lambdaLines(shape.lambda, null)]
			);
			// `__k.toList` is what every other collection helper walks, so a jsoup
			// `Elements`, a `Set` and a `Map` all iterate the way Kotlin's own
			// `forEach` would rather than the way `for…of` would.
			let loop = `for (const ${item} of ${this.helper('toList')}(${subject})) ${block(body.lines)}`;
			if (body.broke) loop = `${exit}: ${loop}`;
			out.push(shape.safe ? `if (${subject} != null) ${block([loop])}` : loop);
			// `forEach` produces Unit, so anything asking it for a value gets one.
			out.push(...this.deliverNull(sink));
			return out;
		}

		const body = this.inlineFrame(
			{
				label: shape.label,
				sink: shape.yields === 'block' ? sink : null,
				exit,
				alias: shape.receiverForm ? subject : null,
				model: shape.receiverForm && shape.subject !== null ? modelTypeOf(shape.subject) : null,
				bound: bound.bound
			},
			() => {
				const lines: string[] = [];
				if (!shape.receiverForm && bound.names.length === 1 && subject !== null) {
					lines.push(`const ${this.safe(bound.names[0])} = ${subject};`);
				}
				lines.push(...bound.unpack);
				lines.push(...this.lambdaLines(shape.lambda, shape.yields === 'block' ? sink : null));
				// `also` and `apply` answer with the receiver, not with the block.
				if (shape.yields === 'subject' && subject !== null) {
					lines.push(...this.deliverValue(subject, sink));
				}
				return lines;
			}
		);

		let text = body.broke ? `${exit}: ${block(body.lines)}` : block(body.lines);
		if (shape.safe && subject !== null) {
			text =
				sink === null
					? `if (${subject} != null) ${text}`
					: `if (${subject} == null) ${block(this.deliverNull(sink))} else ${text}`;
		}
		out.push(text);
		return out;
	}

	/**
	 * The names a lambda binds, for a block being emitted into its caller.
	 *
	 * Separate from `lambda` because an inlined block binds its parameter with
	 * a `const` rather than by being called with one.
	 */
	private inlineParams(
		lambda: KNode,
		receiverForm: boolean
	): { names: string[]; unpack: string[]; bound: string[] } {
		const params = kids(lambda).find((child) => child.type === 'lambda_parameters');
		const names: string[] = [];
		const unpack: string[] = [];
		const bound: string[] = [];
		if (params === undefined) {
			if (!receiverForm) {
				names.push('it');
				bound.push('it');
			}
			return { names, unpack, bound };
		}
		for (const declared of kids(params)) {
			if (declared.type === 'variable_declaration') {
				const name = boundName(declared);
				names.push(name);
				bound.push(name);
				continue;
			}
			if (declared.type !== 'multi_variable_declaration') {
				this.refuse(declared, `a \`${declared.type}\` lambda parameter`);
			}
			const parts = kids(declared).map(boundName);
			const holder = `__p${names.length + 1}`;
			names.push(holder);
			bound.push(holder, ...parts);
			unpack.push(
				`const ${this.pattern(parts)} = ${this.helper('destructured')}(${this.safe(holder)});`
			);
		}
		return { names, unpack, bound };
	}

	private inlineFrame(
		options: {
			label: string;
			sink: Sink;
			exit: string;
			alias?: string | null;
			model?: string | null;
			loop?: boolean;
			bound?: readonly string[];
		},
		run: () => string[]
	): { lines: string[]; broke: boolean } {
		const frame: Frame = {
			kind: 'inline',
			label: options.label,
			usesAwait: false,
			usesSelf: false,
			alias: options.alias ?? null,
			model: options.model ?? null,
			sink: options.sink,
			exit: options.exit,
			loop: options.loop === true,
			broke: false
		};
		this.frames.push(frame);
		// An inlined `forEach` is a `for…of` here: a `break` inside it would
		// end the walk, where Kotlin's — non-local, out of an inline lambda —
		// meant a loop outside it.
		if (frame.loop === true) this.loops.push('barrier');
		this.pushScope();
		for (const name of options.bound ?? []) this.declare(name);
		try {
			return { lines: run(), broke: frame.broke === true };
		} finally {
			this.popScope();
			if (frame.loop === true) this.loops.pop();
			this.frames.pop();
		}
	}

	/**
	 * The inlined block a `return@label` names, or null when it names none.
	 *
	 * The walk stops at the first frame that is a real callback: there is no
	 * `break` out of an arrow function, so a `return@let` written inside a
	 * lambda nested in an inlined `let` is still refused rather than rerouted.
	 */
	/**
	 * The callback a `return@label` names from inside a *nested* callback, with
	 * an identity assigned — or null when no enclosing callback carries that
	 * label.
	 *
	 * Kotlin's non-local return. `map { x?.let { y ?: return@map null } }` leaves
	 * the `map` block from inside the `let` block, and JavaScript has no
	 * statement that returns from anything but the function it is written in.
	 * A throw does cross, so the jump becomes one and the named frame catches
	 * it: exact, including through `await`, and paid for only where it is used.
	 *
	 * Bounded at the first real `function`. A method boundary is not something
	 * a Kotlin lambda label can name, and a throw that escaped one would leave
	 * the member rather than the block.
	 */
	private nonLocalTarget(label: string, mustCross = true): number | null {
		let crossed = false;
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			// Inlined blocks are not callbacks; crossing one costs nothing.
			if (frame.kind === 'inline') continue;
			if (frame.label === label) {
				if (mustCross && !crossed) return null;
				frame.jumpId ??= this.jumpIds++;
				frame.catchesJump = true;
				return frame.jumpId;
			}
			if (frame.kind === 'function') return null;
			crossed = true;
		}
		return null;
	}

	/**
	 * The enclosing member, as a jump target — for Kotlin's *unlabelled*
	 * non-local return out of an inline lambda. See `nonLocalTarget`.
	 */
	private memberJumpTarget(): number | null {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			if (frame.kind !== 'function') continue;
			frame.jumpId ??= this.jumpIds++;
			frame.catchesJump = true;
			return frame.jumpId;
		}
		return null;
	}

	/** The label of the innermost frame that is a real JavaScript callback. */
	private enclosingCallbackLabel(): string | null {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			if (this.frames[index].kind === 'inline') continue;
			return this.frames[index].label;
		}
		return null;
	}

	private inlinedFrameLabelled(label: string): Frame | null {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			if (frame.kind !== 'inline') return null;
			if (frame.label === label) return frame;
		}
		return null;
	}

	private inlineExit(frame: Frame, value: KNode | undefined): string {
		frame.broke = true;
		if (frame.loop === true) {
			// Kotlin discards whatever `return@forEach` carries, so the
			// expression is still evaluated — it may be the whole point — and
			// then dropped.
			return block([...(value === undefined ? [] : [this.stmt(value)]), `continue ${frame.exit};`]);
		}
		const sink = frame.sink ?? null;
		const lines = value === undefined ? this.deliverNull(sink) : this.deliver(value, sink);
		return block([...lines, `break ${frame.exit};`]);
	}

	/* ── strings ─────────────────────────────────────────────────────────── */

	private stringLiteral(node: KNode): string {
		const raw = node.text.startsWith('"""');
		const chunks: { literal: boolean; text: string }[] = [];

		for (const child of node.allChildren) {
			switch (child.type) {
				case 'string_content':
					// A raw string has no escapes at all: `\d` in `"""(\d+)"""` is a
					// backslash and a `d`, which is exactly what a regex wants.
					chunks.push({
						literal: true,
						text: raw ? child.text : decodeEscapes(child.text)
					});
					break;
				case 'interpolated_identifier':
					chunks.push({ literal: false, text: this.read(child.text, child) });
					break;
				case 'interpolated_expression': {
					const inner = kids(child)[0];
					if (inner === undefined) this.refuse(child, 'an empty `${}`');
					chunks.push({ literal: false, text: this.expr(inner) });
					break;
				}
				case '$':
				case '${':
				case '}':
				case '"':
				case '"""':
					break;
				default:
					this.refuse(child, `${spoken(child)} inside a string`);
			}
		}

		if (chunks.every((chunk) => chunk.literal)) {
			return jsString(chunks.map((chunk) => chunk.text).join(''));
		}
		return `\`${chunks.map((chunk) => (chunk.literal ? templateChunk(chunk.text) : `\${${chunk.text}}`)).join('')}\``;
	}

	/* ── names and scopes ────────────────────────────────────────────────── */

	/**
	 * A destructuring's binding list, with each `_` left as a hole.
	 *
	 * Kotlin's `_` is "no component here" and may be written any number of
	 * times — `val (id, _, _) = url.split("/", limit = 3)`. Passed through as a
	 * name it is two `const` bindings of `_`, which is "\"_\" has already been
	 * declared" when the bundle is imported, taking every member with it. An
	 * elided element is exactly what Kotlin meant: the component is not read.
	 */
	private pattern(parts: readonly string[]): string {
		return `[${parts.map((part) => (part === '_' ? '' : this.safe(part))).join(', ')}]`;
	}

	/**
	 * The JavaScript name a Kotlin one is written out as.
	 *
	 * Two rewrites, and they are different in kind. `safeName` handles what
	 * JavaScript reserves and what this emitter reserves for itself, and never
	 * changes between files. `renames` is what *this file* takes back from the
	 * runtime: a file that declares its own `Video` means its own everywhere it
	 * says `Video`, and the file next door that imported the framework's still
	 * means the framework's. `pipeline.ts` decides which files those are.
	 */
	private safe(name: string): string {
		return safeName(this.companionRenames.get(name) ?? this.renames.get(name) ?? name);
	}

	private read(name: string, node: KNode): string {
		const local = this.lookup(name);
		if (local !== null) return local;
		// The root of a package path — `java.lang.Integer.toHexString(…)` — that
		// nothing above resolved. Read as a member it became `this.java`, and
		// the call died on `undefined` at run time with nothing refused.
		if (PACKAGE_ROOTS.has(name) && !this.classMembers.has(name) && !this.moduleNames.has(name)) {
			this.refuse(node, `a fully qualified \`${name}.…\` name this build does not know`);
		}
		// A bare `quality` naming an extension property is a read through an
		// implicit receiver — `with(preferences) { quality }` — which this
		// build does not track. Refused, rather than read off the extension.
		if (this.extensionProperties.has(name) && !this.classMembers.has(name)) {
			this.refuse(node, `a bare read of extension property \`${name}\``);
		}
		// Inside an enum: an entry by its bare name, and the entry list.
		const inEnum = this.enumMember(name);
		if (inEnum !== null) return inEnum;
		// After the local, so a variable named like an alias still wins — a
		// `typealias` is a file-scope declaration and a local shadows one.
		const alias = this.aliased(name);
		if (alias !== name) return this.read(alias, node);
		// A renamed name is one this file declares itself, which outranks the
		// runtime's — the whole point of the rename.
		if (GLOBAL_NAMES.has(name) && !this.renames.has(name)) return name;
		// A `val X get() = …` is a function at module scope, and Kotlin's read of
		// it is a call. Emitting the bare name hands out the function itself.
		if (this.moduleGetters.has(name)) return `${this.safe(name)}()`;
		if (this.moduleNames.has(name)) return this.safe(name);
		const hoisted = this.localTypes.get(name);
		if (hoisted !== undefined) return this.safe(hoisted);
		// A member of the `object` this code is being emitted into, reached the
		// way a frozen literal's members are reached.
		//
		// Not when the class being emitted declares the name itself. The table
		// is file-wide, so without this a `private val tag` on the source read
		// as `Helper.tag` whenever an `object Helper` in the same file also had
		// one — a different value, silently, with nothing refused. Kotlin
		// resolves the innermost declaration first, and outside the object that
		// is the class's own. Inside the object (`owner` is it) its member wins.
		const holder = this.objectMembers.get(name);
		if (holder !== undefined && (holder === this.owner || !this.classMembers.has(name))) {
			// From another property of the same object, through the hoisted const
			// — the literal is not bound yet. From anywhere else, through the
			// object, which by then is.
			const alias = this.objectAliases.get(`${holder}.${name}`);
			if (holder === this.emittingObjectProperty) {
				if (alias !== undefined) return alias;
			} else {
				return `${this.safe(holder)}.${fieldName(name)}`;
			}
		}
		// A property imported by name from a shared `object`.
		const importedFrom = this.importedOwner(name);
		if (importedFrom !== null && this.classFieldIndex.get(importedFrom)?.has(name) === true) {
			return `${this.safe(importedFrom)}.${fieldName(name)}`;
		}
		const backing = this.fieldReference(name, node);
		if (backing !== null) return backing;
		if (name === 'it') this.refuse(node, 'an `it` with no lambda around it');
		// `"https:$this"` — a `this` inside a string template arrives here as an
		// identifier rather than as `this_expression`, and it means what it
		// means there: see the `this_expression` case for the receivers.
		if (name === 'this') return this.receiverAlias() ?? this.receiverParam ?? 'this';
		// `override fun onFailure(call: Call, e: IOException) = Unit` — Kotlin's
		// "no value", and this ecosystem's way of writing an override that does
		// nothing. JavaScript's is `undefined`. Asked here rather than in a
		// table because it is a keyword-shaped name, and after the lookups above
		// so a source that declares its own `Unit` still means its own.
		if (name === 'Unit') return 'undefined';

		// A constant the extension inherited from its base class, written bare
		// the way Kotlin lets it be. Checked after this file's own declarations,
		// so a source that declares the same name keeps meaning its own.
		const inherited = BASE_CONSTANTS.get(name);
		if (inherited !== undefined) return inherited;
		const imported = this.companionImports.get(name);
		if (imported !== undefined) return imported;

		// A capitalised name this file did not declare belongs to another
		// module — `Injekt`, `Dispatchers`, an extractor object. Reading it as a
		// member of the source would resolve to undefined at run time.
		//
		// A capitalised name the class being translated *declares* is not that.
		// `private val ALPHABET = mapOf(…)` read from a method two lines below
		// it is an ordinary member read, and Kotlin's naming convention puts a
		// constant in capitals whether it lives in a companion or not — so this
		// refused a class for reading its own table. The companion case resolved
		// already, because a companion hoists to module scope; a plain property
		// had nothing to catch it.
		if (/^[A-Z]/.test(name) && !this.classMembers.has(name)) this.refuse(node, `\`${name}\``);

		const receiver = this.receiverAlias();
		if (receiver !== null && MODEL_FIELDS.get(this.receiverModel() ?? '')?.has(name) === true) {
			return `${receiver}.${name}`;
		}
		// `fun Dto.toSManga() = SManga.create().apply { genre = tags.join… }`
		// has three implicit receivers, and `tags` is the DTO's: the model does
		// not have one, and Kotlin tries the extension receiver before the
		// class. Read off the model instead it is `undefined`, and the genre
		// list is empty with nothing thrown. A model field the DTO *also*
		// declares stays with the model — that is the innermost receiver, and
		// it is why the source had to write `this@toSManga.title` to mean the
		// other one. Where the model is not written, every model's fields stay
		// with the receiver, which is the old rule.
		if (
			receiver !== null &&
			this.receiverParam !== null &&
			!(MODEL_FIELDS.get(this.receiverModel() ?? '') ?? ANY_MODEL_FIELD).has(name) &&
			this.receiverDeclares(name)
		) {
			return `${this.receiverParam}.${name}`;
		}
		if (
			receiver !== null &&
			!this.isSourceMember(name) &&
			MODEL_LACKS.get(this.receiverModel() ?? '')?.has(name) !== true
		) {
			return `${receiver}.${name}`;
		}
		// Kotlin tries the extension receiver before the class it is declared
		// in, so a name both declare is the receiver's.
		if (this.receiverParam !== null && this.receiverDeclares(name)) {
			return `${this.receiverParam}.${name}`;
		}
		// Inside `fun Element.getInfo()`, a bare name is the receiver's unless
		// the enclosing class declares it — the same rule, and the same residual
		// risk, as an `apply {}` body.
		if (this.receiverParam !== null && !this.isSourceMember(name)) {
			return `${this.receiverParam}.${name}`;
		}
		return `${this.selfReference()}.${name}`;
	}

	/**
	 * `field`, as the backing field of the property whose accessor this is —
	 * or null when `name` is some other name, including a property that is
	 * simply called `field`.
	 *
	 * `class SelectFilter(val field: String)` reads its own `field` in a
	 * method, and Kotlin only makes the word a keyword inside an accessor.
	 * Refusing it everywhere refused two whole filter themes for a parameter
	 * name. Inside an accessor with no field this build modelled it still
	 * refuses: reading the class's member there would be a different value.
	 */
	private fieldReference(name: string, node: KNode): string | null {
		if (name !== 'field') return null;
		if (this.backing !== null) return `${this.selfReference()}.${this.backing}`;
		if (!this.inAccessor && this.classMembers.has('field')) return null;
		this.refuse(node, 'a `field` backing reference');
	}

	/** Whether the extension function being emitted extends a type declaring `name`. */
	private receiverDeclares(name: string): boolean {
		if (this.receiverType === null) return false;
		return this.classMemberIndex.get(this.receiverType)?.has(name) === true;
	}

	private isSourceMember(name: string): boolean {
		return this.classMembers.has(name) || BASE_SOURCE_MEMBERS.has(name);
	}

	/**
	 * True when a name on the left of `::` is a *value* rather than a type.
	 *
	 * A declared type is deliberately excluded even though it is also a module
	 * name: `MyFilter::toUriPart` is Kotlin's unbound form and takes its
	 * receiver as the argument, where `myFilter::toUriPart` does not.
	 */
	private isValueName(name: string): boolean {
		if (this.lookup(name) !== null) return true;
		if (this.classMembers.has(name) || BASE_SOURCE_MEMBERS.has(name)) return true;
		// A member a translated template declares — DooPlay's `protected open
		// val episodeNumberRegex`, read by `Example : DooPlay` as
		// `.let(episodeNumberRegex::find)`. The subclass inherits it through the
		// real `extends`, so it is a value here exactly as its own members are.
		const base = this.owner === null ? undefined : this.classBaseIndex.get(this.owner);
		if (base !== undefined && this.baseDeclares(base, name)) return true;
		if (GLOBAL_NAMES.has(name)) return true;
		return this.moduleNames.has(name) && !this.declaredTypes.has(name);
	}

	/**
	 * How to reach the *source object* from here.
	 *
	 * An `apply {}` emitted as a real `function () {}` rebinds JavaScript's
	 * `this` to the receiver, so the source has to be captured by the enclosing
	 * function as `__self`. An `apply {}` that was *inlined* rebinds nothing —
	 * its receiver is a `const` — so `this` is still the source and no capture
	 * is needed. Getting that backwards emits a `__self` nobody declared.
	 */
	private simpleName(node: KNode, value: string | null): string {
		if (value !== null) {
			// `e.javaClass.simpleName`: whatever the runtime can say about the
			// value, and only where what it says is a diagnostic.
			if (!this.inLogLine)
				this.refuse(node, '`javaClass.simpleName` of a value outside a log line');
			const receiver = kids(kids(node)[0])[0];
			return `${this.helper('simpleName')}(${this.expr(receiver)})`;
		}
		// Inside `apply {}` or `fun String.x()` the implicit receiver is not the
		// class, and `javaClass` is the receiver's. Neither is tracked by type.
		if (this.receiverAlias() !== null || this.receiverParam !== null) {
			this.refuse(node, '`javaClass` of a receiver that is not the class');
		}
		if (this.selfClass === null) this.refuse(node, '`javaClass` where no named class is `this`');
		if (this.selfClass.exact) return JSON.stringify(this.selfClass.name);
		return `${this.helper('simpleName')}(${this.selfReference()})`;
	}

	/**
	 * Whether the class or object being emitted declares `name` itself, or a
	 * local of that name is in scope. See the free-function check in `bareCall`.
	 */
	/**
	 * Whether a call `name(…)` could reach something other than a local: a
	 * member of this class or of a template it extends, an `object`'s own
	 * member, or a file-scope `fun`. See `Local.valueOnly`.
	 */
	private callableMember(name: string): boolean {
		if (this.isSourceMember(name) || this.moduleNames.has(name)) return true;
		if (this.owner !== null && this.objectMembers.get(name) === this.owner) return true;
		const base = this.owner === null ? undefined : this.classBaseIndex.get(this.owner);
		return base !== undefined && this.baseDeclares(base, name);
	}

	private declaresOwn(name: string): boolean {
		if (this.lookup(name) !== null) return true;
		if (this.owner !== null && this.objectMembers.get(name) === this.owner) return true;
		return this.owner !== null && this.classMembers.has(name);
	}

	private selfReference(): string {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const kind = this.frames[index].kind;
			if (kind === 'inline' || kind === 'lambda') continue;
			if (kind === 'function') return 'this';
			// A real receiver block: walk out to the function that can capture.
			for (let outer = index; outer >= 0; outer -= 1) {
				if (this.frames[outer].kind !== 'function') continue;
				this.frames[outer].usesSelf = true;
				return '__self';
			}
			return 'this';
		}
		return 'this';
	}

	/**
	 * How the innermost `apply`/`run`/`with` receiver is spelled, or null.
	 *
	 * `'this'` for a block emitted as a `function () {}`; the temporary holding
	 * the receiver for one that was inlined.
	 */
	private receiverAlias(): string | null {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			if (frame.kind === 'receiver') return 'this';
			if (frame.kind === 'inline') {
				if (frame.alias != null) return frame.alias;
				continue;
			}
			if (frame.kind === 'function') return null;
		}
		return null;
	}

	/** The model type of the innermost receiver block, where one is known. */
	private receiverModel(): string | null {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			if (frame.kind === 'receiver') return frame.model ?? null;
			if (frame.kind === 'inline') {
				if (frame.alias != null) return frame.model ?? null;
				continue;
			}
			if (frame.kind === 'function') return null;
		}
		return null;
	}

	/**
	 * `this@label`: the receiver the label names, or a refusal.
	 *
	 * Kotlin gives a receiver a label three ways, and each already has a
	 * spelling here, so this only has to find the right one:
	 *
	 * - **A scope block** — `this@apply`, `this@run`, `this@buildString` —
	 *   whose receiver is `this` inside a block emitted as `function () {}` and
	 *   a `const` inside one that was inlined. An outer *callback's* `this` is
	 *   out of reach once an inner one has rebound it, and that one refuses.
	 * - **An extension function** — `this@toSManga` — whose receiver this
	 *   emitter moved into its first parameter, which every closure inside the
	 *   function can still see.
	 * - **The class** being emitted, which is the source object wherever this
	 *   code runs: `selfReference` is already how that is reached past a block.
	 *
	 * Innermost first, which is the order Kotlin resolves them in. A label
	 * naming anything else is a receiver this build no longer has, and guessing
	 * which one it was is how a scraper reads a selector off the wrong object.
	 */
	private labelledThis(label: string, node: KNode): string {
		let rebound = false;
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const frame = this.frames[index];
			if (frame.kind === 'function') break;
			if (frame.label === label) {
				if (frame.kind === 'inline' && frame.alias != null) return frame.alias;
				if (frame.kind === 'receiver') {
					if (!rebound) return 'this';
					this.captures += 1;
					frame.capture ??= `__this${this.captures}`;
					return frame.capture;
				}
				this.refuse(node, `\`${node.text}\``);
			}
			if (frame.kind === 'receiver') rebound = true;
		}
		if (label === this.receiverLabel && this.receiverParam !== null) return this.receiverParam;
		if (label === this.owner || label === this.ownerLabel || label === this.className) {
			return this.selfReference();
		}
		this.refuse(node, `\`${node.text}\``);
	}

	/** True when the nearest `this`-rebinding frame is an `apply`/`run` block. */
	private inReceiver(): boolean {
		return this.receiverAlias() !== null;
	}

	/**
	 * True when a bare `return` here would return from a callback rather than
	 * from the member.
	 *
	 * Inlined blocks are transparent: that is the entire point of inlining one.
	 */
	private inLambda(): boolean {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			const kind = this.frames[index].kind;
			if (kind === 'inline') continue;
			return kind !== 'function';
		}
		return false;
	}

	private pushScope(): void {
		this.scopes.push(new Map());
	}

	private popScope(): void {
		this.scopes.pop();
	}

	private declare(name: string, mutable = false, text = this.safe(name)): void {
		this.scopes[this.scopes.length - 1]?.set(name, { text, mutable });
	}

	/** A local bound under a JavaScript name other than its own. See `localBinding`. */
	private declareAs(name: string, text: string, mutable: boolean): void {
		this.scopes[this.scopes.length - 1]?.set(name, { text, mutable });
	}

	/** See `Local.valueOnly`. Rebinds the innermost binding of `name`, unchanged otherwise. */
	private markValueOnly(name: string): void {
		const scope = this.scopes[this.scopes.length - 1];
		const found = scope?.get(name);
		if (found !== undefined) scope.set(name, { ...found, valueOnly: true });
	}

	/** A parameter typed `R.(…) -> T`, taking `arity` arguments besides `R`. */
	private declareReceiverLocal(name: string, arity: number, suspends: boolean): void {
		this.scopes[this.scopes.length - 1]?.set(name, {
			text: this.safe(name),
			mutable: false,
			receiverArity: arity,
			receiverSuspends: suspends
		});
	}

	/**
	 * A call of a parameter typed `R.(…) -> T`, which takes its receiver first.
	 *
	 * Kotlin has three spellings of one call and all three land here:
	 * `builder.block(x)` names the receiver in front, `block(builder, x)` passes
	 * it as the first argument, and `block(x)` inside `apply { … }` leaves it
	 * implicit — the innermost receiver in scope, which is `this` in a receiver
	 * block and `__recv` in an extension function. Where there is no receiver in
	 * scope but the class itself, the call is refused rather than handed the
	 * source object: that would be a receiver of a type the block never takes.
	 *
	 * Told apart by argument count against the declared arity, which is what
	 * the Kotlin compiler does too.
	 */
	private invokeReceiverLocal(
		node: KNode,
		local: Local,
		explicit: string | null,
		args: KNode[],
		lambda: KNode | null
	): string {
		const arity = local.receiverArity ?? 0;
		if (lambda !== null) this.refuse(lambda, 'a lambda passed to a receiver function parameter');
		const passed = this.plainArguments('', args);
		let all: string[];
		if (explicit !== null) {
			if (passed.length !== arity)
				this.refuse(node, 'a receiver function called with the wrong arguments');
			all = [explicit, ...passed];
		} else if (passed.length === arity + 1) {
			all = passed;
		} else if (passed.length === arity) {
			const implicit = this.receiverAlias() ?? this.receiverParam;
			if (implicit === null) {
				this.refuse(node, 'a receiver function called with no receiver in reach');
			}
			all = [implicit, ...passed];
		} else {
			this.refuse(node, 'a receiver function called with the wrong arguments');
		}
		const call = `${local.text}(${all.join(', ')})`;
		return local.receiverSuspends === true ? this.awaited(call) : call;
	}

	private lookup(name: string): string | null {
		return this.lookupLocal(name)?.text ?? null;
	}

	private lookupLocal(name: string): Local | null {
		for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
			const found = this.scopes[index].get(name);
			if (found !== undefined) return found;
		}
		return null;
	}

	private temporary(): string {
		this.temporaries += 1;
		return `__t${this.temporaries}`;
	}

	/* ── frames ──────────────────────────────────────────────────────────── */

	private functionScope(
		kind: Frame['kind'],
		label: string | null,
		params: readonly string[],
		run: () => string,
		model: string | null = null
	): Emitted {
		const frame: Frame = { kind, label, usesAwait: false, usesSelf: false, model };
		this.frames.push(frame);
		this.loops.push('barrier');
		this.pushScope();
		for (const param of params) this.declare(param);
		try {
			const body = run();
			// A `return@thisLabel` written inside a callback nested in this one
			// left by throwing; this is where it lands. See `nonLocalTarget` for
			// why a throw is the only expression JavaScript has for it.
			const raw =
				frame.catchesJump === true && body.startsWith('{')
					? `{ try ${body} catch (__j) { if (${this.helper('isJump')}(__j, ${frame.jumpId})) ` +
						`return ${this.helper('jumpValue')}(__j); throw __j; } }`
					: body;
			// `__self` is declared once per real function, so an `apply {}` nested
			// anywhere inside it can still reach the source's own members.
			const self =
				frame.usesSelf && kind === 'function' && raw.startsWith('{')
					? `{\n\tconst __self = this;${raw.slice(1)}`
					: raw;
			// A receiver block an inner one reached past with `this@label`.
			const text =
				frame.capture !== undefined && self.startsWith('{')
					? `{\n\tconst ${frame.capture} = this;${self.slice(1)}`
					: self;
			return { text, isAsync: frame.usesAwait, usesSelf: frame.usesSelf };
		} finally {
			this.popScope();
			this.loops.pop();
			this.frames.pop();
		}
	}

	/**
	 * Marks the enclosing frame `async` and returns the awaited expression.
	 *
	 * An inlined block has no `function` of its own to be made `async`, so the
	 * mark travels out to whichever one is actually emitting the `await`.
	 */
	private awaited(expression: string): string {
		for (let index = this.frames.length - 1; index >= 0; index -= 1) {
			if (this.frames[index].kind === 'inline') continue;
			this.frames[index].usesAwait = true;
			break;
		}
		return `(await ${expression})`;
	}

	/** A statement sequence used where a value is needed. */
	private iife(lines: () => string[], label: string | null = null): string {
		const emitted = this.functionScope('lambda', label, [], () => block(lines()));
		if (!emitted.isAsync) return `(() => ${emitted.text})()`;
		const outer = this.frames[this.frames.length - 1];
		if (outer !== undefined) outer.usesAwait = true;
		return `(await (async () => ${emitted.text})())`;
	}

	/* ── plumbing ────────────────────────────────────────────────────────── */

	private helper(name: string): string {
		this.used.add(name);
		return `__k.${name}`;
	}

	private refuse(node: KNode, kind: string): never {
		this.pending.push({ kind, line: node.line, memberName: this.memberName });
		throw new Refused(kind);
	}

	private nameOf(node: KNode): string | null {
		const named = kids(node).find(
			(child) => child.type === 'simple_identifier' || child.type === 'type_identifier'
		);
		return named?.text ?? null;
	}

	private propertyName(node: KNode): string | null {
		const declaration = kids(node).find((child) => child.type === 'variable_declaration');
		return kids(declaration)[0]?.text ?? null;
	}

	private hasModifier(node: KNode, name: string): boolean {
		const modifiers = kids(node).find((child) => child.type === 'modifiers');
		return kids(modifiers).some((child) => child.text === name) ?? false;
	}

	/**
	 * The supertype a class *constructs*, if it constructs one.
	 *
	 * `: Intl` with no parentheses is an interface, and there is nothing to
	 * call; only `: Base(a, b)` names a constructor whose arguments have to
	 * reach the base, and only those can be silently lost.
	 */
	private baseInvocation(node: KNode): { type: string; args: readonly KNode[] } | null {
		for (const specifier of kids(node)) {
			if (specifier.type !== 'delegation_specifier') continue;
			const invocation = kids(specifier).find((child) => child.type === 'constructor_invocation');
			if (invocation === undefined) continue;
			const written = kids(invocation)[0];
			if (written === undefined) continue;
			const args = kids(invocation).find((child) => child.type === 'value_arguments');
			return { type: typeName(written), args: kids(args) };
		}
		return null;
	}

	/**
	 * The JavaScript expression a supertype names, or null when nothing does.
	 *
	 * Two things resolve. A type this file declares is emitted beside the class
	 * extending it, so the name is in scope. `AnimeFilter.Select` and its
	 * siblings are the runtime's own — `shims/kotlin-runtime.ts` defines each
	 * as a constructor, and an ES6 class extends one of those the same way it
	 * extends a class. Everything else is the extension's own base class or a
	 * library type, and neither is here to extend.
	 */
	private resolvedBase(type: string): string | null {
		const declared = this.aliased(type);
		if (this.declaredTypes.has(declared)) {
			return this.safe(this.localTypes.get(declared) ?? declared);
		}
		// `: AnimeStreamFilters.QueryPartFilter(name, LIST)` — a nested type
		// written through the object holding it. It is hoisted to module scope
		// under its bare name (see `qualifiedTypes`), and that binding is what
		// the `extends` names, exactly as for the imported bare spelling.
		const nested = this.qualifiedTypes.get(declared);
		if (nested !== undefined && this.declaredTypes.has(nested)) {
			return this.safe(this.localTypes.get(nested) ?? nested);
		}
		// Both spellings of one class: the video ecosystem renamed `Filter` to
		// `AnimeFilter` when it forked and changed nothing else, so a subclass
		// of either resolves and the runtime aliases the two together.
		const filter = /^(?:AnimeFilter|Filter)\.(\w+)$/.exec(type);
		if (filter !== null && ANIME_FILTER_KINDS.has(filter[1])) return type;
		// The bare spelling, which comes of `import …model.AnimeFilter.TriState`.
		// Nine sources here write that, and the base was dropped in silence: a
		// `class TriFilterVal(name) : TriState(name)` emitted with no `extends`
		// has no `isIgnored` on it, so `state.filterNot { it.isIgnored() }`
		// answered `it.isIgnored is not a function` on the first search — out of
		// a bundle that loaded and reported nothing refused. A source declaring
		// a type of its own by that name is caught above, as it must be.
		if (ANIME_FILTER_KINDS.has(declared)) return `AnimeFilter.${declared}`;
		return null;
	}

	/**
	 * What makes a Kotlin `Iterable` iterable here.
	 *
	 * Two spellings reach this. `class Volume(val chapters: List<Chapter>) :
	 * Iterable<Chapter> by chapters` delegates the interface, which was refused
	 * as an `explicit_delegation`; and `override fun iterator() = (a +
	 * b).iterator()` declares it, which translated — into a class JavaScript
	 * cannot iterate. `for (x in volume)` then threw "is not iterable", and
	 * worse, `volume.map { … }` went through `__arr`, which read a value with
	 * no protocol as a list of one: the map ran once, over the Volume itself,
	 * and answered a plausible list of the wrong thing with nothing refused.
	 *
	 * So a delegate becomes `iterator()` over it — read each time from the
	 * `val`s it names, which is the same list Kotlin captured at construction
	 * because a `val` cannot be reassigned (a plain constructor parameter is
	 * gone after construction, so a delegate naming one is refused) — and a
	 * class with either gets `[Symbol.iterator]` draining its Kotlin iterator,
	 * which is what `for…of`, `Array.from` and so `__arr` all ask for.
	 */
	private iterationMembers(
		node: KNode,
		members: readonly KNode[],
		params: readonly { name: string; isProperty?: boolean }[],
		record: boolean
	): string[] {
		let delegate: KNode | null = null;
		for (const specifier of kids(node)) {
			if (specifier.type !== 'delegation_specifier') continue;
			const explicit = kids(specifier).find((child) => child.type === 'explicit_delegation');
			if (explicit === undefined) continue;
			delegate = iterableDelegateOf(explicit);
			if (delegate === null) this.refuse(explicit, 'explicit_delegation');
		}
		const declares = members.some(
			(child) =>
				child.type === 'function_declaration' &&
				this.nameOf(child) === 'iterator' &&
				!this.hasModifier(child, 'abstract') &&
				kids(kids(child).find((part) => part.type === 'function_value_parameters')).length === 0
		);
		if (delegate === null && !declares) return [];
		const out: string[] = [];
		if (delegate !== null) {
			if (declares) this.refuse(delegate, 'an `Iterable` delegate beside its own `iterator()`');
			if (!record) {
				for (const used of walk(delegate)) {
					if (used.type !== 'simple_identifier') continue;
					const param = params.find((one) => one.name === used.text);
					if (param !== undefined && param.isProperty !== true) {
						this.refuse(used, 'an `Iterable` delegate reading a parameter that is not a property');
					}
				}
			}
			const body = this.functionScope('function', null, [], () =>
				block([`return ${this.helper('iterator')}(${this.expr(delegate as KNode)});`])
			);
			if (body.isAsync) this.refuse(delegate, 'an `Iterable` delegate that suspends');
			out.push(`iterator() ${body.text}`);
		}
		out.push(
			'*[Symbol.iterator]() { const __it = this.iterator(); while (__it.hasNext()) yield __it.next(); }'
		);
		return out;
	}

	/** A base constructor's arguments, read with the subclass's own parameters in scope. */
	private baseArguments(
		invoked: { type: string; args: readonly KNode[] },
		params: readonly { name: string }[]
	): string[] {
		this.pushScope();
		try {
			for (const param of params) this.declare(param.name);
			return this.plainArguments(invoked.type, [...invoked.args]);
		} finally {
			this.popScope();
		}
	}

	private superClassOf(node: KNode): string | null {
		const specifiers = kids(node).filter((child) => child.type === 'delegation_specifier');
		const called = specifiers.find((child) =>
			kids(child).some((inner) => inner.type === 'constructor_invocation')
		);
		const chosen = called ?? specifiers[0];
		if (chosen === undefined) return null;
		const invocation = kids(chosen).find((child) => child.type === 'constructor_invocation');
		const type = kids(invocation ?? chosen)[0];
		return type === undefined ? null : typeName(type);
	}
}

/* ── shared shapes ────────────────────────────────────────────────────────── */

/**
 * What an operand is provably, from its shape alone, or null.
 *
 * Deliberately short. Anything a name, a call or a property read produced is
 * null, because none of those says what it holds; see `additive`.
 */
function primitiveShape(node: KNode | undefined): 'number' | 'string' | 'char' | null {
	if (node === undefined) return null;
	switch (node.type) {
		case 'integer_literal':
		case 'hex_literal':
		case 'bin_literal':
		case 'long_literal':
		case 'unsigned_literal':
		case 'real_literal':
		case 'multiplicative_expression':
			return 'number';
		case 'string_literal':
			return 'string';
		case 'character_literal':
			return 'char';
		case 'parenthesized_expression':
			return primitiveShape(kids(node)[0]);
		case 'prefix_expression':
			return node.allChildren[0]?.type === '-' || node.allChildren[0]?.type === '+'
				? primitiveShape(kids(node)[0])
				: null;
		case 'additive_expression': {
			// Left-associative, so the leftmost operand decides the whole chain:
			// `"a" + x + y` is a string throughout, and `1 + x` is a number.
			const left = primitiveShape(kids(node)[0]);
			if (left === 'char') {
				// `'a' + 1` is a Char and `'z' - 'a'` an Int; neither is worth a
				// fast path, so the chain goes through the helper.
				return null;
			}
			return left;
		}
		default:
			return null;
	}
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** Parts of a `property_declaration` that are not its initialiser. */
/**
 * Every model's fields at once, for the one question asked where the model
 * an `apply {}` builds is not written: is a bare name possibly the model's?
 * Inside `fun Dto.toSManga() = …apply { … }` a name listed here stays with the
 * receiver, as it always has; everything else the DTO declares is the DTO's.
 * `memo` is keiyoushi's extra field on all four.
 */
const ANY_MODEL_FIELD: ReadonlySet<string> = new Set([
	...[...MODEL_FIELDS.values()].flatMap((fields) => [...fields]),
	'memo'
]);

/** One term of a `CoroutineScope(…)` context the runtime models. */
const COROUTINE_CONTEXT =
	/^(?:Dispatchers\.(?:IO|Default|Main|Unconfined)|SupervisorJob\(\)|Job\(\))$/;

/** Exception types nothing in this runtime can throw; see `reachableCatches`. */
const NEVER_THROWN: ReadonlySet<string> = new Set([
	'CancellationException',
	'TimeoutCancellationException'
]);

/** Clause types that catch whatever a translated extension can throw. */
const CATCH_ALL: ReadonlySet<string> = new Set(['Exception', 'Throwable']);

/** The framework's model types, whose fields `MODEL_FIELDS` lists. */
const MODEL_TYPES: ReadonlySet<string> = new Set(MODEL_FIELDS.keys());

/** Properties the framework declares, for an unbound `Type::name` reference to one. */
const FRAMEWORK_PROPERTIES: ReadonlySet<string> = new Set([...ANY_MODEL_FIELD, 'state', 'values']);

const PROPERTY_PARTS: ReadonlySet<string> = new Set([
	'modifiers',
	'binding_pattern_kind',
	'variable_declaration',
	'multi_variable_declaration',
	'getter',
	'setter',
	'property_delegate'
]);

/**
 * Declarations that are fine at class scope and would need lifting inside a body.
 *
 * A class declared inside a method is legal Kotlin, and `hoistLocal` lifts it
 * to module scope, which is where the emitted module keeps types. Reaching one
 * through `expr` instead means it was written where a *value* was wanted, and
 * there is no value a declaration produces. Named here rather than in
 * `OUT_OF_SCOPE_KINDS`, which the pre-scan reads and which must keep saying
 * that a `class_declaration` at file scope is perfectly ordinary.
 *
 * A local `fun` is not on this list any more: `localFunction` emits one in
 * place as an arrow, which keeps both `this` and the locals it closes over.
 */
const LOCAL_DECLARATIONS: ReadonlyMap<string, string> = new Map([
	['class_declaration', 'a class declared inside a function'],
	['object_declaration', 'an `object` declared inside a function']
]);

/** Parameter modifiers with nothing left to say once the inlining is gone. */
const ERASED_PARAMETER_MODIFIERS: ReadonlySet<string> = new Set(['noinline', 'crossinline']);

const ASSIGN_OPS: ReadonlySet<string> = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
const CHECK_OPS: ReadonlySet<string> = new Set(['is', '!is', 'in', '!in']);

/* ── text ─────────────────────────────────────────────────────────────────── */

/**
 * A node's named children, with comments removed.
 *
 * This grammar makes `line_comment` and `multiline_comment` **named** children,
 * so they sit in the middle of a statement list, between a class's members, and
 * between an operator and its operand. Reading `children` directly means an
 * emitter that indexes into them picks up a comment as an expression and one
 * that iterates them refuses every commented member — which, measured against
 * the catalogue, was the single largest cause of refusal by an order of
 * magnitude. Every read of a node's children in this file goes through here.
 *
 * `allChildren` is left alone: it is only ever used to find an operator token
 * or a keyword, both of which are matched by kind rather than by position.
 */
function kids(node: KNode | null | undefined): readonly KNode[] {
	if (node === null || node === undefined) return [];
	const all = node.children;
	const named = all.some((child) => COMMENT_KINDS.has(child.type))
		? all.filter((child) => !COMMENT_KINDS.has(child.type))
		: all;

	// `null` is the one *unnamed* node the emitter has to read as a value: this
	// grammar gives `true` a `boolean_literal` wrapper and gives `null` a bare
	// token, so `fun sel() = null` and `x ?: null` arrive with no named children
	// at all and look like an empty body. It is appended rather than spliced
	// into position because every place it appears — a sole value, a right
	// operand — is the last one.
	const nulls = node.allChildren.filter((child) => child.type === 'null');
	return nulls.length === 0 ? named : [...named, ...nulls];
}

/**
 * The function type a parameter is declared with, looking through `( … )?`.
 */
function parameterFunctionType(parameter: KNode): KNode | null {
	let type = kids(parameter).find(
		(child) => child.type === 'function_type' || child.type === 'nullable_type'
	);
	if (type?.type === 'nullable_type') {
		const inner = kids(type).find((child) => child.type === 'parenthesized_type');
		type = kids(inner).find((child) => child.type === 'function_type');
	}
	return type ?? null;
}

/**
 * For a parameter typed `R.(A, B) -> T`, how many arguments it takes besides
 * its receiver — here, 2. Null for any other parameter.
 *
 * The receiver is the `.` in front of the parameter list, which is the only
 * part of the type that says so; the receiver's own name is not needed, and a
 * dotted one arrives respelled — see `dottedReceiverTypes` in `grammar.ts`.
 */
function receiverArity(parameter: KNode): number | null {
	const type = parameterFunctionType(parameter);
	if (type === null) return null;
	const parts = type.allChildren;
	const list = parts.findIndex((child) => child.type === 'function_type_parameters');
	if (list <= 0 || parts[list - 1].type !== '.') return null;
	return kids(parts[list]).length;
}

/**
 * `x` in `x.source()` — a zero-argument, non-safe call of `source` — or null.
 * See the `asResponseBody` case in `methodCall`.
 */
function okioSourceOf(node: KNode): KNode | null {
	return okioStreamOf(node, 'source');
}

/** `x` in `x.<name>()`, zero arguments and not safe, or null. */
function okioStreamOf(node: KNode, name: string): KNode | null {
	if (node.type !== 'call_expression') return null;
	const [callee, suffix] = kids(node);
	if (callee?.type !== 'navigation_expression' || suffix?.type !== 'call_suffix') return null;
	if (suffix.allChildren.some((part) => part.type === 'annotated_lambda')) return null;
	const args = kids(suffix).find((part) => part.type === 'value_arguments');
	if (args !== undefined && kids(args).length > 0) return null;
	const [inner, step] = kids(callee);
	if (step?.type !== 'navigation_suffix' || step.text !== `.${name}`) return null;
	return inner ?? null;
}

/**
 * The block of `x.use { … }`, `x.let { … }` or `x.run { … }`, the receiver
 * written or implicit — the scope functions whose value is the block's last
 * expression — or null. Only a call whose single argument is that trailing
 * block, so `let(::f)` and a `use` with parentheses are not read as one.
 */
const VALUE_SCOPE_FUNCTIONS: ReadonlySet<string> = new Set(['use', 'let', 'run']);
function valueScopeBlock(call: KNode): KNode | null {
	const [callee, suffix] = kids(call);
	if (suffix?.type !== 'call_suffix' || kids(suffix).length !== 1) return null;
	const name =
		callee?.type === 'simple_identifier'
			? callee.text
			: callee?.type === 'navigation_expression'
				? kids(kids(callee)[1] ?? callee)[0]?.text
				: undefined;
	// Bare is the implicit receiver's: `fun String.parseAs(): T = let { … }`.
	if (name === undefined || !VALUE_SCOPE_FUNCTIONS.has(name)) return null;
	const lambda = kids(kids(suffix)[0])[0];
	return kids(suffix)[0].type === 'annotated_lambda' && lambda?.type === 'lambda_literal'
		? lambda
		: null;
}

/** See `ReceiverSlots`. Null for a function with no function-typed parameter. */
function receiverSlots(node: KNode): ReceiverSlots | null {
	const list = kids(node).find((child) => child.type === 'function_value_parameters');
	const parameters = kids(list).filter((child) => child.type === 'parameter');
	if (!parameters.some((parameter) => parameterFunctionType(parameter) !== null)) return null;
	const at: number[] = [];
	const names: string[] = [];
	parameters.forEach((parameter, index) => {
		if (receiverArity(parameter) === null) return;
		at.push(index);
		const name = kids(parameter).find((child) => child.type === 'simple_identifier')?.text;
		if (name !== undefined) names.push(name);
	});
	return { count: parameters.length, at, names };
}

/**
 * `@Contextual` on a property: kotlinx asks the Json's `serializersModule` for
 * the serializer, which this runtime does not have. It asks only when the
 * payload carries the key — one source's `@Contextual private val sdf =
 * SimpleDateFormat(…)` never arrives, and its initialiser is what runs — so
 * the field is registered with this marker in its serializer slot, and the
 * runtime refuses by name only if the key is actually there.
 */
const CONTEXTUAL = /@Contextual\b/;
const CONTEXTUAL_FIELD = '@Contextual';

/** Every table of call names the runtime answers. See the end of `bareCall`. */
const RUNTIME_KNOWN_CALLS: readonly { has(name: string): boolean }[] = [
	EXTENSION_METHODS,
	DECODING_METHODS,
	FREE_FUNCTIONS,
	HOST_METHODS,
	HOST_PROPERTY_METHODS,
	SUPER_MEMBERS,
	GLOBAL_NAMES,
	BASE_SOURCE_MEMBERS
];

/** `@Serializable(X::class)` and `@Serializable(with = X::class)`, naming X. */
const SERIALIZER_ANNOTATION = /@Serializable\s*\(\s*(?:with\s*=\s*)?([\w.]+)::class\s*\)/;

/**
 * A declared Kotlin type as the typed decoder reads it: no whitespace, no
 * variance, no annotations — except `@Serializable(X::class)` on a type
 * argument, which is written `@X|` in front of the type it applies to.
 */
function serialType(text: string): string {
	return text
		.replace(new RegExp(SERIALIZER_ANNOTATION, 'g'), '\u0000$1\u0001')
		.replace(/@[\w.]+(?:\s*\([^()]*\))?/g, '')
		.replace(/\b(?:out|in)\s+(?=[A-Za-z_*])/g, '')
		.replace(/\s+/g, '')
		.replace(/,>/g, '>')
		.replace(/\u0000([\w.]+)\u0001/g, '@$1|');
}

/**
 * The type a serializer built only from kotlinx's defaults decodes, or null.
 *
 * `ListSerializer(Item.serializer())` is `List<Item>`, `MapSerializer(a, b)`
 * is `Map<A, B>`, `X.serializer().nullable` is `X?`. Anything else — a
 * hand-written serializer, a polymorphic one — decodes something only its own
 * code knows, and answers null.
 */
function defaultSerializerType(text: string): string | null {
	const nullable = /^(.*)\.nullable$/.exec(text);
	if (nullable !== null) {
		const inner = defaultSerializerType(nullable[1]);
		return inner === null ? null : `${inner}?`;
	}
	const own = /^([A-Za-z_][\w.]*)\.serializer\(\)$/.exec(text);
	if (own !== null) return own[1].replace(/^.*\./, '');
	const generic = /^serializer<(.+)>\(\)$/.exec(text);
	if (generic !== null) return serialType(generic[1]);
	const call = /^(ListSerializer|SetSerializer|MapSerializer)\((.*)\)$/.exec(text);
	if (call === null) return null;
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let at = 0; at < call[2].length; at += 1) {
		const ch = call[2][at];
		if (ch === '(' || ch === '<') depth += 1;
		else if (ch === ')' || ch === '>') depth -= 1;
		else if (ch === ',' && depth === 0) {
			parts.push(call[2].slice(start, at));
			start = at + 1;
		}
	}
	parts.push(call[2].slice(start));
	const types = parts.filter((part) => part.length > 0).map(defaultSerializerType);
	if (types.some((type) => type === null)) return null;
	if (call[1] === 'MapSerializer') return types.length === 2 ? `Map<${types.join(',')}>` : null;
	if (types.length !== 1) return null;
	return `${call[1] === 'ListSerializer' ? 'List' : 'Set'}<${types[0]}>`;
}

/**
 * The first custom serializer a `@Serializable(X::class)` names anywhere in this
 * class's own declaration, and where, or null. See `classDeclaration`.
 *
 * Four placements, all measured in the catalogue: on the class itself, on a
 * constructor property (the common one), on a property in the body, and on a
 * type argument — `List<@Serializable(RankingMangaSerializer::class) Ranking>`,
 * which reshapes each element rather than the list. A nested class is its own
 * declaration and answers for itself, so the walk stops at one.
 */
function customSerializer(node: KNode): { name: string; placement: string } | null {
	const named = (text: string | undefined) => text?.match(SERIALIZER_ANNOTATION)?.[1] ?? null;

	const own = named(kids(node).find((child) => child.type === 'modifiers')?.text);
	if (own !== null) return { name: own, placement: 'on the class' };

	const header = kids(node).find((child) => child.type === 'primary_constructor');
	for (const parameter of kids(header)) {
		if (parameter.type !== 'class_parameter') continue;
		const found = named(kids(parameter).find((part) => part.type === 'modifiers')?.text);
		if (found !== null) return { name: found, placement: 'on a property' };
	}
	const body = kids(node).find((child) => child.type === 'class_body');
	for (const member of kids(body)) {
		if (member.type !== 'property_declaration') continue;
		const found = named(kids(member).find((part) => part.type === 'modifiers')?.text);
		if (found !== null) return { name: found, placement: 'on a property' };
	}
	if (header !== undefined) {
		for (const child of walk(header)) {
			if (child.type !== 'type_projection') continue;
			const found = named(kids(child).find((part) => part.type === 'type_modifiers')?.text);
			if (found !== null) return { name: found, placement: 'on a type argument' };
		}
	}
	return null;
}

/** True for a `?.name` step, which reads through a null rather than failing on it. */
function isSafeStep(node: KNode): boolean {
	return node.type === 'navigation_suffix' && node.allChildren[0]?.type === '?.';
}

/**
 * Every identifier under a node, deduplicated.
 *
 * Type names are included along with expression names: a member that
 * mentions `PlaylistUtils` only as a declared type still needs it to exist.
 */
function mentions(node: KNode): string[] {
	const found = new Set<string>();
	for (const child of walk(node)) {
		if (child.type === 'simple_identifier' || child.type === 'type_identifier') {
			found.add(child.text);
		}
	}
	return [...found];
}

/**
 * Extract the names a member invokes, separately from incidental identifiers.
 *
 * The receiver is intentionally only classified, not resolved: a call through
 * `loader().readEpisodes()` must keep `readEpisodes` in the closure even when
 * the type of `loader()` is outside this source set. Dropping that edge would
 * turn a real runtime failure into an apparently complete bundle.
 */
/**
 * The optional `<Type>` between a call's name and its arguments.
 *
 * Without it, `filters.parseCheckbox<GenreFilter>(…)` recorded no edge at all:
 * the refused helper looked unreachable, the caller was not blocked, and the
 * bundle shipped a call to a function that is not there —
 * `AnimesGamesFilters.parseTriFilter is not a function`, on the first search,
 * out of a conversion that reported nothing refused. One level of nesting,
 * because `decodeFromString<List<Item>>` is written in this ecosystem and a
 * pattern that reached further would start matching comparisons.
 */
const TYPE_ARGUMENTS = '(?:<[^<>()]*(?:<[^<>()]*>[^<>()]*)*>\\s*)?';

function callEdges(node: KNode): CallEdge[] {
	const found = new Map<string, boolean>();
	const inert = new Set<KNode>();
	for (const child of walk(node)) {
		// `.addInterceptor(::checkForToken)` calls `checkForToken` as surely as
		// `checkForToken(chain)` does — later, from the client, on every request.
		// It is not a `call_expression`, so it drew no edge, and the member
		// behind it was pruned as unreachable along with everything *it*
		// called. LibGroup's refused `refreshToken` (a WebView login) went
		// that way: the bundle reported complete, loaded, and threw
		// `this.refreshToken is not a function` on the first request.
		// Not `::filterElements.isInitialized`, which asks whether a `lateinit`
		// has been written and calls nothing.
		if (child.type === 'navigation_expression' && /\.\s*isInitialized$/.test(child.text)) {
			const reference = kids(child)[0];
			if (reference?.type === 'callable_reference') inert.add(reference);
		}
		if (child.type === 'callable_reference' && !inert.has(child)) {
			const target = kids(child).findLast((part) => part.type === 'simple_identifier');
			if (target !== undefined) found.set(target.text, found.get(target.text) ?? false);
			continue;
		}
		if (child.type !== 'call_expression') continue;
		const text = child.text;
		const dotted = new RegExp(`\\.\\s*([A-Za-z_]\\w*)\\s*${TYPE_ARGUMENTS}\\(`, 'g');
		let match: RegExpExecArray | null;
		let foundDotted = false;
		while ((match = dotted.exec(text)) !== null) {
			foundDotted = true;
			const name = match[1];
			const prefix = text.slice(0, match.index).trimEnd();
			const receiverIsNamed = /[A-Za-z_]\w*$/.test(prefix);
			found.set(name, (found.get(name) ?? false) || !receiverIsNamed);
		}
		if (foundDotted) continue;
		const target = new RegExp(`([A-Za-z_]\\w*)\\s*${TYPE_ARGUMENTS}\\(`).exec(text)?.[1];
		if (target !== undefined && !/^(if|for|while|when|catch)$/.test(target)) {
			found.set(target, true);
		}
	}
	return [...found].map(([member, unresolvedReceiver]) => ({
		member,
		unresolvedReceiver
	}));
}

/**
 * The identifier a `variable_declaration` binds, without its type annotation.
 *
 * Kotlin lets a lambda annotate its parameter — `{ element: Element -> … }` —
 * and the annotation is part of the declaration node's own text. Passing that
 * text through gives `(element: Element) => …`, a JavaScript `SyntaxError` that
 * does not surface until the bundle is imported, where it takes every member
 * with it rather than the one that was written oddly. Nothing downstream reads
 * the type, so it is dropped rather than refused.
 */
/** True for a declaration that comes out as an ES6 `class` and needs `new`. */
function isNewable(node: KNode): boolean {
	if (node.type !== 'class_declaration') return false;
	const kinds = new Set(node.allChildren.map((child) => child.type));
	if (kinds.has('interface') || kinds.has('enum_class_body')) return false;
	const modifiers = kids(kids(node).find((child) => child.type === 'modifiers'));
	return !modifiers.some((child) => child.text === 'data');
}

function boundName(node: KNode): string {
	return node.children[0]?.text ?? node.text;
}

/**
 * A call with a trailing lambda, unwound the way `flatten` unwinds one.
 *
 * `with(x) { … }` parses as a call whose callee is a call — one suffix for the
 * parentheses and one for the block — so a reader that takes the first two
 * children sees a `call_expression` where the function's name should be. Two
 * argument *lists* mean `f(a)(b)`, whose signature is unknowable, and a type
 * argument means a call this has no business recognising; both answer null and
 * take the ordinary path, where they are refused by name.
 */
function unwindCall(
	node: KNode
): { callee: KNode; args: KNode[]; lambda: KNode; label: string } | null {
	if (node.type !== 'call_expression') return null;
	const suffixes: KNode[] = [];
	let current = node;
	while (current.type === 'call_expression') {
		const suffix = kids(current)[1];
		const inner = kids(current)[0];
		if (suffix === undefined || inner === undefined) return null;
		suffixes.unshift(suffix);
		current = inner;
	}

	let args: KNode[] | null = null;
	let lambda: KNode | null = null;
	let label = '';
	for (const suffix of suffixes) {
		if (kids(suffix).some((child) => child.type === 'type_arguments')) return null;
		const values = kids(suffix).find((child) => child.type === 'value_arguments');
		if (values !== undefined) {
			if (args !== null) return null;
			args = kids(values).filter((child) => child.type === 'value_argument');
		}
		const annotated = kids(suffix).find((child) => child.type === 'annotated_lambda');
		if (annotated !== undefined) {
			label = (kids(annotated).find((child) => child.type === 'label')?.text ?? '').replace(
				/@$/,
				''
			);
			lambda = kids(annotated).find((child) => child.type === 'lambda_literal') ?? lambda;
		} else {
			lambda = kids(suffix).find((child) => child.type === 'lambda_literal') ?? lambda;
		}
	}

	if (lambda === null) return null;
	return { callee: current, args: args ?? [], lambda, label };
}

/**
 * The block of a bare `runCatching { … }`, when this expression is one.
 *
 * The receiver form, `x.runCatching { … }`, is deliberately not matched: it
 * binds `this` to `x`, and the two are different constructs.
 */
function runCatchingOf(node: KNode): KNode | null {
	const unwound = unwindCall(node);
	if (unwound === null) return null;
	if (unwound.callee.type !== 'simple_identifier' || unwound.callee.text !== 'runCatching') {
		return null;
	}
	return unwound.args.length === 0 ? unwound.lambda : null;
}

/**
 * The members the runtime's `Result` declares, and nothing else.
 *
 * `onSuccess` and `onFailure` are absent on purpose: the runtime does not have
 * them, and a passthrough onto an object that does not is the fallback this
 * file's header refuses.
 */
const RESULT_MEMBERS: ReadonlySet<string> = new Set([
	'getOrNull',
	'getOrThrow',
	'getOrElse',
	'getOrDefault',
	'exceptionOrNull'
]);

/** The `{ … }` written after a call's parentheses, if there is one. */
function trailingLambda(suffix: KNode): KNode | null {
	if (suffix.type !== 'call_suffix') return null;
	const annotated = kids(suffix).find((child) => child.type === 'annotated_lambda');
	if (annotated !== undefined) {
		return kids(annotated).find((child) => child.type === 'lambda_literal') ?? null;
	}
	return kids(suffix).find((child) => child.type === 'lambda_literal') ?? null;
}

/** The value inside a `value_argument`, without refusing on the way. */
function argumentOf(node: KNode): KNode | null {
	if (node.type !== 'value_argument') return node;
	const parts = kids(node);
	return parts[parts.length - 1] ?? null;
}

/**
 * Whether a block contains a jump that leaves it.
 *
 * The whole gate on inlining, and the reason it is *syntactic*: a bare `return`
 * anywhere under a Kotlin lambda returns from the enclosing function, however
 * many further lambdas it sits inside, and a bare `break` or `continue` with no
 * loop of its own between it and the block edge would have to cross the same
 * boundary. An `anonymous_function` — `fun(x) { return y }` — is the one thing
 * that stops the walk: it has a `return` of its own.
 *
 * Over-answering true costs nothing: the block is then inlined, and an inlined
 * block that did not need to be produces the same value. Under-answering leaves
 * a `return` inside a callback, which is the silent wrongness this exists for,
 * so the walk descends into nested lambdas rather than stopping at them.
 */
function crossesBlock(lambda: KNode, ownLabel: string): boolean {
	let found = false;

	const visit = (node: KNode, loops: number, nested: number): void => {
		if (found || node.type === 'anonymous_function') return;
		if (node.type === 'jump_expression') {
			const text = node.text.trim();
			const label = /^(?:return|break|continue)@(\w+)/.exec(text)?.[1] ?? null;
			if (label === null) {
				if (/^return\b/.test(text)) found = true;
				else if (loops === 0 && /^(?:break|continue)\b/.test(text)) found = true;
			} else if (nested === 0 && label !== ownLabel) {
				// `SAnime.create().apply { title = x ?: return@mapNotNull null }`
				// — a labelled return naming something *outside* this block. Left
				// as a callback the label has no frame to name and the member is
				// refused; inlined, the label reaches the lambda it was written
				// for. Only counted at the top level of this block, because a
				// label written inside a further lambda usually names that one.
				found = true;
			}
			if (found) return;
		}
		// A nested lambda's own loops are not this block's, so the count resets.
		const deeper =
			node.type === 'lambda_literal' ? 0 : LOOP_KINDS.has(node.type) ? loops + 1 : loops;
		const inner = node.type === 'lambda_literal' ? nested + 1 : nested;
		for (const child of node.children) visit(child, deeper, inner);
	};

	for (const child of lambda.children) visit(child, 0, 0);
	return found;
}

const LOOP_KINDS: ReadonlySet<string> = new Set([
	'for_statement',
	'while_statement',
	'do_while_statement'
]);

/* ── hoisting `?: return` out of an expression ────────────────────────────── */

/**
 * Kinds between a guard and its statement that make the guard *conditional*.
 *
 * Kotlin runs `x ?: return` only when control reaches it. Hoisting it to
 * statement level runs it unconditionally, so anything that can decide not to
 * evaluate its children — a short-circuit, a branch, a loop, a callback — stops
 * the hoist. The whole subtree is barred rather than just the conditional half:
 * `&&`'s left operand and `if`'s condition really are unconditional, but the
 * catalogue puts no guards there, and a rule with no exceptions is one that
 * cannot be got subtly wrong later.
 *
 * A branch body or a lambda body is *not* lost by this: each opens its own
 * statement list and therefore its own frame, where its guards are weighed
 * against that statement instead.
 */
const GUARD_BARRIER_KINDS: ReadonlySet<string> = new Set([
	'conjunction_expression',
	'disjunction_expression',
	'if_expression',
	'when_expression',
	'when_entry',
	'try_expression',
	'lambda_literal',
	'anonymous_function',
	'object_literal',
	'object_declaration',
	'class_declaration',
	'function_declaration',
	'for_statement',
	'while_statement',
	'do_while_statement'
]);

/**
 * Kinds whose evaluation nothing can observe being moved across.
 *
 * A guard hoisted to statement level evaluates its left-hand side *before*
 * everything that was written ahead of it, so everything ahead of it has to be
 * a name, a literal, a field read, or a wrapper around those. A call, an index,
 * a cast, a `!!` or an infix function are all left out — not only because they
 * can have effects, but because they can throw, and Kotlin would have thrown
 * before running the guard's left-hand side at all.
 *
 * The default is deliberately the other way round: a kind nobody listed counts
 * as an effect, so a grammar upgrade that introduces one refuses a hoist rather
 * than silently permitting it.
 */
const INERT_KINDS: ReadonlySet<string> = new Set([
	// names and literals
	'simple_identifier',
	'type_identifier',
	'this_expression',
	'super_expression',
	'integer_literal',
	'real_literal',
	'long_literal',
	'hex_literal',
	'bin_literal',
	'unsigned_literal',
	'boolean_literal',
	'character_literal',
	'null',
	'callable_reference',
	// string literals, and the pieces the grammar splits them into
	'string_literal',
	'line_string_literal',
	'multi_line_string_literal',
	'line_str_text',
	'multi_line_str_text',
	'character_escape_seq',
	'interpolated_identifier',
	'interpolated_expression',
	// wrappers that do nothing of their own
	'parenthesized_expression',
	'value_arguments',
	'value_argument',
	'call_suffix',
	'annotated_lambda',
	'type_arguments',
	'navigation_expression',
	'navigation_suffix',
	'elvis_expression',
	'property_declaration',
	'variable_declaration',
	'binding_pattern_kind',
	'modifiers',
	'annotation',
	'statements',
	'control_structure_body',
	// arithmetic and comparison over inert operands stays inert
	'additive_expression',
	'multiplicative_expression',
	'comparison_expression',
	'equality_expression',
	'range_expression'
]);

/**
 * The `?: return` guards inside one statement that may be hoisted in front of
 * it, decided before anything is emitted.
 *
 * Two conditions, and both failures produce a wrong *value* rather than an
 * error, which is why they are checked here rather than trusted to look right:
 *
 * 1. **Nothing evaluated before the guard may have an effect.** Hoisting moves
 *    the guard's left-hand side ahead of everything written before it, so if
 *    any of that ran, wrote, or threw, the statement no longer means what it
 *    said. `INERT_KINDS` is the allowlist; the walk applies a node's own effect
 *    *after* its children, because a call happens after its arguments do —
 *    which is what makes `f(g(x ?: return))` hoistable and
 *    `f(g(), x ?: return)` not.
 * 2. **Nothing between the guard and the statement may be conditional.** See
 *    `GUARD_BARRIER_KINDS`, plus the safe call: `a?.f(x ?: return)` never
 *    evaluates `x` when `a` is null.
 *
 * The two shapes this exists for are `Track(fixUrl(sub) ?: return@mapNotNull
 * null, lang)` and `host + (Regex(…).find(html)?.value ?: return null)`: in
 * both, the only thing ahead of the guard is a name.
 */
/**
 * `x.ifEmpty { return@mapNotNull null }` — the same shape as `x ?: return`.
 *
 * `ifEmpty` and `ifBlank` are *inline* in Kotlin, so a `return@mapNotNull`
 * written inside one returns from the enclosing `mapNotNull` lambda and is
 * perfectly ordinary code. Emitted as a callback there is a JavaScript function
 * in between, and the jump would return from that instead — so it was refused
 * as a `return@…` crossing a lambda, correctly, because the alternative was a
 * member that quietly produced a different value.
 *
 * Read as a guard, the callback disappears and the jump lands where it was
 * written:
 *
 *     const __g = x;
 *     if (__k.isEmpty(__g)) return null;
 *
 * Narrow on purpose. Only a block whose *whole body* is the jump qualifies: a
 * block that also computes something is a value this cannot hoist, and one that
 * ends in a value rather than a jump is the ordinary `ifEmpty` the helper
 * already handles.
 */
function emptyGuard(
	node: KNode
): { value: KNode; jump: KNode; detached?: KNode; test: string } | null {
	if (node.type !== 'call_expression') return null;
	const callee = kids(node)[0];
	if (callee === undefined || callee.type !== 'navigation_expression') return null;

	const suffix = kids(callee)[kids(callee).length - 1];
	const member = kids(suffix).find((child) => child.type === 'simple_identifier')?.text ?? null;
	if (member !== 'ifEmpty' && member !== 'ifBlank') return null;

	// The trailing lambda, which the grammar wraps in a call suffix and often an
	// annotated lambda as well. Searched inside the *suffix* only, so a lambda
	// that merely appears in the receiver is not mistaken for this call's block.
	const trailing = kids(node).find((child) => child.type === 'call_suffix');
	if (trailing === undefined) return null;
	const lambda = [...walk(trailing)].find((child) => child.type === 'lambda_literal');
	if (lambda === undefined) return null;

	const body = kids(lambda).find((child) => child.type === 'statements') ?? lambda;
	const statements = kids(body).filter((child) => child.type !== 'lambda_parameters');
	const jump = statements[0];
	if (jump === undefined || jump.type !== 'jump_expression') return null;

	// The same split `rejoinJumps` repairs at statement level: the grammar cuts
	// `return emptyList()` into a valueless jump and a sibling call, so a body
	// that *is* one jump arrives here as two statements. Requiring exactly one
	// therefore rejected `ifEmpty { return emptyList() }` while accepting
	// `ifEmpty { return listOf(x) }` — the block was emitted as a callback and
	// the whole member refused, for a difference the author never wrote. The
	// pairing rule is `rejoinJumps`': the jump carries nothing of its own and
	// its value is the sibling beginning on the same line.
	const detached =
		statements.length === 2 &&
		kids(jump).every((part) => part.type === 'label') &&
		/^(?:return|throw)\b/.test(jump.text.trim()) &&
		statements[1].line === jump.line
			? statements[1]
			: undefined;
	if (statements.length !== 1 && detached === undefined) return null;

	const value = kids(callee)[0];
	if (value === undefined) return null;
	return {
		value,
		jump,
		detached,
		test: member === 'ifEmpty' ? 'isEmpty' : 'isBlank'
	};
}

/**
 * `x.let { it ?: return emptyList() }` — a null guard wearing a scope function.
 *
 * `let` binds its receiver to `it` and yields whatever the block yields, so a
 * block whose whole body is `it ?: <jump>` yields `x` when `x` is non-null and
 * jumps when it is not. That is `x ?: <jump>` exactly, and reading it as one
 * puts the jump where it was written instead of inside a JavaScript callback it
 * cannot leave.
 *
 * This is worth recognising rather than leaving to the inlining path because
 * the idiom appears mid-chain — `body.string().takeIf { … }.let { it ?: return
 * emptyList() }.substringAfter(…)` is one shared extractor, copied across a
 * whole repository — and inlining a block whose value the rest of the chain
 * consumes would mean hoisting the chain, while reading it as a guard needs
 * only what `hoistedGuard` already does.
 *
 * Narrow in the three ways that make it exact:
 *
 * - **`.let`, never `?.let`.** `x?.let { … }` skips the block when `x` is null,
 *   so the jump is precisely what it does *not* do — reading it as a guard
 *   would return where Kotlin yields null.
 * - **The implicit `it`.** A block that names its parameter may shadow, and a
 *   guard on something other than the receiver is not this shape.
 * - **The whole body, and only the guard.** A block that also computes
 *   something has a value this cannot stand in for.
 */
function letGuard(node: KNode): { value: KNode; jump: KNode; detached?: KNode } | null {
	if (node.type !== 'call_expression') return null;
	const callee = kids(node)[0];
	if (callee === undefined || callee.type !== 'navigation_expression') return null;

	const suffix = kids(callee)[kids(callee).length - 1];
	if (suffix === undefined || suffix.type !== 'navigation_suffix') return null;
	// `?.let` is a different function: it never runs the block for a null
	// receiver, so the jump inside is unreachable exactly when the guard would
	// have fired.
	if (suffix.allChildren[0]?.type === '?.') return null;
	if (kids(suffix).find((child) => child.type === 'simple_identifier')?.text !== 'let') return null;

	const trailing = kids(node).find((child) => child.type === 'call_suffix');
	if (trailing === undefined) return null;
	const lambda = [...walk(trailing)].find((child) => child.type === 'lambda_literal');
	if (lambda === undefined) return null;
	// A named parameter is not the implicit `it` this reads, and a block that
	// renames its subject may be guarding something else entirely.
	if (kids(lambda).some((child) => child.type === 'lambda_parameters')) return null;

	const body = kids(lambda).find((child) => child.type === 'statements') ?? lambda;
	const statements = kids(body);
	const elvis = statements[0];
	if (elvis === undefined || elvis.type !== 'elvis_expression') return null;

	const subject = kids(elvis)[0];
	const jump = kids(elvis)[1];
	if (subject === undefined || subject.type !== 'simple_identifier' || subject.text !== 'it') {
		return null;
	}
	if (jump === undefined || jump.type !== 'jump_expression') return null;

	// The grammar's `return emptyList()` split, the same one `rejoinJumps` and
	// `emptyGuard` repair: the jump carries nothing and its value is the
	// sibling that begins on its line.
	const bare =
		kids(jump).every((part) => part.type === 'label') &&
		/^(?:return|throw)\b/.test(jump.text.trim());
	const detached =
		statements.length === 2 && bare && statements[1].line === jump.line ? statements[1] : undefined;
	if (statements.length !== 1 && detached === undefined) return null;

	const value = kids(callee)[0];
	if (value === undefined) return null;
	return { value, jump, detached };
}

function hoistableGuards(root: KNode): ReadonlySet<KNode> {
	const out = new Set<KNode>();

	/** Visits in evaluation order; answers whether an effect has happened by then. */
	const visit = (node: KNode, blocked: boolean, effects: boolean): boolean => {
		// `x.ifEmpty { return@map null }` guards its statement exactly as
		// `x ?: return` does, and hoists under the same two conditions.
		const empty = emptyGuard(node);
		if (empty !== null) {
			if (!blocked && !effects) out.add(node);
			const after = visit(empty.value, blocked, effects);
			visit(empty.jump, true, after);
			return after;
		}

		// `x.let { it ?: return … }` is `x ?: return …`, and moves under the
		// same two conditions for the same reasons.
		const guarded = letGuard(node);
		if (guarded !== null) {
			if (!blocked && !effects) out.add(node);
			const after = visit(guarded.value, blocked, effects);
			visit(guarded.jump, true, after);
			return after;
		}

		const fallback = node.type === 'elvis_expression' ? kids(node)[1] : undefined;
		if (fallback !== undefined && fallback.type === 'jump_expression') {
			if (!blocked && !effects) out.add(node);
			const value = kids(node)[0];
			const after = value === undefined ? effects : visit(value, blocked, effects);
			// The jump is the branch not taken on the way through, so a guard
			// written inside it is never a guard this statement always reaches.
			visit(fallback, true, after);
			return after;
		}

		if (GUARD_BARRIER_KINDS.has(node.type)) {
			for (const child of kids(node)) visit(child, true, true);
			return true;
		}

		// `a?.b.c(x)` evaluates the arguments only when `a` is not null. The
		// receiver chain is checked rather than the whole node, so a `?.` that
		// merely appears *inside* an argument does not bar its siblings.
		const callee = node.type === 'call_expression' ? kids(node)[0] : undefined;
		const conditional = callee !== undefined && hasSafeCall(callee);

		let seen = effects;
		for (const child of kids(node)) {
			seen = visit(child, blocked || (conditional && child !== callee), seen);
		}
		return seen || !INERT_KINDS.has(node.type);
	};

	visit(root, false, false);
	return out;
}

/**
 * A bare `return`/`throw` that is the whole body of a branch, whose value the
 * grammar left outside the branch. See `rejoinJumps`.
 */
function danglingBranchJump(node: KNode): KNode | null {
	if (node.type !== 'if_expression') return null;
	let found: KNode | null = null;
	for (const child of kids(node)) {
		if (child.type !== 'control_structure_body') continue;
		const only = kids(child);
		const jump = only.length === 1 ? only[0] : undefined;
		if (jump === undefined || jump.type !== 'jump_expression') continue;
		if (!kids(jump).every((part) => part.type === 'label')) continue;
		if (!/^(?:return|throw)\b/.test(jump.text.trim())) continue;
		found = jump;
	}
	return found;
}

/** Whether a call's receiver chain is a `?.`, which makes the call conditional. */
function hasSafeCall(node: KNode): boolean {
	for (const found of walk(node)) {
		if (found.type !== 'navigation_suffix' && found.type !== 'indexing_suffix') continue;
		if (found.allChildren[0]?.type === '?.') return true;
	}
	return false;
}

function safeName(name: string): string {
	// Kotlin lets an identifier be written in backticks — `\`info-src\``, and
	// `\`fun\`` for a name that is a keyword there. The backticks are quoting,
	// not part of the name, and leaving them in emits a template string.
	const bare = fieldName(name);
	// A backticked name is often one JavaScript cannot spell at all —
	// `\`info-src\`` is a DTO field whose JSON key carries a hyphen. As a
	// *binding* it becomes `info_src`; the key it decodes from keeps the real
	// spelling, which is what `fieldName` is for.
	const usable = JS_IDENTIFIER.test(bare) ? bare : bare.replace(/[^\w$]/g, '_');
	// `__` is the emitter's own prefix; a Kotlin identifier using it would
	// shadow `__self` or `__k`, and that failure would be a wrong value.
	return RESERVED.has(usable) || usable.startsWith('__') ? `${usable}_` : usable;
}

/**
 * A declared name with its Kotlin quoting removed, and nothing else changed.
 *
 * This is the name the *data* carries — a serialised field key, a property on
 * a parsed object — as against `safeName`, which answers what JavaScript will
 * accept as a binding. Emitting the backticks into the key produced
 * `"\`info-src\`": info-src`, a field no payload has ever had.
 */
function fieldName(name: string): string {
	return /^`.*`$/.test(name) ? name.slice(1, -1) : name;
}

/** A name JavaScript will take after a dot. Anything else needs brackets. */
const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Emitted declarations, reordered so a class never extends one below it.
 *
 * Kotlin does not care where a base class sits in a file, and this ecosystem
 * writes the specific filter above the `open class UriPartFilter` it extends.
 * JavaScript does care: a `class` binding is in its temporal dead zone until
 * its own declaration runs, so `class GenreFilter extends UriPartFilter` placed
 * first throws "Cannot access 'UriPartFilter' before initialization" while the
 * *module* is evaluating — which takes the whole bundle down at load, names
 * JavaScript rather than the extension, and happens after conversion said the
 * extension was fine.
 *
 * A stable topological pass rather than a general sort: a piece moves only when
 * something it extends is still to come, so everything else keeps the order it
 * was written in. A cycle — which Kotlin would not have compiled — is left
 * alone rather than resolved arbitrarily.
 */
/**
 * As much of a module-scope binding as runs when the module is loaded.
 *
 * Everything from the first `function` or `=>` onward is a body that runs when
 * something calls it, which for ordering purposes is never. Keeping it would
 * invent cycles out of the ordinary shape where an object's method reads a
 * constant declared above the object — `TextInterceptorHelper.createUrl` reads
 * `HOST`, and `HOST` is `TextInterceptorHelper.HOST` — which Kotlin allows
 * because an `object` initialises on first access, and which has one correct
 * order in JavaScript that a false cycle would refuse to find.
 *
 * String literals go first, so a quoted `"HOST"` is not read as the name.
 */
function eagerPart(piece: string): string {
	const withoutStrings = piece.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, "''");
	const body = /\bfunction\b|=>/.exec(withoutStrings);
	return body === null ? withoutStrings : withoutStrings.slice(0, body.index);
}

function orderClasses(pieces: readonly string[]): string[] {
	if (pieces.length < 2) return [...pieces];

	const declares = pieces.map((piece) => {
		const names = new Set<string>();
		for (const match of piece.matchAll(/^(?:async\s+)?(?:class|function|const|let)\s+([\w$]+)/gm)) {
			names.add(match[1]);
		}
		return names;
	});
	const needs = pieces.map((piece, index) => {
		const wanted = new Set<string>();
		for (const match of piece.matchAll(/^class\s+[\w$]+\s+extends\s+([\w$]+)/gm)) {
			wanted.add(match[1]);
		}

		// A `class` or `function` is hoisted and its body is not run, so only its
		// base has to exist yet. A module-scope `const` is neither: its
		// initialiser runs at load, in the order these pieces are emitted, and a
		// name it reaches for is in its temporal dead zone until then.
		//
		// `private val popular = FilterList(SortFilter("popular"))` at file scope
		// beside `class SortFilter` is ordinary Kotlin — a file-scope `val` and a
		// class in one file, with no order between them — and it came out as
		// `Cannot access 'SortFilter' before initialization`, at load, with
		// nothing refused. Every identifier is added rather than only the
		// constructed ones: a name inside a lambda in there does not need to
		// exist yet, so `eagerPart` cuts the piece off at the first function it
		// contains — asking for slightly more order than strictly needed is
		// harmless, but asking for a name that is only read *later* invents a
		// cycle, and a cycle falls back to source order and fixes nothing.
		if (/^(?:const|let)\s/m.test(piece)) {
			for (const match of eagerPart(piece).matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
				if (!declares[index].has(match[1])) wanted.add(match[1]);
			}
		}
		return wanted;
	});

	const remaining = pieces.map((_, index) => index);
	const settled = new Set<string>();
	const out: string[] = [];
	while (remaining.length > 0) {
		let chosen = remaining.findIndex((index) =>
			[...needs[index]].every(
				(base) =>
					settled.has(base) ||
					!remaining.some((other) => other !== index && declares[other].has(base))
			)
		);
		if (chosen === -1) chosen = 0;
		const [index] = remaining.splice(chosen, 1);
		for (const name of declares[index]) settled.add(name);
		out.push(pieces[index]);
	}
	return out;
}

function comma(line: string, index: number, all: readonly string[]): string {
	return index === all.length - 1 ? line : `${line},`;
}

function block(input: readonly string[]): string {
	// A declaration lifted to module scope leaves an empty statement behind.
	const lines = input.filter((line) => line.length > 0);
	if (lines.length === 0) return '{}';
	const body = lines
		.map((line) =>
			line
				.split('\n')
				.map((part) => `\t${part}`)
				.join('\n')
		)
		.join('\n');
	return `{\n${body}\n}`;
}

/**
 * The `get()` or `set()` written on a property, wherever the grammar put it.
 *
 * `val x: String get() = "…"` parses the accessor as a *child* of the property;
 * the same declaration with the `get()` on the next line parses it as the
 * property's next *sibling*. Reading only one of the two shapes refuses a
 * declaration that is spelled the ordinary way, so both are asked for here and
 * every caller passes the sibling that follows it.
 */
/** Whether an accessor names `field`, which is what gives its property a backing field. */
function namesField(accessor: KNode): boolean {
	for (const found of walk(accessor)) {
		if (found.type === 'simple_identifier' && found.text === 'field') return true;
		if (found.type === 'interpolated_identifier' && found.text === 'field') return true;
	}
	return false;
}

function accessorOf(
	node: KNode,
	next: KNode | undefined,
	kind: 'getter' | 'setter'
): KNode | undefined {
	return (
		kids(node).find((child) => child.type === kind) ?? (next?.type === kind ? next : undefined)
	);
}

/**
 * Where an interceptor's pass-through ends and its recovery begins, if it has
 * that shape. See `memberWithRecovery` for why, and for when the cut is taken.
 *
 * Read off the syntax, narrowly, because the claim it supports is narrow —
 * "every answer this guard hands back runs exactly as written":
 *
 * - `intercept` takes one parameter, the chain;
 * - a top-level `val r = chain.proceed(…)` binds the answer;
 * - a later top-level `if (…) return r`, with no `else`, whose condition reads
 *   `r` — a guard *about the answer*, handing that same answer back.
 *
 * A guard that returns `chain.proceed(…)` afresh is deliberately not one: that
 * decides which *requests* the interceptor handles, and there the tail is the
 * interceptor's purpose rather than its recovery.
 */
function recoveryCandidate(fn: KNode, owner: string): RecoveryCandidate | null {
	const list = kids(fn).find((child) => child.type === 'function_value_parameters');
	const params = kids(list).filter((child) => child.type === 'parameter');
	if (params.length !== 1) return null;
	const chain = kids(params[0]).find((child) => child.type === 'simple_identifier')?.text;
	if (chain === undefined) return null;
	const body = kids(fn).find((child) => child.type === 'function_body');
	const statements = kids(body).find((child) => child.type === 'statements');
	if (body === undefined || statements === undefined) return null;

	const answers = new Set<string>();
	const proceeds = new RegExp(`^${chain}\\s*\\.\\s*proceed\\s*\\(`);
	const lines = kids(statements);
	for (const [index, statement] of lines.entries()) {
		if (statement.type === 'property_declaration') {
			const parts = kids(statement);
			const bound = kids(parts.find((part) => part.type === 'variable_declaration'))[0]?.text;
			const value = parts[parts.length - 1];
			if (bound !== undefined && value !== undefined && proceeds.test(value.text)) {
				answers.add(bound);
			}
			continue;
		}
		const guard = passThrough(statement);
		if (guard === null || !answers.has(guard.returned)) continue;
		if (!mentions(guard.condition).includes(guard.returned)) continue;
		const tail = lines[index + 1];
		if (tail === undefined) return null;
		return {
			body,
			keep: index + 1,
			kept: [...params, ...lines.slice(0, index + 1)],
			tailLine: tail.line,
			owner
		};
	}
	return null;
}

/** `if (cond) return x` / `if (cond) { return x }`, no `else`: its parts, or null. */
function passThrough(node: KNode): { condition: KNode; returned: string } | null {
	if (node.type !== 'if_expression') return null;
	if (node.allChildren.some((child) => child.type === 'else')) return null;
	const parts = kids(node);
	if (parts.length !== 2 || parts[1].type !== 'control_structure_body') return null;
	let inner = kids(parts[1]);
	if (inner.length === 1 && inner[0].type === 'statements') inner = kids(inner[0]);
	if (inner.length !== 1 || inner[0].type !== 'jump_expression') return null;
	const jump = inner[0];
	if (!/^return\s/.test(jump.text)) return null;
	const value = kids(jump);
	if (value.length !== 1 || value[0].type !== 'simple_identifier') return null;
	return { condition: parts[0], returned: value[0].text };
}

/**
 * The receiver type of an extension property, `SharedPreferences` in `val
 * SharedPreferences.quality`, or null for an ordinary property. The grammar
 * puts the receiver's `user_type` directly under the declaration, where an
 * ordinary property's type sits inside its `variable_declaration`.
 */
function extensionReceiverOf(node: KNode): string | null {
	const parts = kids(node);
	const at = parts.findIndex((child) => child.type === 'user_type');
	const declared = parts.findIndex((child) => child.type === 'variable_declaration');
	if (at === -1 || declared === -1 || at > declared) return null;
	return typeName(parts[at]);
}

/** Whether a class lists okhttp's `Interceptor` among its supertypes. */
function implementsInterceptor(node: KNode): boolean {
	return kids(node).some(
		(child) =>
			child.type === 'delegation_specifier' && /^(?:okhttp3\.)?Interceptor$/.test(child.text.trim())
	);
}

interface RecoveryCandidate {
	/** The `function_body`, to recognise when it is reached. */
	readonly body: KNode;
	/** How many statements (`kids` of `statements`) are kept: through the guard. */
	readonly keep: number;
	/** The parameter and the kept statements: what edges and the scan read. */
	readonly kept: readonly KNode[];
	/** The first line of the tail; an obstacle on or after it is the tail's. */
	readonly tailLine: number;
	/** The class, as the error names it. */
	readonly owner: string;
}

interface RecoveryCut {
	readonly body: KNode;
	readonly keep: number;
	readonly owner: string;
	/** What the tail was refused for, in `RECOVERY_BOUNDARIES`' plain words. */
	readonly kinds: readonly string[];
}

/**
 * The receiver type of an extension function, or null for an ordinary one.
 *
 * The grammar puts it among the declaration's children *before* the name, so
 * a type seen ahead of the identifier is a receiver and one seen after it is
 * the return type.
 */
function receiverOf(node: KNode): string | null {
	for (const child of node.children) {
		if (child.type === 'simple_identifier') return null;
		if (child.type.endsWith('type')) return typeName(child);
	}
	return null;
}

/**
 * The class a declaration's written type names, when it is a bare class name:
 * `theme: AnikotoTheme` and `theme: AnikotoTheme?` both answer `AnikotoTheme`.
 *
 * Anything else answers null — a qualified `Foo.Bar`, a generic, a function
 * type — because the one use of this (`Declared.propertyTypes`) resolves a
 * member through the named class, and a guess at which class a spelling means
 * is the wrong member called.
 */
function declaredTypeName(children: readonly KNode[]): string | null {
	let type = children.find((child) => child.type === 'user_type' || child.type === 'nullable_type');
	if (type?.type === 'nullable_type') type = kids(type).find((child) => child.type === 'user_type');
	if (type === undefined) return null;
	const parts = kids(type);
	return parts.length === 1 && parts[0].type === 'type_identifier' ? parts[0].text : null;
}

/**
 * The key argument of a `var` property delegated to keiyoushi's preference
 * delegate — `var SharedPreferences.x by preferences.delegate(KEY, DEFAULT)` —
 * or null for anything else, a `val` included.
 */
function preferenceDelegateOf(node: KNode): KNode | null {
	if (!kids(node).some((child) => child.type === 'binding_pattern_kind' && child.text === 'var')) {
		return null;
	}
	const delegate = kids(node).find((child) => child.type === 'property_delegate');
	const call = kids(delegate).find((child) => child.type === 'call_expression');
	if (call === undefined || !/^[\w.]+\.delegate\s*\(/.test(call.text)) return null;
	const suffix = kids(call).find((child) => child.type === 'call_suffix');
	const passed = kids(kids(suffix).find((child) => child.type === 'value_arguments'));
	return passed.length >= 2 ? passed[0] : null;
}

/** `okhttp3.Response` as `Response` — the part an override might not spell the same. */
function simpleTypeName(written: string): string {
	const dot = written.lastIndexOf('.');
	return dot === -1 ? written : written.slice(dot + 1);
}

/** The literal a dispatcher hands `__k.overload`: mangled name, arity bounds, types. */
function overloadTable(name: string, shapes: readonly OverloadSignature[]): string {
	return JSON.stringify(
		shapes.map((shape) => [
			`${name}$${shape.key}`,
			shape.required,
			shape.total,
			shape.types,
			shape.nullable,
			shape.defaults
		])
	);
}

/** A `class` this emitter writes as a JavaScript class: not an interface, enum or data class. */
function isPlainClass(node: KNode): boolean {
	if (node.type !== 'class_declaration') return false;
	const kinds = new Set(node.allChildren.map((child) => child.type));
	if (kinds.has('interface') || kinds.has('enum_class_body')) return false;
	const modifiers = kids(node).find((child) => child.type === 'modifiers');
	return !kids(modifiers).some((modifier) => modifier.text === 'data');
}

/**
 * A type as written, whitespace dropped and generics kept — `List<Foo>?`.
 *
 * `typeName` below strips the arguments, which is right for a name and wrong
 * for a decoder: `List<Foo>` and `Foo` want different containers.
 */
function typeText(node: KNode | undefined): string | null {
	if (node === undefined || !node.type.endsWith('type')) return null;
	// A function type is not a shape anything decodes into.
	if (node.type === 'function_type') return null;
	return node.text.replace(/\s+/g, '');
}

/** A function's declared return type, written after its parameter list. */
function returnTypeText(node: KNode): string | null {
	let seenParameters = false;
	for (const child of kids(node)) {
		if (child.type === 'function_value_parameters') seenParameters = true;
		else if (seenParameters && child.type.endsWith('type')) return typeText(child);
		else if (child.type === 'function_body') return null;
	}
	return null;
}

/** An extension function's receiver type as written, generics kept. */
function receiverText(node: KNode): string | null {
	for (const child of kids(node)) {
		if (child.type === 'simple_identifier') return null;
		if (child.type.endsWith('type')) return typeText(child);
	}
	return null;
}

function isValueParameters(node: KNode): boolean {
	return node.type === 'function_value_parameters';
}

/**
 * The declared type of each value parameter, in order, or null when the list
 * has a `vararg` — past one, a position no longer names a parameter.
 */
function parameterTypesOf(list: KNode | undefined): (string | null)[] | null {
	if (list === undefined) return null;
	const out: (string | null)[] = [];
	for (const child of kids(list)) {
		if (child.type === 'parameter_modifiers' && /\bvararg\b/.test(child.text)) return null;
		if (child.type === 'class_parameter' && /\bvararg\b/.test(child.text)) return null;
		if (child.type !== 'parameter' && child.type !== 'class_parameter') continue;
		out.push(typeText(kids(child).find((part) => part.type.endsWith('type'))));
	}
	return out;
}

/** The block of `by lazy { … }`, or null for any other delegate. */
function lazyBlock(delegate: KNode): KNode | null {
	const call = kids(delegate)[0];
	if (call?.type !== 'call_expression' || kids(call)[0]?.text !== 'lazy') return null;
	const suffix = kids(call)[1];
	const annotated = kids(suffix).find((child) => child.type === 'annotated_lambda');
	return kids(annotated).find((child) => child.type === 'lambda_literal') ?? null;
}

/** Where a `return` stops belonging to the function around it. */
const EXPECTATION_BARRIERS: ReadonlySet<string> = new Set([
	'function_declaration',
	'anonymous_function',
	'class_declaration',
	'object_declaration',
	'object_literal',
	'getter',
	'setter'
]);

/** A companion member as it was written out, for `Emitter.companionStatics`. */
interface CompanionMember {
	readonly name: string;
	readonly binding: string;
	/** A `val X get() = …`, which is a function at module scope. */
	readonly getter: boolean;
	/** A `var`, whose static also writes. */
	readonly mutable?: boolean;
}

/**
 * The members every enum entry answers to that its class did not declare.
 *
 * `toPrimitive` is what makes `this >= other` compare by ordinal, as Kotlin's
 * `compareTo` does, while a string built from an entry still reads its name:
 * JavaScript asks for a *number* in a comparison and a *string* in a template
 * or a `String()`, and `+` — which in Kotlin is string concatenation on an
 * enum — asks for neither and gets the name too.
 */
function enumMethods(declared: ReadonlySet<string>): string[] {
	const out: string[] = [];
	if (!declared.has('toString')) out.push('toString() { return this.name; }');
	if (!declared.has('compareTo'))
		out.push('compareTo(other) { return this.ordinal - other.ordinal; }');
	out.push(
		"[Symbol.toPrimitive](hint) { return hint === 'number' ? this.ordinal : this.toString(); }"
	);
	return out;
}

/** What `enumTail` puts on every enum class, reachable bare inside one. */
const ENUM_STATICS: ReadonlySet<string> = new Set(['entries', 'values', 'valueOf']);

/** A function's own properties, which a companion member is not written over. */
const FUNCTION_OWN_NAMES: ReadonlySet<string> = new Set([
	'name',
	'length',
	'prototype',
	'caller',
	'arguments'
]);

/** See `Emitter.expectedTypes` for why this is not the node itself. */
function expectationKey(node: KNode): string {
	return `${node.line}:${node.type}:${node.text}`;
}

/** The name a type node carries, without its arguments or its nullability. */
function typeName(node: KNode | undefined): string {
	if (node === undefined) return 'Any';
	return node.text.replace(/[?\s]/g, '').replace(/<.*$/, '');
}

/**
 * What a refusal calls a node the emitter met and has no handler for.
 *
 * **Never the raw grammar kind.** `null`, `elvis_expression` and
 * `directly_assignable_expression` are the parser's vocabulary, not the
 * vocabulary of the person who wrote the Kotlin, and a ranked work queue full
 * of them reads as nonsense — one catalogue's largest single blocker was
 * reported, for weeks, as `null`. Worse, a raw kind hides *which* line of
 * source is at fault behind a word that could describe a hundred of them.
 *
 * So: a spoken name where there is one, and otherwise the node's own source
 * text, truncated to a line. The text is always something a reader can find in
 * their own file, which is the property that matters. `OUT_OF_SCOPE_KINDS` is
 * consulted first so the emitter and the pre-scan say the same thing about the
 * same construct.
 */
function spoken(node: KNode): string {
	const named = OUT_OF_SCOPE_KINDS.get(node.type) ?? SPOKEN_KINDS.get(node.type);
	if (named !== undefined) return named;
	const text = describe(node);
	return text.length === 0 ? `a \`${node.type}\` this build has no handler for` : `\`${text}\``;
}

/**
 * Kinds whose own text says nothing useful about why they were refused.
 *
 * Short list on purpose: quoting the source is the better answer almost
 * everywhere, and an entry here only earns its place when the text alone would
 * leave a reader guessing what the emitter objected to.
 */
const SPOKEN_KINDS: ReadonlyMap<string, string> = new Map([
	['companion_object', 'a `companion object` where a member was expected'],
	['property_delegate', 'a `by` delegate where a value was expected'],
	['function_type', 'a function type where a value was expected'],
	['super_expression', '`super` used where this build expected a value'],
	['null', 'a bare `null` where this build expected a declaration']
]);

/**
 * What can stand at the head of an assignment target.
 *
 * Measured rather than reasoned: over every source in the catalogue, a
 * `directly_assignable_expression` begins with a name, with `this`, or with a
 * parenthesised receiver, and with nothing else.
 */
const ASSIGNABLE_HEADS: ReadonlySet<string> = new Set([
	'simple_identifier',
	'this_expression',
	'parenthesized_expression'
]);

/**
 * How many of a function's value parameters have no default.
 *
 * Read off the parameter list as the grammar gives it: a `parameter` followed
 * by `=` has a default, and every other one must be supplied by the caller.
 */
function requiredParameterCount(node: KNode): number {
	const list = kids(node).find((child) => child.type === 'function_value_parameters');
	const children = list?.allChildren ?? [];
	let count = 0;
	for (const [index, child] of children.entries()) {
		if (child.type !== 'parameter') continue;
		let next = index + 1;
		while (next < children.length && COMMENT_KINDS.has(children[next].type)) next += 1;
		if (children[next]?.type !== '=') count += 1;
	}
	return count;
}

/**
 * The `reified` type parameters a function declares, in order.
 *
 * Kotlin monomorphises these at the call site; nothing survives into the
 * emitted function unless it is passed, so each becomes an argument.
 */
function reifiedParams(node: KNode): string[] {
	const declared = kids(node).find((child) => child.type === 'type_parameters');
	if (declared === undefined) return [];
	return kids(declared)
		.filter((one) => one.type === 'type_parameter')
		.filter((one) =>
			kids(one).some(
				(part) => part.type === 'type_parameter_modifiers' && /\breified\b/.test(part.text)
			)
		)
		.map((one) => kids(one).find((part) => part.type === 'type_identifier')?.text ?? '')
		.filter((one) => one.length > 0);
}

/** A name the emitter builds for itself, with nothing in it JavaScript cannot take. */
function plainName(name: string): string {
	return fieldName(name).replace(/[^\w$]/g, '_');
}

/** The argument name a reified type parameter is carried in. */
function reifiedBinding(name: string): string {
	return `__type_${name}`;
}

/** A short, single-line description of an expression, for a `!!` message. */
function describe(node: KNode | undefined): string {
	if (node === undefined) return 'value';
	const text = node.text.replace(/\s+/g, ' ').trim();
	return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

/**
 * Kotlin's escapes, decoded.
 *
 * The grammar hands back `string_content` verbatim — `\n` arrives as a
 * backslash and an `n` — so the emitter decodes before re-encoding for
 * JavaScript. Kotlin admits exactly this set; anything else is a compile error
 * in the source, so an unknown escape is passed through rather than guessed at.
 */
function decodeEscapes(text: string): string {
	return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g, (whole, escape: string) => {
		if (escape.startsWith('u')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
		return SIMPLE_ESCAPES[escape] ?? whole;
	});
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	'0': '\0',
	'\\': '\\',
	'"': '"',
	"'": "'",
	$: '$'
};

function jsString(value: string): string {
	return `'${escapeCore(value).replace(/'/g, "\\'")}'`;
}

function templateChunk(value: string): string {
	return escapeCore(value).replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/**
 * Escapes what breaks a JavaScript literal in either quoting style.
 *
 * U+2028 and U+2029 are line terminators to a JavaScript parser and ordinary
 * characters to everything that produced the HTML this text came from, so
 * leaving one raw turns a scraped title into a syntax error.
 */
function escapeCore(value: string): string {
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\t/g, '\\t')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029');

	// Kotlin spells NUL and backspace as escapes; decoding one of those and
	// writing the raw byte back out puts a control character inside a string
	// literal in the bundle, where a NUL ends the source for some readers and a
	// vertical tab is simply invisible to whoever next reads the diff.
	let out = '';
	for (const character of escaped) {
		const code = character.codePointAt(0) ?? 0;
		out += code < 0x20 || code === 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : character;
	}
	return out;
}
