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
