# Licensing — unresolved, and blocking publication

**This repository has no `LICENSE` file yet, and must not be made public until
it has one.** Without one, the default is "all rights reserved": nobody may use,
copy or contribute to it, which is the opposite of the intent.

This file states what the choice has to accommodate, so that it is made once and
correctly rather than by reflex.

## What the choice must accommodate

### 1. `NOTICE` is not optional

Two parts of this repository were written by **reading a published program**
rather than by using it — the Aniyomi base-class driver and the preference
framework, both reimplemented from an Apache-2.0 project and both recorded in
`NOTICE`. Apache-2.0 §4(d) requires that attribution travel with the work.
Whatever licence is chosen, `NOTICE` ships with it and stays accurate.

Apache-2.0 is therefore the _safest_ outgoing choice, because it is the licence
that already knows what to do with a `NOTICE` file. MIT does not forbid this,
but it leaves the obligation implicit, which is worse for a file whose whole job
is to be explicit.

### 2. The vendored binaries have their own terms

`packages/core/src/kotlin/vendor/` holds two committed wasm artefacts:

| File                      | Licence                              |
| ------------------------- | ------------------------------------ |
| `tree-sitter.wasm`        | MIT                                  |
| `tree-sitter-kotlin.wasm` | MIT (grammar), Unlicense (the build) |

Both licence texts are committed beside them. Neither is copyleft and neither
constrains the outgoing choice; they must simply keep their own files.

### 3. Nothing here is a content source

Rule 9 — no content source, no catalogue, no extractor host, in code, comments,
tests, fixtures, defaults or examples — is a project rule, not a licence term,
but it is the rule that makes publishing this safe at all. It has been audited
for this repository: every host named anywhere in it is RFC 2606 reserved
(`*.example.invalid`, `*.invalid`, `example.com`) or a code forge
(`github.com`, `raw.githubusercontent.com`). A repository index is a **runtime
argument**, never a default.

Anyone adding a test, a fixture or an example inherits that rule. See
`docs/security.md` and `CONTRIBUTING.md`.

## The options, briefly

| Licence        | Fits because                                                                            | Costs                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Apache-2.0** | Already handles `NOTICE`; explicit patent grant; the upstream this derives from uses it | Longer text; a `NOTICE` obligation on redistributors                                                                                                                                       |
| **MIT**        | Shortest, most familiar, maximally permissive                                           | Attribution obligation for the reimplemented parts becomes implicit rather than structural                                                                                                 |
| **MPL-2.0**    | File-level copyleft would keep improvements to the translator public                    | Deliberately _not_ chosen elsewhere in this project's history — `NOTICE` records that an MPL dependency was refused rather than read, and adopting it here would be inconsistent with that |

**Recommendation: Apache-2.0**, for reason 1. It is the only one of the three
whose text already carries the obligation this repository actually has.

This is a decision for the repository's owner, not for a tool. Nothing has been
chosen here.
