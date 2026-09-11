/**
 * That the pieces of a converted bundle can actually be concatenated.
 *
 * Every entry shim builds one module by joining independently written source
 * strings: the shared JavaScript runtime, the stream guards, the inlined DOM
 * engine, a per-format runtime, and a driver. Each is developed and tested on
 * its own, and nothing about writing one tells you what names another already
 * took.
 *
 * That has gone wrong twice, and both times the same way. The Kotlin runtime
 * declared `__request`, which the shared runtime already had; the Aniyomi
 * driver declared `__has`, which the Kotlin runtime had since acquired. A
 * duplicate `function` or `const` at module scope is a **SyntaxError**, so the
 * failure is not "one helper misbehaves" — it is the entire bundle failing to
 * load, at install time, for every source in that format at once. The message
 * names an identifier and nothing about where either declaration came from.
 *
 * A unit test cannot catch this: each piece is valid alone. Only the join is
 * wrong, so the join is what this checks.
 *
 * ## Why declarations are found by column and not by parsing
 *
 * The inlined DOM engine is a minified IIFE on one line — thousands of
 * identifiers, every one of them safely inside a closure. Parsing the whole
 * bundle to get true top-level scope would work and would also mean carrying a
 * JavaScript parser into a spec. Every hand-written runtime here declares at
 * column zero and every nested declaration is indented, so an unindented
 * `function`/`const`/`let`/`var`/`class` is a module-scope declaration, and the
 * minified line begins with `(` and matches nothing. That is a heuristic, and
 * it is exactly strong enough for the bug it exists to catch.
 */

import { describe, expect, it } from 'vitest';

import { aniyomiEntrypoint } from './aniyomi-entry';
import { mangayomiEntrypoint } from './mangayomi-entry';
import { soraEntrypoint } from './sora-entry';

/** Module-scope declarations, by name, with how many times each was declared. */
function declarationsIn(source: string): Map<string, number> {
	const counts = new Map<string, number>();
	const pattern = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
	for (const line of source.split('\n')) {
		const match = pattern.exec(line);
		if (match === null) continue;
		counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
	}
	return counts;
}

function duplicatesIn(source: string): string[] {
	return [...declarationsIn(source)]
		.filter(([, count]) => count > 1)
		.map(([name]) => name)
		.sort();
}

const BUNDLES: readonly (readonly [string, () => string])[] = [
	[
		'aniyomi',
		() =>
			aniyomiEntrypoint({
				pluginId: 'app.yorozo.converted.aniyomi.example',
				translatedSource: 'class Extension { constructor() { this.baseUrl = ""; } }',
				className: 'Extension',
				baseUrl: 'https://example.invalid'
			})
	],
	[
		'mangayomi',
		() =>
			mangayomiEntrypoint({
				pluginId: 'app.yorozo.converted.mangayomi.example',
				script: 'class DefaultExtension extends MProvider {}',
				source: { baseUrl: 'https://example.invalid' }
			})
	],
	[
		'sora',
		() =>
			soraEntrypoint({
				pluginId: 'app.yorozo.converted.sora.example',
				script: 'async function searchResults(q) { return "[]"; }',
				baseUrl: 'https://example.invalid',
				container: 'hls',
				softsub: false
			})
	]
];

describe('every entry shim composes into one loadable module', () => {
	for (const [format, build] of BUNDLES) {
		it(`declares no name twice at module scope — ${format}`, () => {
			// A duplicate here is a SyntaxError at load, which means every source
			// in this format stops converting at once.
			expect(duplicatesIn(build())).toEqual([]);
		});

		it(`carries the shared runtime exactly once — ${format}`, () => {
			const source = build();
			// `__host` is the seam every runtime section reaches through, so a
			// second copy of the shared runtime shows up here first.
			expect(declarationsIn(source).get('__host') ?? 0).toBe(1);
		});
	}

	it('finds a duplicate when there is one', () => {
		// The check has to be able to fail, or it is decoration. Two of the three
		// bundles above once contained exactly this shape.
		const broken = [
			'function __has(name) { return true; }',
			'function __has(other) { return false; }'
		].join('\n');
		expect(duplicatesIn(broken)).toEqual(['__has']);
	});

	it('ignores declarations nested inside a function', () => {
		const nested = ['function outer() {', '  const inner = 1;', '  const inner2 = 2;', '}'].join(
			'\n'
		);
		expect(duplicatesIn(nested)).toEqual([]);
	});
});
