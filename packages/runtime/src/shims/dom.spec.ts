/**
 * The parser is only interesting where the markup is broken.
 *
 * Every fixture here is a shape that turns up in scraped pages — an unclosed
 * `<li>`, a `<script>` full of angle brackets, a `</div>` with nothing to close,
 * an attribute nobody quoted. A parser that handles well-formed HTML and nothing
 * else would pass a test suite and fail on the first real page, so the happy path
 * is the smallest part of what is asserted below.
 *
 * Rule 9: every host, URL and title here is `example.invalid` or `example.com`.
 * There is no real content source in this file and there never will be.
 */

import { describe, expect, it } from 'vitest';

import { parseHtml } from './dom';

const BASE = 'https://example.invalid/a/b/index.html';

const PAGE = `<!DOCTYPE html>
<html>
<head><title>Cards &amp; lists</title></head>
<body>
	<div id="main" class="Wrap outer">
		<ul class="cards">
			<li class="card first" data-id="1"><a href="/watch/1" title="One">One</a></li>
			<li class="card" data-id="2"><a href="/watch/2" title="Two">Two</a><span class="badge">new</span></li>
			<li class="card last" data-id="30"><a href="https://example.com/3" title="Three">Three</a></li>
		</ul>
		<p class="note">Nothing <em>here</em></p>
	</div>
</body>
</html>`;

const page = parseHtml(PAGE, BASE);

/** The tag names a selector produced, which is what most assertions are about. */
function tags(elements: { tagName: string }[]): string[] {
	return elements.map((element) => element.tagName);
}

/** The text each match produced. */
function texts(elements: { text(): string }[]): string[] {
	return elements.map((element) => element.text());
}

describe('the shape a document always has', () => {
	it('synthesises html, head and body around a bare fragment', () => {
		const document = parseHtml('<div><span></span></div>');
		expect(tags(document.select('*'))).toEqual(['#root', 'html', 'head', 'body', 'div', 'span']);
	});

	it('reuses the declared html, head and body rather than nesting new ones', () => {
		const document = parseHtml(
			'<html lang="en"><head></head><body class="b"><p>x</p></body></html>'
		);
		expect(document.select('html').length).toBe(1);
		expect(document.select('body').length).toBe(1);
		expect(document.selectFirst('html')?.attr('lang')).toBe('en');
		expect(document.selectFirst('body')?.attr('class')).toBe('b');
	});

	it('puts head content in head and everything else in body', () => {
		const document = parseHtml('<meta charset="utf-8"><title>T</title><p>body copy</p>');
		expect(tags(document.select('head > *'))).toEqual(['meta', 'title']);
		expect(tags(document.select('body > *'))).toEqual(['p']);
	});

	it('reads the title, entities decoded', () => {
		expect(page.title()).toBe('Cards & lists');
		expect(parseHtml('<p>no title here</p>').title()).toBe('');
	});

	it('carries the base url on the document', () => {
		expect(page.baseUrl).toBe(BASE);
		expect(parseHtml('<p></p>').baseUrl).toBe('');
	});

	it('survives an empty and a truncated document', () => {
		expect(parseHtml('').select('*').length).toBe(4);
		expect(parseHtml('<div class=" <<< ').selectFirst('div')).not.toBeNull();
	});
});

