/**
 * The gate between "converted" and "installed".
 *
 * What is worth pinning here is not that a working plugin passes — it is that
 * each of the four ways a conversion goes wrong is reported as *that* way, and
 * that a partial success is a failure. A module that loads and searches but
 * resolves nothing is the exact output of a half-working converter, and it is
 * indistinguishable from a working plugin until somebody presses play.
 *
 * The Worker is the same in-process double `sandbox-host.spec.ts` uses: Node
 * has no browser Worker, so what is under test is the gate's logic, not the
 * browser's module evaluation.
 */

import { describe, expect, it } from 'vitest';

import { describeVerification, verifyConvertedPlugin } from './verify';
import type { RunnablePlugin } from '@plugin-bridge/host/sandbox-host';

const PLUGIN: RunnablePlugin = {
	id: 'app.yorozo.converted.sora.example',
	name: 'Example',
	hosts: ['watch.example.invalid']
};

type Answers = Partial<Record<string, unknown | (() => never)>>;

/**
 * Urls the “module” asks for during a call, before it answers.
 *
 * There is no seam for a refused host: the only honest way to make the
 * sandbox refuse one is to have the plugin ask for it, which means the double
 * has to speak the outbound half of the protocol too. So it does, and the real
 * `PluginSandbox` allowlist decides what happens — the same check the running
 * app applies.
 */
type Attempts = Partial<Record<string, readonly string[]>>;

/** A Worker double that answers each ABI call from a table. */
class FakeWorker implements Partial<Worker> {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	constructor(
		private readonly answers: Answers,
		private readonly attempts: Attempts = {}
	) {}

	private outboundId = 1;
	private readonly waiting = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();

	postMessage(message: unknown): void {
		const data = message as
			| { id: number; kind: string }
			| {
					inboundReply: true;
					id: number;
					ok: boolean;
					value?: unknown;
					error?: string;
			  };

		if ('inboundReply' in data) {
			const pending = this.waiting.get(data.id);
			this.waiting.delete(data.id);
			if (data.ok) pending?.resolve(data.value);
			else pending?.reject(new Error(data.error));
			return;
		}

		const answer = this.answers[data.kind];

		void (async () => {
			// Each address inside its own `try`, which is how these modules are
			// written: a refusal raised by the host is caught here and never
			// reaches the run, so the call goes on to answer from the table.
			for (const url of this.attempts[data.kind] ?? []) {
				try {
					await this.http(url);
				} catch {
					continue;
				}
			}

			if (typeof answer === 'function') {
				try {
					(answer as () => never)();
				} catch (error) {
					const failure = error as Error;
					this.emit({
						id: data.id,
						ok: false,
						error: { name: failure.name, message: failure.message }
					});
					return;
				}
			}
			this.emit({ id: data.id, ok: true, value: answer });
		})();
	}

	terminate(): void {}

	/** One `ctx.http` call, answered by the host's allowlist rather than a table. */
	private http(url: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this.outboundId;
			this.outboundId += 1;
			this.waiting.set(id, { resolve, reject });
			this.emit({ outbound: true, id, method: 'http', args: [url, {}] });
		});
	}

	private emit(data: unknown): void {
		queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
	}
}

function run(answers: Answers, attempts: Attempts = {}) {
	return verifyConvertedPlugin(PLUGIN, 'export default {};', {
		createWorker: () => new FakeWorker(answers, attempts) as unknown as Worker
	});
}

const WORKING: Answers = {
	load: { id: PLUGIN.id },
	searchCatalog: {
		entries: [{ sourceMediaId: 'https://watch.example.invalid/show/1' }]
	},
	listEpisodes: [{ number: 1, sourceEpisodeId: 'https://watch.example.invalid/show/1/ep/1' }],
	resolve: [{ url: 'https://cdn.example.invalid/one.m3u8', container: 'hls' }]
};

describe('a plugin that does the whole job', () => {
	it('passes, and says what it found', async () => {
		const result = await run(WORKING);

		expect(result.ok).toBe(true);
		expect(result.failedAt).toBeNull();
		expect(result).toMatchObject({
			searchHits: 1,
			episodeCount: 1,
			streamCount: 1
		});
		expect(describeVerification('Example', result)).toMatch(/answered a test search/);
	});
});

