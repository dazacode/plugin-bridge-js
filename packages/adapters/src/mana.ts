/**
 * Source repositories published for Mana, a manga reader.
 *
 * A repository is a `sources.json` — an object with a `repositoryName` and a
 * `sources` array — and one `.mana` bundle per row under `sources/<path>.mana`.
 * Both halves of that shape are the ecosystem's own: the index is what its
 * client fetches to draw a list, and the bundle is what it installs.
 *
 * ## The bundle is already built, and that decides everything here
 *
 * A `.mana` is a single minified CommonJS file from the ecosystem's own
 * toolchain. It carries its own polyfills (`Buffer`, `URL`, `process`, the
 * base64 decoder), bundles the `@mana-app/types` runtime *including* its HTTP
 * client, and ends by assigning its class to `globalThis.Target`. So the only
 * thing this build owes it is a host: `globalThis.__manaHTTPBridge` is the one
 * global the bundle expects and does not supply, and it is exactly the boundary
 * our `ctx.http` can stand in at. `shims/mana-entry.ts` supplies the bridge and
 * the ABI; the bundle is embedded byte for byte.
 *
 * ## The source path, and why refusing is most of it
 *
 * A repository that has not been built publishes no `.mana` at all, and the
 * entry module it would have built from is TypeScript that imports a base class,
 * its own helpers and `cheerio` across several files. A half-version of a module
 * system produces bundles that load and then throw, so this path reads the
 * **entry file only** and refuses, by name and with an obstacle, the two things
 * one file cannot carry: a relative import, and any bare module other than
 * `@mana-app/types`.
 *
 * The type stripping that remains is narrow on purpose — see `stripTypescript`.
 *
 * ## Trackers share the array
 *
 * A repository lists trackers beside sources, same shape, `environment:
 * "tracker"`. A tracker has no catalogue, so it is skipped and counted rather
 * than listed as a source that answers nothing.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { packageBundle } from '@plugin-bridge/core/package';
import { manaEntrypoint } from '@plugin-bridge/runtime/shims/mana-entry';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/**
 * Where a repository's index might be, in the order the layout is likely.
 *
 * `index.json` is last and only ever a courtesy: several ecosystems publish one,
 * and the body decides between them.
 */
const INDEX_PATHS = ['sources.json', 'dist/sources.json', 'index.json'];

/**
 * `CatalogRating` as the index numbers it: 0 safe, 1 mixed, 2 adult.
 *
 * Only 2 is a listing-level claim of adult content. A `1` says the catalogue is
 * mixed, which is true of most comic sites and is not a claim that everything
 * behind the row is adult — and a badge on every row stops meaning anything.
 * The bundle's own per-title `ContentRating` is finer and travels per result.
 */
function isNsfwRating(value: unknown): boolean {
	return value === 2;
}

/**
 * The directory an index sits in, with a build directory removed.
 *
 * `dist/sources.json` is the built copy *beside* a `src/` tree one level up, so
 * resolving a source path against `dist/` would look for a `dist/src/` that is
 * never published.
 */
function repositoryRoot(indexUrl: string): string {
	const url = new URL(indexUrl);
	const segments = url.pathname.split('/').filter((one) => one.length > 0);
	if (segments.length > 1 && segments[segments.length - 2] === 'dist') segments.pop();
	segments.pop();
	return `${url.origin}${segments.length === 0 ? '/' : `/${segments.join('/')}/`}`;
}

/** One entry's folder name, as the bundle path is spelled from it. */
function pathOf(row: Record<string, unknown>): string | null {
	const value = row['path'] ?? row['id'];
	if (typeof value !== 'string' || value.length === 0) return null;
	return value.replace(/^\/+|\/+$/g, '');
}

/**
 * Every address one source may be readable at, best first.
 *
 * The first is the built bundle, which is what conversion prefers. The rest are
 * the source tree in the three layouts this ecosystem has used. All of it is
 * resolved here rather than at conversion so that replaying a stored listing
 * reads the same files.
 */
function artifactCandidates(row: Record<string, unknown>, indexUrl: string): string[] {
	const path = pathOf(row);
	if (path === null) return [];

	const directory = new URL(indexUrl);
	directory.search = '';
	directory.hash = '';
	const built = new URL(`sources/${path}.mana`, directory).toString();

	const root = repositoryRoot(indexUrl);
	const source = [
		`src/sources/${path}/index.ts`,
		`src/${path}/main.ts`,
		`src/${path}/index.ts`
	].map((one) => new URL(one, root).toString());

	return [built, ...source];
}

