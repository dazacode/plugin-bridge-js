/**
 * `mihonAdapter`, tested against protobuf bytes this file encodes itself.
 *
 * Rule 9: every URL here is `example.invalid`, except `cdn.jsdelivr.net`,
 * which `mihon.ts` reads literally as the CDN whose URL shape recovers a
 * source directory — a CDN is not a content source, the same distinction that
 * lets `git-hosts.ts` name `raw.githubusercontent.com`.
 *
 * No fixture is captured from a published index: `protobuf.spec.ts`'s header
 * gives the reasoning, and it applies here unchanged — a captured index is a
 * file full of real hostnames that would live in this repository forever, and
 * it would only ever prove the one shape it happened to contain.
 */

import { describe, expect, it } from 'vitest';

import { ForeignFormatError, ForeignIndexError } from '@plugin-bridge/core/adapter';
import { mihonAdapter } from './mihon';

/**
 * The binary door, bound once.
 *
 * `parseIndexBytes` is optional on `ForeignAdapter` — most formats publish a
 * text index and never implement it — so every call here would otherwise carry
 * a non-null assertion. Binding it once also asserts the thing the tests are
 * about: this adapter does implement it.
 */
const parseIndexBytes = mihonAdapter.parseIndexBytes!.bind(mihonAdapter);

const INDEX_URL = 'https://raw.githubusercontent.com/owner/repo/main/index.pb';

/** Minimal encoder, copied in shape from `protobuf.spec.ts`. */
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

/** One `Source` submessage's raw field bytes (unwrapped — the caller embeds it). */
function sourceBody(input: {
	id?: bigint;
	name?: string;
	language?: string;
	homeUrl?: string;
	mirrorUrls?: string[];
	message?: string;
}): number[] {
	const out: number[] = [];
	if (input.id !== undefined) out.push(...encodeVarint(1, input.id));
	if (input.name !== undefined) out.push(...encodeString(2, input.name));
	if (input.language !== undefined) out.push(...encodeString(3, input.language));
	if (input.homeUrl !== undefined) out.push(...encodeString(4, input.homeUrl));
	for (const mirror of input.mirrorUrls ?? []) out.push(...encodeString(5, mirror));
	if (input.message !== undefined) out.push(...encodeString(7, input.message));
	return out;
}

/** One `Resources` submessage's raw field bytes. */
function resourcesBody(input: { apkUrl?: string; iconUrl?: string; jarUrl?: string }): number[] {
	const out: number[] = [];
	if (input.apkUrl !== undefined) out.push(...encodeString(1, input.apkUrl));
	if (input.iconUrl !== undefined) out.push(...encodeString(2, input.iconUrl));
	if (input.jarUrl !== undefined) out.push(...encodeString(501, input.jarUrl));
	return out;
}

/** One `Extension` submessage's raw field bytes. */
function extensionBody(input: {
	name?: string;
	packageName?: string;
	resources?: number[];
	extensionLib?: string;
	versionCode?: bigint;
	versionName?: string;
	contentWarning?: number;
	sources?: number[][];
}): number[] {
	const out: number[] = [];
	if (input.name !== undefined) out.push(...encodeString(1, input.name));
	if (input.packageName !== undefined) out.push(...encodeString(2, input.packageName));
	if (input.resources !== undefined) out.push(...encodeBytes(3, input.resources));
	if (input.extensionLib !== undefined) out.push(...encodeString(4, input.extensionLib));
	if (input.versionCode !== undefined) out.push(...encodeVarint(5, input.versionCode));
	if (input.versionName !== undefined) out.push(...encodeString(6, input.versionName));
	if (input.contentWarning !== undefined) out.push(...encodeVarint(7, input.contentWarning));
	for (const source of input.sources ?? []) out.push(...encodeBytes(8, source));
	return out;
}

/** The top-level `Index` message, as bytes ready to hand to `parseIndexBytes`. */
function indexBytes(input: {
	name?: string;
	signingKey?: string;
	extensions?: number[][];
}): Uint8Array {
	const extensionListBody = (input.extensions ?? []).flatMap((body) => encodeBytes(1, body));
	const out: number[] = [];
	if (input.name !== undefined) out.push(...encodeString(1, input.name));
	if (input.signingKey !== undefined) out.push(...encodeString(3, input.signingKey));
	out.push(...encodeBytes(101, extensionListBody));
	return new Uint8Array(out);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(
		await new Response(
			new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))
		).arrayBuffer()
	);
}

