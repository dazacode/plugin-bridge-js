/**
 * Whether a page image a source returned is an image a reader can show.
 *
 * The check's last step for a book source (`core/verify.ts`). A source signals
 * failure by returning a url exactly as a video module does, and the commonest
 * failure in this medium is a CDN that answers a page request without the
 * right `Referer` with a 403 and an HTML body (`ABI.md` §8.3). A probe that
 * asked for the status of a HEAD, or sent headers the reader would not, said
 * "reads here" about a source whose reader showed "Page 1 did not load".
 *
 * So the first page is fetched the way a viewer's browser would fetch it:
 *
 * - **a GET for the bytes**, through the host's own relay (`/api/plugin-fetch`,
 *   the route every plugin request already takes), because a browser does not
 *   ask an image server for a status;
 * - **with a browser's image request** — its `Accept`, a desktop
 *   `User-Agent`, `Sec-Fetch-Dest: image` — since a CDN that checks one of
 *   those checks it against what a browser sends;
 * - **with exactly the headers the host would add**, which the caller works
 *   out with `grantedImageHeaders` and passes in — no more, so a header the
 *   reader drops is not one the check quietly sends;
 *
 * and it counts only if **image bytes** come back. A 403 is not a page; nor is
 * a 200 carrying an HTML document, which is what a hotlink-protected CDN and a
 * soft error both look like, and what Chrome refuses outright as an image
 * (`ERR_BLOCKED_BY_ORB`).
 */

import type { ReachOutcome } from '@plugin-bridge/core/verify';
import type { HostFetch } from './host';
import { FrameReader } from './net/frames';
import { FRAME_CONTENT_TYPE } from './net/relay';

/** What a desktop browser sends for an `<img>`, before any header a source set. */
const BROWSER_IMAGE_REQUEST: Readonly<Record<string, string>> = {
	accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
	'accept-language': 'en-US,en;q=0.9',
	'user-agent':
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
		'Chrome/131.0.0.0 Safari/537.36',
	'sec-fetch-dest': 'image',
	'sec-fetch-mode': 'no-cors',
	'sec-fetch-site': 'cross-site'
};

export type PageProbe = (
	url: string,
	headers: Readonly<Record<string, string>>
) => Promise<ReachOutcome>;

/** A page probe over a host's relay. */
export function pageImageProbe(fetcher: HostFetch): PageProbe {
	return async (url, headers) => {
		const sent: Record<string, string> = { ...BROWSER_IMAGE_REQUEST };
		for (const [name, value] of Object.entries(headers)) sent[name.toLowerCase()] = value;

		let response: Response;
		try {
			response = await fetcher('/api/plugin-fetch', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ url, method: 'GET', headers: sent, reply: 'frame' })
			});
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
		if (!response.ok) {
			const said = await response
				.json()
				.then((failed: { error?: string }) => failed.error)
				.catch(() => undefined);
			return { ok: false, detail: said ?? `the relay answered ${response.status}` };
		}

		let answer: {
			status?: unknown;
			headers?: Record<string, unknown>;
			body?: unknown;
			unread?: unknown;
		};
		try {
			answer = await readAnswer(response);
		} catch (error) {
			return { ok: false, detail: error instanceof Error ? error.message : String(error) };
		}
		const status = typeof answer.status === 'number' ? answer.status : 0;
		const type = String(answer.headers?.['content-type'] ?? '')
			.split(';')[0]
			.trim()
			.toLowerCase();
		const typed = type.length > 0 ? ` (${type})` : '';
		if (status < 200 || status > 299)
			return { ok: false, detail: `answered ${status}${typed}, not an image` };

		const body = answer.body instanceof Uint8Array ? answer.body : new Uint8Array(0);
		// Over the relay's cap, so unread: the status and type are all there is,
		// and an image that large is still an image.
		if (answer.unread !== undefined && type.startsWith('image/')) return { ok: true };
		if (body.length === 0) return { ok: false, detail: `answered ${status}${typed} with no bytes` };
		if (imageKind(body) !== null) return { ok: true };
		if (looksLikeDocument(body)) {
			return { ok: false, detail: `answered ${status}${typed} with an HTML page, not an image` };
		}
		return { ok: false, detail: `answered ${status}${typed} with bytes that are not an image` };
	};
}

async function readAnswer(response: Response): Promise<{
	status?: unknown;
	headers?: Record<string, unknown>;
	body?: unknown;
	unread?: unknown;
}> {
	if (response.headers.get('content-type') === FRAME_CONTENT_TYPE) {
		const messages = new FrameReader().push(new Uint8Array(await response.arrayBuffer()));
		if (messages.length !== 1) throw new Error('the relay sent a malformed reply');
		return messages[0] as { status?: unknown; body?: unknown };
	}
	// A relay from before frames answers JSON with the body as text; an image
	// survives that only as far as its signature, which is all this reads.
	const answered = (await response.json()) as { body?: unknown };
	if (typeof answered.body === 'string') {
		answered.body = Uint8Array.from(answered.body, (char) => char.charCodeAt(0) & 0xff);
	}
	return answered;
}

/** The format a body's first bytes declare, or null when they declare none a reader shows. */
export function imageKind(bytes: Uint8Array): string | null {
	const at = (i: number) => bytes[i];
	const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
	if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'jpeg';
	if (bytes.length >= 8 && ascii(1, 4) === 'PNG' && at(0) === 0x89) return 'png';
	if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') return 'gif';
	if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
	if (
		bytes.length >= 12 &&
		ascii(4, 8) === 'ftyp' &&
		/^(avif|avis|heic|heix|mif1|msf1)$/.test(ascii(8, 12))
	) {
		return 'avif/heif';
	}
	if (bytes.length >= 2 && at(0) === 0xff && at(1) === 0x0a) return 'jxl';
	if (bytes.length >= 12 && ascii(4, 12) === 'JXL \r\n\x87\n') return 'jxl';
	if (bytes.length >= 2 && ascii(0, 2) === 'BM') return 'bmp';
	if (bytes.length >= 4 && (ascii(0, 4) === 'II*\0' || ascii(0, 4) === 'MM\0*')) return 'tiff';
	if (bytes.length >= 4 && at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0) return 'ico';
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
	if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
	return null;
}

function looksLikeDocument(bytes: Uint8Array): boolean {
	const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase();
	return (
		head.startsWith('<!doctype') ||
		head.startsWith('<html') ||
		head.includes('<head') ||
		head.includes('<body')
	);
}
