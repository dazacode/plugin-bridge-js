# The host port

What a **host** is, exactly, in the terms every shell implements. `ABI.md` is
the other half: it says what a _plugin_ is. Read together they are the two ends
of one seam — a plugin is a module the runtime runs, a host is the environment
the runtime runs _in_, and neither knows about the other.

ADR-0004 is the _why_; this file is the _what_, and it is normative.

Rule 9 applies. No source is named here, and none may be added.

The runtime this describes is `client-web/src/lib/plugins/`.
`tool/check-runtime-boundary.ts` enforces §1 and §2 on every gate.

---

## 0. The one-sentence version

A host supplies seven capabilities — network, an isolate, a directory per
plugin, a small key-value store, a second isolate for translation, the runtime's
own vendored parser artefacts, and a log — and the runtime supplies everything
else, including the part that decides what a plugin is allowed to do.

---

## 1. The runtime imports nothing from its host

`client-web/src/lib/plugins/` may import:

- other files inside `client-web/src/lib/plugins/`;
- packages, by bare specifier (`node:fs/promises`, `web-tree-sitter`).

It may **not** import `$lib`, `$app`, `$env`, or any relative path that
resolves outside the directory. There is no exception, and there is no
`// eslint-disable` equivalent.

This runs in the direction people find surprising. Where the app and the
runtime need the same type, the **runtime declares it and the app re-exports
it**, because the app can depend on the runtime and the runtime cannot depend
on the app. Today that is:

| Name                                                                    | Declared in                   | Re-exported from |
| ----------------------------------------------------------------------- | ----------------------------- | ---------------- |
| `KuroFailure`, `NetworkFailure`, `NotFoundFailure`, `ValidationFailure` | `plugins/errors.ts`           | `$lib/domain`    |
| `ByteCheck`, `SegmentOp`                                                | `plugins/segment-pipeline.ts` | `$lib/domain`    |
| `RepositoryFormat`, `ForeignFormat`, `REPOSITORY_FORMATS`               | `plugins/foreign/formats.ts`  | `$lib/domain`    |
| `ConversionRecord`                                                      | `plugins/foreign/formats.ts`  | `$lib/domain`    |

A type is moved only when the runtime genuinely _owns_ it. Where the app owns a
type and the runtime merely mentions part of it, the runtime declares a
narrower type of its own instead — `RunnablePlugin` is four fields of the app's
`InstalledPlugin`, and `ForeignMedium` is a four-member union that is not the
domain's three-member `MediaKind`. That is not duplication; it is the runtime
refusing to read fields it has no business reading.

---

## 2. Every capability is granted, never found

The runtime takes no ambient global. Not `fetch`, not `navigator`, not
`localStorage`, not `process`, not `window`, not `globalThis`. A capability
arrives as an argument or it does not exist.

`client-web/src/lib/plugins/host.ts` is this section in types:

```ts
interface PluginHost {
	readonly fetch: HostFetch; // §2.1
	readonly blobs: BlobStore; // §4
	readonly kv: KeyValueStore; // §4.1
	readonly sandbox: WorkerFactory; // §3
	readonly translator: WorkerFactory; // §5
	readonly wasm: WasmLoader; // §2.2
	readonly log: HostLog; // §6
}
```

Nothing in the runtime takes a whole `PluginHost`. Each entry point takes the
capabilities it uses — `new BundleStore(host.blobs)`, `loadChecks(host.kv)`,
`PluginSandbox.start(…, { fetcher, createWorker, log })` — so a caller that
needs storage is not also obliged to invent a sandbox.

### 2.0 A missing capability degrades; it does not crash

Every capability has a defined "this host does not have one" value, and every
one of them is a _refusal_ rather than an exception at import time:

| Absent       | What happens                                                                     |
| ------------ | -------------------------------------------------------------------------------- |
| `fetch`      | plugin requests reject with a `NetworkFailure` naming the host                   |
| `blobs`      | plugins cannot be installed; the settings screen says so and disables the button |
| `kv`         | a remembered check is re-run                                                     |
| `sandbox`    | `PluginSandbox.start` throws a `ValidationFailure`; no plugin runs               |
| `translator` | translation happens inline, with the same answer                                 |
| `wasm`       | the Kotlin front-end refuses by name; every other format is unaffected           |
| `log`        | silence                                                                          |

