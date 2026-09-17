# Foreign extension formats

How a repository written for a _different_ client becomes something Yorozo can
browse, and — where the format allows it — install.

Normative. Versioned alongside `yorozoPluginApi`; this describes **API level 1**.
`ABI.md` is what a plugin is; `REPOSITORY.md` is how one is distributed;
`HOST.md` is what runs one; this is how somebody else's plugin becomes one of
ours.

---

## 0. Rule 9, and the distinction this file rests on

`AGENTS.md` rule 9 forbids bundling, referencing or linking **a content
source** — a site that serves media. It does not forbid naming a _client
application_ or _file format_, and this document names several, because an
adapter for a format cannot be specified without saying which format.

The line, concretely:

- Naming `aniyomi` as a manifest format, and parsing `index.min.json`: allowed.
- Hard-coding the URL of any repository, or the hostname of any streaming site,
  extractor or CDN: **forbidden**, in code, comments, tests, fixtures and commit
  messages alike.

Format detection is therefore by **path shape**, never by hostname.
`github.com`, `raw.githubusercontent.com` and `api.github.com` are the only
hosts any adapter may name. The first two are named in `resolveIndexCandidates`;
the third is named in `git-trees.ts`, and it was added deliberately rather than
quietly, so the reason belongs here beside the rule it amends.

**Why a third host.** Converting from source (§4.1.1) means fetching the `.kt`
files under a directory, and that requires knowing which files are there. Raw
file hosting — the thing the other two hosts do — has no directory index at
all; a forge's own API is the only interface that answers the question. It is
the same repository, at the same ref, reached through the only door that opens.

The alternative was considered and does not work: deriving each file's path from
the extension's class name plus a fixed package prefix does not survive the
variation in package roots across a real catalogue, and a converter that guessed
wrong would report a member as absent rather than as untranslatable — a wrong
reason, which is worse than no answer.

Two constraints come with it. Unauthenticated, that API allows **60 requests an
hour per address**, so a host fetches **one tree per repository per session** and
serves every directory listing from it; a tree per listing fails partway through
checking a repository and looks like the catalogue is broken rather than like we
were rude. And a **truncated** tree is refused, never used: it silently omits
files, and the omission would surface as a spurious refusal somewhere else.

The two self-hostable forge shapes need no new host at all — their APIs live on
the origin the pasted repository URL already named, which is why only one host
was added and not three.

Yorozo ships **zero** repositories in any format. Every entry came from a URL
its owner typed in.

---

## 1. The tiers

A format's tier is a statement about its _artifact_, not about its quality.

| Tier          | Meaning                                                        |
| ------------- | -------------------------------------------------------------- |
| `convert`     | The artifact is text we can turn into a bundle on the device   |
| `browse-only` | The index parses and the catalogue lists, but nothing installs |

`browse-only` is a first-class outcome, not a failure. A repository that lists
254 extensions is worth showing in full even when this build cannot run any of
them: it tells someone what exists, and it tells them precisely why the button
is disabled. The alternative — refusing the URL — is indistinguishable from a
typo.

### 1.1 The table

| Format        | Client(s)                  | Artifact                                        | Tier          | Why                                                                         |
| ------------- | -------------------------- | ----------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `sora`        | Sora                       | `.js` + `module.json`                           | `convert`     | Plain script; maps onto `ABI.md` §1 almost one to one                       |
| `hayase`      | Hayase, Shiru              | `.js` + index entry                             | `convert`     | Plain JS; yields torrents, which the host acquires; §4.2                    |
| `lnreader`    | LNReader                   | CommonJS `.js`                                  | `browse-only` | Novels only; §4.3                                                           |
| `mangayomi`   | Mangayomi                  | `.js` or `.dart` source                         | `convert` †   | The JavaScript third converts; the Dart majority needs an interpreter; §4.4 |
| `aniyomi`     | Aniyomi, Anikku, and forks | APK (R8-minified DEX), built from public Kotlin | `convert` ‡   | Never the artifact — the **source** it was built from; §4.1.1, §4.1.6       |
| `cloudstream` | Cloudstream                | `.cs3` (DEX) and `.jar` (JVM)                   | `browse-only` | Same as above; §4.1                                                         |
| `stremio`     | Stremio                    | none — a published HTTP protocol                | `convert` §   | Nothing to translate: the bundle is a client for the protocol; §4.6         |

§ **This format has no artifact at all, which is why it is the cheapest of the
seven.** An addon is an HTTP service with a published protocol rather than a
program, so conversion produces a generated client for that protocol,
parameterised by the addon's address — see §4.6. Nothing of the author's code
is embedded, no bundle carries an upstream licence, and the same generated
file serves every addon ever installed.

‡ **This tier is a statement about the source, not the artifact, and it is
deliberately optimistic.** Nothing here opens an APK; §4.1.1 is the argument for
reading the program the artifact was built from instead. Most extensions still
refuse — §4.1.6 has the measured rate — and that is the right shape rather than
a reason to mark the format `browse-only`, because a refusal is now **per
listing** and names the members that blocked it. A format-wide sentence could
only have said "not built yet", which is no longer true and was never something
a reader could act on. §6.1's four states carry the rest: a listing nobody has
run is **Unchecked**, and running it answers Works or Broken with a reason.

† **A tier is normally a statement about a format's artifact, but one format
has two.** A Mangayomi listing points at a _source file_ and names the language
it is written in, so convertibility is decided per listing rather than per
format. `refusalFor` therefore reads the listing's own `sourceCodeLanguage`, and
a repository can legitimately offer some rows that install and some that refuse.
A format-wide sentence would be a lie in both directions.

Formats not adapted at all — Legado, Shosetsu, IReader, Echo, Tsundoku,
Kotatsu's external sources — are listed in §8 so that the gap is recorded
rather than implied.

---

## 2. What an adapter does

An adapter answers three questions and nothing else:

