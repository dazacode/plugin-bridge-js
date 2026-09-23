/**
 * What the pipeline is allowed to claim, and when it must stop.
 *
 * The interesting assertions here are the negative ones. A converter that
 * over-claims is worse than one that refuses: `complete` must be false the
 * moment anything at all was refused, because the eight method families that
 * matter are not separable — an extension whose `videoListParse` is missing
 * installs, searches and plays nothing, and one whose `episodeListParse` is
 * missing installs, searches and shows the wrong episodes.
 *
 * The other half is that the cheap reader's answer survives a total failure.
 * `FOREIGN.md` §1 makes a browse-only listing a first-class outcome, so a
 * conversion that refuses everything still has to hand back `name`, `baseUrl`
 * and `lang` for the catalogue row.
 *
 * Fixtures are Kotlin written for this test; `example.invalid` is reserved by
 * RFC 2606 (AGENTS.md rule 9).
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { loadKotlinGrammar, type KotlinParser } from './grammar';
import { convertKotlin, readKotlinFast } from './pipeline';

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

let parser: KotlinParser;

beforeAll(async () => {
	parser = await loadKotlinGrammar(vendorWasm);
}, 60_000);

/** A fixture, one line per argument, so the line breaks are visible. */
function kt(...lines: string[]): string {
	return lines.join('\n');
}

const THIN = kt(
	'package com.example.demo',
	'',
	'class Demo : ParsedAnimeHttpSource() {',
	'    override val name = "Demo"',
	'    override val baseUrl = "https://example.invalid"',
	'    override val lang = "en"',
	'    override val supportsLatest = false',
	'',
	'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)',
	'}'
);

describe('the fast path', () => {
	it('reads the catalogue row without loading a grammar', () => {
		const read = readKotlinFast(THIN);

		expect(read.className).toBe('Demo');
		expect(read.superClass).toBe('ParsedAnimeHttpSource');
		expect(read.stringConstants['baseUrl']).toBe('https://example.invalid');
		expect(read.stringConstants['lang']).toBe('en');
	});
});

describe('a conversion that succeeds', () => {
	it('reports the class, the members, the helpers and nothing refused', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: THIN }], {
			parser
		});

		expect(result.className).toBe('Demo');
		expect(result.superClass).toBe('ParsedAnimeHttpSource');
		expect(result.translated).toContain('popularAnimeRequest');
		expect(result.refusals).toEqual([]);
		expect(result.complete).toBe(true);
		expect(result.message).toBeNull();
		expect(result.js).toContain('class Demo');
	});

	it('carries the reader constants alongside the translation', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: THIN }], {
			parser
		});

		expect(result.constants.stringConstants['name']).toBe('Demo');
		expect(result.constants.stringConstants['baseUrl']).toBe('https://example.invalid');
	});

	it('translates the files after the entry into the same module', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt('class Demo : Source() {', '    fun wrap(file: String) = Item(file)', '}')
				},
				{ path: 'Dto.kt', source: 'data class Item(val file: String)' }
			],
			{ parser }
		);

		expect(result.className).toBe('Demo');
		expect(result.js).toContain('function Item');
		expect(result.perFile.map((one) => one.path)).toEqual(['Demo.kt', 'Dto.kt']);
	});

	it('converts a member whose `return` leaves the block it was written in', async () => {
		// The largest single obstacle in the measured catalogue: `forEach`, `let`
		// and `use` are inlined by Kotlin, so a bare `return` inside one returns
		// from the *member*. Emitted as callbacks they returned from the callback
		// instead, and the whole member was refused rather than mistranslated.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    override fun episodeListParse(response: Response): List<SEpisode> {',
						'        response.asJsoup().select("li").forEach {',
						'            if (it.text() == "stop") return emptyList()',
						'        }',
						'        return emptyList()',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.complete).toBe(true);
		expect(result.abiMembers).toContain('episodeListParse');
		// A `for…of`, not a callback: the difference is whether the `return`
		// belongs to `episodeListParse` or to something the runtime calls.
		expect(result.js).toContain('for (const');
	});

	it('declares a base class above the class extending it, however the file was written', async () => {
		// Kotlin puts the shared `open class UriPartFilter` at the bottom of the
		// file and the filters using it above. In JavaScript that order throws
		// while the module is evaluating, which takes the bundle down at load.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    fun part(): String = GenreFilter().toUriPart()',
						'    private class GenreFilter : UriPartFilter(arrayOf("Action" to "action"))',
						'    private open class UriPartFilter(val vals: Array<Pair<String, String>>) {',
						'        fun toUriPart(): String = vals[0].second',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.js.indexOf('class UriPartFilter')).toBeLessThan(
			result.js.indexOf('class GenreFilter')
		);
	});
});

