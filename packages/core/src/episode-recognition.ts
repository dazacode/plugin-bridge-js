/**
 * An episode's number, read out of its own name.
 *
 * A port of Aniyomi's `EpisodeRecognition.kt` (Apache-2.0 — see the repo-root
 * `NOTICE`, which records the derivation). Behaviour, not text: the Kotlin is
 * 138 lines of regex and this is the same algorithm expressed in TypeScript,
 * pinned by tests written against the upstream doc-comment vectors rather than
 * against ours.
 *
 * ## Why port it rather than invent one
 *
 * Numbering is not a private decision. A viewer who watches episode 12 here and
 * then looks the show up somewhere else expects the same 12, and every client in
 * this ecosystem already agrees on *this* function's answers — including its odd
 * ones (`extra` is `.99`, `omake` is `.98`, `special` is `.97`, `.a` is `.1`).
 * Agreeing with the ecosystem is worth more than being independently defensible,
 * so the odd answers are reproduced exactly rather than tidied.
 *
 * ## The lookbehind, and why this is possible now
 *
 * The `\be`/`\bep`/`episode` prefix rule is a regex lookbehind, and
 * `ABI.md` §6 forbade lookbehind because QuickJS and older JavaScriptCore
 * builds did not have it. **ADR-0003 §2.2 repealed that rule**: deleting the
 * Flutter target collapsed three engine families into one engine class, and
 * every host is now a full modern browser engine. This function is the first
 * concrete thing that repeal buys — without the lookbehind, `s02e07` reads as
 * season two rather than episode seven.
 *
 * ## The contract
 *
 * `-1` means "this name states no number". It is not an error and it is not a
 * fallback value to display; it is the signal that the caller's own ordering
 * information — a positional count, say — is the better answer for that row.
 *
 * ## Two consumers, and what keeps them the same
 *
 * Host-side callers import {@link parseEpisodeNumber}. A converted bundle
 * cannot import anything (`ABI.md` §1: one self-contained module, no module
 * resolution inside the sandbox), so it gets
 * {@link EPISODE_RECOGNITION_SOURCE} — a **literal** string constant, written
 * out a second time, exactly as `js-runtime.ts`, `stream-guards.ts` and the
 * Kotlin runtime are. What ships in a bundle is what is reviewable here.
 *
 * Deriving that constant from `parseEpisodeNumber.toString()` was tried and is
 * wrong, and the reason is worth keeping where the next person will find it:
 * `toString()` returns whatever the *bundler* emitted, so the same foreign
 * source converted under `vite dev` and under `vite build` — or under two bun
 * minors, which rename block-scoped identifiers differently — would produce
 * different bundle bytes, different `integrity.json` digests and therefore a
 * different plugin identity for identical input. `FOREIGN.md` §5.1 requires
 * conversion to be deterministic precisely so that a digest is a fact about the
 * input; a build-dependent function body breaks that at conversion time, on a
 * viewer's device, with no gate anywhere near it.
 *
 * So there are two copies, and the spec beside this file is the gate that keeps
 * them one algorithm: it evaluates the emitted constant in an empty scope and
 * runs every vector through **both** halves. That is a stronger check than the
 * byte comparison `check:generated` makes for the HTML parser, because it
 * compares behaviour rather than text — two spellings of the same algorithm
 * pass, and two algorithms do not.
 *
 * Evaluating in an empty scope is also why every helper and regex is declared
 * *inside* the function: the emitted source has to stand alone.
 *
 * No imports, no I/O, no host dependency, by design.
 */

/**
 * The number stated by an episode's name, or `-1` when it states none.
 *
 * @param animeTitle The show's own title, removed from the name before any
 *   number is read. This is the whole defence against a title that contains
 *   digits — without it, `Steins;Gate 0 - 12` reads as episode zero. Pass an
 *   empty string when the title is genuinely unknown.
 * @param episodeName The name the source gave this episode.
 * @param knownNumber A number the source already stated, if it did. Upstream
 *   short-circuits on it; kept so this function's shape matches the one the
 *   ecosystem's tests describe. Converted bundles have no such number, which is
 *   why this module exists.
 */
