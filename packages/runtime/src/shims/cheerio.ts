/**
 * A cheerio-shaped API over the bundle's own HTML parser, as bundle source.
 *
 * ## Why a façade and not the library
 *
 * A source written against cheerio expects the library its own toolchain would
 * have bundled. Carrying cheerio itself means carrying its parser too — about
 * 460 KB per source, by one ecosystem's own measurement — beside a parser this
 * runtime already ships. So this is the established pattern the Nuvio and
 * Suwatte shims follow: the members a measured corpus calls, over the shared
 * parser, and nothing else. A member outside the set is absent, so calling it
 * fails with its own name rather than answering an empty selection that reads
 * as a page with nothing on it.
 *
 * Measured over every Mana source closure that imports cheerio (45 files):
 * `find`, `text`, `attr`, `first`, `filter`, `map`, `toArray`, `get`, `has`,
 * `slice`, `add`, `each`, `children`, `html`, `parent`, `next`, `last`,
 * `clone`, `remove`, `append`, `closest`, `replaceWith`, `is`, `not`,
 * `hasClass`, `contents`, `end`, `prev`, and `$.root`, `$.html`, `load`.
 *
 * ## Where it is cheerio and not jsoup
 *
 * - `find` is descendants only; the parser's `select` also matches the element
 *   it is asked from.
 * - `text()` is the text content as written — text and script bodies, never
 *   comments — not jsoup's whitespace-normalised text.
 * - `attr` answers `undefined` for an absent attribute, not `''`.
 * - `map` drops `null` and `undefined` and flattens an array, as cheerio does.
 * - The nodes handed to a callback, or out of `get`/`toArray`, are shaped as
 *   cheerio's are — `type`, `name`, `attribs`, `data`, `children`, `parent`,
 *   `next`, `prev` — because sources read them directly, `el.type === 'text'`
 *   included, and a parser node answering `undefined` there is a wrong value
 *   rather than an error.
 *
 * Exposes `__cheerio` (`{ load, default: { load } }`). Needs the DOM engine
 * (`DOM_RUNTIME_SOURCE`) evaluated first.
 */
