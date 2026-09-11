/**
 * Reading a foreign extension's preference declaration.
 *
 * The property under test is narrow and it is the one that matters: what comes
 * out must be what the source *said*, and a declaration this reader cannot
 * follow must come out as nothing rather than as a guess. A wrong default here
 * is a plugin pointed at a mirror its author never chose, and nothing
 * downstream can tell that from a deliberate one.
 *
 * Rule 9: every host in this file is invented and under `.invalid`. A real
 * preference default is very often a real base URL, which is exactly why none
 * of them may be written down here.
 */

import { describe, expect, it } from 'vitest';

import { aniyomiPreferences } from '@plugin-bridge/adapters/aniyomi-preferences';
import { mangayomiPreferences, settingKeyMap } from './preferences';

/* ── the JavaScript ecosystem ─────────────────────────────────────────────── */

const JS_SOURCE = `
class DefaultExtension extends MProvider {
  getSourcePreferences() {
    return [{
      key: "preferred_domain",
      listPreference: {
        title: "Preferred domain",
        summary: "Which mirror to use",
        valueIndex: 1,
        entries: ["Main", "Mirror"],
        entryValues: ["https://watch.example.invalid", "https://mirror.example.invalid"]
      }
    }, {
      key: "api_base",
      editTextPreference: {
        title: "API base",
        summary: "",
        value: "https://api.example.invalid"
      }
    }, {
      key: "prefer_dub",
      switchPreferenceCompat: { title: "Prefer dub", summary: "", value: true }
    }, {
      key: "kinds",
      multiSelectListPreference: {
        title: "Kinds",
        entries: ["Sub", "Dub"],
        entryValues: ["sub", "dub"],
        values: ["sub"]
      }
    }];
  }
}
`;

describe('a JavaScript source’s own getSourcePreferences', () => {
	const settings = mangayomiPreferences(JS_SOURCE);

	it('reads every declared preference, in order', () => {
		expect(settings.map((one) => one.id)).toEqual([
			'preferred_domain',
			'api_base',
			'prefer_dub',
			'kinds'
		]);
	});

	it('maps each of the four shapes onto the manifest type it is', () => {
		expect(settings.map((one) => one.type)).toEqual(['select', 'text', 'switch', 'multiselect']);
	});

	it('takes the label a person reads and the value the code gets, separately', () => {
		expect(settings[0].options).toEqual([
			{ value: 'https://watch.example.invalid', label: 'Main' },
			{ value: 'https://mirror.example.invalid', label: 'Mirror' }
		]);
	});

	it('reads the default through valueIndex rather than assuming the first', () => {
		// This is the whole gap: a bundle that declared nothing ran on whichever
		// entry the author happened to list first, which is not what they chose.
		expect(settings[0].default).toBe('https://mirror.example.invalid');
	});

	it('carries the title and summary the source wrote', () => {
		expect(settings[0].label).toBe('Preferred domain');
		expect(settings[0].help).toBe('Which mirror to use');
	});

	it('reads the other three defaults as their own types', () => {
		expect(settings[1].default).toBe('https://api.example.invalid');
		expect(settings[2].default).toBe(true);
		expect(settings[3].default).toEqual(['sub']);
	});

	it('records what the plugin’s own code calls each one', () => {
		expect(settingKeyMap(settings)['preferred_domain']).toBe('preferred_domain');
	});

	it('gives two keys that normalise alike two ids, and maps both', () => {
		const source = `
      getSourcePreferences() {
        return [
          { key: "pref.server", editTextPreference: { title: "A", value: "one" } },
          { key: "pref_server", editTextPreference: { title: "B", value: "two" } }
        ];
      }
    `;
		const rows = mangayomiPreferences(source);
		expect(rows.map((one) => one.id)).toEqual(['pref_server', 'pref_server_2']);
		// Without the emitted map the second would read the first one's value,
		// silently, which is the failure this exists to prevent.
		expect(settingKeyMap(rows)).toEqual({
			'pref.server': 'pref_server',
			pref_server: 'pref_server_2'
		});
	});

	it('declares nothing for a source that declares nothing', () => {
		expect(mangayomiPreferences('class DefaultExtension extends MProvider {}')).toEqual([]);
	});

	it('skips a row it cannot read as a literal, and keeps the rest', () => {
		// A declaration assembled at runtime is absent from the manifest rather
		// than guessed at, and the bundle's own fallback still answers it.
		const source = `
      getSourcePreferences() {
        return [
          { key: computedKey(), editTextPreference: { title: "A", value: "one" } },
          { key: "plain", editTextPreference: { title: "B", value: "two" } }
        ];
      }
    `;
		expect(mangayomiPreferences(source).map((one) => one.id)).toEqual(['plain']);
	});

	it('does not read a template literal that interpolates', () => {
		const source =
			'getSourcePreferences() { return [{ key: "d", editTextPreference: ' +
			'{ title: "D", value: `${this.base}/x` } }]; }';
		expect(mangayomiPreferences(source)[0].default).toBe('');
	});
});

/* ── the Kotlin ecosystem ─────────────────────────────────────────────────── */

const KOTLIN_SOURCE = `
class Example : ParsedAnimeHttpSource(), ConfigurableAnimeSource {
    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        ListPreference(screen.context).apply {
            key = PREF_DOMAIN_KEY
            title = "Preferred domain"
            entries = arrayOf("Main", "Mirror")
            entryValues = arrayOf("https://watch.example.invalid", "https://mirror.example.invalid")
            setDefaultValue("https://mirror.example.invalid")
            summary = "%s"
        }.also(screen::addPreference)

        SwitchPreferenceCompat(screen.context).apply {
            key = "prefer_dub"
            title = "Prefer dub"
            setDefaultValue(true)
        }.also(screen::addPreference)

        EditTextPreference(screen.context).apply {
            key = "custom_base"
            title = "Custom base"
            setDefaultValue("")
        }.also(screen::addPreference)
    }

    companion object {
        private const val PREF_DOMAIN_KEY = "preferred_domain"
    }
}
`;

describe('a Kotlin extension’s own setupPreferenceScreen', () => {
	const settings = aniyomiPreferences(KOTLIN_SOURCE, {
		PREF_DOMAIN_KEY: 'preferred_domain'
	});

	it('reads all three, following a constant to its key', () => {
		// `key = PREF_DOMAIN_KEY` is how nearly every one of these is written,
		// and a reader that could not follow one indirection would read almost
		// nothing.
		expect(settings.map((one) => one.id)).toEqual([
			'preferred_domain',
			'prefer_dub',
			'custom_base'
		]);
	});

	it('maps the constructor name onto the manifest type', () => {
		expect(settings.map((one) => one.type)).toEqual(['select', 'switch', 'text']);
	});

	it('pairs the entries with the values', () => {
		expect(settings[0].options).toEqual([
			{ value: 'https://watch.example.invalid', label: 'Main' },
			{ value: 'https://mirror.example.invalid', label: 'Mirror' }
		]);
	});

	it('takes setDefaultValue as the default, for each type', () => {
		expect(settings[0].default).toBe('https://mirror.example.invalid');
		expect(settings[1].default).toBe(true);
		expect(settings[2].default).toBe('');
	});

	it('declares nothing for an extension that declares nothing', () => {
		expect(aniyomiPreferences('class Example : ParsedAnimeHttpSource()')).toEqual([]);
	});

	it('skips a preference whose key it cannot resolve', () => {
		const source = `
      ListPreference(screen.context).apply {
          key = somethingComputed()
          entryValues = arrayOf("a")
      }.also(screen::addPreference)
    `;
		expect(aniyomiPreferences(source)).toEqual([]);
	});
});
