/**
 * The line between Kotlin this build translates and Kotlin it refuses, and the
 * vocabulary a refusal is written in.
 *
 * ## Why the allowlist is here and not spread through the emitter
 *
 * `reader.ts` has one load-bearing invariant — every member declaration it sees
 * either resolves or lands in `unreadableOverrides`, and nothing is dropped —
 * and a translator needs the same invariant one level down: **every node is
 * consumed by a handler, or it is named.** An emitter whose `default:` case
 * returns an empty string is the failure that invariant exists to stop. A
 * half-translated `videoListParse` produces a plugin that installs, searches,
 * and shows the wrong episodes, which is precisely the silent wrongness
 * `themes/convert.ts` and `FOREIGN.md` §6 were built to prevent. A refusal
 * naming `object_literal` at line 84 is worth more than a plugin that runs.
 *
 * Keeping the set here rather than as a pile of `case` labels buys two things.
 * The emitter can **pre-scan** a member's subtree and name *every* obstacle in
 * it before translating a single node, so a refusal message lists three
 * problems rather than the first one; and a grammar upgrade that renames a node
 * kind fails a test in one file rather than silently routing a construct into
 * a `default:` nobody reads.
 *
 * ## The three method tables, and why passthrough is an allowlist too
 *
 * A Kotlin method call becomes one of three things, and the difference matters
 * more than it looks:
 *
 * - **Mapped** (`EXTENSION_METHODS`) — a Kotlin standard-library extension whose
 *   semantics differ from the JavaScript method of the same name. `replace`
 *   replaces *every* occurrence in Kotlin and the first one in JavaScript;
 *   `substringAfter` returns the whole string when the delimiter is absent;
 *   `Int` division truncates. Each of these is a wrong-value bug rather than an
 *   error, so each is routed through a `__k` helper that reproduces Kotlin.
 * - **Passthrough** (`HOST_METHODS`) — a method the runtime's own objects
 *   define: jsoup's `select`/`attr`/`text`, an HTTP client's `newCall`, the
 *   model builders. Emitted as `receiver.name(...)`.
 * - **Refused** — everything else, by name.
 *
 * Passthrough is an allowlist rather than a fallback on purpose. A fallback
 * turns an unrecognised Kotlin extension function into a property access on a
 * shim that has never heard of it, and the plugin then fails inside a sandbox
 * on somebody's phone instead of failing here, at conversion, where a sentence
 * can be written about it. The cost is honest and large: an extension using one
 * unlisted helper is refused, and the ranked list of what got refused is the
 * work queue for the next pass.
 *
 * ## Rule 9
 *
 * Nothing here names a content source. The tables are Kotlin and jsoup method
 * names; the only URLs in the specs beside this file are `example.invalid`.
 */

import { walk, type KNode } from './ast';
import { RUNTIME_HELPERS } from './runtime-api';

/* ── what a refusal is ────────────────────────────────────────────────────── */

/**
 * One thing in one member that could not be translated.
 *
 * `kind` names the *obstacle*, not the category: `object_literal`,
 * `Injekt.get`, `WebView`, `.toHttpUrlOrNull()`. A category ("unsupported
 * expression") tells a reader nothing they can act on, and tells the next
 * person working on this translator nothing about what to build.
 */
export interface Untranslatable {
	readonly kind: string;
	/** 1-based, as a person reads it. */
	readonly line: number;
	/** The member the obstacle sits in, or the class name for a header. */
	readonly memberName: string;
}

/** One member that will not be emitted, and every reason why. */
export interface Refusal {
	readonly member: string;
	readonly obstacles: readonly Untranslatable[];
}

/* ── node kinds ───────────────────────────────────────────────────────────── */

/**
 * Grammar node kinds the emitter has a handler for.
 *
 * The vendored grammar ships no `node-types.json` — only the two wasm files —
 * so this set cannot be diffed against the grammar's own manifest the way
 * `ast.ts` imagines. `subset.spec.ts` does the next best thing: it parses a
 * corpus of realistic extension code and asserts the kinds it produces are all
 * in here, so a grammar upgrade that renames one fails a test rather than
 * quietly widening the `default:` case.
 *
 * Punctuation and keyword nodes are absent because the emitter reads them
 * through `allChildren` when it needs an operator and never dispatches on them.
 */
export const SUPPORTED_KINDS: ReadonlySet<string> = new Set([
	// comments, which this grammar makes *named* children — so they sit in the
	// middle of a statement list and an emitter that does not expect them
	// refuses every commented member in the catalogue
	'line_comment',
	'multiline_comment',
	'shebang_line',

	// file and declarations
	'source_file',
	'package_header',
	'import_list',
	'import_header',
	'identifier',
	'simple_identifier',
	'type_identifier',
	'class_declaration',
	'object_declaration',
	// Erased: `registerAlias` records what it points at and nothing is emitted.
	'type_alias',
	// Emitted into the constructor, in the order it was declared.
	'anonymous_initializer',
	'companion_object',
	'primary_constructor',
	'class_parameter',
	'delegation_specifier',
	'constructor_invocation',
	'class_body',
	'enum_class_body',
	'enum_entry',
	'property_declaration',
	'function_declaration',
	'function_value_parameters',
	'parameter',
	'function_body',
	'variable_declaration',
	'multi_variable_declaration',
	'binding_pattern_kind',
	'property_delegate',
	'getter',
	'setter',
	'modifiers',
	'member_modifier',
	'visibility_modifier',
	'property_modifier',
	'class_modifier',
	'function_modifier',
	'inheritance_modifier',
	'parameter_modifier',
	'platform_modifier',
	'annotation',
	'user_type',
	'nullable_type',
	'type_arguments',
	'type_projection',
	'type_parameters',
	'type_parameter',
	'type_parameter_modifiers',
	'type_modifiers',
	// The *plural* container the grammar puts before the parameter it modifies
	// — `@Suppress("…")`, `crossinline`, `vararg`. Absent, every function in the
	// catalogue carrying one was refused for a modifier list, three of whose
	// four members mean nothing at run time and whose fourth (`vararg`) is a
	// rest parameter. See `Emitter.parameters`.
	'parameter_modifiers',
	'variance_modifier',
	'reification_modifier',
	'type_constraints',
	'type_constraint',
	// A function type only ever appears in a signature, and signatures are not
	// emitted — the parameter list is. Refusing it refused every extension that
	// declared a callback parameter, for syntax nothing reads.
	'function_type',
	'function_type_parameters',

	// statements
	'statements',
	'assignment',
	'directly_assignable_expression',
	'for_statement',
	'while_statement',
	'do_while_statement',
	'control_structure_body',
	'jump_expression',
	'label',

	// expressions
	'call_expression',
	'call_suffix',
	'value_arguments',
	'value_argument',
	'navigation_expression',
	'navigation_suffix',
	'indexing_expression',
	'indexing_suffix',
	'annotated_lambda',
	'lambda_literal',
	'lambda_parameters',
	'parenthesized_expression',
	'if_expression',
	'when_expression',
	'when_subject',
	'when_entry',
	'when_condition',
	'try_expression',
	'catch_block',
	'finally_block',
	'elvis_expression',
	'disjunction_expression',
	'conjunction_expression',
	'equality_expression',
	'comparison_expression',
	'additive_expression',
	'multiplicative_expression',
	'range_expression',
	'infix_expression',
	'check_expression',
	'type_test',
	'range_test',
	'as_expression',
	'prefix_expression',
	'postfix_expression',
	'this_expression',
	'super_expression',
	'callable_reference',
	'spread_expression',

	// literals
	'string_literal',
	'string_content',
	'interpolated_identifier',
	'interpolated_expression',
	'character_literal',
	// The escape inside one: `'\''`, `'\n'`, `'\0'`. The grammar makes it a
	// *named child* of the literal, so the pre-scan met it even though
	// `character_literal` decodes its own text — which refused eleven
	// extensions for writing a newline the only way Kotlin spells one.
	'character_escape_seq',
	'integer_literal',
	'real_literal',
	'long_literal',
	'hex_literal',
	'bin_literal',
	'unsigned_literal',
	'boolean_literal',
	'null'
]);

/**
 * Kinds that are grammatically fine and deliberately out of scope.
 *
 * Separated from "unknown" so the message can name the construct the way its
 * author would recognise it rather than by its grammar node kind. Each of these
 * is a decision, listed in `FOREIGN.md` terms:
 *
 * - `object_literal` — an anonymous implementation, almost always an okhttp
 *   `Interceptor` or a callback. Translating the object without its interface
 *   contract gives an object nobody calls.
 * - `anonymous_initializer` is no longer here either: it is emitted into the
 *   constructor at the position it was written, which is the order Kotlin runs
 *   it in. See `initialiserBody`.
 * - `collection_literal` — `[a, b]`, which Kotlin allows only in an annotation
 *   argument, where nothing is emitted to hold it.
 *
 * `type_alias` was on this list and is not any more: it is erased rather than
 * refused, because erasing it is what Kotlin itself does. See `registerAlias`.
 */
export const OUT_OF_SCOPE_KINDS: ReadonlyMap<string, string> = new Map([
	['object_literal', 'an anonymous `object :` implementation'],

	['collection_literal', 'a collection literal'],
	['secondary_constructor', 'a secondary constructor']
]);

/* ── named obstacles ──────────────────────────────────────────────────────── */

/**
 * Things refused by the name their author would use, matched on source text.
 *
 * These are not grammar kinds — they are ordinary calls and types that happen
 * to reach outside anything the sandbox has. Matching on text rather than on
 * resolved symbols is crude and deliberately over-eager: a false refusal costs
 * one extension, a false acceptance costs a plugin that looks like it works.
 */
