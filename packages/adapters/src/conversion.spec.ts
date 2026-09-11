/**
 * Converting a module into a bundle, and running the bundle.
 *
 * Three properties, and each of them is one that would be expensive to
 * discover later:
 *
 * 1. **A converted bundle is an ordinary bundle.** It goes back through
 *    `openPluginArchive` — the same reader, the same refusals — because the
 *    whole design rests on conversion not being a way around verification.
 * 2. **Conversion is deterministic.** `REPOSITORY.md` §6 requires it of the
 *    packager, and updates compare digests: a bundle whose bytes depended on
 *    which browser converted it would look like a new version on every device.
 * 3. **The shim actually works.** The generated entrypoint is imported and
 *    driven here, so the mapping from a foreign module's four functions onto
 *    the three ABI methods is exercised rather than assumed.
 *
 * The module under test is written inline, in the foreign style, against a
 * fake host. Nothing here touches the network and no real source appears
 * (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import fixtures from '../../../fixtures/indexes.json';
import { openPluginArchive, PluginArchiveError } from '@plugin-bridge/core/archive';
import { hostsInSource, wildcardFor, type ConversionServices } from '@plugin-bridge/core/adapter';
import { adapterFor } from '@plugin-bridge/core/detect';
import { convertedManifest, toSemver, writeZip } from '@plugin-bridge/core/package';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';

const soraFixture = fixtures as unknown as {
	sora: { indexUrl: string; body: unknown };
};

/**
 * A module in the foreign style: plain functions, JSON strings out, `fetchv2`
 * in. Deliberately not tidy — this is what the shim has to accept.
 */
const MODULE_SOURCE = `
async function searchResults(keyword) {
  const response = await fetchv2('https://watch.example.invalid/search?q=' + keyword);
  const body = await response.text();
  return JSON.stringify([{ title: 'Found ' + body + ' for ' + keyword, image: '/poster.png', href: '/show/1' }]);
}

async function extractDetails(url) {
  return JSON.stringify([{ description: 'An example.', aliases: '', airdate: '' }]);
}

async function extractEpisodes(url) {
  // Newest first, and unnumbered, which is the common awkward case.
  return JSON.stringify([{ href: '/show/1/ep/2' }, { href: '/show/1/ep/1' }]);
}

async function extractStreamUrl(url) {
  return JSON.stringify({ stream: 'https://cdn.example.invalid/one.m3u8', subtitles: '/subs/one.srt' });
}
`;

/**
 * The obfuscated predicate behind a host-identification gate, transcribed
 * verbatim from a module carrying one.
 *
 * Kept as source text rather than as a function so that the very same
 * characters are both compiled into the module under test below and driven
 * directly. A hand-retyped second copy could drift into something more
 * permissive than the real thing, and the test that asserts the predicate is
 * strict would then be asserting it about a predicate nobody ships.
 */
const HOST_GATE_PREDICATE = `function _0x7E9A(_) { return ((___, ____, _____, ______, _______, ________, _________, __________, ___________, ____________) => (____ = typeof ___, _____ = ___ && ___[String.fromCharCode(...[108, 101, 110, 103, 116, 104])], ______ = [...String.fromCharCode(...[99, 114, 97, 110, 99, 105])], _______ = ___ ? [...___[String.fromCharCode(...[116, 111, 76, 111, 119, 101, 114, 67, 97, 115, 101])]()] : [], (________ = ______[String.fromCharCode(...[115, 108, 105, 99, 101])]()) && _______[String.fromCharCode(...[102, 111, 114, 69, 97, 99, 104])]((_________, __________) => (___________ = ________[String.fromCharCode(...[105, 110, 100, 101, 120, 79, 102])](_________)) >= 0 && ________[String.fromCharCode(...[115, 112, 108, 105, 99, 101])](___________, 1)), ____ === String.fromCharCode(...[115, 116, 114, 105, 110, 103]) && _____ === 16 && ________[String.fromCharCode(...[108, 101, 110, 103, 116, 104])] === 0))(_) }`;

/**
 * A module in the foreign style that asks which application is running it.
 *
 * A good number of these carry this, and answered wrongly it does not throw:
 * it returns a well-formed URL to a file with nothing in it. That is the
 * failure worth a test, because an error is information and this is a plugin
 * that reports success and then plays nothing.
 */