export function parseEpisodeNumber(
	animeTitle: string,
	episodeName: string,
	knownNumber?: number
): number {
	// Everything is declared inside the function on purpose: this body is also
	// shipped as text into plugin bundles (see EPISODE_RECOGNITION_SOURCE), so
	// it may not reference a single name from module scope.

	// Upstream NUMBER_PATTERN. Group 1 is the episode, group 2 a decimal part,
	// group 3 an alphabetic suffix (`a`, `extra`, `special`, `v` …).
	const numberPattern = '([0-9]+)(\\.[0-9]+)?(\\.?[a-z]+)?';

	// `e.xx`, `exx`, `episode xx`, `ep xx`. The lookbehind is what keeps the
	// season out of `s01e01` — see the module doc-comment.
	const basic = new RegExp('(?<=\\be\\.|\\be|episode|\\bep) *' + numberPattern);
	const firstNumber = new RegExp(numberPattern);
	const everyNumber = new RegExp(numberPattern, 'g');

	// A leading or trailing `[group]` / `(source)` tag.
	const tag = /^\[[^\]]+\]|\[[^\]]+\]\s*$|^\([^)]+\)|\([^)]+\)\s*$/g;
	// Release noise that is a number but is not the episode.
	const unwanted = /\b(?:v|ver|version|season|s)[^a-z]?[0-9]+|\b\d+p\b|hi10/g;
	// `12 special` must become `12special`, so that the suffix joins the number.
	const spaceBeforeSuffix = /\s(?=extra|special|omake)/g;

	if (
		knownNumber !== undefined &&
		knownNumber !== null &&
		(knownNumber === -2 || knownNumber > -1)
	) {
		return knownNumber;
	}

	const unknown = knownNumber === undefined || knownNumber === null ? -1 : knownNumber;

	let clean = episodeName.toLowerCase();

	// Literal, every occurrence — Kotlin's `String.replace(String, String)`.
	// Skipped for an empty title, where a naive split/join would still be a
	// no-op but says nothing about intent.
	const title = animeTitle.toLowerCase();
	if (title.length > 0) clean = clean.split(title).join('');

	clean = clean.trim().split(',').join('.').split('-').join('.').replace(spaceBeforeSuffix, '');

	// Strip tags until there are none. Each pass removes at least one non-empty
	// match, so this terminates; the bound is there because this body also runs
	// inside a sandbox on strings a content source chose.
	for (let pass = 0; pass < 32; pass += 1) {
		tag.lastIndex = 0;
		if (!tag.test(clean)) break;
		clean = clean.replace(tag, '');
	}

	const matches: RegExpExecArray[] = [];
	everyNumber.lastIndex = 0;
	let found = everyNumber.exec(clean);
	while (found !== null) {
		matches.push(found);
		found = everyNumber.exec(clean);
	}

	if (matches.length === 0) return unknown;

	if (matches.length > 1) {
		// More than one candidate, so the noise has to go before choosing.
		const stripped = clean.replace(unwanted, '');

		const prefixed = basic.exec(stripped);
		if (prefixed !== null) return numberFromMatch(prefixed);

		// Searched again rather than reused: the first number may have been the
		// thing that was just removed.
		const plain = firstNumber.exec(stripped);
		if (plain !== null) return numberFromMatch(plain);

		// Upstream falls through here rather than giving up, and so does this.
	}

	return numberFromMatch(matches[0]);

	function numberFromMatch(match: RegExpExecArray): number {
		return Number(match[1]) + fractionFor(match[2], match[3]);
	}

	function fractionFor(decimal: string | undefined, alpha: string | undefined): number {
		if (typeof decimal === 'string' && decimal.length > 0) return Number(decimal);

		if (typeof alpha === 'string' && alpha.length > 0) {
			// Ordered, and `indexOf` rather than equality, because the suffix may
			// carry more than the word.
			if (alpha.indexOf('extra') !== -1) return 0.99;
			if (alpha.indexOf('omake') !== -1) return 0.98;
			if (alpha.indexOf('special') !== -1) return 0.97;

			let trimmed = alpha;
			while (trimmed.charAt(0) === '.') trimmed = trimmed.slice(1);
			if (trimmed.length === 1) return alphaSuffix(trimmed);
		}

		return 0;
	}

	/** `x.a` is `x.1`, `x.b` is `x.2`, and anything past `x.i` is just `x`. */
	function alphaSuffix(letter: string): number {
		const value = letter.charCodeAt(0) - ('a'.charCodeAt(0) - 1);
		if (value >= 10) return 0;
		return value / 10;
	}
}

