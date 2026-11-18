/**
 * Paperback extension repositories, as a repository this build can read.
 *
 * ## Why the registration document is `versioning.json`
 *
 * This ecosystem's build output is not a list of downloads. It is a directory
 * per extension holding an already-bundled `index.js`, and beside it a
 * `versioning.json` naming the repository, its build time and every extension
 * by id. The id is also the directory name, so the artifact is *derived* from
 * the document rather than carried by it — which is why the older flat array
 * is accepted as a secondary shape and the object is the primary one.
 *
 * `metadata.json` looks like an index and is not: it is keyed by internal
 * channel (`general-extensions`) and carries build provenance per name with
 * no version at all. Listing it here would produce rows with no artifact that
 * resolves. So it is deliberately absent from `candidates`.
 *
 * ## What is refused
 *
 * A document that is neither shape. In particular an Aidoku index, whose rows
 * carry a `downloadURL` and whose document names no `repository` object — the
 * two negatives together are what makes the object shape recognisable without
 * claiming every `sources` array in the world.
 *
 * ## What the bundle is given
 *
 * A converted module is the published `index.js` unchanged, under a shim that
 * supplies the `Application` global its classes call. The source is already
 * bundled ES5-ish JavaScript: there is no translation, only a host surface.
 * The shim supplies exactly the members measured across the corpus and throws
 * by name for anything else, because an `Application` that answers everything
 * with `undefined` turns "this build is missing a method" into a scrape of an
 * empty page.
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
import { paperbackEntrypoint } from '@plugin-bridge/runtime/shims/paperback-entry';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/** The paved path the toolchain writes, relative to the repository root. */
const PAVED_INDEX = '0.9/stable/versioning.json';

/**
 * The directory part of an index URL, with its trailing slash.
 *
 * Every artifact in this format is a sibling of the index, so the join is done
 * once here rather than in three places with three chances to forget the slash.
 */
function directoryOf(indexUrl: string): string {
	const url = new URL(indexUrl);
	url.pathname = url.pathname.replace(/[^/]*$/, '');
	url.search = '';
	url.hash = '';
	return url.toString();
}

/** An entry's artifact, always a sibling of the index that named it. */
function artifactFor(name: string, filename: unknown, directory: string): string | null {
	const wanted =
		typeof filename === 'string' && filename.length > 0 ? filename : `${name}/index.js`;
	try {
		return new URL(wanted, directory).toString();
	} catch {
		return null;
	}
}

/**
 * A flat-array row: an id and a file, plus the provenance no other array has.
 *
 * The exclusions are the point. Every other array in these ecosystems can put
 * an `id` and a `name` on a row, so the shape alone identifies nothing. What
 * is unique here is what a row *says*: an artifact of its own. Hayase says
 * that through `manifestVersion` and LNReader through `site`, and neither
 * publishes a file with a `.js`-shaped name, so a row claiming either is not
 * one of these.
 */
function isFlatRow(entry: unknown): entry is Record<string, unknown> {
	if (typeof entry !== 'object' || entry === null) return false;
	const row = entry as Record<string, unknown>;
	const file = row['filename'] ?? row['url'];
	return (
		typeof row['id'] === 'string' &&
		typeof row['name'] === 'string' &&
		typeof file === 'string' &&
		/\.(?:js|mjs|cjs)(?:\?|$)/i.test(file) &&
		(typeof row['version'] === 'string' || typeof row['metadata'] === 'object') &&
		row['manifestVersion'] === undefined &&
		row['site'] === undefined
	);
}

/**
 * The fields every listing is built from, in the shape both inputs share.
 *
 * `contentRating` is the ecosystem's own `SAFE|MATURE|ADULT`; anything else is
 * treated as safe, because a row that mislabels itself mature is a row shown
 * behind a warning it did not need, and the opposite hides content.
 */
interface Row {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly version: string;
	readonly author: string;
	readonly language: string | null;
	readonly isNsfw: boolean;
	readonly capabilities: unknown[];
	readonly filename: unknown;
}

function rowOf(entry: Record<string, unknown>): Row {
	const rating =
		typeof entry['contentRating'] === 'string' ? entry['contentRating'].toUpperCase() : '';
	const developer = Array.isArray(entry['developers']) ? entry['developers'][0] : undefined;
	const author =
		typeof developer === 'object' && developer !== null
			? String((developer as Record<string, unknown>)['name'] ?? '')
			: '';

	return {
		id: String(entry['id']),
		name: String(entry['name'] ?? entry['id']),
		description: String(entry['description'] ?? ''),
		version: String(entry['version'] ?? '0'),
		author,
		language: typeof entry['language'] === 'string' ? entry['language'].trim() : null,
		isNsfw: rating === 'MATURE' || rating === 'ADULT',
		capabilities: Array.isArray(entry['capabilities']) ? entry['capabilities'] : [],
		filename: entry['filename'] ?? entry['url']
	};
}