const GATED_MODULE_SOURCE = `
${HOST_GATE_PREDICATE}

function _0xCheck() {
  var a = typeof _0xB4F2 === 'function';   // supplied by the host
  var b = typeof _0x7E9A === 'function';   // defined here
  return a && b ? _0x7E9A(_0xB4F2()) : false;
}

async function searchResults(keyword) { return "[]"; }
async function extractEpisodes(url) { return "[]"; }

async function extractStreamUrl(url) {
  if (!_0xCheck()) return 'https://placeholder.example/blocked.mp4';
  return JSON.stringify({ stream: 'https://cdn.example.invalid/gated.m3u8' });
}
`;

function soraListing(): RepositoryPlugin {
	const listing = adapterFor('sora').parseIndex(
		JSON.stringify(soraFixture.sora.body),
		soraFixture.sora.indexUrl
	).plugins[0];
	expect(listing).toBeDefined();
	return listing;
}

/**
 * The services a conversion is given, carrying only the one this format uses.
 *
 * A module in this format is the single artifact its manifest names, so the
 * byte-fetcher is the whole of it. The other two exist for the format that
 * converts from a source tree, and they throw rather than answer emptily: an
 * adapter that quietly started listing directories would otherwise read an
 * empty repository here and report it as a module with nothing in it.
 */
function servicesFor(script: string): ConversionServices {
	return {
		fetchArtifact: async () => new TextEncoder().encode(script),
		getText: () => {
			throw new Error('this format converts one artifact and reads no sibling file');
		},
		listFiles: () => {
			throw new Error('this format converts one artifact and lists no directory');
		}
	};
}

function convert(script = MODULE_SOURCE): Promise<Uint8Array> {
	return adapterFor('sora').convert(soraListing(), servicesFor(script));
}

describe('a converted bundle is an ordinary bundle', () => {
	it('passes the same archive reader a downloaded one would', async () => {
		const listing = soraListing();
		const bytes = await convert();
		// The bundle's own list, read back, because a conversion legitimately
		// declares more than the foreign manifest named (see the next test).
		const declared = (await openPluginArchive(bytes)).hosts;
		const bundle = await openPluginArchive(bytes, {
			expected: {
				id: listing.id,
				version: toSemver(listing.version),
				// Null because these bytes never crossed a network. Every other
				// check still runs; see `ExpectedPlugin.sha256`.
				sha256: null,
				permissions: listing.permissions,
				hosts: declared
			}
		});

		expect(bundle.id).toBe(listing.id);
		expect(bundle.version).toBe('1.2.0');
		expect(bundle.permissions).toEqual(['network']);
		expect(bundle.signedBy).toBeNull();
		expect(bundle.hosts).toContain('watch.example.invalid');
	});

	it('declares the hosts the module’s code names, not just the manifest’s', async () => {
		// The failure this prevents, seen for real: a module searches fine and is
		// then refused the instant it resolves, because the CDN it streams from
		// is written in its code and named nowhere in its metadata. The refusal
		// reads as a broken source when it is actually our under-declaration.
		const bundle = await openPluginArchive(
			await convert(`
				async function searchResults(q) { return "[]"; }
				async function extractEpisodes(u) { return "[]"; }
				async function extractStreamUrl(u) {
					const api = await fetchv2('https://api.example.invalid/v1/x');
					return JSON.stringify({ stream: 'https://cdn.example.invalid/one.m3u8' });
				}
			`)
		);

		expect(bundle.hosts).toContain('api.example.invalid');
		expect(bundle.hosts).toContain('cdn.example.invalid');
		// Still the manifest's own host, and still finite — never a wildcard.
		expect(bundle.hosts).toContain('watch.example.invalid');
		expect(bundle.hosts).not.toContain('*');
	});

	it('states that nothing signed it, rather than leaving it ambiguous', async () => {
		const bundle = await openPluginArchive(await convert());
		const signature = JSON.parse(new TextDecoder().decode(bundle.files.get('signature.json')!)) as {
			signed: boolean;
			convertedBy: Record<string, unknown>;
		};

		expect(signature.signed).toBe(false);
		expect(signature.convertedBy['format']).toBe('sora');
		expect(signature.convertedBy['foreignVersion']).toBe('1.2.0');
	});

	it('is rejected when a byte of the payload is changed afterwards', async () => {
		const bytes = await convert();
		// The payload is stored, so its bytes are findable in the archive. A
		// converted bundle that could be edited in place and still install would
		// make the whole integrity record decorative.
		const needle = new TextEncoder().encode('searchResults');
		const at = indexOf(bytes, needle);
		expect(at).toBeGreaterThan(-1);
		bytes[at] = bytes[at] ^ 0x20;

		await expect(openPluginArchive(bytes)).rejects.toThrow(PluginArchiveError);
	});
});

