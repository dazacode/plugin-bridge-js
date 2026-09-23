# ADR 0004 — The compatibility layer is the product: one runtime, many shells, and a second front-end for Kotlin

Status: **proposed** · 2026-09-10 · extends ADR-0002 · depends on ADR-0003 ·
revises `contract/FOREIGN.md` §4.1 and §4.1.2

Research answer to: "the plugin runtime is portable because it is JavaScript, so
port it once and wrap it per platform — and the reusable part is not the app, it
is the machinery that turns somebody else's extension into ours. Is that true,
is it new, and what is the order of work?"

Short version: the first half is true and is one commit away from being
structurally true rather than accidentally true. The second half is **half new**,
and the half that is not new is the more useful finding, because a project
shipping today has already proved the harder direction works — from **bytecode**,
which this repository had written off. The order of work follows from that.

Rule 9 applies to this document. No content source is named anywhere in it.
Client applications, libraries and file formats are named, per `FOREIGN.md` §0.

---

## 1. Decision

| Concern                        | Decision                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| What the product is            | The compatibility layer. The client is its first consumer, not its purpose.             |
| Where the runtime lives        | Behind a declared **host port**, enforced by a boundary check — not welded to SvelteKit |
| Second host, and when          | A headless one, **next**, because it is also the conversion laboratory                  |
| The measure of the work        | **Converted listings passing `FOREIGN.md` §6**, per format, tracked per commit          |
| Kotlin front-ends              | **Two.** Source stays; a bytecode front-end is specified and costed here                |
| Where behaviour is copied from | Apache-2.0 sources only, with a `NOTICE`. Never MPL-2.0 or AGPL-3.0 code                |
| The claim we make in public    | "Web-first, multi-ecosystem, no Android or JVM at runtime" — never "the only one"       |

---

## 2. What the research actually found

### 2.1 The compatibility layer is already 91% of the runtime, by line count

Measured on this branch, non-spec TypeScript under `client-web/src/lib/plugins/`:

|                                                                                                      | Lines              |
| ---------------------------------------------------------------------------------------------------- | ------------------ |
| Everything                                                                                           | 29,783             |
| `foreign/` — adapters, translator, shims, themes                                                     | **27,233 (91.4%)** |
| The plugin runtime proper — sandbox, archive, zip, integrity, host matching, HLS rewriting, pipeline | 2,550              |
| of `foreign/`: the Kotlin translator                                                                 | 9,021              |
| of `foreign/`: the runtime shims a converted bundle carries                                          | 8,522              |

The ABI this project defined is small and mostly done. The machinery for running
_other people's_ extensions is an order of magnitude larger and is where every
remaining question lives. That is not a criticism of the split; it is the
strongest available evidence for which half is the product, and it should be
reflected in how the work is sequenced and how the project is described.

### 2.2 The runtime is already portable, and is not shipped that way

The claim "it is JavaScript, so it runs anywhere" is worth checking rather than
asserting. Checked:

- **Zero** imports of `svelte`, `$app` or `$env` anywhere under `plugins/`.
- **Nine** import lines, in six files, reach outside the directory at all, and
  they name exactly two modules: `$lib/domain` (types, plus three failure
  classes) and `$lib/core/media/playback-log` (one `trace` function).
- **Five** ambient capabilities are taken directly rather than injected: OPFS in
  `bundle-store.ts`, `localStorage` in `foreign/check.ts`,
  `new Worker(new URL(…, import.meta.url))` in `sandbox-host.ts` and
  `kotlin/translate-host.ts`, a bare `fetch` fallback in `sandbox-host.ts`, and
  the vendored tree-sitter wasm load in `kotlin/grammar.ts`, which takes both a
  `new URL` and a `fetch`.

  **This bullet said "three" when it was written, and both omissions were found
  by building the port rather than by reading the code.** The count came from
  grepping for `globalThis.fetch`, which a bare `fetch` does not match — so the
  sentence that followed it here, _"network is already injected everywhere as a
  `Fetcher`; there is no ambient `fetch` in the runtime"_, was wrong twice over.
  It is corrected rather than deleted because it is the argument for §6 item 1
  in miniature: a boundary nothing enforces is a boundary nobody can state
  accurately, including the person writing the document that proposes it.