describe('markup that is broken in the usual ways', () => {
	it('closes an open li when the next one starts', () => {
		const document = parseHtml('<ul><li>one<li>two<li>three</ul>');
		expect(texts(document.select('li'))).toEqual(['one', 'two', 'three']);
		expect(document.select('li li').length).toBe(0);
	});

	it('still nests a list inside a list item', () => {
		const document = parseHtml('<ul><li>outer<ul><li>inner</ul><li>after</ul>');
		expect(document.select('li li').length).toBe(1);
		expect(texts(document.select('ul > li'))).toEqual(['outer inner', 'inner', 'after']);
	});

	it('closes an open p when a block element starts', () => {
		const document = parseHtml('<p>first<p>second<div>block</div>');
		expect(texts(document.select('p'))).toEqual(['first', 'second']);
		expect(document.select('p div').length).toBe(0);
		expect(document.selectFirst('div')?.text()).toBe('block');
	});

	it('closes cells and rows in a table nobody closed', () => {
		const document = parseHtml('<table><tr><td>a<td>b<tr><td>c</table>');
		const rows = document.select('tr');
		expect(rows.length).toBe(2);
		expect(texts(rows[0].select('td'))).toEqual(['a', 'b']);
		expect(texts(rows[1].select('td'))).toEqual(['c']);
	});

	it('closes an option when the next one starts', () => {
		const document = parseHtml('<select><option value=1>one<option value=2>two</select>');
		const options = document.select('option');
		expect(options.length).toBe(2);
		expect(options[1].attr('value')).toBe('2');
	});

	it('ignores an end tag that closes nothing', () => {
		const document = parseHtml('<div>a</div></div></span><p>b</p>');
		expect(tags(document.select('body > *'))).toEqual(['div', 'p']);
		expect(document.selectFirst('p')?.text()).toBe('b');
	});

	it('treats void elements as childless whichever way they are written', () => {
		const document = parseHtml('<div><img src="a.png"><br/><hr>tail</div>');
		expect(tags(document.select('div > *'))).toEqual(['img', 'br', 'hr']);
		expect(document.selectFirst('img')?.children.length).toBe(0);
		expect(document.selectFirst('div')?.ownText()).toBe('tail');
	});

	it('honours a self-closed non-void tag instead of nesting the rest of the page in it', () => {
		const document = parseHtml('<div><span class="x"/><b>y</b></div>');
		expect(tags(document.select('div > *'))).toEqual(['span', 'b']);
		expect(document.select('span b').length).toBe(0);
	});

	it('reads unquoted, single-quoted and valueless attributes', () => {
		const document = parseHtml("<a href=/watch/1 class=link data-x='q u' hidden>go</a>");
		const anchor = document.selectFirst('a');
		expect(anchor?.attr('href')).toBe('/watch/1');
		expect(anchor?.attr('class')).toBe('link');
		expect(anchor?.attr('data-x')).toBe('q u');
		expect(anchor?.hasAttr('hidden')).toBe(true);
		expect(anchor?.attr('hidden')).toBe('');
	});

	it('keeps the first of a duplicated attribute', () => {
		expect(parseHtml('<a href="one" href="two">x</a>').selectFirst('a')?.attr('href')).toBe('one');
	});

	it('does not read markup inside script or style', () => {
		const document = parseHtml(
			'<script>var a = "<div id=fake>"; if (1 < 2) {}</script>' +
				'<style>.a > .b { content: "<p>"; }</style>' +
				'<div id="real">r</div>'
		);
		expect(tags(document.select('div'))).toEqual(['div']);
		expect(document.selectFirst('div')?.id).toBe('real');
		// Script and style bodies are data, not text.
		expect(document.text()).toBe('r');
		expect(document.selectFirst('script')?.html()).toContain('id=fake');
	});

	it('is not fooled by a tag whose name merely starts like the end tag', () => {
		const document = parseHtml('<script>x</scriptish>y</script><p>after</p>');
		expect(document.selectFirst('p')?.text()).toBe('after');
		expect(document.selectFirst('script')?.html()).toBe('x</scriptish>y');
	});

	it('keeps comments out of the text and inside the html', () => {
		const document = parseHtml('<div><!-- a note -->visible</div>');
		expect(document.selectFirst('div')?.text()).toBe('visible');
		expect(document.selectFirst('div')?.html()).toBe('<!-- a note -->visible');
	});

	it('treats a lone angle bracket as text', () => {
		expect(parseHtml('<p>1 < 2 and 3 > 2</p>').selectFirst('p')?.text()).toBe('1 < 2 and 3 > 2');
	});

	it('decodes named, decimal and hex references', () => {
		const document = parseHtml('<p>a &amp; b &#39;c&#39; &#x2014; d&nbsp;e &notreal;</p>');
		expect(document.selectFirst('p')?.text()).toBe("a & b 'c' — d e &notreal;");
	});
});

