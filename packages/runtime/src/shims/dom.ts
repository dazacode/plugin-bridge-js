/**
 * An HTML parser and a jsoup-shaped selector engine, written by hand.
 *
 * ## What it is for
 *
 * The scrapers being converted were written against **jsoup**, and they lean on
 * it on nearly every line: `doc.select(".card > a[href]")`, `el.attr("abs:href")`,
 * `el.text()`, and the jsoup-only pseudos `:contains`, `:matches`, `:eq`. None of
 * that exists in the sandbox, so it is built here, from the string up.
 *
 * `DOMParser` is not the shortcut it looks like. A plugin runs in a Worker on
 * QuickJS (Android, Windows, Linux) and JavaScriptCore (iOS, macOS) as well as in
 * a browser, and two of those three have no DOM at all — `ABI.md` §6. A parser
 * that works on the developer's machine and nowhere the product ships is worse
 * than no parser, because it fails at the customer rather than at the desk.
 *
 * The same section bans regex lookbehind, `Intl`, `structuredClone`,
 * `Array.prototype.at` and `Object.groupBy`. Nothing below uses any of them, and
 * nothing below has a dependency: this file is the whole implementation.
 *
 * ## Tolerance is the feature
 *
 * Scraped markup is not valid HTML and never will be. Unclosed `<li>` and `<p>`,
 * void `<img>` and `<br>` written both ways, a stray `</div>` from a truncated
 * template, unquoted attribute values, `<script>` bodies full of angle brackets —
 * all of that is normal, and every one of them has to parse into the tree a human
 * reading the page would expect. So this parser never rejects input. There is no
 * error path: the worst malformed document still yields a document.
 *
 * What it does *not* try to be is html5ever. There is no adoption agency
 * algorithm, no foster parenting of table content, no template contents. Those
 * matter for rendering; a selector run over scraped markup does not notice.
 *
 * ## Where it is deliberately jsoup and not CSS
 *
 * The point of the exercise is that converted code behaves the way its author
 * tested it, so where jsoup disagrees with CSS, jsoup wins:
 *
 * - `[attr~=value]` is a **regular expression** match on the attribute value,
 *   not the whitespace-separated-word match CSS defines. That is what jsoup
 *   compiles it to, and scrapers written against jsoup use it that way.
 * - `:eq(n)`, `:gt(n)` and `:lt(n)` test an element's index **among its
 *   siblings**, not its position in the result list. This one is misread
 *   constantly, including by people who wrote the scrapers, but reproducing the
 *   misreading is what keeps their output identical.
 * - `.class` and tag names match case-insensitively; `#id` does not.
 * - `text()` collapses `&nbsp;` along with ordinary whitespace, and treats block
 *   elements and `<br>` as word boundaries, so `<td>a</td><td>b</td>` reads
 *   `"a b"` rather than `"ab"`.
 *
 * Serialisation is the one place fidelity is knowingly dropped: jsoup
 * pretty-prints by default, re-indenting and re-wrapping as it writes.
 * `html()` here is the equivalent of `prettyPrint(false)` — the markup back out,
 * unreformatted. Anything comparing `outerHtml()` against a jsoup string byte for
 * byte will differ; anything feeding it to a regex, which is what scrapers
 * actually do with it, will not care.
 */

/* ── the public shape ─────────────────────────────────────────────────────── */

export interface KElement {
	readonly tagName: string;
	readonly children: KElement[];
	readonly parent: KElement | null;
	/** A selector string, or one of jsoup's `Evaluator`s (`jsoupEvaluator`). */
	select(selector: string | Query): KElement[];
	selectFirst(selector: string | Query): KElement | null;
	/** This element or its nearest ancestor matching the selector, else null. */
	closest(selector: string): KElement | null;
	/** `''` when absent; an `abs:` prefix resolves the value against the base url. */
	attr(name: string): string;
	/** jsoup's setter: sets the attribute and answers this element. */
	attr(name: string, value: string): KElement;
	attributes(): { key: string; value: string }[];
	dataset(): Map<string, string>;
	hasAttr(name: string): boolean;
	/** Every descendant's text, whitespace-normalised. */
	text(): string;
	/** Only the text children of this element. */
	ownText(): string;
	/** Inner HTML. */
	html(): string;
	outerHtml(): string;
	/** `<script>`/`<style>` bodies and comments, which `text()` never returns. */
	data(): string;
	/** An attribute resolved against the document's base url; `''` when absent. */
	absUrl(name: string): string;
	/** A form control's value: `<textarea>` text, everything else's `value`. */
	val(): string;
	readonly className: string;
	readonly id: string;
	nextElementSibling(): KElement | null;
	previousElementSibling(): KElement | null;
	/**
	 * jsoup's node-level siblings, which include text.
	 *
	 * Not the same question as `previousElementSibling`: a scraper reads
	 * `select("span + br").first()?.previousSibling()?.toString()` precisely
	 * because the value it wants is the *text* before a `<br>`, and an
	 * element-only walk steps straight over it.
	 */
	previousSibling(): KNode | null;
	nextSibling(): KNode | null;
	/** Only this element's own text children, as nodes. */
	textNodes(): KTextNode[];
	/** Every descendant's text, with the whitespace left as it was written. */
	wholeText(): string;
	/** An `id` anywhere below this element, which jsoup answers without a selector. */
	getElementById(id: string): KElement | null;
	/** Every descendant with this tag name. */
	getElementsByTag(tag: string): KElement[];
	/** Case-insensitive, as jsoup's is. */
	hasClass(name: string): boolean;
	/** This element's class names, in the order the attribute wrote them. */
	classNames(): string[];
	/** A detached deep copy: the original is left exactly as it was. */
	clone(): KElement;
	/** jsoup's name for the document's base url, asked of any node. */
	baseUri(): string;
	/** A unique path to this element, which `distinctBy` is handed. */
	cssSelector(): string;
	/** The document this element was parsed into, or itself if it is one. */
	ownerDocument(): KDocument | null;
	setBaseUri(uri: string): void;

	/* Traversal jsoup answers without a selector. */
	child(index: number): KElement;
	elementSiblingIndex(): number;
	parents(): KElement[];
	nextElementSiblings(): KElement[];
	previousElementSiblings(): KElement[];
	childNodes(): KNode[];
	getElementsByClass(name: string): KElement[];
	nodeName(): string;
	normalName(): string;
	is(query: string | Query): boolean;
	hasText(): boolean;

	/* Mutation — see `ElementImpl` for why a scraper needs it. */
	remove(): void;
	replaceWith(node: KNode): void;
	before(content: string | KNode): KElement;
	after(content: string | KNode): KElement;
	append(html: string): KElement;
	prepend(html: string): KElement;
	appendText(text: string): KElement;
	prependText(text: string): KElement;
	appendElement(tagName: string): KElement;
	prependElement(tagName: string): KElement;
}

/**
 * A text, comment or data node, which `previousSibling()` may answer with.
 *
 * jsoup's `Node.toString()` is the node's own markup, and that is what a
 * scraper reading the text before a `<br>` is after. `[object Object]` there is
 * a wrong value rather than an error: it becomes a title, or a video url.
 */
export interface KTextNode {
	readonly kind: 'text' | 'data' | 'comment';
	/** The text, entities decoded, each whitespace run collapsed (not trimmed). */
	text(): string;
	/** The text with its whitespace as written. */
	readonly wholeText: string;
	getWholeText(): string;
	isBlank(): boolean;
	nodeName(): string;
	readonly parent: KElement | null;
	remove(): void;
	outerHtml(): string;
	toString(): string;
}

/** Either half of what a node-level sibling walk can land on. */
export type KNode = KElement | KTextNode;

export interface KDocument extends KElement {
	readonly baseUrl: string;
	title(): string;
	/** jsoup spells the base url this way, and scrapers read it off a node. */
	location(): string;
	/** A new element owned by this document and not yet in it. */
	createElement(tagName: string): KElement;
	head(): KElement;
	body(): KElement;
}

/* ── tag tables ───────────────────────────────────────────────────────────── */

function tagSet(names: string): Set<string> {
	return new Set(names.split(' '));
}

/** Elements with no end tag. Anything after one is a sibling, not a child. */
const VOID_TAGS = tagSet('area base br col embed hr img input link meta param source track wbr');

/** Contents are text, never markup, and never contribute to `text()`. */
const RAW_TEXT_TAGS = tagSet('script style');

/** Contents are text, but they are *readable* text — entities and all. */
const RCDATA_TAGS = tagSet('title textarea');

/** What may sit in `<head>` before the parser decides the body has started. */
const HEAD_TAGS = tagSet('base link meta title style script noscript');

/**
 * jsoup's block list, and it is used for exactly one thing: deciding where
 * `text()` inserts a word boundary. Two words in adjacent cells are two words.
 */
const BLOCK_TAGS = tagSet(
	'html head body frameset script noscript style meta link title frame noframes ' +
		'section nav aside hgroup header footer p h1 h2 h3 h4 h5 h6 ul ol pre div ' +
		'blockquote hr address figure figcaption form fieldset ins del dl dt dd li ' +
		'table caption thead tfoot tbody colgroup col tr th td video audio canvas ' +
		'details menu article main center dir applet marquee listing template'
);

/**
 * Which open elements a start tag implicitly closes.
 *
 * The rule is applied as "pop while the *innermost* open element is in this
 * set", which is what makes nesting work without a scope algorithm: in
 * `<ul><li><ul><li>` the inner `<li>` sees `ul` on top, not `li`, so it nests
 * instead of closing its grandparent.
 */
const IMPLIED_END = new Map<string, Set<string>>();

{
	// Every block-level start tag closes an open <p>. This is where the great
	// majority of real-world unclosed tags live.
	const closesParagraph =
		'address article aside blockquote details div dl fieldset figcaption figure ' +
		'footer form h1 h2 h3 h4 h5 h6 header hgroup hr main menu nav ol p pre section ' +
		'table ul';
	for (const tag of closesParagraph.split(' ')) IMPLIED_END.set(tag, tagSet('p'));

	// Declared after the loop so these win where they overlap it.
	IMPLIED_END.set('li', tagSet('li p'));
	IMPLIED_END.set('dt', tagSet('dt dd p'));
	IMPLIED_END.set('dd', tagSet('dt dd p'));
	IMPLIED_END.set('tr', tagSet('tr td th p'));
	IMPLIED_END.set('td', tagSet('td th p'));
	IMPLIED_END.set('th', tagSet('td th p'));
	IMPLIED_END.set('thead', tagSet('tr td th p'));
	IMPLIED_END.set('tbody', tagSet('tr td th thead p'));
	IMPLIED_END.set('tfoot', tagSet('tr td th tbody thead p'));
	IMPLIED_END.set('option', tagSet('option'));
	IMPLIED_END.set('optgroup', tagSet('option optgroup'));
}

