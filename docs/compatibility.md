# Compatibility — what is supported, what is refused, and why

This is the shape of the answer. `docs/compatibility-aniyomi.md` is the detailed
per-API map for the first ecosystem, and `contract/FOREIGN.md` is normative
where the two disagree.

## Three ways a construct can be handled

|               | Meaning                                                                                               | Example                                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Supported** | Translated, with the semantics the source language has                                                | `substringAfter`, `Map` indexing, `by lazy`, scope functions, `when`, coroutines flattened to promises                       |
| **Refused**   | Named, with file/member/line, and the member is not emitted                                           | an embedded JavaScript engine, `WebView`, AES-ECB and the other ciphers WebCrypto has no equivalent for, a local HTTP server |
| **Native**    | Refused, and not on any roadmap — it needs a capability a portable runtime in a browser tab cannot be | the four above                                                                                                               |

The third column is the one that matters for planning. A refusal that is
_widenable_ is work; a refusal that is native is a boundary. Conflating them
makes the backlog look larger than it is — measured once, 160 of 254 listings
were native and only 34 were widenable.

## What "supported" is held to

Not "it runs". The runtime reproduces the _source language's_ semantics where
they differ from the JavaScript of the same name, because the difference is
always a wrong value rather than an error:

- `replace` replaces **every** occurrence in Kotlin, the first in JavaScript.
- `substringAfter` returns the **whole string** when the delimiter is absent.
- `Int` division truncates.
- `+=` on a `val` collection is `plusAssign` — a mutation, not a rebind.
- A `@Serializable` class's renamed and computed fields survive the decode.
- `it` inside a block that takes no parameter is still the **enclosing** `it`.

Each of those was a bug that shipped a plugin reporting success. That is the
category this layer exists to refuse, and it is why the test suite is large
relative to the code.

## Measuring it

`plugin-bridge catalogue <index-url>` runs all five steps over a whole
repository and scores each listing into one of six columns:

| Column        | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| `portable`    | converts and works, end to end                                |
| `unproven`    | converts, and something downstream did not answer             |
| `unreachable` | the host could not get to the site at all                     |
| `widen`       | refused, and everything it refused on is supportable          |
| `native`      | refused on something that needs a capability this cannot have |
| `absent`      | nothing to test                                               |

The useful ratio is **`portable` over live-and-reachable**, not over the whole
catalogue: a repository is full of sources that are dead, moved, or behind an
anti-bot challenge, and none of those measure this software.

A repository can also publish more than it still contains. An index is a
snapshot of what was _built_; the source it was built from moves on, and index
entries carry no commit or ref to pin against. One measured repository listed
ten extensions and held source for three, the other seven having been deleted
from its default branch two years after the index was written. Those are dead
listings — `catalogue` says so in as many words — and counting them as
translation failures makes the denominator meaningless.

### Probe the path the tool exercises, not the site's front page

The rule that has cost the most time to relearn. When triaging why a listing
failed, fetch **the exact request the extension makes**, not the site's
homepage. An estimate built from the front page was wrong twice in one pass:
two sources both redirected `https://…/` to `http://`, so both looked like the
same fault, but only one of them made that request on the path being measured
— the other's search builds a different URL and was failing for unrelated
selector drift. The prediction said two recoveries; one was real.

Two traps in the instrument itself, both of which report a result that is about
the harness rather than the software:

- **A bare `fetch` is not the host.** Node's follows a redirect that downgrades
  to cleartext; the relay refuses one. A harness built on `fetch(url, {
redirect: 'follow' })` will happily report a search returning eighty results
  that the real host declines to make at all. Drive under the host's own policy
  before believing a green result.
- **Node's trust store is not a browser's.** A site chaining to a newer
  certificate authority can fail in the CLI with
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` while every browser loads it, because the
  browser host uses the browser's roots. That failure belongs to the measuring
  instrument and must not be counted against the catalogue.

## Two ecosystems have been measured this way

The columns above were designed against a Kotlin ecosystem and then used
unchanged on a JavaScript one, which is the only real test of whether they
describe _translation_ or describe one translator.

|                   | Kotlin ecosystem | JavaScript ecosystem   |
| ----------------- | ---------------- | ---------------------- |
| convert and load  | 60 of 254        | 57 of 57 anime modules |
| verified playable | 6                | 16                     |

`compatibility-sora.md` has the second pass in full. Two things from it belong
here rather than there, because they apply to any future measurement:

- **A resolved URL is a claim, not a stream.** Count what answers, not what a
  plugin returned, and report both numbers. On that catalogue 39 claimed and 16
  answered.
- **Never infer the ABI from returned objects.** Two silent harness bugs in one
  day each produced a number that looked like a finding — one reported every
  known-good source as broken, the other counted three stringified objects as
  streams.
