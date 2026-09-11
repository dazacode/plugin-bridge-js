# ADR 0006 — The local HTTP server idiom, and why the plugin ABI already answered it

Status: **accepted** · 2026-09-10 · extends ADR-0004 · settles a row left open by ADR-0005 ·
reads against `contract/plugin-api/ABI.md` §4 and `docs/compatibility-aniyomi.md`

Research answer to: "several extensions refuse to convert because they stand up
an HTTP server on localhost. Is that a translator gap, a missing capability, or
something we deliberately do differently?"

Short version: **something we deliberately do differently, and the replacement
is already built and shipping.** The foreign server is a workaround for a
player limitation this architecture does not have. The mechanism stays refused
and classified `native`. What has to change is the _refusal message_, which
currently describes a decision as if it were an omission.

Rule 9 applies to this document. No content source is named anywhere in it; the
cases are described by shape, and the counts come from a run whose index URL was
supplied at run time and is not recorded here.

---

## 1. Decision

|                                                                                                           | Decision                                               | Why                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Binding a port and serving HTTP from inside a plugin** (`NanoHTTPD`, `startServer`, `getListeningPort`) | **Refused, permanently. Classified `native`.**         | A plugin that listens is a plugin that outlives its call, holds a port, and is reachable by anything else on the machine. No sandbox we are willing to ship can offer it, and the browser host can never offer it at any price. |
| **The thing the server is built to achieve**                                                              | **Already supplied** by `StreamPipeline` (`ABI.md` §4) | Per-request headers on manifest, segment, subtitle _and key_ fetches, plus manifest rewriting and segment byte ops — declared by the plugin, executed by the host.                                                              |
| **Auto-translating a foreign server class into a `StreamPipeline`**                                       | **Refused**                                            | It would mean recognising intent in arbitrary Kotlin. That is source-specific pattern-matching, and the failure mode is a plugin that looks like it works and does not.                                                         |
| **Classifying this cluster**                                                                              | **Name the markers in `NATIVE_CAPABILITIES`**          | 11 of the 14 already land in `native` — but on an _unrelated_ obstacle they happen to also carry. That is luck, and this column's stated value is being the set nobody is planning to move.                                     |

---

## 2. The measurement this is decided against

Counted over the 254-listing catalogue at converter v41, by tracing the marker
set (`NanoHTTPD`, `startServer`, `getListeningPort`, `createLocalUrl`,
`segmentProxyUrl`, `createProxyUrl`, `ForwardingSource`) through the shared
libraries that carry it:

|                                            |                                                        |
| ------------------------------------------ | ------------------------------------------------------ |
| Extensions containing server code directly | **6**                                                  |
| Shared units containing it                 | **2** — one HLS-server library, one multi-source theme |
| Extensions inheriting it from one of those | **8**                                                  |
| **Distinct extensions affected**           | **≥ 14**                                               |

`≥` is meant literally. The debugging corpus lags the live index, and at least
one listing whose live refusal names `startServer` has a corpus copy predating
that code. **14 is a floor, not a total.**

This is the third-largest cluster found so far, after the anti-bot wall (~20)
and the sources whose player element is built in script (~4). Unlike those two,
it is not a capability question — it is already decided. It is also the first
cluster found by reading the _shared libraries_ rather than the per-listing
refusals, which is why it stayed invisible: it reaches most of its listings
through two units, and no single refusal message shows the shape.

---

## 3. What the foreign server actually does

Read from the shared HLS-server library, which is the largest and the one the
others copy. It exposes three endpoints — `/m3u8`, `/segment`, `/health` — and
does exactly three things:

1. **Attaches headers to every upstream fetch.** `referer` and `useragent`
   arrive as query parameters on the localhost URL and are reattached to the
   real request.
2. **Rewrites the playlist** so each segment URL points back at localhost with
   those parameters baked in — the mechanism by which (1) survives to the
   segment level.
3. **Decrypts AES-128 segments itself**, fetching the key URL under the same
   headers and serving plaintext `video/mp2t`.

None of that is a requirement of the _source_. The source serves ordinary HLS.
The server exists because the player on the original platform cannot be told
"fetch every segment with these headers, and here is the key request that needs
them too". It is a shim between an extension and a media player, and it is the
most elaborate workaround in the catalogue.

---

