/**
 * The plugin runtime's host port, over a filesystem and a direct `fetch`.
 *
 * The **second** implementation of `$lib/plugins/host.ts`, and the reason the
 * port exists at all. `web-plugin-host.ts` was the first, and one
 * implementation cannot disagree with itself — ADR-0004 §6.2 makes this one the
 * experiment that says whether "one runtime, many hosts" is a design or a
 * description of a single browser.
 *
 * It is also the conversion laboratory. `tool/check-catalogue.ts` runs
 * `FOREIGN.md` §6's five steps over a whole repository through this host, and
 * that only means anything if the verdicts match a tab's. So the standard here
 * is not "it works headlessly"; it is **row for row**, and every place this file
 * had to adapt something is a place worth being suspicious of.
 *
 * ## What each capability is, and what it costs
 *
 * | Port | Here |
 * | --- | --- |
 * | `fetch` | direct, plus the app's own proxy route served in-process |
 * | `sandbox` | `worker_threads`, sealed by `sandbox-bootstrap.ts` |
 * | `blobs` | a directory per plugin, under one root |
 * | `kv` | one JSON file |
 * | `translator` | none — `HOST.md` §8 says inline is acceptable here |
 * | `wasm` | `node:fs`, from the runtime's own `vendor/` directory |
 * | `log` | stderr |
 *
 * ## Why `fetch` serves `/api/plugin-fetch` rather than routing around it
 *
 * `sandbox-host.ts` sends every plugin request to `/api/plugin-fetch`, and that
 * is not a browser detail leaking into the runtime — it is the shape the port
 * promises, with the browser's `HostFetch` reaching a server route that makes
 * the real request. A headless host *is* that server, so it answers the route
 * itself, by calling the route's own handler.
 *
 * Calling the handler rather than reimplementing it is the whole point. That
 * module holds real policy: https only, private and link-local addresses
 * refused, response size and time capped, redirects walked one hop at a time
 * with every hop re-checked, an incomplete certificate chain chased through AIA.
 * A second implementation of all that would be a second thing to be wrong, and
 * ADR-0004 §7 names exactly that as the risk this host runs: *the moment it is
 * allowed to diverge "because it is only a tool", it is worse than nothing.*
 *
 * ## Cross-platform, and not incidentally
 *
 * This runs under bun on Windows as well as on a Unix. So: `node:path` for every
 * path, `node:os` for a home directory, a `file:` URL for the worker entry point
 * rather than a string built with slashes, and no shell anywhere.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
	NO_WORKER,
	type BlobStore,
	type HostFetch,
	type HostLog,
	type KeyValueStore,
	type PluginHost,
	type WasmLoader,
	type WorkerFactory
} from '@plugin-bridge/host/host';
import { relay } from '@plugin-bridge/host/net/relay';
import { nodeChainRepair } from './net/aia';
import type { SandboxReady } from './sandbox-bootstrap';

/**
 * The route the runtime addresses its outbound requests to.
 *
 * Spelled here rather than imported because the runtime spells it as a string
 * literal too — it is a contract between the two halves of the port, and a
 * constant shared across the boundary would be the app leaking into the runtime
 * the long way round.
 */
const PROXY_ROUTE = '/api/plugin-fetch';

/**
 * The origin the in-process proxy request is addressed to.
 *
 * `Request` needs an absolute URL and nothing ever dials this one: the handler
 * reads the body and the method, never the address it arrived at. `.invalid` is
 * reserved by RFC 2606 precisely so a placeholder cannot become a real lookup.
 */
const LOCAL_ORIGIN = 'http://headless.invalid';

/** How much of the isolate's stderr is worth keeping to explain its death. */
const STDERR_TAIL = 8192;

/** How much of the chosen line to repeat, so a verdict stays one sentence. */
const STDERR_LINE = 200;

export interface HeadlessHostOptions {
	/**
	 * Where plugin directories and the key-value file live.
	 *
	 * Defaults under the user's home directory rather than to the working
	 * directory, so running the tool from two places is one store and not two.
	 */
	readonly dataDir?: string;
	/**
	 * Where the runtime's own explanations go.
	 *
	 * stderr by default, which is what `HOST.md` §6 asks of a headless host and
	 * what keeps a machine-readable report on stdout uncontaminated.
	 */
	readonly log?: HostLog;
	/** The network. Injected so a spec can answer from fixtures. */
	readonly fetch?: typeof fetch;
}

