/**
 * What each foreign format is, as a set of facts the rest of the code reads
 * rather than re-derives.
 */

import { describe, expect, it } from 'vitest';

import { formatProfile } from './formats';
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
