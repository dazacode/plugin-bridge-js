/**
 * A typed façade over the parse tree, and the only place tree-sitter is named.
 *
 * Everything above this file — the emitter, the subset allowlist, the survey —
 * sees `KNode` and nothing else. That is not tidiness for its own sake: the
 * grammar and its runtime are pinned to each other and to a version older than
 * either project's newest (`vendor/README.md`), so a grammar upgrade is a
 * question of "what changed in the node kinds", and the answer has to be
 * findable in one place rather than spread through a translator.
 *
 * It is also what makes the emitter testable without loading a 4 MB wasm: a
 * `KNode` is a plain shape, and a spec can build one by hand.
 *
 * ## Node kinds are strings, deliberately
 *
 * tree-sitter has no enum for them and the set differs per grammar version.
 * `subset.ts` holds the kinds this build handles and asserts that set against
 * the grammar's own node-type list, so a kind that appears after an upgrade
 * fails a test rather than being silently skipped — the `unreadableOverrides`
 * discipline from `reader.ts`, one level down.
 */

/** One node of a parsed Kotlin file. */
export interface KNode {
	/** The grammar's name for this node, e.g. `call_expression`. */
	readonly type: string;
	/** The exact source text this node spans. */
	readonly text: string;
	/** 1-based, for messages a person reads. */
	readonly line: number;
	/** True for this node or anything under it. */
	readonly hasError: boolean;
	/**
	 * True when the parser *inserted* this node to recover.
	 *
	 * A missing node keeps the type it was expected to be — tree-sitter never
	 * names one `MISSING` — so `node.type === 'MISSING'` could not be true and
	 * two guards written that way never fired. See `isMissing` in `subset.ts`.
	 */
	readonly isMissing: boolean;
	/** Named children only — punctuation and keywords are dropped. */
	readonly children: readonly KNode[];
	/** Every child, punctuation included. Needed for operators. */
	readonly allChildren: readonly KNode[];
	/** A child by the grammar's field name, e.g. `name`, `body`, `type`. */
	field(name: string): KNode | null;
}

/** What a parse produced, and whether it can be trusted. */
export interface KotlinTree {
	readonly root: KNode;
	/**
	 * True when the parse contains `ERROR` or `MISSING` anywhere.
	 *
	 * Load-bearing. tree-sitter is error-*tolerant*: it recovers by guessing,
	 * and a recovered parse looks structurally fine. Treating one as
	 * authoritative is how a selector silently becomes the wrong selector, so
	 * a member whose subtree contains either kind is refused rather than
	 * translated.
	 */
	readonly hasError: boolean;
}

/** The subset of web-tree-sitter's node this façade reads. */
export interface RawNode {
	readonly type: string;
	readonly text: string;
	readonly startPosition: { row: number };
	readonly namedChildCount: number;
	readonly childCount: number;
	hasError(): boolean;
	isMissing(): boolean;
	namedChild(index: number): RawNode | null;
	child(index: number): RawNode | null;
	childForFieldName(name: string): RawNode | null;
}

/**
 * Wraps one raw node.
 *
 * Children are computed lazily and memoised: a source file is thousands of
 * nodes and a translator visits a small fraction of them, so building the whole
 * façade eagerly would cost more than the parse did.
 */
/**
 * A name as the program means it, which for a quoted Kotlin name is without
 * its backticks.
 *
 * `` val `data`: Wrapper `` declares a property called `data`; the backticks
 * are how Kotlin lets a name be a word it otherwise reserves, and they are no
 * part of the name. Passed through, every place a name is written out wrote
 * them too — `` this.`data` = data `` — which JavaScript cannot parse, so the
 * bundle failed to load with nothing refused. Only a quoted name that is a
 * plain identifier inside is unquoted; one with a space or a hyphen in it
 * has no JavaScript spelling, and keeps its backticks so it fails loudly.
 */
function identifierText(raw: RawNode): string {
	const text = raw.text;
	if (raw.type !== 'simple_identifier' || !text.startsWith('`')) return text;
	const inner = /^`([A-Za-z_]\w*)`$/.exec(text);
	return inner === null ? text : inner[1];
}

export function wrap(raw: RawNode): KNode {
	let children: readonly KNode[] | null = null;
	let allChildren: readonly KNode[] | null = null;

	return {
		type: raw.type,
		text: identifierText(raw),
		line: raw.startPosition.row + 1,
		get hasError(): boolean {
			return raw.hasError();
		},
		get isMissing(): boolean {
			// Guarded: the façade is also handed hand-built nodes by the specs,
			// and an absent method there is "not missing" rather than a crash.
			return typeof raw.isMissing === 'function' ? raw.isMissing() : false;
		},
		get children(): readonly KNode[] {
			if (children === null) {
				const out: KNode[] = [];
				for (let index = 0; index < raw.namedChildCount; index += 1) {
					// Nullish, not `!== null`: the pinned runtime returns
					// `undefined` for an absent child in some builds and `null`
					// in others, and wrapping `undefined` fails far from here.
					const child = raw.namedChild(index);
					if (child != null) out.push(wrap(child));
				}
				children = out;
			}
			return children;
		},
		get allChildren(): readonly KNode[] {
			if (allChildren === null) {
				const out: KNode[] = [];
				for (let index = 0; index < raw.childCount; index += 1) {
					const child = raw.child(index);
					if (child != null) out.push(wrap(child));
				}
				allChildren = out;
			}
			return allChildren;
		},
		field(name: string): KNode | null {
			const found = raw.childForFieldName(name);
			return found == null ? null : wrap(found);
		}
	};
}

/* ── walking, the three shapes every caller needs ─────────────────────────── */

/** Depth-first over named nodes, this one included. */
export function* walk(node: KNode): Generator<KNode> {
	yield node;
	for (const child of node.children) yield* walk(child);
}

/** The first descendant of a kind, or null. */
export function firstOfType(node: KNode, type: string): KNode | null {
	for (const found of walk(node)) {
		if (found.type === type) return found;
	}
	return null;
}

/** Every descendant of a kind, in source order. */
export function allOfType(node: KNode, type: string): KNode[] {
	const out: KNode[] = [];
	for (const found of walk(node)) {
		if (found.type === type) out.push(found);
	}
	return out;
}

/**
 * Direct named children of a kind. Not the same question as `allOfType`.
 *
 * A class body's `function_declaration` children are its methods; the
 * `function_declaration`s *under* those are local functions, and a caller
 * collecting members wants the first set only.
 */
export function childrenOfType(node: KNode, type: string): KNode[] {
	return node.children.filter((child) => child.type === type);
}

/**
 * Every node kind appearing under this one, counted.
 *
 * The survey's primary measurement: the histogram of kinds inside the method
 * bodies that block conversion is the translator's work queue, ranked.
 */
export function kindHistogram(node: KNode): Map<string, number> {
	const counts = new Map<string, number>();
	for (const found of walk(node)) {
		counts.set(found.type, (counts.get(found.type) ?? 0) + 1);
	}
	return counts;
}
