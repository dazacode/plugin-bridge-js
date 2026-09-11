/**
 * Working out which ecosystem a pasted URL belongs to.
 *
 * `contract/plugin-api/FOREIGN.md` §3 is normative. Two halves, and both are
 * load-bearing:
 *
 * - The **URL** narrows what to fetch. Several ecosystems publish an
 *   `index.json`, so a path is a hint about where the listings are, never a
 *   statement of what they are.
 * - The **body** decides. Each adapter is handed the document and the first one
 *   that parses it wins, which is why an adapter must throw on a body that is
 *   not its format rather than politely returning nothing.
 *
 * The native format is always tried first, everywhere. A Yorozo repository
 * being read as a foreign one would convert something that needs no
 * conversion, and would lose its signature doing it.
 *
 * ## Rule 9
 *
 * Nothing here knows a repository, a streaming site or a CDN by name.
 * `github.com` and `raw.githubusercontent.com` appear because they are how
 * public repositories are addressed, and they are already named in
 * `repository-index.ts` for the same reason.
 */

import { NotFoundFailure, ValidationFailure } from '@plugin-bridge/core/errors';
import {
	parseRepositoryIndex,
	resolveIndexCandidates,
	type RepositoryIndex
} from '@plugin-bridge/core/repository-index';
import {
	ForeignIndexError,
	loadForeignIndex,
	type ForeignAdapter,
	type TextFetcher
} from './adapter';
import { aniyomiAdapter } from '@plugin-bridge/adapters/aniyomi';
import { cloudstreamAdapter } from '@plugin-bridge/adapters/cloudstream';
import { hayaseAdapter } from '@plugin-bridge/adapters/hayase';
import { lnreaderAdapter } from '@plugin-bridge/adapters/lnreader';
import { mangayomiAdapter } from '@plugin-bridge/adapters/mangayomi';
import { soraAdapter } from '@plugin-bridge/adapters/sora';
import type { ForeignFormat } from './formats';

/**
 * Ordered, and the order is a policy.
 *
 * The two formats with a distinctive filename come first, so the common case
 * costs one request. `mangayomi` and `hayase` both answer to a bare
 * `index.json` and are separated by their body, not their position — but
 * `hayase` is checked first because its entries carry a `manifestVersion`
 * field that nothing else does, making it the cheaper negative.
 */
export const FOREIGN_ADAPTERS: readonly ForeignAdapter[] = [
	soraAdapter,
	aniyomiAdapter,
	lnreaderAdapter,
	cloudstreamAdapter,
	hayaseAdapter,
	mangayomiAdapter
];

export function adapterFor(format: ForeignFormat): ForeignAdapter {
	const adapter = FOREIGN_ADAPTERS.find((candidate) => candidate.format === format);
	if (adapter === undefined) {
		throw new ValidationFailure(`This build does not know the "${format}" plugin format.`);
	}
	return adapter;
}

export interface DetectedRepository {
	readonly indexUrl: string;
	readonly index: RepositoryIndex;
}

/**
 * Normalises what somebody pasted into a URL, applying the same two courtesies
 * `resolveIndexCandidates` does: a bare `owner/repo` is a GitHub repository,
 * and anything not https is refused rather than downgraded.
 */
function normalise(pasted: string): URL {
	const trimmed = pasted.trim();
	if (trimmed.length === 0) throw new ValidationFailure('Paste a repository URL.');

	const withScheme = /^[\w.-]+\/[\w.-]+$/.test(trimmed) ? `https://github.com/${trimmed}` : trimmed;

	let url: URL;
	try {
		url = new URL(withScheme);
	} catch {
		throw new ValidationFailure('That is not a URL.');
	}
	if (url.protocol !== 'https:') {
		throw new ValidationFailure(
			'A repository must be https. Anything else can be altered in transit.'
		);
	}
	return url;
}

/**
 * Every URL worth trying, native first, then each adapter's, de-duplicated.
 *
 * De-duplication matters more than it looks: four adapters offer
 * `<repo>/main/index.json`, and without this a repository that is none of them
 * would be fetched four times before failing.
 */
export function detectionCandidates(pasted: string): {
	url: URL;
	candidates: string[];
} {
	const url = normalise(pasted);
	const seen = new Set<string>();
	const candidates: string[] = [];

	const add = (candidate: string) => {
		if (!candidate.startsWith('https://') || seen.has(candidate)) return;
		seen.add(candidate);
		candidates.push(candidate);
	};

	// Native first, always. See this file's header.
	for (const candidate of resolveIndexCandidates(pasted)) add(candidate);
	for (const adapter of FOREIGN_ADAPTERS) {
		for (const candidate of adapter.candidates(url)) add(candidate);
	}
	return { url, candidates };
}

/**
 * Finds the repository behind a pasted URL, in whatever format it is in.
 *
 * `getText` is injected rather than taken from the module scope so that the
 * registry keeps its size caps and https enforcement on every hop, including
 * the second document the two split formats fetch.
 *
 * Throws `NotFoundFailure` listing what was tried. That list is the whole
 * value of the error: "no repository found" alone leaves someone with a typo
 * and no way to see it.
 */
/**
 * Whether a body is announcing itself as a Yorozo index, well-formed or not.
 *
 * Deliberately the *presence* of the key rather than its value: `schemaVersion:
 * 2` is a repository from a future build and must be reported as one, and
 * `schemaVersion: "one"` is ours and broken. Neither is somebody else's format.
 */
function claimsOurs(body: string): boolean {
	try {
		const decoded: unknown = JSON.parse(body);
		return (
			typeof decoded === 'object' &&
			decoded !== null &&
			!Array.isArray(decoded) &&
			'schemaVersion' in decoded
		);
	} catch {
		return false;
	}
}

export async function detectRepository(
	pasted: string,
	getText: TextFetcher
): Promise<DetectedRepository> {
	const { candidates } = detectionCandidates(pasted);
	const attempted: string[] = [];

	for (const candidate of candidates) {
		attempted.push(candidate);

		let body: string;
		try {
			body = await getText(candidate);
		} catch {
			continue;
		}

		// The native parser is authoritative for its own format and refuses a
		// schema version it does not understand, which must stay a hard error
		// rather than a reason to try reading it as something else.
		//
		// **Only when the body claims to be ours.** `parseRepositoryIndex` raises
		// that same error for any JSON object with no `schemaVersion` at all,
		// and several foreign indexes are exactly that — a `repo.json` whose
		// fields are `manifestVersion` and `pluginLists`, for one. Rethrowing
		// there meant an entire format could not be added: detection stopped at
		// the first candidate with "this repository uses index format
		// undefined", naming a field the repository never claimed to have. Found
		// by running the fixtures through both hosts (ADR-0004 §6.2), which is
		// the sort of thing a second implementation is for.
		try {
			return { indexUrl: candidate, index: parseRepositoryIndex(body) };
		} catch (error) {
			if (error instanceof SyntaxError && /index format/.test(error.message) && claimsOurs(body)) {
				throw error;
			}
		}

		for (const adapter of FOREIGN_ADAPTERS) {
			try {
				return {
					indexUrl: candidate,
					index: await loadForeignIndex(adapter, body, candidate, getText)
				};
			} catch (error) {
				// Same rule as the native parser above: an adapter that recognised
				// the body and then found it broken is answering the question, and
				// trying the next adapter can only bury that answer under "nothing
				// found there".
				if (error instanceof ForeignIndexError) throw error;
				continue;
			}
		}
	}

	throw new NotFoundFailure(
		`No plugin repository was found there. Tried:\n${attempted.map((url) => `  ${url}`).join('\n')}`
	);
}
