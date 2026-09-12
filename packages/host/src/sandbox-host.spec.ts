/**
 * The **host** side of the sandbox: what a plugin is allowed to do.
 *
 * Be precise about what this proves, because the distinction matters. Node has
 * no browser `Worker` and no module-blob `import()`, so the Worker here is an
 * in-process double speaking the same `postMessage` protocol. Everything under
 * test is therefore `sandbox-host.ts`:
 *
 * - the network allowlist, and that a refusal happens *before* anything leaves
 * - that plugin traffic goes through the host proxy rather than out directly
 * - the storage cap
 * - termination on a plugin that never returns
 * - that a plugin's own error message survives the boundary
 *
 * What it does **not** prove is that a browser Worker evaluates a real bundle
 * and that `sandbox.worker.ts` seals its scope. That needs a browser, and until
 * there is one in CI the running app is the only demonstration. Saying so is
 * better than a header that implies otherwise.
 */

import { describe, expect, it, vi } from 'vitest';

import {
	hostMatches,
	PluginSandbox,
	type RunnablePlugin,
	type SandboxOptions
} from './sandbox-host';

const PLUGIN: RunnablePlugin = {
	id: 'com.example.plugins.demo',
	name: 'Demo',
	hosts: ['api.example.com', '*.cdn.example.com']
};

/** What the fake "plugin" does when the host asks it something. */
type Behaviour = (
	kind: string,
	payload: unknown,
	host: (method: string, ...args: unknown[]) => Promise<unknown>
) => Promise<unknown>;

/**
 * An in-process stand-in for the Worker.
 *
 * It speaks the exact protocol `sandbox.worker.ts` speaks, so the host is
 * exercised unchanged. `behaviour` decides what the "plugin" does when asked.
 */
class FakeWorker implements Partial<Worker> {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;
	terminated = false;

	constructor(private readonly behaviour: Behaviour) {}

	private outboundId = 1;
	private readonly waiting = new Map<
		number,
		{ resolve: (v: unknown) => void; reject: (e: unknown) => void }
	>();

	postMessage(message: unknown): void {
		const data = message as
			| { id: number; kind: string; payload: unknown }
			| { inboundReply: true; id: number; ok: boolean; value?: unknown; error?: string };

		if ('inboundReply' in data) {
			const pending = this.waiting.get(data.id);
			this.waiting.delete(data.id);
			if (data.ok) pending?.resolve(data.value);
			else pending?.reject(new Error(data.error));
			return;
		}

		const host = (method: string, ...args: unknown[]) =>
			new Promise<unknown>((resolve, reject) => {
				const id = this.outboundId;
				this.outboundId += 1;
				this.waiting.set(id, { resolve, reject });
				this.emit({ outbound: true, id, method, args });
			});

		void (async () => {
			try {
				const value = await this.behaviour(data.kind, data.payload, host);
				this.emit({ id: data.id, ok: true, value });
			} catch (error) {
				const failure = error as Error;
				this.emit({
					id: data.id,
					ok: false,
					error: { name: failure.name, message: failure.message }
				});
			}
		})();
	}

	terminate(): void {
		this.terminated = true;
	}

	private emit(data: unknown): void {
		queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
	}
}

/**
 * The same manifest, but carrying the record that says where it came from.
 *
 * Only the presence of this record separates the two plugins below, which is
 * the point: runtime learning is a concession to conversion, not a general
 * loosening, and a test that varied anything else would not show that.
 */
const CONVERTED: RunnablePlugin = {
	...PLUGIN,
	converted: {
		format: 'sora',
		foreignId: 'demo',
		foreignVersion: '14.58',
		convertedAt: '2026-09-07T00:00:00.000Z',
		converterVersion: 1,
		verified: true
	}
};

function start(
	behaviour: Behaviour,
	options: SandboxOptions = {},
	plugin: RunnablePlugin = PLUGIN
) {
	const worker = new FakeWorker(behaviour);
	return {
		worker,
		sandbox: PluginSandbox.start(
			plugin,
			'export default {};',
			{},
			{
				...options,
				createWorker: () => worker as unknown as Worker
			}
		)
	};
}

