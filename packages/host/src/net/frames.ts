/**
 * Bytes beside JSON, without turning them into JSON.
 *
 * Two transports in this engine speak newline-delimited JSON: the headless
 * host's isolate, over a child process's stdio (`HOST.md` §3.2), and the relay's
 * reply to `sandbox-host.ts`. Both were written when every value crossing them
 * was text, and both carried a response body as a JSON string — which is exact
 * for a page and destroys a video segment: a body read as text has already
 * replaced every byte that is not valid UTF-8, so nothing downstream can get
 * the original back.
 *
 * A frame is the JSON line it always was, plus the bytes it carries, raw:
 *
 *     {"…", "$binary": [18432]}\n<18432 raw bytes>
 *
 * Each `Uint8Array` in the value is replaced by `{"$bytes": i}` and its bytes
 * follow the line in order; `$binary` lists their lengths so a reader knows
 * exactly how much to take before the next line starts. A value with no bytes
 * in it is written exactly as before — no `$binary`, no trailer — so a reader
 * that predates this still reads every message it could read before.
 *
 * **Not base64.** Encoding the bytes into the JSON would be the same mistake
 * one level up: a string standing in for bytes, a third larger, decoded on
 * the far side by code that has to agree about it. Here the bytes are the
 * bytes, and the only thing the JSON says about them is how many there are.
 *
 * Strict, because the far side of the child process runs plugin code: a length
 * that is not a non-negative integer, or a frame past `MAX_FRAME_BYTES`, is a
 * protocol error rather than something to guess at.
 */

/**
 * The most bytes one frame may carry.
 *
 * Above the largest served response a host accepts (`sandbox-host.ts`,
 * `MAX_SERVED_BYTES`) so that limit, which a viewer can meet, is the one that
 * speaks — this one is only the transport refusing to buffer without bound.
 */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

const NEWLINE = 0x0a;
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** The value with each Uint8Array swapped for a placeholder, and the bytes in order. */
function lift(value: unknown, into: Uint8Array[]): unknown {
	if (value instanceof Uint8Array) {
		into.push(value);
		return { $bytes: into.length - 1 };
	}
	if (Array.isArray(value)) return value.map((one) => lift(one, into));
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, one] of Object.entries(value)) out[key] = lift(one, into);
		return out;
	}
	return value;
}

/** The inverse of `lift`. A placeholder naming no carried bytes is refused. */
function lower(value: unknown, from: readonly Uint8Array[]): unknown {
	if (Array.isArray(value)) return value.map((one) => lower(one, from));
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length === 1 && keys[0] === '$bytes') {
			const index = record['$bytes'];
			if (typeof index !== 'number' || !Number.isInteger(index) || from[index] === undefined) {
				throw new Error('A frame names bytes it does not carry.');
			}
			return from[index];
		}
		const out: Record<string, unknown> = {};
		for (const [key, one] of Object.entries(record)) out[key] = lower(one, from);
		return out;
	}
	return value;
}

/** One message, as the bytes to write. */
export function encodeFrame(value: unknown): Uint8Array {
	const carried: Uint8Array[] = [];
	const lifted = lift(value, carried);
	if (carried.length === 0) return ENCODER.encode(`${JSON.stringify(lifted)}\n`);
	const lengths = carried.map((bytes) => bytes.length);
	const total = lengths.reduce((sum, one) => sum + one, 0);
	if (total > MAX_FRAME_BYTES) {
		throw new Error(`A frame of ${total} bytes is over the ${MAX_FRAME_BYTES}-byte limit.`);
	}
	if (lifted === null || typeof lifted !== 'object' || Array.isArray(lifted)) {
		throw new Error('Only an object can carry bytes in a frame.');
	}
	const line = ENCODER.encode(`${JSON.stringify({ ...lifted, $binary: lengths })}\n`);
	const out = new Uint8Array(line.length + total);
	out.set(line, 0);
	let at = line.length;
	for (const bytes of carried) {
		out.set(bytes, at);
		at += bytes.length;
	}
	return out;
}

/**
 * Reads frames out of a byte stream that arrives in arbitrary chunks.
 *
 * `push` takes whatever the transport delivered and returns every message it
 * completed, in order. A chunk may end mid-line or mid-trailer; nothing is
 * decoded until the whole frame is present, which is the difference between
 * this and splitting a utf8 string on newlines — a multi-byte character or a
 * raw byte split across two chunks is not a thing this has to think about.
 */
export class FrameReader {
	/**
	 * @param skipMalformed drop a line that is not JSON rather than throw. For
	 *   the host reading an isolate's stdout, where a runtime notice that escaped
	 *   stderr is noise, not a message; never for the isolate reading the host.
	 */
	private readonly skipMalformed: boolean;

	// A plain field, not a parameter property: the headless isolate imports
	// this file under node's strip-only TypeScript, which refuses that syntax.
	constructor(skipMalformed = false) {
		this.skipMalformed = skipMalformed;
	}

	private buffer = new Uint8Array(0);
	/** The parsed line of a frame whose trailer has not all arrived yet. */
	private waiting: { value: Record<string, unknown>; lengths: number[]; total: number } | null =
		null;

	push(chunk: Uint8Array): unknown[] {
		const joined = new Uint8Array(this.buffer.length + chunk.length);
		joined.set(this.buffer, 0);
		joined.set(chunk, this.buffer.length);
		this.buffer = joined;

		const out: unknown[] = [];
		for (;;) {
			if (this.waiting !== null) {
				if (this.buffer.length < this.waiting.total) break;
				const carried: Uint8Array[] = [];
				let at = 0;
				for (const length of this.waiting.lengths) {
					carried.push(this.buffer.slice(at, at + length));
					at += length;
				}
				this.buffer = this.buffer.slice(at);
				const { $binary: _lengths, ...rest } = this.waiting.value;
				this.waiting = null;
				out.push(lower(rest, carried));
				continue;
			}
			const newline = this.buffer.indexOf(NEWLINE);
			if (newline === -1) break;
			const line = DECODER.decode(this.buffer.subarray(0, newline)).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch (error) {
				if (this.skipMalformed) continue;
				throw error;
			}
			const lengths =
				value !== null && typeof value === 'object' && !Array.isArray(value)
					? (value as Record<string, unknown>)['$binary']
					: undefined;
			if (lengths === undefined) {
				out.push(value);
				continue;
			}
			if (
				!Array.isArray(lengths) ||
				lengths.some((one) => typeof one !== 'number' || !Number.isInteger(one) || one < 0)
			) {
				throw new Error('A frame declared its byte lengths in a shape this reader refuses.');
			}
			const total = (lengths as number[]).reduce((sum, one) => sum + one, 0);
			if (total > MAX_FRAME_BYTES) {
				throw new Error(`A frame of ${total} bytes is over the ${MAX_FRAME_BYTES}-byte limit.`);
			}
			this.waiting = {
				value: value as Record<string, unknown>,
				lengths: lengths as number[],
				total
			};
		}
		return out;
	}
}
