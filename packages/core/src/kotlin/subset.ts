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
	'object_literal',
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
	// `List<AnimeFilter<out Any>>`, `Array<out X509Certificate>` — use-site
	// variance, the container `variance_modifier` sits in when it is written
	// on a type argument rather than a type parameter. A type is never
	// emitted, so what it says about subtyping says nothing at run time.
	'type_projection_modifiers',
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
/**
 * A `when`'s `else ->` that the branch above it swallowed — a defect in the
 * vendored grammar, not in the Kotlin.
 *
 *     when (filter) {
 *         is TextFilter -> if (filter.state.isNotBlank()) { … }
 *         else -> Unit
 *     }
 *
 * Kotlin reads that `else` as the `when`'s last entry. The grammar attaches it
 * to the `if` instead, which leaves the entry's arrow with nowhere to go and
 * parses it as an `ERROR` node holding the two characters `->`. So the marker
 * is unmistakable: an `if_expression` whose `else` is followed immediately by
 * an `ERROR` whose whole text is `->`.
 *
 * It matters because it is not rare. `-> if (…) { … }` followed by another
 * entry is ordinary in this ecosystem's filter code, and every occurrence
 * refused the whole member as "a passage this build could not parse" —
 * including `Madara.addFilters`, and with it the largest template in the
 * catalogue.
 *
 * Returns the body that really belongs to the `when`, so both halves of this
 * build can repair it: the scan forgives the marker, and the emitter moves the
 * branch back where it was written.
 */
export function swallowedWhenElse(node: KNode): { marker: KNode; branch: KNode } | null {
	if (node.type !== 'if_expression') return null;
	const parts = node.allChildren;
	const at = parts.findIndex((child) => child.type === 'else');
	if (at === -1) return null;
	const marker = parts[at + 1];
	const branch = parts[at + 2];
	if (marker === undefined || marker.type !== 'ERROR' || marker.text.trim() !== '->') return null;
	if (branch === undefined || branch.type !== 'control_structure_body') return null;
	return { marker, branch };
}

