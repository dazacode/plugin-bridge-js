/**
 * That an episode's name is read the way the rest of the ecosystem reads it.
 *
 * These vectors are written against **upstream's** behaviour, not ours. The
 * first block is the examples in `EpisodeRecognition.kt`'s own doc-comments,
 * transcribed; the rest are the cases that decide whether the port is worth
 * having, most of all the one the rejected alternative got wrong — a show whose
 * *title* contains a number.
 *
 * Series titles appear here because upstream's own test vectors are series
 * titles. A series is not a content source (AGENTS.md rule 9); no site,
 * extractor, CDN or catalogue is named anywhere in this file.
 */

import { describe, expect, it } from 'vitest';

import { EPISODE_RECOGNITION_SOURCE, parseEpisodeNumber } from './episode-recognition';

/** Every vector, so both the imported function and the emitted source see all of them. */
const VECTORS: readonly (readonly [string, string, number])[] = [
	// --- upstream's own doc-comment examples ---------------------------------
	// `basic`: "kaguya-sama wa kokurasetai - s01e01v2 (BD 1080p HEVC) -R> 01"
	['', 'kaguya-sama wa kokurasetai - s01e01v2 (BD 1080p HEVC)', 1],
	// `number`: "Bleach 567: Down With Snowwhite -R> 567"
	['Bleach', 'Bleach 567: Down With Snowwhite', 567],
	// `unwantedWhiteSpace`: "One Piece 12 special -R> One Piece 12special"
	['One Piece', 'One Piece 12 special', 12.97],

	// --- a title that contains digits ----------------------------------------
	// The exact failure the positional guess was preferred over: reading a
	// number out of the name reorders a season whose *title* has one. Removing
	// the title first is what makes name-derived numbering safe at all.
	['Steins;Gate 0', 'Steins;Gate 0 - 12', 12],
	['Mobile Suit Gundam 00', 'Mobile Suit Gundam 00 Episode 5', 5],
	['86', '86 - Episode 7', 7],

	// --- the prefixes ---------------------------------------------------------
	['', 'Ep 12', 12],
	['', 'Ep. 12', 12],
	['', 'E.12', 12],
	['', 'Episode 12', 12],
	// The lookbehind doing its job: two candidates, and the season must lose.
	['Show', '[Group] Show - S02E07 (1080p)', 7],

	// --- a recap between two episodes ----------------------------------------
	['', 'Episode 12.5', 12.5],
	['Show', 'Show - 12.5 Recap', 12.5],

	// --- the ecosystem's odd suffixes ----------------------------------------
	['One Piece', 'One Piece 12 extra', 12.99],
	['One Piece', 'One Piece 12 omake', 12.98],
	['Bleach', 'Bleach 567.a', 567.1],
	['Bleach', 'Bleach 567.i', 567.9],
	// Past `.i` upstream gives up and returns the whole number.
	['Bleach', 'Bleach 567.j', 567],

	// --- release noise --------------------------------------------------------
	['Show', 'Show - 07v2', 7],
	['Show', 'Show - Episode 07 v2', 7],
	['Show', 'Show 07 1080p', 7],
	['Show', 'Show - 07 [1080p]', 7],
	['Show', 'Show 07 hi10', 7],

	// --- and the name that states nothing ------------------------------------
	['Show', 'Show - Finale', -1],
	['', 'Special', -1],
	['', '', -1]
];

