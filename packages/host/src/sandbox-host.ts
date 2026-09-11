/**
 * The host side of the sandbox: what a plugin is allowed to do.
 *
 * The Worker holds the bundle; this holds the *authority*. Every request the
 * sandbox makes arrives here as a message and is answered only if the plugin's
 * declared `network.hosts` covers it. That split is the whole security model —
 * deleting `fetch` inside the Worker raises the cost of trying, and this makes
 * trying pointless.
 *
 * ## Why plugin HTTP goes through the server
 *
 * A browser cannot fetch a content source directly. The source will not send
 * `Access-Control-Allow-Origin`, so the request is blocked before any of this
 * code runs; and even where CORS allowed it, `Referer`, `Origin` and the
 * `Sec-Fetch-*` headers a source checks are forbidden header names that
 * JavaScript may not set. Both are browser-only problems — the Flutter client
 * has neither — so the browser routes plugin traffic through
 * `/api/plugin-fetch`, the same shape `/api/metadata` already uses for the
 * metadata providers.
 *
 * The allowlist is enforced **here**, before the proxy is called, because this
 * is the side that knows which plugin is asking. The proxy applies its own
 * independent limits (§ the route), on the principle that the one component
 * able to make arbitrary outbound requests should not be taking a caller's
 * word for what is reasonable.
 *
 * ## Termination is the real containment
 *
 * A plugin cannot be trusted to return. Every call is raced against a deadline
 * and a timeout terminates the Worker rather than leaving it running — a
 * runaway loop in a source is otherwise a tab that heats up with no way to
 * stop it from the UI.
 */

import { NetworkFailure, NotFoundFailure, ValidationFailure } from '@plugin-bridge/core/errors';
import { hostMatches } from './host-match';
import { plausibleTld } from './host-names';
import {
	NO_LOG,
	NO_NETWORK,
	NO_WORKER,
	type HostFetch,
	type HostLog,
	type WorkerFactory
} from './host';
import { RequestGate, readPolicy } from './net/request-policy';
import type { ConversionRecord } from '@plugin-bridge/core/formats';

/** How long any one plugin call may take before its Worker is destroyed. */
const CALL_TIMEOUT_MS = 30_000;

/** How long the initial module evaluation may take. */
const LOAD_TIMEOUT_MS = 10_000;

export { hostMatches };

/**
 * As much of an installed plugin as running one requires.
 *
 * Narrower than the app's `InstalledPlugin`, deliberately. That type is a
 * *row* — when it was installed, whether it is enabled, whether its files are
 * missing, which repository it came from — and every one of those fields is
 * the app's business rather than the sandbox's. What the sandbox needs is an
 * identity to check the bundle against, a name to put in a sentence a viewer
 * reads, the host list that is the whole security model, and whether this was
 * converted (which decides whether hosts may be learned at runtime).
 *
 * Declared here rather than moved out of the domain, because the app really
 * does own `InstalledPlugin` and the runtime really does only mention part of
 * it. `InstalledPlugin` is structurally assignable to this, so no caller
 * changed; what changed is that the runtime can no longer read a field it has
 * no business reading.
 */
export interface RunnablePlugin {
	readonly id: string;
	readonly name: string;
	readonly hosts: readonly string[];
	/** Absent for a plugin that was published for Yorozo in the first place. */
	readonly converted?: ConversionRecord;
}

export interface SandboxOptions {
	/**
	 * The host's network, which is the only one there is.
	 *
	 * Defaults to refusing rather than to an ambient `fetch`: a runtime that
	 * silently falls back to whatever global its environment happens to expose
	 * is a runtime whose network policy depends on where it was bundled.
	 * `HOST.md` §2.
	 */
	readonly fetcher?: HostFetch;
	/** Where `ctx.storage` lands. Namespaced per plugin by the caller. */
	readonly storage?: Map<string, string>;
	/** The plugin's own `console`, if the caller wants to surface it. */
	readonly onLog?: (level: string, message: string) => void;
	/**
	 * The isolate to run the plugin in.
	 *
	 * Supplied by the host, because constructing one is the single genuinely
	 * bundler-shaped line in this runtime — `new URL('./x.worker.ts',
	 * import.meta.url)` is a Vite instruction, and a host that is not Vite has
	 * a different one. Returning null means this host has no isolate, and a
	 * plugin then cannot be started at all.
	 */
	readonly createWorker?: WorkerFactory;
	/** Where the runtime's own explanations go. Silent by default. */
	readonly log?: HostLog;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: unknown) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * What the proxy route answers with, as far as this side reads it.
 *
 * Deliberately loose: the fields are JSON that arrived from somewhere else, and
 * every use below re-checks the one it wants rather than trusting the shape.
 */
