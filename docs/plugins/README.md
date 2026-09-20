# Writing a Yorozo plugin

A plugin tells Yorozo where something can be watched. It answers three
questions about a show — what matches a search, what episodes exist, and where
one of them plays — and it has no other powers.

If you can read a website or an API and write some JavaScript, you can write
one. You do not need to know anything about Plugin Bridge, the compatibility
layer, or any of the other ecosystems it adapts.

## The ten-minute version

```sh
plugin-bridge init my-plugin     # scaffold
cd my-plugin
# edit src/index.ts and plugin.json
plugin-bridge test .             # build it, run it, see what it answered
plugin-bridge pack .             # write the .yorozoplugin
```

`test` is the one to lean on. It does not check that your code compiles — it
runs your plugin the way a host runs it, through the same five steps a host
puts it through, and tells you what came back:

```
my-plugin 0.1.0
  packaged      2716 bytes
  declared      1 host(s): api.example.test
  searched      "cowboy bebop" → 5 result(s)
  episodes      5
  resolved      1 stream(s)

All five steps passed.
```

## Read these in order

|                                                   |                                                             |
| ------------------------------------------------- | ----------------------------------------------------------- |
| **[Your first plugin](first-plugin.md)**          | a working plugin against a real API, start to finish        |
| [The manifest](manifest.md)                       | what `plugin.json` declares, and why a viewer sees it       |
| [The three methods](the-three-methods.md)         | `searchCatalog`, `listEpisodes`, `resolve`                  |
| [Networking](networking.md)                       | `ctx.http`, declared hosts, headers, redirects, rate limits |
| [Settings](settings.md)                           | asking a viewer for a mirror, a language, a token           |
| [Testing and packaging](testing-and-packaging.md) | `test`, `pack`, `validate`, and what a bundle contains      |
| [Recipes](recipes.md)                             | HTML scraping, JSON APIs, `Referer`, torrents               |
| [When it goes wrong](troubleshooting.md)          | the errors you will actually hit                            |

## Two things to know before you start

**Your plugin cannot reach anything it did not declare.** Every hostname goes
in `plugin.json` under `network.hosts`. A viewer is shown that list before
installing, and a request to anywhere else throws before a packet leaves. This
is not a formality you can skip — it is the reason someone can install your
plugin without reading it first.

**Your plugin has no ambient anything.** No `fetch`, no `window`, no
`document`, no `localStorage`, no filesystem. Everything it can do arrives as
`ctx` on each call. If it is not on `ctx`, your plugin does not have it.

## Going deeper

This section is the developer experience. The contract underneath it is
[`ABI.md`](../../contract/ABI.md) — the normative specification, including the
parts these pages simplify: the declarative request policy, the byte pipeline,
the engine subset, the failure taxonomy.

You do not need it to write a working plugin. You will want it the first time
you need something unusual, and everything here is true at that level too —
these pages are a shorter path to the same contract, not a different one.

Plugin Bridge itself — the runtime, the packager, the adapters that translate
other ecosystems into this same ABI — lives at
[dazacode/plugin-bridge-js](https://github.com/dazacode/plugin-bridge-js) under
Apache-2.0. It is the reference implementation of everything described here.
