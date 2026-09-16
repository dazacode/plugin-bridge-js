/**
 * Addons published for Stremio, read as a plugin repository.
 *
 * ## One manifest is one addon, and that is the whole index
 *
 * Every other adapter here parses a *list*: a repository document naming
 * dozens of extensions, each with its own artifact to fetch. This ecosystem
 * has no such document. An addon is a URL, and its `/manifest.json` describes
 * exactly one source — so `parseIndex` returns a single listing, and the
 * "repository" a viewer pastes is the addon itself.
 *
 * That is not a degenerate case to apologise for; it is what makes the format
 * cheap. There is no artifact to download, no bytecode to translate and no
 * classpath to provide. `stremio-entry.ts` generates a client for the
 * published protocol and the manifest supplies its four constants.
 *
 * ## Configuration is part of the URL
 *
 * Addons that need a key or a preference set say so with
 * `behaviorHints.configurable`, and the viewer configures them on the addon's
 * own page, which hands back a URL with their settings encoded as a path
 * segment. So a configured addon and a plain one differ only in the string
 * pasted, and this adapter treats everything before `/manifest.json` as an
 * opaque base. Nothing here parses that segment, and nothing logs it — it may
 * carry a viewer's own account key.
 *
 * `configurationRequired: true` is the one refusal: that addon answers nothing
 * useful until it has been configured, so installing the unconfigured URL
 * would produce a source that is permanently empty and look like our fault.
 *
 * ## Rule 9
 *
 * No addon URL appears in this file, its tests or its history. The viewer
 * supplies one, exactly as they supply a repository URL for every other
 * format, and detection is by document shape — a JSON body with `id`, `version`
 * and `resources` — never by hostname.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	keepMediums,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { looksLikeFile } from '@plugin-bridge/core/git-hosts';
import { settingIdFor, type SettingDescriptor } from '@plugin-bridge/core/settings';
import { packageBundle } from '@plugin-bridge/core/package';
import { stremioEntrypoint } from '@plugin-bridge/runtime/shims/stremio-entry';
import type { ForeignMedium } from '@plugin-bridge/core/formats';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** The manifest fields this adapter reads. Everything else is ignored. */
interface StremioManifest {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly version?: unknown;
	readonly description?: unknown;
	readonly types?: unknown;
	readonly resources?: unknown;
	readonly catalogs?: unknown;
	readonly config?: unknown;
	readonly behaviorHints?: unknown;
	readonly logo?: unknown;
	readonly contactEmail?: unknown;
}

/**
 * Whether a parsed document is a manifest at all.
 *
 * Shape, not hostname. `id`, `version` and `resources` are the three the
 * protocol requires of every addon, and a document carrying all three is one
 * whatever it is served from.
 */
function isManifest(value: unknown): value is StremioManifest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	return (
		typeof row['id'] === 'string' &&
		typeof row['version'] === 'string' &&
		Array.isArray(row['resources'])
	);
}

/**
 * The resources an addon serves, as plain names.
 *
 * The protocol permits two spellings — `"stream"` and
 * `{ name: "stream", types: [...] }` — and an addon may use both in one list.
 */
function resourceNames(manifest: StremioManifest): string[] {
	if (!Array.isArray(manifest.resources)) return [];
	const names: string[] = [];
	for (const entry of manifest.resources) {
		if (typeof entry === 'string') names.push(entry);
		else if (typeof entry === 'object' && entry !== null) {
			const name = (entry as Record<string, unknown>)['name'];
			if (typeof name === 'string') names.push(name);
		}
	}
	return names;
}

function typeNames(manifest: StremioManifest): string[] {
	if (!Array.isArray(manifest.types)) return [];
	return manifest.types.filter((one): one is string => typeof one === 'string' && one.length > 0);
}

/**
 * The catalogues this addon will answer a title search against.
 *
 * A catalogue declares what extra arguments it accepts, in either of two
 * spellings, and one that does not accept `search` returns its own unfiltered
 * list for any query — which would bind whatever happened to be trending. So
 * only catalogues that say they are searchable are recorded, and an addon with
 * none is searched not at all.
 */
