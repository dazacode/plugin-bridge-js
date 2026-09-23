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
	HOST_METHODS,
	HOST_PROPERTY_METHODS,
	KNOWN_SIGNATURES,
	OUT_OF_SCOPE_KINDS,
	swallowedWhenElse,
	SUPER_BASE_PROPERTIES,
	SUPER_MEMBERS,
	SUPER_RECEIVER_MEMBERS,
	SUPER_SUSPEND_MEMBERS,
	BASE_CONSTANTS,
	ARGUMENT_LAMBDA_METHODS,
	CLASS_LOADER,
	BUILDER_LAMBDA_METHODS,
	TOLERATED_JSON_FLAGS,
	VARARG_OPTIONS,
	VIDEO_V16_ONLY,
	VIDEO_V16_PARAMETERS,
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
/** `java.net.URLEncoder`, and the other packages written out in full. */
const QUALIFIED_GLOBAL = /^(?:java|javax|kotlin|android)\.[\w.]*?\.?(\w+)$/;

/**
 * `Injekt.get<T>()`, whitespace already squeezed out of the text.
 *
 * Only the no-argument form, because that is the whole of what this ecosystem
 * writes — a keyed `Injekt.get(qualifier)` asks a different question and is
 * left to the refusal.
 */
const INJEKT_GET = /^Injekt\.get<(\w+)>\(\)$/;

/**
 * The calls that make a member `async` whether or not it said `suspend`.
 *
 * `.execute()` blocks in Kotlin and cannot here; the crypto four are
 * `AWAITED_HOST_METHODS`, which the runtime shim implements over
 * `crypto.subtle` and which are therefore promises. `blockingMembers` reads
 * this off a member's *source text* and propagates to a fixpoint, so a helper
 * that decrypts makes its callers `async` too.
 */
