# Measurements — every number this repository reports, dated

This is the one place the numbers live. Every other document links here rather
than carrying its own copy, because two copies of a measurement drift, and a
reader cannot tell which one is current.

Rule 9 applies. Repositories are described, not named, and no content source
is named anywhere; listings are counted, never identified.
[`compatibility.md`](compatibility.md) is how these are measured and why each
column means what it does.

## How to read a number here

Every figure names the stage it measures. They are different questions, and a
number from one is not evidence about the next:

| Stage                 | What it shows                                                                                       | What it does not                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Loaded**            | the listing converts and its bundle imports                                                         | that anything it does is right                                      |
| **All three stages**  | execution reached a network request at browse, list and read, under a probe answering an empty page | that a real page parses, that media plays, or that the site is live |
| **Chain replay**      | a list call's output, handed to the next call, works against a scripted page                        | that the live site still serves that page                           |
| **Verified playable** | a returned stream URL answered with media, checked in the same call                                 | that the media is what a viewer wanted (relevance)                  |

Loaded and three-stage counts are the broad, cheap measurements: they cover a
whole catalogue in minutes, and they move when this software improves. Chain
replay and verified playback are the strong ones, and they cover a subset.

## Current — v0.5.0 (2026-09-22)

Measured over two whole published indexes of the Kotlin extension family,
translated from source: a Mihon-family manga repository and an Aniyomi-family
anime repository.

|                          | before v0.5.0 | **v0.5.0**      | change   |
| ------------------------ | ------------- | --------------- | -------- |
| manga, loaded (of 1,396) | 828           | **949 (68%)**   | **+121** |
| manga, all three stages  | 412           | **609 (44%)**   | **+197** |
| anime, loaded (of 256)   | 74            | **101 (39%)**   | **+27**  |
| anime, all three stages  | 62            | **82 (32%)**    | **+20**  |
| **combined, loaded**     | 902 of 1,652  | **1,050 (64%)** | **+148** |
| **combined, all three**  | 474           | **691 (42%)**   | **+217** |

Re-measured on the released commit: identical, nothing lost, and all counts are
of distinct listings.

"Before" is engine `9048d76` for the loaded counts. The stage counts were first
taken a few commits later, when loading stood at 829 and 74.

**Every one of those gains came from a class-level fix, not a per-source one** —
decoding by type, Map semantics, awaiting what blocks, a shared regex class,
state carried from one call to the next. That is the result that matters more
than any single percentage: a semantic fixed once fanned out across hundreds of
listings in two ecosystems, and the rule that refusals are named rather than
approximated held throughout — a fix that would have needed guessing was left
refused.

### Opening a chapter, measured as a chain

The three-stage probe opens a chapter id it invents, so it cannot see a
capability that depends on what listing returned. The most widely shared site
template in the manga repository (Madara, a WordPress theme) was measured instead by listing its
chapters against a scripted page and opening the id that came back:

|                                                     | before | **v0.5.0** |
| --------------------------------------------------- | ------ | ---------- |
| loaded Madara listings that list and open a chapter | 0      | **164**    |
| of                                                  | 176    | 176        |

Two independent faults stopped every one of them: the template's date parser
used a regex class the runtime refused, and the chapter's `memo` — where it
keeps the title's path — was lost between listing and opening. The remaining
12 use their own page layouts, which the scripted page does not match.

### With deliberate boundaries set aside

115 manga and 114 anime listings are refused on a deliberate native boundary
(WebView, an embedded JavaScript engine, reading a cookie jar, arbitrary
interceptors, threads, a local server, `android.*` — decisions, not backlog).
Setting those aside, 949 of 1,281 (74%) and 101 of 142 (71%) load.

That is the **load rate among listings not behind a deliberate native
boundary**. It is not a compatibility rate: removing the boundaries changes the
population being measured.

## Verified playback

End-to-end playback is measured on smaller corpora, because each stream URL is
range-requested in the same call that resolved it — a signed URL checked later
measures how long its token lived.

| Corpus (2026-09-11)                      | converted and loaded | returned a stream URL | **verified playable** |
| ---------------------------------------- | -------------------- | --------------------- | --------------------- |
| Kotlin, one 254-listing anime repository | 69                   | 6                     | **3**                 |
| JavaScript (Sora), 69 modules            | 57 of 57 anime       | 39                    | **16–18**             |

The JavaScript figure was taken twice that day and recorded as 18 in the
release notes and 16 in [`compatibility-sora.md`](compatibility-sora.md); live
sites move between runs, so both are given. Classifying the Kotlin corpus's
failures by hand found none that was this software's: 26 were site drift, 20
anti-bot or IP-bound CDNs, 14 dead or without https, and 2 refused on purpose.

**Playback has not yet been measured over the v0.5.0 catalogues.** That is the
next number worth having, and until it exists the figures above say how much
of a catalogue this can run, not how much of it plays.

## History — how the numbers got here

Kept because the reasoning is still useful, and because one conclusion below
was overturned and the way it was overturned is the lesson.

| Date       | Measurement                                                | Result                                                                                        |
| ---------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 2026-09-10 | Phase 1 closed, on one 254-listing anime corpus            | 60 installable; "the translator work has reached diminishing returns" — **overturned, below** |
| 2026-09-10 | Phase 2: every native capability granted, then re-measured | offline conversion 65 → 79 at most; the three safe capabilities, once built, gave +4          |
| 2026-09-11 | the same corpus, v0.1.0                                    | 69 convert and load; 3 verified playable                                                      |
| 2026-09-11 | Sora, with core and host frozen                            | 57 of 57 anime modules load; 16–18 verified playable — a second ecosystem with no core change |
| 2026-09-19 | a second JavaScript ecosystem, measured as a no            | 16 of 101 verified playable, about 2 relevant — see [`compatibility.md`](compatibility.md)    |
| 2026-09-22 | v0.5.0: two whole Kotlin-family indexes                    | 1,050 of 1,652 load (+148), 691 reach all three stages (+217); Madara chapters 0 → 164 of 176 |

### Why "diminishing returns" was wrong

Phase 1 ended on one 254-listing corpus with the conclusion that translation
could not grow the count further: every convertible bundle loaded, and what
remained was native capabilities and dead sources. For that corpus, measured
that way, it was true.

It stopped being true when the measurement changed shape, in three ways:

- **Whole catalogues, not one corpus.** Over 1,652 listings, a gap that blocks
  two sources in a small corpus blocks dozens, and class-level fixes become
  visible.
- **Loaded is not working.** Many listings that counted as loaded were
  returning wrong answers silently — a decoded object with no methods, a
  Promise where a value was expected, a map iterated as keys. Driving each one
  to a request, then replaying real shapes, found bugs the load count could
  not.
- **Stateful chains.** A capability that passes state between calls is
  invisible to any per-call probe. The chapter chain above went from 0 to 164
  on a fault no earlier instrument could see.

The Phase 2 finding still stands: native capabilities are not where the
catalogue is lost. What changed is that "the translator is done" turned out to
mean "this instrument is done".
