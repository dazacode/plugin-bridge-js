/**
 * What the request policy actually does to a request, against a clock.
 *
 * Almost nothing here asserts a shape. A rate limit that is "declared" and a
 * rate limit that *paces* are the same object and different software, and the
 * whole reason this file exists is that `__k.rateLimit` spent its life being
 * the first one — it took a limit, returned its receiver, and told nobody. So
 * the tests run requests through a fake clock and assert **when** they left.
 *
 * Every host is `example.invalid`, reserved by RFC 2606 (AGENTS.md rule 9).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RequestGate, readPolicy, retryAfterMs, type Attempted } from './request-policy';

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** An attempt that records the moment it ran and answers a given status. */
function recorder(statuses: readonly number[] = [200], retryAfter?: string) {
	const at: number[] = [];
	let n = 0;
	const attempt = (): Promise<Attempted> => {
		at.push(Date.now());
		const status = statuses[Math.min(n, statuses.length - 1)];
		n += 1;
		return Promise.resolve({ status, ...(retryAfter === undefined ? {} : { retryAfter }) });
	};
	return { at, attempt };
}

/* ── rate limiting ────────────────────────────────────────────────────────── */

describe('a rate limit that actually throttles', () => {
	it('lets the permits through at once and holds the next for the period', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ rateLimit: { permits: 2, periodMs: 1000 } }));
		const { at, attempt } = recorder();

		const started = Date.now();
		const running = [
			gate.run('a.example.invalid', attempt),
			gate.run('a.example.invalid', attempt),
			gate.run('a.example.invalid', attempt)
		];

		// The first two are the burst the source said it would tolerate.
		await vi.advanceTimersByTimeAsync(0);
		expect(at).toEqual([started, started]);

		// The third is not, and waiting 999ms is not enough: the window slides
		// from the *first* request, not from when the third one asked.
		await vi.advanceTimersByTimeAsync(999);
		expect(at).toHaveLength(2);

		await vi.advanceTimersByTimeAsync(1);
		expect(at).toEqual([started, started, started + 1000]);
		await Promise.all(running);
	});

	it('paces a long run at the declared rate rather than in bursts', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ rateLimit: { permits: 1, periodMs: 500 } }));
		const { at, attempt } = recorder();

		const started = Date.now();
		const running = Array.from({ length: 4 }, () => gate.run('a.example.invalid', attempt));
		await vi.advanceTimersByTimeAsync(2000);
		await Promise.all(running);

		expect(at).toEqual([started, started + 500, started + 1000, started + 1500]);
	});

	it('scopes a per-host limit to that host and lets another through', async () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({ rateLimitByHost: { 'slow.example.invalid': { permits: 1, periodMs: 1000 } } })
		);
		const { at: slow, attempt: slowly } = recorder();
		const { at: fast, attempt: quickly } = recorder();

		const started = Date.now();
		const running = [
			gate.run('slow.example.invalid', slowly),
			gate.run('slow.example.invalid', slowly),
			gate.run('fast.example.invalid', quickly),
			gate.run('fast.example.invalid', quickly)
		];

		await vi.advanceTimersByTimeAsync(0);
		// The unlimited host is not held up by the limited one's window.
		expect(fast).toEqual([started, started]);
		expect(slow).toEqual([started]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(slow).toEqual([started, started + 1000]);
		await Promise.all(running);
	});

	it('applies the plugin-wide limit and the host one together', async () => {
		// okhttp installs both interceptors and both run. Taking only the more
		// specific would let a host through at the *looser* of the two rates,
		// which is the one direction a wrong answer here cannot be allowed to go.
		const gate = new RequestGate();
		gate.declare(
			readPolicy({
				rateLimit: { permits: 2, periodMs: 1000 },
				rateLimitByHost: { 'slow.example.invalid': { permits: 1, periodMs: 1000 } }
			})
		);
		const { at, attempt } = recorder();

		const started = Date.now();
		const running = [
			gate.run('slow.example.invalid', attempt),
			gate.run('slow.example.invalid', attempt)
		];
		await vi.advanceTimersByTimeAsync(0);
		expect(at).toEqual([started]);

		await vi.advanceTimersByTimeAsync(1000);
		expect(at).toEqual([started, started + 1000]);
		await Promise.all(running);
	});

	it('prefers the most specific host pattern, not the first written', async () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({
				rateLimitByHost: {
					'*.example.invalid': { permits: 1, periodMs: 1000 },
					'*.cdn.example.invalid': { permits: 2, periodMs: 1000 }
				}
			})
		);
		const { at, attempt } = recorder();

		const started = Date.now();
		const running = [
			gate.run('a.cdn.example.invalid', attempt),
			gate.run('b.cdn.example.invalid', attempt)
		];
		await vi.advanceTimersByTimeAsync(0);
		// Both leave at once: the longer suffix wins and it permits two.
		expect(at).toEqual([started, started]);
		await Promise.all(running);
	});

	it('keeps the window when an unchanged policy is declared again', async () => {
		// A converted extension redeclares whenever it builds a second client.
		// If that reset the limiter, declaring the same limit between two
		// requests would be a way to opt out of it.
		const gate = new RequestGate();
		const policy = { rateLimit: { permits: 1, periodMs: 1000 } };
		gate.declare(readPolicy(policy));
		const { at, attempt } = recorder();

		const started = Date.now();
		const first = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(0);
		expect(at).toEqual([started]);

		gate.declare(readPolicy(policy));
		const second = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(0);
		expect(at).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1000);
		expect(at).toEqual([started, started + 1000]);
		await Promise.all([first, second]);
	});

	it('does nothing at all when nothing was declared', async () => {
		const gate = new RequestGate();
		const { at, attempt } = recorder();
		const started = Date.now();
		await Promise.all([
			gate.run('a.example.invalid', attempt),
			gate.run('a.example.invalid', attempt)
		]);
		expect(at).toEqual([started, started]);
	});
});

