/**
 * One extension's Kotlin sources in, one verdict out.
 *
 * ## Why the cheap reader runs first, every time
 *
 * `grammar.ts` hides a 4 MB wasm behind a dynamic import precisely so a viewer
 * who never converts anything never pays for it. That only holds if the caller
 * can learn something useful *before* reaching for it, and `reader.ts` is that
 * something: a token walk that yields `name`, `baseUrl`, `lang`, the base class
 * and the list of members it could not read, in microseconds and with no
 * dependency. Those constants are what a listing needs in order to be shown at
 * all — `FOREIGN.md` §1 calls a browse-only entry a first-class outcome — and
 * they are needed whether or not translation then succeeds.
 *
 * So the order is: read, then decide whether parsing is worth it, then parse
 * and translate. `convertKotlin` runs the whole thing; `readKotlinFast` is the
 * first half on its own, for a caller that only wants the catalogue row.
 *
 * ## What a result is allowed to claim
 *
 * `complete` is true only when nothing the host will actually call was refused.
 * It is deliberately not "enough members translated": the eight method families
 * that matter are not separable — an extension whose `videoListParse` is
 * missing installs, searches and plays nothing, and one whose
 * `episodeListParse` is missing installs, searches and shows the wrong
 * episodes. A partial conversion is the failure mode `themes/convert.ts` and
 * `FOREIGN.md` §6 exist to prevent, so this module reports the parts and lets
 * the integrator decide, but it never calls a partial result a success.
 *
 * `complete` is also **not sufficient**, and that is worth stating rather than
 * leaving each caller to rediscover. An extension built on a shared template
 * declares almost nothing of its own — every real method lives in the template,
 * which is not in the file — so everything it declares translates, `complete`
 * comes back true, and the bundle packages, installs, loads, and answers a
 * search with silence. `substantive` is the second half: did the conversion
 * produce a member the host will actually call. A caller wants both.
 *
 * The one softening is `blocking`, and it is the softening
 * `themes/convert.ts` already makes: a converted bundle declares no settings
 * and ports no extractors, so an overridden `setupPreferenceScreen` is refused
 * and then never called by anything. Those refusals are still reported, still
 * named, and still in `refusals` — they simply do not stop a build. Nothing
 * that returns data is on that list.
 *
 * `message` is the sentence a person reads, in `matchTheme`'s voice: it names
 * the obstacles and says what converting anyway would cost.
 *
 * ## What this deliberately does not do
 *
 * It does not build a bundle, write a manifest, or know what an adapter is.
 * The integration into `adapters/aniyomi.ts` is somebody else's file, and
 * keeping this one ignorant of it is what lets the survey and the specs run it
 * over hundreds of files with nothing mocked.
 *
 * ## Rule 9
 *
 * No hostname anywhere. This module takes text and returns text.
 */

import { ValidationFailure } from '@plugin-bridge/core/errors';
import type { WasmLoader } from '@plugin-bridge/host/host';
import { frameBudget } from '../scheduling';
import { type KotlinTree } from './ast';
import { loadKotlinGrammar, type KotlinParser } from './grammar';
import {
	declaredIn,
	emitKotlin,
	mergeDeclared,
	type Declared,
	type Emission,
	type MemberEdges
} from './emit';
import { readKotlin, type KotlinSource } from './reader';
import { RUNTIME_GLOBALS } from './runtime-api';
import {
	ABI_MEMBERS,
	describeRefusals,
	HOST_ENTRY_POINTS,
	isHostDrawn,
	type Refusal
} from './subset';

/** One `.kt` file, named so a refusal can say which one it came from. */
export interface KotlinFile {
	/** A path or a display name. Never fetched, never resolved. */
	readonly path: string;
	readonly source: string;
}

/** What one file became, on its own. */
export interface FileConversion {
	readonly path: string;
	readonly js: string;
	readonly translated: readonly string[];
	readonly refusals: readonly Refusal[];
	readonly fileRefusal: string | null;
}

