/**
 * The two things that go wrong quietly in `subset.ts`, checked here.
 *
 * The first is drift: the emitter names a `__k` helper the runtime never
 * defines, and the failure surfaces as `__k.mapNotNul is not a function` inside
 * a sandbox, on somebody's phone, at the far end of a conversion. Nothing but a
 * shared list stops that, so the list is asserted rather than trusted.
 *
 * The second is the allowlist going stale. A grammar upgrade renames a node
 * kind, `SUPPORTED_KINDS` no longer contains it, and every member using it is
 * refused — or worse, a kind that used to be refused starts arriving under a
 * name the scanner does not recognise. Parsing a corpus of ordinary extension
 * code and asserting the kinds it produces catches both directions.
 *
 * Every fixture is Kotlin written for this test. `example.invalid` is reserved
 * by RFC 2606 so a test can hold a URL without naming anything (AGENTS.md
 * rule 9).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadKotlinGrammar, type KotlinParser } from './grammar';
import { RUNTIME_GLOBALS, RUNTIME_HELPERS } from './runtime-api';
import {
	describeRefusals,
	EXTENSION_METHODS,
	FREE_FUNCTIONS,
	GLOBAL_NAMES,
	HOST_METHODS,
	HOST_PROPERTY_METHODS,
	helpersAreDeclared,
	KNOWN_SIGNATURES,
	namedObstacle,
	referencedHelpers,
	scanObstacles,
	thrownHelper,
	unsupportedKinds
} from './subset';

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

describe('the runtime contract', () => {
	it('names only helpers the runtime promises to define', () => {
		const declared = new Set<string>(RUNTIME_HELPERS);
		const missing = referencedHelpers().filter((name) => !declared.has(name));

		expect(missing).toEqual([]);
		expect(helpersAreDeclared()).toBe(true);
	});

	it('keeps its copy of the global names in step with the runtime', () => {
		expect([...GLOBAL_NAMES].sort()).toEqual([...RUNTIME_GLOBALS].sort());
	});

	it('routes the string methods whose JavaScript namesakes behave differently', () => {
		// `replace` is the dangerous one: Kotlin replaces every occurrence and
		// JavaScript replaces the first, so a passthrough would be a wrong value
		// rather than an error.
		expect(EXTENSION_METHODS.get('replace')).toBe('replaceString');
		expect(EXTENSION_METHODS.get('substringAfter')).toBe('substringAfter');
		expect(EXTENSION_METHODS.get('contains')).toBe('contains');
	});

	it('routes generic utility members to runtime semantics', () => {
		expect(EXTENSION_METHODS.get('toByte')).toBe('toByte');
		expect(EXTENSION_METHODS.get('formatBytes')).toBe('formatBytes');
		expect(EXTENSION_METHODS.get('now')).toBe('now');
		expect(EXTENSION_METHODS.get('rateLimit')).toBe('rateLimit');
		expect(EXTENSION_METHODS.get('stop')).toBe('stop');
		expect(EXTENSION_METHODS.get('digitToIntOrNull')).toBe('digitToIntOrNull');
		expect(EXTENSION_METHODS.get('toJsonString')).toBe('toJsonString');
		expect(EXTENSION_METHODS.get('withLock')).toBe('withLock');
		expect(EXTENSION_METHODS.get('elementAt')).toBe('elementAt');
		expect(EXTENSION_METHODS.get('trimMargin')).toBe('trimMargin');
		expect(EXTENSION_METHODS.get('encodeToString')).toBe('encodeToString');
		expect(EXTENSION_METHODS.get('asUriPart')).toBe('asQueryPart');
		expect(EXTENSION_METHODS.get('head')).toBe('firstOrNull');
		expect(EXTENSION_METHODS.get('toLong')).toBe('toLong');
		expect(EXTENSION_METHODS.get('countLeadingZeroBits')).toBe('countLeadingZeroBits');
		expect(GLOBAL_NAMES.has('JsonObject')).toBe(true);
		expect(GLOBAL_NAMES.has('LruCache')).toBe(true);
		expect(GLOBAL_NAMES.has('ConnectionPool')).toBe(true);
		expect(GLOBAL_NAMES.has('Mutex')).toBe(true);
		expect(HOST_METHODS.has('parseToJsonElement')).toBe(true);
		expect(HOST_METHODS.has('hasNext')).toBe(true);
		expect(HOST_PROPERTY_METHODS.has('value')).toBe(true);
	});

	it('routes `String(…)` without declaring a bundle-scope `String`', () => {
		// Kotlin's `String(bytes)` DECODES; JavaScript's `String(bytes)` prints
		// their numbers. It has to be rewritten — but as a helper call, not as a
		// global: a `String` at bundle scope would shadow JavaScript's for the
		// whole runtime, and every `String(x)` inside it would start decoding.
		expect(FREE_FUNCTIONS.get('String')).toBe('stringOf');
		expect(GLOBAL_NAMES.has('String')).toBe(false);
	});

	it('keeps the ignoreCase family positional against a signature it knows', () => {
		// `header.equals("Content-Length", ignoreCase = true)`: without the
		// signature the named argument is refused, and with the wrong one the
		// boolean lands where the string belongs.
		expect(KNOWN_SIGNATURES.get('equals')).toEqual(['other', 'ignoreCase']);
		expect(KNOWN_SIGNATURES.get('extractFromHls')).toEqual([
			'playlistUrl',
			'referer',
			'masterHeaders',
			'videoHeaders',
			'videoNameGen',
			'subtitleList',
			'audioList'
		]);
		expect(KNOWN_SIGNATURES.get('extractFromDash')).toEqual([
			'mpdUrl',
			'videoNameGen',
			'mpdHeaders',
			'videoHeaders',
			'referer',
			'subtitleList',
			'audioList'
		]);
		expect(KNOWN_SIGNATURES.get('graphQLPost')).toEqual(['url', 'query', 'variables', 'headers']);
	});

	it('does not claim to know an extractor signature this ecosystem reuses', () => {
		// `videosFromUrl` and `videoFromUrl` were in this table, and both were
		// wrong: every one of the 37 extractor declarations puts `url` first,
		// and neither invented order did. `videosFromUrl(url, prefix = "…")`
		// therefore emitted `videosFromUrl('…')` — the url dropped into the slot
		// the table called `prefix` and then overwritten by the named argument,
		// so the prefix string was fetched as a url. It converted with no
		// refusal and no error.
		//
		// A name reused across incompatible parameter lists cannot be in a table
		// keyed by name alone. Where the declaration is in the file set it is
		// read from there; where it is not, the named argument is refused.
		expect(KNOWN_SIGNATURES.has('videosFromUrl')).toBe(false);
		expect(KNOWN_SIGNATURES.has('videoFromUrl')).toBe(false);
	});
});

describe('the node-kind allowlist', () => {
	it('keeps supported named infix and callable syntax in the subset', () => {
		const tree = parse(
			kt(
				'class Demo {',
				'    fun values(n: Int, target: MutableList<Int>, items: List<Int>) =',
				'        (n downTo 1).map { it and 3 }.also { target.forEach(::addAll) }',
				'}'
			)
		);

		expect(scanObstacles(tree.root, 'values')).toEqual([]);
	});

	it('covers every kind an ordinary extension produces', () => {
		const source = kt(
			'package com.example.demo',
			'',
			'import com.example.core.Source',
			'',
			'class Demo : Source("demo") {',
			'    override val name = "Demo"',
			'    override val baseUrl = "https://example.invalid"',
			'    private val cache by lazy { mutableListOf<String>() }',
			'',
			'    companion object {',
			'        const val PAGE = "page"',
			'    }',
			'',
			'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?$PAGE=$page", headers)',
			'',
			'    override fun animeDetailsParse(document: Document) = SAnime.create().apply {',
			'        title = document.selectFirst("h1")!!.text()',
			'        genre = document.select("a.tag").joinToString { it.text() }',
			'        status = when (document.selectFirst("span")?.text()?.trim()) {',
			'            "Ongoing" -> 1',
			'            else -> 0',
			'        }',
			'    }',
			'',
			'    override fun episodeListParse(response: Response): List<SEpisode> {',
			'        val doc = response.asJsoup()',
			'        val out = mutableListOf<SEpisode>()',
			'        for (element in doc.select("li a")) {',
			'            out.add(episodeFromElement(element))',
			'        }',
			'        return out.reversed()',
			'    }',
			'',
			'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
			'        val doc = client.newCall(GET(baseUrl + episode.url)).await().asJsoup()',
			'        return doc.select("source").mapNotNull { source ->',
			'            val url = source.attr("src")',
			'            if (url.isNotBlank()) Video(url, "default", url) else null',
			'        }',
			'    }',
			'}',
			'',
			'data class Item(val file: String, val label: String = "")',
			'',
			'enum class Kind { ALPHA, BETA }'
		);

		const tree = parse(source);

		expect(tree.hasError).toBe(false);
		expect(unsupportedKinds(tree.root)).toEqual([]);
	});

	it('names a kind it does not handle rather than skipping it', () => {
		const tree = parse(kt('class Demo {', '    val x = object : Callback {}', '}'));

		const obstacles = scanObstacles(tree.root, 'x');

		expect(obstacles.map((one) => one.kind)).toContain('an anonymous `object :` implementation');
	});

	it('stops descending at the first obstacle on a branch', () => {
		// Everything under a refused construct is a consequence, not a separate
		// problem, and listing all of it would bury the one that matters.
		const tree = parse(
			kt('class Demo {', '    val x = object : Callback { val y = object : Other {} }', '}')
		);

		expect(scanObstacles(tree.root, 'x')).toHaveLength(1);
	});

	it('refuses a subtree that only parsed because tree-sitter recovered', () => {
		const tree = parse(kt('class Demo {', '    fun broken() = "unterminated', '}'));

		const obstacles = scanObstacles(tree.root, 'broken');

		expect(obstacles.length).toBeGreaterThan(0);
		expect(obstacles[0].kind).toBe('a passage this build could not parse');
	});
});

describe('naming the obstacle rather than the category', () => {
	it.each([
		['Injekt.get<Application>()', 'Injekt.get'],
		['WebView(context)', 'WebView'],
		['Interceptor { chain -> chain.proceed(chain.request()) }', 'an okhttp Interceptor'],
		['Cipher.getInstance("AES")', 'javax.crypto'],
		['QuickJs.create()', 'an embedded JavaScript engine'],
		['Class.forName("x")', 'reflection'],
		['launch { load() }', 'launch {}'],
		['android.os.Build.VERSION', 'an android.* API'],
		['operator fun get(index: Int) = 1', 'a custom operator overload'],
		// The two halves of the cookie story that the host jar cannot honour.
		// `loadForRequest` hands a plugin the cookies the host holds, which
		// ADR-0005 §3 forbids outright; `CookieManager` is the WebView's store,
		// which this host has none of. Named here rather than left to the
		// passthrough allowlist because both had a way past it — a declared
		// method for the first, a capitalised receiver for the second.
		['loadForRequest(url)', 'reading a cookie jar'],
		['CookieManager.getInstance()', 'the WebView cookie store']
	])('names %s as %s', (text, expected) => {
		expect(namedObstacle(text)).toBe(expected);
	});

	it('no longer refuses installing or saving to a cookie jar', () => {
		// The host keeps a per-plugin, per-host, in-memory jar and attaches it
		// itself, so both of these are statements of intent it has already acted
		// on. Reading one back is still refused, above: that is the constraint
		// rather than an unimplemented half.
		expect(namedObstacle('cookieJar(jar)')).toBeNull();
		expect(namedObstacle('saveFromResponse(url, cookies)')).toBeNull();
	});

	it('no longer refuses the Android preference framework', () => {
		// It was an obstacle for as long as a converted bundle declared no
		// settings and the runtime had no preference types. It declares them
		// now (`foreign/preferences.ts`) and `KOTLIN_PREFS` supplies the four
		// types, so an extension that mentions one translates rather than being
		// refused — which is what `FOREIGN.md` §4.1.6 ranks as 31 extensions.
		expect(namedObstacle('ListPreference(screen.context)')).toBeNull();
		expect(namedObstacle('SharedPreferences')).toBeNull();
		expect(namedObstacle('SwitchPreferenceCompat(screen.context)')).toBeNull();
	});

	it('lets ordinary scraper code through', () => {
		expect(namedObstacle('document.select("div.card a[href]").map { it.text() }')).toBeNull();
	});
});

describe('what a `throw` becomes', () => {
	it('translates the exception half the catalogue uses to say "not used here"', () => {
		expect(thrownHelper('UnsupportedOperationException')).toBe('unsupported');
	});

	it('surfaces any other exception as a plugin error', () => {
		expect(thrownHelper('IllegalArgumentException')).toBe('error');
		expect(thrownHelper('IOException')).toBe('error');
	});

	it('refuses a thrown type it cannot construct', () => {
		expect(thrownHelper('MyCustomFailure')).toBeNull();
	});
});

describe('the refusal a person reads', () => {
	it('counts the obstacles, names them, and says what converting would cost', () => {
		const message = describeRefusals([
			{
				member: 'videoListParse',
				obstacles: [
					{
						kind: 'an anonymous `object :` implementation',
						line: 84,
						memberName: 'videoListParse'
					},
					{
						kind: '`.videosFromUrl()`',
						line: 88,
						memberName: 'videoListParse'
					}
				]
			},
			{
				member: 'episodeListParse',
				obstacles: [{ kind: 'Injekt.get', line: 41, memberName: 'episodeListParse' }]
			}
		]);

		expect(message).toContain('3 Kotlin constructs');
		expect(message).toContain('`videoListParse`');
		expect(message).toContain('line 84');
		expect(message).toContain('Injekt.get');
		expect(message).toContain('looks like it works and does not');
	});

	it('agrees with itself about one', () => {
		const message = describeRefusals([
			{
				member: 'x',
				obstacles: [{ kind: 'a `super.` call', line: 3, memberName: 'x' }]
			}
		]);

		expect(message).toContain('1 Kotlin construct Yorozo');
		expect(message).not.toContain('constructs');
	});

	it('says nothing when there is nothing to say', () => {
		expect(describeRefusals([])).toBe('');
	});
});
