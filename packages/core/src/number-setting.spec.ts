/**
 * `ABI.md` §9.2 — the numeric setting — as the manifest reader and the value
 * resolver answer it, driven by `contract/fixtures/level-3/number-setting.json`
 * so a client's conformance test and this one read the same vectors.
 */
import { describe, expect, it } from 'vitest';

import vectors from '../../../contract/fixtures/level-3/number-setting.json';
import { convertedManifest, type BundleInput } from './package';
import { parseSettingDescriptors, settingValues, settingsApiLevel } from './settings';

describe('a number setting', () => {
	for (const one of vectors.valid as {
		descriptor: Record<string, unknown>;
		values: { stored?: unknown; expected: number }[];
	}[]) {
		it(`reads "${String(one.descriptor['id'])}" and resolves every stored value onto its step`, () => {
			const parsed = parseSettingDescriptors([one.descriptor]);
			expect(parsed).toHaveLength(1);
			for (const value of one.values) {
				const stored = 'stored' in value ? { [parsed[0].id]: value.stored } : {};
				expect(settingValues(parsed, stored)[parsed[0].id]).toBe(value.expected);
			}
		});
	}

	for (const one of vectors.invalid as { name: string; descriptor: unknown }[]) {
		it(`is not drawn with ${one.name}`, () => {
			expect(parseSettingDescriptors([one.descriptor])).toEqual([]);
		});
	}

	it('raises the API level a manifest declares, and nothing else does', () => {
		const valid = parseSettingDescriptors([vectors.valid[0].descriptor]);
		expect(settingsApiLevel(valid)).toBe(3);
		expect(settingsApiLevel(parseSettingDescriptors([{ id: 't', type: 'text', label: 'T' }]))).toBe(
			1
		);
	});

	it('makes a converted manifest declare level 3, so an older host refuses it at check 1', () => {
		const input: BundleInput = {
			id: 'app.yorozo.converted.example.alpha',
			name: 'Alpha',
			description: 'An example.',
			version: '1.0.0',
			author: 'someone',
			hosts: ['site.example.invalid'],
			origin: {
				format: 'suwatte',
				artifactUrl: 'https://repo.example.invalid/a.stt',
				foreignId: 'a',
				foreignVersion: '1',
				mediaKind: 'manga',
				isNsfw: false
			},
			entrypointSource: 'export default {}'
		};
		expect(
			convertedManifest({
				...input,
				settings: parseSettingDescriptors([vectors.valid[0].descriptor])
			})['yorozoPluginApi']
		).toBe(3);
		expect(convertedManifest(input)['yorozoPluginApi']).toBe(1);
	});
});
