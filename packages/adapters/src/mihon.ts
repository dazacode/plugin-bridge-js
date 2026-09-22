/**
 * The published catalogue for Mihon, Keiyoushi and their forks — the manga
 * counterpart of the Kotlin ecosystem `aniyomi.ts` reads for anime.
 *
 * ## Why this index looks nothing like `aniyomi.ts`'s
 *
 * Aniyomi's listing file is a bare JSON array beside a `repo.json` sibling.
 * This ecosystem moved on: the real index is `index.pb`, a **gzipped
 * protobuf**, published alongside a deliberately hollow `index.min.json` kept
 * only so a reader built against the old array shape fails loudly instead of
 * silently. `parseIndex` below exists almost entirely to name that trap —
 * `contract/plugin-api/FOREIGN.md` §6 is why a format that *can* be detected
 * wrongly-but-successfully has to be detected on purpose instead.
 *
 * `packages/core/src/protobuf.ts` is the wire reader this file is written
 * against; its header has the reasoning for reading the wire format directly
 * rather than generating a schema-bound decoder, and for returning an
 * ecosystem's `int64` fields as `bigint`. Both apply here unchanged: a source
 * id in this catalogue is exactly the same shape of fact as a source id in
 * the other one, and rounds the same way if it is ever read as a `number`.
 *
 * ## One `RepositoryPlugin` per Extension, not per Source
 *
 * The protobuf nests `Source` inside `Extension` because that is what a build
 * actually produces — one APK, one class, and as many `AnimeSource`-shaped
 * (or here, `HttpSource`-shaped) instances as the module declares languages
 * for. Filing a browsable row per source would show the same artifact five
 * times under five names for a module that merely serves five languages, so
 * the artifact is the listing and its sources are carried on `origin.detail`
 * for whatever eventually converts it.
 *
 * ## `mihon` is not yet a registered `ForeignFormat`
 *
 * `packages/core/src/formats.ts`'s `REPOSITORY_FORMATS` union does not have a
 * `'mihon'` member yet, and this file does not add one — `formats.ts` is owned
 * by whoever is mid-edit on the rest of the adapter registry, and its own
 * header explains why the mapping from format to refusal sentence, tier and
 * cookie policy has to stay in one place. Every value that needs to be typed
 * `ForeignFormat` here is therefore `'mihon' as ForeignFormat`, marked
 * `TODO(owner)` at the one place it first appears. Until `formats.ts`
 * registers it, `formatProfile('mihon' as ForeignFormat)` and anything that
 * calls it (`refuseConversion`, `refusalFor`) will throw on a real listing —
 * this file never calls either, precisely because that landmine exists.
 *
 * ## Rule 9
 *
 * `mihon`, `keiyoushi` and `jsdelivr` name a client application, a repository
 * host and a CDN respectively — never a content source — so they are written
 * out in full here exactly as `raw.githubusercontent.com` already is in
 * `git-hosts.ts`. No streaming or scanlation hostname appears anywhere in this
 * file or its spec.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	keepMediums,
	ForeignFormatError,
	ForeignIndexError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';
import { gunzip, isGzip, ProtobufError, ProtoMessage } from '@plugin-bridge/core/protobuf';
import type { ForeignFormat } from '@plugin-bridge/core/formats';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** A pasted URL that already names the binary index, not appended to. */
const INDEX_PB = /\.pb$/i;

/** The two placeholder rows the deprecated `index.min.json` still serves. */
const STUB_NAMES = new Set(['Outdated App', 'Update to Mihon 0.20.1+']);
const STUB_PACKAGE_SUFFIXES = ['.extension.all.keiyoushi', '.extension.all.mihon'];

function stubRowName(row: Record<string, unknown>): string {
	return typeof row['name'] === 'string' ? row['name'] : '';
}

function stubRowPackage(row: Record<string, unknown>): string {
	const pkg = row['pkg'] ?? row['packageName'];
	return typeof pkg === 'string' ? pkg : '';
}

/**
 * Whether a parsed JSON body is the two-entry stub rather than a real index.
 *
 * Checked by name and by package suffix rather than by array length alone,
 * because length two is also what a real, tiny, one-language-two-extension
 * catalogue looks like — and refusing that catalogue for merely being small
 * would be exactly the false positive `FOREIGN.md` §6 is written against.
 */
