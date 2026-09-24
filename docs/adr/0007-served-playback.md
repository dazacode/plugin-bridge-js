# ADR 0007 — Served playback: a plugin's local server, without the socket

Status: **proposed** · 2026-09-24 · revisits ADR-0006 on new evidence without
editing it · reads against `contract/ABI.md` §1, §2, §3 and §4.5

Research answer to: "ADR-0006 refused the local-server idiom and said the
capability gap was zero. A family of extensions still stops there. Was that a
boundary, or a model of the idiom that was too coarse?"

Short version: **too coarse.** ADR-0006 was right that a plugin must never bind
a port, and right that most of what these servers do is expressible as a
`StreamPipeline`. It was wrong that nothing else was needed. What the family
actually requires is three things, none of them a socket: response bodies
carried as exact bytes, the plugin instance that resolved a stream kept alive
for the playback, and each player request dispatched to the plugin's own
handler. Those are now specified (`ABI.md` §4.5), built in the reference hosts,
and measured end to end — headlessly, and through the reference web client's
real player.

ADR-0006 stands as written. This record is the step after it, so the decision
trace stays visible: _local HTTP server behaviour is refused_ → new evidence →
_socket binding stays refused, and a plugin-owned server may be represented as
in-realm served playback_.

Rule 9 applies to this document. No content source or video host is named; the
listings are letters, the counts come from runs whose index URL was supplied at
run time and is not recorded here.

---

## 1. Decision

The six statements this change was approved on, each as decided:

| Statement                                                                                                 | Decision                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Real socket and listener behaviour remains unsupported.**                                               | Unchanged from ADR-0006. No host binds a port or opens a listener for a plugin, and the served origin is a name, not an address (`ABI.md` §4.5 rule 1). The runtime's stand-in server registers a port number in the realm and nothing else.                                             |
| **A plugin-owned local server may instead be represented as in-realm served-playback semantics.**         | `resolve` may return a source with `served: { origin }`; every request the player makes to that origin goes to the plugin's `serve(request)` on the instance that resolved it, and the answer — status, headers, exact body — goes back to the player.                                   |
| **This decision is based on measured corpus evidence.**                                                   | §2 and §3. The family was surveyed, each member classified by what actually stops it, the lift measured across both whole catalogues for losses, and two listings driven through every stage to playable media.                                                                          |
| **Arbitrary translated transform logic becomes executable during playback under `segment-transform-js`.** | Yes, and that is the point. A served stream runs the extension's own handler — its playlist rewrite, its key hand-out, its byte transform — once per player request. The permission `ABI.md` §4.4 reserved as an escape hatch is what gates it.                                          |
| **This reduces reviewer-readable declarative behaviour compared with `StreamPipeline`.**                  | Yes. A `StreamPipeline` is a transform a reviewer reads before it runs; a served stream is code a reviewer cannot. `StreamPipeline` remains the path for anything its vocabulary can express, and nothing here infers one from translated code (ADR-0006 §5 stands).                     |
| **The capability remains sandboxed and permission-visible.**                                              | `serve` runs in the same isolate under the same network policy as every other export. The permission is declared in the manifest, shown before install, and enforced by the host at `resolve` and at every lease. A host that does not know it refuses the plugin at load (`ABI.md` §7). |

---

## 2. What the family turned out to be

Thirteen video listings in the surveyed catalogue run a local HTTP server of
their own — every one a hand-rolled NanoHTTPD 3.x subclass. **None** uses the
upstream app's own contract for this (a `createHttpServer()` returning a server
on port 0, videos on a placeholder `localhost:1`, the host rewriting the port):
that contract exists upstream and has zero users in this corpus, so it is
documented here and deliberately not implemented. Building it would satisfy a
specification and move no listing.

Classified by what actually stops each one:

| Stage                                             | Count | Notes                                                                                                                                                                     |
| ------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In the family                                     |    13 |                                                                                                                                                                           |
| Blocked by something else first                   |     5 | three need a WebView or a JavaScript engine, one a thread pool, one a raw `ServerSocket` — each its own ADR                                                               |
| Loaded after the lift                             |     4 | one of them never uses its server                                                                                                                                         |
| Lists episodes                                    |     3 |                                                                                                                                                                           |
| Resolves to a served stream                       |     2 | listing A: 4 of 8 sources served, the other 4 direct downloads · listing B: 6 of 6 served                                                                                 |
| Serves its manifest, keys, subtitles and segments |     2 | both, byte-exact (§3)                                                                                                                                                     |
| Plays in the reference web player                 |     2 | B fully; A until a segment the player's own transmuxer rejects (§4)                                                                                                       |
| Refused on ordinary translator gaps               |     4 | a fully-qualified builder call, a JDK comparator constant, a lambda passed to its own constructor, an `object` extending a class — none of them served-playback questions |

The survey's own lesson is the one ADR-0006 missed: the servers **differ in
what they compute and agree in what they need**. A playlist rewrite, a key
derived by the extension and handed out on request, a fake image header and an
XOR mask stripped from every segment — three different computations, and one
abstraction under all of them: a request the plugin answers, from state it
built at `resolve`, with exact bytes.

**Catalogue-wide effect of the lift, measured offline:** video 130 → 135
loaded, manga 993 → 993, **zero listings lost**, and no probe stage changed on
any listing that loaded before. Of the five gains, three are this family, one
loads without using its server, and one is outside the family entirely —
unblocked by the byte path alone.

---

## 3. Evidence — through the headless host

Driven live through a real isolate in a child process, over the framed binary
transport (`host/src/net/frames.ts`), which is the same path a browser host's
bytes take minus the Worker boundary:

- **Listing B.** Resolve → 6 served sources → a served HLS playlist (98 KB) →
  a served 3.36 MB segment that parses as MPEG-TS directly.
- **Listing A.** Resolve → 8 sources, 4 served → a served AES-128 playlist → the
  16-byte key served through the same origin → segments that arrive upstream
  disguised as images, which the extension's own translated `ForwardingSource`
  strips and unmasks. Ten consecutive segments, alternating two disguises,
  sequentially and six at a time: **every one decrypts with valid PKCS#7
  padding to MPEG-TS with every 188-byte sync byte in place.** One wrong byte in
  the unmasking would have failed the padding check.

## 4. Evidence — through the reference web client's real player

The reference client runs each plugin in a Web Worker and plays through shaka.
The integration is a player-only scheme: a served source is handed to the
player as `yorozo-served://<route>/<path>`, a scheme only the client's routing
answers, each route bound to one lease on the instance that resolved the
source. Played against the production build of the client:

| Stage                          | Listing B                                                       | Listing A                                                                           |
| ------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Resolve succeeds               | ✓ 6 sources                                                     | ✓ 8 sources                                                                         |
| Served source selected         | ✓ first in the walk                                             | ✓ first in the walk                                                                 |
| Instance pinned                | ✓ one lease per playback                                        | ✓                                                                                   |
| Manifest served                | ✓                                                               | ✓ AES-128                                                                           |
| Key served                     | n/a                                                             | ✓ 16 bytes                                                                          |
| Subtitles served               | n/a                                                             | ✓ two ASS, one SRT, parsed and drawn                                                |
| Segments served                | ✓ byte-identical to the headless run                            | ✓ byte-identical to the headless run (sizes and leading bytes compared per segment) |
| Player accepts media           | ✓ 1080p frames decoded                                          | ✓ 1080p frames decoded                                                              |
| Playback advances              | ✓ 20 s of playback in 20 s, resume honoured                     | ✓ for ~7 s, then the player's TS transmuxer rejects one segment                     |
| Seeking                        | ✓ to 40 %, playing again within 4–5 s                           | not reached                                                                         |
| Teardown releases the instance | ✓ closing playback logs the lease released, nothing left pinned | ✓ on each fall-through                                                              |

**Listing A's stop is not served playback.** The same decrypted segments,
delivered as an ordinary HLS stream to the same player version with no routing
involved at all, fail on the same segment with the same transmuxer error. The
segments carry their parameter sets only in the first segment, as a continuous
stream may; the player transmuxes each segment on its own. That is a player
limitation to be decided separately. When it fires, the walk falls through to
A's direct-download sources, which play through the relay as they always did —
confirmed not routed through `serve()`.

