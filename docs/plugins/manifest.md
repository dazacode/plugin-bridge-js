# The manifest

`plugin.json` is what a viewer sees before they install anything. It is also
what the host enforces at runtime, so it is not documentation — it is a
contract with consequences.

## What you write

```json
{
	"$schema": "https://raw.githubusercontent.com/dazacode/plugin-bridge-js/master/contract/yorozo-plugin.schema.json",
	"id": "com.example.plugins.myplugin",
	"name": "My Plugin",
	"description": "What this source is, in one line.",
	"version": "0.1.0",
	"author": { "name": "you", "url": "https://example.test" },
	"license": "MIT",
	"network": { "hosts": ["api.example.test", "cdn.example.test"] },
	"settings": [],
	"testQuery": "cowboy bebop"
}
```

Keep the `$schema` line. Every editor worth using will then autocomplete the
rest and underline your mistakes before you run anything.

| field           |                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | reverse-DNS, and it must equal the `id` your plugin exports. A host keys everything on it, so changing it later is a different plugin |
| `version`       | semver. A host compares it to decide whether an update is available                                                                   |
| `license`       | SPDX. Omitted, a bundle packages as `NOASSERTION`, which tells a reader nothing about what they may do with your work                 |
| `network.hosts` | every hostname you reach. See below                                                                                                   |
| `settings`      | what you want to ask a viewer — see [Settings](settings.md)                                                                           |
| `testQuery`     | for `plugin-bridge test` only. Not part of the bundle                                                                                 |

## `network.hosts` is the important one

```json
"network": { "hosts": ["api.example.test", "*.cdn.example.test"] }
```

A request to a host not on this list throws before a packet leaves. Not a
warning — the request does not happen.

This exists so that installing a plugin is a decision someone can actually
make. A viewer is shown this list, and the list is the honest answer to "what
can this thing reach". A plugin cannot opt out of the check by not using the
SDK, because the check is the host's.

Three things people get wrong:

- **Redirects count.** If your search redirects to a different host, declare
  that one too. The host you _land_ on is the one being reached.
- **CDNs count.** If your stream URLs are on a different domain from your API,
  declare both.
- **Wildcards are one level.** `*.example.test` matches `cdn.example.test`, not
  `example.test` itself. Declare both if you use both.

If you are not sure what you reach, run `plugin-bridge test .` — an undeclared
host is reported with the name it wanted.

## What the packager fills in

You do not write these; `pack` adds them:

```json
"schemaVersion": 1,
"yorozoPluginApi": 1,
"minimumYorozoVersion": "0.0.0",
"platforms": ["android", "ios", "macos", "windows", "linux", "web"],
"capabilities": ["search", "episodes", "resolve"],
"permissions": ["network"],
"entrypoint": "source"
```

`capabilities` and `permissions` are derived from what your plugin actually
declares and uses, which is why they are not yours to assert.
