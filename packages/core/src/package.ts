/**
 * Writing a `.yorozoplugin`, so a converted extension is an ordinary bundle.
 *
 * The counterpart to `zip.ts`, which reads. It exists because conversion has
 * to produce something the *existing* install path accepts: bytes that
 * `openPluginArchive` opens, hashes, and holds to a declaration. There is
 * deliberately no shortcut from a converter to storage — a converter makes
 * archives, and archives are not trusted for having been made here.
 *
 * ## Stored, never deflated
 *
 * Every entry is written with compression method 0.
 *
 * `REPOSITORY.md` §6 requires the packager to be deterministic, and
 * `CompressionStream('deflate-raw')` is not: the format pins how output is
 * *decoded*, not which of the many valid encodings a given implementation
 * emits. Two browsers, or a browser and Node, may deflate the same input into
 * different bytes, which would make a converted bundle's digest a fact about
 * where the conversion ran rather than about what was converted — and updates
 * compare digests. A few hundred kilobytes of JavaScript is not worth that.
 *
 * Everything else that varies is pinned for the same reason: entries in sorted
 * order, a fixed timestamp, no extra fields, no comment.
 */

import type { ForeignOrigin } from './formats';
import { parseSettingDescriptors, type SettingDescriptor } from '@plugin-bridge/core/settings';

/** Kept well below `zip.ts`'s own caps, which apply when this is read back. */
const MAX_ENTRYPOINT_BYTES = 4 * 1024 * 1024;

/** The manifest's `entrypoint`, and so the module's name inside `payload/`. */
const ENTRYPOINT = 'source';

