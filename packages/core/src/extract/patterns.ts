/**
 * Generic de-obfuscation and packaging transforms, as pure string functions.
 *
 * A converted module's last mile is usually the same shape: it has fetched a
 * page, and the thing it wants is buried under one or two layers of *generic*
 * packaging — a well-known JavaScript packer, numeric character escapes, a
 * player config object, a base64 blob. Those layers are properties of the
 * tooling that produced the page, not of whoever produced the page, and the
 * same handful of them recur everywhere. Implemented once, here, they stop
 * being re-implemented (badly, and differently) by every converted module.
 *
 * ## Nothing here executes anything. Ever.
 *
 * Every input to every function in this file is attacker-controlled text: it
 * came off the network, into a sandbox that was built on the premise that a
 * plugin gets no ambient capability (`AGENTS.md` rule 13). `eval` and
 * `new Function` would hand that text the whole sandbox — the packer's own
 * decoder is a `while` loop and a `replace`, and running it as code to get a
 * string out is a trade nobody should make. So the packer is *parsed*: its
 * arguments are read as data and the substitution is done here. There is no
 * `eval`, no `new Function`, no timer given a string, no dynamic module
 * import, and no code path that constructs a callable from input — which
 * `patterns.spec.ts` asserts against this file's own text, so that adding one
 * fails the suite rather than a review.
 *
 * ## Totality
 *
 * These run on adversarial input, so every function is total: it returns
 * `null`, `''` or `[]` rather than throwing, and it terminates rather than
 * spinning. Loops advance a monotonic index over a bounded string; the ones
 * that could not be shown to advance carry an explicit bound. Sizes, depth and
 * node counts are capped at the top of the file — a nested literal 10,000 deep
 * and a packer claiming a billion substitutions are both *inputs*, not bugs.
 *
 * ## Host-agnostic, by rule
 *
 * `AGENTS.md` rule 9. There is not a hostname, a site, a CDN or a service in
 * this file, in its identifiers, in its comments or in its tests, and there is
 * not going to be one. Everything below is a transform over a string that is
 * described entirely by the *shape* of the string. Anything that could only be
 * described by naming where it came from is not a generic transform and does
 * not belong here.
 *
 * ## The engine subset
 *
 * `contract/plugin-api/ABI.md` §6. ES2020 only, and none of `Intl`, regex
 * lookbehind, `structuredClone`, `Array.prototype.at`, `Object.groupBy`,
 * `String.prototype.replaceAll`, `TextEncoder`/`TextDecoder` or `atob`/`btoa`
 * — which is why `base64Encode`/`base64Decode` do the UTF-8 and the radix-64
 * arithmetic by hand instead of borrowing a global that exists in exactly one
 * of the three engines.
 */

/* -------------------------------------------------------------------------
 * Bounds
 *
 * Chosen to be far larger than any real page and far smaller than "hangs".
 * ---------------------------------------------------------------------- */

/** Longest input any function will look at. Beyond this it declines. */
const MAX_INPUT = 4_000_000;

/** How deep a literal may nest before it is treated as hostile. */
const MAX_DEPTH = 64;

/** How many values one literal may contain. */
const MAX_NODES = 20_000;

/** Ceiling on a packer's claimed substitution count, before clamping. */
const MAX_PACKER_WORDS = 200_000;

/** Ceiling on how many candidate packer calls are tried in one input. */
const MAX_PACKER_ATTEMPTS = 8;

/** Ceiling on results, so a pathological page cannot produce a huge array. */
const MAX_RESULTS = 512;

/**
 * Ceiling on how many `sources:` keys are parsed in one input.
 *
 * Reading one is linear in what follows it, so reading an unbounded number of
 * them is quadratic — which a page consisting of nothing but that key,
 * repeated, would exploit. A page carrying more than this many player
 * configurations is not a page carrying player configurations.
 */
const MAX_PLAYER_CONFIGS = 64;

/** Ceiling on the arguments of one character-code call. */
const MAX_CHAR_CODE_ARGS = 8192;

/* -------------------------------------------------------------------------
 * Shared lexical scanning
 *
 * Brace matching that is not string- and comment-aware is brace matching that
 * an input can lie to, so all of it goes through these.
 * ---------------------------------------------------------------------- */

/** `\w` as the language means it: what a word-boundary substitution respects. */
function isWordCode(code: number): boolean {
	return (
		(code >= 48 && code <= 57) ||
		(code >= 65 && code <= 90) ||
		(code >= 97 && code <= 122) ||
		code === 95
	);
}

/** Index of the next significant character: whitespace and comments skipped. */
function skipTrivia(text: string, start: number): number {
	let i = start;
	while (i < text.length) {
		const code = text.charCodeAt(i);
		if (
			code === 0x20 ||
			code === 0x09 ||
			code === 0x0a ||
			code === 0x0d ||
			code === 0x0b ||
			code === 0x0c ||
			code === 0xa0 ||
			code === 0xfeff
		) {
			i++;
			continue;
		}
		if (code === 0x2f /* / */ && i + 1 < text.length) {
			const next = text.charCodeAt(i + 1);
			if (next === 0x2f /* / */) {
				i += 2;
				while (i < text.length) {
					const c = text.charCodeAt(i);
					if (c === 0x0a || c === 0x0d) break;
					i++;
				}
				continue;
			}
			if (next === 0x2a /* * */) {
				const end = text.indexOf('*/', i + 2);
				i = end === -1 ? text.length : end + 2;
				continue;
			}
		}
		break;
	}
	return i;
}

interface Scanned {
	readonly value: string;
	readonly end: number;
}

/**
 * One numeric escape, resolved.
 *
 * Only the numeric ones: `\xNN`, `\uNNNN`, `\u{...}`. Everything else is
 * somebody else's decision, because the two callers disagree about it — a
 * string literal wants `\n` to become a newline, and a source-text pass wants
 * it left exactly as the two characters it is.
 */
function readNumericEscape(text: string, start: number): Scanned | null {
	if (text.charCodeAt(start) !== 0x5c /* \ */) return null;
	const kind = text[start + 1];

	if (kind === 'x') {
		const digits = text.slice(start + 2, start + 4);
		if (!/^[0-9a-fA-F]{2}$/.test(digits)) return null;
		return { value: String.fromCharCode(parseInt(digits, 16)), end: start + 4 };
	}

	if (kind !== 'u') return null;

	if (text[start + 2] === '{') {
		const close = text.indexOf('}', start + 3);
		if (close === -1 || close - (start + 3) > 6) return null;
		const digits = text.slice(start + 3, close);
		if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) return null;
		const point = parseInt(digits, 16);
		if (point > 0x10ffff) return null;
		return { value: String.fromCodePoint(point), end: close + 1 };
	}

	const digits = text.slice(start + 2, start + 6);
	if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
	return { value: String.fromCharCode(parseInt(digits, 16)), end: start + 6 };
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
	n: '\n',
	t: '\t',
	r: '\r',
	b: '\b',
	f: '\f',
	v: '\v',
	'0': '\0'
};

/**
 * One string literal, decoded.
 *
 * Accepts all three quote characters. A template literal is read as a plain
 * string: a `${...}` substitution is not evaluated (nothing here is), it is
 * simply kept as the characters it is written with.
 */
