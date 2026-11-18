/**
 * Suwatte sources, as a converted plugin.
 *
 * ## What one of these is
 *
 * The opposite of the Paperback shim's job. Where that one receives a bundle
 * and supplies a global, this one receives *modules* in TypeScript and has to
 * remove the TypeScript before the engine will parse them: the `use httpclient`
 * directive, the toolchain import, the `Runner`/`HttpClient` classes and the
 * `ObjectStore` globals are all the app's, and all have to be supplied here.
 *
 * ## Why stripping rather than compiling
 *
 * A compiler is a dependency and a version to keep. The corpus uses a narrow
 * slice — annotations, `implements`, `as`, `import type`, `interface`, `type`
 * aliases and `declare` — and each has a mechanical removal. What the stripper
 * does *not* understand it leaves alone, so a construct it cannot read becomes
 * a parse failure naming the line rather than a quietly different program. The
 * one deliberate approximation is that `enum` is not supported (the corpus gets
 * its enums from the toolchain), and it is left in place to fail loudly.
 *
 * ## Modules
 *
 * There is no module system in the sandbox, so the source's own imports are
 * rewritten onto a registry that is part of this bundle, and the two bare
 * packages the corpus imports (`cheerio` and `@suwatte/toolchain`) are answered
 * from here. Anything else the source imports throws by its own name.
 *
 * ## What is supplied and what is refused
 *
 * Settings views, the search-filter builders, `HttpClient` with both
 * interceptor directions, `ObjectStore`/`SecureStore` and the native `Crypto`
 * façade are implemented because measured sources call them. A WebView-backed
 * settings view is *mapped at conversion* rather than here; `executeInWebView`
 * is not part of this ecosystem and is absent.
 *
 * ## Form values
 *
 * Suwatte sources read preferences themselves through `ObjectStore`, keyed by
 * their own constants, while the host stores one value per manifest id. The
 * adapter decided both halves at conversion and they travel in `__SETTINGS`;
 * every ABI call plants the viewer's answers under the source's own keys
 * before the source runs, so its own accessors find them.
 */

import { BOOT_CONTEXT } from './boot-context';
import { DIGESTS } from './digests';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { JS_RUNTIME } from './js-runtime';

export interface SuwatteModule {
	readonly url: string;
	readonly source: string;
}

export interface SuwatteEntrypointOptions {
	readonly pluginId: string;
	readonly entryUrl: string;
	readonly modules: readonly SuwatteModule[];
	readonly settings?: readonly {
		readonly id: string;
		readonly key: string;
		readonly type: string;
	}[];
	/**
	 * A built `.stt`, carried verbatim in place of `modules`. It declares
	 * `SourcePackage` at its top level, and its `bootstrap()` answers the
	 * source instance.
	 */
	readonly bundle?: string;
}

/* ── the TypeScript stripper ─────────────────────────────────────────────── */

const WORD = /[A-Za-z0-9_$]/;
const MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'override', 'abstract']);

function isWord(char: string): boolean {
	return WORD.test(char);
}