/* ── entities ─────────────────────────────────────────────────────────────── */

/**
 * Every named reference HTML 4 defines, plus `apos` and the upper-case legacy
 * spellings, as `name:hex` pairs.
 *
 * Not the HTML5 table — that is two thousand entries, most of them
 * mathematical, to serve pages that contain a dozen. What a scraped page
 * actually writes is Latin-1 (`&eacute;` in a French synopsis, `&ntilde;` in a
 * Spanish title), typographic punctuation, Greek and arrows, and that is all of
 * HTML 4. The first cut of this table held forty names, and every accented
 * letter outside it came back to a viewer as the literal `&eacute;`. A name
 * outside the table is left exactly as written rather than silently becoming
 * nothing, which is also what jsoup does with a name it does not know.
 */
const ENTITY_TABLE =
	'QUOT:22 quot:22 AMP:26 amp:26 apos:27 LT:3c lt:3c GT:3e gt:3e nbsp:a0 iexcl:a1 cent:a2 ' +
	'pound:a3 curren:a4 yen:a5 brvbar:a6 sect:a7 uml:a8 COPY:a9 copy:a9 ordf:aa laquo:ab ' +
	'not:ac shy:ad REG:ae reg:ae macr:af deg:b0 plusmn:b1 sup2:b2 sup3:b3 acute:b4 micro:b5 ' +
	'para:b6 middot:b7 cedil:b8 sup1:b9 ordm:ba raquo:bb frac14:bc frac12:bd frac34:be ' +
	'iquest:bf Agrave:c0 Aacute:c1 Acirc:c2 Atilde:c3 Auml:c4 Aring:c5 AElig:c6 Ccedil:c7 ' +
	'Egrave:c8 Eacute:c9 Ecirc:ca Euml:cb Igrave:cc Iacute:cd Icirc:ce Iuml:cf ETH:d0 ' +
	'Ntilde:d1 Ograve:d2 Oacute:d3 Ocirc:d4 Otilde:d5 Ouml:d6 times:d7 Oslash:d8 Ugrave:d9 ' +
	'Uacute:da Ucirc:db Uuml:dc Yacute:dd THORN:de szlig:df agrave:e0 aacute:e1 acirc:e2 ' +
	'atilde:e3 auml:e4 aring:e5 aelig:e6 ccedil:e7 egrave:e8 eacute:e9 ecirc:ea euml:eb ' +
	'igrave:ec iacute:ed icirc:ee iuml:ef eth:f0 ntilde:f1 ograve:f2 oacute:f3 ocirc:f4 ' +
	'otilde:f5 ouml:f6 divide:f7 oslash:f8 ugrave:f9 uacute:fa ucirc:fb uuml:fc yacute:fd ' +
	'thorn:fe yuml:ff OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2c6 ' +
	'tilde:2dc Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 ' +
	'Iota:399 Kappa:39a Lambda:39b Mu:39c Nu:39d Xi:39e Omicron:39f Pi:3a0 Rho:3a1 Sigma:3a3 ' +
	'Tau:3a4 Upsilon:3a5 Phi:3a6 Chi:3a7 Psi:3a8 Omega:3a9 alpha:3b1 beta:3b2 gamma:3b3 ' +
	'delta:3b4 epsilon:3b5 zeta:3b6 eta:3b7 theta:3b8 iota:3b9 kappa:3ba lambda:3bb mu:3bc ' +
	'nu:3bd xi:3be omicron:3bf pi:3c0 rho:3c1 sigmaf:3c2 sigma:3c3 tau:3c4 upsilon:3c5 ' +
	'phi:3c6 chi:3c7 psi:3c8 omega:3c9 thetasym:3d1 upsih:3d2 piv:3d6 ensp:2002 emsp:2003 ' +
	'thinsp:2009 zwnj:200c zwj:200d lrm:200e rlm:200f ndash:2013 mdash:2014 lsquo:2018 ' +
	'rsquo:2019 sbquo:201a ldquo:201c rdquo:201d bdquo:201e dagger:2020 Dagger:2021 bull:2022 ' +
	'hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203a oline:203e ' +
	'frasl:2044 euro:20ac image:2111 weierp:2118 real:211c trade:2122 alefsym:2135 larr:2190 ' +
	'uarr:2191 rarr:2192 darr:2193 harr:2194 crarr:21b5 lArr:21d0 uArr:21d1 rArr:21d2 ' +
	'dArr:21d3 hArr:21d4 forall:2200 part:2202 exist:2203 empty:2205 nabla:2207 isin:2208 ' +
	'notin:2209 ni:220b prod:220f sum:2211 minus:2212 lowast:2217 radic:221a prop:221d ' +
	'infin:221e ang:2220 and:2227 or:2228 cap:2229 cup:222a int:222b there4:2234 sim:223c ' +
	'cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 nsub:2284 ' +
	'sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22a5 sdot:22c5 lceil:2308 rceil:2309 ' +
	'lfloor:230a rfloor:230b lang:2329 rang:232a loz:25ca spades:2660 clubs:2663 hearts:2665 ' +
	'diams:2666';

/**
 * The legacy names, which HTML (and so jsoup) decodes even with no `;` after
 * them — `&copy 2020`, `&nbsp`. Every other name needs its semicolon.
 */
const LEGACY_ENTITIES = tagSet(
	'AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml ' +
		'GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG ' +
		'THORN Uacute Ucirc Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde ' +
		'auml brvbar ccedil cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 ' +
		'frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr micro middot nbsp ' +
		'not ntilde oacute ocirc ograve ordf ordm oslash otilde ouml para plusmn pound quot raquo ' +
		'reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc ugrave uml uuml yacute yen ' +
		'yuml'
);

const ENTITIES = new Map<string, string>();
for (const pair of ENTITY_TABLE.split(' ')) {
	const colon = pair.indexOf(':');
	ENTITIES.set(pair.slice(0, colon), String.fromCharCode(parseInt(pair.slice(colon + 1), 16)));
}

/**
 * What a numeric reference into the C1 range means, as every browser (and
 * jsoup) reads it: `&#150;` is an en dash, because the page was written in
 * windows-1252 by someone who never knew there was a difference.
 */
const WINDOWS_1252 = [
	0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152,
	0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122,
	0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178
];

function isAsciiLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
	return isAsciiDigit(code) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/**
 * jsoup's character-reference reader (`Tokeniser.consumeCharacterReference`),
 * which is what both its parser and `Parser.unescapeEntities` run.
 *
 * The rules that make it more than a table lookup, each of which changes a
 * value a scraper reads:
 *
 * - A name decodes without its `;` only if it is a legacy name; `&hellip`
 *   with no semicolon stays as written.
 * - **In an attribute**, a name followed by a letter, digit, `=`, `-` or `_`
 *   is not a reference at all. `href="?a=1&copy=2"` is a query string, and
 *   decoding it to `?a=1©=2` breaks the link — the old decoder here did.
 * - A number outside Unicode, or a surrogate, becomes U+FFFD; one in the C1
 *   range is read as windows-1252.
 * - `&` followed by anything else is just an ampersand.
 */
function unescape(value: string, inAttribute: boolean): string {
	if (value.indexOf('&') < 0) return value;
	let out = '';
	let index = 0;
	for (;;) {
		const amp = value.indexOf('&', index);
		if (amp < 0) break;
		out += value.slice(index, amp);
		const decoded = readReference(value, amp + 1, inAttribute);
		if (decoded === null) {
			out += '&';
			index = amp + 1;
		} else {
			out += decoded.text;
			index = decoded.end;
		}
	}
	return out + value.slice(index);
}

function readReference(
	value: string,
	start: number,
	inAttribute: boolean
): { text: string; end: number } | null {
	let cursor = start;
	if (value.charAt(cursor) === '#') {
		cursor++;
		const hex = value.charAt(cursor) === 'x' || value.charAt(cursor) === 'X';
		if (hex) cursor++;
		const digitsStart = cursor;
		while (
			cursor < value.length &&
			(hex ? isHexDigit(value.charCodeAt(cursor)) : isAsciiDigit(value.charCodeAt(cursor)))
		) {
			cursor++;
		}
		if (cursor === digitsStart) return null;
		const digits = value.slice(digitsStart, cursor);
		if (value.charAt(cursor) === ';') cursor++;
		// Anything past eight hex or ten decimal digits is out of range however
		// it parses, and parseInt would round it rather than say so.
		let code = digits.length > (hex ? 8 : 10) ? -1 : parseInt(digits, hex ? 16 : 10);
		if (code >= 0x80 && code < 0x80 + WINDOWS_1252.length) code = WINDOWS_1252[code - 0x80];
		const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
		return { text: valid ? String.fromCodePoint(code) : '\ufffd', end: cursor };
	}

	while (cursor < value.length && isAsciiLetter(value.charCodeAt(cursor))) cursor++;
	while (cursor < value.length && isAsciiDigit(value.charCodeAt(cursor))) cursor++;
	if (cursor === start) return null;
	const name = value.slice(start, cursor);
	const next = value.charAt(cursor);
	const text = ENTITIES.get(name);
	if (text === undefined) return null;
	if (next !== ';' && !LEGACY_ENTITIES.has(name)) return null;
	// A letter jsoup's reader would have kept consuming (it reads Unicode
	// letters, not only ASCII) means this was never the name it looked like.
	if (next !== '' && next.toLowerCase() !== next.toUpperCase()) return null;
	if (inAttribute && next !== ';' && /[0-9=_-]/.test(next)) return null;
	return { text, end: next === ';' ? cursor + 1 : cursor };
}

/** What text content decodes with: the rules outside an attribute. */
function decodeEntities(value: string): string {
	return unescape(value, false);
}

/**
 * jsoup's `Parser.unescapeEntities(string, inAttribute)` and
 * `Entities.unescape(string)`, which is the same call with `false`.
 */
export function unescapeEntities(value: string, inAttribute: boolean): string {
	return unescape(typeof value === 'string' ? value : String(value), inAttribute === true);
}

