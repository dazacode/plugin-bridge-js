/**
 * The measurement ADR-0004 §5 calls the project's primary instrument.
 *
 * `tool/kotlin-convert-report.ts` produced the numbers `FOREIGN.md` §4.1.6 rests
 * on — 250 refused, 4 translated, 4 answering `searchCatalog`, 0 downstream
 * failures — and it produced them once, by hand, for one format. This is that
 * report generalised: one row per listing, from a real run of `FOREIGN.md` §6's
 * five steps, tallied per format.
 *
 * It shapes data and nothing else. Running the checks is `tool/check-catalogue.ts`
 * and the host it runs them on; keeping the two apart is what lets the shaping be
 * tested against fixed rows instead of against a network.
 *
 * ## The one question, and the three ways of getting it wrong
 *
 * *How many listings pass all five steps.* Not how many parse, not how many
 * emit — `FOREIGN.md` §4.1.5 is explicit that **emit rate is not works rate**,
 * and the gap between the two is the most useful thing either measurement in
 * that document produced.
 *
 * So the tally separates three things a single "failed" column would merge:
 *
 * - **not testable** — it cannot be installed at all, so there is nothing to
 *   learn. A browse-only format, a medium this build does not show. Counting
 *   these as failures makes a browse-only repository look like a repository of
 *   broken things.
 * - **would not convert** — no bundle was produced, so none of the five steps
 *   ever ran. This is where 250 of 254 sat, and it is the number translator work
 *   moves.
 * - **converted and then failed at step N** — a bundle existed and did not work.
 *   `FOREIGN.md` §4.1.6's encouraging half is that this column was **zero**; if
 *   it stops being zero, the losses have moved and the next piece of work is
 *   somewhere else entirely.
 *
 * ## Why refusals are ranked by listings and not by frequency
 *
 * Because the two answer different questions and only one of them chooses the
 * next piece of work. *How often does this construct appear* rewards whatever is
 * common; *how many listings would fixing this unblock* rewards whatever is
 * blocking. `FOREIGN.md` §4.1.4 and §4.1.6 both rank the second way, and the
 * discipline has already paid twice: it is what produced the negative result
 * about extractor modules — feeding them in moved the count from 4 to **0** —
 * and what stopped 403 recovered constants being mistaken for progress.
 *
 * Each listing therefore contributes each reason at most once. `ForeignFormatError`
 * carries the reasons as named kinds rather than as prose, so the ranking does
 * not depend on nobody rewording an error message.
 */

import type { CheckResult } from '@plugin-bridge/core/check';
import type { ObstacleSite } from '@plugin-bridge/core/obstacles';
import type { VerificationStep } from '@plugin-bridge/core/verify';

/** The five steps of `FOREIGN.md` §6, in the order they run. */
export const STEPS: readonly VerificationStep[] = [
	'load',
	'search',
	'episodes',
	'resolve',
	'reach'
];

/** One listing's outcome, flattened into what a report needs. */
export interface ScoredListing {
	readonly id: string;
	readonly name: string;
	/** The foreign format, or `yorozo` for a listing that needs no conversion. */
	readonly format: string;
	readonly version: string;
	readonly status: CheckResult['status'];
	readonly failedAt: VerificationStep | null;
	readonly detail: string | null;
	readonly obstacles: readonly string[];
	/** The same obstacles, addressed. Empty unless the conversion had sites. */
	readonly sites: readonly ObstacleSite[];
	readonly searchHits: number;
	readonly episodeCount: number;
	readonly streamCount: number;
}

/** What one format's listings came to. */
export interface FormatTally {
	readonly listings: number;
	/** Cannot be installed, so nothing was requested and nothing was learned. */
	readonly notTestable: number;
	/** Never reached — a run that was stopped, or a limit. */
	readonly untested: number;
	/** No bundle was produced, so none of the five steps ran. */
	readonly wouldNotConvert: number;
	/** A bundle existed. The sum of `works` and everything in `failed`. */
	readonly converted: number;
	/** Converted, ran, and failed — by the step it failed at. */
	readonly failed: Readonly<Record<VerificationStep, number>>;
	/** Searched, listed episodes, resolved a stream, and something answered. */
	readonly works: number;
	/** The same listings again, cut by *why* rather than by how far they got. */
	readonly reach: Readonly<Record<Reach, number>>;
}

