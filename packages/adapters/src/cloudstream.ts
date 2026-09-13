/**
 * Plugin repositories published for Cloudstream.
 *
 * Two documents, always: a small manifest naming one or more *plugin lists*,
 * and the lists themselves. `loadIndex` follows that chain; `parseIndex`
 * recognises a list. Pasting either the manifest or a list works, because
 * people paste whichever they were given.
 *
 * `browse-only`, for the reason in `contract/plugin-api/FOREIGN.md` §4.1. The
 * artifact is compiled JVM bytecode — this ecosystem helpfully publishes a
 * plain `.jar` beside its Android-flavoured `.cs3`, which makes the *container*
 * easy and changes nothing that matters: neither file contains the Kotlin
 * standard library, the HTTP client or the HTML parser the plugin runs on. The
 * classpath is the work, and it is identical for both.
 *
 * The `.jar` is still worth recording on the listing. When a bytecode converter
 * is written, starting from JVM class files rather than from minified Dalvik is
 * a real head start, and this is the only adapted ecosystem that offers them.
 */

import {
	convertedPluginId,
	foreignListing,
	keepMediums,
	refuseConversion,
	ForeignFormatError,
	type ForeignAdapter,
	type TextFetcher
} from '@plugin-bridge/core/adapter';
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import { looksLikeFile, parseRepositoryUrl, rawCandidates } from '@plugin-bridge/core/git-hosts';
import type { RepositoryIndex } from '@plugin-bridge/core/repository-index';

/**
 * `tvTypes` to a medium.
 *
 * Most providers in this ecosystem are live-action film and television, which
 * is exactly `live-action` — not a fallback pretending to be one of the
 * reading media, and no longer a medium this build has nowhere to show,
 * though the format's own tier (`browse-only`: compiled JVM bytecode, no
 * converter yet) still refuses every listing regardless of what it serves.
 */
function mediumOf(tvTypes: unknown): ForeignMedium {
	const types = Array.isArray(tvTypes) ? tvTypes.map((t) => String(t).toLowerCase()) : [];
	if (types.some((type) => type.includes('anime') || type === 'ova')) return 'anime';
	return 'live-action';
}

function parsePluginList(body: string, listUrl: string, name: string): RepositoryIndex {
	let decoded: unknown;
	try {
		decoded = JSON.parse(body);
	} catch {
		throw new ForeignFormatError('not JSON');
	}
	if (!Array.isArray(decoded) || decoded.length === 0) {
		throw new ForeignFormatError('not a Cloudstream plugin list');
	}

	// `internalName` beside a url is the shape unique to this ecosystem.
	const rows = decoded.filter((entry): entry is Record<string, unknown> => {
		if (typeof entry !== 'object' || entry === null) return false;
		const row = entry as Record<string, unknown>;
		return typeof row['internalName'] === 'string' && typeof row['url'] === 'string';
	});
	if (rows.length === 0) throw new ForeignFormatError('not a Cloudstream plugin list');

	const plugins = rows.map((row) => {
		const internalName = String(row['internalName']);
		const artifact = new URL(String(row['url']), listUrl).toString();
		const jar =
			typeof row['jarUrl'] === 'string' ? new URL(row['jarUrl'], listUrl).toString() : null;
		const authors = Array.isArray(row['authors']) ? row['authors'].map(String) : [];

		return foreignListing({
			id: convertedPluginId('cloudstream', internalName),
			name: String(row['name'] ?? internalName),
			description: String(row['description'] ?? ''),
			version: String(row['version'] ?? '0'),
			author: authors.join(', '),
			language: null,
			// A provider declares no hosts anywhere, so there is nothing honest to
			// put here. An empty list is the truthful answer and would be shown as
			// such on a consent sheet; it is also why nothing in this format could
			// be installed even if the bytecode ran.
			hosts: [],
			size: typeof row['fileSize'] === 'number' ? row['fileSize'] : 0,
			origin: {
				format: 'cloudstream',
				artifactUrl: artifact,
				foreignId: internalName,
				foreignVersion: String(row['version'] ?? '0'),
				mediaKind: mediumOf(row['tvTypes']),
				isNsfw: Array.isArray(row['tvTypes'])
					? row['tvTypes'].some((type) => String(type).toLowerCase() === 'nsfw')
					: false,
				detail: {
					// The JVM twin, and its digest. Recorded for a converter that does
					// not exist yet; see this file's header for why it is the better
					// starting point of the two.
					jarUrl: jar,
					jarHash: typeof row['jarHash'] === 'string' ? row['jarHash'] : null,
					fileHash: typeof row['fileHash'] === 'string' ? row['fileHash'] : null
				}
			}
		});
	});

	return keepMediums({
		name,
		updatedAt: '',
		signingKey: null,
		plugins,
		format: 'cloudstream'
	});
}

export const cloudstreamAdapter: ForeignAdapter = {
	format: 'cloudstream',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		return ['repo.json', 'plugins.json'].flatMap((path) =>
			rawCandidates(repository, path, ['master', 'main', 'builds'])
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		return parsePluginList(body, indexUrl, 'Cloudstream plugins');
	},

	async loadIndex(body: string, indexUrl: string, getText: TextFetcher): Promise<RepositoryIndex> {
		// A plugin list, pasted directly.
		try {
			return this.parseIndex(body, indexUrl);
		} catch {
			// Fall through to the manifest case.
		}

		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(body) as Record<string, unknown>;
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		const lists = manifest['pluginLists'];
		if (!Array.isArray(lists) || lists.length === 0) {
			throw new ForeignFormatError('not a Cloudstream repository');
		}

		const name = String(manifest['name'] ?? 'Cloudstream plugins');
		const merged: RepositoryIndex['plugins'][number][] = [];
		let filtered = 0;
		let reached = 0;

		for (const entry of lists) {
			const listUrl = String(entry);
			if (!listUrl.startsWith('https://')) continue;
			try {
				const list = parsePluginList(await getText(listUrl), listUrl, name);
				merged.push(...list.plugins);
				filtered += list.filteredOut ?? 0;
				reached += 1;
			} catch {
				// One unreachable or malformed list must not hide the others. A
				// repository naming five lists is usable when four answer.
				continue;
			}
		}

		if (reached === 0) {
			throw new ForeignFormatError('none of this repository’s plugin lists could be read');
		}

		return {
			name,
			updatedAt: '',
			signingKey: null,
			plugins: merged,
			format: 'cloudstream',
			filteredOut: filtered
		};
	},

	// `async`, so the refusal is a rejection rather than a synchronous throw
	// from something typed to return a promise. A caller reaching for `.catch`
	// must not be the one who discovers the difference.
	async convert(): Promise<Uint8Array> {
		refuseConversion('cloudstream');
	}
};
