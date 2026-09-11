/**
 * Opening a `.yorozoplugin`, safely. The browser half of the security boundary.
 *
 * **This file's twin is `lib/core/plugins/plugin_archive.dart`**, and the two
 * implement `contract/plugin-api/REPOSITORY.md` §4 in the same order, because
 * the order is the point: hash before opening, open before trusting a path,
 * verify before comparing, compare before asking. Two implementations of one
 * security check is two chances to leave a gap, so the steps and the refusal
 * reasons are kept deliberately identical — `plugin-archive.spec.ts` and
 * `plugin_archive_test.dart` assert the same behaviours.
 *
 * The three attacks it is written against, all of them old:
 *
 * - **Zip slip.** `../../etc/passwd`, an absolute path, a drive letter. Entry
 *   names are checked raw and never normalised, because "normalise then check"
 *   is how every one of these bugs was written.
 * - **Zip bombs.** Bounded in `zip.ts`, against the *declared* sizes, before
 *   anything is inflated.
 * - **Manifest disagreement.** The consent screen renders the index's claims,
 *   since it runs before the download; so the archive is held to those claims
 *   afterwards and a mismatch aborts.
 *
 * Nothing here writes anything. It returns a verified in-memory bundle and
 * lets the registry decide where it goes, which keeps the dangerous parsing
 * away from storage entirely.
 */

import { parseSettingDescriptors, type SettingDescriptor } from './settings';
import { readZip, ZipError } from './zip';

export type PluginRejection =
	| 'unreadable'
	| 'incomplete'
	| 'unsafePath'
	| 'tooLarge'
	| 'corruptFile'
	| 'corruptDigest'
	| 'hashMismatch'
	| 'badSignature'
	| 'unsigned'
	| 'malformedManifest'
	| 'manifestMismatch';

/** A refusal, with a reason a person can act on. */
export class PluginArchiveError extends Error {
	constructor(
		readonly rejection: PluginRejection,
		message: string
	) {
		super(message);
		this.name = 'PluginArchiveError';
	}
}

/** What the index promised, so the archive can be held to it. */
export interface ExpectedPlugin {
	readonly id: string;
	readonly version: string;
	/**
	 * Lowercase hex, or null when there is no download to check.
	 *
	 * Null is for a bundle this client produced itself, by converting an
	 * extension written for another app: those bytes never crossed a network,
	 * so there is no transit to detect tampering in, and a hash of them
	 * computed here would only prove that this function can hash.
	 *
	 * It is worth being exact about what that costs, because it is a real gap.
	 * The *artifact* the conversion was built from did cross a network, and no
	 * foreign ecosystem publishes a digest for it, so nothing verifies that the
	 * script downloaded is the script its author published. What still runs is
	 * everything after: traversal refusal, every file against `integrity.json`,
	 * the canonical digest, and the comparison against what the viewer
	 * consented to. `contract/plugin-api/FOREIGN.md` §5.
	 */
	readonly sha256: string | null;
	readonly permissions: readonly string[];
	readonly hosts: readonly string[];
}

/** A verified bundle, in memory. */
export interface PluginBundle {
	readonly manifest: Record<string, unknown>;
	readonly entrypointSource: string;
	readonly files: ReadonlyMap<string, Uint8Array>;
	readonly digest: string;
	/** Base64 SPKI of the key that signed it, or null when unsigned. */
	readonly signedBy: string | null;
	readonly id: string;
	readonly version: string;
	readonly permissions: readonly string[];
	readonly hosts: readonly string[];
	/**
	 * What the host will draw on this plugin's behalf (`ABI.md` §1).
	 *
	 * Empty for a manifest that declares none, which every bundle published
	 * before settings existed does. Read here rather than at each call site so
	 * that "what the archive claims" is answered in one place.
	 */
	readonly settings: readonly SettingDescriptor[];
}

const REQUIRED = ['plugin.json', 'integrity.json', 'signature.json'] as const;

/**
 * Opens and verifies an archive.
 *
 * `expected` is the repository listing; omit it for a sideloaded file, where
 * there is no index to disagree with and the user is consenting to whatever
 * the archive itself declares.
 *
 * `pinnedKey` is the repository's `signingKey`. When present the archive
 * **must** be signed by it. When absent an unsigned archive is accepted, and
 * the caller is responsible for saying so — "installed on integrity alone" and
 * "installed from a signed repository" are different facts, and only one of
 * them is about origin.
 */
