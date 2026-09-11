/**
 * What happens to whatever a viewer pastes into the "add repository" box.
 *
 * A UX test as much as a parsing one, and the twin of
 * `test/core/plugins/plugin_index_test.dart`. The failure it exists to prevent
 * is not a crash — it is someone pasting the thing in their address bar, being
 * told "invalid URL", and concluding the feature does not work.
 */

import { describe, expect, it } from 'vitest';

import { parseRepositoryIndex, resolveIndexCandidates } from './repository-index';

const HASH = 'ab'.repeat(32);

describe('what people actually paste', () => {
	it('resolves a GitHub URL to real candidates', () => {
		const candidates = resolveIndexCandidates('https://github.com/owner/repo');

		// raw.githubusercontent.com sends `access-control-allow-origin: *`; a
		// GitHub release asset sends no CORS header at all, so a browser cannot
		// read one. Ordering matters here more than anywhere else in this file.
		expect(candidates[0]).toBe('https://raw.githubusercontent.com/owner/repo/main/index.json');
		expect(candidates).toContain('https://raw.githubusercontent.com/owner/repo/master/index.json');
		expect(candidates.at(-1)).toBe(
			'https://github.com/owner/repo/releases/latest/download/index.json'
		);
	});

	it('copes with a trailing slash, .git and a deep path', () => {
		// Including `/tree/master/plugins`, which is what you get from browsing
		// to a subdirectory and copying the address bar.
		for (const pasted of [
			'https://github.com/owner/repo/',
			'https://github.com/owner/repo.git',
			'https://github.com/owner/repo/tree/main',
			'https://github.com/owner/repo/tree/master/plugins'
		]) {
			expect(resolveIndexCandidates(pasted)[0]).toBe(
				'https://raw.githubusercontent.com/owner/repo/main/index.json'
			);
		}
	});

	it('accepts the owner/repo shorthand', () => {
		expect(resolveIndexCandidates('owner/repo')[0]).toMatch(
			/^https:\/\/raw\.githubusercontent\.com\/owner\/repo\//
		);
	});

	it('uses a direct .json URL as given', () => {
		expect(resolveIndexCandidates('https://example.invalid/my/index.json')).toEqual([
			'https://example.invalid/my/index.json'
		]);
	});

	it('appends index.json to a bare host', () => {
		expect(resolveIndexCandidates('https://plugins.example.invalid')).toEqual([
			'https://plugins.example.invalid/index.json',
			'https://plugins.example.invalid/dist/index.json'
		]);
	});
});

describe('https is not optional', () => {
	// A cleartext index is one anybody on the path can rewrite, and rewriting
	// an index is enough to install anything.
	it('refuses http', () => {
		expect(() => resolveIndexCandidates('http://plugins.example.invalid')).toThrowError();
	});

	it('refuses file://', () => {
		expect(() => resolveIndexCandidates('file:///etc/passwd')).toThrowError();
	});

	it('asks for a URL rather than crashing on empty input', () => {
		expect(() => resolveIndexCandidates('   ')).toThrowError(/Paste a repository URL/);
	});
});

describe('parsing an index', () => {
	const entry = {
		id: 'com.example.plugins.demo',
		name: 'Demo',
		description: 'd',
		version: '1.0.0',
		author: 'a',
		license: 'Apache-2.0',
		yorozoPluginApi: 1,
		minimumYorozoVersion: '0.1.0',
		platforms: ['web'],
		capabilities: ['resolve'],
		permissions: ['network'],
		hosts: ['api.example.com'],
		download: 'https://example.invalid/demo-1.0.0.yorozoplugin',
		sha256: HASH,
		size: 1234
	};

	const index = (extra: Record<string, unknown> = {}, plugins: unknown[] = []) =>
		JSON.stringify({
			schemaVersion: 1,
			name: 'Test',
			updatedAt: '2026-09-07',
			plugins,
			...extra
		});

	it('reads what the consent screen needs', () => {
		const parsed = parseRepositoryIndex(index({}, [entry]));
		expect(parsed.name).toBe('Test');
		expect(parsed.plugins[0].permissions).toEqual(['network']);
		expect(parsed.plugins[0].hosts).toEqual(['api.example.com']);
	});

	it('carries a signing key when there is one, and null when there is not', () => {
		expect(parseRepositoryIndex(index({ signingKey: 'MCowBQYDK2Vw' })).signingKey).toBe(
			'MCowBQYDK2Vw'
		);
		expect(parseRepositoryIndex(index()).signingKey).toBeNull();
	});

	it('refuses an index format it does not understand', () => {
		// Best-effort parsing a future format is how a client installs something
		// the repository meant to gate behind a field this build ignores.
		expect(() => parseRepositoryIndex(index({ schemaVersion: 2 }))).toThrowError();
	});

	it('skips a listing with a cleartext download, keeping the rest', () => {
		const bad = { ...entry, download: 'http://example.invalid/demo.yorozoplugin' };
		const parsed = parseRepositoryIndex(index({}, [bad, entry]));
		expect(parsed.plugins).toHaveLength(1);
		expect(parsed.plugins[0].download.startsWith('https://')).toBe(true);
	});

	it('skips a listing with no usable hash', () => {
		expect(parseRepositoryIndex(index({}, [{ ...entry, sha256: 'nope' }])).plugins).toEqual([]);
	});

	it('reports a non-JSON body readably', () => {
		expect(() => parseRepositoryIndex('<!doctype html><html>404</html>')).toThrowError(
			/did not return a plugin repository index/
		);
	});
});
