// Runs FOREIGN.md §6's five steps over a whole repository and scores the result.
//
//   bun ../tool/check-catalogue.ts <index-url>      (also: bun run check:catalogue)
//
// ## What this is
//
// ADR-0004 §5's scoreboard, and §6.2's laboratory. It answers one question per
// format — *how many listings pass all five steps* — and it answers it by
// running the same code the browser client runs when somebody presses Install,
// on the second implementation of the host port
// (`packages/host-node/src/headless-plugin-host.ts`).
//
// The verdicts are supposed to match a tab's row for row. That is the whole
// value of a second host, and a disagreement is a port bug rather than a quirk
// of the tool: `client-web/src/lib/host/host-equivalence.spec.ts` is the standing
// proof on every fixture this repository has.
//
// ## What it does not do
//
// It ships no repository and defaults to none. **AGENTS.md rule 9**: no content
// source, no extension catalogue, no extractor host appears in this repository —
// not in code, not in a comment, not in a default, not in an example. The index
// URL is a runtime argument and there is nowhere here for one to be written down.
//
// It also keeps nothing. `checkListing` converts in memory, runs, and discards —
// `FOREIGN.md` §6.1 — so a run leaves no plugin installed and no files behind.
// What it does remember is *verdicts*, keyed by each listing's own version and
// by the converter that answered, in the host's key-value store, because those
// requests were spent either way and re-spending them on a second run would be
// rude twice. Bumping `CONVERTER_VERSION` is what makes a run after a widened
// translator a measurement rather than a replay; `--fresh` forces the same
// thing for a change that did not warrant a bump.
//
// ## Politeness is the design, not a setting
//
// Every check makes real requests to a real source. Checking two hundred
// listings means two hundred sites searched, and `FOREIGN.md` §6.1 is explicit
// about what follows from that: a few at a time, on request, stoppable, keeping
// whatever it already learned. So the default concurrency is three, Ctrl-C stops
// scheduling and still writes a report, and listings that cannot be installed are
// never requested at all.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { headlessPluginHost, sandboxReport } from '@plugin-bridge/host-node/headless-plugin-host';
import {
	renderScoreboard,
	renderWhy,
	score,
	type ScoredListing
} from '@plugin-bridge/host/scoreboard';
import { checkListing } from '@plugin-bridge/host/catalogue';
import { detectRepository } from '@plugin-bridge/core/detect';
import { FOREIGN_ADAPTERS } from '@plugin-bridge/adapters';
import { checkKey, loadChecks, saveChecks, type CheckResult } from '@plugin-bridge/core/check';
import { CONVERTER_VERSION } from '@plugin-bridge/core/package';
import { createTreeLister } from '@plugin-bridge/core/git-trees';
import { formatPreflight, runPreflight } from './preflight';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';

const SCHEMA = 'yorozo.catalogue-check.v1';

interface Options {
	readonly indexUrl: string;
	readonly atATime: number;
	readonly limit: number;
	readonly json: string | null;
	readonly dataDir: string | undefined;
	readonly fresh: boolean;
	readonly why: boolean;
}

const USAGE = `Usage: bun tool/check-catalogue.ts <index-url> [options]

  --at-a-time <n>   how many listings to check concurrently (default 3)
  --limit <n>       stop after this many listings
  --json <path>     also write the machine-readable report there
  --data-dir <path> where remembered verdicts live (default ~/.yorozo)
  --fresh           ignore remembered verdicts and check everything again
  --why             after the table, print every failure with the file, member
                    and line that stopped it

Ctrl-C stops scheduling new checks, lets the ones in flight finish, and still
writes the report. Nothing is installed and nothing is downloaded twice.
`;

