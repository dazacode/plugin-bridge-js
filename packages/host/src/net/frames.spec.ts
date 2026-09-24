import { describe, expect, it } from 'vitest';

import { encodeFrame, FrameReader, MAX_FRAME_BYTES } from './frames';

/** Every byte value, twice, so both a value and its neighbour cross a chunk edge. */
const EVERY_BYTE = Uint8Array.from({ length: 512 }, (_, i) => i % 256);

/** Bytes that are not UTF-8: a lone continuation byte, an overlong form, 0xFF. */
const NOT_UTF8 = Uint8Array.of(0x00, 0x80, 0xc0, 0xaf, 0xff, 0xfe, 0x47, 0x00);

/** Feeds a byte stream through a reader in chunks of `size`, collecting messages. */
function readInChunks(bytes: Uint8Array, size: number): unknown[] {
	const reader = new FrameReader();
	const out: unknown[] = [];
	for (let at = 0; at < bytes.length; at += size)
		out.push(...reader.push(bytes.slice(at, at + size)));
	return out;
}

describe('a frame', () => {
	it('carries every byte value exactly, whatever size the chunks arrive in', () => {
		const frame = encodeFrame({ kind: 'served', body: EVERY_BYTE });
		for (const size of [1, 7, 256, frame.length]) {
			const [message] = readInChunks(frame, size) as [{ kind: string; body: Uint8Array }];
			expect(message.kind).toBe('served');
			expect(message.body).toBeInstanceOf(Uint8Array);
			expect(Array.from(message.body)).toEqual(Array.from(EVERY_BYTE));
		}
	});

	it('carries 0x00 and bytes that are not UTF-8 without replacing them', () => {
		// A body read as text would have turned 0x80, 0xC0 0xAF and 0xFF into
		// U+FFFD, and no decoder on the far side could get them back.
		const [message] = readInChunks(encodeFrame({ body: NOT_UTF8 }), 3) as [{ body: Uint8Array }];
		expect(Array.from(message.body)).toEqual(Array.from(NOT_UTF8));
	});

	it('writes a message with no bytes exactly as newline-delimited JSON always was', () => {
		// So a reader that predates frames still reads every message it could.
		const value = { id: 3, ok: true, value: { text: 'a\nb', n: [1, 2] } };
		expect(new TextDecoder().decode(encodeFrame(value))).toBe(`${JSON.stringify(value)}\n`);
		expect(readInChunks(encodeFrame(value), 2)).toEqual([value]);
	});

	it('keeps several byte fields apart, and the messages around them in order', () => {
		const stream = [
			encodeFrame({ n: 1 }),
			encodeFrame({
				n: 2,
				a: Uint8Array.of(10, 10),
				nested: { b: Uint8Array.of() },
				c: [Uint8Array.of(0)]
			}),
			encodeFrame({ n: 3 })
		];
		const joined = new Uint8Array(stream.reduce((sum, one) => sum + one.length, 0));
		let at = 0;
		for (const one of stream) {
			joined.set(one, at);
			at += one.length;
		}
		const messages = readInChunks(joined, 5) as Record<string, unknown>[];
		expect(messages.map((one) => one.n)).toEqual([1, 2, 3]);
		const second = messages[1] as { a: Uint8Array; nested: { b: Uint8Array }; c: Uint8Array[] };
		// A newline inside the carried bytes is data, not the end of a line.
		expect(Array.from(second.a)).toEqual([10, 10]);
		expect(second.nested.b.length).toBe(0);
		expect(Array.from(second.c[0])).toEqual([0]);
		expect('$binary' in second).toBe(false);
	});

	it('refuses a declared length that is not a non-negative integer, or over the limit', () => {
		const line = (lengths: unknown) =>
			new TextEncoder().encode(`${JSON.stringify({ body: { $bytes: 0 }, $binary: lengths })}\n`);
		expect(() => new FrameReader().push(line([-1]))).toThrow(/shape this reader refuses/);
		expect(() => new FrameReader().push(line([1.5]))).toThrow(/shape this reader refuses/);
		expect(() => new FrameReader().push(line([MAX_FRAME_BYTES + 1]))).toThrow(/over the/);
	});

	it('refuses a placeholder that names bytes the frame does not carry', () => {
		const forged = new TextEncoder().encode(
			`${JSON.stringify({ body: { $bytes: 4 }, $binary: [1] })}\nx`
		);
		expect(() => new FrameReader().push(forged)).toThrow(/does not carry/);
	});
});
