/**
 * Repositories published for Aniyomi, Anikku and their forks — and, in the
 * same file format, for their manga counterpart.
 *
 * `contract/plugin-api/FOREIGN.md` §4.1 is the normative account of why this
 * adapter browses and does not install. In short: the artifact is an Android
 * APK, and the APK ships only the extension's own classes. Everything it
 * actually runs on — the serialisation library, the coroutine runtime, the
 * Kotlin standard library, an HTML parser, an HTTP client, the crypto and
 * preference frameworks, a dependency-injection container, and in some cases an
 * embedded JavaScript engine — is supplied by the host app and is not in the
 * file. Converting DEX to JVM class files is a solved problem and does not
 * help: what is missing is the classpath, not the container.
 *
 * ## The index, and the second document beside it
 *
 * The listing file is a bare JSON **array**, so it carries no repository name
 * and no signing information. Both live in a sibling `repo.json`, which is why
 * this adapter implements `loadIndex`.
 *
 * That sibling is worth fetching for more than a display name: it carries the
 * SHA-256 fingerprint of the certificate the APKs are signed with. That is a
 * real trust anchor of exactly the shape `REPOSITORY.md` §5 already specifies
 * — pinned on first add, and an error rather than a prompt when it changes.
 *
 * ## Telling an anime repository from a manga one
 *
 * They use the same file format, so the format cannot say. The package name
 * can: an anime extension's package sits under an `animeextension` segment and
 * a manga one does not. Classifying on that means a manga repository still
 * browses in full and every row explains itself, instead of the whole URL being
 * rejected as unrecognised.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	keepMediums,
	hostsInSource,
	ForeignFormatError,
	pretranslatedDescriptor,
	type ConversionServices,
	type ForeignAdapter,
	type TextFetcher
} from '@plugin-bridge/core/adapter';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';
import { TreeError } from '@plugin-bridge/core/git-trees';
import { obstacleSites } from '@plugin-bridge/core/obstacles';
import { attributionFrom } from '@plugin-bridge/core/attribution';
import { namesCookieJar, packageBundle } from '@plugin-bridge/core/package';
import { settingKeyMap } from '@plugin-bridge/core/preferences';
import { aniyomiPreferences } from './aniyomi-preferences';
import { libraryFileSource, synchronyScriptOf } from './library-shims';
import {
	extensionDirectory,
	fetchExtensionSource,
	locationCandidates,
	newSharedCache,
	readBuildGradle,
	sourceRepositoryOf,
	type SharedCache
} from '@plugin-bridge/core/source-repo';
import { readKotlinFast, type KotlinConversion } from '@plugin-bridge/core/kotlin/pipeline';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { formatProfile } from '@plugin-bridge/core/formats';
import type { ForeignMedium } from '@plugin-bridge/core/formats';

/**
 * A prefix on the pinned key, so a certificate fingerprint is never mistaken
 * for the base64 SPKI Ed25519 key a native repository pins.
 *
 * They are both "the key this repository was added with", they are compared the
 * same way, and they are verified by entirely different machinery — so they
 * must not share a namespace.
 */
export const CERTIFICATE_KEY_PREFIX = 'apk-cert-sha256:';

interface AniyomiSource {
	readonly name?: unknown;
	readonly lang?: unknown;
	readonly baseUrl?: unknown;
}

function sources(value: unknown): AniyomiSource[] {
	return Array.isArray(value)
		? (value.filter((s) => typeof s === 'object' && s !== null) as AniyomiSource[])
		: [];
}

/**
 * Anime or manga, from the package name.
 *
 * Defaults to manga, deliberately. A package this build cannot classify is
 * more safely shown as "not an anime source" than offered as one: the first is
 * a listing someone can still read, the second is a promise we cannot keep.
 */
function mediaKindOfPackage(pkg: string): ForeignMedium {
	return /(^|\.)animeextension(\.|$)/.test(pkg) ? 'anime' : 'manga';
}

/**
 * Records where a listing's source lives, without disturbing anything else.
 *
 * On `origin.detail` rather than on the listing, because `detail` is defined as
 * "whatever else that format's converter needs, carried on the listing" — and
 * carrying it means a listing that outlives its index still converts to the
 * same bundle, which is what `formats.ts` requires of the field.
 */
function withSourceRepository(
	listing: RepositoryPlugin,
	sourceRepository: string
): RepositoryPlugin {
	if (listing.origin === undefined) return listing;
	return {
		...listing,
		origin: {
			...listing.origin,
			detail: { ...(listing.origin.detail ?? {}), sourceRepository }
		}
	};
}

