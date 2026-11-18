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
import { walkRepositoryModules } from '@plugin-bridge/core/repository-modules';
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
		// Both a tracker and a row that cannot be identified are counted rather
		// than dropped in silence — a row that vanishes is indistinguishable
		// from a parser that lost it.
		let trackers = 0;
		let skipped = 0;

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

			try {
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
			} catch {
				// `convertedPluginId` refuses an id with nothing usable in it. One
				// such row is not a reason to lose the rest of the catalogue.
				skipped += 1;
			}
		}

		const kept = keepMediums({
			name: String(document?.['repositoryName'] ?? 'Mana sources'),
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'mana'
		});
		return { ...kept, filteredOut: (kept.filteredOut ?? 0) + trackers + skipped };
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
		let textUrl = origin.artifactUrl;
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
				textUrl = candidate;
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

		// Every file the bundle carries is scanned for hosts, not just the entry:
		// a template three directories away is where the API address usually is.
		let scanned = [text];
		let script = text;
		if (!built) {
			const linked = await linkedSource(
				text,
				textUrl,
				String(detail['path'] ?? ''),
				listing.name,
				services
			);
			script = linked.script;
			scanned = linked.sources;
		}
		const hosts = [
			...new Set([
				...listing.hosts,
				...scanned.flatMap((one) => [...hostsInSource(one), ...hostsInEncoded(one)])
			])
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

/** The source layouts a row's path is read at, as `artifactCandidates` spells them. */
const SOURCE_LAYOUTS = [
	(path: string) => `src/sources/${path}/index.ts`,
	(path: string) => `src/${path}/main.ts`,
	(path: string) => `src/${path}/index.ts`
];

/**
 * The repository an entry file was read from: its URL with the layout removed.
 *
 * Recovered from the URL rather than stored on the listing, because the layout
 * is one of three fixed spellings of the row's own path, and so a listing
 * stored before this existed reads the same root.
 */
function sourceRoot(entryUrl: string, path: string): string | null {
	for (const layout of SOURCE_LAYOUTS) {
		const suffix = layout(path);
		if (path.length > 0 && entryUrl.endsWith(`/${suffix}`)) {
			return entryUrl.slice(0, entryUrl.length - suffix.length);
		}
	}
	return null;
}

/** Imports that carry a value: not `import type`, not a list of types only. */
function valueImports(source: string): { specifier: string; statement: string }[] {
	const found: { specifier: string; statement: string }[] = [];
	for (const match of source.matchAll(
		/^[ \t]*(?:import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]|^[ \t]*import\s*['"]([^'"]+)['"]/gm
	)) {
		if (match[4] !== undefined) {
			found.push({ specifier: match[4], statement: match[0] });
			continue;
		}
		if (match[1] !== undefined) continue;
		const clause = match[2].trim();
		// `import { type A, type B }` is as empty at runtime as `import type`.
		const list = /^\{([^}]*)\}$/.exec(clause);
		if (
			list !== null &&
			list[1]
				.split(',')
				.map((one) => one.trim())
				.filter((one) => one.length > 0)
				.every((one) => /^type\s/.test(one))
		) {
			continue;
		}
		found.push({ specifier: match[3], statement: match[0] });
	}
	// A CommonJS `require('x')` reaches a module as surely as an import does,
	// and one left in a bundle fails at load rather than at conversion.
	for (const match of source.matchAll(
		/(?:^|[^A-Za-z0-9_$.])require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm
	)) {
		found.push({ specifier: match[1], statement: match[0] });
	}
	return found;
}

/**
 * Where a TypeScript specifier may be read, best first.
 *
 * This ecosystem writes `../../lib/client.ts`, `../lib/books` and, once in a
 * while, `./x.js` for a file that is `x.ts` — the three conventions a bundler
 * resolves. Nothing past those: a specifier that names no file under any of
 * them is missing, and refused as such.
 */
function typescriptCandidates(resolved: string): string[] {
	if (/\.ts$/.test(resolved)) return [resolved];
	if (/\.js$/.test(resolved)) return [resolved.replace(/\.js$/, '.ts'), resolved];
	return [`${resolved}.ts`, `${resolved}/index.ts`, `${resolved}.js`, `${resolved}/index.js`];
}

/**
 * How many sibling modules one source may carry, and how deep they may nest.
 *
 * Measured: the largest closure in the corpus is 25 files, three levels deep,
 * from a repository whose sources all extend one shared template. The bound is
 * above that with room, and below anything that would make one conversion an
 * unreasonable number of requests.
 */
