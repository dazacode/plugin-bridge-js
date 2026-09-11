# Vendored tree-sitter grammars

Binary artefacts, committed deliberately. Provenance, versions and the reason
each choice was made.

| File                      | Source                                                | Version                                            | Licence                              | SHA-256                                                            |
| ------------------------- | ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| `tree-sitter.wasm`        | npm `web-tree-sitter`                                 | 0.20.8                                             | MIT                                  | `17382e1a69bd628107e8dfe37d31d57f7ba948e5f2da77e56a8aa010488dc5ae` |
| `tree-sitter-kotlin.wasm` | npm `tree-sitter-wasms` `out/tree-sitter-kotlin.wasm` | 0.1.13, built from `fwcd/tree-sitter-kotlin` 0.3.x | MIT (grammar), Unlicense (the build) | `b5cb00c8d06ed0f10f1dbe497205b437809d7e87db1f638721a8cfb30e044449` |

## Why these are committed rather than fetched

Loading a grammar from a CDN would name a third-party host in the client, which
is the shape AGENTS.md rule 9 exists to prevent. It would also make conversion
depend on somebody else's uptime, and make a converted bundle's bytes depend on
which version of a grammar happened to be served that day.

## Why 0.20.8, and not the newest of anything

**The runtime and the grammar must agree on the language ABI**, and they are
published by different projects on different schedules.

`web-tree-sitter` is at 0.27 at the time of writing, and `tree-sitter-wasms`
builds its grammars with `tree-sitter-cli` **0.20.8**. A grammar compiled by the
0.20 toolchain is rejected outright by a 0.27 runtime — `Language.load` throws,
and the message is about a version number rather than about the mismatch. So the
runtime is pinned _down_ to the grammar rather than the grammar built _up_ to
the runtime, because building it up needs Emscripten, and a toolchain nobody on
this project has installed is a step that silently stops being run.

The trade is that both halves are older than they could be. That costs nothing
today: the grammar parses the constructs this converter needs — string
templates, scope functions, safe calls, `!!`, trailing lambdas, `when`,
`suspend` — with zero `ERROR` nodes on representative sources.

## Upgrading

Both files move together or neither does.

1. Pick a `tree-sitter-cli` version and build the Kotlin grammar with
   `tree-sitter build --wasm` (needs Emscripten or Docker), **or** find a
   prebuilt set whose builder version you can verify.
2. Install the matching `web-tree-sitter` and copy its `tree-sitter.wasm` here.
3. Update the table above, including both hashes.
4. Bump `CONVERTER_VERSION` in `../../package.ts`. A grammar change can change
   emitted bytes, which changes a converted bundle's digest, which the update
   path reads as a new version — `FOREIGN.md` §7 already makes a converter
   version bump grounds to offer re-conversion, so this fits that machinery
   rather than needing new machinery.
5. Re-run the survey (`bun tool/kotlin-survey.ts`) and compare the conversion
   rate. A grammar bump that parses _less_ is the failure worth catching.

`grammar.spec.ts` asserts both hashes, so a silent swap fails a test.