describe('text, own text and serialisation', () => {
	it('normalises whitespace and separates block elements', () => {
		const document = parseHtml('<div>\n  <td>a</td>\n  <td>b</td>\n</div>');
		expect(document.selectFirst('div')?.text()).toBe('a b');
	});

	it('does not glue inline elements together', () => {
		expect(parseHtml('<p>one <em>two</em>three</p>').selectFirst('p')?.text()).toBe('one twothree');
	});

	it('breaks a line at a br', () => {
		expect(parseHtml('<p>one<br>two</p>').selectFirst('p')?.text()).toBe('one two');
	});

	it('ownText sees only its own text children', () => {
		const note = page.selectFirst('p.note');
		expect(note?.text()).toBe('Nothing here');
		expect(note?.ownText()).toBe('Nothing');
	});

	it('round-trips markup without reformatting it', () => {
		const document = parseHtml('<div id="a"><span>x &amp; y</span><img src="p.png"></div>');
		expect(document.selectFirst('div')?.outerHtml()).toBe(
			'<div id="a"><span>x &amp; y</span><img src="p.png"></div>'
		);
		expect(document.selectFirst('div')?.html()).toBe('<span>x &amp; y</span><img src="p.png">');
	});

	it('serialises a document without inventing a tag for the root', () => {
		expect(parseHtml('<p>x</p>').outerHtml()).toBe(
			'<html><head></head><body><p>x</p></body></html>'
		);
	});
});

describe('data, which is where a page keeps what text() cannot see', () => {
	it('reads a script body, entities and all, and never its element text', () => {
		const document = parseHtml(
			'<div><script>var sources = ["a&b"]; if (1 < 2) go();</' + 'script>text</div>'
		);
		const holder = document.selectFirst('div');

		expect(holder?.data()).toBe('var sources = ["a&b"]; if (1 < 2) go();');
		expect(holder?.text()).toBe('text');
	});

	it('gathers data from the whole subtree, and reads comments too', () => {
		const document = parseHtml(
			'<div><style>a{}</style><p><script>x=1</' + 'script></p><!-- note --></div>'
		);
		expect(document.selectFirst('div')?.data()).toBe('a{}x=1 note ');
	});

	it(':containsData matches a script by what is inside it', () => {
		const document = parseHtml(
			'<script>var other = 1</' +
				'script><script>var availableres = {"1080":"x"}</' +
				'script><p>var availableres</p>'
		);

		// The paragraph *says* the same thing, and it is not data: a
		// `:containsData` that fell back on text would pick the wrong node and
		// the extraction would go looking for a stream in a sentence.
		const found = document.select('script:containsData(var availableres)');
		expect(found.length).toBe(1);
		expect(found[0].data()).toBe('var availableres = {"1080":"x"}');
		expect(document.select('script:containsData(nothing)').length).toBe(0);
	});

	it(':containsData ignores case, as every other jsoup text pseudo does', () => {
		const document = parseHtml('<script>var Sources = 1</' + 'script>');
		expect(document.select('script:containsData(var sources)').length).toBe(1);
	});
});

describe('absUrl and val, which are jsoup spellings of things it already had', () => {
	it('absUrl resolves against the base url, and says nothing when there is nothing', () => {
		const anchor = page.selectFirst('a');
		expect(anchor?.absUrl('href')).toBe(anchor?.attr('abs:href'));
		expect(anchor?.absUrl('nope')).toBe('');
	});

	it('val reads a control’s value, and a textarea’s text', () => {
		const document = parseHtml('<input value="v"><textarea>written</textarea><p>x</p>');
		expect(document.selectFirst('input')?.val()).toBe('v');
		expect(document.selectFirst('textarea')?.val()).toBe('written');
		expect(document.selectFirst('p')?.val()).toBe('');
	});
});

