/**
 * The Kotlin runtime, evaluated the way a bundle evaluates it.
 *
 * Everything in `kotlin-runtime.ts` is a **string**, so TypeScript checks none
 * of it. A missing brace, a template literal that swallowed a `${`, or a regex
 * whose backslashes were eaten by the TypeScript template it lives inside is
 * not a type error here — it is a `SyntaxError` or an `Invalid regular
 * expression` at bundle load, on a viewer's device, with nothing on screen to
 * say which helper was to blame. Asserting that the source *contains* a
 * substring would catch none of that.
 *
 * So this file builds a module out of the runtime, imports it, and drives the
 * helpers against a fake host — the same shape `dom-source.spec.ts` and
 * `mangayomi-conversion.spec.ts` use. Merely importing proves every regex
 * *literal* compiles; the tests below exercise the ones built at runtime, which
 * a parse cannot reach.
 *
 * The second thing it asserts is the contract in `kotlin/runtime-api.ts`: the
 * emitter and this runtime cannot import each other — one emits text, the other
 * *is* text — so a name added to one side and forgotten on the other would
 * surface as `__k.foo is not a function` at the far end of a conversion. The
 * list is checked here instead.
 *
 * No source is named anywhere in this file (AGENTS.md rule 9); every host is
 * `example.invalid`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
	requiredRuntimeNames,
	HOST_BACKED_HELPERS,
	RUNTIME_GLOBALS,
	RUNTIME_HELPERS
} from '@plugin-bridge/core/kotlin/runtime-api';
import { JS_RUNTIME } from './js-runtime';
import {
	KOTLIN_RUNTIME_SECTIONS,
	kotlinRuntime,
	type KotlinRuntimeSection
} from './kotlin-runtime';

/* ── the fake host ────────────────────────────────────────────────────────── */

interface Sent {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string | null;
}

interface Page {
	status?: number;
	url?: string;
	body: string;
	headers?: Record<string, string>;
	/** Set when the relay declined to read the body; see `__responseOf`. */
	unread?: string;
}

function context(pages: Record<string, Page> = {}, settings: Record<string, string> = {}) {
	const sent: Sent[] = [];
	const requests: Record<string, unknown>[] = [];
	const logged: string[] = [];
	const policies: Record<string, unknown>[] = [];
	const ctx = {
		http: {
			/**
			 * `ABI.md` §2.1's declaration, recorded rather than enforced.
			 *
			 * Enforcement is the host's (`host/net/request-policy.ts` is where it
			 * is tested against a clock). What this side owes is that a limit an
			 * extension declared *arrives*, which is the half that used to be
			 * missing: `__k.rateLimit` returned its receiver and told nobody.
			 */
			async policy(declared: Record<string, unknown>) {
				policies.push(declared);
			},
			async send(
				url: string,
				request: {
					method: string;
					headers: Record<string, string>;
					body: string | null;
					follow?: boolean;
				}
			) {
				sent.push({
					url,
					method: request.method,
					headers: request.headers,
					body: request.body
				});
				// Kept whole and separately, because `follow` is asserted by its
				// *presence*: the contract is that an ordinary request never
				// mentions it, so the default stays the host's business.
				requests.push(request as unknown as Record<string, unknown>);
				const page = pages[url] ?? { body: '' };
				const body = page.body;
				return {
					status: page.status ?? 200,
					url: page.url ?? url,
					headers: page.headers ?? {},
					...(page.unread === undefined ? {} : { unread: page.unread }),
					text: async () => body,
					json: async () => JSON.parse(body || '{}') as unknown
				};
			}
		},
		settings: {
			string: (id: string) => settings[id] ?? '',
			boolean: () => false,
			list: () => [] as string[]
		},
		text: {
			encode: (value: string) => new TextEncoder().encode(value),
			decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		},
		bytes: {
			toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
			fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
		},
		// The host's logger takes a message, and `logged` is where a test reads
		// what a converted extension reported without failing.
		log: {
			debug: (message: string) => logged.push(message),
			warn: (message: string) => logged.push(message)
		}
	};
	return { ctx, sent, requests, logged, policies };
}

/* ── the runtime, as a module ─────────────────────────────────────────────── */

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Loaded {
	k: any;
	globals: Record<string, any>;
	client: any;
	network: any;
	enter(ctx: unknown): unknown;
	hasJsoup: boolean;
}

let loads = 0;

async function load(sections?: readonly KotlinRuntimeSection[]): Promise<Loaded> {
	const full = sections === undefined || sections.length === KOTLIN_RUNTIME_SECTIONS.length;
	const probe = [
		'export const k = __k;',
		full
			? `export const globals = { ${RUNTIME_GLOBALS.join(', ')} };`
			: 'export const globals = {};',
		full ? 'export const clientRef = client;' : 'export const clientRef = null;',
		full ? 'export const networkRef = network;' : 'export const networkRef = null;',
		'export const hasJsoup = typeof Jsoup !== "undefined";',
		'export const enter = __enter;'
	].join('\n');

	// The real Aniyomi bundle places the generated generic runtime before the
	// Kotlin runtime and exposes this bridge as `__rt`. Keep the unit fixture
	// small while still exercising the dependency explicitly.
	// A serial number, because a `data:` URL is cached by its own text and two
	// identical loads would hand back one module. Almost every test is happy
	// with that — evaluating 44 KB of inlined parser per test is not free — but
	// the runtime holds module state (the declared request policy), and a suite
	// that shared it would have one test asserting another's declaration.
	loads += 1;
	const source = `${JS_RUNTIME}\nvar __rt = { unpackDeanEdwards: function (value) { return value === 'packed' ? 'decoded' : null; } };\n${kotlinRuntime(sections)}\n${probe}\n/* load ${loads} */`;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	const module = (await import(/* @vite-ignore */ url)) as {
		k: any;
		globals: Record<string, any>;
		clientRef: any;
		networkRef: any;
		hasJsoup: boolean;
		enter(ctx: unknown): unknown;
	};
	return {
		k: module.k,
		globals: module.globals,
		client: module.clientRef,
		network: module.networkRef,
		enter: module.enter,
		hasJsoup: module.hasJsoup
	};
}

/** Loaded once: evaluating 44 KB of inlined parser per test is not free. */
const runtime = await load();
const k = runtime.k;

/* ── the contract ─────────────────────────────────────────────────────────── */

describe('what the emitter is promised', () => {
	it('defines every helper the emitter may call', () => {
		const missing = RUNTIME_HELPERS.filter((name) => typeof k[name] !== 'function');
		expect(missing).toEqual([]);
	});

	it('defines every global a scraper writes by name', () => {
		const missing = RUNTIME_GLOBALS.filter((name) => runtime.globals[name] === undefined);
		expect(missing).toEqual([]);
	});

	it('names nothing the contract does not', () => {
		// Not a rule against extra internals — those are prefixed `__` and live
		// outside `__k` — but `__k` itself is the published surface.
		const declared = new Set<string>(requiredRuntimeNames());
		expect(Object.keys(k).filter((name) => !declared.has(name))).toEqual([]);
	});

	it('offers nothing named javaClass, so the emitter has to refuse it', () => {
		// `javaClass.simpleName` appears in 54 files of the catalogue, almost
		// all of them to build a log tag. There is no class object here to ask,
		// and no honest answer to invent: a stub returning the emitted class
		// name would be right for a log tag and wrong for every other use of
		// reflection, and nothing distinguishes the two at runtime. So the
		// refusal belongs in the emitter, by name, at conversion time — and
		// this pins the runtime shut so that "just add a shim" cannot quietly
		// become the fix. Today the cost is one bundle that throws
		// `undefined is not an object` at load with nothing naming the cause.
		//
		// Asked of the CODE rather than of the whole text: a comment may name
		// the Kotlin it is about, and `__k.classLoader` has to — the chain it
		// answers is spelled `javaClass.classLoader` in half the catalogue, and
		// a test that forbids saying so forbids explaining the exemption beside
		// the thing it exempts.
		const source = kotlinRuntime()
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.replace(/(^|[^:])\/\/.*$/gm, '$1');
		expect(source).not.toContain('javaClass');
		expect(k.javaClass).toBeUndefined();
	});

	it('always emits the stdlib, because everything else assigns onto it', async () => {
		const only = await load(['models']);
		expect(typeof only.k.nn).toBe('function');
		expect(only.hasJsoup).toBe(false);
	});
});

describe('generic packed-script compatibility', () => {
	it('supports the one-argument helper and constructor spellings', () => {
		expect(k.unpack('packed')).toBe('decoded');
		expect(k.unpack('plain')).toBe('');
		expect(runtime.globals.Unpacker('packed').unpack()).toBe('decoded');
		expect(new runtime.globals.JsUnpacker('packed').unpack()).toBe('decoded');
	});

	it('refuses option-bearing unpackers instead of guessing', () => {
		expect(() => runtime.globals.Unpacker('packed').unpack('left', 'right')).toThrow(
			/Unpacker options/
		);
	});

	it('decodes standard radix tokens through the shared Unbaser', () => {
		const decoder = runtime.globals.Unbaser(62);
		expect(decoder.unbase('0')).toBe(0);
		expect(decoder.unbase('a')).toBe(10);
		expect(decoder.unbase('10')).toBe(62);
		expect(() => runtime.globals.Unbaser(61).unbase('!')).toThrow(/Unbaser digit/);
	});
});

describe('a response whose body the relay would not read', () => {
	it('answers where the redirect landed, and refuses the body by name', async () => {
		// How this ecosystem resolves a video link: fetch, follow, read the url
		// off the response and never touch the body. The relay caps what it will
		// buffer and the chain ends on the video, so that request used to fail
		// outright — throwing away the redirect it had already paid for over a
		// body nobody wanted.
		const { ctx } = context({
			'https://example.invalid/go': {
				status: 200,
				url: 'https://cdn.example.invalid/final.mp4',
				body: '',
				unread: 'too large'
			}
		});
		runtime.enter(ctx);

		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/go'))
			.execute();

		// okhttp's `response.request` is the request that produced the response,
		// which after a redirect is the last one — the whole point of the idiom.
		expect(response.request.url).toBe('https://cdn.example.invalid/final.mp4');
		expect(response.url).toBe('https://cdn.example.invalid/final.mp4');

		// And an extension that did want the body is told why, rather than being
		// handed an empty page it would parse into nothing.
		expect(() => response.body.string()).toThrow(/did not read/);
		expect(() => response.asJsoup()).toThrow(/did not read/);
	});
});

describe('what a jsoup selection says when read as a string', () => {
	it('answers its outer HTML, the way jsoup does', () => {
		const doc = runtime.globals.Jsoup.parse(
			"<html><body><script>html5player.setVideoUrlLow('/low.mp4');</script></body></html>"
		);
		const picked = doc.select('script');

		// `Elements` is a real Array here, so the list branch rendered every node
		// through String() — `[object Object]` — and an extension that reads a
		// script block as `select(...).toString()` then searched that text,
		// found nothing, and handed the whole of it back as a video url.
		const text = runtime.k.toStringOf(picked);
		expect(text).toContain('setVideoUrlLow');
		expect(text).not.toContain('[object Object]');

		// And the substringAfter that always follows it now finds its mark.
		expect(runtime.k.substringBefore(runtime.k.substringAfter(text, "UrlLow('"), "')")).toBe(
			'/low.mp4'
		);
	});

	it('still renders an ordinary list as a list', () => {
		expect(runtime.k.toStringOf([1, 2])).toBe('[1, 2]');
	});
});

describe('decoding, and which of two strings is the type', () => {
	it('decodes `"json".parseAs<T>()`, whose payload comes first', () => {
		// The emitter always writes the receiver first, so a parseAs on a STRING
		// arrives as (payload, type) while `Json.decodeFromString<T>(text)` — its
		// receiver dropped — arrives as (type, payload). Only the second order
		// was recognised, so every parseAs on a string read its own JSON as the
		// type name and then tried to parse the type name as JSON. It reported
		// "this source did not answer with JSON" about JSON it had in hand.
		const rows = runtime.k.decode('[{"file":"/a.mp4","label":"360p"}]', 'Array<GgVideo>');
		expect(Array.isArray(rows)).toBe(true);
		expect(rows[0].file).toBe('/a.mp4');
	});

	it('still decodes the receiver-dropped form, whose type comes first', () => {
		const rows = runtime.k.decode('List<Row>', '[{"file":"/b.mp4"}]');
		expect(rows[0].file).toBe('/b.mp4');
	});

	it('still says so when the payload really is not JSON', () => {
		expect(() => runtime.k.decode('<!DOCTYPE html><html></html>', 'Array<Row>')).toThrow(
			/did not answer with JSON/
		);
	});
});

describe('indexing and formatting, which Kotlin spells as calls', () => {
	it('reads `get(k)` off a list, a map and a string', () => {
		expect(runtime.k.getAt(['a', 'b'], 1)).toBe('b');
		expect(runtime.k.getAt(new Map([['k', 7]]), 'k')).toBe(7);
		// Kotlin's Map.get answers null for a key it does not have.
		expect(runtime.k.getAt(new Map(), 'nope')).toBeNull();
	});

	it('leaves a receiver that has a `get` of its own alone', () => {
		// okhttp's Headers and the preference shims spell `get` as a method, and
		// routing those through indexing would read a property that is not there.
		const headers = { get: (name: string) => `v:${name}` };
		expect(runtime.k.getAt(headers, 'Referer')).toBe('v:Referer');
	});

	it('formats the way `String.format` and `"%s".format` do', () => {
		expect(runtime.k.format(null, '%.0f', 3.6)).toBe('4');
		expect(runtime.k.format('%.1f', 2.25)).toBe('2.3');
		expect(runtime.k.format(null, 'S%02d', 7)).toBe('S07');
		expect(runtime.k.format('%s/%s', 'a', 'b')).toBe('a/b');
		// A Locale first argument is accepted and ignored.
		expect(runtime.k.format(null, { language: 'en' }, '%d%%', 50)).toBe('50%');
	});

	it('leaves a receiver that has a `format` of its own alone', () => {
		// `SimpleDateFormat.format(date)` is a real method on its shim.
		const formatter = { format: (value: number) => `date:${value}` };
		expect(runtime.k.format(formatter, 5)).toBe('date:5');
	});
});

describe('form encoding, which is not encodeURIComponent', () => {
	it('encodes the way java.net.URLEncoder does', () => {
		const encode = (value: string): string => runtime.globals.URLEncoder.encode(value, 'UTF-8');
		// The six disagreements, all of which appear in real query strings.
		expect(encode('a b')).toBe('a+b');
		expect(encode("!~'()")).toBe('%21%7E%27%28%29');
		// And the characters Java leaves alone, which are not the same set
		// `encodeURIComponent` leaves alone.
		expect(encode('a-b_c.d*e')).toBe('a-b_c.d*e');
		expect(encode('a/b?c=d&e')).toBe('a%2Fb%3Fc%3Dd%26e');
		// Non-ASCII is UTF-8 percent bytes, uppercase, as Java writes them.
		expect(encode('é')).toBe('%C3%A9');
	});

	it('round-trips through URLDecoder, with + as a space', () => {
		const encode = (value: string): string => runtime.globals.URLEncoder.encode(value, 'UTF-8');
		const decode = (value: string): string => runtime.globals.URLDecoder.decode(value, 'UTF-8');
		for (const value of ['a b', "!~'()", 'a/b?c=d&e', 'é', 'plain']) {
			expect(decode(encode(value))).toBe(value);
		}
		// A literal plus survives, which is why the + is undone before decoding
		// rather than after.
		expect(decode(encode('a+b'))).toBe('a+b');
	});

	it('refuses a charset it cannot honour rather than guessing', () => {
		// Encoding as UTF-8 when the extension asked for something else produces
		// a different string, and a signature computed over it is simply
		// rejected by the source.
		expect(() => runtime.globals.URLEncoder.encode('x', 'ISO-8859-1')).toThrow(/only has UTF-8/);
		// The usual spellings of UTF-8 are accepted.
		expect(runtime.globals.URLEncoder.encode('a b', 'utf8')).toBe('a+b');
	});
});

describe('the digests a request signature is built from', () => {
	// Published known-answer vectors. Bit-identity with the JVM is the whole
	// requirement: every use of these in this catalogue is a signature the
	// source checks, so an approximation is a request that gets refused.
	const hex = (bytes: number[]): string =>
		bytes.map((byte) => (byte < 16 ? '0' : '') + byte.toString(16)).join('');

	it('answers the published MD5 vectors', () => {
		const md5 = (value: string): string =>
			hex(runtime.globals.MessageDigest.getInstance('MD5').digest(value));
		expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
		expect(md5('The quick brown fox jumps over the lazy dog')).toBe(
			'9e107d9d372bb6826bd81d3542a419d6'
		);
	});

	it('answers the published SHA-1 vectors', () => {
		const sha1 = (value: string): string =>
			hex(runtime.globals.MessageDigest.getInstance('SHA-1').digest(value));
		expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
		expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
	});

	it('answers the published SHA-256 vectors', () => {
		const sha256 = (value: string): string =>
			hex(runtime.globals.MessageDigest.getInstance('SHA-256').digest(value));
		expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
	});

	it('answers unsigned bytes, because the caller spells them with %02x', () => {
		// A Kotlin ByteArray is signed, and `format` widens a negative number
		// rather than masking it — a signed -56 would print "ffffffc8" instead
		// of "c8" and silently corrupt every signature built from it.
		const bytes = runtime.globals.MessageDigest.getInstance('MD5').digest('abc');
		expect(Math.min(...bytes)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...bytes)).toBeLessThanOrEqual(255);
	});

	it('accumulates through update(), and reset() forgets', () => {
		const digest = runtime.globals.MessageDigest.getInstance('SHA-256');
		digest.update('a');
		digest.update('bc');
		expect(hex(digest.digest())).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);

		const other = runtime.globals.MessageDigest.getInstance('SHA-256');
		other.update('nonsense');
		other.reset();
		expect(hex(other.digest('abc'))).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
		);
	});

	it('refuses an algorithm it does not implement, rather than answering', () => {
		// `getInstance` in this ecosystem sits inside a runCatching that answers
		// null on failure. A throwable the extension can catch would read as
		// "the hash could not be computed" and let it carry on with an unsigned
		// request — so the refusal has to name what is missing.
		expect(() => runtime.globals.MessageDigest.getInstance('SHA-512')).toThrow(
			/does not implement/
		);
	});
});

describe('the pieces a vendored unbaser is built out of', () => {
	it('answers every index of a string or a list', () => {
		// Kotlin's `indices` has no JavaScript namesake, so before this it read
		// as a plain property and answered `undefined` — which converted, packaged
		// and installed, then handed `undefined` to whatever iterated it.
		expect(runtime.k.indices('abc')).toEqual([0, 1, 2]);
		expect(runtime.k.indices([9, 8])).toEqual([0, 1]);
		expect(runtime.k.indices('')).toEqual([]);
	});

	it('keys a map by the lambda, and by the item, and keeps real Maps', () => {
		const byKey = runtime.k.associateBy(['ab', 'cd'], (word: string) => word[0]);
		expect(byKey).toBeInstanceOf(Map);
		expect(byKey.get('a')).toBe('ab');
		expect(byKey.get('c')).toBe('cd');

		const withValue = runtime.k.associateWith([1, 2], (n: number) => n * 10);
		expect(withValue.get(2)).toBe(20);
	});

	it('raises a number to a power the way `kotlin.math` does', () => {
		expect(runtime.k.pow(62, 0)).toBe(1);
		expect(runtime.k.pow(62, 2)).toBe(3844);
	});

	it('builds the char-to-digit table the vendored Unbaser builds', () => {
		// The exact expression at Unbaser.kt:19, which is what a base-62
		// unbaser's every digit lookup goes through.
		const alphabet = '0123456789abcdef';
		const table = runtime.k.associateBy(runtime.k.indices(alphabet), (at: number) => alphabet[at]);
		expect(table.get('0')).toBe(0);
		expect(table.get('a')).toBe(10);
		expect(table.get('f')).toBe(15);
	});
});

/* ── null, numbers ────────────────────────────────────────────────────────── */

describe('Kotlin null and Kotlin numbers', () => {
	it('wraps numeric conversions as signed Kotlin Bytes', () => {
		expect(k.toByte(127.9)).toBe(127);
		expect(k.toByte(128)).toBe(-128);
		expect(k.toByte(-129)).toBe(127);
		expect(() => k.toByte(Number.NaN)).toThrow(/non-finite/);
	});

	it('throws from !! and names the expression', () => {
		expect(() => k.nn(null, 'document.selectFirst("div.title")')).toThrow(
			/document\.selectFirst\("div\.title"\)/
		);
		// undefined is Kotlin's null here: a JavaScript property that was never
		// set arrives as undefined, and yielding it would be the silent bug.
		expect(() => k.nn(undefined, 'thumbnail')).toThrow(/thumbnail/);
		expect(k.nn(0, 'zero')).toBe(0);
		expect(k.nn('', 'empty')).toBe('');
	});

	it('refuses a non-number where Kotlin would throw', () => {
		expect(k.toIntOrNull('abc')).toBeNull();
		expect(k.toIntOrNull('12abc')).toBeNull();
		expect(k.toIntOrNull('')).toBeNull();
		expect(k.toIntOrNull(' 42 ')).toBe(42);
		expect(() => k.toInt('abc')).toThrow(/is not one/);
		// The NaN that must never leak: Number('abc') is silently NaN.
		expect(Number.isNaN(k.toIntOrNull('abc') as number)).toBe(false);
	});

	it('reads a float only where one is written', () => {
		expect(k.toFloatOrNull('7.5')).toBe(7.5);
		expect(k.toFloatOrNull('.5')).toBe(0.5);
		expect(k.toFloatOrNull('1e3')).toBe(1000);
		expect(k.toFloatOrNull('7,5')).toBeNull();
		expect(() => k.toFloat('n/a')).toThrow();
	});

	it('refuses a Long a double cannot carry', () => {
		expect(k.toLongOrNull('1700000000000')).toBe(1700000000000);
		expect(k.toLongOrNull('123456789012345678901')).toBeNull();
	});

	it('truncates Int division toward zero, in both directions', () => {
		expect(k.intDiv(7, 2)).toBe(3);
		// The one JavaScript gets wrong twice: -3.5 floors to -4.
		expect(k.intDiv(-7, 2)).toBe(-3);
		expect(k.intDiv(7, -2)).toBe(-3);
		expect(() => k.intDiv(1, 0)).toThrow(/divided by zero/);
	});
});

/* ── strings ──────────────────────────────────────────────────────────────── */

