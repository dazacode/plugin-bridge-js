/**
 * Listing a repository directory through a forge's tree API.
 *
 * Nothing here touches the network. The forge hosts are the two `FOREIGN.md` §0
 * permits plus the API host it now permits alongside them; every repository and
 * every file path is invented.
 */

import { describe, expect, it } from 'vitest';

import { createTreeLister, parseRawUrl, parseTree, treeCandidates, TreeError } from './git-trees';

const GITHUB_TREE = JSON.stringify({
	sha: 'x',
	truncated: false,
	tree: [
		{ path: 'lib', type: 'tree' },
		{ path: 'lib/thing', type: 'tree' },
		{ path: 'lib/thing/build.gradle', type: 'blob' },
		{ path: 'lib/thing/src/Thing.kt', type: 'blob' },
		{ path: 'lib/other/src/Other.kt', type: 'blob' },
		{ path: 'README.md', type: 'blob' }
	]
});

describe('reading a raw URL back', () => {
	it('reads the three forge shapes it was given', () => {
		expect(parseRawUrl('https://raw.githubusercontent.com/owner/repo/master/lib/thing/')).toEqual({
			repository: {
				origin: 'https://github.com',
				owner: 'owner',
				repo: 'repo',
				ref: null
			},
			ref: 'master',
			// No trailing slash: the path comes from the segments, and a
			// trailing one would make every prefix comparison below miss.
			path: 'lib/thing'
		});

		expect(parseRawUrl('https://forge.example.invalid/owner/repo/raw/branch/main/lib/x')).toEqual({
			repository: {
				origin: 'https://forge.example.invalid',
				owner: 'owner',
				repo: 'repo',
				ref: null
			},
			ref: 'main',
			path: 'lib/x'
		});

		expect(parseRawUrl('https://forge.example.invalid/owner/repo/-/raw/main/lib/x')).toEqual({
			repository: {
				origin: 'https://forge.example.invalid',
				owner: 'owner',
				repo: 'repo',
				ref: null
			},
			ref: 'main',
			path: 'lib/x'
		});
	});

	it('refuses anything that is not https, or not a raw URL at all', () => {
		expect(parseRawUrl('http://raw.githubusercontent.com/o/r/main/a')).toBeNull();
		expect(parseRawUrl('https://example.invalid/some/page')).toBeNull();
		expect(parseRawUrl('not a url')).toBeNull();
	});
});

describe('which API is asked', () => {
	it('uses the forge API host for the one forge that has a separate one', () => {
		expect(
			treeCandidates({ origin: 'https://github.com', owner: 'o', repo: 'r', ref: null }, 'master')
		).toEqual(['https://api.github.com/repos/o/r/git/trees/master?recursive=1']);
	});

	it('stays on the origin the pasted repository named, for a self-hosted forge', () => {
		const candidates = treeCandidates(
			{
				origin: 'https://forge.example.invalid',
				owner: 'o',
				repo: 'r',
				ref: null
			},
			'main'
		);
		// Two shapes, because the origin does not say which software is behind
		// it and guessing from a hostname would be a list of hostnames.
		expect(candidates).toHaveLength(2);
		expect(candidates.every((url) => url.startsWith('https://forge.example.invalid/'))).toBe(true);
	});
});

describe('reading a tree document', () => {
	it('takes files and leaves directories', () => {
		// A directory entry is not something to fetch, and requesting one gets a
		// listing page rather than source.
		expect(parseTree(GITHUB_TREE)).toEqual([
			'lib/thing/build.gradle',
			'lib/thing/src/Thing.kt',
			'lib/other/src/Other.kt',
			'README.md'
		]);
	});

	it('reads the bare-array shape as well as the wrapped one', () => {
		const gitlab = JSON.stringify([
			{ path: 'a/B.kt', type: 'blob' },
			{ path: 'a', type: 'tree' }
		]);
		expect(parseTree(gitlab)).toEqual(['a/B.kt']);
	});

	it('refuses a truncated tree rather than using what arrived', () => {
		// A truncated tree silently omits files, and the conversion would then
		// refuse a member for being absent rather than for being untranslatable.
		// A wrong reason is worse than no answer.
		const truncated = JSON.stringify({
			truncated: true,
			tree: [{ path: 'a.kt', type: 'blob' }]
		});
		expect(() => parseTree(truncated)).toThrow(TreeError);
	});

	it('refuses a document that is not a tree', () => {
		expect(() => parseTree('not json')).toThrow(TreeError);
		expect(() => parseTree('{"message":"Not Found"}')).toThrow(TreeError);
	});
});

describe('the lister', () => {
	function lister(): {
		list: ReturnType<typeof createTreeLister>;
		asked: string[];
	} {
		const asked: string[] = [];
		const list = createTreeLister(async (url: string) => {
			asked.push(url);
			return GITHUB_TREE;
		});
		return { list, asked };
	}

	it('returns absolute URLs on the host it was given', async () => {
		const { list } = lister();
		const files = await list('https://raw.githubusercontent.com/owner/repo/master/lib/thing/');

		// Absolute, and on the raw host: `source-repo.ts` drops anything that
		// does not resolve under the directory it asked about, so handing it
		// addresses on the host it already trusts keeps that check meaningful.
		expect(files).toEqual([
			'https://raw.githubusercontent.com/owner/repo/master/lib/thing/build.gradle',
			'https://raw.githubusercontent.com/owner/repo/master/lib/thing/src/Thing.kt'
		]);
	});

	it('does not leak a sibling directory into the answer', async () => {
		const { list } = lister();
		const files = await list('https://raw.githubusercontent.com/owner/repo/master/lib/thing/');
		expect(files.some((url) => url.includes('other'))).toBe(false);
	});

	it('fetches one tree per repository however many directories are listed', async () => {
		const { list, asked } = lister();
		await list('https://raw.githubusercontent.com/owner/repo/master/lib/thing/');
		await list('https://raw.githubusercontent.com/owner/repo/master/lib/other/');
		await list('https://raw.githubusercontent.com/owner/repo/master/');

		// Unauthenticated, the forge API allows 60 requests an hour per address.
		// A tree per listing would fail partway through checking a repository,
		// and would look like the catalogue is broken rather than like we were
		// rude.
		expect(asked).toHaveLength(1);
	});

	it('shares one request between listings that start together', async () => {
		const { list, asked } = lister();
		await Promise.all([
			list('https://raw.githubusercontent.com/owner/repo/master/lib/thing/'),
			list('https://raw.githubusercontent.com/owner/repo/master/lib/other/')
		]);
		// The promise is cached, not the result, so concurrent callers do not
		// race each other into the rate limit.
		expect(asked).toHaveLength(1);
	});

	it('answers nothing for a URL it cannot read, rather than throwing', async () => {
		const { list, asked } = lister();
		// The caller's response to an unlistable directory is to try the next
		// candidate, so an exception per miss would make the ordinary path the
		// exceptional one.
		expect(await list('https://example.invalid/not/a/raw/url')).toEqual([]);
		expect(asked).toHaveLength(0);
	});
});