export async function openPluginArchive(
	bytes: Uint8Array,
	options: { expected?: ExpectedPlugin; pinnedKey?: string | null } = {}
): Promise<PluginBundle> {
	const { expected, pinnedKey } = options;

	// 1. Hash first, before a single byte is parsed. If the index promised a
	//    hash and this is not it, nothing else about this file is worth reading.
	if (expected !== undefined && expected.sha256 !== null) {
		const actual = await sha256Hex(bytes);
		if (actual !== expected.sha256.toLowerCase()) {
			throw new PluginArchiveError(
				'hashMismatch',
				'This download does not match what the repository listed. It may have been ' +
					'altered in transit, or the repository may be out of date.'
			);
		}
	}

	// 2. Open.
	let files: Map<string, Uint8Array>;
	try {
		files = new Map((await readZip(bytes)).map((entry) => [entry.name, entry.bytes]));
	} catch (error) {
		throw new PluginArchiveError(
			error instanceof ZipError && /larger|expands|holds/.test(error.message)
				? 'tooLarge'
				: 'unreadable',
			error instanceof ZipError ? error.message : 'This file is not a readable Yorozo plugin.'
		);
	}

	// 3. Refuse anything that escapes, before a name is used for anything.
	for (const name of files.keys()) {
		if (!isSafeEntryName(name)) {
			throw new PluginArchiveError(
				'unsafePath',
				`This archive contains an unsafe path ("${name}") and was not installed.`
			);
		}
	}

	for (const member of REQUIRED) {
		if (!files.has(member)) {
			throw new PluginArchiveError(
				'incomplete',
				`This archive is missing ${member} and is not a complete plugin.`
			);
		}
	}

	// 4. Integrity: every file, then the canonical digest over all of them.
	const integrity = decodeJson(
		files.get('integrity.json')!,
		'incomplete',
		'integrity.json is unreadable.'
	);
	const declared = integrity['files'] as Record<string, string> | undefined;
	if (declared === undefined) {
		throw new PluginArchiveError('incomplete', 'integrity.json lists no files.');
	}

	for (const [path, hash] of Object.entries(declared)) {
		const content = files.get(path);
		if (content === undefined) {
			throw new PluginArchiveError(
				'corruptFile',
				`integrity.json lists "${path}", which the archive does not contain.`
			);
		}
		if ((await sha256Hex(content)) !== hash) {
			throw new PluginArchiveError(
				'corruptFile',
				`A file in this archive ("${path}") does not match its recorded hash.`
			);
		}
	}

	// Recomputed from the list rather than trusted: otherwise a tampered
	// archive would only need its digest field rewritten to agree with itself.
	const canonical = Object.keys(declared)
		.sort()
		.map((path) => `${path}:${declared[path]}`)
		.join('\n');
	const digest = await sha256Hex(new TextEncoder().encode(canonical));
	if (digest !== integrity['digest']) {
		throw new PluginArchiveError(
			'corruptDigest',
			'This archive’s integrity record contradicts itself.'
		);
	}

	// 5. Signature, when the repository pinned a key.
	const signature = decodeJson(
		files.get('signature.json')!,
		'incomplete',
		'signature.json is unreadable.'
	);
	const isSigned = signature['signed'] === true;
	let signedBy: string | null = null;

	if (pinnedKey !== undefined && pinnedKey !== null) {
		if (!isSigned) {
			throw new PluginArchiveError(
				'unsigned',
				'This repository is signed, but this plugin is not. Refusing to install it.'
			);
		}
		const ok = await verifyEd25519(digest, signature['signature'] as string, pinnedKey);
		if (!ok) {
			throw new PluginArchiveError(
				'badSignature',
				'This plugin was not signed by the key this repository was added with. ' +
					'Remove and re-add the repository if its key really has changed.'
			);
		}
		signedBy = pinnedKey;
	}

	// 6. The manifest, and whether it says what the index said it said.
	const manifest = decodeJson(
		files.get('plugin.json')!,
		'malformedManifest',
		'plugin.json is not valid JSON.'
	);
	const entrypoint = manifest['entrypoint'];
	if (typeof entrypoint !== 'string') {
		throw new PluginArchiveError('malformedManifest', 'plugin.json declares no entrypoint.');
	}
	const source = files.get(`payload/${entrypoint}.js`);
	if (source === undefined) {
		throw new PluginArchiveError(
			'incomplete',
			`This archive declares an entrypoint ("${entrypoint}") it does not carry.`
		);
	}

	const bundle: PluginBundle = {
		manifest,
		entrypointSource: new TextDecoder().decode(source),
		files,
		digest,
		signedBy,
		id: String(manifest['id'] ?? ''),
		version: String(manifest['version'] ?? ''),
		permissions: asStrings(manifest['permissions']),
		hosts: asStrings((manifest['network'] as Record<string, unknown> | undefined)?.['hosts']),
		settings: parseSettingDescriptors(manifest['settings'])
	};

	if (expected !== undefined) assertMatchesIndex(bundle, expected);
	return bundle;
}