describe('the string helpers, at their edges', () => {
	it('returns the whole string when the delimiter is absent', () => {
		// The contract no JavaScript builtin has, and the one that silently
		// empties a title when a site changes its separator.
		expect(k.substringAfter('one/two', '?')).toBe('one/two');
		expect(k.substringBefore('one/two', '?')).toBe('one/two');
		expect(k.substringAfterLast('one/two', '?')).toBe('one/two');
		expect(k.substringBeforeLast('one/two', '?')).toBe('one/two');
		// An explicit missing-delimiter value replaces it, and '' is a value.
		expect(k.substringAfter('one/two', '?', '')).toBe('');
	});

	it('splits on the right side of the right occurrence', () => {
		expect(k.substringAfter('a/b/c', '/')).toBe('b/c');
		expect(k.substringAfterLast('a/b/c', '/')).toBe('c');
		expect(k.substringBefore('a/b/c', '/')).toBe('a');
		expect(k.substringBeforeLast('a/b/c', '/')).toBe('a/b');
	});

	it('strips a prefix, a suffix, or both or neither', () => {
		expect(k.removePrefix('/anime/one', '/')).toBe('anime/one');
		expect(k.removePrefix('anime/one', '/')).toBe('anime/one');
		expect(k.removeSuffix('one/', '/')).toBe('one');
		expect(k.removeSurrounding('"one"', '"')).toBe('one');
		expect(k.removeSurrounding('"one', '"')).toBe('"one');
		expect(k.removeSurrounding('(one)', '(', ')')).toBe('one');
	});

	it('replaces every occurrence, not the first', () => {
		// JavaScript's String.replace does the first; Kotlin's does all, and the
		// difference is a wrong url rather than an error.
		expect(k.replaceString('a-b-c', '-', '_')).toBe('a_b_c');
		expect(k.replaceString('a.b.c', '.', '/')).toBe('a/b/c');
		expect(k.replaceString(null, 'x', 'y')).toBe('');
	});

	it('splits on any of several literal delimiters', () => {
		expect(k.split('a, b;c', ', ', ';')).toEqual(['a', 'b', 'c']);
		expect(k.split('one', ',')).toEqual(['one']);
		expect(k.split('a1b2c', k.regex('[0-9]'))).toEqual(['a', 'b', 'c']);
	});

	it('treats an empty attribute and a missing one alike', () => {
		// jsoup answers '' where the Kotlin reads `attr("x").ifEmpty { null }`.
		expect(k.ifEmpty('', () => null)).toBeNull();
		expect(k.ifEmpty(undefined, () => null)).toBeNull();
		expect(k.ifEmpty('value', () => null)).toBe('value');
		expect(k.ifBlank('   ', () => 'fallback')).toBe('fallback');
		expect(k.isNullOrEmpty(null)).toBe(true);
		expect(k.isNullOrBlank(' \t ')).toBe(true);
		expect(k.isBlank(null)).toBe(true);
		expect(k.isNotBlank('x')).toBe(true);
		expect(k.isEmpty([])).toBe(true);
		expect(k.isNotEmpty(['a'])).toBe(true);
	});

	it('answers `in` over a string, a list, a set and a regex', () => {
		expect(k.contains('Episode 12', 'pisode')).toBe(true);
		expect(k.contains('Episode 12', 'EPISODE', true)).toBe(true);
		expect(k.contains(['a', 'b'], 'b')).toBe(true);
		expect(k.contains(k.toSet(['a']), 'a')).toBe(true);
		expect(k.contains('sub-1080p', k.regex('[0-9]{3,4}p'))).toBe(true);
		expect(k.contains(null, 'x')).toBe(false);
	});

	it('prints a null as Kotlin prints it', () => {
		expect(k.toStringOf(null)).toBe('null');
		expect(k.toStringOf(['a', 'b'])).toBe('[a, b]');
		expect(k.toStringOf(12)).toBe('12');
	});

	it('trims whitespace, a character set, or by predicate', () => {
		expect(k.trim('  x  ')).toBe('x');
		expect(k.trim('--x--', '-')).toBe('x');
		expect(k.trim('12x21', (ch: string) => /[0-9]/.test(ch))).toBe('x');
	});

	it('undents a raw string the way trimIndent does', () => {
		const raw = '\n\t\tquery {\n\t\t\tid\n\t\t}\n\t';
		expect(k.trimIndent(raw)).toBe('query {\n\tid\n}');
	});

	it('pads and cases without reaching for Intl', () => {
		expect(k.padStart('7', 2, '0')).toBe('07');
		expect(k.lowercase('HD')).toBe('hd');
		expect(k.uppercase('hd')).toBe('HD');
		expect(k.startsWith('/anime/one', '/')).toBe(true);
		expect(k.endsWith('a.m3u8', '.m3u8')).toBe(true);
	});
});

/* ── collections, sync and suspending ─────────────────────────────────────── */