export const aniyomiAdapter: ForeignAdapter = {
	format: 'aniyomi',

	candidates(pasted: URL): string[] {
		// A pasted URL that is already a file is used as given. Appending a
		// path to a file produces a URL that cannot exist and buries the real
		// failure under guaranteed 404s.
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// `repo` first: publishing the built listing on a branch of that name,
		// separate from the sources, is the convention this ecosystem settled on,
		// and trying it first saves two round trips on the common case.
		return ['index.min.json'].flatMap((path) =>
			rawCandidates(repository, path, ['repo', ...DEFAULT_REFS])
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		// The listing file is an array. Anything else is a different format, and
		// throwing here is what lets detection move on to the next adapter.
		if (!Array.isArray(decoded) || decoded.length === 0) {
			throw new ForeignFormatError('not an Aniyomi extension index');
		}

		const first = decoded[0] as Record<string, unknown>;
		if (typeof first['pkg'] !== 'string' || typeof first['apk'] !== 'string') {
			throw new ForeignFormatError('not an Aniyomi extension index');
		}

		// Artifacts sit in an `apk/` directory beside the index, which is the
		// layout the publishing tool produces. Resolved rather than assumed, so a
		// repository served from a subdirectory still works.
		const apkBase = new URL('apk/', indexUrl);

		const plugins = [];
		for (const entry of decoded) {
			if (typeof entry !== 'object' || entry === null) continue;
			const row = entry as Record<string, unknown>;
			const pkg = String(row['pkg'] ?? '');
			const apk = String(row['apk'] ?? '');
			if (pkg.length === 0 || apk.length === 0) continue;

			// Checked here, where the index is read, rather than at install time:
			// a descriptor the publisher got wrong is a fact about the listing,
			// and the browse list is where the user is told about it.
			const pretranslated = pretranslatedDescriptor(row['pretranslated']);

			const declared = sources(row['sources']);
			const baseUrls = declared.map((source) =>
				typeof source.baseUrl === 'string' ? source.baseUrl : null
			);
			// The one source's base url as the repository published it, kept for
			// the converter — see `publishedBaseUrl`. Only for a listing that
			// declares exactly one source: with several, which of them the
			// converted class is cannot be read off the index.
			const published =
				baseUrls.length === 1 && baseUrls[0] !== null && baseUrls[0].startsWith('https://')
					? baseUrls[0]
					: null;
			const detail = {
				...(pretranslated === null ? {} : { pretranslated }),
				...(published === null ? {} : { publishedBaseUrl: published })
			};

			plugins.push(
				foreignListing({
					id: convertedPluginId('aniyomi', pkg),
					// The published name carries a client-name prefix that is noise in
					// a list where every row has it.
					name: String(row['name'] ?? pkg).replace(/^\s*[A-Za-z]+:\s*/, ''),
					// De-duplicated: a single extension routinely declares several
					// sources that share one name, differing only in language, and
					// "X, X, X, X, X, X, X, X, X" is not a description of anything.
					description: [
						...new Set(
							declared
								.map((source) => (typeof source.name === 'string' ? source.name.trim() : ''))
								.filter((name) => name.length > 0)
						)
					].join(', '),
					version: String(row['version'] ?? '0'),
					author: '',
					language: typeof row['lang'] === 'string' ? row['lang'] : null,
					hosts: hostsFromUrls(baseUrls),
					origin: {
						format: 'aniyomi',
						artifactUrl: new URL(apk, apkBase).toString(),
						foreignId: pkg,
						foreignVersion: String(row['version'] ?? '0'),
						mediaKind: mediaKindOfPackage(pkg),
						isNsfw: row['nsfw'] === 1 || row['nsfw'] === true,
						...(Object.keys(detail).length === 0 ? {} : { detail })
					}
				})
			);
		}

		return keepMediums({
			// Replaced by `loadIndex` when the sibling metadata is readable. Left
			// as a plain description rather than a guess at the publisher's name.
			name: 'Aniyomi extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'aniyomi'
		});
	},

	async loadIndex(body: string, indexUrl: string, getText: TextFetcher): Promise<RepositoryIndex> {
		const index = this.parseIndex(body, indexUrl);

		// Metadata only. A repository that does not publish it is perfectly
		// usable, so this never fails the add — it just adds less.
		try {
			const siblingUrl = new URL('repo.json', indexUrl).toString();
			const sibling = await getText(siblingUrl);
			const meta = JSON.parse(sibling) as {
				meta?: { name?: unknown; signingKeyFingerprint?: unknown };
			};
			const name = meta.meta?.name;
			const fingerprint = meta.meta?.signingKeyFingerprint;

			// The published artifact is Android bytecode with its classpath
			// missing, but the same document names the repository the artifact
			// was *built* from — and that is readable Kotlin. Resolving it here,
			// while the metadata is in hand, is what later lets `convert` read a
			// program instead of reverse-engineering a binary; it is also the
			// only place the original author and their licence can be found, and
			// a derived work has to carry both (`FOREIGN.md` §5.1).
			const sourceRepository = sourceRepositoryOf(sibling);

			return {
				...index,
				name: typeof name === 'string' && name.length > 0 ? name : index.name,
				signingKey:
					typeof fingerprint === 'string' && /^[0-9a-f]{64}$/i.test(fingerprint)
						? `${CERTIFICATE_KEY_PREFIX}${fingerprint.toLowerCase()}`
						: null,
				plugins:
					sourceRepository === null
						? index.plugins
						: index.plugins.map((listing) => withSourceRepository(listing, sourceRepository))
			};
		} catch {
			return index;
		}
	},

	/**
	 * Converts by reading the extension's source, never its artifact.
	 *
	 * The published artifact is Android bytecode whose classpath is not in the
	 * file, so nothing here opens it. What the repository's own metadata gives
	 * us instead is where the source lives (`loadIndex` above), and that is a
	 * program we can read.
	 *
	 * ## What is fetched, and in what order
	 *
	 * The extension's own files, then its template, then the `lib/` modules its
	 * build file names. A themed extension's own file is often two constants and
	 * a flag — every method it actually runs is in the `lib-multisrc` template
	 * it extends — so converting without the template produces a bundle that
	 * installs, searches, and returns silence. Measured over a 254-extension
	 * catalogue, including the template *lowers* the count of conversions from
	 * 12 to 7 and raises the count that are genuinely substantive, because it
	 * stops those shells passing vacuously. The lower number is the true one.
	 *
	 * The `lib/` modules are `FOREIGN.md` §4.1.3 in force: they are per-host
	 * stream extractors, they cannot be shipped in this repository, and they are
	 * therefore translated onto the viewer's device out of the catalogue's own
	 * code. §4.1.6 recorded feeding them in as a negative result — the count
	 * went 4 to 0, because an extractor's refusals counted against every
	 * extension that merely named it. That is no longer what happens.
	 * `pipeline.ts` walks the call graph, so only the members the host can
	 * actually reach can block, and the same measurement re-run with
	 * reachability in place moves the count **7 to 7**: nothing is lost, and
	 * what changes is the *reason* a conversion is refused. An extension whose
	 * `videoListParse` calls `videosFromUrl` used to be refused for an
	 * unresolved symbol; now it is refused for whichever member of the extractor
	 * fails to translate — or converted, once none of them do.
	 */
	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'aniyomi') {
			throw new ForeignFormatError('That listing did not come from an Aniyomi repository.');
		}

		const detail = origin.detail ?? {};
		const repositoryUrl =
			typeof detail['sourceRepository'] === 'string' ? detail['sourceRepository'] : '';
		if (repositoryUrl.length === 0) {
			throw new ForeignFormatError(
				'This repository does not say where its extensions are built from, and the published ' +
					'artifact is Android bytecode this build cannot read. There is nothing here to convert.'
			);
		}

		const source = await readExtensionSource(
			repositoryUrl,
			origin.foreignId,
			listing.language,
			services
		);
		if (source === null) {
			throw new ForeignFormatError(
				`The source for ${listing.name} could not be found in the repository it is built from.`
			);
		}

		// Off the main thread where there is one to be off: translating is ~35ms
		// of synchronous work per listing, and a repository check runs it for
		// every listing in it. `translateKotlin` falls back to doing it inline
		// when there is no Worker, so the answer does not depend on where it ran.
		const { translateKotlin } = await import('@plugin-bridge/core/kotlin/translate-host');
		const conversion = await translateKotlin(source.files, {
			wasm: services.loadWasm,
			createWorker: services.createTranslateWorker
		});

		if (conversion.className === null) {
			throw new ForeignFormatError(
				`No extension class could be read out of ${listing.name}'s source.`
			);
		}
		if (!conversion.complete) {
			// Each kind once per listing, so a caller counting them is counting
			// listings a fix would unblock rather than how often a construct
			// happens to appear — the distinction `FOREIGN.md` §4.1.4 and §4.1.6
			// both turn on, and the one that produced the negative result about
			// extractor modules.
			const kinds = new Set<string>();
			for (const refusal of conversion.blocking) {
				for (const obstacle of refusal.obstacles) kinds.add(obstacle.kind);
			}
			// Built only here, on the path that is already failing. The sites are
			// for the person widening the translator; the kinds above are the
			// measurement. See `../obstacles.ts`.
			throw new ForeignFormatError(
				describeRefusal(listing.name, conversion),
				[...kinds].sort(),
				obstacleSites(conversion, source.files)
			);
		}
		if (!conversion.substantive) {
			// Everything it declared translated, and none of it was anything the
			// host calls. That is the shell case, and installing it would produce
			// a source that searches and finds nothing.
			throw new ForeignFormatError(
				`${listing.name} translates, but none of what it declares is a member this build would ` +
					'ever call — every method it runs lives in a base class this conversion could not read.'
			);
		}

		const { aniyomiEntrypoint } = await import('@plugin-bridge/runtime/shims/aniyomi-entry');
		const baseUrl =
			conversion.constants.stringConstants['baseUrl'] ||
			baseUrlFromSupertype(source.files[0]?.source ?? '') ||
			baseUrlFromPreference(source.files[0]?.source ?? '', conversion.constants.stringConstants) ||
			(conversion.superClass === 'AnimeSourceFactory'
				? baseUrlFromFactoryTarget(source.files, source.files[0]?.source ?? '')
				: '') ||
			baseUrlOfClass(source.files, conversion.className) ||
			publishedBaseUrl(detail);
		if (!baseUrl.startsWith('https://')) {
			throw new ForeignFormatError(
				`${listing.name} declares no https base URL that can be read without running it.`
			);
		}

		// What the extension says it can be configured with, read out of its own
		// `setupPreferenceScreen`. Statically, over the Kotlin the conversion
		// already has in hand, with the string constants the translator folded
		// as the way through `key = PREF_DOMAIN_KEY`. A declaration this build
		// cannot read produces no settings rather than a guessed one.
		const settings = aniyomiPreferences(
			source.files.map((file) => file.source).join('\n'),
			conversion.constants.stringConstants
		);

		const synchrony = synchronyScriptOf(conversion.js, source.resources);
		const entrypointSource = aniyomiEntrypoint({
			pluginId: listing.id,
			translatedSource: conversion.js,
			className: conversion.className,
			settingIds: settingKeyMap(settings),
			baseUrl,
			synchronyScript: synchrony?.text
		});

		// Over the *emitted* module, not the Kotlin: the emitter has already
		// folded constants and concatenations, so more of the hosts that will
		// actually be reached are visible as literals in the output.
		//
		// The emitted module and not the whole entrypoint, which is the shape
		// the other two adapters always had. An entrypoint is the extension
		// wrapped in *our* runtime, and the runtime is full of quoted strings
		// shaped like hostnames — `"String.fromCharCode"` and
		// `"String.fromCodePoint"`, which the deobfuscator matches on. Those
		// arrived on the consent screen as `string.fromcharcode` and
		// `string.fromcodepoint`, next to the real hosts, with nothing to tell a
		// viewer which were which. Nothing this build writes is ever a host the
		// extension will reach.
		const hosts = [...new Set([...listing.hosts, ...hostsInSource(conversion.js)])].sort();
		const credit = attributionFrom({
			sourceRepositoryUrl: repositoryUrl,
			licenseText: source.licenseText,
			fallbackAuthor: listing.author
		});

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description: 'Converted Aniyomi extension.',
			version: listing.version,
			author: credit.author,
			hosts,
			origin,
			settings,
			entrypointSource,
			// Granted by the **format**, not read off the extension.
			//
			// `formatProfile('aniyomi').implicitCookies` is true because this
			// format's own framework carries a jar on the shared client. The
			// dominant use is therefore implicit — an extension doing a
			// two-request session never writes a line about cookies — so reading
			// the translated module finds nothing and the session silently never
			// carries. `namesCookieJar` is still consulted, as the explicit half
			// of the same question, and stays useful for any format whose
			// framework makes no such guarantee.
			//
			// What this grants is only the constrained jar of `ABI.md` §2: per
			// plugin, per already-granted host, in memory, gone at unload, and
			// unreadable by plugin code. `loadForRequest` and `CookieManager`
			// are refused at conversion, so nothing here hands an extension a
			// cookie *API* — it gets the request continuity its own platform
			// would have given it, and nothing else.
			usesCookies: formatProfile('aniyomi').implicitCookies || namesCookieJar(conversion.js),
			license: credit.license,
			licenseText: source.licenseText ?? undefined,
			embedded: synchrony === undefined ? [] : [synchrony.path],
			repository: credit.repository,
			authorUrl: credit.authorUrl
		});
	}
};

