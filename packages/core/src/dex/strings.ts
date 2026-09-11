/**
 * A read-only reader for the string and type pools of one `classes.dex`.
 *
 * `contract/plugin-api/FOREIGN.md` §4.1 is the reason this exists. Some
 * extension repositories publish an Android APK and no source. The APK is a ZIP
 * holding one or more `classes*.dex` files, and R8 — which renamed every class
 * in them to `a`, `b`, `c` — did **not** touch the string constants. The CSS
 * selectors, endpoint paths and format strings are all still there, in the
 * clear, in the DEX string pool. That is enough to recognise which shared
 * template an extension was generated from, which is the whole ambition here.
 *
 * **Nothing in this file executes, interprets or emulates anything.** It does
 * not read `code_item`s, it does not decode instructions, it does not follow a
 * `map_list`. It walks three flat tables — `string_ids`, `type_ids`,
 * `class_defs` — and stops. A reader that cannot run bytecode cannot be tricked
 * into running bytecode.
 *
 * Hand-written for the same reason `../../zip.ts` is: this sits on the security
 * boundary, and the input is a file somebody downloaded from a URL they typed
 * in. A general DEX library's job is to understand as many files as possible;
 * this one's job is to refuse most of them. Every offset is checked against the
 * buffer before it is read, every declared count is checked against both a cap
 * and the space the file actually has, and a malformed file is a `DexError`
 * with a sentence in it rather than an exception from the depths of a loop.
 */

/** One `classes.dex` refused. Always carries a sentence, never a stack trace. */
export class DexError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DexError';
	}
}

/** `dex\n` — the first four bytes; the next four are three digits and a NUL. */
const MAGIC = [0x64, 0x65, 0x78, 0x0a];

/**
 * `header_item` is a fixed 112 bytes, and the fields below live at fixed
 * offsets inside it. Named rather than inlined because a bare `56` in a bounds
 * check is the kind of thing that gets "tidied" into `54` by somebody counting
 * on their fingers.
 */
const HEADER_BYTES = 112;
const OFF_ENDIAN_TAG = 40;
const OFF_STRING_IDS_SIZE = 56;
const OFF_STRING_IDS_OFF = 60;
const OFF_TYPE_IDS_SIZE = 64;
const OFF_TYPE_IDS_OFF = 68;
const OFF_CLASS_DEFS_SIZE = 96;
const OFF_CLASS_DEFS_OFF = 100;

/**
 * `ENDIAN_CONSTANT`. Its byte-swapped twin, `REVERSE_ENDIAN_CONSTANT`, is legal
 * in the format and has never been produced by a real toolchain, so rather than
 * carry a second code path that nothing exercises, a big-endian file is
 * refused by name.
 */
const ENDIAN_CONSTANT = 0x12345678;
const REVERSE_ENDIAN_CONSTANT = 0x78563412;

const STRING_ID_BYTES = 4;
const TYPE_ID_BYTES = 4;
const CLASS_DEF_BYTES = 32;

/**
 * Caps. The table bounds checks already stop a declared count from outrunning
 * the file, so these exist for the other shape of hostile input: a small file
 * whose header claims work that is technically in range and ruinous to do.
 *
 * The numbers are generous against a real extension — one carries a few
 * thousand strings — and mean, so that "this is not an extension" is decided in
 * milliseconds.
 */
export const MAX_STRINGS = 200_000;
export const MAX_TYPES = 65_536;
export const MAX_CLASS_DEFS = 65_536;
/** No selector or endpoint is 64 Ki UTF-16 units long. Nothing useful is. */
const MAX_STRING_UTF16 = 0x10000;
/** And the pool as a whole, so a hundred thousand large strings is also no. */
const MAX_TOTAL_UTF16 = 8 * 1024 * 1024;

/** One decoded table region, already proven to be inside the buffer. */
interface Dex {
	readonly data: Uint8Array;
	readonly view: DataView;
}

/**
 * Every string constant in one `classes.dex`, in `string_ids` order.
 *
 * Order is worth keeping: `type_ids` indexes into this array, and the pool is
 * sorted, so a fingerprint that wants a stable identity for a template can hash
 * the sequence as it stands.
 */
export function readDexStrings(dex: Uint8Array): string[] {
	const { data, view } = openDex(dex);

	const count = view.getUint32(OFF_STRING_IDS_SIZE, true);
	const tableOff = view.getUint32(OFF_STRING_IDS_OFF, true);
	if (count > MAX_STRINGS) {
		throw new DexError(`This file declares ${count} strings; an extension declares far fewer.`);
	}
	if (count === 0) return [];
	requireTable(data, tableOff, count, STRING_ID_BYTES, 'string table');

	const strings: string[] = new Array<string>(count);
	let total = 0;

	for (let index = 0; index < count; index += 1) {
		const dataOff = view.getUint32(tableOff + index * STRING_ID_BYTES, true);
		const decoded = decodeStringData(data, dataOff, index);
		total += decoded.length;
		if (total > MAX_TOTAL_UTF16) {
			throw new DexError('This file’s strings are larger than an extension’s could be.');
		}
		strings[index] = decoded;
	}

	return strings;
}

