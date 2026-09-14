/**
 * That the vendored grammar is the one we think it is, and that it parses.
 *
 * Two artefacts are committed as binaries here, and both are load-bearing in a
 * way that is invisible in a diff: a wasm shows up in review as "binary file
 * changed" and nothing else. So the hashes are asserted, because a silent swap
 * — an upgrade someone half-finished, a corrupted checkout — would otherwise
 * surface as a conversion that quietly refuses more extensions than it used to,
 * with no failing test anywhere.
 *
 * The checkout risk is real rather than hypothetical: `.gitattributes` sets
 * `* text=auto eol=lf`, so a `.wasm` not marked binary has its bytes rewritten
 * on checkout and fails at instantiation with an error that says nothing about
 * line endings. That entry exists; this test is what proves it still works.
 */

import { describe, expect, it } from 'vitest';

import type { KNode } from './ast';
import { loadKotlinGrammar, resetKotlinGrammar } from './grammar';

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

const EXPECTED: Readonly<Record<string, string>> = {
	'tree-sitter.wasm': '17382e1a69bd628107e8dfe37d31d57f7ba948e5f2da77e56a8aa010488dc5ae',
	'tree-sitter-kotlin.wasm': 'b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449'
};

/**
 * Takes an `ArrayBuffer` rather than a view.
 *
 * `readFile` returns a `Buffer`, whose backing store is a pooled allocation
 * shared with other reads — hashing it directly would hash whatever else Node
 * happened to have in that pool. Copying into a buffer of exactly the right
 * length is what makes the digest a fact about the file.
 */