So the distance between "runs in our web client" and "runs in any JavaScript
host" is four small edits and one interface. That is a fact worth converting into
a rule before it stops being true, because nothing today prevents the tenth
import.

### 2.3 Foreign-extension reuse is not new, and every established implementation keeps the foreign runtime

This was searched specifically, because the interesting claim is a negative one
and negatives are the ones that embarrass you later.

| Project                  | How a foreign extension runs                                                      | Runtime required        | Reaches                          |
| ------------------------ | --------------------------------------------------------------------------------- | ----------------------- | -------------------------------- |
| Suwayomi-Server          | APK → JAR, bytecode patching, an `AndroidCompat` layer                            | A JVM                   | desktop/server, browser via REST |
| miwayomi                 | the same, aimed at anime; `source-api` + `android-compat`                         | JDK 21                  | desktop/server, browser via REST |
| AniyomiCompat            | an Aniyomi runtime embedded in another Android client                             | Android                 | Android                          |
| Mangayomi's APK bridge   | an Android bridge beside its own JS and Dart engines                              | Android                 | Android                          |
| AnymeX's extension index | six formats discovered and installed in one place; each still runs in its own app | the original per format | per format                       |
| Kotatsu's parsers        | not reuse at all — reimplemented by hand as a JVM library                         | a JVM                   | JVM                              |

Two things follow. **"Aniyomi extensions outside Android" is solved**, several
times over, and a plan that treats it as unexplored is wrong. And every one of
those solutions moves the _app_ to where the extension already runs — a JVM, or
Android — which is why none of them reaches a browser, an iPhone, or anything
without a JVM. The compatibility layer is real but it is not portable, because
what it is compatible _with_ is a platform rather than a language.

Alongside them sit portable runtimes that are not compatibility layers at all —
Nuvio's JavaScript providers on Hermes, Mangayomi's own QuickJS sources, the Sora
module format, Stremio's addon protocol (out-of-process, over HTTP), the
`@p-stream/providers` TypeScript package. Each runs everywhere and each runs only
its own format. Both halves of the problem have been solved; not together.

### 2.4 One project already translates to JavaScript — from bytecode, and it ships

The exception, found by searching for it deliberately: **Hoshi**, a SvelteKit +
Tauri + Rust client — very nearly this repository's stack — installs an Aniyomi
or Tachiyomi extension by downloading the **APK** and calling
`apktojs::apk_to_js(&bytes)`, on the viewer's device, under a twenty-second
timeout. It writes the resulting `index.js` and runs it in QuickJS through
`rquickjs`, against compatibility layers named `tachiyomi.js`, `sora.js` and
`lnreader.js` over a common `Base.js`/`Anime.js`/`Manga.js`/`Novel.js` ABI.

`apktojs` is a real Dalvik decompiler: an APK inspector, a DEX extractor and
walker, a lifter to IR, an SSA pass, a CFG and a relooper, a constant-pool and
type resolver, and a renderer — roughly 266 KB of Rust — plus about 122 KB of
JavaScript shims, split as prototypes, std, std classes, locale and date, JSON,
android, jsoup and network. Its dependencies are `dex`, `axmldecoder`, `zip` and
`regex`: all pure Rust, no JVM anywhere.

Three consequences, in increasing order of importance:

1. **The public claim has to change.** "Nobody translates these extensions into
   JavaScript" is false. What remains true, and was still true after looking for
   counter-examples, is stated in §2.8.
2. **A Dalvik front-end can run in a browser.** Those four crates compile to
   WebAssembly, and this client already ships a WASM parser for the source path.
   The architecture that makes Hoshi's approach native-only is its _sandbox_, not
   its translator.