/* ── blobs: a directory per plugin ────────────────────────────────────────── */

/**
 * The filesystem, one directory per plugin id.
 *
 * The same shape as the browser's OPFS store and the Flutter client's
 * `plugin_store.dart`, which is the point of the port being filesystem-shaped in
 * the first place: one mental model for what installing and deleting a plugin
 * mean, rather than one per host.
 *
 * Every method swallows what it can, exactly as the browser's does. A missing
 * file is a real state — files cleared underneath the rows — and the registry
 * reports it as needing a reinstall rather than crashing on it.
 */
class DirectoryBlobStore implements BlobStore {
	constructor(private readonly root: string) {}

	isAvailable(): boolean {
		try {
			mkdirSync(this.root, { recursive: true });
			return true;
		} catch {
			// A read-only home, a path that is a file, a full disk. All of them
			// mean "plugins cannot be stored here", which the settings screen and
			// the CLI both know how to say.
			return false;
		}
	}

	/**
	 * Replaces the directory, leaving nothing of a previous version.
	 *
	 * Not atomic, and the browser's is not either: the old directory goes and
	 * the new one is written in its place. `bundle-store.ts` explains why the
	 * caller writes files before rows, which is what makes a failure between the
	 * two survivable.
	 */
	async write(id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
		const directory = this.directoryOf(id);
		await this.remove(id);
		await mkdir(directory, { recursive: true });

		for (const [path, contents] of files) {
			const target = this.resolveEntry(directory, path);
			await mkdir(dirname(target), { recursive: true });
			await writeFile(target, contents);
		}
	}

	async readText(id: string, path: string): Promise<string | null> {
		try {
			return await readFile(this.resolveEntry(this.directoryOf(id), path), 'utf8');
		} catch {
			return null;
		}
	}

	async remove(id: string): Promise<void> {
		try {
			await rm(this.directoryOf(id), { recursive: true, force: true });
		} catch {
			// Already absent, which is the state the caller wanted.
		}
	}

	async list(): Promise<Set<string>> {
		try {
			const entries = await readdir(this.root, { withFileTypes: true });
			return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
		} catch {
			return new Set();
		}
	}

	private directoryOf(id: string): string {
		// `bundle-store.ts` validates the id before calling and the archive
		// reader refuses traversal before that. This is the boundary, though, and
		// re-checking a boundary costs a comparison.
		if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') {
			throw new Error(`"${id}" is not a plugin id this store will write.`);
		}
		return join(this.root, id);
	}

	/**
	 * One entry path inside one plugin's directory.
	 *
	 * Bundle paths are `/`-separated whatever the host is — that is what makes a
	 * bundle the same tree everywhere — so they are split on `/` and rejoined
	 * with `node:path`. Resolving and then checking the prefix is the second
	 * refusal of traversal, after the archive reader's.
	 */
	private resolveEntry(directory: string, path: string): string {
		const target = resolve(directory, ...path.split('/'));
		if (target !== directory && !target.startsWith(directory + sep)) {
			throw new Error(`"${path}" would be written outside its own plugin directory.`);
		}
		return target;
	}
}

/* ── kv: one JSON file, synchronous, allowed to forget ────────────────────── */

/**
 * `localStorage`'s two methods over a JSON file.
 *
 * Synchronous because the port is: the one caller is remembered check results,
 * read while a list renders. In a CLI that reason is gone but the contract is
 * not, and a host that answered asynchronously would not be an implementation of
 * this port.
 *
 * Both methods swallow their own failures, which is a requirement rather than a
 * courtesy (`HOST.md` §4.1). What this stores is worth a re-run, never a broken
 * screen or a failed catalogue check.
 */
class JsonFileStore implements KeyValueStore {
	private cache: Record<string, string> | null = null;

	constructor(private readonly file: string) {}

