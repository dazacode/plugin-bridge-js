/**
 * Suwatte source repositories, as a repository this build can read.
 *
 * ## Why the artifact is a directory rather than a file
 *
 * Every other adapted ecosystem publishes one file per source. This one
 * publishes TypeScript: `src/sources/<id>/` with `info.ts` beside the runner it
 * exports, plus whatever helpers that runner imports. There is no bundle to
 * download and no single address that is the whole source, so `artifactUrl`
 * names the entry module — a real URL `download` can fetch — and the listing's
 * `detail` carries the plan that says the rest is fetched from the same
 * directory.
 *
 * ## What is refused, and why the refusal is by name
 *
 * TypeScript is stripped, not compiled. The stripper removes the syntax that
 * has no JavaScript left (`type`, `interface`, `declare`, `implements`, `as`,
 * and annotations); anything it does not recognise is left in place and the
 * bundle fails to parse rather than being quietly approximated. A settings
 * view this build has no descriptor for is refused at conversion by the view's
 * own name, for the same reason: a form that loads and loses a control is
 * worse than one that says which control it could not carry.
 *
 * ## Hosts
 *
 * The registration document need not name a site, so hosts are derived from
 * the source itself — `info.website` and every address `hostsInSource` finds in
 * the modules actually fetched. The code host is *not* unioned in: the bundle
 * never fetches its own files.
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
import { parseJsObjectLiteral } from '@plugin-bridge/core/extract/patterns';
import { settingIdFor, type SettingDescriptor } from '@plugin-bridge/core/settings';
import { suwatteEntrypoint } from '@plugin-bridge/runtime/shims/suwatte-entry';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';
import {
	DEFAULT_REFS,
	looksLikeFile,
	pagesCandidates,
	parseRepositoryUrl,
	rawCandidates
} from '@plugin-bridge/core/git-hosts';

/** How many modules one source may pull in before the graph is called large. */
const MAX_MODULES = 24;

/** The view builders this build can turn into a manifest setting. */
const FAITHFUL_VIEWS = new Set(['UIToggle', 'UITextField', 'UIPicker', 'UISelect']);

function directoryOf(indexUrl: string): string {
	const url = new URL(indexUrl);
	url.pathname = url.pathname.replace(/[^/]*$/, '');
	url.search = '';
	url.hash = '';
	return url.toString();
}

/** Everything the converter needs to find a source, all relative to its index. */
interface Plan {
	readonly directory: string;
	readonly entry: string;
	readonly info: string;
}

function planOf(id: string, indexUrl: string): Plan {
	const directory = `${directoryOf(indexUrl)}${id}/`;
	return {
		directory,
		entry: new URL('index.ts', directory).toString(),
		info: new URL('info.ts', directory).toString()
	};
}

/**
 * The `.ts` specifiers one module imports, resolved against itself.
 *
 * Bare packages are returned as their own name so the emitter can decide
 * whether it supplies them; only relative specifiers become URLs.
 */
export function localImports(source: string, moduleUrl: string): string[] {
	const out: string[] = [];
	const pattern = /(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1];
		if (!specifier.startsWith('.')) continue;
		try {
			const url = new URL(specifier, moduleUrl);
			if (/\.[a-z]+$/i.test(url.pathname))
				url.pathname = url.pathname.replace(/\.(?:js|mjs)$/, '.ts');
			else url.pathname += '.ts';
			out.push(url.toString());
		} catch {
			// A specifier that will not resolve is left to fail when fetched,
			// where the message can name it.
		}
	}
	return [...new Set(out)];
}

