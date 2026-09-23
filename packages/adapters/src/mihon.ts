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
	hostsInSource,
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
import { packageBundle } from '@plugin-bridge/core/package';
import { gunzip, isGzip, ProtobufError, ProtoMessage } from '@plugin-bridge/core/protobuf';
import { obstacleSites } from '@plugin-bridge/core/obstacles';
import { newSharedCache } from '@plugin-bridge/core/source-repo';
import { readMihonBuildFile } from './mihon-build-file';
import type { ForeignFormat } from '@plugin-bridge/core/formats';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** A pasted URL that already names the binary index, not appended to. */
const INDEX_PB = /\.pb$/i;

/** The two placeholder rows the deprecated `index.min.json` still serves. */
const STUB_NAMES = new Set(['Outdated App', 'Update to Mihon 0.20.1+']);
const STUB_PACKAGE_SUFFIXES = ['.extension.all.keiyoushi', '.extension.all.mihon'];
const SHARED = newSharedCache();

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
 * The source directory the package name implies, for a listing whose icon is
 * not its own.
 *
 * An extension that ships no launcher icon of its own is published with the
 * icon of whatever it inherits one from — its theme's
 * (`lib-multisrc/<theme>/res/…`) or the repository's default
 * (`core/src/main/res/…`) — so `sourceDirFromIconUrl` reads nothing for it,
 * and forty-odd listings in the real catalogue were refused as not saying
 * where they are built from although their directory is right there.
 *
 * The package name says it instead, and not by resemblance: the build plugin
 * *derives* the application id from the directory, as the namespace plus
 * `<lang>.<dir>`. The one exception is a module that declares `pkgName` to
 * keep an old id across a rename, which is exactly the case where this
 * reading names a directory that is not the module's — so `convert` checks the
 * build file it then fetches against the package, and refuses rather than
 * translate whatever else lives at that path. Only the last two segments are
 * read, so a fork publishing under its own namespace is read the same way.
 */
const PACKAGE_SOURCE_DIR = /\.([a-z0-9_-]+)\.([a-z0-9_]+)$/i;

function sourceDirFromPackage(packageName: string): string | null {
	const match = PACKAGE_SOURCE_DIR.exec(packageName);
	return match === null ? null : `src/${match[1]}/${match[2]}`;
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
				// From the icon when the icon is the module's own; from the package
				// name when it is borrowed, which is only meaningful when the icon
				// still says which repository to read (see `sourceDirFromPackage`).
				sourceDir:
					sourceDirFromIconUrl(resources?.string(2)) ??
					(sourceRepositoryFromIconUrl(resources?.string(2)) === null
						? null
						: sourceDirFromPackage(packageName)),
				// Where that directory lives, and at which ref. The index is a
				// list of built artifacts and names no source location; the icon
				// is served from a CDN mirroring the source repository, so the
				// one field carries both halves of the address.
				sourceRepository: sourceRepositoryFromIconUrl(resources?.string(2)),
				sources
			}
		}
	});
}

/** The repository an extension's source lives in, from the same icon URL. */
const ICON_URL_REPOSITORY = /^https?:\/\/cdn\.jsdelivr\.net\/gh\/([^/@]+)\/([^/@]+)@([^/]+)\//;

/**
 * Where to fetch the Kotlin from, recovered from the icon URL.
 *
 * The index publishes no source location — it is a list of built artifacts —
 * but every listing's icon is served from a CDN that mirrors the *source*
 * repository at a ref, so the one field says which repository, which fork and
 * which commit the extension was built from. Read together with
 * `sourceDirFromIconUrl`, it is the whole address.
 *
 * A ref is carried through rather than dropped because it pins the read: a
 * repository whose default branch moved between publishing the index and
 * converting from it would otherwise translate a file the listing was not
 * built from.
 */
function sourceRepositoryFromIconUrl(iconUrl: string | undefined): string | null {
	if (iconUrl === undefined) return null;
	const match = ICON_URL_REPOSITORY.exec(iconUrl);
	if (match === null) return null;
	const [, owner, repository, ref] = match;
	if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repository) || !/^[\w./-]+$/.test(ref)) {
		return null;
	}
	return `https://github.com/${owner}/${repository}/tree/${ref}`;
}

/**
 * The file whose class the translator should treat as the extension.
 *
 * Every listing in this catalogue annotates exactly one class `@Source`, and
 * upstream's own build refuses a module with more than one — so this is not a
 * heuristic, it is the ecosystem's own rule read off the source. It matters
 * because `convertKotlin` takes the *first* file's class as the extension, and
 * these modules routinely ship a DTO file whose name sorts earlier.
 */
