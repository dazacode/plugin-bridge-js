/**
 * A minimal, read-only ZIP reader.
 *
 * Hand-written rather than taken from a dependency, for the same reason the
 * packager's writer is: this sits on the security boundary, and a general
 * library's job is to read as many archives as possible while this one's job is
 * to refuse most of them. Two hundred lines that only understand what
 * `yorozo package` produces is a smaller thing to audit than a format-complete
 * parser, and it means the browser client ships no third-party code in the path
 * between "bytes off the internet" and "code we are about to run".
 *
 * Inflation is `DecompressionStream('deflate-raw')`, which is native in every
 * browser this client supports and in Node, so there is no bundled inflater
 * either.
 *
 * **It reads the central directory, not the local headers.** A ZIP states each
 * entry twice, and the two can disagree — which is exactly how a file gets
 * treated as one thing by a checker and another by an extractor. The central
 * directory is the authoritative index, so it is the only one consulted.
 */

/** One file inside an archive. */
export interface ZipEntry {
	readonly name: string;
	readonly bytes: Uint8Array;
}

export class ZipError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ZipError';
	}
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

/** Caps, mirroring the Dart reader so a bundle behaves the same on both. */
export const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
/** More entries than this is not a plugin; it is something else entirely. */
const MAX_ENTRIES = 512;

/**
 * Reads every file in `data`.
 *
 * Throws `ZipError` rather than returning a partial archive: half of a bundle
 * is not a smaller bundle, it is an unknown one.
 */
export async function readZip(data: Uint8Array): Promise<ZipEntry[]> {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const end = findEndOfCentralDirectory(data, view);

	const count = view.getUint16(end + 10, true);
	if (count > MAX_ENTRIES) {
		throw new ZipError(`This archive holds ${count} files; a plugin holds far fewer.`);
	}
	let offset = view.getUint32(end + 16, true);

	const entries: ZipEntry[] = [];
	let inflatedTotal = 0;

	for (let index = 0; index < count; index += 1) {
		if (offset + 46 > data.length || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
			throw new ZipError('This archive’s directory is malformed.');
		}

		const method = view.getUint16(offset + 10, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const uncompressedSize = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localOffset = view.getUint32(offset + 42, true);

		const name = new TextDecoder().decode(data.subarray(offset + 46, offset + 46 + nameLength));

		// Checked against the *declared* size, before inflating anything. A zip
		// bomb is small on disk and enormous in memory, so a cap applied after
		// decompression is a cap applied too late.
		if (uncompressedSize > MAX_ENTRY_BYTES) {
			throw new ZipError(`"${name}" is larger than a plugin file may be.`);
		}
		inflatedTotal += uncompressedSize;
		if (inflatedTotal > MAX_INFLATED_BYTES) {
			throw new ZipError('This archive expands to more than a plugin may be.');
		}

		// Directory entries are stored with a trailing slash and no content.
		// There is nothing to extract and nothing to check.
		if (!name.endsWith('/')) {
			entries.push({
				name,
				bytes: await readLocalEntry(
					data,
					view,
					localOffset,
					method,
					compressedSize,
					uncompressedSize,
					name
				)
			});
		}

		offset += 46 + nameLength + extraLength + commentLength;
	}

	return entries;
}

/**
 * Reads one entry's bytes, using the *central directory's* sizes.
 *
 * The local header repeats them and is ignored, because a mismatch between the
 * two is the classic way to make a reader and a verifier disagree about what a
 * file contains.
 */
async function readLocalEntry(
	data: Uint8Array,
	view: DataView,
	localOffset: number,
	method: number,
	compressedSize: number,
	uncompressedSize: number,
	name: string
): Promise<Uint8Array> {
	if (localOffset + 30 > data.length || view.getUint32(localOffset, true) !== 0x04034b50) {
		throw new ZipError(`"${name}" is not where the directory says it is.`);
	}
	const nameLength = view.getUint16(localOffset + 26, true);
	const extraLength = view.getUint16(localOffset + 28, true);
	const start = localOffset + 30 + nameLength + extraLength;
	const body = data.subarray(start, start + compressedSize);

	if (body.length !== compressedSize) {
		throw new ZipError(`"${name}" is truncated.`);
	}

	if (method === 0) {
		if (body.length !== uncompressedSize) {
			throw new ZipError(`"${name}" declares a size it does not have.`);
		}
		// Copied rather than returned as a view, so a caller cannot mutate the
		// archive buffer through it, and so the original can be released.
		return new Uint8Array(body);
	}
	if (method !== 8) {
		throw new ZipError(`"${name}" uses a compression method Yorozo does not read.`);
	}

	const inflated = await inflateRaw(body);
	if (inflated.length !== uncompressedSize) {
		// The declared size is what the entry-size cap was checked against, so
		// a body that inflates to something else has escaped that check.
		throw new ZipError(`"${name}" inflated to an unexpected size.`);
	}
	return inflated;
}

async function inflateRaw(body: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([body as BlobPart])
		.stream()
		.pipeThrough(new DecompressionStream('deflate-raw'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Locates the end-of-central-directory record.
 *
 * Scanned backwards because the record is last and may be followed by a
 * comment of up to 64 KiB. The scan is bounded by that comment's maximum
 * length rather than running the whole file, so a large file that is not a ZIP
 * fails quickly instead of being read end to end.
 */
function findEndOfCentralDirectory(data: Uint8Array, view: DataView): number {
	const earliest = Math.max(0, data.length - (22 + 0xffff));
	for (let offset = data.length - 22; offset >= earliest; offset -= 1) {
		if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY) return offset;
	}
	throw new ZipError('This file is not a Yorozo plugin. A plugin is a .yorozoplugin archive.');
}