	get(key: string): string | null {
		return this.read()[key] ?? null;
	}

	set(key: string, value: string): void {
		const rows = this.read();
		rows[key] = value;
		try {
			mkdirSync(dirname(this.file), { recursive: true });
			writeFileSync(this.file, JSON.stringify(rows, null, '\t'), 'utf8');
		} catch {
			// A read-only directory loses the memory, not the run.
		}
	}

	private read(): Record<string, string> {
		if (this.cache !== null) return this.cache;
		let rows: Record<string, string> = {};
		try {
			if (existsSync(this.file)) {
				const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
				if (typeof parsed === 'object' && parsed !== null) {
					rows = parsed as Record<string, string>;
				}
			}
		} catch {
			// A truncated or hand-edited file is a store that forgot.
		}
		this.cache = rows;
		return rows;
	}
}

/* ── sandbox: a Node child process, adapted and sealed ────────────────────── */

/**
 * The Node executable that will host an isolate.
 *
 * `process.execPath` when this process *is* Node, so a machine with two Node
 * installations uses the one the caller chose. `node` otherwise — which is the
 * case under bun, where `execPath` is bun and a bun realm cannot be sealed — and
 * resolved through the OS's own path search, which finds `node.exe` on Windows
 * without this file needing to know that it is on Windows.
 */
function nodeExecutable(): string {
	const versions = process.versions as unknown as Record<string, string | undefined>;
	return versions['bun'] === undefined && versions['node'] !== undefined
		? process.execPath
		: 'node';
}

/**
 * Where the isolate's entry point is.
 *
 * A `file:` URL built from this module's own and then converted, rather than a
 * path assembled with separators: `new URL` handles a Windows drive letter and a
 * space in a directory name, and `fileURLToPath` undoes it correctly on both.
 */
function bootstrapEntry(): string {
	return fileURLToPath(new URL('./sandbox-bootstrap.ts', import.meta.url));
}

/**
 * A child process wearing the `Worker` interface the port names.
 *
 * `HOST.md` §3: `Worker` is `postMessage`, `onmessage`, `onerror` and
 * `terminate`, not a claim that a host is a browser. What is behind it here is a
 * Node process reading newline-delimited JSON on stdin and writing it on stdout,
 * adapted in one small class rather than by forking the runtime — which is the
 * trade the port was designed to make.
 *
 * **Why a process rather than a thread**, at length in `sandbox-bootstrap.ts`
 * and in one line here: a bun worker thread cannot be sealed, because
 * `globalThis.Bun` is non-configurable and bun has no module-resolution hook, and
 * a bun process cannot start a Node thread. So the isolate is a process, which
 * every runtime can start and every runtime can kill.
 *
 * `terminate()` is therefore a kill, which is *stronger* containment than a
 * browser Worker offers rather than weaker: a plugin that will not return does
 * not merely stop being listened to.
 */
class ProcessWorker {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	/** What the isolate said about itself, before any plugin ran in it. */
	readonly ready: Promise<SandboxReady>;

	private announce: ((value: SandboxReady) => void) | null = null;
	private buffer = '';
	private stopped = false;
	/** The tail of what the isolate wrote to stderr, for when it dies. */
	private noise = '';

