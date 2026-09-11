/**
 * A cookie jar the **host** holds on a plugin's behalf.
 *
 * `docs/adr/0005-network-boundaries.md` §3 is the reasoning and the constraint
 * list; this is the implementation of it. The short version, because it is the
 * whole point of the feature rather than a caveat attached to it:
 *
 * - **Per plugin.** One instance per running sandbox. Nothing here is static,
 *   nothing is module-level, and there is no registry a second jar could be
 *   looked up in. Two plugins that share a host share nothing else.
 * - **Per host.** A cookie is bound to the exact hostname that set it. `Domain`
 *   never widens that — see `absorb`.
 * - **In memory only.** A `Map` on an instance the sandbox owns. There is no
 *   serialiser here, no `toJSON`, and no method that returns the store, so
 *   there is nothing for a caller to accidentally persist.
 * - **Never handed to plugin code.** The only reading method is `header`,
 *   which returns a `Cookie` header for one URL. A plugin cannot call it: the
 *   jar lives host-side of the worker boundary and its output goes into a
 *   request, not into a reply.
 *
 * ## What "conservative" means here, concretely
 *
 * RFC 6265 is written for a browser, where a cookie is ambient authority
 * attached to a user's whole session. Here it is per-plugin state that lives
 * for one run, so the parts of the RFC that exist to *widen* reach are the
 * parts this refuses. Every decision below is "the narrower reading", and each
 * one is a place where a source could work in a browser and not work here.
 * That is the intended trade: a cookie that does not arrive is a source that
 * does not play, and a cookie that arrives at the wrong host is a leak.
 *
 * | Attribute            | What this does                                            |
 * | -------------------- | --------------------------------------------------------- |
 * | `Domain`             | Never widens. Matching the origin host is narrowed to it;  |
 * |                      | not matching is refused outright.                          |
 * | `Path`               | Honoured, RFC 6265 §5.1.4 default-path and path-match.     |
 * | `Secure`             | Honoured, and free: the relay is https-only.               |
 * | `HttpOnly`           | Recorded. Every cookie here is already unreachable from    |
 * |                      | plugin code, so the flag cannot be weaker than the floor.  |
 * | `Expires` / `Max-Age`| Honoured for *expiry*. Never for persistence.              |
 * | `__Host-`/`__Secure-`| Honoured. A prefix whose rules are broken is refused.      |
 * | `SameSite`           | Ignored — see below.                                       |
 * | anything else        | Ignored. None of them can widen scope.                     |
 *
 * `SameSite` is ignored rather than honoured because there is nothing here for
 * it to describe. It exists to tell a browser whether a cookie rides along on
 * a request *the user's page did not make on purpose*, and every request in
 * this runtime is one a plugin made deliberately, from no origin, with no
 * ambient session behind it. Honouring it would mean inventing a "site" for a
 * request that has none, and the invented answer would decide whether a source
 * works. Ignoring it is the honest reading; it grants nothing, because the
 * cross-host rule above is already stricter than any `SameSite` value.
 */

/** One cookie, bound to the host that set it. */
interface StoredCookie {
	readonly name: string;
	readonly value: string;
	/** The exact hostname that sent this, lowercased. Never a suffix. */
	readonly host: string;
	readonly path: string;
	readonly secure: boolean;
	readonly httpOnly: boolean;
	/** Epoch ms, or null for a cookie that dies with the jar anyway. */
	readonly expiresAt: number | null;
	/** Insertion order, for the RFC's tie-break when two paths are equal. */
	readonly created: number;
}

/**
 * Bounds, so that a source cannot turn a session into a memory leak.
 *
 * These are memory limits and not policy, in the same sense as
 * `MAX_LEARNED_HOSTS` in `sandbox-host.ts`: being under them grants nothing,
 * and being over them costs a cookie rather than a refusal. Set where a real
 * session's worth of cookies is nowhere near them — a host that sets 50
 * cookies is doing something other than keeping a session.
 */
const MAX_COOKIES_PER_HOST = 50;
const MAX_HOSTS = 64;
const MAX_VALUE_BYTES = 8 * 1024;

/** Why one `Set-Cookie` was not stored. Diagnostic only; never a control flow. */
export interface CookieRefusal {
	readonly host: string;
	readonly name: string;
	readonly why: string;
}

export class CookieJar {
	/** host → name+path → cookie. Host first, because host is the hard boundary. */
	private readonly byHost = new Map<string, Map<string, StoredCookie>>();
	private sequence = 0;
	private readonly refusals: CookieRefusal[] = [];