This is a requirement, not a courtesy. It is what a browser in private
browsing already looked like from the outside, it is what server-side rendering
_is_, and it is what lets a spec ask an unrelated question without first
inventing five capabilities.

### 2.1 `fetch`

```ts
type HostFetch = (url: string, init?: RequestInit) => Promise<Response>;
```

Must be able to set arbitrary request headers and must not be subject to CORS.
Neither is negotiable: a source will not send `Access-Control-Allow-Origin`,
and the `Referer`, `Origin` and `Sec-Fetch-*` headers it checks are forbidden
header names that browser JavaScript may not set.

The browser therefore supplies a `fetch` that reaches `/api/plugin-fetch`, a
server route that makes the real request; a native shell routes through
`kuro-core`; a headless host passes an unrestricted `fetch` straight through.

**A host does not decide policy here.** Which hosts a plugin may reach is
decided by `sandbox-host.ts` against `manifest.network.hosts` before anything
leaves, and a proxy that has one is applying a _second, independent_ limit —
see §3.1.

#### 2.1.1 The cookie jar, which is not a capability a host supplies

`ABI.md` §2 specifies a per-plugin, per-host, in-memory jar for a plugin that
declares `permissions: ["network", "cookies"]`. It is **not** in the table
above and a host is not asked for one, which is the design rather than an
omission: the jar is runtime state living beside the allowlist in
`sandbox-host.ts`, on the side of the boundary that knows which plugin is
asking. A host that supplied its own would be a second answer to "whose cookie
is this", and the answers would eventually differ.

What a host is obliged to do is **nothing**, and that is checkable. The jar
reaches the wire through two fields on the proxy's existing request and
response bodies:

| Direction | Field                             | Meaning                                               |
| --------- | --------------------------------- | ----------------------------------------------------- |
| request   | `cookies: { send?: string }`      | The caller holds a jar; `send` is the `Cookie` value. |
| response  | `setCookie: { url, headers[] }[]` | What each hop set, tagged with the hop that set it.   |

Both are absent unless a plugin declared the permission, so a host that has
never heard of cookies serves a jar-holding plugin correctly by ignoring them —
it simply carries no session, which is the pre-jar behaviour. The rules a host
must **not** break are in `docs/security.md` §2: `cookie` stays out of the
forwardable request-header allowlist, `Set-Cookie` stays out of the four
response headers a plugin reads, and the header is put on the first hop only.

The same division holds for the **request policy** a plugin declares (`ABI.md`
§2.1). Retry, pacing and per-host headers are applied by `sandbox-host.ts`
_above_ this call, because that is the side that knows which plugin is asking
and can hold a window across requests. A `fetch` supplied here must therefore
not add pacing or retries of its own: a second limiter under this one would make
the rate a plugin actually gets a function of which host it is running on, and
`ABI.md`'s guarantee is that it is not. The one exception already in the tree is
the relay's single retry for an incomplete certificate chain, which repairs a
transport failure rather than re-asking a question.

That retry is itself a host capability rather than something the relay does.
Chasing the AIA extension needs a raw TLS socket and a trust store, which no
browser has, so the relay states what it would need
(`packages/host/src/net/chain-repair.ts`) and takes it from whoever runs it;
`@plugin-bridge/host-node` supplies the one implementation. A host that
supplies none is **not** degraded — in a browser the platform has already
chased the extension before any of this code sees a response — and the relay
then reports the transport failure exactly as it arrived.

The runtime addresses the proxy by path — `/api/plugin-fetch` — in **every**
host, which is not a browser detail that leaked: it is the contract, and a host
without a server answers it itself. The headless host calls the browser route's
own handler rather than reimplementing its limits, because a second
implementation of https-only, private-address refusal, size and time caps,
per-hop redirect re-checking and AIA chasing is a second thing to be wrong (ADR
-0004 §7).

### 2.2 `wasm` — the runtime's own vendored artefacts

```ts
type WasmLoader = (name: string) => Promise<Uint8Array>;
```

Two names are ever asked for: `tree-sitter.wasm` and `tree-sitter-kotlin.wasm`,
the Emscripten runtime and the pinned Kotlin grammar that live in
`plugins/foreign/kotlin/vendor/`.