	constructor(private readonly child: Isolate) {
		this.ready = new Promise<SandboxReady>((resolve, reject) => {
			this.announce = resolve;
			child.on('error', reject);
			child.on('exit', () => reject(new Error('The sandbox exited before it was ready.')));
		});
		// Settled or not, nobody may be awaiting this yet, and an unhandled
		// rejection would take the process down over something already reported
		// through `onerror`.
		this.ready.catch(() => {});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => this.receive(chunk));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			// Through to stderr unchanged — a failure in the isolate stays visible
			// as itself — and the tail kept, because the exit code alone is not a
			// diagnosis. Bounded: a module that throws prints its own source.
			process.stderr.write(chunk);
			this.noise = (this.noise + chunk).slice(-STDERR_TAIL);
		});
		child.on('error', (error: unknown) => this.onerror?.(error));
		child.on('exit', (code: number | null) => {
			if (this.stopped) return;
			// A dead isolate leaves every in-flight call unanswered.
			// `sandbox-host.ts` races each one against a deadline, so this is not
			// the only backstop — but a plugin should not cost thirty seconds of
			// waiting for a process that is already gone.
			const said = this.diagnosis();
			this.onerror?.(
				new Error(
					`The sandbox exited with code ${code ?? 'unknown'}${said === '' ? '' : `: ${said}`}.`
				)
			);
		});
	}

	/**
	 * What the isolate said before it died, in one line.
	 *
	 * The last `Error:` line, because an uncaught throw prints its message and
	 * then its stack, and the message is the part that names a cause. A module
	 * that throws while evaluating prints its own *source* first — these bundles
	 * are one `data:` URL of a few hundred kilobytes — so a plain tail would be
	 * base64 and nothing else.
	 */
	private diagnosis(): string {
		const lines = this.noise
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith('data:'));
		const named = lines.filter((line) => /^[A-Z]\w*Error\b|^Error\b/.test(line));
		const chosen = named[named.length - 1] ?? lines[lines.length - 1] ?? '';
		return chosen.length > STDERR_LINE ? `${chosen.slice(0, STDERR_LINE - 1)}…` : chosen;
	}

	private receive(chunk: string): void {
		this.buffer += chunk;
		for (;;) {
			const newline = this.buffer.indexOf('\n');
			if (newline === -1) return;
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length === 0) continue;

			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch {
				// Anything on this stream that is not ours is a runtime notice
				// that escaped stderr. Dropping it beats handing the runtime a
				// message it cannot read.
				continue;
			}

			// The bootstrap notice belongs to the host, not to the runtime.
			// Forwarding it would hand `sandbox-host.ts` a reply to a call it
			// never made.
			if ((message as { bootstrap?: string }).bootstrap === 'ready') {
				this.announce?.(message as SandboxReady);
				this.announce = null;
				continue;
			}
			this.onmessage?.({ data: message });
		}
	}

	postMessage(value: unknown): void {
		if (this.stopped) return;
		this.child.stdin.write(`${JSON.stringify(value)}\n`);
	}

	terminate(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.child.kill();
	}
}

/** stdin written to, stdout read from, stderr read *and* passed through. */
type Isolate = ChildProcessByStdio<Writable, Readable, Readable>;

function startIsolate(): ProcessWorker {
	const child = spawn(nodeExecutable(), [bootstrapEntry()], {
		// stdout is the transport. stderr was `inherit`, which passed a real
		// failure in the isolate straight to the terminal and past this host —
		// so when the isolate died the only thing left to report was that it had
		// died. A plugin that threw where nothing caught it read as
		// "The sandbox exited with code 1", which names no cause, in a row a
		// reader then spends an afternoon treating as a mystery.
		//
		// Piped instead, and written on to stderr unchanged: the passthrough the
		// comment above promised is kept, and the host also gets to say what the
		// isolate said. See `ProcessWorker.diagnosis`.
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true
	});
	return new ProcessWorker(child);
}

const createSandboxWorker: WorkerFactory = () => {
	try {
		return startIsolate() as unknown as Worker;
	} catch {
		// A host that cannot start an isolate is a supported state: the sandbox
		// refuses to start a plugin and says so, which is more useful than a
		// `TypeError` three frames later.
		return null;
	}
};

/**
 * What an isolate on this machine could be closed to.
 *
 * Run once, before a catalogue is checked, so a report can say what produced it.
 * `sealed` means a bundle asking for `node:fs` is refused the way a browser
 * refuses it for having no such scheme, and nothing on the removal list survived.
 * `porous` means something did, and every verdict from that run is a weaker claim
 * than it looks. `null` means no isolate could be started at all — usually no
 * `node` on the path — which is the state `HOST.md` §2.0 calls "no sandbox".
 *
 * Answered by starting one and reading what it says about itself, rather than by
 * inspecting this process: the isolate is a *different* runtime from the one
 * asking, which is the entire reason it is a child process.
 */