function isStubIndex(decoded: unknown): boolean {
	if (!Array.isArray(decoded) || decoded.length !== 2) return false;
	return decoded.every((entry) => {
		if (typeof entry !== 'object' || entry === null) return false;
		const row = entry as Record<string, unknown>;
		return (
			STUB_NAMES.has(stubRowName(row)) ||
			STUB_PACKAGE_SUFFIXES.some((suffix) => stubRowPackage(row).endsWith(suffix))
		);
	});
}

type MihonContentRating = 'safe' | 'mixed' | 'nsfw' | 'unspecified';

const CONTENT_WARNINGS: Readonly<Record<number, MihonContentRating>> = {
	0: 'unspecified',
	1: 'safe',
	2: 'mixed',
	3: 'nsfw'
};

function contentRatingOf(extension: ProtoMessage): MihonContentRating {
	const warning = extension.int(7);
	return warning === undefined ? 'unspecified' : (CONTENT_WARNINGS[warning] ?? 'unspecified');
}

/**
 * Whether the manifest itself is grounds to warn a viewer before installing.
 *
 * `mixed` counts alongside `nsfw`: it means adult material appears *among*
 * this module's sources, not that every source is safe apart from a labelled
 * few, so a viewer who opted out of adult content is exposed by treating it
 * as safe. `unspecified` is left alongside `safe` rather than folded into the
 * warning — asserting nsfw about a module that never claimed it would be
 * inventing a fact the publisher did not state, the same restraint
 * `pretranslatedDescriptor` and the rest of this codebase apply everywhere
 * else a manifest is silent.
 */
function isNsfwRating(rating: MihonContentRating): boolean {
	return rating === 'nsfw' || rating === 'mixed';
}

/**
 * The source directory a later conversion will need, recovered from where
 * this ecosystem happens to serve its icons.
 *
 * Nothing in the protobuf names a source's directory directly — the
 * generator that `mihon-build-file.ts`'s header describes synthesises the
 * concrete class from a build file the *index* never sees. But `iconUrl` is
 * jsDelivr's GitHub proxy, `cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>`,
 * mirroring the repository's own tree — so an icon filed under
 * `src/<lang>/<dir>/res/…` is sitting inside the exact directory a build file
 * reader will eventually walk. A repository that serves its icons any other
 * way yields no directory here, which is a real gap and not a guess: nothing
 * downstream may invent a path this function could not read.
 */
const ICON_URL_SOURCE_DIR =
	/^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^@/]+@[^/]+\/(src\/[^/]+\/[^/]+)\/res\//i;

function sourceDirFromIconUrl(iconUrl: string | undefined): string | null {
	if (iconUrl === undefined) return null;
	const match = ICON_URL_SOURCE_DIR.exec(iconUrl);
	return match === null ? null : match[1];
}

/**
 * One `Source` submessage, read into the shape `origin.detail` carries.
 *
 * `id` is a decimal string, never a `bigint` and never a rounded `number` —
 * `protobuf.ts`'s header is the reasoning, and `ForeignOrigin.detail` is
 * documented as "structurally cloneable JSON only", which a `bigint` is not:
 * `JSON.stringify` throws on one, and a listing that outlives its index (held
 * across a reload, replayed by a test) has to survive that trip.
 */
interface MihonSourceDetail {
	readonly id: string | null;
	readonly name: string;
	readonly language: string | null;
	readonly homeUrl: string | null;
	readonly mirrorUrls: readonly string[];
	readonly message: string | null;
}

function readSource(source: ProtoMessage): MihonSourceDetail {
	const id = source.varint(1);
	return {
		id: id === undefined ? null : id.toString(),
		name: source.string(2) ?? '',
		language: source.string(3) ?? null,
		homeUrl: source.string(4) ?? null,
		mirrorUrls: source.strings(5),
		message: source.string(7) ?? null
	};
}

