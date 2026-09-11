/**
 * A plugin's settings: what it declares, what the viewer chose, and what the
 * sandbox is handed.
 *
 * `ABI.md` §1 says a plugin never draws UI — it *declares* settings in its
 * manifest and the host draws them, on every surface, in the host's own tokens.
 * This module is the declaration half of that seam, kept beside the runtime
 * rather than in `$lib/domain` because a headless host converting a catalogue
 * needs it and has no app.
 *
 * Three jobs, and they are separate on purpose:
 *
 * - **Reading a declaration.** `parseSettingDescriptors` is deliberately
 *   forgiving about what it drops and unforgiving about what it keeps: a
 *   descriptor the schema would reject is dropped rather than repaired,
 *   because a settings row that does not mean what the manifest says is worse
 *   than a missing one. It is the same rule `package.ts` applies to hosts.
 * - **Resolving a value.** `settingValues` layers what the viewer stored over
 *   what the plugin declared. A bundle that declares nothing therefore resolves
 *   to nothing, which is exactly the behaviour every already-installed
 *   converted bundle has today and must keep having.
 * - **Refusing a value that would widen the network grant.** `hostOutsideGrant`
 *   is why this file knows about hosts at all. See below.
 *
 * ## A setting that points somewhere the plugin was not granted
 *
 * A converted source's commonest preference *is* a base URL, so a settings
 * screen is one text field away from being a way to send a plugin at a host
 * the viewer never consented to. `manifest.network.hosts` is what `ctx.http`
 * enforces (`ABI.md` §2) and it is the list the consent screen showed
 * (`REPOSITORY.md` §4 step 8), so the answer here is a **refusal that names the
 * host**, taken at the moment the viewer sets the value rather than four
 * screens later when a search silently returns nothing.
 *
 * It is a refusal and not a consent step because widening what a plugin may
 * reach is an install-time decision with a diff attached (`REPOSITORY.md` §6),
 * and a settings row is not that. A preference is allowed to choose *among* the
 * hosts a plugin declared; it is not allowed to add one.
 *
 * `ctx.http` still refuses independently. This check is the one that can
 * explain itself; that one is the one that cannot be bypassed.
 */

/** Every setting type the manifest schema allows. */
export type SettingType = 'select' | 'multiselect' | 'switch' | 'text';

export interface SettingOption {
	readonly value: string;
	readonly label: string;
}

export interface SettingDescriptor {
	/** The id the host stores under and `ctx.settings` answers to. */
	readonly id: string;
	/**
	 * What the plugin's own code calls this, when that is not a legal id.
	 *
	 * Foreign preference keys are arbitrary strings; manifest ids are not. The
	 * key is carried so the derivation is auditable in the manifest diff and so
	 * a bundle can be handed the exact mapping rather than re-deriving it.
	 */
	readonly key?: string;
	readonly type: SettingType;
	readonly label: string;
	readonly help?: string;
	readonly default?: unknown;
	readonly options?: readonly SettingOption[];
}

/** What the schema caps these at, repeated here so a derivation can obey it. */
export const MAX_SETTINGS = 32;
const MAX_OPTIONS = 64;
const MAX_ID = 48;
const MAX_LABEL = 64;
const MAX_HELP = 240;

const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A manifest setting id built from a foreign preference key.
 *
 * The bundle shims carry the same normalisation, so a plugin that reads a
 * preference by its own key finds the value the host stored under the id. Where
 * a conversion had to disambiguate two keys that normalise alike, the bundle is
 * handed the exact map instead and this is only its fallback.
 */
export function settingIdFor(key: string): string {
	return String(key)
		.toLowerCase()
		.replace(/[^a-z0-9_]/g, '_')
		.replace(/^[^a-z]+/, '')
		.slice(0, MAX_ID);
}

function text(value: unknown, max: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.slice(0, max);
}

function options(value: unknown): readonly SettingOption[] | null {
	if (!Array.isArray(value) || value.length === 0) return null;
	const out: SettingOption[] = [];
	for (const entry of value.slice(0, MAX_OPTIONS)) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const optionValue = text(row['value'], MAX_LABEL);
		const label = text(row['label'], MAX_LABEL) ?? optionValue;
		if (optionValue === null || label === null) continue;
		out.push({ value: optionValue, label });
	}
	return out.length === 0 ? null : out;
}

/** The default a descriptor declares, coerced to the shape its type promises. */
export function defaultValue(descriptor: SettingDescriptor): unknown {
	return coerce(descriptor, descriptor.default);
}