export const OUT_OF_SCOPE_KINDS: ReadonlyMap<string, string> = new Map([
	// `object_literal` was here. `object : Callback { … }` is an anonymous
	// implementation of an interface, and a JavaScript object literal is the
	// same expression — so the emitter writes one, and refuses the two shapes
	// it cannot express faithfully (a constructed base, a bare `this`) by name
	// rather than refusing the construct. See `objectLiteral` in `emit.ts`.

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
	// `Interceptor` was here, refused by name. It is not refused any more: an
	// okhttp *application* interceptor wraps one call, and `__proceed` in the
	// runtime runs the chain inside the sandbox with the same reach the plugin
	// already had.
	//
	// A **network** interceptor is a different hook and is still refused. It
	// sits between the client and each individual hop of a redirect chain; the
	// host follows redirects itself and reports only where they ended, so there
	// are no per-hop connections here for one to wrap. Refused at the line that
	// installs it rather than at the runtime, because it can never run: a
	// conversion that succeeds and then throws on the first request is the
	// outcome this file exists to avoid.
	{ pattern: /\baddNetworkInterceptor\b/, name: 'an okhttp network interceptor' },
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
	// anywhere — which is a worse answer than refusing the pause. The pause is
	// answered one level up instead, where the call is visible: see the
	// `Thread.sleep` exemption in `scanInto`.
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
	//
	// Still the rule for every leaf. The two chains that do have an answer —
	// `CLASS_LOADER` and `SIMPLE_NAME` below — are exempted whole, at call
	// level in `scanInto`, so what reaches this pattern is everything else.
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
	'AES/GCM/NOPADDING',
	// Not WebCrypto's: the runtime computes RC4 itself (see `__rc4`), because it
	// is a short, fully specified stream cipher with published test vectors.
	// It also names the key, `SecretKeySpec(key, "RC4")`, in the same spelling.
	'RC4',
	'ARCFOUR',
	'RC4/ECB/NOPADDING',
	'ARCFOUR/ECB/NOPADDING'
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
 * - **No DES, DESede, RC2, Blowfish or ChaCha20.** None exist in WebCrypto,
 *   and a block cipher is not something to reimplement here. RC4 is the one
 *   exception, computed in the runtime: a stream cipher of a dozen lines with
 *   RFC 6229's vectors to check it against, and no mode or padding to get
 *   wrong.
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
	//
	// Matched on the shape a curve name actually has — a family, a bit length,
	// then its variant — and not on the family prefix alone. `sect` followed by
	// anything was a curve here, so every `"section"` and `"sections"` a scraper
	// passes as a query parameter or a CSS selector refused its extension as
	// asking for an elliptic curve: fourteen listings, over an English word.
	if (/^(?:secp\d+[kr]\d|prime\d+v\d|brainpoolP\d+[rt]\d|sect\d+[kr]\d)$/.test(text)) {
		return /^(?:secp256r1|prime256v1|secp384r1|secp521r1)$/.test(text)
			? null
			: `the \`${text}\` curve`;
	}
	return null;
}

/**
 * `Injekt.get<Application>().getSharedPreferences(…)`, whitespace squeezed out.
 *
 * The one use of the dependency-injection container this build answers rather
 * than refuses; see the call-level exemption in `scanInto` for why it is
 * matched on the call and not on a leaf. The preference name and mode are not
 * inspected — whatever an extension passes, it is asking for its own store,
 * and the runtime has exactly one.
 */
const APPLICATION_PREFERENCES = /\bInjekt\.get<Application>\(\)\.getSharedPreferences\(/;

/**
 * `Injekt.get<Json>()`, or a property typed `Json` initialised by a bare
 * `Injekt.get()`, whitespace squeezed out. See the exemption in `scanInto`.
 */
const INJECTED_JSON =
	/^(?:Injekt\.get<Json>\(\)|(?:(?:private|internal|public)?(?:val|var))\w+:Json=Injekt\.get(?:<Json>)?\(\))$/;

/**
 * The classpath, in the two spellings this ecosystem writes it in.
 *
 * `this::class.java.classLoader` and `javaClass.classLoader` are one idiom, and
 * the split is not stylistic: the first is what `MadaraBase` writes and the
 * second is what `MangaThemesia` writes, which between them is most of the
 * catalogue. Measured over 300 listings of a real repository, 62 blocked
 * listings named the first and 18 the second — one idiom in two spellings,
 * which is the shape the `Application` primitive above turned out to have too.
 *
 * It is here rather than in `emit.ts` because both files have to agree about
 * it. The emitter turns the chain into `__k.classLoader()`; the scanner has to
 * stop refusing `javaClass` for the length of that chain and no further, which
 * is the same call-level exemption `APPLICATION_PREFERENCES` gets and for the
 * same reason — a leaf sees `javaClass` alone and cannot tell a class *path*,
 * which the runtime can answer, from a class *name*, which it cannot.
 * `javaClass.simpleName` stays refused.
 *
 * The trailing `!!` is a sibling in the tree rather than part of this node, so
 * it is not in the pattern; `nn()` wraps the result as it does anywhere else.
 */
export const CLASS_LOADER =
	/^(?:(?:[A-Za-z_][\w.]*|this)::class\.java|(?:this\.)?javaClass)\.classLoader$/;

/**
 * A class's simple name, in the two places this ecosystem asks for one.
 *
 * The earlier refusal of `javaClass` said that an answer right for a log tag
 * would be wrong for every other use of reflection. That is true of reflection
 * and not of this chain: `simpleName` is one question with one answer, and
 * over two real repositories (yuzono and keiyoushi, 83 sites) every use of it
 * is either a log tag — `private val tag by lazy { javaClass.simpleName }` — or
 * an exception's class inside the text of a `Log.w`. The one exception is
 * keiyoushi's `KeiSource`, which compares an *interceptor's* name and is
 * refused for the interceptor long before this matters.
 *
 * Both halves are answered, differently, by `emit.ts`:
 *
 * - no receiver, or `this.` — the class being emitted. Its Kotlin name is
 *   known statically, and for a class nothing can subclass that *is* the
 *   answer. An open or abstract one asks the runtime, because `javaClass` is
 *   the class of the instance, and a template's `tag` is its subclass's name.
 * - a named value, `e.javaClass.simpleName` — only inside the arguments of a
 *   `Log` call. This runtime erases exception types (`IOException("x")` is an
 *   `Error`), so the honest answer for a caught exception is not the Kotlin
 *   one; confined to a log line it changes what a diagnostic reads and
 *   nothing a plugin does. Anywhere else the emitter refuses it by name.
 *
 * `?.` and anything longer than one identifier on the left stay refused.
 */
export const SIMPLE_NAME = /^(?:this\.|([a-z_]\w*)\.)?javaClass\.simpleName$/;

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
	// Kotlin's Map transforms, each answering a Map — see the runtime.
	['mapValues', 'mapValues'],
	['mapKeys', 'mapKeys'],
	['filterKeys', 'filterKeys'],
	['filterValues', 'filterValues'],
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
	// kotlinx's `T.toJsonElement()`, which this catalogue's filter code uses to
	// turn a DTO list into something it can store. See the helper.
	['toJsonElement', 'toJsonElement'],
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
	// MutableList sorts reorder the receiver and answer Unit.
	['sortBy', 'sortBy'],
	['sortByDescending', 'sortByDescending'],
	['sortWith', 'sortWith'],
	['sortDescending', 'sortDescending'],
	// Compute only when the map has no non-null value under the key.
	['getOrPut', 'getOrPut'],
	['reversed', 'reversed'],
	['distinct', 'distinct'],
	['take', 'take'],
	['drop', 'drop'],
	['joinToString', 'joinToString'],
	['joinTo', 'joinTo'],
	['mapTo', 'mapTo'],
	// `sequence.toCollection(chapters)`, which is how a paginated chapter walk
	// appends each page onto the list it returns. The destination is a
	// `mutableListOf()` or a set the caller declared, and it is the answer.
	['toCollection', 'toCollection'],
	// The reified argument is the constructor, so these are an `instanceof`
	// — see the helpers for why a type-blind fallback would be worse than
	// a refusal.
	['firstInstance', 'firstInstance'],
	['firstInstanceOrNull', 'firstInstanceOrNull'],
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
	// The NotNull variant also drops nulls; catchingMap already skips failed
	// transforms and null results. Only its parallelism is lost in the sandbox.
	['parallelCatchingMapNotNull', 'catchingMap'],
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
	// **And the three names that replaced it.** `tryParse` is `@Deprecated` in
	// the catalogue's own `core/utils/Date.kt`, and the catalogue has moved on
	// — knowing only the old spelling refused the entire `MangaThemesia`
	// template and every `Keyoapp` one, which between them are 130 extensions.
	// All three answer epoch millis or 0; the distinctions upstream draws
	// between them are about which fields the *pattern* carries, and the
	// runtime reads the pattern either way.
	['tryParseDate', 'tryParseDate'],
	['tryParseDateTime', 'tryParseDateTime'],
	['tryParseZonedDateTime', 'tryParseZonedDateTime'],
	// An Instant read as milliseconds — a helper rather than a passthrough
	// because `(Clock.System.now() - duration)` is JavaScript subtraction on
	// the two values' `valueOf`, and answers the number the Instant held.
	['toEpochMilliseconds', 'toEpochMilliseconds'],
	['toJavaInstant', 'toJavaInstant'],
	['toKotlinInstant', 'toJavaInstant'],

	// keiyoushi's two "…or null" readers over jsoup, where blank means absent.
	['textOrNull', 'textOrNull'],
	['attrOrNull', 'attrOrNull'],

	// request bodies, in the shape `__bodyOf` already understands
	['toMediaType', 'toMediaType'],
	['toMediaTypeOrNull', 'toMediaType'],
	['toRequestBody', 'toRequestBody'],
	['toJsonBody', 'toJsonBody'],
	['toJsonRequestBody', 'toJsonRequestBody'],
	// …and the body an interceptor puts on a response it rewrote. okio's
	// `asResponseBody` is deliberately absent: it reads a `Buffer`, and there
	// are no okio streams here to read.
	['toResponseBody', 'toResponseBody'],

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
	['length', 'jsonLength'],
	// Measured stdlib gaps. The nullable number reader already has the same
	// double-precision result; the remaining helpers live in the runtime.
	['toDoubleOrNull', 'toFloatOrNull'],
	['filterNotNull', 'filterNotNull'],
	['maxOf', 'maxOf'],
	['replaceAll', 'replaceAll'],
	['mapNotNullTo', 'mapNotNullTo'],
	['toMap', 'toMap']
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
	// `json.decodeFromJsonElement<Foo>(element)` — the same call whose payload
	// is already parsed rather than text. `decode` reads a non-string payload
	// as the parsed value, so only the name was missing.
	'decodeFromJsonElement',
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
	'putJsonArray',
	// RxJava's two deferring constructors. The lambda *is* the argument here —
	// `Observable.fromCallable { … }` means "run this when somebody asks" —
	// which is the same shape the two above have and the reason this table
	// exists rather than a second one.
	'fromCallable',
	'defer'
]);