/** A `SourceInfo` field, read from source rather than run. */
function infoField(source: string, field: string): string | null {
	const quoted = new RegExp(`\\b${field}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`).exec(source);
	if (quoted !== null) return quoted[2];
	const bare = new RegExp(`\\b${field}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(source);
	if (bare !== null) return bare[1];
	const numeric = new RegExp(`\\b${field}\\s*:\\s*([0-9]+(?:\\.[0-9]+)*)`).exec(source);
	return numeric === null ? null : numeric[1];
}

/** A module-level string constant, used to resolve a `website:` reference. */
function constant(source: string, name: string): string | null {
	const pattern = new RegExp(
		`(?:const|let|var)\\s+${name.replace(/[$]/g, '\\$')}\\s*(?::\\s*[^=]+)?=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`
	);
	const found = pattern.exec(source);
	return found === null ? null : found[2];
}

function websiteOf(modules: Map<string, string>, value: string | null): string | null {
	if (value === null) return null;
	if (/^https?:\/\//i.test(value)) return value;
	for (const source of modules.values()) {
		const resolved = constant(source, value);
		if (resolved !== null) return resolved;
	}
	return null;
}

/**
 * The manifest settings a source's forms declare.
 *
 * Read out of `UIToggle({…})` and its siblings rather than by running
 * `getSettingsPage`: the form builder is a function and may need a network
 * round trip, while the calls themselves are literals. A `UISelect` carrying
 * include and exclude lists is filed as a multiselect of the include list —
 * the host has no exclude half — and `UIWebViewButton` stores nothing, like a
 * header.
 */
function declaredSettings(modules: Map<string, string>): SettingDescriptor[] {
	const out: SettingDescriptor[] = [];
	const called = /\b(UI[A-Za-z]+)\s*\(/g;

	for (const [url, source] of modules) {
		for (const match of source.matchAll(called)) {
			const view = match[1];
			if (view === 'UIForm' || view === 'UISection' || view === 'UIWebViewButton') continue;
			if (!FAITHFUL_VIEWS.has(view)) {
				throw new ForeignFormatError(
					`This source's settings form uses ${view}, which this build has no setting for.`,
					[`settings-view:${view}`],
					[
						{
							kind: `settings-view:${view}`,
							file: url,
							member: view,
							line: 1,
							text: match[0].trim(),
							blocking: true
						}
					]
				);
			}

			const open = source.indexOf('{', match.index + match[0].length);
			if (open < 0) continue;
			const parsed = parseJsObjectLiteral(source, open);
			if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
			const row = parsed as Record<string, unknown>;

			const id = typeof row['id'] === 'string' ? row['id'] : '';
			const title = typeof row['title'] === 'string' ? row['title'] : id;
			if (id.length === 0) continue;

			const base = {
				id: settingIdFor(id),
				key: id,
				label: title.slice(0, 64),
				...(typeof row['subtitle'] === 'string' ? { help: row['subtitle'].slice(0, 240) } : {})
			};

			if (view === 'UIToggle') {
				out.push({ ...base, type: 'switch', default: row['defaultValue'] === true });
				continue;
			}
			if (view === 'UITextField') {
				out.push({
					...base,
					type: 'text',
					default: typeof row['defaultValue'] === 'string' ? row['defaultValue'] : ''
				});
				continue;
			}

			const options: { value: string; label: string }[] = [];
			for (const entry of Array.isArray(row['options']) ? row['options'] : []) {
				if (entry === null || typeof entry !== 'object') continue;
				const option = entry as Record<string, unknown>;
				const value = typeof option['id'] === 'string' ? option['id'] : '';
				if (value.length === 0) continue;
				options.push({
					value,
					label: typeof option['title'] === 'string' ? option['title'] : value
				});
			}
			if (options.length === 0) continue;

			const fallback = view === 'UISelect' ? row['defaultValue'] : undefined;
			const include =
				fallback !== null &&
				typeof fallback === 'object' &&
				Array.isArray((fallback as Record<string, unknown>)['include'])
					? ((fallback as Record<string, unknown>)['include'] as unknown[]).filter(
							(one): one is string => typeof one === 'string'
						)
					: [];

			if (view === 'UISelect') {
				out.push({ ...base, type: 'multiselect', options, default: include });
			} else {
				out.push({
					...base,
					type: 'select',
					options,
					default: typeof row['defaultValue'] === 'string' ? row['defaultValue'] : options[0].value
				});
			}
		}
	}
	return out;
}

