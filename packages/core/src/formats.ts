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
	'cloudstream',
	'stremio',
	'nuvio'
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
	'cloudstream',
	'stremio',
	'nuvio'
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
 * Four members, matching the app's own `MediaKind` in spirit but not in
 * identity — see the next section. `live-action` exists because one adapted
 * ecosystem (Cloudstream) is a general video client whose providers are
 * largely live-action film and television, and Sora's own free-text
 * categories name the same thing; calling those `manga` to fit an
 * anime/manga/novel taxonomy would put a wrong sentence in front of a viewer.
 * Which mediums this build actually has somewhere to show is
 * `SUPPORTED_MEDIUMS`, not "equals `'anime'`" — and since `ADR-0013` that set
 * includes `manga`. `novel` remains unsupported and is refused as it was.
 *
 * ## Why this is written out rather than derived from `MediaKind`
 *
 * It used to read `MediaKind | 'other'`, and that was one of the imports that
 * reached out of this directory. `MediaKind` is a type the **app** owns
 * (AGENTS.md rule 3 — `Media` carries it as a discriminator), and the runtime
 * only ever *mentions* it, so moving it in here would have been dishonest: the
 * runtime would have owned a discriminator it does not decide. A narrower
 * local union is the truthful answer, and it is not a duplicate — the two are
 * allowed to have different members, and did even before this one gained a
 * fourth: the app's `manga`/`novel` are still out of scope and unpopulated,
 * while this union needs a member for every medium a *foreign* index might
 * plausibly claim, supported or not, because `refusalFor` has to name what it
 * is refusing.
 *
 * What it costs is that the two can drift silently in the other direction: a
 * kind added to the domain would not appear here on its own. These values
 * come off *foreign* index rows, so what a listing may claim is decided by
 * what those ecosystems publish, not by what this client's own model grew,
 * and `SUPPORTED_MEDIUMS` is the one place that has to be told when the
 * domain's supported set changes. `ADR-0013` is the one time it has been.
 */
export type ForeignMedium = 'anime' | 'live-action' | 'manga' | 'novel';

/**
 * Which mediums this build actually has somewhere to show.
 *
 * The one set `refusalFor` (install-time: is this listing refused for its
 * medium?) and `adapter.ts`'s `keepMediums` (parse-time: does this listing
 * even survive into a browsable list?) both read, so the two cannot disagree
 * — a listing kept by one and refused by the other would be a row that shows
 * up only to explain that it should not have.
 *
 * `manga` joined under `ADR-0013`, and covers comics, webtoons, manhwa and
 * manhua alike: they differ in origin and in reading direction, which is a
 * property of a title, and in nothing an adapter can see.
 *
 * **A medium here is a capability claim, not a taste one.** This set answers
 * "is there anywhere in this build to show this?" and nothing else. What a
 * listing *contains* is carried on `origin` and decided by the host —
 * `FOREIGN.md` §4.3.
 *
 * **And a medium is not a reader.** Adding one makes a listing installable and
 * convertible; the host still has to have somewhere to put the result, which
 * for this one is `ABI.md` §8.
 */
export const SUPPORTED_MEDIUMS: ReadonlySet<ForeignMedium> = new Set([
	'anime',
	'live-action',
	'manga'
]);

/**
 * Every medium something classified claims, from either shape of the record.
 *
 * One reader for the pair, so that no caller has to remember that `mediaKind`
 * is the collapsed value and `mediaKinds` the real answer, and so that the
 * fallbacks are written once. Empty means nothing was classified at all,
 * which every caller treats as "ask anyway" — a gap in information is not
 * evidence of the wrong medium.
 */
export function declaredMediums(
	of: Pick<ConversionRecord, 'mediaKind' | 'mediaKinds'> | undefined
): readonly ForeignMedium[] {
	if (of === undefined) return [];
	if (of.mediaKinds !== undefined && of.mediaKinds.length > 0) return of.mediaKinds;
	return of.mediaKind === undefined ? [] : [of.mediaKind];
}

