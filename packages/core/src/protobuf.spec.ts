/**
 * The wire reader, tested against bytes this file builds.
 *
 * Every message here is encoded by `encode()` below rather than captured from a
 * published index, for two reasons. Rule 9: a captured index is a file full of
 * content-source hostnames, and it would live in the repository forever. And a
 * captured fixture only ever proves the shape it happened to contain — the
 * cases worth testing are the malformed ones, which no publisher emits.
 */

import { describe, expect, it } from 'vitest';

import { gunzip, isGzip, ProtobufError, ProtoMessage } from './protobuf';

/** Minimal encoder, so a test can state its input as values. */
function varint(value: bigint): number[] {
	const out: number[] = [];
	let rest = value;
	for (;;) {
		const byte = Number(rest & 0x7fn);
		rest >>= 7n;
		if (rest === 0n) {
			out.push(byte);
			return out;
		}
		out.push(byte | 0x80);
	}
}

function tag(field: number, wire: number): number[] {
	return varint((BigInt(field) << 3n) | BigInt(wire));
}

function encodeVarint(field: number, value: bigint | number): number[] {
	return [...tag(field, 0), ...varint(BigInt(value))];
}

function encodeBytes(field: number, body: Uint8Array | number[]): number[] {
	const bytes = Array.from(body);
	return [...tag(field, 2), ...varint(BigInt(bytes.length)), ...bytes];
}

function encodeString(field: number, value: string): number[] {
	return encodeBytes(field, Array.from(new TextEncoder().encode(value)));
}

function bytes(...parts: number[][]): Uint8Array {
	return new Uint8Array(parts.flat());
}

describe('ProtoMessage', () => {
	it('reads scalars by field number', () => {
		const message = ProtoMessage.parse(
			bytes(encodeString(1, 'a name'), encodeVarint(7, 3), encodeString(2, 'ABC'))
		);
		expect(message.string(1)).toBe('a name');
		expect(message.int(7)).toBe(3);
		expect(message.string(2)).toBe('ABC');
	});

	it('answers undefined for a field that is absent, and says so via has()', () => {
		const message = ProtoMessage.parse(bytes(encodeString(1, 'present')));
		expect(message.has(1)).toBe(true);
		expect(message.has(2)).toBe(false);
		expect(message.string(2)).toBeUndefined();
		expect(message.int(2)).toBeUndefined();
		expect(message.message(2)).toBeUndefined();
		expect(message.messages(2)).toEqual([]);
		expect(message.strings(2)).toEqual([]);
	});

	it('keeps an int64 exactly, where a JavaScript number would round it', () => {
		// The value is a real shape: a source id past 2^53. Read as a number it
		// becomes …3316000, and two distinct sources can land on one id.
		const id = 6289731484943315811n;
		const message = ProtoMessage.parse(bytes(encodeVarint(1, id)));
		expect(message.varint(1)).toBe(id);
		// The rounding this avoids, stated so it cannot be argued with: the
		// value does not survive a trip through a JavaScript number.
		expect(BigInt(Number(id))).not.toBe(id);
		expect(BigInt(Number(id))).toBe(6289731484943315968n);
	});

	it('refuses int() rather than rounding a value that will not fit', () => {
		const message = ProtoMessage.parse(bytes(encodeVarint(1, 6289731484943315811n)));
		expect(() => message.int(1)).toThrow(ProtobufError);
	});

	it('reads a repeated message, in wire order', () => {
		const one = bytes(encodeString(2, 'first'), encodeString(3, 'en'));
		const two = bytes(encodeString(2, 'second'), encodeString(3, 'ja'));
		const message = ProtoMessage.parse(bytes(encodeBytes(8, one), encodeBytes(8, two)));

		const sources = message.messages(8);
		expect(sources).toHaveLength(2);
		expect(sources.map((source) => source.string(2))).toEqual(['first', 'second']);
		expect(sources.map((source) => source.string(3))).toEqual(['en', 'ja']);
	});

	it('reads a repeated string', () => {
		const message = ProtoMessage.parse(
			bytes(
				encodeString(5, 'https://example.invalid/'),
				encodeString(5, 'https://mirror.example.invalid/')
			)
		);
		expect(message.strings(5)).toEqual([
			'https://example.invalid/',
			'https://mirror.example.invalid/'
		]);
	});

	it('takes the last value when a singular field appears twice', () => {
		// protobuf's own rule. Refusing would reject input the publisher's
		// reader accepts, which is a worse failure than the duplicate.
		const message = ProtoMessage.parse(bytes(encodeString(1, 'first'), encodeString(1, 'second')));
		expect(message.string(1)).toBe('second');
	});

	it('reads a large field number, as a schema divergence uses', () => {
		// One catalogue's divergence from its upstream sits at field 501.
		const message = ProtoMessage.parse(bytes(encodeString(501, 'https://example.invalid/a.jar')));
		expect(message.string(501)).toBe('https://example.invalid/a.jar');
	});

	it('skips a fixed-width field without losing its place', () => {
		const message = ProtoMessage.parse(
			bytes(tag(4, 5), [1, 2, 3, 4], tag(5, 1), [1, 2, 3, 4, 5, 6, 7, 8], encodeString(6, 'after'))
		);
		expect(message.string(6)).toBe('after');
	});

	describe('refusals', () => {
		it('refuses a group rather than guessing where it ends', () => {
			expect(() => ProtoMessage.parse(bytes(tag(1, 3)))).toThrow(/wire type 3/);
		});

		it('refuses a length that runs past the end', () => {
			expect(() => ProtoMessage.parse(bytes(tag(1, 2), varint(64n), [1, 2, 3]))).toThrow(
				/past the end/
			);
		});

		it('refuses a truncated varint', () => {
			expect(() => ProtoMessage.parse(bytes(tag(1, 0), [0x80, 0x80]))).toThrow(/Truncated/);
		});

		it('refuses a varint longer than ten bytes', () => {
			expect(() => ProtoMessage.parse(bytes(tag(1, 0), [...Array(11).fill(0x80), 0x01]))).toThrow(
				/ten bytes/
			);
		});

		it('refuses field number zero', () => {
			expect(() => ProtoMessage.parse(bytes([0x00, 0x00]))).toThrow(/Field number 0/);
		});

		it('refuses a string that is not UTF-8, rather than showing replacement characters', () => {
			const message = ProtoMessage.parse(bytes(encodeBytes(1, [0xff, 0xfe, 0xfd])));
			expect(() => message.string(1)).toThrow(/UTF-8/);
			expect(() => message.strings(1)).toThrow(/UTF-8/);
		});
	});
});

describe('gzip', () => {
	it('sniffs the header rather than trusting a name', async () => {
		const plain = bytes(encodeString(1, 'a name'));
		expect(isGzip(plain)).toBe(false);

		const compressed = new Uint8Array(
			await new Response(
				new Blob([plain as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
			).arrayBuffer()
		);
		expect(isGzip(compressed)).toBe(true);
		expect(ProtoMessage.parse(await gunzip(compressed)).string(1)).toBe('a name');
	});

	it('sniffs an empty input without reading past it', () => {
		expect(isGzip(new Uint8Array(0))).toBe(false);
		expect(isGzip(new Uint8Array([0x1f]))).toBe(false);
	});
});
