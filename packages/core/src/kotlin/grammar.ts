/**
 * Loading the Kotlin grammar, and the only file that imports `web-tree-sitter`.
 *
 * ## Why this is the one dynamic import in `foreign/`
 *
 * `adapters/aniyomi.ts` is statically reachable from `detect.ts`, which is
 * statically reachable from the plugin registry, which is on the app's entry
 * graph. A static import of the parser here would put a 4 MB wasm and its
 * runtime on the entry chunk of an app that mostly never converts anything.
 *
 * So: `import('web-tree-sitter')` happens inside `loadKotlinGrammar`, behind a
 * module-level promise, and the grammar bytes are fetched next to it. The cost
 * is paid once, by a viewer who converts, and never by one who does not.
 * `anime4k.js` is the precedent — 427 KB behind a dynamic import, asserted in
 * the built output.
 *
 * ## Bytes, not paths, and the host is the one who has them
 *
 * `Language.load` accepts a path in Node and a URL in a browser, and the two
 * disagree about what a `file://` string means. Reading the bytes elsewhere and
 * handing over a `Uint8Array` makes one code path serve both.
 *
 * Elsewhere is now a **host**, and that is the change ADR-0004 phase 2 made.
 * This file used to carry a default loader that resolved `./vendor/…` against
 * `import.meta.url` and read it with an ambient `fetch` — the last ambient
 * capability in the runtime, exempted by name in
 * `tool/check-runtime-boundary.ts` and recorded in `docs/KNOWN_GAPS.md`. The
 * seam it needed already existed; what did not exist was a second host to prove
 * it was the right seam. Both artefacts now arrive as bytes from
 * `PluginHost.wasm`, which is Vite's asset URLs in the browser and `node:fs`
 * headlessly, and *neither* is a fact this module has to know.
 *
 * The Emscripten companion wasm arrives the same way. It used to be *located*
 * rather than loaded, on the grounds that Emscripten wants an address it can
 * fetch itself — but `Module.wasmBinary` takes the bytes directly, which
 * removes the second half of the problem instead of relocating it.
 *
 * ## Version pinning
 *
 * The runtime is pinned *down* to the grammar rather than the grammar built up
 * to the runtime; `vendor/README.md` has the whole argument and the hashes.
 * The short version: a 0.20-built grammar and a 0.27 runtime do not load
 * together, and building a newer grammar needs a toolchain nobody here has.
 */

import type { WasmLoader } from '@plugin-bridge/host/host';
import { wrap, type KotlinTree, type RawNode } from './ast';

/**
 * Re-exported so the Kotlin front-end's own callers name one type.
 *
 * Declared on the port rather than here: it is a *host* capability — "read the
 * runtime's own vendored artefact" — and `host.ts` is where the six others are
 * declared. The two names it is ever asked for are the constants below.
 */
export type { WasmLoader };

/** Parses Kotlin source into the façade `ast.ts` defines. */
export type KotlinParser = (source: string) => KotlinTree;

/** The Emscripten runtime, by the name a host stores it under. */
export const TREE_SITTER_RUNTIME = 'tree-sitter.wasm';

/** The pinned Kotlin grammar, by the name a host stores it under. */
export const TREE_SITTER_KOTLIN = 'tree-sitter-kotlin.wasm';

let pending: Promise<KotlinParser> | null = null;

/**
 * The parser, built once per realm.
 *
 * Memoised on the promise rather than on the result, so two conversions
 * starting at the same time share one 4 MB read instead of racing. The memo is
 * deliberately not keyed on the loader: a realm has one host, and a second
 * loader arriving would mean two answers to "where do this runtime's assets
 * live" rather than a cache to invalidate. `resetKotlinGrammar` is how a spec
 * swaps one.
 */
export function loadKotlinGrammar(loader: WasmLoader): Promise<KotlinParser> {
	if (pending === null) pending = build(loader);
	return pending;
}

/** Drops the memo. For specs that swap the loader; never used in the product. */
export function resetKotlinGrammar(): void {
	pending = null;
}

async function build(loader: WasmLoader): Promise<KotlinParser> {
	const module = await import('web-tree-sitter');
	// The package ships CommonJS, so the constructor arrives on `default`
	// under some bundlers and on the namespace under others.
	const Parser = ((module as unknown as { default?: unknown }).default ??
		module) as unknown as ParserModule;

	// Emscripten asks for its companion wasm by name, and left to its own
	// devices resolves it against the working directory — wrong in a browser,
	// and wrong in Node whenever the process did not start here. The
	// copy-paste fix people reach for is a CDN URL, which would put a
	// third-party host in the client (rule 9).
	//
	// `wasmBinary` sidesteps the question: given the bytes, Emscripten never
	// asks for an address, so there is no address for this module to be wrong
	// about. It is the same trade `Language.load` already made.
	await Parser.init({ wasmBinary: await loader(TREE_SITTER_RUNTIME) });

	const language = await Parser.Language.load(await loader(TREE_SITTER_KOTLIN));
	const parser = new Parser();
	parser.setLanguage(language);

	const read = (source: string): KotlinTree => {
		// Ahead of the first parse, and not gated on an error, because the gap it
		// closes produces no error — see `genericCallOperands`. Kept only if the
		// rewrite parses at least as well as the source did, which is what stops
		// a repair from being trusted further than it has earned.
		const normalised = genericCallOperands(source);
		if (normalised !== source) {
			const rewritten = wrap(parser.parse(normalised).rootNode as unknown as RawNode);
			if (!rewritten.hasError) return { root: rewritten, hasError: false };
		}

		const tree = parser.parse(source);
		const root = wrap(tree.rootNode as unknown as RawNode);
		if (!root.hasError) return { root, hasError: false };

		// Older Kotlin grammars parse a type-use annotation in a delegation
		// specifier (`class Demo : @Marker Base()`) as an annotation call and
		// recover the base name as an ERROR node. Type-use annotations do not
		// change the base class ABI the converter emits, so retry with only those
		// annotation characters blanked. Keeping offsets intact matters: member
		// line numbers and source slices must still refer to the original file.
		// Both rewrites, one retry: they are disjoint on every source measured,
		// and a second re-parse would cost another tree for a case that has not
		// occurred.
		const masked = repairKnownGrammarGaps(maskSupertypeAnnotations(source));
		if (masked === source) return { root, hasError: true };
		const recovered = wrap(parser.parse(masked).rootNode as unknown as RawNode);
		return { root: recovered, hasError: recovered.hasError };
	};

	return (source: string): KotlinTree => {
		// Also not gated on an error, for the reason `genericCallOperands` is
		// not: the parse succeeds and is wrong. See `lineInitialCalls`. The split
		// is kept only where it reads cleanly, so a file this could make worse
		// is read exactly as it always was.
		const split = lineInitialCalls(
			(text) => parser.parse(text).rootNode as unknown as SplitNode,
			source
		);
		if (split === null) return read(source);
		const tree = read(split);
		return tree.hasError ? read(source) : tree;
	};
}