describe('a file that declares a name the runtime already defines', () => {
	// The shape one extension in the catalogue actually has: a DTO file with its
	// own `Video`, and an entry file that imports the framework's and builds one
	// to return a stream. Both were emitted as `function Video` into one module
	// scope, which is a SyntaxError in an ES module — the conversion loaded with
	// "Identifier 'Video' has already been declared" and nothing else.
	const ENTRY = kt(
		'package com.example.demo',
		'',
		'import com.example.demo.dto.Meta',
		'import eu.kanade.tachiyomi.animesource.model.Video',
		'',
		'class Demo : ParsedAnimeHttpSource() {',
		'    override val name = "Demo"',
		'    override val baseUrl = "https://example.invalid"',
		'    override val lang = "en"',
		'',
		'    fun stream(url: String): List<Video> = listOf(Video(url, "default", url))',
		'}'
	);
	const DTO = kt(
		'package com.example.demo.dto',
		'',
		'data class Video(val id: String, val title: String)',
		'',
		'data class Meta(val videos: List<Video>)'
	);

	it('writes the declaration out under a name of its own', async () => {
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: ENTRY },
				{ path: 'Dto.kt', source: DTO }
			],
			{ parser }
		);

		expect(result.complete).toBe(true);
		expect(result.js).toContain('function Video_(');
		expect(result.js).not.toContain('function Video(');
	});

	it('leaves the file that imported the framework one meaning the framework one', async () => {
		// The half that matters more: shadowing the runtime for the whole module
		// would compile and then return a DTO where the host expects a video.
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: ENTRY },
				{ path: 'Dto.kt', source: DTO }
			],
			{ parser }
		);

		const entry = result.perFile.find((one) => one.path === 'Demo.kt');
		expect(entry?.js).toContain('Video(url,');
		expect(entry?.js).not.toContain('Video_(');
	});

	it('renames the references in the file that declared it, and in its package', async () => {
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: ENTRY },
				{ path: 'Dto.kt', source: DTO },
				{
					path: 'More.kt',
					source: kt('package com.example.demo.dto', '', 'data class Chunk(val first: Video)')
				}
			],
			{ parser }
		);

		// `Meta` names `Video` from the same package, and `Chunk` from another
		// file in that package: both mean the DTO, and neither is written out
		// as the runtime's.
		//
		// `Chunk` is deliberately a name the runtime does **not** define — it
		// used to be `Page`, which stopped being one the day the manga types
		// landed. The contrast is the point of the test: a declared name that
		// collides with the runtime is renamed, one that does not is left
		// alone, and a fixture that quietly became a collision would only
		// assert the first half twice.
		const dto = result.perFile.find((one) => one.path === 'Dto.kt');
		const more = result.perFile.find((one) => one.path === 'More.kt');
		expect(dto?.js).toContain('function Video_(');
		expect(more?.js).toContain('function Chunk(');
		expect(result.complete).toBe(true);
	});

	it("keeps two libraries' same-named file-private constants apart", async () => {
		// `private` in Kotlin is scoped to the *file*, so two extractor libraries
		// each declaring `private const val PACKED_CALL` is ordinary code. Both
		// land in one ES module, and before this that module was
		// "Cannot declare a const variable twice" — a SyntaxError before a line
		// of it ran. It converted with no refusals, packaged, installed, and
		// failed at load with a message about JavaScript rather than about
		// itself, which is the failure this whole file exists to prevent.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun build(): String = HostA().go() + HostB().go()',
						'}'
					)
				},
				{
					path: 'lib/HostA.kt',
					source: kt(
						'package eu.kanade.tachiyomi.lib.hosta',
						'',
						'private const val PACKED_CALL = "hosta"',
						'',
						'class HostA { fun go(): String = PACKED_CALL }'
					)
				},
				{
					path: 'lib/HostB.kt',
					source: kt(
						'package eu.kanade.tachiyomi.lib.hostb',
						'',
						'private const val PACKED_CALL = "hostb"',
						'',
						'class HostB { fun go(): String = PACKED_CALL }'
					)
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(true);
		// The module has to *parse*, which is the assertion that would have
		// caught this: every other check passed while it did not.
		expect(() => new Function(result.js)).not.toThrow();
		// And each library still reads its own table rather than the other's.
		expect(result.js).toContain("'hosta'");
		expect(result.js).toContain("'hostb'");
	});

	it('calls an extension function its base class declares next door', async () => {
		// `protected open fun Element.getImageUrl()` on a multisrc theme, called
		// as `element.getImageUrl()` from the extension that extends it.
		// Extension functions are deliberately kept out of `methods` — they take
		// their receiver as the first argument, so they are not passthrough
		// methods — and nothing else carried them across a file, so the call was
		// refused as a method no declaration in reach defines.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Theme() {',
						'    fun go(element: Element): String? = element.getImageUrl()',
						'}'
					)
				},
				{
					path: 'Theme.kt',
					source: kt(
						'open class Theme {',
						'    protected open fun Element.getImageUrl(): String? = attr("abs:src")',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(true);
		// Through the prototype chain the `extends` already set up, which is
		// also why an override in the subclass keeps winning.
		expect(result.js).toContain('getImageUrl(__recv)');
	});

	it('reads a named argument against the signature of the class it is calling', async () => {
		// `videosFromUrl` is declared 37 times across this ecosystem over
		// incompatible parameter lists, so the bare name is ambiguous by
		// construction and is dropped the moment two files disagree — which is
		// exactly when a named argument needs it. Keyed by the declaring class
		// it is an exact fact, and the receiver here is a property whose
		// initialiser names that class.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    private val hostB by lazy { HostB(client) }',
						'    fun go(url: String, doc: Document): String =',
						'        hostB.videoFromUrl(url, referer = doc.location())',
						'}'
					)
				},
				{
					path: 'lib/HostB.kt',
					source: kt(
						'class HostB(private val client: OkHttpClient) {',
						'    fun videoFromUrl(url: String, lang: String = "", prefix: String = "", referer: String = ""): String = url',
						'}'
					)
				},
				{
					// A second, incompatible declaration of the same name — which
					// is what makes the bare-name entry useless.
					path: 'lib/HostA.kt',
					source: kt(
						'class HostA(private val client: OkHttpClient) {',
						'    fun videoFromUrl(prefix: String, url: String): String = url',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(true);
		// `referer` is the fourth parameter, and the url stays first.
		expect(result.js).toContain('videoFromUrl(url, undefined, undefined, doc.location())');
	});

	it('falls back to the bare signature when the qualified one cannot explain the call', async () => {
		// Resolving the receiver's class is a heuristic, and a wrong answer must
		// not cost a conversion. An argument passed BY NAME is a parameter of the
		// callee, so a signature that does not have it belongs to some other
		// class that happens to share the method name — and the bare-name
		// signature is then the better answer rather than a refusal.
		//
		// Measured: gating this wrongly refused an extension that had been
		// converting, because a same-named method on an unrelated class won.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    private val utils by lazy { Utils(client) }',
						'    fun go(url: String, headers: Headers): String =',
						'        utils.extract(url, tag = "x")',
						'}'
					)
				},
				{
					// The receiver resolves to this class, and it does NOT take a
					// `tag` — so this signature cannot be the one being called.
					path: 'lib/Utils.kt',
					source: kt(
						'class Utils(private val client: OkHttpClient) {',
						'    fun other(url: String): String = url',
						'}'
					)
				},
				{
					path: 'lib/Real.kt',
					source: kt(
						'class Real {',
						'    fun extract(url: String, tag: String = ""): String = url + tag',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(true);
		expect(result.js).toContain("extract(url, 'x')");
	});

	it('reads `Dto::method` as the unbound reference Kotlin means', async () => {
		// `parsed.data.map(PopularAnimeDto::toSAnime)` is how this ecosystem maps
		// a list of DTOs. Kotlin's unbound reference makes the argument the
		// receiver, and there was no implementation of that at all: the bound
		// branch is skipped because a declared type is deliberately not a value
		// name, so it fell through to the fallbacks and refused.
		const dto = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun go(rows: List<Dto>): List<SAnime> = rows.map(Dto::toSAnime)',
						'}'
					)
				},
				{
					path: 'Dto.kt',
					source: kt(
						'data class Dto(val title: String) {',
						'    fun toSAnime(): SAnime = SAnime.create()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(dto.complete).toBe(true);
		expect(dto.js).toContain('(__recv, ...__a) => __recv.toSAnime(...__a)');
	});

	it('reads `Obj::method` as bound, where the object is already the receiver', async () => {
		// For an `object`, Kotlin's `Obj::member` is the BOUND form. Reading it
		// as unbound would consume the first argument as a receiver and drop it
		// silently — which is worse than the refusal it replaced. It is now the
		// bound call, the argument passed on and the object as the receiver.
		const object = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun go(s: String): String = s.let(Obj::wrap)',
						'}'
					)
				},
				{
					path: 'Obj.kt',
					source: kt('object Obj {', '    fun wrap(value: String): String = value', '}')
				}
			],
			{ parser }
		);

		expect(object.complete).toBe(true);
		expect(object.js).toContain('(__a) => Obj.wrap(__a)');
		expect(object.js).not.toContain('__recv.wrap');
	});

	it('does not borrow a same-named extension from an unrelated class', async () => {
		// Two classes may each declare `fun Element.getInfo()`. Emitting
		// `__self.getInfo(x)` for the wrong one is a TypeError in the sandbox,
		// so the name alone is never enough — it is checked against the class
		// the call is actually inside.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun go(element: Element): String? = element.getImageUrl()',
						'}'
					)
				},
				{
					path: 'Other.kt',
					source: kt(
						'class Other {',
						'    fun Element.getImageUrl(): String? = attr("data-x")',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(false);
	});

	it('leaves a name nobody redeclares alone', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: ENTRY }], {
			parser
		});

		expect(result.js).toContain('Video(url,');
		expect(result.js).not.toContain('Video_');
	});
});