function parseArgs(argv: readonly string[]): Options | null {
	let indexUrl = '';
	let atATime = 3;
	let limit = Number.POSITIVE_INFINITY;
	let json: string | null = null;
	let dataDir: string | undefined;
	let fresh = false;
	let why = false;

	for (let at = 0; at < argv.length; at += 1) {
		const argument = argv[at];
		const next = (): string => argv[(at += 1)] ?? '';
		if (argument === '--at-a-time') atATime = Math.max(1, Number(next()) || 3);
		else if (argument === '--limit') limit = Math.max(1, Number(next()) || 1);
		else if (argument === '--json') json = next();
		else if (argument === '--data-dir') dataDir = next();
		else if (argument === '--fresh') fresh = true;
		else if (argument === '--why') why = true;
		else if (argument === '--help' || argument === '-h') return null;
		else if (argument.startsWith('-')) return null;
		else indexUrl = argument;
	}

	if (!indexUrl.startsWith('https://')) return null;
	return { indexUrl, atATime, limit, json, dataDir, fresh, why };
}

/** Everything about this run that a later reader would need in order to trust it. */
interface Report {
	readonly schema: typeof SCHEMA;
	readonly checkedAt: string;
	readonly index: {
		readonly url: string;
		readonly name: string;
		readonly format: string;
	};
	readonly host: {
		readonly runtime: string;
		readonly containment: string;
		readonly converterVersion: number;
	};
	readonly run: {
		readonly listings: number;
		readonly checked: number;
		readonly remembered: number;
		readonly atATime: number;
		readonly stopped: boolean;
	};
	readonly formats: unknown;
	readonly totals: unknown;
	readonly refusals: unknown;
	readonly listings: readonly ScoredListing[];
}

function runtimeName(): string {
	const versions = process.versions as unknown as Record<string, string | undefined>;
	const bun = versions['bun'];
	return bun === undefined ? `node ${versions['node'] ?? '?'}` : `bun ${bun}`;
}

function scored(listing: RepositoryPlugin, result: CheckResult): ScoredListing {
	return {
		id: listing.id,
		name: listing.name,
		format: listing.origin?.format ?? 'yorozo',
		version: result.version,
		status: result.status,
		failedAt: result.failedAt,
		detail: result.detail,
		obstacles: result.obstacles ?? [],
		sites: result.sites ?? [],
		searchHits: result.searchHits ?? 0,
		episodeCount: result.episodeCount ?? 0,
		streamCount: result.streamCount ?? 0
	};
}

/**
 * Runs `worker` over `items`, at most `width` at a time, stopping when asked.
 *
 * A fixed pool rather than batches: a batch of three waits for its slowest
 * member before starting anything, and one listing whose source is timing out
 * would idle the other two for the whole timeout. Both are polite; only one is
 * also finished before the end of the afternoon.
 */
