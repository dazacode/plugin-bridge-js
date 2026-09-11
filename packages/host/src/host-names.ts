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
 * `"episode.mp4"`, all of which are shaped exactly like hostnames. A registry
 * lookup is not available and a full public-suffix list is not worth shipping
 * for this, so the test is the other way round: letters only, at least two of
 * them, and not one of the extensions a scraper's source is full of.
 */
export function plausibleTld(host: string): boolean {
	const tld = host.split('.').at(-1) ?? '';
	if (!/^[a-z]{2,}$/.test(tld)) return false;
	return !FILE_EXTENSIONS.has(tld);
}

/**
 * Not exhaustive, and does not need to be. Missing one means one spurious host
 * on a consent screen; the cost of the whole approach is bounded by that.
 *
 * Anything with a digit in it — `mp4`, `m3u8`, `mp3` — is already excluded by
 * the letters-only rule above, since no TLD has ever had one, so those are not
 * listed here.
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
