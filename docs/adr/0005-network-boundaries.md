# ADR 0005 — Three network capabilities the compatibility layer does not have, and which of them it should

Status: **proposed** · 2026-09-10 · extends ADR-0004 · depends on ADR-0003 ·
reads against `contract/plugin-api/FOREIGN.md` §4.1 and `docs/ANIYOMI-COMPATIBILITY-MAP.md`

Research answer to: "the translator converts; the sources still mostly do not
play. What is left, and how much of it is a decision rather than a bug?"

Short version: **the bug-fixing path for the sources this build can reach is
spent.** What remains is three capability questions, and they are not equal —
one is an ordinary HTTP primitive, one is a security posture, and one is a
different product. This document states what each is worth, measured, so the
decision is made against numbers rather than against appetite.

Rule 9 applies to this document. No content source is named anywhere in it; the
cases are described by shape, and the counts come from a run whose index URL was
supplied at run time and is not recorded here.

---

## 1. Decision

| Capability                         | Decision                                                        | Why                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Per-plugin cookie jar**          | **Proposed, constrained** — build when a second source needs it | An ordinary part of HTTP, and the narrowest of the three. Worth **one** listing today.                                                                                                              |
| **Site-side JavaScript execution** | **Refused**, and this ADR is where that is written down         | Worth at least four listings, and it is a different product with a different threat model. `AGENTS.md` rule 13 already forbids `eval`; this says why the _capability_, not the function, stays out. |
| **Anti-bot / challenge solving**   | **Deferred, and separable**                                     | Worth ~20 listings, but it changes what this software _is_ to the sources it reads, which is a question for a person and not for a runtime.                                                         |

---

## 2. The measurement this is decided against

One catalogue of 254 listings, converter v41, every verdict produced by a fresh
run:

|                                                          |                  |
| -------------------------------------------------------- | ---------------- |
| Installable (converts, loads, runs)                      | **60**           |
| Of those, live and reachable                             | **27**           |
| Of those, complete `search → episodes → resolve → fetch` | **5**            |
| **Portable / live-and-reachable**                        | **5 / 27 — 19%** |

`5 of 254` is the wrong number to steer by: 33 of the 60 installable listings
never answer this build at all. They divide as **20 blocked by an anti-bot
challenge**, **6 whose host does not resolve or refuses**, **6 whose endpoint is
gone**, and **1 that serves no https**. None of those is a runtime fault, and no
amount of translator work moves them.

The 22 live sources that do answer and still do not play divide as:

- **~4 build their player element in script.** The page arrives with no
  `iframe`, or with one whose `src` is `about:blank`. The markup the extension
  selects on is produced after load, by the page.
- **~1 needs a cookie.** It collects a session value from the first response's
  `Set-Cookie` and sends it on the second request. Measured both ways: with the
  header it returns 30 results, without it, none.
- **The rest are drift.** The class, the id, or the delimiter the extension
  reads is no longer on the page — proven per source by fetching what the
  extension asked for and running _its own selector_ over it with `shims/dom.ts`.
  One reads a stream url that the source's own third-party decoder minted
  **bound to that decoder's IP address**, which nothing on this side can fetch.

Drift is not a capability question. It is the ordinary cost of scraping, and it
is the source's to fix, not ours.

---

## 3. Cookies

**What is missing.** `/api/plugin-fetch` forwards four response headers —
`content-type`, `content-length`, `location`, `retry-after` — and drops the rest.
That is deliberate: a `Set-Cookie` handed to a plugin is a credential handed to
untrusted code, and the proxy is stateless so nothing would carry it anyway.

**What it costs today.** One listing, measured. It is the _least_ speculative of
the three: the behaviour is defined by RFC 6265, every other client on the
network implements it, and this ecosystem will produce more sources that expect
it.

**The shape, if built.** Not "forward `Set-Cookie`", which hands a credential to
a plugin. A **jar the host holds**:

- per plugin, per host; never shared between plugins
- in memory only; never read from or written to the browser's own cookie store
- only for hosts already granted to that plugin (rule 13's allowlist, unchanged)
- attached by the host on the way out, never visible to plugin code
- explicit lifetime, cleared with the sandbox
- no API for a plugin to read, enumerate or exfiltrate a cookie

Under that shape the plugin gains no authority it did not have: it could already
make the request; it simply could not carry state between two of them. That is
why this is the defensible one.

**Recommendation.** Specify it now, build it when a second live source needs it.
One listing does not pay for a new stateful surface in the host, and the design
above is cheap to hold in reserve.

---

## 3b. Decided 2026-09-10 — the opt-in comes from the format, not the extension

Built, and the measurement moved the design. §3 assumed a plugin would ask for a
jar. Almost none do: **every listing whose source named a cookie API named
`loadForRequest`** — the one call this ADR forbids outright — and the extensions
that actually need continuity never mention cookies at all, because the
framework they were written against installed a jar on the shared client.

An opt-in derived from the translated module therefore finds nothing and the
session silently never carries. So the grant is **format-level**: an adapter
whose foreign framework carries cookies automatically requests the constrained
jar for the bundles it produces (`formats.ts`, `implicitCookies`; true for
`aniyomi`, false everywhere else).

This does not widen the capability, and the bounds are the point:

- only for a format whose framework already made that guarantee
- only for hosts the plugin was already granted
- in memory, cleared at unload
- never readable by plugin code — `loadForRequest` and `CookieManager` stay
  refused at conversion, and there is no enumeration or export
- announced in diagnostics as **"stateful HTTP enabled by format adapter"**,
  because for most plugins carrying it nothing in their own source asked

The extension gains no cookie API. It gains the request continuity its original
platform would have given it, and nothing else.

---

## 4. Site-side JavaScript execution

**What is missing.** A way to run the page's own scripts so that a player
element written at run time exists to be selected.

**What it costs today.** At least four live listings, and it is the single
largest group among sources that answer.

**Why it stays refused.** This is not the `eval` ban restated. `AGENTS.md`
rule 13 forbids `eval` _inside the sandbox_; this is about whether the host
should acquire a browsing engine at all, and the answer is that it would stop
being the thing ADR-0003 and ADR-0004 describe:

- **The threat model inverts.** Today a plugin is translated source we have read,
  running with no ambient capability. Executing a _site's_ script means running
  code nobody converted, nobody reviewed, and which changes whenever the site
  changes.
- **The sandbox stops being the boundary.** The value of a sealed realm is that
  the only way out is `ctx.http`. A page's script expects a DOM, a window, a
  cookie store and an origin; supplying those convincingly is supplying the
  escape.
- **It is a second runtime.** `ANIYOMI-COMPATIBILITY-MAP.md` §4 already records
  that the reference implementation's own WebView is a **stub** — it fires
  `onPageFinished` after a sleep and answers `evaluateJavascript` with `null`.
  The project that runs real bytecode on a JVM did not build this either.

**The honest alternative** is narrower and already half-built: recognise the
_specific_ shapes rather than run the script. Where a player url is assembled by
a known packer, `unpackDeanEdwards` already exists. Where it is fetched by an
XHR the page makes, that request can often be made directly. That is per-shape
work with a bounded blast radius, and it is the only version of this worth doing.

---

## 5. Anti-bot and challenge handling

**What is missing.** Twenty listings answer this build with `403`, `503` or
`522` on the first request. A browser User-Agent changes nothing — **tested
directly against six of them, both with and without a real Chrome UA: `403`
either way.** These are challenge pages, not header checks.

**What it would cost.** Solving a challenge means presenting as a browser that
is not a browser: executing the challenge script (see §4), persisting the
resulting cookie (see §3), and maintaining that against a vendor whose business
is defeating it. It also changes the relationship with the source from "a client
reading a page" to "a client working around a decision the source made".

**Recommendation.** Deferred, and kept **separable** from §3 and §4 so that
neither is argued for on this one's behalf. If it is ever taken up it should be
an explicit, per-plugin, viewer-visible opt-in, and it should not be the reason
the cookie jar or a scripting engine exists.

---

## 6. What none of the three fixes

Stated so that a later reader does not mistake the ceiling for a capability gap:

- A stream url **bound to another host's IP address** is unfetchable by
  construction, whatever headers, ranges or redirects are used.
- A **dead or moved endpoint** is dead.
- **Markup drift** is fixed by the extension's author, upstream, or by nobody.

Roughly half of the 22 live-but-not-playing sources are in this group. The
ceiling on `portable / live-and-reachable` is therefore lower than 27 no matter
which capabilities are added.

---

## 7. Order of work

1. **Done.** The isolate now reports what a plugin threw rather than only that
   it died — three verdicts that read "the sandbox exited with code 1" now name
   their cause. Bad diagnostics turn external failures into fake runtime
   mysteries, which is what this whole document exists to avoid repeating.
2. **Hold** at 19%, and stop steering by it. Measure
   `portable / live-and-reachable` per run; the denominator is the honest part.
3. **Cookies** when a second live source needs them, to the shape in §3.
4. **Per-shape extraction** (§4's alternative) ahead of any scripting engine.
5. **Anti-bot**: only as a deliberate, separate, opt-in decision.
