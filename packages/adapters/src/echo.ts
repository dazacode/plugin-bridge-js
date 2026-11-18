/**
 * Echo — the music client whose extensions are APKs published as release
 * assets, and the one ecosystem of the three with no registry document.
 *
 * ## There is no index, so the *release list* is the index
 *
 * Echo's catalogue is a URL the viewer pastes and the client fetches as JSON;
 * the shape it reads is a flat list of `{id, name, updateUrl}`. That list is
 * not a document the extension's own repository publishes — it is whatever a
 * community index happens to serve — so the one address that is always true of
 * an extension repository is its **releases**, and that is what this adapter
 * asks for. GitHub's own releases array is read as one plugin per `.apk`
 * asset; `tag_name` plus `assets` is the negative nothing else here has, which
 * is what lets detection tell a release list from an Aniyomi or Mihon array.
 *
 * An address that is already a document — a community `index.json`, or a
 * releases API URL — is used as given, so a reader who has one can paste it.
 *
 * ## Why the listing converts nothing yet, and says which thing
 *
 * `ExtensionParser` installs an Echo extension by opening the APK's manifest
 * metadata (`class`, `id`, `version`, `type` — a feature named
 * `dev.brahmkshatriya.echo.<type>`), loading the class out of the dex and
 * casting it to `ExtensionClient`. So the reachable thing is an APK, and this
 * build opens zip archives, not dex. Each listing therefore refuses, naming
 * the asset and the `DexLoader`, rather than the format-wide "not built yet"
 * that would leave a reader unable to tell a broken extension from a
 * converted one.
 *
 * The source repository *is* named by every release's `html_url`, and an Echo
 * extension's Kotlin lives in `ext/` of it. That is the work that would make
 * these convertible, and this file records it on `origin.detail` so a later
 * front-end needs no second read of the release to find it.
 *
 * ## Medium
 *
 * `anime` and `live-action` together. Echo is a music client, and neither
 * medium is what it plays; but the host that shows a converted Echo bundle
 * would be the video host — a track is a playable item reached exactly as a
 * stream is — so claiming otherwise would file these where nothing can open
 * them.
 *
 * ## Rule 9
 *
 * `api.github.com` is named because it is the forge's API, the same
 * distinction that lets `git-hosts.ts` name its raw host. No content source
 * appears.
 */

import {
	convertedPluginId,
	foreignListing,
	hostsFromUrls,
	ForeignFormatError,
	type ConversionServices,
	type ForeignAdapter
} from '@plugin-bridge/core/adapter';
import { looksLikeFile, parseRepositoryUrl } from '@plugin-bridge/core/git-hosts';
import type { RepositoryIndex, RepositoryPlugin } from '@plugin-bridge/core/repository-index';

/** A release row needs both of these; nothing else in this directory has either. */
function isReleaseRow(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const row = value as Record<string, unknown>;
	return typeof row['tag_name'] === 'string' && Array.isArray(row['assets']);
}

/** The `.apk` assets of one release, with the name they will be stored under. */
interface EchoAsset {
	readonly name: string;
	readonly url: string;
	readonly id: string | null;
}

function apkAssets(release: Record<string, unknown>): EchoAsset[] {
	return (release['assets'] as unknown[])
		.filter(
			(asset): asset is Record<string, unknown> =>
				typeof asset === 'object' &&
				asset !== null &&
				typeof (asset as Record<string, unknown>)['browser_download_url'] === 'string' &&
				/\.apk$/i.test(String((asset as Record<string, unknown>)['name'] ?? ''))
		)
		.map((asset) => ({
			name: String(asset['name']),
			url: String(asset['browser_download_url']),
			id: asset['id'] === undefined ? null : String(asset['id'])
		}));
}

/** The repository a release API row belongs to, from its own URLs. */
function repositoryOf(release: Record<string, unknown>, indexUrl: string): string | null {
	for (const candidate of [release['html_url'], release['url'], indexUrl]) {
		if (typeof candidate !== 'string') continue;
		try {
			const repository = parseRepositoryUrl(new URL(candidate));
			if (repository !== null) return `${repository.origin}/${repository.owner}/${repository.repo}`;
		} catch {
			// A release with no usable URL is not a listing anything can be
			// matched against; the caller keeps the row and leaves the source
			// repository null rather than inventing one.
		}
	}
	return null;
}

