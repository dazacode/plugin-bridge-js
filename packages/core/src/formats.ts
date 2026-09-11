/**
 * The extension formats this build recognises, and what it can do with each.
 *
 * `contract/plugin-api/FOREIGN.md` §1 is the normative version of this table;
 * this file is it in code, and the two are meant to be read together.
 *
 * ## Rule 9, and why naming these is allowed
 *
 * AGENTS.md rule 9 forbids referencing **a content source** — a site that
 * serves media. It does not forbid naming a client application or a file
 * format, and an adapter cannot be written without saying which format it
 * parses. So `aniyomi` and `sora` appear here as format names, and no
 * repository URL, streaming hostname, extractor or CDN appears anywhere in
 * this directory. Detection is by path shape, never by hostname.
 *
 * ## Why `browse-only` is a tier and not an error
 *
 * A repository listing hundreds of extensions is worth showing in full even
 * when nothing in it can run here: it says what exists, and the disabled
 * button says exactly why. Refusing the URL outright would be
 * indistinguishable from a typo, which is the failure `repository-index.ts`
 * already exists to prevent for native repositories.
 */

/**
 * Which ecosystem a plugin repository was written for.
 *
 * `yorozo` is the native format and the only one a plugin can be *published*
 * in; the rest are formats this client reads and, where it can, converts —
 * `contract/plugin-api/FOREIGN.md` §1.
 *
 * This union is stored: it lands on a repository row and on an installed
 * plugin row, so it is a wire value with the "never rename a member"
 * obligation everything in `domain/enums.ts` carries — and it used to live
 * there for exactly that reason. It moved here when the runtime stopped
 * importing from the app, because the list of ecosystems this build adapts is
 * the compatibility layer's own vocabulary and nothing else decides it.
 * `domain/enums.ts` re-exports it, so the app's imports are unchanged.
 *
 * Naming a *client application* is not naming a content source, and AGENTS.md
 * rule 9 bars the second, not the first.
 */
export const REPOSITORY_FORMATS = [
	'yorozo',
	'sora',
	'hayase',
	'lnreader',
	'mangayomi',
	'aniyomi',
	'cloudstream'
] as const;
export type RepositoryFormat = (typeof REPOSITORY_FORMATS)[number];

/** Everything except the native format. */
export type ForeignFormat = Exclude<RepositoryFormat, 'yorozo'>;

export function isRepositoryFormat(value: unknown): value is RepositoryFormat {
	return REPOSITORY_FORMATS.includes(value as RepositoryFormat);
}

/** The same list without the native format, kept beside the table it indexes. */
export const FOREIGN_FORMATS = [
	'sora',
	'hayase',
	'lnreader',
	'mangayomi',
	'aniyomi',
	'cloudstream'
] as const satisfies readonly ForeignFormat[];

/**
 * Whether an artifact in this format can become a bundle on the device.
 *
 * A statement about the artifact, not about the ecosystem's quality.
 */
export type ForeignTier = 'convert' | 'browse-only';

/**
 * What a foreign source serves.
 *
 * The domain's three kinds plus one, because one adapted ecosystem is a
 * general video client whose providers are largely live-action film and
 * television. Calling those `manga` to fit them into three values would put a
 * wrong sentence in front of a viewer; `other` lets the row say what is
 * actually true. Nothing outside this directory sees the widening — only
 * `anime` listings survive filtering, and only those reach the domain.
 *
 * ## Why this is written out rather than derived from `MediaKind`
 *
 * It used to read `MediaKind | 'other'`, and that was one of the imports that
 * reached out of this directory. `MediaKind` is a type the **app** owns
 * (AGENTS.md rule 3 — `Media` carries it as a discriminator), and the runtime
 * only ever *mentions* it, so moving it in here would have been dishonest: the
 * runtime would have owned a discriminator it does not decide. A narrower
 * local union is the truthful answer, and it is not a duplicate — this set has
 * four members and the domain's has three.
 *
 * What it costs is that the two can drift: a fourth kind added to the domain
 * would not appear here. That is the direction the drift should run. These
 * values come off *foreign* index rows, so what a listing may claim is decided
 * by what those ecosystems publish, not by what this client's own model grew;
 * and everything except `anime` is refused by `refusalFor` before it reaches
 * the domain, which is where a mismatch would otherwise matter.
 */
