# The plugin ABI

What a `kuro` content-source plugin is, exactly, in the terms both clients
implement. ADR-0002 is the _why_; this file is the _what_, and it is normative.

`HOST.md` is the other end of the same seam: this says what a plugin owes the
runtime, and that says what a **host** owes it.

Rule 9 applies. No source is named here, and none may be added.

Versioned by `yorozoPluginApi` in the manifest. This document describes **API
level 1**.

---

## 0. The one-sentence version

A plugin answers three questions in JavaScript — _what shows do you have?_,
_what episodes?_, _how do I play one?_ — and the third answer may include a
**declarative byte pipeline** that the host, never the plugin, executes.

---

## 1. Shape

A bundle is one ES2020 module with a default export.

```ts
import { defineSource } from '@kuro/plugin-sdk';

export default defineSource({
  id: 'com.example.plugins.example',   // must equal manifest.id

  async searchCatalog(query, page, ctx): Promise<CatalogPage> { … },
  async listEpisodes(ref, ctx): Promise<SourceEpisode[]> { … },
  async resolve(ref, episodeNumber, ctx): Promise<PlaybackSource[]> { … },

  // optional
  async browse(shelf, page, ctx): Promise<CatalogPage> { … },
});
```

The three required methods map one-to-one onto interfaces the clients already
have — `SourceRepository.searchCatalog`, `SourceRepository.listEpisodes`,
`PlaybackRepository.resolve`. A plugin is an _implementation_ of contracts that
predate it, which is why installing one adds no screens and no branches.

### What is deliberately absent

- **No metadata methods.** A source does not get to say what a show _is_; that
  is the metadata layer's job and it keys the user's library (rule 1). A source
  returns `SourceCatalogEntry`, which carries no canonical id, and the matching
  layer binds it.
- **No UI.** Settings are declared in the manifest and drawn by the host, on six
  surfaces, in the host's design tokens.
- **No storage of URLs.** Rule 4. `resolve()` runs at play time and its output
  is never persisted.
- **No lifecycle hooks.** No `onInstall`, no background work. A plugin is a pure
  function of its inputs plus `ctx`.

---

## 2. `ctx` — the only capability a plugin has

```ts
interface SourceContext {
	readonly http: HttpClient; // permission: "network"
	readonly settings: SettingsView; // values for manifest.settings
	readonly storage: KeyValueStore; // permission: "storage", ≤64 KiB
	readonly log: Logger;
	readonly signal: AbortSignal;
	readonly text: TextCodecs; // TextEncoder/TextDecoder shims
	readonly bytes: ByteCodecs; // base64/hex, engine-independent
	readonly crypto: CryptoPrimitives; // WebCrypto, one named operation at a time
	readonly locale: string; // BCP-47, may lack a region
}
```

There is no ambient `fetch`, no `XMLHttpRequest`, no `globalThis.crypto`, no
timers beyond `setTimeout`, no DOM and no filesystem. The sandbox removes them;
`ctx` is the whole surface.

`ctx.http` refuses any host not matched by `manifest.network.hosts`, throwing
before a packet leaves. That check is the host's, not the SDK's — a plugin
cannot opt out of it by not calling the SDK.

### 2.1 `ctx.http.policy()` — the declarative request policy

```ts
interface HttpClient {
	send(url: string, request?: HttpRequest): Promise<HttpResponse>;
	text(url: string, request?: HttpRequest): Promise<string>;
	json(url: string, request?: HttpRequest): Promise<unknown>;
	policy(policy: RequestPolicy): Promise<void>; // ← new at API level 1
}

interface RequestPolicy {
	retry?: {
		attempts: number; // total attempts including the first, 1–5
		onStatus: number[]; // statuses worth asking again, 100–599
		backoffMs: number; // wait before the second attempt, 0–60000
		multiplier?: number; // each further wait times this, 1–10; default 1
	};
	rateLimit?: RateLimitRule; // every request this plugin makes
	rateLimitByHost?: Record<string, RateLimitRule>; // and, in addition, per host
	headersByHost?: Record<string, Record<string, string>>;
}

interface RateLimitRule {
	permits: number; // 1–1000
	periodMs: number; // 1–600000
}
```

**A plugin declares; the host enforces.** There is no interceptor, no chain and
no callback in the request path — for the reason §4.4 gives for the byte path,
and for a second one: pacing that lived inside the isolate would be pacing the
isolate could decline to run. `policy()` replaces the whole policy, and an
absent field means the host's default, which is no retry, no pacing, and no
header the request did not carry.

Normative, and an executor that breaks any of these is not implementing this
document:

1. **Ordering.** A policy declared before a request is in force for it. A host
   whose transport is a message must therefore preserve order between the
   declaration and the requests after it; the plugin need not await `policy()`,
   which is what lets a converted extension declare one from a property
   initialiser.
2. **Rate limiting is a sliding window.** At most `permits` requests may be
   _issued_ in any `periodMs`; the host holds the next one until the oldest of
   the last `permits` has fallen out of the window. A fixed window is wrong and
   is the likely implementation bug: it admits `2 × permits` across a boundary,
   which is exactly the burst the source asked not to receive.
3. **Both rules apply.** Where `rateLimit` and a matching `rateLimitByHost`
   entry both exist, a request to that host spends a permit from each. Taking
   only the more specific would let that host through at the _looser_ of the two
   rates, and this is the direction in which being wrong costs a viewer their
   access.
4. **A permit is spent by issuing, not by returning**, and a retry spends one —
   a retry is a request the source sees.
5. **Only a status is retried.** A request that failed to produce one at all is
   not re-issued, and neither is a status the policy did not name.
6. **`Retry-After` wins over `backoffMs`** where the response carried one that
   parses as seconds or as an HTTP date; a date in the past means "now". A wait
   longer than 60s abandons the retry and returns the response, because a plugin
   call does not live that long (`HOST.md` §3.1) and the alternative is spending
   the deadline to fail anyway.
7. **The request's own headers win** over `headersByHost`. The policy is a
   default declared once; a header written at the call site is the more specific
   of the two statements.
8. **A malformed policy is refused, naming the field**, and the previous policy
   stays in force. Ranges are the ones in the interface above; anything outside
   one is refused rather than clamped.

`headersByHost` is §4.1's field and is matched the same way — the patterns of
`manifest.network.hosts`, most specific first, with an exact host beating a
wildcard and a longer wildcard suffix beating a shorter one. It is the same
concept one layer up: §4.1 is the headers a _stream_ needs across the hosts it
spans, and this is the headers a _scrape_ needs across the hosts it spans.

**What this does not offer, and will not.** There is no hook that runs per
request. `docs/adr/0006-local-http-server.md` §5 is the standing rule and it
binds here: the foreign ecosystem expresses all of this by installing an okhttp
`Interceptor`, and an interceptor body is arbitrary code whose meaning cannot be
read out of it. The named declarative helpers translate onto this policy
(`FOREIGN.md`); a hand-written interceptor stays refused by name.

### `follow: false` — reading a redirect instead of taking it

A request may carry `follow: false`, and then a 3xx is returned as the answer:
its status, and its `Location` in `response.headers`. Redirects are followed by
default, and the host walks them itself rather than letting `fetch` do it, so
that every hop is re-checked against the same rules as the first — `follow:
false` stops that walk and relaxes nothing about it.

It exists because a redirect is an answer in this ecosystem, not only a
detour: a source asked which server holds an episode replies `302` with the
embed in `Location`, and the plugin wants that string rather than the page it
points at. Following it consumes the answer, and the plugin then reports a
source that changed.

The host that a `Location` names becomes reachable for that plugin, exactly as
a redirect _landing_ does. An allowed host answering "go here" is the same
hand-off whether the walk was taken or read, and treating the read one as
weaker would refuse the plugin's very next request.

### `ctx.crypto` — WebCrypto, one named operation at a time

```ts
interface CryptoPrimitives {
	randomBytes(length: number): Uint8Array;
	aes(
		direction: 'encrypt' | 'decrypt',
		mode: 'AES-CBC' | 'AES-GCM',
		key: Uint8Array,
		iv: Uint8Array,
		data: Uint8Array,
		tagBits?: number
	): Promise<Uint8Array>;
	hmac(hash: Hash, key: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
	generateEcKeyPair(curve: 'P-256' | 'P-384' | 'P-521'): Promise<EcKeyPair>;
	ecdsaSign(keys: EcKeyPair, hash: Hash, data: Uint8Array): Promise<Uint8Array>;
	ecdsaVerify(keys: EcKeyPair, hash: Hash, sig: Uint8Array, data: Uint8Array): Promise<boolean>;
}
// Hash is 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'.
// EcKeyPair carries `publicJwk` — kty, crv, x, y — exported at generation.
```

The `crypto` global stays absent (§6). This is why: handing a bundle
`crypto.subtle` would grant whatever algorithms the engine happens to ship,
including the ones a converter's refusals are _about_. Each operation above is
one somebody asked for, and an algorithm outside the unions is refused by name
rather than mapped onto a neighbouring one — a plugin that believes it is doing
ECB and is in fact doing CBC is a plugin that looks like it works.

