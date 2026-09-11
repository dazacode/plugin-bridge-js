/**
 * Completing a certificate chain the source did not bother to send.
 *
 * ## The failure this exists for
 *
 * TLS asks a server to present its leaf certificate *and* every intermediate
 * above it, up to but not including a root the client already trusts. A great
 * many content sources present the leaf alone. Browsers and curl paper over it:
 * the leaf carries an Authority Information Access extension naming a URL where
 * its issuer can be downloaded, and both go and fetch it. Node's TLS stack does
 * not. Neither does Bun's. So the same host that loads in a browser fails here
 * with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, and the plugins page reports a
 * perfectly good source as broken.
 *
 * ## What is deliberately not done
 *
 * `rejectUnauthorized: false`. This proxy relays a plugin's traffic to hosts
 * nobody has vetted, and switching verification off would mean *every* host
 * gets an unauthenticated connection to fix the few that under-send. Chasing
 * AIA is the opposite trade: the chain is still verified, in full, against the
 * system roots — the only thing that changes is that a certificate the server
 * omitted is fetched from the URL the server's own certificate names. A forged
 * intermediate does not help an attacker, because it still has to chain to a
 * root, and if it does then the connection was always going to be trusted.
 *
 * ## Two runtimes
 *
 * ADR-0001 §3: bun serves production, Node runs development and the tests. A
 * custom CA set reaches each one differently and neither reaches `fetch` the
 * same way, so there are two implementations of one small thing:
 *
 * - **Bun** takes `tls: { ca }` on `fetch` directly.
 * - **Node** takes `ca` on an https request, and its global `fetch` has no
 *   route to one — the `dispatcher` option needs `undici`, which is not a
 *   dependency of this package and is not going to become one for this. So the
 *   retry is made with `node:https` and the reply is rebuilt as a `Response`.
 *
 * Only the *retry* is runtime-specific. Discovery is plain sockets and plain
 * http, which both runtimes do the same way.
 */

import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect, rootCertificates, type PeerCertificate } from 'node:tls';

/** How far up a chain to chase. Two intermediates is already unusual. */
const MAX_ISSUERS = 3;
/** A certificate is a couple of kilobytes. Anything near this is not one. */
const MAX_CERT_BYTES = 64 * 1024;
const DISCOVERY_TIMEOUT_MS = 8_000;
/** Long enough that a working host is not re-chased on every stream probe. */
const CACHE_TTL_MS = 10 * 60_000;

interface CacheEntry {
	readonly issuers: string[];
	readonly at: number;
}

const cache = new Map<string, CacheEntry>();

/** Test seam: a chase is a network round trip and specs should not make one. */
export function forgetIssuers(): void {
	cache.clear();
}

/**
 * Whether this failure is the one AIA chasing can fix.
 *
 * `fetch` wraps everything as `TypeError: fetch failed` and hangs the real
 * cause off `cause`, sometimes more than one link deep, so the chain is walked
 * rather than the top-level error inspected.
 *
 * Only the leaf-signature code qualifies. An expired certificate, a name
 * mismatch or a self-signed root are all *conclusions* — fetching another
 * certificate cannot change any of them, and retrying would only turn one clear
 * failure into two slow ones.
 */
export function chainIsIncomplete(error: unknown): boolean {
	for (let current = error, depth = 0; current !== undefined && depth < 5; depth += 1) {
		const code = (current as { code?: unknown } | null)?.code;
		if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return true;
		current = (current as { cause?: unknown } | null)?.cause;
	}
	return false;
}

/**
 * The certificates a host omitted, in PEM, or an empty array.
 *
 * Cached per host:port, including the empty answer — a host that under-sends
 * and names no AIA URL is not going to start naming one within the ten minutes
 * a viewer spends on the plugins page, and re-chasing it would add a TLS
 * handshake to every request that was already going to fail.
 */
export async function issuersFor(target: URL): Promise<string[]> {
	const port = target.port.length > 0 ? Number(target.port) : 443;
	const key = `${target.hostname}:${port}`;

	const hit = cache.get(key);
	if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) return hit.issuers;

	let issuers: string[];
	try {
		issuers = await chase(target.hostname, port);
	} catch {
		// A discovery that fell over is not a different answer to a host that
		// names no issuer: either way there is nothing to retry with.
		issuers = [];
	}

	cache.set(key, { issuers, at: Date.now() });
	return issuers;
}