export type ForeignMedium = 'anime' | 'manga' | 'novel' | 'other';

/**
 * What a converted plugin was made from.
 *
 * Present only when the bundle did not come from a Yorozo repository. It is
 * what an update check compares against — `foreignVersion` verbatim, never
 * parsed as semver, because these ecosystems number however they like and
 * `14.58` against `14.5.8` would collide. `FOREIGN.md` §7.
 *
 * `converterVersion` is recorded so that improving the converter is itself a
 * reason to offer a re-conversion: a newer one may succeed where an older one
 * produced something that failed its install check.
 *
 * Here rather than in `domain/plugin.ts` — which re-exports it — because every
 * field is a fact the conversion produced and only this directory can produce
 * one. The app stores it and shows it; it never fills it in.
 */
export interface ConversionRecord {
	readonly format: ForeignFormat;
	readonly foreignId: string;
	readonly foreignVersion: string;
	readonly convertedAt: string;
	readonly converterVersion: number;
	/**
	 * Whether the bundle was run and answered before this row was written.
	 *
	 * False is a real, permitted state — a source that is merely down is not a
	 * broken plugin — and every surface that says "installed" must also say
	 * this, because an unverified install and a verified one are different
	 * facts (`FOREIGN.md` §6).
	 */
	readonly verified: boolean;
}

/**
 * Where a listing came from, carried on the listing itself.
 *
 * Lives here rather than beside `RepositoryPlugin` so that
 * `repository-index.ts` can carry the field without importing an adapter, and
 * so the import graph runs one way: formats knows nothing about indexes.
 *
 * `foreignVersion` is compared as an **opaque string**. These ecosystems
 * number however they like — an integer version code, a two-part `14.58`, a
 * semver — and imposing semver on them would make a legitimate bump look like
 * a downgrade.
 */
export interface ForeignOrigin {
	readonly format: ForeignFormat;
	/** Where the artifact itself lives. https only. */
	readonly artifactUrl: string;
	/** The foreign ecosystem's own id for this extension, for update matching. */
	readonly foreignId: string;
	/** Its own version string, never parsed. */
	readonly foreignVersion: string;
	readonly mediaKind: ForeignMedium;
	readonly isNsfw: boolean;
	/**
	 * Whatever else that format's converter needs, carried on the listing.
	 *
	 * Here so that conversion is a pure function of the listing rather than of
	 * state the adapter kept from its last parse: a listing that outlives its
	 * index — held across a reload, or replayed by a test — must still convert
	 * to the same bundle. Structurally cloneable JSON only.
	 */
	readonly detail?: Readonly<Record<string, unknown>>;
}

export interface FormatProfile {
	readonly format: ForeignFormat;
	/** How the format is named to a person. */
	readonly label: string;
	readonly tier: ForeignTier;
	/**
	 * Where this format's signing key is published.
	 *
	 * `index` means the same document as the plugin list, which is the native
	 * arrangement: if the key is gone, the document changed, and that is an
	 * event worth refusing over. `sibling` means a separate optional file, where
	 * a key that fails to appear is far more likely a fetch that failed than a
	 * repository that stopped signing — so its absence is treated as unknown
	 * rather than as a removal. Conflating the two turns a flaky network into a
	 * security warning, which teaches people to click through security warnings.
	 */
	readonly keyDocument: 'index' | 'sibling';
	/**
	 * Why installing is refused, in a sentence a viewer can act on. Null for a
	 * convertible format.
	 *
	 * Written out per format rather than generated, because "we cannot run this
	 * yet" and "we can run this and it produces something unplayable" are
	 * different facts and a viewer deserves to know which one they hit.
	 */
	readonly refusal: string | null;
}

