/**
 * Running a converted plugin before agreeing that it is installed.
 *
 * `contract/plugin-api/FOREIGN.md` §6. This is the difference between the
 * install this feature promises and the one every extension ecosystem already
 * has: a conversion is best-effort, and verification is not. A bundle that
 * cannot search, list and resolve does not become a row.
 *
 * It is also the answer to the failure mode ADR-0002 §5.4 names. When an
 * upstream source changes its markup, this turns "black screen, no idea why"
 * into "listEpisodes returned nothing", with the plugin's own
 * `SourceChangedError` message and the url it was looking at.
 *
 * ## Why all four steps
 *
 * Loading proves the conversion produced valid code, which is the *least*
 * interesting thing it could prove. A module that loads and then returns
 * nothing is exactly the outcome a partial conversion produces, and it is
 * indistinguishable from a working plugin until somebody tries to watch
 * something. So the gate runs the whole path a viewer would.
 *
 * ## Why the sandbox is not special here
 *
 * The same `PluginSandbox`, the same `ctx.http`, the same per-plugin host
 * allowlist. A verification pass that ran with more authority than the plugin
 * will have would verify something other than what gets installed.
 */

import {
	PluginSandbox,
	type RunnablePlugin,
	type SandboxOptions
} from '@plugin-bridge/host/sandbox-host';

/** Which part of the path failed, so a message can name it. */
export type VerificationStep = 'load' | 'search' | 'episodes' | 'resolve' | 'reach';

export interface VerificationResult {
	readonly ok: boolean;
	/** The step that failed, or null when every one passed. */
	readonly failedAt: VerificationStep | null;
	/** The plugin's own message, kept verbatim. */
	readonly detail: string | null;
	/** What it found, for a caller that wants to say so. */
	readonly searchHits: number;
	readonly episodeCount: number;
	readonly streamCount: number;
	/**
	 * How many of what it resolved were peer-to-peer descriptors.
	 *
	 * The evidence behind `ConversionRecord.observedP2p`. Counted rather than
	 * flagged, because the count separates two situations a boolean cannot: a
	 * source answering with torrents *and* direct links needs no special
	 * capability to play here, while one answering with torrents alone does.
	 * This and `streamCount` are read together for that reason.
	 */
	readonly torrentCount: number;
}

export interface VerifyOptions extends SandboxOptions {
	/**
	 * What the sandbox is started with, if anything.
	 *
	 * A check runs before anything is installed, so there are no viewer choices
	 * yet — this is the bundle's own declared defaults, resolved by the caller.
	 * Passing them matters because a converted source's commonest preference is
	 * a base URL: a check run on `{}` would exercise whichever mirror the
	 * bundle's internal fallback happened to name, and then the install would
	 * run on a different one.
	 */
	readonly settings?: Readonly<Record<string, unknown>>;
	/**
	 * What to search for.
	 *
	 * A single common particle rather than a title: every catalogue has
	 * something matching it, and picking a real show would make the gate depend
	 * on that show being in that catalogue.
	 */
	readonly probe?: string;
	/**
	 * Source media ids to ask about instead of searching.
	 *
	 * Used only for a source whose conversion record declares it is addressed
	 * by an external id — see `DEFAULT_PROBE_IDS` for why such a source cannot
	 * be checked by searching it.
	 */
	readonly probeIds?: readonly string[];
	/** Overall ceiling. The sandbox enforces its own per-call timeout too. */
	readonly budgetMs?: number;
	/**
	 * Fetches a resolved stream URL, far enough to know it answers.
	 *
	 * The step that makes a pass mean something. Without it, "resolved a
	 * stream" means only that the plugin returned a string — and these modules
	 * signal failure *by returning a URL*, so a module that has given up looks
	 * exactly like one that succeeded. That produced a green tick on a plugin
	 * whose stream turned out to be a placeholder, which is the one outcome
	 * this whole gate exists to prevent.
	 *
	 * Optional: when absent the check stops after `resolve` and says so rather
	 * than claiming more than it verified. Unit tests leave it out to stay
	 * hermetic; the app supplies one.
	 *
	 * Given the stream's own request headers as well as its url: these modules
	 * routinely resolve onto a CDN that serves nothing without the `Referer` of
	 * the embed page it came from, and a probe that dropped them would report a
	 * working stream as a placeholder.
	 *
	 * It answers with a reason rather than a boolean. `false` collapsed four
	 * different worlds — a host the plugin never declared, a TLS chain this
	 * runtime could not verify, a 403 from a CDN, and an actual placeholder —
	 * into one sentence about placeholders, and three quarters of the time that
	 * sentence was wrong. Three of those four are ours to fix and only one is
	 * the source's; a verdict that cannot tell them apart cannot be acted on.
	 */
	readonly reach?: (
		url: string,
		headers: Record<string, string>,
		/**
		 * What the plugin may reach *now*, declared plus learned this run.
		 *
		 * Passed because a probe holding only the converted host list refuses
		 * urls the sandbox itself just allowed: these modules find their video
		 * on a host the page handed them, and the stream url comes out of the
		 * same `resolve()` answer. Judging it against the static list reported
		 * a working stream as one nothing answered for.
		 */
		reachableHosts: readonly string[]
	) => Promise<ReachOutcome>;
}

