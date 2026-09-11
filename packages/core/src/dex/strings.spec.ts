/**
 * Every fixture here is *built*, byte by byte, a few lines above the test that
 * uses it. None is a real file.
 *
 * That is rule 9 first — no APK is downloaded, so no content source can be
 * named by one — but it is also the only way to write the half of this suite
 * that matters. The interesting inputs for a parser on a security boundary are
 * the ones a compiler will never emit: a header claiming four million strings,
 * an offset one byte past the end, a length that disagrees with its own
 * terminator. A builder with a `patch` hook produces those exactly, and a
 * checked-in binary never would.
 */

import { describe, expect, it } from 'vitest';

import { DexError, readDexStrings, readDexTypes } from './strings';

/** Header field offsets, repeated here so a test can corrupt one by name. */
const HEADER_BYTES = 112;
const ENDIAN_TAG = 40;
const STRING_IDS_SIZE = 56;
const STRING_IDS_OFF = 60;
const TYPE_IDS_SIZE = 64;
const TYPE_IDS_OFF = 68;
const CLASS_DEFS_SIZE = 96;
const CLASS_DEFS_OFF = 100;

interface DexShape {
	/** Strings to lay out, MUTF-8 encoded by the helper below. */
	readonly strings?: readonly string[];
	/** Or raw `string_data_item` blobs, for the malformed cases. */
	readonly blobs?: readonly number[][];
	/** `type_ids`, as indices into the string pool. */
	readonly types?: readonly number[];
	/** `class_defs`, as indices into `type_ids`. */
	readonly classes?: readonly number[];
	/** u32s written last, by absolute byte offset. The hostile-input lever. */
	readonly patch?: Readonly<Record<number, number>>;
	/** Cut the finished file down to this many bytes. */
	readonly truncateTo?: number;
}

/**
 * MUTF-8, written out by hand so the tests can assert on the encoding itself.
 *
 * U+0000 takes the two-byte form, and a supplementary character comes out as
 * its two surrogates because the loop walks UTF-16 code units and each one
 * lands in the three-byte branch.
 */
function encodeMutf8(text: string): number[] {
	const out: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		if (unit !== 0 && unit < 0x80) {
			out.push(unit);
		} else if (unit < 0x800) {
			out.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
		} else {
			out.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
		}
	}
	return out;
}

function uleb128(value: number): number[] {
	const out: number[] = [];
	let rest = value;
	do {
		const byte = rest & 0x7f;
		rest >>>= 7;
		out.push(rest === 0 ? byte : byte | 0x80);
	} while (rest !== 0);
	return out;
}

/** One `string_data_item`: ULEB128 UTF-16 length, MUTF-8 bytes, NUL. */
function stringData(text: string): number[] {
	return [...uleb128(text.length), ...encodeMutf8(text), 0];
}

/**
 * A whole synthetic dex: header, then the three tables this reader walks, then
 * the string data they point at. Everything else a real file carries — protos,
 * fields, methods, the map list, any code at all — is absent, because the
 * reader never looks for it.
 */
function buildDex(shape: DexShape = {}): Uint8Array {
	const blobs = shape.blobs ?? (shape.strings ?? []).map((text) => stringData(text));
	const types = shape.types ?? [];
	const classes = shape.classes ?? [];

	const stringIdsOff = HEADER_BYTES;
	const typeIdsOff = stringIdsOff + blobs.length * 4;
	const classDefsOff = typeIdsOff + types.length * 4;
	const dataOff = classDefsOff + classes.length * 32;
	const total = blobs.reduce((sum, blob) => sum + blob.length, dataOff);

	const bytes = new Uint8Array(total);
	const view = new DataView(bytes.buffer);
	// `dex\n035\0`
	bytes.set([0x64, 0x65, 0x78, 0x0a, 0x30, 0x33, 0x35, 0x00], 0);
	view.setUint32(32, total, true);
	view.setUint32(36, HEADER_BYTES, true);
	view.setUint32(ENDIAN_TAG, 0x12345678, true);

	view.setUint32(STRING_IDS_SIZE, blobs.length, true);
	view.setUint32(STRING_IDS_OFF, blobs.length === 0 ? 0 : stringIdsOff, true);
	view.setUint32(TYPE_IDS_SIZE, types.length, true);
	view.setUint32(TYPE_IDS_OFF, types.length === 0 ? 0 : typeIdsOff, true);
	view.setUint32(CLASS_DEFS_SIZE, classes.length, true);
	view.setUint32(CLASS_DEFS_OFF, classes.length === 0 ? 0 : classDefsOff, true);

	let cursor = dataOff;
	blobs.forEach((blob, index) => {
		view.setUint32(stringIdsOff + index * 4, cursor, true);
		bytes.set(blob, cursor);
		cursor += blob.length;
	});
	types.forEach((stringIndex, index) => {
		view.setUint32(typeIdsOff + index * 4, stringIndex, true);
	});
	classes.forEach((typeIndex, index) => {
		view.setUint32(classDefsOff + index * 32, typeIndex, true);
	});

	for (const [offset, value] of Object.entries(shape.patch ?? {})) {
		view.setUint32(Number(offset), value, true);
	}

	return shape.truncateTo === undefined ? bytes : bytes.subarray(0, shape.truncateTo);
}