/**
 * A stand-in for `/api/plugin-fetch` that answers per requested url.
 *
 * The reply shape is the proxy's: `url` is where the request *ended up* after
 * redirects were followed, and `body` is the document. Both are what the host
 * reads hosts out of, so a stub that ignored the request would not be able to
 * tell the two apart.
 */
function proxyAnswering(
	reply: (url: string) => {
		url?: string;
		body?: string;
		status?: number;
		headers?: Record<string, string>;
	}
) {
	return vi.fn<typeof fetch>(async (_input, init) => {
		const sent = JSON.parse(String(init?.body)) as { url: string };
		const answer = reply(sent.url);
		return Response.json({
			status: answer.status ?? 200,
			url: answer.url ?? sent.url,
			headers: answer.headers ?? {},
			body: answer.body ?? ''
		});
	});
}

/** What the host actually sent the proxy, for the request at `index`. */
function sentBody(
	fetcher: ReturnType<typeof proxyAnswering>,
	index: number
): Record<string, unknown> {
	return JSON.parse(String(fetcher.mock.calls[index]?.[1]?.body)) as Record<string, unknown>;
}

/** Reads one declared page, then tries to go where that page pointed. */
function readsThenReaches(target: string): Behaviour {
	return async (kind, _payload, host) => {
		if (kind === 'load') return { id: PLUGIN.id };
		await host('http', 'https://api.example.com/catalogue');
		return host('http', target);
	};
}

const loadsFine: Behaviour = async (kind) =>
	kind === 'load' ? { id: PLUGIN.id } : { entries: [], hasMore: false };

describe('host matching', () => {
	it('is the same rule the Dart side and the SDK apply', () => {
		expect(hostMatches('api.example.com', 'api.example.com')).toBe(true);
		expect(hostMatches('a.cdn.example.com', '*.cdn.example.com')).toBe(true);
		expect(hostMatches('a.b.cdn.example.com', '*.cdn.example.com')).toBe(true);
		// The two that matter: a wildcard does not match the bare parent, and
		// never matches a host that merely ends with the same text.
		expect(hostMatches('cdn.example.com', '*.cdn.example.com')).toBe(false);
		expect(hostMatches('evilcdn.example.com', '*.cdn.example.com')).toBe(false);
	});
});

describe('loading', () => {
	it('refuses a bundle whose id disagrees with its manifest', async () => {
		// Otherwise the plugin produces bindings under an id nothing answers to.
		const { sandbox, worker } = start(async () => ({ id: 'com.example.plugins.other' }));
		await expect(sandbox).rejects.toThrowError(/identifies as/);
		expect(worker.terminated).toBe(true);
	});

	it('accepts a matching id', async () => {
		const { sandbox } = start(loadsFine);
		await expect(sandbox).resolves.toBeInstanceOf(PluginSandbox);
	});
});