/** One ordinary extension: one source, a real apk and icon URL. */
function demoExtension(over: Partial<Parameters<typeof extensionBody>[0]> = {}): number[] {
	return extensionBody({
		name: 'Demo Source',
		packageName: 'eu.kanade.tachiyomi.extension.en.demosource',
		resources: resourcesBody({
			apkUrl: 'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk',
			iconUrl:
				'https://cdn.jsdelivr.net/gh/someowner/somerepo@abc123/src/en/demosource/res/mipmap-xxhdpi/ic_launcher.png'
		}),
		extensionLib: '1.5',
		versionCode: 12n,
		versionName: '1.2.3',
		contentWarning: 1,
		sources: [
			sourceBody({
				id: 987654321n,
				name: 'Demo Source',
				language: 'en',
				homeUrl: 'https://source.example.invalid/'
			})
		],
		...over
	});
}

describe('detecting the format', () => {
	it('refuses the deprecated index.min.json stub, naming index.pb as the real one', () => {
		const stub = JSON.stringify([
			{ name: 'Outdated App', pkg: 'eu.kanade.tachiyomi.extension.all.keiyoushi' },
			{ name: 'Update to Mihon 0.20.1+', pkg: 'eu.kanade.tachiyomi.extension.all.mihon' }
		]);

		// An *index* error, not a format one, and the distinction is the whole
		// value of recognising the stub. A format refusal means "not mine, ask
		// the next adapter" — and the next one would take it, because this
		// document's shape is identical to the sibling Kotlin format's real
		// index. Detection propagates an index error, so this sentence is what
		// a viewer sees instead of a catalogue of two placeholders.
		expect(() => mihonAdapter.parseIndex(stub, INDEX_URL)).toThrow(ForeignIndexError);
		expect(() => mihonAdapter.parseIndex(stub, INDEX_URL)).toThrow(/index\.pb/);
	});

	it('never returns a two-listing index for the stub', () => {
		const stub = JSON.stringify([
			{ name: 'Outdated App', pkg: 'eu.kanade.tachiyomi.extension.all.keiyoushi' },
			{ name: 'Update to Mihon 0.20.1+', pkg: 'eu.kanade.tachiyomi.extension.all.mihon' }
		]);
		try {
			mihonAdapter.parseIndex(stub, INDEX_URL);
			expect.unreachable('the stub must throw, not parse');
		} catch (error) {
			expect(error).toBeInstanceOf(ForeignIndexError);
		}
	});

	it('refuses any other JSON as not this format, rather than accepting text at all', () => {
		expect(() => mihonAdapter.parseIndex('{"not":"mihon"}', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => mihonAdapter.parseIndex('[]', INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => mihonAdapter.parseIndex('not even json', INDEX_URL)).toThrow(ForeignFormatError);
	});

	it('does not mistake a real two-extension catalogue for the stub', () => {
		// Same length as the stub, none of the stub's names or packages — the
		// false positive `isStubIndex` must not produce.
		const notAStub = JSON.stringify([
			{ name: 'First Source', pkg: 'eu.kanade.tachiyomi.extension.en.first' },
			{ name: 'Second Source', pkg: 'eu.kanade.tachiyomi.extension.en.second' }
		]);
		// Still refused — this format's real index is never JSON — but for the
		// generic "not a Mihon index" reason, not the stub sentence.
		expect(() => mihonAdapter.parseIndex(notAStub, INDEX_URL)).toThrow(ForeignFormatError);
		expect(() => mihonAdapter.parseIndex(notAStub, INDEX_URL)).not.toThrow(/index\.pb/);
	});
});

describe('parseIndexBytes', () => {
	it('reads a gzipped index', async () => {
		const bytes = await gzip(
			indexBytes({ name: 'Demo Repository', extensions: [demoExtension()] })
		);
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.format).toBe('mihon');
		expect(index.name).toBe('Demo Repository');
		expect(index.plugins).toHaveLength(1);
		expect(index.plugins[0].name).toBe('Demo Source');
	});

	it('reads a plain, ungzipped index the same way', async () => {
		const bytes = indexBytes({ name: 'Demo Repository', extensions: [demoExtension()] });
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.plugins).toHaveLength(1);
		expect(index.plugins[0].name).toBe('Demo Source');
	});

	it('produces one listing per extension, not per source', async () => {
		const bytes = indexBytes({
			extensions: [
				demoExtension({
					sources: [
						sourceBody({
							id: 1n,
							name: 'English',
							language: 'en',
							homeUrl: 'https://en.example.invalid/',
							mirrorUrls: ['https://en-mirror.example.invalid/']
						}),
						sourceBody({
							id: 2n,
							name: 'Japanese',
							language: 'ja',
							homeUrl: 'https://ja.example.invalid/'
						})
					]
				})
			]
		});
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.plugins).toHaveLength(1);
		const detail = index.plugins[0].origin?.detail;
		expect(detail?.['sources']).toHaveLength(2);
	});

	it('collects hosts from every source’s home and mirror URLs', async () => {
		const bytes = indexBytes({
			extensions: [
				demoExtension({
					sources: [
						sourceBody({
							id: 1n,
							name: 'English',
							homeUrl: 'https://en.example.invalid/',
							mirrorUrls: ['https://mirror.example.invalid/']
						})
					]
				})
			]
		});
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		expect(plugin.hosts).toContain('en.example.invalid');
		expect(plugin.hosts).toContain('mirror.example.invalid');
	});

	it('keeps a source id past Number.MAX_SAFE_INTEGER as an exact decimal string', async () => {
		const bigId = 6289731484943315811n;
		const bytes = indexBytes({
			extensions: [demoExtension({ sources: [sourceBody({ id: bigId, name: 'Demo Source' })] })]
		});
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		const sources = plugin.origin?.detail?.['sources'] as Array<{ id: string }>;
		expect(sources[0].id).toBe('6289731484943315811');
		expect(typeof sources[0].id).toBe('string');
		// The rounding this avoids, stated so it cannot be argued with.
		expect(BigInt(Number(bigId))).not.toBe(bigId);
	});

	it('maps every content warning enum value to its label, and NSFW to isNsfw', async () => {
		const cases: Array<[number, string, boolean]> = [
			[0, 'unspecified', false],
			[1, 'safe', false],
			[2, 'mixed', true],
			[3, 'nsfw', true]
		];
		for (const [warning, label, expectNsfw] of cases) {
			const bytes = indexBytes({ extensions: [demoExtension({ contentWarning: warning })] });
			const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;
			expect(plugin.origin?.detail?.['contentRating']).toBe(label);
			expect(plugin.origin?.isNsfw).toBe(expectNsfw);
		}
	});

	it('recovers the source directory from a jsDelivr icon URL', async () => {
		const bytes = indexBytes({
			extensions: [
				demoExtension({
					resources: resourcesBody({
						apkUrl: 'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk',
						iconUrl:
							'https://cdn.jsdelivr.net/gh/someowner/somerepo@deadbeef/src/en/demosource/res/mipmap-xxhdpi/ic_launcher.png'
					})
				})
			]
		});
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		expect(plugin.origin?.detail?.['sourceDir']).toBe('src/en/demosource');
	});

	it('reads the directory off the package name when the icon is borrowed from a theme', async () => {
		// An extension with no launcher icon of its own is published with its
		// theme's, or the repository default's — neither of which is under
		// `src/`. The package name is derived from the directory by the build
		// plugin, so it names the same place the icon would have.
		for (const borrowed of [
			'https://cdn.jsdelivr.net/gh/someowner/somerepo@main/lib-multisrc/sometheme/res/mipmap-xhdpi/ic_launcher.png',
			'https://cdn.jsdelivr.net/gh/someowner/somerepo@main/core/src/main/res/mipmap-xhdpi/ic_launcher.png'
		]) {
			const bytes = indexBytes({
				extensions: [
					demoExtension({
						resources: resourcesBody({
							apkUrl: 'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk',
							iconUrl: borrowed
						})
					})
				]
			});
			const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

			expect(plugin.origin?.detail?.['sourceDir']).toBe('src/en/demosource');
			expect(plugin.origin?.detail?.['sourceRepository']).toBe(
				'https://github.com/someowner/somerepo/tree/main'
			);
		}
	});

	it('answers null for a source directory when the icon is not served from jsDelivr', async () => {
		const bytes = indexBytes({
			extensions: [
				demoExtension({
					resources: resourcesBody({
						apkUrl: 'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk',
						iconUrl: 'https://icons.example.invalid/demosource.png'
					})
				})
			]
		});
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		expect(plugin.origin?.detail?.['sourceDir']).toBeNull();
	});

	it('carries the extension lib version and the artifact URL', async () => {
		const bytes = indexBytes({ extensions: [demoExtension({ extensionLib: '1.5' })] });
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		expect(plugin.origin?.detail?.['extensionLib']).toBe('1.5');
		expect(plugin.origin?.artifactUrl).toBe(
			'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk'
		);
		expect(plugin.download).toBe(plugin.origin?.artifactUrl);
	});

	it('sets every listing’s medium to manga and keeps it', async () => {
		const bytes = indexBytes({ extensions: [demoExtension()] });
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.plugins[0].origin?.mediaKind).toBe('manga');
		expect(index.filteredOut).toBe(0);
	});

	it('skips a row with no package name rather than failing the whole index', async () => {
		const bytes = indexBytes({
			extensions: [demoExtension(), extensionBody({ name: 'No package at all' })]
		});
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.plugins).toHaveLength(1);
	});

	it('skips a row with no artifact URL rather than failing the whole index', async () => {
		const bytes = indexBytes({
			extensions: [
				demoExtension(),
				extensionBody({ name: 'No APK', packageName: 'eu.kanade.tachiyomi.extension.en.noapk' })
			]
		});
		const index = await parseIndexBytes(bytes, INDEX_URL);

		expect(index.plugins).toHaveLength(1);
	});

	it('refuses bytes that are not valid protobuf at all', async () => {
		const garbage = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]);
		await expect(parseIndexBytes(garbage, INDEX_URL)).rejects.toThrow(ForeignFormatError);
	});

	it('refuses well-formed protobuf that is not this schema', async () => {
		// A single string field 1 and nothing under 101 — valid wire format,
		// just not an Index message.
		const bytes = new Uint8Array(encodeString(1, 'Some Other Format'));
		await expect(parseIndexBytes(bytes, INDEX_URL)).rejects.toThrow(ForeignFormatError);
	});
});

