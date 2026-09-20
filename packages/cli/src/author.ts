/**
 * `init`, `test` and `pack` — the three commands for writing a plugin.
 *
 * Everything here drives the same code the compatibility side drives: the same
 * packager, the same manifest schema, the same five-step conformance run. A
 * plugin you wrote by hand and a plugin translated from another ecosystem are
 * the same kind of artifact by the time they reach a host, and if these
 * commands had their own packager or their own idea of "valid" then that
 * sentence would stop being true the first time one of them drifted.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve as resolvePath } from 'node:path';

import { packageBundle } from '@plugin-bridge/core/package';
import { parseSettingDescriptors } from '@plugin-bridge/core/settings';
import { verifyConvertedPlugin } from '@plugin-bridge/core/verify';
import { headlessPluginHost } from '@plugin-bridge/host-node/headless-plugin-host';

/**
 * The one part of the bundler this file uses, declared rather than depended on.
 *
 * `@types/bun` would pull a whole runtime's surface in to type four fields, and
 * this is a CLI that already only runs under that runtime.
 */
declare const Bun: {
	build(options: {
		entrypoints: string[];
		target: string;
		format: string;
		minify: boolean;
	}): Promise<{
		success: boolean;
		logs: readonly unknown[];
		outputs: readonly { text(): Promise<string> }[];
	}>;
};

const USAGE = `plugin-bridge — writing a Yorozo plugin

  init <dir>        scaffold a plugin you can run in about a minute
  test <dir>        build it, run it, and show what it actually answered
  pack <dir>        write <id>-<version>.yorozoplugin

  test options
    --query <text>  what to search for (default: the manifest's testQuery)
    --episode <n>   which episode to resolve (default: the first listed)
`;

interface PluginManifest {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly version: string;
	readonly author?: { readonly name?: string; readonly url?: string } | string;
	readonly network?: { readonly hosts?: readonly string[] };
	readonly settings?: readonly unknown[];
	/** What `test` searches for when nothing is passed. Not part of the bundle. */
	readonly testQuery?: string;
}