/* ── retry ────────────────────────────────────────────────────────────────── */

describe('a retry that retries the right statuses', () => {
	it('asks again on a named status and returns the answer that worked', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 3, onStatus: [429], backoffMs: 200 } }));
		const { at, attempt } = recorder([429, 429, 200]);

		const started = Date.now();
		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(1000);

		expect(await running).toMatchObject({ status: 200 });
		expect(at).toEqual([started, started + 200, started + 400]);
	});

	it('gives up after the declared attempts and returns the last answer', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 2, onStatus: [503], backoffMs: 100 } }));
		const { at, attempt } = recorder([503]);

		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(1000);

		// Returned, not thrown: a status is an answer a plugin is entitled to
		// read, and `ABI.md` §5 leaves what it means to the plugin.
		expect(await running).toMatchObject({ status: 503 });
		expect(at).toHaveLength(2);
	});

	it('leaves a status the policy did not name alone', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 4, onStatus: [429, 503], backoffMs: 100 } }));
		const { at, attempt } = recorder([403]);

		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(1000);

		// 403 is a decision, not a hiccup, and asking again is how a soft block
		// becomes a hard one.
		expect(await running).toMatchObject({ status: 403 });
		expect(at).toHaveLength(1);
	});

	it('multiplies the wait when asked to back off', async () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({ retry: { attempts: 4, onStatus: [500], backoffMs: 100, multiplier: 2 } })
		);
		const { at, attempt } = recorder([500]);

		const started = Date.now();
		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(5000);
		await running;

		expect(at).toEqual([started, started + 100, started + 300, started + 700]);
	});

	it('waits as long as the source asked rather than as long as we guessed', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 2, onStatus: [429], backoffMs: 50 } }));
		const { at, attempt } = recorder([429, 200], '2');

		const started = Date.now();
		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(5000);
		await running;

		expect(at).toEqual([started, started + 2000]);
	});

	it('stops rather than waiting out a Retry-After longer than a call may live', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 3, onStatus: [429], backoffMs: 50 } }));
		const { at, attempt } = recorder([429, 200], '3600');

		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(10_000);

		// An hour is not a source asking to be waited for, it is a source saying
		// no — and a plugin call is destroyed after thirty seconds regardless.
		expect(await running).toMatchObject({ status: 429 });
		expect(at).toHaveLength(1);
	});

	it('spends a rate-limit permit on every attempt, because a retry is a request', async () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({
				rateLimit: { permits: 1, periodMs: 1000 },
				retry: { attempts: 2, onStatus: [500], backoffMs: 0 }
			})
		);
		const { at, attempt } = recorder([500]);

		const started = Date.now();
		const running = gate.run('a.example.invalid', attempt);
		await vi.advanceTimersByTimeAsync(2000);
		await running;

		expect(at).toEqual([started, started + 1000]);
	});

	it('does not retry a request that threw', async () => {
		const gate = new RequestGate();
		gate.declare(readPolicy({ retry: { attempts: 3, onStatus: [500], backoffMs: 0 } }));
		let calls = 0;
		const attempt = (): Promise<Attempted> => {
			calls += 1;
			return Promise.reject(new Error('the proxy could not reach it'));
		};

		await expect(gate.run('a.example.invalid', attempt)).rejects.toThrow('could not reach');
		expect(calls).toBe(1);
	});

	it('reads Retry-After as seconds, as a date, and as neither', () => {
		const now = Date.parse('2026-09-10T00:00:00Z');
		expect(retryAfterMs('5', now)).toBe(5000);
		expect(retryAfterMs('Thu, 10 Sep 2026 00:00:30 GMT', now)).toBe(30_000);
		// A clock that disagrees with ours must not become a busy loop.
		expect(retryAfterMs('Thu, 10 Sep 2020 00:00:00 GMT', now)).toBe(0);
		expect(retryAfterMs('soon', now)).toBeNull();
		expect(retryAfterMs(undefined, now)).toBeNull();
	});
});

/* ── per-host headers ─────────────────────────────────────────────────────── */