const BLOCKING_CALLS =
	/\.(?:execute|awaitSuccess|await|doFinal|generateKeyPair|verify)\s*\(|(?<!\bMath)\.sign\s*\(|\bThread\s*\.\s*sleep\s*\(/;

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
 * Each takes the type as its last parameter and answers "everything" without
 * one, so a dropped type is a wrong value rather than an error.
 */
const TYPED_HELPERS: ReadonlySet<string> = new Set(['filterIsInstance']);

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
}

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
	 * `class Wcofun : WcoTheme()` resolves its base, because the theme is a
	 * neighbouring file this build *does* convert, so the concrete extension
	 * declined the name and the abstract theme took it. The driver then built
	 * the theme, and every `baseUrl` the theme reads was the one the subclass
	 * never got to set — `undefined/search`.
	 *
	 * The adapter already knows which file is the extension: it sorts the
	 * class named by `build.gradle`'s `extClass` first. This carries that fact
	 * the one step further it needed to travel.
	 */
	entryFile = false
): Emission {
	return new Emitter(neighbours, renames, entryFile).file(tree.root);
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
	classFunctions: new Map()
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
	for (const part of parts) {
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
		classFunctions
	};
}

class Emitter {
	constructor(
		neighbours: Declared,
		private readonly renames: ReadonlyMap<string, string> = new Map(),
		private readonly entryFile = false
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

	private readonly scopes: Map<string, Local>[] = [];
	private readonly frames: Frame[] = [];
	private temporaries = 0;
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
	 * `private val mixdropExtractor by lazy { MixDropExtractor(client) }` is how
	 * this ecosystem keeps an extractor, and `mixdropExtractor.videoFromUrl(…)`
	 * is how it calls one — so without this the receiver is just a name and the
	 * declaring class is unknowable at the call site.
	 */
	private readonly propertyTypes = new Map<string, string>();
	/** Signatures under the class that declares them, as `Owner.method`. */
	private readonly qualifiedSignatures = new Map<string, readonly string[]>();
	/**
	 * Types declared with `object`, whose `::member` is bound and not unbound.
	 *
	 * `Obj::method` in Kotlin already has its receiver — the object — so it is
	 * the bound form. Reading it as unbound would consume the first argument as
	 * a receiver and silently drop it.
	 */
	private readonly declaredObjects = new Set<string>();
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
	/** The class or object whose members are being emitted. */
	private owner: string | null = null;
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
	private classMembers = new Set<string>();
	private suspendMembers = new Set<string>();
	private readonly signatures = new Map<string, readonly string[]>(KNOWN_SIGNATURES);
	private readonly ambiguousSignatures = new Set<string>();
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
			classFunctions: this.classFunctionIndex
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
				for (const param of this.primaryConstructorParams(child)) {
					if (param.isProperty) {
						members.add(param.name);
						fields.add(param.name);
					}
				}
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
		// Registered before anything is emitted: an extension function is
		// usually declared below the members that call it, and so is the nested
		// filter class the members above it construct.
		this.registerExtensions(kids(root), 'module');
		this.registerTypes(kids(root), true);
		this.registerSignatures(kids(root));
		this.registerExpectedTypes(root);
		this.registerImports(kids(root).find((child) => child.type === 'import_list'));

		const top = kids(root);
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
					graph: this.graph
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
			graph: this.graph
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
		if (modifiers.has('data')) return this.dataDeclaration(node, name);

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

		// A class that *constructs* an unreachable base is the extension. One
		// that merely lists an interface — `class SomethingFactory :
		// AnimeSourceFactory` — is not, and it sits above the real source in a
		// third of the files that have both, so it takes the name only until
		// something with a constructed base turns up.
		// `base === null` is the usual test: a class constructing a base this
		// build does not supply is the extension. It is wrong for an extension
		// built on a multisrc theme — `class Wcofun : WcoTheme()` resolves,
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
		this.owner = name;
		this.ownerBase = base;

		this.classMembers = new Set(
			members
				.map((child) =>
					child.type === 'function_declaration'
						? this.nameOf(child)
						: child.type === 'property_declaration'
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
					const next = members[index + 1];
					const detached =
						next !== undefined && (next.type === 'getter' || next.type === 'setter')
							? next
							: undefined;
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
					const emitted = this.member(fnName, child, () =>
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
		this.ownerBase = outerBase;
		this.enumScope = outerEnum;
		this.classMembers = outerMembers;
		this.suspendMembers = outerSuspends;
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
			`class ${this.safe(name)} ${heritage}${block([...ctor, ...memberLines])}` +
			(statics.length > 0 ? `\n${statics}` : '');
		// A `@Serializable` class is a *shape* as well as a class: the decoder
		// answers plain JSON, so a field the source renamed and a property it
		// computes are both absent from what a member then reads. Registered
		// beside the class so the runtime can recognise a decoded object as one
		// — see `shape` in the runtime for why the match has to be exact.
		const shape = this.serialisableShape(node, name);
		return orderClasses([...hoisted, shape === null ? cls : `${cls}\n${shape}`]).join('\n\n');
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
		const renames = new Map<string, string>();
		const saved = new Map<string, string | undefined>();

		for (const child of members) {
			if (child.type !== 'class_declaration' && child.type !== 'object_declaration') continue;
			const declared = this.nameOf(child);
			if (declared === null || declared === undefined) continue;
			if (!this.emittedTypes.has(declared)) {
				this.emittedTypes.add(declared);
				continue;
			}
			let candidate = `${owner}_${declared}`;
			while (this.emittedTypes.has(candidate)) candidate = `${candidate}_`;
			this.emittedTypes.add(candidate);
			renames.set(declared, candidate);
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
	private blockingMembers(members: readonly KNode[]): Set<string> {
		const bodies = new Map<string, string>();
		for (const child of members) {
			if (child.type !== 'function_declaration') continue;
			const name = this.nameOf(child);
			if (name !== null) bodies.set(name, child.text);
		}

		const blocking = new Set<string>();
		for (const [name, text] of bodies) {
			if (BLOCKING_CALLS.test(text)) blocking.add(name);
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
			for (const part of kids(inner)) {
				const declared =
					part.type === 'property_declaration'
						? this.propertyName(part)
						: part.type === 'function_declaration'
							? this.nameOf(part)
							: null;
				if (declared === null) continue;
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
			this.owner = name;
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
				for (const child of kids(body)) {
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
					const getter = kids(child).find((part) => part.type === 'getter');
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
			this.owner = name;
			const dispatched = new Set<string>();
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

			return `const ${self} = Object.freeze(${block(fields.map(comma))});`;
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
		const body = kids(node).find((child) => child.type === 'class_body');
		const out: string[] = [];

		for (const child of kids(body)) {
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
					const getter = accessorOf(child, undefined, 'getter');
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

	private member(name: string, node: KNode, run: () => string): string | null {
		// Recorded before anything is attempted, so a refused member still has
		// edges — a member reachable only from one has to stay reachable.
		this.graph.push({
			member: name,
			owner: this.owner,
			construction: node.type === 'property_declaration',
			references: mentions(node),
			calls: callEdges(node)
		});

		const previousName = this.memberName;
		const previousPending = this.pending;
		this.memberName = name;
		this.pending = [];

		const obstacles = scanObstacles(node, name);
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
		detached?: KNode
	): { kind: 'assign' | 'member'; text: string } | null {
		const name = this.propertyName(node);
		if (name === null) return this.declineMember('val', node, 'an unnamed property');

		// `protected abstract val isHentaiSite: Boolean` — a property this class
		// deliberately does not define, because the subclass is required to.
		// The same argument the abstract *function* above makes: there is
		// nothing to emit and nothing missing, and refusing it refused the
		// template over the one member that was never meant to have a value.
		if (this.hasModifier(node, 'abstract')) return null;

		const delegate = kids(node).find((child) => child.type === 'property_delegate');
		const getter = accessorOf(node, detached, 'getter');
		const setter = accessorOf(node, detached, 'setter');

		if (setter !== undefined) return this.declineMember(name, setter, 'a custom property setter');

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

		if (getter !== undefined) {
			const text = this.member(name, node, () => {
				const body = kids(getter).find((child) => child.type === 'function_body');
				if (body === undefined) this.refuse(getter, 'a getter with no body');
				const emitted = this.functionScope('function', null, [], () => this.functionBody(body));
				if (emitted.isAsync) this.refuse(getter, 'a suspending getter');
				return this.overridable(name, `get ${name}() ${emitted.text}`);
			});
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
			const value = this.propertyValue(node, name);
			if (!mutable && !deferred) {
				for (const helper of this.used) {
					if (before.has(helper)) continue;
					if (!HOST_BACKED_HELPERS.has(helper as RuntimeHelper)) continue;
					deferred = true;
					break;
				}
			}
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

		if (called === 'lazy') {
			const lambda = this.lambdaOf(call);
			if (lambda === null) this.refuse(delegate, 'a `lazy` without a block');
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
		return JSON.stringify(type);
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
		const previousReified = this.reifiedTypes;
		if (receiverType !== null) this.receiverParam = '__recv';
		if (reified.length > 0) {
			this.reifiedTypes = new Map(reified.map((one) => [one, reifiedBinding(one)]));
		}
		let emitted;
		try {
			emitted = this.functionScope('function', null, names, () => this.functionBody(body));
		} finally {
			this.receiverParam = previousReceiver;
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
				text.push(
					fallback === null
						? this.safe(pending.name)
						: `${this.safe(pending.name)} = ${this.expr(fallback)}`
				);
			}
			names.push(pending.name);
			pending = null;
		};

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
	): { name: string; isProperty: boolean; fallback: KNode | null }[] {
		const primary = kids(node).find((child) => child.type === 'primary_constructor');
		const out: { name: string; isProperty: boolean; fallback: KNode | null }[] = [];
		for (const param of kids(primary)) {
			if (param.type !== 'class_parameter') continue;
			const name = kids(param).find((child) => child.type === 'simple_identifier')?.text;
			if (name === undefined) continue;
			const fallback =
				kids(param).find(
					(child) =>
						child.type !== 'modifiers' &&
						child.type !== 'binding_pattern_kind' &&
						child.type !== 'simple_identifier' &&
						!child.type.endsWith('type')
				) ?? null;
			out.push({
				name,
				isProperty: kids(param).some((child) => child.type === 'binding_pattern_kind'),
				fallback
			});
		}
		return out;
	}

	/* ── statements ──────────────────────────────────────────────────────── */

	private statementList(node: KNode, sink: Sink): string[] {
		const children = this.rejoinJumps(kids(node));
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
			case 'while_statement':
				return `while (${this.expr(kids(node)[0])}) ${block(this.bodyLines(kids(node)[1] ?? null))}`;
			case 'do_while_statement': {
				const body = kids(node).find((child) => child.type === 'control_structure_body') ?? null;
				return `do ${block(this.bodyLines(body))} while (${this.expr(kids(node)[kids(node).length - 1])});`;
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
			this.declare(bare, true);
			return `let ${this.safe(bare)};`;
		}

		if (destructuring !== undefined) {
			// Kotlin destructuring is `component1()`, `component2()` — positional
			// over a Pair, a data class, a list or a regex match. The runtime is
			// asked for the components rather than the emitter guessing a shape.
			const value = this.expr(initialiser);
			const names = kids(destructuring).map(boundName);
			for (const name of names) this.declare(name, mutable);
			return `${keyword} [${names.map((part) => this.safe(part)).join(', ')}] = ${this.helper('destructured')}(${value});`;
		}

		const name = this.propertyName(node);
		if (name === null) this.refuse(node, 'an unnamed local');

		const guarded = this.elvisJump(initialiser);
		if (guarded !== null) {
			const value = this.expr(guarded.value);
			this.declare(name, mutable);
			return [
				`${keyword} ${this.safe(name)} = ${value};`,
				`if (${this.safe(name)} == null) ${this.stmt(guarded.jump, this.jumpValues.get(guarded.jump))}`
			].join('\n');
		}

		if (DELIVERABLE.has(initialiser.type)) {
			// `val x = try { … } catch { return … }`: the `return` belongs to the
			// enclosing function, so the `try` becomes a statement that assigns and
			// the `return` stays a real return.
			this.declare(name, mutable);
			return [`let ${this.safe(name)};`, this.tail(initialiser, { target: this.safe(name) })].join(
				'\n'
			);
		}

		if (this.needsInlining(initialiser)) {
			// `val x = response.use { … return … }`: same argument as the `try`
			// above, one construct along. The block is emitted into this function
			// rather than into a callback, so the `return` is this function's.
			const lines = this.deliver(initialiser, { target: this.safe(name) });
			this.declare(name, mutable);
			return [`let ${this.safe(name)};`, ...lines].join('\n');
		}

		const value = this.expr(initialiser);
		this.declare(name, mutable);
		return `${keyword} ${this.safe(name)} = ${value};`;
	}

	private assignment(node: KNode): string {
		const target = kids(node)[0];
		const value = kids(node)[kids(node).length - 1];
		const operator = node.allChildren.find((child) => ASSIGN_OPS.has(child.type))?.type ?? '=';

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
				const write = `${this.assignable(swallowed)} = ${this.expr(value)};`;
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
			if (local !== null && !local.mutable) {
				return `${this.helper(rebound)}(${this.assignable(target)}, ${this.expr(value)});`;
			}
		}

		const indexed = this.isIndexedTarget(target);
		if (indexed && operator !== '=') this.refuse(node, `an indexed \`${operator}\``);
		const write = (text: string): string =>
			indexed
				? `${this.helper('setIndex')}(${this.indexedTarget(target).join(', ')}, ${text});`
				: `${this.assignable(target)} ${operator} ${text};`;

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
		if (node.type !== 'directly_assignable_expression') return this.expr(node);
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
			if (inner.text === 'field') this.refuse(inner, 'a `field` backing reference');
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
			if (local !== null && (receiver === null || this.lookupLocal(inner.text)?.mutable === true)) {
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
			// Only a property write. An indexed write (`map["k"] = v`) needs the
			// runtime's own map semantics rather than JavaScript's, and guessing
			// between them writes to the wrong container.
			if (suffix.type !== 'navigation_suffix') {
				this.refuse(suffix, `an assignment target this build cannot read (\`${suffix.type}\`)`);
			}
			const name = kids(suffix)[0]?.text ?? suffix.text.replace(/^[.?]+/, '');
			if (name.length === 0) this.refuse(suffix, 'an assignment to an unnamed property');
			target = `${target}.${name}`;
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
				head = `const [${names.map((part) => this.safe(part)).join(', ')}]`;
			} else {
				const name = boundName(binding);
				this.declare(name);
				head = `const ${this.safe(name)}`;
			}
			return `for (${head} of ${sequence}) ${block(this.bodyLines(body))}`;
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
			if (this.inLambda()) this.refuse(node, `a \`${keyword}\` crossing a lambda`);
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
		const subjectValue = kids(subject)[0];
		const name = subjectValue === undefined ? null : this.temporary();

		const lines: string[] = [];
		if (name !== null && subjectValue !== undefined) {
			lines.push(`const ${name} = ${this.expr(subjectValue)};`);
		}

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
		const catches = kids(node).filter((child) => child.type === 'catch_block');
		const ensure = kids(node).find((child) => child.type === 'finally_block');
		if (catches.length > 1) this.refuse(catches[1], 'more than one `catch` clause');

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

	private bodyLines(node: KNode | null): string[] {
		return this.branchLines(node, null);
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
				if (label !== this.owner && label !== this.className) {
					this.refuse(node, `\`${node.text}\``);
				}
				return this.selfReference();
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
			case 'equality_expression':
				return this.binary(node, (operator) => (operator.startsWith('==') ? '===' : '!=='));
			case 'comparison_expression': {
				const generic = this.genericReference(node);
				if (generic !== null) return generic;
				return this.binary(node, (operator) => operator);
			}
			case 'additive_expression':
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
				if (operator !== '-' && operator !== '+' && operator !== '!') {
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
			case 'comparison_expression':
			case 'additive_expression':
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
			default:
				return `${operator}${this.expr(node)}`;
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
		if (named && this.isValueName(owner.text)) {
			const receiver = this.read(owner.text, owner);
			const helper = EXTENSION_METHODS.get(member.text);
			if (helper !== undefined) {
				return `(...__a) => ${this.helper(helper)}(${[receiver, '...__a'].join(', ')})`;
			}
			if (!this.declaredMethods.has(member.text) && !HOST_METHODS.has(member.text)) {
				this.refuse(node, `\`::${member.text}\` on \`${owner.text}\``);
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
			this.refuse(node, `an anonymous \`object : ${invoked.type}(…)\` over a constructed base`);
		}
		const body = kids(node).find((child) => child.type === 'class_body');
		if (body === undefined) this.refuse(node, 'an anonymous `object :` with no body');
		if (/(^|[^.@\w])this([^.@\w]|$)/.test(body.text)) {
			this.refuse(node, 'a bare `this` inside an anonymous `object :`');
		}
		const fields: string[] = [];
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
		return `(${block(fields.map(comma))})`;
	}

	/* ── calls ───────────────────────────────────────────────────────────── */

	private call(node: KNode): string {
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

		// `x.ifEmpty { return@map null }` before anything else looks at the call:
		// its lambda is a jump out of the *enclosing* lambda, which only reads
		// correctly with the callback taken away.
		const empty = emptyGuard(node);
		if (empty !== null) return this.hoistedEmptyGuard(node, empty);

		// `x.let { it ?: return emptyList() }` for the same reason: the jump is
		// out of the *member*, and only reads correctly with the callback gone.
		const letGuarded = letGuard(node);
		if (letGuarded !== null) return this.hoistedGuard(node, letGuarded);

		const { callee, args, lambda, labelled, typeArgument } = this.flatten(node);
		const expected = typeArgument === null ? this.expectedOf(node) : null;
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
		const name = kids(suffix).find((child) => child.type === 'simple_identifier')?.text ?? null;
		if (name === null) this.refuse(callee, 'a call through something with no name');
		const safe = suffix.allChildren[0]?.type === '?.';

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

		if (name === 'not' && args.length === 0 && lambda === null && !safe) {
			// `Boolean.not()` is the operator written as a call, which this
			// ecosystem reaches for when negating something already parenthesised:
			// `text.contains(x).not()`.
			return `!(${this.expr(receiver)})`;
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
			const tail = this.plainArguments(name, args);
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
			const before = this.asyncLambdas;
			const receiverText = this.expr(receiver);
			const tail = this.callArguments(name, args, lambda, labelled, false);
			const call = `${receiverText}.${name}(${tail.join(', ')})`;
			return this.asyncLambdas > before ? this.awaited(call) : call;
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
		if ((name === 'rateLimit' || name === 'rateLimitHost') && lambda === null && !shadowed) {
			return this.rateLimitCall(suffix, receiver, name, args);
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
		const helper = indexed
			? 'getAt'
			: scopeFunction && !shadowed
				? EXTENSION_METHODS.get(name)
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
			const call = safe
				? // `a?.substringAfter("x")` cannot use JavaScript's own `?.`: the
					// helper takes the receiver as an argument and would be handed
					// the null, and a conditional would evaluate it twice.
					`${this.helper('sc')}(${receiverText}, (__r) => ${this.helper(helper)}(${['__r', ...tail].join(', ')}))`
				: `${this.helper(helper)}(${[receiverText, ...tail].join(', ')})`;
			const suspends = AWAITING_HELPERS.has(helper) || this.asyncLambdas > before;
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
		const declared = this.declaredMethods.has(name) || ownMember;
		if (!HOST_METHODS.has(name) && !crossFileObject && !declared && scopeFunction) {
			// Passthrough is an allowlist. See the file header: a fallback turns
			// an unrecognised Kotlin helper into a call on a shim that has never
			// heard of it, and the failure then happens inside a sandbox rather
			// than here, where a sentence can be written about it.
			this.refuse(suffix, `\`.${name}()\``);
		}
		const argumentLambda = ARGUMENT_LAMBDA_METHODS.has(name);
		const builderLambda = lambda !== null && (BUILDER_LAMBDA_METHODS.has(name) || argumentLambda);
		if (lambda !== null && !builderLambda) this.refuse(lambda, `a lambda passed to \`.${name}()\``);

		const argumentsText = builderLambda
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
			return this.iife(() => this.lambdaLines(lambda));
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

		const free = FREE_FUNCTIONS.get(name);
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

		if ((name === 'values' || name === 'valueOf') && lambda === null) {
			const inEnum = this.enumMember(name);
			if (inEnum !== null) return `${inEnum}(${this.plainArguments(name, args).join(', ')})`;
		}
		const local = this.lookup(name);
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

		if (implicit !== null && lambda !== null && BUILDER_LAMBDA_METHODS.has(name)) {
			const withLambda = this.callArguments(name, args, lambda, labelled, true);
			return `${implicit}.${name}(${withLambda.join(', ')})`;
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
		if (lambda !== null && this.isSourceMember(name)) {
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
		const out = this.plainArguments(name, args);
		// An unlabelled lambda carries an implicit label: the name of the
		// function it was passed to. `return@map` inside `.map {}` is ordinary
		// Kotlin, and it is a return from the lambda, which translates.
		if (lambda !== null) {
			out.push(
				this.lambda(lambda, receiverForm, labelled ?? name, !NO_BLOCK_PARAMETER.has(name), model)
			);
		}
		return out;
	}

	/**
	 * The class a call's receiver is an instance of, or null.
	 *
	 * Only where it is a *fact* rather than an inference: the receiver is a
	 * construction of a declared type, or a property whose declaration names
	 * one. Anything else answers null and the caller falls back to the bare
	 * name — which refuses a named argument rather than guessing at an order.
	 */
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
	 */
	private rateLimitCall(suffix: KNode, receiver: KNode, name: string, args: KNode[]): string {
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
		const parts = [this.expr(receiver)];
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
			return this.rateLimitCall(suffix, receiver, 'rateLimit', call.args);
		}
		if (call.callee.text === 'SpecificHostRateLimitInterceptor') {
			return this.rateLimitCall(suffix, receiver, 'rateLimitHost', call.args);
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

		// Property *reads* are passthrough where method calls are not: a DTO's
		// fields are unbounded — `item.file`, `item.label` — and an allowlist of
		// them could only ever be a list of the ones already seen.
		const unit = DURATION_UNITS.get(name);
		if (unit !== undefined && /^[0-9][0-9_]*$/.test(receiver.text.trim())) {
			return String(Number(receiver.text.trim().replace(/_/g, '')) * unit);
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
					`const [${parts.map((part) => this.safe(part)).join(', ')}] = ${this.helper('destructured')}(${this.safe(holder)});`
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
				`const [${parts.map((part) => this.safe(part)).join(', ')}] = ${this.helper('destructured')}(${this.safe(holder)});`
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
		this.pushScope();
		for (const name of options.bound ?? []) this.declare(name);
		try {
			return { lines: run(), broke: frame.broke === true };
		} finally {
			this.popScope();
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
		const holder = this.objectMembers.get(name);
		if (holder !== undefined) {
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
		if (name === 'field') this.refuse(node, 'a `field` backing reference');
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
		if (
			receiver !== null &&
			!this.isSourceMember(name) &&
			MODEL_LACKS.get(this.receiverModel() ?? '')?.has(name) !== true
		) {
			return `${receiver}.${name}`;
		}
		// Inside `fun Element.getInfo()`, a bare name is the receiver's unless
		// the enclosing class declares it — the same rule, and the same residual
		// risk, as an `apply {}` body.
		if (this.receiverParam !== null && !this.isSourceMember(name)) {
			return `${this.receiverParam}.${name}`;
		}
		return `${this.selfReference()}.${name}`;
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

	private declare(name: string, mutable = false): void {
		this.scopes[this.scopes.length - 1]?.set(name, {
			text: this.safe(name),
			mutable
		});
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
			const text =
				frame.usesSelf && kind === 'function' && raw.startsWith('{')
					? `{\n\tconst __self = this;${raw.slice(1)}`
					: raw;
			return { text, isAsync: frame.usesAwait, usesSelf: frame.usesSelf };
		} finally {
			this.popScope();
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
	private iife(lines: () => string[]): string {
		const emitted = this.functionScope('lambda', null, [], () => block(lines()));
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

function sameNames(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((name, index) => name === right[index]);
}

/** Parts of a `property_declaration` that are not its initialiser. */
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
	for (const child of walk(node)) {
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
