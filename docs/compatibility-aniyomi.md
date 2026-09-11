# The Aniyomi compatibility map

An architectural review of `miwayomi` as an **answer key** for expected Aniyomi
behaviour, and a per-system map from what it solves to what Yorozo should do
about it.

This is not a porting plan. `miwayomi` runs the real bytecode on a JVM;
`ADR-0004` runs a translation in a JavaScript sandbox, and `ADR-0003` puts that
sandbox on six surfaces. Those are different machines and the same _contract_,
and it is the contract this document is about: **what an extension believes is
true about the world it runs in.** miwayomi had to answer that question
concretely for every Android API an extension touches, which makes it the best
available statement of the question — including in the places where its own
answer is a stub, because a stub is miwayomi telling us that behaviour was not
worth having.

Read `contract/plugin-api/FOREIGN.md` §4.1 first; it is normative and this is
not. Where the two disagree, FOREIGN.md is right and this file is stale.

Three rows below — the cookie jar, `WebView`, and the Cloudflare interstitial —
stopped being compatibility questions once they were measured against a real
catalogue. **`ADR-0005` decides them**, with the counts each is worth: read that
before proposing work on any of the three.

A fourth, found later by reading the shared libraries rather than the
per-listing refusals: **at least 14 listings run their own HTTP server on
localhost** so that per-request headers survive to every HLS segment.
**`docs/adr/0006-local-http-server.md` decides it** — refused permanently,
because `StreamPipeline` already supplies the same behaviour declaratively.

## 0. This is a continuation, not a new direction

`NOTICE` already records two pieces of this repository as reimplementations
read from miwayomi's published source: the Aniyomi base-class driver
(`shims/aniyomi-entry.ts`, from `source-api/`) and the preference framework
(`KOTLIN_PREFS` in `shims/kotlin-runtime.ts`, from `android-compat/`). Both are
Apache-2.0, both were reimplemented rather than copied, and both are attributed.

So the question this review answers is not _whether_ to use miwayomi as a
reference. That was settled, documented and done twice. The question is **which
of the systems it covers are still unanswered here**, and which of those are
worth answering.

## 1. The two architectures, stated once

    Aniyomi APK ─► dex2jar ─► child-first ClassLoader ─► android-compat shims
                ─► JVM source-api ─► Ktor server ─► HTTP API ─► Web UI

    Aniyomi source ─► tree-sitter ─► emit ─► JS bundle ─► sealed sandbox
                   ─► shims/aniyomi-entry.ts ─► Yorozo plugin ABI ─► any surface

miwayomi's shape buys **fidelity**: the extension's own bytecode runs, so
anything the JVM can do, the extension can do. It costs a JVM, a server
process, and a localhost proxy for every byte of video, which is precisely what
`ADR-0003` and `ABI.md` §4.4 exist to avoid. Nothing below proposes changing
that trade.

What the shape means for reading miwayomi: **its compatibility layer is a
type-satisfaction layer.** A class exists so the ClassLoader resolves it. That
is a much weaker obligation than ours — we have no ClassLoader to satisfy, only
behaviour to reproduce — so a miwayomi class is evidence that _extensions
mention this API_, and only sometimes evidence about what it should do.

## 2. What is actually in the answer key

| Module            | What it holds                                                                                                                                                   | Our analogue                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `source-api/`     | `AnimeSource`, `AnimeHttpSource`, `ParsedAnimeHttpSource`, `AnimeSourceFactory`, the `SAnime`/`SEpisode`/`Video`/`Hoster` models, filters                       | `shims/aniyomi-entry.ts`, `KOTLIN_MODELS`                         |
| `android-compat/` | 39 Android/AndroidX classes: `SharedPreferences`, `Uri`, `Base64`, `Handler`/`Looper`, `Log`, `Html`, `WebView`+`CookieManager`, `Bitmap`, `QuickJs`, `Duktape` | `KOTLIN_PREFS`, parts of `kotlin-runtime.ts`                      |
| `core-common/`    | `NetworkHelper`, `JvmCookieJar`, seven okhttp interceptors, `FlareSolverr`, `CloudflareInterceptor`, `JavaScriptEngine`, `PreferenceStore`, torrent/bencode     | `/api/plugin-fetch`, `sandbox-host.ts`, `preferences.ts`          |
| `server/`         | `ExtensionManager`, `ChildFirstURLClassLoader`, `JarFixer`, `PackageTools`, `StreamProxy`, `ImageCache`, routes                                                 | `WebPluginRegistry`, `adapters/aniyomi.ts`, `segment-pipeline.ts` |

`server/` is almost entirely inapplicable — it is the JVM-loading half and the
HTTP-server half, and we have neither problem. `source-api/` we have already
read. **The unmined seam is `core-common/`'s network layer and the handful of
`android-compat` classes our translator currently refuses outright.**

## 3. The map

Status is against `plugin-system` as of this review. "Refused" means the
translator names it in `kotlin/subset.ts`'s `NAMED_OBSTACLES` and stops, which
is a deliberate conservative refusal, not an oversight.