Asynchronous, because `crypto.subtle` is. A synchronous surface would mean
reimplementing a cipher in a security-sensitive path, which is the worse trade.

`publicJwk` is exported when the pair is generated rather than on demand, so
that reading a coordinate off a public key is a property read and not a promise
somebody forgets to await.

### `permission: "cookies"` — state the host carries, and the plugin does not

A plugin that declares `cookies` in `manifest.permissions` gets a **cookie
jar**, and it gets it by having one rather than by being handed one. There is
no `ctx.cookies`, no method that returns a cookie, and no new field on a
response. The plugin declares the intent; the host carries the state.

Normatively, for every host implementing this port:

1. The jar is **per plugin**. One plugin's cookies are never visible to
   another, and two runs of the same plugin are two jars.
2. The jar is **per host**. A cookie is bound to the exact hostname that set
   it, and is sent on no other. `Domain` may **narrow** that binding and may
   never widen it: a `Domain` covering the setting host is stored as the
   setting host, and a `Domain` the setting host is not inside is refused.
3. The jar is **in memory only**. It is never written to disk, never read from
   or written to the host's own cookie store, and does not survive the plugin
   being unloaded.
4. The jar is **never readable by plugin code**. A host must not expose a
   cookie's name, value or existence through `ctx`, through response headers,
   or through any other channel a bundle can observe. `Set-Cookie` remains
   absent from the headers a response carries — the relay forwards four, and
   that list is unchanged — with or without this permission.
5. The jar is **opt-in**. A plugin that does not declare `cookies` behaves
   exactly as one did before the permission existed, down to the bytes on the
   wire. `cookies` requires `network`; without it there is nothing to carry.
6. A cookie is only ever attached to a request that **already passed the host
   allowlist**, so the jar grants no reach. The plugin could always make the
   request; it simply could not carry state between two of them.

`Secure` is honoured and costs nothing, because every plugin request is https.
`HttpOnly` is recorded and cannot be weaker than the floor, because no cookie
is reachable from plugin code in the first place. `Expires` and `Max-Age` are
honoured for **expiry** and never for persistence. `SameSite` is ignored: it
describes whether a cookie rides along on a request a user's page did not make
on purpose, and every request here is one a plugin made deliberately, from no
origin — the per-host rule above is already stricter than any of its values.

A host that cannot meet all six **must not honour the permission at all**. A
jar that leaks across plugins or across hosts is worse than no jar, and a plugin
that silently carries no session fails visibly at the source rather than
quietly at the boundary.

The reasoning, and the two capabilities decided against alongside this one, are
in `docs/adr/0005-network-boundaries.md` §3.

### `ctx.settings` — values for `manifest.settings`

```ts
interface SettingsView {
	string(id: string): string; // '' when unset
	boolean(id: string): boolean; // false when unset
	list(id: string): string[]; // [] when unset
}
```

Read-only, and by manifest `id` rather than by anything the plugin invents. The
values are resolved once, before the isolate starts: the viewer's choices over
the declared defaults, and nothing for an id the manifest does not declare. A
plugin has no lifecycle hooks (§1), so there is no way to push a new value into
a running plugin and none is wanted — a value that changed mid-scrape would be
read inconsistently within one call. **Changing a setting restarts the isolate**,
which is the host's job and is the only way the change is coherent.

There is no setter. Settings are the viewer's, drawn by the host, and a plugin
that could write one back would be editing a screen it is not allowed to draw.
A converted extension whose upstream framework _does_ offer a write gets a
per-run overlay, so that a source remembering a mirror it just resolved reads it
back — see `FOREIGN.md` §4.4.

**A setting may choose among the hosts `manifest.network.hosts` grants; it may
never add one.** A value naming a host outside the grant is refused when it is
set, with a sentence naming the host, and `ctx.http` refuses it again if it ever
gets there. That is deliberate rather than incidental: the consent screen showed
that host list, widening it is an install-time decision with a diff attached
(`REPOSITORY.md` §6), and a settings row is not that. `FOREIGN.md` §5.3 is the
long version, because the preference that is most often a base URL is a
converted one.

### Why a plugin cannot open a socket

Because a plugin that can listen is not sandboxed, and because a browser has no
socket to give it. ADR-0002 §2.1 is the long version: the existing ecosystem's
answer to "the player needs bytes the CDN will not serve plainly" is for the
extension to _become an HTTP server_, and that answer does not survive contact
with six platforms. §4 is what replaces it.

---

## 3. Values crossing the boundary

