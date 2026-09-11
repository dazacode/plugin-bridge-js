/**
 * The sandbox a plugin actually runs in.
 *
 * A module Worker with its ambient capabilities removed, holding one plugin
 * bundle and answering three questions over `postMessage`. It is the browser
 * half of AGENTS.md rule 13; the Flutter half is QuickJS/JavaScriptCore via
 * `flutter_js`, running the same bundle.
 *
 * ## What the isolation is, and what it is not
 *
 * A Worker gets its own global scope, no DOM, no `window`, no access to the
 * page's variables, and it can be terminated from outside — which is the part
 * that matters most, because it means a plugin cannot hang the UI and cannot
 * survive being switched off.
 *
 * What a Worker does *not* give you is a network boundary: `fetch`,
 * `XMLHttpRequest`, `WebSocket` and `importScripts` all exist in worker scope
 * by default. So they are deleted here before the bundle is evaluated
 * (`sealScope`).
 *
 * **That deletion is defence in depth, not the boundary.** A determined bundle
 * could reach a capability this list forgot. The real boundary is that the
 * host holds the plugin's declared `network.hosts` and every request the
 * plugin makes travels out through `ctx.http` as a message the *host* decides
 * whether to honour. Deleting globals raises the cost of trying; the allowlist
 * is what makes trying pointless.
 *
 * ## The shims exist because three engines disagree
 *
 * `TextEncoder`, `TextDecoder`, `atob` and `btoa` are absent from the embedded
 * engines the Flutter client uses. `ctx.text` and `ctx.bytes` are provided
 * here so a plugin that works in the browser works there too — a plugin
 * reaching for a global instead is a plugin that works on the platform its
 * author owns and throws on the others (ABI.md §6).
 */

/// <reference lib="webworker" />

interface HostRequest {
	readonly id: number;
	readonly kind: 'load' | 'searchCatalog' | 'listEpisodes' | 'resolve' | 'browse';
	readonly payload: unknown;
}

interface HostReply {
	readonly id: number;
	readonly ok: boolean;
	readonly value?: unknown;
	readonly error?: { readonly name: string; readonly message: string };
}

/** A call *out* of the sandbox — the only way a plugin reaches anything. */
interface OutboundCall {
	readonly outbound: true;
	readonly id: number;
	readonly method: 'http' | 'storageGet' | 'storageSet' | 'storageDelete' | 'log';
	readonly args: unknown[];
}

interface PluginModule {
	readonly id: string;
	searchCatalog?(query: string, page: number, ctx: unknown, cursor?: string): Promise<unknown>;
	listEpisodes?(sourceMediaId: string, ctx: unknown): Promise<unknown>;
	resolve?(sourceMediaId: string, episode: unknown, ctx: unknown): Promise<unknown>;
	browse?(shelf: string, page: number, ctx: unknown, cursor?: string): Promise<unknown>;
}

let plugin: PluginModule | null = null;
let settings: Record<string, unknown> = {};
let locale = 'en';

/** Pending calls the sandbox made to the host, by id. */
const outbound = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let nextOutboundId = 1;

/** Sends a request to the host and waits for its answer. */
function callHost(method: OutboundCall['method'], ...args: unknown[]): Promise<unknown> {
	const id = nextOutboundId;
	nextOutboundId += 1;
	return new Promise((resolve, reject) => {
		outbound.set(id, { resolve, reject });
		(self as unknown as Worker).postMessage({
			outbound: true,
			id,
			method,
			args
		} as OutboundCall);
	});
}

/**
 * Removes every ambient capability the bundle might otherwise reach for.
 *
 * Deleted rather than stubbed with a thrower, so that a plugin doing feature
 * detection (`typeof fetch === 'function'`) takes the branch that uses
 * `ctx.http` instead of the one that throws at runtime.
 */
function sealScope(): void {
	const scope = self as unknown as Record<string, unknown>;
	for (const name of [
		'fetch',
		'XMLHttpRequest',
		'WebSocket',
		'EventSource',
		'importScripts',
		'indexedDB',
		'caches',
		'BroadcastChannel',
		'SharedWorker',
		'Worker',
		'navigator',
		'Notification',
		'RTCPeerConnection'
	]) {
		try {
			delete scope[name];
		} catch {
			// Some are non-configurable in some engines; the allowlist is the
			// boundary regardless. See the file header.
		}
	}

	// These bundles were written for a browser and routinely attach a helper to
	// `window` — a crypto library, a cached client. A Worker has no `window`, so
	// the assignment throws at load and the plugin is reported as broken code
	// when it is merely code written somewhere else.
	//
	// Aliased to the sandbox's own scope rather than to a bare object, because
	// a module that writes `window.X` then reads `X` expects one place, not two.
	// It grants nothing new: this is the same scope the module already reaches
	// as `self`, with every ambient capability above already removed from it.
	try {
		if (scope['window'] === undefined) scope['window'] = scope;
	} catch {
		// A frozen global is a scope we cannot help; the plugin will say so.
	}
}