| Aniyomi capability                                  | miwayomi solution                                                                              | Yorozo status                                                                            | Cleanest Yorozo implementation                                                                                                                                                                            | Layer                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Extension loading                                   | dex2jar + child-first ClassLoader + `JarFixer` bytecode repair                                 | **N/A by design**                                                                        | Source translation (`kotlin/pipeline.ts`)                                                                                                                                                                 | translator                   |
| `AnimeHttpSource` / `ParsedAnimeHttpSource`         | real `source-api` classes                                                                      | **Supported**                                                                            | `shims/aniyomi-entry.ts` (already derived from this)                                                                                                                                                      | shared runtime               |
| `SAnime`/`SEpisode`/`Video`/`Hoster` models         | `source-api/model/`                                                                            | **Supported**                                                                            | `KOTLIN_MODELS`                                                                                                                                                                                           | shared runtime               |
| `AnimeSourceFactory` (one extension, N sources)     | `SourceManagers` registers every produced source                                               | **Partial** — the factory class is recognised and skipped, one source is taken           | Emit each `createSources()` entry as a listing variant, or state the limitation on the row                                                                                                                | translator                   |
| Preferences / `SharedPreferences`                   | `android-compat` `CompatSharedPreferences` over a properties file                              | **Supported**, reads and writes — the write path was gated shut by the emitter until §5b | `KOTLIN_PREFS` + `preferences.ts` + manifest `settings`                                                                                                                                                   | shared runtime               |
| `PreferenceScreen` declaration reading              | runtime, via the real framework                                                                | **Supported**                                                                            | `aniyomiPreferences()` reads it statically                                                                                                                                                                | translator                   |
| HTML parsing (jsoup)                                | real jsoup                                                                                     | **Supported**                                                                            | `shims/dom.ts` (1,542 lines, jsoup-shaped)                                                                                                                                                                | shared runtime               |
| Kotlin/Java stdlib helpers                          | the real stdlib                                                                                | **Supported** — ~200 helpers                                                             | `kotlin-runtime.ts`                                                                                                                                                                                       | shared runtime               |
| `HttpUrl` / URL building                            | okhttp `HttpUrl`                                                                               | **Supported**                                                                            | `__k.httpUrl`                                                                                                                                                                                             | shared runtime               |
| `Uri.parse` / `android.net.Uri`                     | `android-compat/net/Uri.kt`                                                                    | **Supported**                                                                            | `kotlin-runtime.ts` has both `Uri` and `java.net.URI`, kept distinct from okhttp's `HttpUrl`                                                                                                              | shared runtime               |
| `android.util.Base64`                               | `android-compat/util/Base64.kt`                                                                | **Supported** — including the flag values                                                | `kotlin-runtime.ts` `Base64`                                                                                                                                                                              | shared runtime               |
| `android.text.Html.fromHtml`                        | `android-compat/text/Html.kt`                                                                  | **Missing** — refused as `an android.* API`                                              | Alias onto `shims/dom.ts`'s text extraction                                                                                                                                                               | shared runtime               |
| `android.util.Log` / `logcat`                       | real logging                                                                                   | **Missing** — refused                                                                    | No-op helper that feeds the plugin trace channel                                                                                                                                                          | shared runtime               |
| Default User-Agent                                  | `UserAgentInterceptor` + a preference                                                          | **Missing** — no UA is sent unless the extension sets one                                | A default UA on `/api/plugin-fetch`, overridable per request                                                                                                                                              | platform bridge              |
| Cookies across requests                             | `JvmCookieJar` + SQLite, survives restart                                                      | **Missing** — proxy is stateless and drops `Set-Cookie` deliberately                     | Per-plugin, per-host, in-memory cookie jar held host-side, keyed by the plugin's own grant                                                                                                                | platform bridge              |
| Redirects                                           | okhttp default                                                                                 | **Supported** — followed one hop at a time with the target re-checked                    | —                                                                                                                                                                                                         | platform bridge              |
| okhttp `Interceptor`                                | seven real ones                                                                                | **Refused**                                                                              | Do not model the interface. Recognise the four that recur (rate limit, UA, gzip, double-encoded JSON) and satisfy the _effect_ host-side                                                                  | platform bridge + translator |
| Rate limiting                                       | `RateLimitInterceptor`, `SpecificHostRateLimitInterceptor`                                     | **Partial** — `__k.rateLimit` exists                                                     | Honour it in the sandbox scheduler rather than as a no-op                                                                                                                                                 | shared runtime               |
| Cloudflare challenges                               | `CloudflareInterceptor` + FlareSolverr, cookies + resolved UA cached                           | **Missing** — reads as a bare 403                                                        | Detect and _name_ it (`403/429/503` + `cf-*`/`Server: cloudflare`/body hint). Solving it is a separate, later, opt-in decision                                                                            | platform bridge              |
| `WebView`                                           | class exists; `loadUrl` fires `onPageFinished` after 1.5s, `evaluateJavascript` answers `null` | **Refused**                                                                              | Keep refusing — but see §4                                                                                                                                                                                | translator                   |
| `CookieManager` (webkit)                            | `android-compat/webkit/CookieManager.kt`                                                       | **Missing**                                                                              | Falls out of the cookie jar above                                                                                                                                                                         | platform bridge              |
| Embedded JS engine (QuickJs/Duktape/Rhino)          | delegates to GraalVM `js` — i.e. _evaluate the string_                                         | **Refused**, and `eval` is forbidden in the sandbox (`AGENTS.md` rule 13)                | Do **not** grant eval. Recognise the dominant use — unpacking — and answer that: see §5.1                                                                                                                 | shared runtime               |
| Dean Edwards packer                                 | via the JS engine, or extensions' own `lib/unpacker`                                           | **Already exists**, unexposed to Aniyomi                                                 | `unpackDeanEdwards` in `extract/patterns.ts`; add the compatibility alias                                                                                                                                 | shared runtime               |
| `javax.crypto` (AES)                                | real JCE                                                                                       | **Supported** — AES-CBC and AES-GCM, HMAC, ECDSA over P-256/384/521                      | `ctx.crypto` (ABI.md §2), WebCrypto-backed. ECB, DES, RC4 and raw RSA stay **refused** by the algorithm string: WebCrypto has none of them and mapping one mode onto another decrypts to rubbish silently | shared runtime               |
| `SimpleDateFormat` / `Calendar`                     | real JDK                                                                                       | **Supported** — ranked 32 extensions when measured, and answered since                   | `kotlin-runtime.ts` `java.text dates`, which fails to parse rather than parsing wrongly                                                                                                                   | shared runtime               |
| `PlaylistUtils` (HLS master → per-quality videos)   | not miwayomi's — lives in the catalogue's `lib/`, runs as bytecode                             | **Missing** — ranked 42 extensions                                                       | Ship it. It names no host, so §4.1.3 permits it, and `hls-rewriter.ts` + `findManifestUrls` already do most of it                                                                                         | shared runtime               |
| Per-host extractors (`.videosFromUrl()`)            | runs the extension's own `lib/` bytecode                                                       | **Refused** — ranked 66 extensions                                                       | **Cannot ship here** — rule 9. Needs the reachability fix of §4.1.6, not a port                                                                                                                           | translator                   |
| HLS playback                                        | `hls.js` + `/hls` proxy with manifest rewriting                                                | **Supported**                                                                            | `hls-rewriter.ts`, shaka/mpv                                                                                                                                                                              | playback                     |
| DASH playback                                       | `dash.js` + `/dash` proxy, manifest rewriting                                                  | **Partial**                                                                              | shaka handles `.mpd`; no manifest rewriting path                                                                                                                                                          | playback                     |
| Direct MP4/WebM, chunked, MIME repair               | `StreamProxy` with range support and MIME sniffing                                             | **Partial**                                                                              | `/api/plugin-fetch` caps at 4 MB and is not a media path; playback goes direct or via the native host                                                                                                     | platform bridge              |
| Local proxy for extension-declared servers          | a real localhost HTTP server (`HttpServer` model)                                              | **Unsupported, deliberately**                                                            | `StreamPipeline` byte transforms (`ABI.md` §4.4)                                                                                                                                                          | StreamPipeline               |
| Threading (`Handler`, `Looper`, `Thread`)           | real threads                                                                                   | **Refused**                                                                              | Sandbox is single-threaded; `launch`/`async` already flatten to promises. Extend the flattening rather than model threads                                                                                 | translator                   |
| Locks and atomics (`synchronized`, `AtomicInteger`) | real ones                                                                                      | **Supported** since §5b                                                                  | The block runs and the atomic is a box: one thread means there is nothing to protect                                                                                                                      | shared runtime               |
| `Injekt.get<T>()`                                   | real Injekt DI                                                                                 | **Refused**                                                                              | Resolve the three types that matter statically — `NetworkHelper` → the runtime client, `Application`/`Context` → the preference store, `Json` → the runtime decoder                                       | translator                   |
| Torrent sources                                     | bencode + TorrServer                                                                           | **Out of scope** (`FOREIGN.md` §4.2)                                                     | —                                                                                                                                                                                                         | —                            |

