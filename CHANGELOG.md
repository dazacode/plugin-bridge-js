# Changelog

**Versioning policy.** Release versions represent meaningful changes to Plugin
Bridge's capabilities, architecture, or guarantees — not compatibility
percentages. Compatibility measurements are evidence reported _with_ a release,
not targets that determine _when_ one is made.

Written down because the pressure runs the other way. A version number that
tracks a compatibility percentage turns every release into an argument for
grinding out one more extension, and this project has twice measured that loop
to exhaustion and deliberately closed it. `v0.1.x` is for fixes to what has
already been promised; a minor bump whose case is "the number went up" is not a
minor bump.

## Unreleased — the reason a format was refused stopped being true

Hayase was `browse-only` on one stated ground: _"extensions in this format
return torrents rather than streams, and Yorozo has no torrent client."_ The
premise expired and the refusal did not, which is its own lesson about a
sentence written once and read as a fact ever after.

Everything it needed was already built for another ecosystem:
`TorrentDescriptor` on the ABI, a resolve answering with descriptors and no
direct link counting as a pass, `TorrentAcquisition` as the host's port, a
companion or desktop host behind it, and per-source consent in front. A row's
info hash travels exactly that path and no other. Nothing in the adapter or
the runtime acquires anything, and must not.

Measured over 77 published extensions from 15 repositories rather than against
the format's documentation, which is why the fixes are classes and not sources:
the whole module body is evaluated inside the first plugin call (37 of 77
failed at load because this ecosystem writes its own address as a class field,
`url = atob("…")`, and `export default new class {…}()` constructs at the
assignment); that body is async, because two of them await at their top level;
`navigator.onLine` is answered; `exclusions` and `resolution` always arrive
with the right type; a hash is read from `hash`, from a magnet's `xt=urn:btih:`
in hex or base32, and from a `link` that is itself a bare hash. A `.torrent`
url is refused by name rather than guessed at.

Repository-local helpers are fetched from the same repository at the same ref
and inlined ahead of the entry module. A specifier resolving outside that
repository is refused: it is a real URL on the same forge, and following it
would let one listing run code from a repository nobody added.

Three capabilities, measured separately on the same 67 extensions: the runtime
shim alone, 8; with repository-local modules, 16; with the AniList id the host
already holds, 24. Reported as measured — an earlier estimate said about 35 and
was wrong, because it counted eleven sources wanting AniDB and TVDB ids this
catalogue has no source of. Those stay refused.

No `CONVERTER_VERSION` bump: the number exists so already-installed rows are
re-converted when the converter improves, and a format that could never be
installed has no such rows.

## Unreleased — the destination is the site's to name, the scheme is not

A family of sources answer an **https** request with a 301 to **http** on
their own host — misconfigured canonical redirects, usually doing nothing but
adding a trailing slash. Measured: `https://…/buscar/a` →
`http://…/buscar/a/`, and `https://…/` → `http://…/index`. Both answer 200
over https when asked directly, so the redirect is not a real move to
cleartext; it is a `Location` built by string-joining a stored base that
predates the site's own certificate.

The relay refused, correctly, and the sources were lost with it. Following
the hop is not an option: a plugin's traffic does not go on the wire in the
clear, ever. So the site's advice about _where_ to go is taken and its advice
about _how_ is not — the target is retried over https, and nothing cleartext
is ever sent.

Narrow on purpose. The request being redirected must be https, the target
must be http, and the host must match exactly — `host` and not `hostname`, so
a redirect that also changes port is a different host and stays refused. A
cross-host downgrade is somebody else's server and is never rewritten. The
upgraded URL is re-checked by the same loop as any other hop and spends a hop
from the same budget, so a site that redirects in a circle still stops.

What it is not: following downgrades, relaxing mixed schemes, rewriting
across hosts, or trying https speculatively anywhere else.

Measured on one catalogue: a source went from `search` with 0 results to
`resolve` with 80 results and 6 episodes. It now fails at video extraction,
against a third-party host, which is a different question.

