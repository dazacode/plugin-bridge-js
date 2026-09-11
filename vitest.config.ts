import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** One alias per package, matching `tsconfig.json`'s paths exactly. */
const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			'@plugin-bridge/core': at('./packages/core/src'),
			'@plugin-bridge/runtime': at('./packages/runtime/src'),
			'@plugin-bridge/adapters': at('./packages/adapters/src'),
			'@plugin-bridge/host': at('./packages/host/src')
		}
	},
	test: {
		include: ['packages/**/*.spec.ts'],
		// The Kotlin grammar is a 4 MB wasm and several suites load it.
		testTimeout: 60_000
	}
});