/**
 * What stands between a listing and working, as a kind rather than a step.
 *
 * `FormatTally` answers "how far did it get", which is the right question while
 * the translator is the thing moving. It is the wrong question for deciding
 * what is left, because it files three unrelated situations under one heading:
 * an extension this build could support and does not yet, an extension that
 * needs a browser engine, and an extension whose website is gone. Ranking work
 * off that column means ranking work off a number two thirds of which no amount
 * of converter effort can move.
 *
 * So this is the second cut, and the one to plan from:
 *
 * - **portable** — it converts and it works. The whole claim, proven.
 * - **unproven** — it converts and something downstream did not answer. Usually
 *   the source rather than the conversion, but not always, so it is not counted
 *   as either.
 * - **unreachable** — the host itself could not reach the site: a proxy error, a
 *   name that does not resolve. Nothing here is a compatibility question.
 * - **widen** — refused, and everything it refused on is something this build
 *   could come to support. This is the backlog.
 * - **native** — refused on a capability this host does not have and is not
 *   going to grow: a browser engine, an embedded JavaScript engine, a JVM cipher
 *   suite, a cookie jar, a local HTTP server. Not a backlog item; a boundary.
 * - **absent** — nothing to learn: unconvertible format, or never run.
 */
export type Reach = 'portable' | 'unproven' | 'unreachable' | 'widen' | 'native' | 'absent';

/** One reason, and how many listings it is the reason for. */
export interface RankedRefusal {
	readonly reason: string;
	readonly listings: number;
	/**
	 * `named` is the translator's own word for an obstacle; `message` is a
	 * sentence normalised into a bucket.
	 *
	 * Kept apart because they are not equally trustworthy. A named kind is exact
	 * and stable across rewordings; a bucketed message is this file's guess at
	 * which failures are the same failure, and a reader ranking work off one
	 * should know which they are looking at.
	 */
	readonly kind: 'named' | 'message';
}

export interface Scoreboard {
	readonly formats: Readonly<Record<string, FormatTally>>;
	readonly totals: FormatTally;
	/** Every reason, most listings first, then alphabetically. */
	readonly refusals: readonly RankedRefusal[];
}

function emptyTally(): FormatTally {
	return {
		listings: 0,
		notTestable: 0,
		untested: 0,
		wouldNotConvert: 0,
		converted: 0,
		failed: { load: 0, search: 0, episodes: 0, resolve: 0, reach: 0 },
		works: 0,
		reach: {
			portable: 0,
			unproven: 0,
			unreachable: 0,
			widen: 0,
			native: 0,
			absent: 0
		}
	};
}

function add(tally: FormatTally, row: ScoredListing): FormatTally {
	const failed = { ...tally.failed };
	let notTestable = tally.notTestable;
	let untested = tally.untested;
	let wouldNotConvert = tally.wouldNotConvert;
	let converted = tally.converted;
	let works = tally.works;

	if (row.status === 'notTestable') notTestable += 1;
	else if (row.status === 'untested' || row.status === 'checking') untested += 1;
	else if (row.status === 'works') {
		works += 1;
		converted += 1;
	} else if (row.failedAt === null) {
		// Broken with no step named: the conversion itself refused, so nothing
		// was ever built and none of the five steps ran.
		wouldNotConvert += 1;
	} else {
		failed[row.failedAt] += 1;
		converted += 1;
	}

	const reach = { ...tally.reach };
	reach[reachOf(row)] += 1;

	return {
		listings: tally.listings + 1,
		notTestable,
		untested,
		wouldNotConvert,
		converted,
		failed,
		works,
		reach
	};
}

/**
 * A failure sentence, reduced to the thing that makes it the same failure twice.
 *
 * A fallback, and only for listings whose refusal carried no named kinds — a
 * repository that names no source, an artifact that is not where the index says.
 * Those messages are written for a person and carry the listing's own name, its
 * URLs and its counts, so two instances of one problem look like two problems.
 *
 * The normalisation is deliberately blunt: quoted fragments, digits and anything
 * URL-shaped become placeholders, and the result is cut to one clause. It is a
 * bucketing heuristic and is labelled as one in `RankedRefusal.kind` — the exact
 * ranking is the named one above it.
 *
 * Rule 9: this reduces text that arrives at runtime, and nothing it produces is
 * written to a file in this repository.
 */
