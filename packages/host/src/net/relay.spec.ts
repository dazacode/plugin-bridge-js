/**
 * The proxy's size caps, the one request they must not apply to, and the
 * question a failed request has to answer.
 *
 * A resolved stream is a video, so every cap here is a cap a *working* stream
 * exceeds. That is fine for the reads a plugin makes — a catalogue page is not
 * a video — but the reach probe asks a different question: is anything there.
 * A HEAD answers it without a body, and capping one on the size of the body it
 * describes refused to answer for exactly the streams that worked.
 *
 * The second half of the file is about what this route says when a request does
 * not come back. `fetch` reports nearly everything as `TypeError: fetch failed`
 * and hides the real cause one or two `cause` links down, so a 502 that repeats
 * the wrapper tells the probe only what it already knew. The tests below pin
 * that the specific reason survives to the caller, and that the one failure
 * worth retrying — a chain missing its intermediate — is the only one this
 * route spends a chase on. *Which* failures those are is the repair's own
 * question, and is pinned where the repair lives.
 *
 * The chain repair is a stub, and is one here rather than mocked: the relay
 * takes it as an argument (`chain-repair.ts`), so a spec supplies one the way
 * a host does. The real implementation opens a TLS socket to discover what a
 * host under-sent — a spec that let it run would be doing DNS and a handshake
 * against a name that does not resolve — and it is Node-only, which is why it
 * lives in `@plugin-bridge/host-node` and is tested there. What is pinned here
 * is the relay's own half: that it asks before it spends anything, and that it
 * spends nothing when the answer is no.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { relay } from './relay';
import { isPrivateAddress } from './addresses';
import type { ChainRepair } from './chain-repair';

const issuersFor = vi.fn(async (): Promise<string[]> => []);

/**
 * A host's chain repair, reduced to what these tests need.
 *
 * `chainIsIncomplete` reads one `cause` level, which is all the errors below
 * carry; the real predicate walks the chain and is pinned against every shape
 * of it in `packages/host-node/src/net/aia.spec.ts`. Keeping a stub here is
 * the point of the seam — the relay's behaviour must not depend on which host
 * is answering.
 */
const repair: ChainRepair = {
	chainIsIncomplete: (error) =>
		(error as { cause?: { code?: unknown } } | null)?.cause?.code ===
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	issuersFor,
	fetchTrusting: () => Promise.reject(new Error('no retry is expected in these tests'))
};

const BIG = String(8 * 1024 * 1024);

/** Calls the handler with a fetch double standing in for the wider internet. */
async function call(body: unknown, served: (request: Request) => Response) {
	const response = await relay(
		new Request('https://local.invalid/api/plugin-fetch', {
			method: 'POST',
			body: JSON.stringify(body)
		}),
		(async (input: RequestInfo | URL, init?: RequestInit) =>
			served(new Request(String(input), init as RequestInit))) as typeof fetch,
		repair
	);

	return {
		status: response.status,
		payload: (await response.json()) as Record<string, unknown>
	};
}

/** The shape Node's `fetch` really hands back: a wrapper around the cause. */
function fetchFailed(cause: unknown): TypeError {
	return Object.assign(new TypeError('fetch failed'), { cause });
}

/** A TLS error as `node:tls` raises it, before `fetch` buries it. */
function tlsError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

