/**
 * Nuvio scrapers, as a repository this build can read.
 *
 * An index names each scraper and the file it lives in, separately — which no
 * other format here does — so the artifact is *resolved from the index* rather
 * than guessed from an id. Two shapes are published: one carrying a `base` for
 * every entry, and one where each `filename` is relative to the index itself.
 *
 * ## Every one of these is obfuscated, and that is the whole difficulty
 *
 * 60 of the 61 measured scrapers are string-array obfuscated, which moves every
 * string literal in the file into one rotated, encoded array. A reader that
 * runs before `unpackStringArray` does not see *fewer* of the hosts a scraper
 * reaches — it very often sees none: five declared no address at all, and four
 * of those five are sources this build has watched play. So unpacking is not a
 * tidying step that happens to help. It is the difference between a bundle
 * whose allowlist is right and one whose every request is refused at call time
 * and reported to a viewer as a source that does not work.
 *
 * Unpacking happens before anything is read, and everything is read from the
 * unpacked text: the hosts, the settings, nothing else.
 *
 * ## TMDB is declared because the scrapers call it
 *
 * 52 of 61 look the id up themselves before doing anything else, each carrying
 * its own key. That address is therefore a dependency of the scraper rather
 * than a convenience of ours, and it is declared per listing when the source
 * names it — not granted across the ecosystem because it is common.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	hostsInSource,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { packageBundle } from '@plugin-bridge/core/package';
import { parseJsObjectLiteral, unpackStringArray } from '@plugin-bridge/core/extract/patterns';
import { settingIdFor, type SettingDescriptor } from '@plugin-bridge/core/settings';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import { nuvioEntrypoint } from '@plugin-bridge/runtime/shims/nuvio-entry';
import {
	DEFAULT_REFS,
	looksLikeFile,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/** How far past `onSettings` the schema is looked for before giving up. */
const SETTINGS_WINDOW = 4000;

/**
 * The balanced body of the `onSettings` declaration, whichever way it is spelled.
 *
 * Scoped to the declaration rather than searched for from its name, because
 * "the first `return [` after the word" finds the wrong array in a file where
 * `onSettings` is mentioned before it is defined — and the wrong array parses,
 * so the mistake arrives as a plausible settings screen rather than as nothing.
 */