export function bucketMessage(detail: string): string {
	const cut = detail.split(/(?<=\.)\s/)[0] ?? detail;
	return cut
		.replace(/https?:\/\/\S+/g, '<url>')
		.replace(/`[^`]*`/g, '<name>')
		.replace(/\b\d+\b/g, '<n>')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 120);
}

/**
 * The reasons one listing gives, each at most once.
 *
 * A listing with named obstacles contributes those and nothing else: the
 * sentence it also carries is a rendering of the same facts, and counting both
 * would double the weight of exactly the listings the ranking is meant to
 * distinguish.
 *
 * A listing that converted and then failed contributes the step it failed at
 * alongside its sentence, because the two kinds of blocker are not the same kind
 * of work: one is the translator's and one is the source's or the runtime's, and
 * a ranking that read "nothing answered" next to "a `super.` call" without
 * saying which was which would invite the wrong afternoon.
 */
function reasonsOf(row: ScoredListing): { reason: string; kind: 'named' | 'message' }[] {
	if (row.obstacles.length > 0) {
		return [...new Set(row.obstacles)].map((reason) => ({
			reason,
			kind: 'named' as const
		}));
	}
	if (row.status !== 'broken' || row.detail === null) return [];
	const bucketed = bucketMessage(row.detail);
	return [
		{
			reason: row.failedAt === null ? bucketed : `at ${row.failedAt} — ${bucketed}`,
			kind: 'message' as const
		}
	];
}

/** Every listing's outcome, tallied per format and ranked. */
/**
 * Obstacles that name a capability this host does not provide.
 *
 * Matched on the obstacle's own words, which are stable — they are the
 * translator's names for constructs, not prose. Each one is here because the
 * thing it needs is outside what a portable runtime in a browser tab can be:
 * a real WebView, a second JavaScript engine to run untrusted script in, the
 * JVM's cipher and signature providers, a thread, a socket to listen on.
 *
 * Cookies used to be on that list in full and are now on it in part. The host
 * keeps a per-plugin, per-host, in-memory jar (ADR-0005 §3), so setting one and
 * saving to one are ordinary conversions; what stays here is the half the jar
 * cannot honour — an extension *reading* its own jar, and the WebView's cookie
 * store. Those are refusals by design rather than gaps, which is exactly what
 * this column is for.
 *
 * Deliberately a short list of specific names rather than a pattern. A blanket
 * rule would quietly reclassify tomorrow's ordinary gap as a boundary, and the
 * whole value of this column is that it is the set nobody is planning to move.
 */
const NATIVE_CAPABILITIES: readonly RegExp[] = [
	/WebView/,
	/embedded JavaScript engine/,
	/javax\.crypto/,
	/SecureRandom/,
	/\.initSign\(\)/,
	/\.addInterceptor\(\)/,
	// Both spellings: the passthrough allowlist refuses a call as `.name()`, and
	// the scanner refuses the same shape by the name `NAMED_OBSTACLES` gives it.
	/\.loadForRequest\(\)/,
	/reading a cookie jar/,
	/\.getCookie\(\)/,
	/WebView cookie store/,
	// android.os.Handler — posting to a looper this host does not have. It sits
	// beside the thread cases rather than beside the API gaps: an extension
	// reaching for one wants work to happen somewhere else, and there is no
	// somewhere else.
	/Handler\(/,
	/a background thread/,
	/Thread\(/,
	// A plugin that stands up its own HTTP server on localhost — ADR-0006.
	//
	// The foreign idiom serves `/m3u8` and `/segment` from a loopback port so
	// that per-request headers survive to every segment and an AES key can be
	// fetched under them. A plugin that *listens* outlives its call, holds a
	// port and is reachable by anything else on the machine, and the browser
	// host could not offer one at any price. `StreamPipeline` supplies the same
	// behaviour declaratively, so this is a boundary and not a backlog item.
	//
	// `ForwardingSource` and `PlaylistServer` were here first, spotted as two
	// unrelated names before the cluster was read as one thing.
	/ForwardingSource/,
	/PlaylistServer/,
	/NanoHTTPD/,
	/startServer/,
	/getListeningPort\(\)/,
	/\.createLocalUrl\(\)/,
	/\.createProxyUrl\(\)/,
	/\.segmentProxyUrl\(\)/,
	/\.alwaysNeedsProxy\(\)/,
	/an android\.\* API/
];

/** The host saying it could not get there, as against the plugin failing. */
const UNREACHABLE = /could not reach|proxy returned 5\d\d|ENOTFOUND|ECONNREFUSED/i;

/**
 * Which of the six a listing is in.
 *
 * Order matters: a listing that works is portable whatever else is true of it,
 * and a refusal is classified by its *hardest* obstacle — one native capability
 * is enough, because supporting everything else would still leave it refused.
 */
export function reachOf(row: ScoredListing): Reach {
	if (row.status === 'works') return 'portable';
	if (row.status === 'notTestable' || row.status === 'untested') return 'absent';
	if (row.failedAt !== null) {
		return UNREACHABLE.test(row.detail ?? '') ? 'unreachable' : 'unproven';
	}
	const native = row.obstacles.some((obstacle) =>
		NATIVE_CAPABILITIES.some((pattern) => pattern.test(obstacle))
	);
	return native ? 'native' : 'widen';
}

export function score(rows: readonly ScoredListing[]): Scoreboard {
	const formats = new Map<string, FormatTally>();
	let totals = emptyTally();
	const refusals = new Map<string, { listings: number; kind: 'named' | 'message' }>();

	for (const row of rows) {
		formats.set(row.format, add(formats.get(row.format) ?? emptyTally(), row));
		totals = add(totals, row);
		for (const { reason, kind } of reasonsOf(row)) {
			const seen = refusals.get(reason);
			refusals.set(reason, {
				listings: (seen?.listings ?? 0) + 1,
				kind: seen?.kind ?? kind
			});
		}
	}

	return {
		// Sorted, because this file's output is diffed between two runs and a
		// key order that follows arrival order would show every listing moving
		// whenever a repository reorders its index.
		formats: Object.fromEntries([...formats.entries()].sort(([a], [b]) => a.localeCompare(b))),
		totals,
		refusals: [...refusals.entries()]
			.map(([reason, { listings, kind }]) => ({ reason, listings, kind }))
			.sort((a, b) => b.listings - a.listings || a.reason.localeCompare(b.reason))
	};
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function pad(value: string, width: number): string {
	return value.length >= width ? value : `${value}${' '.repeat(width - value.length)}`;
}

function padStart(value: string, width: number): string {
	return value.length >= width ? value : `${' '.repeat(width - value.length)}${value}`;
}

/**
 * The per-format table, for a person.
 *
 * Column order follows what a listing goes through: how many there are, how many
 * there was nothing to learn from, how many never produced a bundle, how many
 * did, and how many of those work. The last column is the one the document is
 * about, so it is last and it is the only one that is also a proportion.
 */
export function renderScoreboard(board: Scoreboard, refusalLimit = 12): string {
	const rows: string[][] = [
		['format', 'listings', 'untestable', 'no convert', 'converted', 'works', 'works %']
	];

	const line = (name: string, tally: FormatTally): string[] => {
		const denominator = tally.listings - tally.notTestable - tally.untested;
		return [
			name,
			String(tally.listings),
			String(tally.notTestable),
			String(tally.wouldNotConvert),
			String(tally.converted),
			String(tally.works),
			denominator === 0 ? '—' : `${((tally.works / denominator) * 100).toFixed(1)}%`
		];
	};

	for (const [name, tally] of Object.entries(board.formats)) rows.push(line(name, tally));
	if (Object.keys(board.formats).length > 1) rows.push(line('all', board.totals));

	const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
	const table = rows
		.map((row, index) => {
			const rendered = row
				.map((cell, column) =>
					column === 0 ? pad(cell, widths[0]) : padStart(cell, widths[column])
				)
				.join('  ');
			return index === 0
				? `${rendered}\n${widths.map((width) => '─'.repeat(width)).join('  ')}`
				: rendered;
		})
		.join('\n');

	// The second cut, and the one to plan from. The table above says how far a
	// listing got; this says what is standing in the way, which is a different
	// question with a different answer for two thirds of the catalogue.
	const reach = board.totals.reach;
	const planning = [
		`\nWhat stands in the way, over ${board.totals.listings} listings:`,
		`  ${padStart(String(reach.portable), 4)}  portable — converts and works`,
		`  ${padStart(String(reach.unproven), 4)}  unproven — converts, and something downstream did not answer`,
		`  ${padStart(String(reach.unreachable), 4)}  unreachable — the host could not get to the site at all`,
		`  ${padStart(String(reach.widen), 4)}  widen — refused on something this build could come to support`,
		`  ${padStart(String(reach.native), 4)}  native — refused on a capability this host does not have`,
		reach.absent === 0 ? null : `  ${padStart(String(reach.absent), 4)}  absent — nothing to learn`
	]
		.filter((row): row is string => row !== null)
		.join('\n');

	const steps = STEPS.filter((step) => board.totals.failed[step] > 0);
	const failures =
		steps.length === 0
			? board.totals.converted === 0
				? ''
				: '\nNothing that converted failed afterwards.'
			: `\nConverted, then failed at: ${steps
					.map((step) => `${step} ${board.totals.failed[step]}`)
					.join(', ')}.`;

	if (board.refusals.length === 0) return `${table}\n${failures}\n${planning}`.trimEnd();

	const shown = board.refusals.slice(0, refusalLimit);
	const width = Math.max(...shown.map((one) => String(one.listings).length));
	const ranked = shown
		.map(
			(one) =>
				`  ${padStart(String(one.listings), width)}  ${one.reason}${one.kind === 'message' ? ' (bucketed)' : ''}`
		)
		.join('\n');
	const more =
		board.refusals.length > shown.length
			? `\n  … and ${board.refusals.length - shown.length} more.`
			: '';

	return (
		`${table}\n${failures}\n${planning}\n\n` +
		'What blocked them, by listings each would unblock:\n' +
		`${ranked}${more}\n`
	);
}

/* ── why one listing failed ───────────────────────────────────────────────── */

/**
 * The long form: every failed listing, with the address of what stopped it.
 *
 * The table above answers *how many* and the ranking answers *what to build
 * next*. Neither answers the question somebody actually has when they sit down
 * to widen the translator — **where** — and until this existed the answer to
 * that was a grep over a catalogue that is not in this repository and cannot
 * be.
 *
 * Two shapes, because two kinds of failure are two kinds of work:
 *
 * - a listing that never converted lists its obstacles, each with the file,
 *   the member, the line and the line's own text. That is translator work.
 * - a listing that converted and then failed names the step, the sentence, and
 *   what it managed before it stopped. That is runtime, network or source
 *   work, and mixing the two into one list is how an afternoon gets spent on
 *   the wrong front.
 *
 * A non-blocking obstacle is printed and marked as one. It is not why this
 * listing failed — `pipeline.ts` decided nothing the host calls would reach it
 * — but it is the same construct, and a reader deciding what to support next
 * wants to know it turned up twice.
 */
export function renderWhy(rows: readonly ScoredListing[]): string {
	const failed = rows.filter((row) => row.status === 'broken');
	if (failed.length === 0) return 'Nothing failed.';

	const blocks = failed.map((row) => {
		const heading =
			row.failedAt === null
				? `${row.name} — would not convert`
				: `${row.name} — converted, then failed at ${row.failedAt}`;

		const lines = [heading];
		if (row.detail !== null) lines.push(`  ${row.detail}`);

		if (row.failedAt !== null) {
			// Said even when they are all zero, because "searched 12 and listed
			// no episodes" and "searched nothing" are different failures that
			// the step name alone does not tell apart.
			lines.push(
				`  reached: ${row.searchHits} search hit${row.searchHits === 1 ? '' : 's'}, ` +
					`${row.episodeCount} episode${row.episodeCount === 1 ? '' : 's'}, ` +
					`${row.streamCount} stream${row.streamCount === 1 ? '' : 's'}`
			);
		}

		// Blocking first: it is what stopped this one, and a long tail of
		// unreached refusals underneath it must not push it off a screen.
		const ordered = [...row.sites].sort((a, b) =>
			a.blocking === b.blocking
				? a.file.localeCompare(b.file) || a.line - b.line
				: a.blocking
					? -1
					: 1
		);
		for (const site of ordered) {
			lines.push(
				`  ${site.file}:${site.line}  ${site.member}  —  ${site.kind}` +
					(site.blocking ? '' : '  (not blocking)')
			);
			if (site.text.length > 0) lines.push(`      ${site.text}`);
		}
		return lines.join('\n');
	});

	return `Why they failed:\n\n${blocks.join('\n\n')}\n`;
}
