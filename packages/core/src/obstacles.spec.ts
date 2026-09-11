/**
 * That the address on a refusal is the right address.
 *
 * A diagnostic that points at the wrong line is worse than no diagnostic: it
 * sends somebody to read a member that is fine. So the two ways this could
 * point wrongly are pinned here — the file, when two files declare a member of
 * the same name, and the blocking flag, which decides whether a reader should
 * care at all.
 */

import { describe, expect, it } from 'vitest';

import { obstacleSites, redactLine } from './obstacles';
import type { Refusal } from './kotlin/subset';

function refusal(member: string, kind: string, line: number): Refusal {
	return { member, obstacles: [{ kind, line, memberName: member }] };
}

describe('addressing an obstacle', () => {
	it('attributes a member to the file that declared it, not to the first file of that name', () => {
		// The case that makes name matching wrong: a template and an extension
		// both declare `videoListParse`, and only one of them is refused.
		const inExtension = refusal('videoListParse', 'object_literal', 2);
		const inTemplate = refusal('videoListParse', 'a `super.` call', 3);

		const sites = obstacleSites(
			{
				perFile: [
					{
						path: 'src/Ext.kt',
						js: '',
						translated: [],
						refusals: [inExtension],
						fileRefusal: null
					},
					{
						path: 'lib/Tpl.kt',
						js: '',
						translated: [],
						refusals: [inTemplate],
						fileRefusal: null
					}
				],
				refusals: [inExtension, inTemplate],
				blocking: [inExtension]
			},
			[
				{
					path: 'src/Ext.kt',
					source: 'class Ext {\n  val x = object : Video() {}\n}'
				},
				{
					path: 'lib/Tpl.kt',
					source: 'class Tpl {\n\n  super.videoListParse()\n}'
				}
			]
		);

		expect(sites).toHaveLength(2);
		expect(sites[0]).toMatchObject({
			file: 'src/Ext.kt',
			line: 2,
			kind: 'object_literal',
			blocking: true,
			text: 'val x = object : Video() {}'
		});
		expect(sites[1]).toMatchObject({
			file: 'lib/Tpl.kt',
			line: 3,
			blocking: false,
			text: 'super.videoListParse()'
		});
	});

	it('still marks the synthesised header refusal as blocking', () => {
		// `pipeline.ts` builds this one twice rather than once, so it is in no
		// file's list and identity cannot find it. Its member is the path.
		const header = refusal('src/Ext.kt', 'a class header this build could not parse', 1);
		const alsoHeader = refusal('src/Ext.kt', 'a class header this build could not parse', 1);

		const sites = obstacleSites({ perFile: [], refusals: [header], blocking: [alsoHeader] }, [
			{ path: 'src/Ext.kt', source: 'class Ext : Something<' }
		]);

		expect(sites[0]).toMatchObject({
			file: 'src/Ext.kt',
			blocking: true,
			text: 'class Ext : Something<'
		});
	});

	it('says nothing about a line it does not have', () => {
		const one = refusal('parse', 'WebView', 99);
		const sites = obstacleSites(
			{
				perFile: [
					{
						path: 'a.kt',
						js: '',
						translated: [],
						refusals: [one],
						fileRefusal: null
					}
				],
				refusals: [one],
				blocking: [one]
			},
			[{ path: 'a.kt', source: 'class A {}' }]
		);
		expect(sites[0].text).toBe('');
	});
});

describe('what a printed line may carry', () => {
	it('replaces a URL, because rule 9 does not stop at a console', () => {
		expect(redactLine('    override val baseUrl = "https://example.invalid/api?x=1"')).toBe(
			'override val baseUrl = "<url>"'
		);
	});

	it('leaves a bare path alone, because the shape of the request is the point', () => {
		expect(redactLine('\tval url = "/search?q=" + query')).toBe('val url = "/search?q=" + query');
	});

	it('cuts a line nobody would read to the end of', () => {
		const long = redactLine(`val x = "${'a'.repeat(400)}"`);
		expect(long.length).toBeLessThanOrEqual(160);
		expect(long.endsWith('…')).toBe(true);
	});
});