describe('the network allowlist', () => {
	it('lets a declared host through, via the host proxy', async () => {
		// Typed through `fetch` so the mock's call tuple is typed and the
		// assertion below can actually read the URL it was given.
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({
				status: 200,
				url: 'https://api.example.com/x',
				headers: {},
				body: '{"ok":1}'
			})
		);
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'https://api.example.com/x');
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		await running.listEpisodes('demo');

		expect(fetcher).toHaveBeenCalledOnce();
		// Routed through the server, not fetched directly: a browser cannot
		// reach a content source itself.
		expect(fetcher.mock.calls[0]?.[0]).toBe('/api/plugin-fetch');
	});

	it('refuses an undeclared host before anything leaves', async () => {
		const fetcher = vi.fn();
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'https://tracker.invalid/beacon');
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(/did not declare/);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('refuses the bare parent of a wildcard', async () => {
		const fetcher = vi.fn();
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'https://cdn.example.com/x');
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(/did not declare/);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it('refuses cleartext even to a declared host', async () => {
		const fetcher = vi.fn();
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'http://api.example.com/x');
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(/https/);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

describe('the hosts a plugin was refused', () => {
	it('records each one once, and never a host it was allowed to reach', async () => {
		// Kept because the refusal is otherwise invisible to everything above.
		// A converted module asks for each embed provider inside its own `try`,
		// so the failure raised here is caught by the module and swallowed, and
		// the run ends by returning an empty list. The verification gate then
		// told a viewer the source had no stream, when what happened is that we
		// declined hosts the conversion had no way to know about — they are named
		// only in the page the module scraped, never in its code.
		const fetcher = vi.fn<typeof fetch>(async () =>
			Response.json({
				status: 200,
				url: 'https://api.example.com/x',
				headers: {},
				body: '{"ok":1}'
			})
		);
		const swallowed: string[] = [];
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				for (const url of [
					'https://embed.invalid/one',
					'https://embed.invalid/two',
					'https://mirror.invalid/three',
					'https://api.example.com/x'
				]) {
					try {
						await host('http', url);
					} catch (error) {
						swallowed.push((error as Error).message);
					}
				}
				return [];
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		expect(await running.listEpisodes('demo')).toEqual([]);

		// Still refused, first: recording it is an addition to the answer, not a
		// softening of it.
		expect(swallowed).toHaveLength(3);
		expect(swallowed[0]).toMatch(/did not declare/);
		// One entry per host in the order first seen. The same host asked for
		// twice is one thing to explain, not two, and a sentence naming it twice
		// would read as a fault in us.
		expect(running.refusedHosts).toEqual(['embed.invalid', 'mirror.invalid']);
		// The declared host was reached, so there is nothing to explain about it.
		expect(fetcher).toHaveBeenCalledOnce();
	});
});

describe('what the proxy said about the requests that failed', () => {
	it('records each reason once, and nothing for a request that was answered', async () => {
		// The other half of the problem `refusedHosts` above solves. A module
		// walks its list of embed providers inside its own `try`, so a dead
		// host, an expired certificate and a 403 are all swallowed identically
		// and the run ends returning nothing. The proxy knew exactly what went
		// wrong at each one and said so; all of it was discarded one frame
		// above, leaving a console full of bare 502s and a verdict of "that
		// source returned no stream".
		const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
			const sent = JSON.parse(String(init?.body)) as { url: string };
			if (sent.url.startsWith('https://api.example.com/')) {
				return Response.json({ status: 200, url: sent.url, headers: {}, body: '' });
			}
			return sent.url.startsWith('https://a.cdn.example.com/')
				? Response.json({ error: 'ENOTFOUND' }, { status: 502 })
				: Response.json({ error: '403 from the origin' }, { status: 502 });
		});
		const swallowed: string[] = [];
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				for (const url of [
					'https://a.cdn.example.com/one',
					'https://a.cdn.example.com/two',
					'https://b.cdn.example.com/three',
					'https://api.example.com/x'
				]) {
					try {
						await host('http', url);
					} catch (error) {
						swallowed.push((error as Error).message);
					}
				}
				return [];
			},
			{ fetcher: fetcher as unknown as typeof fetch }
		);

		const running = await sandbox;
		expect(await running.listEpisodes('demo')).toEqual([]);

		// Three failures the module said nothing about, and the run still
		// returned an empty list — which on its own is indistinguishable from a
		// source that genuinely has nothing.
		expect(swallowed).toHaveLength(3);
		expect(swallowed[0]).toMatch(/The plugin proxy returned 502: ENOTFOUND/);
		// One entry per host and reason. The same host failing twice for the
		// same reason is one thing to explain, not two; the second host failed
		// for a different reason, and that difference is the whole value of
		// keeping these at all — one of them is the source's fault and one of
		// them may well be ours.
		expect(running.outboundFailures).toEqual([
			'a.cdn.example.com: ENOTFOUND',
			'b.cdn.example.com: 403 from the origin'
		]);
		// The host that answered has nothing to explain, and neither has the
		// allowlist: every one of these was a host the plugin declared, so the
		// two lists are describing genuinely different problems.
		expect(running.refusedHosts).toEqual([]);
	});
});