describe('candidates', () => {
	it('uses a pasted file URL as given, without appending a path', () => {
		const pasted = new URL('https://raw.githubusercontent.com/owner/repo/main/index.pb');
		expect(mihonAdapter.candidates(pasted)).toEqual([pasted.toString()]);
	});

	it('tries index.pb before index.min.json for a repository URL', () => {
		const pasted = new URL('https://github.com/owner/repo');
		const candidates = mihonAdapter.candidates(pasted);

		const pbIndex = candidates.findIndex((url) => url.endsWith('index.pb'));
		const jsonIndex = candidates.findIndex((url) => url.endsWith('index.min.json'));
		expect(pbIndex).toBeGreaterThanOrEqual(0);
		expect(jsonIndex).toBeGreaterThanOrEqual(0);
		expect(pbIndex).toBeLessThan(jsonIndex);
	});
});

describe('convert', () => {
	it('is not built yet, and says so rather than reading the artifact', async () => {
		const bytes = indexBytes({ extensions: [demoExtension()] });
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;

		await expect(
			mihonAdapter.convert(plugin, {
				fetchArtifact: async () => new Uint8Array(0),
				getText: async () => '',
				listFiles: async () => []
			})
		).rejects.toThrow(ForeignFormatError);
	});

	it('refuses a directory read off the package name when it builds another package', async () => {
		// A module renamed on disk keeps its old application id through
		// `pkgName`, so the directory the package name implies can be a
		// different extension altogether. Translating it would install that one
		// under this one's name; the build file says which, before anything is
		// translated.
		const bytes = indexBytes({
			extensions: [
				demoExtension({
					resources: resourcesBody({
						apkUrl: 'https://raw.githubusercontent.com/owner/repo/repo/apk/en.demosource.apk',
						iconUrl:
							'https://cdn.jsdelivr.net/gh/someowner/somerepo@main/core/src/main/res/mipmap-xhdpi/ic_launcher.png'
					})
				})
			]
		});
		const [plugin] = (await parseIndexBytes(bytes, INDEX_URL)).plugins;
		const directory =
			'https://raw.githubusercontent.com/someowner/somerepo/main/src/en/demosource/';

		await expect(
			mihonAdapter.convert(plugin, {
				fetchArtifact: async () => new Uint8Array(0),
				getText: async (url: string) => {
					if (url === `${directory}build.gradle.kts`) {
						return 'keiyoushi {\n    name = "Renamed"\n    pkgName = "en.renamed"\n}\n';
					}
					if (url === `${directory}src/Renamed.kt`) return '@Source\nabstract class Renamed\n';
					throw new Error(`404 ${url}`);
				},
				listFiles: async (url: string) =>
					url === directory ? [`${directory}src/Renamed.kt`, `${directory}build.gradle.kts`] : []
			})
		).rejects.toThrow(/builds a different extension/);
	});
});
