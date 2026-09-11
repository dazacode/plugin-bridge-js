/**
 * Reading a foreign extension's own preference declaration, so the manifest can
 * carry it.
 *
 * `ABI.md` §1: a plugin declares settings and the host draws them. A converted
 * bundle used to declare none, which meant every preference read collapsed to
 * the value the source itself declared and every write was a no-op — and since
 * these sources routinely choose a **base URL** or a **preferred server** that
 * way, a working source could quietly become a mediocre one. This module is
 * what closes that: it reads the declaration out of the artifact being
 * converted and hands `package.ts` a `settings` block.
 *
 * ## Statically, and on purpose
 *
 * Both readers work on source text. Neither evaluates anything.
 *
 * The alternative — build the bundle, run it in the sandbox, ask it what it
 * declares, then rewrite the manifest — would make a bundle's digest depend on
 * a network round-trip and on whichever mirror answered, and `package.ts`
 * exists to keep that digest a fact about the *input*. It would also invert the
 * install order: the manifest is what the consent screen shows, and it cannot
 * be produced by running the thing being consented to.
 *
 * The cost of reading statically is that a declaration assembled at runtime is
 * not read. That is stated rather than papered over: a preference this module
 * cannot see is simply absent from the manifest, the host draws no row for it,
 * and the bundle's own fallback answers it with the source's declared default —
 * which is precisely the behaviour that existed before this file. Deriving
 * fewer settings is never worse than not deriving any.
 *
 * ## Rule 9
 *
 * A preference default is very often a base URL. **None of them is in this
 * repository.** Every value here is read out of an artifact on the viewer's own
 * device at conversion time; nothing is tabulated, defaulted or tested against
 * a real host, and the specs beside this file use invented `.invalid` names.
 */

import {
	MAX_SETTINGS,
	settingIdFor,
	type SettingDescriptor,
	type SettingOption
} from '@plugin-bridge/core/settings';

/* ── shared shaping ───────────────────────────────────────────────────────── */

export interface Declared {
	readonly key: string;
	readonly type: SettingDescriptor['type'];
	readonly label: string;
	readonly help?: string;
	readonly entries?: readonly string[];
	readonly entryValues?: readonly string[];
	readonly value?: string | boolean | readonly string[];
}

/**
 * Declarations to descriptors, with ids that cannot collide.
 *
 * Two foreign keys can normalise to the same id — `pref_server` and
 * `pref.server` do. Suffixing the second would leave the bundle looking the
 * value up under an id the host never stored, so the id map travels *into* the
 * bundle (see `settingKeyMap`) and disambiguation is safe.
 */
export function toDescriptors(declared: readonly Declared[]): readonly SettingDescriptor[] {
	const out: SettingDescriptor[] = [];
	const taken = new Set<string>();

	for (const entry of declared) {
		if (out.length >= MAX_SETTINGS) break;

		const base = settingIdFor(entry.key);
		if (base.length === 0) continue;
		let id = base;
		for (let n = 2; taken.has(id); n += 1) id = `${base.slice(0, 45)}_${n}`;

		const options = pairOptions(entry.entries, entry.entryValues);
		if ((entry.type === 'select' || entry.type === 'multiselect') && options === null) continue;

		taken.add(id);
		out.push({
			id,
			key: entry.key,
			type: entry.type,
			label: entry.label.length > 0 ? entry.label.slice(0, 64) : entry.key.slice(0, 64),
			...(entry.help === undefined || entry.help.length === 0
				? {}
				: { help: entry.help.slice(0, 240) }),
			...(options === null ? {} : { options }),
			default: entry.value ?? defaultFor(entry, options)
		});
	}

	return out;
}

function defaultFor(entry: Declared, options: readonly SettingOption[] | null): unknown {
	if (entry.type === 'switch') return false;
	if (entry.type === 'multiselect') return [];
	if (entry.type === 'select') return options?.[0]?.value ?? '';
	return '';
}

/**
 * `entries` are what a person reads and `entryValues` are what the code gets.
 *
 * Zipped rather than assumed parallel: an extension whose two arrays disagree
 * in length is common enough, and the value half is the load-bearing one — a
 * row whose value is missing is dropped, a row whose label is missing shows its
 * value.
 */
function pairOptions(
	entries: readonly string[] | undefined,
	entryValues: readonly string[] | undefined
): readonly SettingOption[] | null {
	const values = entryValues ?? entries;
	if (values === undefined || values.length === 0) return null;
	const labels = entries ?? values;
	const out: SettingOption[] = [];
	for (let i = 0; i < values.length && out.length < 64; i += 1) {
		const value = values[i];
		if (typeof value !== 'string' || value.length === 0) continue;
		const label = typeof labels[i] === 'string' && labels[i].length > 0 ? labels[i] : value;
		out.push({ value: value.slice(0, 64), label: label.slice(0, 64) });
	}
	return out.length === 0 ? null : out;
}