function searchableCatalogues(manifest: StremioManifest): { type: string; id: string }[] {
	if (!Array.isArray(manifest.catalogs)) return [];
	const out: { type: string; id: string }[] = [];
	for (const entry of manifest.catalogs) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const type = row['type'];
		const id = row['id'];
		if (typeof type !== 'string' || typeof id !== 'string') continue;

		const extra = Array.isArray(row['extra']) ? row['extra'] : [];
		const named = extra.some(
			(one) =>
				typeof one === 'object' &&
				one !== null &&
				(one as Record<string, unknown>)['name'] === 'search'
		);
		const supported = Array.isArray(row['extraSupported'])
			? row['extraSupported'].includes('search')
			: false;
		if (named || supported) out.push({ type, id });
	}
	return out;
}

/**
 * What an addon serves, from the types it declares.
 *
 * `movie` and `series` are the protocol's own names for live-action film and
 * television, and `anime` appears as a non-standard fourth that several addons
 * use. `tv` is live channels and `channel` is a publisher's own feed; neither
 * is a medium this maps, and an addon declaring only those classifies as
 * live-action rather than being dropped — it serves video, and the install
 * check is a better judge of whether it serves anything useful than a guess
 * made from a type list.
 */
function mediaKindsOf(manifest: StremioManifest): ForeignMedium[] {
	const types = typeNames(manifest).map((one) => one.toLowerCase());
	const found: ForeignMedium[] = [];
	if (types.some((one) => one.includes('anime'))) found.push('anime');
	if (
		types.some((one) => one === 'movie' || one === 'series' || one === 'tv' || one === 'channel')
	) {
		found.push('live-action');
	}
	return found.length === 0 ? ['live-action'] : found;
}

/**
 * The addon's own configuration form, as settings this host can draw.
 *
 * A configurable addon declares its fields in `config[]`, and the ecosystem's
 * SDK routes them back as **one path segment holding URL-encoded JSON**
 * (`getRouter.js`: `config = JSON.parse(config)`). So the fields are
 * renderable and the values are applyable, which together mean a viewer sets
 * their own key inside this app instead of being sent to the addon's website
 * to generate a URL and paste it back.
 *
 * `password` maps to `text`, and that is a real loss rather than a neutral
 * one: the manifest schema here has no secret type, so a key a viewer types
 * is drawn in the clear. Worth closing at the schema, not worth papering over
 * by dropping the field — an addon whose only configuration is its key would
 * then be unconfigurable.
 *
 * `number` also maps to `text`, which costs only the keyboard.
 *
 * Anything the schema would reject is dropped rather than repaired, the rule
 * `settings.ts` already applies: a row that does not mean what the manifest
 * says is worse than a missing one.
 */
function settingsFromConfig(manifest: StremioManifest): SettingDescriptor[] {
	if (!Array.isArray(manifest.config)) return [];

	const out: SettingDescriptor[] = [];
	const seen = new Set<string>();
	for (const entry of manifest.config) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const key = typeof row['key'] === 'string' ? row['key'] : '';
		const declared = typeof row['type'] === 'string' ? row['type'] : '';
		if (key.length === 0) continue;

		const id = settingIdFor(key);
		if (id.length === 0 || seen.has(id)) continue;

		const type =
			declared === 'checkbox'
				? 'switch'
				: declared === 'select'
					? 'select'
					: declared === 'text' || declared === 'number' || declared === 'password'
						? 'text'
						: null;
		if (type === null) continue;

		const options = Array.isArray(row['options'])
			? row['options']
					.filter((one): one is string => typeof one === 'string' && one.length > 0)
					.map((one) => ({ value: one, label: one }))
			: [];
		// A select with nothing to select from is a dead control.
		if (type === 'select' && options.length === 0) continue;

		seen.add(id);
		out.push({
			id,
			key,
			type,
			label: typeof row['title'] === 'string' && row['title'].length > 0 ? row['title'] : key,
			...(type === 'select' ? { options } : {}),
			...(row['default'] === undefined
				? {}
				: { default: declared === 'checkbox' ? row['default'] === 'checked' : row['default'] })
		});
	}
	return out;
}

/** Everything before `/manifest.json`, configuration segment included. */
function baseOf(manifestUrl: string): string {
	return manifestUrl.replace(/\/manifest\.json(\?.*)?$/i, '').replace(/\/+$/, '');
}