/**
 * Hosts written as base64 in a bundle or a source.
 *
 * This ecosystem stores its own API address encoded often enough that a reader
 * of the text alone misses it — and a missed host is a request refused at call
 * time, reported to a viewer as a broken source. Decoding is discovery, never
 * trust: what is found here still lands on the consent sheet.
 */
export function hostsInEncoded(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(/['"`]([A-Za-z0-9+/]{16,}={0,2})['"`]/g)) {
		let decoded: string;
		try {
			decoded = atob(match[1]);
		} catch {
			continue;
		}
		// Handed to URL rather than to the source scanner: a decode yields a bare
		// address with no string literal around it to anchor on.
		for (const address of decoded.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
			try {
				const host = new URL(address[0]).hostname.toLowerCase();
				if (host.split('.').length > 1) found.add(host);
			} catch {
				// A decode that happens to contain "://" is not evidence of one.
			}
		}
	}
	return [...found];
}

export const manaAdapter: ForeignAdapter = {
	format: 'mana',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const base = pasted.toString().replace(/\/+$/, '');
		// Two ways to name the same repository: the address its own client is
		// given (`<base>/<branch>`, index a sibling of the path), and a forge
		// URL, where the same file sits on a branch.
		const direct = INDEX_PATHS.map((path) => `${base}/${path}`);
		const repository = parseRepositoryUrl(pasted);
		const forged =
			repository === null
				? []
				: INDEX_PATHS.flatMap((path) => rawCandidates(repository, path, DEFAULT_REFS));

		return [...new Set([...direct, ...forged])];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		// Two spellings are in circulation: this object, and the bare array an
		// unbuilt repository publishes beside its `src/`. Both are read. What is
		// *not* read is an array of things that are not sources, which is what
		// several other ecosystems publish under `index.json`.
		const document =
			typeof decoded === 'object' && decoded !== null && !Array.isArray(decoded)
				? (decoded as Record<string, unknown>)
				: null;
		if (document !== null && !Array.isArray(document['sources'])) {
			throw new ForeignFormatError('not a Mana source index');
		}

		const list = Array.isArray(decoded) ? decoded : document?.['sources'];
		if (!Array.isArray(list) || list.length === 0) {
			throw new ForeignFormatError('not a Mana source index');
		}

		// `path` (the build's folder name) plus a numeric `intents` mask is the
		// pair no other ecosystem's entries carry.
		const rows = list.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			return (
				typeof row['id'] === 'string' &&
				typeof row['name'] === 'string' &&
				(typeof row['path'] === 'string' || typeof row['intents'] === 'number')
			);
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Mana source index');

		const plugins: RepositoryPlugin[] = [];
		let trackers = 0;

		for (const row of rows) {
			const environment = typeof row['environment'] === 'string' ? row['environment'] : 'source';
			if (environment !== 'source') {
				trackers += 1;
				continue;
			}

			const candidates = artifactCandidates(row, indexUrl);
			const artifactUrl = candidates[0];
			if (artifactUrl === undefined) continue;

			const id = String(row['id']);
			const languages = Array.isArray(row['supportedLanguages']) ? row['supportedLanguages'] : [];
			const developers = Array.isArray(row['developers']) ? row['developers'] : [];
			const first = developers[0];
			const author =
				first !== null && typeof first === 'object'
					? String((first as Record<string, unknown>)['name'] ?? '')
					: '';

			plugins.push(
				foreignListing({
					id: convertedPluginId('mana', id),
					name: String(row['name']),
					description: String(row['description'] ?? ''),
					version: String(row['version'] ?? '0'),
					author,
					language: languages.length > 0 ? String(languages[0]) : null,
					// The site the source scrapes, and the icon a client draws for
					// it. The bundle's own hosts are added at conversion, from the
					// bundle, because they are not in the index.
					hosts: hostsFromUrls([
						typeof row['website'] === 'string' ? row['website'] : null,
						typeof row['thumbnail'] === 'string' ? row['thumbnail'] : null
					]),
					origin: {
						format: 'mana',
						artifactUrl,
						foreignId: id,
						foreignVersion: String(row['version'] ?? '0'),
						mediaKind: 'manga',
						isNsfw: isNsfwRating(row['rating']),
						// Everything the later hops need, resolved while the index is
						// in hand, so conversion stays a function of the listing.
						// `hash` is the ecosystem's own 96-character digest, carried
						// as a fact and deliberately not checked: it is not our
						// digest, and verifying against it would report every
						// converted bundle as tampered with.
						detail: {
							path: pathOf(row) ?? '',
							alternates: candidates.slice(1),
							ecosystemHash: typeof row['hash'] === 'string' ? row['hash'] : ''
						}
					}
				})
			);
		}

		const kept = keepMediums({
			name: String(document?.['repositoryName'] ?? 'Mana sources'),
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'mana'
		});
		return { ...kept, filteredOut: (kept.filteredOut ?? 0) + trackers };
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'mana') {
			throw new ForeignFormatError('That listing did not come from a Mana repository.');
		}
		const detail = origin.detail ?? {};
		const alternates = Array.isArray(detail['alternates'])
			? detail['alternates'].filter((one): one is string => typeof one === 'string')
			: [];

		let text: string | null = null;
		let built = false;

		// The built bundle first, and its failure is not fatal: a repository that
		// was never built lists rows whose `.mana` is simply not there.
		try {
			text = new TextDecoder().decode(await services.fetchArtifact(origin.artifactUrl));
			built = true;
		} catch {
			text = null;
		}
		for (const candidate of alternates) {
			if (text !== null) break;
			try {
				text = await services.getText(candidate);
			} catch {
				text = null;
			}
		}
		if (text === null) {
			throw new ForeignFormatError(
				`Nothing readable was published for "${listing.name}": neither the built bundle nor a ` +
					'source file at any layout this format has used could be fetched.',
				['missingArtifact']
			);
		}

		const script = built ? text : transpiledEntry(text, listing.name);
		const hosts = [
			...new Set([...listing.hosts, ...hostsInSource(text), ...hostsInEncoded(text)])
		].sort();

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0
					? `Converted Mana source. ${listing.description}`
					: 'Converted Mana source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource: manaEntrypoint({
				pluginId: listing.id,
				// Which half of the shim to emit. The bundle needs the host bridge
				// and nothing else; a source file needs a base class, because in a
				// single file nothing supplies one.
				artifact: built ? { kind: 'bundle', script } : { kind: 'source', script }
			})
		});
	}
};

