/**
 * What the Kotlin reader can read, and — the half that matters — what it says
 * when it cannot.
 *
 * Every fixture in this file is Kotlin written for this test. Nothing here is
 * copied from a real extension, and no hostname in it resolves: `example.invalid`
 * is reserved by RFC 2606 precisely so a test can have a URL in it without
 * naming anything (AGENTS.md rule 9).
 *
 * The tests are weighted towards the awkward cases on purpose. Reading
 * `override val name = "X"` is not where a reader like this goes wrong; it goes
 * wrong on a string template that looks like a literal, a brace inside a
 * comment, or a `.trim()` hanging off the end of an expression it already
 * decided it understood.
 */

import { describe, expect, it } from 'vitest';

import { readKotlin } from './reader';

/** A fixture, one line per argument, so the line breaks are visible. */
function kt(...lines: string[]): string {
	return lines.join('\n');
}

describe('the file header', () => {
	it('reads the package, the imports and the class it declares', () => {
		const source = kt(
			'package com.example.plugins.demo',
			'',
			'import com.example.core.Theme',
			'import com.example.core.util.*',
			'import com.example.core.Model as Legacy',
			'',
			'class DemoSource : Theme("demo") {',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.packageName).toBe('com.example.plugins.demo');
		expect(read.imports).toEqual([
			'com.example.core.Theme',
			'com.example.core.util.*',
			'com.example.core.Model'
		]);
		expect(read.className).toBe('DemoSource');
		expect(read.superClass).toBe('Theme');
	});

	it('keeps the type arguments of a base class, nested ones included', () => {
		const source = kt(
			'class DemoSource : Theme<Map<String, List<Int>>>("demo", 3) {',
			'    override val lang = "en"',
			'}'
		);

		expect(readKotlin(source).superClass).toBe('Theme<Map<String, List<Int>>>');
	});

	it('prefers the specifier that is called over an interface listed first', () => {
		// Kotlin does not distinguish a superclass from an interface in this
		// list; only the constructor call does, and only the base class has one.
		const source = kt('class DemoSource : ConfigurableSource, Theme("demo") {', '}');

		expect(readKotlin(source).superClass).toBe('Theme');
	});

	it('falls back to the first specifier when nothing is called', () => {
		expect(readKotlin('class DemoSource : Theme, Configurable').superClass).toBe('Theme');
	});

	it('keeps a fully qualified base class qualified', () => {
		const source = 'class DemoSource : com.example.core.Theme<String>()';

		expect(readKotlin(source).superClass).toBe('com.example.core.Theme<String>');
	});

	it('sees through annotations on the class and on its members', () => {
		const source = kt(
			'@file:Suppress("unused")',
			'',
			'package com.example.plugins.demo',
			'',
			'@Serializable',
			'@Suppress("MemberVisibilityCanBePrivate")',
			'class DemoSource : Theme("demo") {',
			'    @SerialName("lang")',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.className).toBe('DemoSource');
		expect(read.stringConstants).toEqual({ lang: 'en' });
	});

	it('returns nulls and empty maps for a file with no declarations in it', () => {
		const read = readKotlin('// nothing here but this comment\n');

		expect(read).toEqual({
			packageName: null,
			className: null,
			superClass: null,
			stringConstants: {},
			intConstants: {},
			boolConstants: {},
			stringLists: {},
			unreadableOverrides: [],
			imports: []
		});
	});
});