describe('attributes and abs:', () => {
	it('answers with an empty string for an attribute that is not there', () => {
		const anchor = page.selectFirst('a');
		expect(anchor?.attr('nope')).toBe('');
		expect(anchor?.hasAttr('nope')).toBe(false);
	});

	it('looks attributes up without regard to case', () => {
		expect(page.selectFirst('a')?.attr('HREF')).toBe('/watch/1');
	});

	it('exposes className and id', () => {
		const main = page.selectFirst('#main');
		expect(main?.className).toBe('Wrap outer');
		expect(main?.id).toBe('main');
		expect(page.selectFirst('ul')?.id).toBe('');
	});

	it('resolves abs: against the document base', () => {
		const document = parseHtml(
			'<a id="root" href="/watch/1"></a>' +
				'<a id="rel" href="c.html"></a>' +
				'<a id="up" href="../d.html"></a>' +
				'<a id="scheme" href="//cdn.example.com/x.png"></a>' +
				'<a id="full" href="https://example.com/y"></a>' +
				'<a id="query" href="?page=2"></a>' +
				'<a id="hash" href="#top"></a>',
			BASE
		);
		const href = (id: string) => document.selectFirst('#' + id)?.attr('abs:href');

		expect(href('root')).toBe('https://example.invalid/watch/1');
		expect(href('rel')).toBe('https://example.invalid/a/b/c.html');
		expect(href('up')).toBe('https://example.invalid/a/d.html');
		expect(href('scheme')).toBe('https://cdn.example.com/x.png');
		expect(href('full')).toBe('https://example.com/y');
		expect(href('query')).toBe('https://example.invalid/a/b/index.html?page=2');
		expect(href('hash')).toBe('https://example.invalid/a/b/index.html#top');
	});

	it('returns the reference unchanged when there is no base to resolve against', () => {
		expect(parseHtml('<a href="c.html"></a>').selectFirst('a')?.attr('abs:href')).toBe('c.html');
	});

	it('returns an empty string for abs: on a missing attribute', () => {
		const document = parseHtml('<a name="x"></a>', BASE);
		expect(document.selectFirst('a')?.attr('abs:href')).toBe('');
		expect(document.selectFirst('a')?.hasAttr('abs:href')).toBe(false);
	});
});

describe('sibling navigation', () => {
	it('steps forwards and backwards over elements only', () => {
		const first = page.selectFirst('li.first');
		const second = first?.nextElementSibling();
		expect(second?.attr('data-id')).toBe('2');
		expect(second?.previousElementSibling()?.attr('data-id')).toBe('1');
		expect(first?.previousElementSibling()).toBeNull();
		expect(page.selectFirst('li.last')?.nextElementSibling()).toBeNull();
	});
});

describe('the node-level walk, which includes text', () => {
	const nodes = parseHtml(
		'<div id="info"><span class="k">Title</span> Sono Bisque <br><em>x</em>tail</div>',
		BASE
	);

	it('answers the text before an element, which an element walk steps over', () => {
		// `select("span + br").first()?.previousSibling()?.toString()` is how a
		// title written between two tags is read. `previousElementSibling` walks
		// straight past it, and `[object Object]` there becomes the title.
		const br = nodes.selectFirst('br');
		expect(br?.previousSibling()?.toString().trim()).toBe('Sono Bisque');
		expect(br?.previousElementSibling()?.tagName).toBe('span');
	});

	it('answers the node after one, and null at either end', () => {
		const em = nodes.selectFirst('em');
		expect(em?.nextSibling()?.toString()).toBe('tail');
		expect(nodes.selectFirst('#info')?.previousSibling()).toBeNull();
	});

	it('lists only its own text children', () => {
		const texts = nodes.selectFirst('#info')?.textNodes() ?? [];
		expect(texts.map((one) => one.text().trim())).toEqual(['Sono Bisque', 'tail']);
	});

	it('keeps the whitespace `text()` normalises away', () => {
		const spaced = parseHtml('<p>one\n\n  two</p>');
		expect(spaced.selectFirst('p')?.text()).toBe('one two');
		expect(spaced.selectFirst('p')?.wholeText()).toBe('one\n\n  two');
	});
});

