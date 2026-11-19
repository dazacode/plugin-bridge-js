/**
 * Drives converted listings through the whole chain a viewer takes, live.
 *
 *   bun scripts/drive-chain.ts <index-url> --only <name,…> [--json <path>]
 *
 * The catalogue's check searches for "a" and stops at the first answer, which
 * says whether code runs; it does not say whether a viewer gets a show and a
 * playing episode. This walks what a viewer does instead: the popular shelf,
 * a search for a word taken from what the shelf showed, the episode list of a
 * real title, the streams of its first episode, and then a fetch of each
 * stream until one answers with media (`host/stream-probe.ts`). Every stage
 * is reported, so a listing that plays and one that only resolves read
 * differently.
 *
 * Like the catalogue command it ships no index and names no source (rule 9):
 * the index is an argument, and nothing it learns is written anywhere but the
 * report it was asked for.
 */

import { writeFileSync } from 'node:fs';

import { adapterFor, FOREIGN_ADAPTERS } from '@plugin-bridge/adapters';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { detectRepository } from '@plugin-bridge/core/detect';
import { createTreeLister } from '@plugin-bridge/core/git-trees';
import { CONVERTER_VERSION } from '@plugin-bridge/core/package';
import { settingValues } from '@plugin-bridge/core/settings';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { headlessPluginHost } from '@plugin-bridge/host-node/headless-plugin-host';
import { PluginSandbox } from '@plugin-bridge/host/sandbox-host';
import { streamMediaProbe } from '@plugin-bridge/host/stream-probe';
import { FrameReader } from '@plugin-bridge/host/net/frames';
import { FRAME_CONTENT_TYPE } from '@plugin-bridge/host/net/relay';

interface Stage {
	ok: boolean;
	detail: string;
}

interface Drive {
	name: string;
	convert?: Stage;
	popular?: Stage;
	search?: Stage;
	episodes?: Stage;
	videos?: Stage;
	playable?: Stage;
}

const argv = process.argv.slice(2);
const indexUrl = argv.find((one) => one.startsWith('https://'));
const flag = (name: string): string | undefined => {
	const at = argv.indexOf(name);
	return at < 0 ? undefined : argv[at + 1];
};
const only = (flag('--only') ?? '')
	.split(',')
	.map((one) => one.trim().toLowerCase())
	.filter((one) => one.length > 0);
const jsonPath = flag('--json');
const width = Number(flag('--at-a-time') ?? '4') || 4;
if (indexUrl === undefined) {
	process.stderr.write('Usage: bun scripts/drive-chain.ts <index-url> [--only a,b] [--json out]\n');
	process.exit(2);
}

const host = headlessPluginHost({ dataDir: flag('--data-dir') });
/**
 * `GITHUB_TOKEN`, when set, on the code host's API and nowhere else: listing a
 * source repository's files is the one request per conversion that host
 * rations, at sixty an hour unauthenticated, and a run over a whole index
 * spends that in minutes.
 */
const apiToken = process.env['GITHUB_TOKEN'];
const text = async (url: string) => {
	const response = await host.fetch(
		url,
		apiToken !== undefined && url.startsWith('https://api.github.com/')
			? { headers: { authorization: `Bearer ${apiToken}` } }
			: undefined
	);
	if (!response.ok) throw new Error(`${response.status} from ${url}`);
	return await response.text();
};
const bytes = async (url: string) => {
	const response = await host.fetch(url);
	if (!response.ok) throw new Error(`${response.status} from ${url}`);
	return new Uint8Array(await response.arrayBuffer());
};
const listFiles = createTreeLister(text);
const tracing = argv.includes('--trace');

/**
 * The host's fetch, reporting each request a plugin makes and what came back,
 * when asked: a shelf that comes back empty is a parse that found nothing or
 * a page that was not the page, and only the status tells the two apart.
 */
