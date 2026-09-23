/**
 * The rest of kotlin.collections and kotlin.text that a catalogue pass named,
 * as bundle source.
 *
 * Spliced into `KOTLIN_STDLIB` after `__k` exists and assigned onto it, so the
 * additions are a block of their own rather than edits in the middle of the
 * `__k` literal. Same text rules as `kotlin-runtime.ts`: a plain template
 * literal, every backslash doubled, no backtick even in a comment.
 */
export const KOTLIN_STDLIB_MORE = `
/* --- the rest of kotlin.collections and kotlin.text a catalogue pass named -- */

/*
 * Each of these refused an extension by name. They sit in a block of their own
 * rather than in the '__k' literal above, assigned onto it, so a helper added
 * here is one hunk and not an edit in the middle of a four-thousand-line
 * object. The receiver is the first argument, as everywhere in '__k'.
 */

/** 'filterNotNull()': the elements that are not null, in order. */
__k.filterNotNull = function (list) {
  var out = [];
  var items = __arr(list);
  for (var i = 0; i < items.length; i += 1) if (__present(items[i])) out.push(items[i]);
  return out;
};

/*
 * A Map read the way Kotlin's MutableMap reads — a real Map, a keyed object
 * (kotlinx's JsonObject is a plain one here), or the runtime's own map
 * wrapper — so every helper below answers both shapes the same.
 */
function __mapHas(map, key) {
  if (map instanceof Map) return map.has(key);
  return map !== null && map !== undefined && Object.prototype.hasOwnProperty.call(map, key);
}
function __mapGet(map, key) {
  if (map instanceof Map) return map.get(key);
  return map[key];
}
function __mapSet(map, key, value) {
  if (map instanceof Map) map.set(key, value);
  else map[key] = value;
}

/**
 * 'getOrPut(key) { default }': the value, or the default computed ONCE, stored
 * and answered. Kotlin tests for null rather than for presence, so a key
 * mapped to null is computed again, and so is it here.
 */
__k.getOrPut = function (map, key, fallback) {
  var held = __mapHas(map, key) ? __mapGet(map, key) : null;
  if (__present(held)) return held;
  return __then(fallback(), function (made) {
    __mapSet(map, key, made);
    return made;
  });
};

/** 'getValue(key)', which throws for a missing key where 'get' answers null. */
__k.getValue = function (map, key) {
  if (map === null || map === undefined || !__mapHas(map, key)) {
    var error = new Error('Key ' + __str(key) + ' is missing in the map.');
    error.name = 'NoSuchElementException';
    throw error;
  }
  return __mapGet(map, key);
};

/**
 * 'toMap()' over pairs or a map, and 'toMap(destination)'.
 *
 * A receiver with a 'toMap' of its own — okhttp's Headers — answers for
 * itself, which is also what happens to a class the extension declared with
 * one. Later pairs win, as Kotlin's do.
 */
__k.toMap = function (value, destination) {
  if (destination === undefined && value !== null && value !== undefined &&
      !(value instanceof Map) && !Array.isArray(value) && typeof value.toMap === 'function') {
    return value.toMap();
  }
  var out = destination === undefined ? __mutableMap(new Map()) : destination;
  if (value instanceof Map) {
    value.forEach(function (held, key) { __mapSet(out, key, held); });
    return out;
  }
  var items = __arr(value);
  for (var i = 0; i < items.length; i += 1) {
    var pair = items[i];
    if (pair === null || pair === undefined) continue;
    if (Array.isArray(pair)) __mapSet(out, pair[0], pair[1]);
    else __mapSet(out, pair.first, pair.second);
  }
  return out;
};

/** 'mapValues { entry -> … }' and 'mapKeys', each into a new map, in order. */
__k.mapValues = function (map, transform) {
  var entries = __arr(map);
  return __then(__each(entries, function (entry) { return transform(entry); }), function (values) {
    var out = __mutableMap(new Map());
    for (var i = 0; i < entries.length; i += 1) out.set(entries[i][0], values[i]);
    return out;
  });
};

__k.mapKeys = function (map, transform) {
  var entries = __arr(map);
  return __then(__each(entries, function (entry) { return transform(entry); }), function (keys) {
    var out = __mutableMap(new Map());
    for (var i = 0; i < entries.length; i += 1) out.set(keys[i], entries[i][1]);
    return out;
  });
};

/** 'mapNotNullTo(destination) { … }': mapNotNull, appended into what it was handed. */
__k.mapNotNullTo = function (list, destination, transform) {
  return __then(__k.mapNotNull(list, transform), function (values) {
    for (var i = 0; i < values.length; i += 1) __k.add(destination, values[i]);
    return destination;
  });
};

/**
 * 'padEnd(length, padChar)', which pads with ONE character repeated and throws
 * for a negative length. JavaScript's padEnd takes a string and truncates it
 * to fit, which for one character is the same thing.
 */
__k.padEnd = function (value, length, pad) {
  var width = Number(length);
  if (!(width >= 0)) throw new Error('Desired length ' + length + ' is less than zero.');
  return __str(value).padEnd(width, pad === undefined ? ' ' : __str(pad));
};

/**
 * 'prependIndent(indent)': the indent in front of every line, and a blank
 * line made exactly the indent (or left alone, if it is already longer) —
 * Kotlin's own rule for blank lines.
 */
__k.prependIndent = function (value, indent) {
  var prefix = indent === undefined ? '    ' : __str(indent);
  return __str(value).split(/\\r\\n|\\n|\\r/).map(function (line) {
    if (line.trim().length === 0) return line.length < prefix.length ? prefix : line;
    return prefix + line;
  }).join('\\n');
};

/** 'removeAt(index)' on a MutableList: the element taken out, and answered. */
__k.removeAt = function (list, index) {
  var at = Number(index);
  if (!Array.isArray(list) || !(at >= 0 && at < list.length) || Math.trunc(at) !== at) {
    var error = new Error('Index ' + index + ' out of bounds for length ' + __arr(list).length + '.');
    error.name = 'IndexOutOfBoundsException';
    throw error;
  }
  return list.splice(at, 1)[0];
};

/*
 * The in-place list operations. Each answers Unit, as Kotlin's do — the whole
 * difference from 'reversed()', which answers a copy and leaves the list
 * alone. (No in-place 'sort': see the member table in subset.ts for why.)
 * A receiver that is not a list but has a method of the name is a class the
 * extension declared, and is asked instead.
 */
__k.reverse = function (list) {
  if (Array.isArray(list)) { list.reverse(); return undefined; }
  if (list !== null && list !== undefined && typeof list.reverse === 'function') {
    return list.reverse.apply(list, Array.prototype.slice.call(arguments, 1));
  }
  throw new Error('This converted extension reversed something that is not a list.');
};

__k.replaceAll = function (list, transform) {
  // java.lang.String.replaceAll(regex, replacement), which Kotlin can call:
  // the first argument is a PATTERN, unlike Kotlin's own replace(String, …).
  if (typeof list === 'string') return __k.replaceString(list, __k.regex(transform), arguments[2]);
  if (!Array.isArray(list)) throw new Error('This converted extension replaced into something that is not a list.');
  return __then(__each(list.slice(), function (item) { return transform(item); }), function (values) {
    for (var i = 0; i < values.length; i += 1) list[i] = values[i];
    return undefined;
  });
};

/** 'reduceIndexed { index, acc, item -> … }', which throws on an empty list. */
__k.reduceIndexed = function (list, operation) {
  var items = __arr(list);
  if (items.length === 0) throw new Error("Empty collection can't be reduced.");
  var acc = items[0];
  for (var i = 1; i < items.length; i += 1) acc = operation(i, acc, items[i]);
  return acc;
};

/** 'maxOf { … }' and 'minOf { … }', which throw on an empty list where the '…OrNull' forms answer null. */
__k.maxOf = function (list, selector) {
  var items = __arr(list);
  if (items.length === 0) throw new Error('This converted extension took maxOf an empty collection.');
  return __then(__each(items, function (item) { return selector(item); }), function (values) {
    var best = values[0];
    for (var i = 1; i < values.length; i += 1) if (__cmp(values[i], best) > 0) best = values[i];
    return best;
  });
};

__k.minOf = function (list, selector) {
  var items = __arr(list);
  if (items.length === 0) throw new Error('This converted extension took minOf an empty collection.');
  return __then(__each(items, function (item) { return selector(item); }), function (values) {
    var best = values[0];
    for (var i = 1; i < values.length; i += 1) if (__cmp(values[i], best) < 0) best = values[i];
    return best;
  });
};

/*
 * The unsigned conversions, over the numbers this runtime keeps. A UByte is
 * the low eight bits read unsigned — '(-1).toByte().toUByte()' is 255 — and a
 * UInt the low thirty-two.
 */
__k.toUByte = function (value) { return Math.trunc(Number(value)) & 255; };
__k.toUShort = function (value) { return Math.trunc(Number(value)) & 65535; };
__k.toUInt = function (value) { return Math.trunc(Number(value)) >>> 0; };

/**
 * java.util's HashSet / LinkedHashSet and the concurrent map, as the runtime's
 * Set and Map. A number argument is an initial CAPACITY — '(16, 0.75f)' — and
 * putting it in the collection would add an element the Kotlin never had; a
 * collection argument is copied, which is the copy constructor.
 */
__k.hashSet = function (source) {
  var from = source === undefined || typeof source === 'number' ? [] : __arr(source);
  return __k.toSet(from);
};

__k.hashMap = function (source) {
  var out = __mutableMap(new Map());
  if (source === undefined || source === null || typeof source === 'number') return out;
  return __k.toMap(source, out);
};

/**
 * 'Exception("…")' as a VALUE — handed to 'Observable.error(…)' rather than
 * thrown — which is an Error carrying the message, as 'throw' already makes.
 */
__k.exceptionOf = function (message, cause) {
  var error = new Error(message === undefined || message === null ? '' : __str(message));
  if (cause !== undefined) error.cause = cause;
  return error;
};

/**
 * 'toBigDecimal()', for the one thing a scraper does with one: print a volume
 * number without its '.0' — '.stripTrailingZeros().toPlainString()'.
 *
 * A Double's BigDecimal is BigDecimal(toString()), so what is carried is the
 * decimal TEXT the number prints as; stripping and plain-printing are text
 * operations on it, and nothing here does arithmetic a double could round.
 */
__k.toBigDecimal = function (value) {
  if (value !== null && value !== undefined && value.__kDecimal === true) return value;
  var text = typeof value === 'string' ? value.trim() : __plainNumber(Number(value));
  if (!/^[+-]?([0-9]+[.]?[0-9]*|[.][0-9]+)$/.test(text)) {
    throw new Error('This converted extension read "' + __str(value) + '" as a decimal, and it is not one.');
  }
  return __decimal(text);
};

/** A number's decimal text with no exponent, which String() gives only between 1e-7 and 1e21. */
function __plainNumber(number) {
  if (!Number.isFinite(number)) throw new Error('This converted extension made a BigDecimal of ' + number + '.');
  var text = String(number);
  var found = /^(-?)([0-9]+)(?:[.]([0-9]+))?e([+-][0-9]+)$/.exec(text);
  if (found === null) return text;
  var digits = found[2] + (found[3] || '');
  var point = found[2].length + Number(found[4]);
  if (point <= 0) return found[1] + '0.' + '0'.repeat(-point) + digits;
  if (point >= digits.length) return found[1] + digits + '0'.repeat(point - digits.length);
  return found[1] + digits.slice(0, point) + '.' + digits.slice(point);
}

function __decimal(text) {
  var value = {
    __kDecimal: true,
    stripTrailingZeros: function () {
      if (text.indexOf('.') === -1) return value;
      var trimmed = text.replace(/0+$/, '').replace(/[.]$/, '');
      return __decimal(trimmed.length === 0 || trimmed === '-' ? '0' : trimmed);
    },
    toPlainString: function () { return text; },
    toString: function () { return text; },
    toDouble: function () { return Number(text); },
    toInt: function () { return Math.trunc(Number(text)); }
  };
  return value;
}
`;
