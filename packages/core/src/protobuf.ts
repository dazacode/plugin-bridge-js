/**
 * A protobuf wire-format reader, for indexes that are published as protobuf.
 *
 * One ecosystem's repository index is a gzipped protobuf rather than JSON, and
 * this is the smallest thing that can read it honestly. It is a **wire**
 * reader, not a schema compiler: it walks tag/value pairs and hands them back
 * by field number, and the adapter that knows the schema names the fields.
 *
 * ## Why not a generated decoder
 *
 * The schema is published by the catalogue, so generating one is possible. It
 * is not done, for the reason `ADR-0004` gives about generated artifacts
 * generally: a committed decoder is a fact about the schema *on the day it was
 * generated*, and this one is a fork of an upstream that is still moving. A
 * wire reader cannot go stale, because it does not know anything to be wrong
 * about — an added field is a field nobody asks for, and a renumbered one
 * fails loudly at the adapter, where somebody is reading the schema anyway.
 *
 * It is also 200 lines against a dependency, and `docs/security.md` is why that
 * trade keeps going this way.
 *
 * ## Varints are read as `bigint`, and that is not caution
 *
 * Source identity in that index is an `int64`, and the values really do exceed
 * `Number.MAX_SAFE_INTEGER` — reading them as JavaScript numbers silently
 * rounds, and two distinct sources can round to the same id. An id that
 * collides is a `SourceBinding` pointing at the wrong source (rule 1), so the
 * rounding would surface as somebody's library breaking rather than as a parse
 * error. `varint()` therefore returns `bigint`, and callers that want a small
 * number ask for one explicitly with `int()`.
 *
 * ## What it refuses
 *
 * Groups (wire types 3 and 4) are removed from the language and are refused
 * rather than skipped, because skipping one means guessing where it ends.
 * Truncated input is refused rather than returning what was read so far: a
 * half-read index is a catalogue that is quietly missing its tail, which is
 * exactly the failure `FOREIGN.md` §6 exists to prevent.
 */

/** Refused input. Carries no position, because a byte offset helps nobody. */
export class ProtobufError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ProtobufError';
	}
}

/**
 * The ceiling on one decompressed index.
 *
 * Matches `zip.ts`'s reasoning and not its number: an index is text-shaped and
 * a catalogue of a few thousand listings decompresses to under a megabyte, so
 * 32 MB is several orders of headroom and still a bound. A gzip member that
 * claims more is refused before it is written anywhere.
 */
export const MAX_INDEX_BYTES = 32 * 1024 * 1024;

