/**
 * Turning a Node process into something no more capable than a browser Worker.
 *
 * This is the entry point of the headless host's isolate. It is **not** the
 * sandbox: `packages/host/src/sandbox.worker.ts` is, and it is imported
 * unchanged at the bottom of this file. What lives here is only the adaptation
 * — the part that is a fact about Node rather than a fact about running a
 * plugin. `HOST.md` §5 draws that line: *the worker bodies stay in the port*,
 * because what a sandbox deletes from its own scope is a contract and not a
 * per-host decision. That line is now also a package boundary: the body is in
 * `@plugin-bridge/host`, this adaptation is in `@plugin-bridge/host-node`.
 *
 * ## The caveat this file exists to answer
 *
 * `HOST.md` §3.2 and ADR-0004 §4 both say it in the same words: **a Node worker
 * is not a sandbox.** It has ambient `fetch`, ambient `process`, a filesystem,
 * and — the one that is easy to miss — a module loader that will hand a plugin
 * `node:fs` on request. A host that ran a plugin in that environment would not
 * have implemented this port; it would have implemented something that looks
 * like it and answers differently. The difference is not academic: this host is
 * the conversion laboratory, so a check that ran in a *more* capable environment
 * would report green on a plugin the browser client refuses, which is the one
 * outcome a second host exists to make impossible.
 *
 * So, in order:
 *
 * 1. **`self` is `globalThis`, not a stand-in for it.** This matters more than
 *    it looks. `sandbox.worker.ts` seals its scope by deleting properties from
 *    `self`; if `self` were a plain object wired to the transport, every one of
 *    those deletes would silently succeed against an object nobody reads, and
 *    the plugin would keep the ambient `fetch` the sealing was supposed to take
 *    away. A sandbox that reports success while doing nothing is worse than one
 *    that throws.
 * 2. **The Node-only globals go**, because a browser Worker does not have them.
 *    `sandbox.worker.ts` owns the browser list and runs it on every load in both
 *    hosts; this owns only the difference between the two environments.
 * 3. **Module resolution from inside the sandbox is refused**, except the
 *    `data:` URL the bundle itself is evaluated from. Deleting `process` does
 *    not stop `await import('node:fs')`, and that is the escape that would make
 *    this environment strictly more capable than a browser's.
 * 4. **`URL.createObjectURL` answers with a `data:` URL.** Node's ESM loader
 *    supports `file:`, `data:` and `node:` and nothing else, so the blob-module
 *    import `sandbox.worker.ts` performs would fail outright. Rewriting the
 *    object URL here is what makes one runtime contract serve both hosts,
 *    without the runtime knowing which one it is in.
 *
 * ## Why this is a process and not a thread, and why it must be Node
 *
 * Both were built and one was measured to be a lie. A **bun** worker thread
 * cannot be sealed: `globalThis.Bun` is `writable: false, configurable: false`,
 * so it survives every attempt to remove it, and `Bun.file`, `Bun.spawn`,
 * `Bun.write` and `Bun.FFI` are a filesystem, a process launcher and arbitrary
 * native code hanging off a property a plugin can simply read. bun also has no
 * module-resolution hook and refuses to let `Bun.plugin` override a builtin, so
 * step 3 has nothing to hook. That is not a smaller sandbox; it is a different
 * one, and `HOST.md` §3.2 is explicit that a host running a plugin in a more
 * capable environment has not implemented this port.
 *
 * A **Node** worker thread seals correctly. But the check tool runs under bun
 * (rule 14) and a bun process cannot spawn a Node thread — so the isolate is a
 * *child process*, which every runtime can start and which every runtime can
 * kill. `terminate()` becomes a real kill rather than a request, which is
 * stronger containment than a browser Worker offers, not weaker.
 *
 * The transport is newline-delimited JSON over stdio, because bun and Node do
 * not share an IPC channel implementation — a Node child forked from bun never
 * gets a `process.send`. The sandbox protocol is JSON-shaped throughout
 * (`sandbox.worker.ts`), so nothing is lost that a structured clone was
 * carrying; `docs/KNOWN_GAPS.md` records the one theoretical difference.
 *
 * ## Also stricter than a browser, deliberately
 *
 * A blob module in a browser may `import('https://…')`, which is a network
 * capability that goes nowhere near `ctx.http` or the plugin's allowlist. Step 3
 * refuses that here. Being *stricter* cannot turn a plugin the browser refuses
 * into one this host accepts, which is the direction that would matter; and no
 * bundle this project produces has an import at all, because the packager emits
 * one self-contained module.
 */

// Static, and relative for the reason the worker body's import below is: this
// file is a bare node entry point with nothing mapped. Resolved before step 3
// seals module resolution, which is what lets the transport use it at all.
import { encodeFrame, FrameReader } from '../../host/src/net/frames.ts';

