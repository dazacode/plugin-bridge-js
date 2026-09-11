# Security model

Three boundaries, in the order a plugin meets them.

## 1. The sandbox

A converted plugin is untrusted code. It runs in a sealed realm with the
browser-Worker capability set and nothing more:

- **No ambient network.** `fetch`, `XMLHttpRequest` and `WebSocket` are removed.
  The only way out is `ctx.http`, which the host serves.
- **No `eval`.** Not `eval`, not `new Function`, not `import()` of anything but
  the bundle itself. An embedded JavaScript engine is a _refused_ translation
  target for this reason, not an unimplemented one.
- **No module loader.** In the Node isolate this matters most: deleting
  `process` does not stop `await import('node:fs')`, and that is the escape that
  would make the headless host strictly more capable than a browser's. It is
  refused explicitly.
- **The isolate is a process**, so terminating it is a kill rather than a
  request. That is stronger containment than a browser Worker offers.

A sandbox that reported success while doing nothing would be worse than one that
throws, so the sealing is asserted by tests that enumerate the globals rather
than described in prose.

## 2. The network relay

Every plugin request goes through one relay (`packages/host/src/net/relay.ts`),
which holds the whole network policy:

- **https only.** No downgrade, no exceptions.
- **Private and link-local addresses refused**, including after a redirect.
- **Redirects followed one hop at a time**, with the target re-checked at each
  hop. `redirect: 'manual'` is what makes that possible.
- **A host allowlist**, per plugin: what the bundle declared, plus what the run
  learned from pages it actually read.
- **Bounded bodies.** A response past the cap answers with its status, final URL
  and headers, and says the body was not read — rather than handing back an
  empty page that reads as a working request.
- **Four response headers forwarded** — `content-type`, `content-length`,
  `location`, `retry-after`. `Set-Cookie` is **still** not one of them: a cookie
  handed to untrusted code is a credential handed to untrusted code, and that
  has not changed. See below for the jar, which is how a plugin carries a
  session without ever seeing one.

The relay is framework-free so that a web server, the headless isolate and a
test all run the _same_ policy. A host that routed around it would be running
plugins under different rules than this repository states.

### 2.1 The cookie jar

A plugin that declares `permissions: ["cookies"]` has a jar, specified
normatively in `contract/ABI.md` §2 and reasoned about in
`docs/adr/0005-network-boundaries.md` §3. The posture, stated as bounds rather
than as features:

- **The jar is host state, not a plugin API.** It lives in `PluginSandbox`
  (`packages/host/src/sandbox-host.ts`), one instance per running plugin. There
  is no `ctx.cookies`, no method that returns a cookie, and no response field
  carrying one. A plugin cannot enumerate cookies for a host it set them on,
  let alone for one it did not.
- **A cookie never crosses a host boundary.** It is bound to the exact hostname
  that set it. `Domain` narrows and never widens: covering the setting host
  stores it as the setting host, and not covering it is refused outright.
- **A cookie never crosses a plugin boundary**, because the jar is a field on
  the sandbox rather than anything a second sandbox can name.
- **A cookie never reaches disk.** In memory only, never the host's own cookie
  store, and `dispose()` empties it — so unloading a plugin is what clearing its
  jar means.
- **The jar grants no reach.** A cookie is only ever attached to a request that
  already passed the per-plugin host allowlist. The plugin could always make the
  request; it could not previously carry state between two of them.
- **Opt-in.** Without the permission the bytes on the wire are what they were
  before the jar existed, in both directions.

Two things the relay does **not** do, and both are load-bearing:

- `cookie` is not in the forwardable request-header allowlist and must stay out
  of it. The jar's header arrives on a field of its own (`cookies.send`) so that
  "this request carried a credential" is one grep rather than a judgement about
  the contents of a map. A caller who could put a cookie in the general header
  map could put any cookie there, for any host.
- The header is put on the **first hop only**. The relay holds no jar and must
  not guess whether a cookie applies to a redirect's target; it drops the header
  and reports what each hop set instead, tagged with the hop, so that the jar
  scopes it and the plugin's next request carries it.

What is deliberately still refused, rather than half-supported: an extension
**reading** its own jar (`loadForRequest`), and the WebView cookie store
(`CookieManager`). Both are refused by name at conversion — the first because
handing cookies to plugin code is the thing this design exists to prevent, the
second because there is no WebView and `§4` of the ADR says there will not be.

## 3. Rule 9 — no content source, anywhere

> Never bundle, reference, or link a content source — not in code, not in
> comments, not in tests, not in fixtures, not in a commit message, not in the
> README.

A repository index is a **runtime argument**, supplied by whoever runs the tool,
every time. There is nowhere in this repository for one to be written down, and
that is deliberate rather than incidental: a browser client makes casual
violation one `fetch` away and visible to anyone with devtools, so the rule is
tighter here, not looser.

Audited for this repository: every host named anywhere in it is RFC 2606
reserved (`*.example.invalid`, `*.invalid`, `example.com`) or a code forge
(`github.com`, `raw.githubusercontent.com`). Client applications, libraries and
file formats are named; sources are not.

**If you are contributing:** a URL that was convenient for one afternoon's
testing is a URL in the repository's history forever. Use `example.invalid`.