/**
 * Type descriptors the dex **defines**, and those it only **references**.
 *
 * The split is the useful half. What an extension defines is a handful of
 * R8-renamed classes and says nothing; what it references is its whole
 * classpath — the serialisation library, the HTML parser, the HTTP client, the
 * base classes of whichever app it was written for — and that is a fingerprint.
 * `defined` is here so that `referenced` can honestly mean "not from this file".
 *
 * Descriptors are returned raw (`Lcom/example/Thing;`, `[I`, `J`), unparsed and
 * de-duplicated, first occurrence winning.
 */
export function readDexTypes(dex: Uint8Array): {
	defined: string[];
	referenced: string[];
} {
	const strings = readDexStrings(dex);
	const { data, view } = openDex(dex);

	const typeCount = view.getUint32(OFF_TYPE_IDS_SIZE, true);
	const typeOff = view.getUint32(OFF_TYPE_IDS_OFF, true);
	if (typeCount > MAX_TYPES) {
		throw new DexError(
			`This file declares ${typeCount} types; a dex file holds at most ${MAX_TYPES}.`
		);
	}
	requireTable(data, typeOff, typeCount, TYPE_ID_BYTES, 'type table');

	const descriptors: string[] = new Array<string>(typeCount);
	for (let index = 0; index < typeCount; index += 1) {
		const stringIndex = view.getUint32(typeOff + index * TYPE_ID_BYTES, true);
		if (stringIndex >= strings.length) {
			throw new DexError(
				`Type ${index} names string ${stringIndex}, and this file has ${strings.length}.`
			);
		}
		descriptors[index] = strings[stringIndex];
	}

	const classCount = view.getUint32(OFF_CLASS_DEFS_SIZE, true);
	const classOff = view.getUint32(OFF_CLASS_DEFS_OFF, true);
	if (classCount > MAX_CLASS_DEFS) {
		throw new DexError(`This file declares ${classCount} classes; that is not an extension.`);
	}
	requireTable(data, classOff, classCount, CLASS_DEF_BYTES, 'class table');

	// Only the first u32 of each 32-byte `class_def_item` is read: `type_idx`.
	// The other seven fields point into structures this reader deliberately
	// never visits.
	const definedTypes = new Set<string>();
	for (let index = 0; index < classCount; index += 1) {
		const typeIndex = view.getUint32(classOff + index * CLASS_DEF_BYTES, true);
		if (typeIndex >= descriptors.length) {
			throw new DexError(
				`Class ${index} names type ${typeIndex}, and this file has ${descriptors.length}.`
			);
		}
		definedTypes.add(descriptors[typeIndex]);
	}

	const referenced: string[] = [];
	const seen = new Set<string>();
	for (const descriptor of descriptors) {
		if (definedTypes.has(descriptor) || seen.has(descriptor)) continue;
		seen.add(descriptor);
		referenced.push(descriptor);
	}

	return { defined: Array.from(definedTypes), referenced };
}

/**
 * Checks the 112-byte header and hands back a view over the whole file.
 *
 * The version digits are checked for being digits and then ignored: every
 * version from 035 onwards lays these three tables out identically, and
 * refusing an unfamiliar number would refuse files that parse perfectly.
 */
function openDex(dex: Uint8Array): Dex {
	if (dex.byteLength < HEADER_BYTES) {
		throw new DexError(
			`This file is ${dex.byteLength} bytes; a dex file’s header alone is ${HEADER_BYTES}.`
		);
	}

	for (let index = 0; index < MAGIC.length; index += 1) {
		if (dex[index] !== MAGIC[index]) throw new DexError('This file is not a dex file.');
	}
	for (let index = 4; index < 7; index += 1) {
		const byte = dex[index];
		if (byte < 0x30 || byte > 0x39) throw new DexError('This file is not a dex file.');
	}
	if (dex[7] !== 0) throw new DexError('This file is not a dex file.');

	const view = new DataView(dex.buffer, dex.byteOffset, dex.byteLength);
	const endian = view.getUint32(OFF_ENDIAN_TAG, true);
	if (endian === REVERSE_ENDIAN_CONSTANT) {
		throw new DexError('This dex file is byte-swapped, which Yorozo does not read.');
	}
	if (endian !== ENDIAN_CONSTANT) {
		throw new DexError('This dex file’s header is malformed.');
	}

	return { data: dex, view };
}

/**
 * Proves that `count` records of `stride` bytes starting at `offset` are inside
 * the buffer, before a single one of them is read.
 *
 * Arithmetic in doubles rather than with `|0`: a u32 count times a stride can
 * exceed 2^31 and a 32-bit multiply would wrap it into something small and
 * plausible, which is precisely the bug this function exists to not have.
 */