/**
 * A catalogue id a source can be addressed by directly, without being searched.
 *
 * The distinction this exists for: every other adapted ecosystem is a *site
 * scraper* whose ids are its own slugs, so the only way to find a show is to
 * search its catalogue by title and score what comes back — and a title is a
 * weak key. One source calls a show `Men on a Mission`, another `Knowing
 * Bros`, and the run of alternative spellings between them is why
 * `catalog-matcher.ts` needs a trusted-match threshold at all.
 *
 * An addon addressed by IMDB id has no such problem: the host already holds
 * that id from its metadata provider, so there is nothing to search, nothing
 * to score and nothing to get wrong. A source declaring one of these is
 * saying "hand me this id and I will answer", and the host binds it directly.
 *
 * **A namespace, not a number.** `anilist` is AniList's id and nothing else:
 * it is never filled from MAL or AniDB because those count different things,
 * and a number from the wrong namespace does not fail — it answers, for the
 * wrong show. The same holds in the other direction now that `tmdb` is a
 * member: a host holding a TMDB id declares `tmdb`, and never spends it as an
 * `anilist` one. A host that does not hold the id a source asked for declares
 * nothing and the source is searched by title instead, which is the ordinary
 * path.
 *
 * `tmdb` carries its endpoint, because TMDB's own numeric ids collide across
 * `/movie` and `/tv` and a bare number does not say which it came from.
 * `referenceFor` spells it, and getting it wrong returns a real but unrelated
 * show — the one failure in this file that answers instead of erroring.
 *
 * Only kinds a host actually carries belong here. AniDB and TVDB are
 * deliberately absent: sources ask for them, this catalogue has no source of
 * them, and adding a mapping service to raise a compatibility count is the
 * trade this project does not make. `tmdb` is admitted on exactly that test
 * and no other — it is a service this catalogue already keys shows by, and
 * for the anime it does not, the id arrives in a mapping payload already
 * fetched for something else.
 */
export type ExternalIdKind = 'imdb' | 'anilist' | 'tmdb';

/**
 * A torrent, as the thing a source hands back instead of a URL.
 *
 * Deliberately not a URL, and deliberately not a magnet string. A magnet would
 * be a URL-shaped value that no fetch can open, and every guard, probe and
 * player downstream treats a URL as fetchable — `__isPlayable`, the reach
 * probe, the mirror memory and the fall-through walk all would have had to
 * learn an exception. A distinct shape makes the one place that must
 * understand it obvious, and leaves the rest of the pipeline reading exactly
 * as it did.
 *
 * Carries what an acquisition engine needs and nothing else: no display
 * strings, no source name, no file list. Those belong to the `PlaybackSource`
 * the host builds once the engine has turned this into an address.
 */
