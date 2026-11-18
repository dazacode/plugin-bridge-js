/**
 * What the shared module walker reports, independent of either format using it.
 *
 * The Hayase adapter's own spec pins how one format reads the report (a gap is
 * converted anyway); the Mana adapter's pins the other (a gap refuses). What is
 * pinned here is that the report is *complete*: a format that refuses on a gap
 * can only refuse on the gaps the walker tells it about. No real repository
 * appears here (AGENTS.md rule 9).
 */

import { describe, expect, it } from 'vitest';

import { walkRepositoryModules, type RepositoryModuleOptions } from './repository-modules';

const ROOT = 'https://repo.example.invalid/owner/name/main/';
const ENTRY = `${ROOT}src/Example/main.ts`;

const specifiers = (source: string): string[] =>
	[...source.matchAll(/from\s*['"](\.[^'"]*)['"]/g)].map((match) => match[1]);

function options(
	files: Record<string, string>,
	extra: Partial<RepositoryModuleOptions> = {}
): RepositoryModuleOptions & { asked: string[] } {
	const asked: string[] = [];
	return {
		root: ROOT,
		getText: async (url) => {
			asked.push(url);
			const body = files[url];
			if (body === undefined) throw new Error(`no ${url}`);
			return body;
		},
		specifiers,
		maxModules: 12,
		maxDepth: 3,
		asked,
		...extra
	};
}

describe('walkRepositoryModules', () => {
	it('links each specifier to the file it was read at, through extension candidates', async () => {
		const files = {
			[`${ROOT}lib/source.ts`]: `import { clean } from './text';`,
			[`${ROOT}lib/text.ts`]: `export const clean = 1;`
		};
		const walk = await walkRepositoryModules(
			{ source: `import { Base } from '../../lib/source.ts';`, url: ENTRY },
			options(files, { candidates: (url) => (url.endsWith('.ts') ? [url] : [`${url}.ts`]) })
		);

		expect(walk.modules.map((one) => one.url)).toEqual([
			`${ROOT}lib/text.ts`,
			`${ROOT}lib/source.ts`
		]);
		expect(walk.entryImports).toEqual({ '../../lib/source.ts': `${ROOT}lib/source.ts` });
		expect(walk.modules[1].imports).toEqual({ './text': `${ROOT}lib/text.ts` });
		expect(walk.missing).toEqual([]);
	});

	it('reads one file once under two spellings, and links both to it', async () => {
		const opts = options(
			{
				[`${ROOT}lib/a.ts`]: `import { b } from './b';`,
				[`${ROOT}lib/b.ts`]: `export const b = 1;`
			},
			{ candidates: (url) => (url.endsWith('.ts') ? [url] : [`${url}.ts`]) }
		);
		const walk = await walkRepositoryModules(
			{
				// `b.ts` first, so the extensionless `./b` inside `a` is the second
				// spelling of a file already read.
				source: `import { b } from '../../lib/b.ts';\nimport { a } from '../../lib/a.ts';`,
				url: ENTRY
			},
			opts
		);

		expect(walk.modules.map((one) => one.url)).toEqual([`${ROOT}lib/b.ts`, `${ROOT}lib/a.ts`]);
		expect(walk.modules[1].imports).toEqual({ './b': `${ROOT}lib/b.ts` });
		expect(walk.cycles).toEqual([]);
	});

	it('reports a specifier no candidate could be read for', async () => {
		const walk = await walkRepositoryModules(
			{ source: `import { gone } from './gone';`, url: ENTRY },
			options({})
		);
		expect(walk.missing).toEqual([{ specifier: './gone', from: ENTRY }]);
	});

	it('reports, and never fetches, a specifier that climbs out of the root', async () => {
		const opts = options({});
		const walk = await walkRepositoryModules(
			{ source: `import { x } from '../../../../../other/repo/x.ts';`, url: ENTRY },
			opts
		);
		expect(walk.escaped).toHaveLength(1);
		expect(opts.asked).toEqual([]);
	});

	it('reports an import of a module still being walked as a cycle', async () => {
		const walk = await walkRepositoryModules(
			{ source: `import { a } from './a.ts';`, url: ENTRY },
			options({
				[`${ROOT}src/Example/a.ts`]: `import { b } from './b.ts';`,
				[`${ROOT}src/Example/b.ts`]: `import { a } from './a.ts';`
			})
		);
		expect(walk.cycles).toEqual([{ specifier: './a.ts', from: `${ROOT}src/Example/b.ts` }]);
	});

	it('says when the bound stopped it, rather than returning a shorter list as if complete', async () => {
		const files: Record<string, string> = {};
		for (let index = 0; index < 4; index += 1) {
			files[`${ROOT}src/Example/m${index}.ts`] = `export const m${index} = ${index};`;
		}
		const source = [0, 1, 2, 3]
			.map((index) => `import { m${index} } from './m${index}.ts';`)
			.join('\n');

		const capped = await walkRepositoryModules(
			{ source, url: ENTRY },
			options(files, { maxModules: 2 })
		);
		expect(capped.modules).toHaveLength(2);
		expect(capped.truncated).toBe(true);

		const whole = await walkRepositoryModules(
			{ source, url: ENTRY },
			options(files, { maxModules: 4 })
		);
		expect(whole.truncated).toBe(false);
	});
});
