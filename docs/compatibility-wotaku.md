# The wotaku pass: ten ecosystems at once

`compatibility.md` describes what a translation is, and `compatibility-aniyomi.md`
and `compatibility-sora.md` each take one ecosystem apart. This page is the
different shape: **ten ecosystems added in one pass**, chosen from a public
catalogue rather than one at a time, and what that changes about the work.

The catalogue is the useful part. Adding an ecosystem has always been a
judgement call made from a sample somebody happened to see; taking a published
list instead means the population is fixed before the first line is written, and
"most of this refused" stops being surprising and starts being a number.

## What was taken, and what it was taken from

A community wiki indexes extension repositories for nineteen client
applications. Sixteen of those had repositories to reach — 80 in total, written
in six implementation languages: Kotlin, TypeScript, JavaScript, Dart, Lua and
Rust.

Ten of the sixteen had no adapter here. That is the whole selection: **every
ecosystem the catalogue names that this build could not already read.**

| Ecosystem | Language                  | Serves             | Tier        | Outcome                                          |
| --------- | ------------------------- | ------------------ | ----------- | ------------------------------------------------ |
| Kotatsu   | Kotlin (parser in-client) | manga              | browse-only | metadata only, nothing to translate              |
| Aidoku    | Rust → WebAssembly        | manga              | browse-only | needs a host surface before anything loads       |
| Shosetsu  | Lua                       | novel              | browse-only | no Lua, and nowhere to show a novel              |
| IReader   | Kotlin                    | manga, novel       | convert     | reads the same base class as the sibling formats |
| Echo      | Kotlin                    | anime, live-action | convert     | APK extensions, addressed through releases       |
| Tsundoku  | Kotlin                    | novel              | convert     | convertible, refused by medium                   |
| Paperback | JavaScript                | manga              | convert     | published as a toolchain bundle                  |
| Suwatte   | TypeScript                | manga              | convert     | published as a transpiled bundle                 |
| Mana      | JavaScript                | manga              | convert     | published as a bundled module                    |
| Seanime   | JavaScript                | anime, manga       | convert     | manifest names its own payload                   |

## The three that do not convert, and why the sentence matters

A browse-only tier is only honest if it says which of the three possible reasons
applies, because they are three different jobs:

- **Kotatsu** publishes no code. Its index is parser _metadata_ — a name, a
  language, a base address — and the parser behind each name is compiled into
  the client. There is nothing to download, so no translator would help.
- **Aidoku** publishes code, but in the one artifact shape this build cannot
  host. An `.aix` is a WebAssembly module, which is the most promising of the
  three — a browser runs wasm already — but the module imports `aidoku-rs`'s own
  surface, and supplying that is a runtime, not a shim.
- **Shosetsu** publishes Lua, and every listing is a novel. Two refusals at once,
  and the medium is checked first, because "nowhere to show it" is the more
  useful sentence of the two.

## What the convertible seven cost

Four of the seven publish a _bundle_ rather than source, which is the cheap
shape: the ecosystem's own toolchain has already flattened the modules, and the
conversion is a host surface plus a manifest. That is exactly what the Nuvio
adapter does and it was reused rather than reinvented.

The surface is not small, and a census was taken before any of it was written
rather than discovered one failing source at a time. Across the Paperback
corpus the single global these bundles are handed is called at these rates:

| member                                | call sites |
| ------------------------------------- | ---------- |
| `Application.Selector`                | 1295       |
| `Application.setState`                | 1267       |
| `Application.getState`                | 959        |
| `Application.arrayBufferToUTF8String` | 925        |
| `Application.scheduleRequest`         | 906        |
| `Application.decodeHTMLEntities`      | 762        |
| `Application.getDefaultUserAgent`     | 355        |
| `Application.SelectorRegistry`        | 174        |
| `Application.sleep`                   | 104        |
| `Application.registerInterceptor`     | 83         |
| `Application.unregisterInterceptor`   | 79         |

The tail is another twenty members, and the shape of that table is the argument
for the census: the top eight cover essentially every module, and a source that
meets a sixteenth member fails by name instead of returning something empty that
reads as a page with nothing on it.

## The three Kotlin siblings

IReader, Echo and Tsundoku are the same base-class shape as the two Kotlin
formats already supported, which is the entire reason they are in the
convertible column. A Kotlin extension is a _subclass_: what makes it work lives
in the class it extends, and that class is the same one two adapters already
supply a driver for. The work is member aliases, not a second translator.

The honest residue is named per listing — an IReader JavaScript source handed to
the Kotlin front-end, an Echo row that is an APK, a Tsundoku listing whose medium
nothing can show — rather than folded into a format-wide "not yet".

## What the corpus produced

Parsing was measured against the clones rather than the fixtures, with
`scripts/wotaku-catalogue.ts`. It reports a repository with no index on disk as
`no-index` rather than as a failure, because a shallow clone of a source
repository genuinely carries none:

| Ecosystem | Repositories | With an index | Listings |
| --------- | ------------ | ------------- | -------- |
| Kotatsu   | 3            | 1             | 5984     |
| Seanime   | 6            | 6             | 305      |
| Shosetsu  | 5            | 5             | 174      |
| Paperback | 21           | 1             | 68       |
| Aidoku    | 7            | 2             | 32       |
| Mana      | 7            | 1             | 1        |

**6,564 listings, and not one refusal.** The refusal column was the point of
running it: a parser that accepts its own fixture and rejects the
twenty-thousand-row reality behind it is a parser that proved nothing.

Conversion is measured separately and further away. IReader and Tsundoku were
counted over their real trees — 53 of 187 IReader extension directories and 41
of 174 Tsundoku ones convert, the rest refused by name — and none of those trees
is reachable from the catalogue link, because both ecosystems publish their index
as a build artifact. Echo converts nothing by design; its extensions are APKs.

## What this pass does not claim

- **A converted bundle is not a working source.** Nothing here has been run
  against a live site; `compatibility.md` keeps those two numbers apart and so
  does this page.
- **Ten ecosystems are not ten times the catalogue.** This is the failure mode
  `compatibility.md` already records, and it is worse here because a community
  wiki's list is a list of _overlapping_ sources. Two adapters reading the same
  site twice is two adapters, not two sources.
- **Four of the ten add no listings at all** on the repositories the catalogue
  links to, because those links are to _source_ repositories and the published
  index lives on a build branch. A repository with no index is reported as
  `no-index` by the harness rather than counted as a failure, and the two numbers
  are kept apart for the same reason the check states are.
