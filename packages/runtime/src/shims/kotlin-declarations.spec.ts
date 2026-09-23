/**
 * Declaration-level Kotlin, from the source that writes it to the value that
 * comes back.
 *
 * ## Why this file goes all the way through
 *
 * Everything here is a construct whose meaning lives in a *declaration* rather
 * than at the line that uses it: a type written on the left of a `val` that
 * decides what a `parseAs()` on the right decodes, two extension functions that
 * share a name and are told apart by their receivers. `emit.spec.ts` runs its
 * fixtures against a stub `__k`, which would agree with whatever the emitter
 * assumed the runtime did; the halves here only mean something together. So
 * each test compiles a snippet, evaluates the emitted module against the real
 * runtime source, and asserts the **value** — the shape `kotlin-crypto.spec.ts`
 * uses for the same reason.
 *
 * Every fixture is Kotlin written for this test; no source is named anywhere
 * (AGENTS.md rule 9).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { emitKotlin, mergeDeclared, declaredIn } from '@plugin-bridge/core/kotlin/emit';
import { loadKotlinGrammar, type KotlinParser } from '@plugin-bridge/core/kotlin/grammar';
import { convertKotlin } from '@plugin-bridge/core/kotlin/pipeline';
import { JS_RUNTIME } from './js-runtime';
import { kotlinRuntime } from './kotlin-runtime';

/** The vendored parser artefacts, read the way this host reads a file. */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(
			fileURLToPath(new URL(`../../../core/src/kotlin/vendor/${name}`, import.meta.url))
		)
	);
}

let parse: KotlinParser;

beforeAll(async () => {
	parse = await loadKotlinGrammar(vendorWasm);
}, 60_000);

function context() {
	return {
		// Nothing chosen, so a setting read answers the default its call site
		// gives — which is what a fixture asserting defaults wants.
		settings: { string: () => '', boolean: () => false, list: () => [] as string[] },
		text: {
			encode: (value: string) => new TextEncoder().encode(value),
			decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
		},
		bytes: {
			toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
			fromBase64: (value: string) => new Uint8Array(Buffer.from(value, 'base64'))
		},
		log: { debug: () => undefined, warn: () => undefined }
	};
}

function kt(...lines: string[]): string {
	return lines.join('\n');
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Compiles one or more files as one unit and returns an instance of `entry`.
 *
 * Several files because a subclass overriding one of its template's overloads
 * is a question about two files, and each is emitted knowing what its
 * neighbours declare — the way the pipeline does it.
 */
async function instantiate(entry: string, ...sources: string[]): Promise<any> {
	const trees = sources.map((source) => parse(source));
	const declared = mergeDeclared(trees.map((tree) => declaredIn(tree)));
	const emitted = trees.map((tree) => emitKotlin(tree, declared));
	for (const emission of emitted) {
		expect(emission.fileRefusal).toBeNull();
		expect(emission.refusals.flatMap((one) => one.obstacles.map((o) => o.kind))).toEqual([]);
	}
	const module = [
		JS_RUNTIME,
		kotlinRuntime(),
		...emitted.map((emission) => emission.js),
		`export const __instantiate = function (ctx) { __enter(ctx); return new ${entry}(); };`
	].join('\n');
	const url = `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`;
	const loaded = (await import(/* @vite-ignore */ url)) as { __instantiate(ctx: unknown): any };
	return loaded.__instantiate(context());
}

function refusalNames(source: string): string[] {
	const emission = emitKotlin(parse(source));
	return emission.refusals.flatMap((one) => one.obstacles.map((obstacle) => obstacle.kind));
}

describe('the collection members a catalogue pass named, run', () => {
	// Each was refused by name, or — `lastIndex` — read as a property a JS
	// array does not have and answered undefined with nothing refused.
	const source = kt(
		'class Demo {',
		'    fun pop(items: List<String>): String {',
		'        val list = items.toMutableList()',
		'        val last = list.removeAt(list.lastIndex)',
		'        list.reverse()',
		'        return last + "|" + list.joinToString(",") + "|" + "abc".lastIndex',
		'    }',
		'    fun popEmpty(): String = mutableListOf<String>().removeAt(0)',
		'    fun value(m: Map<String, Int?>, k: String): Int? = m.getValue(k)',
		'    fun flipped(): String = StringBuilder("ab").append("c").reverse().toString()',
		'    fun date(text: String?): Long = text?.let(Instant::parseOrNull)?.toEpochMilliseconds() ?: 0L',
		'}'
	);

	it('pops, reverses in place, and reads the last index', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.pop(['a', 'b', 'c'])).toBe('c|b,a|2');
		expect(() => demo.popEmpty()).toThrow(/removed index 0 of a list of length 0/);
		expect(demo.flipped()).toBe('cba');
	});

	it('reads a map value, a held null included, and throws only for absence', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.value(new Map([['x', 1]]), 'x')).toBe(1);
		expect(demo.value({ y: null }, 'y')).toBeNull();
		expect(() => demo.value(new Map(), 'z')).toThrow(/"z", which is missing/);
	});

	it('calls a runtime type’s member through a `::` reference', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.date('2024-05-20T10:15:30Z')).toBe(Date.UTC(2024, 4, 20, 10, 15, 30));
		expect(demo.date('not a date')).toBe(0);
		expect(demo.date(null)).toBe(0);
	});

	it('decodes `decodeFromStream(body.byteStream())` from the body text', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private val json = Json { ignoreUnknownKeys = true }',
				'    private inline fun <reified T> Response.decode(): T = json.decodeFromStream(body.byteStream())',
				'    fun names(r: Response): List<String> = r.decode()',
				'}'
			)
		);
		expect(demo.names({ body: { string: () => '["a","b"]' } })).toEqual(['a', 'b']);
		// Anywhere else it is a stream of bytes this runtime does not keep.
		expect(
			refusalNames(kt('class Demo {', '    fun raw(r: Response) = r.body.byteStream()', '}'))
		).toEqual(['`.byteStream()`']);
	});
});

describe('the framework filters a filter class names in its supertype call', () => {
	it('slots named arguments by upstream parameter order, sort selection included', async () => {
		// `: Filter.Group<X>(name = …, state = …)` and friends were refused
		// for the names alone; `Filter.Sort.Selection(3, false)` for being a
		// call on a nested type. Both now build what the runtime's filters hold.
		const demo = await instantiate(
			'Demo',
			kt(
				'class SortFilter(state: Selection = Selection(2, ascending = false)) :',
				'    Filter.Sort(name = "Sort", values = arrayOf("a", "b", "c"), state = state)',
				'class TypeFilter : Filter.Select<String>(values = arrayOf("x", "y"), name = "Type", state = 1)',
				'class Genres(genres: List<String>) :',
				'    Filter.Group<Filter.CheckBox>(name = "Genres", state = genres.map { Filter.CheckBox(it) })',
				'class Demo {',
				'    fun filters() = listOf(SortFilter(), TypeFilter(), Genres(listOf("g")),',
				'        SortFilter(Filter.Sort.Selection(1, true)))',
				'}'
			)
		);
		const [sort, type, genres, chosen] = demo.filters();
		expect([sort.name, sort.values.length, sort.state]).toEqual([
			'Sort',
			3,
			{ index: 2, ascending: false }
		]);
		expect([type.name, type.values, type.state]).toEqual(['Type', ['x', 'y'], 1]);
		expect([genres.name, genres.state[0].name, genres.state[0].state]).toEqual([
			'Genres',
			'g',
			false
		]);
		expect(chosen.state).toEqual({ index: 1, ascending: true });
	});
});

describe('the string and collection members a second catalogue pass named', () => {
	const source = kt(
		'@Serializable',
		'class Manga(val title: String = "")',
		'class Demo {',
		'    fun pad(s: String): String = s.padEnd(5, \'0\') + "|" + "abc".padEnd(2) + "|" + "ab".padEnd(4) + "."',
		'    fun comp(t: String): String {',
		'        val m = Regex("(\\w+)-(\\d+)").find(t)!!',
		'        return m.destructured.component1() + ":" + m.destructured.component2() + ":" + Pair("x", 1).component2()',
		'    }',
		'    fun maps(): String {',
		'        val m = LinkedHashMap<String, Int>()',
		'        m["b"] = 2',
		'        m["a"] = 1',
		'        val copy = HashMap(m)',
		'        copy["c"] = 3',
		'        val set = LinkedHashSet<String>()',
		'        set.add("z"); set.add("z"); set.add("y")',
		'        return m.keys.joinToString() + "|" + copy.size + "|" + m.size + "|" + set.joinToString()',
		'    }',
		'    fun digit(name: String): Int = name.findAnyOf(IntRange(0, 9).map { it.toString() })?.first ?: -1',
		'    fun which(s: String): String = s.findAnyOf(listOf("ab", "a"), ignoreCase = true)?.second ?: "none"',
		'    fun b64(s: String): String = s.decodeBase64()?.utf8() ?: "bad"',
		'    private fun strip(s: String): String = s.removePrefix(")]}\'")',
		'    fun transformed(r: Response): String = r.parseAs<Manga>(transform = ::strip).title',
		'}'
	);

	it('pads, reads components, and builds maps and sets by constructor', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.pad('12')).toBe('12000|abc|ab  .');
		expect(demo.comp('abc-42')).toBe('abc:42:1');
		// Insertion order kept, and the copy is its own map.
		expect(demo.maps()).toBe('b, a|3|2|z, y');
	});

	it('finds the first of several strings, in Kotlin’s order', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.digit('Vol… 12')).toBe(5);
		expect(demo.digit('none')).toBe(-1);
		// At one index, the first in the list that matches — not the longest.
		expect(demo.which('xAB')).toBe('ab');
	});

	it('decodes okio base64 to a ByteString, and null for text that is not base64', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.b64('aGVsbG8gd29ybGQ=')).toBe('hello world');
		expect(demo.b64('aGVs bG8')).toBe('hello');
		expect(demo.b64('aGVsbG8*')).toBe('bad');
		expect(demo.b64('a')).toBe('bad');
	});

	it('builds a url from nothing with `HttpUrl.Builder()`, and refuses one with no scheme', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun u(q: String): String = HttpUrl.Builder().scheme("https").host("search.example.invalid")',
				'        .addPathSegment("search").addQueryParameter("text", q).build().toString()',
				'    fun bare(): String = HttpUrl.Builder().host("x.example.invalid").build().toString()',
				'}'
			)
		);
		expect(demo.u('a b')).toBe('https://search.example.invalid/search?text=a%20b');
		expect(() => demo.bare()).toThrow(/no scheme/);
	});

	it('runs a named `transform` before the parse', async () => {
		const demo = await instantiate('Demo', source);
		const body = ")]}'" + '{"title":"t"}';
		expect(demo.transformed({ body: { string: () => body }, string: () => body })).toBe('t');
	});
});