async function pooled<T>(
	items: readonly T[],
	width: number,
	stopping: () => boolean,
	worker: (item: T, index: number) => Promise<void>
): Promise<void> {
	let next = 0;
	const lane = async (): Promise<void> => {
		for (;;) {
			if (stopping()) return;
			const index = next;
			next += 1;
			if (index >= items.length) return;
			await worker(items[index], index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
}

/**
 * One row, as it happens, with the reason on the same line.
 *
 * The reason is the point. A run over a whole catalogue is minutes of scrolling
 * `broken  <name>`, and every one of those lines used to be a question rather
 * than an answer — the report at the end knew why and the line in front of you
 * did not. So the line carries the shape of the failure: which side of the
 * conversion it fell on, and either the constructs that stopped it or the step
 * it got to.
 *
 * Cut short on purpose. This is the line you skim; `--why` is the long form,
 * and putting a paragraph here would bury the one-word answer in it.
 */
function liveLine(name: string, result: CheckResult): string {
	if (result.status === 'works') return `works   ${name}`;

	const why =
		result.failedAt === null
			? (result.obstacles ?? []).length > 0
				? `no convert · ${(result.obstacles ?? []).join(', ')}`
				: 'no convert'
			: `at ${result.failedAt} · ${(result.detail ?? '').split(/(?<=\.)\s/)[0] ?? ''}`;

	const cut = why.length > 96 ? `${why.slice(0, 95)}…` : why;
	return `broken  ${name}\n            ${cut}`;
}

async function run(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	if (options === null) {
		process.stderr.write(USAGE);
		process.exit(2);
	}

	const host = headlessPluginHost({ dataDir: options.dataDir });
	const isolate = await sandboxReport();
	if (isolate === null) {
		process.stderr.write(
			'This machine could not start an isolate, so no plugin can be run and nothing can be\n' +
				'checked. The sandbox is a Node child process — see sandbox-bootstrap.ts for why —\n' +
				'so `node` has to be on the path.\n'
		);
		process.exit(1);
	}
	if (isolate.containment !== 'sealed') {
		// Not fatal, but it changes what every verdict below means, so it is said
		// once and loudly rather than left in a footnote.
		process.stderr.write(
			`The isolate could not be fully closed (${isolate.leftovers.join(', ')}). Every result\n` +
				'below was produced in a more capable environment than the browser client offers,\n' +
				'which is exactly the disagreement HOST.md §3.2 warns about.\n'
		);
	}

	// The port's network, for everything: a repository index is fetched
	// directly, and the runtime's own `/api/plugin-fetch` requests are served
	// in-process by the same relay that serves them under a web server.
	const text = async (url: string): Promise<string> => {
		const response = await host.fetch(url);
		if (!response.ok) throw new Error(`${response.status} from ${url}`);
		return await response.text();
	};
	const bytes = async (url: string): Promise<Uint8Array> => {
		const response = await host.fetch(url);
		if (!response.ok) throw new Error(`${response.status} from ${url}`);
		return new Uint8Array(await response.arrayBuffer());
	};

	// Detection rather than a single parser: an index may be any of the six
	// ecosystems, and each names its listings differently. `detectRepository`
	// tries the spellings a pasted URL could mean and returns ours.
	const detected = await detectRepository(options.indexUrl, text, FOREIGN_ADAPTERS);
	const index = detected.index;
	const listings = index.plugins.slice(0, options.limit);
	const capabilities = {
		host,
		download: bytes,
		getText: text,
		// The real tree lister, not a stub. This was `async () => []`, which
		// made every aniyomi listing unconvertible *by construction*: that
		// adapter locates an extension's Kotlin in the repository the artifact
		// was built from, and it finds the files by listing the directory. With
		// nothing listed it read `build.gradle`, found no `.kt` beside it, and
		// refused with "the source could not be found in the repository it is
		// built from" — a sentence about the catalogue under test, produced by
		// this file. Every aniyomi run scored 0%, and the number was the tool's.
		//
		// `createTreeLister` bounds the document itself (`MAX_TREE_BYTES`) and
		// caches the promise per repository and ref, so several listings
		// converting at once share one request rather than racing into the rate
		// limit. It is the same lister `web-plugin-registry.ts` hands the
		// browser, which is the point: this tool exists to answer row for row
		// what a tab would answer, and it cannot do that with a capability the
		// tab has and it does not.
		listFiles: createTreeLister(text)
	};

	// Before a single listing is judged, the harness proves the capabilities it
	// would be judging them with. A run that skipped this once reported an
	// entire ecosystem as broken and was describing itself — see `preflight.ts`
	// for the three, and for the rule that follows from them.
	//
	// The source repository is read off the first listing rather than guessed:
	// it is the same field `convert` will use, so checking any other address
	// would be checking something the campaign does not depend on.
	const sourceRepository = listings
		.map((listing) => listing.origin?.detail?.['sourceRepository'])
		.find((value): value is string => typeof value === 'string' && value.length > 0);

	const preflight = await runPreflight(capabilities, {
		indexUrl: detected.indexUrl,
		sourceRepository: sourceRepository ?? null
	});
	process.stderr.write(`Preflight:\n${formatPreflight(preflight)}\n\n`);
	if (!preflight.ok) {
		// No report, no scoreboard, no verdicts written — and in particular
		// nothing said about any source. Every conclusion downstream of here
		// would be a statement about the world resting on a part of this process
		// that is not working, which is the whole failure this guards.
		process.stderr.write(
			'Preflight failed, so nothing was checked and no scoreboard was written.\n' +
				'These are this harness\u2019s own capabilities, not the catalogue\u2019s: a verdict\n' +
				'produced without them would read as an ecosystem that does not work.\n'
		);
		process.exit(1);
	}

	const remembered = options.fresh ? new Map<string, CheckResult>() : loadChecks(host.kv);
	const results = new Map<string, CheckResult>(remembered);

	let stopped = false;
	let fromCache = 0;
	let ran = 0;
	const rows = new Map<string, ScoredListing>();

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		process.stderr.write(
			'\nStopping. The checks already in flight will finish and the report will still be\n' +
				'written — those requests are spent either way.\n'
		);
	};
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);

	process.stderr.write(
		`${index.name}: ${listings.length} listing${listings.length === 1 ? '' : 's'}, ` +
			`${options.atATime} at a time, ${runtimeName()}, isolate ${isolate.containment}.\n`
	);

	await pooled(
		listings,
		options.atATime,
		() => stopped,
		async (listing) => {
			const key = checkKey(listing);
			const known = results.get(key);
			if (known !== undefined) {
				fromCache += 1;
				rows.set(listing.id, scored(listing, known));
				return;
			}
			// A listing that cannot be installed is never *requested* — `FOREIGN.md`
			// §6.1 — and `checkListing` is where that decision lives, so it is
			// asked rather than second-guessed here. It answers `notTestable`
			// without a single byte leaving the machine.
			const result = await checkListing(listing, capabilities);
			rows.set(listing.id, scored(listing, result));
			if (result.status !== 'works' && result.status !== 'broken') return;

			ran += 1;
			results.set(key, result);
			// Written after every answer rather than at the end, so a run that is
			// killed outright still keeps what it learned.
			saveChecks(host.kv, results);
			process.stderr.write(`  ${liveLine(listing.name, result)}\n`);
		}
	);

	// A listing nobody reached is `untested`, which is a real answer and not a
	// failure — `FOREIGN.md` §6.1 is emphatic about that, and a report that
	// silently dropped the rows a stopped run never got to would overstate every
	// proportion in it.
	for (const listing of listings) {
		if (rows.has(listing.id)) continue;
		rows.set(listing.id, {
			id: listing.id,
			name: listing.name,
			format: listing.origin?.format ?? 'yorozo',
			version: listing.origin?.foreignVersion ?? listing.version,
			status: 'untested',
			failedAt: null,
			detail: null,
			obstacles: [],
			sites: [],
			searchHits: 0,
			episodeCount: 0,
			streamCount: 0
		});
	}

	const ordered = [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
	const board = score(ordered);

	const report: Report = {
		schema: SCHEMA,
		checkedAt: new Date().toISOString(),
		index: { url: detected.indexUrl, name: index.name, format: index.format },
		host: {
			runtime: runtimeName(),
			containment: isolate.containment,
			converterVersion: CONVERTER_VERSION
		},
		run: {
			listings: listings.length,
			checked: ran,
			remembered: fromCache,
			atATime: options.atATime,
			stopped
		},
		formats: board.formats,
		totals: board.totals,
		refusals: board.refusals,
		listings: ordered
	};

	if (options.json !== null) {
		writeFileSync(resolve(options.json), `${JSON.stringify(report, null, '\t')}\n`, 'utf8');
		process.stderr.write(`\nWrote ${resolve(options.json)}.\n`);
	}

	process.stdout.write(`\n${renderScoreboard(board)}\n`);
	// After the table rather than instead of it: the table is the measurement
	// and this is the working list, and a reader wants the proportions before
	// the detail.
	if (options.why) process.stdout.write(`\n${renderWhy(ordered)}\n`);
	if (stopped) {
		process.stdout.write(
			'\nStopped before the end. The untested column is what nobody reached, not what failed.\n'
		);
	}
}

/**
 * The subcommand entry. Returns an exit code rather than taking the process
 * down, because `main.ts` owns the process and a library never should.
 */
export async function runCatalogue(argv: string[]): Promise<number> {
	process.argv = [process.argv[0], process.argv[1], ...argv];
	try {
		await run();
		return 0;
	} catch (error) {
		// A repository that is not there, a body that is not an index, a network
		// that is down. All of them are answers about the argument rather than
		// faults in this tool, so they are said in a sentence rather than as a stack.
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}
