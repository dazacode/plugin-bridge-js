// Fails if the plugin runtime has grown a dependency on the app around it.
//
//   bun tool/check-runtime-boundary.ts        (also: bun run check:boundary)
//
// ## Why this exists
//
// `client-web/src/lib/plugins/` is 29,000 lines of ordinary portable
// JavaScript — six foreign-format adapters, a Kotlin translator, the runtime
// shims a converted bundle carries, and the sandbox host. ADR-0004 §2.2
// measured what stood between it and running in any JavaScript host and found
// nine import lines and four ambient capabilities. All of them are gone now
// (`contract/HOST.md`), which makes this file the interesting one:
// nothing *else* prevents the tenth import, and a runtime that is portable by
// accident stops being portable on the first afternoon somebody is in a hurry.
//
// The last of those four is gone too. `foreign/kotlin/grammar.ts` used to be
// exempted here by name, because it resolved its vendored tree-sitter artefacts
// against `import.meta.url` and read them with an ambient `fetch`; ADR-0004
// phase 2 made that a host capability (`PluginHost.wasm`) when a second host
// turned up that had no URL-relative asset resolution to fall back on. What is
// left in EXEMPT is worker interiors, feature-detected timing hints, and bundle
// source — no unfinished business.
//
// The Node host is no longer an exception at all. It used to be four file names
// exempted inside `packages/host`; it is now `packages/host-node`, a package
// this check does not scan, because a host implementation reaching for
// `process` and a filesystem is what a host implementation is for. The
// interfaces it implements stayed behind in `packages/host` and are checked
// like everything else — which is the arrangement the exemption list was
// standing in for.
//
// So the rule is checked rather than remembered, and it is checked at the two
// places portability actually breaks:
//
//   1. an import that leaves the directory — `$lib`, `$app`, `$env`, or a
//      relative path that climbs out of it;
//   2. an ambient host capability taken directly instead of arriving through
//      the port — `navigator`, `localStorage`, `new Worker`, `import.meta`,
//      a bare `fetch`.
//
// ## What it does not check, and why that is honest
//
// A file that declares its own binding for a banned name — a parameter called
// `document`, which the theme adapters have several of — is not examined for
// that name at all. Deciding otherwise means implementing lexical scope, and
// the failure mode of getting *that* subtly wrong is a check nobody trusts.
// The trade is a possible false negative in a file that shadows a global and
// then also reaches for the real one; that shape does not exist today and
// would be visible in review. False *positives* are what would kill this
// check, so there are none by construction.
//
// The exemptions in EXEMPT are the whole of what is left, each with a reason,
// and `docs/KNOWN_GAPS.md` carries the same list for a reader who is not
// reading this file. A new file cannot join them by accident.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The compiler is resolved from `client-web/`, which is the only place in this
// repository with a `node_modules`. Parsing TypeScript with a regex over the
// raw text was the alternative and it is worse in exactly the way that matters
// here: a `/\\\//g` regex literal reads as the start of a line comment, and
// everything after it stops being checked without anybody noticing.
const require = createRequire(new URL('../../../package.json', import.meta.url));
const ts = require('typescript') as typeof import('typescript');

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/**
 * Every package that ships inside a converted bundle or sits behind the port.
 *
 * `cli` is deliberately absent: it *is* a host, so it may read a filesystem and
 * spawn a process. The rule is about the parts that must run anywhere.
 *
 * `host-node` is absent for the same reason, and that absence is the whole of
 * what used to be a list of four file names here. `packages/host` held two
 * different things — the *port*, which must travel anywhere, and one
 * implementation of it for Node, which exists precisely to reach for
 * `process`, `fetch` and a filesystem and hand them over as capabilities — and
 * checking the second against this rule would be asking a power socket not to
 * touch the mains. They are two packages now, so the exception is a package
 * that is not named rather than four files that are.
 */
const RUNTIME_PACKAGES = ['core', 'runtime', 'adapters', 'host'].map((name) =>
	resolve(ROOT, 'packages', name, 'src')
);

/**
 * Ambient host capabilities. A value use of one of these inside the runtime is
 * a capability taken rather than granted.
 *
 * Not on the list, deliberately: `crypto`, `setTimeout`, `queueMicrotask`,
 * `TextEncoder`, `Response`, `URL`. Those are the JavaScript baseline every
 * host in ADR-0004 §4's table has — browser, Worker, Node, Deno, Bun — and a
 * host cannot withhold them, so requiring them to be injected would be
 * ceremony rather than portability. HOST.md §7 states that baseline, and it is
 * the list to argue with if this one looks short.
 */
const AMBIENT = new Set([
	'navigator',
	'localStorage',
	'sessionStorage',
	'indexedDB',
	'caches',
	'window',
	'document',
	'globalThis',
	'self',
	'process',
	'location',
	'XMLHttpRequest',
	'WebSocket',
	'EventSource',
	'importScripts',
	'fetch'
]);