describe('probing a stream', () => {
	it('answers a HEAD whose content-length is far over the body cap', async () => {
		// The bug this pins: every module that resolved a real mp4 was reported
		// as having returned a placeholder, because the probe was refused for
		// being too large — on a response that carried no body at all.
		const { status, payload } = await call(
			{ url: 'https://cdn.example.invalid/a.mp4', method: 'HEAD' },
			() => new Response(null, { status: 200, headers: { 'content-length': BIG } })
		);

		expect(status).toBe(200);
		expect(payload).toMatchObject({ status: 200, body: '' });
	});

	it('still will not read a GET of the same thing, and says so in the answer', async () => {
		// The cap is not gone and nothing is buffered: eight megabytes is still
		// something this relay does not read. What changed is who is told.
		//
		// A plugin writing `execute().request.url` is asking where a redirect
		// lands, which is how this ecosystem resolves a video link — so the
		// chain ends on the video and the cap is reached every time. Answering
		// 502 threw away the redirect it had already paid for over a body it
		// never wanted. The status, the final url and the headers are known by
		// then and cost nothing, so they are answered and the body is marked
		// unread; reading it throws by name (`__responseOf`) rather than
		// answering an empty page.
		const { status, payload } = await call(
			{ url: 'https://cdn.example.invalid/a.mp4', method: 'GET' },
			() => new Response('x', { status: 200, headers: { 'content-length': BIG } })
		);

		expect(status).toBe(200);
		expect(payload).toMatchObject({
			url: 'https://cdn.example.invalid/a.mp4',
			body: '',
			unread: 'too large'
		});
	});

	it('forwards the Range a ranged probe asks for', async () => {
		// The fallback for hosts that will not answer a HEAD. It is only worth
		// making if the header survives the allowlist.
		let seen: string | null = null;
		const { status } = await call(
			{
				url: 'https://cdn.example.invalid/a.mp4',
				method: 'GET',
				headers: { range: 'bytes=0-1023' }
			},
			(request) => {
				seen = request.headers.get('range');
				return new Response('partial', { status: 206 });
			}
		);

		expect(status).toBe(200);
		expect(seen).toBe('bytes=0-1023');
	});

	it('truncates a ranged read the host answered with the whole file', async () => {
		// The same bug as the HEAD one, one fallback further down. The ranged GET
		// exists for hosts that will not answer a HEAD — and plenty of those also
		// ignore `Range` and reply 200 with the entire video. Refusing that for
		// being too large reported a working stream as unreachable, which is
		// precisely what the HEAD probe was introduced to stop.
		const whole = 'x'.repeat(64 * 1024);
		const { status, payload } = await call(
			{
				url: 'https://cdn.example.invalid/a.mp4',
				method: 'GET',
				headers: { range: 'bytes=0-1023' }
			},
			() =>
				new Response(whole, {
					status: 200,
					headers: { 'content-length': BIG }
				})
		);

		expect(status).toBe(200);
		expect(payload).toMatchObject({ status: 200 });
	});
});

describe('a redirect the caller wants to read rather than take', () => {
	// Whole families of sources answer "which server has this episode" with a
	// 302 whose Location is the embed. The extension reads that header; if the
	// hop is followed for it, the header is gone and it reports a source that
	// changed.
	const redirect = () =>
		new Response(null, {
			status: 302,
			headers: { location: 'https://embed.example.invalid/e/1' }
		});

	it('answers with the 302 and its Location when asked not to follow', async () => {
		let hops = 0;
		const { status, payload } = await call(
			{ url: 'https://watch.example.invalid/go/1', follow: false },
			() => {
				hops += 1;
				return redirect();
			}
		);

		expect(status).toBe(200);
		expect(hops).toBe(1);
		expect(payload).toMatchObject({
			status: 302,
			url: 'https://watch.example.invalid/go/1',
			headers: { location: 'https://embed.example.invalid/e/1' }
		});
	});

	it('still follows, and still re-checks each hop, by default', async () => {
		// The default is unchanged, and `follow: false` relaxes nothing about
		// the walk — it only declines to take it. A hop into private space is
		// refused whether or not the first request asked to follow.
		const seen: string[] = [];
		const { payload } = await call({ url: 'https://watch.example.invalid/go/1' }, (request) => {
			seen.push(request.url);
			return seen.length === 1 ? redirect() : new Response('page', { status: 200 });
		});

		expect(seen).toEqual([
			'https://watch.example.invalid/go/1',
			'https://embed.example.invalid/e/1'
		]);
		expect(payload).toMatchObject({
			status: 200,
			url: 'https://embed.example.invalid/e/1'
		});

		const refused = await call(
			{ url: 'https://watch.example.invalid/go/2' },
			() =>
				new Response(null, {
					status: 302,
					headers: { location: 'https://127.0.0.1/admin' }
				})
		);
		expect(refused.status).toBe(403);
	});
});