describe('the hosts a run learns', () => {
	// One page, naming one player, used for both halves of the boundary below.
	// The bodies differ nowhere else, so the only thing that can explain a
	// different answer is the conversion record.
	const NAMES_A_PLAYER = 'watch it at https://player.invalid/e/1 or come back later';

	it('does not widen a plugin that was published as one', async () => {
		// A native bundle is signed and its host list is a promise its author
		// made and a viewer accepted at install time. The problem learning
		// solves belongs entirely to conversion — a scraper's embed host is
		// picked by the site it reads, so no conversion could have declared one
		// — and nothing about that is a reason to soften a boundary that was
		// never broken. So a page may name whatever it likes here: it is read,
		// and it grants nothing.
		const fetcher = proxyAnswering(() => ({ body: NAMES_A_PLAYER }));
		const { sandbox } = start(readsThenReaches('https://player.invalid/e/1'), {
			fetcher: fetcher as unknown as typeof fetch
		});

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(/did not declare/);
		// Only the catalogue page went out; the second request was refused here.
		expect(fetcher).toHaveBeenCalledOnce();
		expect(running.reachableHosts).toEqual(PLUGIN.hosts);
	});

	it('lets a converted plugin follow the page it was allowed to read', async () => {
		// The failure this pins is a source that searches and lists perfectly
		// and is refused the instant it resolves, which reads to a viewer as a
		// broken source and is not one — the same module run without the
		// allowlist returns a playable stream. The host it needs appears in no
		// manifest and nowhere in its code, because the catalogue page is what
		// chooses it, and chooses differently next week.
		const fetcher = proxyAnswering(() => ({ body: NAMES_A_PLAYER }));
		const { sandbox } = start(
			readsThenReaches('https://player.invalid/e/1'),
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).resolves.toBeDefined();
		expect(fetcher).toHaveBeenCalledTimes(2);
		expect(running.refusedHosts).toEqual([]);
	});

	it('follows a hand-off to wherever a redirect landed', async () => {
		// These catalogues do not publish the provider at all. They hand out
		// `/redirect/<n>` links and reveal where the episode really lives only
		// once one is followed, so the landing is the only place the name ever
		// appears. It is also the strongest endorsement on offer: a host the
		// viewer already allowed deliberately handed the plugin over.
		const fetcher = proxyAnswering((url) =>
			url.includes('/redirect/') ? { url: 'https://landing.invalid/e/1' } : {}
		);
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('http', 'https://api.example.com/redirect/7');
				return host('http', 'https://landing.invalid/e/1');
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).resolves.toBeDefined();
		expect(running.reachableHosts).toContain('landing.invalid');
	});

	it('follows a hand-off the plugin read instead of taking', async () => {
		// The same endorsement as the landing above, arriving as a header
		// because the plugin asked not to follow. A source answers "which
		// server has this episode" with a 302, and the module reads Location
		// rather than fetching it — so the host it then asks for was named by
		// an allowed host and never appears in any document body.
		const fetcher = proxyAnswering((url) =>
			url.includes('/go/')
				? { status: 302, headers: { location: 'https://handed.invalid/e/1' } }
				: {}
		);
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('http', 'https://api.example.com/go/7', { follow: false });
				return host('http', 'https://handed.invalid/e/1');
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await expect(running.listEpisodes('demo')).resolves.toBeDefined();
		expect(running.reachableHosts).toContain('handed.invalid');
		expect(running.refusedHosts).toEqual([]);
		// The flag reached the proxy for the request that asked for it, and for
		// no other: the default is the route's business, not every caller's.
		expect(sentBody(fetcher, 0)).toMatchObject({ follow: false });
		expect(sentBody(fetcher, 1)).not.toHaveProperty('follow');
	});

	it('reads a host that the page wrote with its slashes hidden', async () => {
		// The most valuable case here, and the one that was silently missing.
		// A player url almost never reaches a scraper as plain text: it arrives
		// inside an embedded JSON blob or a JavaScript string, where every
		// slash is written `\/`, or HTML-escaped as `&#47;` or `&#x2F;`. A
		// reader that only understands a literal `https://` therefore finds the
		// plain-text links in the page footer — adverts, social buttons — and
		// misses precisely the one url the module was sent to that page for.
		const body = [
			String.raw`<script>var sources = {"file":"https:\/\/backslashed.invalid\/stream.m3u8"};</script>`,
			'<iframe src="&#47;&#47;numeric.invalid/e/1"></iframe>',
			'<a href="&#x2F;&#x2F;hexed.invalid/e/1">mirror</a>'
		].join('\n');
		const fetcher = proxyAnswering((url) => (url.endsWith('/catalogue') ? { body } : {}));
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('http', 'https://api.example.com/catalogue');
				const reached: string[] = [];
				for (const target of [
					'https://backslashed.invalid/stream.m3u8',
					'https://numeric.invalid/e/1',
					'https://hexed.invalid/e/1'
				]) {
					await host('http', target);
					reached.push(target);
				}
				return reached;
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		// All three, because a page picks its spelling and the module has no say
		// in which one it gets.
		await expect(running.listEpisodes('demo')).resolves.toHaveLength(3);
		expect(running.refusedHosts).toEqual([]);
	});

	it('never learns a bare address, however it was named', async () => {
		// A learned host comes out of a document the source controls, and an
		// address written there names a machine that no name points at — which
		// is the one thing a real embed provider never needs to do. The proxy
		// refuses private ranges of its own accord; this refuses the shape
		// outright, on both paths, because both paths read the same document.
		const fetcher = proxyAnswering((url) =>
			url.endsWith('/redirect/7')
				? { url: 'https://203.0.113.7/e/1' }
				: { body: 'fallback at https://198.51.100.9/e/1' }
		);
		const refused: string[] = [];
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('http', 'https://api.example.com/redirect/7');
				await host('http', 'https://api.example.com/catalogue');
				for (const target of ['https://203.0.113.7/e/1', 'https://198.51.100.9/e/1']) {
					await host('http', target).catch((error: Error) => refused.push(error.message));
				}
				return refused;
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await running.listEpisodes('demo');
		expect(refused).toHaveLength(2);
		expect(refused[0]).toMatch(/did not declare/);
		expect(running.refusedHosts).toEqual(['203.0.113.7', '198.51.100.9']);
		expect(running.reachableHosts).toEqual(PLUGIN.hosts);
	});

	it('does not read a `//` that starts a JavaScript comment', async () => {
		// Found in the console of a real run: `console.log`, learned off a
		// catalogue page out of a commented-out `//console.log(direction)` in an
		// inline script. A `//` in a page is a line comment far more often than
		// it is a protocol-relative URL, and no regex can tell the two apart —
		// so one is only read where a URL can start. `.min.js` is the second
		// half of the same guard: shaped exactly like a host, and not one.
		const fetcher = proxyAnswering(() => ({
			body:
				'<script>function swipe(d) {\n  //console.log(d + " - " + d);\n}</script>' +
				'<img src="//quoted.invalid/a"> <img src=//unquoted.invalid/b> ' +
				'<style>body{background:url(//styles.invalid/c)}</style>' +
				'<img srcset="//first.invalid/1 1x, //second.invalid/2 2x">' +
				'<script src="//assets.invalid/bundle.min.js"></script>'
		}));
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'https://api.example.com/catalogue');
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await running.listEpisodes('demo');

		expect(running.reachableHosts).not.toContain('console.log');
		expect(running.reachableHosts).not.toContain('bundle.min.js');
		// `second.invalid` is the cost, and it is deliberate: a `srcset`'s later
		// candidates are written `, //host`, and `, //` is also exactly where a
		// comment sits in an argument list. The strict rule loses an image
		// candidate; the loose one grants a host off a comment. An `srcset` has
		// never been where a scraper finds its provider.
		expect(running.reachableHosts).toEqual([
			...PLUGIN.hosts,
			'quoted.invalid',
			'unquoted.invalid',
			'styles.invalid',
			'first.invalid',
			'assets.invalid'
		]);
	});

	it('reads a link written for https, and not one written for anything else', async () => {
		// The bug this pins: the pattern spelled the scheme as an optional
		// `https:` prefix with nothing to its left, so it also matched at the
		// `//` of `http://`, `ftp://` and `wss://` — every one of which then
		// granted the host. A page a source controls could name a host under
		// any scheme at all and have it become reachable, which is wider than
		// this reader is supposed to be. A protocol-relative `//host` must
		// still work, because that is how markup usually writes a link.
		const fetcher = proxyAnswering(() => ({
			body:
				'plain https://secure.invalid/a ' +
				'insecure http://cleartext.invalid/b ' +
				'transfer ftp://files.invalid/c ' +
				'socket wss://socket.invalid/d ' +
				'markup src="//relative.invalid/e"'
		}));
		const refused: string[] = [];
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('http', 'https://api.example.com/catalogue');
				for (const target of [
					'https://secure.invalid/a',
					'https://relative.invalid/e',
					'https://cleartext.invalid/b',
					'https://files.invalid/c',
					'https://socket.invalid/d'
				]) {
					await host('http', target).catch((error: Error) => refused.push(error.message));
				}
				return refused;
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		await running.listEpisodes('demo');

		// The two the page really offered as links; the three it merely mentioned.
		expect(running.reachableHosts).toEqual([...PLUGIN.hosts, 'secure.invalid', 'relative.invalid']);
		expect(running.refusedHosts).toEqual(['cleartext.invalid', 'files.invalid', 'socket.invalid']);
	});
});

