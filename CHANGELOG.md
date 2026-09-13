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
