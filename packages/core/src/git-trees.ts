/**
 * Listing what is in a repository directory, which raw file hosting cannot do.
 *
 * `source-repo.ts` needs to know which `.kt` files sit under a directory before
 * it can fetch them, and it is written to take that as an injected
 * `listFiles`. Nothing has supplied one until now, because the raw hosts
 * `git-hosts.ts` reaches — the ones that serve a file's bytes with a permissive
 * CORS header — have no directory index at all. A forge's own API does.
 *
 * ## Rule 9, and the host this file adds
 *
 * `FOREIGN.md` §0 permits two hosts by name. This adds a third, `api.github.com`,
 * and that is a contract amendment rather than a convenience: §0 is the
 * foundation the whole file rests on, so the host is named there, with the
 * reason, rather than appearing quietly here.
 *
 * It is the same repository the raw host already serves, reached through the
 * only interface that answers "what is in this directory". The alternative was
 * deriving each file's path from the extension's class name and a fixed package
 * prefix, which does not survive the variation in package roots across a real
 * catalogue. The two self-hosted shapes need no new host: their API lives on
 * the origin the pasted repository URL already named.
 *
 * ## One tree per repository, per session
 *
 * A recursive tree is one request and answers every directory in the
 * repository, so it is fetched once and reused. That is not only politeness.
 * `check.ts` will convert several listings from the same repository, and
 * unauthenticated `api.github.com` allows **60 requests an hour per address** —
 * enough to fail partway through checking a repository if each listing fetched
 * its own tree, and to fail in a way that looks like the catalogue is broken
 * rather than like we were rude.
 *
 * ## Truncation is refused, never worked around
 *
 * A forge truncates a large tree and says so. A truncated tree that is treated
 * as complete silently omits the file somebody asked for, and the conversion
 * then refuses a member for being absent rather than for being untranslatable —
 * a wrong reason, which is worse than no answer.
 */

import type { TextFetcher } from './adapter';
import type { FileLister } from './source-repo';
import { parseRepositoryUrl, type GitRepository } from './git-hosts';

/** The forge API host this file adds to the two `FOREIGN.md` §0 already names. */
export const GITHUB_API = 'https://api.github.com';

/**
 * How much of a tree document is worth reading.
 *
 * A recursive tree of a large catalogue is megabytes of JSON. This is well
 * above what any of them need and far below what would be worth holding.
 */
export const MAX_TREE_BYTES = 8 * 1024 * 1024;

/** Raw file URL → the repository, ref and path it addresses. */
export interface RawLocation {
	readonly repository: GitRepository;
	readonly ref: string;
	/** Repository-relative, no leading or trailing slash. */
	readonly path: string;
}

/**
 * Reverses a raw-hosting URL.
 *
 * `source-repo.ts` hands `listFiles` the same kind of URL it fetches files
 * from, because that is the only address it has. Reading it back is what lets
 * one lister serve every forge shape without that module learning any of them.
 */
export function parseRawUrl(url: string): RawLocation | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;

	const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);

	// `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…>`
	if (parsed.host === 'raw.githubusercontent.com') {
		if (segments.length < 3) return null;
		return {
			repository: {
				origin: 'https://github.com',
				owner: segments[0],
				repo: segments[1],
				ref: null
			},
			ref: segments[2],
			path: segments.slice(3).join('/')
		};
	}

	// `<origin>/<owner>/<repo>/raw/branch/<ref>/<path…>` — Gitea and Forgejo.
	const branch = segments.indexOf('raw');
	if (branch >= 2 && segments[branch + 1] === 'branch' && segments.length > branch + 2) {
		return {
			repository: {
				origin: parsed.origin,
				owner: segments[0],
				repo: segments[1],
				ref: null
			},
			ref: segments[branch + 2],
			path: segments.slice(branch + 3).join('/')
		};
	}

	// `<origin>/<owner>/<repo>/-/raw/<ref>/<path…>` — GitLab.
	const dash = segments.indexOf('-');
	if (dash >= 2 && segments[dash + 1] === 'raw' && segments.length > dash + 2) {
		return {
			repository: {
				origin: parsed.origin,
				owner: segments[0],
				repo: segments[1],
				ref: null
			},
			ref: segments[dash + 2],
			path: segments.slice(dash + 3).join('/')
		};
	}

	return null;
}