function listingOf(manifest: StremioManifest, manifestUrl: string): RepositoryPlugin {
	const name =
		typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : 'Addon';
	const version = typeof manifest.version === 'string' ? manifest.version : '0.0.0';
	const base = baseOf(manifestUrl);
	const resources = resourceNames(manifest);
	const hints =
		typeof manifest.behaviorHints === 'object' && manifest.behaviorHints !== null
			? (manifest.behaviorHints as Record<string, unknown>)
			: {};

	return foreignListing({
		// The addon's own id, not its name: two addons may share a display name
		// and the protocol's id is what distinguishes them.
		id: convertedPluginId('stremio', String(manifest.id)),
		name,
		description: typeof manifest.description === 'string' ? manifest.description : '',
		version,
		author: '',
		language: null,
		// The addon's own host, and nothing else. Where a stream ends up
		// pointing is not knowable from a manifest — it is decided per request,
		// per title, often by a CDN — so it is learned at runtime through the
		// host's own mechanism rather than guessed at here.
		hosts: hostsFromUrls([base]),
		origin: {
			format: 'stremio',
			// There is no artifact. The manifest *is* what conversion reads, and
			// recording it here is what lets an update check re-read it.
			artifactUrl: manifestUrl,
			foreignId: String(manifest.id),
			foreignVersion: version,
			mediaKind: mediaKindsOf(manifest)[0],
			mediaKinds: mediaKindsOf(manifest),
			// Both declared by the addon rather than inferred. `adult` was
			// hardcoded false here, which published a claim the manifest was
			// already making for itself.
			declaredP2p: hints['p2p'] === true,
			// The whole reason this format is worth having: the host holds an
			// IMDB id already, so nothing about this source has to be found by
			// searching its catalogue for a title.
			idKinds: ['imdb'],
			isNsfw: hints['adult'] === true,
			detail: {
				base,
				types: typeNames(manifest),
				resources,
				searchable: searchableCatalogues(manifest),
				configurationRequired: hints['configurationRequired'] === true,
				// The bundle needs the id-to-key mapping, because the segment it
				// builds is keyed the way the addon spelled it, not the way this
				// schema had to normalise it.
				config: settingsFromConfig(manifest).map((one) => ({
					id: one.id,
					key: one.key ?? one.id,
					type: one.type,
					label: one.label,
					...(one.options === undefined ? {} : { options: one.options })
				}))
			}
		}
	});
}

/**
 * The addons in a collection document, or null when this is not one.
 *
 * A collection is the shape this ecosystem uses for *a person's whole addon
 * list*: a JSON array of `{ manifest, transportUrl, flags }` descriptors, each
 * carrying the addon's manifest inline beside the address it is served from.
 * It is what a client saves and restores, and it is the one document here that
 * behaves like every other format's repository index — many sources, one URL.
 *
 * That is why it is worth reading. Without it, a viewer moving across brings
 * their addons one paste at a time; with it, the list they already have is one
 * paste, and the existing browse-and-install screen does the rest.
 *
 * **Recognised strictly**, because a bare JSON array is not a distinctive
 * document — one other adapted format publishes its whole extension list as
 * one. Requiring both a `transportUrl` and an inline manifest carrying `id`,
 * `version` and `resources` is what keeps this from claiming somebody else's
 * index, and an array with no such entry is not a collection at all.
 */
function collectionEntries(
	decoded: unknown
): { manifest: StremioManifest; transportUrl: string }[] | null {
	if (!Array.isArray(decoded)) return null;

	const found: { manifest: StremioManifest; transportUrl: string }[] = [];
	for (const entry of decoded) {
		if (typeof entry !== 'object' || entry === null) continue;
		const row = entry as Record<string, unknown>;
		const transportUrl = row['transportUrl'];
		if (typeof transportUrl !== 'string' || transportUrl.length === 0) continue;
		if (!isManifest(row['manifest'])) continue;
		found.push({ manifest: row['manifest'], transportUrl });
	}
	return found.length === 0 ? null : found;
}