/** Everything the caller needs to decide whether to build a bundle. */
export interface KotlinConversion {
	/**
	 * What the token reader made of the entry file: `baseUrl`, `name`, `lang`,
	 * the base class, and the members it could not read. Present even when
	 * translation fails outright, because a browse-only listing still wants it.
	 */
	readonly constants: KotlinSource;
	readonly className: string | null;
	readonly superClass: string | null;
	/** The emitted module bodies, joined in the order the files were given. */
	readonly js: string;
	readonly perFile: readonly FileConversion[];
	/** Every refused member across every file, entry file first. */
	readonly refusals: readonly Refusal[];
	/**
	 * The subset of `refusals` a caller should stop for.
	 *
	 * A converted bundle declares no settings and ports no extractors, so an
	 * override of `setupPreferenceScreen` or `getFilterList` is refused and
	 * nothing ever calls it — the distinction `themes/convert.ts` draws between
	 * a member that matters and one the host draws itself. Everything is still
	 * in `refusals`; this only says which of them block.
	 */
	readonly blocking: readonly Refusal[];
	/**
	 * Members the host can actually reach, across every file given.
	 *
	 * The closure of `HOST_ENTRY_POINTS` and the entry file's own members over
	 * the call graph. A refusal outside it is reported and does not block.
	 */
	readonly reachable: readonly string[];
	/** `__k` helper names the emitted code calls, sorted. */
	readonly usedRuntime: readonly string[];
	/** Members translated in full, across every file. */
	readonly translated: readonly string[];
	/**
	 * The translated members the host will actually call, in `ABI_MEMBERS` order
	 * of appearance.
	 *
	 * `complete` and this are different questions, and conflating them is a
	 * mistake worth designing against. An extension that extends a shared
	 * template declares almost nothing of its own; everything it declares then
	 * translates, `complete` comes back true, and the bundle installs and
	 * answers a search with silence. Empty here means there is nothing to build
	 * a bundle from, whatever `complete` says.
	 */
	readonly abiMembers: readonly string[];
	/**
	 * True when nothing the host will actually call was refused.
	 *
	 * Deliberately not "enough members translated": the eight families that
	 * matter are not separable, and a partial conversion is the failure mode
	 * `FOREIGN.md` §6 exists to catch.
	 *
	 * **Necessary and not sufficient.** Read it with `substantive`: a file that
	 * declares nothing satisfies it trivially.
	 */
	readonly complete: boolean;
	/**
	 * True when the conversion produced something the host can call.
	 *
	 * `complete && substantive` is the pair a caller should build a bundle on.
	 * Either alone is a way to ship an empty plugin.
	 */
	readonly substantive: boolean;
	/** The refusal, written for a person, or `null` when there is nothing to say. */
	readonly message: string | null;
}

/** Injected so a spec can supply a parser without loading the grammar. */
export interface ConvertOptions {
	readonly parser?: KotlinParser;
	/**
	 * Where the vendored parser artefacts come from, when one has to be built.
	 *
	 * The host's (`HOST.md` §2.2), threaded down here rather than resolved in
	 * `grammar.ts`, because a runtime that can find its own assets has taken a
	 * capability nobody granted it. Ignored when `parser` is supplied, and
	 * required when it is not: a conversion that cannot parse is a refusal
	 * naming the missing capability, not a crash three frames further in.
	 */
	readonly wasm?: WasmLoader;
	/**
	 * Whether to give the host a turn between files.
	 *
	 * On by default, because the caller is usually the main thread and a
	 * repository check is nine seconds of it. Off inside `translate.worker.ts`:
	 * there is nothing to paint in a worker and no other message being served
	 * while one is in flight, so yielding there costs about 7% and buys nobody
	 * anything.
	 */
	readonly interleave?: boolean;
}

/**
 * The token reader on its own, for a caller that only wants the catalogue row.
 *
 * Costs nothing and loads nothing. Everything it returns is also on the full
 * conversion's `constants`, so a caller that is going to convert anyway should
 * not call both.
 */
export function readKotlinFast(source: string): KotlinSource {
	return readKotlin(source);
}

/**
 * Reads, parses and translates one extension.
 *
 * The first file is the entry: its class supplies `className` and
 * `superClass`, and its constants are the ones returned. The rest are the
 * DTOs and helpers that sit beside it in the same source tree, translated into
 * the same module so the entry class can call them.
 *
 * A file whose *class header* could not be parsed stops the whole conversion —
 * every member below such a header is being read against a guess — and the
 * result carries that as a refusal naming the file.
 */
