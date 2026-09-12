// Proves the harness's own capabilities are live, before it judges anybody else's.
//
// ## The incident this exists for
//
// A catalogue run once reported, for every listing in an aniyomi repository,
// that "the source could not be found in the repository it is built from". The
// source was there. What was missing was `listFiles`, stubbed to `[]` in the
// caller — so the adapter asked which files were beside `build.gradle`, was told
// none, and reported the only thing it could conclude.
//
// Fixing that surfaced a second: `createWorker` never reached the verifier, so
// every converted listing failed at `load` with "this host cannot run plugins".
// Fixing *that* surfaced a third: `fetcher` never reached it either, so the
// first request a plugin made was refused with "this host gives plugins no
// network access". Three missing capabilities, each hidden behind the one
// before it, and each reported as a fact about somebody else's repository.
//
// None of them was a product bug. All three were measurement bugs, and the
// numbers they produced looked exactly like real ones — an ecosystem that does
// not convert, then does not load, then cannot reach the network. There is no
// way to tell that apart from the real thing by reading a scoreboard, which is
// why it is checked here instead.
//
// ## The rule
//
// **Never emit a source-level diagnosis for a capability you have not verified
// you actually provide.** A harness that says "this source is broken" is making
// a claim about the world; it has to earn that by first showing that the part
// of itself the claim depends on is working. Everything in this file is one
// instance of that sentence.
//
// ## What is deliberately not done
//
// No assertion that a capability is *present* — every one of the three above
// was present, correctly typed, and wrong. `listFiles` was a function. The
// isolate factory returned a real object. What is checked here is that each one
// *answers*, by using it the way the campaign will.
//
// The reference plugin is therefore run through `verifyConvertedPlugin` with
// the same options object `checkListing` builds, rather than through a shortcut
// that would prove the shortcut works. If the wiring regresses again, the
// reference plugin fails in exactly the way the catalogue did.

import { verifyConvertedPlugin } from '@plugin-bridge/core/verify';
import { DEFAULT_REFS, parseRepositoryUrl, rawCandidates } from '@plugin-bridge/core/git-hosts';
import { verifyOptionsFor, type CheckCapabilities } from '@plugin-bridge/host/catalogue';

/** What one preflight check concluded. */
export interface PreflightCheck {
	readonly name: string;
	readonly ok: boolean;
	/** What was observed — said for a pass too, so the output is evidence. */
	readonly detail: string;
	/** A check that could not apply here, and why. Never fails the run. */
	readonly skipped?: boolean;
}

export interface PreflightResult {
	readonly ok: boolean;
	readonly checks: readonly PreflightCheck[];
}

/**
 * A plugin that does the five steps and nothing else.
 *
 * It is deliberately the smallest thing that exercises every capability the
 * campaign needs: `searchCatalog` makes one real request through `ctx.http`, so
 * a refusing `fetcher` fails here; the three methods together walk the whole
 * verifier. The url it fetches is the index the run was pointed at — already
 * fetched once, therefore known to answer, and on a host the operator chose
 * rather than one this file picked.
 *
 * `resolve` returns a url that is not fetched. The reach probe is the one step
 * a preflight must not perform: it would mean requesting a stream from
 * somebody's CDN to prove something about this process.
 */
function referencePlugin(probeUrl: string): string {
	return `export default {
	// The sandbox answers \`load\` with the module's own id and the host refuses a
	// bundle whose code disagrees with its manifest. A reference plugin has to
	// satisfy the same rule as a real one, or it is not exercising the path.
	id: 'yorozo.preflight',
	async searchCatalog(query, page, ctx) {
		await ctx.http.text(${JSON.stringify(probeUrl)});
		return { entries: [{ sourceMediaId: 'preflight:1', title: 'Preflight' }] };
	},
	async listEpisodes(sourceMediaId, ctx) {
		return [{ number: 1, sourceEpisodeId: 'preflight:1:1' }];
	},
	async resolve(sourceMediaId, episode, ctx) {
		return [{ url: 'https://cdn.example.invalid/preflight.m3u8', container: 'hls' }];
	}
};`;
}