interface ProxyPayload {
	status?: unknown;
	url?: unknown;
	body?: unknown;
	headers?: Record<string, unknown>;
}

/**
 * The same answer with the two things a request policy judges it by pulled out.
 *
 * `retryAfter` is lifted here and dropped again before the payload crosses back
 * into the isolate: it is an instruction to the *host* about waiting, not a
 * field the plugin ABI has, and `ctx.http` already hands the plugin the header
 * itself in `headers`.
 */
interface PluginResponse extends ProxyPayload {
	readonly status: number;
	readonly retryAfter?: string;
}

/** One loaded plugin, running. */
/**
 * Ceiling on hosts learned in one run — a memory bound, not a policy.
 *
 * Set high on purpose. At 32 a single advert-laden catalogue page exhausted it
 * and the leftovers decided whether a source worked, which is the cap
 * arbitrating something it has no business arbitrating. See `learned`.
 */
const MAX_LEARNED_HOSTS = 512;

/**
 * How many refused hosts are worth naming in a failure message.
 *
 * The list exists to be read by a person deciding whether a source is broken.
 * A module that walks a long chain of dead providers could otherwise turn one
 * sentence into a paragraph of hostnames, which is a different way of saying
 * nothing.
 */
const MAX_REFUSED_REPORTED = 8;

/**
 * What a worker's failure event actually said.
 *
 * An `ErrorEvent` carries `message` and, where the runtime supplies one, the
 * `error` itself; a `PromiseRejectionEvent` carries `reason`. Stringifying the
 * event gives `[object ErrorEvent]` for all of them, which is how an ordinary
 * "indexed into a value that was null" became a sentence about the sandbox.
 */
function describeWorkerFailure(event: unknown): string {
	if (typeof event === 'string') return event;
	const carried = event as {
		message?: unknown;
		error?: unknown;
		reason?: unknown;
	};
	const cause = carried?.error ?? carried?.reason;
	if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
	if (typeof carried?.message === 'string' && carried.message.length > 0) return carried.message;
	if (cause !== undefined && cause !== null) return String(cause);
	return 'the sandbox failed without saying why';
}