export async function convertKotlin(
	files: readonly KotlinFile[],
	options: ConvertOptions = {}
): Promise<KotlinConversion> {
	const entry = files[0];
	const constants = readKotlin(entry?.source ?? '');

	if (files.length === 0) {
		return empty(constants, 'No Kotlin source was given to translate.');
	}

	const parse = options.parser ?? (await loadKotlinGrammar(requireWasm(options.wasm)));

	const perFile: FileConversion[] = [];
	const graph: MemberEdges[] = [];
	const entryMembers = new Set<string>();
	const refusals: Refusal[] = [];
	const translated: string[] = [];
	const used = new Set<string>();
	const bodies: string[] = [];
	let className: string | null = null;
	let superClass: string | null = null;

	// Every file is parsed once and surveyed before any is translated. An
	// extension declares its filters in `SomethingFilters.kt` and calls
	// `params.getQuery()` from `Something.kt`, and a per-file emitter cannot
	// tell that method from one no declaration in reach defines — so it refused
	// the call, and with it the member and the extension. The trees are kept
	// rather than re-parsed: parsing is the expensive half.
	const trees = new Map<string, KotlinTree>();
	const surveyed: Declared[] = [];
	// Parsing is the heaviest synchronous stage and a repository check runs it
	// for every file of every listing. Yielding on a budget keeps a long run
	// from freezing the page without paying a task hop per file — see
	// `../scheduling.ts`.
	const breathe = options.interleave === false ? async (): Promise<void> => {} : frameBudget();

	// Kept per file as well as merged: which file declared a name decides
	// whether that file's `Video` is its own or the runtime's. See
	// `localRenames`.
	const declaredByFile = new Map<string, Declared>();

	for (const file of files) {
		await breathe();
		try {
			const tree = parse(file.source);
			trees.set(file.path, tree);
			const declared = declaredIn(tree);
			declaredByFile.set(file.path, declared);
			surveyed.push(declared);
		} catch {
			// Left out of `trees`; the emit loop below reports it as a refused
			// file, which is where that message already lives.
		}
	}
	const neighbours = mergeDeclared(surveyed);
	const renames = localRenames(files, declaredByFile);

	for (const file of files) {
		await breathe();
		let emission: Emission;
		try {
			const tree = trees.get(file.path);
			emission = emitKotlin(
				tree ?? parse(file.source),
				neighbours,
				renames.get(file.path),
				file === entry
			);
		} catch (error) {
			// A throw here is the parser itself failing, not a refusal — the
			// emitter turns everything it understands into a refusal and
			// everything it does not into `Untranslatable`. Reporting it as a
			// refused file keeps the invariant that nothing vanishes quietly.
			const reason = error instanceof Error ? error.message : String(error);
			perFile.push({
				path: file.path,
				js: '',
				translated: [],
				refusals: [],
				fileRefusal: `\`${file.path}\` could not be parsed (${reason}).`
			});
			refusals.push({
				member: file.path,
				obstacles: [
					{
						kind: 'a file this build could not parse',
						line: 1,
						memberName: file.path
					}
				]
			});
			continue;
		}

		perFile.push({
			path: file.path,
			js: emission.js,
			translated: emission.translated,
			refusals: emission.refusals,
			fileRefusal: emission.fileRefusal
		});

		if (className === null && emission.className !== null) {
			className = emission.className;
			superClass = emission.superClass;
		}

		if (emission.fileRefusal !== null) {
			return {
				constants,
				className: className ?? emission.className,
				superClass: superClass ?? emission.superClass,
				js: '',
				perFile,
				refusals: headerRefusal(file.path, emission.fileRefusal),
				blocking: headerRefusal(file.path, emission.fileRefusal),
				reachable: [],
				usedRuntime: [],
				translated: [],
				abiMembers: [],
				complete: false,
				substantive: false,
				message: emission.fileRefusal
			};
		}

		graph.push(...emission.graph);
		if (file === entry) {
			// Everything the extension itself declares is a root. Only the shared
			// files it was given alongside are subject to pruning: an unused
			// private helper in the extension is a rounding error, and a wrongly
			// pruned one there would be the extension's own behaviour going
			// missing.
			for (const edges of emission.graph) entryMembers.add(edges.member);
			if (emission.className !== null) entryMembers.add(emission.className);
		}
		if (emission.js.length > 0) bodies.push(emission.js);
		translated.push(...emission.translated);
		refusals.push(...emission.refusals);
		for (const helper of emission.usedRuntime) used.add(helper);
	}

	const abiMembers = translated.filter((member) => ABI_MEMBERS.has(member));
	const reachable = reach(graph, entryMembers);
	// Reachability is the whole filter. An earlier version also required a
	// refusal to name an `ABI_MEMBERS` member *or* to come from outside the
	// entry file, and the second clause silently exempted every private helper
	// the extension declares: `popularAnimeParse` calling a refused
	// `parsePopularAnimeJson` reported `complete`, packaged, loaded, and threw
	// `this.parsePopularAnimeJson is not a function` on the first search. A
	// member the host can reach is a member the host can reach, whoever
	// declared it.
	// A refusal whose member never entered the graph — a file that would not
	// parse, a class header read against a guess — has no edges to be judged
	// by, so reachability cannot speak for it and it is never pruned. The
	// clause that used to say so lived inside the walk and could not fire:
	// every name it tested was in the graph by construction.
	const graphed = new Set(graph.map((edges) => edges.member));

	// What a member this file *kept* calls, which is the one thing the
	// host-drawn exemption must not cover.
	//
	// `isHostDrawn` exempts members named by this ecosystem's conventions —
	// `getFilterList`, `…Extractor`, `PREF_…`. That is right for the members the
	// HOST draws, because the driver asks `__declares` first and degrades to an
	// empty list when one is missing. It is wrong for a private helper that
	// merely shares the naming: `generateGroupFilter(…)` ends in `Filter` and so
	// was exempted, while the `getFilterList` that survived went on calling it —
	// unguarded. The bundle reported complete, installed, and died at the first
	// search with `this.generateGroupFilter is not a function`.
	//
	// So the exemption holds only while nothing translated calls the member. A
	// refused member with a surviving caller blocks, whatever it is called.
	const calledByTranslated = new Set<string>();
	const kept = new Set(translated);
	for (const edges of graph) {
		if (!kept.has(edges.member)) continue;
		for (const called of edges.calls) calledByTranslated.add(called.member);
		// References as well as calls, for the reason `reach` already learned one
		// level out: a name can be needed without being called. `object
		// AniPlayFilters` refused as a unit, `getFilterList` was exempted for
		// being host-drawn, and the surviving `AniPlayFilters.FILTER_LIST` went
		// out in a bundle that reported nothing blocking — `AniPlayFilters is not
		// defined`, on the first search. The driver can degrade around a member
		// it asks for and does not find; it cannot degrade around a free
		// variable in code that survived.
		for (const mentioned of edges.references) calledByTranslated.add(mentioned);
	}

	const blocking = refusals.filter(
		(one) =>
			(!isHostDrawn(one.member) || calledByTranslated.has(one.member)) &&
			(!graphed.has(one.member) || reachable.has(one.member))
	);
	const message = refusals.length === 0 ? null : describeRefusals(refusals);

	return {
		constants,
		className,
		superClass,
		js: orderByInheritance(bodies).join('\n\n'),
		perFile,
		refusals,
		blocking,
		reachable: [...reachable].sort(),
		usedRuntime: [...used].sort(),
		translated,
		abiMembers,
		complete: blocking.length === 0 && translated.length > 0,
		substantive: abiMembers.length > 0,
		message
	};
}