/**
 * A converter's identity, recorded in the bundle and on the installed row.
 *
 * Bumped when the translator's *answers* change — a construct that used to
 * refuse now converts, or a conversion that used to be wrong is now right —
 * because three things key off it: an offered re-conversion (`formats.ts`), a
 * remembered check verdict (`check.ts`), and the scoreboard's report header.
 * Leaving it still after widening the translator makes all three quietly
 * describe the previous build.
 *
 * 2: the radix/unpacker layer, and the name-resolution fixes under it.
 * 3: companion pre-registration on the `data class` path, and `indices` /
 *    `associateBy` / `associateWith` / `pow` in the runtime.
 * 4: file-private declarations that collide across files are renamed per file,
 *    so a merged module parses.
 * 5: a shared library's test sources are no longer read as library code.
 * 6: the driver supplies the base class's `headersBuilder()`.
 * 7: `{ _, _ -> }` gets a distinct name per ignored parameter, and two classes'
 *    same-named nested types no longer collide at module scope.
 * 8: the driver supplies `client`, `network`, `json` and `preferences`;
 *    `.get(k)` indexes; `String.format` and `"%s".format` format.
 * 9: `"json".parseAs<T>()` decodes its payload rather than its type name.
 * 10: requests are resolved against the base rather than concatenated onto it,
 *     and `.execute()` / `.awaitSuccess()` suspend.
 * 11: a jsoup selection read as a string answers its outer HTML.
 * 12: `response.request` is the request the response came from, a body the
 *     relay would not read refuses by name, and `android.util.Log` exists.
 * 13: a source filed under `pt` is found from a listing that says `pt-BR`.
 * 14: a plain `fun` that blocks on a request is awaited at its call sites.
 * 15: a member the parser had to recover inside is refused, whether or not the
 *     recovery left an ERROR node behind.
 * 16: a prefix operator binds to its operand rather than to the whole binary
 *     expression, `by lazy` evaluates to its value, and a refused member with a
 *     surviving caller blocks whatever it is called.
 * 17: a file-wide parse refusal says which of the two it is.
 * 18: `Random::nextBytes` and `toHex()`; a call on an implicit receiver keeps
 *     its trailing lambda; `?: return emptyList()` returns the list.
 * 19: `delay(300.milliseconds)`, and a base class is emitted before whatever
 *     extends it.
 * 20: a nested type resolves under its qualified name, and an extension built
 *     on a converted theme is the entry class rather than the theme.
 * 21: a one-argument `getString` is not the preferences getter.
 * 22: an extension function a base class declares next door resolves.
 * 23: a base url handed to a multisrc theme as a constructor argument is read.
 * 24: `flatMapIndexed`, `contentType()`, `Thread.sleep`, and two invented
 *     extractor signatures removed — they were dropping a url.
 * 25: a backticked Kotlin name is a binding one way and a field key the other.
 * 26: a named argument is read against the signature of the class being called.
 * 27: `Dto::method` is the unbound reference Kotlin means; `Obj::method` is not.
 * 28: two `when`-entry shapes the vendored grammar could not read are repaired
 *     on the retry path.
 * 29: MD5, SHA-1 and SHA-256, for the request signatures this ecosystem builds.
 * 30: a qualified signature is used only when it accounts for the arguments
 *     actually written; otherwise the bare name still answers.
 * 31: Kotlin's arithmetic spelled as methods — `times`, `div`, `minus`.
 * 32: `java.net.URLEncoder` exists, encodes the way Java does, and resolves
 *     whether it is imported or written out in full.
 * 33: `by preferences.delegate(KEY, DEFAULT)` reads the settings store.
 * 34: `x.ifEmpty { return@map … }` is read as a guard, so the jump lands in the
 *     lambda it was written in.
 *
 * 35-43 moved the number without adding a line here. The gap is left visible
 * rather than backfilled from memory, because a changelog nobody can check is
 * worse than one with a hole in it.
 *
 * 44: a subtitle url is judged before it is made absolute, so a module's
 *     `"none"` is no longer resolved into a caption track pointing at a 404.
 *
 * 45: a Sora module no longer declares the host it was downloaded from, and a
 *     multi-medium declaration is carried as the set it is. Bumped so that
 *     already-installed rows are re-converted: both facts are recorded at
 *     conversion time, so a fixed converter changes nothing for a bundle that
 *     is already on disk.
 *
 * 46: a Stremio addon that has to be set up on its own page says so, instead of
 *     reporting the 403 it is turned away with — which the host read as an
 *     anti-bot wall and rendered as "refused an automated request" about an
 *     addon that was one paste from working. Bumped for both reasons the
 *     number exists: `configurable` and the shape of the pasted address are
 *     recorded at conversion time, so an installed row keeps the old shim until
 *     it is converted again, and every stored verdict that said "Blocking
 *     access" for this was answering a question this build now answers
 *     differently.
 *
 * 47: `Application` is a name, so the two spellings this ecosystem uses to
 *     reach its own settings store both resolve to it —
 *     `Injekt.get<Application>().getSharedPreferences(…)` and
 *     `val context: Application by injectLazy()`. Bumped because it changes
 *     what an extension converts to: members that were refused are now
 *     emitted, and a row installed before this keeps the smaller bundle
 *     until it is converted again.
 *
 * 48: two spellings of a null guard stop refusing the member they guard.
 *     `x.ifEmpty { return emptyList() }` was refused where
 *     `x.ifEmpty { return listOf(y) }` converted, because the grammar splits a
 *     `return` with an empty argument list into two nodes and the guard reader
 *     required one — the same split `rejoinJumps` already repairs. And
 *     `x.let { it ?: return … }` is now read as the `x ?: return …` it is,
 *     which is what lets it appear mid-chain, where one shared extractor puts
 *     it across a whole repository. Bumped because members that were refused
 *     are now emitted, so a row installed before this keeps the smaller bundle
 *     until it is converted again.
 *
 * 49: the convert-everything pass, measured against yuzono (Aniyomi) and
 *     keiyoushi (Mihon) and driven through browse, chapter list and read
 *     rather than counted at import. Kotlin overloads get a JavaScript method
 *     per signature behind a dispatcher (they collapsed to the last one and
 *     recursed or received the other's argument); a string's text no longer
 *     names an obstacle; a capitalised receiver nothing declares is refused
 *     rather than left to throw; the mihon driver attaches the source's
 *     client; plus the grammar, declaration, control-flow, runtime-library
 *     and extractor-library passes merged with it. Bumped because what an
 *     extension converts to changed in both directions — members now emitted,
 *     and bundles that imported but could not run now refused — so a row
 *     installed before this keeps its old bundle until it is converted again.
 *
 * 50: imported repository-wide core objects used as receivers are now read
 *     with the extension. They previously remained undeclared and were
 *     refused. This widens the converted bundle, so existing installations
 *     need another conversion to include those helpers.
 *
 * 51: the video libraries' update hint and catching map variant now use the
 *     existing runtime equivalents. Extensions that called those names were
 *     refused before, so reconversion is needed to pick up the widened subset.
 *
 * 52: detached class and companion getters, mutable lazy properties, and
 *     empty anonymous subclasses now keep their Kotlin behavior. Previously
 *     refused members can enter a bundle after reconversion.
 *
 * 53: mutable sorts, getOrPut, buildSet and Observable lambdas widen the
 *     supported control-flow subset; descending keyed sorts also preserve
 *     Kotlin's stable order. Reconvert to include newly emitted members.
 *
 * 54: measured collection and numeric helpers from the stdlib pass now emit
 *     through checked runtime behavior: null filtering, maxOf, replaceAll,
 *     mapNotNullTo, toMap, and nullable double parsing. Reconvert to include
 *     extensions previously refused for those calls.
 *
 * 55: Next.js App Router, Pages Router, and React Flight extraction now run
 *     through the runtime for typed `extractNextJs` and `extractNextJsRsc`.
 *     Reconvert bundles that use those core helpers.
 *
 * 56: nullable Kotlin comparisons now preserve null/undefined equivalence in
 *     JavaScript. This prevents pagination loops when optional links are absent.
 *
 * 57: a decode that names a `@Serializable` class builds it by type, running
 *     the extension's own custom serializers; JsonElement accessors, Kotlin
 *     Map views and entries, and a suspending Mihon parse all answered wrong
 *     or empty before with nothing refused. Several constructs that converted
 *     and then failed at run time are now refused by name instead (an unread
 *     keiyoushi core call, a value reference that did not resolve, a
 *     custom serializer this runtime cannot run). Every bundle made at 56 or
 *     earlier must be reconverted: some decode differently, and some that
 *     loaded are now honestly refused.
 */