describe('the lookups jsoup answers without a selector', () => {
	it('finds an element by id, from anywhere above it', () => {
		// A selector would need the id escaped, and the id an extension passes
		// here comes out of the page rather than out of the source.
		expect(page.getElementById('main')?.tagName).toBe('div');
		expect(page.getElementById('nope')).toBeNull();
		expect(parseHtml('<div id="a.b">x</div>').getElementById('a.b')?.text()).toBe('x');
	});

	it('lists descendants by tag', () => {
		expect(page.getElementsByTag('li').length).toBe(3);
		expect(page.selectFirst('ul')?.getElementsByTag('a').length).toBe(3);
	});

	it('answers hasClass without regard to case, and classNames as written', () => {
		const main = page.selectFirst('#main');
		expect(main?.hasClass('wrap')).toBe(true);
		expect(main?.hasClass('WRAP')).toBe(true);
		expect(main?.hasClass('wra')).toBe(false);
		// As the attribute wrote them, which is not the lower-cased match set.
		expect(main?.classNames()).toEqual(['Wrap', 'outer']);
	});

	it('answers the document base url from any node', () => {
		expect(page.selectFirst('li.first')?.baseUri()).toBe(BASE);
	});
});

describe('clone, which an extension takes so it can edit a copy', () => {
	it('copies deeply and leaves the original attached and whole', () => {
		const source = parseHtml('<ul><li class="a">one</li><li>two</li></ul>');
		const list = source.selectFirst('ul');
		const copy = list?.clone();

		expect(copy?.select('li').length).toBe(2);
		expect(copy?.selectFirst('li.a')?.text()).toBe('one');
		// Detached, as jsoup's is: the copy exists to be edited without the page
		// it came from losing anything.
		expect(copy?.parent).toBeNull();
		expect(source.select('li').length).toBe(2);
	});
});

describe('the simple selectors', () => {
	it('matches by tag, and includes the element the query was rooted at', () => {
		expect(page.select('li').length).toBe(3);
		const list = page.selectFirst('ul');
		expect(list?.select('ul').length).toBe(1);
	});

	it('matches tags and classes without regard to case, and ids with it', () => {
		expect(parseHtml('<DIV CLASS="Card"></DIV>').select('div.CARD').length).toBe(1);
		expect(page.select('.card').length).toBe(3);
		expect(page.select('#main').length).toBe(1);
		expect(page.select('#MAIN').length).toBe(0);
	});

	it('matches everything with *', () => {
		expect(tags(page.select('#main *'))).toEqual([
			'ul',
			'li',
			'a',
			'li',
			'a',
			'span',
			'li',
			'a',
			'p',
			'em'
		]);
		expect(tags(page.select('ul > *'))).toEqual(['li', 'li', 'li']);
	});

	it('matches on attribute presence and value', () => {
		expect(page.select('[data-id]').length).toBe(3);
		expect(page.select('[data-id=2]').length).toBe(1);
		expect(page.select('[data-id="2"]').length).toBe(1);
		expect(page.select('[data-id^=3]').length).toBe(1);
		expect(page.select('[data-id$=0]').length).toBe(1);
		expect(page.select('[href*=watch]').length).toBe(2);
	});

	it('treats ~= as jsoup does — a regular expression, not a word list', () => {
		// Only the single-digit ids match; `30` does not.
		expect(page.select('[data-id~=^\\d$]').length).toBe(2);
		expect(page.select('[title~=^T]').length).toBe(2);
	});
});

describe('the combinators', () => {
	it('walks descendants, children, adjacent and general siblings', () => {
		expect(page.select('#main a').length).toBe(3);
		expect(page.select('ul > li').length).toBe(3);
		expect(page.select('#main > a').length).toBe(0);
		expect(page.select('li.first + li').map((li) => li.attr('data-id'))).toEqual(['2']);
		expect(page.select('li.first ~ li').length).toBe(2);
	});

	it('does not climb out of the element the query was rooted at', () => {
		const list = page.selectFirst('ul');
		// The <div id=main> ancestor is outside this subtree, so nothing matches.
		expect(list?.select('div a').length).toBe(0);
		expect(page.select('div a').length).toBe(3);
	});

	it('takes a comma-separated list, in document order and without duplicates', () => {
		expect(tags(page.select('p, li'))).toEqual(['li', 'li', 'li', 'p']);
		expect(page.select('li, .card').length).toBe(3);
	});

	it('selectFirst returns the first in document order, or null', () => {
		expect(page.selectFirst('li')?.attr('data-id')).toBe('1');
		expect(page.selectFirst('table')).toBeNull();
	});
});