/**
 * The base url the repository's own index publishes for the listing's one
 * source, asked last.
 *
 * Every reader above looks for the url in the Kotlin, and a template that
 * *computes* it finds nothing there: AnikotoTheme's `baseUrl` is a preference
 * whose default is `"https://${domainEntries.first()}"`, over a list the
 * extension passes by name — five listings refused for declaring no base url
 * while the bundle, run, would have built exactly the one the index names. The
 * index value is not a guess at that: the repository's build instantiates the
 * source and writes down its `baseUrl`, so it is the same default the running
 * extension starts from. Kept to a listing declaring a single source (see where
 * it is recorded), and only reached when the source itself says nothing
 * readable, so no url written in the Kotlin is ever overridden by it.
 */
function publishedBaseUrl(detail: Readonly<Record<string, unknown>>): string {
	const value = detail['publishedBaseUrl'];
	return typeof value === 'string' && value.startsWith('https://') ? value : '';
}

/**
 * The base url a multisrc theme takes as a constructor argument.
 *
 * `readKotlin` finds `override val baseUrl = "…"`, which is how a standalone
 * extension declares one. A themed extension does not declare it at all — it
 * hands the theme a language, a name and a url:
 *
 *     class Example : DooPlay("pt-BR", "Example", "https://…") { … }
 *
 * so the gate below read an empty string and refused an extension that names
 * its host perfectly clearly, one line into the file.
 *
 * Read off the class header rather than anywhere else in the file, and only
 * when the header carries exactly one https literal: this value becomes the
 * plugin's declared host, and a guess at which of several urls that should be
 * is not something to make on an extension's behalf. Two, or none, and the
 * refusal stands.
 */
