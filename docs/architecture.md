# Architecture — how a foreign extension becomes a portable plugin

```
 index url ──► adapter.parseIndex ──► listings
                                        │
 listing ──► adapter.convert ───────────┤
                                        ▼
                     source files ──► front-end ──► emit ──► module text
                                                                │
                          runtime shims ──────────────► bundle ─┤
                                                                ▼
                                        sealed sandbox ──► host port ──► surface
```

## The five stages

### 1. Adapter — one ecosystem's shape, as ours

`packages/adapters`. An adapter does two things and nothing else: it parses a
foreign index into **our** `RepositoryIndex`, and it converts one listing into a
plugin archive. Returning our own types is the whole trick — everything
downstream is written once, against one shape.

Six exist: `aniyomi`, `mangayomi`, `cloudstream`, `sora`, `hayase`, `lnreader`.
Five convert a published artifact; one translates from source.

### 2. Front-end — reading the source

`packages/core/src/kotlin`. A vendored tree-sitter grammar, a **subset
allowlist**, and an emitter. The allowlist is the load-bearing part:

> Every node is consumed by a handler, or it is **named**.

An emitter whose `default:` case returns an empty string is the failure that
invariant exists to prevent. Before translating a member the emitter pre-scans
its subtree and names _every_ obstacle in it, so a refusal lists three problems
rather than the first one.

### 3. Emit — JavaScript that means what the Kotlin meant

Three tables decide what a method call becomes, and the difference matters more
than it looks:

| Table               | Meaning                                                                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTENSION_METHODS` | Semantics differ from the JavaScript namesake — `replace` replaces _all_ in Kotlin, `substringAfter` returns the whole string when the delimiter is absent, `Int` division truncates. Routed through a `__k` helper. |
| `HOST_METHODS`      | The runtime's own objects define it. Emitted as written.                                                                                                                                                             |
| _(neither)_         | **Refused, by name.**                                                                                                                                                                                                |

Passthrough is an allowlist rather than a fallback, deliberately. A fallback
turns an unrecognised helper into a property access on a shim that has never
heard of it, and the failure then happens on somebody's phone instead of here.

### 4. Runtime — what the bundle is built from

`packages/runtime`. Around 200 standard-library helpers, a jsoup-shaped DOM
(1,600 lines), okhttp's `HttpUrl`, `Headers` and `FormBody`, org.json, a
preference framework, and one driver per ecosystem. It is **text**, assembled
into the bundle — so TypeScript checks none of it, and
`kotlin-runtime.spec.ts` evaluates it as a module and drives it instead.

The emitter and the runtime are built against each other and cannot import each
other. `packages/core/src/kotlin/runtime-api.ts` is the list that stops them
drifting; a name on one side and not the other fails a test rather than a viewer.

### 5. Host port — the only capabilities there are

`packages/host`. A plugin gets `ctx` and nothing else: `http`, `settings`,
`storage`, `log`, `text`, `bytes`. No ambient `fetch`, no `process`, no module
loader. Two hosts implement the port — a browser Worker and a headless Node
isolate — and `host-equivalence` exists to prove they answer alike.

## Why the second host exists

It is the conversion laboratory. `plugin-bridge catalogue` runs the same five
steps an install performs, over a whole repository, through the _same_ code the
browser runs. A disagreement between the two is a port bug, not a quirk of a
tool — which is only true because the tool does not have its own shortcut.