`docs/compatibility.md` gains the measurement discipline this was found by:
probe the exact request path the tool exercises, not the site's front page —
an estimate built from two homepages predicted two recoveries and one was
real. With it, the two ways the instrument lies: a bare `fetch` follows the
downgrade the relay refuses, and Node's trust store is not a browser's.

## Unreleased — asking for the settings store is not asking for the container

`Injekt` is a dependency-injection container and reaching into a host app's
object graph is out of scope, so every mention of it was refused. But the
ecosystem does not use it as a container. Measured across four repositories,
every single occurrence is one request: **give me my preferences.** It is
written `Injekt.get<Application>().getSharedPreferences("source_$id",
MODE_PRIVATE)` in 21 places and `private val context: Application by
injectLazy()` in 10 more — the second in shared templates, which is how ten
lines of source blocked thirty-one extension directories.

The store was never the missing part. The runtime has owned it all along; what
was missing was the name. `Application` is now a bundle-scope name whose one
supported member is `getSharedPreferences`, and the two spellings converge on
it.

This is not indulgence toward old code. ext-lib 16 **removed**
`getSourcePreferences()` and documents the `Injekt.get<Application>()` form in
its place, so the extensions writing it are the ones that have migrated, and
their share only grows.

The exemption is the whole idiom and not the type. An `Application` reached for
`filesDir`, or a container reached for the host's http client, still refuses by
name — a shim that has never heard of the member would fail inside the sandbox
instead, which is the trade this project does not make. That distinction can
only be drawn at the call: `namedObstacle` is checked leaf-first, and a leaf
sees the token `Injekt` and nothing around it. So the exemption sits beside the
crypto question in `scanInto`, which is there for the same reason.

Measured: on three third-party repositories added without this project in mind,
1 of 37 directories converted and now 8 do. On the 254-directory corpus the
catalogue is unchanged at 69 — this clears a blocker that was never the only
one there — but 36 refusals are gone and `by injectLazy<Application>()` no
longer blocks anything.

`CONVERTER_VERSION` 47, because what an extension converts to has changed.

## Unreleased — an addon that was never set up is not an addon blocking us

A Stremio addon may require configuration without declaring it. Measured on a
live one: `configurable: true`, `configurationRequired: false`, no `config[]`
at all — and 403 to every stream request against its bare address, with a
browser's own user agent as readily as with ours, while any configuration
segment returns 200.

Nothing in this stack could tell that apart from an anti-bot wall, because the
only evidence it looked at was the status. The host's own vocabulary has a
verdict for a 403 and it is **"Blocking access — this source answered, but
refused an automated request"**, so a viewer was given a confident story about
being refused, about an addon that was one paste from working, with the gesture
that would fix it named nowhere. Rule 17's failure mode with the blame pointed
outward instead of inward.

The status is no longer the evidence. `stremio.ts` records `configurable` and
whether the pasted address carries a configuration segment at all; the
generated client treats 401 or 403 **while unconfigured** as the setup step it
is and says so in words containing no status — deliberately, since a number in
the text is what the reader downstream got wrong. It is asked at request time,
so a viewer who fills in declared fields has configured the addon without
changing its address, and an addon that merely _can_ be configured and works on
its defaults is never accused. An address carrying any path segment counts as
configured, so an addon hosted under a prefix is never told to set itself up.

The sibling case was wrong in the opposite direction and is fixed with it: an
adapter refusing an addon that _does_ declare `configurationRequired` produces a
conversion refusal with no failed step, which is the same shape as a translator
gap — so the correct refusal was reported as **"Not yet translatable — a gap on
this side"**, the one verdict this project measures at zero in sixty-nine.

`CONVERTER_VERSION` 46. Both new facts are recorded at conversion time, so an
installed row keeps the old client until it is converted again, and every stored
verdict that said "Blocking access" for this becomes unknown rather than
carrying a pre-fix answer forward.