describe('a file-scope declaration in the file next door', () => {
	// The shape a shared unpacker has: the extension calls `unpack(script)` and
	// the function lives in a module beside it. Only *types* crossed the file
	// boundary, so the call fell through to the "a bare lowercase name is a
	// member the base class supplies" fallback and came out as
	// `this.unpack(…)` — a conversion that reported complete, packaged,
	// installed, and died at the first call.
	const ENTRY = kt(
		'package com.example.demo',
		'',
		'class Demo : ParsedAnimeHttpSource() {',
		'    override val name = "Demo"',
		'    override val baseUrl = "https://example.invalid"',
		'    override val lang = "en"',
		'    override val supportsLatest = false',
		'',
		'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/$page", headers)',
		'',
		'    override fun videoListParse(response: Response): List<Video> {',
		'        val plain = unpack(response.body.string())',
		'        return listOf(Video(plain, ALPHABET, plain))',
		'    }',
		'}'
	);
	const LIB = kt(
		'package com.example.demo.lib',
		'',
		'const val ALPHABET = "0123456789"',
		'',
		'fun unpack(source: String): String = source',
		'',
		'suspend fun fetchBody(url: String): String = url'
	);

	it('calls it as the module function it is, not as a member of the source', async () => {
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: ENTRY },
				{ path: 'Unpacker.kt', source: LIB }
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.js).toContain('unpack(');
		expect(result.js).not.toContain('this.unpack(');
		// A capitalised one was refused rather than mis-emitted, which at least
		// said so — but it was refused for a name that is in scope.
		expect(result.js).not.toContain('this.ALPHABET');
	});

	it('calls a `val … get()` next door, rather than reading the function itself', async () => {
		// The shape a shared filter file has: `val FILTERS: AnimeFilterList
		// get() = AnimeFilterList(…)`, read by `getFilterList()` in the file
		// next door. The getter is a function here, so a read of the name that
		// stayed a bare name handed the host the function and every search went
		// out with no filters on it.
		const caller = kt(
			'package com.example.demo',
			'',
			'class Demo : ParsedAnimeHttpSource() {',
			'    override val name = "Demo"',
			'    override val baseUrl = "https://example.invalid"',
			'    override val lang = "en"',
			'    override val supportsLatest = false',
			'',
			'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/$page", headers)',
			'',
			'    override fun getFilterList() = FILTERS',
			'}'
		);
		const filters = kt(
			'package com.example.demo.filters',
			'',
			'val FILTERS: List<String> get() = listOf("sort", "year")'
		);

		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: caller },
				{ path: 'Filters.kt', source: filters }
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.js).toContain('return FILTERS();');
	});

	it('awaits a file-scope `suspend fun`, whose call site says nothing', async () => {
		// Kotlin's `suspend` is invisible at the call site and a promise is not:
		// `val body = fetchBody(url)` assigned the promise itself, and what
		// reached the player was `[object Promise]`.
		const caller = kt(
			'package com.example.demo',
			'',
			'class Demo : ParsedAnimeHttpSource() {',
			'    override val name = "Demo"',
			'    override val baseUrl = "https://example.invalid"',
			'    override val lang = "en"',
			'    override val supportsLatest = false',
			'',
			'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/$page", headers)',
			'',
			'    override suspend fun getVideoList(episode: SEpisode): List<Video> {',
			'        val body = fetchBody("$baseUrl/x")',
			'        return listOf(Video(body, "default", body))',
			'    }',
			'}'
		);

		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: caller },
				{ path: 'Unpacker.kt', source: LIB }
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.js).toContain('await fetchBody(');
	});
});

