/**
 * Reaching an extension's sources instead of its binary.
 *
 * Every fixture here is hand-written and every fetcher is fake. Nothing in this
 * file touches the network, and per rule 9 no repository, site or content
 * source is named: `github.com` and `raw.githubusercontent.com` appear because
 * `git-hosts.ts` builds those URLs, and everything else is `example.invalid`.
 *
 * The two properties worth testing hardest are the ones a caller cannot check
 * for itself: that a package name out of a foreign index cannot steer a path
 * out of the directory it names, and that every URL this module constructs is
 * https.
 */

import { describe, expect, it } from 'vitest';

import { TreeError } from './git-trees';

import {
	MAX_KOTLIN_FILES,
	MAX_LIB_FILES,
	MAX_LIB_MODULES,
	MAX_SOURCE_BYTES,
	MAX_SOURCE_FILES,
	MAX_THEME_FILES,
	extensionDirectory,
	fetchExtensionSource,
	fetchSharedSources,
	libDependencies,
	libDirectory,
	locationCandidates,
	matchDirectory,
	newSharedCache,
	newSourceBudget,
	readBuildGradle,
	sourceRepositoryOf,
	themeDirectory,
	type SourceLocation
} from './source-repo';

const REPO = 'https://github.com/owner/sources';
const RAW = 'https://raw.githubusercontent.com/owner/sources';

/** A getText/listFiles pair over a hand-written filesystem, recording every URL asked for. */
function fakeRepository(files: Record<string, string>) {
	const asked: string[] = [];

	const getText = async (url: string): Promise<string> => {
		asked.push(url);
		const body = files[url];
		if (body === undefined) throw new Error(`404 ${url}`);
		return body;
	};

	const listFiles = async (url: string): Promise<readonly string[]> => {
		asked.push(url);
		return Object.keys(files)
			.filter((path) => path.startsWith(url) && path.length > url.length)
			.map((path) => path.slice(url.length));
	};

	return { asked, getText, listFiles };
}

describe('the source repository a metadata document points at', () => {
	it('is read out of meta.website', () => {
		const body = JSON.stringify({
			meta: { name: 'Some extensions', website: REPO }
		});
		expect(sourceRepositoryOf(body)).toBe(REPO);
	});

	it('is normalised, so a link to a page inside the repository still resolves', () => {
		// People link what was in the address bar, which is usually a page in
		// the repository rather than its root.
		const body = JSON.stringify({
			meta: {
				website: 'https://forge.example/owner/sources/blob/main/README.md'
			}
		});
		expect(sourceRepositoryOf(body)).toBe('https://forge.example/owner/sources');
	});

	it('keeps a branch the link named', () => {
		const body = JSON.stringify({ meta: { website: `${REPO}/tree/nightly` } });
		expect(sourceRepositoryOf(body)).toBe(`${REPO}/tree/nightly`);
	});

	it('is null when the field names something that is not a repository', () => {
		// That field is a free-text homepage as often as it is a source link,
		// and the caller's next move is the same either way.
		expect(
			sourceRepositoryOf(JSON.stringify({ meta: { website: 'https://example.invalid/' } }))
		).toBeNull();
		expect(sourceRepositoryOf(JSON.stringify({ meta: { name: 'no website' } }))).toBeNull();
		expect(sourceRepositoryOf(JSON.stringify({ meta: { website: 42 } }))).toBeNull();
		expect(sourceRepositoryOf('not json at all')).toBeNull();
		expect(sourceRepositoryOf('[]')).toBeNull();
	});

	it('refuses a link that is not https', () => {
		// A cleartext link is one anybody on the path can rewrite, and rewriting
		// it here would point conversion at somebody else's Kotlin.
		const body = JSON.stringify({
			meta: { website: 'http://forge.example/owner/sources' }
		});
		expect(sourceRepositoryOf(body)).toBeNull();
	});
});