The odd one out, and worth saying why it is a capability at all. Those files
ship _with_ the runtime, which makes reading them look like the runtime's own
business. It is not, because there is no portable way to ask "where is the file
next to me": a bundler answers with a hashed asset URL, a filesystem answers
with a path, and `import.meta.url` is the bundler's answer wearing a standard's
clothes. So the runtime asks by name and a host answers with bytes.

This was §7.1's outstanding item until ADR-0004 phase 2, on the grounds that
`loadKotlinGrammar(loader)` already took one and no host needed to pass it. A
second host needed to pass it.

---

## 3. `sandbox` — an isolate, and what it must not have

```ts
type WorkerFactory = () => Worker | null;
```

`Worker` is the interface — `postMessage`, `onmessage`, `onerror`,
`terminate` — not a claim that a host is a browser. Node's `worker_threads` and
Deno both present it; anything else is adapted in the host, which is one small
class rather than a fork of the runtime.

Returning `null` means this host has no isolate. That is a supported state.

### 3.1 What the isolate is for, and what it is not

The isolate provides **containment**: a plugin cannot reach the page's
variables, and it can be terminated from outside, which is what stops a runaway
loop being a tab that heats up with no way to switch it off. Every call is
raced against a deadline and a timeout destroys the worker.

The isolate is **not** the authority. Authority lives host-side in
`sandbox-host.ts`, which answers each request the plugin makes only if the
plugin's declared host list covers it. Deleting globals inside the isolate
raises the cost of trying; the allowlist is what makes trying pointless.

### 3.2 The obligation on a host that supplies its own isolate

`client-web/src/lib/plugins/sandbox.worker.ts` deletes `fetch`,
`XMLHttpRequest`, `WebSocket` and `importScripts` from its own scope before it
evaluates a bundle, and provides `ctx.text` and `ctx.bytes` in place of the
globals `ABI.md` §6 forbids. A host that supplies an isolate of its own **must
reproduce that**, and the caveat is worth writing down rather than discovering:

> **A Node worker is not a sandbox.** It has ambient `fetch`, ambient
> `process`, and a filesystem. So does a Deno worker without explicit
> permissions, and so does a bare `vm` context.

**Built, and here is what it took.** ADR-0004 phase 2 implemented this and the
caveat turned out to be understated in two ways worth recording, because both
are things a later host will meet again:

- **Deleting globals is not enough.** `delete globalThis.process` works and
  changes nothing about `await import('node:fs')` — a module specifier is not a
  global. Closing that needs the runtime's own module-resolution hook
  (`module.registerHooks`, Node 22.15+), refusing every specifier except the
  `data:` URL the bundle is evaluated from.
- **bun cannot host this isolate at all.** `globalThis.Bun` is `writable:
false, configurable: false`, so it survives every attempt to remove it, and
  `Bun.file`, `Bun.spawn`, `Bun.write` and `Bun.FFI` are a filesystem, a
  process launcher and arbitrary native code hanging off a property a plugin
  can simply read. bun also has no module-resolution hook and refuses to let
  `Bun.plugin` override a builtin. A bun worker thread is therefore not a
  smaller sandbox; it is a _more capable_ one, which this section forbids.

The headless host's isolate is consequently a **Node child process** speaking
newline-delimited JSON over stdio, started the same way whatever runtime asked
for it — the only arrangement both runtimes can produce and both can kill. Two
smaller consequences follow and are stated so nobody rediscovers them:
`URL.createObjectURL` has to answer with a `data:` URL, because Node's ESM
loader refuses `blob:`; and the transport is JSON rather than a structured
clone, which the protocol already was.

The port's contract is therefore the **capability set, not the isolate**. A
host that runs a plugin in a more capable environment than the client's has not
implemented this port; it has implemented something that looks like it and
answers differently.

**`ctx` is part of that capability set**, so an isolate built here owes the
whole of `ABI.md` §2 — including `ctx.http.policy()`, and including the ordering
guarantee that goes with it: a policy declared before a request must be in force
for it. Over a message transport that is free, since `postMessage` and the
stdio protocol both deliver in order. Over anything that reorders, the isolate
half must not return from `policy()`'s caller before the declaration has been
sent. A host that omits the method entirely is _told_ rather than silently
unpaced: the converted runtime throws at the first request a declared limit
would have governed, naming `ctx.http.policy`.