/**
 * The source path: one TypeScript entry file, made runnable.
 *
 * Only reached for a repository with no build output, which is why it can be
 * this narrow. Every import is inspected rather than rewritten:
 *
 * - `@mana-app/types` becomes a destructure from the shim's module, because
 *   that package is a *types* package and exists at runtime only as the few
 *   enums and the HTTP client the published build would have baked in;
 * - anything else is refused by name.
 *
 * Leaving a relative import in place is not an option: a module inside a bundle
 * has no resolver behind it, so the emitted code parses and then dies with
 * "Cannot find module './MadaraApi'".
 */
function transpiledEntry(text: string, name: string): string {
	const refused: string[] = [];
	for (const match of text.matchAll(
		/^[ \t]*import\s+(?!type\b)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/gm
	)) {
		const specifier = match[1];
		if (!specifier.startsWith('@mana-app/types')) refused.push(specifier);
	}

	const relative = refused.filter((one) => one.startsWith('.'));
	if (relative.length > 0) {
		throw new ForeignFormatError(
			`"${name}" is published as source and imports ${relative
				.map((one) => `"${one}"`)
				.join(', ')}. This build reads a single file, so the helpers it expects are not in ` +
				'the bundle.',
			['relativeModuleImports']
		);
	}
	if (refused.length > 0) {
		throw new ForeignFormatError(
			`"${name}" is published as source and imports ${refused
				.map((one) => `"${one}"`)
				.join(', ')}, which a converted bundle cannot resolve.`,
			['packageImports']
		);
	}

	return stripTypescript(text, (specifier) =>
		specifier.startsWith('@mana-app/types') ? '__manaTypes' : null
	).code;
}

/** What a stripped module still declares, for a caller that needs to find it. */
export interface StrippedModule {
	readonly code: string;
	/** Every name the file exported, for a caller assembling several of them. */
	readonly exports: readonly string[];
	/** The name behind `export default`, or null. */
	readonly defaultName: string | null;
}

const DECLARATORS = new Set(['const', 'let', 'var']);
const MEMBER_MODIFIERS = new Set([
	'public',
	'private',
	'protected',
	'readonly',
	'override',
	'abstract',
	'declare'
]);
/** Type-position words that end the member a modifier belongs to. */
const CLASS_KEYWORDS = new Set(['class', 'interface', 'function']);

