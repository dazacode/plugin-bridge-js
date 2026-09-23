# Phase 2 — What the portable runtime should become, measured

Status: **research, recommendations only — nothing implemented** · 2026-09-10 ·
reads against `adr/0005-network-boundaries.md`, `adr/0006-local-http-server.md` and `compatibility-aniyomi.md`

Phase 1 asked _"how much of this ecosystem can we translate with the runtime we
already have?"_ and answered it: 60 installable, and the translator work has
reached diminishing returns.

> **Later (v0.5.0, 2026-09-22):** that conclusion held for the corpus it was
> measured on, and was overturned by measuring whole catalogues — class-level
> translator fixes moved 1,050 of 1,652 listings to loading, from 902. This
> document's own finding, that native capabilities are not where the catalogue
> is lost, still stands. See [`measurements.md`](measurements.md).

Phase 2 asks the better question — **"what should the portable runtime become,
so that a foreign plugin no longer needs its original platform?"** — by refusing
to treat `native` as permanent. Every capability below was re-examined for the
_behaviour_ the extension needs rather than the JVM or Android API it happens to
reach for.

Rule 9 applies. No content source is named; listings are counted, never
identified.

---

## 1. How the numbers were produced, and why they are not the obvious ones

Counting listings that _mention_ a capability is a first-order number and it is
wrong in a specific direction: a refusal happens at the door, so the code behind
it is never scanned, and granting the capability makes that code reachable and
surfaces obstacles the first count could not see.

So each capability was **actually granted** — a temporary switch removed its
refusal, the whole 254-listing catalogue was re-converted offline, and the
change in _completed conversions_ recorded. The switch was reverted before
anything here was written.

The method is not free of error, and its error has a direction worth stating:
**a grant is shallow.** It suppresses a refusal; it does not implement the
behaviour. A listing counted as unlocked is one that would convert _if the
primitive existed and were correct_. That is the right question for a capability
audit and the wrong one for a release note.

One calibration, kept because it shows the size of the effect: the first crypto
grant measured **+0**, and it was wrong. Removing the umbrella obstacle exposed
the underlying type names to a _different_ refusal, which the first run then
counted as failure. The corrected grant measures **+4**. Any number below that
was not produced by a full grant is not in the table.

---

## 2. The capability map

Baseline: **65 of 254** convert offline. "Unlockable" is measured, not
estimated: the listings that actually complete conversion once that capability —
and only that capability — is granted.

| Native blocker                                | Underlying behaviour                                            | Affected | **Unlockable alone** | Proposed portable primitive                                                      | Web                                          | Native          | Security cost                                          | Recommendation   |
| --------------------------------------------- | --------------------------------------------------------------- | -------- | -------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- | --------------- | ------------------------------------------------------ | ---------------- |
| `javax.crypto`, `SecureRandom`, `.initSign()` | AES decrypt; random bytes; a P-256 keypair; sign a nonce        | 76       | **+4**               | `ctx.crypto` over **WebCrypto**                                                  | **Yes** — `subtle` is the same primitive set | Yes, everywhere | **Low** — pure computation, no new I/O or reachability | **Build first**  |
| Cookie / session state                        | Carry a `Set-Cookie` value to the next request on the same host | 22       | **+3**               | The constrained per-plugin, per-host, in-memory jar `adr/0005` already specifies | Yes, host-side                               | Yes             | **Medium** — real, and already analysed                | **Build second** |
| `.addInterceptor()`                           | Retry, re-sign, rate-limit, or re-header a request              | 83       | **+1**               | Declarative request policy on `ctx.http` — retry, rate limit, per-host headers   | Yes                                          | Yes             | Low–medium                                             | **Built**        |
| Local HTTP server                             | Carry headers to every HLS segment; decrypt AES-128             | 13       | **+1**               | Already exists — `StreamPipeline` (`adr/0006`)                                   | n/a                                          | n/a             | None                                                   | **Closed**       |
| Background threads, `Handler`                 | Run work later; memoise across calls                            | 76       | **+1**               | Nothing new. One thread is a correct translation                                 | Yes                                          | Yes             | None                                                   | Reject           |
| Embedded JS engine                            | Evaluate a packed or obfuscated payload                         | 69       | **+1**               | Narrow, named unpackers only — never arbitrary evaluation                        | Partial                                      | Partial         | **High** if general                                    | Keep refused     |
| WebView                                       | Run the page, including its anti-bot challenge                  | 48       | **+0**               | —                                                                                | No                                           | Companion only  | **High**                                               | **Keep refused** |
| The JVM class object, reflection              | Name a type at runtime                                          | 82       | +0                   | —                                                                                | No                                           | No              | Medium                                                 | Reject           |