Structurally cloneable JSON only — no functions, no class instances, no
`ArrayBuffer` in either direction. `SourceCatalogEntry`, `Episode`,
`SubtitleTrack` and `PlaybackSource` are the shapes already declared in
`lib/domain/models/` and `client-web/src/lib/domain/`, and `contract/fixtures/`
already holds vectors for them.

`PlaybackSource` gains one optional field at API level 1:

```ts
interface PlaybackSource {
	url: string;
	container: 'mp4' | 'hls' | 'dash';
	label: string;
	quality?: string;
	heightPx?: number;
	headers?: Record<string, string>;
	subtitles?: SubtitleTrack[];
	pipeline?: StreamPipeline; // ← new
}
```

Absent `pipeline` means "fetch this URL and play it", which is what a
progressive MP4 needs and what every existing caller already assumes. Adding the
field is backwards-compatible in both languages.

---

## 4. `StreamPipeline`

The declarative replacement for a per-plugin proxy server.

```ts
interface StreamPipeline {
	headers?: Record<string, string>;
	headersByHost?: Record<string, Record<string, string>>;
	propagateQuery?: string[];
	manifest?: ManifestFix[];
	segment?: SegmentOp[];
}
```

### 4.1 `headers`

Applied by the host to manifest, segment, subtitle and key requests alike.

The host decides _how_, and this is the one place the platforms genuinely
differ:

| Host                                          | Mechanism                                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flutter (Android, iOS, Windows, macOS, Linux) | Set directly on the request; forwarded to libmpv as `http-header-fields`                                                                                                                |
| Browser                                       | Forbidden header names (`Referer`, `Origin`, `User-Agent`, `Cookie`, `Sec-*`) cannot be set by JavaScript, so requests carrying any are routed through the host's own origin-side proxy |

A plugin must not know which happened. It declares intent.

`headersByHost` overrides `headers` for requests to a matching host, using the
same patterns as `network.hosts`, most specific first. It exists because a real
stream spans two or three hosts that want different things — an API checking its
own `Referer`, a CDN checking another, a signing endpoint wanting neither — and
one flat map makes a plugin guess which host to please.

### 4.2 `propagateQuery`

Query parameter names to copy from the manifest URL onto any child URL that
lacks them. Replaces the "walk up three levels of nested `url=` looking for a
token" logic that hand-rolled proxies grow.

### 4.3 `manifest`

Named repairs, applied in order, to an HLS/DASH manifest before the player
parses it.

| `kind`              | Effect                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `absolutise`        | Resolve every relative URI against the manifest URL                                                                                             |
| `rebase-from-query` | Resolve relative URIs against a URL held in the manifest URL's `param` query value — for a wrapper endpoint that serves someone else's manifest |
| `repair-bandwidth`  | Where `BANDWIDTH` < `minBps`, replace it with `AVERAGE-BANDWIDTH` if that is above `minBps`, else `BANDWIDTH * scale`                           |

`repair-bandwidth` looks absurdly specific and is not: a CDN emitting Kbps where
the spec says bps makes every player throttle its own buffer to roughly nothing,
and the symptom is constant rebuffering on a fast connection — which reads as
"this app's player is bad", not as "this manifest is wrong".

### 4.4 `segment` — the byte path

An ordered op list applied to each segment's bytes. This is the part that must
be **identical on six surfaces**, so it is specified tightly and pinned by
`contract/fixtures/stream_pipeline.json`.

```ts
type SegmentOp =
	| { kind: 'drop-magic-prefix'; cases: { magic: string; drop: number }[] }
	| { kind: 'drop-bytes'; count: number }
	| { kind: 'xor-repeating'; key: string; unlessByte?: ByteCheck }
	| { kind: 'assert-byte'; at: number; equals: number; because: string };

interface ByteCheck {
	at: number;
	equals: number;
}
```

`magic` and `key` are base64. `key` is 1–64 bytes.

**Execution rules** — an executor that breaks any of these fails the vectors:

1. Ops run in order. Each sees the output of the previous.
2. `drop-magic-prefix` tries `cases` in order and takes the **first** whose
   `magic` matches the stream's leading bytes, dropping `drop` bytes. **No match
   drops nothing** and is not an error — an already-plain segment is normal.
3. `xor-repeating` computes `out[i] = in[i] ^ key[i % key.length]`, where `i`
   counts from the start of the byte stream _entering that op_, and **continues
   across chunk boundaries**. Resetting `i` per chunk is the single most likely
   implementation bug, which is why every vector is replayed in 7-byte chunks.
4. `unlessByte` makes an op a no-op for that segment when the byte at `at`
   already equals `equals`. It is how a source that mixes masked and plain
   segments is handled without corrupting the plain ones.