describe('Kotlin the vendored grammar cannot read, repaired before it is parsed', () => {
	it('assigns through a call result, in the branch it was written in', async () => {
		// `episodes.first().name = "x"` is an ERROR in this grammar, and the
		// recovery loses the brace nesting — which is why it arrived at the
		// scoreboard as a whole file refusing rather than as one member. The
		// repair parenthesises the receiver; a statement that now *opens* with
		// `(` would otherwise read as a call of the previous statement, so the
		// second and third of these are the cases that need a `;` in front.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    fun label(episodes: List<SEpisode>, isMovie: Boolean): List<SEpisode> {',
						'        if (isMovie && episodes.size == 1) {',
						'            episodes.first().name = "Movie"',
						'        }',
						'        log("done")',
						'        episodes.last().episode_number = 2F',
						'        return episodes',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking).toEqual([]);
		expect(conversion.js).toMatch(
			/if \(.*isMovie.*\) \{\s*\(__k\.first\(episodes\)\)\.name = 'Movie';/
		);
		expect(conversion.js).toContain('(__k.last(episodes)).episode_number = 2;');
	});

	it('puts back an assignment the parser recovered into an `if`', async () => {
		// An unbraced branch — `if (m) episodes.first().name = "x"` — parses as
		// `(if …) = "x"`, because the assignable rule does not reach over a call.
		// Emitting *that* produced an immediately-invoked function on the left of
		// an `=`: a JavaScript syntax error, in a bundle that reported nothing
		// refused and so took every other member down with it at load.
		//
		// **This test used to assert the refusal**, which was the right answer
		// while the alternative was broken output. It is not the only honest
		// answer: the association is recoverable, because the target is the
		// branch body and the assignment belongs inside the `if`. Put back where
		// it was written it is an ordinary conditional write, and the reason to
		// bother is that the line is in `MangaThemesia` — a template with 112
		// instances in one catalogue, every one of which refused for it.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    fun label(episodes: List<SEpisode>, isMovie: Boolean) {',
						'        if (isMovie)',
						'            episodes.first().name = "Movie"',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking).toEqual([]);
		// The write is *inside* the branch, which is the whole point: emitted
		// outside it, the name would be set unconditionally.
		expect(conversion.js).toMatch(
			/if \(.*isMovie.*\) \{\s*__k\.first\(episodes\)\.name = 'Movie';/
		);
	});

	it('still refuses the recovered shapes it cannot re-associate', async () => {
		// Three of them, each needing machinery the re-association skips.
		// `if (c) a = x else b = y` is the one that matters: two writes share one
		// value and the grammar gives no honest way to say which branch the
		// parser kept, so guessing would write to the wrong one silently.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    fun label(a: List<SEpisode>, b: List<SEpisode>, m: Boolean) {',
						'        if (m)',
						'            a.first().name = "One"',
						'        else',
						'            b.first().name = "Two"',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		// Refused, whatever it is named: the point is that nothing is emitted
		// for it, not which sentence says so.
		expect(conversion.blocking).not.toEqual([]);
		expect(conversion.js).not.toContain("= 'Two';");
	});

	it('calls a translated superclass through real `super`, and the driver through `__super`', async () => {
		// A multisrc template is a class this build emits and the extension
		// really `extends`, so `super.chapterFromElement()` there is ordinary
		// JavaScript meaning the template's method. Emitting `__super.` instead
		// reached past the template to the driver's base class, which has never
		// heard of it — and the call was refused by name, taking the extension
		// with it. `MangaThemesia` has 112 instances in one catalogue.
		//
		// The discrimination is the point, so both halves are asserted: a member
		// the template declares goes through `super`, and one only the driver
		// has still goes through `__super`.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Theme() {',
						'    override fun chapterFromElement(element: Element): SEpisode {',
						'        val base = super.chapterFromElement(element)',
						'        return base',
						'    }',
						'    fun head() = super.headersBuilder()',
						'}'
					)
				},
				{
					path: 'theme/Theme.kt',
					source: kt(
						'abstract class Theme : ParsedAnimeHttpSource() {',
						'    open fun chapterFromElement(element: Element): SEpisode = SEpisode.create()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking).toEqual([]);
		expect(conversion.js).toContain('class Demo extends Theme');
		// The template's own member: real `super`.
		expect(conversion.js).toMatch(/super\.chapterFromElement\(/);
		expect(conversion.js).not.toMatch(/__super\.chapterFromElement\(/);
		// The driver's: still `__super`, because the template does not declare it.
		expect(conversion.js).toMatch(/__super\.headersBuilder\(/);
	});

	it('interpolates a multi-dollar string where Kotlin 2.1 says it does', async () => {
		// The whole point of the feature is that a single `$` is *text*. A rewrite
		// that got this backwards would send a GraphQL document with its variables
		// substituted away — a wrong request rather than a refusal, which is the
		// class of bug a scoreboard of refusals cannot show.
		const dollar = '$';
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						`    fun body(id: String) = ${dollar}${dollar}"{\\"q\\":\\"get(${dollar}select)\\",\\"id\\":\\"${dollar}${dollar}id\\"}"`,
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking).toEqual([]);
		// `$select` was literal text; `$$id` was the interpolation.
		expect(conversion.js).toContain('get($select)');
		expect(conversion.js).toContain('${id}');
	});
});

describe('a conversion that refuses', () => {
	const PARTIAL = kt(
		'class Demo : ParsedAnimeHttpSource() {',
		'    override val name = "Demo"',
		'    override val baseUrl = "https://example.invalid"',
		'    override val lang = "en"',
		'',
		'    override fun popularAnimeRequest(page: Int) = GET("$baseUrl/hot?page=$page", headers)',
		'',
		'    override fun videoListParse(response: Response): List<Video> {',
		'        val loader = Injekt.get<Loader>()',
		'        return emptyList()',
		'    }',
		'}'
	);

	it('never calls a partial translation complete', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: PARTIAL }], {
			parser
		});

		expect(result.translated).toContain('popularAnimeRequest');
		expect(result.refusals.map((one) => one.member)).toEqual(['videoListParse']);
		expect(result.complete).toBe(false);
	});

	it('names the obstacle and the member in the sentence a person reads', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: PARTIAL }], {
			parser
		});

		expect(result.message).toContain('videoListParse');
		expect(result.message).toContain('Injekt.get');
		expect(result.message).toContain('looks like it works and does not');
	});

	it('still hands back the constants a browse-only listing needs', async () => {
		const result = await convertKotlin([{ path: 'Demo.kt', source: PARTIAL }], {
			parser
		});

		expect(result.constants.stringConstants['baseUrl']).toBe('https://example.invalid');
		expect(result.constants.stringConstants['lang']).toBe('en');
	});

	it('stops the whole conversion when a class header did not parse', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt('class Demo : Source<<< {', '    val x = 1', '}')
				}
			],
			{ parser }
		);

		expect(result.js).toBe('');
		expect(result.complete).toBe(false);
		expect(result.message).toContain('did not parse');
	});

	it('refuses a member that reaches past what the base class offers', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt('class Demo : Source() {', '    override fun setup() = super.setup()', '}')
				}
			],
			{ parser }
		);

		expect(result.complete).toBe(false);
		expect(result.message).toContain('`super.setup()`');
	});

	it('says so when there is nothing to translate', async () => {
		const result = await convertKotlin([], { parser });

		expect(result.complete).toBe(false);
		expect(result.js).toBe('');
		expect(result.message).toContain('No Kotlin source');
	});
});

