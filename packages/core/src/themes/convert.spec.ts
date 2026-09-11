/**
 * Whether an extension can be rebuilt from its template, and what it says when
 * it cannot.
 *
 * The refusals are the interesting half. Most extensions in these ecosystems
 * override more of their template than can be read without running it, so
 * "no" is the common answer and the quality of the sentence attached to it is
 * most of this module's value. A refusal that names the members responsible is
 * something a person can act on and a future translator can be aimed at; "not
 * supported" is neither.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { matchTheme, themeIdOf } from './convert';
import { registerTheme, type Theme } from './engine';
import type { KotlinSource } from '../kotlin/reader';

/** A stand-in template, so these tests do not depend on any real one. */
const STUB: Theme = {
	id: 'stubtheme',
	settings: ['episodeListSelector', 'popularAnimeSelector'],
	async search() {
		return { entries: [], hasMore: false };
	},
	async episodes() {
		return [];
	},
	async streams() {
		return [];
	}
};

beforeAll(() => registerTheme(STUB));

function source(over: Partial<KotlinSource> = {}): KotlinSource {
	return {
		packageName: 'com.example.animeextension.en.demo',
		className: 'Demo',
		superClass: 'StubTheme',
		stringConstants: {
			name: 'Demo',
			baseUrl: 'https://example.invalid',
			lang: 'en'
		},
		intConstants: {},
		boolConstants: {},
		stringLists: {},
		unreadableOverrides: [],
		imports: [],
		...over
	} as KotlinSource;
}

describe('finding the template', () => {
	it('matches a superclass to its directory, through package and type arguments', () => {
		expect(themeIdOf('StubTheme')).toBe('stubtheme');
		expect(themeIdOf('com.example.lib.StubTheme<Foo>')).toBe('stubtheme');
		// `Stub` should also reach `stubtheme`: some directories carry the suffix
		// and some do not, so both spellings are tried rather than assuming one.
		expect(themeIdOf('Stub')).toBe('stubtheme');
	});

	it('is null for a base class this build has no template for', () => {
		expect(themeIdOf('ParsedAnimeHttpLegacySource')).toBeNull();
		expect(themeIdOf(null)).toBeNull();
	});
});

describe('a thin subclass', () => {
	it('converts, carrying only the settings its template reads', () => {
		const match = matchTheme(
			source({
				stringConstants: {
					name: 'Demo',
					baseUrl: 'https://example.invalid',
					lang: 'en',
					episodeListSelector: '.eps > li',
					somethingElse: 'ignored'
				}
			}),
			'en'
		);

		expect(match.refusal).toBeNull();
		expect(match.theme?.id).toBe('stubtheme');
		expect(match.config?.overrides).toEqual({
			episodeListSelector: '.eps > li'
		});
		expect(match.appliedOverrides).toEqual(['episodeListSelector']);
		// Declared, unread, and reported rather than dropped: a constant nobody
		// consumes usually means the template moved and the mapping is stale.
		expect(match.unusedOverrides).toEqual(['somethingElse']);
	});

	it('normalises the base URL so no template has to think about it', () => {
		expect(matchTheme(source(), 'en').config?.baseUrl).toBe('https://example.invalid/');
	});

	it('is still thin when it only overrides things the host draws itself', () => {
		// Settings screens, filter lists and per-host stream extractors are all
		// out of scope by design, so overriding them changes nothing for us.
		const match = matchTheme(
			source({
				unreadableOverrides: [
					'preferences',
					'setupPreferenceScreen',
					'getFilterList',
					'TypeFilter',
					'someExtractor',
					'sortVideos'
				]
			}),
			'en'
		);
		expect(match.refusal).toBeNull();
		expect(match.blockedBy).toEqual([]);
	});
});

describe('refusing, precisely', () => {
	it('names the members that stood in the way', () => {
		const match = matchTheme(
			source({
				unreadableOverrides: ['episodeListParse', 'videoListParse', 'preferences']
			}),
			'en'
		);

		expect(match.theme).toBeNull();
		expect(match.blockedBy).toEqual(['episodeListParse', 'videoListParse']);
		expect(match.refusal).toContain('episodeListParse');
		expect(match.refusal).toContain('videoListParse');
		// `preferences` is not an obstacle and must not be listed as one.
		expect(match.refusal).not.toContain('preferences');
	});

	it('says so when the base class is not a template at all', () => {
		const match = matchTheme(source({ superClass: 'ParsedAnimeHttpLegacySource' }), 'en');
		expect(match.refusal).toContain('ParsedAnimeHttpLegacySource');
		expect(match.blockedBy).toEqual([]);
	});

	it('refuses a base URL that cannot be read, or is not https', () => {
		expect(
			matchTheme(source({ stringConstants: { name: 'D', lang: 'en' } }), 'en').refusal
		).toMatch(/base URL/);
		expect(
			matchTheme(source({ stringConstants: { baseUrl: 'http://example.invalid' } }), 'en').refusal
		).toMatch(/base URL/);
	});

	it('never returns a config alongside a refusal', () => {
		// The one invariant a caller relies on: a refusal is not a partial
		// success it can press on with.
		for (const bad of [
			source({ superClass: 'Unknown' }),
			source({ unreadableOverrides: ['searchAnimeParse'] }),
			source({ stringConstants: {} })
		]) {
			const match = matchTheme(bad, 'en');
			expect(match.refusal).not.toBeNull();
			expect(match.config).toBeNull();
			expect(match.theme).toBeNull();
		}
	});
});
