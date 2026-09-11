/**
 * The jar's scoping rules, which are the feature rather than a detail of it.
 *
 * `docs/adr/0005-network-boundaries.md` §3 refused an *unconstrained* cookie
 * jar and specified a constrained one, so every test here is a constraint
 * rather than a capability: what is not sent, where it is not sent, and what is
 * not stored at all. The one capability test — a cookie comes back to the host
 * that set it — exists so that the rest are not trivially satisfied by a jar
 * that does nothing.
 *
 * Rule 9: every host is RFC 2606 reserved.
 */

import { describe, expect, it } from 'vitest';

import { CookieJar, setCookiesOf } from './cookie-jar';

const A = 'https://a.example.invalid/';
const B = 'https://b.example.invalid/';

describe('a cookie goes back where it came from', () => {
	it('sends a cookie to the host that set it', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['session=abc123; Path=/']);

		expect(jar.header(A)).toBe('session=abc123');
	});

	it('never sends it to a different host', () => {
		// The whole point of the design. A plugin may reach several hosts; a
		// session value one of them issued is that one's and no other's.
		const jar = new CookieJar();
		jar.absorb(A, ['session=abc123; Path=/']);

		expect(jar.header(B)).toBe('');
	});

	it('keeps two hosts’ cookies of the same name apart', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=from-a']);
		jar.absorb(B, ['id=from-b']);

		expect(jar.header(A)).toBe('id=from-a');
		expect(jar.header(B)).toBe('id=from-b');
	});

	it('orders a header longest path first, as RFC 6265 §5.4 asks', () => {
		const jar = new CookieJar();
		jar.absorb(`${A}deep/page`, ['broad=1; Path=/', 'narrow=2; Path=/deep']);

		expect(jar.header(`${A}deep/page`)).toBe('narrow=2; broad=1');
	});
});

describe('Domain, which may narrow and may never widen', () => {
	it('refuses a Domain the setting host is not inside', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1; Domain=elsewhere.invalid']);

		expect(jar.size).toBe(0);
		expect(jar.declined[0].why).toContain('elsewhere.invalid');
	});

	it('does not let a parent Domain reach a sibling host', () => {
		// A browser would send this to `b.example.invalid` too. That is exactly
		// the cross-host send ADR-0005 forbids, so the cookie is kept for the
		// host that set it and for nowhere else.
		const jar = new CookieJar();
		jar.absorb(A, ['id=1; Domain=example.invalid']);

		expect(jar.header(A)).toBe('id=1');
		expect(jar.header(B)).toBe('');
	});
});

describe('Path', () => {
	it('defaults to the directory of the request, not to /', () => {
		// `/` would be a widening: a cookie set on one page would then ride
		// along on every request to the host.
		const jar = new CookieJar();
		jar.absorb(`${A}one/two`, ['id=1']);

		expect(jar.header(`${A}one/three`)).toBe('id=1');
		expect(jar.header(`${A}other`)).toBe('');
	});

	it('matches on a path boundary rather than on a prefix', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1; Path=/a']);

		expect(jar.header(`${A}a/b`)).toBe('id=1');
		expect(jar.header(`${A}ab`)).toBe('');
	});
});

describe('what is not stored at all', () => {
	it('ignores a set-cookie with no name=value pair', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['Secure; HttpOnly']);

		expect(jar.size).toBe(0);
	});

	it('refuses a __Host- cookie that breaks its own prefix rules', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['__Host-id=1; Secure; Domain=example.invalid; Path=/']);

		expect(jar.size).toBe(0);
		expect(jar.declined[0].why).toContain('__Host-');
	});

	it('refuses a __Secure- cookie sent without Secure', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['__Secure-id=1']);

		expect(jar.size).toBe(0);
	});

	it('will not take a cookie over anything but https', () => {
		const jar = new CookieJar();
		jar.absorb('http://a.example.invalid/', ['id=1']);

		expect(jar.size).toBe(0);
	});
});

describe('expiry, which is honoured — unlike persistence, which is not', () => {
	it('drops a cookie whose Max-Age has passed', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1']);
		jar.absorb(A, ['id=1; Max-Age=0']);

		expect(jar.header(A)).toBe('');
	});

	it('lets Max-Age win over Expires, as §5.2.2 requires', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600']);

		expect(jar.header(A)).toBe('id=1');
	});

	it('ignores a Max-Age that is not a number rather than reading it as zero', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1; Max-Age=forever']);

		expect(jar.header(A)).toBe('id=1');
	});

	it('forgets everything on clear, which is what an unload does', () => {
		const jar = new CookieJar();
		jar.absorb(A, ['id=1']);
		jar.clear();

		expect(jar.header(A)).toBe('');
		expect(jar.size).toBe(0);
	});
});

describe('reading Set-Cookie off a response', () => {
	it('keeps two cookies apart without splitting on the comma in an Expires', () => {
		// `get('set-cookie')` joins them with a comma and `Expires=Wed, 01 …`
		// contains one, so a jar that split the joined string back apart would
		// corrupt exactly the cookies that carry an expiry.
		const headers = new Headers();
		headers.append('set-cookie', 'a=1; Expires=Wed, 01 Jan 2098 00:00:00 GMT');
		headers.append('set-cookie', 'b=2');

		const jar = new CookieJar();
		jar.absorb(A, setCookiesOf(headers));

		expect(jar.header(A)).toBe('a=1; b=2');
	});

	it('answers with nothing for a response that set none', () => {
		expect(setCookiesOf(new Headers())).toEqual([]);
	});
});
