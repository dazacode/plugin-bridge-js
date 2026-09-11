/**
 * The host side of off-thread translation, and the reason it can fall back.
 *
 * `translate.worker.ts` does the work; this decides where. There is often
 * nowhere — the specs run in Node, the registry is constructed during SSR — and
 * a host that threw in either case would turn a scheduling optimisation into a
 * portability failure. So the contract is that the answer is identical whether
 * it was computed in a worker or inline, and only *where* differs.
 *
 * ## One worker, and the pool that was measured and rejected
 *
 * Checking a repository runs three listings at a time, and with a single worker
 * all three queue behind one another — so a pool looks like free parallelism.
 * It is not. Measured over 45 real extensions driven three at a time:
 *
 *     1 worker    1599 ms    35.5 ms each
 *     2 workers   1521 ms    33.8 ms each
 *     3 workers   2307 ms    51.3 ms each
 *
 * Two is within noise of one and three is **44% worse**. Each worker
 * instantiates its own copy of a 4 MB grammar, and that — with the structured
 * clone of every file in and every conversion out — costs more than the
 * parallelism returns at this size of job.
 *
 * Written down rather than left as an absence, because a pool is the obvious
 * next idea and somebody will have it again. If translation ever gets cheap
 * enough that grammar instantiation stops dominating, this is worth
 * re-measuring; until then one worker is both simpler and faster.
 *
 * ## Why workers are kept alive
 *
 * Instantiating the grammar is nearly all of the cost of starting one, so a
 * worker torn down between listings would pay for it once per listing. They are
 * created on first use and kept; `stopTranslating` exists for teardown and for
 * tests, which must not leak one run's workers into the next.
 */

import type { WasmLoader, WorkerFactory } from '@plugin-bridge/host/host';
import { TREE_SITTER_KOTLIN, TREE_SITTER_RUNTIME } from './grammar';
import { convertKotlin, type KotlinConversion, type KotlinFile } from './pipeline';
import type { TranslateInit, TranslateReply } from './translate.worker';

export interface TranslateOptions {
	/**
	 * The isolate to translate in, from the host.
	 *
	 * Absent — or returning null — means there is not one, which is a
	 * supported state and not a degraded one: the fallback is `convertKotlin`
	 * on this thread, which is the same function producing the same answer.
	 * The browser shell builds one from `new URL('./translate.worker.ts',
	 * import.meta.url)`, and that line lives there rather than here because it
	 * is an instruction to Vite rather than a fact about translation.
	 */
	readonly createWorker?: WorkerFactory;
	/**
	 * The host's loader for the runtime's own vendored parser artefacts.
	 *
	 * Needed on **both** paths and for the same reason: a worker is its own
	 * realm and cannot resolve an asset relative to a bundle it knows nothing
	 * about, so the bytes are read here and posted into it (`TranslateInit`),
	 * and the inline fallback hands the same loader to `convertKotlin`. A host
	 * without one converts nothing in this ecosystem and says so —
	 * `HOST.md` §2.0.
	 */
	readonly wasm?: WasmLoader;
	/**
	 * Forces the inline path.
	 *
	 * Not only for tests: a caller translating one extension because somebody
	 * pressed Install is better served synchronously than by starting a worker
	 * and loading a grammar into it for a single job.
	 */
	readonly inline?: boolean;
	/** Overrides the pool size. For specs that need to know how many exist. */
	readonly workers?: number;
}

interface Pending {
	resolve(value: KotlinConversion): void;
	reject(error: Error): void;
}

/** One worker and what it is carrying, so work goes to the least-busy one. */
interface Slot {
	readonly worker: Worker;
	inflight: number;
	/**
	 * Resolves once the vendored artefacts have been posted into that realm.
	 *
	 * Awaited before the first request rather than blocking `spawn`, which is
	 * called from a synchronous chooser. A rejection here is the host having no
	 * assets, which is the same refusal the inline path would raise.
	 */
	readonly ready: Promise<void>;
}

const pool: Slot[] = [];
let unavailable = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * One, on the measurement in this file's header.
 *
 * The plumbing for more is deliberately still here: `workers` lets the
 * benchmark that produced those numbers run again, and a future in which
 * translation gets cheap enough for a pool to pay is a one-line change rather
 * than a rewrite. What is not here is a `hardwareConcurrency` heuristic —
 * cores were never the constraint, grammar instantiation was.
 */