export const paperbackAdapter: ForeignAdapter = {
	format: 'paperback',

	candidates(pasted: URL): string[] {
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// The paved path first. It is the only one the toolchain publishes and
		// it is the only one whose directory the artifacts resolve against;
		// the undated shapes exist for forks that have flattened the layout.
		return [PAVED_INDEX, '0.9/stable/index.json', 'stable/versioning.json', 'index.json'].flatMap(
			(path) => rawCandidates(repository, path, DEFAULT_REFS)
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		const directory = directoryOf(indexUrl);
		let name = 'Paperback extensions';
		let description = '';
		let updatedAt = '';
		let rows: Row[];

		if (Array.isArray(decoded)) {
			/*
			 * The older shape. A row carries its own file, and this is the one
			 * array in the adapted ecosystems that says both `filename` and a
			 * `version` (or an opaque `metadata` blob). Hayase's rows name a
			 * `code` and a `manifestVersion`; LNReader's name a `site`; neither
			 * has a file path in this spelling.
			 */
			if (decoded.length === 0 || !decoded.every(isFlatRow)) {
				throw new ForeignFormatError('not a Paperback extension index');
			}
			rows = (decoded as Record<string, unknown>[]).map(rowOf);
		} else if (typeof decoded === 'object' && decoded !== null) {
			const document = decoded as Record<string, unknown>;
			const repository = document['repository'];
			const sources = document['sources'];

			/*
			 * Both halves are the negative. `sources` alone is Aidoku's shape;
			 * a `repository` object beside it is this format's registration
			 * document and no sibling publishes one.
			 */
			if (
				typeof repository !== 'object' ||
				repository === null ||
				Array.isArray(repository) ||
				!Array.isArray(sources) ||
				sources.length === 0
			) {
				throw new ForeignFormatError('not a Paperback extension index');
			}

			const repositoryRow = repository as Record<string, unknown>;
			if (typeof repositoryRow['name'] === 'string' && repositoryRow['name'].length > 0) {
				name = repositoryRow['name'];
			}
			if (typeof repositoryRow['description'] === 'string') {
				description = repositoryRow['description'];
			}
			if (typeof document['buildTime'] === 'string') updatedAt = document['buildTime'];

			rows = sources
				.filter(
					(entry): entry is Record<string, unknown> =>
						typeof entry === 'object' &&
						entry !== null &&
						typeof (entry as Record<string, unknown>)['id'] === 'string' &&
						typeof (entry as Record<string, unknown>)['name'] === 'string'
				)
				.map(rowOf);
			if (rows.length === 0) throw new ForeignFormatError('not a Paperback extension index');
		} else {
			throw new ForeignFormatError('not a Paperback extension index');
		}

		const plugins: RepositoryPlugin[] = [];
		for (const row of rows) {
			const artifactUrl = artifactFor(row.id, row.filename, directory);
			// A row whose id produced nothing URL-shaped cannot be installed and
			// would only be a disabled row; leaving it out is the honest count.
			if (artifactUrl === null) continue;

			plugins.push(
				foreignListing({
					id: convertedPluginId('paperback', row.id),
					name: row.name,
					description: row.description,
					version: row.version,
					author: row.author,
					language: row.language,
					hosts: hostsFromUrls([artifactUrl]),
					origin: {
						format: 'paperback',
						artifactUrl,
						foreignId: row.id,
						foreignVersion: row.version,
						mediaKind: 'manga',
						mediaKinds: ['manga'],
						isNsfw: row.isNsfw,
						/*
						 * The capability bitflags are carried without being
						 * interpreted. They are the ecosystem's own claim about
						 * what a source implements (search, settings, home
						 * sections, a Cloudflare wall), and a later consumer can
						 * read them without this parser having to decide what a
						 * bit means. Interpreting one here would freeze the bit
						 * table into a stored listing.
						 */
						detail: { capabilities: row.capabilities }
					}
				})
			);
		}

		return keepMediums({
			name,
			description,
			updatedAt,
			signingKey: null,
			plugins,
			format: 'paperback'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'paperback') {
			throw new ForeignFormatError('That listing did not come from a Paperback repository.');
		}

		const raw = new TextDecoder().decode(await services.fetchArtifact(origin.artifactUrl));
		const hosts = [...new Set(hostsInSource(raw))].sort();

		/*
		 * Hosts are taken from the code and not from the listing. The artifact
		 * host serves the file that was just downloaded; the extension never
		 * fetches its own bundle at runtime, so granting that address would be
		 * authority nothing spends.
		 */
		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0
					? `Converted Paperback source. ${listing.description}`
					: 'Converted Paperback source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource: paperbackEntrypoint({
				pluginId: listing.id,
				foreignId: origin.foreignId,
				script: raw
			})
		});
	}
};