describe('what a caller is told the plugin may reach', () => {
	it('answers with the declared list and what this run has learned', async () => {
		// Asked by anything that has to judge one of the plugin's own answers —
		// the reach probe, looking at a url `resolve()` just returned. It has to
		// ask the same question the sandbox would, or it refuses the plugin for
		// going exactly where the sandbox sent it, which is what happened: a
		// real stream came back through a learned host and the probe reported
		// that the host was not in the converted allowlist.
		const fetcher = proxyAnswering(() => ({ body: 'https://player.invalid/e/1' }));
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				return host('http', 'https://api.example.com/catalogue');
			},
			{ fetcher: fetcher as unknown as typeof fetch },
			CONVERTED
		);

		const running = await sandbox;
		// Nothing has been read yet, so there is nothing beyond the manifest.
		expect(running.reachableHosts).toEqual(PLUGIN.hosts);
		await running.listEpisodes('demo');
		expect(running.reachableHosts).toEqual([...PLUGIN.hosts, 'player.invalid']);

		// The declared entries arrive as patterns, so a caller must apply the
		// same matcher to them rather than comparing strings — otherwise every
		// wildcard in a manifest reads as a host nothing will ever equal.
		const reaches = (host: string) =>
			running.reachableHosts.some((pattern) => hostMatches(host, pattern));
		expect(reaches('a.cdn.example.com')).toBe(true);
		expect(reaches('cdn.example.com')).toBe(false);
		// A learned entry is an exact host and never a pattern, so it matches
		// itself and nothing under it.
		expect(reaches('player.invalid')).toBe(true);
		expect(reaches('sub.player.invalid')).toBe(false);
	});
});