/**
 * Walks up from the leaf, downloading each certificate the one below names.
 *
 * The handshake that reads the leaf is made with verification off *and nothing
 * is sent over it* — it is opened to read the certificate the server presents
 * and closed again. The certificate it yields is not trusted by having been
 * read; it is trusted, or not, by the verified handshake that follows.
 */
async function chase(hostname: string, port: number): Promise<string[]> {
	let certificate = await peerCertificate(hostname, port);
	const issuers: string[] = [];

	for (let depth = 0; depth < MAX_ISSUERS; depth += 1) {
		const url = caIssuerUrl(certificate);
		if (url === null) break;

		const der = await downloadCertificate(url);
		if (der === null) break;

		issuers.push(pemOf(der));

		// The downloaded issuer may itself be missing *its* issuer, so the same
		// question is asked of it.
		const next = issuerOf(der);
		if (next === null) break;
		certificate = next;
	}

	return issuers;
}

/**
 * A downloaded certificate, read far enough to ask it the same question again.
 *
 * `X509Certificate` is the only way to read an AIA extension off bytes we hold
 * rather than off a live socket, and its `infoAccess` is text where a socket's
 * is a parsed map — hence `parseInfoAccess`.
 *
 * Null ends the walk: either the bytes would not parse, or the certificate is
 * self-signed and therefore a root, and a root is the thing chains stop at.
 */
function issuerOf(der: Uint8Array): PeerCertificate | null {
	try {
		const certificate = new X509Certificate(der);
		if (certificate.issuer === certificate.subject) return null;
		return {
			infoAccess: parseInfoAccess(certificate.infoAccess)
		} as PeerCertificate;
	} catch {
		return null;
	}
}

/** Opens a handshake purely to read what the server presents, then drops it. */
function peerCertificate(hostname: string, port: number): Promise<PeerCertificate> {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect(
			{ host: hostname, port, servername: hostname, rejectUnauthorized: false },
			() => {
				const certificate = socket.getPeerCertificate(false);
				socket.destroy();
				resolve(certificate);
			}
		);
		socket.setTimeout(DISCOVERY_TIMEOUT_MS, () => {
			socket.destroy();
			reject(new Error('timed out reading the certificate'));
		});
		socket.on('error', (error) => {
			socket.destroy();
			reject(error);
		});
	});
}

/**
 * The `caIssuers` URL a certificate names, if it names an http(s) one.
 *
 * AIA URLs are http by convention and by design — a certificate fetched to
 * validate a certificate cannot depend on a validated connection without
 * chasing its own tail — so http is accepted here where the proxy proper
 * refuses it. What makes that safe is that the bytes are not trusted for having
 * arrived: they are an input to the verification that follows, not a
 * substitute for it.
 */
function caIssuerUrl(certificate: PeerCertificate | null): URL | null {
	const listed = certificate?.infoAccess?.['CA Issuers - URI'] ?? [];
	for (const candidate of listed) {
		let url: URL;
		try {
			url = new URL(candidate);
		} catch {
			continue;
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
		// The same SSRF floor the proxy itself keeps. A certificate is a thing
		// an untrusted host wrote, so the URL in it is an untrusted URL, and a
		// leaf naming `http://169.254.169.254/…` must not turn this into the
		// gadget the rest of the route is careful not to be.
		if (isPrivateAddress(url.hostname)) continue;
		return url;
	}
	return null;
}

/** Fetches an issuer certificate as DER, or null if it is not one. */
async function downloadCertificate(url: URL): Promise<Uint8Array | null> {
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: 'follow',
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS)
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;

	const declared = Number(response.headers.get('content-length') ?? '0');
	if (declared > MAX_CERT_BYTES) return null;

	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.length === 0 || bytes.length > MAX_CERT_BYTES) return null;

	// PEM is served for this about as often as DER, despite the spec. Both are
	// accepted; anything that is neither is discarded rather than handed to the
	// TLS stack to choke on.
	const text = new TextDecoder().decode(bytes.subarray(0, 64));
	if (text.includes('-----BEGIN CERTIFICATE-----')) return bytes;
	// DER is a SEQUENCE: tag 0x30, long-form length.
	if (bytes[0] !== 0x30) return null;
	return bytes;
}

