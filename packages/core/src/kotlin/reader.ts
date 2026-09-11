/**
 * Reading the declarative half of a Kotlin extension, and refusing the rest.
 *
 * `FOREIGN.md` §4.1 records the measurement this file exists to exploit: a
 * third of a large foreign catalogue is template-generated, and for those the
 * site-specific parts are all constants on a thin subclass of a shared theme
 * base. Where the ecosystem publishes its sources — one `.kt` file per source,
 * a class, a handful of overridden `val`s — those constants can be read out of
 * the text without executing anything at all.
 *
 * **This is not a Kotlin compiler, or a subset of one.** It has no type
 * system, no name resolution, no notion of control flow, and it will never
 * grow one; the moment a converter needs to *run* Kotlin, the answer is the
 * interpreter §4.1 calls the fallback, not more of this. What it does is walk
 * a token stream, pull out four kinds of literal, and name everything else.
 *
 * ## Why `unreadableOverrides` is the load-bearing output
 *
 * The dangerous failure here is not a refusal. It is a reader that skips an
 * `override fun` it did not understand and hands back a tidy-looking record of
 * six constants, because a caller then converts what it believes is a thin
 * declarative subclass and ships a plugin that is subtly, silently wrong —
 * wrong selectors, a missing pagination step, an extractor that never runs.
 * `FOREIGN.md` §6 exists to catch exactly that class of breakage at install
 * time, and the whole point of that section is that a refusal naming a step
 * beats a black screen.
 *
 * So the invariant is: **every member declaration this reader sees goes
 * somewhere.** Either it resolves to a literal and lands in one of the four
 * maps, or its name lands in `unreadableOverrides`. Nothing is dropped. A
 * caller that finds `unreadableOverrides` non-empty is looking at an extension
 * that does something this reader cannot account for, and should say so rather
 * than convert it.
 *
 * ## Rule 9
 *
 * Nothing in this file, and nothing in its tests, names a content source. It
 * takes a string and returns a record; it has no hostnames in it because it
 * has no hostnames to have.
 */

/** What `readKotlin` could make of a file. */
export interface KotlinSource {
	readonly packageName: string | null;
	readonly className: string | null;
	/** The base class, and its type arguments if any. */
	readonly superClass: string | null;
	/** `override val name = "X"` / `const val FOO = "Y"` → { name: 'X', FOO: 'Y' } */
	readonly stringConstants: Readonly<Record<string, string>>;
	readonly intConstants: Readonly<Record<string, number>>;
	readonly boolConstants: Readonly<Record<string, boolean>>;
	/** `override val x = listOf("a","b")` */
	readonly stringLists: Readonly<Record<string, readonly string[]>>;
	/**
	 * Names of members that are overridden with a body this reader cannot read.
	 *
	 * Also carries everything else at file or class scope that was declined
	 * rather than resolved: functions, `init` blocks, secondary constructors,
	 * properties with a `by` delegate or a block getter, `var`s that are
	 * assigned to somewhere else in the file, names declared twice, and the
	 * name of any type declaration other than the primary class. Deduplicated,
	 * in the order first seen.
	 */
	readonly unreadableOverrides: readonly string[];
	readonly imports: readonly string[];
}

/* -------------------------------------------------------------------------
 * Tokens
 * ---------------------------------------------------------------------- */

type TokenKind = 'word' | 'number' | 'string' | 'char' | 'punct';

interface Token {
	readonly kind: TokenKind;
	/** The source text, less the quotes or backticks that delimited it. */
	readonly text: string;
	/**
	 * A string token's decoded contents — or `null` when it contains a template
	 * expression, which is this reader's way of saying "this is code".
	 */
	readonly value: string | null;
	/** A line break (or the start of the file) separates this token from the last. */
	readonly nl: boolean;
}

/**
 * Operators glued together before single characters are considered.
 *
 * Longest first, and deliberately *not* including `<=` or `>=`: `>>` closing a
 * nested generic (`List<List<Int>>`) has to arrive as two `>` tokens for the
 * angle-bracket counting in `readSpecifier` to balance, and a comparison
 * operator that arrives as two tokens costs this reader nothing, because it
 * never evaluates one.
 */
const MULTI_PUNCT = [
	'===',
	'!==',
	'==',
	'!=',
	'&&',
	'||',
	'?:',
	'?.',
	'->',
	'::',
	'..',
	'!!',
	'+=',
	'-=',
	'*=',
	'/=',
	'%=',
	'++',
	'--'
];

const WORD_START = /[\p{L}_]/u;
const WORD_PART = /[\p{L}\p{Nd}_]/u;
const DIGIT = /[0-9]/;

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

/**
 * Whether a `$` at this position opens a string template.
 *
 * Kotlin only treats `$` as a template when an identifier or `{` follows it,
 * so `"costs $5"` is a plain string and `"$id"` is not. Getting this backwards
 * in either direction is a wrong answer: too eager and readable constants get
 * refused, too lax and a placeholder ships as literal text.
 */
