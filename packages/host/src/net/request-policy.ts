/**
 * The declarative request policy — retry, rate limit, per-host headers.
 *
 * ## What this is, and what it deliberately is not
 *
 * The ecosystem this translator reads from expresses all three of these by
 * installing an okhttp `Interceptor`: an object with a `proceed(request)` chain
 * that may delay, re-header, or re-issue a call. `ABI.md` §2 has no such chain
 * and will not grow one — the host owns the transport, buffers the whole body,
 * and hands a plugin a value rather than a stream. So the *effect* is offered
 * instead of the mechanism, and it is offered the same way `StreamPipeline`
 * offers a proxy server's effect: the plugin **declares** what it wants and the
 * host does it.
 *
 * That is a narrower thing than an interceptor, and the narrowness is the
 * feature. `adr/0006-local-http-server.md` §5 refuses to recognise intent in an
 * arbitrary foreign lambda, and the same rule binds here: a hand-written
 * `addInterceptor { chain -> … }` stays refused by name. What translates onto
 * this policy is only the ecosystem's **named** declarative helpers, whose
 * meaning is fixed by their own signature and not by reading their body.
 *
 * ## Why the shapes look like `StreamPipeline`'s
 *
 * `headersByHost` is `ABI.md` §4.1's field, spelled the same way, matched the
 * same way (`network.hosts` patterns, most specific first) and meaning the same
 * thing. A second concept for "these headers, but only over there" would be two
 * answers to one question — and the reason §4.1 has the field at all is the
 * reason this does: a real source spans two or three hosts that want different
 * things, and one flat map makes a plugin guess which to please.
 *
 * ## Why a rate limit is honoured exactly or refused
 *
 * `__k.rateLimit` used to accept a limit and return its receiver unchanged. An
 * extension that politely throttles itself to one request a second was
 * therefore converted into one that does not, which is the silent-wrong-answer
 * failure this project's standing rule exists to prevent — and the symptom is a
 * source that bans the viewer rather than an error anybody can read. So the
 * period is resolved to whole milliseconds at translation time and a period
 * that cannot be (a sub-millisecond unit, a period that is not a literal) is
 * refused rather than rounded.
 */

import { ValidationFailure } from '@plugin-bridge/core/errors';

import { hostMatches } from '../host-match';

/**
 * At most `permits` requests may be issued in any `periodMs` window.
 *
 * A sliding window, which is what the shared library's interceptor implements:
 * it remembers when the last `permits` requests went out and holds the next one
 * until the oldest of them has fallen out of the window. A fixed window would
 * be the easier thing to write and would permit `2 * permits` requests across
 * a boundary, which is exactly the burst the source asked us not to send.
 */
export interface RateLimitRule {
	readonly permits: number;
	readonly periodMs: number;
}

/**
 * How many times a status is worth asking again, and how long to wait.
 *
 * `onStatus` is a list rather than a range because "retryable" is a per-source
 * judgement: 429 and 503 almost always are, 403 almost never is (it is a
 * decision, and asking again is how a soft block becomes a hard one), and a
 * source that answers 500 on a cold cache and 200 on the retry exists.
 *
 * Only a *status* is retried. A request that threw — the proxy could not reach
 * the host at all — is not, and that is deliberate: a transport failure here
 * has already been through the relay's own one retry (`net/aia.ts`), and
 * re-issuing it would multiply a timeout by `attempts` inside a call that is
 * racing a deadline.
 */
export interface RetryRule {
	/** Total attempts including the first. 1 means "do not retry". */
	readonly attempts: number;
	/** Statuses worth asking again. */
	readonly onStatus: readonly number[];
	/** Wait before the second attempt. */
	readonly backoffMs: number;
	/** Each further wait is multiplied by this. Absent means 1 — a flat wait. */
	readonly multiplier?: number;
}

/**
 * Everything a plugin may declare about *how* its requests are made.
 *
 * Every field is optional and an absent field means "the host's default",
 * which is: no retry, no pacing, and no headers the request did not carry.
 */
