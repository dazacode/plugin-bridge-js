/**
 * What the translated Kotlin *does*, and what it says when it will not run.
 *
 * ## Why almost nothing here asserts emitted text
 *
 * A translator has one interesting question — does the JavaScript compute what
 * the Kotlin computed — and comparing strings does not ask it. Four hundred
 * exact-text assertions all break when a space moves and none of them catch a
 * wrong `substringAfter`. So each test compiles a snippet, runs the emitted
 * code against a stub `__k`, and asserts the value that comes out.
 *
 * The stub is a `Proxy` that throws on any helper it does not implement. That
 * is deliberate: it means a test also fails when the emitter reaches for a
 * helper nobody has written, which is the drift `runtime-api.ts` exists to stop
 * and the one failure that would otherwise appear first inside a sandbox.
 *
 * The other half of the file is refusals, one per out-of-scope construct, each
 * asserting the construct's own **name** appears in the message. A refusal that
 * says "unsupported expression" is worth nothing to the person reading it and
 * nothing to whoever extends this next.
 *
 * Every fixture is Kotlin written for this test; `example.invalid` is reserved
 * by RFC 2606 (AGENTS.md rule 9).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { emitKotlin, type Emission } from './emit';
import { loadKotlinGrammar, type KotlinParser } from './grammar';

/**
 * The vendored artefacts, read the way a host reads them.
 *
 * `loadKotlinGrammar` no longer has a default: the runtime cannot locate a file
 * next to itself without taking `import.meta.url`, which is a fact about a
 * bundler rather than about JavaScript (`HOST.md` §2.2). A spec is its own
 * host — vitest on Node — so this is that host's implementation of the one
 * capability these tests need.
 */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`./vendor/${name}`, import.meta.url)))
	);
}

let parse: KotlinParser;

beforeAll(async () => {
	parse = await loadKotlinGrammar(vendorWasm);
}, 60_000);

/** A fixture, one line per argument, so the line breaks are visible. */
function kt(...lines: string[]): string {
	return lines.join('\n');
}

/** A class body wrapped in the declaration every extension has. */
function inClass(...lines: string[]): string {
	return kt('class Demo : Source() {', ...lines, '}');
}

/* ── the stub runtime ─────────────────────────────────────────────────────── */

type Any = unknown;

const nullish = (value: Any): boolean => value === null || value === undefined;

/** The classpath, as far as a fixture needs one. */
const stubLoader = { getResourceAsStream: () => null };

/** Every value `toByteArray` was handed, in order. See the helper. */
const encodedTexts: string[] = [];

/**
 * Just enough of `__k` to run the fixtures, with Kotlin's semantics where they
 * differ from JavaScript's — which is the only reason these helpers exist.
 */
const helpers: Record<string, (...args: never[]) => unknown> = {
	nn: (value: Any, what: string) => {
		if (nullish(value)) throw new Error(`null: ${what}`);
		return value;
	},
	sc: (value: Any, then: (inner: Any) => Any) => (nullish(value) ? null : then(value)),
	lazy: (owner: Record<string, Any>, key: string, make: () => Any) => {
		const store = (owner.__memo ?? (owner.__memo = {})) as Record<string, Any>;
		if (!(key in store)) store[key] = make();
		return store[key];
	},
	isType: (value: Any, name: string | (new (...args: never[]) => unknown)) => {
		// The real one takes either: a declared class arrives as the class, and
		// only the framework's own shapes arrive as a name. See `typeReference`.
		if (typeof name === 'function') return value instanceof name;
		if (name === 'String') return typeof value === 'string';
		if (name === 'Int' || name === 'Float' || name === 'Long') return typeof value === 'number';
		if (name === 'List') return Array.isArray(value);
		return value !== null && typeof value === 'object';
	},
	// One loader, whichever spelling asked for it — which is what the test
	// about the two spellings is asserting. The real one reads the files the
	// conversion fetched; here it need only be the same object twice.
	classLoader: () => stubLoader,

	cast: (value: Any) => value,
	castOrNull: (value: Any, name: string) =>
		(helpers.isType as never as (a: Any, b: string) => boolean)(value, name) ? value : null,

	listOf: (...items: Any[]) => items,
	mutableListOf: (...items: Any[]) => items,
	listOfNotNull: (...items: Any[]) => items.filter((item) => !nullish(item)),
	emptyList: () => [],
	mapOf: (...pairs: { first: Any; second: Any }[]) =>
		Object.fromEntries(pairs.map((pair) => [String(pair.first), pair.second])),
	// A real `Map`, as the runtime's own is — which is the whole reason
	// indexing goes through `__k.index` rather than being emitted as `[…]`.
	mutableMapOf: (...pairs: { first: Any; second: Any }[]) =>
		new Map(pairs.map((pair) => [pair.first, pair.second])),
	// Called with the accumulator as `this` AND as the argument, exactly as the
	// real one is: the emitter's choice of receiver form is what these prove.
	buildJsonObject: (block: (target: Any) => void) => {
		const out: Record<string, Any> = {};
		const target = {
			put: (key: string, value: Any) => {
				out[key] = value;
			},
			putJsonObject: (key: string, inner: (nested: Any) => void) => {
				out[key] = helpers.buildJsonObject(inner as never);
			}
		};
		block.call(target, target);
		return out;
	},
	setOf: (...items: Any[]) => items,
	add: (list: Any[], item: Any) => list.push(item),
	addAll: (list: Any[], items: Any[]) => list.push(...items),
	size: (value: Any) => (value as Any[]).length,
	flatten: (list: Any[][]) => list.flat(),
	plus: (list: Any[], other: Any) => list.concat(other as Any[]),

	// The collection helpers settle a suspending callback, as `runtime-api.ts`
	// requires of them. A `map` that returned a list of promises would look
	// right in every assertion about its length and be wrong in every one about
	// its contents, which is the failure the emitter's `await` propagation
	// exists to prevent — so the stub has to be honest about it too.
	map: (list: Any[], fn: (item: Any, index: number) => Any) => {
		const out = list.map((item) => fn(item, 0));
		return out.some((value) => value instanceof Promise) ? Promise.all(out) : out;
	},
	mapIndexed: (list: Any[], fn: (index: number, item: Any) => Any) =>
		list.map((item, index) => fn(index, item)),
	mapNotNull: (list: Any[], fn: (item: Any) => Any) =>
		list.map((item) => fn(item)).filter((item) => !nullish(item)),
	getAt: (value: Any, key: Any) => {
		if (value instanceof Map) return value.has(key) ? value.get(key) : null;
		return (value as Record<string, Any>)[key as string];
	},
	indices: (value: Any) =>
		Array.from({ length: (value as { length: number }).length }, (_, at) => at),
	// Real `Map`s, as the runtime's are — `__k.index` is what reads them back.
	associateBy: (list: Any[], fn: (item: Any) => Any) =>
		new Map(list.map((item) => [fn(item), item])),
	associateWith: (list: Any[], fn: (item: Any) => Any) =>
		new Map(list.map((item) => [item, fn(item)])),
	pow: (value: Any, exponent: Any) => Math.pow(Number(value), Number(exponent)),
	filter: (list: Any[], fn: (item: Any) => boolean) => list.filter((item) => fn(item)),
	filterNot: (list: Any[], fn: (item: Any) => boolean) => list.filter((item) => !fn(item)),
	flatMap: (list: Any[], fn: (item: Any) => Any[]) => list.flatMap((item) => fn(item)),
	forEach: (list: Any[], fn: (item: Any) => void) => list.forEach((item) => fn(item)),
	first: (list: Any[]) => list[0],
	firstOrNull: (list: Any[], fn?: (item: Any) => boolean) =>
		(fn === undefined ? list[0] : list.find((item) => fn(item))) ?? null,
	last: (list: Any[]) => list[list.length - 1],
	lastOrNull: (list: Any[]) => list[list.length - 1] ?? null,
	find: (value: Any, argument: Any) =>
		typeof argument === 'function'
			? ((value as Any[]).find((item) => (argument as (item: Any) => boolean)(item)) ?? null)
			: ((value as RegExp).exec(String(argument)) ?? null),
	any: (list: Any[], fn: (item: Any) => boolean) => list.some((item) => fn(item)),
	all: (list: Any[], fn: (item: Any) => boolean) => list.every((item) => fn(item)),
	none: (list: Any[], fn: (item: Any) => boolean) => !list.some((item) => fn(item)),
	count: (list: Any[]) => list.length,
	reversed: (list: Any[]) => [...list].reverse(),
	distinct: (list: Any[]) => [...new Set(list)],
	take: (list: Any[], n: number) => list.slice(0, n),
	drop: (list: Any[], n: number) => list.slice(n),
	toList: (list: Any[]) => [...list],
	toSet: (list: Any[]) => [...new Set(list)],
	sortedBy: (list: Any[], fn: (item: Any) => number) => [...list].sort((a, b) => fn(a) - fn(b)),
	getOrNull: (list: Any[], index: number) => list[index] ?? null,
	getOrDefault: (result: { ok: boolean; value: Any }, fallback: Any) =>
		result.ok ? result.value : fallback,
	getOrElse: (result: { ok: boolean; value: Any }, fallback: () => Any) =>
		result.ok ? result.value : fallback(),
	joinToString: (list: Any[], a?: Any, b?: Any) => {
		const separator = typeof a === 'string' ? a : ', ';
		const fn = typeof a === 'function' ? a : typeof b === 'function' ? b : null;
		return list
			.map((item) => (fn === null ? String(item) : String((fn as (item: Any) => Any)(item))))
			.join(separator);
	},

	substringAfter: (text: string, delimiter: string) =>
		text.includes(delimiter) ? text.slice(text.indexOf(delimiter) + delimiter.length) : text,
	substringBefore: (text: string, delimiter: string) =>
		text.includes(delimiter) ? text.slice(0, text.indexOf(delimiter)) : text,
	substringAfterLast: (text: string, delimiter: string) =>
		text.includes(delimiter) ? text.slice(text.lastIndexOf(delimiter) + delimiter.length) : text,
	substringBeforeLast: (text: string, delimiter: string) =>
		text.includes(delimiter) ? text.slice(0, text.lastIndexOf(delimiter)) : text,
	removePrefix: (text: string, prefix: string) =>
		text.startsWith(prefix) ? text.slice(prefix.length) : text,
	removeSuffix: (text: string, suffix: string) =>
		text.endsWith(suffix) ? text.slice(0, -suffix.length) : text,
	replaceString: (text: string, from: Any, to: string) =>
		typeof from === 'string' ? text.split(from).join(to) : text.replace(from as RegExp, to),
	split: (text: string, delimiter: string) => text.split(delimiter),
	trim: (text: string) => text.trim(),
	trimIndent: (text: string) =>
		text
			.split('\n')
			.map((line) => line.trim())
			.join('\n')
			.trim(),
	lowercase: (text: string) => text.toLowerCase(),
	uppercase: (text: string) => text.toUpperCase(),
	padStart: (text: string, length: number, pad: string) => text.padStart(length, pad),
	startsWith: (text: string, prefix: string, ignoreCase?: boolean) =>
		ignoreCase === true
			? text.toLowerCase().startsWith(prefix.toLowerCase())
			: text.startsWith(prefix),
	// The body of the `Symbol.hasInstance` an emitted `interface` carries.
	hasMembers: (value: Any, names: string[]) =>
		value !== null &&
		(typeof value === 'object' || typeof value === 'function') &&
		names.every((name) => (value as Record<string, Any>)[name] !== undefined),
	filterIsInstance: (list: Any[], type: Any) =>
		list.filter((item) => (typeof type === 'function' ? item instanceof (type as never) : true)),
	distinctBy: (list: Any[], key: (item: Any) => Any) => {
		const seen = new Set<Any>();
		return list.filter((item) => {
			const at = key(item);
			if (seen.has(at)) return false;
			seen.add(at);
			return true;
		});
	},
	endsWith: (text: string, suffix: string) => text.endsWith(suffix),
	isBlank: (text: string) => text.trim().length === 0,
	isNotBlank: (text: string) => text.trim().length > 0,
	isEmpty: (value: Any) => (value as { length: number }).length === 0,
	isNotEmpty: (value: Any) => (value as { length: number }).length > 0,
	isNullOrBlank: (text: Any) => nullish(text) || String(text).trim().length === 0,
	isNullOrEmpty: (text: Any) => nullish(text) || String(text).length === 0,
	ifBlank: (text: string, make: () => string) => (text.trim().length === 0 ? make() : text),
	ifEmpty: (text: string, make: () => string) => (text.length === 0 ? make() : text),
	contains: (haystack: Any, needle: Any) =>
		typeof haystack === 'string'
			? haystack.includes(String(needle))
			: (haystack as Any[]).includes(needle),
	toStringOf: (value: Any) => String(value),

	toInt: (text: string) => {
		const parsed = Number.parseInt(text, 10);
		if (Number.isNaN(parsed)) throw new Error(`not a number: ${text}`);
		return parsed;
	},
	toIntOrNull: (text: string) => {
		const parsed = Number.parseInt(text, 10);
		return Number.isNaN(parsed) ? null : parsed;
	},
	toFloatOrNull: (text: string) => {
		const parsed = Number.parseFloat(text);
		return Number.isNaN(parsed) ? null : parsed;
	},
	toFloat: (text: string) => Number.parseFloat(text),
	toLongOrNull: (text: string) => {
		const parsed = Number.parseInt(text, 10);
		return Number.isNaN(parsed) ? null : parsed;
	},
	intDiv: (a: number, b: number) => Math.trunc(a / b),

	let: (value: Any, fn: (inner: Any) => Any) => fn(value),
	also: (value: Any, fn: (inner: Any) => void) => {
		fn(value);
		return value;
	},
	apply: (value: Any, fn: (this: Any) => void) => {
		fn.call(value);
		return value;
	},
	run: (value: Any, fn: (this: Any) => Any) => fn.call(value),
	takeIf: (value: Any, fn: (inner: Any) => boolean) => (fn(value) ? value : null),
	takeUnless: (value: Any, fn: (inner: Any) => boolean) => (fn(value) ? null : value),
	// A `Result`, with the members the runtime's own carries. It is not a
	// collection, and the difference is the whole point: `EXTENSION_METHODS`
	// maps `getOrNull` onto the *collection* helper, so a `Result` handed to
	// that answers `null` whether it succeeded or not.
	runCatching: (fn: () => Any) => {
		const settle = (ok: boolean, value: Any, error: Any): Any => ({
			ok,
			value,
			isSuccess: ok,
			isFailure: !ok,
			getOrNull: () => (ok ? value : null),
			getOrThrow: () => {
				if (!ok) throw error;
				return value;
			},
			getOrElse: (recover: (e: Any) => Any) => (ok ? value : recover(error)),
			getOrDefault: (fallback: Any) => (ok ? value : fallback),
			exceptionOrNull: () => (ok ? null : error)
		});
		try {
			return settle(true, fn(), null);
		} catch (error) {
			// A non-local return is not a failure; the runtime re-throws it here
			// and so must this, or a `return` written inside a `runCatching`
			// would answer the fallback instead.
			if (error !== null && typeof error === 'object' && '__jump' in (error as object)) {
				throw error;
			}
			return settle(false, null, error);
		}
	},

	range: (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, index) => from + index),
	until: (from: number, to: number) =>
		Array.from({ length: to - from }, (_, index) => from + index),
	downTo: (from: number, to: number) =>
		Array.from({ length: Math.max(0, from - to + 1) }, (_, index) => from - index),
	bitwiseAnd: (left: number, right: number) => left & right,
	bitwiseOr: (left: number, right: number) => left | right,
	bitwiseXor: (left: number, right: number) => left ^ right,
	digitToIntOrNull: (value: string) => (/^[0-9]$/.test(value) ? Number(value) : null),
	toLong: (value: Any) => Number(value),
	countLeadingZeroBits: (value: Any) => Math.clz32(Number(value)),
	toIntArray: (value: Any) => value,
	toJsonString: (value: Any) => JSON.stringify(value),
	asQueryPart: (value: Any) => encodeURIComponent(String(value)),
	withLock: (_lock: Any, block: () => Any) => block(),
	elementAt: (value: Any, index: number) =>
		typeof value === 'string' ? value[index] : (value as unknown[])[index],
	iterator: (value: Any) => (value as Iterable<unknown>)[Symbol.iterator](),
	trimMargin: (value: string) =>
		value
			.split('\n')
			.map((line) => line.replace(/^\s*\|/, ''))
			.join('\n'),
	encodeToString: (value: Any) => {
		void value;
		return 'encoded';
	},
	byteArray: (size: number) => Array.from({ length: size }, () => 0),
	to: (first: Any, second: Any) => ({ first, second }),
	destructured: (value: Any) => {
		if (Array.isArray(value)) return value;
		const pair = value as { first?: Any; second?: Any };
		if ('first' in pair) return [pair.first, pair.second];
		return Object.values(value as Record<string, Any>);
	},

	// Indexing, which the runtime routes through a helper because a Kotlin Map
	// is a real `Map` here and `map[key]` would read a property of it.
	index: (value: Any, key: Any) => {
		if (value instanceof Map) return value.has(key) ? value.get(key) : null;
		return (value as Record<string, Any>)[key as string];
	},
	setIndex: (value: Any, key: Any, next: Any) => {
		if (value instanceof Map) value.set(key, next);
		else (value as Record<string, Any>)[key as string] = next;
		return next;
	},
	// One thread, so the lock is already held: see `__k.synchronized`.
	synchronized: (_lock: Any, block: () => Any) => block(),

	regex: (pattern: string) => new RegExp(pattern),
	groupValues: (match: Any) => (match === null ? null : [...(match as RegExpExecArray)]),

	unsupported: (message?: string) => {
		throw new Error(message ?? 'not supported');
	},
	error: (message?: string) => {
		throw new Error(message ?? 'error');
	},
	decode: (_json: Any, _shape: string, body: string) => JSON.parse(body) as Any,
	pref: (_store: Any, _key: string, fallback: Any) => fallback,

	// One of the helpers that cannot run before a plugin call has entered: the
	// real one reaches `__host().text.encode`. It counts its calls so a test can
	// ask WHEN it ran, which is the whole question about a deferred property.
	toByteArray: (value: Any) => {
		encodedTexts.push(String(value));
		return [String(value).length];
	},
	// The real one reads the manifest's settings and writes to a per-run
	// overlay; here it only has to be a store, so that a delegate resolving to
	// one is distinguishable from the `null` it used to resolve to.
	prefs: () => ({
		getString: (_key: string, fallback: Any) => fallback,
		edit: () => ({ putString: () => undefined, apply: () => undefined })
	}),

	// Kotlin's non-local return, as the runtime implements it: a marker thrown
	// through whatever callbacks lie between, and caught by the frame the jump
	// named. The three have to agree with `kotlin-runtime.ts`; what they are
	// asserted on here is the behaviour, not the shape.
	jump: (id: Any, value: Any) => {
		throw { __jump: id, value };
	},
	isJump: (error: Any, id: Any) => {
		if (error === null || typeof error !== 'object') return false;
		const marker = (error as { __jump?: Any }).__jump;
		// `undefined` for the id means "is this a jump at all" — and the marker
		// has to be *present*, or an ordinary Error would answer yes to it.
		return marker !== undefined && (id === undefined || marker === id);
	},
	jumpValue: (error: Any) => (error as { value: Any }).value,

	await: (value: Any) => Promise.resolve(value),
	awaitAll: (values: Any[]) => Promise.all(values),
	async: (fn: () => Any) => Promise.resolve().then(fn),
	asJsoup: (response: { html: string }) => response.html,
	httpUrl: (text: string) => text,
	els: (value: Any) => value,

	// The two declarative rate limiters, recording what was declared. The
	// *period in milliseconds* is the whole point of translating these — see
	// `rateLimitCall` — so it is read back as a value here rather than matched
	// in emitted text.
	rateLimit: (receiver: Any, permits: Any, periodMs: Any) => {
		declared.push({ host: null, permits: permits as number, periodMs: periodMs as number });
		return receiver;
	},
	rateLimitHost: (receiver: Any, url: Any, permits: Any, periodMs: Any) => {
		declared.push({ host: String(url), permits: permits as number, periodMs: periodMs as number });
		return receiver;
	},

	// keiyoushi's suspend request verbs on a client, recorded as written and
	// answered asynchronously — so a caller that forgot to await reads a field
	// off a promise and the fixture sees undefined.
	okhttp: (receiver: Any, verb: Any, positional: Any, named: Any) => {
		sent.push({ receiver, verb: verb as string, positional: positional as Any[], named });
		return Promise.resolve({ verb, url: (positional as Any[])[0] });
	}
};

