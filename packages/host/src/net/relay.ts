/**
 * The one door a plugin's HTTP goes through, in the browser client.
 *
 * ## Why this exists at all
 *
 * A browser cannot fetch a content source directly, for two independent
 * reasons, and neither has a client-side fix:
 *
 * 1. **CORS.** A source will not send `Access-Control-Allow-Origin`, so the
 *    response is discarded before any of our code sees it.
 * 2. **Forbidden headers.** `Referer`, `Origin`, `User-Agent`, `Cookie` and
 *    every `Sec-*` name cannot be set from JavaScript — and those are exactly
 *    the headers a source checks to decide whether a request came from its own
 *    page.
 *
 * The Flutter client has neither problem, which is why this route is the
 * browser's alone and why nothing about it appears in the plugin ABI. A plugin
 * declares intent; each host satisfies it however that host can.
 *
 * ## What this is, stated plainly
 *
 * **It is a proxy that makes outbound requests on a caller's behalf.** On a
 * personal machine that is unremarkable — it can reach what the person running
 * it can already reach. On a *public* deployment it is a relay a stranger can
 * point at things, so it is bounded here rather than trusted to be used well:
 *
 * - https only, so it cannot be used to reach plaintext services.
 * - Private, loopback, link-local and multicast addresses are refused, which
 *   is what stops it being an SSRF gadget against a metadata endpoint or a
 *   service on the deployment's own network.
 * - Response size and time are capped.
 * - Redirects are followed by us, one hop at a time, re-checking the target —
 *   a source that redirects to `169.254.169.254` must not get a free pass
 *   because the first URL looked fine.
 *
 * The *plugin's* allowlist is enforced on the client, in `sandbox-host.ts`,
 * which is the side that knows which plugin is asking. This route does not
 * take that on faith and does not need to: its own limits hold regardless of
 * what a caller claims.
 *
 * ## One thing it does that a browser would do for it
 *
 * Sources routinely present a certificate chain missing its intermediate.
 * Browsers and curl chase the AIA extension to fill the gap; neither Node nor
 * bun does, so those hosts fail here and read as broken plugins. Chasing it
 * needs a raw TLS socket and a trust store, which is the least portable thing
 * a host owns — so this route asks for the repair rather than performing it
 * (`chain-repair.ts`), and `@plugin-bridge/host-node` is what supplies one.
 * It is spent once, on exactly that error, with verification still on; see
 * that file's header for why that is not the same as trusting less. A host
 * that supplies no repair gets the transport failure reported as it arrived,
 * which is what this route did before any repair existed.
 */

/**
 * The relay is framework-free on purpose.
 *
 * It holds the whole network policy this engine has — https only, private and
 * link-local addresses refused, redirects followed one hop at a time with the
 * target re-checked, a bounded body, and an allowlist in each direction — so a
 * host that routed around it would be running plugins under different rules
 * than the ones this repository states. A web framework's request handler is
 * four lines around `relay`; the four lines belong to the framework and the
 * policy belongs here.
 */
function json(data: unknown, init?: { status?: number }): Response {
	return new Response(JSON.stringify(data), {
		status: init?.status ?? 200,
		headers: { 'content-type': 'application/json' }
	});
}
import { isPrivateAddress } from './addresses';
import type { ChainRepair } from './chain-repair';
import { setCookiesOf } from './cookie-jar';

