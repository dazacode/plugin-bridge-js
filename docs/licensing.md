# Licensing

**This repository is licensed under the Apache License, Version 2.0.** The full
text is in `LICENSE`; the copyright line and the third-party attributions are in
`NOTICE`.

This file records _why_ that licence, because the reason is a real obligation
rather than a preference.

## Why Apache-2.0

### `NOTICE` is not optional here

Two parts of this repository were written by **reading a published program**
rather than by using it — the Aniyomi base-class driver and the preference
framework, both reimplemented from an Apache-2.0 project, both recorded in
`NOTICE`. Apache-2.0 §4(d) requires that attribution travel with the work, and
Apache-2.0 is the only common choice whose text already says what to do with a
`NOTICE` file. MIT does not forbid this; it leaves the obligation implicit,
which is the wrong property for a file whose whole job is to be explicit.

**If you redistribute this, `NOTICE` goes with it.** That is the one condition
this licence adds beyond attribution and the patent grant.

### The vendored binaries keep their own terms

`packages/core/src/kotlin/vendor/` holds two committed wasm artefacts:

| File                      | Licence                              |
| ------------------------- | ------------------------------------ |
| `tree-sitter.wasm`        | MIT                                  |
| `tree-sitter-kotlin.wasm` | MIT (grammar), Unlicense (the build) |

Both licence texts are committed beside them. Neither is copyleft and neither
constrains the outgoing choice — they simply keep their own files, which is why
those files are not reformatted or moved.

### MPL-2.0 was considered and rejected

Not on its merits, but for consistency: `NOTICE` records that an MPL-2.0
dependency was deliberately _not read_ during this project's development, and
adopting the licence here would sit oddly beside that decision.

## What the licence does not cover

Rule 9 — no content source, no catalogue, no extractor host, in code, comments,
tests, fixtures, defaults or examples — is a **project rule, not a licence
term**. It is the rule that makes publishing this safe at all, and it binds
contributors regardless of what the licence permits.

Audited at publication: every host named anywhere in this repository is RFC 2606
reserved (`*.example.invalid`, `*.invalid`, `example.com`) or a code forge
(`github.com`, `raw.githubusercontent.com`). A repository index is a **runtime
argument**, never a default.

See `docs/security.md` and `CONTRIBUTING.md`.

## Applying the header

Per-file headers are _recommended_ by the Apache appendix, not required, and are
deliberately absent here: these files carry unusually dense explanatory comments
already, and a fifteen-line boilerplate above each would bury the part a reader
needs. `LICENSE` plus `NOTICE` at the root is the whole grant.