```ts
interface ForeignAdapter {
	readonly format: ForeignFormat;
	readonly tier: ForeignTier;

	/** Index URLs to try for whatever was pasted, best first. */
	candidates(pasted: URL): string[];

	/** One foreign index, as one of ours. Throws if the body is not this format. */
	parseIndex(body: string, indexUrl: string): RepositoryIndex;

	/** One listing, as bundle bytes. `browse-only` adapters throw. */
	convert(listing: RepositoryPlugin, get: Fetcher): Promise<Uint8Array>;
}
```

`parseIndex` returns a `RepositoryIndex` — **our** shape, the one
`REPOSITORY.md` §2 defines. That is the whole trick: a converted repository is
not a special kind of repository, so the browse screen, the consent sheet and
the update path need no knowledge that a foreign format exists.

`parseIndex` must **throw** rather than return an empty index when the body is
not its format, because detection (§3) works by trying adapters in order and
taking the first that succeeds. An adapter that politely returns nothing makes
every later adapter unreachable.

### 2.1 `origin`, the provenance a converted listing carries

```ts
interface ForeignOrigin {
	readonly format: ForeignFormat;
	/** Where the artifact itself lives. https only. */
	readonly artifactUrl: string;
	/** The foreign ecosystem's own id, for update matching. */
	readonly foreignId: string;
	/** Its own version string, compared verbatim; never parsed as semver. */
	readonly foreignVersion: string;
	readonly mediaKind: ForeignMedium;
	/** Every medium the listing claimed; `mediaKind` is its first element. */
	readonly mediaKinds?: readonly ForeignMedium[];
	readonly isNsfw: boolean;
}
```

`ForeignMedium` (`anime | live-action | manga | novel`), not the app's own
`MediaKind` — deliberately a narrower, local union; `formats.ts` explains why
the runtime may not own the app's discriminator, only mention it.

Some ecosystems declare a **set** rather than one medium: a Sora manifest's
`type` of `movies/shows/anime` claims three, and Cloudstream's `tvTypes` is an
array. `mediaKind` is the one the listing is filed under — its first declared
medium — and `mediaKinds` is everything it claimed. A consumer routing by
medium must read `mediaKinds` (via `declaredMediums`, which falls back to
`[mediaKind]` and then to the empty list): a superset declaration is not
evidence against the mediums it also named, and treating the collapsed value
as exclusive skips a drama source for every live-action title it serves.
Absent means the adapter's classification was genuinely single-valued.

`foreignVersion` is compared as an opaque string. Foreign ecosystems number
however they like — an integer version code, a two-part `14.58`, a semver — and
imposing semver on them would make a legitimate bump look like a downgrade.

---

## 3. Detection

A user pastes one thing. The host builds a candidate list across every adapter,
ordered so that **the native format is always tried first** — a Yorozo
repository must never be mistaken for a foreign one — then probes each
candidate and gives the body to each adapter until one parses it.

Both halves matter. A URL alone does not identify a format: several ecosystems
publish an `index.json`, and two of them mean different things by it. The
_body_ decides; the URL only narrows what to fetch.

Candidate paths, by shape:

| Path                    | Formats that use it                                        |
| ----------------------- | ---------------------------------------------------------- |
| `index.json`            | native, mangayomi, hayase                                  |
| `index.min.json`        | aniyomi                                                    |
| `plugins.min.json`      | lnreader                                                   |
| `repo.json`             | aniyomi (metadata), cloudstream (pointer to `pluginLists`) |
| `module.json`           | sora (a single module)                                     |
| anything ending `.json` | tried as given, every adapter                              |

**https at every hop**, including redirects and every artifact download. A
cleartext index is one anybody on the path can rewrite, and rewriting an index
is enough to install anything.

---

## 4. What each format's artifact allows

### 4.1 Android and JVM bytecode

An extension APK ships its own classes and **nothing else**. A representative
one carries 119 R8-minified classes and references `kotlinx.serialization`,
`kotlinx.coroutines`, the Kotlin standard library, an HTML parser, an HTTP
client, `javax.crypto`, the Android preference framework, a dependency-injection
container and an embedded JavaScript engine — none of which are in the file.

So the difficulty is not the bytecode container. Converting DEX to JVM class
files is a solved problem, and one of these ecosystems publishes plain `.jar`
artifacts already; neither gets you the classpath, and the classpath is the
work. Running such an extension means providing that entire runtime, in
JavaScript, on three engines (`ABI.md` §6).

#### 4.1.1 The source, which is usually public

The artifact is not the only thing published. These extensions are _built_ from
public repositories of readable Kotlin, and a published repository names its own
source: `repo.json` carries a `meta.website` pointing at it. Following that link
is the difference between reverse-engineering a binary and reading a program.

A representative source repository holds 254 extensions in 816 Kotlin files —
and only **11 shared templates** and **76 shared helper modules** underneath
them. The per-extension file is small: 16 KB at the median, 38 KB at the 90th
percentile, because almost all of it is a subclass that overrides a base URL,
some selectors, and one or two small methods.

That changes the shape of the work. Against the source, the template an
extension was generated from is a directory name and its `build.gradle`
`themePkg` — a fact, not an inference. Against the binary it can only be
guessed at.

#### 4.1.2 When there is no source

Some repositories publish only the APK, and a fork's source may be taken down
while its published artifacts stay up, so the binary path is a real fallback
rather than a historical note. Two properties make it workable:

- **R8 minifies class names, not string constants.** Selectors, endpoint paths
  and format strings survive intact in the DEX string pool, which a small reader
  extracts without executing anything.
- **Templates are still identifiable from what an extension _references_.**
  Clustering one 254-extension catalogue by its template-specific selector
  constants yields 7–10 stable groups covering 30–35% of it, dominated by two
  large ones. Less than the source gives, and enough to be worth having.

#### 4.1.3 What the host may and may not ship

This is where rule 9 binds hardest, and the line is not obvious.

A template is a _shape_ — a page layout, a pagination scheme, an episode-list
structure. Implemented with its selectors and base URL passed in as arguments,
it names no source and is ordinary machinery, so it belongs in the host.

