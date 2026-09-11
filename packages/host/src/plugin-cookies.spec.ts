/**
 * The cookie jar as a plugin actually meets it: sandbox, relay, and back.
 *
 * `cookie-jar.spec.ts` pins the scoping rules on the jar itself. This pins the
 * rules that only exist once the pieces are joined, and each of them is a
 * constraint `docs/adr/0005-network-boundaries.md` §3 named:
 *
 * - a cookie set on one host comes back to that host, and to no other;
 * - two plugins running at once do not see each other's;
 * - a jar does not survive its plugin being unloaded;
 * - and a plugin never sees a cookie, because the field the relay reports them
 *   on is stripped before the payload crosses into the isolate.
 *
 * The relay under test is the real one, driven over its real wire format, with
 * only the wider internet stubbed. A spec that mocked the relay would be
 * asserting that this file agrees with itself.
 *
 * Rule 9: every host is RFC 2606 reserved.
 */

import { describe, expect, it } from 'vitest';

import { relay } from './net/relay';
import { PluginSandbox, type RunnablePlugin } from './sandbox-host';

/** One response from the fake internet, keyed by the URL asked for. */
type Served = (url: URL) => Response;

const WITH_COOKIES: RunnablePlugin = {
	id: 'com.example.plugins.jarred',
	name: 'Jarred',
	hosts: ['a.example.invalid', 'b.example.invalid'],
	permissions: ['network', 'cookies']
};

const WITHOUT_COOKIES: RunnablePlugin = {
	...WITH_COOKIES,
	id: 'com.example.plugins.plain',
	name: 'Plain',
	permissions: ['network']
};

/**
 * A worker that is not a worker: the protocol, with a script in place of a
 * bundle.
 *
 * `PluginSandbox` talks to an isolate over four message shapes and nothing
 * else, so standing one up in-process exercises every host-side line — the
 * allowlist, the jar, the payload handed back — without a child process and
 * without a bundle to convert. `script` is what the "plugin" does when asked to
 * search: it is handed the same `http` the real `ctx.http` is, and whatever it
 * returns is what the call resolves to.
 */
class ScriptedWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	private readonly waiting = new Map<number, (reply: { ok: boolean; value?: unknown }) => void>();
	private outbound = 0;

	constructor(
		private readonly id: string,
		private readonly script: (http: (url: string) => Promise<unknown>) => Promise<unknown>
	) {}

	terminate(): void {}

	postMessage(message: Record<string, unknown>): void {
		if (message['inboundReply'] === true) {
			const settle = this.waiting.get(message['id'] as number);
			this.waiting.delete(message['id'] as number);
			settle?.({ ok: message['ok'] as boolean, value: message['value'] });
			return;
		}
		void this.serve(message);
	}

	private async serve(message: Record<string, unknown>): Promise<void> {
		const id = message['id'] as number;
		if (message['kind'] === 'load') {
			this.reply(id, { id: this.id });
			return;
		}
		this.reply(id, await this.script((url) => this.http(url)));
	}

	/** What `ctx.http` is on the far side: one host call, awaited. */
	private http(url: string): Promise<unknown> {
		this.outbound += 1;
		const id = this.outbound;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, (reply) => {
				if (reply.ok) resolve(reply.value);
				else reject(new Error('refused'));
			});
			this.emit({ outbound: true, id, method: 'http', args: [url, {}] });
		});
	}

	private reply(id: number, value: unknown): void {
		this.emit({ id, ok: true, value });
	}

	private emit(data: unknown): void {
		queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
	}
}

/**
 * The host's `fetch`, pointed at the real relay and a stubbed internet.
 *
 * `asked` records every request that reached the far side, which is where the
 * assertions about what was and was not carried are made — a `Cookie` header
 * is only interesting at the moment it leaves.
 */
function network(served: Served) {
	const asked: { url: string; cookie: string | null }[] = [];

	const fetcher = (url: string, init?: RequestInit): Promise<Response> =>
		relay(
			new Request(`https://local.invalid${url}`, { method: 'POST', body: init?.body as string }),
			(async (input: RequestInfo | URL, outbound?: RequestInit) => {
				const target = new URL(String(input));
				const headers = new Headers(outbound?.headers);
				asked.push({ url: target.toString(), cookie: headers.get('cookie') });
				return served(target);
			}) as typeof fetch
		);

	return { fetcher, asked };
}

/** Starts a sandbox whose "plugin" fetches each of `urls` in order. */
async function run(
	plugin: RunnablePlugin,
	served: Served,
	urls: readonly string[]
): Promise<{ sandbox: PluginSandbox; asked: { url: string; cookie: string | null }[] }> {
	const { fetcher, asked } = network(served);
	const sandbox = await PluginSandbox.start(
		plugin,
		'',
		{},
		{
			fetcher,
			createWorker: () =>
				new ScriptedWorker(plugin.id, async (http) => {
					const seen: unknown[] = [];
					for (const url of urls) seen.push(await http(url));
					return { entries: [], seen };
				}) as unknown as Worker
		}
	);
	return { sandbox, asked };
}