3. **Its shim decomposition and ours are the same list.** Independently arrived
   at: they emit prototypes/std/std-classes/locale-date/json/android/jsoup/network;
   `kotlin-runtime.ts` emits stdlib/http/jsoup/serialization/prefs/models. Two
   projects that have never met agreeing on the seam is the best evidence
   available that the seam is real.

`apktojs` is **AGPL-3.0**. It cannot be vendored, linked, or copied into this
product. It can be read, and what it proves can be acted on.

### 2.5 The classpath is paid once, and this repository has already paid it

`FOREIGN.md` §4.1 rejected the binary path in one sentence — _"neither gets you
the classpath, and the classpath is the work"_ — and then §4.1.1 chose to read
the public Kotlin source instead. The reasoning was sound and the conclusion is
now out of date, because of something that happened afterwards **in this
repository**: the classpath got built. `kotlin-runtime.ts` (5,313 lines),
`dom.ts` (1,542), `aniyomi-entry.ts` (500) and the generated parser twin _are_
the classpath, and they were needed for the source path regardless.

That inverts the comparison. Against a paid classpath the two front-ends differ
in what they must _resolve_, and the measurements already in `FOREIGN.md` §4.1.6
say which is harder:

|                                         | Source front-end                                                                                                            | Bytecode front-end                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Artifact completeness                   | partial — a file, whose helpers live in other files in another repository                                                   | complete — every method the extension ships                            |
| Symbol resolution                       | **the wall.** 250 of 254 refusals are unresolved symbols, not unsupported syntax                                            | done by the format: every call site carries owner, name and descriptor |
| `super.` calls (100 extensions)         | must be resolved to a base class we supply                                                                                  | an explicit `invoke-super` instruction                                 |
| A class declared inside a function (63) | a translator feature                                                                                                        | already a separate class in the DEX                                    |
| Extractor modules (66 / 42 / 38)        | a reachability problem across repositories, and the one negative result already recorded — feeding them in moved 4 to **0** | in the APK, or not, and either way it is a fact rather than a fetch    |
| Fetching                                | a forge API, one tree per repository, 60 unauthenticated requests an hour                                                   | one file, at a URL `origin.artifactUrl` **already carries**            |
| Fidelity to what users run              | the source at `HEAD`, which is not what shipped                                                                             | exactly what shipped                                                   |
| Cost to build                           | built; 9,021 lines                                                                                                          | a Dalvik lifter, SSA, a relooper. Weeks, not days                      |
| Output reviewability                    | JavaScript that reads like the Kotlin — auditable in a diff                                                                 | decompiler output, explicitly not meant to be read                     |

The last row is a genuine loss and it matters to this project specifically:
`FOREIGN.md` §5.1 and the consent screen rest on a conversion being inspectable.
The last-but-one row is the honest cost. Nothing here says abandon the source
path — it produces better output, it already works for four extensions, and it is
the only path for the ecosystems that publish no binary. It says the binary path
is a **second front-end into the same runtime**, not a competing project, and
that `FOREIGN.md` §4.1.2's "a real fallback rather than a historical note" is an
understatement that should be corrected.

### 2.6 The base class we implement is a published program, and it has moved without us

`aniyomi-entry.ts` reimplements the driver half of a base class, and its own
header explains why it is not translated. Correct — but it was written from
inference, and the class is published: miwayomi's `source-api` carries
`AnimeHttpSource.kt` (403 lines, 54 members) and `ParsedAnimeHttpSource.kt`
(154 lines) as ordinary readable Kotlin, Apache-2.0.

Read against our driver, the diff is not subtle. We implement the eight classic
families — `popularAnime*`, `searchAnime*`, `latestUpdates*`, `animeDetails*`,
`episodeList*`, `videoList*` and `setUrlWithoutDomain`. The base class also
declares, and we name none of them:

`hosterListRequest` / `hosterListParse` / `Hoster` · `seasonListRequest` /
`seasonListParse` · `resolveVideo` · `videoUrlRequest` / `videoUrlParse` ·
`episodeVideoParse` · `sortHosters` / `sortVideos` / `sort` · `getVideoUrl` ·
`prepareNewEpisode` · `getAnimeUrl` / `getEpisodeUrl` · `getHomeUrl` ·
`versionId` · `generateId` · `getVideoThumbnails` · `getImageTile` ·
`createHttpServer`.

Three of those are load-bearing:

- **`Hoster` is the direction upstream moved.** Episode → hosters → videos is now
  the primary path; `videoListParse(response)` is the legacy one. An extension
  written against the current API cannot convert at all today, and _no measurement
  in `FOREIGN.md` distinguishes "refused because of a symbol" from "refused
  because it targets an API we do not implement."_ That measurement is cheap —
  `tool/kotlin-survey.ts` already walks a catalogue — and it should be run before
  any more translator work is ranked.
- **`sortVideos()` is where quality preference is applied**, and extensions
  override it constantly. A driver without it returns streams in source order.
- **`createHttpServer()` is `ADR-0002` §2.1 promoted into the upstream API.** The
  observation that a resolve contract ending at a string produces a web server in
  every implementation is now _a member of the base class_, with an `HttpServer`
  model beside it. This build cannot supply it and should not try: `StreamPipeline`
  is the answer, and an extension that overrides it must refuse by name.

### 2.7 Two behaviours worth taking, and the licences that decide where from

Reading the compat layers turned up implementations that answer gaps already
recorded here, rather than merely being interesting:

- **Episode numbering.** `KNOWN_GAPS.md` records that converted episodes are
  numbered positionally and that this _"is a guess about ordering"_ which reverses
  a season listed oldest-first. Aniyomi publishes `EpisodeRecognition`: 138 lines,
  pure regex, no dependencies — strip bracket tags, drop `v2`/`1080p`/season
  markers, then read a number, with `.a → .1`, `extra → .99`, `omake → .98`,
  `special → .97`. It is the algorithm the whole ecosystem's numbering agrees
  with, which is the property that matters when a viewer compares two clients.
  Note what makes it usable _now_: it needs a regex lookbehind, which `ABI.md` §6
  forbids and ADR-0003 §2.2 repealed. This is the first concrete thing the engine
  collapse bought.
- **The preference framework.** 31 extensions block on it, and `KNOWN_GAPS.md`
  separately records 67 preference reads across 24 sources in another ecosystem's
  catalogue, where a preference chooses a base URL or a server. miwayomi answers
  it in three small files — `androidx/preference/Preference.kt` (5.1 KB),
  `CompatSharedPreferences.kt` (4.4 KB), `SharedPreferences.kt` (1.3 KB). Our
  `prefs` runtime section exists; what is missing is `PreferenceScreen` and the
  four preference types, plus a manifest `settings` block derived from the
  source's own `getSourcePreferences()` and rendered by the host, which
  `ABI.md` §1 already provides for. One feature closes both gaps and unblocks a
  blocker.
- **The request helpers.** Suwayomi's `OkHttpExtensions` names what extensions
  actually call — `await`, `awaitSuccess`, `parseAs`, `asObservableSuccess` — and
  its `interceptor/` directory names what they wrap themselves in:
  `RateLimitInterceptor`, `SpecificHostRateLimitInterceptor`, `UserAgentInterceptor`.
  A shim that throws on `.rateLimit()` refuses an extension for being polite.
- **Anti-bot.** Suwayomi ships a `CloudflareInterceptor` and Hoshi resolves the
  same wall with a headless browser fetch. Both answers need a real browser
  engine the host controls. ADR-0002 §7 declared this out of scope; it stays out
  of scope, and it is worth recording that both neighbours needed it.