describe('per-host headers', () => {
	it('applies them to the matching host only', () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({
				headersByHost: {
					'api.example.invalid': { referer: 'https://api.example.invalid/' },
					'*.cdn.example.invalid': { origin: 'https://www.example.invalid' }
				}
			})
		);

		expect(gate.headersFor('api.example.invalid', {})).toEqual({
			referer: 'https://api.example.invalid/'
		});
		expect(gate.headersFor('a.cdn.example.invalid', {})).toEqual({
			origin: 'https://www.example.invalid'
		});
		// A host nobody named carries exactly what the request carried.
		expect(gate.headersFor('other.example.invalid', { accept: 'text/html' })).toEqual({
			accept: 'text/html'
		});
	});

	it('does not let a wildcard cover the bare domain or a lookalike', () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({ headersByHost: { '*.cdn.example.invalid': { referer: 'https://a.invalid/' } } })
		);

		expect(gate.headersFor('cdn.example.invalid', {})).toEqual({});
		expect(gate.headersFor('evilcdn.example.invalid', {})).toEqual({});
		expect(gate.headersFor('one.cdn.example.invalid', {})).toHaveProperty('referer');
	});

	it('lets the request keep a header it set itself', () => {
		// The policy is a default declared once at construction; a header written
		// at the call site is the more specific of the two statements. The other
		// precedence would make a per-request `Referer` unsettable.
		const gate = new RequestGate();
		gate.declare(
			readPolicy({ headersByHost: { 'api.example.invalid': { Referer: 'https://a.invalid/' } } })
		);

		expect(gate.headersFor('api.example.invalid', { referer: 'https://b.invalid/' })).toEqual({
			referer: 'https://b.invalid/'
		});
		expect(gate.headersFor('api.example.invalid', { Referer: 'https://b.invalid/' })).toEqual({
			Referer: 'https://b.invalid/'
		});
	});

	it('takes the most specific pattern when several match', () => {
		const gate = new RequestGate();
		gate.declare(
			readPolicy({
				headersByHost: {
					'*.example.invalid': { referer: 'https://wide.invalid/' },
					'*.cdn.example.invalid': { referer: 'https://narrow.invalid/' },
					'one.cdn.example.invalid': { referer: 'https://exact.invalid/' }
				}
			})
		);

		expect(gate.headersFor('one.cdn.example.invalid', {}).referer).toBe('https://exact.invalid/');
		expect(gate.headersFor('two.cdn.example.invalid', {}).referer).toBe('https://narrow.invalid/');
		expect(gate.headersFor('two.example.invalid', {}).referer).toBe('https://wide.invalid/');
	});
});

/* ── what a declaration may not say ───────────────────────────────────────── */

describe('reading a declaration', () => {
	it.each([
		['a field nobody has', { retries: 3 }, '"retries" is not a policy field'],
		['a rate with no permits', { rateLimit: { periodMs: 1000 } }, 'rateLimit.permits'],
		['a fractional period', { rateLimit: { permits: 1, periodMs: 0.5 } }, 'rateLimit.periodMs'],
		['a period of nothing', { rateLimit: { permits: 1, periodMs: 0 } }, 'rateLimit.periodMs'],
		['a period beyond the cap', { rateLimit: { permits: 1, periodMs: 900_000 } }, 'periodMs'],
		['no statuses', { retry: { attempts: 2, onStatus: [], backoffMs: 0 } }, 'retry.onStatus'],
		[
			'more attempts than the deadline allows',
			{ retry: { attempts: 9, onStatus: [429], backoffMs: 0 } },
			'retry.attempts'
		],
		[
			'a multiplier below one',
			{ retry: { attempts: 2, onStatus: [429], backoffMs: 1, multiplier: 0.5 } },
			'retry.multiplier'
		],
		[
			'a wildcard in the middle',
			{ headersByHost: { 'a.*.example.invalid': { referer: 'https://a.invalid/' } } },
			'leading label'
		],
		[
			'a header name that is not one',
			{ headersByHost: { 'a.example.invalid': { 'ref erer': 'x' } } },
			'not a header name'
		],
		[
			'a header carrying a newline',
			{ headersByHost: { 'a.example.invalid': { referer: 'a\r\nb' } } },
			'control character'
		]
	])('refuses %s, and names it', (_label, declared, expected) => {
		expect(() => readPolicy(declared)).toThrow(expected);
	});

	it('accepts an empty policy, which is the host default spelled out', () => {
		expect(readPolicy({})).toEqual({});
	});

	it('lowercases host patterns and header names so a match is not a spelling', () => {
		const policy = readPolicy({
			headersByHost: { 'API.Example.Invalid': { Referer: 'https://a.invalid/' } },
			rateLimitByHost: { 'API.Example.Invalid': { permits: 1, periodMs: 10 } }
		});
		expect(Object.keys(policy.headersByHost ?? {})).toEqual(['api.example.invalid']);
		expect(policy.headersByHost?.['api.example.invalid']).toEqual({
			referer: 'https://a.invalid/'
		});
		expect(Object.keys(policy.rateLimitByHost ?? {})).toEqual(['api.example.invalid']);
	});
});