/** Response body cap. A catalogue page or an embed page, not a video. */
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * How long one relayed call may take, from the first hop to the last.
 *
 * ## One budget, not one per hop
 *
 * This used to be per hop — the signal was built inside the redirect loop — so
 * the real ceiling was `MAX_REDIRECTS + 1` times the number and no single place
 * stated it. A source that redirects four times could therefore spend five
 * budgets while the file claimed one. Shared, the constant is the truth: a call
 * cannot outlive it however many hops it takes, and raising it cannot be
 * multiplied by the shape of somebody else's redirect chain.
 *
 * ## Why the number is what it is, and why it lives here
 *
 * A timeout here is reported to a plugin as the source being unreachable, so
 * this number decides which sources appear to exist. It is set against the
 * population the relay exists to talk to, and that population is slow by a wide
 * margin rather than a narrow one: measured against one converted source, five
 * consecutive fetches of a single episode page answered in 2.8s, 11.4s, 4.4s,
 * 3.5s and 6.0s to first byte, with the TCP connect at 10-60ms every time. It
 * is the origin thinking, not the network.
 *
 * A 20s cap sat *inside* that spread, so the same page resolved or failed
 * depending on which sample a caller happened to draw, and a site that works
 * was filed as gone on a coin toss. That is why it is 45s, and why the number
 * belongs to this file rather than to a host: it is a fact about the sources,
 * not about who is asking.
 *
 * A host that is genuinely dead does not pay it. `ENOTFOUND`, `ECONNREFUSED`
 * and a refused handshake all come back in milliseconds. The only case that
 * waits the budget out is a host that accepts a connection and then says
 * nothing, which is both rare and, from here, indistinguishable from a host
 * that is merely slow.
 *
 * `options.timeoutMs` is for a caller whose ceiling is genuinely different —
 * a test that would rather not wait, a tool that would rather wait longer — and
 * not for a host restating this one. A host holding its own copy of this number
 * is what put the browser route and this file 25 seconds apart without either
 * of them being wrong on its own terms.
 */
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_REDIRECTS = 4;

/**
 * Headers the browser refuses to let JavaScript set, which are precisely the
 * ones a source checks. Forwarded here because a server has no such rule.
 *
 * An allowlist rather than "forward everything": the client is not the place
 * to decide what this server sends, and a caller that could set arbitrary
 * headers could set `Host` or an auth header meant for somewhere else.
 */
const FORWARDABLE = new Set([
	'accept',
	'accept-language',
	'range',
	'referer',
	'origin',
	'user-agent',
	'content-type',
	'x-requested-with',
	'sec-fetch-dest',
	'sec-fetch-mode',
	'sec-fetch-site'
]);

/**
 * `cookie` is deliberately absent from `FORWARDABLE`, and stays absent.
 *
 * A caller that could put a cookie in `headers` could put *any* cookie there,
 * for any host, with nothing recording that it happened. The jar's outbound
 * header therefore arrives through its own field (`cookies.send`) rather than
 * through the general allowlist, so that "this request carried a credential"
 * is one grep and not a judgement about the contents of a map. See
 * `cookie-jar.ts` for the state itself, which this route does not hold.
 */