export class PluginSandbox {
	private worker: Worker | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private readonly storage: Map<string, string>;
	private disposed = false;
	/**
	 * Hosts this plugin asked for and was refused, in the order first seen.
	 *
	 * Recorded because the refusal is otherwise invisible. These modules try
	 * each embed provider in turn inside their own `try`, so a `ValidationFailure`
	 * raised here is caught by the module and swallowed — and the run ends by
	 * returning an empty list, which the verification gate reported as "that
	 * source returned no stream". The viewer was told the source was broken
	 * when what actually happened is that we declined to let it reach three
	 * hosts, none of which appear anywhere in its code because the page it
	 * scraped is what names them.
	 */
	private readonly refused: string[] = [];
	/**
	 * Hosts this session learned, and may therefore reach.
	 *
	 * A converted scraper cannot declare where its embeds live. It reads a
	 * catalogue page, and *that page* names the provider — chosen by the site,
	 * different next week, and written nowhere in the module's code. Deriving
	 * the allowlist from the code alone therefore produces a plugin that
	 * searches and lists fine and is refused the instant it resolves, which
	 * reads as a broken source and is not one: the same module run without the
	 * allowlist returns a playable stream.
	 *
	 * So a host becomes reachable once a document the plugin was already
	 * permitted to fetch has named it. Redirect landings count doubly: an
	 * allowed host followed a link and put the plugin somewhere, which is an
	 * explicit hand-off, and it is how these catalogues work — they hand out
	 * `/redirect/<n>` and reveal the provider only when you follow one.
	 *
	 * ## What the cap is for, which is not what it looks like
	 *
	 * An earlier version capped this at 32 and a real catalogue page filled it
	 * immediately — with adverts, social buttons and trackers, because that is
	 * what a public web page contains. The lesson was not that the reading is
	 * too broad but that a *small* cap is actively harmful: junk crowded out the
	 * provider, so the cap decided which source worked. Restricting the reading
	 * to hand-off documents instead fixed one module and left another refused
	 * at its embed provider — the boundary was choosing winners either way.
	 *
	 * The cap is therefore a memory bound, set high enough that it does not
	 * arbitrate. Being named here is not being reached: nothing is fetched until
	 * the module asks for it, and a module that asks for a tracker was going to
	 * be a module that asks for a tracker whatever this set contained.
	 *
	 * What does the bounding is the rest of it: the chain starts at a declared
	 * host, every link is a document this plugin was already permitted to read,
	 * entries are exact hosts and never wildcards, https only, never a bare
	 * address, and none of it is persisted — it dies with the run rather than
	 * accumulating into a permission the viewer never saw.
	 *
	 * `/api/stream` reached the same conclusion for CDN segment hosts and calls
	 * it `learnedHosts`; this is that idea one layer up.
	 */
	private readonly learned = new Set<string>();

	/** Where this runtime's own explanations go. Never a control flow. */
	private readonly log: HostLog;

	private constructor(
		private readonly plugin: RunnablePlugin,
		private readonly options: SandboxOptions
	) {
		this.storage = options.storage ?? new Map<string, string>();
		this.log = options.log ?? NO_LOG;
	}

	/** Starts an isolate, evaluates `source`, and returns once it is ready. */
	static async start(
		plugin: RunnablePlugin,
		source: string,
		settings: Record<string, unknown>,
		options: SandboxOptions = {}
	): Promise<PluginSandbox> {
		const sandbox = new PluginSandbox(plugin, options);
		const worker = (options.createWorker ?? NO_WORKER)();
		if (worker === null) {
			// A host with no isolate cannot run a plugin, and saying so is more
			// useful than a `TypeError` three frames later. It is a real state:
			// server-side rendering, and any host that has not implemented the
			// sandbox half of the port yet.
			throw new ValidationFailure('This host cannot run plugins: it has no sandbox.');
		}
		sandbox.worker = worker;
		sandbox.worker.onmessage = (event) => sandbox.onMessage(event);
		// `String(event)` on an ErrorEvent is `[object ErrorEvent]`, which names
		// nothing — the browser half of the same blindness the isolate had, where
		// a plugin's own error reached a reader as a fault in the runtime. The
		// message and the error the event carries are the diagnosis; the event
		// itself never was.
		sandbox.worker.onerror = (event) => sandbox.failAll(new Error(describeWorkerFailure(event)));

		const loaded = (await sandbox.call(
			'load',
			{ source, settings, locale: 'en' },
			LOAD_TIMEOUT_MS
		)) as { id: string | null };

		// A bundle whose default export disagrees with its manifest is a bundle
		// that would produce bindings under an id nothing else uses.
		if (loaded.id !== plugin.id) {
			sandbox.dispose();
			throw new ValidationFailure(
				`This plugin's code identifies as "${loaded.id}" but its manifest says ` +
					`"${plugin.id}". It was not loaded.`
			);
		}
		return sandbox;
	}

	searchCatalog(query: string, page: number, cursor?: string): Promise<unknown> {
		return this.call('searchCatalog', { query, page, cursor });
	}

	listEpisodes(sourceMediaId: string): Promise<unknown> {
		return this.call('listEpisodes', { sourceMediaId });
	}

	resolve(sourceMediaId: string, episode: unknown): Promise<unknown> {
		return this.call('resolve', { sourceMediaId, episode });
	}