## v0.4.0 — a source may answer with something this device cannot use

`resolve()` could only say "here is an address" or "I failed". A source that
answered with a torrent had to be reported as one of those, and both were
wrong: it answered, correctly, with media a different device could play.

`TorrentDescriptor` is that third answer. A bundle returns
`{ infoHash, fileIdx?, sources? }` and stops there — whether it can become a
stream is the host's question, the same division that keeps a plugin from
knowing what platform it runs on. Deliberately not a magnet string: a
URL-shaped value no fetch can open would have made every guard, probe and
player downstream learn an exception.

`VerificationResult.torrentCount` and `CheckResult.torrentCount` carry what a
run actually saw, and `ConversionRecord.observedP2p` records it. That is the
fact `behaviorHints.p2p` cannot supply: the most widely installed torrent
addon in this ecosystem declares nothing and returns torrents for every
request, so declaration is advisory and observation is authoritative for the
one thing it covers. `usesP2p` is accordingly renamed `declaredP2p`, because
once the two facts are separate the old name claims the wrong one.

The gate no longer fails a source for answering this way. A resolve that
returns descriptors and no direct link passes, because what stops it playing
is a capability, which is not a property of the source and must not be
reported as one (rule 17).

`p2p` on the manifest stays advisory and stays disclosed. Nothing here
consumes a descriptor; the host does, and that boundary is in the app.

## v0.3.2 — what the manifest was already saying

Three facts a Stremio addon states about itself, which this adapter had been
hardcoding, ignoring, or discovering far too late.

`behaviorHints.adult` reaches `isNsfw`, which was hardcoded `false` — a claim
published on the addon's behalf while the addon was making its own.

`behaviorHints.p2p` reaches a new `usesP2p` on `ForeignOrigin` and
`ConversionRecord`. It is declared at install time, and that is the whole
value: a host that cannot consume peer-to-peer can say so on the row instead
of installing something that fails on its first stream, and a host that can
still owes the viewer the disclosure, because joining a swarm exposes their
address to peers. Nothing here consumes it yet.

`config[]` reaches `SettingDescriptor[]`, so a configurable addon is
configured _in the host_ rather than on its own website. This is possible
because the ecosystem's SDK parses its configuration path segment as JSON
(`getRouter.js`), so the values are applyable and not merely renderable — the
bundle rebuilds that segment from what the viewer set, keyed the way the addon
spelled each field rather than the way this schema had to normalise the id. An
addon that sets nothing gets an untouched address, which matters because one
configured on its own page already carries its settings in the URL.

`password` maps to `text`, and that is a real loss rather than a neutral one:
this manifest schema has no secret type, so a key a viewer types is drawn in
the clear. Worth closing at the schema. Dropping the field instead would make
an addon whose only configuration is its key unconfigurable, which is worse.

## v0.3.1 — a whole addon list in one paste

Three fixes to what v0.3.0 shipped, all of them about the URL a person
actually has in their hand rather than the one the protocol documents.

**Collections.** This ecosystem publishes a person's entire addon list as a
JSON array of `{ manifest, transportUrl, flags }` descriptors — the document a
client saves and restores — and it behaves exactly like every other format's
repository index. Reading it means somebody moving across pastes one URL
instead of one per addon. Recognised strictly, on both a `transportUrl` and a
valid inline manifest, because a bare array is not a distinctive document and
another adapted format publishes its whole extension list as one. Stream-less
entries, which every real list carries, are counted and dropped rather than
taken as grounds to refuse the list.

**Install links.** The addon directories and the addons' own pages hand out a
link to the _web client_ with the manifest as a parameter, not the manifest —
and the parameter sits in the URL _fragment_, so `searchParams` cannot see it
and a reader who checks only there concludes there is nothing to unwrap. Those
are now unwrapped, raw or percent-encoded, matched by route shape rather than
by hostname so a self-hosted client works the same.