describe('names a third catalogue pass found, run', () => {
	const source = kt(
		'import eu.kanade.tachiyomi.source.model.SManga.Companion.COMPLETED',
		'import eu.kanade.tachiyomi.source.model.SManga.Companion.ONGOING',
		'class Demo {',
		'    fun status(done: Boolean): Int = SManga.create().apply { status = if (done) COMPLETED else ONGOING }.status',
		'    fun date(s: String, year: Long): Long {',
		'        val parser = DateTimeFormatterBuilder()',
		'            .appendPattern("d MMMM")',
		'            .parseDefaulting(ChronoField.YEAR, year)',
		'            .toFormatter(Locale.ENGLISH)',
		'        return LocalDate.parse(s, parser).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()',
		'    }',
		'    fun dated(s: String): Long {',
		'        val parser = DateTimeFormatterBuilder().appendPattern("d MMMM yyyy")',
		'            .parseDefaulting(ChronoField.YEAR, 1999L).toFormatter(Locale.ENGLISH)',
		'        return LocalDate.parse(s, parser).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()',
		'    }',
		'    fun decoded(s: String): String = Base64.decode(s, Base64.DEFAULT).toString(Charset.defaultCharset())',
		'    fun latin(s: String): String = String(Base64.decode(s, Base64.DEFAULT), Charset.forName("ISO-8859-1"))',
		'    fun sjis(s: String): String = String(Base64.decode(s, Base64.DEFAULT), Charset.forName("Shift_JIS"))',
		'    fun hex(n: Int): String = n.toString(16) + "|" + (-10).toString(16) + "|" + n.toString(2)',
		'}'
	);

	it('reads a companion constant imported by name', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.status(true)).toBe(2);
		expect(demo.status(false)).toBe(1);
	});

	it('defaults a field the pattern leaves out, and only that one', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.date('12 March', 2024)).toBe(Date.UTC(2024, 2, 12));
		// A year in the text wins over the default, as java.time has it.
		expect(demo.dated('12 March 2020')).toBe(Date.UTC(2020, 2, 12));
	});

	it('decodes bytes through the charset named, and refuses one it does not implement', async () => {
		// ISO-8859-1 is decoded exactly (one byte, one character), which the
		// shared video-host extractor's own decoder depends on; a multi-byte charset this
		// runtime has no table for is still refused by name, never guessed.
		const demo = await instantiate('Demo', source);
		expect(demo.decoded('aGVsbG8=')).toBe('hello');
		expect(demo.latin('6ek=')).toBe('\u00e9\u00e9');
		expect(() => demo.sjis('aGVsbG8=')).toThrow(/Shift_JIS/);
	});

	it('answers `missingDelimiterValue` when a substring delimiter is absent', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun f(n: String): String =',
				'        n.substringBeforeLast(\'.\', missingDelimiterValue = n) + "|" + n.substringAfter("/", missingDelimiterValue = "none")',
				'}'
			)
		);
		expect(demo.f('a.b.c')).toBe('a.b|none');
		expect(demo.f('x/y')).toBe('x/y|y');
	});

	it('formats in the radix `toString(radix)` names, which the plain helper dropped', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.hex(255)).toBe('ff|-a|11111111');
	});
});

describe('a fourth pass: collection members, a when-subject binding, qualified constructors', () => {
	const source = kt(
		'class Demo {',
		'    fun running(): String = listOf(1, 2, 3).runningFold(10) { acc, x -> acc + x }.joinToString()',
		'    fun indexedTo(): String {',
		'        val into = mutableListOf("start")',
		'        listOf("a", "b").mapIndexedTo(into) { i, x -> "$i$x" }',
		'        return into.joinToString()',
		'    }',
		'    fun all(): String = "${listOf(1, 2, 3).containsAll(listOf(3, 1))}${listOf(1, 2).containsAll(listOf(4))}"',
		'    fun retained(): String {',
		'        val xs = mutableListOf(1, 2, 3, 4)',
		'        val changed = xs.retainAll { it % 2 == 0 }',
		'        return "$changed:" + xs.joinToString()',
		'    }',
		'    fun afterLast(u: String): String = u.replaceAfterLast("/", "comics.json")',
		'    fun windows(): String = listOf(1, 2, 3, 4).windowed(size = 2).joinToString { it.joinToString("") } +',
		'        "|" + listOf(1, 2, 3).windowed(2, 2, true).joinToString { it.joinToString("") }',
		'    fun built(): String = Array(3) { i -> "x$i" }.joinToString()',
		'    fun subject(s: String): String = when (val e = s.trim()) {',
		'        "" -> "empty"',
		'        else -> "[$e]"',
		'    }',
		'    fun path(u: String): String? = java.net.URI(u).path',
		'    fun language(): String = Locale("pt").getDisplayLanguage(Locale.ENGLISH) + "|" + Locale("xx").getDisplayLanguage(Locale.ENGLISH)',
		'}'
	);

	it('runs each with Kotlin’s semantics', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.running()).toBe('10, 11, 13, 16');
		expect(demo.indexedTo()).toBe('start, 0a, 1b');
		expect(demo.all()).toBe('truefalse');
		// In place, answering whether anything went.
		expect(demo.retained()).toBe('true:2, 4');
		expect(demo.afterLast('https://a.example.invalid/x/y')).toBe(
			'https://a.example.invalid/x/comics.json'
		);
		expect(demo.windows()).toBe('12, 23, 34|12, 3');
		expect(demo.built()).toBe('x0, x1, x2');
		expect(demo.path('https://a.example.invalid/p/q?x=1')).toBe('/p/q');
		expect(demo.language()).toBe('Portuguese|xx');
	});

	it('binds a `when` subject for its branches', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.subject('  ')).toBe('empty');
		expect(demo.subject(' a ')).toBe('[a]');
	});
});

describe('aggregates, capitalize, java.util.Random and code points', () => {
	const source = kt(
		'class Demo {',
		'    fun agg(): String = listOf("b", "a", "c").min() + listOf(3, 9, 1).max() + listOf(1, 2).average() + "|" + Math.min(4, 2)',
		'    fun empty(): String = emptyList<String>().min()',
		'    fun cap(): String = "hello".capitalize() + "|" + "Hi".capitalize() + "|" + "élan".capitalize()',
		'    fun roll(): Int { val random = Random(); return random.nextInt(5) }',
		'    fun seeded(): Int = Random(42L).nextInt(5)',
		'    fun point(): Int = "a😀".codePointAt(1)',
		'}'
	);

	it('answers each as Kotlin and the JVM do, empty and seeded cases loudly', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.agg()).toBe('a91.5|2');
		expect(() => demo.empty()).toThrow(/minimum of an empty collection/);
		expect(demo.cap()).toBe('Hello|Hi|Élan');
		const rolled = demo.roll();
		expect(rolled >= 0 && rolled < 5).toBe(true);
		// A seed asks for one reproducible sequence, which this cannot give.
		expect(() => demo.seeded()).toThrow(/seeded a Random/);
		expect(demo.point()).toBe(0x1f600);
	});
});

describe('a Kotlin Iterable, declared or delegated', () => {
	// `Iterable<T> by list` was refused; `override fun iterator()` translated
	// into a class JavaScript could not iterate, and `x.map { }` over it ran
	// once, over the object itself, with nothing refused.
	const source = kt(
		'data class D(private val data: List<String>) : Iterable<String> by data',
		'data class S(val series: D, val oneShots: D) : Iterable<String> {',
		'    override fun iterator() = (series + oneShots).iterator()',
		'}',
		'data class Rev(private val issues: List<String>) : Iterable<String> by issues.reversed()',
		'class Plain(val items: List<Int>) : Iterable<Int> by items',
		'class Demo {',
		'    fun mapped(): String = S(D(listOf("a", "b")), D(listOf("c"))).map { it + "!" }.joinToString()',
		'    fun looped(): Int { var n = 0; for (x in Plain(listOf(1, 2, 3))) n += x; return n }',
		'    fun reversed(): String = Rev(listOf("1", "2", "3")).joinToString()',
		'    fun first(): String = D(listOf("x", "y")).first()',
		'}'
	);

	it('iterates the elements, through map, for, and first alike', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.mapped()).toBe('a!, b!, c!');
		expect(demo.looped()).toBe(6);
		expect(demo.reversed()).toBe('3, 2, 1');
		expect(demo.first()).toBe('x');
	});

	it('still refuses any other delegation, and a delegate the instance cannot reach', () => {
		expect(
			refusalNames(kt('class M(private val m: Map<String, Int>) : Map<String, Int> by m'))
		).toEqual(['explicit_delegation']);
		expect(
			refusalNames(kt('class P(items: List<Int>) : Iterable<Int> by items', 'class Demo'))
		).toEqual(['an `Iterable` delegate reading a parameter that is not a property']);
		// With a body, the grammar reads `by pages { … }` as a call passing the
		// body as a lambda; refused as the delegation, not emitted as a call.
		expect(
			refusalNames(
				kt(
					'data class Q(val pages: List<String>) : Iterable<String> by pages {',
					'    val n: Int',
					'        get() = pages.size',
					'}'
				)
			)
		).toEqual(['explicit_delegation']);
	});
});

describe('an exception built as a value', () => {
	it('is made, not thrown, and rejects the Observable it is handed to', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun licensed(): Observable<List<String>> = Observable.error(Exception("Licensed"))',
				'    fun wrapped(cause: Throwable): Throwable = IOException("wrapped", cause)',
				'}'
			)
		);
		await expect(demo.licensed()).rejects.toThrow('Licensed');
		const made = demo.wrapped('root');
		expect(made).toBeInstanceOf(Error);
		expect(made.message).toBe('wrapped');
		expect(made.cause).toBe('root');
	});
});