/**
 * Files allowed to reach for something ambient, and what each is allowed.
 *
 * Read this as the list of things phase 1 did not finish rather than as a
 * convenience. Every entry is either a port implementation that happens to
 * live inside the runtime because its *body* is the runtime's contract, or a
 * seam that already exists and has no caller using it yet.
 */
const EXEMPT: Readonly<Record<string, string>> = {
	// The inside of the sandbox, not a consumer of one. Its whole job is to
	// delete the capabilities its own scope was born with, which it cannot do
	// without naming them. HOST.md §3 makes reproducing this an obligation on
	// any host supplying its own isolate rather than a browser detail.
	'sandbox.worker.ts': 'the isolate interior: it names ambient globals in order to delete them',
	// The other side of the translation worker. Talks to `self`, holds no
	// authority, and reaches nothing a plugin could observe.
	'kotlin/translate.worker.ts': 'the translator isolate interior',
	// Optional scheduling hints, every one feature-detected with a fallback to
	// `setTimeout` and `Date.now()`. A host cannot withhold these in a way that
	// changes an answer — only how long it takes — so they are timing rather
	// than capability. Argued in the file's own header.
	'scheduling.ts': 'feature-detected scheduling hints, each with a baseline fallback',
	// Bundle source, not host code. `tool/gen-plugin-runtime.ts` inlines this
	// into every converted plugin, where `globalThis` is the *sandbox's* global
	// and publishing the parser onto it is how the bundle's own runtime is
	// reached. Its own header says nothing imports it at runtime.
	'shims/runtime-entry.ts':
		'bundle source: the `globalThis` it writes to belongs to the sandbox, not the host'
};

/**
 * Specs are held to the import rule, minus `$contract`, and to nothing else.
 *
 * A spec is a fifth host — vitest on Node — with capabilities of its own, and
 * it ships in nobody's build. Holding one to the port would mean inventing a
 * fixture-loading capability whose only consumer is a test, which is ceremony
 * bought with a worse test. `$contract` is allowed because
 * `contract/fixtures/` is the *cross-client* vector set: `segment-pipeline`'s
 * Dart twin reads the same JSON, and a vector shared by two implementations is
 * the opposite of a dependency on one of them.
 *
 * What a spec is still not allowed is `$lib` and `$app`. Those are the app,
 * and a test that reaches for the app is a test that would stop compiling in
 * the headless host of ADR-0004 §6.2 — which is the host these specs will be
 * asked to run in first.
 */
function isSpec(rel: string): boolean {
	return rel.endsWith('.spec.ts');
}

/** SvelteKit's aliases. Any of them is by definition outside this directory. */
const ALIAS = /^\$(lib|app|env|contract)\b/;

interface Violation {
	readonly file: string;
	readonly line: number;
	readonly column: number;
	readonly message: string;
}

function sources(directory: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(directory)) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			out.push(...sources(path));
			continue;
		}
		if (entry.endsWith('.ts')) out.push(path);
	}
	return out.sort();
}

/**
 * Every name this file binds itself.
 *
 * Collected once per file and consulted before any ambient name is reported —
 * see the header for why that is the trade, and why it is the safe direction
 * to be wrong in.
 */
function declaredNames(file: import('typescript').SourceFile): Set<string> {
	const names = new Set<string>();
	const record = (name: import('typescript').Node | undefined): void => {
		if (name === undefined) return;
		if (ts.isIdentifier(name)) names.add(name.text);
		else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
			for (const element of name.elements) {
				if (ts.isBindingElement(element)) record(element.name);
			}
		}
	};
	const walk = (node: import('typescript').Node): void => {
		if (
			ts.isVariableDeclaration(node) ||
			ts.isParameter(node) ||
			ts.isBindingElement(node) ||
			ts.isFunctionDeclaration(node) ||
			ts.isClassDeclaration(node) ||
			ts.isImportClause(node) ||
			ts.isImportSpecifier(node) ||
			ts.isNamespaceImport(node)
		) {
			record(node.name);
		}
		ts.forEachChild(node, walk);
	};
	ts.forEachChild(file, walk);
	return names;
}

/** Whether this identifier is a name rather than a value being read. */
function isNamePosition(node: import('typescript').Identifier): boolean {
	const parent = node.parent;
	if (parent === undefined) return false;
	// `x.navigator` is a property, not the global.
	if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
	if (ts.isQualifiedName(parent) && parent.right === node) return true;
	// `{ navigator: … }`, `class { fetch() {} }`, `interface { fetch: … }`.
	if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
	if (ts.isPropertySignature(parent) && parent.name === node) return true;
	if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
	if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
	if (ts.isMethodSignature(parent) && parent.name === node) return true;
	if (ts.isShorthandPropertyAssignment(parent)) return true;
	return false;
}

/** Whether this identifier sits in a type, where naming a global costs nothing. */
function isTypePosition(node: import('typescript').Node): boolean {
	for (let at = node.parent; at !== undefined; at = at.parent) {
		// `typeof fetch` and `Worker | null` are descriptions, not uses. A type
		// cannot reach the network.
		if (ts.isTypeNode(at) || ts.isTypeQueryNode(at)) return true;
		if (ts.isExpressionStatement(at) || ts.isBlock(at)) return false;
	}
	return false;
}