## 4. Where miwayomi's answer is "no", and that is the finding

Two of these deserve emphasis, because they are the cases where copying would
have been the mistake the brief warns about.

**WebView.** `android-compat/webkit/WebView.kt` is 85 lines and does nothing. It
holds a URL, fires `onPageFinished` off a sleeping thread after 1.5 seconds, and
answers `evaluateJavascript` with `null`. It exists so the ClassLoader resolves
the type. An extension that genuinely needs a WebView — a Cloudflare interstitial,
a player page that assembles its URL in script — gets silence from it, not a page.

That is a strong argument for _keeping_ our refusal rather than weakening it,
and `AGENTS.md` rule 10 already says the surfaces differ. But it also suggests a
third option we do not currently take, and §5.4 proposes it.

**The JS engine.** miwayomi's `QuickJs` and `Duktape` shims both reduce to
"evaluate this string in a full JS context with `allowAllAccess(true)`". We
cannot follow that and should not want to: our sandbox deletes `eval` and
`new Function` on purpose, and an extension able to eval arbitrary text has the
capability the sandbox exists to withhold. What matters is that the _use_ is
narrow — extensions reach for a JS engine to undo a packer — and that use has a
pure, non-evaluating answer we already ship.

## 5. The queue, ranked by extensions unblocked

Ranked against `FOREIGN.md` §4.1.6's measured blockers, filtered to what is
reusable and permitted. **These numbers are from the 254-extension measurement
that produced the 4-of-254 figure and have not been re-measured since the base
class and preference framework landed** — re-running the catalogue is step one
and will re-order this list. Nothing below should be built past the point where
the scoreboard disagrees with it.

### 5.1 The unpacker alias — cheapest, and it has a licence question

