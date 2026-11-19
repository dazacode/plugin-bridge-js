# Taking an extension repository end to end — the method, and the patterns it found

This is the playbook from taking two whole published repositories of the
Kotlin family through to a viewer — a Mihon-family manga repository and an
Aniyomi-family anime repository, in November 2026 — written so the next
repository costs less. Rule 9 applies: repositories are described, not named,
and no content source is named. The numbers are in
[`measurements.md`](measurements.md); this file is the method and the
reusable lessons.

"End to end" means the whole path a viewer takes, checked live:

| Medium | Path                                                                |
| ------ | ------------------------------------------------------------------- |
| manga  | install → search → chapter list → page list → page image bytes load |
| anime  | install → search → episode list → video list → stream's first bytes |

and then the same thing done by hand in the reference web client: the
repository added, a source installed through the settings screen, searched,
an item opened, a chapter read in the reader or an episode played.

## The method

1. **Baseline first, whole catalogue.** `catalogue <index-url> --json … --why`
   over every listing, before touching anything. Keep the JSON; every later
   run is diffed against it. Set `GITHUB_TOKEN` (for example
   `GITHUB_TOKEN=$(gh auth token)`): the source tree is read through the code
   host's API, and sixty unauthenticated requests an hour run out by lunch
   when two people are re-checking from one address.
2. **Cluster, then rank by what a fix unblocks.** Count listings per obstacle,
   and separately the listings for which an obstacle is the _sole_ blocker —
   that second number is what a fix is worth. Do the same for converted
   listings that failed live, by stage and by message with urls and numbers
   masked out.
3. **Read the upstream source before deciding anything.** Clone the source
   repository sparsely (`git sparse-checkout` without `res/` and images is
   about 45 MB). A cluster is usually one upstream construct: find it, read
   its real definition, port that.
4. **Fix generally, never per extension.** Each fix is a construct, a runtime
   member or a driver behaviour, with a spec in the existing style, and it has
   to keep the whole suite green.
5. **Prove behaviour, not translation.** A member that translates is not one
   that works. Run the emitted code against the real runtime on the inputs
   the Kotlin is fed, and compare with what the Kotlin produces. Four of the
   bugs below compiled cleanly and returned the wrong value.
6. **`--only` for the loop, the whole catalogue for the verdict.** A fix is
   tried on the listings it was written for in a minute
   (`catalogue … --only "name one,name two" --fresh`), and then measured over
   everything — because the whole run is what finds the regression. One fix
   here gained 26 listings and cost 92, and only the full diff showed it.
7. **Then the client, by hand or headless.** The catalogue proves the engine;
   only the client proves the reader, the player, the relay and the install
   flow. A headless Chrome script driving the real screens is enough and is
   repeatable.

## Patterns: what the upstream code does, and what the translator now does

Each entry is the construct, the translation, and how to recognise it in
another repository.

### Upstream API generations

- **A request kind on every request.** The current manga core takes a
  `Fetch` on every request helper — `client.get(url, Fetch.DOCUMENT)`,
  `Fetch.XHR.from(page)`, `builder.fetch(Fetch.XHR)` — and its base class
  turns it into the headers a browser sends for that kind of request (fetch
  metadata, client hints, `Accept`, `Priority`, `Origin`, a trimmed
  `Referer`). Carried as two request tags, as upstream carries them, and
  turned into headers at the end of the interceptor chain. _Recognise it by_
  one capitalised receiver refused in nearly every listing at once: when a
  catalogue drops to zero overnight, the shared core changed.
- **Final members on a repository's own base class.** `KeiSource` (manga)
  and `AniSource` (anime) make `client`, `headersBuilder`, `imageRequest` and
  the play path final and route them to abstract members the extension
  writes (`getImageRequest`, `fetchMangaUpdate`, `fetchVideoList` …). The
  driver has to run the base class's protocol, not the plain one, or search
  works and everything after it is silently empty. _Recognise it by_ a base
  class between the extension and `HttpSource`, and overrides of members the
  plain API does not have.
- **Base members templates call through `super`.** `super.getImageRequest()`
  and `super.getMangasByUrl()` were missing from the driver and refused about
  280 listings between them. _Recognise it by_ a `super.` refusal concentrated
  in one theme directory.
- **Host-drawn members are not safe to call.** `getFilterList` may be refused
  or partly translated without blocking a listing, because nothing used to
  call it. A search does need the source's default filters — sources read
  their sort with `filters.firstInstance<…>()`, which throws on an empty list —
  but calling it must fall back to no filters where it cannot be built.
- **Fire-and-forget calls.** `client.newCall(r).enqueue(callback)` reports a
  view count beside the page a template just read. Start it, do not await
  it, report to the callback.

### Kotlin semantics that compiled and were wrong

