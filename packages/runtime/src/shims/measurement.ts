/**
 * What a bundle built under a measurement grant carries, and nothing else
 * does (`core/src/kotlin/grants.ts`).
 *
 * `__grantedBoundary` is what the emitter wrote where it would have refused:
 * reaching it throws, naming the boundary, so a measured bundle that runs
 * further than its load says so on the line it could not do. The image
 * group's code also names Android's graphics classes at construction, so
 * those are defined as stand-ins that throw the same way on first use rather
 * than failing the import — the import is what is being counted.
 *
 * Empty when no grant is on, which is every bundle a host will ever see.
 */

import { IMAGE_GRANT_GLOBALS, measurementGrants } from '@plugin-bridge/core/kotlin/grants';

export function measurementPrelude(): string {
	const grants = measurementGrants();
	if (grants.length === 0) return '';
	const lines = [
		`/* --- built for a measurement, with ${grants.join(', ')} set aside: not a plugin --- */`,
		'function __grantedBoundary(kind) {',
		"  throw new Error('This bundle was built to measure a boundary, and reached it: ' + kind + '. It is not a plugin.');",
		'}'
	];
	if (grants.includes('image')) {
		lines.push(
			'function __grantedStandIn(name) {',
			'  return new Proxy(function () {}, {',
			"    get: function (target, key) { return key === 'prototype' ? {} : typeof key === 'symbol' ? undefined : __grantedStandIn(name + '.' + String(key)); },",
			'    construct: function () { __grantedBoundary(name); },',
			'    apply: function () { __grantedBoundary(name); }',
			'  });',
			'}',
			...IMAGE_GRANT_GLOBALS.map(
				(name) => `var ${name} = __grantedStandIn(${JSON.stringify(name)});`
			)
		);
	}
	return lines.join('\n');
}