function opensTemplate(next: string | undefined): boolean {
	return next !== undefined && (next === '{' || WORD_START.test(next));
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	const n = source.length;
	let i = 0;
	let nl = true;

	const push = (kind: TokenKind, text: string, value: string | null): void => {
		tokens.push({ kind, text, value, nl });
		nl = false;
	};

	while (i < n) {
		const c = source.charAt(i);

		if (c === '\n') {
			nl = true;
			i += 1;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
			i += 1;
			continue;
		}

		// Line comment. Its terminating newline is left for the loop above, so
		// the token after it is still marked as starting a line.
		if (c === '/' && source.charAt(i + 1) === '/') {
			while (i < n && source.charAt(i) !== '\n') i += 1;
			continue;
		}

		// Block comment. Kotlin nests these, unlike C, so a naive scan for the
		// first `*/` would end the wrong comment and start reading prose as code.
		if (c === '/' && source.charAt(i + 1) === '*') {
			let depth = 0;
			while (i < n) {
				if (source.charAt(i) === '/' && source.charAt(i + 1) === '*') {
					depth += 1;
					i += 2;
				} else if (source.charAt(i) === '*' && source.charAt(i + 1) === '/') {
					depth -= 1;
					i += 2;
					if (depth === 0) break;
				} else {
					if (source.charAt(i) === '\n') nl = true;
					i += 1;
				}
			}
			continue;
		}

		// Raw string. No escapes exist inside one, so every `$` that could open
		// a template does, and the closing delimiter is the *last* three quotes
		// of the run — `""""` ends a raw string whose content is one quote.
		if (c === '"' && source.startsWith('"""', i)) {
			const start = i + 3;
			let j = start;
			let contentEnd = n;
			let after = n;
			while (j < n) {
				if (source.charAt(j) === '"') {
					let run = 0;
					while (j + run < n && source.charAt(j + run) === '"') run += 1;
					if (run >= 3) {
						contentEnd = j + run - 3;
						after = j + run;
						break;
					}
					j += run;
				} else {
					j += 1;
				}
			}
			const body = source.slice(start, contentEnd);
			if (body.includes('\n')) nl = true;
			push('string', body, rawTemplate(body) ? null : body);
			i = after;
			continue;
		}

		if (c === '"') {
			const scanned = scanQuoted(source, i, '"');
			push('string', scanned.text, scanned.template ? null : scanned.text);
			i = scanned.next;
			continue;
		}

		if (c === "'") {
			const scanned = scanQuoted(source, i, "'");
			push('char', scanned.text, null);
			i = scanned.next;
			continue;
		}

		// Backtick-quoted identifier. The backticks are not part of the name.
		if (c === '`') {
			let j = i + 1;
			while (j < n && source.charAt(j) !== '`' && source.charAt(j) !== '\n') j += 1;
			push('word', source.slice(i + 1, j), null);
			i = j < n && source.charAt(j) === '`' ? j + 1 : j;
			continue;
		}

		if (DIGIT.test(c)) {
			let j = i;
			while (j < n) {
				const d = source.charAt(j);
				if (WORD_PART.test(d)) {
					j += 1;
					continue;
				}
				if (d === '.' && DIGIT.test(source.charAt(j + 1))) {
					j += 1;
					continue;
				}
				const prev = source.charAt(j - 1);
				if ((d === '+' || d === '-') && (prev === 'e' || prev === 'E')) {
					j += 1;
					continue;
				}
				break;
			}
			push('number', source.slice(i, j), null);
			i = j;
			continue;
		}

		if (WORD_START.test(c)) {
			let j = i;
			while (j < n && WORD_PART.test(source.charAt(j))) j += 1;
			push('word', source.slice(i, j), null);
			i = j;
			continue;
		}

		const multi = MULTI_PUNCT.find((op) => source.startsWith(op, i));
		if (multi !== undefined) {
			push('punct', multi, null);
			i += multi.length;
			continue;
		}

		push('punct', c, null);
		i += 1;
	}

	return tokens;
}

/** A `$` in a raw string always opens a template; there is no escape for it. */
function rawTemplate(body: string): boolean {
	for (let i = 0; i < body.length; i += 1) {
		if (body.charAt(i) === '$' && opensTemplate(body.charAt(i + 1))) return true;
	}
	return false;
}

/** One `"…"` or `'…'`, decoded, with a flag for "this contained code". */
function scanQuoted(
	source: string,
	start: number,
	quote: string
): { text: string; template: boolean; next: number } {
	const n = source.length;
	let i = start + 1;
	let text = '';
	let template = false;
	while (i < n) {
		const c = source.charAt(i);
		if (c === '\n') break;
		if (c === '\\') {
			const escape = source.charAt(i + 1);
			if (escape === 'u') {
				const hex = source.slice(i + 2, i + 6);
				if (/^[0-9a-fA-F]{4}$/.test(hex)) {
					text += String.fromCharCode(parseInt(hex, 16));
					i += 6;
					continue;
				}
			}
			// `\$` is the reason escapes are decoded before templates are looked
			// for: it is a literal dollar, and treating it as a template would
			// refuse a constant that is perfectly readable.
			text += SIMPLE_ESCAPES[escape] ?? escape;
			i += 2;
			continue;
		}
		if (c === quote) {
			i += 1;
			return { text, template, next: i };
		}
		if (c === '$' && opensTemplate(source.charAt(i + 1))) template = true;
		text += c;
		i += 1;
	}
	// Unterminated. Return what there was; the caller will refuse it either way
	// on the strength of the tokens that follow.
	return { text, template, next: i };
}