/**
 * Removes TypeScript's type syntax, keeping every value.
 *
 * ## Why a scanner and not a regex
 *
 * The syntax is contextual. `:` is a type in `getContent(id: string):
 * Promise<Content>` and an object key in `{ id: 'x' }`, and a pattern that
 * strips colons strips both — producing a bundle that loads and returns
 * `undefined`. So the file is walked once, tracking strings, templates,
 * comments and regexes, and a colon is removed only where the construct around
 * it says a type can appear: a parameter list, a class member, a declarator, a
 * return position, an optional marker.
 *
 * Where a construct is not recognised it is **refused**, never guessed at: an
 * `enum` (a value), a decorator, a namespace. The failure mode of guessing is a
 * bundle that loads and does the wrong thing, which nobody can see.
 *
 * ## What it deliberately is not
 *
 * Not a compiler. No scope analysis, no downlevelling, no checking; the output
 * is the input with types cut out. `moduleFor` decides what an import of a bare
 * module becomes, and `null` leaves a `__manaRequire` call that fails by name
 * at load.
 */
export function stripTypescript(
	source: string,
	moduleFor: (specifier: string) => string | null = () => null
): StrippedModule {
	const out: string[] = [];
	const names: string[] = [];
	let defaultName: string | null = null;
	cursor = 0;

	/** Open brackets, innermost last, each with what it means here. */
	const stack: { char: string; kind: string }[] = [];
	/** Unresolved ternaries per bracket depth, so `a ? b : c` is not a type. */
	const ternaries: number[] = [0];

	let lastSignificant = '';
	let lastEmitted = '\n';
	/** Set between a `class` keyword and its body brace, however far apart. */
	let classHeader = false;

	const push = (text: string): void => {
		out.push(text);
		if (text.length > 0) {
			const end = text.charAt(text.length - 1);
			if (!/\s/.test(end)) lastSignificant = end === '>' && text.endsWith('=>') ? '>' : end;
			lastEmitted = end;
		}
	};

	const back = (from: number): string => {
		for (let at = from - 1; at >= 0; at -= 1) {
			const char = source.charAt(at);
			if (!/\s/.test(char)) return char;
		}
		return '';
	};

	const forward = (from: number): string => {
		for (let at = from; at < source.length; at += 1) {
			const char = source.charAt(at);
			if (!/\s/.test(char)) return char;
		}
		return '';
	};

	const innermost = (): string => stack[stack.length - 1]?.kind ?? 'top';

	/** The bracket matching the one at `open`, or -1. */
	const matching = (open: number): number => {
		const target = source.charAt(open);
		const close = target === '(' ? ')' : target === '[' ? ']' : '}';
		let depth = 0;
		for (let at = open; at < source.length; at += 1) {
			const char = source.charAt(at);
			if (char === target) depth += 1;
			else if (char === close) {
				depth -= 1;
				if (depth === 0) return at;
			}
		}
		return -1;
	};

	const matchingBack = (close: number): number => {
		const target = source.charAt(close);
		const open = target === ')' ? '(' : target === ']' ? '[' : '{';
		let depth = 0;
		for (let at = close; at >= 0; at -= 1) {
			const char = source.charAt(at);
			if (char === target) depth += 1;
			else if (char === open) {
				depth -= 1;
				if (depth === 0) return at;
			}
		}
		return -1;
	};

	/** Skips a type expression, returning where it stopped. */
	const skipType = (from: number): number => {
		let at = from;
		let depth = 0;
		let started = false;
		while (at < source.length) {
			const char = source.charAt(at);
			if (char === '"' || char === "'" || char === '`') {
				started = true;
				at += 1;
				while (at < source.length && source.charAt(at) !== char) {
					if (source.charAt(at) === '\\') at += 1;
					at += 1;
				}
				at += 1;
				continue;
			}
			if (char === '\n' && depth === 0) return at;
			if (/\s/.test(char)) {
				at += 1;
				continue;
			}
			if (char === '(' || char === '[' || char === '<') depth += 1;
			else if (char === '{') {
				// The first `{` of a type is an object type and belongs to it; a
				// later one is the body of whatever declared the type.
				if (depth === 0 && started) return at;
				depth += 1;
			} else if (char === ')' || char === ']' || char === '}' || char === '>') {
				if (depth === 0) return at;
				depth -= 1;
			} else if (depth === 0 && (char === ',' || char === ';' || char === '=' || char === '\n')) {
				return at;
			} else if (depth === 0 && char === '|' && source.charAt(at + 1) === '|') return at;
			else if (depth === 0 && char === '&' && source.charAt(at + 1) === '&') return at;
			started = true;
			at += 1;
		}
		return at;
	};

	/** `(` is a parameter list when what surrounds it says so. */
	const parenKind = (at: number): string => {
		const before = back(at);
		const word = /([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(source.slice(Math.max(0, at - 64), at));
		const keyword = word === null ? '' : word[1];
		const close = matching(at);
		const after = close < 0 ? '' : forward(close + 1);

		// `() =>`, which is an arrow with no parameters.
		if (forward(at + 1) === ')') {
			const beyond = forward(source.indexOf(')', at) + 1);
			if (beyond === '=') return 'params';
		}
		// A declaration's parameter list is followed by its body, its return
		// type, or an arrow. A call is followed by none of those.
		if (after === '{' || after === ':' || after === '=') return 'params';
		if (before === '=' || before === '(' || before === ',' || before === '>' || before === ':') {
			return 'params';
		}
		if (keyword === 'if' || keyword === 'for' || keyword === 'while' || keyword === 'switch') {
			return 'control';
		}
		if (keyword === 'catch' || keyword === 'constructor') return 'params';
		if (keyword === 'return' || keyword === 'typeof' || keyword === 'await') return 'call';
		// `function name(` — the name after the keyword is still a declaration.
		if (
			/(?:^|[^\w$])function\s*$/.test(
				source.slice(Math.max(0, at - keyword.length - 24), at - keyword.length)
			)
		) {
			return 'params';
		}
		// A name directly before a `(` at class level is a method's name.
		if (innermost() === 'class' && keyword.length > 0) return 'params';
		if (keyword === 'function' || keyword === '') return 'params';
		return 'call';
	};

	const colonIsType = (at: number): boolean => {
		if (back(at) === '?') return true;
		if ((ternaries[stack.length] ?? 0) > 0) return false;

		const kind = innermost();
		if (kind === 'params' || kind === 'class') return true;

		// `): T {` — a return position, so the close of a parameter list.
		if (back(at) === ')') {
			const close = source.lastIndexOf(')', at - 1);
			const open = close < 0 ? -1 : matchingBack(close);
			if (open >= 0 && parenKind(open) === 'params') return true;
		}

		// A declarator, possibly through a destructuring pattern.
		let at2 = at - 1;
		let guard = 0;
		while (at2 >= 0 && guard < 512) {
			guard += 1;
			const char = source.charAt(at2);
			if (char === ')' || char === ']' || char === '}') {
				const open = matchingBack(at2);
				if (open < 0) return false;
				at2 = open - 1;
				continue;
			}
			if (char === '=' || char === ';' || char === '\n') return false;
			const word = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(
				source.slice(Math.max(0, at2 - 48), at2 + 1)
			);
			if (word !== null && DECLARATORS.has(word[1])) return true;
			at2 -= 1;
		}
		return false;
	};

	/** True when the `<` at `at` opens a generic list rather than a comparison. */
	const genericList = (at: number): number => {
		const before = back(at);
		if (!/[A-Za-z0-9_$)\]]/.test(before)) return -1;
		let depth = 0;
		for (let scan = at; scan < source.length; scan += 1) {
			const char = source.charAt(scan);
			if (char === '<') depth += 1;
			else if (char === '>') {
				depth -= 1;
				if (depth === 0) {
					const after = forward(scan + 1);
					if (after !== '(' && after !== '{' && after !== '[') return -1;
					const inside = source.slice(at + 1, scan);
					if (inside.length === 0 || inside.length > 240) return -1;
					return /&&|\|\||[;=]|\n/.test(inside) ? -1 : scan;
				}
			} else if (char === ';' || char === '\n' || char === ')' || char === '=') return -1;
		}
		return -1;
	};

	/** The index just past a statement whose body is a *type*, semicolon or not. */
	const typeStatementEnd = (from: number): number => {
		let at = from;
		let depth = 0;
		while (at < source.length) {
			const char = source.charAt(at);
			if (char === '"' || char === "'" || char === '`') {
				at += 1;
				while (at < source.length && source.charAt(at) !== char) {
					if (source.charAt(at) === '\\') at += 1;
					at += 1;
				}
			} else if (char === '(' || char === '[' || char === '{') depth += 1;
			else if (char === ')' || char === ']' || char === '}') depth -= 1;
			else if (depth === 0 && (char === ';' || char === '\n')) {
				// A union or an intersection continues on the next line, so a
				// line ending in one is not the end of the declaration.
				const before = source.slice(0, at).trimEnd();
				const next = source
					.slice(at + 1)
					.trimStart()
					.charAt(0);
				if (char === ';') return at + 1;
				if (/[|&=,([<{]/.test(before.charAt(before.length - 1))) continue;
				if (next === '|' || next === '&' || next === '}') {
					at += 1;
					continue;
				}
				return at + 1;
			}
			at += 1;
		}
		return at;
	};

	/** The index just past the statement starting at `from`. */
	const statementEnd = (from: number): number => {
		let at = from;
		let depth = 0;
		while (at < source.length) {
			const char = source.charAt(at);
			if (char === '"' || char === "'" || char === '`') {
				at += 1;
				while (at < source.length && source.charAt(at) !== char) {
					if (source.charAt(at) === '\\') at += 1;
					at += 1;
				}
			} else if (char === '(' || char === '[' || char === '{') depth += 1;
			else if (char === ')' || char === ']' || char === '}') depth -= 1;
			else if (char === ';' && depth === 0) return at + 1;
			else if (char === '\n' && depth === 0) return at + 1;
			at += 1;
		}
		return at;
	};

	const importStatement = (from: number, text: string): number => {
		const whole = /^import\s+(type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]\s*;?/.exec(text);
		const bare = /^import\s+['"]([^'"]+)['"]\s*;?/.exec(text);
		if (whole === null && bare === null) {
			throw new ForeignFormatError('This source has an import this reader cannot parse.', [
				'importShape'
			]);
		}
		const length = whole?.[0].length ?? bare?.[0].length ?? 0;
		const end = from + length;
		if (whole?.[1] !== undefined) return end;

		const specifier = whole?.[3] ?? bare?.[1] ?? '';
		// The expression the module is reached by: an object for a package this
		// build supplies, a call for one the runtime registry holds.
		const target = moduleFor(specifier) ?? `__manaRequire(${JSON.stringify(specifier)})`;
		const clause = (whole?.[2] ?? '').trim();
		if (clause.length === 0) {
			push(`${target};`);
			return end;
		}

		const parts: string[] = [];
		const namespace = /\*\s*as\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(clause);
		if (namespace !== null) parts.push(`const ${namespace[1]} = ${target};`);
		const defaulted = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:,|$)/.exec(clause);
		if (defaulted !== null && namespace === null) {
			parts.push(`const ${defaulted[1]} = ${target}.default;`);
		}
		const named = /\{([^}]*)\}/.exec(clause);
		if (named !== null) {
			// An import renames with `as`; a destructuring renames with `:`, and
			// the two spellings are not interchangeable.
			const fields = named[1]
				.split(',')
				.map((one) => one.trim().replace(/^type\s+/, ''))
				.filter((one) => one.length > 0)
				.map((one) => one.replace(/\s+as\s+/, ': '));
			if (fields.length > 0) parts.push(`const { ${fields.join(', ')} } = ${target};`);
		}
		push(parts.join(' '));
		return end;
	};

	const exportStatement = (from: number, text: string): number => {
		const defaultDeclaration = /^export\s+default\s+/.exec(text);
		if (defaultDeclaration !== null) {
			const declaration =
				/^(?:async\s+)?(?:abstract\s+)?(class|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
					text.slice(defaultDeclaration[0].length)
				);
			if (declaration !== null) {
				defaultName = declaration[2];
				names.push(declaration[2]);
				return from + defaultDeclaration[0].length;
			}
			const reference = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*;?/.exec(
				text.slice(defaultDeclaration[0].length)
			);
			if (reference === null) {
				throw new ForeignFormatError('This source has a default export this reader cannot read.', [
					'exportShape'
				]);
			}
			defaultName = reference[1];
			return from + defaultDeclaration[0].length;
		}

		// `export type …` and `export interface …` carry nothing at runtime.
		if (/^export\s+type\b/.test(text)) return typeStatementEnd(from);
		if (/^export\s+interface\b/.test(text)) return statementEnd(from);

		const named = /^export\s*\{([^}]*)\}\s*(?:from\s*['"][^'"]*['"])?\s*;?/.exec(text);
		if (named !== null) {
			for (const one of named[1].split(',')) {
				const name = one
					.trim()
					.split(/\s+as\s+/)
					.pop();
				if (name !== undefined && name.length > 0) names.push(name);
			}
			return from + named[0].length;
		}
		if (/^export\s+\*/.test(text)) {
			throw new ForeignFormatError('This source re-exports another module wholesale.', [
				'exportStar'
			]);
		}

		const declaration =
			/^export\s+(?:abstract\s+)?(?:async\s+)?(class|function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
				text
			);
		if (declaration !== null) {
			names.push(declaration[2]);
			return from + 'export '.length;
		}
		// A declaration keyword outside the four — `export default` aside.
		return from + 'export '.length;
	};

	while (out.length >= 0) {
		if (iAt() >= source.length) break;
		const at = iAt();
		const char = source.charAt(at);

		if (char === '"' || char === "'" || char === '`') {
			let scan = at + 1;
			while (scan < source.length && source.charAt(scan) !== char) {
				if (source.charAt(scan) === '\\') scan += 1;
				scan += 1;
			}
			push(source.slice(at, scan + 1));
			iSet(scan + 1);
			continue;
		}
		if (char === '/' && source.charAt(at + 1) === '/') {
			const end = source.indexOf('\n', at);
			const stop = end < 0 ? source.length : end;
			const line = source.slice(at, stop);
			// `/// <reference path="…" />` is a directive, not a note.
			if (!line.startsWith('///')) push(line);
			iSet(stop);
			continue;
		}
		if (char === '/' && source.charAt(at + 1) === '*') {
			const end = source.indexOf('*/', at + 2);
			const stop = end < 0 ? source.length : end + 2;
			push(source.slice(at, stop));
			iSet(stop);
			continue;
		}
		// A regex literal, told from division by what came before it: an
		// operator or an opening bracket can start one, a value cannot.
		if (char === '/' && /[=(,[:!&|?{};>+\-*%^~]|return/.test(lastSignificant || ';')) {
			let scan = at + 1;
			let inClass = false;
			while (scan < source.length) {
				const inner = source.charAt(scan);
				if (inner === '\\') {
					scan += 2;
					continue;
				}
				if (inner === '[') inClass = true;
				else if (inner === ']') inClass = false;
				else if (inner === '/' && !inClass) break;
				else if (inner === '\n') break;
				scan += 1;
			}
			if (source.charAt(scan) === '/') {
				scan += 1;
				while (/[a-z]/i.test(source.charAt(scan))) scan += 1;
				push(source.slice(at, scan));
				iSet(scan);
				continue;
			}
		}
		if (/\s/.test(char)) {
			push(char);
			iSet(at + 1);
			continue;
		}

		const rest = source.slice(at);
		// The start of a line, wherever indentation has already been emitted.
		let lineStart = true;
		for (let back2 = at - 1; back2 >= 0; back2 -= 1) {
			const before = source.charAt(back2);
			if (before === '\n') break;
			if (!/\s/.test(before)) {
				lineStart = false;
				break;
			}
		}

		if (lineStart) {
			const declaration = /^(export\s+)?(declare\s+)?(interface|type|namespace|module|enum)\b/.exec(
				rest
			);
			// `type:` as an object key is not a declaration; the keyword needs a
			// name after it.
			const isDeclaration =
				declaration !== null && !(declaration[3] === 'type' && !/^type\s+[A-Za-z_$]/.test(rest));
			if (isDeclaration && declaration !== null) {
				if (declaration[3] === 'enum') {
					throw new ForeignFormatError(
						'This source declares an enum. An enum is a value, not a type, and the single-file ' +
							'reader does not compile one.',
						['typescriptEnum']
					);
				}
				if (declaration[3] === 'namespace' || declaration[3] === 'module') {
					throw new ForeignFormatError(
						`This source declares a ${declaration[3]}, and the single-file reader cannot erase one.`,
						[`typescript${declaration[3]}`]
					);
				}
				iSet(declaration[3] === 'type' ? typeStatementEnd(at) : statementEnd(at));
				lastSignificant = ';';
				continue;
			}
			if (/^@[A-Za-z_$]/.test(rest)) {
				throw new ForeignFormatError(
					'This source uses a decorator, which the single-file reader does not compile.',
					['typescriptDecorator']
				);
			}
			// `declare const x: T` has no value; the whole statement goes.
			if (/^(?:export\s+)?declare\b/.test(rest)) {
				iSet(typeStatementEnd(at));
				continue;
			}
			if (/^import\b/.test(rest)) {
				iSet(importStatement(at, rest));
				continue;
			}
			if (/^export\b/.test(rest)) {
				iSet(exportStatement(at, rest));
				continue;
			}
		}

		// Modifiers carry no runtime meaning except `static`. They appear on
		// class members and as parameter properties.
		const modifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
		if (modifier !== null && MEMBER_MODIFIERS.has(modifier[0])) {
			const after = forward(at + modifier[0].length);
			const inTypePosition =
				innermost() === 'class' || innermost() === 'params' || CLASS_KEYWORDS.has(modifier[0]);
			const nextWord = /^(class|interface|function)$/.test(
				source.slice(at + modifier[0].length, at + modifier[0].length + 12).trim()
			);
			if (
				inTypePosition &&
				(nextWord || (after !== '(' && after !== ':' && after !== '=' && after !== ';'))
			) {
				push(' ');
				iSet(at + modifier[0].length);
				continue;
			}
		}

		// An `implements` clause names types only, and runs to the body brace.
		if (
			rest.startsWith('implements') &&
			!/[A-Za-z0-9_$]/.test(source.charAt(at + 'implements'.length))
		) {
			let scan = at + 'implements'.length;
			let angle = 0;
			while (scan < source.length) {
				const char = source.charAt(scan);
				if (char === '<') angle += 1;
				else if (char === '>') angle -= 1;
				else if (char === '{' && angle === 0) break;
				scan += 1;
			}
			push(' ');
			iSet(scan);
			continue;
		}

		// A non-null assertion: `x!` before the next thing, not `!` before a value.
		if (char === '!' && !['!', '='].includes(source.charAt(at + 1))) {
			const after = forward(at + 1);
			if (
				/[A-Za-z0-9_$)\]}'"`]/.test(lastSignificant) &&
				['.', ')', ',', ';', ']', '}', ':', '=', '?', ''].includes(after)
			) {
				iSet(at + 1);
				continue;
			}
		}

		// `x as T` and `x satisfies T` — the type is dropped, the value kept.
		if (
			(char === 'a' && rest.startsWith('as ')) ||
			(char === 's' && rest.startsWith('satisfies '))
		) {
			if (rest.startsWith(char === 'a' ? 'as' : 'satisfies')) {
				iSet(skipType(at + (char === 'a' ? 2 : 9)));
				continue;
			}
		}

		if (char === '<') {
			const close = genericList(at);
			if (close > 0) {
				iSet(close + 1);
				continue;
			}
		}

		if (char === ':') {
			if (colonIsType(at)) {
				iSet(skipType(at + 1));
				continue;
			}
			push(char);
			iSet(at + 1);
			continue;
		}

		if (char === '?') {
			const after = forward(at + 1);
			// `a?: T` is an optional marker, which JavaScript does not have; the
			// colon that follows is stripped as the type anyway.
			if (after === ':') {
				iSet(at + 1);
				continue;
			}
			if (after !== '.' && after !== '[' && after !== '?') {
				ternaries[stack.length] = (ternaries[stack.length] ?? 0) + 1;
			} else if (after === '[' && /\s/.test(source.charAt(at + 1))) {
				// `a?[b]` indexes optionally; `a ? [b]` is a ternary whose second
				// branch is an array, and only the spacing tells them apart.
				ternaries[stack.length] = (ternaries[stack.length] ?? 0) + 1;
			}
			push(char);
			iSet(at + 1);
			continue;
		}

		if (char === '=' && source.charAt(at + 1) === '>') {
			push('=>');
			lastSignificant = '>';
			iSet(at + 2);
			continue;
		}

		// A `class` keyword opens a header that ends at its body brace.
		if (char === 'c' && rest.startsWith('class') && !/[A-Za-z0-9_$]/.test(source.charAt(at + 5))) {
			classHeader = true;
		}

		if (char === '(' || char === '[' || char === '{') {
			let kind = char === '(' ? parenKind(at) : 'index';
			if (char === '{') {
				// A class body, versus every other brace. A heritage or
				// `implements` clause can sit between the name and the brace, and
				// may wrap lines, so a flag carries over instead of the line text.
				kind = classHeader ? 'class' : 'block';
				classHeader = false;
			}
			stack.push({ char, kind });
			ternaries[stack.length] = 0;
			push(char);
			iSet(at + 1);
			continue;
		}
		if (char === ')' || char === ']' || char === '}') {
			stack.pop();
			// Not reset here: a ternary opened in the outer depth is still open
			// across a call inside it — `a ? f(x) : y` — and clearing the outer
			// count when the call's paren closes made the `:` look like a type.
			push(char);
			iSet(at + 1);
			continue;
		}

		push(char);
		iSet(at + 1);
	}

	return { code: out.join(''), exports: names, defaultName };

	// `i` is threaded through these two so the loop body can `continue`.
	function iAt(): number {
		return cursor;
	}
	function iSet(value: number): void {
		cursor = value;
	}
}

/** The scanner's position. Hoisted so the loop body can move it and `continue`. */
let cursor = 0;