describe('a Kotlin Map, as a JS Map and as a JsonObject', () => {
	// A Map iterated as bare [k, v] arrays, so `it.key` was undefined, and its
	// `keys`/`values`/`entries` were property reads of a JS Map's *methods*; a
	// JsonObject iterated as one item, itself. All of it converted and answered
	// empty lists and NaN with nothing refused.
	const source = kt(
		'class Demo {',
		'    fun views(): String {',
		'        val m = mapOf("a" to 1, "b" to 2)',
		'        return m.keys.joinToString() + "|" + m.values.joinToString() + "|" + m.entries.joinToString { it.key + it.value }',
		'    }',
		'    fun entries(): String {',
		'        val m = mapOf("a" to 1, "b" to 2)',
		'        return m.map { it.key + it.value }.joinToString() + "|" + m.maxByOrNull { it.value }?.key + "|" + m.toList().joinToString { it.first }',
		'    }',
		'    fun transforms(): String {',
		'        val m = mapOf("a" to 1, "b" to 2)',
		'        return m.filter { it.value > 1 }.keys.joinToString() + "|" + m.mapValues { it.value * 10 }.values.joinToString() + "|" +',
		'            m.mapKeys { it.key.uppercase() }.keys.joinToString() + "|" + m.filterKeys { it == "a" }.size + "|" + m.filterValues { it > 5 }.size',
		'    }',
		'    fun json(text: String): String {',
		'        val o = Json.parseToJsonElement(text).jsonObject',
		'        val seen = mutableListOf<String>()',
		'        o.forEach { (k, _) -> seen.add(k) }',
		'        return o.keys.joinToString() + "|" + ("src" in o) + ("q" in o) + "|" + seen.joinToString() + "|" + o.filter { it.key != "b" }.keys.joinToString()',
		'    }',
		'}'
	);

	it('answers views, entries and Map-valued transforms as Kotlin does', async () => {
		const d = await instantiate('Demo', source);
		expect(d.views()).toBe('a, b|1, 2|a1, b2');
		expect(d.entries()).toBe('a1, b2|b|a, b');
		expect(d.transforms()).toBe('b|10, 20|A, B|1|0');
		expect(d.json('{"src":1,"b":{}}')).toBe('src, b|truefalse|src, b|src');
	});
});

describe('a decode on the implicit receiver', () => {
	it('decodes the receiver, not the source', async () => {
		// Madara's `?.runCatching { parseAs<JsonObject>() }` was
		// `__self.parseAs()` — the extension object, no type — which threw,
		// became null, and silently stopped every view-count ping.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun id(text: String?): String {',
				'        val data = text?.runCatching { parseAs<JsonObject>() }?.getOrNull() ?: return "none"',
				'        return data["manga_id"]?.jsonPrimitive?.content ?: "no id"',
				'    }',
				'}'
			)
		);
		expect(demo.id('{"manga_id":"42"}')).toBe('42');
		expect(demo.id('not json')).toBe('none');
		expect(demo.id(null)).toBe('none');
	});
});

describe('a library member that blocks, called from the file next door', () => {
	// PlaylistUtils' `fixSubtitles` is a plain `fun` that blocks, so it is
	// async here. Cross-file, only the `suspend` modifier was recorded: a
	// direct call handed a Promise on as a value, and a shared extractor's
	// `runCatching { … .let(playlistUtils::fixSubtitles) }.getOrDefault(…)`
	// read `getOrDefault` off a Promise and lost every video it found.
	const utils = kt(
		'class Utils {',
		'    fun fix(list: List<String>): List<String> = runBlocking { async { list.map { it.uppercase() } }.await() }',
		'}'
	);
	const caller = kt(
		'class Demo {',
		'    private val utils = Utils()',
		'    fun direct(list: List<String>): String = utils.fix(list).joinToString()',
		'    fun referenced(list: List<String>): String =',
		'        runCatching { list.let(utils::fix) }.getOrDefault(emptyList()).joinToString()',
		'}'
	);

	it('awaits it, called directly and through a reference in runCatching', async () => {
		const d = await instantiate('Demo', caller, utils);
		expect(await d.direct(['a', 'b'])).toBe('A, B');
		expect(await d.referenced(['c'])).toBe('C');
	});
});

describe('a temporary file handed to the player', () => {
	// PlaylistUtils' fixSubtitles repairs a caption file and writes it to
	// `File.createTempFile("subs", ".vtt")` so the player can load
	// `Uri.fromFile(file)`. A plugin has no filesystem; the carrier is the
	// text, and its uri a `data:` uri of the same bytes. The repair itself is
	// the extension's own code and runs unchanged.
	const source = kt(
		'class Demo {',
		'    fun carry(text: String): String {',
		'        val file = File.createTempFile("subs", ".vtt").also(File::deleteOnExit)',
		'        file.writeText(text)',
		'        return Uri.fromFile(file).toString()',
		'    }',
		'}'
	);

	it('answers a data uri holding exactly the text written, typed by the suffix', async () => {
		const d = await instantiate('Demo', source);
		const text = 'WEBVTT\n\n00:00.000 --> 00:01.000\nh\u00e9llo \u2014 \u5b57\u5e55';
		const uri: string = d.carry(text);
		expect(uri.startsWith('data:text/vtt;charset=utf-8;base64,')).toBe(true);
		const decoded = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64').toString('utf8');
		expect(decoded).toBe(text);
	});

	it('refuses every other use of File by name', () => {
		expect(
			refusalNames(
				kt(
					'fun a(): String = File("/etc/hosts").readText()',
					'fun b(): String = File.separator',
					'fun c(): Boolean = File.createTempFile("a", ".b").setReadable(true)'
				)
			)
		).toEqual(['`File(…)`', '`File.separator`', '`.setReadable()`']);
	});
});

describe('a reference to a member the template declares', () => {
	it('binds it to the inherited value, not to the argument', async () => {
		// DooPlay's `protected open val episodeNumberRegex`, read by a subclass
		// as `.let(episodeNumberRegex::find)`. It was emitted as the unbound
		// `__k.find(text)` — the first character of the text standing in for a
		// regex match — so every episode number was wrong, with nothing refused.
		const sub = await instantiate(
			'Sub',
			kt(
				'open class Base {',
				'    protected open val episodeNumberRegex by lazy { "(\\d+)$".toRegex() }',
				'}',
				'class Sub : Base() {',
				'    fun number(text: String): String = text.let(episodeNumberRegex::find)?.groupValues?.last() ?: "0"',
				'}'
			)
		);
		expect(sub.number('Episode 12')).toBe('12');
		expect(sub.number('Special')).toBe('0');
	});
});