export const CONVERTER_VERSION = 57;

export interface BundleInput {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	/** The foreign version string; normalised to semver for the manifest. */
	readonly version: string;
	readonly author: string;
	readonly hosts: readonly string[];
	readonly origin: ForeignOrigin;
	readonly entrypointSource: string;
	/**
	 * What the source declares it can be configured with.
	 *
	 * Read out of the artifact by `preferences.ts`, never invented here. An
	 * empty list is the honest answer for a source that declares nothing and
	 * for one whose declaration is assembled at runtime, and it produces a
	 * bundle identical to the ones that shipped before settings existed.
	 */
	readonly settings?: readonly SettingDescriptor[];

	/* ── attribution ──────────────────────────────────────────────────────
	 * A converted bundle is a derived work of somebody else's program. These
	 * four fields are how it says whose, and under what terms. All optional,
	 * because a foreign index does not always carry them and inventing one is
	 * worse than admitting it is unknown.
	 */

	/** Upstream SPDX identifier, read from the source — never assumed. */
	readonly license?: string;
	/** The upstream `LICENSE`, carried verbatim into `licenses/`. */
	readonly licenseText?: string;
	/** Where the source this was built from lives. https only. */
	readonly repository?: string;
	/** The original author's own page, when the foreign metadata names one. */
	readonly authorUrl?: string;

	/**
	 * Whether the translated module asks the host to carry cookies for it.
	 *
	 * Decided by the adapter with `namesCookieJar`, over the *translated*
	 * module rather than this bundle's source — an entrypoint is the extension
	 * wrapped in our runtime, and the runtime contains the jar shims, so
	 * reading the whole thing would say yes for every plugin ever converted.
	 * The same reasoning, and the same trap, as the host list two fields up.
	 */
	readonly usesCookies?: boolean;
}