/**
 * The foreign key → manifest id map a bundle carries.
 *
 * The shims normalise a key the same way this module does, so most of the time
 * this is redundant. It is emitted anyway because the one case where it is not
 * redundant — two keys that normalise alike — is silent otherwise: the second
 * setting would read the first one's value.
 */
export function settingKeyMap(descriptors: readonly SettingDescriptor[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const descriptor of descriptors) {
		if (descriptor.key !== undefined) map[descriptor.key] = descriptor.id;
	}
	return map;
}

/* ── a tiny reader for literal syntax ─────────────────────────────────────── */

/**
 * Enough of a scanner to read a literal and refuse everything else.
 *
 * Shared by both readers because both are doing the same thing: walking source
 * text, and stopping the moment a value stops being a literal. Nothing here
 * evaluates, and anything it cannot read becomes `undefined`, which drops the
 * field rather than guessing at it.
 */
export class Literals {
	private at = 0;

	constructor(private readonly text: string) {}

	get index(): number {
		return this.at;
	}

	seek(index: number): void {
		this.at = index;
	}

	/** Skips whitespace and both comment forms. */
	skip(): void {
		for (;;) {
			while (this.at < this.text.length && /\s/.test(this.text[this.at])) this.at += 1;
			if (this.text.startsWith('//', this.at)) {
				const end = this.text.indexOf('\n', this.at);
				this.at = end === -1 ? this.text.length : end + 1;
				continue;
			}
			if (this.text.startsWith('/*', this.at)) {
				const end = this.text.indexOf('*/', this.at + 2);
				this.at = end === -1 ? this.text.length : end + 2;
				continue;
			}
			return;
		}
	}

	peek(): string {
		this.skip();
		return this.text[this.at] ?? '';
	}

	take(character: string): boolean {
		this.skip();
		if (this.text[this.at] === character) {
			this.at += 1;
			return true;
		}
		return false;
	}

	/** A quoted string, unescaped only as far as the escapes that occur. */
	string(): string | undefined {
		this.skip();
		const quote = this.text[this.at];
		if (quote !== '"' && quote !== "'" && quote !== '`') return undefined;
		// A triple-quoted Kotlin string is raw and holds no escapes.
		const raw = this.text.startsWith('"""', this.at);
		const close = raw ? '"""' : quote;
		let cursor = this.at + close.length;
		let out = '';
		while (cursor < this.text.length) {
			const character = this.text[cursor];
			if (!raw && character === '\\') {
				const next = this.text[cursor + 1] ?? '';
				out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
				cursor += 2;
				continue;
			}
			if (this.text.startsWith(close, cursor)) {
				this.at = cursor + close.length;
				return out;
			}
			// An interpolation makes this not a literal; the whole value is
			// unreadable rather than half-read.
			if (character === '$' && (quote === '"' || quote === '`')) return undefined;
			out += character;
			cursor += 1;
		}
		return undefined;
	}

	/** An identifier or a bare word — a key, a name, a keyword. */
	word(): string {
		this.skip();
		const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.text.slice(this.at));
		if (match === null) return '';
		this.at += match[0].length;
		return match[0];
	}

	/** Everything up to the next top-level separator, unparsed. */
	rest(separators: string): string {
		this.skip();
		const start = this.at;
		let depth = 0;
		while (this.at < this.text.length) {
			const character = this.text[this.at];
			if (character === '"' || character === "'" || character === '`') {
				const before = this.at;
				if (this.string() === undefined) {
					this.at = before + 1;
					continue;
				}
				continue;
			}
			if ('([{'.includes(character)) depth += 1;
			else if (')]}'.includes(character)) {
				if (depth === 0) break;
				depth -= 1;
			} else if (depth === 0 && separators.includes(character)) break;
			this.at += 1;
		}
		return this.text.slice(start, this.at).trim();
	}
}

/** Every quoted string inside a bracketed list, in order. */
export function stringList(text: string): readonly string[] | undefined {
	const reader = new Literals(text);
	const out: string[] = [];
	for (;;) {
		const character = reader.peek();
		if (character === '') break;
		if (character === '"' || character === "'" || character === '`') {
			const value = reader.string();
			if (value === undefined) return undefined;
			out.push(value);
			continue;
		}
		reader.seek(reader.index + 1);
	}
	return out.length === 0 ? undefined : out;
}

/* ── the JavaScript ecosystem ─────────────────────────────────────────────── */

