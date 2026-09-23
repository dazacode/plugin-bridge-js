/**
 * The synchrony deobfuscator, embedded from the extension's own repository.
 *
 * A shared library module in the Kotlin extension family, `lib/synchrony`,
 * ships a fixed, prebuilt copy of the synchrony deobfuscator as
 * `assets/synchrony-<version>.js` and a one-object Kotlin wrapper that runs it
 * in QuickJS. The wrapper is replaced at conversion time (see
 * `adapters/src/library-shims.ts`) by one that calls `SynchronyEngine` in the
 * Kotlin runtime, and this module turns the script itself into the factory
 * that engine calls.
 *
 * What is run is the repository's file, never anything a site sent: the
 * site's script is `deobfuscateSource`'s *argument*, which synchrony parses
 * and rewrites as a syntax tree. That is why this is not the embedded
 * JavaScript engine the boundary refuses (`docs/phase-2-capability-map.md`:
 * "narrow, named unpackers only — never arbitrary evaluation").
 *
 * The rewrite is the upstream wrapper's, to the character: the script ends in
 * an ES module export, `export{a as Deobfuscator,b as Transformer};`, which
 * QuickJS cannot take as a script, so the wrapper replaces that line with
 * bindings. Here it becomes the factory's return value instead, so the
 * script's own top-level names stay inside the factory's scope rather than
 * joining the bundle's. When the line is not there, the wrapper returns null
 * and so does this: no factory is emitted, and `SynchronyEngine.deobfuscate`
 * answers null, which every caller already checks for.
 *
 * `console` is a parameter with no-op methods, as the wrapper made it, because
 * the script logs its progress and a bundle has no business writing to the
 * host's console on every chapter.
 */

/** The upstream wrapper's pattern for the export line, unchanged. */
const EXPORT_LINE = /export\{(.*) as Deobfuscator,(.*) as Transformer\};/;

/**
 * Bundle source that installs the script as `SynchronyEngine`'s factory, or
 * the empty string when there is no usable script — in which case the
 * runtime's default, a factory of null, stands.
 */
export function synchronyPrelude(script: string | undefined): string {
	if (script === undefined) return '';
	const exported = EXPORT_LINE.exec(script);
	if (exported === null) return '';
	const [line, deobfuscator, transformer] = exported;
	// A replacer function, because `$` in the script is not a substitution.
	const body = script.replace(
		line,
		() => `return { Deobfuscator: ${deobfuscator}, Transformer: ${transformer} };`
	);
	return [
		'/* --- lib/synchrony, embedded from the source repository ----------------- */',
		'__synchronyFactory = function () {',
		'  return (function (console) {',
		body,
		'  })({ log: function () {}, warn: function () {}, error: function () {}, trace: function () {}, info: function () {}, debug: function () {} });',
		'};'
	].join('\n');
}