describe('readDexStrings', () => {
	it('round-trips a pool of constants in string_ids order', () => {
		const pool = [
			'Lorg/example/BaseSkin;',
			'Lorg/example/Generated;',
			'Ljava/lang/String;',
			'div.entry > a.title',
			'/api/v1/list/%s/page/%d'
		];

		expect(readDexStrings(buildDex({ strings: pool }))).toEqual(pool);
	});

	it('reads an empty pool as an empty pool', () => {
		expect(readDexStrings(buildDex())).toEqual([]);
	});

	it('decodes the two-byte MUTF-8 spelling of U+0000', () => {
		const withNul = 'a\u0000b';
		const blob = stringData(withNul);

		// The encoding under test, asserted directly: three UTF-16 units, then
		// `61 C0 80 62`, then the terminator.
		expect(blob).toEqual([3, 0x61, 0xc0, 0x80, 0x62, 0x00]);
		expect(readDexStrings(buildDex({ strings: [withNul] }))).toEqual([withNul]);

		// And the reason this reader does not hand its bytes to TextDecoder: a
		// conforming UTF-8 decoder does not fail on `C0 80`, it quietly returns
		// a different string.
		const naive = new TextDecoder().decode(new Uint8Array(blob.slice(1, blob.length - 1)));
		expect(naive).not.toBe(withNul);
	});

	it('reassembles a supplementary character from its two surrogates', () => {
		const supplementary = '\u{1F600} tag';
		const blob = stringData(supplementary);

		// Six bytes for one character — two three-byte surrogates — not four.
		expect(blob[0]).toBe(6);
		expect(blob.slice(1, 7)).toEqual([0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]);
		expect(readDexStrings(buildDex({ strings: [supplementary] }))).toEqual([supplementary]);
	});

	it('refuses a file too short to hold a header', () => {
		expect(() => readDexStrings(buildDex({ strings: ['x'], truncateTo: 40 }))).toThrow(DexError);
		expect(() => readDexStrings(new Uint8Array(0))).toThrow(/header alone is 112/);
	});

	it('refuses a file that is not a dex file', () => {
		const notDex = buildDex({ strings: ['x'] });
		notDex[1] = 0x41;

		expect(() => readDexStrings(notDex)).toThrow(/not a dex file/);
	});

	it('refuses a byte-swapped file by name rather than misreading it', () => {
		const swapped = buildDex({
			strings: ['x'],
			patch: { [ENDIAN_TAG]: 0x78563412 }
		});

		expect(() => readDexStrings(swapped)).toThrow(/byte-swapped/);
	});

	it('refuses a string table offset past the end of the buffer', () => {
		const past = buildDex({
			strings: ['x'],
			patch: { [STRING_IDS_OFF]: 0xfffffff0 }
		});

		expect(() => readDexStrings(past)).toThrow(/too small to hold them/);
	});

	it('refuses an absurd declared string count before reading anything', () => {
		const absurd = buildDex({
			strings: ['x'],
			patch: { [STRING_IDS_SIZE]: 4_000_000 }
		});

		expect(() => readDexStrings(absurd)).toThrow(/declares 4000000 strings/);
	});

	it('refuses a plausible count the file has no room for', () => {
		const overclaimed = buildDex({
			strings: ['x'],
			patch: { [STRING_IDS_SIZE]: 50_000 }
		});

		expect(() => readDexStrings(overclaimed)).toThrow(/string table claims 50000 entries/);
	});

	it('refuses a string whose data offset is outside the file', () => {
		// Byte 112 is the first `string_ids` entry, immediately after the header.
		const strayed = buildDex({
			strings: ['x'],
			patch: { [HEADER_BYTES]: 0x7fffffff }
		});

		expect(() => readDexStrings(strayed)).toThrow(/not inside this file/);
	});

	it('refuses a string whose data offset points back into the header', () => {
		const overlapping = buildDex({
			strings: ['x'],
			patch: { [HEADER_BYTES]: 8 }
		});

		expect(() => readDexStrings(overlapping)).toThrow(/not inside this file/);
	});

	it('refuses a string truncated by the end of the file', () => {
		const whole = buildDex({ strings: ['a long enough constant'] });

		expect(() => readDexStrings(whole.subarray(0, whole.length - 6))).toThrow(
			/runs past the end of the file/
		);
	});

	it('refuses a declared length longer than the bytes that follow', () => {
		// Claims nine code units, supplies three and then the terminator.
		const lying = buildDex({ blobs: [[9, 0x61, 0x62, 0x63, 0x00]] });

		expect(() => readDexStrings(lying)).toThrow(/ends before the 9 characters/);
	});

	it('refuses a string with no terminator', () => {
		const unterminated = buildDex({ blobs: [[3, 0x61, 0x62, 0x63]] });

		expect(() => readDexStrings(unterminated)).toThrow(/not terminated/);
	});

	it('refuses a byte that cannot begin a MUTF-8 character', () => {
		// 0xF0 opens a four-byte UTF-8 sequence, which MUTF-8 does not have.
		const fourByte = buildDex({ blobs: [[1, 0xf0, 0x9f, 0x98, 0x80, 0x00]] });

		expect(() => readDexStrings(fourByte)).toThrow(/cannot start a character/);
	});

	it('refuses a character cut short of its continuation bytes', () => {
		const clipped = buildDex({ blobs: [[2, 0xe3, 0x81, 0x61, 0x00]] });

		expect(() => readDexStrings(clipped)).toThrow(/cut short/);
	});

	it('refuses a length that never stops being a length', () => {
		const runaway = buildDex({
			blobs: [[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]]
		});

		expect(() => readDexStrings(runaway)).toThrow(/not a number/);
	});
});

