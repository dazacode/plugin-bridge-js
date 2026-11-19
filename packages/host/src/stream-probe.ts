/**
 * Whether a stream a source returned answers with media.
 *
 * The check's last step for a video source (`core/verify.ts`), and the stage
 * `docs/measurements.md` calls _verified playable_. A source signals failure by
 * returning a url, so "it resolved a stream" and "a stream is there" are
 * different claims, and only the second is worth a column.
 *
 * A status is not that claim. A hotlink-protected CDN answers 200 with an HTML
 * page, an expired token answers 200 with a JSON error, and one family of
 * extractors falls back to a zero-byte placeholder file. So the probe reads the
 * first bytes, through the host's own relay and with exactly the headers the
 * source attached to the stream, and counts only:
 *
 * - **a container's own signature** — MP4/fMP4, Matroska/WebM, MPEG-TS, FLV;
 * - **a DASH manifest**;
 * - **an HLS playlist whose media answers too.** A playlist is text anybody
 *   can serve, and the place these streams break is the segment host (a
 *   `Referer` it checks, a token the playlist forgot), so a master playlist is
 *   followed to its first variant and a media playlist to its first segment,
 *   which has to carry media bytes in turn. Segments disguised behind an image
 *   header are counted — a player's demuxer finds the sync bytes after it — but
 *   only when the sync bytes are actually there.
 *
 * Three requests at most per stream, each ranged, so a working source costs a
 * few kilobytes of somebody's bandwidth and no more.
 */

import type { ReachOutcome } from '@plugin-bridge/core/verify';
import type { HostFetch } from './host';
import { hostMatches } from './host-match';
import { FrameReader } from './net/frames';
import { FRAME_CONTENT_TYPE } from './net/relay';

/** What a desktop browser's media element sends, before any header a source set. */
const BROWSER_MEDIA_REQUEST: Readonly<Record<string, string>> = {
	accept: '*/*',
	'accept-language': 'en-US,en;q=0.9',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
		'Chrome/131.0.0.0 Safari/537.36'
};

/** The slice asked for. Enough for any signature and for a playlist's head. */
const PROBE_RANGE = 'bytes=0-65535';

export type StreamProbe = (
	url: string,
	headers: Readonly<Record<string, string>>,
	reachableHosts: readonly string[]
) => Promise<ReachOutcome>;

interface Answer {
	readonly status: number;
	readonly type: string;
	readonly url: string;
	readonly body: Uint8Array;
	readonly challenge: string | null;
}