**The install scheme.** The same ecosystem's documentation tells people to
copy a link under its own scheme, formed by swapping `https` for it and
changing nothing else. Pasting one used to fail with "a repository must be
https" — true about the scheme, useless as advice. It is rewritten back, so
what is fetched is still https. Fixing that surfaced a second bug:
`detectionCandidates` normalised the paste for the adapters and then handed
the _raw_ string to the native resolver, which refused it before any adapter
was asked. Both halves now read the same URL.

## v0.3.0 — a seventh ecosystem, and the first with nothing to translate

Six adapters port programs. `FOREIGN.md` §4.1 states the cost plainly: an
extension's artifact ships its own classes and nothing else, and "neither gets
you the classpath, and the classpath is the work."

Stremio addons are not programs. An addon is an HTTP service with a published
protocol, so `stremio` converts by **generating a client** for that protocol
rather than porting anything: nothing is fetched to convert, no upstream code
is embedded, no bundle carries an upstream licence, and one generated file
serves every addon ever installed. One manifest is one listing, and an addon
configured on its own page differs only in the URL pasted — the adapter treats
everything before `/manifest.json` as an opaque base it never parses or logs,
because it may carry a viewer's own account key.

**The format also brings the first real key.** The protocol is addressed by
IMDB id (`tt0944947`, and `tt0944947:1:5` for an episode), so a source in it
needs no title matching at all. That is new to this project, not just to this
adapter: every other ecosystem is a site scraper whose ids are its own slugs,
which is why bindings carry a confidence and a trusted threshold in the first
place. `ForeignOrigin.idKinds` and `ConversionRecord.idKinds` carry the claim,
and a host holding the id binds such a source exactly, without a search.

`verify.ts` follows. A stream-only addon publishes `catalogs: []` and answers
every search with nothing however healthy it is, so an id-addressed source is
asked about `DEFAULT_PROBE_IDS` instead of searched — several, because a niche
source legitimately lacks one title and that is not a fault. Where several are
tried, the failure reported is the one that got _furthest_, since a probe that
reached `resolve` describes the source while a later one failing at `episodes`
describes the title.

What the protocol returns is mostly unplayable here, and that is now said out
loud. Measured live: one addon returned 132 of 132 streams as `infoHash`,
another 12 of 12 as `externalUrl`. Torrents were already settled by §4.2, but
returning an empty list for them reported a working addon as a broken one, so
the shim names the count and the remedy instead — configuring the addon with a
debrid account is what turns those into direct links.

`keepMediums` and the plugins screen's badge now agree on multi-medium
listings, and `wildcardFor` no longer widens GitHub user content. Both were
carried in from the v0.2.1 work.

## v0.2.1 — a declared set is not a declared exclusion

Fixes to what v0.2.0 promised, found on a live install rather than in a
measurement run.

v0.2.0 gave every listing a classified `mediaKind` and said a consumer could
route by it. Half these ecosystems declare a _set_, though — `movies/shows/anime`
is the most common `type` in the measured Sora library, and Cloudstream's
`tvTypes` is an array — and collapsing a set to its first mention turned a
superset into an exclusion. KissAsian, a Korean/Chinese/Japanese/Thai drama
source, declares `movies/shows/anime`, filed under `anime`, and was then never
asked for a live-action title: the viewer's only installed source reported "No
installed plugin serves that kind of media" for the content it actually serves.

`ForeignOrigin` and `ConversionRecord` gain `mediaKinds`, the full declared
set, with `mediaKind` staying its first element and the medium a row is filed
under. `declaredMediums()` reads the pair, falling back to `[mediaKind]` and
then to the empty list, so an unclassified plugin is still asked rather than
excluded. `keepMediums()` keeps a listing with any supported medium instead of
only a supported _primary_. Sora's classifier matches live-action words
explicitly (`movies`, `shows`, `series`, `dramas`, `tv`, `films`) rather than
inferring them from the absence of the other three, because a declaration
naming both anime and shows has to produce both.