/**
 * A row of the built catalogue: `sources.json`, `catalogVersion` 2.
 *
 * The toolchain's build publishes one bundle per row at `sources/<path>.stt`
 * beside the catalogue, and marks the row with the runtime that bundle is for,
 * `environment: "jsc"`. That pair is the positive test, and it is this
 * format's alone: a Mana row also carries `path`, with an environment of
 * `source` or `tracker`, which is why the source-tree rows below exclude
 * `path` outright and these are let through only by naming their runtime.
 */
function builtRow(row: Record<string, unknown>): boolean {
	return (
		typeof row['id'] === 'string' &&
		typeof row['name'] === 'string' &&
		typeof row['path'] === 'string' &&
		row['path'].length > 0 &&
		row['environment'] === 'jsc'
	);
}

/**
 * The catalogue's rating, which the build writes as the toolchain's
 * `ContentRating` ordinal rather than its name.
 *
 * Read from the corpus rather than assumed: the one source declaring
 * `SUGGESTIVE` publishes 1 and the seventeen declaring `MATURE` publish 2. So
 * 2 and above is what the named form already flagged — `MATURE`, `ADULT` — and
 * 1 is not.
 */
function builtIsNsfw(rating: unknown): boolean {
	return typeof rating === 'number' && rating >= 2;
}

function builtListing(row: Record<string, unknown>, indexUrl: string): RepositoryPlugin {
	const id = String(row['id']);
	const path = String(row['path']).replace(/^\/+|\/+$/g, '');
	const artifactUrl = new URL(`sources/${path}.stt`, directoryOf(indexUrl)).toString();
	const version = String(row['version'] ?? '0');
	const website = typeof row['website'] === 'string' ? row['website'] : null;
	return foreignListing({
		id: convertedPluginId('suwatte', id),
		name: String(row['name']),
		description: String(row['description'] ?? ''),
		version,
		author: '',
		language:
			Array.isArray(row['languages']) && typeof row['languages'][0] === 'string'
				? row['languages'][0]
				: null,
		hosts: hostsFromUrls([website]),
		origin: {
			format: 'suwatte',
			artifactUrl,
			foreignId: id,
			foreignVersion: version,
			mediaKind: 'manga',
			mediaKinds: ['manga'],
			isNsfw: builtIsNsfw(row['rating']),
			detail: { layout: 'bundle', path }
		}
	});
}

