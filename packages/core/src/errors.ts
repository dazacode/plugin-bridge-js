/**
 * The failures the plugin runtime raises, and the base every failure shares.
 *
 * These used to live in `$lib/domain/failures.ts` with the app's own, and were
 * three of the nine imports that reached out of this directory. The dependency
 * now points the other way: the runtime declares the failures it throws, and
 * `$lib/domain` re-exports them, so every existing `import { NetworkFailure }
 * from '$lib/domain'` in the app still resolves to *this* class. One class
 * object, so `instanceof` keeps working across the seam — which matters,
 * because the screens branch on it.
 *
 * ## Where the line between the two files is
 *
 * Here: what a **source** does to you. It could not be reached
 * (`NetworkFailure`), it does not have the thing (`NotFoundFailure`), or the
 * request itself is one this host refuses to make (`ValidationFailure`).
 * A host running only the runtime — a headless conversion harness, say — needs
 * exactly these three and nothing else.
 *
 * Still in `domain/failures.ts`: what the **app** does to itself. A payload
 * that changed shape, a build that cannot perform a legitimate operation, a
 * caller that went away, a local database that will not open. None of those
 * are things a plugin can cause, and moving them here would put a database
 * error inside the compatibility layer.
 *
 * The base class comes with the three because a taxonomy split across two
 * files still has to be one taxonomy — `code` and `isRetryable` are read by
 * screens that do not know or care which half a failure came from.
 */

/** Base type for every recoverable failure the app knows how to talk about. */
export abstract class KuroFailure extends Error {
	/** The underlying error this failure was translated from, if any. */
	readonly cause?: unknown;

	protected constructor(message: string, cause?: unknown) {
		super(message);
		this.name = new.target.name;
		this.cause = cause;
	}

	/**
	 * A stable, loggable name for this failure kind.
	 *
	 * Rather than the class name, for the same reason it is on the Dart side: a
	 * bundled build minifies class names, and a bug report is the one place the
	 * name matters.
	 */
	abstract readonly code: string;

	/** Whether retrying the same call could plausibly succeed. */
	abstract readonly isRetryable: boolean;

	override toString(): string {
		return `KuroFailure(${this.code}): ${this.message}`;
	}
}

/** The request could not reach the other side, or came back as a transport error. */
export class NetworkFailure extends KuroFailure {
	readonly code = 'network';
	readonly isRetryable = true;
	readonly statusCode?: number;
	readonly isTimeout: boolean;

	constructor(
		message: string,
		options: { cause?: unknown; statusCode?: number; isTimeout?: boolean } = {}
	) {
		super(message, options.cause);
		this.statusCode = options.statusCode;
		this.isTimeout = options.isTimeout ?? false;
	}

	/** Whether the remote asked us to slow down (HTTP 429). */
	get isRateLimited(): boolean {
		return this.statusCode === 429;
	}
}

/** The thing asked for does not exist. Distinct from an empty list. */
export class NotFoundFailure extends KuroFailure {
	readonly code = 'notFound';
	readonly isRetryable = false;
	/** Stable identifier of what was missing, e.g. `local:sable-line`. */
	readonly resource?: string;

	constructor(message: string, options: { cause?: unknown; resource?: string } = {}) {
		super(message, options.cause);
		this.resource = options.resource;
	}
}

/**
 * What the viewer asked for is not acceptable, and repeating it will not help.
 *
 * Mirrors `ValidationFailure` in `lib/domain/failures/kuro_failure.dart`, and
 * is distinct from its neighbours in a way that matters at the call site:
 * `ParseFailure` is *the other side* changing shape, `NotFoundFailure` is the
 * other side not having a thing, `UnsupportedFailure` is *this build* being
 * unable to do something legitimate — and this is the **request itself** being
 * refused: a repository URL that is not https, a download larger than a plugin
 * may be, an archive signed by a key the repository was not pinned to, a host
 * a plugin never declared.
 *
 * Unlike its siblings, `message` here **is** meant for the viewer. Every site
 * that throws one writes a sentence a person can act on, because carrying that
 * sentence out of the security layer is the whole value of the class.
 */
export class ValidationFailure extends KuroFailure {
	readonly code = 'validation';
	readonly isRetryable = false;

	constructor(message: string, options: { cause?: unknown } = {}) {
		super(message, options.cause);
	}
}
