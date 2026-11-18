/**
 * The credentials a plugin authored itself, as they leave the host.
 *
 * `docs/adr/0005-network-boundaries.md` §3c and §3d are the decisions; these
 * pin their bounds where the pieces are joined — sandbox, the real relay over
 * its real wire, and a stubbed internet. A credential is only interesting at
 * the moment it leaves, so every assertion is made on what reached the far side.
 *
 * Rule 9: every host is RFC 2606 reserved.
 */

import { describe, expect, it } from 'vitest';

import { relay } from './net/relay';
import { PluginSandbox, type RunnablePlugin } from './sandbox-host';

type Served = (url: URL) => Response;
type HostCall = (method: string, ...args: unknown[]) => Promise<unknown>;

const PLUGIN: RunnablePlugin = {
	id: 'com.example.plugins.credentialed',
	name: 'Credentialed',
	hosts: ['api.example.invalid', 'www.example.invalid'],
	permissions: ['network', 'cookies'],
	// Converted, so a host read off a page is learned at run time — the case
	// the declared-grant rule exists to tell apart.
	converted: {
		format: 'aniyomi',
		foreignId: 'example',
		foreignVersion: '14.1',
		convertedAt: '2026-01-01T00:00:00.000Z',
		converterVersion: 1,
		verified: false
	}
};

/** A worker standing in for the isolate: the protocol, with a script in place of a bundle. */
class ScriptedWorker {
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: unknown) => void) | null = null;

	private readonly waiting = new Map<
		number,
		(reply: { ok: boolean; value?: unknown; error?: string }) => void
	>();
	private outbound = 0;

	constructor(
		private readonly id: string,
		private readonly script: (call: HostCall) => Promise<unknown>
	) {}

	terminate(): void {}

	postMessage(message: Record<string, unknown>): void {
		if (message['inboundReply'] === true) {
			const settle = this.waiting.get(message['id'] as number);
			this.waiting.delete(message['id'] as number);
			settle?.({
				ok: message['ok'] as boolean,
				value: message['value'],
				error: message['error'] as string | undefined
			});
			return;
		}
		void this.serve(message);
	}

	private async serve(message: Record<string, unknown>): Promise<void> {
		const id = message['id'] as number;
		if (message['kind'] === 'load') {
			this.emit({ id, ok: true, value: { id: this.id } });
			return;
		}
		try {
			this.emit({
				id,
				ok: true,
				value: await this.script((method, ...args) => this.call(method, args))
			});
		} catch (error) {
			this.emit({ id, ok: false, error: { name: 'Error', message: (error as Error).message } });
		}
	}

	private call(method: string, args: unknown[]): Promise<unknown> {
		this.outbound += 1;
		const id = this.outbound;
		return new Promise((resolve, reject) => {
			this.waiting.set(id, (reply) => {
				if (reply.ok) resolve(reply.value);
				else reject(new Error(reply.error ?? 'refused'));
			});
			this.emit({ outbound: true, id, method, args });
		});
	}

	private emit(data: unknown): void {
		queueMicrotask(() => this.onmessage?.({ data } as MessageEvent));
	}
}

interface Asked {
	readonly url: string;
	readonly authorization: string | null;
	readonly cookie: string | null;
}

/** Runs `script` as the plugin's search, over the real relay and `served`. */
async function run(
	served: Served,
	script: (call: HostCall) => Promise<unknown>,
	plugin: RunnablePlugin = PLUGIN
): Promise<{ asked: Asked[]; value: unknown }> {
	const asked: Asked[] = [];
	const fetcher = (url: string, init?: RequestInit): Promise<Response> =>
		relay(
			new Request(`https://local.invalid${url}`, { method: 'POST', body: init?.body as string }),
			(async (input: RequestInfo | URL, outbound?: RequestInit) => {
				const target = new URL(String(input));
				const headers = new Headers(outbound?.headers);
				asked.push({
					url: target.toString(),
					authorization: headers.get('authorization'),
					cookie: headers.get('cookie')
				});
				return served(target);
			}) as typeof fetch
		);
	const sandbox = await PluginSandbox.start(
		plugin,
		'',
		{},
		{ fetcher, createWorker: () => new ScriptedWorker(plugin.id, script) as unknown as Worker }
	);
	try {
		const value = await sandbox.searchCatalog('anything', 1);
		return { asked, value };
	} finally {
		sandbox.dispose();
	}
}

const ok: Served = () => new Response('{}', { status: 200 });