	browse(shelf: string, page: number, cursor?: string): Promise<unknown> {
		return this.call('browse', { shelf, page, cursor });
	}

	/**
	 * Requests that reached the proxy and came back as failures, `host: why`.
	 *
	 * The same reasoning as `refused`, for the other half of the problem. These
	 * modules walk a list of embed providers inside their own `try`, so a dead
	 * host, an expired certificate and a 403 are all swallowed identically and
	 * the run ends returning nothing. The proxy knew exactly what went wrong at
	 * each one — it says `ENOTFOUND`, `ECONNREFUSED`, a status — and all of it
	 * was discarded one stack frame above, leaving a console full of bare 502s
	 * and a verdict of "returned no stream".
	 */
	private readonly failures: string[] = [];

	/**
	 * The request policy this plugin declared, and the pacing state enforcing it.
	 *
	 * Host-side because this is the only side that sees every request. A limiter
	 * inside the isolate would be one the isolate could decline to run, and the
	 * window it keeps has to outlive any one call to mean anything.
	 */
	private readonly gate = new RequestGate();

	/**
	 * Everything this plugin may currently reach: what it declared, plus what
	 * this run learned.
	 *
	 * A caller that has to judge one of the plugin's *own answers* — the reach
	 * probe, checking a url `resolve()` just returned — has to ask the same
	 * question the sandbox would, or it refuses the plugin for going exactly
	 * where the sandbox sent it. That is what happened: the module resolved a
	 * real stream through a learned host and the probe reported "host not in
	 * the converted allowlist" about a host the plugin was legitimately at.
	 */
	get reachableHosts(): readonly string[] {
		return [...this.plugin.hosts, ...this.learned];
	}

	/**
	 * The hosts refused so far, for a caller reporting why a run came to
	 * nothing. Empty for a plugin that stayed inside what it declared.
	 */
	get refusedHosts(): readonly string[] {
		return this.refused;
	}

	/** What the proxy said about the requests that did not come back, `host: why`. */
	get outboundFailures(): readonly string[] {
		return this.failures;
	}

