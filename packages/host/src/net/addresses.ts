/**
 * The private-address floor, in one place because two callers hold it.
 *
 * The relay refuses one for a URL a caller supplied; the Node host's AIA chase
 * (`@plugin-bridge/host-node`) refuses one for a URL an untrusted certificate
 * named. Both are the same question and a second implementation of it would be
 * a second thing to get wrong — so it lives here, on the portable side, where
 * the relay can reach it without reaching for a certificate stack.
 */

/**
 * Whether this hostname is one the relay must not dial.
 *
 * Literal addresses only: a hostname that *resolves* privately still gets
 * through, and closing that needs resolution before connection which neither
 * `fetch` nor this exposes.
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
