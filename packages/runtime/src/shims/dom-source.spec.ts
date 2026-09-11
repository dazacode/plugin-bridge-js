/**
 * The DOM engine, as it is actually shipped inside a converted bundle.
 *
 * `dom.spec.ts` tests the parser as TypeScript. This tests the *generated*
 * copy — the bundled, minified source string that `tool/gen-plugin-runtime.ts`
 * produces and that `mangayomi-entry.ts` inlines — because those are two
 * different artefacts and only one of them is what a viewer runs.
 *
 * The failure this exists to catch: a bundle that ships a runtime which does
 * not evaluate, or which is missing an export the entry shims call. That would
 * surface as every converted plugin failing at `load` with a message about
 * something being undefined, a long way from the generator that caused it.
 *
 * Byte-level drift between `dom.ts` and its generated copy is a separate gate
 * and belongs where the other generated artefacts are checked — regenerate and
 * diff — because a spec cannot re-run the bundler without reaching outside the
 * package.
 */

import { describe, expect, it } from 'vitest';

import { DOM_RUNTIME_SOURCE } from './generated/dom-source';

interface Runtime {
	parseHtml(
		html: string,
		baseUrl?: string
	): {
		select(selector: string): { attr(name: string): string; text(): string }[];
		selectFirst(selector: string): { attr(name: string): string; text(): string } | null;
	};
	unpackDeanEdwards(source: string): string | null;
	base64Decode(value: string): string;
	base64Encode(value: string): string;
	decodeJsUnicodeEscapes(source: string): string;
	parsePlayerSources(script: string): unknown[];
	findManifestUrls(text: string): string[];
}

/** Evaluated the way a bundle evaluates it: as module source, not as a call. */
async function runtime(): Promise<Runtime> {
	const source = `${DOM_RUNTIME_SOURCE}\nexport default globalThis.__yorozoRuntime;`;
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return (await import(/* @vite-ignore */ url)).default as Runtime;
}

describe('the generated plugin runtime', () => {
	it('is self-contained, because a bundle has no module resolution', () => {
		// An `import` here would be unresolvable inside the sandbox and the
		// failure would arrive as a load error on every converted plugin.
		expect(DOM_RUNTIME_SOURCE).not.toMatch(/^\s*import\s/m);
		expect(DOM_RUNTIME_SOURCE).not.toMatch(/^\s*export\s/m);
	});

	it('evaluates and provides every export the entry shims call', async () => {
		const rt = await runtime();
		for (const name of [
			'parseHtml',
			'unpackDeanEdwards',
			'decodeJsUnicodeEscapes',
			'parsePlayerSources',
			'findManifestUrls',
			'base64Decode',
			'base64Encode'
		]) {
			expect(typeof (rt as unknown as Record<string, unknown>)[name]).toBe('function');
		}
	});

	it('parses, selects and resolves the way the host-side copy does', async () => {
		const rt = await runtime();
		const doc = rt.parseHtml(
			'<ul><li class="row"><a href="/x">One &amp; Two</a></li></ul>',
			'https://example.invalid/base/'
		);

		expect(doc.select('li.row')).toHaveLength(1);
		expect(doc.selectFirst('li.row a')?.text()).toBe('One & Two');
		// `abs:` is the property scrapers rely on most, and the one that breaks
		// silently — a relative id is stored and stops resolving later.
		expect(doc.selectFirst('a')?.attr('abs:href')).toBe('https://example.invalid/x');
	});

	it('keeps the deobfuscation helpers working after bundling', async () => {
		const rt = await runtime();
		expect(rt.base64Encode('yorozo')).toBe('eW9yb3pv');
		expect(rt.base64Decode('eW9yb3pv')).toBe('yorozo');
		// Not packed, and saying so is the contract — an empty string here
		// would look like a successful unpack of nothing.
		expect(rt.unpackDeanEdwards('var plain = 1;')).toBeNull();
	});
});