describe('which refusals stop a build', () => {
	it('blocks on a refused helper called with nothing but a trailing lambda', async () => {
		// `observableSeries { series -> series.search(q) }`: no parenthesis, and
		// a `.search(` inside the lambda. Neither text scan drew the edge, the
		// helper was pruned, and its callers survived calling nothing.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Theme() {',
						'    override val baseUrl = "https://example.invalid"',
						'}'
					)
				},
				{
					path: 'Theme.kt',
					source: kt(
						'abstract class Theme : HttpSource() {',
						'    private fun <R> cached(block: (List<String>) -> R): R = block(listOf(Build.MODEL))',
						'    override fun popularMangaRequest(page: Int): Request = cached { all ->',
						'        GET(all.first().trim(), headers)',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);
		expect(result.blocking.map((one) => one.member)).toEqual(['cached']);
	});

	it('does not block on a private helper only the settings screen calls', async () => {
		// A `private fun` is not the host's to call, so it is a root no longer;
		// it is reached when a reachable member names it — by a call, or by a
		// `::name` reference — and here only the never-run screen does.
		const source = (caller: string) =>
			kt(
				'class Demo : Source() {',
				'    override val baseUrl = "https://example.invalid"',
				'    override fun setupPreferenceScreen(screen: PreferenceScreen) {',
				'        checkLogin("a")',
				'    }',
				'    private fun checkLogin(email: String) {',
				'        Thread { println(email) }.start()',
				'    }',
				'    override fun popularMangaRequest(page: Int): Request {',
				`        ${caller}`,
				'        return GET(baseUrl, headers)',
				'    }',
				'}'
			);
		const unused = await convertKotlin([{ path: 'Demo.kt', source: source('') }], { parser });
		expect(unused.refusals.map((one) => one.member)).toEqual(['checkLogin']);
		expect(unused.blocking).toEqual([]);
		expect(unused.complete).toBe(true);

		// Called from a member the host runs, it blocks — and so does a
		// reference to it, which is no call at all.
		for (const caller of ['checkLogin("b")', 'listOf("b").forEach(::checkLogin)']) {
			const used = await convertKotlin([{ path: 'Demo.kt', source: source(caller) }], { parser });
			expect(used.blocking.map((one) => one.member)).toEqual(['checkLogin']);
		}
	});

	it('does not block on a member the host draws itself', async () => {
		// A converted bundle declares no settings, so nothing ever calls
		// `setupPreferenceScreen` — the same line `themes/convert.ts` draws.
		// The preference types themselves translate now; the Android toast
		// beside them is what is refused.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'    override fun setupPreferenceScreen(screen: PreferenceScreen) {',
						'        screen.addPreference(ListPreference(screen.context))',
						'        Toast.makeText(screen.context, "saved", Toast.LENGTH_SHORT).show()',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals.map((one) => one.member)).toEqual(['setupPreferenceScreen']);
		expect(result.blocking).toEqual([]);
		expect(result.complete).toBe(true);
		// Still reported: nothing vanishes quietly, it simply does not stop a build.
		expect(result.message).toContain('setupPreferenceScreen');
	});

	it('does not block on what a preference screen calls, since nothing runs one', async () => {
		// The extension's own screen translates now that the preference types
		// do, and it calls its template's — which refuses on a toast — and a
		// shared helper that refuses, which is MangaThemesia's paid-chapter
		// helper's shape. Neither can run: no driver invokes
		// `setupPreferenceScreen`. The same helper called from a member the
		// host does run still blocks, below.
		const files = (caller: string) => [
			{
				path: 'Demo.kt',
				source: kt(
					'class Demo : Theme() {',
					'    override fun setupPreferenceScreen(screen: PreferenceScreen) {',
					'        screen.addPreference(ListPreference(screen.context))',
					'        Helper().addTo(screen)',
					'        super.setupPreferenceScreen(screen)',
					'    }',
					caller,
					'}'
				)
			},
			{
				path: 'theme/Theme.kt',
				source: kt(
					'abstract class Theme : Source() {',
					'    override fun setupPreferenceScreen(screen: PreferenceScreen) {',
					'        Toast.makeText(screen.context, "saved", Toast.LENGTH_SHORT).show()',
					'    }',
					'}',
					'',
					'class Helper {',
					'    fun addTo(screen: PreferenceScreen?) = Injekt.get<Loader>()',
					'}'
				)
			}
		];

		const inert = await convertKotlin(files(''), { parser });
		expect(inert.refusals.map((one) => one.member).sort()).toEqual([
			'addTo',
			'setupPreferenceScreen'
		]);
		expect(inert.blocking).toEqual([]);
		expect(inert.complete).toBe(true);

		const reached = await convertKotlin(
			files('    override fun popularAnimeParse(response: Response) = Helper().addTo(null)'),
			{ parser }
		);
		expect(reached.blocking.map((one) => one.member)).toEqual(['addTo']);
	});

	it('blocks on a member that returns data', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override fun episodeListParse(response: Response) = Injekt.get<Loader>()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['episodeListParse']);
		expect(result.complete).toBe(false);
	});

	it('blocks on the intercept of an interceptor the extension installs', async () => {
		// Nothing names `intercept`: installing the object is the call. Pruned
		// as unreachable, a descrambler drawing on `Bitmap` left a class with no
		// `intercept` at all, the conversion reported complete, and the client
		// failed at the first request — or, where nothing checked, the pages
		// arrived still scrambled.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val client = network.client.newBuilder().addInterceptor(Unscramble()).build()',
						'    override fun popularMangaRequest(page: Int) = GET("https://example.invalid/")',
						'}',
						'',
						'class Unscramble : Interceptor {',
						'    override fun intercept(chain: Interceptor.Chain): Response {',
						'        val bitmap = Injekt.get<Loader>()',
						'        return chain.proceed(chain.request())',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['intercept']);
		expect(result.complete).toBe(false);
	});

	it('installs an interceptor whose only refused part is a WebView recovery', async () => {
		// A shared video-host extractor's shape, whole: the recovery tail is cut (see
		// `memberWithRecovery`), and the refused `by lazy` store it read is read
		// by nothing that survived — so neither blocks, and the cut is reported.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val client = network.client.newBuilder().addInterceptor(Guard()).build()',
						'    override fun popularAnimeRequest(page: Int) = GET("https://example.invalid/")',
						'}',
						'',
						'class Guard : Interceptor {',
						'    private val cookieManager by lazy { CookieManager.getInstance() }',
						'    override fun intercept(chain: Interceptor.Chain): Response {',
						'        val response = chain.proceed(chain.request())',
						'        if (response.code != 403) return response',
						'        val cookies = cookieManager.getCookie(chain.request().url.toString())',
						'        return chain.proceed(chain.request().newBuilder().addHeader("cookie", cookies).build())',
						'    }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking).toEqual([]);
		expect(result.complete).toBe(true);
		expect(result.refusals.map((one) => one.member)).toEqual(['cookieManager']);
		expect(result.deferred.map((one) => one.member)).toEqual(['intercept']);
	});

	it('blocks on a refused lazy property the moment translated code reads it', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    private val store by lazy { CookieManager.getInstance() }',
						'    override fun popularAnimeRequest(page: Int) = GET("https://example.invalid/" + store)',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['store']);
	});

	it('blocks on a refused lazy property that overrides one the driver reads', async () => {
		// Nothing in the Kotlin names `client`, but the driver does: pruned, it
		// would fall back to the base's client, which is the fallback a refused
		// override never gets.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val client by lazy { CookieManager.getInstance() }',
						'    override fun popularAnimeRequest(page: Int) = GET("https://example.invalid/")',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['client']);
	});

	it('blocks on a configureClient, which the driver calls although nothing else does', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : KeiSource() {',
						'    override fun OkHttpClient.Builder.configureClient() = apply { Injekt.get<Loader>() }',
						'    override fun popularMangaRequest(page: Int) = GET("https://example.invalid/")',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['configureClient']);
	});

	it('blocks on a private helper the extension’s own ABI member calls', async () => {
		// The hole this closes: a refusal in the entry file that was not itself
		// an `ABI_MEMBERS` name was exempted, so `popularAnimeParse` calling a
		// refused `parsePopular` reported `complete`, packaged, loaded, and threw
		// `this.parsePopular is not a function` on the first search. Whoever
		// declared it, a member the host can reach is a member the host reaches.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override fun popularAnimeParse(response: Response) = parsePopular(response)',
						'',
						'    private fun parsePopular(response: Response) = Injekt.get<Loader>()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['parsePopular']);
		expect(result.complete).toBe(false);
	});

	it('blocks on a file it could not parse at all', async () => {
		// A file-level refusal has no member in the call graph, so reachability
		// cannot speak for it — and a refusal reachability cannot judge is one
		// nothing may prune.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'}'
					)
				},
				{ path: 'Broken.kt', source: 'class Broken { fun x(  = }' }
			],
			{ parser }
		);

		expect(result.blocking.length).toBeGreaterThan(0);
		expect(result.complete).toBe(false);
	});
});