/** What the fixtures above sent through `__k.okhttp`, most recent last. */
const sent: { receiver: Any; verb: string; positional: Any[]; named: Any }[] = [];

/** What the fixtures above declared, most recent last. */
const declared: { host: string | null; permits: number; periodMs: number }[] = [];

/** Throws on any helper the emitter reaches for that nobody has written. */
const runtime = new Proxy(helpers, {
	get(target, key: string) {
		if (!(key in target)) throw new Error(`the emitter called an undefined helper: __k.${key}`);
		return target[key];
	}
});

/* ── running a fixture ────────────────────────────────────────────────────── */

interface Globals {
	[name: string]: unknown;
}

/**
 * An instance of a translated class, as a test reads it.
 *
 * Members are values *and* callable, because the fixtures assert on both —
 * `demo.baseUrl` and `demo.popularAnimeRequest(2)` — and the emitted class has
 * no declared shape for TypeScript to have an opinion about.
 */
type Instance = Record<string, ((...args: unknown[]) => unknown) & Record<string, unknown>>;

const defaults: Globals = {
	GET: (url: string, headers?: unknown) => ({ url, headers, method: 'GET' }),
	POST: (url: string, headers?: unknown, body?: unknown) => ({
		url,
		headers,
		body,
		method: 'POST'
	}),
	Headers: { Builder: () => ({ build: () => ({}) }) },
	FormBody: { Builder: () => ({ build: () => ({}) }) },
	Jsoup: { parse: (html: string) => html },
	Charsets: { UTF_8: 'UTF-8' },
	SAnime: { create: () => ({}), ONGOING: 1, COMPLETED: 2, UNKNOWN: 0 },
	SEpisode: { create: () => ({}) },
	Video: (url: string, quality: string, videoUrl: string) => ({
		url,
		quality,
		videoUrl
	}),
	Track: (url: string, lang: string) => ({ url, lang }),
	AnimeFilter: {
		TriState: { STATE_IGNORE: 0, STATE_INCLUDE: 1, STATE_EXCLUDE: 2 }
	},
	Json: {},
	// As the runtime defines it: the one member this ecosystem asks of an
	// `Application` is the settings store, and it is the same store
	// `__k.prefs()` hands back.
	Application: { getSharedPreferences: () => helpers.prefs?.([] as never) },
	// Constructed for one purpose: something to `synchronized` on.
	Any: () => ({})
};

function translate(source: string): Emission {
	return emitKotlin(parse(source));
}

/**
 * Compiles a fixture and returns an instance of its class.
 *
 * `base` stands in for the base source class. A bare lowercase call the
 * extension did not declare — `episodeFromElement(el)`, `headersBuilder()` —
 * is emitted as `this.name(…)`, because in 247 of the catalogue's 254
 * extensions that is exactly what it is: a member the base supplies. So the
 * stubs go on the prototype, where the constructor can already see them.
 */
function instantiate(source: string, base: Globals = {}, globals: Globals = {}): Instance {
	const emission = translate(source);
	expect(emission.fileRefusal).toBeNull();
	expect(emission.refusals).toEqual([]);

	const all = { ...defaults, ...globals };
	const names = ['__k', '__base', ...Object.keys(all)];
	const make = new Function(
		...names,
		`${emission.js}\nObject.assign(${emission.className}.prototype, __base);\nreturn new ${emission.className};`
	) as (...args: unknown[]) => Instance;
	return make(runtime, base, ...Object.values(all));
}

/** Compiles a fixture and evaluates one expression against its module scope. */
function evaluate(source: string, expression: string, globals: Globals = {}): unknown {
	const emission = translate(source);
	expect(emission.fileRefusal).toBeNull();
	expect(emission.refusals).toEqual([]);

	const all = { ...defaults, ...globals };
	const names = ['__k', ...Object.keys(all)];
	const make = new Function(...names, `${emission.js}\nreturn (${expression});`) as (
		...args: unknown[]
	) => unknown;
	return make(runtime, ...Object.values(all));
}

/** The obstacle names in a refusal, for a test that asserts one is present. */
function refusalNames(source: string): string[] {
	const emission = translate(source);
	return emission.refusals.flatMap((one) => one.obstacles.map((obstacle) => obstacle.kind));
}

/* ── declarations ─────────────────────────────────────────────────────────── */

describe('declarations', () => {
	it('turns overridden constants into properties set once', () => {
		const demo = instantiate(
			inClass(
				'    override val name = "Demo"',
				'    override val baseUrl = "https://example.invalid"',
				'    override val supportsLatest = true'
			)
		);

		expect(demo.name).toBe('Demo');
		expect(demo.baseUrl).toBe('https://example.invalid');
		expect(demo.supportsLatest).toBe(true);
	});

	it('evaluates a `val` initialiser once, not on every read', () => {
		// A getter would re-run `network.client.newBuilder().build()` per access;
		// Kotlin runs it once, and two different clients is a real bug.
		let calls = 0;
		const demo = instantiate(inClass('    override val client = makeClient()'), {
			makeClient: () => {
				calls += 1;
				return { id: calls };
			}
		});

		expect(demo.client).toEqual({ id: 1 });
		expect(demo.client).toEqual({ id: 1 });
		expect(calls).toBe(1);
	});

	it('memoises a `by lazy` and does not run it before it is read', () => {
		let calls = 0;
		const demo = instantiate(inClass('    private val cache by lazy { count() }'), {
			count: () => {
				calls += 1;
				return calls;
			}
		});

		expect(calls).toBe(0);
		expect(demo.cache).toBe(1);
		expect(demo.cache).toBe(1);
		expect(calls).toBe(1);
	});

	it('hoists companion constants so the class can read them by bare name', () => {
		const demo = instantiate(
			inClass(
				'    companion object {',
				'        const val PREFIX = "ep-"',
				'    }',
				'',
				'    fun label(n: Int) = PREFIX + n',
				'    fun prefix() = PREFIX'
			)
		);

		expect(demo.prefix()).toBe('ep-');
		expect(demo.label(3)).toBe('ep-3');
	});

	it('makes a data class a factory, defaults included', () => {
		const value = evaluate(
			kt('data class Item(val file: String, val label: String = "none")'),
			'Item("a.mp4")'
		);

		expect(value).toEqual({ file: 'a.mp4', label: 'none' });
	});

	it('makes an enum class a frozen map carrying its own state', () => {
		const value = evaluate(
			kt('enum class Kind(val weight: Int) {', '    ALPHA(3),', '    BETA(5),', '}'),
			'[Kind.ALPHA.weight, Kind.BETA.ordinal, Object.isFrozen(Kind)]'
		);

		expect(value).toEqual([3, 1, true]);
	});

	it('makes an `object` a frozen literal', () => {
		const value = evaluate(
			kt('object Registry {', '    val names = listOf("a", "b")', '}'),
			'[Registry.names, Object.isFrozen(Registry)]'
		);

		expect(value).toEqual([['a', 'b'], true]);
	});

	it('assigns primary-constructor `val` parameters to the instance', () => {
		const value = evaluate(
			kt('class Demo(private val lang: String) : Source() {', '    fun tag() = lang', '}'),
			'new Demo("en").tag()'
		);

		expect(value).toBe('en');
	});
});

/* ── expressions ──────────────────────────────────────────────────────────── */

describe('strings', () => {
	it('interpolates an identifier and an expression', () => {
		const demo = instantiate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    fun page(n: Int) = "$baseUrl/list/${n + 1}"'
			)
		);

		expect(demo.page(2)).toBe('https://example.invalid/list/3');
	});

	it('decodes Kotlin escapes rather than passing the backslash through', () => {
		const demo = instantiate(inClass('    fun gap() = "a\\tb\\nc\\"d"'));

		expect(demo.gap()).toBe('a\tb\nc"d');
	});

	it('leaves a raw string raw, so a regex keeps its backslashes', () => {
		const demo = instantiate(inClass('    fun pattern() = """(\\d+)p"""'));

		expect(demo.pattern()).toBe('(\\d+)p');
	});

	it('keeps a template safe when the text contains backticks and dollars', () => {
		const demo = instantiate(inClass('    fun odd(x: Int) = "`${x}` costs \\$5"'));

		expect(demo.odd(2)).toBe('`2` costs $5');
	});

	it('routes `replace` through the runtime, because Kotlin replaces them all', () => {
		const demo = instantiate(inClass('    fun clean(s: String) = s.replace("-", " ")'));

		expect(demo.clean('a-b-c')).toBe('a b c');
	});
});

describe('operators', () => {
	it('translates elvis, safe calls and `!!`', () => {
		const demo = instantiate(
			inClass(
				'    fun fallback(x: String?) = x ?: "none"',
				'    fun safe(x: String?) = x?.length',
				'    fun demand(x: String?) = x!!.length'
			)
		);

		expect(demo.fallback(null)).toBe('none');
		expect(demo.fallback('a')).toBe('a');
		// Kotlin's absent value is `null` and a native `?.` yields `undefined`.
		// Everything downstream — `??`, `== null`, every runtime helper — treats
		// the two alike, so the divergence is left rather than papered over on
		// every property access in the file.
		expect(demo.safe(null) ?? null).toBeNull();
		expect(demo.safe('abc')).toBe(3);
		expect(demo.demand('abc')).toBe(3);
	});

	it('makes `!!` throw with the expression that was null in the message', () => {
		const demo = instantiate(inClass('    fun demand(doc: String?) = doc!!.length'));

		expect(() => demo.demand(null)).toThrow(/doc/);
	});

	it('keeps a safe call safe when the method needs the runtime', () => {
		// `a?.substringAfter("x")` cannot use JavaScript's `?.`: the helper takes
		// the receiver as an argument and would be handed the null.
		const demo = instantiate(inClass('    fun tail(x: String?) = x?.substringAfter("/")'));

		expect(demo.tail(null)).toBeNull();
		expect(demo.tail('a/b')).toBe('b');
	});

	it('translates `is`, `as?` and `in`', () => {
		const demo = instantiate(
			inClass(
				'    fun kind(x: Any) = x is String',
				'    fun maybe(x: Any) = x as? String',
				'    fun member(x: String) = x in listOf("a", "b")'
			)
		);

		expect(demo.kind('a')).toBe(true);
		expect(demo.kind(1)).toBe(false);
		expect(demo.maybe(1)).toBeNull();
		expect(demo.member('b')).toBe(true);
		expect(demo.member('z')).toBe(false);
	});

	it('translates comparison, arithmetic and boolean chains', () => {
		const demo = instantiate(
			inClass('    fun check(a: Int, b: Int) = a > b && a - b == 2 || a == 0')
		);

		expect(demo.check(5, 3)).toBe(true);
		expect(demo.check(5, 1)).toBe(false);
		expect(demo.check(0, 9)).toBe(true);
	});
});

describe('control flow', () => {
	it('uses `if` as an expression', () => {
		const demo = instantiate(inClass('    fun pick(n: Int) = if (n > 0) "up" else "down"'));

		expect(demo.pick(1)).toBe('up');
		expect(demo.pick(-1)).toBe('down');
	});

	it('uses a block-bodied `if` as an expression', () => {
		const demo = instantiate(
			inClass(
				'    fun pick(n: Int) = if (n > 0) {',
				'        val doubled = n * 2',
				'        doubled',
				'    } else {',
				'        0',
				'    }'
			)
		);

		expect(demo.pick(3)).toBe(6);
		expect(demo.pick(-3)).toBe(0);
	});

	it('evaluates a `when` subject once and matches against it', () => {
		let calls = 0;
		const demo = instantiate(
			inClass(
				'    fun status(): Int = when (raw()) {',
				'        "Ongoing" -> 1',
				'        "Completed", "Finished" -> 2',
				'        else -> 0',
				'    }'
			),
			{
				raw: () => {
					calls += 1;
					return 'Finished';
				}
			}
		);

		expect(demo.status()).toBe(2);
		expect(calls).toBe(1);
	});

	it('uses a subjectless `when` as a chain of conditions', () => {
		const demo = instantiate(
			inClass(
				'    fun band(n: Int) = when {',
				'        n > 10 -> "high"',
				'        n > 5 -> "middle"',
				'        else -> "low"',
				'    }'
			)
		);

		expect(demo.band(20)).toBe('high');
		expect(demo.band(7)).toBe('middle');
		expect(demo.band(1)).toBe('low');
	});

	it('uses `try`/`catch` as an expression', () => {
		const demo = instantiate(
			inClass('    fun parse(s: String) = try { s.toInt() } catch (e: Exception) { -1 }')
		);

		expect(demo.parse('12')).toBe(12);
		expect(demo.parse('nope')).toBe(-1);
	});

	it('walks a range in a `for`', () => {
		const demo = instantiate(
			inClass(
				'    fun total(n: Int): Int {',
				'        var sum = 0',
				'        for (i in 1..n) sum += i',
				'        return sum',
				'    }'
			)
		);

		expect(demo.total(4)).toBe(10);
	});

	it('translates descending ranges and named integer infix operations', () => {
		const demo = instantiate(
			inClass('    fun values(n: Int) = (n downTo 1).map { (it and 3) or (it xor 1) }')
		);

		expect(demo.values(5)).toEqual([5, 5, 3, 3, 1]);
	});

	it('widens numeric, query, JSON, lock, and shift helpers', () => {
		const demo = instantiate(
			inClass(
				'    fun values(text: String, bits: Int) = listOf(text[0].digitToIntOrNull(), text[0].toString().asQueryPart(), bits shl 2)',
				'    fun json(value: String) = mapOf("value" to value).toJsonString()',
				'    fun locked(value: String) = value.withLock { "locked" }'
			)
		);

		expect(demo.values('7', 3)).toEqual([7, '7', 12]);
		expect(demo.json('ok')).toBe('{"value":"ok"}');
		expect(demo.locked('ok')).toBe('locked');
	});

	it('translates collection access, primitive arrays, and margin strings', () => {
		const demo = instantiate(
			inClass(
				'    fun read(items: List<String>) = items.elementAt(1)',
				'    fun buffer() = LongArray(3).size',
				'    fun text() = "  |one\\n  |two".trimMargin()',
				'    fun long(text: String) = text.toLong()',
				'    fun zeros(value: Int) = value.countLeadingZeroBits()'
			)
		);

		expect(demo.read(['a', 'b'])).toBe('b');
		expect(demo.buffer()).toBe(3);
		expect(demo.text()).toBe('one\ntwo');
		expect(demo.long('42')).toBe(42);
		expect(demo.zeros(1)).toBe(31);
	});

	it('constructs zero-filled byte arrays and expands vararg spreads', () => {
		const demo = instantiate(
			inClass(
				'    fun bytes(values: List<Int>) = ByteArray(3)',
				// `ByteArray(3)` is a length and `byteArrayOf(…)` is the elements.
				// Routing both at the size helper turned a two-byte key into ten
				// zeroes, silently, wherever a converted source built one.
				'    fun key() = byteArrayOf(0x0a, 0x0b)',
				'    fun joined(values: List<String>) = listOf("head", *values.toTypedArray(), "tail")'
			)
		);

		expect(demo.bytes([])).toEqual([0, 0, 0]);
		expect(demo.key()).toEqual([10, 11]);
		expect(demo.joined(['a', 'b'])).toEqual(['head', 'a', 'b', 'tail']);
	});

	it('passes a lambda to a translated source member', () => {
		const demo = instantiate(
			inClass(
				'    fun applyTo(value: String, fn: (String) -> String) = fn(value)',
				'    fun result() = applyTo("x") { it.uppercase() }'
			)
		);

		expect(demo.result()).toBe('X');
	});

	it('keeps a labelled return local to runBlocking', async () => {
		const demo = instantiate(
			inClass(
				'    fun size(items: List<Int>) = runBlocking {',
				'        return@runBlocking items.size',
				'    }'
			)
		);

		expect(await demo.size([1, 2, 3])).toBe(3);
	});

	it('keeps a labelled return local to the blocks that are real callbacks', async () => {
		// `withContext`, bare `with`, `async` and `by lazy` all become a real
		// JavaScript function, and each one's frame was carrying no label — so
		// `return@withContext` was compared against `null` and refused as
		// "crossing a lambda" while crossing nothing at all.
		//
		// None of the four is one of Kotlin's inline scope functions, which is
		// what makes the fix safe rather than convenient: a bare `return` inside
		// any of them does not compile in Kotlin either, so the only return an
		// extension can write is the labelled one, and it leaves exactly the
		// function this emitter already produces.
		const demo = instantiate(
			inClass(
				'    val floor by lazy {',
				'        if (limit < 0) return@lazy 0',
				'        limit',
				'    }',
				// Negative, so the `by lazy` guard actually fires and `floor` is the
				// value the labelled return carried rather than the block's last line.
				'    val limit = -1',
				'    fun pick(items: List<Int>) = runBlocking {',
				'        withContext(Dispatchers.Default) {',
				'            if (items.isEmpty()) return@withContext floor',
				'            items.first()',
				'        }',
				'    }',
				'    fun width(text: String) = with(text) {',
				'        if (isEmpty()) return@with floor',
				'        length',
				'    }'
			)
		);

		expect(await demo.pick([7, 8])).toBe(7);
		expect(await demo.pick([])).toBe(0);
		expect(demo.width('abcd')).toBe(4);
		expect(demo.width('')).toBe(0);
	});

	it('leaves the labelled frame when the jump crosses a callback', () => {
		// The label names the `withContext`, but the jump is written inside a
		// `map` callback. There is no `return` in JavaScript that leaves both —
		// this was refused for that reason until the emitter grew a jump that
		// crosses one: a throw carrying the value, caught by the frame the label
		// named. `jump(` is the marker; the `catch` is on the `withContext`.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(rows: List<String>): String = runBlocking {',
			'        withContext(Dispatchers.Default) {',
			'            rows.map { row ->',
			'                if (row.isEmpty()) return@withContext "none"',
			'                row',
			'            }.first()',
			'        }',
			'    }',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.jump(');
		expect(emitted.js).toContain('__k.isJump(');
	});

	it('drops the type annotation a `for` binding may carry', () => {
		// `for (item: MatchResult in matches)` passed through gives
		// `for (const item: MatchResult of …)`, which is a SyntaxError in the
		// *bundle* — so it takes every member down at import rather than the one
		// member that named a type.
		const demo = instantiate(
			inClass(
				'    fun sizes(words: List<String>): Int {',
				'        var total = 0',
				'        for (word: String in words) {',
				'            total += word.length',
				'        }',
				'        return total',
				'    }'
			)
		);

		expect(demo.sizes(['ab', 'cde'])).toBe(5);
	});

	it('destructures a declaration positionally', () => {
		const demo = instantiate(
			inClass(
				'    fun swap(a: String, b: String): String {',
				'        val (first, second) = a to b',
				'        return second + first',
				'    }'
			)
		);

		expect(demo.swap('x', 'y')).toBe('yx');
	});

	it('unwraps `?: return` into a guard rather than refusing it', () => {
		const demo = instantiate(
			inClass(
				'    fun tag(x: String?): String {',
				'        val value = x ?: return "missing"',
				'        return value.uppercase()',
				'    }'
			)
		);

		expect(demo.tag(null)).toBe('missing');
		expect(demo.tag('ab')).toBe('AB');
	});

	it('throws for the exception extensions use to say a member is unused', () => {
		const demo = instantiate(
			inClass(
				'    override fun latestUpdatesRequest(page: Int) = throw UnsupportedOperationException("Not used.")'
			)
		);

		expect(() => demo.latestUpdatesRequest(1)).toThrow('Not used.');
	});
});

/* ── lambdas and scope functions ──────────────────────────────────────────── */

describe('lambdas', () => {
	it('gives an implicit `it` to a trailing lambda', () => {
		const demo = instantiate(
			inClass('    fun shout(words: List<String>) = words.map { it.uppercase() }')
		);

		expect(demo.shout(['a', 'b'])).toEqual(['A', 'B']);
	});

	it('names a lambda parameter when the source does', () => {
		const demo = instantiate(
			inClass(
				'    fun keep(words: List<String>) = words.mapNotNull { word -> word.ifBlank { null } }'
			)
		);

		expect(demo.keep(['a', ' ', 'b'])).toEqual(['a', 'b']);
	});

	it('returns the last expression of a multi-statement lambda', () => {
		const demo = instantiate(
			inClass(
				'    fun sizes(words: List<String>) = words.map {',
				'        val trimmed = it.trim()',
				'        trimmed.length',
				'    }'
			)
		);

		expect(demo.sizes([' ab ', 'c'])).toEqual([2, 1]);
	});

	it('binds `apply` to its receiver so bare assignment lands on it', () => {
		const demo = instantiate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    fun build(path: String) = SAnime.create().apply {',
				'        url = "$baseUrl/$path"',
				'        title = path.uppercase()',
				'    }'
			)
		);

		expect(demo.build('x')).toEqual({
			url: 'https://example.invalid/x',
			title: 'X'
		});
	});

	it('reads the source own members from inside an `apply`, not the receiver', () => {
		// The heuristic that matters: writes go to the receiver, and reads of a
		// name the class declares go to the class. Getting this backwards makes
		// `"$baseUrl/x"` read `undefined/x`, silently.
		const demo = instantiate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    fun build() = SAnime.create().apply {',
				'        url = baseUrl',
				'    }'
			)
		);

		expect(demo.build()).toEqual({ url: 'https://example.invalid' });
	});

	it('translates `let` on a nullable receiver', () => {
		const demo = instantiate(inClass('    fun tidy(x: String?) = x?.let { it.trim() } ?: "none"'));

		expect(demo.tidy('  a  ')).toBe('a');
		expect(demo.tidy(null)).toBe('none');
	});

	it('translates `return@label` as a return from the lambda', () => {
		const demo = instantiate(
			inClass(
				'    fun firstNames(words: List<String>) = words.map {',
				'        return@map it.substringBefore(" ")',
				'    }'
			)
		);

		expect(demo.firstNames(['a b', 'c d'])).toEqual(['a', 'c']);
	});
});

