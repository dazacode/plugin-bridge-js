/**
 * Kotlin overloads, through the translator and the real runtime together.
 *
 * Kotlin resolves a call among same-named declarations at compile time; a
 * JavaScript class has one slot per name. Until `Declared.overloads` the
 * second declaration simply replaced the first, and every shape below
 * converted, packaged and imported cleanly while doing the wrong thing:
 *
 * - `searchMangaUrl(page, query)` beside `searchMangaUrl(page, query,
 *   filters)` (MangaThemesia) — the three-argument method called itself.
 * - `mangaDetailsParse(response)` beside `mangaDetailsParse(document)`
 *   (Madara) — whichever came second was handed the other's argument.
 * - `val useLoadMoreRequest` beside `fun useLoadMoreRequest()` (Madara) — the
 *   property took the slot and the call threw.
 * - `Element.imgAttr()` beside `Elements.imgAttr()` (MangaThemesia) — the
 *   list version called itself on every cover.
 *
 * Run against the real runtime rather than the emitter's stub, because the
 * resolution is the runtime's (`__k.overload`) and the stub has no opinion
 * about a `Response`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { translateKotlin } from '@plugin-bridge/core/kotlin/translate-host';
import { JS_RUNTIME } from '@plugin-bridge/runtime/shims/js-runtime';
import { kotlinRuntime } from '@plugin-bridge/runtime/shims/kotlin-runtime';

async function vendorWasm(name: string): Promise<Uint8Array> {
	const path = fileURLToPath(new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url));
	return new Uint8Array(await readFile(path));
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let loads = 0;

/** Translates `source`, and evaluates it after the runtime, exporting `names`. */
async function run(source: string, names: string[], base: Record<string, unknown> = {}) {
	const translated = await translateKotlin([{ path: 'Demo.kt', source }], { wasm: vendorWasm });
	expect(translated.complete).toBe(true);
	loads += 1;
	const module = [
		JS_RUNTIME,
		'var __rt = {};',
		kotlinRuntime(),
		// The driver's base class, which a call no translated declaration takes
		// falls back to — see `__k.overload`.
		`const __super = globalThis.__overloadsBase${loads};`,
		translated.js,
		`export const exported = { ${names.join(', ')} };`,
		`export const k = __k;`
	].join('\n');
	(globalThis as any)[`__overloadsBase${loads}`] = base;
	const url = `data:text/javascript;base64,${Buffer.from(module).toString('base64')}`;
	return (await import(/* @vite-ignore */ url)) as { exported: Record<string, any>; k: any };
}

