/**
 * The entry the plugin runtime bundle is built from.
 *
 * Converted bundles are one self-contained ES2020 module (`ABI.md` §1). There
 * is no module resolution inside the sandbox, so a converted scraper cannot
 * `import` the HTML parser it needs — the parser has to travel *into* the
 * bundle as source text.
 *
 * `dom.ts` and `extract/patterns.ts` are the two pieces that qualify: both are
 * dependency-free, both are already written to the engine subset, and both are
 * what a foreign scraper reaches for. This file names exactly what crosses that
 * line. Anything not listed here is host-side only.
 *
 * `tool/gen-plugin-runtime.ts` bundles this into `generated/dom-source.ts`.
 * Nothing imports this file at runtime; it exists to be a build input.
 */

import { parseHtml } from './dom';
import {
	base64Decode,
	base64Encode,
	decodeJsUnicodeEscapes,
	findManifestUrls,
	parsePlayerSources,
	unpackDeanEdwards
} from '@plugin-bridge/core/extract/patterns';

// Assigned onto `globalThis` rather than exported, because the output is
// inlined into a larger module as an IIFE and an `export` cannot be nested.
(globalThis as unknown as Record<string, unknown>)['__yorozoRuntime'] = {
	parseHtml,
	unpackDeanEdwards,
	decodeJsUnicodeEscapes,
	parsePlayerSources,
	findManifestUrls,
	base64Decode,
	base64Encode
};