## 4. Why this architecture does not need one

`ABI.md` §4 already describes `StreamPipeline` as, verbatim, _"the declarative
replacement for a per-plugin proxy server"_. That was written for the Yorozo
plugin API, before this cluster was measured, and it lines up point for point:

| Foreign server does                          | Here                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reattach `referer` / `useragent` per request | `headers`, and `headersByHost` when a stream spans hosts that want different things — _"applied by the host to manifest, segment, subtitle and key requests alike"_ |
| Rewrite the playlist to keep headers alive   | Unnecessary. The host attaches them at fetch time, so there is nothing to smuggle through a URL.                                                                    |
| Decrypt AES-128                              | Standard HLS. Both players do it natively once the key request carries headers — which is the same sentence as the row above.                                       |
| Serve a status other than 500 upstream       | The relay already surfaces the upstream status.                                                                                                                     |

In the reference client the browser half is a media-player request filter
registered fresh per attempt and captured by value, so a mirror that needs a
`Referer` cannot leak it to the next one, with the forbidden header names
routed through the origin-side proxy instead. The desktop half forwards them to
libmpv as `http-header-fields`. A plugin declares intent and does not learn
which happened. **This repository ships the declaration and the classification;
the execution belongs to whichever host embeds it** — see
`docs/adding-an-adapter.md`.

So the capability gap here is **zero**. What is missing is a _translation_, and
that is the next section.

---

## 5. What is deliberately not built

A tempting fix is to detect the idiom — a class extending an HTTP server, a
`/segment` endpoint, a header reattachment — and emit an equivalent
`StreamPipeline`. **Refused**, on the standing rule that conservative refusal
beats silent wrong behaviour.

The server body is arbitrary Kotlin. Recognising "this one is a header proxy"
means recognising that the _rest_ of it does nothing that matters, and the rest
includes a Cloudflare-solve fallback path, a key-derivation step, and in one
case a custom byte transform. Get it wrong and the result converts cleanly,
loads, plays for ten seconds and stops — the exact failure the refusal text
exists to prevent.

The supported path for a source in this cluster is a **hand-written adapter**
that declares the pipeline directly. That is a person reading one source and
writing down what it needs, which is a different activity from translation and
is out of scope for the converter.

---

## 6. What changes today

Less than expected, and the measurement is the interesting part. Each affected
directory was converted offline and its _blocking_ obstacles classified under
the current rules:

|                                                                                |        |
| ------------------------------------------------------------------------------ | ------ |
| Already `native`                                                               | **12** |
| ...of which carry a server marker that contributes **nothing** to that verdict | **11** |
| Currently `widen`, moved by this change                                        | **1**  |
| Carry server code that never reaches the blocking set                          | **2**  |

So the headline is not a reclassification. It is that **11 listings are
classified correctly by accident** — they also use the JVM's cipher, or a
WebView, or a thread, and one of those is what `reachOf` actually matched. Take
the coincidence away and they would read as `widen`, which is a promise the
translator cannot keep.

`NATIVE_CAPABILITIES` therefore gains the markers the obstacles actually use —
`super.getListeningPort()`, `.createLocalUrl()`, `.createProxyUrl()`,
`.segmentProxyUrl()`, `.alwaysNeedsProxy()`, `startServer`, `NanoHTTPD` —
joining `ForwardingSource` and `PlaylistServer`, which were already there and
are the same cluster spotted earlier without being named as one.

The file's own comment is the argument: _"a blanket rule would quietly
reclassify tomorrow's ordinary gap as a boundary, and the whole value of this
column is that it is the set nobody is planning to move."_ These belong in it
on the merits, not because of what they happen to sit beside.

---

## 7. Consequences

- `widen` loses one listing and `native` gains it. Eleven more keep the
  classification they had and stop depending on a coincidence to keep it.
- The ceiling in ADR-0005 is unaffected. Every listing here already failed at
  conversion, so none of them was among the 27 live-and-reachable.
- If a desktop-only host ever wanted to offer a real loopback server, this ADR
  is where to argue against it: a browser host could not follow, and a
  capability only some hosts have is one a plugin cannot safely declare.
- `StreamPipeline` gains its first evidence of being the right shape. It was
  designed ahead of the measurement and the measurement agrees with it, which
  is worth recording because the reverse is the more common outcome.