describe('conversion is deterministic', () => {
	it('produces byte-identical bundles for identical input', async () => {
		const [first, second] = await Promise.all([convert(), convert()]);
		expect(Array.from(first)).toEqual(Array.from(second));
	});

	it('writes entries in sorted order regardless of insertion order', () => {
		const forwards = writeZip(
			new Map([
				['a.txt', new Uint8Array([1])],
				['b.txt', new Uint8Array([2])]
			])
		);
		const backwards = writeZip(
			new Map([
				['b.txt', new Uint8Array([2])],
				['a.txt', new Uint8Array([1])]
			])
		);
		expect(Array.from(forwards)).toEqual(Array.from(backwards));
	});
});

describe('the manifest a converter writes', () => {
	it('normalises a foreign version into SemVer without losing the original', () => {
		// The lossy direction is the point: `14.58` and `14.5.8` both become
		// something the schema accepts, which is exactly why update checks
		// compare `origin.foreignVersion` and never this.
		expect(toSemver('14.58')).toBe('14.58.0');
		expect(toSemver('1.2.3')).toBe('1.2.3');
		expect(toSemver('0')).toBe('0.0.0');
		expect(toSemver('v2')).toBe('2.0.0');
		expect(toSemver('')).toBe('0.0.0');
	});

	it('refuses to build a bundle that could reach nothing', () => {
		// No hosts means nothing to ask permission for and nothing it could
		// fetch. Producing that bundle would install a plugin guaranteed to fail
		// at its first request.
		expect(() =>
			convertedManifest({
				id: 'app.yorozo.converted.sora.example',
				name: 'Example',
				description: '',
				version: '1.0.0',
				author: 'nobody',
				hosts: [],
				origin: {
					format: 'sora',
					artifactUrl: 'https://example.invalid/s.js',
					foreignId: 'Example',
					foreignVersion: '1.0.0',
					mediaKind: 'anime',
					isNsfw: false
				},
				entrypointSource: 'x'
			})
		).toThrow(/nothing to ask permission for/);
	});
});