describe('a decode that names a @Serializable class', () => {
	// The structural decoder recognised a record by its field set, and a class
	// whose fields are all optional fits every record — so `Filters` below made
	// `Chapter` unrecognisable, and `dto.toPages()` was not a function on a
	// bundle that reported nothing refused. A written type needs no guess.
	const dtos = kt(
		'@Serializable',
		'class Filters(val genres: List<String> = emptyList(), val tags: List<String> = emptyList())',
		'@Serializable',
		'class Envelope<T>(val data: T, val total: Int = 0)',
		'@Serializable',
		'class Chapter(',
		'    @SerialName("cap_id") val id: Int,',
		'    @JsonNames("cap_nome", "titulo") val name: String,',
		'    val number: Float? = null,',
		'    @SerialName("cap_paginas") @Serializable(PageList::class) val pages: List<PageSrc> = emptyList(),',
		'    val scan: Scan? = null,',
		') {',
		'    fun toPages(): List<String> = pages.map { "${scan?.slug ?: "-"}/" + it.src }',
		'    var views: Int = 0',
		'}',
		'@Serializable',
		'class PageSrc(val src: String, val mime: String? = null)',
		'@Serializable',
		'data class Scan(@SerialName("scan_slug") val slug: String)',
		'object PageList : JsonTransformingSerializer<List<PageSrc>>(ListSerializer(PageSrc.serializer())) {',
		'    override fun transformDeserialize(element: JsonElement) = JsonArray(',
		'        element.jsonArray.map { page ->',
		'            when (page) {',
		'                is JsonPrimitive -> buildJsonObject { put("src", page.content) }',
		'                else -> page',
		'            }',
		'        },',
		'    )',
		'}',
		'object FirstOrSelf : JsonTransformingSerializer<PageSrc>(PageSrc.serializer()) {',
		'    override fun transformDeserialize(element: JsonElement): JsonElement = if (element is JsonArray) element[0] else element',
		'}',
		'object StringOrNumber : KSerializer<String> {',
		'    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("StringOrNumber", PrimitiveKind.STRING)',
		'    override fun deserialize(decoder: Decoder): String = when (decoder) {',
		'        is JsonDecoder -> decoder.decodeJsonElement().jsonPrimitive.content',
		'        else -> decoder.decodeString()',
		'    }',
		'    override fun serialize(encoder: Encoder, value: String) {',
		'        encoder.encodeString(value)',
		'    }',
		'}',
		'@Serializable',
		'class Cover(@Serializable(FirstOrSelf::class) val image: PageSrc, @Serializable(with = StringOrNumber::class) val id: String)',
		'@Serializable',
		'class Ranked(val ids: List<@Serializable(StringOrNumber::class) String>)'
	);
	const demo = kt(
		'class Demo {',
		'    private val json = Json { ignoreUnknownKeys = true }',
		'    fun chapter(text: String): Chapter = json.decodeFromString<Chapter>(text)',
		'    fun wrapped(text: String): Envelope<List<Chapter>> = json.decodeFromString(text)',
		'    fun cover(text: String): Cover = json.decodeFromString<Cover>(text)',
		'    fun ranked(text: String): Ranked = json.decodeFromString<Ranked>(text)',
		'    fun filters(text: String): Filters = json.decodeFromString<Filters>(text)',
		'    fun encode(value: Chapter): JsonElement = value.toJsonElement()',
		'}'
	);

	it('builds the class the type names, with its methods, renames and defaults', async () => {
		const d = await instantiate('Demo', demo, dtos);
		const chapter = d.chapter(
			'{"cap_id":7,"titulo":"Seven","cap_paginas":["a.jpg",{"src":"b.webp"}],"scan":{"scan_slug":"s1"},"views":3}'
		);
		expect(chapter.id).toBe(7);
		expect(chapter.name).toBe('Seven');
		expect(chapter.number).toBeNull();
		expect(chapter.views).toBe(3);
		// The extension's own PageList reshaped the bare string into a record.
		expect(chapter.toPages()).toEqual(['s1/a.jpg', 's1/b.webp']);
		const empty = d.chapter('{"cap_id":1,"cap_nome":"One"}');
		expect(empty.toPages()).toEqual([]);
		expect(empty.views).toBe(0);
		// `Filters` fits every record; it is still only what its type says.
		expect(d.filters('{}').genres).toEqual([]);
	});

	it('carries a type argument through a generic class', async () => {
		const d = await instantiate('Demo', demo, dtos);
		const page = d.wrapped('{"data":[{"cap_id":2,"cap_nome":"Two","cap_paginas":["x"]}]}');
		expect(page.total).toBe(0);
		expect(page.data[0].toPages()).toEqual(['-/x']);
	});

	it('runs a transforming serializer and a KSerializer where they are written', async () => {
		const d = await instantiate('Demo', demo, dtos);
		const cover = d.cover('{"image":[{"src":"first"},{"src":"second"}],"id":42}');
		expect(cover.image.src).toBe('first');
		expect(cover.id).toBe('42');
		expect(d.cover('{"image":{"src":"only"},"id":"x"}').image.src).toBe('only');
		// On a type argument, the serializer applies to each element.
		expect(d.ranked('{"ids":[1,"b",3]}').ids).toEqual(['1', 'b', '3']);
	});

	it('fails a missing required field as kotlinx does, and not a nullable one', async () => {
		const d = await instantiate('Demo', demo, dtos);
		expect(() => d.chapter('{"cap_nome":"no id"}')).toThrow(/response\.id/);
		expect(d.chapter('{"cap_id":1,"cap_nome":"n","number":null,"cap_paginas":null}').pages).toEqual(
			[]
		);
	});

	it('uses a @Contextual default when the key is absent, and refuses it when present', async () => {
		// One source's `@Contextual private val sdf = SimpleDateFormat(…)`: kotlinx
		// asks the serializersModule only for a key the payload carries.
		const d = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun read(text: String): Dated = Json.decodeFromString<Dated>(text)',
				'}',
				'@Serializable',
				'data class Dated(val id: String) {',
				'    @Contextual',
				'    private val stamp = listOf(1, 2)',
				'    fun size(): Int = stamp.size',
				'}'
			)
		);
		expect(d.read('{"id":"a"}').size()).toBe(2);
		expect(() => d.read('{"id":"a","stamp":"x"}')).toThrow(/@Contextual field/);
	});

	it("reads the app's Json through Injekt, and binds a reference to it", async () => {
		// keiyoushi core's `val jsonInstance: Json = Injekt.get()`, and
		// One source's `contentOrNull?.let(jsonInstance::parseToJsonElement)`,
		// which used to call `parseToJsonElement` on the string itself.
		const d = await instantiate(
			'Demo',
			kt(
				'val jsonInstance: Json = Injekt.get()',
				'class Demo {',
				'    fun tags(text: String?): JsonElement? = text?.let(jsonInstance::parseToJsonElement)',
				'    fun empty(): JsonObject = JsonObject(emptyMap())',
				'    fun one(): JsonObject = JsonObject(mutableMapOf("a" to JsonPrimitive(1)))',
				'}'
			)
		);
		expect(d.tags('["a","b"]')).toEqual(['a', 'b']);
		expect(d.tags(null)).toBeNull();
		// A Kotlin Map's entries are the object, not a mutable map's methods.
		expect(Object.keys(d.empty())).toEqual([]);
		expect(d.one()).toEqual({ a: 1 });
	});

	it('refuses to encode a record whose class runs a custom serializer', async () => {
		// Encoding it as its decoded fields is not what the serializer writes.
		const d = await instantiate('Demo', demo, dtos);
		const chapter = d.chapter('{"cap_id":7,"cap_nome":"n"}');
		expect(() => d.encode(chapter)).toThrow(/custom serializer/);
	});
});

describe('a decode whose type is written where the value goes', () => {
	const source = kt(
		'class Demo {',
		'    private val json = Json { ignoreUnknownKeys = true }',
		'    fun typedVal(text: String): Int {',
		'        val list: List<String> = json.decodeFromString(text)',
		'        return list.size',
		'    }',
		'    fun declaredReturn(text: String): List<Int> = json.decodeFromString(text)',
		'    fun returned(text: String): List<Int> {',
		'        if (text.isEmpty()) return emptyList()',
		'        return json.decodeFromString(text)',
		'    }',
		'    fun assigned(text: String): String {',
		'        lateinit var value: String',
		'        value = if (text.isEmpty()) "none" else json.decodeFromString(text)',
		'        return value',
		'    }',
		'    fun argument(text: String): Int = count(json.decodeFromString(text))',
		'    private fun count(items: List<String>): Int = items.size',
		'    fun viaHelper(text: String): List<String> = text.parseWith()',
		'    private inline fun <reified T> String.parseWith(): T = json.decodeFromString(this)',
		'}'
	);

	it('decodes to the container the declared type names', async () => {
		const demo = await instantiate('Demo', source);
		// A single object read as `List<String>` is a list of one — that is
		// what the container is for, and it is only right if the type arrived.
		expect(demo.typedVal('"alone"')).toBe(1);
		expect(demo.declaredReturn('[1,2,3]')).toEqual([1, 2, 3]);
		expect(demo.returned('')).toEqual([]);
		expect(demo.returned('[4]')).toEqual([4]);
		expect(demo.argument('"one"')).toBe(1);
	});

	it('coerces to the primitive the declared type names', async () => {
		const demo = await instantiate('Demo', source);
		// `String` decoded from a number is the number's text in kotlinx's
		// lenient mode; without the type it would stay a number.
		expect(demo.assigned('42')).toBe('42');
		expect(demo.assigned('')).toBe('none');
	});

	it('carries a reified helper’s type through to the decode inside it', async () => {
		const demo = await instantiate('Demo', source);
		// Inside the helper the type is the *call site's* — `List<String>` —
		// and not the letter `T`, which names nothing and decoded as "any".
		expect(demo.viaHelper('"single"')).toEqual(['single']);
	});

	it('reads the type through a `use`, `let` or `run` whose value is the block', async () => {
		// `private inline fun <reified T> Response.parseAs(): T = use {
		// json.decodeFromString(it.body.string()) }` — the block is the value,
		// so Kotlin infers its result from the return type. `also` answers its
		// receiver, so a type is not pushed into its block.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private val json = Json { ignoreUnknownKeys = true }',
				'    fun viaLet(text: String): List<String> = text.parseLet()',
				'    private inline fun <reified T> String.parseLet(): T = let { json.decodeFromString(it) }',
				'    fun viaRun(text: String): List<Int> = text.run { json.decodeFromString(this) }',
				'    fun viaUse(text: String): String = text.let { it.trim() }.let {',
				'        json.decodeFromString(it)',
				'    }',
				'}'
			)
		);
		expect(demo.viaLet('"single"')).toEqual(['single']);
		expect(demo.viaRun('[1,2]')).toEqual([1, 2]);
		expect(demo.viaUse(' 42 ')).toBe('42');
		expect(
			refusalNames(
				kt(
					'class Demo {',
					'    private val json = Json { ignoreUnknownKeys = true }',
					'    fun kept(text: String): String = text.also { json.decodeFromString(it) }',
					'}'
				)
			)
		).toEqual(['`.decodeFromString()` with no type argument']);
	});

	it('still refuses a decode with nowhere to read its type from', () => {
		expect(
			refusalNames(
				kt(
					'class Demo {',
					'    private val json = Json { ignoreUnknownKeys = true }',
					'    fun untyped(text: String) = json.decodeFromString(text)',
					'}'
				)
			)
		).toEqual(['`.decodeFromString()` with no type argument']);
	});

	it('refuses where two positions give one call two different types', () => {
		// The same call text on the same line reached from two typed positions
		// is not something Kotlin allows to disagree; this build keys by text,
		// so it refuses rather than picking one.
		expect(
			refusalNames(
				kt(
					'class Demo {',
					'    private val json = Json { ignoreUnknownKeys = true }',
					'    fun both(text: String): Int { val a: List<Int> = json.decodeFromString(text); val b: String = json.decodeFromString(text); return 1 }',
					'}'
				)
			)
		).toContain('`.decodeFromString()` with no type argument');
	});
});

describe('a reified function whose type parameter is read off the call', () => {
	it('takes it from the declared type the value goes to', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private val json = Json { ignoreUnknownKeys = true }',
				'    private inline fun <reified T> String.decoded(): T = json.decodeFromString<T>(this)',
				'    fun run(text: String): Int {',
				'        val numbers: List<Int> = text.decoded()',
				'        return numbers.size',
				'    }',
				'}'
			)
		);
		expect(demo.run('7')).toBe(1);
	});
});