function baseUrlFromSupertype(source: string): string {
	const header = /\bclass\s+\w+\s*(?:\([^)]*\))?\s*:([\s\S]{0,800}?)\{/.exec(source);
	if (header === null) return '';
	const found = [...header[1].matchAll(/"(https:\/\/[^"\s$]+)"/g)].map((one) => one[1]);
	return found.length === 1 ? found[0] : '';
}

/**
 * The base url of an extension whose domain is a *setting*.
 *
 * `override val baseUrl by preferences.delegate(PREF_DOMAIN, DOMAIN_DEFAULT)`
 * and `by lazy { preferences.getString(PREF_DOMAIN_KEY, DEFAULT)!! }` are how a
 * growing number of these let a viewer follow a source that moves. There is no
 * literal on the line, so the token reader saw no base url at all and the
 * listing was refused for declaring none — while the Kotlin declares one
 * perfectly well, one name along.
 *
 * The *default* is the right answer here and not a compromise: it is what the
 * extension itself resolves to until a viewer changes the setting, and the
 * converted plugin reads the same preference through the same default at run
 * time. So the manifest and the runtime agree, which is the property that
 * matters.
 *
 * Only a default that is already a literal https url. A default that is itself
 * computed is left alone rather than guessed at, and the honest refusal stands.
 */