/** The next non-space, non-comment character index, or the length. */
function significant(source: string, from: number): number {
	let i = from;
	while (i < source.length) {
		const char = source.charAt(i);
		if (/\s/.test(char)) {
			i += 1;
			continue;
		}
		if (char === '/' && source.charAt(i + 1) === '/') {
			const end = source.indexOf('\n', i);
			i = end < 0 ? source.length : end;
			continue;
		}
		if (char === '/' && source.charAt(i + 1) === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		break;
	}
	return i;
}

function readWord(source: string, from: number): string {
	let i = from;
	while (i < source.length && isWord(source.charAt(i))) i += 1;
	return source.slice(from, i);
}

/** Tokens after which a slash begins an expression rather than a division. */
const REGEX_PREFIX =
	/^(?:|return|typeof|instanceof|in|of|new|case|delete|void|yield|await|=>|[(,=:[!&|?{;])$/;

/** The end of a regex literal, including its flags. */
function skipRegex(source: string, from: number): number {
	let i = from + 1;
	let inClass = false;
	while (i < source.length) {
		const char = source.charAt(i);
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (char === '[') inClass = true;
		else if (char === ']') inClass = false;
		else if (char === '/' && !inClass) {
			i += 1;
			while (/[a-z]/i.test(source.charAt(i))) i += 1;
			return i;
		}
		i += 1;
	}
	return i;
}

/** The end of a string or template literal starting at `from`. */
function skipString(source: string, from: number): number {
	const quote = source.charAt(from);
	let i = from + 1;
	while (i < source.length) {
		const char = source.charAt(i);
		if (char === '\\') {
			i += 2;
			continue;
		}
		if (char === quote) return i + 1;
		i += 1;
	}
	return i;
}

/**
 * Where a type expression ends, scanning from its first character.
 *
 * Balanced brackets are consumed so an object or function type survives as a
 * whole; at depth zero a declaration terminator ends it. A newline ends a type
 * only when the next significant token does not continue one, which is what
 * lets `string |\n null` work without swallowing the statement after it.
 */
function skipType(source: string, from: number): number {
	let i = from;
	let depth = 0;
	let prev = '';
	const functionType = source.charAt(significant(source, from)) === '(';
	while (i < source.length) {
		const char = source.charAt(i);
		if (char === '"' || char === "'" || char === '`') {
			i = skipString(source, i);
			prev = 'string';
			continue;
		}
		if (char === '=' && source.charAt(i + 1) === '>') {
			if (!functionType) return i;
			i += 2;
			prev = '>';
			continue;
		}
		const beginsType = prev === '' || ['|', '&', '<', ',', '(', '[', ':', '='].includes(prev);
		if ((char === '{' || char === '(') && depth === 0 && !beginsType) return i;
		if (char === '(' || char === '[' || char === '{' || char === '<') {
			depth += 1;
			i += 1;
			prev = char;
			continue;
		}
		if (char === ')' || char === ']' || char === '}' || char === '>') {
			if (depth === 0) return i;
			depth -= 1;
			i += 1;
			prev = char;
			continue;
		}
		if (depth === 0) {
			if (char === '>' && source.charAt(i + 1) === '=') return i - (char === '>' ? 0 : 0);
			if (char === ',' || char === ';' || char === '=') return i;
			if (char === '>' && i > from && source.charAt(i - 1) === '=') return i - 1;
			if (char === '\n') {
				const next = significant(source, i);
				const follows = source.charAt(next);
				if (!['|', '&', '.', '<', '['].includes(follows)) return i;
			}
		}
		if (!/\s/.test(char)) prev = char;
		i += 1;
	}
	return i;
}

function skipBalanced(source: string, from: number, open: string, close: string): number {
	let i = from;
	let depth = 0;
	while (i < source.length) {
		const char = source.charAt(i);
		if (char === '"' || char === "'" || char === '`') {
			i = skipString(source, i);
			continue;
		}
		if (char === '/' && source.charAt(i + 1) === '/') {
			const end = source.indexOf('\n', i);
			i = end < 0 ? source.length : end;
			continue;
		}
		if (char === '/' && source.charAt(i + 1) === '*') {
			const end = source.indexOf('*/', i + 2);
			i = end < 0 ? source.length : end + 2;
			continue;
		}
		if (char === open) depth += 1;
		if (char === close) {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
		i += 1;
	}
	return i;
}

/** `import` statement processing: type imports go and type specifiers are cut. */
function processImport(statement: string): string {
	if (/^import\s+type\b/.test(statement)) return '';
	return statement.replace(/\{[\s\S]*?\}/g, (whole, _b: string) => {
		const body = whole
			.slice(1, -1)
			.replace(/\/\/[^\n]*/g, ' ')
			.replace(/\/\*[\s\S]*?\*\//g, ' ');
		const kept = body
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0 && !/^type\s/.test(part));
		return `{ ${kept.join(', ')} }`;
	});
}

/**
 * The source with TypeScript-only syntax removed.
 *
 * Deterministic and quote-aware: a `:` inside a string or a `?` inside a
 * template is never a type marker. The scanner returns the text unchanged when
 * it meets something it cannot classify.
 */
export function stripTypescript(source: string): string {
	let out = '';
	let i = 0;
	let last = '';
	let lastWord = '';
	let lastParenParams = false;
	const braces: ('class' | 'other')[] = [];
	const parens: boolean[] = [];
	let pendingClass = false;
	let pendingAnnotation = false;
	let statementStart = true;
	let afterVar = 0;
	let atMember = false;

	const classMember = (): boolean =>
		braces.length > 0 &&
		braces[braces.length - 1] === 'class' &&
		parens.length === 0 &&
		statementStart;

	while (i < source.length) {
		const char = source.charAt(i);

		if (char === '/' && source.charAt(i + 1) === '/') {
			const end = source.indexOf('\n', i);
			const stop = end < 0 ? source.length : end;
			out += source.slice(i, stop);
			i = stop;
			continue;
		}

		if (char === '/' && source.charAt(i + 1) === '*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end < 0 ? source.length : end + 2;
			out += source.slice(i, stop);
			i = stop;
			continue;
		}

		if (char === '`') {
			// A template's interpolations are code, and may hold an annotation.
			out += char;
			i += 1;
			while (i < source.length) {
				const inner = source.charAt(i);
				if (inner === '\\') {
					out += source.slice(i, i + 2);
					i += 2;
					continue;
				}
				if (inner === '`') {
					out += inner;
					i += 1;
					break;
				}
				if (inner === '$' && source.charAt(i + 1) === '{') {
					out += '${';
					const end = skipBalanced(source, i + 1, '{', '}');
					out += stripTypescript(source.slice(i + 2, end - 1));
					out += '}';
					i = end;
					continue;
				}
				out += inner;
				i += 1;
			}
			last = 'string';
			statementStart = false;
			if (afterVar > 0) afterVar -= 1;
			continue;
		}

		if (char === '"' || char === "'") {
			const end = skipString(source, i);
			out += source.slice(i, end);
			i = end;
			last = 'string';
			statementStart = false;
			if (afterVar > 0) afterVar -= 1;
			continue;
		}

		if (char === '/' && REGEX_PREFIX.test(last)) {
			const end = skipRegex(source, i);
			out += source.slice(i, end);
			i = end;
			last = 'regex';
			statementStart = false;
			continue;
		}

		if (isWord(char)) {
			const word = readWord(source, i);

			if (word === 'import') {
				let j = i;
				let depth = 0;
				while (j < source.length) {
					const inner = source.charAt(j);
					if (inner === '"' || inner === "'") {
						j = skipString(source, j);
						continue;
					}
					if (inner === '{') depth += 1;
					if (inner === '}') depth -= 1;
					if (inner === ';' && depth === 0) {
						j += 1;
						break;
					}
					if (inner === '\n' && depth === 0) break;
					j += 1;
				}
				out += processImport(source.slice(i, j));
				i = j;
				last = 'import';
				statementStart = true;
				continue;
			}

			if (word === 'export') {
				const next = significant(source, i + word.length);
				const nextWord = readWord(source, next);
				if (nextWord === 'interface') {
					i = skipInterface(source, next);
					statementStart = true;
					continue;
				}
				if (nextWord === 'type') {
					i = skipAliasOrList(source, next);
					statementStart = true;
					continue;
				}
				out += word;
				i += word.length;
				last = word;
				statementStart = false;
				continue;
			}

			if (word === 'interface') {
				i = skipInterface(source, i);
				statementStart = true;
				continue;
			}

			if (word === 'type' && statementStart) {
				const next = significant(source, i + word.length);
				const candidate = readWord(source, next);
				const after = significant(source, next + candidate.length);
				if (candidate.length > 0 && source.charAt(after) === '=') {
					i = skipAliasOrList(source, i);
					statementStart = true;
					continue;
				}
			}

			if (word === 'declare') {
				i = skipDeclaration(source, i);
				statementStart = true;
				continue;
			}

			if (word === 'implements') {
				let j = i + word.length;
				while (j < source.length && source.charAt(j) !== '{') j += 1;
				i = j;
				last = 'implements';
				statementStart = false;
				continue;
			}

			if (word === 'as' || word === 'satisfies') {
				i = skipType(source, significant(source, i + word.length));
				last = 'type';
				statementStart = false;
				continue;
			}

			const nextOfWord = significant(source, i + word.length);
			if (MODIFIERS.has(word) && ![':', ',', ')', '.', '='].includes(source.charAt(nextOfWord))) {
				i = nextOfWord;
				continue;
			}

			if (classMember()) atMember = true;
			if (word === 'class') pendingClass = true;
			out += word;
			i += word.length;
			last = word;
			lastWord = word;
			statementStart = false;
			if (afterVar > 0) afterVar -= 1;
			if (word === 'const' || word === 'let' || word === 'var') afterVar = 2;
			continue;
		}

		if (char === '{') {
			out += char;
			atMember = false;
			braces.push(pendingClass ? 'class' : 'other');
			pendingClass = false;
			i += 1;
			last = '{';
			statementStart = true;
			continue;
		}

		if (char === '}') {
			out += char;
			atMember = false;
			braces.pop();
			i += 1;
			last = '}';
			statementStart = true;
			continue;
		}

		if (char === '(') {
			const close = skipBalanced(source, i, '(', ')');
			const after = significant(source, close);
			let before = i - 1;
			while (before >= 0 && /\s/.test(source.charAt(before))) before -= 1;
			const arrowAhead =
				source.slice(after, after + 2) === '=>' ||
				(source.charAt(after) === ':' && /^\s*:[^;{\n]*=>/.test(source.slice(after, after + 200)));
			const params =
				arrowAhead ||
				atMember ||
				classMember() ||
				/(?:^|[^\w$])(?:async\s+)?function\s+[\w$]*\s*$/.test(source.slice(0, i)) ||
				(source.charAt(before) === '>' && source.charAt(before - 1) !== '=');
			atMember = false;
			parens.push(params);
			out += char;
			i += 1;
			last = '(';
			statementStart = false;
			continue;
		}

		if (char === ')') {
			lastParenParams = parens.pop() === true;
			out += char;
			i += 1;
			last = ')';
			statementStart = false;
			continue;
		}

		if (char === ':' && !pendingAnnotation) {
			const annotation =
				parens[parens.length - 1] === true ||
				(last === ')' && lastParenParams) ||
				afterVar > 0 ||
				atMember ||
				last === '?';
			if (annotation) {
				pendingAnnotation = true;
				i = skipType(source, i + 1);
				pendingAnnotation = false;
				atMember = false;
				last = 'type';
				statementStart = false;
				continue;
			}
		}

		if (char === '<' && lastWord.length > 0 && i > 0 && isWord(source.charAt(i - 1))) {
			// A generic parameter list: only when what follows '>' starts a body
			// or parameter list, so \`a < b\` is never mistaken for one.
			const close = skipBalanced(source, i, '<', '>');
			const after = significant(source, close);
			if (['(', '{'].includes(source.charAt(after))) {
				i = close;
				last = '>';
				statementStart = false;
				continue;
			}
		}

		if (char === '!' && lastWord.length > 0) {
			const next = significant(source, i + 1);
			if (
				next >= source.length ||
				[
					'.',
					'(',
					')',
					',',
					';',
					'=',
					'[',
					'?',
					'}',
					'-',
					'+',
					'*',
					'/',
					'%',
					'<',
					'>',
					'&',
					'|'
				].includes(source.charAt(next))
			) {
				i += 1;
				continue;
			}
		}

		if (char === '?' && lastWord.length > 0) {
			const next = significant(source, i + 1);
			if ([':', ',', ')', ';'].includes(source.charAt(next))) {
				i += 1;
				last = '?';
				continue;
			}
		}

		out += char;
		i += 1;
		if (char === '\n') {
			const next = significant(source, i);
			if (
				!['=', '+', '-', '*', '/', '&', '|', '?', ':', '.', '<', '>', '(', '[', '{', ','].includes(
					source.charAt(next)
				)
			) {
				statementStart = true;
			}
		} else {
			if (char === ';' || char === '=' || char === ',') atMember = false;
			if (!/\s/.test(char)) {
				last = char;
				statementStart = false;
				if (afterVar > 0 && char !== ':') afterVar -= 1;
			}
		}
	}

	return out;
}

function skipInterface(source: string, from: number): number {
	let i = from;
	while (i < source.length && source.charAt(i) !== '}') {
		if (source.charAt(i) === '<') {
			i = skipBalanced(source, i, '<', '>');
			continue;
		}
		if (source.charAt(i) === '{') {
			i = skipBalanced(source, i, '{', '}');
			break;
		}
		if (source.charAt(i) === ';') break;
		i += 1;
	}
	while (i < source.length && source.charAt(i) === '\n') i += 1;
	return i;
}

function skipAliasOrList(source: string, from: number): number {
	let i = from;
	while (i < source.length && source.charAt(i) !== ';' && source.charAt(i) !== '\n') {
		if (source.charAt(i) === '{') {
			i = skipBalanced(source, i, '{', '}');
			continue;
		}
		if (source.charAt(i) === '(') {
			i = skipBalanced(source, i, '(', ')');
			continue;
		}
		if (source.charAt(i) === '<') {
			i = skipBalanced(source, i, '<', '>');
			continue;
		}
		if (source.charAt(i) === '=') {
			i = skipType(source, i + 1);
			break;
		}
		i += 1;
	}
	while (i < source.length && (source.charAt(i) === ';' || source.charAt(i) === '\n')) i += 1;
	return i;
}

function skipDeclaration(source: string, from: number): number {
	let i = from + 'declare'.length;
	while (i < source.length) {
		const char = source.charAt(i);
		if (char === ';') return i + 1;
		if (char === '{') return skipBalanced(source, i, '{', '}');
		if (char === '\n') return i;
		i += 1;
	}
	return i;
}

/* ── modules ─────────────────────────────────────────────────────────────── */

const BUILT_INS: Readonly<Record<string, string>> = {
	'@suwatte/toolchain': 'toolchain',
	cheerio: 'cheerio',
	'cheerio/slim': 'cheerio'
};

function rewriteImports(code: string, moduleUrl: string): string {
	const withSideEffects = code.replace(
		/^import\s+(["'])([^"']+)\1\s*;?/gm,
		(_whole, _quote: string, specifier: string) => {
			const built = BUILT_INS[specifier];
			let id = built;
			if (id === undefined) {
				if (!specifier.startsWith('.')) id = specifier;
				else {
					try {
						const url = new URL(specifier, moduleUrl);
						if (/\.[a-z]+$/i.test(url.pathname))
							url.pathname = url.pathname.replace(/\.(?:js|mjs)$/, '.ts');
						else url.pathname += '.ts';
						id = url.toString();
					} catch {
						id = specifier;
					}
				}
			}
			return `__require(${JSON.stringify(id)});`;
		}
	);
	return withSideEffects.replace(
		/import\s+([\s\S]*?)\s+from\s+(["'])([^"']+)\2\s*;?/g,
		(_whole, clause: string, _quote: string, specifier: string) => {
			const built = BUILT_INS[specifier];
			let id = built;
			if (id === undefined) {
				if (!specifier.startsWith('.')) {
					id = specifier;
				} else {
					try {
						const url = new URL(specifier, moduleUrl);
						if (/\.[a-z]+$/i.test(url.pathname))
							url.pathname = url.pathname.replace(/\.(?:js|mjs)$/, '.ts');
						else url.pathname += '.ts';
						id = url.toString();
					} catch {
						id = specifier;
					}
				}
			}

			const trimmed = clause.trim();
			const named = /^\{([\s\S]*)\}$/.exec(trimmed);
			if (named !== null) {
				const parts = named[1]
					.split(',')
					.map((part) => part.trim())
					.filter((part) => part.length > 0)
					.map((part) => {
						const alias = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(part);
						return alias === null ? part : `${alias[1]}: ${alias[2]}`;
					});
				return `const { ${parts.join(', ')} } = __require(${JSON.stringify(id)});`;
			}
			const namespace = /^\*\s+as\s+([\w$]+)$/.exec(trimmed);
			if (namespace !== null) return `const ${namespace[1]} = __require(${JSON.stringify(id)});`;
			return `const ${trimmed} = __require(${JSON.stringify(id)}).default;`;
		}
	);
}

function rewriteExports(code: string): { code: string; exported: string[] } {
	const exported: string[] = [];
	for (const match of code.matchAll(
		/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gm
	)) {
		exported.push(match[1]);
	}

	let next = code.replace(/^export\s+default\s+/gm, 'const __default__ = ');
	next = next.replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
	next = next.replace(/^export\s*\{([^}]*)\}\s*;?/gm, (_whole, body: string) =>
		body
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.length > 0)
			.map((part) => {
				const alias = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(part);
				return alias === null
					? `__exports.${part} = ${part};`
					: `__exports.${alias[2]} = ${alias[1]};`;
			})
			.join(' ')
	);
	return { code: next, exported };
}

function moduleCode(module: SuwatteModule): string {
	const { code, exported } = rewriteExports(
		rewriteImports(stripTypescript(module.source), module.url)
	);
	const tail = [
		'__exports.default = typeof __default__ === "undefined" ? undefined : __default__;',
		...exported.map((name) => `__exports.${name} = ${name};`)
	].join('\n');
	return `__define(${JSON.stringify(module.url)}, function (__exports, __require) {\n${code}\n${tail}\n});`;
}

/* ── the entry ───────────────────────────────────────────────────────────── */

/** The source-tree half: every module registered, the entry's default export run. */
function sourceTree(modules: readonly SuwatteModule[]): string {
	return `${modules.map(moduleCode).join('\n\n')}

var __module = __require(__ENTRY_URL);
var __Ctor = __module.default;

function __construct() {
  if (typeof __Ctor !== 'function') {
    throw new Error('This converted source has no default-exported runner class.');
  }
  return new __Ctor();
}`;
}

/**
 * The built half: the bundle at module scope, where its `var SourcePackage`
 * has to be declared, then the instance its own `bootstrap()` makes.
 */
function builtBundle(bundle: string): string {
	return `${bundle}

function __construct() {
  if (typeof SourcePackage !== 'object' || SourcePackage === null || typeof SourcePackage.bootstrap !== 'function') {
    throw new Error('This converted bundle defines no SourcePackage to start.');
  }
  return SourcePackage.bootstrap();
}`;
}

export function suwatteEntrypoint(options: SuwatteEntrypointOptions): string {
	return `${DOM_RUNTIME_SOURCE}
${DIGESTS}
${JS_RUNTIME}
${BOOT_CONTEXT}

const __PLUGIN_ID = ${JSON.stringify(options.pluginId)};
const __ENTRY_URL = ${JSON.stringify(options.entryUrl)};
const __SETTINGS = ${JSON.stringify(options.settings ?? [])};
const __dom = globalThis.__yorozoRuntime;

/* --- storage the app carries --------------------------------------------- */

var __objectStore = new Map();
var __secureStore = new Map();

function __stored(store, key, fallback) {
  return store.has(key) ? store.get(key) : fallback;
}

globalThis.ObjectStore = {
  string: async function (key) { return __stored(__objectStore, key, null); },
  number: async function (key) { return __stored(__objectStore, key, null); },
  boolean: async function (key) { return __stored(__objectStore, key, false) === true; },
  stringArray: async function (key) {
    var value = __stored(__objectStore, key, []);
    return Array.isArray(value) ? value : [];
  },
  set: async function (key, value) { __objectStore.set(key, value); },
  remove: async function (key) { __objectStore.delete(key); }
};

globalThis.SecureStore = {
  string: async function (key) { return __stored(__secureStore, key, null); },
  set: async function (key, value) { __secureStore.set(key, value); },
  remove: async function (key) { __secureStore.delete(key); }
};

/** The viewer's answers, under the keys the source's own constants use. */
function __plantSettings(ctx) {
  for (var i = 0; i < __SETTINGS.length; i++) {
    var setting = __SETTINGS[i];
    var value = null;
    if (ctx && ctx.settings) {
      if (setting.type === 'switch') value = ctx.settings.boolean(setting.id);
      // \`ctx.settings\` answers a list as \`list(id)\` (ABI §2); the source reads it
      // back through \`ObjectStore.stringArray\`, which is the toolchain's name.
      else if (setting.type === 'multiselect') value = ctx.settings.list(setting.id);
      else value = ctx.settings.string(setting.id);
    }
    __objectStore.set(setting.key, value);
  }
}

/* --- web primitives the app supplies ------------------------------------- */

class Headers {
  constructor(initial) {
    this._map = new Map();
    if (initial) for (var key in initial) this.set(key, initial[key]);
  }
  set(name, value) { this._map.set(String(name).toLowerCase(), String(value)); }
  append(name, value) {
    var key = String(name).toLowerCase();
    var existing = this._map.get(key);
    this._map.set(key, existing === undefined ? String(value) : existing + ', ' + String(value));
  }
  get(name) { return this._map.get(String(name).toLowerCase()) ?? null; }
  has(name) { return this._map.has(String(name).toLowerCase()); }
  delete(name) { this._map.delete(String(name).toLowerCase()); }
  entries() { return this._map.entries(); }
  keys() { return this._map.keys(); }
  values() { return this._map.values(); }
  forEach(fn) { this._map.forEach(function (value, key) { fn(value, key); }); }
  toString() {
    var out = [];
    this._map.forEach(function (value, key) { out.push(key + ': ' + value); });
    return out.join('\\n');
  }
  [Symbol.iterator]() { return this._map.entries(); }
}

class URLSearchParams {
  constructor(initial) {
    this._pairs = [];
    if (typeof initial === 'string') {
      for (var part of initial.replace(/^\\?/, '').split('&')) {
        if (part.length === 0) continue;
        var cut = part.indexOf('=');
        this._pairs.push(cut < 0
          ? [decodeURIComponent(part), '']
          : [decodeURIComponent(part.slice(0, cut)), decodeURIComponent(part.slice(cut + 1))]);
      }
    } else if (initial && typeof initial === 'object') {
      for (var key in initial) this.append(key, initial[key]);
    }
  }
  append(name, value) { this._pairs.push([String(name), String(value)]); }
  set(name, value) {
    this.delete(name);
    this.append(name, value);
  }
  get(name) {
    for (var pair of this._pairs) if (pair[0] === String(name)) return pair[1];
    return null;
  }
  getAll(name) {
    return this._pairs.filter(function (pair) { return pair[0] === String(name); }).map(function (pair) { return pair[1]; });
  }
  has(name) { return this.get(name) !== null; }
  delete(name) { this._pairs = this._pairs.filter(function (pair) { return pair[0] !== String(name); }); }
  entries() { return this._pairs[Symbol.iterator](); }
  keys() { return this._pairs.map(function (pair) { return pair[0]; })[Symbol.iterator](); }
  values() { return this._pairs.map(function (pair) { return pair[1]; })[Symbol.iterator](); }
  forEach(fn) { for (var pair of this._pairs) fn(pair[1], pair[0], this); }
  toString() {
    return this._pairs
      .map(function (pair) { return encodeURIComponent(pair[0]) + '=' + encodeURIComponent(pair[1]); })
      .join('&');
  }
  [Symbol.iterator]() { return this._pairs[Symbol.iterator](); }
}

/**
 * A real URL parser, because the sources build, join and stringify addresses
 * and a plain string would make '/api' and a base URL two different things.
 */
class URL {
  constructor(value, base) {
    var raw = String(value);
    var joined = raw;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      if (base === undefined) throw new TypeError('Invalid URL');
      var parent = String(base);
      var parsedBase = /^([a-z][a-z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)/i.exec(parent);
      if (parsedBase === null) throw new TypeError('Invalid base URL');
      if (raw.startsWith('//')) joined = parsedBase[1] + raw;
      else if (raw.startsWith('/')) joined = parsedBase[1] + '//' + parsedBase[2] + raw;
      else {
        var folder = parsedBase[3].replace(/[^/]*$/, '');
        joined = parsedBase[1] + '//' + parsedBase[2] + folder + raw;
      }
    }
    var parsed = /^([a-z][a-z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/i.exec(joined);
    if (parsed === null) throw new TypeError('Invalid URL: ' + raw);
    var hostPart = parsed[2];
    var credentials = /^(?:([^@]*)@)?(.*)$/.exec(hostPart);
    this.protocol = parsed[1].toLowerCase();
    this.username = credentials[1] === undefined ? '' : credentials[1].split(':')[0];
    this.password = credentials[1] === undefined ? '' : (credentials[1].split(':')[1] || '');
    this.host = credentials[2].toLowerCase();
    this.hostname = this.host.split(':')[0];
    this.port = this.host.indexOf(':') < 0 ? '' : this.host.split(':')[1];
    this.pathname = parsed[3] || '/';
    this.search = parsed[4] || '';
    this.hash = parsed[5] || '';
    this.searchParams = new URLSearchParams(this.search);
  }
  get origin() { return this.protocol + '//' + this.host; }
  toString() {
    var query = this.searchParams.toString();
    return this.protocol + '//' + this.host + this.pathname + (query.length > 0 ? '?' + query : '') + this.hash;
  }
  toJSON() { return this.toString(); }
}

globalThis.Headers = globalThis.Headers || Headers;
globalThis.URLSearchParams = globalThis.URLSearchParams || URLSearchParams;

/** Prefer the engine's own URL; the class above is the fallback realm shape. */
var __URL = globalThis.URL || URL;
if (globalThis.URL === undefined) globalThis.URL = URL;

/* --- the toolchain surface ----------------------------------------------- */

class CloudflareError extends Error {
  constructor(request) {
    super('Cloudflare is challenging this request. Open the site once and try again.');
    this.name = 'CloudflareError';
    this.request = request;
  }
}

class BasicRateLimiter {
  constructor(id, options) { this.id = id; this.options = options || {}; }
  registerInterceptor() {}
  unregisterInterceptor() {}
}

class CookieStore {
  constructor(options) { this.options = options || {}; this._cookies = []; }
  get cookies() { return this._cookies.slice(); }
  getAllCookies() { return this.cookies; }
  setCookie(cookie) { this._cookies.push(cookie); }
  deleteCookie(cookie) {
    this._cookies = this._cookies.filter(function (one) { return one.name !== cookie.name; });
  }
  registerInterceptor() {}
  unregisterInterceptor() {}
}

class Runner {}

function __labeled(shape) { return shape; }

var __toolchain = {
  ContentRating: { UNKNOWN: 'UNKNOWN', EVERYONE: 'EVERYONE', SUGGESTIVE: 'SUGGESTIVE', MATURE: 'MATURE', ADULT: 'ADULT', PORNOGRAPHIC: 'PORNOGRAPHIC' },
  ContentStatus: { UNKNOWN: 'UNKNOWN', ONGOING: 'ONGOING', COMPLETED: 'COMPLETED', HIATUS: 'HIATUS', CANCELLED: 'CANCELLED' },
  ContentType: { MANGA: 'MANGA', COMIC: 'COMIC', MANHWA: 'MANHWA', MANHUA: 'MANHUA', NOVEL: 'NOVEL' },
  ReadingMode: { PAGED_COMIC: 'PAGED_COMIC', PAGED_MANGA: 'PAGED_MANGA', VERTICAL: 'VERTICAL', WEBTOON: 'VERTICAL' },
  SourceChapterTextFormat: { HTML: 'HTML', TEXT: 'TEXT', MARKDOWN: 'MARKDOWN' },
  SourceInfo: __labeled({}),
  SourceVariant: __labeled({}),
  SourceConfiguration: __labeled({}),
  LabeledOption: __labeled({}),
  SearchRequest: __labeled({}),
  Item: __labeled({}),
  UIForm: __labeled({}),
  UISection: __labeled({}),
  CloudflareError: CloudflareError,
  BasicRateLimiter: BasicRateLimiter,
  CookieStore: CookieStore,
  Runner: Runner,
  NativeCrypto: __labeled({}),
  UIToggle: function (view) { return { type: 'toggle', ...view }; },
  UITextField: function (view) { return { type: 'textField', ...view }; },
  UIPicker: function (view) { return { type: 'picker', ...view }; },
  UISelect: function (view) { return { type: 'select', ...view }; },
  UIWebViewButton: function (view) { return { type: 'webViewButton', ...view }; },
  SearchFilter: function (id, title, filter, subtitle) {
    return { id: id, title: title, filter: filter, subtitle: subtitle };
  },
  SelectFilter: function (options, multiple) { return { type: 'select', options: options, multiple: multiple === true }; },
  PickerFilter: function (options) { return { type: 'picker', options: options }; },
  TextFilter: function () { return { type: 'text' }; },
  ToggleFilter: function () { return { type: 'toggle' }; },
  SortOptions: function (options) { return { options: options }; }
};

/** An unknown toolchain name throws by itself rather than arriving undefined. */
__toolchain = new Proxy(__toolchain, {
  get: function (target, member) {
    if (member in target) return target[member];
    if (typeof member !== 'string') return undefined;
    return function () {
      throw new Error('This converted Suwatte source used @suwatte/toolchain.' + member + ', which this build does not provide.');
    };
  }
});

/** The \`Crypto\` global's whole surface in this corpus. */
globalThis.Crypto = {
  sha256: function (value) {
    var bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
    return __digestSha256(bytes);
  }
};

/* --- the Application surface the compat classes still call --------------- */

var __selectors = new Map();
var __selectorSeq = 0;

function __selector(target, key) {
  var fn = typeof target === 'function' ? target : target[key];
  if (typeof fn !== 'function') {
    throw new Error('Application.Selector: "' + String(key) + '" is not a function.');
  }
  var id = 'selector-' + (++__selectorSeq);
  __selectors.set(id, fn.bind(target));
  return id;
}

var Application = {
  Selector: __selector,
  SelectorRegistry: {
    selector: function (token) {
      if (typeof token === 'function') return token;
      var found = __selectors.get(token);
      if (found === undefined) throw new Error('Application.SelectorRegistry.selector: no selector "' + String(token) + '".');
      return found;
    }
  },
  async scheduleRequest(init) {
    var call = init || {};
    var url = String(call.url || '') + String(call.param || '');
    if (url.length === 0) throw new Error('Application.scheduleRequest: the request names no url.');
    var raw = await fetchv2(url, {
      method: String(call.method || 'GET').toUpperCase(),
      headers: call.headers || {},
      body: call.body === undefined ? call.data : call.body
    });
    var text = await raw.text();
    var response = {
      status: raw.status,
      url: raw.url,
      headers: raw.headers || {},
      request: { url: url, method: String(call.method || 'GET').toUpperCase(), headers: call.headers || {} }
    };
    return [response, new TextEncoder().encode(text)];
  },
  async getDefaultUserAgent() { return 'Yorozo/1.0 (Suwatte conversion)'; }
};

globalThis.Application = Application;

/* --- the request client --------------------------------------------------- */

function __query(params) {
  if (params === undefined || params === null) return '';
  if (params instanceof URLSearchParams) return params.toString();
  if (typeof params === 'string') return params;
  var pairs = new URLSearchParams();
  for (var key in params) {
    var value = params[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (var one of value) pairs.append(key, one);
    else pairs.append(key, value);
  }
  return pairs.toString();
}

class HttpClient {
  constructor(options) {
    var config = options || {};
    this.baseUrl = config.baseUrl || '';
    this.headers = config.headers || {};
    this.validateStatus = config.validateStatus;
    this.rateLimit = config.rateLimit;
    this.requestTimeout = config.requestTimeout;
    this.interceptors = {
      request: { handlers: [], use: function (fn) { this.handlers.push(fn); return fn; } },
      response: { handlers: [], use: function (fn) { this.handlers.push(fn); return fn; } }
    };
  }

  async request(method, path, options) {
    var config = options || {};
    var url = /^[a-z][a-z0-9+.-]*:/i.test(String(path))
      ? String(path)
      : new __URL(String(path), this.baseUrl).toString();
    var query = __query(config.params);
    if (query.length > 0) url += (url.indexOf('?') < 0 ? '?' : '&') + query;

    var headers = new Headers(this.headers);
    if (config.headers) {
      var extra = config.headers instanceof Headers ? config.headers : new Headers(config.headers);
      for (var pair of extra) headers.set(pair[0], pair[1]);
    }

    var request = {
      url: url,
      method: String(method).toUpperCase(),
      headers: headers,
      params: config.params,
      context: config.context,
      body: config.body
    };

    for (var one of this.interceptors.request.handlers) {
      var changed = await one(request);
      if (changed !== undefined && changed !== null) request = changed;
    }

    var plain = {};
    for (var entry of (request.headers instanceof Headers ? request.headers : new Headers(request.headers))) {
      plain[entry[0]] = entry[1];
    }
    var pair = await Application.scheduleRequest({
      url: request.url,
      method: request.method,
      headers: plain,
      body: request.body === undefined ? undefined : (typeof request.body === 'string' ? request.body : JSON.stringify(request.body)),
      cookies: request.cookies || {}
    });

    var bytes = pair[1];
    var response = {
      status: pair[0].status,
      url: pair[0].url,
      headers: pair[0].headers,
      request: request,
      text: async function () { return new TextDecoder().decode(bytes); },
      json: async function () { return JSON.parse(new TextDecoder().decode(bytes)); },
      bytes: async function () { return bytes; },
      arrayBuffer: async function () { return bytes.buffer; },
      clone: function () { return response; }
    };

    for (var after of this.interceptors.response.handlers) {
      var rewritten = await after(response);
      if (rewritten !== undefined && rewritten !== null) response = rewritten;
    }

    if (this.validateStatus && !this.validateStatus(response.status)) {
      throw new Error('Request failed with status ' + response.status + ': ' + url);
    }
    return response;
  }

  get(path, options) { return this.request('GET', path, options); }
  post(path, body, options) { return this.request('POST', path, { ...(options || {}), body: body }); }
  put(path, body, options) { return this.request('PUT', path, { ...(options || {}), body: body }); }
  patch(path, body, options) { return this.request('PATCH', path, { ...(options || {}), body: body }); }
  delete(path, options) { return this.request('DELETE', path, options); }
}

globalThis.HttpClient = HttpClient;

/* --- cheerio, over the bundle's own parser -------------------------------- */

function __selection(nodes, doc) {
  var api = {
    length: nodes.length,
    __nodes: nodes,
    toArray: function () { return nodes.slice(); },
    get: function (i) { return i === undefined ? nodes.slice() : nodes[i < 0 ? nodes.length + i : i]; },
    eq: function (i) { var at = i < 0 ? nodes.length + i : i; return __selection(at >= 0 && at < nodes.length ? [nodes[at]] : [], doc); },
    first: function () { return api.eq(0); },
    last: function () { return api.eq(nodes.length - 1); },
    find: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) out = out.concat(nodes[i].select(String(selector)));
      return __selection(out, doc);
    },
    children: function (selector) {
      var kids = [];
      for (var i = 0; i < nodes.length; i++) kids = kids.concat(nodes[i].children);
      var out = __selection(kids, doc);
      return selector === undefined ? out : out.filter(selector);
    },
    parent: function () {
      var up = [];
      for (var i = 0; i < nodes.length; i++) {
        var parent = nodes[i].parent;
        if (parent !== null && parent !== undefined && up.indexOf(parent) === -1) up.push(parent);
      }
      return __selection(up, doc);
    },
    text: function () {
      var value = '';
      for (var i = 0; i < nodes.length; i++) value += nodes[i].text();
      return value;
    },
    html: function () { return nodes.length === 0 ? null : nodes[0].html(); },
    attr: function (name) {
      if (nodes.length === 0) return undefined;
      var value = nodes[0].attr(String(name));
      return value === '' && !nodes[0].hasAttr(String(name)) ? undefined : value;
    },
    each: function (fn) {
      for (var i = 0; i < nodes.length; i++) fn.call(nodes[i], i, nodes[i]);
      return api;
    },
    map: function (fn) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) out.push(fn.call(nodes[i], i, nodes[i]));
      return { length: out.length, get: function () { return out; }, toArray: function () { return out; } };
    },
    filter: function (test) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var keep = typeof test === 'function'
          ? test.call(nodes[i], i, nodes[i])
          : __selection([nodes[i]], doc).is(test);
        if (keep) out.push(nodes[i]);
      }
      return __selection(out, doc);
    },
    is: function (selector) {
      for (var i = 0; i < nodes.length; i++) {
        var owner = nodes[i].ownerDocument();
        if (owner !== null && owner.select(String(selector)).indexOf(nodes[i]) !== -1) return true;
      }
      return false;
    },
    val: function () { return nodes.length === 0 ? undefined : nodes[0].val(); }
  };
  return api;
}

function __cheerioLoad(html) {
  var doc = __dom.parseHtml(String(html === null || html === undefined ? '' : html));
  var $ = function (what, context) {
    if (what === null || what === undefined) return __selection([], doc);
    if (typeof what === 'object') return __selection(what.__nodes !== undefined ? what.__nodes : [what], doc);
    var roots = context === undefined
      ? [doc]
      : (typeof context === 'object' && context.__nodes !== undefined ? context.__nodes : [context]);
    var out = [];
    for (var i = 0; i < roots.length; i++) out = out.concat(roots[i].select(String(what)));
    return __selection(out, doc);
  };
  $.html = function (node) { return node === undefined ? doc.html() : __selection([node], doc).html(); };
  $.root = function () { return __selection([doc], doc); };
  $.xml = function () { return $.apply(null, arguments); };
  return $;
}

var __cheerio = { load: __cheerioLoad, default: { load: __cheerioLoad } };

/* --- the module registry -------------------------------------------------- */

var __modules = new Map();

function __define(url, factory) {
  __modules.set(url, { factory: factory, exports: {}, loaded: false });
}

function __require(id) {
  if (id === 'toolchain') return __toolchain;
  if (id === 'cheerio') return __cheerio;
  var found = __modules.get(id);
  if (found === undefined) {
    throw new Error('This converted source imports "' + id + '", which this build does not provide.');
  }
  if (!found.loaded) {
    found.loaded = true;
    found.factory(found.exports, __require);
  }
  return found.exports;
}

${options.bundle === undefined ? sourceTree(options.modules) : builtBundle(options.bundle)}

/* --- the ABI -------------------------------------------------------------- */

var __runner = null;

async function __instance() {
  if (__runner !== null) return __runner;
  __runner = __construct();
  if (typeof __runner.onLoad === 'function') await __runner.onLoad();
  if (typeof __runner.initialise === 'function') await __runner.initialise();
  return __runner;
}

function __page(value) {
  var decoded = value || {};
  var rows = Array.isArray(decoded.items) ? decoded.items : [];
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row || typeof row !== 'object') continue;
    var id = String(row.id || '');
    var title = String(row.title || '').trim();
    if (id.length === 0 || title.length === 0) continue;
    entries.push({
      sourceMediaId: id,
      title: title,
      alternativeTitles: [],
      posterImageUrl: row.coverImage === undefined || row.coverImage === null || row.coverImage === '' ? undefined : String(row.coverImage)
    });
  }
  return { entries: entries, hasMore: decoded.isLastPage !== true && entries.length > 0 };
}

/**
 * The Referer a source's \`SourceConfiguration\` asks its images be fetched with.
 *
 * The toolchain's own answer to the most common image failure — a CDN that
 * answers 403 without one — and eighteen measured sources declare it rather
 * than setting headers per page. The ABI's page carries headers to the byte
 * fetch (§8.3), so it travels there; a header the page set itself wins.
 */
async function __imageReferer(runner) {
  if (typeof runner.getConfiguration !== 'function') return '';
  try {
    var config = await runner.getConfiguration();
    return config && typeof config.imageReferer === 'string' ? config.imageReferer : '';
  } catch (error) {
    return '';
  }
}

function __hasHeader(headers, name) {
  if (!headers) return false;
  for (var key in headers) if (String(key).toLowerCase() === name) return true;
  return false;
}

async function __imageRequest(page) {
  if (typeof page.willRequestImage !== 'function') return page;
  var request = { url: String(page.url || ''), headers: page.headers || {} };
  var changed = await page.willRequestImage(request);
  return changed || request;
}

export default {
  id: __PLUGIN_ID,

  async searchCatalog(query, page, ctx) {
    __enter(ctx);
    __plantSettings(ctx);
    var runner = await __instance();
    if (typeof runner.getSearchResults !== 'function') return { entries: [] };
    var request = { query: String(query), filters: {}, sort: undefined };
    return __page(await runner.getSearchResults(request, Math.max(1, Number(page) || 1)));
  },

  async listChapters(sourceMediaId, ctx) {
    __enter(ctx);
    __plantSettings(ctx);
    var runner = await __instance();
    if (typeof runner.getChapters !== 'function') return [];
    var rows = await runner.getChapters(String(sourceMediaId));
    var chapters = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var id = String(row.id || '');
      if (id.length === 0) continue;
      chapters.push({
        sourceChapterId: id,
        number: Number.isFinite(Number(row.number)) ? Number(row.number) : chapters.length + 1,
        title: typeof row.title === 'string' && row.title.length > 0 ? row.title : undefined,
        volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : undefined
      });
    }
    chapters.sort(function (a, b) { return a.number - b.number; });
    return chapters;
  },

  async readChapter(sourceMediaId, chapter, ctx) {
    __enter(ctx);
    __plantSettings(ctx);
    var runner = await __instance();
    if (typeof runner.getChapterPages !== 'function') return { pages: [] };
    var chapterId = chapter && chapter.sourceChapterId ? String(chapter.sourceChapterId) : '';
    if (chapterId.length === 0) throw new Error('This chapter has no source id to read.');
    var rows = await runner.getChapterPages(String(sourceMediaId), chapterId);
    var referer = await __imageReferer(runner);
    var pages = [];
    for (var i = 0; i < (rows || []).length; i++) {
      var row = rows[i];
      if (!row || typeof row !== 'object') continue;
      var request = await __imageRequest(row);
      var url = String(request.url || '');
      if (url.length === 0) continue;
      var headers = request.headers && typeof request.headers === 'object' ? Object.assign({}, request.headers) : undefined;
      if (referer.length > 0 && !__hasHeader(headers, 'referer')) {
        headers = Object.assign(headers || {}, { Referer: referer });
      }
      pages.push({ index: pages.length, url: url, headers: headers });
    }
    var content = null;
    if (typeof runner.getContent === 'function') {
      try { content = await runner.getContent(String(sourceMediaId)); } catch (error) { content = null; }
    }
    return { pages: pages, direction: content && content.readingMode === 'VERTICAL' ? 'vertical' : undefined };
  }
};
`;
}