	/** Destroys the Worker. Safe to call twice. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.worker?.terminate();
		this.worker = null;
		this.failAll(new NetworkFailure('This plugin was stopped.'));
	}

	private call(kind: string, payload: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<unknown> {
		if (this.disposed || this.worker === null) {
			return Promise.reject(new NetworkFailure('This plugin is not running.'));
		}
		const id = this.nextId;
		this.nextId += 1;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				// Terminated, not just abandoned. A plugin that never returns
				// would otherwise keep running with nobody waiting for it.
				this.dispose();
				reject(
					new NetworkFailure(
						`${this.plugin.name} did not answer within ${Math.round(timeoutMs / 1000)}s and was stopped.`
					)
				);
			}, timeoutMs);

			this.pending.set(id, { resolve, reject, timer });
			this.worker?.postMessage({ id, kind, payload });
		});
	}

	private onMessage(event: MessageEvent): void {
		const data = event.data as
			| { outbound: true; id: number; method: string; args: unknown[] }
			| { fatal: true; error: { name: string; message: string } }
			| {
					id: number;
					ok: boolean;
					value?: unknown;
					error?: { name: string; message: string };
			  };

		if ('outbound' in data) {
			void this.serveOutbound(data);
			return;
		}

		// A promise the plugin rejected and nobody awaited. A browser Worker does
		// not raise one through `onerror`, so nothing here would have heard it
		// and every call in flight would have waited out its deadline — the
		// browser's version of "the sandbox exited with code 1". The worker says
		// so itself instead.
		if ('fatal' in data) {
			this.failAll(toFailure(data.error));
			return;
		}

		const pending = this.pending.get(data.id);
		if (pending === undefined) return;
		this.pending.delete(data.id);
		clearTimeout(pending.timer);

		if (data.ok) {
			pending.resolve(data.value);
			return;
		}
		// The plugin's own error name and message, preserved. A
		// `SourceChangedError` naming a URL is the most actionable thing this
		// system produces, and flattening it here would discard it.
		const error = data.error ?? {
			name: 'Error',
			message: 'This plugin failed.'
		};
		pending.reject(toFailure(error));
	}

	/** Answers a request the sandbox made. This is where authority lives. */
	private async serveOutbound(call: {
		id: number;
		method: string;
		args: unknown[];
	}): Promise<void> {
		const respond = (ok: boolean, value?: unknown, error?: string) =>
			this.worker?.postMessage({
				inboundReply: true,
				id: call.id,
				ok,
				value,
				error
			});

		try {
			switch (call.method) {
				case 'http':
					respond(true, await this.fetchForPlugin(call.args[0] as string, call.args[1]));
					return;
				case 'httpPolicy':
					// Re-read rather than trusted. The isolate validated it too, so
					// a plugin's own mistake throws at the line that made it — but
					// the host does not take a sandbox's word for the shape of
					// anything, and this one decides how long it will sleep for.
					this.gate.declare(readPolicy(call.args[0]));
					this.log('a plugin declared a request policy', {
						plugin: this.plugin.id,
						policy: this.gate.declared()
					});
					respond(true);
					return;
				case 'storageGet':
					respond(true, this.storage.get(call.args[0] as string) ?? null);
					return;
				case 'storageSet': {
					const value = call.args[1] as string;
					// Capped, because `ctx.storage` is a scratchpad and a plugin
					// filling the origin's quota would break the app around it.
					if (value.length > 64 * 1024) throw new Error('storage value too large');
					this.storage.set(call.args[0] as string, value);
					respond(true);
					return;
				}
				case 'storageDelete':
					this.storage.delete(call.args[0] as string);
					respond(true);
					return;
				case 'log':
					this.options.onLog?.(call.args[0] as string, call.args[1] as string);
					respond(true);
					return;
				default:
					respond(false, undefined, `unknown host call: ${call.method}`);
			}
		} catch (error) {
			respond(false, undefined, (error as Error).message);
		}
	}

	/**
	 * The allowlist check, and the only way out of the sandbox.
	 *
	 * Refused before anything leaves, so a plugin cannot learn whether a host
	 * exists by timing the failure.
	 */
	private async fetchForPlugin(url: string, request: unknown): Promise<unknown> {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw new ValidationFailure(`Not a URL: ${url}`);
		}
		if (target.protocol !== 'https:') {
			throw new ValidationFailure('A plugin may only make https requests.');
		}
		const host = target.hostname.toLowerCase();
		if (
			!this.learned.has(host) &&
			!this.plugin.hosts.some((pattern) => hostMatches(target.hostname, pattern))
		) {
			if (this.refused.length < MAX_REFUSED_REPORTED && !this.refused.includes(target.hostname)) {
				this.refused.push(target.hostname);
			}
			// Traced as well as recorded. The recorded list reaches a viewer at
			// the end of a run; this reaches an engineer while it is happening,
			// in order, next to the request that provoked it.
			this.log('refused a host it did not declare', {
				plugin: this.plugin.id,
				host: target.hostname,
				declared: this.plugin.hosts.length,
				learned: this.learned.size
			});
			throw new ValidationFailure(
				`${this.plugin.name} tried to reach ${target.hostname}, which it did not declare. ` +
					'Refused.'
			);
		}

		const options = (request ?? {}) as {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
			/**
			 * Whether the proxy may follow a redirect for this request.
			 *
			 * Absent means yes, which is what almost every request wants. `false`
			 * is for the caller that is reading the `Location` header as the
			 * answer — following it would consume the answer and hand back the
			 * page it pointed at.
			 */
			follow?: boolean;
		};

