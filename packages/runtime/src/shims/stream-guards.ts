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

/**
 * `__isPlayable(url)`, `__namesASidecar(raw)`, `__subtitleTrack(...)`,
 * `__streamContainer(...)` and `__torrentOf(...)`.
 *
 * ## Why the container is decided here too
 *
 * Every shim used to guess the container from the url's extension on its own,
 * with its own regular expression, and fall back to `mp4`. Measured against
 * sixteen streams a live addon catalogue verified as playing: six were labelled
 * wrongly — four Matroska files, and two HLS manifests whose urls do not end in
 * `.m3u8`. One Sora mapping sent every declared type that was not exactly
 * `mp4`, `MKV` included, to HLS. And the fields that *state* a container —
 * a Stremio stream's `behaviorHints.filename` and `notWebReady` — were never
 * read. A wrong label is a player error on a stream that works, so the order of
 * evidence is one decision, taken once: see `__streamContainer`.
 *
 * Be exact about what that fixes. An HLS manifest named by its file name or by
 * a proxied address in its query now says so, and a declared `MKV` is no longer
 * HLS. A Matroska file is still labelled `mp4` — correctly *as a transport*,
 * because the ABI's three values are two adaptive manifests and one single
 * file, and wrongly as a MIME hint, because a host that derives `video/mp4`
 * from it is told the wrong thing. There is no value to put there instead
 * until `ABI.md` §3 grows one, and an unknown container is not allowed either:
 * a host refuses a source without one of the three.
 *
 * ## Why torrents are read here
 *
 * Three shims read an info hash three ways: one accepted hex and base32 from a
 * magnet, a declared hash and a bare link; one lowercased whatever arrived;
 * one took hex out of a magnet and nothing else. The same row therefore became
 * a torrent in one ecosystem and nothing in another, and an uppercase or
 * base32 hash two engines for one swarm. `__torrentOf` is the one reading.
 */
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

/* --- container ----------------------------------------------------------- */

/**
 * A container, from a word a source *declared* — a type field, a mime type —
 * compared without regard to case. \`MKV\`, \`HLS\` and \`Mp4\` are all in
 * circulation. Null when the word says nothing this knows.
 *
 * The ABI has three containers (\`ABI.md\` §3) and one of them, \`mp4\`, is the
 * only value for a file fetched and played whole. So Matroska, WebM and
 * QuickTime are \`mp4\` here: the transport is right, which is what the field
 * chooses a pipeline by, and the ABI has no word for the rest. That is a gap in
 * the ABI and not something this function can close — it is named, not hidden.
 */
function __containerNamed(value) {
  if (typeof value !== 'string') return null;
  const word = value.trim().toLowerCase().replace(/^\\./, '');
  if (word.length === 0) return null;
  if (/^(?:hls|m3u8|m3u|application\\/(?:x-mpegurl|vnd\\.apple\\.mpegurl)|audio\\/mpegurl)$/.test(word)) return 'hls';
  if (/^(?:dash|mpd|application\\/dash\\+xml)$/.test(word)) return 'dash';
  if (/^(?:mp4|m4v|mov|mkv|matroska|webm|progressive|video\\/(?:mp4|webm|quicktime|x-matroska|matroska))$/.test(word)) return 'mp4';
  return null;
}

/**
 * A container, from the extension a file name or a url's path ends in.
 *
 * The path only: a query is not part of a file's name, and \`?type=.mp4\` is not
 * the same statement as \`/a.mp4\`. When the path has no extension this knows,
 * a query *value* that is itself a path is asked the same question — the shape
 * of a proxy that carries the real address in a parameter, whose own path says
 * nothing. That is a structural rule about urls, not a list of anybody's.
 */
function __containerOfName(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const extensionOf = function (path) {
    const last = path.slice(path.lastIndexOf('/') + 1);
    const dot = last.lastIndexOf('.');
    return dot === -1 ? null : __containerNamed(last.slice(dot + 1));
  };
  let text = value.trim();
  const hash = text.indexOf('#');
  if (hash !== -1) text = text.slice(0, hash);
  const question = text.indexOf('?');
  const path = question === -1 ? text : text.slice(0, question);
  const own = extensionOf(path);
  if (own !== null) return own;
  if (question === -1) return null;
  for (const pair of text.slice(question + 1).split('&')) {
    const equals = pair.indexOf('=');
    if (equals === -1) continue;
    let inner = pair.slice(equals + 1);
    try { inner = decodeURIComponent(inner.replace(/\\+/g, ' ')); } catch (error) { continue; }
    const innerQuestion = inner.indexOf('?');
    const found = extensionOf(innerQuestion === -1 ? inner : inner.slice(0, innerQuestion));
    if (found !== null) return found;
  }
  return null;
}