function baseUrlFromPreference(
	source: string,
	constants: Readonly<Record<string, string>>
): string {
	const declared =
		/\boverride\s+val\s+baseUrl\b[^\n]*\bby\b([\s\S]{0,200}?)(?:\n\s*(?:override|private|internal|protected|public|val|var|fun|@)|\n\s*\})/.exec(
			source
		);
	if (declared === null) return '';
	for (const name of declared[1].matchAll(/\b([A-Z][A-Z0-9_]*)\b/g)) {
		const value = constants[name[1]];
		if (value !== undefined && value.startsWith('https://')) return value;
	}
	const literal = /"(https:\/\/[^"\s$]+)"/.exec(declared[1]);
	return literal === null ? '' : literal[1];
}

/**
 * The base url of the class the conversion chose, read off that class alone.
 *
 * The token reader takes the *first* class in the entry file as the one it
 * describes, and a file can open with something else: `class
 * SamatoDenVideosFactory : AnimeSourceFactory { … listOf(SamatoDenVideos()) }`
 * sits above `class SamatoDenVideos : AnimeHttpLegacySource() { override val
 * baseUrl = "https://…" }`. The emitter picks the second — it is the one that
 * constructs a base — while the reader had already read the first, found no
 * base url, and the listing was refused for declaring none.
 *
 * So the file declaring the chosen class is cut at that declaration and read
 * again, the same three ways the entry file is. Nothing is guessed: the
 * answer is a literal in that class, or in its header, or the literal default
 * of its domain setting, or nothing.
 */
function baseUrlOfClass(
	files: readonly { path: string; source: string }[],
	className: string
): string {
	const declaration = new RegExp(`\\bclass\\s+${escapeForRegExp(className)}\\b`);
	for (const file of files) {
		const at = declaration.exec(file.source);
		if (at === null) continue;
		const slice = file.source.slice(at.index);
		const constants = readKotlinFast(slice).stringConstants;
		const found =
			constants['baseUrl'] ||
			baseUrlFromSupertype(slice) ||
			baseUrlFromPreference(slice, constants);
		if (found.startsWith('https://')) return found;
	}
	return '';
}

/**
 * The base url of an extension published as an `AnimeSourceFactory`.
 *
 * A factory's own class declares no `baseUrl` at all — one factory hands back
 * several language variants of the *same* source, each a separate instance of
 * a sibling class, and the domain lives on that class instead
 * (`AnimeWorldIndiaFactory` naming `AnimeWorldIndia` nine times over is the
 * shape). `createSources()` is the only place that says which class the
 * factory actually builds, so the first constructor call it makes — skipping
 * the collection builders `listOf`/`arrayOf`/… have to be written with — names
 * the file to look in. Once that file is found, it is read exactly the way
 * the entry file already was: a literal, then the two computed forms above.
 */