/** A page that sets one cookie, and answers with nothing else worth reading. */
function setsCookie(value: string): Served {
	return () => new Response('<html></html>', { status: 200, headers: { 'set-cookie': value } });
}

describe('a cookie comes back to the host that issued it', () => {
	it('carries a session value onto the plugin’s next request', async () => {
		// The measured shape from ADR-0005 §2: a source hands out a session
		// value on the first response and expects it on the second.
		const { sandbox, asked } = await run(WITH_COOKIES, setsCookie('session=abc; Path=/'), [
			'https://a.example.invalid/first',
			'https://a.example.invalid/second'
		]);
		try {
			await sandbox.searchCatalog('anything', 1);
		} finally {
			sandbox.dispose();
		}

		expect(asked.map((one) => one.cookie)).toEqual([null, 'session=abc']);
	});

	it('will not carry it to a different host the same plugin may also reach', async () => {
		// Both hosts are declared, so the allowlist lets both requests out. The
		// cookie still stops at the host that set it, which is the constraint
		// the whole design exists for.
		const { sandbox, asked } = await run(WITH_COOKIES, setsCookie('session=abc; Path=/'), [
			'https://a.example.invalid/first',
			'https://b.example.invalid/second'
		]);
		try {
			await sandbox.searchCatalog('anything', 1);
		} finally {
			sandbox.dispose();
		}

		expect(asked[1].url).toContain('b.example.invalid');
		expect(asked[1].cookie).toBeNull();
	});

	it('gives a plugin that did not ask for cookies none at all', async () => {
		const { sandbox, asked } = await run(WITHOUT_COOKIES, setsCookie('session=abc; Path=/'), [
			'https://a.example.invalid/first',
			'https://a.example.invalid/second'
		]);
		try {
			await sandbox.searchCatalog('anything', 1);
		} finally {
			sandbox.dispose();
		}

		expect(asked.map((one) => one.cookie)).toEqual([null, null]);
	});
});

describe('one jar per plugin, and per run', () => {
	it('does not show one plugin what another was given', async () => {
		const served = setsCookie('session=first-plugin; Path=/');
		const first = await run(WITH_COOKIES, served, ['https://a.example.invalid/first']);
		try {
			await first.sandbox.searchCatalog('anything', 1);
		} finally {
			first.sandbox.dispose();
		}

		// A second plugin, same host, running against the same relay. It has
		// asked for cookies itself, so an absent header here is scoping rather
		// than the permission being missing.
		const other: RunnablePlugin = { ...WITH_COOKIES, id: 'com.example.plugins.other' };
		const second = await run(other, () => new Response('<html></html>'), [
			'https://a.example.invalid/second'
		]);
		try {
			await second.sandbox.searchCatalog('anything', 1);
		} finally {
			second.sandbox.dispose();
		}

		expect(first.asked[0].cookie).toBeNull();
		expect(second.asked[0].cookie).toBeNull();
	});

	it('does not survive the plugin being unloaded and started again', async () => {
		const served = setsCookie('session=abc; Path=/');
		const first = await run(WITH_COOKIES, served, ['https://a.example.invalid/first']);
		try {
			await first.sandbox.searchCatalog('anything', 1);
		} finally {
			// The unload. Everything the run learned goes with it.
			first.sandbox.dispose();
		}

		const again = await run(WITH_COOKIES, served, ['https://a.example.invalid/first']);
		try {
			await again.sandbox.searchCatalog('anything', 1);
		} finally {
			again.sandbox.dispose();
		}

		expect(again.asked[0].cookie).toBeNull();
	});
});

describe('what the plugin is told about any of it', () => {
	it('hands the isolate no trace of a Set-Cookie', async () => {
		// The relay reports cookies to the *host* on a field of its own. If that
		// field ever reached the isolate, the jar would have handed a plugin the
		// credential it exists to keep from it.
		const { sandbox } = await run(WITH_COOKIES, setsCookie('session=abc; Path=/'), [
			'https://a.example.invalid/first'
		]);
		let answer: { seen: Record<string, unknown>[] };
		try {
			answer = (await sandbox.searchCatalog('anything', 1)) as typeof answer;
		} finally {
			sandbox.dispose();
		}

		const payload = answer.seen[0];
		expect(payload['setCookie']).toBeUndefined();
		expect(Object.keys(payload['headers'] as object)).not.toContain('set-cookie');
		expect(JSON.stringify(payload)).not.toContain('abc');
	});
});