describe('extension functions overloaded on their receiver', () => {
	const template = kt(
		'open class Template {',
		'    protected open fun Element.label(): String = attr("data-label")',
		'    protected open fun Elements.label(): String = firstOrNull()?.label().orEmpty()',
		'    fun fromList(html: String): String = Jsoup.parse(html).select("span").label()',
		'    fun fromOne(html: String): String = Jsoup.parse(html).selectFirst("span")!!.label()',
		'}'
	);

	it('dispatches each receiver to its own overload rather than the last', async () => {
		// Collapsed onto the last declaration, the list overload called itself
		// with an element, which it again read as a list of one — until the
		// stack ran out. That was every cover in the largest template measured.
		const demo = await instantiate('Template', template);
		expect(demo.fromList('<span data-label="first"></span><span data-label="second"></span>')).toBe(
			'first'
		);
		expect(demo.fromOne('<span data-label="only"></span>')).toBe('only');
		expect(demo.fromList('<p></p>')).toBe('');
	});

	it('lets a subclass override one overload without replacing the dispatch', async () => {
		const demo = await instantiate(
			'Child',
			template,
			kt(
				'class Child : Template() {',
				'    override fun Element.label(): String = attr("data-other")',
				'}'
			)
		);
		// The list overload is the template's and calls the element overload,
		// which is now the child's — the answer Kotlin's virtual dispatch gives.
		expect(demo.fromList('<span data-label="a" data-other="b"></span>')).toBe('b');
		expect(demo.fromOne('<span data-label="a" data-other="c"></span>')).toBe('c');
	});

	it('dispatches on a class this module declares', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'class Box(val inner: String)',
				'class Demo {',
				'    private fun Box.describe(): String = "box of " + inner.describe()',
				'    private fun String.describe(): String = "text " + this',
				'    fun run(): String = Box("a").describe()',
				'}'
			)
		);
		expect(demo.run()).toBe('box of text a');
	});

	it('sends a Document to its own overload rather than the Element one', async () => {
		// A Document *is* an Element, in jsoup and here; Kotlin picks the most
		// specific overload for the static type, and a document is only ever
		// handed over typed as one.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private fun Element.pick(): String = "element " + tagName()',
				'    private fun Document.pick(): String = "document"',
				'    fun onDocument(html: String): String = Jsoup.parse(html).pick()',
				'    fun onElement(html: String): String = Jsoup.parse(html).selectFirst("p")!!.pick()',
				'}'
			)
		);
		expect(demo.onDocument('<p></p>')).toBe('document');
		expect(demo.onElement('<p></p>')).toBe('element p');
	});
});

describe('a member imported by name from a shared object', () => {
	const shared = kt(
		'package example.shared',
		'object SharedFilters {',
		'    open class Choice(val value: String)',
		'    fun pairs(index: Int): String = "pairs-" + index',
		'    val PREFIX = "p:"',
		'    inline fun <reified R> List<Any>.firstOf(): R = first { it is R } as R',
		'    fun List<Any>.asQueryPart(): String = (first() as Choice).value',
		'}'
	);
	const importing = kt(
		'package example.extension',
		'import example.shared.SharedFilters.Choice',
		'import example.shared.SharedFilters.asQueryPart',
		'import example.shared.SharedFilters.firstOf',
		'import example.shared.SharedFilters.pairs',
		'import example.shared.SharedFilters.PREFIX',
		'class Picked(value: String) : Choice(value)',
		'object LocalFilters {',
		'    fun sorted(index: Int): String = PREFIX + pairs(index)',
		'    fun chosen(items: List<Any>): String = items.firstOf<Picked>().value',
		'    fun query(items: List<Any>): String = items.asQueryPart()',
		'}',
		'class Demo {',
		'    fun sorted(): String = LocalFilters.sorted(2)',
		'    fun chosen(): String = LocalFilters.chosen(listOf("x", Picked("y")))',
		'    fun query(): String = LocalFilters.query(listOf(Picked("a b")))',
		'}'
	);

	it('calls the object that declares it, not the one calling it', async () => {
		// Emitted as `this.pairs(…)` on the importing object, which has no such
		// member: a TypeError at the first search, with nothing refused.
		const demo = await instantiate('Demo', shared, importing);
		expect(demo.sorted()).toBe('p:pairs-2');
	});

	it('passes an imported reified extension the type the call site named', async () => {
		const demo = await instantiate('Demo', shared, importing);
		expect(demo.chosen()).toBe('y');
	});

	it('runs an imported extension rather than a runtime helper of the same name', async () => {
		// The runtime's `asQueryPart` URL-encodes a string; handed the filter
		// list instead of the declared extension, it answered an encoded list.
		const demo = await instantiate('Demo', shared, importing);
		expect(demo.query()).toBe('a b');
	});
});

describe('a companion object, which belongs to its class', () => {
	it('keeps two classes’ companion members of one name apart', async () => {
		// Hoisted to one module scope, the second `options` was refused as a
		// collision — and a filters file keeps a dozen of them, one per filter.
		const demo = await instantiate(
			'Demo',
			kt(
				'class GenreFilter {',
				'    fun first() = options[0]',
				'    companion object {',
				'        private val options = listOf("action", "drama")',
				'    }',
				'}',
				'class TypeFilter {',
				'    fun first() = options[0]',
				'    fun count() = describe()',
				'    companion object {',
				'        private val options = listOf("manga", "manhwa", "manhua")',
				'        private fun describe() = options.size',
				'    }',
				'}',
				'class Demo {',
				'    fun run() = listOf(GenreFilter().first(), TypeFilter().first(), TypeFilter().count().toString())',
				'}'
			)
		);
		expect(demo.run()).toEqual(['action', 'manga', '3']);
	});

	it('is reachable through the class’s name from outside it', async () => {
		// `Holder.KEY` read a property the emitted class never had, and
		// answered undefined with nothing refused.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Holder(val tag: String) {',
				'    fun bump(): Int { counter += 1; return counter }',
				'    companion object {',
				'        const val KEY = "key"',
				'        var counter = 0',
				'        fun make() = Holder("made")',
				'    }',
				'}',
				'class Demo {',
				'    fun run(): String {',
				'        Holder.counter = 40',
				'        Holder("x").bump()',
				'        return Holder.KEY + ":" + Holder.make().tag + ":" + Holder("y").bump()',
				'    }',
				'}'
			)
		);
		// A companion `var` is one value, written from outside and from inside.
		expect(demo.run()).toBe('key:made:42');
	});
});

describe('an enum class, which is a class with fixed instances', () => {
	const source = kt(
		'enum class Layout(private val prefix: String, val label: String) {',
		'    SLUG("", "Slug"),',
		'    NESTED("/comic/", "Nested"),',
		'    ROOT("/", "Root"),',
		'    ;',
		'    fun url(slug: String): String = "$prefix$slug"',
		'    val shouting get() = label.uppercase()',
		'    fun atLeast(other: Layout): Boolean = this >= other',
		'    companion object {',
		'        const val PREF_KEY = "layout"',
		'        val default = NESTED',
		'        fun fromKey(key: String) = entries.find { it.name == key } ?: default',
		'        fun byLabel(label: String) = values().first { it.label == label }',
		'    }',
		'}',
		'class Demo {',
		'    fun urls() = Layout.entries.map { it.url("x") }',
		'    fun count() = Layout.values().size',
		'    fun parsed() = Layout.valueOf("ROOT").ordinal',
		'    fun companion() = Layout.PREF_KEY + ":" + Layout.fromKey("nope").name + ":" + Layout.byLabel("Root").shouting',
		'    fun compare() = listOf(Layout.ROOT.atLeast(Layout.SLUG), Layout.SLUG.atLeast(Layout.ROOT))',
		'    fun text() = "layout " + Layout.SLUG + " is ${Layout.ROOT}"',
		'    fun picked() = pick(Layout.valueOf("NESTED"))',
		'    fun pick(layout: Layout) = when (layout) {',
		'        Layout.SLUG -> 1',
		'        Layout.NESTED -> 2',
		'        Layout.ROOT -> 3',
		'    }',
		'}'
	);

	it('runs the members an enum declares, on each entry', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.urls()).toEqual(['x', '/comic/x', '/x']);
		expect(demo.companion()).toBe('layout:NESTED:ROOT');
	});

	it('answers entries, values() and valueOf() as Kotlin does', async () => {
		// All three read undefined off the frozen map an enum used to be.
		const demo = await instantiate('Demo', source);
		expect(demo.count()).toBe(3);
		expect(demo.parsed()).toBe(2);
		expect(demo.picked()).toBe(2);
	});

	it('compares by ordinal and prints by name', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.compare()).toEqual([true, false]);
		expect(demo.text()).toBe('layout SLUG is ROOT');
	});

	it('refuses an entry with a body of its own', () => {
		// A subclass per entry, which this emission has no shape for.
		expect(
			refusalNames(
				kt('enum class Mode {', '    A { override fun toString() = "a" },', '    B,', '}')
			)
		).not.toEqual([]);
	});
});

describe('a data class copy', () => {
	const source = kt(
		'data class Item(val name: String, val count: Int = 1) {',
		'    val label get() = "$name x$count"',
		'}',
		'class Demo {',
		'    fun renamed() = Item("a", 2).copy(name = "b").label',
		'    fun positional() = Item("a", 2).copy("c").label',
		'    fun original(): String { val one = Item("a"); one.copy(count = 9); return one.label }',
		'    fun nullable(item: Item?) = item?.copy(count = 5)?.label',
		'    fun page() = MangasPage(listOf(), true).copy(hasNextPage = false).hasNextPage',
		'    fun pageByPosition() = MangasPage(listOf(), true).copy(listOf(SManga.create())).mangas.size',
		'}'
	);

	it('rebuilds the record, so what it computes follows the copy', async () => {
		// Copied field by field, `label` kept closing over the old parameters.
		const demo = await instantiate('Demo', source);
		expect(demo.renamed()).toBe('b x2');
		expect(demo.positional()).toBe('c x2');
		expect(demo.original()).toBe('a x1');
		expect(demo.nullable(null) ?? null).toBeNull();
	});

	it('copies the framework’s own list page, by name or position', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.page()).toBe(false);
		expect(demo.pageByPosition()).toBe(1);
	});
});

describe('detached accessors and minimal declarations', () => {
	it('reads computed properties, replaces a LazyMutable, and constructs an empty subclass', async () => {
		const demo = await instantiate(
			'Demo',
			kt(
				'data class Series(val genre: String) {',
				'    val label: String',
				'        get() = "$genre series"',
				'}',
				'class Demo {',
				'    private var built = 0',
				'    var host by LazyMutable { built += 1; "mirror$built" }',
				'    var token: String? = null',
				'        private set',
				'    fun hosts(): String { val first = host; val again = host; host = "chosen"; return "$first $again $host $built" }',
				'    fun login(): String? { token = "t"; return token }',
				'    fun label() = Series("action").label',
				'    fun year() = currentYear',
				'    fun filters() = listOf("a", "b").map { object : Filter.CheckBox(it, true) {} }',
				'    companion object {',
				'        private val currentYear: Int',
				'            get() = 2000 + 26',
				'    }',
				'}'
			)
		);
		expect(demo.hosts()).toBe('mirror1 mirror1 chosen 1');
		expect(demo.login()).toBe('t');
		expect(demo.label()).toBe('action series');
		expect(demo.year()).toBe(2026);
		expect(
			demo.filters().map((item: { name: string; state: boolean }) => `${item.name}=${item.state}`)
		).toEqual(['a=true', 'b=true']);
	});

	it('still refuses an anonymous subclass with its own body', () => {
		expect(
			refusalNames(
				kt(
					'class Demo {',
					'    val cache = object : LinkedHashMap<String, String>() {',
					'        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?) = size > 10',
					'    }',
					'}'
				)
			)
		).toEqual(['an anonymous `object : LinkedHashMap(…)` over a constructed base']);
	});
});