describe('the floor an AIA url is held to', () => {
	// The URL chased for a missing intermediate comes out of a certificate an
	// untrusted host wrote, so it gets the same refusal the proxy gives a
	// caller-supplied URL. Without that, a leaf could name an address on the
	// deployment's own network and turn the fix into the SSRF gadget the rest
	// of the route is careful not to be.
	it('refuses loopback, private, link-local and carrier-grade space', () => {
		expect(isPrivateAddress('localhost')).toBe(true);
		expect(isPrivateAddress('127.0.0.1')).toBe(true);
		expect(isPrivateAddress('10.0.0.1')).toBe(true);
		expect(isPrivateAddress('192.168.1.1')).toBe(true);
		expect(isPrivateAddress('172.16.0.1')).toBe(true);
		// The cloud metadata endpoint: the single address an SSRF is usually
		// aimed at, because reaching it hands over the deployment's own
		// credentials.
		expect(isPrivateAddress('169.254.169.254')).toBe(true);
		expect(isPrivateAddress('100.64.0.1')).toBe(true);
		expect(isPrivateAddress('::1')).toBe(true);
		expect(isPrivateAddress('fd00::1')).toBe(true);
	});

	it('lets ordinary public addresses through', () => {
		// The guard has to stay a guard rather than become a blanket refusal.
		// `172.32` is just outside the private block and `8.8.8.8` is as public
		// as an address gets; a check that caught either would be refusing to
		// complete chains for hosts that are perfectly reachable.
		expect(isPrivateAddress('cdn.example.invalid')).toBe(false);
		expect(isPrivateAddress('172.32.0.1')).toBe(false);
		expect(isPrivateAddress('8.8.8.8')).toBe(false);
	});

	it('does not read a hostname beginning fc or fd as a unique-local address', () => {
		// A real bug, and one that belongs to this triage rather than to the
		// AIA work: the check was `startsWith('fc')`, so every host whose name
		// happens to start with those two letters was refused before a request
		// was made — and that is a shape content hosts genuinely use. The
		// viewer saw a broken source; the cause was our own over-matching.
		expect(isPrivateAddress('fc2.example.invalid')).toBe(false);
		expect(isPrivateAddress('fdn.example.invalid')).toBe(false);
		// The addresses themselves still are: the colon is what tells them
		// apart, and a hostname cannot contain one by the time it reaches here.
		expect(isPrivateAddress('fc00::1')).toBe(true);
		expect(isPrivateAddress('fdaa:bb::1')).toBe(true);
	});
});

