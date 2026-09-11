/**
 * The host port: everything the plugin runtime needs from the thing running it.
 *
 * `contract/plugin-api/ABI.md` says what a *plugin* is. This says what a
 * **host** is, and `contract/plugin-api/HOST.md` is its normative half — the
 * two files are meant to be read together, and this one is the version a
 * compiler checks.
 *
 * The runtime under `src/lib/plugins/` is ordinary portable JavaScript: it
 * imports nothing from the app, nothing from SvelteKit, and reaches for no
 * ambient global. Everything it cannot compute for itself — the network, an
 * isolate to run a plugin in, somewhere to put files, somewhere to remember a
 * small answer, a second isolate for translation, and a log — arrives through
 * one of the interfaces below. `tool/check-runtime-boundary.ts` is what stops
 * the tenth import and the first `navigator` from appearing anyway.
 *
 * ## Why the defaults refuse rather than throw at import time
 *
 * Every capability here has a "this host does not have one" value, and each is
 * a *refusal*, not a crash: no blobs means plugins cannot be installed, no
 * sandbox means none can be started, no worker means translation happens
 * inline. That is deliberate and it is what the browser already does — OPFS is
 * absent in private browsing and `bundle-store.ts` has always degraded to
 * "plugins cannot be stored here" rather than taking a settings screen down
 * with it. The port keeps that property instead of replacing it with a
 * required argument that every spec, the Kotlin survey and server-side
 * rendering would each have to satisfy before they could ask an unrelated
 * question.
 *
 * ## A Worker is not the boundary
 *
 * `sandbox` hands back an isolate, and the runtime treats it as *containment*
 * (it can be terminated) rather than as *authority*. Authority lives in
 * `sandbox-host.ts`, which answers a plugin's requests against its declared
 * host list and refuses the rest. A host whose isolate is more capable than a
 * browser Worker — a Node worker thread has ambient `fetch`, `process` and a
 * filesystem — therefore does not get a weaker allowlist, but it does get a
 * plugin that could reach past it. HOST.md §3 states the obligation: a host
 * supplying its own isolate must strip it the way `sandbox.worker.ts` does,
 * or a check run there is green on plugins this client would refuse.
 */

/**
 * The one network call the runtime makes on its own behalf.
 *
 * Deliberately `fetch`-shaped rather than something narrower: the browser
 * passes the real `fetch` through to a proxy route, a headless host passes an
 * unrestricted one, and a spec passes a function that answers from a fixture.
 * Widening it to `RequestInfo` would buy nothing — every caller in the runtime
 * has a string.
 */
export type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * A directory per plugin, addressed by plugin id.
 *
 * The shape is the point rather than an implementation detail. A bundle is a
 * tree of files — `manifest.json`, `payload/<entrypoint>.js`, whatever else it
 * carries — and the Dart client stores it as a directory
 * (`lib/core/plugins/plugin_store.dart`), so a port shaped like a filesystem
 * is one mental model across every host instead of one per host. A key-value
 * store with slashes in the keys would work and would immediately start
 * disagreeing with the other client about what "delete a plugin" means.
 *
 * Paths inside a bundle may contain `/`; an implementation is expected to
 * create the intermediate directories. Callers have already refused traversal
 * (`isSafeEntryName`), and `bundle-store.ts` refuses it again before calling
 * here, so an implementation may treat a path as well-formed — but it is a
 * boundary, and re-checking is cheap.
 */
export interface BlobStore {
	/**
	 * Whether this host can store plugin files at all.
	 *
	 * Separate from letting `write` fail, because the answer is needed *before*
	 * anything is downloaded: the settings screen disables installing and says
	 * why, rather than offering a button that fails at the last step.
	 */
	isAvailable(): boolean;