/** DER to PEM, or PEM straight through. */
function pemOf(der: Uint8Array): string {
	const head = new TextDecoder().decode(der.subarray(0, 64));
	if (head.includes('-----BEGIN CERTIFICATE-----')) return new TextDecoder().decode(der);

	const base64 = Buffer.from(der).toString('base64');
	const lines = base64.match(/.{1,64}/g) ?? [];
	return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * `X509Certificate.infoAccess` is text, one entry per line, in the shape
 * `CA Issuers - URI:http://…`. `PeerCertificate.infoAccess` is the parsed map.
 * This turns the first into the second so one reader serves both.
 */
function parseInfoAccess(raw: string | undefined): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const line of (raw ?? '').split('\n')) {
		const separator = line.indexOf(':');
		if (separator < 0) continue;
		const name = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (name.length === 0 || value.length === 0) continue;
		(out[name] ??= []).push(value);
	}
	return out;
}

interface RetryInit {
	readonly method: string;
	readonly headers: Headers;
	readonly body: string | null;
	readonly signal: AbortSignal;
	readonly maxBytes: number;
}

/**
 * The request again, with the missing certificates added to the trust store.
 *
 * Redirects are not followed: the caller re-checks every hop itself, and a
 * retry that quietly followed one would be handing back a response from an
 * address nothing had refused.
 */
export async function fetchTrusting(
	target: URL,
	extraCa: readonly string[],
	init: RetryInit
): Promise<Response> {
	const bun = (globalThis as { Bun?: unknown }).Bun;
	if (bun !== undefined) {
		return fetch(target, {
			method: init.method,
			headers: init.headers,
			body: init.body,
			redirect: 'manual',
			signal: init.signal,
			// Bun's own extension, and the whole reason this branch exists.
			tls: { ca: [...rootCertificates, ...extraCa] }
		} as RequestInit);
	}
	return nodeFetch(target, extraCa, init);
}

/** Node's https client, rebuilt into the `Response` the caller expects. */
function nodeFetch(target: URL, extraCa: readonly string[], init: RetryInit): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = httpsRequest(
			target,
			{
				method: init.method,
				headers: Object.fromEntries(init.headers),
				// Replacing the CA list replaces it wholesale, so the system
				// roots are re-stated. Leaving them out would trust the three
				// certificates we just downloaded and nothing else.
				ca: [...rootCertificates, ...extraCa],
				signal: init.signal
			},
			(reply) => {
				const chunks: Buffer[] = [];
				let size = 0;
				reply.on('data', (chunk: Buffer) => {
					size += chunk.length;
					if (size > init.maxBytes) {
						reply.destroy();
						reject(new Error('response too large'));
						return;
					}
					chunks.push(chunk);
				});
				reply.on('error', reject);
				reply.on('end', () => {
					const status = reply.statusCode ?? 502;
					const headers = new Headers();
					for (const [name, value] of Object.entries(reply.headers)) {
						if (value === undefined) continue;
						for (const one of Array.isArray(value) ? value : [value]) {
							headers.append(name, one);
						}
					}
					// A 204 or a 304 may not carry a body at all, and handing
					// `Response` an empty one for those throws.
					const empty = status === 204 || status === 304 || init.method === 'HEAD';
					resolve(
						new Response(empty ? null : Buffer.concat(chunks), {
							status,
							headers
						})
					);
				});
			}
		);

		request.on('error', reject);
		if (init.body !== null && init.method !== 'GET' && init.method !== 'HEAD') {
			request.write(init.body);
		}
		request.end();
	});
}

/**
 * The proxy's private-address floor, shared so an AIA URL is held to it too.
 *
 * Literal addresses only, like the caller's: a hostname that *resolves*
 * privately still gets through, and closing that needs resolution before
 * connection which neither `fetch` nor this exposes.
 */
export function isPrivateAddress(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

	if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
	// Unique-local (fc00::/7) and link-local (fe80::/10), and the colon is not
	// decoration. A bare `startsWith('fc')` refuses every *hostname* beginning
	// with those two letters — `fc2.example`, `fdn.example` — which is a shape
	// content hosts really use, and the refusal read as a broken source rather
	// than as our over-matching. An address always carries a colon inside its
	// first four hex digits; a hostname never can, since `URL.hostname` has
	// already taken any port off and the brackets are stripped above.
	if (host === '::1' || /^(fe80|f[cd][0-9a-f]{0,2}):/.test(host)) return true;

	const parts = host.split('.');
	if (parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part))) {
		const [a, b] = parts.map(Number);
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 169 && b === 254) || // link-local, and the cloud metadata endpoint
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
			a >= 224 // multicast and reserved
		);
	}

	return false;
}