/**
 * Masks annotations attached to a class delegation type while preserving
 * source offsets. This is deliberately narrow: annotations elsewhere in a
 * file may affect emitted behaviour and must continue to make parsing refuse.
 */
function maskSupertypeAnnotations(source: string): string {
	let output = source;
	const classHeader = /\bclass\s+[\w`]+(?:\s*<[^{}]*>)?[^{}]*:/g;
	let match: RegExpExecArray | null;
	while ((match = classHeader.exec(source)) !== null) {
		const start = match.index + match[0].length;
		const end = findHeaderEnd(source, start);
		if (end === -1) continue;
		const header = source.slice(start, end);
		const masked = header.replace(/@[\w.]+(?:\s*\([^()]*\))?\s+(?=[A-Za-z_`])/g, (annotation) =>
			annotation.replace(/\S/g, ' ')
		);
		if (masked !== header) output = output.slice(0, start) + masked + output.slice(end);
	}
	return output;
}

function findHeaderEnd(source: string, start: number): number {
	let parens = 0;
	let angles = 0;
	for (let index = start; index < source.length; index += 1) {
		const character = source.charAt(index);
		if (character === '(') parens += 1;
		else if (character === ')') parens = Math.max(0, parens - 1);
		else if (character === '<') angles += 1;
		else if (character === '>') angles = Math.max(0, angles - 1);
		else if (parens === 0 && angles === 0 && (character === '{' || character === '\n'))
			return index;
	}
	return -1;
}

/* ── the shape of the pinned runtime, named so nothing else imports it ────── */

/**
 * Rewrites two `when`-entry shapes the pinned grammar cannot read.
 *
 * Same bargain as `maskSupertypeAnnotations` above, and the same retry: the
 * first parse is the honest one, and only a tree that already has an error is
 * worth a second attempt on a rewritten string. Each rewrite has a *proven*
 * shape — a fixture through this parser fails before it and passes after — and
 * each is a no-op on Kotlin the grammar already reads, which is what makes it
 * safe to run over every file rather than only the ones somebody looked at.
 *
 * **`return <name beginning with e>` as a when-entry body.** `-> return
 * emptyList()` is an ERROR and `-> return listOf()` is not; so is `-> return
 * eee()`, while `-> return elseX()` is fine. The lexer is reaching for `else`.
 * Parenthesising the *returned expression* — `return (emptyList())` — puts a
 * token in front of the `e` and the reach never happens. Wrapping the whole
 * body instead parses and then emits nothing: `emit.ts` refuses a `return` used
 * as a value, so the member would trade one refusal for another.
 *
 * **An unbraced `if` whose else-value is a string, as a when-entry body.**
 * `-> if (a) "x" else "y"` is an ERROR; `-> if (a) "x" else y` is not.
 *
 * ## What this deliberately does not do
 *
 * **It does not move a newline.** Every obstacle this build reports is a file
 * and a line, and a rewrite that shifted one would relabel every obstacle below
 * it. Both parentheses are inserted within a line, and a body that does not
 * finish on its own line is skipped rather than closed in the wrong place.
 *
 * **It does not match inside a string or a comment.** Several of these sources
 * carry raw triple-quoted GraphQL and HTML with `->`, `if` and `else` in them.
 * Matching runs against a mask in which literal bodies and comments are filler
 * of the same length, and the offsets it produces are applied to the real
 * source.
 *
 * **It does not touch a lambda arrow.** `{ x -> if (a) "p" else "q" }` parses
 * today, and rewriting a file the grammar already reads is not a repair, it is
 * a second parser. So the arrow must be a *when-entry* arrow, which is checked
 * by walking back to the brace that opened it.
 *
 * **It does not make a refused member translate.** A member that parses can
 * still be refused, and several of these are. That is the point: the rewrite
 * buys an honest obstacle in place of "could not parse", nothing more.
 *
 * A third gap — a dotted receiver in a function type, `Headers.Builder.() ->
 * Unit` — is deliberately absent. The parse repair is clean, but the one real
 * file it unlocks then emits a receiver lambda this emitter does not model and
 * throws at run time. An honest "could not parse" is worth more than a plugin
 * that looks complete and does not work.
 */