/** `v1.2.3` without its prefix, and the asset's own stem when the tag is bare. */
function versionOf(release: Record<string, unknown>, asset: EchoAsset): string {
	const tag = String(release['tag_name'] ?? '');
	if (tag.length > 0) return tag.replace(/^v/i, '');
	return asset.name.replace(/\.apk$/i, '');
}

export const echoAdapter: ForeignAdapter = {
	format: 'echo',

	candidates(pasted: URL): string[] {
		// A document somebody already holds is used as given.
		if (looksLikeFile(pasted) || /\/releases$/.test(pasted.pathname)) {
			return [pasted.toString()];
		}

		const repository = parseRepositoryUrl(pasted);
		if (repository === null) return [];
		if (repository.origin !== 'https://github.com') return [];

		// The API rather than the repository page: the page is HTML, and this
		// fetch has no parser behind it. `per_page` is echoed because the host
		// may have pasted it and it bounds one request's answer.
		const api = `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases`;
		return [api, `${api}?per_page=100`];
	},

	parseIndex(body: string, indexUrl: string): RepositoryIndex {
		let decoded: unknown;
		try {
			decoded = JSON.parse(body);
		} catch {
			throw new ForeignFormatError('not JSON');
		}
		if (!Array.isArray(decoded) || decoded.length === 0 || !decoded.every(isReleaseRow)) {
			throw new ForeignFormatError('not an Echo release list');
		}

		const plugins: RepositoryPlugin[] = [];
		for (const release of decoded) {
			const repository = repositoryOf(release, indexUrl);
			const tag = String(release['tag_name'] ?? '');
			const prerelease = release['prerelease'] === true;
			const published = String(release['published_at'] ?? '');
			for (const asset of apkAssets(release)) {
				const version = versionOf(release, asset);
				// The asset name is the only identifier a release carries. The
				// extension id inside the APK's manifest is not readable here,
				// and a listing whose id is invented would not match on update.
				const foreignId = `${repository ?? 'echo'}#${asset.name}`;
				plugins.push(
					foreignListing({
						id: convertedPluginId('echo', foreignId),
						name: String(release['name'] ?? '') || asset.name.replace(/\.apk$/i, ''),
						description: prerelease ? `${tag} (prerelease)` : tag,
						version,
						author: '',
						language: null,
						hosts: hostsFromUrls([asset.url, repository]),
						origin: {
							format: 'echo',
							artifactUrl: asset.url,
							foreignId,
							foreignVersion: version,
							mediaKind: 'anime',
							mediaKinds: ['anime', 'live-action'],
							isNsfw: false,
							detail: {
								repository,
								asset: asset.name,
								assetId: asset.id,
								tag,
								published
							}
						}
					})
				);
			}
		}

		if (plugins.length === 0) {
			throw new ForeignFormatError('an Echo release list with no .apk asset');
		}

		return {
			name: 'Echo extensions',
			updatedAt: '',
			signingKey: null,
			plugins,
			filteredOut: 0,
			format: 'echo'
		};
	},

	/**
	 * The honest half: what is published is dex, and this build has no dex
	 * reader. Everything the front-end can read exists upstream and is named on
	 * the listing, so the sentence points at the work rather than at a bug.
	 */
	async convert(listing: RepositoryPlugin, _services: ConversionServices): Promise<Uint8Array> {
		const origin = listing.origin;
		if (origin === undefined || origin.format !== 'echo') {
			throw new ForeignFormatError('That listing did not come from an Echo release list.');
		}
		const detail = origin.detail ?? {};
		const asset = typeof detail['asset'] === 'string' ? detail['asset'] : 'the release asset';
		const repository = typeof detail['repository'] === 'string' ? detail['repository'] : '';

		throw new ForeignFormatError(
			`${listing.name} is published as \`${asset}\`, an Android APK: Echo loads an extension by ` +
				'reading its manifest metadata and instantiating the class through `DexLoader`, so what is ' +
				'installable is dex and this build has no dex reader.' +
				(repository.length > 0
					? ` The Kotlin it is built from is in \`${repository}\`, and converting that source is ` +
						'the work this listing is waiting on.'
					: ''),
			[`an Android APK (\`${asset}\`) read through \`DexLoader\``]
		);
	}
};
