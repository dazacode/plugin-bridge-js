/**
 * The build file that says what a listing in the Kotlin manga ecosystem *is*.
 *
 * ## Why an adapter reads a build file at all
 *
 * Every listing in this catalogue — all 1,396 of them — declares an
 * **abstract** class, annotated for a build-time code generator. The class that
 * can actually be instantiated does not exist in the source tree: the generator
 * synthesises it, and takes its inputs from a declarative block in the module's
 * build file.
 *
 * So a translator that reads only the Kotlin produces an abstract class and
 * fails every single listing, with one message that looks like one bug and is
 * really the absence of a build step. This file is the missing step, and
 * `mihon.ts` is what turns what it reads into a concrete subclass.
 *
 * ## It is a reader, not an evaluator
 *
 * The file is Kotlin and is in principle a program. It is read as **data**,
 * with a brace-aware scanner over a vocabulary of ten keys and four calls,
 * because every one of the 1,396 stays inside that vocabulary.
 *
 * The discipline is `FOREIGN.md` §4.4's, and for the same reason: a value that
 * stops being a literal **stops being read**, and the key is reported absent
 * rather than guessed at. Building the module to find out what it declares
 * would make a bundle's digest a fact about the machine that converted it.
 *
 * ## `dependencies` is read too, and it is the honest part
 *
 * A module declares the shared library modules it uses. Several of those —
 * archive-delivered chapters, tile-scrambled pages, text rendered to an image —
 * are byte-level operations `ABI.md` §8.4 does not yet have a vocabulary for.
 * Reading the declaration is how a conversion **refuses by name and is
 * counted**, instead of converting cleanly and producing a reader full of
 * scrambled pages.
 */

/** How a listing's base URL is decided. */
export type MihonBaseUrl =
	| { readonly kind: 'static'; readonly url: string }
	/** Several, the first being the default. The host draws a picker. */
	| { readonly kind: 'mirrors'; readonly urls: readonly string[] }
	/** The viewer supplies it. `url` is the default, when one was declared. */
	| { readonly kind: 'custom'; readonly url: string | null };

/** One source the generator will emit. A module may declare several. */
export interface MihonSourceDecl {
	readonly lang: string;
	/** Present only when this source overrides the module's name. */
	readonly name: string | null;
	/**
	 * The source's own id, when pinned.
	 *
	 * `bigint` because it is an `int64` and the real values exceed
	 * `Number.MAX_SAFE_INTEGER` — see `protobuf.ts`'s header for what rounding
	 * one costs. Null means the generator derives it, which it does from the
	 * name, language and version.
	 */
	readonly id: bigint | null;
	readonly versionId: number | null;
	readonly baseUrl: MihonBaseUrl | null;
}

export type MihonContentWarning = 'safe' | 'mixed' | 'nsfw' | 'unspecified';

export interface MihonBuildFile {
	readonly name: string | null;
	readonly versionCode: number | null;
	readonly versionName: string | null;
	readonly libVersion: string | null;
	readonly contentWarning: MihonContentWarning;
	/** The shared template this listing instantiates, when it does. */
	readonly theme: string | null;
	readonly pkgName: string | null;
	readonly sources: readonly MihonSourceDecl[];
	/** Shared library modules, by bare name: `randomua`, `speedbinb`, … */
	readonly libModules: readonly string[];
}

/**
 * Comments removed, so a commented-out declaration is not read as one.
 *
 * Done by scanning rather than by regex because a `//` inside a string literal
 * is a URL, and every base URL in this catalogue contains one.
 */
function stripComments(source: string): string {
	let out = '';
	let at = 0;
	while (at < source.length) {
		const char = source[at];
		if (char === '"') {
			const start = at;
			at += 1;
			while (at < source.length && source[at] !== '"') {
				if (source[at] === '\\') at += 1;
				at += 1;
			}
			at += 1;
			out += source.slice(start, at);
			continue;
		}
		if (char === '/' && source[at + 1] === '/') {
			while (at < source.length && source[at] !== '\n') at += 1;
			continue;
		}
		if (char === '/' && source[at + 1] === '*') {
			at += 2;
			while (at < source.length && !(source[at] === '*' && source[at + 1] === '/')) at += 1;
			at += 2;
			continue;
		}
		out += char;
		at += 1;
	}
	return out;
}

