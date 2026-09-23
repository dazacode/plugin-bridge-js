/**
 * The guards, run rather than read.
 *
 * These are emitted as *source* into a bundle, so nothing typechecks them and
 * nothing imports them — the only way to find out what they do is to evaluate
 * them the way a bundle would. That is worth doing for the reason in
 * `stream-guards.ts`: this is the layer that decides whether a module which
 * has given up gets to look like one that succeeded.
 *
 * `__absolute` is lifted out of the shared runtime rather than restated here,
 * because the bug these tests exist for was precisely a disagreement about
 * what `__absolute` does to a value that is not a url.
 */

import { describe, expect, it } from 'vitest';

import { JS_RUNTIME } from './js-runtime';
import { STREAM_GUARDS } from './stream-guards';

/**
 * One function's source, by name, from a runtime that declares at column zero
 * and closes at column zero. The same shape assumption `bundle-composition`
 * relies on, and strong enough for the same reason.
 */
function declarationOf(source: string, name: string): string {
	const start = source.indexOf(`function ${name}(`);
	if (start === -1) throw new Error(`no declaration of ${name}`);
	const end = source.indexOf('\n}', start);
	if (end === -1) throw new Error(`${name} does not close at column zero`);
	return source.slice(start, end + 2);
}

const guards = new Function(
	`${declarationOf(JS_RUNTIME, '__absolute')}
${STREAM_GUARDS}
return { __isPlayable: __isPlayable, __namesASidecar: __namesASidecar, __subtitleTrack: __subtitleTrack };`
)() as {
	__isPlayable: (url: unknown) => boolean;
	__namesASidecar: (raw: unknown) => boolean;
	__subtitleTrack: (
		url: unknown,
		label: string,
		language: string,
		base: string
	) => { url: string; format: string; isDefault: boolean; languageCode: string } | null;
};

const BASE = 'https://source.test/';

describe('a value that is not a url, before anything makes it one', () => {
	/**
	 * What these ecosystems return for "there are no captions here". Not a
	 * list the guard consults — the guard is shape-based — but the evidence
	 * the shape was chosen against, kept where a later change can see it.
	 */
	const SENTINELS = ['none', 'null', 'undefined', 'false', 'N/A', 'NONE', '  none  ', ''];

	it.each(SENTINELS)('refuses %j rather than resolving it into one', (sentinel) => {
		// The whole bug in one line: `__absolute` turns every one of these into
		// a url that no later check can tell from a real relative path, because
		// by then it is one. Asked first, they are obviously not urls.
		expect(guards.__namesASidecar(sentinel)).toBe(false);
		expect(guards.__subtitleTrack(sentinel, 'Subtitles', 'und', BASE)).toBeNull();
	});

	it('shows what resolving one first would have produced', () => {
		// Pinned so the next person does not have to take the argument above on
		// faith: this is the url the old code attached, as a default track.
		const resolved = new URL('none', BASE).toString();
		expect(resolved).toBe('https://source.test/none');
		expect(guards.__isPlayable(resolved)).toBe(true);
	});

	it('refuses a value that is not a string at all', () => {
		for (const value of [null, undefined, 0, false, {}, []]) {
			expect(guards.__namesASidecar(value)).toBe(false);
			expect(guards.__subtitleTrack(value, '', '', BASE)).toBeNull();
		}
	});
});

describe('a value that does name a caption file', () => {
	it('resolves a relative sidecar against the module’s own base', () => {
		const track = guards.__subtitleTrack('subs/en.vtt', 'English', 'en', BASE);
		expect(track).not.toBeNull();
		expect(track?.url).toBe('https://source.test/subs/en.vtt');
		expect(track?.format).toBe('vtt');
		expect(track?.languageCode).toBe('en');
	});

	it('reads the format from the url, which is the only statement of it', () => {
		expect(guards.__subtitleTrack('/c/1.srt', '', '', BASE)?.format).toBe('srt');
		expect(guards.__subtitleTrack('/c/1.ass', '', '', BASE)?.format).toBe('ass');
		expect(guards.__subtitleTrack('/c/1.vtt?v=2', '', '', BASE)?.format).toBe('vtt');
		// No extension it recognises is still a track; vtt is the default the
		// player can most often make sense of.
		expect(guards.__subtitleTrack('https://cdn.test/s?id=3', '', '', BASE)?.format).toBe('vtt');
	});

	it('keeps an absolute url, and a data uri, exactly as the module wrote it', () => {
		// A scheme is a location stated on purpose. Some modules inline a whole
		// vtt rather than host one, and refusing that would drop real captions.
		expect(guards.__subtitleTrack('https://cdn.test/a/b.vtt', '', '', BASE)?.url).toBe(
			'https://cdn.test/a/b.vtt'
		);
		const inlined = 'data:text/vtt,WEBVTT';
		expect(guards.__namesASidecar(inlined)).toBe(true);
		expect(guards.__subtitleTrack(inlined, '', '', BASE)?.url).toBe(inlined);
	});

	it('labels an unknown language honestly instead of guessing one', () => {
		expect(guards.__subtitleTrack('/c/1.vtt', '', '', BASE)?.languageCode).toBe('und');
	});

	it('never marks a track default; that is the adapter’s call', () => {
		// Sora sets it, because a Sora module returns at most one sidecar and
		// there is nothing to choose between. Nothing else should inherit that.
		expect(guards.__subtitleTrack('/c/1.vtt', '', '', BASE)?.isDefault).toBe(false);
	});
});

