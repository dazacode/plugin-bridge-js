import { describe, expect, it } from 'vitest';

import { JS_RUNTIME } from './js-runtime';
import { kotlinRuntime } from './kotlin-runtime';
import { synchronyPrelude } from './synchrony';

/**
 * A stand-in for `lib/synchrony`'s prebuilt script, in the shape the upstream
 * wrapper rewrites: top-level declarations and one ES module export line.
 *
 * The real script is somebody else's, is not this repository's to carry, and
 * is not needed to test what this module does — which is the rewrite and the
 * two null answers, not deobfuscation. Its `deobfuscateSource` answers a
 * transformed copy of its input, so a test can tell it ran, and reads a
 * top-level binding and a `$` so the rewrite is seen to keep both intact.
 */
const SCRIPT = [
	'var up = "$&";',
	'var Hf = class { deobfuscateSource(e) { console.log("noisy"); return "clean:" + e + ":" + up; } };',
	'var me = class {};',
	'export{Hf as Deobfuscator,me as Transformer};'
].join('');

/* eslint-disable @typescript-eslint/no-explicit-any */
let loads = 0;

/** The Kotlin runtime with a prelude after it, as an entry places them. */
async function engine(script: string | undefined): Promise<any> {
	loads += 1;
	const source = [
		JS_RUNTIME,
		'var __rt = {};',
		kotlinRuntime(),
		synchronyPrelude(script),
		'export const SynchronyEngine_ = SynchronyEngine;',
		`/* load ${loads} */`
	].join('\n');
	const url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
	return ((await import(/* @vite-ignore */ url)) as { SynchronyEngine_: any }).SynchronyEngine_;
}

describe("lib/synchrony's deobfuscator, embedded", () => {
	it("runs the repository's script on the site's source", async () => {
		const synchrony = await engine(SCRIPT);
		expect(synchrony.deobfuscate('packed()')).toBe('clean:packed():$&');
	});

	it('answers null with no script, as the upstream wrapper does for a missing asset', async () => {
		const synchrony = await engine(undefined);
		expect(synchrony.deobfuscate('packed()')).toBeNull();
	});

	it('answers null when the export line is not the one the wrapper rewrites', async () => {
		const synchrony = await engine(SCRIPT.replace('as Transformer', 'as Other'));
		expect(synchrony.deobfuscate('packed()')).toBeNull();
	});

	it("keeps the script's top-level names out of the bundle's scope", () => {
		const prelude = synchronyPrelude(SCRIPT);
		expect(prelude).toContain('__synchronyFactory = function () {');
		expect(prelude).not.toContain('export{');
		// Declared inside the factory, so a translated class named `up` or `Hf`
		// cannot collide with the script's minified bindings.
		expect(prelude.indexOf('var up')).toBeGreaterThan(prelude.indexOf('function (console)'));
	});

	it('is nothing at all for a conversion that never reached it', () => {
		expect(synchronyPrelude(undefined)).toBe('');
	});
});