describe('a stream that is only a string', () => {
	it('fails when nothing answers at the address it resolved', async () => {
		// The false pass this exists to stop, seen for real: these modules signal
		// failure *by returning a URL*, so a module that gave up is
		// indistinguishable from one that succeeded until something fetches it.
		// It reported green, and the failure surfaced later as a player error.
		const result = await verifyConvertedPlugin(PLUGIN, 'export default {};', {
			createWorker: () => new FakeWorker(WORKING) as unknown as Worker,
			reach: async () => ({ ok: false, detail: '404 from the host' })
		});

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'reach',
			streamCount: 1
		});
		// The reason, and whose address it was. Answering "nothing answered"
		// for a refused host, an unverifiable chain and a genuine placeholder
		// alike sent a whole afternoon looking at the wrong sources.
		expect(result.detail).toMatch(/cdn\.example\.invalid: 404 from the host/);
		expect(describeVerification('Example', result)).toMatch(/nothing answered for/);
	});

	it('names every mirror that refused, once each', async () => {
		// Four addresses refused for one reason should read as one reason; two
		// addresses refused for different reasons are two different problems and
		// collapsing them loses the one that is ours.
		const result = await verifyConvertedPlugin(PLUGIN, 'export default {};', {
			createWorker: () =>
				new FakeWorker({
					...WORKING,
					resolve: [
						{ url: 'https://a.example.invalid/1.m3u8', container: 'hls' },
						{ url: 'https://b.example.invalid/2.m3u8', container: 'hls' }
					]
				}) as unknown as Worker,
			reach: async (url) =>
				url.includes('a.example')
					? { ok: false, detail: 'host not in the converted allowlist' }
					: { ok: false, detail: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }
		});

		expect(result.detail).toMatch(/a\.example\.invalid: host not in the converted allowlist/);
		expect(result.detail).toMatch(/b\.example\.invalid: UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
	});

	it('passes as soon as any one mirror answers', async () => {
		// Sources routinely return several and expect the player to fall through
		// them, so one dead mirror is not a verdict on the plugin.
		const tried: string[] = [];
		const result = await verifyConvertedPlugin(PLUGIN, 'export default {};', {
			createWorker: () =>
				new FakeWorker({
					...WORKING,
					resolve: [
						{ url: 'https://dead.example.invalid/a.m3u8', container: 'hls' },
						{ url: 'https://live.example.invalid/b.m3u8', container: 'hls' }
					]
				}) as unknown as Worker,
			reach: async (url) => {
				tried.push(url);
				return url.indexOf('live.') !== -1
					? { ok: true }
					: { ok: false, detail: 'nothing listening' };
			}
		});

		expect(result.ok).toBe(true);
		expect(tried).toHaveLength(2);
	});

	it('hands the probe the stream’s own request headers', async () => {
		// These modules resolve onto a CDN that serves nothing without the
		// `Referer` of the embed page. A probe given only the url got a 403 and
		// reported a working stream as a placeholder.
		let seen: Record<string, string> | undefined;
		const result = await verifyConvertedPlugin(PLUGIN, 'export default {};', {
			createWorker: () =>
				new FakeWorker({
					...WORKING,
					resolve: [
						{
							url: 'https://cdn.example.invalid/a.m3u8',
							container: 'hls',
							headers: {
								Referer: 'https://embed.example.invalid/',
								'X-Junk': 7
							}
						}
					]
				}) as unknown as Worker,
			reach: async (_url, headers) => {
				seen = headers;
				return { ok: true };
			}
		});

		expect(result.ok).toBe(true);
		// Only the string-valued ones: a module may attach anything, and what
		// reaches the proxy has to be a header map.
		expect(seen).toEqual({ Referer: 'https://embed.example.invalid/' });
	});

	it('claims no more than it verified when no probe is available', async () => {
		// Without a probe the check stops after resolve. It must not present that
		// as though a stream had been reached.
		const result = await verifyConvertedPlugin(PLUGIN, 'export default {};', {
			createWorker: () => new FakeWorker(WORKING) as unknown as Worker
		});
		expect(result.ok).toBe(true);
		expect(result.failedAt).toBeNull();
	});
});