function scanStringLiteral(text: string, start: number): Scanned | null {
	const quote = text[start];
	if (quote !== '"' && quote !== "'" && quote !== '`') return null;

	let out = '';
	let i = start + 1;
	while (i < text.length) {
		const ch = text[i];
		if (ch === quote) return { value: out, end: i + 1 };

		if (ch === '\\') {
			if (i + 1 >= text.length) return null;
			const numeric = readNumericEscape(text, i);
			if (numeric !== null) {
				out += numeric.value;
				i = numeric.end;
				continue;
			}
			const escaped = text[i + 1];
			if (escaped === '\n') {
				i += 2;
				continue;
			}
			const simple = Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, escaped)
				? SIMPLE_ESCAPES[escaped]
				: escaped;
			out += simple;
			i += 2;
			continue;
		}

		if ((ch === '\n' || ch === '\r') && quote !== '`') return null;
		out += ch;
		i++;
	}
	return null;
}

/**
 * The index of the `}` (or `]`, or `)`) that closes the one at `openIndex`.
 *
 * String- and comment-aware; `-1` when the input never closes it. Only the
 * one pair is counted, so an unrelated bracket of another kind inside cannot
 * throw the count off.
 */
function matchBracket(text: string, openIndex: number): number {
	const open = text[openIndex];
	const close = open === '{' ? '}' : open === '[' ? ']' : open === '(' ? ')' : '';
	if (close === '') return -1;

	let depth = 0;
	let i = openIndex;
	while (i < text.length) {
		const ch = text[i];

		if (ch === '"' || ch === "'" || ch === '`') {
			const str = scanStringLiteral(text, i);
			if (str === null) return -1;
			i = str.end;
			continue;
		}

		if (ch === '/') {
			const after = skipTrivia(text, i);
			if (after !== i) {
				i = after;
				continue;
			}
		}

		if (ch === open) {
			depth++;
			i++;
			continue;
		}
		if (ch === close) {
			depth--;
			i++;
			if (depth === 0) return i - 1;
			continue;
		}
		i++;
	}
	return -1;
}

/* -------------------------------------------------------------------------
 * 1. The classic self-extracting packer
 * ---------------------------------------------------------------------- */

/**
 * The head of a packed payload.
 *
 * The parameter list is the fingerprint — the last one is spelled `d` or `r`
 * depending on which vintage of the packer produced it, and some emitters drop
 * the leading `eval` call when the payload is embedded rather than standalone.
 */