/**
 * What a probe found at one stream URL.
 *
 * `detail` is a fragment, not a sentence — it is joined with others and read
 * after the host it belongs to, so "403 from the CDN" rather than "The CDN
 * returned 403.".
 */
export type ReachOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string };

interface CatalogEntry {
	readonly sourceMediaId?: unknown;
}

interface EpisodeRow {
	readonly number?: unknown;
	readonly sourceEpisodeId?: unknown;
}

interface StreamRow {
	readonly url?: unknown;
	readonly container?: unknown;
	readonly headers?: unknown;
}

/**
 * The request headers the shim found on a stream, keeping only the string ones.
 *
 * A module may attach anything at all here; what reaches the proxy has to be a
 * header map, and a non-string value is a module's mistake rather than a reason
 * to fail the probe.
 */
function headersOf(stream: StreamRow): Record<string, string> {
	if (stream.headers === null || typeof stream.headers !== 'object') return {};
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(stream.headers as Record<string, unknown>)) {
		if (typeof value === 'string') out[name] = value;
	}
	return out;
}

/** How far through the path a result got, for comparing two failures. */
const STEP_ORDER: readonly VerificationStep[] = ['load', 'search', 'episodes', 'resolve', 'reach'];

function reachedFurther(candidate: VerificationResult, incumbent: VerificationResult): boolean {
	return (
		STEP_ORDER.indexOf(candidate.failedAt ?? 'load') >
		STEP_ORDER.indexOf(incumbent.failedAt ?? 'load')
	);
}

const DEFAULT_PROBE = 'a';

/**
 * What to ask an id-addressed source about, when there is nothing to search.
 *
 * The counterpart to `DEFAULT_PROBE`, and it exists because that probe is
 * unusable for a whole class of source. An addon addressed by catalogue id may
 * publish no catalogues at all — the measured case returned `catalogs: []` —
 * and searching one for `'a'` returns nothing however healthy it is. Running
 * the search gate against it would fail every such source at `search` with
 * "Searching this source returned nothing", which is rule 17's exact
 * prohibition: a source-level verdict from a capability the check never had.
 *
 * Several ids rather than one, because a niche source legitimately carries
 * neither the film nor the series a single probe would name, and "this one
 * title is missing" is not "this source is broken". One answer passes.
 *
 * These are **work** ids, not sources: an IMDB id identifies a film the way an
 * AniList id identifies a series, and rule 9 bars naming a site that serves
 * media, which none of these is. One film and one series, because the two
 * take different paths through a source and an addon may serve only one.
 */
const DEFAULT_PROBE_IDS: readonly string[] = ['movie:tt0133093', 'series:tt0944947'];
const DEFAULT_BUDGET_MS = 60_000;

