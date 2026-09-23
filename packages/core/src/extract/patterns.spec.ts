/**
 * The generic extraction transforms, including the inputs designed to break them.
 *
 * Two things are being pinned here. The first is that each transform decodes
 * what it claims to decode. The second, and the one worth the length, is that
 * none of them can be turned into a weapon by the text they are given: these
 * functions run on bytes that came off the network into a sandbox, so an
 * unbalanced brace, a literal nested five thousand deep, a packer claiming a
 * billion substitutions and a dictionary that is not a dictionary all have to
 * produce `null`, `''` or `[]` — quickly — rather than an exception or a spin.
 *
 * Every fixture is synthetic and every host in one is `example.invalid`, which
 * is reserved by RFC 6761 and resolves nowhere. `AGENTS.md` rule 9: there is no
 * real source named anywhere in this file, and there is no way to add one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
	base64Decode,
	base64Encode,
	decodeJsUnicodeEscapes,
	findManifestUrls,
	parseJsObjectLiteral,
	parsePlayerSources,
	unpackDeanEdwards,
	unpackStringArray
} from './patterns';

/* -------------------------------------------------------------------------
 * The premise
 * ---------------------------------------------------------------------- */

describe('the module itself', () => {
	it('contains no way to execute the text it is given', () => {
		const source = readFileSync(fileURLToPath(new URL('./patterns.ts', import.meta.url)), 'utf8');
		for (const gate of ['eval(', 'new Function(', 'Function(', 'import(', 'setTimeout(']) {
			expect(source.includes(gate)).toBe(false);
		}
	});
});

/* -------------------------------------------------------------------------
 * Fixture builders
 * ---------------------------------------------------------------------- */

/**
 * The packer's decoder, verbatim, as the body of the emitted function.
 *
 * Kept as text rather than paraphrased so that what the parser is pointed at
 * is the shape it will actually meet: regular expression literals, nested
 * braces, quoted backslashes and all. Nothing here is ever executed.
 */
const PACKER_BODY =
	"e=function(c){return(c<a?'':e(parseInt(c/a)))+((c=c%a)>35?String.fromCharCode(c+29):c.toString(36))};" +
	"if(!''.replace(/^/,String)){while(c--){d[e(c)]=k[c]||e(c)}k=[function(e){return d[e]}];" +
	"e=function(){return'\\\\w+'};c=1};" +
	"while(c--){if(k[c]){p=p.replace(new RegExp('\\\\b'+e(c)+'\\\\b','g'),k[c])}}return p";

/** The packer's index encoding, so fixtures are built the way they are read. */
function token(index: number, base: number): string {
	let value = index;
	let out = '';
	do {
		const digit = value % base;
		out = (digit > 35 ? String.fromCharCode(digit + 29) : digit.toString(36)) + out;
		value = Math.floor(value / base);
	} while (value > 0);
	return out;
}

interface PackOptions {
	readonly base?: number;
	readonly count?: number;
	readonly separator?: string;
	readonly dictionaryAsArray?: boolean;
	readonly withEval?: boolean;
}

/** Build a packed payload from a source and a dictionary, the way the packer does. */
function pack(source: string, words: readonly string[], options: PackOptions = {}): string {
	const base = options.base ?? 62;
	const separator = options.separator ?? '|';
	const payload = source.replace(/[A-Za-z0-9_]+/g, (word) => {
		const index = words.indexOf(word);
		return index === -1 ? word : token(index, base);
	});

	const quoted = payload.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
	const dictionary = options.dictionaryAsArray
		? `[${words.map((word) => `'${word}'`).join(',')}]`
		: `'${words.join(separator)}'.split('${separator}')`;

	const call = `function(p,a,c,k,e,d){${PACKER_BODY}}('${quoted}',${base},${options.count ?? words.length},${dictionary},0,{})`;
	return options.withEval === false ? call : `eval(${call})`;
}

/* -------------------------------------------------------------------------
 * unpackDeanEdwards
 * ---------------------------------------------------------------------- */