async function readManifest(dir: string): Promise<PluginManifest> {
	const path = join(dir, 'plugin.json');
	try {
		return JSON.parse(await readFile(path, 'utf8')) as PluginManifest;
	} catch (error) {
		const why = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read ${path}: ${why}`);
	}
}

/**
 * The plugin as one ES module.
 *
 * Bundled rather than read, so that an author can split their plugin across
 * files and import a helper — which everyone does by the second evening — and
 * still ship the single self-contained module the ABI asks for.
 */
async function buildSource(dir: string): Promise<string> {
	const entry = join(dir, 'src', 'index.ts');
	const fallback = join(dir, 'src', 'index.js');
	const chosen = (await stat(entry).catch(() => null)) === null ? fallback : entry;

	const built = await Bun.build({
		entrypoints: [chosen],
		target: 'browser',
		format: 'esm',
		minify: false
	});
	if (!built.success) {
		/*
		 * Every log, not `String(built)`. The bundler's own summary is the
		 * word "Bundle failed", which names neither the file nor the import
		 * that could not be found — measured by scaffolding a plugin in an
		 * empty directory and running this, which is how an author meets it.
		 */
		const why = built.logs
			.map((one: unknown) => {
				const line = one as { message?: unknown; position?: { file?: unknown; line?: unknown } };
				const where =
					line.position?.file === undefined
						? ''
						: ` (${String(line.position.file)}:${String(line.position.line ?? '?')})`;
				return `  ${String(line.message ?? one)}${where}`;
			})
			.join('\n');
		throw new Error(
			`${basename(chosen)} did not build.\n${why.length > 0 ? why : '  (the bundler gave no reason)'}`
		);
	}
	return await built.outputs[0].text();
}

function authorOf(manifest: PluginManifest): { name: string; url?: string } {
	if (typeof manifest.author === 'string') return { name: manifest.author };
	return { name: manifest.author?.name ?? 'unknown', url: manifest.author?.url };
}

async function bundleOf(dir: string): Promise<{ manifest: PluginManifest; bytes: Uint8Array }> {
	const manifest = await readManifest(dir);
	const source = await buildSource(dir);
	const author = authorOf(manifest);
	const bytes = await packageBundle({
		id: manifest.id,
		name: manifest.name,
		description: manifest.description ?? '',
		version: manifest.version,
		author: author.name,
		...(author.url === undefined ? {} : { authorUrl: author.url }),
		hosts: manifest.network?.hosts ?? [],
		entrypointSource: source,
		settings: parseSettingDescriptors(manifest.settings ?? [])
	});
	return { manifest, bytes };
}

const STARTER_MANIFEST = (id: string, name: string) =>
	`${JSON.stringify(
		{
			$schema:
				'https://raw.githubusercontent.com/dazacode/plugin-bridge-js/master/contract/yorozo-plugin.schema.json',
			id,
			name,
			description: 'A Yorozo source plugin.',
			version: '0.1.0',
			author: { name: 'you' },
			network: {
				hosts: ['example.test']
			},
			settings: [],
			testQuery: 'cowboy bebop'
		},
		null,
		'\t'
	)}\n`;

const STARTER_SOURCE = `import { defineSource } from './yorozo';

/*
 * Three questions, and nothing else:
 *
 *   searchCatalog  what matches this text?
 *   listEpisodes   what episodes does that show have?
 *   resolve        where does this episode play, right now?
 *
 * Every address you reach has to be in plugin.json's network.hosts. A viewer
 * is shown that list before installing, and a request anywhere else is refused
 * at call time rather than quietly allowed.
 *
 * Run \`plugin-bridge test .\` after each change. It shows you what your plugin
 * actually answered, which is usually not what you thought.
 */
export default defineSource({
	id: '__PLUGIN_ID__',

	async searchCatalog(query, page, ctx) {
		if (page > 1) return { entries: [] };

		const found = await ctx.http.json<{ results: { slug: string; title: string }[] }>(
			\`https://example.test/api/search?q=\${encodeURIComponent(query)}\`
		);

		return {
			entries: found.results.map((one) => ({
				sourceMediaId: one.slug,
				title: one.title
			}))
		};
	},

	async listEpisodes(sourceMediaId, ctx) {
		const found = await ctx.http.json<{ episodes: { id: string; number: number }[] }>(
			\`https://example.test/api/show/\${sourceMediaId}\`
		);

		return found.episodes.map((one) => ({
			number: one.number,
			sourceEpisodeId: one.id
		}));
	},

	async resolve(sourceMediaId, episode, ctx) {
		// You published an episode list above, so sourceEpisodeId is the thing
		// to key on. A source that publishes no list gets episode.season and
		// episode.number instead — see ResolveTarget.
		const found = await ctx.http.json<{ file: string; quality?: string }>(
			\`https://example.test/api/watch/\${episode.sourceEpisodeId}\`
		);

		return [
			{
				url: found.file,
				container: 'hls',
				label: found.quality ?? 'default'
			}
		];
	}
});
`;

const STARTER_README = (id: string) => `# ${id}

A Yorozo source plugin.

\`\`\`sh
plugin-bridge test .     # build it, run it, show what it answered
plugin-bridge pack .     # write the .yorozoplugin
\`\`\`

Edit \`src/index.ts\`. Declare every address you reach in \`plugin.json\` under
\`network.hosts\` — a request to anything else is refused.
`;

const STARTER_TSCONFIG = `${JSON.stringify(
	{
		compilerOptions: {
			target: 'ES2020',
			module: 'ESNext',
			moduleResolution: 'bundler',
			strict: true,
			noEmit: true,
			skipLibCheck: true
		},
		include: ['src']
	},
	null,
	'\t'
)}\n`;

async function runInit(args: string[]): Promise<number> {
	const dir = resolvePath(args[0] ?? '.');
	const name = basename(dir);
	const id = `com.example.plugins.${name.replace(/[^a-z0-9]+/gi, '').toLowerCase() || 'example'}`;

	if ((await stat(join(dir, 'plugin.json')).catch(() => null)) !== null) {
		process.stderr.write(`${join(dir, 'plugin.json')} already exists — not overwriting it.\n`);
		return 1;
	}

	await mkdir(join(dir, 'src'), { recursive: true });

	/*
	 * The SDK is copied in rather than depended on.
	 *
	 * It is one file with no imports, so a scaffold that carries it builds in
	 * an empty directory with nothing installed — which is the state an author
	 * is actually in when they run this. Depending on a package instead means
	 * the very first `test` fails on a missing module, and the first thing the
	 * tool teaches you is that it does not work.
	 */
	const sdk = await readFile(new URL('../../plugin-sdk/src/index.ts', import.meta.url), 'utf8');
	await writeFile(join(dir, 'src', 'yorozo.ts'), sdk);

	await writeFile(join(dir, 'plugin.json'), STARTER_MANIFEST(id, name));
	await writeFile(join(dir, 'src', 'index.ts'), STARTER_SOURCE.replace('__PLUGIN_ID__', id));
	await writeFile(join(dir, 'README.md'), STARTER_README(id));
	await writeFile(join(dir, 'tsconfig.json'), STARTER_TSCONFIG);

	process.stdout.write(
		`Wrote a plugin to ${dir}\n\n` +
			`  plugin.json      id, version, and the hosts you are allowed to reach\n` +
			`  src/index.ts     the three methods\n` +
			`  src/yorozo.ts    the types, copied in so this builds with nothing installed\n\n` +
			`Next:\n` +
			`  1. point it at a real source in src/index.ts\n` +
			`  2. put that source's hostname in plugin.json's network.hosts\n` +
			`  3. plugin-bridge test ${args[0] ?? '.'}\n`
	);
	return 0;
}

async function runTest(args: string[]): Promise<number> {
	let dir = '.';
	let query: string | null = null;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--query') query = args[++i] ?? null;
		else if (args[i] === '--episode') i++;
		else if (!args[i].startsWith('--')) dir = args[i];
	}

	const { manifest, bytes } = await bundleOf(resolvePath(dir));
	const source = await buildSource(resolvePath(dir));
	const hosts = manifest.network?.hosts ?? [];

	process.stdout.write(`${manifest.name} ${manifest.version}\n`);
	process.stdout.write(`  packaged      ${bytes.length} bytes\n`);
	process.stdout.write(
		`  declared      ${hosts.length} host(s): ${hosts.join(', ') || '(none)'}\n`
	);

	const host = headlessPluginHost();
	const probe = query ?? manifest.testQuery ?? 'test';
	const result = await verifyConvertedPlugin(
		{ id: manifest.id, name: manifest.name, hosts },
		source,
		{
			probe,
			createWorker: host.sandbox,
			fetcher: host.fetch,
			log: host.log
		}
	);

	process.stdout.write(`  searched      "${probe}" → ${result.searchHits} result(s)\n`);
	process.stdout.write(`  episodes      ${result.episodeCount}\n`);
	process.stdout.write(`  resolved      ${result.streamCount} stream(s)`);
	process.stdout.write(result.torrentCount > 0 ? `, ${result.torrentCount} torrent(s)\n` : `\n`);

	if (result.ok) {
		process.stdout.write(
			`\nAll five steps passed. \`plugin-bridge pack ${dir}\` when you are ready.\n`
		);
		return 0;
	}
	process.stdout.write(
		`\nStopped at ${result.failedAt ?? 'load'}: ${result.detail ?? 'no detail'}\n`
	);
	return 1;
}

async function runPack(args: string[]): Promise<number> {
	const dir = resolvePath(args[0] ?? '.');
	const { manifest, bytes } = await bundleOf(dir);
	const out = join(dir, `${manifest.id}-${manifest.version}.yorozoplugin`);
	await writeFile(out, bytes);
	process.stdout.write(`Wrote ${out} (${bytes.length} bytes)\n`);
	process.stdout.write(`Check it with: plugin-bridge validate ${out}\n`);
	return 0;
}

export async function runAuthor(command: string, args: string[]): Promise<number> {
	if (args[0] === '--help' || args[0] === '-h') {
		process.stdout.write(USAGE);
		return 0;
	}
	try {
		if (command === 'init') return await runInit(args);
		if (command === 'test') return await runTest(args);
		if (command === 'pack') return await runPack(args);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	process.stderr.write(USAGE);
	return 1;
}