describe('a nested type with a top-level namesake further down', () => {
	// `Chapter.Branch` nested above a top-level `Branch`: the nested one took
	// the bare name because it was written first, the top-level one was
	// written under it too, and the module was "Branch has already been
	// declared" at load. The top-level type keeps the name the rest of the
	// module uses; the nested one is renamed apart, and the typed decoder is
	// told the renamed class, or `branches` would decode as the namesake.
	const source = kt(
		'@Serializable',
		'class Chapter(val branches: List<Branch>) {',
		'    @Serializable',
		'    class Branch(@SerialName("branch_id") val branchId: Int, val team: String) {',
		'        fun label(): String = "$team#$branchId"',
		'    }',
		'    fun labels(): String = branches.joinToString { it.label() }',
		'}',
		'@Serializable',
		'class Branch(val id: Int)',
		'class Demo {',
		'    private val json = Json { ignoreUnknownKeys = true }',
		'    fun chapter(text: String): String = json.decodeFromString<Chapter>(text).labels()',
		'    fun nested(text: String): String = json.decodeFromString<Chapter.Branch>(text).label()',
		'    fun branches(text: String): Int = json.decodeFromString<List<Branch>>(text).sumOf { it.id }',
		'}'
	);

	it('loads, and decodes each spelling as the class it names', async () => {
		const d = await instantiate('Demo', source);
		expect(d.chapter('{"branches":[{"branch_id":1,"team":"a"},{"branch_id":2,"team":"b"}]}')).toBe(
			'a#1, b#2'
		);
		expect(d.nested('{"branch_id":3,"team":"c"}')).toBe('c#3');
		expect(d.branches('[{"id":4},{"id":5}]')).toBe(9);
	});
});

describe('a filter class that names its framework base’s arguments', () => {
	// `Filter.Group<Option>(name = name, state = …)` in a filter file's base
	// class. Refused, the base went — and every filter extending it with it,
	// which died at load. Placed by upstream's own parameter lists.
	it('builds the filter with each argument where upstream puts it', async () => {
		const d = await instantiate(
			'Demo',
			kt(
				'class Option(name: String, val value: String) : Filter.CheckBox(name)',
				'abstract class MultiValue(name: String, values: List<Pair<String, String>>) : Filter.Group<Option>(',
				'    state = values.map { Option(it.first, it.second) },',
				'    name = name,',
				')',
				'class Status : MultiValue("Status", listOf("On" to "0", "Done" to "1"))',
				'class Order : Filter.Sort(values = arrayOf("a", "b"), name = "Order", state = Selection(1, false))',
				'class Demo {',
				'    fun status(): String { val f = Status(); return f.name + ":" + f.state.joinToString { it.name + "=" + it.value } }',
				'    fun order(): String { val f = Order(); return f.name + ":" + f.values.joinToString() + ":" + f.state!!.index }',
				'}'
			)
		);
		expect(d.status()).toBe('Status:On=0, Done=1');
		expect(d.order()).toBe('Order:a, b:1');
	});
});

describe('an extension named after the theme it imports and extends', () => {
	// `abstract class UzayManga : UzayManga()` over
	// `import …multisrc.uzaymanga.UzayManga`. Kotlin resolves the name to the
	// import everywhere but the declaration itself; read the other way round,
	// the class was emitted extending itself and the bundle died on import.
	it('loads, extends the theme, and is the class the driver builds', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'src/Theme.kt',
					source: kt(
						'package com.example.extension',
						'',
						'import com.example.multisrc.theme.Theme',
						'',
						'class Theme : Theme() {',
						'    override val cdnUrl = "https://cdn.example.invalid"',
						'}'
					)
				},
				{
					path: 'lib/Theme.kt',
					source: kt(
						'package com.example.multisrc.theme',
						'',
						'abstract class Theme {',
						'    open val cdnUrl = "https://default.example.invalid"',
						'    fun image(path: String): String = "$cdnUrl/$path"',
						'}'
					)
				}
			],
			{ parser: parse }
		);
		expect(result.blocking).toEqual([]);
		expect(result.className).toBe('Theme');
		const module = [
			JS_RUNTIME,
			kotlinRuntime(),
			result.js,
			`export const __instantiate = function (ctx) { __enter(ctx); return new ${result.className}(); };`
		].join('\n');
		const url = `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`;
		const loaded = (await import(/* @vite-ignore */ url)) as { __instantiate(ctx: unknown): any };
		expect(loaded.__instantiate(context()).image('a.jpg')).toBe(
			'https://cdn.example.invalid/a.jpg'
		);
	});
});

describe('a reference to a function a runtime global answers', () => {
	it('calls it, as the call form does', async () => {
		// `publishedAt?.let(Instant::parseOrNull)` in a DTO's `toSChapter`,
		// reached by `map(ChapterDto::toSChapter)`: refused and pruned, the
		// chapter list died at "not a function".
		const d = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun millis(at: String?): Long = at?.let(Instant::parseOrNull)?.toEpochMilliseconds() ?: 0L',
				'}'
			)
		);
		expect(d.millis('2021-05-17T09:30:15Z')).toBe(Date.UTC(2021, 4, 17, 9, 30, 15));
		expect(d.millis('not a date')).toBe(0);
		expect(d.millis(null)).toBe(0);
	});
});

describe('an interceptor whose recovery needs the WebView', () => {
	// A shared video-host extractor's `DdosGuardInterceptor`, cut to its shape: pass every
	// answer through unless it is a DDoS-Guard challenge, and only then go to
	// the WebView's cookie store. Refused whole, it refused every extension
	// that installs the extractor, although the tail only runs when a hoster
	// challenges. See `memberWithRecovery` in `emit.ts`.
	const source = kt(
		'class Guard(private val client: OkHttpClient) : Interceptor {',
		'    override fun intercept(chain: Interceptor.Chain): Response {',
		'        val originalRequest = chain.request()',
		'        val response = chain.proceed(originalRequest)',
		'',
		'        // Check if DDos-GUARD is on',
		'        if (response.code !in ERROR_CODES || response.header("Server") !in SERVER_CHECK) {',
		'            return response',
		'        }',
		'',
		'        response.close()',
		'        val cookies = CookieManager.getInstance().getCookie(originalRequest.url.toString())',
		'        return chain.proceed(originalRequest.newBuilder().addHeader("cookie", cookies).build())',
		'    }',
		'',
		'    companion object {',
		'        private val ERROR_CODES = listOf(403)',
		'        private val SERVER_CHECK = listOf("ddos-guard")',
		'    }',
		'}'
	);

	function chain(code: number, server: string | null) {
		const answer = {
			code,
			header: (name: string) => (name.toLowerCase() === 'server' ? server : null),
			close: () => undefined
		};
		const proceeded: unknown[] = [];
		return {
			answer,
			proceeded,
			request: () => ({ url: 'https://hoster.invalid/e/1' }),
			proceed: async (request: unknown) => {
				proceeded.push(request);
				return answer;
			}
		};
	}

	it('translates the pass-through and reports the cut, not a refusal', () => {
		const emission = emitKotlin(parse(source));
		expect(emission.refusals).toEqual([]);
		expect(emission.translated).toContain('intercept');
		// Still named: the member is there, and so is what its tail needed.
		expect(emission.deferred.map((one) => one.member)).toEqual(['intercept']);
		expect(emission.deferred[0].obstacles.map((one) => one.kind)).toEqual([
			'the WebView cookie store'
		]);
		// The awaited answer is what the guard reads. Not awaited, every read
		// of it was `undefined` and every challenge passed as an answer.
		expect(emission.js).toContain('(await chain.proceed(originalRequest))');
	});

	it('hands back every answer the guard passes, exactly as the Kotlin does', async () => {
		const guard = await instantiate('Guard', source);
		for (const [code, server] of [
			[200, 'nginx'],
			[403, 'nginx'],
			[200, 'ddos-guard'],
			[404, null]
		] as const) {
			const link = chain(code, server);
			expect(await guard.intercept(link)).toBe(link.answer);
			expect(link.proceeded).toHaveLength(1);
		}
	});

	it('raises an error naming the boundary where the recovery would begin', async () => {
		const guard = await instantiate('Guard', source);
		const link = chain(403, 'ddos-guard');
		await expect(guard.intercept(link)).rejects.toThrow(
			/Guard got an answer it would only get past through the WebView's cookie store/
		);
		// Nothing after the guard ran: no second request went out.
		expect(link.proceeded).toHaveLength(1);
	});

	it('leaves a tail refused for an ordinary gap refused', () => {
		// The cut is for a boundary only. A tail that fails for a translator gap
		// is ours to fix, and a cut would hide it behind a runtime error.
		const emission = emitKotlin(
			parse(
				source.replace(
					'CookieManager.getInstance().getCookie(originalRequest.url.toString())',
					'Injekt.get<Loader>()'
				)
			)
		);
		expect(emission.refusals.map((one) => one.member)).toEqual(['intercept']);
		expect(emission.deferred).toEqual([]);
	});

	it('does not cut after a guard that decides which requests to handle', () => {
		// `return chain.proceed(…)` afresh, before any answer is read: there
		// the tail is the interceptor's purpose, not a recovery from an answer.
		const emission = emitKotlin(
			parse(
				kt(
					'class Gate : Interceptor {',
					'    override fun intercept(chain: Interceptor.Chain): Response {',
					'        val request = chain.request()',
					'        if (!request.url.host.contains("cdn")) return chain.proceed(request)',
					'        val cookies = CookieManager.getInstance().getCookie(request.url.toString())',
					'        return chain.proceed(request.newBuilder().addHeader("cookie", cookies).build())',
					'    }',
					'}'
				)
			)
		);
		expect(emission.refusals.map((one) => one.member)).toEqual(['intercept']);
		expect(emission.deferred).toEqual([]);
	});

	it('does not cut when the boundary is reached before the guard', () => {
		const emission = emitKotlin(
			parse(
				kt(
					'class Early : Interceptor {',
					'    override fun intercept(chain: Interceptor.Chain): Response {',
					'        val cookies = CookieManager.getInstance().getCookie("https://x.invalid")',
					'        val response = chain.proceed(chain.request())',
					'        if (response.code != 403) return response',
					'        return chain.proceed(chain.request())',
					'    }',
					'}'
				)
			)
		);
		expect(emission.refusals.map((one) => one.member)).toEqual(['intercept']);
		expect(emission.deferred).toEqual([]);
	});
});