/**
 * Names a file declares that the runtime already defines, and who they belong to.
 *
 * The runtime defines `Video`, `Track`, `SAnime` and a dozen more at bundle
 * scope, spelled the way the Kotlin spells them (`RUNTIME_GLOBALS`). An
 * extension is entitled to declare a type with one of those names, and one in
 * the measured catalogue does: its DTO file declares `data class Video` while
 * its entry file imports the framework's `Video` and constructs one to return a
 * stream. Both used to be emitted as `function Video` into a single module
 * scope, and in an ES module that is a `SyntaxError` before a line of it runs —
 * "Identifier 'Video' has already been declared" — so the extension converted,
 * packaged, and then failed at load with a message about JavaScript rather than
 * about itself.
 *
 * Kotlin decides this per *file*, and so does this: the declaration is renamed,
 * and so is every reference in a file that Kotlin would resolve to it — the
 * file that declares it, a file in the same package, and a file that imports it
 * from that package. Every other file still means the runtime's, which is what
 * its own `import` says it means. Shadowing the runtime for the whole module
 * would have been the easy fix and the wrong one: the entry file would have
 * returned a DTO where the host expects a video.
 *
 * A file that did not parse contributes no declarations, so it renames nothing
 * — it is refused a few lines later anyway.
 */
function localRenames(
	files: readonly KotlinFile[],
	declared: ReadonlyMap<string, Declared>
): Map<string, ReadonlyMap<string, string>> {
	const applied = new Map<string, ReadonlyMap<string, string>>();

	/**
	 * Which files declare each name, for every name any file declares.
	 *
	 * Types *and* file-scope values, because the collision is about the emitted
	 * identifier and an emitted `const` collides exactly as loudly as an emitted
	 * `function`. Two files declaring the same `private const val` is ordinary
	 * Kotlin — `private` is scoped to the file — and becomes "Cannot declare a
	 * const variable twice" once both land in one module. This is the guard
	 * rather than the cure for the case that found it, which was test sources
	 * being read as library code (`source-repo.ts`); the collision it describes
	 * is real on its own and costs nothing to hold.
	 */
	const owners = new Map<string, Set<string>>();
	for (const file of files) {
		const one = declared.get(file.path);
		if (one === undefined) continue;
		for (const name of [...one.types, ...one.values]) {
			const where = owners.get(name) ?? new Set<string>();
			where.add(file.path);
			owners.set(name, where);
		}
	}

	/**
	 * The names that actually have to move.
	 *
	 * Two reasons, and they differ in one way that matters. A name the *runtime*
	 * defines has to move even when a single file declares it, because the
	 * runtime's copy is already in scope. A name two extension files declare has
	 * to move for all but one of them, and the one left alone keeps the spelling
	 * every file that merely *refers* to it already uses — which is the safety
	 * net below.
	 */
	const contested = new Map<string, readonly string[]>();
	for (const [name, where] of owners) {
		// Widened: `RUNTIME_GLOBALS` is a literal tuple, and this asks about an
		// arbitrary declared name rather than about one of its members.
		const shadowsRuntime = (RUNTIME_GLOBALS as readonly string[]).includes(name);
		if (!shadowsRuntime && where.size < 2) continue;
		// Sorted so a conversion is deterministic: the same input has to emit the
		// same module, or a bundle digest means nothing (`package.ts`).
		const sorted = [...where].sort();
		contested.set(name, shadowsRuntime ? sorted : sorted.slice(1));
	}
	if (contested.size === 0) return applied;

	// What each renamed declaration is written out as. `Video_` unless something
	// already declares that, which would trade one collision for another.
	const taken = new Set<string>();
	for (const one of declared.values()) {
		for (const name of one.types) taken.add(name);
		for (const name of one.values) taken.add(name);
	}
	/** name → file that declares it → the identifier that file emits. */
	const written = new Map<string, Map<string, string>>();
	for (const [name, movers] of contested) {
		const perFile = new Map<string, string>();
		for (const path of movers) {
			let candidate = `${name}_`;
			while (taken.has(candidate)) candidate = `${candidate}_`;
			taken.add(candidate);
			perFile.set(path, candidate);
		}
		written.set(name, perFile);
	}

	/** The package each file declares, read once. */
	const packages = new Map<string, string>();
	for (const file of files) packages.set(file.path, packageOf(file.source));

	for (const file of files) {
		const pkg = packages.get(file.path) ?? '';
		const imported = importsOf(file.source);
		const mine = new Map<string, string>();

		for (const [name, perFile] of written) {
			// This file's own declaration always wins — that is what `private`
			// means, and what shadowing a runtime global means.
			const own = perFile.get(file.path);
			if (own !== undefined) {
				mine.set(name, own);
				continue;
			}
			if (owners.get(name)?.has(file.path) === true) continue;

			// Otherwise it is a *reference*, and it resolves to whichever file
			// Kotlin would resolve it to: one in this package, else one this file
			// imports the name from. Only when that is unambiguous — two same-named
			// private declarations in reach is not something this can read, and
			// guessing would bind a call to the wrong table.
			const reachable = [...(owners.get(name) ?? [])].filter(
				(path) =>
					packages.get(path) === pkg ||
					imported.some(
						(spec) =>
							spec.endsWith(`.${name}`) &&
							spec.slice(0, spec.length - name.length - 1) === packages.get(path)
					)
			);
			if (reachable.length !== 1) continue;
			const renamed = perFile.get(reachable[0]);
			// `undefined` means the file it resolves to is the one that kept the
			// original spelling, so this file is already correct as written.
			if (renamed !== undefined) mine.set(name, renamed);
		}

		if (mine.size > 0) applied.set(file.path, mine);
	}
	return applied;
}

