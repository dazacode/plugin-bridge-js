/**
 * Reading a settings declaration, and refusing a value that would widen a grant.
 *
 * Two halves, and the second is the one with teeth. A converted source's
 * commonest preference is a base URL, so "what counts as naming a host" decides
 * whether a settings field is a convenience or a hole in the consent screen.
 *
 * Rule 9: every host here is invented and under `.invalid`.
 */

import { describe, expect, it } from 'vitest';

import { hostMatches } from '@plugin-bridge/host/host-match';
import {
	coerce,
	defaultValue,
	hostOutsideGrant,
	parseSettingDescriptors,
	settingIdFor,
	settingValues,
	type SettingDescriptor
} from './settings';

const SELECT: SettingDescriptor = {
	id: 'server',
	type: 'select',
	label: 'Server',
	options: [
		{ value: 'alpha', label: 'Alpha' },
		{ value: 'beta', label: 'Beta' }
	],
	default: 'beta'
};

describe('reading a declaration', () => {
	it('keeps a descriptor the schema would accept', () => {
		expect(parseSettingDescriptors([SELECT])).toEqual([SELECT]);
	});

	it('drops a row whose id is not one, rather than repairing it', () => {
		// A settings row that does not mean what the manifest says is worse
		// than a missing one: the plugin reads by id and would find nothing.
		expect(parseSettingDescriptors([{ ...SELECT, id: 'Server Choice' }])).toEqual([]);
		expect(parseSettingDescriptors([{ ...SELECT, id: '9lives' }])).toEqual([]);
	});

	it('drops a select with nothing to select from', () => {
		expect(parseSettingDescriptors([{ ...SELECT, options: undefined }])).toEqual([]);
	});

	it('drops a second descriptor claiming an id the first already took', () => {
		const rows = parseSettingDescriptors([SELECT, { ...SELECT, label: 'Other' }]);
		expect(rows).toHaveLength(1);
		expect(rows[0].label).toBe('Server');
	});

	it('is not a manifest that fails to install', () => {
		// It runs after the archive has already been held to its declaration,
		// so a malformed block is fewer settings, not a refusal.
		expect(parseSettingDescriptors('nonsense')).toEqual([]);
		expect(parseSettingDescriptors([null, 7, { id: 'x' }])).toEqual([]);
	});

	it('carries the foreign key when the manifest states one', () => {
		const rows = parseSettingDescriptors([{ ...SELECT, key: 'preferred.server' }]);
		expect(rows[0].key).toBe('preferred.server');
	});
});

describe('a value as its type promises it', () => {
	it('answers a list-valued setting with a list', () => {
		// A comma-joined string iterates as one long element rather than as the
		// values it holds, which is the kind of wrong that surfaces three
		// frames away from its cause.
		const multi: SettingDescriptor = {
			id: 'kinds',
			type: 'multiselect',
			label: 'Kinds',
			options: [{ value: 'sub', label: 'Sub' }]
		};
		expect(coerce(multi, 'sub')).toEqual([]);
		expect(coerce(multi, ['sub', 7])).toEqual(['sub']);
	});

	it('reads a switch written as a string, because storage has no booleans', () => {
		const flag: SettingDescriptor = { id: 'dub', type: 'switch', label: 'Dub' };
		expect(coerce(flag, 'true')).toBe(true);
		expect(coerce(flag, 'false')).toBe(false);
		expect(coerce(flag, undefined)).toBe(false);
	});

	it('falls back to the declared default when nothing was chosen', () => {
		expect(defaultValue(SELECT)).toBe('beta');
		expect(settingValues([SELECT])).toEqual({ server: 'beta' });
	});

	it('layers a viewer’s choice over the default', () => {
		expect(settingValues([SELECT], { server: 'alpha' })).toEqual({ server: 'alpha' });
	});

	it('drops a stored value for a setting nothing declares any more', () => {
		// Settings survive an update; an update that removed a setting removed
		// it, and passing the old value in would hand the plugin a key its
		// manifest no longer mentions.
		expect(settingValues([SELECT], { gone: 'x', server: 'alpha' })).toEqual({ server: 'alpha' });
	});

	it('declares nothing for a bundle that declares nothing', () => {
		expect(settingValues([], { server: 'alpha' })).toEqual({});
	});
});

describe('normalising a foreign key into an id', () => {
	it('lowercases, replaces what an id may not hold, and trims the head', () => {
		expect(settingIdFor('PREF_SERVER')).toBe('pref_server');
		expect(settingIdFor('preferred.domain')).toBe('preferred_domain');
		expect(settingIdFor('1080p_only')).toBe('p_only');
	});
});

describe('a value that would send a plugin outside its grant', () => {
	const grant = ['watch.example.invalid', '*.cdn.example.invalid'];

	it('allows a value naming a host the plugin declared', () => {
		expect(hostOutsideGrant('https://watch.example.invalid/x', grant, hostMatches)).toBeNull();
		expect(hostOutsideGrant('media.cdn.example.invalid', grant, hostMatches)).toBeNull();
	});

	it('names the host when the value points somewhere else', () => {
		expect(hostOutsideGrant('https://other.example.invalid', grant, hostMatches)).toBe(
			'other.example.invalid'
		);
	});

	it('checks every entry of a list, because a mirror list is one', () => {
		expect(
			hostOutsideGrant(['watch.example.invalid', 'mirror.example.invalid'], grant, hostMatches)
		).toBe('mirror.example.invalid');
	});

	it('lets a value that is not a host through', () => {
		// Every plain string setting would otherwise be a refusal: `sub`,
		// `1080p` and `Server 3` are values, not hosts.
		for (const value of ['1080p', 'sub', 'Server 3', '', 'a.b']) {
			expect(hostOutsideGrant(value, grant, hostMatches)).toBeNull();
		}
	});

	it('does not treat a wildcard grant as covering the bare domain', () => {
		// `*.cdn.example.invalid` is what the manifest schema can express, and
		// `hostMatches` deliberately does not let it match `cdn.example.invalid`
		// itself. A settings row must not quietly widen that.
		expect(hostOutsideGrant('https://cdn.example.invalid/a', grant, hostMatches)).toBe(
			'cdn.example.invalid'
		);
	});
});