describe('an extension property on the settings store', () => {
	// `private val SharedPreferences.quality get() = getString(KEY, DEFAULT)!!`,
	// read as `preferences.quality`. Emitted as the extension's own getter, it
	// read `getString` off the extension and the read went to the store, which
	// has no such field: every setting answered `undefined`, nothing refused.
	const source = kt(
		'class Demo {',
		'    private val preferences by getPreferencesLazy()',
		'    private val SharedPreferences.quality get() = getString(PREF_QUALITY_KEY, "1080p")!!',
		'    private val SharedPreferences.server: String',
		'        get() = getString(PREF_SERVER_KEY, "alpha")!!',
		'    private val SharedPreferences.ignorePreview',
		'        by preferences.delegate(PREF_PREVIEW_KEY, true)',
		'    private var SharedPreferences.markFiller',
		'        by LazyMutable { preferences.getBoolean(PREF_FILLER_KEY, false) }',
		'    fun settings() = listOf(preferences.quality, preferences.server, preferences.ignorePreview, preferences.markFiller)',
		'    fun label(video: Video) = video.quality',
		'    fun nested() = buildList { add(preferences.quality) }',
		'    companion object {',
		'        private const val PREF_QUALITY_KEY = "quality"',
		'        private const val PREF_SERVER_KEY = "server"',
		'        private const val PREF_PREVIEW_KEY = "preview"',
		'        private const val PREF_FILLER_KEY = "filler"',
		'    }',
		'}'
	);

	it('reads each through the store, with the defaults its declaration gives', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.settings()).toEqual(['1080p', 'alpha', true, false]);
		// A field of the same name on another object is still that object's.
		expect(demo.label({ quality: '720p' })).toBe('720p');
		expect(demo.nested()).toEqual(['1080p']);
	});

	it('refuses what it cannot read rather than reading it off the wrong object', () => {
		const refused = (...lines: string[]) =>
			refusalNames(
				kt(
					'class Demo {',
					'    private val preferences by getPreferencesLazy()',
					'    private val SharedPreferences.quality get() = getString("q", "1080p")!!',
					...lines,
					'}'
				)
			);
		// A write: there is no setter to call, and a field on the store is read
		// back by nothing.
		expect(refused('    fun set(v: String) { preferences.quality = v }')).toContain(
			'a write to extension property `quality`'
		);
		// A bare read through an implicit receiver this build does not track.
		expect(refused('    fun read() = with(preferences) { quality }')).toContain(
			'a bare read of extension property `quality`'
		);
	});

	it('writes through a setter, and `+=` as a read, a plus and a write', async () => {
		// OlympusScanlation's shape: a cached map behind the store, replaced
		// wholesale — `slugMap += more` on a read-only Map is `slugMap =
		// slugMap + more`, through both accessors.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private val preference by getPreferencesLazy()',
				'    private var cache: List<String>? = null',
				'    private var SharedPreferences.seen: List<String>',
				'        get() = cache ?: emptyList()',
				'        set(value) {',
				'            cache = value',
				'        }',
				'    fun add(more: List<String>): List<String> {',
				'        preference.seen = listOf("a")',
				'        preference.seen += more',
				'        return preference.seen',
				'    }',
				'}'
			)
		);
		expect(demo.add(['b', 'c'])).toEqual(['a', 'b', 'c']);
	});
});

describe('stdlib calls that converted to the wrong thing, or not at all', () => {
	const source = kt(
		'import java.util.Base64',
		'class Demo {',
		'    private val json = Json { ignoreUnknownKeys = true }',
		'    fun find(text: String) = text.indexOf("english", ignoreCase = true)',
		'    fun findFrom(text: String) = text.indexOf("a", startIndex = 2)',
		'    fun next(year: Int) = year.inc()',
		'    fun counts(pairs: List<Pair<String, String>>) = pairs.groupingBy { it.second }.eachCount()',
		'    fun decoded(text: String) = String(Base64.getDecoder().decode(text))',
		'    fun encoded(text: String) = Base64.getEncoder().encodeToString(text.toByteArray())',
		'    fun urlSafe(text: String) = Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray())',
		'    fun variables() = json.encodeToString(buildJsonObject { put("page", 2) })',
		'    fun named(url: String) = Namer().name(url) { it.uppercase() }',
		'    fun missing(start: Int, end: Int) = start == -1 || end == -1',
		'    fun guard(y: Boolean, list: List<Int>) = y && !list.any { it > 1 } || list.isEmpty()',
		'    fun years(current: Int) = Array(current - 2022) { (current - it).toString() }',
		'    fun size(bits: Long): String {',
		'        var left = bits',
		'        val unit: CharacterIterator = StringCharacterIterator("kMGTPE")',
		'        while (left <= -999950 || left >= 999950) {',
		'            left /= 1000',
		'            unit.next()',
		'        }',
		'        return java.lang.String.format("%.0f%cb", left / 1000.0, unit.current())',
		'    }',
		'}',
		'class Namer {',
		'    fun name(url: String, prefix: String = "p:", gen: (String) -> String = { it }): String = prefix + gen(url)',
		'}'
	);

	it('answers each as Kotlin does', async () => {
		const demo = await instantiate('Demo', source);
		// JavaScript's indexOf has no third argument and would search
		// case-sensitively: -1.
		expect(demo.find('In English')).toBe(3);
		expect(demo.findFrom('aaa')).toBe(2);
		expect(demo.next(2025)).toBe(2026);
		expect([
			...demo.counts(
				[
					['a', 'x'],
					['b', 'y'],
					['c', 'x']
				].map(([first, second]) => ({ first, second }))
			)
		]).toEqual([
			['x', 2],
			['y', 1]
		]);
		expect(demo.decoded('aGVsbG8=')).toBe('hello');
		// java.util's basic encoder never wraps or ends in a newline, which
		// android's DEFAULT does.
		expect(demo.encoded('x'.repeat(80))).toBe(Buffer.from('x'.repeat(80)).toString('base64'));
		expect(demo.urlSafe('øÿ~')).toBe(Buffer.from('øÿ~').toString('base64url'));
		// The coder encodes the value, not itself.
		expect(JSON.parse(demo.variables())).toEqual({ page: 2 });
		// A trailing lambda to a declared method binds its LAST parameter; the
		// one skipped on the way keeps its default.
		expect(demo.named('u')).toBe('p:U');
		// A prefix operator after a binary one keeps to its own operand.
		expect(demo.missing(3, -1)).toBe(true);
		expect(demo.missing(3, 4)).toBe(false);
		expect(demo.guard(false, [])).toBe(true);
		expect(demo.guard(true, [5])).toBe(false);
		expect(demo.years(2025)).toEqual(['2025', '2024', '2023']);
		expect(demo.size(1500000)).toBe('2Mb');
	});
});

describe('a base class written through the object that holds it', () => {
	it('extends the nested class, as the imported bare spelling already did', async () => {
		// `class TypeFilter(name) : AnimeStreamFilters.QueryPartFilter(name, LIST)`
		// refused as "a base class this build has not": the qualified name was
		// looked up whole, and the nested class is hoisted under its bare one.
		const demo = await instantiate(
			'Demo',
			kt(
				'object Filters {',
				'    open class QueryPartFilter(val displayName: String, val vals: Array<Pair<String, String>>) {',
				'        fun toUriPart(at: Int) = vals[at].second',
				'    }',
				'}',
				'class TypeFilter(name: String) : Filters.QueryPartFilter(name, arrayOf("Movie" to "movie", "Series" to "tv"))',
				'class Demo {',
				'    fun part() = TypeFilter("Type").toUriPart(1)',
				'    fun label() = TypeFilter("Type").displayName',
				'}'
			)
		);
		expect(demo.part()).toBe('tv');
		expect(demo.label()).toBe('Type');
	});
});

describe('a helper class calling back into the source object it was handed', () => {
	// A multisrc template's shape: `class Extractor(private val theme: Theme)`,
	// built with `Extractor(this)`, calling `theme.displayName(…)`. The entry
	// class's methods are never passthroughs, so the call was refused as a
	// method nothing declares — while the method sat translated one file over.
	const THEME = kt(
		'abstract class Theme : AnimeHttpSource() {',
		"    open fun displayName(name: String): String = name.trimEnd('-', ' ')",
		'    suspend fun slow(name: String): String {',
		'        delay(1)',
		'        return name + "?"',
		'    }',
		'    fun viaOther(): String = Other().load()',
		'    fun label(name: String): String = Helper(this).label(name)',
		'    suspend fun late(name: String): String = Helper(this).late(name)',
		'    fun loud(): String = Helper(this).loud()',
		'}'
	);
	const HELPER = kt(
		'class Helper(private val theme: Theme) {',
		'    fun label(name: String): String = theme.displayName(name) + "!"',
		'    suspend fun late(name: String): String = theme.slow(name) + "!"',
		'    fun loud(): String = theme.viaOther() + "!"',
		'}',
		'class Other {',
		'    fun load(): String = client.get("https://example.invalid/x").body.string()',
		'}'
	);
	const ENTRY = kt(
		'class Demo : Theme() {',
		'    override fun displayName(name: String): String = "[" + super.displayName(name) + "]"',
		'}'
	);

	it('resolves the member on the declared type, and dispatches to the override', async () => {
		const demo = await instantiate('Demo', THEME, HELPER, ENTRY);
		expect(demo.label('one -')).toBe('[one]!');
	});

	it('awaits a member the source class declares `suspend`', async () => {
		const demo = await instantiate('Demo', THEME, HELPER, ENTRY);
		await expect(demo.late('two')).resolves.toBe('two?!');
	});

	it('fails loudly when the member turned out to be async after all', async () => {
		// `viaOther` is not `suspend` and reads as no request, so the survey
		// calls it plain; its emitter made it async for the request inside
		// `Other.load`. Handed on, the promise would have been "[object
		// Promise]!" — so the call throws, naming the member, instead.
		const demo = await instantiate('Demo', THEME, HELPER, ENTRY);
		expect(() => demo.loud()).toThrow(/Theme\.viaOther as a plain function/);
	});

	it('leaves a parameter that shadows the property alone', async () => {
		// Only the property read counts: a local named `theme` of some other
		// type is not the source object, and stays the refusal it was.
		const emission = emitKotlin(
			parse(
				kt(
					'abstract class Theme : AnimeHttpSource() {',
					'    fun displayName(name: String): String = name',
					'}',
					'class Helper(private val theme: Theme) {',
					'    fun label(theme: Any, name: String): String = theme.displayName(name)',
					'}'
				)
			)
		);
		expect(emission.refusals.flatMap((one) => one.obstacles.map((o) => o.kind))).toEqual([
			'`.displayName()`'
		]);
	});
});