function requireTable(
	data: Uint8Array,
	offset: number,
	count: number,
	stride: number,
	what: string
): void {
	if (count === 0) return;
	if (offset < HEADER_BYTES) {
		throw new DexError(`This file’s ${what} overlaps its header.`);
	}
	if (offset + count * stride > data.length) {
		throw new DexError(
			`This file’s ${what} claims ${count} entries, and the file is too small to hold them.`
		);
	}
}

/**
 * Decodes one `string_data_item`: a ULEB128 length in UTF-16 code units,
 * followed by MUTF-8 bytes and a NUL.
 *
 * **MUTF-8 is not UTF-8, and `TextDecoder` must not be pointed at it.** Two
 * differences matter and both are silent corruptions rather than errors:
 *
 * - A U+0000 is encoded as the two bytes `C0 80`, which is an overlong form
 *   that a conforming UTF-8 decoder replaces with U+FFFD. Java writes it that
 *   way exactly so that a NUL can appear inside a NUL-terminated string, and
 *   dex strings do contain them.
 * - A supplementary character is written as its two UTF-16 surrogates, each
 *   encoded in three bytes, rather than as one four-byte sequence. A UTF-8
 *   decoder sees two unpaired surrogates and replaces both.
 *
 * Handing the bytes to `TextDecoder` therefore does not fail loudly; it returns
 * a string that is subtly wrong, which for a fingerprint is the worst outcome
 * available. So the bytes are walked here.
 */
function decodeStringData(data: Uint8Array, offset: number, index: number): string {
	if (offset < HEADER_BYTES || offset >= data.length) {
		throw new DexError(`String ${index} sits at ${offset}, which is not inside this file.`);
	}

	const { value: utf16Size, next } = readUleb128(data, offset, index);
	if (utf16Size > MAX_STRING_UTF16) {
		throw new DexError(`String ${index} declares ${utf16Size} characters; nothing useful is.`);
	}

	let cursor = next;
	let out = '';

	// Exactly `utf16Size` code units are produced — never "until the NUL". A
	// declared length and a terminator that disagree is a file where a checker
	// and a reader can be made to see two different strings, so disagreement is
	// an error rather than a preference for one of them.
	for (let produced = 0; produced < utf16Size; produced += 1) {
		if (cursor >= data.length) {
			throw new DexError(`String ${index} runs past the end of the file.`);
		}
		const lead = data[cursor];
		cursor += 1;

		if (lead === 0) {
			throw new DexError(`String ${index} ends before the ${utf16Size} characters it declares.`);
		}
		if (lead < 0x80) {
			out += String.fromCharCode(lead);
			continue;
		}
		if ((lead & 0xe0) === 0xc0) {
			const second = readContinuation(data, cursor, index);
			cursor += 1;
			// Not rejected when overlong: `C0 80` *is* the overlong encoding of
			// U+0000, and it is the correct spelling here.
			out += String.fromCharCode(((lead & 0x1f) << 6) | second);
			continue;
		}
		if ((lead & 0xf0) === 0xe0) {
			const second = readContinuation(data, cursor, index);
			const third = readContinuation(data, cursor + 1, index);
			cursor += 2;
			// A lone surrogate is emitted as it stands. JavaScript strings are
			// UTF-16, so a well-formed pair reassembles itself and a broken one
			// stays broken instead of being quietly patched.
			out += String.fromCharCode(((lead & 0x0f) << 12) | (second << 6) | third);
			continue;
		}
		throw new DexError(
			`String ${index} is not MUTF-8: byte 0x${lead.toString(16)} cannot start a character.`
		);
	}

	if (cursor >= data.length || data[cursor] !== 0) {
		throw new DexError(`String ${index} is not terminated.`);
	}
	return out;
}

function readContinuation(data: Uint8Array, offset: number, index: number): number {
	if (offset >= data.length) {
		throw new DexError(`String ${index} runs past the end of the file.`);
	}
	const byte = data[offset];
	if ((byte & 0xc0) !== 0x80) {
		throw new DexError(`String ${index} is not MUTF-8: a character is cut short.`);
	}
	return byte & 0x3f;
}

/**
 * An unsigned LEB128, bounded at five bytes.
 *
 * The bound is the point. A LEB128 is "keep reading while the high bit is set",
 * and a file of `0xff` bytes is a loop that ends at the end of the buffer or
 * not at all. Five bytes is every value a u32 can hold.
 */
function readUleb128(
	data: Uint8Array,
	offset: number,
	index: number
): { value: number; next: number } {
	let value = 0;
	let shift = 0;

	for (let step = 0; step < 5; step += 1) {
		const at = offset + step;
		if (at >= data.length) {
			throw new DexError(`String ${index} runs past the end of the file.`);
		}
		const byte = data[at];
		value |= (byte & 0x7f) << shift;
		shift += 7;
		// `>>> 0` because the fifth byte shifts into the sign bit and a length
		// must not come out negative.
		if ((byte & 0x80) === 0) return { value: value >>> 0, next: at + 1 };
	}

	throw new DexError(`String ${index} declares a length that is not a number.`);
}
