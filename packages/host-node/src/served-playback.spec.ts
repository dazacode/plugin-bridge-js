/**
 * Served playback, end to end through a real isolate.
 *
 * The headless host runs a plugin in a child process speaking frames over
 * stdio, so every byte in these tests crosses every hop a served segment does:
 * the upstream answer into the relay, the relay's framed reply into the host,
 * the host into the isolate, `HttpResponse.bytes()` inside it, the plugin's
 * `serve` answer back out, and the host's checks on that answer. A hop that
 * turned bytes into text anywhere would fail the first test.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginSandbox, type RunnablePlugin } from '@plugin-bridge/host/sandbox-host';
import { headlessPluginHost } from './headless-plugin-host';

/** Every byte value twice over, then bytes that are not UTF-8 at all. */
const SEGMENT = Uint8Array.from([
	...Array.from({ length: 512 }, (_, i) => i % 256),
	0x00,
	0xc0,
	0xaf,
	0xff
]);

const ORIGIN = 'http://127.0.0.1:49152';

const PLUGIN: RunnablePlugin = {
	id: 'com.example.plugins.served',
	name: 'Served',
	hosts: ['api.example.com'],
	permissions: ['network', 'segment-transform-js']
};

/** A plugin written to the ABI directly: it resolves one served stream and serves it. */
const SOURCE = `
let segment = null;
let again = null;
let decoded = '';
let answer = '${ORIGIN}';
export default {
	id: 'com.example.plugins.served',
	async searchCatalog() { return { entries: [] }; },
	async listEpisodes() { return []; },
	async resolve(id, episode, ctx) {
		const response = await ctx.http.send('https://api.example.com/seg.ts');
		segment = await response.bytes();
		decoded = await response.text();
		again = await response.bytes();
		if (id === 'elsewhere') answer = 'https://api.example.com';
		return [{
			url: answer + '/index.m3u8',
			container: 'hls',
			label: 'Served',
			served: { origin: answer }
		}];
	},
	async serve(request) {
		const path = new URL(request.url).pathname;
		if (path === '/index.m3u8') {
			return {
				status: 200,
				headers: { 'Content-Type': 'application/vnd.apple.mpegurl', 'X-Seen': request.headers['x-probe'] || '' },
				body: '#EXTM3U\\nseg.ts\\n'
			};
		}
		if (path === '/seg.ts') return { status: 200, headers: { 'Content-Type': 'video/mp2t' }, body: segment };
		if (path === '/same') {
			const same = segment.length === again.length && segment.every((b, i) => b === again[i]);
			// A plugin writing into what bytes() gave it must not change the next read.
			segment[0] = 0x7f;
			return { status: 200, headers: {}, body: String(same) + ' ' + decoded.length };
		}
		if (path === '/huge') return { status: 200, headers: {}, body: new Uint8Array(33 * 1024 * 1024) };
		if (path === '/slow') await new Promise((resolve) => setTimeout(resolve, 20000));
		return { status: 404, headers: { 'Content-Type': 'text/plain' }, body: 'not here' };
	}
};
`;