/* -------------------------------------------------------------------------
 * The vocabulary this reader recognises
 * ---------------------------------------------------------------------- */

const MODIFIERS = new Set([
	'abstract',
	'actual',
	'annotation',
	'companion',
	'const',
	'crossinline',
	'data',
	'enum',
	'expect',
	'external',
	'final',
	'infix',
	'inline',
	'inner',
	'internal',
	'lateinit',
	'noinline',
	'open',
	'operator',
	'override',
	'private',
	'protected',
	'public',
	'reified',
	'sealed',
	'suspend',
	'tailrec',
	'value',
	'vararg'
]);

const DECLARATIONS = new Set([
	'val',
	'var',
	'fun',
	'class',
	'object',
	'interface',
	'init',
	'constructor',
	'typealias'
]);

/** Call shapes whose arguments this reader will read as a list of strings. */
const LIST_BUILDERS = new Set([
	'listOf',
	'mutableListOf',
	'arrayOf',
	'setOf',
	'mutableSetOf',
	'arrayListOf'
]);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

/** Punctuation and keywords that mean "the declaration continues on the next line". */
const CONTINUES_AFTER = new Set([
	'=',
	'+',
	'-',
	'*',
	'/',
	'%',
	',',
	'.',
	':',
	'?',
	'<',
	'>',
	'&&',
	'||',
	'?:',
	'->',
	'::',
	'?.',
	'+=',
	'-=',
	'*=',
	'/=',
	'%=',
	'==',
	'!='
]);
const CONTINUES_AFTER_WORDS = new Set(['by', 'return', 'in', 'is', 'if', 'else', 'while', 'do']);

/** Punctuation and keywords that mean "this line continues the previous one". */
const CONTINUES_BEFORE = new Set([
	'.',
	'?.',
	'::',
	',',
	'+',
	'*',
	'/',
	'%',
	'&&',
	'||',
	'?:',
	'->',
	'=',
	'==',
	'!='
]);
const CONTINUES_BEFORE_WORDS = new Set(['else', 'catch', 'finally', 'where']);

type Literal =
	| { readonly kind: 'string'; readonly value: string }
	| { readonly kind: 'int'; readonly value: number }
	| { readonly kind: 'bool'; readonly value: boolean }
	| { readonly kind: 'list'; readonly value: string[] };

/* -------------------------------------------------------------------------
 * The reader
 * ---------------------------------------------------------------------- */

class Reader {
	private readonly tokens: Token[];
	private i = 0;

	packageName: string | null = null;
	className: string | null = null;
	superClass: string | null = null;
	readonly imports: string[] = [];
	readonly strings = new Map<string, string>();
	readonly ints = new Map<string, number>();
	readonly bools = new Map<string, boolean>();
	readonly lists = new Map<string, string[]>();
	readonly unreadable: string[] = [];

	/** Every name declared so far, so a second declaration can be caught. */
	private readonly declared = new Set<string>();
	/** Names declared `var`, checked against assignments once the walk is done. */
	readonly mutables = new Set<string>();
	/** Set once the file's first `class`/`object` has been taken as the primary. */
	private primaryTaken = false;

	constructor(source: string) {
		this.tokens = tokenize(source);
	}

	/* --- cursor ------------------------------------------------------- */

	private peek(ahead = 0): Token | undefined {
		return this.tokens[this.i + ahead];
	}

	private at(text: string, ahead = 0): boolean {
		const t = this.peek(ahead);
		return t !== undefined && t.kind === 'punct' && t.text === text;
	}

	private atWord(text: string, ahead = 0): boolean {
		const t = this.peek(ahead);
		return t !== undefined && t.kind === 'word' && t.text === text;
	}

	/* --- recording ---------------------------------------------------- */

	private forget(name: string): void {
		this.strings.delete(name);
		this.ints.delete(name);
		this.bools.delete(name);
		this.lists.delete(name);
	}

	/**
	 * Names a member this reader declined.
	 *
	 * Also removes any value already recorded under that name, because a name
	 * that resolved once and then turned out to be ambiguous is exactly the
	 * case where reporting the first value would be worse than reporting
	 * nothing.
	 */
	refuse(name: string): void {
		this.forget(name);
		this.declared.add(name);
		if (!this.unreadable.includes(name)) this.unreadable.push(name);
	}