describe('Kotlin overloads', () => {
	it('dispatches by argument count, and a subclass override calling super does not find itself', async () => {
		const { exported } = await run(
			`
abstract class Theme : ParsedHttpSource() {
    open fun url(page: Int, query: String): String = "p$page q$query"
    open fun url(page: Int, query: String, filters: List<String>): String =
        url(page, query) + " f" + filters.size
}
class Ext : Theme() {
    override fun url(page: Int, query: String): String = super.url(page, query) + "!"
}
`,
			['Ext']
		);
		const ext = new exported.Ext();
		expect(ext.url(1, 'a')).toBe('p1 qa!');
		// The three-argument version reaches the subclass's two-argument
		// override — Kotlin's virtual dispatch — and the override's `super`
		// reaches the template's, not itself.
		expect(ext.url(2, 'b', ['x', 'y'])).toBe('p2 qb! f2');
	});

	it('dispatches by argument type, and hands the driver what no declaration takes', async () => {
		const { exported, k } = await run(
			`
abstract class Theme : ParsedHttpSource() {
    override fun mangaDetailsParse(response: Response): String = "response:" + mangaDetailsParse(response.asJsoup())
    protected open fun mangaDetailsParse(document: Document): String = "document"
}
class Ext : Theme() {
    override fun mangaDetailsParse(document: Document): String = "ext " + super.mangaDetailsParse(document)
    fun other(x: String): String = "s"
    fun other(x: Int): String = "i"
}
`,
			['Ext']
		);
		const ext = new exported.Ext();
		const document = k.asJsoup('<html><body></body></html>');
		expect(ext.mangaDetailsParse(document)).toBe('ext document');
		expect(ext.other('a')).toBe('s');
		expect(ext.other(3)).toBe('i');
	});

	it('keeps a val and a fun of the same name apart', async () => {
		const { exported } = await run(
			`
abstract class Theme : ParsedHttpSource() {
    protected open val useLoadMore = 1
    protected fun useLoadMore(): Boolean = useLoadMore == 2
    fun decide(): Boolean = useLoadMore()
}
class Ext : Theme() {
    override val useLoadMore = 2
}
`,
			['Ext']
		);
		const ext = new exported.Ext();
		expect(ext.useLoadMore).toBe(2);
		expect(ext.decide()).toBe(true);
	});

	it('tells an Element receiver from an Elements one', async () => {
		const { exported, k } = await run(
			`
abstract class Theme : ParsedHttpSource() {
    protected open fun Element.imgAttr(): String = attr("src")
    protected fun Elements.imgAttr(): String = firstOrNull()?.imgAttr() ?: "none"
    fun cover(e: Element): String = e.imgAttr()
    fun covers(e: Elements): String = e.imgAttr()
}
class Ext : Theme()
`,
			['Ext']
		);
		const ext = new exported.Ext();
		const document = k.asJsoup('<img src="a.png"><img src="b.png">');
		expect(ext.cover(document.selectFirst('img'))).toBe('a.png');
		expect(ext.covers(document.select('img'))).toBe('a.png');
		expect(ext.covers(document.select('video'))).toBe('none');
	});

	it('dispatches an object\u2019s overloads, including one taken off it as a value', async () => {
		// `JsUnpacker.unpack(String)` beside `unpack(Collection)`: an object is a
		// frozen literal, and a literal keeps the last of two keys. (`decode`
		// here because the runtime has a free `unpack` of its own.)
		const { exported } = await run(
			`
object Unpacker {
    fun decode(script: String): String = "one:" + script
    fun decode(scripts: Collection<String>): String = scripts.joinToString(",") { decode(it) }
}
class Ext : ParsedHttpSource() {
    fun both(): String = Unpacker.decode("a") + " | " + Unpacker.decode(listOf("b", "c"))
    fun mapped(): List<String> = listOf("d").map(Unpacker::decode)
}
`,
			['Ext']
		);
		const ext = new exported.Ext();
		expect(ext.both()).toBe('one:a | one:b,one:c');
		expect(ext.mapped()).toEqual(['one:d']);
	});

	it('keeps two objects\u2019 overloads of one name apart', async () => {
		// The signature table is collected by name across files, so each
		// dispatcher lists the other object's signatures too. Only the ones
		// actually on the object it is resolving against may be picked.
		const { exported } = await run(
			`
object Packed {
    fun unpack(a: String, b: String, c: String): String = "P3"
    fun unpack(x: Int): String = "Pi"
}
object Js {
    fun unpack(s: String): String = "J1"
    fun unpack(s: Collection<String>): String = "Jc"
}
class Ext : ParsedHttpSource() {
    fun all(): String = Packed.unpack("a", "b", "c") + Packed.unpack(1) + Js.unpack("x") + Js.unpack(listOf("y"))
}
`,
			['Ext']
		);
		expect(new exported.Ext().all()).toBe('P3PiJ1Jc');
	});

	it('tells a skipped defaulted slot from a required one, and a function from a Headers', async () => {
		// PlaylistUtils: two extractFromHls, the same length, differing only in
		// `masterHeaders: Headers` (required) against `masterHeadersGen: (…) ->
		// Headers = …` (defaulted). A call naming neither is the second; taken
		// as the first, its body called the dispatcher again, for ever.
		const { exported, k } = await run(
			`
class Utils(private val client: OkHttpClient) {
    fun hls(url: String, referer: String = "r", master: Headers, name: (String) -> String = { it }): String =
        hls(url, referer, { _, _ -> master }, name)
    fun hls(url: String, referer: String = "r", masterGen: (Headers, String) -> Headers = { h, _ -> h }, name: (String) -> String = { it }): String =
        "gen " + name(url)
}
class Ext : ParsedHttpSource() {
    fun named(u: Utils): String = u.hls("a", referer = "x", name = { it + "!" })
    fun headed(u: Utils): String = u.hls("b", "x", headers, { it })
}
`,
			['Ext', 'Utils']
		);
		const ext = new exported.Ext();
		ext.headers = k.headersOf ? k.headersOf('A', '1') : undefined;
		const utils = new exported.Utils(null);
		expect(ext.named(utils)).toBe('gen a!');
	});

	it('falls back to the driver base when no translated declaration accepts the call', async () => {
		const { exported } = await run(
			`
abstract class Theme : ParsedHttpSource() {
    fun pick(x: String): String = "string"
    fun pick(x: Int): String = "int"
}
class Ext : Theme()
`,
			['Ext'],
			{ pick: () => 'driver' }
		);
		expect(new exported.Ext().pick(true)).toBe('driver');
	});
});