/**
 * Everything needed from the environment, captured before any of it is removed.
 *
 * Order is the whole trick: `process` and `Buffer` are deleted below, because a
 * browser Worker has neither, and the transport and the `data:` URL shim need
 * them. A reference taken now survives the delete; a lookup afterwards would not.
 */
const input = process.stdin;
const output = process.stdout;
const errors = process.stderr;
const die = process.exit.bind(process);
const onProcess = process.on.bind(process);
const bytes = Buffer;

const scope = globalThis as unknown as Record<string, unknown>;

/* ── 1. `self` is this realm's own global object ──────────────────────────── */

/**
 * Messages that arrived before the realm was ready to serve them.
 *
 * The runtime's worker body is imported asynchronously and the globals are
 * removed after it, so a host that posts `load` immediately — which is exactly
 * what `PluginSandbox.start` does — would otherwise have it evaluated in a realm
 * that still had `process`. A browser Worker has the same race and the same
 * answer: events queue until the scope is ready for them.
 */
const queued: unknown[] = [];
let ready = false;

function deliver(data: unknown): void {
	const handler = scope['onmessage'] as ((event: { data: unknown }) => void) | undefined;
	if (!ready || typeof handler !== 'function') {
		queued.push(data);
		return;
	}
	handler({ data });
}

/**
 * Frames in (`host/src/net/frames.ts`): one JSON value per line, and the raw
 * bytes it carries after it — an http body from the host arrives this way, as
 * the source sent it. Read as bytes, never as utf8, because a chunk may end in
 * the middle of those bytes. Partial frames are held until they finish.
 */
const frames = new FrameReader();
input.on('data', (chunk: Uint8Array) => {
	for (const message of frames.push(chunk)) deliver(message);
});

scope['self'] = scope;
/* Frames out, for the same reason: a served response carries bytes. */
scope['postMessage'] = (value: unknown): void => {
	output.write(encodeFrame(value));
};
// Created up front so `self.onmessage = …` is an ordinary assignment; the
// dispatcher reads the property fresh on every message.
scope['onmessage'] = undefined;

/**
 * What the isolate says before it dies, so its death names a cause.
 *
 * A converted plugin can reject a promise nobody awaited — a `parallelMap` whose
 * element threw, a request that failed after the member it belonged to already
 * returned — and Node's answer to that is to take the process down. The host
 * then had nothing to report but the exit code, so an ordinary
 * "indexed into a value that was null" reached a reader as
 * "The sandbox exited with code 1", which names nothing and reads like a
 * mystery in the runtime. It was one, once, for an afternoon.
 *
 * Reported and *then* exited, deliberately: an uncaught throw leaves a realm in
 * a state nothing here can vouch for, and containment is the point of running a
 * plugin in its own process. What changes is only that the host is told what
 * happened — `ProcessWorker.diagnosis` reads this line back off stderr.
 *
 * Node's own default printing is replaced rather than added to, because a
 * module that throws while evaluating prints its own source, and these bundles
 * are one `data:` URL of several hundred kilobytes.
 */
function lastWords(kind: string, cause: unknown): void {
	const message =
		cause instanceof Error
			? `${cause.name}: ${cause.message}`
			: `Error: ${typeof cause === 'string' ? cause : JSON.stringify(cause)}`;
	errors.write(`${message} (${kind} inside the sandbox)\n`);
	die(1);
}

onProcess('uncaughtException', (cause: unknown) => lastWords('uncaught', cause));
onProcess('unhandledRejection', (cause: unknown) => lastWords('unhandled rejection', cause));

/* ── 2. the globals a browser Worker does not have ────────────────────────── */

/**
 * Node's additions to the global scope, by name.
 *
 * Deleted rather than stubbed with a thrower, for the reason the runtime already
 * gives: a bundle doing feature detection should take the branch that uses
 * `ctx`, not the branch that throws at runtime.
 *
 * `Bun` is on the list even though the isolate is a Node process, because a
 * list that is right only as long as nobody changes how the isolate is started
 * is a list waiting to be wrong.
 */
const NOT_IN_A_BROWSER = [
	'process',
	'Buffer',
	'global',
	'setImmediate',
	'clearImmediate',
	'require',
	'module',
	'exports',
	'__dirname',
	'__filename',
	'gc',
	'Bun',
	'HTMLRewriter'
];

function removeHostGlobals(): void {
	for (const name of NOT_IN_A_BROWSER) {
		try {
			delete scope[name];
		} catch {
			// Non-configurable, which under bun is `Bun` itself and is why this
			// isolate is a Node process. Reported rather than assumed away:
			// `containment` below is what the host is told.
		}
	}
}

/** Whether anything on the list survived being deleted. */
function leftovers(): string[] {
	return NOT_IN_A_BROWSER.filter((name) => scope[name] !== undefined);
}

/* ── 3. no module resolution except the bundle's own ──────────────────────── */