const NAMED_OBSTACLES: readonly {
	readonly pattern: RegExp;
	readonly name: string;
}[] = [
	{ pattern: /\bInjekt\b/, name: 'Injekt.get' },
	{ pattern: /\b(?:WebView|WebSettings|WebViewClient)\b/, name: 'WebView' },
	{ pattern: /\bInterceptor\b/, name: 'an okhttp Interceptor' },
	// Narrowed rather than deleted when `ctx.crypto` arrived. What is left is
	// the part of javax.crypto that still has no honest answer:
	//
	// - `KeyGenerator` and `SecretKeyFactory` *derive* a key — from a password,
	//   from a seed — and the derivation is the provider's, not the spec's.
	// - `KeyStore`, `KeyFactory` and the encoded key specs read a key out of a
	//   DER blob, which is a parser this does not have.
	// - `CipherInputStream` / `CipherOutputStream` are streaming, and the one
	//   thing WebCrypto has no shape for at all.
	//
	// The supported half — `Cipher`, `Mac`, `Signature`, `KeyPairGenerator`,
	// `SecretKeySpec`, `IvParameterSpec` — is refused by *algorithm* instead;
	// see `cryptoObstacle`, which reads the transformation string an extension
	// wrote and refuses the modes WebCrypto does not have.
	{
		pattern:
			/\bjavax\.crypto\b|\b(?:KeyGenerator|SecretKeyFactory|KeyStore|KeyFactory|PBEKeySpec|X509EncodedKeySpec|PKCS8EncodedKeySpec|CipherInputStream|CipherOutputStream)\b/,
		name: 'javax.crypto'
	},
	{
		pattern: /\b(?:QuickJs|Rhino|JavaScriptEngine|evaluateJavascript)\b/,
		name: 'an embedded JavaScript engine'
	},
	{
		pattern: /\bjava\.lang\.reflect\b|\bClass\.forName\b|\bgetDeclaredField\b/,
		name: 'reflection'
	},
	// Matched on the bare name rather than on `launch {`, because the scanner
	// asks this question of leaves: by the time a call is a node, its callee is
	// a `simple_identifier` with nothing but the name in it.
	{ pattern: /^launch$|\blaunch\s*[({]/, name: 'launch {}' },
	// `Thread.sleep(…)` is a pause rather than a background thread, and the
	// runtime implements it as a real wait — so it is tempting to narrow this.
	// It was tried and put back: the scanner asks this question of *leaves*, so
	// the text it sees is the bare `Thread` with nothing after it, and no
	// lookahead can tell the two apart. Dropping the name instead let
	// `Thread.currentThread()` through as a passthrough on a capitalised
	// receiver — `Thread is not defined` inside a sandbox, with no refusal
	// anywhere — which is a worse answer than refusing the pause.
	{ pattern: /\b(?:Thread|Executors)\b/, name: 'a background thread' },
	{ pattern: /^android$|\bandroid\./, name: 'an android.* API' },
	{ pattern: /\bFileInputStream\b|\bjava\.io\.File\b/, name: 'the filesystem' },
	{ pattern: /\boperator\s+fun\b/, name: 'a custom operator overload' },
	// `this.javaClass.simpleName` is in 54 files of one 254-extension
	// catalogue, nearly all of it a log tag — and a runtime that answered with
	// the emitted class name would be right for the log tag and wrong for every
	// other use of reflection, with nothing at runtime able to tell them apart.
	// Left unrefused it surfaced as `undefined is not an object` at *load*,
	// which names nothing and takes the whole bundle with it.
	{ pattern: /\bjavaClass\b/, name: 'the JVM class object' },
	// The two cookie shapes the host jar cannot honour, refused by name rather
	// than left to the passthrough allowlist, because both had a way past it.
	//
	// `loadForRequest` hands a plugin the cookies it holds, which is the one
	// thing `docs/adr/0005-network-boundaries.md` §3 forbids outright: the host
	// carries the state and the plugin never reads it. Naming it here rather
	// than simply omitting it from `HOST_METHODS` catches the *declaration*
	// too — a class implementing okhttp's `CookieJar` declares both halves of
	// the interface, and the call would then be a declared method and pass. It
	// is also what stops a custom jar quietly becoming the no-op that
	// `saveFromResponse` now is.
	{ pattern: /\bloadForRequest\b/, name: 'reading a cookie jar' },
	// `CookieManager.getInstance().getCookie(url)` is the WebView's cookie
	// store, which this host does not have and will not grow (§4 of the same
	// ADR). The capitalised receiver made it a cross-file object reference,
	// which is exempt from the passthrough allowlist, so it converted cleanly
	// and died inside the sandbox as `CookieManager is not defined` — a runtime
	// mystery in place of a refusal with a name on it.
	{ pattern: /\bCookieManager\b/, name: 'the WebView cookie store' }
];

/* ── algorithms ───────────────────────────────────────────────────────────── */

/**
 * A JCE algorithm string, by the shape a JCE algorithm string has.
 *
 * The scanner asks its questions of *leaves*, and a transformation is written
 * as a string literal — so `Cipher.getInstance("AES/ECB/PKCS5Padding")` reaches
 * `cryptoObstacle` as the `string_content` node `AES/ECB/PKCS5Padding`, which
 * is the only place the mode is knowable at conversion time.
 *
 * Anchored on the WHOLE leaf, and the alternatives each require a digest or a
 * cipher name rather than a loose keyword. That matters: every string in an
 * extension is a leaf, so a pattern loose enough to match `\bDES\b` inside
 * prose would refuse a member for a word in a title. A transformation string is
 * the entire literal or it is not one.
 */
const CRYPTO_SPEC =
	/^(?:AES|AESWrap|DES|DESede|TripleDES|RC2|RC4|ARCFOUR|Blowfish|ChaCha20|RSA|PBEWith[A-Za-z0-9]+|PBKDF2With[A-Za-z0-9]+)(?:\/[A-Za-z0-9]+){0,2}$/;

/** `SHA256withECDSA` and its relatives, which name a digest and a scheme. */
const SIGNATURE_SPEC = /^(?:MD[245]|SHA-?\d+)with([A-Za-z0-9]+)$/i;

/** `HmacSHA256` and its relatives. */
const MAC_SPEC = /^Hmac(MD5|SHA-?\d+)$/i;

/**
 * The transformations `ctx.crypto` genuinely performs.
 *
 * WebCrypto's AES-CBC always applies PKCS#7, which over a 16-byte block is
 * byte-for-byte PKCS#5 — the same padding under two names, which is why both
 * spellings are here and why `AES/CBC/NoPadding` is not.
 */
const SUPPORTED_TRANSFORMS: ReadonlySet<string> = new Set([
	'AES/CBC/PKCS5PADDING',
	'AES/CBC/PKCS7PADDING',
	'AES/GCM/NOPADDING'
]);

/** The digests WebCrypto signs and MACs over. */
const SUPPORTED_HASHES: ReadonlySet<string> = new Set(['SHA1', 'SHA256', 'SHA384', 'SHA512']);

/**
 * The one algorithm name that is ambiguous out of context.
 *
 * `"AES"` is written in two places and means two things. As a transformation it
 * is ECB — the JCE's provider default, which WebCrypto does not have and which
 * must refuse. As the second argument to `SecretKeySpec(key, "AES")` it names
 * the key's algorithm, which is supported, and refusing it there would refuse
 * every AES-CBC extension for the line that sets up its key.
 *
 * A leaf carries no context, so the leaf scan does not refuse it and
 * `factoryTransformation` — which only asks about a string that is literally
 * the argument of a `Cipher.getInstance(…)` — does. `DES` and its neighbours
 * are not here because this build supports them in neither position.
 */
const AMBIGUOUS_ALGORITHMS: ReadonlySet<string> = new Set(['AES']);

/** The static factories whose first argument is an algorithm rather than a key's. */
const CRYPTO_FACTORY =
	/(?:^|\b)(?:Cipher|Mac|Signature|KeyPairGenerator)\s*\.\s*getInstance\s*\(\s*"([^"\\$]*)"\s*[),]/;

/**
 * The algorithm a `getInstance` call names, when it names one literally.
 *
 * Read off the call's own source text rather than by walking to the argument,
 * because the question is only worth asking of a node whose *shape* is already
 * known — the same technique `BLOCKING_CALLS` uses. A transformation built from
 * a variable has no literal here and is refused by the runtime instead, by
 * name, through a failure the extension cannot swallow.
 */
export function factoryTransformation(text: string): string | null {
	const found = CRYPTO_FACTORY.exec(text);
	return found === null ? null : found[1];
}

/**
 * The algorithm this text names and this build does not implement.
 *
 * `ctx.crypto` is AES-CBC, AES-GCM, HMAC and ECDSA over the three NIST curves,
 * because that is what WebCrypto has. Everything else an extension can write
 * into a `getInstance` has to refuse *here*, at conversion, by the name the
 * author used — and refuse rather than be mapped onto a neighbour:
 *
 * - **No ECB anywhere.** WebCrypto does not implement it, and a bare `"AES"`
 *   means ECB in the JCE's own defaults, so both refuse. Answering either with
 *   CBC produces a plugin that decrypts to rubbish and reports nothing.
 * - **No DES, DESede, RC2, RC4, Blowfish or ChaCha20.** None exist in
 *   WebCrypto, and a cipher is not something to reimplement here.
 * - **No RSA.** WebCrypto's RSA is RSASSA-PKCS1-v1_5, PSS and OAEP — padded
 *   schemes — where the JCE's `"RSA"` is raw modular exponentiation with the
 *   padding named separately. They are not interchangeable.
 * - **No PBE or PBKDF2.** A derivation is a promise about iteration count and
 *   salt handling, and getting it wrong yields a key that is simply different.
 *
 * `MessageDigest` is not asked about: a digest name is hyphenated (`SHA-256`),
 * matches none of these shapes, and is answered synchronously in the runtime
 * over its own published algorithms.
 */
export function cryptoObstacle(text: string, asTransformation = false): string | null {
	if (CRYPTO_SPEC.test(text)) {
		if (SUPPORTED_TRANSFORMS.has(text.toUpperCase())) return null;
		if (!asTransformation && AMBIGUOUS_ALGORITHMS.has(text.toUpperCase())) return null;
		return `the \`${text}\` cipher`;
	}
	const signature = SIGNATURE_SPEC.exec(text);
	if (signature !== null) {
		const hash = text.slice(0, text.toLowerCase().indexOf('with')).toUpperCase().replace(/-/g, '');
		const scheme = signature[1].toUpperCase();
		if (scheme === 'ECDSA' && SUPPORTED_HASHES.has(hash)) return null;
		return `the \`${text}\` signature`;
	}
	const mac = MAC_SPEC.exec(text);
	if (mac !== null) {
		const hash = mac[1].toUpperCase().replace(/-/g, '');
		return SUPPORTED_HASHES.has(hash) ? null : `the \`${text}\` MAC`;
	}
	// A curve is named as a bare string too, and `secp256k1` is one character
	// from a curve WebCrypto has and is not one it has.
	if (/^(?:secp|prime|brainpool|sect)[a-z0-9]+$/.test(text)) {
		return /^(?:secp256r1|prime256v1|secp384r1|secp521r1)$/.test(text)
			? null
			: `the \`${text}\` curve`;
	}
	return null;
}

/** The obstacle this node's own text names, if any. Checked leaf-first. */
export function namedObstacle(text: string): string | null {
	// Asked first, because it is the specific question: `cryptoObstacle` names
	// the algorithm the author wrote, where the table below can only name the
	// package it came from. A refusal that says `AES/ECB/PKCS5Padding` tells
	// the reader which line to look at; one that says `javax.crypto` does not.
	const algorithm = cryptoObstacle(text);
	if (algorithm !== null) return algorithm;
	for (const { pattern, name } of NAMED_OBSTACLES) {
		if (pattern.test(text)) return name;
	}
	return null;
}

/* ── method tables ────────────────────────────────────────────────────────── */

/**
 * Kotlin standard-library members that must go through the runtime, and the
 * `__k` helper each becomes.
 *
 * Emitted as `__k.helper(receiver, ...arguments)`. Every value here is asserted
 * against `RUNTIME_HELPERS` by `subset.spec.ts`, because the failure mode of a
 * typo is `__k.mapNotNul is not a function` inside a sandbox.
 */
export const EXTENSION_METHODS: ReadonlyMap<string, string> = new Map([
	// strings — every one of these differs from its JavaScript namesake
	['substringAfter', 'substringAfter'],
	['substringAfterLast', 'substringAfterLast'],
	['substringBefore', 'substringBefore'],
	['substringBeforeLast', 'substringBeforeLast'],
	['removePrefix', 'removePrefix'],
	['removeSuffix', 'removeSuffix'],
	['removeSurrounding', 'removeSurrounding'],
	['trimIndent', 'trimIndent'],
	['ifEmpty', 'ifEmpty'],
	['ifBlank', 'ifBlank'],
	['isNullOrEmpty', 'isNullOrEmpty'],
	['isNullOrBlank', 'isNullOrBlank'],
	['replace', 'replaceString'],
	['split', 'split'],
	['lowercase', 'lowercase'],
	['toLowerCase', 'lowercase'],
	['uppercase', 'uppercase'],
	['toUpperCase', 'uppercase'],
	['padStart', 'padStart'],
	['contains', 'contains'],
	['startsWith', 'startsWith'],
	['endsWith', 'endsWith'],
	['isBlank', 'isBlank'],
	['isNotBlank', 'isNotBlank'],
	['trim', 'trim'],
	['toString', 'toStringOf'],
	['toRegex', 'regex'],

	// numbers
	['toIntOrNull', 'toIntOrNull'],
	['toInt', 'toInt'],
	['toFloatOrNull', 'toFloatOrNull'],
	['toFloat', 'toFloat'],
	['toLongOrNull', 'toLongOrNull'],
	['toLong', 'toLong'],
	['countLeadingZeroBits', 'countLeadingZeroBits'],
	['toByte', 'toByte'],
	['formatBytes', 'formatBytes'],
	['now', 'now'],
	['digitToIntOrNull', 'digitToIntOrNull'],
	['toIntArray', 'toIntArray'],
	['toLongArray', 'toIntArray'],
	['toJsonString', 'toJsonString'],
	['asQueryPart', 'asQueryPart'],
	['withLock', 'withLock'],
	['elementAt', 'elementAt'],
	['iterator', 'iterator'],
	['trimMargin', 'trimMargin'],
	['encodeToString', 'encodeToString'],
	['asUriPart', 'asQueryPart'],
	['head', 'firstOrNull'],
	['rateLimit', 'rateLimit'],
	// The per-host sibling of the one above. Both are emitted with their period
	// already resolved to milliseconds; see `rateLimitCall` in `emit.ts`.
	['rateLimitHost', 'rateLimitHost'],
	['stop', 'stop'],

	// collections
	['map', 'map'],
	['mapIndexed', 'mapIndexed'],
	['mapNotNull', 'mapNotNull'],
	['filter', 'filter'],
	['filterNot', 'filterNot'],
	['flatMap', 'flatMap'],
	// The index comes FIRST in the lambda; see the helper.
	['flatMapIndexed', 'flatMapIndexed'],
	['flatten', 'flatten'],
	['firstOrNull', 'firstOrNull'],
	['first', 'first'],
	['lastOrNull', 'lastOrNull'],
	['last', 'last'],
	['find', 'find'],
	['any', 'any'],
	['all', 'all'],
	['none', 'none'],
	['sortedBy', 'sortedBy'],
	['sortedByDescending', 'sortedByDescending'],
	['reversed', 'reversed'],
	['distinct', 'distinct'],
	['take', 'take'],
	['drop', 'drop'],
	['joinToString', 'joinToString'],
	['toList', 'toList'],
	['toSet', 'toSet'],
	// Kotlin distinguishes a List from a MutableList and from an Iterable; the
	// runtime models all three as one array, and `add`/`addAll` are helpers
	// rather than methods, so the conversions between them are identities.
	['toMutableList', 'toList'],
	['toMutableSet', 'toSet'],
	['toMutableMap', 'toMutableMap'],
	['asIterable', 'toList'],
	['forEach', 'forEach'],
	['indexOfFirst', 'indexOfFirst'],
	['groupBy', 'groupBy'],
	// `String.format(Locale.US, "%.1f", x)` and `"%.1f".format(x)`. A receiver
	// that has its own `format` — `SimpleDateFormat` — still gets it; see the
	// helper.
	// `ByteArray.toHexString()` is the stdlib's; `toHex()` is keiyoushi's own
	// extension for the same operation, imported by the themes that build a
	// nonce. One helper answers both.
	// Kotlin spells arithmetic as methods too: `seconds.times(1000)`.
	['times', 'times'],
	['div', 'divide'],
	['minus', 'subtract'],
	['toHexString', 'toHexString'],
	['toHex', 'toHexString'],
	['format', 'format'],
	['associate', 'associate'],
	['associateBy', 'associateBy'],
	['associateWith', 'associateWith'],
	['sumOf', 'sumOf'],
	// kotlin.math, written as a method on the number it raises.
	['pow', 'pow'],
	['count', 'count'],
	['withIndex', 'withIndex'],
	['zip', 'zip'],
	['chunked', 'chunked'],
	['plus', 'plus'],
	['add', 'add'],
	['addAll', 'addAll'],
	['remove', 'remove'],
	['isEmpty', 'isEmpty'],
	['isNotEmpty', 'isNotEmpty'],
	['getOrNull', 'getOrNull'],
	['getOrDefault', 'getOrDefault'],
	['getOrElse', 'getOrElse'],

	// `List<Video>.toHosterList()` — not stdlib, but shaped exactly like it: a
	// companion extension function on a list, and the one line every source with
	// no hoster concept writes to answer `getHosterList`.
	['toHosterList', 'toHosterList'],

	// scope functions
	['let', 'let'],
	['also', 'also'],
	['apply', 'apply'],
	['run', 'run'],
	['takeIf', 'takeIf'],
	['takeUnless', 'takeUnless'],
	['runCatching', 'runCatching'],

	// the environment the host supplies
	['toHttpUrl', 'httpUrl'],
	['toHttpUrlOrNull', 'httpUrl'],
	['asJsoup', 'asJsoup'],
	['useAsJsoup', 'asJsoup'],
	// `use` closes a resource and yields the block's value; the shim has nothing
	// to close, so only the value half survives.
	['use', 'let'],
	['orEmpty', 'orEmpty'],
	['eachText', 'eachText'],
	['eachAttr', 'eachAttr'],
	['filterIsInstance', 'filterIsInstance'],
	['bodyString', 'bodyString'],
	// The `parallel*` family is this ecosystem's own: concurrency the sandbox
	// does not have, over a list. The `Catching` half of the name is the part
	// that matters — it *skips* an element whose lambda threw, and a plain
	// `flatMap` would fail the whole page instead of dropping one bad iframe.
	['parallelMap', 'map'],
	['parallelMapBlocking', 'map'],
	['parallelMapNotNull', 'mapNotNull'],
	['parallelMapNotNullBlocking', 'mapNotNull'],
	['parallelFlatMap', 'flatMap'],
	['parallelFlatMapBlocking', 'flatMap'],
	['parallelForEach', 'forEach'],
	['parallelForEachBlocking', 'forEach'],
	['parallelCatchingMap', 'catchingMap'],
	['parallelCatchingMapBlocking', 'catchingMap'],
	['parallelCatchingFlatMap', 'catchingFlatMap'],
	['parallelCatchingFlatMapBlocking', 'catchingFlatMap'],
	// The same three functions again without the `parallel` prefix. The
	// catalogue's own `Coroutines.kt` defines `catchingFlatMap` as `flatMap`
	// with the transform wrapped in a try-catch that yields an empty list, and
	// `catchingFlatMapBlocking`/`flatMapCatching` as that one — which is what
	// the `catchingFlatMap` helper already does, concurrency dropped.
	['catchingFlatMap', 'catchingFlatMap'],
	['catchingFlatMapBlocking', 'catchingFlatMap'],
	['flatMapCatching', 'catchingFlatMap'],
	['toTypedArray', 'toList'],
	['await', 'await'],
	['awaitAll', 'awaitAll'],
	// `execute()` is Kotlin's blocking call and suspends here; `awaitSuccess()`
	// is `await` plus a throw on a non-2xx, which is the whole reason it has its
	// own name.
	['execute', 'executeCall'],
	['awaitSuccess', 'awaitSuccess'],

	// All four getters collapse onto one helper: what separates them is the
	// type of the answer, and the call site's own fallback already states it.
	['getString', 'pref'],
	['getBoolean', 'pref'],
	['getInt', 'pref'],
	['getLong', 'pref'],
	['getStringSet', 'pref'],

	// chars — a Kotlin Char is a one-character string here, and every one of
	// these predicates is Unicode-wide where the ASCII spelling is not
	['isDigit', 'isDigit'],
	['isLetter', 'isLetter'],
	['isLetterOrDigit', 'isLetterOrDigit'],
	['isWhitespace', 'isWhitespace'],
	['digitToInt', 'digitToInt'],
	['titlecase', 'titlecase'],
	['titlecaseChar', 'titlecase'],
	// `Char.uppercaseChar()` answers a Char and `Char.uppercase()` a String;
	// this runtime spells both as a one-character string, so they collapse.
	['uppercaseChar', 'uppercase'],
	['lowercaseChar', 'lowercase'],
	['replaceFirstChar', 'replaceFirstChar'],

	// more strings — `replaceFirst` replaces one where `replace` replaces all,
	// and `equals` is structural in Kotlin where `===` is identity
	['replaceFirst', 'replaceFirst'],
	['repeat', 'repeat'],
	['lines', 'lines'],
	['equals', 'equalsTo'],
	['compareTo', 'compareTo'],
	['toByteArray', 'toByteArray'],
	['encodeToByteArray', 'toByteArray'],
	// `ByteArray.decodeToString()`, which is `String(bytes)` under Kotlin's
	// other name — including the range form, which tells a playlist from a
	// video by its first seven bytes.
	['decodeToString', 'decodeToString'],
	['toCharArray', 'toCharArray'],
	['contentEquals', 'contentEquals'],

	// more numbers
	['roundToInt', 'roundToInt'],
	['coerceAtLeast', 'coerceAtLeast'],
	['coerceAtMost', 'coerceAtMost'],
	['coerceIn', 'coerceIn'],
	// `a.minus(b)` is arithmetic on a number and removal on a collection; the
	// helper dispatches, because reading the second as the first answers NaN.
	['minus', 'minus'],
	// A bare `x.not()` is folded to `!(x)` by the emitter before this table is
	// read; what reaches the helper is `?.not()` and jsoup's `Elements.not(sel)`.
	['not', 'not'],

	// more collections
	['distinctBy', 'distinctBy'],
	['sortedWith', 'sortedWith'],
	['sorted', 'sorted'],
	['sortedDescending', 'sortedDescending'],
	['thenBy', 'thenBy'],
	['thenByDescending', 'thenByDescending'],
	['asSequence', 'asSequence'],
	['asReversed', 'asReversed'],
	['forEachIndexed', 'forEachIndexed'],
	['mapIndexedNotNull', 'mapIndexedNotNull'],
	['filterIndexed', 'filterIndexed'],
	['firstNotNullOfOrNull', 'firstNotNullOfOrNull'],
	['onEach', 'onEach'],
	['indexOfLast', 'indexOfLast'],
	['single', 'single'],
	['singleOrNull', 'singleOrNull'],
	['subList', 'subList'],
	['slice', 'slice'],
	['dropLast', 'dropLast'],
	['takeLast', 'takeLast'],
	['takeWhile', 'takeWhile'],
	['dropWhile', 'dropWhile'],
	['minOrNull', 'minOrNull'],
	['maxOrNull', 'maxOrNull'],
	['minOfOrNull', 'minOfOrNull'],
	['maxOfOrNull', 'maxOfOrNull'],
	['minByOrNull', 'minByOrNull'],
	['maxByOrNull', 'maxByOrNull'],
	['reduce', 'reduce'],
	// `fold` is a list fold and a Result fold under one name; the receiver
	// decides, because the emitter has no types to decide with.
	['fold', 'fold'],
	['random', 'random'],
	['removeAll', 'removeAll'],

	// the Result `runCatching` builds, past `getOrNull()`
	['onFailure', 'onFailure'],
	['onSuccess', 'onSuccess'],

	// keiyoushi's `SimpleDateFormat.tryParse`, which answers 0 rather than
	// throwing — the idiom around it is `?.time ?: 0L`
	['tryParse', 'tryParse'],

	// request bodies, in the shape `__bodyOf` already understands
	['toMediaType', 'toMediaType'],
	['toMediaTypeOrNull', 'toMediaType'],
	['toRequestBody', 'toRequestBody'],
	['toJsonBody', 'toJsonBody'],
	['toJsonRequestBody', 'toJsonRequestBody'],

	// jsoup's two upward calls
	['closest', 'closest'],
	['ownerDocument', 'ownerDocument'],

	// `Throwable.printStackTrace()`, which is what `onFailure { … }` contains
	['printStackTrace', 'printStackTrace'],

	// `Int.toChar()`, which is the character at that code and not its digits
	['toChar', 'toChar'],

	// The Select filter's `isDefault()`, declared as `state == 0` by every
	// extension in the catalogue that declares it. The helper asks the value
	// first, so a declaration the emitter did resolve still wins.
	['isDefault', 'isDefault'],

	// android's name for okhttp's `queryParameter`
	['getQueryParameter', 'getQueryParameter'],

	['randomOrNull', 'randomOrNull'],

	// RFC 3986 reference resolution, over a `URI` or an `HttpUrl`. The helper
	// dispatches on the receiver because okhttp answers null for a result that
	// is not http, which is what `?: return null` at the call sites tests.
	['resolve', 'resolve'],

	// Kotlin's `trimStart`/`trimEnd` take a vararg of Chars where JavaScript's
	// take none, so the passthrough these used to get trimmed whitespace when
	// the source asked for a delimiter. With no arguments the two agree, which
	// is why it had gone unnoticed.
	['trimStart', 'trimStart'],
	['trimEnd', 'trimEnd'],

	// org.json's readers. The values a parse answers here are plain, so the
	// whole of org.json is this list — the `opt` forms take a fallback and the
	// `get` forms throw, which is the distinction an extension is making when
	// it writes one rather than the other.
	['optString', 'optString'],
	['optInt', 'optInt'],
	['optLong', 'optLong'],
	['optDouble', 'optDouble'],
	['optBoolean', 'optBoolean'],
	['optJSONObject', 'optJSONObject'],
	['optJSONArray', 'optJSONArray'],
	['getJSONObject', 'getJSONObject'],
	['getJSONArray', 'getJSONArray'],
	['has', 'jsonHas'],
	['keys', 'jsonKeys'],
	['opt', 'jsonOpt'],

	// The long tail. Each of these refused extensions by name while the
	// behaviour was already spelled somewhere in the runtime — `xor` as an
	// infix operator, `isLowerCase` as a `Character` static, `toMillis` on the
	// `TimeUnit` shim — and only the tables had not been told.
	['toUrl', 'toUrl'],
	['digitToChar', 'digitToChar'],
	['isLowerCase', 'isLowerCase'],
	['isUpperCase', 'isUpperCase'],
	['containsKey', 'containsKey'],
	['intersect', 'intersect'],
	['partition', 'partition'],
	['sortedArray', 'sortedArray'],
	['copyOfRange', 'copyOfRange'],
	['clear', 'clearAll'],
	['stackTraceToString', 'stackTraceToString'],
	['lineSequence', 'lineSequence'],
	// keiyoushi's hex readers, which answer bytes and text respectively — an
	// initialisation vector and a key both arrive this way.
	['decodeHex', 'decodeHex'],
	['decodeHexToString', 'decodeHexToString'],
	// `Int.xor(other)` written as a call rather than as the infix the emitter
	// already reads. Same operator, and the same helper.
	['xor', 'bitwiseXor'],
	// `length()` with the parentheses is org.json's, never Kotlin's
	// `String.length` — that one is a property and reaches a different table.
	['length', 'jsonLength']
]);

/**
 * Deserialisation, which needs the type argument rather than the arguments.
 *
 * `json.decodeFromString<Foo>(body)` and `response.parseAs<Foo>()` both name
 * the shape they expect in a place the call's arguments do not reach, so these
 * are emitted as `__k.decode(receiver, 'Foo', …)` with the type argument passed
 * through as text. A call of either name *without* a type argument is refused:
 * the runtime cannot build a descriptor for a shape nobody named, and guessing
 * one produces an object with the right keys missing.
 */
export const DECODING_METHODS: ReadonlySet<string> = new Set([
	'decodeFromString',
	'decodeFromStream',
	'parseAs'
]);

/**
 * `Json { … }` builder flags the runtime's parser already behaves as if set.
 *
 * The shim is permanently lenient — it ignores unknown keys and coerces absent
 * ones to their declared defaults — so a builder block that only sets these is
 * a no-op and the whole call collapses to `Json`. A block that sets anything
 * else is changing behaviour this build does not model, and is refused.
 */
export const TOLERATED_JSON_FLAGS: ReadonlySet<string> = new Set([
	'ignoreUnknownKeys',
	'isLenient',
	'coerceInputValues',
	'explicitNulls',
	'encodeDefaults',
	'allowStructuredMapKeys',
	'allowSpecialFloatingPointValues'
]);

/**
 * The kotlinx builders whose trailing lambda is a body to translate rather than
 * a callback to refuse. Here rather than spelled out in the emitter, because the
 * emitter asks the question from two places — a named receiver and an implicit
 * one — and a name added to only one of them converts in one position and is
 * refused in the other.
 */
export const BUILDER_LAMBDA_METHODS: ReadonlySet<string> = new Set([
	'putJsonObject',
	'putJsonArray'
]);

/**
 * Kotlin properties (no call parentheses) that must go through the runtime.
 *
 * `size` is the whole reason this table exists: jsoup's `Elements` and Kotlin's
 * `List` both spell it `size` and a JavaScript array spells it `length`.
 */
export const EXTENSION_PROPERTIES: ReadonlyMap<string, string> = new Map([
	['size', 'size'],
	// `CharSequence.indices` and `Collection.indices`, which JavaScript has no
	// namesake for at all — so it converted as a plain property read, answered
	// `undefined`, and handed that to whatever iterated it. A refusal would have
	// been the honest outcome; silence was not. See `indices` in the runtime.
	['indices', 'indices'],
	['groupValues', 'groupValues'],
	['destructured', 'destructured']
]);

/**
 * jsoup methods the runtime answers with a property of the same name.
 *
 * jsoup spells all of these as calls — `element.parent()`, `element.id()` — and
 * `shims/dom.ts` spells them as fields, because that is what they are in
 * JavaScript and the parser reads them on every line it runs. Emitting the call
 * as written passes the allowlist above, translates, packages and installs, and
 * then answers the first `element.parent()` with `parent is not a function`:
 * the passthrough that lands on a shim which has never heard of the *shape*
 * asked for, rather than of the name. So the call parentheses are dropped here,
 * which is the same rewrite `EXTENSION_PROPERTIES` makes in the other
 * direction. Only the zero-argument form: anything else is not this method.
 */
export const HOST_PROPERTY_METHODS: ReadonlySet<string> = new Set([
	'parent',
	'children',
	'tagName',
	'className',
	'id',
	'value',
	// `Charsets.UTF_8.name()` — java.nio's Charset spells it as a method and the
	// runtime holds it as a field, exactly like the jsoup cases above. A Kotlin
	// enum's `.name` is a property either way, so dropping the parentheses is
	// right for both spellings.
	'name'
]);

/**
 * Methods and properties emitted unchanged, because the runtime defines them.
 *
 * jsoup (`shims/dom.ts`), the HTTP client, the URL builder and the three model
 * builders. Anything not here is refused by name — see the header for why that
 * is a deliberate cost rather than an oversight.
 */
export const HOST_METHODS: ReadonlySet<string> = new Set([
	// jsoup
	'select',
	'selectFirst',
	'attr',
	'hasAttr',
	'text',
	'ownText',
	'html',
	'outerHtml',
	'data',
	'absUrl',
	'parent',
	'children',
	'nextElementSibling',
	'previousElementSibling',
	// The node-level walk, which includes text: an extension reads
	// `select("span + br").first()?.previousSibling()` precisely because the
	// value it wants is the text an element-only walk steps over.
	'previousSibling',
	'nextSibling',
	'textNodes',
	'wholeText',
	'getElementById',
	'getElementsByTag',
	'hasClass',
	'classNames',
	'clone',
	'baseUri',
	'tagName',
	'className',
	'id',
	'val',
	'parse',
	'parseToJsonElement',
	'parseBodyFragment',

	// `TimeUnit.DAYS.toMillis(n)`, which the `TimeUnit` shim already answers.
	'toMillis',
	// java.util.Base64's coder accessors, which android's Base64 has no need of
	// and which every source reaching for java.util's writes.
	'getDecoder',
	'getEncoder',
	'getUrlDecoder',
	'getUrlEncoder',
	// java.time, for the one chain this ecosystem writes.
	'toInstant',
	'toEpochMilli',
	// okhttp's HttpUrl fragment, which this ecosystem packs a second id into.
	'fragment',
	'encodedFragment',
	// jsoup's document title, and the unique path `distinctBy` reads.
	'title',
	'cssSelector',
	// okhttp's FormBody.Builder, whose `addEncoded` names a pair that is
	// already encoded — a request signature — and must not be encoded again.
	'addEncoded',

	// org.json's tokener, whose `nextValue()` is the one method of it this
	// ecosystem calls. The runtime answers a reader object rather than routing
	// the parse through `__k`, so the call is a passthrough.
	'nextValue',

	// http
	'post',
	'newCall',
	'execute',
	// Reaches the property branch below, which drops the parentheses.
	'name',
	// java.security.MessageDigest: a request signature, hashed and hexed.
	'digest',
	'update',
	'reset',

	// javax.crypto and java.security, whose objects are built by a static
	// `getInstance` — a capitalised receiver, which passes through on its own —
	// and then driven through these. The four that touch a key are also in
	// `AWAITED_HOST_METHODS`.
	//
	// These are the widest names in this table, and `init`, `sign` and `verify`
	// are the ones to be uneasy about: the allowlist is by *name*, so a `.sign()`
	// on something that is not a `Signature` now passes through and dies at run
	// time where it used to be refused at conversion. That is the trade every
	// entry here makes, and it is made knowingly rather than overlooked — the
	// alternative is resolving the receiver's type, which this emitter does not
	// do for anything and would be a guess where it matters most.
	'init',
	'doFinal',
	'initSign',
	'initVerify',
	'sign',
	'verify',
	'initialize',
	'generateKeyPair',
	'getPublic',
	'getPrivate',
	'getEncoded',
	'getIV',
	// `BigInteger.toByteArray()` on an affine coordinate, which is how the
	// Kotlin this replaces assembles a JWK by hand. `toByteArray` is a String
	// method in `EXTENSION_METHODS` too; the helper tells the two apart by what
	// it is handed.
	'bitLength',
	// `response.body.contentType()`, the header verbatim.
	'contentType',
	// `Random::nextBytes`, passed to `also` to fill a ByteArray in place.
	'nextBytes',
	'enqueue',
	'body',
	'string',
	'bytes',
	'code',
	'headers',
	'header',
	'request',
	'url',
	'location',
	'headersOf',
	'isSuccessful',
	'close',
	'stop',
	// The two cookie calls the host jar makes true, rather than merely
	// tolerable. `ADR-0005` §3: the plugin declares intent, the host carries
	// the state — so both of these are statements of intent the host has
	// already acted on, and the runtime answers them as no-ops.
	//
	// `.cookieJar(…)` on a client builder says "carry cookies on this client".
	// A plugin holding the `cookies` permission has a jar on every request it
	// makes, so the setting is satisfied before it is written. Supplying a jar
	// with logic of its own does not slip through here: an `object : CookieJar`
	// is refused as an anonymous object, and a named class implementing the
	// interface declares `loadForRequest`, which is refused by name above.
	//
	// `.saveFromResponse(url, cookies)` says "remember what this response set".
	// The host absorbed those cookies before the response reached the plugin at
	// all, so the call is an acknowledgement of work already done.
	'cookieJar',
	'saveFromResponse',

	// url building
	'newBuilder',
	'addQueryParameter',
	'addEncodedQueryParameter',
	'setQueryParameter',
	'removeAllQueryParameters',
	'addPathSegment',
	'addPathSegments',
	'encodedPath',
	'queryParameter',
	'queryParameterNames',
	'pathSegments',
	'fragment',
	'host',
	'scheme',
	'build',

	// the accumulator `buildString` hands its block
	'append',
	'appendLine',

	// header and form builders
	'Builder',
	'set',
	'get',
	'put',
	'addHeader',
	'addAllHeaders',

	// models
	'create',
	'setUrlWithoutDomain',

	// regex results
	'find',
	'findAll',
	'matchEntire',
	'containsMatchIn',
	'matches',
	'toPattern',

	// strings that behave identically in both languages
	'trimStart',
	'trimEnd',

	// Timeouts, which are the host transport's business: the runtime's builder
	// accepts each and changes nothing, and refusing them would fail extensions
	// that set one idly and never depend on it. `followRedirects` is NOT one of
	// these — it is honoured, and it is listed with the client below.
	'connectTimeout',
	'readTimeout',
	'writeTimeout',
	'callTimeout',
	'followSslRedirects',
	'retryOnConnectionFailure',
	'connectionPool',
	// `protocols(listOf(Protocol.HTTP_1_1))`. The version is negotiated by
	// whatever actually makes the request, so this configures nothing here.
	'protocols',
	// Honoured: the builder records it and every request that client makes
	// carries `follow: false` to the host, which returns the 3xx as data. It
	// earned its place here by being implemented; a passthrough that accepted
	// the flag and dropped it would make an extension believe it was reading a
	// `Location` when it was reading the page that header pointed at.
	'followRedirects',
	'indexOf',
	'lastIndexOf',
	'substring',
	'toDouble',
	'toBoolean',
	'format',
	'parseLong',
	'time',

	// SharedPreferences, written. The store and its editor are both in
	// `KOTLIN_PREFS` already; only this gate stood between an extension and
	// `preferences.edit().putString(key, value).apply()`, which is how every
	// one of them saves a chosen quality or a chosen mirror. `apply` is not
	// here — it is a scope function first, and the emitter separates the two by
	// whether a block was passed.
	'edit',
	'putString',
	'putStringSet',
	'putInt',
	'putLong',
	'putFloat',
	'putBoolean',
	'commit',
	'hasNext',
	'next',

	// `AnimeFilter.TriState`, whose three states are read either as constants
	// (see `BASE_CONSTANTS`) or through these
	'isIncluded',
	'isExcluded',
	'isIgnored',

	// the atomics, whose `get`/`set` are already above
	'incrementAndGet',
	'decrementAndGet',
	'getAndIncrement',
	'getAndDecrement',
	'addAndGet',
	'getAndAdd',
	'getAndSet',
	'compareAndSet',
	'updateAndGet',
	'getAndUpdate'
]);

/**
 * Passthrough methods that return a promise, and so must be awaited.
 *
 * Kotlin's `javax.crypto` is synchronous and `crypto.subtle` is not, so the
 * four operations that actually touch a key are `async` in the runtime shim.
 * Nothing at the call site says so — `cipher.doFinal(bytes)` reads as a
 * `ByteArray` in both languages — and an un-awaited one is a Promise handed to
 * `String(…)`, which answers `[object Promise]` and encrypts nothing. That is
 * the same failure `SUPER_SUSPEND_MEMBERS` exists to prevent, decided the same
 * way: from the runtime's own shape rather than inferred at the call site.
 *
 * The emitter's `awaited()` marks the enclosing frame `async`, and
 * `BLOCKING_CALLS` carries that outward to whatever calls *it* — so a member
 * that decrypts becomes `async` and its callers await it, transitively.
 *
 * Only these four, and each is a name javax.crypto and java.security own.
 * `init`, `initSign` and `update` stay synchronous because the shim keeps them
 * so: a key is recorded rather than imported, and the import happens inside the
 * operation, which is what keeps the asynchronous surface this small.
 */
export const AWAITED_HOST_METHODS: ReadonlySet<string> = new Set([
	'doFinal',
	'sign',
	'verify',
	'generateKeyPair'
]);

/**
 * Bare-name calls, and what each becomes.
 *
 * A bare call whose name is not here and not a member of the translated class
 * becomes `this.name(...)`, which is right for anything the base class
 * supplies — `episodeFromElement`, `videoUrlParse`, `headersBuilder`. A bare
 * call that is neither is refused.
 */
export const FREE_FUNCTIONS: ReadonlyMap<string, string> = new Map([
	['listOf', 'listOf'],
	['mutableListOf', 'mutableListOf'],
	['arrayListOf', 'mutableListOf'],
	['listOfNotNull', 'listOfNotNull'],
	['emptyList', 'emptyList'],
	// `delay(300.milliseconds)` between retries. It suspends, so it is awaited.
	['delay', 'delay'],
	// Generic packed-script decoding. The runtime deliberately accepts only the
	// one-argument form; option-bearing variants carry semantics we cannot prove
	// equivalent without executing foreign code.
	['unpack', 'unpack'],
	['mapOf', 'mapOf'],
	['mutableMapOf', 'mutableMapOf'],
	['setOf', 'setOf'],

	// Kotlin distinguishes an Array from a List and a HashMap from a Map; this
	// runtime does not, because the distinction is about storage and variance
	// and nothing downstream of a scraper can observe either. Collapsing them
	// onto the collection helpers is what stops `arrayOf(…)` falling through to
	// the bare-call fallback below and being emitted as `this.arrayOf(…)` — a
	// method the source does not have, which took eleven conversions down at
	// load time before these entries existed.
	['arrayOf', 'listOf'],
	['ByteArray', 'byteArray'],
	['CharArray', 'byteArray'],
	['IntArray', 'byteArray'],
	['LongArray', 'byteArray'],
	['FloatArray', 'byteArray'],
	['DoubleArray', 'byteArray'],
	['BooleanArray', 'byteArray'],
	// `byteArrayOf` takes the elements, like its six siblings below; only
	// `ByteArray(size)` above takes a length.
	['byteArrayOf', 'listOf'],
	['intArrayOf', 'listOf'],
	['longArrayOf', 'listOf'],
	['floatArrayOf', 'listOf'],
	['doubleArrayOf', 'listOf'],
	['booleanArrayOf', 'listOf'],
	['charArrayOf', 'listOf'],
	['emptyArray', 'emptyList'],
	['hashMapOf', 'mapOf'],
	['linkedMapOf', 'mapOf'],
	['sortedMapOf', 'mapOf'],
	['emptyMap', 'mapOf'],
	['mutableSetOf', 'setOf'],
	['hashSetOf', 'setOf'],
	['sortedSetOf', 'setOf'],
	['linkedSetOf', 'setOf'],
	['emptySet', 'setOf'],
	['runCatching', 'runCatching'],
	['error', 'error'],
	['awaitAll', 'awaitAll'],
	['async', 'async'],
	['lazy', 'lazy'],
	['to', 'to'],
	['Pair', 'to'],
	['Triple', 'triple'],
	['Regex', 'regex'],

	// `String(bytes)` and `String(bytes, Charsets.UTF_8)` DECODE, and this is
	// routed here rather than declared at bundle scope on purpose: a global
	// named `String` would shadow JavaScript's inside the whole runtime, and
	// every `String(x)` in this file — `__str`, `__headerPairs`, the regex
	// translator — would start decoding bytes instead of stringifying.
	['String', 'stringOf'],
	['StringBuilder', 'stringBuilder'],
	['StringBuffer', 'stringBuilder'],
	['Date', 'dateOf'],

	// Comparator construction, which `sortedWith` is always handed
	['compareBy', 'compareBy'],
	['compareByDescending', 'compareByDescending'],

	// `Char(code)`, the constructor form of `Int.toChar()`
	['Char', 'toChar'],

	// kotlinx's JSON values, which in this runtime are the plain values they
	// describe — marked, so `toJsonRequestBody` may serialise one without a
	// `@Serializable` descriptor to consult.
	['JsonArray', 'jsonArrayOf'],
	['JsonPrimitive', 'jsonPrimitiveOf'],

	// `AnimeFilter.Sort.Selection(index, ascending)`, written bare
	['Selection', 'selection'],

	// The builders whose block is handed a receiver. `buildString` is emitted
	// by name in `emit.ts`; these four are ordinary free functions there.
	['buildList', 'buildList'],
	['buildMap', 'buildMap'],
	['buildJsonObject', 'buildJsonObject'],
	['buildJsonArray', 'buildJsonArray'],

	// `require(x) { "…" }` and `requireNotNull(x) { "…" }`, which throw
	['require', 'require'],
	['requireNotNull', 'requireNotNull'],

	// The BARE `repeat(n) { … }`, which is a loop. `String.repeat` is the other
	// function of that name and it is in `EXTENSION_METHODS`; a bare call and a
	// method call are separate tables, so the two never collide.
	['repeat', 'repeatBlock'],

	// org.json's three constructors. Android ships it, and an extension reaching
	// for `JSONTokener` rather than `JSONObject` is reading a response that may
	// be either shape — see `jsonTokener` in the runtime.
	// jsoup's `Elements()`, which is an array here: `select` answers one, so a
	// hand-built list has to be the same shape or nothing downstream indexes it.
	['Elements', 'elementsOf'],

	['ArrayList', 'arrayList'],
	['LinkedList', 'arrayList'],
	// `List(n) { at -> … }` BUILDS: it is an episode list as often as not, and
	// an empty array of that length answers undefined for every entry.
	['List', 'listOfSize'],

	['JSONObject', 'jsonObject'],
	['JSONArray', 'jsonArray'],
	['JSONTokener', 'jsonTokener'],

	// `java.net.URI(url)`, which is NOT the `HttpUrl` this runtime already has:
	// that one refuses a scheme it does not model, and an extractor reads
	// `.scheme` precisely to decide whether it wants the value. `java.net.URL`
	// is deliberately absent: nothing in the catalogue constructs one, and a
	// name here shadows a declaration of the same name in the converted source.
	['URI', 'uri']
]);

/**
 * The helper a `throw` becomes, by the exception's own name.
 *
 * `UnsupportedOperationException` is not an edge case in this ecosystem: it is
 * how an extension says "this member is not used here", and the survey found it
 * in 134 of 254 extensions. Refusing it would refuse half the catalogue for
 * writing down that a method does nothing. It must translate to a throw.
 *
 * Anything else whose name ends the way an exception's does becomes
 * `__k.error`, which the host surfaces as a plugin error. An unrecognised
 * thrown type is refused rather than guessed at, because a `throw` the runtime
 * cannot construct is a member that dies at its first call.
 */
export function thrownHelper(typeName: string): string | null {
	if (typeName === 'UnsupportedOperationException') return 'unsupported';
	if (/(?:Exception|Error|Throwable)$/.test(typeName)) return 'error';
	return null;
}

/**
 * Constants a base class supplies, which an extension writes bare.
 *
 * A `class Genre(name: String) : AnimeFilter.TriState(name)` says
 * `STATE_INCLUDE` with no qualifier, because in Kotlin it inherits the
 * companion of the class it extends. The emitter has no inheritance to consult
 * — a capitalised name it did not see declared is refused by name — so the few
 * that matter are written down here and resolved to their qualified form.
 *
 * Deliberately three entries. This is a *fallback*: a file that declares its
 * own `STATE_INCLUDE` is checked first, and a name added here that an extension
 * meant differently would silently mean the framework's.
 */
export const BASE_CONSTANTS: ReadonlyMap<string, string> = new Map([
	['STATE_IGNORE', 'AnimeFilter.TriState.STATE_IGNORE'],
	['STATE_INCLUDE', 'AnimeFilter.TriState.STATE_INCLUDE'],
	['STATE_EXCLUDE', 'AnimeFilter.TriState.STATE_EXCLUDE']
]);

/**
 * Names the runtime defines at bundle scope, used bare.
 *
 * Kept in step with `RUNTIME_GLOBALS` by `subset.spec.ts`; duplicated as a set
 * here only because the emitter asks the question thousands of times.
 */
export const GLOBAL_NAMES: ReadonlySet<string> = new Set([
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
	'Hoster',
	'AnimesPage',
	'AnimeFilterList',
	'RegexOption',
	'SimpleDateFormat',
	'Locale',
	'Calendar',
	'Base64',
	'Charsets',
	'StandardCharsets',
	'JsonObject',
	'LruCache',
	'Random',
	'MessageDigest',

	// javax.crypto and the keyed half of java.security. See `RUNTIME_GLOBALS`
	// for why each is a bundle-scope name, and `cryptoObstacle` below for the
	// algorithms that are still refused rather than answered.
	'SecureRandom',
	'SecretKeySpec',
	'IvParameterSpec',
	'GCMParameterSpec',
	'ECGenParameterSpec',
	'Cipher',
	'Mac',
	'Signature',
	'KeyPairGenerator',

	'URLEncoder',
	'URLDecoder',
	'Log',
	'ConnectionPool',
	'Mutex',
	'Uri',
	'System',
	'TimeUnit',

	// `java.util.concurrent.atomic`, which is a mutable box on one thread, and
	// the `Any()` this ecosystem constructs to have something to lock.
	'AtomicInteger',
	'AtomicLong',
	'AtomicBoolean',
	'AtomicReference',
	'Any',

	// `java.lang.Character`, and okhttp's `Protocol` for `protocols(…)`.
	'Character',
	'Protocol',
	'Unpacker',
	'JsUnpacker',
	'Unbaser',

	// The boxed numeric limits. `Float.MAX_VALUE` is how this ecosystem says
	// "sort this episode last", and a capitalised receiver is passed through —
	// so an absent name is `Float is not defined` at run time, not a refusal.
	'Float',
	'Double',
	'Int',
	'Long',
	// `Math.random()`, whose JavaScript namesake answers the same thing.
	'Math',

	// `AnimeFilter.TriState` and `.CheckBox`, imported by their bare names.
	'TriState',
	'CheckBox',

	// `java.text.Normalizer`, `android.text.Html` and java.time's instants.
	'Normalizer',
	'Html',
	'Instant',
	'OffsetDateTime',
	'ZonedDateTime',
	'LocalDateTime'
]);

/**
 * Base-class members an extension may reach with `super.`.
 *
 * `shims/aniyomi-entry.ts` declares these on a `__super` object, so a written
 * `super.foo(x)` becomes `__super.foo(x)`. This does not soften the rule that a
 * *refused* override never falls back to the base: that rule exists because a
 * member we could not read might have been replacing the base behaviour or
 * adding to it, and we cannot tell which. An explicit `super.` call is the
 * extension saying, in its own source, that the base behaviour belongs at that
 * point. Honouring a written instruction and inventing one to cover a failure
 * are different acts.
 *
 * A `super.` to something not on this list is still refused, by name. The list
 * and the `__super` object are one contract in two files, and the failure mode
 * of a name added here and forgotten there is `__super.foo is not a function`
 * inside a sandbox — so `aniyomi-conversion.spec.ts` asserts the driver declares
 * every name below.
 */
export const SUPER_MEMBERS: ReadonlySet<string> = new Set([
	'popularAnimeParse',
	'searchAnimeParse',
	'latestUpdatesParse',
	'episodeListParse',
	'animeDetailsParse',
	'headersBuilder',
	'animeDetailsRequest',
	'episodeListRequest',
	'videoListRequest',
	'popularAnimeNextPageSelector',
	'searchAnimeNextPageSelector',
	'latestUpdatesNextPageSelector',
	'getSearchAnime',

	// The hoster API, which is the direction the base class moved: an episode
	// yields hosters and a hoster yields videos. An extension written against it
	// wraps these constantly — `super.getHosterList(episode)` and then a filter
	// over the result is the idiom — and until the driver implemented them there
	// was nothing for that to compile to.
	'getHosterList',
	'hosterListRequest',
	'hosterListParse',
	'getVideoList',
	'videoListParse',

	// Ordering. `sortVideos` is where a quality preference is applied and it is
	// overridden constantly; `sort` is the deprecated spelling its own default
	// still delegates to, so an extension that overrode only `sort` keeps
	// working. All three are extension functions on the list, so their call
	// sites carry a receiver — see `SUPER_RECEIVER_MEMBERS`.
	'sortHosters',
	'sortVideos',
	'sort',

	// Resolving one stream, which is the pre-`resolveVideo` path and is still
	// what a source with a two-step player page uses.
	'resolveVideo',
	'getVideoUrl',
	'videoUrlRequest',
	'videoUrlParse',

	// Seasons, which this ABI has no surface for. The driver implements them
	// anyway: an extension that calls through to one is usually doing it inside
	// a member we *do* call, and refusing the whole extension over a branch that
	// never runs loses a source for nothing.
	'seasonListRequest',
	'seasonListParse',

	// The remainder of the published surface, each with the base class's own
	// answer — including the ones whose answer is to refuse by name.
	'episodeVideoParse',
	'getHomeUrl',
	'getAnimeUrl',
	'getEpisodeUrl',
	'prepareNewEpisode',
	'createHttpServer',
	'getVideoThumbnails',
	'getImageTile',
	'generateId',
	'getAnimeDetails',
	'getEpisodeList',
	'getPopularAnime',
	'getLatestUpdates'
]);

/**
 * The `super.` members whose call site has a receiver to pass.
 *
 * `sortVideos`, `sortHosters` and `sort` are declared upstream as extension
 * functions on `List<Video>` / `List<Hoster>`, so an override is written
 * `override fun List<Video>.sortVideos()` and a call through to the base is
 * written `super.sortVideos()` with *no arguments* — the list it applies to is
 * the receiver, which Kotlin passes implicitly.
 *
 * This emitter moves a receiver into first position (see `functionDeclaration`),
 * so the implicit receiver has to be made explicit here too. Emitting
 * `__super.sortVideos()` instead would call the base ordering on `undefined`,
 * and the extension would silently lose the list it was sorting.
 */
export const SUPER_RECEIVER_MEMBERS: ReadonlySet<string> = new Set([
	'sortHosters',
	'sortVideos',
	'sort'
]);

/**
 * The `super.` members that fetch, and therefore suspend.
 *
 * Kotlin's `suspend` is invisible at the call site — `super.getHosterList(ep)`
 * reads like any other expression and is used as one. In JavaScript the same
 * text is a promise, and a promise that is filtered rather than awaited does
 * not fail: `__k.filter(promise, …)` walks nothing and answers an empty list.
 * That is a source that silently plays nothing, which is exactly the class of
 * failure `FOREIGN.md` §6 exists to prevent, so the await is decided here from
 * the driver's own shape rather than inferred at the call site.
 */
export const SUPER_SUSPEND_MEMBERS: ReadonlySet<string> = new Set([
	// The four `…Parse` members the driver implements asynchronously, because
	// each of them may fetch. `override fun episodeListParse(response) =
	// super.episodeListParse(response).reversed()` is the commonest use of
	// `super.` in this ecosystem, and un-awaited it reversed a *promise*:
	// `__k.reversed` was handed something that is not a list and answered an
	// empty one, so the episode list was silently empty with nothing refused.
	'episodeListParse',
	'videoListParse',
	'hosterListParse',
	'seasonListParse',

	'getSearchAnime',
	'getPopularAnime',
	'getLatestUpdates',
	'getAnimeDetails',
	'getEpisodeList',
	'getHosterList',
	'getVideoList',
	'getVideoUrl',
	'resolveVideo',
	'getVideoThumbnails',
	'getImageTile'
]);

/**
 * Parameter order for the few callees whose named arguments can be resolved.
 *
 * Kotlin lets a caller pass arguments by name in any order, and reordering them
 * needs the callee's signature. For a locally declared function or data class
 * the emitter has the signature; for everything else it has this table, and for
 * everything else again a named argument is refused. Emitting `GET(url = a,
 * headers = b)` as `GET(a, b)` without checking is how a converted request ends
 * up with its headers in the URL.
 */
export const KNOWN_SIGNATURES: ReadonlyMap<string, readonly string[]> = new Map([
	['GET', ['url', 'headers', 'cache']],
	['POST', ['url', 'headers', 'body', 'cache']],
	['Video', ['url', 'quality', 'videoUrl', 'headers', 'subtitleTracks', 'audioTracks']],
	['Track', ['url', 'lang']],

	// `Hoster(hosterUrl = …, hosterName = …)`, which is how every extension
	// written against the hoster API builds one — by name, and usually skipping
	// `videoList` so it is fetched later. Positionally it is the same order.
	['Hoster', ['hosterUrl', 'hosterName', 'videoList', 'internalData', 'lazy']],

	// The `ignoreCase` family, which this ecosystem passes by name far more
	// often than positionally: `text.contains(other, ignoreCase = true)`. Kept
	// to the four whose extra argument is a trailing boolean, because a
	// signature here becomes a positional call the runtime has to accept, and
	// filling a gap with `undefined` is only safe at the end.
	['contains', ['other', 'ignoreCase']],
	['startsWith', ['prefix', 'ignoreCase']],
	['endsWith', ['suffix', 'ignoreCase']],
	['replace', ['oldValue', 'newValue', 'ignoreCase']],
	// `header.equals("Content-Length", ignoreCase = true)` is how this
	// ecosystem compares a header name, and it is the same trailing-boolean
	// shape as the four above.
	['equals', ['other', 'ignoreCase']],

	// `AnimesPage(animes = …, hasNextPage = …)`, which a list parse returns by
	// hand. Both halves are required, so nothing is filled with `undefined`.
	['AnimesPage', ['animes', 'hasNextPage']],

	// Kotlin's own `joinToString`, in full. The runtime helper takes the same
	// order, including `limit`/`truncated` — a signature that stopped at
	// `postfix` would put the transform where the limit belongs.
	['joinToString', ['separator', 'prefix', 'postfix', 'limit', 'truncated', 'transform']],
	// Common host/extractor entry points use named arguments to make the
	// otherwise opaque request shape readable. These are all trailing optional
	// values, so reordering is safe and preserves omitted defaults.
	// PlaylistUtils overloads keep the manifest URL first, then request
	// context, naming and track lists. Use the full superset order so named
	// arguments can be lowered without guessing around omitted defaults.
	[
		'extractFromHls',
		[
			'playlistUrl',
			'referer',
			'masterHeaders',
			'videoHeaders',
			'videoNameGen',
			'subtitleList',
			'audioList'
		]
	],
	[
		'extractFromDash',
		['mpdUrl', 'videoNameGen', 'mpdHeaders', 'videoHeaders', 'referer', 'subtitleList', 'audioList']
	],
	['graphQLPost', ['url', 'query', 'variables', 'headers']]
	// `videosFromUrl` and `videoFromUrl` were here, and both were wrong.
	//
	// Every one of the 37 extractor declarations in this ecosystem puts `url`
	// first; none has `prefix` first, and none takes `videoNameGen` third. With
	// the invented order in hand, `videosFromUrl(url, prefix = "Okru: ")` was
	// emitted as `videosFromUrl('Okru: ')` — the url dropped into a slot the
	// table called `prefix`, then overwritten by the named argument, so the
	// prefix string was fetched as a url. It converted with no refusal.
	//
	// A signature cannot be guessed from a name this ecosystem reuses 37 times
	// over incompatible parameter lists. It is read from the declaration, and
	// where the declaration cannot be found the named argument is refused —
	// which is the answer this table was added to avoid and the only correct
	// one available.
]);

/**
 * Callees whose named arguments come *after* a vararg, and what they are called.
 *
 * `split(vararg delimiters: String, ignoreCase: Boolean, limit: Int)` cannot be
 * a `KNOWN_SIGNATURES` entry: there is no fixed position for `limit` when the
 * delimiters can be one or five, so reordering into slots would put the limit
 * where a delimiter goes and split on the string `"2"`.
 *
 * These become a trailing options object instead — `__k.split(text, ",",
 * { limit: 2 })` — which the runtime reads back by name. It is unambiguous
 * because every other argument in that position is a delimiter, and a
 * delimiter is a string or a Regex, never a plain object.
 */
export const VARARG_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['split', new Set(['ignoreCase', 'limit'])]
]);