Separately, a Sora listing no longer declares `scriptUrl`'s host among its
granted hosts. That URL is where the module is downloaded from, fetched once
by the host before any sandbox exists; a converted bundle has no business
fetching its own source at runtime (`mangayomi.ts` already drops
`sourceCodeUrl` for this reason). Every module published on GitHub raw was
being granted a standing read of `raw.githubusercontent.com` for a request
none of them makes — and `githubusercontent.com` joins `SHARED_SUFFIXES`, so
the wildcard sibling that came with it, `*.githubusercontent.com`, is no
longer granted to anything. That one covered every file GitHub serves for
every public repository.

`CONVERTER_VERSION` 44 → 45: both facts are recorded at conversion time, so
already-installed rows need a re-conversion to pick them up.

## v0.2.0 — a second medium, not just a second ecosystem

`ForeignMedium` was `'anime' | 'manga' | 'novel' | 'other'`, and the only
consumer-facing filter, `keepAnimeOnly()`, dropped everything but `'anime'`
unconditionally. That was a real capability gap, not a fix: Cloudstream is a
live-action film/TV ecosystem, already fully integrated, and every one of its
listings was being discarded by policy rather than by anything about the
listings themselves.

`ForeignMedium` gains `'live-action'`. `keepAnimeOnly()` is now
`keepMediums()`, filtering against an exported `SUPPORTED_MEDIUMS` set
(`anime`, `live-action`) instead of a single hardcoded kind, and
`refusalFor()`'s messaging follows. Cloudstream's classifier maps its `movie`/
`tv` types to `'live-action'` instead of `'other'`; Sora's gains real
manga/novel/live-action text matching instead of a two-way anime/manga guess.
`ConversionRecord` carries the classified `mediaKind` through to the host
catalogue, so a consumer can route a listing by medium without re-deriving it.

The other four adapters (Aniyomi, Hayase, LNReader, Mangayomi) are unchanged
in behavior — genuinely single-medium ecosystems gain nothing from a wider
enum they were never going to produce values for.

## v0.1.3 — fixes to what v0.1.0 promised

No new capability, no new ecosystem, no architectural change.

### v0.1.2's fix left one shape uncovered

Disambiguating a colliding id by the listing's own script URL does nothing for
a library entry published twice, byte for byte — same declared name, same
script — because there is then nothing about the second one to key an id on.
Found the same way as v0.1.2's fix: browser-driving the production deployment
against the same live library still threw `each_key_duplicate`, one pair
narrower. The second copy is now dropped rather than given an id indistinguishable
from the first — a true duplicate has no other listing to prefer over it.

## v0.1.2 — fixes to what v0.1.0 promised

No new capability, no new ecosystem, no architectural change.

### Two modules with the same declared name collided into one id

A library can list one site twice — two quality tiers, or a plain duplicate
entry — and the Sora adapter built a listing's id from its declared name
alone. Two listings sharing a name shared an id, which is also the key the
client renders its plugin list by, so the whole list failed to render, not
just the pair. Found by browser-driving the production deployment: the plugins
page threw `each_key_duplicate` and a listing could not be found by name.

Colliding ids are now rewritten from each listing's own script URL rather than
its position in the list, so a later fetch that returns the same modules in a
different order cannot flip which listing gets which id. Every non-colliding
name — the overwhelming majority — keeps exactly the id it already had, since
that id is written into a stored `SourceBinding` and moving it would orphan an
install.

## v0.1.1 — fixes to what v0.1.0 promised

No new capability, no new ecosystem, no architectural change. Every entry below
is a bug fix or a hardening of behaviour v0.1.0 already claimed, which is what
the policy above means by a patch release.

### A whole ecosystem's modules could not load

Sora modules are written for a runtime that evaluates them as a **classic
script**, where top-level `this` is the global. Spliced into an ES module they
get strict mode and no receiver, so a bundled UMD library whose header reads
`root.CryptoJS = factory()` threw before a single request was made. The wrapper
now calls with `globalThis`, and it has to be the real one: the UMD dance
assigns onto the receiver and then reads the library back as a _free variable_,
so a stand-in object takes the write and loses the read. Measured against a live
library, five modules of fifty-one failed on this one cause.

