/**
 * Checking a listing without installing it.
 *
 * The properties worth pinning are mostly about restraint: that nothing is
 * offered for checking unless it could be installed, and that "nobody has
 * looked" never quietly becomes "this works".
 */

import { describe, expect, it } from 'vitest';

import { checkKey, describeStatus, isTestable, statusOf } from './check';
import type { CheckResult } from './check';
import type { RepositoryPlugin } from '@plugin-bridge/core/repository-index';

function listing(id: string, over: Partial<RepositoryPlugin> = {}): RepositoryPlugin {
	return {
		id,
		name: id,
		description: '',
		version: '1.0.0',
		author: '',
		license: '',
		yorozoPluginApi: 1,
		minimumYorozoVersion: '0.0.0',
		platforms: ['web'],
		capabilities: ['search'],
		permissions: ['network'],
		hosts: ['example.invalid'],
		language: 'en',
		download: 'https://example.invalid/s.js',
		sha256: '',
		origin: {
			format: 'sora',
			artifactUrl: 'https://example.invalid/s.js',
			foreignId: id,
			foreignVersion: '1.0.0',
			mediaKind: 'anime',
			isNsfw: false
		},
		size: 0,
		...over
	} as RepositoryPlugin;
}

/**
 * A listing on a format that cannot be installed at all.
 *
 * Cloudstream rather than Aniyomi: the latter converts now, from source rather
 * than from its published artifact, so it is no longer an example of anything
 * being refused. This one still ships compiled Java with its classpath missing,
 * which is the case these tests are about.
 */
function unconvertible(id: string): RepositoryPlugin {
	return listing(id, {
		origin: {
			format: 'cloudstream',
			artifactUrl: 'https://example.invalid/a.cs3',
			foreignId: id,
			foreignVersion: '1',
			mediaKind: 'anime',
			isNsfw: false
		}
	});
}

const ok = (id: string): CheckResult => ({
	listingId: id,
	version: '1.0.0',
	status: 'works',
	detail: null,
	failedAt: null,
	checkedAt: '2026-09-08T00:00:00.000Z'
});

describe('what gets checked at all', () => {
	it('has nothing to learn from a listing that could not be installed anyway', () => {
		expect(isTestable(listing('a'))).toBe(true);
		// The row offers no button, because the request would be spent on a
		// question the refusal has already answered.
		expect(isTestable(unconvertible('b'))).toBe(false);
	});
});

describe('the status a row shows', () => {
	it('is grey until something has actually been run', () => {
		const status = statusOf(listing('a'), new Map());
		expect(status.status).toBe('untested');
		// Said as a state, not as a fault — it is where most rows live.
		expect(describeStatus(status)).toMatch(/Not checked/);
	});

	it('is not-testable for a listing that cannot be installed', () => {
		expect(statusOf(unconvertible('b'), new Map()).status).toBe('notTestable');
	});

	it('forgets a result when the listing publishes a new version', () => {
		const results = new Map([[checkKey(listing('a')), ok('a')]]);

		expect(statusOf(listing('a'), results).status).toBe('works');
		// A new build is code nobody has run. Carrying the tick forward would
		// show a green light for something that has never executed.
		const bumped = listing('a', {
			origin: { ...listing('a').origin!, foreignVersion: '1.1.0' }
		});
		expect(statusOf(bumped, results).status).toBe('untested');
	});

	it('forgets a result when this build learns to read something it could not', () => {
		// The mirror image of the test above, and the one whose absence made a
		// widening loop unable to see its own work: a remembered `broken` is a
		// statement about a converter, and the converter is what keeps changing.
		// Every row went on reciting a pre-fix refusal, so a fix that unblocked
		// an extension looked on screen exactly like a fix that did nothing.
		const stored = new Map([[checkKey(listing('a')), ok('a')]]);
		expect(statusOf(listing('a'), stored).status).toBe('works');

		const answeredByAnOlderConverter = new Map([
			[checkKey(listing('a')).replace(/#c\d+$/, '#c0'), ok('a')]
		]);
		expect(statusOf(listing('a'), answeredByAnOlderConverter).status).toBe('untested');
	});

	it('lets a refusal outrank a stale pass', () => {
		// Once a format stops being convertible, a listing that used to work is
		// not a working listing.
		const results = new Map([[checkKey(unconvertible('b')), ok('b')]]);
		expect(statusOf(unconvertible('b'), results).status).toBe('notTestable');
	});
});