describe('readDexTypes', () => {
	const POOL = [
		'Lorg/example/BaseSkin;',
		'Lorg/example/Generated;',
		'Ljava/lang/String;',
		'div.entry > a.title'
	];

	it('separates what the file defines from what it only references', () => {
		// Three descriptors named; the second is the one `class_defs` defines.
		const dex = buildDex({ strings: POOL, types: [0, 1, 2], classes: [1] });

		expect(readDexTypes(dex)).toEqual({
			defined: ['Lorg/example/Generated;'],
			referenced: ['Lorg/example/BaseSkin;', 'Ljava/lang/String;']
		});
	});

	it('reads a file with no classes as all references', () => {
		const dex = buildDex({ strings: POOL, types: [0, 2] });

		expect(readDexTypes(dex)).toEqual({
			defined: [],
			referenced: ['Lorg/example/BaseSkin;', 'Ljava/lang/String;']
		});
	});

	it('de-duplicates a type table that repeats itself', () => {
		const dex = buildDex({ strings: POOL, types: [0, 0, 2] });

		expect(readDexTypes(dex).referenced).toEqual(['Lorg/example/BaseSkin;', 'Ljava/lang/String;']);
	});

	it('refuses a type that names a string the file does not have', () => {
		const dex = buildDex({ strings: POOL, types: [0, 99] });

		expect(() => readDexTypes(dex)).toThrow(/names string 99/);
	});

	it('refuses a class that names a type the file does not have', () => {
		const dex = buildDex({ strings: POOL, types: [0], classes: [7] });

		expect(() => readDexTypes(dex)).toThrow(/names type 7/);
	});

	it('refuses a type table the file has no room for', () => {
		const dex = buildDex({
			strings: POOL,
			types: [0],
			patch: { [TYPE_IDS_SIZE]: 20_000 }
		});

		expect(() => readDexTypes(dex)).toThrow(/type table claims 20000 entries/);
	});

	it('refuses an absurd declared type count', () => {
		const dex = buildDex({
			strings: POOL,
			types: [0],
			patch: { [TYPE_IDS_SIZE]: 1_000_000 }
		});

		expect(() => readDexTypes(dex)).toThrow(/declares 1000000 types/);
	});

	it('refuses a class table the file has no room for', () => {
		const dex = buildDex({
			strings: POOL,
			types: [0],
			classes: [0],
			patch: { [CLASS_DEFS_SIZE]: 4_096 }
		});

		expect(() => readDexTypes(dex)).toThrow(/class table claims 4096 entries/);
	});
});