describe('the stream guard this one is modelled on', () => {
	it('still refuses a bare origin and accepts a path', () => {
		expect(guards.__isPlayable('https://source.test')).toBe(false);
		expect(guards.__isPlayable('https://source.test/')).toBe(false);
		expect(guards.__isPlayable('https://source.test/v/1.mp4')).toBe(true);
		expect(guards.__isPlayable('ftp://source.test/v/1.mp4')).toBe(false);
		expect(guards.__isPlayable('')).toBe(false);
	});
});

const shared = new Function(
	`${declarationOf(JS_RUNTIME, '__absolute')}
${STREAM_GUARDS}
return { __streamContainer: __streamContainer, __torrentOf: __torrentOf };`
)() as {
	__streamContainer: (
		evidence: { declared?: unknown; filename?: unknown; url?: unknown; webReady?: boolean },
		fallback: string
	) => string;
	__torrentOf: (row: unknown) => { infoHash: string; trackers: string[] } | null;
};

describe('the container, from the strongest statement about it', () => {
	const container = shared.__streamContainer;

	it('believes a declared type, whatever its case', () => {
		expect(container({ declared: 'HLS', url: 'https://cdn.test/a.mp4' }, 'mp4')).toBe('hls');
		expect(container({ declared: 'mp4' }, 'hls')).toBe('mp4');
		expect(container({ declared: 'DASH' }, 'mp4')).toBe('dash');
		expect(container({ declared: 'application/x-mpegURL' }, 'mp4')).toBe('hls');
	});

	it('reads a declared MKV as a single file, not as HLS', () => {
		// The mapping this replaced sent every value but exactly "mp4" to HLS,
		// so a Matroska module was opened as a manifest and failed to play.
		expect(container({ declared: 'MKV' }, 'hls')).toBe('mp4');
		expect(container({ declared: 'webm' }, 'hls')).toBe('mp4');
	});

	it('reads a stated file name ahead of an opaque url', () => {
		// A debrid link is a token; the file name beside it is the statement.
		expect(
			container({ filename: 'Title.S01E01.mkv', url: 'https://cdn.test/dl/9f8e7d' }, 'hls')
		).toBe('mp4');
		expect(container({ filename: 'master.m3u8', url: 'https://cdn.test/t/1' }, 'mp4')).toBe('hls');
	});

	it("reads the url's own extension, ignoring its query", () => {
		expect(container({ url: 'https://cdn.test/a/index.m3u8?token=1' }, 'mp4')).toBe('hls');
		expect(container({ url: 'https://cdn.test/a/manifest.mpd#t=3' }, 'mp4')).toBe('dash');
		expect(container({ url: 'https://cdn.test/a/file.MKV' }, 'hls')).toBe('mp4');
		// `?type=.m3u8` names nothing about a file; only a value that is a path does.
		expect(container({ url: 'https://cdn.test/a?type=m3u8' }, 'mp4')).toBe('mp4');
	});

	it('reads a proxied address carried in the query when the path says nothing', () => {
		const proxied =
			'https://proxy.test/stream?d=' +
			encodeURIComponent('https://origin.test/hls/master.m3u8?x=1');
		expect(container({ url: proxied }, 'mp4')).toBe('hls');
	});

	it('takes web-ready as a statement of mp4, and falls back only when nothing spoke', () => {
		expect(container({ url: 'https://cdn.test/opaque', webReady: true }, 'hls')).toBe('mp4');
		expect(container({ url: 'https://cdn.test/opaque', webReady: false }, 'mp4')).toBe('mp4');
		expect(container({ url: 'https://cdn.test/opaque' }, 'hls')).toBe('hls');
	});
});

describe('a torrent, from whichever spelling a row carries it in', () => {
	const HEX = '0123456789abcdef0123456789abcdef01234567';
	const BASE32 = 'AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH';
	const torrent = shared.__torrentOf;

	it('reads a declared hash in hex of either case, or base32', () => {
		expect(torrent({ hash: HEX.toUpperCase() })?.infoHash).toBe(HEX);
		expect(torrent({ infoHash: BASE32 })?.infoHash).toBe(HEX);
	});

	it("reads a magnet's hash and its trackers", () => {
		const magnet = `magnet:?xt=urn:btih:${BASE32}&dn=x&tr=${encodeURIComponent('udp://t.test:1')}&tr=http%3A%2F%2Fu.test%2Fa`;
		expect(torrent({ magnet })).toEqual({
			infoHash: HEX,
			trackers: ['udp://t.test:1', 'http://u.test/a']
		});
		// The same magnet under the field names the other ecosystems use.
		expect(torrent({ link: magnet })?.infoHash).toBe(HEX);
		expect(torrent({ url: magnet })?.infoHash).toBe(HEX);
	});

	it('reads a link that is itself a bare hash', () => {
		expect(torrent({ link: HEX })?.infoHash).toBe(HEX);
	});

	it('answers nothing for a value that is not an info hash', () => {
		expect(torrent({ infoHash: 'abc' })).toBeNull();
		expect(torrent({ link: 'https://example.invalid/a.torrent' })).toBeNull();
		expect(torrent({ magnet: 'magnet:?xt=urn:btih:tooshort' })).toBeNull();
		expect(torrent(null)).toBeNull();
	});
});
