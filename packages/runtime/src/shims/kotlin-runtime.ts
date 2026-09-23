/**
 * The runtime an emitted Kotlin translation lands on, as source.
 *
 * The transpiler in `kotlin/` turns an Aniyomi extension's Kotlin into
 * JavaScript. It does not turn the *Kotlin standard library* into JavaScript,
 * and it never should: `substringAfter`, `mapNotNull`, okhttp, jsoup and
 * kotlinx.serialization are a library surface, not a language, and inlining a
 * copy of each of them at every call site would make the emitted text
 * unreadable and every fix a re-conversion. So the translation emits calls, and
 * this file is what they call.
 *
 * It is emitted **as text into the bundle**, not imported by it, for the same
 * reason `js-runtime.ts` is: a plugin bundle is one self-contained ES2020
 * module (`ABI.md` §1), there is no module resolution inside the sandbox, and
 * an `import` would have nothing to resolve against. Hence string constants
 * rather than functions, and hence a spec that has to *evaluate* the strings —
 * a typo in here is not a type error, it is a `SyntaxError` on a viewer's
 * phone.
 *
 * Sections are separate constants so a conversion concatenates only what the
 * extension it converted actually touched. `KOTLIN_STDLIB` is not optional: it
 * declares `__k`, and everything else hangs off it.
 *
 * **This runtime assumes `JS_RUNTIME` is emitted before it.** `__host()` and
 * `__enter()` are declared there, once, and a second `function __host` at
 * module scope is a `SyntaxError`, not a shadowing — so they are used here and
 * not redeclared. `kotlinRuntime()` returns this runtime alone; the entrypoint
 * builder is what puts the two in order.
 *
 * ## Why every helper hangs off `__k`
 *
 * `runtime-api.ts` has the long version: emitted code shares a scope with the
 * converted source's own identifiers, and Kotlin extensions are full of short
 * names — `headers`, `client`, `json`, `element`. A bare `substringAfter` would
 * be shadowed by any local with that name and the failure would be a wrong
 * value rather than an error. The exceptions are the names a scraper *writes* —
 * `GET`, `Headers`, `SAnime`, `Jsoup` — which stay spelled as the Kotlin spells
 * them so the emitter need not rewrite every construction site.
 *
 * ## The one asynchronous call, and why it is only one
 *
 * `client.newCall(request).execute()` **reads the response body before it
 * resolves**. In Kotlin, `response.body.string()`, `response.asJsoup()` and
 * `response.parseAs()` are synchronous calls on an open stream, and they appear
 * in arbitrary expression positions — inside a `map`, inside a string template,
 * as a receiver of a chain. If they were asynchronous here the transpiler would
 * have to inject `await` into those positions and infect every enclosing
 * function with `async`; the taint spreads until it reaches a lambda a caller
 * invokes synchronously, and then it is a `Promise` where a `String` was
 * expected — a wrong value, not an error. Reading eagerly costs nothing (the
 * host already buffers the whole body: `sandbox.worker.ts` hands over a string)
 * and collapses the asynchronous surface to exactly one call. The text is
 * cached, so a second `.string()` returns the same bytes rather than an empty
 * one.
 *
 * `asJsoup()` parses against the response's **final** url, not the requested
 * one, because `attr("abs:href")` after a redirect must resolve against where
 * the document actually came from. Passing the request url instead produces
 * links that are absolute, plausible and wrong.
 *
 * ## Where fidelity is knowingly traded
 *
 * - **No interceptor chain.** okhttp's is a streaming construct and the host
 *   owns the transport. An extension that installs one is refused by name at
 *   the point it installs it, because an interceptor silently dropped is an
 *   extension that thinks it is signing its requests and is not.
 * - **Regex is translated, and refuses what it cannot express.** Lookbehind is
 *   forbidden by `ABI.md` §6; `\\p{...}` classes and possessive quantifiers
 *   have no JavaScript equivalent that behaves identically. All three throw a
 *   named error rather than compiling to a pattern that matches differently on
 *   one engine — but at the first *use*, not at construction. A pattern is
 *   almost always a top-level `val` here, so refusing in the constructor threw
 *   during module initialisation and cost the bundle every entry point it had,
 *   including the ones that never touch that pattern.
 * - **Preferences are read-only.** A converted bundle declares no settings, so
 *   there is nothing for the host to draw and nothing to write back; a read
 *   returns the viewer's value if the host somehow has one, else the default
 *   the extension declared.
 * - **Filters are inert.** The ABI's `searchCatalog` takes a query and a page,
 *   so a filter list is constructed and never populated. Its declared default
 *   state is what the extension sees.
 *
 * ## The engine subset
 *
 * ES2020, and none of `Intl`, `crypto`, `structuredClone`, `Array.prototype.at`
 * or `Object.groupBy` (`ABI.md` §6). Nothing below uses any of them.
 *
 * Regex lookbehind was on that list and is not any more: `ABI.md` §6 named it
 * for the three-engine world of `ADR-0002` §2.3, and `ADR-0003` §2.2 repealed
 * that — every surface is now a full browser engine, and all of them have it.
 */

import { DOM_RUNTIME_SOURCE } from './generated/dom-source';
import { KOTLIN_TIME } from './kotlin-time';

/**
 * The Kotlin standard library, as much of it as a scraper reaches for.
 *
 * Declares `__k` and the null, number, string, collection, scope-function,
 * coroutine and regex helpers `runtime-api.ts` lists. Every other section
 * assigns onto the object this one creates, so it is always emitted first.
 */
export const KOTLIN_STDLIB = `
/* --- Kotlin stdlib -------------------------------------------------------- */

/** Set by the jsoup section. Null means the bundle was built without it. */
var __kdom = null;

function __thenable(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function';
}

/**
 * Continues with a value that may or may not have suspended.
 *
 * The transpiler turns a Kotlin \`suspend fun\` into an \`async function\`, so any
 * lambda handed to a collection helper may return a promise. A helper that
 * ignored that would compare a Promise for truthiness — always true — and
 * filter nothing while looking like it filtered.
 */
function __then(value, fn) {
  return __thenable(value) ? value.then(fn) : fn(value);
}

/**
 * RxJava's Observable, as the one thing this ecosystem actually uses it for.
 *
 * The idiom is uniform across the catalogue — 238 occurrences of exactly this
 * shape:
 *
 *   client.newCall(request).asObservableSuccess().map { response -> parse(it) }
 *
 * One value, one transform, awaited by the caller. That is a promise with a
 * 'map', so that is what this is: the value may already be a promise, 'map'
 * chains onto it, and the whole thing is **thenable**, so 'await' and the
 * runtime's own '__then' both handle it without knowing what it is.
 *
 * Deliberately not a scheduler. 'subscribeOn'/'observeOn' answer the same
 * object because there is one thread here and pretending otherwise would be a
 * lie with moving parts. The multi-value operators are absent rather than
 * approximated — nothing in this catalogue emits twice, and a 'concat' that
 * quietly dropped a second emission is the silent wrongness this runtime
 * exists to refuse.
 */
function __observable(value) {
  return {
    __isObservable: true,
    then: function (onResolved, onRejected) {
      return Promise.resolve(value).then(onResolved, onRejected);
    },
    map: function (fn) { return __observable(__then(value, fn)); },
    flatMap: function (fn) {
      return __observable(__then(value, function (item) { return __unwrapObservable(fn(item)); }));
    },
    doOnNext: function (fn) {
      return __observable(__then(value, function (item) { fn(item); return item; }));
    },
    onErrorReturn: function (fn) {
      return __observable(Promise.resolve(value).catch(function (error) { return fn(error); }));
    },
    subscribeOn: function () { return this; },
    observeOn: function () { return this; },
    toBlocking: function () { return this; },
    single: function () { return value; },
    first: function () { return value; }
  };
}

function __isObservable(value) {
  return value !== null && typeof value === 'object' && value.__isObservable === true;
}

/** An Observable as its value, and anything else unchanged — what 'flatMap'
 * needs when the lambda answers another Observable. */
function __unwrapObservable(value) {
  return __isObservable(value) ? value.single() : value;
}

var Observable = {
  just: function (value) { return __observable(value); },
  /* Deferred, both of them: Kotlin writes 'fromCallable { … }' precisely so
     the work does not start until somebody subscribes, and the extensions that
     use it are relying on that to keep a request out of a constructor. The
     lambda runs when the value is first asked for, which here is the moment
     the caller awaits. */
  fromCallable: function (fn) { return __observable(__then(null, function () { return fn(); })); },
  defer: function (fn) {
    return __observable(__then(null, function () { return __unwrapObservable(fn()); }));
  },
  error: function (error) { return __observable(Promise.reject(error)); },
  empty: function () { return __observable(null); }
};

function __arr(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  // '' is the empty value orEmpty() answers with when it cannot know whether a
  // String or a List was wanted, so it must read as an empty list too — one
  // bogus '' element in a page of results is exactly the silent wrongness this
  // runtime exists to prevent.
  if (typeof value === 'string') return value.length === 0 ? [] : [value];
  // A Kotlin Map iterates as its entries — see '__entry' — whether it is a JS
  // Map or a JsonObject, which is the plain object JSON.parse made. Both used
  // to be wrong: a Map gave bare [k, v] arrays, so 'it.key' was undefined, and
  // a JsonObject was one item, itself, so 'forEach { (k, v) -> }' ran once
  // with the object as its key.
  if (value instanceof Map) return __mapEntries(value);
  if (__mapLike(value)) return __mapEntries(value);
  if (typeof value.toArray === 'function') return value.toArray();
  if (typeof value[Symbol.iterator] === 'function') return Array.from(value);
  if (typeof value.length === 'number') return Array.prototype.slice.call(value);
  return [value];
}

/**
 * A Kotlin Map.Entry: the '[key, value]' pair destructuring reads, which is
 * how a Map iterated here all along, carrying the names Kotlin reads it by —
 * 'key' and 'value', and 'first'/'second' so 'toList()' of a map is a list of
 * Pairs, as it is in Kotlin. Non-enumerable, so JSON and equality see a pair.
 */
function __entry(key, value) {
  var entry = [key, value];
  Object.defineProperty(entry, 'key', { value: key, enumerable: false });
  Object.defineProperty(entry, 'value', { value: value, enumerable: false });
  Object.defineProperty(entry, 'first', { value: key, enumerable: false });
  Object.defineProperty(entry, 'second', { value: value, enumerable: false });
  return entry;
}

/**
 * A plain object that can only be a Map in Kotlin: JSON's object (a
 * JsonObject, or a map field the decoder answered), never a record the
 * runtime or the extension built with behaviour on it. Kotlin cannot iterate
 * a class instance or a DTO, so an object reaching a collection helper is one
 * of these — this only makes sure it is data and not, say, a builder.
 */
function __mapLike(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof Map || value instanceof Set) return false;
  var proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  if (value.__kResult === true) return false;
  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] === 'function') return false;
  }
  return true;
}

function __mapEntries(value) {
  var out = [];
  if (value instanceof Map) {
    value.forEach(function (held, key) { out.push(__entry(key, held)); });
    return out;
  }
  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(__entry(key, value[key]));
  }
  return out;
}

/** A new Kotlin Map from entries — what filter and mapValues answer over a Map. */
function __mapFrom(entries) {
  var out = __mutableMap(new Map());
  for (var i = 0; i < entries.length; i += 1) out.set(entries[i][0], entries[i][1]);
  return out;
}

function __isMap(value) {
  return value instanceof Map || __mapLike(value);
}

/**
 * A Map's 'keys', 'values' or 'entries', read as a property.
 *
 * They were plain property reads: undefined on a JsonObject, and on a JS Map
 * the *method* of that name, which every helper then iterated as one opaque
 * item — 'm.values.joinToString()' was empty. A receiver that really has the
 * property answers it unchanged: a DTO's own 'entries' field, a class getter,
 * an enum's static 'entries'.
 */
function __mapPart(value, name) {
  if (value instanceof Map) {
    var entries = __mapEntries(value);
    if (name === 'entries') return entries;
    return entries.map(function (entry) { return name === 'keys' ? entry[0] : entry[1]; });
  }
  if (value !== null && value !== undefined && (typeof value === 'object' || typeof value === 'function') &&
      name in value) {
    return value[name];
  }
  if (__mapLike(value)) return __mapPart(new Map(__mapEntries(value)), name);
  return value === null || value === undefined ? value : value[name];
}

/**
 * A value as the sequence Kotlin actually iterates it as.
 *
 * A Kotlin String is a CharSequence, and 'filter', 'all', 'any', 'none',
 * 'count', 'map' and 'forEach' each have a CharSequence overload that walks its
 * *characters*. '__arr' cannot answer that, because it has to read a bare
 * string as one value — that is what 'orEmpty()' hands it for an absent list —
 * so the helpers whose lambda is handed a Char ask this instead. Without it,
 * '"12a".all { it.isDigit() }' tests the whole string as one character, answers
 * for the first, and is a wrong branch rather than an error.
 */
function __chars(value) {
  return typeof value === 'string' ? value.split('') : __arr(value);
}

/**
 * Applies a lambda across a list, awaiting only when one actually suspended.
 *
 * A synchronous lambda must stay synchronous: making every helper return a
 * promise would push the async taint back into the emitted code, which is the
 * thing this whole runtime exists to avoid.
 */
function __each(list, fn) {
  var out = [];
  var suspended = false;
  for (var i = 0; i < list.length; i += 1) {
    var value = fn(list[i], i);
    if (__thenable(value)) suspended = true;
    out.push(value);
  }
  return suspended ? Promise.all(out) : out;
}

/**
 * A predicate's verdict, negated on the far side of a suspension.
 *
 * '!predicate(item)' is false for EVERY suspended lambda, because a Promise is
 * always truthy — so a helper written that way finds nothing, never
 * short-circuits, and answers 'all of them matched'. The negation has to happen
 * after the await, not before it.
 */
function __negate(verdict) {
  return __thenable(verdict)
    ? verdict.then(function (value) { return !value; })
    : !verdict;
}

/** The index of the first match, short-circuiting until a lambda suspends. */
function __firstIndex(items, predicate) {
  for (var i = 0; i < items.length; i += 1) {
    var verdict = predicate(items[i]);
    if (__thenable(verdict)) {
      var pending = [verdict];
      for (var j = i + 1; j < items.length; j += 1) pending.push(predicate(items[j]));
      var from = i;
      return Promise.all(pending).then(function (flags) {
        for (var k = 0; k < flags.length; k += 1) if (flags[k]) return from + k;
        return -1;
      });
    }
    if (verdict) return i;
  }
  return -1;
}

/** Whether a value is an instance of a converted class with this method. See __k.ownOr. */
function __ownsMethod(receiver, name) {
  if (receiver === null || typeof receiver !== 'object') return false;
  if (Array.isArray(receiver) || receiver instanceof Map || receiver instanceof Set) return false;
  if (receiver instanceof Date || receiver instanceof RegExp || receiver instanceof Promise) return false;
  var proto = Object.getPrototypeOf(receiver);
  if (proto === null || proto === Object.prototype) return false;
  return typeof receiver[name] === 'function';
}

function __str(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** What a catching map leaves where an element's lambda threw. */
var __SKIPPED = { skipped: true };

/**
 * Applies a lambda across a list, surviving the ones that throw.
 *
 * A rejected promise counts: the lambda a suspending function became reports
 * its failure that way, and a rejection that escaped here would fail the whole
 * page rather than the one element that could not be resolved.
 */
function __catching(list, fn) {
  var out = [];
  var suspended = false;
  for (var i = 0; i < list.length; i += 1) {
    try {
      var value = fn(list[i], i);
      if (__thenable(value)) {
        suspended = true;
        value = value.then(
          function (resolved) { return resolved; },
          function () { return __SKIPPED; }
        );
      }
      out.push(value);
    } catch (error) {
      out.push(__SKIPPED);
    }
  }
  return suspended ? Promise.all(out) : out;
}

/**
 * A value built by buildJsonObject / buildJsonArray, marked as its own.
 *
 * The mark says 'these keys were written in the extension's own source', which
 * is what lets toJsonRequestBody serialise it with no @Serializable descriptor
 * to consult. It is non-enumerable, so JSON.stringify never sees it and it
 * cannot arrive at somebody's server as a field.
 */
function __marked(value) {
  Object.defineProperty(value, '__kJson', { value: true, enumerable: false });
  return value;
}

function __isJson(value) {
  return value !== null && value !== undefined && value.__kJson === true;
}

/** A JSON value, which in this runtime is the plain value it already is. */
function __jsonOf(value) {
  return value === undefined ? null : value;
}

/** The message half of require / requireNotNull, evaluated only on failure. */
function __requireMessage(lazyMessage, fallback) {
  if (lazyMessage === undefined || lazyMessage === null) return fallback;
  var text = typeof lazyMessage === 'function' ? lazyMessage() : lazyMessage;
  return __str(text).length > 0 ? __str(text) : fallback;
}

/**
 * A Kotlin Result, which is what runCatching answers with.
 *
 * Built here rather than inside 'runCatching' because 'map', 'recover' and
 * 'fold' have to produce one too, and a Result each of them spelled slightly
 * differently would answer a different set of method names depending on where
 * it came from. The '__kResult' mark is how the helpers that are *also* list
 * helpers — 'map', 'fold' — tell a Result from a list.
 */
function __success(value) {
  return {
    __kResult: true,
    __value: value,
    __error: null,
    isSuccess: true,
    isFailure: false,
    getOrNull: function () { return value; },
    getOrThrow: function () { return value; },
    getOrElse: function () { return value; },
    getOrDefault: function () { return value; },
    exceptionOrNull: function () { return null; }
  };
}

function __failure(error) {
  return {
    __kResult: true,
    __value: null,
    __error: error,
    isSuccess: false,
    isFailure: true,
    getOrNull: function () { return null; },
    getOrThrow: function () { throw error; },
    getOrElse: function (recover) { return typeof recover === 'function' ? recover(error) : recover; },
    getOrDefault: function (fallback) { return fallback; },
    exceptionOrNull: function () { return error; }
  };
}

function __isResult(value) {
  return value !== null && value !== undefined && value.__kResult === true;
}

/** Kotlin's null, and JavaScript's undefined, are the same absence here. */
function __present(value) {
  return value !== null && value !== undefined;
}

/** Kotlin's natural ordering, for the two types a scraper ever sorts by. */
function __cmp(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : (a > b ? 1 : 0);
  // A java.time value orders by its own compareTo — by instant, or by date —
  // where the string fallback below would order '2024-10-01' after '2024-9-…'.
  if (a !== null && a !== undefined && a.__kTime === true && typeof a.compareTo === 'function') {
    var order = a.compareTo(b);
    return order < 0 ? -1 : (order > 0 ? 1 : 0);
  }
  // Kotlin's Boolean is Comparable and false sorts before true, which is the
  // whole point of 'compareBy { it.title.contains(quality) }' — the falses go
  // first and the caller reverses. Spelled out rather than left to the string
  // path below, which agrees only by the accident of 'false' < 'true'.
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : (a ? 1 : -1);
  var x = __str(a);
  var y = __str(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

/**
 * The first non-null result of a lambda, short-circuiting until one suspends.
 *
 * The same shape as '__firstIndex' and for the same reason: a lambda that
 * suspended cannot be tested for truthiness, and a Promise is always truthy —
 * so once one suspends the rest are started and the answer is awaited.
 */
function __firstPresent(items, fn) {
  for (var i = 0; i < items.length; i += 1) {
    var value = fn(items[i], i);
    if (__thenable(value)) {
      var pending = [value];
      for (var j = i + 1; j < items.length; j += 1) pending.push(fn(items[j], j));
      return Promise.all(pending).then(function (values) {
        for (var k = 0; k < values.length; k += 1) if (__present(values[k])) return values[k];
        return null;
      });
    }
    if (__present(value)) return value;
  }
  return null;
}

/**
 * Kotlin's '==', which is structural where JavaScript's '===' is not.
 *
 * 'listOf(1, 2) == listOf(1, 2)' is true in Kotlin and false for two JavaScript
 * arrays, and the same goes for a data class and a Pair. Comparing by
 * identity would answer 'not equal' for two values Kotlin calls equal, which is
 * a wrong branch rather than an error.
 */
function __equal(a, b) {
  if (a === b) return true;
  if (!__present(a) || !__present(b)) return !__present(a) && !__present(b);
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) if (!__equal(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return false;
    var same = true;
    a.forEach(function (item) { if (!b.has(item)) same = false; });
    return same;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    var agrees = true;
    a.forEach(function (value, key) { if (!b.has(key) || !__equal(value, b.get(key))) agrees = false; });
    return agrees;
  }
  var keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (var j = 0; j < keys.length; j += 1) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[j])) return false;
    if (!__equal(a[keys[j]], b[keys[j]])) return false;
  }
  return true;
}

/**
 * Character classes, Unicode-wide where the engine can and ASCII where it cannot.
 *
 * Kotlin's 'Char.isDigit()' is every Unicode Nd, not '0'..'9', and an extension
 * stripping digits out of an Arabic-Indic title would keep them if this were
 * ASCII-only. The classes are therefore built with 'new RegExp' inside a
 * try/catch rather than written as literals: a build whose engine lacks
 * '\\p{...}' would otherwise fail to *parse* this file, taking the whole bundle
 * down at load rather than narrowing one predicate.
 */
function __charClass(unicode, ascii) {
  try {
    return new RegExp(unicode, 'u');
  } catch (error) {
    return new RegExp(ascii);
  }
}

var __IS_DIGIT = __charClass('^\\\\p{Nd}$', '^[0-9]$');
var __IS_LETTER = __charClass('^\\\\p{L}$', '^[A-Za-z]$');
var __IS_LETTER_OR_DIGIT = __charClass('^[\\\\p{L}\\\\p{Nd}]$', '^[A-Za-z0-9]$');

/**
 * The one walker behind trim, trimStart and trimEnd.
 *
 * All three take Kotlin's vararg of Chars or a predicate, and all three fall
 * back to whitespace when handed neither — which is the only case JavaScript's
 * own methods cover.
 */
function __trimEnds(value, given, fromStart, fromEnd) {
  var text = __str(value);
  var wanted = given.filter(function (one) { return one !== undefined && one !== null; });
  if (wanted.length === 0) {
    if (fromStart && fromEnd) return text.trim();
    return fromStart ? text.replace(/^\\s+/, '') : text.replace(/\\s+$/, '');
  }
  var keep;
  if (wanted.length === 1 && typeof wanted[0] === 'function') {
    var predicate = wanted[0];
    keep = function (ch) { return !predicate(ch); };
  } else {
    var set = [];
    for (var g = 0; g < wanted.length; g += 1) {
      var one = wanted[g];
      if (typeof one === 'string') set = set.concat(one.split(''));
      else set = set.concat(__arr(one));
    }
    keep = function (ch) { return set.indexOf(ch) === -1; };
  }
  var start = 0;
  var end = text.length;
  if (fromStart) while (start < end && !keep(text.charAt(start))) start += 1;
  if (fromEnd) while (end > start && !keep(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/** A Kotlin Char, which this runtime spells as a one-character string. */
/** A Kotlin Pair, which is a two-element array carrying first and second. */
/**
 * okio's ByteString, as the bytes with its readers on them: 'utf8()',
 * 'toByteArray()', 'hex()', 'base64()' and 'size'. Non-enumerable, so the
 * value is still the Uint8Array every byte helper here already reads.
 */
function __byteString(bytes) {
  var readers = {
    utf8: function () { return __host().text.decode(bytes); },
    toByteArray: function () { return bytes.slice(); },
    hex: function () {
      var out = '';
      for (var i = 0; i < bytes.length; i += 1) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
      return out;
    },
    base64: function () { return __host().bytes.toBase64(bytes); }
  };
  for (var name in readers) {
    Object.defineProperty(bytes, name, { value: readers[name], enumerable: false });
  }
  Object.defineProperty(bytes, 'size', { get: function () { return bytes.length; }, enumerable: false });
  return bytes;
}

function __component(value, n) {
  if (value !== null && value !== undefined && typeof value['component' + n] === 'function' &&
      !Array.isArray(value)) {
    return value['component' + n]();
  }
  var parts = __k.destructured(value);
  if (n > parts.length) {
    throw new Error('This converted extension asked for component' + n + ' of a value with ' + parts.length + '.');
  }
  return parts[n - 1];
}

function __isPair(value) {
  return Array.isArray(value) && value.length === 2 &&
    Object.prototype.hasOwnProperty.call(value, 'first');
}

/**
 * Whether a '+' or '-' operand is a collection of elements or one element.
 *
 * A string is one element (a String in a List<String>), and so is a Pair and a
 * Map: none of the three is an Iterable in Kotlin, whatever it is here.
 */
function __isCollection(value) {
  if (value === null || value === undefined || typeof value !== 'object') return false;
  if (__isPair(value) || value instanceof Map) return false;
  return Array.isArray(value) || value instanceof Set ||
    typeof value.toArray === 'function' || typeof value[Symbol.iterator] === 'function';
}

function __isChar(value) {
  return typeof value === 'string' && value.length === 1;
}

function __charRange(from, to, inclusive) {
  var out = [];
  var end = to.charCodeAt(0) - (inclusive === 1 ? 0 : 1);
  for (var code = from.charCodeAt(0); code <= end; code += 1) out.push(String.fromCharCode(code));
  return out;
}

/** The single character a Char helper was handed, or '' if it was handed none. */
function __char(value) {
  var text = __str(value);
  return text.length === 0 ? '' : text.charAt(0);
}

/**
 * A Comparator, which is a function this runtime has to tell from a lambda.
 *
 * 'sortedWith', 'thenBy' and 'reversed' all take or return one, and 'reversed'
 * is also a list helper — so a comparator carries a mark rather than being
 * guessed at by arity.
 */
function __comparator(compare) {
  compare.__isComparator = true;
  return compare;
}

function __isComparator(value) {
  return typeof value === 'function' && value.__isComparator === true;
}

/** compareBy / compareByDescending, over one selector or several. */
function __byKeys(selectors, sign) {
  return __comparator(function (a, b) {
    for (var i = 0; i < selectors.length; i += 1) {
      var pick = selectors[i];
      var delta = __isComparator(pick) ? pick(a, b) : __cmp(pick(a), pick(b));
      if (delta !== 0) return sign * delta;
    }
    return 0;
  });
}

/**
 * The type names this runtime can actually decide.
 *
 * A data class has no runtime existence after translation, so 'x as Episode'
 * names a type nothing here can check. Deciding it 'false' would turn every
 * such cast into a failure the original never had, so an unknown name is
 * answered by letting the value through — the Kotlin compiler already proved
 * that cast; this runtime is not re-proving it.
 */
var __TYPES = {
  String: function (v) { return typeof v === 'string'; },
  Int: function (v) { return typeof v === 'number' && Number.isInteger(v); },
  Long: function (v) { return typeof v === 'number' && Number.isInteger(v); },
  Double: function (v) { return typeof v === 'number'; },
  Float: function (v) { return typeof v === 'number'; },
  Number: function (v) { return typeof v === 'number'; },
  Boolean: function (v) { return typeof v === 'boolean'; },
  List: function (v) { return Array.isArray(v); },
  MutableList: function (v) { return Array.isArray(v); },
  Collection: function (v) { return Array.isArray(v) || v instanceof Set; },
  Array: function (v) { return Array.isArray(v); },
  Set: function (v) { return v instanceof Set; },
  MutableSet: function (v) { return v instanceof Set; },
  Map: function (v) { return v instanceof Map; },
  MutableMap: function (v) { return v instanceof Map; },
  // Not an array: the shim's Elements is one, and carries jsoup's list methods
  // (select among them), but in Kotlin an Elements is never an Element.
  Element: function (v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.select === 'function';
  },
  // A Document is an Element with a location; the jsoup shim gives one only to
  // the document. Told apart because Madara declares mangaDetailsParse over
  // both a Response and a Document, and the overload dispatcher has to know
  // which it was handed.
  Document: function (v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.select === 'function' &&
      typeof v.location === 'function';
  },
  // jsoup's Elements, which the shim's select answers as a plain array — so
  // an Element (which has select) and an Elements (which does not) are never
  // both, which is what MangaThemesia's Element.imgAttr / Elements.imgAttr pair
  // needs told apart.
  Elements: function (v) { return Array.isArray(v); },
  // jsoup's character nodes, as childNodes() and previousSibling() hand them
  // out. Unlisted, 'node is TextNode' was answered true for every node — an
  // element included — which is the let-it-through default above, and wrong
  // for exactly the loop that asks it: text appended, elements handled apart.
  TextNode: function (v) { return v !== null && typeof v === 'object' && v.kind === 'text' && typeof v.getWholeText === 'function'; },
  DataNode: function (v) { return v !== null && typeof v === 'object' && v.kind === 'data' && typeof v.getWholeText === 'function'; },
  // okhttp's Headers, by the shape __headersObject builds: the builder and the
  // name list together, which no Map, list or model has.
  Headers: function (v) {
    return v !== null && typeof v === 'object' && typeof v.newBuilder === 'function' &&
      typeof v.names === 'function' && typeof v.get === 'function';
  },
  // okhttp's Response, by the shape __responseOf builds.
  Response: function (v) {
    return v !== null && typeof v === 'object' && typeof v.code === 'number' &&
      v.body !== null && typeof v.body === 'object' && v.request !== undefined;
  },

  // The model types, recognised by shape rather than by constructor: they are
  // built in a later section, and a type table that reached forward into it
  // would break the moment a conversion left that section out.
  SAnime: function (v) { return __has(v, 'thumbnail_url') && __has(v, 'title'); },
  SManga: function (v) { return __has(v, 'thumbnail_url') && __has(v, 'title'); },
  SEpisode: function (v) { return __has(v, 'episode_number'); },
  Video: function (v) { return __has(v, 'videoUrl') && __has(v, 'quality'); },
  Track: function (v) { return __has(v, 'lang') && __has(v, 'url') && !__has(v, 'quality'); },
  AnimeFilter: function (v) { return __has(v, 'name') && __has(v, 'state'); },

  // org.json, which this runtime parses into plain values. 'parsed !is
  // JSONObject' after a JSONTokener is how an extension tells an error envelope
  // from a list, so the two have to be distinguishable and an array is not one.
  JSONObject: function (v) { return typeof v === 'object' && !Array.isArray(v) && !(v instanceof Map); },
  JSONArray: function (v) { return Array.isArray(v); },
  // kotlinx's JsonElement family, over the same plain values. JsonNull (and
  // so JsonPrimitive and JsonElement) is also true of null, which '__isType'
  // answers before it gets here — see '__jeKind'.
  JsonElement: function (v) { return __jeKind(v) !== 'other'; },
  JsonObject: function (v) { return __jeKind(v) === 'object'; },
  JsonArray: function (v) { return __jeKind(v) === 'array'; },
  JsonPrimitive: function (v) { return __jeKind(v) === 'primitive'; },
  JsonNull: function () { return false; },
  // What a KSerializer's 'deserialize' is handed: see '__jsonDecoder'.
  JsonDecoder: function (v) { return v.__kJsonDecoder === true; },
  Decoder: function (v) { return v.__kJsonDecoder === true; }
};

/**
 * What a plain value is, read as a kotlinx JsonElement: 'object', 'array',
 * 'primitive', 'null' (JSON's null, which is JS null — an absent key is
 * undefined and is Kotlin's null, not JsonNull), or 'other' for anything JSON
 * cannot hold. A record a '@Serializable' class decoded into is an object; a
 * Map or a class instance with methods is not JSON.
 */
function __jeKind(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'other';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return 'primitive';
  }
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object' && !(value instanceof Map) && !(value instanceof Set)) return 'object';
  return 'other';
}

var __JE_NONE = {};

/**
 * The receiver's own answer to a property of this name, or __JE_NONE when it
 * is to be read as JSON.
 *
 * A property the receiver has, own or inherited, is its answer. So is a
 * record's *absent* field for every name but the four that are JSON's alone:
 * a JsonObject has no 'content' or 'int', so a plain object asked for one is
 * a DTO whose optional field was not in the payload, and that read answered
 * undefined before this existed and must still. A value JSON cannot hold — a
 * Map, a class the runtime built, undefined — is read exactly as it was too.
 */
var __JE_OWN_NAMES = { jsonObject: true, jsonArray: true, jsonPrimitive: true, jsonNull: true };
function __jeOwn(value, name) {
  if (value !== null && value !== undefined && typeof value === 'object' && name in value) {
    return value[name];
  }
  var kind = __jeKind(value);
  if (kind === 'other' || (kind === 'object' && __JE_OWN_NAMES[name] !== true)) return value[name];
  return __JE_NONE;
}

function __jeWrongKind(value, wanted) {
  var kind = __jeKind(value);
  var had = kind === 'null' ? 'JsonNull' : kind === 'object' ? 'JsonObject' :
    kind === 'array' ? 'JsonArray' : kind === 'primitive' ? 'JsonPrimitive' : 'not JSON';
  throw new Error('This converted extension read a ' + had + ' as a ' + wanted + '.');
}

/** A primitive's content, as kotlinx spells it: the literal's text. */
function __jeContent(value, asked) {
  var kind = __jeKind(value);
  if (kind === 'null') return 'null';
  if (kind !== 'primitive') __jeWrongKind(value, 'JsonPrimitive (for ' + asked + ')');
  return String(value);
}

/** '.int', '.doubleOrNull' and the rest: the content, parsed, or null/throw. */
function __jeNumber(value, name, whole, orNull) {
  var own = __jeOwn(value, name);
  if (own !== __JE_NONE) return own;
  var kind = __jeKind(value);
  if (kind === 'null') {
    if (orNull) return null;
    throw new Error('This converted extension read JsonNull as a number (' + name + ').');
  }
  var text = __jeContent(value, name);
  var number = typeof value === 'number' ? value : (/^\s*$/.test(text) ? NaN : Number(text));
  var fits = Number.isFinite(number) && (!whole || Number.isInteger(number));
  if (fits) return number;
  if (orNull) return null;
  throw new Error('This converted extension read "' + text.slice(0, 24) + '" as a number (' + name + ').');
}

/**
 * 'JsonObject.get(key)' for the keyed readers: undefined for an absent key,
 * null for JSON null, and a throw for a receiver that is not a JsonObject.
 * A Map is one — kotlinx's untyped decode answers a Map for an object.
 */
function __jeFieldOf(value, key, name) {
  if (value instanceof Map) return value.get(key);
  if (__jeKind(value) !== 'object') __jeWrongKind(value, 'JsonObject (for ' + name + ')');
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** 'getValue(key)', which is NoSuchElementException for an absent key. */
function __jeRequiredField(value, key, name) {
  var found = __jeFieldOf(value, key, name);
  if (found === undefined) {
    throw new Error('This converted extension asked for a required JSON field "' + __str(key) + '".');
  }
  return found;
}

/** 'get(key)?.jsonPrimitive': undefined when absent, a throw for an object or array. */
function __jePrimitiveAt(value, key, name) {
  var found = __jeFieldOf(value, key, name);
  if (found === undefined) return undefined;
  var kind = __jeKind(found);
  if (kind !== 'primitive' && kind !== 'null') __jeWrongKind(found, 'JsonPrimitive (for ' + name + ')');
  return found;
}

/** '.boolean' is kotlinx's toBooleanStrict: exactly "true" or "false". */
function __jeBoolean(value, name, orNull) {
  var own = __jeOwn(value, name);
  if (own !== __JE_NONE) return own;
  if (__jeKind(value) === 'null') {
    if (orNull) return null;
    throw new Error('This converted extension read JsonNull as a boolean.');
  }
  var text = __jeContent(value, name);
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (orNull) return null;
  throw new Error('This converted extension read "' + text.slice(0, 24) + '" as a boolean.');
}

/**
 * Whether each argument fits its parameter, where this runtime can decide.
 *
 * Three things are decidable. A type in __TYPES. A function type — written
 * with its arrow, '(Headers,String)->Headers' — which is a JavaScript
 * function or nothing. And a slot that was skipped: a call with named
 * arguments arrives with undefined wherever the caller left a parameter out,
 * which only a parameter with a default permits. That last one is what tells
 * PlaylistUtils' two extractFromHls apart: 'masterHeaders: Headers' has no
 * default, 'masterHeadersGen: (…) -> Headers' does, and a call naming neither
 * is the second — taken as the first, it called itself for ever.
 */
function __overloadAccepts(entry, args) {
  var types = entry[3];
  var nullable = entry[4];
  var defaults = entry[5] || [];
  for (var i = 0; i < types.length; i += 1) {
    var value = i < args.length ? args[i] : undefined;
    var type = String(types[i]);
    if (value === undefined) {
      if (defaults[i] !== true && nullable[i] !== true) return false;
      continue;
    }
    if (value === null) {
      if (nullable[i] !== true && (__knownType(type) || type.indexOf('->') !== -1)) return false;
      continue;
    }
    if (type.indexOf('->') !== -1) {
      if (typeof value !== 'function') return false;
      continue;
    }
    if (__knownType(type) && !__isType(value, type)) return false;
  }
  return true;
}

/**
 * How specifically a declaration fits: a decided type beats an undecided one,
 * a Document beats the Element it also is, and an exact count beats a default.
 */
function __overloadRank(entry, args) {
  var score = entry[2] === args.length ? 1 : 0;
  var types = entry[3];
  for (var i = 0; i < args.length && i < types.length; i += 1) {
    if (types[i] === 'Any' || args[i] === undefined) continue;
    if (__knownType(types[i]) || String(types[i]).indexOf('->') !== -1) score += 4;
    if (types[i] === 'Document') score += 2;
  }
  return score;
}

function __has(value, name) {
  return value !== null && value !== undefined && typeof value === 'object' &&
    Object.prototype.hasOwnProperty.call(value, name);
}

function __knownType(type) {
  if (typeof type === 'function') return true;
  return Object.prototype.hasOwnProperty.call(__TYPES, __str(type));
}

function __isType(value, type) {
  // JSON's null is a JsonNull, and so a JsonPrimitive and a JsonElement. It is
  // JS null here, where Kotlin's null — an absent key — is undefined.
  if (value === null && (type === 'JsonNull' || type === 'JsonPrimitive' || type === 'JsonElement')) {
    return true;
  }
  if (value === null || value === undefined) return false;
  if (typeof type === 'function') return value instanceof type;
  var check = __TYPES[__str(type)];
  return check === undefined ? false : check(value);
}

/** Write a sorted copy back into a MutableList, answering Unit. */
function __sortInPlace(list, sorted) {
  if (!Array.isArray(list)) {
    throw new Error('This converted extension sorted something that is not a mutable list.');
  }
  for (var i = 0; i < sorted.length; i += 1) list[i] = sorted[i];
  return undefined;
}

/** An array that also answers to a MutableList's method names. */
function __mutableList(items) {
  function define(name, value) {
    Object.defineProperty(items, name, { value: value, enumerable: false, writable: true });
  }
  define('add', function (item) { items.push(item); return true; });
  define('addAll', function (more) {
    var incoming = __arr(more);
    for (var i = 0; i < incoming.length; i += 1) items.push(incoming[i]);
    return incoming.length > 0;
  });
  define('remove', function (item) {
    var index = items.indexOf(item);
    if (index === -1) return false;
    items.splice(index, 1);
    return true;
  });
  define('clear', function () { items.length = 0; });
  define('isEmpty', function () { return items.length === 0; });
  return items;
}

/** A Map that also answers to Kotlin's names for the same operations. */
function __mutableMap(map) {
  map.put = function (key, value) { map.set(key, value); return map; };
  map.containsKey = function (key) { return map.has(key); };
  map.remove = function (key) { return map.delete(key); };
  map.isEmpty = function () { return map.size === 0; };
  return map;
}

function __parseDoc(html, baseUrl) {
  if (__kdom === null) {
    throw new Error(
      'This converted extension parsed HTML, but its bundle was built without the jsoup runtime.'
    );
  }
  return __kdom.parseHtml(__str(html), __str(baseUrl));
}

/* --- regex: java.util.regex, translated or refused ------------------------ */

function __regexRefusal(what, pattern) {
  var error = new Error(
    'This converted extension uses ' + what + ', which the plugin engine subset does not ' +
    'allow (ABI.md section 6). The pattern was: ' + pattern
  );
  // Marked so __KRegex can name the extension's own declaration on the way out.
  // A refusal reported by pattern text alone is the one part of the failure a
  // maintainer cannot grep the Kotlin for: the source spells it with Kotlin's
  // escaping, and by the time it reaches here it is spelled with the engine's.
  error.__regexRefusal = true;
  return error;
}

/** A refusal, re-thrown against the member the extension declared it as. */
function __regexRefusalAt(error, declaredAt) {
  if (declaredAt.length === 0 || !error || error.__regexRefusal !== true) return error;
  var named = new Error(error.message + ' It was declared as ' + declaredAt + '.');
  named.__regexRefusal = true;
  return named;
}

var __REGEX_OPTIONS = {
  IGNORE_CASE: 'i',
  MULTILINE: 'm',
  DOT_MATCHES_ALL: 's',
  UNIX_LINES: '',
  LITERAL: '',
  COMMENTS: null,
  CANON_EQ: null
};

/** Escapes a run of text that Java quoted with \\\\Q ... \\\\E. */
function __regexQuote(text) {
  return text.replace(/[.*+?^\${}()|[\\]\\\\\\/]/g, '\\\\$&');
}

/**
 * Translates a Java pattern to a JavaScript one, or refuses.
 *
 * Refusing is the point. Lookbehind is unavailable on at least one of the three
 * engines a bundle runs on; \\p{...} classes and possessive quantifiers have no
 * JavaScript spelling that matches identically. Emitting them anyway produces a
 * pattern that either throws at load or, worse, matches something else.
 */
function __regexSource(pattern) {
  var text = String(pattern);
  var flags = '';

  // Java writes inline flags where JavaScript writes a flag on the literal.
  var lead = /^\\(\\?([a-zA-Z]+)\\)/.exec(text);
  if (lead !== null) {
    for (var f = 0; f < lead[1].length; f += 1) {
      var letter = lead[1].charAt(f);
      if (letter === 'i') flags += 'i';
      else if (letter === 'm') flags += 'm';
      else if (letter === 's') flags += 's';
      else if (letter !== 'd' && letter !== 'u') throw __regexRefusal('the inline flag (?' + letter + ')', text);
    }
    text = text.slice(lead[0].length);
  }

  var out = '';
  var inClass = false;
  var quantified = false;
  var i = 0;

  while (i < text.length) {
    var ch = text.charAt(i);

    if (ch === '\\\\') {
      var next = text.charAt(i + 1);
      if (next === 'p' || next === 'P') {
        var named = __regexNamedClass(text, i, next === 'P', inClass);
        if (named === null) throw __regexRefusal('a \\\\p{...} Unicode class', pattern);
        out += named.text;
        if (named.unicode && flags.indexOf('u') === -1) flags += 'u';
        i = named.end;
        quantified = false;
        continue;
      }
      if (next === 'Q') {
        var end = text.indexOf('\\\\E', i + 2);
        var literal = end === -1 ? text.slice(i + 2) : text.slice(i + 2, end);
        out += __regexQuote(literal);
        i = end === -1 ? text.length : end + 2;
        quantified = false;
        continue;
      }
      // \\A and \\z anchor the whole input in Java; ^ and $ do the same here
      // because no multiline flag is set unless the pattern asked for one.
      if (next === 'A') { out += '^'; i += 2; quantified = false; continue; }
      if (next === 'z' || next === 'Z') { out += '$'; i += 2; quantified = false; continue; }
      out += ch + next;
      i += 2;
      quantified = false;
      continue;
    }

    if (inClass) {
      if (ch === ']') inClass = false;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === '[') {
      inClass = true;
      out += ch;
      i += 1;
      quantified = false;
      continue;
    }

    if (ch === '(') {
      var head4 = text.substr(i, 4);
      // Lookbehind passes through: Java and JavaScript spell it the same way,
      // and Java's is the bounded-width one, so anything Java accepted this
      // engine accepts. It was refused here for the three-engine world of
      // ADR-0002 section 2.3, which ADR-0003 section 2.2 repealed — every
      // surface is now a full browser engine. episode-recognition.ts has used
      // one on every episode list since; refusing a converted extension for
      // the same construct was this runtime disagreeing with itself.
      if (text.substr(i, 3) === '(?>') throw __regexRefusal('an atomic group', pattern);
      out += ch;
      i += 1;
      quantified = false;
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?') {
      if (quantified) {
        // 'a+?' is lazy and fine; 'a++' and 'a*+' are possessive and are not.
        if (ch !== '?') throw __regexRefusal('a possessive quantifier', pattern);
        out += ch;
        i += 1;
        quantified = false;
        continue;
      }
      out += ch;
      i += 1;
      quantified = true;
      continue;
    }

    if (ch === '{') {
      var repeat = /^\\{[0-9]+(,[0-9]*)?\\}/.exec(text.slice(i));
      if (repeat !== null) {
        out += repeat[0];
        i += repeat[0].length;
        quantified = true;
        continue;
      }
    }

    out += ch;
    i += 1;
    quantified = false;
  }

  // A general category needs Unicode mode, which is stricter about escapes
  // than the mode everything else here was written for. A pattern it rejects
  // is refused, never compiled without the flag: without it '\\\\p{L}' is the
  // letter 'p', which matches something else.
  if (flags.indexOf('u') !== -1) {
    try {
      new RegExp(out, flags);
    } catch (error) {
      throw __regexRefusal('a \\\\p{...} Unicode class in a pattern Unicode mode rejects', pattern);
    }
  }

  return { source: out, flags: flags };
}

/*
 * Java's named classes that have a JavaScript spelling matching identically.
 *
 * - General categories ('L', 'Lu', 'Mn' …, also 'IsL' and 'gc=L') are the same
 *   Unicode property in both, so they pass through as '\\\\p{L}' under the
 *   'u' flag.
 * - POSIX names ('Alpha', 'Punct' …) are US-ASCII in Java unless the pattern
 *   asks for UNICODE_CHARACTER_CLASS, which the subset has no option for, so
 *   they are these exact ranges.
 * - A block ('InCombiningDiacriticalMarks') is a fixed code-point range. Only
 *   the blocks the catalogue was measured using are listed; any other name is
 *   refused as before rather than guessed.
 *
 * Scripts ('IsLatin'), the 'java*' methods and anything else stay refused.
 */
var __REGEX_CATEGORIES = [
  'L', 'Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'LC', 'M', 'Mn', 'Mc', 'Me', 'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'S', 'Sm', 'Sc', 'Sk', 'So',
  'Z', 'Zs', 'Zl', 'Zp', 'C', 'Cc', 'Cf', 'Co', 'Cs', 'Cn'
];

var __REGEX_POSIX = {
  Lower: [[0x61, 0x7a]],
  Upper: [[0x41, 0x5a]],
  ASCII: [[0x00, 0x7f]],
  Alpha: [[0x41, 0x5a], [0x61, 0x7a]],
  Digit: [[0x30, 0x39]],
  Alnum: [[0x30, 0x39], [0x41, 0x5a], [0x61, 0x7a]],
  Punct: [[0x21, 0x2f], [0x3a, 0x40], [0x5b, 0x60], [0x7b, 0x7e]],
  Graph: [[0x21, 0x7e]],
  Print: [[0x20, 0x7e]],
  Blank: [[0x09, 0x09], [0x20, 0x20]],
  Cntrl: [[0x00, 0x1f], [0x7f, 0x7f]],
  XDigit: [[0x30, 0x39], [0x41, 0x46], [0x61, 0x66]],
  Space: [[0x09, 0x0d], [0x20, 0x20]]
};

/* Keyed by the name with case, spaces, '_' and '-' removed, as Java matches it. */
var __REGEX_BLOCKS = {
  COMBININGDIACRITICALMARKS: [[0x0300, 0x036f]],
  HANGULSYLLABLES: [[0xac00, 0xd7af]]
};

function __regexCodeUnit(code) {
  var hex = code.toString(16);
  while (hex.length < 4) hex = '0' + hex;
  return '\\\\u' + hex;
}

/** The class at text[at] ('\\\\p' or '\\\\P'), or null to refuse it. */
function __regexNamedClass(text, at, negated, inClass) {
  var name;
  var end;
  if (text.charAt(at + 2) === '{') {
    var close = text.indexOf('}', at + 3);
    if (close === -1) return null;
    name = text.slice(at + 3, close);
    end = close + 1;
  } else {
    name = text.charAt(at + 2);
    end = at + 3;
  }

  var category = name.replace(/^(Is|gc=|general_category=)/, '');
  if (__REGEX_CATEGORIES.indexOf(category) !== -1) {
    return { text: (negated ? '\\\\P{' : '\\\\p{') + category + '}', end: end, unicode: true };
  }

  var ranges = null;
  if (Object.prototype.hasOwnProperty.call(__REGEX_POSIX, name)) {
    ranges = __REGEX_POSIX[name];
  } else {
    var block = /^(In|block=|blk=)(.+)$/.exec(name);
    var key = block === null ? '' : block[2].replace(/[ _-]/g, '').toUpperCase();
    if (block !== null && Object.prototype.hasOwnProperty.call(__REGEX_BLOCKS, key)) {
      ranges = __REGEX_BLOCKS[key];
    }
  }
  if (ranges === null) return null;
  // A negated range cannot be written inside a class that is already open.
  if (negated && inClass) return null;

  var body = '';
  for (var r = 0; r < ranges.length; r += 1) {
    body += ranges[r][0] === ranges[r][1]
      ? __regexCodeUnit(ranges[r][0])
      : __regexCodeUnit(ranges[r][0]) + '-' + __regexCodeUnit(ranges[r][1]);
  }
  return { text: inClass ? body : (negated ? '[^' : '[') + body + ']', end: end, unicode: false };
}

function __regexFlags(base, extra) {
  var out = base;
  for (var i = 0; i < extra.length; i += 1) {
    if (out.indexOf(extra.charAt(i)) === -1) out += extra.charAt(i);
  }
  return out;
}

/** Kotlin's MatchResult, including the '' that an unmatched group reads as. */
function __match(found, input, regex) {
  if (found === null || found === undefined) return null;

  var values = [];
  var groups = [];
  for (var i = 0; i < found.length; i += 1) {
    values.push(found[i] === undefined ? '' : found[i]);
    groups.push(found[i] === undefined ? null : { value: found[i] });
  }
  if (found.groups) {
    for (var name in found.groups) {
      if (Object.prototype.hasOwnProperty.call(found.groups, name)) {
        groups[name] = found.groups[name] === undefined ? null : { value: found.groups[name] };
      }
    }
  }

  return {
    value: found[0],
    range: { first: found.index, last: found.index + found[0].length - 1 },
    groupValues: values,
    groups: groups,
    destructured: values.slice(1),
    next: function () {
      return regex.find(input, found.index + (found[0].length === 0 ? 1 : found[0].length));
    }
  };
}

/**
 * kotlin.text.Regex, over a translated pattern — translated on first *use*.
 *
 * Constructing eagerly is what a reader expects and it is wrong here. This
 * ecosystem declares its patterns as top-level or companion \`val\`s, so an
 * inexpressible one (\\p{...}, a possessive quantifier, an atomic group) threw
 * while the module was still initialising: the whole bundle failed to load,
 * taking every entry point with it, over a pattern that \`searchCatalog\` may
 * never reach. Measured on the catalogue, one extension lost all four ABI calls
 * to a single pattern used only in a details parser.
 *
 * Deferring costs one branch per call and refuses in the member that actually
 * needed the pattern, which is where the failure can be read. It refuses no
 * less: nothing here compiles a pattern the subset forbids, and the refusal is
 * re-thrown on every use rather than cached away after the first.
 *
 * \`declaredAt\` is optional and names the Kotlin member or property the pattern
 * came from; the emitter passes it when it knows. See \`runtime-api.ts\`.
 */
function __KRegex(pattern, options, declaredAt) {
  this.pattern = String(pattern);
  this.__isRegex = true;
  this.__options = options;
  this.__declaredAt = typeof declaredAt === 'string' ? declaredAt : '';
  this.__ready = false;
  this.__source = '';
  this.__flags = '';
}

/** Translates, or refuses. Called by every method before it touches a pattern. */
__KRegex.prototype.__prepare = function () {
  if (this.__ready) return;
  var source;
  var flags;
  try {
    var translated = __regexSource(this.pattern);
    source = translated.source;
    flags = translated.flags;

    var declared = this.__options;
    if (declared !== null && declared !== undefined) {
      var names = Array.isArray(declared) ? declared : [declared];
      for (var i = 0; i < names.length; i += 1) {
        var option = names[i];
        var text = typeof option === 'string' ? option : __str(option && option.name);
        if (Object.prototype.hasOwnProperty.call(__REGEX_OPTIONS, text)) {
          var mapped = __REGEX_OPTIONS[text];
          if (mapped === null) throw __regexRefusal('the regex option ' + text, this.pattern);
          flags = __regexFlags(flags, mapped);
          continue;
        }
        // Already spelled as JavaScript flags, which is what the emitter writes.
        flags = __regexFlags(flags, text.replace(/[^gimsuy]/g, ''));
      }
    }
  } catch (error) {
    throw __regexRefusalAt(error, this.__declaredAt);
  }
  this.__source = source;
  this.__flags = flags.replace(/g/g, '');
  this.__ready = true;
};

__KRegex.prototype.__re = function (extra) {
  this.__prepare();
  return new RegExp(this.__source, __regexFlags(this.__flags, extra || ''));
};

__KRegex.prototype.__whole = function () {
  this.__prepare();
  return new RegExp('^(?:' + this.__source + ')$', this.__flags);
};

__KRegex.prototype.find = function (input, startIndex) {
  var text = __str(input);
  var re = this.__re('g');
  re.lastIndex = startIndex === undefined || startIndex === null ? 0 : Number(startIndex);
  return __match(re.exec(text), text, this);
};

__KRegex.prototype.findAll = function (input) {
  var text = __str(input);
  var re = this.__re('g');
  var out = [];
  var found = re.exec(text);
  while (found !== null) {
    out.push(__match(found, text, this));
    if (found[0].length === 0) re.lastIndex += 1;
    found = re.exec(text);
  }
  return out;
};

__KRegex.prototype.containsMatchIn = function (input) {
  return this.__re('').test(__str(input));
};

__KRegex.prototype.matches = function (input) {
  return this.__whole().test(__str(input));
};

__KRegex.prototype.matchEntire = function (input) {
  var text = __str(input);
  return __match(this.__whole().exec(text), text, this);
};

__KRegex.prototype.replace = function (input, replacement) {
  var text = __str(input);
  var self = this;
  if (typeof replacement === 'function') {
    return text.replace(this.__re('g'), function () {
      var args = Array.prototype.slice.call(arguments);
      var trailing = typeof args[args.length - 1] === 'object' ? 3 : 2;
      var found = args.slice(0, args.length - trailing);
      found.index = args[args.length - trailing];
      if (trailing === 3) found.groups = args[args.length - 1];
      return __str(replacement(__match(found, text, self)));
    });
  }
  // Java spells a named back-reference \${name}; JavaScript spells it $<name>.
  var spelled = __str(replacement).replace(/\\$\\{([A-Za-z][A-Za-z0-9]*)\\}/g, '$<$1>');
  return text.replace(this.__re('g'), spelled);
};

__KRegex.prototype.replaceFirst = function (input, replacement) {
  return __str(input).replace(this.__re(''), __str(replacement));
};

/**
 * A split by a JavaScript RegExp, honouring Kotlin's limit.
 *
 * With no limit this is what JavaScript already does. With one, the last part
 * is the REMAINDER OF THE INPUT — separators and all — which is why the parts
 * cannot be split first and rejoined afterwards: joining loses the text of
 * every separator it stitches back over, so 'a, b, c' limited to two came back
 * as ['a', 'b c'] with the commas silently deleted. Walking the matches keeps
 * the offsets, and the remainder is a slice of the original string.
 */
function __splitByRegExp(text, re, limit) {
  var max = limit === undefined || limit === null ? 0 : Number(limit);
  if (!Number.isFinite(max) || max <= 0) return text.split(re);

  var walker = new RegExp(re.source, re.flags.indexOf('g') === -1 ? re.flags + 'g' : re.flags);
  var parts = [];
  var start = 0;
  walker.lastIndex = 0;
  while (parts.length < max - 1) {
    var match = walker.exec(text);
    if (match === null) break;
    if (match[0].length === 0) {
      // A zero-width match would never advance lastIndex on its own.
      walker.lastIndex += 1;
      if (walker.lastIndex > text.length) break;
      continue;
    }
    parts.push(text.slice(start, match.index));
    start = match.index + match[0].length;
  }
  parts.push(text.slice(start));
  return parts;
}

__KRegex.prototype.split = function (input, limit) {
  return __splitByRegExp(__str(input), this.__re(''), limit);
};

__KRegex.prototype.toString = function () {
  return this.pattern;
};

/**
 * The options a scraper names, as the translator's own vocabulary.
 *
 * A scraper never constructs one of these; it writes RegexOption.IGNORE_CASE
 * and the translation maps it onto a flag — or refuses it, for the two Java has
 * and JavaScript cannot express.
 */
var RegexOption = {
  IGNORE_CASE: { name: 'IGNORE_CASE' },
  MULTILINE: { name: 'MULTILINE' },
  DOT_MATCHES_ALL: { name: 'DOT_MATCHES_ALL' },
  LITERAL: { name: 'LITERAL' },
  UNIX_LINES: { name: 'UNIX_LINES' },
  COMMENTS: { name: 'COMMENTS' },
  CANON_EQ: { name: 'CANON_EQ' }
};

/* --- java.text dates ------------------------------------------------------ */

var __MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];

var __MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function __monthIndex(name) {
  var wanted = __str(name).toLowerCase().replace(/[.,]/g, '');
  for (var i = 0; i < __MONTHS.length; i += 1) {
    if (__MONTHS[i] === wanted || __MONTHS_SHORT[i] === wanted) return i;
    if (wanted.length >= 3 && __MONTHS[i].indexOf(wanted) === 0) return i;
  }
  return -1;
}

/**
 * A locale, as far as a bundle can have one.
 *
 * 'Intl' is out of the engine subset (ABI.md section 6), so there is exactly
 * one set of month names here and it is English — which is what every
 * extension that parses a date passes anyway. A pattern in another language
 * fails to parse rather than parsing to the wrong date: SimpleDateFormat.parse
 * answers null for a month name it does not know, and the idiom around it is
 * '?.time ?: 0L'. That is the honest outcome, and it is why constructing a
 * non-English locale is allowed rather than refused — the extension gets no
 * date, not a date in the wrong year.
 *
 * It is a FUNCTION carrying the constants, not an object holding them, because
 * 'SimpleDateFormat("dd/MM/yy", Locale("pt", "BR"))' is ordinary in this
 * catalogue. An object literal there is 'Locale is not a function' at load,
 * which costs the bundle every entry point it had rather than one date.
 */
function Locale(language, country) {
  if (!(this instanceof Locale)) return new Locale(language, country);
  this.language = __str(language);
  this.country = country === undefined || country === null ? '' : __str(country);
}

Locale.prototype.getLanguage = function () { return this.language; };
Locale.prototype.getCountry = function () { return this.country; };
Locale.prototype.toString = function () {
  return this.country.length === 0 ? this.language : this.language + '_' + this.country;
};

Locale.ENGLISH = new Locale('en');
Locale.US = new Locale('en', 'US');
Locale.UK = new Locale('en', 'GB');
Locale.ROOT = new Locale('');
Locale.getDefault = function () { return Locale.ENGLISH; };
Locale.forLanguageTag = function (tag) {
  var parts = __str(tag).split(/[-_]/);
  return new Locale(parts[0], parts[1]);
};

/**
 * The language names this ecosystem serves, and why the list stops there.
 *
 * 'Locale.getDisplayName' is a language's name in another language, and
 * 'ABI.md' section 6 both forbids the 'Intl' global and says display names are
 * the host's job. So this answers an ENGLISH name whatever locale is asked,
 * and a tag it has never heard of answers itself rather than a guess.
 *
 * The 27 tags are exactly the ones a real manga index publishes across ~1,400
 * listings, plus the two pseudo-tags 'all' and 'other' that an index uses for
 * a multi-language source. Extending it to the whole of ISO 639 would put
 * about eight kilobytes into every bundle to answer a question two listings
 * ask, and the host draws the language chips a viewer actually sees.
 */
var __LANGUAGE_NAMES = {
  af: 'Afrikaans', ar: 'Arabic', bg: 'Bulgarian', ca: 'Catalan', cs: 'Czech',
  de: 'German', el: 'Greek', en: 'English', es: 'Spanish', fa: 'Persian',
  fi: 'Finnish', fr: 'French', he: 'Hebrew', hi: 'Hindi', hu: 'Hungarian',
  id: 'Indonesian', it: 'Italian', ja: 'Japanese', ko: 'Korean', ms: 'Malay',
  nl: 'Dutch', no: 'Norwegian', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian',
  ru: 'Russian', sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', zh: 'Chinese'
};

var __REGION_NAMES = {
  BR: 'Brazil', CN: 'China', HANS: 'Simplified', HANT: 'Traditional',
  HK: 'Hong Kong', MX: 'Mexico', PT: 'Portugal', TW: 'Taiwan', US: 'United States'
};

/**
 * The display name, in English, of whatever tag this locale was built from.
 *
 * The argument is the locale to answer IN, and it is accepted and ignored for
 * the reason above. Kept as a parameter rather than dropped because every call
 * in this ecosystem passes one, and a shim that took none would be an arity
 * mismatch rather than a documented limitation.
 */
Locale.prototype.getDisplayName = function (inLocale) {
  var base = __str(this.language).toLowerCase();
  var name = Object.prototype.hasOwnProperty.call(__LANGUAGE_NAMES, base)
    ? __LANGUAGE_NAMES[base]
    : '';
  if (name.length === 0) return this.toString();
  var region = __str(this.country).toUpperCase();
  if (region.length === 0) return name;
  var place = Object.prototype.hasOwnProperty.call(__REGION_NAMES, region)
    ? __REGION_NAMES[region]
    : region;
  return name + ' (' + place + ')';
};

/**
 * The language half of that name alone — 'Locale("pt").getDisplayLanguage(
 * Locale.ENGLISH)' is "Portuguese" — with the same English-only limit, and
 * java.util's answer for a language it has no name for: the code itself.
 */
Locale.prototype.getDisplayLanguage = function (inLocale) {
  var base = __str(this.language).toLowerCase();
  return Object.prototype.hasOwnProperty.call(__LANGUAGE_NAMES, base) ? __LANGUAGE_NAMES[base] : base;
};

/**
 * java.text.Collator, which sorts by a locale's rules.
 *
 * Every use of it here is 'sortedWith(intl.collator)' over filter labels, so
 * what it has to answer is a comparator. 'localeCompare' is the JavaScript
 * spelling of the same question and is in the language core rather than in
 * 'Intl' — without 'Intl' its collation is implementation-defined, which for
 * ordering a list of genre names is a difference nobody can see. The locale is
 * not passed on to it for exactly that reason: an engine with no 'Intl' throws
 * on a locale argument it cannot honour, and a sort that throws costs the
 * whole filter list.
 */
function Collator(locale) {
  if (!(this instanceof Collator)) return new Collator(locale);
  this.locale = locale;
}

Collator.getInstance = function (locale) { return new Collator(locale); };
Collator.prototype.compare = function (left, right) {
  return __str(left).localeCompare(__str(right));
};
Collator.prototype.equals = function (left, right) {
  return this.compare(left, right) === 0;
};

/**
 * kotlinx's descriptor vocabulary, as far as a hand-written KSerializer
 * declares it: 'override val descriptor = PrimitiveSerialDescriptor("X",
 * PrimitiveKind.STRING)'. Nothing in this runtime reads a descriptor — the
 * typed decoder takes the type from the class that names the serializer — so
 * these are the values themselves, kept so the object declaring one converts.
 */
function PrimitiveSerialDescriptor(serialName, kind) {
  return { serialName: __str(serialName), kind: kind, isNullable: false };
}
var PrimitiveKind = {
  STRING: 'STRING', INT: 'INT', LONG: 'LONG', SHORT: 'SHORT', BYTE: 'BYTE',
  DOUBLE: 'DOUBLE', FLOAT: 'FLOAT', BOOLEAN: 'BOOLEAN', CHAR: 'CHAR'
};

/** kotlinx's JsonNull, which is JSON's null and so JS null here — see '__jeKind'. */
var JsonNull = null;

/**
 * The files an extension's own repository keeps beside its Kotlin.
 *
 * This is NOT a JVM classpath and does not pretend to be one. It answers the
 * paths the conversion actually fetched — 'assets/i18n/messages_en.properties'
 * and its siblings — and null for everything else, which is what the JVM
 * answers for a resource that is not on the classpath either.
 *
 * '__RESOURCES' is declared by the entry point ahead of this runtime, the way
 * '__SETTING_ID_MAP' is. A bundle that declares none (the video half, or a
 * conversion whose repository had no assets) reads as empty rather than
 * throwing, so the 'typeof' guard is load-bearing.
 */
function __resources() {
  return typeof __RESOURCES === 'undefined' || __RESOURCES === null ? {} : __RESOURCES;
}

function __ClassLoader() {}

__ClassLoader.prototype.getResourceAsStream = function (name) {
  var path = __str(name).replace(/^\\/+/, '');
  var files = __resources();
  if (!Object.prototype.hasOwnProperty.call(files, path)) return null;
  return { __text: __str(files[path]), __path: path };
};

__ClassLoader.prototype.getResource = function (name) {
  return this.getResourceAsStream(name);
};

var __theClassLoader = new __ClassLoader();

/**
 * InputStreamReader, which here is the identity on what the loader answered.
 *
 * The only stream this runtime can produce is one it already holds as text, so
 * decoding is done. The charset is accepted and ignored: the fetcher read the
 * file as UTF-8, and the one call site in this ecosystem passes "UTF-8".
 *
 * A null stream is carried rather than thrown on, because Java's NPE here would
 * land inside a class PROPERTY — 'MadaraBase' builds its filter options from
 * 'intl[…]' at construction — and a throw there takes the whole extension, not
 * one label. See PropertyResourceBundle for what an absent file answers
 * instead.
 */
function InputStreamReader(stream, charset) {
  if (!(this instanceof InputStreamReader)) return new InputStreamReader(stream, charset);
  this.__text = stream === null || stream === undefined ? null : __str(stream.__text);
  this.__path = stream === null || stream === undefined ? '' : __str(stream.__path);
}

InputStreamReader.prototype.readText = function () {
  return this.__text === null ? '' : this.__text;
};
InputStreamReader.prototype.close = function () {};

/**
 * java.util.PropertyResourceBundle, over a '.properties' file.
 *
 * It answers a MAP rather than an object with the entries on it, because the
 * emitter turns 'bundle.containsKey(k)' into '__k.containsKey' and
 * 'bundle.getString(k)' into '__k.jsonGetString', and both of those already
 * read a Map. Entries as own properties would work too until a messages file
 * carried a key spelled like one of the methods.
 *
 * A bundle over a file that is not in this conversion is EMPTY rather than a
 * throw. Upstream's own 'Intl.get' answers '[key]' for a key it cannot find,
 * so an empty bundle degrades to a label a reader can see and report — where
 * the throw would be a dead extension, at construction, for a missing
 * translation.
 */
function PropertyResourceBundle(reader) {
  var text = reader === null || reader === undefined ? '' : __str(reader.readText());
  var map = __parseProperties(text);
  map.getString = function (key) { return __str(map.get(key)); };
  map.containsKey = function (key) { return map.has(key); };
  map.getKeys = function () { return Array.from(map.keys()); };
  map.keySet = map.getKeys;
  return map;
}

/**
 * java.util.Properties' text format, as far as these files use it.
 *
 * Comments, the three separators Java allows, a trailing backslash that
 * continues onto the next line, and the escapes that appear in a translated
 * string: '\\\\n', '\\\\t', '\\\\uXXXX', and an escaped separator. Written out rather
 * than approximated with a split on '=' because a value in these files
 * routinely contains one — 'order_by_filter_az=A-Z' is fine either way,
 * 'search_hint=title=…' is not.
 */
function __parseProperties(text) {
  var out = new Map();
  var lines = __str(text).replace(/\\r\\n?/g, '\\n').split('\\n');
  var pending = '';
  for (var i = 0; i < lines.length; i += 1) {
    var line = pending + lines[i].replace(/^[ \\t\\f]+/, '');
    pending = '';
    if (line.length === 0) continue;
    if (line.charAt(0) === '#' || line.charAt(0) === '!') continue;
    // A line ending in an ODD number of backslashes continues; an even number
    // is an escaped backslash that happens to sit at the end.
    var slashes = /\\\\*$/.exec(line)[0].length;
    if (slashes % 2 === 1) {
      pending = line.slice(0, -1);
      continue;
    }
    var key = '';
    var cut = -1;
    for (var c = 0; c < line.length; c += 1) {
      var ch = line.charAt(c);
      if (ch === '\\\\') { c += 1; continue; }
      if (ch === '=' || ch === ':' || ch === ' ' || ch === '\\t' || ch === '\\f') { cut = c; break; }
    }
    if (cut === -1) {
      out.set(__unescapeProperty(line), '');
      continue;
    }
    key = __unescapeProperty(line.slice(0, cut));
    var rest = line.slice(cut).replace(/^[ \\t\\f]*[=:]?[ \\t\\f]*/, '');
    out.set(key, __unescapeProperty(rest));
  }
  return out;
}

function __unescapeProperty(text) {
  var out = '';
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch !== '\\\\') { out += ch; continue; }
    i += 1;
    var next = text.charAt(i);
    if (next === 'n') out += '\\n';
    else if (next === 't') out += '\\t';
    else if (next === 'r') out += '\\r';
    else if (next === 'f') out += '\\f';
    else if (next === 'u') {
      var hex = text.slice(i + 1, i + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
      } else {
        out += 'u';
      }
    } else out += next;
  }
  return out;
}

/**
 * SimpleDateFormat, for the one thing extensions use it for.
 *
 * 'episodeFromElement' reads an upload date on nearly every list page, always
 * as 'SimpleDateFormat("dd MMM yyyy", Locale.ENGLISH).parse(text)'. The result
 * is read as '.time', so parse answers something carrying one — and answers
 * NULL rather than throwing where Java throws, because the idiom around it is
 * '?.time ?: 0L' and a throw there would lose the whole episode list over a
 * date nobody displays.
 *
 * Fields are read in the format's own zone — 'timeZone = …' or
 * 'setTimeZone(…)' — and UTC when it names none. UTC rather than the host's
 * zone, which would make the same page produce different values on two
 * devices. An offset in the TEXT ('+0700', 'GMT+9') outranks both, as it does
 * in java.text. The pattern reader is java.time's, in 'kotlin-time.ts'.
 */
function SimpleDateFormat(pattern, locale) {
  if (!(this instanceof SimpleDateFormat)) return new SimpleDateFormat(pattern, locale);
  this.pattern = __str(pattern);
  this.locale = locale === undefined ? Locale.ENGLISH : locale;
  this.__parts = __datePattern(this.pattern);
}

SimpleDateFormat.prototype.parse = function (text) {
  var read = __readDate(this.__parts, text);
  if (read === null) return null;
  var local = __epochDayOf(read.year, read.month, read.day) * __MS_PER_DAY +
    read.hour * 3600000 + read.minute * 60000 + read.second * 1000 + __fdiv(read.nano, 1000000);
  var zone = read.zone !== null ? read.zone : __timeZoneRules(this.timeZone);
  var millis = zone.__instantOf(local, null);
  if (!Number.isFinite(millis)) return null;
  return { time: millis, getTime: function () { return millis; } };
};

SimpleDateFormat.prototype.format = function (value) {
  var millis = value === null || value === undefined
    ? 0
    : (typeof value === 'number' ? value : Number(value.time === undefined ? value.getTime() : value.time));
  var fields = __zoned(millis, __timeZoneRules(this.timeZone)).__fields();
  return __formatFields(__patternTokens(this.pattern), fields, this.locale);
};

/** The zone parse and format read fields in; see the constructor. */
SimpleDateFormat.prototype.setTimeZone = function (zone) { this.timeZone = zone; };
SimpleDateFormat.prototype.getTimeZone = function () {
  return this.timeZone === undefined || this.timeZone === null ? TimeZone.getDefault() : this.timeZone;
};

/** A java.util.TimeZone, a java.time ZoneId, or nothing — as the rules it carries. */
function __timeZoneRules(value) {
  if (value === null || value === undefined) return __systemZone();
  if (value instanceof __Zone) return value;
  if (value.__zone instanceof __Zone) return value.__zone;
  return __systemZone();
}

/**
 * java.util.TimeZone, over the zone table 'kotlin-time.ts' keeps.
 *
 * 115 sources in this catalogue write 'dateFormat.timeZone =
 * TimeZone.getTimeZone("UTC")', and a good share of the rest name the zone the
 * site publishes in — Asia/Tokyo, Asia/Ho_Chi_Minh. That zone is honoured: a
 * format carrying one reads its fields there, which is the difference between
 * a chapter dated today and one dated yesterday.
 *
 * An id java.util cannot read answers GMT — java.util's own rule, and why it
 * never throws. An id java.util WOULD read but this table does not carry is the
 * one place that rule costs something; the table is where to add it.
 *
 * Named so the bundle *loads*. A capitalised receiver is passed through by the
 * emitter, so an absent name is 'TimeZone is not defined' at load, inside a
 * sandbox, rather than a refusal here with a sentence attached.
 */
function __timeZone(id, zone) {
  return {
    id: id,
    __zone: zone,
    rawOffset: zone.__std * 1000,
    getID: function () { return id; },
    getRawOffset: function () { return zone.__std * 1000; },
    getOffset: function (millis) { return zone.__offsetAt(Number(millis)) * 1000; },
    useDaylightTime: function () { return zone.__rule !== null; },
    inDaylightTime: function (date) { return zone.__offsetAt(__millisOf(date)) !== zone.__std; },
    toZoneId: function () { return zone; },
    hasSameRules: function (other) {
      return other !== null && other !== undefined && other.__zone !== undefined &&
        other.__zone.__std === zone.__std && other.__zone.__rule === zone.__rule;
    },
    toString: function () { return id; }
  };
}

var TimeZone = {
  getTimeZone: function (value) {
    if (value instanceof __Zone) return __timeZone(value.id, value);
    var id = __str(value);
    var zone = __zoneFromText(id);
    return zone === null ? __timeZone('GMT', __systemZone()) : __timeZone(id, zone);
  },
  getDefault: function () { return __timeZone('UTC', __systemZone()); },
  getAvailableIDs: function () { return Object.keys(__ZONE_TABLE); }
};

/**
 * kotlin.text.Regex's statics, which are not the constructor.
 *
 * 'Regex(pattern)' is a call and goes to '__k.regex', where the pattern is
 * translated. 'Regex.escape(literal)' is a *member* of the companion, and
 * reached the sandbox as a bare name nothing defined. It turns a literal into
 * a pattern that matches it, which here means putting a backslash in front of
 * every character the regex syntax would otherwise read — Java's '\Q…\E'
 * says the same thing in a form this runtime's translator does not read.
 */
var Regex = {
  escape: function (literal) {
    return __str(literal).replace(/[\\^$.|?*+()\\[\\]{}\\\\\\/-]/g, '\\\\$&');
  },
  escapeReplacement: function (literal) { return __str(literal).replace(/\\$/g, '$$$$'); },
  fromLiteral: function (literal) { return __k.regex(Regex.escape(literal)); }
};

/* --- java.util.Calendar --------------------------------------------------- */

/**
 * Calendar, for the one line every extension writes with it.
 *
 * 'Calendar.getInstance().get(Calendar.YEAR)' builds a year filter, and that is
 * very nearly all of it. Fields are read as UTC for the same reason
 * SimpleDateFormat reads them as UTC: the host's timezone would make the same
 * page produce a different filter list on two devices, and a year list that
 * disagrees with itself is worse than one that is a few hours stale.
 *
 * Field numbers are java.util.Calendar's own, so MONTH is 0-based and
 * DAY_OF_WEEK counts from Sunday = 1. Reading MONTH as 1-based is the classic
 * off-by-one here, and it is a wrong value rather than an error.
 */
function __KCalendar(millis, zone) {
  this.millis = millis;
  this.__zone = zone === undefined || zone === null ? __systemZone() : zone;
}

/*
 * The wall clock in this calendar's zone, as a Date whose UTC fields ARE that
 * wall clock — the one trick every field reader below relies on — and the way
 * back: a wall-clock reading resolved to an instant the way java.util does,
 * keeping the offset it had where the clocks allow.
 */
__KCalendar.prototype.__local = function () {
  return new Date(this.millis + this.__zone.__offsetAt(this.millis) * 1000);
};
__KCalendar.prototype.__resolve = function (local) {
  this.millis = this.__zone.__instantOf(local.getTime(), this.__zone.__offsetAt(this.millis));
};

var __CALENDAR_FIELDS = {
  1: function (d) { return d.getUTCFullYear(); },
  2: function (d) { return d.getUTCMonth(); },
  5: function (d) { return d.getUTCDate(); },
  6: function (d) {
    return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  },
  7: function (d) { return d.getUTCDay() + 1; },
  9: function (d) { return d.getUTCHours() < 12 ? 0 : 1; },
  10: function (d) { return d.getUTCHours() % 12; },
  11: function (d) { return d.getUTCHours(); },
  12: function (d) { return d.getUTCMinutes(); },
  13: function (d) { return d.getUTCSeconds(); },
  14: function (d) { return d.getUTCMilliseconds(); }
};

/**
 * Milliseconds per unit, for the fields 'add' moves along the timeline. The
 * day fields are not here: a day is a calendar day, which across a clock
 * change is 23 or 25 hours, so those move the wall clock instead.
 */
var __CALENDAR_STEPS = { 10: 3600000, 11: 3600000, 12: 60000, 13: 1000, 14: 1 };

__KCalendar.prototype.get = function (field) {
  var read = __CALENDAR_FIELDS[Number(field)];
  if (read === undefined) {
    throw new Error('This converted extension read Calendar field ' + __str(field) + ', which Yorozo does not model.');
  }
  return read(this.__local());
};

__KCalendar.prototype.set = function (field, value) {
  var when = this.__local();
  var number = Number(field);
  if (number === 1) when.setUTCFullYear(Number(value));
  else if (number === 2) when.setUTCMonth(Number(value));
  else if (number === 5) when.setUTCDate(Number(value));
  else if (number === 11) when.setUTCHours(Number(value));
  else if (number === 12) when.setUTCMinutes(Number(value));
  else if (number === 13) when.setUTCSeconds(Number(value));
  else if (number === 14) when.setUTCMilliseconds(Number(value));
  else {
    throw new Error('This converted extension set Calendar field ' + __str(field) + ', which Yorozo does not model.');
  }
  this.__resolve(when);
};

__KCalendar.prototype.add = function (field, amount) {
  var number = Number(field);
  var step = __CALENDAR_STEPS[number];
  if (step !== undefined) {
    this.millis += step * Number(amount);
    return;
  }
  // Days, months and years are not a fixed number of milliseconds, so they move
  // the wall clock. A month or a year CLAMPS the day — January 31st plus a
  // month is February 29th in a leap year, as java.util.Calendar.add has it —
  // where letting a Date normalise the overflow would answer March 2nd.
  var when = this.__local();
  var step = Math.trunc(Number(amount));
  if (number === 5 || number === 6 || number === 7) {
    when.setUTCDate(when.getUTCDate() + step);
  } else if (number === 1 || number === 2) {
    var moved = __addMonths(when.getUTCFullYear(), when.getUTCMonth() + 1, when.getUTCDate(),
      number === 1 ? step * 12 : step);
    var wall = when.getTime() - __fdiv(when.getTime(), __MS_PER_DAY) * __MS_PER_DAY;
    when = new Date(__epochDayOf(moved[0], moved[1], moved[2]) * __MS_PER_DAY + wall);
  } else {
    throw new Error('This converted extension moved Calendar field ' + __str(field) + ', which Yorozo does not model.');
  }
  this.__resolve(when);
};

/*
 * 'getDisplayName(Calendar.DAY_OF_WEEK, Calendar.LONG, Locale.US)' — the name
 * of today, which a weekly-schedule source builds its url from. English, and a
 * named refusal for another language (see __requireEnglish); null for a field
 * with no names, as java.util answers.
 */
__KCalendar.prototype.getDisplayName = function (field, style, locale) {
  var local = this.__local();
  var form = Number(style) === 1 || Number(style) === 32769 ? 'SHORT' : 'FULL';
  if (Number(field) === 7) return __englishName(__DAY_NAMES[(local.getUTCDay() + 6) % 7], form, locale);
  if (Number(field) === 2) return __englishName(__MONTH_NAMES[local.getUTCMonth()], form, locale);
  return null;
};

__KCalendar.prototype.getTime = function () { return __kDate(this.millis); };
__KCalendar.prototype.setTime = function (value) { this.millis = __millisOf(value); };
__KCalendar.prototype.getTimeInMillis = function () { return this.millis; };
__KCalendar.prototype.setTimeInMillis = function (value) { this.millis = Number(value); };
__KCalendar.prototype.clone = function () { return new __KCalendar(this.millis, this.__zone); };
/* The instant stays; the fields read differently from here on — java.util's. */
__KCalendar.prototype.setTimeZone = function (zone) { this.__zone = __timeZoneRules(zone); };
__KCalendar.prototype.getTimeZone = function () { return __timeZone(this.__zone.id, this.__zone); };

Object.defineProperty(__KCalendar.prototype, 'timeZone', {
  get: function () { return this.getTimeZone(); },
  set: function (value) { this.setTimeZone(value); }
});

Object.defineProperty(__KCalendar.prototype, 'time', {
  get: function () { return __kDate(this.millis); },
  set: function (value) { this.millis = __millisOf(value); }
});

Object.defineProperty(__KCalendar.prototype, 'timeInMillis', {
  get: function () { return this.millis; },
  set: function (value) { this.millis = Number(value); }
});

var Calendar = {
  ERA: 0, YEAR: 1, MONTH: 2, WEEK_OF_YEAR: 3, WEEK_OF_MONTH: 4,
  DATE: 5, DAY_OF_MONTH: 5, DAY_OF_YEAR: 6, DAY_OF_WEEK: 7,
  HOUR: 10, HOUR_OF_DAY: 11, MINUTE: 12, SECOND: 13, MILLISECOND: 14,
  JANUARY: 0, FEBRUARY: 1, MARCH: 2, APRIL: 3, MAY: 4, JUNE: 5,
  JULY: 6, AUGUST: 7, SEPTEMBER: 8, OCTOBER: 9, NOVEMBER: 10, DECEMBER: 11,
  SUNDAY: 1, MONDAY: 2, TUESDAY: 3, WEDNESDAY: 4, THURSDAY: 5, FRIDAY: 6, SATURDAY: 7,
  AM_PM: 9, AM: 0, PM: 1, ALL_STYLES: 0, SHORT: 1, LONG: 2, SHORT_FORMAT: 1, LONG_FORMAT: 2,
  // 'getInstance()', '(zone)', '(locale)' or '(zone, locale)'; the locale
  // changes nothing a field reader answers, so only a zone is looked for.
  getInstance: function (a, b) {
    var zone = null;
    if (a !== null && a !== undefined && !(a instanceof Locale)) zone = __timeZoneRules(a);
    else if (b !== null && b !== undefined && !(b instanceof Locale)) zone = __timeZoneRules(b);
    return new __KCalendar(Date.now(), zone);
  }
};

/**
 * java.util.Date, as far as this runtime carries one.
 *
 * Only '.time' and 'getTime()' are modelled, because that is all an extension
 * ever reads off one — the same shape SimpleDateFormat.parse already answers
 * with, so the two are interchangeable at every call site that mixes them.
 */
function __kDate(millis) {
  return {
    time: millis,
    getTime: function () { return millis; },
    __kDate: true
  };
}

function __millisOf(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.time === 'number') return value.time;
  if (typeof value.getTime === 'function') return Number(value.getTime());
  return Number(value);
}

/**
 * java.lang.System, for the two members a scraper reads off it.
 *
 * 'System.currentTimeMillis()' is a cache-buster or an expiry on a signed url,
 * and it turns up in the extractor modules the whole catalogue shares. It has
 * to be a NAME rather than a refusal because a capitalised receiver is passed
 * through unrefused: without this the bundle converts, loads, and then dies
 * with 'System is not defined' at the first video request.
 *
 * Nothing else is here on purpose. 'System.exit', 'getenv' and 'out' have no
 * honest answer inside a sandbox, and an undefined member fails loudly at the
 * call rather than quietly answering nothing.
 */
var System = {
  currentTimeMillis: function () { return Date.now(); },
  nanoTime: function () { return Date.now() * 1000000; }
};

/**
 * java.util.concurrent.TimeUnit, which is only ever a timeout's second argument.
 *
 * 'connectTimeout(30, TimeUnit.SECONDS)' is the whole of its use here, and the
 * timeout itself belongs to the host's transport — so the unit changes nothing
 * this runtime does. It still has to be a NAME: the emitter refuses a
 * capitalised identifier it cannot resolve, and one unresolvable enum was
 * refusing an extension whose only other obstacle was the timeout call it sits
 * inside. Each entry carries the conversion it names so that a bundle reaching
 * for one gets a number rather than an object that stringifies to nonsense.
 */
function __timeUnit(millis) {
  return {
    toMillis: function (amount) { return Number(amount) * millis; },
    toSeconds: function (amount) { return Math.trunc((Number(amount) * millis) / 1000); }
  };
}

/**
 * okhttp's Protocol enum, which is only ever an argument to protocols().
 *
 * Named rather than refused, on the TimeUnit argument above: the version is
 * negotiated by whatever actually makes the request, so the value changes
 * nothing here, and an unresolvable capitalised identifier would refuse the
 * whole extension over a line that does nothing.
 */
var Protocol = {
  HTTP_1_0: { name: 'http/1.0' },
  HTTP_1_1: { name: 'http/1.1' },
  HTTP_2: { name: 'h2' },
  H2_PRIOR_KNOWLEDGE: { name: 'h2_prior_knowledge' },
  SPDY_3: { name: 'spdy/3.1' },
  QUIC: { name: 'quic' }
};

/**
 * java.lang.Character, whose statics this ecosystem uses to sniff a string.
 *
 * A Kotlin Char is a one-character string in this runtime, so each of these is
 * a question about the first character of what it is handed. They exist because
 * an id parser reaches for Character.isDigit rather than a regex often enough
 * to refuse extensions over it.
 */
var Character = {
  isDigit: function (value) { return /^[0-9]$/.test(__str(value).charAt(0)); },
  isLetter: function (value) { return /^\\p{L}$/u.test(__str(value).charAt(0)); },
  isLetterOrDigit: function (value) { return /^[\\p{L}0-9]$/u.test(__str(value).charAt(0)); },
  isWhitespace: function (value) { return /^\\s$/.test(__str(value).charAt(0)); },
  isUpperCase: function (value) {
    var c = __str(value).charAt(0);
    return c !== '' && c === c.toUpperCase() && c !== c.toLowerCase();
  },
  isLowerCase: function (value) {
    var c = __str(value).charAt(0);
    return c !== '' && c === c.toLowerCase() && c !== c.toUpperCase();
  },
  toUpperCase: function (value) { return __str(value).charAt(0).toUpperCase(); },
  toLowerCase: function (value) { return __str(value).charAt(0).toLowerCase(); },
  getNumericValue: function (value) {
    var c = __str(value).charAt(0);
    var digit = parseInt(c, 36);
    return Number.isNaN(digit) ? -1 : digit;
  },
  toString: function (value) { return __str(value).charAt(0); },
  valueOf: function (value) { return __str(value).charAt(0); }
};

var TimeUnit = {
  NANOSECONDS: __timeUnit(1 / 1000000),
  MICROSECONDS: __timeUnit(1 / 1000),
  MILLISECONDS: __timeUnit(1),
  SECONDS: __timeUnit(1000),
  MINUTES: __timeUnit(60000),
  HOURS: __timeUnit(3600000),
  DAYS: __timeUnit(86400000)
};

/* --- charsets: UTF-8 by the host, the single-byte two here ---------------- */

/**
 * The charsets an extension names, and the ones this runtime actually does.
 *
 * 'ctx.text.encode' and 'ctx.text.decode' are UTF-8 and nothing else. The two
 * single-byte charsets need no host at all - ISO-8859-1 maps each byte to the
 * code point of the same number and back, US-ASCII is its lower half - so they
 * are done here, exactly, with the JVM's own answer for a character that has no
 * byte ('?') and a byte that has no character (U+FFFD). ISO-8859-1 is not rare:
 * it is how this ecosystem turns a byte array into a string one char per byte
 * before shifting characters, which is a shared video-host extractor's whole decoder.
 *
 * The UTF-16 family is declared but not honoured: naming one is a named failure
 * rather than a decode that quietly produces mojibake. A byte sequence read as
 * the wrong charset is a title that looks almost right, which is the failure
 * this runtime least wants to ship.
 */
var Charsets = {
  UTF_8: { name: 'UTF-8' },
  ISO_8859_1: { name: 'ISO-8859-1' },
  US_ASCII: { name: 'US-ASCII' },
  UTF_16: { name: 'UTF-16' },
  UTF_16BE: { name: 'UTF-16BE' },
  UTF_16LE: { name: 'UTF-16LE' }
};

var StandardCharsets = Charsets;

/* Which of the three a charset argument names: 'utf8', 'latin1' or 'ascii'. */
function __charsetOf(charset) {
  if (charset === null || charset === undefined) return 'utf8';
  var name = typeof charset === 'string' ? charset : __str(charset.name);
  if (/^(?:iso-?8859-1|iso_8859_1|latin-?1)$/i.test(name)) return 'latin1';
  if (/^(?:us-?ascii|ascii)$/i.test(name)) return 'ascii';
  __utf8Only(charset);
  return 'utf8';
}

/* Bytes to text in a single-byte charset, as java.lang.String decodes them. */
function __singleByteDecode(bytes, kind) {
  var out = '';
  for (var i = 0; i < bytes.length; i += 1) {
    var b = bytes[i] & 255;
    out += kind === 'ascii' && b > 127 ? '\\ufffd' : String.fromCharCode(b);
  }
  return out;
}

/* Text to bytes in a single-byte charset; an unmappable character is '?'. */
function __singleByteEncode(text, kind) {
  var limit = kind === 'ascii' ? 127 : 255;
  var out = new Uint8Array(text.length);
  for (var i = 0; i < text.length; i += 1) {
    var c = text.charCodeAt(i);
    out[i] = c > limit ? 63 : c;
  }
  return out;
}
/**
 * java.nio's Charset by name. 'defaultCharset()' is UTF-8, which is what
 * Android's always is. 'forName' answers the named charset, and every reader
 * here that takes one asks '__utf8Only' of it — so a charset other than UTF-8
 * fails where it is used, by name, as it did before this existed.
 */
var Charset = {
  forName: function (name) {
    var wanted = __str(name);
    for (var key in Charsets) {
      if (Object.prototype.hasOwnProperty.call(Charsets, key) &&
          Charsets[key].name.toLowerCase() === wanted.toLowerCase()) return Charsets[key];
    }
    return { name: wanted };
  },
  defaultCharset: function () { return Charsets.UTF_8; }
};

function __utf8Only(charset) {
  if (charset === null || charset === undefined) return;
  var name = typeof charset === 'string' ? charset : __str(charset.name);
  if (/^utf-?8$/i.test(name)) return;
  throw new Error(
    'This converted extension asked for the ' + name + ' charset. Yorozo only offers UTF-8, and ' +
    'decoding those bytes as UTF-8 instead would produce text that looks almost right.'
  );
}

/* --- android.util.Base64 -------------------------------------------------- */

/**
 * Standard, padded base64 to bytes, in plain JavaScript — for Base64.decode
 * when no host has been entered yet (see there). Characters outside the
 * alphabet are an error, as they are to the host's decoder, rather than
 * skipped into different bytes.
 */
function __base64Decode(text) {
  var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var body = text.replace(/=+$/, '');
  var out = new Uint8Array(Math.floor((body.length * 3) / 4));
  var bits = 0;
  var count = 0;
  var at = 0;
  for (var i = 0; i < body.length; i++) {
    var index = alphabet.indexOf(body.charAt(i));
    if (index < 0) throw new Error('Base64.decode was handed a character that is not base64.');
    bits = (bits << 6) | index;
    count += 6;
    if (count >= 8) {
      count -= 8;
      out[at++] = (bits >> count) & 255;
    }
  }
  return at === out.length ? out : out.slice(0, at);
}

/**
 * Android's Base64, whose flags are the part that catches people out.
 *
 * The values are Android's own, so 'Base64.URL_SAFE or Base64.NO_WRAP' is the
 * bitwise or the extension wrote. Two differences from a naive btoa:
 *
 * - DEFAULT **wraps** at 76 characters and appends a newline. NO_WRAP is what
 *   turns that off, and an extension that pastes a DEFAULT-encoded value into
 *   a URL without NO_WRAP is broken on Android too — so the wrapping is
 *   reproduced rather than quietly dropped.
 * - URL_SAFE swaps '+/' for '-_'. Encoding without it where the Kotlin asked
 *   for it yields a token the far end rejects.
 *
 * Decoding accepts both alphabets and tolerates missing padding, which is
 * wider than Android's decoder. That can only accept input Android would
 * reject; it cannot turn valid input into different bytes.
 */
var Base64 = {
  DEFAULT: 0,
  NO_PADDING: 1,
  NO_WRAP: 2,
  CRLF: 4,
  URL_SAFE: 8,

  decode: function (value, flags) {
    // Before any plugin call there is no host to lend a decoder, and a
    // companion constant is evaluated exactly then: 'private val KEY =
    // Base64.decode("…", Base64.DEFAULT)' hoists to module scope and killed
    // the bundle on import. Base64 is arithmetic on ASCII, so that one moment
    // is served by __base64Decode below; with a host, the host's decoder is
    // used as it always was.
    var early = __ctx === null;
    var text = typeof value === 'string'
      ? value
      : early
        ? String.fromCharCode.apply(null, Array.prototype.slice.call(__bytesOf(value)))
        : __host().text.decode(__bytesOf(value));
    var normalised = text.replace(/[-]/g, '+').replace(/_/g, '/').replace(/[\\r\\n\\s]/g, '');
    while (normalised.length % 4 !== 0) normalised += '=';
    return early ? __base64Decode(normalised) : __host().bytes.fromBase64(normalised);
  },

  encodeToString: function (bytes, flags) {
    var mask = Number(flags) || 0;
    var encoded = __host().bytes.toBase64(__bytesOf(bytes));
    if ((mask & 8) !== 0) encoded = encoded.replace(/[+]/g, '-').replace(/\\//g, '_');
    if ((mask & 1) !== 0) encoded = encoded.replace(/=+$/, '');
    if ((mask & 2) !== 0) return encoded;
    var breaker = (mask & 4) !== 0 ? '\\r\\n' : '\\n';
    var lines = [];
    for (var i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
    return lines.join(breaker) + breaker;
  },

  /**
   * java.util.Base64's getDecoder()/getEncoder(), which android's Base64 is not.
   *
   * Two different classes with the same name: android's is all statics, and
   * java.util's hands back a coder first. The decoders can be this same object
   * - both spell the work 'decode(value)', and a flag argument never arrives.
   * The encoders cannot: java.util's basic encoder never wraps and never ends
   * in a newline, and answering with this object made 'encodeToString(bytes)'
   * android's DEFAULT, which wraps at 76 and appends one. See '__javaEncoder'.
   */
  getDecoder: function () { return Base64; },
  getMimeDecoder: function () { return Base64; },
  getEncoder: function () { return __javaEncoder(2); },
  getUrlDecoder: function () { return Base64; },
  getUrlEncoder: function () { return __javaEncoder(2 | 8); },

  /** Android's encode() answers bytes; the text is the same either way. */
  encode: function (bytes, flags) {
    return __host().text.encode(Base64.encodeToString(bytes, flags));
  }
};

/**
 * A java.util.Base64.Encoder, as the android flags that produce the same text:
 * NO_WRAP always, URL_SAFE for the url encoder, NO_PADDING once
 * 'withoutPadding()' asked for it.
 */
function __javaEncoder(flags) {
  return {
    encodeToString: function (bytes) { return Base64.encodeToString(bytes, flags); },
    encode: function (bytes) { return __host().text.encode(Base64.encodeToString(bytes, flags)); },
    withoutPadding: function () { return __javaEncoder(flags | 1); }
  };
}

function __bytesOf(value) {
  if (value === null || value === undefined) return __host().text.encode('');
  if (typeof value === 'string') return __host().text.encode(value);
  if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) return value;
  if (Array.isArray(value)) {
    // A Kotlin ByteArray is signed; a byte the extension wrote as -1 is 255
    // here, and masking rather than truncating is what keeps the round trip.
    var out = new Uint8Array(value.length);
    for (var i = 0; i < value.length; i += 1) out[i] = Number(value[i]) & 255;
    return out;
  }
  if (typeof value.length === 'number') return new Uint8Array(Array.prototype.slice.call(value));
  return __host().text.encode(__str(value));
}

/**
 * The trailing options object on a vararg call, or null when there is none.
 *
 * Kotlin puts 'ignoreCase' and 'limit' AFTER a vararg, where a positional
 * translation has nowhere to put them, so the emitter passes them as one
 * object on the end. Recognising it is unambiguous by construction: every
 * other argument in that position is a delimiter, and a delimiter is a string
 * or a Regex.
 */
function __splitOptions(value) {
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value) || value instanceof RegExp || value.__isRegex === true) return null;
  if (!('limit' in value) && !('ignoreCase' in value)) return null;
  return value;
}

/* --- the helpers the emitter calls ---------------------------------------- */

var __k = {
  /**
   * Kotlin's !!.
   *
   * It must throw, and it must say which expression was null: a helper that
   * returned undefined here would push the failure into whatever read the
   * value next, several frames from the cause.
   */
  nn: function (value, name) {
    if (value === null || value === undefined) {
      throw new Error(
        'This converted extension required ' + (name ? name : 'a value') +
        ' to be present, and it was null.'
      );
    }
    return value;
  },

  /* -- numbers ------------------------------------------------------------ */

  toIntOrNull: function (value) {
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
    var text = __str(value).trim();
    if (!/^[+-]?[0-9]+$/.test(text)) return null;
    var parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  },

  /** Kotlin's Int.and, kept explicit because JavaScript has no named infix form. */
  bitwiseAnd: function (left, right) {
    return Number(left) & Number(right);
  },

  bitwiseOr: function (left, right) {
    return Number(left) | Number(right);
  },

  bitwiseXor: function (left, right) {
    return Number(left) ^ Number(right);
  },

  /** Kotlin throws here where Number('abc') is a silent NaN. */
  toInt: function (value) {
    var parsed = __k.toIntOrNull(value);
    if (parsed === null) {
      throw new Error('This converted extension read "' + __str(value) + '" as a number, and it is not one.');
    }
    return parsed;
  },

  toFloatOrNull: function (value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    var text = __str(value).trim();
    if (!/^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]+)?$/.test(text)) return null;
    var parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  },

  toFloat: function (value) {
    var parsed = __k.toFloatOrNull(value);
    if (parsed === null) {
      throw new Error('This converted extension read "' + __str(value) + '" as a number, and it is not one.');
    }
    return parsed;
  },

  /**
   * A Long, as far as a double can carry one.
   *
   * Every Long a scraper reads is a timestamp or an id, both well inside the
   * safe range; a value beyond it is refused rather than silently rounded.
   */
  toLongOrNull: function (value) {
    var parsed = __k.toIntOrNull(value);
    if (parsed === null) return null;
    return Number.isSafeInteger(parsed) ? parsed : null;
  },

  /** Throwing Long conversion, parallel to Kotlin's toInt/toFloat helpers. */
  toLong: function (value) {
    var parsed = __k.toLongOrNull(value);
    if (parsed === null) {
      throw new Error('This converted extension read "' + __str(value) + '" as a Long, and it is not one.');
    }
    return parsed;
  },

  /** Kotlin Int.countLeadingZeroBits over the same signed 32-bit width. */
  countLeadingZeroBits: function (value) { return Math.clz32(Number(value)); },

  /** Kotlin Int division truncates toward zero, and 1/0 is an exception. */
  intDiv: function (a, b) {
    var divisor = Number(b);
    if (divisor === 0) throw new Error('This converted extension divided by zero.');
    return Math.trunc(Number(a) / divisor);
  },

  /** Kotlin's signed Byte conversion: truncate, then keep eight bits. */
  toByte: function (value) {
    var number = Number(value);
    if (!Number.isFinite(number)) throw new Error('This converted extension read a non-finite Byte.');
    var wrapped = Math.trunc(number) & 255;
    return wrapped >= 128 ? wrapped - 256 : wrapped;
  },

  /**
   * Kotlin's 'toUByte()': the low eight bits, read as 0–255. A UByte here is
   * the plain number, so 'toInt()' after it is the same value, which is the
   * whole idiom ('it.toUByte().toInt()'). Only the conversion into a UByte is
   * here; the UInt/ULong arithmetic that wraps at 2^32 is not modelled.
   */
  /** Kotlin's 'String?.toBoolean()': "true" ignoring case; null and anything else false. */
  toBoolean: function (value) {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    return __str(value).toLowerCase() === 'true';
  },

  /** 'toBooleanStrict()': exactly "true" or "false", else IllegalArgumentException. */
  toBooleanStrict: function (value) {
    var read = __k.toBooleanStrictOrNull(value);
    if (read === null) {
      throw new Error('The string does not represent a boolean value: ' + __str(value));
    }
    return read;
  },

  /** 'toBooleanStrictOrNull()': exactly "true" or "false", else null. */
  toBooleanStrictOrNull: function (value) {
    var text = value === null || value === undefined ? null : __str(value);
    return text === 'true' ? true : text === 'false' ? false : null;
  },

  toUByte: function (value) {
    var number = Number(value);
    if (!Number.isFinite(number)) throw new Error('This converted extension read a non-finite UByte.');
    return Math.trunc(number) & 255;
  },

  /* -- strings ------------------------------------------------------------ */

  substringAfter: function (value, delimiter, missing) {
    var text = __str(value);
    var d = __str(delimiter);
    var index = text.indexOf(d);
    if (index === -1) return missing === undefined ? text : __str(missing);
    return text.slice(index + d.length);
  },

  substringAfterLast: function (value, delimiter, missing) {
    var text = __str(value);
    var d = __str(delimiter);
    var index = text.lastIndexOf(d);
    if (index === -1) return missing === undefined ? text : __str(missing);
    return text.slice(index + d.length);
  },

  substringBefore: function (value, delimiter, missing) {
    var text = __str(value);
    var index = text.indexOf(__str(delimiter));
    if (index === -1) return missing === undefined ? text : __str(missing);
    return text.slice(0, index);
  },

  substringBeforeLast: function (value, delimiter, missing) {
    var text = __str(value);
    var index = text.lastIndexOf(__str(delimiter));
    if (index === -1) return missing === undefined ? text : __str(missing);
    return text.slice(0, index);
  },

  removePrefix: function (value, prefix) {
    var text = __str(value);
    var p = __str(prefix);
    return p.length > 0 && text.indexOf(p) === 0 ? text.slice(p.length) : text;
  },

  removeSuffix: function (value, suffix) {
    var text = __str(value);
    var s = __str(suffix);
    return s.length > 0 && text.length >= s.length && text.slice(text.length - s.length) === s
      ? text.slice(0, text.length - s.length)
      : text;
  },

  /** Both ends, or neither — Kotlin does not half-strip. */
  removeSurrounding: function (value, prefix, suffix) {
    var text = __str(value);
    var start = __str(prefix);
    var end = suffix === undefined ? start : __str(suffix);
    if (text.length >= start.length + end.length &&
        text.indexOf(start) === 0 &&
        text.slice(text.length - end.length) === end) {
      return text.slice(start.length, text.length - end.length);
    }
    return text;
  },

  trimIndent: function (value) {
    var lines = __str(value).split('\\n');
    while (lines.length > 0 && lines[0].trim().length === 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) lines.pop();
    var indent = -1;
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].trim().length === 0) continue;
      var width = lines[i].length - lines[i].replace(/^[ \\t]+/, '').length;
      if (indent === -1 || width < indent) indent = width;
    }
    if (indent <= 0) return lines.join('\\n');
    var out = [];
    for (var j = 0; j < lines.length; j += 1) out.push(lines[j].slice(indent));
    return out.join('\\n');
  },

  /**
   * Kotlin's ifEmpty, over both kinds of absence.
   *
   * jsoup's attr() returns '' where the Kotlin writes attr("x").ifEmpty { null },
   * and a missing property arrives as undefined, so both count as empty.
   */
  ifEmpty: function (value, fallback) {
    var empty = !__present(value) ||
      (typeof value === 'string' ? value.length === 0 : __arr(value).length === 0);
    if (!empty) return value;
    return typeof fallback === 'function' ? fallback() : fallback;
  },

  ifBlank: function (value, fallback) {
    var blank = !__present(value) || __str(value).trim().length === 0;
    if (!blank) return value;
    return typeof fallback === 'function' ? fallback() : fallback;
  },

  isNullOrEmpty: function (value) {
    if (!__present(value)) return true;
    return typeof value === 'string' ? value.length === 0 : __arr(value).length === 0;
  },

  isNullOrBlank: function (value) {
    return !__present(value) || __str(value).trim().length === 0;
  },

  /**
   * Kotlin's String.replace, which replaces EVERY occurrence.
   *
   * JavaScript's replaces the first when handed a string, and that difference
   * is a wrong value rather than an error — the commonest single bug in a
   * hand-written port of one of these extensions.
   *
   * Dispatches on the receiver: '"s".replace(a, b)' and 'regex.replace(s, b)'
   * are the same call site after translation, because the emitter has no types
   * to tell them apart with.
   */
  replaceString: function (value, target, replacement) {
    if (value && value.__isRegex === true) return value.replace(target, replacement);
    if (value instanceof RegExp) {
      return __str(target).replace(new RegExp(value.source, __regexFlags(value.flags, 'g')), replacement);
    }
    var text = __str(value);
    if (target && target.__isRegex === true) return target.replace(text, replacement);
    if (target instanceof RegExp) {
      return text.replace(new RegExp(target.source, __regexFlags(target.flags, 'g')), replacement);
    }
    return text.split(__str(target)).join(__str(replacement));
  },

  /** MutableList.replaceAll changes the list; String.replaceAll takes a regex. */
  replaceAll: function (value, transform, replacement) {
    if (typeof value === 'string') return __k.replaceString(value, __k.regex(transform), replacement);
    if (!Array.isArray(value) || typeof transform !== 'function') {
      throw new Error('This converted extension called replaceAll on an unsupported value.');
    }
    return __then(__each(value.slice(), transform), function (values) {
      for (var i = 0; i < values.length; i += 1) value[i] = values[i];
      return undefined;
    });
  },

  /**
   * Kotlin splits on any of several literal delimiters, or on a Regex.
   *
   * 'limit' and 'ignoreCase' arrive as a trailing options object, because the
   * delimiters are a vararg and there is no position after a vararg to put them
   * in. The emitter builds it (see VARARG_OPTIONS); a delimiter is a string or
   * a Regex and never a plain object, so the two cannot be confused.
   *
   * 'limit' is Kotlin's: at most that many parts, and the last one is the
   * REMAINDER of the string rather than the next part — which is why the scan
   * stops rather than the result being trimmed afterwards.
   */
  split: function (value) {
    var text = __str(value);
    var delimiters = Array.prototype.slice.call(arguments, 1);
    var options = __splitOptions(delimiters[delimiters.length - 1]);
    if (options !== null) delimiters = delimiters.slice(0, -1);
    if (delimiters.length === 1 && Array.isArray(delimiters[0])) delimiters = delimiters[0];
    if (delimiters.length === 0) return [text];

    var limit = options === null || options.limit === undefined ? 0 : Number(options.limit);
    if (!Number.isFinite(limit) || limit < 0) limit = 0;
    var fold = options !== null && options.ignoreCase === true;

    var first = delimiters[0];
    if (first && first.__isRegex === true) return first.split(text, limit);
    if (first instanceof RegExp) return __splitByRegExp(text, first, limit);

    var literals = [];
    for (var i = 0; i < delimiters.length; i += 1) {
      var d = __str(delimiters[i]);
      if (d.length > 0) literals.push(fold ? d.toLowerCase() : d);
    }
    if (literals.length === 0) return [text];

    var haystack = fold ? text.toLowerCase() : text;
    var parts = [];
    var start = 0;
    var at = 0;
    while (at < text.length) {
      if (limit > 0 && parts.length === limit - 1) break;
      var hit = null;
      for (var j = 0; j < literals.length; j += 1) {
        if (haystack.substr(at, literals[j].length) === literals[j]) { hit = literals[j]; break; }
      }
      if (hit === null) { at += 1; continue; }
      parts.push(text.slice(start, at));
      at += hit.length;
      start = at;
    }
    parts.push(text.slice(start));
    return parts;
  },

  lowercase: function (value) { return __str(value).toLowerCase(); },
  uppercase: function (value) { return __str(value).toUpperCase(); },

  padStart: function (value, length, pad) {
    var text = __str(value);
    var filler = pad === undefined ? ' ' : __str(pad);
    if (filler.length === 0) return text;
    while (text.length < Number(length)) text = filler.charAt(0) + text;
    return text;
  },

  /**
   * okio's String.decodeBase64(): a ByteString, or NULL for text that is not
   * base64 — the '?.utf8() ?: throw' after it is how an extension says the
   * page changed. Both alphabets, whitespace and trailing '=' skipped, as
   * okio does; any other character, or a length no encoding produces, is null
   * rather than a best effort.
   */
  okioDecodeBase64: function (value) {
    if (value === null || value === undefined) return null;
    var text = __str(value).replace(/[ \\t\\r\\n]/g, '').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+\\/_-]*$/.test(text) || text.length % 4 === 1) return null;
    var normalised = text.replace(/-/g, '+').replace(/_/g, '/');
    while (normalised.length % 4 !== 0) normalised += '=';
    return __byteString(__host().bytes.fromBase64(normalised));
  },

  /**
   * CharSequence.findAnyOf(strings, startIndex = 0, ignoreCase = false): the
   * first index at which any of the strings occurs, paired with the one that
   * does, or null. Kotlin's own order: indices ascending, and at one index
   * the first string in the collection's order that matches there — not the
   * longest.
   */
  findAnyOf: function (value, strings, startIndex, ignoreCase) {
    var text = __str(value);
    var wanted = __arr(strings).map(__str);
    var fold = ignoreCase === true;
    var hay = fold ? text.toLowerCase() : text;
    var start = Math.max(0, Number(startIndex) || 0);
    for (var at = start; at <= text.length; at += 1) {
      for (var i = 0; i < wanted.length; i += 1) {
        var needle = fold ? wanted[i].toLowerCase() : wanted[i];
        if (hay.startsWith(needle, at)) return __k.to(at, wanted[i]);
      }
    }
    return null;
  },

  /**
   * runningFold(initial) { acc, x -> … }: every accumulator in turn, the
   * initial one first — a list one longer than the input.
   */
  runningFold: function (list, initial, operation) {
    var items = __arr(list);
    var out = [initial];
    var accumulator = initial;
    for (var i = 0; i < items.length; i += 1) {
      accumulator = operation(accumulator, items[i]);
      out.push(accumulator);
    }
    return out;
  },

  /** mapIndexedTo(destination) { index, x -> … }: appended to it, which is answered. */
  mapIndexedTo: function (list, destination, transform) {
    return __then(
      __each(__arr(list), function (item, index) { return transform(index, item); }),
      function (values) {
        for (var at = 0; at < values.length; at += 1) __k.add(destination, values[at]);
        return destination;
      }
    );
  },

  /** containsAll(other): every element of it is in this one, by Kotlin's equality. */
  containsAll: function (collection, other) {
    var items = __arr(collection);
    var wanted = __arr(other);
    for (var i = 0; i < wanted.length; i += 1) {
      var found = false;
      for (var j = 0; j < items.length && !found; j += 1) if (__equal(items[j], wanted[i])) found = true;
      if (!found) return false;
    }
    return true;
  },

  /**
   * retainAll { keep }: a MutableList filtered IN PLACE, answering whether
   * anything went — the list the next line reads is the one that shrank.
   */
  retainAll: function (collection, subject) {
    if (!Array.isArray(collection)) {
      throw new Error('This converted extension retained elements of something that is not a list.');
    }
    var keep = typeof subject === 'function'
      ? subject
      : function (item) { return __arr(subject).some(function (one) { return __equal(one, item); }); };
    var kept = collection.filter(function (item) { return keep(item) === true; });
    var removed = kept.length !== collection.length;
    collection.length = 0;
    for (var i = 0; i < kept.length; i += 1) collection.push(kept[i]);
    return removed;
  },

  /**
   * replaceAfterLast(delimiter, replacement, missing = this): everything after
   * the last delimiter swapped for the replacement, the delimiter kept.
   */
  replaceAfterLast: function (value, delimiter, replacement, missing) {
    var text = __str(value);
    var at = text.lastIndexOf(__str(delimiter));
    if (at === -1) return missing === undefined ? text : __str(missing);
    return text.slice(0, at + __str(delimiter).length) + __str(replacement);
  },

  /**
   * windowed(size, step = 1, partialWindows = false): each run of 'size'
   * consecutive elements, starting every 'step'; a short tail only when
   * partial windows were asked for.
   */
  windowed: function (list, size, step, partial, transform) {
    var items = __arr(list);
    var width = Math.trunc(Number(size));
    var stride = step === undefined || step === null ? 1 : Math.trunc(Number(step));
    if (!(width > 0) || !(stride > 0)) {
      throw new Error('This converted extension asked for windows of size ' + size + ' and step ' + step + '.');
    }
    var out = [];
    for (var at = 0; at < items.length; at += stride) {
      var window = items.slice(at, at + width);
      if (window.length < width && partial !== true) break;
      out.push(typeof transform === 'function' ? transform(window) : window);
    }
    return out;
  },

  /** okio's ByteArray.toByteString(): the same bytes with ByteString's readers. */
  toByteString: function (bytes) {
    return __byteString(__bytesOf(bytes).slice());
  },

  /**
   * Iterable.min()/max() — Kotlin 1.7's, which THROW on an empty collection
   * (minOrNull is the forgiving one). A receiver with its own min/max answers
   * for itself: 'Math.min(a, b)' reaches this table by name too.
   */
  collectionMin: function (list) {
    if (list !== null && list !== undefined && !Array.isArray(list) && typeof list.min === 'function') {
      return list.min.apply(list, Array.prototype.slice.call(arguments, 1));
    }
    var best = __k.minOrNull(list);
    if (best === null && __arr(list).length === 0) {
      throw new Error('This converted extension asked for the minimum of an empty collection.');
    }
    return best;
  },
  collectionMax: function (list) {
    if (list !== null && list !== undefined && !Array.isArray(list) && typeof list.max === 'function') {
      return list.max.apply(list, Array.prototype.slice.call(arguments, 1));
    }
    var best = __k.maxOrNull(list);
    if (best === null && __arr(list).length === 0) {
      throw new Error('This converted extension asked for the maximum of an empty collection.');
    }
    return best;
  },

  /** average() of numbers: NaN for an empty collection, as Kotlin's. */
  average: function (list) {
    var items = __arr(list);
    if (items.length === 0) return NaN;
    var total = 0;
    for (var i = 0; i < items.length; i += 1) total += Number(items[i]);
    return total / items.length;
  },

  /**
   * String.capitalize(), deprecated in Kotlin and still written: the first
   * character upper-cased when it is lower case, the rest untouched. The
   * locale argument is accepted and not applied — the language core has no
   * locale casing without 'Intl' (ABI.md section 6) — which differs from
   * Kotlin only for a locale with its own rule for that letter, Turkish 'i'.
   */
  capitalize: function (value) {
    var text = __str(value);
    if (text.length === 0) return text;
    var first = String.fromCodePoint(text.codePointAt(0));
    if (first.toLowerCase() !== first || first.toUpperCase() === first) return text;
    return first.toUpperCase() + text.slice(first.length);
  },

  /** padEnd(length, padChar = ' '), padStart's mirror. */
  padEnd: function (value, length, pad) {
    var text = __str(value);
    var filler = pad === undefined ? ' ' : __str(pad);
    if (filler.length === 0) return text;
    while (text.length < Number(length)) text = text + filler.charAt(0);
    return text;
  },

  /**
   * Kotlin's 'in', which is one operator over three receivers.
   *
   * A substring in a String, an element in a Collection, a key in a Map and a
   * match of a Regex all spell the same thing in Kotlin, and the emitter cannot
   * always tell which it has.
   */
  contains: function (haystack, needle, ignoreCase) {
    if (haystack === null || haystack === undefined) return false;
    if (haystack && haystack.__isRegex === true) return haystack.containsMatchIn(needle);
    if (needle && needle.__isRegex === true) return needle.containsMatchIn(haystack);
    if (typeof haystack === 'string') {
      if (ignoreCase === true) return haystack.toLowerCase().indexOf(__str(needle).toLowerCase()) !== -1;
      return haystack.indexOf(__str(needle)) !== -1;
    }
    if (haystack instanceof Set) return haystack.has(needle);
    if (haystack instanceof Map) return haystack.has(needle);
    // 'key in jsonObject' is containsKey, as it is on any Kotlin Map.
    if (__mapLike(haystack)) return Object.prototype.hasOwnProperty.call(haystack, __str(needle));
    var items = __arr(haystack);
    for (var i = 0; i < items.length; i += 1) if (items[i] === needle) return true;
    return false;
  },

  /**
   * Kotlin's CharSequence.indexOf(other, startIndex, ignoreCase), reached only
   * when the call named an argument - 'indexOf("English", ignoreCase = true)'
   * - because JavaScript's indexOf has no third argument and would search
   * case-sensitively without a word. A skipped startIndex arrives undefined.
   * Anything that is not a string keeps its own indexOf.
   */
  indexOf: function (value, other, startIndex, ignoreCase) {
    if (typeof value !== 'string') return value.indexOf(other, startIndex === undefined ? 0 : startIndex);
    var from = startIndex === undefined || startIndex === null ? 0 : Math.max(0, Number(startIndex));
    var text = ignoreCase === true ? value.toLowerCase() : value;
    var needle = ignoreCase === true ? __str(other).toLowerCase() : __str(other);
    return text.indexOf(needle, from);
  },

  /* The same, searching backwards from startIndex (the end, when skipped). */
  lastIndexOf: function (value, other, startIndex, ignoreCase) {
    if (typeof value !== 'string') return value.lastIndexOf(other);
    var from = startIndex === undefined || startIndex === null ? value.length : Number(startIndex);
    var text = ignoreCase === true ? value.toLowerCase() : value;
    var needle = ignoreCase === true ? __str(other).toLowerCase() : __str(other);
    return from < 0 ? -1 : text.lastIndexOf(needle, from);
  },

  startsWith: function (value, prefix, ignoreCase) {
    var text = __str(value);
    var p = __str(prefix);
    if (ignoreCase === true) return text.slice(0, p.length).toLowerCase() === p.toLowerCase();
    return text.slice(0, p.length) === p;
  },

  endsWith: function (value, suffix, ignoreCase) {
    var text = __str(value);
    var s = __str(suffix);
    if (s.length === 0) return true;
    var tail = text.slice(text.length - s.length);
    return ignoreCase === true ? tail.toLowerCase() === s.toLowerCase() : tail === s;
  },

  /**
   * Blank and empty, over a null the Kotlin's types said could not happen.
   *
   * jsoup's attr() answers '' where the Kotlin reads a String, and a missing
   * property arrives as undefined; both are 'blank' here rather than a
   * TypeError on .trim().
   */
  isBlank: function (value) { return !__present(value) || __str(value).trim().length === 0; },
  isNotBlank: function (value) { return __present(value) && __str(value).trim().length > 0; },

  isEmpty: function (value) { return __k.isNullOrEmpty(value); },
  isNotEmpty: function (value) { return !__k.isNullOrEmpty(value); },

  /**
   * Kotlin's Any?.toString(), which prints 'null' rather than throwing.
   *
   * Lists print as '[a, b]' and maps as '{k=v}' — a scraper that builds a url
   * out of a list would otherwise get JavaScript's comma-joined spelling, which
   * is a different string.
   */
  toStringOf: function (value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'string') return value;

    // jsoup's Element and Elements both answer their outer HTML, and an
    // extension reaching for a script block writes select(...).toString().
    // Elements is a real Array here, so the list branch below rendered every
    // node through String() — '[object Object]' — and the substringAfter that
    // followed searched that text, found nothing, and returned the whole of it
    // as a video url.
    if (typeof value.outerHtml === 'function') return value.outerHtml();
    if (value instanceof Map) {
      var entries = [];
      value.forEach(function (item, key) { entries.push(__k.toStringOf(key) + '=' + __k.toStringOf(item)); });
      return '{' + entries.join(', ') + '}';
    }
    if (Array.isArray(value) || value instanceof Set) {
      var items = __arr(value);
      var parts = [];
      for (var i = 0; i < items.length; i += 1) parts.push(__k.toStringOf(items[i]));
      return '[' + parts.join(', ') + ']';
    }
    return String(value);
  },

  /**
   * toString(argument), which is two different functions and neither is
   * toString(): 'Int.toString(radix)' — '255.toString(16)' is "ff" — and
   * 'ByteArray.toString(charset)', which DECODES the bytes. Both used to reach
   * 'toStringOf', which ignores an argument: the radix was dropped (a hex
   * digest came out decimal) and the bytes printed as a list. A receiver with
   * its own one-argument toString answers for itself.
   */
  toStringWith: function (value, argument) {
    if (typeof argument === 'number') {
      if (typeof value === 'number' || typeof value === 'bigint') {
        var radix = Math.trunc(argument);
        if (radix < 2 || radix > 36) throw new Error('This converted extension asked for radix ' + radix + '.');
        return value.toString(radix);
      }
    } else if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) {
      return __k.stringOf(value, argument);
    }
    if (value !== null && value !== undefined && typeof value === 'object' &&
        typeof value.toString === 'function' && value.toString.length === 1) {
      return value.toString(argument);
    }
    throw new Error('This converted extension called toString with an argument this runtime does not read.');
  },

  /**
   * trim(), trim(vararg chars) and trim { predicate }, which are one name.
   *
   * The vararg is the part that bites: Kotlin's is 'trim(vararg chars: Char)',
   * so trimming a quote and an apostrophe in one call strips BOTH. Reading only the first
   * argument leaves the other one on the value, and a title that keeps a
   * trailing quote is a wrong value nothing downstream errors on.
   */
  trim: function (value) {
    return __trimEnds(value, Array.prototype.slice.call(arguments, 1), true, true);
  },

  /**
   * trimStart / trimEnd, whose vararg JavaScript's namesakes do not have.
   *
   * Kotlin's are 'trimStart(vararg chars: Char)' and JavaScript's take none, so
   * a passthrough silently trims whitespace where the source asked for a
   * slash — the same latent bug 'trim' had. Given no arguments the two agree
   * exactly, which is why it went unnoticed.
   */
  trimStart: function (value) {
    return __trimEnds(value, Array.prototype.slice.call(arguments, 1), true, false);
  },

  trimEnd: function (value) {
    return __trimEnds(value, Array.prototype.slice.call(arguments, 1), false, true);
  },

  /** Human-readable IEC byte sizes with stable output. */
  formatBytes: function (value) {
    var bytes = Number(value);
    if (!Number.isFinite(bytes)) return '0 B';
    var sign = bytes < 0 ? '-' : '';
    var magnitude = Math.abs(bytes);
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    var unit = 0;
    while (magnitude >= 1024 && unit < units.length - 1) {
      magnitude /= 1024;
      unit += 1;
    }
    var digits = unit === 0 ? 0 : magnitude < 10 ? 2 : magnitude < 100 ? 1 : 0;
    return sign + magnitude.toFixed(digits) + ' ' + units[unit];
  },

  /**
   * 'X.now(…)', dispatched on X.
   *
   * 'now' is a member of every java.time type and of kotlin.time's Clock, and
   * each answers its own kind of value: 'LocalDate.now(zone)' is a date,
   * 'Instant.now()' an instant, 'Clock.System.now()' an instant again. The
   * emitter reaches this helper by name for all of them, so the receiver
   * decides; answering a bare millisecond count for each made
   * 'LocalDateTime.now().year' undefined and 'Instant.now().toEpochMilli()' a
   * call on a number. Wall-clock milliseconds only for a receiver with no 'now'.
   */
  now: function (receiver) {
    if (receiver !== null && receiver !== undefined && typeof receiver.now === 'function') {
      return receiver.now.apply(receiver, Array.prototype.slice.call(arguments, 1));
    }
    return Date.now();
  },

  /**
   * '.rateLimit(permits, period)' on an okhttp client builder.
   *
   * The period arrives already resolved to **whole milliseconds** by the
   * emitter, which is the only place that can do it: 'rateLimit(1, 2)' means
   * two seconds under the TimeUnit overload and 'rateLimit(1, 2.seconds)' means
   * the same thing written another way, and by the time the runtime sees either
   * one the literal has been erased to a number. See 'rateLimitPeriod' there,
   * and the refusal it raises for a period it cannot read exactly.
   *
   * This used to return its receiver and do nothing at all. An extension that
   * politely throttles itself to one request a second was therefore converted
   * into one that does not — no error, no refusal, and a viewer whose address
   * gets blocked by a source that was never asked rudely before.
   */
  rateLimit: function (receiver, permits, periodMs) {
    __declareRateLimit(null, permits, periodMs);
    return receiver;
  },

  /**
   * '.rateLimitHost(url, permits, period)' — the same, scoped to one host.
   *
   * The url is a runtime value: it is almost always built from 'baseUrl' or
   * from a preference, so only the host can know what it resolved to. Both an
   * okhttp 'HttpUrl' and a plain string arrive here and both carry a host.
   */
  rateLimitHost: function (receiver, url, permits, periodMs) {
    __declareRateLimit(__hostOfUrl(url), permits, periodMs);
    return receiver;
  },

  /** Stop/cancel a host-owned handle when it exposes that operation. */
  stop: function (value) {
    if (value !== null && value !== undefined && typeof value.stop === 'function') return value.stop();
    if (value !== null && value !== undefined && typeof value.cancel === 'function') return value.cancel();
    return undefined;
  },

  /**
   * UnsupportedOperationException, which is ordinary control flow here.
   *
   * 134 of 254 extensions throw it from a member they declare and do not
   * implement — 'latestUpdatesRequest' on a source with no latest shelf, say.
   * It must survive translation as a throw: a member that returned undefined
   * instead would hand the adapter an empty page and look like a source that
   * had nothing, rather than one that never offered the shelf.
   */
  unsupported: function (message) {
    throw new Error(
      __present(message) && __str(message).length > 0
        ? __str(message)
        : 'This converted extension does not implement the member that was called.'
    );
  },

  /**
   * 'List<Video>.toHosterList()', the bridge between the two video APIs.
   *
   * A source with no hoster concept still has to answer 'getHosterList', and
   * this is the one-liner the base class supplies for it: wrap everything in a
   * single hoster carrying the sentinel name. It is a companion extension
   * function rather than a member, so it arrives here with its receiver in
   * first position like every other one.
   */
  toHosterList: function (videos) {
    return __mutableList([Hoster('', Hoster.NO_HOSTER_LIST, __arr(videos))]);
  },

  /* -- collections -------------------------------------------------------- */

  /**
   * map, over a list or over a Result.
   *
   * 'runCatching { … }.map { … }' transforms the success and passes a failure
   * through untouched. Without the branch the Result object would go through
   * '__arr', arrive as a one-element list holding the Result itself, and the
   * lambda would be handed the wrapper instead of the value — a wrong value,
   * silently, exactly where the extension was already handling an error.
   */
  map: function (list, fn) {
    // Dispatched, like the Result branch below it: an Observable's 'map' is a
    // transform of the one value it carries, and reading it as a list would
    // walk the wrapper's own keys.
    if (__isObservable(list)) return list.map(fn);
    if (__isResult(list)) {
      if (list.isFailure) return list;
      return __then(fn(list.__value), function (value) { return __success(value); });
    }
    return __each(__chars(list), function (item) { return fn(item); });
  },

  /**
   * Kotlin's mapNotNull, which is not map().filter().
   *
   * It drops nulls from the RESULT, not from the input, and undefined counts:
   * a lambda whose last expression is an if with no else returns undefined
   * here and Unit there.
   */
  mapNotNull: function (list, fn) {
    return __then(__each(__arr(list), function (item) { return fn(item); }), function (values) {
      var out = [];
      for (var i = 0; i < values.length; i += 1) if (__present(values[i])) out.push(values[i]);
      return out;
    });
  },

  /** Keep only non-null input values, in their original order. */
  filterNotNull: function (list) {
    var items = __arr(list);
    var out = [];
    for (var i = 0; i < items.length; i += 1) if (__present(items[i])) out.push(items[i]);
    return out;
  },

  /**
   * filter, which answers a String for a String.
   *
   * Kotlin's 'CharSequence.filter' returns a CharSequence, not a List<Char>:
   * '"a1b2".filter { it.isDigit() }' is "12". Handing back ['1','2'] instead
   * would print as '1,2' the moment it reached a string template.
   */
  filter: function (list, predicate) {
    var items = __chars(list);
    var text = typeof list === 'string';
    // Over a Map, Kotlin's filter answers a Map, and '.keys' is read off it.
    var map = __isMap(list);
    return __then(__each(items, function (item) { return predicate(item); }), function (flags) {
      var out = [];
      for (var i = 0; i < items.length; i += 1) if (flags[i]) out.push(items[i]);
      return text ? out.join('') : (map ? __mapFrom(out) : out);
    });
  },

  filterNot: function (list, predicate) {
    var items = __chars(list);
    var text = typeof list === 'string';
    // Over a Map, Kotlin's filterNot answers a Map, and '.keys' is read off it.
    var map = __isMap(list);
    return __then(__each(items, function (item) { return predicate(item); }), function (flags) {
      var out = [];
      for (var i = 0; i < items.length; i += 1) if (!flags[i]) out.push(items[i]);
      return text ? out.join('') : (map ? __mapFrom(out) : out);
    });
  },

  flatMap: function (list, fn) {
    if (__isObservable(list)) return list.flatMap(fn);
    return __then(__each(__arr(list), function (item) { return fn(item); }), function (values) {
      var out = [];
      for (var i = 0; i < values.length; i += 1) {
        var inner = __arr(values[i]);
        for (var j = 0; j < inner.length; j += 1) out.push(inner[j]);
      }
      return out;
    });
  },

  firstOrNull: function (list, predicate) {
    var items = __arr(list);
    if (typeof predicate !== 'function') return items.length === 0 ? null : items[0];
    return __then(__firstIndex(items, predicate), function (index) {
      return index === -1 ? null : items[index];
    });
  },

  /**
   * Kotlin's first(), which throws rather than answering null.
   *
   * Written over the index and not over firstOrNull, so that a list whose first
   * element legitimately IS null is answered rather than reported as empty.
   */
  first: function (list, predicate) {
    var items = __arr(list);
    if (typeof predicate !== 'function') {
      if (items.length === 0) {
        throw new Error('This converted extension took the first item of an empty list.');
      }
      return items[0];
    }
    return __then(__firstIndex(items, predicate), function (index) {
      if (index === -1) {
        throw new Error('This converted extension found no item matching what it asked for.');
      }
      return items[index];
    });
  },

  lastOrNull: function (list, predicate) {
    var items = __arr(list);
    if (typeof predicate !== 'function') return items.length === 0 ? null : items[items.length - 1];
    var reversed = items.slice().reverse();
    return __then(__firstIndex(reversed, predicate), function (index) {
      return index === -1 ? null : reversed[index];
    });
  },

  last: function (list, predicate) {
    var items = __arr(list);
    if (typeof predicate !== 'function') {
      if (items.length === 0) {
        throw new Error('This converted extension took the last item of an empty list.');
      }
      return items[items.length - 1];
    }
    var reversed = items.slice().reverse();
    return __then(__firstIndex(reversed, predicate), function (index) {
      if (index === -1) {
        throw new Error('This converted extension found no item matching what it asked for.');
      }
      return reversed[index];
    });
  },

  /**
   * 'list.find { }' and 'regex.find(s)' are one call site after translation.
   *
   * They mean entirely different things — a matching element, and a MatchResult
   * — and the emitter has no types to disambiguate with, so the receiver does.
   */
  find: function (list, predicate, startIndex) {
    if (list && list.__isRegex === true) return list.find(predicate, startIndex);
    return __k.firstOrNull(list, predicate);
  },

  any: function (list, predicate) {
    var items = __chars(list);
    if (typeof predicate !== 'function') return items.length > 0;
    return __then(__firstIndex(items, predicate), function (index) { return index !== -1; });
  },

  all: function (list, predicate) {
    var items = __chars(list);
    return __then(__firstIndex(items, function (item) { return __negate(predicate(item)); }), function (index) {
      return index === -1;
    });
  },

  none: function (list, predicate) {
    var items = __chars(list);
    if (typeof predicate !== 'function') return items.length === 0;
    return __then(__firstIndex(items, predicate), function (index) { return index === -1; });
  },

  indexOfFirst: function (list, predicate) {
    return __firstIndex(__chars(list), predicate);
  },

  /** Stable, because Kotlin's is and a reordered episode list is visible. */
  sortedBy: function (list, selector) {
    var items = __arr(list).slice();
    return __then(__each(items, function (item) { return selector(item); }), function (keys) {
      var order = [];
      for (var i = 0; i < items.length; i += 1) order.push(i);
      order.sort(function (a, b) {
        var delta = __cmp(keys[a], keys[b]);
        return delta !== 0 ? delta : a - b;
      });
      var out = [];
      for (var j = 0; j < order.length; j += 1) out.push(items[order[j]]);
      return out;
    });
  },

  /** Reversing an ascending result would also reverse equal keys. */
  sortedByDescending: function (list, selector) {
    var items = __arr(list).slice();
    return __then(__each(items, function (item) { return selector(item); }), function (keys) {
      var order = [];
      for (var i = 0; i < items.length; i += 1) order.push(i);
      order.sort(function (a, b) {
        var delta = __cmp(keys[b], keys[a]);
        return delta !== 0 ? delta : a - b;
      });
      var out = [];
      for (var j = 0; j < order.length; j += 1) out.push(items[order[j]]);
      return out;
    });
  },

  /** maxOf on a collection requires an element and a selector. */
  maxOf: function (list, selector) {
    var items = __arr(list);
    if (items.length === 0) throw new Error('This converted extension took maxOf an empty collection.');
    return __then(__each(items, selector), function (values) {
      var best = values[0];
      for (var i = 1; i < values.length; i += 1) if (__cmp(values[i], best) > 0) best = values[i];
      return best;
    });
  },

  /** MutableList sorts change the receiver and answer Unit. */
  sortBy: function (list, selector) {
    return __then(__k.sortedBy(list, selector), function (sorted) { return __sortInPlace(list, sorted); });
  },

  sortByDescending: function (list, selector) {
    return __then(__k.sortedByDescending(list, selector), function (sorted) {
      return __sortInPlace(list, sorted);
    });
  },

  sortWith: function (list, comparator) {
    return __sortInPlace(list, __k.sortedWith(list, comparator));
  },

  sortDescending: function (list) {
    return __sortInPlace(list, __k.sortedDescending(list));
  },

  /** Null is a miss, so a fallback may run again for a present key. */
  getOrPut: function (map, key, make) {
    if (map instanceof Map) {
      if (map.has(key) && __present(map.get(key))) return map.get(key);
      return __then(make(), function (value) { map.set(key, value); return value; });
    }
    if (map === null || map === undefined || typeof map !== 'object') {
      throw new Error('This converted extension called getOrPut on something that is not a map.');
    }
    if (Object.prototype.hasOwnProperty.call(map, key) && __present(map[key])) return map[key];
    return __then(make(), function (value) { map[key] = value; return value; });
  },

  /**
   * reversed(), over the three things Kotlin spells that way.
   *
   * A Comparator reversed is a Comparator, not a one-element list of one — and
   * 'compareBy { … }.reversed()' is how half the video sorters in this
   * ecosystem are written, so getting it wrong sorts nothing and reports no
   * error. A String reversed is a String; reading it as a list would hand the
   * caller '["cba"]' spelled forwards.
   */
  /** Int.inc()/dec(), and Char's, which step to the neighbouring character. */
  inc: function (value) {
    return __isChar(value) ? String.fromCharCode(value.charCodeAt(0) + 1) : value + 1;
  },
  dec: function (value) {
    return __isChar(value) ? String.fromCharCode(value.charCodeAt(0) - 1) : value - 1;
  },

  /**
   * groupingBy { key }: Kotlin's lazy Grouping, which does nothing until a
   * terminal runs. eachCount() is the one this ecosystem writes - a Map from
   * each key to how many elements had it, in first-seen order, as the
   * LinkedHashMap Kotlin answers.
   */
  /**
   * java.text.StringCharacterIterator: a cursor over a string. current() is
   * the character under it, next()/previous() move it and answer the new one,
   * and walking off either end answers DONE (U+FFFF) as java.text does.
   */
  charIterator: function (text) {
    var value = __str(text);
    var at = 0;
    var DONE = '\uffff';
    var here = function () { return at >= 0 && at < value.length ? value.charAt(at) : DONE; };
    return {
      current: here,
      next: function () { at = Math.min(at + 1, value.length); return here(); },
      previous: function () {
        if (at <= 0) return DONE;
        at -= 1;
        return here();
      },
      first: function () { at = 0; return here(); },
      last: function () { at = Math.max(0, value.length - 1); return here(); },
      getIndex: function () { return at; },
      setIndex: function (index) { at = Number(index); return here(); },
      getBeginIndex: function () { return 0; },
      getEndIndex: function () { return value.length; }
    };
  },

  groupingBy: function (list, keyOf) {
    var items = __arr(list);
    return {
      eachCount: function () {
        var counts = new Map();
        for (var i = 0; i < items.length; i += 1) {
          var key = keyOf(items[i]);
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        return counts;
      }
    };
  },

  reversed: function (list) {
    if (__isComparator(list)) {
      return __comparator(function (a, b) { return -list(a, b); });
    }
    if (typeof list === 'string') return list.split('').reverse().join('');
    return __arr(list).slice().reverse();
  },

  distinct: function (list) {
    var items = __arr(list);
    var seen = new Set();
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      if (seen.has(items[i])) continue;
      seen.add(items[i]);
      out.push(items[i]);
    }
    return out;
  },

  /**
   * take/drop, which answer a String for a String.
   *
   * Kotlin's 'String.take(2)' is "ab" and its 'List.take(2)' is a list. This
   * runtime models a String as a scalar rather than as a list of Chars, so
   * without the branch '"abcd".take(2)' would go through '__arr' and come back
   * as the whole string in a one-element array — a value that reads as the
   * untruncated string everywhere downstream.
   */
  take: function (list, count) {
    var size = Math.max(0, Number(count));
    if (typeof list === 'string') return list.slice(0, size);
    return __arr(list).slice(0, size);
  },

  drop: function (list, count) {
    var size = Math.max(0, Number(count));
    if (typeof list === 'string') return list.slice(size);
    return __arr(list).slice(size);
  },

  /**
   * joinToString, over Kotlin's whole signature.
   *
   * That signature is (separator, prefix, postfix, limit, truncated, transform),
   * and named arguments reach here as positions with gaps filled by undefined —
   * so 'joinToString(prefix = ...) { … }' arrives as three arguments with the
   * first one absent. Reading argument two as the transform, which a
   * (list, separator, transform) helper must, drops the prefix silently and
   * puts a function where a string belongs.
   *
   * 'limit' is the other quiet one: Kotlin stops after that many elements and
   * appends 'truncated' — a genre list joined without it is longer than the
   * extension meant it to be.
   */
  /**
   * 'joinTo(buffer, separator, …) { … }' — 'joinToString' with somewhere to
   * put the result.
   *
   * The one idiom in this catalogue is inside a 'buildString'/'apply', where
   * the buffer is the implicit receiver: 'altNames.joinTo(this, "\\n") { "- $it" }'.
   * So the work is 'joinToString' plus an append, and the buffer is returned
   * because Kotlin returns it and a chain may go on from there.
   *
   * A buffer that cannot be appended to answers the joined text instead,
   * which is what a caller reading the result expects and is never wrong in a
   * way that is silent.
   */
  /**
   * 'firstInstance<T>()' / 'firstInstanceOrNull<T>()' — keiyoushi's reader for
   * a heterogeneous list, and the idiom behind every filter panel in this
   * catalogue: 'filters.firstInstance<GenreFilter>()' picks the one filter of
   * a given type out of the list the host handed back.
   *
   * The type arrives as the emitter's reified argument, which is the
   * constructor itself, so the test is an ordinary 'instanceof'. Without a
   * usable one the answer is null rather than a guess: picking the first
   * element regardless of type would hand a genre filter's state to a sort
   * filter and narrow a search by the wrong thing, silently.
   */
  firstInstanceOrNull: function (list, type) {
    var items = __arr(list);
    if (typeof type !== 'function') return null;
    for (var at = 0; at < items.length; at += 1) {
      if (items[at] instanceof type) return items[at];
    }
    return null;
  },

  /** The same, where Kotlin throws rather than answering null. Throwing is
   * right: the caller goes straight on to read a field off it. */
  firstInstance: function (list, type) {
    var found = __k.firstInstanceOrNull(list, type);
    if (found === null) {
      throw new Error('This converted extension expected a filter that was not in the list.');
    }
    return found;
  },

  /** 'mapTo(destination) { … }' — 'map' with somewhere to put the result,
   * and the destination is returned because Kotlin returns it. */
  mapTo: function (list, destination, transform) {
    return __then(
      __each(__arr(list), function (item) {
        return typeof transform === 'function' ? transform(item) : item;
      }),
      function (values) {
        for (var at = 0; at < values.length; at += 1) destination.push(values[at]);
        return destination;
      }
    );
  },

  /** Append non-null transformed values to the destination itself. */
  mapNotNullTo: function (list, destination, transform) {
    return __then(__k.mapNotNull(list, transform), function (values) {
      for (var i = 0; i < values.length; i += 1) __k.add(destination, values[i]);
      return destination;
    });
  },

  /**
   * 'toCollection(destination)': every element added, in order, to a
   * collection the caller already holds — and that collection answered, not a
   * copy, because the idiom is a loop appending page after page onto one list.
   *
   * Through '__k.add', so a Set destination keeps its own de-duplication and a
   * Map destination takes pairs, exactly as Kotlin's MutableCollection.add
   * would. A suspended upstream (a sequence whose 'map' was handed a suspending
   * lambda) is awaited first.
   */
  toCollection: function (list, destination) {
    return __then(list, function (items) {
      var incoming = __arr(items);
      for (var at = 0; at < incoming.length; at += 1) __k.add(destination, incoming[at]);
      return destination;
    });
  },

  joinTo: function (list, buffer) {
    var rest = Array.prototype.slice.call(arguments, 2);
    var text = __k.joinToString.apply(null, [list].concat(rest));
    if (buffer !== null && buffer !== undefined && typeof buffer.append === 'function') {
      buffer.append(text);
      return buffer;
    }
    return text;
  },

  joinToString: function (list) {
    var rest = Array.prototype.slice.call(arguments, 1);
    var fn = null;
    // The transform is always last in Kotlin, and a trailing lambda lands last
    // here too, so it is taken off the end rather than guessed at by position.
    if (rest.length > 0 && typeof rest[rest.length - 1] === 'function') fn = rest.pop();

    var separator = ', ';
    var prefix = '';
    var postfix = '';
    var limit = -1;
    var truncated = '...';

    var options = rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object' &&
      !Array.isArray(rest[0]) ? rest[0] : null;
    if (options !== null) {
      if (typeof options.separator === 'string') separator = options.separator;
      prefix = __str(options.prefix);
      postfix = __str(options.postfix);
      if (typeof options.limit === 'number') limit = options.limit;
      if (options.truncated !== undefined) truncated = __str(options.truncated);
      if (typeof options.transform === 'function') fn = options.transform;
    } else {
      if (rest[0] !== undefined && rest[0] !== null) separator = __str(rest[0]);
      if (rest[1] !== undefined && rest[1] !== null) prefix = __str(rest[1]);
      if (rest[2] !== undefined && rest[2] !== null) postfix = __str(rest[2]);
      if (rest[3] !== undefined && rest[3] !== null) limit = Number(rest[3]);
      if (rest[4] !== undefined && rest[4] !== null) truncated = __str(rest[4]);
    }

    var items = __arr(list);
    var cut = limit >= 0 && limit < items.length;
    var taken = cut ? items.slice(0, limit) : items;
    return __then(__each(taken, function (item) { return fn === null ? item : fn(item); }), function (values) {
      var out = [];
      for (var i = 0; i < values.length; i += 1) out.push(__str(values[i]));
      if (cut) out.push(truncated);
      return prefix + out.join(separator) + postfix;
    });
  },

  toList: function (value) { return __arr(value).slice(); },

  /**
   * Kotlin's toSet, with 'contains' spelled the way the emitter may reach for.
   *
   * A Set is iterable, so every other helper here takes it unchanged.
   */
  toSet: function (value) {
    var set = new Set(__arr(value));
    set.contains = function (item) { return set.has(item); };
    return set;
  },

  forEach: function (list, fn) {
    return __then(__each(__chars(list), function (item) { return fn(item); }), function () { return undefined; });
  },

  groupBy: function (list, keySelector, valueSelector) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return keySelector(item); }), function (keys) {
      return __then(
        __each(items, function (item) { return valueSelector ? valueSelector(item) : item; }),
        function (values) {
          var grouped = new Map();
          for (var i = 0; i < items.length; i += 1) {
            if (!grouped.has(keys[i])) grouped.set(keys[i], []);
            grouped.get(keys[i]).push(values[i]);
          }
          return grouped;
        }
      );
    });
  },

  /** The lambda returns a pair, which the emitter writes as a two-element array. */
  associate: function (list, fn) {
    return __then(__each(__arr(list), function (item) { return fn(item); }), function (pairs) {
      var out = new Map();
      for (var i = 0; i < pairs.length; i += 1) {
        var pair = pairs[i];
        if (pair === null || pair === undefined) continue;
        if (Array.isArray(pair)) out.set(pair[0], pair[1]);
        else out.set(pair.first, pair.second);
      }
      return out;
    });
  },

  /**
   * Kotlin's indices — every valid index of a string or collection, in order.
   *
   * Kotlin's is an IntRange; an array of the same numbers is what every use of
   * one in this ecosystem does with it, and it is what __k.range and __k.until
   * already answer.
   */
  /**
   * Char.code, and every other .code read, which is the same spelling.
   *
   * A Char is a one-character string here, so its code is the character's own
   * code unit; a String has no .code in Kotlin, so a one-character string
   * reaching this is always a Char. Anything else — okhttp's response.code, a
   * DTO field — is handed back as the property it is.
   */
  code: function (value) {
    if (__isChar(value)) return value.charCodeAt(0);
    return value === null || value === undefined ? value : value.code;
  },

  indices: function (value) {
    var length = typeof value === 'string' ? value.length : __arr(value).length;
    var out = [];
    for (var i = 0; i < length; i += 1) out.push(i);
    return out;
  },

  /**
   * List.lastIndex / CharSequence.lastIndex: size minus one, so -1 for an
   * empty one, as Kotlin's. It is also an ordinary field name, so a receiver
   * that is neither a string nor a list and has the property answers it.
   */
  lastIndex: function (value) {
    if (typeof value === 'string' || Array.isArray(value)) return value.length - 1;
    if (value !== null && value !== undefined && typeof value === 'object' && 'lastIndex' in value) {
      return value.lastIndex;
    }
    return __arr(value).length - 1;
  },

  /** associateBy: the lambda answers the key, and the item is the value. */
  /**
   * flatMapIndexed { index, item -> … }, which hands the INDEX first.
   *
   * The mirror of mapIndexed, and the argument order is the whole hazard: a
   * lambda written (i, list) that received (list, i) would index a list with a
   * list and flatten nothing, silently.
   */
  flatMapIndexed: function (list, fn) {
    var items = __arr(list);
    return __then(__each(items, function (item, at) { return fn(at, item); }), function (parts) {
      var out = [];
      for (var i = 0; i < parts.length; i += 1) {
        var inner = __arr(parts[i]);
        for (var j = 0; j < inner.length; j += 1) out.push(inner[j]);
      }
      return out;
    });
  },

  associateBy: function (list, fn) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return fn(item); }), function (keys) {
      var out = new Map();
      for (var i = 0; i < items.length; i += 1) out.set(keys[i], items[i]);
      return out;
    });
  },

  /** associateWith: the mirror image — the item is the key. */
  associateWith: function (list, fn) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return fn(item); }), function (values) {
      var out = new Map();
      for (var i = 0; i < items.length; i += 1) out.set(items[i], values[i]);
      return out;
    });
  },

  /**
   * kotlin.math.pow, which Kotlin writes as a method on the number.
   *
   * Kotlin's is Float.pow(Int): Float and JavaScript has one number type, so a
   * caller that folds the result back with toInt() gets what it asked for, and
   * one that keeps it gets a double where Kotlin had a float. The difference
   * shows up past 2^24, which no base-62 unbaser reaches.
   */
  /*
   * kotlin.math, called bare. JavaScript's Math agrees with Kotlin on every one
   * of these for the doubles and ints a scraper handles — NaN propagates the
   * same way through min and max — except round, which is below.
   */
  mathAbs: function (value) { return Math.abs(Number(value)); },
  mathMin: function (a, b) { return Math.min(Number(a), Number(b)); },
  mathMax: function (a, b) { return Math.max(Number(a), Number(b)); },
  mathCeil: function (value) { return Math.ceil(Number(value)); },
  mathFloor: function (value) { return Math.floor(Number(value)); },
  mathSqrt: function (value) { return Math.sqrt(Number(value)); },
  mathLog10: function (value) { return Math.log10(Number(value)); },
  mathSign: function (value) { return Math.sign(Number(value)); },

  /**
   * kotlin.math.round, which rounds a tie to the EVEN neighbour: round(2.5) is
   * 2.0 and round(3.5) is 4.0. Math.round sends every tie up, which is what
   * roundToInt does and not what this does.
   */
  mathRound: function (value) {
    var x = Number(value);
    if (!Number.isFinite(x)) return x;
    var floor = Math.floor(x);
    var diff = x - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  },

  /**
   * The free maxOf(a, b, …) and minOf(a, b, …), over numbers or anything
   * comparable. Kotlin answers the first of equal values, and NaN for a NaN
   * among doubles, which Math.max/min already do.
   */
  mathMaxOf: function () {
    var values = Array.prototype.slice.call(arguments);
    if (values.every(function (v) { return typeof v === 'number'; })) return Math.max.apply(null, values);
    var best = values[0];
    for (var i = 1; i < values.length; i += 1) if (values[i] > best) best = values[i];
    return best;
  },
  mathMinOf: function () {
    var values = Array.prototype.slice.call(arguments);
    if (values.every(function (v) { return typeof v === 'number'; })) return Math.min.apply(null, values);
    var best = values[0];
    for (var i = 1; i < values.length; i += 1) if (values[i] < best) best = values[i];
    return best;
  },

  pow: function (value, exponent) {
    return Math.pow(Number(value), Number(exponent));
  },

  sumOf: function (list, selector) {
    return __then(__each(__arr(list), function (item) { return selector(item); }), function (values) {
      var total = 0;
      for (var i = 0; i < values.length; i += 1) total += Number(values[i]) || 0;
      return total;
    });
  },

  count: function (list, predicate) {
    var items = __chars(list);
    if (typeof predicate !== 'function') return items.length;
    return __then(__each(items, function (item) { return predicate(item); }), function (flags) {
      var total = 0;
      for (var i = 0; i < flags.length; i += 1) if (flags[i]) total += 1;
      return total;
    });
  },

  /**
   * IndexedValue, readable both ways.
   *
   * Kotlin destructures 'for ((index, value) in list.withIndex())' positionally
   * and reads '.index' by name elsewhere; the emitter may produce either, so
   * each entry answers to both.
   */
  withIndex: function (list) {
    var items = __arr(list);
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var entry = [i, items[i]];
      entry.index = i;
      entry.value = items[i];
      out.push(entry);
    }
    return out;
  },

  zip: function (a, b, transform) {
    var left = __arr(a);
    var right = __arr(b);
    var size = Math.min(left.length, right.length);
    var indices = [];
    for (var i = 0; i < size; i += 1) indices.push(i);
    if (typeof transform === 'function') {
      return __each(indices, function (index) { return transform(left[index], right[index]); });
    }
    var out = [];
    for (var j = 0; j < size; j += 1) {
      var pair = [left[j], right[j]];
      pair.first = left[j];
      pair.second = right[j];
      out.push(pair);
    }
    return out;
  },

  chunked: function (list, size, transform) {
    var items = __arr(list);
    var width = Math.max(1, Number(size));
    var chunks = [];
    for (var i = 0; i < items.length; i += width) chunks.push(items.slice(i, i + width));
    if (typeof transform !== 'function') return chunks;
    return __each(chunks, function (chunk) { return transform(chunk); });
  },

  /**
   * Kotlin's '+', and the plus() it is spelled as — dispatched on the LEFT
   * operand, which is where Kotlin resolves it.
   *
   * The emitter has no types, and JavaScript's '+' reads a list as its text:
   * 'listOf(1) + listOf(2)' was the string "12", a filter list built as
   * 'EVERY + getPairList(n)' was one long string, and nothing refused or threw.
   * So an operand the emitter cannot prove is a number or a string comes here.
   *
   * A number adds and a string (or a null String?) concatenates, exactly as
   * the plain operator would. A Map merges a Map, a Pair or a list of Pairs;
   * a Set unions; anything else that iterates is a list, which concatenates a
   * collection and appends anything else. A Pair is an array here, and is one
   * element rather than two. A class that declares its own 'operator fun plus'
   * is asked for it.
   *
   * 'Char + Int' is the one case this cannot see: a Char is a one-character
   * string, so it concatenates. The emitter answers that where the Char is a
   * literal, which is the only place it can be told apart.
   */
  plus: function (left, right, unit) {
    // A date moved by an amount: 'zoned.plus(3, ChronoUnit.DAYS)'.
    if (left !== null && left !== undefined && left.__kTime === true) return left.plus(right, unit);
    if (typeof left === 'number' || typeof left === 'string' || left === null || left === undefined) {
      return left + right;
    }
    if (left instanceof Map) {
      var merged = new Map(left);
      if (right instanceof Map) right.forEach(function (value, key) { merged.set(key, value); });
      else if (__isPair(right)) merged.set(right.first, right.second);
      else {
        var entries = __arr(right);
        for (var e = 0; e < entries.length; e += 1) merged.set(entries[e].first, entries[e].second);
      }
      return merged;
    }
    if (left instanceof Set) {
      var union = __k.toSet(__arr(left));
      var adding = __isCollection(right) ? __arr(right) : [right];
      for (var u = 0; u < adding.length; u += 1) union.add(adding[u]);
      return union;
    }
    if (!Array.isArray(left) && typeof left === 'object' && typeof left.plus === 'function') {
      return left.plus(right);
    }
    var items = __arr(left).slice();
    if (__isCollection(right)) return items.concat(__arr(right));
    items.push(right);
    return items;
  },

  listOfNotNull: function () {
    var out = [];
    for (var i = 0; i < arguments.length; i += 1) if (__present(arguments[i])) out.push(arguments[i]);
    return out;
  },

  emptyList: function () { return []; },

  /* -- scope functions ---------------------------------------------------- */

  /**
   * The scope functions, and the 'this' a receiver block reads.
   *
   * 'apply', 'run' and 'with' hand their block a RECEIVER, and the emitter
   * writes that block as a function whose body says 'this.title = ...'. A
   * bundle is an ES module, so it is strict, so a plain fn(value) leaves 'this'
   * undefined and every one of those blocks dies with 'undefined is not an
   * object' — on the first search, inside the sandbox. Calling through .call
   * binds both spellings at once: 'this' for a receiver block, and the argument
   * for the 'it' form of let/also, whose lambdas are arrows and ignore it.
   */
  let: function (value, fn) { return fn(value); },
  run: function (value, fn) { return fn.call(value, value); },
  also: function (value, fn) { return __then(fn(value), function () { return value; }); },
  apply: function (value, fn) { return __then(fn.call(value, value), function () { return value; }); },

  /**
   * A block written for a parameter typed 'R.() -> T', as a plain function
   * taking R first.
   *
   * The block itself is emitted as a receiver function, whose body reads its
   * receiver as 'this'. A value of such a type travels in the shape Kotlin
   * gives it wherever a '(R) -> T' is expected — receiver first — because that
   * is how everything that later calls it will call it: 'block(builder)' from
   * the translated function, 'apply(block)' through the helper above, or
   * 'use(parse)' through 'let'. This is the one place the two shapes meet, so
   * both 'this' and the leading argument are the receiver on the way in — and
   * a caller that binds only 'this', as a receiver block's own callers did
   * before this existed, still hands over the receiver it meant.
   */
  receiverLambda: function (fn) {
    return function (receiver) {
      if (arguments.length === 0) return fn.call(this);
      return fn.apply(receiver, Array.prototype.slice.call(arguments, 1));
    };
  },

  takeIf: function (value, predicate) {
    return __then(predicate(value), function (verdict) { return verdict ? value : null; });
  },

  takeUnless: function (value, predicate) {
    return __then(predicate(value), function (verdict) { return verdict ? null : value; });
  },

  /**
   * Kotlin's runCatching, which swallows a failure into a value.
   *
   * A suspending block makes the Result asynchronous, and a rejected promise
   * that escaped the catch would crash the whole call rather than being the
   * failure the extension asked to handle.
   */
  runCatching: function (a, b) {
    // Kotlin has both a bare runCatching and a receiver one, and the emitter
    // routes them to the same helper — the second with the receiver first.
    // Reading that receiver as the block calls a string, which is an error the
    // extension never wrote.
    var block = typeof b === 'function' ? b : a;
    var receiver = typeof b === 'function' ? a : undefined;
    try {
      var produced = block.call(receiver, receiver);
      if (__thenable(produced)) {
        return produced.then(__success, function (error) {
          if (error instanceof __Jump) throw error;
          return __failure(error);
        });
      }
      return __success(produced);
    } catch (error) {
      // A non-local return is not a failure. Kotlin's 'return' inside a
      // 'runCatching' leaves the enclosing function; it does not produce a
      // failed Result, and swallowing the marker here would answer the
      // fallback where the source answered its own value. See '__k.jump'.
      if (error instanceof __Jump) throw error;
      return __failure(error);
    }
  },

  /* -- coroutines, flattened --------------------------------------------- */

  /** The sandbox is single-threaded, so a dispatcher is a no-op. */
  async: function (fn) {
    var promise = Promise.resolve().then(function () { return fn(); });
    promise.await = function () { return promise; };
    return promise;
  },

  /**
   * 'CoroutineScope(Dispatchers.IO)', and whether it is a supervisor.
   *
   * The dispatcher is a thread pool, and there is one thread here, so it is
   * dropped. The Job is not: under a plain Job one failed child cancels the
   * whole scope, and every launch after it never runs; under a SupervisorJob a
   * failure is its child's alone. The emitter reads which was written.
   */
  coroutineScope: function (supervisor) {
    return { supervisor: supervisor === true, cancelled: false };
  },

  /**
   * 'scope.launch { … }' — started, not awaited.
   *
   * On Android this is a block handed to another thread while the caller
   * carries on, and the caller never sees its result. Here it is the same
   * block started as a promise nobody awaits: it begins once the caller has
   * yielded, runs concurrently with whatever the caller does next, and a
   * request it makes goes out through the host like any other. That is the
   * whole of what 'launch' promises; how many threads carry it is not.
   *
   * A failure is logged, never thrown: a launched block has nobody to throw
   * to, and on Android an uncaught one is an app crash, which a host must not
   * reproduce. A plain-Job scope is then cancelled, as Kotlin's would be, so
   * a later launch on it does not run. 'scope' is null for GlobalScope, which
   * nothing cancels.
   *
   * Cancelling a running job is refused rather than faked: Kotlin stops the
   * block at its next suspension point, and a promise cannot be stopped, so a
   * 'cancel' that answered would let the block go on making requests and
   * writing state while the caller believed it had stopped.
   */
  launch: function (scope, block) {
    var job = {
      isActive: true,
      isCompleted: false,
      isCancelled: false,
      cancel: function () {
        throw new Error('This converted extension cancelled a launched coroutine, which cannot be stopped here.');
      }
    };
    var scoped = scope !== null && typeof scope === 'object';
    if (scoped && scope.cancelled === true) {
      job.isActive = false;
      job.isCompleted = true;
      job.isCancelled = true;
      job.done = Promise.resolve();
      job.join = function () { return job.done; };
      return job;
    }
    job.done = Promise.resolve()
      .then(function () { return block(); })
      .then(
        function () {
          job.isActive = false;
          job.isCompleted = true;
        },
        function (error) {
          job.isActive = false;
          job.isCompleted = true;
          job.isCancelled = true;
          if (scoped && scope.supervisor !== true) scope.cancelled = true;
          __k.printStackTrace(error);
        }
      );
    job.join = function () { return job.done; };
    return job;
  },

  /** A throw, as a call: 'x ?: throw e' in a position only an expression can hold. */
  raise: function (error) {
    // Kotlin's 'throw null' is a NullPointerException, not a throw of nothing.
    if (error === null || error === undefined) {
      throw new Error('This converted extension threw a value that was null.');
    }
    throw error;
  },

  /**
   * java.util.UUID.randomUUID(), as its text: 122 random bits in the
   * version-4 layout. What an extension does with one is send it as a session
   * id, and a site can check its shape but not where the bits came from, so
   * the platform's secure generator is used where there is one and
   * Math.random where there is not.
   */
  randomUUID: function () {
    var bytes = [];
    var secure = typeof crypto !== 'undefined' && crypto !== null && typeof crypto.getRandomValues === 'function';
    if (secure) {
      var buffer = new Uint8Array(16);
      crypto.getRandomValues(buffer);
      for (var i = 0; i < 16; i += 1) bytes.push(buffer[i]);
    } else {
      for (var j = 0; j < 16; j += 1) bytes.push(Math.floor(Math.random() * 256));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = bytes.map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' + hex.slice(20);
  },

  awaitAll: function (list) {
    var items = __arr(list);
    var pending = [];
    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];
      pending.push(item && typeof item.await === 'function' ? item.await() : item);
    }
    return Promise.all(pending);
  },

  /** call.await(), and anything else the emitter suspends on. */
  /**
   * call.execute(), which Kotlin blocks on and JavaScript cannot.
   *
   * Only awaitSuccess was routed through a helper the emitter knows to await;
   * execute() was a plain passthrough, so an extension written the blocking way
   * got a Promise where it expected a Response. It then read an empty script
   * off it, matched no episodes and returned an empty list — while the request
   * it had fired landed after the check had already given up on it.
   */
  executeCall: function (call) {
    if (call !== null && call !== undefined && typeof call.execute === 'function') {
      return call.execute();
    }
    if (call !== null && call !== undefined && typeof call.await === 'function') {
      return call.await();
    }
    return Promise.resolve(call);
  },

  /**
   * call.awaitSuccess(), which differs from await by throwing on a non-2xx.
   *
   * It had been collapsed onto await, so the one thing that separates the two
   * names — the throw an extension relies on to stop reading a dead mirror —
   * did not happen.
   */
  awaitSuccess: function (call) {
    if (call !== null && call !== undefined && typeof call.awaitSuccess === 'function') {
      return call.awaitSuccess();
    }
    return __k.await(call);
  },

  /**
   * keiyoushi's 'client.get(url)', 'post', 'put' and 'head': build the request,
   * send it through the client, await it, and throw on a non-2xx unless told
   * 'ensureSuccess = false'.
   *
   * Each is declared twice in that repository's core/ network helpers — once
   * taking 'headers', once reading them off the HttpSource context receiver —
   * and the emitter cannot tell which was written, because the second
   * positional argument is 'headers' in one and 'cacheControl' or 'body' in
   * the other. The values can tell: a Headers value, a request body and a
   * boolean are each recognisable, and whatever is none of them is the cache
   * policy, which this runtime leaves to the host exactly as GET does.
   *
   * With no headers passed, the source's own 'headers' are used, which is what
   * the context-receiver overload reads. A receiver that is not this runtime's
   * client is somebody else's class with a 'get' of its own, and is called as
   * written — or, for 'get' with one argument, indexed, which is what that
   * spelling meant before this helper existed.
   */
  okhttp: function (client, verb, positional, named) {
    var args = positional || [];
    var options = named || {};
    if (client === null || client === undefined || typeof client.newCall !== 'function') {
      if (Object.keys(options).length > 0) {
        throw new Error(
          'This converted extension passed named arguments to a ' + verb + '() that is not an ' +
          'okhttp client, so which parameter each one is could not be read.'
        );
      }
      if (client !== null && client !== undefined && typeof client[verb] === 'function') {
        return client[verb].apply(client, args);
      }
      if (verb === 'get' && args.length === 1) return __k.getAt(client, args[0]);
      throw new Error('This converted extension called ' + verb + '() on something that has none.');
    }

    var url = options.url !== undefined ? options.url : args[0];
    var headers = options.headers;
    var body = options.body;
    var ensureSuccess = options.ensureSuccess;
    for (var i = options.url !== undefined ? 0 : 1; i < args.length; i += 1) {
      var value = args[i];
      if (typeof value === 'boolean') ensureSuccess = value;
      else if (__isHeadersValue(value)) headers = value;
      else if (value !== null && typeof value === 'object' && (value.__kBody === true || typeof value.text === 'string')) {
        body = value;
      }
      /* Anything else is the CacheControl, which the host owns. */
    }
    if (url === undefined || url === null) {
      throw new Error('This converted extension called ' + verb + '() with no url.');
    }
    if ((verb === 'post' || verb === 'put') && (body === undefined || body === null)) {
      throw new Error('This converted extension called ' + verb + '() with no request body.');
    }
    if (headers === undefined || headers === null) headers = __sourceHeaders();

    var request = __kRequest(verb.toUpperCase(), url, headers, verb === 'get' || verb === 'head' ? null : body);
    var call = client.newCall(request);
    return ensureSuccess === false ? call.await() : call.awaitSuccess();
  },

  await: function (value) {
    if (value !== null && value !== undefined && typeof value.await === 'function') {
      return value.await();
    }
    return Promise.resolve(value);
  },

  /* -- properties, safe calls and types ----------------------------------- */

  /**
   * A Kotlin val's initialiser, which runs once.
   *
   * A JavaScript getter runs on every read, and 'val client = ...build()' read
   * twice would be two clients — with two cookie jars, if the host ever grows
   * them. This is also what 'by lazy' becomes. Readable as a call and as
   * '.value', because the emitter writes whichever reads better at the site.
   */
  lazy: function (owner, key, initialiser) {
    /*
     * Memoised per instance, under the property's own name.
     *
     * The emitter writes 'get x() { return __k.lazy(this, "x", () => …); }' —
     * three arguments — and this took one, the old delegate contract that
     * answered a reader function. So 'initialiser' bound to the instance, the
     * thunk was discarded, and the getter handed back a FUNCTION where the
     * Kotlin had a value.
     *
     * Silent, and one step removed from where it showed: a source whose
     * 'private val apiHeaders = headers.newBuilder()…build()' is lazy this way
     * passed that function to GET() as its headers, the header pairs came out
     * empty, and every request went out bare with nothing anywhere saying so.
     *
     * A Kotlin val is evaluated once; a JavaScript getter runs on every read,
     * which is the whole reason this helper exists rather than a plain getter.
     */
    var store = owner.__memo;
    if (store === undefined || store === null) {
      store = {};
      Object.defineProperty(owner, '__memo', { value: store, enumerable: false, writable: true });
    }
    if (!(key in store)) store[key] = initialiser();
    return store[key];
  },

  /**
   * A safe call onto a helper: a?.substringAfter("x").
   *
   * JavaScript's own ?. cannot express this, because the helper takes its
   * receiver as the first argument and would be handed the null. Emitting a
   * conditional instead would evaluate the receiver twice, which matters when
   * the receiver is a request.
   */
  sc: function (receiver, fn) {
    if (receiver === null || receiver === undefined) return null;
    var rest = Array.prototype.slice.call(arguments, 2);
    return fn.apply(null, [receiver].concat(rest));
  },

  isType: function (value, type) { return __isType(value, type); },

  /**
   * A call among same-named Kotlin declarations, resolved as it is made.
   *
   * Kotlin picks an overload at compile time by argument count and static
   * type; a JavaScript class has one slot per name. The emitter therefore
   * writes each declaration under 'name$key' and calls this, which picks the
   * way Kotlin would have from what it can see at run time: first the count,
   * then each argument against its parameter's type where this runtime can
   * decide that type (see __TYPES — a type it cannot decide rules nothing
   * out), then the most specific survivor.
   *
   * 'target' is where the candidates are looked up and 'self' what they run
   * on; they differ only for super., which looks on the parent's prototype so
   * that the override making the call does not find itself. A call no
   * translated declaration accepts goes to the driver's base class, which is
   * where Kotlin would have found an API member the extension only declared
   * one half of; and to the receiver's own plain method when the receiver has
   * no translated declarations at all (a runtime object answering a name a
   * class of this extension also uses).
   */
  overload: function (target, self, name, args, table, fallback) {
    var fits = [];
    var declares = false;
    for (var i = 0; i < table.length; i += 1) {
      var entry = table[i];
      if (target === null || target === undefined || typeof target[entry[0]] !== 'function') continue;
      declares = true;
      if (args.length < entry[1]) continue;
      if (entry[2] !== -1 && args.length > entry[2]) continue;
      if (!__overloadAccepts(entry, args)) continue;
      fits.push(entry);
    }
    if (fits.length > 1) fits.sort(function (a, b) { return __overloadRank(b, args) - __overloadRank(a, args); });
    if (fits.length > 0) return target[fits[0][0]].apply(self, args);
    if (!declares && target !== null && target !== undefined && typeof target[name] === 'function') {
      return target[name].apply(self, args);
    }
    var base = null;
    try { base = typeof fallback === 'function' ? fallback() : null; } catch (error) { base = null; }
    if (base !== null && base !== undefined && typeof base[name] === 'function') {
      return base[name].apply(base, args);
    }
    throw new Error(
      'This converted extension called ' + name + ' with arguments none of its declarations takes.'
    );
  },

  /**
   * Kotlin's 'as', which throws, and 'as?', which does not.
   *
   * A type this runtime cannot decide — a data class, which has no runtime
   * existence after translation — passes through rather than failing: the
   * Kotlin compiler already checked that cast, and refusing it here would
   * invent an error the original never had.
   */
  cast: function (value, type) {
    if (!__knownType(type)) return value;
    if (__isType(value, type)) return value;
    throw new Error(
      'This converted extension read a value as a ' + __str(type) + ', and it was not one.'
    );
  },

  castOrNull: function (value, type) {
    if (!__knownType(type)) return value;
    return __isType(value, type) ? value : null;
  },

  /**
   * filterIsInstance<T>(), with the type arriving as text.
   *
   * A name this runtime models filters; a name it does not — a custom filter
   * class, which is most of them — passes everything through. Emptying the list
   * instead would be the same silent wrongness 'cast' avoids: the Kotlin
   * compiler already knew what was in that list, and this runtime does not get
   * to disagree by guessing.
   */
  /**
   * Whether an object carries every member a name lists.
   *
   * The whole of what an emitted 'interface' is: this ecosystem's interfaces
   * declare capability methods and nothing else, and the only question ever
   * asked of one is 'filterIsInstance<UriFilter>()'. A method is checked as a
   * function, because that is what the caller is about to invoke; anything
   * else is checked for presence only, since a property declared on an
   * interface may legitimately hold null.
   */
  /**
   * Kotlin's non-local return, as the one expression that crosses a function.
   *
   * 'jump' THROWS rather than returning, which is what makes it usable in the
   * middle of an expression: 'x ?? __k.jump(3, null)' is a value position, and
   * JavaScript's own 'return' is not. The marker is a private class, so a
   * source that catches Error or a specific type of its own cannot swallow it
   * by accident — and the catch the emitter writes re-throws anything whose id
   * is not the one it is waiting for, so two nested jumps do not collide.
   */
  jump: function (id, value) {
    throw new __Jump(id, value);
  },
  isJump: function (error, id) {
    if (!(error instanceof __Jump)) return false;
    // No id asked for: "is this any jump at all", which is what an emitted
    // 'catch' translated from the source's own 'try' asks before it decides
    // whether the thing it caught was ever an error.
    return id === undefined || error.id === id;
  },
  jumpValue: function (error) {
    return error.value;
  },

  hasMembers: function (value, names) {
    if (value === null || value === undefined) return false;
    if (typeof value !== 'object' && typeof value !== 'function') return false;
    for (var i = 0; i < names.length; i += 1) {
      var member = value[names[i]];
      if (member === undefined) return false;
    }
    return true;
  },

  filterIsInstance: function (list, type) {
    var items = __arr(list);
    if (!__knownType(type)) return items.slice();
    var out = [];
    for (var i = 0; i < items.length; i += 1) if (__isType(items[i], type)) out.push(items[i]);
    return out;
  },

  /**
   * buildString { append(…) }, whose block is handed the accumulator.
   *
   * The accumulator is not a JavaScript string: strings are immutable, so an
   * 'append' on one would build a value the block then threw away. The parts
   * are collected and joined once instead.
   */
  buildString: function (block) {
    var parts = [];
    // Reached as 'this' inside the block, which is how the emitter writes a
    // receiver lambda — see the scope functions above for why .call matters.
    var accumulator = {
      append: function (value) { parts.push(__str(value)); return accumulator; },
      appendLine: function (value) { parts.push(__str(value) + '\\n'); return accumulator; },
      toString: function () { return parts.join(''); },
      isEmpty: function () { return parts.length === 0; }
    };
    return __then(block.call(accumulator, accumulator), function () { return parts.join(''); });
  },

  /* -- collection construction -------------------------------------------- */

  listOf: function () { return Array.prototype.slice.call(arguments); },

  /**
   * ByteArray.toHexString() and Int.toHexString(), lowercase and unpadded per
   * element.
   *
   * Kotlin's ByteArray holds SIGNED bytes, so a byte written as -1 is 0xff
   * here: each is masked back to its unsigned value before it is spelled, which
   * is what Kotlin prints too.
   */
  /**
   * kotlinx.coroutines.delay(ms), which really does wait.
   *
   * A no-op would be the rude answer: this ecosystem calls delay between
   * retries and between pages, and dropping it turns a polite retry loop into
   * a source being hammered as fast as the host will go. The host already caps
   * how long a plugin call may take, so a wait that is too long ends as that
   * cap rather than as a hang.
   *
   * Capped anyway, because the argument comes out of the extension and a
   * mistranslated duration should cost a moment rather than the whole budget.
   */
  delay: function (millis) {
    var wait = Number(millis);
    if (!Number.isFinite(wait) || wait <= 0) return Promise.resolve(null);
    return new Promise(function (resolve) {
      setTimeout(resolve, Math.min(wait, 30000));
    });
  },

  /**
   * Kotlin spells arithmetic as methods as well as operators.
   *
   * released?.toLongOrNull()?.times(1000) is how a timestamp in seconds becomes
   * one in milliseconds through a null-safe chain, where the operator form has
   * nowhere to put the ?. at all.
   */
  times: function (value, other) { return Number(value) * Number(other); },
  divide: function (value, other) { return Number(value) / Number(other); },
  subtract: function (value, other) { return Number(value) - Number(other); },

  toHexString: function (value) {
    if (typeof value === 'number') {
      var single = Math.trunc(value);
      return (single < 0 ? single >>> 0 : single).toString(16);
    }
    var bytes = __arr(value);
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var byte = Math.trunc(Number(bytes[i])) & 0xff;
      out += (byte < 16 ? '0' : '') + byte.toString(16);
    }
    return out;
  },

  /** Kotlin's ByteArray(size), represented as a mutable numeric byte list. */
  byteArray: function (size) {
    var length = Number(size);
    if (!Number.isInteger(length) || length < 0) {
      throw new Error('ByteArray size must be a non-negative integer.');
    }
    var out = [];
    for (var index = 0; index < length; index += 1) out.push(0);
    return out;
  },

  /** A MutableList has add(); a JavaScript array does not answer to that name. */
  mutableListOf: function () {
    return __mutableList(Array.prototype.slice.call(arguments));
  },

  mapOf: function () {
    var out = new Map();
    for (var i = 0; i < arguments.length; i += 1) {
      var pair = arguments[i];
      if (pair === null || pair === undefined) continue;
      if (Array.isArray(pair)) out.set(pair[0], pair[1]);
      else out.set(pair.first, pair.second);
    }
    return __mutableMap(out);
  },

  mutableMapOf: function () { return __k.mapOf.apply(null, arguments); },

  toMutableMap: function (value) {
    if (value instanceof Map) return __mutableMap(new Map(value));
    var out = new Map();
    if (value !== null && value !== undefined) {
      Object.keys(value).forEach(function (key) { out.set(key, value[key]); });
    }
    return __mutableMap(out);
  },

  /** Turn pairs into a map, with later duplicates winning as in Kotlin. */
  toMap: function (value, destination) {
    if (destination === undefined && value !== null && value !== undefined &&
        !(value instanceof Map) && !Array.isArray(value) && typeof value.toMap === 'function') {
      return value.toMap();
    }
    var out = destination === undefined ? __mutableMap(new Map()) : destination;
    if (!(out instanceof Map)) throw new Error('This converted extension passed a non-map destination to toMap.');
    if (value instanceof Map) {
      value.forEach(function (held, key) { out.set(key, held); });
      return out;
    }
    var items = value !== null && value !== undefined && !Array.isArray(value) &&
      typeof value === 'object' && typeof value[Symbol.iterator] !== 'function'
      ? Object.entries(value) : __arr(value);
    for (var i = 0; i < items.length; i += 1) {
      var pair = items[i];
      if (Array.isArray(pair)) out.set(pair[0], pair[1]);
      else if (pair !== null && pair !== undefined && 'first' in pair && 'second' in pair) {
        out.set(pair.first, pair.second);
      } else if (pair !== null && pair !== undefined && 'key' in pair && 'value' in pair) {
        out.set(pair.key, pair.value);
      } else throw new Error('This converted extension passed a non-pair to toMap.');
    }
    return out;
  },

  setOf: function () { return __k.toSet(Array.prototype.slice.call(arguments)); },

  /**
   * add(), over a collection or over a builder.
   *
   * 'list.add(x)' and 'Headers.Builder().add(name, value)' are the same name in
   * Kotlin and the same call site here. A builder returns itself, so the chain
   * that follows keeps working; a collection returns the boolean Kotlin's does.
   */
  add: function (collection, item, value) {
    if (Array.isArray(collection)) { collection.push(item); return true; }
    if (collection instanceof Set) { collection.add(item); return true; }
    if (collection instanceof Map) {
      collection.set(Array.isArray(item) ? item[0] : item.first, Array.isArray(item) ? item[1] : item.second);
      return true;
    }
    if (collection !== null && collection !== undefined && typeof collection.add === 'function') {
      return collection.add(item, value);
    }
    return false;
  },

  addAll: function (collection, items) {
    var incoming = __arr(items);
    for (var i = 0; i < incoming.length; i += 1) __k.add(collection, incoming[i]);
    return incoming.length > 0;
  },

  remove: function (collection, item) {
    // No argument at all is not a collection's remove — Kotlin has none that
    // takes nothing. It is jsoup's Node.remove() / Elements.remove(), and
    // reading it as "remove undefined from this list" answered false and
    // left the page exactly as it was.
    if (arguments.length === 1) {
      if (Array.isArray(collection)) collection = __k.els(collection);
      if (collection !== null && collection !== undefined && typeof collection.remove === 'function') {
        return collection.remove();
      }
      throw new Error('This converted extension called remove() on something that has no remove().');
    }
    if (Array.isArray(collection)) {
      var index = collection.indexOf(item);
      if (index === -1) return false;
      collection.splice(index, 1);
      return true;
    }
    if (collection instanceof Set) return collection.delete(item);
    if (collection instanceof Map) return collection.delete(item);
    if (collection !== null && collection !== undefined && typeof collection.remove === 'function') {
      return collection.remove(item);
    }
    return false;
  },

  size: function (value) {
    if (value === null || value === undefined) return 0;
    if (value instanceof Set || value instanceof Map) return value.size;
    if (typeof value === 'string' || Array.isArray(value)) return value.length;
    if (typeof value.size === 'function') return value.size();
    if (typeof value.length === 'number') return value.length;
    return Object.keys(value).length;
  },

  flatten: function (list) {
    var items = __arr(list);
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var inner = __arr(items[i]);
      for (var j = 0; j < inner.length; j += 1) out.push(inner[j]);
    }
    return out;
  },

  /** Kotlin passes the index FIRST, which is the opposite of Array.map. */
  mapIndexed: function (list, fn) {
    return __each(__arr(list), function (item, index) { return fn(index, item); });
  },

  /**
   * Kotlin's indexing, which is one syntax over four different reads.
   *
   * A Map is why this exists. The runtime models one as a real Map, and
   * table['key'] in JavaScript reads a PROPERTY OF THE MAP OBJECT — which is
   * undefined for every key any extension ever asks for. Emitted as plain
   * indexing, mapOf(...)['1080p'] answered nothing, silently, and a quality
   * table, a language table or a header table came back empty with nothing
   * anywhere to report it.
   *
   * A List and a String index the way Kotlin does, including throwing out of
   * bounds: Kotlin's List.get throws IndexOutOfBoundsException, and an
   * undefined returned in its place travels a long way before it fails.
   * Anything else — a JsonObject, a DTO, an okhttp Headers — is a plain object
   * and is read as one.
   */
  /**
   * x.get(k) — Kotlin's indexing, spelled long.
   *
   * A Kotlin List, Map and CharSequence all answer get(i), and this ecosystem
   * writes matchResult?.groupValues?.get(1) as readily as groupValues[1]. A
   * JavaScript array has no get at all, so it converted clean and died with
   * "__k.sc(...)?.get is not a function" on the first episode list.
   *
   * A receiver that has a real get of its own keeps it — okhttp's Headers and
   * the preference shims are methods, not tables — and everything else falls
   * through to the indexing rules, where a Map answers null for a missing key
   * the way Kotlin does.
   */
  /**
   * Java's String.format and Kotlin's "%.1f".format(x), which are one formatter
   * reached two ways — plus every receiver that already has a format of its
   * own.
   *
   * SimpleDateFormat and DecimalFormat are shims here with a real format
   * method, and they keep it: only a string receiver, or the String
   * constructor standing in for the static call, reaches the formatter. An
   * optional Locale first argument is accepted and ignored, because every use
   * in this ecosystem passes Locale.US to get the invariant behaviour that is
   * already the only behaviour here.
   */
  format: function (receiver) {
    var rest = Array.prototype.slice.call(arguments, 1);
    if (receiver !== null && receiver !== undefined && typeof receiver.format === 'function') {
      return receiver.format.apply(receiver, rest);
    }
    var pattern = typeof receiver === 'string' ? receiver : rest.shift();
    // String.format(Locale.US, "%.0f", value): the locale is an object, the
    // pattern never is.
    if (pattern !== null && typeof pattern === 'object') pattern = rest.shift();
    if (typeof pattern !== 'string') {
      __k.unsupported('a format with no pattern');
    }
    var at = 0;
    return pattern.replace(
      /%(%|(?:(0)?(\\d+))?(?:\\.(\\d+))?([sdfxXc]))/g,
      function (whole, kind, zero, width, precision, verb) {
        if (kind === '%') return '%';
        var value = rest[at];
        at += 1;
        var out;
        if (verb === 's') out = value === null || value === undefined ? 'null' : String(value);
        // '%c', a Char: YouTube's size formatter writes "%.0f%cb" with the unit
        // letter. Left out, the pattern kept "%c" in the answer, literally.
        else if (verb === 'c') out = typeof value === 'number' ? String.fromCharCode(value) : __str(value);
        else if (verb === 'd') out = String(Math.trunc(Number(value)) || 0);
        else if (verb === 'f') out = Number(value).toFixed(precision === undefined ? 6 : Number(precision));
        else {
          out = (Math.trunc(Number(value)) >>> 0).toString(16);
          if (verb === 'X') out = out.toUpperCase();
        }
        if (width !== undefined) {
          var pad = Number(width) - out.length;
          if (pad > 0) out = new Array(pad + 1).join(zero === '0' ? '0' : ' ') + out;
        }
        return out;
      }
    );
  },

  getAt: function (value, key) {
    if (
      value !== null && value !== undefined &&
      !(value instanceof Map) && !Array.isArray(value) && typeof value !== 'string' &&
      typeof value.get === 'function'
    ) {
      return value.get(key);
    }
    return __k.index(value, key);
  },

  index: function (value, key) {
    if (value === null || value === undefined) {
      throw new Error('This converted extension indexed into a value that was null.');
    }
    if (value instanceof Map) return value.has(key) ? value.get(key) : null;
    if (typeof value === 'string' || Array.isArray(value)) {
      var at = Number(key);
      if (!Number.isFinite(at) || at < 0 || at >= value.length) {
        throw new Error(
          'This converted extension read index ' + String(key) + ' of a ' +
          (typeof value === 'string' ? 'string' : 'list') + ' of length ' + value.length + '.'
        );
      }
      return value[at];
    }
    // Kotlin's a[k] is a.get(k) on any type that declares operator get, and
    // this runtime's own objects declare it where their Kotlin namesakes do:
    // Calendar.getInstance()[Calendar.YEAR] is Calendar.get, and reading it as
    // a property answered undefined, so a comic source listing one entry per
    // year from the current one down to 2012 listed nothing at all. A
    // translated class with an operator get emits a get method, which is the
    // same rule.
    if (typeof value.get === 'function') return value.get(key);
    return value[key];
  },

  /**
   * 'synchronized(lock) { … }', which is a lock in a runtime with one thread.
   *
   * The block runs, the lock is ignored, and that is exact rather than a
   * weakening: a plugin is a single-threaded module (ABI.md section 1), so
   * nothing else can be inside the block while this is, and Kotlin does not
   * allow a suspend call in one — so there is no await for the event loop to
   * interleave at either. The lock was already evaluated by the caller.
   */
  synchronized: function (lock, block) { return block(); },

  /** kotlinx.coroutines Mutex.withLock: serialize the block on one worker. */
  withLock: function (lock, block) {
    return __then(block.call(lock, lock), function (value) { return value; });
  },

  /** Kotlin's bounds-checking List.elementAt, including strings and iterables. */
  elementAt: function (value, index) {
    var items = typeof value === 'string' ? value : __arr(value);
    var at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= items.length) {
      throw new Error('This converted extension read an element outside its collection.');
    }
    return items[at];
  },

  /** A small Kotlin-style iterator for code that uses hasNext()/next(). */
  iterator: function (value) {
    var items = typeof value === 'string' ? value.split('') : __arr(value);
    var at = 0;
    return {
      hasNext: function () { return at < items.length; },
      next: function () {
        if (at >= items.length) throw new Error('This converted extension exhausted an iterator.');
        return items[at++];
      }
    };
  },

  /** The write half: map[key] = value, and the same Map problem. */
  setIndex: function (value, key, next) {
    if (value === null || value === undefined) {
      throw new Error('This converted extension assigned into a value that was null.');
    }
    if (value instanceof Map) value.set(key, next);
    // The mirror of index: a[k] = v is a.set(k, v) on a type declaring operator
    // set — Headers.Builder, a Calendar, a translated class.
    else if (!Array.isArray(value) && typeof value.set === 'function') value.set(key, next);
    else value[key] = next;
    return next;
  },

  /**
   * The three getOr* names, which are a collection lookup AND a Result read.
   *
   * 'runCatching { … }.getOrDefault(x)' passes ONE argument, so a helper
   * written only for '(collection, key, fallback)' reads that argument as an
   * index into the Result object, misses, and answers the fallback — for a
   * SUCCESS. That is a wrong value on the happy path, which is the worst place
   * for one, so the Result is recognised before the lookup is attempted.
   */
  getOrNull: function (collection, key) {
    if (__isResult(collection)) return collection.getOrNull();
    if (collection === null || collection === undefined) return null;
    if (collection instanceof Map) {
      return collection.has(key) ? collection.get(key) : null;
    }
    if (typeof collection === 'string' || Array.isArray(collection)) {
      var index = Number(key);
      if (!Number.isFinite(index) || index < 0 || index >= collection.length) return null;
      return collection[index];
    }
    var value = collection[key];
    return value === undefined ? null : value;
  },

  getOrDefault: function (collection, key, fallback) {
    // On a Result the single argument IS the default, not a key.
    if (__isResult(collection)) return collection.isSuccess ? collection.__value : key;
    var value = __k.getOrNull(collection, key);
    return value === null ? fallback : value;
  },

  getOrElse: function (collection, key, fallback) {
    if (__isResult(collection)) {
      if (collection.isSuccess) return collection.__value;
      return typeof key === 'function' ? key(collection.__error) : key;
    }
    var value = __k.getOrNull(collection, key);
    if (value !== null) return value;
    return typeof fallback === 'function' ? fallback(key) : fallback;
  },

  /** Kotlin's infix 'to', readable positionally and by name. */
  to: function (first, second) {
    var pair = [first, second];
    pair.first = first;
    pair.second = second;
    return pair;
  },

  /* -- ranges -------------------------------------------------------------- */

  /**
   * '1..n', which is inclusive, and empty when the end is below the start.
   *
   * Kotlin's '..' also builds a CharRange, and this ecosystem uses one to make
   * an alphabet out of three of them. Reading those endpoints as numbers gives
   * NaN, an empty range, and an alphabet with nothing in it — which surfaces
   * three calls later as a random pick from an empty collection, naming neither
   * the range nor the characters.
   */
  range: function (from, to) {
    if (__isChar(from) && __isChar(to)) return __charRange(from, to, 1);
    var out = [];
    for (var i = Number(from); i <= Number(to); i += 1) out.push(i);
    return out;
  },

  /** '0 until n', which is not. */
  until: function (from, to) {
    if (__isChar(from) && __isChar(to)) return __charRange(from, to, 0);
    var out = [];
    for (var i = Number(from); i < Number(to); i += 1) out.push(i);
    return out;
  },

  /** 'n downTo 0', inclusive and descending. */
  downTo: function (from, to) {
    if (__isChar(from) && __isChar(to)) return __charRange(from, to, -1);
    var out = [];
    for (var i = Number(from); i >= Number(to); i -= 1) out.push(i);
    return out;
  },

  /**
   * 'progression step n' — every n-th element, starting with the first.
   *
   * The three builders above answer the whole progression as an array whose
   * neighbours differ by exactly one, so every n-th element of it is exactly
   * the progression Kotlin's step builds: '0 until 7 step 2' is 0, 2, 4, 6 and
   * '10 downTo 1 step 3' is 10, 7, 4, 1. Kotlin throws for a step that is not
   * positive rather than looping forever or answering nothing, and so does
   * this.
   */
  step: function (progression, n) {
    var by = Number(n);
    if (!(by > 0)) throw new Error('Step must be positive, was: ' + n + '.');
    var all = __arr(progression);
    var out = [];
    for (var i = 0; i < all.length; i += by) out.push(all[i]);
    return out;
  },

  /**
   * The infix 'matches': 'REGEX matches text', or 'text matches REGEX'.
   *
   * Kotlin declares it on Regex and on CharSequence, and both are the
   * whole-input test. Which side is the pattern is only knowable at run time
   * here, and a Regex is always one of this runtime's own, so that is what is
   * asked. Neither side a Regex is not something Kotlin can compile.
   */
  regexMatches: function (left, right) {
    if (left instanceof __KRegex) return left.matches(right);
    if (right instanceof __KRegex) return right.matches(left);
    throw new Error('This converted extension used matches without a Regex on either side.');
  },

  /**
   * Kotlin's error(), which is a throw and not a log.
   *
   * It reaches the host as an ordinary plugin failure, which is what the
   * extension meant: the shape it expected is gone.
   */
  error: function (message) {
    throw new Error(__str(message).length > 0 ? __str(message) : 'This converted extension failed.');
  },

  /**
   * 'Exception(message)', 'IOException(message, cause)' and their kin built as
   * a VALUE — 'Observable.error(Exception("Licensed"))' — rather than thrown
   * where they stand, which is 'error' above. The error is made, not thrown;
   * whoever it is handed to decides. A cause is kept as the standard one.
   */
  exception: function (message, cause) {
    var text = message === undefined || message === null ? '' : __str(message);
    var made = new Error(text.length > 0 ? text : 'This converted extension failed.');
    if (cause !== undefined && cause !== null) made.cause = cause;
    return made;
  },

  /**
   * The safe answer to the common packed-script helper. The decoder itself is
   * in the generated generic runtime and never evaluates the returned text.
   * An unpacker that needs custom alphabet or delimiters is intentionally
   * rejected rather than guessed at.
   */
  unpack: function (source) {
    var unpacked = __rt.unpackDeanEdwards(__str(source));
    return unpacked === null ? '' : unpacked;
  },

  /* -- regex -------------------------------------------------------------- */

  /**
   * A Regex, translated lazily.
   *
   * The optional third argument names the Kotlin member or property the
   * pattern was declared as. It is only ever read when the pattern turns out
   * to be one the engine subset forbids, and it is what turns a refusal that
   * quotes escaped pattern text into one naming a symbol the maintainer can
   * find in the extension's own source. Absent, the refusal still names the
   * pattern, which is what it did before.
   */
  regex: function (pattern, options, declaredAt) {
    if (pattern && pattern.__isRegex === true) return pattern;
    return new __KRegex(pattern, options, declaredAt);
  },

  /** Kotlin reads an unmatched group as '', never as undefined. */
  groupValues: function (match) {
    if (!__present(match)) return [];
    if (Array.isArray(match.groupValues)) return match.groupValues;
    var out = [];
    for (var i = 0; i < match.length; i += 1) out.push(match[i] === undefined ? '' : match[i]);
    return out;
  },

  /**
   * Positional components, of whatever Kotlin was destructuring.
   *
   * 'val (a, b) = ...' is one syntax over four things: a MatchResult's
   * destructured groups, a Pair, a data class's declared properties, and a
   * list. The emitter writes the same helper for all of them because it cannot
   * tell which it has, so the shape decides here.
   */
  /**
   * componentN() written out — 'match.destructured.component1()' — which is
   * the Nth of what destructuring the same value would bind (see
   * 'destructured' below), or the value's own componentN where it has one.
   */
  component1: function (value) { return __component(value, 1); },
  component2: function (value) { return __component(value, 2); },
  component3: function (value) { return __component(value, 3); },
  component4: function (value) { return __component(value, 4); },
  component5: function (value) { return __component(value, 5); },

  destructured: function (value) {
    if (!__present(value)) return [];
    if (Array.isArray(value.groupValues)) return value.groupValues.slice(1);
    if (Array.isArray(value)) {
      // A raw exec array is a match, not a list: it carries the input it
      // matched against, and its first element is the whole match.
      if (typeof value.index === 'number' && typeof value.input === 'string') {
        return __k.groupValues(value).slice(1);
      }
      return value.slice();
    }
    if (value instanceof Map) return Array.from(value.values());
    if (value.first !== undefined || value.second !== undefined) return [value.first, value.second];
    if (typeof value === 'object') {
      var out = [];
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (typeof value[key] === 'function') continue;
        out.push(value[key]);
      }
      return out;
    }
    return [value];
  },

  /* -- the shapes this ecosystem adds to the stdlib ----------------------- */

  /**
   * orEmpty(), which cannot know whether a String or a List was wanted.
   *
   * The emitter has no types, so one value has to serve as both. '' is that
   * value: '__arr' reads it as an empty list, every string helper reads it as
   * an empty string, and concatenating it changes nothing. An empty array would
   * read as 'the string "[object Array]"' somewhere eventually, which is the
   * failure that would be found late and far away.
   */
  orEmpty: function (value) {
    return __present(value) ? value : '';
  },

  /**
   * map/flatMap that SKIPS an element whose lambda threw.
   *
   * This is what 'parallelCatchingFlatMapBlocking' means in this ecosystem, and
   * the skipping is the entire point: an episode page lists several mirrors,
   * one of them is dead, and losing that mirror must not lose the page.
   * Collapsing these onto plain map/flatMap would turn a partial result into no
   * result — which reads to a viewer as a source that is down.
   *
   * The concurrency is dropped: the sandbox has one thread, and requests are
   * made through one host anyway.
   */
  /**
   * What an okhttp interceptor's recovery path becomes when it needs a
   * boundary this runtime does not cross.
   *
   * The emitter keeps an interceptor's pass-through - send the request, look at
   * the answer, hand it back unless it is a challenge - and cuts the part after
   * that guard when what refused it was the WebView or its cookie store. This is
   * what runs in its place: the answer the Kotlin would have recovered from
   * becomes an error naming the interceptor and what it reached for, at the
   * point the recovery would have begun. Not an empty answer, and not the
   * challenge page handed on as if it were the content.
   */
  recoveryRefused: function (owner, kinds) {
    var needed = __arr(kinds).map(function (one) { return __str(one); }).join(', ');
    return new Error(
      'This converted extension\\'s ' + __str(owner) + ' got an answer it would only get past ' +
      'through ' + needed + ', which Yorozo does not give a plugin. Answers it passes ' +
      'through unchanged still work; this one cannot be recovered here.'
    );
  },

  catchingMap: function (list, fn) {
    return __then(__catching(__arr(list), fn), function (values) {
      var out = [];
      for (var i = 0; i < values.length; i += 1) {
        if (values[i] !== __SKIPPED && __present(values[i])) out.push(values[i]);
      }
      return out;
    });
  },

  catchingFlatMap: function (list, fn) {
    return __then(__catching(__arr(list), fn), function (values) {
      var out = [];
      for (var i = 0; i < values.length; i += 1) {
        if (values[i] === __SKIPPED || !__present(values[i])) continue;
        var inner = __arr(values[i]);
        for (var j = 0; j < inner.length; j += 1) out.push(inner[j]);
      }
      return out;
    });
  },

  /* -- characters --------------------------------------------------------- */

  /**
   * Char.isDigit(), which is EVERY Unicode decimal digit and not '0'..'9'.
   *
   * An ASCII-only test answers false for a character Kotlin calls a digit, so a
   * title stripped of digits would keep some of them — a wrong value rather
   * than an error. The classes are built at load with an ASCII fallback, so an
   * engine without \\p{...} narrows this one predicate instead of failing to
   * parse the whole bundle.
   */
  isDigit: function (value) { return __IS_DIGIT.test(__char(value)); },
  isLetter: function (value) { return __IS_LETTER.test(__char(value)); },
  isLetterOrDigit: function (value) { return __IS_LETTER_OR_DIGIT.test(__char(value)); },

  /** Kotlin counts every Unicode space separator, which is what \\s is here. */
  isWhitespace: function (value) {
    var ch = __char(value);
    return ch !== '' && /\\s/.test(ch);
  },

  /** Kotlin THROWS for a non-digit where Number('x') is a silent NaN. */
  digitToInt: function (value) {
    var ch = __char(value);
    if (!__IS_DIGIT.test(ch)) {
      throw new Error('This converted extension read "' + ch + '" as a digit, and it is not one.');
    }
    var parsed = Number(ch);
    if (Number.isFinite(parsed)) return parsed;
    // A Unicode digit outside ASCII: Number() cannot read it, but every Nd
    // block runs zero-to-nine in order, so its value is its offset in it.
    var code = ch.codePointAt(0);
    for (var back = 0; back < 10; back += 1) {
      if (!__IS_DIGIT.test(String.fromCodePoint(code - back - 1))) return back;
    }
    return 0;
  },

  /** Nullable counterpart of digitToInt; Kotlin returns null instead of throwing. */
  digitToIntOrNull: function (value) {
    var ch = __char(value);
    if (!__IS_DIGIT.test(ch)) return null;
    return __k.digitToInt(ch);
  },

  /**
   * Char.titlecase(), which uppercases and answers a String.
   *
   * Reached almost always as 'replaceFirstChar { it.titlecase() }', where the
   * receiver is a single character. Handed more than one it uppercases the
   * first and leaves the rest: Kotlin has no String.titlecase to imitate, and
   * uppercasing the whole word would shout a title that should not.
   */
  titlecase: function (value) {
    var text = __str(value);
    if (text.length <= 1) return text.toUpperCase();
    return text.charAt(0).toUpperCase() + text.slice(1);
  },

  /**
   * replaceFirstChar { … }, which is how this ecosystem capitalises a title.
   *
   * The lambda is handed the first character alone and its result replaces it,
   * so a lambda answering more than one character lengthens the string — which
   * is what Kotlin does too. An empty receiver comes back untouched rather than
   * calling the lambda with '', which would capitalise nothing and could still
   * produce text.
   */
  replaceFirstChar: function (value, transform) {
    var text = __str(value);
    if (text.length === 0) return text;
    var head = typeof transform === 'function' ? transform(text.charAt(0)) : __str(transform);
    return __then(head, function (replacement) { return __str(replacement) + text.slice(1); });
  },

  /* -- more strings ------------------------------------------------------- */

  /**
   * Kotlin's String(bytes) — a DECODE, and not JavaScript's String().
   *
   * 'String(Base64.decode(x))' is the commonest line in this ecosystem's
   * obfuscation handling, and JavaScript's String() on a byte array yields
   * '104,101,108,108,111'. That is the worst substitution available here: it
   * produces a string, so nothing downstream errors, and the value is nonsense.
   * Handed a CharArray — an array of one-character strings, which is how this
   * runtime models one — it joins rather than decodes.
   */
  stringOf: function (value, charset) {
    var kind = __charsetOf(charset);
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      var chars = true;
      for (var i = 0; i < value.length; i += 1) if (typeof value[i] !== 'string') chars = false;
      if (chars) return value.join('');
    }
    if (kind !== 'utf8') return __singleByteDecode(__bytesOf(value), kind);
    return __host().text.decode(__bytesOf(value));
  },

  /**
   * toByteArray(), which is UTF-8 and nothing else here.
   *
   * The charset argument is checked rather than ignored: encoding as UTF-8
   * where the Kotlin asked for ISO-8859-1 differs silently for every character
   * above 0x7f, and the failure would be a signature that does not verify.
   *
   * java.math.BigInteger spells its own, unrelated method the same way, and an
   * affine coordinate is the one BigInteger this runtime hands out. Without the
   * branch it fell through to the string case and encoded the number's DECIMAL
   * DIGITS as UTF-8 — 77 plausible bytes where 32 were wanted, which is a JWK
   * for a public key nobody holds.
   */
  toByteArray: function (value, charset) {
    if (value !== null && typeof value === 'object' && value.__bigInteger === true) {
      return value.toByteArray();
    }
    var kind = __charsetOf(charset);
    if (value === null || value === undefined) return __host().text.encode('');
    if (typeof value === 'string') {
      return kind === 'utf8' ? __host().text.encode(value) : __singleByteEncode(value, kind);
    }
    return __bytesOf(value);
  },

  /**
   * ByteArray.decodeToString(), which is stringOf() under Kotlin's other name.
   *
   * The optional range is a real range and not a hint: 'bytes.decodeToString(0,
   * 7) == "#EXTM3U"' is how a playlist is told from a video, and decoding the
   * whole array there answers false for every playlist.
   */
  decodeToString: function (value, start, end) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
      return start === undefined && end === undefined ? value : value.slice(start, end);
    }
    var bytes = __bytesOf(value);
    if (start !== undefined || end !== undefined) {
      bytes = bytes.slice(start === undefined ? 0 : start, end === undefined ? bytes.length : end);
    }
    return __host().text.decode(bytes);
  },

  /** Primitive array conversions are representation-preserving in the sandbox. */
  toIntArray: function (value) { return __arr(value); },

  /** JSON stringification used by small request/signature helpers. */
  /**
   * keiyoushi's 'T.toJsonString()', whose Json is the injected one. Encoded
   * the way kotlinx encodes wherever the value reaches a '@Serializable'
   * class this bundle registered — see '__serialEncode' — and stringified as
   * it stands everywhere else, which is what it always was.
   */
  toJsonString: function (value) {
    return JSON.stringify(__serialEncode(value, __JSON_INJECTED, 'value', 0, false));
  },

  /** Encode one query component without turning spaces into form plus signs. */
  asQueryPart: function (value) { return encodeURIComponent(__str(value)); },

  /** Kotlin's trimMargin with its default margin marker. */
  trimMargin: function (value, margin) {
    var marker = margin === undefined ? '|' : __str(margin);
    return __str(value).split('\\n').map(function (line) {
      var match = /^\\s*/.exec(line);
      var start = match === null ? 0 : match[0].length;
      return line.slice(start).indexOf(marker) === 0 ? line.slice(start + marker.length) : line;
    }).join('\\n');
  },

  /**
   * encodeToString, which three different Kotlin APIs spell the same way.
   *
   * With one argument it is the byte-array extension this helper was written
   * for: Base64 text, unwrapped. With a receiver AND a value it is a coder
   * being asked to encode something - kotlinx's 'json.encodeToString(value)',
   * or java.util's 'Base64.getEncoder().encodeToString(bytes)' - and the coder
   * does the work. Treated as the first, both encoded the CODER: AniList's
   * GraphQL variables went out as the Base64 of the Json object, and the
   * source answered every search with an error.
   */
  encodeToString: function (value, other) {
    if (arguments.length >= 2 && value !== null && value !== undefined &&
        typeof value.encodeToString === 'function') {
      return value.encodeToString.apply(value, Array.prototype.slice.call(arguments, 1));
    }
    return Base64.encodeToString(value, Base64.NO_WRAP);
  },

  /** A CharArray, which this runtime models as an array of one-char strings. */
  toCharArray: function (value) { return __str(value).split(''); },

  /**
   * ByteArray.contentEquals(), which JavaScript's === cannot answer.
   *
   * Two arrays holding the same bytes are different objects, so '===' says
   * 'different' where Kotlin says 'equal' — and the branch it guards is
   * usually 'is this the payload I expected'.
   */
  contentEquals: function (a, b) {
    if (!__present(a) || !__present(b)) return !__present(a) && !__present(b);
    var left = typeof a === 'string' ? a.split('') : __bytesOf(a);
    var right = typeof b === 'string' ? b.split('') : __bytesOf(b);
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
    return true;
  },

  /**
   * equals(other), and equals(other, ignoreCase).
   *
   * Kotlin's '==' is structural, so two equal lists are equal; JavaScript's
   * '===' compares identity and would answer 'not equal' for values Kotlin
   * calls equal. The ignoreCase overload is the one this ecosystem writes, and
   * it is always against a header name.
   */
  equalsTo: function (value, other, ignoreCase) {
    if (ignoreCase === true) return __str(value).toLowerCase() === __str(other).toLowerCase();
    return __equal(value, other);
  },

  /** compareTo, which answers the SIGN Kotlin's does, over numbers or text. */
  compareTo: function (value, other) { return __cmp(value, other); },

  /**
   * replaceFirst, which replaces ONE occurrence where 'replace' replaces all.
   *
   * Written over indexOf rather than over String.replace because JavaScript
   * gives '$&', '$1' and '$$' meaning inside the replacement string — so a
   * literal replacement containing a dollar sign would be rewritten into
   * something else. A Regex receiver keeps the group references, because there
   * the extension meant them.
   */
  replaceFirst: function (value, target, replacement) {
    // 'regex.replaceFirst(text, x)' and '"…".replaceFirst(regex, x)' are the
    // same call site after translation, so the receiver decides which is which.
    if (value && value.__isRegex === true) return value.replaceFirst(target, replacement);
    var text = __str(value);
    if (target && target.__isRegex === true) return target.replaceFirst(text, replacement);
    if (target instanceof RegExp) {
      return text.replace(new RegExp(target.source, __regexFlags(target.flags, '')), replacement);
    }
    var needle = __str(target);
    var at = text.indexOf(needle);
    if (at === -1) return text;
    return text.slice(0, at) + __str(replacement) + text.slice(at + needle.length);
  },

  /** Kotlin throws for a negative count, and so does JavaScript — identically. */
  repeat: function (value, count) {
    var times = Number(count);
    if (!Number.isFinite(times) || times < 0) {
      throw new Error('This converted extension repeated a string ' + __str(count) + ' times.');
    }
    var text = __str(value);
    var out = '';
    for (var i = 0; i < Math.trunc(times); i += 1) out += text;
    return out;
  },

  /**
   * lines(), which splits on all three line endings.
   *
   * Splitting on '\\n' alone leaves a '\\r' on every line of a CRLF document,
   * and a scraper comparing a line to a literal then never matches — a wrong
   * branch with nothing on screen to say why.
   */
  lines: function (value) { return __str(value).split(/\\r\\n|\\n|\\r/); },

  /* -- more numbers -------------------------------------------------------- */

  /** Kotlin rounds .5 AWAY from zero; Math.round rounds -0.5 up to -0. */
  roundToInt: function (value) {
    var number = Number(value);
    if (!Number.isFinite(number)) {
      throw new Error('This converted extension rounded a value that is not a number.');
    }
    return number < 0 ? -Math.round(-number) : Math.round(number);
  },

  coerceAtLeast: function (value, minimum) {
    return __cmp(value, minimum) < 0 ? minimum : value;
  },

  coerceAtMost: function (value, maximum) {
    return __cmp(value, maximum) > 0 ? maximum : value;
  },

  /** Kotlin throws for an empty range rather than silently inverting it. */
  coerceIn: function (value, minimum, maximum) {
    if (__cmp(minimum, maximum) > 0) {
      throw new Error('This converted extension clamped a value into an empty range.');
    }
    if (__cmp(value, minimum) < 0) return minimum;
    return __cmp(value, maximum) > 0 ? maximum : value;
  },

  /**
   * minus(), which is subtraction for a number and removal for a collection.
   *
   * 'a.minus(b)' on two Ints is 'a - b'; 'list.minus(other)' removes every
   * element of 'other', and 'list.minus(x)' removes the first match of one. The
   * emitter has no types, so the receiver decides — reading a list subtraction
   * as arithmetic would answer NaN.
   */
  minus: function (value, other, unit) {
    if (typeof value === 'number') return value - Number(other);
    // And the same for a date: 'ZonedDateTime.now(zone).minus(n, unit)'.
    if (value !== null && value !== undefined && value.__kTime === true) return value.minus(other, unit);
    // Kotlin has no String minus, so a string on the left is a Char: 'c - 'A''
    // is the distance between two, and 'c - 1' is the Char one before. As
    // JavaScript's '-' both were NaN.
    if (typeof value === 'string') {
      var code = value.charCodeAt(0);
      if (typeof other === 'string') return code - other.charCodeAt(0);
      return String.fromCharCode(code - Number(other));
    }
    if (value instanceof Map) {
      var without = new Map(value);
      var keys = __isCollection(other) ? __arr(other) : [other];
      for (var k = 0; k < keys.length; k += 1) without.delete(keys[k]);
      return without;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        !(value instanceof Set) && typeof value.minus === 'function') {
      return value.minus(other);
    }
    if (value instanceof Set) {
      var removing = other instanceof Set || Array.isArray(other) ? __arr(other) : [other];
      var kept = new Set(value);
      for (var i = 0; i < removing.length; i += 1) kept.delete(removing[i]);
      return __k.toSet(Array.from(kept));
    }
    var items = __arr(value).slice();
    if (Array.isArray(other) || other instanceof Set) {
      var dropping = __arr(other);
      var out = [];
      for (var j = 0; j < items.length; j += 1) {
        var found = false;
        for (var d = 0; d < dropping.length; d += 1) if (__equal(items[j], dropping[d])) found = true;
        if (!found) out.push(items[j]);
      }
      return out;
    }
    // A single element removes only its FIRST occurrence, which is Kotlin's.
    for (var m = 0; m < items.length; m += 1) {
      if (__equal(items[m], other)) { items.splice(m, 1); break; }
    }
    return items;
  },

  /**
   * not(), which is a Boolean in Kotlin and a filter in jsoup.
   *
   * '.not()' with no argument negates; '.not("[data-toggle]")' on a selection
   * is jsoup's Elements.not, which DROPS the matching elements. Passing the
   * selection through unchanged would silently keep the very elements the
   * scraper asked to exclude.
   */
  not: function (value, selector) {
    if (selector === undefined || selector === null) return !value;
    var items = __k.els(value).toArray();
    var out = [];
    for (var i = 0; i < items.length; i += 1) {
      var element = items[i];
      if (typeof element.closest !== 'function' || element.closest(selector) !== element) out.push(element);
    }
    return __k.els(out);
  },

  /* -- more collections ---------------------------------------------------- */

  /** Keeps the FIRST element for each key, which is the one Kotlin keeps. */
  distinctBy: function (list, selector) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return selector(item); }), function (keys) {
      var seen = new Set();
      var out = [];
      for (var i = 0; i < items.length; i += 1) {
        if (seen.has(keys[i])) continue;
        seen.add(keys[i]);
        out.push(items[i]);
      }
      return out;
    });
  },

  /**
   * sortedWith(comparator), stable because Kotlin's is.
   *
   * A reordered episode list is visible to a viewer, and two videos of equal
   * quality swapping places between runs reads as the source having changed.
   * The comparator is synchronous by construction: Kotlin's Comparator.compare
   * is not a suspend function, so nothing inside one can have suspended.
   */
  sortedWith: function (list, comparator) {
    var items = __arr(list).slice();
    var order = [];
    for (var i = 0; i < items.length; i += 1) order.push(i);
    order.sort(function (a, b) {
      var delta = comparator(items[a], items[b]);
      return delta !== 0 ? delta : a - b;
    });
    var out = [];
    for (var j = 0; j < order.length; j += 1) out.push(items[order[j]]);
    return out;
  },

  /** Natural order, over the same __cmp every other sort here uses. */
  sorted: function (list) {
    if (typeof list === 'string') return list.split('').sort(__cmp).join('');
    return __arr(list).slice().sort(__cmp);
  },

  sortedDescending: function (list) { return __k.reversed(__k.sorted(list)); },

  /**
   * compareBy / compareByDescending, which take one selector or several.
   *
   * Several are tried in order and the first difference decides; dropping the
   * later ones would sort by the first key alone and look almost right. A
   * selector that is itself a comparator is used as one, which is what
   * 'compareBy(comparator, { … })' means.
   */
  compareBy: function () { return __byKeys(Array.prototype.slice.call(arguments), 1); },

  /**
   * 'Comparator<T> { a, b -> … }' — the SAM constructor, whose lambda is the
   * compare function itself. Kotlin's is synchronous (Comparator.compare is
   * not a suspend function), so an answer that is a Promise is refused where
   * it happens rather than read as a non-zero number, which would sort by
   * nothing and look almost right.
   */
  comparatorOf: function (compare) {
    if (typeof compare !== 'function') {
      throw new Error('This converted extension built a Comparator from something that is not a function.');
    }
    return __comparator(function (a, b) {
      var delta = compare(a, b);
      if (__thenable(delta)) {
        throw new Error('This converted extension compared with a function that suspends, which Kotlin cannot do either.');
      }
      return Number(delta);
    });
  },
  compareByDescending: function () { return __byKeys(Array.prototype.slice.call(arguments), -1); },

  thenBy: function (comparator, selector) {
    return __comparator(function (a, b) {
      var first = comparator(a, b);
      return first !== 0 ? first : __cmp(selector(a), selector(b));
    });
  },

  thenByDescending: function (comparator, selector) {
    return __comparator(function (a, b) {
      var first = comparator(a, b);
      return first !== 0 ? first : -__cmp(selector(a), selector(b));
    });
  },

  /**
   * asSequence(), which this runtime makes eager.
   *
   * A Sequence is lazy in Kotlin and an array is not, so a chain over one
   * evaluates every stage for every element here rather than one element at a
   * time. The results agree; the only observable difference is the order side
   * effects happen in, and a scraper's transforms do not have any. What a
   * Sequence must NOT become is a one-element list holding itself, which is
   * what a passthrough would leave behind.
   */
  asSequence: function (list) { return __arr(list); },

  /** asReversed() is a live view in Kotlin; nothing here mutates the source. */
  asReversed: function (list) { return __arr(list).slice().reverse(); },

  /** Kotlin passes the INDEX first, which is the opposite of Array.forEach. */
  forEachIndexed: function (list, fn) {
    return __then(
      __each(__arr(list), function (item, index) { return fn(index, item); }),
      function () { return undefined; }
    );
  },

  mapIndexedNotNull: function (list, fn) {
    return __then(
      __each(__arr(list), function (item, index) { return fn(index, item); }),
      function (values) {
        var out = [];
        for (var i = 0; i < values.length; i += 1) if (__present(values[i])) out.push(values[i]);
        return out;
      }
    );
  },

  filterIndexed: function (list, predicate) {
    var items = __arr(list);
    return __then(
      __each(items, function (item, index) { return predicate(index, item); }),
      function (flags) {
        var out = [];
        for (var i = 0; i < items.length; i += 1) if (flags[i]) out.push(items[i]);
        return out;
      }
    );
  },

  /**
   * firstNotNullOfOrNull, which is not 'map, then first'.
   *
   * It stops at the first lambda that answers something, so the ones after it
   * never run — which matters when each is a date parse that throws or a
   * request that costs a round trip. Answering null for 'nothing matched'
   * rather than throwing is the OrNull half of the name.
   */
  firstNotNullOfOrNull: function (list, fn) {
    return __firstPresent(__arr(list), function (item) { return fn(item); });
  },

  /** Runs the lambda for its effect and answers the RECEIVER, not the results. */
  onEach: function (list, fn) {
    return __then(__each(__arr(list), function (item) { return fn(item); }), function () { return list; });
  },

  indexOfLast: function (list, predicate) {
    var items = __arr(list);
    var reversed = items.slice().reverse();
    return __then(__firstIndex(reversed, predicate), function (index) {
      return index === -1 ? -1 : items.length - 1 - index;
    });
  },

  /**
   * single(), which throws unless there is EXACTLY one.
   *
   * Both directions matter: an empty list and a two-element list are each an
   * error in Kotlin, and answering the first element of a longer list — which
   * is what a 'first()' spelled 'single()' would do — hides a page that
   * returned more than the extension expected.
   */
  single: function (list, predicate) {
    return __then(__k.singleOrNull(list, predicate), function (value) {
      if (!__present(value)) {
        throw new Error('This converted extension expected exactly one item, and did not find one.');
      }
      return value;
    });
  },

  singleOrNull: function (list, predicate) {
    var items = __chars(list);
    if (typeof predicate !== 'function') return items.length === 1 ? items[0] : null;
    return __then(__each(items, function (item) { return predicate(item); }), function (flags) {
      var only = null;
      var seen = 0;
      for (var i = 0; i < items.length; i += 1) {
        if (!flags[i]) continue;
        seen += 1;
        only = items[i];
      }
      return seen === 1 ? only : null;
    });
  },

  /** Kotlin's subList throws for a range outside the list; slice() would clamp. */
  subList: function (list, from, to) {
    var items = __arr(list);
    var start = Number(from);
    var end = Number(to);
    if (start < 0 || end > items.length || start > end) {
      throw new Error(
        'This converted extension took items ' + start + ' to ' + end +
        ' of a list of ' + items.length + '.'
      );
    }
    return items.slice(start, end);
  },

  /**
   * slice(range) and slice(indices), which are one name over two shapes.
   *
   * '__k.range' and '__k.until' both answer arrays of indices, so a range
   * arrives here indistinguishable from an explicit index list — and both mean
   * the same thing: these positions, in this order.
   */
  slice: function (list, indices) {
    var text = typeof list === 'string';
    var items = __chars(list);
    var wanted = __arr(indices);
    var out = [];
    for (var i = 0; i < wanted.length; i += 1) {
      var at = Number(wanted[i]);
      if (at < 0 || at >= items.length) {
        throw new Error('This converted extension sliced position ' + at + ' out of ' + items.length + '.');
      }
      out.push(items[at]);
    }
    return text ? out.join('') : out;
  },

  /** Kotlin CLAMPS these four: taking more than there is is not an error. */
  dropLast: function (list, count) {
    var size = Math.max(0, Number(count));
    if (typeof list === 'string') return list.slice(0, Math.max(0, list.length - size));
    var items = __arr(list);
    return items.slice(0, Math.max(0, items.length - size));
  },

  takeLast: function (list, count) {
    var size = Math.max(0, Number(count));
    if (typeof list === 'string') return size === 0 ? '' : list.slice(Math.max(0, list.length - size));
    var items = __arr(list);
    return size === 0 ? [] : items.slice(Math.max(0, items.length - size));
  },

  /** Stops at the first element that fails, and keeps nothing after it. */
  takeWhile: function (list, predicate) {
    var text = typeof list === 'string';
    var items = __chars(list);
    return __then(__firstIndex(items, function (item) { return __negate(predicate(item)); }), function (index) {
      var kept = index === -1 ? items.slice() : items.slice(0, index);
      return text ? kept.join('') : kept;
    });
  },

  dropWhile: function (list, predicate) {
    var text = typeof list === 'string';
    var items = __chars(list);
    return __then(__firstIndex(items, function (item) { return __negate(predicate(item)); }), function (index) {
      var kept = index === -1 ? [] : items.slice(index);
      return text ? kept.join('') : kept;
    });
  },

  /**
   * The *OrNull extremes, which answer null for an empty collection.
   *
   * Kotlin's minOf/maxOf without the OrNull throw instead, and this ecosystem
   * writes the OrNull form precisely because a page can come back empty.
   */
  minOrNull: function (list) {
    var items = __arr(list);
    if (items.length === 0) return null;
    var best = items[0];
    for (var i = 1; i < items.length; i += 1) if (__cmp(items[i], best) < 0) best = items[i];
    return best;
  },

  maxOrNull: function (list) {
    var items = __arr(list);
    if (items.length === 0) return null;
    var best = items[0];
    for (var i = 1; i < items.length; i += 1) if (__cmp(items[i], best) > 0) best = items[i];
    return best;
  },

  minOfOrNull: function (list, selector) {
    return __then(__each(__arr(list), function (item) { return selector(item); }), function (keys) {
      return __k.minOrNull(keys);
    });
  },

  maxOfOrNull: function (list, selector) {
    return __then(__each(__arr(list), function (item) { return selector(item); }), function (keys) {
      return __k.maxOrNull(keys);
    });
  },

  /** Kotlin keeps the FIRST element carrying the extreme key, not the last. */
  minByOrNull: function (list, selector) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return selector(item); }), function (keys) {
      if (items.length === 0) return null;
      var at = 0;
      for (var i = 1; i < items.length; i += 1) if (__cmp(keys[i], keys[at]) < 0) at = i;
      return items[at];
    });
  },

  maxByOrNull: function (list, selector) {
    var items = __arr(list);
    return __then(__each(items, function (item) { return selector(item); }), function (keys) {
      if (items.length === 0) return null;
      var at = 0;
      for (var i = 1; i < items.length; i += 1) if (__cmp(keys[i], keys[at]) > 0) at = i;
      return items[at];
    });
  },

  /**
   * reduce, which THROWS on an empty list rather than answering undefined.
   *
   * Sequential rather than mapped, because each step needs the one before it —
   * so a suspending operation is chained, not gathered with Promise.all.
   */
  reduce: function (list, operation) {
    var items = __arr(list);
    if (items.length === 0) {
      throw new Error('This converted extension reduced an empty list.');
    }
    var accumulator = items[0];
    var index = 1;
    function step() {
      while (index < items.length) {
        var next = operation(accumulator, items[index]);
        index += 1;
        if (__thenable(next)) {
          return next.then(function (value) { accumulator = value; return step(); });
        }
        accumulator = next;
      }
      return accumulator;
    }
    return step();
  },

  /**
   * fold, over a list or over a Result.
   *
   * 'list.fold(initial) { acc, x -> … }' and 'result.fold(onSuccess, onFailure)'
   * are one name over two entirely different things, and the receiver is all
   * the emitter leaves to tell them apart. Folding a Result as a list would
   * hand the accumulator lambda the wrapper object.
   */
  fold: function (value, first, second) {
    if (__isResult(value)) {
      return value.isSuccess ? first(value.__value) : second(value.__error);
    }
    var items = __arr(value);
    var accumulator = first;
    var index = 0;
    function step() {
      while (index < items.length) {
        var next = second(accumulator, items[index]);
        index += 1;
        if (__thenable(next)) {
          return next.then(function (produced) { accumulator = produced; return step(); });
        }
        accumulator = next;
      }
      return accumulator;
    }
    return step();
  },

  /**
   * random(), which picks an ELEMENT and is not Math.random().
   *
   * '(1..20).random()' is an Int in that range and 'list.random()' is one of
   * the items; a float in [0,1) used as either would be a wrong value at every
   * call site. Kotlin throws for an empty collection, and so does this.
   */
  random: function (list) {
    var items = __chars(list);
    if (items.length === 0) {
      throw new Error('This converted extension asked for a random element of an empty collection.');
    }
    return items[Math.floor(Math.random() * items.length)];
  },

  /**
   * removeAll, over a MutableList or over a Headers.Builder.
   *
   * okhttp's builder spells 'drop every header with this name' exactly the way
   * Kotlin spells 'drop every matching element', and both appear here. A
   * builder must answer itself so the chain that follows keeps building; a
   * list answers whether anything went, as Kotlin's does.
   */
  removeAll: function (collection, subject) {
    if (collection !== null && collection !== undefined && !Array.isArray(collection) &&
        typeof collection.removeAll === 'function') {
      return collection.removeAll(subject);
    }
    var items = __arr(collection);
    var predicate = typeof subject === 'function' ? subject : null;
    var dropping = predicate !== null
      ? []
      : (Array.isArray(subject) || subject instanceof Set ? __arr(subject) : [subject]);
    var kept = [];
    for (var i = 0; i < items.length; i += 1) {
      var go = false;
      if (predicate !== null) go = predicate(items[i]) === true;
      else for (var d = 0; d < dropping.length; d += 1) if (__equal(items[i], dropping[d])) go = true;
      if (!go) kept.push(items[i]);
    }
    var removed = kept.length !== items.length;
    if (Array.isArray(collection)) {
      collection.length = 0;
      for (var j = 0; j < kept.length; j += 1) collection.push(kept[j]);
    }
    return removed;
  },

  /**
   * MutableList.removeAt(index): takes the element out and answers it, and
   * THROWS for an index outside the list — the '.removeAt(list.lastIndex)'
   * that pops a sentinel off a page's results is written against a list the
   * extension knows is not empty, and an empty one is an error there, not an
   * undefined carried on. A receiver with its own removeAt answers for itself.
   */
  removeAt: function (list, index) {
    if (list !== null && list !== undefined && !Array.isArray(list) &&
        typeof list.removeAt === 'function') {
      return list.removeAt(index);
    }
    if (!Array.isArray(list)) {
      throw new Error('This converted extension removed an element from something that is not a list.');
    }
    var at = Number(index);
    if (!Number.isInteger(at) || at < 0 || at >= list.length) {
      throw new Error(
        'This converted extension removed index ' + String(index) + ' of a list of length ' +
        list.length + '.'
      );
    }
    return list.splice(at, 1)[0];
  },

  /**
   * MutableList.reverse(), in place and answering nothing — which is where it
   * differs from 'reversed()', a new list. 'chapters.reverse()' on its own
   * line is how an extension flips a page it read oldest-first; answering a
   * reversed copy there would leave the list the next line reads unchanged.
   * A StringBuilder or anything else with its own reverse answers for itself.
   */
  reverseInPlace: function (list) {
    if (list !== null && list !== undefined && !Array.isArray(list) &&
        typeof list.reverse === 'function') {
      return list.reverse();
    }
    if (!Array.isArray(list)) {
      throw new Error('This converted extension reversed something that is not a list.');
    }
    list.reverse();
    return undefined;
  },

  /**
   * Map.getValue(key): the value, or NoSuchElementException for a key the map
   * does not hold. A key held with a null value answers null, as Kotlin's
   * does; only absence throws. A JSON object is a map here, and a receiver
   * with its own getValue answers for itself.
   */
  mapGetValue: function (map, key) {
    if (map instanceof Map) {
      if (map.has(key)) return map.get(key);
    } else if (map !== null && map !== undefined && typeof map === 'object' && !Array.isArray(map)) {
      if (!__mapLike(map) && typeof map.getValue === 'function') return map.getValue(key);
      if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    } else {
      throw new Error('This converted extension read a key from something that is not a map.');
    }
    throw new Error('This converted extension asked for key "' + __str(key) + '", which is missing in the map.');
  },

  /* -- Result, past getOrNull ---------------------------------------------- */

  /**
   * onFailure / onSuccess, which run a block and answer the SAME Result.
   *
   * '.onFailure { it.printStackTrace() }.getOrNull()' is the shape this
   * ecosystem writes, so a helper answering the block's value instead would
   * break the chain after it — and one answering null on failure would swallow
   * a Result the extension goes on to read.
   */
  onFailure: function (result, fn) {
    if (!__isResult(result) || result.isSuccess) return result;
    return __then(fn(result.__error), function () { return result; });
  },

  onSuccess: function (result, fn) {
    if (!__isResult(result) || result.isFailure) return result;
    return __then(fn(result.__value), function () { return result; });
  },

  /* -- the shapes this ecosystem builds by hand ---------------------------- */

  /** Kotlin's Triple, readable positionally and by name, exactly like 'to'. */
  triple: function (first, second, third) {
    var out = [first, second, third];
    out.first = first;
    out.second = second;
    out.third = third;
    return out;
  },

  /**
   * StringBuilder(), whose one argument is a capacity OR an initial string.
   *
   * 'StringBuilder(16)' preallocates and starts EMPTY; 'StringBuilder("/x")'
   * starts with that text. Reading the number as content would put '16' at the
   * front of whatever the extension went on to build — a wrong value nothing
   * around it would notice.
   */
  stringBuilder: function (initial) {
    var parts = [];
    if (typeof initial === 'string') parts.push(initial);
    var builder = {
      append: function (value) { parts.push(__str(value)); return builder; },
      appendLine: function (value) { parts.push(__str(value) + '\\n'); return builder; },
      insert: function (at, value) { parts.splice(Number(at), 0, __str(value)); return builder; },
      setLength: function (length) {
        parts = [parts.join('').slice(0, Math.max(0, Number(length)))];
        return builder;
      },
      clear: function () { parts = []; return builder; },
      // By code point, as Java's keeps a surrogate pair in order.
      reverse: function () { parts = [Array.from(parts.join('')).reverse().join('')]; return builder; },
      isEmpty: function () { return parts.join('').length === 0; },
      isNotEmpty: function () { return parts.join('').length > 0; },
      toString: function () { return parts.join(''); }
    };
    Object.defineProperty(builder, 'length', { get: function () { return parts.join('').length; } });
    return builder;
  },

  /**
   * Throwable.printStackTrace(), which is a LOG and not a rethrow.
   *
   * '.onFailure { it.printStackTrace() }' is how this ecosystem writes 'carry
   * on without this one', so the helper must not throw and must not be a bare
   * no-op either: the message is the only trace of a mirror that died. It goes
   * to the host log, guarded, because a diagnostic that can fail is worse than
   * no diagnostic.
   */
  printStackTrace: function (error) {
    try {
      var host = __host();
      if (host.log && typeof host.log.warn === 'function') {
        host.log.warn(error && error.message ? String(error.message) : __str(error));
      }
    } catch (ignored) {
      // Outside a plugin call, or a host without a logger. Either way there is
      // nothing to report to and nothing this can usefully do about it.
    }
  },

  /** java.util.Date(), or Date(millis). Only '.time' is ever read off one. */
  dateOf: function (millis) {
    return __kDate(millis === undefined || millis === null ? Date.now() : Number(millis));
  },

  /* -- the builders whose block is handed a receiver ----------------------- */

  /**
   * buildList { add(x) }, whose block is handed a MutableList as its receiver.
   *
   * The same shape as buildString: the block is a function the emitter wrote
   * with bare 'add(…)' calls in it, so the accumulator arrives as 'this' and
   * the LIST comes back rather than the block's own value. Answering what the
   * block returned — the value of its last statement — is the mistake that
   * would look like it worked: 'buildList { add(a); add(b) }' would be 'true'
   * instead of a list of two.
   *
   * 'buildList(2) { … }' preallocates; the number is a CAPACITY, and putting it
   * in the list would add an element the Kotlin never had.
   */
  buildList: function (a, b) {
    var block = typeof b === 'function' ? b : a;
    var items = __mutableList([]);
    return __then(block.call(items, items), function () { return items; });
  },

  /** buildSet uses a Set receiver and keeps insertion order. */
  buildSet: function (a, b) {
    var block = typeof b === 'function' ? b : a;
    var set = __k.toSet([]);
    return __then(block.call(set, set), function () { return set; });
  },

  /** buildMap { put(k, v) }, the same shape over a MutableMap. */
  buildMap: function (a, b) {
    var block = typeof b === 'function' ? b : a;
    var map = __mutableMap(new Map());
    return __then(block.call(map, map), function () { return map; });
  },

  /**
   * kotlinx's buildJsonObject { put(k, v) } and buildJsonArray { add(v) }.
   *
   * A JsonObject has no runtime existence here beyond the plain value it
   * describes — the decoder already answers plain objects and arrays — so these
   * build one and mark it. The mark is what lets toJsonRequestBody accept the
   * result: an object built key by key in the extension's own source needs no
   * @Serializable descriptor, because the extension wrote the wire names
   * itself. It is non-enumerable, so JSON.stringify never sees it.
   */
  buildJsonObject: function (block) {
    var out = {};
    var accumulator = {
      put: function (key, value) { out[__str(key)] = __jsonOf(value); return accumulator; },
      putJsonObject: function (key, inner) {
        return __then(__k.buildJsonObject(inner), function (built) {
          out[__str(key)] = built;
          return accumulator;
        });
      },
      putJsonArray: function (key, inner) {
        return __then(__k.buildJsonArray(inner), function (built) {
          out[__str(key)] = built;
          return accumulator;
        });
      },
      remove: function (key) { delete out[__str(key)]; return accumulator; },
      containsKey: function (key) { return Object.prototype.hasOwnProperty.call(out, __str(key)); }
    };
    return __then(block.call(accumulator, accumulator), function () { return __marked(out); });
  },

  buildJsonArray: function (block) {
    var out = [];
    var accumulator = {
      add: function (value) { out.push(__jsonOf(value)); return accumulator; },
      addJsonObject: function (inner) {
        return __then(__k.buildJsonObject(inner), function (built) {
          out.push(built);
          return accumulator;
        });
      },
      addJsonArray: function (inner) {
        return __then(__k.buildJsonArray(inner), function (built) {
          out.push(built);
          return accumulator;
        });
      }
    };
    return __then(block.call(accumulator, accumulator), function () { return __marked(out); });
  },

  /** A Map's keys, values and entries, read as properties — see '__mapPart'. */
  kKeys: function (value) { return __mapPart(value, 'keys'); },
  kValues: function (value) { return __mapPart(value, 'values'); },
  kEntries: function (value) { return __mapPart(value, 'entries'); },

  /**
   * Kotlin's Map transforms, which answer a Map: the lambda of 'mapValues' and
   * 'mapKeys' is handed the entry, of 'filterKeys' the key and of
   * 'filterValues' the value.
   */
  mapValues: function (map, fn) {
    var entries = __arr(map);
    return __then(__each(entries, function (entry) { return fn(entry); }), function (values) {
      var out = [];
      for (var i = 0; i < entries.length; i += 1) out.push([entries[i][0], values[i]]);
      return __mapFrom(out);
    });
  },
  mapKeys: function (map, fn) {
    var entries = __arr(map);
    return __then(__each(entries, function (entry) { return fn(entry); }), function (keys) {
      var out = [];
      for (var i = 0; i < entries.length; i += 1) out.push([keys[i], entries[i][1]]);
      return __mapFrom(out);
    });
  },
  filterKeys: function (map, fn) {
    var entries = __arr(map);
    return __then(__each(entries, function (entry) { return fn(entry[0]); }), function (flags) {
      return __mapFrom(entries.filter(function (entry, i) { return flags[i]; }));
    });
  },
  filterValues: function (map, fn) {
    var entries = __arr(map);
    return __then(__each(entries, function (entry) { return fn(entry[1]); }), function (flags) {
      return __mapFrom(entries.filter(function (entry, i) { return flags[i]; }));
    });
  },

  /** JsonArray(list) and JsonPrimitive(x), which are the values themselves. */
  jsonArrayOf: function (values) { return __marked(__arr(values).slice()); },
  jsonPrimitiveOf: function (value) { return __jsonOf(value); },

  /**
   * kotlinx's JsonElement accessors, read as properties: 'el.jsonObject',
   * 'el.jsonPrimitive.content', 'p.intOrNull'.
   *
   * A JsonElement here is the plain value JSON.parse made, so these were
   * emitted as property reads of that value and every one answered undefined —
   * 'obj["name"]!!.jsonPrimitive.content' threw on a perfectly good document,
   * and the '?.' spelling of the same chain answered null with nothing
   * refused. About a hundred files across the two measured catalogues read
   * JSON this way, and every JsonTransformingSerializer body does.
   *
   * The names are ordinary field names too — a DTO has a 'content', a class
   * can compute an 'int' — so a receiver that HAS the property, own or on its
   * prototype, answers it unchanged, and only a value that does not is read as
   * JSON. That is decisive rather than a guess: a Kotlin JsonObject has no
   * 'content' and a JsonPrimitive has no fields at all.
   *
   * A JSON null is JS null here and an absent key is undefined, so JsonNull
   * is null: '.jsonPrimitive' of it is itself and its content is the text
   * "null", as in kotlinx. The mismatches kotlinx throws on
   * (IllegalArgumentException, NumberFormatException) throw here too, naming
   * what was asked for.
   */
  jeObject: function (value) {
    var own = __jeOwn(value, 'jsonObject');
    if (own !== __JE_NONE) return own;
    if (__jeKind(value) !== 'object') __jeWrongKind(value, 'JsonObject');
    return value;
  },
  jeArray: function (value) {
    var own = __jeOwn(value, 'jsonArray');
    if (own !== __JE_NONE) return own;
    if (__jeKind(value) !== 'array') __jeWrongKind(value, 'JsonArray');
    return value;
  },
  jePrimitive: function (value) {
    var own = __jeOwn(value, 'jsonPrimitive');
    if (own !== __JE_NONE) return own;
    var kind = __jeKind(value);
    if (kind !== 'primitive' && kind !== 'null') __jeWrongKind(value, 'JsonPrimitive');
    return value === undefined ? null : value;
  },
  jeNull: function (value) {
    var own = __jeOwn(value, 'jsonNull');
    if (own !== __JE_NONE) return own;
    if (__jeKind(value) !== 'null') __jeWrongKind(value, 'JsonNull');
    return null;
  },
  jeContent: function (value) {
    var own = __jeOwn(value, 'content');
    if (own !== __JE_NONE) return own;
    return __jeContent(value, 'content');
  },
  jeContentOrNull: function (value) {
    var own = __jeOwn(value, 'contentOrNull');
    if (own !== __JE_NONE) return own;
    return __jeKind(value) === 'null' ? null : __jeContent(value, 'contentOrNull');
  },
  jeIsString: function (value) {
    var own = __jeOwn(value, 'isString');
    if (own !== __JE_NONE) return own;
    __jeContent(value, 'isString');
    return typeof value === 'string';
  },
  jeInt: function (value) { return __jeNumber(value, 'int', true, false); },
  jeIntOrNull: function (value) { return __jeNumber(value, 'intOrNull', true, true); },
  jeLong: function (value) { return __jeNumber(value, 'long', true, false); },
  jeLongOrNull: function (value) { return __jeNumber(value, 'longOrNull', true, true); },
  jeDouble: function (value) { return __jeNumber(value, 'double', false, false); },
  jeDoubleOrNull: function (value) { return __jeNumber(value, 'doubleOrNull', false, true); },
  jeFloat: function (value) { return __jeNumber(value, 'float', false, false); },
  jeFloatOrNull: function (value) { return __jeNumber(value, 'floatOrNull', false, true); },
  jeBoolean: function (value) { return __jeBoolean(value, 'boolean', false); },
  jeBooleanOrNull: function (value) { return __jeBoolean(value, 'booleanOrNull', true); },

  /**
   * keiyoushi's JsonObject readers from 'core/', by key: 'obj.getStringOrNull(k)'
   * and its siblings.
   *
   * Upstream each is one line over the accessors above, and the '?.' in it is
   * the whole meaning: 'get(key)?.jsonPrimitive?.contentOrNull' answers null
   * for an absent key and for JSON null, and still THROWS for a key holding an
   * object or an array, because '.jsonPrimitive' of those is an
   * IllegalArgumentException. 'getArrayOrNull' is 'get(key)?.jsonArray', so
   * there only an absent key is null — a JSON null under it throws, as
   * JsonNull.jsonArray does. The plain 'getArray'/'getObject' are 'getValue',
   * which throws for an absent key.
   *
   * The receiver must be a JsonObject. The org.json-shaped readers accept
   * anything and answer undefined; these are typed on JsonObject upstream,
   * and a receiver that is not one (a manga record whose 'memo' was never
   * set, a DTO field that was absent) is a bug to report, not a null to walk
   * into a fallback branch.
   */
  jeGetStringOrNull: function (value, key) {
    var found = __jePrimitiveAt(value, key, 'getStringOrNull');
    return found === undefined || found === null ? null : String(found);
  },
  jeGetIntOrNull: function (value, key) {
    var found = __jePrimitiveAt(value, key, 'getIntOrNull');
    return found === undefined ? null : __jeNumber(found, 'intOrNull', true, true);
  },
  jeGetLongOrNull: function (value, key) {
    var found = __jePrimitiveAt(value, key, 'getLongOrNull');
    return found === undefined ? null : __jeNumber(found, 'longOrNull', true, true);
  },
  jeGetBooleanOrNull: function (value, key) {
    var found = __jePrimitiveAt(value, key, 'getBooleanOrNull');
    return found === undefined ? null : __jeBoolean(found, 'booleanOrNull', true);
  },
  jeGetArrayOrNull: function (value, key) {
    var found = __jeFieldOf(value, key, 'getArrayOrNull');
    if (found === undefined) return null;
    if (__jeKind(found) !== 'array') __jeWrongKind(found, 'JsonArray');
    return found;
  },
  jeGetObjectOrNull: function (value, key) {
    var found = __jeFieldOf(value, key, 'getObjectOrNull');
    if (found === undefined) return null;
    if (__jeKind(found) !== 'object') __jeWrongKind(found, 'JsonObject');
    return found;
  },
  jeGetArray: function (value, key) {
    var found = __jeRequiredField(value, key, 'getArray');
    if (__jeKind(found) !== 'array') __jeWrongKind(found, 'JsonArray');
    return found;
  },
  jeGetObject: function (value, key) {
    var found = __jeRequiredField(value, key, 'getObject');
    if (__jeKind(found) !== 'object') __jeWrongKind(found, 'JsonObject');
    return found;
  },

  /* -- the contract functions ---------------------------------------------- */

  /**
   * require(condition) { message }, which THROWS rather than answering false.
   *
   * The idiom is an '.also { require(it.isNotEmpty()) { … } }' after a parse —
   * the extension asserting that the page it just read was not empty, and
   * meaning that failure to reach the viewer as an error. A helper that
   * answered a boolean would let the empty list through and report a source
   * with nothing on it, which is the wrong story about what happened.
   *
   * The message is a lambda in Kotlin so it costs nothing when the check
   * passes, and it is called only when it does not.
   */
  require: function (value, lazyMessage) {
    if (value) return undefined;
    throw new Error(
      __requireMessage(lazyMessage, 'This converted extension required something that was not true.')
    );
  },

  requireNotNull: function (value, lazyMessage) {
    if (__present(value)) return value;
    throw new Error(
      __requireMessage(lazyMessage, 'This converted extension required a value that was null.')
    );
  },

  /** check() and checkNotNull(): require's twins for state rather than arguments. */
  check: function (value, lazyMessage) {
    if (value) return undefined;
    throw new Error(
      __requireMessage(lazyMessage, 'This converted extension checked something that was not true.')
    );
  },

  checkNotNull: function (value, lazyMessage) {
    if (__present(value)) return value;
    throw new Error(
      __requireMessage(lazyMessage, 'This converted extension checked a value that was null.')
    );
  },

  /* -- the last of the long tail ------------------------------------------- */

  /**
   * Int.toChar() and Char(code), which are the character AT that code.
   *
   * '(n + offset).toChar()' is how every rot-n deobfuscator in this catalogue
   * is written. String(n) would answer the DIGITS of the number — a string, so
   * nothing errors, and the decoded text is silently unreadable.
   */
  toChar: function (value) {
    if (typeof value === 'string') return value.length === 0 ? '' : value.charAt(0);
    var code = Number(value);
    if (!Number.isFinite(code)) {
      throw new Error('This converted extension read "' + __str(value) + '" as a character code.');
    }
    // Kotlin's Char is a UTF-16 code UNIT, so a value past 0xffff wraps here as
    // it does there rather than becoming an astral pair.
    return String.fromCharCode(Math.trunc(code) & 0xffff);
  },

  /**
   * The free repeat(times) { index -> … }, which is a LOOP and not a string.
   *
   * Kotlin has both, and they share a name: 'text.repeat(3)' answers a string,
   * and a bare 'repeat(3) { … }' runs the block three times for its effects.
   * Routing the second onto the first would answer the number's digits repeated
   * and never run the block at all.
   *
   * Sequential, because each turn may depend on the one before it — a
   * suspending block is chained rather than started all at once.
   */
  repeatBlock: function (times, action) {
    var total = Math.trunc(Number(times));
    if (!Number.isFinite(total) || total <= 0) return undefined;
    var index = 0;
    function step() {
      while (index < total) {
        var produced = action(index);
        index += 1;
        if (__thenable(produced)) return produced.then(step);
      }
      return undefined;
    }
    return step();
  },

  /** random() for a collection that may be empty, which answers null instead. */
  randomOrNull: function (list) {
    var items = __chars(list);
    return items.length === 0 ? null : items[Math.floor(Math.random() * items.length)];
  },

  /**
   * AnimeFilter.Sort.Selection(index, ascending), which a Sort filter's state is.
   *
   * Read by name off the value it was given, so both halves are named rather
   * than positional — a scraper asks a Sort filter for '.state.ascending'.
   */
  selection: function (index, ascending) {
    return { index: Number(index) || 0, ascending: ascending === true };
  },

  /**
   * isDefault(), which this ecosystem declares identically everywhere.
   *
   * Every occurrence in the catalogue is 'fun isDefault() = state == 0' on a
   * Select filter, and that is what this answers — after asking the value
   * itself, so an extension whose own declaration the emitter did resolve keeps
   * it. Worth knowing that a table entry SHADOWS a declaration of the same name
   * in the converted source; the delegation above is what keeps that from
   * mattering.
   */
  isDefault: function (filter) {
    if (!__present(filter)) return true;
    if (typeof filter.isDefault === 'function') return filter.isDefault();
    return Number(filter.state) === 0;
  },


  /* -- org.json, as the plain values it describes --------------------------- */

  /**
   * JSONObject(text) — a parse, and the values it answers are plain.
   *
   * Android ships org.json and a good part of this ecosystem reads responses
   * with it rather than with kotlinx. There is no object model to reproduce
   * here: a parsed JSON object IS a plain object in this runtime, exactly as
   * kotlinx's JsonObject already is, so the whole of org.json's surface is the
   * READERS below rather than a type.
   *
   * The distinction org.json draws that a plain parse loses is JSONObject.NULL
   * against absent, and it is not load-bearing for any reader here: every one
   * of them answers its fallback for both.
   */
  jsonObject: function (text) {
    if (text === null || text === undefined) return {};
    if (typeof text === 'object') return text;
    return __jsonParsed(text, 'object');
  },

  /** JSONArray(text), or JSONArray(list) — the same parse, one shape along. */
  jsonArray: function (text) {
    if (text === null || text === undefined) return [];
    if (Array.isArray(text)) return text.slice();
    if (typeof text === 'object') return __arr(text);
    return __jsonParsed(text, 'array');
  },

  /**
   * JSONTokener(text), whose only use in this ecosystem is nextValue().
   *
   * It is the reader for a response that may be an object OR an array, which
   * is why an extension reaches for it rather than for JSONObject — so this
   * answers whichever the text holds, and the 'is JSONObject' that always
   * follows one decides.
   */
  jsonTokener: function (text) {
    return {
      nextValue: function () {
        return __jsonParsed(text, 'value');
      }
    };
  },

  /**
   * optString(key), which COERCES and never throws.
   *
   * org.json's opt-readers answer the fallback for a missing key, for a null,
   * and for a value of the wrong kind — and optString turns a number or a
   * boolean into its text rather than answering the fallback. An extension
   * reads 'obj.optString("name")' straight into a title, so answering
   * undefined for a numeric name would put "undefined" on screen.
   */
  optString: function (value, key, fallback) {
    var found = __jsonAt(value, key);
    if (found === null || found === undefined) return fallback === undefined ? '' : fallback;
    if (typeof found === 'object') return fallback === undefined ? '' : fallback;
    return __str(found);
  },

  /** optInt(key), truncating, and never NaN: a non-number answers the fallback. */
  optInt: function (value, key, fallback) {
    return __jsonNumber(value, key, fallback, true);
  },

  /** optLong(key) — the same reader; this runtime has one number type. */
  optLong: function (value, key, fallback) {
    return __jsonNumber(value, key, fallback, true);
  },

  /** optDouble(key), which org.json answers with NaN rather than 0 when absent. */
  optDouble: function (value, key, fallback) {
    return __jsonNumber(value, key, fallback === undefined ? Number.NaN : fallback, false);
  },

  /** optBoolean(key), which reads "true"/"false" as org.json does. */
  optBoolean: function (value, key, fallback) {
    var found = __jsonAt(value, key);
    var stated = fallback === undefined ? false : fallback;
    if (found === null || found === undefined) return stated;
    if (typeof found === 'boolean') return found;
    if (typeof found === 'string') {
      if (found.toLowerCase() === 'true') return true;
      if (found.toLowerCase() === 'false') return false;
    }
    return stated;
  },

  /** optJSONObject(key) — null for absent, and null for a value that is not one. */
  optJSONObject: function (value, key) {
    var found = __jsonAt(value, key);
    return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : null;
  },

  /** optJSONArray(key) — null for absent, and null for a value that is not one. */
  optJSONArray: function (value, key) {
    var found = __jsonAt(value, key);
    return Array.isArray(found) ? found : null;
  },

  /**
   * getJSONObject(key), which THROWS where the opt- form answers null.
   *
   * The difference is the whole reason both exist: an extension writing get-
   * has decided the field is required, and answering null there would carry an
   * undefined into a title or a url instead of failing where the data is wrong.
   */
  getJSONObject: function (value, key) {
    var found = __jsonAt(value, key);
    if (found === null || typeof found !== 'object' || Array.isArray(found)) {
      throw new Error('This converted extension asked for a JSON object at "' + __str(key) + '".');
    }
    return found;
  },

  /** getJSONArray(key) — the same contract, one shape along. */
  getJSONArray: function (value, key) {
    var found = __jsonAt(value, key);
    if (!Array.isArray(found)) {
      throw new Error('This converted extension asked for a JSON array at "' + __str(key) + '".');
    }
    return found;
  },

  /** has(key) — present and not null, which is what org.json means by it. */
  jsonHas: function (value, key) {
    return __jsonAt(value, key) !== null && __jsonAt(value, key) !== undefined;
  },

  /**
   * length(), spelled as a CALL — org.json's, not Kotlin's String.length.
   *
   * An array answers its size and an object answers its number of keys, which
   * is the pair 'for (i in 0 until arr.length())' and 'obj.length()' need.
   */
  jsonLength: function (value) {
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) || typeof value === 'string') return value.length;
    if (value instanceof Map || value instanceof Set) return value.size;
    if (typeof value === 'object') return Object.keys(value).length;
    return 0;
  },


  /**
   * getString(key) — org.json's, which THROWS where optString answers "".
   *
   * Told apart from SharedPreferences.getString by arity at the call site: the
   * preferences reader always names a fallback and this one never does. Getting
   * that backwards would read the plugin's own settings store under a setting
   * id made from a JSON field name, and answer undefined with nothing refused.
   *
   * Coerces, as Android's org.json does: a number or a boolean under the key is
   * its own text rather than a failure.
   */
  jsonGetString: function (value, key) {
    return __str(__jsonRequired(value, key));
  },

  /** getInt(key), truncating — and throwing for a value that is not a number. */
  jsonGetInt: function (value, key) {
    return Math.trunc(__jsonRequiredNumber(value, key));
  },

  /** getLong(key); this runtime has one number type, so it is getInt's twin. */
  jsonGetLong: function (value, key) {
    return Math.trunc(__jsonRequiredNumber(value, key));
  },

  /** getDouble(key), which keeps the fraction getInt truncates. */
  jsonGetDouble: function (value, key) {
    return __jsonRequiredNumber(value, key);
  },

  /** getBoolean(key), reading "true"/"false" as org.json does. */
  jsonGetBoolean: function (value, key) {
    var found = __jsonRequired(value, key);
    if (typeof found === 'boolean') return found;
    if (typeof found === 'string') {
      if (found.toLowerCase() === 'true') return true;
      if (found.toLowerCase() === 'false') return false;
    }
    throw new Error('This converted extension asked for a boolean at "' + __str(key) + '".');
  },

  /**
   * keys(), which org.json answers with an iterator and this answers with names.
   *
   * Both uses in this ecosystem are 'for (k in obj.keys())' and
   * 'obj.keys().forEach { … }', and an array satisfies each of them — where a
   * JavaScript iterator would satisfy the first and not the second.
   */
  jsonKeys: function (value) {
    if (value === null || value === undefined) return [];
    if (value instanceof Map) return [...value.keys()];
    if (Array.isArray(value)) return value.map(function (_, index) { return index; });
    return typeof value === 'object' ? Object.keys(value) : [];
  },

  /** opt(key) — the untyped read, null for absent, with no coercion at all. */
  jsonOpt: function (value, key) {
    var found = __jsonAt(value, key);
    return found === undefined ? null : found;
  },


  /* -- the long tail of the standard library ------------------------------- */

  /**
   * HttpUrl.toUrl(), which is java.net.URL and spells its parts differently.
   *
   * 'val u = response.request.url.toUrl()' then reads 'u.protocol' and 'u.host'
   * to rebuild an origin. okhttp's HttpUrl says 'scheme' for the same thing, so
   * passing the HttpUrl straight through answers undefined for the protocol and
   * builds 'undefined://host' — a url, so nothing throws, and every request
   * made from it fails.
   */
  toUrl: function (value) {
    var url = value === null || value === undefined ? null : value;
    var text = __str(url === null ? '' : url);
    var scheme = url !== null && typeof url.scheme === 'string' ? url.scheme : text.split(':')[0];
    var host = url !== null && typeof url.host === 'string' ? url.host : text.replace(/^[a-z]+:\\/\\//i, '').split('/')[0];
    var path = url !== null && typeof url.encodedPath === 'string' ? url.encodedPath : '';
    return {
      protocol: scheme,
      host: host,
      path: path,
      file: path,
      toString: function () { return text; }
    };
  },

  /**
   * Char.digitToChar() and Int.digitToChar(radix), whose letters are UPPERCASE.
   *
   * Kotlin's is 'A'..'Z' above nine, and a lower-cased answer differs for every
   * value past 9 — which in this ecosystem is a decoded url with the wrong
   * characters in it rather than an error.
   */
  digitToChar: function (value, radix) {
    var base = radix === undefined ? 10 : Math.trunc(Number(radix));
    var digit = Math.trunc(Number(value));
    if (!Number.isFinite(digit) || digit < 0 || digit >= base) {
      throw new Error('This converted extension asked for digit ' + __str(value) + ' in base ' + __str(base) + '.');
    }
    return digit.toString(base).toUpperCase();
  },

  /** Char.isLowerCase()/isUpperCase(), which java.lang.Character already answers. */
  isLowerCase: function (value) { return Character.isLowerCase(value); },
  isUpperCase: function (value) { return Character.isUpperCase(value); },

  /**
   * The classpath, which is what this build has of one: see __ClassLoader.
   *
   * A helper rather than a bundle-scope name because the Kotlin that reaches it
   * is not a construction — 'this::class.java.classLoader' and
   * 'javaClass.classLoader' are reflection the emitter recognises as a whole
   * chain and rewrites, and nothing spells the loader itself.
   */
  classLoader: function () { return __theClassLoader; },

  /**
   * A class's simple name, for the two uses the emitter lets reach here.
   *
   * On an instance of a converted class the answer is exact: the emitter
   * writes each Kotlin class as a JavaScript class of the same name, so the
   * constructor's name is the subclass's when a template asks for its own tag.
   * On anything else — a caught exception above all — it is what this runtime
   * has, which is not always the Kotlin answer: exceptions are plain Errors
   * here, so an IOException reads 'Error'. The emitter only lets a value that
   * is not the class itself reach this inside the arguments of a Log call,
   * where the difference is a word in a diagnostic and never a branch taken.
   */
  /**
   * A stdlib helper's name called on a receiver that may declare it itself.
   *
   * Kotlin resolves a member before an extension, so 'parser.substringBefore(x)'
   * on a converted class that declares substringBefore is that method, and on
   * a String it is the stdlib's. The emitter cannot type the receiver, and
   * only routes a call here when some converted class declares the name; the
   * instance then answers for itself. The built-in collections, strings and
   * plain objects never do — their methods are JavaScript's, not Kotlin
   * members — so they keep the helper.
   */
  ownOr: function (receiver, name, helper) {
    var rest = Array.prototype.slice.call(arguments, 3);
    if (__ownsMethod(receiver, name)) return receiver[name].apply(receiver, rest);
    return __k[helper].apply(null, [receiver].concat(rest));
  },

  simpleName: function (value) {
    if (value === null || value === undefined) {
      throw new Error('This converted extension asked for the class of a null value.');
    }
    if (typeof value === 'string') return 'String';
    if (typeof value === 'boolean') return 'Boolean';
    if (value instanceof Error) return value.name;
    var proto = Object.getPrototypeOf(value);
    var ctor = proto === null ? null : proto.constructor;
    return typeof ctor === 'function' && ctor.name ? ctor.name : 'Object';
  },

  /** Map.containsKey(k), over a Map, a plain object, or a shim that has its own. */
  containsKey: function (value, key) {
    if (value === null || value === undefined) return false;
    if (value instanceof Map) return value.has(key);
    if (typeof value.containsKey === 'function') return value.containsKey(key);
    return Object.prototype.hasOwnProperty.call(value, __str(key));
  },

  /**
   * Collection.intersect(other), which answers a SET and keeps THIS order.
   *
   * Kotlin's intersect is defined on the receiver: the result holds the
   * receiver's elements that the argument also has, in the receiver's order.
   */
  intersect: function (value, other) {
    var mine = __arr(value);
    var theirs = new Set(__arr(other));
    var out = new Set();
    for (var i = 0; i < mine.length; i += 1) if (theirs.has(mine[i])) out.add(mine[i]);
    return out;
  },

  /** Collection.partition { … } — the matching first, as Kotlin's Pair has it. */
  partition: function (value, predicate) {
    var items = __arr(value);
    var yes = [];
    var no = [];
    for (var i = 0; i < items.length; i += 1) {
      (predicate(items[i]) ? yes : no).push(items[i]);
    }
    return __k.to(yes, no);
  },

  /** Array.sortedArray() — a sorted COPY, which is what the caller reads. */
  sortedArray: function (value) { return __k.sorted(value); },

  /**
   * Array.copyOfRange(from, to) — a COPY, with 'to' exclusive.
   *
   * 'slice' rather than 'subarray': the typed-array 'subarray' is a view onto
   * the same buffer, so a caller that then wrote into the result would be
   * writing into the original. Kotlin hands back a copy, and the code that uses
   * this — key material sliced out of a longer buffer — depends on that.
   *
   * Out of range THROWS, because Kotlin throws. JavaScript's 'slice' clamps
   * instead, and a clamped copy is a short key that silently decrypts to
   * rubbish rather than an error anybody sees.
   *
   * (No backticks in this comment: it lives inside the KOTLIN_STDLIB template
   * literal, where one ends the string and takes the whole shim with it.)
   */
  copyOfRange: function (value, from, to) {
    if (value === null || value === undefined) return value;
    var size = value.length;
    if (from < 0 || to > size || from > to) {
      throw new Error('copyOfRange(' + from + ', ' + to + ') outside an array of ' + size);
    }
    return value.slice(from, to);
  },

  /** MutableCollection.clear(), over an array, a Set or a Map. */
  clearAll: function (value) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) { value.length = 0; return undefined; }
    if (typeof value.clear === 'function') { value.clear(); return undefined; }
    for (var key in value) if (Object.prototype.hasOwnProperty.call(value, key)) delete value[key];
    return undefined;
  },

  /** Throwable.stackTraceToString(), which is a message here and not a trace. */
  stackTraceToString: function (value) {
    if (value === null || value === undefined) return '';
    if (typeof value.stack === 'string' && value.stack.length > 0) return value.stack;
    return __str(value.message === undefined ? value : value.message);
  },

  /** String.lineSequence(), which this runtime answers eagerly as lines(). */
  lineSequence: function (value) { return __k.lines(value); },

  /**
   * jsoup's Elements(), which is an ARRAY here.
   *
   * 'select' answers a plain array in this runtime, so a hand-built list has to
   * be the same shape or nothing that indexes or iterates one works on it.
   */
  elementsOf: function (value) {
    if (value === null || value === undefined) return __mutableList([]);
    return __mutableList(__arr(value).slice());
  },

  /**
   * keiyoushi's String.decodeHex(), which answers BYTES.
   *
   * An initialisation vector and a key both arrive as hex in this ecosystem and
   * both are handed straight to a cipher, so a string of the hex digits would
   * be the wrong length before it was the wrong value. An odd length, or a
   * character that is not a hex digit, is a malformed input rather than
   * something to round down.
   */
  decodeHex: function (value) {
    var text = __str(value).trim();
    if (text.length % 2 !== 0 || /[^0-9a-fA-F]/.test(text)) {
      throw new Error('This converted extension read "' + text.slice(0, 24) + '" as hex.');
    }
    var bytes = new Uint8Array(text.length / 2);
    for (var i = 0; i < bytes.length; i += 1) bytes[i] = parseInt(text.substr(i * 2, 2), 16);
    return bytes;
  },

  /** The same, decoded as UTF-8 text — which is what the other half of them do. */
  decodeHexToString: function (value) {
    return __host().text.decode(__k.decodeHex(value));
  },

  /**
   * Registers a '@Serializable' class as a shape the decoder can recognise.
   *
   * The decoder answers plain JSON — that is deliberate, and everything that
   * reads a DTO field by its own name works because of it. Two things do not
   * survive: a '@SerialName'/'@JsonNames' rename, so 'imgPath' never becomes
   * 'image'; and a computed 'val vid get() = key ?: contxt', which lives on the
   * class rather than on the record. Both are silent — an extension reported 32
   * search results whose every id was undefined.
   *
   * Matching is by FIELD SET and it has to be exact, because a wrong prototype
   * is worse than none: a shape is taken only when its every required field is
   * present (directly or under one of its own aliases) and nothing else claims
   * the same record. Zero matches or two, and the record is left exactly as the
   * JSON had it.
   */
  /**
   * Registers a '@Serializable' class for typed decoding — see '__SERIAL'.
   *
   * 'make' builds one from its constructor arguments in declaration order
   * ('new' for a class, a call for a data class's factory). 'meta' is what
   * kotlinx's generated serializer knows: type parameters, the constructor's
   * fields and the body's backing-field properties as [name, wireNames, type,
   * hasDefault, serializer, transient], and a class-level serializer. 'custom'
   * maps each serializer the class names to a thunk answering the object, or
   * is null when it names none.
   */
  serial: function (name, make, meta, custom, ctor) {
    var registration = { make: make, meta: meta, custom: custom };
    __SERIAL[name] = registration;
    // The class (or a data class's factory) answers for its instances, which
    // is how the encoder finds the registration from a value — see
    // '__serialEncode'. Absent from a bundle emitted before it was passed.
    if (typeof ctor === 'function') {
      Object.defineProperty(ctor, '__kSerial', { value: registration, configurable: true });
    }
  },

  /** A JsonTransformingSerializer object, and the type its base serializer decodes. */
  transforms: function (serializer, decodes) {
    if (__TRANSFORMS !== null) __TRANSFORMS.set(serializer, decodes);
  },

  shape: function (ctor, fields, optional, aliases) {
    __SHAPES.push({
      ctor: ctor,
      fields: fields,
      optional: optional || [],
      aliases: aliases || {}
    });
  },

  /**
   * 'value.toJsonElement()' — kotlinx's encoder, in the direction the decoder
   * already goes.
   *
   * A JsonElement in this runtime is a plain JavaScript value: that is what
   * '__k.decode' answers and what every DTO field read depends on. So encoding
   * one is a *plain copy* — nothing here is a class the JSON would not accept
   * — with one thing put back that the decoder took out.
   *
   * That one thing is the '@SerialName' rename. '__applyShapes' maps a wire
   * name onto the field name a DTO reads by; an encode has to map it the other
   * way, or a filter list written out under the field names would come back
   * from the site under names it does not use. The shape is matched exactly as
   * the decoder matches it — one shape or none — so a record nothing claims is
   * copied as it stands.
   */
  toJsonElement: function (value) {
    return __serialEncode(value, __JSON_INJECTED, 'value', 0, false);
  },

  /**
   * Kotlin's plusAssign, which MUTATES rather than rebinding.
   *
   * 'val episodes = mutableListOf(); episodes += more' adds to the list the
   * name already holds. Two overloads share the spelling — one element, or a
   * collection of them — and Kotlin picks by type where this has none, so an
   * array or a Set is read as the many and anything else as the one. A list OF
   * lists is the case that cannot be told apart, and it does not occur here.
   */
  plusAssign: function (target, value) {
    if (target instanceof Set) {
      var many = Array.isArray(value) || value instanceof Set ? __arr(value) : [value];
      for (var s = 0; s < many.length; s += 1) target.add(many[s]);
      return undefined;
    }
    if (target instanceof Map) {
      var pairs = Array.isArray(value) ? value : [value];
      for (var p = 0; p < pairs.length; p += 1) {
        if (pairs[p] && pairs[p].first !== undefined) target.set(pairs[p].first, pairs[p].second);
      }
      return undefined;
    }
    if (!Array.isArray(target)) {
      throw new Error('This converted extension added to something that is not a collection.');
    }
    var items = Array.isArray(value) || value instanceof Set ? __arr(value) : [value];
    for (var i = 0; i < items.length; i += 1) target.push(items[i]);
    return undefined;
  },

  /** Kotlin's minusAssign — removing the first occurrence, as remove() does. */
  minusAssign: function (target, value) {
    if (target instanceof Set) {
      var gone = Array.isArray(value) || value instanceof Set ? __arr(value) : [value];
      for (var g = 0; g < gone.length; g += 1) target.delete(gone[g]);
      return undefined;
    }
    if (target instanceof Map) {
      target.delete(value);
      return undefined;
    }
    if (!Array.isArray(target)) {
      throw new Error('This converted extension removed from something that is not a collection.');
    }
    var out = Array.isArray(value) || value instanceof Set ? __arr(value) : [value];
    for (var i = 0; i < out.length; i += 1) {
      var at = target.indexOf(out[i]);
      if (at !== -1) target.splice(at, 1);
    }
    return undefined;
  },

  /**
   * lateinit's isInitialized, which is a question about assignment.
   *
   * Reading an unassigned lateinit THROWS in Kotlin and answers undefined here,
   * so the receiver is safe to evaluate — and the guard this is part of is the
   * one in front of every lazily-built filter list in this ecosystem.
   */
  initialized: function (value) { return value !== undefined && value !== null; },

  /** ArrayList(), ArrayList(n) and ArrayList(collection) — a mutable list. */
  /**
   * HashMap() / LinkedHashMap(), and the copying constructor that takes a
   * map. A capacity (a number) builds an empty one. A JS Map keeps insertion
   * order, which is LinkedHashMap's promise and a HashMap's permitted order.
   */
  hashMap: function (value) {
    if (value === null || value === undefined || typeof value === 'number') {
      return __mutableMap(new Map());
    }
    return __k.toMutableMap(value);
  },

  /** HashSet() / LinkedHashSet(), and the copying constructor over a collection. */
  hashSet: function (value) {
    if (value === null || value === undefined || typeof value === 'number') return __k.toSet([]);
    return __k.toSet(__arr(value));
  },

  arrayList: function (value) {
    if (value === null || value === undefined || typeof value === 'number') return __mutableList([]);
    return __mutableList(__arr(value).slice());
  },

  /**
   * List(size) { index -> … }, which BUILDS rather than allocating.
   *
   * 'List(episodeCount) { at -> … }' is an episode list, and an empty array of
   * that length would answer undefined for every entry.
   */
  listOfSize: function (size, build) {
    var total = Math.trunc(Number(size));
    if (!Number.isFinite(total) || total <= 0) return [];
    var out = [];
    for (var i = 0; i < total; i += 1) out.push(build === undefined ? null : build(i));
    return out;
  },


  /**
   * parseAs<T> { text -> text }, whose block runs BEFORE the parse.
   *
   * 'response.parseAs<AnimeResponse> { it.substringAfter(…) }' is a
   * JSON document embedded in an HTML attribute: the block is what digs it out,
   * and dropping it hands the parser a page. The block was refused rather than
   * dropped, which was the honest answer until there was somewhere to put it.
   */
  decodeWith: function (value, type) {
    var transform = null;
    for (var i = 2; i < arguments.length; i += 1) {
      if (typeof arguments[i] === 'function') transform = arguments[i];
    }
    var text = __jsonText(value);
    if (text === null) text = __str(value);
    return __k.decode(transform === null ? text : transform(text), type);
  },

  /**
   * A data class's record, told how to copy itself.
   *
   * 'data class Item(val name, val count)' is a factory returning a literal,
   * and a computed property on it closes over the factory's parameters — so a
   * copy made field by field would keep answering from the old values. The
   * record carries its own factory and field order instead, non-enumerable so
   * that serialising it or comparing it sees only its fields.
   */
  dataRecord: function (record, factory, names) {
    // Which data class this is, for the encoder: a record is a plain object
    // and its constructor says nothing. See '__serialOf'.
    Object.defineProperty(record, '__kFactory', { value: factory, enumerable: false });
    Object.defineProperty(record, '__kCopy', {
      value: function (named, positional) {
        var args = [];
        for (var i = 0; i < names.length; i += 1) {
          if (i < positional.length) args.push(positional[i]);
          else if (Object.prototype.hasOwnProperty.call(named, names[i])) args.push(named[names[i]]);
          else args.push(record[names[i]]);
        }
        return factory.apply(null, args);
      },
      enumerable: false
    });
    return record;
  },

  /**
   * Kotlin's data-class copy(field = value), over whatever record it is.
   *
   * A record this build emitted rebuilds itself (see 'dataRecord'). The
   * framework's list pages and Video are data classes upstream and are known
   * here: a page by its two fields in order, a Video by name only, since its
   * two constructors disagree about what comes first. Anything else — a
   * decoded DTO, a plain record — is copied field by field with its prototype
   * kept, which is exact for a value with no computed members, and a
   * positional argument there is refused: nothing says which field it is.
   */
  copy: function (value, named, positional) {
    if (value === null || value === undefined) {
      throw new Error('This converted extension copied a value that was null.');
    }
    var byName = named || {};
    var byPosition = positional || [];
    if (typeof value.__kCopy === 'function') return value.__kCopy(byName, byPosition);
    var order = null;
    if (typeof MangasPage === 'function' && value instanceof MangasPage) order = ['mangas', 'hasNextPage'];
    if (typeof AnimesPage === 'function' && value instanceof AnimesPage) order = ['animes', 'hasNextPage'];
    if (byPosition.length > 0 && (order === null || byPosition.length > order.length)) {
      throw new Error(
        'This converted extension copied a record by position, and this runtime does not know its field order.'
      );
    }
    var out = Object.create(Object.getPrototypeOf(value));
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k += 1) out[keys[k]] = value[keys[k]];
    for (var p = 0; p < byPosition.length; p += 1) out[order[p]] = byPosition[p];
    for (var name in byName) {
      if (Object.prototype.hasOwnProperty.call(byName, name)) out[name] = byName[name];
    }
    // Video's title has two spellings here (see Video); a copy renaming it
    // has to rename both, or the host reads the old one.
    if (typeof Video === 'function' && value instanceof Video &&
        Object.prototype.hasOwnProperty.call(byName, 'videoTitle')) {
      out.quality = __str(byName.videoTitle);
    }
    if (out.mangas !== undefined && order !== null) out.mangas = __arr(out.mangas);
    if (out.animes !== undefined && order !== null) out.animes = __arr(out.animes);
    return out;
  },

  /**
   * A reified type argument, as the text '__k.decode' reads a container from.
   *
   * 'inline fun <reified T> Response.parseAs(): T = json.decodeFromString(…)'
   * carries T as an argument, and what arrives is whatever the call site
   * wrote: the text 'List<Item>' for a type the runtime reads by name, or the
   * class itself for one the module declares. A class is a record shape, and
   * records are matched by their fields after the parse (see 'shape'), so its
   * text is 'Any'. Not the empty string: a string receiver arrives as two
   * strings, and decode tells payload from type by which one looks like a
   * type. Handing decode the class itself would have it CALLED as a
   * descriptor thunk, which an ES6 class refuses.
   */
  typeText: function (type) {
    return typeof type === 'string' ? type : 'Any';
  },

  /**
   * keiyoushi's SimpleDateFormat.tryParse, which answers 0 and never throws.
   *
   * 0 is the epoch, and it is what this ecosystem stores for 'no date' — the
   * host renders it as no date at all. Throwing instead would lose a whole
   * episode list over an upload date nobody reads.
   */
  tryParse: function (format, text) {
    if (format === null || format === undefined || typeof format.parse !== 'function') return 0;
    if (!__present(text)) return 0;
    try {
      var parsed = format.parse(text);
      return parsed === null || parsed === undefined ? 0 : Number(parsed.time);
    } catch (error) {
      return 0;
    }
  },

  /* 'tryParseDate' and its two siblings are java.time's, and live with it in
     'kotlin-time.ts': each has its own meaning there, which is the point. */

  /**
   * keiyoushi's 'Element?.textOrNull()' — the element's text, with blank read
   * as absent.
   *
   * Null rather than '' because the call sites assign straight into a model
   * field ('description = …?.textOrNull()') where the two are different: an
   * empty string is a description somebody wrote and left empty, and null is
   * one the page does not carry.
   */
  textOrNull: function (node) {
    if (node === null || node === undefined || typeof node.text !== 'function') return null;
    var text = __str(node.text());
    return text.trim().length === 0 ? null : text;
  },

  /** The same, for an attribute: jsoup answers '' for one that is not there. */
  attrOrNull: function (node, name) {
    if (node === null || node === undefined || typeof node.attr !== 'function') return null;
    var value = __str(node.attr(name));
    return value.trim().length === 0 ? null : value;
  }
};

/* --- org.json's readers, over plain parsed values -------------------------- */

/**
 * A parse that says what it was reading, and what it got.
 *
 * org.json throws JSONException on malformed text, and the extensions that use
 * it lean on that: a response that is an HTML error page rather than JSON must
 * fail here rather than carry an undefined into an episode list.
 */
function __jsonParsed(text, want) {
  var parsed;
  try {
    parsed = JSON.parse(__str(text));
  } catch (error) {
    throw new Error('This converted extension could not read a response as JSON.');
  }
  if (want === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
    throw new Error('This converted extension read a response that is not a JSON object.');
  }
  if (want === 'array' && !Array.isArray(parsed)) {
    throw new Error('This converted extension read a response that is not a JSON array.');
  }
  return parsed;
}

/**
 * One field of a parsed value, by name or by index.
 *
 * 'arr.getJSONObject(i)' and 'obj.optString(k)' are the same read here, because
 * a JSONArray is an array and a JSONObject is an object. A Map is accepted too:
 * kotlinx's decoder answers one for an untyped object, and the two
 * representations meet whenever a response is read by one and indexed by the
 * other.
 */
function __jsonAt(value, key) {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Map) return value.get(key);
  if (Array.isArray(value)) {
    var index = Math.trunc(Number(key));
    return Number.isFinite(index) ? value[index] : undefined;
  }
  if (typeof value !== 'object') return undefined;
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

/** opt-readers for numbers: a value that is not one answers the fallback. */
function __jsonNumber(value, key, fallback, whole) {
  var stated = fallback === undefined ? 0 : fallback;
  var found = __jsonAt(value, key);
  if (found === null || found === undefined || typeof found === 'object') return stated;
  var number = typeof found === 'boolean' ? Number(found) : Number(found);
  if (!Number.isFinite(number)) return stated;
  return whole ? Math.trunc(number) : number;
}

/** A field a 'get' reader requires, or the failure that says which one. */
function __jsonRequired(value, key) {
  var found = __jsonAt(value, key);
  if (found === null || found === undefined) {
    throw new Error('This converted extension asked for a required JSON field "' + __str(key) + '".');
  }
  return found;
}

/** The same, read as a number rather than as text. */
function __jsonRequiredNumber(value, key) {
  var found = __jsonRequired(value, key);
  var number = Number(found);
  if (typeof found === 'object' || !Number.isFinite(number)) {
    throw new Error('This converted extension asked for a number at "' + __str(key) + '".');
  }
  return number;
}

/* --- java.text.Normalizer, android.text.Html, and java.time's instants ----- */

/**
 * java.text.Normalizer, which JavaScript spells as a method on the string.
 *
 * The pattern it is always part of is accent-stripping: normalize to NFD, then
 * drop the combining marks. Both halves have to work, and the second is the
 * extension's own regex.
 */
var Normalizer = {
  Form: { NFD: 'NFD', NFC: 'NFC', NFKD: 'NFKD', NFKC: 'NFKC' },
  normalize: function (value, form) {
    return __str(value).normalize(form === undefined ? 'NFC' : __str(form));
  }
};

/**
 * android.text.Html.fromHtml(), which answers the TEXT of a fragment.
 *
 * A synopsis arrives with entities and tags in it and an extension reaches for
 * this to get a paragraph out. Answering the markup unchanged would put the
 * tags on screen; answering the entities undecoded would put '&amp;' there.
 *
 * A String is returned rather than a Spanned, because '.toString()' is what
 * every call site does with one and a String answers that itself.
 */
var Html = {
  FROM_HTML_MODE_LEGACY: 0,
  FROM_HTML_MODE_COMPACT: 63,
  fromHtml: function (value, mode) {
    if (typeof Jsoup === 'undefined') return __str(value);
    return Jsoup.parse(__str(value)).text();
  }
};

${KOTLIN_TIME}
/**
 * okhttp's CacheControl, which the host's transport decides for itself.
 *
 * Carried as a value rather than refused, for the reason the timeouts on
 * '__clientBuilder' are: an extension writes 'CacheControl.FORCE_NETWORK' as
 * the third argument of GET, where this runtime already drops it, and refusing
 * the name would lose the extension over a line that changes nothing it can
 * observe. The host owns caching (ABI.md), and it is the one that has to.
 */
var CacheControl = {
  FORCE_NETWORK: { noCache: true },
  FORCE_CACHE: { onlyIfCached: true },
  Builder: function () {
    var builder = {
      noCache: function () { return builder; },
      noStore: function () { return builder; },
      maxAge: function () { return builder; },
      maxStale: function () { return builder; },
      minFresh: function () { return builder; },
      onlyIfCached: function () { return builder; },
      noTransform: function () { return builder; },
      immutable: function () { return builder; },
      build: function () { return {}; }
    };
    return builder;
  }
};

/* --- the shapes a '@Serializable' class registers -------------------------- */

var __SHAPES = [];

/** See '__k.toJsonElement'. */
function __encodeElement(value, depth) {
  if (depth > 12 || value === null || value === undefined) return value === undefined ? null : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    var list = [];
    for (var i = 0; i < value.length; i += 1) list.push(__encodeElement(value[i], depth + 1));
    return list;
  }
  if (value instanceof Map) {
    var fromMap = {};
    value.forEach(function (held, key) { fromMap[String(key)] = __encodeElement(held, depth + 1); });
    return fromMap;
  }
  if (value instanceof Set) {
    var fromSet = [];
    value.forEach(function (held) { fromSet.push(__encodeElement(held, depth + 1)); });
    return fromSet;
  }

  // A record whose class runs a custom serializer would be encoded here as its
  // decoded fields, which is not what that serializer writes. Refused rather
  // than sent: see '__serialObject'.
  if (__SERIAL_CUSTOM !== null && __SERIAL_CUSTOM.has(value)) {
    throw new Error(
      'This converted extension encoded a record whose class has a custom serializer, which this runtime only runs for decoding.'
    );
  }

  var found = null;
  var matches = 0;
  for (var s = 0; s < __SHAPES.length; s += 1) {
    if (!__shapeFits(__SHAPES[s], value)) continue;
    matches += 1;
    found = __SHAPES[s];
  }
  // The reverse of '__applyShapes': field name back to wire name.
  var renames = {};
  if (matches === 1 && found !== null) {
    for (var alias in found.aliases) renames[found.aliases[alias]] = alias;
  }

  var out = {};
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    var held = value[key];
    if (typeof held === 'function') continue;
    out[renames[key] === undefined ? key : renames[key]] = __encodeElement(held, depth + 1);
  }
  return out;
}

/* --- typed encoding, the way kotlinx encodes --------------------------------- */

/**
 * The Json the host injects, which is what keiyoushi's 'jsonInstance' is and
 * what its encoding helpers default to: 'ignoreUnknownKeys' and
 * 'explicitNulls = false' over kotlinx's defaults, so 'encodeDefaults' is
 * false too. Both matter only here: a property still holding its default is
 * left out, and so is a null.
 */
var __JSON_INJECTED = { encodeDefaults: false, explicitNulls: false };

/** The registration answering for this value, or null. See '__k.serial'. */
function __serialOf(value) {
  if (value === null || typeof value !== 'object') return null;
  var owner = value.__kFactory !== undefined ? value.__kFactory : value.constructor;
  return typeof owner === 'function' && owner.__kSerial !== undefined ? owner.__kSerial : null;
}

function __serialRefuse(path, why) {
  return new Error('This converted extension encoded "' + path + '", ' + why +
    ', which this runtime cannot write the way kotlinx would.');
}

/**
 * One value, as kotlinx's Json encoder writes it.
 *
 * The decoder builds a record from its registration (see '__serialDecode');
 * this is the other direction over the same registration, and it is what the
 * old encoder guessed at. That one copied a record's *field* names — posting
 * 'query' to a server that reads the '@SerialName' 'q' — and wrote every
 * default and every null, which kotlinx leaves out. A request built that way
 * is answered with nothing in it, and the source looks as if it went quiet.
 *
 * 'strict' is whether a value this runtime cannot vouch for is refused
 * (a request body, which used to be refused whole) or left to the old copy
 * (the JsonElement and string helpers, which have always answered one).
 */
function __serialEncode(value, config, path, depth, strict) {
  if (depth > 32) throw __serialRefuse(path, 'nested past any payload a request carries');
  if (value === null || value === undefined) return null;
  var kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return value;
  if (kind === 'number') {
    if (!isFinite(value)) throw __serialRefuse(path, 'a number JSON has no spelling for');
    return value;
  }
  if (kind === 'bigint') {
    // JSON.stringify refuses a BigInt; a Long past 2^53 has no exact number.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw __serialRefuse(path, 'a Long past what a JSON number carries exactly here');
    }
    return Number(value);
  }
  if (kind !== 'object') throw __serialRefuse(path, 'a ' + kind);
  if (value instanceof Uint8Array) {
    // A ByteArray is a list of signed bytes to kotlinx.
    var bytes = [];
    for (var b = 0; b < value.length; b += 1) bytes.push(value[b] > 127 ? value[b] - 256 : value[b]);
    return bytes;
  }
  if (__isJson(value)) return value;
  var registration = __serialOf(value);
  if (registration !== null) return __serialEncodeObject(registration, value, config, path, depth, strict);
  var i;
  if (Array.isArray(value)) {
    // A Pair or Triple is an array here and a class to kotlinx, which writes
    // its components by name. A map entry is written as a one-key object
    // there, which nothing in this catalogue encodes.
    if (Object.prototype.hasOwnProperty.call(value, 'key')) {
      throw __serialRefuse(path, 'a Map.Entry');
    }
    if (Object.prototype.hasOwnProperty.call(value, 'first') && Object.prototype.hasOwnProperty.call(value, 'second')) {
      var pair = {
        first: __serialEncode(value.first, config, path + '.first', depth + 1, strict),
        second: __serialEncode(value.second, config, path + '.second', depth + 1, strict)
      };
      if (Object.prototype.hasOwnProperty.call(value, 'third')) {
        pair.third = __serialEncode(value.third, config, path + '.third', depth + 1, strict);
      }
      return pair;
    }
    var list = [];
    for (i = 0; i < value.length; i += 1) list.push(__serialEncode(value[i], config, path + '[' + i + ']', depth + 1, strict));
    return list;
  }
  if (value instanceof Set) {
    var fromSet = [];
    value.forEach(function (held) { fromSet.push(__serialEncode(held, config, path + '[]', depth + 1, strict)); });
    return fromSet;
  }
  if (value instanceof Map) {
    var fromMap = {};
    value.forEach(function (held, key) {
      fromMap[__serialKey(key, path)] = __serialEncode(held, config, path + '.' + String(key), depth + 1, strict);
    });
    return fromMap;
  }
  var ctor = value.constructor;
  if (ctor && ctor.entries !== undefined && typeof value.ordinal === 'number' && typeof value.name === 'string') {
    return __serialEnum(value, ctor);
  }
  var proto = Object.getPrototypeOf(value);
  var plain = (proto === Object.prototype || proto === null) && value.__kCopy === undefined;
  if (!plain) {
    if (strict) {
      throw __serialRefuse(path, 'an instance of a class with no @Serializable registration in this bundle');
    }
    return __encodeElement(value, depth);
  }
  // A plain object is a JsonObject or a Kotlin Map, and both are written as
  // the keys they already carry.
  var out = {};
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (typeof value[key] === 'function') continue;
    out[key] = __serialEncode(value[key], config, path + '.' + key, depth + 1, strict);
  }
  return out;
}

/** A map key, which kotlinx's Json writes as a string and only for a primitive or an enum. */
function __serialKey(key, path) {
  var kind = typeof key;
  if (kind === 'string' || kind === 'number' || kind === 'boolean' || kind === 'bigint') return String(key);
  if (key !== null && typeof key === 'object' && key.constructor && key.constructor.entries !== undefined &&
      typeof key.name === 'string') {
    return __serialEnum(key, key.constructor);
  }
  throw __serialRefuse(path, 'a map whose keys are not primitives');
}

/** An enum entry: its '@SerialName' when the emitter recorded one, else its name. */
function __serialEnum(value, ctor) {
  var names = ctor.__kSerialNames;
  if (names !== undefined && Object.prototype.hasOwnProperty.call(names, value.name)) return names[value.name];
  return value.name;
}

/**
 * One registered record: its fields under their wire names, in declaration
 * order, the constructor's and then the body's.
 *
 * A default is decided the way the generated serializer decides it — the
 * property is left out when it equals what its default expression gives — and
 * the default is found by asking the class itself: built again with that one
 * argument left out and every other as the record has it, which is where the
 * emitter put the default expressions. So a default that reads another
 * parameter — 'val size: Int = page * 10' — reads the same value kotlinx's
 * would, and a body property is compared with the class built from the
 * record's own arguments.
 */
function __serialEncodeObject(registration, value, config, path, depth, strict) {
  var meta = registration.meta;
  if (meta.with !== null) throw __serialRefuse(path, 'a class with a custom serializer');
  var actual = [];
  for (var a = 0; a < meta.fields.length; a += 1) actual.push(value[meta.fields[a][0]]);
  // The class built again with one argument left to its default and every
  // other one as this record has it — which is exactly the expression the
  // generated serializer compares against, evaluated over the same values.
  function rebuilt(without) {
    var args = actual.slice();
    if (without >= 0) args[without] = undefined;
    var built;
    try {
      built = registration.make(args);
    } catch (error) {
      throw __serialRefuse(path, 'a class whose defaults could not be worked out (' +
        (error && error.message ? error.message : String(error)) + ')');
    }
    if (__thenable(built)) throw __serialRefuse(path, 'a class whose construction suspends');
    return built;
  }
  var out = {};
  var bodyDefaults = null;
  var fields = meta.fields.concat(meta.body);
  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    if (field[5] === true) continue;
    var held = value[field[0]];
    if (held === undefined) held = null;
    // '@EncodeDefault' decides for its own property: ALWAYS writes a default,
    // NEVER leaves one out whatever the Json says.
    var mode = field.length > 6 ? field[6] : null;
    var skipDefaults = mode === 'NEVER' || (mode !== 'ALWAYS' && !config.encodeDefaults);
    if (field[3] && skipDefaults) {
      var isBody = i >= meta.fields.length;
      var fresh;
      if (isBody) {
        if (bodyDefaults === null) bodyDefaults = rebuilt(-1);
        fresh = bodyDefaults;
      } else {
        fresh = rebuilt(i);
      }
      if (__serialSame(held, fresh[field[0]], 0)) continue;
    }
    if (held === null && !config.explicitNulls) continue;
    // A serializer named on the property, or on a type argument inside it
    // ('List<@Serializable(X::class) String>', spelled '@X|' in the type):
    // what it writes is its own business, and only decoding runs one here.
    if (field[4] !== null || field[2].indexOf('@') !== -1) {
      throw __serialRefuse(path + '.' + field[0], 'a field with a custom serializer');
    }
    out[field[1][0]] = __serialEncode(held, config, path + '.' + field[0], depth + 1, strict);
  }
  return out;
}

/**
 * Kotlin's '==' as a generated serializer asks it of a default: structural
 * for a list, a set, a map and a data class, identity for anything else —
 * which is 'equals' for every type a default is written as.
 */
function __serialSame(a, b, depth) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == b;
  if (typeof a !== 'object' || typeof b !== 'object' || depth > 16) return false;
  var i;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (i = 0; i < a.length; i += 1) if (!__serialSame(a[i], b[i], depth + 1)) return false;
    return true;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false;
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    var every = true;
    a.forEach(function (one) { if (!b.has(one)) every = false; });
    return every;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    var same = true;
    a.forEach(function (held, key) { if (!b.has(key) || !__serialSame(held, b.get(key), depth + 1)) same = false; });
    return same;
  }
  var plainA = Object.getPrototypeOf(a) === Object.prototype;
  var plainB = Object.getPrototypeOf(b) === Object.prototype;
  // A data class, or a JsonObject/Map written as a plain object: by fields.
  var recordA = a.__kCopy !== undefined && a.__kFactory !== undefined;
  var recordB = b.__kCopy !== undefined && b.__kFactory !== undefined;
  if (recordA || recordB) {
    if (!(recordA && recordB) || a.__kFactory !== b.__kFactory) return false;
  } else if (!(plainA && plainB)) {
    return false;
  }
  var keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (i = 0; i < keys.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
    if (!__serialSame(a[keys[i]], b[keys[i]], depth + 1)) return false;
  }
  return true;
}

/** True when this record carries every field the shape requires. */
function __shapeFits(shape, value) {
  for (var i = 0; i < shape.fields.length; i += 1) {
    var field = shape.fields[i];
    if (shape.optional.indexOf(field) !== -1) continue;
    if (Object.prototype.hasOwnProperty.call(value, field)) continue;
    var aliased = false;
    for (var key in shape.aliases) {
      if (shape.aliases[key] === field && Object.prototype.hasOwnProperty.call(value, key)) {
        aliased = true;
        break;
      }
    }
    if (!aliased) return false;
  }
  return true;
}

/**
 * Gives a decoded record the names and the getters its Kotlin class declared.
 *
 * Depth-first, so a nested record is settled before the one holding it, and
 * only ever on a plain object: a Map, an array's elements and a primitive are
 * left alone. Nothing is removed — the JSON's own keys stay exactly where they
 * were, and an alias is *added* beside the key it renames, because an extension
 * reading the raw name is still reading something true.
 */
function __applyShapes(value, depth) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) __applyShapes(value[i], depth + 1);
    return value;
  }
  if (value instanceof Map || value instanceof Set) return value;

  for (var key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) __applyShapes(value[key], depth + 1);
  }

  var found = null;
  var matches = 0;
  for (var s = 0; s < __SHAPES.length; s += 1) {
    if (!__shapeFits(__SHAPES[s], value)) continue;
    matches += 1;
    found = __SHAPES[s];
  }
  // Exactly one, or nothing: see 'shape'.
  if (matches !== 1 || found === null) return value;

  for (var alias in found.aliases) {
    var field = found.aliases[alias];
    if (
      Object.prototype.hasOwnProperty.call(value, alias) &&
      !Object.prototype.hasOwnProperty.call(value, field)
    ) {
      value[field] = value[alias];
    }
  }
  if (typeof found.ctor === 'function' && found.ctor.prototype) {
    try {
      Object.setPrototypeOf(value, found.ctor.prototype);
    } catch (error) {
      // A frozen or sealed record keeps the names it was given, which is still
      // more than it had.
    }
  }
  return value;
}

/* --- the boxed numeric limits, and Math ----------------------------------- */

/**
 * Kotlin's Float/Double/Int/Long companions, for the two constants read here.
 *
 * 'ep.episode_number.takeIf { it > 0f } ?: Float.MAX_VALUE' is the shape: a
 * sort key meaning "put this last". A capitalised receiver is passed through by
 * the emitter, so an absent name is 'Float is not defined' at run time rather
 * than a refusal — which is why these exist as values and not as a table.
 *
 * Int and Long carry the 32-bit and 64-bit limits Kotlin gives them; this
 * runtime has one number type, and the LIMITS still have to be the right ones
 * because a comparison against them is what they are for.
 */
var Float = {
  MAX_VALUE: 3.4028235e38,
  MIN_VALUE: 1.4e-45,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: Number.NaN
};
var Double = {
  MAX_VALUE: Number.MAX_VALUE,
  MIN_VALUE: Number.MIN_VALUE,
  POSITIVE_INFINITY: Infinity,
  NEGATIVE_INFINITY: -Infinity,
  NaN: Number.NaN
};
var Int = { MAX_VALUE: 2147483647, MIN_VALUE: -2147483648 };
var Long = { MAX_VALUE: 9223372036854775807, MIN_VALUE: -9223372036854775808 };

/* --- java.util.concurrent.atomic, on one thread --------------------------- */

/**
 * The atomics, which are a box with methods when there is only one thread.
 *
 * Generic utility code in this ecosystem reaches for an AtomicInteger to number
 * things — a request id, a segment counter — and for an AtomicBoolean to record
 * that something has happened once. Both are ordinary mutable state here: a
 * plugin is a single-threaded module (ABI.md section 1), so a read-modify-write
 * cannot be interrupted part way and the guarantee the class exists to provide
 * is one the runtime already has.
 *
 * One implementation serves all four names. The numeric operations coerce, so
 * an AtomicBoolean asked to increment answers NaN rather than pretending — but
 * nothing calls that, and a separate class per name would be four copies of
 * this to keep in step.
 */
function __atomic(initial) {
  var box = {
    __value: initial,
    get: function () { return box.__value; },
    set: function (next) { box.__value = next; },
    lazySet: function (next) { box.__value = next; },
    getAndSet: function (next) { var was = box.__value; box.__value = next; return was; },
    compareAndSet: function (expect, next) {
      if (box.__value !== expect) return false;
      box.__value = next;
      return true;
    },
    incrementAndGet: function () { box.__value = Number(box.__value) + 1; return box.__value; },
    decrementAndGet: function () { box.__value = Number(box.__value) - 1; return box.__value; },
    getAndIncrement: function () { var was = box.__value; box.__value = Number(was) + 1; return was; },
    getAndDecrement: function () { var was = box.__value; box.__value = Number(was) - 1; return was; },
    addAndGet: function (delta) { box.__value = Number(box.__value) + Number(delta); return box.__value; },
    getAndAdd: function (delta) {
      var was = box.__value;
      box.__value = Number(was) + Number(delta);
      return was;
    },
    updateAndGet: function (fn) { box.__value = fn(box.__value); return box.__value; },
    getAndUpdate: function (fn) { var was = box.__value; box.__value = fn(was); return was; },
    toString: function () { return String(box.__value); }
  };
  return box;
}

function AtomicInteger(initial) { return __atomic(initial === undefined ? 0 : Number(initial)); }
function AtomicLong(initial) { return __atomic(initial === undefined ? 0 : Number(initial)); }
function AtomicBoolean(initial) { return __atomic(initial === true); }
function AtomicReference(initial) { return __atomic(initial === undefined ? null : initial); }

/**
 * 'Any()', which this ecosystem constructs for one reason: something to lock.
 *
 * 'private val lock = Any()' and then 'synchronized(lock) { … }'. The lock does
 * nothing here (see __k.synchronized) and neither does this, but the value has
 * to exist and to be distinct from every other one, which an empty object is.
 */
function Any() { return {}; }

/* --- the declarative request policy --------------------------------------- */

/*
 * What an extension asked for about *how* its requests are made, and the one
 * place it is allowed to ask.
 *
 * okhttp's answer to all of this is an Interceptor: an object in a chain that
 * may delay, re-header or re-issue a call. There is no chain here — the host
 * owns the transport — so the named, declarative helpers the ecosystem's shared
 * libraries expose are folded into a policy the host enforces (ABI.md 2.1), and
 * a hand-written 'addInterceptor { chain -> ... }' stays refused by name. That
 * boundary is adr/0006 section 5's: recognising what an arbitrary lambda means
 * is exactly the intent-recognition this converter will not do.
 *
 * These live in the stdlib section rather than beside the client, so a bundle
 * that carries the stdlib alone still has a complete answer for them.
 */
var __rateLimitAll = null;
var __rateLimitByHost = {};
var __policyVersion = 0;
/*
 * Starts level with the version, so an extension that declares nothing never
 * calls ctx.http.policy at all. A host that has not implemented the method is
 * then unaffected by this section existing, which is the difference between a
 * new capability and a new requirement.
 */
var __policySent = 0;

/* The host of an okhttp HttpUrl, of a string, or of neither. */
function __hostOfUrl(value) {
  if (value !== null && value !== undefined && typeof value.host === 'string') {
    return String(value.host).toLowerCase();
  }
  var text = String(value === null || value === undefined ? '' : value);
  var found = /^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/([^/?#]*)/.exec(text);
  var authority = found === null ? text : found[1];
  return authority.replace(/^[^@]*@/, '').replace(/:[0-9]+$/, '').toLowerCase();
}

/*
 * Keeps the stricter of two rules for one scope.
 *
 * An extension may build two clients and limit each — the catalogue's own
 * '.rateLimit(2)' for the API and '.rateLimit(1)' for the images. The policy is
 * per plugin rather than per client, so the two have to be one rule, and the
 * stricter one is the only merge that can never send a source more than it was
 * told it could have. Equal rates are decided by the smaller burst.
 */
function __stricterRate(held, rule) {
  if (held === null || held === undefined) return rule;
  var a = held.permits / held.periodMs;
  var b = rule.permits / rule.periodMs;
  if (b < a) return rule;
  if (b > a) return held;
  return rule.permits < held.permits ? rule : held;
}

/* Folds one declaration in. 'host' is null for the plugin-wide rule. */
function __declareRateLimit(host, permits, periodMs) {
  var wanted = Number(permits);
  var period = Number(periodMs);
  if (!Number.isInteger(wanted) || wanted < 1 || !Number.isInteger(period) || period < 1) {
    throw new Error(
      'This converted extension asked for a rate limit of ' + permits + ' per ' + periodMs +
      'ms, which is not a rate this host can honour exactly.'
    );
  }
  var rule = { permits: wanted, periodMs: period };
  if (host === null) {
    __rateLimitAll = __stricterRate(__rateLimitAll, rule);
  } else if (host.length === 0) {
    throw new Error('This converted extension rate-limited a host whose url named none.');
  } else {
    __rateLimitByHost[host] = __stricterRate(__rateLimitByHost[host], rule);
  }
  __policyVersion += 1;
}

function __policyOf() {
  var policy = {};
  if (__rateLimitAll !== null) policy.rateLimit = __rateLimitAll;
  var named = Object.keys(__rateLimitByHost);
  if (named.length > 0) {
    policy.rateLimitByHost = {};
    for (var i = 0; i < named.length; i += 1) {
      policy.rateLimitByHost[named[i]] = __rateLimitByHost[named[i]];
    }
  }
  return policy;
}

/*
 * Hands the host the policy, once per change, before the first request it
 * governs.
 *
 * Declared lazily rather than eagerly because '.rateLimit(...)' is written in a
 * property initialiser, and a property initialiser may run before any plugin
 * call has begun — there is no ctx to declare against yet. The version counter
 * is what stops a re-declaration of an unchanged policy, which the host treats
 * as a new policy and would otherwise reset the window for.
 *
 * A host with no ctx.http.policy is told, loudly, rather than quietly given a
 * plugin whose rate limit does not exist. That silent drop is the bug this
 * whole path was built to remove.
 */
function __syncPolicy() {
  if (__policySent === __policyVersion) return;
  var ctx = __host();
  if (ctx.http === null || ctx.http === undefined || typeof ctx.http.policy !== 'function') {
    throw new Error(
      'This converted extension declares a request rate limit, and this host has no ' +
      'ctx.http.policy() to honour it with.'
    );
  }
  __policySent = __policyVersion;
  var declared = ctx.http.policy(__policyOf());
  if (declared !== null && declared !== undefined && typeof declared.catch === 'function') {
    declared.catch(function (error) {
      // Re-armed, so the next request tries again rather than proceeding
      // unpaced on the strength of one refusal.
      __policySent = __policyVersion - 1;
      if (ctx.log !== null && ctx.log !== undefined && typeof ctx.log.warn === 'function') {
        ctx.log.warn('the host refused this extension\\'s request policy: ' + __str(error && error.message ? error.message : error));
      }
    });
  }
}
`;

/**
 * okhttp, as much of it as an extension's request-building touches.
 *
 * `execute()` is the only asynchronous call in a converted extension, by
 * design: it buffers the body before resolving so everything downstream of a
 * response — `body.string()`, `asJsoup()`, `parseAs()` — stays synchronous and
 * the emitter never has to inject `await` into an expression position.
 *
 * Requires `JS_RUNTIME` (for `__host`) and `KOTLIN_STDLIB` before it.
 */
export const KOTLIN_HTTP = `
/* --- okhttp --------------------------------------------------------------- */

function __headerPairs(value) {
  var pairs = [];
  if (!value) return pairs;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i += 1) {
      if (Array.isArray(value[i])) pairs.push([String(value[i][0]), __str(value[i][1])]);
    }
    return pairs;
  }
  if (typeof value.toMap === 'function') value = value.toMap();
  if (value instanceof Map) {
    value.forEach(function (item, key) { pairs.push([String(key), __str(item)]); });
    return pairs;
  }
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    var entry = value[key];
    if (entry === null || entry === undefined || typeof entry === 'function') continue;
    pairs.push([key, String(entry)]);
  }
  return pairs;
}

/**
 * okhttp's Headers, which is also a plain object.
 *
 * Extensions read a header both ways — headers["Referer"] and headers.get(...)
 * — and the host wants a plain record, so the entries are own properties and
 * the methods are non-enumerable. Spreading or serialising one therefore gives
 * the headers and nothing else.
 */
/**
 * Whether a value is a Headers this runtime built, as opposed to a CacheControl
 * or a body in the same argument position. See '__k.okhttp'.
 */
function __isHeadersValue(value) {
  return (
    value !== null && typeof value === 'object' &&
    typeof value.names === 'function' && typeof value.newBuilder === 'function' &&
    typeof value.toMap === 'function'
  );
}

/**
 * The source's own 'headers', which a keiyoushi request helper reads off its
 * HttpSource context receiver when it is not handed any.
 *
 * Read through 'typeof' and a try because the instance is declared by the
 * entry point after this runtime, and a runtime evaluated on its own (as its
 * spec does) has no instance at all: that is the empty set, not a crash.
 */
function __sourceHeaders() {
  try {
    if (typeof __source !== 'undefined' && __source && __source.headers) return __source.headers;
  } catch (error) {
    /* Not constructed yet. */
  }
  return {};
}

function __headersObject(pairs) {
  var headers = {};
  for (var i = 0; i < pairs.length; i += 1) headers[pairs[i][0]] = pairs[i][1];

  function define(name, value) {
    Object.defineProperty(headers, name, { value: value, enumerable: false, writable: true });
  }
  define('get', function (name) {
    var wanted = String(name).toLowerCase();
    for (var j = 0; j < pairs.length; j += 1) {
      if (pairs[j][0].toLowerCase() === wanted) return pairs[j][1];
    }
    return null;
  });
  define('toMap', function () {
    var out = {};
    for (var j = 0; j < pairs.length; j += 1) out[pairs[j][0]] = pairs[j][1];
    return out;
  });
  define('names', function () {
    var out = [];
    for (var j = 0; j < pairs.length; j += 1) out.push(pairs[j][0]);
    return out;
  });
  define('newBuilder', function () { return __headersBuilder(pairs); });
  // okhttp's Headers is a Sequence of name/value Pairs, and extensions walk it:
  // 'for (cookie in response.headers)' is how a session cookie is collected off
  // a first request. A plain record is not iterable, so that was
  // '{} is not iterable' on the first search. Non-enumerable, so spreading or
  // serialising one still gives the headers and nothing else.
  define(Symbol.iterator, function () {
    var at = 0;
    return {
      next: function () {
        if (at >= pairs.length) return { done: true, value: undefined };
        var pair = pairs[at];
        at += 1;
        return { done: false, value: __k.to(pair[0], pair[1]) };
      }
    };
  });
  define('size', pairs.length);
  return headers;
}

function __headersBuilder(initial) {
  var pairs = __headerPairs(initial);
  var builder = {
    add: function (name, value) { pairs.push([String(name), __str(value)]); return builder; },
    set: function (name, value) {
      var wanted = String(name).toLowerCase();
      var kept = [];
      for (var i = 0; i < pairs.length; i += 1) {
        if (pairs[i][0].toLowerCase() !== wanted) kept.push(pairs[i]);
      }
      kept.push([String(name), __str(value)]);
      pairs = kept;
      return builder;
    },
    removeAll: function (name) {
      var wanted = String(name).toLowerCase();
      var kept = [];
      for (var i = 0; i < pairs.length; i += 1) {
        if (pairs[i][0].toLowerCase() !== wanted) kept.push(pairs[i]);
      }
      pairs = kept;
      return builder;
    },
    build: function () { return __headersObject(pairs); }
  };
  return builder;
}

var Headers = {
  Builder: function (initial) { return __headersBuilder(initial); },
  headersOf: function () {
    var pairs = [];
    for (var i = 0; i + 1 < arguments.length; i += 2) pairs.push([String(arguments[i]), __str(arguments[i + 1])]);
    return __headersObject(pairs);
  }
};

/**
 * keiyoushi.utils.commonEmptyHeaders, which the shared modules take as a
 * constructor default: 'class PlaylistUtils(client, headers: Headers =
 * commonEmptyHeaders)'. It is Headers.Builder().build() there, and a module
 * built without headers sends none of its own — the host's still apply.
 */
var commonEmptyHeaders = Headers.Builder().build();

var FormBody = {
  Builder: function () {
    var pairs = [];
    var builder = {
      add: function (name, value) { pairs.push([String(name), __str(value), false]); return builder; },
      // addEncoded names a pair that is ALREADY encoded — a request signature,
      // usually — so encoding it again would send the percent signs escaped and
      // the signature would not verify.
      addEncoded: function (name, value) { pairs.push([String(name), __str(value), true]); return builder; },
      build: function () {
        var parts = [];
        for (var i = 0; i < pairs.length; i += 1) {
          parts.push(
            pairs[i][2] === true
              ? pairs[i][0] + '=' + pairs[i][1]
              : encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1])
          );
        }
        return __requestBody('application/x-www-form-urlencoded; charset=utf-8', parts.join('&'));
      }
    };
    return builder;
  }
};

/**
 * A request body: its content type and the text the host transport sends.
 *
 * A constructor rather than a literal so every body answers okhttp's
 * 'contentLength()' — which the catalogue reads to write a Content-Length
 * header by hand — in BYTES, as okhttp counts it, rather than in characters.
 */
function __RequestBody(contentType, text) {
  this.__kBody = true;
  this.contentType = contentType;
  this.text = text;
}
__RequestBody.prototype.contentLength = function () {
  return __host().text.encode(__str(this.text)).length;
};

function __requestBody(contentType, text) {
  return new __RequestBody(contentType === undefined ? null : contentType, __str(text));
}

/** A body, whatever shape the extension built it in. */
function __bodyOf(body) {
  if (body === null || body === undefined) return null;
  if (body instanceof __RequestBody) return body;
  if (body.__kBody === true) return __requestBody(body.contentType, body.text);
  if (typeof body === 'string') return __requestBody(null, body);
  if (typeof body.text === 'string') return __requestBody(body.contentType || null, body.text);
  return __requestBody('application/json; charset=utf-8', JSON.stringify(body));
}

/**
 * okhttp's MultipartBody, for a form an extension posts the way a browser
 * would post a file-upload form: 'MultipartBody.Builder().setType(FORM)
 * .addFormDataPart("page", "2").build()'.
 *
 * The parts are text, because the host transport carries text. A part built
 * from bytes is taken when those bytes are UTF-8 — the same test a response
 * body gets in 'toResponseBody' — and refused by name when they are not,
 * rather than sent mangled.
 */
var MultipartBody = {
  FORM: 'multipart/form-data',
  MIXED: 'multipart/mixed',
  ALTERNATIVE: 'multipart/alternative',
  DIGEST: 'multipart/digest',
  PARALLEL: 'multipart/parallel',
  Builder: function (boundary) {
    var mark = boundary === undefined || boundary === null
      ? 'yorozo-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
      : __str(boundary);
    var type = 'multipart/mixed';
    var parts = [];
    function textOf(body) {
      if (body === null || body === undefined) return { type: null, text: '' };
      if (typeof body === 'string') return { type: null, text: body };
      var made = __bodyOf(body);
      return { type: made.contentType, text: made.text };
    }
    function quoted(value) { return __str(value).replace(/"/g, '%22').replace(/\\r/g, '%0D').replace(/\\n/g, '%0A'); }
    var builder = {
      setType: function (value) { type = __str(value); return builder; },
      addFormDataPart: function (name, a, b) {
        var disposition = 'form-data; name="' + quoted(name) + '"';
        if (b === undefined) {
          parts.push({ headers: ['Content-Disposition: ' + disposition], text: __str(a) });
          return builder;
        }
        if (a !== null && a !== undefined) disposition += '; filename="' + quoted(a) + '"';
        var body = textOf(b);
        var headers = ['Content-Disposition: ' + disposition];
        if (body.type !== null) headers.push('Content-Type: ' + body.type);
        parts.push({ headers: headers, text: body.text });
        return builder;
      },
      addPart: function (a, b) {
        var body = textOf(b === undefined ? a : b);
        var headers = [];
        if (b !== undefined && a !== null && a !== undefined) {
          __headerPairs(a).forEach(function (pair) { headers.push(pair[0] + ': ' + pair[1]); });
        }
        if (body.type !== null) headers.push('Content-Type: ' + body.type);
        parts.push({ headers: headers, text: body.text });
        return builder;
      },
      build: function () {
        if (parts.length === 0) throw new Error('Multipart body must have at least one part.');
        var text = '';
        for (var i = 0; i < parts.length; i += 1) {
          text += '--' + mark + '\\r\\n' + parts[i].headers.join('\\r\\n') + '\\r\\n\\r\\n' + parts[i].text + '\\r\\n';
        }
        text += '--' + mark + '--\\r\\n';
        return __requestBody(type + '; boundary=' + mark, text);
      }
    };
    return builder;
  }
};

/**
 * okhttp's Request.
 *
 * 'url' is an HttpUrl, as okhttp's is, and not the string it used to be here:
 * the catalogue reads 'response.request.url.pathSegments', '.fragment',
 * '.queryParameter("id")' and '.host' about six hundred times, and every one
 * of those was undefined on a string — a wrong value, with nothing refused. It
 * prints as exactly the text it was built from, so a template, a 'GET(…)' and
 * the host transport all see the same url they always did.
 *
 * 'tag' is okhttp's per-request label, which an extension sets on the request
 * and reads back off 'response.request' to know which of its requests this was.
 */
function __kRequest(method, url, headers, body, tags) {
  var request = {
    method: method,
    url: __urlOfRequest(url),
    headers: __headersObject(__headerPairs(headers)),
    body: __bodyOf(body)
  };
  var labels = tags === undefined || tags === null ? new Map() : tags;
  Object.defineProperty(request, '__tags', { value: labels, enumerable: false });
  Object.defineProperty(request, 'header', {
    value: function (name) { return request.headers.get(name); },
    enumerable: false
  });
  Object.defineProperty(request, 'tag', {
    value: function (type) { return __readTag(labels, type); },
    enumerable: false
  });
  Object.defineProperty(request, 'isHttps', {
    get: function () { return request.url.scheme === 'https'; },
    enumerable: false
  });
  Object.defineProperty(request, 'newBuilder', {
    value: function () { return __requestBuilder(request.method, request.url, request.headers, request.body, labels); },
    enumerable: false
  });
  return request;
}

function __urlOfRequest(value) {
  if (value !== null && value !== undefined && typeof value === 'object' && value.__kUrl === true) return value;
  var text = __str(value);
  return __httpUrlOf(text, true);
}

/*
 * A tag's key. okhttp keys a tag by its Class; 'String::class.java' reaches
 * here as whatever the emitter made of the class — a constructor or a name —
 * so the key is that value's own identity, and the untyped 'tag(value)' form
 * is keyed as Object, which is what okhttp does with it.
 */
var __OBJECT_TAG = { name: 'Object' };
function __readTag(labels, type) {
  var key = type === undefined ? __OBJECT_TAG : type;
  return labels.has(key) ? labels.get(key) : null;
}

function GET(url, headers, cache) { return __kRequest('GET', url, headers, null); }
function POST(url, headers, body, cache) { return __kRequest('POST', url, headers, body); }
function PUT(url, headers, body) { return __kRequest('PUT', url, headers, body); }
function DELETE(url, headers, body) { return __kRequest('DELETE', url, headers, body); }
function HEAD(url, headers) { return __kRequest('HEAD', url, headers, null); }

/**
 * okhttp's Request.Builder — for a request built from nothing, and for
 * 'request.newBuilder()', which is how an interceptor changes the request it
 * was handed before proceeding with it.
 *
 * The cache setting is the host's to decide (see CacheControl), so it is
 * accepted and changes nothing; everything else is carried.
 */
function __requestBuilder(method, url, headers, body, tags) {
  var labels = new Map(tags === undefined || tags === null ? [] : tags);
  var builder = {
    url: function (value) { url = value; return builder; },
    headers: function (value) { headers = value || {}; return builder; },
    header: function (name, value) {
      var wanted = String(name).toLowerCase();
      var next = __headerPairs(headers).filter(function (pair) { return pair[0].toLowerCase() !== wanted; });
      next.push([String(name), __str(value)]);
      headers = __headersObject(next);
      return builder;
    },
    addHeader: function (name, value) {
      var next = __headerPairs(headers);
      next.push([String(name), __str(value)]);
      headers = __headersObject(next);
      return builder;
    },
    removeHeader: function (name) {
      var wanted = String(name).toLowerCase();
      headers = __headersObject(__headerPairs(headers).filter(function (pair) {
        return pair[0].toLowerCase() !== wanted;
      }));
      return builder;
    },
    method: function (value, valueBody) {
      method = String(value).toUpperCase();
      body = valueBody === undefined ? null : valueBody;
      return builder;
    },
    get: function () { method = 'GET'; body = null; return builder; },
    head: function () { method = 'HEAD'; body = null; return builder; },
    post: function (value) { method = 'POST'; body = value; return builder; },
    put: function (value) { method = 'PUT'; body = value; return builder; },
    patch: function (value) { method = 'PATCH'; body = value; return builder; },
    delete: function (value) { method = 'DELETE'; body = value || null; return builder; },
    cacheControl: function () { return builder; },
    /* 'tag(value)', or 'tag(type, value)'; a null value removes the tag. */
    tag: function (a, b) {
      var key = b === undefined ? __OBJECT_TAG : a;
      var value = b === undefined ? a : b;
      if (value === null || value === undefined) labels.delete(key);
      else labels.set(key, value);
      return builder;
    },
    build: function () { return __kRequest(method, url, headers, body, labels); }
  };
  return builder;
}

/** okhttp's Request.Builder, for extensions that need a request body. */
var Request = {
  Builder: function () { return __requestBuilder('GET', '', {}, null, null); }
};

/**
 * The response, with its body already read.
 *
 * See the file header: everything an extension does with a response is
 * synchronous in Kotlin, and making any of it asynchronous here would spread
 * 'await' through arbitrary expression positions in the emitted code.
 */
function __responseOf(raw, text, request) {
  var finalUrl = __str(raw.url).length > 0 ? __str(raw.url) : __str(request.url);

  /*
   * okhttp's response.request is the request that PRODUCED this response — the
   * last one in a redirect chain, not the first. Handing back the original made
   * 'client.newCall(GET(url)).execute().request.url' answer the url the caller
   * already had, which is the one thing that expression is never asked for: it
   * is how this ecosystem resolves a redirect to its destination.
   */
  var finalRequest = finalUrl === __str(request.url)
    ? request
    : __kRequest(request.method, finalUrl, request.headers, request.body, request.__tags);

  /*
   * A body the host declined to read is not an empty body.
   *
   * The proxy caps what it will buffer, and a request whose redirect lands on a
   * video legitimately exceeds it. Answering '' there would tell an extension
   * the page was blank; it asks instead, and gets told why.
   */
  var unread = __str(raw.unread === undefined || raw.unread === null ? '' : raw.unread);
  function read() {
    if (unread.length > 0) {
      throw new Error('This source answered with a body this host did not read: ' + unread + '.');
    }
    return text;
  }

  var response = {
    code: raw.status,
    /* okhttp's reason phrase. HTTP/2 has none and okhttp answers '' there,
       which is also what a host that does not report one answers here. */
    message: __str(raw.message),
    isSuccessful: raw.status >= 200 && raw.status < 300,
    request: finalRequest,
    url: finalUrl,
    headers: __headersObject(__headerPairs(raw.headers)),
    /*
     * okhttp's 'response.header(name)' and 'header(name, default)': one header,
     * case-insensitively, or the default (null when none is given). The method
     * the request builder has always had, and the one an interceptor reads a
     * challenge off: 'response.header("Server") !in SERVER_CHECK'. Missing, that
     * line threw a TypeError out of the interceptor on every answer - a hoster
     * lost for a reason no refusal named.
     */
    header: function (name, fallback) {
      var value = response.headers.get(name);
      if (value !== null && value !== undefined) return value;
      return fallback === undefined ? null : fallback;
    },
    body: {
      string: function () { return read(); },
      bytes: function () { return __host().text.encode(read()); },
      // In bytes, which is what okhttp counts and what 'bytes()' answers.
      contentLength: function () { return __host().text.encode(read()).length; },
      /*
       * okhttp's ResponseBody.contentType(), which is the header verbatim.
       *
       * The comparison this ecosystem writes is
       * contentType() == "application/json".toMediaType(), and toMediaType is
       * the string and nothing more here — so a header reading
       * "application/json; charset=utf-8" is NOT equal to "application/json",
       * exactly as okhttp's own MediaType equality has it. Normalising the
       * charset away would answer a question the extension did not ask.
       */
      contentType: function () {
        // A body an interceptor built with 'toResponseBody(type)' carries its
        // own, as okhttp's does; the header is what it falls back on.
        if (raw.bodyType !== null && raw.bodyType !== undefined) return raw.bodyType;
        var headers = raw.headers || {};
        for (var key in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === 'content-type') {
            return headers[key];
          }
        }
        return null;
      },
      close: function () {},
      closeQuietly: function () {}
    },
    /**
     * Parsed against the FINAL url, so that attr("abs:href") is right after a
     * redirect. Parsing against the requested url instead yields links that are
     * absolute, plausible and wrong.
     */
    asJsoup: function (html) {
      return __parseDoc(html === undefined || html === null ? read() : String(html), finalUrl);
    },
    parseAs: function (descriptor) { return __k.decode(descriptor, read()); },
    /*
     * okhttp's 'peekBody(byteCount)': at most that many BYTES of the body,
     * without consuming it. The whole body was read already, so peeking costs
     * nothing — but the limit is honoured, because a check written as
     * 'peekBody(15).string() == "<!DOCTYPE html>"' is asking about the first
     * fifteen bytes and nothing past them.
     */
    peekBody: function (byteCount) {
      var limit = Number(byteCount);
      var whole = read();
      var text = whole;
      if (Number.isFinite(limit) && limit >= 0 && limit < whole.length * 4) {
        var bytes = __host().text.encode(whole);
        if (limit < bytes.length) text = __host().text.decode(bytes.slice(0, limit));
      }
      return {
        string: function () { return text; },
        bytes: function () { return __host().text.encode(text); },
        contentLength: function () { return __host().text.encode(text).length; },
        contentType: function () { return response.body.contentType(); },
        close: function () {},
        closeQuietly: function () {}
      };
    },
    close: function () {},
    /* okhttp's 'Response.closeQuietly()' — the same nothing as 'close', since
       the host buffered the body before this object existed. */
    closeQuietly: function () {},
    /*
     * 'response.newBuilder().body(…).build()', which is how an interceptor
     * replaces what it was handed — the decrypting image interceptors in this
     * ecosystem all end on this line.
     *
     * The body is taken as text, because that is the only shape this runtime
     * has: the host read the whole response before the plugin saw it, and
     * '__responseOf' is built around that. A builder that accepted a stream
     * would be accepting something nothing downstream could read.
     */
    newBuilder: function () {
      var nextCode = raw.status;
      var nextMessage = raw.message;
      var nextHeaders = raw.headers;
      var nextText = null;
      var nextType = raw.bodyType;
      var made = {
        code: function (value) { nextCode = Number(value); return made; },
        message: function (value) { nextMessage = __str(value); return made; },
        request: function () { return made; },
        protocol: function () { return made; },
        header: function (name, value) {
          var pairs = __headerPairs(nextHeaders);
          var kept = [];
          for (var i = 0; i < pairs.length; i += 1) {
            if (String(pairs[i][0]).toLowerCase() !== String(name).toLowerCase()) kept.push(pairs[i]);
          }
          kept.push([String(name), __str(value)]);
          nextHeaders = __headersObject(kept);
          return made;
        },
        addHeader: function (name, value) {
          var pairs = __headerPairs(nextHeaders);
          pairs.push([String(name), __str(value)]);
          nextHeaders = __headersObject(pairs);
          return made;
        },
        removeHeader: function (name) {
          var pairs = __headerPairs(nextHeaders);
          var kept = [];
          for (var i = 0; i < pairs.length; i += 1) {
            if (String(pairs[i][0]).toLowerCase() !== String(name).toLowerCase()) kept.push(pairs[i]);
          }
          nextHeaders = __headersObject(kept);
          return made;
        },
        headers: function (value) { nextHeaders = value || {}; return made; },
        /* What 'toResponseBody' built, another response's 'body', or text. A
           body object stringified would be '[object Object]' on the page. */
        body: function (value) {
          if (value === null || value === undefined) nextText = '';
          else if (value.__kBody === true) {
            nextText = __str(value.text);
            if (value.contentType !== null && value.contentType !== undefined) nextType = __str(value.contentType);
          } else if (typeof value.string === 'function') nextText = __str(value.string());
          else nextText = __str(value);
          return made;
        },
        build: function () {
          var next = Object.assign({}, raw, {
            status: nextCode,
            message: nextMessage,
            headers: nextHeaders,
            bodyType: nextType
          });
          return __responseOf(next, nextText === null ? text : nextText, request);
        }
      };
      return made;
    },
    use: function (block) { return block(response); }
  };
  return response;
}

async function __execute(request, follow) {
  // Before the request rather than at declaration time: '.rateLimit(...)' is
  // written in a property initialiser, which may run outside a plugin call
  // where there is no ctx to declare against. Cheap — a version comparison —
  // and it is the one place every converted request passes through.
  __syncPolicy();
  var headers = typeof request.headers.toMap === 'function'
    ? request.headers.toMap()
    : request.headers;
  var body = request.body;
  if (body !== null && body.contentType !== null && !__hasHeader(headers, 'content-type')) {
    headers = Object.assign({}, headers);
    headers['Content-Type'] = body.contentType;
  }
  var options = {
    method: request.method,
    headers: headers,
    body: body === null ? null : body.text
  };
  // Sent only when the extension turned redirects off. An absent flag is the
  // host's default, and restating it on every request would make that default
  // this runtime's business rather than the host's — see ABI.md, 'follow:
  // false — reading a redirect instead of taking it'.
  if (follow === false) options.follow = false;
  var raw = await __host().http.send(__str(request.url), options);
  return __responseOf(raw, await raw.text(), request);
}

/**
 * The marker '__k.jump' throws; see it for why this is not an Error.
 *
 * A plain constructor rather than a class extending Error: a converted
 * extension that writes 'catch (e: Exception)' around a block containing a
 * non-local return would otherwise swallow the jump and answer the wrong
 * value. Nothing here is an Error, so nothing catches it by type.
 */
function __Jump(id, value) {
  this.id = id;
  this.value = value;
}

function __hasHeader(headers, name) {
  for (var key in headers) {
    if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === name) return true;
  }
  return false;
}

/**
 * A NETWORK interceptor is refused, loudly. An application interceptor is not
 * — see '__proceed', which runs the chain.
 *
 * The two are not the same hook. An application interceptor wraps one call and
 * is handed the request and the response, both of which this runtime has. A
 * network interceptor sits between the client and each individual hop of a
 * redirect chain, and sees the raw connection: the host follows redirects
 * itself and reports only the destination, so there is nothing here for one to
 * sit between. Accepting it and running it once over the final hop would leave
 * an extension believing it had rewritten every hop when it had rewritten one.
 */
function __noInterceptor(name) {
  return function () {
    throw new Error(
      'This converted extension installs an okhttp ' + name + '. Yorozo lets the host follow ' +
      'redirects and reports only where they ended, so there are no per-hop connections for a ' +
      'network interceptor to wrap. An ordinary addInterceptor { } does run.'
    );
  };
}

/**
 * okhttp's CookieJar, as much of it as the host can honour.
 *
 * The host keeps a per-plugin, per-host, in-memory jar and attaches it to every
 * request on the way out (ADR-0005 section 3). So an extension that installs a
 * jar is asking for behaviour it already has, and the two halves of the
 * interface land in very different places:
 *
 * - 'saveFromResponse' is an acknowledgement. The host absorbed the response's
 *   'Set-Cookie' headers before the response reached the extension, so there is
 *   nothing left to do and doing nothing is correct rather than a shortcut.
 * - 'loadForRequest' hands the caller the cookies. That is the one thing the
 *   design forbids: the host carries the state and the extension never reads
 *   it, so a plugin cannot enumerate cookies for a host it did not set them on.
 *   It is refused at conversion by name; this thrower is the floor under that,
 *   for a route into it nobody has thought of yet.
 */
var __cookieJar = {
  saveFromResponse: function () {},
  loadForRequest: function () {
    throw new Error(
      'This converted extension reads its own cookie jar. Yorozo holds the cookies host-side ' +
      'and attaches them itself, and does not hand them to plugin code, so the extension can ' +
      'be converted but not run as written.'
    );
  }
};

/**
 * A builder, whose one load-bearing setting is the redirect policy.
 *
 * Timeouts belong to the host's transport: accepting them changes nothing an
 * extension can observe, and refusing them would fail extensions that set one
 * idly and never depend on it. 'followRedirects(false)' is not like that. The
 * extension that turns it off does so BECAUSE the 3xx is the answer — it asks a
 * source which server holds an episode and reads the embed out of 'Location'.
 * Following it consumes that answer and hands back the page it pointed at, so a
 * builder that accepted the flag and dropped it would report a source that had
 * changed. The flag is therefore carried into the request, where ctx.http turns
 * it into the host's 'follow: false'.
 */
function __clientBuilder(follow, inherited, inheritedCookies) {
  var redirects = follow;
  var chain = (inherited || []).slice();
  var cookies = (inheritedCookies || []).slice();
  var builder = {
    /*
     * keiyoushi's 'addCookie', which is how an age gate or a reading mode is
     * switched on: 'addCookie("is_mature" to "true")'. Upstream installs a
     * NETWORK interceptor that writes a Cookie header on every request to the
     * source's host (or the domain given), merging with one already there —
     * and also writes the cookie into Android's shared CookieManager.
     *
     * The header is what this does, and it is a request header the plugin
     * sets on its own requests: nothing here reads a jar. The CookieManager
     * write is not done and cannot be: it is the host's store, which ADR-0005
     * keeps out of a plugin's reach in both directions, and what it bought
     * upstream was the cookie on requests the plugin does not make — a
     * WebView, the app's own image loader. Those are the host's here.
     *
     * The domain is resolved per request, as upstream resolves it, so a
     * source whose base url is a preference follows the preference.
     */
    addCookie: function (a, b) {
      if (b === undefined) cookies.push({ domain: null, cookies: a });
      else cookies.push({ domain: a, cookies: b });
      return builder;
    },
    /* Kept in written order, which is the order okhttp runs them in: the first
       one added is the outermost, and it sees the request before the ones
       after it and the response after them. */
    addInterceptor: function (interceptor) {
      if (interceptor === null || interceptor === undefined) return builder;
      if (typeof interceptor !== 'function' && typeof interceptor.intercept !== 'function') {
        throw new Error(
          'This converted extension installed something as an okhttp interceptor that has no ' +
          'intercept(chain).'
        );
      }
      chain.push(interceptor);
      return builder;
    },
    addNetworkInterceptor: __noInterceptor('network interceptor'),
    connectTimeout: function () { return builder; },
    readTimeout: function () { return builder; },
    writeTimeout: function () { return builder; },
    callTimeout: function () { return builder; },
    connectionPool: function () { return builder; },
    // 'protocols(listOf(Protocol.HTTP_1_1))' pins HTTP/1.1, usually to make a
    // chunked player endpoint behave. The browser and the native host both
    // negotiate their own version and neither exposes the choice, so this is
    // configuration with nothing here to configure — recorded as inert for the
    // same reason the timeouts are: refusing it would lose an extension over a
    // line that changes nothing.
    protocols: function () { return builder; },
    followRedirects: function (allowed) { redirects = allowed !== false; return builder; },
    // The SSL variant is about an https-to-http downgrade during a walk the
    // host does not expose, so there is nothing here for it to change.
    followSslRedirects: function () { return builder; },
    // 'cookieJar(jar)' says "carry cookies on this client". A plugin holding
    // the 'cookies' permission has a host-side jar on every request it makes,
    // so the setting is already true; a jar with logic of its own never reaches
    // here, because conversion refuses it. See __cookieJar.
    cookieJar: function () { return builder; },
    retryOnConnectionFailure: function () { return builder; },
    build: function () {
      /* The shared client only when nothing was changed: an extension that
         built one to install an interceptor must not get the one everything
         else uses. */
      if (redirects !== false && chain.length === 0 && cookies.length === 0) return client;
      return __clientWith(redirects !== false, chain, cookies);
    }
  };
  return builder;
}

/**
 * The okhttp *application* interceptor chain, run inside the sandbox.
 *
 * What an application interceptor does is wrap one call: it is handed the
 * request, may rewrite it, calls 'proceed', and may inspect or replace what
 * comes back. None of that needs the transport — 'proceed' at the end of the
 * chain is this runtime's own send — so the chain runs here, in the plugin's
 * own module, with exactly the reach the plugin already had.
 *
 * Two things are still refused rather than approximated, and both are about
 * what the host owns rather than about difficulty:
 *
 * - **A network interceptor** sits between the client and each individual
 *   redirect hop. The host follows redirects itself and reports only where it
 *   ended up, so there are no hops here to sit between.
 * - **A streaming body.** The host buffers the whole response before a plugin
 *   sees it, so an interceptor that wraps the source of a body rather than its
 *   bytes has nothing to wrap.
 */
async function __proceed(request, chain, index, follow, cookies) {
  // A request a suspending member built — 'pageListRequest' that fetched a
  // page to find an id first — arrives as a promise of one. Kotlin would
  // have finished building it before the call; so does this.
  if (__thenable(request)) request = await request;
  if (index >= chain.length) return await __execute(__withCookies(request, cookies), follow);
  var interceptor = chain[index];
  var link = {
    request: function () { return request; },
    proceed: function (next) { return __proceed(next, chain, index + 1, follow, cookies); },
    /* okhttp hands the chain the call and the connection. The call is the
       request this one is wrapping; there is no connection, and a source that
       asks for one is asking about a socket this build does not have. */
    call: function () { return { request: function () { return request; }, cancel: function () {} }; },
    connection: function () { return null; },
    /* The per-call timeout setters, which answer the chain so the fluent form
       keeps working. Timeouts belong to the host's transport — see
       '__clientBuilder' for why accepting one and not acting on it is right. */
    withConnectTimeout: function () { return link; },
    withReadTimeout: function () { return link; },
    withWriteTimeout: function () { return link; },
    readTimeoutMillis: function () { return 0; },
    connectTimeoutMillis: function () { return 0; },
    writeTimeoutMillis: function () { return 0; }
  };
  /* 'addInterceptor { chain -> … }' is Kotlin's SAM form and arrives as a
     function; 'addInterceptor(MyInterceptor())' arrives as an object with the
     member the interface names. Both are the same one call. */
  var run = typeof interceptor === 'function' ? interceptor : interceptor.intercept;
  var answer = await run.call(interceptor, link);
  if (answer === null || answer === undefined) {
    throw new Error('This converted extension has an interceptor that returned no response.');
  }
  return answer;
}

/**
 * The Cookie header 'addCookie' asks for, merged into a request the way
 * upstream's CookieInterceptor merges it: the first rule whose domain matches
 * the request's host (or a subdomain of it) wins; a cookie already on the
 * request under the same name is replaced; and a request already carrying all
 * of them is sent unchanged.
 */
function __withCookies(request, rules) {
  if (rules === undefined || rules === null || rules.length === 0) return request;
  var host = request.url.host;
  var chosen = null;
  for (var i = 0; i < rules.length && chosen === null; i += 1) {
    var domain = rules[i].domain === null ? __sourceHost() : __str(rules[i].domain());
    if (host === domain || host.endsWith('.' + domain)) chosen = __cookiePairs(rules[i].cookies);
  }
  if (chosen === null) return request;
  var existing = __str(request.headers.get('Cookie'));
  var written = existing.length === 0 ? [] : existing.split('; ');
  var wanted = chosen.map(function (pair) { return pair[0] + '=' + pair[1]; });
  if (wanted.every(function (one) { return written.indexOf(one) !== -1; })) return request;
  var kept = written.filter(function (one) {
    return !chosen.some(function (pair) { return one.indexOf(pair[0] + '=') === 0; });
  });
  return request.newBuilder().header('Cookie', kept.concat(wanted).join('; ')).build();
}

/** A Pair, a list of Pairs, or a function answering either — as name/value rows. */
function __cookiePairs(value) {
  var given = typeof value === 'function' ? value() : value;
  if (given === null || given === undefined) return [];
  var list = Array.isArray(given) && given.first !== undefined ? [given] : __arr(given);
  return list.map(function (pair) {
    return Array.isArray(pair) ? [__str(pair[0]), __str(pair[1])] : [__str(pair.first), __str(pair.second)];
  });
}

/*
 * The host of the source the bundle serves — upstream's 'source.baseUrl',
 * read when a request is made rather than when the client is built, because a
 * property initialiser runs before the entry has finished constructing it.
 */
function __sourceHost() {
  var base = null;
  try {
    base = typeof __source === 'undefined' || __source === null ? null : __source.baseUrl;
  } catch (error) {
    base = null;
  }
  if ((base === null || base === undefined) && typeof __BASE_URL !== 'undefined') base = __BASE_URL;
  if (base === null || base === undefined) {
    throw new Error('This converted extension set a cookie for its own site, and has no base url to take the site from.');
  }
  return __httpUrlOf(__str(base)).host;
}

/** A client, and the redirect policy every call it makes carries. */
function __clientWith(follow, interceptors, cookieRules) {
  var chain = interceptors || [];
  var cookies = cookieRules || [];
  var made = {
    interceptors: chain,
    newCall: function (request) {
      return {
        execute: function () { return __proceed(request, chain, 0, follow, cookies); },
        await: function () { return __proceed(request, chain, 0, follow, cookies); },
        /* The Rx-era doors onto the same two calls. 238 members in one
           catalogue are written as
           'client.newCall(r).asObservableSuccess().map { … }', so these are
           the entry point for most of this ecosystem's older half. */
        asObservable: function () { return __observable(__proceed(request, chain, 0, follow, cookies)); },
        asObservableSuccess: function () { return __observable(this.awaitSuccess()); },
        awaitSuccess: async function () {
          var response = await __proceed(request, chain, 0, follow, cookies);
          if (!response.isSuccessful) {
            throw new Error('This source answered ' + response.code + ' for ' + request.url + '.');
          }
          return response;
        },
        enqueue: function () {
          throw new Error('This converted extension enqueued a request; Yorozo only executes them.');
        },
        cancel: function () {},
        stop: function () {}
      };
    },
    newBuilder: function () { return __clientBuilder(follow, chain, cookies); },
    cookieJar: __cookieJar
  };
  return made;
}

var client = __clientWith(true);

/** What an extension reaches through in Kotlin, pointing at the same client. */
var network = {
  client: client,
  cloudflareClient: client
};

/* --- HttpUrl -------------------------------------------------------------- */

/**
 * okhttp's HttpUrl, parsed by hand rather than by URL.
 *
 * 'URL' is not in the engine subset's guaranteed set (ABI.md section 6 lists
 * what a QuickJS build routinely omits, and this is the same class of risk), so
 * a search url built through it would work in a browser and throw on a phone.
 *
 * Query parts are kept **as written**. Decoding and re-encoding them looks
 * harmless and is not: a '+' that meant a plus comes back as '%2B', and a token
 * a source signed stops verifying. Only parameters this builder adds are
 * encoded, because only those arrived as plain text.
 */
function __httpUrlOf(value, keepText) {
  var text = __str(value);
  var parts = /^([a-zA-Z][a-zA-Z0-9+.-]*:)?(\\/\\/[^/?#]*)?([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(text);
  var scheme = parts[1] === undefined ? '' : parts[1];
  var authority = parts[2] === undefined ? '' : parts[2];
  var path = parts[3] === undefined ? '' : parts[3];
  var query = parts[4] === undefined ? '' : parts[4].slice(1);
  var fragment = parts[5] === undefined ? '' : parts[5];

  var pairs = [];
  if (query.length > 0) {
    var written = query.split('&');
    for (var i = 0; i < written.length; i += 1) {
      if (written[i].length === 0) continue;
      var at = written[i].indexOf('=');
      if (at === -1) pairs.push([written[i], null]);
      else pairs.push([written[i].slice(0, at), written[i].slice(at + 1)]);
    }
  }

  return __httpUrlValue(scheme, authority, path, pairs, fragment, keepText === true ? text : null);
}

/*
 * The parts of an authority: 'user:pass@host:port'. okhttp spells the default
 * port for the scheme when none is written.
 */
function __authorityParts(scheme, authority) {
  var bare = authority.replace(/^\\/\\//, '');
  var at = bare.lastIndexOf('@');
  var userinfo = at === -1 ? '' : bare.slice(0, at);
  var hostport = at === -1 ? bare : bare.slice(at + 1);
  var port = /:([0-9]+)$/.exec(hostport);
  var colon = userinfo.indexOf(':');
  var named = scheme.replace(/:$/, '').toLowerCase();
  return {
    user: colon === -1 ? userinfo : userinfo.slice(0, colon),
    password: colon === -1 ? '' : userinfo.slice(colon + 1),
    host: port === null ? hostport : hostport.slice(0, port.index),
    port: port === null ? (named === 'https' ? 443 : (named === 'http' ? 80 : -1)) : Number(port[1]),
    written: port !== null
  };
}

function __httpUrlValue(scheme, authority, path, pairs, fragment, original) {
  function decode(part) {
    try {
      return decodeURIComponent(String(part).replace(/\\+/g, ' '));
    } catch (error) {
      return String(part);
    }
  }

  var url = {
    scheme: scheme.replace(/:$/, ''),
    // okhttp exposes the fragment, and this ecosystem carries a second id in
    // one: '/play/<vid>#<cid>' is an extension packing both halves of what its
    // playlist endpoint needs into the url it stores. Absent, the request went
    // out with an empty 'cid' and the source answered 63 bytes.
    fragment: fragment.replace(/^#/, '') || null,
    encodedFragment: fragment.replace(/^#/, '') || null,
    __kUrl: true,
    host: __authorityParts(scheme, authority).host,
    port: __authorityParts(scheme, authority).port,
    username: decode(__authorityParts(scheme, authority).user),
    password: decode(__authorityParts(scheme, authority).password),
    encodedUsername: __authorityParts(scheme, authority).user,
    encodedPassword: __authorityParts(scheme, authority).password,
    isHttps: scheme.replace(/:$/, '').toLowerCase() === 'https',
    encodedPath: path,
    // okhttp keeps an empty last segment ('/a/' is ['a', '']) — pathSize and
    // removePathSegment count it — but this runtime has always answered the
    // segments WITHOUT empties, and the catalogue reads '.last()' of them to
    // mean the last real one. That reading is kept; pathSize follows it.
    pathSegments: path.split('/').filter(function (segment) { return segment.length > 0; }),
    encodedPathSegments: path.split('/').filter(function (segment) { return segment.length > 0; }),
    pathSize: path.split('/').filter(function (segment) { return segment.length > 0; }).length,
    // android.net.Uri's readers, over the same parse: 'Uri.parse(u).path'.
    path: decode(path.replace(/\\+/g, '%2B')),
    lastPathSegment: (function () {
      var segments = path.split('/').filter(function (segment) { return segment.length > 0; });
      return segments.length === 0 ? null : decode(segments[segments.length - 1].replace(/\\+/g, '%2B'));
    }()),
    authority: authority.replace(/^\\/\\//, '') || null,
    encodedQuery: pairs.length === 0 && original === null ? null : __joinQuery(pairs),
    query: pairs.length === 0 && original === null ? null : pairs.map(function (pair) {
      return pair[1] === null ? decode(pair[0]) : decode(pair[0]) + '=' + decode(pair[1]);
    }).join('&'),
    querySize: pairs.length,
    queryParameterValues: function (name) {
      var values = [];
      for (var i = 0; i < pairs.length; i += 1) {
        if (decode(pairs[i][0]) === String(name)) values.push(pairs[i][1] === null ? null : decode(pairs[i][1]));
      }
      return values;
    },
    queryParameterName: function (index) { return decode(pairs[Number(index)][0]); },
    queryParameterValue: function (index) {
      var value = pairs[Number(index)][1];
      return value === null ? null : decode(value);
    },
    queryParameter: function (name) {
      for (var i = 0; i < pairs.length; i += 1) {
        if (decode(pairs[i][0]) === String(name)) return pairs[i][1] === null ? null : decode(pairs[i][1]);
      }
      return null;
    },
    queryParameterNames: function () {
      var names = [];
      for (var i = 0; i < pairs.length; i += 1) names.push(decode(pairs[i][0]));
      return names;
    },
    /* Exactly the text it was parsed from, when it was parsed from one: a
       request's url prints as the url the extension wrote, byte for byte. */
    toString: function () {
      if (original !== null && original !== undefined) return original;
      var written = __joinQuery(pairs);
      return scheme + authority + path + (written.length > 0 ? '?' + written : '') + fragment;
    }
  };
  // If the query was '?' with nothing after it, the parse has no pairs but
  // okhttp's encodedQuery is '' rather than null.
  if (original !== null && original !== undefined && url.encodedQuery !== null && original.indexOf('?') === -1) {
    url.encodedQuery = null;
    url.query = null;
  }
  url.newBuilder = function () { return __httpUrlBuilder(scheme, authority, path, pairs.slice(), fragment); };
  // android.net.Uri's name for the same builder.
  url.buildUpon = url.newBuilder;
  url.getQueryParameters = url.queryParameterValues;
  return url;
}

function __joinQuery(pairs) {
  var written = [];
  for (var i = 0; i < pairs.length; i += 1) {
    written.push(pairs[i][1] === null ? pairs[i][0] : pairs[i][0] + '=' + pairs[i][1]);
  }
  return written.join('&');
}

function __httpUrlBuilder(scheme, authority, path, pairs, fragment) {
  function encode(value) { return encodeURIComponent(__str(value)); }
  /* A whole query written as text: '&' and '=' stay separators, and what a
     query may not carry is escaped — '#', a space — while an escape already
     in it is left as written. */
  function canonical(value) {
    return __str(value).replace(/[^A-Za-z0-9\\-._~!$&'()*+,;=:@/?%]/g, function (ch) {
      return encodeURIComponent(ch);
    }).replace(/%(?![0-9A-Fa-f]{2})/g, '%25');
  }
  function splitQuery(text) {
    var out = [];
    var written = __str(text).split('&');
    for (var i = 0; i < written.length; i += 1) {
      var at = written[i].indexOf('=');
      if (at === -1) out.push([written[i], null]);
      else out.push([written[i].slice(0, at), written[i].slice(at + 1)]);
    }
    return out;
  }
  function segments() { return path.split('/').filter(function (segment) { return segment.length > 0; }); }
  function authorityOf(parts) {
    var userinfo = parts.user.length === 0 ? '' : parts.user + (parts.password.length === 0 ? '' : ':' + parts.password) + '@';
    var named = scheme.replace(/:$/, '').toLowerCase();
    var standard = (named === 'https' && parts.port === 443) || (named === 'http' && parts.port === 80);
    return '//' + userinfo + parts.host + (parts.port === -1 || standard ? '' : ':' + parts.port);
  }

  var builder = {
    /* okhttp's setters for the parts before the path. */
    scheme: function (value) {
      var next = __str(value).toLowerCase();
      if (next !== 'http' && next !== 'https') throw new Error('unexpected scheme: ' + next);
      scheme = next + ':';
      return builder;
    },
    host: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.host = __str(value);
      authority = authorityOf(parts);
      return builder;
    },
    port: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.port = Number(value);
      authority = authorityOf(parts);
      return builder;
    },
    username: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.user = encode(value);
      authority = authorityOf(parts);
      return builder;
    },
    password: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.password = encode(value);
      authority = authorityOf(parts);
      return builder;
    },
    encodedUsername: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.user = __str(value);
      authority = authorityOf(parts);
      return builder;
    },
    encodedPassword: function (value) {
      var parts = __authorityParts(scheme, authority);
      parts.password = __str(value);
      authority = authorityOf(parts);
      return builder;
    },
    /* 'encodedPath("/a/b")' replaces the whole path; okhttp insists on the
       leading slash, and so does this rather than guessing where it went. */
    encodedPath: function (value) {
      var next = __str(value);
      if (next.charAt(0) !== '/') throw new Error('unexpected encodedPath: ' + next);
      path = next;
      return builder;
    },
    /* 'removePathSegment(i)': the i-th segment gone, and '/' left when it was
       the only one — okhttp's. */
    removePathSegment: function (index) {
      var kept = segments();
      var at = Number(index);
      if (!(at >= 0 && at < kept.length)) throw new Error('This converted extension removed path segment ' + at + ' of ' + kept.length + '.');
      kept.splice(at, 1);
      path = '/' + kept.join('/');
      return builder;
    },
    /* 'query(text)' and 'encodedQuery(text)' replace the whole query; null
       removes it. The first escapes what a query cannot carry, the second
       takes the text as already escaped. */
    query: function (value) {
      pairs = value === null || value === undefined ? [] : splitQuery(canonical(value));
      return builder;
    },
    encodedQuery: function (value) {
      pairs = value === null || value === undefined ? [] : splitQuery(value);
      return builder;
    },
    setEncodedQueryParameter: function (name, value) {
      builder.removeAllEncodedQueryParameters(name);
      return builder.addEncodedQueryParameter(name, value);
    },
    removeAllEncodedQueryParameters: function (name) {
      var wanted = __str(name);
      pairs = pairs.filter(function (pair) { return pair[0] !== wanted; });
      return builder;
    },
    encodedFragment: function (value) {
      fragment = value === null || value === undefined ? '' : '#' + __str(value);
      return builder;
    },
    /* android.net.Uri.Builder, over the same parts: 'Uri.parse(u).buildUpon()
       .appendQueryParameter("s", q)'. Uri.encode and encodeURIComponent leave
       the same characters alone. */
    appendQueryParameter: function (name, value) {
      pairs.push([encode(name), value === null || value === undefined ? 'null' : encode(value)]);
      return builder;
    },
    appendPath: function (segment) {
      path = path.replace(/\\/$/, '') + '/' + encode(segment);
      return builder;
    },
    appendEncodedPath: function (segment) {
      var written = __str(segment);
      path = path.replace(/\\/$/, '') + '/' + written.replace(/^\\//, '');
      return builder;
    },
    path: function (value) {
      path = __str(value).split('/').map(encode).join('/');
      return builder;
    },
    clearQuery: function () { pairs = []; return builder; },
    authority: function (value) { authority = '//' + encode(value).replace(/%3A/gi, ':').replace(/%40/g, '@'); return builder; },
    encodedAuthority: function (value) { authority = '//' + __str(value); return builder; },
    addQueryParameter: function (name, value) {
      pairs.push([encode(name), value === null || value === undefined ? null : encode(value)]);
      return builder;
    },
    addEncodedQueryParameter: function (name, value) {
      pairs.push([__str(name), value === null || value === undefined ? null : __str(value)]);
      return builder;
    },
    setQueryParameter: function (name, value) {
      builder.removeAllQueryParameters(name);
      return builder.addQueryParameter(name, value);
    },
    removeAllQueryParameters: function (name) {
      var wanted = encode(name);
      var kept = [];
      for (var i = 0; i < pairs.length; i += 1) if (pairs[i][0] !== wanted) kept.push(pairs[i]);
      pairs = kept;
      return builder;
    },
    addPathSegment: function (segment) {
      path = path.replace(/\\/$/, '') + '/' + encode(segment);
      return builder;
    },
    addEncodedPathSegment: function (segment) {
      path = path.replace(/\\/$/, '') + '/' + __str(segment);
      return builder;
    },
    addPathSegments: function (segments) {
      var written = __str(segments).split('/');
      for (var i = 0; i < written.length; i += 1) {
        if (written[i].length > 0) builder.addPathSegment(written[i]);
      }
      return builder;
    },
    /* The already-encoded pair of the two above: a path this source composed
       itself, where re-encoding would turn its separators into '%2F'. */
    addEncodedPathSegments: function (segments) {
      var written = __str(segments).split('/');
      for (var i = 0; i < written.length; i += 1) {
        if (written[i].length > 0) builder.addEncodedPathSegment(written[i]);
      }
      return builder;
    },
    /* 'setPathSegment(i, value)' rewrites one segment in place, which is how a
       source turns a chapter url into its page url. */
    setPathSegment: function (index, value) {
      var written = path.split('/');
      // The leading '' from the opening slash is not a segment.
      var at = Number(index) + 1;
      if (at > 0 && at < written.length) written[at] = encode(value);
      path = written.join('/');
      return builder;
    },
    setEncodedPathSegment: function (index, value) {
      var written = path.split('/');
      var at = Number(index) + 1;
      if (at > 0 && at < written.length) written[at] = __str(value);
      path = written.join('/');
      return builder;
    },
    fragment: function (value) {
      fragment = value === null || value === undefined ? '' : '#' + __str(value);
      return builder;
    },
    build: function () { return __httpUrlValue(scheme, authority, path, pairs, fragment); },
    toString: function () { return builder.build().toString(); }
  };
  return builder;
}

/**
 * okhttp's HttpUrl, by name — for 'HttpUrl.Builder()', a url built from
 * nothing: '.scheme("https").host("…").addPathSegments(…)…build()'. The
 * builder is the one 'newBuilder()' answers, started empty, and 'build()'
 * throws as okhttp's does when the scheme or the host was never set, rather
 * than answering a url with neither.
 */
var HttpUrl = {
  Builder: function () {
    var builder = __httpUrlBuilder('', '', '/', [], '');
    var complete = builder.build;
    builder.build = function () {
      var built = complete();
      if (built.scheme.length === 0) throw new Error('This converted extension built a url with no scheme.');
      if (built.host.length === 0) throw new Error('This converted extension built a url with no host.');
      return built;
    };
    return builder;
  }
};

/**
 * 'response.body.string()', which this ecosystem writes as one call.
 *
 * Total over what it may be handed: the response, its body, or a string an
 * extension already pulled out — because the emitter writes the same helper
 * wherever the Kotlin wrote the same extension function.
 */
/**
 * okhttp's "…".toMediaType(), which is the string and nothing more here.
 *
 * A MediaType in okhttp parses into type, subtype and parameters; nothing in a
 * converted extension reads those back — the value goes straight into a
 * Content-Type header — so it stays the text the extension wrote. Parsing and
 * re-serialising it would be a chance to change a charset nobody asked to
 * change. 'toMediaTypeOrNull' is the same call; the shim never fails to parse.
 */
__k.toMediaType = function (value) { return __str(value); };

/**
 * String.toRequestBody(contentType), as the body shape __bodyOf understands.
 *
 * The content type must survive: '__execute' only sets a Content-Type header
 * when the body carries one, and a form body posted without
 * 'application/x-www-form-urlencoded' is read by the far end as something else
 * — which comes back as an empty result rather than as an error.
 *
 * The host's transport takes text, so a ByteArray body is decoded as UTF-8. A
 * binary body cannot be sent through it at all, and one that is not UTF-8
 * would be corrupted silently, so that is refused by name instead.
 */
__k.toRequestBody = function (value, contentType) {
  var type = contentType === undefined || contentType === null ? null : __str(contentType);
  if (typeof value === 'string' || value === null || value === undefined) {
    return __requestBody(type, __str(value));
  }
  if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) {
    return __requestBody(type, __host().text.decode(value));
  }
  throw new Error(
    'This converted extension built a request body out of something Yorozo cannot send as text. ' +
    'The host transport carries a string, so a binary body has no faithful spelling here.'
  );
};

/**
 * String.toResponseBody(contentType) and ByteArray.toResponseBody(…), which is
 * what an interceptor hands 'response.newBuilder().body(…)' when it replaces
 * what came back — an empty page for a search that answered 404, or a payload
 * it decrypted.
 *
 * A response here is text: the host read the whole body before the plugin saw
 * it, and every reader downstream ('string()', 'asJsoup()', 'parseAs()') reads
 * text. So bytes are decoded as UTF-8, and only when they ARE UTF-8 — checked
 * by encoding them back. An image an interceptor descrambled is not text, and
 * decoding it would hand 'bytes()' something that merely looks like the image;
 * that is refused at the point it happens rather than corrupted quietly.
 */
__k.toResponseBody = function (value, contentType) {
  var type = contentType === undefined || contentType === null ? null : __str(contentType);
  if (typeof value === 'string' || value === null || value === undefined) {
    return __requestBody(type, __str(value));
  }
  if (typeof Uint8Array !== 'undefined' && value instanceof Uint8Array) {
    var text = __host().text.decode(value);
    var back = __host().text.encode(text);
    var same = back.length === value.length;
    for (var at = 0; same && at < value.length; at += 1) same = back[at] === value[at];
    if (same) return __requestBody(type, text);
  }
  throw new Error(
    'This converted extension replaced a response with a body that is not text. Yorozo keeps a ' +
    'response as the text the host read, so a binary body has no faithful spelling here.'
  );
};

/** Common catalogue shorthand for a JSON request body. */
__k.toJsonBody = function (value) {
  return __k.toRequestBody(value, 'application/json; charset=utf-8');
};

/**
 * keiyoushi's toJsonRequestBody(), which is a String extension here and only a
 * String extension.
 *
 * On a String — which is how every use in the catalogue writes it, over a raw
 * JSON template — it is 'toRequestBody("application/json")'. On an OBJECT the
 * Kotlin serialises it with kotlinx first, and that needs the @Serializable
 * descriptor: a class renamed by @SerialName has different keys on the wire
 * than in its source, and this runtime keeps that mapping only on the DECODE
 * side. JSON.stringify would post the Kotlin field names, the far end would
 * answer 200 with nothing in it, and the extension would look like a source
 * that had gone quiet. So it is refused by name at the point it happens.
 */
__k.toJsonRequestBody = function (value) {
  // A buildJsonObject / buildJsonArray result is safe to serialise: the
  // extension wrote its keys itself, so there is no @SerialName rename to lose.
  if (__isJson(value)) {
    return __requestBody('application/json; charset=utf-8', JSON.stringify(value));
  }
  if (typeof value !== 'string') {
    // Encoded as kotlinx would, through the registration the emitter wrote
    // beside each '@Serializable' class: its '@SerialName's, its defaults
    // left out, its nulls left out — the injected Json's configuration, which
    // is the one keiyoushi's helper encodes with. Anything the encoder cannot
    // spell faithfully (a class it has no registration for, a custom
    // serializer, a polymorphic value) is refused inside it, by name.
    var encoded = __serialEncode(value, __JSON_INJECTED, 'body', 0, true);
    return __requestBody('application/json; charset=utf-8', JSON.stringify(encoded));
  }
  return __requestBody('application/json; charset=utf-8', value);
};

/* --- keiyoushi core's GraphQL helpers --------------------------------------- */

/**
 * keiyoushi core's 'utils/GraphQL.kt', ported: the request builders and the
 * envelope reader, over the typed encoder and decoder above.
 *
 * Supplied by the host, as the other 'keiyoushi.utils' helpers are, because
 * the file itself does not translate: it overloads each builder on whether
 * 'variables' is a JsonElement or a '@Serializable' value, and JavaScript has
 * one slot per name. The two overloads differ only in that the typed one runs
 * 'variables.toJsonElement(json)' first, and encoding a JsonElement is the
 * element itself — so one function answers both, exactly.
 *
 * Every one of them encodes with its 'json' parameter, which defaults to the
 * injected instance. A Json passed explicitly carries a configuration this
 * runtime does not keep (every 'Json { }' collapses to one parser here), so
 * that is refused rather than encoded under the wrong rules.
 */
function __graphQLJson(json, what) {
  if (json !== undefined && json !== null) {
    throw new Error('This converted extension passed its own Json to ' + what +
      ', whose encoding settings this runtime does not carry.');
  }
  return __JSON_INJECTED;
}

/** 'GraphQLRequest(operationName, query, variables, extensions)', encoded. */
function __graphQLRequest(query, operationName, variables, extensions, json, what) {
  var config = __graphQLJson(json, what);
  var fields = [
    ['operationName', operationName],
    ['query', query],
    ['variables', variables],
    ['extensions', extensions]
  ];
  var out = {};
  for (var i = 0; i < fields.length; i += 1) {
    var held = fields[i][1] === undefined ? null : fields[i][1];
    // Every field defaults to null and the injected Json leaves out both a
    // default and a null, so an absent one is simply not written.
    if (held === null) continue;
    out[fields[i][0]] = __serialEncode(held, config, 'graphQL.' + fields[i][0], 0, true);
  }
  return out;
}

__k.graphQLBody = function (query, operationName, variables, extensions, json) {
  var request = __graphQLRequest(query, operationName, variables, extensions, json, 'graphQLBody');
  return __requestBody('application/json; charset=utf-8', JSON.stringify(request));
};

__k.graphQLPost = function (url, headers, query, operationName, variables, extensions, cache, json) {
  var body = __k.graphQLBody(query, operationName, variables, extensions, json);
  return POST(url, headers, body, cache === undefined ? null : cache);
};

/**
 * 'HttpUrl.Builder.appendGraphQLParams(…)': the four as query parameters, in
 * core's order, a null one left out.
 */
__k.appendGraphQLParams = function (builder, query, operationName, variables, extensions, json) {
  var config = __graphQLJson(json, 'appendGraphQLParams');
  if (operationName !== undefined && operationName !== null) builder.addQueryParameter('operationName', operationName);
  if (query !== undefined && query !== null) builder.addQueryParameter('query', query);
  if (variables !== undefined && variables !== null) {
    builder.addQueryParameter('variables', JSON.stringify(__serialEncode(variables, config, 'graphQL.variables', 0, true)));
  }
  if (extensions !== undefined && extensions !== null) {
    builder.addQueryParameter('extensions', JSON.stringify(__serialEncode(extensions, config, 'graphQL.extensions', 0, true)));
  }
  return builder;
};

/** The top-level 'graphQLGet(url, headers, …)', which builds a Request. */
__k.graphQLGet = function (url, headers, query, operationName, variables, extensions, cache, json) {
  var built = __k.appendGraphQLParams(
    __k.httpUrl(url).newBuilder(), query, operationName, variables, extensions, json
  ).build();
  return GET(built, headers, cache === undefined ? null : cache);
};

/** '{"persistedQuery":{"version":…,"sha256Hash":…}}' — neither field has a default. */
__k.persistedQueryExtension = function (hash, version) {
  return { persistedQuery: { version: version === undefined ? 1 : version, sha256Hash: __str(hash) } };
};

/**
 * 'parseGraphQLAs<T>()', on a Response or a String: the envelope decoded,
 * a non-empty 'errors' thrown as their messages joined by newlines, and a
 * missing 'data' an IllegalStateException — in that order, as core has it.
 */
__k.parseGraphQLAs = function (receiver, type, json) {
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('This converted extension read a GraphQL response with no type to decode it as.');
  }
  var text = typeof receiver === 'string' ? receiver : __jsonText(receiver);
  if (text === null) throw new Error('This converted extension read a GraphQL response from something with no body.');
  var raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error('This converted extension expected JSON, and this source did not answer with JSON.');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('This converted extension expected a GraphQL response to be a JSON object.');
  }
  var data = raw.data === undefined ? null : raw.data;
  // Decoded first: kotlinx builds the whole envelope before anything is
  // asked of it, so a 'data' that does not fit T fails before 'errors' does.
  var decoded = data === null ? null : __k.decode(Json, type, JSON.stringify(data));
  var errors = raw.errors === undefined ? null : raw.errors;
  if (errors !== null) {
    if (!Array.isArray(errors)) {
      throw new Error('This converted extension expected "errors" to be a list in a GraphQL response.');
    }
    if (errors.length > 0) {
      var messages = [];
      for (var i = 0; i < errors.length; i += 1) {
        var message = errors[i] === null || typeof errors[i] !== 'object' ? undefined : errors[i].message;
        if (typeof message !== 'string') throw __serialMissing('response.errors[' + i + '].message');
        messages.push(message);
      }
      var failure = new Error(messages.join('\\n'));
      failure.name = 'GraphQLException';
      throw failure;
    }
  }
  if (decoded === null || decoded === undefined) {
    return __k.error("GraphQL response is missing the 'data' field");
  }
  return decoded;
};

__k.bodyString = function (value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.body && typeof value.body.string === 'function') return value.body.string();
  if (typeof value.string === 'function') return value.string();
  return __str(value);
};

/**
 * android's Uri.getQueryParameter, over the url parser this runtime has.
 *
 * okhttp spells it 'queryParameter' and android spells it this way; both mean
 * the same thing, and an extension reaching for either has a url in its hand.
 * Null for an absent parameter is what android answers, and every call site in
 * this catalogue is a '?: return' or a '!!' on the result.
 *
 * Assigned in this section rather than in the stdlib because it needs the url
 * parser, which lives here — a bundle built without the http section would
 * otherwise carry a helper that referenced something absent.
 */
/**
 * URI(text), and URI(scheme, authority, path, query, fragment).
 *
 * The five-argument form is java.net's own, and it QUOTES each component as it
 * assembles them — see __uriQuote for the '%' consequence. The one-argument
 * form parses what it was given and quotes nothing, which is also java's.
 */
__k.uri = function (a, b, c, d, e) {
  if (a !== null && a !== undefined && a.__kUri === true) return a;
  if (arguments.length <= 1) return new __KUri(__str(a));
  if (arguments.length === 2) {
    // URI(scheme, schemeSpecificPart) — the opaque form, quoted the same way.
    return new __KUri((a === null ? '' : __str(a) + ':') + __str(__uriQuote(b)));
  }
  var path = __uriQuote(c);
  return new __KUri(__uriBuild(
    a === null || a === undefined ? null : __str(a),
    __uriQuote(b),
    path === null ? '' : path,
    __uriQuote(d),
    __uriQuote(e)
  ));
};

/**
 * resolve(), over the two things in this runtime that have a notion of one.
 *
 * A URI resolves by RFC 3986. okhttp's HttpUrl resolves the same way and then
 * REFUSES a result that is not http or https, answering null — which is what
 * 'url.resolve(href) ?: return null' in this ecosystem is testing for. Reading
 * either as a plain string join would build a plausible URL to the wrong file.
 */
__k.resolve = function (base, reference) {
  if (base !== null && base !== undefined && base.__kUri === true) return base.resolve(reference);
  var from = new __KUri(__str(base === null || base === undefined ? '' : base.toString()));
  var resolved = from.resolve(reference);
  // An HttpUrl receiver answers an HttpUrl, and null where okhttp would.
  var scheme = resolved.scheme === null ? '' : resolved.scheme.toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') return null;
  return __httpUrlOf(resolved.toString());
};

__k.getQueryParameter = function (value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value.queryParameter === 'function') return value.queryParameter(__str(name));
  return __httpUrlOf(__str(value)).queryParameter(__str(name));
};

/* --- java.net.URI, which is not okhttp's HttpUrl -------------------------- */

/**
 * java.net.URI, modelled as itself rather than as the URL parser next door.
 *
 * It is tempting to answer 'URI' with the HttpUrl this runtime already has —
 * one parser, three names. Three differences make that a wrong-value bug rather
 * than a simplification, and an extractor is exactly where they bite:
 *
 * - **HttpUrl refuses a scheme it does not know.** okhttp models an http URL;
 *   'blob:', 'magnet:' and a bare relative reference are not one. java.net.URI
 *   parses the generic syntax and accepts all of them, and an extractor handed
 *   a 'blob:' source is testing 'scheme' precisely to reject it. A parser that
 *   refused the input would take the branch that says the source changed.
 * - **A relative reference has no scheme and no host**, and java.net.URI says
 *   so by answering null for both. HttpUrl has no way to say it.
 * - **resolve() is RFC 3986 reference resolution**, which is not okhttp's
 *   'newBuilder().build()' on a joined string: '../b' has to pop a segment and
 *   '?q' has to keep the base path while replacing the query.
 *
 * Where the two agree — path excludes the query, query excludes the '?' —
 * they are spelled the same way here so that a call site reading either object
 * reads the same value.
 *
 * The 'raw*' half is the string as written and the plain half is percent-decoded,
 * which is java.net.URI's distinction and the one this catalogue's one
 * path-encoder depends on.
 */
function __KUri(text) {
  var written = __str(text);
  // RFC 3986 Appendix B, which is the parse java.net.URI performs. Deliberately
  // permissive: a URI that does not parse is still a URI with everything in its
  // scheme-specific part, which is what java.net.URI does for an opaque one.
  var parts = /^(?:([a-zA-Z][a-zA-Z0-9+.-]*):)?(?:\\/\\/([^/?#]*))?([^?#]*)(?:\\?([^#]*))?(?:#(.*))?$/.exec(written);

  this.__kUri = true;
  this.__text = written;
  this.scheme = parts === null || parts[1] === undefined ? null : parts[1];
  this.rawAuthority = parts === null || parts[2] === undefined ? null : parts[2];
  this.rawPath = parts === null || parts[3] === undefined ? '' : parts[3];
  this.rawQuery = parts === null || parts[4] === undefined ? null : parts[4];
  this.rawFragment = parts === null || parts[5] === undefined ? null : parts[5];

  this.authority = __uriDecode(this.rawAuthority);
  this.path = __uriDecode(this.rawPath);
  this.query = __uriDecode(this.rawQuery);
  this.fragment = __uriDecode(this.rawFragment);

  var authority = this.rawAuthority;
  if (authority === null) {
    this.userInfo = null;
    this.host = null;
    this.port = -1;
  } else {
    var at = authority.lastIndexOf('@');
    this.userInfo = at === -1 ? null : __uriDecode(authority.slice(0, at));
    var hostPort = at === -1 ? authority : authority.slice(at + 1);
    var colon = hostPort.lastIndexOf(':');
    // A ':' inside '[...]' belongs to an IPv6 literal, not to a port.
    var portable = colon > hostPort.lastIndexOf(']');
    this.host = portable ? hostPort.slice(0, colon) : hostPort;
    var port = portable ? Number(hostPort.slice(colon + 1)) : NaN;
    this.port = Number.isFinite(port) ? port : -1;
    // java.net.URI answers null for a host it cannot read as a server name,
    // and the callers here test it. An empty authority is one of those.
    if (this.host.length === 0) this.host = null;
  }

  this.rawSchemeSpecificPart =
    (this.rawAuthority === null ? '' : '//' + this.rawAuthority) +
    this.rawPath +
    (this.rawQuery === null ? '' : '?' + this.rawQuery);
  this.schemeSpecificPart = __uriDecode(this.rawSchemeSpecificPart);
}

function __uriDecode(part) {
  if (part === null || part === undefined) return null;
  try {
    return decodeURIComponent(part);
  } catch (error) {
    // java.net.URI throws for a malformed escape at construction; this runtime
    // has already accepted the string, so the raw form is the honest answer
    // rather than losing the whole conversion over one stray '%'.
    return part;
  }
}

__KUri.prototype.isAbsolute = function () { return this.scheme !== null; };
__KUri.prototype.isOpaque = function () {
  return this.scheme !== null && this.rawAuthority === null && this.rawPath.indexOf('/') !== 0;
};
__KUri.prototype.getScheme = function () { return this.scheme; };
__KUri.prototype.getHost = function () { return this.host; };
__KUri.prototype.getPath = function () { return this.path; };
__KUri.prototype.getRawPath = function () { return this.rawPath; };
__KUri.prototype.getQuery = function () { return this.query; };
__KUri.prototype.getRawQuery = function () { return this.rawQuery; };
__KUri.prototype.getFragment = function () { return this.fragment; };
__KUri.prototype.getAuthority = function () { return this.authority; };
__KUri.prototype.getPort = function () { return this.port; };
__KUri.prototype.getUserInfo = function () { return this.userInfo; };

__KUri.prototype.toString = function () { return this.__text; };
__KUri.prototype.toASCIIString = function () { return this.__text; };
__KUri.prototype.toURL = function () { return this; };
__KUri.prototype.normalize = function () { return new __KUri(__uriNormalise(this.__text)); };

/**
 * RFC 3986 section 5.3 reference resolution, which is the whole point of URI.
 *
 * Joining strings is not this: '../b' has to pop a segment off the base path,
 * '?q' has to keep the base path and replace only the query, and '//host/x'
 * has to keep the base scheme and nothing else. Each of those is a URL that
 * looks plausible and points somewhere else.
 */
__KUri.prototype.resolve = function (reference) {
  var other = reference !== null && reference !== undefined && reference.__kUri === true
    ? reference
    : new __KUri(__str(reference));

  if (other.scheme !== null) return other;
  if (other.rawAuthority !== null) {
    return new __KUri(__uriBuild(this.scheme, other.rawAuthority, __uriNormalise(other.rawPath), other.rawQuery, other.rawFragment));
  }
  if (other.rawPath.length === 0) {
    var query = other.rawQuery === null ? this.rawQuery : other.rawQuery;
    return new __KUri(__uriBuild(this.scheme, this.rawAuthority, this.rawPath, query, other.rawFragment));
  }
  var path;
  if (other.rawPath.charAt(0) === '/') {
    path = __uriNormalise(other.rawPath);
  } else {
    var base = this.rawPath;
    var merged = this.rawAuthority !== null && base.length === 0
      ? '/' + other.rawPath
      : base.slice(0, base.lastIndexOf('/') + 1) + other.rawPath;
    path = __uriNormalise(merged);
  }
  return new __KUri(__uriBuild(this.scheme, this.rawAuthority, path, other.rawQuery, other.rawFragment));
};

__KUri.prototype.relativize = function (other) { return other; };

/** RFC 3986 section 5.2.4: '.' and '..' removed against the path, not the string. */
function __uriNormalise(path) {
  var input = __str(path);
  var out = [];
  var segments = input.split('/');
  for (var i = 0; i < segments.length; i += 1) {
    var segment = segments[i];
    if (segment === '.') {
      if (i === segments.length - 1) out.push('');
      continue;
    }
    if (segment === '..') {
      if (out.length > 1) out.pop();
      if (i === segments.length - 1) out.push('');
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

function __uriBuild(scheme, authority, path, query, fragment) {
  return (scheme === null ? '' : scheme + ':') +
    (authority === null || authority === undefined ? '' : '//' + authority) +
    __str(path) +
    (query === null || query === undefined ? '' : '?' + query) +
    (fragment === null || fragment === undefined ? '' : '#' + fragment);
}

/**
 * The characters java.net.URI's multi-argument constructors leave alone.
 *
 * Everything else is percent-encoded — INCLUDING '%' itself, which is the
 * famous edge of that constructor: it assumes each component is unencoded, so
 * a caller that percent-encoded a path first gets it encoded again. That is
 * what happens on Android, so it is what happens here; producing the
 * single-encoded string instead would make this runtime disagree with the
 * platform the extension was tested on.
 */
var __URI_SAFE = /[A-Za-z0-9\\-._~!$&'()*+,;=:@/]/;

function __uriQuote(part) {
  if (part === null || part === undefined) return null;
  var text = __str(part);
  var out = '';
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (__URI_SAFE.test(ch)) { out += ch; continue; }
    var bytes = __host().text.encode(ch);
    for (var b = 0; b < bytes.length; b += 1) {
      out += '%' + __k.uppercase(__k.padStart(bytes[b].toString(16), 2, '0'));
    }
  }
  return out;
}

/**
 * android's Uri, which is okhttp's HttpUrl under a different name.
 *
 * 'Uri.parse(url).getQueryParameter("id")' is the android spelling of the same
 * two operations okhttp spells 'toHttpUrl().queryParameter(…)', and both are in
 * this catalogue. Without the name the emitter passes 'Uri.parse(…)' through as
 * written — a capitalised receiver is not refused — and the bundle dies with
 * 'Uri is not defined' at the first call, which names nothing useful.
 */
/**
 * java.io.File, for the one thing a converted extension may do with it: write
 * a temporary file and hand its uri to the player.
 *
 * PlaylistUtils' fixSubtitles fetches a caption file, repairs it (SubRip to
 * WebVTT, the stray blank lines that break a cue) and writes the result to
 * 'File.createTempFile("subs", ".vtt")' so the player can load it from
 * 'Uri.fromFile(file)'. The file is a carrier and nothing else: nothing reads
 * it back, and it is deleted on exit. A plugin has no filesystem (ABI.md), so
 * the carrier here is the text itself, and its uri is a 'data:' uri holding
 * the same bytes, which the sidecar guard already accepts and a player loads
 * like any caption file. The repair still runs in the extension's own code.
 *
 * Only the temporary file exists. 'File(path)', 'File.separator' and every
 * other member are refused by name in the emitter ('FILE_STATICS'), and a
 * temp file's methods are the ones this carrier can answer truthfully.
 */
function __KTempFile(prefix, suffix) {
  this.prefix = __str(prefix);
  this.suffix = suffix === null || suffix === undefined ? '.tmp' : __str(suffix);
  this.text = '';
  this.deleted = false;
}
__KTempFile.prototype.writeText = function (text, charset) {
  __utf8Only(charset);
  this.text = __str(text);
  this.deleted = false;
};
__KTempFile.prototype.readText = function (charset) {
  __utf8Only(charset);
  if (this.deleted) throw new Error('This converted extension read a temporary file it had deleted.');
  return this.text;
};
__KTempFile.prototype.deleteOnExit = function () {};
__KTempFile.prototype.delete = function () {
  var had = !this.deleted;
  this.deleted = true;
  this.text = '';
  return had;
};
__KTempFile.prototype.exists = function () { return !this.deleted; };
__KTempFile.prototype.length = function () {
  return this.deleted ? 0 : __host().text.encode(this.text).length;
};

/* The media type a temporary file's uri carries, read from its suffix. */
function __tempFileType(suffix) {
  var s = suffix.toLowerCase();
  if (s === '.vtt') return 'text/vtt';
  if (s === '.srt') return 'application/x-subrip';
  if (s === '.ass' || s === '.ssa') return 'text/x-ssa';
  return 'text/plain';
}

var File = {
  createTempFile: function (prefix, suffix) { return new __KTempFile(prefix, suffix); }
};

var Uri = {
  /**
   * The uri of a temporary file: its bytes, as a 'data:' uri of the type its
   * suffix names. A file this runtime did not make has no uri here.
   */
  fromFile: function (file) {
    if (!(file instanceof __KTempFile)) {
      throw new Error('This converted extension asked for the uri of a file this runtime did not make.');
    }
    if (file.deleted) throw new Error('This converted extension asked for the uri of a deleted file.');
    var encoded = __host().bytes.toBase64(__host().text.encode(file.text));
    var uri = 'data:' + __tempFileType(file.suffix) + ';charset=utf-8;base64,' + encoded;
    return { toString: function () { return uri; } };
  },
  parse: function (value) { return __httpUrlOf(__str(value)); },
  encode: function (value) { return encodeURIComponent(__str(value)); },
  decode: function (value) {
    try { return decodeURIComponent(__str(value)); } catch (error) { return __str(value); }
  }
};

__k.httpUrl = function (value) {
  if (value !== null && value !== undefined && typeof value.newBuilder === 'function' && value.encodedPath !== undefined) {
    return value;
  }
  return __httpUrlOf(value);
};
`;

/**
 * jsoup, over the inlined DOM engine.
 *
 * The parser cannot be imported — a bundle is one module with no resolution
 * inside the sandbox — so it travels into the bundle as source, exactly as it
 * does for the other converted formats.
 *
 * `dom.ts` deliberately models `select()` as a bare array, because that is the
 * honest shape for a selector result. jsoup's `Elements` is a *collection with
 * element methods on it*, and scraper code calls `.text()`, `.attr()` and
 * `.first()` on the collection itself. That wrapper is added here rather than
 * in `dom.ts`, so the parser stays a parser.
 */
export const KOTLIN_JSOUP = `
/* --- the DOM engine, inlined ---------------------------------------------- */
${DOM_RUNTIME_SOURCE}
__kdom = globalThis.__yorozoRuntime;

/* --- jsoup ---------------------------------------------------------------- */

var Jsoup = {
  // A third argument is a Parser, and the scanner lets through only
  // Parser.htmlParser(), which is what parse() does without one.
  parse: function (html, baseUrl) { return __parseDoc(html, baseUrl); },
  parseBodyFragment: function (html, baseUrl) { return __parseDoc(html, baseUrl); }
};

/**
 * org.jsoup.parser.Parser, for the two statics the catalogue calls on it.
 *
 * unescapeEntities is jsoup's own character-reference reader (the engine's,
 * which the parser also runs), so a title from a WordPress JSON API decodes
 * exactly as the same title would out of the page. xmlParser() is NOT here:
 * an XML parse keeps case, has no void elements and no implied html/body,
 * and handing back the HTML parser's tree for one is the wrong tree. The
 * scanner refuses every other member by name.
 */
var Parser = {
  unescapeEntities: function (value, inAttribute) {
    return __kdom.unescapeEntities(__str(value), inAttribute === true);
  },
  htmlParser: function () { return Parser; }
};

/** org.jsoup.nodes.Entities.unescape(string), which is inAttribute = false. */
var Entities = {
  unescape: function (value) { return __kdom.unescapeEntities(__str(value), false); }
};

/** jsoup's TextNode(text): the characters, never parsed. Callable with or without new. */
function TextNode(text) { return __kdom.createTextNode(__str(text)); }

/**
 * org.jsoup.select.Evaluator's Tag, Class and Id — the three the catalogue
 * builds by hand, and which select() and selectFirst() take in place of a
 * selector string. Callable with or without new, as a Kotlin constructor
 * call may arrive either way.
 */
var Evaluator = {
  Tag: function (name) { return __kdom.jsoupEvaluator('Tag', __str(name)); },
  Class: function (name) { return __kdom.jsoupEvaluator('Class', __str(name)); },
  Id: function (name) { return __kdom.jsoupEvaluator('Id', __str(name)); }
};

/**
 * jsoup's Elements: a list that answers element questions about its members.
 *
 * **An array**, because both shapes are asked of the same value: the translated
 * Kotlin maps, filters and indexes a selection, and the scraper that wrote it
 * calls .attr(), .text() and .first() on the collection itself. jsoup's own
 * Elements is a List for exactly that reason, so this is the faithful shape
 * rather than a convenience.
 *
 * text() concatenates, attr() answers for the first member that has the
 * attribute, and an empty selection answers '' rather than throwing — all three
 * are what jsoup does, and a scraper written against it depends on each.
 */
function __KElements(items) {
  var list = items === null || items === undefined ? [] : Array.prototype.slice.call(items);
  Object.setPrototypeOf(list, __KElements.prototype);
  return list;
}

__KElements.prototype = Object.create(Array.prototype);
__KElements.prototype.constructor = __KElements;

// map(), filter() and slice() answer plain arrays. Left alone they would try to
// rebuild this type through a constructor that takes items rather than a
// length, and hand back an empty list for a page full of results.
Object.defineProperty(__KElements, Symbol.species, { get: function () { return Array; } });

__KElements.prototype.size = function () { return this.length; };
__KElements.prototype.isEmpty = function () { return this.length === 0; };
__KElements.prototype.isNotEmpty = function () { return this.length > 0; };
__KElements.prototype.get = function (index) {
  var item = this[index];
  return item === undefined ? null : item;
};
__KElements.prototype.first = function () {
  return this.length === 0 ? null : this[0];
};
__KElements.prototype.last = function () {
  return this.length === 0 ? null : this[this.length - 1];
};

__KElements.prototype.text = function () {
  var parts = [];
  for (var i = 0; i < this.length; i += 1) {
    var text = this[i].text();
    if (text.length > 0) parts.push(text);
  }
  return parts.join(' ');
};

__KElements.prototype.eachText = function () {
  var out = [];
  for (var i = 0; i < this.length; i += 1) {
    var text = this[i].text();
    if (text.length > 0) out.push(text);
  }
  return out;
};

/**
 * The first member that HAS the attribute, which is not the first member —
 * or, given a value, jsoup's setter: every member gets it, and the
 * selection is the answer.
 */
__KElements.prototype.attr = function (name, value) {
  if (arguments.length > 1) return __eachElement(this, 'attr', [name, __str(value)]);
  for (var i = 0; i < this.length; i += 1) {
    var value = this[i].attr(name);
    if (value.length > 0) return value;
  }
  return '';
};

/**
 * The attribute of every member that HAS it — the others are omitted.
 *
 * jsoup skips an element without the attribute rather than yielding '', and
 * scraper code depends on that: the result gets zipped against another list,
 * and a placeholder would shift every pair after it by one.
 *
 * 'abs:href' is asked about as 'href', because the resolved form is computed
 * and never present in the markup.
 */
__KElements.prototype.eachAttr = function (name) {
  var asked = __str(name);
  var declared = asked.indexOf('abs:') === 0 ? asked.slice(4) : asked;
  var out = [];
  for (var i = 0; i < this.length; i += 1) {
    if (!this[i].hasAttr(declared)) continue;
    out.push(this[i].attr(asked));
  }
  return out;
};

__KElements.prototype.hasAttr = function (name) {
  for (var i = 0; i < this.length; i += 1) {
    if (this[i].hasAttr(name)) return true;
  }
  return false;
};

__KElements.prototype.select = function (selector) {
  var out = [];
  var seen = new Set();
  for (var i = 0; i < this.length; i += 1) {
    var found = this[i].select(selector);
    for (var j = 0; j < found.length; j += 1) {
      if (seen.has(found[j])) continue;
      seen.add(found[j]);
      out.push(found[j]);
    }
  }
  return new __KElements(out);
};

__KElements.prototype.selectFirst = function (selector) {
  for (var i = 0; i < this.length; i += 1) {
    var found = this[i].selectFirst(selector);
    if (found !== null) return found;
  }
  return null;
};

__KElements.prototype.html = function () {
  var parts = [];
  for (var i = 0; i < this.length; i += 1) parts.push(this[i].html());
  return parts.join('\\n');
};

__KElements.prototype.outerHtml = function () {
  var parts = [];
  for (var i = 0; i < this.length; i += 1) parts.push(this[i].outerHtml());
  return parts.join('\\n');
};

/**
 * jsoup's Elements.toString(), which is its outer HTML.
 *
 * Inherited from Array, this answered the elements joined by commas — and for
 * a single element, '[object Object]'. An extension that reads a script block
 * as select(...).toString() and then substringAfter()s into it therefore
 * searched the literal text '[object Object]', found nothing, and handed the
 * whole of it back as a video url. The player was then sent to a path spelled
 * '[object Object]', which answers 404 rather than raising, and so read as a
 * source that was down.
 */
__KElements.prototype.toString = function () { return this.outerHtml(); };

__KElements.prototype.toArray = function () { return Array.prototype.slice.call(this); };

/**
 * The Elements half of jsoup's mutation and traversal: each is the Element
 * call applied to every member, and the mutators answer the same Elements so
 * a chain keeps going — select("p, br").prepend("\\n") is one line in the
 * catalogue.
 *
 * remove() is the one that mattered first. The runtime's collection remove()
 * took an Elements for a list and removed "undefined" from it — nothing —
 * so select("script, .ad").remove() left the advert in the synopsis and
 * answered false, with nothing refused and nothing thrown.
 */
function __eachElement(list, name, args) {
  for (var i = 0; i < list.length; i += 1) list[i][name].apply(list[i], args);
  return list;
}
__KElements.prototype.remove = function () { return __eachElement(this, 'remove', []); };
__KElements.prototype.prepend = function (html) { return __eachElement(this, 'prepend', [__str(html)]); };
__KElements.prototype.append = function (html) { return __eachElement(this, 'append', [__str(html)]); };
__KElements.prototype.before = function (html) { return __eachElement(this, 'before', [__str(html)]); };
__KElements.prototype.after = function (html) { return __eachElement(this, 'after', [__str(html)]); };
__KElements.prototype.hasText = function () {
  for (var i = 0; i < this.length; i += 1) {
    if (this[i].hasText()) return true;
  }
  return false;
};
/** Any member matching, as jsoup's Elements.is() answers. */
__KElements.prototype.is = function (query) {
  for (var i = 0; i < this.length; i += 1) {
    if (this[i].is(query)) return true;
  }
  return false;
};
/** Every member's ancestors, once each, in the order they were first met. */
__KElements.prototype.parents = function () {
  var out = [];
  var seen = new Set();
  for (var i = 0; i < this.length; i += 1) {
    var up = this[i].parents();
    for (var j = 0; j < up.length; j += 1) {
      if (seen.has(up[j])) continue;
      seen.add(up[j]);
      out.push(up[j]);
    }
  }
  return new __KElements(out);
};

/**
 * The engine's own selections answer as Elements too.
 *
 * dom.ts models select() as a bare array and stays a parser, which is the right
 * call for a parser — but the scraper it serves writes
 * element.select("a").attr("href"), asking the collection an element question
 * that an array cannot answer. So the array the engine hands back is given this
 * prototype on the way out, once, here. Two extensions in the catalogue load,
 * search, and fail with ".attr is not a function" without it, which reads as
 * the source having changed when nothing about the source is wrong.
 */
(function () {
  var proto = Object.getPrototypeOf(__parseDoc('', ''));
  while (proto !== null && !Object.prototype.hasOwnProperty.call(proto, 'select')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (proto === null) return;
  var bare = proto.select;
  proto.select = function (selector) { return new __KElements(bare.call(this, selector)); };
})();

/**
 * asJsoup(), which is an extension function and so cannot be a method.
 *
 * Reached with a Response — the common case, and the one that must parse
 * against the response's FINAL url — or with a String an extension pulled out
 * of a script tag, which has no base url to resolve against at all.
 */
__k.asJsoup = function (value, html) {
  if (value !== null && value !== undefined && typeof value.asJsoup === 'function') {
    return value.asJsoup(html);
  }
  if (value !== null && value !== undefined && value.body && typeof value.body.string === 'function') {
    return __parseDoc(html === undefined || html === null ? value.body.string() : html, __str(value.url));
  }
  return __parseDoc(html === undefined || html === null ? value : html, '');
};

/**
 * The collection shortcuts, as helpers rather than only as methods.
 *
 * 'eachText()' and 'eachAttr()' are called on a bare selector result as often
 * as on an Elements, and the emitter cannot tell which it has — so both go
 * through the wrapper.
 */
/**
 * jsoup's Element.closest(), the one selector call that walks upwards.
 *
 * Reached with an Element, or with a selection the emitter could not tell from
 * one — a bare array from select() answers for its first element, because that
 * is what 'selectFirst(x).closest(y)' means after the null check the Kotlin
 * already wrote. Nothing above it matching is null, not an empty selection: the
 * call sites read '?.attr(...)' straight off the result.
 */
__k.closest = function (value, selector) {
  if (value === null || value === undefined) return null;
  if (typeof value.closest === 'function') return value.closest(__str(selector));
  var items = __k.els(value).toArray();
  if (items.length === 0 || typeof items[0].closest !== 'function') return null;
  return items[0].closest(__str(selector));
};

/**
 * jsoup's ownerDocument(), reached through a helper for the usual reason.
 *
 * The receiver is an Element the emitter has no type for, and a selection from
 * select() is an array — which has no methods at all. A document owns itself,
 * as it does in jsoup, so 'doc.ownerDocument()!!.location()' is the same url as
 * 'doc.location()'.
 */
__k.ownerDocument = function (value) {
  if (value === null || value === undefined) return null;
  if (typeof value.ownerDocument === 'function') return value.ownerDocument();
  var items = __k.els(value).toArray();
  if (items.length === 0 || typeof items[0].ownerDocument !== 'function') return null;
  return items[0].ownerDocument();
};

/**
 * before(x) and after(x), which are two different library calls under one name.
 *
 * On a jsoup Element or Elements they insert x (markup or a node) beside the
 * receiver and answer the receiver. On a java.util.Date they compare instants,
 * and on a Calendar they compare only with another Calendar — Calendar.before
 * takes an Object and answers false for anything that is not one, which is
 * the JDK's rule and so this one's. The emitter cannot see the type, so the
 * value is asked; anything that is neither is an error rather than a guess.
 */
function __dateOrder(value, other, name) {
  function millis(v) {
    if (v instanceof Date) return v.getTime();
    if (v !== null && v !== undefined && typeof v.getTime === 'function') return v.getTime();
    return null;
  }
  if (value instanceof __KCalendar) {
    if (!(other instanceof __KCalendar)) return null;
    return value.getTimeInMillis() - other.getTimeInMillis();
  }
  var a = millis(value);
  var b = millis(other);
  if (a === null || b === null) {
    throw new Error('This converted extension called ' + name + '() on something that is neither a jsoup node nor a date.');
  }
  return a - b;
}
/**
 * .head(), which the catalogue writes for two things and neither is a list:
 * Request.Builder().head() — the HEAD method — and a jsoup document's
 * head(). Both receivers define it; anything else is a Kotlin sequence's
 * first element, which is what this name was once mapped to wholesale.
 */
__k.head = function (value) {
  if (value !== null && value !== undefined && typeof value.head === 'function') return value.head();
  return __k.firstOrNull(value);
};

__k.before = function (value, other) {
  if (value !== null && value !== undefined && typeof value.before === 'function') return value.before(other);
  var order = __dateOrder(value, other, 'before');
  return order !== null && order < 0;
};
__k.after = function (value, other) {
  if (value !== null && value !== undefined && typeof value.after === 'function') return value.after(other);
  var order = __dateOrder(value, other, 'after');
  return order !== null && order > 0;
};

__k.eachText = function (value) { return __k.els(value).eachText(); };
__k.eachAttr = function (value, name) { return __k.els(value).eachAttr(name); };

__k.els = function (value) {
  if (value instanceof __KElements) return value;
  if (value === null || value === undefined) return new __KElements([]);
  if (Array.isArray(value)) return new __KElements(value);
  if (typeof value.select === 'function') return new __KElements([value]);
  return new __KElements(__arr(value));
};
`;

/**
 * kotlinx.serialization, as a descriptor walk.
 *
 * A `@Serializable` class has no runtime existence after translation — there is
 * no reflection to recover the field list from — so the emitter writes the
 * fields down: `{ fields: [[jsName, wireName, kind, default], ...] }`. That is
 * what carries `@SerialName` renames and declared defaults across, and both are
 * silent-wrongness bugs if dropped: a rename lost reads every value as absent,
 * and a default lost turns an optional field into a crash.
 *
 * Unknown keys are ignored, which is what every extension configures its `Json`
 * with anyway, and what keeps a source that adds a field from breaking a
 * conversion made before it did.
 */
export const KOTLIN_SERIALIZATION = `
/* --- kotlinx.serialization ------------------------------------------------ */

function __descriptorOf(descriptor) {
  return typeof descriptor === 'function' ? descriptor() : descriptor;
}

function __decodePrimitive(kind, value, path) {
  var optional = kind.charAt(kind.length - 1) === '?';
  var base = optional ? kind.slice(0, kind.length - 1) : kind;

  if (value === null || value === undefined) {
    if (optional || base === 'any') return null;
    throw new Error(
      'This converted extension expected "' + path + '" to be present in the response, and it was not.'
    );
  }

  if (base === 'string') return typeof value === 'string' ? value : String(value);
  if (base === 'boolean') return value === true || value === 'true';
  if (base === 'int' || base === 'long') {
    var whole = Number(value);
    if (!Number.isFinite(whole)) {
      throw new Error('This converted extension expected "' + path + '" to be a number.');
    }
    return Math.trunc(whole);
  }
  if (base === 'double' || base === 'float') {
    var real = Number(value);
    if (!Number.isFinite(real)) {
      throw new Error('This converted extension expected "' + path + '" to be a number.');
    }
    return real;
  }
  return value;
}

function __decodeValue(kind, value, path) {
  if (kind === null || kind === undefined || kind === 'any') return value === undefined ? null : value;
  if (typeof kind === 'string') return __decodePrimitive(kind, value, path);

  // ['list', element] — how the emitter writes List<T>.
  if (Array.isArray(kind)) {
    if (kind[0] === 'map') return __decodeMap(kind[1], value, path);
    return __decodeList(kind[1], value, path);
  }

  var shape = __descriptorOf(kind);
  if (shape === null || shape === undefined) return value;
  if (shape.nullable !== undefined) {
    return value === null || value === undefined ? null : __decodeValue(shape.nullable, value, path);
  }
  if (shape.list !== undefined) return __decodeList(shape.list, value, path);
  if (shape.map !== undefined) return __decodeMap(shape.map, value, path);
  if (shape.fields !== undefined) return __decodeObject(shape, value, path);
  return value;
}

function __decodeList(element, value, path) {
  if (value === null || value === undefined) return [];
  var items = Array.isArray(value) ? value : [value];
  var out = [];
  for (var i = 0; i < items.length; i += 1) {
    out.push(__decodeValue(element, items[i], path + '[' + i + ']'));
  }
  return out;
}

function __decodeMap(element, value, path) {
  var out = {};
  if (value === null || value === undefined || typeof value !== 'object') return out;
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = __decodeValue(element, value[key], path + '.' + key);
  }
  return out;
}

function __decodeObject(shape, value, path) {
  var source = value === null || value === undefined || typeof value !== 'object' ? {} : value;
  var fields = shape.fields;
  var out = {};

  for (var i = 0; i < fields.length; i += 1) {
    var field = fields[i];
    var jsName = field[0];
    var wireName = field.length > 1 && field[1] !== null && field[1] !== undefined ? field[1] : jsName;
    var kind = field.length > 2 ? field[2] : 'any';
    var hasDefault = field.length > 3;
    var raw = source[wireName];

    if (raw === undefined) {
      // A declared default wins; without one, the kind decides whether an
      // absent key is a null or a named failure.
      out[jsName] = hasDefault ? field[3] : __decodeValue(kind, null, path + '.' + jsName);
      continue;
    }
    out[jsName] = __decodeValue(kind, raw, path + '.' + jsName);
  }
  // Every other key in the payload is dropped, which is ignoreUnknownKeys.
  return out;
}

/**
 * A Kotlin type name, as a decoding kind.
 *
 * 'parseAs<List<Item>>()' arrives here as the text 'List<Item>', because a type
 * argument is the one thing a translation cannot keep: the class it names does
 * not exist at runtime. The CONTAINER still does, and it is what matters —
 * decoding 'List<Item>' as a single object rather than a list is the difference
 * between one result and a page of them.
 *
 * The element type is only honoured when the emitter also handed over a
 * descriptor for it. Without one, an unknown class name means 'whatever the
 * payload holds', which is what ignoreUnknownKeys already implies.
 */
/** A bare type name, optionally generic and optionally nullable — never JSON. */
function __looksLikeDescriptor(text) {
  return /^[A-Za-z_][A-Za-z0-9_.]*(\\s*<.*>)?\\??$/.test(__str(text).trim());
}

function __typeKind(name, element) {
  var text = __str(name).trim();
  if (text.length === 0) return element === undefined ? 'any' : element;

  var optional = text.charAt(text.length - 1) === '?';
  if (optional) text = text.slice(0, text.length - 1).trim();

  var generic = /^([A-Za-z_][A-Za-z0-9_.]*)\\s*<(.*)>$/.exec(text);
  if (generic !== null) {
    var container = generic[1].replace(/^.*\\./, '');
    var inner = generic[2];
    if (container === 'Map' || container === 'HashMap' || container === 'MutableMap') {
      var comma = __splitTypeArguments(inner);
      return ['map', __typeKind(comma.length > 1 ? comma[1] : '', element)];
    }
    if (container === 'List' || container === 'ArrayList' || container === 'Set' ||
        container === 'Collection' || container === 'MutableList' || container === 'Array') {
      return ['list', __typeKind(__splitTypeArguments(inner)[0], element)];
    }
    return __typeKind(inner, element);
  }

  var bare = text.replace(/^.*\\./, '');
  if (bare === 'String') return optional ? 'string?' : 'string';
  if (bare === 'Int' || bare === 'Long' || bare === 'Short') return optional ? 'int?' : 'int';
  if (bare === 'Double' || bare === 'Float' || bare === 'Number') return optional ? 'double?' : 'double';
  if (bare === 'Boolean') return optional ? 'boolean?' : 'boolean';
  return element === undefined ? 'any' : element;
}

/** Splits 'String, Item' without cutting inside a nested type argument. */
function __splitTypeArguments(text) {
  var parts = [];
  var depth = 0;
  var start = 0;
  for (var i = 0; i < text.length; i += 1) {
    var ch = text.charAt(i);
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A field descriptor, wherever in the argument list it turned up. */
function __descriptorArg(value) {
  if (typeof value === 'function') return value;
  if (value === null || value === undefined || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.length > 0 && typeof value[0] === 'string' ? value : null;
  if (value.fields !== undefined || value.list !== undefined || value.map !== undefined ||
      value.nullable !== undefined) {
    return value;
  }
  return null;
}

function __jsonText(value) {
  if (typeof value === 'string') return value;
  if (value !== null && value !== undefined && value.body && typeof value.body.string === 'function') {
    return value.body.string();
  }
  return null;
}

/**
 * decode(), in both shapes the emitter writes.
 *
 * 'decode(descriptor, value)' is the descriptor form, and
 * 'decode(receiver, "List<Item>", value?)' is the one a 'parseAs' or a
 * 'Json.decodeFromString' becomes — the receiver being a Response, whose body
 * is already read, or the Json object itself.
 */
__k.decode = function (a, b, c, d) {
  var descriptor = a;
  var payload = b;
  // The Kotlin type as written, where one was: see the typed path at the end.
  var typeName = null;

  var receiverText = __jsonText(a);
  var isJson = a === Json;
  if (isJson || (receiverText !== null && typeof a !== 'string')) {
    // Receiver form: the type name carries the container, the payload is either
    // the receiver's own body or a later argument, and a descriptor may arrive
    // in any position after the receiver — the emitter writes one when it has
    // one, and the type name alone when it does not.
    var named = typeof b === 'string' ? b : '';
    if (named.length > 0) typeName = named;
    var element = __descriptorArg(b) || __descriptorArg(c) || __descriptorArg(d);
    descriptor = named.length > 0
      ? __typeKind(named, element === null ? undefined : element)
      : (element === null ? 'any' : element);
    payload = typeof c === 'string' ? c : (typeof d === 'string' ? d : receiverText);
  } else if (typeof a === 'string' && typeof b === 'string') {
    // Two strings, and which is which depends on how it was written.
    //
    // 'Json.decodeFromString<T>(text)' loses its receiver and arrives as
    // (type, payload). '"...".parseAs<T>()' has a *string* receiver, and the
    // emitter always writes the receiver first, so it arrives as
    // (payload, type) — the other way round. The old test only asked whether
    // the FIRST string looked like a type, so every parseAs on a string read
    // its own JSON as the descriptor and then tried to JSON.parse the type
    // name. That threw 'expected JSON, and this source did not answer with
    // JSON' on a payload that was perfectly good JSON.
    //
    // A descriptor is a bare type name, optionally generic, optionally
    // nullable. A JSON payload never matches that, which is what makes them
    // safe to tell apart.
    if (__looksLikeDescriptor(b) && !__looksLikeDescriptor(a)) {
      descriptor = __typeKind(b, undefined);
      typeName = b;
      payload = a;
    } else if (__looksLikeDescriptor(a)) {
      descriptor = __typeKind(a, undefined);
      typeName = a;
      payload = b;
    }
  }

  var parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error('This converted extension expected JSON, and this source did not answer with JSON.');
    }
  }
  // A type that names a '@Serializable' class this module declared is decoded
  // the way kotlinx decodes it — see '__serialDecode'. Everything else takes
  // the structural walk below, exactly as it did before that existed.
  var typed = typeof typeName === 'string' ? __serialTree(typeName) : null;
  if (typed !== null && __serialNames(typed)) return __serialDecode(typed, parsed, 'response', {});
  // The shapes last, over the decoded value: a '@Serializable' class that
  // renamed a field or computes one registered itself beside its declaration,
  // and until this ran neither survived the parse. See 'shape'.
  return __applyShapes(__decodeValue(descriptor, parsed, 'response'), 0);
};

/* --- typed decoding, the way kotlinx decodes --------------------------------- */

/**
 * Every '@Serializable' class this module declares, by the name a type is
 * written with, and what kotlinx knows about it. See '__k.serial'.
 *
 * The structural walk above answers plain JSON and then *guesses* which class
 * a record is from the fields it carries. The guess has to be unique, and a
 * class whose fields are all optional fits every record — so one such DTO in a
 * module made every other one unrecognisable, and a record came back with no
 * methods: 'dto.toPageList is not a function' on the first chapter, out of a
 * bundle that reported nothing refused. It also has no way to run a custom
 * serializer, which is written on a field the guess cannot see.
 *
 * A type is not a guess. 'parseAs<Chapter>()' names the class, the class
 * names its fields' types, and that is exactly the walk kotlinx's generated
 * deserializer makes — so where the type is written, the record is built by
 * the class itself: its constructor, its defaults, its '@SerialName' and
 * '@JsonNames', its computed members, and at a '@Serializable(with = X)'
 * field the extension's own X.
 */
var __SERIAL = {};
/** A JsonTransformingSerializer object, to the type its base serializer decodes. */
var __TRANSFORMS = typeof WeakMap === 'function' ? new WeakMap() : null;
/** Instances built by a registration that runs a custom serializer. */
var __SERIAL_CUSTOM = typeof WeakSet === 'function' ? new WeakSet() : null;
var __SERIAL_TREES = {};

/**
 * A Kotlin type as the emitter writes it, parsed once: 'Box<List<@X|Item>?>'.
 * '@X|' is a '@Serializable(X::class)' on that type argument. Null for text
 * that is not a type, which then takes the structural walk.
 */
function __serialTree(text) {
  var source = __str(text).replace(/\\s+/g, '');
  if (Object.prototype.hasOwnProperty.call(__SERIAL_TREES, source)) return __SERIAL_TREES[source];
  var at = 0;
  function item() {
    var ser = null;
    if (source.charAt(at) === '@') {
      var bar = source.indexOf('|', at);
      if (bar === -1) throw null;
      ser = source.slice(at + 1, bar);
      at = bar + 1;
    }
    if (source.charAt(at) === '*') {
      at += 1;
      return { name: 'Any', args: [], nullable: true, ser: ser };
    }
    var name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(source.slice(at));
    if (name === null) throw null;
    at += name[0].length;
    var args = [];
    if (source.charAt(at) === '<') {
      at += 1;
      for (;;) {
        args.push(item());
        if (source.charAt(at) === ',') { at += 1; continue; }
        if (source.charAt(at) === '>') { at += 1; break; }
        throw null;
      }
    }
    var nullable = source.charAt(at) === '?';
    if (nullable) at += 1;
    return { name: name[0].replace(/^.*\\./, ''), args: args, nullable: nullable, ser: ser };
  }
  var tree = null;
  try {
    tree = item();
    if (at !== source.length) tree = null;
  } catch (error) {
    tree = null;
  }
  __SERIAL_TREES[source] = tree;
  return tree;
}

/** Whether this type reaches a registered class anywhere — else nothing changes. */
function __serialNames(tree) {
  if (Object.prototype.hasOwnProperty.call(__SERIAL, tree.name)) return true;
  for (var i = 0; i < tree.args.length; i += 1) if (__serialNames(tree.args[i])) return true;
  return false;
}

var __SERIAL_LISTS = { List: 1, MutableList: 1, ArrayList: 1, Collection: 1, Iterable: 1, Array: 1,
  Set: 1, MutableSet: 1, HashSet: 1, LinkedHashSet: 1 };
var __SERIAL_MAPS = { Map: 1, MutableMap: 1, HashMap: 1, LinkedHashMap: 1 };
var __SERIAL_PRIMITIVES = { String: 'string', Char: 'string', Int: 'int', Long: 'int', Short: 'int',
  Byte: 'int', Double: 'double', Float: 'double', Boolean: 'boolean' };
var __SERIAL_ELEMENTS = { JsonElement: 1, JsonObject: 1, JsonArray: 1, JsonPrimitive: 1, JsonNull: 1 };

function __serialMissing(path) {
  return new Error(
    'This converted extension expected "' + path + '" to be present in the response, and it was not.'
  );
}

/**
 * One value, decoded as this type. 'bound' maps the enclosing class's type
 * parameters to the trees they were given; 'custom' is the enclosing
 * registration's serializers, for a '@X|' on a type argument.
 */
function __serialDecode(tree, raw, path, bound, custom) {
  if (tree.ser !== null) {
    if (raw === null && tree.nullable) return null;
    return __serialRun(tree.ser, custom, raw, path);
  }
  if (Object.prototype.hasOwnProperty.call(bound, tree.name) && tree.args.length === 0) {
    var given = bound[tree.name];
    return raw === null && tree.nullable ? null : __serialDecode(given, raw, path, {}, custom);
  }
  if (raw === null || raw === undefined) {
    if (tree.nullable || tree.name === 'Any' || tree.name === 'JsonElement' ||
        tree.name === 'JsonPrimitive' || tree.name === 'JsonNull') {
      return raw === undefined ? null : raw;
    }
    throw __serialMissing(path);
  }
  var primitive = __SERIAL_PRIMITIVES[tree.name];
  if (primitive !== undefined) return __decodePrimitive(primitive, raw, path);
  if (__SERIAL_ELEMENTS[tree.name] === 1) return raw;
  var i;
  if (__SERIAL_LISTS[tree.name] === 1) {
    var element = tree.args.length > 0 ? tree.args[0] : null;
    // The structural walk's leniency, kept so this path decodes no less than
    // it did: a single value where a list was declared is a list of one.
    var items = Array.isArray(raw) ? raw : [raw];
    var list = [];
    for (i = 0; i < items.length; i += 1) {
      list.push(element === null ? items[i] : __serialDecode(element, items[i], path + '[' + i + ']', bound, custom));
    }
    return list;
  }
  if (__SERIAL_MAPS[tree.name] === 1) {
    var held = tree.args.length > 1 ? tree.args[1] : null;
    var map = {};
    if (typeof raw !== 'object' || Array.isArray(raw)) return map;
    for (var key in raw) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      map[key] = held === null ? raw[key] : __serialDecode(held, raw[key], path + '.' + key, bound, custom);
    }
    return map;
  }
  var registration = __SERIAL[tree.name];
  if (registration === undefined) {
    // A class this module did not declare '@Serializable' — the structural
    // walk decides it, as it decided everything before.
    return __applyShapes(__decodeValue('any', raw, path), 0);
  }
  var args = [];
  for (i = 0; i < tree.args.length; i += 1) {
    var arg = tree.args[i];
    args.push(arg.args.length === 0 && Object.prototype.hasOwnProperty.call(bound, arg.name) ? bound[arg.name] : arg);
  }
  return __serialObject(registration, args, raw, path);
}

/** A registered class, built from one JSON object by its own constructor. */
function __serialObject(registration, typeArgs, raw, path) {
  var meta = registration.meta;
  if (meta.with !== null) return __serialRun(meta.with, registration.custom, raw, path);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('This converted extension expected "' + path + '" to be a JSON object.');
  }
  var bound = {};
  for (var p = 0; p < meta.params.length; p += 1) {
    bound[meta.params[p]] = p < typeArgs.length ? typeArgs[p] : { name: 'Any', args: [], nullable: true, ser: null };
  }
  var args = [];
  for (var i = 0; i < meta.fields.length; i += 1) {
    args.push(__serialField(registration, meta.fields[i], raw, path, bound, true));
  }
  var built = registration.make(args);
  for (var b = 0; b < meta.body.length; b += 1) {
    var value = __serialField(registration, meta.body[b], raw, path, bound, false);
    if (value !== undefined) built[meta.body[b][0]] = value;
  }
  if (registration.custom !== null && __SERIAL_CUSTOM !== null && built !== null && typeof built === 'object') {
    __SERIAL_CUSTOM.add(built);
  }
  return built;
}

/**
 * One field: [name, wireNames, type, hasDefault, serializer, transient,
 * encodeDefault] — the last is the property's '@EncodeDefault' mode, which only
 * the encoder reads (see '__serialEncodeObject').
 *
 * Undefined means "use the declared default" — the constructor's own default
 * parameter, which is where the emitter put it. An absent field with no
 * default is kotlinx's MissingFieldException, except that a nullable one is
 * null, which is what every extension's 'explicitNulls = false' asks for. A
 * null where the type is not nullable takes the default when there is one,
 * which is 'coerceInputValues'.
 */
function __serialField(registration, field, raw, path, bound, required) {
  var name = field[0];
  var tree = __serialTree(field[2]) || { name: 'Any', args: [], nullable: true, ser: null };
  var where = path + '.' + name;
  var found = false;
  var value;
  if (field[5] !== true) {
    for (var w = 0; w < field[1].length; w += 1) {
      if (Object.prototype.hasOwnProperty.call(raw, field[1][w])) {
        found = true;
        value = raw[field[1][w]];
        break;
      }
    }
  }
  if (!found) {
    if (field[3] || !required) return undefined;
    if (tree.nullable) return null;
    throw __serialMissing(where);
  }
  if (field[4] === '@Contextual') {
    // kotlinx would ask the Json's serializersModule, which is not here. It
    // only asks when the key is present, and so does this.
    throw new Error(
      'This converted extension decoded "' + where + '", a @Contextual field, whose serializer only the Json configuration of the extension knows.'
    );
  }
  if (value === null && !tree.nullable) {
    if (field[3]) return undefined;
    if (field[4] === null && tree.ser === null) throw __serialMissing(where);
  }
  if (field[4] !== null) {
    if (value === null && tree.nullable) return null;
    return __serialRun(field[4], registration.custom, value, where);
  }
  return __serialDecode(tree, value, where, bound, registration.custom);
}

/**
 * The extension's own serializer, over one JSON value.
 *
 * Two kinds occur, and both are run exactly as kotlinx runs them. A
 * JsonTransformingSerializer reshapes the element with its own
 * 'transformDeserialize' and hands the result to its base serializer — which
 * the emitter only accepted when it was built from default serializers, and
 * recorded as the type it decodes (see '__k.transforms'). A KSerializer's
 * 'deserialize' is handed a JsonDecoder over the value and answers the value
 * itself. Anything else is refused here by name rather than read past.
 */
function __serialRun(name, custom, raw, path) {
  var lookup = custom === null ? undefined : custom[name];
  var serializer = typeof lookup === 'function' ? lookup() : undefined;
  if (serializer === null || serializer === undefined) {
    throw new Error('This converted extension decodes "' + path + '" with ' + name + ', which is not in this bundle.');
  }
  var decodes = __TRANSFORMS === null ? undefined : __TRANSFORMS.get(serializer);
  var out;
  if (decodes !== undefined) {
    var shaped = typeof serializer.transformDeserialize === 'function'
      ? serializer.transformDeserialize(raw === undefined ? null : raw)
      : raw;
    if (__thenable(shaped)) {
      throw new Error('This converted extension decodes with ' + name + ', and it suspends, which kotlinx cannot do either.');
    }
    var tree = __serialTree(decodes);
    if (tree === null) throw new Error('This converted extension decodes "' + path + '" as ' + decodes + '.');
    return __serialDecode(tree, shaped, path, {}, custom);
  }
  if (typeof serializer.deserialize === 'function') {
    out = serializer.deserialize(__jsonDecoder(raw === undefined ? null : raw, path));
    if (__thenable(out)) {
      throw new Error('This converted extension decodes with ' + name + ', and it suspends, which kotlinx cannot do either.');
    }
    return out;
  }
  throw new Error(
    'This converted extension decodes "' + path + '" with ' + name +
    ', which is neither a JsonTransformingSerializer nor a KSerializer this runtime can run.'
  );
}

/**
 * kotlinx's JsonDecoder over one value — the decoder a KSerializer's
 * 'deserialize' is handed. 'decodeJsonElement' is how nearly every hand-written
 * one starts; the primitive reads are kotlinx's own, over the same accessors
 * '.int' and '.content' use. A structured read ('beginStructure',
 * 'decodeSerializableValue') refuses by name: it needs descriptors this
 * runtime does not build.
 */
function __jsonDecoder(raw, path) {
  function refuse(what) {
    return function () {
      throw new Error('This converted extension decoded "' + path + '" with a serializer calling ' + what +
        ', which this runtime does not implement.');
    };
  }
  return {
    __kJsonDecoder: true,
    json: typeof Json === 'undefined' ? null : Json,
    decodeJsonElement: function () { return raw; },
    decodeString: function () {
      if (typeof raw === 'string') return raw;
      throw new Error('This converted extension expected "' + path + '" to be a string.');
    },
    decodeInt: function () { return __jeNumber(raw, 'int', true, false); },
    decodeLong: function () { return __jeNumber(raw, 'long', true, false); },
    decodeShort: function () { return __jeNumber(raw, 'int', true, false); },
    decodeByte: function () { return __jeNumber(raw, 'int', true, false); },
    decodeDouble: function () { return __jeNumber(raw, 'double', false, false); },
    decodeFloat: function () { return __jeNumber(raw, 'float', false, false); },
    decodeBoolean: function () { return __jeBoolean(raw, 'boolean', false); },
    decodeChar: function () { return __jeContent(raw, 'char').charAt(0); },
    decodeNull: function () { return null; },
    decodeNotNullMark: function () { return raw !== null; },
    beginStructure: refuse('beginStructure'),
    decodeSerializableValue: refuse('decodeSerializableValue'),
    decodeInline: refuse('decodeInline')
  };
}

/* --- keiyoushi core's Next.js extraction ---------------------------------- */

/**
 * keiyoushi core's extractNextJs<T>() and extractNextJsRsc<T>(), ported.
 *
 * A Next.js page carries its data as React Flight rows: pushed into
 * 'self.__next_f' by inline scripts (the App Router), or as one JSON document
 * in 'script#__NEXT_DATA__' (the Pages Router), or as the raw 'text/x-component'
 * body of a client navigation. The helper finds the rows, resolves the
 * references between them, walks the result depth-first and decodes the first
 * object or array its predicate accepts as T.
 *
 * Ported from the repository's own core/utils/NextJs.kt line for line, because
 * every choice in it is a fact about React Flight's wire format: which '$'
 * markers mean what, that a 'T' row's length is in UTF-8 bytes rather than
 * characters, and that a React element tuple is walked by 'type'/'key'/'props'.
 * A JsonElement here is a plain value, as it is everywhere else in this
 * runtime; the two JSON parsers agree on every document these rows hold.
 */
var __NEXT_F = /self\\.__next_f\\.push\\(\\s*(\\[.*])\\s*\\)\\s*;?\\s*$/s;

function __nextIsContainer(value) {
  return value !== null && typeof value === 'object';
}

function __nextHas(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function __nextFind(payload, predicate) {
  if (!__nextIsContainer(payload)) return undefined;
  if (predicate(payload) === true) return payload;
  var children = Array.isArray(payload)
    ? payload
    : Object.keys(payload).map(function (key) { return payload[key]; });
  for (var i = 0; i < children.length; i += 1) {
    var found = __nextFind(children[i], predicate);
    if (found !== undefined) return found;
  }
  return undefined;
}

function __nextResolve(element, chunks, models, resolving) {
  if (Array.isArray(element)) {
    return element.map(function (item) { return __nextResolve(item, chunks, models, resolving); });
  }
  if (__nextIsContainer(element)) {
    var out = {};
    for (var key in element) {
      if (__nextHas(element, key)) out[key] = __nextResolve(element[key], chunks, models, resolving);
    }
    return out;
  }
  if (typeof element !== 'string' || element.charAt(0) !== '$' || element.length < 2) return element;
  if (element === '$undefined') return null;
  if (element === '$Infinity' || element === '$-Infinity' || element === '$NaN' || element === '$-0') {
    return element.substring(1);
  }
  var marker = element.charAt(1);
  var resolved;
  if (marker === '$') return element.substring(1);
  if (marker === 'D' || marker === 'n') return element.substring(2);
  if (marker === 'Q') resolved = __nextMapRef(element.substring(2), chunks, models, resolving);
  else if (marker === 'W') resolved = __nextSetRef(element.substring(2), chunks, models, resolving);
  else if (marker === 'L' || marker === '@') {
    resolved = __nextModelRef(element.substring(2), chunks, models, resolving);
  } else resolved = __nextModelRef(element.substring(1), chunks, models, resolving);
  return resolved === null ? element : resolved;
}

function __nextModelRef(reference, chunks, models, resolving) {
  var segments = reference.split(':');
  var id = segments[0];
  if (segments.length === 1 && __nextHas(chunks, id)) return chunks[id];
  if (resolving.indexOf(id) !== -1) return null;
  var guard = resolving.concat([id]);
  if (!__nextHas(models, id)) return null;
  var value = models[id];
  for (var i = 1; i < segments.length; i += 1) {
    if (typeof value === 'string' && value.charAt(0) === '$') {
      value = __nextResolve(value, chunks, models, guard);
    }
    value = __nextWalk(value, segments[i]);
    if (value === undefined) return null;
  }
  return __nextResolve(value, chunks, models, guard);
}

function __nextIndex(value, segment) {
  if (!/^[-+]?\\d+$/.test(segment)) return undefined;
  var at = Number(segment);
  return at >= 0 && at < value.length ? value[at] : undefined;
}

function __nextWalk(value, segment) {
  if (Array.isArray(value)) {
    if (value.length >= 4 && value[0] === '$') {
      if (segment === 'type') return value[1];
      if (segment === 'key') return value[2];
      if (segment === 'props') return value[3];
    }
    return __nextIndex(value, segment);
  }
  if (__nextIsContainer(value)) return __nextHas(value, segment) ? value[segment] : undefined;
  return undefined;
}

function __nextMapRef(id, chunks, models, resolving) {
  if (resolving.indexOf(id) !== -1) return null;
  var entries = __nextHas(models, id) ? models[id] : null;
  if (!Array.isArray(entries)) return null;
  var resolved = __nextResolve(entries, chunks, models, resolving.concat([id]));
  if (!Array.isArray(resolved)) return null;
  var out = {};
  for (var i = 0; i < resolved.length; i += 1) {
    var pair = resolved[i];
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    var key = __nextIsContainer(pair[0]) ? JSON.stringify(pair[0]) : String(pair[0]);
    out[key] = pair[1];
  }
  return out;
}

function __nextSetRef(id, chunks, models, resolving) {
  if (resolving.indexOf(id) !== -1) return null;
  var values = __nextHas(models, id) ? models[id] : null;
  if (!Array.isArray(values)) return null;
  return __nextResolve(values, chunks, models, resolving.concat([id]));
}

/** A JSON value starting at 'start', and where it ends; element null when it did not parse. */
function __nextJsonAt(body, start) {
  if (start >= body.length) return [null, start];
  var depth = 0;
  var inString = false;
  var escape = false;
  var i = start;
  while (i < body.length) {
    var c = body.charAt(i);
    i += 1;
    if (escape) { escape = false; continue; }
    if (c === '\\\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) {
        try {
          return [JSON.parse(body.substring(start, i)), i];
        } catch (error) {
          return [null, i];
        }
      }
    }
    if (depth === 0 && /\\s/.test(c)) {
      try {
        return [JSON.parse(body.substring(start, i - 1)), i];
      } catch (error) {
        return [null, i];
      }
    }
  }
  return [null, i];
}

function __nextRscPayloads(body, chunks, models) {
  var results = [];
  var pos = 0;
  while (pos < body.length) {
    var colon = body.indexOf(':', pos);
    if (colon === -1) break;
    var id = body.substring(pos, colon);
    if (!/^[0-9a-fA-F]+$/.test(id)) {
      pos += 1;
      continue;
    }
    pos = colon + 1;
    if (pos >= body.length) break;

    if (body.charAt(pos) === 'T') {
      // A text row: 'T<hex byte length>,<content>'. The length counts UTF-8
      // bytes, so a character outside ASCII is two or three of them and a
      // surrogate pair is four.
      pos += 1;
      var comma = body.indexOf(',', pos);
      if (comma === -1) break;
      var lengthText = body.substring(pos, comma);
      if (!/^[-+]?[0-9a-fA-F]+$/.test(lengthText)) break;
      var byteLength = parseInt(lengthText, 16);
      pos = comma + 1;
      var bytes = 0;
      var start = pos;
      while (pos < body.length && bytes < byteLength) {
        var code = body.charCodeAt(pos);
        if (code < 0x80) bytes += 1;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
          bytes += 4;
          pos += 1;
        } else bytes += 3;
        pos += 1;
      }
      var content = body.substring(start, pos);
      chunks[id] = content;
      try {
        results.push(JSON.parse(content));
      } catch (error) {
        /* A text row that is not JSON is still a chunk a reference can name. */
      }
    } else {
      var parsed = __nextJsonAt(body, pos);
      if (parsed[0] !== null) {
        results.push(parsed[0]);
        models[id] = parsed[0];
      }
      pos = parsed[1];
    }
  }
  return results;
}

function __nextAppRouter(document, chunks, models) {
  var out = [];
  var scripts = __arr(document.select('script'));
  for (var i = 0; i < scripts.length; i += 1) {
    if (scripts[i].hasAttr('src')) continue;
    var script = __str(scripts[i].data());
    if (script.indexOf('self.__next_f.push') === -1) continue;
    try {
      var found = __NEXT_F.exec(script);
      if (found === null) continue;
      var row = JSON.parse(found[1]);
      if (!Array.isArray(row)) continue;
      var content = row.length > 1 ? row[1] : null;
      if (content === null || content === undefined || __nextIsContainer(content)) continue;
      out = out.concat(__nextRscPayloads(String(content), chunks, models));
    } catch (error) {
      /* A script this cannot read contributes nothing, as upstream's does. */
    }
  }
  return out;
}

function __nextPagesRouter(document) {
  var script = document.selectFirst('script#__NEXT_DATA__');
  if (script === null || script === undefined) return [];
  try {
    var root = JSON.parse(__str(script.data()));
    if (!__nextIsContainer(root) || Array.isArray(root)) return [];
    var props = root.props;
    // A JSON null there is not an object, and upstream's jsonObject throws on it.
    if (props === null) return [];
    if (props !== undefined && (!__nextIsContainer(props) || Array.isArray(props))) return [];
    var pageProps = props === undefined || props === null ? undefined : props.pageProps;
    return pageProps === undefined || pageProps === null ? [root] : [pageProps, root];
  } catch (error) {
    return [];
  }
}

/**
 * The predicate upstream infers from T: every field that is neither optional
 * nor nullable is present, under its own name or an alternative one. Read off
 * the shape the emitter registered for T, and refused rather than guessed when
 * there is none — a predicate that matched anything would decode the page's
 * first object as the title.
 */
function __nextInferred(type) {
  var text = __str(type).trim().replace(/\\?$/, '');
  var list = /^(?:[\\w.]*\\.)?(?:List|MutableList|ArrayList)\\s*<(.*)>$/.exec(text);
  var element = (list === null ? text : list[1]).trim().replace(/\\?$/, '').replace(/^.*\\./, '');
  var required = [];
  // The registration every '@Serializable' class now carries is kotlinx's own
  // descriptor, so it is read first and exactly as upstream reads one: an
  // element is required unless it has a default or a nullable type, and it is
  // present under its '@SerialName' or any of its '@JsonNames'. The shapes
  // below are registered only for a class with a rename or a computed field,
  // so a plain DTO had none and was refused for a predicate it plainly has.
  var registration = Object.prototype.hasOwnProperty.call(__SERIAL, element) ? __SERIAL[element] : null;
  if (registration !== null && registration.meta.with === null) {
    var elements = registration.meta.fields.concat(registration.meta.body);
    for (var e = 0; e < elements.length; e += 1) {
      var described = elements[e];
      if (described[5] === true || described[3] === true) continue;
      if (/\\?$/.test(__str(described[2]).replace(/\\s+/g, ''))) continue;
      required.push(described[1].slice());
    }
    return __nextRequired(element, required, list !== null);
  }
  var shape = null;
  for (var s = 0; s < __SHAPES.length; s += 1) {
    var ctor = __SHAPES[s].ctor;
    if (typeof ctor !== 'function' || ctor.name !== element) continue;
    if (shape !== null) throw new Error('Cannot infer a predicate for ' + element + ': two classes share its name.');
    shape = __SHAPES[s];
  }
  if (shape === null) {
    throw new Error('Cannot infer a predicate for ' + element + ': this conversion has no @Serializable declaration of it.');
  }
  for (var f = 0; f < shape.fields.length; f += 1) {
    var field = shape.fields[f];
    if (shape.optional.indexOf(field) !== -1) continue;
    var names = [field];
    for (var alias in shape.aliases) {
      if (__nextHas(shape.aliases, alias) && shape.aliases[alias] === field) names.push(alias);
    }
    required.push(names);
  }
  return __nextRequired(element, required, list !== null);
}

/** The predicate over a set of required keys, each present under one of its names. */
function __nextRequired(element, required, isList) {
  if (required.length === 0) {
    throw new Error(
      'Cannot infer a predicate for ' + element +
      ': all fields are optional or nullable. Provide an explicit predicate instead.'
    );
  }
  var fits = function (value) {
    if (!__nextIsContainer(value) || Array.isArray(value)) return false;
    return required.every(function (names) {
      return names.some(function (name) { return __nextHas(value, name); });
    });
  };
  return !isList
    ? fits
    : function (value) { return Array.isArray(value) && value.length > 0 && fits(value[0]); };
}

function __nextDecode(payloads, chunks, models, type, predicate) {
  var test = typeof predicate === 'function' ? predicate : __nextInferred(type);
  for (var i = 0; i < payloads.length; i += 1) {
    var resolved = __nextResolve(payloads[i], chunks, models, []);
    var found = __nextFind(resolved, function (value) { return test(value) === true; });
    if (found !== undefined) {
      var typed = __serialTree(type);
      if (typed !== null && __serialNames(typed)) return __serialDecode(typed, found, 'data', {});
      return __applyShapes(__decodeValue(__typeKind(type, undefined), found, 'data'), 0);
    }
  }
  return null;
}

/** String.extractNextJsRsc<T>(predicate?): a raw 'text/x-component' body. */
__k.extractNextJsRsc = function (body, type, predicate) {
  var chunks = {};
  var models = {};
  var payloads = __nextRscPayloads(__str(body), chunks, models);
  return __nextDecode(payloads, chunks, models, type, predicate);
};

/**
 * Document.extractNextJs<T>(predicate?) and Response.extractNextJs<T>(predicate?).
 *
 * A Response is dispatched on its Content-Type exactly as upstream does: a
 * flight body as one, an HTML page as a document, anything else refused by
 * name rather than parsed as whichever it looked more like.
 */
__k.extractNextJs = function (receiver, type, predicate) {
  if (receiver === null || receiver === undefined) {
    throw new Error('This converted extension looked for Next.js data in nothing.');
  }
  if (typeof receiver.select !== 'function' && receiver.body !== undefined) {
    var headers = receiver.headers;
    var contentType = headers && typeof headers.get === 'function' ? __str(headers.get('Content-Type') || '') : '';
    if (contentType.indexOf('text/x-component') !== -1) {
      return __k.extractNextJsRsc(receiver.body.string(), type, predicate);
    }
    if (contentType.indexOf('text/html') === -1) {
      throw new Error('Unsupported Content-Type for Next.js extraction: ' + contentType);
    }
    receiver = __k.asJsoup(receiver);
  }
  var chunks = {};
  var models = {};
  var payloads = __nextAppRouter(receiver, chunks, models);
  if (payloads.length === 0) payloads = __nextPagesRouter(receiver);
  return __nextDecode(payloads, chunks, models, type, predicate);
};

/**
 * kotlinx's Json, both as an object and as the builder call that configures it.
 *
 * 'Json { ignoreUnknownKeys = true }' translates to a call, and unknown keys
 * are ignored here regardless, so the configuration is accepted and discarded.
 */
function Json() { return Json; }
Json.decodeFromString = function (descriptor, text) { return __k.decode(descriptor, text); };
Json.encodeToString = function (value) {
  // kotlinx's two-argument form names the serializer to encode with, and this
  // runtime runs serializers only for decoding. Stringifying the serializer
  // object instead would post it.
  if (arguments.length > 1) {
    throw new Error(
      'This converted extension encoded a value with an explicit serializer, which this runtime only runs for decoding.'
    );
  }
  return JSON.stringify(value);
};
Json.parseToJsonElement = function (text) { return __k.decode('any', text); };
`;

/**
 * Preferences: what the extension declares, and what the viewer chose.
 *
 * This used to be read-only and collapse to whatever default the extension
 * wrote down, because a converted bundle declared no settings and so the host
 * had nothing to draw and nothing to store. It declares them now — the
 * conversion reads `setupPreferenceScreen` and emits a manifest `settings`
 * block (`foreign/preferences.ts`) — so the layering here is real: what this
 * run wrote, then what the viewer chose, then what the screen declared, then
 * what the call site asked for.
 *
 * The last of those four is what a bundle carrying no settings lands on, which
 * is the whole of the old behaviour and is deliberately still reachable: an
 * already-installed bundle declares nothing and must keep working exactly as it
 * did.
 *
 * The preference *types* are here because `FOREIGN.md` §4.1.6 ranks the Android
 * preference framework as blocking 31 extensions in one catalogue — not because
 * anything renders them. A plugin never draws UI (`ABI.md` §1); what these
 * classes buy is that an extension mentioning the framework anywhere the host
 * actually calls now translates instead of being refused.
 *
 * Ported from the published `androidx.preference` and `android.content`
 * compatibility surfaces (Apache-2.0; see the repo-root `NOTICE`). Behaviour,
 * not text: the property names are the framework's because extensions assign
 * them directly, and everything behind them is this sandbox's own.
 */
export const KOTLIN_PREFS = `
/**
 * android.util.Log, which an extension leaves in and the runtime has to answer.
 *
 * These calls are diagnostics, not behaviour — 'Log.d("fetchVideoList", url)'
 * sits in the middle of a working video resolver — so an absent Log is a
 * ReferenceError in the one place it can do the most damage. Every level goes
 * to the host log, guarded the way printStackTrace is: a diagnostic that can
 * fail is worse than no diagnostic.
 */
var Log = (function () {
  function write(level, tag, message) {
    try {
      var host = __host();
      var line = __str(tag) + ': ' + __str(message);
      if (host.log && typeof host.log[level] === 'function') host.log[level](line);
      else if (host.log && typeof host.log.debug === 'function') host.log.debug(line);
    } catch (ignored) {
      // Outside a plugin call, or a host with no logger. Nothing to report to.
    }
    return 0;
  }
  return {
    v: function (tag, message) { return write('debug', tag, message); },
    d: function (tag, message) { return write('debug', tag, message); },
    i: function (tag, message) { return write('debug', tag, message); },
    w: function (tag, message) { return write('warn', tag, message); },
    e: function (tag, message) { return write('warn', tag, message); },
    wtf: function (tag, message) { return write('warn', tag, message); }
  };
})();

/**
 * kotlin.random.Random.
 *
 * Deliberately Math.random and not a crypto source: kotlin.random.Random makes
 * no security promise either, and an extension that wants one spells it
 * SecureRandom - which is a separate name below, answered by ctx.crypto's
 * getRandomValues. Answering *this* name with a crypto source would cost
 * entropy for nothing; answering the other one with Math.random would be the
 * silent kind of wrong this runtime refuses to be, which is why they are two.
 *
 * nextBytes fills IN PLACE and answers the same array, as Kotlin does, because
 * the idiom is ByteArray(16).also(Random::nextBytes) and also() hands back its
 * receiver. Values are signed, which is what a Kotlin ByteArray holds.
 */
/**
 * java.net.URLEncoder and URLDecoder.
 *
 * Not encodeURIComponent. Java encodes application/x-www-form-urlencoded, and
 * the two disagree in six places that all appear in real query strings: a space
 * becomes + rather than %20, and the marks ! ~ ( ) and the apostrophe are
 * escaped here where
 * encodeURIComponent leaves them alone. A signature computed over one spelling
 * and sent in the other is simply rejected, so the difference is the whole
 * point of implementing it rather than aliasing it.
 *
 * The charset argument is accepted and checked rather than ignored: Java takes
 * any charset name, and every use in this ecosystem passes UTF-8. Encoding
 * something else as UTF-8 would produce a different string, so anything else
 * refuses instead.
 */
/**
 * java.util.Arrays, the static methods this ecosystem's crypto helpers use.
 *
 * 'copyOfRange' pads with zeros past the end, exactly as Java does — a caller
 * that asks for 16 bytes of an 8-byte array gets 16 there, and a 'slice' here
 * would have answered 8 and derived a short key without saying so.
 */
/**
 * okhttp's 'Interceptor', as a name rather than as behaviour.
 *
 * An extension writes 'object : Interceptor { override fun intercept(chain) }'
 * or 'class RateLimit : Interceptor'. Neither inherits anything — the member
 * is the whole interface — so what this has to do is exist, and answer
 * 'instanceof' for anything carrying that member.
 */
var Interceptor = {};
Object.defineProperty(Interceptor, Symbol.hasInstance, {
  value: function (value) { return __k.hasMembers(value, ['intercept']); }
});

var Arrays = {
  copyOfRange: function (source, from, to) {
    var items = __arr(source);
    var out = new Array(Math.max(0, to - from));
    for (var i = from; i < to; i += 1) out[i - from] = i < items.length ? items[i] : 0;
    return source instanceof Uint8Array ? Uint8Array.from(out) : out;
  },
  copyOf: function (source, length) { return Arrays.copyOfRange(source, 0, length); },
  /* Both Java overloads: fill(a, v) and fill(a, from, to, v). */
  fill: function (target, a, b, c) {
    var value = c === undefined ? a : c;
    var from = c === undefined ? 0 : a;
    var to = c === undefined ? target.length : b;
    for (var i = from; i < to; i += 1) target[i] = value;
    return target;
  },
  equals: function (a, b) {
    var left = __arr(a);
    var right = __arr(b);
    if (left.length !== right.length) return false;
    for (var i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false;
    return true;
  },
  asList: function (items) { return __arr(items).slice(); },
  toString: function (items) { return '[' + __arr(items).join(', ') + ']'; }
};

var URLEncoder = {
  encode: function (value, charset) {
    __requireUtf8(charset, 'URLEncoder');
    return encodeURIComponent(__str(value))
      .replace(/%20/g, '+')
      .replace(/[!'()~]/g, function (character) {
        return '%' + character.charCodeAt(0).toString(16).toUpperCase();
      });
  }
};

var URLDecoder = {
  decode: function (value, charset) {
    __requireUtf8(charset, 'URLDecoder');
    // The + must go back to a space before decoding, or a literal %2B would
    // come out as a space too.
    try {
      return decodeURIComponent(__str(value).replace(/\\+/g, ' '));
    } catch (error) {
      // Java throws on a malformed escape as well; answering the input would
      // hand back something that is neither encoded nor decoded.
      return __k.unsupported('This converted extension decoded a malformed percent escape.');
    }
  }
};

function __requireUtf8(charset, which) {
  if (charset === undefined || charset === null) return;
  var name = __str(charset).toUpperCase().replace(/-/g, '');
  if (name.length === 0 || name === 'UTF8') return;
  __k.unsupported(
    'This converted extension asked ' + which + ' for the ' + __str(charset) +
      ' charset, and this build only has UTF-8.'
  );
}

/**
 * kotlin.random.Random's default instance, which is also what java.util's
 * 'Random()' constructs here: 'val random = Random(); random.nextInt(n)'.
 * Callable for that reason. A SEEDED 'Random(seed)' is refused: a seed asks
 * for one reproducible sequence — a descrambler reorders tiles by it — and
 * this generator cannot give it, so answering any sequence would be a wrong
 * image rather than an error.
 */
function Random(seed) {
  if (seed !== undefined && seed !== null) {
    throw new Error('This converted extension seeded a Random, and this build cannot reproduce a seeded sequence.');
  }
  return Random;
}
Object.assign(Random, {
  nextBytes: function (array) {
    var bytes = __arr(array);
    for (var i = 0; i < bytes.length; i += 1) {
      var byte = Math.floor(Math.random() * 256);
      array[i] = byte > 127 ? byte - 256 : byte;
    }
    return array;
  },
  nextInt: function (from, until) {
    if (from === undefined) return Math.floor(Math.random() * 0x100000000) - 0x80000000;
    if (until === undefined) return Math.floor(Math.random() * Number(from));
    return Number(from) + Math.floor(Math.random() * (Number(until) - Number(from)));
  },
  nextLong: function (from, until) { return Random.nextInt(from, until); },
  nextDouble: function () { return Math.random(); },
  nextBoolean: function () { return Math.random() < 0.5; }
});

/**
 * java.security.MessageDigest, over MD5, SHA-1 and SHA-256.
 *
 * A hash is the one piece of java.security that can be answered honestly here.
 * It is a pure function of its bytes — no key, no IV, no mode, nothing the
 * sandbox cannot supply — which is exactly what separates it from the
 * javax.crypto surface next door, where a missing key would have to be invented.
 *
 * Every real use in this catalogue is a REQUEST SIGNATURE: concatenate a salt,
 * a timestamp and a path, hash it, hex it, and put the result in a header or a
 * query parameter so the source accepts the request. So the output has to be
 * bit-identical to the JVM or the request is refused at the far end, which is
 * why these are the published algorithms rather than an approximation.
 *
 * Answers UNSIGNED bytes. Kotlin's ByteArray is signed, but every caller here
 * spells the digest with "%02x", and the formatter widens a negative number
 * rather than masking it — a signed -56 would print "ffffffc8" instead of "c8"
 * and silently corrupt every signature.
 *
 * An algorithm this does not implement is refused through __k.unsupported,
 * NOT by returning null: getInstance in this ecosystem sits inside a
 * runCatching that answers null on failure, so a throwable the extension can
 * catch would look like "the hash could not be computed" and let it carry on
 * with an unsigned request. The refusal has to be the host's, not the
 * extension's to swallow.
 */
var MessageDigest = {
  getInstance: function (algorithm) {
    var name = __str(algorithm).toUpperCase().replace(/-/g, '');
    var compute =
      name === 'MD5' ? __md5 : name === 'SHA1' ? __sha1 : name === 'SHA256' ? __sha256 : null;
    if (compute === null) {
      __k.unsupported(
        'This converted extension asked for the ' + __str(algorithm) +
          ' digest, which this build does not implement.'
      );
    }
    var pending = [];
    return {
      update: function (bytes) { pending = pending.concat(__digestBytes(bytes)); return this; },
      reset: function () { pending = []; return this; },
      digest: function (bytes) {
        var input = bytes === undefined || bytes === null ? pending : pending.concat(__digestBytes(bytes));
        pending = [];
        return compute(input);
      }
    };
  }
};

/** Whatever a caller hands a digest, as an array of unsigned bytes. */
function __digestBytes(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return Array.prototype.slice.call(__host().text.encode(value));
  var items = __arr(value);
  var out = [];
  for (var i = 0; i < items.length; i += 1) out.push(Number(items[i]) & 0xff);
  return out;
}

/** The 64-byte-block padding MD5, SHA-1 and SHA-256 all share. */
function __digestPad(bytes, littleEndian) {
  var padded = bytes.slice();
  var bits = bytes.length * 8;
  padded.push(0x80);
  while (padded.length % 64 !== 56) padded.push(0);
  var length = [];
  for (var i = 0; i < 8; i += 1) {
    length.push(Math.floor(bits / Math.pow(2, 8 * i)) & 0xff);
  }
  if (!littleEndian) length.reverse();
  return padded.concat(length);
}

function __md5(bytes) {
  var padded = __digestPad(bytes, true);
  var a = 0x67452301, b = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
  var rotate = function (value, shift) { return (value << shift) | (value >>> (32 - shift)); };
  for (var block = 0; block < padded.length; block += 64) {
    var words = [];
    for (var w = 0; w < 16; w += 1) {
      var at = block + w * 4;
      words.push(
        padded[at] | (padded[at + 1] << 8) | (padded[at + 2] << 16) | (padded[at + 3] << 24)
      );
    }
    var oa = a, ob = b, oc = c, od = d;
    for (var i = 0; i < 64; i += 1) {
      var f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      var tmp = d;
      d = c;
      c = b;
      var sum = (a + f + MD5_K[i] + words[g]) | 0;
      b = (b + rotate(sum, MD5_S[i])) | 0;
      a = tmp;
    }
    a = (a + oa) | 0; b = (b + ob) | 0; c = (c + oc) | 0; d = (d + od) | 0;
  }
  var out = [];
  var word = [a, b, c, d];
  for (var n = 0; n < 4; n += 1) {
    for (var byte = 0; byte < 4; byte += 1) out.push((word[n] >>> (8 * byte)) & 0xff);
  }
  return out;
}

var MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
];

var MD5_K = (function () {
  var out = [];
  for (var i = 0; i < 64; i += 1) out.push((Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0));
  return out;
})();

function __sha1(bytes) {
  var padded = __digestPad(bytes, false);
  var h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  var rotate = function (value, shift) { return (value << shift) | (value >>> (32 - shift)); };
  for (var block = 0; block < padded.length; block += 64) {
    var w = [];
    for (var i = 0; i < 16; i += 1) {
      var at = block + i * 4;
      w.push((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]);
    }
    for (var t = 16; t < 80; t += 1) {
      w.push(rotate(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1));
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for (var s = 0; s < 80; s += 1) {
      var f, k;
      if (s < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (s < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (s < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      var next = (rotate(a, 5) + f + e + k + w[s]) | 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = next;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0; h[4] = (h[4] + e) | 0;
  }
  var out = [];
  for (var n = 0; n < 5; n += 1) {
    out.push((h[n] >>> 24) & 0xff, (h[n] >>> 16) & 0xff, (h[n] >>> 8) & 0xff, h[n] & 0xff);
  }
  return out;
}

var SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

function __sha256(bytes) {
  var padded = __digestPad(bytes, false);
  var h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ];
  var rotate = function (value, shift) { return (value >>> shift) | (value << (32 - shift)); };
  for (var block = 0; block < padded.length; block += 64) {
    var w = [];
    for (var i = 0; i < 16; i += 1) {
      var at = block + i * 4;
      w.push(((padded[at] << 24) | (padded[at + 1] << 16) | (padded[at + 2] << 8) | padded[at + 3]) >>> 0);
    }
    for (var t = 16; t < 64; t += 1) {
      var s0 = rotate(w[t - 15], 7) ^ rotate(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      var s1 = rotate(w[t - 2], 17) ^ rotate(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w.push((w[t - 16] + s0 + w[t - 7] + s1) >>> 0);
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (var s = 0; s < 64; s += 1) {
      var S1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      var ch = (e & f) ^ (~e & g);
      var t1 = (hh + S1 + ch + SHA256_K[s] + w[s]) >>> 0;
      var S0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    var next = [a, b, c, d, e, f, g, hh];
    for (var n = 0; n < 8; n += 1) h[n] = (h[n] + next[n]) >>> 0;
  }
  var out = [];
  for (var n2 = 0; n2 < 8; n2 += 1) {
    out.push((h[n2] >>> 24) & 0xff, (h[n2] >>> 16) & 0xff, (h[n2] >>> 8) & 0xff, h[n2] & 0xff);
  }
  return out;
}

/* --- javax.crypto and java.security --------------------------------------- */

/**
 * The JCE surface, answered by ctx.crypto.
 *
 * ## What this is and is not
 *
 * MessageDigest above is a pure function of its bytes, which is why it could be
 * computed here. Everything in this block has a key, and a key is a capability:
 * it is answered by the host's WebCrypto through 'ctx.crypto' (ABI.md §2) and
 * never by an implementation written in this file. Nothing here reimplements a
 * cipher, and nothing here may: a hand-rolled AES in a security-sensitive path
 * is the trade this runtime refuses to make, even to avoid an await.
 *
 * ## Asynchronous, and where that stops
 *
 * 'crypto.subtle' returns promises and javax.crypto does not, so the operations
 * that actually touch a key - doFinal, sign, verify, generateKeyPair - are
 * async, and the emitter awaits them by name (see AWAITED_HOST_METHODS in
 * subset.ts). Everything else is synchronous on purpose:
 *
 * - 'getInstance' only chooses an algorithm, so it parses and refuses here.
 * - 'init' / 'initSign' / 'initialize' only record a key and a parameter set;
 *   the import that needs a promise happens inside the operation.
 * - 'update' buffers. That is exact for Mac and Signature, whose JCE update
 *   returns void - and it is NOT exact for Cipher, whose update returns the
 *   blocks completed so far. Cipher.update therefore refuses rather than
 *   pretending, because a caller that concatenated update() and doFinal()
 *   would get the plaintext twice or not at all.
 * - a generated key pair exports its public JWK eagerly, so 'x', 'y', 'crv'
 *   and 'kty' are property reads rather than promises nobody awaits.
 *
 * ## What refuses, and why each one has to
 *
 * WebCrypto has no ECB, no DES and no raw RSA, so an extension naming
 * one is refused at CONVERSION time by the algorithm string it wrote (see
 * 'cryptoObstacle' in subset.ts). That is the refusal that matters, and it is
 * why the scanner also reads the argument of a getInstance call rather than
 * only the leaf: a conversion that never happened cannot be caught by anything.
 *
 * A transformation assembled at run time has no literal to read, so it lands
 * here and refuses through __k.unsupported. Be honest about what that is worth:
 * it throws an ordinary Error, and getInstance in this ecosystem often sits
 * inside a runCatching, which catches one. So this is a backstop that names the
 * algorithm in a log and stops THIS call, not a refusal the extension cannot
 * swallow. Returning null instead would be strictly worse — that is the JCE's
 * own "unavailable" signal and the caller is written to carry on past it.
 *
 * Mapping an unsupported mode onto a supported one is the one thing that must
 * never happen here. AES/ECB answered as AES/CBC decrypts to rubbish, reports
 * nothing, and is exactly the plausible-but-wrong output this runtime exists to
 * prevent.
 */

/** The JCE hash names, as WebCrypto spells them. Nothing else is offered. */
var CRYPTO_HASHES = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA384: 'SHA-384', SHA512: 'SHA-512' };

/** The JCE curve names, as WebCrypto spells them. */
var CRYPTO_CURVES = {
  secp256r1: 'P-256',
  prime256v1: 'P-256',
  secp384r1: 'P-384',
  secp521r1: 'P-521'
};

/** Half the raw ECDSA signature, per curve: the width of r and of s. */
var CRYPTO_COORDS = { 'P-256': 32, 'P-384': 48, 'P-521': 66 };

function __cryptoRefuse(what) {
  __k.unsupported('This converted extension asked for ' + what + ', which this build does not implement.');
}

/** A JCE digest name as WebCrypto's, or a refusal naming the one it asked for. */
function __cryptoHash(name) {
  var key = __str(name).toUpperCase().replace(/-/g, '');
  var found = CRYPTO_HASHES[key];
  if (found === undefined) __cryptoRefuse('the ' + __str(name) + ' hash');
  return found;
}

/** Bytes out, as the SIGNED numeric list a Kotlin ByteArray actually is. */
function __cryptoArray(bytes) {
  var out = [];
  for (var i = 0; i < bytes.length; i += 1) {
    var byte = bytes[i] & 0xff;
    out.push(byte > 127 ? byte - 256 : byte);
  }
  return out;
}

/**
 * java.security.SecureRandom, which is ctx.crypto.randomBytes.
 *
 * nextBytes fills IN PLACE and answers the same array, exactly as Random above
 * does and for the same reason: the idiom is ByteArray(16).also(rng::nextBytes)
 * and also() hands back its receiver.
 */
function SecureRandom() {
  return {
    nextBytes: function (bytes) {
      var target = __arr(bytes);
      var random = __host().crypto.randomBytes(target.length);
      for (var i = 0; i < target.length; i += 1) {
        target[i] = random[i] > 127 ? random[i] - 256 : random[i];
      }
      return target;
    },
    generateSeed: function (size) {
      return __cryptoArray(__host().crypto.randomBytes(Number(size)));
    },
    nextInt: function (bound) {
      var bytes = __host().crypto.randomBytes(4);
      var value = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
      if (bound === undefined) return value | 0;
      return value % Number(bound);
    },
    nextLong: function () {
      var bytes = __host().crypto.randomBytes(4);
      return ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) | 0;
    }
  };
}

/** javax.crypto.spec.SecretKeySpec, which is a key and the name of its cipher. */
function SecretKeySpec(key, algorithm) {
  return {
    __secretKey: true,
    algorithm: __str(algorithm),
    bytes: __bytesOf(key),
    getAlgorithm: function () { return __str(algorithm); },
    getEncoded: function () { return __cryptoArray(__bytesOf(key)); },
    getFormat: function () { return 'RAW'; }
  };
}

/** javax.crypto.spec.IvParameterSpec. */
function IvParameterSpec(iv) {
  return { __iv: __bytesOf(iv), __tagBits: null, getIV: function () { return __cryptoArray(__bytesOf(iv)); } };
}

/**
 * javax.crypto.spec.GCMParameterSpec(tagBits, iv).
 *
 * The tag length is carried rather than dropped: GCM with a 96-bit tag and GCM
 * with a 128-bit tag produce different ciphertext lengths, and a peer that
 * expects one and is sent the other rejects the message.
 */
function GCMParameterSpec(tagBits, iv) {
  return {
    __iv: __bytesOf(iv),
    __tagBits: Number(tagBits),
    getIV: function () { return __cryptoArray(__bytesOf(iv)); },
    getTLen: function () { return Number(tagBits); }
  };
}

/** java.security.spec.ECGenParameterSpec, whose curve name is the whole of it. */
function ECGenParameterSpec(name) {
  var curve = CRYPTO_CURVES[__str(name)];
  if (curve === undefined) __cryptoRefuse('the ' + __str(name) + ' curve');
  return { __curve: curve, getName: function () { return __str(name); } };
}

/**
 * A JCE transformation string, as the mode ctx.crypto offers.
 *
 * The JCE's own default for a bare 'AES' is ECB, which is why a bare 'AES'
 * refuses here rather than being read as the CBC somebody probably meant.
 * Padding is checked and not ignored: WebCrypto's AES-CBC always applies PKCS#7
 * (which is PKCS#5 over 16-byte blocks - the same bytes under two names), and
 * AES-GCM never pads, so a transformation asking for the other combination is
 * asking for output this cannot produce.
 */
function __cipherSpec(transformation) {
  var text = __str(transformation);
  var parts = text.split('/');
  var algorithm = __str(parts[0]).toUpperCase();
  var mode = parts.length > 1 ? __str(parts[1]).toUpperCase() : '';
  var padding = parts.length > 2 ? __str(parts[2]).toUpperCase() : '';

  // RC4 is a stream cipher with no mode, no padding and no IV, and it is
  // computed here rather than by the host: WebCrypto does not have it, and it
  // is a few lines of arithmetic with published test vectors (RFC 6229), which
  // is the one kind of cipher it is honest to carry. SunJCE spells it both
  // ways, and accepts the ECB/NoPadding suffix as a no-op for either.
  if (algorithm === 'RC4' || algorithm === 'ARCFOUR') {
    if ((mode === '' || mode === 'ECB' || mode === 'NONE') && (padding === '' || padding === 'NOPADDING')) {
      return { mode: 'RC4' };
    }
    __cryptoRefuse('the ' + text + ' cipher');
  }
  if (algorithm !== 'AES' || mode === '') __cryptoRefuse('the ' + text + ' cipher');
  if (mode === 'CBC') {
    if (padding !== 'PKCS5PADDING' && padding !== 'PKCS7PADDING') {
      __cryptoRefuse('the ' + text + ' cipher');
    }
    return { mode: 'AES-CBC' };
  }
  if (mode === 'GCM') {
    if (padding !== 'NOPADDING' && padding !== '') __cryptoRefuse('the ' + text + ' cipher');
    return { mode: 'AES-GCM' };
  }
  __cryptoRefuse('the ' + text + ' cipher');
}

/**
 * RC4 over a key and a message, both byte arrays: the key schedule, then the
 * keystream XORed over the input. Checked against RFC 6229 in the spec.
 */
function __rc4(key, data) {
  var state = new Array(256);
  var i;
  var j = 0;
  for (i = 0; i < 256; i += 1) state[i] = i;
  for (i = 0; i < 256; i += 1) {
    j = (j + state[i] + (key[i % key.length] & 0xff)) & 0xff;
    var swap = state[i];
    state[i] = state[j];
    state[j] = swap;
  }
  var out = new Uint8Array(data.length);
  i = 0;
  j = 0;
  for (var n = 0; n < data.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + state[i]) & 0xff;
    var held = state[i];
    state[i] = state[j];
    state[j] = held;
    out[n] = (data[n] & 0xff) ^ state[(state[i] + state[j]) & 0xff];
  }
  return out;
}

/** javax.crypto.Cipher, over the two AES modes WebCrypto has and RC4. */
var Cipher = {
  ENCRYPT_MODE: 1,
  DECRYPT_MODE: 2,
  getInstance: function (transformation) {
    var spec = __cipherSpec(transformation);
    var direction = null;
    var key = null;
    var iv = null;
    var tagBits = null;
    return {
      // RC4 has no algorithm parameters; the JCE answers null, and the idiom
      // passes that straight back into init.
      parameters: null,
      getParameters: function () { return null; },
      init: function (mode, secret, parameters) {
        direction = Number(mode) === 2 ? 'decrypt' : 'encrypt';
        if (secret === null || secret === undefined || secret.__secretKey !== true) {
          __cryptoRefuse('a cipher key this build cannot read');
        }
        key = secret.bytes;
        if (spec.mode === 'RC4') {
          // SunJCE's bounds: 40 to 1024 bits. It throws InvalidKeyException
          // outside them, and so does this.
          if (key.length < 5 || key.length > 128) {
            throw new Error('This converted extension gave RC4 a ' + key.length + '-byte key.');
          }
          return this;
        }
        iv = parameters === null || parameters === undefined ? null : parameters.__iv;
        tagBits =
          parameters === null || parameters === undefined || parameters.__tagBits === null
            ? null
            : parameters.__tagBits;
        if (iv === null || iv === undefined) {
          // No IV means the provider generates one for encryption and the
          // caller reads it back off the cipher. That is a second value to
          // carry and nothing in reach asks for it, so it refuses rather than
          // silently using zeros - which would be a real key with no IV at all.
          __cryptoRefuse('a cipher initialised without an IV');
        }
        return this;
      },
      update: function () {
        // JCE's Cipher.update answers the blocks completed so far. Buffering
        // and answering nothing would change what the caller received, so this
        // refuses. Mac and Signature buffer because their update returns void.
        __cryptoRefuse('a streaming Cipher.update()');
      },
      doFinal: async function (data) {
        if (direction === null) __cryptoRefuse('a cipher used before init()');
        // Each doFinal starts from the key's initial state, as the JCE resets a
        // cipher to its last init; encryption and decryption are one XOR.
        if (spec.mode === 'RC4') return __cryptoArray(__rc4(key, __bytesOf(data)));
        var out = await __host().crypto.aes(
          direction,
          spec.mode,
          key,
          iv,
          __bytesOf(data),
          tagBits === null ? undefined : tagBits
        );
        return __cryptoArray(out);
      },
      getIV: function () { return iv === null ? null : __cryptoArray(iv); }
    };
  }
};

/** javax.crypto.Mac - HMAC, whose update() really does only accumulate. */
var Mac = {
  getInstance: function (algorithm) {
    var text = __str(algorithm);
    if (text.slice(0, 4).toUpperCase() !== 'HMAC') __cryptoRefuse('the ' + text + ' MAC');
    var hash = __cryptoHash(text.slice(4));
    var key = null;
    var pending = [];
    return {
      init: function (secret) {
        if (secret === null || secret === undefined || secret.__secretKey !== true) {
          __cryptoRefuse('a MAC key this build cannot read');
        }
        key = secret.bytes;
        pending = [];
        return this;
      },
      update: function (data) {
        pending = pending.concat(Array.prototype.slice.call(__bytesOf(data)));
        return this;
      },
      reset: function () { pending = []; return this; },
      doFinal: async function (data) {
        if (key === null) __cryptoRefuse('a MAC used before init()');
        var all = data === undefined || data === null
          ? pending
          : pending.concat(Array.prototype.slice.call(__bytesOf(data)));
        pending = [];
        return __cryptoArray(await __host().crypto.hmac(hash, key, new Uint8Array(all)));
      }
    };
  }
};

/**
 * java.security.KeyPairGenerator, for EC and nothing else.
 *
 * RSA is absent deliberately: WebCrypto's RSA is RSASSA-PKCS1/PSS and OAEP, not
 * the raw modular exponentiation a JCE 'RSA/ECB/NoPadding' asks for, and the
 * two are not interchangeable. An extension naming RSA refuses.
 */
var KeyPairGenerator = {
  getInstance: function (algorithm) {
    var text = __str(algorithm).toUpperCase();
    if (text !== 'EC' && text !== 'ECDSA') __cryptoRefuse('a ' + __str(algorithm) + ' key pair');
    var curve = 'P-256';
    return {
      initialize: function (spec) {
        if (spec !== null && spec !== undefined && typeof spec.__curve === 'string') {
          curve = spec.__curve;
          return this;
        }
        // KeyPairGenerator.initialize(keysize) picks a curve by bit length for
        // EC, and the mapping is the provider's rather than the spec's. Naming
        // the curve is the only unambiguous form, so the other one refuses.
        __cryptoRefuse('an EC key pair sized by bit length rather than by curve');
      },
      generateKeyPair: async function () {
        var pair = await __host().crypto.generateEcKeyPair(curve);
        return __keyPair(pair);
      }
    };
  }
};

/**
 * The generated pair, with its public half already a JWK.
 *
 * Both spellings are answered because both are written: Kotlin reads the Java
 * getters as properties, so 'pair.public' and 'pair.getPublic()' are one thing.
 */
function __keyPair(pair) {
  var publicKey = {
    __ecPublic: pair,
    algorithm: 'EC',
    format: 'JWK',
    kty: pair.publicJwk.kty,
    crv: pair.publicJwk.crv,
    x: pair.publicJwk.x,
    y: pair.publicJwk.y,
    w: {
      affineX: __coordinate(pair.publicJwk.x),
      affineY: __coordinate(pair.publicJwk.y)
    },
    getAlgorithm: function () { return 'EC'; },
    getFormat: function () { return 'JWK'; }
  };
  var privateKey = { __ecPrivate: pair, algorithm: 'EC', getAlgorithm: function () { return 'EC'; } };
  return {
    public: publicKey,
    private: privateKey,
    getPublic: function () { return publicKey; },
    getPrivate: function () { return privateKey; }
  };
}

/**
 * An affine coordinate, as much of java.math.BigInteger as it is read through.
 *
 * The Kotlin this stands in for spends a dozen lines assembling a JWK by hand:
 * it takes 'publicKey.w.affineX', calls toByteArray(), and pads the result to
 * the coordinate width. The JWK is already exported here - 'x' and 'y' above
 * are it - but the hand-assembling code still has to run, so the coordinate has
 * to answer to the name that code uses.
 *
 * toByteArray() is Java's exactly: big-endian two's complement, which for a
 * positive number means a leading zero byte whenever the top bit is set. The
 * JWK coordinate is fixed-width and unsigned, so that leading zero is the only
 * difference and it is the one the padding code is written around. Getting it
 * wrong by one byte is a JWK that encodes a different public key.
 *
 * This is NOT a BigInteger. It answers toByteArray() and toString(); arithmetic
 * is refused at conversion time, because a method this runtime does not name is
 * one the emitter has no passthrough for.
 */
function __coordinate(base64url) {
  var bytes = Base64.decode(__str(base64url), Base64.URL_SAFE);
  var unsigned = __bytesOf(bytes);
  return {
    __bigInteger: true,
    bytes: unsigned,
    toByteArray: function () {
      var out = [];
      var at = 0;
      while (at < unsigned.length - 1 && unsigned[at] === 0) at += 1;
      if ((unsigned[at] & 0x80) !== 0) out.push(0);
      for (var i = at; i < unsigned.length; i += 1) {
        out.push(unsigned[i] > 127 ? unsigned[i] - 256 : unsigned[i]);
      }
      return out;
    },
    bitLength: function () {
      var at = 0;
      while (at < unsigned.length && unsigned[at] === 0) at += 1;
      if (at === unsigned.length) return 0;
      var bits = (unsigned.length - at - 1) * 8;
      for (var high = unsigned[at]; high > 0; high >>= 1) bits += 1;
      return bits;
    },
    toString: function (radix) {
      if (radix === undefined || Number(radix) === 10) return __decimalOf(unsigned);
      if (Number(radix) !== 16) __cryptoRefuse('a BigInteger in base ' + __str(radix));
      var hex = __k.toHexString(__cryptoArray(unsigned)).replace(/^0+/, '');
      return hex.length === 0 ? '0' : hex;
    }
  };
}

/** Big-endian unsigned bytes as their decimal digits, which BigInteger prints. */
function __decimalOf(bytes) {
  var digits = [0];
  for (var i = 0; i < bytes.length; i += 1) {
    var carry = bytes[i];
    for (var j = 0; j < digits.length; j += 1) {
      var cell = digits[j] * 256 + carry;
      digits[j] = cell % 10;
      carry = Math.floor(cell / 10);
    }
    while (carry > 0) {
      digits.push(carry % 10);
      carry = Math.floor(carry / 10);
    }
  }
  return digits.reverse().join('');
}

/**
 * java.security.Signature, over ECDSA.
 *
 * ## The one translation that is not a rename
 *
 * The JCE answers a DER-encoded SEQUENCE of two INTEGERs; WebCrypto answers the
 * raw 'r || s' of IEEE P1363. A peer that verifies what a JVM produced is
 * expecting DER, so raw bytes handed over as a signature simply fail to verify
 * - silently, at the far end, with nothing here to say why. So sign() encodes
 * and verify() decodes. That is ASN.1, not cryptography: no key material is
 * touched and no primitive is reimplemented.
 */
var Signature = {
  getInstance: function (algorithm) {
    var text = __str(algorithm);
    var split = text.toLowerCase().indexOf('with');
    if (split <= 0) __cryptoRefuse('the ' + text + ' signature');
    var scheme = text.slice(split + 4).toUpperCase();
    if (scheme !== 'ECDSA') __cryptoRefuse('the ' + text + ' signature');
    var hash = __cryptoHash(text.slice(0, split));
    var keys = null;
    var pending = [];
    return {
      initSign: function (key) {
        if (key === null || key === undefined || key.__ecPrivate === undefined) {
          __cryptoRefuse('a signing key this build cannot read');
        }
        keys = key.__ecPrivate;
        pending = [];
        return this;
      },
      initVerify: function (key) {
        if (key === null || key === undefined || key.__ecPublic === undefined) {
          __cryptoRefuse('a verifying key this build cannot read');
        }
        keys = key.__ecPublic;
        pending = [];
        return this;
      },
      update: function (data) {
        pending = pending.concat(Array.prototype.slice.call(__bytesOf(data)));
        return this;
      },
      sign: async function () {
        if (keys === null) __cryptoRefuse('a signature used before initSign()');
        var message = new Uint8Array(pending);
        pending = [];
        var raw = await __host().crypto.ecdsaSign(keys, hash, message);
        return __cryptoArray(__derSignature(raw));
      },
      verify: async function (signature) {
        if (keys === null) __cryptoRefuse('a signature used before initVerify()');
        var message = new Uint8Array(pending);
        pending = [];
        var width = CRYPTO_COORDS[keys.curve];
        var raw = __rawSignature(__bytesOf(signature), width);
        if (raw === null) return false;
        return __host().crypto.ecdsaVerify(keys, hash, raw, message);
      }
    };
  }
};

/** Raw 'r || s' as the DER SEQUENCE the JCE answers. */
function __derSignature(raw) {
  var half = raw.length >> 1;
  var body = __derInteger(raw.subarray(0, half)).concat(__derInteger(raw.subarray(half)));
  return [0x30].concat(__derLength(body.length), body);
}

/** One DER INTEGER: minimal length, and a leading zero when the top bit is set. */
function __derInteger(bytes) {
  var at = 0;
  while (at < bytes.length - 1 && bytes[at] === 0) at += 1;
  var value = [];
  if ((bytes[at] & 0x80) !== 0) value.push(0);
  for (var i = at; i < bytes.length; i += 1) value.push(bytes[i]);
  return [0x02].concat(__derLength(value.length), value);
}

function __derLength(length) {
  if (length < 0x80) return [length];
  if (length < 0x100) return [0x81, length];
  return [0x82, (length >> 8) & 0xff, length & 0xff];
}

/**
 * The DER SEQUENCE back as raw 'r || s', or null when it is not one.
 *
 * null rather than a throw: verify() answers false for a signature it cannot
 * read, which is what a JCE Signature does with a malformed one, and a
 * malformed signature is a failed verification rather than a broken plugin.
 */
function __rawSignature(der, width) {
  var at = 0;
  if (der.length < 8 || der[at] !== 0x30) return null;
  at += 1;
  if (der[at] === 0x81) at += 2;
  else if (der[at] === 0x82) at += 3;
  else at += 1;
  var out = new Uint8Array(width * 2);
  for (var half = 0; half < 2; half += 1) {
    if (der[at] !== 0x02) return null;
    at += 1;
    var length = der[at];
    at += 1;
    if (length > der.length - at) return null;
    var from = at;
    var size = length;
    while (size > 1 && der[from] === 0) { from += 1; size -= 1; }
    if (size > width) return null;
    for (var i = 0; i < size; i += 1) out[half * width + width - size + i] = der[from + i];
    at += length;
  }
  return out;
}

/* --- androidx preferences ------------------------------------------------- */

/**
 * A foreign preference key, as the manifest setting id the host stores under.
 *
 * The conversion emits the exact map where it derived one, because two keys can
 * normalise to the same id and the second would otherwise read the first one's
 * value. The normalisation is the fallback, for a key the conversion never saw.
 */
var __SETTING_IDS = typeof __SETTING_ID_MAP === 'object' && __SETTING_ID_MAP !== null ? __SETTING_ID_MAP : {};
function __settingId(key) {
  var mapped = __SETTING_IDS[__str(key)];
  if (typeof mapped === 'string') return mapped;
  return __str(key).toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '').slice(0, 48);
}

/**
 * What this run wrote, and what the screen declared.
 *
 * Two registries, and the difference matters. '__prefWrites' is the extension
 * writing a preference back — remembering a mirror it just resolved, a token it
 * just fetched — and it is deliberately **not persisted**: 'ABI.md' §1 has the
 * host draw settings and the plugin read them, so a plugin that could write one
 * back would be editing a screen it is not allowed to draw. It is kept for the
 * life of the sandbox because these extensions write and then read moments
 * later, and a write that vanishes is a read that contradicts the line above it.
 *
 * '__prefDeclared' is filled in by constructing a preference: whatever
 * 'setupPreferenceScreen' builds says what its own default is, which is the
 * answer for any read whose call site did not carry one.
 */
var __prefWrites = {};
var __prefDeclared = {};

/**
 * pref(), with or without the store the Kotlin read it from.
 *
 * 'preferences.getString(KEY, DEFAULT)' arrives here as
 * 'pref(store, KEY, DEFAULT)' — all four getters collapse onto this one helper,
 * because what separates them is the type of the answer and that is what the
 * fallback already states. A read with no store at all is the same question
 * with one fewer argument.
 *
 * The order is: what this run wrote, then what the viewer chose, then what the
 * screen declared, then what the call site asked for. A bundle whose manifest
 * declares no settings therefore lands on the last one, which is exactly the
 * behaviour every already-installed converted bundle has.
 */
__k.pref = function (store, key, fallback) {
  if (arguments.length < 3 && (typeof store === 'string' || store === undefined)) {
    return __pref(store, key);
  }
  // A store that actually answers is preferred, because it is the one the
  // extension named. Normally that is this runtime's own — which lands back in
  // '__pref' below with the same arguments — but an extension may hand a store
  // of its own, and answering past it would ignore what it wrote.
  if (store !== null && store !== undefined && typeof store.getString === 'function') {
    var declared = store.getString(key, fallback);
    if (declared !== null && declared !== undefined && declared !== '') return declared;
  }
  return __pref(key, fallback);
};

function __pref(key, fallback) {
  var name = __str(key);
  if (Object.prototype.hasOwnProperty.call(__prefWrites, name)) {
    return __prefTyped(__prefWrites[name], fallback);
  }

  var id = __settingId(name);
  var settings = null;
  try {
    settings = __host().settings;
  } catch (error) {
    // Read from module scope, outside any ABI call. Everything below still
    // answers; a thrown error here would fail the whole load.
    settings = null;
  }

  // A set-valued preference ('getStringSet') must come back as a list: an
  // extension reads it with a collection helper, and a comma-joined string
  // would iterate as one long element rather than as the values it holds.
  if (Array.isArray(fallback)) {
    if (settings !== null) {
      var chosenList = settings.list(id);
      if (Array.isArray(chosenList) && chosenList.length > 0) return chosenList;
    }
    var declaredList = __prefDeclared[name];
    if (Array.isArray(declaredList)) return declaredList;
    return fallback;
  }

  if (settings !== null) {
    if (typeof fallback === 'boolean') {
      var chosenFlag = settings.string(id);
      if (chosenFlag === 'true' || chosenFlag === 'false') return chosenFlag === 'true';
      if (settings.boolean(id) === true) return true;
    } else {
      var chosen = settings.string(id);
      if (typeof chosen === 'string' && chosen.length > 0) return __prefTyped(chosen, fallback);
    }
  }

  if (Object.prototype.hasOwnProperty.call(__prefDeclared, name)) {
    return __prefTyped(__prefDeclared[name], fallback);
  }
  return fallback === undefined ? '' : fallback;
}

/** A stored value as the type the call site's fallback promised. */
function __prefTyped(value, fallback) {
  if (value === undefined || value === null) return fallback === undefined ? '' : fallback;
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : [__str(value)];
  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return value;
    return __str(value) === 'true';
  }
  if (typeof fallback === 'number') {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return typeof value === 'string' ? value : __str(value);
}

/**
 * 'android.content.SharedPreferences', as far as a sandbox can honour it.
 *
 * Reads go through the same path every other preference read does. Writes go to
 * the per-run overlay above. 'commit()' answers true because it succeeded at
 * what it does here, and an extension that branches on false would take a
 * failure path for a write that was never going to be durable anyway.
 */
function __PrefEditor() { this.__edits = {}; this.__clear = false; }
__PrefEditor.prototype.putString = function (key, value) { this.__edits[__str(key)] = value; return this; };
__PrefEditor.prototype.putStringSet = function (key, value) { this.__edits[__str(key)] = __k.toList(value); return this; };
__PrefEditor.prototype.putInt = function (key, value) { this.__edits[__str(key)] = value; return this; };
__PrefEditor.prototype.putLong = function (key, value) { this.__edits[__str(key)] = value; return this; };
__PrefEditor.prototype.putFloat = function (key, value) { this.__edits[__str(key)] = value; return this; };
__PrefEditor.prototype.putBoolean = function (key, value) { this.__edits[__str(key)] = value === true; return this; };
__PrefEditor.prototype.remove = function (key) { this.__edits[__str(key)] = null; return this; };
__PrefEditor.prototype.clear = function () { this.__clear = true; return this; };
__PrefEditor.prototype.commit = function () {
  if (this.__clear) __prefWrites = {};
  for (var key in this.__edits) {
    if (!Object.prototype.hasOwnProperty.call(this.__edits, key)) continue;
    if (this.__edits[key] === null) delete __prefWrites[key];
    else __prefWrites[key] = this.__edits[key];
  }
  this.__edits = {};
  return true;
};
__PrefEditor.prototype.apply = function () { this.commit(); };

function __SharedPreferences() {}
__SharedPreferences.prototype.getString = function (key, fallback) { return __pref(key, fallback === undefined ? '' : fallback); };
__SharedPreferences.prototype.getStringSet = function (key, fallback) { return __pref(key, Array.isArray(fallback) ? fallback : []); };
__SharedPreferences.prototype.getBoolean = function (key, fallback) { return __pref(key, fallback === true); };
__SharedPreferences.prototype.getInt = function (key, fallback) { return __pref(key, typeof fallback === 'number' ? fallback : 0); };
__SharedPreferences.prototype.getLong = function (key, fallback) { return __pref(key, typeof fallback === 'number' ? fallback : 0); };
__SharedPreferences.prototype.getFloat = function (key, fallback) { return __pref(key, typeof fallback === 'number' ? fallback : 0); };
__SharedPreferences.prototype.contains = function (key) {
  var name = __str(key);
  if (Object.prototype.hasOwnProperty.call(__prefWrites, name)) return true;
  if (Object.prototype.hasOwnProperty.call(__prefDeclared, name)) return true;
  try {
    return __host().settings.string(__settingId(name)).length > 0;
  } catch (error) {
    return false;
  }
};
__SharedPreferences.prototype.edit = function () { return new __PrefEditor(); };
__SharedPreferences.prototype.all = function () {
  var out = {};
  for (var declaredKey in __prefDeclared) out[declaredKey] = __prefDeclared[declaredKey];
  for (var writtenKey in __prefWrites) out[writtenKey] = __prefWrites[writtenKey];
  return out;
};
__SharedPreferences.prototype.registerOnSharedPreferenceChangeListener = function () {};
__SharedPreferences.prototype.unregisterOnSharedPreferenceChangeListener = function () {};

var __prefStore = new __SharedPreferences();

/** The store, however this ecosystem's several spellings ask for it. */
__k.prefs = function () { return __prefStore; };
function SharedPreferences() { return __prefStore; }
function getSourcePreferences() { return __prefStore; }
function sourcePreferences() { return __prefStore; }
function getPreferences() { return __prefStore; }
function getSharedPreferences() { return __prefStore; }
function preferencesKey(id) { return 'source_' + __str(id); }

/**
 * 'Application', which this ecosystem reaches for exactly one thing.
 *
 * Android's Application is a whole process context. Nothing here pretends to
 * be one: across every corpus measured, an extension asks for it to call
 * 'getSharedPreferences("source_$id", MODE_PRIVATE)' and nothing else. That is
 * the store above, so the object answers that call and declares the two
 * members a caller reaches on the way to it.
 *
 * It matters more than it looks. 'getSourcePreferences()' was removed in
 * ext-lib 16, and 'Injekt.get<Application>().getSharedPreferences(…)' is what
 * the ecosystem now documents in its place — so this is the current spelling,
 * not a legacy one, and the share of extensions using it only grows.
 *
 * The preference *name* is ignored on purpose. A converted bundle has one
 * store, keyed by the host's own plugin id; 'source_$id' is this ecosystem's
 * way of writing "mine", and honouring it as a namespace would hand each
 * source a second, empty store that its own defaults never reached.
 */
var Application = {
  getSharedPreferences: function () { return __prefStore; },
  getApplicationContext: function () { return Application; },
  getPackageName: function () { return 'app'; },
  packageName: 'app'
};

/**
 * The androidx preference types, as declarations rather than as widgets.
 *
 * An extension builds these in 'setupPreferenceScreen' and the host never
 * renders them: 'ABI.md' §1 draws the manifest's own 'settings' block, which
 * the conversion derived from this same declaration before the bundle was
 * packaged. What running them buys is the other half — an extension that
 * mentions the preference framework anywhere the host *does* call now
 * translates instead of being refused, and whatever default it writes down here
 * answers a read whose call site did not carry one.
 *
 * Written as functions with prototypes rather than classes so that a
 * constructor call emitted with or without 'new' behaves the same. The property
 * names are the ones the framework publishes, because extensions assign them
 * directly.
 */
function __definePreference(name, parent, fields) {
  function Type(context) {
    if (!(this instanceof Type)) return new Type(context);
    parent.call(this, context);
    for (var field in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, field)) {
        this[field] = Array.isArray(fields[field]) ? fields[field].slice() : fields[field];
      }
    }
  }
  Type.prototype = Object.create(parent.prototype);
  Type.prototype.constructor = Type;
  Type.__prefName = name;
  return Type;
}

function Preference(context) {
  if (!(this instanceof Preference)) return new Preference(context);
  this.__context = context === undefined ? null : context;
  this.key = null;
  this.title = null;
  this.summary = null;
  this.defaultValue = null;
  this.isVisible = true;
  this.isEnabled = true;
  this.isPersistent = false;
  this.order = 0;
  this.summaryProvider = null;
  this.onPreferenceChangeListener = null;
  this.onPreferenceClickListener = null;
}
Preference.prototype.getContext = function () { return this.__context; };
Preference.prototype.setTitle = function (value) { this.title = value; return this; };
Preference.prototype.setSummary = function (value) { this.summary = value; return this; };
Preference.prototype.setKey = function (value) { this.key = value; return this; };
Preference.prototype.setEnabled = function (value) { this.isEnabled = value === true; return this; };
Preference.prototype.setVisible = function (value) { this.isVisible = value === true; return this; };
Preference.prototype.setIcon = function () { return this; };
Preference.prototype.setDependency = function () { return this; };
Preference.prototype.setLayoutResource = function () { return this; };
Preference.prototype.setWidgetLayoutResource = function () { return this; };
Preference.prototype.setOnPreferenceChangeListener = function (listener) {
  this.onPreferenceChangeListener = listener;
  return this;
};
Preference.prototype.setOnPreferenceClickListener = function (listener) {
  this.onPreferenceClickListener = listener;
  return this;
};
Preference.prototype.getSharedPreferences = function () { return __prefStore; };
/** Records what this preference says its default is, under its own key. */
Preference.prototype.setDefaultValue = function (value) {
  this.defaultValue = value;
  this.__declare(value);
  return this;
};
Preference.prototype.__declare = function (value) {
  if (typeof this.key !== 'string' || this.key.length === 0) return;
  if (value === undefined || value === null) return;
  if (Object.prototype.hasOwnProperty.call(__prefWrites, this.key)) return;
  __prefDeclared[this.key] = value;
};
/** What this preference would answer with, once it is on a screen. */
Preference.prototype.__declaredValue = function () { return this.defaultValue; };

function PreferenceGroup(context) {
  if (!(this instanceof PreferenceGroup)) return new PreferenceGroup(context);
  Preference.call(this, context);
  this.__children = [];
}
PreferenceGroup.prototype = Object.create(Preference.prototype);
PreferenceGroup.prototype.constructor = PreferenceGroup;
PreferenceGroup.prototype.addPreference = function (preference) {
  if (preference === null || preference === undefined) return false;
  this.__children.push(preference);
  if (typeof preference.__declare === 'function') {
    preference.__declare(preference.__declaredValue());
  }
  return true;
};
PreferenceGroup.prototype.removePreference = function (preference) {
  var at = this.__children.indexOf(preference);
  if (at === -1) return false;
  this.__children.splice(at, 1);
  return true;
};
PreferenceGroup.prototype.getPreferenceCount = function () { return this.__children.length; };
PreferenceGroup.prototype.getPreference = function (index) { return this.__children[index] === undefined ? null : this.__children[index]; };
PreferenceGroup.prototype.getPreferences = function () { return this.__children.slice(); };
PreferenceGroup.prototype.setOrderingAsAdded = function () {};
PreferenceGroup.prototype.setInitialExpandedChildrenCount = function () {};

var PreferenceCategory = __definePreference('PreferenceCategory', PreferenceGroup, {});
var PreferenceScreen = __definePreference('PreferenceScreen', PreferenceGroup, {});

var TwoStatePreference = __definePreference('TwoStatePreference', Preference, {
  isChecked: false,
  summaryOn: null,
  summaryOff: null
});
TwoStatePreference.prototype.setChecked = function (value) { this.isChecked = value === true; return this; };
TwoStatePreference.prototype.__declaredValue = function () {
  return this.defaultValue === null || this.defaultValue === undefined ? this.isChecked : this.defaultValue;
};

var SwitchPreferenceCompat = __definePreference('SwitchPreferenceCompat', TwoStatePreference, {});
var SwitchPreference = __definePreference('SwitchPreference', TwoStatePreference, {});
var CheckBoxPreference = __definePreference('CheckBoxPreference', TwoStatePreference, {});

var DialogPreference = __definePreference('DialogPreference', Preference, {
  dialogTitle: null,
  dialogMessage: null,
  positiveButtonText: null,
  negativeButtonText: null
});
DialogPreference.prototype.setDialogTitle = function (value) { this.dialogTitle = value; return this; };
DialogPreference.prototype.setDialogMessage = function (value) { this.dialogMessage = value; return this; };

var EditTextPreference = __definePreference('EditTextPreference', DialogPreference, {
  text: null,
  onBindEditTextListener: null
});
EditTextPreference.prototype.setOnBindEditTextListener = function (listener) {
  this.onBindEditTextListener = listener;
  return this;
};
EditTextPreference.prototype.__declaredValue = function () {
  return this.defaultValue === null || this.defaultValue === undefined ? this.text : this.defaultValue;
};

var ListPreference = __definePreference('ListPreference', Preference, {
  entries: null,
  entryValues: null,
  value: null
});
/** The label beside the chosen value, which is what 'summary' usually shows. */
ListPreference.prototype.getEntry = function () {
  var values = __k.toList(this.entryValues);
  var labels = __k.toList(this.entries);
  var at = values.indexOf(__pref(this.key, this.__declaredValue()));
  return at === -1 ? null : (labels[at] === undefined ? null : labels[at]);
};
ListPreference.prototype.findIndexOfValue = function (value) {
  return __k.toList(this.entryValues).indexOf(value);
};
ListPreference.prototype.setValueIndex = function (index) {
  var values = __k.toList(this.entryValues);
  if (values[index] !== undefined) this.value = values[index];
  return this;
};
ListPreference.prototype.__declaredValue = function () {
  if (this.defaultValue !== null && this.defaultValue !== undefined) return this.defaultValue;
  if (this.value !== null && this.value !== undefined) return this.value;
  var values = __k.toList(this.entryValues);
  return values.length > 0 ? values[0] : null;
};

var DropDownPreference = __definePreference('DropDownPreference', ListPreference, {});

var MultiSelectListPreference = __definePreference('MultiSelectListPreference', Preference, {
  entries: null,
  entryValues: null,
  values: []
});
MultiSelectListPreference.prototype.__declaredValue = function () {
  if (Array.isArray(this.defaultValue)) return this.defaultValue.slice();
  if (this.defaultValue !== null && this.defaultValue !== undefined) return __k.toList(this.defaultValue);
  return __k.toList(this.values);
};

var SeekBarPreference = __definePreference('SeekBarPreference', Preference, {
  value: 0,
  min: 0,
  max: 100,
  showSeekBarValue: true
});
SeekBarPreference.prototype.__declaredValue = function () {
  return this.defaultValue === null || this.defaultValue === undefined ? this.value : this.defaultValue;
};
`;

export const KOTLIN_MODELS = `
/* --- the Aniyomi model types ---------------------------------------------- */

/**
 * Path, query and fragment — what the base class's own helper keeps.
 *
 * Written against the published program rather than against what looks
 * reasonable, because extensions depend on this string: they store it, hand it
 * back, and do string surgery on it. Upstream builds a 'java.net.URI' from the
 * url and reassembles 'path' + '?' + 'query' + '#' + 'fragment', which has
 * three consequences that a plain regex strip does not have, and all three are
 * observable.
 *
 * **It percent-decodes.** 'URI.getPath()' and its siblings are the decoding
 * accessors, so '/a%20b' comes back as '/a b'. That round-trips on the way out
 * — the request builder re-encodes it — and it is what an extension comparing
 * this string against a title it read from the page is relying on.
 *
 * **An unparseable url is returned whole.** Java refuses a raw space, a brace,
 * a backslash or a truncated escape outright, and upstream catches that and
 * hands back the *original*, domain and all. So an extension with a sloppy
 * href stores an absolute url — which reads like a bug and is one, but it is
 * the bug the ecosystem was written against, and '__foreign' on the way back in
 * already reduces a stored absolute id for exactly this reason.
 *
 * **The authority is dropped, not the scheme's absence assumed.** A url that is
 * already relative has no authority to drop and comes back unchanged.
 *
 * One deliberate divergence, and it is the only one. Upstream returns the
 * *empty string* for a url with no path at all — a bare origin — and this returns
 * '/'. Everything downstream of here treats an empty id as "no id" — the
 * adapter drops a catalogue entry whose url is empty rather than emitting one
 * that addresses nothing — so upstream's empty string would silently delete a
 * row instead of pointing it at the site root, which is what it means.
 */
/*
 * The http section carries a fuller 'java.net.URI' ('__KUri'), and this is
 * deliberately not it: a section may be emitted without the ones after it, so
 * a models helper that reached into http would be a load-time death for any
 * conversion that asked for models alone. What is needed here is three fields
 * of the parse, and this is three fields of the parse.
 */
function __domainlessRejects(value) {
  // The characters 'java.net.URI' will not accept anywhere in a url: the
  // control range and space, and the seven RFC 2396 "excluded" ones that a
  // browser tolerates and Java does not.
  if (/[\\u0000-\\u0020"<>{}|\\\\^\`]/.test(value)) return true;
  // A '%' that does not begin a complete escape is a malformed escape.
  return /%(?![0-9A-Fa-f]{2})/.test(value);
}

function __domainlessDecode(value) {
  if (value.indexOf('%') === -1) return value;
  // A percent-escape that is not valid UTF-8 decodes to a replacement
  // character in Java and throws here, so the raw text stands in for it.
  try { return decodeURIComponent(value); } catch (error) { return value; }
}

function __withoutDomain(url) {
  var value = __str(url);
  if (value.length === 0) return value;
  if (__domainlessRejects(value)) return value;

  var rest = value;
  var fragment = null;
  var hash = rest.indexOf('#');
  if (hash !== -1) { fragment = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  var query = null;
  var mark = rest.indexOf('?');
  if (mark !== -1) { query = rest.slice(mark + 1); rest = rest.slice(0, mark); }

  var authority = /^[a-zA-Z][a-zA-Z0-9+.-]*:\\/\\/[^/]*/.exec(rest);
  if (authority === null) authority = /^\\/\\/[^/]*/.exec(rest);
  if (authority !== null) rest = rest.slice(authority[0].length);

  var out = __domainlessDecode(rest);
  if (query !== null) out += '?' + __domainlessDecode(query);
  if (fragment !== null) out += '#' + __domainlessDecode(fragment);
  return out.length === 0 ? '/' : out;
}

var SAnime = {
  UNKNOWN: 0,
  ONGOING: 1,
  COMPLETED: 2,
  LICENSED: 3,
  PUBLISHING_FINISHED: 4,
  CANCELLED: 5,
  ON_HIATUS: 6,
  create: function () {
    var anime = {
      url: '',
      title: '',
      artist: null,
      author: null,
      description: null,
      genre: null,
      status: 0,
      thumbnail_url: null,
      initialized: false
    };
    anime.setUrlWithoutDomain = function (url) {
      anime.url = __withoutDomain(url);
      return anime;
    };
    return anime;
  }
};

var SEpisode = {
  create: function () {
    var episode = {
      url: '',
      name: '',
      date_upload: 0,
      episode_number: -1,
      scanlator: null
    };
    episode.setUrlWithoutDomain = function (url) {
      episode.url = __withoutDomain(url);
      return episode;
    };
    return episode;
  }
};

/**
 * What every list page returns, and what a 'super.' call must answer with.
 *
 * 'popularAnimeParse' builds one by hand on nearly every extension, and the
 * driver reads both halves back — so both are plain readable fields rather
 * than accessors. 'animes' is the ecosystem's spelling and stays that way.
 */
function AnimesPage(animes, hasNextPage) {
  if (!(this instanceof AnimesPage)) return new AnimesPage(animes, hasNextPage);
  this.animes = __arr(animes);
  this.hasNextPage = hasNextPage === true;
}

/**
 * A filter list, which is a List<AnimeFilter> and is treated as one.
 *
 * An array, so every collection helper here takes it unchanged: extensions
 * iterate their own filter list far more often than they index it.
 */
function AnimeFilterList(filters) {
  var items = arguments.length === 1 ? __arr(filters) : Array.prototype.slice.call(arguments);
  var list = __mutableList(items.slice());
  Object.defineProperty(list, 'filterList', { value: list, enumerable: false });
  return list;
}

/** kotlinx.serialization's JsonObject is a marked plain object in this runtime. */
function JsonObject(value) {
  // 'JsonObject(emptyMap())' and 'JsonObject(mapOf(...))' hand over a Kotlin
  // Map, which is a JS Map here — and a mutable one carries its put/remove as
  // own properties, so copying its properties made a JSON object whose keys
  // were those methods and none of its entries. Its entries are the object.
  if (value instanceof Map) {
    var out = {};
    value.forEach(function (held, key) { out[__str(key)] = held; });
    return __marked(out);
  }
  return __marked(Object.assign({}, value || {}));
}

/** Browser transport owns pooling; retain the constructor as inert configuration. */
function ConnectionPool(maxIdle, keepAlive, timeUnit) {
  return { maxIdle: maxIdle, keepAlive: keepAlive, timeUnit: timeUnit };
}

/** kotlinx.coroutines Mutex, represented as an identity lock on one worker. */
function Mutex(locked) {
  if (!(this instanceof Mutex)) return new Mutex(locked);
  this.isLocked = Boolean(locked);
}

/**
 * java.lang.ref's SoftReference and WeakReference: a holder whose get() may
 * answer null once the collector has taken the value.
 *
 * "May" is the whole contract — the JVM is allowed never to clear one, and
 * every caller has to handle both answers already, which is why the one
 * template that uses it re-fetches on a null. Holding the value until clear()
 * is therefore one of the behaviours the Kotlin was written against, not an
 * approximation of it. The template caching a URL map this way also resets
 * the reference itself on a timer, so nothing grows without bound.
 */
function SoftReference(value) {
  if (!(this instanceof SoftReference)) return new SoftReference(value);
  var held = value === undefined ? null : value;
  this.get = function () { return held; };
  this.clear = function () { held = null; };
}
var WeakReference = SoftReference;

/** Small access-ordered cache for generic utility code. */
function LruCache(maxSize) {
  if (!(this instanceof LruCache)) return new LruCache(maxSize);
  this.maxSize = Math.max(0, Math.trunc(Number(maxSize) || 0));
  this.entries = new Map();
}
LruCache.prototype.get = function (key) {
  if (!this.entries.has(key)) return null;
  var value = this.entries.get(key);
  this.entries.delete(key);
  this.entries.set(key, value);
  return value;
};
LruCache.prototype.put = function (key, value) {
  var previous = this.entries.has(key) ? this.entries.get(key) : null;
  this.entries.delete(key);
  this.entries.set(key, value);
  while (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value);
  return previous;
};
LruCache.prototype.remove = function (key) {
  var previous = this.entries.has(key) ? this.entries.get(key) : null;
  this.entries.delete(key);
  return previous;
};
LruCache.prototype.evictAll = function () { this.entries.clear(); };
LruCache.prototype.size = function () { return this.entries.size; };

/**
 * Constructible with or without 'new', because the emitter writes both.
 *
 * Two constructors live here under one name. The positional arguments are the
 * ext-lib 14 secondary — 'Video(url, quality, videoUrl, ...)' — which is what
 * the overwhelming majority of the catalogue writes and what upstream still
 * keeps as a deprecated secondary. A **single plain object** carrying any
 * ext-lib 16 field is the primary constructor instead, whose first parameter
 * is 'videoUrl' where the secondary's third is.
 *
 * The emitter decides which, and only ever passes the object form for a call
 * that named an ext-lib 16 parameter, so the shapes never have to be told
 * apart by arity here. The check is still made on the object's own fields
 * rather than on 'arguments.length', because a runtime that infers a
 * constructor from a count is one refactor away from inferring the wrong one.
 *
 * 'url' is the *page* url upstream ('videoPageUrl'), which the ext-lib 16
 * constructor has no parameter for, so it stays empty there — and 'quality' is
 * upstream a deprecated getter returning 'videoTitle', so both spellings are
 * populated from whichever one the caller supplied. That is what lets
 * 'aniyomi-entry' keep reading 'videoUrl || url' and 'videoTitle || quality'
 * without knowing which constructor ran.
 */
function __isVideoV16(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (var i = 0; i < __VIDEO_V16_FIELDS.length; i += 1) {
    if (__has(value, __VIDEO_V16_FIELDS[i])) return true;
  }
  return false;
}

var __VIDEO_V16_FIELDS = [
  'videoTitle', 'resolution', 'bitrate', 'preferred', 'timestamps',
  'mpvArgs', 'ffmpegStreamArgs', 'ffmpegVideoArgs', 'internalData',
  'initialized', 'memo'
];

function Video(url, quality, videoUrl, headers, subtitleTracks, audioTracks) {
  // Decided once, before the 'new' forward below: forwarding six named
  // parameters turns a one-argument call into a six-argument one, so an
  // 'arguments.length' test inside the constructed call would see the wrong
  // shape and silently take the ext-lib 14 path.
  var v = arguments.length === 1 && __isVideoV16(url) ? url : null;
  if (!(this instanceof Video)) {
    return v !== null
      ? new Video(v)
      : new Video(url, quality, videoUrl, headers, subtitleTracks, audioTracks);
  }
  if (v !== null) {
    this.url = '';
    this.videoUrl = v.videoUrl === null || v.videoUrl === undefined ? null : String(v.videoUrl);
    this.videoTitle = __str(v.videoTitle);
    this.quality = __str(v.videoTitle);
    this.resolution = v.resolution === undefined ? null : v.resolution;
    this.bitrate = v.bitrate === undefined ? null : v.bitrate;
    this.headers = v.headers === undefined ? null : v.headers;
    this.preferred = v.preferred === true;
    this.subtitleTracks = __arr(v.subtitleTracks);
    this.audioTracks = __arr(v.audioTracks);
    this.timestamps = __arr(v.timestamps);
    this.internalData = __str(v.internalData);
    this.initialized = v.initialized === true;
    return;
  }
  this.url = __str(url);
  this.quality = __str(quality);
  this.videoUrl = videoUrl === null || videoUrl === undefined ? null : String(videoUrl);
  this.videoTitle = __str(quality);
  this.headers = headers === undefined ? null : headers;
  this.subtitleTracks = __arr(subtitleTracks);
  this.audioTracks = __arr(audioTracks);
}

function Track(url, lang) {
  if (!(this instanceof Track)) return new Track(url, lang);
  this.url = __str(url);
  this.lang = __str(lang);
}

/**
 * A place a stream can be fetched from, which is now the primary shape.
 *
 * The base class moved: an episode yields *hosters*, and a hoster yields
 * videos. 'videoListParse(response)' is the legacy path it kept for the
 * extensions that predate the change. An extension written against the current
 * API names this type in its own signatures, so without it the conversion fails
 * for naming its own return type — the same reason 'AnimesPage' is here.
 *
 * 'videoList' is null when the hoster has not been opened yet and a list when
 * the extension already had the videos in hand; the driver reads both, and null
 * is what makes it fetch. 'lazy' is the extension asking the player to defer
 * that fetch until somebody presses play, which this host cannot honour — it
 * resolves an episode to every stream at once — so it is carried and not acted
 * on, and the fetch happens either way.
 */
function Hoster(hosterUrl, hosterName, videoList, internalData, lazy) {
  if (!(this instanceof Hoster)) {
    return new Hoster(hosterUrl, hosterName, videoList, internalData, lazy);
  }
  this.hosterUrl = __str(hosterUrl);
  this.hosterName = __str(hosterName);
  this.videoList = videoList === undefined || videoList === null ? null : __arr(videoList);
  this.internalData = __str(internalData);
  this.lazy = lazy === true;
  this.status = 'IDLE';
}

/**
 * The name a source with no hoster concept wraps its videos under.
 *
 * A sentinel rather than a real host, so the driver drops it from the label
 * instead of showing it to a viewer. Spelled exactly as upstream spells it,
 * because an extension compares against it by hand.
 */
Hoster.NO_HOSTER_LIST = 'no_hoster_list';

Hoster.prototype.copy = function (hosterUrl, hosterName, videoList, internalData, lazy) {
  return new Hoster(
    hosterUrl === undefined ? this.hosterUrl : hosterUrl,
    hosterName === undefined ? this.hosterName : hosterName,
    videoList === undefined ? this.videoList : videoList,
    internalData === undefined ? this.internalData : internalData,
    lazy === undefined ? this.lazy : lazy
  );
};

/**
 * Filters, constructed and then never populated.
 *
 * The ABI's searchCatalog takes a query and a page (ABI.md section 1), so
 * nothing on the host side can set a filter's state. Each type therefore
 * carries its declared default, which is what an extension reads when the
 * viewer has chosen nothing — the state a first search runs in anyway.
 */
var AnimeFilter = {
  Header: function (name) {
    if (!(this instanceof AnimeFilter.Header)) return new AnimeFilter.Header(name);
    this.name = __str(name);
  },
  Separator: function () {
    if (!(this instanceof AnimeFilter.Separator)) return new AnimeFilter.Separator();
    this.name = '';
  },
  Select: function (name, values, state) {
    if (!(this instanceof AnimeFilter.Select)) return new AnimeFilter.Select(name, values, state);
    this.name = __str(name);
    this.values = __arr(values);
    this.state = state === undefined ? 0 : Number(state);
  },
  Text: function (name, state) {
    if (!(this instanceof AnimeFilter.Text)) return new AnimeFilter.Text(name, state);
    this.name = __str(name);
    this.state = __str(state);
  },
  CheckBox: function (name, state) {
    if (!(this instanceof AnimeFilter.CheckBox)) return new AnimeFilter.CheckBox(name, state);
    this.name = __str(name);
    this.state = state === true;
  },
  TriState: function (name, state) {
    if (!(this instanceof AnimeFilter.TriState)) return new AnimeFilter.TriState(name, state);
    this.name = __str(name);
    this.state = state === undefined ? 0 : Number(state);
  },
  Group: function (name, state) {
    if (!(this instanceof AnimeFilter.Group)) return new AnimeFilter.Group(name, state);
    this.name = __str(name);
    this.state = __arr(state);
  },
  Sort: function (name, values, state) {
    if (!(this instanceof AnimeFilter.Sort)) return new AnimeFilter.Sort(name, values, state);
    this.name = __str(name);
    this.values = __arr(values);
    this.state = state === undefined ? null : state;
  }
};

/**
 * TriState's three states and the three questions asked about them.
 *
 * The constants are the whole of what a tri-state genre filter is read with:
 * 'filter.state == AnimeFilter.TriState.STATE_INCLUDE' is how an extension
 * decides a genre was asked for, and a subclass of TriState says it bare. They
 * were absent, so that comparison read undefined and every genre came back
 * un-included — a search that quietly ignored its filters rather than failing.
 *
 * The values are Aniyomi's own: ignore is 0, which is also what the framework
 * treats as 'default' (see __k.isDefault).
 */
AnimeFilter.TriState.STATE_IGNORE = 0;
AnimeFilter.TriState.STATE_INCLUDE = 1;
AnimeFilter.TriState.STATE_EXCLUDE = 2;
AnimeFilter.TriState.prototype.isIgnored = function () { return Number(this.state) === 0; };
AnimeFilter.TriState.prototype.isIncluded = function () { return Number(this.state) === 1; };
AnimeFilter.TriState.prototype.isExcluded = function () { return Number(this.state) === 2; };

/**
 * The two nested filter types this ecosystem imports by their bare name.
 *
 * 'import …model.AnimeFilter.TriState' then 'TriState.STATE_INCLUDE' — nine
 * sources here write the first and the emitter passes a capitalised receiver
 * through, so the bare name has to BE something. A file declaring its own
 * 'TriState' shadows this one, which the emitter already renames around.
 */
var TriState = AnimeFilter.TriState;
var CheckBox = AnimeFilter.CheckBox;

/* ── the manga half ────────────────────────────────────────────────────────
 *
 * The video ecosystem above is a fork of the manga one, and several of these
 * types were renamed rather than changed when it forked. Where that is true
 * they are **aliased, not copied**: two definitions of one thing drift, and
 * the drift would show up as a filter that reads its own state wrongly rather
 * than as an error anybody sees.
 *
 * Where the fork genuinely diverged — a chapter numbers itself differently
 * from an episode, a page has no counterpart at all — they are their own.
 */

/**
 * 'SManga' is what 'SAnime' was renamed from: same fields, same status
 * constants, same 'setUrlWithoutDomain'. It was an alias for that reason, and
 * the one thing that would force them apart was a field added to one and not
 * the other. That happened: keiyoushi's lib gave the manga half a 'memo', so
 * this is now the anime record plus that one field, deliberately, and still
 * shares every constant and the url setter rather than copying them.
 *
 * 'memo' is a JsonObject a source stashes on a title or chapter —
 * 'memo = buildJsonObject { put("id", id) }' in a parse — for a later call
 * to read back with 'memo.getStringOrNull("id")'. Upstream it is non-null
 * and defaults to an empty object, and the app persists it with the entry.
 *
 * **This host does not persist it.** A title or chapter reaches a later call
 * as its url alone (see '__mangaRef' in the driver), so it arrives with the
 * empty memo — which is exactly what upstream hands a source for an entry the
 * app stored before the source started writing one, and every reader in the
 * catalogue is written against that case: 'getStringOrNull(k) ?: <fetch it>'.
 * Within one call a memo a parse set is read back as written. A source that
 * requires one ('memo.getString(k)') throws, naming the field, rather than
 * reading undefined.
 */
function __withMemo(record) {
  record.memo = {};
  return record;
}

var SManga = Object.assign({}, SAnime, {
  create: function () { return __withMemo(SAnime.create()); }
});

/**
 * The library-update hint a source may set on a title.
 *
 * Two members, and the catalogue overwhelmingly writes one: 61 uses of
 * 'ONLY_FETCH_ONCE' against 7 of 'ALWAYS_UPDATE'. It means "this title's
 * chapter list is immutable, do not re-fetch it in a library update" — a
 * finished one-shot, usually.
 *
 * Carried as a value on 'SManga.update_strategy' rather than acted on here:
 * scheduling library refreshes is the host's, and a source saying a title
 * never changes is advice the host may take. What matters at this layer is
 * that the name resolves and the field survives, because the alternative was
 * refusing 68 extensions over an enum nobody reads at conversion time.
 */
var UpdateStrategy = {
  ALWAYS_UPDATE: 'ALWAYS_UPDATE',
  ONLY_FETCH_ONCE: 'ONLY_FETCH_ONCE'
};

/** Aniyomi writes the same two library-refresh hints on SAnime. */
var AnimeUpdateStrategy = UpdateStrategy;

/**
 * Details and chapters together, from one request.
 *
 * 'fetchMangaUpdate' is upstream's answer to a source that can serve both in a
 * single call — a GraphQL document returning the title and its chapter list —
 * where the older API forced two. It is a pair and nothing more, so it is one
 * here too.
 *
 * Both fields are optional in Kotlin and both are named at every construction
 * site in this catalogue, so the shape is built from named arguments and the
 * emitter's named-argument table is what orders them.
 */
function SMangaUpdate(manga, chapters) {
  if (!(this instanceof SMangaUpdate)) return new SMangaUpdate(manga, chapters);
  this.manga = manga === undefined ? null : manga;
  this.chapters = chapters === undefined ? null : chapters;
}

/**
 * A chapter, which is where the two ecosystems actually differ.
 *
 * 'chapter_number' rather than 'episode_number', and it is a Float in Kotlin
 * whose unset value is -1: a book has chapter 10.5 and the numbering has to
 * survive it. Everything else matches an episode, including the date being
 * epoch milliseconds and 0 meaning "not stated".
 */
var SChapter = {
  create: function () {
    var chapter = {
      url: '',
      name: '',
      date_upload: 0,
      chapter_number: -1,
      scanlator: null,
      // A chapter's 'memo', exactly as a title's — see 'SManga'.
      memo: {}
    };
    chapter.setUrlWithoutDomain = function (url) {
      chapter.url = __withoutDomain(url);
      return chapter;
    };
    return chapter;
  }
};

/**
 * One image in a chapter, and the type with no video counterpart at all.
 *
 * 'Page(index, url = "", imageUrl = null)' is the Kotlin signature, and both
 * defaults matter: extensions construct it three ways — positionally with an
 * image url, positionally with only a page url it will resolve later through
 * 'imageUrlParse', and with 'imageUrl' named. The last is why the defaults are
 * written out rather than left undefined: 'Page(index, imageUrl = x)' arrives
 * here as a two-argument call whose second argument is the *url* slot unless
 * the emitter named it, and a page whose 'url' holds an image is one the
 * driver would try to fetch a document from.
 */
function Page(index, url, imageUrl) {
  if (!(this instanceof Page)) return new Page(index, url, imageUrl);
  this.index = Number(index) || 0;
  this.url = url === undefined || url === null ? '' : __str(url);
  this.imageUrl = imageUrl === undefined ? null : imageUrl;
}

/**
 * What every list page returns here, the counterpart of 'AnimesPage'.
 *
 * 'mangas' is the ecosystem's own spelling and stays that way, for the reason
 * 'animes' does: extensions build one by hand on nearly every list page and
 * read both halves straight back.
 */
function MangasPage(mangas, hasNextPage) {
  if (!(this instanceof MangasPage)) return new MangasPage(mangas, hasNextPage);
  this.mangas = __arr(mangas);
  this.hasNextPage = hasNextPage === true;
}

/**
 * 'Filter' and 'FilterList', which the video fork renamed and did not change.
 *
 * Every member, every state constant and every question asked about a
 * tri-state is identical — 'AnimeFilter' above IS this class, one rename
 * later. So the bare names an extension imports resolve to the same objects,
 * and 'Filter.TriState.STATE_INCLUDE' is the same number in both.
 */
var Filter = AnimeFilter;
var FilterList = AnimeFilterList;

/* The nested filter types imported by their bare name here, the same way
   'TriState' and 'CheckBox' are above. A file declaring its own is renamed
   around by the emitter before it reaches these. */
var Select = Filter.Select;
var Text = Filter.Text;
var Group = Filter.Group;
var Sort = Filter.Sort;
var Header = Filter.Header;
var Separator = Filter.Separator;

/**
 * Compatibility facade for the constructor-shaped spelling used by converted
 * extensions. Only the generic one-argument packer is supported; overloads
 * that supply a custom alphabet or delimiter would need semantics this host
 * does not expose.
 */
function Unpacker(source) {
  if (!(this instanceof Unpacker)) return new Unpacker(source);
  this.source = source;
}
Unpacker.prototype.unpack = function () {
  if (arguments.length > 0) __k.unsupported('Unpacker options');
  return __k.unpack(this.source);
};
var JsUnpacker = Unpacker;

/**
 * Radix decoder used by generic packed-script unpackers. This is deliberately
 * a value primitive rather than a source-specific extractor: it only converts
 * a token into its numeric index and never fetches, decrypts, or evaluates.
 */
function Unbaser(base) {
  if (!(this instanceof Unbaser)) return new Unbaser(base);
  this.base = Number(base);
  if (!Number.isInteger(this.base) || this.base < 2 || this.base > 95) {
    __k.unsupported('Unbaser base');
  }
  var alphabet = Unbaser.ALPHABET[this.base];
  if (alphabet === undefined) {
    if (this.base >= 37 && this.base <= 62) alphabet = Unbaser.ALPHABET[62].slice(0, this.base);
    else __k.unsupported('Unbaser alphabet');
  }
  this.alphabet = alphabet;
  this.dictionary = Object.create(null);
  for (var i = 0; i < alphabet.length; i += 1) this.dictionary[alphabet.charAt(i)] = i;
}
Unbaser.ALPHABET = {
  62: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
  95: (function () {
    var out = '';
    for (var code = 32; code <= 126; code += 1) out += String.fromCharCode(code);
    return out;
  }())
};
Unbaser.prototype.unbase = function (value) {
  var text = __str(value);
  var result = 0;
  for (var i = text.length - 1, power = 0; i >= 0; i -= 1, power += 1) {
    var digit = this.dictionary[text.charAt(i)];
    if (digit === undefined) __k.unsupported('Unbaser digit');
    result += digit * Math.pow(this.base, power);
  }
  return result;
};
Unbaser.prototype.invoke = Unbaser.prototype.unbase;
`;

/** The sections, in the order they must be concatenated. */
export const KOTLIN_RUNTIME_SECTIONS = [
	'stdlib',
	'http',
	'jsoup',
	'serialization',
	'prefs',
	'models'
] as const;

export type KotlinRuntimeSection = (typeof KOTLIN_RUNTIME_SECTIONS)[number];

const SECTION_SOURCE: Record<KotlinRuntimeSection, string> = {
	stdlib: KOTLIN_STDLIB,
	http: KOTLIN_HTTP,
	jsoup: KOTLIN_JSOUP,
	serialization: KOTLIN_SERIALIZATION,
	prefs: KOTLIN_PREFS,
	models: KOTLIN_MODELS
};

/**
 * The runtime source for a conversion, in dependency order.
 *
 * `stdlib` is always emitted and always first: it declares `__k`, and every
 * other section assigns onto it. Ordering is enforced here rather than trusted
 * to the caller, because the failure mode is `__k is not defined` at load —
 * after the conversion, on a viewer's device, with nothing on screen to say
 * which section was missing.
 *
 * Emit `JS_RUNTIME` before this: `__host()` lives there and is not redeclared
 * here, because a second `function __host` at module scope is a `SyntaxError`.
 */
export function kotlinRuntime(
	sections: readonly KotlinRuntimeSection[] = KOTLIN_RUNTIME_SECTIONS
): string {
	const wanted = new Set<KotlinRuntimeSection>(sections);
	wanted.add('stdlib');
	return KOTLIN_RUNTIME_SECTIONS.filter((section) => wanted.has(section))
		.map((section) => SECTION_SOURCE[section])
		.join('\n');
}
