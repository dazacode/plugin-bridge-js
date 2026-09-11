/**
 * Telling a chain worth completing from one that is simply broken.
 *
 * The predicate is the whole of the decision to spend a TLS handshake and a
 * second request, and it reads an error `fetch` has already wrapped — so what
 * it has to survive is the wrapping, not the certificate. These moved here
 * with `aia.ts` itself when the port was split from the Node implementation:
 * the relay states the capability, this package supplies it, and a predicate
 * is tested where it lives.
 *
 * Nothing here opens a socket. `issuersFor` and `fetchTrusting` are the parts
 * that do, and they are exercised through the relay with a stub standing in
 * for a host that under-sends (`packages/host/src/net/relay.spec.ts`).
 */

import { describe, expect, it } from 'vitest';

import { chainIsIncomplete } from './aia';

/** The shape Node's `fetch` really hands back: a wrapper around the cause. */
function fetchFailed(cause: unknown): TypeError {
	return Object.assign(new TypeError('fetch failed'), { cause });
}

/** A TLS error as `node:tls` raises it, before `fetch` buries it. */
function tlsError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

describe('deciding a chain is worth completing', () => {
	it('recognises the leaf-signature failure at the top level', () => {
		// The one error AIA chasing exists for: the server sent its leaf and
		// nothing above it, so verification stopped for want of a certificate
		// the leaf itself says where to find.
		expect(
			chainIsIncomplete(
				tlsError('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
			)
		).toBe(true);
	});

	it('finds it one and two cause levels down, which is how fetch reports it', () => {
		// Reading `error.code` off what `fetch` throws finds nothing at all —
		// the wrapper is a bare `TypeError` — and the retry that would have
		// rescued the source never fires. The depth varies by runtime and by
		// how the socket failed, so both shapes are pinned.
		const inner = tlsError(
			'unable to verify the first certificate',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
		);

		expect(chainIsIncomplete(fetchFailed(inner))).toBe(true);
		expect(chainIsIncomplete(fetchFailed(new Error('write EPROTO', { cause: inner })))).toBe(true);
	});

	it('refuses the failures another certificate cannot change', () => {
		// Each of these is a conclusion, not a gap. Retrying them would trade
		// one clear failure for two slow ones — a discovery handshake and a
		// second request — and still report the same thing at the end.
		expect(
			chainIsIncomplete(fetchFailed(tlsError('certificate has expired', 'CERT_HAS_EXPIRED')))
		).toBe(false);
		expect(
			chainIsIncomplete(
				fetchFailed(tlsError('hostname/IP does not match', 'ERR_TLS_CERT_ALTNAME_INVALID'))
			)
		).toBe(false);
		expect(chainIsIncomplete(fetchFailed(tlsError('getaddrinfo ENOTFOUND', 'ENOTFOUND')))).toBe(
			false
		);
	});

	it('says no to an error carrying no code at all', () => {
		expect(chainIsIncomplete(new Error('something went wrong'))).toBe(false);
	});

	it('terminates on an error whose cause is itself', () => {
		// Nothing forbids a library from building one, and a walk that trusted
		// the chain to end would hang the request rather than fail it.
		const looping: Error & { cause?: unknown } = new Error('round and round');
		looping.cause = looping;

		expect(chainIsIncomplete(looping)).toBe(false);
	});
});