/** The package a file declares, or `''` for one that declares none. */
function packageOf(source: string): string {
	return /^[ \t]*package[ \t]+([\w.]+)/m.exec(source)?.[1] ?? '';
}

/** Every path a file imports, aliases and wildcards left as written. */
function importsOf(source: string): string[] {
	return [...source.matchAll(/^[ \t]*import[ \t]+([\w.]+)/gm)].map((match) => match[1]);
}

/**
 * Which members the host can get to, and therefore which refusals matter.
 *
 * The problem this solves is specific and was measured: feeding an extension
 * its shared template and extractor modules made conversion *worse*, because
 * an extractor's own refusals — an `Interceptor` in a method the extension
 * never calls — counted against every extension that merely named the module.
 * Whole-file all-or-nothing was asking the wrong question. The right one is
 * whether the members the host can reach all translated.
 *
 * The walk is over-approximate at every edge, and each of those choices is
 * deliberate:
 *
 * - Edges are every call target a member's *text* mentions, not only the calls
 *   the emitter resolved, so a refused member still has edges out of it and a
 *   member reachable only from one stays reachable. Nobody knows what a
 *   member that failed to translate would have called.
 * - A call through a receiver this build cannot resolve still names its method,
 *   so it stays reachable.
 * - Names collide across files; a collision keeps both.
 * - Reaching a *type* reaches its properties, because those run when it is
 *   constructed even if nothing names them.
 *
 * Pruning something that is in fact called does not produce a refusal. It
 * produces `undefined is not a function` inside a sandbox on somebody's
 * phone, which is a worse failure than the one it replaced — so every
 * uncertainty here resolves towards keeping.
 */
