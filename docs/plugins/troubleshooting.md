# When it goes wrong

The errors you will actually hit, and what each one means.

## `... did not build`

A bundling failure, with the file and line underneath it. Usually one of:

- a dependency that needs Node built-ins (`fs`, `path`, `Buffer`). The sandbox
  has none. Pick a browser-safe library.
- a TypeScript error — `plugin-bridge test` builds, it does not typecheck. Run
  `tsc --noEmit` for the friendlier message.

## `A plugin may only make https requests.`

Exactly what it says. `http://` is refused, including `http://localhost`.

This means there is **no local-mock story** today: you cannot point a plugin at
a dev server on `http://127.0.0.1`. Test against the real source over https.

## `... which it did not declare`

Your plugin reached a host that is not in `plugin.json`'s `network.hosts`. The
message names the host. Add it and run again.

If it names a host you have never heard of, you were redirected there —
redirects are re-checked at every hop, and the host you _land_ on is the one
being reached.

## `ctx.http.get is not a function`

There is no `get` or `post`. The client is `send`, `text`, `json` and `policy`.

## `ctx.log.info is not a function`

`ctx.log` has two methods, `debug` and `warn`. `console.log` also works and
goes to the same place.

## `Stopped at search: ... → 0 result(s)`

Your plugin ran and found nothing. That is a source answer, not a crash — try
`--query` with something you are certain that source carries, and log the raw
response:

```ts
const body = await ctx.http.text(url);
ctx.log.debug(body.slice(0, 500));
```

## `Stopped at resolve` with no message

`resolve` returned `[]`. Something upstream changed shape — the selector, the
JSON key, the redirect. Log what you got before you parse it.

## A setting that does nothing

Declared, saved, and ignored. Your plugin runs fine on its defaults, so nothing
fails.

Check first that the id in `ctx.settings.string('...')` matches the manifest
exactly — an unknown id reads as unset rather than erroring. Then prove it by
effect: change the default, run `test` again, and confirm the output changed.
Identical output means the value is not being read.

## It works in a script and not in `test`

That is the point of `test`. Your script has `fetch`, a filesystem, ambient
globals and no host allowlist. The sandbox has none of those. The difference is
the thing that would have broken on someone's phone.