/** Tree API URLs to try for one repository at one ref, best first. */
export function treeCandidates(repository: GitRepository, ref: string): string[] {
	const { origin, owner, repo } = repository;
	if (origin === 'https://github.com') {
		return [`${GITHUB_API}/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`];
	}
	const project = encodeURIComponent(`${owner}/${repo}`);
	return [
		// Gitea and Forgejo, then GitLab. Both are tried because the origin does
		// not say which software is behind it, and guessing from a hostname
		// would be a list of hostnames.
		`${origin}/api/v1/repos/${owner}/${repo}/git/trees/${ref}?recursive=true`,
		`${origin}/api/v4/projects/${project}/repository/tree?recursive=true&per_page=100&ref=${ref}`
	];
}

export class TreeError extends Error {}

/**
 * Every file path in a tree document, whichever shape it came in.
 *
 * Returns paths only for blobs: a directory entry is not something to fetch,
 * and including one would make the caller request a URL that answers with a
 * listing page rather than with source.
 */
export function parseTree(body: string): string[] {
	if (body.length > MAX_TREE_BYTES) throw new TreeError('the tree document is too large to read');

	let decoded: unknown;
	try {
		decoded = JSON.parse(body);
	} catch {
		throw new TreeError('the tree document is not JSON');
	}

	// GitLab answers with a bare array; the other two wrap it.
	const wrapper = decoded as { tree?: unknown; truncated?: unknown };
	const rows = Array.isArray(decoded) ? decoded : wrapper.tree;
	if (!Array.isArray(rows)) throw new TreeError('the tree document has no file list');

	if (wrapper.truncated === true) {
		// Refused rather than used. A truncated tree silently omits files, and
		// the conversion would then refuse a member for being absent rather
		// than for being untranslatable — a wrong reason.
		throw new TreeError('the repository tree was truncated, so it cannot be trusted');
	}

	const paths: string[] = [];
	for (const row of rows) {
		if (typeof row !== 'object' || row === null) continue;
		const entry = row as { path?: unknown; type?: unknown };
		if (typeof entry.path !== 'string' || entry.path.length === 0) continue;
		// `blob` on GitHub and Gitea, `blob` on GitLab too. A tree is a
		// directory; anything else is a submodule or a symlink.
		if (entry.type !== 'blob') continue;
		paths.push(entry.path);
	}
	return paths;
}

/**
 * A `FileLister` backed by forge tree APIs, caching one tree per repository.
 *
 * The returned function is what `source-repo.ts` expects: given a directory
 * URL, every file under it, as absolute URLs on the same raw host it was given.
 * Returning raw URLs rather than relative names is deliberate — that module
 * drops anything not resolving under the directory it asked about, and handing
 * it addresses on the host it already trusts keeps that check meaningful.
 */
export function createTreeLister(getText: TextFetcher): FileLister {
	/** `origin/owner/repo@ref` → the paths in it, or the failure that stands. */
	const trees = new Map<string, Promise<readonly string[]>>();

	async function treeFor(location: RawLocation): Promise<readonly string[]> {
		const { repository, ref } = location;
		const key = `${repository.origin}/${repository.owner}/${repository.repo}@${ref}`;

		const cached = trees.get(key);
		if (cached !== undefined) return await cached;

		// The promise is cached, not the result, so several listings converting
		// at once share one request instead of racing each other into the rate
		// limit.
		const pending = (async (): Promise<readonly string[]> => {
			let last: unknown = null;
			for (const candidate of treeCandidates(repository, ref)) {
				try {
					return parseTree(await getText(candidate));
				} catch (error) {
					last = error;
				}
			}
			throw last instanceof Error
				? last
				: new TreeError('no forge API answered for this repository');
		})();

		trees.set(key, pending);
		return await pending;
	}

	return async (directoryUrl: string): Promise<readonly string[]> => {
		const location = parseRawUrl(directoryUrl);
		if (location === null) return [];

		const prefix = location.path.replace(/\/+$/, '');
		const paths = await treeFor(location);

		const base = directoryUrl.endsWith('/') ? directoryUrl : `${directoryUrl}/`;
		const out: string[] = [];
		for (const path of paths) {
			if (prefix.length > 0 && !path.startsWith(`${prefix}/`)) continue;
			const relative = prefix.length > 0 ? path.slice(prefix.length + 1) : path;
			if (relative.length === 0) continue;
			out.push(`${base}${relative}`);
		}
		return out;
	};
}

/** Whether a URL is one this module would reach. For the consent surface. */
export function isForgeApi(url: string): boolean {
	try {
		return new URL(url).origin === GITHUB_API;
	} catch {
		return false;
	}
}

/** Kept so a caller can name the repository a pasted URL points at. */
export function repositoryOf(url: string): GitRepository | null {
	try {
		return parseRepositoryUrl(new URL(url));
	} catch {
		return null;
	}
}