describe('candidate locations for one extension', () => {
	it('puts the package’s last segment under the stated language first', () => {
		const candidates = locationCandidates(REPO, 'org.example.animeextension.en.somename', 'en');
		expect(candidates[0]).toEqual({
			repositoryUrl: REPO,
			lang: 'en',
			directory: 'somename'
		});
	});

	it('offers a lowercased variant when the package segment is not lowercase', () => {
		const candidates = locationCandidates(REPO, 'org.example.animeextension.en.SomeName', 'en');
		expect(candidates.slice(0, 2).map((candidate) => candidate.directory)).toEqual([
			'SomeName',
			'somename'
		]);
	});

	it('falls back to `all`, where a multi-language extension is filed', () => {
		const candidates = locationCandidates(REPO, 'org.example.animeextension.en.somename', 'en');
		expect(candidates.some((candidate) => candidate.lang === 'all')).toBe(true);
		// After the stated language, never before it: the index states the
		// language, and only the directory name is a guess.
		expect(candidates.findIndex((candidate) => candidate.lang === 'all')).toBeGreaterThan(0);
	});

	it('does not repeat a language when the extension already declares `all`', () => {
		const candidates = locationCandidates(REPO, 'org.example.animeextension.all.somename', 'all');
		expect(candidates.filter((candidate) => candidate.lang === 'all')).toHaveLength(
			candidates.length
		);
		expect(candidates).toHaveLength(1);
	});

	it('is empty for anything that is not an https repository', () => {
		expect(locationCandidates('http://github.com/owner/sources', 'a.b.c', 'en')).toEqual([]);
		expect(locationCandidates('https://example.invalid/', 'a.b.c', 'en')).toEqual([]);
		expect(locationCandidates('not a url', 'a.b.c', 'en')).toEqual([]);
	});

	it('refuses a package or language that would climb out of the directory', () => {
		// The package name comes out of a foreign index, so it is attacker-shaped
		// input the moment it is concatenated into a path.
		expect(locationCandidates(REPO, 'org.example.en.a/b/../../etc', 'en')).toEqual([]);
		// A bad language drops that language rather than the extension: the
		// language is only ever a directory name. What is left is the package's
		// own language segment — which came from the same index but is a plain
		// segment, and is what the build compiled under — and then `all`.
		expect(locationCandidates(REPO, 'org.example.en.somename', '../..')).toEqual([
			{ repositoryUrl: REPO, lang: 'en', directory: 'somename' },
			{ repositoryUrl: REPO, lang: 'all', directory: 'somename' }
		]);
		// And a traversal in the package's language segment is dropped the same
		// way, leaving only `all`.
		expect(locationCandidates(REPO, 'org.example.../..\u002esomename', '../..')).toEqual([
			{ repositoryUrl: REPO, lang: 'all', directory: 'somename' }
		]);
		// Dots are the package separator, so a traversal written with them is
		// destroyed by the split and can only ever yield one plain segment.
		expect(
			locationCandidates(REPO, 'org.example.en...somename', 'en').every(
				(candidate) => candidate.directory === 'somename'
			)
		).toBe(true);
	});
});

describe('matching a package against a directory listing', () => {
	const names = ['alpha', 'SomeName', 'somenameextra', 'other'];

	it('prefers an exact name', () => {
		expect(matchDirectory(names, 'org.example.en.alpha')).toBe('alpha');
	});

	it('matches case-insensitively', () => {
		expect(matchDirectory(names, 'org.example.en.somename')).toBe('SomeName');
	});

	it('accepts a suffix only when nothing better exists', () => {
		expect(matchDirectory(['somenameextra', 'unrelated'], 'org.example.en.somename')).toBe(
			'somenameextra'
		);
	});

	it('takes the shortest overlap, since a shorter one ignored less', () => {
		expect(matchDirectory(['somenamelonger', 'somenamex'], 'org.example.en.somename')).toBe(
			'somenamex'
		);
	});

	it('is null when nothing there looks like it', () => {
		expect(matchDirectory(names, 'org.example.en.nothinglikeit')).toBeNull();
		expect(matchDirectory([], 'org.example.en.alpha')).toBeNull();
		expect(matchDirectory(names, '')).toBeNull();
	});
});