/**
 * Every capability the campaign depends on, exercised once.
 *
 * `sourceRepository` is the repository an adapter will read extension source
 * out of, when the detected format reads one. Null where the format does not,
 * which is a skip rather than a failure — a sora repository ships its modules
 * and never lists a directory.
 */
export async function runPreflight(
	capabilities: CheckCapabilities,
	context: { readonly indexUrl: string; readonly sourceRepository: string | null }
): Promise<PreflightResult> {
	const checks: PreflightCheck[] = [];

	// 1. The file lister. This is the one that was stubbed, and the shape of the
	//    stub — a function returning an empty array — is indistinguishable from
	//    a repository with nothing in it unless something known-populated is
	//    asked about.
	if (context.sourceRepository === null) {
		checks.push({
			name: 'file listing',
			ok: true,
			skipped: true,
			detail: 'this repository names no source repository to read extensions out of'
		});
	} else {
		// Built with the engine's own `rawCandidates` rather than by writing a
		// raw-file path here: `listFiles` takes a *directory* url under a ref,
		// which is a forge-shaped address, and a second hand-written copy of
		// that layout is the kind of duplication this whole file is about.
		// Every candidate ref is tried for the same reason the adapter tries
		// them — a repository's default branch is not knowable from its url.
		let repository = null;
		try {
			repository = parseRepositoryUrl(new URL(context.sourceRepository));
		} catch {
			repository = null;
		}
		if (repository === null) {
			checks.push({
				name: 'file listing',
				ok: false,
				detail: `no repository could be read out of ${context.sourceRepository}`
			});
		} else {
			let listed = 0;
			let failure = 'the source repository listed no files at any known ref';
			for (const url of rawCandidates(repository, '', [...DEFAULT_REFS])) {
				try {
					const paths = await capabilities.listFiles(url);
					if (paths.length > 0) {
						listed = paths.length;
						break;
					}
				} catch (error) {
					failure = error instanceof Error ? error.message : String(error);
				}
			}
			checks.push({
				name: 'file listing',
				ok: listed > 0,
				detail:
					listed > 0
						? `${listed} paths under the source repository`
						: `${failure} — no real repository is empty, so the lister is not answering`
			});
		}
	}

	// 2. The isolate, the network, the ABI and the verifier, in one pass, through
	//    the path a listing takes. Deliberately not four separate assertions:
	//    what broke was never a capability in isolation, it was the wiring
	//    between them, and only running the whole thing exercises that.
	try {
		const result = await verifyConvertedPlugin(
			{
				id: 'yorozo.preflight',
				name: 'Preflight',
				hosts: [new URL(context.indexUrl).hostname]
			},
			referencePlugin(context.indexUrl),
			// The campaign's own options, assembled by the campaign's own
			// function. Passing a hand-built object here would check that this
			// file can open a sandbox, which nobody doubted; what needs
			// checking is the assembly that went wrong.
			verifyOptionsFor(capabilities, {})
		);
		checks.push({
			name: 'sandbox, network and the five steps',
			ok: result.ok,
			detail: result.ok
				? 'the reference plugin loaded, searched, listed and resolved'
				: `the reference plugin failed at ${result.failedAt ?? 'load'}: ${result.detail} ` +
					'— this is the harness, not a source'
		});
	} catch (error) {
		checks.push({
			name: 'sandbox, network and the five steps',
			ok: false,
			detail: error instanceof Error ? error.message : String(error)
		});
	}

	return { ok: checks.every((check) => check.ok), checks };
}

/** The preflight as a block of output, pass or fail. */
export function formatPreflight(result: PreflightResult): string {
	const lines = result.checks.map((check) => {
		const mark = check.skipped ? '–' : check.ok ? '✓' : '✗';
		return `  ${mark} ${check.name} — ${check.detail}`;
	});
	return lines.join('\n');
}