const MAX_SOURCE_MODULES = 40;
const MAX_SOURCE_DEPTH = 6;

/**
 * The source path: a TypeScript entry file and every sibling it imports, made
 * runnable as one script.
 *
 * Only reached for a repository with no build output. The entry is the row's
 * `main.ts` or `index.ts`; what it imports from its own repository — the
 * template it extends, a client, a parser — is fetched with the same walker the
 * Hayase adapter uses, and each module is stripped and wrapped in a function
 * that returns its exports. Deepest first, so a module exists before whatever
 * reads it. An import becomes a destructure of that module's object; the entry
 * runs last, unwrapped, so its `Target` is what the shim finds.
 *
 * Every import is still inspected rather than guessed:
 *
 * - `@mana-app/types` becomes the shim's module, because that package is a
 *   *types* package and exists at runtime only as the few enums and the HTTP
 *   client the published build would have baked in;
 * - a relative import that cannot be read, climbs out of the repository, closes
 *   a cycle or lies past the bound is refused by name — a module inside a
 *   bundle has no resolver behind it, and a missing one parses and then dies
 *   with "Cannot find module" at the first call;
 * - any other bare module, anywhere in the closure, is refused by name.
 */
async function linkedSource(
	text: string,
	entryUrl: string,
	path: string,
	name: string,
	services: ConversionServices
): Promise<{ script: string; sources: string[] }> {
	const relativeOf = (source: string): string[] =>
		valueImports(source)
			.map((one) => one.specifier)
			.filter((one) => one.startsWith('.'));

	const root = sourceRoot(entryUrl, path);
	const entryRelative = relativeOf(text);
	if (root === null && entryRelative.length > 0) {
		throw new ForeignFormatError(
			`"${name}" is published as source and imports ${entryRelative
				.map((one) => `"${one}"`)
				.join(', ')}, from a file at no layout this format uses, so where its repository ` +
				'begins is unknown.',
			['relativeModuleImports']
		);
	}

	const walk = await walkRepositoryModules(
		{ source: text, url: entryUrl },
		{
			root: root ?? entryUrl,
			getText: services.getText,
			specifiers: relativeOf,
			candidates: typescriptCandidates,
			maxModules: MAX_SOURCE_MODULES,
			maxDepth: MAX_SOURCE_DEPTH
		}
	);

	const quoted = (list: readonly { specifier: string }[]): string =>
		[...new Set(list.map((one) => `"${one.specifier}"`))].join(', ');
	if (walk.escaped.length > 0) {
		throw new ForeignFormatError(
			`"${name}" imports ${quoted(walk.escaped)}, which resolves outside its own repository. ` +
				'Code is read only from the repository the listing came from.',
			['relativeModuleEscapes']
		);
	}
	if (walk.missing.length > 0) {
		throw new ForeignFormatError(
			`"${name}" imports ${quoted(walk.missing)}, and no file at that path could be read from ` +
				'its repository.',
			['relativeModuleMissing']
		);
	}
	if (walk.cycles.length > 0) {
		throw new ForeignFormatError(
			`"${name}" has modules that import each other (${quoted(walk.cycles)}). A cycle needs ` +
				'live bindings, which a bundle linked in dependency order does not have.',
			['relativeModuleCycle']
		);
	}
	if (walk.truncated) {
		throw new ForeignFormatError(
			`"${name}" imports more of its repository than one conversion reads ` +
				`(${MAX_SOURCE_MODULES} files, ${MAX_SOURCE_DEPTH} levels deep).`,
			['relativeModuleBound']
		);
	}

	const sources = [...walk.modules.map((one) => one.source), text];
	const bare = [
		...new Set(
			sources.flatMap((one) =>
				valueImports(one)
					.map((found) => found.specifier)
					.filter((found) => !found.startsWith('.') && !found.startsWith('@mana-app/types'))
			)
		)
	];
	if (bare.length > 0) {
		throw new ForeignFormatError(
			`"${name}" is published as source and imports ${bare
				.map((one) => `"${one}"`)
				.join(', ')}, which a converted bundle cannot resolve.`,
			['packageImports']
		);
	}

	const variables = new Map<string, string>(
		walk.modules.map((one, index) => [one.url, `__manaModule${index}`])
	);
	const linker = (imports: Readonly<Record<string, string>>) => (specifier: string) => {
		if (specifier.startsWith('@mana-app/types')) return '__manaTypes';
		if (!specifier.startsWith('.')) return null;
		const url = imports[specifier];
		const variable = url === undefined ? undefined : variables.get(url);
		// Only a type-only import reaches here unwalked, and the stripper drops
		// those before asking; anything else is a linker bug, refused loudly.
		if (variable === undefined) {
			throw new ForeignFormatError(
				`"${name}" imports "${specifier}", which this build read but could not link.`,
				['relativeModuleImports']
			);
		}
		return variable;
	};

	const wrapped = walk.modules.map((one, index) => {
		const stripped = stripTypescript(one.source, linker(one.imports));
		// A bare local is read through `typeof`: `export { Options }` may name
		// an interface, which has no value, and reading one would throw at load
		// over something no caller can use anyway.
		const own = stripped.bindings
			.map((binding) => {
				const value = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding.local)
					? `typeof ${binding.local} === 'undefined' ? undefined : ${binding.local}`
					: binding.local;
				return `${JSON.stringify(binding.exported)}: ${value}`;
			})
			.join(', ');
		return (
			`/* ${one.specifier} */\nvar __manaModule${index} = (function () {\n${stripped.code}\n` +
			`return __manaLink([${stripped.spread.join(', ')}], { ${own} });\n})();`
		);
	});
	const entry = stripTypescript(text, linker(walk.entryImports));
	const script =
		walk.modules.length === 0 ? entry.code : `${MANA_LINK}\n${wrapped.join('\n')}\n${entry.code}`;
	return { script, sources };
}

