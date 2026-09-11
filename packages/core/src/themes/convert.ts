/**
 * Deciding whether one extension can be converted from its template, and with
 * what configuration.
 *
 * This is the join between three things that were built separately: the Kotlin
 * reader, which says what an extension declares and — more usefully — what it
 * overrides that nobody can read; the template registry in `engine.ts`; and the
 * converter that turns the answer into a bundle.
 *
 * ## Why the answer is usually no, and why that is fine
 *
 * Measured across one 254-extension catalogue, only 60 extend a shared template
 * at all, and of those only a handful are thin enough to be reconstructed from
 * their constants. The median extension overrides eleven of the members our ABI
 * needs. That is the honest shape of this ecosystem: a template supplies a page
 * layout, and most extensions then rewrite a good deal of it.
 *
 * So this module is built to **refuse precisely**. A `ThemeMatch` that cannot
 * convert says which members stood in the way, by name. That turns "this
 * extension is not supported" into "this extension overrides
 * `episodeListParse` and `videoListParse`", which is a sentence somebody can
 * act on — and it is the same information that would tell a future translator
 * exactly what it needs to handle.
 *
 * Guessing would be the alternative, and guessing here is worse than refusing:
 * an extension whose overridden episode parser is silently ignored produces a
 * plugin that installs, searches, and then shows the wrong episodes.
 */

import type { KotlinSource } from '../kotlin/reader';
import { themeById, type Theme, type ThemeConfig } from './engine';

/**
 * Members our ABI needs an implementation of.
 *
 * An extension that overrides one of these has changed behaviour the template
 * would otherwise have supplied, and the override is code we cannot read. The
 * prefixes match the naming convention the source ecosystem uses throughout.
 */
const REQUIRED = [
	'popularAnime',
	'latestUpdates',
	'searchAnime',
	'animeDetailsParse',
	'episodeList',
	'episodeFromElement',
	'videoList',
	'getVideoList',
	'videoFromElement',
	'videosFromElement'
];

/**
 * Members that may be overridden freely, because the host does that job itself.
 *
 * Settings and filters are declared in the manifest and rendered by the host on
 * every surface (`ABI.md` §1, "what is deliberately absent"), and per-host
 * stream extractors are deliberately not ported into this repository at all
 * (`FOREIGN.md` §4.1.3). An extension overriding only these is still a thin
 * subclass as far as we are concerned.
 */
const IRRELEVANT = [
	'preferences',
	'setupPreferenceScreen',
	'getFilterList',
	'headersBuilder',
	'sortVideos',
	'client',
	'json',
	'networkService'
];

function isRequired(member: string): boolean {
	return REQUIRED.some((prefix) => member.startsWith(prefix));
}

function isIrrelevant(member: string): boolean {
	if (IRRELEVANT.includes(member)) return true;
	// Filters and extractors are named by convention, and both are out of scope.
	return /Filter$/.test(member) || /[Ee]xtractor$/.test(member);
}

/**
 * Which template a superclass names.
 *
 * The mapping is from the class an extension extends to the directory its
 * template lives in — the two differ only in case and, occasionally, a
 * `Theme` suffix. A superclass carrying type arguments or a package prefix is
 * reduced first, so `com.example.lib.DooPlay<Foo>` and `DooPlay` agree.
 */
export function themeIdOf(superClass: string | null): string | null {
	if (superClass === null) return null;
	const bare = superClass.replace(/<.*$/, '').replace(/^.*\./, '').trim();
	if (bare.length === 0) return null;

	const lowered = bare.toLowerCase();
	if (themeById(lowered) !== null) return lowered;
	// `ZoroTheme` lives in `zorotheme`, but `DooPlay` lives in `dooplay` — the
	// suffix is part of some directory names and not others, so both are tried
	// rather than assuming one convention holds.
	const suffixed = `${lowered}theme`;
	if (themeById(suffixed) !== null) return suffixed;
	const unsuffixed = lowered.replace(/theme$/, '');
	return themeById(unsuffixed) !== null ? unsuffixed : null;
}

export interface ThemeMatch {
	/** The template, when one was found and the extension is thin enough. */
	readonly theme: Theme | null;
	readonly config: ThemeConfig | null;
	/**
	 * Why not, in a sentence naming the obstacle. Null on success.
	 *
	 * Written for a person reading an install failure, not for a log.
	 */
	readonly refusal: string | null;
	/** Overridden members our ABI needs and cannot read. Empty on success. */
	readonly blockedBy: readonly string[];
	/** Overrides matched to a template setting, and applied. */
	readonly appliedOverrides: readonly string[];
	/**
	 * Overrides the extension declares that its template never reads.
	 *
	 * Not fatal, and not silent either: a constant nobody consumes usually means
	 * the template moved on and the mapping needs revisiting.
	 */
	readonly unusedOverrides: readonly string[];
}

function refuse(refusal: string, blockedBy: readonly string[] = []): ThemeMatch {
	return {
		theme: null,
		config: null,
		refusal,
		blockedBy,
		appliedOverrides: [],
		unusedOverrides: []
	};
}

/**
 * Works out whether one extension can be rebuilt from its template.
 *
 * `lang` comes from the repository index rather than the source, because the
 * index is what the viewer is looking at when they press install and the source
 * does not always agree with it.
 */
export function matchTheme(source: KotlinSource, lang: string): ThemeMatch {
	const themeId = themeIdOf(source.superClass);
	if (themeId === null) {
		return refuse(
			source.superClass === null
				? 'This extension declares no base class this build recognises.'
				: `This extension is built on "${source.superClass.replace(/<.*$/, '')}", which this ` +
						'build has no template for.'
		);
	}
	const theme = themeById(themeId)!;

	// The overrides that matter. Everything the host draws itself, and every
	// per-host extractor, is excluded before counting — an extension that only
	// overrides those is still a thin subclass to us.
	const blocked = source.unreadableOverrides
		.filter((member) => isRequired(member) && !isIrrelevant(member))
		.sort();

	if (blocked.length > 0) {
		return refuse(
			`This extension rewrites ${blocked.length} part${blocked.length === 1 ? '' : 's'} of its ` +
				`template that Yorozo would have to read as code: ${blocked.join(', ')}. Converting ` +
				'it from its template alone would produce a plugin that looks like it works and ' +
				'does not.',
			blocked
		);
	}

	const baseUrl = source.stringConstants['baseUrl'];
	if (typeof baseUrl !== 'string' || !baseUrl.startsWith('https://')) {
		return refuse(
			'This extension does not declare an https base URL that can be read without running it.'
		);
	}

	// Only the constants this template says it reads. A template that silently
	// accepted anything would make a typo in a member name undetectable.
	const applied: string[] = [];
	const overrides: Record<string, string> = {};
	for (const key of theme.settings) {
		const value = source.stringConstants[key];
		if (typeof value === 'string' && value.length > 0) {
			overrides[key] = value;
			applied.push(key);
		}
	}

	const settings = new Set(theme.settings);
	const unused = Object.keys(source.stringConstants)
		.filter((key) => !settings.has(key) && !RESERVED.has(key))
		.sort();

	return {
		theme,
		config: {
			// Trailing slash normalised once, here, so no template has to think
			// about whether it has one.
			baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
			lang,
			overrides
		},
		refusal: null,
		blockedBy: [],
		appliedOverrides: applied.sort(),
		unusedOverrides: unused
	};
}

/** Constants every extension declares that are not template settings. */
const RESERVED = new Set(['name', 'baseUrl', 'lang', 'id', 'versionId']);