export const suwatteAdapter: ForeignAdapter = {
	format: 'suwatte',

	candidates(pasted: URL): string[] {
		if (looksLikeFile(pasted)) return [pasted.toString()];

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];

		// The source tree's own index on a branch, then the built catalogue,
		// which a repository deploys to its site from CI and never commits —
		// so a repository link reaches it only by asking the site.
		return [
			...['src/index.json', 'index.json', 'dist/index.json'].flatMap((path) =>
				rawCandidates(repository, path, DEFAULT_REFS)
			),
			...pagesCandidates(repository, 'sources.json')
		];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}

		let raw: unknown[];
		if (Array.isArray(decoded)) {
			raw = decoded;
		} else if (
			typeof decoded === 'object' &&
			decoded !== null &&
			Array.isArray((decoded as Record<string, unknown>)['sources'])
		) {
			raw = (decoded as Record<string, unknown>)['sources'] as unknown[];
		} else {
			throw new ForeignFormatError('not a Suwatte source index');
		}

		/*
		 * A version, and none of the siblings' negatives. Hayase's rows also
		 * carry an id, a name and a version, and are separated by their
		 * `manifestVersion`; LNReader's carry `site`/`url` and no version at
		 * all. No suwatte row publishes either negative.
		 *
		 * `path` and `intents` are the third: a Mana row carries both, and a
		 * Mana index is otherwise an id, a name and a version — which is this
		 * row shape exactly. Without the exclusion a Mana repository is read as
		 * Suwatte and every one of its listings is fetched at an address that
		 * does not exist.
		 */
		const rows = raw.filter((entry): entry is Record<string, unknown> => {
			if (typeof entry !== 'object' || entry === null) return false;
			const row = entry as Record<string, unknown>;
			if (builtRow(row)) return true;
			return (
				typeof row['id'] === 'string' &&
				typeof row['name'] === 'string' &&
				(row['version'] !== undefined ||
					row['website'] !== undefined ||
					row['rating'] !== undefined) &&
				row['manifestVersion'] === undefined &&
				row['site'] === undefined &&
				row['path'] === undefined &&
				row['intents'] === undefined &&
				// A Paperback row carries a `capabilities` bit array and no
				// Suwatte row does; like `path`, it is only used to tell the two
				// apart, never interpreted here.
				row['capabilities'] === undefined &&
				// And the two formats whose rows name their own artifact — an
				// Aidoku `downloadURL`, a Seanime `manifestURI`. A Suwatte row
				// names neither, because its file is derived from its id.
				row['downloadURL'] === undefined &&
				row['manifestURI'] === undefined
			);
		});
		if (rows.length === 0) throw new ForeignFormatError('not a Suwatte source index');

		const plugins: RepositoryPlugin[] = [];
		for (const row of rows) {
			if (builtRow(row)) {
				plugins.push(builtListing(row, indexUrl));
				continue;
			}
			const id = String(row['id']);
			const plan = planOf(id, indexUrl);
			const version = String(row['version'] ?? '0');
			const website =
				typeof row['website'] === 'string'
					? row['website']
					: typeof row['websiteBaseURL'] === 'string'
						? row['websiteBaseURL']
						: null;

			plugins.push(
				foreignListing({
					id: convertedPluginId('suwatte', id),
					name: String(row['name']),
					description: String(row['description'] ?? ''),
					version,
					author: '',
					language:
						Array.isArray(row['languages']) && typeof row['languages'][0] === 'string'
							? row['languages'][0]
							: null,
					// The registration document usually names no site; the
					// artifact host is all that is knowable before conversion.
					hosts: hostsFromUrls([website, plan.entry]),
					origin: {
						format: 'suwatte',
						artifactUrl: plan.entry,
						foreignId: id,
						foreignVersion: version,
						mediaKind: 'manga',
						mediaKinds: ['manga'],
						isNsfw: row['rating'] === 'MATURE' || row['rating'] === 'ADULT',
						/*
						 * Not a URL: the source is a directory. The plan is
						 * what makes conversion a pure function of the listing
						 * even though the file set is only known after the
						 * entry module has been read.
						 */
						detail: { directory: plan.directory, entry: 'index.ts', info: 'info.ts' }
					}
				})
			);
		}

		return keepMediums({
			name: 'Suwatte sources',
			updatedAt: '',
			signingKey: null,
			plugins,
			format: 'suwatte'
		});
	},

	async convert(listing: RepositoryPlugin, services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'suwatte') {
			throw new ForeignFormatError('That listing did not come from a Suwatte repository.');
		}

		if (origin.detail?.['layout'] === 'bundle') return convertBuilt(listing, services);

		const entryUrl = origin.artifactUrl;
		const directory = entryUrl.replace(/[^/]*$/, '');
		const plan: Plan = {
			directory,
			entry: entryUrl,
			info: new URL('info.ts', entryUrl).toString()
		};
		const modules = new Map<string, string>();

		let entry: string;
		let info: string;
		try {
			info = await services.getText(plan.info);
			entry = await services.getText(plan.entry);
		} catch {
			throw new ForeignFormatError(
				`${listing.name} does not publish both an info.ts and an index.ts, so there is no runner to convert.`,
				['suwatte:missing-entry'],
				[
					{
						kind: 'suwatte:missing-entry',
						file: plan.directory,
						member: 'index.ts',
						line: 1,
						text: '',
						blocking: true
					}
				]
			);
		}
		modules.set(plan.info, info);
		modules.set(plan.entry, entry);

		// Breadth-first over the runner's own imports. The bound is on the
		// graph, not on each module, so one import-heavy helper cannot hide the
		// rest of the source behind the limit.
		const queue = [...localImports(entry, plan.entry), ...localImports(info, plan.info)];
		while (queue.length > 0) {
			const url = queue.shift()!;
			if (modules.has(url)) continue;
			if (modules.size >= MAX_MODULES) {
				throw new ForeignFormatError(
					`${listing.name} imports more than ${MAX_MODULES} modules, which is larger than a source this build carries in one bundle.`,
					['suwatte:module-graph-too-large'],
					[
						{
							kind: 'suwatte:module-graph-too-large',
							file: plan.entry,
							member: 'import',
							line: 1,
							text: '',
							blocking: true
						}
					]
				);
			}
			let body: string;
			try {
				body = await services.getText(url);
			} catch {
				throw new ForeignFormatError(
					`${listing.name} imports ${url}, which is not there.`,
					['suwatte:missing-sibling'],
					[
						{
							kind: 'suwatte:missing-sibling',
							file: url,
							member: 'import',
							line: 1,
							text: '',
							blocking: true
						}
					]
				);
			}
			modules.set(url, body);
			queue.push(...localImports(body, url));
		}

		const id = infoField(info, 'id');
		const name = infoField(info, 'name');
		if (id === null || name === null) {
			throw new ForeignFormatError(
				`${listing.name} has an info.ts with no id or no name, so the source cannot be identified.`,
				['suwatte:info-incomplete'],
				[
					{
						kind: 'suwatte:info-incomplete',
						file: plan.info,
						member: 'info',
						line: 1,
						text: '',
						blocking: true
					}
				]
			);
		}

		const website = websiteOf(modules, infoField(info, 'website'));
		const hosts = new Set<string>();
		for (const host of hostsFromUrls([website])) hosts.add(host);
		for (const source of modules.values())
			for (const host of hostsInSource(source)) hosts.add(host);

		const settings = declaredSettings(modules);
		const version = infoField(info, 'version') ?? origin.foreignVersion;

		return packageBundle({
			id: listing.id,
			name: name,
			description:
				listing.description.length > 0
					? `Converted Suwatte source. ${listing.description}`
					: 'Converted Suwatte source.',
			version,
			author: '',
			hosts: [...hosts].sort(),
			origin: { ...origin, foreignId: id, foreignVersion: version },
			entrypointSource: suwatteEntrypoint({
				pluginId: listing.id,
				entryUrl: plan.entry,
				modules: [...modules].map(([url, source]) => ({ url, source })),
				settings: settings.map((one) => ({ id: one.id, key: one.key ?? one.id, type: one.type }))
			}),
			settings
		});
	}
};