/**
 * Members the host actually calls to browse, list or play something.
 *
 * `complete` — nothing we tried to translate failed — is a true statement and
 * an insufficient one. An extension that extends a shared template declares
 * almost nothing of its own: every real method lives in the template, which is
 * not in the file. Everything it *does* declare then translates, `complete`
 * comes back true, and the bundle packages, installs, loads, and answers a
 * search with silence. That is the "looks like it works and does not" outcome
 * `FOREIGN.md` §6 exists to prevent, arrived at from the opposite direction —
 * not by translating something wrongly, but by translating nothing and calling
 * it a success.
 *
 * So a conversion also reports whether it produced any of these. One is the
 * minimum a bundle can be built from; none means there is nothing to build.
 */
export const ABI_MEMBERS: ReadonlySet<string> = new Set([
	'popularAnimeRequest',
	'popularAnimeParse',
	'popularAnimeFromElement',
	'latestUpdatesRequest',
	'latestUpdatesParse',
	'latestUpdatesFromElement',
	'searchAnimeRequest',
	'searchAnimeParse',
	'searchAnimeFromElement',
	'animeDetailsParse',
	'episodeListParse',
	'episodeFromElement',
	'videoListParse',
	'getVideoList',
	'videoFromElement',
	'videosFromElement'
]);