describe('the collection helpers', () => {
	it('drops null AND undefined from mapNotNull', () => {
		const out = k.mapNotNull([1, 2, 3, 4], (n: number) => {
			if (n === 2) return null;
			// A Kotlin `if` with no else is Unit, which arrives here as undefined.
			if (n === 3) return undefined;
			return n * 10;
		});
		expect(out).toEqual([10, 40]);
	});

	it('joins with a separator, a prefix and a transform', () => {
		expect(k.joinToString(['a', 'b'], ', ')).toBe('a, b');
		expect(k.joinToString(['a', 'b'])).toBe('a, b');
		expect(k.joinToString([1, 2], '-', (n: number) => `#${n}`)).toBe('#1-#2');
		// The transform alone, with the default separator: all four overloads
		// reach one helper, and only the argument shapes tell them apart.
		expect(k.joinToString([1, 2], (n: number) => `#${n}`)).toBe('#1, #2');
		expect(k.joinToString(['a'], { separator: ',', prefix: '[', postfix: ']' })).toBe('[a]');
	});

	it('sorts stably and reverses', () => {
		const rows = [
			{ n: 2, tag: 'a' },
			{ n: 1, tag: 'b' },
			{ n: 2, tag: 'c' }
		];
		expect(k.sortedBy(rows, (r: { n: number }) => r.n).map((r: { tag: string }) => r.tag)).toEqual([
			'b',
			'a',
			'c'
		]);
		expect(k.reversed([1, 2, 3])).toEqual([3, 2, 1]);
		// reversed() must not mutate: the episode list is read again after it.
		const source = [1, 2, 3];
		k.reversed(source);
		expect(source).toEqual([1, 2, 3]);
	});

	it('covers the rest of the list surface', () => {
		expect(k.firstOrNull([])).toBeNull();
		expect(k.first([1, 2])).toBe(1);
		expect(() => k.first([])).toThrow(/empty list/);
		expect(k.lastOrNull([1, 2])).toBe(2);
		expect(k.last([1, 2])).toBe(2);
		expect(k.find([1, 2, 3], (n: number) => n > 1)).toBe(2);
		expect(k.indexOfFirst([1, 2], (n: number) => n === 2)).toBe(1);
		expect(k.any([1], (n: number) => n === 1)).toBe(true);
		expect(k.all([1, 2], (n: number) => n > 0)).toBe(true);
		expect(k.none([1], (n: number) => n === 2)).toBe(true);
		expect(k.distinct([1, 1, 2])).toEqual([1, 2]);
		expect(k.take([1, 2, 3], 2)).toEqual([1, 2]);
		expect(k.drop([1, 2, 3], 2)).toEqual([3]);
		expect(k.count([1, 2, 3], (n: number) => n > 1)).toBe(2);
		expect(k.sumOf([1, 2], (n: number) => n)).toBe(3);
		expect(k.chunked([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
		expect(k.plus([1], 2)).toEqual([1, 2]);
		expect(k.plus([1], [2, 3])).toEqual([1, 2, 3]);
		expect(k.listOfNotNull(1, null, undefined, 2)).toEqual([1, 2]);
		expect(k.emptyList()).toEqual([]);
		expect(k.toList(new Set([1, 2]))).toEqual([1, 2]);
		expect(k.toSet([1, 1]).contains(1)).toBe(true);
		expect(k.filterNot([1, 2], (n: number) => n === 1)).toEqual([2]);
		expect(k.flatMap([[1], [2, 3]], (row: number[]) => row)).toEqual([1, 2, 3]);
	});

	it('reads an IndexedValue positionally and by name', () => {
		const [entry] = k.withIndex(['a']);
		expect(entry.index).toBe(0);
		expect(entry.value).toBe('a');
		const [index, value] = entry;
		expect([index, value]).toEqual([0, 'a']);
	});

	it('groups and associates into a Map', () => {
		const grouped = k.groupBy([1, 2, 3], (n: number) => n % 2);
		expect(grouped.get(1)).toEqual([1, 3]);
		const associated = k.associate([1, 2], (n: number) => [n, n * 2]);
		expect(associated.get(2)).toBe(4);
	});

	it('zips into a pair readable both ways', () => {
		const [pair] = k.zip(['a'], [1]);
		expect(pair.first).toBe('a');
		expect(pair[1]).toBe(1);
		expect(k.zip(['a'], [1], (x: string, n: number) => x + n)).toEqual(['a1']);
	});
});

describe('a suspending lambda handed to a collection helper', () => {
	// The transpiler turns `suspend fun` into `async function`, so any of these
	// may be given a promise. A helper that ignored that would compare a
	// Promise for truthiness — always true — and filter nothing.
	it('is awaited by map, mapNotNull and flatMap', async () => {
		expect(await k.map([1, 2], async (n: number) => n * 2)).toEqual([2, 4]);
		expect(await k.mapNotNull([1, 2], async (n: number) => (n === 1 ? null : n))).toEqual([2]);
		expect(await k.flatMap([1], async (n: number) => [n, n])).toEqual([1, 1]);
	});

	it('does not let filter judge a Promise for truthiness', async () => {
		const out = await k.filter([1, 2, 3], async (n: number) => n > 2);
		expect(out).toEqual([3]);
		expect(await k.filterNot([1, 2], async (n: number) => n === 1)).toEqual([2]);
	});

	it('is awaited by forEach, and by the predicate helpers', async () => {
		const seen: number[] = [];
		await k.forEach([1, 2], async (n: number) => {
			seen.push(n);
		});
		expect(seen).toEqual([1, 2]);
		expect(await k.any([1, 2], async (n: number) => n === 2)).toBe(true);
		expect(await k.all([1], async (n: number) => n === 1)).toBe(true);
		expect(await k.firstOrNull([1, 2], async (n: number) => n === 2)).toBe(2);
		expect(await k.sortedBy([2, 1], async (n: number) => n)).toEqual([1, 2]);
		expect(await k.joinToString([1, 2], '-', async (n: number) => String(n))).toBe('1-2');
	});

	it('stays synchronous when the lambda is', () => {
		// The other half of the contract: a synchronous lambda must NOT infect
		// the caller with a promise, or the async taint spreads back into the
		// emitted code this design exists to keep clean.
		expect(Array.isArray(k.map([1], (n: number) => n))).toBe(true);
		expect(Array.isArray(k.filter([1], (n: number) => n === 1))).toBe(true);
	});
});

/* ── scope functions and coroutines ───────────────────────────────────────── */

describe('the scope functions', () => {
	it('returns the receiver from apply and also, the lambda from let and run', () => {
		const anime = runtime.globals.SAnime.create();
		const applied = k.apply(anime, (it: { title: string }) => {
			it.title = 'One';
		});
		expect(applied).toBe(anime);
		expect(applied.title).toBe('One');
		expect(k.let('x', (it: string) => it + 'y')).toBe('xy');
		expect(k.run(2, (it: number) => it * 2)).toBe(4);
		expect(k.also([1], (it: number[]) => it.push(2))).toEqual([1, 2]);
	});

	it('awaits a suspending apply before handing back the receiver', async () => {
		const built = await k.apply({ title: '' }, async (it: { title: string }) => {
			it.title = 'later';
		});
		expect(built.title).toBe('later');
	});

	it('answers null from takeIf and takeUnless rather than false', () => {
		expect(k.takeIf('x', (it: string) => it.length > 0)).toBe('x');
		expect(k.takeIf('', (it: string) => it.length > 0)).toBeNull();
		expect(k.takeUnless('x', (it: string) => it.length > 0)).toBeNull();
	});

	it('turns a throw into a Result, synchronously and asynchronously', async () => {
		const failed = k.runCatching(() => {
			throw new Error('nope');
		});
		expect(failed.isFailure).toBe(true);
		expect(failed.getOrNull()).toBeNull();
		expect(failed.getOrElse(() => 'fallback')).toBe('fallback');
		expect(k.runCatching(() => 1).getOrThrow()).toBe(1);

		const suspended = await k.runCatching(async () => {
			throw new Error('later');
		});
		expect(suspended.isFailure).toBe(true);
		expect(suspended.exceptionOrNull().message).toBe('later');
	});

	it('flattens async/await into promises', async () => {
		const one = k.async(() => 1);
		const two = k.async(async () => 2);
		expect(await k.awaitAll([one, two])).toEqual([1, 2]);
		expect(await one.await()).toBe(1);
	});

	it('throws by name for a member the extension never implemented', () => {
		// 134 of 254 extensions throw UnsupportedOperationException from a
		// declared member. Returning undefined instead would look like a source
		// with an empty shelf rather than one that never offered it.
		expect(() => k.unsupported('Not used')).toThrow(/Not used/);
		expect(() => k.unsupported()).toThrow(/does not implement/);
	});
});

/* ── one call site, two receivers ─────────────────────────────────────────── */

describe('the helpers that must dispatch on their receiver', () => {
	// The emitter has no types. `list.find { }` and `regex.find(s)` reach the
	// same helper, and so do `"s".contains(x)` and `list.contains(x)`: the
	// runtime is the only thing left that can tell them apart.
	it('finds an element, or a match, depending on what it was given', () => {
		expect(k.find([1, 2, 3], (n: number) => n > 1)).toBe(2);
		expect(k.find(k.regex('e(\\d+)'), 'e12')?.groupValues[1]).toBe('12');
		expect(k.find(k.regex('x'), 'e12')).toBeNull();
	});

	it('replaces through a string receiver or a regex one', () => {
		expect(k.replaceString('a-b-c', '-', '_')).toBe('a_b_c');
		expect(k.replaceString(k.regex('[0-9]+'), 'e1 e2', 'x')).toBe('ex ex');
		expect(k.replaceString('e1 e2', k.regex('[0-9]+'), 'x')).toBe('ex ex');
	});

	it('answers `in` for a string, a list, a map and a regex receiver', () => {
		expect(k.contains('abc', 'b')).toBe(true);
		expect(k.contains(['a'], 'a')).toBe(true);
		expect(k.contains(k.mapOf(k.to('a', 1)), 'a')).toBe(true);
		expect(k.contains(k.regex('[0-9]'), 'e1')).toBe(true);
	});

	it('destructures a match, a pair, a data class and a list', () => {
		const [first, second] = k.destructured(k.regex('(a)(b)').find('ab'));
		expect([first, second]).toEqual(['a', 'b']);
		expect(k.destructured(k.to('x', 1))).toEqual(['x', 1]);
		// A translated data class is a plain object: components come out in
		// declaration order, which is the order the properties were assigned.
		expect(k.destructured({ url: '/one', title: 'One' })).toEqual(['/one', 'One']);
		expect(k.destructured([1, 2])).toEqual([1, 2]);
		expect(k.destructured(null)).toEqual([]);
	});

	it('adds to a collection or to a builder', () => {
		const list = k.mutableListOf(1);
		expect(k.add(list, 2)).toBe(true);
		expect(list).toEqual([1, 2]);
		const builder = runtime.globals.Headers.Builder();
		// A builder returns itself, so the chain the Kotlin wrote keeps working.
		expect(k.add(builder, 'Referer', 'https://example.invalid/')).toBe(builder);
		expect(builder.build().get('referer')).toBe('https://example.invalid/');
	});

	it('reads a body through the shorthand, whatever it is handed', async () => {
		const { ctx } = context({ 'https://example.invalid/x': { body: 'hello' } });
		runtime.enter(ctx);
		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/x'))
			.execute();
		expect(k.bodyString(response)).toBe('hello');
		expect(k.bodyString(response.body)).toBe('hello');
		expect(k.bodyString('already text')).toBe('already text');
		expect(k.bodyString(null)).toBe('');
	});

	it('answers orEmpty with a value that reads as both empty things', () => {
		expect(k.orEmpty('x')).toBe('x');
		expect(k.orEmpty(null)).toBe('');
		// The emitter cannot say whether a String or a List was wanted, so the
		// one empty value has to serve as both: '' must iterate as no elements,
		// not as one empty element.
		expect(k.map(k.orEmpty(null), (x: string) => x)).toEqual([]);
		expect(k.joinToString(k.orEmpty(undefined), ',')).toBe('');
		expect(k.size(k.orEmpty(null))).toBe(0);
	});
});

describe('one dead mirror must not lose the page', () => {
	// `parallelCatchingFlatMapBlocking` is how this ecosystem resolves several
	// mirrors at once. Collapsing it onto flatMap would turn a partial result
	// into no result, which reads to a viewer as a source that is down.
	it('skips the element whose lambda threw, and keeps the rest', () => {
		const out = k.catchingMap(['a', 'b', 'c'], (m: string) => {
			if (m === 'b') throw new Error('this mirror is gone');
			return m.toUpperCase();
		});
		expect(out).toEqual(['A', 'C']);
	});

	it('skips a rejected promise too, which is how a suspending one fails', async () => {
		const out = await k.catchingFlatMap(['a', 'b'], async (m: string) => {
			if (m === 'b') throw new Error('404');
			return [m, m];
		});
		expect(out).toEqual(['a', 'a']);
	});

	it('flattens one level and drops a null result', () => {
		expect(k.catchingFlatMap([1, 2], (n: number) => (n === 1 ? [n] : null))).toEqual([1]);
		expect(k.catchingMap([1], (n: number) => n)).toEqual([1]);
	});
});

/* ── properties, types, ranges ────────────────────────────────────────────── */

describe('the parts of Kotlin that have no JavaScript spelling', () => {
	it('runs a val initialiser once, however often it is read', () => {
		// A getter would run per read, and `val client = ...build()` read twice
		// would be two clients rather than one.
		//
		// The shape matters as much as the memoising. `emit.ts` writes
		// `get x() { return __k.lazy(this, "x", () => …); }` and this helper took
		// a single argument — the old delegate contract, which answered a reader
		// FUNCTION. The instance bound to `initialiser`, the thunk was dropped,
		// and every lazy property evaluated to a function instead of its value.
		// A source whose `private val apiHeaders = headers.newBuilder()…build()`
		// is lazy this way then passed that function to `GET()`, and every
		// request went out with no headers at all, silently.
		//
		// It survived because each side had its own test: this file exercised the
		// one-argument contract nobody emitted, and `emit.spec.ts`'s stub
		// implemented the three-argument one nobody had written here.
		expect(k.lazy.length).toBe(3);

		let built = 0;
		const owner: Record<string, unknown> = {};
		const read = (): { id: number } =>
			k.lazy(owner, 'value', () => {
				built += 1;
				return { id: built };
			});

		expect(read().id).toBe(1);
		expect(read().id).toBe(1);
		expect(built).toBe(1);

		// Per instance, because a Kotlin val belongs to its object.
		const other: Record<string, unknown> = {};
		expect(k.lazy(other, 'value', () => ({ id: 99 })).id).toBe(99);
		expect(read().id).toBe(1);
	});

	it('safe-calls a helper without evaluating the receiver twice', () => {
		let reads = 0;
		const receiver = (): string => {
			reads += 1;
			return 'a/b';
		};
		expect(k.sc(receiver(), (it: string) => k.substringAfter(it, '/'))).toBe('b');
		expect(reads).toBe(1);
		expect(k.sc(null, (it: string) => it.length)).toBeNull();
		// The receiver-first shape, for a helper passed by name.
		expect(k.sc('a/b', k.substringAfter, '/')).toBe('b');
	});

	it('decides the types it can and lets the rest through', () => {
		expect(k.isType('x', 'String')).toBe(true);
		expect(k.isType(1, 'String')).toBe(false);
		expect(k.isType([1], 'List')).toBe(true);
		expect(k.cast('x', 'String')).toBe('x');
		expect(() => k.cast(1, 'String')).toThrow(/was not one/);
		expect(k.castOrNull(1, 'String')).toBeNull();
		// A data class has no runtime existence after translation, so a cast to
		// one passes through: the Kotlin compiler already proved it.
		const row = { id: 1 };
		expect(k.cast(row, 'EpisodeDto')).toBe(row);
		expect(k.castOrNull(row, 'EpisodeDto')).toBe(row);
	});

	it('filters by a type it models, and passes an unknown one through', () => {
		const anime = runtime.globals.SAnime.create();
		const episode = runtime.globals.SEpisode.create();
		const video = runtime.globals.Video('https://example.invalid/a.mp4', 'HD');
		const mixed = [anime, episode, video, 'loose'];

		expect(k.filterIsInstance(mixed, 'SAnime')).toEqual([anime]);
		expect(k.filterIsInstance(mixed, 'SEpisode')).toEqual([episode]);
		expect(k.filterIsInstance(mixed, 'Video')).toEqual([video]);
		expect(k.filterIsInstance(mixed, 'String')).toEqual(['loose']);
		// A custom filter class is most of them, and the Kotlin compiler already
		// knew what was in that list — emptying it here would be a guess.
		expect(k.filterIsInstance(mixed, 'GenreFilter')).toHaveLength(4);
	});

	it('accumulates a built string instead of appending to an immutable one', () => {
		const built = k.buildString(
			(sb: { append(v: string): unknown; appendLine(v: string): unknown }) => {
				sb.append('a=1');
				sb.append('&');
				sb.appendLine('b=2');
			}
		);
		expect(built).toBe('a=1&b=2\n');
		expect(k.buildString(() => {})).toBe('');
	});

	it('awaits a suspending buildString block before joining', async () => {
		const built = await k.buildString(async (sb: { append(v: string): unknown }) => {
			sb.append('one');
			await Promise.resolve();
			sb.append('-two');
		});
		expect(built).toBe('one-two');
	});

	it('builds the collections Kotlin builds', () => {
		expect(k.listOf(1, 2)).toEqual([1, 2]);
		const list = k.mutableListOf(1);
		list.add(2);
		list.addAll([3]);
		expect(list).toEqual([1, 2, 3]);
		expect(Array.isArray(list)).toBe(true);

		const map = k.mapOf(k.to('a', 1), ['b', 2]);
		expect(map.get('a')).toBe(1);
		map.put('c', 3);
		expect(map.containsKey('c')).toBe(true);

		const set = k.setOf(1, 1, 2);
		k.add(set, 3);
		expect(k.size(set)).toBe(3);
		expect(k.size('abc')).toBe(3);
		expect(k.size(null)).toBe(0);
		expect(k.addAll(list, [4])).toBe(true);
	});

	it('flattens, indexes and reads a missing index as null', () => {
		expect(k.flatten([[1], [2, 3]])).toEqual([1, 2, 3]);
		// Kotlin passes the index FIRST, which is the opposite of Array.map.
		expect(k.mapIndexed(['a', 'b'], (index: number, item: string) => `${index}${item}`)).toEqual([
			'0a',
			'1b'
		]);
		expect(k.getOrNull([1, 2], 5)).toBeNull();
		expect(k.getOrNull([1, 2], 1)).toBe(2);
		expect(k.getOrDefault(k.mapOf(k.to('a', 1)), 'b', 0)).toBe(0);
		expect(k.getOrElse([1], 4, () => 'fallback')).toBe('fallback');
		const pair = k.to('a', 1);
		expect([pair.first, pair[1]]).toEqual(['a', 1]);
	});

	it('makes a range a list, inclusive or not', () => {
		expect(k.range(1, 3)).toEqual([1, 2, 3]);
		expect(k.until(0, 3)).toEqual([0, 1, 2]);
		expect(k.downTo(3, 1)).toEqual([3, 2, 1]);
		// Kotlin's 1..0 is empty, not a countdown.
		expect(k.range(1, 0)).toEqual([]);
	});

	it('strides a progression with `step`, and refuses a step that is not positive', () => {
		expect(k.step(k.until(0, 7), 2)).toEqual([0, 2, 4, 6]);
		expect(k.step(k.range(1, 10), 3)).toEqual([1, 4, 7, 10]);
		expect(k.step(k.downTo(10, 1), 3)).toEqual([10, 7, 4, 1]);
		expect(k.step(k.until(0, 0), 2)).toEqual([]);
		expect(() => k.step(k.until(0, 4), 0)).toThrow(/positive/);
	});

	it('reads the infix `matches` from whichever side holds the Regex', () => {
		expect(k.regexMatches(k.regex('a+'), 'aaa')).toBe(true);
		expect(k.regexMatches('aaa', k.regex('a+'))).toBe(true);
		// Whole-input, not a search.
		expect(k.regexMatches(k.regex('a+'), 'baaa')).toBe(false);
	});

	it('keeps named integer bitwise operations explicit', () => {
		expect(k.bitwiseAnd(6, 3)).toBe(2);
	});

	it('throws from error(), and awaits a call', async () => {
		expect(() => k.error('the episode list selector returned nothing')).toThrow(/selector/);
		expect(await k.await(Promise.resolve(1))).toBe(1);
		expect(await k.await({ await: async () => 2 })).toBe(2);
	});
});

describe('a `@Serializable` class, which is a shape as well as a class', () => {
	class Item {
		image: string;
		key: string | null;
		title: string;
		contxt: string;
		constructor(image: string, key: string | null, title: string, contxt: string) {
			this.image = image;
			this.key = key;
			this.title = title;
			this.contxt = contxt;
		}
		get vid(): string {
			return this.key ?? this.contxt;
		}
	}

	it('gives a decoded record the names and the getters its class declared', async () => {
		// The decoder answers plain JSON, deliberately. Two things do not survive
		// it: a `@JsonNames("imgPath")` rename, and a computed
		// `val vid get() = key ?: contxt`. Both are silent — one extension
		// reported 32 search results whose every id was `undefined`.
		const built = await load();
		built.k.shape(Item, ['image', 'key', 'title', 'contxt'], ['key'], {
			imgPath: 'image'
		});

		const decoded = built.k.decode('{"list":[{"imgPath":"i","title":"T","contxt":"C"}]}', 'Any');
		const row = decoded.list[0];

		// The alias is added beside the key it renames; nothing is taken away.
		expect(row.image).toBe('i');
		expect(row.imgPath).toBe('i');
		// And the getter the class declares now answers.
		expect(row.vid).toBe('C');
	});

	it('leaves a record alone when two shapes could claim it', async () => {
		// A wrong prototype is worse than none: it would answer a getter with a
		// value computed from another class's fields. Exactly one match, or the
		// record stays exactly as the JSON had it.
		class Other {
			title = '';
			contxt = '';
		}
		const built = await load();
		built.k.shape(Item, ['title', 'contxt'], [], {});
		built.k.shape(Other, ['title', 'contxt'], [], {});

		const row = built.k.decode('{"title":"T","contxt":"C"}', 'Any');

		expect(row.vid).toBeUndefined();
		expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
	});
});

describe('okhttp Headers, which is a sequence as well as a record', () => {
	it('walks as name/value pairs, and still reads as a record', async () => {
		// `for (cookie in response.headers)` is how a session cookie is collected
		// off a first request, and okhttp's Headers is a Sequence of Pairs. A
		// plain record is not iterable, so that was `{} is not iterable` on the
		// first search.
		const headers = runtime.globals.Headers.Builder()
			.add('Set-Cookie', 'a=1')
			.add('Content-Type', 'text/html')
			.build();

		const walked: string[] = [];
		for (const pair of headers as Iterable<{ first: string; second: string }>) {
			walked.push(`${pair.first}=${pair.second}`);
		}

		expect(walked).toEqual(['Set-Cookie=a=1', 'Content-Type=text/html']);
		// And the record reading it already had, unchanged: the iterator and the
		// three methods are non-enumerable, so spreading one still gives headers.
		expect(headers['Content-Type']).toBe('text/html');
		expect(headers.get('set-cookie')).toBe('a=1');
		expect(Object.keys({ ...headers })).toEqual(['Set-Cookie', 'Content-Type']);
	});
});

describe('org.json, whose values are plain here', () => {
	it('parses an object, an array, and either through a tokener', () => {
		expect(runtime.k.jsonObject('{"a":1}')).toEqual({ a: 1 });
		expect(runtime.k.jsonArray('[1,2]')).toEqual([1, 2]);
		// A tokener is what an extension reaches for when the response may be
		// either shape, and `parsed !is JSONObject` is what decides.
		expect(runtime.k.jsonTokener('[1]').nextValue()).toEqual([1]);
		expect(runtime.k.jsonTokener('{"a":1}').nextValue()).toEqual({ a: 1 });
		expect(runtime.k.isType(runtime.k.jsonTokener('[1]').nextValue(), 'JSONObject')).toBe(false);
		expect(runtime.k.isType(runtime.k.jsonTokener('{}').nextValue(), 'JSONObject')).toBe(true);
	});

	it('throws on text that is not JSON, rather than answering undefined', () => {
		// The response that reaches one of these is often an HTML error page, and
		// carrying an undefined out of it puts an empty episode list on screen
		// with nothing anywhere saying the read failed.
		expect(() => runtime.k.jsonObject('<html>')).toThrow(/could not read a response as JSON/);
		expect(() => runtime.k.jsonObject('[1]')).toThrow(/not a JSON object/);
	});

	it('answers the fallback from every `opt` reader', () => {
		const json = {
			name: 'Show',
			count: 3,
			ratio: 1.5,
			ok: 'true',
			nested: {},
			list: [1]
		};
		expect(runtime.k.optString(json, 'name')).toBe('Show');
		expect(runtime.k.optString(json, 'absent')).toBe('');
		expect(runtime.k.optString(json, 'absent', 'x')).toBe('x');
		// org.json coerces rather than answering the fallback for a number.
		expect(runtime.k.optString(json, 'count')).toBe('3');
		expect(runtime.k.optInt(json, 'ratio')).toBe(1);
		expect(runtime.k.optInt(json, 'absent', 7)).toBe(7);
		expect(runtime.k.optDouble(json, 'ratio')).toBe(1.5);
		expect(runtime.k.optBoolean(json, 'ok')).toBe(true);
		expect(runtime.k.optBoolean(json, 'absent')).toBe(false);
		expect(runtime.k.optJSONObject(json, 'nested')).toEqual({});
		// A value of the wrong kind is null, not the value.
		expect(runtime.k.optJSONObject(json, 'list')).toBeNull();
		expect(runtime.k.optJSONArray(json, 'list')).toEqual([1]);
		expect(runtime.k.optJSONArray(json, 'nested')).toBeNull();
	});

	it('throws from every `get` reader, which is why an extension writes one', () => {
		const json = { url: 'https://example.invalid/v', n: 2, list: [{ a: 1 }] };
		expect(runtime.k.jsonGetString(json, 'url')).toBe('https://example.invalid/v');
		expect(runtime.k.jsonGetInt(json, 'n')).toBe(2);
		expect(() => runtime.k.jsonGetString(json, 'absent')).toThrow(/required JSON field/);
		expect(() => runtime.k.getJSONObject(json, 'absent')).toThrow(/asked for a JSON object/);
		expect(() => runtime.k.getJSONArray(json, 'url')).toThrow(/asked for a JSON array/);
		// `arr.getJSONObject(i)` is the same read, indexed.
		expect(runtime.k.getJSONObject(json.list, 0)).toEqual({ a: 1 });
	});

	it('counts and names, the way `length()` and `keys()` are looped over', () => {
		expect(runtime.k.jsonLength([1, 2, 3])).toBe(3);
		expect(runtime.k.jsonLength({ a: 1, b: 2 })).toBe(2);
		expect(runtime.k.jsonLength(null)).toBe(0);
		// An array rather than an iterator: both `for (k in obj.keys())` and
		// `obj.keys().forEach { … }` reach for this, and only one of them works
		// against a JavaScript iterator.
		expect(runtime.k.jsonKeys({ a: 1, b: 2 })).toEqual(['a', 'b']);
		expect(runtime.k.jsonHas({ a: null }, 'a')).toBe(false);
		expect(runtime.k.jsonHas({ a: 1 }, 'a')).toBe(true);
	});
});

describe('decodeToString, which is a decode and not a stringify', () => {
	it('decodes a whole byte array, and a range of one', () => {
		const bytes = new TextEncoder().encode('#EXTM3U\nrest');
		expect(runtime.k.decodeToString(bytes)).toBe('#EXTM3U\nrest');
		// The range form is what tells a playlist from a video, and decoding the
		// whole array there answers false for every playlist.
		expect(runtime.k.decodeToString(bytes, 0, 7)).toBe('#EXTM3U');
	});
});

describe('the long tail, each of which refused an extension by name', () => {
	it('reads an HttpUrl as java.net.URL spells it', () => {
		// `response.request.url.toUrl()` then reads `protocol` and `host` to
		// rebuild an origin. okhttp says `scheme` for the same thing, so passing
		// the HttpUrl through built `undefined://host` — a string, so nothing
		// threw, and every request made from it failed.
		const url = runtime.k.toUrl(runtime.globals.Uri.parse('https://example.invalid/a/b?q=1'));
		expect(url.protocol).toBe('https');
		expect(url.host).toBe('example.invalid');
	});

	it('answers digitToChar with UPPERCASE letters, as Kotlin does', () => {
		expect(runtime.k.digitToChar(7)).toBe('7');
		// Lower-casing here is a decoded url with the wrong characters in it,
		// which is a wrong value rather than an error.
		expect(runtime.k.digitToChar(11, 16)).toBe('B');
		expect(() => runtime.k.digitToChar(11)).toThrow(/digit/);
	});

	it('intersects in the receiver’s order, and answers a Set', () => {
		const both = runtime.k.intersect(['c', 'a', 'b'], ['b', 'c']);
		expect(both instanceof Set).toBe(true);
		expect([...both]).toEqual(['c', 'b']);
	});

	it('partitions with the matching half first', () => {
		const split = runtime.k.partition([1, 2, 3, 4], (n: number) => n % 2 === 0);
		expect(split.first).toEqual([2, 4]);
		expect(split.second).toEqual([1, 3]);
	});

	it('builds `List(n) { … }` rather than allocating an empty one', () => {
		// It is an episode list as often as not, and an array of that length
		// answers undefined for every entry.
		expect(runtime.k.listOfSize(3, (at: number) => at * 2)).toEqual([0, 2, 4]);
		expect(runtime.k.listOfSize(0, () => 1)).toEqual([]);
	});

	it('clears an array, a Set and a Map in place', () => {
		const list = [1, 2];
		const set = new Set([1]);
		runtime.k.clearAll(list);
		runtime.k.clearAll(set);
		expect(list).toEqual([]);
		expect(set.size).toBe(0);
	});

	it('answers containsKey over a Map and over a plain object', () => {
		expect(runtime.k.containsKey(new Map([['a', 1]]), 'a')).toBe(true);
		expect(runtime.k.containsKey({ a: 1 }, 'b')).toBe(false);
	});

	it('carries the numeric limits an episode sort reads', () => {
		// `ep.episode_number.takeIf { it > 0f } ?: Float.MAX_VALUE` — a sort key
		// meaning "put this last". An absent name is a ReferenceError at run
		// time, because a capitalised receiver is passed through.
		expect(runtime.globals.Float.MAX_VALUE).toBeGreaterThan(1e38);
		expect(runtime.globals.Int.MAX_VALUE).toBe(2147483647);
	});
});

describe('a form body whose pair is already encoded', () => {
	it('sends an addEncoded value verbatim and an add value escaped', () => {
		// `addEncoded` names a request signature, and encoding it again sends the
		// percent signs escaped — a body that is accepted and does not verify.
		const body = runtime.globals.FormBody.Builder()
			.add('q', 'a b')
			.addEncoded('vv', 'x%2Fy')
			.build();

		expect(body.text).toBe('q=a%20b&vv=x%2Fy');
	});
});

describe('HttpUrl, built by hand', () => {
	it('adds query parameters without re-encoding the ones already there', () => {
		// Decoding and re-encoding looks harmless: a '+' that meant a plus comes
		// back as '%2B', and a signed token stops verifying.
		const url = k
			.httpUrl('https://api.example.invalid/search?token=a%2Bb')
			.newBuilder()
			.addQueryParameter('q', 'one two')
			.addQueryParameter('page', '2')
			.build();

		expect(url.toString()).toBe(
			'https://api.example.invalid/search?token=a%2Bb&q=one%20two&page=2'
		);
		expect(url.host).toBe('api.example.invalid');
		expect(url.queryParameter('q')).toBe('one two');
		expect(url.queryParameter('absent')).toBeNull();
	});

	it('appends path segments and replaces a parameter', () => {
		const url = k
			.httpUrl('https://example.invalid/api')
			.newBuilder()
			.addPathSegment('anime')
			.addPathSegments('one/1')
			.setQueryParameter('lang', 'en')
			.setQueryParameter('lang', 'jp')
			.build();

		expect(url.toString()).toBe('https://example.invalid/api/anime/one/1?lang=jp');
		expect(url.pathSegments).toEqual(['api', 'anime', 'one', '1']);
		expect(url.encodedPath).toBe('/api/anime/one/1');
	});

	it('is idempotent, and survives a url with no query at all', () => {
		const url = k.httpUrl('https://example.invalid/one');
		expect(k.httpUrl(url)).toBe(url);
		expect(url.toString()).toBe('https://example.invalid/one');
		expect(url.queryParameterNames()).toEqual([]);
	});
});

/* ── regex ────────────────────────────────────────────────────────────────── */

describe('java.util.regex, translated', () => {
	it('compiles the patterns a scraper actually writes', () => {
		// Every one of these is built with `new RegExp` at call time, which a
		// parse cannot check: an escaping mistake in the TypeScript template
		// surfaces here and nowhere earlier.
		expect(k.regex('Episode\\s+(\\d+)').find('Episode 12')?.groupValues[1]).toBe('12');
		expect(k.regex('\\.m3u8(\\?|$)').containsMatchIn('a/index.m3u8?x=1')).toBe(true);
		expect(k.regex('^[a-z]+$').matches('abc')).toBe(true);
		expect(k.regex('^[a-z]+$').matches('abc1')).toBe(false);
		expect(k.regex('a|b').matchEntire('a')?.value).toBe('a');
		expect(k.regex('a|b').matchEntire('ab')).toBeNull();
	});

	it('reads an unmatched group as the empty string Kotlin reads', () => {
		const match = k.regex('(a)?(b)').find('b');
		expect(k.groupValues(match)).toEqual(['b', '', 'b']);
		expect(k.destructured(match)).toEqual(['', 'b']);
		expect(match.groups[1]).toBeNull();
		expect(match.range.first).toBe(0);
	});

	it('finds all matches, and walks them with next()', () => {
		const all = k.regex('[0-9]+').findAll('1 22 333');
		expect(all.map((m: { value: string }) => m.value)).toEqual(['1', '22', '333']);
		expect(k.regex('[0-9]+').find('1 22')?.next()?.value).toBe('22');
	});

	it('replaces every match, with a string or a lambda', () => {
		expect(k.regex('-').replace('a-b-c', '_')).toBe('a_b_c');
		expect(k.regex('(\\d+)').replace('e1 e2', '[$1]')).toBe('e[1] e[2]');
		// Java spells a named back-reference ${name}; JavaScript spells it $<name>.
		expect(k.regex('(?<n>\\d+)').replace('e1', '<${n}>')).toBe('e<1>');
		expect(k.regex('\\d+').replace('e1', (m: { value: string }) => `#${m.value}`)).toBe('e#1');
		expect(k.regex('\\d+').replaceFirst('e1 e2', 'x')).toBe('ex e2');
	});

	it('honours the inline flags Java writes into the pattern', () => {
		expect(k.regex('(?i)HD').containsMatchIn('hd')).toBe(true);
		expect(k.regex('(?s)a.b').containsMatchIn('a\nb')).toBe(true);
		expect(k.regex('HD', 'IGNORE_CASE').containsMatchIn('hd')).toBe(true);
		expect(k.regex('HD', ['IGNORE_CASE']).containsMatchIn('hd')).toBe(true);
	});

	it('translates the anchors and quoted runs Java has and JavaScript does not', () => {
		expect(k.regex('\\Aone\\z').matches('one')).toBe(true);
		expect(k.regex('\\Qa.b\\E').containsMatchIn('a.b')).toBe(true);
		expect(k.regex('\\Qa.b\\E').containsMatchIn('axb')).toBe(false);
		expect(k.regex('a{2,3}').containsMatchIn('aaa')).toBe(true);
	});

	it('translates a lookbehind, which every surface now has', () => {
		// ABI.md section 6 forbade it for the three-engine world of ADR-0002
		// section 2.3; ADR-0003 section 2.2 repealed that and ADR-0004 names
		// this as the first thing the engine collapse bought. Java's lookbehind
		// is the bounded-width one and spells it the same way, so anything Java
		// accepted this engine accepts. `episode-recognition.ts` has used one on
		// every episode list since — refusing a converted extension for the same
		// construct was this runtime disagreeing with itself.
		expect(k.regex('(?<=id=)\\d+').containsMatchIn('id=1')).toBe(true);
		expect(k.regex('(?<!x)y').replace('zy', 'w')).toBe('zw');
		// The shape that sent this looking: read a query parameter's value.
		expect(k.regex('(?<=\\?e=)(.*?)(?=&f=)').find('a?e=VALUE&f=b')?.value).toBe('VALUE');
	});

	it('refuses what it cannot translate identically', () => {
		expect(() => k.regex('\\p{Alpha}+').find('a')).toThrow(/Unicode class/);
		expect(() => k.regex('a++').find('a')).toThrow(/possessive/);
		expect(() => k.regex('\\d*+').find('1')).toThrow(/possessive/);
		expect(() => k.regex('(?>ab)').find('ab')).toThrow(/atomic/);
		// A lazy quantifier is not a possessive one and must still compile.
		expect(k.regex('<(.+?)>').find('<a><b>')?.groupValues[1]).toBe('a');
	});

	it('holds an inexpressible pattern without failing until it is used', () => {
		// The whole reason the translation is deferred. This ecosystem declares
		// its patterns as top-level vals, so refusing in the constructor threw
		// during module initialisation: the bundle did not load at all, and
		// every ABI call it declared was lost to a pattern that one of them —
		// often none of them — would have touched. Measured on the catalogue:
		// one extension lost searchCatalog to a single pattern used only in a
		// details parser.
		const held = k.regex('(?>ab)+');
		expect(held.pattern).toBe('(?>ab)+');
		expect(String(held)).toBe('(?>ab)+');

		// And it refuses every time, not only the first: caching the failure
		// away would turn the second call into a wrong answer.
		expect(() => held.find('a')).toThrow(/atomic/);
		expect(() => held.find('a')).toThrow(/atomic/);
	});

	it('names the member a refused pattern was declared as, when it was told one', () => {
		// The pattern text in the message is the engine's spelling, not the
		// Kotlin's, so it is the one thing a maintainer cannot grep the source
		// for. The emitter passes the declaring member when it knows it; see
		// runtime-api.ts. Without it the refusal still names the pattern.
		expect(() => k.regex('(?>x)y', null, 'UNESCAPED_QUOTE_REGEX').find('xy')).toThrow(
			/declared as UNESCAPED_QUOTE_REGEX/
		);
		expect(() => k.regex('(?>x)y').find('xy')).toThrow(/atomic/);
		expect(() => k.regex('(?>x)y').find('xy')).not.toThrow(/declared as/);
	});

	it('is idempotent, so a Regex handed back is not retranslated', () => {
		const once = k.regex('a');
		expect(k.regex(once)).toBe(once);
	});
});

/* ── http ─────────────────────────────────────────────────────────────────── */

describe('generic runtime helpers', () => {
	it('formats bytes and exposes a millisecond clock', () => {
		expect(k.formatBytes(0)).toBe('0 B');
		expect(k.formatBytes(1536)).toBe('1.50 KiB');
		expect(k.formatBytes(-1024)).toBe('-1.00 KiB');
		expect(k.now()).toBeGreaterThan(0);
	});

	it('returns the builder a rate limit was declared on, and stops handles', () => {
		// The *shape* is what this asserts: `.rateLimit(n)` is written mid-chain
		// and its value is the builder `.build()` is called on next. What the
		// call now also does — declare a policy the host enforces — is asserted
		// against a host in 'the declarative request policy' below, because this
		// helper has no way to observe it.
		const handle = { cancel: () => 'cancelled' };
		expect(k.rateLimit(handle, 1, 250)).toBe(handle);
		expect(k.stop(handle)).toBe('cancelled');
		expect(k.stop({})).toBeUndefined();
	});

	it('provides generic JSON objects and an access-ordered LRU cache', () => {
		const object = new runtime.globals.JsonObject({ answer: 42 });
		expect(object.answer).toBe(42);
		const cache = new runtime.globals.LruCache(2);
		cache.put('a', 1);
		cache.put('b', 2);
		expect(cache.get('a')).toBe(1);
		cache.put('c', 3);
		expect(cache.get('b')).toBeNull();
		expect(cache.get('a')).toBe(1);
		expect(cache.get('c')).toBe(3);
	});
});

describe('okhttp, over the host', () => {
	it('accepts a connection pool without changing host-owned transport', () => {
		const built = runtime.client.newBuilder().connectionPool({}).build();
		expect(typeof built.newCall).toBe('function');
	});
	it('reads the body before resolving, so everything after is synchronous', async () => {
		const { ctx, sent } = context({
			'https://example.invalid/one': { body: '<p class="syn">A synopsis.</p>' }
		});
		runtime.enter(ctx);

		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/one'))
			.execute();

		// No await anywhere below this line: that is the whole design.
		expect(response.body.string()).toBe('<p class="syn">A synopsis.</p>');
		// A second read must not be empty — okhttp's would be, but the Kotlin
		// that reads twice was written against a body it had already buffered.
		expect(response.body.string()).toBe('<p class="syn">A synopsis.</p>');
		expect(response.asJsoup().selectFirst('p.syn')?.text()).toBe('A synopsis.');
		expect(response.code).toBe(200);
		expect(response.isSuccessful).toBe(true);
		expect(sent).toEqual([
			{
				url: 'https://example.invalid/one',
				method: 'GET',
				headers: {},
				body: null
			}
		]);
	});

	it('parses against the final url, so abs:href survives a redirect', async () => {
		const { ctx } = context({
			'https://example.invalid/go': {
				url: 'https://moved.example.invalid/anime/one',
				body: '<a href="/anime/one/1">Episode 1</a>'
			}
		});
		runtime.enter(ctx);

		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/go'))
			.execute();

		// Parsing against the REQUEST url here would give an absolute link that
		// is plausible, wrong, and only fails at play time.
		expect(response.asJsoup().selectFirst('a')?.attr('abs:href')).toBe(
			'https://moved.example.invalid/anime/one/1'
		);
		expect(response.url).toBe('https://moved.example.invalid/anime/one');
	});

	it('builds headers that read as a map and as a Headers', async () => {
		const { ctx, sent } = context();
		runtime.enter(ctx);

		const headers = runtime.globals.Headers.Builder()
			.add('Referer', 'https://example.invalid/')
			.add('X-Requested-With', 'XMLHttpRequest')
			.set('Referer', 'https://example.invalid/watch')
			.build();

		expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
		expect(headers.get('referer')).toBe('https://example.invalid/watch');
		// The methods must not leak into what the host is handed.
		expect(Object.keys(headers).sort()).toEqual(['Referer', 'X-Requested-With']);

		await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/', headers))
			.execute();
		expect(sent[0].headers).toEqual({
			Referer: 'https://example.invalid/watch',
			'X-Requested-With': 'XMLHttpRequest'
		});
	});

	it('posts a form body, form-encoded, with the content type set', async () => {
		const { ctx, sent } = context();
		runtime.enter(ctx);

		const body = runtime.globals.FormBody.Builder().add('q', 'one two').add('page', '1').build();
		await runtime.client
			.newCall(runtime.globals.POST('https://example.invalid/s', {}, body))
			.execute();

		expect(sent[0].method).toBe('POST');
		expect(sent[0].body).toBe('q=one%20two&page=1');
		expect(sent[0].headers['Content-Type']).toMatch(/x-www-form-urlencoded/);
	});

	it('names the status when awaitSuccess is not a success', async () => {
		const { ctx } = context({
			'https://example.invalid/gone': { status: 404, body: '' }
		});
		runtime.enter(ctx);

		await expect(
			runtime.client.newCall(runtime.globals.GET('https://example.invalid/gone')).awaitSuccess()
		).rejects.toThrow(/404/);
		// execute() does not throw: Kotlin branches on response.code itself.
		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/gone'))
			.execute();
		expect(response.isSuccessful).toBe(false);
	});

	// What the runtime hands an interceptor. Declared here because this file
	// drives an *emitted module*, so nothing it calls has a type of its own.
	interface Chain {
		request(): { url: string };
		proceed(request: unknown): Promise<{
			code: number;
			body: { string(): string };
			newBuilder(): { body(text: string): { build(): unknown } };
		}>;
	}

	it('runs an application interceptor, and lets it rewrite the request', async () => {
		const { ctx, sent } = context();
		runtime.enter(ctx);
		// The chain runs inside the sandbox: 'proceed' at the end of it is this
		// runtime's own send, so an interceptor needs nothing the plugin did not
		// already have. What is asserted is the whole contract — the interceptor
		// sees the request, what it proceeds with is what goes out, and what it
		// returns is what the caller gets.
		const client = runtime.client
			.newBuilder()
			.addInterceptor(function (chain: Chain) {
				const asked = chain.request();
				return chain.proceed(
					runtime.globals.GET(asked.url + '?signed=1', { Referer: 'https://s.invalid/' })
				);
			})
			.build();

		const response = await client
			.newCall(runtime.globals.GET('https://example.invalid/a'))
			.execute();

		expect(sent.at(-1)?.url).toBe('https://example.invalid/a?signed=1');
		expect(response.code).toBe(200);
	});

	it('runs interceptors outermost first, in the order they were added', async () => {
		const { ctx } = context();
		runtime.enter(ctx);
		const order: string[] = [];
		const client = runtime.client
			.newBuilder()
			.addInterceptor(function (chain: Chain) {
				order.push('first');
				return chain.proceed(chain.request());
			})
			.addInterceptor(function (chain: Chain) {
				order.push('second');
				return chain.proceed(chain.request());
			})
			.build();

		await client.newCall(runtime.globals.GET('https://example.invalid/a')).execute();

		expect(order).toEqual(['first', 'second']);
	});

	it('lets an interceptor replace the body it was handed', async () => {
		const { ctx } = context();
		runtime.enter(ctx);
		const client = runtime.client
			.newBuilder()
			.addInterceptor(async function (chain: Chain) {
				const answered = await chain.proceed(chain.request());
				return answered.newBuilder().body('rewritten').build();
			})
			.build();

		const response = await client
			.newCall(runtime.globals.GET('https://example.invalid/a'))
			.execute();

		expect(response.body.string()).toBe('rewritten');
	});

	it('refuses a NETWORK interceptor, which has no per-hop connection to wrap', () => {
		// The host follows redirects itself and reports only where they ended,
		// so there is nothing here for one to sit between. Running it once over
		// the final hop would leave an extension believing it had rewritten
		// every hop when it had rewritten one.
		expect(() => runtime.client.newBuilder().addNetworkInterceptor(() => {})).toThrow(
			/network interceptor/
		);
		// A timeout is a no-op, not a refusal: extensions set them idly.
		expect(runtime.client.newBuilder().readTimeout(30).build()).toBe(runtime.client);
		expect(runtime.network.client).toBe(runtime.client);
	});

	it('does not hand the shared client to an extension that built its own', () => {
		// The one that would be silent: a client built to carry an interceptor
		// must not come back as the one every other request uses.
		const own = runtime.client
			.newBuilder()
			.addInterceptor(function (chain: Chain) {
				return chain.proceed(chain.request());
			})
			.build();

		expect(own).not.toBe(runtime.client);
		expect(runtime.client.interceptors).toEqual([]);
	});

	it('refuses to reach the network outside an ABI call', async () => {
		runtime.enter(null);
		await expect(
			runtime.client.newCall(runtime.globals.GET('https://example.invalid/')).execute()
		).rejects.toThrow();
	});
});

/* ── the declarative request policy ───────────────────────────────────────── */

/**
 * The seam between what an extension declared and what the host is told.
 *
 * Enforcement is tested against a clock in `host/net/request-policy.spec.ts`.
 * What is asserted here is the half that used to be missing entirely: that a
 * limit reaches the host at all, before the request it governs, and only when
 * one was actually declared.
 *
 * A fresh runtime per test, unlike every other block in this file. The policy
 * an extension declares is module state, because a bundle is one module and a
 * plugin is one isolate — so two tests sharing a runtime would share a limit,
 * and the second would be asserting the first one's declaration.
 */
describe('the declarative request policy', () => {
	let rt: Loaded;

	beforeEach(async () => {
		rt = await load();
	});

	const paced = async (declare: () => void) => {
		const { ctx, policies, sent } = context({ 'https://api.example.invalid/': { body: 'ok' } });
		rt.enter(ctx);
		declare();
		await rt.client.newCall(rt.globals.GET('https://api.example.invalid/')).execute();
		return { policies, sent };
	};

	it('hands the host a rate limit before the first request it governs', async () => {
		const { policies, sent } = await paced(() => {
			rt.k.rateLimit(rt.client.newBuilder(), 3, 1000);
		});

		expect(policies).toEqual([{ rateLimit: { permits: 3, periodMs: 1000 } }]);
		expect(sent).toHaveLength(1);
	});

	it('scopes a per-host limit by the host of whatever url it was given', async () => {
		// The url is a runtime value — built from `baseUrl` or read out of a
		// preference — so only this side can know what it resolved to. An okhttp
		// HttpUrl and a plain string both arrive here and both carry a host.
		const { policies } = await paced(() => {
			rt.k.rateLimitHost(rt.client.newBuilder(), 'https://API.example.invalid/search?q=1', 1, 2000);
		});

		expect(policies).toEqual([
			{ rateLimitByHost: { 'api.example.invalid': { permits: 1, periodMs: 2000 } } }
		]);
	});

	it('keeps the stricter of two limits an extension declared', async () => {
		// An extension may build two clients and pace each. The policy is per
		// plugin, so the two have to become one rule — and the stricter one is
		// the only merge that can never send a source more than it allowed.
		const { policies } = await paced(() => {
			rt.k.rateLimit(rt.client.newBuilder(), 5, 1000);
			rt.k.rateLimit(rt.client.newBuilder(), 1, 1000);
		});

		expect(policies).toEqual([{ rateLimit: { permits: 1, periodMs: 1000 } }]);
	});

	it('declares once and not again, so the host does not reset its window', async () => {
		const { ctx, policies } = context({ 'https://api.example.invalid/': { body: 'ok' } });
		rt.enter(ctx);
		rt.k.rateLimit(rt.client.newBuilder(), 2, 1000);

		for (let n = 0; n < 3; n += 1) {
			await rt.client.newCall(rt.globals.GET('https://api.example.invalid/')).execute();
		}

		expect(policies).toHaveLength(1);
	});

	it('says nothing to the host when no limit was declared', async () => {
		// A runtime that declared an empty policy on every request would make
		// `ctx.http.policy` a requirement on hosts rather than a capability.
		const { ctx, policies } = context({ 'https://api.example.invalid/': { body: 'ok' } });
		rt.enter(ctx);
		await rt.client.newCall(rt.globals.GET('https://api.example.invalid/')).execute();

		expect(policies).toEqual([]);
	});

	it('tells a host with no policy support rather than pacing nothing', async () => {
		// The bug this whole path exists to remove is a declared limit that is
		// quietly not a limit. A host that cannot honour one has to say so.
		const { ctx } = context({ 'https://api.example.invalid/': { body: 'ok' } });
		delete (ctx.http as unknown as Record<string, unknown>).policy;
		rt.enter(ctx);
		rt.k.rateLimit(rt.client.newBuilder(), 1, 1000);

		await expect(
			rt.client.newCall(rt.globals.GET('https://api.example.invalid/')).execute()
		).rejects.toThrow(/ctx\.http\.policy/);
	});

	it('refuses a rate it could not honour exactly rather than rounding it', () => {
		// The emitter resolves a period to whole milliseconds and refuses what it
		// cannot read; this is the same rule one layer down, for a runtime handed
		// something the emitter would never have produced.
		expect(() => rt.k.rateLimit({}, 1, 0)).toThrow(/not a rate/);
		expect(() => rt.k.rateLimit({}, 0, 1000)).toThrow(/not a rate/);
		expect(() => rt.k.rateLimit({}, 1, 2.5)).toThrow(/not a rate/);
		expect(() => rt.k.rateLimitHost({}, '', 1, 1000)).toThrow(/named none/);
	});
});

/* ── jsoup ────────────────────────────────────────────────────────────────── */

describe('the Elements wrapper dom.ts deliberately lacks', () => {
	const markup =
		'<ul><li class="row"><a href="/one" title="One">One</a></li>' +
		'<li class="row"><a href="/two">Two</a></li>' +
		'<li class="row"></li></ul>';

	it('answers element questions about the whole collection', () => {
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		const rows = k.els(document.select('li.row'));

		expect(rows.size()).toBe(3);
		expect(rows.isEmpty()).toBe(false);
		// jsoup's Elements.text() concatenates; an empty member contributes
		// nothing rather than a stray separator.
		expect(rows.text()).toBe('One Two');
		expect(rows.eachText()).toEqual(['One', 'Two']);
		expect(rows.first()?.text()).toBe('One');
		expect(rows.last()?.text()).toBe('');
		expect(rows.get(9)).toBeNull();
	});

	it('reads an attribute from the first member that has one', () => {
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		const links = k.els(document.select('li.row a'));
		// Not the first member's attribute: the first member that HAS it.
		expect(links.attr('title')).toBe('One');
		expect(links.eachAttr('href')).toEqual(['/one', '/two']);
		expect(links.attr('data-absent')).toBe('');
		expect(links.hasAttr('href')).toBe(true);
	});

	it('omits an element that lacks the attribute rather than padding with ""', () => {
		// jsoup skips it, and scraper code depends on that: the result is zipped
		// against another list, and a placeholder shifts every pair after it.
		const document = runtime.globals.Jsoup.parse(
			'<ul><li><a href="/one">One</a></li><li><a>Two</a></li><li><a href="/three">Three</a></li></ul>',
			'https://example.invalid/'
		);
		const links = document.select('li a');
		expect(k.eachAttr(links, 'href')).toEqual(['/one', '/three']);
		expect(k.eachText(links)).toEqual(['One', 'Two', 'Three']);
		// 'abs:href' is asked about as 'href': the resolved form is computed and
		// never present in the markup, so a hasAttr on it would omit everything.
		expect(k.eachAttr(links, 'abs:href')).toEqual([
			'https://example.invalid/one',
			'https://example.invalid/three'
		]);
	});

	it('takes a bare selector result as readily as an Elements', () => {
		const document = runtime.globals.Jsoup.parse('<p>a</p><p>b</p>', 'https://example.invalid/');
		expect(k.eachText(document.select('p'))).toEqual(['a', 'b']);
		expect(k.eachText(k.els(document.select('p')))).toEqual(['a', 'b']);
		expect(k.eachText(null)).toEqual([]);
	});

	it('selects across the collection, without duplicating a shared match', () => {
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		const rows = k.els(document.select('li.row'));
		expect(rows.select('a').size()).toBe(2);
		expect(rows.selectFirst('a')?.attr('href')).toBe('/one');
		// The whole document selected twice must still yield one <ul>.
		expect(k.els([document, document]).select('ul').size()).toBe(1);
	});

	it('wraps whatever the emitter hands it, and iterates', () => {
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		expect(k.els(null).isEmpty()).toBe(true);
		expect(k.els(document.selectFirst('li.row')).size()).toBe(1);
		const wrapped = k.els(document.select('li.row'));
		expect(k.els(wrapped)).toBe(wrapped);
		// Iterable, so every collection helper here takes one unchanged.
		expect(k.map(wrapped, (el: { text(): string }) => el.text())).toEqual(['One', 'Two', '']);
	});

	it('answers element questions on what the parser itself returned', () => {
		// The failure this prevents, seen on two extensions in the catalogue:
		// they loaded, searched, and threw `element.select(...).attr is not a
		// function` — because the engine answers with a bare array and the
		// scraper asks the collection an element question directly.
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		expect(document.select('li.row a').attr('title')).toBe('One');
		expect(document.select('li.row a').first()?.attr('href')).toBe('/one');
		expect(document.select('li.row').text()).toBe('One Two');
		expect(document.select('li.row').select('a').size()).toBe(2);
		expect(document.select('li.missing').isEmpty()).toBe(true);
		expect(document.selectFirst('ul')?.select('a').eachAttr('href')).toEqual(['/one', '/two']);
	});

	it('is still an array, so the translated Kotlin can index and map it', () => {
		// Both shapes are asked of the same value. A selection that stopped
		// being an array would break every `for (el of …)` and `list[0]` the
		// emitter writes, which is most of what a scraper does with one.
		const document = runtime.globals.Jsoup.parse(markup, 'https://example.invalid/');
		const rows = document.select('li.row');
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.length).toBe(3);
		expect(rows[0].text()).toBe('One');
		expect([...rows].length).toBe(3);
		// map() and filter() answer plain arrays rather than trying to rebuild
		// an Elements out of a length.
		expect(rows.map((el: { text(): string }) => el.text())).toEqual(['One', 'Two', '']);
		expect(rows.filter((el: { text(): string }) => el.text().length > 0).length).toBe(2);
		expect(rows.slice(1).length).toBe(2);
	});

	it('parses a response, or a string an extension dug out of a script', async () => {
		const { ctx } = context({
			'https://example.invalid/one': {
				url: 'https://moved.example.invalid/one',
				body: '<a href="/two">Two</a>'
			}
		});
		runtime.enter(ctx);
		const response = await runtime.client
			.newCall(runtime.globals.GET('https://example.invalid/one'))
			.execute();

		// The extension-function form, which is how the Kotlin spells it.
		expect(k.asJsoup(response).selectFirst('a')?.attr('abs:href')).toBe(
			'https://moved.example.invalid/two'
		);
		expect(k.asJsoup('<b>x</b>').selectFirst('b')?.text()).toBe('x');
	});

	it('says so when the bundle was built without the parser', async () => {
		const bare = await load(['stdlib']);
		expect(bare.hasJsoup).toBe(false);
	});
});

/* ── kotlinx.serialization ────────────────────────────────────────────────── */

describe('kotlinx.serialization, as a descriptor walk', () => {
	const episode = {
		fields: [
			['id', 'id', 'int'],
			['title', 'episode_title', 'string'],
			['number', 'ep', 'double', 0],
			['premium', 'is_premium', 'boolean', false]
		]
	};

	it('renames by @SerialName and ignores unknown keys', () => {
		const decoded = k.decode(
			episode,
			JSON.stringify({
				id: 7,
				episode_title: 'One',
				ep: 1.5,
				unknown: 'ignored'
			})
		);
		expect(decoded).toEqual({
			id: 7,
			title: 'One',
			number: 1.5,
			premium: false
		});
		expect('unknown' in decoded).toBe(false);
	});

	it('fills an absent key from the declared default, not with undefined', () => {
		const decoded = k.decode(episode, { id: 1, episode_title: 'One' });
		expect(decoded.number).toBe(0);
		expect(decoded.premium).toBe(false);
	});

	it('names the field when a required one is missing', () => {
		expect(() => k.decode(episode, { id: 1 })).toThrow(/episode_title|title/);
		// A nullable field is absent, not missing.
		const nullable = { fields: [['name', 'name', 'string?']] };
		expect(k.decode(nullable, {}).name).toBeNull();
	});

	it('walks lists, maps and nested descriptors', () => {
		const page = {
			fields: [
				['results', 'results', ['list', episode]],
				['labels', 'labels', ['map', 'string'], {}]
			]
		};
		const decoded = k.decode(page, {
			results: [{ id: 1, episode_title: 'One' }],
			labels: { en: 'English' }
		});
		expect(decoded.results[0].title).toBe('One');
		expect(decoded.labels.en).toBe('English');
	});

	it('refuses a body that is not JSON, by saying so', () => {
		expect(() => k.decode(episode, '<html>')).toThrow(/did not answer with JSON/);
	});

	it('decodes a response body through parseAs', async () => {
		const { ctx } = context({
			'https://api.example.invalid/e': {
				body: '{"id":3,"episode_title":"Three"}'
			}
		});
		runtime.enter(ctx);
		const response = await runtime.client
			.newCall(runtime.globals.GET('https://api.example.invalid/e'))
			.execute();
		expect(response.parseAs(episode).title).toBe('Three');
		expect(runtime.globals.Json.decodeFromString(episode, '{"id":1,"episode_title":"x"}').id).toBe(
			1
		);
		// `Json { ignoreUnknownKeys = true }` is a call in Kotlin.
		expect(runtime.globals.Json()).toBe(runtime.globals.Json);
	});

	it('keeps the container from a type argument that no longer exists', async () => {
		const { ctx } = context({
			'https://api.example.invalid/list': { body: '[{"id":1},{"id":2}]' }
		});
		runtime.enter(ctx);
		const response = await runtime.client
			.newCall(runtime.globals.GET('https://api.example.invalid/list'))
			.execute();

		// `parseAs<List<Item>>()` arrives as the text 'List<Item>'. The class is
		// gone after translation; the container is not, and decoding a list as a
		// single object is the difference between one result and a page of them.
		const rows = k.decode(response, 'List<Item>');
		expect(Array.isArray(rows)).toBe(true);
		expect(rows.map((row: { id: number }) => row.id)).toEqual([1, 2]);

		// A single object under a list type is still a list of one.
		expect(k.decode(runtime.globals.Json, 'List<Item>', '{"id":9}')).toHaveLength(1);
		expect(k.decode(runtime.globals.Json, 'Item', '{"id":9}').id).toBe(9);
		expect(k.decode(runtime.globals.Json, 'Map<String, Item>', '{"a":{"id":1}}').a.id).toBe(1);
	});

	it('honours a descriptor handed alongside the type name', async () => {
		const named = {
			fields: [
				['title', 'episode_title', 'string'],
				['number', 'ep', 'double', 0]
			]
		};
		expect(
			k.decode(runtime.globals.Json, 'List<Episode>', '[{"episode_title":"One"}]', named)
		).toEqual([{ title: 'One', number: 0 }]);
		// The descriptor as the second argument is the shape the emitter writes
		// when it has one to give.
		expect(k.decode(runtime.globals.Json, named, '{"episode_title":"One"}')).toEqual({
			title: 'One',
			number: 0
		});
	});
});

/* ── preferences ──────────────────────────────────────────────────────────── */

describe('preferences', () => {
	it('answers the declared default when the host has nothing', () => {
		const { ctx } = context();
		runtime.enter(ctx);
		expect(k.pref('preferred_quality', '1080p')).toBe('1080p');
		expect(k.pref('preferred_quality')).toBe('');
		expect(k.pref('use_dub', false)).toBe(false);
	});

	it('prefers the viewer’s value, coerced to the default’s type', () => {
		const { ctx } = context({}, { preferred_quality: '720p', use_dub: 'true', limit: '5' });
		runtime.enter(ctx);
		expect(k.pref('preferred_quality', '1080p')).toBe('720p');
		expect(k.pref('use_dub', false)).toBe(true);
		expect(k.pref('limit', 1)).toBe(5);
	});

	it('answers the default rather than throwing outside an ABI call', () => {
		// These are read at module scope, before any call has entered.
		runtime.enter(null);
		expect(k.pref('preferred_quality', '1080p')).toBe('1080p');
	});

	it('takes a null store, which is what getPreferencesLazy emits', () => {
		const { ctx } = context({}, { preferred_quality: '720p' });
		runtime.enter(ctx);
		// There is nothing for the store to be — a converted bundle declares no
		// settings — so a null one must mean the default, not a thrown error.
		expect(k.pref(null, 'unset_key', '1080p')).toBe('1080p');
		expect(k.pref(null, 'preferred_quality', '1080p')).toBe('720p');
	});

	it('answers a set-valued preference as a list, not as a joined string', () => {
		// getStringSet maps onto this helper. A comma-joined string would
		// iterate as one long element rather than as the values it holds.
		const { ctx } = context();
		runtime.enter(ctx);
		const fallback = ['sub', 'dub'];
		expect(k.pref('preferred_types', fallback)).toEqual(fallback);
		expect(k.pref(null, 'preferred_types', fallback)).toEqual(fallback);
		runtime.enter(null);
		expect(k.pref('preferred_types', fallback)).toEqual(fallback);
	});

	it('prefers a store that actually answers', () => {
		const { ctx } = context({}, { preferred_quality: '720p' });
		runtime.enter(ctx);
		const store = {
			getString: (key: string, fallback: string) => (key === 'server' ? 'beta' : fallback)
		};
		expect(k.pref(store, 'server', 'alpha')).toBe('beta');
		// A store that has nothing falls back to the host, then to the default.
		expect(k.pref(store, 'preferred_quality', '')).toBe('720p');
	});
});

/* ── the preference framework ─────────────────────────────────────────────── */

/**
 * The runtime again, with the androidx preference names exported.
 *
 * They are not in `RUNTIME_GLOBALS` — nothing the emitter *calls* is a
 * preference type; an extension constructs them by name — so the shared loader
 * cannot reach them and this one exports them directly.
 */
async function loadPreferences(settingIds: Record<string, string> = {}) {
	const probe = [
		'export const k = __k;',
		'export const enter = __enter;',
		'export const types = { Preference, PreferenceScreen, PreferenceCategory, ListPreference,',
		'  EditTextPreference, SwitchPreferenceCompat, MultiSelectListPreference, DropDownPreference };',
		'export const store = getSourcePreferences();'
	].join('\n');

	const source = [
		JS_RUNTIME,
		`var __SETTING_ID_MAP = ${JSON.stringify(settingIds)};`,
		kotlinRuntime(),
		probe
	].join('\n');
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return (await import(/* @vite-ignore */ url)) as any;
}

describe('the androidx preference framework a converted extension builds', () => {
	it('constructs the four types and puts them on a screen', async () => {
		const runtime = await loadPreferences();
		const screen = new runtime.types.PreferenceScreen(null);

		const list = new runtime.types.ListPreference(null);
		list.key = 'server';
		list.entries = ['Alpha', 'Beta'];
		list.entryValues = ['alpha', 'beta'];
		list.setDefaultValue('beta');
		screen.addPreference(list);

		screen.addPreference(new runtime.types.SwitchPreferenceCompat(null));
		screen.addPreference(new runtime.types.EditTextPreference(null));
		screen.addPreference(new runtime.types.MultiSelectListPreference(null));

		expect(screen.getPreferenceCount()).toBe(4);
	});

	it('is callable without `new`, since a Kotlin constructor has no keyword', async () => {
		const runtime = await loadPreferences();
		const screen = runtime.types.PreferenceScreen(null);
		expect(screen.addPreference(runtime.types.ListPreference(null))).toBe(true);
	});

	it('answers a read with what the screen declared, when the call site did not', async () => {
		const runtime = await loadPreferences();
		runtime.enter(null);

		const list = new runtime.types.ListPreference(null);
		list.key = 'server';
		list.entryValues = ['alpha', 'beta'];
		list.setDefaultValue('beta');

		expect(runtime.k.pref(null, 'server', '')).toBe('beta');
	});

	it('prefers the viewer’s choice over what the screen declared', async () => {
		const runtime = await loadPreferences();
		const { ctx } = context({}, { server: 'alpha' });
		runtime.enter(ctx);

		const list = new runtime.types.ListPreference(null);
		list.key = 'server';
		list.entryValues = ['alpha', 'beta'];
		list.setDefaultValue('beta');

		expect(runtime.k.pref(null, 'server', '')).toBe('alpha');
	});

	it('reads a preference back through the id the conversion mapped it to', async () => {
		// Two foreign keys can normalise to the same id, so the conversion emits
		// the exact map and the runtime uses it rather than re-deriving.
		const runtime = await loadPreferences({ 'pref.server': 'pref_server_2' });
		const { ctx } = context({}, { pref_server_2: 'beta' });
		runtime.enter(ctx);
		expect(runtime.k.pref(null, 'pref.server', 'alpha')).toBe('beta');
	});
});

describe('the SharedPreferences these extensions read and write', () => {
	it('answers all four getters as the type the call site asked for', async () => {
		const runtime = await loadPreferences();
		const { ctx } = context({}, { quality: '720p' });
		runtime.enter(ctx);

		expect(runtime.store.getString('quality', '1080p')).toBe('720p');
		expect(runtime.store.getString('unset', '1080p')).toBe('1080p');
		expect(runtime.store.getBoolean('unset', true)).toBe(true);
		expect(runtime.store.getInt('unset', 3)).toBe(3);
		expect(runtime.store.getStringSet('unset', ['sub'])).toEqual(['sub']);
	});

	it('remembers a write for the run, and does not send it to the host', async () => {
		// These extensions write a mirror they just resolved and read it again
		// moments later. A write that vanished would be a read contradicting
		// the line above it — but a plugin does not get to edit a screen it is
		// not allowed to draw, so nothing leaves the sandbox.
		const runtime = await loadPreferences();
		const written: string[] = [];
		const ctx = {
			settings: {
				string: () => '',
				boolean: () => false,
				list: () => [] as string[],
				set: (id: string) => written.push(id)
			}
		};
		runtime.enter(ctx);

		runtime.store.edit().putString('mirror', 'https://two.example.invalid').apply();
		expect(runtime.store.getString('mirror', '')).toBe('https://two.example.invalid');
		expect(written).toEqual([]);
	});

	it('takes a write back off again', async () => {
		const runtime = await loadPreferences();
		runtime.enter(null);
		runtime.store.edit().putBoolean('dub', true).commit();
		expect(runtime.store.getBoolean('dub', false)).toBe(true);
		runtime.store.edit().remove('dub').apply();
		expect(runtime.store.getBoolean('dub', false)).toBe(false);
	});

	it('is what `by getPreferencesLazy()` resolves to', async () => {
		const runtime = await loadPreferences();
		expect(typeof runtime.k.prefs().edit).toBe('function');
		expect(runtime.k.prefs()).toBe(runtime.store);
	});
});

/* ── the Aniyomi model types ──────────────────────────────────────────────── */

describe('the model types an extension builds its results with', () => {
	it('creates an SAnime with the fields extensions assign', () => {
		const anime = runtime.globals.SAnime.create();
		anime.title = 'One';
		anime.thumbnail_url = 'https://cdn.example.invalid/1.jpg';
		anime.description = 'A synopsis.';
		anime.genre = 'Action, Drama';
		anime.status = runtime.globals.SAnime.ONGOING;
		anime.author = 'Studio';
		anime.artist = 'Studio';
		anime.initialized = true;
		expect(anime.status).toBe(1);
		expect(anime.url).toBe('');
	});

	it('creates an SEpisode with the fields extensions assign', () => {
		const episode = runtime.globals.SEpisode.create();
		episode.name = 'Episode 1';
		episode.episode_number = 1;
		episode.date_upload = 1700000000000;
		episode.scanlator = 'Sub';
		expect(episode.episode_number).toBe(1);
	});

	it('strips scheme and host and keeps path, query and fragment', () => {
		const anime = runtime.globals.SAnime.create();
		anime.setUrlWithoutDomain('https://example.invalid/anime/one?lang=en#top');
		expect(anime.url).toBe('/anime/one?lang=en#top');

		const episode = runtime.globals.SEpisode.create();
		episode.setUrlWithoutDomain('https://example.invalid/anime/one/1');
		expect(episode.url).toBe('/anime/one/1');

		// A bare origin keeps a path, and a relative url is already relative:
		// an extension that stored one must get the same string back.
		anime.setUrlWithoutDomain('https://example.invalid');
		expect(anime.url).toBe('/');
		anime.setUrlWithoutDomain('/anime/two');
		expect(anime.url).toBe('/anime/two');
		anime.setUrlWithoutDomain('//example.invalid/anime/three');
		expect(anime.url).toBe('/anime/three');
	});

	it('percent-decodes the way the published helper does', () => {
		// Upstream builds a `java.net.URI` and reads `path`, `query` and
		// `fragment` — the *decoding* accessors. Extensions rely on it: the
		// string is compared against text read out of the page, and a stored
		// `%20` never matches a title with a space in it. It round-trips on the
		// way back out, because the request builder re-encodes.
		const anime = runtime.globals.SAnime.create();
		anime.setUrlWithoutDomain('https://example.invalid/a%20b');
		expect(anime.url).toBe('/a b');

		anime.setUrlWithoutDomain('https://example.invalid/p?q=a%2Bb#f%20g');
		expect(anime.url).toBe('/p?q=a+b#f g');
	});

	it('hands back the whole url when the base class would have failed to parse it', () => {
		// `java.net.URI` refuses a raw space or a truncated escape outright, and
		// upstream catches that and returns the *original* — domain and all. It
		// reads like a bug and it is one, but it is the bug this ecosystem was
		// written against, and `__foreign` reduces such an id on the way back in.
		const anime = runtime.globals.SAnime.create();
		anime.setUrlWithoutDomain('https://example.invalid/a b');
		expect(anime.url).toBe('https://example.invalid/a b');

		anime.setUrlWithoutDomain('https://example.invalid/a%2');
		expect(anime.url).toBe('https://example.invalid/a%2');
	});

	it('builds a Hoster, with or without new, and names the no-hoster sentinel', () => {
		const { Hoster, Video } = runtime.globals;

		const plain = Hoster('https://example.invalid/host/a', 'Alpha');
		expect(plain.hosterUrl).toBe('https://example.invalid/host/a');
		expect(plain.hosterName).toBe('Alpha');
		// Null, not an empty list: null is what makes the driver fetch, and an
		// empty list is a hoster that genuinely offers nothing.
		expect(plain.videoList).toBeNull();
		expect(plain.lazy).toBe(false);

		const video = Video('https://example.invalid/a.mp4', '720p', 'https://example.invalid/a.mp4');
		const carrying = new Hoster('', 'Alpha', [video]);
		expect(carrying.videoList).toHaveLength(1);

		// Spelled exactly as upstream spells it, because extensions compare
		// against it by hand.
		expect(Hoster.NO_HOSTER_LIST).toBe('no_hoster_list');

		const renamed = carrying.copy(undefined, 'Beta');
		expect(renamed.hosterName).toBe('Beta');
		expect(renamed.videoList).toHaveLength(1);
	});

	it('builds a Video from either constructor, and keeps both spellings filled', () => {
		const { Video } = runtime.globals;

		// ext-lib 14 secondary — three positional arguments, which is what 137
		// calls in the current catalogue write.
		const legacy = Video('https://example.invalid/page', '720p', 'https://example.invalid/a.mp4');
		expect(legacy.url).toBe('https://example.invalid/page');
		expect(legacy.videoUrl).toBe('https://example.invalid/a.mp4');
		expect(legacy.quality).toBe('720p');
		// Upstream `quality` is a deprecated getter over `videoTitle`, so both
		// read the same however the caller spelled it.
		expect(legacy.videoTitle).toBe('720p');

		// ext-lib 16 primary — one options object, which is what the emitter
		// writes for a call that named an ext-lib 16 parameter. `videoUrl` is
		// this constructor's FIRST parameter where it is the secondary's third,
		// which is the whole reason the two cannot share a positional list.
		const current = Video({
			videoUrl: 'https://example.invalid/b.m3u8',
			videoTitle: '1080p',
			resolution: 1080,
			preferred: true,
			internalData: 'k'
		});
		expect(current.videoUrl).toBe('https://example.invalid/b.m3u8');
		expect(current.videoTitle).toBe('1080p');
		expect(current.quality).toBe('1080p');
		expect(current.resolution).toBe(1080);
		expect(current.preferred).toBe(true);
		expect(current.internalData).toBe('k');
		// No page url exists in this constructor, and inventing one would put a
		// manifest address where `aniyomi-entry` looks for a page.
		expect(current.url).toBe('');

		// What playback actually reads, for both — `videoUrl || url` and
		// `videoTitle || quality` in `aniyomi-entry`. Neither may come back
		// empty, which is the failure this whole split exists to prevent.
		for (const made of [legacy, current]) {
			expect(String(made.videoUrl || made.url || '')).not.toBe('');
			expect(String(made.videoTitle || made.quality || '')).not.toBe('');
		}
	});

	it('reads a first argument that is not an ext-lib 16 object as a page url', () => {
		const { Video } = runtime.globals;

		// A string first argument is the secondary constructor however few
		// arguments follow: the object form is the only thing that selects the
		// primary, so arity never has to decide.
		const two = Video('https://example.invalid/a.mp4', 'HD');
		expect(two.url).toBe('https://example.invalid/a.mp4');
		expect(two.quality).toBe('HD');

		// An object carrying none of the ext-lib 16 fields is not a v16 call
		// either — `videoUrl` alone is shared by both constructors and settles
		// nothing.
		const shared = Video({ videoUrl: 'https://example.invalid/a.mp4' });
		expect(shared.videoTitle).toBe('');
	});

	it('wraps a video list as the single sentinel hoster', () => {
		// `List<Video>.toHosterList()` — the one line a source with no hoster
		// concept writes to answer `getHosterList`.
		const { Hoster, Video } = runtime.globals;
		const videos = [
			Video('https://example.invalid/a.mp4', '720p', 'https://example.invalid/a.mp4')
		];

		const hosters = runtime.k.toHosterList(videos);

		expect(hosters).toHaveLength(1);
		expect(hosters[0].hosterName).toBe(Hoster.NO_HOSTER_LIST);
		expect(hosters[0].videoList).toHaveLength(1);
	});

	it('constructs a Video and a Track with or without new', () => {
		const track = runtime.globals.Track('https://example.invalid/en.vtt', 'English');
		const video = new runtime.globals.Video(
			'https://example.invalid/a/index.m3u8',
			'1080p',
			'https://example.invalid/a/index.m3u8',
			{ Referer: 'https://example.invalid/' },
			[track]
		);
		expect(video.quality).toBe('1080p');
		expect(video.subtitleTracks[0].lang).toBe('English');
		expect(video.audioTracks).toEqual([]);
		// Called without `new`, which is how the Kotlin spells it.
		const bare = runtime.globals.Video('https://example.invalid/a.mp4', 'HD');
		expect(bare.videoUrl).toBeNull();
		expect(bare.headers).toBeNull();
	});

	it('builds an AnimesPage with both halves readable', () => {
		// What `popularAnimeParse` returns, and what the driver reads back when
		// it answers a `super.` call — so both fields are plain and readable.
		const anime = runtime.globals.SAnime.create();
		anime.title = 'One';
		const page = runtime.globals.AnimesPage([anime], true);
		expect(page.animes).toHaveLength(1);
		expect(page.animes[0].title).toBe('One');
		expect(page.hasNextPage).toBe(true);
		// Without `new`, which is how the Kotlin spells it, and a missing
		// hasNextPage is false rather than undefined.
		expect(new runtime.globals.AnimesPage([], undefined).hasNextPage).toBe(false);
	});

	it('builds an AnimeFilterList that behaves as the list it is', () => {
		const filters = runtime.globals.AnimeFilterList(
			runtime.globals.AnimeFilter.Header('Filters'),
			runtime.globals.AnimeFilter.Text('Query', '')
		);
		expect(k.size(filters)).toBe(2);
		expect(k.map(filters, (f: { name: string }) => f.name)).toEqual(['Filters', 'Query']);
		// Given a list rather than varargs, which both appear in the Kotlin.
		expect(k.size(runtime.globals.AnimeFilterList([1, 2, 3]))).toBe(3);
	});

	it('parses the upload dates a list page carries', () => {
		const format = runtime.globals.SimpleDateFormat('dd MMM yyyy', runtime.globals.Locale.ENGLISH);
		expect(format.parse('05 Mar 2024')?.time).toBe(Date.UTC(2024, 2, 5));
		expect(format.parse('5 March 2024')?.time).toBe(Date.UTC(2024, 2, 5));
		// Unparseable answers null, because the idiom around it is `?.time ?: 0L`
		// and a throw there would lose an episode list over a date nobody reads.
		expect(format.parse('not a date')).toBeNull();
		expect(format.parse('05 Xyz 2024')).toBeNull();

		const stamped = runtime.globals.SimpleDateFormat('yyyy-MM-dd HH:mm:ss');
		expect(stamped.parse('2024-03-05 07:08:09')?.time).toBe(Date.UTC(2024, 2, 5, 7, 8, 9));
		expect(stamped.format(Date.UTC(2024, 2, 5, 7, 8, 9))).toBe('2024-03-05 07:08:09');

		const meridiem = runtime.globals.SimpleDateFormat('MMM d, yyyy h:mm a');
		expect(meridiem.parse('Mar 5, 2024 1:30 PM')?.time).toBe(Date.UTC(2024, 2, 5, 13, 30));
	});

	it('names the regex options a scraper writes rather than flags', () => {
		expect(k.regex('hd', runtime.globals.RegexOption.IGNORE_CASE).containsMatchIn('HD')).toBe(true);
		expect(() => k.regex('a', runtime.globals.RegexOption.COMMENTS).find('a')).toThrow(/COMMENTS/);
	});

	it('constructs the filter types with their declared default state', () => {
		const filters = runtime.globals.AnimeFilter;
		expect(new filters.Select('Genre', ['All', 'Action'], 1).state).toBe(1);
		expect(filters.Text('Query', '').state).toBe('');
		expect(filters.CheckBox('Dub', true).state).toBe(true);
		expect(filters.TriState('Tag').state).toBe(0);
		expect(filters.Group('Genres', []).state).toEqual([]);
		expect(filters.Header('Filters').name).toBe('Filters');
		expect(filters.Separator().name).toBe('');
		expect(filters.Sort('Order', ['Latest'], null).values).toEqual(['Latest']);
	});
});

/* ── chars, and the string helpers built on them ──────────────────────────── */

describe('a Kotlin Char, which this runtime spells as a one-character string', () => {
	it('calls every Unicode decimal a digit, not only 0 to 9', () => {
		expect(k.isDigit('7')).toBe(true);
		expect(k.isDigit('x')).toBe(false);
		expect(k.isDigit('')).toBe(false);
		expect(k.isDigit(null)).toBe(false);
		// The difference from `/[0-9]/`: Kotlin's isDigit is every Unicode Nd,
		// so a title in Arabic-Indic numerals keeps its digits either way.
		expect(k.isDigit('٧')).toBe(true);
	});

	it('separates letters, digits and whitespace the way Kotlin does', () => {
		expect(k.isLetter('é')).toBe(true);
		expect(k.isLetter('4')).toBe(false);
		expect(k.isLetterOrDigit('4')).toBe(true);
		expect(k.isLetterOrDigit('-')).toBe(false);
		expect(k.isWhitespace(' ')).toBe(true);
		expect(k.isWhitespace(' ')).toBe(true);
		expect(k.isWhitespace('')).toBe(false);
	});

	it('throws from digitToInt where Number() would answer NaN', () => {
		expect(k.digitToInt('9')).toBe(9);
		expect(() => k.digitToInt('a')).toThrow(/is not one/);
		expect(k.digitToInt('٣')).toBe(3);
	});

	it('replaces the first character and leaves the rest alone', () => {
		expect(k.replaceFirstChar('naruto', (c: string) => k.uppercase(c))).toBe('Naruto');
		expect(k.replaceFirstChar('naruto', (c: string) => k.titlecase(c))).toBe('Naruto');
		// An empty receiver never reaches the lambda: capitalising nothing must
		// not be able to produce something.
		expect(k.replaceFirstChar('', () => 'X')).toBe('');
		// Kotlin lets the lambda lengthen the string, and so does this.
		expect(k.replaceFirstChar('bc', () => 'AA')).toBe('AAc');
	});

	it('walks a String as its characters, not as one value', () => {
		// `__arr` has to read a bare string as a single value, because that is
		// what `orEmpty()` hands it. The CharSequence overloads must not.
		expect(k.all('123', (c: string) => k.isDigit(c))).toBe(true);
		expect(k.all('12a', (c: string) => k.isDigit(c))).toBe(false);
		expect(k.any('abc', (c: string) => k.isDigit(c))).toBe(false);
		expect(k.count('a1b2', (c: string) => k.isDigit(c))).toBe(2);
		// Kotlin's CharSequence.filter answers a CharSequence, not a List<Char>.
		expect(k.filter('a1b2', (c: string) => k.isDigit(c))).toBe('12');
		expect(k.filter([1, 2, 3], (n: number) => n > 1)).toEqual([2, 3]);
	});
});

describe('the string helpers added for the catalogue', () => {
	it('decodes bytes where JavaScript String() would print their numbers', () => {
		const bytes = new TextEncoder().encode('héllo');
		// The failure this exists to stop: String(bytes) in JavaScript is
		// '104,101,...' — a string, so nothing downstream errors.
		expect(String(bytes)).not.toBe('héllo');
		expect(k.stringOf(bytes)).toBe('héllo');
		expect(k.stringOf(bytes, runtime.globals.Charsets.UTF_8)).toBe('héllo');
		// A CharArray is joined, not decoded.
		expect(k.stringOf(['a', 'b'])).toBe('ab');
		expect(k.stringOf(null)).toBe('');
	});

	it('refuses a charset the host cannot do rather than guessing UTF-8', () => {
		const bytes = new TextEncoder().encode('x');
		expect(() => k.stringOf(bytes, runtime.globals.Charsets.ISO_8859_1)).toThrow(
			/only offers UTF-8/
		);
		expect(() => k.toByteArray('x', runtime.globals.Charsets.UTF_16)).toThrow(/only offers UTF-8/);
	});

	it('encodes to bytes and back', () => {
		expect(new TextDecoder().decode(k.toByteArray('héllo'))).toBe('héllo');
		expect(k.toCharArray('abc')).toEqual(['a', 'b', 'c']);
		expect(k.contentEquals(k.toByteArray('ab'), k.toByteArray('ab'))).toBe(true);
		expect(k.contentEquals(k.toByteArray('ab'), k.toByteArray('ac'))).toBe(false);
		// Two arrays holding the same bytes are different objects, so === says
		// 'different' where Kotlin says 'equal'.
		expect(k.toByteArray('ab') === k.toByteArray('ab')).toBe(false);
	});

	it('compares structurally, and ignoring case when asked', () => {
		expect(k.equalsTo('Accept-Ranges', 'accept-ranges', true)).toBe(true);
		expect(k.equalsTo('Accept-Ranges', 'accept-ranges')).toBe(false);
		// Kotlin's == over two equal lists is true; JavaScript's === is not.
		expect(k.equalsTo([1, 2], [1, 2])).toBe(true);
		expect(k.equalsTo(null, undefined)).toBe(true);
		expect(k.equalsTo(null, 0)).toBe(false);
		expect(k.compareTo('a', 'b')).toBeLessThan(0);
		expect(k.compareTo(2, 2)).toBe(0);
	});

	it('replaces the first occurrence only, dollar signs and all', () => {
		expect(k.replaceFirst('a&b&c', '&', '?')).toBe('a?b&c');
		// Absent delimiter leaves the string alone rather than appending.
		expect(k.replaceFirst('abc', '&', '?')).toBe('abc');
		// A literal '$&' in the replacement is a literal, where JavaScript's
		// String.replace would substitute the whole match for it.
		expect(k.replaceFirst('ab', 'a', '$&')).toBe('$&b');
		expect(k.replaceFirst('[ru] Title', k.regex('^\\[\\w+\\] ?'), '')).toBe('Title');
	});

	it('repeats, and splits lines on all three endings', () => {
		expect(k.repeat('ab', 3)).toBe('ababab');
		expect(k.repeat('ab', 0)).toBe('');
		expect(() => k.repeat('ab', -1)).toThrow(/repeated/);
		// The '\r' a naive split('\n') leaves behind is why this exists.
		expect(k.lines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
	});
});

/* ── numbers, comparators and the long tail of collections ────────────────── */

describe('the number helpers', () => {
	it('rounds away from zero, as Kotlin does and Math.round does not', () => {
		expect(k.roundToInt(2.5)).toBe(3);
		// Math.round(-2.5) is -2; Kotlin's roundToInt is -3.
		expect(k.roundToInt(-2.5)).toBe(-3);
		expect(() => k.roundToInt('x')).toThrow();
	});

	it('coerces into a range, and refuses an empty one', () => {
		expect(k.coerceAtLeast(-1, 0)).toBe(0);
		expect(k.coerceAtMost(9, 5)).toBe(5);
		expect(k.coerceIn(7, 0, 5)).toBe(5);
		expect(k.coerceIn(-1, 0, 5)).toBe(0);
		expect(() => k.coerceIn(1, 5, 0)).toThrow(/empty range/);
	});

	it('subtracts a number and removes from a collection under one name', () => {
		expect(k.minus(7, 2)).toBe(5);
		expect(k.minus(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
		// A single element removes its first occurrence only, which is Kotlin's.
		expect(k.minus(['a', 'b', 'a'], 'a')).toEqual(['b', 'a']);
	});

	it('negates with no argument and filters a selection with one', () => {
		expect(k.not(false)).toBe(true);
		const doc = k.asJsoup('<div><a class="x">one</a><a>two</a></div>');
		expect(k.eachText(k.not(doc.select('a'), '.x'))).toEqual(['two']);
	});
});

describe('sorting with a comparator', () => {
	const videos = [
		{ title: 'b', hd: false },
		{ title: 'a', hd: true },
		{ title: 'c', hd: true }
	];

	it('sorts by several keys, the first difference deciding', () => {
		const order = k.sortedWith(
			videos,
			k.compareBy(
				(v: { hd: boolean }) => v.hd,
				(v: { title: string }) => v.title
			)
		);
		// false sorts before true, which is what `compareBy { it.contains(q) }`
		// followed by `.reversed()` relies on.
		expect(order.map((v: { title: string }) => v.title)).toEqual(['b', 'a', 'c']);
	});

	it('reverses a comparator rather than reading it as a one-item list', () => {
		const byTitle = k.compareBy((v: { title: string }) => v.title);
		const order = k.sortedWith(videos, k.reversed(byTitle));
		expect(order.map((v: { title: string }) => v.title)).toEqual(['c', 'b', 'a']);
		// The same helper still reverses a list, and a string as a string.
		expect(k.reversed([1, 2])).toEqual([2, 1]);
		expect(k.reversed('abc')).toBe('cba');
	});

	it('chains a second key with thenBy and thenByDescending', () => {
		const order = k.sortedWith(
			videos,
			k.thenByDescending(
				k.compareByDescending((v: { hd: boolean }) => v.hd),
				(v: { title: string }) => v.title
			)
		);
		expect(order.map((v: { title: string }) => v.title)).toEqual(['c', 'a', 'b']);
	});

	it('is stable, because a reordered episode list is visible', () => {
		const same = [
			{ id: 1, key: 'x' },
			{ id: 2, key: 'x' },
			{ id: 3, key: 'x' }
		];
		const order = k.sortedWith(
			same,
			k.compareBy((v: { key: string }) => v.key)
		);
		expect(order.map((v: { id: number }) => v.id)).toEqual([1, 2, 3]);
	});
});

describe('the rest of the collection helpers', () => {
	it('keeps the first item of each key, not the last', () => {
		const items = [
			{ url: 'a', n: 1 },
			{ url: 'b', n: 2 },
			{ url: 'a', n: 3 }
		];
		expect(
			k.distinctBy(items, (i: { url: string }) => i.url).map((i: { n: number }) => i.n)
		).toEqual([1, 2]);
		expect(k.distinctBy([], () => 1)).toEqual([]);
	});

	it('stops at the first lambda that answers something', () => {
		const seen: number[] = [];
		const found = k.firstNotNullOfOrNull([1, 2, 3], (n: number) => {
			seen.push(n);
			return n === 2 ? 'two' : null;
		});
		expect(found).toBe('two');
		// The point of the helper: the third lambda never runs.
		expect(seen).toEqual([1, 2]);
		expect(k.firstNotNullOfOrNull([1], () => null)).toBeNull();
		expect(k.firstNotNullOfOrNull(null, () => 'x')).toBeNull();
	});

	it('passes the index first, the way Kotlin does', () => {
		const pairs: string[] = [];
		k.forEachIndexed(['a', 'b'], (index: number, value: string) => {
			pairs.push(`${index}:${value}`);
		});
		expect(pairs).toEqual(['0:a', '1:b']);
		expect(k.mapIndexedNotNull(['a', 'b'], (i: number, v: string) => (i === 0 ? null : v))).toEqual(
			['b']
		);
		expect(k.filterIndexed(['a', 'b', 'c'], (i: number) => i % 2 === 0)).toEqual(['a', 'c']);
	});

	it('answers the receiver from onEach and the extreme item from the *By helpers', () => {
		const seen: number[] = [];
		expect(k.onEach([1, 2], (n: number) => seen.push(n))).toEqual([1, 2]);
		expect(seen).toEqual([1, 2]);
		expect(k.maxOrNull([3, 1, 2])).toBe(3);
		expect(k.minOrNull([])).toBeNull();
		expect(k.maxOfOrNull([{ n: 1 }, { n: 4 }], (i: { n: number }) => i.n)).toBe(4);
		// Kotlin keeps the FIRST element carrying the extreme key.
		const tied = [
			{ id: 1, n: 5 },
			{ id: 2, n: 5 }
		];
		expect(k.maxByOrNull(tied, (i: { n: number }) => i.n).id).toBe(1);
		expect(k.minByOrNull([], () => 1)).toBeNull();
		expect(k.indexOfLast([1, 2, 1], (n: number) => n === 1)).toBe(2);
	});

	it('throws from single() unless there is exactly one', () => {
		expect(k.single(['only'])).toBe('only');
		expect(k.singleOrNull(['a', 'b'])).toBeNull();
		expect(k.singleOrNull([])).toBeNull();
		// The failure a `first()` spelled `single()` would hide: a page that
		// answered more than the extension expected.
		expect(() => k.single(['a', 'b'])).toThrow(/exactly one/);
		expect(() => k.single([])).toThrow(/exactly one/);
		expect(k.single('x')).toBe('x');
	});

	it('takes and drops from either end, over a list or a string', () => {
		expect(k.dropLast([1, 2, 3], 1)).toEqual([1, 2]);
		expect(k.takeLast([1, 2, 3], 2)).toEqual([2, 3]);
		// Kotlin clamps rather than throwing, and a String answers a String —
		// which is what `take` and `drop` had been getting wrong.
		expect(k.dropLast([1], 5)).toEqual([]);
		expect(k.take('abcd', 2)).toBe('ab');
		expect(k.drop('abcd', 2)).toBe('cd');
		expect(k.dropLast('abcd', 1)).toBe('abc');
		expect(k.takeLast('abcd', 2)).toBe('cd');
		expect(k.takeWhile('12a3', (c: string) => k.isDigit(c))).toBe('12');
		expect(k.dropWhile('12a3', (c: string) => k.isDigit(c))).toBe('a3');
		expect(k.takeWhile([1, 2], () => true)).toEqual([1, 2]);
	});

	it('slices by index list and refuses a sublist outside the list', () => {
		expect(k.subList([1, 2, 3, 4], 1, 3)).toEqual([2, 3]);
		// Kotlin throws here; Array.slice would silently clamp and answer short.
		expect(() => k.subList([1, 2], 0, 5)).toThrow(/of a list of 2/);
		expect(k.slice(['a', 'b', 'c'], k.until(1, 3))).toEqual(['b', 'c']);
		expect(k.slice('abcd', k.range(1, 2))).toBe('bc');
	});

	it('folds and reduces, and throws on an empty reduce', () => {
		expect(k.fold([1, 2, 3], 0, (acc: number, n: number) => acc + n)).toBe(6);
		expect(k.fold([], 'seed', () => 'x')).toBe('seed');
		expect(k.reduce([1, 2, 3], (a: number, b: number) => a + b)).toBe(6);
		expect(() => k.reduce([], () => 0)).toThrow(/empty list/);
	});

	it('picks an element at random rather than answering a float', () => {
		// The wrong answer here is Math.random(): a number in [0, 1) used as an
		// element or as an Int in a range is a wrong value at every call site.
		expect([1, 2, 3]).toContain(k.random([1, 2, 3]));
		expect(k.range(1, 5)).toContain(k.random(k.range(1, 5)));
		expect(() => k.random([])).toThrow(/empty collection/);
	});

	it('removes from a list and from a header builder under one name', () => {
		const list = k.mutableListOf('a', 'b', 'a');
		expect(k.removeAll(list, 'a')).toBe(true);
		expect(list).toEqual(['b']);
		expect(k.removeAll(k.mutableListOf('a'), 'z')).toBe(false);
		expect(k.removeAll(k.mutableListOf(1, 2, 3), (n: number) => n > 1)).toBe(true);

		const built = k
			.removeAll(
				runtime.globals.Headers.Builder().add('Referer', 'x').add('Accept', 'y'),
				'Referer'
			)
			.build();
		// A builder must answer itself, or the chain after it stops building.
		expect(built.Accept).toBe('y');
		expect(built.Referer).toBeUndefined();
	});

	it('makes a Sequence eager rather than a one-item list of itself', () => {
		expect(k.asSequence([1, 2])).toEqual([1, 2]);
		expect(k.map(k.asSequence([1, 2]), (n: number) => n * 2)).toEqual([2, 4]);
		expect(k.asReversed([1, 2])).toEqual([2, 1]);
		expect(k.sorted([3, 1, 2])).toEqual([1, 2, 3]);
		expect(k.sortedDescending([3, 1, 2])).toEqual([3, 2, 1]);
	});
});

describe('a suspending lambda handed to one of the new helpers', () => {
	it('is awaited rather than tested for truthiness', async () => {
		// The worst failure available: a Promise is always truthy, so a helper
		// that tested one would keep everything and look like it filtered.
		expect(
			await k.distinctBy([{ u: 'a' }, { u: 'a' }], async (i: { u: string }) => i.u)
		).toHaveLength(1);
		expect(await k.takeWhile([1, 2, 3], async (n: number) => n < 3)).toEqual([1, 2]);
		expect(await k.firstNotNullOfOrNull([1, 2], async (n: number) => (n === 2 ? 'x' : null))).toBe(
			'x'
		);
		expect(await k.fold([1, 2], 0, async (acc: number, n: number) => acc + n)).toBe(3);
		expect(await k.reduce([1, 2, 3], async (a: number, b: number) => a + b)).toBe(6);
		expect(await k.maxByOrNull([{ n: 1 }, { n: 2 }], async (i: { n: number }) => i.n)).toEqual({
			n: 2
		});
		expect(await k.single([1, 2], async (n: number) => n === 2)).toBe(2);
		const seen: number[] = [];
		await k.forEachIndexed([1, 2], async (_i: number, n: number) => {
			seen.push(n);
		});
		expect(seen).toEqual([1, 2]);
	});
});

/* ── Result, past getOrNull ───────────────────────────────────────────────── */

describe('the Result runCatching builds', () => {
	it('runs onFailure and answers the same Result, so the chain survives', () => {
		let caught: unknown = null;
		const failed = k.runCatching(() => {
			throw new Error('down');
		});
		expect(
			k
				.onFailure(failed, (error: Error) => {
					caught = error;
				})
				.getOrNull()
		).toBeNull();
		expect((caught as Error).message).toBe('down');

		let ran = false;
		const ok = k.runCatching(() => 'value');
		expect(
			k
				.onFailure(ok, () => {
					ran = true;
				})
				.getOrNull()
		).toBe('value');
		expect(ran).toBe(false);
	});

	it('maps and folds a Result rather than reading it as a list', () => {
		const ok = k.runCatching(() => 2);
		// Without the receiver branch the lambda would be handed the wrapper.
		expect(k.map(ok, (n: number) => n + 1).getOrNull()).toBe(3);
		expect(k.map([1, 2], (n: number) => n + 1)).toEqual([2, 3]);
		expect(
			k.fold(
				ok,
				(n: number) => `ok ${n}`,
				() => 'failed'
			)
		).toBe('ok 2');
		const bad = k.runCatching(() => {
			throw new Error('x');
		});
		expect(k.map(bad, () => 1).isFailure).toBe(true);
		expect(
			k.fold(
				bad,
				() => 'ok',
				(e: Error) => `failed ${e.message}`
			)
		).toBe('failed x');
	});

	it('reads getOrDefault and getOrElse off a Result, not as a lookup', () => {
		// `runCatching { … }.getOrDefault(x)` passes one argument. A helper
		// written only for `(collection, key, fallback)` reads it as an index
		// into the Result, misses, and answers the fallback — for a SUCCESS.
		const ok = k.runCatching(() => 7);
		expect(k.getOrDefault(ok, -1)).toBe(7);
		expect(k.getOrNull(ok)).toBe(7);
		expect(k.getOrElse(ok, () => -1)).toBe(7);

		const bad = k.runCatching(() => {
			throw new Error('down');
		});
		expect(k.getOrDefault(bad, -1)).toBe(-1);
		expect(k.getOrNull(bad)).toBeNull();
		expect(k.getOrElse(bad, (error: Error) => error.message)).toBe('down');

		// A collection lookup is untouched by any of that.
		expect(k.getOrDefault(['a', 'b'], 1, 'z')).toBe('b');
		expect(k.getOrDefault(['a'], 5, 'z')).toBe('z');
	});

	it('runs onSuccess only on a success', () => {
		let seen: unknown = null;
		k.onSuccess(
			k.runCatching(() => 5),
			(value: number) => {
				seen = value;
			}
		);
		expect(seen).toBe(5);
	});
});

/* ── Calendar, Base64, the shapes built by hand ───────────────────────────── */

describe('the java and android types an extension names', () => {
	it('reads Calendar fields as UTC, with java numbering', () => {
		const calendar = runtime.globals.Calendar.getInstance();
		calendar.timeInMillis = Date.UTC(2021, 4, 17, 9, 30, 15);
		const Calendar = runtime.globals.Calendar;
		expect(calendar.get(Calendar.YEAR)).toBe(2021);
		// MONTH is 0-based in java too; reading it as 1-based is the classic
		// off-by-one, and it is a wrong value rather than an error.
		expect(calendar.get(Calendar.MONTH)).toBe(4);
		expect(calendar.get(Calendar.DAY_OF_MONTH)).toBe(17);
		expect(calendar.get(Calendar.HOUR_OF_DAY)).toBe(9);
		// DAY_OF_WEEK counts from Sunday = 1; 2021-05-17 was a Monday.
		expect(calendar.get(Calendar.DAY_OF_WEEK)).toBe(2);
		expect(calendar.get(Calendar.MINUTE)).toBe(30);
		expect(() => calendar.get(99)).toThrow(/does not model/);
	});

	it('moves a Calendar by a field and clones without aliasing', () => {
		const Calendar = runtime.globals.Calendar;
		const calendar = Calendar.getInstance();
		calendar.timeInMillis = Date.UTC(2021, 11, 31);
		calendar.add(Calendar.DAY_OF_MONTH, 1);
		expect(calendar.get(Calendar.YEAR)).toBe(2022);
		const copy = calendar.clone();
		copy.add(Calendar.YEAR, 1);
		expect(calendar.get(Calendar.YEAR)).toBe(2022);
		expect(copy.get(Calendar.YEAR)).toBe(2023);
		expect(calendar.time.time).toBe(calendar.timeInMillis);
	});

	it('gives the year the whole ecosystem builds a filter out of', () => {
		const Calendar = runtime.globals.Calendar;
		expect(Calendar.getInstance().get(Calendar.YEAR)).toBe(new Date().getUTCFullYear());
	});

	it('encodes and decodes base64 through the host, flags and all', () => {
		const { ctx } = context();
		runtime.enter(ctx);
		const Base64 = runtime.globals.Base64;
		const bytes = k.toByteArray('ab~cd?ef');

		// NO_WRAP is what every extension actually passes.
		const wrapped = Base64.encodeToString(bytes, Base64.NO_WRAP);
		expect(wrapped).not.toContain('\n');
		expect(k.stringOf(Base64.decode(wrapped))).toBe('ab~cd?ef');

		// URL_SAFE swaps '+/' for '-_'; encoding without it yields a token the
		// far end rejects, which reads as an empty page rather than an error.
		const urlSafe = Base64.encodeToString(k.toByteArray('øÿ~'), Base64.URL_SAFE | Base64.NO_WRAP);
		expect(urlSafe).not.toMatch(/[+/]/);
		expect(k.stringOf(Base64.decode(urlSafe))).toBe('øÿ~');

		// DEFAULT wraps at 76 and ends with a newline, as Android's does.
		const long = Base64.encodeToString(k.toByteArray('x'.repeat(120)), Base64.DEFAULT);
		expect(long.split('\n')[0]).toHaveLength(76);
		expect(long.endsWith('\n')).toBe(true);

		// No padding, and the other alphabet, both still decode.
		expect(k.stringOf(Base64.decode('YWJj'))).toBe('abc');
		expect(k.stringOf(Base64.decode('YQ'))).toBe('a');
		expect(new TextDecoder().decode(Base64.encode(k.toByteArray('a'), Base64.NO_WRAP))).toBe(
			'YQ=='
		);
	});

	it('builds a Triple, a Date and a StringBuilder', () => {
		const triple = k.triple(1, 'two', 3);
		expect(triple.first).toBe(1);
		expect(triple.third).toBe(3);
		expect(k.destructured(triple)).toEqual([1, 'two', 3]);

		expect(k.dateOf(1_600_000_000_000).time).toBe(1_600_000_000_000);

		const builder = k.stringBuilder('/player');
		builder.append('?id=').append(7);
		expect(k.toStringOf(builder)).toBe('/player?id=7');
		expect(builder.length).toBe(12);
		// A number is a CAPACITY, not content: 'StringBuilder(16)' starts empty,
		// and reading the 16 as text would prefix everything built after it.
		expect(k.toStringOf(k.stringBuilder(16).append('x'))).toBe('x');
		expect(k.stringBuilder().isEmpty()).toBe(true);
	});

	it('answers 0 from tryParse rather than losing the episode list', () => {
		const format = runtime.globals.SimpleDateFormat('yyyy-MM-dd', runtime.globals.Locale.ENGLISH);
		expect(k.tryParse(format, '2021-05-17')).toBe(Date.UTC(2021, 4, 17));
		// The idiom around it is `?.time ?: 0L`, and a throw here would cost the
		// whole page over an upload date nobody displays.
		expect(k.tryParse(format, 'not a date')).toBe(0);
		expect(k.tryParse(format, null)).toBe(0);
		expect(k.tryParse(null, '2021-05-17')).toBe(0);
	});
});

/* ── request bodies, and the one that is refused ──────────────────────────── */

describe('a request body an extension builds itself', () => {
	it('keeps the content type, which is what makes the post readable', async () => {
		const { ctx, sent } = context({
			'https://example.invalid/api': { body: 'ok' }
		});
		runtime.enter(ctx);
		const body = k.toRequestBody('a=1&b=2', k.toMediaType('application/x-www-form-urlencoded'));
		await runtime.globals.POST('https://example.invalid/api', null, body);
		await runtime.client
			.newCall(runtime.globals.POST('https://example.invalid/api', null, body))
			.execute();
		expect(sent[0].body).toBe('a=1&b=2');
		// Without the type the far end reads the form as something else, which
		// comes back as an empty result rather than as an error.
		expect(sent[0].headers['Content-Type']).toBe('application/x-www-form-urlencoded');
	});

	it('posts a JSON string body with the json content type', async () => {
		const { ctx, sent } = context({
			'https://example.invalid/g': { body: '{}' }
		});
		runtime.enter(ctx);
		await runtime.client
			.newCall(
				runtime.globals.POST('https://example.invalid/g', null, k.toJsonRequestBody('{"q":1}'))
			)
			.execute();
		expect(sent[0].body).toBe('{"q":1}');
		expect(sent[0].headers['Content-Type']).toBe('application/json; charset=utf-8');
	});

	it('builds the catalogue JSON body shorthand', () => {
		expect(k.toJsonBody('{"q":1}')).toMatchObject({
			contentType: 'application/json; charset=utf-8',
			text: '{"q":1}'
		});
	});

	it('builds okhttp requests with a POST body', () => {
		const body = k.toRequestBody('payload', 'text/plain');
		const request = runtime.globals.Request.Builder()
			.url('https://example.invalid/submit')
			.addHeader('X-Test', 'yes')
			.post(body)
			.build();

		expect(request.method).toBe('POST');
		expect(request.url).toBe('https://example.invalid/submit');
		expect(request.headers.get('X-Test')).toBe('yes');
		expect(request.body.text).toBe('payload');
	});

	it('refuses to serialise an object, because the wire names are not here', () => {
		// A @SerialName rename is carried only on the decode side, so encoding a
		// DTO would post the Kotlin field names and the far end would answer 200
		// with nothing in it — a source that looks like it has gone quiet.
		expect(() => k.toJsonRequestBody({ q: 1 })).toThrow(/only for decoding/);
		expect(() => k.toRequestBody({ q: 1 }, 'application/json')).toThrow(/as text/);
	});
});

/* ── jsoup, upwards ───────────────────────────────────────────────────────── */

describe('closest(), the one selector call that walks up', () => {
	const html =
		'<div class="card" id="outer"><div class="row"><a href="/x">one</a></div></div>' +
		'<p><a href="/y">two</a></p>';

	it('answers the element itself before any ancestor', () => {
		const doc = k.asJsoup(html);
		const link = doc.selectFirst('a[href="/x"]');
		expect(k.closest(link, 'a').text()).toBe('one');
		expect(k.closest(link, '.card').attr('id')).toBe('outer');
	});

	it('answers null when nothing above it matches', () => {
		const doc = k.asJsoup(html);
		expect(k.closest(doc.selectFirst('a[href="/y"]'), '.card')).toBeNull();
		expect(k.closest(null, '.card')).toBeNull();
	});

	it('reads a selection as its first element, which is what the call sites mean', () => {
		const doc = k.asJsoup(html);
		expect(k.closest(doc.select('a'), '.row').attr('class')).toBe('row');
		expect(k.closest(doc.select('span'), '.row')).toBeNull();
	});

	it('gets the base url back through ownerDocument', () => {
		const { ctx } = context({
			'https://example.invalid/page': {
				body: html,
				url: 'https://example.invalid/final'
			}
		});
		runtime.enter(ctx);
		const doc = k.asJsoup(html);
		// A document owns itself, as it does in jsoup, so the idiom works either
		// way round: `element.ownerDocument()!!.location()`.
		expect(k.ownerDocument(doc)).toBe(doc);
		expect(k.ownerDocument(doc.selectFirst('a')).location()).toBe(doc.location());
		expect(k.ownerDocument(null)).toBeNull();
	});
});

describe('printStackTrace, which onFailure almost always contains', () => {
	it('logs and never rethrows, because the mirror is meant to be lost', () => {
		const { ctx, logged } = context();
		runtime.enter(ctx);

		const result = k.onFailure(
			k.runCatching(() => {
				throw new Error('mirror down');
			}),
			(error: Error) => k.printStackTrace(error)
		);

		expect(logged).toEqual(['mirror down']);
		// The chain after it has to keep working: the shape is
		// `.onFailure { it.printStackTrace() }.getOrNull()`.
		expect(result.getOrNull()).toBeNull();
		expect(() => k.printStackTrace(null)).not.toThrow();
	});
});

/* ── the receiver a block is handed ───────────────────────────────────────── */

describe('a block the emitter wrote as a receiver function', () => {
	// The emitter writes `x.apply { title = "y" }` as
	// `__k.apply(x, function () { this.title = 'y'; })`. A bundle is an ES
	// module, so it is strict, so calling that as `fn(value)` leaves `this`
	// undefined and every one of those blocks dies with `undefined is not an
	// object` — on the first search, inside the sandbox. These drive the exact
	// shape the emitter produces rather than an `it` lambda, which would pass
	// either way and prove nothing.

	it('binds the receiver as `this` for apply, run and with', () => {
		const anime = k.apply({ title: '' }, function (this: { title: string }) {
			this.title = 'One';
		});
		expect(anime).toEqual({ title: 'One' });

		expect(
			k.run({ n: 2 }, function (this: { n: number }) {
				return this.n * 3;
			})
		).toBe(6);
	});

	it('binds it for buildString, and answers the text rather than the block', () => {
		expect(
			k.buildString(function (this: { append(value: unknown): unknown }) {
				this.append('a');
				return this.append('b');
			})
		).toBe('ab');
	});

	it('takes a receiver form of runCatching without reading it as the block', () => {
		// `x.runCatching { … }` reaches the same helper with the receiver first.
		// Reading that receiver as the block calls a string.
		const result = k.runCatching('input', function (this: string) {
			return this.toUpperCase();
		});
		expect(result.getOrNull()).toBe('INPUT');
		expect(k.runCatching(() => 4).getOrNull()).toBe(4);
	});
});

describe('the builders whose block is handed a receiver', () => {
	it('answers the list, not the value of the block’s last statement', () => {
		const built = k.buildList(function (this: unknown) {
			k.add(this, 'a');
			// `add` answers a boolean in Kotlin, and a helper returning the
			// block's value would hand back `true` instead of a list of two.
			return k.add(this, 'b');
		});
		expect(built).toEqual(['a', 'b']);
		expect(k.buildList(function () {})).toEqual([]);
	});

	it('reads a leading number as a capacity, never as content', () => {
		const built = k.buildList(2, function (this: unknown) {
			k.add(this, 'only');
		});
		expect(built).toEqual(['only']);
	});

	it('builds a Map, with Kotlin’s names for putting into one', () => {
		const built = k.buildMap(function (this: { put(k: unknown, v: unknown): unknown }) {
			this.put('a', 1);
			this.put('b', 2);
		});
		expect(built.get('a')).toBe(1);
		expect(k.size(built)).toBe(2);
	});

	it('builds a JSON object and array as the plain values they describe', () => {
		const object = k.buildJsonObject(function (this: { put(k: string, v: unknown): unknown }) {
			this.put('q', 'query');
			this.put('page', 2);
		});
		expect(object).toEqual({ q: 'query', page: 2 });
		// The mark that lets `toJsonRequestBody` serialise it must not be a field.
		expect(JSON.stringify(object)).toBe('{"q":"query","page":2}');

		const array = k.buildJsonArray(function (this: { add(v: unknown): unknown }) {
			this.add(1);
			this.add('two');
		});
		expect(array).toEqual([1, 'two']);
		expect(k.jsonArrayOf([1, 2])).toEqual([1, 2]);
		expect(k.jsonPrimitiveOf('x')).toBe('x');
	});

	it('lets a built JSON object become a request body, unlike a DTO', () => {
		const object = k.buildJsonObject(function (this: { put(k: string, v: unknown): unknown }) {
			this.put('q', 'query');
		});
		// Safe because the extension wrote these keys itself — there is no
		// `@SerialName` rename to lose, which is why a plain object is refused.
		expect(k.toJsonRequestBody(object).text).toBe('{"q":"query"}');
		expect(() => k.toJsonRequestBody({ q: 'query' })).toThrow(/only for decoding/);
	});
});

describe('require, which throws where a boolean would carry on', () => {
	it('passes a true condition through and throws on a false one', () => {
		expect(k.require(true, () => 'unused')).toBeUndefined();
		// The idiom: the extension asserting the page it parsed was not empty,
		// and meaning that failure to reach the viewer.
		expect(() => k.require(false, () => 'No streams available!')).toThrow(/No streams available!/);
		expect(() => k.require(false)).toThrow(/was not true/);
	});

	it('only builds the message when the check failed', () => {
		let built = 0;
		k.require(true, () => {
			built += 1;
			return 'x';
		});
		expect(built).toBe(0);
	});

	it('answers the value from requireNotNull', () => {
		expect(k.requireNotNull('x', () => 'm')).toBe('x');
		expect(() => k.requireNotNull(null, () => 'no element')).toThrow(/no element/);
		expect(() => k.requireNotNull(undefined)).toThrow(/was null/);
	});
});

/* ── joinToString, over Kotlin’s whole signature ──────────────────────────── */

describe('joinToString as its named arguments arrive', () => {
	it('keeps the separator, prefix and postfix in their own slots', () => {
		// `joinToString(prefix = "a: ") { … }` arrives with the separator slot
		// absent, so argument two is the PREFIX and not the transform.
		expect(
			k.joinToString(
				['x', 'y'],
				undefined,
				'Scanlated by: ',
				undefined,
				undefined,
				undefined,
				(v: string) => v.toUpperCase()
			)
		).toBe('Scanlated by: X, Y');
		expect(k.joinToString(['x', 'y'], ' | ')).toBe('x | y');
		expect(k.joinToString(['x', 'y'], '', undefined, undefined, undefined, undefined)).toBe('xy');
		expect(k.joinToString(['x'], ', ', '[', ']')).toBe('[x]');
	});

	it('still takes the two shapes it always took', () => {
		expect(k.joinToString(['a', 'b'], (v: string) => v + '!')).toBe('a!, b!');
		expect(k.joinToString(['a', 'b'], { separator: '-', prefix: '<', postfix: '>' })).toBe('<a-b>');
		expect(k.joinToString([])).toBe('');
	});

	it('truncates at a limit, which a helper without one lengthens silently', () => {
		expect(k.joinToString([1, 2, 3, 4], ', ', '', '', 2, '…')).toBe('1, 2, …');
		expect(k.joinToString([1, 2], ', ', '', '', 5, '…')).toBe('1, 2');
	});

	it('awaits a suspending transform rather than joining promises', async () => {
		expect(
			await k.joinToString(['a', 'b'], '-', '', '', -1, '...', async (v: string) => v + '1')
		).toBe('a1-b1');
	});
});

/* ── the last of the long tail ────────────────────────────────────────────── */

describe('the odds and ends an extension names once', () => {
	it('trims every character it was given, not only the first', () => {
		// Kotlin's is `trim(vararg chars: Char)`. Reading one argument leaves the
		// other quote on the value, which nothing downstream errors on.
		expect(k.trim('"\'title\'"', '"', "'")).toBe('title');
		expect(k.trim('  x  ')).toBe('x');
		expect(k.trim('--x--', '-')).toBe('x');
		expect(k.trim('1x1', (c: string) => k.isDigit(c))).toBe('x');
	});

	it('reads a code as the character at it, not as its digits', () => {
		expect(k.toChar(65)).toBe('A');
		// The failure it exists to stop: String(65) is '65', a string, so
		// nothing errors and the decoded text is unreadable.
		expect(String(65)).toBe('65');
		// A Char receiver is already a character; only a code that is not a
		// number has nothing to answer with.
		expect(k.toChar('AB')).toBe('A');
		expect(() => k.toChar(Number('nope'))).toThrow(/character code/);
	});

	it('runs a bare repeat as a loop, not as a string', () => {
		const seen: number[] = [];
		k.repeatBlock(3, (index: number) => seen.push(index));
		// The other `repeat` answers a string, and routing this one onto it
		// would give '333' and never run the block.
		expect(seen).toEqual([0, 1, 2]);
		expect(k.repeat('3', 3)).toBe('333');
		k.repeatBlock(0, () => seen.push(9));
		k.repeatBlock(-1, () => seen.push(9));
		expect(seen).toEqual([0, 1, 2]);
	});

	it('runs a suspending repeat one turn at a time', async () => {
		const seen: number[] = [];
		await k.repeatBlock(3, async (index: number) => {
			seen.push(index);
		});
		expect(seen).toEqual([0, 1, 2]);
	});

	it('answers null from randomOrNull rather than throwing', () => {
		expect(k.randomOrNull([])).toBeNull();
		expect([1, 2]).toContain(k.randomOrNull([1, 2]));
	});

	it('builds a Sort filter’s Selection and reads a Select filter’s default', () => {
		expect(k.selection(1, true)).toEqual({ index: 1, ascending: true });
		expect(k.selection(0)).toEqual({ index: 0, ascending: false });
		expect(k.isDefault({ state: 0 })).toBe(true);
		expect(k.isDefault({ state: 2 })).toBe(false);
		// A declaration the emitter did resolve keeps winning.
		expect(k.isDefault({ state: 0, isDefault: () => false })).toBe(false);
	});

	it('reads a query parameter through either language’s spelling', () => {
		const url = k.httpUrl('https://example.invalid/e?id=7&sub=en');
		expect(k.getQueryParameter(url, 'id')).toBe('7');
		expect(k.getQueryParameter('https://example.invalid/e?sub=en', 'sub')).toBe('en');
		expect(k.getQueryParameter('https://example.invalid/e', 'missing')).toBeNull();
		expect(k.getQueryParameter(null, 'id')).toBeNull();
		// `Uri.parse(url)` is the android spelling of the same two operations.
		expect(runtime.globals.Uri.parse('https://example.invalid/e?id=9').queryParameter('id')).toBe(
			'9'
		);
	});
});

/* ── java.net.URI, which is not the URL parser next door ──────────────────── */

describe('java.net.URI', () => {
	it('takes a url apart the way the extractors read it', () => {
		// The shape the shared extractor modules use, to rebuild a sibling url:
		// `URI(url).let { "${it.scheme}://${it.host}" }`.
		const uri = k.uri('https://cdn.example.invalid:8443/a/b/file.mp4?token=x#frag');
		expect(uri.scheme).toBe('https');
		expect(uri.host).toBe('cdn.example.invalid');
		expect(uri.port).toBe(8443);
		// `path` excludes the query and the fragment, as java's does.
		expect(uri.path).toBe('/a/b/file.mp4');
		expect(uri.query).toBe('token=x');
		expect(uri.fragment).toBe('frag');
		expect(String(uri)).toBe('https://cdn.example.invalid:8443/a/b/file.mp4?token=x#frag');
	});

	it('accepts a scheme the http parser refuses, which is the point', () => {
		// An extractor reads `.scheme` precisely to REJECT a value. A parser that
		// refused the input would take the branch that says the source changed.
		const blob = k.uri('blob:https://example.invalid/9f8e');
		expect(blob.scheme).toBe('blob');
		expect(blob.isOpaque()).toBe(true);
		expect(k.uri('mailto:someone@example.invalid').scheme).toBe('mailto');
	});

	it('says a relative reference has no scheme and no host', () => {
		const relative = k.uri('../two/three.mp4?a=1');
		expect(relative.scheme).toBeNull();
		expect(relative.host).toBeNull();
		expect(relative.isAbsolute()).toBe(false);
		expect(relative.path).toBe('../two/three.mp4');
		expect(relative.query).toBe('a=1');
	});

	it('keeps the raw half raw and decodes the other', () => {
		const uri = k.uri('https://example.invalid/a%20b/c?q=x%26y');
		expect(uri.rawPath).toBe('/a%20b/c');
		expect(uri.path).toBe('/a b/c');
		expect(uri.rawQuery).toBe('q=x%26y');
		expect(uri.query).toBe('q=x&y');
		// A stray '%' is answered raw rather than losing the conversion.
		expect(k.uri('https://example.invalid/100%sure').path).toBe('/100%sure');
	});

	it('resolves a reference by RFC 3986, which a string join is not', () => {
		const base = k.uri('https://example.invalid/a/b/c.m3u8?v=1');
		// A sibling: the last segment is replaced, not appended to.
		expect(String(k.resolve(base, 'd.ts'))).toBe('https://example.invalid/a/b/d.ts');
		// '..' pops a segment rather than surviving into the path.
		expect(String(k.resolve(base, '../x/y.ts'))).toBe('https://example.invalid/a/x/y.ts');
		// A bare query keeps the base path and replaces only the query.
		expect(String(k.resolve(base, '?v=2'))).toBe('https://example.invalid/a/b/c.m3u8?v=2');
		// An absolute reference wins outright, and a rooted one keeps the host.
		expect(String(k.resolve(base, 'https://other.invalid/z'))).toBe('https://other.invalid/z');
		expect(String(k.resolve(base, '/z'))).toBe('https://example.invalid/z');
		expect(String(k.resolve(base, '//other.invalid/z'))).toBe('https://other.invalid/z');
	});

	it('answers null from an HttpUrl receiver when the result is not http', () => {
		// okhttp's resolve does, and `url.resolve(href) ?: return null` at the
		// call sites is testing exactly that.
		const url = k.httpUrl('https://example.invalid/a/b');
		expect(String(k.resolve(url, 'c'))).toBe('https://example.invalid/a/c');
		expect(k.resolve(url, 'mailto:someone@example.invalid')).toBeNull();
		expect(k.resolve(url, 'javascript:void(0)')).toBeNull();
	});

	it('quotes each component of the multi-argument constructor, as java does', () => {
		const { ctx } = context();
		runtime.enter(ctx);
		expect(String(k.uri('https', 'example.invalid', '/a b/c', 'q=1', null))).toBe(
			'https://example.invalid/a%20b/c?q=1'
		);
		// The famous edge of that constructor: it assumes each component is
		// UNencoded, so a '%' is quoted again. That is what happens on Android,
		// and disagreeing with the platform the extension was tested on is the
		// wrong kind of helpfulness.
		expect(String(k.uri('https', 'example.invalid', '/a%20b', null, null))).toBe(
			'https://example.invalid/a%2520b'
		);
	});

	it('is idempotent, so a URI handed to URI() is itself', () => {
		const uri = k.uri('https://example.invalid/a');
		expect(k.uri(uri)).toBe(uri);
	});
});

/* ── the ends of a string, and the ranges Kotlin builds ───────────────────── */

describe('trimStart and trimEnd, whose vararg JavaScript lacks', () => {
	it('trims the characters it was given, not whitespace', () => {
		// The latent bug this closes: JavaScript's trimStart takes no arguments,
		// so a passthrough trimmed whitespace where the source asked for a slash.
		expect(k.trimStart('///a/b', '/')).toBe('a/b');
		expect(k.trimEnd('a/b///', '/')).toBe('a/b');
		expect(k.trimStart('xy-a-yx', 'x', 'y')).toBe('-a-yx');
		expect(k.trimEnd('xy-a-yx', 'x', 'y')).toBe('xy-a-');
	});

	it('agrees with JavaScript exactly when given nothing', () => {
		expect(k.trimStart('  a  ')).toBe('a  ');
		expect(k.trimEnd('  a  ')).toBe('  a');
		expect(k.trim('  a  ')).toBe('a');
	});

	it('takes a predicate, which is Kotlin’s third overload', () => {
		expect(k.trimStart('12ab', (c: string) => k.isDigit(c))).toBe('ab');
		expect(k.trimEnd('ab12', (c: string) => k.isDigit(c))).toBe('ab');
	});
});

describe('a Kotlin range over characters', () => {
	it('builds the alphabet the extractors build', () => {
		// `('A'..'Z') + ('a'..'z') + ('0'..'9')` is how this ecosystem makes a
		// random-string alphabet. Reading those endpoints as numbers gives NaN,
		// an empty range, and a failure three calls later that names neither.
		expect(k.range('a', 'e')).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(k.until('a', 'd')).toEqual(['a', 'b', 'c']);
		const alphabet = k.plus(k.plus(k.range('A', 'Z'), k.range('a', 'z')), k.range('0', '9'));
		expect(alphabet).toHaveLength(62);
		expect(alphabet).toContain('A');
		expect(alphabet).toContain('9');
		expect(k.random(alphabet)).toHaveLength(1);
	});

	it('leaves the numeric ranges exactly as they were', () => {
		expect(k.range(1, 4)).toEqual([1, 2, 3, 4]);
		expect(k.until(0, 3)).toEqual([0, 1, 2]);
		expect(k.range(3, 1)).toEqual([]);
	});
});

describe('System, which the shared extractors read a clock off', () => {
	it('answers a millisecond clock rather than being undefined at the call', () => {
		const before = Date.now();
		const now = runtime.globals.System.currentTimeMillis();
		expect(now).toBeGreaterThanOrEqual(before);
		expect(typeof runtime.globals.System.nanoTime()).toBe('number');
	});

	it('names TimeUnit, which is only ever a timeout’s second argument', () => {
		// The timeout belongs to the host's transport, so the unit changes
		// nothing — but one unnameable identifier was refusing a whole extension
		// whose only other obstacle was the call it sits inside.
		const client = runtime.client
			.newBuilder()
			.connectTimeout(30, runtime.globals.TimeUnit.SECONDS)
			.callTimeout(1, runtime.globals.TimeUnit.MINUTES)
			.build();
		expect(typeof client.newCall).toBe('function');
		expect(runtime.globals.TimeUnit.SECONDS.toMillis(30)).toBe(30_000);
		expect(runtime.globals.TimeUnit.MINUTES.toMillis(2)).toBe(120_000);
	});

	it('offers nothing a sandbox cannot honestly answer', () => {
		// `exit`, `getenv` and `out` have no meaning here, and an undefined
		// member fails loudly at the call rather than quietly answering nothing.
		expect(runtime.globals.System.exit).toBeUndefined();
		expect(runtime.globals.System.getenv).toBeUndefined();
	});
});

/* ── Locale, which has to be callable ─────────────────────────────────────── */

describe('Locale', () => {
	it('is a function, because extensions construct one', () => {
		// `SimpleDateFormat("dd/MM/yy", Locale("pt", "BR"))` is ordinary here, and
		// an object literal makes that `Locale is not a function` at LOAD — which
		// costs the bundle every entry point it had, not one date.
		const made = runtime.globals.Locale('pt', 'BR');
		expect(made.language).toBe('pt');
		expect(made.country).toBe('BR');
		expect(String(made)).toBe('pt_BR');
	});

	it('still answers to the constants every date parse names', () => {
		expect(runtime.globals.Locale.ENGLISH.language).toBe('en');
		expect(runtime.globals.Locale.US.country).toBe('US');
		expect(runtime.globals.Locale.getDefault().language).toBe('en');
		expect(runtime.globals.Locale.ROOT.language).toBe('');
	});

	it('answers no date, rather than the wrong one, in a language it cannot read', () => {
		const format = runtime.globals.SimpleDateFormat(
			'dd MMM yyyy',
			runtime.globals.Locale('pt', 'BR')
		);
		// There is one set of month names here and it is English (`Intl` is out
		// of the engine subset). A Portuguese month fails to parse; it does not
		// parse to a different month.
		expect(format.parse('17 mai 2021')).toBeNull();
		expect(k.tryParse(format, '17 mai 2021')).toBe(0);
		expect(format.parse('17 May 2021')!.time).toBe(Date.UTC(2021, 4, 17));
	});
});

/* ── reading a redirect instead of taking it ──────────────────────────────── */

describe('followRedirects(false), which is an answer and not a detour', () => {
	const REDIRECT = 'https://example.invalid/go';

	function redirecting() {
		return context({
			[REDIRECT]: {
				status: 302,
				body: '',
				headers: { location: 'https://example.invalid/embed/7' }
			}
		});
	}

	it('carries follow: false to the host for a client built with it', async () => {
		const { ctx, requests } = redirecting();
		runtime.enter(ctx);

		const noRedirect = runtime.client.newBuilder().followRedirects(false).build();
		const response = await noRedirect.newCall(runtime.globals.GET(REDIRECT)).execute();

		expect(requests[0].follow).toBe(false);
		expect(response.code).toBe(302);
		// The whole point: the Location is the answer the extension wanted.
		expect(response.headers.get('Location')).toBe('https://example.invalid/embed/7');
	});

	it('does not mention follow at all on an ordinary request', async () => {
		const { ctx, requests } = redirecting();
		runtime.enter(ctx);

		await runtime.client.newCall(runtime.globals.GET(REDIRECT)).execute();

		// Absent, not `true`: the default belongs to the host, and restating it
		// on every request would move that decision into this runtime.
		expect('follow' in requests[0]).toBe(false);
	});

	it('keeps the policy through a rebuild and leaves the shared client alone', async () => {
		const { ctx, requests } = redirecting();
		runtime.enter(ctx);

		const noRedirect = runtime.client.newBuilder().followRedirects(false).build();
		// A builder taken off the no-redirect client starts from its policy.
		const again = noRedirect.newBuilder().readTimeout(30).build();
		await again.newCall(runtime.globals.GET(REDIRECT)).execute();
		expect(requests[0].follow).toBe(false);

		// And turning it back on is a client that follows again.
		const following = noRedirect.newBuilder().followRedirects(true).build();
		await following.newCall(runtime.globals.GET(REDIRECT)).execute();
		expect('follow' in requests[1]).toBe(false);

		// The module-scope client was never mutated by any of that.
		await runtime.client.newCall(runtime.globals.GET(REDIRECT)).execute();
		expect('follow' in requests[2]).toBe(false);
	});

	it('still refuses a network interceptor, which has no per-hop connection', () => {
		expect(() => runtime.client.newBuilder().addNetworkInterceptor(() => {})).toThrow(
			/network interceptor/
		);
	});
});

/* ── indexing, locks and atomics ──────────────────────────────────────────── */

describe('the syntax whose JavaScript namesake is wrong', () => {
	it('reads a Map through `index`, which plain `[]` cannot do', () => {
		// The bug this exists for: a Kotlin Map is a real `Map` here, so
		// `table['1080p']` emitted as itself reads a *property of the Map
		// object* and answers undefined for every key — a quality table that
		// silently matched nothing.
		const table = k.mapOf(k.to('1080p', 'a'), k.to('720p', 'b'));
		expect(table instanceof Map).toBe(true);
		expect(k.index(table, '1080p')).toBe('a');
		// Kotlin's `Map.get` answers null for an absent key rather than throwing.
		expect(k.index(table, '480p')).toBeNull();
	});

	it('indexes a list and a string the way Kotlin does, including out of bounds', () => {
		expect(k.index(k.listOf('a', 'b'), 1)).toBe('b');
		expect(k.index('abc', 0)).toBe('a');
		// `List.get` throws in Kotlin; answering undefined would travel.
		expect(() => k.index(k.listOf('a'), 4)).toThrow(/index 4/);
		expect(() => k.index(null, 'a')).toThrow(/was null/);
	});

	it('reads a plain object as a plain object', () => {
		expect(k.index({ title: 'One' }, 'title')).toBe('One');
	});

	it('reads and writes through operator get and set, the way Kotlin spells a[k]', () => {
		// `Calendar.getInstance()[Calendar.YEAR]` is `Calendar.get`, and was read
		// as a property: undefined, so a list of years down to 2012 was empty.
		const year = k.index(runtime.globals.Calendar.getInstance(), runtime.globals.Calendar.YEAR);
		expect(year).toBe(new Date().getFullYear());

		const store = new Map<string, string>();
		const operator = {
			get: (key: string) => store.get(key) ?? 'absent',
			set: (key: string, value: string) => void store.set(key, value)
		};
		k.setIndex(operator, 'a', 'b');
		expect(k.index(operator, 'a')).toBe('b');
		expect(k.index(operator, 'z')).toBe('absent');
	});

	it('writes into a Map and into a list', () => {
		const table = k.mutableMapOf();
		k.setIndex(table, 'k', 'v');
		expect(k.index(table, 'k')).toBe('v');
		expect(table.get('k')).toBe('v');

		const list = k.mutableListOf('a', 'b');
		k.setIndex(list, 1, 'c');
		expect(list[1]).toBe('c');
		expect(() => k.setIndex(null, 'k', 'v')).toThrow(/was null/);
	});

	it('runs a synchronized block and answers with its value', () => {
		// One thread: the lock is already held. The block is the whole of it.
		let ran = 0;
		expect(
			k.synchronized({}, () => {
				ran += 1;
				return 'done';
			})
		).toBe('done');
		expect(ran).toBe(1);
	});

	it('keeps an atomic counter, which is a box on one thread', () => {
		const counter = runtime.globals.AtomicInteger(0);
		expect(counter.incrementAndGet()).toBe(1);
		expect(counter.getAndIncrement()).toBe(1);
		expect(counter.get()).toBe(2);
		expect(counter.addAndGet(3)).toBe(5);
		expect(counter.getAndSet(0)).toBe(5);
		expect(counter.get()).toBe(0);

		const flag = runtime.globals.AtomicBoolean(false);
		expect(flag.compareAndSet(true, true)).toBe(false);
		expect(flag.compareAndSet(false, true)).toBe(true);
		expect(flag.get()).toBe(true);

		const held = runtime.globals.AtomicReference(null);
		expect(held.get()).toBeNull();
		held.set('x');
		expect(held.updateAndGet((value: string) => `${value}y`)).toBe('xy');
	});

	it('gives `Any()` a value distinct from every other one', () => {
		// It exists to be locked on, and nothing else. Two of them must not be
		// the same object, or two locks would be one.
		expect(runtime.globals.Any()).not.toBe(runtime.globals.Any());
	});
});

describe('the enums and statics an extension names in passing', () => {
	it('answers `Character`, whose Char is a one-character string here', () => {
		const Character = runtime.globals.Character;
		expect(Character.isDigit('7')).toBe(true);
		expect(Character.isDigit('x')).toBe(false);
		expect(Character.isLetter('é')).toBe(true);
		expect(Character.isLetterOrDigit('-')).toBe(false);
		expect(Character.isWhitespace(' ')).toBe(true);
		expect(Character.isUpperCase('A')).toBe(true);
		expect(Character.isLowerCase('A')).toBe(false);
		expect(Character.toLowerCase('A')).toBe('a');
		expect(Character.getNumericValue('f')).toBe(15);
		expect(Character.getNumericValue('-')).toBe(-1);
	});

	it('accepts `protocols(…)` as the inert configuration it is here', () => {
		// The HTTP version is negotiated by whatever makes the request, and
		// neither surface exposes the choice. Accepting it keeps an extension
		// that pins HTTP/1.1 out of habit; refusing it would lose one over a
		// line that changes nothing.
		const Protocol = runtime.globals.Protocol;
		const built = runtime.client.newBuilder().protocols([Protocol.HTTP_1_1]).build();
		expect(typeof built.newCall).toBe('function');
	});
});

describe('split, which Kotlin gives options a vararg leaves no room for', () => {
	it('splits on several literal delimiters, as before', () => {
		expect(k.split('a-b_c', '-', '_')).toEqual(['a', 'b', 'c']);
	});

	it('honours a limit, whose last part is the rest of the string', () => {
		// Kotlin's limit is not "take the first n": the final element is the
		// REMAINDER, separators included.
		expect(k.split('a,b,c', ',', { limit: 2 })).toEqual(['a', 'b,c']);
		expect(k.split('a,b,c', ',', { limit: 0 })).toEqual(['a', 'b', 'c']);
	});

	it('honours ignoreCase without disturbing the text it returns', () => {
		expect(k.split('aXbxc', 'x', { ignoreCase: true })).toEqual(['a', 'b', 'c']);
		expect(k.split('aXbxc', 'x')).toEqual(['aXb', 'c']);
	});

	it('keeps the separators inside a limited Regex split', () => {
		// The old implementation split fully and rejoined the tail, which
		// deleted the text of every separator it stitched over.
		expect(k.split('a, b, c', k.regex(',\\s*'), { limit: 2 })).toEqual(['a', 'b, c']);
		expect(k.regex(',').split('a,b,c', 2)).toEqual(['a', 'b,c']);
	});
});

describe('the tri-state filter, which is read by constant', () => {
	it('names the three states and answers the three questions', () => {
		const AnimeFilter = runtime.globals.AnimeFilter;
		expect(AnimeFilter.TriState.STATE_IGNORE).toBe(0);
		expect(AnimeFilter.TriState.STATE_INCLUDE).toBe(1);
		expect(AnimeFilter.TriState.STATE_EXCLUDE).toBe(2);

		const tag = AnimeFilter.TriState('Action', AnimeFilter.TriState.STATE_INCLUDE);
		expect(tag.isIncluded()).toBe(true);
		expect(tag.isExcluded()).toBe(false);
		expect(tag.isIgnored()).toBe(false);
		// Ignored is state 0, which is also what the framework calls default.
		expect(k.isDefault(AnimeFilter.TriState('Action'))).toBe(true);
	});
});

/* ── how the whole thing is assembled ─────────────────────────────────────── */

describe('assembling a conversion', () => {
	it('emits the stdlib first, whatever order it was asked for', () => {
		const source = kotlinRuntime(['models', 'stdlib']);
		expect(source.indexOf('var __k = {')).toBeLessThan(source.indexOf('var SAnime'));
	});

	it('emits only what a conversion asked for', () => {
		const lean = kotlinRuntime(['stdlib', 'models']);
		expect(lean).not.toContain('function GET(');
		expect(kotlinRuntime()).toContain('function GET(');
	});

	it('never spells a hostname, in any section', () => {
		// AGENTS.md rule 9. The runtime is generic by construction; this is the
		// gate that keeps it that way as helpers are added.
		const source = kotlinRuntime();
		const hosts = source.match(/https?:\/\/[a-z0-9.-]+/gi) ?? [];
		expect(hosts.filter((host) => !host.includes('example.invalid'))).toEqual([]);
	});
});

describe('the types a manga extension writes by name', () => {
	it('gives a chapter its own number field, which a book needs as a fraction', () => {
		const chapter = (runtime.globals.SChapter as { create(): Record<string, unknown> }).create();

		// `chapter_number`, not `episode_number`: the two ecosystems diverge
		// here and nowhere else in this type, and -1 is Kotlin's unset Float.
		expect(chapter.chapter_number).toBe(-1);
		expect(chapter).not.toHaveProperty('episode_number');
		expect(chapter.date_upload).toBe(0);
		expect(chapter.scanlator).toBeNull();

		chapter.chapter_number = 10.5;
		expect(chapter.chapter_number).toBe(10.5);
	});

	it('is the same object under both names where the fork only renamed it', () => {
		// Aniyomi's `SAnime` is `SManga` one rename later, and `AnimeFilter` is
		// `Filter`. Aliased rather than copied, because two definitions of one
		// thing drift and the drift would be a filter misreading its own state.
		expect(runtime.globals.SManga).toBe(runtime.globals.SAnime);
		expect(runtime.globals.Filter).toBe(runtime.globals.AnimeFilter);
		expect(runtime.globals.FilterList).toBe(runtime.globals.AnimeFilterList);

		const filter = runtime.globals.Filter as { TriState: { STATE_INCLUDE: number } };
		expect(filter.TriState.STATE_INCLUDE).toBe(1);
	});

	it('exposes the nested filter types under the bare names an import produces', () => {
		const filter = runtime.globals.Filter as Record<string, unknown>;
		for (const name of ['Select', 'Text', 'Group', 'Sort', 'Header', 'Separator']) {
			expect(runtime.globals[name]).toBe(filter[name]);
		}
	});

	it('keeps a page url and an image url in different slots', () => {
		// The failure this prevents is silent: `Page(index, imageUrl = it)` is
		// how a page list is built, and emitted positionally without a
		// signature the image url lands in `url` — the slot the driver fetches
		// a *document* from. The emitter's `KNOWN_SIGNATURES` is the other half
		// of this; here it is only asserted that the two slots are distinct.
		const Page = runtime.globals.Page as new (
			index: number,
			url?: string,
			imageUrl?: string | null
		) => Record<string, unknown>;

		const resolved = new Page(0, '', 'https://example.invalid/1.jpg');
		expect(resolved.index).toBe(0);
		expect(resolved.url).toBe('');
		expect(resolved.imageUrl).toBe('https://example.invalid/1.jpg');

		// The other construction: a page whose image is resolved later.
		const deferred = new Page(1, 'https://example.invalid/read/1');
		expect(deferred.url).toBe('https://example.invalid/read/1');
		expect(deferred.imageUrl).toBeNull();
	});

	it('builds a list page whose halves are both readable', () => {
		const MangasPage = runtime.globals.MangasPage as new (
			mangas: unknown,
			hasNextPage: unknown
		) => Record<string, unknown>;

		const page = new MangasPage([{ title: 'A Book' }], true);
		expect(page.mangas).toHaveLength(1);
		expect(page.hasNextPage).toBe(true);
		// `hasNextPage` is a strict boolean: a source returning a truthy string
		// would otherwise paginate forever.
		expect((new MangasPage([], 'yes') as { hasNextPage: unknown }).hasNextPage).toBe(false);
	});
});

/* ── the two companions a capitalised receiver reaches ────────────────────── */

describe('names that are a companion rather than a constructor', () => {
	it('escapes a literal into a pattern that matches exactly it', () => {
		// `Regex(pattern)` is a call and goes to `__k.regex`. `Regex.escape(x)`
		// is a *member*, and reached the sandbox as a bare name nothing defined
		// — a bundle that converted, packaged and then died at load with `Regex
		// is not defined`. Measured: it is the whole of `Madara.wordRegex`.
		const escaped = runtime.globals.Regex.escape('a.b+c(d)');

		expect(new RegExp(escaped).test('a.b+c(d)')).toBe(true);
		expect(new RegExp(escaped).test('axbxcxd')).toBe(false);
	});

	it('answers a time zone, which the date parser already behaves as', () => {
		// 115 sources write `dateFormat.timeZone = TimeZone.getTimeZone("UTC")`
		// and nothing else with it. The parser reads every field as UTC, so the
		// zone is a label it never consults — which is what makes answering one
		// honest rather than a stub.
		expect(runtime.globals.TimeZone.getTimeZone('UTC').getID()).toBe('UTC');
		expect(runtime.globals.TimeZone.getDefault().getID()).toBe('UTC');
	});
});

/* ── the classpath, and the i18n files it exists to reach ─────────────────── */

/**
 * The runtime with a classpath in it.
 *
 * `__RESOURCES` is declared by the entry point ahead of the runtime, so a test
 * that wants one has to build the module the same way the entry point does.
 * The plain `load()` above deliberately declares none, which is what pins the
 * other half of the contract: a bundle with no resources reads as empty rather
 * than throwing on an undeclared name.
 */
async function loadWithResources(resources: Record<string, string>): Promise<Loaded['globals']> {
	loads += 1;
	const source = [
		JS_RUNTIME,
		`var __RESOURCES = ${JSON.stringify(resources)};`,
		kotlinRuntime(),
		'export const k = __k;',
		'export const globals = { PropertyResourceBundle, InputStreamReader, Collator, Locale };',
		`/* load ${loads} */`
	].join('\n');
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	const module = (await import(/* @vite-ignore */ url)) as {
		k: any;
		globals: Record<string, any>;
	};
	return { ...module.globals, k: module.k };
}

const MESSAGES = [
	'# a comment, and the blank line under it',
	'',
	'! the other comment marker',
	'author_filter_title=Author',
	'colon_form:Colon',
	'space_form Space',
	'empty=',
	'wrapped=one \\',
	'    two',
	'escaped_separator=a\\=b',
	'unicode=caf\\u00e9',
	'newline=first\\nsecond'
].join('\n');

describe('the classpath a converted extension reads its strings from', () => {
	it('answers a file the conversion fetched, and null for one it did not', async () => {
		// Null rather than a throw is what the JVM does for a resource that is
		// not on the classpath, and the difference matters one layer up: the
		// bundle is what degrades, not the runtime.
		const g = await loadWithResources({ 'assets/i18n/messages_en.properties': MESSAGES });

		expect(g.k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties')).not.toBe(
			null
		);
		expect(g.k.classLoader().getResourceAsStream('assets/i18n/messages_zz.properties')).toBe(null);
		// A leading slash is the other spelling of the same path.
		expect(g.k.classLoader().getResourceAsStream('/assets/i18n/messages_en.properties')).not.toBe(
			null
		);
	});

	it('reads a .properties file the way java.util.Properties reads one', async () => {
		// Each of these appears in the message files of a real catalogue, and a
		// split on `=` gets three of them wrong.
		const g = await loadWithResources({ 'assets/i18n/messages_en.properties': MESSAGES });
		const stream = g.k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties');
		const bundle = g.PropertyResourceBundle(new g.InputStreamReader(stream, 'UTF-8'));

		expect(bundle.getString('author_filter_title')).toBe('Author');
		expect(bundle.getString('colon_form')).toBe('Colon');
		expect(bundle.getString('space_form')).toBe('Space');
		expect(bundle.getString('empty')).toBe('');
		expect(bundle.getString('wrapped')).toBe('one two');
		expect(bundle.getString('escaped_separator')).toBe('a=b');
		expect(bundle.getString('unicode')).toBe('café');
		expect(bundle.getString('newline')).toBe('first\nsecond');
		expect(bundle.containsKey('author_filter_title')).toBe(true);
		expect(bundle.containsKey('# a comment, and the blank line under it')).toBe(false);
	});

	it('is a Map, because that is what the emitter’s two readers already take', async () => {
		// `bundle.containsKey(k)` becomes `__k.containsKey` and
		// `bundle.getString(k)` becomes `__k.jsonGetString`. Both read a Map
		// already; entries as own properties would work until a message file
		// carried a key spelled like one of the methods.
		const g = await loadWithResources({ 'assets/i18n/messages_en.properties': MESSAGES });
		const bundle = g.PropertyResourceBundle(
			new g.InputStreamReader(
				g.k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties'),
				'UTF-8'
			)
		);

		expect(g.k.containsKey(bundle, 'author_filter_title')).toBe(true);
		expect(g.k.jsonGetString(bundle, 'author_filter_title')).toBe('Author');
	});

	it('answers an EMPTY bundle for a file that is not there, rather than throwing', async () => {
		// The load-bearing one. `MadaraBase` builds its filter options from
		// `intl[…]` in a class *property*, so this runs while the extension is
		// being constructed — a throw there costs the whole bundle rather than
		// one label. Upstream's own `Intl.get` answers `[key]` for a key it
		// cannot find, so an empty bundle is the fallback its author wrote.
		const g = await loadWithResources({});
		const bundle = g.PropertyResourceBundle(
			new g.InputStreamReader(
				g.k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties'),
				'UTF-8'
			)
		);

		expect(bundle.containsKey('author_filter_title')).toBe(false);
		expect(bundle.size).toBe(0);
	});

	it('reads an empty classpath when the bundle declares none', () => {
		// The video half declares no `__RESOURCES` at all, and an undeclared
		// name is a ReferenceError rather than `undefined` — which is why the
		// runtime asks `typeof`. This is the runtime loaded WITHOUT one.
		expect(k.classLoader().getResourceAsStream('assets/i18n/messages_en.properties')).toBe(null);
	});
});

describe('the two java.text services Intl asks for', () => {
	it('orders strings, which is all a Collator is used for here', async () => {
		const g = await loadWithResources({});
		const collator = g.Collator.getInstance(g.Locale.forLanguageTag('es'));

		expect(['pear', 'apple', 'fig'].sort((a, b) => collator.compare(a, b))).toEqual([
			'apple',
			'fig',
			'pear'
		]);
		expect(collator.equals('fig', 'fig')).toBe(true);
	});

	it('names a language it knows and answers the tag for one it does not', async () => {
		// ABI.md §6 forbids the `Intl` global and says display names are the
		// host's job, so the name is English whatever locale is asked. A tag
		// with no entry answers itself, which is visible rather than invented.
		const g = await loadWithResources({});

		expect(g.Locale.forLanguageTag('ja').getDisplayName(g.Locale.ROOT)).toBe('Japanese');
		expect(g.Locale.forLanguageTag('pt-BR').getDisplayName(g.Locale.ROOT)).toBe(
			'Portuguese (Brazil)'
		);
		expect(g.Locale.forLanguageTag('zz').getDisplayName(g.Locale.ROOT)).toBe('zz');
	});
});

/* ── the helpers that need a plugin call in flight ────────────────────────── */

/** Loaded fresh and never entered, so `__ctx` is still null in it. */
const hostless = await load();

describe('what cannot run before a plugin call has entered', () => {
	/**
	 * The list `emit.ts` defers a class property on, checked against the runtime
	 * that decides it.
	 *
	 * A helper that stops reaching `__host()` and stays on the list costs a
	 * needless deferral; one that starts reaching it and is left off is a bundle
	 * that dies at load, in a constructor, telling its reader about a network
	 * call it never made. Both are a name in the wrong list rather than anything
	 * a reader of either file could see, so the two are checked against each
	 * other here.
	 */
	// A runtime of its own, because `__enter` sets module state: by the time this
	// file gets here the shared `runtime` has had a context entered by an
	// earlier test, and every helper below would answer "no host needed".
	const clean = hostless.k;

	const ARGUMENTS: readonly unknown[][] = [
		[],
		['a'],
		['a', 'b'],
		// A character no URI may carry literally, because `__k.uri` reaches the
		// host's encoder only for the bytes it has to percent-escape — a probe
		// made entirely of safe text would decide it needs no host.
		['a', 'é'],
		['a', 'é', 'é', 'é', 'é'],
		['a', 'UTF-8'],
		[new Uint8Array([1, 2])],
		[new Uint8Array([1, 2]), 'UTF-8'],
		[{}],
		[{}, 'a'],
		[1],
		[1, 2],
		[[1, 2]]
	];

	/** True when SOME call of this helper fails for want of a host. */
	function needsHost(name: string): boolean {
		const fn = clean[name];
		if (typeof fn !== 'function') return false;
		for (const args of ARGUMENTS) {
			try {
				const answer = fn(...args);
				// Several helpers are `async`, and one handed nonsense rejects.
				// Swallowed here: what is being asked is whether it THREW for want
				// of a host, and a rejection over a bad argument is neither that
				// nor a failure of this suite.
				if (answer !== null && typeof answer === 'object' && 'catch' in answer) {
					(answer as Promise<unknown>).catch(() => undefined);
				}
			} catch (error) {
				if (String((error as Error).message).includes('before any plugin call')) return true;
			}
		}
		return false;
	}

	it('names every helper the emitter must defer a property on', () => {
		const missing = [...HOST_BACKED_HELPERS].filter((name) => !needsHost(name));
		expect(missing).toEqual([]);
	});

	it('names no helper that runs perfectly well without one', () => {
		// The other direction, which is the one that would let a bundle die:
		// a helper that reaches the host and is absent from the list.
		const unlisted = RUNTIME_HELPERS.filter(
			(name) => !HOST_BACKED_HELPERS.has(name) && needsHost(name)
		);
		expect(unlisted).toEqual([]);
	});

	it('says which capability was reached for, not only the network', () => {
		// `__host` guards `text`, `bytes` and `crypto` as well as `http`, and the
		// message named only the last — so an extension whose class property
		// encoded a constant to UTF-8 was told at load that it had called out to
		// the network, and whoever read that went looking for a request that
		// does not exist.
		expect(() => clean.toByteArray('Salted__', 'UTF-8')).toThrow(/text/);
		expect(() => clean.toByteArray('Salted__', 'UTF-8')).toThrow(/before any plugin call/);
	});
});