	private resolve(name: string, literal: Literal): void {
		// A name declared twice — once in the class and once in its companion,
		// say — cannot be resolved without scoping rules this reader does not
		// have, so both declarations become one refusal.
		if (this.declared.has(name)) {
			this.refuse(name);
			return;
		}
		this.declared.add(name);
		if (literal.kind === 'string') this.strings.set(name, literal.value);
		else if (literal.kind === 'int') this.ints.set(name, literal.value);
		else if (literal.kind === 'bool') this.bools.set(name, literal.value);
		else this.lists.set(name, literal.value);
	}

	/* --- skipping ----------------------------------------------------- */

	/** Consumes a balanced `(`/`[`/`{` group; assumes the cursor is on the opener. */
	private skipBalanced(): void {
		const open = this.peek();
		if (open === undefined || open.kind !== 'punct') return;
		const close = open.text === '(' ? ')' : open.text === '[' ? ']' : '}';
		let depth = 0;
		while (this.i < this.tokens.length) {
			const t = this.tokens[this.i];
			this.i += 1;
			if (t === undefined || t.kind !== 'punct') continue;
			if (t.text === open.text) depth += 1;
			else if (t.text === close) {
				depth -= 1;
				if (depth === 0) return;
			}
		}
	}

	/**
	 * Consumes `<…>`, counting nesting.
	 *
	 * Bails on a token that cannot appear in a type argument list, so that a
	 * stray `<` used as a comparison somewhere unexpected costs one token
	 * rather than the rest of the file.
	 */
	private skipAngles(): void {
		if (!this.at('<')) return;
		let depth = 0;
		while (this.i < this.tokens.length) {
			const t = this.tokens[this.i];
			if (t === undefined) return;
			if (t.kind === 'punct') {
				if (t.text === '{' || t.text === ';' || t.text === '=') return;
				if (t.text === '<') depth += 1;
				else if (t.text === '>') {
					depth -= 1;
					if (depth === 0) {
						this.i += 1;
						return;
					}
				}
			}
			this.i += 1;
		}
	}

	/** `@Foo`, `@Foo("bar")`, `@file:Suppress(…)`, `@get:JvmName(…)`. */
	private skipAnnotation(): void {
		this.i += 1; // '@'
		if (this.peek()?.kind === 'word') this.i += 1;
		if (this.at(':')) {
			this.i += 1;
			if (this.peek()?.kind === 'word') this.i += 1;
		}
		while (this.at('.') && this.peek(1)?.kind === 'word') this.i += 2;
		if (this.at('(')) this.skipBalanced();
		if (this.at('[')) this.skipBalanced();
	}

	/**
	 * Walks past the rest of a declaration.
	 *
	 * Kotlin has no statement terminator, so the end of a declaration is "back
	 * at bracket depth zero, at a line break that is not a continuation". The
	 * continuation sets are what stop a wrapped `+` chain or a `.also { }`
	 * on the following line from being mistaken for the next member.
	 */
	private skipDeclaration(): void {
		let depth = 0;
		// Seeded with the token *before* the cursor rather than left undefined,
		// so that skipping a declaration which has already ended — an abstract
		// `val` with no initializer, say — consumes nothing and does not eat the
		// modifiers of the member that follows it.
		let prev: Token | undefined = this.tokens[this.i - 1];
		for (;;) {
			const t = this.peek();
			if (t === undefined) return;
			if (depth === 0 && t.kind === 'punct') {
				if (t.text === '}' || t.text === ')' || t.text === ']') return;
				if (t.text === ';') {
					this.i += 1;
					return;
				}
			}
			if (depth === 0 && prev !== undefined && t.nl && !continues(prev, t)) return;
			if (t.kind === 'punct') {
				if (t.text === '{' || t.text === '(' || t.text === '[') depth += 1;
				else if (t.text === '}' || t.text === ')' || t.text === ']') depth -= 1;
			}
			this.i += 1;
			prev = t;
		}
	}

	/** Walks past `: SomeType<…>?` up to whatever gives the property its value. */
	private skipType(): void {
		let paren = 0;
		let angle = 0;
		let prev: Token | undefined;
		for (;;) {
			const t = this.peek();
			if (t === undefined) return;
			if (paren === 0 && angle === 0) {
				if (t.kind === 'punct' && (t.text === '=' || t.text === ';')) return;
				if (t.kind === 'punct' && (t.text === '}' || t.text === ')')) return;
				if (t.kind === 'word' && (t.text === 'by' || t.text === 'get' || t.text === 'set')) {
					return;
				}
				if (prev !== undefined && t.nl && !continues(prev, t)) return;
			}
			if (t.kind === 'punct') {
				if (t.text === '(') paren += 1;
				else if (t.text === ')') paren -= 1;
				else if (t.text === '<') angle += 1;
				else if (t.text === '>' && angle > 0) angle -= 1;
			}
			this.i += 1;
			prev = t;
		}
	}

	/* --- literals ----------------------------------------------------- */