	/**
	 * Takes the `Set-Cookie` headers one response sent.
	 *
	 * `url` is the URL of the **hop that sent them**, not the URL the caller
	 * originally asked for. A redirect chain sets cookies at each step and they
	 * belong to the step that set them; passing the first URL for all of them
	 * is exactly the cross-host bug this whole file exists to prevent.
	 */
	absorb(url: string | URL, headers: readonly string[]): void {
		let origin: URL;
		try {
			origin = url instanceof URL ? url : new URL(url);
		} catch {
			return;
		}
		// https-only is the relay's rule and this does not get to be the place
		// it is relaxed. A cookie arriving over anything else is not stored.
		if (origin.protocol !== 'https:') return;
		const host = origin.hostname.toLowerCase();

		for (const header of headers) {
			const parsed = parseSetCookie(header, origin);
			if (typeof parsed === 'string') {
				this.refuse(host, header, parsed);
				continue;
			}
			this.store(host, parsed);
		}
	}

	/**
	 * The `Cookie` header for this URL, or `''` when nothing applies.
	 *
	 * Only cookies set by this exact host, only those whose path matches, and
	 * only those that have not expired. Ordered as RFC 6265 §5.4 asks: longest
	 * path first, oldest first within a path.
	 */
	header(url: string | URL): string {
		let target: URL;
		try {
			target = url instanceof URL ? url : new URL(url);
		} catch {
			return '';
		}
		if (target.protocol !== 'https:') return '';

		const host = target.hostname.toLowerCase();
		const stored = this.byHost.get(host);
		if (stored === undefined) return '';

		const now = Date.now();
		const path = requestPath(target);
		const applicable: StoredCookie[] = [];
		for (const [key, cookie] of stored) {
			if (cookie.expiresAt !== null && cookie.expiresAt <= now) {
				stored.delete(key);
				continue;
			}
			if (!pathMatches(path, cookie.path)) continue;
			applicable.push(cookie);
		}
		if (stored.size === 0) this.byHost.delete(host);

		applicable.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
		return applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
	}

	/**
	 * Forgets everything.
	 *
	 * Called from `PluginSandbox.dispose()`, which is what makes "the jar does
	 * not survive a reload" true rather than merely intended: dropping the
	 * reference would be enough for the garbage collector, and is not enough
	 * for a reader auditing the lifetime.
	 */
	clear(): void {
		this.byHost.clear();
		this.refusals.length = 0;
		this.sequence = 0;
	}

	/** How many cookies are held, across every host. For logs and tests. */
	get size(): number {
		let total = 0;
		for (const stored of this.byHost.values()) total += stored.size;
		return total;
	}

	/**
	 * The `Set-Cookie` headers this jar declined, and why.
	 *
	 * Kept because a cookie that silently did not arrive is indistinguishable
	 * from a source that changed, which is the failure mode this repository
	 * spends most of its diagnostics on. Never read by control flow.
	 */
	get declined(): readonly CookieRefusal[] {
		return this.refusals;
	}

	private refuse(host: string, header: string, why: string): void {
		if (this.refusals.length >= 32) return;
		const name = header.slice(0, header.indexOf('=') === -1 ? 0 : header.indexOf('=')).trim();
		this.refusals.push({ host, name: name.length > 0 ? name : '(unnamed)', why });
	}

	private store(host: string, cookie: Omit<StoredCookie, 'host' | 'created'>): void {
		// A `Max-Age=0` or a past `Expires` is a deletion, which is the only way
		// a source has of clearing one. Honouring it costs nothing and not
		// honouring it means sending a cookie the host just told us to drop.
		const key = `${cookie.name} ${cookie.path}`;
		if (cookie.expiresAt !== null && cookie.expiresAt <= Date.now()) {
			const existing = this.byHost.get(host);
			existing?.delete(key);
			if (existing?.size === 0) this.byHost.delete(host);
			return;
		}

		let stored = this.byHost.get(host);
		if (stored === undefined) {
			if (this.byHost.size >= MAX_HOSTS) {
				this.refuse(host, cookie.name, 'this run has cookies for too many hosts already');
				return;
			}
			stored = new Map<string, StoredCookie>();
			this.byHost.set(host, stored);
		}
		if (!stored.has(key) && stored.size >= MAX_COOKIES_PER_HOST) {
			this.refuse(host, cookie.name, 'this host has set too many cookies in one run');
			return;
		}

		this.sequence += 1;
		stored.set(key, { ...cookie, host, created: this.sequence });
	}
}

/**
 * One `Set-Cookie` header as a cookie, or a sentence saying why not.
 *
 * A string return is a refusal. That shape rather than `null` because every
 * refusal here is one somebody will eventually have to explain to a person
 * looking at a source that does not play, and "it was dropped" is the answer
 * that wastes their afternoon.
 */
