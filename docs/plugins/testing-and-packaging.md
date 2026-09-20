# Testing and packaging

## `plugin-bridge test`

```sh
plugin-bridge test .
plugin-bridge test . --query "some other show"
```

It builds your plugin, packages it, loads it into the same sandbox a host uses,
and drives it through five steps: **convert, load, search, list episodes,
resolve**. Then it prints what came back.

```
my-plugin 0.1.0
  packaged      2716 bytes
  declared      1 host(s): api.example.test
  searched      "cowboy bebop" → 5 result(s)
  episodes      5
  resolved      1 stream(s)

All five steps passed.
```

A failure names the step and prints your plugin's own message:

```
Stopped at resolve: Cannot read properties of undefined (reading 'file')
```

This is not a linter. It is your plugin running with no network of its own, no
globals, and only the hosts you declared — which is the environment that
matters, and it is why `test` catches things a local script never would.

## `plugin-bridge pack`

```sh
plugin-bridge pack .
```

Writes `<id>-<version>.yorozoplugin`. That single file is the whole plugin.

## `plugin-bridge validate`

```sh
plugin-bridge validate com.example.plugins.myplugin-0.1.0.yorozoplugin
```

```
id: com.example.plugins.myplugin
version: 0.1.0
digest: 448926fecb84815bbf48a8679085c939e3d69fc1d7b6bcd7df7f5931d12352a8
hosts: api.example.test
permissions: network
```

Reads the bundle back and checks its digests — the same thing a host does
before installing one. Run it on the file you are about to publish, not on the
directory you built it from.

## What is in the bundle

```
plugin.json        the full manifest, including what the packager filled in
payload/source.js  your plugin, bundled to one ES module
integrity.json     digests
signature.json     provenance
```

Packaging is deterministic: the same input produces a byte-identical file, so a
digest that changed means something actually changed.

## Versioning

Bump `version` in `plugin.json` for every release. A host compares it to decide
whether an update exists, and a bundle whose contents changed under the same
version is a bundle some viewers will never receive.