describe('reading a build file', () => {
	it('picks the declared fields out of an ext block', () => {
		const declared = readBuildGradle(`
			ext {
				extName = 'Some Name'
				extClass = '.SomeSource'
				extVersionCode = 12
				isNsfw = true
			}

			apply from: "$rootDir/common.gradle"
		`);
		expect(declared).toMatchObject({
			extName: 'Some Name',
			extClass: '.SomeSource',
			extVersionCode: '12',
			isNsfw: 'true'
		});
	});

	it('finds the theme package, which is the field the whole thing is for', () => {
		// An extension generated from a shared template is a thin subclass whose
		// site-specific parts are constants; porting the template once converts
		// every extension built on it.
		const declared = readBuildGradle("ext {\n themePkg = 'sometheme'\n }\n");
		expect(declared['themePkg']).toBe('sometheme');
	});

	it('reads the Kotlin DSL spelling and double quotes too', () => {
		const declared = readBuildGradle('val extName = "Some Name"\next.themePkg = "sometheme"\n');
		expect(declared).toMatchObject({
			extName: 'Some Name',
			themePkg: 'sometheme'
		});
	});

	it('ignores a commented-out assignment', () => {
		const declared = readBuildGradle(`
			// extName = 'Wrong'
			/* themePkg = 'wrong' */
			extName = 'Right'
		`);
		expect(declared['extName']).toBe('Right');
		expect(declared['themePkg']).toBeUndefined();
	});

	it('does not mistake the slashes in a URL for a comment', () => {
		const declared = readBuildGradle("baseUrl = 'https://example.invalid/path' // a real comment");
		expect(declared['baseUrl']).toBe('https://example.invalid/path');
	});

	it('lets a later assignment win, as Gradle does', () => {
		expect(readBuildGradle('extVersionCode = 1\nextVersionCode = 7\n')['extVersionCode']).toBe('7');
	});

	it('is empty for a file that declares nothing', () => {
		expect(readBuildGradle('dependencies {\n implementation(project(":lib:shared"))\n}\n')).toEqual(
			{}
		);
	});
});

describe('reading the helper modules a build file declares', () => {
	it('reads the Groovy spelling', () => {
		// `implementation project(':lib:name')`, single-quoted.
		const declared = libDependencies(`
			dependencies {
				implementation project(':lib:someextractor')
				compileOnly project(':lib:another')
			}
		`);
		expect(declared).toEqual(['someextractor', 'another']);
	});

	it('reads the Kotlin DSL spelling', () => {
		// `implementation(project(":lib:name"))`, double-quoted. The two spellings
		// differ only in their quotes, which is why one pattern covers both.
		const declared = libDependencies(
			'dependencies {\n implementation(project(":lib:someextractor"))\n}\n'
		);
		expect(declared).toEqual(['someextractor']);
	});

	it('ignores a commented-out dependency', () => {
		// A line somebody commented out is a line somebody decided not to build
		// against, and fetching it would be fetching a module that was dropped.
		const declared = libDependencies(`
			dependencies {
				// implementation(project(":lib:retired"))
				/* implementation(project(":lib:alsoretired")) */
				implementation(project(":lib:live"))
			}
		`);
		expect(declared).toEqual(['live']);
	});

	it('does not mistake an assignment for a dependency, or the reverse', () => {
		// The two readers exist separately because a dependency is a call and an
		// assignment is not, and neither regex finds the other's shape.
		expect(libDependencies("ext {\n themePkg = 'sometheme'\n}\n")).toEqual([]);
		expect(readBuildGradle('implementation(project(":lib:someextractor"))\n')).toEqual({});
	});

	it('drops a name that is not one path segment, rather than repairing it', () => {
		// These become directory names in a URL. A module named `../../etc` is a
		// foreign repository asking this client to fetch somewhere of its
		// choosing, and trimming it to something plausible would grant that
		// request in a shape nobody reviewed.
		expect(libDependencies("implementation project(':lib:../../etc')")).toEqual([]);
		expect(libDependencies('implementation(project(":lib:/etc/passwd"))')).toEqual([]);
		expect(libDependencies('implementation(project(":lib:a/b"))')).toEqual([]);
		expect(libDependencies('implementation(project(":lib:.hidden"))')).toEqual([]);
		expect(libDependencies('implementation(project(":lib:"))')).toEqual([]);
	});

	it('names each module once, however many times it is declared', () => {
		expect(
			libDependencies(
				'implementation(project(":lib:shared"))\ncompileOnly(project(":lib:shared"))\n'
			)
		).toEqual(['shared']);
	});

	it('ignores a project dependency that is not a lib module', () => {
		expect(libDependencies('implementation(project(":core"))')).toEqual([]);
		expect(libDependencies('implementation(project(":lib-multisrc:sometheme"))')).toEqual([]);
	});
});

