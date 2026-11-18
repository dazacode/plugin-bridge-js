/**
 * Tsundoku repositories — the novel sibling of `mihon.ts`, and the reason that
 * file's build-file reader and protobuf reader are not duplicated here.
 *
 * ## The same catalogue, one fork across
 *
 * A Tsundoku repository is a keiyoushi repository: `src/<lang>/<dir>/`, a
 * `keiyoushi { source { … } }` build block, `lib-multisrc/` templates, a
 * `repo` branch and an `index.pb`. Its index proto is mihon's schema with two
 * fork fields — `Resources.jarUrl` at 501 and `Extension.isNovel` at 8000 —
 * neither of which the manga reader needs, so both doors here delegate to
 * `mihonAdapter`'s parser and re-tag the origin. That delegation is the point:
 * two copies of a protobuf reader would drift, and the schema is *the same
 * schema*, not a lookalike.
 *
 * ## The negative, and why it is a package segment
 *
 * `index.min.json` here is a bare array of `{pkg, apk, …}` — exactly the shape
 * `aniyomi.ts` parses and exactly what a two-entry mihon stub looks like. The
 * distinguishing fact is in the package: every source in this ecosystem lives
 * under a `novelextension` segment, `…tachiyomi.novelextension.<lang>.<dir>`.
 * So a row that does not carry it is not this format's, and detection moves on
 * rather than claiming a manga catalogue and filing it as novels.
 *
 * `parseIndexBytes` holds the binary index to the same negative. The schema is
 * the sibling's and has no novel field, so the package is again the only
 * thing that says what a row is: every row must be under `novelextension`, and
 * a manga `index.pb` is refused for what it is rather than for its bytes.
 * Without that this door accepted *any* sibling index and filed it as novels,
 * and the sibling — which has no such negative — accepted every novel index
 * and filed it as manga; whichever was asked first won.
 *
 * ## What converts, and what does not
 *
 * The extension is translated exactly as `mihon.ts` translates one — from the
 * source tree, entry file first, template and helper modules behind it — with
 * one addition: the repository's `core/` helpers are read by the packages the
 * extension imports. Those are `SlugPath`, the archive inflater and the like,
 * and without them a member that merely calls `slugPath.absolute(…)` is
 * refused as an unresolved receiver for a file that exists in the tree.
 *
 * A listing whose directory is Java is refused by the file. `lib/secretstream`
 * is Java in more than one of these repositories, and a Kotlin wrapper around
 * it converts only as far as the wrapper; an extension whose *own* directory is
 * Java has nothing here to translate.
 *
 * ## Rule 9
 *
 * No hostname: the forge arrives through `git-hosts.ts` and `mihon.ts`'s own
 * CDN-shape reading.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates,
	type GitRepository
} from '@plugin-bridge/core/git-hosts';
import { obstacleSites } from '@plugin-bridge/core/obstacles';
import { packageBundle } from '@plugin-bridge/core/package';
import { attributionFrom } from '@plugin-bridge/core/attribution';
import {
	fetchExtensionSource,
	newSharedCache,
	readBuildGradle,
	type SharedCache
} from '@plugin-bridge/core/source-repo';
import { mihonAdapter } from './mihon';
import { readMihonBuildFile } from './mihon-build-file';
import { libraryFileSource } from './library-shims';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** The segment every package in this ecosystem carries. */
const NOVEL_PACKAGE = /(?:^|\.)novelextension(?:\.|$)/i;

/** A pasted URL that already names a file. */
const INDEX_FILE = /\.(?:pb|json)$/i;

/** The one negative a JSON row can be checked by. */
function novelRows(decoded: unknown): decoded is Record<string, unknown>[] {
	if (!Array.isArray(decoded) || decoded.length === 0) return false;
	return decoded.every((entry) => {
		if (typeof entry !== 'object' || entry === null) return false;
		const pkg = (entry as Record<string, unknown>)['pkg'];
		return typeof pkg === 'string' && NOVEL_PACKAGE.test(pkg);
	});
}

