/**
 * Translating Kotlin off the main thread.
 *
 * Converting one extension is around 35ms of synchronous work, and checking a
 * repository does that for every listing in it — nine seconds of blocked main
 * thread for a catalogue of 254. Yielding between files made that survivable to
 * look at, but it did not make it smaller: the same work still ran where the
 * page is painted from.
 *
 * ## Why this one needs no protocol, where the sandbox does
 *
 * `sandbox.worker.ts` runs plugin code, so it must call *back* to the host for
 * every request a plugin makes, and most of its size is that protocol.
 * Translation is not like that. By the time it starts, the adapter has already
 * fetched the source; translating is a pure function from text to text with no
 * capability of its own, so this worker takes strings and answers with a plain
 * record. One message each way, nothing to marshal, nothing to guard.
 *
 * That also means the worker needs no sandboxing. It is our code, translating
 * text, with no network and no storage — the isolation it provides is a
 * scheduling one, not a security one, and pretending otherwise would invite
 * somebody to run plugin code in here later.
 *
 * ## The grammar is loaded once, here
 *
 * The 4 MB wasm is instantiated in this worker rather than on the main thread,
 * so the first conversion pays for it off the critical path and every one after
 * it reuses the same parser — `loadKotlinGrammar` memoises per realm, and a
 * worker is its own realm.
 *
 * ## Why the artefacts arrive in a message
 *
 * A worker is its own realm, and this one is *runtime* code: it cannot resolve
 * the vendored wasm against `import.meta.url`, because that is a fact about the
 * host's bundler and `HOST.md` §2 says the runtime takes no such fact. So the
 * bytes come from the host, through `translate-host.ts`, as one `init` message
 * before any work is posted. It costs one structured clone of about 4.6 MB per
 * worker — and there is one worker — which is cheaper than the alternative of
 * giving every realm its own way to find a file.
 */

import type { WasmLoader } from '@plugin-bridge/host/host';
import { convertKotlin, type KotlinConversion, type KotlinFile } from './pipeline';

/**
 * The host handing over the runtime's own vendored artefacts, by file name.
 *
 * Sent once, immediately after the worker is constructed and before any
 * request. A request arriving first is a host bug rather than a state to
 * recover from, and it fails saying so.
 */
export interface TranslateInit {
	readonly init: true;
	readonly assets: Readonly<Record<string, Uint8Array>>;
}

/** What the host asks for. */
export interface TranslateRequest {
	readonly id: number;
	readonly files: readonly KotlinFile[];
}

/** What it gets back. Structurally cloneable; there is nothing else in it. */
export type TranslateReply =
	| { readonly id: number; readonly ok: true; readonly value: KotlinConversion }
	| { readonly id: number; readonly ok: false; readonly error: string };

/** The artefacts this realm was given, or null until the host hands them over. */
let assets: Readonly<Record<string, Uint8Array>> | null = null;

const wasm: WasmLoader = (name) => {
	const bytes = assets?.[name];
	if (bytes === undefined) {
		return Promise.reject(new Error(`The translator was not given ${name}.`));
	}
	return Promise.resolve(bytes);
};

self.onmessage = async (event: MessageEvent<TranslateInit | TranslateRequest>) => {
	if ('init' in event.data) {
		assets = event.data.assets;
		return;
	}
	const { id, files } = event.data;

	try {
		// No interleaving in here: nothing paints in a worker, and this worker
		// serves one message at a time, so yielding between files would slow the
		// translation down to give a turn to nobody.
		const value = await convertKotlin(files, { interleave: false, wasm });
		// `postMessage` structured-clones, and every field of a conversion is a
		// string, number, boolean, array or plain object. A `Map` would clone
		// too; a function or a class instance would not, which is why the
		// pipeline returns records rather than the tree it built them from.
		self.postMessage({ id, ok: true, value } satisfies TranslateReply);
	} catch (error) {
		self.postMessage({
			id,
			ok: false,
			error: error instanceof Error ? error.message : String(error)
		} satisfies TranslateReply);
	}
};