describe('the four kinds of constant', () => {
	it('reads strings, ints and booleans off the class and its companion', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val name = "Example Source"',
			'    override val lang = "en"',
			'    override val supportsLatest = true',
			'    override val hasNsfw = false',
			'',
			'    companion object {',
			'        const val PAGE_SIZE = 24',
			'        const val MASK = 0x1F',
			'        const val BUDGET = 1_000',
			'        const val OFFSET = -5',
			'        const val LIMIT = 40L',
			'    }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({
			name: 'Example Source',
			lang: 'en'
		});
		expect(read.boolConstants).toEqual({
			supportsLatest: true,
			hasNsfw: false
		});
		expect(read.intConstants).toEqual({
			PAGE_SIZE: 24,
			MASK: 31,
			BUDGET: 1000,
			OFFSET: -5,
			LIMIT: 40
		});
		expect(read.unreadableOverrides).toEqual([]);
	});

	it('decodes escapes, and does not mistake an escaped dollar for a template', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val separator = "a\\tb\\nc"',
			'    override val quoted = "say \\"hi\\""',
			'    override val literalDollar = "costs \\$5 exactly"',
			'    override val unicode = "\\u00e9"',
			'}'
		);

		expect(readKotlin(source).stringConstants).toEqual({
			separator: 'a\tb\nc',
			quoted: 'say "hi"',
			literalDollar: 'costs $5 exactly',
			unicode: 'é'
		});
	});

	it('reads a dollar that cannot open a template as an ordinary character', () => {
		// Kotlin only starts a template when an identifier or `{` follows.
		const source = 'class DemoSource : Theme("demo") {\n    override val price = "costs $5"\n}';

		expect(readKotlin(source).stringConstants).toEqual({ price: 'costs $5' });
	});

	it('reads a getter whose whole body is a literal', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val name get() = "Example Source"',
			'    override val lang: String get() = "en"',
			'    override val pageSize: Int',
			'        get() = 24',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({
			name: 'Example Source',
			lang: 'en'
		});
		expect(read.intConstants).toEqual({ pageSize: 24 });
		expect(read.unreadableOverrides).toEqual([]);
	});

	it('joins a concatenation of literals and constants it has already resolved', () => {
		const source = kt(
			'private const val PREFIX = "/api"',
			'',
			'class DemoSource : Theme("demo") {',
			'    override val endpoint = PREFIX + "/v1" + "/list"',
			'}'
		);

		expect(readKotlin(source).stringConstants).toEqual({
			PREFIX: '/api',
			endpoint: '/api/v1/list'
		});
	});

	it('refuses a concatenation naming something it has not resolved', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val endpoint = BuildConfig.HOST + "/v1"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({});
		expect(read.unreadableOverrides).toEqual(['endpoint']);
	});

	it('refuses a number it cannot represent exactly rather than rounding it', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    const val HUGE = 92233720368547758071',
			'    const val RATIO = 1.5',
			'}'
		);

		const read = readKotlin(source);

		expect(read.intConstants).toEqual({});
		expect(read.unreadableOverrides).toEqual(['HUGE', 'RATIO']);
	});
});

describe('string lists', () => {
	it('reads listOf and arrayOf, with type arguments and a trailing comma', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val tags = listOf(',
			'        "action",',
			'        "comedy",',
			'    )',
			'    override val aliases = arrayOf<String>()',
			'    override val codes = setOf("a", "b")',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringLists).toEqual({
			tags: ['action', 'comedy'],
			aliases: [],
			codes: ['a', 'b']
		});
	});

	it('refuses a list with anything but strings in it', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val filters = listOf(GenreFilter(), SortFilter())',
			'    override val pages = listOf(1, 2, 3)',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringLists).toEqual({});
		expect(read.unreadableOverrides).toEqual(['filters', 'pages']);
	});

	it('refuses a list that is only the start of a longer expression', () => {
		// The dangerous version of this bug is the quiet one: reporting
		// `["a", "b"]` for a value that is really `["A", "B"]`.
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val tags = listOf("a", "b").map { it.uppercase() }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringLists).toEqual({});
		expect(read.unreadableOverrides).toEqual(['tags']);
	});
});

describe('string templates', () => {
	it('refuses a value with a template in it instead of emitting the text', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val name = "Example"',
			'    override val greeting = "Hello $name"',
			'    override val braced = "${name.uppercase()}!"',
			'    override val nested = "a ${ if (x) "{" else "}" } b"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ name: 'Example' });
		expect(read.unreadableOverrides).toEqual(['greeting', 'braced', 'nested']);
	});

	it('refuses a template inside a list element', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val paths = listOf("/list", "/list/$page")',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringLists).toEqual({});
		expect(read.unreadableOverrides).toEqual(['paths']);
	});
});

describe('raw strings', () => {
	it('reads one containing braces and quotes verbatim', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val selector = """div.card { a[href] } "quoted" """',
			'    override val lang = "en"',
			'}'
		);

		expect(readKotlin(source).stringConstants).toEqual({
			selector: 'div.card { a[href] } "quoted" ',
			lang: 'en'
		});
	});

	it('reads one spanning several lines, and keeps reading afterwards', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val blurb = """',
			'        line one',
			'        line two',
			'    """',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants.blurb).toBe('\n        line one\n        line two\n    ');
		expect(read.stringConstants.lang).toBe('en');
	});

	it('closes on the last three quotes of a longer run', () => {
		const source = 'class DemoSource : Theme("demo") {\n    override val q = """x""""\n}';

		expect(readKotlin(source).stringConstants).toEqual({ q: 'x"' });
	});

	it('refuses a raw string with a template, which has no escape to disable one', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val path = """/list/$page"""',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['path']);
	});
});

