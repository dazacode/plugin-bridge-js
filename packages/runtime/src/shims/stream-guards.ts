/**
 * The checks every converted bundle applies to a stream before returning it.
 *
 * Emitted as source into the bundle, like the rest of the conversion runtime,
 * because a plugin cannot import from the host (`ABI.md` §1).
 *
 * ## Why this is shared rather than copied per format
 *
 * `__isPlayable` is the single most safety-critical function in a converted
 * bundle, and the reason is in `FOREIGN.md` §6: these ecosystems **signal
 * failure by returning a URL**. A module that has given up hands back a
 * placeholder host or a bare origin, and a shim that passes one through makes
 * the install check report success. The failure then surfaces much later, as a
 * player error, on a plugin already marked as working — and a false pass is
 * worse than a failure, because a failure is information.
 *
 * A rule that important must not exist twice in two adapters that can drift
 * apart. The first converter carried its own copy; every converter now shares
 * this one.
 *
 * The test is deliberately about *shape* rather than about any particular
 * placeholder: a stream lives at a path, and a bare origin with an empty path
 * addresses a site, not a file. That catches the sentinels in circulation
 * without this repository carrying a list of hostnames it would have to keep
 * current — which rule 9 forbids anyway.
 *
 * ## Why a sidecar is guarded before it is made absolute, and a stream after
 *
 * The same rule cannot be asked at the same moment for both. A stream url
 * arrives absolute or nearly so, and `__isPlayable` reads it afterwards.
 * A subtitle url arrives as whatever the module felt like returning, and
 * **`__absolute` will turn any of it into a valid url**: a Sora module says
 * `"none"` for "this stream has no captions", and resolving that against the
 * source's base manufactures `https://the-source/none` — a string no shape
 * rule can distinguish from a real relative path, because by then it *is* one.
 * Absolutising a sentinel does not just fail to catch it, it destroys the
 * evidence that there was one.
 *
 * So `__subtitleTrack` takes the raw value and the base, and resolves only
 * after it has decided. Three adapters call it; none of them can now forget,
 * which is the same reasoning that put `__isPlayable` here in the first place.
 *
 * What this cannot catch is a module that returns an *absolute* sentinel with
 * a path on it. Nothing downstream can either, and saying so is better than
 * implying a guarantee: a wrong caption url costs a track that renders
 * nothing, where a wrong stream url costs a false pass on an install check.
 */

/** `__isPlayable(url)`, `__namesASidecar(raw)` and `__subtitleTrack(...)`. */
export const STREAM_GUARDS = `
/* --- stream guards ------------------------------------------------------- */

function __isPlayable(url) {
  if (typeof url !== 'string' || url.length === 0) return false;
  if (url.indexOf('https://') !== 0 && url.indexOf('http://') !== 0) return false;

  const afterScheme = url.slice(url.indexOf('://') + 3);
  const slash = afterScheme.indexOf('/');
  if (slash === -1) return false;

  // Everything after the host, minus a query or fragment that a bare origin
  // may still carry.
  const path = afterScheme.slice(slash + 1).split('?')[0].split('#')[0];
  return path.length > 0;
}

/**
 * Whether a value names a caption file, asked of what the module actually
 * returned rather than of what \`__absolute\` would make of it.
 *
 * Shape again, not a list. Anything carrying a scheme is a location the module
 * stated on purpose — including the \`data:\` uri a few of them inline a whole
 * vtt into. Anything else is relative, and a relative reference to a *file*
 * ends in an extension. Every sentinel in circulation is a bare word and has
 * none: \`none\`, \`null\`, \`undefined\`, \`false\`, \`N/A\`.
 *
 * The cost of the rule is a relative caption endpoint with no extension, such
 * as \`/api/subtitles/3\`, which is refused. That is the right way round: a
 * missing track is visible and recoverable, and a phantom one is selected by
 * default, renders nothing, and reads to a viewer as subtitles being broken.
 */
function __namesASidecar(raw) {
  if (typeof raw !== 'string') return false;
  const value = raw.trim();
  if (value.length === 0) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return true;
  const path = value.split('?')[0].split('#')[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  return /\\.[a-z0-9]{2,5}$/i.test(last);
}

/**
 * One subtitle sidecar, from the url a module returned and the base to resolve
 * it against. The format is read from the url because that is the only
 * statement about it these ecosystems make.
 */
function __subtitleTrack(url, label, language, base) {
  if (!__namesASidecar(url)) return null;
  const value = __absolute(String(url).trim(), base);
  if (value.length === 0) return null;
  const format = /\\.srt(\\?|$)/i.test(value) ? 'srt' : /\\.ass(\\?|$)/i.test(value) ? 'ass' : 'vtt';
  return {
    // 'und' rather than a guess: a wrong label in the player's track menu is
    // worse than an honest unknown one.
    languageCode: typeof language === 'string' && language.length > 0 ? language : 'und',
    label: typeof label === 'string' && label.length > 0 ? label : 'Subtitles',
    format: format,
    url: value,
    isEmbedded: false,
    isDefault: false
  };
}
`;