/**
 * The body of `name { … }`, brace-matched, or null.
 *
 * `from` lets a caller walk repeated blocks — `source { }` appears up to five
 * times in one file — without the scanner needing to know that.
 */
function block(source: string, name: string, from = 0): { body: string; end: number } | null {
	const pattern = new RegExp(`(^|[^A-Za-z0-9_.])${name}\\s*\\{`, 'g');
	pattern.lastIndex = from;
	const match = pattern.exec(source);
	if (match === null) return null;

	let depth = 1;
	let at = match.index + match[0].length;
	const start = at;
	while (at < source.length && depth > 0) {
		const char = source[at];
		if (char === '"') {
			at += 1;
			while (at < source.length && source[at] !== '"') {
				if (source[at] === '\\') at += 1;
				at += 1;
			}
		} else if (char === '{') depth += 1;
		else if (char === '}') depth -= 1;
		at += 1;
	}
	if (depth !== 0) return null;
	return { body: source.slice(start, at - 1), end: at };
}

/** The nested blocks removed, so a key reads only at this level. */
function shallow(body: string): string {
	let out = '';
	let depth = 0;
	for (const char of body) {
		if (char === '{') depth += 1;
		else if (char === '}') depth -= 1;
		else if (depth === 0) out += char;
	}
	return out;
}

/** `key = "value"`, and only when it really is a literal. */
function stringOf(body: string, key: string): string | null {
	const match = new RegExp(`(^|[^A-Za-z0-9_.])${key}\\s*=\\s*"([^"]*)"`).exec(body);
	return match === null ? null : match[2];
}

/** `key = 123`. A value assembled from anything else is not read. */
function numberOf(body: string, key: string): number | null {
	const match = new RegExp(`(^|[^A-Za-z0-9_.])${key}\\s*=\\s*(-?\\d+)\\b`).exec(body);
	if (match === null) return null;
	const value = Number(match[2]);
	return Number.isSafeInteger(value) ? value : null;
}

/** The same, kept exact. Source ids do not fit in a `number`. */
function bigintOf(body: string, key: string): bigint | null {
	const match = new RegExp(`(^|[^A-Za-z0-9_.])${key}\\s*=\\s*(-?\\d+)\\b`).exec(body);
	return match === null ? null : BigInt(match[2]);
}

/** Every string literal passed to `call(…)`, in order. */
function callArguments(body: string, call: string): readonly string[] {
	const match = new RegExp(`(^|[^A-Za-z0-9_.])${call}\\s*\\(([^)]*)\\)`).exec(body);
	if (match === null) return [];
	return Array.from(match[2].matchAll(/"([^"]*)"/g), (found) => found[1]);
}

