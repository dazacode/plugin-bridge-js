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

## Since v0.5.1 — served playback (2026-09-24, unreleased)

The same two catalogues, the same harness and method as v0.5.1, measured on
the served-playback work ([ADR-0007](adr/0007-served-playback.md)) before any
version was cut.

|                         | v0.5.1 | **now**         | change |
| ----------------------- | ------ | --------------- | ------ |
| manga, loaded           | 993    | **994 (71%)**   | +1     |
| manga, all three stages | 657    | **657 (47%)**   | 0      |
| anime, loaded           | 130    | **137 (54%)**   | +7     |
| anime, all three stages | 115    | **122 (48%)**   | +7     |
| **combined, loaded**    | 1,123  | **1,131 (68%)** | +8     |
| **combined, all three** | 772    | **779 (47%)**   | +7     |

**Zero listings lost in either catalogue, and no probe stage changed** on any
listing that loaded before. Of the seven anime gains, six are members of the
local-server family (one of which loads without taking its server path). The
seventh is outside the family, unblocked by the exact byte path alone. The
manga gain is one listing unblocked by the rule for trailing lambdas passed to
constructors.

**Verified playable in the reference web client, served:** three listings end
to end (resolve, served manifest, media decoded, playback advancing, seek,
teardown releasing the plugin instance), plus one more that plays until the
player's own transmuxer rejects a segment. ADR-0007 §8 has the family funnel.

## Current — v0.5.1 (2026-09-23)

Measured over two whole published indexes of the Kotlin extension family,
translated from source: a Mihon-family manga repository and an Aniyomi-family
anime repository. Counts are of distinct listings, on the merged commit.

|                          | v0.1.0   | **v0.5.1**      | change since v0.1.0 |
| ------------------------ | -------- | --------------- | ------------------- |
| manga, loaded (of 1,396) | — ¹      | **993 (71%)**   | **+993**            |
| manga, all three stages  | — ¹      | **657 (47%)**   | **+657**            |
| anime, loaded (of 256)   | 62 (24%) | **130 (51%)**   | **+68**             |
| anime, all three stages  | 56 (22%) | **115 (45%)**   | **+59**             |
| **combined, loaded**     | 62 (4%)  | **1,123 (68%)** | **+1,061**          |
| **combined, all three**  | 56 (3%)  | **772 (47%)**   | **+716**            |

¹ v0.1.0 (2026-09-11) could not run a manga source at all; chapters and pages
arrived with API level 2. Its anime figures were measured on 2026-09-23 over
the same index, with the same harness, as the v0.5.1 column. v0.1.0
shipped the day after Phase 1 concluded that translation had
[reached diminishing returns](#why-diminishing-returns-was-wrong).
The v0.5.1 column is what happened once the measurement changed shape.

v0.5.1 continues the v0.5.0 pass over the same two catalogues, with the same
method; the v0.5.0 section below is kept as it was measured.

Where it came from, each measured on its own against what was merged before it:

| Change                                                                   | anime loaded / all three | manga loaded / all three |
| ------------------------------------------------------------------------ | ------------------------ | ------------------------ |
| Kotlin widening (Iterable delegation, BigDecimal, prefix increment, …)   | 101 → 111 / 82 → 99      | 949 → 951 / 609 → 611    |
| Manga widening, and a template's properties reached with its extension   | 111 / 99 → 97 ¹          | 951 → 959 / 611 → 626 ²  |
| `lib/synchrony`'s deobfuscator, run from the script its repository ships | 111 → 130 / 97 → 115     | 959 → 961 / 626 → 628    |
| Network interceptors, and interceptors on an implicit builder            | 130 / 115                | 961 → 992 / 628 → 656    |
| Older work-in-progress branches, ported (`java.net.URL` and four more)   | 130 / 115                | 992 → 993 / 656 → 657    |

¹ Two anime listings now make a request a lazy value needs before they list,
and the probe answers that request with an empty HTML page, so they stop on
"expected JSON" one step earlier. Before, the lazy value was a Promise nobody
awaited and execution ran on past it. The probe cannot tell the difference;
the code is more correct.

² **Net of seven listings refused on purpose.** Each loaded in v0.5.0 and
could not work: four read a template's `apiUrl`, which needs the public-suffix
list and had been pruned, so every request went to `undefined/search`; two sent
an undefined User-Agent read from an Android API; one sent a header whose value
was an unawaited Promise. Each is now refused by name. Refusing a bundle that
was loaded but broken lowers the number and is the right result, because a
loaded bundle that cannot work is the outcome this project exists to avoid.

**Two caveats on the interceptor row.** An interceptor runs on every request
the plugin makes. Page images and stream segments are fetched by the host, so
an interceptor written for _those_ installs and is never called. Of the 33
listings that interceptors unblocked, a census of their interceptor bodies tags
4 as rewriting image requests: those load, and may still fail to show a page.
24 rewrite the request the plugin itself makes (a header, a token, a retry),
which is the case that runs exactly. The second caveat: a network interceptor
runs once around the exchange rather than once per redirect hop.

The JavaScript ecosystems' shims (Sora, Mangayomi, Stremio, Nuvio) had
correctness fixes in this release, so a stream's container and a torrent's
hash are now read one way, and a rotated string array no longer decodes
shifted. Those are proved by specs against upstream's own output. They are not
catalogue counts, so they appear in the changelog rather than here.

### With deliberate boundaries set aside (v0.5.1)

112 manga and 87 anime listings are refused on a deliberate native boundary
(WebView, an embedded JavaScript engine asked to run a site's code, reading a
cookie jar, threads, a local server, `android.*`, page images, which only the
host fetches — decisions, not backlog). Setting those aside, 993 of 1,284
(77%) and 130 of 169 (77%) load. Interceptors and `lib/synchrony` came off
this list in v0.5.1: both now run for real.

What each boundary still costs can be re-measured at any time with
`bridge catalogue <index> --grant webview,js-engine,cookie-store,image`
(`packages/core/src/kotlin/grants.ts`). A grant sets the refusals that name its
boundary aside, so the rest of the extension is counted. The bundles it builds
throw where the boundary was, and no host will open them. A grant only adds
listings. That property had to be fixed before the instrument could be
trusted: an anti-bot recovery path once lost 25 listings under a grant.

That is the **load rate among listings not behind a deliberate native
boundary**. It is not a compatibility rate: removing the boundaries changes the
population being measured.

## v0.5.0 (2026-09-22)

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

### With deliberate boundaries set aside (v0.5.0)

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

**Playback has not yet been measured over the v0.5.1 catalogues.** That is the
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
| 2026-09-23 | v0.5.1: the same two indexes                               | 1,123 load (+73, net of 7 refused on purpose), 772 reach all three stages (+81)               |
| 2026-09-23 | v0.1.0 re-measured over the v0.5.1 anime index             | 62 of 256 load, 56 reach all three stages; no manga support, so 0 of 1,396                    |

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
