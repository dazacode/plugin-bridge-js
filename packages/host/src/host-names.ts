import { ROOT_ZONE_TLDS } from './tlds';

/**
 * Whether a string shaped like a hostname is worth treating as one.
 *
 * Two places read hosts out of text a source controls, and they answer for
 * different things: `foreign/adapter.ts` reads a converted module's own code
 * and writes what it finds into the **manifest**, which a viewer sees and
 * consents to; `sandbox-host.ts` reads a page the plugin has just fetched and
 * adds what it finds to the hosts that run may reach. The inputs differ —
 * module source has `${…}` in it, markup does not — but "is this a host at
 * all" is one question, and it had two answers.
 *
 * The looser of the two was the one running at *runtime*: it learned
 * `console.log` off a real page, out of `//console.log(direction)` — a
 * commented-out line in an inline script, whose `//` no regex can tell from a
 * protocol-relative URL. The packager had already solved that, by anchoring the
 * protocol-relative form on a quote and by testing the last label. So the test
 * lives here now, where the next reader of hostnames inherits it instead of
 * rediscovering it. The same argument as `host-match.ts`, one question along.
 *
 * Reading bare quoted strings means reading `"player.js"`, `"styles.css"` and
 * `"episode.mp4"`, all of which are shaped exactly like hostnames — and, in a
 * built bundle or a translated Kotlin module, `"Array.prototype.indexOf"`,
 * `"nodejs.util.inspect.custom"` and `"java.net.SocketTimeoutException"`. The
 * test used to be "letters only, and not a file extension", which let every
 * one of those last three through: they reached the consent screen as hosts,
 * with their `*.` siblings beside them (`*.c.staff` from a `j.c.staff`).
 *
 * So the last label has to be a top-level domain that exists: one in the root
 * zone (`tlds.ts`, IANA's list, whole), or one of the names RFC 2606 reserves
 * for tests and documentation, which resolve nowhere and are what this
 * project's own fixtures are required to use. `localhost` is not among them:
 * it resolves, to this machine. The file extensions are still refused where
 * they are also TLDs (`.zip`, `.mov`), since `"episode.mov"` is a filename far
 * more often than it is a host.
 */
export function plausibleTld(host: string): boolean {
	const tld = host.split('.').at(-1) ?? '';
	if (FILE_EXTENSIONS.has(tld)) return false;
	return ROOT_ZONE_TLDS.has(tld) || RESERVED_FOR_TESTS.has(tld);
}

/** RFC 2606 §2: names that will never be delegated, kept for tests and examples. */
const RESERVED_FOR_TESTS = new Set(['test', 'example', 'invalid']);

/**
 * Extensions that a quoted filename ends in. Most are not TLDs at all and the
 * root-zone test already refuses them; the list matters for the ones that are
 * both (`zip`, `mov`, `map`, and `md`, which is Moldova), and it stays whole so that
 * a TLD delegated under a common extension later does not quietly start
 * granting filenames.
 */
const FILE_EXTENSIONS = new Set([
	'js',
	'mjs',
	'cjs',
	'ts',
	'json',
	'html',
	'htm',
	'php',
	'asp',
	'aspx',
	'jsp',
	'css',
	'scss',
	'xml',
	'txt',
	'md',
	'map',
	'min',
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'svg',
	'ico',
	'bmp',
	'avif',
	'mkv',
	'webm',
	'avi',
	'mov',
	'flv',
	'aac',
	'ogg',
	'wav',
	'flac',
	'vtt',
	'srt',
	'ass',
	'ssa',
	'sub',
	'woff',
	'ttf',
	'otf',
	'eot',
	'zip',
	'gz',
	'rar',
	'pdf',
	'exe',
	'apk',
	'jar'
]);
