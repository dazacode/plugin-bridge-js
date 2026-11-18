/**
 * Measures every new adapter against the real corpus it was written for.
 *
 * Fixtures prove an adapter reads the shape somebody wrote down. They do not
 * prove it reads the shape eighty repositories actually publish, and the
 * difference is where every earlier adapter's real bugs lived. So this walks
 * the cloned corpus, finds each repository's index document by the convention
 * its ecosystem uses, and reports what the parser made of it: how many listings
 * survived, how many the medium filter dropped, and what refused a repository
 * outright.
 *
 * Run: `bun scripts/wotaku-catalogue.ts [--json]`
 *
 * ## What it deliberately does not do
 *
 * It does not fetch. A repository here publishes its *source*; the index lives
 * on a build branch this clone does not have, so a repository with no index on
 * disk is reported as `no-index` rather than as a failure. That number is a
 * fact about what wotaku links to, not about the adapter, and conflating the
 * two would make the adapter look worst where the link is thinnest.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

import { FOREIGN_ADAPTERS } from '@plugin-bridge/adapters';
import { refusalFor, type ForeignFormat } from '@plugin-bridge/core/formats';

const CORPUS = new URL('../../../corpus/', import.meta.url).pathname;
const MANIFEST = new URL('../../../manifest/repos.json', import.meta.url).pathname;

/**
 * Where each ecosystem keeps its index, in preference order.
 *
 * A function per format rather than a static path, because two of them put the
 * document somewhere the repository name decides.
 */
const INDEX_PATHS: Partial<Record<ForeignFormat, (root: string) => Promise<string[]>>> = {
	kotatsu: async (root) => only(join(root, 'index'), '.json'),
	aidoku: async (root) => [
		...(await maybe(join(root, 'index.min.json'))),
		...(await maybe(join(root, 'public/index.json')))
	],
	shosetsu: async (root) => maybe(join(root, 'index.json')),
	paperback: async (root) => [
		...(await maybe(join(root, '0.9/stable/versioning.json'))),
		...(await maybe(join(root, '0.9/stable/index.json')))
	],
	mana: async (root) => [
		...(await maybe(join(root, 'sources.json'))),
		...(await maybe(join(root, 'dist/sources.json'))),
		...(
			await Promise.all(
				(await only(join(root, 'odt'), null)).map((dir) => maybe(join(dir, 'sources.json')))
			)
		).flat()
	],
	seanime: async (root) => [
		...(await maybe(join(root, 'marketplace/main.json'))),
		...(await maybe(join(root, 'marketplace.json')))
	],
	ireader: async (root) => [
		...(await maybe(join(root, 'index.json'))),
		...(await maybe(join(root, 'js-index.json')))
	],
	echo: async () => [],
	tsundoku: async (root) => [
		...(await maybe(join(root, 'index.min.json'))),
		...(await maybe(join(root, 'index.json')))
	]
};

async function maybe(path: string): Promise<string[]> {
	return existsSync(path) ? [path] : [];
}

async function only(dir: string, suffix: string | null): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries
			.filter((one) => (suffix === null ? one.isDirectory() : one.name.endsWith(suffix)))
			.map((one) => join(dir, one.name));
	} catch {
		return [];
	}
}

interface Row {
	readonly ecosystem: ForeignFormat;
	readonly slug: string;
	readonly outcome: 'no-index' | 'parsed' | 'refused' | 'threw';
	readonly listings: number;
	readonly dropped: number;
	readonly refusedByMedium: number;
	readonly reason: string;
}

const rows: Row[] = [];
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
	ecosystem: string;
	slug: string;
}[];

for (const entry of manifest) {
	const adapter = FOREIGN_ADAPTERS.find((one) => one.format === entry.ecosystem);
	if (adapter === undefined) continue;

	const root = join(CORPUS, entry.slug);
	const finder = INDEX_PATHS[adapter.format];
	const candidates = finder === undefined ? [] : await finder(root);

	if (candidates.length === 0) {
		rows.push({
			ecosystem: adapter.format,
			slug: entry.slug,
			outcome: 'no-index',
			listings: 0,
			dropped: 0,
			refusedByMedium: 0,
			reason: 'no index document in the clone'
		});
		continue;
	}

	for (const path of candidates) {
		const body = await readFile(path, 'utf8');
		const url = `https://example.invalid/${entry.slug}/${relative(root, path)}`;
		try {
			const index = adapter.parseIndex(body, url);
			const refusedByMedium = index.plugins.filter(
				(one) =>
					one.origin !== undefined &&
					refusalFor(one.origin.format, one.origin.mediaKind, one.origin.detail) !== null
			).length;
			rows.push({
				ecosystem: adapter.format,
				slug: entry.slug,
				outcome: 'parsed',
				listings: index.plugins.length,
				dropped: index.filteredOut,
				refusedByMedium,
				reason: ''
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			rows.push({
				ecosystem: adapter.format,
				slug: entry.slug,
				outcome: 'refused',
				listings: 0,
				dropped: 0,
				refusedByMedium: 0,
				reason: message.slice(0, 120)
			});
		}
	}
}

if (process.argv.includes('--json')) {
	console.log(JSON.stringify(rows, null, 2));
} else {
	const byEcosystem = new Map<string, Row[]>();
	for (const row of rows) {
		const list = byEcosystem.get(row.ecosystem) ?? [];
		list.push(row);
		byEcosystem.set(row.ecosystem, list);
	}
	for (const [ecosystem, list] of [...byEcosystem].sort()) {
		// Per repository, not per document: several repositories publish more
		// than one index file and counting documents would inflate a repository
		// that happens to be split in two.
		const repos = new Set(list.map((one) => one.slug));
		const listings = list.reduce((sum, one) => sum + one.listings, 0);
		const parsedRepos = new Set(
			list.filter((one) => one.outcome === 'parsed').map((one) => one.slug)
		);
		const noIndex = new Set(
			list.filter((one) => one.outcome === 'no-index').map((one) => one.slug)
		);
		const refused = list.filter((one) => one.outcome === 'refused');
		console.log(
			`${ecosystem.padEnd(11)} repos=${String(repos.size).padStart(2)} parsed=${String(parsedRepos.size).padStart(2)} listings=${String(listings).padStart(5)} no-index=${String(noIndex.size).padStart(2)} refused=${refused.length}`
		);
		for (const one of refused) console.log(`  ! ${one.slug}: ${one.reason}`);
	}
}

// Marks a clone the harness could not even stat, so a missing corpus is loud.
if (!(await stat(CORPUS)).isDirectory()) {
	console.error('corpus missing');
	process.exit(1);
}