/** A varint, at most ten bytes. Anything longer is not an `int64`. */
function readVarint(bytes: Uint8Array, start: number): readonly [bigint, number] {
	let result = 0n;
	let shift = 0n;
	let at = start;
	for (let count = 0; count < 10; count += 1) {
		if (at >= bytes.length) throw new ProtobufError('Truncated varint.');
		const byte = bytes[at];
		at += 1;
		result |= BigInt(byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [result, at];
		shift += 7n;
	}
	throw new ProtobufError('Varint longer than ten bytes.');
}

interface Field {
	readonly wire: number;
	readonly varint: bigint;
	readonly bytes: Uint8Array;
}

/**
 * One parsed message: field number to the values that appeared under it.
 *
 * Repeated fields are the reason this is a list rather than a value. A field
 * that is *not* repeated in the schema may still appear twice on the wire, and
 * protobuf's rule is that the last one wins — which is what the singular
 * accessors implement, rather than refusing, because refusing would reject
 * input the publisher's own reader accepts.
 */
export class ProtoMessage {
	private constructor(private readonly fields: ReadonlyMap<number, readonly Field[]>) {}

	static parse(bytes: Uint8Array): ProtoMessage {
		const fields = new Map<number, Field[]>();
		let at = 0;
		while (at < bytes.length) {
			const [tag, afterTag] = readVarint(bytes, at);
			at = afterTag;
			const number = Number(tag >> 3n);
			const wire = Number(tag & 7n);
			if (number === 0) throw new ProtobufError('Field number 0 is not valid.');

			let field: Field;
			if (wire === 0) {
				const [value, next] = readVarint(bytes, at);
				at = next;
				field = { wire, varint: value, bytes: EMPTY };
			} else if (wire === 2) {
				const [length, afterLength] = readVarint(bytes, at);
				const size = Number(length);
				if (afterLength + size > bytes.length) {
					throw new ProtobufError('Length-delimited field runs past the end.');
				}
				field = { wire, varint: 0n, bytes: bytes.subarray(afterLength, afterLength + size) };
				at = afterLength + size;
			} else if (wire === 5 || wire === 1) {
				const size = wire === 5 ? 4 : 8;
				if (at + size > bytes.length)
					throw new ProtobufError('Fixed-width field runs past the end.');
				field = { wire, varint: 0n, bytes: bytes.subarray(at, at + size) };
				at += size;
			} else {
				// 3 and 4 are start-group and end-group, removed from the language.
				// Skipping one means guessing where it ends, so it is refused.
				throw new ProtobufError(`Unsupported wire type ${wire}.`);
			}

			const existing = fields.get(number);
			if (existing === undefined) fields.set(number, [field]);
			else existing.push(field);
		}
		return new ProtoMessage(fields);
	}

	/** Every value that appeared under this field number, in wire order. */
	private all(number: number): readonly Field[] {
		return this.fields.get(number) ?? [];
	}

	has(number: number): boolean {
		return this.fields.has(number);
	}

	/** The last varint under this field, or undefined. `bigint` — see the header. */
	varint(number: number): bigint | undefined {
		const values = this.all(number).filter((field) => field.wire === 0);
		return values.length === 0 ? undefined : values[values.length - 1].varint;
	}

	/**
	 * The same value as a `number`, refused rather than rounded if it will not fit.
	 *
	 * For the fields that are genuinely small — an enum, a version code — where
	 * carrying a `bigint` around would be noise.
	 */
	int(number: number): number | undefined {
		const value = this.varint(number);
		if (value === undefined) return undefined;
		if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new ProtobufError(`Field ${number} does not fit in a JavaScript number.`);
		}
		return Number(value);
	}

	bytes(number: number): Uint8Array | undefined {
		const values = this.all(number).filter((field) => field.wire === 2);
		return values.length === 0 ? undefined : values[values.length - 1].bytes;
	}

	/**
	 * The last string under this field.
	 *
	 * Decoded strictly: protobuf says a `string` is UTF-8, and a fatal decoder
	 * turns a mis-declared `bytes` field into a refusal rather than into a name
	 * full of replacement characters that somebody then sees in a list.
	 */
	string(number: number): string | undefined {
		const raw = this.bytes(number);
		if (raw === undefined) return undefined;
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(raw);
		} catch {
			throw new ProtobufError(`Field ${number} is not valid UTF-8.`);
		}
	}

	/** Every string under this field, for a `repeated string`. */
	strings(number: number): readonly string[] {
		const out: string[] = [];
		for (const field of this.all(number)) {
			if (field.wire !== 2) continue;
			try {
				out.push(new TextDecoder('utf-8', { fatal: true }).decode(field.bytes));
			} catch {
				throw new ProtobufError(`Field ${number} is not valid UTF-8.`);
			}
		}
		return out;
	}

	message(number: number): ProtoMessage | undefined {
		const raw = this.bytes(number);
		return raw === undefined ? undefined : ProtoMessage.parse(raw);
	}

	/** Every submessage under this field, for a `repeated` message. */
	messages(number: number): readonly ProtoMessage[] {
		return this.all(number)
			.filter((field) => field.wire === 2)
			.map((field) => ProtoMessage.parse(field.bytes));
	}
}

const EMPTY = new Uint8Array(0);

/**
 * Whether these bytes are a gzip member.
 *
 * Sniffed rather than decided from the URL, because the published index is
 * served under a name that says nothing about its encoding, and a fetch layer
 * that transparently decompressed it would hand us the same bytes without the
 * header. Both have to work.
 */
export function isGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Gunzip, over `DecompressionStream`, bounded.
 *
 * `zip.ts` established that the platform's own decompressor is the one to use —
 * it is native in every browser this client supports and in Node, so no
 * inflater is bundled and rule 13's surface does not grow. The bound is checked
 * while reading rather than after, so a zip bomb is refused before it is held.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'));
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > MAX_INDEX_BYTES) {
			await reader.cancel();
			throw new ProtobufError('Compressed index expands past the size limit.');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
}