export interface TorrentDescriptor {
	/** The infohash, lowercased hex, as the protocol spells it. */
	readonly infoHash: string;
	/**
	 * Which file in the torrent, when the source knows.
	 *
	 * Absent is a real answer rather than a default: a single-file torrent has
	 * nothing to choose, and for a multi-file one an engine picking the largest
	 * video is more reliable than a source guessing an index it never read.
	 */
	readonly fileIdx?: number;
	/**
	 * Trackers and DHT nodes the source offered, verbatim.
	 *
	 * Passed through untouched because an engine joins a swarm faster knowing
	 * where to look, and because rewriting them would be this client having an
	 * opinion about somebody else's network.
	 */
	readonly sources?: readonly string[];
}

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
	/**
	 * What the originating listing served, copied from `ForeignOrigin.mediaKind`
	 * at conversion time.
	 *
	 * Optional so that a row written before this field existed keeps working —
	 * the same rule `settings` documents just above this interface's sibling
	 * fields. Its purpose is entirely downstream of installation: a multi-source
	 * search (`PluginSourceRepository.searchCatalog`) can skip asking a plugin
	 * whose declared medium the current search has no use for, rather than
	 * spinning up its sandbox to search a catalogue that predictably has
	 * nothing relevant. Absent is treated as "ask anyway" wherever this is
	 * read, never as a reason to exclude — an unclassified plugin is a gap in
	 * information, not evidence it is the wrong kind.
	 */
	readonly mediaKind?: ForeignMedium;
	/**
	 * Every medium the originating listing claimed, copied from
	 * `ForeignOrigin.mediaKinds` at conversion time.
	 *
	 * This, not `mediaKind`, is what a medium filter must read: `mediaKind` is
	 * one value because a row is filed under one medium, and a source that
	 * declared three is not evidence against the other two. Absent means the
	 * classification was single-valued, so a reader falls back to
	 * `[mediaKind]` — and with `mediaKind` absent too, to asking anyway.
	 */
	readonly mediaKinds?: readonly ForeignMedium[];
	/**
	 * External ids this source is addressed by, copied from
	 * `ForeignOrigin.idKinds` at conversion time.
	 *
	 * What `CatalogSearchMatcher` reads to decide whether this source can be
	 * bound without searching it. Absent is the ordinary case and means "search
	 * it by title", which is what every row written before this existed meant.
	 */
	readonly idKinds?: readonly ExternalIdKind[];
	/**
	 * What the source's manifest claimed, copied from `ForeignOrigin` at
	 * conversion time. Advisory — see there.
	 */
	readonly declaredP2p?: boolean;
	/**
	 * Whether this client **watched** the source answer with peer-to-peer
	 * descriptors.
	 *
	 * Authoritative for the one thing it covers, and only that: we ran
	 * `resolve()` and read what came back. Rule 17 is satisfied by
	 * construction, because the capability the claim depends on is the one
	 * that produced the evidence.
	 *
	 * Kept beside `declaredP2p` rather than merged into it, because the two
	 * are different facts and stay distinguishable even when both are true. A
	 * source that declared nothing and was observed is a source whose author
	 * was careless; a source that declared and was never run is unproven. One
	 * boolean could not say either.
	 *
	 * **Evidence, never authority.** Observing peer-to-peer does not widen
	 * what a plugin may do: permissions are granted at install against a
	 * manifest the viewer was shown, and a fact learned afterwards cannot
	 * retroactively enlarge that grant. What it does is let a host disclose
	 * honestly and ask.
	 */
	readonly observedP2p?: boolean;
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
	/**
	 * Every medium the listing claimed, not just the one it is filed under.
	 *
	 * Some ecosystems declare a *set*: a Sora manifest saying
	 * `movies/shows/anime` serves all three, and Cloudstream's `tvTypes` is an
	 * array. `mediaKind` has to collapse that to one value — a row is filed
	 * under one medium, and `keepMediums`/`refusalFor` ask a yes-or-no question
	 * — and collapsing it loses exactly the fact a consumer needs to route by
	 * medium later. A drama site declaring `movies/shows/anime` files under
	 * `anime` on the first mention and is then never asked for the live-action
	 * it actually serves.
	 *
	 * So the set is carried alongside the collapsed value rather than instead
	 * of it. `mediaKind` stays the listing's primary medium and is always the
	 * first element. Absent means the adapter's classification was genuinely
	 * single-valued — a Mangayomi `itemType` enum, an Aniyomi package name —
	 * and a reader treats it as `[mediaKind]`, never as "no mediums".
	 */
	readonly mediaKinds?: readonly ForeignMedium[];
	/**
	 * External catalogue ids this source can be addressed by directly.
	 *
	 * Absent or empty means the ordinary path: the host searches this source's
	 * catalogue by title and scores the results. Present means it need not —
	 * see `ExternalIdKind`.
	 */
	readonly idKinds?: readonly ExternalIdKind[];
	/**
	 * Whether the source's own manifest **claims** peer-to-peer acquisition.
	 *
	 * Advisory, and named for it. A manifest is what an author wrote, not what
	 * their addon does: the most widely installed torrent addon in this
	 * ecosystem declares nothing here and returns torrents for every request.
	 * So this buys early disclosure when it is present and proves nothing when
	 * it is absent, which is why `ConversionRecord.observedP2p` exists beside
	 * it rather than instead of it.
	 */
	readonly declaredP2p?: boolean;
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
	/**
	 * Whether this format's own framework carries cookies for an extension
	 * without the extension asking.
	 *
	 * A statement about the **foreign platform**, not about any one extension,
	 * and that is the whole point of putting it here. The dominant cookie use in
	 * these ecosystems is implicit: the framework installs a jar on the shared
	 * client and the extension's code never names a cookie API at all. Deriving
	 * the capability from the translated source therefore finds nothing and the
	 * session silently never carries — the extension is not broken, it is simply
	 * running somewhere that quietly dropped a guarantee its platform made.
	 *
	 * So the opt-in comes from the format contract. An adapter whose framework
	 * makes that guarantee requests the **constrained** jar for the bundles it
	 * produces (`ABI.md` §2): per plugin, per already-granted host, in memory,
	 * cleared at unload, and never readable by plugin code. The extension gains
	 * no cookie API — `loadForRequest` and `CookieManager` stay refused at
	 * conversion, and there is no enumeration or export. It gains only the
	 * request continuity its original framework would have given it.
	 *
	 * False is the honest default: a format whose framework does *not* do this
	 * must not have plugins granted state they were never written to expect.
	 */
	readonly implicitCookies: boolean;
}