### A caption track pointing at a 404, on every episode

A module returning the string `"none"` for a stream with no subtitles had it
resolved against the source's base into `https://…/none`, built with
`isDefault: true`, and fetched — which a viewer reads as subtitles being broken.
The value is now judged before it is made absolute, in the shared guards rather
than in each adapter's copy. `CONVERTER_VERSION` moves 43 → 44 so the fix
reaches bundles already installed; those rows raise a reconversion notice.

### Timeouts, and where the ceiling lives

`AbortSignal.timeout` was built inside the redirect loop, so the real ceiling was
`MAX_REDIRECTS + 1` times the number the file stated. It is one signal for the
whole walk now. The per-call budget moves 30s → 90s, because one plugin call is
several round trips and the host allows 45s for any single one of them; the
relay's own default moves 20s → 45s, against a population measured answering the
same page in 2.8s, 11.4s, 4.4s, 3.5s and 6.0s — a 20s cap sat inside that spread
and filed working sites as gone on a coin toss. A timeout now sets `isTimeout` on
`NetworkFailure`, so a host stops reporting it as the page having changed.

### Two sentences about somebody else's repository, both of them false

`api.github.com` allows 60 requests an hour unauthenticated, counted per address
— and in a browser that address is the viewer's. When it ran out, every ref
failed identically and the conversion reported that _the source could not be
found in the repository it is built from_. `TreeError` now carries `rateLimited`
and the message says what actually happened and that it is temporary.

The catalogue harness had the same shape: three capabilities it never passed —
`listFiles`, `createWorker`, `fetcher` — produced three plausible verdicts about
the catalogue under test, each hiding the next. It now proves its own
capabilities _by use_ before it judges anything, and refuses to write a report at
all if it cannot.

### Toolchain

The bun pin moves 1.3.14 → 1.4.2, with the generated artefact regenerated and
committed beside it so the two never disagree in history. The diff is six
characters. The pin moved because the generated-artefact gate was silently not
running on any 1.4 machine, and a gate that is quietly skipped is worth less than
one that fails.

### API surface

Additive only; nothing removed, nothing changed shape. `TreeError.rateLimited`,
an optional `options.timeoutMs` on the relay for a caller whose ceiling is
genuinely different, and `verifyOptionsFor` in the host's catalogue module —
extracted so the new CLI preflight and `checkListing` cannot assemble different
options and prove different things.

### No compatibility figures are attached to this release

The classic-script fix emptied the `load` column for five modules, and re-driven
afterwards every one of them stopped somewhere in its own source. The headline it
was measured against did not move. A column that empties is a reclassification,
not a compatibility gain — and per the policy above, it would not be a reason for
a release either way.

## v0.1.0 — the first public architecture milestone

**This is not a stability release.** The API is not stable, the network
boundaries are not decided, and the compatibility numbers below are a
measurement of one day against live sources that change without notice. What
this tag marks is that the central architectural claim is now backed by
evidence rather than intention.

### What is proven — and what is not

**v0.1.0 demonstrates that Plugin Bridge is not Aniyomi-specific. It does not
demonstrate that the common abstraction is final.** Two independent ecosystems
through a frozen core falsifies the first concern. A third genuinely different
ecosystem is what would begin testing the second, and the remaining named
formats are `browse-only` for reasons of their own — so a third test means
writing a new adapter, not running an existing one.

The order mattered and is worth repeating on any future ecosystem: the second
was measured against a **frozen** core _before_ anything was allowed to
generalise. Had the core been reshaped first, every number after it would have
been unfalsifiable — an abstraction reshaped to fit and an abstraction that
already fit look identical once the work is done.