function readBaseUrl(sourceBody: string): MihonBaseUrl | null {
	// `baseUrl = "…"` — the common case, and the only one a concrete class may use.
	const flat = stringOf(shallow(sourceBody), 'baseUrl');
	if (flat !== null) return { kind: 'static', url: flat };

	const nested = block(sourceBody, 'baseUrl');
	if (nested === null) return null;

	const mirrors = callArguments(nested.body, 'mirrors');
	if (mirrors.length > 0) return { kind: 'mirrors', urls: mirrors };

	// `custom(…)` — the viewer supplies the URL. It may carry a default, and a
	// bare `custom()` means there is none: the source cannot be reached until
	// somebody types one, which is a fact the host has to be able to state.
	if (/(^|[^A-Za-z0-9_.])custom\s*\(/.test(nested.body)) {
		const supplied = callArguments(nested.body, 'custom');
		return { kind: 'custom', url: supplied[0] ?? null };
	}

	const host = callArguments(nested.body, 'host');
	if (host.length > 0) return { kind: 'static', url: host[0] };
	return null;
}

const WARNINGS: Readonly<Record<string, MihonContentWarning>> = {
	SAFE: 'safe',
	MIXED: 'mixed',
	NSFW: 'nsfw',
	UNSPECIFIED: 'unspecified'
};

/**
 * `val someUrl = "https://…"` resolved, so `baseUrl = someUrl` still reads.
 *
 * A named literal is still a literal. Several modules hoist a URL they use for
 * more than one source, and refusing those would be refusing a declaration this
 * reader can see in full, two lines above the use — which is the opposite of
 * the rule in `expandSourceLoops`. That rule refuses what it **cannot** see.
 *
 * Only a `val` bound directly to a string literal is resolved. A `val` computed
 * from anything else — a concatenation, an interpolation, another call — is
 * left alone, and the key that reads it is reported absent.
 *
 * Substitution skips string bodies, so a base URL that happens to contain a
 * declared name is untouched.
 */
function resolveLocalVals(body: string): string {
	const bound = new Map<string, string>();
	for (const found of body.matchAll(
		/\bval\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g
	)) {
		bound.set(found[1], found[2]);
	}
	if (bound.size === 0) return body;

	let out = '';
	let at = 0;
	while (at < body.length) {
		const char = body[at];
		if (char === '"') {
			const start = at;
			at += 1;
			while (at < body.length && body[at] !== '"') {
				if (body[at] === '\\') at += 1;
				at += 1;
			}
			at += 1;
			out += body.slice(start, at);
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(at));
		if (word === null) {
			out += char;
			at += 1;
			continue;
		}
		const name = word[0];
		const value = bound.get(name);
		const isDeclaration = /\bval\s+$/.test(out);
		const isMember = out.endsWith('.');
		out += value !== undefined && !isDeclaration && !isMember ? `"${value}"` : name;
		at += name.length;
	}
	return out;
}

/**
 * `val languages = listOf(…)` inlined at its `languages.forEach` use site.
 *
 * All seven of the modules that were still unread after the loop expander
 * landed name their list before iterating it, which is the same "a named
 * literal is still a literal" argument `resolveLocalVals` makes — and together
 * they are 226 of the catalogue's 2,371 sources, because one of them declares a
 * hundred and eight.
 *
 * Done as a rewrite rather than as a second code path in `expandSourceLoops`,
 * so there is exactly one implementation of what a loop means. A name bound to
 * anything but a literal list is not rewritten and its loop stays unread.
 */
function inlineBoundLists(body: string): string {
	const bound = new Map<string, string>();
	const pattern = /\bval\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(listOf|mapOf)\s*\(/g;
	for (const found of body.matchAll(pattern)) {
		const open = found.index + found[0].length - 1;
		const closed = balanced(body, open);
		if (closed === null) continue;
		bound.set(found[1], `${found[2]}${body.slice(open, closed.end)}`);
	}
	if (bound.size === 0) return body;

	let out = body;
	for (const [name, call] of bound) {
		out = out.replace(
			new RegExp(`(^|[^A-Za-z0-9_.])${name}\\s*\\.forEach`, 'g'),
			`$1${call}.forEach`
		);
	}
	return out;
}

/**
 * `listOf("en", "ja").forEach { source { lang = it … } }`, expanded.
 *
 * Seventy modules declare their sources this way rather than repeating a block,
 * and one of them declares a hundred and eight. Left unexpanded they are
 * modules that appear to declare no source at all — indistinguishable from a
 * module this reader failed on, and together they are 226 of the catalogue's
 * 2,371 sources.
 *
 * **This is reading, not evaluating, and the distinction is the list.** Every
 * element of every one of these lists is a literal — a string, or a `"lang" to
 * 123L` pair of them — so the loop is a literal repeated, and expanding it
 * invents nothing. The moment an element stops being a literal, or the binding
 * does not match the element's arity, the loop is **left alone** and the
 * sources it would have declared are simply absent: `FOREIGN.md` §4.4's rule,
 * applied to a build file.
 *
 * The pair form matters more than its seven modules suggest, because the second
 * half is usually a **pinned source id**. Dropping those modules would be one
 * failure; expanding them while guessing which half is the id would be a worse
 * one, since an id that is wrong is a `SourceBinding` pointing at a different
 * source (rule 1). The binding names them, so neither is necessary.
 */
function expandSourceLoops(body: string): string {
	let out = '';
	let at = 0;
	for (;;) {
		const start = findReceiver(body, at);
		if (start === null) break;

		const args = balanced(body, start.open);
		if (args === null) break;

		const tail = /^\s*\.forEach\s*\{/.exec(body.slice(args.end));
		if (tail === null) {
			out += body.slice(at, args.end);
			at = args.end;
			continue;
		}

		const lambdaStart = args.end + tail[0].length;
		const lambda = braced(body, lambdaStart);
		if (lambda === null) break;

		const elements = readElements(body.slice(start.open + 1, args.end - 1));
		const binding = readBinding(lambda.body);

		// Not literal, or the binding does not match what the list holds: left
		// exactly as it was, and counted as unread by the caller.
		if (elements === null || binding === null || binding.names.length !== elements[0].length) {
			out += body.slice(at, lambda.end);
			at = lambda.end;
			continue;
		}

		out += body.slice(at, start.begin);
		for (const element of elements) {
			out += substitute(binding.rest, binding.names, element) + '\n';
		}
		at = lambda.end;
	}
	return out + body.slice(at);
}

/** The next `listOf(` or `mapOf(` at or after `from`. */
function findReceiver(body: string, from: number): { begin: number; open: number } | null {
	const pattern = /(^|[^A-Za-z0-9_.])(listOf|mapOf)\s*\(/g;
	pattern.lastIndex = from;
	const match = pattern.exec(body);
	if (match === null) return null;
	return { begin: match.index + match[1].length, open: match.index + match[0].length - 1 };
}

/** Scans to the `)` that closes the `(` at `open`, ignoring string bodies. */
function balanced(body: string, open: number): { end: number } | null {
	let depth = 1;
	let at = open + 1;
	while (at < body.length && depth > 0) {
		const char = body[at];
		if (char === '"') {
			at += 1;
			while (at < body.length && body[at] !== '"') {
				if (body[at] === '\\') at += 1;
				at += 1;
			}
		} else if (char === '(') depth += 1;
		else if (char === ')') depth -= 1;
		at += 1;
	}
	return depth === 0 ? { end: at } : null;
}

/** The body of the `{` at `open`, and where it ends. */
function braced(body: string, open: number): { body: string; end: number } | null {
	let depth = 1;
	let at = open;
	while (at < body.length && depth > 0) {
		const char = body[at];
		if (char === '"') {
			at += 1;
			while (at < body.length && body[at] !== '"') {
				if (body[at] === '\\') at += 1;
				at += 1;
			}
		} else if (char === '{') depth += 1;
		else if (char === '}') depth -= 1;
		at += 1;
	}
	return depth === 0 ? { body: body.slice(open, at - 1), end: at } : null;
}

/** One literal: a quoted string, or an integer with Kotlin's optional `L`. */
const LITERAL = /^\s*(?:"((?:[^"\\]|\\.)*)"|(-?\d+)[Ll]?)\s*$/;

/**
 * The list's elements, each as a tuple of literals, or null if any is not one.
 *
 * A bare literal is a one-tuple and `"a" to 1L` is a two-tuple, so the caller
 * compares arity against the binding rather than against a shape flag.
 */
function readElements(args: string): string[][] | null {
	const parts = splitTop(args);
	if (parts.length === 0) return null;
	const out: string[][] = [];
	for (const part of parts) {
		const halves = part.split(/\s+to\s+/);
		if (halves.length > 2) return null;
		const tuple: string[] = [];
		for (const half of halves) {
			const found = LITERAL.exec(half);
			if (found === null) return null;
			tuple.push(found[1] ?? found[2]);
		}
		out.push(tuple);
	}
	// A ragged list is not a list this reader understands.
	return out.every((tuple) => tuple.length === out[0].length) ? out : null;
}

/** Split on top-level commas, so a nested call cannot end an element early. */
function splitTop(args: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	let at = 0;
	while (at < args.length) {
		const char = args[at];
		if (char === '"') {
			const from = at;
			at += 1;
			while (at < args.length && args[at] !== '"') {
				if (args[at] === '\\') at += 1;
				at += 1;
			}
			at += 1;
			current += args.slice(from, at);
			continue;
		}
		if (char === '(' || char === '[') depth += 1;
		else if (char === ')' || char === ']') depth -= 1;
		if (char === ',' && depth === 0) {
			if (current.trim() !== '') parts.push(current);
			current = '';
		} else current += char;
		at += 1;
	}
	if (current.trim() !== '') parts.push(current);
	return parts;
}

/** The lambda's parameter names, and the body after them. */
function readBinding(lambda: string): { names: string[]; rest: string } | null {
	const destructured =
		/^\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*->/.exec(lambda);
	if (destructured !== null) {
		return {
			names: [destructured[1], destructured[2]],
			rest: lambda.slice(destructured[0].length)
		};
	}
	const named = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*->/.exec(lambda);
	if (named !== null) return { names: [named[1]], rest: lambda.slice(named[0].length) };
	// No arrow: Kotlin's implicit single parameter.
	return /->/.test(lambda.split('\n')[0]) ? null : { names: ['it'], rest: lambda };
}

/**
 * The bindings replaced by their values, inside string literals as well as out.
 *
 * Interpolation has to be handled because several of these build a URL from the
 * bound value — `"https://$sub.example.invalid"`. Only a bound name is
 * substituted; `${'$'}` and any other expression is left, which leaves a string
 * that is no longer a literal and a key that therefore does not read.
 */
function substitute(lambda: string, names: readonly string[], values: readonly string[]): string {
	let out = '';
	let at = 0;
	while (at < lambda.length) {
		const char = lambda[at];
		if (char === '"') {
			const from = at;
			at += 1;
			while (at < lambda.length && lambda[at] !== '"') {
				if (lambda[at] === '\\') at += 1;
				at += 1;
			}
			at += 1;
			let text = lambda.slice(from, at);
			names.forEach((name, index) => {
				text = text
					.replaceAll(`\${${name}}`, values[index])
					.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, 'g'), values[index]);
			});
			out += text;
			continue;
		}
		const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(lambda.slice(at));
		if (word === null) {
			out += char;
			at += 1;
			continue;
		}
		const index = names.indexOf(word[0]);
		const isMember = out.endsWith('.');
		out += index === -1 || isMember ? word[0] : quoteFor(values[index]);
		at += word[0].length;
	}
	return out;
}