function parseSetCookie(
	header: string,
	origin: URL
): Omit<StoredCookie, 'host' | 'created'> | string {
	const [pair, ...rest] = header.split(';');
	const equals = pair.indexOf('=');
	// RFC 6265 §5.2: a set-cookie-string with no `=` in its name-value pair is
	// ignored. Not stored under an empty name, which is how a jar ends up with
	// a cookie no request can ever match.
	if (equals === -1) return 'no name=value pair';

	const name = pair.slice(0, equals).trim();
	const value = pair.slice(equals + 1).trim();
	if (name.length === 0) return 'an empty cookie name';
	if (value.length > MAX_VALUE_BYTES) return 'a value past the size cap';

	let path: string | null = null;
	let domain: string | null = null;
	let secure = false;
	let httpOnly = false;
	let expires: number | null = null;
	let maxAge: number | null = null;

	for (const attribute of rest) {
		const at = attribute.indexOf('=');
		const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
		const raw = at === -1 ? '' : attribute.slice(at + 1).trim();
		switch (key) {
			case 'path':
				// A `Path` that is not absolute is ignored and the default-path
				// used instead, which is the RFC's own answer and is narrower
				// than guessing what was meant.
				path = raw.startsWith('/') ? raw : null;
				break;
			case 'domain':
				domain = raw.replace(/^\./, '').toLowerCase();
				break;
			case 'secure':
				secure = true;
				break;
			case 'httponly':
				httpOnly = true;
				break;
			case 'expires': {
				const parsed = Date.parse(raw);
				if (!Number.isNaN(parsed)) expires = parsed;
				break;
			}
			case 'max-age': {
				// §5.2.2: a non-numeric Max-Age is ignored, not treated as zero.
				if (/^-?\d+$/.test(raw)) maxAge = Number(raw) * 1000 + Date.now();
				break;
			}
			default:
				// `SameSite`, `Partitioned`, `Priority` and whatever comes next.
				// None of them can widen host or path, which is the only thing
				// this jar is strict about, so ignoring them is safe by
				// construction rather than by review.
				break;
		}
	}

	const host = origin.hostname.toLowerCase();

	// The one place `Domain` is allowed to matter, and it only ever narrows.
	//
	// In a browser `Domain=example.invalid` set by `a.example.invalid` is sent
	// to `b.example.invalid` too. That is precisely the cross-host send ADR-0005
	// forbids, so a `Domain` covering the origin host is kept as the origin host
	// and nothing else. A `Domain` that does *not* cover the origin host is not
	// a narrowing question at all — it is a host trying to set a cookie for
	// somewhere it is not — and is refused, as RFC 6265 §5.3.6 also requires.
	if (domain !== null && domain !== host && !host.endsWith(`.${domain}`)) {
		return `a Domain of ${domain}, which is not ${host}`;
	}

	// RFC 6265bis §4.1.3. Cheap to honour, and a broken prefix is a
	// misconfiguration worth naming rather than quietly downgrading.
	if (name.startsWith('__Secure-') && !secure) return 'a __Secure- name without Secure';
	if (name.startsWith('__Host-')) {
		if (!secure) return 'a __Host- name without Secure';
		if (domain !== null) return 'a __Host- name with a Domain';
		if (path !== null && path !== '/') return 'a __Host- name with a Path other than /';
		path = '/';
	}

	return {
		name,
		value,
		path: path ?? defaultPath(origin),
		secure,
		httpOnly,
		// §5.2.2: Max-Age wins over Expires wherever both are present.
		expiresAt: maxAge ?? expires
	};
}

/**
 * RFC 6265 §5.1.4 default-path: the directory the request was in.
 *
 * Not `/`, which is what a jar that skipped this would use and is a widening:
 * a cookie set on `/a/b` would then ride along on every request to the host.
 */
function defaultPath(url: URL): string {
	const path = url.pathname;
	if (!path.startsWith('/')) return '/';
	const lastSlash = path.lastIndexOf('/');
	return lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
}

/** The request path a cookie's path is matched against. */
function requestPath(url: URL): string {
	return url.pathname.startsWith('/') ? url.pathname : '/';
}

/** RFC 6265 §5.1.4 path-match. `/a` covers `/a` and `/a/b`, never `/ab`. */
function pathMatches(requested: string, cookiePath: string): boolean {
	if (requested === cookiePath) return true;
	if (!requested.startsWith(cookiePath)) return false;
	return cookiePath.endsWith('/') || requested[cookiePath.length] === '/';
}

/**
 * The `Set-Cookie` headers of one response, however this runtime spells it.
 *
 * `Headers.getSetCookie()` is the only correct reader — `get('set-cookie')`
 * joins them with a comma, and `Expires=Wed, 01 Jan …` contains a comma, so
 * splitting the joined string back apart corrupts exactly the cookies that
 * carry an expiry. The fallback therefore does not split: a host old enough to
 * lack `getSetCookie` gets the single-cookie case right and does not invent a
 * second one.
 */
export function setCookiesOf(headers: Headers): string[] {
	const reader = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
	if (typeof reader === 'function') return reader.call(headers);
	const single = headers.get('set-cookie');
	return single === null ? [] : [single];
}
