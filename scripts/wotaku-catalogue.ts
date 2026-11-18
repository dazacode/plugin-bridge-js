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
import { ForeignFormatError } from '@plugin-bridge/core/adapter';
import { openPluginArchive } from '@plugin-bridge/core/archive';
import { refusalFor, type ForeignFormat } from '@plugin-bridge/core/formats';

/**
 * The working set the corpus lives in.
 *
 * By default the layout this script was written in, where the repository is
 * checked out at `<working set>/ref/plugin-bridge-js`. `WOTAKU_ROOT` names it
 * directly for a checkout that lives anywhere else.
 */
const ROOT = process.env['WOTAKU_ROOT'] ?? new URL('../../../', import.meta.url).pathname;
const CORPUS = join(ROOT, 'corpus/');
const MANIFEST = join(ROOT, 'manifest/repos.json');

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

/**
 * The source path, measured: every Mana entry file in the corpus, converted
 * and loaded.
 *
 * Parsing says nothing about this path, because six of the seven Mana
 * repositories publish no index on disk — their sources exist only as the
 * TypeScript tree the toolchain would have built from. So each entry file is
 * listed the way an unbuilt repository's own bare-array index would list it,
 * `{ id, name, path }`, and handed to the adapter with the clone standing in
 * for the network. A source is an entry file that declares `Target`, which is
 * the class the ecosystem's own build exports; a shared helper directory that
 * happens to have an `index.ts` is not one.
 *
 * *Loaded* means the bundle imported and identified as its manifest id. It
 * is not a search, and nothing here reaches a live site.
 */
async function measureManaSources(): Promise<void> {
	const adapter = FOREIGN_ADAPTERS.find((one) => one.format === 'mana');
	if (adapter === undefined) return;

	const slugs = manifest.filter((one) => one.ecosystem === 'mana').map((one) => one.slug);
	const layouts: [string, string][] = [
		['src/sources', 'index.ts'],
		['src', 'main.ts'],
		['src', 'index.ts']
	];
	let sources = 0;
	let converted = 0;
	let loaded = 0;
	const refusals = new Map<string, number>();
	const loadFailures = new Map<string, number>();

	for (const slug of slugs) {
		const root = join(CORPUS, slug);
		const found = new Set<string>();
		for (const [parent, file] of layouts) {
			for (const dir of await only(join(root, parent), null)) {
				const entry = join(dir, file);
				const name = relative(join(root, parent), dir);
				if (found.has(name) || !existsSync(entry)) continue;
				if (!/^export\s+class\s+Target\b/m.test(await readFile(entry, 'utf8'))) continue;
				found.add(name);
			}
		}

		const base = `https://example.invalid/${slug}/`;
		const local = (url: string): string => {
			if (!url.startsWith(base)) throw new Error(`outside the clone: ${url}`);
			const path = join(root, decodeURIComponent(url.slice(base.length)));
			if (!existsSync(path)) throw new Error(`not in the clone: ${url}`);
			return path;
		};

		for (const name of [...found].sort()) {
			sources += 1;
			const listing = adapter.parseIndex(
				JSON.stringify([{ id: name, name, path: name }]),
				`${base}sources.json`
			).plugins[0];
			let bytes: Uint8Array;
			try {
				bytes = await adapter.convert(listing, {
					fetchArtifact: async (url) => new Uint8Array(await readFile(local(url))),
					getText: async (url) => readFile(local(url), 'utf8'),
					listFiles: () => {
						throw new Error('nothing here lists');
					}
				});
			} catch (error) {
				const obstacles =
					error instanceof ForeignFormatError && error.obstacles.length > 0
						? error.obstacles.join('+')
						: error instanceof Error
							? error.message.slice(0, 80)
							: String(error);
				refusals.set(obstacles, (refusals.get(obstacles) ?? 0) + 1);
				continue;
			}
			converted += 1;
			try {
				const opened = await openPluginArchive(bytes);
				const url = `data:text/javascript;base64,${Buffer.from(opened.entrypointSource).toString('base64')}`;
				const module = (await import(url)) as { default?: { id?: unknown } };
				if (module.default?.id !== listing.id) throw new Error('identified as something else');
				loaded += 1;
			} catch (error) {
				const message = (error instanceof Error ? error.message : String(error)).slice(0, 100);
				loadFailures.set(message, (loadFailures.get(message) ?? 0) + 1);
			}
		}
	}

	console.log(
		`\nmana source path: sources=${sources} converted=${converted} loaded=${loaded} refused=${sources - converted}`
	);
	for (const [why, count] of [...refusals].sort((a, b) => b[1] - a[1])) {
		console.log(`  refused ${String(count).padStart(3)} ${why}`);
	}
	for (const [why, count] of [...loadFailures].sort((a, b) => b[1] - a[1])) {
		console.log(`  load    ${String(count).padStart(3)} ${why}`);
	}
}

if (!process.argv.includes('--json')) await measureManaSources();

// Marks a clone the harness could not even stat, so a missing corpus is loud.
if (!(await stat(CORPUS)).isDirectory()) {
	console.error('corpus missing');
	process.exit(1);
}