/**
 * Everything the host, or the base class on its behalf, calls by name.
 *
 * These are the roots of the reachability walk in `pipeline.ts`. `ABI_MEMBERS`
 * is what a caller asks for; this is wider, because the base class reaches back
 * into the source for its selectors and its configuration while answering one
 * of those asks — `popularAnimeParse` calls `popularAnimeSelector` and
 * `popularAnimeFromElement`, and neither is anything the host names itself.
 *
 * Wider than strictly necessary on purpose. A name missing from here is a
 * member that gets pruned from the closure and then refuses nothing when it
 * fails — which turns a refusal into `undefined is not a function` inside a
 * sandbox. The cost of an extra name is one member kept.
 */
export const HOST_ENTRY_POINTS: ReadonlySet<string> = new Set([
	...ABI_MEMBERS,

	// configuration the base reads on every call
	'name',
	'baseUrl',
	'lang',
	'supportsLatest',
	'client',
	'headers',
	'headersBuilder',
	'json',
	'preferences',
	'id',
	'versionId',

	// requests
	'animeDetailsRequest',
	'episodeListRequest',
	'videoListRequest',
	'getSearchAnime',

	// selectors the base parsers reach back for
	'popularAnimeSelector',
	'popularAnimeNextPageSelector',
	'latestUpdatesSelector',
	'latestUpdatesNextPageSelector',
	'searchAnimeSelector',
	'searchAnimeNextPageSelector',
	'episodeListSelector',
	'videoListSelector',

	// the rest of the play path
	'videoUrlParse',
	'videoFromElement',
	'videosFromElement',
	'sortVideos'
]);

