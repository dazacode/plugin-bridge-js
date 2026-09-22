/**
 * Turning something a user pasted into a list of installable plugins.
 *
 * **This file's twin is `lib/core/plugins/plugin_index.dart`.** They resolve
 * the same URLs in the same order and refuse the same things, because a
 * repository that works in one client and not the other is a bug report nobody
 * can reproduce.
 *
 * Two rules from `contract/plugin-api/REPOSITORY.md` are load-bearing:
 *
 * - **kuro ships zero repositories.** No default, no bundled list, no
 *   discovery. A build that seeded one would be a build that ships a content
 *   source, which rule 9 forbids.
 * - **Being listed means nothing about safety.** This module resolves and
 *   parses; it does not vet. The permissions sheet is where safety is decided.
 *
 * The URL resolution exists because of what people actually paste. Nobody
 * pastes a raw githubusercontent link to a JSON file on a default branch; they
 * paste what is in the address bar.
 */

import type { ForeignOrigin, RepositoryFormat } from '@plugin-bridge/core/formats';

/** One plugin as a repository *claims* it is. */
export interface RepositoryPlugin {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly author: string;
	readonly license: string;
	readonly yorozoPluginApi: number;
	readonly minimumYorozoVersion: string;
	readonly platforms: readonly string[];
	readonly capabilities: readonly string[];
	/** Shown before installing, in full. */
	readonly permissions: readonly string[];
	/** Shown before installing, in full — never truncated. */
	readonly hosts: readonly string[];
	readonly language: string | null;
	readonly download: string;
	/**
	 * Lowercase hex, and empty for a listing from a foreign format.
	 *
	 * A native listing without one is refused in `parsePlugin` below. Foreign
	 * ecosystems publish no digest at all, so a converted install verifies the
	 * bundle against the *converter's* declaration rather than against a
	 * publisher's promise — `contract/plugin-api/FOREIGN.md` §5 states the
	 * consequence rather than papering over it.
	 */
	readonly sha256: string;
	readonly size: number;
	/**
	 * Where this listing came from, when it was not written for Yorozo.
	 *
	 * Absent for a native listing, which is what "this needs no conversion"
	 * looks like everywhere downstream.
	 */
	readonly origin?: ForeignOrigin;
}

export interface RepositoryIndex {
	readonly name: string;
	readonly updatedAt: string;
	/** Base64 SPKI Ed25519, pinned on first add. Null for an unsigned repository. */
	readonly signingKey: string | null;
	readonly plugins: readonly RepositoryPlugin[];
	/**
	 * Which ecosystem's index this was, before it was normalised into ours.
	 *
	 * `yorozo` for a native repository. Carried so the settings screen can say
	 * what it is reading, and so a refresh routes back through the same parser.
	 */
	readonly format: RepositoryFormat;
	/**
	 * Listings dropped because this build has nowhere to show what they serve.
	 *
	 * Counted rather than discarded silently: a repository none of whose
	 * listings survive must be able to say so, because an empty list reads as a
	 * failed fetch.
	 *
	 * The example this comment used to give — three hundred manga sources and
	 * no anime — was a real repository, and under `ADR-0013` it is now three
	 * hundred listings that are kept. The count survives because `novel` and
	 * any medium a foreign index may yet claim still land here.
	 */
	readonly filteredOut?: number;
}

/**
 * Parses one listing, rejecting anything unusable rather than defaulting it.
 *
 * A missing `sha256` or a non-https `download` is not a listing with a gap; it
 * is one that cannot be installed safely, and defaulting either would produce
 * an entry that fails confusingly at install time instead of clearly here.
 */
function parsePlugin(value: unknown): RepositoryPlugin {
	if (typeof value !== 'object' || value === null) throw new SyntaxError('not a plugin entry');
	const entry = value as Record<string, unknown>;

	const download = String(entry['download'] ?? '');
	if (!download.startsWith('https://')) {
		throw new SyntaxError('a plugin download must be https');
	}
	const sha256 = String(entry['sha256'] ?? '').toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SyntaxError('a listing needs a sha256');

	return {
		id: String(entry['id']),
		name: String(entry['name']),
		description: String(entry['description'] ?? ''),
		version: String(entry['version']),
		author: String(entry['author'] ?? 'unknown'),
		license: String(entry['license'] ?? ''),
		yorozoPluginApi: Number(entry['yorozoPluginApi'] ?? 1),
		minimumYorozoVersion: String(entry['minimumYorozoVersion'] ?? '0.0.0'),
		platforms: strings(entry['platforms']),
		capabilities: strings(entry['capabilities']),
		permissions: strings(entry['permissions']),
		hosts: strings(entry['hosts']),
		language: typeof entry['language'] === 'string' ? entry['language'] : null,
		download,
		sha256,
		size: Number(entry['size'] ?? 0)
	};
}

