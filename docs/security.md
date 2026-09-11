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
  `location`, `retry-after`. `Set-Cookie` is dropped: a cookie handed to
  untrusted code is a credential handed to untrusted code. See
  `docs/adr/0005-network-boundaries.md` for the constrained jar that would
  change this, and what it is worth.

The relay is framework-free so that a web server, the headless isolate and a
test all run the _same_ policy. A host that routed around it would be running
plugins under different rules than this repository states.

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
