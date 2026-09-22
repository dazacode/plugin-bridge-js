/**
 * What each foreign format is, as a set of facts the rest of the code reads
 * rather than re-derives.
 */

import { describe, expect, it } from 'vitest';

import { formatProfile, refusalFor } from './formats';
describe('which formats carry cookies for an extension that never asked', () => {
	it('grants the constrained jar by format rather than by reading the extension', () => {
		// The decision this encodes: the dominant cookie use in these ecosystems
		// is *implicit*. An extension doing a two-request session against a
		// framework that installs a jar never writes a line about cookies, so
		// deriving the capability from its translated source finds nothing and
		// the session silently never carries.
		expect(formatProfile('aniyomi').implicitCookies).toBe(true);

		// False everywhere else, and that is the honest default: a format whose
		// framework makes no such guarantee must not have its plugins granted
		// state they were never written to expect.
		for (const format of ['sora', 'mangayomi', 'hayase', 'lnreader'] as const) {
			expect(formatProfile(format).implicitCookies).toBe(false);
		}
	});
});

describe('which mediums this build has somewhere to show', () => {
	it('refuses a listing for its medium only when the medium is unsupported', () => {
		// `sora` converts and carries no format-level refusal, so a supported
		// medium falls all the way through to `null` — installable.
		expect(refusalFor('sora', 'anime')).toBeNull();
		expect(refusalFor('sora', 'live-action')).toBeNull();
		// `manga` joined the supported set under ADR-0013.
		expect(refusalFor('sora', 'manga')).toBeNull();
		expect(refusalFor('sora', 'novel')).toMatch(/novel source/);
	});

	it("refuses a live-action listing for its format's own reason, not for its medium", () => {
		// Cloudstream is `browse-only` regardless of medium — compiled JVM
		// bytecode, no converter — so a live-action listing and an anime one
		// get the *same* sentence, and neither is the old "wrong medium" one.
		const anime = refusalFor('cloudstream', 'anime');
		const liveAction = refusalFor('cloudstream', 'live-action');
		expect(anime).toMatch(/compiled Java/);
		expect(liveAction).toMatch(/compiled Java/);
		expect(liveAction).not.toMatch(/nowhere to show/);
	});

	it('still refuses a novel listing for the medium, not the format', () => {
		// The medium check runs first and is the more specific answer, so this
		// listing is told it is the wrong medium rather than the wrong format.
		expect(refusalFor('cloudstream', 'novel')).toMatch(/novel source/);
	});

	it('refuses a manga listing for its format now that the medium is supported', () => {
		// The same listing before ADR-0013 was refused for its medium. It is
		// still refused — this format's artifact has no converter — and the
		// *reason* moving is the whole point of checking the medium first.
		expect(refusalFor('cloudstream', 'manga')).toMatch(/compiled Java/);
	});
});