/**
 * A built `.stt`: the toolchain has already compiled and flattened the source,
 * so the bundle is carried byte for byte and the shim supplies only the host
 * globals it reaches for — the same ones the source-tree path supplies — and
 * calls the `bootstrap()` the build appended.
 *
 * Settings are not read out of a bundle. The form builders are compiled into
 * it beside every view the toolchain defines, so scanning its text would find
 * views the source never uses; the source reads its own preferences through
 * `ObjectStore` and gets its own defaults, which is what a viewer who never
 * opened the form gets.
 */
async function convertBuilt(
	listing: RepositoryPlugin,
	services: ConversionServices
): Promise<Uint8Array> {
	const origin = listing.origin!;
	let bundle: string;
	try {
		bundle = new TextDecoder().decode(await services.fetchArtifact(origin.artifactUrl));
	} catch {
		throw new ForeignFormatError(
			`${listing.name} is listed with a built bundle, and none was published at its path.`,
			['suwatte:missing-bundle']
		);
	}
	if (!/\bvar\s+SourcePackage\s*=/.test(bundle) || !/\bbootstrap\b/.test(bundle)) {
		throw new ForeignFormatError(
			`${listing.name}'s bundle does not define the SourcePackage the toolchain builds, so there ` +
				'is no source in it to start.',
			['suwatte:not-a-bundle']
		);
	}

	const hosts = [...new Set([...listing.hosts, ...hostsInSource(bundle)])].sort();
	return packageBundle({
		id: listing.id,
		name: listing.name,
		description:
			listing.description.length > 0
				? `Converted Suwatte source. ${listing.description}`
				: 'Converted Suwatte source.',
		version: listing.version,
		author: '',
		hosts,
		origin,
		entrypointSource: suwatteEntrypoint({
			pluginId: listing.id,
			entryUrl: origin.artifactUrl,
			modules: [],
			bundle
		})
	});
}