/**
 * Whether a translated module installs or saves to a cookie jar.
 *
 * The manifest's `cookies` permission is an opt-in a viewer is shown before
 * installing, so it has to be derived from something auditable rather than
 * granted to every conversion. These are the two calls the passthrough
 * allowlist admits for exactly this purpose (`kotlin/subset.ts`); the shapes
 * the jar cannot honour are refused at conversion and so cannot appear in a
 * module that got this far.
 *
 * Over-eager on purpose, in the direction that costs nothing: a module with an
 * unrelated method of its own called `saveFromResponse` would declare a
 * permission it never uses, which shows one more line on a consent screen. The
 * opposite error is a plugin whose session silently never carries.
 */
export function namesCookieJar(translatedSource: string): boolean {
	return /\.(?:cookieJar|saveFromResponse)\s*\(/.test(translatedSource);
}

export class PackagingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PackagingError';
	}
}

/**
 * A foreign version string as strict SemVer, because the manifest schema
 * requires it.
 *
 * The original is *not* thrown away — it stays on the listing as
 * `origin.foreignVersion`, and that is what update checks compare, precisely
 * because this transformation is lossy: an ecosystem numbering `14.58` and one
 * numbering `14.5.8` would collide here and must not collide there.
 */
export function toSemver(version: string): string {
	const parts = version
		.trim()
		.split(/[.+-]/)
		.map((part) => part.replace(/\D/g, ''))
		.filter((part) => part.length > 0)
		.map((part) => String(Number(part)));

	while (parts.length < 3) parts.push('0');
	return parts.slice(0, 3).join('.');
}

/**
 * Host patterns the manifest schema will accept.
 *
 * A host that cannot be expressed as a pattern is dropped rather than
 * mangled: an allowlist entry that does not mean what it says is worse than a
 * missing one, because the missing one fails loudly at `ctx.http`.
 */
function usableHosts(hosts: readonly string[]): string[] {
	const pattern = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
	return [...new Set(hosts.map((host) => host.toLowerCase()))]
		.filter((host) => host.length >= 4 && host.length <= 253 && pattern.test(host))
		.sort();
}

/**
 * An SPDX identifier the schema will accept, or null.
 *
 * Dropped rather than corrected when it does not fit: a licence field that
 * says something slightly different from what upstream wrote is worse than one
 * that admits it does not know.
 */
function spdx(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim().slice(0, 64);
	return /^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(trimmed) ? trimmed : null;
}

/** An https URL the schema will accept, or null. */
function httpUrl(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return /^https:\/\/[^\s]+$/.test(trimmed) && trimmed.length <= 2048 ? trimmed : null;
}

