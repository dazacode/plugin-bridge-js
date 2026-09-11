/**
 * That the headless isolate is no more capable than a browser Worker.
 *
 * This is the test `sandbox-host.spec.ts`'s own header says it cannot be. That
 * file drives an in-process double, because Node has no browser `Worker` and no
 * module-blob `import()`, so what it proves is the *host* half: the allowlist,
 * the storage cap, termination, an error surviving the boundary. It says plainly
 * that nothing proves `sandbox.worker.ts` actually seals its scope.
 *
 * Here there is a real isolate — a worker thread, running the runtime's own
 * worker body unchanged — so the sealing is observable for the first time in
 * either host, and it is observed the only way that means anything: by asking a
 * plugin what it can see.
 *
 * ## Why the capability list is asserted rather than described
 *
 * `HOST.md` §3.2 makes reproducing the browser's sealing an obligation on any
 * host that supplies an isolate, and ADR-0004 §8 makes failing it a
 * falsification of the whole document: *if the port cannot be implemented
 * headlessly without weakening the sandbox, "one runtime, many hosts" has a
 * floor at "browser-like hosts".* A comment claiming the globals are gone would
 * be exactly as reassuring and exactly as unverified as the situation this
 * replaces.
 *
 * The three that matter are different in kind. `fetch` is what the browser's own
 * list removes. `process` is what a Node worker adds and a browser never had —
 * the ambient capability ADR-0004 §4 warns about by name. `node:fs` is the one
 * that survives deleting globals, because a module specifier is not a global.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginSandbox, type RunnablePlugin } from '@plugin-bridge/host/sandbox-host';
import { headlessPluginHost, sandboxReport } from './headless-plugin-host';

const PLUGIN: RunnablePlugin = {
	id: 'com.example.plugins.probe',
	name: 'Probe',
	hosts: ['api.example.com']
};

/**
 * A plugin that reports what it can see, instead of what it can do.
 *
 * Every question is answered as a `searchCatalog` result, because that is a call
 * the ABI already has and the sandbox already carries a value back from. A
 * bundle that *used* the capability would prove the same thing and would also
 * make a request from a test.
 */
const PROBE_SOURCE = `
export default {
	id: 'com.example.plugins.probe',
	async searchCatalog(query) {
		if (query === 'globals') {
			return {
				entries: [],
				fetch: typeof fetch,
				process: typeof process,
				XMLHttpRequest: typeof XMLHttpRequest,
				WebSocket: typeof WebSocket,
				importScripts: typeof importScripts,
				Buffer: typeof Buffer,
				require: typeof require,
				self: typeof self,
				window: typeof window,
				ctxText: typeof arguments
			};
		}
		if (query === 'node') {
			try {
				const fs = await import('node:fs');
				return { entries: [], reached: typeof fs.readFileSync };
			} catch (error) {
				return { entries: [], refused: String(error && error.message) };
			}
		}
		return { entries: [] };
	}
};
`;

const scratch = mkdtempSync(join(tmpdir(), 'yorozo-headless-'));

afterAll(() => {
	rmSync(scratch, { recursive: true, force: true });
});

function host() {
	return headlessPluginHost({ dataDir: scratch, log: () => {} });
}

/**
 * The port's capabilities as the runtime's entry point takes them.
 *
 * Nothing in the runtime accepts a whole `PluginHost` (`HOST.md` §2), so this is
 * the same three-field mapping `web-plugin-registry.ts` performs — written out
 * rather than hidden in a helper, because it is the seam under test.
 */
function sandboxOptions() {
	const capabilities = host();
	return {
		fetcher: capabilities.fetch,
		createWorker: capabilities.sandbox,
		log: capabilities.log
	};
}

async function ask(query: string): Promise<Record<string, unknown>> {
	const sandbox = await PluginSandbox.start(PLUGIN, PROBE_SOURCE, {}, sandboxOptions());
	try {
		return (await sandbox.searchCatalog(query, 1)) as Record<string, unknown>;
	} finally {
		sandbox.dispose();
	}
}