function baseUrlFromFactoryTarget(
	files: readonly { path: string; source: string }[],
	entrySource: string
): string {
	const body = /\bfun\s+createSources\s*\([^)]*\)[\s\S]{0,4000}/.exec(entrySource)?.[0];
	if (body === undefined) return '';
	const collectionBuilders = new Set([
		'listOf',
		'mutableListOf',
		'arrayOf',
		'sequenceOf',
		'setOf',
		'buildList'
	]);
	for (const call of body.matchAll(/\b([A-Z]\w*)\s*\(/g)) {
		const name = call[1];
		if (collectionBuilders.has(name)) continue;
		const target = files.find((file) => new RegExp(`\\bclass\\s+${name}\\b`).test(file.source));
		if (target === undefined) continue;
		const found =
			readKotlinFast(target.source).stringConstants['baseUrl'] ||
			baseUrlFromSupertype(target.source) ||
			baseUrlFromPreference(target.source, readKotlinFast(target.source).stringConstants);
		if (found.startsWith('https://')) return found;
	}
	return '';
}

/**
 * Escapes a name read out of a foreign build file.
 *
 * `extClass` is attacker-influenced like every other value in that file, and it
 * is being put into a regular expression. Kotlin class names cannot contain
 * metacharacters, so this never changes a legitimate one — it is here so that a
 * malformed value fails to match rather than becoming a pattern of its own.
 */
function escapeForRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The refusal a person reads, naming members rather than categories. */
function describeRefusal(name: string, conversion: KotlinConversion): string {
	const members = [...new Set(conversion.blocking.map((refusal) => refusal.member))].sort();
	const obstacles = [
		...new Set(conversion.blocking.flatMap((refusal) => refusal.obstacles.map((one) => one.kind)))
	].sort();

	return (
		`${name} rewrites ${members.length} part${members.length === 1 ? '' : 's'} of its base class ` +
		`that this build would have to read as code: ${members.join(', ')}. ` +
		`It uses ${obstacles.join(', ')}. Converting it anyway would produce a plugin ` +
		'that looks like it works and does not.'
	);
}

/**
 * The extension's Kotlin, entry file first, with its template and its
 * extractor modules behind it.
 *
 * `convertKotlin` takes the first file's class as the extension, so the order
 * matters: a DTO sorted ahead of the source would translate the wrong class and
 * report it as complete. Everything shared goes after the extension's own files
 * for the same reason, and because `pipeline.ts` treats only the entry file's
 * members as roots — a shared file's members are kept when something reachable
 * calls them and pruned when nothing does.
 */
async function readExtensionSource(
	repositoryUrl: string,
	pkg: string,
	lang: string | null,
	services: ConversionServices
): Promise<{
	files: { path: string; source: string }[];
	licenseText: string | null;
	/** Non-Kotlin files the modules ship; see `library-shims.ts`. */
	resources: ReadonlyMap<string, string>;
} | null> {
	// The repository's own file list, fetched once and shared by every listing in
	// it. Two things come out of it, and both used to cost requests per listing:
	// which branch answers, and which of the guessed directories actually exist.
	const index = await repositoryFiles(repositoryUrl, services);

	// Carrying the resolved branch on the URL is what stops `rawCandidates`
	// probing `main` before `master` for all 254 listings — it puts the branch
	// that answered first. `parseRepositoryUrl` reads a ref out of `/tree/<ref>`
	// precisely so a caller who knows one can say so.
	const url =
		index === null ? repositoryUrl : `${repositoryUrl.replace(/\/+$/, '')}/tree/${index.ref}`;

	const candidates = locationCandidates(url, pkg, lang ?? 'all').filter((location) => {
		if (index === null) return true;
		const prefix = `${extensionDirectory(location)}/`;
		return index.paths.some((path) => path.startsWith(prefix));
	});

	for (const location of candidates) {
		const found = await fetchExtensionSource(
			location,
			services.listFiles,
			services.getText,
			sharedCacheFor(repositoryUrl)
		);
		if (found.kotlinFiles.size === 0) continue;

		const own = [...found.kotlinFiles].map(([path, source]) => ({
			path,
			source
		}));
		const theme = [...found.themeFiles].map(([path, source]) => ({
			path: `theme/${path}`,
			source
		}));
		// Sorted by module name, so the same extension read twice hands the
		// translator the same files in the same order — a refusal that named a
		// different member on a second run would be a bug nobody could reproduce.
		const modules = [...found.libModules]
			.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			.flatMap(([name, files]) =>
				[...files].map(([path, source]) => ({
					path: `lib/${name}/${path}`,
					source: libraryFileSource(name, path, source)
				}))
			);
		const core = [...found.coreFiles].map(([path, source]) => ({
			path: `core/${path}`,
			source
		}));

		// A class with a supertype is the extension; everything else beside it is
		// a DTO, a filter or a helper.
		// The build file names the entry class outright, and every extension in a
		// real catalogue declares it. That is an exact answer where the shape of
		// the code is only a guess — and the guess was wrong in a way that
		// mattered: a deep-link handler class also extends a supertype, so it
		// tied with the real source and won on whichever order the listing
		// happened to arrive in. The conversion then translated the handler,
		// found nothing untranslatable in it, and reported it complete.
		const extClass = (readBuildGradle(found.buildGradle ?? '')['extClass'] ?? '').replace(
			/^\./,
			''
		);
		const named =
			extClass.length > 0 ? new RegExp(`\\bclass\\s+${escapeForRegExp(extClass)}\\b`) : null;

		const rank = (file: { source: string }): number => {
			if (named !== null && named.test(file.source)) return 0;
			return /class\s+\w+\s*(\([^)]*\))?\s*:\s*\w/.test(file.source) ? 1 : 2;
		};
		own.sort((a, b) => rank(a) - rank(b));

		return {
			files: [...own, ...theme, ...modules, ...core],
			licenseText: await readLicence(repositoryUrl, services, index),
			resources: found.resources
		};
	}
	return null;
}