/** The manifest a converted bundle carries. */
export function convertedManifest(input: BundleInput): Record<string, unknown> {
	const hosts = usableHosts(input.hosts);
	const settings = parseSettingDescriptors(input.settings ?? []);
	if (hosts.length === 0) {
		throw new PackagingError(
			`${input.name} declares no host this build can express as a network rule, so there ` +
				'is nothing to ask permission for and nothing it could reach.'
		);
	}

	return {
		schemaVersion: 1,
		id: input.id,
		name: input.name.slice(0, 64),
		// The schema requires a non-empty description and caps it. A converted
		// bundle always has something true to say, so this never falls back to
		// filler.
		description: (input.description.length > 0
			? input.description
			: `Converted from a ${input.origin.format} extension.`
		).slice(0, 280),
		version: toSemver(input.version),
		author: {
			name: input.author.length > 0 ? input.author.slice(0, 128) : 'unknown',
			...(httpUrl(input.authorUrl) === null ? {} : { url: httpUrl(input.authorUrl) })
		},
		// The upstream licence when the source stated one, and `NOASSERTION`
		// when it did not. That fallback is a statement of ignorance, not a
		// claim: these extensions are somebody else's work, usually published
		// under a real licence, and writing a guessed identifier into a
		// manifest would be asserting terms on their behalf.
		license: spdx(input.license) ?? 'NOASSERTION',
		...(httpUrl(input.repository) === null ? {} : { repository: httpUrl(input.repository) }),
		yorozoPluginApi: 1,
		minimumYorozoVersion: '0.0.0',
		platforms: ['android', 'ios', 'macos', 'windows', 'linux', 'web'],
		capabilities: ['search', 'episodes', 'resolve'],
		// `cookies` is the host-held jar of ADR-0005 §3 and it adds nothing to
		// `ctx` — a plugin cannot read a cookie either way. It is a permission
		// rather than a default because it is state the host keeps on this
		// plugin's behalf, and a viewer is entitled to see that named before
		// they install. A plugin that does not ask does not get one.
		permissions: input.usesCookies === true ? ['network', 'cookies'] : ['network'],
		entrypoint: ENTRYPOINT,
		network: { hosts },
		// Run back through the manifest reader rather than trusted as built:
		// this is the file that decides what a bundle claims, and a claim the
		// published schema would reject must not leave here. Omitted entirely
		// when there is nothing to say, so a bundle with no settings is
		// byte-identical to one converted before this existed.
		...(settings.length === 0 ? {} : { settings })
	};
}

/**
 * Builds the archive.
 *
 * `integrity.json` lists the two files that matter — the manifest and the code
 * — and carries the canonical digest over that list, computed exactly as
 * `archive.ts` recomputes it. `signature.json` states, in the file rather than
 * by its absence, that nothing signed this.
 */
export async function packageBundle(input: BundleInput): Promise<Uint8Array> {
	const source = input.entrypointSource;
	if (source.length === 0) throw new PackagingError('The converted module is empty.');

	const encoder = new TextEncoder();
	const sourceBytes = encoder.encode(source);
	if (sourceBytes.length > MAX_ENTRYPOINT_BYTES) {
		throw new PackagingError('The converted module is larger than a plugin may be.');
	}

	// Two spaces and a trailing newline, so a bundle unpacked by a curious user
	// reads like a file somebody wrote rather than one line of JSON.
	const manifestBytes = encoder.encode(`${JSON.stringify(convertedManifest(input), null, 2)}\n`);

	const files = new Map<string, Uint8Array>([
		['plugin.json', manifestBytes],
		[`payload/${ENTRYPOINT}.js`, sourceBytes]
	]);

	// The upstream licence travels with the code it covers. A converted bundle
	// is a derived work, and the terms it was published under are part of what
	// was derived — hashed and listed like every other member, so it cannot be
	// stripped without the integrity check noticing.
	const licenseText = (input.licenseText ?? '').trim();
	if (licenseText.length > 0) {
		files.set(
			'licenses/UPSTREAM.txt',
			encoder.encode(`${licenseText}
`)
		);
	}

	const hashes: Record<string, string> = {};
	for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
		hashes[path] = await sha256Hex(bytes);
	}
	const digest = await sha256Hex(
		encoder.encode(
			Object.keys(hashes)
				.sort()
				.map((path) => `${path}:${hashes[path]}`)
				.join('\n')
		)
	);

	files.set(
		'integrity.json',
		encoder.encode(`${JSON.stringify({ files: hashes, digest }, null, 2)}\n`)
	);
	files.set(
		'signature.json',
		encoder.encode(
			`${JSON.stringify(
				{
					signed: false,
					convertedBy: {
						converter: 'yorozo-foreign',
						converterVersion: CONVERTER_VERSION,
						format: input.origin.format,
						foreignId: input.origin.foreignId,
						foreignVersion: input.origin.foreignVersion,
						artifactUrl: input.origin.artifactUrl,
						// Stated beside the conversion rather than only in the
						// manifest, because this file is what a reviewer reads
						// to answer "where did this come from and whose is it".
						...(httpUrl(input.repository) === null
							? {}
							: { sourceRepository: httpUrl(input.repository) }),
						...(spdx(input.license) === null ? {} : { upstreamLicense: spdx(input.license) })
					}
				},
				null,
				2
			)}\n`
		)
	);

	return writeZip(files);
}

