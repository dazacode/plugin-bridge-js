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
	// The Voe extractor's `DdosGuardInterceptor`, cut to its shape: pass every
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