/**
 * Holds the archive to what the user was shown.
 *
 * The consent screen renders the *index's* claims, because it has to run
 * before the download. So an index that under-reports permissions would
 * otherwise be a complete bypass: ask for one thing, ship another. A mismatch
 * aborts rather than re-prompting — someone who has already said yes is not in
 * a position to re-evaluate.
 */
function assertMatchesIndex(bundle: PluginBundle, expected: ExpectedPlugin): void {
	if (bundle.id !== expected.id || bundle.version !== expected.version) {
		throw new PluginArchiveError(
			'manifestMismatch',
			`This archive is ${bundle.id} ${bundle.version}, but the repository listed ` +
				`${expected.id} ${expected.version}.`
		);
	}
	const extraPermissions = bundle.permissions.filter((p) => !expected.permissions.includes(p));
	if (extraPermissions.length > 0) {
		throw new PluginArchiveError(
			'manifestMismatch',
			`This plugin asks for permissions the repository did not list: ${extraPermissions.join(', ')}.`
		);
	}
	const extraHosts = bundle.hosts.filter((host) => !expected.hosts.includes(host));
	if (extraHosts.length > 0) {
		throw new PluginArchiveError(
			'manifestMismatch',
			`This plugin reaches hosts the repository did not list: ${extraHosts.join(', ')}.`
		);
	}
}

/**
 * Whether an archive entry name may be used at all.
 *
 * Deliberately strict and deliberately dumb: it checks the raw name and never
 * normalises it.
 */
export function isSafeEntryName(name: string): boolean {
	if (name.length === 0) return false;
	if (name.startsWith('/') || name.startsWith('\\')) return false;
	if (name.includes('\\')) return false;
	// A NUL in a path is never legitimate and is a classic way to make a
	// checker and a filesystem disagree about where a write lands.
	if (name.includes('\u0000')) return false;
	if (/^[A-Za-z]:/.test(name)) return false;
	return !name.split('/').some((segment) => segment === '..' || segment === '.');
}

/**
 * Ed25519 over the digest's raw bytes, matching the packager, which signs
 * `Buffer.from(digest, 'hex')`.
 *
 * `crypto.subtle` rather than a bundled curve implementation: it is native,
 * constant-time, and one less piece of third-party code on the trust path.
 */
async function verifyEd25519(
	digestHex: string,
	signatureBase64: string,
	publicKeyBase64: string
): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey(
			'spki',
			fromBase64(publicKeyBase64) as BufferSource,
			{ name: 'Ed25519' },
			false,
			['verify']
		);
		return await crypto.subtle.verify(
			'Ed25519',
			key,
			fromBase64(signatureBase64) as BufferSource,
			fromHex(digestHex) as BufferSource
		);
	} catch {
		// A key this browser cannot import is a signature this browser cannot
		// check, which is a refusal rather than a pass.
		return false;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function decodeJson(
	bytes: Uint8Array,
	rejection: PluginRejection,
	message: string
): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new PluginArchiveError(rejection, message);
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof PluginArchiveError) throw error;
		throw new PluginArchiveError(rejection, message);
	}
}

function asStrings(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function fromBase64(value: string): Uint8Array {
	const clean = value.replace(/[=\s]/g, '');
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
	let accumulator = 0;
	let bits = 0;
	let index = 0;
	for (const character of clean) {
		const digit = DIGITS.indexOf(character);
		if (digit === -1) throw new Error(`Not base64: ${value}`);
		accumulator = (accumulator << 6) | digit;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out[index] = (accumulator >> bits) & 0xff;
			index += 1;
		}
	}
	return out.subarray(0, index);
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
