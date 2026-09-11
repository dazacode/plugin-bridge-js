/**
 * Every ecosystem this build can read, and the way to find one by name.
 *
 * This list lived in `@plugin-bridge/core/detect` until 2026-09-11, where it
 * made core import all six adapters — the dependency pointing the wrong way
 * round. Core is what an adapter is written *against*; an adapter is not
 * something core is written against. While the list lived there, adding a
 * seventh ecosystem meant editing the package that is supposed to know nothing
 * about any particular one.
 *
 * It is an explicit list rather than a registry adapters call into at import
 * time. Self-registration would make the set depend on which modules a bundler
 * happened to keep, and an ecosystem silently missing from detection is a
 * failure that looks exactly like a repository being unrecognised.
 */

import { ValidationFailure } from '@plugin-bridge/core/errors';
import type { ForeignAdapter } from '@plugin-bridge/core/adapter';
import type { ForeignFormat } from '@plugin-bridge/core/formats';

import { aniyomiAdapter } from './aniyomi';
import { cloudstreamAdapter } from './cloudstream';
import { hayaseAdapter } from './hayase';
import { lnreaderAdapter } from './lnreader';
import { mangayomiAdapter } from './mangayomi';
import { soraAdapter } from './sora';

/**
 * Ordered, and the order is a policy.
 *
 * The two formats with a distinctive filename come first, so the common case
 * costs one request. `mangayomi` and `hayase` both answer to a bare
 * `index.json` and are separated by their body, not their position — but
 * `hayase` is checked first because its entries carry a `manifestVersion`
 * field that nothing else does, making it the cheaper negative.
 */
export const FOREIGN_ADAPTERS: readonly ForeignAdapter[] = [
	soraAdapter,
	aniyomiAdapter,
	lnreaderAdapter,
	cloudstreamAdapter,
	hayaseAdapter,
	mangayomiAdapter
];

export function adapterFor(format: ForeignFormat): ForeignAdapter {
	const adapter = FOREIGN_ADAPTERS.find((candidate) => candidate.format === format);
	if (adapter === undefined) {
		throw new ValidationFailure(`This build does not know the "${format}" plugin format.`);
	}
	return adapter;
}

export {
	aniyomiAdapter,
	cloudstreamAdapter,
	hayaseAdapter,
	lnreaderAdapter,
	mangayomiAdapter,
	soraAdapter
};