/** A value goes back in the shape the key that reads it expects. */
function quoteFor(value: string): string {
	return /^-?\d+$/.test(value) ? value : `"${value}"`;
}

/**
 * Read one `build.gradle.kts`.
 *
 * Never throws. A file this cannot read yields a record whose fields are null,
 * and the caller refuses the listing naming what was missing — which is a
 * better failure than a parser exception that names a byte offset.
 */
export function readMihonBuildFile(text: string): MihonBuildFile {
	const source = stripComments(text);
	const root = block(source, 'keiyoushi');
	const body = expandSourceLoops(inlineBoundLists(resolveLocalVals(root?.body ?? '')));
	const top = shallow(body);

	const sources: MihonSourceDecl[] = [];
	let at = 0;
	for (;;) {
		const found = block(body, 'source', at);
		if (found === null) break;
		at = found.end;
		const inner = shallow(found.body);
		const lang = stringOf(inner, 'lang');
		if (lang === null) continue; // a source with no language is not a source
		sources.push({
			lang,
			name: stringOf(inner, 'name'),
			id: bigintOf(inner, 'id'),
			versionId: numberOf(inner, 'versionId'),
			baseUrl: readBaseUrl(found.body)
		});
	}

	const warning = /contentWarning\s*=\s*(?:ContentWarning\.)?([A-Z_]+)/.exec(top);

	const libModules = Array.from(
		source.matchAll(/project\(\s*"[:\w]*:lib:([A-Za-z0-9_-]+)"\s*\)/g),
		(found) => found[1]
	);

	return {
		name: stringOf(top, 'name'),
		versionCode: numberOf(top, 'versionCode'),
		versionName: stringOf(top, 'versionName'),
		libVersion: stringOf(top, 'libVersion'),
		contentWarning: (warning && WARNINGS[warning[1]]) ?? 'unspecified',
		theme: stringOf(top, 'theme'),
		pkgName: stringOf(top, 'pkgName'),
		sources,
		libModules: [...new Set(libModules)]
	};
}