/** Containers the players actually open. Anything else is not a pass. */
const PLAYABLE = new Set(['mp4', 'hls', 'dash']);

/**
 * Drives one converted bundle through the four steps.
 *
 * Never throws for a plugin's own failure — those are the result. It throws
 * only if the harness itself cannot run, which is a different problem and
 * should not be reported to a viewer as "this plugin is broken".
 */
export async function verifyConvertedPlugin(
	plugin: RunnablePlugin,
	entrypointSource: string,
	options: VerifyOptions = {}
): Promise<VerificationResult> {
	const {
		probe = DEFAULT_PROBE,
		probeIds = DEFAULT_PROBE_IDS,
		budgetMs = DEFAULT_BUDGET_MS,
		reach,
		settings = {},
		...sandboxOptions
	} = options;

	const nothing = { searchHits: 0, episodeCount: 0, streamCount: 0, torrentCount: 0 };
	let sandbox: PluginSandbox | null = null;
	const deadline = Date.now() + budgetMs;
	const outOfTime = () => Date.now() > deadline;

	try {
		try {
			sandbox = await PluginSandbox.start(plugin, entrypointSource, settings, sandboxOptions);
		} catch (error) {
			return {
				ok: false,
				failedAt: 'load',
				detail: messageOf(error),
				...nothing
			};
		}

		// Narrowed once, because the attempt closure below loses the assignment
		// TypeScript can see in this scope and asserting inside it would be
		// asserting the same fact several times.
		const live: PluginSandbox = sandbox;

		// A source the host addresses by id is never searched at play time, so
		// searching it here would verify a path nothing uses — and for a source
		// with no catalogue at all, would fail it for answering a question it
		// never claimed to answer. The check runs what an install would.
		const idAddressed = (plugin.converted?.idKinds ?? []).length > 0;

		let entries: CatalogEntry[];
		if (idAddressed) {
			entries = probeIds.map((id) => ({ sourceMediaId: id }));
		} else {
			try {
				const page = (await sandbox.searchCatalog(probe, 1)) as {
					entries?: CatalogEntry[];
				} | null;
				entries = page?.entries ?? [];
			} catch (error) {
				return {
					ok: false,
					failedAt: 'search',
					detail: messageOf(error),
					...nothing
				};
			}
			const found = entries.find((entry) => typeof entry.sourceMediaId === 'string');
			if (found === undefined || outOfTime()) {
				return {
					ok: false,
					failedAt: 'search',
					detail:
						(entries.length === 0
							? 'Searching this source returned nothing.'
							: 'Search results carried no id this client can use.') + alsoRefused(sandbox),
					...nothing,
					searchHits: entries.length
				};
			}
		}

		const searchHits = idAddressed ? 0 : entries.length;

		/**
		 * One candidate, driven the whole way: episodes, a stream, and where a
		 * probe exists, a fetch of it.
		 *
		 * A function rather than a straight line because an id-addressed source
		 * gets more than one attempt, and the steps after the first are identical
		 * either way — a second copy of them is how the searched path and the
		 * id path would start reporting different things for the same failure.
		 */
		const attempt = async (candidate: string): Promise<VerificationResult> => {
			let episodes: EpisodeRow[];
			try {
				episodes = ((await live.listEpisodes(candidate)) ?? []) as EpisodeRow[];
			} catch (error) {
				return {
					ok: false,
					failedAt: 'episodes',
					detail: messageOf(error),
					...nothing,
					searchHits: searchHits
				};
			}
			const episode = episodes.find((row) => typeof row.sourceEpisodeId === 'string');
			if (episode === undefined || outOfTime()) {
				return {
					ok: false,
					failedAt: 'episodes',
					detail:
						(episodes.length === 0
							? 'That source listed no episodes for the first thing it found.'
							: 'Its episode list carried no id this client can use.') + alsoRefused(sandbox),
					...nothing,
					searchHits: searchHits,
					episodeCount: episodes.length
				};
			}

			let streams: StreamRow[];
			try {
				streams = ((await live.resolve(candidate, {
					number: Number(episode.number) || 1,
					sourceEpisodeId: String(episode.sourceEpisodeId)
				})) ?? []) as StreamRow[];
			} catch (error) {
				return {
					ok: false,
					failedAt: 'resolve',
					detail: messageOf(error),
					...nothing,
					searchHits: searchHits,
					episodeCount: episodes.length
				};
			}

			// https, and a container something can open. A resolved url that is
			// neither is not a stream, however confidently it was returned.
			const playable = streams.filter(
				(stream) =>
					typeof stream.url === 'string' &&
					stream.url.startsWith('https://') &&
					PLAYABLE.has(String(stream.container ?? 'hls'))
			);

			// Counted, not judged. Whether a descriptor can become a stream is the
			// host's question — this records that the source answered with one,
			// so a row can say so honestly whatever this build can do about it.
			const torrents = streams.filter(
				(stream) => typeof (stream as { torrent?: unknown }).torrent === 'object'
			);

			const counts = {
				searchHits: searchHits,
				episodeCount: episodes.length,
				streamCount: playable.length,
				torrentCount: torrents.length
			};

			// A source that answered with descriptors this build cannot acquire
			// has still answered, and the gate says so rather than calling it
			// broken — what stops it playing is a capability, which is not a
			// property of the source and must not be reported as one.
			if (playable.length === 0 && torrents.length > 0) {
				return { ok: true, failedAt: null, detail: null, ...counts };
			}

			if (playable.length === 0) {
				return {
					ok: false,
					failedAt: 'resolve',
					detail:
						(streams.length === 0
							? 'That source returned no stream for its first episode.'
							: 'The streams it returned are not https, or are in a format this client cannot play.') +
						alsoRefused(sandbox),
					...counts
				};
			}

			// Returning a URL is not the same as having a stream. Where a probe is
			// available, one is fetched — because a module that failed and a module
			// that succeeded are otherwise indistinguishable from here.
			if (reach !== undefined && !outOfTime()) {
				let reached = false;
				const refusals: string[] = [];
				for (const stream of playable) {
					try {
						// The stream's own host is offered as reachable alongside
						// everything else. Not a loophole: an extractor computes its
						// final address out of a provider's payload, so it appears
						// in no page and no manifest and neither the conversion nor
						// the run's learning can have seen it. Playback reaches it
						// the same way — `plugin-playback-repository.ts` seeds it
						// into the stream ticket — so a probe that refused it would
						// be failing sources that play, which is the one thing this
						// gate must never do.
						const outcome = await reach(String(stream.url), headersOf(stream), [
							...(sandbox?.reachableHosts ?? plugin.hosts),
							...hostsOf(stream.url)
						]);
						if (outcome.ok) {
							reached = true;
							break;
						}
						refusals.push(`${hostOf(String(stream.url))}: ${outcome.detail}`);
					} catch (error) {
						// One unreachable mirror is not a verdict; sources routinely
						// return several and expect the player to fall through them.
						refusals.push(`${hostOf(String(stream.url))}: ${messageOf(error)}`);
						continue;
					}
				}
				if (!reached) {
					return {
						ok: false,
						failedAt: 'reach',
						// Every mirror, not just the first. A source that returns
						// four addresses and is refused by all four for the same
						// reason is telling you something a single line does not.
						detail: `It resolved a stream, but nothing answered — ${unique(refusals).join('; ')}.`,
						...counts
					};
				}
			}

			return { ok: true, failedAt: null, detail: null, ...counts };
		};

		const candidates = entries
			.map((entry) => entry.sourceMediaId)
			.filter((id): id is string => typeof id === 'string');
		if (candidates.length === 0) {
			return {
				ok: false,
				failedAt: 'search',
				detail: 'This check had nothing to ask that source about.' + alsoRefused(sandbox),
				...nothing
			};
		}

		// One candidate for a searched source — the first result is what a
		// viewer would have clicked. Several for an id-addressed one, where a
		// missing title is a fact about the title and the next probe is the
		// only way to tell that from a source that answers nothing.
		// The failure kept is the one that got *furthest*, not the last one
		// tried. A probe that reached `resolve` and found nothing playable is
		// describing the source; a later probe failing at `episodes` because
		// this addon has no metadata for that particular title is describing
		// the title. Reporting the second would bury the first.
		let worst: VerificationResult | null = null;
		for (const candidate of candidates) {
			const outcome = await attempt(candidate);
			if (outcome.ok) return outcome;
			if (worst === null || reachedFurther(outcome, worst)) worst = outcome;
			if (!idAddressed || outOfTime()) break;
		}
		return (
			worst ?? {
				ok: false,
				failedAt: 'resolve',
				detail: 'Nothing this check asked about produced a stream.' + alsoRefused(sandbox),
				...nothing
			}
		);
	} finally {
		sandbox?.dispose();
	}
}