/* ── blocks Kotlin inlines, inlined here too ──────────────────────────────── */

/**
 * The non-local `return`, which was the largest single obstacle in the
 * catalogue.
 *
 * Every test here asserts a *value*, not a shape, because the shape alone
 * proves nothing: `words.forEach { return it }` emitted as a callback also
 * compiles, also runs, and answers with the wrong thing. The question is which
 * value the method produces, and only running it asks that.
 */
describe('a `return` that leaves the block it is written in', () => {
	it('returns from the method, not from a `forEach` callback', () => {
		const demo = instantiate(
			inClass(
				'    fun firstLong(words: List<String>): String {',
				'        words.forEach {',
				'            if (it.length < 3) return@forEach',
				'            return it',
				'        }',
				'        return "none"',
				'    }'
			)
		);

		expect(demo.firstLong(['a', 'bb', 'ccc', 'dddd'])).toBe('ccc');
		expect(demo.firstLong(['a', 'bb'])).toBe('none');
	});

	it('leaves the method from inside `?.let`, and skips the block when null', () => {
		const demo = instantiate(
			inClass(
				'    fun href(doc: Document): String {',
				'        doc.selectFirst("a")?.let {',
				'            return it.attr("href")',
				'        }',
				'        return "none"',
				'    }'
			)
		);

		expect(demo.href({ selectFirst: () => ({ attr: () => '/x' }) })).toBe('/x');
		expect(demo.href({ selectFirst: () => null })).toBe('none');
	});

	it('leaves the method from inside `use`', () => {
		const demo = instantiate(
			inClass(
				'    fun read(response: Response): String {',
				'        response.use { r ->',
				'            if (!r.ok) return "bad"',
				'            return r.body',
				'        }',
				'    }'
			)
		);

		expect(demo.read({ ok: true, body: 'hello' })).toBe('hello');
		expect(demo.read({ ok: false, body: 'hello' })).toBe('bad');
	});

	it('keeps `apply` writing to its receiver while the `return` leaves the method', () => {
		const demo = instantiate(
			inClass(
				'    fun build(text: String): SAnime {',
				'        return SAnime.create().apply {',
				'            title = text',
				'            if (text.isEmpty()) return SAnime.create()',
				'        }',
				'    }'
			)
		);

		expect(demo.build('Some show')).toEqual({ title: 'Some show' });
		expect(demo.build('')).toEqual({});
	});

	it('unwraps `?: run { … }`, which is a guard wearing an operator', () => {
		const demo = instantiate(
			inClass(
				'    fun pick(items: List<String>): String {',
				'        val first = items.firstOrNull() ?: run {',
				'            return "none"',
				'        }',
				'        return first',
				'    }'
			)
		);

		expect(demo.pick(['a', 'b'])).toBe('a');
		expect(demo.pick([])).toBe('none');
	});

	it('reads `runCatching { … }.getOrElse { … }` as the try/catch it is', () => {
		const demo = instantiate(
			inClass(
				'    fun parse(text: String): Int {',
				'        val value = runCatching {',
				'            text.toInt()',
				'        }.getOrElse {',
				'            return -1',
				'        }',
				'        return value',
				'    }'
			)
		);

		expect(demo.parse('12')).toBe(12);
		expect(demo.parse('not a number')).toBe(-1);
	});

	it('reads `runCatching { … }.getOrNull()` as a try/catch when a `return` leaves it', () => {
		const demo = instantiate(
			inClass(
				'    fun parse(text: String): Int {',
				'        val value = runCatching {',
				'            if (text.isEmpty()) return -2',
				'            text.toInt()',
				'        }.getOrNull() ?: -1',
				'        return value',
				'    }'
			)
		);

		expect(demo.parse('12')).toBe(12);
		expect(demo.parse('not a number')).toBe(-1);
		expect(demo.parse('')).toBe(-2);
	});

	it('evaluates a `getOrDefault` argument after the block, whether or not it threw', () => {
		// The argument of `x.f(y)` is evaluated after `x`, and here `x` is the
		// block. Emitting it inside the `catch` would skip it on success;
		// emitting it above the `try` would run it first. `getOrDefault(
		// emptyList())` is ordinary in this ecosystem, and that is a call.
		const order: string[] = [];
		const demo = instantiate(
			inClass(
				'    fun parse(text: String): Int {',
				'        val value = runCatching {',
				'            if (text == "stop") return -2',
				'            note("block")',
				'            text.toInt()',
				'        }.getOrDefault(fallback())',
				'        return value',
				'    }'
			),
			{
				note: (what: string) => order.push(what),
				fallback: () => {
					order.push('fallback');
					return -1;
				}
			}
		);

		expect(demo.parse('7')).toBe(7);
		expect(order).toEqual(['block', 'fallback']);

		order.length = 0;
		expect(demo.parse('not a number')).toBe(-1);
		expect(order).toEqual(['block', 'fallback']);

		// A non-local return leaves before either, exactly as Kotlin's does.
		order.length = 0;
		expect(demo.parse('stop')).toBe(-2);
		expect(order).toEqual([]);
	});

	it('resolves `return@mapNotNull` written inside an `apply` inside the `mapNotNull`', () => {
		const demo = instantiate(
			inClass(
				'    fun titles(items: List<String>): List<SAnime> {',
				'        return items.mapNotNull { item ->',
				'            SAnime.create().apply {',
				'                if (item.isEmpty()) return@mapNotNull null',
				'                title = item',
				'            }',
				'        }',
				'    }'
			)
		);

		expect(demo.titles(['a', '', 'b'])).toEqual([{ title: 'a' }, { title: 'b' }]);
	});

	it('carries `await` out of an inlined block, so the member is still async', async () => {
		const demo = instantiate(
			inClass(
				'    suspend fun body(url: String): String {',
				'        val request = GET(url)',
				'        request.let { r ->',
				'            return fetch(r.url).await()',
				'        }',
				'    }'
			),
			{ fetch: (url: string) => `body of ${url}` }
		);

		await expect(demo.body('https://example.invalid/a')).resolves.toBe(
			'body of https://example.invalid/a'
		);
	});

	it('unwraps `?: return` on the right of an assignment', () => {
		const demo = instantiate(
			inClass(
				'    fun titles(items: List<String>): List<SAnime> {',
				'        return items.mapNotNull { item ->',
				'            SAnime.create().apply {',
				'                title = item.firstOrNull() ?: return@mapNotNull null',
				'            }',
				'        }',
				'    }'
			)
		);

		expect(demo.titles(['ab', '', 'cd'])).toEqual([{ title: 'a' }, { title: 'c' }]);
	});
});

/* ── coroutines ───────────────────────────────────────────────────────────── */

describe('coroutines', () => {
	it('makes `suspend fun` async and awaits `.await()`', async () => {
		const demo = instantiate(
			inClass(
				'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
				'        val page = fetch().await()',
				'        return listOf(Video(page, "default", page))',
				'    }'
			),
			{ fetch: () => 'https://example.invalid/v.mp4' }
		);

		await expect(demo.getVideoList({})).resolves.toEqual([
			{
				url: 'https://example.invalid/v.mp4',
				quality: 'default',
				videoUrl: 'https://example.invalid/v.mp4'
			}
		]);
	});

	it('awaits a collection helper whose lambda suspends', async () => {
		// A `map` handed an un-awaited promise yields a list of promises, and a
		// `filter` handed one keeps everything: both are plausible wrong output.
		const demo = instantiate(
			inClass(
				'    suspend fun all(paths: List<String>): List<String> {',
				'        return paths.map { fetch(it).await() }',
				'    }'
			),
			{ fetch: (path: string) => `got:${path}` }
		);

		await expect(demo.all(['a', 'b'])).resolves.toEqual(['got:a', 'got:b']);
	});

	it('drops the dispatcher and awaits the block of a `withContext`', async () => {
		const demo = instantiate(
			inClass(
				'    suspend fun load(): String = withContext(Dispatchers.IO) {',
				'        fetch().await()',
				'    }'
			),
			{ fetch: () => 'body' }
		);

		await expect(demo.load()).resolves.toBe('body');
	});
});

/* ── the eight families, end to end ───────────────────────────────────────── */

describe('the method families that block conversion', () => {
	it('translates a request builder', () => {
		const demo = instantiate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    override val headers = "H"',
				'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/popular?page=$page", headers)'
			)
		);

		expect(demo.popularAnimeRequest(2)).toEqual({
			url: 'https://example.invalid/popular?page=2',
			headers: 'H',
			method: 'GET'
		});
	});

	it('reorders named arguments against a signature it knows', () => {
		const demo = instantiate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    fun request() = GET(headers = "H", url = baseUrl)'
			)
		);

		expect(demo.request()).toEqual({
			url: 'https://example.invalid',
			headers: 'H',
			method: 'GET'
		});
	});

	it('reorders named arguments for a translated constructor and function', () => {
		const demo = instantiate(
			kt(
				'class Request(val url: String, val headers: String, val cache: Boolean) {',
				'    fun describe(): String = url + "/" + headers + "/" + cache',
				'}',
				'class Demo : Source() {',
				'    fun format(cache: Boolean, request: Request): String = request.describe() + "/" + cache',
				'    fun make(): String = format(request = Request(cache = true, headers = "H", url = "U"), cache = false)',
				'}'
			)
		);

		expect(demo.make()).toBe('U/H/true/false');
	});

	it('translates an episode list walk', () => {
		const demo = instantiate(
			inClass(
				'    override fun episodeListParse(response: Response): List<SEpisode> {',
				'        val rows = response.asJsoup()',
				'        return rows.map { row ->',
				'            SEpisode.create().apply {',
				'                name = row.substringBefore("|")',
				'                episode_number = row.substringAfter("|").toFloatOrNull() ?: 0F',
				'            }',
				'        }.reversed()',
				'    }'
			)
		);

		expect(demo.episodeListParse({ html: ['One|1', 'Two|2'] })).toEqual([
			{ name: 'Two', episode_number: 2 },
			{ name: 'One', episode_number: 1 }
		]);
	});

	it('translates a details parse with a `when` and a `!!`', () => {
		const demo = instantiate(
			inClass(
				'    override fun animeDetailsParse(document: Document) = SAnime.create().apply {',
				'        title = document.select("title").first()!!.trim()',
				'        status = when (document.select("status").firstOrNull()) {',
				'            "Ongoing" -> SAnime.ONGOING',
				'            else -> SAnime.UNKNOWN',
				'        }',
				'    }'
			),
			{}
		);

		const document = {
			select: (what: string) => (what === 'title' ? ['  Name  '] : ['Ongoing'])
		};

		expect(demo.animeDetailsParse(document)).toEqual({
			title: 'Name',
			status: 1
		});
	});
});

/* ── declarations inside declarations ─────────────────────────────────────── */

describe('declarations written inside other declarations', () => {
	it('keeps a local `fun` local, with the enclosing values it closed over', () => {
		// Hoisting it to module scope the way a local *class* is hoisted would
		// lose `prefix` and resolve `name` against nothing — an emitted module
		// that reads a member of the wrong object rather than failing.
		const demo = instantiate(
			inClass(
				'    fun tidy(items: List<String>): List<String> {',
				'        val prefix = name',
				'        fun label(text: String): String = prefix + text',
				'        return items.map { label(it) }',
				'    }'
			),
			{ name: 'X-' }
		);

		expect(demo.tidy(['a', 'b'])).toEqual(['X-a', 'X-b']);
	});

	it('gives every default in a multi-parameter list to the parameter that owns it', () => {
		// The grammar puts a default *beside* its parameter rather than inside
		// it, and gives `null` no named node at all — so reading the list by
		// position paired `true` with `prefix`, left `prefix` with no default,
		// and then met the stray `null` where a parameter was expected. Every
		// per-host extractor in the measured catalogue is written this way.
		const demo = instantiate(
			inClass(
				'    fun two(',
				'        url: String,',
				'        prefix: String? = null,',
				'        redirect: Boolean = true,',
				'        subs: List<String> = emptyList(),',
				'    ): String {',
				'        return (prefix ?: url) + "/" + redirect + "/" + subs.size',
				'    }'
			)
		);

		expect(demo.two('u')).toBe('u/true/0');
		expect(demo.two('u', 'p')).toBe('p/true/0');
		expect(demo.two('u', null, false, ['a'])).toBe('u/false/1');
	});

	it('keeps a constructor default, because a missing one is a wrong value', () => {
		// `= true` dropped from the signature is not a missing argument, it is
		// `undefined` where Kotlin gives `true`.
		const part = evaluate(
			kt(
				'class Utils(val client: String, val redirect: Boolean = true) {',
				'    fun describe(): String = client + "/" + redirect',
				'}'
			),
			'new Utils("c").describe()'
		);

		expect(part).toBe('c/true');
	});

	it('takes a `vararg` as a rest parameter, so every argument arrives', () => {
		const demo = instantiate(
			inClass('    fun joinAll(vararg parts: String): String = parts.joinToString("-")')
		);

		expect(demo.joinAll('a', 'b', 'c')).toBe('a-b-c');
		expect(demo.joinAll()).toBe('');
	});

	it('declares a base class before the class extending it, whatever the source order', () => {
		// Kotlin does not care where the base sits; JavaScript does, and a class
		// naming one below it throws while the *module* is evaluating — which
		// takes the whole bundle down at load, after conversion said it was fine.
		const demo = instantiate(
			inClass(
				'    fun part(): String = GenreFilter().toUriPart()',
				'    private class GenreFilter : UriPartFilter(arrayOf("Action" to "action"))',
				'    private open class UriPartFilter(val vals: Array<Pair<String, String>>) {',
				'        fun toUriPart(): String = vals[0].second',
				'    }'
			)
		);

		expect(demo.part()).toBe('action');
	});

	it('reads a base-class member on first use rather than during construction', () => {
		// The driver attaches the base after the subclass constructor has run, so
		// `private val apiHeaders = headers.newBuilder()…` assigned in the
		// constructor reads `undefined` and the bundle dies at load.
		let built = 0;
		const demo = instantiate(
			inClass(
				'    private val apiHeaders = headers.newBuilder().build()',
				'    fun which(): String = apiHeaders'
			),
			{
				headers: {
					newBuilder: () => {
						built += 1;
						return { build: () => 'built' };
					}
				}
			}
		);

		expect(built).toBe(0);
		expect(demo.which()).toBe('built');
		expect(demo.which()).toBe('built');
		// Still a `val`: evaluated once, however often it is read.
		expect(built).toBe(1);
	});

	it('lets a DTO name itself past an `apply` receiver that shadows its field', () => {
		const title = evaluate(
			kt(
				'data class Row(val title: String) {',
				'    fun toSAnime(): SAnime = SAnime.create().apply {',
				'        title = this@Row.title',
				'    }',
				'}'
			),
			'Row("Some show").toSAnime().title'
		);

		expect(title).toBe('Some show');
	});
});

/* ── what the grammar hands over in pieces ────────────────────────────────── */

describe('shapes the grammar splits apart', () => {
	it('keeps the value of `return f()`, which parses as two statements', () => {
		// The vendored grammar splits `return emptyList()` — a `return` and a
		// bare call with an *empty* argument list — into a valueless jump and a
		// sibling expression, while `return listOf(1)` stays whole. Emitting the
		// pieces as written gives `return; emptyList();`: a plugin that installs,
		// searches, and shows an empty list, with no error anywhere.
		const demo = instantiate(
			inClass(
				'    override fun episodeListParse(response: Response): List<SEpisode> {',
				'        return emptyList()',
				'    }'
			)
		);

		expect(demo.episodeListParse({})).toEqual([]);
	});

	it('reads `= null` as a body, though `null` is not a named node', () => {
		const demo = instantiate(inClass('    override fun searchAnimeNextPageSelector() = null'));

		expect(demo.searchAnimeNextPageSelector()).toBeNull();
	});

	it('reads a default argument, which is a sibling of its parameter', () => {
		const demo = instantiate(
			inClass('    fun label(name: String, prefix: String = "ep") = prefix + name')
		);

		expect(demo.label('1')).toBe('ep1');
		expect(demo.label('1', 'x')).toBe('x1');
	});

	it('evaluates a file-scope getter at every read, not once', () => {
		// A `val` with a `get()` is a function in Kotlin wearing a property's
		// spelling, and this ecosystem leans on the difference: a filter list
		// built once would hand every search the state the last one ticked.
		const built = evaluate(
			kt(
				'val NEXT: MutableList<String> get() = mutableListOf("a")',
				'',
				'fun take(): String {',
				'    NEXT.add("b")',
				'    return NEXT.joinToString(",")',
				'}'
			),
			'take()'
		);

		expect(built).toBe('a');
	});

	it('reads a file-scope getter written on the line below its property', () => {
		const demo = instantiate(
			kt(
				'val LIMIT: Int',
				'    get() = 12',
				'',
				'class Demo : Source() {',
				'    fun size(): Int = LIMIT',
				'}'
			)
		);

		expect(demo.size()).toBe(12);
	});

	it('reads a getter written on the line below its property', () => {
		const demo = instantiate(
			inClass('    override val baseUrl: String', '        get() = "https://example.invalid"')
		);

		expect(demo.baseUrl).toBe('https://example.invalid');
	});

	it('ignores comments wherever the grammar puts them', () => {
		// Comments are *named* children here, so they arrive between statements
		// and between class members.
		const demo = instantiate(
			inClass(
				'    // ============ Popular ============',
				'    override val baseUrl = "https://example.invalid"',
				'',
				'    fun page(n: Int): String {',
				'        /* the first page is 1, not 0 */',
				'        val start = n + 1 // one-based',
				'        return "$baseUrl/$start"',
				'    }'
			)
		);

		expect(demo.page(0)).toBe('https://example.invalid/1');
	});
});