- **A positional argument after a named one** goes in its own index:
  `f(e, bold = false, true)` is `f(e, false, true)`. Counting positionals put
  the `true` over the `false`.
- **Property and function namespaces are separate.** `val mangaLang` beside
  `fun Element.mangaLang()`, and `private val isLocked` beside
  `fun isLocked()`, are two members; a call must be resolved by signature on
  any receiver, or it reads the property. _Recognise it by_
  `this.x is not a function` on a name that is also a field.
- **A class name as a receiver is static.** `Character.isLetterOrDigit(c)`
  inside `fun Char?.isLetterOrDigit()` is Java's static, not the file's
  extension; read as the extension it recursed forever. A class name reaches
  an extension only through its `Companion`.
- **`?.` on a decode.** `data?.parseAs<T>()` decodes nothing when `data` is
  null; dropping the `?.` handed null to the parser.
- **A bare `apply { … }`** is the receiver form on the implicit receiver —
  how a builder's members are written: `fun add(x) = apply { … }`.
- **`list[i] += x`** is `set(i, get(i) + x)` with receiver and key read once.
- **A `for` over a map** walks its entries; decoded JSON maps are plain
  objects here.
- **A template's fetching member** must be awaited from a subclass, through
  `super.x()` and when called bare.
- **Annotation strings are Kotlin literals.** `@SerialName("\$t")` names the
  key `$t` — the one a common blog platform's JSON feed keys its text by.
- **Reified type arguments occupy a slot** when an overloaded name is
  dispatched.

### Library semantics

- **okhttp.** `addPathSegments("search/")` is `/search/` — the empty trailing
  segment is kept, and a site that serves the slashed path answers 404
  otherwise. `toHttpUrlOrNull` answers null on text that is not a url. Hosts
  are lower-cased. `enqueue` exists.
- **jsoup selectors.** An unquoted attribute value runs to the bracket,
  spaces included (`[title=Jump to number]`); `!=`; `:first-of-type` and the
  rest of that family; `:matches((?i)…)` opens with Java's inline flags;
  `element.isBlock` from jsoup's tag list.
- **Java regex.** A possessive quantifier over one character has an exact
  JavaScript spelling (`X++` is `X+(?!X)`, `X?+` is `(?:X|(?!X))`); over a
  group it does not, and is refused. A `]` that opens a character class is
  literal.
- **kotlinx serialization.** A generated `X.serializer()` argument is the
  type, on encode as on decode.
- **StringBuilder.** `append(a, b, c)` appends all three; `append(s, 1, 3)`
  is a range.
- **Android.** `MediaMetadataRetriever` for an mp4's picture size is answered
  by reading the box structure with ranged requests; `BitmapFactory` image
  descrambling is still refused (the sandbox has no canvas).

### Values that need the host before the host exists

A constructor or module-scope initialiser that reaches the host (bytes of a
literal, a cookie read) fails with "used a capability … before any plugin
call had started". Fold literal bytes at conversion, defer any property that
reads a deferred one, and hold a host read in an initialiser as a started
promise every read awaits.

## Measurement lessons

- **Probe the bytes, not the status.** A stream that answers 200 with an HTML
  error page is not playable; `catalogue --reach` counts a listing only when
  the first bytes are media.
- **Do not search for "a" and stop.** Gallery and name-indexed sites answer
  "a" and "the" with nothing; after both, the verifier now searches for a
  title the source's own popular shelf lists, and a source that cannot find
  its own title is reported in those words.
- **Name the wall.** Most live failures in both catalogues are a bot check,
  a dead host or a header the relay does not forward. Each now says so in
  the verdict instead of reading as "returned nothing".
- **Read the plugin's own log.** Extractors swallow their exceptions; the
  `Log.e` lines are where the reason is.
- **Regexes inside the runtime are inside a template literal.** Every
  backslash is doubled there; a single one cost two listings their playback
  before a bisect found it.
- **Diff whole runs.** "Works before, not after" over the full JSON is the
  only check that catches a fix trading one cluster for another.

## What is left, and whose decision it is

- **Bot checks and dead hosts** are most of what remains in both
  catalogues. A bot check is outside a plugin's reach by design (ADR-0005).
- **Image descrambling with Android's bitmap API** (about 90 manga listings)
  needs a canvas capability the sandbox does not have.
- **A WebView or an embedded JavaScript engine reached from one shared
  extractor** refuses about 50 anime listings that would otherwise mostly
  work. Refusing at the call site rather than the whole listing
  (compatibility-aniyomi §5.4) would recover them; that is a policy change.
- **Plugin-set request headers the relay does not forward** (a handful of
  anime listings) would be unblocked under ADR-0005 §3c's bounds, as was done
  for `Authorization`.