/**
 * Routes a plugin's own logging to the host instead of to the console.
 *
 * These bundles are written for a client that shows their output to their
 * author, and they log freely — a page of markup, a stream URL, a running
 * count. Left alone, checking fifty of them buries every real message in the
 * devtools under thousands of lines nobody can attribute to a plugin.
 *
 * `console` is replaced rather than deleted. Deleting it would make a plugin
 * that logs throw, which turns a noisy plugin into a broken one and would be a
 * far worse trade. The output travels out as a host call, so it stays
 * available, stays attributed to the plugin that wrote it, and stays something
 * the host can choose to show or drop.
 *
 * Bounded per load: a plugin that logs in a loop must not be able to flood the
 * message channel it shares with its own results.
 */
function captureConsole(): void {
	const scope = self as unknown as Record<string, unknown>;
	let remaining = 200;

	const forward =
		(level: string) =>
		(...args: unknown[]) => {
			if (remaining <= 0) return;
			remaining -= 1;
			const text = args
				.map((value) => {
					if (typeof value === 'string') return value;
					try {
						return JSON.stringify(value);
					} catch {
						return String(value);
					}
				})
				.join(' ')
				.slice(0, 2000);
			void callHost('log', level, remaining === 0 ? `${text}\n… further output dropped` : text);
		};

	scope['console'] = {
		log: forward('debug'),
		info: forward('debug'),
		debug: forward('debug'),
		warn: forward('warn'),
		error: forward('warn'),
		trace: forward('debug'),
		// Present so a plugin calling one does not throw; they mean nothing here.
		group: () => undefined,
		groupEnd: () => undefined,
		table: forward('debug'),
		time: () => undefined,
		timeEnd: () => undefined,
		assert: () => undefined,
		dir: forward('debug'),
		count: () => undefined
	};
}

/** The engine-independent codecs `ctx` promises. */
const TEXT = {
	encode: (value: string) => new TextEncoder().encode(value),
	decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes)
};

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BYTES = {
	toBase64(bytes: Uint8Array): string {
		let out = '';
		for (let i = 0; i < bytes.length; i += 3) {
			const a = bytes[i];
			const b = i + 1 < bytes.length ? bytes[i + 1] : undefined;
			const c = i + 2 < bytes.length ? bytes[i + 2] : undefined;
			out += DIGITS[a >> 2];
			out += DIGITS[((a & 0x03) << 4) | ((b ?? 0) >> 4)];
			out += b === undefined ? '=' : DIGITS[((b & 0x0f) << 2) | ((c ?? 0) >> 6)];
			out += c === undefined ? '=' : DIGITS[c & 0x3f];
		}
		return out;
	},
	fromBase64(value: string): Uint8Array {
		const clean = value.replace(/[=\s]/g, '');
		const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
		let accumulator = 0;
		let bits = 0;
		let index = 0;
		for (const character of clean) {
			const digit = DIGITS.indexOf(character);
			if (digit === -1) throw new Error(`Not base64: ${value}`);
			accumulator = (accumulator << 6) | digit;
			bits += 6;
			if (bits >= 8) {
				bits -= 8;
				out[index] = (accumulator >> bits) & 0xff;
				index += 1;
			}
		}
		return out.subarray(0, index);
	},
	toHex: (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
	fromHex(value: string): Uint8Array {
		const clean = value.replace(/\s|^0x/g, '');
		if (clean.length % 2 !== 0) throw new Error(`Not hex: ${value}`);
		const out = new Uint8Array(clean.length / 2);
		for (let i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
		return out;
	}
};

/** The response shape `ctx.http` hands a plugin. */
function makeResponse(raw: {
	status: number;
	url: string;
	headers: Record<string, string>;
	body: string;
}) {
	return {
		status: raw.status,
		url: raw.url,
		headers: raw.headers,
		text: async () => raw.body,
		json: async () => JSON.parse(raw.body) as unknown,
		bytes: async () => TEXT.encode(raw.body)
	};
}

/** Builds the only capability a plugin has. */
function makeContext() {
	const send = async (url: string, request?: unknown) => {
		const raw = (await callHost('http', url, request)) as {
			status: number;
			url: string;
			headers: Record<string, string>;
			body: string;
		};
		return makeResponse(raw);
	};

	const http = {
		send,
		async text(url: string, request?: unknown) {
			const response = await send(url, request);
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`${response.status} from ${url}`);
			}
			return response.text();
		},
		async json(url: string, request?: unknown) {
			const response = await send(url, request);
			if (response.status < 200 || response.status >= 300) {
				throw new Error(`${response.status} from ${url}`);
			}
			return response.json();
		}
	};

	return {
		http,
		settings: {
			string: (id: string) => (typeof settings[id] === 'string' ? (settings[id] as string) : ''),
			boolean: (id: string) => settings[id] === true,
			list: (id: string) => (Array.isArray(settings[id]) ? (settings[id] as string[]) : [])
		},
		storage: {
			get: (key: string) => callHost('storageGet', key) as Promise<string | null>,
			set: (key: string, value: string) => callHost('storageSet', key, value) as Promise<void>,
			delete: (key: string) => callHost('storageDelete', key) as Promise<void>
		},
		log: {
			debug: (message: string) => void callHost('log', 'debug', message),
			warn: (message: string) => void callHost('log', 'warn', message)
		},
		text: TEXT,
		bytes: BYTES,
		locale,
		signal: new AbortController().signal
	};
}