describe('each way a conversion fails is reported as that way', () => {
	it('names the load step when the bundle will not evaluate', async () => {
		const result = await run({
			...WORKING,
			load: { id: 'something.else.entirely' }
		});

		expect(result).toMatchObject({ ok: false, failedAt: 'load' });
		// The sandbox's own complaint, carried through: a bundle whose code
		// disagrees with its manifest is a specific, fixable fault.
		expect(result.detail).toMatch(/manifest says/);
	});

	it('names the search step when nothing comes back', async () => {
		const result = await run({ ...WORKING, searchCatalog: { entries: [] } });

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'search',
			searchHits: 0
		});
		expect(describeVerification('Example', result)).toBe(
			'Example could not search. Searching this source returned nothing.'
		);
	});

	it('distinguishes results with no usable id from no results at all', async () => {
		const result = await run({
			...WORKING,
			searchCatalog: { entries: [{ title: 'no id' }] }
		});

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'search',
			searchHits: 1
		});
		expect(result.detail).toMatch(/carried no id/);
	});

	it('names the episode step, and keeps the plugin’s own message', async () => {
		const result = await run({
			...WORKING,
			listEpisodes: () => {
				// The error class that makes a broken source actionable: it names
				// what changed and where. Flattening it here would waste the whole
				// mechanism (ABI.md §5).
				const error = new Error('the episode list selector matched nothing at /show/1');
				error.name = 'SourceChangedError';
				throw error;
			}
		});

		expect(result).toMatchObject({ ok: false, failedAt: 'episodes' });
		expect(result.detail).toBe('the episode list selector matched nothing at /show/1');
	});

	it('fails a plugin that searches and lists but resolves nothing', async () => {
		// The half-working converter's signature output, and the reason all four
		// steps run rather than just `load`.
		const result = await run({ ...WORKING, resolve: [] });

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'resolve',
			searchHits: 1,
			episodeCount: 1,
			streamCount: 0
		});
	});

	it('rejects a stream that is not https or not playable', async () => {
		for (const stream of [
			{ url: 'http://cdn.example.invalid/one.m3u8', container: 'hls' },
			{ url: 'https://cdn.example.invalid/one.mkv', container: 'matroska' },
			{ url: 'magnet:?xt=urn:btih:0000' }
		]) {
			const result = await run({ ...WORKING, resolve: [stream] });
			expect(result.ok).toBe(false);
			expect(result.failedAt).toBe('resolve');
		}
	});
});
describe('a run that came to nothing because hosts were refused', () => {
	// The failure this whole clause exists for, seen against a live module. It
	// resolves a stream by following redirect links out of the page it has just
	// scraped, landing on embed providers whose hostnames appear nowhere in its
	// code — so the conversion cannot derive them, and the sandbox is right to
	// refuse them. But the module asks for each provider inside its own `try`,
	// so the refusal is caught by the module and swallowed, and the run ends
	// returning an empty list. With the allowlist enforced it produced no
	// streams at all; with the same module let through, a real playable one. All
	// the gate said was that the source returned no stream, and a viewer went
	// looking for a broken source that was working.
	const EMBEDS = [
		'https://one.embed.example.invalid/e/1',
		'https://two.embed.example.invalid/e/1',
		'https://three.embed.example.invalid/e/1'
	];

	it('reports the empty stream list and the hosts we declined', async () => {
		const result = await run({ ...WORKING, resolve: [] }, { resolve: EMBEDS });

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'resolve',
			streamCount: 0
		});
		// Both facts together. Either one alone is misleading: the first blames
		// the source for something we did, and the second on its own does not say
		// what the run came to.
		expect(result.detail).toMatch(/That source returned no stream for its first episode\./);
		expect(result.detail).toMatch(
			/one\.embed\.example\.invalid, two\.embed\.example\.invalid, three\.embed\.example\.invalid/
		);
		expect(result.detail).toMatch(/the conversion could not know to declare/);
	});

	it('adds nothing at all when no host was refused', async () => {
		// The other half of the fix, and the easier one to get wrong: a module
		// that simply has no stream must still read as a plain sentence. An empty
		// or dangling clause on every ordinary failure would bury the one case
		// where it means something.
		const result = await run({ ...WORKING, resolve: [] });

		expect(result.detail).toBe('That source returned no stream for its first episode.');
		expect(result.detail).not.toMatch(/refused/);
	});

	it('reads as one host or as several', async () => {
		// Read by a viewer, not a log reader. “It was also refused one host it
		// tried” has to agree with itself either way.
		const one = await run({ ...WORKING, resolve: [] }, { resolve: EMBEDS.slice(0, 1) });

		expect(one.detail).toMatch(/refused one\.embed\.example\.invalid — host it tried/);
		expect(one.detail).not.toMatch(/hosts it tried/);

		const two = await run({ ...WORKING, resolve: [] }, { resolve: EMBEDS.slice(0, 2) });

		expect(two.detail).toMatch(
			/refused one\.embed\.example\.invalid, two\.embed\.example\.invalid — hosts it tried/
		);
	});

	it('carries them when the module got no further than its first request', async () => {
		// The same under-declaration stops some modules at the search, where it
		// read as an empty catalogue — a source apparently holding nothing, for
		// exactly the same reason and with exactly as little to act on.
		const result = await run(
			{ ...WORKING, searchCatalog: { entries: [] } },
			{ searchCatalog: EMBEDS.slice(0, 1) }
		);

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'search',
			searchHits: 0
		});
		expect(result.detail).toMatch(/Searching this source returned nothing\./);
		expect(result.detail).toMatch(/one\.embed\.example\.invalid/);
	});
});