/**
 * The manifest URL carried inside a Stremio Web install link.
 *
 * These are what people actually copy. The addon directories and the addons'
 * own pages hand out a link to the *web client* with the manifest as a
 * parameter — `…/#/addons?addon=https://…/manifest.json` — rather than the
 * manifest itself, so a viewer pasting what they were given is pasting a link
 * to somebody else's app. Appending `/manifest.json` to that produces a URL
 * that cannot exist, and the viewer is told their addon is not an addon.
 *
 * **The parameter is in the fragment, not the query.** `#/addons?addon=…` puts
 * the `?` after the `#`, so `url.searchParams.get('addon')` returns null and a
 * reader who checks only there concludes there is nothing to unwrap. This is
 * the whole bug, and it is invisible until tried.
 *
 * Matched by shape rather than by hostname: any host serving that route means
 * the same thing, including a self-hosted web client, and matching on a
 * hostname would be both narrower and the kind of thing rule 9 exists to keep
 * out of this directory. The embedded value is accepted raw or percent-encoded
 * because both forms circulate — `URLSearchParams` decodes the second and
 * leaves the first alone.
 */
function unwrapInstallLink(pasted: URL): string | null {
	const hash = pasted.hash;
	const at = hash.indexOf('?');
	if (at < 0) return null;

	const addon = new URLSearchParams(hash.slice(at + 1)).get('addon');
	if (addon === null || addon.length === 0) return null;

	try {
		const inner = new URL(addon);
		// Only ever https out of here: `detect.ts` enforces that on what it
		// fetches, and an install link is not a way around it.
		return inner.protocol === 'https:' ? inner.toString() : null;
	} catch {
		return null;
	}
}

/**
 * The settings a listing already derived, read back for the bundle.
 *
 * `convert` holds a listing rather than a manifest — conversion is a pure
 * function of the listing (`ForeignOrigin.detail`'s own rule) — so the config
 * shape travels there and this rebuilds the descriptors from it rather than
 * re-fetching a document already read.
 */
function settingsOf(listing: RepositoryPlugin): SettingDescriptor[] {
	const rows = listing.origin?.detail?.['config'];
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((entry) => {
		if (typeof entry !== 'object' || entry === null) return [];
		const row = entry as Record<string, unknown>;
		const id = typeof row['id'] === 'string' ? row['id'] : '';
		const key = typeof row['key'] === 'string' ? row['key'] : '';
		const type = row['type'];
		if (id.length === 0 || (type !== 'text' && type !== 'switch' && type !== 'select')) return [];
		return [
			{
				id,
				key,
				type,
				label: typeof row['label'] === 'string' && row['label'].length > 0 ? row['label'] : key,
				...(Array.isArray(row['options']) ? { options: row['options'] as never } : {})
			} satisfies SettingDescriptor
		];
	});
}

/**
 * A collection, as a repository of sources.
 *
 * Addons that serve no streams are dropped rather than refused: a real
 * collection routinely carries a metadata provider and a subtitle provider
 * beside the sources, and refusing the document for their presence would
 * reject a perfectly ordinary list. They are counted, so the screen can say
 * how many were left out instead of quietly showing a shorter list — the same
 * bargain `keepMediums` makes for an unsupported medium.
 */
function collectionIndex(
	entries: readonly { manifest: StremioManifest; transportUrl: string }[]
): RepositoryIndex {
	const plugins: RepositoryPlugin[] = [];
	const seen = new Set<string>();
	let withoutStreams = 0;

	for (const entry of entries) {
		if (!resourceNames(entry.manifest).includes('stream')) {
			withoutStreams += 1;
			continue;
		}
		const listing = listingOf(entry.manifest, entry.transportUrl);
		// A list may name the same addon twice — two configurations of one
		// service share an id. Two listings sharing an id share a keyed-each
		// key, and the render throws for the whole list rather than the pair.
		if (seen.has(listing.id)) continue;
		seen.add(listing.id);
		plugins.push(listing);
	}

	const kept = keepMediums({
		name: 'Stremio addons',
		updatedAt: '',
		signingKey: null,
		plugins,
		format: 'stremio'
	});
	// `keepMediums` counts what *it* dropped; the stream-less ones were gone
	// before it ran and belong in the same total.
	return { ...kept, filteredOut: (kept.filteredOut ?? 0) + withoutStreams };
}

