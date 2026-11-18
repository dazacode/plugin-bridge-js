/**
 * The cheerio façade and the two library subsets, evaluated as the bundle
 * source they ship as.
 *
 * Pinned where cheerio and the shared parser disagree, because those are the
 * places a source reads the façade wrong without an error, and where a library
 * subset would be tempted to answer something rather than refuse. No real site
 * appears here (AGENTS.md rule 9).
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CHEERIO_SOURCE } from './cheerio';
import { DIGESTS } from './digests';
import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { JS_LIBRARIES_SOURCE } from './js-libraries';

type Library = {
	cheerio: { load(html: string): CheerioLike };
	entities: { decode(text: string): string; encode(text: string, options?: unknown): string };
	crypto: Record<string, any>;
};
type CheerioLike = ((what: unknown, context?: unknown) => any) & Record<string, any>;

const library = new Function(
	`${DOM_RUNTIME_SOURCE}\n${DIGESTS}\n${CHEERIO_SOURCE}\n${JS_LIBRARIES_SOURCE}\nreturn { cheerio: __cheerio, entities: __htmlEntities, crypto: __cryptoJs };`
)() as Library;

const HTML = `<div class="outer"><div class="card" data-id="1"><a href="/one">  One <b>bold</b>
</a><!-- note --><img src="/1.jpg"></div><div class="card"><a href="/two">Two</a></div></div>
<ul><li class="a">a</li><li class="b new">b</li><li>c</li></ul><script>var x = 1;</script>`;

describe('the cheerio façade', () => {
	const $ = library.cheerio.load(HTML);

	it('finds below each element, never the element itself', () => {
		expect($('div.outer').find('div').length).toBe(2);
		expect($('div').length).toBe(3);
	});

	it('reads text as written, comments left out, script bodies kept', () => {
		expect($('.card').first().text()).toBe('  One bold\n');
		expect($('script').text()).toBe('var x = 1;');
	});

	it('answers undefined for an absent attribute, and every attribute with no name', () => {
		expect($('.card').attr('data-id')).toBe('1');
		expect($('.card').eq(1).attr('data-id')).toBeUndefined();
		expect($('li.b').attr()).toEqual({ class: 'b new' });
	});

	it('hands callbacks nodes shaped as cheerio’s', () => {
		const kinds = $('.card')
			.first()
			.contents()
			.map((_: number, node: any) => `${node.type}:${node.name ?? node.data.trim()}`)
			.get();
		expect(kinds).toEqual(['tag:a', 'comment:note', 'tag:img']);
		expect($('img').get(0).attribs).toEqual({ src: '/1.jpg' });
		expect($('li').toArray()[0].parent.name).toBe('ul');
	});

	it('maps as cheerio does: nulls dropped, arrays flattened', () => {
		expect(
			$('li')
				.map((i: number, el: any) =>
					i === 1 ? null : i === 2 ? [$(el).text(), 'z'] : $(el).text()
				)
				.get()
		).toEqual(['a', 'c', 'z']);
	});

	it('filters, narrows and moves', () => {
		expect($('li').filter('.a, .b').length).toBe(2);
		expect($('li').not('.a').length).toBe(2);
		expect(
			$('li')
				.filter((_: number, el: any) => $(el).text() === 'c')
				.text()
		).toBe('c');
		expect($('li').is('.b')).toBe(true);
		expect($('li').eq(1).hasClass('new')).toBe(true);
		expect($('.card').has('img').length).toBe(1);
		expect($('li.a').next().text()).toBe('b');
		expect($('li.b').prev().text()).toBe('a');
		expect($('img').closest('.card').attr('data-id')).toBe('1');
		expect($('div', '.outer').length).toBe(2);
		expect($('li.a').add('li.b').length).toBe(2);
		expect($('ul').children('li').length).toBe(3);
		expect($('li.a').parent().is('ul')).toBe(true);
	});

	it('edits a clone without touching the page, and ends back where it was', () => {
		const card = $('.card').first();
		expect(card.clone().find('b').remove().end().text()).toBe('  One \n');
		expect(card.text()).toBe('  One bold\n');
	});

	it('replaces a line break with text, as the idiom expects', () => {
		const local = library.cheerio.load('<p>one<br>two</p>');
		local('br').replaceWith('\n');
		expect(local('p').text()).toBe('one\ntwo');
	});

	it('answers the root, the markup and the text of the whole document', () => {
		expect($.root().find('li').length).toBe(3);
		expect($.html($('li.a'))).toBe('<li class="a">a</li>');
		expect($.text($('li'))).toBe('abc');
	});
});

describe('html-entities', () => {
	it('decodes with the parser’s own table and encodes the five special characters', () => {
		expect(library.entities.decode('a &amp; b &lt;c&gt; &eacute; &#39;')).toBe("a & b <c> é '");
		expect(library.entities.encode(`<a href="x">'&'</a>`)).toBe(
			'&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;'
		);
		expect(() => library.entities.encode('x', { mode: 'nonAscii' })).toThrow(/nonAscii/);
	});
});

describe('crypto-js, the keyless part', () => {
	const C = library.crypto;

	it('round-trips the encoders and agrees with node on the digests', () => {
		const words = C.enc.Utf8.parse('héllo');
		expect(C.enc.Utf8.stringify(C.enc.Base64.parse(C.enc.Base64.stringify(words)))).toBe('héllo');
		expect(C.enc.Hex.stringify(C.enc.Hex.parse('00ff10'))).toBe('00ff10');
		expect(C.SHA256('abc').toString()).toBe(createHash('sha256').update('abc').digest('hex'));
		expect(C.MD5('abc').toString(C.enc.Base64)).toBe(
			createHash('md5').update('abc').digest('base64')
		);
		expect(C.lib.CipherParams.create({ ciphertext: C.enc.Hex.parse('0102') }).toString()).toBe(
			'AQI='
		);
	});

	it('throws on bytes that are not UTF-8, as crypto-js does', () => {
		expect(() => C.enc.Utf8.stringify(C.enc.Hex.parse('ff'))).toThrow('Malformed UTF-8 data');
	});

	it('refuses every keyed operation by name rather than answering', () => {
		expect(() => C.AES.decrypt('x', 'key')).toThrow(/crypto-js AES/);
		expect(() => C.HmacSHA256('x', 'key')).toThrow(/crypto-js HmacSHA256/);
	});
});