describe('the generated entrypoint, run', () => {
	/** A fake host with exactly the surface `ctx` promises. */
	function context(): { ctx: unknown; requested: string[] } {
		const requested: string[] = [];
		const ctx = {
			http: {
				async send(url: string) {
					requested.push(url);
					return {
						status: 200,
						url,
						headers: {},
						text: async () => 'ok',
						json: async () => ({})
					};
				}
			},
			text: {
				encode: (value: string) => new TextEncoder().encode(value),
				decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
			},
			bytes: {
				toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
				fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
			}
		};
		return { ctx, requested };
	}

	async function loadModule() {
		const bundle = await openPluginArchive(await convert());
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		return (await import(/* @vite-ignore */ url)).default as {
			id: string;
			searchCatalog(query: string, page: number, ctx: unknown): Promise<{ entries: unknown[] }>;
			listEpisodes(
				id: string,
				ctx: unknown
			): Promise<{ number: number; sourceEpisodeId: string }[]>;
			resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
		};
	}

	it('identifies as the id its manifest declares', async () => {
		const module = await loadModule();
		// The sandbox refuses a bundle whose code disagrees with its manifest,
		// so a converter that got this wrong would produce an uninstallable
		// bundle that looked fine until load.
		expect(module.id).toBe(soraListing().id);
	});

	it('routes the module’s own fetch through ctx, and absolutises what it returns', async () => {
		const module = await loadModule();
		const { ctx, requested } = context();

		const page = await module.searchCatalog('example', 1, ctx);

		expect(requested).toEqual(['https://watch.example.invalid/search?q=example']);
		expect(page.entries).toEqual([
			{
				sourceMediaId: 'https://watch.example.invalid/show/1',
				title: 'Found ok for example',
				alternativeTitles: [],
				posterImageUrl: 'https://watch.example.invalid/poster.png'
			}
		]);
	});

	it('returns nothing for a second page rather than the first again', async () => {
		// These modules have no pagination. Repeating page one would make a
		// paginating caller loop forever.
		const module = await loadModule();
		expect((await module.searchCatalog('example', 2, context().ctx)).entries).toEqual([]);
	});

	it('numbers and orders an episode list the module left unnumbered', async () => {
		const module = await loadModule();
		const episodes = await module.listEpisodes(
			'https://watch.example.invalid/show/1',
			context().ctx
		);

		expect(episodes.map((episode) => episode.number)).toEqual([1, 2]);
		// Position decides the number, and the list is then sorted ascending, so
		// a source that lists newest first does not produce a grid counting down.
		expect(episodes[0].sourceEpisodeId).toBe('https://watch.example.invalid/show/1/ep/2');
	});

	it('resolves to a stream carrying the container the module declared', async () => {
		const module = await loadModule();
		const sources = await module.resolve(
			'https://watch.example.invalid/show/1',
			{
				number: 1,
				sourceEpisodeId: 'https://watch.example.invalid/show/1/ep/1'
			},
			context().ctx
		);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/one.m3u8');
		// From the manifest's `streamType`, not sniffed from the extension:
		// guessing a container is how a player gets a black screen and no error.
		expect(sources[0].container).toBe('hls');
		// The subtitle is taken because the *result* carried one. The manifest's
		// `softsub` flag says a module can return subtitles, not that this call
		// did — and modules routinely return them with the flag unset, so
		// trusting the flag threw away tracks that were right there.
		expect(sources[0].subtitles).toEqual([
			{
				languageCode: 'und',
				label: 'Subtitles',
				format: 'srt',
				url: 'https://watch.example.invalid/subs/one.srt',
				isEmbedded: false,
				isDefault: true
			}
		]);
	});

	it('reads the location key these modules actually use', async () => {
		// Measured across a real library: 18 of 28 modules return the location as
		// `streamUrl` and only 6 as `url`. Reading `url` alone silently dropped
		// the streams of two thirds of them, and the check then reported "that
		// source returned no stream" — blaming the author for a key this shim
		// never looked at.
		const bundle = await openPluginArchive(
			await convert(`
				async function searchResults(q) { return "[]"; }
				async function extractEpisodes(u) { return "[]"; }
				async function extractStreamUrl(u) {
					return JSON.stringify({
						streams: [{ title: 'Mirror A', streamUrl: 'https://cdn.example.invalid/a.m3u8',
						            headers: { Referer: 'https://watch.example.invalid/' } }],
						subtitle: 'https://cdn.example.invalid/a.vtt'
					});
				}
			`)
		);
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
		};

		const sources = await module.resolve('x', { number: 1, sourceEpisodeId: 'y' }, context().ctx);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/a.m3u8');
		expect(sources[0].label).toBe('Mirror A');
		// Dropping per-stream headers is not cosmetic: a source that checks
		// Referer serves the manifest and then refuses every segment, which
		// looks like a working plugin that plays nothing.
		expect(sources[0].headers).toEqual({
			Referer: 'https://watch.example.invalid/'
		});
		// `subtitle`, singular — the spelling 11 of those 28 use.
		expect((sources[0].subtitles as { url: string }[])[0].url).toBe(
			'https://cdn.example.invalid/a.vtt'
		);
	});

	it('does not pass off a failure sentinel as a stream', async () => {
		// These modules signal failure by returning a URL — a bare origin with
		// nothing after it. Accepting one produced a green tick on a plugin whose
		// stream turned out not to exist, which is the worst thing the check can
		// do: a false pass, unlike a failure, tells you nothing is wrong.
		const bundle = await openPluginArchive(
			await convert(`
				async function searchResults(q) { return "[]"; }
				async function extractEpisodes(u) { return "[]"; }
				async function extractStreamUrl(u) {
					return JSON.stringify({ stream: 'https://example.invalid/' });
				}
			`)
		);
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
		};

		const sources = await module.resolve('x', { number: 1, sourceEpisodeId: 'y' }, context().ctx);
		expect(sources).toEqual([]);
	});

	it('answers the host-identification gate a module puts in front of its stream', async () => {
		// The failure this prevents, seen for real: the module asks which client
		// is running it, gets no answer, and returns a working URL to a
		// zero-byte file rather than an error. Every check downstream is
		// satisfied — it is a real URL, it has a path, the request succeeds — so
		// the plugin is marked working and the viewer discovers otherwise at the
		// player. Answered, the module hands over the URL it would have given
		// its own client.
		const bundle = await openPluginArchive(await convert(GATED_MODULE_SOURCE));
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
		};

		const sources = await module.resolve('x', { number: 1, sourceEpisodeId: 'y' }, context().ctx);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/gated.m3u8');
		// Named rather than merely counted, because what the gate returns
		// unanswered is a perfectly ordinary URL: nothing else in this shim
		// could tell it apart from a stream, which is why the question has to be
		// answered instead of the answer filtered.
		expect(sources[0].url).not.toBe('https://placeholder.example/blocked.mp4');
	});

	it('runs a predicate that a wrong answer genuinely fails', () => {
		// Without this the test above would pass just as happily against a
		// predicate that returned true for anything, and would be pinning
		// nothing. The real one wants a sixteen-character string containing
		// every letter of its author's handle, so the near misses are what
		// matter: the required letters at the wrong length are still a refusal,
		// in both directions.
		const predicate = new Function(`${HOST_GATE_PREDICATE}\nreturn _0x7E9A;`)() as (
			value: unknown
		) => boolean;

		expect(predicate('kuro-cranci-0001')).toBe(true);
		expect(predicate('sora')).toBe(false);
		expect(predicate('')).toBe(false);
		// The letters and nothing else, ten characters short.
		expect(predicate('cranci')).toBe(false);
		// The accepted answer with one character added.
		expect(predicate('kuro-cranci-00012')).toBe(false);
	});

	it('leaves a module that asks no such question alone', async () => {
		// The answer is injected into every converted bundle, including the
		// majority that never look for it, so it has to be inert. This is the
		// cheap half of that change and the half nobody would notice breaking
		// until a working source stopped resolving for a reason unrelated to
		// anything its author wrote.
		const bundle = await openPluginArchive(
			await convert(`
				async function searchResults(q) { return "[]"; }
				async function extractEpisodes(u) { return "[]"; }
				async function extractStreamUrl(u) {
					return JSON.stringify({ stream: 'https://cdn.example.invalid/ungated.m3u8' });
				}
			`)
		);
		// The gate really is in these bytes, so this module resolving says the
		// injection is harmless rather than that it was skipped.
		expect(bundle.entrypointSource).toContain('_0xB4F2');

		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
		};

		const sources = await module.resolve('x', { number: 1, sourceEpisodeId: 'y' }, context().ctx);

		expect(sources).toHaveLength(1);
		expect(sources[0].url).toBe('https://cdn.example.invalid/ungated.m3u8');
	});

	it('reports a missing function by name instead of throwing on undefined', async () => {
		const bundle = await openPluginArchive(
			await convert('async function searchResults() { return "[]"; }')
		);
		const url = `data:text/javascript;base64,${Buffer.from(bundle.entrypointSource).toString('base64')}`;
		const module = (await import(/* @vite-ignore */ url)).default as {
			listEpisodes(id: string, ctx: unknown): Promise<unknown>;
		};

		await expect(module.listEpisodes('x', context().ctx)).rejects.toThrow(
			/does not implement extractEpisodes/
		);
	});
});