export const stremioAdapter: ForeignAdapter = {
	format: 'stremio',

	/**
	 * What to try for a pasted URL.
	 *
	 * A viewer pastes whatever their addon's configure page gave them, which is
	 * sometimes the manifest itself and sometimes the directory above it. The
	 * configuration segment is preserved either way, because it is part of the
	 * path and nothing here rewrites paths — only appends one.
	 *
	 * A URL that is already a file is used as given, the same rule every other
	 * adapter follows: appending `/manifest.json` to a `.json` produces a URL
	 * that cannot exist, and buries "that was not a manifest" — which is a
	 * sentence a viewer can act on — under a guaranteed 404.
	 */
	candidates(pasted: URL): string[] {
		// An install link is a link to a client app with the real address
		// inside it. Unwrapped first, because everything below is about the
		// addon's own URL and this is not one yet.
		//
		// A link that names an addon this cannot use offers *nothing* rather
		// than falling back to the link itself: appending `/manifest.json` to a
		// web client's route builds a URL that cannot exist, and spending a
		// request to discover that adds a fetch without adding an answer.
		const named = pasted.hash.includes('addon=');
		const unwrapped = unwrapInstallLink(pasted);
		if (named && unwrapped === null) return [];
		const url = unwrapped === null ? pasted : new URL(unwrapped);

		const raw = url.toString();
		if (looksLikeFile(url)) return [raw];
		return [`${raw.replace(/\/+$/, '')}/manifest.json`];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		// A whole addon list, which is the only document in this format that
		// lists more than one source. Read before the single-manifest case
		// because the two are different JSON shapes and cannot be confused.
		const collection = collectionEntries(decoded);
		if (collection !== null) {
			return collectionIndex(collection);
		}

		if (!isManifest(decoded)) {
			throw new ForeignFormatError('not a Stremio addon manifest');
		}
		// An addon that serves neither streams nor catalogues is a metadata or
		// subtitle provider. Those are real and useful to Stremio itself, and
		// there is nothing this client can do with one: it has its own metadata
		// stack, and a source that cannot produce a stream is not a source.
		const resources = resourceNames(decoded);
		if (!resources.includes('stream')) {
			throw new ForeignFormatError(
				'this addon serves no streams — it provides ' +
					(resources.join(', ') || 'nothing this client can use')
			);
		}

		return keepMediums({
			name: typeof decoded.name === 'string' ? decoded.name : 'Stremio addon',
			updatedAt: '',
			signingKey: null,
			plugins: [listingOf(decoded, indexUrl)],
			format: 'stremio'
		});
	},

	// eslint-disable-next-line @typescript-eslint/require-await
	async convert(listing: RepositoryPlugin, _services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'stremio') {
			throw new ForeignFormatError('That listing did not come from a Stremio addon.');
		}
		const detail = origin.detail ?? {};
		if (detail['configurationRequired'] === true) {
			throw new ForeignFormatError(
				'This addon has to be configured on its own page first. Configuring it there ' +
					'produces a second URL, with your settings in it, and that is the one to paste here.'
			);
		}

		const base = typeof detail['base'] === 'string' ? detail['base'] : '';
		if (base.length === 0) {
			throw new ForeignFormatError('That listing carries no addon address.');
		}

		// No artifact is fetched, because there is none: the bundle is a client
		// for a protocol, and every addon-specific fact it needs was read from
		// the manifest when the listing was made.
		return packageBundle({
			id: listing.id,
			name: listing.name,
			description:
				listing.description.length > 0 ? `Stremio addon. ${listing.description}` : 'Stremio addon.',
			version: listing.version,
			author: listing.author,
			hosts: listing.hosts,
			origin,
			entrypointSource: stremioEntrypoint({
				pluginId: listing.id,
				baseUrl: base,
				types: Array.isArray(detail['types']) ? (detail['types'] as string[]) : [],
				searchable: Array.isArray(detail['searchable'])
					? (detail['searchable'] as { type: string; id: string }[])
					: [],
				config: Array.isArray(detail['config'])
					? (detail['config'] as { id: string; key: string; type: string }[])
					: []
			}),
			settings: settingsOf(listing)
		});
	}
};