		const fetcher = this.options.fetcher ?? NO_NETWORK;
		// The declared policy fills in what the request did not carry. Computed
		// once rather than per attempt: a retry is the *same* request asked
		// again, and a policy that changed between the two would make the second
		// one a different question.
		const headers = this.gate.headersFor(host, options.headers ?? {});
		const attempt = async (): Promise<PluginResponse> => {
			const response = await fetcher('/api/plugin-fetch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					url,
					method: options.method ?? 'GET',
					headers,
					body: options.body ?? null,
					// Only sent when the caller said no, so the route's default stays
					// the route's own business rather than something every request
					// restates.
					...(options.follow === false ? { follow: false } : {})
					// No `allowedHosts` here, and the field that used to be is gone
					// rather than ignored. It claimed the route applied the plugin's
					// allowlist a second time; the route never read it, and its own
					// header explains why it does not — it has no way to know which
					// plugin is asking, so it enforces a floor that holds whatever a
					// caller claims (https only, no private address, capped size and
					// time, every redirect hop re-checked). The allowlist is enforced
					// here, in `fetchForPlugin`, before anything leaves. A comment
					// promising a second gate is worse than no comment: it is what
					// somebody reads when deciding how much this one has to do.
				})
			});

			if (!response.ok) {
				// The route says *why* it could not relay — which host, and what went
				// wrong reaching it. Dropping that left a bare 502 in the console and
				// a plugin failure nobody could act on.
				const detail = await response
					.json()
					.then((failed: { error?: string }) => failed.error)
					.catch(() => undefined);
				// Kept before it is thrown, because the thing that throws is usually
				// not the thing that reports. See `failures`.
				const note = `${host}: ${detail ?? `the proxy returned ${response.status}`}`;
				if (this.failures.length < MAX_REFUSED_REPORTED && !this.failures.includes(note)) {
					this.failures.push(note);
				}
				this.log('outbound request failed', {
					plugin: this.plugin.id,
					host,
					status: response.status,
					detail
				});
				// Thrown rather than returned, so a policy never *retries* it: the
				// policy names upstream statuses, and this is the proxy failing to
				// produce one at all. The relay has already spent its own one retry
				// (`net/aia.ts`) by the time it says this, and asking again would
				// multiply a timeout by `attempts` inside a call racing a deadline.
				throw new NetworkFailure(
					detail === undefined
						? `The plugin proxy returned ${response.status}.`
						: `The plugin proxy returned ${response.status}: ${detail}`
				);
			}
			const answered = (await response.json()) as ProxyPayload;
			return {
				...answered,
				// Normalised for the gate, which judges an attempt by the status the
				// *source* gave and by what it said about waiting. A route that
				// answered without a status is given one no policy can name, rather
				// than a zero that a careless `onStatus` might match.
				status: typeof answered.status === 'number' ? answered.status : -1,
				retryAfter:
					typeof answered.headers?.['retry-after'] === 'string'
						? answered.headers['retry-after']
						: undefined
			};
		};

		// `retryAfter` is dropped rather than forwarded: it was lifted out of the
		// headers for the gate's benefit, and inventing a response field the ABI
		// does not have is how a plugin comes to depend on one.
		const { retryAfter: _waited, ...payload } = await this.gate.run(host, attempt);

		// Only for a converted plugin. A native bundle is signed and its host
		// list is a promise its author made and a viewer accepted; widening
		// that at runtime would weaken a boundary that was never broken. The
		// problem this solves belongs to conversion — a scraper's embed host is
		// chosen by the site it scrapes, so no conversion of it could have
		// declared one.
		if (this.plugin.converted === undefined) return payload;

		// Where a redirect actually landed: an allowed host handed the plugin
		// over deliberately, which is the strongest endorsement available.
		if (typeof payload.url === 'string') {
			const landed = hostOf(payload.url);
			if (landed !== null && landed !== host) this.learn(landed);
		}
		// The same endorsement, for a request that asked not to follow. An
		// allowed host answered with "go here"; that it was read rather than
		// walked does not make it a weaker hand-off, and treating it as one
		// would refuse the very request the plugin makes next — which is the
		// whole reason it turned following off.
		const location = payload.headers?.['location'];
		if (typeof location === 'string') {
			const named = hostOf(location.startsWith('//') ? `https:${location}` : location);
			if (named !== null && named !== host) this.learn(named);
		}
		// And what the document names, because that is where a scraper finds
		// its provider. See `learned` for why this is not gated more tightly.
		if (typeof payload.body === 'string') this.learnNamedIn(payload.body);
		return payload;
	}

	/** Records one host. Exact match, never a wildcard, never a bare address. */
	private learn(host: string): void {
		if (this.learned.size >= MAX_LEARNED_HOSTS || isAddressLiteral(host)) return;
		if (this.learned.has(host)) return;
		this.learned.add(host);
		// The single most useful line when a converted source misbehaves: it
		// says whether the host the module is about to ask for was ever offered
		// to it, which is the difference between "the site changed" and "we
		// read its page wrong".
		this.log('learned a host from a page it read', {
			plugin: this.plugin.id,
			host,
			learned: this.learned.size
		});
	}

	/**
	 * The hosts a document names.
	 *
	 * Absolute `https://` and protocol-relative `//host` — the two shapes a
	 * page writes a link in. Deliberately not every string that resembles a
	 * hostname: this runs over markup a source controls, so the looser the
	 * reading the more a page can grant itself.
	 *
	 * **A `//` is only read as a URL where a URL can start**, which is after a
	 * quote, a backtick, an `=` (an unquoted attribute), a `(` (a CSS `url()`)
	 * or a `,` (a `srcset`). Everywhere else a `//` in a page is a JavaScript
	 * line comment, and this learned `console.log` off a real catalogue page out
	 * of `//console.log(direction)`. Refusing a `//` that follows a colon —
	 * which is what stopped `http://`, `ftp://` and `wss://` from granting their
	 * hosts through this branch — is subsumed by the same rule.
	 *
	 * `plausibleTld` is the second half, and the packager has applied it to the
	 * manifest's hosts since the beginning; see `host-names.ts` for why the two
	 * readers now share it.
	 */
	private learnNamedIn(body: string): void {
		const label = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
		const pattern = new RegExp(
			`(?:https:\\/\\/|(?<=["'\`=(,])\\/\\/)(${label}(?:\\.${label})+)`,
			'gi'
		);
		for (const match of unescapeSlashes(body).matchAll(pattern)) {
			if (this.learned.size >= MAX_LEARNED_HOSTS) return;
			const host = match[1].toLowerCase();
			if (plausibleTld(host)) this.learn(host);
		}
	}

	private failAll(error: unknown): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