/**
 * A stored-only ZIP, byte-identical for identical input.
 *
 * Written against what `zip.ts` reads: the central directory is authoritative
 * there, so the local headers here repeat it exactly rather than relying on
 * data descriptors, which that reader does not consult.
 */
export function writeZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
	const names = [...files.keys()].sort();
	const encoder = new TextEncoder();

	const locals: Uint8Array[] = [];
	const centrals: Uint8Array[] = [];
	let offset = 0;

	for (const name of names) {
		const bytes = files.get(name)!;
		const nameBytes = encoder.encode(name);
		const crc = crc32(bytes);

		const local = new Uint8Array(30 + nameBytes.length + bytes.length);
		const localView = new DataView(local.buffer);
		localView.setUint32(0, 0x04034b50, true);
		localView.setUint16(4, 20, true); // version needed
		localView.setUint16(6, 0, true); // no flags; no data descriptor
		localView.setUint16(8, 0, true); // stored
		localView.setUint16(10, 0, true); // time: fixed
		localView.setUint16(12, 0x0021, true); // date: 1980-01-01, the epoch of this format
		localView.setUint32(14, crc, true);
		localView.setUint32(18, bytes.length, true);
		localView.setUint32(22, bytes.length, true);
		localView.setUint16(26, nameBytes.length, true);
		localView.setUint16(28, 0, true);
		local.set(nameBytes, 30);
		local.set(bytes, 30 + nameBytes.length);
		locals.push(local);

		const central = new Uint8Array(46 + nameBytes.length);
		const centralView = new DataView(central.buffer);
		centralView.setUint32(0, 0x02014b50, true);
		centralView.setUint16(4, 20, true); // version made by
		centralView.setUint16(6, 20, true); // version needed
		centralView.setUint16(8, 0, true);
		centralView.setUint16(10, 0, true); // stored
		centralView.setUint16(12, 0, true);
		centralView.setUint16(14, 0x0021, true);
		centralView.setUint32(16, crc, true);
		centralView.setUint32(20, bytes.length, true);
		centralView.setUint32(24, bytes.length, true);
		centralView.setUint16(28, nameBytes.length, true);
		centralView.setUint16(30, 0, true); // extra
		centralView.setUint16(32, 0, true); // comment
		centralView.setUint16(34, 0, true); // disk
		centralView.setUint16(36, 0, true); // internal attributes
		centralView.setUint32(38, 0, true); // external attributes
		centralView.setUint32(42, offset, true);
		central.set(nameBytes, 46);
		centrals.push(central);

		offset += local.length;
	}

	const centralSize = centrals.reduce((total, entry) => total + entry.length, 0);
	const end = new Uint8Array(22);
	const endView = new DataView(end.buffer);
	endView.setUint32(0, 0x06054b50, true);
	endView.setUint16(4, 0, true);
	endView.setUint16(6, 0, true);
	endView.setUint16(8, names.length, true);
	endView.setUint16(10, names.length, true);
	endView.setUint32(12, centralSize, true);
	endView.setUint32(16, offset, true);
	endView.setUint16(20, 0, true);

	const total = locals.reduce((sum, entry) => sum + entry.length, 0) + centralSize + end.length;
	const out = new Uint8Array(total);
	let cursor = 0;
	for (const chunk of [...locals, ...centrals, end]) {
		out.set(chunk, cursor);
		cursor += chunk.length;
	}
	return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
	if (crcTable === null) {
		crcTable = new Uint32Array(256);
		for (let i = 0; i < 256; i += 1) {
			let value = i;
			for (let bit = 0; bit < 8; bit += 1) {
				value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
			}
			crcTable[i] = value >>> 0;
		}
	}
	let crc = 0xffffffff;
	for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