/** A sentence for a viewer, naming the step and quoting the plugin. */
export function describeVerification(name: string, result: VerificationResult): string {
	if (result.ok) {
		// A pass earned entirely by descriptors is a different sentence. The
		// gate stopped failing those on purpose — what prevents playback is a
		// capability, not the source — but saying "played a stream" of a run
		// that played nothing swaps one wrong verdict for another.
		if (result.streamCount === 0 && result.torrentCount > 0) {
			return (
				`${name} answered a test search and episode list, and offered ` +
				`${result.torrentCount} peer-to-peer stream(s). Nothing was played: acquiring one ` +
				`needs a client that can join a swarm.`
			);
		}
		return `${name} answered a test search, episode list and stream.`;
	}

	const step = {
		load: 'could not be loaded',
		search: 'could not search',
		episodes: 'could not list episodes',
		resolve: 'could not resolve a stream',
		// Not "resolved a stream that does not exist" any more. The probe now
		// says which of the several possible reasons applied, and most of them
		// are about our reach rather than the stream's existence.
		reach: 'resolved a stream nothing answered for'
	}[result.failedAt ?? 'load'];

	return `${name} ${step}.${result.detail === null ? '' : ` ${result.detail}`}`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A sentence naming the hosts we would not let the plugin reach, or ''.
 *
 * Appended to whatever the step reported, because these two facts belong
 * together and only ever appeared apart. A converted scraper reaches its embed
 * providers by following links out of the page it just read, so those hosts are
 * named nowhere in its code and cannot be derived from it — `hostsInSource`
 * says as much. The refusal is correct; reporting it as the source having no
 * stream is not, and it sent a viewer looking at a source that works.
 */
function alsoRefused(sandbox: PluginSandbox | null): string {
	const hosts = sandbox?.refusedHosts ?? [];
	const failures = sandbox?.outboundFailures ?? [];

	let detail = '';
	if (hosts.length > 0) {
		detail +=
			` It was also refused ${hosts.join(', ')} — host${hosts.length === 1 ? '' : 's'} it tried ` +
			'to reach that the conversion could not know to declare.';
	}
	// What the proxy said about the hosts it did try. A module walking a list
	// of dead providers swallows every one of these, so without them the only
	// visible evidence is a run that produced nothing.
	if (failures.length > 0) {
		detail += ` Along the way: ${failures.join('; ')}.`;
	}
	return detail;
}

/** The https host of a resolved url, as a one-item list, or none. */
function hostsOf(url: unknown): string[] {
	try {
		const parsed = new URL(String(url));
		return parsed.protocol === 'https:' ? [parsed.hostname.toLowerCase()] : [];
	} catch {
		return [];
	}
}

/** The host, for naming which mirror said what. The whole url if it is not one. */
function hostOf(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return url;
	}
}

/** Four mirrors refused for one reason should read as one reason. */
function unique(lines: readonly string[]): string[] {
	return [...new Set(lines)];
}