describe('the structural pseudo-selectors', () => {
	const list = parseHtml('<ul><li>a</li><li>b</li><li>c</li><li>d</li><li>e</li></ul>');

	it('handles :first-child and :last-child', () => {
		expect(texts(list.select('li:first-child'))).toEqual(['a']);
		expect(texts(list.select('li:last-child'))).toEqual(['e']);
	});

	it('handles :nth-child with a plain number', () => {
		expect(texts(list.select('li:nth-child(2)'))).toEqual(['b']);
		expect(list.select('li:nth-child(9)').length).toBe(0);
	});

	it('handles the an+b forms', () => {
		expect(texts(list.select('li:nth-child(2n+1)'))).toEqual(['a', 'c', 'e']);
		expect(texts(list.select('li:nth-child(2n)'))).toEqual(['b', 'd']);
		expect(texts(list.select('li:nth-child(odd)'))).toEqual(['a', 'c', 'e']);
		expect(texts(list.select('li:nth-child(even)'))).toEqual(['b', 'd']);
		expect(texts(list.select('li:nth-child(-n+2)'))).toEqual(['a', 'b']);
		expect(texts(list.select('li:nth-child( 2n + 1 )'))).toEqual(['a', 'c', 'e']);
	});

	it('handles :nth-last-child, which counts from the end', () => {
		// Standard CSS, and jsoup has it, so a scraper using it works against
		// the real page — it was failing only here. Found in four extensions of
		// one catalogue, where the last row of a table is the one wanted and
		// the number of rows above it varies.
		expect(texts(list.select('li:nth-last-child(1)'))).toEqual(['e']);
		expect(texts(list.select('li:nth-last-child(2)'))).toEqual(['d']);
		expect(texts(list.select('li:nth-last-child(odd)'))).toEqual(['a', 'c', 'e']);
		expect(texts(list.select('li:nth-last-child(-n+2)'))).toEqual(['d', 'e']);
	});

	it('agrees with :last-child at the one place they overlap', () => {
		expect(texts(list.select('li:nth-last-child(1)'))).toEqual(texts(list.select('li:last-child')));
	});

	it('names the pseudo-class it could not read, not a neighbouring one', () => {
		// A message about `:nth-child` for a `:nth-last-child` selector sends
		// whoever reads it looking at the wrong part of the selector.
		expect(() => list.select('li:nth-last-child(zz)')).toThrow(/nth-last-child/);
	});
});