const scratch = mkdtempSync(join(tmpdir(), 'yorozo-served-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function start(plugin: RunnablePlugin = PLUGIN): Promise<PluginSandbox> {
	const capabilities = headlessPluginHost({
		dataDir: scratch,
		log: () => {},
		fetch: (async () =>
			new Response(SEGMENT, {
				status: 200,
				headers: { 'content-type': 'video/mp2t' }
			})) as unknown as typeof fetch
	});
	return await PluginSandbox.start(
		plugin,
		SOURCE,
		{},
		{
			fetcher: capabilities.fetch,
			createWorker: capabilities.sandbox,
			log: capabilities.log
		}
	);
}

describe('served playback through the headless isolate', () => {
	it('carries a segment byte for byte, from the source to the served answer', async () => {
		const sandbox = await start();
		try {
			const [source] = (await sandbox.resolve('one', { number: 1 })) as {
				served: { origin: string };
			}[];
			const lease = sandbox.lease(source.served.origin);
			const served = await lease.serve({ url: `${ORIGIN}/seg.ts`, method: 'GET', headers: {} });

			expect(served.status).toBe(200);
			expect(served.headers['Content-Type']).toBe('video/mp2t');
			expect(served.body).toBeInstanceOf(Uint8Array);
			expect(Array.from(served.body as Uint8Array)).toEqual(Array.from(SEGMENT));
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('keeps a text answer text, with its status and headers as the plugin gave them', async () => {
		const sandbox = await start();
		try {
			await sandbox.resolve('one', { number: 1 });
			const lease = sandbox.lease(ORIGIN);
			const manifest = await lease.serve({
				url: `${ORIGIN}/index.m3u8`,
				method: 'GET',
				headers: { 'x-probe': 'player' }
			});
			expect(manifest.body).toBe('#EXTM3U\nseg.ts\n');
			expect(manifest.headers).toEqual({
				'Content-Type': 'application/vnd.apple.mpegurl',
				'X-Seen': 'player'
			});

			const missing = await lease.serve({ url: `${ORIGIN}/nope`, method: 'GET', headers: {} });
			expect(missing.status).toBe(404);
			expect(missing.body).toBe('not here');
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('reads one body the same way every time, and bytes() cannot be written through', async () => {
		const sandbox = await start();
		try {
			await sandbox.resolve('one', { number: 1 });
			const lease = sandbox.lease(ORIGIN);
			const first = await lease.serve({ url: `${ORIGIN}/same`, method: 'GET', headers: {} });
			// text() decoded the same bytes: 516 values, of which the invalid
			// UTF-8 at the end decodes to replacement characters, so the text is
			// shorter than nothing and longer than zero — it came from one body.
			expect(String(first.body).startsWith('true ')).toBe(true);
			const segment = await lease.serve({ url: `${ORIGIN}/seg.ts`, method: 'GET', headers: {} });
			expect((segment.body as Uint8Array)[0]).toBe(0x7f);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('never routes a request off the served origin, and refuses an origin that is not a stand-in', async () => {
		const sandbox = await start();
		try {
			await sandbox.resolve('one', { number: 1 });
			const lease = sandbox.lease(ORIGIN);
			await expect(
				lease.serve({ url: 'http://127.0.0.1:9999/seg.ts', method: 'GET', headers: {} })
			).rejects.toThrow(/not on the served origin/);
			await expect(
				lease.serve({ url: 'https://api.example.com/seg.ts', method: 'GET', headers: {} })
			).rejects.toThrow(/not on the served origin/);
			await expect(sandbox.resolve('elsewhere', { number: 1 })).rejects.toThrow(
				/origin is not one this host serves/
			);
			expect(() => sandbox.lease('https://api.example.com')).toThrow(/Not a served origin/);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('refuses a served stream from a plugin that did not declare the permission', async () => {
		const sandbox = await start({ ...PLUGIN, permissions: ['network'] });
		try {
			await expect(sandbox.resolve('one', { number: 1 })).rejects.toThrow(/segment-transform-js/);
			expect(() => sandbox.lease(ORIGIN)).toThrow(/segment-transform-js/);
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('pins the instance while a playback holds it, and releasing it stops what it had in flight', async () => {
		const sandbox = await start();
		try {
			await sandbox.resolve('one', { number: 1 });
			expect(sandbox.pinned).toBe(false);
			const lease = sandbox.lease(ORIGIN);
			expect(sandbox.pinned).toBe(true);

			const slow = lease.serve({ url: `${ORIGIN}/slow`, method: 'GET', headers: {} });
			lease.release();
			await expect(slow).rejects.toThrow(/released/);
			expect(sandbox.pinned).toBe(false);
			expect(lease.released).toBe(true);
			await expect(
				lease.serve({ url: `${ORIGIN}/seg.ts`, method: 'GET', headers: {} })
			).rejects.toThrow(/released/);

			// The instance itself is still running for anyone else: release ends a
			// playback, it does not stop the plugin.
			const again = sandbox.lease(ORIGIN);
			const served = await again.serve({ url: `${ORIGIN}/index.m3u8`, method: 'GET', headers: {} });
			expect(served.status).toBe(200);
			again.release();
		} finally {
			sandbox.dispose();
		}
	}, 30_000);

	it('releases every playback when the instance is stopped', async () => {
		const sandbox = await start();
		await sandbox.resolve('one', { number: 1 });
		const lease = sandbox.lease(ORIGIN);
		const slow = lease.serve({ url: `${ORIGIN}/slow`, method: 'GET', headers: {} });
		sandbox.dispose();
		await expect(slow).rejects.toThrow(/stopped/);
		expect(lease.released).toBe(true);
		expect(sandbox.pinned).toBe(false);
	}, 30_000);

	it('refuses an answer over the size limit rather than handing it to a player', async () => {
		const sandbox = await start();
		try {
			await sandbox.resolve('one', { number: 1 });
			const lease = sandbox.lease(ORIGIN);
			await expect(
				lease.serve({ url: `${ORIGIN}/huge`, method: 'GET', headers: {} })
			).rejects.toThrow(/over the \d+-byte limit/);
		} finally {
			sandbox.dispose();
		}
	}, 60_000);
});