describe('a refusal the surviving code still needs', () => {
	it("keeps two libraries' same-named companion constants apart", async () => {
		// Both hoist to module scope, and until the declaration pass saw them the
		// cross-file rename could not: two shared extractors in one bundle each
		// declaring a companion `QUALITY_REGEX` emitted the name twice, and
		// `"QUALITY_REGEX" has already been declared` took the whole bundle down
		// at load — out of a conversion that reported nothing refused.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    override fun popularAnimeRequest(page: Int) = GET(First().read() + Second().read())',
						'}'
					)
				},
				{
					path: 'lib/one/First.kt',
					source: kt(
						'class First {',
						'    fun read(): String = QUALITY_REGEX.pattern',
						'    companion object { private val QUALITY_REGEX = Regex("a") }',
						'}'
					)
				},
				{
					path: 'lib/two/Second.kt',
					source: kt(
						'class Second {',
						'    fun read(): String = QUALITY_REGEX.pattern',
						'    companion object { private val QUALITY_REGEX = Regex("b") }',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking).toEqual([]);
		const declarations = [...conversion.js.matchAll(/^const (QUALITY_REGEX\w*)/gm)].map(
			(one) => one[1]
		);
		expect(declarations.length).toBe(2);
		expect(new Set(declarations).size).toBe(2);
	});

	it('blocks on a helper called with an explicit type argument', async () => {
		// `callEdges` matched `.name(` and so recorded no edge at all for
		// `filters.parseTriFilter<GenreFilter>(…)`: the refused helper looked
		// unreachable, the caller was not blocked, and the bundle shipped
		// `AnimesGamesFilters.parseTriFilter is not a function` — on the first
		// search, out of a conversion that reported nothing refused.
		const conversion = await convertKotlin(
			[
				{
					path: 'Filters.kt',
					source: kt(
						'object Filters {',
						'    internal fun getSearchParameters(filters: List<Any>): String =',
						'        filters.parseTriFilter<GenreFilter>()',
						'',
						'    private inline fun <reified R> List<Any>.parseTriFilter(): String = Injekt.get<String>()',
						'}'
					)
				},
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    override fun searchAnimeRequest(page: Int, query: String, filters: List<Any>) =',
						'        GET(Filters.getSearchParameters(filters))',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.blocking.length).toBeGreaterThan(0);
		expect(conversion.complete).toBe(false);
	});

	it('blocks on a refused object whose name the surviving code mentions', async () => {
		// `object AniPlayFilters` refused as a unit, `getFilterList` exempted for
		// being host-drawn, and the surviving `AniPlayFilters.FILTER_LIST` went
		// out in a bundle that reported nothing blocking. The driver can degrade
		// around a member it asks for and does not find; it cannot degrade around
		// a free variable in code that survived.
		const conversion = await convertKotlin(
			[
				{
					path: 'Filters.kt',
					source: kt(
						'object DemoFilters {',
						'    open class SelectFilter(name: String) : AnimeFilter.Select<String>(name, arrayOf())',
						'    internal class OrderFilter : SelectFilter(MISSING_LIST)',
						'    val FILTER_LIST get() = AnimeFilterList(OrderFilter())',
						'}'
					)
				},
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : ParsedAnimeHttpSource() {',
						'    override fun getFilterList() = DemoFilters.FILTER_LIST',
						'}'
					)
				}
			],
			{ parser }
		);

		// The object refuses as a unit — the fault is in a nested class header,
		// which is not a per-member refusal — and the refusal is named for the
		// object, which `isHostDrawn` exempts for ending in `Filters`.
		expect(conversion.refusals.map((one) => one.member)).toEqual(['DemoFilters']);
		expect(conversion.blocking.map((one) => one.member)).toEqual(['DemoFilters']);
		expect(conversion.complete).toBe(false);
	});
});