/**
 * The repository's own licence text, or null.
 *
 * Null is a real answer: a conversion is a derived work, and `NOASSERTION` has
 * to mean "we looked and did not find it" rather than "we did not look"
 * (`FOREIGN.md` §5.1). A repository that publishes no licence file gets the
 * honest answer, not a guessed identifier.
 */
async function readLicence(
	repositoryUrl: string,
	services: ConversionServices,
	/**
	 * The repository's own file list, when one was read.
	 *
	 * With it there is nothing to probe: the tree says whether a licence file
	 * exists, under which of the four names, and on which ref — so the request
	 * that gets made is one that can succeed. Without it the names are tried in
	 * turn, which is the old behaviour and still the answer for a repository
	 * whose tree no forge API would give up.
	 */
	index: RepositoryFiles | null
): Promise<string | null> {
	const repository = parseRepositoryUrl(new URL(repositoryUrl));
	if (repository === null) return null;

	// One licence per repository, not per listing. Four filenames across two
	// refs is up to eight requests, of which at most one can succeed — and a
	// repository's licence is the same for every extension in it. Checking a
	// catalogue of 254 listings was paying that toll 254 times, which is most of
	// a thousand requests to learn one fact.
	//
	// The promise is cached rather than the answer, so listings converting
	// concurrently share one lookup instead of racing into the same misses.
	const cached = LICENCES.get(repositoryUrl);
	if (cached !== undefined) return await cached;

	const names = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'COPYING'];
	const pending = (async (): Promise<string | null> => {
		for (const name of names) {
			// A name the tree does not list is a request that would 404. The tree
			// was already fetched for this repository, so this costs nothing and
			// saves up to eight round trips — and the console stops filling with
			// misses for files nobody claimed existed.
			if (index !== null && !index.paths.includes(name)) continue;
			// The tree's ref is the one that answered, and it already accounts for
			// a ref the pasted URL named, so it replaces the guesses rather than
			// joining them.
			const refs = index === null ? DEFAULT_REFS : [index.ref];
			const where = index === null ? repository : { ...repository, ref: null };
			for (const candidate of rawCandidates(where, name, refs)) {
				try {
					const body = await services.getText(candidate);
					if (body.trim().length > 0) return body;
				} catch {
					// A missing licence file is the ordinary case for three of these
					// four names; only the absence of all of them means anything.
				}
			}
		}
		return null;
	})();

	// Oldest first, which `Map` gives free through insertion order. A viewer with
	// more than this many repositories open is re-fetching one licence, not
	// leaking memory.
	if (LICENCES.size >= MAX_CACHED_LICENCES) {
		const oldest = LICENCES.keys().next();
		if (oldest.done !== true) LICENCES.delete(oldest.value);
	}
	LICENCES.set(repositoryUrl, pending);
	return await pending;
}

/**
 * Every file in a source repository, and the branch they were found on.
 *
 * The listing this replaces was expensive and almost entirely wasted.
 * `locationCandidates` guesses a couple of directory names from the package,
 * and `fetchExtensionSource` then probes each with two build-file names across
 * two branches — eight requests per listing, of which at most one succeeds.
 * Multiplied by a 254-listing catalogue that is two thousand requests to find
 * two hundred and fifty-four files.
 *
 * A recursive tree answers all of it at once, and the tree lister already
 * caches one per repository, so this costs nothing that was not already paid.
 * With the real file list in hand a directory guess is either confirmed or
 * discarded without a request, and the branch is settled once for the whole
 * repository rather than re-probed per listing.
 */
