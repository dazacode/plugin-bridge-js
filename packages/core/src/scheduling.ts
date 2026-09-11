/**
 * Giving the browser a chance to paint in the middle of a long conversion.
 *
 * Converting one extension is around 60ms of *synchronous* work — parse the
 * Kotlin, translate it, hash and zip the bundle — and checking a repository does
 * that for every listing in it. None of it touches the DOM, but all of it runs
 * on the main thread, so the effect on a viewer is that the page stops
 * responding for as long as the check takes. A 60ms block is four dropped
 * frames; two hundred of them back to back is an application that appears to
 * have crashed.
 *
 * The honest fix is to run conversion in a Worker, and that is a larger change
 * than this one: the converter is handed `getText` and `listFiles` as
 * closures over the registry's fetcher, so moving it off-thread means a message
 * protocol for those, not a `postMessage` of the input. This is the smaller
 * change that makes the difference a viewer actually feels — the same total
 * work, broken into pieces the event loop can interleave with rendering.
 *
 * ## Why a macrotask and not a microtask
 *
 * `queueMicrotask` and a resolved promise both run *before* the browser gets to
 * paint, so yielding through either changes nothing a viewer can see. Only a
 * macrotask gives up the turn. `scheduler.yield()` is the purpose-built version
 * of that and keeps the continuation at the front of the queue rather than
 * behind every pending timer, so it is preferred where it exists.
 */

interface Scheduler {
	yield?: () => Promise<void>;
}

/**
 * Yields the main thread, once.
 *
 * Cheap enough to call in a loop: on a host with `scheduler.yield` it is a
 * task hop, and on one without it is a zero-delay timer, which is the same
 * thing with a worse queue position.
 */
export function yieldToHost(): Promise<void> {
	const scheduler = (globalThis as { scheduler?: Scheduler }).scheduler;
	if (scheduler !== undefined && typeof scheduler.yield === 'function') {
		return scheduler.yield();
	}
	return new Promise<void>((resolve) => {
		const channel = messageChannel();
		if (channel === null) {
			setTimeout(resolve, 0);
			return;
		}
		channel.port1.onmessage = () => {
			channel.port1.onmessage = null;
			channel.port1.close();
			channel.port2.close();
			resolve();
		};
		channel.port2.postMessage(0);
	});
}

/**
 * A message channel, when the host has one.
 *
 * `setTimeout(0)` is the obvious macrotask and the wrong one: browsers clamp a
 * zero delay to about four milliseconds, and clamp nested timers harder still,
 * so a loop that yields through it spends most of its wall-clock waiting for
 * timers rather than working. Measured on this converter, yielding every file
 * through `setTimeout` made a conversion 57% slower.
 *
 * A `MessageChannel` post is a macrotask with no clamp — it gives the host its
 * turn to paint and comes straight back. That is the whole difference between
 * "responsive and a little slower" and "responsive and half the speed".
 */
function messageChannel(): MessageChannel | null {
	const constructor = (globalThis as { MessageChannel?: typeof MessageChannel }).MessageChannel;
	if (constructor === undefined) return null;
	try {
		return new constructor();
	} catch {
		return null;
	}
}

/**
 * Yields only when the current run of work has gone on long enough to matter.
 *
 * Yielding after every item would be correct and slow: a task hop costs more
 * than translating a small file, so a loop that hops per file spends most of
 * its time in the scheduler. This keeps a budget instead — work until the
 * frame's worth of time is gone, then let the host in.
 *
 * Construct one per loop; it is stateful.
 */
export function frameBudget(milliseconds = 12): () => Promise<void> {
	let since = now();
	return async (): Promise<void> => {
		if (now() - since < milliseconds) return;
		await yieldToHost();
		since = now();
	};
}

function now(): number {
	// `performance` is present in browsers, Workers and Node, but this module is
	// also inlined into places with neither, so the fallback is not decorative.
	const timer = (globalThis as { performance?: { now(): number } }).performance;
	return timer === undefined ? Date.now() : timer.now();
}