/**
 * These drive `hostsInSource` directly rather than through `convert()`, because
 * what is being pinned is how *text* is read — the shapes a foreign module
 * writes a host in, and the things shaped like hosts that are not any. Routing
 * that through a zip and an archive reader would only put distance between a
 * wrong regex and the failure it causes.
 */
describe('the hosts a module’s source text names', () => {
	it('still reads a plain absolute literal', () => {
		// The oldest shape, kept under test because everything else here
		// widened the reading around it: a module that writes its API host out
		// in full must not be lost to a regex grown greedier.
		expect(hostsInSource('const api = "https://api.example.invalid/x";')).toContain(
			'api.example.invalid'
		);
	});

	it('grants the wildcard sibling beside every host it finds', () => {
		// The failure this prevents, seen for real: the code names one CDN host,
		// the page it scrapes then hands it a numbered neighbour, and the plugin
		// is refused mid-playback for a host nobody could have written down. The
		// manifest’s hosts were always widened this way; the code’s were not.
		expect(hostsInSource('const api = "https://api.example.invalid/x";')).toContain(
			'*.example.invalid'
		);
	});

	it('keeps the literal tail of an interpolated host and none of the placeholder', () => {
		// These modules pick a server at runtime and build the url around it.
		// Refusing to read the shape at all left converted modules declaring
		// nothing and failing at resolve; reading it naively is worse, because a
		// host with `${` in it is a permission nobody can grant.
		const hosts = hostsInSource('const url = `https://${server}.example.invalid/x`;');

		expect(hosts).toContain('*.example.invalid');
		expect(hosts.some((host) => host.includes('${'))).toBe(false);
	});

	it('reads nothing from a host that is entirely a placeholder', () => {
		// Nothing is written down, so nothing can honestly be declared.
		expect(hostsInSource('const url = `https://${everything}`;')).toEqual([]);
	});

	it('reads a protocol-relative url, as scraped markup writes it', () => {
		// Markup says `//host/…` and these modules copy it through verbatim, so
		// a reader insisting on a scheme misses the stream urls that matter.
		expect(hostsInSource('const src = "//cdn.example.invalid/a.m3u8";')).toContain(
			'cdn.example.invalid'
		);
	});

	it('reads a bare quoted hostname that never sits beside a scheme', () => {
		// The common idiom is a host constant concatenated onto `"https://"`
		// somewhere else entirely, so only the bare half is nameable.
		expect(hostsInSource('const host = "cdn.example.invalid";')).toContain('cdn.example.invalid');
	});

	it('does not read a CSS selector as a host, however much it looks like one', () => {
		// A scraper is made of these. `div.description` and `font.ep` are quoted
		// strings shaped exactly like hostnames, and they arrived on the consent
		// screen as hosts, beside the real ones, with nothing to tell them
		// apart. Nothing about the string says which it is; the call around it
		// does.
		const source =
			"const a = document.selectFirst('div.description');\n" +
			"const b = document.select('font.ep');\n" +
			"const c = element.closest('li.card');";

		expect(hostsInSource(source)).toEqual([]);
	});

	it('does not mistake a filename for a hostname', () => {
		// The price of reading bare quoted strings: a scraper’s source is full
		// of things shaped exactly like hosts. Getting this wrong does not break
		// playback, it fills the consent screen with `player.min.js` and teaches
		// viewers that the host list is noise.
		expect(
			hostsInSource('const assets = ["player.min.js", "styles.css", "episode.mp4", "index.html"];')
		).toEqual([]);
	});

	it('ignores a single-label string, which is never a host worth granting', () => {
		expect(hostsInSource('const where = "localhost"; const enc = "utf-8";')).toEqual([]);
	});

	it('does not read a host out of a block comment', () => {
		// Seen for real: a module carries a comment documenting the JSON its
		// extractor returns, complete with five invented urls. Those arrived on
		// the consent screen as five hosts and five wildcards, beside the real
		// ones, with nothing to tell a viewer which were which.
		const hosts = hostsInSource(`
			/* {"streamUrl": "https://invented.example/stream1.m3u8"} */
			const real = "https://cdn.example.invalid/a.m3u8";
		`);

		expect(hosts).toContain('cdn.example.invalid');
		expect(hosts).not.toContain('invented.example');
	});

	it('does not read a host out of a line comment', () => {
		const hosts = hostsInSource(`
			//   "https://retired.example/embed": "retired",
			const real = "https://cdn.example.invalid/a.m3u8";
		`);

		expect(hosts).toContain('cdn.example.invalid');
		expect(hosts).not.toContain('retired.example');
	});

	it('still reads code on a line that also carries a trailing comment', () => {
		// Stripping runs from `//` to the end of the line, not over the line.
		expect(
			hostsInSource('const api = "https://api.example.invalid/x"; // the search endpoint')
		).toContain('api.example.invalid');
	});

	it('does not mistake the `//` inside a url for the start of a comment', () => {
		expect(hostsInSource('const u = "https://cdn.example.invalid/a.m3u8";')).toContain(
			'cdn.example.invalid'
		);
	});

	it('keeps reading after a regex literal holding an odd number of quotes', () => {
		// The regression that matters most here. The comment stripper first
		// tracked quotes across the whole file, and ordinary scraper code
		// contains an anchor-matching regex with three double quotes in it. Odd
		// parity, so the scan entered a string it never left, every `//` in
		// every url below read as a comment, and two thirds of the module’s
		// hosts disappeared with no sign anything had gone wrong. A '' or ""
		// string may not hold a raw newline, so that state now resets at each
		// line ending and one confusing line confuses nothing after it.
		const hosts = hostsInSource(`
			const re = /<a[^>]*href="([^"]+)"[^>]*>([^<]+)<\\/a>/g;
			const page = "https://watch.example.invalid/list";
			const stream = "https://cdn.example.invalid/a.m3u8";
		`);

		expect(hosts).toContain('watch.example.invalid');
		expect(hosts).toContain('cdn.example.invalid');
	});

	it('carries template state across lines, so a multi-line template names its host', () => {
		// The other half of the same grammar argument: a template literal is the
		// one string that genuinely spans lines, so its state has to survive one.
		const hosts = hostsInSource(
			['const markup = `', '  <iframe src=https://tpl.example.invalid/embed>', '`;'].join('\n')
		);

		expect(hosts).toContain('tpl.example.invalid');
	});

	it('bounds how many hosts the code may contribute', () => {
		// A minified bundle carrying analytics and ad urls would otherwise turn
		// the install sheet into a hundred lines nobody reads, and a consent
		// screen nobody reads grants everything.
		const source = `
			fetchv2("https://a.one.invalid/x");
			fetchv2("https://b.two.invalid/x");
			fetchv2("https://c.three.invalid/x");
			fetchv2("https://d.four.invalid/x");
		`;
		const named = (hosts: string[]) => hosts.filter((host) => !host.startsWith('*.'));

		expect(named(hostsInSource(source))).toHaveLength(4);
		expect(named(hostsInSource(source, 2))).toHaveLength(2);
	});

	it('never widens a shared hosting suffix into a wildcard', () => {
		// End to end, because this is the one over-grant that would not look
		// like one on the consent screen.
		const hosts = hostsInSource('fetchv2("https://helper.someone.workers.dev/go");');

		expect(hosts).toContain('*.someone.workers.dev');
		expect(hosts).not.toContain('*.workers.dev');
	});
});