describe('the headless isolate', () => {
	it('runs the runtime worker body and lets a bundle identify itself', async () => {
		const sandbox = await PluginSandbox.start(PLUGIN, PROBE_SOURCE, {}, sandboxOptions());
		try {
			// `PluginSandbox.start` refuses a bundle whose default export
			// disagrees with its manifest, so reaching here at all is the load
			// step of `FOREIGN.md` §6 passing in a real isolate.
			expect(await sandbox.searchCatalog('anything', 1)).toEqual({
				entries: []
			});
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('has removed every global the browser sandbox removes', async () => {
		const seen = await ask('globals');

		// The list `sandbox.worker.ts` deletes, asked for from inside. A browser
		// Worker would answer identically, which is the whole claim.
		expect(seen['fetch']).toBe('undefined');
		expect(seen['XMLHttpRequest']).toBe('undefined');
		expect(seen['WebSocket']).toBe('undefined');
		expect(seen['importScripts']).toBe('undefined');
	}, 30_000);

	it('has removed the globals a browser Worker never had', async () => {
		const seen = await ask('globals');

		// The ambient capabilities ADR-0004 §4 names: a Node worker has
		// `process`, and `Buffer` and `require` come with it. None of the three
		// exists in a browser Worker, so a plugin that finds one here is running
		// somewhere the client would never run it.
		expect(seen['process']).toBe('undefined');
		expect(seen['Buffer']).toBe('undefined');
		expect(seen['require']).toBe('undefined');
	}, 30_000);

	it('keeps the two a browser Worker does have', async () => {
		const seen = await ask('globals');

		// Sealing is not the same as emptying. `self` is the worker's own scope
		// and `window` is aliased to it by `sandbox.worker.ts` on purpose, for
		// bundles written against a page — removing either would fail modules
		// the browser host runs.
		expect(seen['self']).toBe('object');
		expect(seen['window']).toBe('object');
	}, 30_000);

	it('refuses a plugin that reaches for a Node builtin', async () => {
		const seen = await ask('node');

		// The escape that survives deleting globals, because a module specifier
		// is not a global. In a browser there is no such scheme, so the import
		// fails on its own; here it has to be made to fail.
		expect(seen['reached']).toBeUndefined();
		expect(String(seen['refused'])).toContain('node:fs');
	}, 30_000);

	it('says how tightly it could be closed, before anything runs in it', async () => {
		const report = await sandboxReport();

		// The isolate is a Node child process precisely so this answer is
		// `sealed` whatever runtime asked. A `porous` answer here would mean
		// every verdict this host produces is about a more capable environment
		// than the browser client's, which ADR-0004 §8 calls a falsification.
		expect(report?.containment).toBe('sealed');
		expect(report?.leftovers).toEqual([]);
	}, 30_000);
});

describe('an isolate that dies', () => {
	/**
	 * A plugin that rejects a promise nobody awaits.
	 *
	 * The shape a converted extension produces by accident: a `parallelMap`
	 * whose element throws after the member holding it already returned. Node
	 * takes the process down for one of those, and until the host read the
	 * isolate's stderr the only thing left to report was the exit code.
	 */
	const FLOATING = `
export default {
	id: 'com.example.plugins.probe',
	async searchCatalog() {
		Promise.reject(new Error('indexed into a value that was null'));
		await new Promise((resolve) => setTimeout(resolve, 50));
		return { entries: [] };
	}
};
`;

	it('names what the plugin threw, rather than only the exit code', async () => {
		const sandbox = await PluginSandbox.start(PLUGIN, FLOATING, {}, sandboxOptions());
		let reported = '';
		try {
			await sandbox.searchCatalog('a', 1);
		} catch (error) {
			reported = error instanceof Error ? error.message : String(error);
		} finally {
			sandbox.dispose();
		}

		// The cause, carried out of the isolate and into the sentence a reader
		// sees — not "The sandbox exited with code 1" on its own, which names
		// nothing and reads as a fault in the runtime.
		expect(reported).toContain('indexed into a value that was null');
		expect(reported).toContain('unhandled rejection');
	}, 30_000);
});

describe('the headless capabilities', () => {
	it('stores a bundle as a directory and reads one file back', async () => {
		const blobs = host().blobs;
		expect(blobs.isAvailable()).toBe(true);

		await blobs.write(
			'com.example.plugins.probe',
			new Map([
				['manifest.json', new TextEncoder().encode('{"id":"probe"}')],
				['payload/entry.js', new TextEncoder().encode('export default {};')]
			])
		);

		expect(await blobs.readText('com.example.plugins.probe', 'payload/entry.js')).toBe(
			'export default {};'
		);
		expect([...(await blobs.list())]).toContain('com.example.plugins.probe');

		// Replacement, not merge: a previous version must leave nothing behind.
		await blobs.write(
			'com.example.plugins.probe',
			new Map([['manifest.json', new TextEncoder().encode('{"id":"probe"}')]])
		);
		expect(await blobs.readText('com.example.plugins.probe', 'payload/entry.js')).toBeNull();

		await blobs.remove('com.example.plugins.probe');
		// Removing twice is the state the caller wanted, not an error.
		await blobs.remove('com.example.plugins.probe');
		expect([...(await blobs.list())]).not.toContain('com.example.plugins.probe');
	});

	it('answers null for a file that is not there rather than throwing', async () => {
		expect(await host().blobs.readText('com.example.plugins.absent', 'manifest.json')).toBeNull();
	});

	it('refuses an entry path that would climb out of its own directory', async () => {
		await expect(
			host().blobs.write(
				'com.example.plugins.probe',
				new Map([['../escaped.js', new TextEncoder().encode('nope')]])
			)
		).rejects.toThrow(/outside its own plugin directory/);
	});

	it('remembers a small answer across two stores over the same file', async () => {
		host().kv.set('kuro.plugins.checks.v1', '{"one":"works"}');
		// A fresh instance, because the point of the file is that it outlives the
		// object — a check remembered in a previous run must come back.
		expect(host().kv.get('kuro.plugins.checks.v1')).toBe('{"one":"works"}');
		expect(host().kv.get('nothing.stored.here')).toBeNull();
	});

	it('reads the runtime vendored artefacts and refuses anything else', async () => {
		const wasm = host().wasm;
		// The magic number, so this is the wasm and not a README that happened to
		// be at the path.
		expect([...(await wasm('tree-sitter-kotlin.wasm')).subarray(0, 4)]).toEqual([
			0x00, 0x61, 0x73, 0x6d
		]);
		await expect(wasm('../../../package.json')).rejects.toThrow(/no copy of/);
	});
});
