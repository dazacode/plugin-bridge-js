/**
 * Finding out whether a listing works *before* anybody installs it.
 *
 * The install gate (`verify.ts`) already runs a converted bundle through a
 * search, an episode list and a stream resolve before it becomes a row. That
 * whole pass happens from bytes in memory and writes nothing, which means it
 * can equally be run on a listing nobody has chosen — and then a browse list
 * can say which entries actually work instead of leaving every one of them to
 * be discovered one install at a time.
 *
 * ## Grey means unknown, and unknown is not a failure
 *
 * The default state of every listing is `untested`, and that is a real answer
 * rather than a placeholder. Nothing has been run, so nothing is claimed. A
 * client that guessed — marking things green because they parsed, or red
 * because they looked unusual — would be inventing a judgement it has not
 * earned, and this system already has one hard rule about that: being listed
 * in a repository means nothing about whether it works, and the host must not
 * imply otherwise (`REPOSITORY.md` §5).
 *
 * So a grey row says "no one has checked this; try it and see". That is the
 * honest state, it is the state most rows are in, and the viewer is the one
 * who resolves it.
 *
 * ## Checking is not free, and the cost lands on somebody else
 *
 * A check makes the same requests an install makes — to the source, not to us.
 * Checking a repository of two hundred entries would therefore be two hundred
 * sources searched because somebody opened a list. That is rude at best, so:
 *
 * - it never happens automatically, only when asked for;
 * - it is asked for one listing at a time, from that listing's own row — there
 *   is no sweep, because a repository-wide sweep spends two hundred sites'
 *   bandwidth to answer a question about the one plugin somebody was looking
 *   at, and every measured run of one was stopped part way through anyway;
 * - and a result is remembered per listing *version* and per converter
 *   version, so a second look at a row already answered costs nothing, while
 *   widening the translator re-opens every question it had answered.
 *
 * Listings that cannot be installed at all are never checked. There is nothing
 * to learn, and the request would be spent on a question already answered.
 */

import { NO_KV, type KeyValueStore } from '@plugin-bridge/host/host';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { listingRefusal } from './adapter';
import type { ObstacleSite } from './obstacles';
import { CONVERTER_VERSION } from './package';
import type { VerificationStep } from './verify';

/**
 * What is known about one listing.
 *
 * `untested` and `notTestable` are deliberately distinct. The first is "nobody
 * has looked"; the second is "looking is not possible" — a format this build
 * cannot convert, or a source for a medium the app does not show. Collapsing
 * them would make a browse-only repository look like a repository of failures.
 */
export type CheckStatus = 'untested' | 'checking' | 'works' | 'broken' | 'notTestable';

export interface CheckResult {
	readonly listingId: string;
	/** The listing's own version string, so a new release resets the answer. */
	readonly version: string;
	readonly status: CheckStatus;
	/** Why it is broken, in the words the plugin or the host used. */
	readonly detail: string | null;
	readonly failedAt: VerificationStep | null;
	readonly checkedAt: string;
	/**
	 * What blocked the conversion, named rather than described.
	 *
	 * Present only when a conversion refused and had something structured to
	 * say. A row does not render it — `detail` is the sentence a person reads —
	 * but the scoreboard ranks on it, because ranking on prose would make a
	 * measurement depend on nobody rewording an error message.
	 *
	 * Each kind appears at most once per listing, so counting rows carrying a
	 * kind answers "how many listings would this unblock" rather than "how often
	 * does this construct occur". `FOREIGN.md` §4.1.4 and §4.1.6 both rest on
	 * that being the number.
	 */
	readonly obstacles?: readonly string[];
	/**
	 * The same obstacles with the file, member and line each sits on.
	 *
	 * `obstacles` is the measurement and this is the address — see
	 * `obstacles.ts`. Nothing ranks on it and no row renders it; it is what
	 * `check-catalogue --why` prints so that the next construct to support can
	 * be read off a console rather than grepped for.
	 */
	readonly sites?: readonly ObstacleSite[];
	/**
	 * Which medium the run was about, so a row can name what the counts are.
	 *
	 * The two walks share these fields and not their vocabulary: `episodeCount`
	 * holds chapters and `streamCount` holds page images for a source driven
	 * through `ABI.md` §8. A row that prints them as episodes and streams reads
	 * as a bridge that does not know a book from a season — which is the first
	 * thing somebody asked about it, from a screen that had just verified a
	 * manga source correctly.
	 *
	 * Absent means video, which is what every caller of this meant before books
	 * existed.
	 */
	readonly medium?: 'video' | 'book';
	/** What it managed before failing, when it managed anything. */
	readonly searchHits?: number;
	readonly episodeCount?: number;
	/**
	 * How many peer-to-peer descriptors the run resolved.
	 *
	 * Here as well as on `ConversionRecord.observedP2p` because the two cover
	 * different rows: a listing somebody checked without installing has no
	 * conversion record to carry the observation, and forgetting what that
	 * check saw would mean asking the source again to learn something already
	 * proved.
	 */
	readonly torrentCount?: number;
	readonly streamCount?: number;
}