const traced = (name: string): typeof host.fetch =>
	tracing
		? async (url, init) => {
				const response = await host.fetch(url, init);
				if (url === '/api/plugin-fetch' && typeof init?.body === 'string') {
					const asked = JSON.parse(init.body) as { url?: string; method?: string };
					const copy = response.clone();
					let said = `${response.status}`;
					try {
						const framed = copy.headers.get('content-type') === FRAME_CONTENT_TYPE;
						const answer = (
							framed
								? new FrameReader().push(new Uint8Array(await copy.arrayBuffer()))[0]
								: await copy.json()
						) as { status?: number; challenge?: string; body?: unknown; error?: string };
						const size =
							answer.body instanceof Uint8Array
								? answer.body.length
								: typeof answer.body === 'string'
									? answer.body.length
									: 0;
						said = `${answer.status ?? response.status}${answer.challenge ? ` ${answer.challenge}` : ''}${answer.error ? ` ${answer.error}` : ''} ${size}b`;
					} catch {
						// the status is enough
					}
					process.stderr.write(`  [${name}] ${asked.method ?? 'GET'} ${asked.url} -> ${said}\n`);
				}
				return response;
			}
		: host.fetch;
const probe = streamMediaProbe(host.fetch);

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** What the sandbox saw go wrong on the way, for a stage that came back empty. */
const along = (sandbox: PluginSandbox): string => {
	const seen = [
		...sandbox.outboundFailures,
		...sandbox.refusedHosts.map((one) => `refused ${one}`)
	];
	return seen.length === 0 ? '' : ` [${seen.slice(0, 4).join('; ')}]`;
};
const short = (value: string, at = 160) =>
	value.length > at ? `${value.slice(0, at - 1)}…` : value;

/** A search word a viewer might type, taken from a title the shelf showed. */
function queryFrom(title: string): string {
	const words = title
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length >= 4)
		.sort((a, b) => b.length - a.length);
	return words[0] ?? title.trim().slice(0, 12);
}

interface Entry {
	sourceMediaId?: unknown;
	title?: unknown;
}