const PACKER_HEAD =
	/(?:eval\s*\(\s*)?function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*[dr]\s*\)\s*\{/g;

/** The invocation, for inputs whose body defeats brace matching. */
const PACKER_TAIL = /\}\s*\(\s*['"`]/g;

/**
 * The packer's own index encoding, reimplemented.
 *
 * Its decoder writes this as a recursive `e(c)`: digits `0-9a-z` for values
 * under 36, and `String.fromCharCode(c + 29)` above that, most significant
 * digit first. It is a base-`base` numeral with an unusual digit set, so it is
 * computed here as one.
 */
function packerToken(index: number, base: number): string {
	let value = index;
	let out = '';
	// A 32-bit index in base 2 is 32 digits; the bound is slack, not a limit.
	for (let step = 0; step < 64; step++) {
		const digit = value % base;
		out = (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36)) + out;
		value = Math.floor(value / base);
		if (value === 0) break;
	}
	return out;
}

interface PackerArguments {
	readonly payload: string;
	readonly base: number;
	readonly count: number;
	readonly words: readonly string[];
}

/** A number literal in argument position. `null` when it is not one. */
function readArgumentNumber(text: string, start: number): { value: number; end: number } | null {
	const match = /^[+-]?(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
		text.slice(start, start + 32)
	);
	if (match === null) return null;
	const value = Number(match[0].charAt(0) === '+' ? match[0].slice(1) : match[0]);
	if (!Number.isFinite(value)) return null;
	return { value, end: start + match[0].length };
}

/** The dictionary argument: `'a|b|c'.split('|')`, or a plain array of strings. */
function readArgumentWords(text: string, start: number): { words: string[]; end: number } | null {
	const pos = skipTrivia(text, start);

	if (text[pos] === '[') {
		const literal = parseJsObjectLiteral(text, pos);
		if (!Array.isArray(literal)) return null;
		const close = matchBracket(text, pos);
		if (close === -1) return null;
		const words = literal
			.slice(0, MAX_PACKER_WORDS)
			.map((entry) => (typeof entry === 'string' ? entry : ''));
		return { words, end: close + 1 };
	}

	const joined = scanStringLiteral(text, pos);
	if (joined === null) return null;

	let separator = '|';
	let end = joined.end;
	const afterString = skipTrivia(text, joined.end);
	if (text.slice(afterString, afterString + 6) === '.split') {
		const openParen = skipTrivia(text, afterString + 6);
		if (text[openParen] === '(') {
			const argument = scanStringLiteral(text, skipTrivia(text, openParen + 1));
			if (argument !== null) {
				const closeParen = skipTrivia(text, argument.end);
				if (text[closeParen] === ')') {
					separator = argument.value;
					end = closeParen + 1;
				}
			}
		}
	}

	const words = (separator === '' ? joined.value.split('') : joined.value.split(separator)).slice(
		0,
		MAX_PACKER_WORDS
	);
	return { words, end };
}

/** The four arguments that matter, read as data. `text[parenIndex]` is `(`. */
function readPackerArguments(text: string, parenIndex: number): PackerArguments | null {
	let pos = skipTrivia(text, parenIndex + 1);

	const payload = scanStringLiteral(text, pos);
	if (payload === null || payload.value.length > MAX_INPUT) return null;
	pos = skipTrivia(text, payload.end);
	if (text[pos] !== ',') return null;

	const base = readArgumentNumber(text, skipTrivia(text, pos + 1));
	if (base === null) return null;
	pos = skipTrivia(text, base.end);
	if (text[pos] !== ',') return null;

	const count = readArgumentNumber(text, skipTrivia(text, pos + 1));
	if (count === null) return null;
	pos = skipTrivia(text, count.end);
	if (text[pos] !== ',') return null;

	const words = readArgumentWords(text, pos + 1);
	if (words === null) return null;

	if (!Number.isInteger(base.value) || base.value < 2 || base.value > 62) return null;
	if (!Number.isInteger(count.value) || count.value < 0) return null;

	return {
		payload: payload.value,
		base: base.value,
		count: count.value,
		words: words.words
	};
}

/**
 * Word-boundary substitution over the payload, in one pass.
 *
 * The packer's decoder does this as `count` sequential regex replacements, and
 * a single pass is both cheaper and — where the two differ — more faithful to
 * what was actually encoded. They differ only when a dictionary word is itself
 * the token of a *lower* index, in which case the sequential loop replaces the
 * word it just inserted; that is the packer's own long-standing collision bug,
 * and reproducing it would corrupt correctly packed input rather than match
 * it. The pass is also O(payload) regardless of `count`, which is what makes a
 * dictionary of 200,000 entries uninteresting instead of quadratic.
 */
function substituteTokens(payload: string, words: ReadonlyMap<string, string>): string {
	let out = '';
	let i = 0;
	while (i < payload.length) {
		const start = i;
		while (i < payload.length && isWordCode(payload.charCodeAt(i))) i++;
		if (i > start) {
			const token = payload.slice(start, i);
			const word = words.get(token);
			out += word === undefined ? token : word;
			continue;
		}
		out += payload[i];
		i++;
	}
	return out;
}

/** One candidate call, decoded. `null` when its arguments do not read. */
function unpackAt(source: string, bodyOpenIndex: number): string | null {
	let parenIndex = -1;

	const bodyClose = matchBracket(source, bodyOpenIndex);
	if (bodyClose !== -1) {
		const afterBody = skipTrivia(source, bodyClose + 1);
		if (source[afterBody] === '(') parenIndex = afterBody;
	}

	if (parenIndex === -1) {
		// A body containing a regular expression with an unbalanced brace can
		// defeat the matcher. The invocation itself is still unambiguous.
		PACKER_TAIL.lastIndex = bodyOpenIndex;
		const tail = PACKER_TAIL.exec(source);
		if (tail === null) return null;
		parenIndex = tail.index + tail[0].length - 1;
		while (parenIndex > tail.index && source[parenIndex] !== '(') parenIndex--;
		if (source[parenIndex] !== '(') return null;
	}

	const args = readPackerArguments(source, parenIndex);
	if (args === null) return null;

	const count = Math.min(args.count, args.words.length, MAX_PACKER_WORDS);
	const words = new Map<string, string>();
	for (let i = 0; i < count; i++) {
		const word = args.words[i];
		// `d[e(c)] = k[c] || e(c)`: an empty slot decodes to its own token, so
		// there is nothing to substitute and nothing to record.
		if (typeof word === 'string' && word.length > 0) words.set(packerToken(i, args.base), word);
	}

	return substituteTokens(args.payload, words);
}

/**
 * Decode a payload packed by the classic `p,a,c,k,e,d` packer.
 *
 * Returns `null` when the input is not packed, when its arguments do not parse
 * as the four data values they are supposed to be, or when it is too large to
 * look at. A payload that is itself packed comes back still packed — call
 * again if you want the next layer, so that the number of layers stays the
 * caller's decision rather than an unbounded loop's.
 */
export function unpackDeanEdwards(source: string): string | null {
	if (typeof source !== 'string' || source.length === 0 || source.length > MAX_INPUT) return null;

	PACKER_HEAD.lastIndex = 0;
	for (let attempt = 0; attempt < MAX_PACKER_ATTEMPTS; attempt++) {
		const head = PACKER_HEAD.exec(source);
		if (head === null) return null;

		const bodyOpenIndex = head.index + head[0].length - 1;
		const unpacked = unpackAt(source, bodyOpenIndex);
		if (unpacked !== null) return unpacked;
	}
	return null;
}

/* -------------------------------------------------------------------------
 * 1b. The string-array obfuscator
 * ---------------------------------------------------------------------- */

/**
 * Ceiling on how many shifts a rotation is tried before it is abandoned.
 *
 * The real count is bounded by the dictionary's length, and a dictionary long
 * enough to exceed this is one whose checksum is never going to agree anyway.
 */
const MAX_ROTATIONS = 4096;

/** Shortest array taken for a dictionary rather than an ordinary literal. */
const MIN_DICTIONARY = 8;

/** Ceiling on how many call sites are rewritten in one input. */
const MAX_SUBSTITUTIONS = 100_000;

/**
 * An identifier as this obfuscator writes one: `_0x` and hex, optionally behind
 * a prefix (its `identifiersPrefix` option, `a0_0x51fb` by default in some
 * builds). Top-level names carry the prefix and locals do not, so every reader
 * below accepts both — a pattern that only knew the bare form declined every
 * prefixed build outright, returning null for a source it could read.
 */
const OBFUSCATED_NAME = '[A-Za-z_$][\\w$]*?_0x[0-9a-fA-F]+|_0x[0-9a-fA-F]+';

/** A name as a literal inside a larger regular expression. */
function literalName(name: string): string {
	return name.replace(/[$]/g, '\\$');
}

/**
 * The rotation loop's own statement: the array's first entry moved to its end.
 *
 * Asked separately from the call that closes the loop, because the two answer
 * different questions. The call supplies the target; this says a rotation
 * *exists*. A source that rotates but whose call this cannot read must not be
 * read as though it did not rotate — that is how every string came out shifted
 * by a few places, confidently, with nothing to say so.
 */
const ROTATES =
	/\[\s*(['"])push\1\s*\]\s*\(\s*[\w$]+\s*\[\s*(['"])shift\2\s*\]\s*\(\s*\)\s*\)|\.push\(\s*[\w$]+\.shift\(\s*\)\s*\)/;

/**
 * A radix-64 alphabet written out in full, as this obfuscator's decoder does.
 *
 * Matched by *shape* rather than compared against a constant, because the
 * alphabet is a property of the build: the common one puts lowercase first,
 * which is not the standard order, and decoding with the wrong table does not
 * fail — it returns a different string of the same length. That is the whole
 * reason this is read from the source instead of assumed.
 */
const RADIX_64_ALPHABET = /['"]([A-Za-z0-9+/=]{65})['"]/;

/**
 * The text of the balanced `{...}` starting at or after `from`.
 *
 * String literals are skipped rather than scanned, because a brace inside one
 * is text and counting it closes the block early — which then reads as a
 * function whose body is a prefix of itself.
 */
function balancedBraces(text: string, from: number): { body: string; end: number } | null {
	const open = text.indexOf('{', from);
	if (open < 0) return null;

	let depth = 0;
	for (let i = open; i < text.length; i++) {
		const c = text.charAt(i);
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return { body: text.slice(open + 1, i), end: i };
		} else if (c === '"' || c === "'" || c === '`') {
			i++;
			while (i < text.length && text.charAt(i) !== c) {
				if (text.charAt(i) === '\\') i++;
				i++;
			}
		}
	}
	return null;
}

/** A hex or decimal integer, as this obfuscator writes them. */
function readInteger(text: string): number | null {
	const value = /^(?:0[xX][0-9a-fA-F]+|\d+)$/.test(text) ? Number(text) : Number.NaN;
	return Number.isFinite(value) ? value : null;
}

/**
 * The dictionary: a zero-argument function whose whole body is one array of
 * strings, which it then caches by reassigning its own name.
 *
 * Found by shape rather than by name, because every identifier in this output
 * is a fresh hash. The array is read as *data* — the quotes, the `\x` escapes
 * and the ordering are all there is to it.
 */
function readDictionary(source: string): { name: string; items: string[] } | null {
	const declaration = new RegExp('function\\s+(' + OBFUSCATED_NAME + ')\\s*\\(\\s*\\)\\s*\\{', 'g');
	for (let found = declaration.exec(source); found !== null; found = declaration.exec(source)) {
		const body = balancedBraces(source, found.index + found[0].length - 1);
		if (body === null) continue;

		const literal = /=\s*\[([\s\S]*?)\]\s*;/.exec(body.body);
		if (literal === null) continue;

		const items: string[] = [];
		const entry = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;
		for (let one = entry.exec(literal[1]); one !== null; one = entry.exec(literal[1])) {
			items.push(decodeJsUnicodeEscapes(one[1] === undefined ? (one[2] ?? '') : one[1]));
			if (items.length > MAX_NODES) return null;
		}
		if (items.length >= MIN_DICTIONARY) return { name: found[1], items };
	}
	return null;
}

/**
 * The decoder: the function that reads the dictionary by index.
 *
 * `offset` is the constant subtracted from every index, so that the numbers at
 * the call sites do not start at zero. `alphabet` is the radix-64 table the
 * entries are encoded with, taken from the decoder's own body, or `null` when
 * this build stored them as plain text.
 */
function readDecoder(
	source: string,
	dictionary: string
): { name: string; offset: number; alphabet: string | null; keyed: boolean } | null {
	const declaration = new RegExp(
		'function\\s+(' + OBFUSCATED_NAME + ')\\s*\\(([^)]*)\\)\\s*\\{',
		'g'
	);
	for (let found = declaration.exec(source); found !== null; found = declaration.exec(source)) {
		if (found[1] === dictionary || found[2].trim().length === 0) continue;

		const body = balancedBraces(source, found.index + found[0].length - 1);
		if (body === null || !body.body.includes(dictionary + '(')) continue;

		const shift = /=\s*\w+\s*-\s*(0[xX][0-9a-fA-F]+|\d+)/.exec(body.body);
		const offset = shift === null ? 0 : (readInteger(shift[1]) ?? 0);
		const table = RADIX_64_ALPHABET.exec(body.body);
		return {
			name: found[1],
			offset,
			alphabet: table === null ? null : table[1],
			keyed: usesKey(body.body)
		};
	}
	return null;
}

/**
 * Whether a decoder decrypts with a key, as the RC4 build does.
 *
 * That build radix-64 decodes an entry and then runs RC4 over it, keyed by the
 * call site's second argument. This file has no RC4 and the key is per call, so
 * decoding the radix-64 layer alone would answer every string as ciphertext
 * that happens to be printable — a wrong string in the one place a reader looks
 * for hosts. The key schedule's `% 0x100` over a 256-entry state is the shape
 * that gives it away, and a decoder carrying it is declined.
 */
function usesKey(body: string): boolean {
	return /%\s*(?:0x100|256)\b/.test(body) && /(?:0x100|256)\s*;/.test(body);
}

/**
 * Every name that holds the decoder, following assignment chains.
 *
 * A `const` keyword is deliberately *not* required. A minifier writes the
 * second and later declarators of one statement without one — `const a={…},
 * b=decode;` — and the decoder alias is very often among those. Requiring the
 * keyword loses every call made through such an alias, which does not fail:
 * it silently leaves those strings encoded, and whatever reads the result
 * afterwards sees a source that simply does not mention them.
 */
function decoderNames(source: string, decoder: string): Set<string> {
	const direct = new Map<string, string>();
	const assignment = new RegExp(
		'(?<![\\w$])(' + OBFUSCATED_NAME + ')\\s*=\\s*(' + OBFUSCATED_NAME + ')\\s*[;,)]',
		'g'
	);
	for (let one = assignment.exec(source); one !== null; one = assignment.exec(source)) {
		direct.set(one[1], one[2]);
	}

	const names = new Set<string>([decoder]);
	for (let grew = true; grew;) {
		grew = false;
		direct.forEach((to, from) => {
			if (names.has(to) && !names.has(from)) {
				names.add(from);
				grew = true;
			}
		});
	}
	return names;
}

/**
 * `{ _0xaa: 0x91, … }` tables, flattened to `owner.key → index`.
 *
 * The obfuscator hoists most of its indices into one of these per function and
 * writes the call sites as `decode(table.key)`. A reader that only understands
 * a literal argument therefore misses the majority of them — and, worse, misses
 * them inside the rotation checksum, where the consequence is not a few stray
 * strings but a rotation that never converges at all.
 */
function numericTables(source: string): Map<string, number> {
	const tables = new Map<string, number>();
	const table = new RegExp('(?<![\\w$])(' + OBFUSCATED_NAME + ')\\s*=\\s*\\{([^{}]*)\\}', 'g');
	for (let one = table.exec(source); one !== null; one = table.exec(source)) {
		const field = /(_0x[0-9a-fA-F]+)\s*:\s*(0[xX][0-9a-fA-F]+|\d+)/g;
		for (let f = field.exec(one[2]); f !== null; f = field.exec(one[2])) {
			const at = readInteger(f[2]);
			if (at !== null) tables.set(one[1] + '.' + f[1], at);
		}
	}
	return tables;
}

/**
 * Radix-64 over a table read from the source, decoded as UTF-8.
 *
 * `base64Decode` is deliberately not reused: it is correct for the standard
 * alphabet and this one is not standard, and the difference shows up as a
 * decode that succeeds and answers wrongly rather than one that reports a
 * problem. Padding ends the data; a character outside the table is skipped,
 * which is what the decoder being imitated does.
 */
function decodeRadix64(value: string, alphabet: string): string {
	const bytes: number[] = [];
	let accumulator = 0;
	let bits = 0;

	for (let i = 0; i < value.length; i++) {
		const digit = alphabet.indexOf(value.charAt(i));
		if (digit < 0) continue;
		if (digit === 64) break;
		accumulator = (accumulator << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >> bits) & 0xff);
		}
	}

	return utf8Decode(bytes);
}

/**
 * The rotation checksum, evaluated as arithmetic over data.
 *
 * Total and non-recursive in its inputs: `+ - * / ( )` and `parseInt(d(i))`,
 * nothing else. Anything it does not recognise ends the parse and returns
 * `null`, which abandons the rotation rather than guessing at it.
 *
 * This exists because the dictionary cannot be read until it has been rotated,
 * and the rotation is defined by a checksum over the dictionary's own entries.
 * The obfuscator resolves that circularity by *running* a loop. Running it is
 * exactly what this file does not do, so the expression is parsed instead and
 * the loop is driven from outside.
 */
function evaluateChecksum(
	expression: string,
	read: (index: number) => number,
	tables: Map<string, number>
): number | null {
	let at = 0;
	const skip = (): void => {
		while (at < expression.length && /\s/.test(expression.charAt(at))) at++;
	};

	const primary = (): number | null => {
		skip();
		if (expression.charAt(at) === '-') {
			at++;
			const value = primary();
			return value === null ? null : -value;
		}
		if (expression.charAt(at) === '+') {
			at++;
			return primary();
		}
		if (expression.charAt(at) === '(') {
			at++;
			const value = sum();
			skip();
			if (expression.charAt(at) !== ')') return null;
			at++;
			return value;
		}

		const rest = expression.slice(at);
		const literal = /^parseInt\(\s*[A-Za-z_$][\w$]*\(\s*(0[xX][0-9a-fA-F]+|\d+)\s*\)\s*\)/.exec(
			rest
		);
		if (literal !== null) {
			at += literal[0].length;
			const index = readInteger(literal[1]);
			return index === null ? null : read(index);
		}
		const indirect = new RegExp(
			'^parseInt\\(\\s*[A-Za-z_$][\\w$]*\\(\\s*(' +
				OBFUSCATED_NAME +
				')\\.(' +
				OBFUSCATED_NAME +
				')\\s*\\)\\s*\\)'
		).exec(rest);
		if (indirect !== null) {
			const index = tables.get(indirect[1] + '.' + indirect[2]);
			if (index === undefined) return null;
			at += indirect[0].length;
			return read(index);
		}
		const number = /^(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?)/.exec(rest);
		if (number !== null) {
			at += number[0].length;
			return Number(number[0]);
		}
		return null;
	};

	const product = (): number | null => {
		let left = primary();
		if (left === null) return null;
		for (;;) {
			skip();
			const operator = expression.charAt(at);
			if (operator !== '*' && operator !== '/') return left;
			at++;
			const right = primary();
			if (right === null) return null;
			left = operator === '*' ? left * right : left / right;
		}
	};

	const sum = (): number | null => {
		let left = product();
		if (left === null) return null;
		for (;;) {
			skip();
			const operator = expression.charAt(at);
			if (operator !== '+' && operator !== '-') return left;
			at++;
			const right = product();
			if (right === null) return null;
			left = operator === '+' ? left + right : left - right;
		}
	};

	return sum();
}

/**
 * Rewrite a string-array-obfuscated source so its strings are readable.
 *
 * The scheme: every string literal is moved into one array, each call site
 * becomes `decode(index)`, and the array is shifted at load until a checksum
 * over a few of its own entries equals a constant. It is the default output of
 * a widely used obfuscator, so this is a property of the *tool*, not of anyone
 * who ran it, and it is worth defeating once here rather than per ecosystem.
 *
 * Nothing is executed. The dictionary and the index offset are read as data,
 * the radix-64 layer is `decodeRadix64` over the decoder's own alphabet, and
 * the rotation is driven from outside by parsing its checksum, exactly as the
 * loop drives itself. Calls are rewritten only after the rotation's closing
 * call, so the checksum still reads the dictionary as it turns and the output
 * still runs. `fixtures/string-array/` holds the obfuscator's own output with
 * expected text produced by executing it, and the spec holds this to that.
 *
 * Returns `null` — which a caller reads as "not in this form", and then uses
 * the source as it is — whenever the answer would not be certain: the input is
 * not in this form or too large; the source rotates and the rotation's call or
 * checksum cannot be read, or does not converge within its bound; or the
 * decoder decrypts with a per-call key (the RC4 build), which this file cannot.
 * A checksum reached only through the obfuscator's offset-shifting wrapper
 * functions is one it cannot read, and so declines as well.
 *
 * ## Why a caller should care
 *
 * Because *everything* a static reader wants is inside that array: the hosts a
 * source reaches, the settings it declares, the endpoints it calls. A reader
 * that runs before this one does not see a smaller set of them — it very
 * often sees none, and reports a source that names nothing as a source that
 * needs nothing.
 */
export function unpackStringArray(source: string): string | null {
	if (typeof source !== 'string' || source.length === 0 || source.length > MAX_INPUT) return null;

	const dictionary = readDictionary(source);
	if (dictionary === null) return null;

	const decoder = readDecoder(source, dictionary.name);
	if (decoder === null || decoder.keyed) return null;

	const items = dictionary.items.slice();
	let cache = new Map<number, string>();
	const decode = (index: number): string | undefined => {
		const at = index - decoder.offset;
		if (at < 0 || at >= items.length) return undefined;
		const hit = cache.get(at);
		if (hit !== undefined) return hit;
		const value =
			decoder.alphabet === null ? items[at] : decodeRadix64(items[at], decoder.alphabet);
		cache.set(at, value);
		return value;
	};

	const tables = numericTables(source);

	// The rotation, when there is one. `}(dictionary, target)` is the call that
	// closes the self-checking loop, and the `var … = -parseInt(…` inside it is
	// the checksum whose value that target is.
	//
	// What follows the call is not part of it. The obfuscator usually writes the
	// program after it with a comma — `}(dict, 0xd9f3b), (function () {…}())` —
	// and a pattern that demanded a closing parenthesis there found no rotation
	// at all, then read the dictionary unrotated: every string shifted by the
	// same few places, output that parsed and ran and was wrong.
	const closing = new RegExp(
		'\\}\\s*\\(\\s*' + literalName(dictionary.name) + '\\s*,\\s*(0[xX][0-9a-fA-F]+|\\d+)\\s*\\)'
	);
	const rotation = closing.exec(source);

	// Where rewriting may start. Everything before the end of the rotation call
	// is left exactly as written: the checksum reads the dictionary *while* it
	// is being rotated, and a call rewritten there to its settled value turns the
	// loop's test into a constant, and the loop into one that never ends.
	let rewriteFrom = 0;

	if (rotation !== null || ROTATES.test(source)) {
		// A source that rotates and whose rotation cannot be read is declined,
		// never read as though it did not rotate.
		if (rotation === null) return null;
		const target = readInteger(rotation[1]);
		const checksumPattern = new RegExp(
			'(?:const|let|var)\\s+(?:' +
				OBFUSCATED_NAME +
				')\\s*=\\s*(-?\\s*parseInt[\\s\\S]*?);\\s*if\\s*\\(',
			'g'
		);
		// The checksum is the one *inside* this loop: the last before its call.
		let checksum: string | null = null;
		for (
			let one = checksumPattern.exec(source);
			one !== null && one.index < rotation.index;
			one = checksumPattern.exec(source)
		) {
			checksum = one[1];
		}
		if (target === null || checksum === null) return null;

		// Driven exactly as the loop drives itself: from no shift, one entry at a
		// time, stopping at the first arrangement whose checksum is the target.
		// `parseInt` with no radix, as the loop calls it — a radix of ten reads
		// an entry beginning `0x` differently from the code being imitated.
		let shifted = 0;
		for (; shifted < MAX_ROTATIONS; shifted++) {
			cache = new Map<number, string>();
			const value = evaluateChecksum(
				checksum,
				(i) => {
					const entry = decode(i);
					return entry === undefined ? Number.NaN : parseInt(entry);
				},
				tables
			);
			if (value === target) break;
			const first = items.shift();
			if (first === undefined) return null;
			items.push(first);
		}
		if (shifted >= MAX_ROTATIONS) return null;
		cache = new Map<number, string>();
		rewriteFrom = rotation.index + rotation[0].length;
	}

	const names = decoderNames(source, decoder.name);
	const group: string[] = [];
	names.forEach((one) => group.push(literalName(one)));
	const alternation = group.join('|');

	let substitutions = 0;
	const replaceCall = (whole: string, index: number | undefined): string => {
		if (index === undefined || substitutions >= MAX_SUBSTITUTIONS) return whole;
		const value = decode(index);
		if (value === undefined || value === '') return whole;
		substitutions++;
		return JSON.stringify(value);
	};

	let rest = source
		.slice(rewriteFrom)
		.replace(
			new RegExp('(?<![\\w$])(?:' + alternation + ')\\((0[xX][0-9a-fA-F]+|\\d+)\\)', 'g'),
			(whole, digits: string) => replaceCall(whole, readInteger(digits) ?? undefined)
		);
	rest = rest.replace(
		new RegExp(
			'(?<![\\w$])(?:' +
				alternation +
				')\\((' +
				OBFUSCATED_NAME +
				')\\.(' +
				OBFUSCATED_NAME +
				')\\)',
			'g'
		),
		(whole, owner: string, key: string) => replaceCall(whole, tables.get(owner + '.' + key))
	);
	return source.slice(0, rewriteFrom) + rest;
}

/* -------------------------------------------------------------------------
 * 2. Numeric character escapes
 * ---------------------------------------------------------------------- */

/** A numeric literal argument to a character-code call: decimal or hex. */
const CHAR_CODE_ARGUMENT = /[+-]?(?:0[xX][0-9a-fA-F]+|\d+)/y;

/**
 * A `String.fromCharCode(...)` chain, resolved.
 *
 * Chained rather than single because the concatenated form is as common as the
 * variadic one, and resolving each call separately would leave `+` signs
 * stranded between the characters they were meant to join.
 */
function readCharCodeChain(text: string, start: number): Scanned | null {
	let value = '';
	let i = start;
	let calls = 0;

	while (i < text.length && calls < MAX_CHAR_CODE_ARGS) {
		const isCharCode = text.startsWith('String.fromCharCode', i);
		const isCodePoint = text.startsWith('String.fromCodePoint', i);
		if (!isCharCode && !isCodePoint) break;

		const open = skipTrivia(text, i + (isCharCode ? 19 : 20));
		if (text[open] !== '(') break;

		let pos = skipTrivia(text, open + 1);
		let produced = '';
		let arguments_ = 0;
		let closed = false;

		while (pos < text.length && arguments_ < MAX_CHAR_CODE_ARGS) {
			if (text[pos] === ')') {
				closed = true;
				pos++;
				break;
			}
			CHAR_CODE_ARGUMENT.lastIndex = pos;
			const match = CHAR_CODE_ARGUMENT.exec(text);
			if (match === null) break;
			const point = Number(match[0].charAt(0) === '+' ? match[0].slice(1) : match[0]);
			if (!Number.isInteger(point) || point < 0) break;
			if (isCodePoint) {
				if (point > 0x10ffff) break;
				produced += String.fromCodePoint(point);
			} else {
				produced += String.fromCharCode(point & 0xffff);
			}
			arguments_++;
			pos = skipTrivia(text, pos + match[0].length);
			if (text[pos] === ',') pos = skipTrivia(text, pos + 1);
		}

		if (!closed) break;

		value += produced;
		i = pos;
		calls++;

		const afterCall = skipTrivia(text, i);
		if (text[afterCall] !== '+') break;
		const afterPlus = skipTrivia(text, afterCall + 1);
		if (
			!text.startsWith('String.fromCharCode', afterPlus) &&
			!text.startsWith('String.fromCodePoint', afterPlus)
		) {
			break;
		}
		i = afterPlus;
	}

	return calls === 0 ? null : { value, end: i };
}

/**
 * Resolve `\xNN`, `\uNNNN`, `\u{...}` and character-code calls to text.
 *
 * A source-text pass, not a string decoder: it rewrites those sequences
 * wherever they appear and leaves everything else — including `\n` and every
 * other non-numeric escape — exactly as written, because the point is to make
 * the *content* of an obfuscated blob searchable, not to re-lex it.
 *
 * A backslash that escapes another backslash consumes it, so `\\u0041` stays
 * the six characters it already is instead of being decoded a level too far.
 * Anything that does not parse is emitted verbatim.
 */
export function decodeJsUnicodeEscapes(source: string): string {
	if (typeof source !== 'string' || source.length === 0) return '';
	if (source.length > MAX_INPUT) return source;

	let out = '';
	let i = 0;
	while (i < source.length) {
		const ch = source[i];

		if (ch === '\\') {
			const numeric = readNumericEscape(source, i);
			if (numeric !== null) {
				out += numeric.value;
				i = numeric.end;
				continue;
			}
			if (source[i + 1] === '\\') {
				out += '\\\\';
				i += 2;
				continue;
			}
			out += ch;
			i++;
			continue;
		}

		if (ch === 'S' && source.startsWith('String.from', i)) {
			const chain = readCharCodeChain(source, i);
			if (chain !== null) {
				out += chain.value;
				i = chain.end;
				continue;
			}
		}

		out += ch;
		i++;
	}
	return out;
}

/* -------------------------------------------------------------------------
 * 3 & 5. JavaScript object literals
 * ---------------------------------------------------------------------- */

interface ReaderState {
	readonly text: string;
	pos: number;
	nodes: number;
	failed: boolean;
}

const IDENTIFIER = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER = /[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;

const KEYWORDS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined']);

function keywordValue(word: string): unknown {
	if (word === 'true') return true;
	if (word === 'false') return false;
	if (word === 'null') return null;
	return undefined;
}

function toNumber(literal: string): number {
	const negative = literal.charAt(0) === '-';
	const body = literal.charAt(0) === '+' || negative ? literal.slice(1) : literal;
	const value = Number(body);
	return negative ? -value : value;
}

/**
 * Move past a value that is not a literal, without evaluating it.
 *
 * A player config is a *program*, so a value position can hold a function, a
 * variable, an arithmetic expression or a constructor call. None of those has
 * a statically known value, so the parser records `undefined` and steps over
 * the expression — bracket-, string- and comment-aware, stopping at the comma
 * or closer that belongs to the current depth. The alternative is failing the
 * whole literal because one key held a callback, which would throw away the
 * keys the caller actually wanted.
 */
function skipOpaqueValue(state: ReaderState): void {
	const text = state.text;
	let depth = 0;
	let i = state.pos;

	while (i < text.length) {
		const ch = text[i];

		if (ch === '"' || ch === "'" || ch === '`') {
			const str = scanStringLiteral(text, i);
			if (str === null) {
				state.failed = true;
				return;
			}
			i = str.end;
			continue;
		}

		if (ch === '/') {
			const after = skipTrivia(text, i);
			if (after !== i) {
				i = after;
				continue;
			}
		}

		if (ch === '{' || ch === '[' || ch === '(') {
			depth++;
			i++;
			continue;
		}
		if (ch === '}' || ch === ']' || ch === ')') {
			if (depth === 0) break;
			depth--;
			i++;
			continue;
		}
		if (ch === ',' && depth === 0) break;
		i++;
	}

	if (i === state.pos) {
		// No progress means there was no value here at all.
		state.failed = true;
		return;
	}
	state.pos = i;
}

function readValue(state: ReaderState, depth: number): unknown {
	if (state.failed) return undefined;
	state.nodes++;
	if (depth > MAX_DEPTH || state.nodes > MAX_NODES) {
		state.failed = true;
		return undefined;
	}

	state.pos = skipTrivia(state.text, state.pos);
	if (state.pos >= state.text.length) {
		state.failed = true;
		return undefined;
	}

	const ch = state.text[state.pos];
	if (ch === '{') return readObject(state, depth);
	if (ch === '[') return readArray(state, depth);

	if (ch === '"' || ch === "'" || ch === '`') {
		const str = scanStringLiteral(state.text, state.pos);
		if (str === null) {
			state.failed = true;
			return undefined;
		}
		state.pos = str.end;
		return str.value;
	}

	IDENTIFIER.lastIndex = state.pos;
	const identifier = IDENTIFIER.exec(state.text);
	if (identifier !== null) {
		const end = state.pos + identifier[0].length;
		if (KEYWORDS.has(identifier[0]) && endsValue(state.text, end)) {
			state.pos = end;
			return keywordValue(identifier[0]);
		}
		skipOpaqueValue(state);
		return undefined;
	}

	NUMBER.lastIndex = state.pos;
	const number = NUMBER.exec(state.text);
	if (number !== null) {
		const end = state.pos + number[0].length;
		if (endsValue(state.text, end)) {
			state.pos = end;
			return toNumber(number[0]);
		}
	}

	skipOpaqueValue(state);
	return undefined;
}

/** Whether what follows `end` is a delimiter, rather than more expression. */
function endsValue(text: string, end: number): boolean {
	const next = skipTrivia(text, end);
	if (next >= text.length) return true;
	const ch = text[next];
	return ch === ',' || ch === '}' || ch === ']';
}

function readObject(state: ReaderState, depth: number): Record<string, unknown> | undefined {
	const result: Record<string, unknown> = {};
	state.pos++; // the `{`

	while (state.pos < state.text.length) {
		state.pos = skipTrivia(state.text, state.pos);
		if (state.text[state.pos] === '}') {
			state.pos++;
			return result;
		}

		const key = readKey(state);
		if (state.failed || key === null) {
			state.failed = true;
			return undefined;
		}

		state.pos = skipTrivia(state.text, state.pos);
		if (state.text[state.pos] !== ':') {
			state.failed = true;
			return undefined;
		}
		state.pos++;

		const value = readValue(state, depth + 1);
		if (state.failed) return undefined;

		// `defineProperty` rather than assignment: a literal is allowed to
		// contain a `__proto__` key, and plain assignment would let it reach
		// the prototype instead of the object.
		Object.defineProperty(result, key, {
			value,
			enumerable: true,
			writable: true,
			configurable: true
		});

		state.pos = skipTrivia(state.text, state.pos);
		if (state.text[state.pos] === ',') {
			state.pos++;
			continue;
		}
		if (state.text[state.pos] === '}') {
			state.pos++;
			return result;
		}
		state.failed = true;
		return undefined;
	}

	state.failed = true;
	return undefined;
}

function readKey(state: ReaderState): string | null {
	const ch = state.text[state.pos];

	if (ch === '"' || ch === "'" || ch === '`') {
		const str = scanStringLiteral(state.text, state.pos);
		if (str === null) return null;
		state.pos = str.end;
		return str.value;
	}

	IDENTIFIER.lastIndex = state.pos;
	const identifier = IDENTIFIER.exec(state.text);
	if (identifier !== null) {
		state.pos += identifier[0].length;
		return identifier[0];
	}

	NUMBER.lastIndex = state.pos;
	const number = NUMBER.exec(state.text);
	if (number !== null) {
		state.pos += number[0].length;
		return String(toNumber(number[0]));
	}

	return null;
}

function readArray(state: ReaderState, depth: number): unknown[] | undefined {
	const result: unknown[] = [];
	state.pos++; // the `[`

	while (state.pos < state.text.length) {
		state.pos = skipTrivia(state.text, state.pos);
		if (state.text[state.pos] === ']') {
			state.pos++;
			return result;
		}

		// An elision — `[1, , 2]` — is a hole, and reads as one.
		if (state.text[state.pos] === ',') {
			result.push(undefined);
			state.pos++;
			continue;
		}

		const value = readValue(state, depth + 1);
		if (state.failed) return undefined;
		result.push(value);

		state.pos = skipTrivia(state.text, state.pos);
		if (state.text[state.pos] === ',') {
			state.pos++;
			continue;
		}
		if (state.text[state.pos] === ']') {
			state.pos++;
			return result;
		}
		state.failed = true;
		return undefined;
	}

	state.failed = true;
	return undefined;
}

/**
 * Read one balanced `{...}` or `[...]` literal at `startIndex`, as plain data.
 *
 * Not JSON, and not parsed as JSON: what appears in a page is JavaScript, so
 * single quotes, backticks, unquoted keys, trailing commas, elisions, hex
 * numbers and `//` and `/* *\/` comments are all accepted. Values that are not
 * literals — functions, variables, expressions — read as `undefined`, and the
 * key they were under is still present, which is the difference between
 * recovering a config and failing on its first callback.
 *
 * Returns `null` for anything that is not a literal at that position, for a
 * literal that never closes, and for one that exceeds the depth or node
 * bounds. Whitespace and comments before the literal are skipped, so
 * `startIndex` may point just after the `:` that introduces it.
 */
export function parseJsObjectLiteral(text: string, startIndex: number): unknown | null {
	if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT) return null;

	const requested = Number.isFinite(startIndex) ? Math.trunc(startIndex) : 0;
	const start = requested < 0 ? 0 : requested;
	if (start >= text.length) return null;

	const state: ReaderState = {
		text,
		pos: skipTrivia(text, start),
		nodes: 0,
		failed: false
	};
	const ch = text[state.pos];
	if (ch !== '{' && ch !== '[') return null;

	const value = readValue(state, 0);
	return state.failed ? null : value;
}

/* -------------------------------------------------------------------------
 * 4. Player source arrays
 * ---------------------------------------------------------------------- */

export interface PlayerSource {
	readonly file: string;
	readonly label?: string;
	readonly type?: string;
}

/**
 * A `sources:` key, quoted or not, that is not the tail of a longer word.
 *
 * The leading group is what a lookbehind would otherwise do, and lookbehind is
 * not available on every engine (`ABI.md` §6). The backreference lets the
 * quote character be either kind or absent while still having to match.
 */
const SOURCES_KEY = /(^|[^A-Za-z0-9_$])(["'`]?)sources\2\s*:\s*\[/g;

/** The keys a config of this family uses for the location of a stream. */
const FILE_KEYS = ['file', 'src', 'url'] as const;

function readStringField(entry: Record<string, unknown>, key: string): string | undefined {
	const value = entry[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Pull the `sources: [ ... ]` array out of a player configuration.
 *
 * Every occurrence is read, in order, and the results are de-duplicated: a
 * page can carry more than one configuration, and picking the first would be a
 * coin flip about which one holds the stream. Entries without a usable
 * location are dropped rather than returned half-built.
 *
 * Returns `[]` for input with no such array, and for one whose array does not
 * parse. Nothing is executed to obtain it.
 */
export function parsePlayerSources(script: string): PlayerSource[] {
	if (typeof script !== 'string' || script.length === 0 || script.length > MAX_INPUT) return [];

	const results: PlayerSource[] = [];
	const seen = new Set<string>();

	SOURCES_KEY.lastIndex = 0;
	let match = SOURCES_KEY.exec(script);
	let configs = 0;
	while (match !== null && results.length < MAX_RESULTS && configs < MAX_PLAYER_CONFIGS) {
		configs++;
		const bracket = match.index + match[0].length - 1;
		const literal = parseJsObjectLiteral(script, bracket);

		if (Array.isArray(literal)) {
			for (const raw of literal) {
				if (results.length >= MAX_RESULTS) break;
				if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
				const entry = raw as Record<string, unknown>;

				let file: string | undefined;
				for (const key of FILE_KEYS) {
					file = readStringField(entry, key);
					if (file !== undefined) break;
				}
				if (file === undefined) continue;

				const label = readStringField(entry, 'label');
				const type = readStringField(entry, 'type');

				// Serialised rather than joined on a separator, so that a label
				// containing the separator cannot collide with another entry.
				const identity = JSON.stringify([file, label ?? null, type ?? null]);
				if (seen.has(identity)) continue;
				seen.add(identity);

				const source: PlayerSource = { file };
				results.push(
					label === undefined && type === undefined
						? source
						: {
								file,
								...(label === undefined ? {} : { label }),
								...(type === undefined ? {} : { type })
							}
				);
			}
		}

		// The regex may have matched a leading delimiter character; resuming at
		// the bracket keeps a second key that begins where this one ended
		// findable, and always advances.
		SOURCES_KEY.lastIndex = Math.max(SOURCES_KEY.lastIndex, bracket + 1);
		match = SOURCES_KEY.exec(script);
	}

	return results;
}

/* -------------------------------------------------------------------------
 * 6. Manifest and media URLs
 * ---------------------------------------------------------------------- */

/**
 * The three container and manifest extensions a player can be handed.
 *
 * A property of the file format, not of anywhere it might be served from.
 */
const MEDIA_EXTENSIONS = ['.m3u8', '.mpd', '.mp4'] as const;

/**
 * A URL run: everything up to the characters that delimit one.
 *
 * Whitespace, both quote kinds, the backtick, angle brackets, a backslash, the
 * closing brackets, and `,` `;` `|` — which is what actually separates two
 * URLs when they are written next to each other in markup or a list. A raw
 * comma inside a query string is the cost; the extension test looks at the
 * path, so a truncated query still classifies correctly.
 */
const URL_RUN = /https:\/\/[^\s"'`<>\\)\]}|,;]+/g;

/** Punctuation that ends an English sentence rather than a URL. */
const TRAILING_NOISE = /[.,;:!?]+$/;

/**
 * Every absolute https URL whose path names a manifest or a media container.
 *
 * De-duplicated, in order of first appearance. Forward slashes escaped for
 * JSON (`\/`) are normalised first, because that is how these URLs arrive more
 * often than not; nothing else about the text is interpreted.
 *
 * Only `https`. A plain-http stream is one the browser will refuse to load
 * from a secure page anyway, so returning it would only produce a candidate
 * that cannot work.
 */
export function findManifestUrls(text: string): string[] {
	if (typeof text !== 'string' || text.length === 0 || text.length > MAX_INPUT) return [];

	const normalised = text.replace(/\\\//g, '/');
	const found: string[] = [];
	const seen = new Set<string>();

	URL_RUN.lastIndex = 0;
	let match = URL_RUN.exec(normalised);
	while (match !== null && found.length < MAX_RESULTS) {
		const url = match[0].replace(TRAILING_NOISE, '');
		const withoutFragment = url.split('#')[0];
		const path = withoutFragment.split('?')[0].toLowerCase();

		let isMedia = false;
		for (const extension of MEDIA_EXTENSIONS) {
			const stem = path.length - extension.length;
			// A file needs a name, not just a suffix: `/.mp4` is a dot-file, and
			// treating it as a stream would hand the player a directory.
			if (stem > 0 && path.slice(stem) === extension && path[stem - 1] !== '/') {
				isMedia = true;
				break;
			}
		}

		if (isMedia && !seen.has(url)) {
			seen.add(url);
			found.push(url);
		}
		match = URL_RUN.exec(normalised);
	}

	return found;
}

/* -------------------------------------------------------------------------
 * 7. Base64
 *
 * `atob`/`btoa` are browser globals and two of the three engines do not have
 * them (`ABI.md` §6), so both directions are arithmetic here. Both are defined
 * over *text*: the string is UTF-8 on the byte side, which is what every
 * producer of these blobs means and what `atob` famously does not do.
 * ---------------------------------------------------------------------- */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

let base64Lookup: Int16Array | null = null;

/** Digit values by character code, with the URL-safe pair folded in. */
function lookupTable(): Int16Array {
	if (base64Lookup === null) {
		const table = new Int16Array(128).fill(-1);
		for (let i = 0; i < BASE64_ALPHABET.length; i++) {
			table[BASE64_ALPHABET.charCodeAt(i)] = i;
		}
		table[0x2d /* - */] = 62;
		table[0x5f /* _ */] = 63;
		base64Lookup = table;
	}
	return base64Lookup;
}

/** UTF-8 bytes for a string. A lone surrogate becomes U+FFFD. */
function utf8Encode(value: string): number[] {
	const bytes: number[] = [];
	let i = 0;
	while (i < value.length) {
		let point = value.codePointAt(i) ?? 0xfffd;
		i += point > 0xffff ? 2 : 1;
		if (point >= 0xd800 && point <= 0xdfff) point = 0xfffd;

		if (point < 0x80) {
			bytes.push(point);
		} else if (point < 0x800) {
			bytes.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
		} else if (point < 0x10000) {
			bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f));
		} else {
			bytes.push(
				0xf0 | (point >> 18),
				0x80 | ((point >> 12) & 0x3f),
				0x80 | ((point >> 6) & 0x3f),
				0x80 | (point & 0x3f)
			);
		}
	}
	return bytes;
}

/** A string from UTF-8 bytes. Anything malformed becomes U+FFFD. */
function utf8Decode(bytes: readonly number[]): string {
	let out = '';
	let units: number[] = [];
	let i = 0;

	while (i < bytes.length) {
		const lead = bytes[i];
		let point = 0xfffd;
		let extra = -1;

		if (lead < 0x80) {
			point = lead;
			extra = 0;
		} else if ((lead & 0xe0) === 0xc0) {
			point = lead & 0x1f;
			extra = 1;
		} else if ((lead & 0xf0) === 0xe0) {
			point = lead & 0x0f;
			extra = 2;
		} else if ((lead & 0xf8) === 0xf0) {
			point = lead & 0x07;
			extra = 3;
		}

		if (extra < 0) {
			point = 0xfffd;
			i++;
		} else {
			let complete = true;
			for (let k = 1; k <= extra; k++) {
				const continuation = bytes[i + k];
				if (continuation === undefined || (continuation & 0xc0) !== 0x80) {
					complete = false;
					break;
				}
				point = (point << 6) | (continuation & 0x3f);
			}
			if (!complete) {
				point = 0xfffd;
				i++;
			} else {
				i += extra + 1;
				if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) point = 0xfffd;
			}
		}

		if (point > 0xffff) {
			const offset = point - 0x10000;
			units.push(0xd800 | (offset >> 10), 0xdc00 | (offset & 0x3ff));
		} else {
			units.push(point);
		}

		// Chunked so the spread never approaches an argument-count limit.
		if (units.length >= 4096) {
			out += String.fromCharCode(...units);
			units = [];
		}
	}

	if (units.length > 0) out += String.fromCharCode(...units);
	return out;
}

/**
 * Decode base64 text to the string it encodes, as UTF-8.
 *
 * Whitespace is ignored and the URL-safe alphabet is accepted, because both
 * turn up in blobs that were transported through markup. Padding ends the
 * data. A character outside both alphabets means the input is not base64, and
 * the answer is `''` rather than a plausible-looking prefix of a wrong string.
 */
export function base64Decode(value: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT) return '';

	const table = lookupTable();
	const bytes: number[] = [];
	let accumulator = 0;
	let bits = 0;

	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code === 0x3d /* = */) break;
		if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;

		const digit = code < 128 ? table[code] : -1;
		if (digit < 0) return '';

		accumulator = (accumulator << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes.push((accumulator >> bits) & 0xff);
		}
	}

	return utf8Decode(bytes);
}

/** Encode a string as base64, over its UTF-8 bytes. Padded, standard alphabet. */
export function base64Encode(value: string): string {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_INPUT) return '';

	const bytes = utf8Encode(value);
	const parts: string[] = [];

	for (let i = 0; i < bytes.length; i += 3) {
		const hasSecond = i + 1 < bytes.length;
		const hasThird = i + 2 < bytes.length;
		const b0 = bytes[i];
		const b1 = hasSecond ? bytes[i + 1] : 0;
		const b2 = hasThird ? bytes[i + 2] : 0;

		parts.push(
			BASE64_ALPHABET[b0 >> 2] +
				BASE64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)] +
				(hasSecond ? BASE64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=') +
				(hasThird ? BASE64_ALPHABET[b2 & 0x3f] : '=')
		);
	}

	return parts.join('');
}