function repairKnownGrammarGaps(source: string): string {
	// Ahead of the mask, because the mask cannot read a multi-dollar string
	// correctly either — what interpolates inside one is the question this
	// rewrite answers. Same reason `rawStringsEndingInBackslash` runs here
	// rather than after: the mask calls `skipRawString` too, and a raw string
	// this grammar cannot terminate correctly is exactly the input the mask
	// would also get wrong.
	const plain = rawStringsEndingInBackslash(multiDollarStrings(source));
	const masked = maskLiteralsAndComments(plain);
	// Descending, so an earlier edit's offsets are still the ones the mask
	// computed once a later one has been spliced in.
	const edits = [
		...whenEntryBodies(masked),
		...assignmentsThroughCalls(masked),
		...whenInConditions(masked)
	].sort((left, right) => right.start - left.start);
	let output = plain;
	for (const edit of edits) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

/**
 * Kotlin 2.1's multi-dollar string, which this grammar predates.
 *
 * The feature is one rule: a string opened with N ≥ 2 dollars interpolates only
 * where N dollars appear together, and every shorter run is literal text. It
 * exists for exactly the strings extensions carry — GraphQL documents full of
 * `$variable`, and JSON bodies with a `$` in them — so the sources reaching for
 * it are the ones whose strings would otherwise need escaping on every line.
 *
 * There is no way to ask a 2023 grammar to read it, and the string is not
 * decoration: it is the request body. So it is rewritten into the spelling the
 * grammar does read, which is the spelling Kotlin had before the feature. With
 * two dollars, and writing R for a raw string's triple quote:
 *
 *     $$R query get($select: X) { $$id } R
 *     R query get(${'$'}select: X) { $id } R
 *
 * A run of exactly N dollars becomes one — it interpolated, and still does. A
 * shorter run in front of a name or a brace was literal, and becomes literal
 * the old way: `${'$'}` in a raw string, a backslash escape in a quoted one. A
 * run in front of anything else needs no help; `$` is literal there under both
 * rules.
 *
 * **A longer run than N is refused** — the whole file keeps its "could not
 * parse" rather than being rewritten on a guess about a shape no source in the
 * catalogue uses. Length is the only thing this changes; no newline moves, so
 * every line a refusal names is still the line it was.
 */
function multiDollarStrings(source: string): string {
	if (!source.includes('$$')) return source;
	const masked = maskLiteralsAndComments(source);
	const edits: Edit[] = [];

	for (let at = 0; at < source.length;) {
		const fill = masked.charAt(at);
		if (source.charAt(at) !== '$' || fill === STRING_FILL || fill === COMMENT_FILL) {
			at += 1;
			continue;
		}
		let opener = at;
		while (source.charAt(opener) === '$') opener += 1;
		const dollars = opener - at;
		if (dollars < 2 || source.charAt(opener) !== '"') {
			at = opener;
			continue;
		}

		const raw = source.startsWith('"""', opener);
		const quote = raw ? 3 : 1;
		const end = raw ? skipRawString(source, opener + 3) : skipQuoted(source, opener + 1, '"');
		const from = opener + quote;
		const inside = rewriteDollars(source, from, Math.max(from, end - quote), dollars, raw);
		// A shape this does not claim to understand: leave the file as it was.
		if (inside === null) return source;

		edits.push({ start: at, end: opener, text: '' });
		edits.push(...inside);
		at = end;
	}

	if (edits.length === 0) return source;
	let output = source;
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

/** The dollar runs in one multi-dollar body, or `null` for a shape to leave alone. */
function rewriteDollars(
	source: string,
	from: number,
	to: number,
	dollars: number,
	raw: boolean
): Edit[] | null {
	const edits: Edit[] = [];
	for (let at = from; at < to;) {
		if (source.charAt(at) !== '$') {
			at += 1;
			continue;
		}
		let end = at;
		while (end < to && source.charAt(end) === '$') end += 1;
		// `$` in front of anything but a name or a brace is literal under both
		// rules, however many of them there are.
		if (!/[A-Za-z_{]/.test(source.charAt(end))) {
			at = end;
			continue;
		}
		const run = end - at;
		if (run > dollars) return null;
		edits.push({
			start: at,
			end,
			text: run === dollars ? '$' : (raw ? LITERAL_DOLLAR_RAW : '\\$').repeat(run)
		});
		at = end;
	}
	return edits;
}

/** How a raw string spells a literal `$`: an interpolation of the character. */
const LITERAL_DOLLAR_RAW = "${'$'}";

/**
 * A raw (triple-quoted) string whose content ends in an odd run of
 * backslashes — `"""\"""`, one backslash immediately before the terminator.
 *
 * Kotlin raw strings have no escape mechanism: a backslash is exactly one
 * character wherever it sits, and `"""..."""` ends at the first `"""` not
 * followed by another quote (`skipRawString`, unchanged here because it
 * already gets this right). The pinned grammar's raw-string scanner disagrees
 * — it treats a trailing backslash as escaping the quote after it, the rule an
 * *ordinary* string follows, and reads past the real terminator hunting for
 * one it does not consider escaped. What it finds is the next `"""` anywhere
 * later in the file, and everything between becomes one `ERROR`. Regex
 * patterns are exactly the sources that end a string on a backslash —
 * `Regex("""\\x...""")` is unaffected (an even run), `.replace("""\\""",
 * """\""")` is not (the second argument ends on one).
 *
 * Fixed by respelling rather than masking: the value is what the extension
 * runs on, so the raw string is rewritten into the ordinary escaped spelling
 * of the same value — the one shape this grammar's normal-string handling
 * reads correctly no matter how many backslashes it ends on. Skipped when the
 * content holds a literal newline, which an ordinary string cannot spell, or a
 * `${…}` block interpolation, whose own quotes and backslashes are Kotlin
 * syntax rather than string content and must not be escaped along with it —
 * nothing measured needs either, and this stays a respelling of exactly the
 * cases it understands rather than a general raw-string rewriter.
 */
function rawStringsEndingInBackslash(source: string): string {
	if (!source.includes('"""')) return source;
	const edits: Edit[] = [];
	let at = 0;
	while (at < source.length) {
		const character = source.charAt(at);
		if (character === '/' && source.charAt(at + 1) === '/') {
			while (at < source.length && source.charAt(at) !== '\n') at += 1;
		} else if (character === '/' && source.charAt(at + 1) === '*') {
			at += 2;
			while (at < source.length && !source.startsWith('*/', at)) at += 1;
			at = Math.min(source.length, at + 2);
		} else if (character === '`') {
			at += 1;
			while (at < source.length && source.charAt(at) !== '`' && source.charAt(at) !== '\n') {
				at += 1;
			}
			at += 1;
		} else if (source.startsWith('"""', at)) {
			const end = skipRawString(source, at + 3);
			const content = source.slice(at + 3, Math.max(at + 3, end - 3));
			const trailingBackslashes = /\\+$/.exec(content)?.[0].length ?? 0;
			if (trailingBackslashes % 2 === 1 && !content.includes('\n') && !content.includes('${')) {
				edits.push({ start: at, end, text: `"${content.replace(/[\\"]/g, '\\$&')}"` });
			}
			at = end;
		} else if (character === '"' || character === "'") {
			at = skipQuoted(source, at + 1, character);
		} else {
			at += 1;
		}
	}
	if (edits.length === 0) return source;
	let output = source;
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

/**
 * `x + f.pick<Genre>(1)` — a generic call read as a chain of comparisons.
 *
 * The grammar resolves `<` … `>` `(` in favour of comparison when the call is
 * the RIGHT operand of a binary operator, and the result is a tree with no
 * ERROR node in it: `y + f.pick<G>(1)` becomes `(y + f.pick)<G>(1)` — an
 * `additive_expression` being *called*. Kotlin has no such reading; `a < b` is
 * a Boolean and `Boolean > (c)` is a type error, so wherever this shape appears
 * the type arguments are what was meant.
 *
 * ## Why this one is not gated on a parse error
 *
 * Every other repair in this file runs only after the first parse failed, on
 * the principle that the honest parse comes first. There is no error to wait
 * for here. The parse *succeeds* and is wrong, which is the failure this whole
 * layer exists to refuse rather than ship — and it is caught today only because
 * the emitter will not call a receiver with no name, so what reaches the
 * scoreboard is "a call through `f.pick<G>(1) + f.pick`".
 *
 * Two things keep it honest instead:
 *
 * - **The shape is tight.** The operand has to be a postfix chain, the angle
 *   brackets have to hold nothing but type characters, and both have to be on
 *   one line. Anything with an operator inside the brackets — `x + a < b && c >
 *   (d)`, a genuine pair of comparisons — fails that test and is left alone.
 * - **The rewrite has to parse.** The result is re-parsed and kept only if it
 *   has no error the original did not; see `loadKotlinGrammar`. A repair that
 *   made the tree worse is discarded rather than trusted.
 *
 * Parentheses around an expression change nothing in Kotlin, so what is kept is
 * the meaning the source already had.
 */
function genericCallOperands(source: string): string {
	// Cheap enough to run on every file: a binary operator, a postfix chain,
	// angle brackets holding only type characters, and an open parenthesis.
	if (!GENERIC_OPERAND.test(source)) return source;

	const masked = maskLiteralsAndComments(source);
	const edits: Edit[] = [];
	for (let at = 0; at < masked.length; at += 1) {
		if (masked.charAt(at) !== '<') continue;
		const close = typeArgumentEnd(masked, at);
		if (close === -1) continue;

		let open = close + 1;
		while (/[ \t]/.test(masked.charAt(open))) open += 1;
		if (masked.charAt(open) !== '(') continue;
		const end = callEnd(masked, open);
		if (end === -1) continue;

		const start = chainStart(masked, at);
		if (start === -1) continue;
		if (!precededByOperator(masked, start)) continue;

		edits.push({ start: end, end, text: ')' });
		edits.push({ start, end: start, text: '(' });
	}

	if (edits.length === 0) return source;
	let output = source;
	for (const edit of edits.sort((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

const GENERIC_OPERAND =
	/(?:\+|-|\*|\/|%|\?:|&&|\|\||\.\.)\s*[\w$]+(?:[ \t]*[?!]*\.[ \t]*[\w$]+)*[ \t]*<[\w$.,?* \t]*>[ \t]*\(/;

/** The `>` closing a type-argument list opened at `from`, or -1. */
function typeArgumentEnd(masked: string, from: number): number {
	let depth = 0;
	for (let at = from; at < masked.length; at += 1) {
		const character = masked.charAt(at);
		if (character === '<') depth += 1;
		else if (character === '>') {
			depth -= 1;
			if (depth === 0) return at;
		}
		// A type argument holds names, dots, commas, `?` and `*` — and nothing
		// else. An operator or a bracket in here means these are comparisons.
		else if (!/[\w$.,?* \t]/.test(character)) return -1;
	}
	return -1;
}

/** The index just past the `)` closing the argument list opened at `from`. */
function callEnd(masked: string, from: number): number {
	let depth = 0;
	for (let at = from; at < masked.length; at += 1) {
		const character = masked.charAt(at);
		if (character === '(' || character === '[') depth += 1;
		else if (character === ')' || character === ']') {
			depth -= 1;
			if (depth === 0) return at + 1;
		}
	}
	return -1;
}

/** The first character of the postfix chain ending just before `at`. */
function chainStart(masked: string, at: number): number {
	let index = at - 1;
	while (index >= 0 && /[ \t]/.test(masked.charAt(index))) index -= 1;
	if (index < 0 || !/[\w$]/.test(masked.charAt(index))) return -1;
	while (index >= 0 && /[\w$.?!]/.test(masked.charAt(index))) index -= 1;
	return index + 1;
}

/** True when a binary operator stands in front of the chain starting at `at`. */
function precededByOperator(masked: string, at: number): boolean {
	let index = at - 1;
	while (index >= 0 && (/\s/.test(masked.charAt(index)) || masked.charAt(index) === COMMENT_FILL))
		index -= 1;
	if (index < 0) return false;
	const character = masked.charAt(index);
	if ('+-*/%'.includes(character)) return true;
	// The two-character operators, each of which has a one-character meaning
	// that is not one: a lone `:` introduces a supertype, and wrapping the base
	// class after it turned `) : Base(x)` into `) : (Base(x))`, which is not a
	// class header at all.
	const before = masked.charAt(index - 1);
	if (character === ':') return before === '?';
	if (character === '.') return before === '.';
	if (character === '&') return before === '&';
	if (character === '|') return before === '|';
	return false;
}

/** One splice into the original source, at an offset the mask found. */
interface Edit {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/** An arrow whose body starts on the same line; a body below is left alone. */
const ARROW = /->[ \t]*(?=[^\s])/g;

/** `return emptyList()`, `return@label emptyList()` — and not `return elseX()`. */
const JUMP_TO_E = /^(return(?:@\w+)?[ \t]+)e(?!lse\b)\w*/;

function whenEntryBodies(masked: string): Edit[] {
	const edits: Edit[] = [];
	ARROW.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = ARROW.exec(masked)) !== null) {
		const bodyStart = match.index + match[0].length;
		const end = bodyEnd(masked, bodyStart);
		if (end === -1) continue;
		const body = masked.slice(bodyStart, end);

		// Cheapest test first: the shape. `isWhenEntryArrow` walks back over the
		// file and is only worth paying for on an arrow that could be one of the
		// two gaps at all.
		const jump = JUMP_TO_E.exec(body);
		if (jump === null && !ifWithStringElse(body)) continue;
		if (!isWhenEntryArrow(masked, match.index)) continue;

		const open = jump === null ? bodyStart : bodyStart + jump[1].length;
		edits.push({ start: end, end, text: ')' });
		edits.push({ start: open, end: open, text: '(' });
	}
	return edits;
}

/**
 * A `when` entry whose condition is `in …` or `!in …`, below an entry whose
 * body ended in an expression.
 *
 *     when (status) {
 *         in ongoing -> SManga.ONGOING
 *         in completed -> SManga.COMPLETED
 *
 * Kotlin ends an entry at the newline. The pinned grammar does not: it reads
 * `SManga.ONGOING in completed` as one infix `in` expression continuing onto
 * the next line, and the second entry's arrow is left with no condition — a
 * *missing* identifier rather than an ERROR, which is why nothing about it
 * looks like the entry above. `is` does not have the gap; a body ending in `}`
 * does not either. Only an entry after an expression body.
 *
 * It is two shared files' worth of catalogue on its own. `ZeistManga`'s
 * `parseStatus` is written this way, and so is `VoeExtractor`'s `rot13`
 * (`in 'A'..'Z' -> …` / `in 'a'..'z' -> …`) — one a template, the other a
 * stream extractor that most of an anime repository reaches through
 * `lib/`. Each refused every extension built on it as "a passage this build
 * could not parse".
 *
 * The repair is a `;` at the end of the line above, which Kotlin permits
 * after a when entry and which settles the question the newline should have.
 * It is inserted after the last code character — a trailing comment is filler
 * in the mask and stays where it is — so no newline moves and every line an
 * obstacle names is still the line it was. Only where the arrow on the `in`
 * line belongs to a `when` (`isWhenEntryArrow`), and only after a character
 * that can end an expression: after `{`, `,` or an operator the `in` really
 * is a continuation, or the first entry, and is left alone.
 */
function whenInConditions(masked: string): Edit[] {
	const edits: Edit[] = [];
	const lead = /^[ \t]*!?in[ \t(]/;
	let lineStart = 0;
	while (lineStart < masked.length) {
		let lineEnd = masked.indexOf('\n', lineStart);
		if (lineEnd === -1) lineEnd = masked.length;
		const line = masked.slice(lineStart, lineEnd);
		if (lead.test(line)) {
			const arrow = entryArrow(masked, lineStart, lineEnd);
			if (arrow !== -1 && isWhenEntryArrow(masked, arrow)) {
				let before = lineStart - 1;
				while (before >= 0 && /[\s\u0002]/.test(masked.charAt(before))) before -= 1;
				if (before >= 0 && /[\w)\]\u0001!]/.test(masked.charAt(before))) {
					edits.push({ start: before + 1, end: before + 1, text: ';' });
				}
			}
		}
		lineStart = lineEnd + 1;
	}
	return edits;
}

/** The first `->` on this line outside any bracket, or -1. */
function entryArrow(masked: string, from: number, to: number): number {
	let depth = 0;
	for (let index = from; index < to - 1; index += 1) {
		const character = masked.charAt(index);
		if (character === '(' || character === '[' || character === '{') depth += 1;
		else if (character === ')' || character === ']' || character === '}') depth -= 1;
		else if (depth === 0 && character === '-' && masked.charAt(index + 1) === '>') return index;
	}
	return -1;
}

/**
 * `episodes.first().name = "x"` — an assignment whose target sits behind a call.
 *
 * The pinned grammar's assignable-expression rule reaches a navigation suffix
 * over an identifier and over an index (`a[0].name = x` parses), and not over a
 * call. So `a.first().name = x`, `getMeta(id).schedule = xs` and `a.f().n += 1`
 * are all ERROR — and the recovery loses the brace nesting, which is why this
 * arrives at the scoreboard as *the whole file* refusing rather than one member.
 *
 * Parenthesising the receiver up to and including its last call is the repair:
 * `(a.first()).name = x`. Parentheses around an expression change nothing in
 * Kotlin, so the meaning is the meaning the file already had.
 *
 * ## The leading parenthesis is the whole difficulty
 *
 * A statement that now *opens* with `(` reads as a call of whatever the
 * previous statement ended with — `doThing()` followed by `(a.f()).n = 1`
 * becomes `doThing()(a.f())`, which is worse than the refusal it replaced. A
 * semicolon in front settles it, and a semicolon is only safe where an empty
 * statement is: not after `{`, where the grammar rejects one outright, and not
 * where the previous token is the head of a statement still waiting for its
 * body. So the token before the target decides, and two of the answers are
 * "leave this one alone":
 *
 * - `{`, `;`, `->`, start of file — the target already begins a statement, so
 *   the parenthesis goes in bare.
 * - `}`, or anything that ends an expression — insert `;(`.
 * - `else` or `do`, or a `)` closing an `if`/`while`/`for` head — an unbraced
 *   body, where a semicolon would silently become the body and the assignment
 *   would move out of the branch. **Refused**, and the file keeps its honest
 *   "could not parse".
 *
 * ## What it will not match
 *
 * The target has to be a plain postfix chain on one line — identifiers, dots,
 * safe calls, `!!`, calls, indices and type arguments, and nothing else. A line
 * carrying a brace (`list.forEach { (it.f()).n = 1 }`), a comma, or an operator
 * at depth zero is skipped rather than wrapped around text that was never the
 * target. Named arguments and default parameter values are inside parentheses
 * and so are never at depth zero to begin with; `==`, `!=`, `<=` and `>=` are
 * not assignments and are read as such.
 *
 * It is a no-op on Kotlin this grammar already reads: every shape it matches —
 * a `.name` behind a `)` on the left of an `=` — is one the parser refuses
 * today. `grammar.spec.ts` asserts that over a corpus rather than trusting it.
 */
function assignmentsThroughCalls(masked: string): Edit[] {
	const edits: Edit[] = [];
	let lineStart = 0;
	while (lineStart < masked.length) {
		let lineEnd = masked.indexOf('\n', lineStart);
		if (lineEnd === -1) lineEnd = masked.length;
		const edit = assignmentThroughCall(masked, lineStart, lineEnd);
		if (edit !== null) edits.push(...edit);
		lineStart = lineEnd + 1;
	}
	return edits;
}

/** The assignment operator on this line, or -1: `=`, `+=`, `-=`, `*=`, `/=`, `%=`. */
function assignmentOperator(masked: string, from: number, to: number): number {
	let depth = 0;
	for (let index = from; index < to; index += 1) {
		const character = masked.charAt(index);
		if (character === '(' || character === '[') depth += 1;
		else if (character === ')' || character === ']') depth -= 1;
		else if (character === '=' && depth === 0) {
			if (masked.charAt(index + 1) === '=') return -1;
			const before = masked.charAt(index - 1);
			// `==`, `!=`, `<=`, `>=` are not assignments; `+=` and its siblings are,
			// and their target starts one character earlier.
			if (before === '=' || before === '!' || before === '<' || before === '>') return -1;
			return '+-*/%'.includes(before) ? index - 1 : index;
		}
	}
	return -1;
}

/** A postfix chain and nothing else: `a.b()`, `a!!.b(c)[0].d`, `this.a.b<T>()`. */
function isPostfixChain(text: string): boolean {
	let residue = '';
	let depth = 0;
	for (const character of text) {
		if (character === '(' || character === '[' || character === '<') depth += 1;
		else if (character === ')' || character === ']' || character === '>') depth -= 1;
		else if (depth === 0) residue += character;
		if (depth < 0) return false;
	}
	return (
		depth === 0 && /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.|!!\.)[A-Za-z_$][\w$]*)*(?:!!)?$/.test(residue)
	);
}

function assignmentThroughCall(masked: string, lineStart: number, lineEnd: number): Edit[] | null {
	let start = lineStart;
	while (start < lineEnd && /[ \t]/.test(masked.charAt(start))) start += 1;

	const operator = assignmentOperator(masked, start, lineEnd);
	if (operator === -1) return null;

	let end = operator;
	while (end > start && /[ \t]/.test(masked.charAt(end - 1))) end -= 1;
	const target = masked.slice(start, end);

	// The navigation being assigned to, and the call it sits behind.
	if (!/\.[A-Za-z_$][\w$]*$/.test(target)) return null;
	const closed = target.lastIndexOf(')');
	if (closed === -1 || target.charAt(closed + 1) !== '.') return null;
	if (!isPostfixChain(target)) return null;

	// A parenthesised expression rather than a call — `(a + b).name = x` parses
	// today, and re-wrapping Kotlin the grammar reads is not a repair.
	const opened = matchingOpenParenthesis(masked, start + closed);
	if (opened === -1 || !/[\w$)\]>]/.test(masked.charAt(opened - 1))) return null;

	const lead = statementLead(masked, start);
	if (lead === null) return null;

	return [
		{ start: start + closed + 1, end: start + closed + 1, text: ')' },
		{ start, end: start, text: lead }
	];
}

/**
 * What has to go in front of the parenthesis, or `null` to leave this alone.
 *
 * Reads backwards over whitespace and comments — both are filler in the mask —
 * to the token that precedes the target. See `assignmentsThroughCalls` for why
 * each answer is what it is.
 */
function statementLead(masked: string, from: number): string | null {
	let index = from - 1;
	while (index >= 0 && (/\s/.test(masked.charAt(index)) || masked.charAt(index) === COMMENT_FILL))
		index -= 1;
	if (index < 0) return '(';

	const character = masked.charAt(index);
	if (character === '{' || character === ';') return '(';
	if (character === '>' && masked.charAt(index - 1) === '-') return '(';
	if (character === '}') return ';(';
	if (character === ')') {
		// A call ends a statement; an `if`/`while`/`for` head does not.
		const opened = matchingOpenParenthesis(masked, index);
		if (opened === -1) return null;
		let head = opened - 1;
		while (head >= 0 && /\s/.test(masked.charAt(head))) head -= 1;
		let word = head;
		while (word >= 0 && /\w/.test(masked.charAt(word))) word -= 1;
		const keyword = masked.slice(word + 1, head + 1);
		return keyword === 'if' || keyword === 'while' || keyword === 'for' ? null : ';(';
	}
	if (/\w/.test(character)) {
		let word = index;
		while (word >= 0 && /\w/.test(masked.charAt(word))) word -= 1;
		const keyword = masked.slice(word + 1, index + 1);
		// An unbraced `else`/`do` body: a semicolon would become the body.
		return keyword === 'else' || keyword === 'do' ? null : ';(';
	}
	// A string, `]`, `!!` or an operator this read does not know: an expression
	// ended here, so a semicolon is safe.
	return character === STRING_FILL || character === ']' || character === '!' ? ';(' : null;
}

/**
 * `if (…) … else "…"` — an unbraced `if` whose else-value opens with a string.
 *
 * The `else` has to be this `if`'s own, so nesting is tracked; and it has to be
 * on the same line, which `bodyEnd` has already guaranteed by stopping at the
 * newline. An `if` whose `else` is on the next line therefore never matches,
 * which is the case a wrap would have broken.
 */
function ifWithStringElse(body: string): boolean {
	if (!/^if[ \t]*\(/.test(body)) return false;
	let depth = 0;
	for (let index = 0; index < body.length; index += 1) {
		const character = body.charAt(index);
		if (character === '(' || character === '[' || character === '{') depth += 1;
		else if (character === ')' || character === ']' || character === '}') depth -= 1;
		else if (
			depth === 0 &&
			body.startsWith('else', index) &&
			!/\w/.test(body.charAt(index - 1) || ' ')
		) {
			const after = body.slice(index + 4);
			const gap = after.length - after.replace(/^[ \t]+/, '').length;
			if (gap > 0 && after.charAt(gap) === STRING_FILL) return true;
		}
	}
	return false;
}

/**
 * The arrow's body, ending at the newline — or sooner.
 *
 * Sooner at a `}` or `)` this body did not open, so `{ … -> return empty() }`
 * closes before the brace rather than swallowing it; and sooner at a comment,
 * so the closing parenthesis never lands inside one. Answers -1 for a body
 * whose brackets do not balance on this line, which is a body that continues
 * below and must not be wrapped.
 */
function bodyEnd(masked: string, start: number): number {
	let depth = 0;
	let index = start;
	for (; index < masked.length; index += 1) {
		const character = masked.charAt(index);
		if (character === '\n' || character === COMMENT_FILL) break;
		if (character === '(' || character === '[' || character === '{') depth += 1;
		else if (character === ')' || character === ']' || character === '}') {
			if (depth === 0) break;
			depth -= 1;
		}
	}
	if (depth !== 0) return -1;
	while (index > start && /[ \t]/.test(masked.charAt(index - 1))) index -= 1;
	return index === start ? -1 : index;
}

/**
 * True when this arrow belongs to a `when` entry rather than to a lambda.
 *
 * Both gaps are specific to a when entry: `{ x -> if (a) "p" else "q" }` and
 * `{ x -> return emptyList() }` both parse, and real files contain the first.
 * Indentation would not tell them apart, so this walks back to the `{` that
 * encloses the arrow and asks what opened it.
 */
function isWhenEntryArrow(masked: string, arrow: number): boolean {
	const opener = enclosingBraceOpener(masked, arrow);
	if (opener === -1) return false;
	let index = opener - 1;
	while (index >= 0 && /\s/.test(masked.charAt(index))) index -= 1;
	if (masked.charAt(index) === ')') {
		index = matchingOpenParenthesis(masked, index);
		if (index === -1) return false;
		index -= 1;
		while (index >= 0 && /\s/.test(masked.charAt(index))) index -= 1;
	}
	let word = index;
	while (word >= 0 && /\w/.test(masked.charAt(word))) word -= 1;
	return masked.slice(word + 1, index + 1) === 'when';
}

function enclosingBraceOpener(masked: string, from: number): number {
	let depth = 0;
	for (let index = from - 1; index >= 0; index -= 1) {
		const character = masked.charAt(index);
		if (character === ')' || character === ']' || character === '}') depth += 1;
		else if (character === '(' || character === '[') {
			// An unmatched `(` reached first means the arrow is inside an argument
			// list or a function type, not a block. Not a when entry.
			if (depth === 0) return -1;
			depth -= 1;
		} else if (character === '{') {
			if (depth === 0) return index;
			depth -= 1;
		}
	}
	return -1;
}

function matchingOpenParenthesis(masked: string, close: number): number {
	let depth = 0;
	for (let index = close; index >= 0; index -= 1) {
		const character = masked.charAt(index);
		if (character === ')') depth += 1;
		else if (character === '(') {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/**
 * Two fillers rather than one, because the difference is load-bearing: a body
 * ends *before* a trailing comment and *at* whatever follows a string. Neither
 * is a word, bracket or quote character, so nothing above matches across one.
 */
const STRING_FILL = '\u0001';
const COMMENT_FILL = '\u0002';

/**
 * Replaces literal bodies and comments with filler of the same length,
 * newlines preserved.
 *
 * Hand-written rather than taken from the parse tree, because the file this is
 * asked about is by definition one the parser could not read — the tree's idea
 * of where a string ends is the thing in question. Kotlin's four awkward cases
 * are all here: nested block comments, `"""` raw strings (which end at the
 * first `"""` not followed by another quote), `${…}` interpolations that may
 * contain further strings, and backtick identifiers, which are skipped without
 * masking because they are code.
 */
function maskLiteralsAndComments(source: string): string {
	const out = source.split('');
	const blank = (from: number, to: number, fill: string): void => {
		for (let index = from; index < to && index < out.length; index += 1) {
			if (out[index] !== '\n') out[index] = fill;
		}
	};
	let at = 0;
	while (at < source.length) {
		const character = source.charAt(at);
		if (character === '/' && source.charAt(at + 1) === '/') {
			let end = at;
			while (end < source.length && source.charAt(end) !== '\n') end += 1;
			blank(at, end, COMMENT_FILL);
			at = end;
		} else if (character === '/' && source.charAt(at + 1) === '*') {
			let depth = 1;
			let end = at + 2;
			while (end < source.length && depth > 0) {
				if (source.startsWith('/*', end)) {
					depth += 1;
					end += 2;
				} else if (source.startsWith('*/', end)) {
					depth -= 1;
					end += 2;
				} else end += 1;
			}
			blank(at, end, COMMENT_FILL);
			at = end;
		} else if (character === '`') {
			let end = at + 1;
			while (end < source.length && source.charAt(end) !== '`' && source.charAt(end) !== '\n') {
				end += 1;
			}
			at = end + 1;
		} else if (source.startsWith('"""', at)) {
			const end = skipRawString(source, at + 3);
			blank(at, end, STRING_FILL);
			at = end;
		} else if (character === '"' || character === "'") {
			const end = skipQuoted(source, at + 1, character);
			blank(at, end, STRING_FILL);
			at = end;
		} else at += 1;
	}
	return out.join('');
}

function skipRawString(source: string, from: number): number {
	let at = from;
	while (at < source.length) {
		if (source.charAt(at) === '$' && source.charAt(at + 1) === '{') {
			at = skipBraces(source, at + 1);
			continue;
		}
		if (source.startsWith('"""', at) && source.charAt(at + 3) !== '"') return at + 3;
		at += 1;
	}
	return source.length;
}

function skipQuoted(source: string, from: number, quote: string): number {
	let at = from;
	while (at < source.length) {
		const character = source.charAt(at);
		if (character === '\\') {
			at += 2;
			continue;
		}
		if (character === '$' && source.charAt(at + 1) === '{') {
			at = skipBraces(source, at + 1);
			continue;
		}
		if (character === quote) return at + 1;
		// An unterminated quote is a mis-lex, not a string running to the end of
		// the file: stop at the newline so the rest stays code.
		if (character === '\n') return at;
		at += 1;
	}
	return source.length;
}

function skipBraces(source: string, open: number): number {
	let depth = 0;
	let at = open;
	while (at < source.length) {
		const character = source.charAt(at);
		if (character === '{') depth += 1;
		else if (character === '}') {
			depth -= 1;
			if (depth === 0) return at + 1;
		} else if (source.startsWith('"""', at)) {
			at = skipRawString(source, at + 3);
			continue;
		} else if (character === '"' || character === "'") {
			at = skipQuoted(source, at + 1, character);
			continue;
		}
		at += 1;
	}
	return source.length;
}

/**
 * A statement that begins with `(`, read as a call on the line above it.
 *
 *     val url = baseUrl + path
 *     (if (filters.isEmpty()) getFilterList() else filters).forEach { … }
 *
 * Kotlin reads two statements there. Its grammar allows no newline in front
 * of a call's argument list — `callSuffix` has no `NL*` where `navigationSuffix`
 * does — so a `(` that begins a line is never an argument list for what ended
 * the line before. The pinned grammar does not know that, and reads one
 * statement: `path(if (…) … else filters).forEach { … }`, the previous line
 * *called* with the next line's parenthesis as its arguments.
 *
 * That is not a parse error, so nothing else here would see it. Where the
 * line above ended in a call the emitter refused the result as "a call
 * returning a callable" (25 listings of one catalogue, eight of them for this
 * alone); where it ended in a plain name it did not refuse at all — `x = y`
 * above `(a + b).let { … }` became `x = y(a + b).let { … }`, a wrong program
 * with nothing reported.
 *
 * The repair is the statement separator Kotlin inferred, written out: a `;` in
 * front of the `(`. Three things keep it to the cases Kotlin agrees with.
 *
 * - **The `(` is the first thing on its line, and the callee ended on an
 *   earlier one.** Read off the tree the pinned grammar produced, not off the
 *   text, so a parenthesis in a string or a comment is never a candidate.
 * - **The newline is one Kotlin counts.** Inside parentheses or brackets it
 *   does not: `listOf(a` newline `(b))` really is `a(b)`. So the call must
 *   sit in a block — a function body, a lambda, a `when` entry — with no
 *   argument list, parenthesis, index, condition or string between it and
 *   the block. Anything else is left alone.
 * - **The result must parse cleanly**, or the file is read as it was.
 *
 * A `;` replaces the indentation character in front of the `(` where there is
 * one, so no offset moves; no newline ever moves, so every line a refusal
 * names is still the line it was.
 */
function lineInitialCalls(parse: (source: string) => SplitNode, source: string): string | null {
	// Cheap enough to run on every file: a line that begins with `(`.
	if (!/\n[ \t]*\(/.test(source)) return null;

	const lines = source.split('\n');
	const starts: number[] = [];
	let offset = 0;
	for (const line of lines) {
		starts.push(offset);
		offset += line.length + 1;
	}

	const edits = new Map<number, Edit>();
	for (const suffix of parse(source).descendantsOfType('call_suffix')) {
		const values = suffix.child(0);
		const callee = suffix.previousSibling;
		if (values === null || callee === null || values.type !== 'value_arguments') continue;
		const row = values.startPosition.row;
		if (row <= callee.endPosition.row || suffix.parent === null) continue;
		const line = lines[row];
		if (line === undefined || !/^[ \t]*\(/.test(line)) continue;
		if (!countedNewline(suffix.parent)) continue;

		const at = starts[row] + line.indexOf('(');
		const before = source.charAt(at - 1);
		edits.set(
			at,
			before === ' ' || before === '\t'
				? { start: at - 1, end: at, text: ';' }
				: { start: at, end: at, text: ';' }
		);
	}
	if (edits.size === 0) return null;

	let output = source;
	for (const edit of [...edits.values()].sort((left, right) => right.start - left.start)) {
		output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
	}
	return output;
}

/**
 * Whether a newline in front of this call is one Kotlin reads as the end of a
 * statement: true inside a block, false inside anything bracketed.
 *
 * Walked outward to the first construct that decides. A condition — `if (…)`,
 * `while (…)`, a `for` header — is parenthesised, so arriving at one from
 * anything but its body is arriving from inside the parentheses.
 */
function countedNewline(from: SplitNode): boolean {
	let child = from;
	for (let at = from.parent; at !== null; child = at, at = at.parent) {
		if (BRACKETED.has(at.type)) return false;
		if (BLOCKS.has(at.type)) return true;
		if (CONDITIONED.has(at.type) && child.type !== 'control_structure_body') return false;
	}
	return true;
}

/** Constructs whose newlines Kotlin ignores. */
const BRACKETED: ReadonlySet<string> = new Set([
	'value_arguments',
	'parenthesized_expression',
	'indexing_suffix',
	'collection_literal',
	'when_subject',
	'function_value_parameters',
	'primary_constructor',
	'annotation',
	'string_literal',
	'interpolation',
	'type_arguments'
]);

/** Constructs whose newlines end a statement. */
const BLOCKS: ReadonlySet<string> = new Set([
	'statements',
	'lambda_literal',
	'when_entry',
	'class_body',
	'source_file'
]);

/** Constructs with a parenthesised header in front of a body. */
const CONDITIONED: ReadonlySet<string> = new Set([
	'if_expression',
	'while_statement',
	'do_while_statement',
	'for_statement',
	'catch_block'
]);

/** The subset of web-tree-sitter's node `lineInitialCalls` reads. */
interface SplitNode {
	readonly type: string;
	readonly startPosition: { readonly row: number };
	readonly endPosition: { readonly row: number };
	readonly parent: SplitNode | null;
	readonly previousSibling: SplitNode | null;
	child(index: number): SplitNode | null;
	descendantsOfType(type: string): SplitNode[];
}

interface ParserModule {
	new (): {
		setLanguage(language: unknown): void;
		parse(source: string): { rootNode: unknown };
	};
	init(options: { wasmBinary: Uint8Array }): Promise<void>;
	Language: { load(bytes: Uint8Array): Promise<unknown> };
}