/**
 * Parses an index, refusing a schema version it does not understand.
 *
 * Refusing rather than best-effort parsing: a future index might be *relying*
 * on a field this build ignores, and quietly ignoring it is how a client
 * installs something the repository meant to gate.
 */
export function parseRepositoryIndex(body: string): RepositoryIndex {
	let decoded: unknown;
	try {
		decoded = JSON.parse(body);
	} catch {
		throw new SyntaxError('That URL did not return a plugin repository index.');
	}
	if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
		throw new SyntaxError('That URL did not return a plugin repository index.');
	}
	const document = decoded as Record<string, unknown>;

	if (document['schemaVersion'] !== 1) {
		throw new SyntaxError(
			`This repository uses index format ${String(document['schemaVersion'])}, which this ` +
				'version of Yorozo does not understand. Update the app.'
		);
	}

	const plugins: RepositoryPlugin[] = [];
	for (const entry of Array.isArray(document['plugins']) ? document['plugins'] : []) {
		// One malformed listing must not hide an entire repository.
		try {
			plugins.push(parsePlugin(entry));
		} catch {
			continue;
		}
	}

	return {
		name: String(document['name'] ?? 'Untitled repository'),
		updatedAt: String(document['updatedAt'] ?? ''),
		signingKey: typeof document['signingKey'] === 'string' ? document['signingKey'] : null,
		plugins,
		format: 'yorozo'
	};
}

/**
 * Candidate index URLs for whatever a user pasted, best first.
 *
 * The caller tries each and takes the first that parses. Throws for anything
 * that is not https — at every hop, because a cleartext index is one anybody on
 * the path can rewrite, and rewriting an index is enough to install anything.
 */
export function resolveIndexCandidates(pasted: string): string[] {
	const trimmed = pasted.trim();
	if (trimmed.length === 0) throw new SyntaxError('Paste a repository URL.');

	// A bare `owner/repo` is unambiguous, and shorter than making someone type
	// a prefix they will get wrong.
	const normalised = /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : trimmed;

	let url: URL;
	try {
		url = new URL(normalised);
	} catch {
		throw new SyntaxError('That is not a URL.');
	}
	if (url.protocol !== 'https:') {
		throw new SyntaxError('A repository must be https. Anything else can be altered in transit.');
	}

	const path = url.pathname.replace(/\/+$/, '');

	if (url.hostname === 'github.com') {
		const segments = path.split('/').filter((segment) => segment.length > 0);
		if (segments.length >= 2) {
			const owner = segments[0];
			const repo = segments[1].replace(/\.git$/, '');
			// Raw first, release assets last. The ordering is load-bearing.
			//
			// A GitHub **release asset** is served with no
			// `Access-Control-Allow-Origin` header, so a browser `fetch` for one
			// is blocked by CORS before this client sees a byte.
			// `raw.githubusercontent.com` sends `access-control-allow-origin: *`.
			//
			// The Dart twin resolves the same URLs in the same order, so that a
			// repository cannot work on the five Flutter targets and silently
			// fail to be added here. The release asset stays in the list — it is
			// a legitimate place to publish, and it works everywhere except a
			// browser — it is just tried after the things that work everywhere.
			return [
				`https://raw.githubusercontent.com/${owner}/${repo}/main/index.json`,
				`https://raw.githubusercontent.com/${owner}/${repo}/master/index.json`,
				`https://raw.githubusercontent.com/${owner}/${repo}/main/dist/index.json`,
				`https://raw.githubusercontent.com/${owner}/${repo}/master/dist/index.json`,
				`https://github.com/${owner}/${repo}/releases/latest/download/index.json`
			];
		}
	}

	if (path.endsWith('.json')) return [url.toString()];
	return [`${url.origin}${path}/index.json`, `${url.origin}${path}/dist/index.json`];
}

function strings(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