describe('storage', () => {
	it('round-trips, and is capped', async () => {
		const store = new Map<string, string>();
		const { sandbox } = start(
			async (kind, _payload, host) => {
				if (kind === 'load') return { id: PLUGIN.id };
				await host('storageSet', 'k', 'v');
				return host('storageGet', 'k');
			},
			{ storage: store }
		);

		const running = await sandbox;
		expect(await running.listEpisodes('demo')).toBe('v');
		expect(store.get('k')).toBe('v');
	});

	it('refuses a value larger than the scratchpad allows', async () => {
		const { sandbox } = start(async (kind, _payload, host) => {
			if (kind === 'load') return { id: PLUGIN.id };
			return host('storageSet', 'k', 'x'.repeat(64 * 1024 + 1));
		});
		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(/too large/);
	});
});

describe('a plugin that misbehaves', () => {
	it('is terminated when it does not return', async () => {
		vi.useFakeTimers();
		try {
			const { sandbox, worker } = start(async (kind) =>
				kind === 'load' ? { id: PLUGIN.id } : new Promise(() => {})
			);
			const running = await sandbox;
			const call = running.listEpisodes('demo');
			// The expectation is attached *before* time is advanced. The
			// rejection fires inside the timer, and a handler attached after
			// that is a handler attached too late — Node reports the gap as an
			// unhandled rejection even though the test goes on to pass.
			const rejected = expect(call).rejects.toThrowError(/did not answer/);
			// Terminated, not merely abandoned: a runaway loop would otherwise
			// keep a thread hot with nobody waiting for it.
			await vi.advanceTimersByTimeAsync(91_000);
			await rejected;
			expect(worker.terminated).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it('says a call that ran out of time ran out of time', async () => {
		// One call is several requests, and a host caps each of those on its
		// own, so this budget expiring means "slow", never "the page changed".
		// Read back out of the sentence it would mean neither: the wording
		// contains no word any classifier looks for, and a caller matching on
		// prose filed it as a source whose markup had moved on — telling a
		// viewer the page was misread when it had never been fetched.
		vi.useFakeTimers();
		try {
			const { sandbox } = start(async (kind) =>
				kind === 'load' ? { id: PLUGIN.id } : new Promise(() => {})
			);
			const running = await sandbox;
			const call = running.resolve('demo', { number: 1 } as never);
			const failure = expect(call).rejects.toMatchObject({ isTimeout: true });
			await vi.advanceTimersByTimeAsync(91_000);
			await failure;
		} finally {
			vi.useRealTimers();
		}
	});

	it('gives a call longer than the host gives any one of its requests', async () => {
		// The inversion this pins. A resolve walks a catalogue page, a mirror
		// page and often an embed; the browser host allows 45s for any single
		// one of them. A call budget under that cannot be met by a source that
		// is only slow — the plugin is terminated mid-request, having done
		// nothing wrong. The number is asserted rather than described because
		// the relationship lives in two repositories and neither can import
		// the other's constant.
		vi.useFakeTimers();
		try {
			const { sandbox, worker } = start(async (kind) =>
				kind === 'load' ? { id: PLUGIN.id } : new Promise(() => {})
			);
			const running = await sandbox;
			const call = running.listEpisodes('demo');
			const rejected = expect(call).rejects.toThrowError(/did not answer within 90s/);
			// Still running well past the host's single-request cap of 45s.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(worker.terminated).toBe(false);
			await vi.advanceTimersByTimeAsync(31_000);
			await rejected;
		} finally {
			vi.useRealTimers();
		}
	});

	it('carries its own error message out intact', async () => {
		// A SourceChangedError naming a URL is the most useful thing this
		// system produces when a source breaks. Flattening it would waste it.
		const { sandbox } = start(async (kind) => {
			if (kind === 'load') return { id: PLUGIN.id };
			const error = new Error('Could not find the episode list at https://api.example.com/eps.');
			error.name = 'SourceChangedError';
			throw error;
		});
		const running = await sandbox;
		await expect(running.listEpisodes('demo')).rejects.toThrowError(
			/Could not find the episode list at https:\/\/api\.example\.com\/eps\./
		);
	});
});

describe('disposal', () => {
	it('terminates the worker and rejects anything in flight', async () => {
		const { sandbox, worker } = start(async (kind) =>
			kind === 'load' ? { id: PLUGIN.id } : new Promise(() => {})
		);
		const running = await sandbox;
		const call = running.listEpisodes('demo');
		// Attached before `dispose()`, which rejects synchronously.
		const rejected = expect(call).rejects.toThrowError(/stopped/);
		running.dispose();

		expect(worker.terminated).toBe(true);
		await rejected;
	});
});