/** A stream probe over a host's relay. */
export function streamMediaProbe(fetcher: HostFetch): StreamProbe {
	const get = async (
		url: string,
		headers: Readonly<Record<string, string>>
	): Promise<Answer | string> => {
		const sent: Record<string, string> = { ...BROWSER_MEDIA_REQUEST };
		for (const [name, value] of Object.entries(headers)) sent[name.toLowerCase()] = value;
		sent['range'] = PROBE_RANGE;
		let response: Response;
		try {
			response = await fetcher('/api/plugin-fetch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url, method: 'GET', headers: sent, reply: 'frame' })
			});
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		if (!response.ok) {
			const said = await response
				.json()
				.then((failed: { error?: string }) => failed.error)
				.catch(() => undefined);
			return said ?? `the relay answered ${response.status}`;
		}
		let answer: {
			status?: unknown;
			url?: unknown;
			headers?: Record<string, unknown>;
			body?: unknown;
			challenge?: unknown;
		};
		try {
			if (response.headers.get('content-type') !== FRAME_CONTENT_TYPE) {
				return 'the relay did not answer in frames';
			}
			const messages = new FrameReader().push(new Uint8Array(await response.arrayBuffer()));
			if (messages.length !== 1) return 'the relay sent a malformed reply';
			answer = messages[0] as typeof answer;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		return {
			status: typeof answer.status === 'number' ? answer.status : 0,
			type: String(answer.headers?.['content-type'] ?? '')
				.split(';')[0]
				.trim()
				.toLowerCase(),
			url: typeof answer.url === 'string' ? answer.url : url,
			body: answer.body instanceof Uint8Array ? answer.body : new Uint8Array(0),
			challenge: typeof answer.challenge === 'string' ? answer.challenge : null
		};
	};

	/** Fails with a fragment naming what came back instead of media. */
	const refusal = (answer: Answer, what: string): ReachOutcome => {
		const typed = answer.type.length > 0 ? ` (${answer.type})` : '';
		if (answer.status < 200 || answer.status > 299) {
			const behind = answer.challenge === null ? '' : ` from behind a ${answer.challenge} check`;
			return { ok: false, detail: `${what} answered ${answer.status}${typed}${behind}` };
		}
		if (answer.body.length === 0) {
			return { ok: false, detail: `${what} answered ${answer.status}${typed} with no bytes` };
		}
		const head = textHead(answer.body);
		const said = /^\s*</.test(head)
			? 'an HTML page'
			: /^\s*[{[]/.test(head)
				? 'a JSON document'
				: 'bytes that are not media';
		return { ok: false, detail: `${what} answered ${answer.status}${typed} with ${said}` };
	};

	return async (url, headers, reachableHosts) => {
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			return { ok: false, detail: 'not a url' };
		}
		if (target.protocol !== 'https:') {
			return { ok: false, detail: `${target.protocol.replace(':', '')}, not https` };
		}
		// The stream's own address has to be one the plugin may reach. What it
		// names from there — a variant, a segment on a CDN — is reached the way
		// playback reaches it, on the manifest's word.
		if (!reachableHosts.some((pattern) => hostMatches(target.hostname, pattern))) {
			return { ok: false, detail: 'host not in the converted allowlist' };
		}

		let answer = await get(url, headers);
		if (typeof answer === 'string') return { ok: false, detail: answer };
		if (answer.status < 200 || answer.status > 299) return refusal(answer, 'the stream');

		if (mediaKind(answer.body) !== null || isDashManifest(answer.body)) return { ok: true };
		if (!isHlsPlaylist(answer.body)) return refusal(answer, 'the stream');

		// A master playlist names variants; a media playlist names segments. Two
		// hops at most: master, then variant, then one segment.
		for (let hop = 0; hop < 2; hop += 1) {
			const playlist = new TextDecoder().decode(answer.body);
			const next = firstReference(playlist);
			if (next === null) return { ok: false, detail: 'an HLS playlist that names no media' };
			let address: string;
			try {
				address = new URL(next.uri, answer.url).toString();
			} catch {
				return { ok: false, detail: 'an HLS playlist naming an address that is not a url' };
			}
			const following = await get(address, headers);
			if (typeof following === 'string') return { ok: false, detail: following };
			const what = next.kind === 'variant' ? 'its variant playlist' : 'its first segment';
			if (following.status < 200 || following.status > 299) return refusal(following, what);
			if (next.kind === 'segment') {
				if (mediaKind(following.body) !== null || disguisedTransportStream(following.body)) {
					return { ok: true };
				}
				// An encrypted segment is noise by design; the key line says so,
				// and nothing short of decrypting it could say more.
				if (/#EXT-X-KEY:METHOD=(AES-128|SAMPLE-AES)/.test(playlist) && following.body.length > 0) {
					return { ok: true };
				}
				return refusal(following, what);
			}
			if (!isHlsPlaylist(following.body)) return refusal(following, what);
			answer = following;
		}
		return { ok: false, detail: 'an HLS playlist that nests deeper than a master and a variant' };
	};
}

function textHead(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes.subarray(0, 512)).replace(/^﻿/, '');
}

function isHlsPlaylist(bytes: Uint8Array): boolean {
	return textHead(bytes).trimStart().startsWith('#EXTM3U');
}

function isDashManifest(bytes: Uint8Array): boolean {
	const head = textHead(bytes).trimStart();
	return head.startsWith('<MPD') || (head.startsWith('<?xml') && head.includes('<MPD'));
}

/**
 * The first thing a playlist points at: the first variant of a master, or the
 * first segment of a media playlist. An `EXT-X-MAP` initialisation segment
 * counts as a segment, since it is media the player fetches first.
 */
export function firstReference(
	playlist: string
): { readonly kind: 'variant' | 'segment'; readonly uri: string } | null {
	const lines = playlist.split(/\r?\n/).map((line) => line.trim());
	const map = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
	const mapUri = map === undefined ? null : /URI="([^"]+)"/.exec(map)?.[1];
	if (mapUri !== undefined && mapUri !== null) return { kind: 'segment', uri: mapUri };
	const master = lines.some((line) => line.startsWith('#EXT-X-STREAM-INF'));
	for (let at = 0; at < lines.length; at += 1) {
		const line = lines[at];
		if (line.length === 0 || line.startsWith('#')) continue;
		return { kind: master ? 'variant' : 'segment', uri: line };
	}
	return null;
}

/** The container a body's first bytes declare, or null when they declare none. */
export function mediaKind(bytes: Uint8Array): string | null {
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (bytes.length >= 8 && /^(ftyp|moov|moof|styp|sidx|free|mdat|skip)$/.test(ascii(4, 8))) {
		return 'mp4';
	}
	if (
		bytes.length >= 4 &&
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	) {
		return 'matroska';
	}
	if (bytes.length >= 189 && bytes[0] === 0x47 && bytes[188] === 0x47) return 'mpegts';
	if (bytes.length >= 3 && ascii(0, 3) === 'FLV') return 'flv';
	if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return 'id3';
	if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return 'adts';
	return null;
}

/**
 * An MPEG-TS segment behind some other file's header — two sync bytes a
 * packet apart, somewhere in the first kilobytes. Players' demuxers search for
 * exactly this, which is why the disguise works on them and not on a status.
 */
export function disguisedTransportStream(bytes: Uint8Array): boolean {
	const limit = Math.min(bytes.length - 188 * 2, 16384);
	for (let at = 0; at < limit; at += 1) {
		if (bytes[at] === 0x47 && bytes[at + 188] === 0x47 && bytes[at + 376] === 0x47) return true;
	}
	return false;
}
