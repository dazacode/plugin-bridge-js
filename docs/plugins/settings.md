# Settings

Ask a viewer for a mirror, a language, a quality preference, an API token.

Declare them in `plugin.json`:

```json
"settings": [
	{
		"id": "mirror",
		"type": "select",
		"label": "Mirror",
		"default": "one",
		"options": [
			{ "value": "one", "label": "Mirror one" },
			{ "value": "two", "label": "Mirror two" }
		]
	},
	{ "id": "prefer_dub", "type": "switch", "label": "Prefer dubbed", "default": false },
	{ "id": "api_token", "type": "text", "label": "API token", "help": "From your account page." }
]
```

Read them by `id`:

```ts
const mirror = ctx.settings.string('mirror'); // '' when unset
const dubbed = ctx.settings.boolean('prefer_dub'); // false when unset
const langs = ctx.settings.list('languages'); // [] when unset
```

Four types: `select`, `multiselect`, `switch`, `text`.

## Two things about how they work

**Values are resolved once, before your plugin starts.** There is no way to be
told one changed — changing a setting restarts the plugin, which is the only
way a scrape sees a consistent value. So read them wherever you like.

**An id the manifest does not declare reads as unset.** Not an error, and not a
warning. If `ctx.settings.string('mirrror')` returns `''` forever, check the
spelling against the manifest.

## Prove the setting actually does something

A setting can be declared, delivered, and ignored — and everything looks fine,
because your plugin still works on its defaults. That is a real failure mode
and it is invisible to a normal test run.

If a setting changes _what your plugin returns_ — a mirror, a language, a
credential that unlocks direct links — test it by effect:

```sh
plugin-bridge test .                    # with the default
# change the default in plugin.json
plugin-bridge test .                    # and confirm the answer changed
```

If both runs produce identical output, your plugin is not reading the setting,
whatever the manifest says.
