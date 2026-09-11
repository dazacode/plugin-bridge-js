/**
 * Working out whose work a conversion is derived from, and under what terms.
 *
 * A converted bundle is a derived work. The Kotlin and JavaScript it is built
 * from were written by other people and published under real licences —
 * usually a permissive one, which is the only reason any of this is possible —
 * and the bundle has to carry that forward rather than presenting itself as
 * ours. `FOREIGN.md` §5.1 is the normative version; this file is how the
 * fields are filled.
 *
 * ## Read, never assume
 *
 * The temptation is to write `Apache-2.0` because that is what these
 * repositories usually use. That would be a claim about someone else's terms
 * made without looking, and it is wrong in exactly the way a wrong author is
 * wrong. So the licence is **detected from the repository's own `LICENSE`
 * file**, and when there is no confident match the answer is `NOASSERTION` —
 * which is a statement that we did not find the terms, not a claim that there
 * are none.
 *
 * The detector is deliberately narrow. It matches on the licence's own
 * self-identifying line, not on scattered keywords, because a fuzzy match that
 * returns `GPL-3.0` for an Apache file is worse than no match at all: one is a
 * missing credit, the other is a false statement about someone's licensing.
 *
 * ## Who gets credited, and the honest limit of it
 *
 * These ecosystems do not record a per-extension author anywhere a converter
 * can reach: the index entry has no author field, and the build file names the
 * extension rather than the person. What *is* knowable is the repository the
 * source came from and who publishes it. So the credit is to that repository
 * and its owner, and it is a link a reader can follow to the real authorship —
 * which is more useful than a name we would have had to invent, and more
 * honest than `unknown`.
 *
 * ## Rule 9
 *
 * Nothing here names a content source. It takes a repository URL that a viewer
 * pasted or that a foreign manifest supplied, and returns fields; the only
 * hosts it recognises are the forge hosts `git-hosts.ts` already names.
 */

/** The attribution fields a converted bundle carries. */
export interface Attribution {
	/** Credited name — a repository owner, not an invented person. */
	readonly author: string;
	/** Their page on the forge, when the URL was one we could read. */
	readonly authorUrl?: string;
	/** The source repository, https. */
	readonly repository?: string;
	/** Upstream SPDX identifier, when the licence text said so plainly. */
	readonly license?: string;
}

/**
 * SPDX identifiers, matched on each licence's own title line.
 *
 * Ordered most specific first: an Apache-2.0 file contains the word "License"
 * a great many times, and a GPL file names the Lesser GPL in its own preamble,
 * so a first-match-wins list has to put the narrow patterns before the broad
 * ones.
 */
const LICENCE_PATTERNS: readonly (readonly [string, RegExp])[] = [
	['Apache-2.0', /Apache License\s*,?\s*Version 2\.0/i],
	['AGPL-3.0', /GNU AFFERO GENERAL PUBLIC LICENSE\s*,?\s*Version 3/i],
	['LGPL-3.0', /GNU LESSER GENERAL PUBLIC LICENSE\s*,?\s*Version 3/i],
	['LGPL-2.1', /GNU LESSER GENERAL PUBLIC LICENSE\s*,?\s*Version 2\.1/i],
	['GPL-3.0', /GNU GENERAL PUBLIC LICENSE\s*,?\s*Version 3/i],
	['GPL-2.0', /GNU GENERAL PUBLIC LICENSE\s*,?\s*Version 2/i],
	['MPL-2.0', /Mozilla Public License\s*,?\s*Version 2\.0/i],
	['BSD-3-Clause', /Redistributions of source code[\s\S]{0,2000}?name of the copyright holder/i],
	['BSD-2-Clause', /Redistributions of source code[\s\S]{0,1200}?Redistributions in binary form/i],
	['ISC', /Permission to use, copy, modify, and\/or distribute this software/i],
	['Unlicense', /This is free and unencumbered software released into the public domain/i],
	['MIT', /Permission is hereby granted, free of charge, to any person obtaining a copy/i]
];

/**
 * The SPDX identifier a licence file states, or null.
 *
 * Null is a real answer and the caller must treat it as one. A licence this
 * cannot identify is not an absent licence — it is one we could not read, and
 * the difference matters to whoever wrote it.
 */
export function spdxFromLicenseText(text: string | null | undefined): string | null {
	if (typeof text !== 'string') return null;
	// Bounded: a LICENSE file is kilobytes, and a repository that serves
	// megabytes under that name is not one to run regexes over.
	const body = text.slice(0, 64 * 1024);
	if (body.trim().length === 0) return null;

	for (const [identifier, pattern] of LICENCE_PATTERNS) {
		if (pattern.test(body)) return identifier;
	}
	return null;
}

/** `https://<forge>/<owner>/<repo>` → its two path segments. */
function ownerAndRepo(url: string): { owner: string; repo: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== 'https:') return null;

	const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
	if (segments.length < 2) return null;

	const owner = segments[0];
	const repo = segments[1].replace(/\.git$/, '');
	if (owner.length === 0 || repo.length === 0) return null;
	return { owner, repo };
}

/**
 * Everything a bundle can honestly say about where its code came from.
 *
 * `fallbackAuthor` is whatever the foreign index claimed, used only when the
 * repository URL cannot be read — an index that names an author is rare in
 * these ecosystems, but ignoring one that does would be discarding the better
 * answer.
 */
export function attributionFrom(input: {
	readonly sourceRepositoryUrl?: string | null;
	readonly licenseText?: string | null;
	readonly fallbackAuthor?: string;
}): Attribution {
	const license = spdxFromLicenseText(input.licenseText) ?? undefined;
	const url = typeof input.sourceRepositoryUrl === 'string' ? input.sourceRepositoryUrl : '';
	const parts = url.length > 0 ? ownerAndRepo(url) : null;

	if (parts === null) {
		const fallback = (input.fallbackAuthor ?? '').trim();
		return {
			// `unknown` rather than this project's name. A conversion whose
			// provenance we lost is not a conversion we authored.
			author: fallback.length > 0 ? fallback : 'unknown',
			license
		};
	}

	const origin = new URL(url).origin;
	return {
		author: parts.owner,
		authorUrl: `${origin}/${parts.owner}`,
		repository: `${origin}/${parts.owner}/${parts.repo}`,
		license
	};
}