/**
 * The key a result is filed under.
 *
 * Version-scoped on purpose: a repository publishing a new build has published
 * something nobody has tested, and carrying the old verdict forward would show
 * a green tick for code that has never run.
 *
 * **Converter-scoped for the mirror-image reason.** A verdict is a statement
 * about two things — the listing's code and this build's ability to read it —
 * and keying on the listing alone silently asserts the second never changes.
 * It changes constantly: widening the translator is the whole activity. So a
 * remembered `broken` outlived the refusal that produced it, and every row went
 * on reciting a pre-fix message until the *repository* happened to publish.
 * That turns a measurement loop into a loop that cannot measure itself — the
 * scoreboard reports the converter that ran first, not the one installed now.
 *
 * `ConversionRecord` already says an improved converter "is itself a reason to
 * offer a re-conversion"; this is that sentence applied to the verdict as well
 * as to the bundle. Bump `CONVERTER_VERSION` when the translator's answers
 * change and every stored verdict becomes unknown again, which is the honest
 * state for a question nobody has re-asked.
 */
export function checkKey(listing: RepositoryPlugin): string {
	const version = listing.origin?.foreignVersion ?? listing.version;
	return `${listing.id}@${version}#c${CONVERTER_VERSION}`;
}

/** Whether there is anything to learn by running this one. */
export function isTestable(listing: RepositoryPlugin): boolean {
	return listingRefusal(listing) === null;
}

/**
 * What to show for one listing, given everything checked so far.
 *
 * Reads the refusal first, because "this cannot be installed" outranks any
 * stale result: a listing that once worked and is now on a format this build
 * refuses is not a working listing.
 */
export function statusOf(
	listing: RepositoryPlugin,
	results: ReadonlyMap<string, CheckResult>
): CheckResult {
	const key = checkKey(listing);
	const base = {
		listingId: listing.id,
		version: listing.origin?.foreignVersion ?? listing.version,
		detail: null,
		failedAt: null,
		checkedAt: ''
	};

	if (!isTestable(listing)) return { ...base, status: 'notTestable' };
	return results.get(key) ?? { ...base, status: 'untested' };
}

const STORE_KEY = 'kuro.plugins.checks.v1';

/**
 * Remembered results, so opening a repository twice costs nothing.
 *
 * The store is the host's (`host.ts`), which in the browser is `localStorage`
 * — matching the plugin rows in `web-plugin-registry.ts`, because these are a
 * handful of small records read whole and putting them anywhere else would
 * mean plugin state living in two places with different durability. A headless
 * host backs the same two methods with a JSON file.
 *
 * Passed in rather than found, and defaulted to the store that forgets, so a
 * host without one loses the *memory* of a check and nothing else. Every
 * failure inside an implementation is swallowed there for the same reason: a
 * viewer with site data blocked pays for a re-run, not for the screen.
 */
export function loadChecks(kv: KeyValueStore = NO_KV): Map<string, CheckResult> {
	const raw = kv.get(STORE_KEY);
	if (raw === null) return new Map();

	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null) return new Map();
		const out = new Map<string, CheckResult>();
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			const row = value as CheckResult;
			// `checking` is a state of a run, not of the world. A stored one means
			// a tab closed mid-check, and it must come back as unknown.
			if (row?.status === 'works' || row?.status === 'broken') out.set(key, row);
		}
		return out;
	} catch {
		return new Map();
	}
}

export function saveChecks(kv: KeyValueStore, results: ReadonlyMap<string, CheckResult>): void {
	const object: Record<string, CheckResult> = {};
	for (const [key, value] of results) {
		if (value.status === 'works' || value.status === 'broken') object[key] = value;
	}
	// A full quota loses the memory, not the session — swallowed by the store.
	kv.set(STORE_KEY, JSON.stringify(object));
}

/** How a status reads to a person, on the row itself. */
export function describeStatus(result: CheckResult): string {
	switch (result.status) {
		case 'works':
			return 'Checked — searched, listed episodes and resolved a stream.';
		case 'broken':
			return result.detail === null ? 'Checked — it did not work.' : result.detail;
		case 'checking':
			return 'Checking…';
		case 'notTestable':
			return 'Cannot be installed, so there is nothing to check.';
		default:
			// Said plainly, because it is the state most rows are in and it is not
			// a failure. The viewer decides.
			return 'Not checked. Nobody has run this one — install it and see.';
	}
}