const PROFILES: Readonly<Record<ForeignFormat, FormatProfile>> = {
	sora: {
		format: 'sora',
		label: 'Sora',
		tier: 'convert',
		keyDocument: 'index',
		refusal: null
	},
	hayase: {
		format: 'hayase',
		label: 'Hayase',
		tier: 'browse-only',
		keyDocument: 'index',
		refusal:
			'Extensions in this format return torrents rather than streams, and Yorozo has no ' +
			'torrent client. This repository browses, but nothing here can be installed yet.'
	},
	lnreader: {
		format: 'lnreader',
		label: 'LNReader',
		tier: 'browse-only',
		keyDocument: 'index',
		refusal:
			'Extensions in this format are novel sources. Yorozo is an anime client and has ' +
			'nowhere to show them.'
	},
	mangayomi: {
		format: 'mangayomi',
		label: 'Mangayomi',
		// Half of it converts. A listing in this format points at a *source
		// file* and names the language it is written in: the JavaScript third
		// needs only the globals its own host provides, and the Dart majority
		// still needs an interpreter. The tier is the optimistic half because
		// `refusalFor` reads the listing's own language and refuses the rest by
		// name — a format-wide refusal would now be a lie for everything that
		// does convert.
		tier: 'convert',
		keyDocument: 'index',
		refusal:
			'This source is written in Dart, and running one means providing a Dart ' +
			'interpreter. Yorozo converts the JavaScript sources in this format; this is ' +
			'not one of them.'
	},
	aniyomi: {
		format: 'aniyomi',
		label: 'Aniyomi',
		// The published artifact is still an Android app this build cannot run,
		// and nothing here opens one. What changed is that the artifact stopped
		// being the only thing published: these extensions are *built from*
		// readable Kotlin, the repository's own metadata says where, and
		// `FOREIGN.md` §4.1.1 is the argument for reading the program rather
		// than reverse-engineering the binary.
		//
		// So the tier is a statement about the *source*, and it is deliberately
		// optimistic: most extensions still refuse. That is the right shape
		// because a refusal is now per listing and names the members that
		// blocked it, where a format-wide sentence could only say "not built
		// yet" — which is no longer true, and was never actionable. §6.1's four
		// check states are what a viewer reads instead: a listing nobody has run
		// is **Unchecked**, and running it says Works or Broken with a reason.
		tier: 'convert',
		// The listing file is a bare array; the key is in a sibling repo.json.
		keyDocument: 'sibling',
		refusal: null
	},
	cloudstream: {
		format: 'cloudstream',
		label: 'Cloudstream',
		tier: 'browse-only',
		keyDocument: 'index',
		refusal:
			'Extensions in this format are compiled Java, and running one means providing the ' +
			'whole runtime it expects. The converter for this format is not built yet — this ' +
			'repository browses, but nothing here can be installed.'
	}
};

export function formatProfile(format: ForeignFormat): FormatProfile {
	return PROFILES[format];
}

/** How a format is named to a person, native included. */
export function formatLabel(format: RepositoryFormat): string {
	return format === 'yorozo' ? 'Yorozo' : PROFILES[format].label;
}

/**
 * Why this listing cannot be installed, or null when it can.
 *
 * Two independent reasons, checked in this order because the more specific one
 * is more useful: a manga source in a convertible format should be told it is
 * the wrong medium, not that its format is unsupported.
 */
export function refusalFor(
	format: ForeignFormat,
	medium: ForeignMedium,
	detail?: Readonly<Record<string, unknown>>
): string | null {
	if (medium === 'other') {
		return (
			'This source serves live-action film and television. Yorozo is an anime client ' +
			'and has nowhere to show it.'
		);
	}
	if (medium !== 'anime') {
		return `This is a ${medium} source. Yorozo is an anime client and has nowhere to show it.`;
	}

	// A listing that ships a prebuilt implementation is installable whatever its
	// source format says, because nothing is being converted: the refusal the
	// profile carries is about reading the published artifact, and that artifact
	// is not what gets installed. Answered here rather than at each caller, so
	// that the install button, the check, and the banner cannot disagree about
	// which listings are installable.
	if (detail?.['pretranslated'] !== undefined) return null;

	// One format is convertible per *listing* rather than per format, because a
	// listing names the language its source file is written in. Reading that
	// here keeps both halves of the answer in this file, which is what
	// `listingRefusal` promises its callers.
	if (format === 'mangayomi') {
		return detail?.['sourceCodeLanguage'] === 'js' ? null : PROFILES.mangayomi.refusal;
	}
	return PROFILES[format].refusal;
}

export function isConvertible(format: ForeignFormat): boolean {
	return PROFILES[format].tier === 'convert';
}

/**
 * Whether an index reporting no key means the repository stopped signing.
 *
 * False only where the key lives in a separate document, since there its
 * absence is indistinguishable from a request that failed.
 */
export function absentKeyMeansRemoved(format: RepositoryFormat): boolean {
	return format === 'yorozo' || PROFILES[format].keyDocument === 'index';
}
