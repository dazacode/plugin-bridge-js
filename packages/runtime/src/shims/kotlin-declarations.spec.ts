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