Also measured in the web run: two simultaneous served playbacks in two tabs,
each with its own sandbox and route, both advancing; leaving the watch page
hands the episode to the client's mini player with the lease still held (it is
still playing); closing the mini player releases it. **Zero requests reached the
served origin over the network in any run**, and after §5's fix, zero requests
on the served scheme reached the browser's fetch.

---

## 5. What the real architecture taught that the headless host could not

Each of these was invisible until a real player drove the path, and each is now
written into the client's routing rather than worked around:

1. **A declared container on a served source is a guess.** The upstream
   `Video` type declares none, and the shared rule reads one off the url's
   extension — which a stand-in address like `/proxy?url=…` does not have. Every
   served playlist arrived labelled progressive MP4. The host now reads the
   plugin's own answer once (a playlist starts `#EXTM3U`, a DASH manifest is an
   `<MPD`) and hands that answer to the player's first request, so asking costs
   the plugin nothing.
2. **So is a declared subtitle format**, for the same reason, and a WebVTT
   parser handed an ASS file draws nothing. Same remedy.
3. **The player chooses a transport before request filters run.** shaka picks
   the plugin for a request from its url, then runs the filters, then calls the
   plugin it already picked with the filtered url. An absolute stand-in url in
   a playlist therefore went to the HTTP transport, which was handed the served
   scheme and refused it. It failed closed — the scheme cannot be fetched — and
   succeeded on the retry, one wasted attempt and one backoff per segment. The
   host now rewrites urls on the served origin in manifests only, before the
   player parses them. Segment, key and subtitle bodies are never touched. The
   filter stays as the backstop, and still fails closed.
4. **A player that fetches addresses itself cannot play a served source.** The
   desktop client's mpv controller withholds served sources from the list it
   sends rather than hand mpv an address on the viewer's own loopback.
5. **The owner of a sandbox's lifetime must retire, not stop.** A settings
   change or a bundle update used to dispose the running instance at once, which
   would end a served episode mid-stream. The host now exposes `whenUnpinned()`;
   a replaced instance takes nothing new and is stopped when its last playback
   ends. Switching a plugin off still stops it immediately.
6. **General translator bugs the byte path exposed**, fixed for every
   extension rather than this one: writing into a `ByteArray` by index, okio's
   `Buffer()` called without `new`, `JsonObject.toString()`, a fully-qualified
   `org.jsoup` call, and an `InputStream.read` into a `ByteArray` the extension
   made itself — the last one found only because a served subtitle answered 500.

## 6. Limits and trade-offs, stated

- **Bounded.** One answer at most 32 MiB, six `serve` calls in flight per
  instance, 30 seconds each; past the deadline the isolate is treated as stuck.
  Release rejects what a playback had in flight.
- **Reviewability is lower.** This is the trade in §1, and the reason
  `StreamPipeline` remains preferred wherever it can express the stream.
- **Resolve-time state is pinned memory.** An instance serving a stream stays
  alive for the playback. One instance per plugin per page in the reference
  client; two tabs are two instances.
- **Progressive MP4 cannot be served yet** in a browser: it plays down the
  media element's own `src=` path, which no scheme routing reaches. Refused by
  name rather than attempted.
- **Not a proxy.** Only the declared origin is routed, only to that plugin,
  and the origin must be `http`, a loopback name and an explicit port or
  `resolve` is refused.

## 7. Consequences

- ADR-0006's refusal of listeners stands. Its §4 claim that the capability gap
  was zero is superseded by this record: the gap was byte-exact bodies, an
  instance lifetime and request dispatch, now specified.
- `segment-transform-js` moves from reserved to implemented. The `StreamPipeline`
  vocabulary is unchanged.
- The client's install check does not yet understand served streams and reports
  a served-only listing as "did not answer" — a verification gap, not a
  playback one, recorded for the client.
- Adding a member of this family now means fixing ordinary translator gaps
  (§2's last row), not deciding architecture.
