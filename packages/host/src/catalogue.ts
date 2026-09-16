/**
 * Converting one listing and running it, without installing anything.
 *
 * This is `FOREIGN.md` §6's five steps as a function: convert, load, search,
 * list episodes, resolve a stream — and then nothing. Nothing is written, no
 * bundle is kept, and no row appears anywhere. That is what makes the answer
 * worth reporting: a check that took a shortcut would be reporting on a
 * different thing than an install performs.
 *
 * ## Why it lives in the engine rather than in a product
 *
 * It was written first inside a consuming application's plugin registry, beside
 * install, enable, bindings and settings — and only the first half of that list
 * is about compatibility. A product decides what to *keep*; the engine decides
 * what *works*. Keeping the second half here is what lets a command-line tool,
 * a test and an application all ask the same question and get the same answer,
 * which is the property the whole scoreboard rests on.
 */

import { adapterFor } from '@plugin-bridge/adapters';
import { openPluginArchive, type PluginBundle } from '@plugin-bridge/core/archive';
import type { CheckResult } from '@plugin-bridge/core/check';
import { CONVERTER_VERSION } from '@plugin-bridge/core/package';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { settingValues } from '@plugin-bridge/core/settings';
import { verifyConvertedPlugin, type ReachOutcome } from '@plugin-bridge/core/verify';
import type { PluginHost } from './host';
import type { ConversionRecord } from '@plugin-bridge/core/formats';

/** Everything a check needs from the world, and nothing it does not. */
export interface CheckCapabilities {
	readonly host: PluginHost;
	/** Bytes at a URL — an artifact, or a source file. */
	readonly download: (url: string) => Promise<Uint8Array>;
	readonly getText: (url: string) => Promise<string>;
	readonly listFiles: (url: string) => Promise<readonly string[]>;
	/**
	 * Whether anything answers at a resolved stream, without downloading it.
	 *
	 * Optional: without one the check stops after `resolve` and says so, rather
	 * than claiming more than it verified — these modules signal failure *by
	 * returning a URL*, so a module that has given up looks exactly like one
	 * that succeeded until something asks the address a question.
	 */
	readonly reach?: (
		url: string,
		headers: Record<string, string>,
		reachableHosts: readonly string[]
	) => Promise<ReachOutcome>;
	/** Overrides for a test; production passes none. */
	readonly verifyOptions?: Record<string, unknown>;
	readonly now?: () => Date;
}

/**
 * Converts a listing to a bundle, through the adapter its format names.
 *
 * The archive goes back through the ordinary reader: the converter is a
 * producer of archives, and an archive is not trusted for having been made
 * here — traversal, per-file hashes and the canonical digest all still run.
 */
async function convertToBundle(
	listing: RepositoryPlugin,
	capabilities: CheckCapabilities
): Promise<PluginBundle> {
	const origin = listing.origin;
	if (origin === undefined) {
		throw new Error('This listing is not a converted one, so there is nothing to translate.');
	}
	const adapter = adapterFor(origin.format);
	const bytes = await adapter.convert(listing, {
		fetchArtifact: (url: string) => capabilities.download(url),
		getText: (url: string) => capabilities.getText(url),
		listFiles: capabilities.listFiles,
		createTranslateWorker: capabilities.host.translator,
		loadWasm: capabilities.host.wasm
	});
	return await openPluginArchive(bytes);
}

/**
 * Everything the verifier needs from a host, assembled in one place.
 *
 * Exported, and used by the preflight as well as by `checkListing`, because the
 * three capabilities below all went missing here once and the scoreboard
 * reported it as an ecosystem that does not work. A preflight that assembled
 * its *own* options would prove that the preflight works; running through this
 * function is what makes it prove that the campaign does.
 *
 * - `createWorker` defaults to `NO_WORKER`, so without it every converted
 *   listing fails at `load` saying this host cannot run plugins — on a host
 *   that demonstrably can, since the conversion is already using two other
 *   capabilities off the same object. All five steps happen after a sandbox
 *   opens, so the `works` column was structurally zero rather than measured.
 * - `fetcher` defaults to refusing rather than to an ambient `fetch`
 *   (`HOST.md` §2), which is right, and means a caller that forgets it gets the
 *   plugin refused at its first request.
 * - `log` goes through so a plugin that explains itself on the way down is not
 *   silent in the one tool whose output is a diagnosis.
 */
export function verifyOptionsFor(
	capabilities: CheckCapabilities,
	settings: Record<string, unknown>
): Record<string, unknown> {
	return {
		settings,
		reach: capabilities.reach,
		createWorker: capabilities.host.sandbox,
		fetcher: capabilities.host.fetch,
		log: capabilities.host.log,
		// Test overrides last, so a spec can replace any of the above.
		...capabilities.verifyOptions
	};
}

/**
 * One listing, converted and run, as a verdict.
 *
 * A conversion that never produced a bundle reports `failedAt: null` rather
 * than a step, because all five steps happen *after* a bundle exists. That is
 * what tells the listings that could not be built apart from the ones that were
 * built and did not work — the distinction the whole scoreboard turns on.
 */
export async function checkListing(
	listing: RepositoryPlugin,
	capabilities: CheckCapabilities
): Promise<CheckResult> {
	const now = capabilities.now ?? (() => new Date());
	const version = listing.origin?.foreignVersion ?? listing.version;
	const base = {
		listingId: listing.id,
		version,
		checkedAt: now().toISOString()
	};

	if (listing.origin === undefined) {
		// A native listing is a signed archive from a repository that published a
		// digest. Downloading one to run it would spend somebody's bandwidth to
		// learn less than the signature already says.
		return { ...base, status: 'notTestable', detail: null, failedAt: null };
	}

	let bundle: PluginBundle;
	try {
		bundle = await convertToBundle(listing, capabilities);
	} catch (error) {
		const named = error as { obstacles?: unknown; sites?: unknown };
		return {
			...base,
			status: 'broken',
			detail: error instanceof Error ? error.message : String(error),
			failedAt: null,
			obstacles: named.obstacles as CheckResult['obstacles'],
			sites: named.sites as CheckResult['sites']
		};
	}

	// The same conversion record an install would attach, because the sandbox
	// reads it: runtime host learning is for converted plugins only, and a check
	// that omitted the record would quietly run under a stricter rule than an
	// install does.
	const converted: ConversionRecord = {
		format: listing.origin.format,
		foreignId: listing.origin.foreignId,
		foreignVersion: listing.origin.foreignVersion,
		convertedAt: now().toISOString(),
		converterVersion: CONVERTER_VERSION,
		verified: false,
		mediaKind: listing.origin.mediaKind,
		mediaKinds: listing.origin.mediaKinds,
		idKinds: listing.origin.idKinds,
		declaredP2p: listing.origin.declaredP2p
	};

	const result = await verifyConvertedPlugin(
		{ id: bundle.id, name: listing.name, hosts: bundle.hosts, converted },
		bundle.entrypointSource,
		verifyOptionsFor(capabilities, settingValues(bundle.settings))
	);

	return {
		...base,
		status: result.ok ? 'works' : 'broken',
		detail: result.detail,
		failedAt: result.failedAt,
		searchHits: result.searchHits,
		episodeCount: result.episodeCount,
		streamCount: result.streamCount
	};
}
