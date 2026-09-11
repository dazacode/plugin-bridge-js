/**
 * The four commands that take one extension rather than a whole repository.
 *
 * They exist because the catalogue is the wrong instrument for a single source:
 * it makes real requests to two hundred hosts to answer a question about one.
 * These read a directory, translate it, and say what happened — with no network
 * at all for `convert` and `inspect`.
 *
 * A directory rather than a URL is deliberate for the same reason: the thing a
 * person has in front of them when they are fixing a translation is a checkout.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { loadKotlinGrammar } from '@plugin-bridge/core/kotlin/grammar';
import { convertKotlin } from '@plugin-bridge/core/kotlin/pipeline';

/** The vendored parser, read the way every host reads it. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const at = new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url);
	return new Uint8Array(await readFile(fileURLToPath(at)));
}

/** Every `.kt` under a directory, with the path each was read from. */
async function kotlinSources(dir: string): Promise<{ path: string; source: string }[]> {
	const out: { path: string; source: string }[] = [];
	const walk = async (at: string): Promise<void> => {
		for (const entry of await readdir(at, { withFileTypes: true })) {
			const full = join(at, entry.name);
			// Test sources are not library code. Reading them produced modules
			// with three copies of the same declaration and a SyntaxError at load.
			if (entry.isDirectory()) {
				if (['test', 'androidTest', 'testFixtures', 'build'].includes(entry.name)) continue;
				await walk(full);
				continue;
			}
			if (entry.name.endsWith('.kt')) {
				out.push({
					path: relative(dir, full),
					source: await readFile(full, 'utf8')
				});
			}
		}
	};
	await walk(dir);
	return out;
}

function reportRefusals(conversion: {
	complete: boolean;
	className: string | null;
	blocking: readonly {
		member: string;
		obstacles: readonly { kind: string; line: number }[];
	}[];
	refusals: readonly {
		member: string;
		obstacles: readonly { kind: string; line: number }[];
	}[];
}): void {
	process.stdout.write(`class: ${conversion.className ?? '(none found)'}\n`);
	process.stdout.write(`converts: ${conversion.complete ? 'yes' : 'no'}\n`);
	const rows = conversion.blocking.length > 0 ? conversion.blocking : conversion.refusals;
	if (rows.length === 0) return;
	process.stdout.write(
		conversion.blocking.length > 0 ? '\nblocking refusals:\n' : '\nrefusals (none blocking):\n'
	);
	for (const refusal of rows) {
		for (const obstacle of refusal.obstacles) {
			process.stdout.write(`  ${refusal.member}:${obstacle.line}  ${obstacle.kind}\n`);
		}
	}
}

export async function runSource(
	command: 'convert' | 'check' | 'inspect' | 'validate',
	args: string[],
	format: string | null
): Promise<number> {
	const target = args.find((one) => !one.startsWith('-'));
	if (target === undefined) {
		process.stderr.write(`plugin-bridge ${command} <directory>\n`);
		return 1;
	}
	const path = resolve(target);

	if (command === 'validate') {
		// A bundle is not trusted for having been made here: traversal, the
		// per-file hashes and the canonical digest all run again on the way in.
		const bundle = await openPluginArchive(new Uint8Array(await readFile(path)));
		process.stdout.write(`id: ${bundle.id}\nversion: ${bundle.version}\n`);
		process.stdout.write(`digest: ${bundle.digest}\n`);
		process.stdout.write(`hosts: ${bundle.hosts.join(', ') || '(none)'}\n`);
		process.stdout.write(`permissions: ${bundle.permissions.join(', ') || '(none)'}\n`);
		return 0;
	}

	if ((await stat(path)).isDirectory() === false) {
		process.stderr.write(`${path} is not a directory.\n`);
		return 1;
	}
	if (format !== null && format !== 'aniyomi') {
		// The other five adapters convert a published artifact rather than a
		// source tree, so there is nothing on disk for these commands to read.
		process.stderr.write(
			`Only \`aniyomi\` translates from a source directory. For ${format}, use \`catalogue\`.\n`
		);
		return 1;
	}

	const files = await kotlinSources(path);
	if (files.length === 0) {
		process.stderr.write(`No .kt files under ${path}.\n`);
		return 1;
	}

	const parser = await loadKotlinGrammar(vendorWasm);
	const conversion = await convertKotlin(files, { parser });
	reportRefusals(conversion);

	if (command === 'inspect') return conversion.complete ? 0 : 1;
	if (command === 'check') {
		// `check` on a directory stops where the network would begin: running it
		// needs a base url and a host, which `catalogue` supplies from an index.
		process.stdout.write(
			'\nTranslated only. Running it needs a repository listing — use `catalogue`.\n'
		);
		return conversion.complete ? 0 : 1;
	}

	const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : `${path}.js`;
	await writeFile(out, conversion.js, 'utf8');
	process.stdout.write(`\nwrote ${out}\n`);
	return conversion.complete ? 0 : 1;
}
