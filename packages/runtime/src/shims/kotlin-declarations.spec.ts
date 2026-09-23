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

	it('decodes bytes through `toString(charset)`, and still refuses a charset other than UTF-8', async () => {
		const demo = await instantiate('Demo', source);
		expect(demo.decoded('aGVsbG8=')).toBe('hello');
		expect(() => demo.latin('aGVsbG8=')).toThrow(/ISO-8859-1 charset/);
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
		// MayoTune's `@Contextual private val sdf = SimpleDateFormat(…)`: kotlinx
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
		// OneReader's `contentOrNull?.let(jsonInstance::parseToJsonElement)`,
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