async function drive(listing: RepositoryPlugin): Promise<Drive> {
	const report: Drive = { name: listing.name };
	const origin = listing.origin!;
	let sandbox: PluginSandbox | null = null;
	try {
		const bundleBytes = await adapterFor(origin.format).convert(listing, {
			fetchArtifact: bytes,
			getText: text,
			listFiles,
			createTranslateWorker: host.translator,
			loadWasm: host.wasm
		});
		const bundle = await openPluginArchive(bundleBytes);
		report.convert = { ok: true, detail: `${bundle.hosts.length} hosts` };
		sandbox = await PluginSandbox.start(
			{
				id: bundle.id,
				name: listing.name,
				hosts: bundle.hosts,
				permissions: bundle.permissions,
				converted: {
					format: origin.format,
					foreignId: origin.foreignId,
					foreignVersion: origin.foreignVersion,
					convertedAt: new Date().toISOString(),
					converterVersion: CONVERTER_VERSION,
					verified: false,
					mediaKind: origin.mediaKind,
					mediaKinds: origin.mediaKinds,
					idKinds: origin.idKinds,
					declaredP2p: origin.declaredP2p
				}
			},
			bundle.entrypointSource,
			settingValues(bundle.settings),
			{
				createWorker: host.sandbox,
				fetcher: traced(listing.name),
				log: () => {},
				onLog: tracing
					? (level, line) =>
							process.stderr.write(`  [${listing.name}] ${level}: ${short(line, 400)}\n`)
					: undefined
			}
		);
	} catch (error) {
		report.convert = { ok: false, detail: short(message(error), 300) };
		sandbox?.dispose();
		return report;
	}

	try {
		let shelf: Entry[] = [];
		try {
			const page = (await sandbox.searchCatalog('', 1)) as { entries?: Entry[] } | null;
			shelf = page?.entries ?? [];
			report.popular = {
				ok: shelf.length > 0,
				detail: `${shelf.length} entries${shelf[0] ? `, first "${short(String(shelf[0].title), 40)}"` : along(sandbox)}`
			};
		} catch (error) {
			report.popular = { ok: false, detail: short(message(error)) + along(sandbox) };
		}

		let found: Entry[] = [];
		const query = shelf[0] ? queryFrom(String(shelf[0].title ?? '')) : 'love';
		try {
			const page = (await sandbox.searchCatalog(query, 1)) as { entries?: Entry[] } | null;
			found = page?.entries ?? [];
			report.search = {
				ok: found.length > 0,
				detail: `"${query}": ${found.length} entries${found.length === 0 ? along(sandbox) : ''}`
			};
		} catch (error) {
			report.search = {
				ok: false,
				detail: `"${query}": ${short(message(error))}${along(sandbox)}`
			};
		}

		const candidates = [...found, ...shelf]
			.map((entry) => entry.sourceMediaId)
			.filter((id): id is string => typeof id === 'string')
			.slice(0, 3);
		if (candidates.length === 0) return report;

		for (const candidate of candidates) {
			let episodes: { number?: unknown; sourceEpisodeId?: unknown }[] = [];
			try {
				episodes = ((await sandbox.listEpisodes(candidate)) ?? []) as typeof episodes;
				report.episodes = {
					ok: episodes.length > 0,
					detail: `${episodes.length} episodes${episodes.length === 0 ? along(sandbox) : ''}`
				};
			} catch (error) {
				report.episodes = { ok: false, detail: short(message(error)) + along(sandbox) };
				continue;
			}
			const episode = episodes.find((row) => typeof row.sourceEpisodeId === 'string');
			if (episode === undefined) continue;

			let streams: { url?: unknown; headers?: Record<string, string>; container?: unknown }[] = [];
			try {
				streams = ((await sandbox.resolve(candidate, {
					number: Number(episode.number) || 1,
					sourceEpisodeId: String(episode.sourceEpisodeId)
				})) ?? []) as typeof streams;
				report.videos = {
					ok: streams.length > 0,
					detail: `${streams.length} streams${streams.length === 0 ? along(sandbox) : ''}`
				};
			} catch (error) {
				report.videos = { ok: false, detail: short(message(error)) + along(sandbox) };
				continue;
			}
			if (streams.length === 0) continue;

			const refusals: string[] = [];
			for (const stream of streams.slice(0, 8)) {
				const url = String(stream.url);
				let hostName = '?';
				try {
					hostName = new URL(url).hostname;
				} catch {
					// reported below as not a url
				}
				const outcome = await probe(url, stream.headers ?? {}, [
					...sandbox.reachableHosts,
					hostName
				]);
				if (outcome.ok) {
					report.playable = {
						ok: true,
						detail: `${String(stream.container)} from the ${refusals.length + 1}th stream`
					};
					return report;
				}
				refusals.push(outcome.detail);
			}
			report.playable = { ok: false, detail: short([...new Set(refusals)].join('; '), 300) };
		}
		return report;
	} finally {
		sandbox.dispose();
	}
}

const detected = await detectRepository(indexUrl, text, FOREIGN_ADAPTERS, bytes);
const listings = detected.index.plugins.filter(
	(listing) =>
		listing.origin !== undefined &&
		(only.length === 0 || only.some((part) => listing.name.toLowerCase().includes(part)))
);
process.stderr.write(`${listings.length} listings, ${width} at a time\n`);

const results: Drive[] = [];
let next = 0;
const lane = async () => {
	for (;;) {
		const at = next;
		next += 1;
		if (at >= listings.length) return;
		const result = await drive(listings[at]).catch((error): Drive => ({
			name: listings[at].name,
			convert: { ok: false, detail: message(error) }
		}));
		results.push(result);
		const stages = (['convert', 'popular', 'search', 'episodes', 'videos', 'playable'] as const)
			.filter((stage) => result[stage] !== undefined)
			.map((stage) => `${result[stage]!.ok ? '+' : '-'}${stage}: ${result[stage]!.detail}`);
		process.stdout.write(`${result.name}\n    ${stages.join('\n    ')}\n`);
	}
};
await Promise.all(Array.from({ length: Math.min(width, listings.length) }, lane));

const playable = results.filter((one) => one.playable?.ok).map((one) => one.name);
process.stdout.write(
	`\nverified playable: ${playable.length} of ${results.length}\n  ${playable.join(', ')}\n`
);
if (jsonPath !== undefined) writeFileSync(jsonPath, `${JSON.stringify(results, null, '\t')}\n`);
process.exit(0);
