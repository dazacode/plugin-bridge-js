/**
 * A Nuvio scraper's answers, as the bundle hands them to the host.
 *
 * This shim used to skip the guards every other one applies, and read its own
 * container and its own torrents. What is pinned here is the difference that
 * made: a scraper that has given up answers with an address that is not a
 * stream, and that must not reach the install check as one.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { nuvioEntrypoint } from './nuvio-entry';

async function resolveRows(rows: unknown[]): Promise<Record<string, unknown>[]> {
	const directory = await mkdtemp(join(tmpdir(), 'nuvio-entry-'));
	const file = join(directory, 'entry.mjs');
	await writeFile(
		file,
		nuvioEntrypoint({
			pluginId: 'test.nuvio',
			script: `async function getStreams() { return ${JSON.stringify(rows)}; }
module.exports = { getStreams };`
		})
	);
	// The bundle assigns the React Native \`navigator\` onto the global, which a
	// sandbox allows and node's getter-only one does not; it is lent back after.
	const ambient = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	delete (globalThis as Record<string, unknown>)['navigator'];
	try {
		const loaded = (await import(`file://${file}`)) as {
			default: {
				resolve(id: string, episode: unknown, ctx: unknown): Promise<Record<string, unknown>[]>;
			};
		};
		return await loaded.default.resolve('movie:1', null, {
			settings: { string: () => '', boolean: () => false, list: () => [] }
		});
	} finally {
		if (ambient !== undefined) Object.defineProperty(globalThis, 'navigator', ambient);
	}
}

const HEX = '0123456789abcdef0123456789abcdef01234567';

describe('a Nuvio scraper, through the shared guards', () => {
	it('refuses a bare origin, which is a scraper giving up and not a stream', async () => {
		const sources = await resolveRows([
			{ name: 'Gave up', url: 'https://placeholder.example.invalid' },
			{ name: 'Real', url: 'https://cdn.example.invalid/v/1.mp4' }
		]);
		expect(sources.map((one) => one.url)).toEqual(['https://cdn.example.invalid/v/1.mp4']);
	});

	it('reads the container by the shared rule, not by a substring anywhere', async () => {
		const sources = await resolveRows([
			{ name: 'A', url: 'https://cdn.example.invalid/hls/master.m3u8?sig=1' },
			// '.m3u8' in a *query word* used to make this HLS; it names no file.
			{ name: 'B', url: 'https://cdn.example.invalid/v/2.mp4?from=list.m3u8x' },
			{ name: 'C', url: 'https://cdn.example.invalid/v/3.mkv' }
		]);
		expect(sources.map((one) => one.container)).toEqual(['hls', 'mp4', 'mp4']);
	});

	it('reads a base32 magnet, and its trackers, as the other ecosystems do', async () => {
		const sources = await resolveRows([
			{
				name: 'Swarm',
				url: 'magnet:?xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH&tr=udp%3A%2F%2Ft.test%3A1'
			}
		]);
		expect(sources).toEqual([
			{ torrent: { infoHash: HEX, sources: ['udp://t.test:1'] }, label: 'Swarm' }
		]);
	});
});