**Where behaviour may be copied from, and where not.** This is a licence
question with a clean answer, and it must be settled before anyone opens an
editor next to a reference implementation:

| Source                                             | Licence    | What we may do                                                                                              |
| -------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------- |
| Aniyomi, miwayomi (`source-api`, `android-compat`) | Apache-2.0 | Port behaviour, with attribution and a `NOTICE`, as `FOREIGN.md` §5.1 already requires of converted bundles |
| Suwayomi-Server                                    | MPL-2.0    | **Read for its inventory of what extensions call. Do not copy a file.** MPL is file-level copyleft          |
| `apktojs`                                          | AGPL-3.0   | **Read. Vendor nothing.**                                                                                   |

The existing rule that converted bundles carry upstream attribution points
outward; this is the same rule pointing inward, and it is the one that gets
forgotten.

### 2.8 What is genuinely unoccupied, stated narrowly enough to survive

After looking for counter-examples rather than for confirmation:

> Yorozo runs extensions from several unrelated ecosystems through one declared
> plugin ABI, in a **capability-sandboxed JavaScript host with no Android, no
> JVM and no embedded engine of its own** — the browser it is already running in —
> and it ends `resolve()` at a **declarative byte pipeline** rather than at a URL.

Each clause is doing work, and each is what a neighbour lacks: Suwayomi and
miwayomi need a JVM; AniyomiCompat and the APK bridges need Android; Hoshi needs
an engine it embeds and a Rust sandbox, and covers three formats to our six;
Nuvio, Stremio and the provider libraries run only their own format; and every
one of them ends at a URL, which is why the ecosystem keeps re-deriving a local
web server.

What must _not_ be claimed: that translating these extensions to JavaScript is
new, that nobody unifies several ecosystems, or that this is the only project
turning existing code into something reusable. The first is false, the second is
arguable, and the third is unprovable — and the accurate sentence is stronger
than all three because it survives someone checking.

---

## 3. The shape

```
   six foreign formats                   one ABI                 many hosts
 ┌────────────────────┐        ┌──────────────────────┐   ┌────────────────────┐
 │ sora      (JS)     │        │                      │   │ browser  Worker    │
 │ mangayomi (JS)     │─ adapt ▶                      │   │ Tauri    Worker    │
 │ lnreader  (JS)     │        │   ABI.md level 1     │◀──│ Capacitor Worker   │
 │ hayase    (JS)     │        │   + StreamPipeline   │   │ headless  isolate  │
 │ aniyomi   (Kotlin) │─ src ──▶                      │   └────────────────────┘
 │ cloudstream(Kotlin)│─ src ──▶       ▲                            │
 │ aniyomi   (DEX)    │─ bin ──▶       │                     the HOST PORT
 └────────────────────┘        └───────┼──────────────┘   http · sandbox · blobs
                                       │                   kv · workers · clock
                              runtime shims (shared)
                    stdlib · http · jsoup · serialization
                          · prefs · models · driver
```

Two front-ends, one runtime, one ABI, four hosts. The three columns are
independent: a new format is an adapter, a new host is a port implementation, and
neither touches the middle. That independence is the whole architectural claim,
and §6 is ordered to make it structurally true rather than presently true.

---

## 4. The host port

What a shell must supply, derived from what the runtime uses today rather than
from what one might imagine it needs.

| Port                                              | Used by                               | Browser today                | Native (ADR-0003) | Headless                                   |
| ------------------------------------------------- | ------------------------------------- | ---------------------------- | ----------------- | ------------------------------------------ |
| `fetch` — arbitrary headers, no CORS              | every adapter, the sandbox, the probe | `/api/plugin-fetch`          | `kuro-core` proxy | direct                                     |
| `sandbox` — an isolate with no ambient capability | `sandbox-host.ts`                     | `Worker` + `import.meta.url` | the same          | `worker_threads`, **with a stated caveat** |
| `blobs` — a directory per plugin                  | `bundle-store.ts`                     | OPFS                         | OPFS              | the filesystem                             |
| `kv` — small, synchronous                         | `foreign/check.ts`                    | `localStorage`               | `localStorage`    | a JSON file                                |
| `worker` — a second isolate for translation       | `kotlin/translate-host.ts`            | `Worker`                     | the same          | inline is acceptable                       |
| `log`                                             | `sandbox-host.ts`                     | `trace`                      | `trace`           | stderr                                     |
| `stream` — executes `StreamPipeline`              | playback                              | `/api/stream`                | `kuro-core`       | not needed                                 |