	/**
	 * One string, allowing `+` between literals and names already resolved to
	 * strings.
	 *
	 * Only *already seen* names resolve, which is a real limitation and a
	 * deliberate one: following a forward reference would mean a second pass
	 * and a dependency order, and a base URL assembled out of order is the kind
	 * of near-miss this reader exists not to produce. A name that does not
	 * resolve fails the whole initializer, so the member is refused.
	 */
	private readStringExpression(): string | null {
		let out = '';
		for (;;) {
			const t = this.peek();
			if (t === undefined) return null;
			if (t.kind === 'string') {
				// `value === null` is a template: the string is code, not text.
				if (t.value === null) return null;
				out += t.value;
				this.i += 1;
			} else if (t.kind === 'word' && this.strings.has(t.text)) {
				// A call or a member access on the name is not a constant.
				if (this.at('(', 1) || this.at('.', 1) || this.at('{', 1)) return null;
				out += this.strings.get(t.text) ?? '';
				this.i += 1;
			} else {
				return null;
			}
			if (!this.at('+')) return out;
			this.i += 1;
		}
	}

	/** `listOf("a", "b",)`, `arrayOf<String>()`, and the trailing comma. */
	private readStringList(): string[] | null {
		const head = this.peek();
		if (head === undefined || head.kind !== 'word' || !LIST_BUILDERS.has(head.text)) return null;
		this.i += 1;
		if (this.at('<')) this.skipAngles();
		if (!this.at('(')) return null;
		this.i += 1;
		const out: string[] = [];
		for (;;) {
			if (this.at(')')) {
				this.i += 1;
				return out;
			}
			const element = this.readStringExpression();
			if (element === null) return null;
			out.push(element);
			if (this.at(',')) {
				this.i += 1;
				continue;
			}
			if (this.at(')')) {
				this.i += 1;
				return out;
			}
			return null;
		}
	}

	/**
	 * The whole of an initializer, or nothing.
	 *
	 * Restores the cursor on failure so the caller can fall back to skipping
	 * the declaration wholesale.
	 */
	private readLiteral(): Literal | null {
		const start = this.i;
		const attempt = (): Literal | null => {
			const t = this.peek();
			if (t === undefined) return null;

			if (t.kind === 'word' && (t.text === 'true' || t.text === 'false')) {
				this.i += 1;
				return { kind: 'bool', value: t.text === 'true' };
			}

			if (t.kind === 'punct' && (t.text === '-' || t.text === '+')) {
				const digits = this.peek(1);
				if (digits === undefined || digits.kind !== 'number') return null;
				const magnitude = parseIntLiteral(digits.text);
				if (magnitude === null) return null;
				this.i += 2;
				return { kind: 'int', value: t.text === '-' ? -magnitude : magnitude };
			}

			if (t.kind === 'number') {
				const value = parseIntLiteral(t.text);
				if (value === null) return null;
				this.i += 1;
				return { kind: 'int', value };
			}

			if (t.kind === 'word' && LIST_BUILDERS.has(t.text)) {
				const list = this.readStringList();
				return list === null ? null : { kind: 'list', value: list };
			}

			const text = this.readStringExpression();
			return text === null ? null : { kind: 'string', value: text };
		};

		const literal = attempt();
		if (literal !== null && this.terminates()) return literal;
		this.i = start;
		return null;
	}

	/**
	 * Whether the expression just read was the *whole* initializer.
	 *
	 * Without this, `listOf("a").map { … }` would be read as `["a"]` and
	 * `"x" ?: y` as `"x"` — both of which are the silent-wrongness this file
	 * is written to avoid. Anything still on the line means there was more
	 * expression than this reader understood.
	 */
	private terminates(): boolean {
		const t = this.peek();
		if (t === undefined) return true;
		if (t.kind === 'punct' && (t.text === '}' || t.text === ';')) return true;
		return t.nl;
	}

	/* --- declarations ------------------------------------------------- */

	/** Reads `a.b.c` (and `a.b.*`) as written. */
	private readDottedPath(): string {
		const parts: string[] = [];
		for (;;) {
			const t = this.peek();
			if (t === undefined) break;
			if (t.kind === 'word') {
				parts.push(t.text);
				this.i += 1;
			} else if (t.kind === 'punct' && t.text === '*') {
				parts.push('*');
				this.i += 1;
				break;
			} else {
				break;
			}
			if (this.at('.')) this.i += 1;
			else break;
		}
		return parts.join('.');
	}

	/**
	 * The declared name of a member, past any receiver it extends.
	 *
	 * `fun List<String>.clean()` and `val Config.host` are both members named
	 * by their last segment; the receiver — type arguments and all — belongs to
	 * the signature and not to the name.
	 */
	private readMemberName(): string | null {
		let name: string | null = null;
		for (;;) {
			const t = this.peek();
			if (t === undefined || t.kind !== 'word') break;
			name = t.text;
			this.i += 1;
			if (this.at('<')) this.skipAngles();
			if (this.at('.') && this.peek(1)?.kind === 'word') this.i += 1;
			else break;
		}
		return name;
	}