`extract/patterns.ts` exports `unpackDeanEdwards`, it is already inside every
converted bundle (`shims/runtime-entry.ts` puts it there), `shims/mangayomi-entry.ts`
exposes it as `unpackJs`, and the Aniyomi path cannot reach it. Extensions reach
the same behaviour by three spellings: their own `lib/unpacker` module,
`QuickJs.create().evaluate(...)`, and `JsUnpacker`. Adding `Unpacker` to
`GLOBAL_NAMES` and to `kotlin-runtime.ts` is a table entry and a test.

**The upstream `lib/unpacker` is MPL-2.0, not Apache-2.0.** It was checked
during this review, and MPL-2.0 file-level copyleft is the exact reason `NOTICE`
records `Suwayomi-Server` as deliberately not read. So this one item cannot be
built the way the other reimplementations were, and it needs a decision before
anybody writes it:

- The **implementation** is not the problem: ours already exists and was written
  from the packer format, not from that file.
- The **interface** — the name, and `unpack(script, left?, right?)` returning an
  empty string when nothing is packed — is what an alias has to match, and
  matching an interface for interoperability is the ordinary case that neither
  licence obstructs.
- The **behavioural details** are the question. Upstream documents one that is
  not derivable from the packer format (single quotes inside the payload become
  double quotes), and reproducing that is reproducing what is in that file.

The conservative shape, and the one recommended here: implement the one-argument
form over our own unpacker, and have the two- and three-argument forms throw
`__k.unsupported` by name rather than guess. That is loud where it is unsure,
which is the rule everywhere else in this layer.

### 5.2 `PlaylistUtils` — 42 extensions, and it names no host

The single largest permitted win. It takes an HLS master playlist and produces
one `Video` per quality, carrying subtitle and audio tracks. It is pure
manifest parsing, so `FOREIGN.md` §4.1.3 permits it here — "a common player
configuration shape" is exactly what it is — and `hls-rewriter.ts` and
`findManifestUrls` already contain most of the parsing.

### 5.3 Two translator features — 63 and 36 extensions

"A class declared inside a function" and "a non-local return from a lambda" are
ordinary Kotlin, host-free, and blocked on emitter work alone. They unblock more
extensions than anything else on this list and carry no policy question.

### 5.4 Refuse later rather than earlier

Today a reachable member mentioning `WebView`, `Injekt` or `Interceptor` refuses
the whole conversion. miwayomi's stubs suggest the alternative: **translate the
member and emit `__k.unsupported('WebView')` at the exact call site.** The helper
already exists. An extension whose `videoListParse` uses a WebView for one mirror
and plain HTTP for four others then works for four, and fails loudly and by name
for the fifth — instead of not existing.

This is a real change to the conservative-refusal rule, so it is a proposal and
not a plan: it must not apply where the wrong answer is _silent_ (a dropped
interceptor that was rate-limiting, a decryption that returns a wrong string).
It applies where the alternative to a named throw is nothing at all.

### 5.5 Network truth: UA, cookies, and naming Cloudflare

Three separate small things, all in `/api/plugin-fetch`, all of which currently
read to a person as "that source is broken":

1. No default `User-Agent`. Sources check it.
2. No cookie jar. A source that hands out a session on its catalogue page and
   demands it on its episode page cannot work, and reports as an empty list.
3. A Cloudflare interstitial is indistinguishable from a real 403. **Done** —
   `challengeKind` in `/api/plugin-fetch/+server.ts` names it and the reach
   probe repeats it. Detection only; solving one is a separate decision.

The third was the cheapest and the most valuable per line: detection is a status
code, three header names and a body hint, and the payoff is that the scoreboard
stops filing a solvable class of failure under "the source refused us".

### 5.6 Then: `Html`, `Log`, AES

The small remainder. `Html.fromHtml` and `Log` are aliases onto things we have;
AES is `crypto.subtle` behind one helper. Each removes a `NAMED_OBSTACLES` entry.
Build them when the scoreboard says they are what is left.

`Uri`, `Base64`, `SimpleDateFormat` and `Calendar` are **already supplied** by
`shims/kotlin-runtime.ts` — checked against the file during this review, and
worth stating because two of them appear in §4.1.6's ranked blocker list and
that list predates them. It is the second entry in that list to have been
answered without the ranking being re-run, after the preference framework. **The
ranked list is stale in our favour and must not be used to choose work until the
catalogue has been re-run.**

## 5b. Answered on 2026-09-10, driven by four refusals

Four listings were checked in the app and each printed the members it could not
read and the constructs that stopped it. Read together the four lists are not
four problems: **most of what they name is ordinary Kotlin the translator had
no handler for**, not a missing Android or okhttp surface. That is a different
and much cheaper front than §5 assumed, and it is the one this pass took.

What now translates, with the reason each was safe to allow:

| Construct                                        | What it becomes                                            | Why that is exact                                                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typealias A = B`                                | nothing; the alias resolves to `B` where a value is wanted | Kotlin erases it too. `registerAlias` keeps only the head of the aliased type                                                                                                                                                     |
| `var x: String` with the assignment a line later | `let x;`                                                   | Kotlin's definite-assignment rule makes a read before that assignment a compile error, so the gap cannot be observed                                                                                                              |
| `init { … }`                                     | constructor lines, at the position it was written          | Kotlin runs initialisers and `init` blocks in declaration order, and a property declared below one cannot be read inside it. Constructor parameters are declared in scope, which is where Kotlin puts them                        |
| `synchronized(lock) { … }`                       | the block, inlined or via `__k.synchronized`               | One thread (`ABI.md` §1), and Kotlin forbids suspending inside one — so there is no interleaving point to protect. A block carrying a non-local `return` takes the inlining path                                                  |
| `AtomicInteger` and friends, `Any()`             | a mutable box; an empty object                             | Same one-thread argument. `Any()` is constructed here for one purpose: something to lock                                                                                                                                          |
| `map[key]` and `map[key] = v`                    | `__k.index` / `__k.setIndex`                               | **This was a wrong-value bug.** A Kotlin Map is a real `Map`, so `table['1080p']` read a property of the map object and answered `undefined` for every key                                                                        |
| `split(",", limit = 2)`                          | a trailing options object                                  | A named argument after a vararg has no slot to be reordered into; `VARARG_OPTIONS` is that shape written down                                                                                                                     |
| `STATE_INCLUDE` written bare                     | `AnimeFilter.TriState.STATE_INCLUDE`                       | Inherited from the companion of the class the filter extends. The constants did not exist on the runtime's TriState either, so the qualified spelling was `undefined` and every genre comparison was false                        |
| `preferences.edit().putString(k, v).apply()`     | itself                                                     | The store and its editor were already in `KOTLIN_PREFS`; only the passthrough allowlist stood in the way. `apply()` with no block is the editor's commit and not the scope function — the emitter now separates them by the block |
| `buildJsonObject { put(k, v) }`                  | a `function` block bound to the accumulator                | **Also a wrong-value bug**, in the other direction: the bare `put` was emitted as `this.put(…)` on the _source object_, so the conversion succeeded and the member died at its first call                                         |

Two of those rows are the interesting ones. `map[key]` and the JSON builders
were not refusals at all — they converted, packaged and installed, and failed
or answered nothing at run time. They were found by writing fixtures for the
_refusals_ and reading the emitted JavaScript on the way past, which is an
argument for reading the output of a conversion that succeeds.

### Second pass, same day: what installing one of them found

Oppai Stream converted, installed, and then answered a search with
`this.fixLink is not a function`. That message is worth more than the four
refusals were, because it is the failure `FOREIGN.md` §6 exists to prevent
arriving in the open, and pulling on it found four separate name-resolution
bugs — three of which produce a **wrong value or a dead member rather than a
refusal**:

- **A member extension function called from inside `apply {}`.** The block is a
  real `function`, so its `this` is the record being built; `this.fixLink(…)`
  looked for the extension on the `SAnime`. Now `selfReference()`, which is the
  `__self` the enclosing member captures. This is the Oppai Stream failure.
- **`this` inside `fun String.fixLink()`.** Kotlin's `this` there is the
  _receiver_, which this emitter moves into a parameter. Left as `this` it meant
  the source object, so `"https:$this"` interpolated the extension class and a
  bare `this` returned it. Two wrong values, no error.
- **A capitalised property the class declares itself.** `private val ALPHABET =
mapOf(…)` read from a method below it was refused as "a capitalised name this
  file did not declare". The companion case resolved — a companion hoists to
  module scope — and a plain property had nothing to catch it. This is
  PinoyMoviePedia's `ALPHABET`.
- **A file-scope constant declared below the class that uses it.** The same
  ordering problem the companion pre-registration already solved, one scope out.
  A Kotlin file puts its `private const val DEFAULT_REFERER` at the bottom.

Two more names were added on the way, both inert: `java.lang.Character`'s
statics, and okhttp's `Protocol` with `protocols(…)` — the HTTP version is
negotiated by whatever makes the request and neither surface exposes the choice,
so this is the `TimeUnit` argument again.

### Third pass: the refusal that was the contract being stale

With `fixLink` resolving, Oppai Stream's next answer was an honest, named
runtime refusal: **regex lookbehind**, in `(?<=\?e=)(.*?)(?=&f=)`, declared as
`fixLink`. That is `ABI.md` §6 — and §6 was **stale**. It opens with the
three-engine table (QuickJS, JavaScriptCore, the browser's own) that
`ADR-0003` §2.2 deleted when it deleted Flutter, and `ADR-0004` §4 already
names lookbehind as _"the first concrete thing the engine collapse bought"_.
`foreign/episode-recognition.ts` has used one on every episode list since. So
the runtime was refusing a converted extension for a construct our own runtime
uses, on the authority of a paragraph describing a product shape we no longer
have.

Repealed: `ABI.md` §6's engine paragraph now says what ADR-0003 left, and
lookbehind is allowed. Atomic groups, possessive quantifiers and `\p{…}` stay
refused — those are `java.util.regex` constructs JavaScript does not have,
which is a different reason and one the collapse did not touch. The other four
bullets in §6 are also inherited from the three-engine world; two of them are
load-bearing for _other_ reasons and none has been re-decided, which §6 now
says out loud.

### Third pass, second half: what crossed a file boundary and what did not

`Declared` — what one converted file tells the next — carried types, methods
and signatures, and **no file-scope values**. A shared `fun unpack(source)` was
therefore invisible to the extension calling it, fell through to the "a bare
lowercase name is a member the base class supplies" fallback, and came out as
`this.unpack(…)`: complete, packaged, installed, dead at the first call. A
capitalised one — a shared `ALPHABET` — was refused instead, which at least
said so. Both now cross.

Found in the same place, and the same family as the `apply {}` bug: a
**file-scope `suspend fun` was awaited nowhere**. Class methods were tracked;
file-scope functions were not tracked at all, so `val body = fetchBody(url)`
assigned the promise and what reached the player was `[object Promise]`.

What the four listings still name, and correctly: a local HTTP server
(`PlaylistServer`, `.register()`, `.segmentProxyUrl()`) — `ABI.md` §4.4 says
`StreamPipeline`, not a server; okio (`ForwardingSource`, `.source()`); and
per-host extractors, which is rule 9 and §5.2 again.

### Fourth pass: the first extension that ran end to end

The listing from the third pass now completes the whole chain against the live
site — **browse, search with filters, episode list, video extraction** — and
returns two playable MP4 URLs at two qualities. That is the first time a
translated Aniyomi extension has done all of it. Getting there cost five fixes,
and **four of the five were wrong values rather than refusals**, which is the
same finding as the second pass and is now a pattern rather than an anecdote.

**1. A file-scope `val X get() = …` had no value this build could read.** A
property with a custom getter at _class_ scope was handled and one at _file_
scope was not, so `val FILTERS: AnimeFilterList get() = AnimeFilterList(…)`
refused — and `getFilterList() = FILTERS` still emitted the bare name. Now
emitted as a function, with every read of the name a call to it, because a
Kotlin getter is **re-evaluated at every read**: folding it into a `const`
would hand every search the filter state the last search ticked. It crosses a
file boundary as `Declared.getters`.

**2. `when (filter) { is SortFilter -> … }` matched nothing.** `is` always
emitted the type's **name** as a string, and `__isType` answers a string by
looking it up in its small table of framework shapes — which has never heard of
a class the converted module declares four lines above. No branch ran, nothing
refused, nothing threw: the search simply went out with every filter the viewer
had chosen silently dropped. A type emitted as a real ES6 class is now handed
over as the class, so `instanceof` decides it, subclasses included. A `data
class` (a factory) and an `object` (a frozen literal) keep the name, because
`instanceof` is false for both. **This affects every extension with a filter
list**, which is most of the catalogue.

**3. The jsoup surface promised methods the runtime does not have.**
`HOST_METHODS` — the passthrough allowlist — lists `data`, `absUrl`, `val`,
`parent`, `children`, `tagName`, `className` and `id`, and `shims/dom.ts`
implemented none of the first three and spelled the last five as _fields_. So
`element.parent()` translated, packaged, installed and answered with `parent is
not a function`. `data()`, `absUrl()` and `val()` are now implemented; the five
field-shaped ones are rewritten at emission by `HOST_PROPERTY_METHODS`, which
drops the call parentheses. **The allowlist and the shim were never checked
against each other** — worth doing again the next time either grows.

**4. `:containsData` was not a supported pseudo-selector.** `doc.selectFirst("script:containsData(…)")!!.data()`
is _the_ idiom for pulling a stream list out of an inline script, and it needs
the selector and `data()` together — the same feature arriving from two
directions. Both landed in this pass. Note it does **not** normalise
whitespace, unlike `:contains`: it matches raw script source.

**5. An `object` refused as a unit, and the reference to it survived.** One
`Injekt.get` in one method deleted the whole `object Helper` — while the
extension next door, whose only reachable method called
`Helper.readEpisodes(response)`, still emitted that call against a name nothing
declared. An object now refuses **one member at a time**, exactly as a class
body does.

Beside it, the reason a refusal reached the viewer as a runtime error rather
than as a conversion verdict: **`reach()` followed calls and not references.**
A bare `FILTERS` is neither a call nor a member access, so the refusal that
named it was pruned as unreachable, the conversion reported `complete`, and the
bundle installed. References into _file-scope_ declarations are now edges. A
class member cannot fail this way — it is reached as `this.name`, which was
already an edge.

**The instrument that made all of this cheap** is a ~90-line script that
converts a set of `.kt` files, builds the entrypoint with `aniyomiEntrypoint`,
writes it to a `.mjs`, imports it, and drives `searchCatalog` → `listEpisodes`
→ `resolve` against a real `fetch`. It is the missing rung between
`convertKotlin` in Node (which only ever shows refusals) and installing in the
app (which shows one error at a time). Every bug above except the first was
found by reading its request log rather than its verdict — bug 2 in particular
is invisible to any check that does not look at the **query string the search
actually sent**.

Also worth keeping: `bun run check:generated` fails under bun 1.4.x by design,
and the fix is not to skip it — download the pinned bun (`1.3.14`, from
`packageManager`) into a scratch directory and run the generator with that.
Editing `shims/dom.ts` without regenerating `shims/generated/dom-source.ts`
changes nothing a converted bundle can see.

### Fifth pass: the 403 was ours, and the host learner had a false positive

**The `403` on the media host was not Cloudflare.** The verdict said "a
cloudflare challenge, not a refusal", and the challenge classifier was reading
a hotlink guard. Probed directly: the same URL answers `403` bare, `403` with a
browser user-agent, and **`206` with the `Referer` the extension had already
built in its own `headersBuilder()`**.

It never sent one, because **nothing defined `headers` on the source**.
`AnimeHttpSource` declares it `by lazy { headersBuilder().build() }` and an
extension reads it bare all over — `GET(url, headers)`, and
`Video(url, quality, url, headers)`, which is how a stream carries the header
its CDN insists on. `headers` was in `BASE_SOURCE_MEMBERS` (so `emit.ts` happily
emitted `this.headers`) and in nothing else, so every one of those reads was
`undefined`. The driver now defines it, memoised, from the extension's own
`headersBuilder()`. The rest of the path was already built for this: the ticket
in `plugin-playback-repository.ts` carries request headers, and a source with
any forces a relay.

This is the third instance of one shape — **a name the translator will emit and
the runtime does not answer**. `HOST_METHODS` versus `shims/dom.ts` was the
fourth pass; `BASE_SOURCE_MEMBERS` versus the driver is this one. Both tables
say "the runtime has this"; neither had anything checking that it does.

**And the host learner was reading `//` in JavaScript comments.** A real
catalogue page granted `console.log`, out of a commented-out
`//console.log(direction)` in an inline script. The packager had solved this
already — `foreign/adapter.ts` anchors the protocol-relative form on a quote and
tests the last label with `plausibleTld` — and the runtime reader had neither.
The shape test now lives in `plugins/host-names.ts` and both use it, and a `//`
is read as a URL only where a URL can start (after a quote, backtick, `=`, `(`
or `,`). Measured against two real pages: the only thing it stops learning is
`console.log`.