function reach(graph: readonly MemberEdges[], entryMembers: ReadonlySet<string>): Set<string> {
	const byName = new Map<string, MemberEdges[]>();
	const byOwner = new Map<string, MemberEdges[]>();
	for (const edges of graph) {
		const named = byName.get(edges.member);
		if (named === undefined) byName.set(edges.member, [edges]);
		else named.push(edges);
		if (edges.owner === null) continue;
		const owned = byOwner.get(edges.owner);
		if (owned === undefined) byOwner.set(edges.owner, [edges]);
		else owned.push(edges);
	}

	// A file-scope declaration is reached by its *name*, with no receiver in
	// front of it: `getFilterList() = FILTERS` emits a bare `FILTERS`, and if
	// that declaration was refused nothing in the module declares it. The walk
	// followed calls only, so the refusal was pruned as unreachable, the
	// conversion reported complete, and the extension installed and answered its
	// first search with `FILTERS is not defined`. A class member cannot fail
	// this way — it is reached as `this.name`, which is an edge already.
	const fileScope = new Set<string>();
	for (const edges of graph) if (edges.owner === null) fileScope.add(edges.member);

	const reached = new Set<string>();
	const pending: string[] = [...entryMembers, ...HOST_ENTRY_POINTS];

	while (pending.length > 0) {
		const name = pending.pop() as string;
		if (reached.has(name)) continue;
		reached.add(name);

		for (const edges of byName.get(name) ?? []) {
			for (const call of edges.calls) {
				if (!reached.has(call.member)) pending.push(call.member);
			}
			for (const reference of edges.references) {
				if (fileScope.has(reference) && !reached.has(reference)) pending.push(reference);
			}
		}

		// An unresolved receiver still names the method it intends to call. If a
		// shared object is the only declaration that provides that method, keep
		// the object in the closure; otherwise the bundle would fail later with an
		// undefined method instead of refusing at conversion time.
		const unresolvedTarget = graph.some(
			(edges) =>
				reached.has(edges.member) &&
				edges.calls.some((call) => call.member === name && call.unresolvedReceiver)
		);
		if (unresolvedTarget) {
			for (const edges of graph) {
				if (edges.owner === null && edges.references.includes(name) && !reached.has(edges.member)) {
					pending.push(edges.member);
				}
			}
		}

		// Reaching a type reaches whatever runs when it is built.
		for (const edges of byOwner.get(name) ?? []) {
			if (edges.construction && !reached.has(edges.member)) pending.push(edges.member);
		}
	}

	return reached;
}