function checkFile(path: string, root: string): Violation[] {
	const rel = relative(root, path).split(sep).join('/');
	const exemption = EXEMPT[rel];
	const text = readFileSync(path, 'utf8');
	const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
	const found: Violation[] = [];
	const declared = declaredNames(file);

	const at = (node: import('typescript').Node, message: string): void => {
		const { line, character } = file.getLineAndCharacterOfPosition(node.getStart(file));
		found.push({
			file: relative(ROOT, path),
			line: line + 1,
			column: character + 1,
			message
		});
	};

	const spec = isSpec(rel);

	const checkSpecifier = (node: import('typescript').Node, specifier: string): void => {
		if (spec && specifier.startsWith('$contract/')) return;
		if (ALIAS.test(specifier)) {
			at(
				node,
				`imports \`${specifier}\`. The plugin runtime owns the types and failures it ` +
					`needs and the app re-exports them; see contract/HOST.md §1.`
			);
			return;
		}
		// A bare specifier is a package, which travels fine — including the
		// workspace's own `@plugin-bridge/*`, which is how one package reaches
		// another now that they are packages rather than folders.
		if (!specifier.startsWith('.')) return;
		const target = resolve(path, '..', specifier);
		if (RUNTIME_PACKAGES.some((one) => target === one || target.startsWith(one + sep))) return;
		at(
			node,
			`imports \`${specifier}\`, which resolves outside the runtime directory. ` +
				`See contract/HOST.md §1.`
		);
	};

	const walk = (node: import('typescript').Node): void => {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier !== undefined &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			checkSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length > 0 &&
			ts.isStringLiteral(node.arguments[0])
		) {
			checkSpecifier(
				node.arguments[0],
				(node.arguments[0] as import('typescript').StringLiteral).text
			);
		}

		if (exemption === undefined && !spec) {
			// `new Worker(new URL('./x.worker.ts', import.meta.url))` — the one
			// genuinely bundler-shaped construction in the runtime, and the reason
			// the port has a `WorkerFactory` at all.
			if (
				ts.isNewExpression(node) &&
				ts.isIdentifier(node.expression) &&
				node.expression.text === 'Worker'
			) {
				at(
					node,
					'constructs a `Worker` directly. An isolate arrives through ' +
						'`WorkerFactory`; see contract/HOST.md §5.'
				);
			}
			if (
				node.kind === ts.SyntaxKind.MetaProperty &&
				(node as import('typescript').MetaProperty).keywordToken === ts.SyntaxKind.ImportKeyword
			) {
				at(
					node,
					'reads `import.meta`, which is a fact about the bundler rather than ' +
						'about the runtime. See contract/HOST.md §5.'
				);
			}
			if (
				ts.isIdentifier(node) &&
				AMBIENT.has(node.text) &&
				!declared.has(node.text) &&
				!isNamePosition(node) &&
				!isTypePosition(node)
			) {
				at(
					node,
					`takes the ambient \`${node.text}\`. Every host capability arrives through ` +
						`\`$lib/plugins/host.ts\`; see contract/HOST.md §2.`
				);
			}
		}

		ts.forEachChild(node, walk);
	};
	walk(file);
	return found;
}

function main(): void {
	const files = RUNTIME_PACKAGES.flatMap((root) =>
		sources(root)
			.map((path) => ({ path, root, rel: relative(root, path).split(sep).join('/') }))
			// A spec is not the runtime: it never ships in a bundle and never runs
			// in a host, so the one thing this rule protects does not apply to it.
			.filter(({ rel }) => !rel.endsWith('.spec.ts'))
	);
	const violations = files.flatMap(({ path, root }) => checkFile(path, root));

	if (violations.length === 0) {
		const exempt = Object.keys(EXEMPT).length;
		process.stdout.write(
			`runtime boundary: ${files.length} files clean, ${exempt} exempted by name.\n`
		);
		return;
	}

	process.stderr.write(
		`\nThe plugin runtime reached outside itself in ${violations.length} place` +
			`${violations.length === 1 ? '' : 's'}:\n\n`
	);
	for (const violation of violations) {
		process.stderr.write(`  ${violation.file}:${violation.line}:${violation.column}\n`);
		process.stderr.write(`    ${violation.message}\n\n`);
	}
	process.stderr.write(
		'The runtime runs in four hosts (ADR-0004 §3) and only one of them is this\n' +
			'browser. If the capability is real, add it to the port in\n' +
			'packages/host/src/host.ts and implement it in the shell.\n'
	);
	process.exit(1);
}

/** The subcommand entry for the runtime/host boundary assertion. */
export async function runBoundary(argv: string[]): Promise<number> {
	process.argv = [process.argv[0], process.argv[1], ...argv];
	main();
	return 0;
}