5. `assert-byte` throws when the byte at `at` is present and differs, using
   `because` verbatim as the failure message. When the stream is shorter than
   `at + 1` it passes.
6. `at` is `0..15`, and every executor MUST buffer the first **16 bytes**
   (`lookaheadBytes`) before emitting anything, so that guards and asserts are
   decidable in a streaming implementation.
7. A stream shorter than the lookahead is flushed at end-of-stream, not waited
   on.

**Why a vocabulary and not a callback:** a callback would put a JS engine in the
path of every segment. On Android and Windows that engine is QuickJS behind a
Dart FFI boundary whose documented weakness is large buffer transfer, and an
episode is hundreds of multi-megabyte segments. The transform would be
imperceptible on a developer's laptop and unusable on a phone. ADR-0002 §2.3.

An escape hatch is specified — `permissions: ["segment-transform-js"]` — and is
**not implemented** at API level 1. A host encountering it must refuse to load
the plugin with a named reason, never silently ignore it.

---

## 5. Failures

Everything a plugin throws is normalised to the `KuroFailure` taxonomy the
clients already share. A plugin should throw the SDK's typed errors so the
mapping is not guesswork:

| SDK error            | Becomes              | Means                                                                                                          |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `NotFoundError`      | `NotFoundFailure`    | The show or episode is not in this source                                                                      |
| `NetworkError`       | `NetworkFailure`     | Transport failed, retryable                                                                                    |
| `SourceChangedError` | `NetworkFailure`     | A selector or shape the plugin expected is gone — **the message is shown to the user and logged with the URL** |
| `UnsupportedError`   | `UnsupportedFailure` | This surface cannot do what the source needs (no WebView, rule 10)                                             |
| `RateLimitedError`   | `NetworkFailure`     | Back off                                                                                                       |

`SourceChangedError` is not decoration. It is the difference between a bug
report that says "black screen" and one that says "the episode list selector
returned nothing at `<url>`", and it is what makes the cassette workflow
(ADR-0002 §5.4) actionable.

---

## 6. The engine subset

One bundle runs on **one class** of engine: Chromium (Android WebView, WebView2,
the browser) and WebKit (WKWebView, webkit2gtk). `ADR-0003` §2.2 is what
collapsed this — it deleted Flutter and with it the embedded interpreters, so
the three-engine table this section used to open with (QuickJS, JavaScriptCore,
the browser's own) describes a shape the product no longer has.

API level 1 requires:

- ES2020 syntax. No decorators, no top-level `await` in the bundle's entry.
- **No `Intl`.** QuickJS builds routinely omit it. Language display names are
  the host's job.
- **Regex lookbehind is allowed.** It was forbidden here for the engine table
  above, and `ADR-0003` §2.2 repealed that: every surface has it. `ADR-0004`
  names this as the first concrete thing the engine collapse bought, and
  `foreign/episode-recognition.ts` has needed one since. Atomic groups,
  possessive quantifiers and `\p{…}` are **still** refused — those are
  `java.util.regex` constructs JavaScript does not have, which is a different
  reason and one the collapse did not touch.
- **No `TextEncoder`/`TextDecoder`/`atob`/`btoa` globals.** Use `ctx.text` and
  `ctx.bytes`; the SDK shims them per engine.
- **No `crypto` global, no `crypto.subtle`.** `ctx.crypto` (§2) is what is
  provided, and it is a named-operation surface rather than the whole of
  `subtle` for the reason given there.
- **No `structuredClone`, no `Array.prototype.at`, no `Object.groupBy`.**

**The four bullets above have not been re-decided.** Each was written against
the engine table this section used to open with, and each is now available on
every surface — but two of them are load-bearing for other reasons that survive
the collapse: `ctx.text`/`ctx.bytes` are how `HOST.md` keeps a plugin from
reaching an ambient global at all, and the `crypto` line is a sandbox
capability decision rather than an engine one (`AGENTS.md` rule 13). Lookbehind
was the one whose only justification was the engine table, which is why it is
the only one repealed here.

`kuro plugin test --engines` runs a plugin's own suite on the engine class
above, so this list is enforced rather than remembered.

---

## 7. Compatibility

Checked in this order at load, each with a distinct user-readable reason:

1. `manifest.yorozoPluginApi` ≤ the host's API level.
2. `manifest.minimumYorozoVersion` ≤ the host's version.
3. The current platform is in `manifest.platforms`.
4. Every `manifest.permissions` entry is known to this host.
5. Every declared `capability` has a consumer.

A plugin declaring an unknown permission is **refused**, not degraded. Silently
dropping a capability a plugin believes it has is how a plugin ends up making a
request it thinks is authorised.