export const CHEERIO_SOURCE = `
/* --- cheerio, over the bundle's own parser -------------------------------- */

var __cheerioDom = globalThis.__yorozoRuntime;
var __cheerioViews = new WeakMap();

function __cheerioIsElement(node) { return node !== null && typeof node === 'object' && node.kind === 'element'; }

/** A parser node as cheerio's domhandler node looks, one view per node. */
function __cheerioView(node) {
  if (node === null || node === undefined) return null;
  if (node.__cheerioNode !== undefined) return node;
  var known = __cheerioViews.get(node);
  if (known !== undefined) return known;
  var view = { __cheerioNode: node };
  var element = __cheerioIsElement(node);
  var tag = element ? String(node.tagName).toLowerCase() : '';
  Object.defineProperties(view, {
    type: { get: function () {
      if (!element) return node.kind === 'comment' ? 'comment' : 'text';
      if (tag === 'script') return 'script';
      if (tag === 'style') return 'style';
      return 'tag';
    } },
    name: { get: function () { return element ? tag : undefined; } },
    tagName: { get: function () { return element ? tag : undefined; } },
    data: { get: function () { return element ? undefined : String(node.wholeText); } },
    attribs: { get: function () {
      if (!element) return undefined;
      var out = {};
      var list = node.attributes();
      for (var i = 0; i < list.length; i++) out[list[i].key] = list[i].value;
      return out;
    } },
    children: { get: function () { return element ? node.childNodes().map(__cheerioView) : []; } },
    childNodes: { get: function () { return element ? node.childNodes().map(__cheerioView) : []; } },
    parent: { get: function () { return __cheerioIsElement(node.parent) ? __cheerioView(node.parent) : null; } },
    next: { get: function () { return __cheerioSibling(node, 1); } },
    prev: { get: function () { return __cheerioSibling(node, -1); } }
  });
  __cheerioViews.set(node, view);
  return view;
}

function __cheerioSibling(node, step) {
  var parent = node.parent;
  if (!__cheerioIsElement(parent)) return null;
  var list = parent.childNodes();
  var at = list.indexOf(node) + step;
  return at >= 0 && at < list.length ? __cheerioView(list[at]) : null;
}

function __cheerioNode(value) {
  return value !== null && typeof value === 'object' && value.__cheerioNode !== undefined ? value.__cheerioNode : value;
}

/** Text content as written: text and script bodies, comments left out. */
function __cheerioText(node) {
  if (node === null || typeof node !== 'object') return '';
  if (node.kind === 'text' || node.kind === 'data') return String(node.wholeText);
  if (node.kind === 'comment') return '';
  var out = '';
  var children = node.childNodes();
  for (var i = 0; i < children.length; i++) out += __cheerioText(children[i]);
  return out;
}

function __cheerioUnique(nodes) {
  var out = [];
  for (var i = 0; i < nodes.length; i++) if (out.indexOf(nodes[i]) < 0) out.push(nodes[i]);
  return out;
}

function __cheerioMatches(node, selector) {
  return __cheerioIsElement(node) && node.is(String(selector));
}

/** Whatever a source may hand '$()' or 'add()', as parser nodes. */
function __cheerioNodesOf(value, doc) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return doc.select(value);
  if (value.__cheerioSelection === true) return value.__nodes.slice();
  if (Array.isArray(value)) return value.map(__cheerioNode);
  return [__cheerioNode(value)];
}

function __cheerioSelection(nodes, doc, previous) {
  var api = {
    __cheerioSelection: true,
    __nodes: nodes,
    length: nodes.length,
    cheerio: '[cheerio object]',

    toArray: function () { return nodes.map(__cheerioView); },
    get: function (i) {
      if (i === undefined) return nodes.map(__cheerioView);
      var at = i < 0 ? nodes.length + i : i;
      return __cheerioView(nodes[at]);
    },
    eq: function (i) {
      var at = i < 0 ? nodes.length + i : i;
      return __cheerioSelection(at >= 0 && at < nodes.length ? [nodes[at]] : [], doc, api);
    },
    first: function () { return api.eq(0); },
    last: function () { return api.eq(nodes.length - 1); },
    slice: function (a, b) { return __cheerioSelection(nodes.slice(a, b), doc, api); },
    end: function () { return previous === undefined ? __cheerioSelection([], doc) : previous; },
    add: function (other) { return __cheerioSelection(__cheerioUnique(nodes.concat(__cheerioNodesOf(other, doc))), doc, api); },

    find: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!__cheerioIsElement(node)) continue;
        var found = node.select(String(selector));
        for (var j = 0; j < found.length; j++) if (found[j] !== node) out.push(found[j]);
      }
      return __cheerioSelection(__cheerioUnique(out), doc, api);
    },
    children: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) if (__cheerioIsElement(nodes[i])) out = out.concat(nodes[i].children);
      return api.__narrow(out, selector);
    },
    contents: function () {
      var out = [];
      for (var i = 0; i < nodes.length; i++) if (__cheerioIsElement(nodes[i])) out = out.concat(nodes[i].childNodes());
      return __cheerioSelection(out, doc, api);
    },
    parent: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var up = nodes[i].parent;
        if (__cheerioIsElement(up)) out.push(up);
      }
      return api.__narrow(__cheerioUnique(out), selector);
    },
    closest: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        if (!__cheerioIsElement(nodes[i])) continue;
        var found = nodes[i].closest(String(selector));
        if (found !== null) out.push(found);
      }
      return __cheerioSelection(__cheerioUnique(out), doc, api);
    },
    next: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var found = __cheerioIsElement(nodes[i]) ? nodes[i].nextElementSibling() : null;
        if (found !== null) out.push(found);
      }
      return api.__narrow(out, selector);
    },
    prev: function (selector) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var found = __cheerioIsElement(nodes[i]) ? nodes[i].previousElementSibling() : null;
        if (found !== null) out.push(found);
      }
      return api.__narrow(out, selector);
    },
    __narrow: function (list, selector) {
      if (selector === undefined) return __cheerioSelection(list, doc, api);
      return __cheerioSelection(list.filter(function (node) { return __cheerioMatches(node, selector); }), doc, api);
    },

    filter: function (test) {
      var keep = api.__test(test);
      return __cheerioSelection(nodes.filter(function (node, i) { return keep(node, i); }), doc, api);
    },
    not: function (test) {
      var keep = api.__test(test);
      return __cheerioSelection(nodes.filter(function (node, i) { return !keep(node, i); }), doc, api);
    },
    is: function (test) {
      var keep = api.__test(test);
      for (var i = 0; i < nodes.length; i++) if (keep(nodes[i], i)) return true;
      return false;
    },
    has: function (selector) {
      return __cheerioSelection(nodes.filter(function (node) {
        if (!__cheerioIsElement(node)) return false;
        var found = typeof selector === 'string' ? node.select(selector) : __cheerioNodesOf(selector, doc);
        for (var i = 0; i < found.length; i++) if (found[i] !== node && __cheerioContains(node, found[i])) return true;
        return false;
      }), doc, api);
    },
    __test: function (test) {
      if (typeof test === 'function') {
        return function (node, i) { var view = __cheerioView(node); return Boolean(test.call(view, i, view)); };
      }
      if (typeof test === 'string') return function (node) { return __cheerioMatches(node, test); };
      var others = __cheerioNodesOf(test, doc);
      return function (node) { return others.indexOf(node) >= 0; };
    },
    hasClass: function (name) {
      for (var i = 0; i < nodes.length; i++) if (__cheerioIsElement(nodes[i]) && nodes[i].hasClass(String(name))) return true;
      return false;
    },

    text: function (value) {
      if (value === undefined) {
        var out = '';
        for (var i = 0; i < nodes.length; i++) out += __cheerioText(nodes[i]);
        return out;
      }
      for (var j = 0; j < nodes.length; j++) {
        if (!__cheerioIsElement(nodes[j])) continue;
        var kids = nodes[j].childNodes();
        for (var k = 0; k < kids.length; k++) kids[k].remove();
        nodes[j].appendText(String(value));
      }
      return api;
    },
    html: function () { return __cheerioIsElement(nodes[0]) ? nodes[0].html() : null; },
    attr: function (name, value) {
      if (name === undefined) {
        var all = {};
        if (__cheerioIsElement(nodes[0])) {
          var list = nodes[0].attributes();
          for (var i = 0; i < list.length; i++) all[list[i].key] = list[i].value;
        }
        return all;
      }
      if (value === undefined) {
        if (!__cheerioIsElement(nodes[0]) || !nodes[0].hasAttr(String(name))) return undefined;
        return nodes[0].attr(String(name));
      }
      for (var j = 0; j < nodes.length; j++) if (__cheerioIsElement(nodes[j])) nodes[j].attr(String(name), String(value));
      return api;
    },
    data: function (name) {
      var node = nodes[0];
      if (!__cheerioIsElement(node)) return undefined;
      if (name === undefined) {
        var out = {};
        node.dataset().forEach(function (value, key) { out[key] = value; });
        return out;
      }
      return node.hasAttr('data-' + name) ? node.attr('data-' + name) : undefined;
    },
    val: function () { return __cheerioIsElement(nodes[0]) ? nodes[0].val() : undefined; },

    each: function (fn) {
      for (var i = 0; i < nodes.length; i++) {
        var view = __cheerioView(nodes[i]);
        if (fn.call(view, i, view) === false) break;
      }
      return api;
    },
    map: function (fn) {
      var out = [];
      for (var i = 0; i < nodes.length; i++) {
        var view = __cheerioView(nodes[i]);
        var value = fn.call(view, i, view);
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) out.push.apply(out, value);
        else out.push(value);
      }
      return {
        length: out.length,
        get: function (i) { return i === undefined ? out.slice() : out[i < 0 ? out.length + i : i]; },
        toArray: function () { return out.slice(); }
      };
    },

    clone: function () {
      return __cheerioSelection(nodes.filter(__cheerioIsElement).map(function (node) { return node.clone(); }), doc, api);
    },
    remove: function (selector) {
      for (var i = 0; i < nodes.length; i++) {
        if (selector !== undefined && !__cheerioMatches(nodes[i], selector)) continue;
        nodes[i].remove();
      }
      return api;
    },
    append: function (content) {
      for (var i = 0; i < nodes.length; i++) {
        if (!__cheerioIsElement(nodes[i])) continue;
        if (typeof content === 'string') nodes[i].append(content);
        else {
          var incoming = __cheerioNodesOf(content, doc);
          for (var j = 0; j < incoming.length; j++) nodes[i].append(incoming[j].outerHtml ? incoming[j].outerHtml() : String(incoming[j]));
        }
      }
      return api;
    },
    replaceWith: function (content) {
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!__cheerioIsElement(node) || !__cheerioIsElement(node.parent)) continue;
        if (typeof content === 'string') node.before(content);
        else {
          var incoming = __cheerioNodesOf(content, doc);
          for (var j = 0; j < incoming.length; j++) node.before(incoming[j]);
        }
        node.remove();
      }
      return api;
    }
  };
  return api;
}

function __cheerioContains(ancestor, node) {
  for (var at = node.parent; at !== null && at !== undefined; at = at.parent) if (at === ancestor) return true;
  return false;
}

/** 'cheerio.load(html)', the one entry point the measured sources use. */
function __cheerioLoad(html) {
  var doc = __cheerioDom.parseHtml(String(html === null || html === undefined ? '' : html));
  var $ = function (what, context) {
    if (typeof what === 'string' && context !== undefined && context !== null) {
      return __cheerioSelection(__cheerioNodesOf(context, doc), doc).find(what);
    }
    if (typeof what === 'string' && /^\\s*</.test(what)) {
      var fragment = __cheerioDom.parseHtml(what);
      return __cheerioSelection(fragment.body().children.slice(), doc);
    }
    return __cheerioSelection(__cheerioUnique(__cheerioNodesOf(what, doc)), doc);
  };
  $.root = function () { return __cheerioSelection([doc], doc); };
  $.html = function (what) {
    if (what === undefined) return doc.outerHtml();
    var list = __cheerioNodesOf(what, doc);
    var out = '';
    for (var i = 0; i < list.length; i++) out += __cheerioIsElement(list[i]) ? list[i].outerHtml() : String(list[i].wholeText);
    return out;
  };
  $.text = function (what) {
    var list = what === undefined ? [doc] : __cheerioNodesOf(what, doc);
    var out = '';
    for (var i = 0; i < list.length; i++) out += __cheerioText(list[i]);
    return out;
  };
  return $;
}

var __cheerio = { load: __cheerioLoad, default: { load: __cheerioLoad } };
`;