	private readProperty(isVar: boolean): void {
		if (this.at('<')) this.skipAngles();

		const name = this.readMemberName();
		if (name === null) {
			this.skipDeclaration();
			return;
		}
		if (isVar) this.mutables.add(name);

		if (this.at(':')) {
			this.i += 1;
			this.skipType();
		}

		if (this.at('=')) {
			this.i += 1;
			const literal = this.readLiteral();
			if (literal === null) {
				this.refuse(name);
				this.skipDeclaration();
				return;
			}
			// An initializer with a custom accessor after it is not the value
			// the property reports; only the getter is.
			if (this.hasAccessorAhead()) {
				this.refuse(name);
				this.skipDeclaration();
				return;
			}
			this.resolve(name, literal);
			return;
		}

		// `get() = "literal"` is the one function body shape worth reading,
		// because it is a constant that happens to be spelled as a getter.
		if (this.atWord('get') && this.at('(', 1) && this.at(')', 2) && this.at('=', 3)) {
			this.i += 4;
			const literal = this.readLiteral();
			if (literal !== null) {
				this.resolve(name, literal);
				return;
			}
		}

		// `by lazy { … }`, `by injectLazy()`, a block getter, or no initializer
		// at all (an abstract declaration, which has no value to report).
		this.refuse(name);
		this.skipDeclaration();
	}

	/** Whether a `get`/`set` accessor follows, past any modifiers on it. */
	private hasAccessorAhead(): boolean {
		let ahead = 0;
		for (;;) {
			const t = this.peek(ahead);
			if (t === undefined || t.kind !== 'word') return false;
			if (t.text === 'get' || t.text === 'set') return true;
			if (!MODIFIERS.has(t.text)) return false;
			ahead += 1;
		}
	}

	private readFunction(): void {
		if (this.at('<')) this.skipAngles();
		this.refuse(this.readMemberName() ?? 'fun');
		this.skipDeclaration();
	}

	/**
	 * The primary class header: name, type parameters, primary constructor,
	 * and the delegation specifier list.
	 *
	 * Kotlin does not distinguish a superclass from an interface here, so the
	 * first specifier that is *called* — the one with constructor arguments —
	 * is preferred, and the first specifier of any kind is the fallback. For
	 * the shape this reader is aimed at, the theme base is invariably the one
	 * being called.
	 */
	private readClassHeader(nameParameters: boolean): {
		name: string | null;
		superClass: string | null;
	} {
		const nameToken = this.peek();
		const name = nameToken !== undefined && nameToken.kind === 'word' ? nameToken.text : null;
		if (name !== null) this.i += 1;

		if (this.at('<')) this.skipAngles();

		if (this.at('(')) {
			if (nameParameters) this.readPrimaryConstructor();
			else this.skipBalanced();
		}

		let superClass: string | null = null;
		if (this.at(':')) {
			this.i += 1;
			let firstAny: string | null = null;
			let firstCalled: string | null = null;
			for (;;) {
				const specifier = this.readSpecifier();
				if (specifier.text.length > 0) {
					if (firstAny === null) firstAny = specifier.text;
					if (specifier.called && firstCalled === null) firstCalled = specifier.text;
				}
				if (this.at(',')) {
					this.i += 1;
					continue;
				}
				break;
			}
			superClass = firstCalled ?? firstAny;
		}

		if (this.atWord('where')) {
			// Bounded by the line, because a class with a `where` clause and no
			// body would otherwise swallow the rest of the file.
			this.i += 1;
			while (this.peek() !== undefined && !this.at('{') && this.peek()?.nl !== true) this.i += 1;
		}
		return { name, superClass };
	}

	/**
	 * Skips the primary constructor, naming any `val`/`var` parameter on the
	 * way past.
	 *
	 * A constructor parameter's default is not the property's value — whoever
	 * constructs the class decides that — so these are members with values
	 * this reader genuinely cannot know, which is precisely what
	 * `unreadableOverrides` is for.
	 */
	private readPrimaryConstructor(): void {
		const start = this.i;
		this.i += 1;
		let depth = 1;
		while (this.i < this.tokens.length && depth > 0) {
			const t = this.tokens[this.i];
			if (t === undefined) break;
			if (t.kind === 'punct') {
				if (t.text === '(') depth += 1;
				else if (t.text === ')') depth -= 1;
			}
			if (
				depth === 1 &&
				t.kind === 'word' &&
				(t.text === 'val' || t.text === 'var') &&
				this.peek(1)?.kind === 'word'
			) {
				const named = this.peek(1);
				if (named !== undefined) this.refuse(named.text);
			}
			this.i += 1;
		}
		if (depth > 0) this.i = start;
	}

