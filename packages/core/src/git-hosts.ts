/**
 * Turning "a repository URL" into "a URL that serves a file", on any git host.
 *
 * Every adapter needs the same thing — given what somebody pasted, where would
 * `index.min.json` live? — and the answer is host-shaped rather than
 * format-shaped, so it lives here once instead of six times.
 *
 * ## Why this is not just GitHub
 *
 * `repository-index.ts` handles GitHub because that is what most people paste.
 * It is not what everybody pastes: these ecosystems are also published on
 * self-hosted Gitea, on Codeberg, and on GitLab, and a client that only
 * understands one forge tells the other three that their URL is invalid.
 *
 * The raw-file path differs per forge and nowhere else does:
 *
 * | Forge | Raw path |
 * | --- | --- |
 * | GitHub | `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` |
 * | GitLab | `<host>/<owner>/<repo>/-/raw/<ref>/<path>` |
 * | Gitea, Forgejo, Codeberg | `<host>/<owner>/<repo>/raw/branch/<ref>/<path>` |
 *
 * **A pasted URL may already be on the raw host**, and often is: it is what
 * these repositories publish and what somebody copies out of a browser tab.
 * `parseRepositoryUrl` normalises that back to the forge origin, so the three
 * shapes above stay the only thing `rawCandidates` has to know about. See
 * that function for what went wrong while it did not.
 *
 * ## Rule 9
 *
 * No host is named here except the three forge *software* conventions and
 * GitHub's raw domain, which `repository-index.ts` already names. An unknown
 * host is handled by trying both self-hostable shapes, not by recognising it —
 * which is the only approach that works for a forge nobody has heard of, and
 * the only one that keeps a hostname list out of this repository.
 */

/**
 * GitHub, and the separate host it serves file bytes from.
 *
 * Named rather than inlined because three places now compare against them and
 * a fourth builds a URL from one. Both are already named in this package —
 * `repository-index.ts` and `git-trees.ts` — so this adds no host to the
 * repository (see the rule 9 note above).
 */
const GITHUB = 'https://github.com';
const GITHUB_RAW_HOST = 'raw.githubusercontent.com';

/** Where a repository lives, in the parts every forge agrees on. */
export interface GitRepository {
	readonly origin: string;
	readonly owner: string;
	readonly repo: string;
	/** A branch the pasted URL named, if it named one. */
	readonly ref: string | null;
}

/**
 * Reads a pasted URL as a repository, or returns null when it is not one.
 *
 * Deliberately tolerant about what follows the repository name: people paste
 * what is in the address bar, which is usually a page *inside* the repository
 * — a file, a subdirectory, a branch listing.
 */
export function parseRepositoryUrl(url: URL): GitRepository | null {
	const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, '');
	if (owner.length === 0 || repo.length === 0) return null;

	/*
	 * `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path…>` — the same
	 * repository, reached through GitHub's file host.
	 *
	 * **Normalised to the forge origin**, because every question asked of a
	 * `GitRepository` afterwards is "which forge is this", and the answer is
	 * GitHub rather than "a raw host". `parseRawUrl` in `git-trees.ts` has
	 * done exactly this since it was written; this is the same normalisation,
	 * arrived at later.
	 *
	 * The ref is unmarked here — there is no `/tree/`, the third segment
	 * simply *is* the branch — so the marker scan below would miss it.
	 *
	 * Both halves were wrong together, and the visible cost was the second
	 * one: an un-normalised origin failed `rawCandidates`'s GitHub test and
	 * fell through to the two self-hostable shapes, so a paste of this form
	 * produced 70 candidates in Gitea and GitLab path syntax aimed at a host
	 * that serves neither — every one a guaranteed 404, and together an error
	 * message that buried whatever the real problem was under seventy URLs.
	 */
	if (url.host === GITHUB_RAW_HOST) {
		return { origin: GITHUB, owner, repo, ref: segments[2] ?? null };
	}

	// `/tree/<ref>` on GitHub and Gitea, `/-/tree/<ref>` on GitLab, and
	// `/src/branch/<ref>` on Gitea's own file browser. Picking the ref out
	// matters: somebody who pasted a branch page meant that branch.
	let ref: string | null = null;
	const rest = segments.slice(2);
	const marker = rest.findIndex((segment) => segment === 'tree' || segment === 'branch');
	if (marker !== -1 && rest.length > marker + 1) ref = rest[marker + 1];

	return { origin: url.origin, owner, repo, ref };
}

/**
 * Every raw-file URL worth trying for one path inside a repository, best
 * first.
 *
 * `refs` is tried in order, and a ref the pasted URL named comes before the
 * defaults — asking for a branch and being served a different one is worse
 * than failing.
 */
export function rawCandidates(
	repository: GitRepository,
	path: string,
	refs: readonly string[]
): string[] {
	const wanted = repository.ref === null ? refs : [repository.ref, ...refs];
	const seen = new Set<string>();
	const out: string[] = [];

	const add = (candidate: string) => {
		if (seen.has(candidate)) return;
		seen.add(candidate);
		out.push(candidate);
	};

	const { origin, owner, repo } = repository;
	// True for a URL pasted on the raw host too — `parseRepositoryUrl`
	// normalises that origin, which is what keeps this one comparison correct
	// for both spellings instead of needing a second.
	const isGitHub = origin === GITHUB;

	for (const ref of wanted) {
		if (isGitHub) {
			// `raw.githubusercontent.com` sends `access-control-allow-origin: *`;
			// `github.com/<owner>/<repo>/raw/...` redirects there, so it is only a
			// slower way to reach the same bytes.
			add(`https://${GITHUB_RAW_HOST}/${owner}/${repo}/${ref}/${path}`);
			continue;
		}
		// Both self-hostable shapes, because the host does not say which
		// software is behind it and guessing from a hostname would be a list of
		// hostnames.
		add(`${origin}/${owner}/${repo}/raw/branch/${ref}/${path}`);
		add(`${origin}/${owner}/${repo}/-/raw/${ref}/${path}`);
	}
	return out;
}

/**
 * The branch names to try when the pasted URL named none.
 *
 * Ordered by how likely they are, which is worth doing: each miss is a request
 * that has to fail before the next is tried.
 */
export const DEFAULT_REFS = ['main', 'master'] as const;

/**
 * Whether a pasted URL already points at a file, so nothing should be appended
 * to it.
 *
 * The bug this exists to prevent, which is easy to write by hand in every
 * adapter and was: given `…/thing.json`, append `/index.min.json` and try
 * `…/thing.json/index.min.json`. The pasted URL is a file. Appending a path to
 * a file produces a URL that cannot exist, and buries the real failure — a
 * fetch that was blocked, say — under two guaranteed 404s.
 */
export function looksLikeFile(url: URL): boolean {
	return /\.(json|jsonc)$/i.test(url.pathname);
}