The caveat is worth writing down rather than discovering: **a Node worker is not
a sandbox.** It has ambient `fetch`, `process` and the filesystem. The headless
host must delete those globals exactly as `sandbox.worker.ts` already does for
the browser, and a check that ran in a _more_ capable environment than the client
would report green on a plugin the client refuses. The port's contract is the
capability set, not the isolate.

---

## 5. The scoreboard

`tool/kotlin-convert-report.ts` produced the numbers `FOREIGN.md` §4.1.6 rests
on — 250 refused, 4 translated, 4 answering `searchCatalog`, 0 downstream
failures — and it produced them once, by hand, for one format.

**That report becomes the project's primary instrument.** Generalised across all
six adapters and run against a catalogue clone held outside this repository, it
answers one question per format: _how many listings pass all five steps of
`FOREIGN.md` §6_. Not how many parse, not how many emit — how many **work**.
`FOREIGN.md` §4.1.5 already says it: _"emit rate is not works rate."_

Three properties make it worth the effort:

- **Refusals are ranked by extensions unblocked**, not by frequency, so the next
  piece of work is chosen by the measurement rather than by taste. That
  discipline already exists and already paid — it is what produced the negative
  result about extractor modules, and what stopped 403 recovered constants from
  being mistaken for progress.
- **It is a regression test.** A translator change that converts three more and
  breaks two is currently invisible. `FOREIGN.md`'s remembered-per-version check
  results and ADR-0002 §5.4's cassettes are the same idea reaching for the same
  thing; this is where they meet.
- **It is how this document gets falsified.** §8.

The number to beat is **4 of 254**. Every phase below states what it should move.

---

## 6. Order of work

Each phase has a kill switch, and none of them blocks ADR-0003's phases 3–5 —
where they interleave, that is said.

1. **The port, named and enforced.** Write `contract/HOST.md` from §4.
   Replace the nine outward imports with a local `errors.ts` and an injected
   logger; take `sandbox`, `blobs`, `kv` and `worker` as constructor arguments.
   Add `tool/check-runtime-boundary.ts` to the web `check` script, failing on any
   import out of `plugins/` and any ambient global outside a port.
   _Kill switch:_ the web build, the 1,392 tests and `check:generated` stay green.
   _Moves the number:_ not at all. It makes every later phase possible.

2. **The headless host, which is the laboratory.** A second port implementation
   over the filesystem and direct `fetch`, plus a `yorozo check <index-url>`
   command that runs `FOREIGN.md` §6 across a whole catalogue and emits the §5
   scoreboard. This replaces a harness that has already been hand-written more
   than once, badly, under time pressure — the traps are recorded in this
   project's own notes.
   _Kill switch:_ it reproduces the web client's verdicts, row for row, on a
   catalogue both have seen. A disagreement is a port bug and is the point.
   _Moves the number:_ not directly. It is what makes the number exist.

3. **Two measurements, before any more translator work.** With the harness:
   (a) how many refusals are the `Hoster`-era API rather than a missing symbol
   (§2.6); (b) the same conversion report for **cloudstream**, whose extensions
   are also public Kotlin subclassing a published base class, and which is
   `browse-only` today for a reason §2.5 revises. Cloudstream is the cheap test
   of the entire thesis: if one translator plus one new driver yields a second
   ecosystem, the compatibility layer is reusable machinery. If it does not, it
   is one bespoke Aniyomi converter wearing a general name, and this document was
   wrong about what is being built.