A per-host stream extractor is not. Those are named after specific video hosts
and are made of their hostnames and URL patterns; porting one into this
repository would put a content source into the code, the comments and the
history, which rule 9 forbids outright. Generic transforms that recur
everywhere — a well-known JavaScript packer, a common player configuration
shape, base64 — are host-free and may ship. Anything that cannot be described
without naming a site must live in a plugin repository, which is exactly the
separation §6 of `REPOSITORY.md` already requires.

#### 4.1.4 What the template path is actually worth, measured

Five templates were ported to settle this by experiment rather than estimate,
covering 54 of the 60 template-backed extensions in one 254-extension
catalogue. The result:

|                                          | Extensions |
| ---------------------------------------- | ---------- |
| In the catalogue                         | 254        |
| Extending a ported template              | 54         |
| **Converting from their template alone** | **1**      |

Not a small tranche — one. And the obvious next improvement does not move it: a
reader that resolved `override fun x() = "literal"` the way it already resolves
`get() = "literal"` would recover 403 selector constants across half the
catalogue, and re-running the measurement with all 403 resolved still converts
**one**.

The reason is in what remains. Ranked, the members that block a conversion are
`videoListParse` (31), `popularAnimeRequest` (29), `searchAnimeRequest` (24),
`getVideoList` (22), `animeDetailsParse` (18), `episodeListParse` (14),
`episodeFromElement` (13), `latestUpdatesRequest` (12). Every one of those is a
method body that builds a request or walks a document. None is a constant in
disguise, and no amount of constant extraction reaches them. An extension on a
template overrides the template's _behaviour_, not just its selectors.

So the honest conclusion is that **the template path does not convert this
ecosystem**, and a document that implied otherwise would send the next person
down the same road. What it does do is state precisely what a translator would
have to handle — eight method families, named above — which is a much smaller
and better-specified problem than "translate Kotlin".

The templates themselves are kept. They are correct, they are the runtime a
translator would emit calls into, and they are what makes the eventual output
small. They are simply not, on their own, a conversion strategy.

So the staged answer is a **converter that executes no bytecode**: read the
source where it exists and the string pool where it does not, resolve which
template an extension uses, and instantiate a parameterised TypeScript
implementation of that template with the extension's own constants. A general
interpreter is the fallback for what neither path reaches, not the starting
point.

#### 4.1.5 What the _source_ path measures, against the same catalogue

§4.1.4 measured the template-and-constants path and found it converted one
extension in 254. This is the same catalogue, measured again with a parser
rather than a constant reader, to size the translation path before building it.
`tool/kotlin-survey.ts` is the instrument; it takes a local clone, because an
extension's name in this ecosystem is the name of a content source.

**The grammar reads this ecosystem.**

|                                             |               |
| ------------------------------------------- | ------------- |
| Extensions                                  | 254           |
| Kotlin files                                | 643 (5.0 MiB) |
| Files containing any `ERROR`/`MISSING` node | 33 (5.1%)     |
| Extensions parsing **entirely** clean       | 224 (88.2%)   |

So parsing is not the bottleneck, and a converter that refuses on any error node
still has 88% of the catalogue in front of it. That is the opposite of the
binary path, where the classpath was the wall.

**What is in the bodies that block conversion.** 247 of 254 extensions declare
at least one of the members §4.1.4 named. Ranked by how many extensions each
construct would unblock — which is the number that matters, not raw frequency:

    calls, navigation, parameters, returns   247
    string literals                          245
    property and variable declarations       241
    lambdas                                  235
    string interpolation "$x"                229
    assignment                               206
    if-expression                            188
    elvis ?:                                 180
    when                                     172
    string interpolation "${...}"            155
    postfix (!!, ++)                         140

None of that is exotic. It is ordinary Kotlin, and it is why a restricted-subset
translator is worth attempting where a template matcher was not.

**What those bodies call**, by extensions: `GET` 218 · `response` 216 ·
`create` 200 · `SAnime` 185 · `apply` 181 · `select` 181 · `text` 177 ·
`attr` 175 · `SEpisode` 168 · `selectFirst` 165 · `joinToString` 163 ·
`setUrlWithoutDomain` 154 · `asJsoup` 123 · `newCall` 106. This is the runtime
shim's specification, arrived at by counting rather than by taste.

One finding worth stating on its own: **`UnsupportedOperationException` appears
in 134 of 254 extensions.** Declaring a member and throwing from it is ordinary
control flow in this ecosystem, not an error — a converter that treated it as
one would refuse half the catalogue for doing something normal.

**Fan-out per extension**, which is what bounds the fetch: 60 extensions declare
a theme, across 7 distinct themes; 862 lib dependencies across 58 distinct
modules, a mean of 3.4 per extension. So most extensions are _not_ generated
from a template — they subclass the base source class directly. The template
path was never going to carry this ecosystem, and §4.1.4's conclusion is
reinforced rather than revised.

The top lib modules are per-host stream extractors, at 65, 62, 60 and 59
extensions each. §4.1.3 is therefore not a corner case either: it is the
majority path, and it is why those are translated into the bundle on the
viewer's device rather than shipped here.

**The coverage curve, which is the go/no-go.** Only **72 distinct node kinds**
appear across every blocking member in the whole catalogue. Asking how many
extensions would translate _completely_ — every kind in every blocking member
supported, because §6's discipline refuses a partial body rather than shipping
one — as a function of how many of those kinds an emitter handles:

| Kinds supported | Extensions translating completely |
| --------------- | --------------------------------- |
| top 10          | 0 (0.0%)                          |
| top 20          | 0 (0.0%)                          |
| top 30          | 2 (0.8%)                          |
| top 40          | 48 (18.9%)                        |
| top 50          | 132 (52.0%)                       |
| **top 60**      | **228 (89.8%)**                   |
| all 72          | 247 (97.2%)                       |

The curve is worth reading rather than skimming. It is flat to 30 and steep from
40 to 60 — which is the signature of a problem with a _bounded_ long tail rather
than an unbounded one, and it is the opposite of what §4.1.4 found. Ranks 31–61
are entirely ordinary Kotlin: equality, arithmetic, `is`/`in`, `::`, indexing,
destructuring, `as`, `&&`/`||`, `try`/`catch`, `super`, `for`, `while`, ranges.
Rank 62 is `ERROR` itself, which must refuse by design, and ranks 63–72 are one
to three extensions each.