describe('the jsoup-only pseudo-selectors', () => {
	it(':not excludes, and takes a whole selector', () => {
		expect(page.select('li:not(.first)').length).toBe(2);
		expect(page.select('li:not([data-id=2])').length).toBe(2);
		expect(page.select('li:not(.first):not(.last)').length).toBe(1);
		expect(page.select('li:not(.first, .last)').length).toBe(1);
	});

	it(':has looks into the subtree, and takes a child combinator', () => {
		expect(page.select('li:has(span)').length).toBe(1);
		expect(page.select('li:has(> a)').length).toBe(3);
		expect(page.select('li:has(> span.badge)').length).toBe(1);
		expect(page.select('ul:has(li.last)').length).toBe(1);
		expect(page.select('li:has(table)').length).toBe(0);
	});

	it(':has with a sibling combinator looks forwards instead', () => {
		expect(page.select('li:has(+ li)').length).toBe(2);
		expect(page.select('li:has(~ li.last)').length).toBe(2);
	});

	it(':contains searches all descendant text, case-insensitively', () => {
		// `Twonew` and not `Two new`: <a> and <span> are inline, so neither of them
		// introduces a word boundary. jsoup reads it the same way.
		expect(texts(page.select('li:contains(two)'))).toEqual(['Twonew']);
		expect(page.select('ul:contains(Three)').length).toBe(1);
		expect(page.select('li:contains(nothing at all)').length).toBe(0);
	});

	it(':containsOwn searches only the element’s own text', () => {
		expect(page.select('p:containsOwn(Nothing)').length).toBe(1);
		// "here" belongs to the nested <em>, so it is not the paragraph's own.
		expect(page.select('p:containsOwn(here)').length).toBe(0);
		expect(page.select('p:contains(here)').length).toBe(1);
	});

	it(':matches takes a regular expression over the text', () => {
		expect(texts(page.select('a:matches(^T)'))).toEqual(['Two', 'Three']);
		expect(page.select('a:matches(^Z)').length).toBe(0);
		expect(page.select('li:matches(\\d)').length).toBe(0);
	});

	it(':matchesOwn is the same over own text', () => {
		expect(page.select('p:matchesOwn(^Nothing$)').length).toBe(1);
		expect(page.select('p:matchesOwn(here)').length).toBe(0);
	});

	it(':eq, :gt and :lt index siblings, not results — as jsoup does', () => {
		expect(texts(page.select('li:eq(0)'))).toEqual(['One']);
		expect(page.select('li:gt(0)').length).toBe(2);
		expect(page.select('li:lt(1)').length).toBe(1);

		// The sibling index is per parent, so one from each list matches, not one
		// in total. This is the property people expect to be result-relative.
		const two = parseHtml('<ul><li>a</li><li>b</li></ul><ul><li>c</li><li>d</li></ul>');
		expect(texts(two.select('li:eq(1)'))).toEqual(['b', 'd']);
	});
});

describe('closest, which is the only selector call that walks up', () => {
	it('tries the element itself before any ancestor', () => {
		const link = page.selectFirst('a[href="/watch/1"]')!;
		// Starting at the parent instead would skip an element that already
		// matches, which is the common case for `a.closest("a[href]")`.
		expect(link.closest('a')).toBe(link);
		expect(link.closest('li')!.attr('data-id')).toBe('1');
		expect(link.closest('#main')!.tagName).toBe('div');
	});

	it('answers null when nothing above it matches', () => {
		const link = page.selectFirst('a[href="/watch/1"]')!;
		expect(link.closest('table')).toBeNull();
		expect(link.closest('.badge')).toBeNull();
	});

	it('lets a descendant combinator look above the candidate', () => {
		const badge = page.selectFirst('span.badge')!;
		expect(badge.closest('ul.cards li')!.attr('data-id')).toBe('2');
	});

	it('reports an unparseable selector the way select does', () => {
		expect(() => page.selectFirst('li')!.closest('li:nope(1)')).toThrow(/is not supported/);
	});
});

describe('ownerDocument, which is how an element finds its base url', () => {
	it('answers the document an element was parsed into', () => {
		const link = page.selectFirst('a[href="/watch/1"]')!;
		expect(link.ownerDocument()).toBe(page);
		expect(link.ownerDocument()!.location()).toBe(BASE);
	});

	it('lets a document own itself, as jsoup does', () => {
		expect(page.ownerDocument()).toBe(page);
		// The pair exists for `element.ownerDocument()!!.location()`, so the two
		// spellings of the base url must agree.
		expect(page.location()).toBe(page.baseUrl);
	});
});

describe('selectors that do not parse', () => {
	it('names the selector and the reason', () => {
		expect(() => page.select('li:nope(1)')).toThrow(/is not supported/);
		expect(() => page.select('div[')).toThrow(/Could not parse the selector/);
		expect(() => page.select('div >')).toThrow();
		expect(() => page.select('')).toThrow();
		expect(() => page.select(':nth-child(q)')).toThrow(/not a recognised pattern/);
		expect(() => page.select(':eq(x)')).toThrow(/whole number/);
	});
});