	/** One entry in a delegation specifier list, with its type arguments. */
	private readSpecifier(): { text: string; called: boolean } {
		const parts: string[] = [];
		let angle = 0;
		for (;;) {
			const t = this.peek();
			if (t === undefined) break;
			if (t.kind === 'punct' && t.text === '<') {
				angle += 1;
				parts.push('<');
				this.i += 1;
				continue;
			}
			if (t.kind === 'punct' && t.text === '>') {
				if (angle === 0) break;
				angle -= 1;
				parts.push('>');
				this.i += 1;
				continue;
			}
			if (angle === 0) {
				if (t.kind === 'punct' && (t.text === ',' || t.text === '(' || t.text === '{')) break;
				if (parts.length > 0 && t.nl) break;
				if (t.kind === 'word' && t.text === 'by') break;
			} else if (t.kind === 'punct' && t.text === ',') {
				parts.push(',');
				this.i += 1;
				continue;
			}
			if (t.kind === 'word' || (t.kind === 'punct' && (t.text === '.' || t.text === '?'))) {
				parts.push(t.text);
				this.i += 1;
				continue;
			}
			if (t.kind === 'punct' && t.text === '*' && angle > 0) {
				parts.push('*');
				this.i += 1;
				continue;
			}
			break;
		}
		let called = false;
		if (this.at('(')) {
			this.skipBalanced();
			called = true;
		}
		// `: Base by delegate` — a delegated interface, not a base class.
		if (this.atWord('by')) {
			this.i += 1;
			this.skipDeclarationTail();
		}
		return { text: joinType(parts), called };
	}

	/** Consumes one delegate expression inside a specifier list. */
	private skipDeclarationTail(): void {
		for (;;) {
			const t = this.peek();
			if (t === undefined) return;
			if (t.kind === 'punct' && (t.text === ',' || t.text === '{')) return;
			if (t.kind === 'punct' && (t.text === '(' || t.text === '[')) {
				this.skipBalanced();
				continue;
			}
			this.i += 1;
		}
	}

	/* --- scopes ------------------------------------------------------- */

	/**
	 * Walks a run of declarations: the file, a class body, or a companion.
	 *
	 * `braced` means the scope ends at a `}` rather than at the end of input.
	 */
	private readScope(braced: boolean): void {
		for (;;) {
			const t = this.peek();
			if (t === undefined) return;

			if (t.kind === 'punct' && t.text === '}') {
				this.i += 1;
				if (braced) return;
				continue;
			}
			if (t.kind === 'punct' && t.text === '@') {
				this.skipAnnotation();
				continue;
			}
			if (t.kind === 'punct' && (t.text === '{' || t.text === '(' || t.text === '[')) {
				this.skipBalanced();
				continue;
			}
			if (t.kind !== 'word') {
				this.i += 1;
				continue;
			}

			if (!braced && t.text === 'package' && this.packageName === null) {
				this.i += 1;
				this.packageName = this.readDottedPath() || null;
				continue;
			}
			if (!braced && t.text === 'import') {
				this.i += 1;
				const path = this.readDottedPath();
				if (path.length > 0) this.imports.push(path);
				if (this.atWord('as')) this.i += 2;
				continue;
			}

			// Modifiers and annotations only count as such when a declaration
			// keyword actually follows; `data` and `value` are perfectly good
			// identifiers otherwise.
			const found = this.findDeclarationKeyword();
			if (found === null) {
				this.i += 1;
				continue;
			}
			const { keyword, modifiers, index } = found;
			this.i = index + 1;

			if (keyword === 'val' || keyword === 'var') {
				this.readProperty(keyword === 'var');
				continue;
			}
			if (keyword === 'fun') {
				this.readFunction();
				continue;
			}
			if (keyword === 'init') {
				this.refuse('init');
				this.skipDeclaration();
				continue;
			}
			if (keyword === 'constructor') {
				this.refuse('constructor');
				this.skipDeclaration();
				continue;
			}
			if (keyword === 'typealias') {
				this.skipDeclaration();
				continue;
			}

			// A companion object is not a separate scope as far as a caller is
			// concerned — `Foo.BAR` reads the same either way — so its members
			// are merged into the class's.
			if (keyword === 'object' && modifiers.has('companion')) {
				if (this.peek()?.kind === 'word') this.i += 1;
				if (this.at(':')) this.readClassHeaderTailOnly();
				if (this.at('{')) {
					this.i += 1;
					this.readScope(true);
				}
				continue;
			}

			const primaryEligible =
				!braced &&
				!this.primaryTaken &&
				(keyword === 'class' || keyword === 'object') &&
				!modifiers.has('enum') &&
				!modifiers.has('annotation');

			if (primaryEligible) {
				this.primaryTaken = true;
				const header = this.readClassHeader(true);
				this.className = header.name;
				this.superClass = header.superClass;
				if (this.at('{')) {
					this.i += 1;
					this.readScope(true);
				}
				continue;
			}

			// Any other type declaration. Its name is reported and its body is
			// not read: a file with a second class in it is not the thin
			// declarative subclass this reader is looking for, and saying so is
			// more useful than merging two classes' constants into one record.
			const other = this.readClassHeader(false);
			this.refuse(other.name ?? keyword);
			if (this.at('{')) this.skipBalanced();
		}
	}

	/** `companion object : Something {` — the specifier list, discarded. */
	private readClassHeaderTailOnly(): void {
		this.i += 1;
		for (;;) {
			this.readSpecifier();
			if (this.at(',')) {
				this.i += 1;
				continue;
			}
			return;
		}
	}