export const relay = async (
	request: Request,
	/**
	 * The network, supplied rather than taken.
	 *
	 * This used to default to the ambient `fetch`, which was the one thing in
	 * this file that assumed a host. Every caller already passed its own — a
	 * server passes the platform's, a headless host passes a direct one, a spec
	 * passes a function answering from fixtures — so the default was reaching
	 * for a global nobody used.
	 */
	fetch: typeof globalThis.fetch,
	/**
	 * How to repair an under-sent certificate chain, if this host can.
	 *
	 * Null is the browser's answer and a perfectly good one: there, the
	 * platform has already chased the AIA extension before our code sees a
	 * response. See `chain-repair.ts`.
	 */
	repair: ChainRepair | null = null,
	/**
	 * What this host decides differently, if anything.
	 *
	 * Deliberately one object rather than a fourth positional argument: the
	 * next thing a host needs to set goes here without every existing caller
	 * moving, and a host that needs nothing keeps passing three arguments.
	 */
	options: { readonly timeoutMs?: number } = {}
): Promise<Response> => {
	let body: {
		url?: string;
		method?: string;
		headers?: Record<string, string>;
		body?: string | null;
		follow?: boolean;
		/**
		 * Present when the caller holds a cookie jar on a plugin's behalf.
		 *
		 * Presence alone is the switch: without this key the route behaves
		 * exactly as it did before jars existed, down to the response shape.
		 * With it, `send` is put on the first hop and every `Set-Cookie` the
		 * chain produced is reported back, tagged with the hop that sent it.
		 *
		 * The route stays **stateless**. It does not parse a cookie, does not
		 * decide what a `Domain` means, and does not carry one across a
		 * redirect — all of that is the jar's, in one place, host-side.
		 */
		cookies?: { send?: string };
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ error: 'malformed request' }, { status: 400 });
	}

	const method = (body.method ?? 'GET').toUpperCase();
	if (!['GET', 'POST', 'HEAD'].includes(method)) {
		return json({ error: 'unsupported method' }, { status: 400 });
	}

	let target: URL;
	try {
		target = new URL(String(body.url));
	} catch {
		return json({ error: 'not a url' }, { status: 400 });
	}

	const headers = new Headers();
	for (const [name, value] of Object.entries(body.headers ?? {})) {
		if (FORWARDABLE.has(name.toLowerCase())) headers.set(name, value);
	}

	// A jar-holding caller is answered with what each hop set; everyone else
	// gets the response shape this route has always had.
	const jarAware = body.cookies !== undefined && body.cookies !== null;
	const send = typeof body.cookies?.send === 'string' ? body.cookies.send : '';
	const setCookie: { url: string; headers: string[] }[] = [];

	// Built once, outside the loop, because it is the budget for the whole walk
	// and not for each leg of it. See `DEFAULT_TIMEOUT_MS`.
	const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

	// Redirects are followed here rather than by `fetch`, so every hop is
	// re-checked. `redirect: 'manual'` is what makes that possible.
	let response: Response;
	let hops = 0;
	for (;;) {
		const refusal = refuse(target);
		if (refusal !== null) return json({ error: refusal }, { status: 403 });

		// **The first hop only.** `send` was computed by the jar for the URL the
		// caller asked for, and a redirect is a different request to a possibly
		// different host — carrying the header along would be the route deciding
		// a cookie's scope, which is the one thing it is not allowed to do. The
		// hops that follow are therefore uncredentialled, and what they set is
		// reported back instead, so the jar scopes it and the *next* request
		// carries it. `delete` rather than "never set" because the header object
		// is reused across hops.
		if (hops === 0 && send.length > 0) headers.set('cookie', send);
		else headers.delete('cookie');

		const outbound = {
			method,
			headers,
			body: method === 'POST' ? (body.body ?? null) : null,
			redirect: 'manual' as const,
			signal
		};

		try {
			response = await fetch(target, outbound);
		} catch (error) {
			// The one retryable failure: a chain missing its intermediate. The
			// certificates are fetched from where the server's own leaf says
			// they live, and the handshake is then made again with full
			// verification — see `chain-repair.ts`. A host that supplied no
			// repair skips straight to reporting the failure, which is the
			// answer a browser needs and the answer this route gave before the
			// repair existed.
			const issuers =
				repair !== null && repair.chainIsIncomplete(error) ? await repair.issuersFor(target) : [];
			if (repair === null || issuers.length === 0) {
				return json(
					{ error: `could not reach ${target.hostname}: ${why(error)}` },
					{ status: 502 }
				);
			}
			try {
				response = await repair.fetchTrusting(target, issuers, {
					method,
					headers,
					body: outbound.body,
					signal,
					maxBytes: MAX_BYTES
				});
			} catch (retryError) {
				return json(
					{ error: `could not reach ${target.hostname}: ${why(retryError)}` },
					{ status: 502 }
				);
			}
		}

		// Collected per hop, tagged with the hop, because a chain sets cookies at
		// each step and they belong to the step that set them. Tagging them all
		// with the URL the caller asked for is precisely how a cookie ends up
		// filed against the wrong host.
		if (jarAware) {
			const headersSet = setCookiesOf(response.headers);
			if (headersSet.length > 0) setCookie.push({ url: target.toString(), headers: headersSet });
		}

		const location = response.headers.get('location');
		// A caller that asked not to follow is reading the redirect *itself*.
		//
		// Whole families of sources answer a "which server has this episode"
		// request with a 302 whose `Location` is the embed, and the extension
		// reads that header rather than fetching it. Following the hop for such
		// a caller hands back the destination page with the header gone, so the
		// extension reads its own answer as absent and reports a source that
		// changed. The hop is still re-checked when it *is* followed, below:
		// this only stops the walk, it does not relax anything about it.
		if (body.follow === false) break;
		if (response.status >= 300 && response.status < 400 && location !== null) {
			hops += 1;
			if (hops > MAX_REDIRECTS) return json({ error: 'too many redirects' }, { status: 502 });
			const from = target;
			let next: URL;
			try {
				next = new URL(location, target);
			} catch {
				return json({ error: 'bad redirect' }, { status: 502 });
			}
			// The site's advice about *scheme* is the one part not taken. See
			// `keepingHttps`. Everything else about this hop — the private-address
			// guard, the https floor, the hop budget, the uncredentialled
			// header — is decided by the top of this loop, on whatever URL comes
			// back from here, exactly as before.
			target = keepingHttps(from, next);
			continue;
		}
		break;
	}

	// A HEAD has no body, so neither cap applies to it. `content-length` on a
	// HEAD describes the body a GET *would* return, and refusing a large one
	// would be refusing to answer the one question a probe is asking: is
	// anything there? A stream is a video, so that answer is always "too large".
	//
	// A *ranged* GET is the same question asked a second way, for the hosts that
	// will not answer a HEAD at all. The caller has named the slice it wants, so
	// a host that ignores `Range` and starts sending the whole file is answering
	// badly rather than being asked for too much — refusing it there reported a
	// working stream as unreachable, which is the exact bug the HEAD probe was
	// introduced to fix, one fallback further down. So a ranged read is
	// truncated at the cap instead of refused; the cap still holds, because what
	// it protects is this process's memory and that is bounded either way.
	//
	// Too large is reported as an *answer*, not as an error.
	//
	// A plugin that writes `client.newCall(GET(url)).execute().request.url` is
	// asking where a redirect lands, and this ecosystem resolves video links
	// that way — so the chain ends on the video itself and the cap is reached
	// every time. Refusing there threw away the redirect the plugin had already
	// paid for, over a body it never wanted. The status, the final url and the
	// headers are all known by then and all cost nothing, so they are answered
	// and the body is marked unread. A plugin that does want the body is told
	// why it cannot have it (`__responseOf`), rather than handed an empty page.
	let text = '';
	let unread: string | null = null;
	if (method !== 'HEAD') {
		const ranged = headers.has('range');
		const declared = Number(response.headers.get('content-length') ?? '0');
		if (declared > MAX_BYTES && !ranged) {
			unread = 'too large';
			await response.body?.cancel();
		} else {
			text = ranged ? await readCapped(response, MAX_BYTES) : await response.text();
			if (text.length > MAX_BYTES && !ranged) {
				text = '';
				unread = 'too large';
			}
		}
	}

	// Only the headers a plugin has any business reading. A `Set-Cookie` is
	// still not among them, and the jar did not change that: it is reported on
	// its own field below, to a *host* that holds it, and `sandbox-host.ts`
	// strips that field before the payload reaches the isolate. A plugin sees
	// the same four headers it always saw.
	const returned: Record<string, string> = {};
	for (const name of ['content-type', 'content-length', 'location', 'retry-after']) {
		const value = response.headers.get(name);
		if (value !== null) returned[name] = value;
	}

	// A non-2xx is returned as data, not as an HTTP error: sources use 404 and
	// 403 as ordinary answers, and the plugin decides what they mean.
	const challenge = challengeKind(response, text);
	return json({
		status: response.status,
		url: target.toString(),
		headers: returned,
		body: text,
		...(unread === null ? {} : { unread }),
		...(challenge === null ? {} : { challenge }),
		...(setCookie.length === 0 ? {} : { setCookie })
	});
};