/**
 * A promise the plugin rejected where nothing was waiting for it.
 *
 * A converted extension produces these by accident — a `parallelMap` whose
 * element throws after the member holding it has already returned. A worker does
 * not raise one through `onerror`, so the host heard nothing at all and every
 * call in flight waited out its deadline instead. The headless isolate had the
 * same blindness for the same reason and answers it the same way: say what
 * happened, and let the host decide what to do about it.
 *
 * Guarded, because the two hosts are not the same realm: a browser Worker has
 * `addEventListener` and the headless isolate's `self` is a Node `globalThis`
 * that does not. That one answers rejections in `sandbox-bootstrap.ts`, where
 * it has a `process` to hear them on.
 */
const listens = self as unknown as {
	addEventListener?: (...args: unknown[]) => void;
};
if (typeof listens.addEventListener === 'function') {
	listens.addEventListener('unhandledrejection', (event: unknown) => {
		const reason = (event as { reason?: unknown }).reason;
		const error =
			reason instanceof Error
				? { name: reason.name, message: reason.message }
				: { name: 'Error', message: String(reason) };
		(self as unknown as Worker).postMessage({ fatal: true, error });
	});
}

self.onmessage = async (event: MessageEvent) => {
	const data = event.data as
		| HostRequest
		| {
				inboundReply: true;
				id: number;
				ok: boolean;
				value?: unknown;
				error?: string;
		  };

	// An answer to something the sandbox asked the host for.
	if ('inboundReply' in data) {
		const pending = outbound.get(data.id);
		if (pending === undefined) return;
		outbound.delete(data.id);
		if (data.ok) pending.resolve(data.value);
		else pending.reject(new Error(data.error ?? 'host call failed'));
		return;
	}

	const reply = (value: HostReply) => (self as unknown as Worker).postMessage(value);

	try {
		switch (data.kind) {
			case 'load': {
				const request = data.payload as {
					source: string;
					settings: Record<string, unknown>;
					locale: string;
				};
				settings = request.settings;
				locale = request.locale;
				sealScope();
				captureConsole();

				// A blob module URL rather than `eval`: the bundle is an ES
				// module with a default export, and evaluating it as a module
				// is what makes `export default` mean what it says. The blob is
				// revoked immediately — the module graph holds its own
				// reference once imported.
				const blob = new Blob([request.source], { type: 'text/javascript' });
				const url = URL.createObjectURL(blob);
				try {
					const module = (await import(/* @vite-ignore */ url)) as {
						default: PluginModule;
					};
					plugin = module.default;
				} finally {
					URL.revokeObjectURL(url);
				}
				reply({ id: data.id, ok: true, value: { id: plugin?.id ?? null } });
				return;
			}
			case 'searchCatalog': {
				const { query, page, cursor } = data.payload as {
					query: string;
					page: number;
					cursor?: string;
				};
				const value = await required().searchCatalog?.(query, page, makeContext(), cursor);
				reply({ id: data.id, ok: true, value });
				return;
			}
			case 'listEpisodes': {
				const { sourceMediaId } = data.payload as { sourceMediaId: string };
				const value = await required().listEpisodes?.(sourceMediaId, makeContext());
				reply({ id: data.id, ok: true, value });
				return;
			}
			case 'resolve': {
				const { sourceMediaId, episode } = data.payload as {
					sourceMediaId: string;
					episode: unknown;
				};
				const value = await required().resolve?.(sourceMediaId, episode, makeContext());
				reply({ id: data.id, ok: true, value });
				return;
			}
			case 'browse': {
				const { shelf, page, cursor } = data.payload as {
					shelf: string;
					page: number;
					cursor?: string;
				};
				const value = await required().browse?.(shelf, page, makeContext(), cursor);
				reply({ id: data.id, ok: true, value });
				return;
			}
		}
	} catch (error) {
		const failure = error as Error;
		reply({
			id: data.id,
			ok: false,
			// The plugin's own error name and message travel out intact. A
			// `SourceChangedError` naming a URL is the most useful thing this
			// system produces when a source breaks, and flattening it to
			// "plugin failed" here would throw exactly that away.
			error: {
				name: failure?.name ?? 'Error',
				message: failure?.message ?? String(error)
			}
		});
	}
};

function required(): PluginModule {
	if (plugin === null) throw new Error('This plugin has not been loaded.');
	return plugin;
}

export {};