What the audit did **not** find, and it is worth writing down so it is not
re-litigated: learned hosts are **not** a widening of anything persistent. They
apply to converted plugins only, live on the running `PluginSandbox` and die
with it, are exact hosts and never wildcards, are refused unless the request is
`https:`, and are never written to a manifest — the manifest's hosts come from
`hostsInSource` at conversion time, which is the list a viewer consents to.
Being _named_ is not being reached. One thing was wrong: `sandbox-host.ts` sent
an `allowedHosts` field to `/api/plugin-fetch` with a comment claiming the route
applied the same rule independently. The route never read it. The field is gone
and the comment now says what the route actually enforces — a floor that holds
whatever a caller claims, which is why it does not need the allowlist.

### Sixth pass: "resolved 0 source(s)" was four answers wearing one face

`PluginPlaybackRepository.resolve` throws `NotFoundFailure` for four different
outcomes — no plugin claims the show; the source has no episode of that number;
the plugin answered with no videos; nothing survived publishing to the proxy —
and `resolvePluginSources` discarded all four, on a comment reasoning that
"nothing claims this show" is normal and the page already says kuro ships no
sources. That reasoning was written when nothing claimed anything. With a
converted source installed and browsing happily, the screen and the log both
said `resolved 0 source(s) {failure: null}` and there was no way to ask why.