describe('reading an episode number out of its name', () => {
	for (const [title, name, expected] of VECTORS) {
		it(`reads ${JSON.stringify(name)} as ${expected}`, () => {
			expect(parseEpisodeNumber(title, name)).toBeCloseTo(expected, 10);
		});
	}

	it('returns -1 rather than throwing when the name states no number', () => {
		// -1 is a contract, not an accident: it is the signal a caller falls
		// back on its own ordering with. Anything >= 0 is an answer, including
		// zero, because a prologue numbered 0 is a real episode.
		expect(parseEpisodeNumber('Show', 'Show - Prologue')).toBe(-1);
		expect(parseEpisodeNumber('Show', 'Show - Episode 0')).toBe(0);
	});

	it('does not read the title as the number even when the name adds none', () => {
		// The whole title is removed, so what is left states nothing and the
		// caller is told so — rather than being handed the year in the title.
		expect(parseEpisodeNumber('Fate/stay night [2006]', 'Fate/stay night [2006] - Prologue')).toBe(
			-1
		);
	});

	it('short-circuits on a number the source already stated', () => {
		// Kept from upstream so the shape matches; no converted format we
		// support states one, which is the reason this module exists.
		expect(parseEpisodeNumber('Show', 'Show - Finale', 24)).toBe(24);
		expect(parseEpisodeNumber('Show', 'Show - Episode 3', 24)).toBe(24);
		// -1 is upstream's "not known", so it does not short-circuit.
		expect(parseEpisodeNumber('Show', 'Show - Episode 3', -1)).toBe(3);
	});

	it('terminates on a name that is nothing but tags', () => {
		// The tag strip is a loop, and this body runs in a sandbox on strings a
		// content source chose. A pathological name must return, not hang.
		expect(parseEpisodeNumber('', '[a][b][c][d][e][f][g][h]')).toBe(-1);
		expect(parseEpisodeNumber('', '('.repeat(200) + ')'.repeat(200))).toBe(-1);
	});
});

/**
 * The bundle copy, and why this block is the drift gate.
 *
 * A converted bundle cannot import anything, so the algorithm exists twice: the
 * function above, and a literal string constant beside it. It is written out
 * twice rather than derived from `toString()` because `FOREIGN.md` §5.1 makes
 * conversion deterministic — a function body that reflects whatever the bundler
 * emitted would give the same foreign source different bundle bytes, and so a
 * different plugin identity, under `vite dev` and `vite build`, or under two
 * bun minors.
 *
 * Two copies need a gate, and this is it: every vector runs through both. It
 * compares behaviour rather than bytes, which is a stronger test than the one
 * `check:generated` makes for the HTML parser — two spellings of the same
 * algorithm pass, and two algorithms do not.
 */
describe('the copy that ships inside a converted bundle', () => {
	/** The emitted source, evaluated in an empty scope — no module, no imports. */
	const inBundle = new Function(
		`${EPISODE_RECOGNITION_SOURCE}\nreturn __episodeNumber;`
	)() as typeof parseEpisodeNumber;

	it('is self-contained: it evaluates with nothing in scope', () => {
		// If the copy ever reaches for a module-level regex or helper, this is
		// where it fails — long before a viewer sees every converted plugin die
		// at `load` with a ReferenceError.
		expect(typeof inBundle).toBe('function');
	});

	it('answers identically to the host-side function on every vector', () => {
		// Edit one copy and not the other, and this is the failure. It is the
		// only thing standing between the two, so it is deliberately the whole
		// vector table rather than a sample of it.
		for (const [title, name, expected] of VECTORS) {
			expect(inBundle(title, name)).toBeCloseTo(expected, 10);
		}
	});

	it('is a literal constant rather than something a build produced', () => {
		// `FOREIGN.md` §5.1: converting the same input twice produces
		// byte-identical output, so a digest is a fact about the input. A body
		// obtained from `parseEpisodeNumber.toString()` is a fact about the
		// bundler instead, and would drag the host-side name in with it. This
		// is what that regression looks like from here.
		expect(EPISODE_RECOGNITION_SOURCE).toContain('function __episodeNumber(');
		expect(EPISODE_RECOGNITION_SOURCE).not.toContain('parseEpisodeNumber');
	});

	it('names no host symbol the sandbox does not have', () => {
		// A bundle gets `ctx` and nothing else. These are the globals a shim
		// would most plausibly reach for by accident.
		expect(EPISODE_RECOGNITION_SOURCE).not.toMatch(
			/\b(?:require|import|fetch|window|globalThis)\b/
		);
	});
});