/**
 * What a linked module returns: everything it re-exported wholesale, then its
 * own exports over them. `default` is never carried by `export *`, as in ES.
 */
const MANA_LINK = `function __manaLink(spread, own) {
  var all = {};
  for (var i = 0; i < spread.length; i++) {
    for (var key in spread[i]) if (key !== 'default') all[key] = spread[i][key];
  }
  for (var name in own) all[name] = own[name];
  return all;
}`;

/** What a stripped module still declares, for a caller that needs to find it. */
export interface StrippedModule {
	readonly code: string;
	/** Every name the file exported, for a caller assembling several of them. */
	readonly exports: readonly string[];
	/** The name behind `export default`, or null. */
	readonly defaultName: string | null;
	/**
	 * Each export as the expression that reads it, for a linker: a local name,
	 * or `<module>.<member>` for one re-exported from a module `moduleFor`
	 * named. `default` is spelled as such.
	 */
	readonly bindings: readonly { readonly exported: string; readonly local: string }[];
	/** Modules re-exported wholesale (`export * from`), as `moduleFor` named them. */
	readonly spread: readonly string[];
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
/** Text ending in a keyword that is followed by an operand, never by an operator. */
const AFTER_KEYWORD =
	/(?:^|[^A-Za-z0-9_$.])(?:return|typeof|case|in|of|void|throw|delete|yield|await|else|do)\s*$/;
/** A type so far that still needs an operand: a union, an intersection, an operator. */
const TYPE_OPERAND = /(?:[|&]|(?:^|[^A-Za-z0-9_$])(?:readonly|keyof|typeof|unique))$/;
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
	const bindings: { exported: string; local: string }[] = [];
	const spread: string[] = [];
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
			// A function type's arrow is one token, and its `>` closes nothing.
			// Inside brackets it is always the type's; at the top it is the
			// type's only after a parameter list — `(a: T): R => …` is an arrow
			// function whose return type ended at `R`.
			if (char === '=' && source.charAt(at + 1) === '>') {
				if (depth > 0 || source.slice(from, at).trimEnd().endsWith(')')) {
					started = true;
					at += 2;
					continue;
				}
				return at;
			}
			if (char === '(' || char === '[' || char === '<') depth += 1;
			else if (char === '{') {
				// The first `{` of a type is an object type and belongs to it; a
				// later one is the body of whatever declared the type.
				// …unless the type is still asking for an operand: `A | { b }`,
				// `A & { b }` and `readonly { b }[]` are each one type, and the
				// brace is the rest of it.
				if (depth === 0 && started && !TYPE_OPERAND.test(source.slice(from, at).trimEnd())) {
					return at;
				}
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
			// A string is skipped whole: `{ id: "letter", title: … }` holds the
			// letters `let`, and they declare nothing.
			if (char === '"' || char === "'" || char === '`') {
				let open = at2 - 1;
				while (open >= 0 && !(source.charAt(open) === char && source.charAt(open - 1) !== '\\')) {
					open -= 1;
				}
				if (open < 0) return false;
				at2 = open - 1;
				continue;
			}
			if (char === '=' || char === ';' || char === '\n') return false;
			// …and a declarator is a whole word, not the start of `letters`.
			if (!/[A-Za-z0-9_$]/.test(source.charAt(at2 + 1))) {
				const word = /([A-Za-z_$][A-Za-z0-9_$]*)\s*$/.exec(
					source.slice(Math.max(0, at2 - 48), at2 + 1)
				);
				if (word !== null && DECLARATORS.has(word[1])) return true;
			}
			at2 -= 1;
		}
		return false;
	};

	/** True when the `<` at `at` opens a generic list rather than a comparison. */
	const genericList = (at: number): number => {
		const before = back(at);
		if (!/[A-Za-z0-9_$)\]]/.test(before)) return -1;
		let depth = 0;
		let parens = 0;
		/** What the list holds, with object types and arrows taken out. */
		let flat = '';
		for (let scan = at; scan < source.length; scan += 1) {
			const char = source.charAt(scan);
			// An object type is opaque here: `Map<string, { at: number; v: T }>`
			// has a `;` and maybe a newline that say nothing about the list.
			if (char === '{') {
				const close = matching(scan);
				if (close < 0) return -1;
				scan = close;
				continue;
			}
			// A function type's arrow is one token; its `>` closes nothing.
			if (char === '=' && source.charAt(scan + 1) === '>') {
				scan += 1;
				continue;
			}
			if (char === '(') parens += 1;
			else if (char === ')') {
				if (parens === 0) return -1;
				parens -= 1;
			} else if (char === '<') depth += 1;
			else if (char === '>') {
				depth -= 1;
				if (depth === 0) {
					const after = forward(scan + 1);
					if (after !== '(' && after !== '{' && after !== '[') return -1;
					const inside = source.slice(at + 1, scan);
					if (inside.length === 0 || inside.length > 240) return -1;
					return /&&|\|\||[;=]|\n/.test(flat) ? -1 : scan;
				}
			} else if (char === ';' || char === '\n' || char === '=') return -1;
			if (scan > at) flat += char;
		}
		return -1;
	};

	/** The index just past a statement whose body is a *type*, semicolon or not. */
	const typeStatementEnd = (from: number): number => {
		let at = from;
		let depth = 0;
		while (at < source.length) {
			const char = source.charAt(at);
			// A comment is opaque: its text is prose, and a line break inside a
			// block comment between two union members is not the end of the type.
			if (char === '/' && source.charAt(at + 1) === '*') {
				const end = source.indexOf('*/', at + 2);
				at = end < 0 ? source.length : end + 2;
				continue;
			}
			if (char === '/' && source.charAt(at + 1) === '/') {
				const end = source.indexOf('\n', at);
				at = end < 0 ? source.length : end;
				continue;
			}
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
				// The next thing that is not a comment: a union member may be
				// documented on the lines above it.
				const next = source
					.slice(at + 1)
					.replace(/^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/, '')
					.charAt(0);
				if (char === ';') return at + 1;
				if (/[|&=,([<{]/.test(before.charAt(before.length - 1))) {
					at += 1;
					continue;
				}
				// …and so does a line that closes a generic opened above it:
				// `Pick<\n  Model,\n  "a" | "b"\n>;`.
				if (next === '|' || next === '&' || next === '}' || next === '>') {
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
			// the two spellings are not interchangeable. A `type` field names
			// nothing at runtime and is dropped, so a list of nothing but types
			// imports nothing — as TypeScript itself elides it — rather than
			// reaching for a module that may not be there.
			const fields = named[1]
				.split(',')
				.map((one) => one.trim())
				.filter((one) => one.length > 0 && !/^type\s/.test(one))
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
				bindings.push({ exported: 'default', local: declaration[2] });
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
			bindings.push({ exported: 'default', local: reference[1] });
			return from + defaultDeclaration[0].length;
		}

		// `export type …` and `export interface …` carry nothing at runtime.
		if (/^export\s+type\b/.test(text)) return typeStatementEnd(from);
		if (/^export\s+interface\b/.test(text)) return statementEnd(from);

		const named = /^export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]*)['"])?\s*;?/.exec(text);
		if (named !== null) {
			// Re-exported from elsewhere, the value is that module's member, and
			// it is reached through the module rather than as a local name the
			// file never declared.
			const origin =
				named[2] === undefined
					? null
					: (moduleFor(named[2]) ?? `__manaRequire(${JSON.stringify(named[2])})`);
			for (const one of named[1].split(',')) {
				const field = one.trim();
				if (field.length === 0 || /^type\s/.test(field)) continue;
				const [local, exported = local] = field.split(/\s+as\s+/).map((part) => part.trim());
				names.push(exported);
				bindings.push({ exported, local: origin === null ? local : `${origin}.${local}` });
			}
			return from + named[0].length;
		}
		const star =
			/^export\s*\*\s*(?:as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*)?from\s*['"]([^'"]*)['"]\s*;?/.exec(
				text
			);
		if (star !== null) {
			// Wholesale is only readable when the module behind it is one this
			// build linked, because only then are its members known at runtime.
			const target = moduleFor(star[2]);
			if (target === null) {
				throw new ForeignFormatError('This source re-exports another module wholesale.', [
					'exportStar'
				]);
			}
			if (star[1] !== undefined) {
				names.push(star[1]);
				bindings.push({ exported: star[1], local: target });
			} else {
				spread.push(target);
			}
			return from + star[0].length;
		}
		if (/^export\s+\*/.test(text)) {
			throw new ForeignFormatError('This source re-exports another module wholesale.', [
				'exportStar'
			]);
		}

		const declaration =
			/^export\s+(?:abstract\s+)?(?:async\s+)?(class|function\*?|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(
				text
			);
		if (declaration !== null) {
			names.push(declaration[2]);
			bindings.push({ exported: declaration[2], local: declaration[2] });
			return from + 'export '.length;
		}
		if (/^export\s+(?:const|let|var)\s*[[{]/.test(text)) {
			// A destructuring export declares names only its pattern knows, and a
			// linker that missed one would hand an importer `undefined`.
			throw new ForeignFormatError('This source exports a destructuring declaration.', [
				'exportShape'
			]);
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
		if (
			char === '/' &&
			(/[=(,[:!&|?{};>+\-*%^~]/.test(lastSignificant || ';') ||
				// `lastSignificant` is one character, so a keyword before the
				// regex — `return /^https?:/.test(x)` — read as a value, and the
				// pattern's `?:` as a ternary and a type.
				AFTER_KEYWORD.test(source.slice(Math.max(0, at - 16), at)))
		) {
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
		if (
			modifier !== null &&
			MEMBER_MODIFIERS.has(modifier[0]) &&
			!/[A-Za-z0-9_$.]/.test(source.charAt(at - 1))
		) {
			const after = forward(at + modifier[0].length);
			const inTypePosition =
				innermost() === 'class' || innermost() === 'params' || CLASS_KEYWORDS.has(modifier[0]);
			// `abstract class X`, wherever it stands: anchored as a word, because
			// the twelve characters after the modifier are `class X …`, never
			// `class` alone.
			const nextWord = /^(class|interface|function)\b/.test(
				source.slice(at + modifier[0].length, at + modifier[0].length + 12).trim()
			);
			const isMember = after !== '(' && after !== ':' && after !== '=' && after !== ';';
			// An abstract member is a signature with no body, and a bare
			// `name(): T;` left behind in a class body is a syntax error.
			if (modifier[0] === 'abstract' && innermost() === 'class' && !nextWord && isMember) {
				iSet(typeStatementEnd(at));
				continue;
			}
			if (nextWord || (inTypePosition && isMember)) {
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
			// JavaScript has no infix `!`, so one written hard against a value
			// — `w[i]! + s` — can only be TypeScript's assertion.
			const adjacent =
				/[A-Za-z0-9_$)\]]/.test(source.charAt(at - 1)) &&
				!AFTER_KEYWORD.test(source.slice(Math.max(0, at - 16), at));
			if (
				/[A-Za-z0-9_$)\]}'"`]/.test(lastSignificant) &&
				(adjacent || ['.', ')', ',', ';', ']', '}', ':', '=', '?', ''].includes(after))
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
			// A ternary's colon closes one pending `?`; leaving the count up
			// would make every later colon in the same block look like one too.
			if ((ternaries[stack.length] ?? 0) > 0) ternaries[stack.length] -= 1;
			push(char);
			iSet(at + 1);
			continue;
		}

		// `??` is one operator. Read a character at a time, its second `?`
		// looked like a ternary that never closed, and the next `name: T` in
		// the same block lost its type to it.
		if (char === '?' && source.charAt(at + 1) === '?') {
			push('??');
			iSet(at + 2);
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
			// Optional indexing is spelled `a?.[b]`, so a `?` before `[` opens a
			// ternary however it is spaced — `x?[y]:[]` included, which minified
			// sources write and which used to lose its `: []` as a "type".
			if (after !== '.' && after !== '?') {
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

	return { code: out.join(''), exports: names, defaultName, bindings, spread };

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
