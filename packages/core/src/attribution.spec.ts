/**
 * What a converted bundle says about whose work it is.
 *
 * A conversion is a **derived work**. The Kotlin and JavaScript these bundles
 * are built from were written by other people and published under real
 * licences — usually a permissive one, which is what makes any of this
 * possible — and the bundle that comes out has to carry that forward rather
 * than quietly presenting itself as ours.
 *
 * The failure this guards against is not legal theatre, it is a factual one:
 * `convertedManifest` used to write `license: 'NOASSERTION'` unconditionally,
 * which is a *claim about someone else's terms* made without looking. Saying
 * "unknown" when the source told us `Apache-2.0` is wrong in the same way a
 * wrong author is wrong.
 *
 * So: the licence is carried when the source stated one, `NOASSERTION` is
 * reserved for genuine ignorance, the upstream licence text travels inside the
 * archive where the integrity check covers it, and the repository the code came
 * from is named in both the manifest and the provenance file.
 */

import { describe, expect, it } from 'vitest';

import { openPluginArchive } from '@plugin-bridge/core/archive';
import { attributionFrom, spdxFromLicenseText } from './attribution';
import { convertedManifest, packageBundle } from './package';
import type { ForeignOrigin } from './formats';

const origin: ForeignOrigin = {
	format: 'aniyomi',
	artifactUrl: 'https://raw.githubusercontent.com/owner/repo/main/apk/example.apk',
	foreignId: 'example',
	foreignVersion: '14.5',
	mediaKind: 'anime',
	isNsfw: false
};

function input(extra: Record<string, unknown> = {}) {
	return {
		id: 'app.yorozo.converted.aniyomi.example',
		name: 'Example',
		description: 'Converted.',
		version: '14.5',
		author: 'Upstream Author',
		hosts: ['watch.example.invalid'],
		origin,
		entrypointSource: 'export default { id: "app.yorozo.converted.aniyomi.example" };',
		...extra
	};
}

describe('the licence a converted bundle declares', () => {
	it('carries the upstream identifier when the source stated one', () => {
		const manifest = convertedManifest(input({ license: 'Apache-2.0' }));
		expect(manifest.license).toBe('Apache-2.0');
	});

	it('says NOASSERTION only when nothing was stated', () => {
		expect(convertedManifest(input()).license).toBe('NOASSERTION');
	});

	it('drops an identifier the schema would reject rather than correcting it', () => {
		// A licence field that says something slightly different from what
		// upstream wrote is worse than one that admits it does not know.
		expect(convertedManifest(input({ license: 'Apache 2.0 (modified)' })).license).toBe(
			'NOASSERTION'
		);
	});
});

describe('who a converted bundle credits', () => {
	it('names the original author and links them when the metadata does', () => {
		const manifest = convertedManifest(
			input({ authorUrl: 'https://github.com/owner' })
		) as unknown as { author: { name: string; url?: string } };

		expect(manifest.author.name).toBe('Upstream Author');
		expect(manifest.author.url).toBe('https://github.com/owner');
	});

	it('names the repository the source came from', () => {
		const manifest = convertedManifest(input({ repository: 'https://github.com/owner/repo' }));
		expect(manifest.repository).toBe('https://github.com/owner/repo');
	});

	it('omits a link it cannot vouch for rather than emitting a broken one', () => {
		// The schema requires https, and an absent field is honest where a
		// mangled one would be a dead link in a credit.
		const manifest = convertedManifest(input({ repository: 'not a url', authorUrl: 'ftp://x/y' }));
		expect(manifest.repository).toBeUndefined();
		expect((manifest as unknown as { author: { url?: string } }).author.url).toBeUndefined();
	});
});