	/** Replaces the directory named `id` with exactly these files. */
	write(id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void>;

	/** One file's contents as text, or null when it is not there. */
	readText(id: string, path: string): Promise<string | null>;

	/** Removes a directory. Succeeds when it was already gone. */
	remove(id: string): Promise<void>;

	/** The ids that have a directory. Empty when storage is unavailable. */
	list(): Promise<Set<string>>;
}

/**
 * Small, synchronous, string-to-string, and allowed to forget.
 *
 * `localStorage`'s shape, minus the parts nothing here uses. Synchronous
 * because the one caller — remembered check results — is read while a list is
 * being rendered, and an async read there would mean every row flickering
 * through "unknown" on the way to an answer it already had.
 *
 * **Every implementation may fail silently.** A viewer with site data blocked
 * loses the memory of a check, which costs a re-run; it must not cost them the
 * screen. Implementations swallow their own errors rather than making each
 * caller wrap a getter in `try`.
 */
export interface KeyValueStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

/**
 * Starts an isolate.
 *
 * `Worker` is the *interface* — `postMessage`, `onmessage`, `onerror`,
 * `terminate` — not a claim that a host has to be a browser. Node's
 * `worker_threads` and Deno both present it; a host that has something else
 * adapts it here, which is one small class rather than a fork of the runtime.
 *
 * Returning `null` means "this host has no isolate", and every caller has a
 * defined answer for that: the sandbox refuses to start a plugin, and the
 * translator does the work inline.
 */
export type WorkerFactory = () => Worker | null;

/**
 * Reads one of the runtime's *own* vendored artefacts, by file name.
 *
 * The odd one out in this file, and worth saying why it is here rather than
 * being something the runtime just does. `plugins/foreign/kotlin/vendor/` holds
 * a 4 MB tree-sitter grammar and its Emscripten runtime; they ship *with* the
 * runtime, so it looks like the runtime's business to read them. It is not,
 * because there is no portable way to ask "where is the file next to me": a
 * bundler answers with a hashed asset URL, a filesystem answers with a path,
 * and `import.meta.url` is the bundler's answer wearing a standard's clothes.
 *
 * So the host answers instead. It is handed a name — `tree-sitter.wasm` or
 * `tree-sitter-kotlin.wasm` — and returns the bytes.
 *
 * This was `HOST.md` §7.1's outstanding item until ADR-0004 phase 2, on the
 * grounds that `loadKotlinGrammar(loader)` already took one and no host needed
 * to pass it. A second host needed to pass it.
 */
export type WasmLoader = (name: string) => Promise<Uint8Array>;

/**
 * A line for whoever has the console open. Never a control flow.
 *
 * Mirrors the shape of the app's own playback trace, which is where the
 * browser host sends it. The runtime's calls are the ones that explain a
 * refusal — "this plugin asked for a host it did not declare" — and they are
 * useless if the only host that can emit them is the one this repository
 * happens to ship.
 */
export type HostLog = (message: string, detail?: Readonly<Record<string, unknown>>) => void;

/**
 * Everything at once, for a shell that supplies the lot.
 *
 * Assembled as one object so that adding a capability is one field rather than
 * a new argument in five signatures — the same reasoning `ConversionServices`
 * already uses one directory down. Nothing in the runtime *takes* a
 * `PluginHost`: each entry point takes only the capabilities it uses, so a
 * caller that needs a blob store is not also obliged to invent a sandbox. This
 * is the type a shell builds and destructures.
 */
export interface PluginHost {
	readonly fetch: HostFetch;
	readonly blobs: BlobStore;
	readonly kv: KeyValueStore;
	/** An isolate to run one plugin in. */
	readonly sandbox: WorkerFactory;
	/** A second isolate, for translating a foreign extension off the main thread. */
	readonly translator: WorkerFactory;
	/** The runtime's own vendored parser artefacts, as bytes. */
	readonly wasm: WasmLoader;
	readonly log: HostLog;
}

/** A host with no network. Refuses rather than reaching for an ambient one. */
export const NO_NETWORK: HostFetch = () =>
	Promise.reject(new Error('This host gives plugins no network access.'));

/** A host that cannot store files. What a browser without OPFS looks like. */
export const NO_BLOBS: BlobStore = {
	isAvailable: () => false,
	write: () => Promise.reject(new Error('This host cannot store plugins.')),
	readText: () => Promise.resolve(null),
	remove: () => Promise.resolve(),
	list: () => Promise.resolve(new Set<string>())
};

/** A store that forgets everything, which is a state a real one can be in. */
export const NO_KV: KeyValueStore = {
	get: () => null,
	set: () => {}
};

/** No isolate. The sandbox refuses; the translator works inline. */
export const NO_WORKER: WorkerFactory = () => null;

/**
 * A host that cannot read the runtime's vendored artefacts.
 *
 * What it costs is narrow and worth stating: the formats that convert from a
 * published JavaScript artifact are unaffected, and the one that translates
 * Kotlin refuses by name. A rejection rather than a throw at import time, for
 * the same reason as every other absence here — a spec asking an unrelated
 * question should not first have to invent a filesystem.
 */
export const NO_WASM: WasmLoader = (name) =>
	Promise.reject(new Error(`This host has no copy of ${name}.`));

/** Silence. The default, because a log is for whoever asked for one. */
export const NO_LOG: HostLog = () => {};

/**
 * A host that can do nothing, as the base for one that can do something.
 *
 * Spread over, rather than implemented from scratch, so that a shell adding
 * only a blob store does not have to write four refusals it does not care
 * about — and so that adding a capability to the port does not break every
 * existing implementation on the day it lands.
 */
export const NO_CAPABILITIES: PluginHost = {
	fetch: NO_NETWORK,
	blobs: NO_BLOBS,
	kv: NO_KV,
	sandbox: NO_WORKER,
	translator: NO_WORKER,
	wasm: NO_WASM,
	log: NO_LOG
};