	/**
	 * Looks ahead over modifiers and annotations for a declaration keyword.
	 *
	 * Returns `null` when the run does not end in one, which is how a bare
	 * expression using `value` or `data` as a variable name stays a bare
	 * expression.
	 */
	private findDeclarationKeyword(): {
		keyword: string;
		modifiers: Set<string>;
		index: number;
	} | null {
		const modifiers = new Set<string>();
		let j = this.i;
		for (;;) {
			const t = this.tokens[j];
			if (t === undefined) return null;
			if (t.kind === 'punct' && t.text === '@') {
				const saved = this.i;
				this.i = j;
				this.skipAnnotation();
				j = this.i;
				this.i = saved;
				continue;
			}
			if (t.kind !== 'word') return null;
			if (DECLARATIONS.has(t.text)) return { keyword: t.text, modifiers, index: j };
			if (!MODIFIERS.has(t.text)) return null;
			modifiers.add(t.text);
			j += 1;
		}
	}

	/**
	 * Refuses every `var` that is assigned to anywhere else in the file.
	 *
	 * A `var` initializer is a starting value, not a constant, and a reader
	 * that reports one as a constant is wrong in exactly the way a `var` exists
	 * to allow. Named arguments (`copy(x = 1)`) are excluded, since those are
	 * not assignments to the property at all.
	 */
	private refuseReassignedVars(): void {
		if (this.mutables.size === 0) return;
		for (let j = 0; j < this.tokens.length; j += 1) {
			const t = this.tokens[j];
			const next = this.tokens[j + 1];
			if (t === undefined || next === undefined) continue;
			if (t.kind !== 'word' || !this.mutables.has(t.text)) continue;
			if (next.kind !== 'punct' || !ASSIGN_OPS.has(next.text)) continue;
			const prev = this.tokens[j - 1];
			if (prev !== undefined) {
				if (prev.kind === 'word' && (prev.text === 'val' || prev.text === 'var')) continue;
				if (prev.kind === 'punct' && (prev.text === '(' || prev.text === ',')) continue;
			}
			this.refuse(t.text);
		}
	}

	run(): void {
		this.readScope(false);
		this.refuseReassignedVars();
	}
}

/* -------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------- */

function continues(prev: Token, next: Token): boolean {
	if (prev.kind === 'punct' && CONTINUES_AFTER.has(prev.text)) return true;
	if (prev.kind === 'word' && CONTINUES_AFTER_WORDS.has(prev.text)) return true;
	if (next.kind === 'punct' && CONTINUES_BEFORE.has(next.text)) return true;
	if (next.kind === 'word' && CONTINUES_BEFORE_WORDS.has(next.text)) return true;
	return false;
}

/** Rebuilds a type's text from its tokens: `Map<String, List<Int>>`. */
function joinType(parts: readonly string[]): string {
	let out = '';
	for (const part of parts) {
		if (out.length === 0) {
			out = part;
			continue;
		}
		const prev = out.charAt(out.length - 1);
		const tight =
			part === '.' ||
			part === '<' ||
			part === '>' ||
			part === '?' ||
			part === ',' ||
			prev === '.' ||
			prev === '<';
		out += tight ? part : ` ${part}`;
	}
	return out;
}

/**
 * A Kotlin integer literal, or `null` for anything that is not one.
 *
 * Floats, and integers too large to survive as a JavaScript number, both
 * return `null` rather than a rounded answer.
 */
function parseIntLiteral(text: string): number | null {
	const body = text.replace(/_/g, '').replace(/[uUlL]+$/, '');
	let value: number;
	if (/^0[xX][0-9a-fA-F]+$/.test(body)) value = parseInt(body.slice(2), 16);
	else if (/^0[bB][01]+$/.test(body)) value = parseInt(body.slice(2), 2);
	else if (/^[0-9]+$/.test(body)) value = parseInt(body, 10);
	else return null;
	return Number.isSafeInteger(value) ? value : null;
}

function fromMap<T>(map: Map<string, T>): Readonly<Record<string, T>> {
	const out: Record<string, T> = {};
	for (const [key, value] of map) out[key] = value;
	return Object.freeze(out);
}

/**
 * Reads one Kotlin file's declarative surface.
 *
 * Never throws and never fails: a file that is not Kotlin at all comes back as
 * nulls and empty maps, and a file this reader half-understands comes back
 * with the half it understood plus the names of the rest. The caller decides
 * what a non-empty `unreadableOverrides` means; `FOREIGN.md` §5 is why it
 * should usually mean "do not convert this".
 */
export function readKotlin(source: string): KotlinSource {
	const reader = new Reader(source);
	reader.run();
	return {
		packageName: reader.packageName,
		className: reader.className,
		superClass: reader.superClass,
		stringConstants: fromMap(reader.strings),
		intConstants: fromMap(reader.ints),
		boolConstants: fromMap(reader.bools),
		stringLists: Object.freeze(fromMap(reader.lists)),
		unreadableOverrides: Object.freeze([...reader.unreadable]),
		imports: Object.freeze([...reader.imports])
	};
}