/* ── which refusals actually block ────────────────────────────────────────── */

/**
 * Members whose refusal costs the host nothing, because the host does that job.
 *
 * The same list `themes/convert.ts` keeps and for the same reason: settings and
 * filters are declared in the manifest and drawn by the host on every surface
 * (`ABI.md` §1), and per-host stream extractors are deliberately not ported
 * into this repository at all (`FOREIGN.md` §4.1.3). `setupPreferenceScreen` is
 * read by the *converter* — `foreign/preferences.ts` derives the manifest's
 * `settings` from it statically — and nothing calls it at runtime, so refusing
 * an override nobody invokes is not the same kind of event as refusing
 * `videoListParse`.
 *
 * This does **not** soften the refusal discipline. Every refusal is still
 * reported and still named; this only says which of them a caller should treat
 * as a reason to stop. Getting that distinction wrong in the other direction —
 * treating a refused `episodeListParse` as harmless — is the failure the whole
 * module exists to prevent, so the list is short, explicit, and contains
 * nothing that returns data.
 */
const HOST_DRAWN_MEMBERS: ReadonlySet<string> = new Set([
	'preferences',
	'setupPreferenceScreen',
	'getFilterList',
	'sortVideos',
	'getPreferenceKey',
	'restartApp'
]);

/** True when refusing this member does not stop a bundle from being built. */
export function isHostDrawn(member: string): boolean {
	if (HOST_DRAWN_MEMBERS.has(member)) return true;
	// Named by convention throughout this ecosystem, and both are out of scope.
	return /Filters?$|[Ee]xtractor$|^PREF_|Preference$/.test(member);
}

