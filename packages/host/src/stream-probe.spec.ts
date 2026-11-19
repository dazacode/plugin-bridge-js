/**
 * The verified-playable probe: a stream counts when its bytes are media, never
 * on a status alone. Each case is a way a resolved url has been seen to
 * "answer" without anything a player could open.
 */
import { describe, expect, it } from 'vitest';

import { encodeFrame } from './net/frames';
import { FRAME_CONTENT_TYPE } from './net/relay';
import {
	disguisedTransportStream,
	firstReference,
	mediaKind,
	streamMediaProbe
} from './stream-probe';

const bytes = (text: string) => new TextEncoder().encode(text);

const mp4 = Uint8Array.from([0, 0, 0, 0x20, ...bytes('ftypisom'), 0, 0, 0, 0]);
const ts = (() => {
	const out = new Uint8Array(188 * 3);
	out[0] = 0x47;
	out[188] = 0x47;
	out[376] = 0x47;
	return out;
})();

interface Served {
	status?: number;
	type?: string;
	body: Uint8Array;
}

/** A relay that answers from a table, and records what it was asked. */
function relay(table: Record<string, Served>) {
	const asked: { url: string; headers: Record<string, string> }[] = [];
	const fetcher = async (_route: string, init?: RequestInit): Promise<Response> => {
		const request = JSON.parse(String(init?.body)) as {
			url: string;
			headers: Record<string, string>;
		};
		asked.push(request);
		const served = table[request.url];
		const answer =
			served === undefined
				? { status: 404, url: request.url, headers: {}, body: new Uint8Array(0) }
				: {
						status: served.status ?? 206,
						url: request.url,
						headers: served.type === undefined ? {} : { 'content-type': served.type },
						body: served.body
					};
		return new Response(encodeFrame(answer) as BodyInit, {
			headers: { 'content-type': FRAME_CONTENT_TYPE }
		});
	};
	return { asked, probe: streamMediaProbe(fetcher) };
}

const HOSTS = ['media.example', '*.cdn.example'];

describe('streamMediaProbe', () => {
	it('counts a container signature, and sends the stream headers with a range', async () => {
		const { probe, asked } = relay({ 'https://media.example/v.mp4': { body: mp4 } });
		expect(
			await probe('https://media.example/v.mp4', { Referer: 'https://site.example/' }, HOSTS)
		).toEqual({
			ok: true
		});
		expect(asked[0].headers['referer']).toBe('https://site.example/');
		expect(asked[0].headers['range']).toMatch(/^bytes=0-/);
	});

	it('refuses a 200 that is an HTML page, saying so', async () => {
		const { probe } = relay({
			'https://media.example/v.mp4': {
				status: 200,
				type: 'text/html',
				body: bytes('<!doctype html><p>no')
			}
		});
		const outcome = await probe('https://media.example/v.mp4', {}, HOSTS);
		expect(outcome).toEqual({
			ok: false,
			detail: 'the stream answered 200 (text/html) with an HTML page'
		});
	});

	it('refuses a zero-byte placeholder file', async () => {
		const { probe } = relay({
			'https://media.example/v.mp4': { status: 200, type: 'video/mp4', body: new Uint8Array(0) }
		});
		const outcome = await probe('https://media.example/v.mp4', {}, HOSTS);
		expect(outcome.ok).toBe(false);
	});

	it('follows a master playlist to a segment, resolving each address against the last', async () => {
		const { probe, asked } = relay({
			'https://media.example/hls/master.m3u8': {
				body: bytes('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n')
			},
			'https://media.example/hls/low/index.m3u8': {
				body: bytes('#EXTM3U\n#EXTINF:4,\nhttps://a.cdn.example/seg0.ts\n')
			},
			'https://a.cdn.example/seg0.ts': { body: ts }
		});
		expect(await probe('https://media.example/hls/master.m3u8', {}, HOSTS)).toEqual({ ok: true });
		expect(asked.map((one) => one.url)).toEqual([
			'https://media.example/hls/master.m3u8',
			'https://media.example/hls/low/index.m3u8',
			'https://a.cdn.example/seg0.ts'
		]);
	});

	it('refuses a playlist whose segment host turns the request away', async () => {
		const { probe } = relay({
			'https://media.example/index.m3u8': { body: bytes('#EXTM3U\n#EXTINF:4,\nseg0.ts\n') },
			'https://media.example/seg0.ts': { status: 403, body: bytes('denied') }
		});
		expect(await probe('https://media.example/index.m3u8', {}, HOSTS)).toEqual({
			ok: false,
			detail: 'its first segment answered 403'
		});
	});

	it('counts a transport stream behind an image header, and nothing else behind one', async () => {
		const png = Uint8Array.from([0x89, ...bytes('PNG\r\n\x1a\n'), ...new Uint8Array(60)]);
		const disguised = new Uint8Array(png.length + ts.length);
		disguised.set(png);
		disguised.set(ts, png.length);
		expect(disguisedTransportStream(disguised)).toBe(true);
		expect(disguisedTransportStream(png)).toBe(false);
	});

	it('refuses plain http and hosts outside the allowlist without a request', async () => {
		const { probe, asked } = relay({});
		expect(await probe('http://media.example/v.mp4', {}, HOSTS)).toEqual({
			ok: false,
			detail: 'http, not https'
		});
		expect(await probe('https://elsewhere.example/v.mp4', {}, HOSTS)).toEqual({
			ok: false,
			detail: 'host not in the converted allowlist'
		});
		expect(asked).toEqual([]);
	});
});

describe('stream signatures', () => {
	it('names the containers players open', () => {
		expect(mediaKind(mp4)).toBe('mp4');
		expect(mediaKind(ts)).toBe('mpegts');
		expect(mediaKind(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('matroska');
		expect(mediaKind(bytes('<html>'))).toBeNull();
	});

	it('reads the first reference of a playlist, preferring an init segment', () => {
		expect(firstReference('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s\n')).toEqual({
			kind: 'segment',
			uri: 'init.mp4'
		});
		expect(firstReference('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n\nv/a.m3u8\n')).toEqual({
			kind: 'variant',
			uri: 'v/a.m3u8'
		});
		expect(firstReference('#EXTM3U\n#EXT-X-ENDLIST\n')).toBeNull();
	});
});