describe('a plugin-authored Authorization (ADR-0005 §3c)', () => {
	it('reaches a host the plugin declared', async () => {
		const { asked } = await run(ok, async (call) => {
			await call('http', 'https://api.example.invalid/search', {
				headers: { Authorization: 'Bearer own-token' }
			});
			return { entries: [] };
		});
		expect(asked).toEqual([
			{ url: 'https://api.example.invalid/search', authorization: 'Bearer own-token', cookie: null }
		]);
	});

	it('is dropped for a host the run only learned, not one the plugin declared', async () => {
		// The declared page names an embed host, which a converted plugin may
		// then reach — but it never asked a viewer to trust it with a credential.
		const served: Served = (url) =>
			url.hostname === 'www.example.invalid'
				? new Response('<iframe src="https://embed.example.invalid/e/1"></iframe>', {
						status: 200,
						headers: { 'content-type': 'text/html' }
					})
				: new Response('{}', { status: 200 });
		const { asked } = await run(served, async (call) => {
			await call('http', 'https://www.example.invalid/page');
			await call('http', 'https://embed.example.invalid/e/1', {
				headers: { authorization: 'Bearer own-token' }
			});
			return { entries: [] };
		});
		expect(asked.map((one) => [one.url, one.authorization])).toEqual([
			['https://www.example.invalid/page', null],
			['https://embed.example.invalid/e/1', null]
		]);
	});

	it('is dropped on a redirect that leaves its origin, and kept on one that does not', async () => {
		const served: Served = (url) => {
			if (url.pathname === '/one') {
				return new Response(null, { status: 302, headers: { location: '/two' } });
			}
			if (url.pathname === '/two') {
				return new Response(null, {
					status: 302,
					headers: { location: 'https://www.example.invalid/three' }
				});
			}
			return new Response('{}', { status: 200 });
		};
		const { asked } = await run(served, async (call) => {
			await call('http', 'https://api.example.invalid/one', {
				headers: { Authorization: 'Bearer own-token' }
			});
			return { entries: [] };
		});
		expect(asked.map((one) => [one.url, one.authorization])).toEqual([
			['https://api.example.invalid/one', 'Bearer own-token'],
			['https://api.example.invalid/two', 'Bearer own-token'],
			['https://www.example.invalid/three', null]
		]);
	});

	it('is absent when the plugin did not set one', async () => {
		const { asked } = await run(ok, async (call) => {
			await call('http', 'https://api.example.invalid/search', { headers: { Accept: '*/*' } });
			return { entries: [] };
		});
		expect(asked[0].authorization).toBeNull();
	});
});

describe('a plugin reading its own cookies (ADR-0005 §3d)', () => {
	it('sees the cookies its own requests were given, for a host it declared', async () => {
		const served: Served = () =>
			new Response('ok', { status: 200, headers: { 'set-cookie': 'sid=own; Path=/' } });
		const { value } = await run(served, async (call) => {
			await call('http', 'https://api.example.invalid/page');
			return { entries: [], seen: await call('httpCookies', 'https://api.example.invalid/next') };
		});
		expect((value as { seen: unknown }).seen).toEqual([{ name: 'sid', value: 'own' }]);
	});

	it('sees nothing for a host it did not declare, though its jar holds one there', async () => {
		// The embed host was learned from a page, so a request to it is allowed
		// and its cookie is carried on the next one — but reading it is not.
		const served: Served = (url) =>
			url.hostname === 'www.example.invalid'
				? new Response('<iframe src="https://embed.example.invalid/e/1"></iframe>', {
						status: 200,
						headers: { 'content-type': 'text/html' }
					})
				: new Response('ok', { status: 200, headers: { 'set-cookie': 'embed=1; Path=/' } });
		const { asked, value } = await run(served, async (call) => {
			await call('http', 'https://www.example.invalid/page');
			await call('http', 'https://embed.example.invalid/e/1');
			await call('http', 'https://embed.example.invalid/e/2');
			return { entries: [], seen: await call('httpCookies', 'https://embed.example.invalid/e/3') };
		});
		expect(asked[2].cookie).toBe('embed=1');
		expect((value as { seen: unknown }).seen).toEqual([]);
	});

	it('sees nothing when the plugin holds no jar', async () => {
		const served: Served = () =>
			new Response('ok', { status: 200, headers: { 'set-cookie': 'sid=own; Path=/' } });
		const { value } = await run(
			served,
			async (call) => {
				await call('http', 'https://api.example.invalid/page');
				return { entries: [], seen: await call('httpCookies', 'https://api.example.invalid/next') };
			},
			{ ...PLUGIN, permissions: ['network'] }
		);
		expect((value as { seen: unknown }).seen).toEqual([]);
	});
});