/** Reads one `Extension` submessage into one browsable listing, or null. */
function readExtension(extension: ProtoMessage): RepositoryPlugin | null {
	const packageName = extension.string(2);
	// A row missing its own package name is not a listing anything can be
	// installed or matched against later, and one malformed row must not sink
	// the rest of a 1,396-extension catalogue.
	if (packageName === undefined || packageName.length === 0) return null;

	const resources = extension.message(3);
	const apkUrl = resources?.string(1) ?? '';
	// Nothing to browse to without an artifact URL — this is the same "skip,
	// don't fail the whole index" rule `aniyomi.ts` applies to a row missing
	// `apk`.
	if (apkUrl.length === 0) return null;

	const versionCode = extension.varint(5);
	const versionName = extension.string(6) ?? '';
	// This ecosystem numbers with an integer `versionCode` as well as a
	// human `versionName`; the name is what a viewer recognises, and the code
	// is the fallback for the rare row that omits it. Neither is parsed as
	// semver — `ForeignOrigin.foreignVersion`'s own doc comment is why.
	const version = versionName.length > 0 ? versionName : (versionCode?.toString() ?? '0');

	const sources = extension.messages(8).map(readSource);
	const hostUrls = sources.flatMap((source) => [source.homeUrl, ...source.mirrorUrls]);
	const rating = contentRatingOf(extension);

	return foreignListing({
		id: convertedPluginId('mihon' as ForeignFormat, packageName),
		name: extension.string(1) ?? packageName,
		// De-duplicated for the same reason `aniyomi.ts` de-duplicates: a
		// module routinely declares several sources sharing one name, differing
		// only by language, and "X, X, X, X, X" describes nothing.
		description: [
			...new Set(sources.map((source) => source.name).filter((name) => name.length > 0))
		].join(', '),
		version,
		author: '',
		language: sources[0]?.language ?? null,
		hosts: hostsFromUrls(hostUrls),
		origin: {
			format: 'mihon',
			artifactUrl: apkUrl,
			foreignId: packageName,
			foreignVersion: version,
			mediaKind: 'manga',
			isNsfw: isNsfwRating(rating),
			detail: {
				contentRating: rating,
				extensionLib: extension.string(4) ?? '',
				sourceDir: sourceDirFromIconUrl(resources?.string(2)),
				sources
			}
		}
	});
}