describe('paths in the layout convention', () => {
	it('names an extension directory, a theme directory and a lib directory', () => {
		const location: SourceLocation = {
			repositoryUrl: REPO,
			lang: 'en',
			directory: 'somename'
		};
		expect(extensionDirectory(location)).toBe('src/en/somename');
		expect(themeDirectory('sometheme')).toBe('lib-multisrc/sometheme');
		expect(libDirectory('someextractor')).toBe('lib/someextractor');
	});
});

describe('fetching one located extension', () => {
	const location: SourceLocation = {
		repositoryUrl: REPO,
		lang: 'en',
		directory: 'somename'
	};
	const dir = `${RAW}/main/src/en/somename/`;

	const gradle = "ext {\n extName = 'Some Name'\n themePkg = 'sometheme'\n}\n";
	const kotlin = 'package org.example.animeextension.en.somename\n\nclass SomeSource\n';

	it('reads the build file, the theme and the Kotlin beside it', async () => {
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradle,
			[`${dir}src/org/example/SomeSource.kt`]: kotlin,
			[`${dir}res/icon.png`]: 'not kotlin'
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.buildGradle).toBe(gradle);
		expect(source.themePackage).toBe('sometheme');
		expect([...source.kotlinFiles]).toEqual([['src/org/example/SomeSource.kt', kotlin]]);
		// Keyed relative to the extension directory, and nothing that is not
		// Kotlin was fetched.
		expect(asked).not.toContain(`${dir}res/icon.png`);
	});

	it('asks for nothing that is not https', async () => {
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradle,
			[`${dir}src/A.kt`]: kotlin
		});

		await fetchExtensionSource(location, listFiles, getText);

		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every((url) => url.startsWith('https://'))).toBe(true);
	});

	it('settles the branch once, on the build file, and reuses it', async () => {
		// The default branch is probed by fetching one file rather than by
		// fetching every file twice.
		const masterDir = `${RAW}/master/src/en/somename/`;
		const { getText, listFiles, asked } = fakeRepository({
			[`${masterDir}build.gradle`]: gradle,
			[`${masterDir}src/A.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect([...source.kotlinFiles.keys()]).toEqual(['src/A.kt']);
		expect(asked.filter((url) => url.indexOf('/main/') !== -1)).toHaveLength(1);
	});

	it('still reads the sources when there is no build file', async () => {
		const { getText, listFiles } = fakeRepository({
			[`${dir}src/A.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.buildGradle).toBeNull();
		expect(source.themePackage).toBeNull();
		expect([...source.kotlinFiles.keys()]).toEqual(['src/A.kt']);
	});

	it('accepts a Kotlin DSL build file as the fallback spelling', async () => {
		const { getText, listFiles } = fakeRepository({
			[`${dir}build.gradle.kts`]: 'themePkg = "sometheme"\n'
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.themePackage).toBe('sometheme');
	});

	it('is empty rather than an exception when the extension is not there', async () => {
		// The caller's response to a miss is to try the next candidate, and an
		// exception per miss would make the ordinary path the exceptional one.
		const { getText, listFiles } = fakeRepository({});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source).toEqual({
			buildGradle: null,
			kotlinFiles: new Map(),
			themePackage: null,
			themeFiles: new Map(),
			libModules: new Map(),
			resolvedRef: null
		});
	});

	it('keeps what it could read when one file fails', async () => {
		const files: Record<string, string> = {
			[`${dir}build.gradle`]: gradle,
			[`${dir}src/A.kt`]: kotlin
		};
		const { getText, listFiles } = fakeRepository(files);
		const listPlusOneMissing = async (url: string) => [...(await listFiles(url)), 'src/Gone.kt'];

		const source = await fetchExtensionSource(location, listPlusOneMissing, getText);

		expect([...source.kotlinFiles.keys()]).toEqual(['src/A.kt']);
	});

	it('never follows a listing entry that points outside the directory', async () => {
		const { getText, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradle,
			[`${dir}src/A.kt`]: kotlin
		});
		const listOffsite = async () => [
			'src/A.kt',
			'http://elsewhere.example/Cleartext.kt',
			'https://elsewhere.example/Https.kt',
			'../../other/Sibling.kt'
		];

		const source = await fetchExtensionSource(location, listOffsite, getText);

		// A listing is a claim about one directory. An entry naming somewhere
		// else — cleartext, another origin, or a climb up the tree — is a URL
		// somebody else chose, and is not worth a request.
		expect([...source.kotlinFiles.keys()]).toEqual(['src/A.kt']);
		expect(asked.some((url) => url.indexOf('elsewhere.example') !== -1)).toBe(false);
		expect(asked.some((url) => url.indexOf('/other/') !== -1)).toBe(false);
	});

	it('caps how many files one extension may cost', async () => {
		const files: Record<string, string> = { [`${dir}build.gradle`]: gradle };
		for (let index = 0; index < MAX_KOTLIN_FILES + 20; index += 1) {
			files[`${dir}src/File${String(index).padStart(3, '0')}.kt`] = kotlin;
		}
		const { getText, listFiles } = fakeRepository(files);

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.kotlinFiles.size).toBe(MAX_KOTLIN_FILES);
		// Sorted, so the same extension read twice drops the same files.
		expect([...source.kotlinFiles.keys()][0]).toBe('src/File000.kt');
	});

	it('refuses a location whose parts would climb out of the repository', async () => {
		const { getText, listFiles, asked } = fakeRepository({});

		const source = await fetchExtensionSource(
			{ repositoryUrl: REPO, lang: 'en', directory: '../../../etc' },
			listFiles,
			getText
		);

		expect(source.kotlinFiles.size).toBe(0);
		expect(asked).toEqual([]);
	});
});