/**
 * Whether a refusal was a bot check rather than the source saying no.
 *
 * These are the same HTTP status. A source that has decided we may not read it
 * and an interstitial asking a *browser* to run some JavaScript both answer
 * `403`, and until this existed the two were one row on the scoreboard reading
 * "the host refused us" — which sent people to look at their request headers
 * for a problem that was never there. Naming it does not solve it. It moves a
 * whole class of failure out of "unknown" and into a column somebody can decide
 * about, which is the step that has to come first either way.
 *
 * The signals are the ones a challenge cannot avoid emitting: the status codes
 * it uses, the vendor's own headers, and — for the deployments that strip
 * those — two phrases from the interstitial body. Read in that order, because
 * the first two cost nothing and the third is a guess.
 *
 * Advisory, and returned alongside the response rather than instead of it. The
 * plugin still gets the status and the body it would have got, and decides for
 * itself; nothing here changes what is relayed.
 */
function challengeKind(response: Response, body: string): string | null {
	if (![403, 429, 503].includes(response.status)) return null;

	const named =
		response.headers.get('cf-mitigated') !== null ||
		response.headers.get('cf-ray') !== null ||
		response.headers.get('cf-chl-out') !== null ||
		(response.headers.get('server') ?? '').toLowerCase().includes('cloudflare');
	if (named) return 'cloudflare';

	// Only the head of the body: an interstitial says so early, and scanning a
	// megabyte of a page that merely happens to 403 is work for nothing.
	const head = body.slice(0, 2048).toLowerCase();
	if (head.includes('just a moment') || head.includes('cf-chl')) return 'cloudflare';
	return null;
}