describe('comments and quoting', () => {
	it('ignores braces and quotes inside comments of every shape', () => {
		const source = kt(
			'// a line comment with a { brace and an unclosed "quote',
			'/* a block comment with } and /* a nested one { */ still a comment */',
			'/** KDoc: } "quotes" and a stray val notReal = "no" */',
			'class DemoSource : Theme("demo") {',
			'    override val lang = "en" // trailing } comment',
			'}'
		);

		const read = readKotlin(source);

		expect(read.className).toBe('DemoSource');
		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual([]);
	});

	it('does not let a brace inside a string open a block', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val pattern = "{ not a block }"',
			'    override val closer = "}"',
			'    override val lang = "en"',
			'}'
		);

		expect(readKotlin(source).stringConstants).toEqual({
			pattern: '{ not a block }',
			closer: '}',
			lang: 'en'
		});
	});

	it('reads backticked names and declarations separated by a semicolon', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    val `weird name` = "x"; val pageSize = 2',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ 'weird name': 'x', lang: 'en' });
		expect(read.intConstants).toEqual({ pageSize: 2 });
	});

	it('reads a character literal without losing the rest of the line', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			"    private val sep = '/'",
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['sep']);
	});
});

describe('everything it refuses, by name', () => {
	it('names a delegated property rather than dropping it', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    private val client by lazy { buildClient() }',
			'    private val prefs: SharedPreferences by injectLazy()',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['client', 'prefs']);
	});

	it('names every function, block-bodied or expression-bodied', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val lang = "en"',
			'',
			'    override fun popularRequest(page: Int): Request {',
			'        val path = "/popular/" + page',
			'        return get(path)',
			'    }',
			'',
			'    override fun latestSelector() = "div.item"',
			'',
			'    private fun List<String>.clean(): List<String> = map { it.trim() }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['popularRequest', 'latestSelector', 'clean']);
		// The `val path` inside the function body is not a member of the class
		// and must not leak into the constants.
		expect(read.stringConstants.path).toBeUndefined();
	});

	it('steps over a multi-line when body without reading anything out of it', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override fun qualityOf(label: String) = when (label) {',
			'        "hd" -> "1080p"',
			'        else -> "480p"',
			'    }',
			'',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['qualityOf']);
	});

	it('names an init block, a secondary constructor and a constructor property', () => {
		const source = kt(
			'class DemoSource(override val lang: String = "en") : Theme("demo") {',
			'    init {',
			'        register(this)',
			'    }',
			'',
			'    constructor() : this("en")',
			'',
			'    override val name = "Example"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ name: 'Example' });
		// `lang`'s default is not its value: whoever constructs the class decides.
		expect(read.unreadableOverrides).toEqual(['lang', 'init', 'constructor']);
	});

	it('names a property that has no initializer at all', () => {
		const source = kt(
			'abstract class DemoSource : Theme("demo") {',
			'    abstract val entryPoint: String',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.unreadableOverrides).toEqual(['entryPoint']);
		expect(read.stringConstants).toEqual({ lang: 'en' });
	});

	it('names a property whose literal is followed by a custom accessor', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override var baseUrl = "https://example.invalid"',
			"        get() = field.trimEnd('/')",
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['baseUrl']);
	});

	it('names a property whose initializer is a call it cannot evaluate', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val client = network.client.newBuilder()',
			'        .addInterceptor(RateLimit(3))',
			'        .build()',
			'    override val headers = Headers.Builder().add("Accept", "*/*").build()',
			'    override val trimmed = "  padded  ".trim()',
			'    override val lang = "en"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['client', 'headers', 'trimmed']);
	});

	it('names the second type in a file, and does not merge its members in', () => {
		const source = kt(
			'class DemoFactory : SourceFactory {',
			'    override fun createSources() = listOf(DemoSource())',
			'}',
			'',
			'class DemoSource : Theme("demo") {',
			'    override val lang = "ja"',
			'}',
			'',
			'enum class Quality { LOW, HIGH }',
			'',
			'interface Extractor {',
			'    fun extract(url: String): List<String>',
			'}'
		);

		const read = readKotlin(source);

		expect(read.className).toBe('DemoFactory');
		expect(read.superClass).toBe('SourceFactory');
		expect(read.stringConstants).toEqual({});
		expect(read.unreadableOverrides).toEqual([
			'createSources',
			'DemoSource',
			'Quality',
			'Extractor'
		]);
	});

	it('names a nested class inside the primary one', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val lang = "en"',
			'',
			'    private class Page(val index: Int) {',
			'        val url = "/page"',
			'    }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['Page']);
	});

	it('does not fall off the end of a type declaration with no body', () => {
		// The scan for a class body has to be bounded by the line, or an
		// interface with nothing in it swallows every declaration after it.
		const source = kt(
			'interface Marker',
			'',
			'class DemoSource : Theme("demo"), Marker {',
			'    override val lang = "en"',
			'}',
			'',
			'abstract class Paged<T> : Theme("demo") where T : Entry',
			'',
			'class Trailing : Theme("demo")'
		);

		const read = readKotlin(source);

		expect(read.className).toBe('DemoSource');
		expect(read.superClass).toBe('Theme');
		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toEqual(['Marker', 'Paged', 'Trailing']);
	});

	it('refuses a name declared twice rather than picking one of the two', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val name = "A"',
			'',
			'    companion object {',
			'        const val name = "B"',
			'    }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({});
		expect(read.unreadableOverrides).toEqual(['name']);
	});

	it('lists each refused name once, in the order it was first seen', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override fun setup() = Unit',
			'    override fun setup(flag: Boolean) = Unit',
			'    override val lang = "en"',
			'}'
		);

		expect(readKotlin(source).unreadableOverrides).toEqual(['setup']);
	});
});