`PluginResolution` now carries a `note` — always set when the list is empty for
a reason — and the reason is shown as a `failure` when a plugin actually
_claimed_ the show, which is the rule the interface always stated: something
undertook this and could not deliver. The watch page traces `note` and
`pluginId` beside the count.

Worth knowing when reading one of these logs: **both steps before the fetch are
cached**. `CatalogMediaMatcher` keeps bindings in `localStorage` and
`PluginSourceRepository.listEpisodes` keeps episode lists behind a TTL, so a
resolve that learns **no hosts at all** did no plugin network — which narrows
four outcomes to the two that can answer without one.

**And the consent screen was listing hosts out of our own runtime.** A converted
bundle's hosts were read from the whole _entrypoint_ — the extension wrapped in
every shim this build ships — where the deobfuscator matches on the literal
strings `"String.fromCharCode"` and `"String.fromCodePoint"`. Those reached a
viewer as `string.fromcharcode`, `string.fromcodepoint` and `string.from`, plus
a wildcard each. Beside them, `div.description` and `font.ep`: **CSS selectors**,
which are quoted strings shaped exactly like hostnames, and a scraper is made of
them. Fixed at both ends — hosts are read from the emitted module only, which is
the shape the Sora and Mangayomi adapters always had, and a quoted string handed
to `select`/`selectFirst`/`closest` is not read as a host. Measured on the same
extension: **14 hosts down to 4**, all four of them real.

### Seventh pass: it played, and then it looked like it had not

`resolved 2 source(s)` with the plugin named, `loading 2 source(s)`, `trying
"1080p"` — the whole chain, in the app. The `note` added in the sixth pass paid
for itself on the run before it: `'No installed plugin has this show.'`, which
is the matcher having nothing bound, not the source being broken.

Then nothing, for as long as anyone watched. No error, no fall-through, just
`no decoded frame yet` four times a second.

**Nothing was broken. It was downloading.** The file is a 166MB progressive
`.mp4` whose `moov` atom sits at the _end_ — `ftyp` then straight into `mdat`,
because nobody ran `-movflags faststart` — so the browser cannot decode a frame
until it has found the index. Measured through the proxy: 6.7MB/s, and the whole
file in **24.6 seconds**. That is the wait, and the log gave no sign it was
progress rather than a hang.

Two real defects sat underneath it:

**`/api/stream` aborted the body at thirty seconds.**
`AbortSignal.timeout(TIMEOUT_MS)` bounds the whole operation, body included —
correct for an HLS segment, wrong for the other thing this proxy carries. A
transfer that legitimately needs 24.6s on a good connection and more on a bad
one was being cut off at 30s with **no error anywhere**: the player simply never
decoded another frame, which is indistinguishable from a dead mirror. The
timeout now bounds _getting a response_ and is cleared when the headers arrive;
the buffered manifest branch re-arms it, since that one reads a capped body.
Verified after the change: the full 166,140,734 bytes, status 200, 24.6s.

**`player.load()` had no bound, so the walk had no way to give up.** Shaka
resolves it when the media is ready and rejects when it fails, and does neither
while bytes are arriving too slowly to produce a frame — so one stalled mirror
hung the walk indefinitely. 720p was never tried, and nothing was reported.
Bounded now at 45s, with an `unload()` first so the abandoned load stops pulling
bytes, and a retryable `NetworkFailure` so the walk moves on.

Written in the same pass: `source-fallthrough.spec.ts`, which
`source-fallthrough.ts` has promised in its own header since it was written and
which did not exist. The one thing that loop guarantees — a dead mirror does not
end the episode — was the thing nothing checked.

## 6. The loop, and the one thing it needs

`tool/check-catalogue.ts` is the instrument the brief describes, and it already
records more than the brief asks for: per listing, `notTestable` / `wouldNotConvert`
/ converted-then-failed-at-step, with the five steps being load, search,
episodes, resolve and reach. `host/scoreboard.ts` ranks blockers **by listings
each would unblock** rather than by frequency, which is the discipline the brief
asks for and which is already load-bearing here.

    bun run check:catalogue <index-url> --json report.json --why

`--why` prints, under the table, every failed listing with the **file, member and
line** of each obstacle and that line's own text — added in this pass, because
the ranking said _what_ to build and nothing said _where_. The live progress
lines carry the reason on the spot for the same reason.

It ships no index URL and cannot: rule 9 puts the repository address outside
this repository, so **the one input the loop needs is a catalogue URL supplied
at run time.** Everything else — concurrency, resumability, remembered verdicts
per listing version, Ctrl-C leaving a valid report — is built.

Two properties of the existing instrument worth not losing:

- **Translation completing is not success.** `substantive` already catches the
  extension that translates, installs, searches and finds nothing because
  everything it runs lives in a base class we could not read.
- **A refusal is conjunctive.** An extension blocked by three constructs is
  unblocked by none of them individually, which is why the ranking counts
  listings and why `CLAUDE_HANDOFF.md` rule 5 says to address them by whole-
  extension gains.

## 7. Where the pass stopped, and the two measurements that stopped it

**The compatibility loop is closed for this phase.** 60 listings convert, load
and run; every offline-convertible bundle loads cleanly; 5 of the 27 that are
live and reachable complete the whole chain. The remaining blockers no longer
unlock listings.

Two measurements made that a conclusion rather than a mood, and both work the
same way — count what a fix would unblock _alone_, then check what else the
listing carries:

|                                    | Listings carrying it | Listings it would unblock | Why                                                                                                                                                        |
| ---------------------------------- | -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A local HTTP server on loopback    | ≥ 14                 | 0                         | Not a gap. `ABI.md` §4 replaces it declaratively — `adr/0006-local-http-server.md`                                                                         |
| A non-local `return` from a lambda | 14                   | **0**                     | All 14 are already blocked by a native capability: WebView, `javax.crypto`, `.addInterceptor()`, `.loadForRequest()`, `.initSign()`, an embedded JS engine |

The second is the one worth internalising. It had sat on the backlog since the
translator's early days as the obvious next feature, and it survived there on
its _frequency_. Co-occurrence is the test, not the count: a construct that
appears in fourteen extensions and never decides one of them is not a blocker,
it is a passenger.

**What the last pass did find was diagnostics, twice.** A cluster classified
`native` correctly but _by accident_, on an unrelated obstacle the same
listings happened to also carry; and a refusal that named a construct the source
did not contain — `withContext`, bare `with`, `async` and `by lazy` each built
their frame with no label, so the one labelled return Kotlin permits inside them
was refused as "crossing a lambda" while crossing nothing. Neither moved a
number. Both were worth fixing, because a scoreboard is only worth what its
reasons are worth.

The work that remains is not translator work. It is the three capability
decisions in `adr/0005`, the sources themselves, and cleanup that will not move
installability.

## 8. Licensing

miwayomi is Apache-2.0. Its `source-api/` and `core-common/` are adapted from
Aniyomi (Apache-2.0, `NOTICE-ANIYOMI.md`); its `android-compat/`, server and UI
are its own work. Apache-2.0 permits reuse, including verbatim, with attribution
and a statement of changes.

The practice already set in `NOTICE` is stricter than the licence requires and
should continue: **reimplement from the published source, do not copy the text,
and attribute anyway.** It is what keeps the shims shaped like our runtime
instead of like a JVM, and it is why the preference framework has no widgets and
no properties file. Any new work derived from a miwayomi module gets a `NOTICE`
entry naming the files on both sides.

`NOTICE`'s "what was deliberately not read" boundary stands: `Suwayomi-Server`
(MPL-2.0) and `hoshi-io/apktojs` (AGPL-3.0) remain unread.

Rule 9 applies here as everywhere. Naming a client application, a compatibility
project and a file format is allowed; naming a content source is not, and none
is named in this file.
