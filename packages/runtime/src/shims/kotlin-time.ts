/**
 * java.time and kotlin.time, as a real subset, as bundle source.
 *
 * Split out of `kotlin-runtime.ts` because it is one coherent thing — a
 * calendar, a zone table, five temporal types and a pattern formatter — and it
 * is spliced into `KOTLIN_STDLIB` where the old one-chain shim stood, so every
 * bundle still carries it and nothing else changes shape. The rules for the
 * text are that file's: a plain template literal, so every backslash in the
 * runtime code is doubled here and a backtick is forbidden even in a comment.
 *
 * ## Why a real subset rather than the chain that was here
 *
 * The shim this replaced answered exactly `OffsetDateTime.parse(x).toInstant()
 * .toEpochMilli()`, read every date as UTC, and let `LocalDateTime` be the same
 * object as `OffsetDateTime`. What the catalogue actually writes is wider and
 * the difference is values rather than errors: `LocalDate.parse(d, f)
 * .atStartOfDay(ZoneId.of("Asia/Ho_Chi_Minh"))` is seven hours off if the zone
 * is dropped, `now.minusYears(1)` on the 29th of February is the 28th, and
 * keiyoushi's `tryParseZonedDateTime` must FAIL on a text with no offset so
 * the `?:` chain after it runs. Each of those is a date a reader sees, wrong,
 * with nothing refused.
 *
 * ## What is knowingly traded
 *
 * - **Zones are a table.** `ABI.md` §6 keeps `Intl` out of the bundle, and it
 *   is the only thing in an engine that knows named zones. The table carries
 *   the rules in force now (see `__ZONE_TABLE`); a zone missing from it is a
 *   named refusal when asked for, never UTC in disguise.
 * - **Milliseconds.** Arithmetic is on the millisecond timeline, with the
 *   sub-millisecond nanos carried for printing. Nothing a scraper reads is
 *   finer than that.
 * - **English names.** Month and weekday names in another language are
 *   refused by name rather than written in English.
 * - **The system zone is UTC**, as it already was for `TimeZone.getDefault()`:
 *   a device's own zone would make one page produce two answers on two phones.
 *
 * Requires `KOTLIN_STDLIB`'s helpers (`__str`, `__regexQuote`, `__monthIndex`,
 * `Locale`) and assigns onto `__k`, so it is spliced in after `__k` exists.
 */
