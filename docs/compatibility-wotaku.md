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

## Closing the gaps the pass left

The pass above stopped at four named gaps. This is what became of each, and
what a live run of two of the formats found besides.

### Mana sources published as a tree: 0 → 111 of 139 load

Every Mana source in the corpus is published unbuilt, as a TypeScript entry
that extends a template a directory or two away. The source path read the
entry file alone and refused all 139 for `relativeModuleImports`.

Three steps, each measured before the next:

1. **The module walk.** The relative-import walker the Hayase adapter already
   had is now shared (`core/repository-modules.ts`). Mana links the closure in
   dependency order — each module wrapped and returning its exports, re-exports
   and `export * from` included — and refuses by name a module that cannot be
   read, climbs out of the repository, closes a cycle or lies past the bound.
2. **The three packages the closures import.** `cheerio` (116 closures),
   `html-entities` (80) and `crypto-js` (52) are answered by compatible
   subsets over the runtime's own parser and digests (`shims/cheerio.ts`,
   `shims/js-libraries.ts`), kept to the members the corpus calls. Every keyed
   `crypto-js` operation — AES, the HMACs — throws naming itself: a key stays
   on the host's asynchronous WebCrypto (`ABI.md` §2), so a source loads and
   only a protected chapter fails, by name.
3. **The published client.** The search-form builders, the `Body` builders,
   `HttpHeaders`, the numbered `HttpMethod`, `RateLimit`, `ObjectStore`, a
   `SearchRequest` for `search`, and interceptors that are awaited and handed
   the enum — each a live failure on the trees, fixed as the published
   `@mana-app/types` defines it.

Each step exposed TypeScript the stripper read wrongly — twenty-three
constructs in all, from a union member after a comment to a parameter
property that must still assign its field. Each converted and then failed to
parse or answered differently; each is fixed and pinned by a test that runs
the stripped code.

Measured with `bun scripts/wotaku-catalogue.ts`, which converts and loads every
Mana entry file in the clones:

|                                     | before | after |
| ----------------------------------- | ------ | ----- |
| Mana entry files (declare `Target`) | 139    | 139   |
| refused `relativeModuleImports`     | 139    | 0     |
| refused `packageImports`            | 0      | 28    |
| convert                             | 0      | 111   |
| convert and load                    | 0      | 111   |

The 28 import `simple-url` (26), `moment` (2) or `crypto-es` (1), refused by
name.

Then live, each listing driven through search, its list, its pages and a fetch
of a page image's bytes (real addresses on the command line only). _Works_
means the image bytes arrived and were an image:

|                                                    | listings | convert | load | search | list | pages | image bytes |
| -------------------------------------------------- | -------- | ------- | ---- | ------ | ---- | ----- | ----------- |
| Source trees from the clones, before               | 139      | 0       | 0    | 0      | 0    | 0     | 0           |
| Source trees from the clones, after                | 139      | 111     | 111  | 42     | 28   | 27    | 26          |
| Built bundles from three live repositories, before | 21       | 21      | 21   | 11     | 11   | 11    | 6           |
| Built bundles from three live repositories, after  | 21       | 21      | 21   | 13     | 13   | 13    | 12          |

What stops the rest after load is mostly the sites': a Cloudflare challenge, a
search that finds nothing for the harness's probe title, a page that is gone,
a server that wants settings only a viewer can give. Ten novel sources list no
chapters, because a book source answers a different method.

### Image transport: the source's own request path, then level 3

A Mana source does not hand the app image URLs; it hands it a client
(`getPageTransport`, `getCoverTransport`) whose interceptors add a Referer or
rewrite the address. The shim now runs that client for each page — and once
per cover host — with the image send intercepted: what it would have sent
becomes the page's address and headers. A client that reads the image's own
response refuses the chapter by name. Paperback's registered interceptors run
the same way for each page.

Page headers were already in the ABI (§8.3). Cover headers were not, and the
contract's owner decided them: `ABI.md` §9.1, API level 3, adds
`posterImageHeaders`, `imageHeadersByHost` and `headersByHost`, which the Mana
cover path and the Suwatte `imageReferer` now emit.

### A number: level 3

`ABI.md` §9.2 adds `type: 'number'`, decided the same way. The Suwatte source
with a `UIStepper` converts with it — and had in fact lost every setting, to
ids written as module constants that parsed as nothing; those are resolved
now. For a host below level 3 a stepper whose values fit a select's 64 is drawn
as one; one that does not is refused by name.

### Seanime: the AniList id, and unnumbered episodes

- A torrent provider is now declared addressed by `anilist` (`ExternalIdKind`).
  Seanime's `Media.id` is an AniList id, and a host that holds one already
  hands an id-addressed source `anilist:<id>|<title>`; the shim reads it into
  `media.id`. A host that binds by title still gets `0`, as before. The host is
  asked for nothing new.
- An episode with no number is placed between its numbered neighbours, with
  the rule the Mangayomi shim already used, instead of by position, which could
  land on a number another row held.

### What a live run of Seanime and Suwatte found

Converting is not running, so both formats were run against their live
repositories with the catalogue harness (real addresses on the command line
only). Each failure below converted, loaded or not, and failed on something
the host hands a provider that this build did not:

- **Seanime**: `LoadDoc`/`Doc` (the host's goquery document API, 81 call sites
  in the corpus), `$getUserPreference` (67), `$store` (71). All three are now
  supplied — the document API over the shared parser, following goquery where
  it and jsoup disagree, and preferences from the manifest's `userConfig` as
  manifest settings. A payload whose file is `.ts` is stripped whatever the
  manifest says.
- **Suwatte**: what a repository serves is the toolchain's built catalogue
  (`sources.json`, `catalogVersion` 2, one `.stt` bundle per row), which the
  adapter did not model and Mana's parser claimed, answering zero listings.
  It is now read as Suwatte, Mana's positive match requires its own
  `environment`, and a pasted repository link also asks the repository's
  Pages site. Bundles load with the same boot context the Mana bundle path
  uses, and the image Referer a source's configuration declares travels on its
  pages.
- **The headless host** threw `Buffer is not defined` on any bundle that read
  `globalThis.Headers`, because Node defines it lazily over a client that needs
  the `Buffer` the isolate deletes. Those classes are now pinned before the
  sealing. No browser was affected.

| Live, against the repository as published  | before                                                      | after                     |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------- |
| Suwatte catalogue, detected as             | Mana, 0 listings                                            | Suwatte, 120 listings     |
| Suwatte repository link                    | not found                                                   | 120 listings              |
| Suwatte, first six checked                 | —                                                           | 1 works; 5 fail past load |
| Seanime, five listings that failed by name | 0 work, 5 fail at load/search on a missing global or a type | 1 works, 5 load           |
| Seanime, a second marketplace's first six  | 1 works                                                     | 2 work                    |

What still fails after load is the site's or the probe's, and is reported as
such: a provider that needs its own local helper process, a search that
answers nothing for the harness's title, a CDN that refuses the probe's own
request shape while answering the same request without it.