/** One parsed listing, as this format's origin rather than the sibling's. */
function asNovel(listing: RepositoryPlugin): RepositoryPlugin {
	if (listing.origin === undefined) return listing;
	return {
		...listing,
		origin: {
			...listing.origin,
			format: 'tsundoku',
			mediaKind: 'novel',
			mediaKinds: ['novel']
		}
	};
}

/**
 * `src/<lang>/<dir>`, from `…novelextension.<lang>.<dir>`.
 *
 * The build plugin derives the application id from the directory, so the last
 * two segments are the address. Used only by the JSON door: the proto index
 * names the same place on its icon, which reads it directly.
 */
function sourceDirOf(pkg: string): string | null {
	const segments = pkg.split('.').filter((segment) => segment.length > 0);
	if (segments.length < 2) return null;
	return `src/${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
}

export const tsundokuAdapter: ForeignAdapter = {
	format: 'tsundoku',

	candidates(pasted: URL): string[] {
		if (looksLikeFile(pasted) || INDEX_FILE.test(pasted.pathname)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// `repo` first, as in the sibling format: publishing the built index on
		// a branch of that name is the convention, and trying it first saves
		// two round trips on the common case.
		return ['index.pb', 'index.min.json'].flatMap((path) =>
			rawCandidates(repository, path, ['repo', ...DEFAULT_REFS])
		);
	},

	/** The text door: an array, refused unless every row is a novel package. */
	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (!novelRows(decoded)) throw new ForeignFormatError('not a Tsundoku extension index');

		const apkBase = new URL('apk/', indexUrl);
		let repository: string | null = null;
		try {
			const parsed = parseRepositoryUrl(new URL(indexUrl));
			if (parsed !== null) repository = `${parsed.origin}/${parsed.owner}/${parsed.repo}`;
		} catch {
			repository = null;
		}

		const plugins: RepositoryPlugin[] = [];
		for (const row of decoded) {
			const pkg = String(row['pkg'] ?? '');
			const apk = String(row['apk'] ?? '');
			if (pkg.length === 0 || apk.length === 0) continue;

			const declared = Array.isArray(row['sources']) ? row['sources'] : [];
			const names = declared
				.map((source) =>
					typeof source === 'object' && source !== null
						? String((source as Record<string, unknown>)['name'] ?? '').trim()
						: ''
				)
				.filter((name) => name.length > 0);

			plugins.push(
				foreignListing({
					id: convertedPluginId('tsundoku', pkg),
					name: String(row['name'] ?? pkg),
					description: [...new Set(names)].join(', '),
					version: String(row['version'] ?? '0'),
					author: '',
					language: typeof row['lang'] === 'string' ? row['lang'] : null,
					hosts: hostsFromUrls(
						declared.map((source) =>
							typeof source === 'object' && source !== null
								? String((source as Record<string, unknown>)['baseUrl'] ?? '')
								: ''
						)
					),
					origin: {
						format: 'tsundoku',
						artifactUrl: new URL(apk, apkBase).toString(),
						foreignId: pkg,
						foreignVersion: String(row['version'] ?? '0'),
						mediaKind: 'novel',
						mediaKinds: ['novel'],
						isNsfw: row['nsfw'] === 1 || row['nsfw'] === true,
						detail: { sourceRepository: repository, sourceDir: sourceDirOf(pkg) }
					}
				})
			);
		}

		return {
			name: 'Tsundoku extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			// Every row is novel, and `novel` is a medium this build has nowhere
			// to show yet — but the rows are *kept* rather than filtered, because
			// a repository that browses to an empty page says less than one whose
			// rows each explain via `refusalFor` that the medium is the reason.
			filteredOut: 0,
			format: 'tsundoku'
		};
	},

	/**
	 * The binary door, delegated to the sibling that reads this schema.
	 *
	 * The sibling's parser answers `mihon` origins; they are re-tagged here, so
	 * the one difference between the two formats in this document — the fork
	 * field that says every row is a novel — is read by the *format*, from the
	 * proto, rather than by a second reader of the same bytes.
	 */
	async parseIndexBytes(bytes: Uint8Array, indexUrl: string): Promise<RepositoryIndex> {
		const index = await mihonAdapter.parseIndexBytes!(bytes, indexUrl);
		const novel = index.plugins.every((listing) =>
			NOVEL_PACKAGE.test(listing.origin?.foreignId ?? '')
		);
		if (!novel) throw new ForeignFormatError('not a Tsundoku extension index');
		const plugins = index.plugins.map(asNovel);
		if (plugins.length === 0) throw new ForeignFormatError('not a Tsundoku extension index');
		return { ...index, plugins, filteredOut: 0, format: 'tsundoku' };
	},

	/** `repo.json` beside the index carries the repository's name. */
	async loadIndex(body: string, indexUrl: string, getText: (url: string) => Promise<string>) {
		const index = this.parseIndex(body, indexUrl);
		try {
			const meta = JSON.parse(await getText(new URL('repo.json', indexUrl).toString())) as {
				meta?: { name?: unknown };
			};
			const name = meta.meta?.name;
			return typeof name === 'string' && name.length > 0 ? { ...index, name } : index;
		} catch {
			return index;
		}
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'tsundoku') {
			throw new ForeignFormatError('That listing did not come from a Tsundoku repository.');
		}
		const detail = origin.detail ?? {};

		const repositoryUrl =
			typeof detail['sourceRepository'] === 'string' ? detail['sourceRepository'] : '';
		const sourceDir = typeof detail['sourceDir'] === 'string' ? detail['sourceDir'] : '';
		if (repositoryUrl.length === 0 || sourceDir.length === 0) {
			throw new ForeignFormatError(
				`The index does not say where ${listing.name} is built from, and the published artifact ` +
					'is Android bytecode this build cannot read.'
			);
		}
		const [, lang, directory] = sourceDir.split('/');
		if (lang === undefined || directory === undefined) {
			throw new ForeignFormatError(`The source location for ${listing.name} could not be read.`);
		}

		const repository = parseRepositoryUrl(new URL(repositoryUrl));
		if (repository === null)
			throw new ForeignFormatError(`Where ${listing.name} is built from could not be read.`);

		const wanted = rawCandidates(repository, `${sourceDir}/`, DEFAULT_REFS)[0];
		if (wanted !== undefined) {
			const listed = await services.listFiles(wanted).catch(() => [] as readonly string[]);
			if (listed.length > 0) {
				const kotlin = listed.filter((url) => /\.kt$/i.test(new URL(url).pathname));
				const java = listed.find((url) => /\.java$/i.test(new URL(url).pathname));
				// An extension directory with Java in it is one this front-end
				// cannot read. Saying so by the file is the point: "not found"
				// would send a reader looking for a directory that is right there.
				if (kotlin.length === 0 && java !== undefined) {
					const file = new URL(java).pathname.split('/').pop() ?? 'a .java file';
					throw new ForeignFormatError(
						`${listing.name} is Java, not Kotlin: \`${file}\` is the entry. This build has no Java front-end.`,
						[`\`${file}\` (Java)`]
					);
				}
			}
		}

		const source = await fetchExtensionSource(
			{ repositoryUrl, lang, directory },
			services.listFiles,
			services.getText,
			sharedCacheFor(repositoryUrl)
		);
		if (source.kotlinFiles.size === 0) {
			throw new ForeignFormatError(
				`The source for ${listing.name} could not be found in the repository it is built from.`
			);
		}

		const build = readMihonBuildFile(source.buildGradle ?? '');
		const declaredPackage = build.pkgName ?? `${lang}.${directory}`;
		if (!origin.foreignId.endsWith(`.${declaredPackage}`)) {
			throw new ForeignFormatError(
				`The source directory read for ${listing.name} (${sourceDir}) builds a different extension, ` +
					'so where it is built from is not known.'
			);
		}

		// The entry class the generator would have emitted, by the name the
		// build file declares; the `@Source` annotation when a fork leaves the
		// extension named there, and a class with a supertype last.
		const extClass = (readBuildGradle(source.buildGradle ?? '')['extClass'] ?? '').replace(
			/^\./,
			''
		);
		const named = extClass.length > 0 ? new RegExp(`\\bclass\\s+${escape(extClass)}\\b`) : null;
		const own = [...source.kotlinFiles]
			.map(([path, text]) => ({ path, source: text }))
			.sort((a, b) => {
				const rank = (file: { source: string }): number => {
					if (named !== null && named.test(file.source)) return 0;
					if (/(^|\n)\s*@Source\b/.test(file.source)) return 1;
					return /class\s+\w+\s*(\([^)]*\))?\s*:\s*\w/.test(file.source) ? 2 : 3;
				};
				return rank(a) - rank(b) || (a.path < b.path ? -1 : 1);
			});

		const theme = [...source.themeFiles].map(([path, text]) => ({
			path: `theme/${path}`,
			source: text
		}));
		const modules = [...source.libModules]
			.sort((a, b) => (a[0] < b[0] ? -1 : 1))
			.flatMap(([name, files]) =>
				[...files].map(([path, text]) => ({
					path: `lib/${name}/${path}`,
					source: libraryFileSource(name, path, text)
				}))
			);
		const core = [...source.coreFiles].map(([path, text]) => ({
			path: `core/${path}`,
			source: text
		}));
		const helpers = await readImportedCore(
			repository,
			source.resolvedRef,
			[...own, ...theme, ...modules].map((file) => file.source),
			services
		);

		const files = [...own, ...theme, ...modules, ...core, ...helpers];
		const { translateKotlin } = await import('@plugin-bridge/core/kotlin/translate-host');
		const conversion = await translateKotlin(files, {
			wasm: services.loadWasm,
			createWorker: services.createTranslateWorker
		});

		if (conversion.className === null) {
			throw new ForeignFormatError(
				`No extension class could be read out of ${listing.name}'s source.`
			);
		}
		if (!conversion.complete) {
			const kinds = new Set<string>();
			for (const refusal of conversion.blocking) {
				for (const obstacle of refusal.obstacles) kinds.add(obstacle.kind);
			}
			throw new ForeignFormatError(
				`${listing.name} could not be translated: ${[...kinds].sort().join(', ')}.`,
				[...kinds].sort(),
				obstacleSites(conversion, files)
			);
		}
		if (!conversion.substantive) {
			throw new ForeignFormatError(
				`${listing.name} translates, but none of what it declares is a member this build would ever call.`
			);
		}

		const declaredSource = build.sources.find((one) => one.lang === lang) ?? build.sources[0];
		const baseUrl =
			declaredSource?.baseUrl?.kind === 'static'
				? declaredSource.baseUrl.url
				: declaredSource?.baseUrl?.kind === 'mirrors'
					? declaredSource.baseUrl.urls[0]
					: (declaredSource?.baseUrl?.url ?? '');
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
			name: declaredSource?.name ?? build.name ?? listing.name,
			// Novel chapters are text: `fetchPageText` supersedes the image
			// members in the driver, which is the whole of the difference.
			dialect: 'tsundoku'
		});

		const hosts = [...new Set([...hostsFromUrls([baseUrl]), ...listing.hosts])].sort();
		const credit = attributionFrom({
			sourceRepositoryUrl: repositoryUrl,
			licenseText: null,
			fallbackAuthor: listing.author
		});

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description: 'Converted Tsundoku source.',
			version: listing.version,
			author: credit.author,
			hosts,
			origin,
			entrypointSource,
			usesCookies: true,
			repository: credit.repository,
			authorUrl: credit.authorUrl
		});
	}
};