describe('the wildcard sibling a host is granted alongside', () => {
	it('widens to the registrable parent', () => {
		expect(wildcardFor('www.example.com')).toBe('*.example.com');
		expect(wildcardFor('example.com')).toBe('*.example.com');
		expect(wildcardFor('shop.example.co.uk')).toBe('*.example.co.uk');
	});

	it('takes a shared suffix one label deeper instead', () => {
		// The failure this prevents: a module reaches a helper endpoint on a
		// shared hosting domain, and the last two labels of that name belong to
		// the platform rather than to anyone. Wildcarding there granted every
		// worker anybody has ever deployed.
		expect(wildcardFor('helper.someone.workers.dev')).toBe('*.someone.workers.dev');
	});

	it('grants nothing when the shared suffix has no deeper label', () => {
		// A bare `github.io` names no one and `*.github.io` names everyone, so
		// there is no honest wildcard to give.
		expect(wildcardFor('someone.github.io')).toBeNull();
		expect(wildcardFor('github.io')).toBeNull();
	});

	it('grants nothing for a single label', () => {
		expect(wildcardFor('localhost')).toBeNull();
	});
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (let i = 0; i + needle.length <= haystack.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1) {
			if (haystack[i + j] !== needle[j]) continue outer;
		}
		return i;
	}
	return -1;
}