describe('saying why a source did not answer', () => {
	beforeEach(() => {
		issuersFor.mockClear();
	});

	it('reports the TLS code rather than the fetch wrapper', async () => {
		// The regression this pins: the 502 read `could not reach …: TypeError:
		// fetch failed`, which is the one thing the reach probe already knew.
		// The host that under-sends its intermediate is a supportable source
		// with a nameable problem, and the report has to name it.
		const { status, payload } = await call({ url: 'https://cdn.example.invalid/a.mp4' }, () => {
			throw fetchFailed(
				tlsError('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
			);
		});

		expect(status).toBe(502);
		expect(payload.error).toContain('cdn.example.invalid');
		expect(payload.error).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
		expect(payload.error).not.toContain('fetch failed');
		// And the retry was attempted: this failure is the retryable one, so
		// the route asked what the host omitted before giving up. The stub
		// answers with nothing, which is how a host that names no AIA url
		// behaves, and the 502 above is what that has to produce.
		expect(issuersFor).toHaveBeenCalledWith(
			expect.objectContaining({ hostname: 'cdn.example.invalid' })
		);
	});

	it('falls back to the innermost message when nothing carries a code', async () => {
		// Plenty of failures arrive as messages alone. Reporting the outermost
		// one would again report `fetch failed`; the specific sentence is the
		// one furthest down.
		const { status, payload } = await call({ url: 'https://cdn.example.invalid/a.mp4' }, () => {
			throw fetchFailed(new Error('the socket closed before a reply arrived'));
		});

		expect(status).toBe(502);
		expect(payload.error).toContain('cdn.example.invalid');
		expect(payload.error).toContain('the socket closed before a reply arrived');
		// Not retryable, so no handshake was spent asking a host that had
		// already given a conclusive answer.
		expect(issuersFor).not.toHaveBeenCalled();
	});
});

describe('telling a bot check apart from a refusal', () => {
	it('names a challenge that announced itself in a header', async () => {
		const { payload } = await call(
			{ url: 'https://source.example.invalid/catalogue' },
			() =>
				new Response('<html>…</html>', {
					status: 403,
					headers: { server: 'cloudflare', 'cf-ray': '0000000000000000-XXX' }
				})
		);

		// Relayed as it arrived — the plugin still gets its 403 and its body.
		expect(payload.status).toBe(403);
		expect(payload.body).toContain('<html>');
		expect(payload.challenge).toBe('cloudflare');
	});

	it('reads the interstitial when the headers were stripped', async () => {
		const { payload } = await call(
			{ url: 'https://source.example.invalid/catalogue' },
			() =>
				new Response('<html><head><title>Just a moment...</title></head></html>', {
					status: 503
				})
		);
		expect(payload.challenge).toBe('cloudflare');
	});

	it('does not call an ordinary refusal a challenge', async () => {
		// The false positive that would matter: a source that has genuinely
		// decided we may not read it, mislabelled as solvable.
		const { payload } = await call(
			{ url: 'https://source.example.invalid/catalogue' },
			() => new Response('nope', { status: 403, headers: { server: 'nginx' } })
		);
		expect(payload.challenge).toBeUndefined();
	});

	it('says nothing about a page that merely mentions the phrase', async () => {
		const { payload } = await call(
			{ url: 'https://source.example.invalid/catalogue' },
			() =>
				new Response('<p>Just a moment, loading episodes…</p>', {
					status: 200
				})
		);
		expect(payload.challenge).toBeUndefined();
	});
});

/**
 * The relay holds no cookies. It puts one header on the first hop and reports
 * what came back; every question about scope belongs to `cookie-jar.ts`, one
 * layer up. These pin the three parts that are this route's own business.
 */
describe('carrying a jar’s header, and reporting what a chain set', () => {
	it('sends what the caller’s jar produced, on the first hop', async () => {
		let carried: string | null = null;
		await call(
			{ url: 'https://a.example.invalid/', cookies: { send: 'session=abc' } },
			(request) => {
				carried = request.headers.get('cookie');
				return new Response('ok');
			}
		);

		expect(carried).toBe('session=abc');
	});

	it('refuses a Cookie smuggled in through the ordinary header map', async () => {
		// `cookie` is not in FORWARDABLE and must stay out of it: a caller that
		// could set one there could set any cookie for any host, with nothing
		// recording that a credential had been sent. The jar's header arrives
		// on its own field precisely so that it is greppable.
		let carried: string | null = null;
		await call(
			{ url: 'https://a.example.invalid/', headers: { Cookie: 'session=smuggled' } },
			(request) => {
				carried = request.headers.get('cookie');
				return new Response('ok');
			}
		);

		expect(carried).toBeNull();
	});

	it('does not carry the header across a redirect, and reports each hop', async () => {
		// A redirect is a different request, possibly to a different host, and
		// this route has no jar with which to decide whether the cookie applies
		// there. So it drops it, and reports what each hop set instead — the jar
		// scopes those, and the plugin's next request carries them.
		const carried: (string | null)[] = [];
		const { payload } = await call(
			{ url: 'https://a.example.invalid/one', cookies: { send: 'session=abc' } },
			(request) => {
				carried.push(request.headers.get('cookie'));
				if (request.url.endsWith('/one')) {
					return new Response(null, {
						status: 302,
						headers: {
							location: 'https://b.example.invalid/two',
							'set-cookie': 'hop=1'
						}
					});
				}
				return new Response('ok', { headers: { 'set-cookie': 'landed=2' } });
			}
		);

		expect(carried).toEqual(['session=abc', null]);
		expect(payload.setCookie).toEqual([
			{ url: 'https://a.example.invalid/one', headers: ['hop=1'] },
			{ url: 'https://b.example.invalid/two', headers: ['landed=2'] }
		]);
	});

	it('says nothing about cookies to a caller that holds no jar', async () => {
		// Without the key the response shape is what it was before jars existed,
		// and `Set-Cookie` is still not one of the four headers forwarded.
		const { payload } = await call(
			{ url: 'https://a.example.invalid/' },
			() => new Response('ok', { headers: { 'set-cookie': 'session=abc' } })
		);

		expect(payload.setCookie).toBeUndefined();
		expect(payload.headers).not.toHaveProperty('set-cookie');
	});
});