describe('skip markers on a video', () => {
	it('builds TimeStamp values and carries them through a Video copy', async () => {
		// ext-lib 16's `TimeStamp(start, end, name, type)`. The ABI has no field
		// for them, so what matters is that building them is ordinary Kotlin:
		// numbers compared, a default type, a `copy(timestamps = …)`.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    fun marks(s: Int, e: Int): List<TimeStamp> = buildList {',
				'        if (e > s) add(TimeStamp(s.toDouble(), e.toDouble(), name = "Intro", type = ChapterType.Opening))',
				'        add(TimeStamp(90.0, 120.5, "Outro"))',
				'    }',
				'    fun video(s: Int, e: Int): Video =',
				'        Video("https://example.invalid/a.m3u8", "720p", "https://example.invalid/a.m3u8")',
				'            .copy(timestamps = marks(s, e))',
				'    fun parsed(t: String): Double = t.toDouble() + 1.toDouble()',
				'}'
			)
		);
		const [intro, outro] = demo.marks(0, 85);
		expect([intro.start, intro.end, intro.name, intro.type]).toEqual([0, 85, 'Intro', 'Opening']);
		expect([outro.start, outro.end, outro.type]).toEqual([90, 120.5, 'Other']);
		expect(demo.marks(5, 5)).toHaveLength(1);
		const video = demo.video(0, 85);
		expect(video.videoUrl).toBe('https://example.invalid/a.m3u8');
		expect(video.timestamps.map((one: { name: string }) => one.name)).toEqual(['Intro', 'Outro']);
		// `toDouble` was a passthrough onto a method no number or string has.
		expect(demo.parsed(' 2.5')).toBe(3.5);
		expect(() => demo.parsed('two')).toThrow(/as a number/);
	});
});

describe('a prefix increment', () => {
	it('increments before reading, over a local and over a property', async () => {
		// The grammar hangs `++` over the whole `++i > 3`, as it does `-` and
		// `!`; applied to the comparison it would not be JavaScript at all.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private var n = 0',
				'    fun loop(): Int {',
				'        var i = 0',
				'        while (true) { if (++i > 3) break }',
				'        return i',
				'    }',
				'    fun both(): Int { --n; return ++n + n }',
				'}'
			)
		);
		expect(demo.loop()).toBe(4);
		expect(demo.both()).toBe(0);
	});
});

describe('a bare call inside an object', () => {
	it('refuses a name the object does not declare, rather than calling it on `this`', () => {
		// A Kotlin `object` has no outer instance, so the "a base class supplies
		// it" fallback cannot apply. Written as `this.name(…)` it was undefined
		// at module scope — the bundle died at load — or a TypeError at the call.
		expect(
			refusalNames(
				kt(
					'object Serializer {',
					'    val descriptor = somethingUnread("X")',
					'    fun read(): Int = alsoUnread(2)',
					'}'
				)
			)
		).toEqual([
			'`somethingUnread(…)`, which nothing this build read declares',
			'`alsoUnread(…)`, which nothing this build read declares'
		]);
	});

	it('still calls its own members, and answers an empty sequence', async () => {
		// The shared unpacker's `if (!detect(s)) emptySequence() else …` —
		// which came out `this.emptySequence()` and threw on every plain script.
		const demo = await instantiate(
			'Demo',
			kt(
				'object ScriptPacker {',
				'    fun detect(s: String): Boolean = s.startsWith("eval")',
				'    fun unpack(s: String): Sequence<String> = if (!detect(s)) emptySequence() else sequenceOf(s)',
				'}',
				'class Demo {',
				'    fun plain(): List<String> = ScriptPacker.unpack("var a").toList()',
				'    fun packed(): List<String> = ScriptPacker.unpack("eval(x)").toList()',
				'}'
			)
		);
		expect(demo.plain()).toEqual([]);
		expect(demo.packed()).toEqual(['eval(x)']);
	});
});

describe('a reference to a member of a declared object', () => {
	it('is bound to the object, forwarding one argument to an overloaded name', async () => {
		// `hls.let(UrlUtils::fixUrl)`. The object is the receiver; with two
		// overloads, `(url)` and `(url, baseUrl)`, the index a collection
		// helper passes must not reach the second.
		const demo = await instantiate(
			'Demo',
			kt(
				'object Urls {',
				'    fun fix(url: String): String = if (url.startsWith("//")) "https:$url" else url',
				'    fun fix(url: String, base: String): String = base + url',
				'}',
				'class Demo {',
				'    fun one(u: String): String = u.let(Urls::fix)',
				'    fun many(us: List<String>): List<String> = us.map(Urls::fix)',
				'}'
			)
		);
		expect(demo.one('//a.example.invalid/x')).toBe('https://a.example.invalid/x');
		expect(demo.many(['//b.example.invalid', 'c'])).toEqual(['https://b.example.invalid', 'c']);
	});
});

describe('a write through a preference-delegated extension property', () => {
	it('lands on the delegate’s key, and the next read answers it', async () => {
		// `private var SharedPreferences.latestId by preferences.delegate(KEY,
		// 0)`, then `preferences.latestId = id` — refused as a write to an
		// extension property, while the delegate names the key to write.
		const demo = await instantiate(
			'Demo',
			kt(
				'class Demo {',
				'    private val preferences by getPreferencesLazy()',
				'    private var SharedPreferences.latestId by preferences.delegate(PREF_LATEST_KEY, 0)',
				'    fun bump(): Int {',
				'        val before = preferences.latestId',
				'        preferences.latestId = before + 3',
				'        return preferences.latestId * 10 + preferences.getInt(PREF_LATEST_KEY, -1)',
				'    }',
				'    companion object {',
				'        private const val PREF_LATEST_KEY = "latest_id"',
				'    }',
				'}'
			)
		);
		expect(demo.bump()).toBe(33);
	});
});

describe('java.math.BigDecimal', () => {
	const source = kt(
		'class Demo {',
		'    fun stars(score: String?): String {',
		'        if (score.isNullOrBlank()) return ""',
		'        return try {',
		'            val big = score.toBigDecimal()',
		'            if (big.signum() <= 0) return ""',
		'            val stars = big.divide(BigDecimal(2), 0, RoundingMode.HALF_UP).toInt().coerceIn(0, 5)',
		'            "★".repeat(stars) + "☆".repeat(5 - stars) + " " + big.stripTrailingZeros().toPlainString()',
		'        } catch (_: Exception) {',
		'            ""',
		'        }',
		'    }',
		'    fun half(t: String): String = t.toBigDecimal().div(BigDecimal(2)).toPlainString()',
		'    fun exact(t: String): String = BigDecimal(t).divide(BigDecimal("8")).toString()',
		'    fun scaled(t: String): String = t.toBigDecimal().setScale(1, RoundingMode.HALF_EVEN).toPlainString()',
		'    fun bigger(a: String, b: String): Boolean = a.toBigDecimal().compareTo(b.toBigDecimal()) > 0',
		'    fun raw(a: String, b: String) = a.toBigDecimal() / b.toBigDecimal()',
		'}'
	);

	it('divides, rounds and prints the way Java does, scale included', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.stars('8.40')).toBe('★★★★☆ 8.4');
		expect(demo.stars('9')).toBe('★★★★★ 9');
		expect(demo.stars('0')).toBe('');
		expect(demo.stars('n/a')).toBe('');
		// Kotlin's `div` is HALF_EVEN at the dividend's scale: 7/2 is 4, not 3.5.
		expect(demo.half('7')).toBe('4');
		expect(demo.half('7.0')).toBe('3.5');
		expect(demo.exact('1')).toBe('0.125');
		expect(demo.scaled('2.25')).toBe('2.2');
		expect(demo.bigger('2.50', '2.5')).toBe(false);
		expect(demo.bigger('2.51', '2.5')).toBe(true);
	});

	it('refuses to be read as a double by an operator, rather than dividing like one', async () => {
		const demo = await instantiate('Demo', source);
		expect(() => demo.raw('7', '2')).toThrow(/arithmetic operator on a BigDecimal/);
	});
});

describe('a request tag keyed by a class', () => {
	it('reads back what was set under the same class, and nothing under another', async () => {
		// `.tag(SearchParams::class.java, params)` in the request builder and
		// `response.request.tag(SearchParams::class.java)` in the parser — how a
		// source carries its filter state across without an instance field.
		const demo = await instantiate(
			'Demo',
			kt(
				'class SearchParams(val query: String = "")',
				'class Other(val x: Int = 0)',
				'class Demo {',
				'    fun build(q: String): Request = GET("https://example.invalid/s").newBuilder()',
				'        .tag(SearchParams::class.java, SearchParams(q))',
				'        .build()',
				'    fun query(r: Request): String = r.tag(SearchParams::class.java)?.query ?: "none"',
				'    fun other(r: Request): String = if (r.tag(Other::class.java) == null) "absent" else "present"',
				'}'
			)
		);
		const request = demo.build('one');
		expect(demo.query(request)).toBe('one');
		expect(demo.other(request)).toBe('absent');
	});
});