describe('fetching the template and the modules an extension shares', () => {
	const location: SourceLocation = {
		repositoryUrl: REPO,
		lang: 'en',
		directory: 'somename'
	};
	const dir = `${RAW}/main/src/en/somename/`;
	const themeDir = `${RAW}/main/lib-multisrc/sometheme/`;
	const libDir = (name: string) => `${RAW}/main/lib/${name}/`;

	const kotlin = 'package org.example\n\nclass Anything\n';

	/** A build file declaring a template, some modules, or both. */
	function gradleFor(themePkg: string | null, libs: readonly string[]): string {
		const ext = themePkg === null ? '' : `ext {\n themePkg = '${themePkg}'\n}\n`;
		const deps = libs.map((name) => ` implementation(project(":lib:${name}"))`).join('\n');
		return `${ext}dependencies {\n${deps}\n}\n`;
	}

	it('fetches the template the build file names', async () => {
		// The template holds the method bodies the extension inherits and never
		// restates; without it the conversion has a subclass and no superclass.
		const { getText, listFiles } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor('sometheme', []),
			[`${dir}src/A.kt`]: kotlin,
			[`${themeDir}src/Template.kt`]: kotlin,
			[`${themeDir}README.md`]: 'not kotlin'
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.themePackage).toBe('sometheme');
		expect([...source.themeFiles]).toEqual([['src/Template.kt', kotlin]]);
	});

	it('asks for nothing under the template root when no template is declared', async () => {
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor(null, []),
			[`${dir}src/A.kt`]: kotlin,
			[`${themeDir}src/Template.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.themePackage).toBeNull();
		expect(source.themeFiles.size).toBe(0);
		expect(asked.some((url) => url.indexOf('lib-multisrc') !== -1)).toBe(false);
	});

	it("leaves a library's test sources out of the extension", async () => {
		// Gradle builds the extension against `src/`, never against `test/`. This
		// read was "every .kt under the module", so unit tests arrived as library
		// code: three of them declared the same `PACKED_CALL` — nothing in Kotlin,
		// and "Identifier 'PACKED_CALL' has already been declared" once emitted
		// into one module. Everything in them also counted as obstacles against
		// any extension that merely depended on the library.
		const dsl = 'dependencies {\n implementation(project(":lib:unpacker"))\n}\n';
		const { getText, listFiles } = fakeRepository({
			[`${dir}build.gradle`]: dsl,
			[`${dir}src/A.kt`]: kotlin,
			[`${libDir('unpacker')}src/keiyoushi/lib/Unpacker.kt`]: kotlin,
			[`${libDir('unpacker')}test/kotlin/keiyoushi/lib/UnpackerTest.kt`]: kotlin,
			[`${libDir('unpacker')}androidTest/kotlin/keiyoushi/lib/OnDevice.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect([...(source.libModules.get('unpacker')?.keys() ?? [])]).toEqual([
			'src/keiyoushi/lib/Unpacker.kt'
		]);
	});

	it('fetches the modules the build file names, in either Gradle spelling', async () => {
		// `videoListParse` and `getVideoList` delegate to these; a conversion
		// without them is a call to a function that is not there.
		const groovy = "dependencies {\n implementation project(':lib:groovymodule')\n}\n";
		const dsl = 'dependencies {\n implementation(project(":lib:dslmodule"))\n}\n';
		const { getText, listFiles } = fakeRepository({
			[`${dir}build.gradle`]: `${groovy}${dsl}`,
			[`${dir}src/A.kt`]: kotlin,
			[`${libDir('groovymodule')}src/One.kt`]: kotlin,
			[`${libDir('dslmodule')}src/Two.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect([...source.libModules.keys()].sort()).toEqual(['dslmodule', 'groovymodule']);
		expect([...(source.libModules.get('dslmodule') ?? [])]).toEqual([['src/Two.kt', kotlin]]);
	});

	it('does not fetch a module the build file commented out', async () => {
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]:
				'dependencies {\n // implementation(project(":lib:retired"))\n implementation(project(":lib:live"))\n}\n',
			[`${dir}src/A.kt`]: kotlin,
			[`${libDir('retired')}src/One.kt`]: kotlin,
			[`${libDir('live')}src/Two.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect([...source.libModules.keys()]).toEqual(['live']);
		expect(asked.some((url) => url.indexOf('/retired/') !== -1)).toBe(false);
	});

	it('drops a template or module name that would climb out of the repository', async () => {
		// The names come out of a foreign build file, so they are attacker-shaped
		// the moment they are concatenated into a path. A failing name is dropped,
		// never trimmed into something that would resolve.
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: [
				"ext {\n themePkg = '../../../etc'\n}\n",
				'dependencies {\n implementation(project(":lib:../../etc"))\n',
				' implementation(project(":lib:/absolute"))\n}\n'
			].join(''),
			[`${dir}src/A.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.themeFiles.size).toBe(0);
		expect(source.libModules.size).toBe(0);
		expect(asked.some((url) => url.indexOf('..') !== -1)).toBe(false);
		expect(asked.some((url) => url.indexOf('/etc') !== -1)).toBe(false);
		expect(asked.some((url) => url.indexOf('/absolute') !== -1)).toBe(false);
		// And the extension itself is still readable: one bad name in a build
		// file is not a reason to abandon the sources beside it.
		expect([...source.kotlinFiles.keys()]).toEqual(['src/A.kt']);
	});

	it('never follows a template or module listing entry that points elsewhere', async () => {
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor('sometheme', ['somemodule']),
			[`${dir}src/A.kt`]: kotlin,
			[`${themeDir}src/Template.kt`]: kotlin,
			[`${libDir('somemodule')}src/One.kt`]: kotlin
		});
		const listOffsite = async (url: string): Promise<readonly string[]> => [
			...(await listFiles(url)),
			'http://elsewhere.example/Cleartext.kt',
			'https://elsewhere.example/Https.kt',
			'../../other/Sibling.kt'
		];

		const source = await fetchExtensionSource(location, listOffsite, getText);

		expect([...source.themeFiles.keys()]).toEqual(['src/Template.kt']);
		expect([...(source.libModules.get('somemodule') ?? new Map()).keys()]).toEqual(['src/One.kt']);
		expect(asked.some((url) => url.indexOf('elsewhere.example') !== -1)).toBe(false);
		expect(asked.some((url) => url.indexOf('/other/') !== -1)).toBe(false);
	});

	it('costs no extra ref probes: the branch that answered is the branch reused', async () => {
		// A dozen modules re-probing two refs across two forge shapes would be
		// dozens of requests whose only possible outcome is 404, which is why the
		// ref settled on `build.gradle` is carried rather than rediscovered.
		const master = `${RAW}/master/`;
		const { getText, listFiles, asked } = fakeRepository({
			[`${master}src/en/somename/build.gradle`]: gradleFor('sometheme', ['somemodule']),
			[`${master}src/en/somename/src/A.kt`]: kotlin,
			[`${master}lib-multisrc/sometheme/src/Template.kt`]: kotlin,
			[`${master}lib/somemodule/src/One.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.resolvedRef).toBe('master');
		expect(source.themeFiles.size).toBe(1);
		expect(source.libModules.size).toBe(1);
		// Exactly one request ever named the other ref: the build-file probe that
		// settled the question in the first place.
		expect(asked.filter((url) => url.indexOf('/main/') !== -1)).toHaveLength(1);
		expect(asked.every((url) => url.startsWith('https://'))).toBe(true);
	});

	it('follows a module’s own dependencies one level, and then stops', async () => {
		// Following the chain to its end would make this client's request count a
		// property of somebody else's repository. A symbol still unresolved past
		// depth 1 is the transpiler's to refuse, not this module's to chase.
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor(null, ['first']),
			[`${dir}src/A.kt`]: kotlin,
			[`${libDir('first')}build.gradle`]: gradleFor(null, ['second']),
			[`${libDir('first')}src/One.kt`]: kotlin,
			[`${libDir('second')}build.gradle`]: gradleFor(null, ['third']),
			[`${libDir('second')}src/Two.kt`]: kotlin,
			[`${libDir('third')}src/Three.kt`]: kotlin
		});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect([...source.libModules.keys()]).toEqual(['first', 'second']);
		// The bound is on the *edge*, not on the read: what the depth-1 module
		// declares is looked at and not followed. Reading it is what lets the
		// same module answer from the cache when the next listing reaches it at
		// depth 0, instead of costing a second look at the same build file.
		expect(asked.some((url) => url.indexOf('/third/') !== -1)).toBe(false);
	});

	it('spends one budget across all three groups, so separate caps cannot multiply', async () => {
		const libs = Array.from({ length: MAX_LIB_MODULES }, (_, index) => `module${index}`);
		const files: Record<string, string> = {
			[`${dir}build.gradle`]: gradleFor('sometheme', libs)
		};
		const pad = (index: number) => String(index).padStart(3, '0');
		for (let index = 0; index < MAX_KOTLIN_FILES; index += 1) {
			files[`${dir}src/File${pad(index)}.kt`] = kotlin;
		}
		for (let index = 0; index < MAX_THEME_FILES; index += 1) {
			files[`${themeDir}src/Theme${pad(index)}.kt`] = kotlin;
		}
		for (const name of libs) {
			for (let index = 0; index < MAX_LIB_FILES; index += 1) {
				files[`${libDir(name)}src/Lib${pad(index)}.kt`] = kotlin;
			}
		}
		const { getText, listFiles } = fakeRepository(files);

		const source = await fetchExtensionSource(location, listFiles, getText);

		const total =
			source.kotlinFiles.size +
			source.themeFiles.size +
			[...source.libModules.values()].reduce((sum, module) => sum + module.size, 0);

		// The per-group caps between them would have allowed far more; the shared
		// budget is what makes the total a number this module chose.
		expect(MAX_KOTLIN_FILES + MAX_THEME_FILES + MAX_LIB_MODULES * MAX_LIB_FILES).toBeGreaterThan(
			MAX_SOURCE_FILES
		);
		expect(total).toBe(MAX_SOURCE_FILES);
		expect(source.libModules.size).toBeLessThan(MAX_LIB_MODULES);
		// The extension itself is read first, so a greedy template or a long
		// module list can only cost what is left after it.
		expect(source.kotlinFiles.size).toBe(MAX_KOTLIN_FILES);
	});

	it('reads a shared directory once per repository, not once per listing', async () => {
		// The largest of the three multipliers. Across a 254-extension catalogue
		// the extensions declare 862 module dependencies between them and only 58
		// distinct modules, so without this every module's files are fetched
		// about fifteen times to produce the same bytes — 3,268 file requests for
		// a whole-catalogue pass instead of 1,068.
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor('sometheme', ['somemodule']),
			[`${dir}src/A.kt`]: kotlin,
			[`${themeDir}src/Template.kt`]: kotlin,
			[`${libDir('somemodule')}src/One.kt`]: kotlin
		});
		const cache = newSharedCache();

		const first = await fetchExtensionSource(location, listFiles, getText, cache);
		const afterFirst = asked.length;
		const second = await fetchExtensionSource(location, listFiles, getText, cache);

		// The same files, and the second listing paid for none of them.
		expect([...second.themeFiles]).toEqual([...first.themeFiles]);
		expect([...(second.libModules.get('somemodule') ?? new Map())]).toEqual([
			['src/One.kt', kotlin]
		]);
		const later = asked.slice(afterFirst);
		expect(later.some((url) => url.indexOf('lib-multisrc') !== -1)).toBe(false);
		expect(later.some((url) => url.indexOf('/lib/') !== -1)).toBe(false);
		// What is re-read is what belongs to the listing: its build file and its
		// own Kotlin, and nothing shared.
		expect(later.every((url) => url.startsWith(dir))).toBe(true);
	});

	it('reads every shared directory afresh when the caller keeps no cache', async () => {
		// The default, and right for a single conversion: a cache is a statement
		// about a repository the caller intends to keep asking about.
		const { getText, listFiles, asked } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor('sometheme', []),
			[`${dir}src/A.kt`]: kotlin,
			[`${themeDir}src/Template.kt`]: kotlin
		});

		await fetchExtensionSource(location, listFiles, getText);
		const afterFirst = asked.length;
		await fetchExtensionSource(location, listFiles, getText);

		expect(asked.slice(afterFirst).some((url) => url.indexOf('lib-multisrc') !== -1)).toBe(true);
	});

	it('does not remember a shared read that ran out of budget', async () => {
		// What a truncated read produced is a property of one listing's budget
		// rather than of the directory. Caching it would make every later listing
		// inherit a truncation it did not cause, and the conversion would then
		// refuse a member for being absent rather than for being untranslatable.
		const files: Record<string, string> = {
			[`${dir}build.gradle`]: gradleFor('sometheme', [])
		};
		const pad = (index: number) => String(index).padStart(3, '0');
		for (let index = 0; index < MAX_KOTLIN_FILES; index += 1) {
			files[`${dir}src/File${pad(index)}.kt`] = kotlin;
		}
		for (let index = 0; index < MAX_THEME_FILES; index += 1) {
			files[`${themeDir}src/Theme${pad(index)}.kt`] = kotlin;
		}
		const { getText, listFiles } = fakeRepository(files);
		const cache = newSharedCache();

		// A budget too small to finish the template, then a full one.
		await fetchSharedSources(
			`${RAW}/main/`,
			'sometheme',
			[],
			listFiles,
			getText,
			{
				files: 4,
				bytes: MAX_SOURCE_BYTES
			},
			cache
		);
		const full = await fetchSharedSources(
			`${RAW}/main/`,
			'sometheme',
			[],
			listFiles,
			getText,
			newSourceBudget(),
			cache
		);

		expect(full.themeFiles.size).toBe(MAX_THEME_FILES);
	});

	it('reports the ref that answered, so a caller can build from the same one', async () => {
		const { getText, listFiles } = fakeRepository({
			[`${dir}build.gradle`]: gradleFor(null, []),
			[`${dir}src/A.kt`]: kotlin
		});

		expect((await fetchExtensionSource(location, listFiles, getText)).resolvedRef).toBe('main');
	});
});