describe('the delegates this ecosystem uses instead of construction', () => {
	it('resolves `by injectLazy<Json>()` to the runtime parser', () => {
		const demo = instantiate(
			inClass('    private val json by injectLazy<Json>()'),
			{},
			{
				Json: { marker: true }
			}
		);

		expect(demo.json).toEqual({ marker: true });
	});

	it('takes the injected type from the property when the call omits it', () => {
		const demo = instantiate(
			inClass('    private val json: Json by injectLazy()'),
			{},
			{
				Json: { marker: true }
			}
		);

		expect(demo.json).toEqual({ marker: true });
	});

	it('gives a preferences store the runtime actually owns', () => {
		// It used to resolve to `null` — the argument `__k.pref` ignores —
		// which was right while a converted bundle declared no settings and
		// wrong the moment one could: `preferences.edit()` is how these
		// extensions remember a mirror, and `null.edit()` is not a fallback.
		const demo = instantiate(
			inClass(
				'    private val preferences by getPreferencesLazy()',
				'    fun quality() = preferences.getString("q", "1080p")!!'
			)
		);

		expect(demo.preferences).not.toBeNull();
		expect(demo.quality()).toBe('1080p');
	});

	it('refuses an injection of something the host does not own', () => {
		expect(refusalNames(inClass('    private val loader by injectLazy<Loader>()'))).toContain(
			'`by injectLazy<Loader>()`'
		);
	});

	it('reads the store through the container, which is what ext-lib 16 documents', () => {
		// `getSourcePreferences()` was removed in ext-lib 16 and this is the
		// spelling that replaced it, so the share of the ecosystem writing it
		// only grows. Refusing it cost every extension that had migrated.
		const demo = instantiate(
			inClass(
				'    override val id = 7L',
				'    private val preferences = Injekt.get<Application>().getSharedPreferences("source_$id", 0x0000)',
				'    fun quality() = preferences.getString("q", "1080p")!!'
			)
		);

		expect(demo.quality()).toBe('1080p');
	});

	it('reads the store through the older delegate spelling of the same thing', () => {
		// `private val context: Application by injectLazy()` and the
		// `Injekt.get<Application>()` above are one idiom written two ways, a
		// generation apart. Both resolve to the store; neither resolves to a
		// context.
		const demo = instantiate(
			inClass(
				'    private val context: Application by injectLazy()',
				'    fun quality() = context.getSharedPreferences("source_1", 0).getString("q", "720p")!!'
			)
		);

		expect(demo.quality()).toBe('720p');
	});

	it('still refuses the container when it is reached for anything else', () => {
		// The exemption is the preferences idiom, not the type. An `Application`
		// reached for a real context, or a container reached for the host's
		// http client, would resolve to a shim that has never heard of it and
		// fail inside the sandbox — the silent-bug shape `subset.ts` refuses to
		// trade a named refusal for.
		expect(refusalNames(inClass('    val client = Injekt.get<NetworkHelper>().client'))).toContain(
			'Injekt.get'
		);
		expect(refusalNames(inClass('    val dir = Injekt.get<Application>().filesDir'))).toContain(
			'Injekt.get'
		);
	});
});

describe('callable references', () => {
	it('translates `Type::member` by the member, since there are no types to check', () => {
		const demo = instantiate(
			inClass('    fun tidy(words: List<String>) = words.filter(String::isNotBlank)')
		);

		expect(demo.tidy(['a', ' ', 'b'])).toEqual(['a', 'b']);
	});

	it('translates a bare `::member` as a call on the source', () => {
		const demo = instantiate(inClass('    fun all(rows: List<String>) = rows.map(::wrap)'), {
			wrap: (row: string) => `[${row}]`
		});

		expect(demo.all(['a'])).toEqual(['[a]']);
	});

	it('calls the method on the value when the reference is bound to one', () => {
		// `helper::wrap` is bound: the receiver is the `helper`, and the argument
		// is the argument. Read as `Type::member` instead it becomes
		// `(row) => row.wrap()`, which asks a string for a method it has not got
		// — an error at the far end of a conversion rather than here.
		const demo = instantiate(
			inClass(
				'    private val helper = Helper()',
				'    fun all(rows: List<String>) = rows.map(helper::wrap)',
				'    private class Helper {',
				'        fun wrap(text: String): String = "[" + text + "]"',
				'    }'
			)
		);

		expect(demo.all(['a', 'b'])).toEqual(['[a]', '[b]']);
	});

	it('preserves JSON builder lambdas', () => {
		const refusal = refusalNames(
			inClass('    fun make() = buildJsonObject { putJsonObject("data") { put("x", 1) } }')
		);
		expect(refusal).not.toContain('a lambda passed to `.putJsonObject()`');
		expect(refusal).toEqual([]);
	});

	it('binds a builder block to its accumulator, not to the source', () => {
		// A bare `put` inside `buildJsonObject { … }` is a call on the builder.
		// Emitted as an ordinary lambda it became `this.put(…)` — the source
		// object, which has no `put` — so the conversion succeeded and the
		// member died at its first call.
		const source = inClass(
			'    fun make(): JsonObject = buildJsonObject {',
			'        put("page", 1)',
			'        putJsonObject("filters") {',
			'            put("kind", "anime")',
			'        }',
			'    }'
		);

		// The block has to be a `function`, not an arrow: an arrow keeps the
		// enclosing `this`, which is the source, and that is the bug.
		expect(translate(source).js).toContain('__k.buildJsonObject(function ()');
		expect(instantiate(source).make()).toEqual({
			page: 1,
			filters: { kind: 'anime' }
		});
	});

	it('translates a bare reference to a Kotlin extension function', () => {
		const demo = instantiate(
			inClass(
				'    fun merge(target: MutableList<Int>, items: List<Int>): MutableList<Int> {',
				'        ::addAll(target, items)',
				'        return target',
				'    }'
			)
		);

		expect(demo.merge([1], [2, 3])).toEqual([1, 2, 3]);
	});

	it('binds the receiver of a collection extension reference', () => {
		const demo = instantiate(
			inClass(
				'    fun merge(target: MutableList<Int>, items: List<Int>): MutableList<Int> {',
				'        items.let(target::addAll)',
				'        return target',
				'    }'
			)
		);

		expect(demo.merge([1], [2, 3])).toEqual([1, 2, 3]);
	});
});

describe('the base class an extension may call through to', () => {
	it('awaits the base parser it wraps, because the driver fetches in it', async () => {
		// `override fun episodeListParse(response) =
		// super.episodeListParse(response).reversed()` is the commonest use of
		// `super.` in this ecosystem — 23 sources here — and the driver's own
		// `episodeListParse` is asynchronous, because reading an episode list may
		// take another request. Un-awaited, `.reversed()` was handed a *promise*:
		// `__k.reversed` answers an empty list for something that is not a list,
		// so the episode list came back empty with nothing refused anywhere.
		const demo = instantiate(
			inClass(
				'    override fun episodeListParse(response: Response): List<SEpisode> {',
				'        return super.episodeListParse(response).reversed()',
				'    }'
			),
			{},
			{
				__super: { episodeListParse: async (r: { rows: string[] }) => r.rows }
			}
		);

		expect(await demo.episodeListParse({ rows: ['a', 'b'] })).toEqual(['b', 'a']);
	});
});

describe('the jsoup surface', () => {
	it('reads `parent()` and `tagName()` as the properties the runtime answers with', () => {
		// jsoup spells these as calls and `shims/dom.ts` spells them as fields.
		// Emitted as written they pass the passthrough allowlist, translate,
		// package and install, and answer the first call with `parent is not a
		// function` — inside a sandbox, at the first search.
		const demo = instantiate(
			inClass('    fun owner(element: Element): String = element.parent()!!.tagName()')
		);

		expect(demo.owner({ parent: { tagName: 'div' } })).toBe('div');
	});

	it('keeps a method of the same name that this file declares itself', () => {
		const demo = instantiate(
			kt(
				'class Row(val label: String) {',
				'    fun id(): String = "row-" + label',
				'}',
				'',
				'class Demo : Source() {',
				'    fun name(row: Row): String = row.id()',
				'}'
			)
		);

		expect(demo.name({ id: () => 'row-a', label: 'a' })).toBe('row-a');
	});
});

describe('type tests', () => {
	it('tells a class this file declares apart from its siblings', () => {
		// The filter idiom, which every extension with a filter list writes:
		// `when (filter) { is SortFilter -> … }`. Handing the runtime the class
		// *name* asked its table of framework shapes about a class declared four
		// lines above, which answered no — so no branch ran, nothing refused,
		// and the search went out without the viewer's choices on it.
		const picked = evaluate(
			kt(
				'open class Filter(val label: String)',
				'class SortFilter(label: String) : Filter(label)',
				'class YearFilter(label: String) : Filter(label)',
				'',
				'fun describe(filter: Filter): String = when (filter) {',
				'    is SortFilter -> "sort:" + filter.label',
				'    is YearFilter -> "year:" + filter.label',
				'    else -> "other"',
				'}'
			),
			'[describe(new SortFilter("a")), describe(new YearFilter("b"))].join("|")'
		);

		expect(picked).toBe('sort:a|year:b');
	});

	it('keeps a subclass answering to its base class', () => {
		const picked = evaluate(
			kt(
				'open class Filter(val label: String)',
				'class SortFilter(label: String) : Filter(label)',
				'',
				'fun isFilter(value: Any): Boolean = value is Filter'
			),
			'[isFilter(new SortFilter("a")), isFilter("x")].join(",")'
		);

		expect(picked).toBe('true,false');
	});
});

describe('values that outlive the construct that produced them', () => {
	it('lets a `return` inside a `when` return from the method, not from a wrapper', () => {
		// Wrapping the `when` in an arrow IIFE would make this `return` leave the
		// IIFE instead, and the method would carry on with a value its author
		// never meant it to have — silently.
		const demo = instantiate(
			inClass(
				'    fun pick(kind: String): String {',
				'        when (kind) {',
				'            "early" -> return "stopped"',
				'            else -> { }',
				'        }',
				'        return "carried on"',
				'    }'
			)
		);

		expect(demo.pick('early')).toBe('stopped');
		expect(demo.pick('other')).toBe('carried on');
	});

	it('lets a `return` inside a `try` used as a local initialiser leave the method', () => {
		const demo = instantiate(
			inClass(
				'    fun parse(text: String): String {',
				'        val value = try {',
				'            text.toInt()',
				'        } catch (e: Exception) {',
				'            return "gave up"',
				'        }',
				'        return "got $value"',
				'    }'
			)
		);

		expect(demo.parse('4')).toBe('got 4');
		expect(demo.parse('nope')).toBe('gave up');
	});

	it('carries a `when` value out of a function whose whole body it is', () => {
		const demo = instantiate(
			inClass(
				'    fun band(n: Int) = when {',
				'        n > 10 -> "high"',
				'        else -> "low"',
				'    }'
			)
		);

		expect(demo.band(20)).toBe('high');
		expect(demo.band(1)).toBe('low');
	});
});

describe('extension functions', () => {
	it('moves the receiver into the first argument, at both ends', () => {
		// `fun Element.getInfo(key)` is a function whose first argument is spelled
		// as a receiver. Emitting the signature as written would produce one that
		// silently ignored the value it was called on.
		const demo = instantiate(
			inClass(
				'    private fun String.tagged(prefix: String) = prefix + trim()',
				'',
				'    fun label(raw: String) = raw.tagged("ep-")'
			)
		);

		expect(demo.label('  7 ')).toBe('ep-7');
	});

	it('translates a top-level extension function and its call site together', () => {
		const value = evaluate(
			kt(
				'data class Row(val file: String)',
				'',
				'fun Row.label(): String = file.uppercase()',
				'',
				'class Demo : Source() {',
				'    fun show(row: Row) = row.label()',
				'}'
			),
			'new Demo().show(Row("a.mp4"))'
		);

		expect(value).toBe('A.MP4');
	});

	it('keeps a safe call safe through an extension function', () => {
		const demo = instantiate(
			inClass(
				'    private fun String.tagged() = trim()',
				'',
				'    fun label(raw: String?) = raw?.tagged()'
			)
		);

		expect(demo.label(null) ?? null).toBeNull();
		expect(demo.label('  x ')).toBe('x');
	});

	it('passes a trailing lambda through a declared extension function', () => {
		// `response.retryOn419 { req -> … }` is `retryOn419(response, (req) =>
		// …)` under the same rule as any other argument — the receiver first,
		// the trailing lambda last — and used to be refused outright rather than
		// converted, so nothing that shape appeared in ever installed.
		const demo = instantiate(
			inClass(
				'    private fun Int.retryOnZero(onRetry: (Int) -> Int): Int {',
				'        if (this != 0) return this',
				'        return onRetry(this)',
				'    }',
				'',
				'    fun result(value: Int) = value.retryOnZero { it + 1 }'
			)
		);

		expect(demo.result(0)).toBe(1);
		expect(demo.result(5)).toBe(5);
	});
});

describe('scope functions with no receiver', () => {
	it('runs a bare `run { }` for its value', () => {
		const demo = instantiate(
			inClass(
				'    fun total(a: Int, b: Int) = run {',
				'        val sum = a + b',
				'        sum * 2',
				'    }'
			)
		);

		expect(demo.total(2, 3)).toBe(10);
	});
});

describe('declarations that are not where they belong', () => {
	it('lifts a class declared inside a function to module scope', () => {
		const demo = instantiate(
			inClass(
				'    fun wrap(name: String): Row {',
				'        data class Row(val title: String)',
				'        return Row(name)',
				'    }'
			)
		);

		expect(demo.wrap('x')).toEqual({ title: 'x' });
	});

	it('evaluates a companion `by lazy` constant, which has nothing to memoise', () => {
		const demo = instantiate(
			inClass(
				'    companion object {',
				'        private val PREFIX by lazy { "ep-" }',
				'    }',
				'',
				'    fun label(n: Int) = PREFIX + n'
			)
		);

		expect(demo.label(2)).toBe('ep-2');
	});
});

describe('lambda parameters', () => {
	it('unpacks a destructured parameter instead of reading it as two arguments', () => {
		// `{ (key, value) -> … }` binds the components of one argument. Emitting
		// them as a parameter list shifts every later argument along by one.
		const demo = instantiate(
			inClass(
				'    fun show(pairs: List<Pair<String, Int>>) = pairs.map { (name, count) -> name + count }'
			)
		);

		expect(demo.show([{ first: 'a', second: 1 }])).toEqual(['a1']);
	});

	it('drops a parameter’s type annotation instead of emitting it', () => {
		// `{ element: Element -> … }` carries its type in the declaration node's
		// own text. Passing that through gives `(element: Element) =>`, which is
		// a SyntaxError that surfaces at *import* and takes every member of the
		// bundle with it rather than the one member written oddly.
		const demo = instantiate(
			inClass('    fun titles(rows: List<String>) = rows.map { row: String -> row + "!" }')
		);

		expect(demo.titles(['a'])).toEqual(['a!']);
	});
});

/* ── classes with a base ──────────────────────────────────────────────────── */

describe('a class that extends another', () => {
	it('passes a locally declared base its constructor arguments', () => {
		// The failure this replaces: the supertype and its arguments were both
		// dropped, so `class Genre : UriPart("g", "genre")` came out as `class
		// Genre {}` — an object with no `part`, no error, and a `toUriPart()`
		// that answered `undefined` on every search.
		const demo = instantiate(
			kt(
				'class Demo : Source() {',
				'    fun pick() = Genre().toUriPart()',
				'',
				'    open class UriPart(val label: String, val part: String) {',
				'        fun toUriPart() = part',
				'    }',
				'',
				'    class Genre : UriPart("Genre", "genre")',
				'}'
			)
		);

		expect(demo.pick()).toBe('genre');
	});

	it('extends the runtime’s own `AnimeFilter.Select`, so `state` is real', () => {
		// The ecosystem's idiom: a `UriPartFilter` over `AnimeFilter.Select`,
		// reading `vals[state]`. Without the base there is no `state` at all and
		// the index is `undefined`.
		const demo = instantiate(
			kt(
				'class Demo : Source() {',
				'    fun pick() = TypeFilter().toUriPart()',
				'',
				'    open class UriPartFilter(name: String, val vals: Array<Pair<String, String>>) :',
				'        AnimeFilter.Select<String>(name, vals.map { it.first }.toTypedArray()) {',
				'        fun toUriPart() = vals[state].second',
				'    }',
				'',
				'    class TypeFilter : UriPartFilter("Type", arrayOf(Pair("All", ""), Pair("Film", "f")))',
				'}'
			),
			{},
			{
				AnimeFilter: {
					Select: function Select(this: Record<string, unknown>, name: string, values: unknown) {
						this.name = name;
						this.values = values;
						this.state = 0;
					}
				}
			}
		);

		expect(demo.pick()).toBe('');
	});

	it('refuses a class whose base class is not one this build has', () => {
		expect(
			refusalNames(
				kt(
					'class Demo : Source() {',
					'    fun go() = 1',
					'}',
					'',
					'class Helper : SomeLibraryThing("x")'
				)
			)
		).toContain('a base class `SomeLibraryThing` this build has not');
	});

	it('lets the class that constructs a base take the name from a marker class', () => {
		// A `SomethingFactory : AnimeSourceFactory` sits above the real source in
		// this ecosystem's multi-source files, and it names an interface rather
		// than constructing anything.
		const emission = translate(
			kt(
				'class DemoFactory : AnimeSourceFactory {',
				'    override fun createSources() = listOf(Demo())',
				'}',
				'',
				'class Demo : Source() {',
				'    override val name = "Demo"',
				'}'
			)
		);

		expect(emission.className).toBe('Demo');
	});
});