describe('var, which is a starting value and not a constant', () => {
	it('reads one that is never assigned to again', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override var baseUrl = "https://example.invalid"',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({
			baseUrl: 'https://example.invalid'
		});
		expect(read.unreadableOverrides).toEqual([]);
	});

	it('refuses one that is assigned to elsewhere in the file', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override var baseUrl = "https://example.invalid"',
			'    override val lang = "en"',
			'',
			'    fun applyPreference() {',
			'        baseUrl = preferences.getString("host", baseUrl)',
			'    }',
			'}'
		);

		const read = readKotlin(source);

		expect(read.stringConstants).toEqual({ lang: 'en' });
		expect(read.unreadableOverrides).toContain('baseUrl');
	});

	it('refuses one assigned to through this', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override var baseUrl = "https://example.invalid"',
			'',
			'    fun reset() {',
			'        this.baseUrl = "https://other.example.invalid"',
			'    }',
			'}'
		);

		expect(readKotlin(source).unreadableOverrides).toContain('baseUrl');
	});

	it('does not mistake a named argument for an assignment', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override var baseUrl = "https://example.invalid"',
			'',
			'    fun copyOf() = config.copy(baseUrl = "https://example.invalid", retries = 2)',
			'}'
		);

		expect(readKotlin(source).stringConstants).toEqual({
			baseUrl: 'https://example.invalid'
		});
	});
});

describe('a whole thin extension, of the shape FOREIGN.md 4.1 describes', () => {
	const source = kt(
		'package com.example.plugins.demo',
		'',
		'import com.example.core.Theme',
		'import com.example.core.model.Episode',
		'',
		'/**',
		' * A generated theme subclass: constants, and one method that is not.',
		' */',
		'@Suppress("unused")',
		'class DemoSource : Theme<Episode>(',
		'    "Example Source",',
		'    "https://example.invalid",',
		'    "en",',
		') {',
		'    override val id = 4213',
		'    override val supportsLatest = true',
		'    override val isNsfw = false',
		'    override val dateFormat = "yyyy-MM-dd"',
		'    override val qualities = listOf("360p", "720p", "1080p")',
		'',
		'    // The one thing that is not declarative.',
		'    override fun videoListParse(response: Response): List<Video> {',
		'        return response.select("{source}").map { Video(it.attr("src")) }',
		'    }',
		'',
		'    companion object {',
		'        const val PREFIX = "id:"',
		'    }',
		'}'
	);

	it('reads the declarative half', () => {
		const read = readKotlin(source);

		expect(read.packageName).toBe('com.example.plugins.demo');
		expect(read.className).toBe('DemoSource');
		expect(read.superClass).toBe('Theme<Episode>');
		expect(read.stringConstants).toEqual({
			dateFormat: 'yyyy-MM-dd',
			PREFIX: 'id:'
		});
		expect(read.intConstants).toEqual({ id: 4213 });
		expect(read.boolConstants).toEqual({ supportsLatest: true, isNsfw: false });
		expect(read.stringLists).toEqual({ qualities: ['360p', '720p', '1080p'] });
	});

	it('reports the one method it cannot read, which is what makes the rest safe to use', () => {
		expect(readKotlin(source).unreadableOverrides).toEqual(['videoListParse']);
	});

	it('is stable: reading the same text twice gives the same answer', () => {
		expect(readKotlin(source)).toEqual(readKotlin(source));
	});
});

describe('input it was never promised', () => {
	it('does not throw on truncated Kotlin', () => {
		const source = kt(
			'class DemoSource : Theme("demo") {',
			'    override val lang = "en"',
			'    override fun parse(response: Response): List<Video> {',
			'        return listOf('
		);

		expect(() => readKotlin(source)).not.toThrow();
	});

	it('does not throw on an unterminated string', () => {
		expect(() => readKotlin('class A { val x = "unterminated')).not.toThrow();
	});

	it('does not throw on an unterminated block comment', () => {
		expect(() => readKotlin('/* forever')).not.toThrow();
	});

	it('does not throw on text that is not Kotlin at all', () => {
		const read = readKotlin('{ "json": true, "nested": { "a": [1, 2] } }');

		expect(read.className).toBeNull();
	});
});
