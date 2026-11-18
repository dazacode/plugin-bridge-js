/**
 * The modules an extension imports from its own repository, fetched.
 *
 * Two formats publish an entry file that imports siblings — a Hayase extension
 * splits a helper out, a Mana source extends a template three directories away
 * — and a converted bundle has no resolver behind it, so the siblings have to be
 * read at conversion and carried in. This is the one walker both use. What
 * differs between them is passed in: which statements count as an import, how a
 * specifier with no extension becomes a file, and how far the walk may go.
 *
 * ## What is refused, and why each rule is here
 *
 * - **Only relative specifiers.** A bare one (`node:fs`, a package name) is a
 *   dependency this runtime does not have, and inventing a fetch for it would
 *   turn a named refusal into a mystery at call time. The caller's
 *   `specifiers` decides what is relative; the walker never sees a bare one.
 * - **Only under the repository root.** Resolution is against the importing
 *   module's own URL, and the result must still begin with `root`.
 *   `../../../other/repo/x.js` resolves to a real URL on the same forge, and
 *   fetching it would let one listing pull code from a repository nobody
 *   added — provenance laundering, not a module system. Such a specifier is
 *   reported in `escaped`, never fetched.
 * - **Bounded.** Depth and count are capped, because how many requests one
 *   conversion costs must not be a property of somebody else's repository. A
 *   walk that stopped at the cap says so in `truncated`.
 *
 * Deepest first, so a module is declared before whatever reads it, and each
 * URL appears once however many modules import it. An import of a module that
 * is still being walked is a cycle; it is reported in `cycles`, because the
 * deepest-first order cannot honour one and a caller that links modules by
 * that order must not pretend it can.
 *
 * Nothing here decides whether a gap is fatal. One format converts anyway and
 * lets the missing symbol refuse by its own name; another cannot link a module
 * that is not there and refuses outright. Both read the same report.
 */

import type { TextFetcher } from './adapter';

export interface RepositoryModule {
	/** The specifier as the first module to import it wrote it. */
	readonly specifier: string;
	/** Where it was read from, after extension resolution. */
	readonly url: string;
	readonly source: string;
	/** Each relative specifier this module wrote, to the URL it resolved to. */
	readonly imports: Readonly<Record<string, string>>;
}

export interface RepositoryModuleWalk {
	/** Deepest first. The entry itself is not in it. */
	readonly modules: readonly RepositoryModule[];
	/** Each relative specifier the entry wrote, to the URL it resolved to. */
	readonly entryImports: Readonly<Record<string, string>>;
	/** Specifiers no candidate URL could be read for, with the importer. */
	readonly missing: readonly { readonly specifier: string; readonly from: string }[];
	/** Specifiers that resolved outside `root`, with the importer. */
	readonly escaped: readonly { readonly specifier: string; readonly from: string }[];
	/** Imports of a module that was still being walked, with the importer. */
	readonly cycles: readonly { readonly specifier: string; readonly from: string }[];
	/** True when the count or depth cap stopped the walk short. */
	readonly truncated: boolean;
}

export interface RepositoryModuleOptions {
	/** Everything fetched must begin with this, `https://host/…/`. */
	readonly root: string;
	readonly getText: TextFetcher;
	/** The relative specifiers one module's source imports, in order. */
	readonly specifiers: (source: string) => readonly string[];
	/**
	 * The URLs one resolved specifier may be read at, best first.
	 *
	 * The default is the URL itself, which is right for JavaScript that names its
	 * files. TypeScript habitually writes `./client` for `./client.ts`.
	 */
	readonly candidates?: (resolved: string) => readonly string[];
	readonly maxModules: number;
	readonly maxDepth: number;
}

/** Walks the entry's relative imports, bounded and inside `root`. */
export async function walkRepositoryModules(
	entry: { readonly source: string; readonly url: string },
	options: RepositoryModuleOptions
): Promise<RepositoryModuleWalk> {
	const { root, getText, maxModules, maxDepth } = options;
	const candidates = options.candidates ?? ((resolved: string) => [resolved]);

	/** Resolved specifier URL → the URL it was read from. */
	const readAt = new Map<string, string>([[entry.url, entry.url]]);
	/** Every URL a walk has started on, finished or not. */
	const seen = new Set<string>([entry.url]);
	const finished = new Set<string>();
	const collected: RepositoryModule[] = [];
	const missing: { specifier: string; from: string }[] = [];
	const escaped: { specifier: string; from: string }[] = [];
	const cycles: { specifier: string; from: string }[] = [];
	let truncated = false;

	async function walk(
		source: string,
		base: string,
		depth: number
	): Promise<Record<string, string>> {
		const imports: Record<string, string> = {};
		if (depth > maxDepth) {
			if (options.specifiers(source).length > 0) truncated = true;
			return imports;
		}
		for (const specifier of options.specifiers(source)) {
			if (collected.length >= maxModules) {
				truncated = true;
				return imports;
			}

			let resolved: string;
			try {
				resolved = new URL(specifier, base).toString();
			} catch {
				missing.push({ specifier, from: base });
				continue;
			}
			if (!resolved.startsWith(root)) {
				escaped.push({ specifier, from: base });
				continue;
			}

			const known = readAt.get(resolved);
			if (known !== undefined) {
				imports[specifier] = known;
				if (!finished.has(known)) cycles.push({ specifier, from: base });
				continue;
			}
			if (seen.has(resolved)) continue;
			seen.add(resolved);

			let body: string | null = null;
			let url = resolved;
			for (const candidate of candidates(resolved)) {
				if (!candidate.startsWith(root)) continue;
				try {
					body = await getText(candidate);
					url = candidate;
					break;
				} catch {
					body = null;
				}
			}
			if (body === null) {
				missing.push({ specifier, from: base });
				continue;
			}
			readAt.set(resolved, url);
			imports[specifier] = url;
			if (url !== resolved) {
				// Two spellings of one file — `./client` and `./client.ts` — are one
				// module, read once.
				const other = readAt.get(url);
				if (other !== undefined) {
					imports[specifier] = other;
					if (!finished.has(other)) cycles.push({ specifier, from: base });
					continue;
				}
				readAt.set(url, url);
				seen.add(url);
			}

			const nested = await walk(body, url, depth + 1);
			finished.add(url);
			collected.push({ specifier, url, source: body, imports: nested });
		}
		return imports;
	}

	const entryImports = await walk(entry.source, entry.url, 0);
	return { modules: collected, entryImports, missing, escaped, cycles, truncated };
}
