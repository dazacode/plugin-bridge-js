# Adding an ecosystem

An adapter is deliberately narrow. It answers two questions and delegates
everything else:

```ts
interface ForeignAdapter {
	/** One foreign index, as one of ours. */
	parseIndex(body: string, indexUrl: string): RepositoryIndex;
	/** One listing, as a plugin archive. */
	convert(listing: RepositoryPlugin, capabilities: ConvertCapabilities): Promise<Uint8Array>;
}
```

Returning `RepositoryIndex` is the whole trick: every scoreboard, check, cache
and install downstream is written once, against one shape.

## The order to build it in

1. **`parseIndex` first, with a fixture.** Add a sample index to
   `fixtures/indexes.json` — with `example.invalid` hosts, see
   `docs/security.md` — and a spec asserting the listings it produces. Do not
   fetch anything yet.
2. **`convert` for the artifact case.** Most existing adapters convert a
   published artifact rather than source. If yours does, most of the
   work is reading the archive and writing a manifest.
3. **A driver, if the ecosystem has a base class.** `packages/runtime/src/shims`
   holds one per ecosystem: the object that knows the ABI the extension was
   written against and maps it onto ours.
4. **A front-end, only if you must translate source.** This is the expensive
   one. See `docs/architecture.md`.

## What an adapter must not do

- **Must not name a source.** Not in a default, not in a test, not in a comment.
- **Must not soften a refusal.** If a construct cannot be translated, name it
  and stop. An adapter that converts approximately produces a plugin that
  installs and does the wrong thing, which nobody can see.
- **Must not reach the network directly.** Take the capabilities passed to
  `convert`; they are routed through the host's relay and the policy in
  `docs/security.md`.

## Before you open a pull request

```sh
bun run test     # every package
bun run check    # types
bun run lint     # formatting
```

New compatibility behaviour needs a regression test that **provably** catches
its bug: break the fix, watch the test fail, restore it. A test that passes both
ways is not evidence.