This is not only a security statement. It is a _measurement_ statement, and
that is what makes it urgent: ADR-0004 §6.2 makes a headless host the
laboratory for the conversion scoreboard, and **a check that ran in a more
capable environment than the client would report green on a plugin the client
refuses.** The whole value of a second host is that the two agree row for row;
a disagreement is a port bug and is the point.

---

## 4. `blobs` — a directory per plugin

```ts
interface BlobStore {
	isAvailable(): boolean;
	write(id: string, files: ReadonlyMap<string, Uint8Array>): Promise<void>;
	readText(id: string, path: string): Promise<string | null>;
	remove(id: string): Promise<void>;
	list(): Promise<Set<string>>;
}
```

The shape is normative, not incidental. A bundle is a _tree_ of files, the
Flutter client stores it as a directory (`lib/core/plugins/plugin_store.dart`),
and a port shaped like a filesystem is one mental model across every host. A
key-value store with slashes in the keys would work right up until the two
clients disagreed about what deleting a plugin means.

Requirements on an implementation:

- a path may contain `/`; intermediate directories are created;
- `write` **replaces** the directory, leaving nothing of a previous version;
- `readText` returns `null` for a missing file rather than throwing — files
  cleared underneath the rows is a real state the registry reports as "needs
  reinstalling";
- `remove` succeeds when the directory was already gone;
- `list` returns an empty set when storage is unavailable, never throws.

`isAvailable()` is separate from letting `write` fail because the answer is
needed _before_ anything is downloaded: the settings screen disables installing
and says why, instead of offering a button that fails at the last step.

An implementation is handed a validated id and validated paths —
`bundle-store.ts` checks both, and repeats the archive reader's traversal
refusal, before it calls. It may re-check; it may not assume it is the only
check.

### 4.1 `kv` — small, synchronous, and allowed to forget

```ts
interface KeyValueStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}
```

Synchronous because its one caller — remembered check results — is read while a
list renders, and an async read there means every row flickering through
"unknown" on the way to an answer it already had.

**Both methods must swallow their own failures.** Reading `localStorage` throws
outright in a browser with site data blocked; writing throws on a full quota.
Neither is worth a broken screen for what this stores, so an implementation
turns both into "this host forgot" rather than making every caller wrap a
getter in `try`.

---

## 5. `translator` — a second isolate, and where `new URL` lives

The Kotlin translator runs off the main thread where there is one to be off:
converting one extension is about 35 ms of _synchronous_ work, and checking a
repository does that per listing. The contract is that **the answer is
identical whether it ran in a worker or inline**, and only _where_ differs — so
`translator` returning `null` is a supported state, not a degraded one.

One worker, not a pool. Measured over 45 real extensions driven three at a
time: one worker 1599 ms, two 1521 ms, three 2307 ms. Each worker instantiates
its own copy of a 4 MB grammar, and that costs more than the parallelism
returns at this size of job.

### 5.1 The one bundler-shaped line

```ts
new Worker(new URL('./sandbox.worker.ts', import.meta.url), { type: 'module' });
```

is an instruction to **Vite**, not a fact about the runtime: written any other
way — a variable, a concatenation — it silently becomes a URL that resolves to
nothing in a built app. It is the only genuinely bundler-specific construction
in 29,000 lines, and it lives in the shell
(`client-web/src/lib/host/web-plugin-host.ts`) for exactly that reason. A
runtime containing one would be a runtime only one bundler could build.

The worker _bodies_ stay in the runtime. What a sandbox deletes from its own
scope (§3.2) is a contract, not a per-host decision. That line is a package
boundary as well as a rule: the bodies are in `packages/host`, and what a
particular runtime has to do to its own realm before running one —
`packages/host-node/src/sandbox-bootstrap.ts`, which turns a Node process into
something no more capable than a Worker — is in the package for that host.

---

## 6. `log`

```ts
type HostLog = (message: string, detail?: Readonly<Record<string, unknown>>) => void;
```

Never a control flow, and never an error channel — a failure a viewer should
see is a `KuroFailure` the screens render. This is for whoever has a console
open, and the runtime's own lines are the ones that explain a refusal: _this
plugin asked for a host it did not declare_, _this host was learned from a page
it read_, _the proxy said why it could not relay_. Those are useless if the
only host that can emit them is the one this repository happens to ship.

