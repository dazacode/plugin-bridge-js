// Regenerates fixtures/string-array/expected.json from the samples beside it.
//
//   node fixtures/string-array/generate.mjs
//
// ## What this is an oracle for
//
// `unpackStringArray` (packages/core/src/extract/patterns.ts) reads a
// string-array-obfuscated source without running it. The only honest check of a
// reader like that is the thing it refuses to be: the source, executed. So this
// script — and only this script, never the spec — runs each sample in a
// `node:vm` context and asks its own decoder, after its own rotation loop has
// finished, what every index decodes to. The expected output is the sample with
// each call site after the rotation replaced by that executed answer, and it is
// itself run to prove it behaves exactly as the sample does before it is
// written.
//
// The samples are one tiny program (`samples/source.js`) put through the
// obfuscator's string-array options one at a time, and every name in them is a
// placeholder under `.invalid`. Two samples have `null` as their expected
// output, because the reader must decline them: `rc4.js` decrypts per call with
// a key, and `wrappers.js` reaches the decoder only through offset-shifting
// wrapper functions. A reader that answered either would be guessing.
//
// The spec compares against what this wrote. It does not execute anything.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = fileURLToPath(new URL('.', import.meta.url));
const samples = `${here}samples/`;

/** Declined by the reader on purpose; see this file's header. */
const DECLINED = new Set(['rc4', 'wrappers']);

const NAME = '[A-Za-z_$][\\w$]*?_0x[0-9a-fA-F]+|_0x[0-9a-fA-F]+';

/** What the sample does, from the one place it writes: the page's hostname. */
function behaviour(code) {
	const out = [];
	for (const [host, random] of [
		['r1.example.invalid', 0],
		['r1.example.invalid', 0.9],
		['elsewhere.example.invalid', 0],
		['elsewhere.example.invalid', 0.9]
	]) {
		const page = { location: { hostname: host } };
		vm.runInNewContext(
			code,
			{ window: page, Math: { floor: Math.floor, random: () => random } },
			{ timeout: 2000 }
		);
		out.push(page.location.hostname);
	}
	return out.join(',');
}

function expectedFor(source) {
	// The dictionary is the zero-parameter function holding the array; the
	// decoder is the one that calls it. Found here only to know which calls to
	// ask about — their *answers* come from running the sample.
	const dictionary = new RegExp(`function\\s+(${NAME})\\s*\\(\\s*\\)\\s*\\{[^}]*\\[`).exec(
		source
	)[1];
	const decoder = [...source.matchAll(new RegExp(`function\\s+(${NAME})\\s*\\(([^)]+)\\)`, 'g'))]
		.map((one) => one[1])
		.find(
			(name) =>
				name !== dictionary &&
				new RegExp(`function\\s+${name.replace(/\$/g, '\\$')}\\s*\\([^)]*\\)\\s*\\{[^]*?${dictionary.replace(/\$/g, '\\$')}\\(`).test(
					source
				)
		);

	const aliases = new Set([decoder]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const one of source.matchAll(new RegExp(`(?<![\\w$])(${NAME})\\s*=\\s*(${NAME})\\s*[;,)]`, 'g'))) {
			if (aliases.has(one[2]) && !aliases.has(one[1])) {
				aliases.add(one[1]);
				grew = true;
			}
		}
	}

	const rotation = new RegExp(
		`\\}\\s*\\(\\s*${dictionary.replace(/\$/g, '\\$')}\\s*,\\s*(0[xX][0-9a-fA-F]+|\\d+)\\s*\\)`
	).exec(source);
	const from = rotation === null ? 0 : rotation.index + rotation[0].length;

	// Run the sample once, then ask its own decoder.
	const context = {
		window: { location: { hostname: 'r1.example.invalid' } },
		Math: { floor: Math.floor, random: () => 0 }
	};
	vm.runInNewContext(source, context, { timeout: 2000 });
	const decode = (index) => context[decoder](index);

	// Index tables — `t = { k: 0x11a }` read as `decode(t.k)` — resolved to
	// the number, so the same executed decoder answers them.
	const tables = new Map();
	for (const table of source.matchAll(new RegExp(`(?<![\\w$])(${NAME})\\s*=\\s*\\{([^{}]*)\\}`, 'g'))) {
		for (const field of table[2].matchAll(new RegExp(`(${NAME})\\s*:\\s*(0[xX][0-9a-fA-F]+|\\d+)`, 'g'))) {
			tables.set(`${table[1]}.${field[1]}`, Number(field[2]));
		}
	}

	const answer = (whole, index) => {
		if (index === undefined) return whole;
		const value = decode(index);
		return typeof value === 'string' && value.length > 0 ? JSON.stringify(value) : whole;
	};
	const names = [...aliases].map((one) => one.replace(/\$/g, '\\$')).join('|');
	const rest = source
		.slice(from)
		.replace(new RegExp(`(?<![\\w$])(?:${names})\\((0[xX][0-9a-fA-F]+|\\d+)\\)`, 'g'), (whole, digits) =>
			answer(whole, Number(digits))
		)
		.replace(new RegExp(`(?<![\\w$])(?:${names})\\((${NAME})\\.(${NAME})\\)`, 'g'), (whole, owner, key) =>
			answer(whole, tables.get(`${owner}.${key}`))
		);
	return source.slice(0, from) + rest;
}

const expected = {};
for (const file of readdirSync(samples).sort()) {
	if (!file.endsWith('.js') || file === 'source.js') continue;
	const name = file.slice(0, -3);
	const source = readFileSync(samples + file, 'utf8');
	const original = behaviour(source);
	if (original !== behaviour(readFileSync(`${samples}source.js`, 'utf8'))) {
		throw new Error(`${file} does not behave like the program it was made from`);
	}
	if (DECLINED.has(name)) {
		expected[name] = null;
		continue;
	}
	const output = expectedFor(source);
	if (behaviour(output) !== original) throw new Error(`the expected output for ${file} behaves differently`);
	if (output === source) throw new Error(`the expected output for ${file} rewrote nothing`);
	expected[name] = output;
}

writeFileSync(`${here}expected.json`, JSON.stringify(expected, null, '\t') + '\n');
console.log(`wrote ${Object.keys(expected).length} expected outputs`);
