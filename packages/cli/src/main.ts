#!/usr/bin/env bun
/**
 * `plugin-bridge` — the engine, from a terminal.
 *
 * Every command answers a question this repository already had to answer for
 * itself: what does this source translate to, would it run, and what stopped
 * it. They are thin on purpose. A command that computed something the library
 * could not would be a second implementation of the interesting part, and the
 * whole point of the port is that there is one.
 *
 * ## What the commands do not do
 *
 * **No command ships a source.** There is no default index, no bundled
 * catalogue and no example host anywhere in this repository — an index URL is
 * a runtime argument, every time, supplied by whoever is running it. That is
 * not politeness, it is the line the project is built on; see `docs/security.md`.
 */

const COMMANDS = `plugin-bridge — adapt a foreign plugin into a portable JavaScript one

  convert <dir|url>            translate one extension and write a bundle
  check <dir|url>              translate it, run it, and say what stopped it
  inspect <dir|url>            what it declares, and what this build refuses
  catalogue <index-url>        every listing in a repository, scored
  validate <bundle.zip>        read a bundle back and check its digests

Writing a plugin of your own:

  init <dir>                   scaffold one you can run in about a minute
  test <dir>                   build it, run it, and show what it answered
  pack <dir>                   write the .yorozoplugin
  generate                     rebuild the generated runtime sources
  boundary                     assert the runtime/host boundary holds

Ecosystem-scoped forms are accepted where a format cannot be detected:

  plugin-bridge aniyomi check <dir>

Run a command with --help for its own options.
`;

/** The ecosystems an explicit scope may name; detection is tried first. */
const FORMATS = new Set([
	'aniyomi',
	'mangayomi',
	'cloudstream',
	'sora',
	'hayase',
	'lnreader',
	'nuvio'
]);

async function main(argv: string[]): Promise<number> {
	const args = [...argv];
	let format: string | null = null;
	if (args.length > 0 && FORMATS.has(args[0])) format = args.shift() ?? null;

	const command = args.shift();
	if (command === undefined || command === '--help' || command === '-h') {
		process.stdout.write(COMMANDS);
		return command === undefined ? 1 : 0;
	}

	switch (command) {
		case 'catalogue': {
			const { runCatalogue } = await import('./catalogue');
			return await runCatalogue(args);
		}
		case 'generate': {
			const { runGenerate } = await import('./generate');
			return await runGenerate(args);
		}
		case 'boundary': {
			const { runBoundary } = await import('./boundary');
			return await runBoundary(args);
		}
		case 'init':
		case 'test':
		case 'pack': {
			const { runAuthor } = await import('./author');
			return await runAuthor(command, args);
		}
		case 'convert':
		case 'check':
		case 'inspect':
		case 'validate': {
			const { runSource } = await import('./source');
			return await runSource(command, args, format);
		}
		default:
			process.stderr.write(`Unknown command: ${command}\n\n${COMMANDS}`);
			return 1;
	}
}

export {};

process.exitCode = await main(process.argv.slice(2));