export const KOTLIN_TIME = `
/* --- java.time and kotlin.time ------------------------------------------- */

/*
 * The calendar arithmetic underneath everything below, done by hand.
 *
 * 'Date' is not used for it on purpose: 'Date.UTC(99, 0, 1)' is 1999, not the
 * year 99, and a two-digit year read off a page and handed to it lands a
 * century out. The civil-from-days pair is Howard Hinnant's, which is exact
 * over the whole proleptic Gregorian calendar java.time also uses.
 */
var __MS_PER_DAY = 86400000;

function __fdiv(a, b) { return Math.floor(a / b); }
function __fmod(a, b) { return a - Math.floor(a / b) * b; }
function __isLeapYear(year) { return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0; }

function __monthLength(year, month) {
  if (month === 2) return __isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function __epochDayOf(year, month, day) {
  var y = month <= 2 ? year - 1 : year;
  var era = __fdiv(y, 400);
  var yoe = y - era * 400;
  var mp = (month + 9) % 12;
  var doy = __fdiv(153 * mp + 2, 5) + day - 1;
  var doe = yoe * 365 + __fdiv(yoe, 4) - __fdiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

function __civilOf(epochDay) {
  var z = epochDay + 719468;
  var era = __fdiv(z, 146097);
  var doe = z - era * 146097;
  var yoe = __fdiv(doe - __fdiv(doe, 1460) + __fdiv(doe, 36524) - __fdiv(doe, 146096), 365);
  var doy = doe - (365 * yoe + __fdiv(yoe, 4) - __fdiv(yoe, 100));
  var mp = __fdiv(5 * doy + 2, 153);
  var day = doy - __fdiv(153 * mp + 2, 5) + 1;
  var month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month: month, day: day };
}

/** ISO day of week, Monday = 1 … Sunday = 7. 1970-01-01 was a Thursday. */
function __isoDayOfWeek(epochDay) { return __fmod(epochDay + 3, 7) + 1; }

function __pad(value, width) {
  var text = String(Math.abs(value));
  while (text.length < width) text = '0' + text;
  return value < 0 ? '-' + text : text;
}

function __timeError(message) {
  var error = new Error(message);
  error.name = 'DateTimeException';
  return error;
}

function __timeInt(value, what) {
  var number = Number(value);
  if (!Number.isFinite(number) || Math.trunc(number) !== number) {
    throw __timeError('This converted extension passed ' + __str(value) + ' as ' + what + '.');
  }
  return number;
}

/* --- zones ---------------------------------------------------------------- */

/*
 * Time-zone rules, carried as a table because ABI.md section 6 keeps 'Intl'
 * out of the bundle — and 'Intl' is the only thing in a JavaScript engine that
 * knows a named zone.
 *
 * Each entry is a standard offset in seconds and, where the zone shifts its
 * clocks, the rule family it shifts by. The families are the rules IN FORCE
 * NOW, applied to every year: exact for anything since 2007 in North America
 * and 1996 in the EU, which covers every upload date this catalogue parses,
 * and off by at most the one hour a rule changed by before that. A zone that
 * is not in the table is refused by name when it is asked for, rather than
 * answered as UTC: an hour-shifted chapter date is a wrong value, and the
 * table is the place to add a zone somebody needs.
 *
 * The zones are the ones this catalogue names (Asia/Ho_Chi_Minh, Asia/Tokyo,
 * Europe/Paris, America/Chicago…) plus their neighbours, so the next source
 * from the same region is not a refusal over a zone next door.
 */
var __ZONE_TABLE = {
  'UTC': [0], 'GMT': [0], 'UT': [0], 'Etc/UTC': [0], 'Etc/GMT': [0], 'Etc/UCT': [0],
  'Universal': [0], 'Zulu': [0], 'Greenwich': [0],
  'Asia/Tokyo': [32400], 'Japan': [32400], 'Asia/Seoul': [32400], 'ROK': [32400],
  'Asia/Pyongyang': [32400], 'Asia/Jayapura': [32400],
  'Asia/Shanghai': [28800], 'Asia/Chongqing': [28800], 'Asia/Harbin': [28800], 'PRC': [28800],
  'Asia/Hong_Kong': [28800], 'Asia/Macau': [28800], 'Asia/Taipei': [28800], 'ROC': [28800],
  'Asia/Singapore': [28800], 'Singapore': [28800], 'Asia/Kuala_Lumpur': [28800],
  'Asia/Manila': [28800], 'Asia/Makassar': [28800], 'Asia/Brunei': [28800],
  'Australia/Perth': [28800],
  'Asia/Ho_Chi_Minh': [25200], 'Asia/Saigon': [25200], 'Asia/Bangkok': [25200],
  'Asia/Jakarta': [25200], 'Asia/Pontianak': [25200], 'Asia/Phnom_Penh': [25200],
  'Asia/Vientiane': [25200], 'Asia/Novosibirsk': [25200],
  'Asia/Yangon': [23400], 'Asia/Rangoon': [23400],
  'Asia/Dhaka': [21600], 'Asia/Almaty': [18000], 'Asia/Kathmandu': [20700],
  'Asia/Kolkata': [19800], 'Asia/Calcutta': [19800], 'Asia/Colombo': [19800],
  'Asia/Karachi': [18000], 'Asia/Tashkent': [18000],
  'Asia/Dubai': [14400], 'Asia/Baku': [14400], 'Asia/Tehran': [12600],
  'Asia/Riyadh': [10800], 'Asia/Baghdad': [10800], 'Asia/Qatar': [10800], 'Asia/Kuwait': [10800],
  'Asia/Amman': [10800], 'Asia/Damascus': [10800],
  'Europe/Istanbul': [10800], 'Asia/Istanbul': [10800], 'Turkey': [10800],
  'Europe/Moscow': [10800], 'Europe/Minsk': [10800],
  'Africa/Nairobi': [10800], 'Africa/Johannesburg': [7200], 'Africa/Lagos': [3600],
  'Africa/Algiers': [3600], 'Africa/Casablanca': [3600],
  'America/Sao_Paulo': [-10800], 'America/Argentina/Buenos_Aires': [-10800],
  'America/Buenos_Aires': [-10800], 'America/Montevideo': [-10800],
  'America/Bogota': [-18000], 'America/Lima': [-18000], 'America/Caracas': [-14400],
  'America/La_Paz': [-14400], 'America/Mexico_City': [-21600], 'America/Phoenix': [-25200],
  'Pacific/Honolulu': [-36000],
  'Europe/London': [0, 'eu'], 'Europe/Dublin': [0, 'eu'], 'Europe/Lisbon': [0, 'eu'],
  'Europe/Paris': [3600, 'eu'], 'Europe/Berlin': [3600, 'eu'], 'Europe/Madrid': [3600, 'eu'],
  'Europe/Rome': [3600, 'eu'], 'Europe/Amsterdam': [3600, 'eu'], 'Europe/Brussels': [3600, 'eu'],
  'Europe/Vienna': [3600, 'eu'], 'Europe/Warsaw': [3600, 'eu'], 'Europe/Prague': [3600, 'eu'],
  'Europe/Stockholm': [3600, 'eu'], 'Europe/Oslo': [3600, 'eu'], 'Europe/Copenhagen': [3600, 'eu'],
  'Europe/Zurich': [3600, 'eu'], 'Europe/Budapest': [3600, 'eu'], 'Europe/Belgrade': [3600, 'eu'],
  'Europe/Athens': [7200, 'eu'], 'Europe/Kiev': [7200, 'eu'], 'Europe/Kyiv': [7200, 'eu'],
  'Europe/Helsinki': [7200, 'eu'], 'Europe/Bucharest': [7200, 'eu'], 'Europe/Sofia': [7200, 'eu'],
  'America/New_York': [-18000, 'us'], 'America/Toronto': [-18000, 'us'],
  'America/Detroit': [-18000, 'us'], 'US/Eastern': [-18000, 'us'],
  'America/Chicago': [-21600, 'us'], 'US/Central': [-21600, 'us'],
  'America/Denver': [-25200, 'us'], 'US/Mountain': [-25200, 'us'],
  'America/Los_Angeles': [-28800, 'us'], 'America/Vancouver': [-28800, 'us'],
  'US/Pacific': [-28800, 'us'], 'America/Anchorage': [-32400, 'us'],
  'Australia/Sydney': [36000, 'au'], 'Australia/Melbourne': [36000, 'au'],
  'Australia/Canberra': [36000, 'au'], 'Australia/Hobart': [36000, 'au'],
  'Australia/Brisbane': [36000]
};

/** The epoch day of the first Sunday on or after a date. */
function __sundayFrom(year, month, day) {
  var at = __epochDayOf(year, month, day);
  return at + __fmod(7 - __isoDayOfWeek(at), 7);
}

/** The epoch day of the last Sunday of a month. */
function __lastSunday(year, month) {
  var at = __epochDayOf(year, month, __monthLength(year, month));
  return at - __fmod(__isoDayOfWeek(at), 7);
}

/*
 * Whether a rule family is on summer time at an instant.
 *
 * - eu: last Sunday of March to last Sunday of October, both at 01:00 UTC.
 * - us: second Sunday of March at 02:00 local standard time to the first
 *   Sunday of November at 02:00 local daylight time.
 * - au: the southern mirror — first Sunday of October at 02:00 standard to the
 *   first Sunday of April at 03:00 daylight — so it is summer time OUTSIDE the
 *   window rather than inside it.
 */
function __onSummerTime(rule, standard, millis) {
  var year = __civilOf(__fdiv(millis, __MS_PER_DAY)).year;
  var hour = 3600000;
  if (rule === 'eu') {
    var euStart = __lastSunday(year, 3) * __MS_PER_DAY + hour;
    var euEnd = __lastSunday(year, 10) * __MS_PER_DAY + hour;
    return millis >= euStart && millis < euEnd;
  }
  if (rule === 'us') {
    var usStart = __sundayFrom(year, 3, 8) * __MS_PER_DAY + 2 * hour - standard * 1000;
    var usEnd = __sundayFrom(year, 11, 1) * __MS_PER_DAY + 2 * hour - (standard + 3600) * 1000;
    return millis >= usStart && millis < usEnd;
  }
  var auEnd = __sundayFrom(year, 4, 1) * __MS_PER_DAY + 3 * hour - (standard + 3600) * 1000;
  var auStart = __sundayFrom(year, 10, 1) * __MS_PER_DAY + 2 * hour - standard * 1000;
  return millis < auEnd || millis >= auStart;
}

/**
 * java.time's ZoneId, and — with no rule — its ZoneOffset.
 *
 * One constructor for both because java.time makes ZoneOffset a ZoneId, and an
 * extension hands either to the same 'atZone'.
 */
function __Zone(id, standard, rule) {
  this.id = id;
  this.__std = standard;
  this.__rule = rule === undefined ? null : rule;
  if (this.__rule === null && /^(Z$|[+-])/.test(id)) this.totalSeconds = standard;
}

__Zone.prototype.getId = function () { return this.id; };
__Zone.prototype.getTotalSeconds = function () { return this.totalSeconds; };
__Zone.prototype.toString = function () { return this.id; };
__Zone.prototype.equals = function (other) {
  return other instanceof __Zone && other.id === this.id;
};
__Zone.prototype.normalized = function () {
  return this.__rule === null ? __zoneOffset(this.__std) : this;
};
/** The offset in force at an instant, in seconds. */
__Zone.prototype.__offsetAt = function (millis) {
  if (this.__rule === null) return this.__std;
  return __onSummerTime(this.__rule, this.__std, millis) ? this.__std + 3600 : this.__std;
};
/**
 * The instant a wall-clock reading in this zone names.
 *
 * java.time's own resolution: in an overlap (clocks going back) the offset the
 * value already had wins if it is one of the two, else the earlier — summer —
 * one; in a gap (clocks going forward) the reading is moved later by the
 * length of the gap, which is the instant the old offset gives.
 */
__Zone.prototype.__instantOf = function (localMillis, preferred) {
  if (this.__rule === null) return localMillis - this.__std * 1000;
  var standard = this.__std;
  var summer = standard + 3600;
  var asStandard = this.__offsetAt(localMillis - standard * 1000) === standard;
  var asSummer = this.__offsetAt(localMillis - summer * 1000) === summer;
  if (asStandard && asSummer) {
    return localMillis - (preferred === standard ? standard : summer) * 1000;
  }
  if (asSummer) return localMillis - summer * 1000;
  return localMillis - standard * 1000;
};
__Zone.prototype.getRules = function () {
  var zone = this;
  return {
    getOffset: function (value) { return __zoneOffset(zone.__offsetAt(__epochMillisOf(value))); },
    getStandardOffset: function () { return __zoneOffset(zone.__std); },
    isFixedOffset: function () { return zone.__rule === null; },
    isDaylightSavings: function (value) {
      return zone.__offsetAt(__epochMillisOf(value)) !== zone.__std;
    }
  };
};

function __offsetId(seconds) {
  if (seconds === 0) return 'Z';
  var sign = seconds < 0 ? '-' : '+';
  var abs = Math.abs(seconds);
  var text = sign + __pad(__fdiv(abs, 3600), 2) + ':' + __pad(__fdiv(abs % 3600, 60), 2);
  return abs % 60 === 0 ? text : text + ':' + __pad(abs % 60, 2);
}

var __OFFSETS = {};
function __zoneOffset(seconds) {
  var total = __timeInt(seconds, 'an offset');
  if (Math.abs(total) > 18 * 3600) {
    throw __timeError('Zone offset not in valid range: ' + total + ' seconds.');
  }
  if (__OFFSETS[total] === undefined) __OFFSETS[total] = new __Zone(__offsetId(total), total, null);
  return __OFFSETS[total];
}

/**
 * An offset written as text: 'Z', '+7', '+07', '+0700', '+07:00', '-03:30:15'.
 * Null for anything that is not one, so a caller can try a zone id next.
 */
function __offsetSeconds(text) {
  var value = __str(text).trim();
  if (value === 'Z' || value === 'z') return 0;
  var found = /^([+-])([0-9]{1,2})(?::?([0-9]{2}))?(?::?([0-9]{2}))?$/.exec(value);
  if (found === null) return null;
  var seconds = Number(found[2]) * 3600 + Number(found[3] || 0) * 60 + Number(found[4] || 0);
  return found[1] === '-' ? -seconds : seconds;
}

/*
 * The abbreviations a page prints after a time, where they are unambiguous.
 * 'CST', 'IST' and 'BST' each name two or three zones and are left out: a
 * guess between them is an hours-wrong date.
 */
var __ZONE_ABBREVIATIONS = {
  UTC: 0, GMT: 0, UT: 0, JST: 32400, KST: 32400, HKT: 28800, SGT: 28800, PHT: 28800,
  WITA: 28800, ICT: 25200, WIB: 25200, WIT: 32400,
  EST: -18000, EDT: -14400, CDT: -18000, MST: -25200, MDT: -21600, PST: -28800, PDT: -25200,
  CET: 3600, CEST: 7200, EET: 7200, EEST: 10800, WET: 0, WEST: 3600, MSK: 10800,
  BRT: -10800, ART: -10800, AEST: 36000, AEDT: 39600
};

/**
 * A zone or offset, as a page or a pattern writes it, or null.
 *
 * An offset, a prefixed offset ('GMT+7', 'UTC+09:00'), an id this runtime
 * carries rules for, or an unambiguous abbreviation.
 */
function __zoneFromText(text) {
  var value = __str(text).trim();
  if (value.length === 0) return null;
  var seconds = __offsetSeconds(value);
  if (seconds !== null) return __zoneOffset(seconds);
  var prefixed = /^(GMT|UTC|UT)([+-].+)$/.exec(value);
  if (prefixed !== null) {
    var shifted = __offsetSeconds(prefixed[2]);
    if (shifted !== null) return new __Zone(prefixed[1] + (shifted === 0 ? '' : __offsetId(shifted)), shifted, null);
  }
  if (Object.prototype.hasOwnProperty.call(__ZONE_TABLE, value)) {
    var row = __ZONE_TABLE[value];
    return new __Zone(value, row[0], row[1]);
  }
  var upper = value.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(__ZONE_ABBREVIATIONS, upper)) {
    return __zoneOffset(__ZONE_ABBREVIATIONS[upper]);
  }
  return null;
}

/** The zone a system default means here. See TimeZone.getDefault. */
function __systemZone() { return new __Zone('UTC', 0, null); }

var ZoneId = {
  of: function (id) {
    var value = __str(id);
    var zone = __zoneFromText(value);
    // An abbreviation is not an id: ZoneId.of("JST") throws in java.time, and
    // SHORT_IDS is the explicit way to ask for one.
    var abbreviation = __ZONE_ABBREVIATIONS[value.toUpperCase()] !== undefined && __ZONE_TABLE[value] === undefined;
    if (zone === null || abbreviation) {
      throw __timeError(
        'This converted extension asked for the time zone "' + value + '", which Yorozo carries ' +
        'no rules for. Named zones are a table here (ABI.md keeps Intl out of the bundle).'
      );
    }
    return zone;
  },
  systemDefault: function () { return __systemZone(); },
  getAvailableZoneIds: function () { return __k.toSet(Object.keys(__ZONE_TABLE)); }
};

var ZoneOffset = {
  UTC: __zoneOffset(0),
  MIN: __zoneOffset(-18 * 3600),
  MAX: __zoneOffset(18 * 3600),
  ofHours: function (hours) { return __zoneOffset(__timeInt(hours, 'hours') * 3600); },
  ofHoursMinutes: function (hours, minutes) {
    return __zoneOffset(__timeInt(hours, 'hours') * 3600 + __timeInt(minutes, 'minutes') * 60);
  },
  ofHoursMinutesSeconds: function (hours, minutes, seconds) {
    return __zoneOffset(__timeInt(hours, 'hours') * 3600 + __timeInt(minutes, 'minutes') * 60 +
      __timeInt(seconds, 'seconds'));
  },
  ofTotalSeconds: function (seconds) { return __zoneOffset(seconds); },
  of: function (text) {
    var seconds = __offsetSeconds(text);
    if (seconds === null) throw __timeError('Invalid ID for ZoneOffset: ' + __str(text));
    return __zoneOffset(seconds);
  }
};

/** Whatever an extension hands where a zone goes: a ZoneId, a TimeZone, or a Clock. */
function __zoneArg(value) {
  if (value === null || value === undefined) return __systemZone();
  if (value instanceof __Zone) return value;
  if (value.__zone instanceof __Zone) return value.__zone;
  if (typeof value.getZone === 'function') return __zoneArg(value.getZone());
  if (typeof value === 'string') return ZoneId.of(value);
  throw __timeError('This converted extension passed something that is not a time zone.');
}

/** The clock an extension handed a 'now', or the wall clock. */
function __nowMillis(clock) {
  if (clock !== null && clock !== undefined && typeof clock.millis === 'function') return Number(clock.millis());
  return Date.now();
}

/* --- units and fields ----------------------------------------------------- */

function __Unit(name, millis, months, dateBased) {
  this.name = name;
  this.__ms = millis;
  this.__months = months;
  this.__dateBased = dateBased;
}
__Unit.prototype.toString = function () { return this.name.charAt(0) + this.name.slice(1).toLowerCase(); };
__Unit.prototype.isDateBased = function () { return this.__dateBased; };
__Unit.prototype.isTimeBased = function () { return !this.__dateBased && this.name !== 'FOREVER'; };
__Unit.prototype.getDuration = function () { return this.__ms; };
__Unit.prototype.between = function (start, end) { return start.until(end, this); };

var ChronoUnit = {
  NANOS: new __Unit('NANOS', 0.000001, 0, false),
  MICROS: new __Unit('MICROS', 0.001, 0, false),
  MILLIS: new __Unit('MILLIS', 1, 0, false),
  SECONDS: new __Unit('SECONDS', 1000, 0, false),
  MINUTES: new __Unit('MINUTES', 60000, 0, false),
  HOURS: new __Unit('HOURS', 3600000, 0, false),
  HALF_DAYS: new __Unit('HALF_DAYS', 43200000, 0, false),
  DAYS: new __Unit('DAYS', __MS_PER_DAY, 0, true),
  WEEKS: new __Unit('WEEKS', 7 * __MS_PER_DAY, 0, true),
  MONTHS: new __Unit('MONTHS', 0, 1, true),
  YEARS: new __Unit('YEARS', 0, 12, true),
  DECADES: new __Unit('DECADES', 0, 120, true),
  CENTURIES: new __Unit('CENTURIES', 0, 1200, true),
  MILLENNIA: new __Unit('MILLENNIA', 0, 12000, true)
};

function __unitArg(unit) {
  if (unit instanceof __Unit) return unit;
  throw __timeError('This converted extension moved a date by something that is not a ChronoUnit.');
}

var ChronoField = {
  YEAR: { name: 'YEAR', __read: function (f) { return f.year; } },
  MONTH_OF_YEAR: { name: 'MONTH_OF_YEAR', __read: function (f) { return f.month; } },
  DAY_OF_MONTH: { name: 'DAY_OF_MONTH', __read: function (f) { return f.day; } },
  DAY_OF_YEAR: {
    name: 'DAY_OF_YEAR',
    __read: function (f) { return __epochDayOf(f.year, f.month, f.day) - __epochDayOf(f.year, 1, 1) + 1; }
  },
  DAY_OF_WEEK: { name: 'DAY_OF_WEEK', __read: function (f) { return __isoDayOfWeek(__epochDayOf(f.year, f.month, f.day)); } },
  HOUR_OF_DAY: { name: 'HOUR_OF_DAY', __time: true, __read: function (f) { return f.hour; } },
  MINUTE_OF_HOUR: { name: 'MINUTE_OF_HOUR', __time: true, __read: function (f) { return f.minute; } },
  SECOND_OF_MINUTE: { name: 'SECOND_OF_MINUTE', __time: true, __read: function (f) { return f.second; } },
  NANO_OF_SECOND: { name: 'NANO_OF_SECOND', __time: true, __read: function (f) { return f.nano; } }
};

var TextStyle = { FULL: 'FULL', SHORT: 'SHORT', NARROW: 'NARROW', FULL_STANDALONE: 'FULL', SHORT_STANDALONE: 'SHORT' };

var __DAY_NAMES = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
var __MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'
];

/** A name in English, which is the only language this runtime has names in. */
function __englishName(upper, style, locale) {
  __requireEnglish(locale);
  var full = upper.charAt(0) + upper.slice(1).toLowerCase();
  if (style === 'SHORT') return full.slice(0, 3);
  if (style === 'NARROW') return full.charAt(0);
  return full;
}

/*
 * Month and weekday NAMES are English here, because the names of the other
 * languages live in 'Intl' and ABI.md section 6 keeps it out. Asking for one
 * in another language is refused rather than answered in English: a Spanish
 * month written into a request url as 'January' is a request for a page that
 * does not exist.
 */
function __requireEnglish(locale) {
  if (locale === null || locale === undefined) return;
  var language = __str(locale.language === undefined ? locale : locale.language).toLowerCase();
  if (language.length === 0 || language === 'en') return;
  throw __timeError(
    'This converted extension asked for a date name in "' + language + '". Yorozo has English ' +
    'names only (ABI.md keeps Intl out of the bundle).'
  );
}

function __Named(names, value) {
  this.name = names[value - 1];
  this.value = value;
  this.ordinal = value - 1;
}
__Named.prototype.getValue = function () { return this.value; };
__Named.prototype.toString = function () { return this.name; };
__Named.prototype.getDisplayName = function (style, locale) { return __englishName(this.name, style, locale); };
__Named.prototype.compareTo = function (other) { return this.value - other.value; };

function __namedSet(names) {
  var set = {};
  var list = [];
  for (var i = 0; i < names.length; i += 1) {
    set[names[i]] = new __Named(names, i + 1);
    list.push(set[names[i]]);
  }
  set.values = function () { return list.slice(); };
  set.entries = list;
  set.of = function (value) {
    var number = __timeInt(value, 'a ' + names.length + '-valued field');
    if (number < 1 || number > names.length) throw __timeError('Invalid value: ' + number);
    return list[number - 1];
  };
  set.valueOf = function (name) {
    if (!Object.prototype.hasOwnProperty.call(set, __str(name))) throw __timeError('No enum constant ' + __str(name));
    return set[__str(name)];
  };
  return set;
}

var DayOfWeek = __namedSet(__DAY_NAMES);
var Month = __namedSet(__MONTH_NAMES);
DayOfWeek.values().forEach(function (day) {
  day.plus = function (days) { return DayOfWeek.of(__fmod(day.value - 1 + Number(days), 7) + 1); };
  day.minus = function (days) { return day.plus(-Number(days)); };
});

/* --- the shared shape ----------------------------------------------------- */

/*
 * Every temporal below carries the same plain fields — year, month (1-12),
 * day, hour, minute, second, nano — and answers them from '__fields()'. The
 * formatter and 'get(ChronoField)' read that and nothing else, so a new
 * temporal is one constructor and not a new formatting path.
 */
function __temporalProto(proto) {
  proto.__kTime = true;
  Object.defineProperty(proto, 'dayOfWeek', {
    get: function () { return DayOfWeek.of(__isoDayOfWeek(__epochDayOf(this.year, this.monthValue, this.dayOfMonth))); }
  });
  Object.defineProperty(proto, 'dayOfYear', {
    get: function () { return __epochDayOf(this.year, this.monthValue, this.dayOfMonth) - __epochDayOf(this.year, 1, 1) + 1; }
  });
  Object.defineProperty(proto, 'month', { get: function () { return Month.of(this.monthValue); } });
  proto.getYear = function () { return this.year; };
  proto.getMonthValue = function () { return this.monthValue; };
  proto.getMonth = function () { return this.month; };
  proto.getDayOfMonth = function () { return this.dayOfMonth; };
  proto.getDayOfWeek = function () { return this.dayOfWeek; };
  proto.getDayOfYear = function () { return this.dayOfYear; };
  proto.isLeapYear = function () { return __isLeapYear(this.year); };
  proto.lengthOfMonth = function () { return __monthLength(this.year, this.monthValue); };
  proto.lengthOfYear = function () { return __isLeapYear(this.year) ? 366 : 365; };
  proto.get = function (field) {
    if (field === null || field === undefined || typeof field.__read !== 'function') {
      throw __timeError('This converted extension read a date field Yorozo does not model.');
    }
    if (field.__time === true && this.hour === undefined) throw __timeError('Unsupported field: ' + field.name);
    return field.__read(this.__fields());
  };
  proto.getLong = proto.get;
  proto.format = function (formatter) { return __formatterArg(formatter).format(this); };
  proto.hashCode = function () { return 0; };
  // The plus/minus family, all spelled through 'plus(amount, unit)'.
  var units = { Nanos: 'NANOS', Seconds: 'SECONDS', Minutes: 'MINUTES', Hours: 'HOURS', Days: 'DAYS',
    Weeks: 'WEEKS', Months: 'MONTHS', Years: 'YEARS', Millis: 'MILLIS' };
  Object.keys(units).forEach(function (suffix) {
    proto['plus' + suffix] = function (amount) { return this.plus(amount, ChronoUnit[units[suffix]]); };
    proto['minus' + suffix] = function (amount) { return this.plus(-Number(amount), ChronoUnit[units[suffix]]); };
  });
  proto.minus = function (amount, unit) {
    if (unit === undefined) return this.plus(-__durationMillis(amount));
    return this.plus(-Number(amount), unit);
  };
  proto.isBefore = function (other) { return this.compareTo(other) < 0; };
  proto.isAfter = function (other) { return this.compareTo(other) > 0; };
  proto.isEqual = function (other) { return this.compareTo(other) === 0; };
}

/** A kotlin.time Duration, which is milliseconds here, or a refusal. */
function __durationMillis(amount) {
  if (typeof amount === 'number') return amount;
  throw __timeError('This converted extension moved a date by an amount Yorozo does not model.');
}

/** Months added to a date, with the day clamped to the new month's length. */
function __addMonths(year, month, day, months) {
  var total = year * 12 + (month - 1) + months;
  var nextYear = __fdiv(total, 12);
  var nextMonth = __fmod(total, 12) + 1;
  return [nextYear, nextMonth, Math.min(day, __monthLength(nextYear, nextMonth))];
}

function __checkDate(year, month, day) {
  var y = __timeInt(year, 'a year');
  var m = __timeInt(month, 'a month');
  var d = __timeInt(day, 'a day');
  if (m < 1 || m > 12) throw __timeError('Invalid value for MonthOfYear: ' + m);
  if (d < 1 || d > __monthLength(y, m)) {
    throw __timeError('Invalid date: ' + __pad(y, 4) + '-' + __pad(m, 2) + '-' + __pad(d, 2));
  }
  return [y, m, d];
}

function __checkTime(hour, minute, second, nano) {
  var h = __timeInt(hour === undefined ? 0 : hour, 'an hour');
  var mi = __timeInt(minute === undefined ? 0 : minute, 'a minute');
  var s = __timeInt(second === undefined ? 0 : second, 'a second');
  var n = __timeInt(nano === undefined ? 0 : nano, 'a nanosecond');
  if (h < 0 || h > 23) throw __timeError('Invalid value for HourOfDay: ' + h);
  if (mi < 0 || mi > 59) throw __timeError('Invalid value for MinuteOfHour: ' + mi);
  if (s < 0 || s > 59) throw __timeError('Invalid value for SecondOfMinute: ' + s);
  if (n < 0 || n > 999999999) throw __timeError('Invalid value for NanoOfSecond: ' + n);
  return [h, mi, s, n];
}

function __isoDate(year, month, day) {
  var y = year > 9999 ? '+' + year : (year < 0 ? '-' + __pad(-year, 4) : __pad(year, 4));
  return y + '-' + __pad(month, 2) + '-' + __pad(day, 2);
}

/** java.time's LocalTime.toString: seconds and the fraction only when present. */
function __isoTime(hour, minute, second, nano) {
  var text = __pad(hour, 2) + ':' + __pad(minute, 2);
  if (second === 0 && nano === 0) return text;
  text += ':' + __pad(second, 2);
  if (nano === 0) return text;
  if (nano % 1000000 === 0) return text + '.' + __pad(nano / 1000000, 3);
  if (nano % 1000 === 0) return text + '.' + __pad(nano / 1000, 6);
  return text + '.' + __pad(nano, 9);
}

/* --- LocalDate ------------------------------------------------------------ */

function __LocalDate(year, month, day) {
  this.year = year;
  this.monthValue = month;
  this.dayOfMonth = day;
}
__temporalProto(__LocalDate.prototype);

function __localDate(year, month, day) {
  var checked = __checkDate(year, month, day);
  return new __LocalDate(checked[0], checked[1], checked[2]);
}

function __localDateOfEpochDay(epochDay) {
  var civil = __civilOf(epochDay);
  return new __LocalDate(civil.year, civil.month, civil.day);
}

__LocalDate.prototype.__fields = function () {
  return { year: this.year, month: this.monthValue, day: this.dayOfMonth };
};
__LocalDate.prototype.toEpochDay = function () { return __epochDayOf(this.year, this.monthValue, this.dayOfMonth); };
__LocalDate.prototype.plus = function (amount, unit) {
  if (unit === undefined) {
    throw __timeError('This converted extension added a Duration to a LocalDate, which java.time refuses too.');
  }
  var step = __unitArg(unit);
  var count = __timeInt(amount, 'an amount');
  if (step.__months > 0) {
    var moved = __addMonths(this.year, this.monthValue, this.dayOfMonth, count * step.__months);
    return new __LocalDate(moved[0], moved[1], moved[2]);
  }
  if (step === ChronoUnit.DAYS || step === ChronoUnit.WEEKS) {
    return __localDateOfEpochDay(this.toEpochDay() + count * (step === ChronoUnit.WEEKS ? 7 : 1));
  }
  throw __timeError('Unsupported unit: ' + step.toString());
};
__LocalDate.prototype.withDayOfMonth = function (day) { return __localDate(this.year, this.monthValue, day); };
__LocalDate.prototype.withMonth = function (month) {
  var m = __checkDate(this.year, month, 1)[1];
  return new __LocalDate(this.year, m, Math.min(this.dayOfMonth, __monthLength(this.year, m)));
};
__LocalDate.prototype.withYear = function (year) {
  var y = __timeInt(year, 'a year');
  return new __LocalDate(y, this.monthValue, Math.min(this.dayOfMonth, __monthLength(y, this.monthValue)));
};
__LocalDate.prototype.withDayOfYear = function (day) {
  return __localDateOfEpochDay(__epochDayOf(this.year, 1, 1) + __timeInt(day, 'a day of the year') - 1);
};
/**
 * The first instant of the day — a LocalDateTime at midnight, or with a zone
 * a ZonedDateTime. Not always midnight: where a zone's clocks jump forward
 * AT midnight, the day starts at the first time that exists, which is what
 * the zone resolution below gives.
 */
__LocalDate.prototype.atStartOfDay = function (zone) {
  var midnight = new __LocalDateTime(this.year, this.monthValue, this.dayOfMonth, 0, 0, 0, 0);
  return zone === undefined ? midnight : midnight.atZone(zone);
};
__LocalDate.prototype.atTime = function (hour, minute, second, nano) {
  var time = __checkTime(hour, minute, second, nano);
  return new __LocalDateTime(this.year, this.monthValue, this.dayOfMonth, time[0], time[1], time[2], time[3]);
};
__LocalDate.prototype.until = function (end, unit) {
  var other = __asLocalDate(end);
  var step = __unitArg(unit);
  if (step.__months > 0) {
    var months = (other.year * 12 + other.monthValue) - (this.year * 12 + this.monthValue);
    if (months > 0 && other.dayOfMonth < this.dayOfMonth) months -= 1;
    else if (months < 0 && other.dayOfMonth > this.dayOfMonth) months += 1;
    return Math.trunc(months / step.__months);
  }
  var days = other.toEpochDay() - this.toEpochDay();
  if (step === ChronoUnit.DAYS) return days;
  if (step === ChronoUnit.WEEKS) return Math.trunc(days / 7);
  throw __timeError('Unsupported unit: ' + step.toString());
};
__LocalDate.prototype.compareTo = function (other) {
  return this.toEpochDay() - __asLocalDate(other).toEpochDay();
};
__LocalDate.prototype.equals = function (other) {
  return other instanceof __LocalDate && this.compareTo(other) === 0;
};
__LocalDate.prototype.toString = function () { return __isoDate(this.year, this.monthValue, this.dayOfMonth); };

function __asLocalDate(value) {
  if (value instanceof __LocalDate) return value;
  if (value !== null && value !== undefined && typeof value.toLocalDate === 'function') return value.toLocalDate();
  throw __timeError('This converted extension compared a LocalDate with something that is not one.');
}

var LocalDate = {
  of: function (year, month, day) {
    return __localDate(year, month instanceof __Named ? month.value : month, day);
  },
  ofEpochDay: function (day) { return __localDateOfEpochDay(__timeInt(day, 'an epoch day')); },
  ofYearDay: function (year, day) { return __localDate(year, 1, 1).withDayOfYear(day); },
  ofInstant: function (instant, zone) { return __zoned(__epochMillisOf(instant), __zoneArg(zone)).toLocalDate(); },
  now: function (zoneOrClock) { return __nowIn(zoneOrClock).toLocalDate(); },
  parse: function (text, formatter) {
    var f = __parseWith(text, formatter, DateTimeFormatter.ISO_LOCAL_DATE);
    __requireFields(f, text, ['year', 'month', 'day']);
    return __localDate(f.year, f.month, f.day);
  },
  from: function (value) { return __asLocalDate(value); },
  EPOCH: new __LocalDate(1970, 1, 1),
  MIN: new __LocalDate(-999999999, 1, 1),
  MAX: new __LocalDate(999999999, 12, 31)
};

/* --- LocalDateTime -------------------------------------------------------- */

function __LocalDateTime(year, month, day, hour, minute, second, nano) {
  this.year = year;
  this.monthValue = month;
  this.dayOfMonth = day;
  this.hour = hour;
  this.minute = minute;
  this.second = second;
  this.nano = nano;
}
__temporalProto(__LocalDateTime.prototype);

/** The fields as if they were UTC, in milliseconds — the local timeline. */
__LocalDateTime.prototype.__localMillis = function () {
  return __epochDayOf(this.year, this.monthValue, this.dayOfMonth) * __MS_PER_DAY +
    this.hour * 3600000 + this.minute * 60000 + this.second * 1000 + __fdiv(this.nano, 1000000);
};

/** A local reading from the local timeline, keeping the sub-millisecond nanos. */
function __localDateTimeOf(localMillis, subMillisNanos) {
  var day = __fdiv(localMillis, __MS_PER_DAY);
  var civil = __civilOf(day);
  var rest = localMillis - day * __MS_PER_DAY;
  return new __LocalDateTime(
    civil.year, civil.month, civil.day,
    __fdiv(rest, 3600000), __fdiv(rest % 3600000, 60000), __fdiv(rest % 60000, 1000),
    (rest % 1000) * 1000000 + (subMillisNanos || 0)
  );
}

__LocalDateTime.prototype.__fields = function () {
  return {
    year: this.year, month: this.monthValue, day: this.dayOfMonth,
    hour: this.hour, minute: this.minute, second: this.second, nano: this.nano
  };
};
__LocalDateTime.prototype.toLocalDate = function () {
  return new __LocalDate(this.year, this.monthValue, this.dayOfMonth);
};
__LocalDateTime.prototype.plus = function (amount, unit) {
  if (unit === undefined) return __localDateTimeOf(this.__localMillis() + __durationMillis(amount), this.nano % 1000000);
  var step = __unitArg(unit);
  if (step.__dateBased) {
    var date = this.toLocalDate().plus(amount, step);
    return new __LocalDateTime(date.year, date.monthValue, date.dayOfMonth, this.hour, this.minute, this.second, this.nano);
  }
  var count = __timeInt(amount, 'an amount');
  if (step === ChronoUnit.NANOS || step === ChronoUnit.MICROS) {
    var nanos = this.nano % 1000000 + count * (step === ChronoUnit.NANOS ? 1 : 1000);
    return __localDateTimeOf(this.__localMillis() + __fdiv(nanos, 1000000), __fmod(nanos, 1000000));
  }
  return __localDateTimeOf(this.__localMillis() + count * step.__ms, this.nano % 1000000);
};
__LocalDateTime.prototype.__with = function (changes) {
  var f = this.__fields();
  var year = changes.year === undefined ? f.year : changes.year;
  var month = changes.month === undefined ? f.month : changes.month;
  var day = changes.day === undefined ? f.day : changes.day;
  var date = __checkDate(year, month, day);
  var time = __checkTime(
    changes.hour === undefined ? f.hour : changes.hour,
    changes.minute === undefined ? f.minute : changes.minute,
    changes.second === undefined ? f.second : changes.second,
    changes.nano === undefined ? f.nano : changes.nano
  );
  return new __LocalDateTime(date[0], date[1], date[2], time[0], time[1], time[2], time[3]);
};
__LocalDateTime.prototype.withYear = function (year) {
  var y = __timeInt(year, 'a year');
  return this.__with({ year: y, day: Math.min(this.dayOfMonth, __monthLength(y, this.monthValue)) });
};
__LocalDateTime.prototype.withMonth = function (month) {
  var m = __checkDate(this.year, month, 1)[1];
  return this.__with({ month: m, day: Math.min(this.dayOfMonth, __monthLength(this.year, m)) });
};
__LocalDateTime.prototype.withDayOfMonth = function (day) { return this.__with({ day: day }); };
__LocalDateTime.prototype.withHour = function (hour) { return this.__with({ hour: hour }); };
__LocalDateTime.prototype.withMinute = function (minute) { return this.__with({ minute: minute }); };
__LocalDateTime.prototype.withSecond = function (second) { return this.__with({ second: second }); };
__LocalDateTime.prototype.withNano = function (nano) { return this.__with({ nano: nano }); };
__LocalDateTime.prototype.truncatedTo = function (unit) {
  var step = __unitArg(unit);
  if (step === ChronoUnit.DAYS) return this.__with({ hour: 0, minute: 0, second: 0, nano: 0 });
  if (step.__dateBased || step.__ms > __MS_PER_DAY) throw __timeError('Unit is too large to be used for truncation');
  var nanosOfDay = (this.hour * 3600 + this.minute * 60 + this.second) * 1e9 + this.nano;
  var size = step.__ms * 1000000;
  var kept = nanosOfDay - __fmod(nanosOfDay, size);
  var seconds = __fdiv(kept, 1e9);
  return new __LocalDateTime(this.year, this.monthValue, this.dayOfMonth,
    __fdiv(seconds, 3600), __fdiv(seconds % 3600, 60), seconds % 60, kept - seconds * 1e9);
};
__LocalDateTime.prototype.atZone = function (zone) {
  var resolved = __zoneArg(zone);
  var instant = resolved.__instantOf(this.__localMillis(), null);
  return __zoned(instant, resolved, this.nano % 1000000);
};
__LocalDateTime.prototype.atOffset = function (offset) {
  var zone = __offsetArg(offset);
  return __offsetDateTime(this.__localMillis() - zone.__std * 1000, zone, this.nano % 1000000);
};
__LocalDateTime.prototype.toInstant = function (offset) {
  return __instantOf(this.__localMillis() - __offsetArg(offset).__std * 1000);
};
__LocalDateTime.prototype.toEpochSecond = function (offset) {
  return __fdiv(this.__localMillis() - __offsetArg(offset).__std * 1000, 1000);
};
__LocalDateTime.prototype.until = function (end, unit) {
  var other = end instanceof __LocalDateTime ? end : end.toLocalDateTime();
  var step = __unitArg(unit);
  if (step.__dateBased) {
    var days = this.toLocalDate().until(other.toLocalDate(), step);
    return days;
  }
  return Math.trunc((other.__localMillis() - this.__localMillis()) / step.__ms);
};
__LocalDateTime.prototype.compareTo = function (other) {
  var that = other instanceof __LocalDateTime ? other : other.toLocalDateTime();
  var diff = this.__localMillis() - that.__localMillis();
  return diff !== 0 ? diff : (this.nano % 1000000) - (that.nano % 1000000);
};
__LocalDateTime.prototype.equals = function (other) {
  return other instanceof __LocalDateTime && this.compareTo(other) === 0;
};
__LocalDateTime.prototype.toString = function () {
  return __isoDate(this.year, this.monthValue, this.dayOfMonth) + 'T' +
    __isoTime(this.hour, this.minute, this.second, this.nano);
};

function __offsetArg(value) {
  var zone = __zoneArg(value);
  if (zone.__rule !== null) {
    throw __timeError('This converted extension passed a named zone where java.time wants a ZoneOffset.');
  }
  return zone;
}

var LocalDateTime = {
  of: function (year, month, day, hour, minute, second, nano) {
    if (year instanceof __LocalDate) {
      throw __timeError('This converted extension built a LocalDateTime from a LocalTime, which Yorozo does not model.');
    }
    var date = __checkDate(year, month instanceof __Named ? month.value : month, day);
    var time = __checkTime(hour, minute, second, nano);
    return new __LocalDateTime(date[0], date[1], date[2], time[0], time[1], time[2], time[3]);
  },
  now: function (zoneOrClock) { return __nowIn(zoneOrClock).toLocalDateTime(); },
  ofInstant: function (instant, zone) { return __zoned(__epochMillisOf(instant), __zoneArg(zone)).toLocalDateTime(); },
  ofEpochSecond: function (seconds, nanos, offset) {
    var millis = __timeInt(seconds, 'seconds') * 1000 + __fdiv(Number(nanos || 0), 1000000);
    return __localDateTimeOf(millis + __offsetArg(offset).__std * 1000, __fmod(Number(nanos || 0), 1000000));
  },
  parse: function (text, formatter) {
    var f = __parseWith(text, formatter, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
    __requireFields(f, text, ['year', 'month', 'day', 'hour']);
    return LocalDateTime.of(f.year, f.month, f.day, f.hour, f.minute, f.second, f.nano);
  },
  from: function (value) {
    if (value instanceof __LocalDateTime) return value;
    if (value !== null && value !== undefined && typeof value.toLocalDateTime === 'function') return value.toLocalDateTime();
    throw __timeError('Unable to obtain LocalDateTime from ' + __str(value));
  }
};

/* --- ZonedDateTime and OffsetDateTime -------------------------------------- */

/*
 * One constructor for both: a local reading, the offset in force, and the
 * zone that decided it. An OffsetDateTime is the case where the zone IS the
 * offset. What separates them is what 'plusDays' means across a clock change —
 * a ZonedDateTime keeps the wall-clock time and re-resolves, an
 * OffsetDateTime keeps the offset — and that is the zone's rule, not a flag.
 */
function __ZonedDateTime(instantMillis, zone, subMillisNanos, offsetOnly) {
  var offset = zone.__offsetAt(instantMillis);
  var local = __localDateTimeOf(instantMillis + offset * 1000, subMillisNanos || 0);
  this.year = local.year;
  this.monthValue = local.monthValue;
  this.dayOfMonth = local.dayOfMonth;
  this.hour = local.hour;
  this.minute = local.minute;
  this.second = local.second;
  this.nano = local.nano;
  this.offset = __zoneOffset(offset);
  this.zone = offsetOnly ? this.offset : zone;
  this.__instant = instantMillis;
  this.__offsetOnly = offsetOnly === true;
}
__temporalProto(__ZonedDateTime.prototype);

function __zoned(instantMillis, zone, subMillisNanos) {
  return new __ZonedDateTime(instantMillis, zone, subMillisNanos, false);
}
function __offsetDateTime(instantMillis, offset, subMillisNanos) {
  return new __ZonedDateTime(instantMillis, offset, subMillisNanos, true);
}

__ZonedDateTime.prototype.__fields = function () {
  return {
    year: this.year, month: this.monthValue, day: this.dayOfMonth,
    hour: this.hour, minute: this.minute, second: this.second, nano: this.nano,
    offset: this.offset.__std, zone: this.zone
  };
};
__ZonedDateTime.prototype.getZone = function () { return this.zone; };
__ZonedDateTime.prototype.getOffset = function () { return this.offset; };
__ZonedDateTime.prototype.toInstant = function () { return __instantOf(this.__instant, this.nano % 1000000); };
__ZonedDateTime.prototype.toEpochSecond = function () { return __fdiv(this.__instant, 1000); };
__ZonedDateTime.prototype.toLocalDateTime = function () {
  return new __LocalDateTime(this.year, this.monthValue, this.dayOfMonth, this.hour, this.minute, this.second, this.nano);
};
__ZonedDateTime.prototype.toLocalDate = function () {
  return new __LocalDate(this.year, this.monthValue, this.dayOfMonth);
};
__ZonedDateTime.prototype.toOffsetDateTime = function () {
  return __offsetDateTime(this.__instant, this.offset, this.nano % 1000000);
};
__ZonedDateTime.prototype.toZonedDateTime = function () {
  return __zoned(this.__instant, this.zone, this.nano % 1000000);
};
/** A new local reading in this value's zone, keeping its offset where it can. */
__ZonedDateTime.prototype.__relocal = function (local) {
  if (this.__offsetOnly) return __offsetDateTime(local.__localMillis() - this.offset.__std * 1000, this.offset, local.nano % 1000000);
  var instant = this.zone.__instantOf(local.__localMillis(), this.offset.__std);
  return __zoned(instant, this.zone, local.nano % 1000000);
};
__ZonedDateTime.prototype.__retime = function (instantMillis, subMillisNanos) {
  return new __ZonedDateTime(instantMillis, this.zone, subMillisNanos, this.__offsetOnly);
};
/**
 * Date units move the wall clock and re-resolve in the zone; time units move
 * the instant. So 'plusDays(1)' across a clock change is the same time
 * tomorrow, and 'plusHours(24)' is twenty-four real hours — java.time's rule.
 */
__ZonedDateTime.prototype.plus = function (amount, unit) {
  if (unit === undefined) return this.__retime(this.__instant + __durationMillis(amount), this.nano % 1000000);
  var step = __unitArg(unit);
  if (step.__dateBased) return this.__relocal(this.toLocalDateTime().plus(amount, step));
  var moved = this.toLocalDateTime().plus(amount, step);
  var delta = moved.__localMillis() - this.toLocalDateTime().__localMillis();
  return this.__retime(this.__instant + delta, moved.nano % 1000000);
};
['withYear', 'withMonth', 'withDayOfMonth', 'withHour', 'withMinute', 'withSecond', 'withNano', 'truncatedTo']
  .forEach(function (name) {
    __ZonedDateTime.prototype[name] = function (value) {
      return this.__relocal(this.toLocalDateTime()[name](value));
    };
  });
__ZonedDateTime.prototype.withZoneSameInstant = function (zone) {
  return __zoned(this.__instant, __zoneArg(zone), this.nano % 1000000);
};
__ZonedDateTime.prototype.withZoneSameLocal = function (zone) {
  return this.toLocalDateTime().atZone(zone);
};
__ZonedDateTime.prototype.withOffsetSameInstant = function (offset) {
  return __offsetDateTime(this.__instant, __offsetArg(offset), this.nano % 1000000);
};
__ZonedDateTime.prototype.atZoneSameInstant = __ZonedDateTime.prototype.withZoneSameInstant;
__ZonedDateTime.prototype.until = function (end, unit) {
  var step = __unitArg(unit);
  var other = __asZoned(end);
  if (step.__dateBased) {
    return this.toLocalDateTime().until(other.withZoneSameInstant(this.zone).toLocalDateTime(), step);
  }
  return Math.trunc((other.__instant - this.__instant) / step.__ms);
};
__ZonedDateTime.prototype.compareTo = function (other) {
  var that = __asZoned(other);
  var diff = this.__instant - that.__instant;
  return diff !== 0 ? diff : (this.nano % 1000000) - (that.nano % 1000000);
};
__ZonedDateTime.prototype.equals = function (other) {
  return other instanceof __ZonedDateTime && this.compareTo(other) === 0 && this.zone.equals(other.zone);
};
__ZonedDateTime.prototype.toString = function () {
  var text = this.toLocalDateTime().toString() + this.offset.id;
  return this.__offsetOnly || this.zone.__rule === null && this.zone.id === this.offset.id
    ? text
    : text + '[' + this.zone.id + ']';
};

function __asZoned(value) {
  if (value instanceof __ZonedDateTime) return value;
  if (value instanceof __Instant) return __zoned(value.__ms, ZoneOffset.UTC, value.__subNanos);
  throw __timeError('This converted extension compared a date with something that is not one.');
}

/** 'now' in a zone or on a clock, as a ZonedDateTime; UTC when neither. */
function __nowIn(zoneOrClock) {
  var millis = __nowMillis(zoneOrClock);
  return __zoned(millis, __zoneArg(zoneOrClock));
}

var ZonedDateTime = {
  now: function (zoneOrClock) { return __nowIn(zoneOrClock); },
  of: function (a, b, c, d, e, f, g, h) {
    if (a instanceof __LocalDateTime) return a.atZone(b);
    if (a instanceof __LocalDate) {
      throw __timeError('This converted extension built a ZonedDateTime from a LocalTime, which Yorozo does not model.');
    }
    return LocalDateTime.of(a, b, c, d, e, f, g).atZone(h);
  },
  ofInstant: function (instant, zone) {
    var value = __instantArg(instant);
    return __zoned(value.__ms, __zoneArg(zone), value.__subNanos);
  },
  parse: function (text, formatter) {
    var f = __parseWith(text, formatter, DateTimeFormatter.ISO_ZONED_DATE_TIME);
    return __zonedFromFields(f, text, formatter, false);
  },
  from: function (value) { return __asZoned(value); }
};

var OffsetDateTime = {
  now: function (zoneOrClock) {
    var zoned = __nowIn(zoneOrClock);
    return __offsetDateTime(zoned.__instant, zoned.offset);
  },
  of: function (a, b, c, d, e, f, g, h) {
    if (a instanceof __LocalDateTime) return a.atOffset(b);
    return LocalDateTime.of(a, b, c, d, e, f, g).atOffset(h);
  },
  ofInstant: function (instant, zone) {
    var value = __instantArg(instant);
    var resolved = __zoneArg(zone);
    return __offsetDateTime(value.__ms, __zoneOffset(resolved.__offsetAt(value.__ms)), value.__subNanos);
  },
  parse: function (text, formatter) {
    var f = __parseWith(text, formatter, DateTimeFormatter.ISO_OFFSET_DATE_TIME);
    return __zonedFromFields(f, text, formatter, true);
  }
};

/**
 * A zoned reading out of parsed fields: a parsed offset or zone decides, else
 * the formatter's own zone ('withZone'), else it is not a zoned value and
 * java.time throws — which is what 'tryParseZonedDateTime' relies on to fall
 * through to the next pattern.
 */
function __zonedFromFields(f, text, formatter, offsetOnly) {
  __requireFields(f, text, ['year', 'month', 'day', 'hour']);
  var local = LocalDateTime.of(f.year, f.month, f.day, f.hour, f.minute, f.second, f.nano);
  var zone = f.zone !== null ? f.zone : (formatter !== undefined && formatter !== null ? formatter.zone : null);
  if (zone === null || zone === undefined) {
    throw __parseError(text, 'it carries no offset or zone');
  }
  if (offsetOnly) {
    var offset = zone.__rule === null ? zone : __zoneOffset(zone.__offsetAt(zone.__instantOf(local.__localMillis(), null)));
    return local.atOffset(offset);
  }
  return local.atZone(zone);
}

/* --- Instant -------------------------------------------------------------- */

/**
 * java.time's Instant and kotlin.time's, which are one value here.
 *
 * Milliseconds, with the sub-millisecond nanos carried alongside for
 * 'toString' and 'nano'. 'valueOf' is the millisecond count, so Kotlin's
 * operators on an Instant — 'now - 5.days', 'a < b' — do what they say: a
 * kotlin.time Duration is milliseconds here, and the difference of two
 * instants is one.
 */
function __Instant(millis, subNanos) {
  this.__ms = millis;
  this.__subNanos = subNanos || 0;
  this.epochSecond = __fdiv(millis, 1000);
  this.epochSeconds = this.epochSecond;
  this.nano = __fmod(millis, 1000) * 1000000 + this.__subNanos;
  this.nanosecondsOfSecond = this.nano;
}

function __instantOf(millis, subNanos) {
  if (!Number.isFinite(millis)) throw __timeError('This converted extension built an instant out of ' + millis + '.');
  return new __Instant(millis, subNanos);
}

__Instant.prototype.__kTime = true;
__Instant.prototype.valueOf = function () { return this.__ms; };
__Instant.prototype.toEpochMilli = function () { return this.__ms; };
__Instant.prototype.toEpochMilliseconds = function () { return this.__ms; };
__Instant.prototype.getEpochSecond = function () { return this.epochSecond; };
__Instant.prototype.toEpochSeconds = function () { return this.epochSecond; };
__Instant.prototype.getNano = function () { return this.nano; };
__Instant.prototype.toInstant = function () { return this; };
__Instant.prototype.toJavaInstant = function () { return this; };
__Instant.prototype.toKotlinInstant = function () { return this; };
__Instant.prototype.atZone = function (zone) { return __zoned(this.__ms, __zoneArg(zone), this.__subNanos); };
__Instant.prototype.atOffset = function (offset) {
  return __offsetDateTime(this.__ms, __offsetArg(offset), this.__subNanos);
};
__Instant.prototype.plus = function (amount, unit) {
  if (unit === undefined) return __instantOf(this.__ms + __durationMillis(amount), this.__subNanos);
  var step = __unitArg(unit);
  if (step.__months > 0 || step === ChronoUnit.WEEKS) throw __timeError('Unsupported unit: ' + step.toString());
  var count = __timeInt(amount, 'an amount');
  if (step === ChronoUnit.NANOS || step === ChronoUnit.MICROS) {
    var nanos = this.__subNanos + count * (step === ChronoUnit.NANOS ? 1 : 1000);
    return __instantOf(this.__ms + __fdiv(nanos, 1000000), __fmod(nanos, 1000000));
  }
  return __instantOf(this.__ms + count * step.__ms, this.__subNanos);
};
__Instant.prototype.minus = function (amount, unit) {
  // kotlin.time's 'a.minus(b)' with an Instant 'b' is the Duration between.
  if (unit === undefined && amount instanceof __Instant) return this.__ms - amount.__ms;
  if (unit === undefined) return this.plus(-__durationMillis(amount));
  return this.plus(-Number(amount), unit);
};
__Instant.prototype.plusMillis = function (n) { return this.plus(n, ChronoUnit.MILLIS); };
__Instant.prototype.plusSeconds = function (n) { return this.plus(n, ChronoUnit.SECONDS); };
__Instant.prototype.plusNanos = function (n) { return this.plus(n, ChronoUnit.NANOS); };
__Instant.prototype.minusMillis = function (n) { return this.plus(-Number(n), ChronoUnit.MILLIS); };
__Instant.prototype.minusSeconds = function (n) { return this.plus(-Number(n), ChronoUnit.SECONDS); };
__Instant.prototype.minusNanos = function (n) { return this.plus(-Number(n), ChronoUnit.NANOS); };
__Instant.prototype.truncatedTo = function (unit) {
  var step = __unitArg(unit);
  if (step.__dateBased && step !== ChronoUnit.DAYS) throw __timeError('Unit is too large to be used for truncation');
  if (step === ChronoUnit.NANOS) return this;
  if (step === ChronoUnit.MICROS) return __instantOf(this.__ms, this.__subNanos - this.__subNanos % 1000);
  return __instantOf(this.__ms - __fmod(this.__ms, step.__ms), 0);
};
__Instant.prototype.until = function (end, unit) {
  return Math.trunc((__epochMillisOf(end) - this.__ms) / __unitArg(unit).__ms);
};
__Instant.prototype.compareTo = function (other) {
  var that = __instantArg(other);
  var diff = this.__ms - that.__ms;
  return diff !== 0 ? diff : this.__subNanos - that.__subNanos;
};
__Instant.prototype.isBefore = function (other) { return this.compareTo(other) < 0; };
__Instant.prototype.isAfter = function (other) { return this.compareTo(other) > 0; };
__Instant.prototype.equals = function (other) {
  return other instanceof __Instant && this.compareTo(other) === 0;
};
__Instant.prototype.hashCode = function () { return this.__ms | 0; };
/** ISO-8601 in UTC, with the fraction only when there is one — java.time's. */
__Instant.prototype.toString = function () {
  var zoned = __zoned(this.__ms, ZoneOffset.UTC, this.__subNanos);
  var date = __isoDate(zoned.year, zoned.monthValue, zoned.dayOfMonth);
  var time = __pad(zoned.hour, 2) + ':' + __pad(zoned.minute, 2) + ':' + __pad(zoned.second, 2);
  var nano = zoned.nano;
  if (nano !== 0) {
    if (nano % 1000000 === 0) time += '.' + __pad(nano / 1000000, 3);
    else if (nano % 1000 === 0) time += '.' + __pad(nano / 1000, 6);
    else time += '.' + __pad(nano, 9);
  }
  return date + 'T' + time + 'Z';
};

function __instantArg(value) {
  if (value instanceof __Instant) return value;
  if (typeof value === 'number') return __instantOf(value);
  if (value instanceof __ZonedDateTime) return value.toInstant();
  throw __timeError('This converted extension passed something that is not an instant.');
}

/** Epoch milliseconds out of whatever a caller holds for a point in time. */
function __epochMillisOf(value) {
  if (typeof value === 'number') return value;
  if (value instanceof __Instant) return value.__ms;
  if (value instanceof __ZonedDateTime) return value.__instant;
  if (value !== null && value !== undefined && typeof value.time === 'number') return value.time;
  throw __timeError('This converted extension passed something that is not a point in time.');
}

/**
 * An ISO-8601 instant — the shape a JSON API sends — read strictly.
 *
 * 'Date.parse' is not used: what it accepts beyond ISO is engine-defined, and
 * a date-time with no offset it reads in the DEVICE's zone. java.time and
 * kotlin.time both refuse such a string, and so does this; the callers that
 * want a fallback wrote 'parseOrNull' or 'tryParse' for exactly that case.
 */
function __parseIsoInstant(text) {
  var f = __isoFields(__str(text).trim());
  if (f === null || f.hour === null || f.zone === null || f.zone.__rule !== null) return null;
  var local = __epochDayOf(f.year, f.month, f.day) * __MS_PER_DAY +
    f.hour * 3600000 + f.minute * 60000 + f.second * 1000 + __fdiv(f.nano, 1000000);
  if (f.month < 1 || f.month > 12 || f.day < 1 || f.day > __monthLength(f.year, f.month)) return null;
  if (f.hour > 23 || f.minute > 59 || f.second > 59) return null;
  return __instantOf(local - f.zone.__std * 1000, f.nano % 1000000);
}

var Instant = {
  EPOCH: new __Instant(0, 0),
  now: function (clock) { return __instantOf(__nowMillis(clock)); },
  ofEpochMilli: function (millis) { return __instantOf(__timeInt(millis, 'epoch milliseconds')); },
  ofEpochSecond: function (seconds, nanos) {
    var extra = Number(nanos || 0);
    return __instantOf(__timeInt(seconds, 'epoch seconds') * 1000 + __fdiv(extra, 1000000), __fmod(extra, 1000000));
  },
  fromEpochMilliseconds: function (millis) { return __instantOf(__timeInt(millis, 'epoch milliseconds')); },
  fromEpochSeconds: function (seconds, nanos) { return Instant.ofEpochSecond(seconds, nanos); },
  parse: function (text) {
    var parsed = __parseIsoInstant(text);
    if (parsed === null) throw __parseError(text, 'it is not an ISO-8601 instant');
    return parsed;
  },
  /*
   * kotlin.time's reader of an ISO-8601 string, which this catalogue uses for
   * an upload date more than any other spelling — and keiyoushi's 'tryParse'
   * over it, which answers 0 rather than null because its callers assign it
   * straight to 'date_upload', where 0 means "no date".
   */
  parseOrNull: function (text) { return text === null || text === undefined ? null : __parseIsoInstant(text); },
  tryParse: function (text) {
    var parsed = text === null || text === undefined ? null : __parseIsoInstant(text);
    return parsed === null ? 0 : parsed.__ms;
  },
  from: function (value) { return __instantArg(value); }
};

/**
 * kotlin.time's Clock and java.time's, which a converted extension only ever
 * reads the time off. 'Clock.System.now()' is the kotlin spelling and
 * 'Clock.systemUTC()' the java one.
 */
function __clock(zone) {
  return {
    now: function () { return Instant.now(); },
    millis: function () { return Date.now(); },
    instant: function () { return Instant.now(); },
    getZone: function () { return zone; },
    zone: zone,
    withZone: function (other) { return __clock(__zoneArg(other)); }
  };
}

var Clock = {
  System: __clock(__systemZone()),
  systemUTC: function () { return __clock(ZoneOffset.UTC); },
  systemDefaultZone: function () { return __clock(__systemZone()); },
  system: function (zone) { return __clock(__zoneArg(zone)); }
};

/** java.time's Year, for 'Year.now().value' — the top of a year filter. */
function __year(value) {
  var year = __timeInt(value, 'a year');
  return {
    value: year,
    getValue: function () { return year; },
    isLeap: function () { return __isLeapYear(year); },
    length: function () { return __isLeapYear(year) ? 366 : 365; },
    atDay: function (day) { return LocalDate.ofYearDay(year, day); },
    plusYears: function (n) { return __year(year + Number(n)); },
    minusYears: function (n) { return __year(year - Number(n)); },
    toString: function () { return String(year); }
  };
}

var Year = {
  now: function (zoneOrClock) { return __year(__nowIn(zoneOrClock).year); },
  of: function (value) { return __year(value); },
  isLeap: function (value) { return __isLeapYear(Number(value)); }
};

/** kotlin.time's Duration constants. A Duration is milliseconds here. */
var Duration = { ZERO: 0, INFINITE: Infinity };

/* --- reading and writing dates by pattern ---------------------------------- */

/**
 * The ISO-8601 shapes java.time's predefined formatters read: a date, then
 * optionally 'T' and a time, then optionally an offset, then optionally a
 * zone id in brackets. Which parts are REQUIRED is the formatter's business.
 */
function __isoFields(text) {
  var found = /^([+-]?[0-9]{4,9})-([0-9]{2})-([0-9]{2})(?:[Tt]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:[.,]([0-9]{1,9}))?)?)?(Z|z|[+-][0-9]{2}(?::?[0-9]{2}(?::?[0-9]{2})?)?)?(?:\\[([^\\]]+)\\])?$/.exec(text);
  if (found === null) return null;
  var fraction = found[7] === undefined ? '' : found[7];
  while (fraction.length < 9) fraction += '0';
  var zone = null;
  if (found[9] !== undefined) {
    zone = __zoneFromText(found[9]);
    if (zone === null) return null;
  } else if (found[8] !== undefined) {
    zone = __zoneOffset(__offsetSeconds(found[8]));
  }
  return {
    year: Number(found[1]),
    month: Number(found[2]),
    day: Number(found[3]),
    hour: found[4] === undefined ? null : Number(found[4]),
    minute: found[5] === undefined ? 0 : Number(found[5]),
    second: found[6] === undefined ? 0 : Number(found[6]),
    nano: Number(fraction),
    offsetText: found[8] === undefined ? null : found[8],
    zone: zone
  };
}

/**
 * A pattern, as the letters it is made of — one reader for SimpleDateFormat's
 * pattern language and DateTimeFormatter's, which agree on every letter a
 * scraper writes. Quoted text is a literal; '' is a quote.
 */
function __patternTokens(pattern) {
  var tokens = [];
  var i = 0;
  while (i < pattern.length) {
    var ch = pattern.charAt(i);
    if (ch === "'") {
      var close = pattern.indexOf("'", i + 1);
      var literal = close === -1 ? pattern.slice(i + 1) : pattern.slice(i + 1, close);
      tokens.push({ literal: literal.length === 0 ? "'" : literal });
      i = close === -1 ? pattern.length : close + 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      var run = 1;
      while (i + run < pattern.length && pattern.charAt(i + run) === ch) run += 1;
      tokens.push({ letter: ch, run: run });
      i += run;
      continue;
    }
    // '[' and ']' mark an optional section in java.time's language; their
    // contents are read as ordinary tokens, which matches when the section is
    // present — the case a scraper's own pages produce.
    if (ch === '[' || ch === ']') { i += 1; continue; }
    tokens.push({ literal: ch });
    i += 1;
  }
  return tokens;
}

/**
 * A pattern as a regex plus the field each group fills.
 *
 * Offsets and zones ('X', 'x', 'Z', 'O', 'z', 'V') are CAPTURED: a page that
 * says '+07:00' after a time is saying which instant it means, and a reader
 * that dropped it answered a value off by that many hours.
 */
function __datePattern(pattern) {
  var tokens = __patternTokens(__str(pattern));
  var source = '';
  var fields = [];
  for (var t = 0; t < tokens.length; t += 1) {
    var token = tokens[t];
    if (token.literal !== undefined) {
      source += /^\\s$/.test(token.literal) ? '\\\\s+' : __regexQuote(token.literal);
      continue;
    }
    var ch = token.letter;
    var run = token.run;
    // 'yyyyMMdd': with nothing between two numbers, only the pattern's widths
    // say where one ends — java's adjacent-value rule. Elsewhere a field reads
    // as many digits as are there, so '5/1/2024' fits 'dd/MM/yyyy'.
    var next = tokens[t + 1];
    var adjacent = next !== undefined && next.letter !== undefined && __numericLetter(next.letter, next.run);
    var digits = function (loose) { return adjacent ? '([0-9]{' + run + '})' : loose; };
    if (ch === 'y' || ch === 'u') {
      source += run === 2 ? '([0-9]{2})' : digits('([0-9]{1,9})');
      fields.push(run === 2 ? 'year2' : 'year');
    } else if (ch === 'M' || ch === 'L') {
      if (run >= 3) { source += '([A-Za-z\\u00c0-\\u024f.]+)'; fields.push('monthName'); }
      else { source += digits('([0-9]{1,2})'); fields.push('month'); }
    } else if (ch === 'd') { source += digits('([0-9]{1,2})'); fields.push('day'); }
    else if (ch === 'H' || ch === 'k') { source += digits('([0-9]{1,2})'); fields.push(ch === 'k' ? 'hour24' : 'hour'); }
    else if (ch === 'h' || ch === 'K') { source += digits('([0-9]{1,2})'); fields.push('hour12'); }
    else if (ch === 'm') { source += digits('([0-9]{1,2})'); fields.push('minute'); }
    else if (ch === 's') { source += digits('([0-9]{1,2})'); fields.push('second'); }
    else if (ch === 'S') { source += digits('([0-9]{1,9})'); fields.push('fraction'); }
    else if (ch === 'a') { source += '([AaPp]\\\\.?[Mm]\\\\.?)'; fields.push('meridiem'); }
    else if (ch === 'E') { source += '[A-Za-z.]+'; }
    else if (ch === 'X' || ch === 'x' || ch === 'Z' || ch === 'O' || ch === 'z' || ch === 'V') {
      source += '([A-Za-z0-9/_:+-]*)';
      fields.push('zone');
    } else source += '.{' + run + '}';
  }
  return { source: '^\\\\s*' + source + '\\\\s*$', fields: fields };
}

function __numericLetter(letter, run) {
  if (letter === 'M' || letter === 'L') return run < 3;
  return 'yudHkhKmsS'.indexOf(letter) !== -1;
}

/**
 * The fields a pattern read out of a text, or null.
 *
 * 'has' records which ones the TEXT supplied, because java.time answers
 * differently for a field that was read and one that defaulted: a LocalDate
 * from a pattern with no year is an exception there, not the year 1970.
 */
function __readDate(parts, text) {
  var found = new RegExp(parts.source).exec(__str(text));
  if (found === null) return null;
  var read = {
    year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0, nano: 0,
    zone: null, has: {}
  };
  var meridiem = '';
  var hour12 = null;
  for (var i = 0; i < parts.fields.length; i += 1) {
    var value = found[i + 1];
    var field = parts.fields[i];
    if (field === 'year') { read.year = Number(value); read.has.year = true; }
    else if (field === 'year2') { read.year = 2000 + Number(value); read.has.year = true; }
    else if (field === 'month') { read.month = Number(value); read.has.month = true; }
    else if (field === 'monthName') {
      var index = __monthIndex(value);
      if (index < 0) return null;
      read.month = index + 1;
      read.has.month = true;
    } else if (field === 'day') { read.day = Number(value); read.has.day = true; }
    else if (field === 'hour') { read.hour = Number(value); read.has.hour = true; }
    else if (field === 'hour24') { read.hour = Number(value) % 24; read.has.hour = true; }
    else if (field === 'hour12') { hour12 = Number(value); read.has.hour = true; }
    else if (field === 'minute') { read.minute = Number(value); read.has.minute = true; }
    else if (field === 'second') { read.second = Number(value); read.has.second = true; }
    else if (field === 'fraction') {
      var digits = __str(value).slice(0, 9);
      while (digits.length < 9) digits += '0';
      read.nano = Number(digits);
    } else if (field === 'meridiem') meridiem = __str(value).replace(/[.]/g, '').toLowerCase();
    else if (field === 'zone') {
      // A zone that is not one this runtime can read is left unread, as the
      // reader always did: the pattern still matched, and the caller's own
      // zone decides.
      var zone = __zoneFromText(value);
      if (zone !== null) read.zone = zone;
    }
  }
  if (hour12 !== null) {
    read.hour = hour12 % 12;
    if (meridiem === 'pm') read.hour += 12;
    else if (meridiem !== 'am') read.hour = hour12;
  }
  if (read.month < 1 || read.month > 12) return null;
  return read;
}

function __parseError(text, why) {
  var error = new Error('This converted extension could not read "' + __str(text) + '" as a date: ' + why + '.');
  error.name = 'DateTimeParseException';
  return error;
}

function __requireFields(f, text, names) {
  for (var i = 0; i < names.length; i += 1) {
    if (f.has[names[i]] !== true) throw __parseError(text, 'the pattern gives it no ' + names[i]);
  }
}

/** Fields out of a text through a formatter, or the ISO default; throws on a miss. */
function __parseWith(text, formatter, fallback) {
  if (text === null || text === undefined) throw __parseError(text, 'it is null');
  var chosen = formatter === undefined || formatter === null ? fallback : __formatterArg(formatter);
  return chosen.__read(__str(text));
}

function __formatterArg(value) {
  if (value instanceof __DateTimeFormatter) return value;
  throw __timeError('This converted extension formatted a date with something that is not a DateTimeFormatter.');
}

/**
 * java.time's DateTimeFormatter: a pattern, a locale, and an optional zone.
 *
 * The zone is 'withZone(…)', and it matters twice: formatting an Instant needs
 * one to know what the wall clock read, and parsing a text that carries no
 * offset uses it to decide which instant was meant. keiyoushi's
 * 'tryParseDate(text)' falls back on it too — 'zone ?: this.zone'.
 */
function __DateTimeFormatter(pattern, locale, zone, iso) {
  this.pattern = pattern;
  this.locale = locale === undefined || locale === null ? Locale.getDefault() : locale;
  this.zone = zone === undefined ? null : zone;
  this.__iso = iso === undefined ? null : iso;
  this.__parts = iso ? null : __datePattern(pattern);
  this.__tokens = iso ? null : __patternTokens(pattern);
}
__DateTimeFormatter.prototype.getZone = function () { return this.zone; };
__DateTimeFormatter.prototype.getLocale = function () { return this.locale; };
__DateTimeFormatter.prototype.withZone = function (zone) {
  return __withDefaults(
    new __DateTimeFormatter(this.pattern, this.locale, zone === null ? null : __zoneArg(zone), this.__iso),
    this.__defaults
  );
};
__DateTimeFormatter.prototype.withLocale = function (locale) {
  return __withDefaults(new __DateTimeFormatter(this.pattern, locale, this.zone, this.__iso), this.__defaults);
};

/** A formatter's 'parseDefaulting' fields, carried to a copy of it. */
function __withDefaults(formatter, defaults) {
  if (defaults !== undefined && defaults.length > 0) formatter.__defaults = defaults.slice();
  return formatter;
}
__DateTimeFormatter.prototype.toString = function () { return this.pattern; };
__DateTimeFormatter.prototype.__read = function (text) {
  if (this.__iso !== null) {
    var iso = __isoFields(text.trim());
    if (iso === null) throw __parseError(text, 'it is not ISO-8601');
    var needsTime = this.__iso !== 'date';
    if (needsTime && iso.hour === null) throw __parseError(text, 'it has no time');
    if (this.__iso === 'date' && iso.hour !== null) throw __parseError(text, 'it has a time');
    if (this.__iso === 'local' && iso.zone !== null) throw __parseError(text, 'it has an offset');
    var needsOffset = this.__iso === 'offset' || this.__iso === 'instant' || this.__iso === 'zoned';
    if (needsOffset && iso.offsetText === null) {
      throw __parseError(text, 'it has no offset');
    }
    return {
      year: iso.year, month: iso.month, day: iso.day,
      hour: iso.hour === null ? 0 : iso.hour, minute: iso.minute, second: iso.second, nano: iso.nano,
      zone: iso.zone,
      has: { year: true, month: true, day: true, hour: iso.hour !== null, minute: iso.hour !== null, second: iso.hour !== null }
    };
  }
  var read = __readDate(this.__parts, text);
  if (read === null) throw __parseError(text, 'it does not match "' + this.pattern + '"');
  // 'parseDefaulting(field, value)' from a DateTimeFormatterBuilder: a field
  // the pattern did not give is taken as that value, and one it did give is
  // left alone, as java.time does.
  var defaults = this.__defaults || [];
  for (var d = 0; d < defaults.length; d += 1) {
    var key = defaults[d][0];
    if (read.has[key] !== true) {
      read[key] = defaults[d][1];
      read.has[key] = true;
    }
  }
  return read;
};
/** What java.time hands back from 'parse': the fields, and the instant when it can say. */
__DateTimeFormatter.prototype.parse = function (text) {
  var read = this.__read(__str(text));
  var local = __epochDayOf(read.year, read.month, read.day) * __MS_PER_DAY +
    read.hour * 3600000 + read.minute * 60000 + read.second * 1000 + __fdiv(read.nano, 1000000);
  var zone = read.zone !== null ? read.zone : (this.zone !== null ? this.zone : ZoneOffset.UTC);
  var millis = zone.__instantOf(local, null);
  return { __fields: read, time: millis, getTime: function () { return millis; } };
};
__DateTimeFormatter.prototype.format = function (value) {
  var fields;
  if (value instanceof __Instant || typeof value === 'number') {
    if (this.zone === null) {
      throw __timeError('This converted extension formatted an Instant with a formatter that has no zone; java.time refuses that too.');
    }
    fields = __zoned(__epochMillisOf(value), this.zone).__fields();
  } else if (value !== null && value !== undefined && typeof value.__fields === 'function') {
    // An override zone re-expresses anything that is an instant in it.
    fields = this.zone !== null && value instanceof __ZonedDateTime
      ? value.withZoneSameInstant(this.zone).__fields()
      : value.__fields();
  } else {
    throw __timeError('This converted extension formatted something that is not a date.');
  }
  if (this.__iso !== null) return __formatIso(this.__iso, fields);
  return __formatFields(this.__tokens, fields, this.locale);
};

function __formatIso(kind, f) {
  var date = __isoDate(f.year, f.month, f.day);
  if (kind === 'date') return date;
  if (f.hour === undefined) throw __timeError('Unsupported field: HourOfDay');
  // The predefined formatters always write the seconds, and a fraction with
  // its trailing zeros dropped — unlike 'toString', which drops zero seconds.
  var fraction = f.nano === 0 ? '' : '.' + __pad(f.nano, 9).replace(/0+$/, '');
  var text = date + 'T' + __pad(f.hour, 2) + ':' + __pad(f.minute, 2) + ':' + __pad(f.second, 2) + fraction;
  if (kind === 'local') return text;
  if (f.offset === undefined) throw __timeError('Unsupported field: OffsetSeconds');
  if (kind === 'instant') return __instantOf(__epochDayOf(f.year, f.month, f.day) * __MS_PER_DAY +
    f.hour * 3600000 + f.minute * 60000 + f.second * 1000 + __fdiv(f.nano, 1000000) - f.offset * 1000).toString();
  text += __offsetId(f.offset);
  if ((kind === 'zoned' || kind === 'any') && f.zone && f.zone.__rule !== null) text += '[' + f.zone.id + ']';
  return text;
}

/** A temporal's fields written out through a pattern's letters. */
function __formatFields(tokens, f, locale) {
  var out = '';
  for (var t = 0; t < tokens.length; t += 1) {
    var token = tokens[t];
    if (token.literal !== undefined) { out += token.literal; continue; }
    var ch = token.letter;
    var run = token.run;
    var timeLetter = 'HhKkmsSa'.indexOf(ch) !== -1;
    if (timeLetter && f.hour === undefined) throw __timeError('Unsupported field: ' + ch + ' on a date with no time');
    if (ch === 'y' || ch === 'u') out += run === 2 ? __pad(__fmod(f.year, 100), 2) : __pad(f.year, run);
    else if (ch === 'M' || ch === 'L') {
      if (run >= 4) out += __englishName(__MONTH_NAMES[f.month - 1], 'FULL', locale);
      else if (run === 3) out += __englishName(__MONTH_NAMES[f.month - 1], 'SHORT', locale);
      else out += __pad(f.month, run);
    } else if (ch === 'd') out += __pad(f.day, run);
    else if (ch === 'D') out += __pad(__epochDayOf(f.year, f.month, f.day) - __epochDayOf(f.year, 1, 1) + 1, run);
    else if (ch === 'E') {
      var dow = __DAY_NAMES[__isoDayOfWeek(__epochDayOf(f.year, f.month, f.day)) - 1];
      out += __englishName(dow, run >= 4 ? 'FULL' : 'SHORT', locale);
    } else if (ch === 'H') out += __pad(f.hour, run);
    else if (ch === 'k') out += __pad(f.hour === 0 ? 24 : f.hour, run);
    else if (ch === 'h') out += __pad(f.hour % 12 === 0 ? 12 : f.hour % 12, run);
    else if (ch === 'K') out += __pad(f.hour % 12, run);
    else if (ch === 'm') out += __pad(f.minute, run);
    else if (ch === 's') out += __pad(f.second, run);
    else if (ch === 'S') out += __pad(f.nano, 9).slice(0, run);
    else if (ch === 'a') out += f.hour < 12 ? 'AM' : 'PM';
    else if ('XxZO'.indexOf(ch) !== -1) {
      if (f.offset === undefined) throw __timeError('Unsupported field: OffsetSeconds');
      out += __formatOffset(ch, run, f.offset);
    } else if (ch === 'z' || ch === 'V') {
      if (f.offset === undefined) throw __timeError('Unsupported field: ZoneId');
      out += f.zone && f.zone.__rule !== null ? f.zone.id : __offsetId(f.offset);
    } else out += ch;
  }
  return out;
}

function __formatOffset(letter, run, seconds) {
  if (seconds === 0 && (letter === 'X' || (letter === 'Z' && run === 5))) return 'Z';
  var sign = seconds < 0 ? '-' : '+';
  var abs = Math.abs(seconds);
  var hours = __pad(__fdiv(abs, 3600), 2);
  var minutes = __pad(__fdiv(abs % 3600, 60), 2);
  if (letter === 'O') {
    if (seconds === 0) return 'GMT';
    return run === 4 ? 'GMT' + sign + hours + ':' + minutes : 'GMT' + sign + Number(hours) + (minutes === '00' ? '' : ':' + minutes);
  }
  if (letter === 'Z') {
    if (run === 4) return seconds === 0 ? 'GMT' : 'GMT' + sign + hours + ':' + minutes;
    if (run === 5) return sign + hours + ':' + minutes;
    return sign + hours + minutes;
  }
  if (run === 1) return sign + hours + (minutes === '00' ? '' : minutes);
  if (run === 2 || run === 4) return sign + hours + minutes;
  return sign + hours + ':' + minutes;
}

/**
 * java.time's DateTimeFormatterBuilder, as this catalogue uses it: a pattern
 * appended, fields defaulted for a text that leaves them out — "12 March"
 * read as this year — and a formatter out of it. 'parseDefaulting' takes the
 * six fields a date pattern here can carry; any other is refused where it is
 * asked, rather than silently ignored at parse time.
 */
var __DEFAULTABLE = {
  YEAR: 'year', MONTH_OF_YEAR: 'month', DAY_OF_MONTH: 'day',
  HOUR_OF_DAY: 'hour', MINUTE_OF_HOUR: 'minute', SECOND_OF_MINUTE: 'second'
};
function DateTimeFormatterBuilder() {
  if (!(this instanceof DateTimeFormatterBuilder)) return new DateTimeFormatterBuilder();
  this.__pattern = '';
  this.__defaults = [];
}
DateTimeFormatterBuilder.prototype.appendPattern = function (pattern) {
  this.__pattern += __str(pattern);
  return this;
};
DateTimeFormatterBuilder.prototype.parseDefaulting = function (field, value) {
  var key = field === null || field === undefined ? undefined : __DEFAULTABLE[field.name];
  if (key === undefined) {
    throw __timeError('This converted extension defaulted a date field this runtime does not parse.');
  }
  this.__defaults.push([key, Number(value)]);
  return this;
};
DateTimeFormatterBuilder.prototype.toFormatter = function (locale) {
  return __withDefaults(new __DateTimeFormatter(this.__pattern, locale), this.__defaults);
};

var DateTimeFormatter = {
  ofPattern: function (pattern, locale) { return new __DateTimeFormatter(__str(pattern), locale); },
  ISO_LOCAL_DATE: new __DateTimeFormatter('yyyy-MM-dd', null, null, 'date'),
  ISO_DATE: new __DateTimeFormatter('yyyy-MM-dd', null, null, 'date'),
  ISO_LOCAL_DATE_TIME: new __DateTimeFormatter("yyyy-MM-dd'T'HH:mm:ss", null, null, 'local'),
  ISO_DATE_TIME: new __DateTimeFormatter("yyyy-MM-dd'T'HH:mm:ssXXX'['VV']'", null, null, 'any'),
  ISO_OFFSET_DATE_TIME: new __DateTimeFormatter("yyyy-MM-dd'T'HH:mm:ssXXX", null, null, 'offset'),
  ISO_ZONED_DATE_TIME: new __DateTimeFormatter("yyyy-MM-dd'T'HH:mm:ssXXX'['VV']'", null, null, 'zoned'),
  ISO_INSTANT: new __DateTimeFormatter("yyyy-MM-dd'T'HH:mm:ssX", null, null, 'instant'),
  RFC_1123_DATE_TIME: new __DateTimeFormatter('EEE, d MMM yyyy HH:mm:ss O', null, null)
};

/* --- the helpers that reach the above from emitted code ------------------- */

/**
 * keiyoushi's three date readers, each with java.time's own meaning — which
 * is why they are three helpers and not one.
 *
 * - tryParseDate: the DATE fields only, at the start of that day in the zone
 *   given, else the formatter's zone, else the system's.
 * - tryParseDateTime: date and time, in that zone; an offset in the text is
 *   ignored, as upstream documents.
 * - tryParseZonedDateTime: the text's own offset or zone decides, and a text
 *   with none FAILS. Sources chain the three with '?: ' precisely so that a
 *   miss falls through to the next reading; answering the first one for a
 *   text it should have refused parsed the time in UTC and stopped the chain.
 *
 * All three answer epoch milliseconds, and 0 for anything unreadable.
 */
__k.tryParseDate = function (formatter, text, zone) {
  if (text === null || text === undefined) return 0;
  try {
    var date = LocalDate.parse(text, formatter);
    return date.atStartOfDay(__readerZone(formatter, zone)).toInstant().toEpochMilli();
  } catch (error) {
    return 0;
  }
};

__k.tryParseDateTime = function (formatter, text, zone) {
  if (text === null || text === undefined) return 0;
  try {
    return LocalDateTime.parse(text, formatter).atZone(__readerZone(formatter, zone)).toInstant().toEpochMilli();
  } catch (error) {
    return 0;
  }
};

__k.tryParseZonedDateTime = function (formatter, text) {
  if (text === null || text === undefined) return 0;
  try {
    return ZonedDateTime.parse(text, formatter).toInstant().toEpochMilli();
  } catch (error) {
    return 0;
  }
};

function __readerZone(formatter, zone) {
  if (zone !== null && zone !== undefined) return __zoneArg(zone);
  if (formatter !== null && formatter !== undefined && formatter.zone) return formatter.zone;
  return __systemZone();
}

/**
 * kotlin.time's unit properties on a number that is not a literal:
 * '(amount * 7).days', 'number.seconds'. A Duration is milliseconds here, the
 * same unit a literal '5.seconds' is folded to at conversion.
 *
 * The receiver decides, because the emitter has no types: Kotlin resolves a
 * member before an extension, so on anything that is not a number the same
 * spelling is an ordinary field read and stays one.
 */
__k.durationOf = function (value, name, factor) {
  if (typeof value === 'number') return value * factor;
  if (value === null || value === undefined) return value;
  return value[name];
};

/** Duration's 'inWhole…' readers, over the same milliseconds; truncated toward zero. */
__k.inWhole = function (value, name) {
  if (typeof value !== 'number') return value === null || value === undefined ? value : value[name];
  var per = { inWholeNanoseconds: 0.000001, inWholeMicroseconds: 0.001, inWholeMilliseconds: 1,
    inWholeSeconds: 1000, inWholeMinutes: 60000, inWholeHours: 3600000, inWholeDays: __MS_PER_DAY }[name];
  return Math.trunc(value / per);
};

/**
 * An Instant's millisecond reading, where the value may already BE the
 * milliseconds: 'Clock.System.now() - 5.days' is JavaScript subtraction on the
 * two values' 'valueOf', and answers the number the Kotlin's Instant held.
 */
__k.toEpochMilliseconds = function (value) {
  if (typeof value === 'number') return value;
  return __epochMillisOf(value);
};

/** kotlin.time's and java.time's Instant are one value here; a bare number becomes one. */
__k.toJavaInstant = function (value) {
  return typeof value === 'number' ? __instantOf(value) : value;
};
`;