/**
 * The same text with the two ways a page hides a slash undone.
 *
 * Scraped pages rarely hand a URL over as plain text. It arrives inside an
 * embedded JSON blob or a JavaScript string, where `/` is written `\/`, or
 * HTML-escaped as `&#47;` / `&#x2F;`. A reader that only understands `https://`
 * therefore misses precisely the URLs a player page carries — which are the
 * ones a converted scraper needs — while happily finding the plain-text links
 * in the page footer.
 *
 * Only slashes are undone, and only these three spellings. This is not an HTML
 * entity decoder: the aim is to recognise a host that is really there, not to
 * reconstruct a document.
 */
function unescapeSlashes(body: string): string {
	return body.replace(/\\\//g, '/').replace(/&#(?:47|x2[Ff]);/g, '/');
}

/** The hostname of a url, lowercased, or null when it is not an https one. */
function hostOf(url: string): string | null {
	try {
		const parsed = new URL(url);
		return parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * Whether this is a literal address rather than a name.
 *
 * Learned hosts come out of documents a source controls, and an address there
 * is a way of naming a machine that no name points at. The proxy already
 * refuses private ranges; this refuses the shape outright, because nothing a
 * legitimate embed provider does needs it.
 */
function isAddressLiteral(host: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

/** Rebuilds a domain failure from what crossed the worker boundary. */
function toFailure(error: { name: string; message: string }): Error {
	switch (error.name) {
		case 'NotFoundError':
			return new NotFoundFailure(error.message);
		case 'SourceChangedError':
		case 'NetworkError':
		case 'RateLimitedError':
			return new NetworkFailure(error.message);
		case 'UnsupportedError':
			return new ValidationFailure(error.message);
		default:
			return new NetworkFailure(error.message);
	}
}