describe('unpackDeanEdwards', () => {
	it('restores the dictionary words a payload was packed against', () => {
		const original = 'function boot(){return alpha+beta}';
		expect(unpackDeanEdwards(pack(original, ['alpha', 'beta', 'boot']))).toBe(original);
	});

	it('reads an index whose token needs more than one digit', () => {
		// Base 62 turns over at 62, so index 100 is a two-digit token.
		const words: string[] = [];
		for (let i = 0; i < 101; i++) words.push(`w${i}`);
		const original = 'var target=w100;var other=w7';
		expect(unpackDeanEdwards(pack(original, words))).toBe(original);
	});

	it('uses the digit set above 35 that the packer uses', () => {
		expect(token(36, 62)).toBe('A');
		expect(token(61, 62)).toBe('Z');
		expect(token(62, 62)).toBe('10');
	});

	it('decodes a base other than 62', () => {
		const original = 'var one=first;var two=second';
		expect(unpackDeanEdwards(pack(original, ['first', 'second'], { base: 36 }))).toBe(original);
		expect(unpackDeanEdwards(pack(original, ['first', 'second'], { base: 10 }))).toBe(original);
	});

	it('accepts a dictionary written as an array literal', () => {
		const original = 'call(alpha,beta)';
		expect(unpackDeanEdwards(pack(original, ['alpha', 'beta'], { dictionaryAsArray: true }))).toBe(
			original
		);
	});

	it('accepts a separator other than the pipe', () => {
		const original = 'call(alpha,beta)';
		expect(unpackDeanEdwards(pack(original, ['alpha', 'beta'], { separator: '~' }))).toBe(original);
	});

	it('accepts a call that was embedded without the eval wrapper', () => {
		const original = 'return alpha';
		expect(unpackDeanEdwards(pack(original, ['alpha'], { withEval: false }))).toBe(original);
	});

	it('leaves a token whose dictionary slot is empty untouched', () => {
		// `d[e(c)] = k[c] || e(c)`: an empty slot decodes to its own token.
		const packed = `eval(function(p,a,c,k,e,d){${PACKER_BODY}}('0 1 2',62,3,'||gamma'.split('|'),0,{}))`;
		expect(unpackDeanEdwards(packed)).toBe('0 1 gamma');
	});

	it('decodes the escapes the payload string itself carries', () => {
		const packed = `eval(function(p,a,c,k,e,d){${PACKER_BODY}}('var s=\\'0\\';\\n1',62,2,'quoted|next'.split('|'),0,{}))`;
		expect(unpackDeanEdwards(packed)).toBe("var s='quoted';\nnext");
	});

	it('ignores whatever follows the four arguments it needs', () => {
		const packed = `eval(function(p,a,c,k,e,d){${PACKER_BODY}}('0',62,1,'alpha'.split('|')`;
		expect(unpackDeanEdwards(packed)).toBe('alpha');
	});

	it('substitutes only whole words', () => {
		const packed = pack('var ab=alpha', ['alpha']);
		// `alpha` is index 0, token `0`; the literal `ab` must survive intact.
		expect(unpackDeanEdwards(packed)).toBe('var ab=alpha');
	});

	it('preserves the payload verbatim where nothing matched', () => {
		const original = 'const marker="https://cdn.example.invalid/a/b.m3u8";';
		expect(unpackDeanEdwards(pack(original, ['marker']))).toBe(original);
	});

	it('clamps an enormous claimed substitution count to the dictionary', () => {
		const original = 'call(alpha,beta)';
		const started = Date.now();
		const unpacked = unpackDeanEdwards(pack(original, ['alpha', 'beta'], { count: 1_000_000_000 }));
		expect(unpacked).toBe(original);
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('returns null for a count that is not a whole number', () => {
		expect(unpackDeanEdwards(pack('x', ['x'], { count: Number.NaN }))).toBeNull();
	});

	it('returns null for a base outside the packer digit set', () => {
		expect(unpackDeanEdwards(pack('call(alpha)', ['alpha'], { base: 1 }))).toBeNull();
		expect(
			unpackDeanEdwards(pack('call(alpha)', ['alpha'], { base: 62 }).replace(',62,', ',999,'))
		).toBeNull();
	});

	it('returns null for source that is not packed', () => {
		expect(unpackDeanEdwards('function boot(){return 1}')).toBeNull();
		expect(unpackDeanEdwards('')).toBeNull();
		expect(unpackDeanEdwards('eval(function(a,b){return a})')).toBeNull();
	});

	it('returns null for a truncated or unbalanced packer', () => {
		const packed = pack('call(alpha)', ['alpha']);
		// Cut after the base argument, so the dictionary is never reached.
		expect(unpackDeanEdwards(packed.slice(0, packed.indexOf(',62,') + 4))).toBeNull();
		expect(unpackDeanEdwards(packed.slice(0, packed.indexOf("('call") + 4))).toBeNull();
		expect(unpackDeanEdwards('eval(function(p,a,c,k,e,d){')).toBeNull();
		expect(unpackDeanEdwards('eval(function(p,a,c,k,e,d){{{{{{{{{{')).toBeNull();
	});

	it('returns null when the arguments are not the four data values', () => {
		expect(
			unpackDeanEdwards(`eval(function(p,a,c,k,e,d){${PACKER_BODY}}(somewhere,62,1,x,0,{}))`)
		).toBeNull();
		expect(
			unpackDeanEdwards(`eval(function(p,a,c,k,e,d){${PACKER_BODY}}('p',62,1,notAString,0,{}))`)
		).toBeNull();
	});

	it('does not hang on a long run of packer heads that never resolve', () => {
		const started = Date.now();
		let source = '';
		for (let i = 0; i < 500; i++) source += 'eval(function(p,a,c,k,e,d){';
		expect(unpackDeanEdwards(source)).toBeNull();
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('declines input beyond the size bound instead of working on it', () => {
		expect(unpackDeanEdwards('a'.repeat(4_000_001))).toBeNull();
	});

	it('survives non-string input', () => {
		expect(unpackDeanEdwards(null as unknown as string)).toBeNull();
		expect(unpackDeanEdwards(42 as unknown as string)).toBeNull();
	});
});

/* -------------------------------------------------------------------------
 * unpackStringArray
 *
 * The fixtures are built the way the obfuscator builds its output, so that a
 * test failure means the unpacker stopped understanding the scheme rather than
 * that a hand-written sample drifted.
 * ---------------------------------------------------------------------- */

/** The alphabet the common build uses: lowercase first, which is not standard. */
const LOWER_FIRST = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';

/** Radix-64 over an arbitrary table — the inverse of what the unpacker does. */
function encodeWith(value: string, alphabet: string): string {
	const bytes: number[] = [];
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x80) bytes.push(code);
		else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
	}
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const a = bytes[i];
		const b = i + 1 < bytes.length ? bytes[i + 1] : -1;
		const c = i + 2 < bytes.length ? bytes[i + 2] : -1;
		out += alphabet.charAt(a >> 2);
		out += alphabet.charAt(((a & 3) << 4) | (b < 0 ? 0 : b >> 4));
		out += b < 0 ? '=' : alphabet.charAt(((b & 15) << 2) | (c < 0 ? 0 : c >> 6));
		out += c < 0 ? '=' : alphabet.charAt(c & 63);
	}
	return out;
}

interface ObfuscatorOptions {
	/** How many times the dictionary is pre-rotated, which the loop must undo. */
	readonly rotations?: number;
	/** Write the checksum's indices through a table, as most builds do. */
	readonly indirectChecksum?: boolean;
	/** Declare the decoder alias with no keyword, as a minifier does. */
	readonly aliasWithoutKeyword?: boolean;
	/** Store entries as plain text instead of encoding them. */
	readonly plainText?: boolean;
	/** The radix-64 table to encode with. */
	readonly alphabet?: string;
}

/**
 * A source in the string-array scheme, carrying `strings` at `offset`.
 *
 * Every identifier is `_0x` followed by hex, because that is what the tool
 * emits and what the unpacker matches on. A fixture with readable names is
 * correctly ignored, which makes it a test of nothing.
 *
 * The two entries the checksum reads are numeric, so the target is their sum
 * and holds for exactly one rotation of the dictionary.
 */
function obfuscated(strings: readonly string[], options: ObfuscatorOptions = {}): string {
	const alphabet = options.alphabet ?? LOWER_FIRST;
	const offset = 0x64;
	// Padded past the minimum a dictionary must reach to be taken for one, so
	// that a fixture carrying a single address is still shaped like real output.
	const filler: string[] = [];
	while (2 + strings.length + filler.length < 10) filler.push('pad' + String(filler.length));
	const entries = ['111', '222', ...strings, ...filler];
	const stored = entries.map((one) =>
		options.plainText === true ? one : encodeWith(one, alphabet)
	);

	// Pre-rotate backwards, so that shifting forwards restores the order.
	for (let i = 0; i < (options.rotations ?? 0); i++) stored.unshift(stored.pop() as string);

	const literal = stored.map((one) => "'" + one + "'").join(',');
	const decoder = options.plainText === true ? '' : "const _0xa1c3='" + alphabet + "';";
	const first = options.indirectChecksum === true ? '_0x9c0d._0xe1f2' : '0x64';
	const second = options.indirectChecksum === true ? '_0x9c0d._0xa3b4' : '0x65';
	const table =
		options.indirectChecksum === true ? 'const _0x9c0d={_0xe1f2:0x64,_0xa3b4:0x65};' : '';
	const alias =
		options.aliasWithoutKeyword === true
			? 'const _0xf5a6={_0xc7d8:0x1},_0xb2d4=_0xe3f4;'
			: 'const _0xb2d4=_0xe3f4;';

	return (
		'function _0x1a2b(){const _0x3c4d=[' +
		literal +
		'];_0x1a2b=function(){return _0x3c4d;};return _0x1a2b();}' +
		'(function(_0x5e6f,_0x7a8b){' +
		table +
		'const _0xc5d6=_0xe3f4;const _0xe7f8=_0x5e6f();while(!![]){try{' +
		'const _0xa9b0=parseInt(_0xc5d6(' +
		first +
		'))/0x1+parseInt(_0xc5d6(' +
		second +
		'))/0x1;' +
		'if(_0xa9b0===_0x7a8b)break;else _0xe7f8["push"](_0xe7f8["shift"]());' +
		'}catch(_0xc1d2){_0xe7f8["push"](_0xe7f8["shift"]());}}}(_0x1a2b,0x14d));' +
		'function _0xe3f4(_0xa5b6,_0xc7d8){_0xa5b6=_0xa5b6-' +
		String(offset) +
		';const _0xe9f0=_0x1a2b();' +
		decoder +
		'return _0xe9f0[_0xa5b6];}' +
		alias +
		'const value=_0xb2d4(0x66);'
	);
}

describe('unpackStringArray', () => {
	it('declines anything that is not in this form', () => {
		expect(unpackStringArray('const a = 1;')).toBeNull();
		expect(unpackStringArray('')).toBeNull();
	});

	it('reads the dictionary and rewrites the call sites', () => {
		const out = unpackStringArray(obfuscated(['https://example.test/api']));
		expect(out).not.toBeNull();
		expect(out).toContain('https://example.test/api');
	});

	it('undoes the rotation the dictionary was stored under', () => {
		for (const rotations of [0, 1, 3, 7]) {
			const out = unpackStringArray(obfuscated(['https://rotated.test/x'], { rotations }));
			expect(out, `rotated ${rotations}`).toContain('https://rotated.test/x');
		}
	});

	/*
	 * Each of the three below was a real defect, and each one *succeeded*: the
	 * unpacker returned a source that looked unpacked and silently withheld
	 * addresses. A caller deriving a request allowlist from that output
	 * produces a plugin refused at its first request, which reads as a broken
	 * source rather than as an under-declaration here.
	 */

	it('resolves indirect indices inside the rotation checksum', () => {
		// Measured: without this the checksum never evaluates, the rotation
		// never converges, and 30 of 60 real sources unpacked to nothing.
		const out = unpackStringArray(
			obfuscated(['https://indirect.test/v1'], { rotations: 2, indirectChecksum: true })
		);
		expect(out).not.toBeNull();
		expect(out).toContain('https://indirect.test/v1');
	});

	it('follows a decoder alias declared without a keyword', () => {
		// `const a={…},read=decode;` — the second declarator carries no `const`,
		// and requiring one loses every call made through `read`.
		const out = unpackStringArray(
			obfuscated(['https://aliased.test/v2'], { aliasWithoutKeyword: true })
		);
		expect(out).not.toBeNull();
		expect(out).toContain('https://aliased.test/v2');
	});

	it('decodes with the alphabet the source declares, not the standard one', () => {
		// The dangerous one. Decoding with the wrong table does not throw and
		// does not return nothing: it returns a different string of the same
		// length. Both alphabets below are valid; only the source says which.
		const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
		for (const alphabet of [LOWER_FIRST, standard]) {
			const out = unpackStringArray(obfuscated(['https://alphabet.test/z'], { alphabet }));
			expect(out, alphabet.slice(0, 6)).toContain('https://alphabet.test/z');
		}
	});

	it('reads a build that stored its entries as plain text', () => {
		const out = unpackStringArray(obfuscated(['https://plain.test/p'], { plainText: true }));
		expect(out).toContain('https://plain.test/p');
	});

	it('gives up rather than spinning when the checksum cannot be satisfied', () => {
		const broken = obfuscated(['https://never.test']).replace('0x14d', '0x7fffffff');
		expect(unpackStringArray(broken)).toBeNull();
	});
});

/* -------------------------------------------------------------------------
 * decodeJsUnicodeEscapes
 * ---------------------------------------------------------------------- */

describe('decodeJsUnicodeEscapes', () => {
	it('resolves hex, four-digit and braced escapes', () => {
		expect(decodeJsUnicodeEscapes('\\x41\\x42')).toBe('AB');
		expect(decodeJsUnicodeEscapes('\\u0041\\u0042')).toBe('AB');
		expect(decodeJsUnicodeEscapes('\\u{1F600}')).toBe('\u{1F600}');
	});

	it('joins a surrogate pair written as two escapes', () => {
		expect(decodeJsUnicodeEscapes('\\ud83d\\ude00')).toBe('\u{1F600}');
	});

	it('rebuilds a url written entirely as escapes', () => {
		const escaped = 'https://a.example.invalid/x.m3u8'
			.split('')
			.map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
			.join('');
		expect(decodeJsUnicodeEscapes(escaped)).toBe('https://a.example.invalid/x.m3u8');
	});

	it('resolves a character-code call with decimal and hex arguments', () => {
		expect(decodeJsUnicodeEscapes('String.fromCharCode(72,73)')).toBe('HI');
		expect(decodeJsUnicodeEscapes('String.fromCharCode(0x48, 0x49)')).toBe('HI');
		expect(decodeJsUnicodeEscapes('String.fromCharCode( 72 , 73 , )')).toBe('HI');
	});

	it('resolves a chain of concatenated character-code calls as one string', () => {
		expect(decodeJsUnicodeEscapes('String.fromCharCode(72)+String.fromCharCode(73)')).toBe('HI');
		expect(decodeJsUnicodeEscapes('String.fromCodePoint(128512)')).toBe('\u{1F600}');
	});

	it('stops a chain at the first thing that is not another call', () => {
		expect(decodeJsUnicodeEscapes('String.fromCharCode(72)+suffix')).toBe('H+suffix');
	});

	it('does not decode a backslash that was itself escaped', () => {
		expect(decodeJsUnicodeEscapes('\\\\u0041')).toBe('\\\\u0041');
	});

	it('leaves non-numeric escapes exactly as written', () => {
		expect(decodeJsUnicodeEscapes('a\\nb\\tc')).toBe('a\\nb\\tc');
		expect(decodeJsUnicodeEscapes('\\q')).toBe('\\q');
	});

	it('leaves malformed escapes verbatim', () => {
		expect(decodeJsUnicodeEscapes('\\uZZZZ')).toBe('\\uZZZZ');
		expect(decodeJsUnicodeEscapes('\\x4')).toBe('\\x4');
		expect(decodeJsUnicodeEscapes('\\u{110000}')).toBe('\\u{110000}');
		expect(decodeJsUnicodeEscapes('\\u{')).toBe('\\u{');
		expect(decodeJsUnicodeEscapes('trailing\\')).toBe('trailing\\');
	});

	it('leaves an unterminated character-code call verbatim', () => {
		expect(decodeJsUnicodeEscapes('String.fromCharCode(72,73')).toBe('String.fromCharCode(72,73');
		expect(decodeJsUnicodeEscapes('String.fromCharCode(oops)')).toBe('String.fromCharCode(oops)');
		expect(decodeJsUnicodeEscapes('String.fromWhatever(72)')).toBe('String.fromWhatever(72)');
	});

	it('returns an empty string for empty input and survives garbage', () => {
		expect(decodeJsUnicodeEscapes('')).toBe('');
		expect(decodeJsUnicodeEscapes(null as unknown as string)).toBe('');
		expect(decodeJsUnicodeEscapes({} as unknown as string)).toBe('');
	});

	it('does not spin on a very long unmatched call and stays bounded', () => {
		const started = Date.now();
		const hostile = `String.fromCharCode(${'65,'.repeat(200_000)}`;
		expect(decodeJsUnicodeEscapes(hostile).length).toBeGreaterThan(0);
		expect(Date.now() - started).toBeLessThan(3000);
	});
});

/* -------------------------------------------------------------------------
 * parsePlayerSources
 * ---------------------------------------------------------------------- */

describe('parsePlayerSources', () => {
	it('reads a double-quoted array', () => {
		const script = `setup({ sources: [{ "file": "https://a.example.invalid/x.m3u8", "label": "1080p", "type": "hls" }] });`;
		expect(parsePlayerSources(script)).toEqual([
			{ file: 'https://a.example.invalid/x.m3u8', label: '1080p', type: 'hls' }
		]);
	});

	it('reads single quotes, unquoted keys and a trailing comma', () => {
		const script = `var config = { sources: [ { file: 'https://a.example.invalid/x.mp4', label: 'SD', }, ], };`;
		expect(parsePlayerSources(script)).toEqual([
			{ file: 'https://a.example.invalid/x.mp4', label: 'SD' }
		]);
	});

	it('copes with nested braces and function values inside an entry', () => {
		const script = `
			player.setup({
				sources: [
					{
						file: "https://a.example.invalid/x.m3u8",
						type: "hls",
						drm: { widevine: { url: "https://a.example.invalid/l" } },
						onReady: function () { if (true) { return { a: 1 }; } }
					}
				]
			});`;
		expect(parsePlayerSources(script)).toEqual([
			{ file: 'https://a.example.invalid/x.m3u8', type: 'hls' }
		]);
	});

	it('accepts the alternate spellings of the location key', () => {
		expect(parsePlayerSources(`{sources:[{src:"https://a.example.invalid/x.mp4"}]}`)).toEqual([
			{ file: 'https://a.example.invalid/x.mp4' }
		]);
		expect(parsePlayerSources(`{sources:[{url:"https://a.example.invalid/y.mp4"}]}`)).toEqual([
			{ file: 'https://a.example.invalid/y.mp4' }
		]);
	});

	it('reads every array on the page, in order, without repeating an entry', () => {
		const script = `
			var a = { sources: [{ file: "https://a.example.invalid/1.m3u8" }] };
			var b = { "sources": [{ file: "https://a.example.invalid/2.m3u8" }] };
			var c = { sources: [{ file: "https://a.example.invalid/1.m3u8" }] };`;
		expect(parsePlayerSources(script)).toEqual([
			{ file: 'https://a.example.invalid/1.m3u8' },
			{ file: 'https://a.example.invalid/2.m3u8' }
		]);
	});

	it('ignores a key that merely ends in the word', () => {
		expect(
			parsePlayerSources(`{ mysources: [{ file: "https://a.example.invalid/x.mp4" }] }`)
		).toEqual([]);
	});

	it('drops entries with no usable location', () => {
		const script = `{ sources: [ { label: "1080p" }, { file: "" }, { file: 12 }, null, "x", [1], { file: "https://a.example.invalid/x.mp4" } ] }`;
		expect(parsePlayerSources(script)).toEqual([{ file: 'https://a.example.invalid/x.mp4' }]);
	});

	it('returns an empty array for garbage and for input with no array', () => {
		expect(parsePlayerSources('')).toEqual([]);
		expect(parsePlayerSources('<html><body>nothing here</body></html>')).toEqual([]);
		expect(parsePlayerSources('sources: not an array')).toEqual([]);
		expect(parsePlayerSources(null as unknown as string)).toEqual([]);
	});

	it('returns an empty array when the array never closes', () => {
		expect(parsePlayerSources(`{ sources: [{ file: "https://a.example.invalid/x.mp4" }`)).toEqual(
			[]
		);
		expect(parsePlayerSources(`{ sources: [{ file: "unterminated string }] }`)).toEqual([]);
	});

	it('does not go quadratic on a page that is nothing but the key', () => {
		// Reading one array is linear in what follows it, so the number read
		// has to be capped or this input is O(n²).
		const started = Date.now();
		expect(parsePlayerSources(' sources:[ '.repeat(20_000))).toEqual([]);
		expect(Date.now() - started).toBeLessThan(1000);
	});

	it('declines input beyond the size bound', () => {
		expect(parsePlayerSources('x'.repeat(4_000_001))).toEqual([]);
	});
});

/* -------------------------------------------------------------------------
 * findManifestUrls
 * ---------------------------------------------------------------------- */

describe('findManifestUrls', () => {
	it('finds each manifest and container extension', () => {
		const text = `
			a https://a.example.invalid/s/index.m3u8 b
			c https://b.example.invalid/s/manifest.mpd d
			e https://c.example.invalid/s/video.mp4 f`;
		expect(findManifestUrls(text)).toEqual([
			'https://a.example.invalid/s/index.m3u8',
			'https://b.example.invalid/s/manifest.mpd',
			'https://c.example.invalid/s/video.mp4'
		]);
	});

	it('keeps first-appearance order and de-duplicates', () => {
		const text = `"https://b.example.invalid/2.mp4" "https://a.example.invalid/1.m3u8" "https://b.example.invalid/2.mp4"`;
		expect(findManifestUrls(text)).toEqual([
			'https://b.example.invalid/2.mp4',
			'https://a.example.invalid/1.m3u8'
		]);
	});

	it('judges by the path, so a query string does not disqualify one', () => {
		expect(findManifestUrls('https://a.example.invalid/s/index.m3u8?token=abc&e=1')).toEqual([
			'https://a.example.invalid/s/index.m3u8?token=abc&e=1'
		]);
		expect(findManifestUrls('https://a.example.invalid/s/index.m3u8#frag')).toEqual([
			'https://a.example.invalid/s/index.m3u8#frag'
		]);
	});

	it('normalises slashes escaped for json', () => {
		expect(findManifestUrls('{"file":"https:\\/\\/a.example.invalid\\/s\\/x.m3u8"}')).toEqual([
			'https://a.example.invalid/s/x.m3u8'
		]);
	});

	it('separates urls written next to each other', () => {
		expect(
			findManifestUrls('https://a.example.invalid/1.mp4,https://b.example.invalid/2.mp4')
		).toEqual(['https://a.example.invalid/1.mp4', 'https://b.example.invalid/2.mp4']);
	});

	it('trims sentence punctuation but not the path', () => {
		expect(findManifestUrls('See https://a.example.invalid/s/x.m3u8.')).toEqual([
			'https://a.example.invalid/s/x.m3u8'
		]);
	});

	it('ignores anything that is not an absolute https media url', () => {
		const text = `
			http://a.example.invalid/s/x.m3u8
			//a.example.invalid/s/x.m3u8
			https://a.example.invalid/s/x.m3u8x
			https://a.example.invalid/s/x.txt
			https://a.example.invalid/.mp4
			https://a.example.invalid/page.html`;
		expect(findManifestUrls(text)).toEqual([]);
	});

	it('is case-insensitive about the extension', () => {
		expect(findManifestUrls('https://a.example.invalid/S/X.M3U8')).toEqual([
			'https://a.example.invalid/S/X.M3U8'
		]);
	});

	it('returns an empty array for garbage', () => {
		expect(findManifestUrls('')).toEqual([]);
		expect(findManifestUrls('\u0000\u0001\u0002 ????? <<<>>>')).toEqual([]);
		expect(findManifestUrls(undefined as unknown as string)).toEqual([]);
	});

	it('caps the result count and stays fast on a huge input', () => {
		const started = Date.now();
		let text = '';
		for (let i = 0; i < 5000; i++) text += ` https://a.example.invalid/${i}.mp4`;
		expect(findManifestUrls(text)).toHaveLength(512);
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it('declines input beyond the size bound', () => {
		expect(findManifestUrls('x'.repeat(4_000_001))).toEqual([]);
	});
});

/* -------------------------------------------------------------------------
 * parseJsObjectLiteral
 * ---------------------------------------------------------------------- */

describe('parseJsObjectLiteral', () => {
	it('reads a strict-json object', () => {
		expect(parseJsObjectLiteral('{"a":1,"b":[true,false,null]}', 0)).toEqual({
			a: 1,
			b: [true, false, null]
		});
	});

	it('reads what json refuses: quotes, bare keys, trailing commas, comments', () => {
		const text = `{
			// a line comment
			file: 'https://a.example.invalid/x.m3u8', /* and a block one */
			label: \`720p\`,
			flags: [1, 2, 3,],
			hex: 0x1f,
			negative: -2.5e3,
		}`;
		expect(parseJsObjectLiteral(text, 0)).toEqual({
			file: 'https://a.example.invalid/x.m3u8',
			label: '720p',
			flags: [1, 2, 3],
			hex: 31,
			negative: -2500
		});
	});

	it('reads an array literal as readily as an object', () => {
		expect(parseJsObjectLiteral("['a', 'b']", 0)).toEqual(['a', 'b']);
	});

	it('skips leading whitespace and comments before the literal', () => {
		expect(parseJsObjectLiteral('x = /* here */ { a: 1 }', 3)).toEqual({
			a: 1
		});
	});

	it('reads a numeric or quoted key as a string key', () => {
		expect(parseJsObjectLiteral("{1: 'a', 'b c': 2}", 0)).toEqual({
			'1': 'a',
			'b c': 2
		});
	});

	it('records a value it cannot know statically as undefined, keeping the key', () => {
		const parsed = parseJsObjectLiteral(
			'{ a: someVariable, b: function () { return 1; }, c: 2 + 3, d: new Thing(1), e: 4 }',
			0
		) as Record<string, unknown>;
		expect(Object.keys(parsed)).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(parsed.e).toBe(4);
		expect(parsed.a).toBeUndefined();
		expect(parsed.b).toBeUndefined();
	});

	it('does not let a __proto__ key reach the prototype', () => {
		const parsed = parseJsObjectLiteral('{"__proto__": {"polluted": true}}', 0) as Record<
			string,
			unknown
		>;
		expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
	});

	it('reads a delimiter inside a string as data, not structure', () => {
		expect(parseJsObjectLiteral(`{a: "}", b: "]", c: 'it\\'s', d: "\\u0041"}`, 0)).toEqual({
			a: '}',
			b: ']',
			c: "it's",
			d: 'A'
		});
	});

	it('returns null when the start position is not a literal', () => {
		expect(parseJsObjectLiteral('not a literal', 0)).toBeNull();
		expect(parseJsObjectLiteral('{"a":1}', 3)).toBeNull();
		expect(parseJsObjectLiteral('', 0)).toBeNull();
		expect(parseJsObjectLiteral('{"a":1}', 99)).toBeNull();
	});

	it('tolerates a nonsense start index by starting at the beginning', () => {
		expect(parseJsObjectLiteral('{"a":1}', -5)).toEqual({ a: 1 });
		expect(parseJsObjectLiteral('{"a":1}', Number.NaN)).toEqual({ a: 1 });
		expect(parseJsObjectLiteral('{"a":1}', Number.POSITIVE_INFINITY)).toEqual({
			a: 1
		});
		expect(parseJsObjectLiteral('{"a":1}', 2.7)).toBeNull();
	});

	it('returns null for unbalanced or truncated literals', () => {
		expect(parseJsObjectLiteral('{a: 1', 0)).toBeNull();
		expect(parseJsObjectLiteral('{a: [1, 2}', 0)).toBeNull();
		expect(parseJsObjectLiteral('{a: "unterminated}', 0)).toBeNull();
		expect(parseJsObjectLiteral('{a 1}', 0)).toBeNull();
		expect(parseJsObjectLiteral('{: 1}', 0)).toBeNull();
		expect(parseJsObjectLiteral('{a: }', 0)).toBeNull();
	});

	it('accepts nesting up to the bound and refuses beyond it', () => {
		const shallow = `${'['.repeat(32)}1${']'.repeat(32)}`;
		expect(parseJsObjectLiteral(shallow, 0)).not.toBeNull();

		const started = Date.now();
		const deep = `${'['.repeat(5000)}1${']'.repeat(5000)}`;
		expect(parseJsObjectLiteral(deep, 0)).toBeNull();
		expect(Date.now() - started).toBeLessThan(2000);
	});

	it('refuses a literal with more values than the node bound', () => {
		const wide = `[${'1,'.repeat(30_000)}1]`;
		expect(parseJsObjectLiteral(wide, 0)).toBeNull();
	});

	it('does not spin on an enormous unbalanced literal', () => {
		const started = Date.now();
		expect(parseJsObjectLiteral('['.repeat(500_000), 0)).toBeNull();
		expect(Date.now() - started).toBeLessThan(3000);
	});

	it('survives non-string input', () => {
		expect(parseJsObjectLiteral(null as unknown as string, 0)).toBeNull();
		expect(parseJsObjectLiteral(7 as unknown as string, 0)).toBeNull();
	});
});

/* -------------------------------------------------------------------------
 * base64
 * ---------------------------------------------------------------------- */

describe('base64Encode and base64Decode', () => {
	it('matches the padding cases of the standard vectors', () => {
		expect(base64Encode('Man')).toBe('TWFu');
		expect(base64Encode('Ma')).toBe('TWE=');
		expect(base64Encode('M')).toBe('TQ==');
		expect(base64Decode('TWFu')).toBe('Man');
		expect(base64Decode('TWE=')).toBe('Ma');
		expect(base64Decode('TQ==')).toBe('M');
	});

	it('round-trips ascii, punctuation and a synthetic url', () => {
		const value = 'https://a.example.invalid/s/x.m3u8?token=abc+def/ghi==';
		expect(base64Decode(base64Encode(value))).toBe(value);
	});

	it('round-trips text outside the basic plane', () => {
		const value = 'ようこそ \u{1F600} \u00e9\u00df';
		expect(base64Decode(base64Encode(value))).toBe(value);
	});

	it('encodes over utf-8 bytes rather than code units', () => {
		expect(base64Encode('\u00e9')).toBe('w6k=');
		expect(base64Decode('w6k=')).toBe('\u00e9');
	});

	it('accepts the url-safe alphabet and embedded whitespace', () => {
		const value = '\u00ff\u00fe\u00fd';
		const standard = base64Encode(value);
		const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_');
		expect(base64Decode(urlSafe)).toBe(value);
		expect(base64Decode(`${standard.slice(0, 4)}\n  ${standard.slice(4)}`)).toBe(value);
	});

	it('accepts input with the padding omitted', () => {
		expect(base64Decode('TWE')).toBe('Ma');
		expect(base64Decode('TQ')).toBe('M');
	});

	it('returns an empty string for input that is not base64', () => {
		expect(base64Decode('not base64!!')).toBe('');
		expect(base64Decode('****')).toBe('');
		expect(base64Decode('\u{1F600}')).toBe('');
	});

	it('returns replacement characters rather than throwing on invalid utf-8', () => {
		// 0xFF is not a legal lead byte in any position.
		expect(base64Decode('//8=')).toBe('\ufffd\ufffd');
		expect(base64Decode('4A==')).toBe('\ufffd');
	});

	it('returns an empty string for empty and non-string input', () => {
		expect(base64Encode('')).toBe('');
		expect(base64Decode('')).toBe('');
		expect(base64Encode(null as unknown as string)).toBe('');
		expect(base64Decode(undefined as unknown as string)).toBe('');
	});

	it('declines input beyond the size bound', () => {
		expect(base64Encode('x'.repeat(4_000_001))).toBe('');
		expect(base64Decode('A'.repeat(4_000_001))).toBe('');
	});

	it('round-trips a payload large enough to cross the chunking boundary', () => {
		const value = 'abcdefghij'.repeat(2000);
		expect(base64Decode(base64Encode(value))).toBe(value);
	});
});

/* -------------------------------------------------------------------------
 * The transforms composed, which is how a caller meets them
 * ---------------------------------------------------------------------- */

describe('the transforms together', () => {
	it('unpacks, decodes escapes and finds the url a synthetic page hid', () => {
		const inner = `var config={sources:[{file:"\\u0068\\u0074\\u0074\\u0070\\u0073://a.example.invalid/s/x.m3u8",label:"1080p",type:"hls"}]};`;
		const packed = pack(inner, ['config', 'sources', 'file', 'label', 'type']);

		const unpacked = unpackDeanEdwards(packed);
		expect(unpacked).not.toBeNull();

		const decoded = decodeJsUnicodeEscapes(unpacked as string);
		expect(parsePlayerSources(decoded)).toEqual([
			{
				file: 'https://a.example.invalid/s/x.m3u8',
				label: '1080p',
				type: 'hls'
			}
		]);
		expect(findManifestUrls(decoded)).toEqual(['https://a.example.invalid/s/x.m3u8']);
	});

	it('reaches a url that was base64 inside a packed payload', () => {
		const url = 'https://a.example.invalid/s/y.mpd';
		const encoded = base64Encode(url);
		const inner = `var blob="${encoded}";`;
		const unpacked = unpackDeanEdwards(pack(inner, ['blob']));
		expect(unpacked).toBe(inner);

		const match = /"([A-Za-z0-9+/=]+)"/.exec(unpacked as string);
		expect(match).not.toBeNull();
		expect(findManifestUrls(base64Decode((match as RegExpExecArray)[1]))).toEqual([url]);
	});
});

/* -------------------------------------------------------------------------
 * unpackStringArray, against the source it reads, executed
 *
 * The synthetic fixtures above are built the way the reader reads, which makes
 * them good at telling when it stops understanding the scheme and blind to the
 * scheme being something else. These are the obfuscator's own output — one
 * small program put through its string-array options one at a time — and the
 * expected text was produced by *running* each sample and asking its own
 * decoder, after its own rotation, what every call answers
 * (`fixtures/string-array/generate.mjs`, the only place anything runs). This
 * spec executes nothing.
 *
 * Before this: every rotated sample came out with every string shifted by the
 * same few places — the rotation was never found, because the obfuscator
 * follows its closing call with a comma and the reader demanded a parenthesis —
 * and output that ran looped forever, its checksum rewritten into a constant.
 * Every prefixed sample (`a0_0x…`) came back null.
 * ---------------------------------------------------------------------- */

describe('unpackStringArray, against its execution oracle', () => {
	const directory = fileURLToPath(new URL('../../../../fixtures/string-array/', import.meta.url));
	const expected = JSON.parse(readFileSync(`${directory}expected.json`, 'utf8')) as Record<
		string,
		string | null
	>;

	it('has the whole set of samples to check', () => {
		// So that a sample dropped from the directory is a failure, not a pass.
		expect(Object.keys(expected).sort()).toEqual([
			'base64',
			'base64-flattened',
			'base64-prefixed',
			'calls-transform',
			'prefixed',
			'rc4',
			'rotated',
			'rotated-comma',
			'rotated-comma-prefixed',
			'self-rebinding',
			'shuffled-index-shift',
			'unrotated',
			'unrotated-prefixed',
			'wrappers'
		]);
	});

	for (const [name, output] of Object.entries(expected)) {
		it(
			output === null
				? `declines ${name}, which it cannot read with certainty`
				: `reads ${name} exactly as running it does`,
			() => {
				const source = readFileSync(`${directory}samples/${name}.js`, 'utf8');
				expect(unpackStringArray(source)).toBe(output);
			}
		);
	}

	it('declines a rotated source whose rotation it cannot find, rather than reading it unrotated', () => {
		const source = readFileSync(`${directory}samples/rotated-comma.js`, 'utf8');
		// The closing call's target, made unreadable. The loop is still there,
		// so the dictionary still rotates when it runs; reading it as though it
		// did not is exactly the silent shift this used to produce.
		const broken = source.replace(/\}\(_0x5a4a,0xd9f3b\)/, '}(_0x5a4a,target)');
		expect(broken).not.toBe(source);
		expect(unpackStringArray(broken)).toBeNull();
	});
});