/**
 * `getSourcePreferences()` out of a source written for the JavaScript half of
 * the format `FOREIGN.md` §4.4 describes.
 *
 * The shape is an array of rows, each with a `key` and exactly one of four
 * typed sub-objects:
 *
 * ```js
 * getSourcePreferences() {
 *   return [{
 *     key: "example_server",
 *     listPreference: {
 *       title: "Server", summary: "", valueIndex: 0,
 *       entries: ["Alpha", "Beta"], entryValues: ["alpha", "beta"]
 *     }
 *   }];
 * }
 * ```
 *
 * Read by walking the returned array literal. A row whose value is computed —
 * built from a variable, a template with an interpolation, a call — is skipped;
 * the remaining rows still convert, which is the whole reason this is a walk
 * rather than a single expression match.
 */
export function mangayomiPreferences(script: string): readonly SettingDescriptor[] {
	const body = returnedArray(script, 'getSourcePreferences');
	if (body === null) return [];

	const declared: Declared[] = [];
	const reader = new Literals(body);
	reader.take('[');

	while (reader.take('{')) {
		const row = readObject(reader);
		const entry = declaredFromRow(row);
		if (entry !== null) declared.push(entry);
		if (!reader.take(',')) break;
	}

	return toDescriptors(declared);
}

/** The array literal a named method returns, as text, or null. */
function returnedArray(script: string, method: string): string | null {
	const pattern = new RegExp(`\\b${method}\\s*\\([^)]*\\)\\s*\\{`, 'g');
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(script)) !== null) {
		const returned = script.indexOf('return', match.index + match[0].length);
		if (returned === -1) continue;
		const reader = new Literals(script);
		reader.seek(returned + 'return'.length);
		if (reader.peek() !== '[') continue;
		const start = reader.index;
		reader.rest(';');
		return script.slice(start, reader.index);
	}
	return null;
}

/** One `{ … }` body, as key → raw text. Assumes the `{` is consumed. */
function readObject(reader: Literals): Map<string, string> {
	const out = new Map<string, string>();
	for (;;) {
		if (reader.take('}')) return out;
		const quoted = reader.peek();
		const key = quoted === '"' || quoted === "'" ? (reader.string() ?? '') : reader.word();
		if (key.length === 0) {
			// Something this reader does not understand. Stop rather than
			// resynchronise: a half-read object is a wrong object.
			return out;
		}
		if (!reader.take(':')) return out;
		out.set(key, reader.rest(',}'));
		if (!reader.take(',')) {
			reader.take('}');
			return out;
		}
	}
}

function declaredFromRow(row: ReadonlyMap<string, string>): Declared | null {
	const key = literalString(row.get('key'));
	if (key === undefined || key.length === 0) return null;

	const list = nested(row.get('listPreference'));
	if (list !== null) {
		const entries = stringList(list.get('entries') ?? '');
		const entryValues = stringList(list.get('entryValues') ?? '') ?? entries;
		const index = Number(list.get('valueIndex') ?? '0');
		const chosen =
			entryValues !== undefined && Number.isInteger(index) && index >= 0
				? entryValues[index]
				: undefined;
		return {
			key,
			type: 'select',
			label: literalString(list.get('title')) ?? key,
			help: literalString(list.get('summary')),
			entries,
			entryValues,
			...(chosen === undefined ? {} : { value: chosen })
		};
	}

	const edit = nested(row.get('editTextPreference'));
	if (edit !== null) {
		return {
			key,
			type: 'text',
			label: literalString(edit.get('title')) ?? key,
			help: literalString(edit.get('summary')),
			value: literalString(edit.get('value')) ?? ''
		};
	}

	const toggle = nested(row.get('switchPreferenceCompat'));
	if (toggle !== null) {
		return {
			key,
			type: 'switch',
			label: literalString(toggle.get('title')) ?? key,
			help: literalString(toggle.get('summary')),
			value: (toggle.get('value') ?? '').trim() === 'true'
		};
	}

	const multi = nested(row.get('multiSelectListPreference'));
	if (multi !== null) {
		const entries = stringList(multi.get('entries') ?? '');
		const entryValues = stringList(multi.get('entryValues') ?? '') ?? entries;
		return {
			key,
			type: 'multiselect',
			label: literalString(multi.get('title')) ?? key,
			help: literalString(multi.get('summary')),
			entries,
			entryValues,
			value: stringList(multi.get('values') ?? '') ?? []
		};
	}

	return null;
}

function nested(text: string | undefined): Map<string, string> | null {
	if (text === undefined) return null;
	const reader = new Literals(text);
	if (!reader.take('{')) return null;
	return readObject(reader);
}

function literalString(text: string | undefined): string | undefined {
	if (text === undefined) return undefined;
	return new Literals(text).string();
}

/* ── the Kotlin ecosystem ─────────────────────────────────────────────────── */
