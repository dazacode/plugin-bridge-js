/**
 * The build-file reader, against files this file writes.
 *
 * Rule 9: every host is `example.invalid`. The shapes are real — each `describe`
 * below is a form that appears in the measured catalogue, and the counts in the
 * comments are how many modules use it — but no catalogue text is copied in.
 *
 * The reader's real proof is not here. It is that, run over the whole catalogue,
 * it reproduces the **published index** exactly: 1,396 of 1,396 modules, 2,371
 * of 2,371 sources, and every language on every one. Those are two independent
 * inputs — a source tree and a protobuf someone else generated — and this file
 * is what stops a change breaking that without saying so.
 */

import { describe, expect, it } from 'vitest';

import { readMihonBuildFile } from './mihon-build-file';

/** The wrapper every one of these files has, so a case states only its body. */
function buildFile(body: string): string {
	return `import io.github.keiyoushi.gradle.api.ContentWarning

plugins {
    alias(kei.plugins.extension)
}

keiyoushi {
${body}
}
`;
}

describe('readMihonBuildFile', () => {
	it('reads the common shape: one source, a static base URL', () => {
		const file = readMihonBuildFile(
			buildFile(`    name = "A Source"
    versionCode = 2
    contentWarning = ContentWarning.SAFE
    libVersion = "1.4"

    source {
        lang = "en"
        baseUrl = "https://example.invalid"
    }`)
		);

		expect(file.name).toBe('A Source');
		expect(file.versionCode).toBe(2);
		expect(file.libVersion).toBe('1.4');
		expect(file.contentWarning).toBe('safe');
		expect(file.theme).toBeNull();
		expect(file.sources).toEqual([
			{
				lang: 'en',
				name: null,
				id: null,
				versionId: null,
				baseUrl: { kind: 'static', url: 'https://example.invalid' }
			}
		]);
	});

	it('reads the template a listing instantiates — 723 of 1,396 declare one', () => {
		const file = readMihonBuildFile(
			buildFile(`    name = "A Source"
    theme = "atemplate"
    source { lang = "en"; baseUrl = "https://example.invalid" }`)
		);
		expect(file.theme).toBe('atemplate');
	});

	it('keeps a pinned source id exactly, because it does not fit in a number', () => {
		const file = readMihonBuildFile(
			buildFile(`    name = "A Source"
    source {
        lang = "all"
        baseUrl = "https://example.invalid"
        id = 4972933717624256217
    }`)
		);
		// Rule 1: an id that rounds is a binding pointing at a different source.
		expect(file.sources[0].id).toBe(4972933717624256217n);
	});

	describe('base URL forms', () => {
		it('reads a mirror list, first being the default', () => {
			const file = readMihonBuildFile(
				buildFile(`    source {
        lang = "all"
        baseUrl {
            mirrors(
                "https://example.invalid",
                "https://mirror.example.invalid",
            )
        }
    }`)
			);
			expect(file.sources[0].baseUrl).toEqual({
				kind: 'mirrors',
				urls: ['https://example.invalid', 'https://mirror.example.invalid']
			});
		});

		it('reads a labelled mirror list as its URLs', () => {
			// `"Label" to "https://…"` names each mirror for the picker; read as
			// plain literals the first label became the base URL.
			const file = readMihonBuildFile(
				buildFile(`    source {
        lang = "ru"
        baseUrl {
            mirrors(
                "Первый" to "https://example.invalid",
                "Second" to "https://mirror.example.invalid",
            )
        }
    }`)
			);
			expect(file.sources[0].baseUrl).toEqual({
				kind: 'mirrors',
				urls: ['https://example.invalid', 'https://mirror.example.invalid']
			});
		});

		it('reads a viewer-supplied URL, and says when there is no default', () => {
			const file = readMihonBuildFile(
				buildFile(`    source {
        lang = "en"
        baseUrl { custom() }
    }`)
			);
			// Not reachable until somebody types one — a fact the host must state.
			expect(file.sources[0].baseUrl).toEqual({ kind: 'custom', url: null });
		});

		it('resolves a base URL hoisted into a val — a named literal is a literal', () => {
			const file = readMihonBuildFile(
				buildFile(`    val theUrl = "https://example.invalid"

    source { lang = "en"; baseUrl = theUrl }
    source { lang = "es"; baseUrl = theUrl }`)
			);
			expect(file.sources.map((source) => source.baseUrl)).toEqual([
				{ kind: 'static', url: 'https://example.invalid' },
				{ kind: 'static', url: 'https://example.invalid' }
			]);
		});
	});

	describe('loops, which declare 226 of the catalogue’s 2,371 sources', () => {
		it('expands an inline list with the implicit binding', () => {
			const file = readMihonBuildFile(
				buildFile(`    listOf("en", "ja", "zh").forEach {
        source {
            lang = it
            baseUrl = "https://example.invalid"
        }
    }`)
			);
			expect(file.sources.map((source) => source.lang)).toEqual(['en', 'ja', 'zh']);
		});

		it('expands a named binding', () => {
			const file = readMihonBuildFile(
				buildFile(`    listOf("en", "fr").forEach { language ->
        source { lang = language; baseUrl = "https://example.invalid" }
    }`)
			);
			expect(file.sources.map((source) => source.lang)).toEqual(['en', 'fr']);
		});

		it('expands a list bound to a val before it is iterated', () => {
			const file = readMihonBuildFile(
				buildFile(`    val languages = listOf("en", "de")

    languages.forEach { language ->
        source { lang = language; baseUrl = "https://example.invalid" }
    }`)
			);
			expect(file.sources.map((source) => source.lang)).toEqual(['en', 'de']);
		});

		it('expands destructured pairs, and puts each half where the binding names it', () => {
			// The second half is usually a pinned id, so guessing which is which
			// would mint a binding pointing at another source (rule 1).
			const file = readMihonBuildFile(
				buildFile(`    val ids = listOf(
        "ar" to 5133570518916566066L,
        "bn" to 4728703871864086205L,
    )

    ids.forEach { (langCode, oldId) ->
        source {
            lang = langCode
            id = oldId
            baseUrl = "https://example.invalid"
        }
    }`)
			);
			expect(file.sources).toEqual([
				{
					lang: 'ar',
					name: null,
					id: 5133570518916566066n,
					versionId: null,
					baseUrl: { kind: 'static', url: 'https://example.invalid' }
				},
				{
					lang: 'bn',
					name: null,
					id: 4728703871864086205n,
					versionId: null,
					baseUrl: { kind: 'static', url: 'https://example.invalid' }
				}
			]);
		});

		it('substitutes a binding inside a string, where a URL is built from it', () => {
			const file = readMihonBuildFile(
				buildFile(`    val subdomains = mapOf("pt-BR" to "br", "es" to "es")

    subdomains.forEach { (langCode, sub) ->
        source {
            lang = langCode
            baseUrl = "https://$sub.example.invalid"
        }
    }`)
			);
			expect(file.sources.map((source) => source.baseUrl)).toEqual([
				{ kind: 'static', url: 'https://br.example.invalid' },
				{ kind: 'static', url: 'https://es.example.invalid' }
			]);
		});

		it('mixes an expanded loop with a source declared beside it', () => {
			const file = readMihonBuildFile(
				buildFile(`    val theUrl = "https://example.invalid"

    listOf("en", "es").forEach {
        source { lang = it; baseUrl = theUrl }
    }
    source {
        name = "A Source (No Text)"
        lang = "other"
        baseUrl = theUrl
    }`)
			);
			expect(file.sources.map((source) => source.lang)).toEqual(['en', 'es', 'other']);
			expect(file.sources[2].name).toBe('A Source (No Text)');
		});
	});

	describe('what it refuses to read, rather than guess', () => {
		it('leaves a loop whose elements are not literals, declaring no source from it', () => {
			const file = readMihonBuildFile(
				buildFile(`    supportedLanguages().forEach {
        source { lang = it; baseUrl = "https://example.invalid" }
    }`)
			);
			// Absent, not invented. The caller counts the module as unread.
			expect(file.sources).toEqual([]);
		});

		it('leaves a loop whose binding does not match the element arity', () => {
			const file = readMihonBuildFile(
				buildFile(`    listOf("en", "ja").forEach { (a, b) ->
        source { lang = a; baseUrl = "https://example.invalid" }
    }`)
			);
			expect(file.sources).toEqual([]);
		});

		it('does not read a base URL that is assembled rather than declared', () => {
			const file = readMihonBuildFile(
				buildFile(`    source {
        lang = "en"
        baseUrl = defaultHost() + "/manga"
    }`)
			);
			expect(file.sources[0].baseUrl).toBeNull();
		});

		it('does not read a commented-out declaration', () => {
			const file = readMihonBuildFile(
				buildFile(`    name = "A Source"
    // theme = "atemplate"
    /* source { lang = "ja"; baseUrl = "https://old.example.invalid" } */
    source { lang = "en"; baseUrl = "https://example.invalid" }`)
			);
			expect(file.theme).toBeNull();
			expect(file.sources.map((source) => source.lang)).toEqual(['en']);
		});

		it('is not fooled by the // inside every base URL it reads', () => {
			const file = readMihonBuildFile(
				buildFile(`    name = "A Source"
    source { lang = "en"; baseUrl = "https://example.invalid/a//b" }`)
			);
			expect(file.sources[0].baseUrl).toEqual({
				kind: 'static',
				url: 'https://example.invalid/a//b'
			});
		});

		it('never throws on a file it cannot make sense of', () => {
			expect(() => readMihonBuildFile('')).not.toThrow();
			expect(() => readMihonBuildFile('keiyoushi { name = ')).not.toThrow();
			expect(readMihonBuildFile('').sources).toEqual([]);
			expect(readMihonBuildFile('').contentWarning).toBe('unspecified');
		});
	});

	describe('the rest of the module', () => {
		it('reads the shared library modules a listing depends on', () => {
			// ABI.md §8.4 has no vocabulary for these yet, so reading the
			// declaration is how a conversion refuses by name and is counted.
			const file = readMihonBuildFile(
				`${buildFile(`    name = "A Source"
    source { lang = "ja"; baseUrl = "https://example.invalid" }`)}
dependencies {
    implementation(project(":lib:speedbinb"))
    implementation(project(":lib:randomua"))
    implementation(project(":lib:speedbinb"))
}
`
			);
			expect(file.libModules).toEqual(['speedbinb', 'randomua']);
		});

		it('reads all three content ratings', () => {
			const rating = (value: string) =>
				readMihonBuildFile(buildFile(`    contentWarning = ContentWarning.${value}`))
					.contentWarning;
			expect(rating('SAFE')).toBe('safe');
			expect(rating('MIXED')).toBe('mixed');
			expect(rating('NSFW')).toBe('nsfw');
		});

		it('reads the package-name override, which is a suffix and not a package', () => {
			// It replaces the `<lang>.<dir>` tail, so a caller that used it whole
			// would look up a package the index does not contain.
			const file = readMihonBuildFile(buildFile(`    pkgName = "en.asource"`));
			expect(file.pkgName).toBe('en.asource');
		});

		it('ignores a deeplink block, which declares nothing a conversion needs', () => {
			const file = readMihonBuildFile(
				buildFile(`    source { lang = "en"; baseUrl = "https://example.invalid" }
    deeplink {
        host("example.invalid")
        path("/comic/..*")
    }`)
			);
			expect(file.sources).toHaveLength(1);
		});
	});
});
