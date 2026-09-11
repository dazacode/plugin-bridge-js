# Changelog

## v0.1.0 — the first public architecture milestone

**This is not a stability release.** The API is not stable, the network
boundaries are not decided, and the compatibility numbers below are a
measurement of one day against live sources that change without notice. What
this tag marks is that the central architectural claim is now backed by
evidence rather than intention.

### What is proven

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
