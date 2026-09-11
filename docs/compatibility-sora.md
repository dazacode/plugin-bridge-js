# Sora — the second ecosystem, and what it proved

Measured 2026-09-11 against one live public catalogue of 69 modules. The index
URL is a runtime argument and is not recorded here; rule 9 applies to this
document as to every other, so no content source is named anywhere in it.

This exists because the repository makes a claim — that the Kotlin front-end is
_one_ front-end and the rest is a general compatibility engine — and until a
second ecosystem was driven end to end, that claim was untested. Six adapters
were named and exactly one had ever been measured.

---

## 1. Why this ecosystem was the right test

Of the five unmeasured adapters, this one is the only sharp test available:

| Candidate                | Why not                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A compiled-JVM ecosystem | `browse-only`. The artifact is bytecode, and the classpath is the work.                                                    |
| A manga/novel ecosystem  | Its convertible half is JavaScript, but the media type means the episodes-and-stream half of the chain is never exercised. |
| A torrent ecosystem      | Out of scope — nothing here plays a torrent.                                                                               |

This one converts, it is **anime** so the whole chain is meaningful, and it is
**JavaScript** — which is the point. An ecosystem in the same language as the
first would have proved only that the Kotlin translator is reusable. A
different language tests whether the _core_ is language-agnostic or quietly
shaped around one translator.

---

## 2. The funnel, with the core frozen

No change was made to `packages/core` or `packages/host` during this pass. Only
the adapter moved.

| Stage                                 |        |
| ------------------------------------- | ------ |
| Catalogue entries                     | 69     |
| Manifests readable                    | 68     |
| Anime listings after the media filter | 57     |
| **Converted**                         | **57** |
| **Loaded, exposing the common ABI**   | **57** |
| Search returned real rows             | 54     |
| Episodes listed                       | 51     |
| Claimed a stream                      | 39     |
| **Verified playable**                 | **16** |

**The last two rows are deliberately separate.** A resolved URL is a claim, not
a stream. Each is range-requested **in the same call that resolved it** and
checked: content type, and an `#EXTM3U` sniff for a manifest whose server
mislabels it. Verifying from a saved results file instead measures how long a
signed token lived — on the first ecosystem that gap reported six playable
streams where three play. The 23 that did not answer
failed honestly — 404s, 500s, unverifiable certificate chains, one module that
builds a URL with the host doubled into the path, and one that returns a joke
string. None was a placeholder and none was a stringified object.

For scale, the first ecosystem measured the same way on the same day: **3
verified playable**, from 6 resolved URLs, of 69 that convert and load.

---

## 3. The result that matters

**Not one of the 57 touched the Kotlin front-end.** The adapter imports no part
of it. A module in this ecosystem converts, loads, and exposes exactly
`searchCatalog`, `listEpisodes` and `resolve` — the same three methods the
Kotlin path produces, reached by a completely different road.

```text
Kotlin ecosystem  ──→ its adapter ──┐
                                    ├──→ core ──→ common ABI ──→ host
JavaScript ecosystem ─→ its adapter ┘
```

That diagram was an intention before this measurement. It is now a description.

---

## 4. What the adapter needed — and what core did not

Three changes, **all in the adapter, none in core**.

**A library index that points at manifests.** The format is published in three
shapes: a single manifest, a list with manifests inline, and — for a repository
of many modules — an index whose entries carry a `manifestUrl` one fetch away.
Only the first two were handled. The third is what `ForeignAdapter.loadIndex`
already exists for: _"a format whose index is genuinely split across two
documents."_ The hook was written before this ecosystem was measured and fits it
exactly. **The abstraction was vindicated rather than stretched**, which is the
single strongest piece of evidence in this document.

**Media kind is a mention, not an enum.** Both the manifest's `type` and the
library's `category` are free text written for a person: `anime`, but also
`shows/movies/anime`, `anime/movies`, `movies/shows`, `mangas`, `novels`.
Matching `type === 'anime'` exactly and treating every other non-empty value as
manga dropped **22 anime modules of 56** — silently, because a filtered listing
is one nothing ever explains. Both fields are now read as a mention.

**One genuine core leak, found and removed.** `aniyomiPreferences` lived in
`packages/core`. It knows Kotlin, it knows one ecosystem's four preference
constructor names, and nothing else could ever have used it. It now lives in
that ecosystem's adapter. Core keeps what is genuinely shared: the descriptor
shape every adapter emits, and the literal readers both parsers use.

**Still outstanding**, recorded rather than quietly fixed: `core/detect.ts`
imports every adapter, so the dependency points the wrong way and adding a
seventh ecosystem means editing core. That is architectural rather than specific
to any one ecosystem, and it deserves its own change.

---

## 5. Read the contract. Never infer the ABI from returned objects

Two harness bugs in one day, both silent, both producing numbers that looked
publishable:

- A results field read as `video` where the driver returns `streams`. It
  reported **0 of 69 resolved** — including every extension already known to
  work. That impossibility is the only reason it was caught.
- A search entry's id guessed as `id` where the contract says **`sourceMediaId`**.
  The whole entry object went into a `String()` inside the runtime, producing
  `https://host/[object%20Object]`, and **three of those were counted as
  resolved streams**.

Neither was an engine fault. Both would have been reported as findings.

The campaign harness now enforces three things, and they belong to whoever runs
the next one:

1. **Validate every ABI boundary against the contract** and fail loudly on a
   shape that does not match — never let an unrecognised value flow onward.
2. **Carry known-good canaries.** If every one fails at once, abort before
   classifying anything: the harness is measuring itself.
3. **Verify a stream before counting it.** Range-request the URL, check what
   answers, and treat a known placeholder host as a module _refusing_ rather
   than working. Report claimed and verified as two numbers, always.