export const mihonAdapter: ForeignAdapter = {
	format: 'mihon',

	candidates(pasted: URL): string[] {
		// A pasted URL that already names a file — the binary index or the JSON
		// stub — is used as given. Appending a path to a file produces a URL
		// that cannot exist and buries the real failure under a guaranteed 404,
		// same as every other adapter in this directory.
		if (looksLikeFile(pasted) || INDEX_PB.test(pasted.pathname)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// `index.pb` first: it is the real catalogue, and `index.min.json` is
		// the deprecated stub `parseIndex` below refuses by name. Trying the
		// binary index first costs the ordinary case one request instead of two.
		return ['index.pb', 'index.min.json'].flatMap((path) =>
			rawCandidates(repository, path, DEFAULT_REFS)
		);
	},

	/**
	 * The text door onto this format, which exists to name one trap.
	 *
	 * This ecosystem's real index is never text — it is the gzipped protobuf
	 * `parseIndexBytes` reads. The one text document this format still serves
	 * is `index.min.json`, and it parses as clean, well-formed JSON: two
	 * objects, "Outdated App" and "Update to Mihon 0.20.1+", which is the
	 * ecosystem's own way of telling a reader built against the old array
	 * format to stop. A converter that read it literally would report a
	 * catalogue of two and never be told it was wrong — so this refuses it by
	 * name, in a sentence that says where the real index is, rather than
	 * accepting a body that is genuinely valid JSON and genuinely not a
	 * catalogue.
	 */
	parseIndex(body: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		if (isStubIndex(decoded)) {
			// **`ForeignIndexError`, not `ForeignFormatError`, and that is the
			// whole point of recognising the stub at all.** A format refusal
			// means "not mine, try the next adapter", and the next adapter here
			// would take it: this stub is a JSON array of
			// `{name, pkg, apk, lang, version, sources}`, which is *exactly* the
			// shape the sibling Kotlin format publishes. It would parse
			// cleanly, and a viewer would be shown a two-entry catalogue whose
			// rows are called "Outdated App" and "Update to Mihon 0.20.1+".
			//
			// An index error is the one detection propagates, because an
			// adapter that recognised a body and found it unusable is answering
			// the question rather than declining it. So the sentence below wins
			// over a silent, wrong success — which is the failure this whole
			// path exists to prevent.
			throw new ForeignIndexError(
				'This is index.min.json, the deprecated stub this ecosystem still serves at that ' +
					'path — two placeholder rows telling an old reader to update, not a catalogue. ' +
					'index.pb, published beside it, is the real index.'
			);
		}

		// Nothing else this format publishes is text at all.
		throw new ForeignFormatError('not a Mihon index');
	},

	/**
	 * The real door: a gzipped protobuf, decoded per the wire schema this
	 * catalogue publishes (see this file's header).
	 *
	 * ## Why this is declared to return a `Promise` although
	 * `ForeignAdapter.parseIndexBytes` is typed to return a bare
	 * `RepositoryIndex`
	 *
	 * `isGzip`/`gunzip` in `protobuf.ts` are built on `DecompressionStream`,
	 * which is the right primitive per that file's own header — the platform's
	 * own decompressor, native in every browser this client supports and in
	 * Node, so no inflater is bundled — and which has no synchronous form on
	 * any of those platforms. There is no way to gunzip this index without
	 * awaiting something.
	 *
	 * `loadForeignIndex` already calls this through `Promise.resolve(...)`,
	 * which flattens a returned thenable correctly at runtime regardless of
	 * what the interface declares; what is actually missing is the interface
	 * signature itself; this file cannot widen it (`formats.ts`, `adapter.ts`
	 * and the registry that will eventually list `mihonAdapter` alongside the
	 * other five belong to whoever is mid-edit on them). So `mihonAdapter` here
	 * is typed `MihonAdapter`, not `ForeignAdapter` — see the alias above —
	 * and whoever wires this format into the registry will need to widen
	 * `ForeignAdapter.parseIndexBytes`'s return type to
	 * `RepositoryIndex | Promise<RepositoryIndex>` to type-check the addition.
	 */
	async parseIndexBytes(bytes: Uint8Array): Promise<RepositoryIndex> {
		let raw: Uint8Array;
		try {
			raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
		} catch (error) {
			if (error instanceof ProtobufError) {
				throw new ForeignFormatError(`not a Mihon index: ${error.message}`);
			}
			throw error;
		}

		let root: ProtoMessage;
		try {
			root = ProtoMessage.parse(raw);
		} catch (error) {
			if (error instanceof ProtobufError) throw new ForeignFormatError('not a Mihon index');
			throw error;
		}

		const extensionList = root.message(101);
		// The one field this format cannot publish an index without. Its
		// absence — from a body that decompressed and parsed as *some* valid
		// protobuf message, just not this schema's — is what lets detection move
		// on to the next adapter instead of reporting a broken Mihon repository.
		if (extensionList === undefined) throw new ForeignFormatError('not a Mihon index');

		const plugins: RepositoryPlugin[] = [];
		for (const extension of extensionList.messages(1)) {
			const listing = readExtension(extension);
			if (listing !== null) plugins.push(listing);
		}

		return keepMediums({
			name: root.string(1) ?? 'Mihon extensions',
			updatedAt: '',
			signingKey: root.string(3) ?? null,
			plugins,
			format: 'mihon' as ForeignFormat
		});
	},

	/**
	 * Not built yet.
	 *
	 * What it will need, once it is:
	 *
	 * - the source tree at the directory `sourceDirFromIconUrl` recovers onto
	 *   `origin.detail.sourceDir` above, fetched the way `aniyomi.ts`'s
	 *   `readExtensionSource` fetches this ecosystem's sibling one;
	 * - `readMihonBuildFile` (`mihon-build-file.ts`) to read the generator's
	 *   declarative block, since every one of these 1,396 listings declares an
	 *   **abstract** class — the concrete subclass the generator would
	 *   synthesise does not exist in the checked-in source at all, and that
	 *   file's header is the full account of why;
	 * - a driver that turns what the build file declares into that concrete
	 *   subclass before handing it to the same Kotlin translator `aniyomi.ts`
	 *   already uses, since the translator needs to see the class the
	 *   generator would have produced, not the abstract one actually on disk.
	 */
	async convert(_listing: RepositoryPlugin, _services: ConversionServices): Promise<Uint8Array> {
		throw new ForeignFormatError('Conversion for the Mihon format is not built yet.');
	}
};