describe('which refusals the host can reach', () => {
	const EXTENSION = kt(
		'class Demo : Source() {',
		'    override val baseUrl = "https://example.invalid"',
		'',
		'    override fun episodeListParse(response: Response) = Helper.readEpisodes(response)',
		'}'
	);

	const SHARED = kt(
		'object Helper {',
		'    fun readEpisodes(response: Response) = response.asJsoup().select("li")',
		'',
		'    fun installInterceptor(client: OkHttpClient) = Injekt.get<Chain>()',
		'}'
	);

	it('does not block on a refusal in a shared file nothing reachable calls', async () => {
		// Measured: feeding an extension its extractor modules made conversion
		// *worse*, because an extractor's own refusals counted against every
		// extension that merely named the module.
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: EXTENSION },
				{ path: 'Helper.kt', source: SHARED }
			],
			{ parser }
		);

		// Named for the method that could not be translated, not for the object
		// around it: an object refuses one member at a time, as a class does, so
		// the method the extension actually calls is still there to call.
		expect(result.refusals.map((one) => one.member)).toContain('installInterceptor');
		expect(result.blocking).toEqual([]);
		expect(result.reachable).toContain('episodeListParse');
		expect(result.js).toContain('const Helper = Object.freeze(');
		expect(result.js).toContain('readEpisodes');
	});

	it('still blocks on a refusal the entry class does reach', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override fun episodeListParse(response: Response) = Injekt.get<Loader>()',
						'}'
					)
				},
				{ path: 'Helper.kt', source: SHARED }
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['episodeListParse']);
	});

	it('blocks on a refused file-scope value a reachable member merely reads', async () => {
		// A bare name, with no receiver in front of it and no call parentheses
		// after it. The walk followed calls only, so this refusal was pruned as
		// unreachable — and the emitted member still said `FILTERS`, which
		// nothing in the module declared. It converted, packaged, installed, and
		// answered the first search with `FILTERS is not defined`.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'',
						'    override fun getFilterList() = FILTERS',
						'}'
					)
				},
				{ path: 'Filters.kt', source: 'val FILTERS = Injekt.get<Filters>()' }
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toContain('FILTERS');
	});

	it('blocks on a refused property of the template the extension extends', async () => {
		// Building the extension builds its base class, and a getter-bodied
		// property is read as `this.apiUrl` — a read, not a call, so it drew
		// no edge. The template was never reached as a type, the refused getter
		// was pruned, and every request went to `undefined/search` out of a
		// conversion that reported nothing refused.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt('class Demo : Template() {', '    override val lang = "en"', '}')
				},
				{
					path: 'Template.kt',
					source: kt(
						'abstract class Template : Source() {',
						'    protected open val apiUrl: String',
						'        get() = Injekt.get<Api>().url',
						'    private fun searchUrl(page: Int) = "$apiUrl/search?page=$page"',
						'    override fun popularMangaRequest(page: Int) = GET(searchUrl(page))',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toEqual(['apiUrl']);
	});

	it('keeps a member reached only through a receiver it cannot resolve', async () => {
		// The graph is built from the text, not from resolved calls: pruning
		// something that is in fact called trades a refusal for `undefined is not
		// a function` inside a sandbox, which is the worse of the two.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun links(url: String) = loader().readEpisodes(url)',
						'}'
					)
				},
				{
					path: 'Helper.kt',
					source: kt(
						'object Helper {',
						'    fun readEpisodes(url: String) = Injekt.get<Loader>()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.reachable).toContain('readEpisodes');
		expect(result.blocking.map((one) => one.member)).toContain('readEpisodes');
	});

	it('blocks on a refused class a surviving class extends, whatever it is called', async () => {
		// `class StatusList : MultiValueFilter(…)` runs `extends` when the module
		// loads. The base refused, its name ends in `Filter` so it was exempted
		// as host-drawn, and a class header draws no edge — so nothing blocked,
		// and the bundle died on import with "MultiValueFilter is not defined".
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'    override fun getFilterList() = FilterList(StatusFilter())',
						'}'
					)
				},
				{
					path: 'Filters.kt',
					source: kt(
						'abstract class MultiValueFilter(name: String) : Filter.Group<Filter.CheckBox>(name = name, options = emptyList())',
						'class StatusFilter : MultiValueFilter("Status")'
					)
				}
			],
			{ parser }
		);

		expect(result.blocking.map((one) => one.member)).toContain('MultiValueFilter');
		expect(result.complete).toBe(false);
	});

	it('follows a member reference, which is a call made later', async () => {
		// `.addInterceptor(::checkForToken)` on a template's client: nothing
		// *calls* `checkForToken` in the text, so it and the refused login it
		// calls were pruned, and the bundle threw `this.refresh is not a
		// function` on its first request with nothing refused.
		const result = await convertKotlin(
			[
				{ path: 'Demo.kt', source: kt('class Demo : Base() {', '}') },
				{
					path: 'Base.kt',
					source: kt(
						'abstract class Base : Source() {',
						'    override val client = network.client.newBuilder().addInterceptor(::checkForToken).build()',
						'    private fun checkForToken(chain: Interceptor.Chain): Response {',
						'        refresh()',
						'        return chain.proceed(chain.request())',
						'    }',
						'    private fun refresh() = Injekt.get<Loader>()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.reachable).toContain('checkForToken');
		expect(result.blocking.map((one) => one.member)).toContain('refresh');
	});

	it('does not read `::x.isInitialized` as a call to `x`', async () => {
		// It asks whether a `lateinit` was written. Followed as a call, a
		// template's refused-but-unread `lateinit` blocked four listings that
		// had been loading and requesting.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'    fun popular(): Boolean = Cache.ready()',
						'}'
					)
				},
				{
					path: 'Cache.kt',
					source: kt(
						'object Cache {',
						'    lateinit var elements: Elements',
						'    fun ready() = ::elements.isInitialized',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.reachable).toContain('ready');
		expect(result.blocking.map((one) => one.member)).not.toContain('elements');
	});
});

describe('what the runtime is asked for', () => {
	it('lists only the helpers the emitted code calls, sorted and deduplicated', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    fun a(s: String) = s.substringAfter("/")',
						'    fun b(s: String) = s.substringAfter("?")',
						'    fun c(s: String) = s.trim()',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.usedRuntime).toEqual(['substringAfter', 'trim']);
	});
});

