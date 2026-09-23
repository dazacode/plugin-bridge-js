/**
 * Shared library files that a conversion reads as something other than
 * what they say.
 *
 * The Kotlin extension family keeps helpers in shared modules (`lib/<name>/`)
 * that both the anime and the manga repositories build against. Almost all of
 * them are ordinary Kotlin and are translated like an extension's own files.
 * A module lands here only when its Kotlin is a thin wrapper around a
 * capability this build provides differently, and the wrapper, not the
 * capability, is what stops the conversion.
 *
 * Each entry replaces **one file by its path in one module**, with Kotlin that
 * keeps the upstream object's name, signature and failure answers, and says
 * where the difference went. Nothing is recognised by what a body *does*: the
 * standing rule against recognising intent in arbitrary Kotlin
 * (`docs/adr/0006-local-http-server.md` §5) is about extensions' own code,
 * and a named module's named file is the opposite of that.
 */

/**
 * Where `lib/synchrony` ships its script, relative to the module. The same
 * pattern `source-repo.ts` fetches by.
 */
const SYNCHRONY_SCRIPT_PATH = /^assets\/synchrony-[\w.-]+\.js$/;

/**
 * `lib/synchrony`'s `Deobfuscator`, calling the runtime's `SynchronyEngine`
 * instead of QuickJS.
 *
 * Upstream reads `assets/synchrony-<version>.js` through the classloader,
 * rewrites its export line, evaluates it in a fresh QuickJS and calls
 * `deobfuscateSource` on the site's script, answering null when the asset is
 * missing or its export line is not the expected one. The asset is embedded
 * in the bundle instead (`synchronyScriptOf`), the rewrite is the runtime's
 * (`shims/synchrony.ts`), and both null answers are kept.
 */
const SYNCHRONY_DEOBFUSCATOR = `package keiyoushi.lib.synchrony

object Deobfuscator {
    fun deobfuscateScript(source: String): String? = SynchronyEngine.deobfuscate(source)
}
`;

/** The one file each shim replaces, keyed by module name. */
const REPLACED: ReadonlyMap<string, { readonly file: RegExp; readonly source: string }> = new Map([
	['synchrony', { file: /(?:^|\/)Deobfuscator\.kt$/, source: SYNCHRONY_DEOBFUSCATOR }]
]);

/** A library module's file as the translator should read it. */
export function libraryFileSource(module: string, path: string, source: string): string {
	const shim = REPLACED.get(module);
	return shim !== undefined && shim.file.test(path) ? shim.source : source;
}

/**
 * The synchrony script to embed, when the conversion includes the module.
 *
 * Only then: the script is about 400 KB, and a bundle built without the
 * module should be byte-identical to one converted before this existed. The
 * test is the emitted module naming `SynchronyEngine`, which it does exactly
 * when the replaced wrapper was translated — reachability prunes refusals, not
 * code, so an extension that depends on the module without calling it still
 * carries the wrapper, and so the script it would call.
 * `resources` is the library's asset map as `fetchExtensionSource` read it.
 * The path comes back with the text so the bundle can say what it embedded
 * (`BundleInput.embedded`).
 */
export function synchronyScriptOf(
	emitted: string,
	resources: Iterable<readonly [string, string]>
): { readonly path: string; readonly text: string } | undefined {
	if (!/\bSynchronyEngine\b/.test(emitted)) return undefined;
	for (const [path, text] of resources) {
		if (SYNCHRONY_SCRIPT_PATH.test(path)) return { path: `lib/synchrony/${path}`, text };
	}
	return undefined;
}

/**
 * Whether a resource belongs on the runtime's classpath.
 *
 * The classpath is what `Intl` reads message files from; an embedded script is
 * not a message file, and putting 400 KB of JavaScript into every bundle's
 * resource table would cost that much whether or not anything read it.
 */
export function isClasspathResource(path: string): boolean {
	return !SYNCHRONY_SCRIPT_PATH.test(path);
}