export async function sandboxReport(): Promise<SandboxReady | null> {
	let worker: ProcessWorker;
	try {
		worker = startIsolate();
	} catch {
		return null;
	}
	try {
		return await worker.ready;
	} catch {
		return null;
	} finally {
		worker.terminate();
	}
}

/* ── wasm: the runtime's own vendored artefacts ───────────────────────────── */

/**
 * The tree-sitter runtime and the Kotlin grammar, from the source tree.
 *
 * `HOST.md` §7.1's outstanding item, now a host's job. The files ship inside
 * `plugins/foreign/kotlin/vendor/`, which makes them look like the runtime's own
 * business — but there is no portable way for a module to ask where the file
 * next to it is, so the runtime asks by name and this answers.
 *
 * The name is checked against the two the runtime is allowed to ask for, rather
 * than joined straight onto a directory. It is not a security boundary — the
 * caller is the runtime, not a plugin — but a path assembled from an argument is
 * a shape worth not having.
 */
const VENDOR = ['tree-sitter.wasm', 'tree-sitter-kotlin.wasm'];

const vendoredWasm: WasmLoader = async (name) => {
	if (!VENDOR.includes(name)) throw new Error(`This host has no copy of ${name}.`);
	const url = new URL(`../../core/src/kotlin/vendor/${name}`, import.meta.url);
	return new Uint8Array(await readFile(fileURLToPath(url)));
};

/* ── the host ─────────────────────────────────────────────────────────────── */

/** stderr, so a machine-readable report on stdout stays machine-readable. */
const stderrLog: HostLog = (message, detail) => {
	const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`;
	process.stderr.write(`plugin: ${message}${suffix}\n`);
};

/**
 * `fetch`, plus the app's own proxy route answered in-process.
 *
 * Two callers and two shapes. The runtime asks for `/api/plugin-fetch` with a
 * JSON body, which is the browser's arrangement and stays the arrangement here —
 * answered by the route's own handler, so the limits a public deployment relies
 * on are the limits a local run gets. Everything else is a repository index or
 * an artifact, fetched directly, which is what `HOST.md` §2.1 means by a
 * headless host passing an unrestricted `fetch` straight through.
 */
function headlessFetch(network: typeof fetch): HostFetch {
	return async (url, init) => {
		if (url !== PROXY_ROUTE) return network(url, init);

		// The relay takes a `Request` and the `fetch` it should reach the world
		// with — no framework event in between, which is what lets the same
		// policy run under a web server, under this isolate, and in a test.
		//
		// The third argument is the part only a Node host can supply: chasing
		// AIA for a chain a source under-sent needs `node:tls`, so the relay
		// asks for the repair and this host hands it over (`net/aia.ts`). A
		// browser passes nothing there and loses nothing, because the platform
		// has already done it.
		return await relay(
			new Request(`${LOCAL_ORIGIN}${PROXY_ROUTE}`, init),
			network,
			nodeChainRepair
		);
	};
}

/** Where a run keeps its plugin directories and its remembered answers. */
export function defaultDataDir(): string {
	return join(homedir(), '.yorozo');
}

/**
 * A `PluginHost` over this machine.
 *
 * Built by spreading nothing and naming all seven, because `HOST.md` §9's advice
 * to spread `NO_CAPABILITIES` is for a shell that has *some* of them; this one
 * has an answer for every entry, and one of those answers is deliberately "no".
 */
export function headlessPluginHost(options: HeadlessHostOptions = {}): PluginHost {
	const dataDir = options.dataDir ?? defaultDataDir();
	const network =
		options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

	return {
		fetch: headlessFetch(network),
		blobs: new DirectoryBlobStore(join(dataDir, 'plugins')),
		kv: new JsonFileStore(join(dataDir, 'kv.json')),
		sandbox: createSandboxWorker,
		// Deliberately none. `HOST.md` §8 says inline is acceptable for a headless
		// host, and the contract translation already carries is that the answer is
		// identical either way — only *where* differs. What a second isolate buys
		// is a main thread that keeps painting, and there is nothing here to paint.
		// The measurement in `translate-host.ts` says a worker is not faster.
		translator: NO_WORKER,
		wasm: vendoredWasm,
		log: options.log ?? stderrLog
	};
}
