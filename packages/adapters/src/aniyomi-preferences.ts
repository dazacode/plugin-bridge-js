/**
 * Reading an Aniyomi extension's declared preferences out of its Kotlin.
 *
 * This lived in `@plugin-bridge/core` until 2026-09-11, which was wrong in a
 * way worth recording: nothing here is shared. It knows Kotlin, it knows this
 * ecosystem's four preference constructor names, and it knows that they are
 * configured inside an `apply { }` block. A second ecosystem gained nothing
 * from it being in core and a reader of core had to skip past it to find what
 * genuinely was shared.
 *
 * What core keeps is the part that is: `SettingDescriptor`, the manifest shape
 * every adapter emits, and the literal helpers both readers use.
 */

import {
	Literals,
	stringList,
	toDescriptors,
	type Declared
} from '@plugin-bridge/core/preferences';
import { MAX_SETTINGS, type SettingDescriptor } from '@plugin-bridge/core/settings';

/**
 * `setupPreferenceScreen(screen)` out of an extension's Kotlin.
 *
 * Cheaper than it looks, and worth saying why, because "do the second ecosystem
 * if it is cheap" was a real question. The bodies are formulaic — the framework
 * only offers four preference types and every extension builds them the same
 * way:
 *
 * ```kotlin
 * ListPreference(screen.context).apply {
 *     key = PREF_SERVER_KEY
 *     title = "Preferred server"
 *     entries = arrayOf("Alpha", "Beta")
 *     entryValues = arrayOf("alpha", "beta")
 *     setDefaultValue("alpha")
 * }.also(screen::addPreference)
 * ```
 *
 * So this reads assignments inside `apply { }` blocks that follow one of the
 * four constructor names, and resolves `PREF_SERVER_KEY` through the string
 * constants the translator already folded out of the file. What it does not do
 * is parse Kotlin: it is a literal walk over the member's text, and a value it
 * cannot read as a literal is dropped. That is the same trade the JavaScript
 * reader makes and it is bounded the same way.
 */
export function aniyomiPreferences(
	kotlin: string,
	constants: Readonly<Record<string, string>> = {}
): readonly SettingDescriptor[] {
	const declared: Declared[] = [];
	const pattern =
		/\b(ListPreference|EditTextPreference|SwitchPreferenceCompat|MultiSelectListPreference)\s*\(/g;

	let match: RegExpExecArray | null;
	while ((match = pattern.exec(kotlin)) !== null && declared.length < MAX_SETTINGS) {
		const block = applyBlock(kotlin, pattern.lastIndex - 1);
		if (block === null) continue;
		const entry = declaredFromKotlin(match[1], block, constants);
		if (entry !== null) declared.push(entry);
	}

	return toDescriptors(declared);
}

/** The `apply { … }` body that follows a constructor call, or null. */
function applyBlock(kotlin: string, parenthesis: number): string | null {
	// Past the constructor's own arguments.
	let depth = 0;
	let cursor = parenthesis;
	for (; cursor < kotlin.length; cursor += 1) {
		if (kotlin[cursor] === '(') depth += 1;
		else if (kotlin[cursor] === ')') {
			depth -= 1;
			if (depth === 0) {
				cursor += 1;
				break;
			}
		}
	}

	const reader = new Literals(kotlin);
	reader.seek(cursor);
	// `ListPreference(screen.context).apply { … }` — the dot is a separate
	// token and `word()` will not step over it.
	if (!reader.take('.')) return null;
	if (reader.word() !== 'apply') return null;
	if (!reader.take('{')) return null;

	const start = reader.index;
	depth = 1;
	for (cursor = start; cursor < kotlin.length; cursor += 1) {
		if (kotlin[cursor] === '{') depth += 1;
		else if (kotlin[cursor] === '}') {
			depth -= 1;
			if (depth === 0) return kotlin.slice(start, cursor);
		}
	}
	return null;
}

/** `name = value` and `setX(value)` assignments in an `apply` body. */
function kotlinAssignments(block: string): Map<string, string> {
	const out = new Map<string, string>();

	const assignment = /(^|[\s;{])([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/g;
	let match: RegExpExecArray | null;
	while ((match = assignment.exec(block)) !== null) {
		const reader = new Literals(block);
		reader.seek(match.index + match[0].length);
		out.set(match[2], reader.rest('\n;'));
	}

	const setter = /\bset([A-Z][A-Za-z0-9_]*)\s*\(/g;
	while ((match = setter.exec(block)) !== null) {
		const reader = new Literals(block);
		reader.seek(setter.lastIndex);
		const name = match[1][0].toLowerCase() + match[1].slice(1);
		if (!out.has(name)) out.set(name, reader.rest(')'));
	}

	return out;
}

/**
 * A literal, or the value of a constant the translator already folded.
 *
 * `key = PREF_DOMAIN_KEY` is how nearly every one of these is written, and a
 * derivation that could not follow one indirection would read almost nothing.
 */
function kotlinValue(
	text: string | undefined,
	constants: Readonly<Record<string, string>>
): string | undefined {
	if (text === undefined) return undefined;
	const literal = new Literals(text).string();
	if (literal !== undefined) return literal;
	const name = text.trim();
	return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name)
		? (constants[name] ?? constants[name.split('.').pop() ?? ''])
		: undefined;
}

function declaredFromKotlin(
	kind: string,
	block: string,
	constants: Readonly<Record<string, string>>
): Declared | null {
	const fields = kotlinAssignments(block);
	const key = kotlinValue(fields.get('key'), constants);
	if (key === undefined || key.length === 0) return null;

	const label = kotlinValue(fields.get('title'), constants) ?? key;
	const help = kotlinValue(fields.get('summary'), constants);
	const declaredDefault = fields.get('defaultValue');

	if (kind === 'SwitchPreferenceCompat') {
		return {
			key,
			type: 'switch',
			label,
			help,
			value: (declaredDefault ?? '').trim() === 'true'
		};
	}

	if (kind === 'EditTextPreference') {
		return {
			key,
			type: 'text',
			label,
			help,
			value: kotlinValue(declaredDefault, constants) ?? ''
		};
	}

	const entries = stringList(fields.get('entries') ?? '');
	const entryValues = stringList(fields.get('entryValues') ?? '') ?? entries;

	if (kind === 'MultiSelectListPreference') {
		return {
			key,
			type: 'multiselect',
			label,
			help,
			entries,
			entryValues,
			value: stringList(declaredDefault ?? '') ?? []
		};
	}

	const chosen = kotlinValue(declaredDefault, constants);
	return {
		key,
		type: 'select',
		label,
		help,
		entries,
		entryValues,
		...(chosen === undefined ? {} : { value: chosen })
	};
}