function settingsBody(source: string): string | null {
	const declaration =
		/(?:function\s+onSettings\s*\(|onSettings\s*[:=]\s*(?:async\s+)?function\s*\(|onSettings\s*[:=]\s*(?:async\s*)?\()/g;
	const found = declaration.exec(source);
	if (found === null) return null;

	const open = source.indexOf('{', found.index + found[0].length);
	if (open < 0) return null;

	let depth = 0;
	for (let i = open; i < source.length && i - open < SETTINGS_WINDOW * 4; i++) {
		const c = source.charAt(i);
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return source.slice(open, i);
		} else if (c === '"' || c === "'" || c === '`') {
			i++;
			while (i < source.length && source.charAt(i) !== c) {
				if (source.charAt(i) === '\\') i++;
				i++;
			}
		}
	}
	return null;
}

/**
 * The settings a scraper declares, as the host's own manifest shape.
 *
 * Read, never run. `onSettings` is a function that returns a literal, so the
 * literal is parsed out of it — which is the same trade the packer beside it
 * makes, and the reason conversion never becomes code execution.
 *
 * A scraper whose schema does not parse contributes none, and its own defaults
 * apply: every one of them reads its values as `SETTINGS[key] || <default>`,
 * so an absent setting is the case they already handle.
 */
function declaredSettings(source: string): SettingDescriptor[] {
	const body = settingsBody(source);
	if (body === null) return [];

	const from = body.search(/return\s*\[/);
	if (from < 0) return [];
	const parsed = parseJsObjectLiteral(body, body.indexOf('[', from));
	if (!Array.isArray(parsed)) return [];

	const out: SettingDescriptor[] = [];
	for (const one of parsed) {
		if (one === null || typeof one !== 'object') continue;
		const row = one as Record<string, unknown>;
		const key = typeof row['key'] === 'string' ? row['key'] : '';
		const kind = typeof row['type'] === 'string' ? row['type'] : '';
		// A header is a caption this ecosystem draws between groups. It carries
		// no key and stores nothing, so it is not a setting — and emitting one
		// would put a control on the screen that cannot be answered.
		if (key.length === 0 || kind === 'header') continue;

		const label = typeof row['label'] === 'string' ? row['label'] : key;
		const help = typeof row['description'] === 'string' ? row['description'] : undefined;
		const base = { id: settingIdFor(key), key, label, ...(help === undefined ? {} : { help }) };

		if (kind === 'toggle') {
			out.push({ ...base, type: 'switch', default: row['default'] === true });
			continue;
		}
		if (kind === 'text') {
			out.push({
				...base,
				type: 'text',
				default: typeof row['default'] === 'string' ? row['default'] : ''
			});
			continue;
		}
		if (kind !== 'select' || !Array.isArray(row['options'])) continue;

		const options: { value: string; label: string }[] = [];
		for (const option of row['options']) {
			if (option === null || typeof option !== 'object') continue;
			const entry = option as Record<string, unknown>;
			const value = typeof entry['value'] === 'string' ? entry['value'] : '';
			if (value.length === 0) continue;
			options.push({ value, label: typeof entry['label'] === 'string' ? entry['label'] : value });
		}
		if (options.length === 0) continue;
		out.push({
			...base,
			type: 'select',
			options,
			default: typeof row['default'] === 'string' ? row['default'] : options[0].value
		});
	}
	return out;
}

/** An index entry, in either of the two published shapes. */
function entryOf(row: Record<string, unknown>, base: string, indexUrl: string): string | null {
	const filename = typeof row['filename'] === 'string' ? row['filename'] : '';
	if (filename.length === 0) return null;
	try {
		return new URL(filename, base.length > 0 ? base + '/' : indexUrl).toString();
	} catch {
		return null;
	}
}

export const nuvioAdapter: ForeignAdapter = {
	format: 'nuvio',

	candidates(pasted: URL): string[] {
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		return ['nuvio.json', 'manifest.json', 'scrapers.json', 'index.json'].flatMap((path) =>
			rawCandidates(repository, path, DEFAULT_REFS)
		);
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
			throw new ForeignFormatError('not a Nuvio scraper index');
		}

		const document = decoded as Record<string, unknown>;
		// `scrapers` on the document, with each entry naming its own file, is
		// what distinguishes this from every other object-shaped index here.
		const scrapers = document['scrapers'];
		if (!Array.isArray(scrapers) || scrapers.length === 0) {
			throw new ForeignFormatError('not a Nuvio scraper index');
		}

		const base = typeof document['base'] === 'string' ? document['base'].replace(/\/+$/, '') : '';
		const rows = scrapers.filter(
			(entry): entry is Record<string, unknown> =>
				typeof entry === 'object' &&
				entry !== null &&
				typeof (entry as Record<string, unknown>)['id'] === 'string' &&
				typeof (entry as Record<string, unknown>)['filename'] === 'string'
		);
		if (rows.length === 0) throw new ForeignFormatError('not a Nuvio scraper index');

		const plugins = [];
		for (const row of rows) {
			// `enabled: false` is the index's own word that an entry is not to be
			// offered. Listing it anyway would put a row on screen that its
			// publisher has withdrawn.
			if (row['enabled'] === false) continue;

			const artifactUrl = entryOf(row, base, indexUrl);
			if (artifactUrl === null) continue;

			const id = String(row['id']);
			const languages = Array.isArray(row['contentLanguage']) ? row['contentLanguage'] : [];
			plugins.push(
				foreignListing({
					id: convertedPluginId('nuvio', id),
					name: String(row['name'] ?? id),
					description: String(row['description'] ?? ''),
					version: String(row['version'] ?? '0'),
					author: String(row['author'] ?? ''),
					language: languages.length > 0 ? String(languages[0]) : null,
					hosts: hostsFromUrls([artifactUrl]),
					origin: {
						format: 'nuvio',
						artifactUrl,
						foreignId: id,
						foreignVersion: String(row['version'] ?? '0'),
						/*
						 * Both, and not a guess per scraper. These are addressed
						 * by a TMDB id and answer for whatever that id names, so
						 * a scraper is as capable of an animated series as of a
						 * film. Declaring one would hide it from half the
						 * catalogue it can actually serve.
						 */
						mediaKinds: ['anime', 'live-action'],
						// The collapsed value the older readers take; `mediaKinds`
						// above is the real answer and the two must not disagree.
						mediaKind: 'live-action',
						// The whole reason `ExternalIdKind` gained a third member.
						idKinds: ['tmdb'],
						isNsfw: row['nsfw'] === true
					}
				})
			);
		}
		if (plugins.length === 0) throw new ForeignFormatError('not a Nuvio scraper index');

		return keepMediums({
			name: String(document['name'] ?? 'Nuvio scrapers'),
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'nuvio'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'nuvio') {
			throw new ForeignFormatError('That listing did not come from a Nuvio repository.');
		}

		const raw = new TextDecoder().decode(await services.fetchArtifact(origin.artifactUrl));

		/*
		 * Before anything is read from it. `unpackStringArray` answers `null`
		 * for a source that was not obfuscated, which one of the sixty-one is,
		 * and the original text is then exactly what should be read.
		 */
		const script = unpackStringArray(raw) ?? raw;

		/*
		 * From the source and nothing else — deliberately *not* unioned with the
		 * listing's, which is where the code was downloaded from. A scraper does
		 * not fetch its own file at runtime, so declaring that address grants a
		 * host nothing ever reaches. Measured across the corpus: every one of the
		 * sixty-one names at least one address of its own once unpacked, so the
		 * narrower list costs no source and removes a standing grant from all of
		 * them.
		 */
		const hosts = [...new Set(hostsInSource(script))].sort();

		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0
					? `Converted Nuvio source. ${listing.description}`
					: 'Converted Nuvio source.',
			version: listing.version,
			author: listing.author,
			hosts,
			origin,
			entrypointSource: nuvioEntrypoint({ pluginId: listing.id, script }),
			settings: declaredSettings(script)
		});
	}
};