4. **The driver, completed from the published base class** (§2.6), and
   `EpisodeRecognition` ported (§2.7) — both from Apache-2.0 sources, with a
   `NOTICE`, and both pinned by tests written against the upstream behaviour
   rather than against ours. Then the preference feature: derive manifest
   `settings` from the source's own declaration, render them host-side, close
   both recorded gaps at once.
   _Moves the number:_ this is the first phase that should, and by how much is a
   prediction the scoreboard will judge. State it before running it.

5. **The Dalvik front-end, specified and costed, decided on evidence.** Not
   started before phases 2 and 3 report, because their numbers decide whether it
   is necessary. If it goes ahead: our own Rust, compiled to WASM for the browser
   and linked into `kuro-core` for the shells, emitting into the _same_ shims —
   which is the only reason the cost is bearable. `origin.artifactUrl` already
   points at the artifact, so nothing new is needed to find it.
   _Kill switch, stated in advance:_ one extension, converted from its APK,
   passing all five steps in the browser. If that takes more than a month, the
   source path is the answer and this is closed with the result written down.
   _Constraint:_ AGPL-3.0 code is read, never copied (§2.7).

6. **The shells.** ADR-0003 phases 4 and 5 consume the port rather than the
   directory. If phase 1 is done, this is a `package.json` line and an
   implementation of §4's table; if it is not, it is a fork.

7. **The package, and the rename.** Extract to a workspace package when
   `client-web/` becomes `web/` in ADR-0003 phase 6 — not before. The boundary is
   the valuable part and phase 1 already has it; moving files earlier collides
   with a rename that is already scheduled, and buys nothing the check does not.

---

## 7. What this costs, and what it does not solve

- **Phase 1 is pure overhead if the shells never ship.** It is small — nine
  imports and four constructor arguments — and it is the cheapest it will ever
  be. That is the argument, and it is an honest one rather than a strong one.
- **The headless host is a second place for a check to be wrong.** Its whole
  value is that the two agree; the moment it is allowed to diverge "because it is
  only a tool", it is worse than nothing. Hence the kill switch.
- **A Dalvik front-end loses reviewability** (§2.5) and that conflicts with a
  property this project has treated as load-bearing. If it ships, the consent
  screen must say which front-end produced the bundle, and `signature.json`'s
  conversion record must carry it.
- **Anti-bot walls stay unsolved**, and both neighbours needed a real browser to
  solve them (§2.7). Unchanged from ADR-0002 §7.
- **Nothing here helps the ecosystems that need an interpreter** — Dart, Lua, or
  a rule format with embedded JavaScript. `FOREIGN.md` §8 still lists them, still
  correctly.
- **"Deploy anywhere" remains a claim about the runtime, not the product.** A
  shell still owes the viewer a player, storage, downloads, notifications and a
  back gesture. ADR-0003 already decided every shell is a webview, which makes
  that list shorter than it looks, but it is not empty and this document does not
  shorten it further.

---

## 8. What would falsify this

Stated now, so it is not negotiated later:

- **Cloudstream does not convert** with the existing translator plus a driver
  (phase 3b). Then the compatibility layer is not reusable machinery, and the
  honest description of this project is "an Aniyomi and Sora converter", which is
  still worth building and is a different thing to say about it.
- **The scoreboard does not move** across phases 4 and 5. Then the losses are not
  where the measurements said, and the measurements need rebuilding before more
  code is written.
- **The port cannot be implemented headlessly without weakening the sandbox**
  (§4). Then "one runtime, many hosts" has a floor at "browser-like hosts", which
  is still four surfaces and is a smaller claim than this document makes.
- **A neighbour ships a browser-native multi-format runtime.** Then §2.8's
  sentence is spent, and the answer is to say so and compete on the parts that
  are ours — the capability sandbox, the declarative byte pipeline, and the
  refusal to ship a single source.