async function sha256(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readExactly(path: string): Promise<ArrayBuffer> {
	const { readFile } = await import('node:fs/promises');
	const file = await readFile(path);
	const copy = new Uint8Array(file.byteLength);
	copy.set(file);
	return copy.buffer;
}

/** The first node of a kind anywhere in the tree, for asserting a shape. */
function firstOfType(node: KNode, kind: string): KNode | null {
	if (node.type === kind) return node;
	for (const child of node.children) {
		const found = firstOfType(child, kind);
		if (found !== null) return found;
	}
	return null;
}

describe('the vendored grammar', () => {
	for (const [name, hash] of Object.entries(EXPECTED)) {
		it(`is the ${name} recorded in vendor/README.md`, async () => {
			const { fileURLToPath } = await import('node:url');
			const path = fileURLToPath(new URL(`./vendor/${name}`, import.meta.url));
			expect(await sha256(await readExactly(path))).toBe(hash);
		});
	}

	it('parses the constructs a real extension is made of', async () => {
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Example : ParsedAnimeHttpSource() {
    override val baseUrl = "https://example.invalid"
    override fun popularAnimeRequest(page: Int): Request = GET("$baseUrl/p?page=$page", headers)
    override fun animeFromElement(element: Element): SAnime = SAnime.create().apply {
        setUrlWithoutDomain(element.selectFirst("a")!!.attr("href"))
        title = element.selectFirst("h3")?.text() ?: ""
    }
    override suspend fun getVideoList(episode: SEpisode): List<Video> =
        client.newCall(GET(baseUrl)).execute().asJsoup().select("li").map { Video(it.attr("src"), "d", it.attr("src")) }
}
`);

		// Zero errors, not "few": tree-sitter recovers by guessing, and this
		// converter refuses any member whose subtree contains an ERROR — so a
		// grammar that stumbles here would refuse the whole ecosystem.
		expect(tree.hasError).toBe(false);
		expect(tree.root.type).toBe('source_file');
	});

	it('accepts a type-use annotation on a delegation specifier', async () => {
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo : @Marker Base() {
    val value = 1
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reads a `when` entry that returns a name beginning with `e`', async () => {
		// The vendored lexer reaches for `else` on the first character: `-> return
		// emptyList()` is an ERROR while `-> return listOf()` is not, and so is
		// `-> return eee()` while `-> return elseX()` is fine. A member that
		// cannot be parsed is refused, so this one construct refused whole files.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    fun go(kind: String): List<String> = when (kind) {
        "a" -> listOf("x")
        else -> return emptyList()
    }
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reads a `when` entry whose unbraced `if` ends in a string', async () => {
		const parse = await loadKotlinGrammar(vendorWasm);
		// `else "y"` is the trigger; `else y` parses unaided.
		const tree = parse(`
class Demo {
    fun go(type: String): String = when (type) {
        else -> if (type == "movie") "primary" else "first_air"
    }
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('leaves a lambda arrow alone, because it already parses', async () => {
		// `{ x -> if (a) "p" else "q" }` is not a `when` entry and needs no
		// repair. Rewriting a file the grammar already reads would make this a
		// second parser rather than a repair, so the arrow is checked by walking
		// back to the brace that opened it.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    fun go(rows: List<String>): List<String> = rows.map { x -> if (x == "a") "p" else "q" }
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reads an assignment whose target sits behind a call', async () => {
		// The assignable-expression rule reaches over an identifier and over an
		// index — `a[0].name = x` parses — and not over a call. Recovery then
		// loses the brace nesting, so this one construct refused whole files and
		// reported it as a declaration at file scope.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    fun go(episodes: List<SEpisode>, isMovie: Boolean) {
        if (isMovie && episodes.size == 1) {
            episodes.first().name = "Movie"
        }
        log("done")
        episodes.last().episode_number = 2F
        getMeta(1).schedule += 1
    }
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('leaves an assignment through an index alone, because it already parses', async () => {
		// The assignable-expression rule does reach over an index, so this needs
		// no repair — and rewriting Kotlin the grammar already reads would make
		// this a second parser rather than a repair.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    fun go(rows: List<SEpisode>) {
        rows[0].name = "x"
    }
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reads a multi-dollar string, raw and quoted', async () => {
		// Kotlin 2.1. A string opened with two dollars interpolates only where two
		// appear together, which is why sources carrying GraphQL reach for it.
		const parse = await loadKotlinGrammar(vendorWasm);
		const dollar = '$';
		const tree = parse(`
class Demo {
    private val query = ${dollar}${dollar}"""
        query get(${dollar}select: Search) { items { id ${dollar}${dollar}id } }
    """

    private fun body(id: String) = ${dollar}${dollar}"{\\"id\\":\\"${dollar}${dollar}id\\",\\"q\\":\\"f(${dollar}serie)\\"}"
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('leaves a plain string containing two dollars alone', async () => {
		// `"costs $$"` ends in two dollars and a quote, which is the shape of a
		// multi-dollar opener read backwards. The rewrite runs against a mask, so
		// dollars inside a literal are never an opener.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    private val label = "costs $$"
    private val also = "$$" + label
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reads a raw string ending in an odd run of backslashes', async () => {
		// The pinned grammar treats a trailing backslash in a raw string as
		// escaping the quote after it, a rule Kotlin raw strings do not have, and
		// reads past the real terminator looking for one it does not consider
		// escaped. `Regex("""\\x...""")` ends on two backslashes and is fine;
		// `.replace("""\\""", """\""")` ends its second argument on one.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    private fun unescape(value: String): String = value
        .replace("""\\\\""", """\\""")
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('leaves a raw string ending in an even run of backslashes alone, because it already parses', async () => {
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    private val hexEscape = Regex("""\\\\x([0-9a-fA-F]{2})""")
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('does not respell a raw string ending in a backslash across a real newline', async () => {
		// An ordinary string cannot hold a literal newline, so a raw string
		// ending in an odd run of backslashes is left as the honest "could not
		// parse" rather than respelled into a shape that would lose the newline
		// — the same trigger as the passing case above, with a line break in the
		// content instead of none.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    private val body = """
    line one \\"""
}
`);

		expect(tree.hasError).toBe(true);
	});

	it('reads a generic call used as the right operand of an operator', async () => {
		// The grammar resolves `<` … `>` `(` in favour of comparison there, and
		// the result has no ERROR node: `y + f.pick<G>(1)` becomes
		// `(y + f.pick)<G>(1)`, an additive expression being *called*. Kotlin has
		// no such reading — `a < b` is a Boolean and `Boolean > (c)` is a type
		// error — so wherever this shape appears the type arguments are meant.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
object Filters {
    fun go(filters: List<Any>): String =
        filters.pick<GenreFilter>("a") +
            filters.pick<SeasonFilter>("b") +
            filters.pick<StudioFilter>("c")
}
`);

		expect(tree.hasError).toBe(false);
		// The mis-parse is not an error, so the proof is the *shape*: the value
		// is a sum, not a call.
		const value = firstOfType(tree.root, 'additive_expression');
		expect(value).not.toBeNull();
	});

	it('leaves a genuine pair of comparisons alone', async () => {
		// `x + a < b && c > (d)` has the same characters in the same order and is
		// two comparisons. The angle brackets have to hold nothing but type
		// characters, and `&&` is not one.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
class Demo {
    fun go(a: Int, b: Int, c: Int, d: Int): Boolean = a + a < b && c > (d)
}
`);

		expect(tree.hasError).toBe(false);
		expect(firstOfType(tree.root, 'conjunction_expression')).not.toBeNull();
	});

	it('does not wrap the base class after a class header colon', async () => {
		// `) : AnimeFilter.Select<String>(…)` is a supertype and not an operand,
		// and wrapping it produced `) : (AnimeFilter.Select<String>(…))` — not a
		// class header at all. A lone `:` is not the `?:` this looks for.
		const parse = await loadKotlinGrammar(vendorWasm);
		const tree = parse(`
object Filters {
    open class QueryPartFilter(
        displayName: String,
        val vals: Array<Pair<String, String>>,
    ) : AnimeFilter.Select<String>(
        displayName,
        vals.map { it.first }.toTypedArray(),
    )
}
`);

		expect(tree.hasError).toBe(false);
	});

	it('reports an error for source that is genuinely broken', async () => {
		const parse = await loadKotlinGrammar(vendorWasm);
		// The check has to be able to fail. An error-tolerant parser that never
		// reported one would make `hasError` useless as a refusal signal.
		expect(parse('class A : B( {{{ val = ').hasError).toBe(true);
	});

	it('builds the parser once however many callers ask', async () => {
		resetKotlinGrammar();
		const loads: string[] = [];
		const loader = async (name: string): Promise<Uint8Array> => {
			loads.push(name);
			return vendorWasm(name);
		};

		const [first, second] = await Promise.all([
			loadKotlinGrammar(loader),
			loadKotlinGrammar(loader)
		]);

		// Two conversions starting together must share one build rather than
		// racing each other through it — and a build reads each of the two
		// vendored artefacts exactly once, never one of them twice.
		expect(second).toBe(first);
		expect(loads.sort()).toEqual(['tree-sitter-kotlin.wasm', 'tree-sitter.wasm']);
	});
});
