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
 */

/** `__isPlayable(url)` and `__subtitleTrack(url, label)`, as bundle source. */
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
 * One subtitle sidecar. The format is read from the url because that is the
 * only statement about it these ecosystems make.
 */
function __subtitleTrack(url, label, language) {
  if (typeof url !== 'string' || url.length === 0) return null;
  const format = /\\.srt(\\?|$)/i.test(url) ? 'srt' : /\\.ass(\\?|$)/i.test(url) ? 'ass' : 'vtt';
  return {
    // 'und' rather than a guess: a wrong label in the player's track menu is
    // worse than an honest unknown one.
    languageCode: typeof language === 'string' && language.length > 0 ? language : 'und',
    label: typeof label === 'string' && label.length > 0 ? label : 'Subtitles',
    format: format,
    url: url,
    isEmbedded: false,
    isDefault: false
  };
}
`;