describe('a method declared on a class in the same source', () => {
	it('calls it rather than refusing the name', () => {
		const demo = instantiate(
			kt(
				'class Demo : Source() {',
				'    fun ask(box: Box) = box.contents()',
				'}',
				'',
				'class Box {',
				'    fun contents() = "inside"',
				'}'
			)
		);

		expect(demo.ask({ contents: () => 'inside' } as unknown as never)).toBe('inside');
	});

	it('still refuses a method no declaration in reach defines', () => {
		expect(refusalNames(inClass('    fun go(x: String) = x.mysteriousHelper()'))).toContain(
			'`.mysteriousHelper()`'
		);
	});

	it('passes through Kotlin mutable-map put to the runtime map', () => {
		const emission = translate(
			inClass('    fun add(values: MutableMap<String, Int>) = values.put("key", 1)')
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain("values.put('key', 1)");
	});
});

/* ── the Kotlin this build used to stop at ────────────────────────────────── */

describe('declarations Kotlin erases, and this build now erases too', () => {
	it('emits nothing for a `typealias` and refuses nothing for it either', () => {
		const source = kt(
			'typealias GenericBlock = (String) -> Unit',
			'',
			'class Demo : Source() {',
			'    fun label(): String = "x"',
			'}'
		);
		const emission = translate(source);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).not.toContain('GenericBlock');
	});

	it('constructs through an alias, because the alias is the name written', () => {
		const source = kt(
			'class Row(val title: String)',
			'',
			'typealias Entry = Row',
			'',
			'class Demo : Source() {',
			'    fun build(): Row = Entry("One")',
			'}'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(instantiate(source).build()).toEqual({ title: 'One' });
	});
});

describe('a local declared before it has a value', () => {
	it('declares it and lets the assignment a line later fill it', () => {
		// Kotlin's definite-assignment rule makes a read before the assignment a
		// compile error there, so the gap can never be observed here.
		const demo = instantiate(
			inClass(
				'    fun build(): String {',
				'        var packed: String',
				'        if (true) {',
				'            packed = "one"',
				'        } else {',
				'            packed = "two"',
				'        }',
				'        return packed',
				'    }'
			)
		);

		expect(demo.build()).toBe('one');
	});
});

describe('an `init` block, which is constructor code', () => {
	it('runs it where it was written, after the properties above it', () => {
		const demo = instantiate(
			kt(
				'class Demo : Source() {',
				'    val seen = mutableListOf<String>()',
				'    init {',
				'        seen.add("first")',
				'    }',
				'    val after = "later"',
				'    init {',
				'        seen.add(after)',
				'    }',
				'}'
			)
		);

		expect(demo.seen).toEqual(['first', 'later']);
	});

	it('reads a constructor parameter that is not a property', () => {
		// `size` exists only inside the constructor in Kotlin. Read as
		// `this.size` — which is where a bare name otherwise falls back to — it
		// would be undefined at construction, with nothing to say so.
		const source = kt(
			'class Unbaser(size: Int) {',
			'    val table = mutableMapOf<String, Int>()',
			'    init {',
			'        table["size"] = size',
			'    }',
			'}',
			'',
			'class Demo : Source() {',
			'    fun build(): Int = Unbaser(62).table["size"]!!',
			'}'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(instantiate(source).build()).toBe(62);
	});
});

describe('`synchronized`, which is a lock in a runtime with one thread', () => {
	it('runs the block and answers with its value', () => {
		const demo = instantiate(
			inClass(
				'    private val lock = Any()',
				'    fun build(): String = synchronized(lock) { "held" }'
			)
		);

		expect(demo.build()).toBe('held');
	});

	it('keeps a `return` inside the block a return from the member', () => {
		// Kotlin inlines `synchronized`, so a bare `return` inside one leaves
		// the *member*. A callback would swallow it.
		const demo = instantiate(
			inClass(
				'    fun build(): String {',
				'        synchronized(this) {',
				'            return "early"',
				'        }',
				'    }'
			)
		);

		expect(demo.build()).toBe('early');
	});
});

describe('writing a preference back, which is how a chosen mirror is saved', () => {
	it('passes the editor chain through, and `apply()` is not `apply { }`', () => {
		const source = inClass(
			'    fun save() {',
			'        preferences.edit().putString("domain", "one").putBoolean("seen", true).apply()',
			'    }'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(translate(source).js).toContain('.edit().putString(');
		expect(translate(source).js).toContain('.apply()');
		expect(translate(source).js).not.toContain('__k.apply(');
	});

	it('still inlines `apply { }`, which carries a block', () => {
		const demo = instantiate(
			inClass(
				'    fun build(): SAnime = SAnime.create().apply {',
				'        title = "One"',
				'    }'
			),
			{ SAnime: { create: () => ({ title: '' }) } }
		);

		expect(demo.build()).toEqual({ title: 'One' });
	});
});

describe('the named arguments that sit after a vararg', () => {
	it('passes `split(…, limit = n)` as options rather than as a delimiter', () => {
		const source = inClass('    fun build(): String = "a,b,c".split(",", limit = 2).last()');

		expect(translate(source).js).toContain('{ limit: 2 }');
		expect(translate(source).refusals).toEqual([]);
	});

	it('still refuses a named argument it has no signature for', () => {
		expect(refusalNames(inClass('    fun build() = fetch(page = 2)'))).toEqual([
			'a named argument to `fetch`'
		]);
	});
});

describe('a constant an extension inherits from its base class', () => {
	it('resolves the tri-state constants a filter subclass writes bare', () => {
		const source = kt(
			'class Tag(name: String) : AnimeFilter.TriState(name) {',
			'    fun mode(): String = if (state == STATE_INCLUDE) "in" else "out"',
			'}',
			'',
			'class Demo : Source() {',
			'    fun build(): String = "x"',
			'}'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(translate(source).js).toContain('AnimeFilter.TriState.STATE_INCLUDE');
	});

	it('lets a file that declares the name itself keep meaning its own', () => {
		const source = kt(
			'const val STATE_INCLUDE = 9',
			'',
			'class Demo : Source() {',
			'    fun build(): Int = STATE_INCLUDE',
			'}'
		);

		expect(translate(source).js).not.toContain('AnimeFilter.TriState.STATE_INCLUDE');
		expect(instantiate(source).build()).toBe(9);
	});
});

describe('an extension function declared in an `object`', () => {
	it('resolves at the call site, through the object that holds it', () => {
		// A Kotlin `object` becomes a frozen literal rather than a set of module
		// bindings, and its extension functions were never registered at all —
		// so every call to one was refused as an unknown passthrough. This whole
		// ecosystem keeps its filter helpers in an `object XFilters`, which made
		// it `parseCheckbox`, `parseTriFilter`, `getFirst` and `asQueryPart`
		// across a quarter of the catalogue.
		const source = kt(
			'object Filters {',
			'    fun getSearchParameters(filters: List<String>): String = filters.pick(1)',
			'',
			'    private fun List<String>.pick(at: Int): String = this[at]',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// Through the object's name, not as a bare module binding: the function
		// lives inside `Object.freeze({ … })` and nothing declares it outside.
		expect(emitted.js).toContain('Filters.pick(filters, 1)');
	});

	it('carries a `reified` type parameter as an argument', () => {
		// Kotlin monomorphises `inline fun <reified R>` at the call site, so
		// `it is R` inside the body means the type written there. Nothing carries
		// that here unless it is passed: the emitted `__k.isType(it, "R")` asked
		// the runtime's type table about a type called "R", answered false for
		// every element, and the helper read an empty filter list with nothing
		// refused anywhere.
		const source = kt(
			'object Filters {',
			'    class GenreFilter(val v: String)',
			'',
			'    fun go(filters: List<Any>): Any = filters.firstOfType<GenreFilter>()',
			'',
			'    private inline fun <reified R> List<Any>.firstOfType(): Any = first { it is R }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// The class itself, so `__isType` can use `instanceof`.
		expect(emitted.js).toContain('Filters.firstOfType(GenreFilter, filters)');
		expect(emitted.js).toContain('__k.isType(it, __type_R)');
	});

	it('refuses a `reified` call the site names no type for', () => {
		// The parameter would arrive undefined, `__isType` would answer false for
		// every value, and the read would come back empty rather than wrong-ish.
		const source = kt(
			'object Filters {',
			'    fun go(filters: List<Any>): Any = filters.firstOfType()',
			'',
			'    private inline fun <reified R> List<Any>.firstOfType(): Any = first { it is R }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals.flatMap((one) => one.obstacles.map((o) => o.kind)).join()).toMatch(
			/no type argument for its `reified` parameter/
		);
	});

	it('extends the filter type imported under its bare name', () => {
		// `import …model.AnimeFilter.TriState` then `class TriFilterVal : TriState(name)`,
		// which nine sources here write. The base was dropped in silence, so the
		// emitted class had no `isIgnored` on it and
		// `state.filterNot { it.isIgnored() }` threw on the first search — out of
		// a bundle that loaded and reported nothing refused.
		const source = kt(
			'object Filters {',
			'    class TriFilterVal(name: String) : TriState(name)',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('class TriFilterVal extends AnimeFilter.TriState');
	});

	it('hands `filterIsInstance` the type that is the whole point of it', () => {
		// The helper answers everything when it has no type — deliberately, so it
		// never empties a list it cannot judge — so a dropped type argument is a
		// wrong value and not an error: the `.first()` after it took whichever
		// filter happened to be first.
		const source = kt(
			'object Filters {',
			'    class OrderFilter(name: String) : AnimeFilter.Select<String>(name, arrayOf())',
			'',
			'    fun pick(filters: List<Any>): Any = filters.filterIsInstance<OrderFilter>().first()',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.filterIsInstance(filters, OrderFilter)');
	});

	it('mutates a `val` collection on `+=`, rather than rebinding it', () => {
		// Kotlin's `plusAssign`. A `val` cannot be rebound at all, so a `+=` onto
		// one is always this operator — which is what makes the two safe to tell
		// apart where no types are known. Emitted as written it was `episodes +=
		// …` against a `const`: a JavaScript syntax error, so the bundle did not
		// load at all and took every other member with it.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(page: List<String>): List<String> {',
			'        val episodes = mutableListOf<String>()',
			'        episodes += page',
			'        return episodes',
			'    }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.plusAssign(episodes, page)');
	});

	it('keeps a `var` rebinding on `+=`, which is what Kotlin does there', () => {
		const source = kt(
			'class Demo : Source() {',
			'    fun go(): String {',
			'        var text = "a"',
			'        text += "b"',
			'        return text',
			'    }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain("text += 'b'");
	});

	it('runs an `object`’s `by lazy` on first read, and only once', () => {
		// `private val GENRES_LIST by lazy { getPairListByIndex(0) }` inside an
		// `object`. The block reads a `lateinit` the first search assigns, so
		// running it where the literal is built runs it before there is anything
		// to read — and the thunk had no receiver at all, which is
		// "Cannot read properties of undefined" at LOAD.
		const source = kt(
			'object Filters {',
			'    fun pairs(at: Int): String = "x"',
			'    private val GENRES_LIST by lazy { pairs(0) }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// A getter, so it runs on read; memoised outside the frozen literal,
		// because `lazy` runs its block once.
		expect(emitted.js).toContain('const __lazy_Filters = {};');
		expect(emitted.js).toMatch(/get "GENRES_LIST"\(\) \{ return __lazy_Filters\.GENRES_LIST \?\?=/);
	});

	it('reaches a sibling of the `object` declared below it', () => {
		// `class OrderFilter : SelectFilter("Ordina per", ORDER_LIST)` with
		// `ORDER_LIST` two hundred lines below, which is how this ecosystem
		// writes a filter file. A Kotlin `object` becomes a frozen literal, so
		// the sibling is `F.ORDER_LIST` and not a module binding — and the
		// nested class is hoisted, so it runs long after the literal is built.
		const source = kt(
			'object Filters {',
			'    open class SelectFilter(name: String, val vals: Array<String>) : AnimeFilter.Select<String>(name, vals)',
			'    internal class OrderFilter : SelectFilter("Ordina", ORDER_LIST)',
			'    private val ORDER_LIST = arrayOf("a")',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('Filters.ORDER_LIST');
	});

	it('registers a `@Serializable` class that renames or computes a field', () => {
		// Only where something would otherwise be lost: a plain DTO whose names
		// already match the JSON needs no registration, and every one that gets
		// one carries either a rename or a property the record cannot have.
		const source = kt(
			'@Serializable',
			'class Item(',
			'    @JsonNames("imgPath")',
			'    val image: String,',
			'    val key: String?,',
			'    val contxt: String,',
			') {',
			'    val vid: String get() = key ?: contxt',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain(
			'__k.shape(Item, ["image","key","contxt"], ["key"], {"imgPath":"image"});'
		);
	});

	it('registers nothing for a DTO whose names already match', () => {
		const source = kt('@Serializable', 'class Plain(val title: String, val url: String)');
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).not.toContain('__k.shape(');
	});

	it('leaves `it` alone in a block Kotlin gives no parameter', () => {
		// `element.selectFirst("img")!!.let { it.attr("a").ifEmpty { it.attr("b") } }`
		// — `ifEmpty` takes a `() -> R`, so the inner `it` is still the one `let`
		// bound. Emitted as `(it) => …` the parameter shadowed the element with
		// the nothing `ifEmpty` passes, and the first browse died with
		// `undefined is not an object (evaluating 'it.attr')`.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(element: Element): String =',
			'        element.selectFirst("img")!!.let {',
			'            it.attr("data-lazy-src").ifEmpty { it.attr("src") }',
			'        }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// The outer block binds `it`; the inner one takes nothing.
		expect(emitted.js).toContain('(it) => {');
		expect(emitted.js).toMatch(/__k\.ifEmpty\(it\.attr\('data-lazy-src'\), \(\) => \{/);
		expect(emitted.js).toContain("return it.attr('src');");
	});

	it('lets one of an `object`’s constants read the one above it', () => {
		// `object Data { val EVERY = Pair(…); val GENRES = arrayOf(EVERY, …) }` is
		// ordinary Kotlin — an object initialises its properties top to bottom —
		// and a frozen literal has no way to say it: `const F = Object.freeze({
		// EVERY: …, GENRES: [F.EVERY] })` reads `F` before it is bound. The whole
		// filter table came out holding only its first entry, so the first search
		// indexed into a `GENRES` that was not there.
		const source = kt(
			'object Data {',
			'    val EVERY = Pair("Select Genre", "")',
			'    val GENRES = arrayOf(EVERY, Pair("Comedy", "comedy"))',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// The shared constant is hoisted, in declaration order, and the literal
		// carries that name — which is what a companion's members already do.
		expect(emitted.js).toMatch(/const __const_Data_EVERY = __k\.to\('Select Genre', ''\);/);
		expect(emitted.js).toContain('__k.listOf(__const_Data_EVERY');
		expect(emitted.js).toContain('"EVERY": __const_Data_EVERY');
	});

	it('leaves a property of the literal reaching a sibling refused', () => {
		// `const F = Object.freeze({ a: 1, b: F.a })` throws before `F` is bound,
		// so a property cannot reach a sibling through the literal's own name the
		// way a method or a hoisted class can. The honest refusal that was
		// already the answer is better than a ReferenceError at load.
		const source = kt(
			'object Filters {',
			'    private val FIRST = SECOND',
			'    private val SECOND = "x"',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals.flatMap((one) => one.obstacles.map((o) => o.kind))).toContain(
			'`SECOND`'
		);
	});

	it('calls a declared extension function on the implicit receiver', () => {
		// `isValidUrl("src")` inside `fun Element.getImageUrl()`. The receiver is
		// the first argument, exactly as where it is written out — emitted as a
		// member of the receiver it was `__recv.isValidUrl is not a function` on
		// the first search, out of a conversion that reported nothing refused.
		const source = kt(
			'class Demo : Source() {',
			'    private fun Element.isValidUrl(name: String): Boolean = hasAttr(name)',
			'',
			'    private fun Element.getImageUrl(): String = when {',
			'        isValidUrl("data-src") -> attr("abs:data-src")',
			'        else -> ""',
			'    }',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain("this.isValidUrl(__recv, 'data-src')");
		expect(emitted.js).not.toContain('__recv.isValidUrl(');
	});

	it('asks whether a `lateinit` was assigned, rather than reading through it', () => {
		// `this::filterList.isInitialized` is the guard in front of every lazily
		// built filter list here. The grammar drops the `::`, so what arrives is
		// a plain read of a property called `isInitialized` — and emitted as
		// written it is a read off `undefined` the first time, which is
		// "Cannot read properties of undefined" on the first search.
		const source = kt(
			'class Demo : Source() {',
			'    private lateinit var filterList: AnimeFilterList',
			'',
			'    fun ready(): Boolean = this::filterList.isInitialized',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.initialized(this.filterList)');
	});

	it('lets a declared extension win a name the runtime also defines', () => {
		// Two sources in this catalogue declare `fun AnimeFilterList.asQueryPart()`
		// while the runtime has an `asQueryPart` that URL-encodes a string. The
		// helper won, so the search went out with an encoded *filter list* where
		// the chosen option belonged — and the declared function was emitted
		// beside it and never called.
		const source = kt(
			'object Filters {',
			'    fun go(filters: List<String>): String = filters.asQueryPart()',
			'',
			'    private fun List<String>.asQueryPart(): String = this[0]',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('Filters.asQueryPart(filters)');
		expect(emitted.js).not.toContain('__k.asQueryPart(');
	});

	it('leaves the standard-library helper alone at a call carrying a block', () => {
		// Six sources declare `private fun Array<String>.any(url: String)` and
		// call the stdlib `this.any { … }` from inside it. Same name; only the
		// block says which is meant — the distinction `editor.apply()` against
		// `x.apply { … }` already turns on.
		const source = kt(
			'class Demo : Source() {',
			'    private fun List<String>.any(url: String): Boolean = this.any { url.contains(it) }',
			'',
			'    fun go(hosts: List<String>, url: String): Boolean = hosts.any(url)',
			'}'
		);
		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		// The block form stays the helper; the one-argument form is the declared.
		expect(emitted.js).toMatch(/__k\.any\(__recv, \(it\)/);
		expect(emitted.js).toMatch(/this\.any\(hosts, url\)/);
	});
});

describe('a name declared somewhere the emitter had not looked', () => {
	it('reads a capitalised property the class declares itself', () => {
		// Kotlin puts a constant in capitals whether it lives in a companion or
		// not. The companion case resolved, because a companion hoists to module
		// scope; a plain property was refused as "a capitalised name this file
		// did not declare" — which is how a vendored decoder lost its table.
		const source = kt(
			'class Unbaser(private val base: Int) {',
			'    private val ALPHABET = mapOf(62 to "0123456789")',
			'    fun alphabet(): String = ALPHABET[base] ?: ""',
			'}',
			'',
			'class Demo : Source() {',
			'    fun build(): String = Unbaser(62).alphabet()',
			'}'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(instantiate(source).build()).toBe('0123456789');
	});

	it("keeps two classes' same-named nested types apart", () => {
		// Kotlin scopes a nested type to the class holding it, so one DTO file
		// declaring `EpisodeListResponse.EpisodeObject` and
		// `PagePropsObject.EpisodeObject` means two different shapes. Both are
		// hoisted into one module scope, and the second `function EpisodeObject`
		// is "Identifier 'EpisodeObject' has already been declared" in an ES
		// module. The measured file declares three such pairs, converted with no
		// refusals, and failed at load.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(): String = Outer().render() + Other().render()',
			'}',
			'',
			'class Outer {',
			'    data class Row(val name: String)',
			'    fun render(): String = Row("outer").name',
			'}',
			'',
			'class Other {',
			'    data class Row(val label: String)',
			'    fun render(): String = Row("other").label',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		// Two declarations, two names.
		expect(emitted.js.match(/function \w*Row\(/g)).toHaveLength(2);
		// And each class still builds its own shape: `Other.Row` has no `name`,
		// so a reference that leaked to the first one would answer undefined.
		expect(instantiate(source).build()).toBe('outerother');
	});

	it('lets `ifEmpty { return@map … }` jump out of the lambda it was written in', () => {
		// `ifEmpty` and `ifBlank` are *inline* in Kotlin, so a `return@mapNotNull`
		// written inside one returns from the enclosing `mapNotNull` lambda. As a
		// callback there is a JavaScript function in between and the jump would
		// return from that instead, so it was refused — correctly, because the
		// alternative was a member that quietly produced a different list.
		//
		// Read as a guard the callback disappears and the jump lands where it
		// was written, which is the same move `x ?: return` already makes.
		const demo = instantiate(
			inClass(
				'    fun keep(rows: List<String>): List<String> = rows.mapNotNull { row ->',
				'        val text = trimmed(row).ifBlank { return@mapNotNull null }',
				'        text',
				'    }',
				'    fun trimmed(row: String): String = row.trim()'
			)
		);

		expect(demo.keep(['a', '   ', 'b'])).toEqual(['a', 'b']);
	});

	it('does not hoist the guard into the wrong callback when it sits one deeper', () => {
		// `runCatching { … ifEmpty { return@mapNotNull null } … }` inside a
		// `mapNotNull`. Kotlin inlines `runCatching` too, so this is legal there.
		// Hoisting is still wrong here — the guard would land in the
		// `runCatching` callback and its `return` would leave *that*, handing
		// `mapNotNull` a value instead of dropping the row, silently — so the
		// guard is not hoisted. It leaves by the throw instead, which crosses
		// the callback and is caught by the frame the label names.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(rows: List<String>): List<String> = rows.mapNotNull { row ->',
			'        runCatching {',
			'            val url = pick(row).ifEmpty { return@mapNotNull null }',
			'            url',
			'        }.getOrNull()',
			'    }',
			'    fun pick(row: String): String = row',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.jump(');
		// And the hoist did not happen: the guard's subject is still read where
		// it was written, inside the `runCatching` block.
		expect(emitted.js).not.toMatch(/const __t\d+ = [^;]*pick\(row\);\n[^;]*mapNotNull/);
	});

	it('gives `ifEmpty { return emptyList() }` its value back', () => {
		// The same grammar split `rejoinJumps` repairs at statement level: a
		// `return` with an empty argument list arrives as a valueless jump and a
		// sibling call, so a block that *is* one jump reaches the guard reader as
		// two statements. Requiring exactly one refused this while converting
		// `ifEmpty { return listOf(x) }` — the same code, one argument apart.
		const demo = instantiate(
			inClass(
				'    fun parts(row: String): List<String> {',
				'        val text = row.ifEmpty { return emptyList() }',
				'        return text.split(",")',
				'    }'
			)
		);

		expect(demo.parts('a,b')).toEqual(['a', 'b']);
		// And the jump keeps the value it was written with, rather than
		// returning `undefined` where a list was meant.
		expect(demo.parts('')).toEqual([]);
	});

	it('reads `x.let { it ?: return … }` as the guard it is', () => {
		// One shared extractor writes this mid-chain and a whole repository
		// inherits it: the block is `let`, so its value feeds the rest of the
		// chain, and inlining it would mean hoisting the chain. As a guard it is
		// `x ?: return …`, which hoists on its own and leaves the chain alone.
		const demo = instantiate(
			inClass(
				'    fun parts(row: String): List<String> {',
				'        return row.takeIf { it.isNotEmpty() }',
				'            .let { it ?: return emptyList() }',
				'            .trim()',
				'            .split(",")',
				'    }'
			)
		);

		expect(demo.parts(' a,b ')).toEqual(['a', 'b']);
		expect(demo.parts('')).toEqual([]);
	});

	it('does not read `?.let { it ?: return … }` as a guard', () => {
		// `x?.let { … }` never runs the block for a null receiver, so the jump is
		// unreachable in exactly the case a guard would fire. Read as one, a null
		// `row` would return "guard" where Kotlin yields null — a different
		// value, silently. The inlining path already gets this right; what this
		// checks is that the guard reader keeps its hands off it.
		const demo = instantiate(
			inClass(
				'    fun pick(row: String?): String {',
				'        val got = row?.let { it ?: return "guard" }',
				'        return "[" + (got ?: "null") + "]"',
				'    }'
			)
		);

		expect(demo.pick('a')).toBe('[a]');
		expect(demo.pick(null)).toBe('[null]');
	});

	it('does not hoist a `let` guard past something that has already run', () => {
		// Hoisting moves the guard's subject ahead of everything written before
		// it. `first()` is written first and must stay first, so this guard
		// cannot move — and it is not moved. It leaves by the throw the member
		// catches instead, which keeps the written order and still returns from
		// the member, which is what the Kotlin says.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(row: String): String = join(first(), row.let { it ?: return "" })',
			'    fun first(): String = "1"',
			'    fun join(a: String, b: String): String = a + b',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		// The subject is evaluated in place, inside the argument, not lifted into
		// a `const` above the call.
		expect(emitted.js).toContain('__k.jump(');
		expect(emitted.js).toMatch(/join\(this\.first\(\)/);
	});

	it('still calls `let` as a function when its block is not a guard', () => {
		// Only a block whose whole body is `it ?: <jump>` is this shape. One that
		// computes something is the ordinary `let`, and reading it as a guard
		// would throw its result away.
		const demo = instantiate(inClass('    fun tag(row: String): String = row.let { it + "!" }'));

		expect(demo.tag('a')).toBe('a!');
	});

	it('still calls `ifEmpty` as a function when its block produces a value', () => {
		// Only a block whose whole body is the jump becomes a guard. One that
		// yields a value is the ordinary `ifEmpty`, and turning that into a
		// guard would drop the fallback.
		const demo = instantiate(inClass('    fun or(row: String): String = row.ifEmpty { "none" }'));

		expect(demo.or('')).toBe('none');
		expect(demo.or('x')).toBe('x');
	});

	it('reads a `by preferences.delegate(…)` property from the settings store', () => {
		// keiyoushi's own property delegate, and how a growing number of these
		// extensions let a viewer move them to a new domain — so it is the
		// `baseUrl` itself in several. It resolves to the same `__k.pref` that
		// `preferences.getString` does, rather than to a second idea of where
		// settings live.
		const source = kt(
			'class Demo : Source() {',
			'    override val baseUrl by preferences.delegate(PREF_DOMAIN, PREF_DOMAIN_DEFAULT)',
			'}',
			'',
			'private const val PREF_DOMAIN = "domain"',
			'private const val PREF_DOMAIN_DEFAULT = "https://example.invalid"'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('__k.pref(__k.prefs(), PREF_DOMAIN, PREF_DOMAIN_DEFAULT)');
	});

	it('resolves a class written out in full, as an import would have named it', () => {
		// `java.net.URLEncoder.encode(…)` and the imported `URLEncoder.encode(…)`
		// are one call written two ways, and Kotlin takes either. Read as a
		// navigation chain the leading `java` is an unresolvable name, so the
		// qualified spelling refused while the imported one converted.
		//
		// `Charsets.UTF_8.name()` on the same line is java.nio spelling a field
		// as a method, which the property branch answers by dropping the
		// parentheses — the same rewrite the jsoup members already get.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(url: String): String =',
			'        java.net.URLEncoder.encode(url, Charsets.UTF_8.name())',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('URLEncoder.encode(url, Charsets.UTF_8.name)');
	});

	it('spells a backticked Kotlin name two ways, because it means two things', () => {
		// Kotlin lets an identifier be written in backticks, and this ecosystem
		// uses it for names JavaScript cannot take: a DTO field whose JSON key
		// carries a hyphen. Emitted as written, `it.\`info-src\`` is not a
		// property access at all — the module failed to parse and the extension
		// died at load naming a template string.
		//
		// As a BINDING it has to become something JavaScript will accept; as a
		// KEY it has to keep the spelling the payload actually uses. The two are
		// different answers to the same name.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(row: Eps): String = row.`info-src`',
			'}',
			'',
			'data class Eps(val `info-src`: String)'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(() => new Function(emitted.js)).not.toThrow();
		// Read with brackets, which is what the name means.
		expect(emitted.js).toContain('row["info-src"]');
		// Decoded from the real key, into a binding JavaScript will take.
		expect(emitted.js).toContain('"info-src": info_src');
	});

	it('reads an extractor signature from its declaration, not from a name', () => {
		// `videosFromUrl` is declared 37 times across this ecosystem over
		// incompatible parameter lists. A table keyed by the bare name had
		// `prefix` first, so `videosFromUrl(url, prefix = "…")` emitted
		// `videosFromUrl('…')`: the url dropped into the slot the table called
		// `prefix`, then overwritten by the named argument. The prefix string
		// was fetched as a url, with no refusal and no error.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(url: String): String = Okru(client).videosFromUrl(url, prefix = "p: ")',
			'}',
			'',
			'class Okru(private val client: OkHttpClient) {',
			'    fun videosFromUrl(url: String, prefix: String = ""): String = url + prefix',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		// Both arguments, in the order the declaration gives them.
		expect(emitted.js).toContain("videosFromUrl(url, 'p: ')");
	});

	it('reads a one-argument `getString` as org.json, never as a preference', () => {
		// `getString`, `getBoolean`, `getInt` and `getLong` map onto the
		// preferences helper, and org.json spells four of its readers the same
		// way. Routed through the preferences helper, `json.getString("url")`
		// would read the *plugin's settings store* under a setting id made from
		// "url" and answer undefined — converting clean, with no refusal
		// anywhere. It was masked while `JSONObject(…)` refused first in the same
		// member, and stopped being masked the moment org.json was supported.
		//
		// Arity separates them: a SharedPreferences read always names a key AND
		// a fallback; an org.json read names only the field.
		const source = kt(
			'class Demo : Source() {',
			'    fun go(json: Any): String = json.getString("url")',
			'}'
		);
		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain("__k.jsonGetString(json, 'url')");
		expect(emitted.js).not.toContain('getPreference');

		// And the genuine preferences read still converts.
		const prefs = kt(
			'class Demo : Source() {',
			'    fun go(): String = preferences.getString("quality", "1080")!!',
			'}'
		);
		expect(translate(prefs).refusals).toEqual([]);
	});

	it('keeps the trailing lambda of a call on an implicit receiver', () => {
		// `fun List<String>.keep() = filter { … }` reaches the emitter with its
		// receiver implicit, and the arguments were built without the block — so
		// the predicate was dropped and `__k.filter(__recv)` went out with
		// nothing to filter by. `filter` and `map` at least throw; `first`,
		// `firstOrNull` and `last` answer element 0, which is a wrong value and
		// says nothing. Written `this.filter { … }` it was always correct.
		const demo = instantiate(
			inClass(
				'    fun List<String>.keep(): List<String> = filter { it.isNotBlank() }',
				'    fun build(): List<String> = listOf("a", "", "b").keep()'
			)
		);

		expect(demo.build()).toEqual(['a', 'b']);
	});

	it('gives `?: return emptyList()` its value back', () => {
		// The vendored grammar splits `return emptyList()` into a valueless jump
		// and a sibling call. `rejoinJumps` puts that back together at statement
		// level, but in elvis position the jump is the fallback of an expression
		// and not a child of the block — so the join was missed and the guard
		// emitted `return;` with the orphaned `__k.emptyList();` after it.
		// `undefined` where a list was meant: installs, searches, shows nothing.
		const demo = instantiate(
			inClass(
				'    fun pick(value: String?): List<String> {',
				'        val found = value ?: return emptyList()',
				'        return listOf(found)',
				'    }'
			)
		);

		expect(demo.pick('x')).toEqual(['x']);
		expect(demo.pick(null)).toEqual([]);
	});

	it('binds a prefix operator to its operand, not to the whole expression', () => {
		// The vendored grammar parses `!a && b` as `prefix(conjunction(a, b))`:
		// the operand of `!` is the WHOLE binary expression. Emitted faithfully
		// that is `!(a && b)`, and Kotlin means `(!a) && b`. Prefix binds tighter
		// than every binary operator in Kotlin, so the operator belongs to the
		// leftmost operand.
		//
		// Silent, and measured across the catalogue: one extension's search read
		// `if (!filter.isDefault() && query.isBlank())`, got the negation of the
		// whole condition, and dropped the query from every search that had one.
		const demo = instantiate(
			inClass(
				'    fun andNot(a: Boolean, b: Boolean): Boolean = !a && b',
				'    fun orNot(a: Boolean, b: Boolean): Boolean = !a || b',
				'    fun chain(a: Boolean, b: Boolean, c: Boolean): Boolean = !a && !b && !c',
				'    fun minus(x: Int, y: Int): Int = -x + y'
			)
		);

		// `!false && true` is true; `!(false && true)` is also true — so the
		// telling case is the one where the two answers differ.
		expect(demo.andNot(true, true)).toBe(false);
		expect(demo.orNot(true, false)).toBe(false);
		expect(demo.chain(true, false, false)).toBe(false);
		expect(demo.minus(2, 5)).toBe(3);
	});

	it('takes the right branch of `in` entries the parser used to guess at', () => {
		// tree-sitter is error-TOLERANT: it recovers, and a recovery does not
		// always leave an ERROR node behind. This `when` was the case that proved
		// it — the vendored grammar continued the first entry's body across the
		// newline as an infix `in`, reported `hasError` on the `when_expression`
		// with every node under it ordinarily typed, and a scan for the ERROR
		// *type* saw nothing. The member translated against the guess and
		// emitted JavaScript that took the wrong branch while the conversion
		// reported complete. `scanInto` now refuses any unrepaired `hasError`.
		//
		// `grammar.ts` (`whenInConditions`) since repairs this shape before the
		// tree is read, so what is asserted here is the other half of the same
		// promise: that the repaired member does not merely convert, it answers
		// the way Kotlin does for every entry, including the ones the guess had
		// swallowed.
		const demo = instantiate(
			inClass(
				'    fun band(n: Int): Int = when (n) {',
				'        in 1..5 -> 1',
				'        in 10..20 -> 2',
				'        else -> 0',
				'    }'
			)
		);

		// Integer ranges, because this file's stub runtime builds numeric ranges
		// only; the character ranges `rot13` uses are the real runtime's
		// (`__charRange`), and the emitted shape is the same.
		expect(demo.band(3)).toBe(1);
		expect(demo.band(12)).toBe(2);
		expect(demo.band(7)).toBe(0);
	});

	it('awaits a plain `fun` that blocks on a request', () => {
		// Kotlin lets an ordinary `fun` block on a request, and JavaScript has no
		// blocking — so the emitter writes that member `async` and a caller that
		// does not await it holds a Promise. Only members carrying the `suspend`
		// modifier were awaited, so a helper like this one was called bare and
		// the next line read a field off a Promise. The failure surfaced one
		// member away from the thing that suspended, which is what hid it.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(): String = title(page())',
			'    private fun page(): String =',
			'        client.newCall(GET("https://example.invalid/")).execute().body',
			'    private fun title(html: String): String = html',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('await this.page(');
		// And the member that merely calls it is awaited too, transitively.
		expect(emitted.js).toContain('async build(');
	});

	it('awaits the crypto operations, which are synchronous in Kotlin only', () => {
		// `crypto.subtle` is promise-returning and `javax.crypto` is not, so the
		// four operations that touch a key are `async` in the runtime shim and
		// nothing at the call site says so. Un-awaited, `String(cipher.doFinal(…))`
		// is `[object Promise]` — a plausible string that travels a long way
		// before anything notices it is not the plaintext.
		const source = kt(
			'class Demo : Source() {',
			'    fun label(data: ByteArray): String = String(open(data))',
			'    private fun open(data: ByteArray): ByteArray {',
			'        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")',
			'        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key(), "AES"), IvParameterSpec(iv()))',
			'        return cipher.doFinal(data)',
			'    }',
			'    private fun key(): ByteArray = ByteArray(16)',
			'    private fun iv(): ByteArray = ByteArray(16)',
			'}'
		);

		const emitted = translate(source);

		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('await cipher.doFinal(');
		// And outward: the member holding the `await` is `async`, and the member
		// that merely calls it awaits in turn. That second hop is the one that
		// hides the failure when it is missing.
		expect(emitted.js).toContain('async open(');
		expect(emitted.js).toContain('await this.open(');
		expect(emitted.js).toContain('async label(');
		// `init` and the two specs stay synchronous, which is what keeps the
		// asynchronous surface to the operations themselves.
		expect(emitted.js).toContain('cipher.init(');
		expect(emitted.js).not.toContain('await cipher.init(');
	});

	it('awaits `.execute()`, which Kotlin blocks on', () => {
		// Only `awaitSuccess()` was routed through a helper the emitter knows to
		// await. `execute()` was a plain passthrough, so an extension written the
		// blocking way read a Promise as if it were a Response — no error, an
		// empty parse, and the request landing after the caller had given up.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(): String = client.newCall(GET("https://example.invalid/")).execute().body',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(emitted.js).toContain('await __k.executeCall(');
	});

	it('gives every ignored lambda parameter a name of its own', () => {
		// Kotlin lets a lambda ignore more than one parameter, and this ecosystem
		// does it constantly: `extractFromHls(url, referer) { _, _ -> … }`.
		// Emitted as written that is `(_, _) =>`, which JavaScript rejects
		// outright — a SyntaxError before a line of the module runs. It converted
		// with no refusals and failed at load.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(): String = pick { _, _ -> "ok" }',
			'    fun pick(f: (String, String) -> String): String = f("a", "b")',
			'}'
		);

		const emitted = translate(source);
		expect(emitted.refusals).toEqual([]);
		expect(() => new Function(emitted.js)).not.toThrow();
		expect(instantiate(source).build()).toBe('ok');
	});

	it('reads a `data class` companion constant from above the companion', () => {
		// A `data class` is emitted as a factory function rather than an ES6
		// class, and that path walked the body in source order with no pre-pass
		// — so a member reading `ALPHABET` above the companion that declares it
		// was refused as "a capitalised name this file did not declare". The
		// plain-class path had pre-registered companions all along; this one
		// never did, and nothing crossed between them.
		//
		// Not a corner. The vendored `internal data class Unbaser` is exactly
		// this shape, and `ALPHABET` came back as the single most common
		// blocker in a 254-listing catalogue run.
		const source = kt(
			'data class Unbaser(private val base: Int) {',
			'    private val dict by lazy {',
			'        ALPHABET[base]?.let { str -> str.indices.associateBy { str[it] } }',
			'    }',
			'    fun digit(c: Char): Int = dict?.get(c) ?: -1',
			'',
			'    companion object {',
			'        private val ALPHABET = mapOf(62 to "0ab")',
			'    }',
			'}',
			'',
			'class Demo : Source() {',
			"    fun build(): Int = Unbaser(62).digit('b')",
			'}'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(instantiate(source).build()).toBe(2);
	});

	it('reads a file-scope constant declared below the class that uses it', () => {
		// The same ordering problem the companion pre-registration already
		// solved, one scope out: a Kotlin file puts its constants at the bottom.
		const source = kt(
			'class Demo : Source() {',
			'    fun build(): String = DEFAULT_REFERER',
			'}',
			'',
			'private const val DEFAULT_REFERER = "https://example.invalid/"'
		);

		expect(translate(source).refusals).toEqual([]);
		expect(instantiate(source).build()).toBe('https://example.invalid/');
	});
});

describe('the receiver a member is actually called on', () => {
	it('calls a member extension from inside `apply {}` on the source', () => {
		// `SAnime.create().apply { … }` is emitted as a real `function`, so its
		// `this` is the *record*. A member extension emitted as `this.fixLink(…)`
		// therefore looked for the extension on the SAnime, and the converted
		// extension installed, searched, and died with
		// `this.fixLink is not a function`.
		const source = inClass(
			'    fun build(): SAnime = SAnime.create().apply {',
			'        title = "x".fixLink()',
			'    }',
			'    private fun String.fixLink(): String = "[" + this + "]"'
		);

		expect(translate(source).js).toContain('__self.fixLink(');
		expect(instantiate(source, {}, { SAnime: { create: () => ({ title: '' }) } }).build()).toEqual({
			title: '[x]'
		});
	});

	it('makes `this` inside a member extension mean its receiver', () => {
		// Kotlin's `this` in `fun String.fixLink()` is the String. Left meaning
		// the source object, `"https:$this"` interpolated the extension class
		// and the bare `this` returned it — both wrong values, neither an error.
		const demo = instantiate(
			inClass(
				'    fun build(text: String): String = text.fixLink()',
				'    private fun String.fixLink(): String = if (startsWith("//")) "https:$this" else this'
			)
		);

		expect(demo.build('//host.example.invalid/a')).toBe('https://host.example.invalid/a');
		expect(demo.build('/a')).toBe('/a');
	});
});

/* ── the declarative request policy ───────────────────────────────── */

/**
 * The rate limit an extension declared, as the runtime will receive it.
 *
 * The period is the interesting number and it is resolved **here**, in the
 * emitter, because this is the last place that can be: `300.milliseconds` is
 * erased to the bare `300` before any helper sees it, so `rateLimit(1, 2)` and
 * `rateLimit(1, 2.seconds)` would otherwise reach `__k` as identical arguments
 * meaning 2000ms and 2ms. Every row below is a spelling a shared library in
 * this ecosystem actually offers.
 */
describe('declarative rate limits, translated onto the request policy', () => {
	const rateLimited = (...lines: string[]) => {
		declared.length = 0;
		const demo = instantiate(inClass(...lines), {
			network: { client: { newBuilder: () => ({ build: () => ({}) }) } }
		});
		// A `val` is emitted as a lazy getter, so reading it is what runs the
		// initialiser the declaration is written in.
		void demo.client;
		return declared;
	};

	it.each([
		['the bare form, whose period is one second', 'rateLimit(3)', { permits: 3, periodMs: 1000 }],
		['a period in the default unit', 'rateLimit(1, 2)', { permits: 1, periodMs: 2000 }],
		['a Long period', 'rateLimit(1, 2L)', { permits: 1, periodMs: 2000 }],
		[
			'an explicit TimeUnit',
			'rateLimit(1, 500, TimeUnit.MILLISECONDS)',
			{ permits: 1, periodMs: 500 }
		],
		[
			'a TimeUnit in minutes',
			'rateLimit(4, 1, TimeUnit.MINUTES)',
			{ permits: 4, periodMs: 60_000 }
		],
		['a kotlin.time Duration', 'rateLimit(1, 2.seconds)', { permits: 1, periodMs: 2000 }],
		['a sub-second Duration', 'rateLimit(1, 250.milliseconds)', { permits: 1, periodMs: 250 }],
		[
			'the interceptor object the same library ships',
			'addInterceptor(RateLimitInterceptor(2, 3, TimeUnit.SECONDS))',
			{ permits: 2, periodMs: 3000 }
		]
	])('translates %s', (_label, call, expected) => {
		const source = `    override val client = network.client.newBuilder().${call}.build()`;
		expect(rateLimited(source)).toEqual([{ host: null, ...expected }]);
	});

	it('carries the host through for a per-host limit', () => {
		expect(
			rateLimited(
				'    override val client = network.client.newBuilder()',
				'        .rateLimitHost("https://api.example.invalid".toHttpUrl(), 2, 5, TimeUnit.SECONDS)',
				'        .build()'
			)
		).toEqual([{ host: 'https://api.example.invalid', permits: 2, periodMs: 5000 }]);
	});

	it("takes a host limit from the shared library's interceptor object too", () => {
		expect(
			rateLimited(
				'    override val client = network.client.newBuilder()',
				'        .addInterceptor(SpecificHostRateLimitInterceptor("https://api.example.invalid".toHttpUrl(), 1))',
				'        .build()'
			)
		).toEqual([{ host: 'https://api.example.invalid', permits: 1, periodMs: 1000 }]);
	});

	it('declares both when an extension paces itself twice', () => {
		expect(
			rateLimited(
				'    override val client = network.client.newBuilder()',
				'        .rateLimit(5)',
				'        .rateLimitHost("https://api.example.invalid".toHttpUrl(), 1)',
				'        .build()'
			)
		).toEqual([
			{ host: null, permits: 5, periodMs: 1000 },
			{ host: 'https://api.example.invalid', permits: 1, periodMs: 1000 }
		]);
	});

	it('resolves the period of a bare rateLimit inside configureClient()', () => {
		// `KeiSource` hands the builder to this hook as its receiver, so the
		// call has no receiver written. It went down the generic helper path,
		// which passes arguments through, and the runtime was handed no period.
		declared.length = 0;
		const demo = instantiate(
			inClass('    override fun OkHttpClient.Builder.configureClient() = rateLimit(3, 2.seconds)')
		);
		const builder = {};
		expect(demo.configureClient(builder)).toBe(builder);
		expect(declared).toEqual([{ host: null, permits: 3, periodMs: 2000 }]);
	});

	it('applies a rate limit scoped by a predicate to every request', () => {
		// keiyoushi's `rateLimit(permits, period) { url -> … }`. The host cannot
		// run the predicate, and the limit applied to everything is stricter
		// than asked rather than looser — so the rule is declared whole.
		expect(
			rateLimited(
				'    override val client = network.client.newBuilder()',
				'        .rateLimit(1, 2.seconds) { !it.encodedPath.startsWith("/uploads/") }',
				'        .build()'
			)
		).toEqual([{ host: null, permits: 1, periodMs: 2000 }]);
	});

	it('refuses a keiyoushi interval where the old TimeUnit sat', () => {
		// The third positional argument is `interval: Duration` there and
		// `unit: TimeUnit` in the older library. Neither reading may be guessed.
		expect(
			refusalNames(
				inClass(
					'    override val client = network.client.newBuilder().rateLimit(10, 1.seconds, 100.milliseconds).build()'
				)
			).some((name) => name.includes('rateLimit'))
		).toBe(true);
	});

	it('leaves a rateLimit the extension declared itself alone', () => {
		// A name this ecosystem reuses. An extension declaring its own
		// `fun String.rateLimit()` means that one, and translating it as the okhttp
		// helper would hand a request policy a string.
		const demo = instantiate(
			inClass(
				'    fun paced(text: String): String = text.rateLimit()',
				'    private fun String.rateLimit(): String = "[" + this + "]"'
			)
		);
		expect(demo.paced('x')).toBe('[x]');
	});
});

/* ── refusals ─────────────────────────────────────────────────────────────── */

describe('refusing by name', () => {
	it.each([
		[
			// Not the anonymous object itself — that translates now — but the one
			// shape of it this build will not express: an `object :` over a base
			// it *constructs* is the base plus an override, and a literal
			// carrying only the override is missing everything the base supplied.
			'an anonymous object over a constructed base',
			inClass(
				'    val sorter = object : Filter.Sort("Sort", arrayOf("A"), null) {',
				'        override fun on() = 1',
				'    }'
			),
			'an anonymous `object : Filter.Sort(…)` over a constructed base'
		],
		['a dependency container', inClass('    val app = Injekt.get<Application>()'), 'Injekt.get'],
		['a WebView', inClass('    fun solve() = WebView(context).loadUrl(baseUrl)'), 'WebView'],
		[
			// The interceptor hook that has nothing here to hook into. An
			// *application* interceptor wraps one call and runs; a network one
			// sits between the client and each redirect hop, and the host follows
			// redirects itself.
			'an okhttp network interceptor',
			inClass(
				'    val tapped = client.newBuilder()',
				'        .addNetworkInterceptor { chain -> chain.proceed(chain.request()) }',
				'        .build()'
			),
			'an okhttp network interceptor'
		],
		[
			'a key derivation',
			inClass('    fun key() = KeyGenerator.getInstance("AES").generateKey()'),
			'javax.crypto'
		],
		[
			'an embedded engine',
			inClass('    fun unpack(s: String) = QuickJs.create().evaluate(s)'),
			'an embedded JavaScript engine'
		],
		['a coroutine launch', inClass('    fun go() = launch { load() }'), 'launch {}'],
		[
			'a rate limit whose period is not a literal',
			inClass('    val paced = client.newBuilder().rateLimit(1, everySeconds).build()'),
			'`.rateLimit()` with a period that is not a literal'
		],
		[
			'a rate limit shorter than the host can wait out',
			inClass('    val paced = client.newBuilder().rateLimit(1, 5, TimeUnit.NANOSECONDS).build()'),
			'`.rateLimit()` over a period shorter than a millisecond'
		]
	])('refuses %s and names it', (_label, source, expected) => {
		expect(refusalNames(source)).toContain(expected);
	});

	it('lets `Thread.sleep` through as the wait it is, and nothing else about `Thread`', () => {
		// The emitter has long written `Thread.sleep(n)` as the runtime's awaited
		// `delay`; the scanner refused it anyway, at the leaf `Thread`, as a
		// background thread.
		expect(refusalNames(inClass('    fun pause() { Thread.sleep(1000L) }'))).toEqual([]);
		expect(translate(inClass('    fun pause() { Thread.sleep(1000L) }')).js).toMatch(
			/async pause[\s\S]*await __k\.delay\(1000\)/
		);
		expect(refusalNames(inClass('    fun t() = Thread.currentThread()'))).toContain(
			'a background thread'
		);
		expect(refusalNames(inClass('    fun p() { Thread.sleep(WebView(context).x) }'))).toContain(
			'WebView'
		);
	});

	it('does not refuse a string for the words in it', () => {
		// The message a reader sees when a site wants a login is the commonest
		// way a manga extension *mentions* WebView, and matching the prose put
		// dozens of listings in the native column for a sentence.
		const demo = instantiate(
			inClass(
				'    fun locked(): String = throw Exception("Log in via WebView to read this chapter")',
				'    val note = """Open in WebView, then Thread back"""'
			)
		);
		expect(demo.note).toBe('Open in WebView, then Thread back');
		expect(() => demo.locked()).toThrow('Log in via WebView');

		// Code interpolated into a string is still code, and is still scanned.
		expect(refusalNames(inClass('    fun f() = "a ${WebView(context).url} b"'))).toContain(
			'WebView'
		);
		// A string is the only place a JCE transformation's mode is written, so
		// the algorithm question is still asked of one — here in a constant.
		expect(
			refusalNames(
				inClass(
					'    private val mode = "AES/ECB/PKCS5Padding"',
					'    fun c() = Cipher.getInstance(mode)'
				)
			)
		).not.toEqual([]);
	});

	it('translates a hand-written interceptor lambda, binding `it` to the chain', () => {
		// This was refused by name until the runtime grew a chain to run it in.
		// The regression it guards is narrower than that: `addInterceptor`'s
		// block takes the chain as a *parameter*, so `it` is bound to it — and
		// emitted as a receiver block instead, the same source refuses for "an
		// `it` with no lambda around it", naming a construct nobody wrote.
		const emission = translate(
			inClass(
				'    val tapped = client.newBuilder().addInterceptor { it.proceed(it.request()) }.build()'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain('addInterceptor');
		expect(emission.js).toContain('proceed');
	});

	it('translates an interceptor object the extension declares itself', () => {
		const emission = translate(
			inClass(
				'    val tapped = client.newBuilder().addInterceptor(SigningInterceptor(key)).build()'
			)
		);

		// `SigningInterceptor` is still refused — it is a type this file never
		// declared — but for being an unknown constructor, which is a sentence
		// about the extension, rather than for the word `Interceptor`.
		expect(
			refusalNames(inClass('    val t = client.newBuilder().addInterceptor(S(k)).build()'))
		).not.toContain('an okhttp Interceptor');
		expect(emission.refusals.length).toBeGreaterThan(0);
	});

	it('honours a written `super.` call, which is not the same as falling back', () => {
		// Rule 3 forbids falling back to the base when *we* failed to read a
		// member, because we cannot know whether the override was adding to the
		// base behaviour or replacing it. An explicit `super.` is the extension
		// saying in its own source that the base belongs at that point.
		const emission = translate(
			inClass(
				'    override fun episodeListParse(response: Response) = super.episodeListParse(response)'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain('__super.episodeListParse(response)');
	});

	it('gives `super.sortVideos()` the list it was written against', () => {
		// Upstream declares the ordering members as extension functions on the
		// list, so the receiver is implicit in Kotlin: `super.sortVideos()` is
		// written with no arguments and means "the base ordering, of *this*
		// list". This emitter moves a receiver into first position, so the
		// implicit one has to be made explicit here too — emitting
		// `__super.sortVideos()` would order `undefined`.
		const emission = translate(
			inClass('    override fun List<Video>.sortVideos(): List<Video> = super.sortVideos()')
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain('__super.sortVideos(__recv)');
	});

	it('awaits a `super.` call that fetches', () => {
		// `suspend` is invisible at a Kotlin call site and a promise is not. A
		// promise that is filtered rather than awaited does not throw — it walks
		// nothing and answers an empty list, which is a source that silently
		// plays nothing rather than one that reports a failure.
		const emission = translate(
			inClass(
				'    override suspend fun getHosterList(episode: SEpisode): List<Hoster> {',
				'        return super.getHosterList(episode).filter { it.hosterName != "x" }',
				'    }'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain('(await __super.getHosterList(episode))');
	});

	it('builds an ext-lib 16 `Video` from its own parameter names', () => {
		// `videoTitle` is the ext-lib 16 primary constructor's second parameter
		// and appears nowhere in the ext-lib 14 secondary, so naming it settles
		// which of the two is being called. Before this, the name was simply
		// absent from `KNOWN_SIGNATURES['Video']` and the call was refused —
		// measured at 18 calls across 10 extensions in the current catalogue.
		const emission = translate(
			inClass(
				'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
				'        return listOf(Video(videoUrl = "https://example.invalid/a.m3u8", videoTitle = "1080p"))',
				'    }'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain(
			"Video({ videoUrl: 'https://example.invalid/a.m3u8', videoTitle: '1080p' })"
		);
	});

	it('carries the ext-lib 16 fields that have no ext-lib 14 counterpart', () => {
		const emission = translate(
			inClass(
				'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
				'        return listOf(Video(videoUrl = "https://example.invalid/a.m3u8", videoTitle = "x", resolution = 1080, preferred = true, internalData = "k"))',
				'    }'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain('resolution: 1080');
		expect(emission.js).toContain('preferred: true');
		expect(emission.js).toContain("internalData: 'k'");
	});

	it('leaves the ext-lib 14 `Video` positional, which is most of the catalogue', () => {
		// 137 calls in the current catalogue pass three positional arguments and
		// 73 pass four. None of that may move.
		const emission = translate(
			inClass(
				'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
				'        return listOf(Video(page, "default", page))',
				'    }'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain("Video(this.page, 'default', this.page)");
		expect(emission.js).not.toContain('videoTitle:');
	});

	it('still slots an ext-lib 14 named argument positionally', () => {
		const emission = translate(
			inClass(
				'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
				'        return listOf(Video(url = "https://example.invalid/p", quality = "720p", videoUrl = "https://example.invalid/a.mp4"))',
				'    }'
			)
		);

		expect(emission.refusals).toEqual([]);
		expect(emission.js).toContain(
			"Video('https://example.invalid/p', '720p', 'https://example.invalid/a.mp4')"
		);
	});

	it('refuses a `Video` that is not cleanly either constructor', () => {
		// The two share `videoUrl`, `headers`, `subtitleTracks` and
		// `audioTracks` at different indices. A call that mixes a positional
		// argument with an ext-lib 16 name, or names `quality` beside one, has
		// no reading this can be sure of — and the wrong reading publishes a
		// page url as the stream, which converts and loads and plays nothing.
		expect(
			refusalNames(
				inClass(
					'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
					'        return listOf(Video("https://example.invalid/p", videoTitle = "1080p"))',
					'    }'
				)
			).join(' ')
		).toContain('mixing positional and ext-lib 16 named arguments');

		expect(
			refusalNames(
				inClass(
					'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
					'        return listOf(Video(quality = "1080p", videoTitle = "1080p"))',
					'    }'
				)
			).join(' ')
		).toContain('ext-lib 16 parameter');
	});

	it('refuses a `super.` to something the base class does not offer', () => {
		expect(refusalNames(inClass('    override fun setup() = super.setup()'))).toContain(
			'`super.setup()`'
		);
	});

	it('refuses `super.` used as a property, since the base holds no state', () => {
		expect(refusalNames(inClass('    fun tag() = super.baseUrl'))).toContain(
			'`super.` used as a property'
		);
	});

	it('refuses reflection spelled `::class`', () => {
		expect(refusalNames(inClass('    fun name() = Demo::class.java.simpleName'))).toContain(
			'`::class` reflection'
		);
	});

	it('returns from the MEMBER on a non-local return, not from the lambda', () => {
		// Kotlin's bare `return` inside an inline lambda returns from the
		// enclosing function; JavaScript's returns from the lambda, and the
		// method then produces a different value with nothing reporting it.
		// `mapNotNull` is a real callback the runtime calls, so the jump has to
		// cross it — which it does by throwing a marker the member catches.
		//
		// Asserted by running it: `find` must answer the empty list, not a list
		// with the non-empty words in it.
		const demo = instantiate(
			inClass(
				'    fun find(words: List<String>): List<String> {',
				'        return words.mapNotNull {',
				'            if (it.isEmpty()) return emptyList()',
				'            it',
				'        }',
				'    }'
			)
		);

		expect(demo.find(['a', 'b'])).toEqual(['a', 'b']);
		expect(demo.find(['a', '', 'b'])).toEqual([]);
	});

	it('returns from the member when the jump is one lambda deeper still', () => {
		// The `let` inlines; the `map` inside it does not, and a bare `return`
		// there is still a return from `find`. Two callbacks deep is the same
		// throw, caught in the same place.
		const demo = instantiate(
			inClass(
				'    fun find(words: List<String>): List<String> {',
				'        words.let { all ->',
				'            return all.map {',
				'                if (it.isEmpty()) return emptyList()',
				'                it',
				'            }',
				'        }',
				'    }'
			)
		);

		expect(demo.find(['a', 'b'])).toEqual(['a', 'b']);
		expect(demo.find(['a', '', 'b'])).toEqual([]);
	});

	it('returns from the member out of a bare `runCatching`, whose value is a Result', () => {
		// `runCatching { … }.getOrElse { … }` is a try/catch and inlines. A bare
		// `runCatching` has to *produce* a `Result`, so the return has nowhere in
		// that object to go and leaves by the throw instead.
		//
		// The marker must not be caught by `runCatching` itself: a `Result` that
		// swallowed it would answer 0 where Kotlin answers -1. That is what the
		// second assertion is.
		const demo = instantiate(
			inClass(
				'    fun parse(text: String): Int {',
				'        val result = runCatching {',
				'            if (text.isEmpty()) return -1',
				'            text.toInt()',
				'        }',
				'        return result.getOrDefault(0)',
				'    }'
			)
		);

		expect(demo.parse('12')).toBe(12);
		expect(demo.parse('')).toBe(-1);
		expect(demo.parse('not a number')).toBe(0);
	});

	it('refuses a `vararg` that is not the last parameter', () => {
		// Kotlin allows it and names the rest at the call site; a JavaScript rest
		// parameter has to be last, and one that is not swallows every argument
		// the later parameters were meant to receive.
		expect(
			refusalNames(
				inClass(
					'    fun joinAll(vararg parts: String, sep: String = "-") = parts.joinToString(sep)'
				)
			)
		).toContain('a `vararg` followed by another parameter');
	});

	it('never names a construct by its grammar kind', () => {
		// A work queue ranked by `null` and `elvis_expression` tells a reader
		// nothing they can act on and the next person working on this translator
		// nothing about what to build. Where there is no spoken name, the source
		// text is quoted, which is always findable.
		const named = refusalNames(inClass('    fun odd(x: String) = (x)(1)'));

		expect(named).not.toHaveLength(0);
		for (const name of named) {
			expect(name).not.toMatch(/^[a-z_]+$/);
		}
	});

	it('refuses a method the runtime has never heard of, by its own name', () => {
		expect(refusalNames(inClass('    fun odd(s: String) = s.toSnakeCase()'))).toContain(
			'`.toSnakeCase()`'
		);
	});

	it('refuses constructing a class this build did not translate', () => {
		expect(
			refusalNames(
				inClass('    fun links(url: String) = AlphaExtractor(client).videosFromUrl(url)')
			)
		).toContain('`AlphaExtractor(…)`');
	});

	it('refuses a named argument to a callee whose signature is unknown', () => {
		expect(refusalNames(inClass('    fun call() = helper(size = 3)'))).toContain(
			'a named argument to `helper`'
		);
	});

	it('refuses a `Json { }` block that changes something this build does not model', () => {
		expect(
			refusalNames(inClass('    private val json = Json { serializersModule = custom }'))
		).toContain('`Json { serializersModule }`');
	});

	it('accepts a `Json { }` block that only asks for leniency', () => {
		const emission = translate(inClass('    private val json = Json { ignoreUnknownKeys = true }'));

		expect(emission.refusals).toEqual([]);
		expect(emission.translated).toContain('json');
	});

	it('refuses only the member the obstacle is in', () => {
		const emission = translate(
			inClass(
				'    override val baseUrl = "https://example.invalid"',
				'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/p/$page", headers)',
				'    override fun setup() = super.setup()'
			)
		);

		expect(emission.translated).toEqual(['baseUrl', 'popularAnimeRequest']);
		expect(emission.refusals.map((one) => one.member)).toEqual(['setup']);
	});

	it('lists every obstacle in a refused member, not just the first', () => {
		const emission = translate(
			inClass(
				'    override fun videoListParse(response: Response): List<Video> {',
				'        val a = Injekt.get<Loader>()',
				'        val b = WebView(context)',
				'        return emptyList()',
				'    }'
			)
		);

		expect(emission.refusals).toHaveLength(1);
		expect(emission.refusals[0].obstacles.map((one) => one.kind)).toEqual([
			'Injekt.get',
			'WebView'
		]);
	});

	it('does not claim a runtime helper a refused member would have used', () => {
		const emission = translate(inClass('    fun odd(s: String) = s.trim().toSnakeCase()'));

		expect(emission.usedRuntime).toEqual([]);
	});

	it('refuses the whole file when the class header did not parse', () => {
		// tree-sitter recovers from this rather than failing, and the recovered
		// header looks structurally fine — which is exactly why a member read
		// against it cannot be trusted.
		const emission = translate(
			kt('class Demo : Source<<< {', '    override val name = "Demo"', '}')
		);

		expect(emission.fileRefusal).not.toBeNull();
		expect(emission.js).toBe('');
	});

	it('refuses the file when a whole declaration failed to parse', () => {
		const emission = translate(kt('class Demo : Source( {', '    val x = 1', '}'));

		expect(emission.fileRefusal).not.toBeNull();
		expect(emission.js).toBe('');
	});
});

describe('what the emission reports', () => {
	it('names the class and the base class it was written against', () => {
		const emission = translate(
			kt('class Demo : ParsedAnimeHttpSource(), ConfigurableSource {', '    val x = 1', '}')
		);

		expect(emission.className).toBe('Demo');
		expect(emission.superClass).toBe('ParsedAnimeHttpSource');
	});

	it('reports the helpers the emitted code actually calls', () => {
		const emission = translate(inClass('    fun tail(s: String) = s.substringAfter("/")'));

		expect(emission.usedRuntime).toEqual(['substringAfter']);
	});
});

describe('assigning to a property of something', () => {
	// The grammar does not nest a qualified assignment target: `anime.title` is
	// an identifier and a `navigation_suffix` as *siblings* of one
	// `directly_assignable_expression`. Reading only the first child emitted
	// `anime = …`, assigning over the object instead of into it.
	//
	// This is the second-commonest idiom in the ecosystem after `apply {}`, and
	// it is dangerous rather than merely wrong: here the receiver was a `val`,
	// so it threw. Against a `var` it silently replaces the record with a
	// string, and the failure shows up as a show with no title.

	it('keeps the property being assigned to', () => {
		const demo = instantiate(
			inClass(
				'    fun build(): SAnime {',
				'        val anime = SAnime.create()',
				'        anime.title = "One"',
				'        anime.description = "Two"',
				'        return anime',
				'    }'
			),
			{ SAnime: { create: () => ({ title: '', description: '' }) } }
		);

		expect(demo.build()).toEqual({ title: 'One', description: 'Two' });
	});

	it('keeps every step of a longer path', () => {
		const demo = instantiate(
			inClass(
				'    fun build(): SAnime {',
				'        val holder = make()',
				'        holder.inner.value = "deep"',
				'        return holder',
				'    }'
			),
			{ make: () => ({ inner: { value: '' } }) }
		);

		expect(demo.build()).toEqual({ inner: { value: 'deep' } });
	});

	it('still sends a bare write inside apply to the receiver', () => {
		const demo = instantiate(
			inClass(
				'    fun build(): SAnime = SAnime.create().apply {',
				'        title = "One"',
				'    }'
			),
			{ SAnime: { create: () => ({ title: '' }) } }
		);

		expect(demo.build()).toEqual({ title: 'One' });
	});

	it('writes an index through the runtime rather than as JavaScript indexing', () => {
		// `map["k"] = v` needs the runtime's map semantics, not JavaScript's: a
		// Kotlin Map is a real `Map` here, and `bag["c"] = "d"` emitted as
		// itself hangs a property off the map object that no read finds again.
		const source = inClass(
			'    fun build(): String {',
			'        val bag = mutableMapOf("a" to "b")',
			'        bag["c"] = "d"',
			'        return bag["c"]!!',
			'    }'
		);

		expect(translate(source).js).toContain('__k.setIndex(');
		expect(translate(source).js).toContain('__k.index(');
		expect(instantiate(source).build()).toBe('d');
	});

	it('refuses a compound assignment to an index rather than evaluating it twice', () => {
		expect(
			refusalNames(
				inClass(
					'    fun build() {',
					'        val bag = mutableMapOf("a" to 1)',
					'        bag["a"] += 1',
					'    }'
				)
			)
		).toEqual(['an indexed `+=`']);
	});
});

/* ── the constructs the manga half of this ecosystem is written in ────────── */

describe('a `when` whose branch swallowed the entry after it', () => {
	// A defect in the vendored grammar, not in the Kotlin. `-> if (…) { … }`
	// followed by another entry parses the `else` as the `if`'s, which leaves
	// the entry's arrow as an ERROR node — and an ERROR anywhere under a member
	// refuses that member outright. Measured, it refused `Madara.addFilters`
	// and with it the largest template in this catalogue.

	it('runs the branch the source wrote, not the one the tree says', () => {
		const demo = instantiate(
			inClass(
				'    fun name(value: Any): String {',
				'        when (value) {',
				'            is String -> if (value.isNotBlank()) {',
				'                return "text"',
				'            }',
				'            else -> return "other"',
				'        }',
				'        return "fell through"',
				'    }',
				'}'.slice(0, 0) + '    fun unused(): Int = 0'
			)
		);

		expect(demo.name('hello')).toBe('text');
		// The `else` belongs to the `when`. Attached to the `if`, a blank string
		// would have taken it — and an Int, which matches no branch, would have
		// fallen out of the `when` entirely.
		expect(demo.name('')).toBe('fell through');
		expect(demo.name(1)).toBe('other');
	});

	it('still refuses a parse error that is not this one', () => {
		// The forgiveness is for one recognised marker. Anything else under a
		// member is still fatal to it, which is the rule this relaxed.
		expect(refusalNames(inClass('    fun broken() = when { -> }'))).toContain(
			'a passage this build could not parse'
		);
	});
});

describe('an anonymous `object :`, which is an object literal here', () => {
	it('carries its members, and reaches the source from inside them', () => {
		const emission = translate(
			inClass(
				'    val prefix = "p:"',
				'    fun tag(): Any {',
				'        return object : Callback {',
				'            override fun onName(value: String): String = label(value)',
				'        }',
				'    }',
				'    fun label(value: String): String = prefix + value'
			)
		);

		expect(emission.refusals).toEqual([]);

		const make = new Function('__k', `${emission.js}\nreturn new Demo();`) as (k: Any) => {
			tag: () => { onName: (value: string) => string };
		};
		const demo = make(runtime);

		// The body reads `label`, a member of the *source* — so the block is an
		// arrow and `this` is still the extension. A `function` here would have
		// bound `this` to the literal and answered `label is not a function`.
		expect(demo.tag().onName('x')).toBe('p:x');
	});

	it('refuses the one shape a literal cannot be: a constructed base', () => {
		// `object : Filter.Select("Sort", arrayOf("A")) { … }` is the base plus
		// an override, and a literal carrying only the override is missing
		// everything the base was going to supply.
		expect(
			refusalNames(
				inClass(
					'    val sorter = object : Filter.Select("Sort", arrayOf("A")) {',
					'        override fun on() = 1',
					'    }'
				)
			).join(' ')
		).toContain('over a constructed base');
	});
});

describe('an `interface`, which is a membership test here', () => {
	it('answers `is` and `filterIsInstance` for anything carrying its members', () => {
		// Every interface in this ecosystem is a capability marker with no
		// bodies, and the only question asked of one is
		// `filters.filterIsInstance<UriFilter>()`. JavaScript cannot express the
		// Kotlin — the implementers already extend `Filter.Select` and a class
		// extends one thing — so `instanceof` is answered by the members.
		const answers = evaluate(
			kt(
				'interface UriFilter {',
				'    fun addToUri(builder: String)',
				'}',
				'class Demo : Source() {',
				'    fun go() = 1',
				'}'
			),
			'[{ addToUri: () => 1 } instanceof UriFilter, { other: 2 } instanceof UriFilter]'
		);

		// `__isType` routes a declared type through `instanceof`, so this is the
		// same answer `filterIsInstance<UriFilter>()` and `is UriFilter` give.
		expect(answers).toEqual([true, false]);
	});

	it('refuses an interface member with a body, rather than dropping it', () => {
		// Kotlin allows a default implementation and nothing here would inherit
		// it: the implementer would answer `undefined` from a method the source
		// wrote out.
		expect(
			refusalNames(
				kt(
					'interface UriFilter {',
					'    fun addToUri(builder: String): String = builder + "!"',
					'}',
					'class Demo : Source() {',
					'    fun go() = 1',
					'}'
				)
			).join(' ')
		).toContain('with a body');
	});
});

describe('the member table a nested class used to overwrite', () => {
	it('keeps the enclosing class visible to the members below it', () => {
		// `protected class SMangaDto(…)` inside a template replaced the member
		// table and never put it back, so from the nested declaration to the end
		// of the file `this.somethingThisClassDeclares()` was read as a member of
		// a four-field DTO — and refused as a passthrough onto a shim, naming a
		// method the source had declared forty lines further down.
		const demo = instantiate(
			inClass(
				'    class Row(val title: String)',
				'    fun go(): String = this.later()',
				'    fun later(): String = "found"'
			)
		);

		expect(demo.go()).toBe('found');
	});
});

describe('a signature two declarations disagree about', () => {
	it('reads the call by the names it writes, rather than refusing it', () => {
		// `WordSet.startsWith(dateString)` in two shared templates collides with
		// Kotlin's `String.startsWith(prefix, ignoreCase)`, which deleted the
		// known signature and refused every `date.startsWith(it, ignoreCase =
		// true)` in the catalogue — 21 listings of 300, none of which had
		// written anything ambiguous. An argument passed by name is a parameter
		// of the callee, so a candidate without it is not the callee.
		const demo = instantiate(
			inClass(
				'    fun startsWith(dateString: String): Boolean = dateString.length > 2',
				'    fun check(text: String): Boolean = text.startsWith("AB", ignoreCase = true)'
			)
		);

		expect(demo.check('abcd')).toBe(true);
		expect(demo.check('zzz')).toBe(false);
	});
});

describe('an unbound reference to a property', () => {
	it('reads the property, where the same form over a method calls it', () => {
		// `distinctBy(GenreRoute::slug)` is a function of one argument that
		// reads it. Emitted as the method form it would be a function where a
		// value belongs, and a de-duplication keyed on a function keeps one row
		// out of every hundred.
		const found = evaluate(
			kt(
				'class Row(val slug: String)',
				'class Demo : Source() {',
				'    fun pick(rows: List<Row>): List<Row> = rows.distinctBy(Row::slug)',
				'}'
			),
			'new Demo().pick([{ slug: "a" }, { slug: "a" }, { slug: "b" }])'
		);

		expect(found).toHaveLength(2);
	});
});

describe('a primary constructor parameter that is not a property', () => {
	it('reads the parameter itself, not a field the class never got', () => {
		// `class Intl(language: String, private val baseLanguage: String)` gives
		// the class one field and two names, and this used to emit `this.language`
		// for both. The half with no field read `undefined`, so `Intl`'s own
		// language selection compared nothing against nothing and answered the
		// base language every time — an extension in Spanish drawing its filters
		// in English, with nothing refused and nothing thrown.
		const demo = instantiate(
			kt(
				'class Chooser(wanted: String, available: Set<String>, private val fallback: String) {',
				'    val chosen: String = if (wanted in available) wanted else fallback',
				'}',
				'class Demo : Source() {',
				'    fun pick(): String = Chooser("es", setOf("en", "es"), "en").chosen',
				'    fun miss(): String = Chooser("de", setOf("en", "es"), "en").chosen',
				'}'
			)
		);

		expect(demo.pick()).toBe('es');
		expect(demo.miss()).toBe('en');
	});

	it('still reads a parameter that IS a property off the instance', () => {
		// The other half, and the reason the scope is only as wide as an
		// initialiser: a `val` parameter outlives the constructor, and a getter
		// written below it reads the field rather than the argument.
		const demo = instantiate(
			kt(
				'class Holder(val lang: String, suffix: String) {',
				'    val tag = lang + suffix',
				'    val shown get() = lang',
				'}',
				'class Demo : Source() {',
				'    fun tag(): String = Holder("es", "!").tag',
				'    fun shown(): String = Holder("es", "!").shown',
				'}'
			)
		);

		expect(demo.tag()).toBe('es!');
		expect(demo.shown()).toBe('es');
	});
});

describe('the class loader', () => {
	it('answers the runtime’s classpath for both spellings of it', () => {
		// One idiom, two spellings, and the split is the whole catalogue:
		// `MadaraBase` writes the first and `MangaThemesia` the second.
		const demo = instantiate(
			inClass(
				'    val a = this::class.java.classLoader!!',
				'    val b = javaClass.classLoader!!',
				'    fun same(): Boolean = a == b'
			),
			{},
			{}
		);

		expect(demo.same()).toBe(true);
	});

	it('still refuses the JVM class object asked for anything else', () => {
		// A class *path* has an answer here and a class *name* does not. The
		// exemption is the length of the one chain and no further.
		expect(refusalNames(inClass('    val tag = javaClass.simpleName'))).toContain(
			'the JVM class object'
		);
	});
});

describe('a getter a subclass overrides with a plain value', () => {
	it('lets the assignment win, where a bare accessor threw at load', () => {
		// `override val mangaSubString = "comics-new"` over a template's
		// `open val mangaSubString get() = "manga"` is ordinary Kotlin and is a
		// strict-mode TypeError against a prototype accessor with no setter.
		// Measured over 300 listings it was 30 of the 47 bundles that converted
		// cleanly and then died on import.
		const demo = instantiate(
			kt(
				'open class Template {',
				'    open val slug get() = "manga"',
				'}',
				'class Special : Template() {',
				'    override val slug = "comics-new"',
				'}',
				'class Demo : Source() {',
				'    fun base(): String = Template().slug',
				'    fun overridden(): String = Special().slug',
				'}'
			)
		);

		expect(demo.base()).toBe('manga');
		expect(demo.overridden()).toBe('comics-new');
	});
});

describe('a property whose value the host has to compute', () => {
	it('waits until something reads it, rather than running in the constructor', () => {
		// `private val salted = "Salted__".toByteArray(Charsets.UTF_8)` is a
		// constant that happens to need an encoder, and the encoder is the
		// host's. No plugin call has entered while a constructor runs, so this
		// threw at load in 7 of 300 measured bundles — and the message it threw
		// said the module had called out to the network, which it had not.
		encodedTexts.length = 0;
		const demo = instantiate(
			inClass('    private val salted = "Salted__".toByteArray(Charsets.UTF_8)')
		);

		expect(encodedTexts).toEqual([]);
		expect(demo.salted).toEqual([8]);
		expect(encodedTexts).toEqual(['Salted__']);
	});

	it('still evaluates once, which is what the Kotlin `val` promised', () => {
		encodedTexts.length = 0;
		const demo = instantiate(
			inClass('    private val salted = "Salted__".toByteArray(Charsets.UTF_8)')
		);

		expect(demo.salted).toEqual([8]);
		expect(demo.salted).toEqual([8]);
		expect(encodedTexts).toEqual(['Salted__']);
	});

	it('leaves a `var` alone, because deferring one would move a side effect', () => {
		// The deferral is only sound for a value nothing reassigns.
		encodedTexts.length = 0;
		instantiate(inClass('    private var salted = "Salted__".toByteArray(Charsets.UTF_8)'));

		expect(encodedTexts).toEqual(['Salted__']);
	});
});

describe('the settings store written as a plain call', () => {
	it('resolves to the store, as the `by` delegate spelling already did', () => {
		// `protected val preferences = getPreferences()` is what `Keyoapp` and
		// `Kemono` write. It fell through to `this.getPreferences()` — the right
		// default for a member the base supplies, and wrong here, because the
		// driver supplies no such member. Four of the measured bundles died at
		// load on it.
		const demo = instantiate(
			inClass(
				'    private val preferences = getPreferences()',
				'    fun domain(): String = preferences.getString("domain", "fallback")!!'
			)
		);

		expect(demo.domain()).toBe('fallback');
	});
});

describe('the order module-scope declarations are emitted in', () => {
	it('puts a class before the constant that constructs it', () => {
		// A file-scope `val` and a class in one file have no order between them
		// in Kotlin. In JavaScript the `const` runs at load and the class is in
		// its temporal dead zone until its own line, so the wrong order is
		// `Cannot access 'Sort' before initialization` — at load, with nothing
		// refused.
		const found = evaluate(
			kt(
				'private val popular = Sort("views")',
				'class Sort(val key: String)',
				'class Demo : Source() {',
				'    fun pick(): String = popular.key',
				'}'
			),
			'new Demo().pick()'
		);

		expect(found).toBe('views');
	});

	it('does not invent a cycle out of a method that reads a constant above it', () => {
		// `object Helper { fun url() = HOST }` beside `val HOST = Helper.NAME`
		// is ordinary, and reading the method body as a load-time dependency
		// makes the two need each other. There is one correct order and a false
		// cycle would refuse to find it.
		const found = evaluate(
			kt(
				'private val host = Helper.NAME',
				'object Helper {',
				'    const val NAME = "example.invalid"',
				'    fun url(): String = "https://" + host',
				'}',
				'class Demo : Source() {',
				'    fun link(): String = Helper.url()',
				'}'
			),
			'new Demo().link()'
		);

		expect(found).toBe('https://example.invalid');
	});
});

/* ── the current manga API ───────────────────────────────────────────────── */

/**
 * keiyoushi's request verbs and the `SMangaUpdate` pair, which is how the
 * current half of the manga catalogue makes a request and answers one.
 */
describe('keiyoushi request verbs on a client', () => {
	const run = async (body: string[], client: unknown = { newCall: () => null }) => {
		sent.length = 0;
		const demo = instantiate(inClass(...body), { client, headers: { h: 1 } });
		return { demo, sent };
	};

	it('sends and awaits client.get(url), rather than indexing into the client', async () => {
		// One argument is also how `list.get(i)` reads, and this spelling came
		// out as `__k.getAt(this.client, url)` — no request, no await.
		const { demo } = await run(['    suspend fun page(url: String): String = client.get(url).url']);
		expect(await demo.page('https://example.invalid/a')).toBe('https://example.invalid/a');
		expect(sent).toHaveLength(1);
		expect(sent[0].verb).toBe('get');
		expect(sent[0].positional).toEqual(['https://example.invalid/a']);
		expect(sent[0].named).toEqual({});
	});

	it('hands named arguments over by name, for the runtime to place', async () => {
		const { demo } = await run([
			'    suspend fun page(url: String) = client.get(url, ensureSuccess = false)',
			'    suspend fun send(url: String, body: RequestBody) = client.post(url, headers, body)'
		]);
		await demo.page('https://example.invalid/a');
		await demo.send('https://example.invalid/b', 'BODY');
		expect(sent[0].named).toEqual({ ensureSuccess: false });
		expect(sent[1].verb).toBe('post');
		expect(sent[1].positional).toEqual(['https://example.invalid/b', { h: 1 }, 'BODY']);
	});

	it('reaches a client the extension named for what it is', async () => {
		const apiClient = { newCall: () => null };
		const { demo } = await run(['    suspend fun page(url: String) = apiClient.get(url)'], {
			newCall: () => null
		});
		(demo as Record<string, unknown>).apiClient = apiClient;
		await demo.page('https://example.invalid/a');
		expect(sent[0].receiver).toBe(apiClient);
	});

	it('refuses an argument name no overload declares', () => {
		expect(
			refusalNames(inClass('    suspend fun page(url: String) = client.get(url, retries = 2)'))
		).toContain('the argument name `retries` on `get`');
	});
});

describe('SMangaUpdate and getMangaUpdate', () => {
	it('builds the pair from named arguments in the data class order', async () => {
		const demo = instantiate(
			inClass(
				'    fun update(m: SManga, c: List<SChapter>) = SMangaUpdate(chapters = c, manga = m)'
			),
			{},
			{ SMangaUpdate: (manga: unknown, chapters: unknown) => ({ manga, chapters }) }
		);
		expect(demo.update('M', ['c1'])).toEqual({ manga: 'M', chapters: ['c1'] });
	});

	it('awaits the base class getMangaUpdate and reads the manga off the answer', async () => {
		// Read as `.manga` straight off the call, so an unawaited one hands back
		// undefined as the title.
		const calls: unknown[][] = [];
		const demo = instantiate(
			inClass(
				'    suspend fun details(m: SManga): SManga =',
				'        getMangaUpdate(m, emptyList(), fetchDetails = true, fetchChapters = false).manga'
			),
			{},
			{
				__super: {
					getMangaUpdate: async (...args: unknown[]) => {
						calls.push(args);
						return { manga: 'details', chapters: [] };
					}
				}
			}
		);
		expect(await demo.details('M')).toBe('details');
		expect(calls).toEqual([['M', [], true, false]]);
	});
});

/**
 * `super.x` where `x` is a property of a template this build translated.
 *
 * `override val seriesStatusSelector = ".status, ${super.seriesStatusSelector}"`
 * is how an extension extends a template's selector rather than replacing it,
 * and it was refused outright: `__super` holds the driver's methods and no
 * template state at all.
 */
describe('reading a template property through super', () => {
	const template = [
		'abstract class Base : Source() {',
		'    open val sel = "div.x"',
		'    open val count by lazy { 41 }',
		'    open val other = "o"',
		'}',
		''
	];

	it('reads the base value while the override is being initialised', () => {
		const emission = translate(
			kt(
				...template,
				'class Child : Base() {',
				'    override val sel = ".a, ${super.sel}"',
				'    override val count = super.count + 1',
				'    fun both() = sel + "|" + count + "|" + super.other',
				'}'
			)
		);
		expect(emission.refusals).toEqual([]);
		const make = new Function(
			'__k',
			...Object.keys(defaults),
			`${emission.js}\nreturn new Child();`
		) as (...args: unknown[]) => Instance;
		const child = make(runtime, ...Object.values(defaults));
		expect(child.both()).toBe('.a, div.x|42|o');
	});

	it('still refuses a sibling property the subclass also overrides', () => {
		// By the time `sel` is initialised, `other` holds the subclass's value,
		// not the template's, so there is no base value left to read.
		expect(
			refusalNames(
				kt(
					...template,
					'class Child : Base() {',
					'    override val other = "mine"',
					'    override val sel = super.other',
					'}'
				)
			)
		).toContain('`super.` used as a property');
	});
});