### The ladder, cumulative

| Granted                                                    | Converts | Δ       |
| ---------------------------------------------------------- | -------- | ------- |
| Nothing (today)                                            | 65       | —       |
| Crypto                                                     | 69       | +4      |
| Crypto + cookies                                           | 72       | +7      |
| Crypto + cookies + interceptor policy                      | **75**   | **+10** |
| **Every named boundary**, WebView and a JS engine included | **79**   | **+14** |

---

## 3. The finding

**The boundary is not where the catalogue is lost.** Granting _every_ native
capability in this document — cookies, crypto, interceptors, an embedded
JavaScript engine, a WebView, threads, reflection, the JVM class object — moves
offline conversion from 65 to **79**. Fourteen listings, for the entire
architectural surface, including the two capabilities that would change what
this software is.

The safe, portable subset gets **10 of those 14**. WebView and a general JS
engine — the two with a real security cost — are worth **+4 between them**, and
WebView alone is worth **zero**.

That is the answer to "is `native` an eternal ceiling?" It is not a ceiling at
all. It is a wall with very little behind it.

**What is behind it instead** is the same long tail Phase 1 stopped on. With
every boundary granted, the top remaining blockers are an unparsed passage (76),
an anonymous `object :` (48), deeper JVM surface that the grant merely revealed
— `::deleteOnExit`, `.getResource()`, `Runnable(…)` — and a scatter of one-offs.
Extensions that reach for a cipher also reach for six other things.

---

## 4. Why crypto is nonetheless worth building

It ranks first on the measurement, and it is the only item here whose
_implementation_ is smaller than the thing it replaces.

The shape, read from the shared extractor library that carries it for most of
its listings, is a client attestation handshake: generate a P-256 keypair, sign
a server nonce, decrypt an AES payload, and take random bytes for a fingerprint.
Every one of those is a WebCrypto call:

| Kotlin                                                                   | WebCrypto                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------- |
| `KeyPairGenerator.getInstance("EC")` + `ECGenParameterSpec("secp256r1")` | `generateKey({ name: 'ECDSA', namedCurve: 'P-256' })` |
| `Signature.initSign` / `sign`                                            | `sign({ name: 'ECDSA', hash: 'SHA-256' })`            |
| `Cipher.getInstance("AES/…")` + `doFinal`                                | `decrypt({ name: 'AES-CBC' or 'AES-GCM' })`           |
| `SecureRandom().nextBytes`                                               | `getRandomValues`                                     |

The Kotlin spends a dozen lines assembling a JWK by hand — padding `affineX` and
`affineY` to 32 bytes. WebCrypto exports JWK directly, so the shim is _shorter_
than the code it stands in for. It is available in browsers, Node, Deno, Bun and
every mobile runtime, which makes it the most portable capability in the table.

**The one real cost, stated up front:** `crypto.subtle` is asynchronous and
`javax.crypto` is not. The emitter already propagates `await` outward from any
frame that needs it, so the work is to mark the crypto helpers as awaited and
let that propagation run — bounded, but not free, and it will make some
previously-synchronous members `async`. The alternative — a synchronous
hand-rolled cipher — is rejected: reimplementing AES to avoid an `await` is a
bad trade in a security-sensitive path.

It also generalises. A crypto primitive is not an Aniyomi concept; every plugin
ecosystem worth translating has extensions that decrypt something.

---

## 5. Built, and what the measurement said afterwards

All three recommendations below were implemented. The catalogue was re-measured
against the real implementations, and the result is the most useful thing in
this document:

|                | Predicted by the grant | **Measured, built**                          |
| -------------- | ---------------------- | -------------------------------------------- |
| Crypto         | +4                     | **+4**                                       |
| Cookie jar     | +3                     | **0**                                        |
| Request policy | +1                     | **0**                                        |
| **Total**      | **+10**                | **+4** — 65 → 69 conversions, no regressions |

**A shallow grant measures "if we ignored our own rules", not "if we built this
properly."** That is the correction, and each miss has a different and instructive
cause.

**Crypto met its number exactly — but only after a stdlib gap was closed.**
Three of the four listings reached the new `ctx.crypto` and then stopped on
`.copyOfRange()`, which is plain Kotlin standard library and was simply never
implemented. A capability granted one call short of useful is worth nothing, and
nothing in the first-order count could show that: the grant had quietly included
the helper. Worth remembering — **when a capability lands and the listings do not
move, look for the ordinary call behind the extraordinary one.**

