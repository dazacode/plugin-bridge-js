# Your first plugin

We are going to write a plugin against a real API, run it, and package it.

The API here is GitHub's, which is obviously not a video source — it is used
because it is public, stable, needs no key, and lets you see every step work
before you point the same code at whatever you actually care about.
Repositories stand in for shows and commits for episodes.

## 1. Scaffold

```sh
plugin-bridge init my-plugin
cd my-plugin
```

You get four files:

```
plugin.json       id, version, and the hosts you are allowed to reach
src/index.ts      the three methods
src/yorozo.ts     the types, copied in so this builds with nothing installed
tsconfig.json
```

`src/yorozo.ts` is the SDK. It is copied rather than installed so that the
scaffold builds in an empty directory — there is nothing to `npm install`.

## 2. Declare where you are allowed to go

Open `plugin.json` and set the host:

```json
{
	"id": "com.example.plugins.myplugin",
	"name": "my-plugin",
	"version": "0.1.0",
	"network": { "hosts": ["api.github.com"] },
	"testQuery": "plugin-bridge"
}
```

`testQuery` is what `plugin-bridge test` searches for when you do not pass
`--query`. It is for you; it is not part of the bundle.

Get `network.hosts` wrong and you will find out immediately — a request to an
undeclared host throws, and `test` prints the host it wanted.

## 3. Write the three methods

Replace `src/index.ts`:

```ts
import { defineSource } from './yorozo';

const HEADERS = {
	Accept: 'application/vnd.github+json',
	'User-Agent': 'yorozo-plugin-example'
};

export default defineSource({
	id: 'com.example.plugins.myplugin',

	async searchCatalog(query, page, ctx) {
		// One page is enough for this example. Returning an empty page for
		// anything past the end is how the host knows to stop asking.
		if (page > 1) return { entries: [] };

		const found = await ctx.http.json<{ items: { full_name: string }[] }>(
			`https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=5`,
			{ headers: HEADERS }
		);

		return {
			entries: (found.items ?? []).map((one) => ({
				sourceMediaId: one.full_name,
				title: one.full_name
			}))
		};
	},

	async listEpisodes(sourceMediaId, ctx) {
		const found = await ctx.http.json<{ sha: string; commit: { message: string } }[]>(
			`https://api.github.com/repos/${sourceMediaId}/commits?per_page=5`,
			{ headers: HEADERS }
		);

		return (found ?? []).map((one, index) => ({
			number: index + 1,
			sourceEpisodeId: one.sha,
			title: one.commit.message.split('\n')[0].slice(0, 64)
		}));
	},

	async resolve(sourceMediaId, episode, ctx) {
		ctx.log.debug(`resolving ${sourceMediaId} episode ${episode.number}`);

		return [
			{
				url: `https://api.github.com/repos/${sourceMediaId}/tarball/${episode.sourceEpisodeId}`,
				container: 'mp4',
				label: 'source tarball'
			}
		];
	}
});
```

Three things worth noticing.

**`sourceMediaId` is yours.** It is whatever this source calls a show — a slug,
a number, a path. It comes back to `listEpisodes` and `resolve` unchanged and a
viewer never sees it. Do not try to return a canonical id; the host has its own
from its metadata provider, and a plugin claiming to know which show this _is_
would be answering a question it was not asked.

**`sourceEpisodeId` is yours too**, and it is what `resolve` should key on when
you published a list.

**`ctx.http.json` is the network.** There is no `fetch`. The client is `send`,
`text`, `json` and `policy` — nothing else — and every call goes through the
host, which is where the declared-host check happens.

## 4. Run it

```sh
plugin-bridge test .
```

```
my-plugin 0.1.0
  packaged      2716 bytes
  declared      1 host(s): api.github.com
  searched      "plugin-bridge" → 5 result(s)
  episodes      5
  resolved      1 stream(s)

All five steps passed. `plugin-bridge pack .` when you are ready.
```

If a step fails, `test` names it and prints your plugin's own message. That is
the loop: change something, run `test`, read what it actually answered.

## 5. Package it

```sh
plugin-bridge pack .
plugin-bridge validate com.example.plugins.myplugin-0.1.0.yorozoplugin
```

```
id: com.example.plugins.myplugin
version: 0.1.0
digest: 448926fecb84815bbf48a8679085c939e3d69fc1d7b6bcd7df7f5931d12352a8
hosts: api.github.com
permissions: network
```

That file is the whole plugin. `validate` reads it back and checks its digests,
which is also what a host does before installing one.

## Now point it at something real

The shape does not change. Replace the three URLs, replace the parsing, put the
new hostname in `network.hosts`, and run `test` again.

For a source that serves HTML rather than JSON, see
[Recipes](recipes.md#scraping-html). For one that needs a `Referer` on the
stream, see [Recipes](recipes.md#a-stream-that-needs-headers) — that is very
common and the host handles it for you.