const PROFILES: Readonly<Record<ForeignFormat, FormatProfile>> = {
	sora: {
		format: 'sora',
		label: 'Sora',
		tier: 'convert',
		keyDocument: 'index',
		refusal: null,
		implicitCookies: false
	},
	hayase: {
		format: 'hayase',
		label: 'Hayase',
		tier: 'convert',
		keyDocument: 'index',
		/*
		 * Was `browse-only`, on one stated ground: *"extensions in this format
		 * return torrents rather than streams, and Yorozo has no torrent
		 * client."* That premise stopped being true, and the refusal outlived
		 * it — which is its own lesson about a sentence written once and read
		 * as a fact forever.
		 *
		 * What replaced it was already built for another ecosystem:
		 * `TorrentDescriptor` on the ABI, a resolve answering with descriptors
		 * and no direct link counting as a pass, `TorrentAcquisition` as the
		 * host's port, a companion or desktop host behind it, and `P2pConsent`
		 * per source in front of it. A Hayase row's info hash travels exactly
		 * that path and no other; nothing in the adapter or the runtime
		 * acquires anything.
		 */
		refusal: null,
		implicitCookies: false
	},
	nuvio: {
		format: 'nuvio',
		label: 'Nuvio',
		tier: 'convert',
		/*
		 * Its index is a `scrapers` array rather than the bare list four other
		 * formats publish, and it is the only one that names each entry's file
		 * separately from the entry itself — so the key document is the index
		 * and the artifact is resolved from it, not guessed from the id.
		 */
		keyDocument: 'index',
		refusal: null,
		/*
		 * These run in a React Native scope, which has no document and no
		 * cookie jar of its own. A source here that needs a session carries it
		 * in a header it sets itself, so granting ambient cookies would hand
		 * every one of them state it was never written to expect.
		 */
		implicitCookies: false
	},
	lnreader: {
		format: 'lnreader',
		label: 'LNReader',
		tier: 'browse-only',
		keyDocument: 'index',
		refusal:
			'Extensions in this format are novel sources. Yorozo is an anime client and has ' +
			'nowhere to show them.',
		implicitCookies: false
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
			'not one of them.',
		implicitCookies: false
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
		refusal: null,
		// `AnimeHttpSource` hands every extension a shared client that upstream
		// builds with a real cookie jar, so an extension doing a two-request
		// session never writes a line about cookies and is entitled to assume
		// the second request carries what the first was given.
		implicitCookies: true
	},
	stremio: {
		format: 'stremio',
		label: 'Stremio',
		// The only format with nothing to translate. An addon is an HTTP
		// service with a published protocol, so conversion produces a client
		// for it rather than a port of it: no bytecode, no classpath, no
		// template inference, and nothing of the author's code in the bundle.
		// `FOREIGN.md` §4.4.
		tier: 'convert',
		// A manifest *is* the index here — one document describing one addon —
		// so there is no sibling to look for and no key to find.
		keyDocument: 'index',
		refusal: null,
		implicitCookies: false
	},
	cloudstream: {
		format: 'cloudstream',
		label: 'Cloudstream',
		tier: 'browse-only',
		keyDocument: 'index',
		refusal:
			'Extensions in this format are compiled Java, and running one means providing the ' +
			'whole runtime it expects. The converter for this format is not built yet — this ' +
			'repository browses, but nothing here can be installed.',
		implicitCookies: false
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
	if (!SUPPORTED_MEDIUMS.has(medium)) {
		return `This is a ${medium} source. Yorozo does not support that yet.`;
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