describe('a listing that failed, rather than a directory that is empty', () => {
	const location: SourceLocation = { repositoryUrl: REPO, lang: 'en', directory: 'somename' };

	it('lets the failure out instead of answering "nothing there"', async () => {
		// The bug this exists for, reported from the app: every listing in one
		// catalogue read "The source for X could not be found in the repository
		// it is built from", over sources sitting in that repository. One tree
		// document serves every listing in a repository, so when reading it
		// fails they all fail together — and this function turned that into an
		// empty file map, which the adapter reports as the sentence above.
		//
		// The forge rate-limiting this address is the commonest way in: 60
		// requests an hour, unauthenticated, counted per address, and in a
		// browser that address is the viewer's.
		const getText = async (): Promise<string> => {
			throw new Error('unreachable in this test');
		};
		const listFiles = async (): Promise<readonly string[]> => {
			throw new TreeError('the code host is rate-limiting this address', { rateLimited: true });
		};

		await expect(fetchExtensionSource(location, listFiles, getText)).rejects.toThrow(
			/rate-limiting/
		);
	});

	it('still reads a directory that really is empty as empty', async () => {
		// The other half, and why this is not simply "throw on anything": a
		// directory that is not there does not throw. The lister filters a tree
		// it read successfully by prefix and answers none, which is a fact about
		// the repository and is allowed to be reported as one.
		const { getText, listFiles } = fakeRepository({});

		const source = await fetchExtensionSource(location, listFiles, getText);

		expect(source.kotlinFiles.size).toBe(0);
	});
});