The browser sends them to the playback trace, which is silent unless somebody
asks for it. A headless host writes them to stderr.

---

## 7. What a host does _not_ have to supply

The JavaScript baseline. Every host in the table below has it, no host can
withhold it, and requiring it to be injected would be ceremony rather than
portability:

`crypto` and `crypto.subtle` · `setTimeout` / `clearTimeout` ·
`queueMicrotask` · `TextEncoder` / `TextDecoder` · `Response` / `Request` /
`Headers` · `URL` / `URLSearchParams` · `Date` · `Intl`-free string handling.

Note the asymmetry with `ABI.md` §6, and that it is deliberate: a **plugin**
may not use `crypto` or `TextEncoder`, because a plugin runs on three engines
including QuickJS and JavaScriptCore builds that omit them. The **runtime** may,
because it runs in hosts, and every host in §8 is a full modern engine.

### 7.1 Nothing, and what used to be here

`plugins/foreign/kotlin/grammar.ts` used to resolve its vendored tree-sitter
artefacts with `new URL('./vendor/…', import.meta.url)` and read them with an
ambient `fetch`. It was the last ambient capability in the runtime, exempted by
name in `tool/check-runtime-boundary.ts` and recorded in `docs/KNOWN_GAPS.md`,
on the grounds that the seam already existed and no host needed it.

ADR-0004 phase 2 closed it. Both artefacts now arrive as bytes through §2.2, the
Emscripten companion wasm included — `Module.wasmBinary` takes bytes, which
removes the "Emscripten wants an address it can fetch itself" problem instead of
relocating it. The exemption is gone and the four that remain are worker
interiors, feature-detected timing hints and bundle source: no unfinished
business.

What a host is still not asked for is in §7 above, and that list is the
JavaScript baseline rather than a gap.

---

## 8. The hosts, and what each supplies

| Port         | Browser (today)              | Native (ADR-0003)  | Headless (ADR-0004 §6.2)                 |
| ------------ | ---------------------------- | ------------------ | ---------------------------------------- |
| `fetch`      | `/api/plugin-fetch`          | `kuro-core` proxy  | direct, and that route served in-process |
| `sandbox`    | `Worker` + `import.meta.url` | the same           | a **Node child process**, per §3.2       |
| `blobs`      | OPFS                         | OPFS               | the filesystem                           |
| `kv`         | `localStorage`               | `localStorage`     | a JSON file                              |
| `translator` | `Worker`                     | the same           | none; inline, which is the same answer   |
| `wasm`       | Vite asset URLs              | the same           | `node:fs`                                |
| `log`        | the playback trace           | the playback trace | stderr                                   |

The headless column is implemented: `packages/host-node/src/headless-plugin-host.ts`,
driven by `plugin-bridge catalogue`. It is a separate package from the port it
implements (`packages/host`) so that the port stays free of `process`, `node:`
and a filesystem — a consumer that runs in a browser imports the port and drags
none of this in.

`stream` — executing a `StreamPipeline` — is deliberately **not** in this
table. It is not a capability the plugin runtime asks for: the pipeline is data
a plugin produced during `resolve()`, and the thing that executes it is the
player's response filter (`plugins/segment-pipeline.ts` in a browser,
`lib/core/plugins/segment_pipeline.dart` on the Flutter targets). A host that
plays video needs it; a host that only converts and checks does not, which is
why a headless conversion harness is a complete host without one.

---

## 9. Implementing one

1. Write a `PluginHost`. Spread `NO_CAPABILITIES` and override what you have,
   so adding a capability to the port later does not break you.
2. Hand it in at the seam. In the browser that is
   `client-web/src/lib/data/plugins/index.ts` and `backend.ts` — two call sites,
   and no other file in the app names a capability.
3. Run `bun run check:boundary`. It fails with the file and line if anything in
   the runtime reached past you.
4. Run the same catalogue through both hosts and compare row for row. A
   disagreement is a port bug (§3.2), and finding those is what a second host is
   for. `client-web/src/lib/host/host-equivalence.spec.ts` is that comparison
   over every fixture this repository has, and it says in its own header what it
   cannot reach: a real browser, and a real catalogue.