/** The refusals a file that could not be read as a whole can carry. */
/**
 * The host's asset loader, or a refusal that names what is missing.
 *
 * A host without one is a supported state — `HOST.md` §2.0 — and the
 * degradation is that this ecosystem cannot be converted here, which is worth
 * saying in a sentence rather than discovering as `loader is not a function`.
 */
function requireWasm(loader: WasmLoader | undefined): WasmLoader {
	if (loader === undefined) {
		throw new ValidationFailure(
			'This host supplies no parser assets, so Kotlin sources cannot be translated here.'
		);
	}
	return loader;
}

/**
 * A file-wide refusal, named by which of the two it is.
 *
 * Both used to report `a class header this build could not parse`, and only one
 * of them is about a header. The other is a declaration at file scope the
 * parser could not read — which is what a mis-parse *inside* a member looks
 * like from up here, because tree-sitter's recovery loses the brace nesting and
 * the rest of the class lands at top level as ERROR nodes.
 *
 * Worth separating because the scoreboard ranks on these kinds. Six listings sat
 * under the header name while their real fault was a member the grammar could
 * not read, and two investigations went looking at class headers that parse
 * perfectly well.
 */
/**
 * The emitted file bodies, with a base class ahead of anything that extends it.
 *
 * `class X extends Y` is evaluated where it stands, so `Y` has to have been
 * initialised by then — unlike a `function`, a `class` is not hoisted into use.
 * The files arrive in the order the adapter reads them, which puts the
 * extension's own sources first *on purpose* (the entry class must be the one
 * found), and its theme after. So an extension that extends its multisrc theme
 * emitted `class Wcofun extends WcoTheme` above the `class WcoTheme` it names
 * and died at load with "Cannot access 'WcoTheme' before initialization".
 *
 * Read off the emitted text rather than the Kotlin, because this is a fact
 * about the JavaScript: what matters is which file *emitted* a binding and
 * which file's `extends` clause names it.
 *
 * Stable, and cycle-tolerant: a file whose dependency is missing or circular
 * keeps its place rather than being dropped or reordered on a guess. Kotlin has
 * no circular inheritance, so a cycle here means this read was wrong, and the
 * original order is the honest fallback.
 */
function orderByInheritance(bodies: readonly string[]): string[] {
	if (bodies.length < 2) return [...bodies];

	const declares = new Map<string, number>();
	bodies.forEach((body, at) => {
		for (const found of body.matchAll(/^(?:class|function)\s+([A-Za-z_$][\w$]*)/gm)) {
			if (!declares.has(found[1])) declares.set(found[1], at);
		}
	});

	const needs = bodies.map((body) => {
		const out = new Set<number>();
		for (const found of body.matchAll(/\bextends\s+([A-Za-z_$][\w$]*)/g)) {
			const at = declares.get(found[1]);
			if (at !== undefined) out.add(at);
		}
		return out;
	});

	const order: number[] = [];
	const state = new Uint8Array(bodies.length);
	const visit = (at: number): void => {
		if (state[at] !== 0) return;
		state[at] = 1;
		for (const dependency of needs[at]) {
			// A cycle: leave it, and let the original order stand for both.
			if (state[dependency] === 1) continue;
			visit(dependency);
		}
		state[at] = 2;
		order.push(at);
	};
	for (let at = 0; at < bodies.length; at += 1) visit(at);

	return order.map((at) => bodies[at]);
}

function headerRefusal(path: string, reason: string): Refusal[] {
	const kind = /class header/.test(reason)
		? 'a class header this build could not parse'
		: 'a declaration this build could not parse';
	return [{ member: path, obstacles: [{ kind, line: 1, memberName: path }] }];
}

function empty(constants: KotlinSource, message: string): KotlinConversion {
	return {
		constants,
		className: null,
		superClass: null,
		js: '',
		perFile: [],
		refusals: [],
		blocking: [],
		reachable: [],
		usedRuntime: [],
		translated: [],
		abiMembers: [],
		complete: false,
		substantive: false,
		message
	};
}