/**
 * Methods whose trailing lambda is an ordinary *parameter* lambda, not a
 * receiver one.
 *
 * `BUILDER_LAMBDA_METHODS` above hands the block a receiver — `putJsonObject {
 * put(…) }` is written against the object being built. These are the other
 * shape: `client.newBuilder().addInterceptor { chain -> … }` is Kotlin's SAM
 * conversion of a one-method interface, so the block takes the chain as an
 * argument and `it` is bound to it.
 *
 * Kept apart because emitting one as the other is silent: a receiver-form
 * block has no `it`, so `addInterceptor { it.proceed(it.request()) }` — which
 * is how most of them are written — refused for an `it` with no lambda around
 * it, naming a construct the source never wrote.
 */
export const ARGUMENT_LAMBDA_METHODS: ReadonlySet<string> = new Set([
	'addInterceptor',
	// keiyoushi's `addCookie { listOf("k" to v) }`: the lambda is the cookies,
	// asked for at each request so a preference can change them.
	'addCookie',
	// Observable takes each block as a function of the value or error.
	'doOnNext',
	'onErrorReturn'
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
	['destructured', 'destructured'],
	// `Char.code`. A Char is a one-character string here, so the read came out
	// as a property of a string — `undefined` — and `ch.code - '0'.code` was
	// NaN: the unpacker module's radix parser answered NaN for every word and
	// returned its packed input unchanged, with nothing refused. The name is
	// also okhttp's `response.code`, which the helper hands straight back.
	['code', 'code'],
	// kotlinx's JsonElement accessors. A JsonElement is the plain parsed value
	// here, so every one of these was a property read that answered
	// `undefined` — `.jsonPrimitive.content` threw on a good document and its
	// `?.` spelling answered null, nothing refused. Each helper defers to a
	// receiver that really has the property, because these are ordinary field
	// names too; see `jeObject` in the runtime.
	['jsonObject', 'jeObject'],
	['jsonArray', 'jeArray'],
	['jsonPrimitive', 'jePrimitive'],
	['jsonNull', 'jeNull'],
	['content', 'jeContent'],
	['contentOrNull', 'jeContentOrNull'],
	['isString', 'jeIsString'],
	['int', 'jeInt'],
	['intOrNull', 'jeIntOrNull'],
	['long', 'jeLong'],
	['longOrNull', 'jeLongOrNull'],
	['double', 'jeDouble'],
	['doubleOrNull', 'jeDoubleOrNull'],
	['float', 'jeFloat'],
	['floatOrNull', 'jeFloatOrNull'],
	['boolean', 'jeBoolean'],
	['booleanOrNull', 'jeBooleanOrNull'],
	// A Kotlin Map's views. A JS Map spells these as *methods* and a
	// JsonObject has none, so each was a property read that answered the
	// method or undefined — `m.values.joinToString()` was empty, nothing
	// refused. Deferring to a receiver that has the property, as above.
	['keys', 'kKeys'],
	['values', 'kValues'],
	['entries', 'kEntries']
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
	// kotlinx's JsonDecoder, as a KSerializer's `deserialize` is handed it by
	// the typed decoder (`__jsonDecoder` in the runtime). The `encode*` half
	// is what the same object's `serialize` writes; the runtime never calls
	// one, and refuses to encode a record whose class names a serializer.
	'decodeJsonElement',
	'decodeString',
	'decodeInt',
	'decodeLong',
	'decodeDouble',
	'decodeFloat',
	'decodeBoolean',
	'decodeNull',
	'decodeNotNullMark',
	'encodeString',
	'encodeInt',
	'encodeLong',
	'encodeDouble',
	'encodeBoolean',
	'encodeNull',
	'encodeJsonElement',
	// The classpath, and the one question this ecosystem asks a `Locale`.
	//
	// `getResourceAsStream(name)` is the read at the bottom of `Intl`, and
	// `__k.classLoader()` is what it is called on — a loader over the files the
	// conversion fetched beside the Kotlin, not the whole of a JVM classpath. A
	// name that was never fetched answers null, which is what the JVM answers
	// too, so the `Intl` above it falls back to its base language exactly as it
	// would on a device.
	//
	// `getDisplayName` is a language's name in another language. ABI.md §6 says
	// the host owns those and the bundle has no `Intl` global, so the runtime's
	// answer is the tag itself unless it is one of the languages this ecosystem
	// actually serves — see the table for why that is a short list rather than
	// all of ISO 639.
	'getResourceAsStream',
	'getDisplayName',

	// The Rx-era doors on a Call, and the operators on what they answer.
	// Emitted unchanged because `__observable` defines them — see it for
	// why an Observable here is a promise with a `map`.
	'asObservable',
	'asObservableSuccess',
	'doOnNext',
	'onErrorReturn',
	'subscribeOn',
	'observeOn',
	'toBlocking',
	'single',
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
	// kotlinx-datetime's reading in seconds. The milliseconds one is a helper
	// (`EXTENSION_METHODS`), because its receiver may already be a number.
	'toEpochSeconds',
	// The rest of java.time as `kotlin-time.ts` implements it: moving a date,
	// putting it in a zone, reading it back. Every one is a method the
	// runtime's temporals define; the names are java.time's own and nothing
	// else in the catalogue spells them.
	'atStartOfDay',
	'atZone',
	'atOffset',
	'atTime',
	'withZone',
	'withLocale',
	'withZoneSameInstant',
	'withZoneSameLocal',
	'withOffsetSameInstant',
	'plusYears',
	'plusMonths',
	'plusWeeks',
	'plusDays',
	'plusHours',
	'plusMinutes',
	'plusSeconds',
	'plusNanos',
	'plusMillis',
	'minusYears',
	'minusMonths',
	'minusWeeks',
	'minusDays',
	'minusHours',
	'minusMinutes',
	'minusSeconds',
	'minusNanos',
	'minusMillis',
	'truncatedTo',
	'isBefore',
	'isAfter',
	'isEqual',
	'toLocalDate',
	'toLocalDateTime',
	'toOffsetDateTime',
	'toZonedDateTime',
	'toEpochSecond',
	'toEpochDay',
	'getEpochSecond',
	'lengthOfMonth',
	'lengthOfYear',
	'isLeapYear',
	'withDayOfMonth',
	'withDayOfYear',
	'withMonth',
	'withYear',
	'withHour',
	'withMinute',
	'withSecond',
	'withNano',
	'getRules',
	'getOffset',
	'getTotalSeconds',
	'getZone',
	'getDayOfWeek',
	'getDayOfMonth',
	'getMonthValue',
	'getYear',
	'normalized',
	// `ChronoUnit.DAYS.between(a, b)`: a navigation receiver, which is not the
	// capitalised-name passthrough, so the name has to be listed.
	'between',
	// `TimeZone.getTimeZone(id).toZoneId()` and the SimpleDateFormat pair.
	'toZoneId',
	'setTimeZone',
	'getTimeZone',
	// okhttp's CacheControl.Builder, whose every setting the host decides.
	'maxStale',
	'minFresh',
	'onlyIfCached',
	'noTransform',
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
	// `cipher.init(mode, key, cipher.getParameters())` — how an RC4 key is set
	// up, with the parameters RC4 does not have. The shim answers null, as the
	// JCE does; the property spelling `cipher.parameters` reads the same field.
	'getParameters',
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
	// okhttp's request side: an interceptor's `request.newBuilder()
	// .removeHeader("Referer")`, the label a request carries back on its
	// response (`tag`), a Content-Length written by hand from `contentLength()`,
	// and `peekBody(n)` — the first n bytes, without consuming the body.
	'removeHeader',
	'tag',
	'contentLength',
	'peekBody',
	'cacheControl',
	// okhttp's MultipartBody.Builder.
	'setType',
	'addFormDataPart',
	'addPart',
	// keiyoushi's `addCookie`, a Cookie header on the source's own requests —
	// see the client builder in the runtime for what it does and does not do.
	'addCookie',
	// `response.newBuilder().code(200).message("OK")` — the reason phrase an
	// interceptor writes when it turns a 404 into an empty page. The builder
	// records it and the built response carries it as `message`.
	'message',
	'headers',
	'header',
	'request',
	// `client.newBuilder().addInterceptor(…)`, the one line that installs one.
	// The network variant is here too so that it reaches the runtime, which
	// refuses it by name with a sentence about redirects — a refusal a reader
	// can act on, rather than one about the word `Interceptor` appearing.
	'addInterceptor',
	// The okhttp interceptor chain: `chain.request()` reads what it was handed
	// and `chain.proceed(request)` runs the rest. `intercept` is the member an
	// extension's own `Interceptor` class declares, called by name from the
	// runtime. See `__proceed`.
	'proceed',
	'intercept',
	// `response.newBuilder().body(…).build()`, which is how an interceptor
	// hands back something other than what it was given.
	'newBuilder',
	'url',
	'location',
	'headersOf',
	'isSuccessful',
	'close',
	// okhttp's `Response.closeQuietly()`, which this ecosystem calls on a
	// response it is discarding. The host buffers the whole body before the
	// extension sees it, so both are already nothing to do — but a name that is
	// absent dies in the sandbox rather than refusing here.
	'closeQuietly',
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
	// The encoded pair of the segment builders, and the two setters — a source
	// that composed a path itself passes it through these so its separators are
	// not re-encoded into `%2F`.
	'addEncodedPathSegments',
	'setPathSegment',
	'setEncodedPathSegment',
	// The rest of HttpUrl.Builder: the whole query at once (`query(null)` is how
	// this catalogue strips one), one segment out, an encoded parameter set, and
	// the authority's parts.
	'query',
	'encodedQuery',
	'removePathSegment',
	'addEncodedPathSegment',
	'setEncodedQueryParameter',
	'removeAllEncodedQueryParameters',
	'username',
	'password',
	'port',
	'queryParameterValues',
	// android.net.Uri.Builder, which the runtime answers with the same builder:
	// `Uri.parse(u).buildUpon().appendQueryParameter("s", q)`.
	'buildUpon',
	'appendQueryParameter',
	'appendPath',
	'appendEncodedPath',
	'clearQuery',
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

	// SharedPreferences, read. `Application.getSharedPreferences("source_$id",
	// MODE_PRIVATE)` is how ext-lib 16 tells an extension to reach its own
	// store, having removed `getSourcePreferences()`. The receiver resolves to
	// the runtime's `Application` and this is the only method asked of it, so
	// without the gate the whole idiom converts up to its last step and then
	// refuses on the call that was the point of it.
	'getSharedPreferences',

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

	// `protected val preferences = getPreferences()` — the plain-call spelling
	// of the delegate `emit.ts` already resolves. Without it the bare call fell
	// through to `this.getPreferences()`, which is the right default for a
	// member the base supplies and wrong here: the driver supplies no such
	// member, so the bundle died at load with `this.getPreferences is not a
	// function`. Four of the measured bundles, and `Keyoapp` and `Kemono` are
	// both written this way.
	['getPreferences', 'prefs'],

	// `delay(300.milliseconds)` between retries. It suspends, so it is awaited.
	['delay', 'delay'],
	// kotlin.math's free functions. Each needs an explicit import in Kotlin, and
	// without an entry here a bare `abs(x)` read as a member the base class
	// supplies and came out `this.abs(x)` — unrefused, and a TypeError on the
	// first call. PlaylistUtils' quality normaliser, which every HLS extraction
	// runs, is `STANDARD_QUALITIES.minByOrNull { abs(it - intQuality) }`.
	// Named `math*` so they cannot collide with the collection helpers of the
	// same Kotlin spelling (`list.maxOf { … }` is a different function). A
	// class's own `min`/`max` still wins; see `declaresOwn` in `emit.ts`.
	['abs', 'mathAbs'],
	['min', 'mathMin'],
	['max', 'mathMax'],
	['ceil', 'mathCeil'],
	['floor', 'mathFloor'],
	['round', 'mathRound'],
	['sqrt', 'mathSqrt'],
	['log10', 'mathLog10'],
	['sign', 'mathSign'],
	['maxOf', 'mathMaxOf'],
	['minOf', 'mathMinOf'],
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
	['buildSet', 'buildSet'],
	['buildMap', 'buildMap'],
	['buildJsonObject', 'buildJsonObject'],
	['buildJsonArray', 'buildJsonArray'],

	// `require(x) { "…" }` and `requireNotNull(x) { "…" }`, which throw
	['require', 'require'],
	['requireNotNull', 'requireNotNull'],
	// …and their `check` siblings, which throw the same way for a state the
	// extension did not expect rather than an argument it was handed.
	['check', 'check'],
	['checkNotNull', 'checkNotNull'],

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
	'Arrays',
	// `object : Interceptor { … }` and `class X : Interceptor` — the type an
	// extension names when it writes one out rather than passing a lambda. The
	// runtime calls `intercept` by name, so the interface itself carries no
	// behaviour; it is here so that naming it resolves.
	'Interceptor',
	'CacheControl',
	/* See `RUNTIME_GLOBALS`: the shared modules' default constructor headers. */
	'commonEmptyHeaders',
	/* `TimeZone.getTimeZone("UTC")`, which 115 sources set on a date format,
	   and `Regex.escape(literal)`, which is the companion rather than the
	   constructor. Both are capitalised receivers the emitter passes through, so
	   an absent name is a death at load rather than a refusal. */
	'TimeZone',
	'Regex',
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
	'Application',
	'AnimesPage',
	'AnimeFilterList',
	'RegexOption',
	'Observable',
	'UpdateStrategy',
	'AnimeUpdateStrategy',
	'SMangaUpdate',
	'SimpleDateFormat',
	'DateTimeFormatter',
	'Locale',
	'Calendar',
	'Base64',
	'Charsets',
	'StandardCharsets',
	'JsonObject',
	'LruCache',
	// `java.lang.ref`'s two holders, which a template caches a fetched map in.
	'SoftReference',
	'WeakReference',
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

	// The manga half. `SManga`, `Filter` and `FilterList` are the video
	// ecosystem's names one rename earlier and the runtime aliases them;
	// `SChapter`, `Page` and `MangasPage` are its own. The nested filter types
	// follow `TriState` above: an `import …model.Filter.Select` writes them
	// bare.
	'SManga',
	'SChapter',
	'Page',
	'MangasPage',
	'Filter',
	'FilterList',
	'Select',
	'Text',
	'Group',
	'Sort',
	'Header',
	'Separator',

	// `java.text.Normalizer`, `android.text.Html` and java.time's instants.
	'Normalizer',
	'Html',
	'Instant',
	'OffsetDateTime',
	'ZonedDateTime',
	'LocalDateTime',
	// okhttp's MultipartBody, whose `FORM` is read off the type itself.
	'MultipartBody',
	// The rest of the java.time subset, and kotlin.time's Clock and Duration —
	// see `RUNTIME_GLOBALS` for why each has to be a name.
	'LocalDate',
	'ZoneId',
	'ZoneOffset',
	'ChronoUnit',
	'ChronoField',
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
	'JsonNull'
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
const SUPER_MEMBERS_VIDEO: ReadonlySet<string> = new Set([
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
 * The same, for the image medium — and the list whose absence capped it.
 *
 * Every name in `SUPER_MEMBERS_VIDEO` is an anime one, so a manga extension
 * writing `super.imageRequest(page)` — the ordinary way to add a `Referer` to
 * an image request, and the hook upstream added for exactly that — was refused
 * by name. **The driver had implemented it all along**, along with twenty-two
 * others; only this list had not heard of them. Measured over 300 listings of
 * a real catalogue, `super.imageRequest()` was the *sole* remaining blocker on
 * 32 of them, more than twice the number that converted at all.
 *
 * This is the fourth time an anime-only allowlist has capped the manga medium
 * — `ABI_MEMBERS` above carries the third, in the same shape and with the same
 * comment. The pattern is worth naming: a set written when there was one
 * medium reads as a general rule and behaves as a filter on the other one.
 *
 * **Every name here is declared by `shims/mihon-entry.ts`**, checked by a test
 * that runs inside a real bundle rather than over the driver's source text —
 * see the note on `SUPER_MEMBERS`. Names a *blocked* extension asks for and
 * the driver does not have (`fetchSearchManga`, `fetchChapterList`, the rest
 * of the Rx-era `fetch*` family) are deliberately absent: adding one here
 * without adding it there converts a clean refusal into
 * `__super.x is not a function` on a viewer's device.
 */
const SUPER_MEMBERS_IMAGE: ReadonlySet<string> = new Set([
	'popularMangaParse',
	'searchMangaParse',
	'latestUpdatesParse',
	'chapterListParse',
	'mangaDetailsParse',
	'pageListParse',
	'imageUrlParse',
	'headersBuilder',

	// The request half. `imageRequest` is the one whose headers are
	// load-bearing (ABI.md §8.3): an image host answers 403 without a Referer
	// on a page whose chapter loaded fine.
	'popularMangaRequest',
	'latestUpdatesRequest',
	'searchMangaRequest',
	'mangaDetailsRequest',
	'chapterListRequest',
	'pageListRequest',
	'imageUrlRequest',
	'imageRequest',

	'popularMangaNextPageSelector',
	'searchMangaNextPageSelector',
	'latestUpdatesNextPageSelector',

	'getMangaUrl',
	'getChapterUrl',
	'setupPreferenceScreen',

	// The Rx-era half of the base class, which most of this catalogue's older
	// extensions override — and, having overridden one, routinely call
	// `super` on it to wrap the base rather than replace it. The driver
	// implements each as the request/parse pair wrapped in an Observable.
	'fetchPopularManga',
	'fetchLatestUpdates',
	'fetchSearchManga',
	'fetchMangaDetails',
	'fetchChapterList',
	'fetchPageList',

	// The current API's one `final` entry point, which an extension calls on
	// itself — `getMangaUpdate(manga, emptyList(), fetchDetails = true,
	// fetchChapters = false).manga` — to reuse its own `fetchMangaUpdate` for
	// a detail read. The driver runs the extension's `fetchMangaUpdate` and
	// nothing else, exactly as the base class does.
	'getMangaUpdate'
]);

/**
 * Both media's base members, merged.
 *
 * Merged rather than selected by medium because the emitter does not know
 * which format it is translating, and `ABI_MEMBERS` already took this shape
 * for the same reason. The two vocabularies barely overlap — anime spells
 * everything `*Anime*`, `*Episode*`, `*Video*`; manga spells it `*Manga*`,
 * `*Chapter*`, `*Page*` — and the three names genuinely common to both
 * (`latestUpdatesParse`, `latestUpdatesRequest`, `headersBuilder`) mean the
 * same thing in each.
 *
 * What the merge costs, stated rather than discovered: an *anime* extension
 * writing `super.imageRequest()` now compiles instead of being refused, and
 * would fail inside the sandbox because the video driver has no such member.
 * No such extension exists — it is a manga member, in a manga base class — and
 * the alternative is threading a medium through the emitter to prevent
 * something nobody writes.
 */
export const SUPER_MEMBERS: ReadonlySet<string> = new Set([
	...SUPER_MEMBERS_VIDEO,
	...SUPER_MEMBERS_IMAGE
]);

/** Exported for the two cross-check tests, which each assert their own
 * driver declares its own half. See `SUPER_MEMBERS_IMAGE`. */
export { SUPER_MEMBERS_VIDEO, SUPER_MEMBERS_IMAGE };

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
/**
 * Base-class *properties* a `super.` read resolves to a runtime global.
 *
 * Only where the base's value is the runtime's own object and reading it off
 * `this` would be wrong. `super.client` is the whole reason: it appears inside
 * the declaration of `client` itself, wrapping the base's HTTP client in a
 * builder, so `this.client` would be the half-built member or the recursion.
 * `super.headers` is the same shape one line away.
 *
 * Deliberately short. A base property this build does not supply under its own
 * name is still refused, because guessing which object holds it is how a
 * scraper reads a header off the wrong one.
 */
export const SUPER_BASE_PROPERTIES: ReadonlySet<string> = new Set(['client', 'headers']);

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
	'getImageTile',

	// The manga half's `suspend fun getMangaUpdate(…): SMangaUpdate`. Read as
	// `.manga` straight off the call, so an unawaited one reads a field off a
	// promise and hands back undefined as the title.
	'getMangaUpdate'
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
	// **The ext-lib 14 secondary constructor**, which is still what the
	// overwhelming majority of the catalogue writes: 137 calls pass three
	// positional arguments and 73 pass four, and every named call that spells
	// `url` or `quality` means this one. It survives upstream as a deprecated
	// secondary, delegating to the primary with `videoTitle = quality` — so
	// keeping it as the positional shape is not legacy support, it is the
	// common case.
	//
	// The **ext-lib 16 primary** constructor is a different parameter list
	// that happens to share three names at different indices, and it cannot be
	// merged into this one entry. `VIDEO_V16_PARAMETERS` below is that list,
	// reached only when a call names something that can only be its.
	['Video', ['url', 'quality', 'videoUrl', 'headers', 'subtitleTracks', 'audioTracks']],
	['Track', ['url', 'lang']],

	// **`Page(index, url = "", imageUrl = null)`**, and the reason it is here
	// rather than left to positional calls: `Page(index, imageUrl = it)` is how
	// this ecosystem builds a page list, and it was the single largest refusal
	// left after the manga types landed. Without the signature the call is
	// refused; emitted positionally without one it would put an image url in
	// the `url` slot, which is the slot the driver fetches a *document* from.
	['Page', ['index', 'url', 'imageUrl']],

	// `MangasPage(mangas = …, hasNextPage = …)`, the same shape as its video
	// counterpart and named about as often as it is passed positionally.
	['MangasPage', ['mangas', 'hasNextPage']],

	// **`SMangaUpdate(manga = …, chapters = …)`**, the pair the current
	// manga API returns details and chapters in, from one request. Every
	// construction site in the measured catalogue names both — 92 listings
	// were refused on that alone — and the order is the data class's own.
	['SMangaUpdate', ['manga', 'chapters']],

	// **`getMangaUpdate(manga, chapters, fetchDetails = …, fetchChapters = …)`**,
	// the base class's `final` entry point, which an extension calls on itself
	// to reuse its own `fetchMangaUpdate` for a detail read — always with the
	// two flags named. It is the base's member, so no declaration in the
	// extension supplies its parameter list; `fetchMangaUpdate` is the same
	// list and is declared in every extension that has it, but is listed too
	// for a template that calls it before any subclass declares it.
	['getMangaUpdate', ['manga', 'chapters', 'fetchDetails', 'fetchChapters']],
	['fetchMangaUpdate', ['manga', 'chapters', 'fetchDetails', 'fetchChapters']],

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
	// Kotlin's `joinTo` takes the buffer first and then `joinToString`'s
	// arguments, so the names are the same list with `buffer` in front.
	['joinTo', ['buffer', 'separator', 'prefix', 'postfix', 'limit', 'truncated', 'transform']],
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
 * `Video`'s **ext-lib 16 primary constructor**, which is a second parameter
 * list under the same name.
 *
 * Upstream `Video.kt` is a data class whose primary constructor is
 *
 *     Video(videoUrl = "", videoTitle = "", resolution: Int? = null,
 *           bitrate: Int? = null, headers = null, preferred = false,
 *           subtitleTracks = [], audioTracks = [], timestamps = [],
 *           mpvArgs = [], ffmpegStreamArgs = [], ffmpegVideoArgs = [],
 *           internalData = "", initialized = false, memo = {})
 *
 * with the ext-lib 14 shape kept as a *deprecated secondary* that delegates to
 * it (`videoTitle = quality`, and `url` stored as the separate page url). Both
 * are live, and `KNOWN_SIGNATURES` can hold only one list per name.
 *
 * They cannot be merged, because `videoUrl`, `headers`, `subtitleTracks` and
 * `audioTracks` appear in **both at different indices** — `videoUrl` is index
 * 2 in the secondary and index 0 here. Slotting a named `videoUrl` against the
 * wrong list is how a converted extension ends up publishing its page url as
 * the stream.
 *
 * What makes the choice decidable is that the discriminating names are
 * disjoint: `url`/`quality` belong only to the secondary, and
 * `VIDEO_V16_ONLY` below only to the primary. Measured over the current
 * catalogue (777 Kotlin files, ~300 `Video(…)` calls): 18 calls in 10
 * extensions name something v16-only, **none** of them mixes in a positional
 * argument and **none** also spells `url` or `quality`. So a call is read as
 * v16 exactly when it names one of those, and anything ambiguous is refused
 * rather than guessed — the rule `rateLimitCall` already follows.
 */
export const VIDEO_V16_PARAMETERS: readonly string[] = [
	'videoUrl',
	'videoTitle',
	'resolution',
	'bitrate',
	'headers',
	'preferred',
	'subtitleTracks',
	'audioTracks',
	'timestamps',
	'mpvArgs',
	'ffmpegStreamArgs',
	'ffmpegVideoArgs',
	'internalData',
	'initialized',
	'memo'
];

/**
 * The parameter names that can only mean the ext-lib 16 primary constructor.
 *
 * `VIDEO_V16_PARAMETERS` minus the four it shares with the ext-lib 14
 * secondary (`videoUrl`, `headers`, `subtitleTracks`, `audioTracks`), which
 * say nothing about which one is being called.
 */
export const VIDEO_V16_ONLY: ReadonlySet<string> = new Set([
	'videoTitle',
	'resolution',
	'bitrate',
	'preferred',
	'timestamps',
	'mpvArgs',
	'ffmpegStreamArgs',
	'ffmpegVideoArgs',
	'internalData',
	'initialized',
	'memo'
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
	'videosFromElement',

	/* The manga half. Without these the test above is unsatisfiable for an
	   entire medium: every member a manga extension declares is spelled
	   differently, so `abiMembers` came back empty for all of them and every
	   conversion was refused as "translates, but declares nothing this build
	   would call" — a sentence about the extension that was really a fact
	   about this list. */
	'popularMangaRequest',
	'popularMangaParse',
	'popularMangaFromElement',
	'latestUpdatesRequest',
	'latestUpdatesParse',
	'latestUpdatesFromElement',
	'searchMangaRequest',
	'searchMangaParse',
	'searchMangaFromElement',
	'mangaDetailsParse',
	'chapterListRequest',
	'chapterListParse',
	'chapterFromElement',
	'pageListRequest',
	'pageListParse',
	'imageUrlParse',
	'imageRequest',

	/* The selector families, which for a themed extension are often the only
	   thing it declares — and are exactly what makes it more than a shell. */
	'popularMangaSelector',
	'searchMangaSelector',
	'latestUpdatesSelector',
	'chapterListSelector',

	/* **The two generations of entry point above the request/parse pair**, both
	   of which `shims/mihon-entry.ts` now runs in preference to it.

	   `fetchX(): Observable<T>` is the deprecated Rx API and `suspend fun
	   getX(): T` is the one that replaced it — and the catalogue has moved.
	   Measured over this repository's ~800 Kotlin sources: 332 declare
	   `getPopularManga`, 331 `getLatestUpdates`, 330 `getPageList`, ~300
	   `getSearchMangaList`, against 152 for `fetchSearchManga` and 100 for
	   `fetchChapterList`. An extension that writes only these declares no
	   member of the pair at all, so `substantive` was false for it and a
	   conversion that had succeeded was thrown away with a sentence about the
	   extension that was really a fact about this list — the third time that
	   has happened here, and the reason the rule is to add a name only
	   alongside the driver that calls it. */
	'getPopularManga',
	'getLatestUpdates',
	'getSearchMangaList',
	'getSearchManga',
	'getChapterList',
	'getPageList',
	'getImageUrl',
	'fetchPopularManga',
	'fetchLatestUpdates',
	'fetchSearchManga',
	'fetchChapterList',
	'fetchPageList',
	/* Details and chapters from one request — the current API's abstract
	   member, which `KeiSource` subclasses implement instead of any chapter
	   list member at all. `listChapters` runs it. */
	'fetchMangaUpdate'
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

	// keiyoushi's `KeiSource` builds its final `client` and `headersBuilder`
	// by calling these two on a builder, and `shims/mihon-entry.ts` does the
	// same. Nothing in the extension calls them, so without being roots a
	// refused one was pruned as unreachable, the driver found no such member,
	// and the client went out without the rate limit it declares.
	'configureClient',
	'configureHeaders',

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

/**
 * Whether a subtree holds a parse error this build cannot put right.
 *
 * Three cases, and the third is the one worth stating: a node may report
 * `hasError` with no ERROR or MISSING node beneath it at all — tree-sitter
 * recovers by guessing and does not always leave a marker — and that is still
 * an error, at *this* node. So a `hasError` no child accounts for is
 * unrepaired, which is what keeps the guard from being loosened into nothing.
 */
function unrepairedError(node: KNode): boolean {
	if (COMMENT_KINDS.has(node.type)) return false;
	if (!node.hasError && node.type !== 'ERROR' && !node.isMissing) return false;

	const swallowed = swallowedWhenElse(node);
	if (swallowed !== null) {
		// By kind rather than by identity: the two child accessors wrap the same
		// tree-sitter node in different objects, so `===` across them is false.
		return node.allChildren.some(
			(child) => child.type !== 'ERROR' && child.type !== 'else' && unrepairedError(child)
		);
	}
	if (node.type === 'ERROR' || node.isMissing) return true;

	const children = node.allChildren.filter((child) => !COMMENT_KINDS.has(child.type));
	if (children.some(unrepairedError)) return true;
	// `hasError` here with nothing beneath it carrying one: the guess is at this
	// node, and there is no marker to forgive.
	return !children.some((child) => child.hasError || child.type === 'ERROR' || child.isMissing);
}

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
	// One exception, and it is a defect in the grammar rather than in the
	// source: see `swallowedWhenElse`. The marker is forgiven and the branch is
	// put back by the emitter, so a construct this build reads correctly is not
	// refused for the shape of the tree it arrived in. `hasError` propagates
	// upward, so the question has to be asked of the whole subtree rather than
	// of this node — `unrepairedError` is that question.
	const swallowed = swallowedWhenElse(node);
	if (node.type === 'ERROR' || node.isMissing || node.hasError) {
		if (unrepairedError(node)) {
			found.push({
				kind: 'a passage this build could not parse',
				line: node.line,
				memberName
			});
			return;
		}
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

	// The other question a leaf cannot answer, and the mirror of the one above.
	//
	// `Injekt` on its own is the dependency-injection container, which is out
	// of reach and stays refused. But `Injekt.get<Application>()
	// .getSharedPreferences("source_$id", MODE_PRIVATE)` is this ecosystem's
	// spelling of "my settings store" — ext-lib 16 removed
	// `getSourcePreferences()` and documents this in its place — and the store
	// is one the runtime already owns. A leaf sees only `Injekt`, so the two
	// can only be told apart here, at the call.
	//
	// The exemption is the whole idiom rather than `<Application>` alone,
	// deliberately. An `Application` reached for anything else — `filesDir`,
	// `packageManager`, a real context — would resolve to a shim that has never
	// heard of it and fail inside the sandbox, which is the silent-bug shape
	// this file's header refuses to trade for. Asking for the store is
	// answered; asking for the process is still a named refusal.
	if (
		node.type === 'call_expression' &&
		APPLICATION_PREFERENCES.test(node.text.replace(/\s+/g, ''))
	) {
		return;
	}
	// The same container asked for the app's `Json`, which is the other object
	// the runtime already owns: `by injectLazy<Json>()` has resolved to it all
	// along, and keiyoushi core spells the same request `val jsonInstance:
	// Json = Injekt.get()`. Mihon configures that instance with
	// `ignoreUnknownKeys` and `explicitNulls = false`, which is what the
	// runtime's decoder does. Anything else asked of Injekt stays refused.
	if (INJECTED_JSON.test(node.text.replace(/\s+/g, ''))) return;

	// And a fourth: `Thread.sleep(ms)`. The name table refuses `Thread` because
	// a leaf cannot tell a pause from a thread (see the note on that entry),
	// but a call can, and the emitter already writes this one as the
	// runtime's real `delay` — awaited, the member made `async`. So the pause
	// that spaces a source's retries out was refused as "a background thread"
	// while the translation for it sat unused. Only the callee is forgiven:
	// the argument is scanned like any other expression, and every other use
	// of `Thread` still reaches the leaf and is refused.
	if (node.type === 'call_expression' && /^Thread\.sleep\(/.test(node.text.replace(/\s+/g, ''))) {
		for (const child of node.children) {
			if (child.type === 'call_suffix') scanInto(child, memberName, found);
		}
		return;
	}

	// And `scope.launch { … }`, which the emitter now writes as a block started
	// and not awaited (see `__k.launch`). The name table refuses the `launch`
	// leaf because a leaf cannot tell a launch on a named scope from a bare
	// `launch` inside `coroutineScope { }` — a child its scope waits for, which
	// is not what the emitter writes. The call can, by its receiver. Only the
	// callee's name is forgiven: the receiver, the arguments and the block are
	// scanned like anything else.
	if (node.type === 'call_expression') {
		// `scope.launch(Dispatchers.IO) { … }` arrives as a call whose callee is
		// the call carrying the arguments, so one level is unwound.
		let callee = node.children[0];
		const suffixes = [node.children[1]];
		if (callee?.type === 'call_expression') {
			suffixes.unshift(callee.children[1]);
			callee = callee.children[0];
		}
		const step = callee?.type === 'navigation_expression' ? callee.children[1] : undefined;
		const last = suffixes[suffixes.length - 1];
		if (
			step?.type === 'navigation_suffix' &&
			step.children[0]?.text === 'launch' &&
			last?.type === 'call_suffix' &&
			last.children.some((part) => part.type === 'annotated_lambda')
		) {
			const receiver = callee?.children[0];
			if (receiver !== undefined) scanInto(receiver, memberName, found);
			for (const suffix of suffixes) if (suffix !== undefined) scanInto(suffix, memberName, found);
			return;
		}
	}

	// The third of the same shape, and the emitter's other half: see
	// `CLASS_LOADER`. Returning rather than descending is what keeps the
	// `javaClass` leaf below from being refused, and keeps the exemption exactly
	// as long as the chain the emitter recognises.
	if (node.type === 'navigation_expression' && CLASS_LOADER.test(node.text.replace(/\s+/g, ''))) {
		return;
	}

	// And the fourth: `SIMPLE_NAME`, the chain `emit.ts` answers with a class's
	// name. Exempt the whole chain here and no more of it, for the reason above;
	// the emitter still refuses the half of it that is not in a log line.
	if (node.type === 'navigation_expression' && SIMPLE_NAME.test(node.text.replace(/\s+/g, ''))) {
		return;
	}

	// Named obstacles are matched on the smallest node whose text contains
	// them, so the reported line is the call rather than the whole method.
	//
	// Type names are exempt: nothing here emits a type, so a parameter declared
	// `screen: PreferenceScreen` mentions the preference framework without
	// touching it. Matching on a type refuses a member for its signature.
	//
	// A string's own text is exempt from the name table too, and only from the
	// name table. `throw Exception("Log in via WebView and retry")` is the
	// single commonest way a manga extension *mentions* WebView — it is the
	// message a reader sees when a site wants a login — and matching the prose
	// refused it as a WebView user: 60-odd keiyoushi listings sat in the native
	// column for a sentence. Code interpolated into a string is a node of its
	// own (`${x.webView}` is a navigation expression, not `string_content`),
	// so it is still scanned. What a string *is* the only place for is a JCE
	// transformation — `Cipher.getInstance("AES/ECB/PKCS5Padding")` has its mode
	// nowhere else, including when the string sits in a constant — so the
	// algorithm question is still asked of it.
	if (node.type === 'string_content') {
		const algorithm = cryptoObstacle(node.text);
		if (algorithm !== null) {
			found.push({ kind: algorithm, line: node.line, memberName });
			return;
		}
	} else if (node.children.length === 0 && node.type !== 'type_identifier') {
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

	for (const child of node.children) {
		if (swallowed !== null && (child.type === 'ERROR' || child.type === 'else')) continue;
		scanInto(child, memberName, found);
	}
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
	'setIndex',
	'overload',
	'receiverLambda'
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