/**
 * A value as the descriptor's type promises it, or the type's empty value.
 *
 * The sandbox reads settings through three typed accessors and a plugin that
 * asks for a list must get an array — a comma-joined string iterates as one
 * long element rather than as the values it holds, which is the kind of wrong
 * that surfaces three frames away from its cause.
 */
export function coerce(descriptor: SettingDescriptor, value: unknown): unknown {
	switch (descriptor.type) {
		case 'switch':
			if (typeof value === 'boolean') return value;
			if (value === 'true') return true;
			if (value === 'false') return false;
			return false;
		case 'multiselect':
			if (!Array.isArray(value)) return [];
			return value.filter((entry): entry is string => typeof entry === 'string');
		case 'select':
		case 'text':
		default:
			return typeof value === 'string' ? value : '';
	}
}

/**
 * Descriptors out of a manifest, keeping only what the schema would accept.
 *
 * Never throws: a manifest reaches this after the archive has already been
 * verified against its declaration, and a malformed `settings` block is a
 * plugin with fewer settings rather than a plugin that will not install.
 */
export function parseSettingDescriptors(value: unknown): readonly SettingDescriptor[] {
	if (!Array.isArray(value)) return [];
	const out: SettingDescriptor[] = [];
	const seen = new Set<string>();

	for (const entry of value) {
		if (out.length >= MAX_SETTINGS) break;
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;

		const id = text(row['id'], MAX_ID);
		if (id === null || !ID_PATTERN.test(id) || seen.has(id)) continue;

		const type = row['type'];
		if (type !== 'select' && type !== 'multiselect' && type !== 'switch' && type !== 'text') {
			continue;
		}

		const label = text(row['label'], MAX_LABEL);
		if (label === null) continue;

		const help = text(row['help'], MAX_HELP);
		const key = text(row['key'], 128);
		const choices = options(row['options']);

		// A select with nothing to select from is not a setting, it is a dead
		// row. The plugin still reads its own declared default through the
		// bundle, which is the behaviour that already exists.
		if ((type === 'select' || type === 'multiselect') && choices === null) continue;

		const descriptor: SettingDescriptor = {
			id,
			type,
			label,
			...(key === null ? {} : { key }),
			...(help === null ? {} : { help }),
			...(choices === null ? {} : { options: choices }),
			...('default' in row ? { default: row['default'] } : {})
		};
		out.push({ ...descriptor, default: defaultValue(descriptor) });
		seen.add(id);
	}

	return out;
}

/**
 * What the sandbox is handed: the viewer's choices over the declared defaults.
 *
 * A stored value for an id nothing declares is dropped rather than passed
 * through — settings survive an update, and an update that removed a setting
 * removed it.
 */
export function settingValues(
	descriptors: readonly SettingDescriptor[],
	stored: Readonly<Record<string, unknown>> = {}
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const descriptor of descriptors) {
		out[descriptor.id] = Object.prototype.hasOwnProperty.call(stored, descriptor.id)
			? coerce(descriptor, stored[descriptor.id])
			: defaultValue(descriptor);
	}
	return out;
}

/**
 * The host a value would send a plugin to, when the grant does not cover it.
 *
 * Returns null when the value names no host, or names one the plugin already
 * declared. Every string a value carries is checked, because a multiselect of
 * mirrors is a list of them.
 */
export function hostOutsideGrant(
	value: unknown,
	hosts: readonly string[],
	matches: (host: string, pattern: string) => boolean
): string | null {
	const strings = Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === 'string')
		: typeof value === 'string'
			? [value]
			: [];

	for (const candidate of strings) {
		const host = hostIn(candidate);
		if (host === null) continue;
		if (!hosts.some((pattern) => matches(host, pattern))) return host;
	}
	return null;
}

/**
 * The hostname a setting's value names, or null when it names none.
 *
 * A preference value is usually one of three things: a whole URL, a bare
 * hostname, or something that is not a host at all — `sub`, `1080p`, `Server
 * 3`. Only the first two are checked, and the third has to be recognised as
 * *not a host* rather than guessed at, or every plain string setting becomes a
 * refusal.
 */
function hostIn(value: string): string | null {
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;

	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
		try {
			const hostname = new URL(trimmed).hostname.toLowerCase();
			return hostname.length === 0 ? null : hostname;
		} catch {
			return null;
		}
	}

	// A bare hostname: labels separated by dots, a TLD of at least two letters,
	// no spaces and no path. Anything else is a plain value.
	const bare = trimmed.replace(/\/.*$/, '').toLowerCase();
	return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(bare)
		? bare
		: null;
}