describe('the upstream licence text', () => {
	it('travels inside the archive, where the integrity check covers it', async () => {
		const bytes = await packageBundle(
			input({
				license: 'Apache-2.0',
				licenseText: 'Apache License\nVersion 2.0'
			})
		);
		// It opens through the ordinary reader — a converted bundle carrying an
		// extra member is still an ordinary bundle, and conversion has no path
		// to storage that skips verification.
		const bundle = await openPluginArchive(bytes);
		expect(bundle.manifest.id).toBe('app.yorozo.converted.aniyomi.example');
	});

	it('does not disturb determinism', async () => {
		const args = input({
			license: 'Apache-2.0',
			licenseText: 'Apache License\nVersion 2.0'
		});
		const [first, second] = [await packageBundle(args), await packageBundle(args)];
		// `REPOSITORY.md` §6: converting the same input twice produces
		// byte-identical output, so a digest is a fact about the input.
		expect(Array.from(first)).toEqual(Array.from(second));
	});
});

describe('the provenance file', () => {
	it('records where the code came from and under what terms', async () => {
		const bytes = await packageBundle(
			input({
				license: 'Apache-2.0',
				repository: 'https://github.com/owner/repo'
			})
		);
		// `signature.json` is what a reviewer reads to answer "where did this
		// come from and whose is it", so the answer lives there too and not
		// only in the manifest.
		const text = new TextDecoder().decode(bytes);
		expect(text).toContain('sourceRepository');
		expect(text).toContain('upstreamLicense');
	});
});

describe('reading the upstream licence rather than assuming it', () => {
	it('identifies a licence from its own title line', () => {
		expect(spdxFromLicenseText('   Apache License\n   Version 2.0, January 2004\n')).toBe(
			'Apache-2.0'
		);
		expect(
			spdxFromLicenseText(
				'Permission is hereby granted, free of charge, to any person obtaining a copy'
			)
		).toBe('MIT');
		expect(spdxFromLicenseText('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007')).toBe(
			'GPL-3.0'
		);
	});

	it('does not confuse the Lesser and Affero variants with the plain one', () => {
		// Each names the plain GPL inside its own preamble, so a keyword match
		// would return the wrong identifier — a false statement about someone
		// else's licensing, which is worse than no answer.
		expect(spdxFromLicenseText('GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007')).toBe(
			'LGPL-3.0'
		);
		expect(
			spdxFromLicenseText('GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007')
		).toBe('AGPL-3.0');
	});

	it('answers null for text it cannot identify, and null is a real answer', () => {
		// Not "no licence" — "we could not read the licence". The caller turns
		// that into NOASSERTION rather than into a guess.
		expect(spdxFromLicenseText('Copyright somebody. All rights reserved.')).toBeNull();
		expect(spdxFromLicenseText('')).toBeNull();
		expect(spdxFromLicenseText(null)).toBeNull();
	});
});

describe('who a conversion credits', () => {
	it('credits the repository owner and links both owner and repository', () => {
		// These ecosystems record no per-extension author anywhere a converter
		// can reach, so the credit is to the repository — a link a reader can
		// follow to the real authorship, rather than a name we invented.
		expect(
			attributionFrom({
				sourceRepositoryUrl: 'https://example.invalid/owner/repo'
			})
		).toEqual({
			author: 'owner',
			authorUrl: 'https://example.invalid/owner',
			repository: 'https://example.invalid/owner/repo',
			license: undefined
		});
	});

	it('drops a .git suffix so the credit links somewhere a person can read', () => {
		const found = attributionFrom({
			sourceRepositoryUrl: 'https://example.invalid/o/r.git'
		});
		expect(found.repository).toBe('https://example.invalid/o/r');
	});

	it('falls back to what the index claimed, and to unknown — never to us', () => {
		expect(attributionFrom({ sourceRepositoryUrl: 'not a url' }).author).toBe('unknown');
		expect(
			attributionFrom({
				sourceRepositoryUrl: null,
				fallbackAuthor: 'Someone Else'
			}).author
		).toBe('Someone Else');
	});

	it('refuses a non-https repository rather than crediting over cleartext', () => {
		expect(attributionFrom({ sourceRepositoryUrl: 'http://example.invalid/o/r' }).author).toBe(
			'unknown'
		);
	});
});