describe('a run that came to nothing at hosts the proxy could not reach', () => {
	// The sibling of the clause above, for the failures that are not refusals.
	// These modules walk a list of mirrors inside their own `try`, so a dead
	// host, an expired certificate and a 403 are swallowed identically and the
	// run ends returning nothing. The proxy knew exactly what went wrong at each
	// one — it names the DNS failure, the chain it could not build, the status —
	// and every word of it was discarded one frame above, leaving a console full
	// of bare 502s and a verdict that blamed the source for having no stream.
	const MIRRORS: RunnablePlugin = {
		...PLUGIN,
		hosts: ['one.mirror.example.invalid', 'two.mirror.example.invalid']
	};

	const ATTEMPTS = {
		resolve: ['https://one.mirror.example.invalid/e/1', 'https://two.mirror.example.invalid/e/1']
	};

	/** A proxy that fails both mirrors, each for its own reason. */
	const failing = (async (_input: RequestInfo | URL, init?: RequestInit) => {
		const sent = JSON.parse(String(init?.body)) as { url: string };
		return Response.json(
			{
				error: sent.url.startsWith('https://one.')
					? 'ENOTFOUND'
					: 'the certificate chain could not be built'
			},
			{ status: 502 }
		);
	}) as typeof fetch;

	it('names each host the proxy could not reach and what it said', async () => {
		const result = await verifyConvertedPlugin(MIRRORS, 'export default {};', {
			createWorker: () =>
				new FakeWorker({ ...WORKING, resolve: [] }, ATTEMPTS) as unknown as Worker,
			fetcher: failing
		});

		expect(result).toMatchObject({
			ok: false,
			failedAt: 'resolve',
			streamCount: 0
		});
		// Both facts, as with a refusal: what the run came to, and the evidence
		// that says whose fault it was. A name resolution that fails and a
		// certificate this runtime cannot verify are different problems, and only
		// one of them is the source's.
		expect(result.detail).toMatch(/That source returned no stream for its first episode\./);
		expect(result.detail).toMatch(
			/Along the way: one\.mirror\.example\.invalid: ENOTFOUND; two\.mirror\.example\.invalid: the certificate chain could not be built\./
		);
	});

	it('adds no clause at all when every request was answered', async () => {
		// The same trap the refusal clause has: a module that simply has no
		// stream must still read as one plain sentence. A dangling "Along the
		// way:" on every ordinary failure would bury the case where it carries
		// something.
		const answering = (async (_input: RequestInfo | URL, init?: RequestInit) => {
			const sent = JSON.parse(String(init?.body)) as { url: string };
			return Response.json({
				status: 200,
				url: sent.url,
				headers: {},
				body: ''
			});
		}) as typeof fetch;

		const result = await verifyConvertedPlugin(MIRRORS, 'export default {};', {
			createWorker: () =>
				new FakeWorker({ ...WORKING, resolve: [] }, ATTEMPTS) as unknown as Worker,
			fetcher: answering
		});

		expect(result.detail).toBe('That source returned no stream for its first episode.');
		expect(result.detail).not.toMatch(/Along the way/);
	});
});