/**
 * The container a stream is played as, from the strongest statement about it.
 *
 * 1. **\`declared\`** — what the source said the stream is: Sora's \`streamType\`,
 *    a mime type. Its author knows what it serves.
 * 2. **\`filename\`** — a file name the source stated beside the url, as a
 *    Stremio stream's \`behaviorHints.filename\` does. A debrid link's url is an
 *    opaque token; the file name is the only place its container is written.
 * 3. **\`url\`** — the address's own extension, as \`__containerOfName\` reads it.
 * 4. **\`webReady\`** — Stremio's \`notWebReady\`, inverted. The protocol defines
 *    that flag as "the url is not https or is not an mp4", so a stream that says
 *    it *is* web-ready has stated mp4. One that says it is not has ruled mp4
 *    out without saying what it is instead — and the commonest thing it is, a
 *    Matroska file, is \`mp4\` under the ABI anyway (see \`__containerNamed\`),
 *    so \`false\` is treated as no statement rather than as a reason to guess
 *    HLS.
 * 5. **\`fallback\`** — the format's own prior, used only when nothing above
 *    said anything. The ABI requires one of its three values and has no
 *    "unknown" (\`ABI.md\` §3; a host refuses a source without one), so this is
 *    the single guess left, and each caller names it and why.
 */
function __streamContainer(evidence, fallback) {
  const e = evidence || {};
  const stated = __containerNamed(e.declared) || __containerOfName(e.filename) || __containerOfName(e.url);
  if (stated !== null) return stated;
  if (e.webReady === true) return 'mp4';
  return fallback;
}

/* --- torrents ------------------------------------------------------------ */

/** A base32 info hash (32 characters, RFC 4648 alphabet) as 40 lowercase hex. */
function __base32InfoHash(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const text = String(value).toUpperCase().replace(/=+$/, '');
  if (text.length !== 32) return null;
  let bits = 0;
  let acc = 0;
  let hex = '';
  for (let i = 0; i < text.length; i += 1) {
    const index = alphabet.indexOf(text.charAt(i));
    if (index < 0) return null;
    acc = ((acc << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ('0' + ((acc >> bits) & 0xff).toString(16)).slice(-2);
    }
  }
  return hex.length === 40 ? hex : null;
}

/** A value that is an info hash, hex or base32, as 40 lowercase hex — or null. */
function __infoHashOf(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (/^[0-9a-fA-F]{40}$/.test(text)) return text.toLowerCase();
  return __base32InfoHash(text);
}

/**
 * One torrent, from whichever of the four spellings a row carries it in:
 *
 * - a declared hash — \`hash\` or \`infoHash\` — in hex or base32;
 * - a magnet's \`xt=urn:btih:\`, hex or base32, with its \`tr=\` trackers;
 * - a link that is itself a bare 40-hex hash.
 *
 * Answers \`{ infoHash, trackers }\` or null. A \`.torrent\` url carries its hash
 * only inside bencode behind a SHA-1 of the info dictionary, which is a parser
 * this build does not have, so it is null here rather than a guess.
 */
function __torrentOf(row) {
  if (!row || typeof row !== 'object') return null;
  const declared = __infoHashOf(row.infoHash) || __infoHashOf(row.hash);
  const links = [row.magnet, row.link, row.url];
  let infoHash = declared;
  const trackers = [];
  for (const link of links) {
    if (typeof link !== 'string' || !/^magnet:\\?/i.test(link.trim())) continue;
    const found = /[?&]xt=urn:btih:([0-9a-zA-Z]+)/i.exec(link);
    if (infoHash === null && found !== null) infoHash = __infoHashOf(found[1]);
    const pattern = /[?&]tr=([^&]+)/g;
    let match = pattern.exec(link);
    while (match !== null) {
      try { trackers.push(decodeURIComponent(match[1])); } catch (error) { /* skip one bad tracker */ }
      match = pattern.exec(link);
    }
    break;
  }
  if (infoHash === null) {
    for (const link of links) {
      if (typeof link === 'string' && /^[0-9a-fA-F]{40}$/.test(link.trim())) {
        infoHash = link.trim().toLowerCase();
        break;
      }
    }
  }
  return infoHash === null ? null : { infoHash: infoHash, trackers: trackers };
}
`;