/**
 * At most `limit` bytes of a body, then the connection is dropped.
 *
 * For the ranged probe, where the question is whether anything is being served
 * and the honest answer must not depend on the host having honoured `Range`.
 * Reading through the stream rather than `text()` is what makes the ceiling
 * real: `text()` would buffer the whole video first and check afterwards.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
	const body = response.body;
	if (body === null) return '';

	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done || value === undefined) break;
			chunks.push(value);
			size += value.length;
			if (size >= limit) break;
		}
	} finally {
		// Cancel rather than drain: the rest of a video is bytes nobody asked
		// for, on somebody else's bandwidth.
		await reader.cancel().catch(() => {});
	}

	const joined = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return new TextDecoder().decode(joined.subarray(0, limit));
}

/**
 * The same redirect target, over https, when the only thing being changed is
 * the scheme — and otherwise the target untouched.
 *
 * A family of sites (misconfigured canonical redirects, usually adding a
 * trailing slash) answer an **https** request with a 301 to **http** on their
 * own host. Measured: `https://…/buscar/a` → `http://…/buscar/a/`, and
 * `https://…/` → `http://…/index`. Both answer 200 over https when asked
 * directly, so the redirect is not a real move to cleartext — it is a
 * `Location` built by string-joining a stored base that predates the site's
 * own certificate.
 *
 * Refusing it is correct and was costing working sources. Following it is not
 * an option: this relay does not put a plugin's traffic on the wire in the
 * clear, ever. So the site's advice about *where* to go is taken, and its
 * advice about *how* is not.
 *
 * Narrow on purpose, and each condition is load-bearing:
 *
 * - The request being redirected must itself be https. An http hop cannot
 *   reach here — the loop refuses one before it is sent — but the check says
 *   so rather than relying on that.
 * - The target must be http. Anything else is returned untouched.
 * - The host must match **exactly**, `host` and not `hostname`, so a redirect
 *   to a different port is a different host and is left to be refused. A
 *   cross-host downgrade is somebody else's server and is never rewritten.
 *
 * What this deliberately is not: following downgrades, relaxing mixed schemes,
 * rewriting across hosts, or trying https speculatively anywhere else. The
 * returned URL is re-checked by the loop like any other hop and spends a hop
 * from the same budget, so a site that redirects in a circle still stops.
 */
function keepingHttps(from: URL, to: URL): URL {
	if (from.protocol !== 'https:' || to.protocol !== 'http:') return to;
	if (to.host !== from.host) return to;
	const upgraded = new URL(to.toString());
	upgraded.protocol = 'https:';
	return upgraded;
}

/**
 * Why this URL may not be fetched, or null.
 *
 * The literal-IP checks are the SSRF guard. A hostname that *resolves* to a
 * private address still gets through — closing that needs resolution before
 * connection, which `fetch` does not expose — so this raises the bar rather
 * than sealing it, and says so instead of implying otherwise.
 */
function refuse(url: URL): string | null {
	if (url.protocol !== 'https:') return 'a plugin may only make https requests';
	// Shared with the AIA chase (`@plugin-bridge/host-node`), which follows a
	// URL an untrusted certificate named and so has to be held to the same
	// floor. That is why the check lives in `addresses.ts` rather than here.
	if (isPrivateAddress(url.hostname)) return 'refusing a private address';
	return null;
}

/**
 * The failure in words that name a cause.
 *
 * `fetch` reports nearly everything as `TypeError: fetch failed` and hangs the
 * real reason off `cause`. Returning the wrapper is returning "it did not
 * work", which is what the caller already knew — and the caller here is a
 * verification probe whose entire job is to say *why* a source did not answer.
 * So the chain is walked for the first thing that says something: a system
 * error code, then a message.
 */
function why(error: unknown): string {
	const seen: string[] = [];
	for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
		const code = (current as { code?: unknown } | null)?.code;
		if (typeof code === 'string' && code.length > 0) return code;
		const message = (current as { message?: unknown } | null)?.message;
		if (typeof message === 'string' && message.length > 0) seen.push(message);
		current = (current as { cause?: unknown } | null)?.cause;
	}
	// The innermost message is the specific one; `fetch failed` is the outer.
	return seen.at(-1) ?? String(error);
}