/* ── the sentence ─────────────────────────────────────────────────────────── */

/**
 * The refusal, in `matchTheme`'s voice.
 *
 * Counts the obstacles, names them with the member and line they sit on, and
 * closes with what converting anyway would cost. The closing clause is not
 * decoration: without it a reader assumes the tool is being fussy, and the
 * whole point is that the alternative is a plugin that looks like it works.
 */
export function describeRefusals(refusals: readonly Refusal[]): string {
	const total = refusals.reduce((sum, one) => sum + one.obstacles.length, 0);
	if (total === 0) return '';

	const parts = refusals.map((one) => {
		const named = one.obstacles.map((o) => `\`${o.kind}\`, line ${o.line}`).join('; ');
		return `\`${one.member}\` (${named})`;
	});

	return (
		`This extension uses ${total} Kotlin construct${total === 1 ? '' : 's'} Yorozo cannot ` +
		`translate, in ${joinList(parts)}. Converting it anyway would produce a plugin that ` +
		'looks like it works and does not.'
	);
}

function joinList(parts: readonly string[]): string {
	if (parts.length <= 1) return parts[0] ?? '';
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/* ── scanning ─────────────────────────────────────────────────────────────── */

/**
 * Every syntactic obstacle in a subtree, in source order.
 *
 * Run *before* a member is translated, so a refusal can list all three problems
 * rather than whichever one the emitter tripped over first. It answers three
 * questions in one pass, in this order of severity:
 *
 * 1. Is there an `ERROR` or `MISSING` node? tree-sitter recovers from a parse
 *    failure by guessing, and a recovered subtree looks structurally fine — so
 *    one anywhere under a member refuses that member outright. A selector read
 *    out of a guessed parse is a wrong selector, not a missing one.
 * 2. Does the text name something out of reach — `Injekt.get`, `WebView`,
 *    `javax.crypto`?
 * 3. Is the node kind one the emitter has no handler for?
 *
 * Descent stops at the first obstacle on a branch, because everything under a
 * refused construct is a consequence rather than a separate problem.
 */
export function scanObstacles(node: KNode, memberName: string): Untranslatable[] {
	const found: Untranslatable[] = [];
	scanInto(node, memberName, found);
	return found;
}

/** Kinds the grammar makes named children and nothing should read as code. */
export const COMMENT_KINDS: ReadonlySet<string> = new Set([
	'line_comment',
	'multiline_comment',
	'shebang_line'
]);

function scanInto(node: KNode, memberName: string, found: Untranslatable[]): void {
	// A comment mentioning `WebView` is prose, not a WebView. Scanning one would
	// refuse a member for what its author wrote *about* the code.
	if (COMMENT_KINDS.has(node.type)) return;

	// `hasError` rather than only a node *typed* ERROR.
	//
	// tree-sitter recovers by guessing, and a recovery does not always leave an
	// ERROR node behind: a `when` whose entry body ran on past the newline
	// reports `hasError` on the `when_expression` itself while every node under
	// it has an ordinary type. Scanning for the type alone therefore missed it,
	// the member translated against the guess, and the emitted JavaScript both
	// took the wrong branch and was not parseable — a conversion that reported
	// complete with no refusal at all.
	//
	// `emitKotlin`'s own header comment already states the policy this restores:
	// an error is fatal to whichever member contains it.
	if (node.type === 'ERROR' || node.isMissing || node.hasError) {
		found.push({
			kind: 'a passage this build could not parse',
			line: node.line,
			memberName
		});
		return;
	}

	const outOfScope = OUT_OF_SCOPE_KINDS.get(node.type);
	if (outOfScope !== undefined) {
		found.push({ kind: outOfScope, line: node.line, memberName });
		return;
	}

	// The one question a leaf cannot answer. `"AES"` is a supported key
	// algorithm and an unsupported cipher mode, and only the call it sits in
	// says which — so it is asked here, of the call, where `Cipher.getInstance`
	// is still visible above the string.
	if (node.type === 'call_expression') {
		const transformation = factoryTransformation(node.text);
		if (transformation !== null) {
			const refused = cryptoObstacle(transformation, true);
			if (refused !== null) {
				found.push({ kind: refused, line: node.line, memberName });
				return;
			}
		}
	}

	// Named obstacles are matched on the smallest node whose text contains
	// them, so the reported line is the call rather than the whole method.
	//
	// Type names are exempt: nothing here emits a type, so a parameter declared
	// `screen: PreferenceScreen` mentions the preference framework without
	// touching it. Matching on a type refuses a member for its signature.
	if (node.children.length === 0 && node.type !== 'type_identifier') {
		const named = namedObstacle(node.text);
		if (named !== null) {
			found.push({ kind: named, line: node.line, memberName });
			return;
		}
	}

	if (!SUPPORTED_KINDS.has(node.type) && node.type !== node.text) {
		found.push({ kind: node.type, line: node.line, memberName });
		return;
	}

	for (const child of node.children) scanInto(child, memberName, found);
}

/** Node kinds under this one with no handler. For the survey and the specs. */
export function unsupportedKinds(node: KNode): string[] {
	const out = new Set<string>();
	for (const found of walk(node)) {
		// A punctuation node's kind is its own text; those never reach dispatch.
		if (found.type === found.text) continue;
		if (!SUPPORTED_KINDS.has(found.type) && !OUT_OF_SCOPE_KINDS.has(found.type)) {
			out.add(found.type);
		}
	}
	return [...out].sort();
}

/**
 * Helpers the emitter reaches for without a table, because the construct that
 * needs them is syntax rather than a name.
 *
 * Listed so the contract check covers them: a `!!` emitting `__k.nn` is exactly
 * as capable of drifting from the runtime as a `.mapNotNull` is.
 */
export const SYNTAX_HELPERS: readonly string[] = [
	'nn',
	'sc',
	'lazy',
	'isType',
	'cast',
	'castOrNull',
	'range',
	'until',
	'to',
	'downTo',
	'bitwiseAnd',
	'bitwiseOr',
	'bitwiseXor',
	'awaitAll',
	'async',
	'unsupported',
	'error',
	'decode',
	'destructured',
	'synchronized',
	'index',
	'setIndex'
];

/** Helper names referenced by the tables, for the spec that checks the contract. */
export function referencedHelpers(): string[] {
	const names = new Set<string>([
		...EXTENSION_METHODS.values(),
		...EXTENSION_PROPERTIES.values(),
		...FREE_FUNCTIONS.values(),
		...SYNTAX_HELPERS
	]);
	return [...names].sort();
}

/** True when every helper the tables name is one the runtime promises. */
export function helpersAreDeclared(): boolean {
	const declared = new Set<string>(RUNTIME_HELPERS);
	return referencedHelpers().every((name) => declared.has(name));
}