function entryFirst(files: readonly { path: string; source: string }[]): typeof files {
	const entry = files.findIndex((file) => /(^|\n)\s*@Source\b/.test(file.source));
	if (entry <= 0) return files;
	return [files[entry], ...files.filter((_, at) => at !== entry)];
}

/**
 * The supertypes each class in these files names, by simple name.
 *
 * Read off the declaration header — the text between `class Name` and the
 * body's `{`, with the constructor's parentheses skipped — which is exactly
 * where Kotlin puts them. Only the head identifier of each supertype is kept,
 * so `KeiSource()`, `ConfigurableSource` and `Madara(…)` read as those names.
 * A class declared twice under one name in different files keeps both lists,
 * which can only make an answer below *more* inclusive for a name the
 * translator would have had to resolve anyway.
 */
function supertypesByClass(files: readonly { source: string }[]): Map<string, string[]> {
	const out = new Map<string, string[]>();
	const declaration = /\bclass\s+([A-Za-z_]\w*)/g;
	for (const { source } of files) {
		for (const match of source.matchAll(declaration)) {
			let depth = 0;
			let colon = -1;
			let end = source.length;
			for (let at = (match.index ?? 0) + match[0].length; at < source.length; at += 1) {
				const char = source[at];
				if (char === '(' || char === '<') depth += 1;
				else if (char === ')' || char === '>') depth -= 1;
				else if (depth === 0 && char === ':' && colon === -1) colon = at;
				else if (depth === 0 && char === '{') {
					end = at;
					break;
				} else if (depth === 0 && char === '\n' && colon !== -1) {
					// A class with no body ends at its line, unless the list of
					// supertypes is still open — a trailing comma, or a colon with
					// nothing after it yet.
					const written = source.slice(colon + 1, at).trim();
					if (written.length > 0 && !written.endsWith(',')) {
						end = at;
						break;
					}
				}
			}
			if (colon === -1) continue;
			const names = [...source.slice(colon + 1, end).matchAll(/(?:^|,)\s*([A-Za-z_][\w.]*)/g)].map(
				(one) => one[1].split('.').pop() ?? one[1]
			);
			out.set(match[1], [...(out.get(match[1]) ?? []), ...names]);
		}
	}
	return out;
}

/**
 * Whether the extension class descends from keiyoushi's `KeiSource`, through
 * its template or directly.
 *
 * Walked over the files the conversion translated rather than guessed from a
 * member it happens to declare, because the base class decides behaviour the
 * extension never states — the `Referer` on every request, where its rate
 * limit is applied — and an extension that declares no hook at all is still
 * one. See `MihonEntrypointOptions.keiSource`.
 */