**Two unrelated plugin ecosystems reach the same ABI through the same host.**
One is written in Kotlin for Android, one in JavaScript for iOS and macOS. The
second was measured with `packages/core` and `packages/host` **frozen** — every
change it needed was in its own adapter, and it never touches the Kotlin
front-end at all.

```text
Kotlin ecosystem  ──→ its adapter ──┐
                                    ├──→ core ──→ common ABI ──→ host
JavaScript ecosystem ─→ its adapter ┘
```

Also in this tag: `core` no longer imports a single adapter — the adapters
package owns the list and detection is told which to try; `host` is split into
the portable port and its Node implementation; and the reference client consumes
these packages instead of carrying its own copy of the engine.

### The numbers, stage by stage

Every row names the stage it measures. Two of these used to be quoted
interchangeably and they are not the same question.

| Stage                                                | Kotlin ecosystem | JavaScript ecosystem |
| ---------------------------------------------------- | ---------------- | -------------------- |
| Listings measured                                    | 254              | 69 (57 anime)        |
| **Convert** — the translator produces a valid module | **69**           | **57**               |
| **Load and run** — it imports and answers            | **69**           | **57**               |
| Reach content — `search`/`browse` returns rows       | 23               | 54                   |
| List episodes                                        | 14               | 51                   |
| Return a stream URL                                  | 6                | 39                   |
| **Verified playable** — that URL answers with media  | **3**            | **18**               |

**A returned URL is a claim, not playback.** Each is range-requested in the same
call that resolved it, and the response is checked for a media content type or
an `#EXTM3U` header. Verifying from a saved file instead measures how long a
signed token lived — doing that reported six playable streams for the first
ecosystem where three play.

### Why doesn't everything work?

Because four different things fail and only one of them is this software.
**Conversion failure ≠ runtime failure ≠ dead source ≠ security boundary**, and
collapsing them is how "supports Aniyomi" comes to mean nothing.

Classifying every one of the 69 that convert and load, driven live:

|                                                                 |       |
| --------------------------------------------------------------- | ----- |
| Source or site drift — the markup the extension reads is gone   | 26    |
| Anti-bot, or a token or IP-bound CDN                            | 20    |
| Dead, unreachable, or serving no https                          | 14    |
| Player built in script — **refused on purpose**, see `adr/0005` | 2     |
| **A runtime or converter bug of ours**                          | **0** |
| **A missing safe portable capability**                          | **0** |

The commonest failure is an extension that translates perfectly and then reads a
page its author last saw a year ago. The second is a source that has decided it
does not serve programs. Neither is fixed by more translator work, which is why
the compatibility loop is closed rather than continuing.

### Known limitations

- **Anti-bot challenges are not solved**, and whether they ever should be is a
  question for a person rather than a runtime (`adr/0005`).
- **Site-side JavaScript is refused.** Sources that build their player element in
  script therefore cannot be read, and that is a decision, not a gap.
- **A local HTTP server is refused permanently** (`adr/0006`); the ABI replaces
  it declaratively.
- **The cookie jar is constrained by design** — per plugin, per already-granted
  host, in memory, never readable by plugin code — so an extension that reads its
  own jar stays refused.
- **`contract/` still reads as the reference client's.** A contributor arriving
  cold should not need to know that client to read a normative spec.
- Two of the six named ecosystems convert. The rest are `browse-only` for
  reasons recorded per format.

### How these numbers were made trustworthy

Four rules, each of which exists because it was broken first, and each enforced
in the measurement harness rather than remembered:

1. **Validate against the ABI contract; never infer a field from a returned
   object.** A results field read as `video` where the driver returns `streams`
   once reported every known-good source as broken.
2. **A returned stream URL is a claim.** Guessing a search entry's id as `id`
   where the contract says `sourceMediaId` put three stringified objects into a
   results table as successes.
3. **Verify ephemeral media at resolve time**, never from a stored result.
4. **A run never overwrites the last trustworthy dataset** until it passes its
   own validation. A filter bug once replaced a 57-module campaign with one row.