export interface RequestPolicy {
	readonly retry?: RetryRule;
	/** Pacing for every request this plugin makes. */
	readonly rateLimit?: RateLimitRule;
	/** Pacing for one host, *in addition to* `rateLimit`. */
	readonly rateLimitByHost?: Readonly<Record<string, RateLimitRule>>;
	/** Headers to fill in on requests to a matching host. */
	readonly headersByHost?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/* ── bounds ───────────────────────────────────────────────────────────────── */

/**
 * Ceilings, which are memory and liveness bounds rather than policy.
 *
 * A plugin call is raced against a 30-second deadline (`sandbox-host.ts`), so a
 * policy that could ask the host to sleep for an hour is a policy that can only
 * ever end in a terminated isolate. Refusing it at declaration says so where a
 * person can read it, instead of at minute seventeen where nobody can.
 */
const MAX_PERMITS = 1000;
const MAX_PERIOD_MS = 600_000;
const MAX_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 60_000;
const MAX_MULTIPLIER = 10;
const MAX_HOST_RULES = 32;
const MAX_HEADERS_PER_HOST = 32;

/**
 * The longest a `Retry-After` will be obeyed before the retry is abandoned.
 *
 * A source answering `Retry-After: 3600` is not asking to be waited for, it is
 * saying no. Waiting would burn the call deadline and then fail anyway, so the
 * response it came with is returned as the answer instead.
 */
const MAX_RETRY_AFTER_MS = 60_000;

/* ── reading a declaration ────────────────────────────────────────────────── */

function fail(what: string): never {
	throw new ValidationFailure(`Not a request policy: ${what}.`);
}

function whole(value: unknown, what: string, low: number, high: number): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) {
		fail(`${what} must be a whole number from ${low} to ${high}`);
	}
	return value;
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${what} must be an object`);
	}
	return value as Record<string, unknown>;
}

function readRateLimit(value: unknown, what: string): RateLimitRule {
	const rule = record(value, what);
	return {
		permits: whole(rule.permits, `${what}.permits`, 1, MAX_PERMITS),
		periodMs: whole(rule.periodMs, `${what}.periodMs`, 1, MAX_PERIOD_MS)
	};
}

function readRetry(value: unknown): RetryRule {
	const rule = record(value, 'retry');
	if (!Array.isArray(rule.onStatus) || rule.onStatus.length === 0) {
		fail('retry.onStatus must be a non-empty list of status codes');
	}
	const onStatus = rule.onStatus.map((status, index) =>
		whole(status, `retry.onStatus[${index}]`, 100, 599)
	);
	const multiplier = rule.multiplier;
	if (multiplier !== undefined) {
		if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) {
			fail('retry.multiplier must be a number');
		}
		if (multiplier < 1 || multiplier > MAX_MULTIPLIER) {
			fail(`retry.multiplier must be from 1 to ${MAX_MULTIPLIER}`);
		}
	}
	return {
		attempts: whole(rule.attempts, 'retry.attempts', 1, MAX_ATTEMPTS),
		onStatus,
		backoffMs: whole(rule.backoffMs, 'retry.backoffMs', 0, MAX_BACKOFF_MS),
		...(multiplier === undefined ? {} : { multiplier })
	};
}

/**
 * A host pattern, in the spelling `manifest.network.hosts` already uses.
 *
 * Not checked against the plugin's own grant here, and deliberately: a policy
 * entry for a host the plugin may not reach is inert rather than wrong, and
 * `fetchForPlugin` refuses the host itself before anything leaves. Refusing the
 * *declaration* would also refuse a plugin that names a host it only reaches
 * after a page has handed it over (`sandbox-host.ts`, `learned`).
 */
function readPattern(key: string, what: string): string {
	const pattern = key.trim().toLowerCase();
	if (pattern.length === 0) fail(`${what} has an empty host pattern`);
	if (/\s/.test(pattern)) fail(`${what} host pattern "${key}" contains whitespace`);
	if (pattern.includes('*') && !pattern.startsWith('*.')) {
		fail(`${what} host pattern "${key}" may only wildcard a leading label, as "*.example.invalid"`);
	}
	if (pattern.slice(2).includes('*')) {
		fail(`${what} host pattern "${key}" may only wildcard a leading label, as "*.example.invalid"`);
	}
	return pattern;
}

/** RFC 7230 token, which is what a header name is. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/i;

function readHeaders(value: unknown, what: string): Record<string, string> {
	const written = record(value, what);
	const names = Object.keys(written);
	if (names.length > MAX_HEADERS_PER_HOST) {
		fail(`${what} declares more than ${MAX_HEADERS_PER_HOST} headers`);
	}
	const out: Record<string, string> = {};
	for (const name of names) {
		if (!HEADER_NAME.test(name)) fail(`${what} has "${name}", which is not a header name`);
		const held = written[name];
		if (typeof held !== 'string') fail(`${what}.${name} must be a string`);
		// A control character in a header value is a request-splitting attempt
		// wherever the transport is line-based. The relay's own allowlist would
		// drop most of these anyway; refusing here means the plugin is told.
		if (/[\r\n\0]/.test(held)) fail(`${what}.${name} contains a control character`);
		out[name.toLowerCase()] = held;
	}
	return out;
}

/**
 * Validates a declaration and returns it in canonical form.
 *
 * Throws `ValidationFailure` naming the field. Called on **both** sides of the
 * sandbox seam on purpose: inside the isolate so a plugin's own mistake throws
 * at the line that made it, and again in the host, which does not take a
 * sandbox's word for the shape of anything.
 */
export function readPolicy(value: unknown): RequestPolicy {
	const declared = record(value, 'a request policy');
	const policy: {
		retry?: RetryRule;
		rateLimit?: RateLimitRule;
		rateLimitByHost?: Record<string, RateLimitRule>;
		headersByHost?: Record<string, Record<string, string>>;
	} = {};

	for (const key of Object.keys(declared)) {
		if (!['retry', 'rateLimit', 'rateLimitByHost', 'headersByHost'].includes(key)) {
			// Named rather than ignored, for the reason `ABI.md` §7 refuses an
			// unknown permission: a field silently dropped is a plugin that
			// believes it declared something it did not.
			fail(`"${key}" is not a policy field`);
		}
	}

	if (declared.retry !== undefined) policy.retry = readRetry(declared.retry);
	if (declared.rateLimit !== undefined) {
		policy.rateLimit = readRateLimit(declared.rateLimit, 'rateLimit');
	}
	if (declared.rateLimitByHost !== undefined) {
		const written = record(declared.rateLimitByHost, 'rateLimitByHost');
		const keys = Object.keys(written);
		if (keys.length > MAX_HOST_RULES)
			fail(`rateLimitByHost names more than ${MAX_HOST_RULES} hosts`);
		const rules: Record<string, RateLimitRule> = {};
		for (const key of keys) {
			rules[readPattern(key, 'rateLimitByHost')] = readRateLimit(
				written[key],
				`rateLimitByHost["${key}"]`
			);
		}
		policy.rateLimitByHost = rules;
	}
	if (declared.headersByHost !== undefined) {
		const written = record(declared.headersByHost, 'headersByHost');
		const keys = Object.keys(written);
		if (keys.length > MAX_HOST_RULES) fail(`headersByHost names more than ${MAX_HOST_RULES} hosts`);
		const byHost: Record<string, Record<string, string>> = {};
		for (const key of keys) {
			byHost[readPattern(key, 'headersByHost')] = readHeaders(
				written[key],
				`headersByHost["${key}"]`
			);
		}
		policy.headersByHost = byHost;
	}
	return policy;
}

/* ── matching ─────────────────────────────────────────────────────────────── */

/**
 * The one pattern that should decide, out of those that match.
 *
 * `ABI.md` §4.1's rule, made executable: most specific first. An exact host
 * beats a wildcard, and between two wildcards the longer suffix wins — so
 * `*.cdn.example.invalid` beats `*.example.invalid` for a host both cover, and
 * a plugin does not have to care what order it wrote them in.
 */
function mostSpecific(patterns: readonly string[], host: string): string | null {
	let best: string | null = null;
	for (const pattern of patterns) {
		if (!hostMatches(host, pattern)) continue;
		if (best === null) {
			best = pattern;
			continue;
		}
		const wasExact = !best.startsWith('*.');
		const isExact = !pattern.startsWith('*.');
		if (wasExact && !isExact) continue;
		if (isExact && !wasExact) {
			best = pattern;
			continue;
		}
		if (pattern.length > best.length) best = pattern;
	}
	return best;
}

/* ── enforcement ──────────────────────────────────────────────────────────── */

function sameRule(a: RateLimitRule | undefined, b: RateLimitRule | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.permits === b.permits && a.periodMs === b.periodMs;
}

/** What the gate needs to know about an attempt in order to judge it. */
export interface Attempted {
	readonly status: number;
	/** `Retry-After`, verbatim, when the response carried one. */
	readonly retryAfter?: string;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * `Retry-After` as milliseconds, when it is a number of seconds or a date.
 *
 * Returns null for anything else, including a date in the past — a source whose
 * clock disagrees with ours should not be able to turn a retry into a busy
 * loop, and a malformed header should fall back to the declared backoff rather
 * than fail the request.
 */
export function retryAfterMs(value: string | undefined, now: number): number | null {
	if (value === undefined) return null;
	const text = value.trim();
	if (/^\d+$/.test(text)) return Number(text) * 1000;
	const at = Date.parse(text);
	if (Number.isNaN(at)) return null;
	return at <= now ? 0 : at - now;
}

/**
 * One plugin's policy, and the request history it is judged against.
 *
 * Held by the host — `sandbox-host.ts` owns one per running plugin — because
 * that is the only side that sees every request the plugin makes. A limiter
 * inside the isolate would be a limiter the isolate can choose not to run.
 */
export class RequestGate {
	private policy: RequestPolicy = {};

	/**
	 * When each of the last `permits` requests went out, per scope.
	 *
	 * Keyed by `'*'` for the plugin-wide rule and by the host pattern for a
	 * per-host one, so that changing a policy's period does not silently carry
	 * a window across from the old one.
	 */
	private readonly windows = new Map<string, number[]>();

	/**
	 * Replaces the policy.
	 *
	 * Replace rather than merge, so that what is in force is exactly what was
	 * last declared and a reader need not reconstruct a history. The *runtime
	 * shim* is where several Kotlin declarations are folded into one, because
	 * how two `rateLimit` calls combine is a fact about okhttp rather than
	 * about this ABI.
	 */
	declare(policy: RequestPolicy): void {
		// A window is kept where its rule did not change. Clearing the lot would
		// make a redeclaration a way to reset the limiter — declare the same rate
		// limit again between two requests and the pacing starts from nothing —
		// and a converted extension redeclares whenever it builds a second
		// client. What is dropped is a window whose rule moved, because the
		// request times under it were counted against a different period.
		const before = this.policy;
		if (sameRule(before.rateLimit, policy.rateLimit) !== true) this.windows.delete('*');
		const wasByHost = before.rateLimitByHost ?? {};
		const isByHost = policy.rateLimitByHost ?? {};
		for (const key of this.windows.keys()) {
			if (key !== '*' && sameRule(wasByHost[key], isByHost[key]) !== true) {
				this.windows.delete(key);
			}
		}
		this.policy = policy;
	}

	declared(): RequestPolicy {
		return this.policy;
	}

	/**
	 * The headers a request to `host` should carry.
	 *
	 * The request's own headers win. A policy entry is a default the plugin
	 * declared once, at construction, and a header written at the call site is
	 * the more specific statement of the two — the opposite precedence would
	 * make a per-request `Referer` unsettable without redeclaring the policy.
	 */
	headersFor(host: string, headers: Readonly<Record<string, string>>): Record<string, string> {
		const byHost = this.policy.headersByHost;
		if (byHost === undefined) return { ...headers };
		const pattern = mostSpecific(Object.keys(byHost), host.toLowerCase());
		if (pattern === null) return { ...headers };

		const already = new Set(Object.keys(headers).map((name) => name.toLowerCase()));
		const out: Record<string, string> = { ...headers };
		for (const [name, value] of Object.entries(byHost[pattern])) {
			if (!already.has(name)) out[name] = value;
		}
		return out;
	}

	/**
	 * Paces, runs, and re-runs one request.
	 *
	 * `attempt` is the whole of making the request once. It is called again only
	 * for a status the policy named, and every attempt — including a retry —
	 * spends a rate-limit permit, because a retry is a request the source sees.
	 */
	async run<T extends Attempted>(host: string, attempt: () => Promise<T>): Promise<T> {
		const retry = this.policy.retry;
		const attempts = retry === undefined ? 1 : retry.attempts;
		let wait = retry === undefined ? 0 : retry.backoffMs;

		for (let n = 1; ; n += 1) {
			await this.pace(host);
			const answer = await attempt();
			if (retry === undefined || n >= attempts) return answer;
			if (!retry.onStatus.includes(answer.status)) return answer;

			// The source's own answer to "how long", when it gave one. It knows
			// and we are guessing, so it wins — unless it is asking for longer
			// than a plugin call is allowed to live, in which case waiting would
			// spend the deadline and fail anyway.
			const asked = retryAfterMs(answer.retryAfter, Date.now());
			if (asked !== null && asked > MAX_RETRY_AFTER_MS) return answer;
			await sleep(asked ?? wait);
			wait = Math.min(wait * (retry.multiplier ?? 1), MAX_BACKOFF_MS);
		}
	}

	/** Holds until every rule covering `host` has a permit to spare. */
	private async pace(host: string): Promise<void> {
		const target = host.toLowerCase();
		// The plugin-wide rule first, then the host's. Both apply where both are
		// declared, which is what okhttp does with two installed interceptors and
		// is the only merge that is never *less* restrictive than what the source
		// asked for.
		if (this.policy.rateLimit !== undefined) {
			await this.acquire('*', this.policy.rateLimit);
		}
		const byHost = this.policy.rateLimitByHost;
		if (byHost === undefined) return;
		const pattern = mostSpecific(Object.keys(byHost), target);
		if (pattern !== null) await this.acquire(pattern, byHost[pattern]);
	}

	private async acquire(key: string, rule: RateLimitRule): Promise<void> {
		let window = this.windows.get(key);
		if (window === undefined) {
			window = [];
			this.windows.set(key, window);
		}
		for (;;) {
			const now = Date.now();
			while (window.length > 0 && now - window[0] >= rule.periodMs) window.shift();
			if (window.length < rule.permits) {
				// Recorded before the await that follows this call rather than
				// after the request returns: a permit is spent by *issuing*, and
				// counting on return would let ten slow requests leave together.
				window.push(now);
				return;
			}
			await sleep(rule.periodMs - (now - window[0]));
		}
	}
}