function descendsFromKeiSource(files: readonly { source: string }[], className: string): boolean {
	const supertypes = supertypesByClass(files);
	const seen = new Set<string>();
	const pending = [className];
	while (pending.length > 0) {
		const name = pending.pop()!;
		if (seen.has(name)) continue;
		seen.add(name);
		for (const parent of supertypes.get(name) ?? []) {
			if (parent === 'KeiSource') return true;
			pending.push(parent);
		}
	}
	return false;
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
	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'mihon') {
			throw new ForeignFormatError('That listing did not come from a Mihon repository.');
		}
		const detail = origin.detail ?? {};

		const sourceDir = detail['sourceDir'];
		const repositoryUrl = detail['sourceRepository'];
		if (typeof sourceDir !== 'string' || typeof repositoryUrl !== 'string') {
			throw new ForeignFormatError(
				`This repository does not say where ${listing.name} is built from, and the published ` +
					'artifact is Android bytecode this build cannot read.'
			);
		}

		// `src/<lang>/<directory>`, which is the layout `source-repo.ts` already
		// knows — the two ecosystems share it, which is why that file serves
		// both rather than having been copied for the second.
		const [, lang, directory] = sourceDir.split('/');
		if (lang === undefined || directory === undefined) {
			throw new ForeignFormatError(`The source location for ${listing.name} could not be read.`);
		}

		const { fetchExtensionSource } = await import('@plugin-bridge/core/source-repo');
		const source = await fetchExtensionSource(
			{ repositoryUrl, lang, directory },
			services.listFiles,
			services.getText,
			SHARED
		);
		if (source.kotlinFiles.size === 0) {
			throw new ForeignFormatError(
				`The source for ${listing.name} could not be found in the repository it is built from.`
			);
		}

		// **The directory has to be this listing's**, which the package name
		// checks: the build plugin makes the application id from `pkgName` when
		// a module declares one and from `<lang>.<dir>` when it does not. A
		// directory recovered from the package name of a renamed module would
		// otherwise be a different extension, translated and installed under
		// this one's name — refusing is the honest answer to a path this
		// adapter could only have guessed.
		const declaredPackage =
			readMihonBuildFile(source.buildGradle ?? '').pkgName ?? `${lang}.${directory}`;
		if (!origin.foreignId.endsWith(`.${declaredPackage}`)) {
			throw new ForeignFormatError(
				`The source directory read for ${listing.name} (${sourceDir}) builds a different ` +
					'extension, so where it is built from is not known.'
			);
		}

		// The extension, then its template, then the shared modules — the order
		// `convertKotlin` reads as "entry first, neighbours after". Sorted
		// within each group so the same extension read twice hands the
		// translator the same files in the same order: a refusal naming a
		// different member on a second run is a bug nobody can reproduce.
		const own = entryFirst([...source.kotlinFiles].map(([path, text]) => ({ path, source: text })));
		const theme = [...source.themeFiles].map(([path, text]) => ({
			path: `theme/${path}`,
			source: text
		}));
		const modules = [...source.libModules]
			.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			.flatMap(([name, files]) =>
				[...files].map(([path, text]) => ({ path: `lib/${name}/${path}`, source: text }))
			);
		const core = [...source.coreFiles].map(([path, text]) => ({
			path: `core/${path}`,
			source: text
		}));

		const kotlin = [...own, ...theme, ...modules, ...core];
		const { translateKotlin } = await import('@plugin-bridge/core/kotlin/translate-host');
		const conversion = await translateKotlin(kotlin, {
			wasm: services.loadWasm,
			createWorker: services.createTranslateWorker
		});

		if (conversion.className === null) {
			throw new ForeignFormatError(
				`No extension class could be read out of ${listing.name}'s source.`
			);
		}
		if (!conversion.complete) {
			// Each kind once per listing, so a caller counting them counts
			// listings a fix would unblock rather than how often a construct
			// appears — `FOREIGN.md` §4.1.4's distinction, and the one that
			// produced the negative result about extractor modules.
			const kinds = new Set<string>();
			for (const refusal of conversion.blocking) {
				for (const obstacle of refusal.obstacles) kinds.add(obstacle.kind);
			}
			throw new ForeignFormatError(
				`${listing.name} could not be translated: ${[...kinds].sort().join(', ')}.`,
				[...kinds].sort(),
				obstacleSites(conversion, kotlin)
			);
		}
		if (!conversion.substantive) {
			// Everything declared translated and none of it is a member the host
			// would ever call: every method it runs lives in a base class this
			// conversion could not read. Installing it produces a source that
			// searches and finds nothing.
			throw new ForeignFormatError(
				`${listing.name} translates, but none of what it declares is a member this build ` +
					'would ever call.'
			);
		}

		// **The base URL comes from the build file, not from a heuristic.** The
		// sibling format has to read a constant out of the Kotlin and guess
		// among several spellings when it cannot; here the generated subclass
		// upstream would have supplied it, and the declaration it is generated
		// *from* is a literal in a file this conversion already fetched.
		const build = readMihonBuildFile(source.buildGradle ?? '');
		const declared = build.sources.find((one) => one.lang === lang) ?? build.sources[0];
		const baseUrl =
			declared?.baseUrl?.kind === 'static'
				? declared.baseUrl.url
				: declared?.baseUrl?.kind === 'mirrors'
					? declared.baseUrl.urls[0]
					: (declared?.baseUrl?.url ?? '');
		if (!baseUrl.startsWith('https://')) {
			throw new ForeignFormatError(
				`${listing.name} declares no https base URL that can be read without running it.`
			);
		}

		const { mihonEntrypoint } = await import('@plugin-bridge/runtime/shims/mihon-entry');
		const entrypointSource = mihonEntrypoint({
			pluginId: listing.id,
			translatedSource: conversion.js,
			className: conversion.className,
			baseUrl,
			lang,
			keiSource: descendsFromKeiSource(kotlin, conversion.className),
			// The `.properties` files this extension's own repository keeps
			// beside its Kotlin, which `Intl` reads through the classloader. An
			// extension with none passes an empty map and the classpath is
			// empty, which is what it was before they were fetched at all.
			resources: Object.fromEntries(source.resources)
		});

		// Over the emitted module rather than the Kotlin: the emitter has
		// already folded constants and concatenations, so more of the hosts
		// that will actually be reached are visible as literals in the output.
		const hosts = [...new Set([...listing.hosts, ...hostsInSource(conversion.js)])].sort();

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description: 'Converted Mihon source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource
		});
	}
};