/**
 * {@link parseEpisodeNumber} as `__episodeNumber(animeTitle, episodeName)`, in
 * bundle source.
 *
 * One string constant rather than anything assembled or derived, so that the
 * bytes a converted bundle carries are these bytes, on every machine and under
 * every build — `FOREIGN.md` §5.1's determinism requirement, and the module
 * doc-comment above says what breaks when it is not honoured.
 *
 * It is a second copy, and the spec beside this file is what keeps it honest:
 * every vector is run through this text as well as through the function above.
 * Edit one and the other fails within the second.
 *
 * ES2020 only, and no `Intl`, `structuredClone`, `Array.prototype.at` or
 * `Object.groupBy` (`ABI.md` §6). The lookbehind in `basic` is the one item on
 * that list ADR-0003 §2.2 repealed.
 */
export const EPISODE_RECOGNITION_SOURCE = `
/* --- episode recognition --------------------------------------------------- */
/* A port of Aniyomi's EpisodeRecognition.kt, Apache-2.0; see this repository's
   NOTICE. The host-side twin is foreign/episode-recognition.ts, and the spec
   beside it runs every vector through both copies. */

function __episodeNumber(animeTitle, episodeName, knownNumber) {
  const numberPattern = '([0-9]+)(\\\\.[0-9]+)?(\\\\.?[a-z]+)?';

  const basic = new RegExp('(?<=\\\\be\\\\.|\\\\be|episode|\\\\bep) *' + numberPattern);
  const firstNumber = new RegExp(numberPattern);
  const everyNumber = new RegExp(numberPattern, 'g');

  const tag = /^\\[[^\\]]+\\]|\\[[^\\]]+\\]\\s*$|^\\([^)]+\\)|\\([^)]+\\)\\s*$/g;
  const unwanted = /\\b(?:v|ver|version|season|s)[^a-z]?[0-9]+|\\b\\d+p\\b|hi10/g;
  const spaceBeforeSuffix = /\\s(?=extra|special|omake)/g;

  if (
    knownNumber !== undefined &&
    knownNumber !== null &&
    (knownNumber === -2 || knownNumber > -1)
  ) {
    return knownNumber;
  }

  const unknown = knownNumber === undefined || knownNumber === null ? -1 : knownNumber;

  let clean = episodeName.toLowerCase();

  const title = animeTitle.toLowerCase();
  if (title.length > 0) clean = clean.split(title).join('');

  clean = clean.trim().split(',').join('.').split('-').join('.').replace(spaceBeforeSuffix, '');

  for (let pass = 0; pass < 32; pass += 1) {
    tag.lastIndex = 0;
    if (!tag.test(clean)) break;
    clean = clean.replace(tag, '');
  }

  const matches = [];
  everyNumber.lastIndex = 0;
  let found = everyNumber.exec(clean);
  while (found !== null) {
    matches.push(found);
    found = everyNumber.exec(clean);
  }

  if (matches.length === 0) return unknown;

  if (matches.length > 1) {
    const stripped = clean.replace(unwanted, '');

    const prefixed = basic.exec(stripped);
    if (prefixed !== null) return numberFromMatch(prefixed);

    const plain = firstNumber.exec(stripped);
    if (plain !== null) return numberFromMatch(plain);
  }

  return numberFromMatch(matches[0]);

  function numberFromMatch(match) {
    return Number(match[1]) + fractionFor(match[2], match[3]);
  }

  function fractionFor(decimal, alpha) {
    if (typeof decimal === 'string' && decimal.length > 0) return Number(decimal);

    if (typeof alpha === 'string' && alpha.length > 0) {
      if (alpha.indexOf('extra') !== -1) return 0.99;
      if (alpha.indexOf('omake') !== -1) return 0.98;
      if (alpha.indexOf('special') !== -1) return 0.97;

      let trimmed = alpha;
      while (trimmed.charAt(0) === '.') trimmed = trimmed.slice(1);
      if (trimmed.length === 1) return alphaSuffix(trimmed);
    }

    return 0;
  }

  /* x.a is x.1, x.b is x.2, and anything past x.i is just x. */
  function alphaSuffix(letter) {
    const value = letter.charCodeAt(0) - ('a'.charCodeAt(0) - 1);
    if (value >= 10) return 0;
    return value / 10;
  }
}
`;