function escapeText(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/* ── url resolution ───────────────────────────────────────────────────────── */

const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
const URL_PARTS = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\/\/[^/?#]*)?([^?#]*)(\?[^#]*)?/;

/** RFC 3986 §5.2.4, so that `../` in a scraped href means what it says. */
function removeDotSegments(path: string): string {
	const segments = path.split('/');
	const out: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const last = i === segments.length - 1;
		if (segment === '.') {
			if (last) out.push('');
			continue;
		}
		if (segment === '..') {
			if (out.length > 1) out.pop();
			if (last) out.push('');
			continue;
		}
		out.push(segment);
	}
	return out.join('/');
}

/**
 * Resolves a possibly relative reference against a base url.
 *
 * Hand-rolled rather than `new URL(ref, base)` because `URL` is not a language
 * feature — QuickJS builds ship without it, and `abs:href` is the single most
 * used jsoup call in a scraper. Getting it wrong means every link is broken on
 * two of three engines.
 */
function resolveUrl(base: string, reference: string): string {
	if (reference === '') return '';
	if (ABSOLUTE_URL.test(reference)) return reference;

	const parts = URL_PARTS.exec(base);
	const scheme = parts === null ? undefined : parts[1];
	if (parts === null || scheme === undefined) return reference;
	const authority = parts[2] === undefined ? '' : parts[2];
	const basePath = parts[3] === undefined ? '' : parts[3];
	const baseQuery = parts[4] === undefined ? '' : parts[4];

	if (reference.slice(0, 2) === '//') return scheme + reference;
	if (reference.charAt(0) === '#') return scheme + authority + basePath + baseQuery + reference;
	if (reference.charAt(0) === '?') return scheme + authority + basePath + reference;

	const split = reference.search(/[?#]/);
	const refPath = split < 0 ? reference : reference.slice(0, split);
	const refRest = split < 0 ? '' : reference.slice(split);

	if (refPath.charAt(0) === '/') {
		return scheme + authority + removeDotSegments(refPath) + refRest;
	}

	const cut = basePath.lastIndexOf('/');
	const directory = cut < 0 ? '/' : basePath.slice(0, cut + 1);
	return scheme + authority + removeDotSegments(directory + refPath) + refRest;
}

/* ── the node tree ────────────────────────────────────────────────────────── */

interface Attribute {
	readonly name: string;
	readonly value: string;
}

/**
 * A leaf node. `data` is `<script>`/`<style>` content: it serialises, but it is
 * not text, and `text()` must not return a page's JavaScript.
 */
interface CharacterNode {
	readonly kind: 'text' | 'data' | 'comment';
	readonly value: string;
	/** Set when the node is inserted, so that moving it can detach it first. */
	parent?: ElementImpl | null;
}

type ChildNode = ElementImpl | CharacterNode;

/** Whitespace as jsoup's normaliser sees it — which includes `&nbsp;`. */
const TEXT_WHITESPACE = /[ \t\n\f\r\u00a0]+/g;

/** Builds a whitespace-normalised string the way jsoup's `text()` does. */
class TextAccumulator {
	private readonly parts: string[] = [];
	/** Starts true so that leading whitespace is dropped rather than trimmed. */
	private trailingSpace = true;

	/** A word boundary contributed by structure rather than by characters. */
	space(): void {
		if (this.parts.length > 0 && !this.trailingSpace) {
			this.parts.push(' ');
			this.trailingSpace = true;
		}
	}

	append(raw: string): void {
		let text = raw.replace(TEXT_WHITESPACE, ' ');
		if (this.trailingSpace && text.charAt(0) === ' ') text = text.slice(1);
		if (text === '') return;
		this.parts.push(text);
		this.trailingSpace = text.charAt(text.length - 1) === ' ';
	}

	value(): string {
		const joined = this.parts.join('');
		return this.trailingSpace && joined !== '' ? joined.slice(0, -1) : joined;
	}
}

class ElementImpl implements KElement {
	readonly kind = 'element' as const;
	readonly tagName: string;
	readonly children: ElementImpl[] = [];
	readonly nodes: ChildNode[] = [];
	readonly attrs: Attribute[] = [];
	parent: ElementImpl | null = null;
	/**
	 * Cached at insertion time, and recomputed by `reindex` whenever a
	 * mutation changes this element's parent's child list.
	 */
	siblingIndex = 0;
	document: DocumentImpl | null = null;
	/** `setBaseUri` on this element, which its descendants inherit. */
	baseOverride: string | null = null;
	private classList: string[] | null = null;

	constructor(tagName: string) {
		this.tagName = tagName;
	}

	appendChild(node: ChildNode): void {
		this.nodes.push(node);
		node.parent = this;
		if (node.kind === 'element') {
			node.document = this.document;
			node.siblingIndex = this.children.length;
			this.children.push(node);
		}
	}

	/* -- mutation -- */

	/*
	 * jsoup documents are mutable, and scrapers use that: `select("script,
	 * .ad").remove()` before reading a synopsis's `text()`, `select("br")
	 * .prepend("\\n")` before reading its `wholeText()`, a `<br>` replaced by
	 * a newline text node. Until these existed a `remove()` answered false and
	 * changed nothing, so the synopsis came back with the advert in it and
	 * nothing anywhere said so.
	 *
	 * Every structural change goes through `insertNodes` and `detach`, and both
	 * rebuild the element list and its sibling indexes from the node list
	 * rather than patching them: the selector engine's `:eq`, `+` and `~` read
	 * `siblingIndex`, and a stale one is a wrong match rather than an error.
	 */

	/** Rebuilds `children` and every child's `siblingIndex` from `nodes`. */
	private reindex(): void {
		this.children.length = 0;
		for (const node of this.nodes) {
			node.parent = this;
			if (node.kind === 'element') {
				node.siblingIndex = this.children.length;
				this.children.push(node);
			}
		}
	}

	/** Inserts at a node index, moving each node out of wherever it was first. */
	insertNodes(at: number, incoming: ChildNode[]): void {
		for (const node of incoming) detach(node);
		// Detaching may have shortened this list, if a node came from here.
		const index = Math.max(0, Math.min(at, this.nodes.length));
		this.nodes.splice(index, 0, ...incoming);
		for (const node of incoming) {
			if (node.kind === 'element') adopt(node, this.document);
		}
		this.reindex();
	}

	/** Removes one child node; the caller has already checked it is one. */
	removeNode(node: ChildNode): void {
		const at = this.nodes.indexOf(node);
		if (at < 0) return;
		this.nodes.splice(at, 1);
		node.parent = null;
		if (node.kind === 'element') node.siblingIndex = 0;
		this.reindex();
	}

	/** jsoup's `remove()`: out of the tree. Removing a detached node is a no-op. */
	remove(): void {
		detach(this);
	}

	/**
	 * jsoup's `replaceWith(node)`. The replacement is moved, not copied, which is
	 * jsoup's rule and what `a.replaceWith(TextNode(...))` relies on.
	 */
	replaceWith(replacement: KNode): void {
		const parent = this.parent;
		if (parent === null) throw new Error('replaceWith() was called on an element with no parent.');
		const node = toChildNode(replacement);
		parent.insertNodes(parent.nodes.indexOf(this), [node]);
		detach(this);
	}

	/** jsoup's `before(html)` / `before(node)`: siblings, parsed in the parent's context. */
	before(content: string | KNode): KElement {
		this.insertSibling(content, 0);
		return this;
	}

	after(content: string | KNode): KElement {
		this.insertSibling(content, 1);
		return this;
	}

	private insertSibling(content: string | KNode, offset: number): void {
		const parent = this.parent;
		if (parent === null)
			throw new Error('before()/after() was called on an element with no parent.');
		const incoming =
			typeof content === 'string' ? parseFragment(content, parent) : [toChildNode(content)];
		parent.insertNodes(parent.nodes.indexOf(this) + offset, incoming);
	}

	/** jsoup's `append(html)`: parsed in this element's context, added at the end. */
	append(html: string): KElement {
		this.insertNodes(this.nodes.length, parseFragment(String(html), this));
		return this;
	}

	prepend(html: string): KElement {
		this.insertNodes(0, parseFragment(String(html), this));
		return this;
	}

	/** A text node, never markup: `appendText("<b>")` is the characters. */
	appendText(text: string): KElement {
		this.insertNodes(this.nodes.length, [{ kind: 'text', value: String(text) }]);
		return this;
	}

	prependText(text: string): KElement {
		this.insertNodes(0, [{ kind: 'text', value: String(text) }]);
		return this;
	}

	/** jsoup answers the NEW element from these two, not this one. */
	appendElement(tagName: string): KElement {
		const child = new ElementImpl(String(tagName).toLowerCase());
		this.insertNodes(this.nodes.length, [child]);
		return child;
	}

	prependElement(tagName: string): KElement {
		const child = new ElementImpl(String(tagName).toLowerCase());
		this.insertNodes(0, [child]);
		return child;
	}

	/* -- attributes -- */

	/**
	 * jsoup's `attr(name)`, and with a value its `attr(name, value)`, which sets
	 * the attribute and answers the element — `img.attr("src", url)
	 * .attr("abs:src")` is written in this catalogue. Before the setter existed
	 * that call read the attribute instead, answered a string, and the chained
	 * read got nothing.
	 */
	attr(name: string): string;
	attr(name: string, value: string): KElement;
	attr(name: string, value?: string): string | KElement {
		const key = name.toLowerCase();
		if (value !== undefined) {
			this.setAttr(key, String(value));
			return this;
		}
		if (key.length > 4 && key.slice(0, 4) === 'abs:') {
			const raw = this.attr(key.slice(4));
			if (raw === '') return '';
			return resolveUrl(this.baseUri(), raw.trim());
		}
		for (const attribute of this.attrs) {
			if (attribute.name === key) return attribute.value;
		}
		return '';
	}

	private setAttr(key: string, value: string): void {
		const at = this.attrs.findIndex((attribute) => attribute.name === key);
		if (at >= 0) this.attrs[at] = { name: key, value };
		else this.attrs.push({ name: key, value });
		if (key === 'class') this.classList = null;
	}

	/**
	 * jsoup's `attributes()`: every attribute as a `key`/`value` pair, in
	 * document order. Read-only copies — writing goes through `attr`.
	 */
	attributes(): { key: string; value: string }[] {
		return this.attrs.map((attribute) => ({ key: attribute.name, value: attribute.value }));
	}

	/**
	 * jsoup's `dataset()`: the `data-*` attributes with the prefix taken off,
	 * as a map, which is how `body().dataset()["manga-id"]` reads.
	 */
	dataset(): Map<string, string> {
		const out = new Map<string, string>();
		for (const attribute of this.attrs) {
			if (attribute.name.length > 5 && attribute.name.slice(0, 5) === 'data-') {
				out.set(attribute.name.slice(5), attribute.value);
			}
		}
		return out;
	}

	hasAttr(name: string): boolean {
		const key = name.toLowerCase();
		if (key.length > 4 && key.slice(0, 4) === 'abs:') return this.attr(key) !== '';
		for (const attribute of this.attrs) {
			if (attribute.name === key) return true;
		}
		return false;
	}

	get className(): string {
		return this.attr('class').trim();
	}

	get id(): string {
		return this.attr('id');
	}

	/** Lower-cased because jsoup's `hasClass` ignores case, and so must `.foo`. */
	classes(): string[] {
		if (this.classList === null) {
			const raw = this.attr('class').trim().toLowerCase();
			this.classList = raw === '' ? [] : raw.split(/[ \t\n\f\r]+/);
		}
		return this.classList;
	}

	/* -- traversal -- */

	/** Internally typed; the two ABI methods below only widen the return. */
	nextElement(): ElementImpl | null {
		if (this.parent === null) return null;
		const sibling = this.parent.children[this.siblingIndex + 1];
		return sibling === undefined ? null : sibling;
	}

	previousElement(): ElementImpl | null {
		if (this.parent === null || this.siblingIndex === 0) return null;
		const sibling = this.parent.children[this.siblingIndex - 1];
		return sibling === undefined ? null : sibling;
	}

	nextElementSibling(): KElement | null {
		return this.nextElement();
	}

	previousElementSibling(): KElement | null {
		return this.previousElement();
	}

	/**
	 * jsoup's `child(index)`, which throws past the end rather than answering
	 * null — the Kotlin that calls it has no null check to fall back on.
	 */
	child(index: number): KElement {
		const found = this.children[index];
		if (found === undefined) {
			throw new Error(
				'This converted extension read child ' +
					index +
					' of an element with ' +
					this.children.length +
					'.'
			);
		}
		return found;
	}

	/** This element's index among its parent's elements, as jsoup counts it. */
	elementSiblingIndex(): number {
		return this.parent === null ? 0 : this.siblingIndex;
	}

	/**
	 * jsoup's `parents()`: nearest first, up to and including `<html>` but not
	 * the document itself, which jsoup does not count as an element's parent.
	 */
	parents(): KElement[] {
		const out: ElementImpl[] = [];
		let current = this.parent;
		while (current !== null && current.tagName !== '#root') {
			out.push(current);
			current = current.parent;
		}
		return out;
	}

	/** Every following element sibling, in document order. */
	nextElementSiblings(): KElement[] {
		if (this.parent === null) return [];
		return this.parent.children.slice(this.siblingIndex + 1);
	}

	/**
	 * Every preceding element sibling, NEAREST FIRST — jsoup walks backwards
	 * from this element, so the list is in reverse document order.
	 */
	previousElementSiblings(): KElement[] {
		if (this.parent === null) return [];
		return this.parent.children.slice(0, this.siblingIndex).reverse();
	}

	/** jsoup's `childNodes()`: elements and text alike, in order. */
	childNodes(): KNode[] {
		const out: KNode[] = [];
		for (const node of this.nodes) {
			const wrapped = wrapNode(node);
			if (wrapped !== null) out.push(wrapped);
		}
		return out;
	}

	/** The tag name as jsoup's `nodeName()` and `normalName()` both give it here. */
	nodeName(): string {
		return this.tagName;
	}

	normalName(): string {
		return this.tagName;
	}

	/**
	 * jsoup's `is(query)`: whether this element matches, evaluated against the
	 * whole tree it sits in, so a combinator can look above it.
	 */
	is(query: string | Query): boolean {
		let root: ElementImpl = this;
		while (root.parent !== null) root = root.parent;
		return matchesList(root, this, parseSelector(query));
	}

	/**
	 * jsoup's `hasText()`: some descendant text node is not blank. A script
	 * body is data, not text, and does not count.
	 */
	hasText(): boolean {
		for (const node of this.nodes) {
			// jsoup's `isBlank` is ASCII whitespace only: a text node that is
			// just `&nbsp;` HAS text, which is the opposite of what `text()`
			// normalisation would suggest.
			if (node.kind === 'text' && /[^ \t\n\f\r]/.test(node.value)) return true;
			if (node.kind === 'element' && node.hasText()) return true;
		}
		return false;
	}

	/* -- node-level siblings, which include text -- */

	/** This element's place among its parent's child *nodes*, or -1. */
	private nodeIndex(): number {
		if (this.parent === null) return -1;
		return this.parent.nodes.indexOf(this);
	}

	previousSibling(): KNode | null {
		const at = this.nodeIndex();
		if (at <= 0 || this.parent === null) return null;
		return wrapNode(this.parent.nodes[at - 1]);
	}

	nextSibling(): KNode | null {
		const at = this.nodeIndex();
		if (at === -1 || this.parent === null) return null;
		const node = this.parent.nodes[at + 1];
		return node === undefined ? null : wrapNode(node);
	}

	textNodes(): KTextNode[] {
		const out: KTextNode[] = [];
		for (const node of this.nodes) {
			if (node.kind === 'text') out.push(new TextNodeImpl(node));
		}
		return out;
	}

	/**
	 * Every descendant's text with the whitespace as written.
	 *
	 * `text()` normalises — runs of whitespace collapse and the ends are
	 * trimmed — which is right for a title and wrong for a synopsis whose
	 * paragraphs are newlines. jsoup has both, and so must this.
	 */
	wholeText(): string {
		const parts: string[] = [];
		collectWholeText(this, parts);
		return parts.join('');
	}

	/* -- lookups jsoup answers without a selector -- */

	getElementById(id: string): KElement | null {
		const wanted = String(id);
		let found: ElementImpl | null = null;
		const walk = (element: ElementImpl): void => {
			if (found !== null) return;
			for (const child of element.children) {
				if (found !== null) return;
				if (child.attr('id') === wanted) {
					found = child;
					return;
				}
				walk(child);
			}
		};
		if (this.attr('id') === wanted && this.tagName !== '#root') return this;
		walk(this);
		return found;
	}

	/**
	 * Every element with this tag name, this one included — jsoup collects from
	 * the element it is asked of, not from below it.
	 */
	getElementsByTag(tag: string): KElement[] {
		const wanted = String(tag).toLowerCase();
		return this.collect((element) => wanted === '*' || element.tagName === wanted);
	}

	/** jsoup's `getElementsByClass`: case-insensitive, this element included. */
	getElementsByClass(name: string): KElement[] {
		const wanted = String(name).trim().toLowerCase();
		return this.collect((element) => element.classes().indexOf(wanted) >= 0);
	}

	private collect(test: (element: ElementImpl) => boolean): ElementImpl[] {
		const out: ElementImpl[] = [];
		const walk = (element: ElementImpl): void => {
			if (test(element)) out.push(element);
			for (const child of element.children) walk(child);
		};
		walk(this);
		return out;
	}

	/** Lower-cased on both sides, because jsoup's `hasClass` ignores case. */
	hasClass(name: string): boolean {
		return this.classes().indexOf(String(name).trim().toLowerCase()) >= 0;
	}

	classNames(): string[] {
		const raw = this.attr('class').trim();
		return raw === '' ? [] : raw.split(/[ \t\n\f\r]+/);
	}

	/**
	 * A detached deep copy.
	 *
	 * Detached on purpose: jsoup's `clone()` has no parent, and an extension
	 * clones a node precisely so it can strip children out of the copy without
	 * the page it came from losing them.
	 */
	clone(): KElement {
		const copy = new ElementImpl(this.tagName);
		copy.document = this.document;
		for (const attribute of this.attrs) {
			copy.attrs.push({ name: attribute.name, value: attribute.value });
		}
		for (const node of this.nodes) {
			copy.appendChild(node.kind === 'element' ? (node.clone() as ElementImpl) : { ...node });
		}
		return copy;
	}

	/** The nearest `setBaseUri` at or above this element, else the document's. */
	baseUri(): string {
		let current: ElementImpl | null = this;
		while (current !== null) {
			if (current.baseOverride !== null) return current.baseOverride;
			current = current.parent;
		}
		return this.document === null ? '' : this.document.baseUrl;
	}

	/**
	 * jsoup's `setBaseUri`: what `abs:` resolves against from here down. On a
	 * document it is the document's base url, which is where every extension
	 * in the catalogue calls it — a page fetched from one host whose links are
	 * meant to resolve against another.
	 */
	setBaseUri(uri: string): void {
		this.baseOverride = String(uri);
	}

	/**
	 * jsoup's unique path to this element.
	 *
	 * What it is used for is `distinctBy { it.cssSelector() }` — telling two
	 * elements apart after a `select` that overlapped — so the property that
	 * matters is that it is unique, and the shape is jsoup's: an `#id` where
	 * there is one, otherwise the parent's path and this element's position.
	 */
	cssSelector(): string {
		if (this.id !== '') return `#${this.id}`;
		if (this.parent === null) return this.tagName;
		return `${this.parent.cssSelector()} > ${this.tagName}:nth-child(${this.siblingIndex + 1})`;
	}

	/**
	 * jsoup's ownerDocument(), which is how a scraper gets the base url back.
	 *
	 * The pattern it exists for is 'element.ownerDocument()!!.location()' —
	 * an element deep in a page needing the url the page came from, which
	 * nothing on the element itself carries. A document owns itself, as it does
	 * in jsoup, so the call is safe on either.
	 */
	ownerDocument(): KDocument | null {
		return this.document;
	}

	/* -- text -- */

	text(): string {
		const accumulator = new TextAccumulator();
		collectText(this, accumulator);
		return accumulator.value();
	}

	ownText(): string {
		const accumulator = new TextAccumulator();
		for (const node of this.nodes) {
			if (node.kind === 'text') accumulator.append(node.value);
			else if (node.kind === 'element' && node.tagName === 'br') accumulator.space();
		}
		return accumulator.value();
	}

	/**
	 * jsoup's `data()`: the content of `<script>` and `<style>`, plus comments.
	 *
	 * The single most-reached-for method in this ecosystem after `attr`, and the
	 * one `text()` cannot stand in for — a `<script>` body is a data node, and
	 * `collectText` walks past data nodes on purpose. `doc.selectFirst("script:
	 * containsData(sources)")!!.data()` is how a page's stream list is read, so
	 * the selector and this are the same feature arriving from two directions.
	 *
	 * Recursive over child elements, as jsoup is, and unescaped: a data node's
	 * text is script source, and `&amp;` in it was never an entity.
	 */
	data(): string {
		const parts: string[] = [];
		collectData(this, parts);
		return parts.join('');
	}

	/**
	 * jsoup's `absUrl(name)`, which is `attr("abs:" + name)` written the other way.
	 *
	 * Both spellings are in the catalogue and they mean the same thing, so this
	 * is deliberately one line over the other rather than a second resolver.
	 */
	absUrl(name: string): string {
		return this.attr('abs:' + name);
	}

	/**
	 * jsoup's `val()`: what a form control would submit.
	 *
	 * A `<textarea>`'s value is its text content and everything else's is the
	 * `value` attribute — jsoup's own rule, and the reason this is not simply
	 * `attr("value")`.
	 */
	val(): string {
		return this.tagName === 'textarea' ? this.text() : this.attr('value');
	}

	/* -- serialisation -- */

	html(): string {
		const parts: string[] = [];
		for (const node of this.nodes) serialise(node, parts);
		return parts.join('');
	}

	outerHtml(): string {
		// A document has no tag of its own to write.
		if (this.tagName === '#root') return this.html();
		const parts: string[] = [];
		serialise(this, parts);
		return parts.join('');
	}

	/* -- selectors -- */

	select(selector: string | Query): KElement[] {
		const list = parseSelector(selector);
		const found: ElementImpl[] = [];
		collectMatches(this, this, list, found);
		return found;
	}

	selectFirst(selector: string | Query): KElement | null {
		return firstMatch(this, this, parseSelector(selector));
	}

	/**
	 * jsoup's `closest()`, which is the only selector call that walks *up*.
	 *
	 * `select` and `selectFirst` search descendants, so a scraper that has an
	 * inner `<a>` and wants the card around it has no way back without this.
	 * Self first, then each ancestor, exactly as jsoup and the browser DOM do —
	 * starting at the parent instead would silently skip an element that
	 * already matches, which is the common case for `a.closest("a[href]")`.
	 *
	 * The match is evaluated with the document as the scope, so a descendant
	 * combinator in the selector can look above the candidate.
	 */
	closest(selector: string): KElement | null {
		const list = parseSelector(selector);
		const scope: ElementImpl = this.document ?? this;
		if (matchesList(scope, this, list)) return this;
		let current = this.parent;
		while (current !== null) {
			if (matchesList(scope, current, list)) return current;
			current = current.parent;
		}
		return null;
	}
}

class DocumentImpl extends ElementImpl implements KDocument {
	baseUrl: string;

	constructor(baseUrl: string) {
		super('#root');
		this.baseUrl = baseUrl;
		this.document = this;
	}

	setBaseUri(uri: string): void {
		this.baseUrl = String(uri);
	}

	/**
	 * jsoup's `head()` and `body()`. The parser always synthesises both, so
	 * neither is ever null here — as in jsoup, which creates them too.
	 */
	head(): KElement {
		return this.structural('head');
	}

	body(): KElement {
		return this.structural('body');
	}

	private structural(tagName: string): ElementImpl {
		const html = this.children.find((child) => child.tagName === 'html');
		const found = html?.children.find((child) => child.tagName === tagName);
		if (found !== undefined) return found;
		// Only reachable after an extension removed it; jsoup puts one back.
		const root = html ?? this;
		const made = new ElementImpl(tagName);
		root.insertNodes(tagName === 'head' ? 0 : root.nodes.length, [made]);
		return made;
	}

	/**
	 * jsoup's `createElement(tag)`: a new element belonging to this document but
	 * not yet in it, so its `abs:` reads resolve against this document's url
	 * the moment it is given an `href`.
	 */
	createElement(tagName: string): KElement {
		const element = new ElementImpl(String(tagName).toLowerCase());
		element.document = this;
		return element;
	}

	title(): string {
		const element = this.selectFirst('title');
		return element === null ? '' : element.text();
	}

	/** jsoup's name for the base url — the same string `abs:` resolves against. */
	location(): string {
		return this.baseUrl;
	}
}

/**
 * A character node, as jsoup's `TextNode`, `DataNode` and `Comment` present one.
 *
 * A view over the tree's own node rather than a copy, so that handing one to
 * `replaceWith` or `before` moves the node itself, as jsoup does.
 */
class TextNodeImpl implements KTextNode {
	readonly raw: CharacterNode;

	constructor(raw: CharacterNode) {
		this.raw = raw;
	}

	get kind(): 'text' | 'data' | 'comment' {
		return this.raw.kind;
	}

	/**
	 * jsoup's `TextNode.text()`, which collapses each run of whitespace to one
	 * space and does NOT trim — `wholeText` is the unnormalised one.
	 */
	text(): string {
		return this.raw.kind === 'text' ? this.raw.value.replace(TEXT_WHITESPACE, ' ') : this.raw.value;
	}

	/** `TextNode.getWholeText()`, which Kotlin reads as the property `wholeText`. */
	get wholeText(): string {
		return this.raw.value;
	}

	getWholeText(): string {
		return this.raw.value;
	}

	/** ASCII whitespace only, as jsoup's `StringUtil.isBlank` has it. */
	isBlank(): boolean {
		return !/[^ \t\n\f\r]/.test(this.raw.value);
	}

	nodeName(): string {
		return this.raw.kind === 'text' ? '#text' : this.raw.kind === 'data' ? '#data' : '#comment';
	}

	/** Read as a property: `HOST_PROPERTY_METHODS` drops the call parentheses. */
	get parent(): KElement | null {
		return this.raw.parent ?? null;
	}

	remove(): void {
		detach(this.raw);
	}

	toString(): string {
		const node = this.raw;
		return node.kind === 'comment'
			? `<!--${node.value}-->`
			: node.kind === 'data'
				? node.value
				: escapeText(node.value);
	}

	outerHtml(): string {
		return this.toString();
	}
}

/**
 * jsoup's `TextNode(text)`: the characters as given, never parsed as markup
 * and never entity-decoded — `TextNode("&amp;")` serialises as `&amp;amp;`.
 */
export function createTextNode(text: string): KTextNode {
	return new TextNodeImpl({ kind: 'text', value: String(text) });
}

/** Either half of a child-node list, as the ABI hands it back. */
function wrapNode(node: ChildNode | undefined): KNode | null {
	if (node === undefined) return null;
	return node.kind === 'element' ? node : new TextNodeImpl(node);
}

/** What a node handed to a mutation is, underneath the view the ABI gave out. */
function toChildNode(node: KNode): ChildNode {
	if (node instanceof ElementImpl) return node;
	if (node instanceof TextNodeImpl) return node.raw;
	throw new Error('This converted extension inserted something that is not a jsoup node.');
}

/** Out of whatever it is in, if anything. */
function detach(node: ChildNode): void {
	const parent = node.parent;
	if (parent !== null && parent !== undefined) parent.removeNode(node);
}

/** An element and everything below it now belong to this document. */
function adopt(element: ElementImpl, document: DocumentImpl | null): void {
	element.document = document;
	for (const child of element.children) adopt(child, document);
}

/**
 * Markup parsed the way jsoup's `append`, `prepend`, `before` and `after` parse
 * it: as a fragment in the context of the element it lands in.
 *
 * The context matters in exactly the way a scraper meets it: text going into a
 * `<script>` is script source, not markup (`head().prependElement("script")
 * .append(js)`), and into a `<title>` or `<textarea>` it is text with entities
 * decoded. Anywhere else it is body content — no `<head>` to fall into, so a
 * leading `<script>` stays where it was put.
 */
function parseFragment(html: string, context: ElementImpl): ChildNode[] {
	if (RAW_TEXT_TAGS.has(context.tagName)) return html === '' ? [] : [{ kind: 'data', value: html }];
	if (RCDATA_TAGS.has(context.tagName)) {
		return html === '' ? [] : [{ kind: 'text', value: decodeEntities(html) }];
	}
	const holder = new HtmlParser(html, '', true).parseFragment();
	const nodes = holder.nodes.slice();
	for (const node of nodes) holder.removeNode(node);
	return nodes;
}

/** `wholeText()`: the text as written, with no whitespace normalisation. */
function collectWholeText(element: ElementImpl, parts: string[]): void {
	for (const node of element.nodes) {
		if (node.kind === 'text') parts.push(node.value);
		else if (node.kind === 'element') collectWholeText(node, parts);
	}
}

function collectText(element: ElementImpl, accumulator: TextAccumulator): void {
	for (const node of element.nodes) {
		if (node.kind === 'text') {
			accumulator.append(node.value);
		} else if (node.kind === 'element') {
			if (BLOCK_TAGS.has(node.tagName) || node.tagName === 'br') accumulator.space();
			collectText(node, accumulator);
		}
	}
}

/** jsoup's `Element.data()`, which reads data and comment nodes and no text. */
function collectData(element: ElementImpl, parts: string[]): void {
	for (const node of element.nodes) {
		if (node.kind === 'data' || node.kind === 'comment') parts.push(node.value);
		else if (node.kind === 'element') collectData(node, parts);
	}
}

function serialise(node: ChildNode, parts: string[]): void {
	if (node.kind !== 'element') {
		if (node.kind === 'text') parts.push(escapeText(node.value));
		else if (node.kind === 'data') parts.push(node.value);
		else parts.push('<!--' + node.value + '-->');
		return;
	}

	parts.push('<' + node.tagName);
	for (const attribute of node.attrs) {
		parts.push(' ' + attribute.name);
		// A valueless attribute goes back out valueless; `checked=""` is not what
		// was written and not what a regex over the result expects to find.
		if (attribute.value !== '') parts.push('="' + escapeAttribute(attribute.value) + '"');
	}
	parts.push('>');
	// A void element has no end tag — unless a mutation gave it children
	// (`select("br").prepend(…)`), which jsoup then writes out with one.
	if (VOID_TAGS.has(node.tagName) && node.nodes.length === 0) return;
	for (const child of node.nodes) serialise(child, parts);
	parts.push('</' + node.tagName + '>');
}

/* ── the html parser ──────────────────────────────────────────────────────── */

function isSpace(character: string): boolean {
	return (
		character === ' ' ||
		character === '\t' ||
		character === '\n' ||
		character === '\f' ||
		character === '\r'
	);
}

function isAsciiAlpha(character: string): boolean {
	return (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
}

function isTagNameChar(character: string): boolean {
	return (
		isAsciiAlpha(character) ||
		(character >= '0' && character <= '9') ||
		character === '-' ||
		character === '_' ||
		character === ':' ||
		character === '.'
	);
}

/**
 * Finds the end tag that terminates a raw-text element.
 *
 * `indexOf('</script')` would be wrong on the first `</scriptish>` and on
 * `</SCRIPT>`, so the match is case-insensitive and the character after the name
 * has to be a plausible tag terminator.
 */
function findRawTextEnd(input: string, from: number, name: string): number {
	let index = from;
	while (index < input.length) {
		const open = input.indexOf('<', index);
		if (open < 0) return -1;
		if (input.charAt(open + 1) === '/') {
			const start = open + 2;
			if (input.slice(start, start + name.length).toLowerCase() === name) {
				const after = input.charAt(start + name.length);
				if (after === '' || after === '>' || after === '/' || isSpace(after)) return open;
			}
		}
		index = open + 1;
	}
	return -1;
}

/**
 * A tolerant tokeniser and tree builder in one pass.
 *
 * `html`, `head` and `body` are created up front and reused if the document
 * turns out to declare them, which is what lets a bare fragment — the usual case
 * for a scraper parsing an AJAX response — and a whole page produce the same
 * shape. The stack never pops below the third entry, so no amount of stray end
 * tags can unroot the document.
 */
class HtmlParser {
	private readonly input: string;
	private position = 0;
	private readonly doc: DocumentImpl;
	private readonly htmlElement: ElementImpl;
	private readonly headElement: ElementImpl;
	private readonly bodyElement: ElementImpl;
	private stack: ElementImpl[];
	private inHead = true;
	/**
	 * How many stack entries are structural and never popped: the document,
	 * `<html>` and `<head>`/`<body>` for a document, only the holder for a
	 * fragment.
	 */
	private readonly floor: number;
	private readonly fragment: boolean;

	constructor(input: string, baseUrl: string, fragment = false) {
		this.input = input;
		this.fragment = fragment;
		this.doc = new DocumentImpl(baseUrl);
		this.htmlElement = new ElementImpl('html');
		this.headElement = new ElementImpl('head');
		this.bodyElement = new ElementImpl('body');
		if (fragment) {
			// A fragment is body content held by a bare element: no document
			// structure is synthesised, and nothing can move it into a <head>.
			this.inHead = false;
			this.floor = 1;
			this.stack = [this.bodyElement];
			return;
		}
		this.floor = 3;
		this.doc.appendChild(this.htmlElement);
		this.htmlElement.appendChild(this.headElement);
		this.htmlElement.appendChild(this.bodyElement);
		this.stack = [this.doc, this.htmlElement, this.headElement];
	}

	/** Parses as a fragment and answers the element holding the result. */
	parseFragment(): ElementImpl {
		this.parse();
		return this.bodyElement;
	}

	parse(): DocumentImpl {
		const input = this.input;
		while (this.position < input.length) {
			const open = input.indexOf('<', this.position);
			if (open < 0) {
				this.appendText(input.slice(this.position));
				break;
			}
			if (open > this.position) this.appendText(input.slice(this.position, open));
			this.position = open;
			if (!this.markup()) {
				// A `<` that starts nothing is just a `<`.
				this.appendText('<');
				this.position = open + 1;
			}
		}
		return this.doc;
	}

	private top(): ElementImpl {
		return this.stack[this.stack.length - 1];
	}

	private skipPast(marker: string): void {
		const at = this.input.indexOf(marker, this.position);
		this.position = at < 0 ? this.input.length : at + marker.length;
	}

	private switchToBody(): void {
		if (!this.inHead || this.fragment) return;
		this.inHead = false;
		this.stack = [this.doc, this.htmlElement, this.bodyElement];
	}

	private appendText(raw: string): void {
		if (this.inHead) {
			// Whitespace between head elements belongs to nobody.
			if (raw.trim() === '') return;
			this.switchToBody();
		}
		this.top().appendChild({ kind: 'text', value: decodeEntities(raw) });
	}

	/** Returns false when the `<` at the cursor does not begin markup. */
	private markup(): boolean {
		const input = this.input;
		const next = input.charAt(this.position + 1);

		if (next === '!') {
			if (input.slice(this.position + 2, this.position + 4) === '--') {
				const end = input.indexOf('-->', this.position + 4);
				const stop = end < 0 ? input.length : end;
				this.top().appendChild({
					kind: 'comment',
					value: input.slice(this.position + 4, stop)
				});
				this.position = end < 0 ? input.length : end + 3;
			} else {
				// A doctype, or something pretending to be one.
				this.skipPast('>');
			}
			return true;
		}
		if (next === '?') {
			this.skipPast('>');
			return true;
		}
		if (next === '/') {
			const start = this.position + 2;
			let index = start;
			while (index < input.length && isTagNameChar(input.charAt(index))) index++;
			this.skipPast('>');
			if (index > start) this.closeTag(input.slice(start, index).toLowerCase());
			return true;
		}
		if (isAsciiAlpha(next)) {
			this.startTag();
			return true;
		}
		return false;
	}

	private startTag(): void {
		const input = this.input;
		let index = this.position + 1;
		const nameStart = index;
		while (index < input.length && isTagNameChar(input.charAt(index))) index++;
		const name = input.slice(nameStart, index).toLowerCase();

		const attributes: Attribute[] = [];
		let selfClosing = false;

		for (;;) {
			while (index < input.length && isSpace(input.charAt(index))) index++;
			const character = input.charAt(index);
			if (character === '') break;
			if (character === '>') {
				index++;
				break;
			}
			if (character === '/') {
				index++;
				if (input.charAt(index) === '>') {
					selfClosing = true;
					index++;
					break;
				}
				continue;
			}

			const attributeStart = index;
			while (index < input.length) {
				const c = input.charAt(index);
				if (isSpace(c) || c === '=' || c === '>' || c === '/') break;
				index++;
			}
			if (index === attributeStart) {
				// Nothing consumable here; step over it rather than spin.
				index++;
				continue;
			}
			const attributeName = input.slice(attributeStart, index).toLowerCase();

			let value = '';
			let cursor = index;
			while (cursor < input.length && isSpace(input.charAt(cursor))) cursor++;
			if (input.charAt(cursor) === '=') {
				cursor++;
				while (cursor < input.length && isSpace(input.charAt(cursor))) cursor++;
				const quote = input.charAt(cursor);
				if (quote === '"' || quote === "'") {
					cursor++;
					const close = input.indexOf(quote, cursor);
					const stop = close < 0 ? input.length : close;
					value = input.slice(cursor, stop);
					cursor = close < 0 ? input.length : close + 1;
				} else {
					const valueStart = cursor;
					while (cursor < input.length) {
						const c = input.charAt(cursor);
						if (isSpace(c) || c === '>') break;
						cursor++;
					}
					value = input.slice(valueStart, cursor);
				}
				index = cursor;
			}

			// First declaration wins, which is what every HTML parser does with a
			// duplicated attribute.
			let seen = false;
			for (const existing of attributes) {
				if (existing.name === attributeName) seen = true;
			}
			if (!seen) attributes.push({ name: attributeName, value: unescape(value, true) });
		}

		this.position = index;
		this.openTag(name, attributes, selfClosing);
	}

	private openTag(name: string, attributes: Attribute[], selfClosing: boolean): void {
		// In a fragment the document's own tags have nothing to stand for, and
		// jsoup's fragment parser drops them the same way.
		if (this.fragment && (name === 'html' || name === 'head' || name === 'body')) return;
		if (name === 'html') {
			this.mergeAttributes(this.htmlElement, attributes);
			return;
		}
		if (name === 'head') {
			this.mergeAttributes(this.headElement, attributes);
			this.stack = [this.doc, this.htmlElement, this.headElement];
			this.inHead = true;
			return;
		}
		if (name === 'body') {
			this.mergeAttributes(this.bodyElement, attributes);
			this.switchToBody();
			return;
		}
		if (this.inHead && !HEAD_TAGS.has(name)) this.switchToBody();

		const closes = IMPLIED_END.get(name);
		if (closes !== undefined) {
			while (this.stack.length > this.floor && closes.has(this.top().tagName)) this.stack.pop();
		}

		const element = new ElementImpl(name);
		for (const attribute of attributes) element.attrs.push(attribute);
		this.top().appendChild(element);

		// `<div/>` is honoured rather than ignored as HTML5 says. XHTML-flavoured
		// markup is common in the wild, and reading a self-closed tag as an open
		// one nests the entire rest of the document inside it.
		if (selfClosing || VOID_TAGS.has(name)) return;

		this.stack.push(element);
		const raw = RAW_TEXT_TAGS.has(name);
		if (raw || RCDATA_TAGS.has(name)) this.rawText(name, raw);
	}

	private rawText(name: string, isData: boolean): void {
		const end = findRawTextEnd(this.input, this.position, name);
		const stop = end < 0 ? this.input.length : end;
		const value = this.input.slice(this.position, stop);
		if (value !== '') {
			this.top().appendChild({
				kind: isData ? 'data' : 'text',
				value: isData ? value : decodeEntities(value)
			});
		}
		this.position = stop;
		this.stack.pop();
		if (end >= 0) this.skipPast('>');
	}

	private closeTag(name: string): void {
		if (this.fragment && (name === 'html' || name === 'head' || name === 'body')) return;
		if (name === 'head') {
			this.switchToBody();
			return;
		}
		// Content after `</body>` is still content, so these two never pop.
		if (name === 'body' || name === 'html') return;

		for (let index = this.stack.length - 1; index >= this.floor; index--) {
			if (this.stack[index].tagName === name) {
				this.stack.length = index;
				return;
			}
		}
		// A stray end tag for something that was never open. Ignored, which is what
		// a browser does with the truncated templates these pages ship.
	}

	private mergeAttributes(element: ElementImpl, attributes: Attribute[]): void {
		for (const attribute of attributes) {
			if (!element.hasAttr(attribute.name)) element.attrs.push(attribute);
		}
	}
}

/**
 * Parses a document. Never throws: malformed input still produces a tree.
 *
 * `baseUrl` is what `attr('abs:href')` resolves against. Left empty, `abs:`
 * returns the raw value rather than a wrong absolute one.
 */
export function parseHtml(html: string, baseUrl = ''): KDocument {
	// Typed as a string, but reached from converted JavaScript that may not have
	// one. A missing body should yield an empty document, not a stack trace.
	return new HtmlParser(typeof html === 'string' ? html : '', baseUrl).parse();
}

/* ── selectors: the grammar ───────────────────────────────────────────────── */

type Combinator = ' ' | '>' | '+' | '~';

type AttributeOperator = 'exists' | '=' | '^=' | '$=' | '*=' | '~=';

type Simple =
	| { readonly type: 'all' }
	| { readonly type: 'tag'; readonly name: string }
	| { readonly type: 'id'; readonly value: string }
	| { readonly type: 'class'; readonly value: string }
	| {
			readonly type: 'attribute';
			readonly name: string;
			readonly operator: AttributeOperator;
			readonly value: string;
			readonly pattern: RegExp | null;
	  }
	| { readonly type: 'not'; readonly list: Complex[] }
	| { readonly type: 'has'; readonly list: Complex[] }
	| { readonly type: 'contains'; readonly own: boolean; readonly text: string }
	| { readonly type: 'containsData'; readonly text: string }
	| {
			readonly type: 'matches';
			readonly own: boolean;
			readonly pattern: RegExp;
	  }
	| {
			readonly type: 'index';
			readonly operator: 'eq' | 'gt' | 'lt';
			readonly value: number;
	  }
	| {
			readonly type: 'nth';
			readonly step: number;
			readonly offset: number;
			/** `:nth-last-child`, which counts from the end of the sibling list. */
			readonly fromEnd: boolean;
	  }
	| { readonly type: 'firstChild' }
	| { readonly type: 'lastChild' };

/** One compound selector plus the combinator that joins it to the one before. */
interface Step {
	readonly combinator: Combinator | null;
	readonly parts: Simple[];
}

type Complex = Step[];

const IDENTIFIER_CHAR = /[\w\u00a0-\uffff-]/;
const ATTRIBUTE_NAME_CHAR = /[\w\u00a0-\uffff:.-]/;

export class SelectorError extends Error {}

class SelectorParser {
	private readonly input: string;
	private position = 0;

	constructor(input: string) {
		this.input = input;
	}

	parseList(): Complex[] {
		const list: Complex[] = [];
		for (;;) {
			list.push(this.parseComplex());
			this.skipSpace();
			if (this.input.charAt(this.position) === ',') {
				this.position++;
				continue;
			}
			break;
		}
		if (this.position < this.input.length) {
			throw this.error('unexpected "' + this.input.charAt(this.position) + '"');
		}
		return list;
	}

	private parseComplex(): Complex {
		const steps: Step[] = [];
		this.skipSpace();

		// A leading combinator is legal only inside :has(), where it is measured
		// against the element being tested rather than against a previous step.
		let combinator: Combinator | null = this.readCombinator();

		for (;;) {
			const parts = this.parseCompound();
			steps.push({ combinator, parts });

			const before = this.position;
			this.skipSpace();
			const gap = this.position > before;
			const next = this.input.charAt(this.position);
			if (next === '' || next === ',' || next === ')') break;

			const explicit = this.readCombinator();
			if (explicit !== null) combinator = explicit;
			else if (gap) combinator = ' ';
			else throw this.error('unexpected "' + next + '"');
		}
		return steps;
	}

	private readCombinator(): Combinator | null {
		const character = this.input.charAt(this.position);
		if (character === '>' || character === '+' || character === '~') {
			this.position++;
			this.skipSpace();
			return character;
		}
		return null;
	}

	private parseCompound(): Simple[] {
		const parts: Simple[] = [];
		for (;;) {
			const character = this.input.charAt(this.position);
			if (character === '' || character === ',' || character === ')') break;
			if (isSpace(character) || character === '>' || character === '+' || character === '~') break;

			if (character === '*') {
				this.position++;
				parts.push({ type: 'all' });
			} else if (character === '#') {
				this.position++;
				parts.push({ type: 'id', value: this.readIdentifier() });
			} else if (character === '.') {
				this.position++;
				parts.push({
					type: 'class',
					value: this.readIdentifier().toLowerCase()
				});
			} else if (character === '[') {
				parts.push(this.parseAttribute());
			} else if (character === ':') {
				this.position++;
				parts.push(this.parsePseudo());
			} else {
				parts.push({ type: 'tag', name: this.readIdentifier().toLowerCase() });
			}
		}
		if (parts.length === 0) throw this.error('empty selector');
		return parts;
	}

	private parseAttribute(): Simple {
		this.position++; // '['
		this.skipSpace();
		const start = this.position;
		while (
			this.position < this.input.length &&
			ATTRIBUTE_NAME_CHAR.test(this.input.charAt(this.position))
		) {
			this.position++;
		}
		const name = this.input.slice(start, this.position).toLowerCase();
		if (name === '') throw this.error('an attribute selector needs a name');
		this.skipSpace();

		let operator: AttributeOperator = 'exists';
		let value = '';
		const character = this.input.charAt(this.position);
		if (character === ']') {
			this.position++;
		} else {
			if (character === '^' || character === '$' || character === '*' || character === '~') {
				if (this.input.charAt(this.position + 1) !== '=') {
					throw this.error('expected "=" after "' + character + '"');
				}
				operator = (character + '=') as AttributeOperator;
				this.position += 2;
			} else if (character === '=') {
				operator = '=';
				this.position++;
			} else {
				throw this.error('unexpected "' + character + '" in an attribute selector');
			}
			this.skipSpace();
			value = this.readAttributeValue();
			this.skipSpace();
			if (this.input.charAt(this.position) !== ']') throw this.error('unclosed "["');
			this.position++;
		}

		let pattern: RegExp | null = null;
		if (operator === '~=') {
			// jsoup compiles `~=` to a regex rather than the CSS word match.
			try {
				pattern = new RegExp(value);
			} catch {
				throw this.error('"' + value + '" is not a valid regular expression');
			}
		}
		return { type: 'attribute', name, operator, value, pattern };
	}

	private readAttributeValue(): string {
		const quote = this.input.charAt(this.position);
		if (quote === '"' || quote === "'") {
			this.position++;
			let out = '';
			while (this.position < this.input.length) {
				const character = this.input.charAt(this.position);
				if (character === '\\') {
					out += this.input.charAt(this.position + 1);
					this.position += 2;
					continue;
				}
				if (character === quote) {
					this.position++;
					return out;
				}
				out += character;
				this.position++;
			}
			throw this.error('unclosed quote');
		}
		const start = this.position;
		while (this.position < this.input.length) {
			const character = this.input.charAt(this.position);
			if (character === ']' || isSpace(character)) break;
			this.position++;
		}
		return this.input.slice(start, this.position);
	}

	private parsePseudo(): Simple {
		const start = this.position;
		while (this.position < this.input.length && /[\w-]/.test(this.input.charAt(this.position))) {
			this.position++;
		}
		const raw = this.input.slice(start, this.position);
		const name = raw.toLowerCase();
		const argument = this.input.charAt(this.position) === '(' ? this.readArgument() : null;

		switch (name) {
			case 'first-child':
				return { type: 'firstChild' };
			case 'last-child':
				return { type: 'lastChild' };
			case 'nth-child':
				return this.parseNth(this.argumentOf(argument, ':nth-child'), false, 'nth-child');
			// Standard CSS, and jsoup has it, so a selector using this works on
			// the real page and was failing only here. Counted from the end of
			// the sibling list; everything else about it is `:nth-child`.
			case 'nth-last-child':
				return this.parseNth(this.argumentOf(argument, ':nth-last-child'), true, 'nth-last-child');
			case 'not':
			case 'has': {
				const list = new SelectorParser(this.argumentOf(argument, ':' + name)).parseList();
				return name === 'not' ? { type: 'not', list } : { type: 'has', list };
			}
			case 'contains':
			case 'containsown': {
				const inner = stripQuotes(this.argumentOf(argument, ':' + raw));
				const text = normaliseArgument(unescapeArgument(inner));
				return {
					type: 'contains',
					own: name === 'containsown',
					text: text.toLowerCase()
				};
			}
			case 'containsdata': {
				// Not whitespace-normalised, unlike `:contains`. jsoup matches this
				// one against the raw data, and the data is script source: the
				// runs of spaces and newlines in it are what the author matched on.
				const inner = stripQuotes(this.argumentOf(argument, ':' + raw));
				return {
					type: 'containsData',
					text: unescapeArgument(inner).toLowerCase()
				};
			}
			case 'matches':
			case 'matchesown': {
				// Deliberately not unescaped: those backslashes belong to the pattern.
				const source = stripQuotes(this.argumentOf(argument, ':' + raw));
				try {
					return {
						type: 'matches',
						own: name === 'matchesown',
						pattern: new RegExp(source)
					};
				} catch {
					throw this.error('"' + source + '" is not a valid regular expression');
				}
			}
			case 'eq':
			case 'gt':
			case 'lt': {
				const value = parseInteger(this.argumentOf(argument, ':' + name));
				if (value === null) throw this.error(':' + name + ' needs a whole number');
				return { type: 'index', operator: name, value };
			}
			default:
				throw this.error('":' + raw + '" is not supported');
		}
	}

	private argumentOf(argument: string | null, name: string): string {
		if (argument === null) throw this.error(name + ' needs an argument');
		return argument;
	}

	private parseNth(argument: string, fromEnd: boolean, name: string): Simple {
		const raw = argument.replace(/[ \t\n\f\r]+/g, '').toLowerCase();
		if (raw === 'odd') return { type: 'nth', step: 2, offset: 1, fromEnd };
		if (raw === 'even') return { type: 'nth', step: 2, offset: 0, fromEnd };

		const plain = /^([+-]?\d+)$/.exec(raw);
		if (plain !== null) return { type: 'nth', step: 0, offset: parseInt(plain[1], 10), fromEnd };

		const stepped = /^([+-]?\d*)n([+-]\d+)?$/.exec(raw);
		if (stepped === null) {
			// Named for the pseudo-class actually written: a message about
			// `:nth-child` for a `:nth-last-child` selector sends whoever reads
			// it looking at the wrong part of the selector.
			throw this.error('":' + name + '(' + raw + ')" is not a recognised pattern');
		}
		const head = stepped[1];
		const tail = stepped[2];
		const step = head === '' || head === '+' ? 1 : head === '-' ? -1 : parseInt(head, 10);
		return {
			type: 'nth',
			step,
			offset: tail === undefined ? 0 : parseInt(tail, 10),
			fromEnd
		};
	}

	/**
	 * Reads a parenthesised argument, tracking nesting and quotes so that
	 * `:not(a:has(b))` and `:matches((one|two))` both survive. Backslash escapes
	 * are copied through rather than resolved: whoever consumes the argument knows
	 * whether a `\(` is punctuation or part of a pattern.
	 */
	private readArgument(): string {
		this.position++; // '('
		let depth = 1;
		let quote = '';
		let out = '';
		while (this.position < this.input.length) {
			const character = this.input.charAt(this.position);
			if (character === '\\') {
				out += character + this.input.charAt(this.position + 1);
				this.position += 2;
				continue;
			}
			if (quote !== '') {
				if (character === quote) quote = '';
				out += character;
				this.position++;
				continue;
			}
			if (character === '"' || character === "'") {
				quote = character;
				out += character;
				this.position++;
				continue;
			}
			if (character === '(') depth++;
			if (character === ')') {
				depth--;
				if (depth === 0) {
					this.position++;
					return out;
				}
			}
			out += character;
			this.position++;
		}
		throw this.error('unclosed "("');
	}

	private readIdentifier(): string {
		let out = '';
		while (this.position < this.input.length) {
			const character = this.input.charAt(this.position);
			if (character === '\\') {
				out += this.input.charAt(this.position + 1);
				this.position += 2;
				continue;
			}
			if (!IDENTIFIER_CHAR.test(character)) break;
			out += character;
			this.position++;
		}
		if (out === '') throw this.error('expected a name');
		return out;
	}

	private skipSpace(): void {
		while (this.position < this.input.length && isSpace(this.input.charAt(this.position))) {
			this.position++;
		}
	}

	/**
	 * Returned rather than thrown, so that every call site reads
	 * `throw this.error(...)` and the compiler can see the path ends there.
	 */
	private error(message: string): SelectorError {
		return new SelectorError('Could not parse the selector "' + this.input + '": ' + message + '.');
	}
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;
	const first = trimmed.charAt(0);
	if ((first === '"' || first === "'") && trimmed.charAt(trimmed.length - 1) === first) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function unescapeArgument(value: string): string {
	if (value.indexOf('\\') < 0) return value;
	let out = '';
	for (let index = 0; index < value.length; index++) {
		if (value.charAt(index) === '\\' && index + 1 < value.length) {
			out += value.charAt(index + 1);
			index++;
			continue;
		}
		out += value.charAt(index);
	}
	return out;
}

function normaliseArgument(value: string): string {
	return value.replace(TEXT_WHITESPACE, ' ').trim();
}

function parseInteger(value: string): number | null {
	const trimmed = value.trim();
	if (!/^[+-]?\d+$/.test(trimmed)) return null;
	return parseInt(trimmed, 10);
}

/**
 * Selectors are parsed once and kept.
 *
 * A scraper calls `select` with the same handful of literals inside a loop over
 * every card on a page, and parsing is the expensive half of the operation. The
 * cache is cleared wholesale rather than evicted, because the only way to reach
 * the bound is a plugin generating selectors, and that plugin wants its memory
 * back more than it wants its history.
 */
const SELECTOR_CACHE = new Map<string, Complex[]>();

function parseSelector(selector: string | Query): Complex[] {
	if (isQuery(selector)) return selector.query;
	const key = String(selector);
	const cached = SELECTOR_CACHE.get(key);
	if (cached !== undefined) return cached;
	const parsed = new SelectorParser(key).parseList();
	if (SELECTOR_CACHE.size >= 512) SELECTOR_CACHE.clear();
	SELECTOR_CACHE.set(key, parsed);
	return parsed;
}

/**
 * A selector that arrives already parsed: jsoup's `Evaluator` objects, which
 * `select` and `selectFirst` accept in place of a string.
 */
export interface Query {
	readonly query: Complex[];
}

function isQuery(value: unknown): value is Query {
	return typeof value === 'object' && value !== null && Array.isArray((value as Query).query);
}

/**
 * jsoup's `Evaluator.Tag`, `Evaluator.Class` and `Evaluator.Id`, the three
 * the catalogue constructs by hand — usually to avoid escaping a class name
 * in a selector string.
 *
 * Each is exactly its selector's simple part, with jsoup's own comparison:
 * `Tag` compares against the lower-cased tag name *as given* (jsoup does not
 * lower-case the argument, so `Tag("A")` matches nothing), `Class` is
 * case-insensitive, `Id` is exact. Any other evaluator is refused before it
 * gets here.
 */
export function jsoupEvaluator(kind: string, value: string): Query {
	const text = String(value);
	let part: Simple;
	if (kind === 'Tag') part = { type: 'tag', name: text };
	else if (kind === 'Class') part = { type: 'class', value: text.toLowerCase() };
	else if (kind === 'Id') part = { type: 'id', value: text };
	else throw new Error('Evaluator.' + kind + ' is not one this runtime implements.');
	return { query: [[{ combinator: null, parts: [part] }]] };
}

/* ── selectors: matching ──────────────────────────────────────────────────── */

function matchesSimple(scope: ElementImpl, element: ElementImpl, part: Simple): boolean {
	switch (part.type) {
		case 'all':
			return true;
		case 'tag':
			return element.tagName === part.name;
		case 'id':
			return element.id === part.value;
		case 'class':
			return element.classes().indexOf(part.value) >= 0;
		case 'attribute':
			return matchesAttribute(element, part);
		case 'not':
			return !matchesList(scope, element, part.list);
		case 'has':
			return matchesHas(element, part.list);
		case 'containsData':
			return element.data().toLowerCase().indexOf(part.text) >= 0;
		case 'contains': {
			const haystack = (part.own ? element.ownText() : element.text()).toLowerCase();
			return haystack.indexOf(part.text) >= 0;
		}
		case 'matches':
			return part.pattern.test(part.own ? element.ownText() : element.text());
		case 'index': {
			if (element.parent === null) return false;
			if (part.operator === 'eq') return element.siblingIndex === part.value;
			if (part.operator === 'gt') return element.siblingIndex > part.value;
			return element.siblingIndex < part.value;
		}
		case 'nth': {
			if (element.parent === null) return false;
			const ordinal = part.fromEnd
				? element.parent.children.length - element.siblingIndex
				: element.siblingIndex + 1;
			if (part.step === 0) return ordinal === part.offset;
			const delta = ordinal - part.offset;
			return delta % part.step === 0 && delta / part.step >= 0;
		}
		case 'firstChild':
			return element.parent !== null && element.siblingIndex === 0;
		case 'lastChild':
			return element.parent !== null && element.siblingIndex === element.parent.children.length - 1;
		default:
			return false;
	}
}

function matchesAttribute(
	element: ElementImpl,
	part: {
		name: string;
		operator: AttributeOperator;
		value: string;
		pattern: RegExp | null;
	}
): boolean {
	if (!element.hasAttr(part.name)) return false;
	if (part.operator === 'exists') return true;

	const actual = element.attr(part.name);
	if (part.operator === '~=') return part.pattern !== null && part.pattern.test(actual);

	// jsoup compares these case-insensitively, and trims for equality only.
	const lower = actual.toLowerCase();
	const wanted = part.value.toLowerCase();
	switch (part.operator) {
		case '=':
			return lower.trim() === wanted;
		case '^=':
			return lower.slice(0, wanted.length) === wanted;
		case '$=':
			return wanted.length <= lower.length && lower.slice(lower.length - wanted.length) === wanted;
		case '*=':
			return lower.indexOf(wanted) >= 0;
		default:
			return false;
	}
}

function matchesCompound(scope: ElementImpl, element: ElementImpl, parts: Simple[]): boolean {
	for (const part of parts) {
		if (!matchesSimple(scope, element, part)) return false;
	}
	return true;
}

/**
 * Matches right to left, which is the only direction that terminates cheaply:
 * the rightmost step is already known to match the candidate, and each step
 * left narrows a single element rather than a set.
 */
function matchesComplex(
	scope: ElementImpl,
	element: ElementImpl,
	steps: Complex,
	index: number
): boolean {
	const step = steps[index];
	if (!matchesCompound(scope, element, step.parts)) return false;

	if (index === 0) {
		// A leading combinator only exists inside :has(), and anchors to the
		// element that :has() was asked about.
		switch (step.combinator) {
			case null:
				return true;
			case '>':
				return element.parent === scope;
			case ' ':
				return isDescendantOf(element, scope);
			case '+':
				return element.previousElement() === scope;
			case '~':
				return element.parent === scope.parent && element.siblingIndex > scope.siblingIndex;
		}
	}

	switch (step.combinator) {
		case '>': {
			const parent = element.parent;
			return (
				parent !== null && element !== scope && matchesComplex(scope, parent, steps, index - 1)
			);
		}
		case '+': {
			const previous = element.previousElement();
			return previous !== null && matchesComplex(scope, previous, steps, index - 1);
		}
		case '~': {
			const parent = element.parent;
			if (parent === null) return false;
			for (let i = element.siblingIndex - 1; i >= 0; i--) {
				if (matchesComplex(scope, parent.children[i], steps, index - 1)) return true;
			}
			return false;
		}
		default: {
			// Descendant. The walk stops at the scope, having tested it: an
			// ancestor outside the subtree the query was rooted at is not one of
			// this query's ancestors.
			if (element === scope) return false;
			let ancestor = element.parent;
			while (ancestor !== null) {
				if (matchesComplex(scope, ancestor, steps, index - 1)) return true;
				if (ancestor === scope) break;
				ancestor = ancestor.parent;
			}
			return false;
		}
	}
}

function isDescendantOf(element: ElementImpl, ancestor: ElementImpl): boolean {
	let current = element.parent;
	while (current !== null) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}

function matchesList(scope: ElementImpl, element: ElementImpl, list: Complex[]): boolean {
	for (const steps of list) {
		if (matchesComplex(scope, element, steps, steps.length - 1)) return true;
	}
	return false;
}

/**
 * `:has(x)` — where the candidates are the element's descendants, except for
 * `:has(+ x)` and `:has(~ x)`, whose candidates are its following siblings.
 */
function matchesHas(element: ElementImpl, list: Complex[]): boolean {
	for (const steps of list) {
		const leading = steps[0].combinator;
		if (leading === '+' || leading === '~') {
			const parent = element.parent;
			if (parent === null) continue;
			for (let index = element.siblingIndex + 1; index < parent.children.length; index++) {
				if (matchesComplex(element, parent.children[index], steps, steps.length - 1)) return true;
			}
			continue;
		}
		if (anyDescendant(element, steps)) return true;
	}
	return false;
}

function anyDescendant(element: ElementImpl, steps: Complex): boolean {
	for (const child of element.children) {
		if (matchesComplex(element, child, steps, steps.length - 1)) return true;
		if (anyDescendant(child, steps)) return true;
	}
	return false;
}

/** Document order, and the root itself is a candidate — as it is in jsoup. */
function collectMatches(
	scope: ElementImpl,
	element: ElementImpl,
	list: Complex[],
	found: ElementImpl[]
): void {
	if (matchesList(scope, element, list)) found.push(element);
	for (const child of element.children) collectMatches(scope, child, list, found);
}

function firstMatch(scope: ElementImpl, element: ElementImpl, list: Complex[]): ElementImpl | null {
	if (matchesList(scope, element, list)) return element;
	for (const child of element.children) {
		const found = firstMatch(scope, child, list);
		if (found !== null) return found;
	}
	return null;
}
