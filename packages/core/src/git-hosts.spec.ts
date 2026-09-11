/**
 * Where a file lives, given a repository URL, on whichever forge it is on.
 *
 * Two of these tests exist because of bugs that reached a screen. The first is
 * the one that matters most: a URL that already names a file must be used
 * untouched. Appending `/index.min.json` to `…/thing.json` produces a URL that
 * cannot exist, and the two guaranteed 404s that follow bury whatever actually
 * went wrong with the real URL — which, on a self-hosted forge, is usually a
 * response the browser discarded for lack of a CORS header.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_REFS, looksLikeFile, parseRepositoryUrl, rawCandidates } from './git-hosts';
import { FOREIGN_ADAPTERS } from '@plugin-bridge/adapters';

const repo = (href: string) => parseRepositoryUrl(new URL(href));

describe('reading a pasted URL as a repository', () => {
	it('takes owner and repo from any forge', () => {
		expect(repo('https://github.com/owner/repo')).toMatchObject({
			origin: 'https://github.com',
			owner: 'owner',
			repo: 'repo',
			ref: null
		});
		expect(repo('https://codeberg.example/owner/repo.git')).toMatchObject({
			origin: 'https://codeberg.example',
			owner: 'owner',
			repo: 'repo'
		});
	});

	it('keeps a branch the URL named', () => {
		// Somebody who pasted a branch page meant that branch, and serving them a
		// different one silently is worse than not finding anything.
		expect(repo('https://github.com/owner/repo/tree/nightly')?.ref).toBe('nightly');
		expect(repo('https://forge.example/owner/repo/src/branch/nightly')?.ref).toBe('nightly');
	});

	it('is not a repository when there is no repository there', () => {
		expect(repo('https://example.invalid/')).toBeNull();
		expect(repo('https://example.invalid/onlyone')).toBeNull();
	});
});

describe('raw file URLs', () => {
	it('uses GitHub’s raw domain, which sends CORS headers', () => {
		const candidates = rawCandidates(repo('https://github.com/owner/repo')!, 'index.json', [
			'main'
		]);
		expect(candidates).toEqual(['https://raw.githubusercontent.com/owner/repo/main/index.json']);
	});

	it('offers both self-hostable shapes for an unknown forge', () => {
		// The host does not say which software is behind it, and guessing from a
		// hostname would mean keeping a list of hostnames.
		const candidates = rawCandidates(repo('https://forge.example/owner/repo')!, 'index.json', [
			'main'
		]);
		expect(candidates).toEqual([
			'https://forge.example/owner/repo/raw/branch/main/index.json',
			'https://forge.example/owner/repo/-/raw/main/index.json'
		]);
	});

	it('tries a named branch before the defaults', () => {
		const candidates = rawCandidates(
			repo('https://github.com/owner/repo/tree/nightly')!,
			'index.json',
			DEFAULT_REFS
		);
		expect(candidates[0]).toBe('https://raw.githubusercontent.com/owner/repo/nightly/index.json');
		expect(candidates).toContain('https://raw.githubusercontent.com/owner/repo/main/index.json');
	});
});

describe('a URL that is already a file', () => {
	it('is recognised as one', () => {
		expect(looksLikeFile(new URL('https://forge.example/o/r/raw/branch/main/a/b.json'))).toBe(true);
		expect(looksLikeFile(new URL('https://forge.example/o/r'))).toBe(false);
	});

	// The regression. Every adapter used to hand-roll this check against its own
	// filename, so a `.json` under any other name got a path appended to it.
	it.each(FOREIGN_ADAPTERS.map((adapter) => adapter.format))(
		'%s uses it untouched instead of appending a path to it',
		(format) => {
			const pasted = 'https://forge.example/owner/repo/raw/branch/main/thing/thing.json';
			const adapter = FOREIGN_ADAPTERS.find((candidate) => candidate.format === format)!;

			expect(adapter.candidates(new URL(pasted))).toEqual([pasted]);
		}
	);
});