async function refuseModuleResolution(): Promise<boolean> {
	const loader = (await import('node:module')) as unknown as {
		registerHooks?: (hooks: Record<string, unknown>) => void;
	};
	// Present from Node 22.15. Absent under bun, which is the other half of why
	// this isolate is a Node process.
	if (typeof loader.registerHooks !== 'function') return false;

	loader.registerHooks({
		resolve(
			specifier: string,
			context: unknown,
			next: (specifier: string, context: unknown) => unknown
		): unknown {
			// The bundle itself, and nothing else. `sandbox.worker.ts` evaluates a
			// plugin by importing a module URL, and after the shim below that URL
			// is a `data:` one — so this is the plugin being loaded, not the plugin
			// reaching for something.
			if (specifier.startsWith('data:')) return next(specifier, context);
			throw new Error(
				`A plugin may not import ${specifier}. It has the capabilities its host granted ` +
					'it, and no others.'
			);
		}
	});
	return true;
}

/* ── 4. an object URL Node's loader will actually import ──────────────────── */

/** The one Blob the runtime makes, kept where `createObjectURL` can read it. */
const SOURCE = Symbol('bundle source');

/**
 * `Blob` and `URL.createObjectURL`, rewritten to produce a `data:` URL.
 *
 * `createObjectURL` is synchronous and Node's `Blob` has no synchronous reader,
 * so the two are shimmed together: the Blob remembers the strings it was built
 * from and the object URL encodes them.
 *
 * A **subclass** rather than a replacement, so a bundle that uses `Blob` for
 * anything else still gets the real one. Only the module-evaluation path needs
 * the string back — `new Blob([source], { type })`, then `createObjectURL`, then
 * `revokeObjectURL` — and that path always builds one from a string this process
 * already holds.
 *
 * `revokeObjectURL` becomes a no-op, which is the honest translation: a `data:`
 * URL holds no resource to release, and the module graph keeps its own reference
 * to what it evaluated either way.
 */
function useDataUrls(): void {
	const Native = scope['Blob'] as new (parts?: readonly unknown[], options?: unknown) => object;

	class DataBlob extends Native {
		readonly [SOURCE]: string | null;

		constructor(parts: readonly unknown[] = [], options: { type?: string } = {}) {
			super(parts, options);
			this[SOURCE] = parts.every((part) => typeof part === 'string') ? parts.join('') : null;
		}
	}

	scope['Blob'] = DataBlob;

	const target = URL as unknown as {
		createObjectURL(blob: unknown): string;
		revokeObjectURL(url: string): void;
	};

	target.createObjectURL = (blob: unknown): string => {
		const source = (blob as { [SOURCE]?: string | null })[SOURCE];
		if (typeof source !== 'string') {
			throw new TypeError('This host can only make an object URL of a Blob built from text.');
		}
		const type = (blob as { type?: string }).type;
		const encoded = bytes.from(source, 'utf8').toString('base64');
		return `data:${type === undefined || type === '' ? 'text/javascript' : type};base64,${encoded}`;
	};
	target.revokeObjectURL = (): void => {};
}

/* ── the sandbox itself, unchanged ────────────────────────────────────────── */

/**
 * What this realm managed, sent before anything else.
 *
 * The host reads it, does not forward it to the runtime, and reports it beside
 * every verdict: a green row from a realm that could not be closed is a weaker
 * claim than a green row from one that could, and a scoreboard that did not say
 * which would be quietly averaging the two.
 */
export interface SandboxReady {
	readonly bootstrap: 'ready';
	readonly containment: 'sealed' | 'porous';
	/** Anything on the removal list that survived. Empty in a sealed realm. */
	readonly leftovers: readonly string[];
}

/**
 * Runs the adaptation in the one order that works, then hands over.
 *
 * The import of the runtime's worker body happens *before* module resolution is
 * closed, because closing it first would refuse this file's own import. Nothing
 * a plugin can do runs in between: `sandbox.worker.ts` evaluates no bundle until
 * it is sent a `load` message, and messages are queued until the last line here.
 */
async function bootstrap(): Promise<void> {
	useDataUrls();
	// A relative path across the two packages, and it has to be one. This file
	// is spawned as the *entry point* of a bare `node`, which strips types and
	// resolves nothing else: no bundler, no workspace path mapping, no
	// `node_modules` link to `@plugin-bridge/host`. The specifier the rest of
	// this package writes would resolve here only by luck.
	await import('../../host/src/sandbox.worker.ts');
	const sealed = await refuseModuleResolution();
	removeHostGlobals();
	const remaining = leftovers();

	output.write(
		`${JSON.stringify({
			bootstrap: 'ready',
			containment: sealed && remaining.length === 0 ? 'sealed' : 'porous',
			leftovers: remaining
		} satisfies SandboxReady)}\n`
	);

	ready = true;
	for (const message of queued.splice(0)) deliver(message);
}

void bootstrap();