**What this number is not.** It is _syntactic_ coverage: every construct in the
body is one the emitter handles. It says nothing about whether the emitted
JavaScript is semantically right — jsoup returning `''` where Kotlin expects
null, `Int` division truncating, and above all suspending lambdas inside
collection operations, where a wrong `filter` predicate filters on promise
truthiness and silently keeps everything. **Emit rate is not works rate.** The
number that decides whether this shipped is how many converted bundles pass §6's
five steps, and it belongs here beside these when it exists.

Stated plainly so the next person does not misread the table: 89.8% is the
fraction of the catalogue whose _syntax_ a 60-kind emitter can express. It is
permission to build the thing, not evidence that it works.

#### 4.1.6 What the translator actually converts, and why it is not 89.8%

The emitter was then built, and run over the same 254 extensions all the way to
a bundle the sandbox imports (`tool/kotlin-convert-report.ts`):

|                                                     |       |
| --------------------------------------------------- | ----- |
| Refused by the translator                           | 250   |
| Translated completely                               | 4     |
| Packaged, loaded and answered `searchCatalog`       | 4     |
| Failures in the packager, archive reader or runtime | **0** |

**The gap between 89.8% and 1.6% is the most useful thing either measurement
produced, and it is not a contradiction — it is a correction.** The coverage
curve counted _node kinds_: whether the shapes of the syntax were ones an
emitter could walk. Almost every real refusal is instead an unresolved
**symbol** — a method the extension calls that nothing in scope defines. Syntax
was necessary and nowhere near sufficient, and a plan that had stopped at the
curve would have been badly wrong about how much work remained.

The other half of the table is the encouraging half: **nothing that translates
fails afterwards.** The runtime, the base-class driver, the packager and the
archive reader are not where the losses are, so coverage is a single tractable
front rather than a diffuse one.

Ranked by extensions affected, what blocks the other 250:

    a `super.` call                      100
    .videosFromUrl()                      66
    a class declared inside a function    63
    PlaylistUtils(…)                      42
    .toUriPart()                          38
    a non-local return from a lambda      36
    a date-format constant                32
    the Android preference framework      31

The first is answered by this build supplying the base class those calls refer
to (§4.1.7). The second, fourth and ninth are per-host extractors, which is
§4.1.3 again: they live in the catalogue's own `lib/` modules and must be
translated into the bundle rather than shipped here.

**The last is answered.** The Android preference framework is no longer refused:
the runtime supplies `PreferenceScreen` and the four preference types, a
`SharedPreferences` that reads the manifest's own `settings` and writes to a
per-run overlay, and the conversion derives that `settings` block from the
extension's `setupPreferenceScreen` (§4.4, §5.3). The 31 is what it should
remove; **it has not been re-measured against the catalogue**, and the number to
beat is still 4 of 254 until the scoreboard ADR-0004 §5 asks for exists and says
otherwise.

**One negative result, recorded so it is not re-derived.** Feeding those `lib/`
modules into the translator alongside the extension — the obvious fix — moved
the count from 4 to **0**. An extractor has its own refusals, and because a
conversion is complete or it is not, every extension naming an extractor then
failed on the extractor's problems instead of its own. What is needed is
reachability: the entry class, plus the members it actually calls from shared
files, and not the rest of those files.

#### 4.1.7 The base class this build supplies

An extension in this format is a **subclass**, and most of what makes one work
lives in the class it extends rather than in the file being converted. So the
host supplies that class: `shims/aniyomi-entry.ts` is a reimplementation of its
driver half, which is a _shape_ and therefore shippable under §4.1.3 — it names
no site and never may.

**Where its behaviour comes from, and why that is a licence question.** The base
class is published, readable Kotlin under **Apache-2.0**, and the driver is
written against the program rather than against a guess at it. Apache-2.0
permits porting behaviour with attribution; the repo-root `NOTICE` is that
attribution, and it also records the two adjacent projects that were
deliberately _not_ read, because their licences (MPL-2.0 file-level copyleft,
AGPL-3.0) would reach further into this repository than a compatibility shim
should. Reading the program is what makes the defaults right rather than
plausible — `sortVideos()` delegating to a deprecated `sort()`, a hoster's
request addressing the _hoster's_ url and not the episode's, `resolveVideo`
answering null to mean the stream is gone — none of which is guessable and all
of which extensions rely on.

**Two video paths, because upstream has two.** The published API moved: an
episode yields **hosters**, and a hoster yields videos. `videoListParse(response)`
is the path kept for the extensions that predate the change. Both are
implemented, and the hoster path is tried first — an extension written against
the current API declares nothing the legacy path can call, so before this it
could not convert at all. Kotlin separates the two by overload resolution and
JavaScript has no overloads, so once a class is translated `videoListParse` is
one name for two methods; the driver decides from what the class declares (any
hoster member makes it hoster-shaped) and, where that is not enough, from
arity.

**Refused by name, and why each.** A member the host cannot honour is a refusal
naming itself, never a silent no-op:

| Member                              | Refused because                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createHttpServer()`                | The extension plays by running a **local web server on the device** and pointing the player at it — `ADR-0002` §2.1's observation, promoted into the upstream API. A plugin here gets no ambient capability (rule 13) and the host executes a declarative byte pipeline instead. An override fails at `resolve` with `UnsupportedError` (`ABI.md` §5); the stream urls such an extension hands back address a server nobody started, so ignoring the override would be a false pass. |
| `getImageTile(url)`                 | Returns an Android bitmap. There is no bitmap surface for a plugin to draw into.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `generateId(name, lang, versionId)` | The first eight bytes of an MD5 read as a signed 64-bit integer, which JavaScript's number cannot hold. A rounded id is a wrong answer wearing a right one's clothes, and the failure it produces — two sources colliding — surfaces much later with nothing pointing back here. Yorozo identifies a plugin by its own manifest id and does not need the value.                                                                                                                      |

`getVideoThumbnails()` is **not** refused: upstream's own default is `null`, so
answering `null` is fidelity rather than a stub. Nothing in this ABI asks for a
thumbnail, so an override of it is unused rather than wrong. And there are no
torrent members on this base class at all — §4.2 refuses that format one tier
up, at install, which is the honest place for it.

**One deliberate divergence, stated rather than silent.** `setUrlWithoutDomain`
is reimplemented exactly, percent-decoding and unparseable-url passthrough
included, with a single exception: a url with no path at all (a bare origin)
becomes `/` here where upstream produces the empty string. Everything
downstream treats an empty id as _no_ id — a catalogue entry with one is
dropped rather than emitted — so upstream's answer would delete a row instead
of pointing it at the site root, which is what it means.

#### 4.1.8 Interceptors: the two that translate, and the rest that do not

An extension in this format configures its HTTP client by installing okhttp
`Interceptor`s. There is no interceptor chain here — the host owns the transport
and buffers the whole body — so the question is not "can we run one" but "can we
read what one was for". The answer splits cleanly, and the split is the point.

**Translated**, because the meaning is fixed by the signature and nothing has to
be read out of a body. Each becomes a `RequestPolicy` the host enforces
(`ABI.md` §2.1):

| Written                                                     | Becomes                                     |
| ----------------------------------------------------------- | ------------------------------------------- |
| `.rateLimit(permits)`                                       | `rateLimit`, over one second                |
| `.rateLimit(permits, period)`                               | `rateLimit`, `period` in seconds            |
| `.rateLimit(permits, period, TimeUnit.X)`                   | `rateLimit`, in that unit                   |
| `.rateLimit(permits, 250.milliseconds)`                     | `rateLimit`, from the `Duration` overload   |
| `.rateLimitHost(url, permits[, period[, unit]])`            | `rateLimitByHost`, keyed by that url's host |
| `.addInterceptor(RateLimitInterceptor(…))`                  | the same as `.rateLimit(…)`                 |
| `.addInterceptor(SpecificHostRateLimitInterceptor(url, …))` | the same as `.rateLimitHost(…)`             |

**The period is resolved to whole milliseconds by the emitter**, and this is not
an optimisation. `300.milliseconds` is erased to the bare number `300` before
any runtime helper sees it, so `rateLimit(1, 2)` and `rateLimit(1, 2.seconds)`
would otherwise reach the runtime as identical arguments meaning two thousand
milliseconds and two. A period written as anything but a literal, or in a unit
finer than a millisecond, is **refused** — naming `.rateLimit()` and saying so —
because the failure mode of guessing is an extension that asks a source for a
thousand times more than it promised, and the symptom is a viewer whose address
is blocked rather than an error anybody can read.

**Refused, and staying refused:** every other interceptor, including
`.addInterceptor { chain -> … }` with any body at all, an `Interceptor { … }`
object, and a named interceptor class this list does not contain. The refusal
names the construct.

This is `docs/adr/0006-local-http-server.md` §5's rule applied a second time.
Recognising what an interceptor body _means_ is recognising that the rest of it
does nothing that matters, and the rest is where a challenge-solve fallback, a
signing step and a cookie read live. The measurement agrees: accepting the body
unblocks zero listings, because an extension whose interceptor does something
worth recognising also reaches for `.proceed()` and a cookie jar, and those are
blocking anyway.

**What does not translate, and is not pretended to.** `retry` and
`headersByHost` are part of the policy and no Kotlin shape maps onto either —
there is no declarative retry helper in the shared libraries, and the default
`User-Agent` an extension inherits is the _host's_ value rather than the
extension's, so inventing one here would be fabricating a semantic. Both fields
exist for plugins written for this ABI and for hand-written adapters (§2).

**One divergence, stated rather than silent.** okhttp installs an interceptor on
_a client_; the policy is per _plugin_. An extension that builds two clients and
paces each gets the stricter of the two rules applied to both. That is slower
than it asked for and never faster, which is the only direction in which being
wrong here does not cost a viewer their access.

---

### 4.2 Torrent sources

One adapted format's extensions declare `"type": "torrent"` and return magnet
links. This was refused on the ground that Yorozo's players take an HTTP URL,
neither can play a magnet, and there is no torrent client in the product —
with the note that it "stops refusing when a torrent client exists".

**It exists, so this converts.** A row's info hash becomes a
`TorrentDescriptor` (`ABI.md` §1); a resolve answering with descriptors and no
direct link is a pass, not a failure; the host owns acquisition behind its own
`TorrentAcquisition` port, with pairing and per-source consent in front of it.
Neither the adapter nor the runtime acquires anything, and must not: they hand
back an info hash and stop, which is the same division that keeps a plugin
from knowing what device it runs on.

These sources publish **no catalogue and no episode list** — they answer about
a title the caller already names, which is the same shape as a stream-only
addon in §4.6 and is bound the same way: by an id the host holds
(`ExternalIdKind`), never by searching a catalogue that does not exist.

A repository-local helper module is part of the extension and is fetched with
it, from the same repository at the same ref. A specifier that resolves
outside that repository is refused — it is a real URL on the same forge, and
following it would let one listing run code from a repository nobody added.

### 4.3 Unsupported mediums

`AGENTS.md` scopes the product to `anime` and `live-action` (movies and drama
series): no manga, no light novels. This is a per-_listing_ judgement and not
a per-repository one — one ecosystem's own published catalogue is manga-only
while third-party catalogues in the same format serve something this build
does show, so a format may not be written off on the strength of the
catalogue its authors happen to publish. Listings **none** of whose declared
mediums (`origin.mediaKinds`, falling back to `origin.mediaKind`) are in
`SUPPORTED_MEDIUMS` (`formats.ts`) are **filtered out of the browse list** by
`keepMediums` and cannot be installed; one supported medium among several
keeps the listing. A repository whose every
listing was filtered says so explicitly — "this repository lists no
supported sources" — rather than rendering an empty list, which reads as a
broken fetch.

`live-action` is not the same claim as "anime". A listing correctly
classified as `live-action` still answers to its _format's_ own tier: a
Cloudstream listing, for instance, is now filtered in rather than dropped,
and still refuses to install, because that format's artifact is compiled JVM
bytecode with no converter yet (§4.1) — a fact about the format, unrelated to
what the listing serves.

### 4.4 A format that is half convertible

One ecosystem publishes **source**, not a build, and names the language of each
file. The JavaScript third of a typical anime catalogue needs no translation at
all: those files were written against globals their own app provides, and every
one of them has a counterpart here.

| Foreign global      | Answered by                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `Document`          | the host's own HTML parser and selector engine, inlined as source                                            |
| `Client`            | `ctx.http`                                                                                                   |
| `MProvider`         | declared by the entry shim; carries `source` and `getPreference`                                             |
| `SharedPreferences` | the same preference lookup, reachable from module scope, over the manifest `settings` the conversion derived |
| `unpackJs`, base64  | the host's generic deobfuscation helpers                                                                     |

The Dart majority refuses, naming the _language_ rather than the format, because
the same repository's JavaScript rows install.

**Inlining, not importing.** A bundle is one self-contained module with no module
resolution inside the sandbox (`ABI.md` §1), so a parser cannot be imported into
one — it travels in as source text, emitted by a generator and committed, so
what ships is reviewable in a diff and a bundle's digest stays a fact about its
input rather than about the machine that converted it.

**Preferences are derived, declared and drawn.** A conversion reads the source's
own `getSourcePreferences()` **statically** and emits what it found as the
bundle's manifest `settings` — key, type, title, summary, entries, entry values
and default — which the host then renders in its own tokens on every surface
(`ABI.md` §1). A read answers, in order: what this run wrote, what the viewer
chose, and what the source declared. This matters more than it sounds: sources in
this ecosystem choose a base URL or a preferred server that way, and a bundle
declaring none ran on whichever mirror its author happened to list first.

Three limits, stated rather than discovered:

- **A declaration assembled at runtime is not read.** The reader walks source
  text and stops the moment a value stops being a literal, because the
  alternative — build the bundle, run it, then rewrite the manifest — would make
  a bundle's digest a fact about which mirror answered, and would ask a viewer to
  consent to a manifest produced by running the thing being consented to. A
  preference that cannot be read is absent from the manifest, no row is drawn for
  it, and the bundle's own fallback answers it: exactly the old behaviour, for
  that one preference.
- **A write does not persist.** These sources write a preference to remember a
  resolved mirror and read it again moments later, so a write that vanished would
  be a read contradicting the line above it. It goes to a per-run overlay that
  dies with the sandbox. A plugin that could write a setting back would be editing
  a screen it is not allowed to draw.
- **A setting may choose among the granted hosts; it may never add one.** See §5.3.

**A bundle that declares no settings is unchanged.** It reads its own declared
defaults exactly as before, which is what every bundle installed before this
existed does.

#### 4.4.1 Per-host extractors, and why they are stubs

This ecosystem's runtime ships a family of built-in **per-host stream
extractors**, reached as bare globals, and sources both call them and wrap them:

```js
_someExtractor = someExtractor;                  // captured, then replaced
someExtractor = async (url) => { ... };
```

§4.1.3 forbids those living here: they are named after specific video hosts and
are made of their hostnames and URL patterns. A host may not ship them, and this
one does not.

So each such name is declared in the generated bundle as a **stub that throws
when called, naming itself**. The names are read out of the file being
converted, on the viewer's own device; this repository holds no list of them and
must not grow one — detection is by _shape_, never by a table of hosts.

The consequence is the useful one. A source that only needs an extractor to play
still converts, still searches and still lists episodes; it fails at `resolve`,
which is the step §6 runs before recording an install. The viewer gets a sentence
naming what was missing instead of a black screen, and the browse list marks the
listing **Broken** with that reason rather than **Not testable**.

---

### 4.6 A format with no artifact

Every other format in this document is a program to be ported, and §4.1 states
what that costs: "neither gets you the classpath, and the classpath is the
work". Stremio addons are not programs. An addon is an HTTP service with a
published protocol — `/manifest.json` describes it, and
`/{resource}/{type}/{id}.json` serves catalogues, metadata, streams and
subtitles.

So conversion inverts. Instead of translating an artifact, the converter
**generates a client** for the protocol and parameterises it with the addon's
address. Consequences worth stating, because they are unlike the rest of this
document:

- **Nothing is fetched to convert.** Every addon-specific fact comes from the
  manifest that was already read to make the listing.
- **No upstream code is embedded**, so no bundle carries an upstream licence
  and there is no derived work to attribute. `licenses/` is empty by
  construction rather than by omission.
- **One manifest is one listing**, and a _collection_ is the exception. A
  manifest describes one addon, so the "repository" a viewer pastes is usually
  the addon itself. This ecosystem also publishes a person's whole addon list
  as a JSON array of `{ manifest, transportUrl, flags }` descriptors — the
  document a client saves and restores — and that behaves like every other
  format's index: many sources, one URL, each entry carrying its manifest
  inline beside the address it is served from. It is recognised strictly, on
  both a `transportUrl` and a valid inline manifest, because a bare JSON array
  is not a distinctive document and one other adapted format publishes its
  entire extension list as one. Addons in a collection that serve no streams —
  the metadata and subtitle providers a real list carries — are counted and
  dropped rather than refusing the document.
- **The link people copy is not the manifest.** Directories and addon pages
  hand out a link to the _web client_ with the manifest as a parameter, and
  that parameter sits in the URL fragment, where `searchParams` cannot see it.
  The same ecosystem's documentation also tells people to copy a link under
  its own scheme. `candidates` unwraps the first; `detect.ts` rewrites the
  second back to https, so what is fetched is unchanged.
- **Configuration lives in the URL.** An addon that needs a key hands the
  viewer a URL with their settings in a path segment, so a configured addon
  and a plain one differ only in the string pasted. The adapter treats
  everything before `/manifest.json` as an opaque base, parses none of it and
  logs none of it — it may carry a viewer's own account key. An addon
  declaring `configurationRequired` is refused with the instruction to
  configure it first, because installing the unconfigured URL would produce a
  permanently empty source that looks like this client's fault.
- **An addon may require configuration without declaring it, and then the
  status is not the evidence.** Measured on a live addon: `configurable: true`,
  `configurationRequired: false`, no `config[]` at all — and **403 to every
  stream request** against its bare address, with a browser's own user agent as
  readily as with ours, while _any_ configuration segment returns 200. So the
  refusal above never fires, no form can be drawn, and the bundle is turned
  away by a status indistinguishable from an anti-bot wall. Read as one, it
  produced the worst sentence available: the host told the viewer this source
  _"refused an automated request"_ — a story about being blocked, about an
  addon that had simply never been set up, with the one gesture that fixes it
  named nowhere. The adapter therefore records `configurable` and whether the
  pasted address carries a segment at all; the shim treats **401 or 403 while
  unconfigured** as the setup step it is, and says so in words carrying no
  status, because the status is what misled the reader in the first place.
  Whether the addon is configured is asked at request time rather than baked
  in, since a viewer who fills in declared fields configures it without
  changing its address. Being unsure resolves toward silence: an address with
  any path segment is taken as configured, so an addon hosted under a prefix is
  never told to go and set itself up.

#### 4.6.1 Addressed by id, which is what the rest of the system gains

The protocol is keyed on IMDB ids: `tt0944947` for a series and
`tt0944947:1:5` for one episode. The host already holds that id, so this is
the first adapted format that needs **no title matching at all**.

That is not a local convenience. `catalog-matcher.ts` exists because a site
scraper's ids are its own slugs, leaving titles as the only shared key — and
titles are a weak one, which is why a binding carries a confidence and a
trusted threshold. A source declaring `ForeignOrigin.idKinds` is saying it has
a real key, and the host binds it exactly, at full confidence, without a
search. `ConversionRecord.idKinds` carries that fact to the app.

It also changes what verification can mean for such a source. A stream-only
addon publishes `catalogs: []` and answers **every** search with nothing,
however healthy it is — so `verify.ts` asks an id-addressed source about
`DEFAULT_PROBE_IDS` instead of searching it. Running the search gate against
one would fail it at `search` for declining to answer a question it never
claimed to answer, which is exactly the source-level verdict AGENTS.md rule 17
forbids.

#### 4.6.2 What the protocol returns that cannot be played

A stream object names its content in one of several mutually exclusive ways,
and only `url` is an http link. `infoHash` is a torrent — §4.2 already settles
that — `externalUrl` is a link to somebody else's player, and `ytId` needs an
embed this client does not host.

Measured against live addons: one returned **132 of 132** streams as
`infoHash`, another **12 of 12** as `externalUrl`. So this is the common case,
not an edge, and the shim reports it rather than returning an empty list:
"answered with 67 torrent stream(s) and no direct link" names what happened
and what would fix it, where an empty list would have been read as a broken
source. A viewer's own debrid configuration is what turns those into `url`,
and the addon does that itself, in the URL the viewer pasted.

## 5. Converting, and what it may not skip

`convert()` returns **bundle bytes**, never an installed plugin. Those bytes
then travel the ordinary install path in `REPOSITORY.md` §4: opened by the same
archive reader, checked for traversal, verified file-by-file against
`integrity.json`, compared against the declaration the consent screen rendered.

There is deliberately no path from converter output to storage that skips
verification. A converter is a producer of archives, and archives are not
trusted because of who produced them.

### 5.1 The bundle a converter emits

Exactly the layout `REPOSITORY.md` §6 describes, with three requirements:

- `plugin.json` declares `network.hosts` derived from the foreign manifest —
  its base URL, plus any host the foreign metadata names. This is what the
  consent screen shows and what `ctx.http` later enforces.
- `signature.json` is `{"signed": false, "convertedBy": {…}}`. A converted
  bundle has no origin signature and never gains one; absence would be
  ambiguous, and `REPOSITORY.md` §6 requires the file regardless.
- The ZIP must be **deterministic**: entries in sorted order, no timestamps, no
  platform-varying fields. Converting the same input twice produces
  byte-identical output, so a digest is a fact about the input rather than about
  when the conversion ran.
- **Attribution is carried, not invented.** A conversion is a derived work of
  somebody else's program, and the bundle says whose:
  - `author` is the original author, with their own `url` when the foreign
    metadata names one — never the converter.
  - `license` is the **upstream** SPDX identifier where the source states one.
    `NOASSERTION` is reserved for genuine ignorance: it is a statement that we
    did not find the terms, and writing it over a licence the source _did_
    declare is a false claim about someone else's work. An identifier that does
    not fit the schema is dropped rather than corrected — terms that say
    almost what upstream wrote are worse than terms that admit to being unknown.
  - `repository` names where the source lives, so a credit is followable.
  - The upstream licence text, where it was fetched, is carried at
    `licenses/UPSTREAM.txt` and hashed into `integrity.json` like every other
    member, so it cannot be stripped without the integrity check noticing.
  - `signature.json` repeats the source repository and the upstream licence
    beside the conversion record, because that file is what a reviewer reads to
    answer "where did this come from, and whose is it".

  This is the counterpart of §0's rule 9 line, pointing the other way: rule 9
  keeps _their_ sources out of _our_ repository, and this keeps _our_ name off
  _their_ work.

### 5.2 The converted plugin id

`<reverse-dns namespace>.<format>.<sanitised foreign id>`, so that two formats
carrying a same-named source cannot collide, and so a converted plugin is
visibly converted in any log that prints an id. It is written into stored
`SourceBinding`s and therefore may never change for a given input — which is
also why the sanitisation is specified rather than left to each adapter.

---

### 5.3 A setting that points outside the network grant

A converted source's commonest preference _is_ a base URL, so the settings screen
is one text field away from being a way to send a plugin at a host nobody agreed
to. `manifest.network.hosts` is what `ctx.http` enforces (`ABI.md` §2) and it is
the list the consent screen showed (`REPOSITORY.md` §4 step 8).

**The answer is a refusal that names the host**, taken when the viewer sets the
value rather than when a search later returns nothing:

> _Example_ was installed with permission to reach 2 hosts, and
> `elsewhere.invalid` is not one of them. A setting can choose between the hosts
> a plugin declared; it cannot add one. Adding a host means installing a version
> that asks for it, so the permissions screen can show you the difference.

A refusal and not a consent prompt, because widening what a plugin may reach is
an install-time decision with a diff attached (`REPOSITORY.md` §6), and a
settings row is not that: a viewer editing a mirror is not being shown what else
that plugin could then do. The check runs over every string a value carries — a
list of mirrors is a list of hosts — and over both spellings, a whole URL and a
bare hostname. A value that names no host is not a host and passes.

`ctx.http` refuses independently and unchanged. This check is the one that can
explain itself; that one is the one that cannot be bypassed.

Nothing here widens the grant _automatically_, either. The hosts a conversion
declares come from the artifact's own text, so a preference whose alternatives
are written down as string literals — which is nearly all of them — is already
covered, and one whose alternatives are not is refused rather than quietly
added.

---

## 6. Verification before installation

An install from a foreign format is only recorded once the converted bundle has
been **run**. In order, in the ordinary sandbox, with the ordinary per-plugin
network grant:

1. `load` — the module evaluates and self-identifies as its manifest id.
2. `searchCatalog` — returns at least one entry.
3. `listEpisodes` on that entry — returns at least one episode.
4. `resolve` on its first episode — returns at least one `PlaybackSource` whose
   url is https and whose container the host plays.
5. **Something answers at that url.** One resolved stream is fetched, through
   the same proxy plugin traffic uses and only to a host the bundle declared.

Step 5 is not belt and braces. These ecosystems signal failure _by returning a
URL_ — a placeholder host, a bare origin with an empty path — so a module that
has given up is indistinguishable from one that succeeded right up until
something tries to play it. Without the fetch, a check reports green and the
failure surfaces later as a player error on a plugin already marked as working.
A false pass is worse than a failure, because a failure is information.

Several mirrors are tried before the step fails: sources routinely return more
than one and expect the player to fall through them, so a single dead address
is not a verdict. A host with no probe available stops after step 4 and must
report only what it verified.

Any step failing aborts the install: nothing is written, and the host reports
which step failed together with the plugin's own message. A `SourceChangedError`
naming a URL (`ABI.md` §5) is the most useful thing this system produces, and
this is where it surfaces.

A host **may** offer to install without verification, and when it does the
resulting record must carry `verified: false` and say so wherever it says the
plugin is installed. A source that is merely down is a real case; presenting an
unverified install as a verified one is not.

This is the direct answer to the silent-breakage failure mode: an upstream
change becomes a refusal naming a step, instead of a black screen.

---

### 6.1 Checking before installing

The same pass may be run on a listing nobody has chosen, so a browse list can
say which entries work instead of leaving that to be discovered one install at
a time. It converts and runs exactly what an install would and then keeps
nothing — no files, no row. A check that took a shortcut would be reporting on
something other than what pressing Install does.

Four states, and the distinctions between them are the whole point:

| State            | Means                                                          |
| ---------------- | -------------------------------------------------------------- |
| **Unchecked**    | Nobody has run this. The default, and not a failure.           |
| **Works**        | It searched, listed episodes and resolved a stream.            |
| **Broken**       | It ran and failed, with the step and the plugin's own message. |
| **Not testable** | It cannot be installed at all, so there is nothing to learn.   |

**Unchecked is a real answer and must be shown as one.** A host may not infer a
verdict from anything short of running the plugin — not from the listing
parsing, not from its format, not from other listings in the same repository.
`REPOSITORY.md` §5 already forbids presenting a listing as vetted; inventing a
green tick would be the same error wearing a different hat. The viewer resolves
an unchecked row by trying it.

A result is remembered against the listing's **own version string**, so a new
release returns to unchecked rather than inheriting a tick earned by code that
has since been replaced.

Checking is **never automatic**. The requests go to the sources, not to the
host, so checking a repository of two hundred entries means two hundred sites
searched because somebody opened a list. It happens on request, a few at a
time, and stops when asked — keeping whatever it already learned, since those
requests are spent either way. Listings that are not testable are never
requested at all.

## 7. Updates

On demand only. Never on a timer, never in the background — `REPOSITORY.md` §6
applies unchanged, and a client that polls a list of content sources on a
schedule has a network fingerprint its user did not ask for.

An installed converted plugin records `converted: { format, foreignId,
foreignVersion, convertedAt, converterVersion }`. A refresh re-parses the index
through the same adapter and compares `foreignVersion` verbatim.

Two rules specific to conversion:

- The new version is converted **and verified (§6) before** the installed
  bundle is replaced. A broken upstream release must leave the working plugin
  installed, and say that the update failed.
- `converterVersion` changing is itself grounds to offer a re-conversion, since
  a better converter may succeed where an older one refused.

Widening `permissions` or `network.hosts` requires fresh consent, shown as a
diff, exactly as for a native update.

---

## 8. Formats with no adapter

Recorded so the gap is a decision rather than an oversight:

| Format                   | Artifact                                            | What it would take                                                                                 |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Legado                   | JSON rule objects with embedded JavaScript          | A rule interpreter: CSS, XPath and JSONPath selectors plus the `@js:` / `<js>` escape. Novels only |
| Shosetsu                 | `.lua`                                              | A Lua interpreter. Novels only                                                                     |
| Mangayomi (Dart half)    | `.dart` source                                      | A Dart interpreter, for roughly two-thirds of that ecosystem. Its JavaScript half converts (§4.4)  |
| IReader, Echo, Tsundoku  | APK                                                 | §4.1, and none of them are anime                                                                   |
| Kotatsu external sources | A separate Android app exposing a `ContentProvider` | Android-only by construction; no cross-platform form exists                                        |

None of these are blocked on a decision. They are blocked on someone writing
the interpreter, and each is independent of the others.