/**
 * Cookies, split down the middle.
 *
 * The host keeps a per-plugin, per-host, in-memory jar and attaches it on the
 * way out (`docs/adr/0005-network-boundaries.md` §3), so an extension that
 * *installs* a jar or *saves* to one is asking for behaviour it already has and
 * converts. An extension that *reads* one is asking for the thing that design
 * refuses — the host carries the state and the plugin never sees it — and must
 * still be refused by name rather than quietly handed an empty list.
 */
describe('the cookie shapes that convert, and the ones that still refuse', () => {
	it('converts a client that installs a jar and saves responses to it', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'',
						'    fun clientFor() = client.newBuilder().cookieJar(jar).build()',
						'',
						'    fun remember(url: HttpUrl, response: Response) =',
						'        client.cookieJar.saveFromResponse(url, response.headers)',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals).toEqual([]);
		expect(result.js).toContain('.cookieJar(');
		expect(result.js).toContain('.saveFromResponse(');
	});

	it('refuses an extension that reads its own jar, by name', async () => {
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'',
						'    fun stolen(url: HttpUrl) = client.cookieJar.loadForRequest(url)',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals.map((one) => one.member)).toContain('stolen');
		expect(result.js).not.toContain('loadForRequest');
	});

	it('refuses the WebView cookie store rather than letting it die in the sandbox', async () => {
		// A capitalised receiver is a cross-file object reference, which is
		// exempt from the passthrough allowlist — so this used to convert
		// cleanly and fail inside the isolate as `CookieManager is not
		// defined`, which names nothing anybody can act on.
		const result = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : Source() {',
						'    override val baseUrl = "https://example.invalid"',
						'',
						'    fun stored(url: String) = CookieManager.getInstance().getCookie(url)',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(result.refusals.map((one) => one.member)).toContain('stored');
	});
});

describe('a refusal that constructor code names', () => {
	it('blocks, even where the host would never reach the member', async () => {
		// The shape that reached a device: a template builds its filter options
		// in a property initialiser out of a member that refused. Reachability
		// pruned the refusal — nothing the host calls reaches it — so the
		// conversion reported complete, packaged, installed, and threw on the
		// line that constructs the class. `namedAtConstruction` is the clause
		// that was missing.
		const conversion = await convertKotlin(
			[
				{
					path: 'Demo.kt',
					source: kt(
						'class Demo : HttpSource() {',
						'    private val helper = Unreachable(context)',
						'    private val options = listOf(helper.label)',
						'    override fun popularMangaRequest(page: Int) = GET(baseUrl)',
						'}'
					)
				}
			],
			{ parser }
		);

		expect(conversion.complete).toBe(false);
		expect(conversion.blocking.map((one) => one.member)).toContain('helper');
	});
});