function poolSize(): number {
	return 1;
}

/**
 * Translates one extension, off the main thread where that is possible.
 *
 * Falls back to translating inline — same function, same answer — when there is
 * no `Worker`, when one cannot be constructed, or when the caller asks.
 */
export async function translateKotlin(
	files: readonly KotlinFile[],
	options: TranslateOptions = {}
): Promise<KotlinConversion> {
	if (options.inline === true) return await convertKotlin(files, { wasm: options.wasm });

	const slot = leastBusy(options);
	if (slot === null) return await convertKotlin(files, { wasm: options.wasm });

	await slot.ready;

	const id = nextId;
	nextId += 1;
	slot.inflight += 1;

	try {
		return await new Promise<KotlinConversion>((resolve, reject) => {
			pending.set(id, { resolve, reject });
			slot.worker.postMessage({ id, files });
		});
	} finally {
		slot.inflight -= 1;
	}
}

/**
 * The worker with the least work on it, growing the pool until it is full.
 *
 * Grown lazily rather than all at once: a viewer who converts a single
 * extension should pay for one worker and one grammar, not three.
 */
function leastBusy(options: TranslateOptions): Slot | null {
	if (unavailable) return null;

	const wanted = options.workers ?? poolSize();
	if (pool.length < wanted && (pool.length === 0 || pool.every((slot) => slot.inflight > 0))) {
		const created = spawn(options);
		if (created !== null) pool.push(created);
	}
	if (pool.length === 0) return null;

	let best = pool[0];
	for (const slot of pool) {
		if (slot.inflight < best.inflight) best = slot;
	}
	return best;
}

function spawn(options: TranslateOptions): Slot | null {
	try {
		const worker = options.createWorker?.() ?? null;
		if (worker === null) {
			// No isolate from this host. Remembered so 254 listings do not each
			// ask again, exactly as a failed construction is.
			unavailable = true;
			return null;
		}

		worker.onmessage = (event: MessageEvent<TranslateReply>) => {
			const reply = event.data;
			const waiting = pending.get(reply.id);
			if (waiting === undefined) return;
			pending.delete(reply.id);
			if (reply.ok) waiting.resolve(reply.value);
			else waiting.reject(new Error(reply.error));
		};

		// A worker that dies takes every in-flight translation with it, and a
		// promise nobody settles is a check that never finishes and a spinner
		// that never stops. The dead one is dropped so the next call starts a
		// fresh one rather than posting into a corpse.
		worker.onerror = () => {
			const index = pool.findIndex((slot) => slot.worker === worker);
			if (index !== -1) pool.splice(index, 1);

			const waiting = [...pending.values()];
			pending.clear();
			for (const one of waiting) {
				one.reject(new Error('The translator stopped before it answered.'));
			}
		};

		// One clone of about 4.6 MB, once per worker, before anything is asked
		// of it. The runtime cannot find these itself (`HOST.md` §2), and a
		// realm that has not been given them refuses by name rather than
		// parsing against nothing.
		const ready = (async () => {
			const load = options.wasm;
			if (load === undefined) return;
			const [runtime, kotlin] = await Promise.all([
				load(TREE_SITTER_RUNTIME),
				load(TREE_SITTER_KOTLIN)
			]);
			worker.postMessage({
				init: true,
				assets: {
					[TREE_SITTER_RUNTIME]: runtime,
					[TREE_SITTER_KOTLIN]: kotlin
				}
			} satisfies TranslateInit);
		})();

		return { worker, inflight: 0, ready };
	} catch {
		// The host offered an isolate and building it threw. Remembered so 254
		// listings do not each throw their way here.
		unavailable = true;
		return null;
	}
}

/** Ends every worker and fails anything still waiting. For teardown, and tests. */
export function stopTranslating(): void {
	const waiting = [...pending.values()];
	pending.clear();
	for (const one of waiting) one.reject(new Error('Translation was stopped.'));

	for (const slot of pool) slot.worker.terminate();
	pool.length = 0;
	unavailable = false;
}