/** Nothing in a Kotlin class name is a regex metacharacter; this keeps it that way. */
function escape(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `core/` files the extension actually imports, by the symbol it names.
 *
 * `source-repo.ts` selects only an imported *capitalised symbol used as a
 * receiver*, which misses a helper called as an extension — `SlugPath(…)`
 * constructed nearby then `.absolute(…)` — and misses a lowercase factory.
 * Matching the imported *name* against a declaration in the file is narrower
 * than reading a whole package, which matters here: `keiyoushi.utils` also
 * holds the WebView and archive helpers, and pulling all of it in blocks every
 * extension on `Handler` and `InflaterSource` whichever one it uses.
 */
async function readImportedCore(
	repository: GitRepository,
	ref: string | null,
	sources: readonly string[],
	services: ConversionServices
): Promise<{ path: string; source: string }[]> {
	const wanted = new Map<string, Set<string>>();
	for (const source of sources) {
		for (const match of source.matchAll(/^import\s+((keiyoushi\.[\w.]+))/gm)) {
			const whole = match[1];
			const cut = whole.lastIndexOf('.');
			const pkg = whole.slice(0, cut);
			const symbol = whole.slice(cut + 1);
			if (symbol.length === 0) continue;
			// `keiyoushi.network` is a thin wrapper over the okhttp expressions
			// the runtime already answers (`client.newCall`, `POST(…)`), and its
			// file drags the okio `.sink()`/`.exists()` extensions in with it.
			// Reading it buys nothing the driver does not already supply.
			if (pkg === 'keiyoushi.network') continue;
			// `KeiSource` is a *supertype*, not a library: the driver supplies
			// its behaviour and `mihon.ts` detects it off the class header. Its
			// file is also the one full of Android reflection
			// (`javaClass.simpleName`), which would block every extension that
			// merely extends it.
			if (pkg === 'keiyoushi.source') continue;
			const names = wanted.get(pkg) ?? new Set<string>();
			names.add(symbol);
			wanted.set(pkg, names);
		}
	}
	if (wanted.size === 0) return [];

	const base = rawCandidates(repository, 'core/', [ref ?? DEFAULT_REFS[0]])[0];
	if (base === undefined) return [];
	const listed = await services.listFiles(base).catch(() => [] as readonly string[]);
	const out: { path: string; source: string }[] = [];
	for (const url of listed.slice(0, 96)) {
		if (out.length >= 20) break;
		if (!/\.kt$/i.test(new URL(url).pathname)) continue;
		const body = await services.getText(url).catch(() => '');
		const declared = /^package\s+([\w.]+)/m.exec(body)?.[1];
		if (declared === undefined) continue;
		const names = wanted.get(declared);
		if (names === undefined) continue;
		const hit = [...names].some((name) =>
			new RegExp(
				`\\b(?:class|object|interface|fun(?:\\s*<[^>]+>)?|val|var)\\s+(?:[\\w<>.?]+\\.)?${name}\\b`
			).test(body)
		);
		if (hit) out.push({ path: `core/${url.slice(base.length)}`, source: body });
	}
	return out;
}

/**
 * One shared template cache per repository, for the length of the session.
 *
 * Lifted from `aniyomi.ts` unchanged, and for its reason: a template is read
 * once per repository rather than once per listing that names it.
 */
const SHARED_BY_REPOSITORY = new Map<string, SharedCache>();

function sharedCacheFor(repositoryUrl: string): SharedCache {
	const existing = SHARED_BY_REPOSITORY.get(repositoryUrl);
	if (existing !== undefined) return existing;
	if (SHARED_BY_REPOSITORY.size >= 32) {
		const oldest = SHARED_BY_REPOSITORY.keys().next();
		if (oldest.done !== true) SHARED_BY_REPOSITORY.delete(oldest.value);
	}
	const created = newSharedCache();
	SHARED_BY_REPOSITORY.set(repositoryUrl, created);
	return created;
}

/** Kept for the spec: a conversion must not inherit another case's cache. */
export function forgetTsundokuCaches(): void {
	SHARED_BY_REPOSITORY.clear();
}