**The cookie jar's +3 was an artifact of a grant that broke the design.** All
three listings name `loadForRequest` — they read their own jar — and ADR-0005
forbids exactly that: the host carries the state and the extension never reads
it. The grant allowed the read because a grant only suppresses a refusal; it has
no opinion about policy. So the correct implementation refuses all three, and the
+3 was never available without abandoning the constraint that made the feature
acceptable.

There is a second finding underneath it: the dominant cookie usage in this
ecosystem is **implicit** — the upstream framework installs a jar on the shared
client and the extension's own code never names a cookie API. Such a bundle has
nothing for an opt-in to be derived from. So the jar's conversion value is zero
and its _runtime_ value is real but unreachable until a per-format default is
decided. That is a decision, not a bug.

**The request policy's +1 was the same artifact.** Its one listing needs an
arbitrary `addInterceptor { chain -> … }` lambda, which stays refused on the
ADR-0006 §5 rule against recognising intent in arbitrary Kotlin, plus the WebView
cookie store, which is now refused by name rather than converting cleanly and
dying inside the sandbox.

**The policy was still worth building, for a reason no count predicted.**
`__k.rateLimit` was `function (value) { return value; }` — under a comment saying
pacing was "host-owned", which the host never received. Every extension that
throttled itself to protect a source was converted into one that does not, with
nothing reporting it, and the symptom lands on a viewer as a block. The
compatibility table listed that as "Partial — `__k.rateLimit` exists". A
capability audit found a silent correctness bug, which is not what it was for.

**What the three are actually worth, stated plainly:** +4 conversions, one silent
rate-limit bug fixed, one class of runtime death (`CookieManager`) converted into
a conversion-time refusal, and a cookie jar whose value is real but gated behind a
decision nobody has made yet.

---

## 6. Recommendation

_Written before the work; kept as it stood, with §5 as the correction._

1. **`ctx.crypto`, WebCrypto-backed.** +4 measured, portable everywhere, low
   security cost, useful to every future ecosystem. The async propagation is the
   work.
2. **The constrained cookie jar**, exactly as `adr/0005` specifies. +3 measured,
   which retires that ADR's "build it when a second source needs it" threshold —
   the audit is that second source and then some.
3. **Declarative request policy** — retry, rate limit, per-host headers — as the
   portable answer to `.addInterceptor()`. Only +1 by itself, but it is the
   honest shape for a capability 83 listings reach for, and unlike the others it
   removes a _class_ of refusal rather than a name.

   **Built** — `ABI.md` §2.1, `FOREIGN.md` §4.1.8. Two things about it are worth
   recording here, because neither was what the row above predicted.

   The first is that the **+1 was not the reason to do it.** The reason was a
   silent wrong answer already shipping: `__k.rateLimit` accepted a limit,
   returned its receiver and told nobody, so an extension that politely throttled
   itself to one request a second was converted into one that does not. That is
   not a missing feature, it is the failure mode this project's standing rule
   exists to prevent, and it was sitting inside a helper the tables listed as
   supported.

   The second is that the **scope held.** What translates is the named
   declarative helpers — `.rateLimit()`, `.rateLimitHost()`, and the two
   interceptor objects the same library ships — whose meaning is their signature.
   A hand-written `addInterceptor { chain -> … }` is still refused by name, on
   `adr/0006` §5, and the recorded measurement that accepting its body unblocks
   zero listings is unchanged and was not re-litigated.

4. **Nothing else.** Threads, reflection and the JVM class object are correctly
   refused. A general embedded JavaScript engine and a WebView stay outside the
   portable runtime: together they are worth four listings, and they are the two
   that change the threat model.

Ranked against the criteria that were asked for — whole extensions unlocked,
portability across web/iOS/Android/desktop, security impact, implementation
complexity, and usefulness to non-Aniyomi ecosystems — crypto wins every column
except complexity, where the cookie jar is simpler.

**What this does not claim.** +10 is a conversion figure, not an installability
figure, and Phase 1 established that conversion is the easy half: of 60
installable listings, 33 never answered at all for reasons no capability fixes.
A realistic expectation for all three primitives is that the _live_ portable
count moves by low single digits. That is still the best return available — it
is simply not a large number, and this document would be dishonest to imply
otherwise.