interface RepositoryFiles {
	/** The branch that answered. */
	readonly ref: string;
	/** Repository-relative paths, every file in the tree. */
	readonly paths: readonly string[];
}

const REPOSITORY_FILES = new Map<string, Promise<RepositoryFiles | null>>();

async function repositoryFiles(
	repositoryUrl: string,
	services: ConversionServices
): Promise<RepositoryFiles | null> {
	const cached = REPOSITORY_FILES.get(repositoryUrl);
	if (cached !== undefined) return await cached;

	const pending = (async (): Promise<RepositoryFiles | null> => {
		let repository;
		try {
			repository = parseRepositoryUrl(new URL(repositoryUrl));
		} catch {
			return null;
		}
		if (repository === null) return null;

		// `HEAD` is the repository's *own* default branch, whatever it is called,
		// and GitHub resolves it on both the tree API and the raw host — so one
		// request settles the question that guessing `main` then `master` asks in
		// two, and a repository on neither name stops being unreachable. The
		// guesses stay behind it for a forge that does not resolve `HEAD`, and a
		// ref the pasted URL named still comes first: somebody who pasted a
		// branch page meant that branch.
		const defaults =
			repository.origin === 'https://github.com' ? ['HEAD', ...DEFAULT_REFS] : DEFAULT_REFS;
		const refs = repository.ref === null ? defaults : [repository.ref, ...defaults];
		/**
		 * A refusal aimed at us, kept rather than swallowed with the rest.
		 *
		 * The catch below is right for what it was written for — a branch that
		 * does not exist is the ordinary case — and wrong for the one failure
		 * that is not about the repository at all. When the forge rate-limits
		 * this address every ref fails identically, `null` comes back, and the
		 * conversion goes on to report that the extension's source *could not be
		 * found in the repository it is built from*. That sentence is a claim
		 * about somebody else's repository, and it is false; the source is
		 * there, and we ran out of requests. AGENTS.md rule 17 is exactly this.
		 */
		let refused: unknown = null;
		for (const ref of [...new Set(refs)]) {
			const root = rawCandidates({ ...repository, ref: null }, '', [ref])[0];
			if (root === undefined) continue;
			try {
				const found = await services.listFiles(root);
				if (found.length === 0) continue;
				// Back to repository-relative: the lister answers in absolute URLs
				// on the raw host, which is what `source-repo.ts` wants and not
				// what a path comparison does.
				const paths = found
					.filter((url) => url.startsWith(root))
					.map((url) => url.slice(root.length));
				if (paths.length > 0) return { ref, paths };
			} catch (error) {
				// A branch that does not exist is the ordinary case for one of the
				// two; only both failing means anything. A refusal aimed at this
				// address is not that, and is kept.
				if (error instanceof TreeError && error.rateLimited) refused = error;
			}
		}
		if (refused !== null) throw refused;
		return null;
	})();

	if (REPOSITORY_FILES.size >= MAX_CACHED_LICENCES) {
		const oldest = REPOSITORY_FILES.keys().next();
		if (oldest.done !== true) REPOSITORY_FILES.delete(oldest.value);
	}
	REPOSITORY_FILES.set(repositoryUrl, pending);
	return await pending;
}

/**
 * Licence text by source repository, for the length of the session.
 *
 * Module-level rather than per-registry because the fact it holds is a property
 * of somebody else's repository, not of this app's state, and because the
 * adapter is a module singleton with nowhere else to put it. Bounded so a
 * viewer who pastes many repositories cannot grow it without limit; a licence is
 * a few kilobytes and the cap is generous.
 */
const LICENCES = new Map<string, Promise<string | null>>();
const MAX_CACHED_LICENCES = 32;

/**
 * The templates and extractor modules each source repository has given up.
 *
 * Beside the licence memo and for the same reason, one level larger: a licence
 * is one fact per repository, and this is a few dozen. It is what keeps
 * `FOREIGN.md` §4.1.3's "translate the extractor on the device" from meaning
 * "fetch the extractor once per listing that names it". Measured over a
 * 254-extension catalogue those 862 declared dependencies resolve to 58
 * distinct directories, so converting the whole catalogue costs 1,068 file
 * requests with this and 3,268 without.
 */
const SHARED = new Map<string, SharedCache>();

function sharedCacheFor(repositoryUrl: string): SharedCache {
	const existing = SHARED.get(repositoryUrl);
	if (existing !== undefined) return existing;

	if (SHARED.size >= MAX_CACHED_LICENCES) {
		const oldest = SHARED.keys().next();
		if (oldest.done !== true) SHARED.delete(oldest.value);
	}
	const created = newSharedCache();
	SHARED.set(repositoryUrl, created);
	return created;
}

/** Drops the memo. For specs, which must not leak a repository between cases. */
export function forgetCachedLicences(): void {
	LICENCES.clear();
	REPOSITORY_FILES.clear();
	SHARED.clear();
}
