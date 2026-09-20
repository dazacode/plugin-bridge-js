# Recipes

Patterns that come up constantly. Each one is runnable — point it at a real
source, declare the host, and `plugin-bridge test .`.

## A JSON API

The easy case, and worth checking for before you reach for the HTML.

```ts
async searchCatalog(query, page, ctx) {
	if (page > 1) return { entries: [] };
	const found = await ctx.http.json<{ results: { id: string; name: string }[] }>(
		`https://api.example.test/search?q=${encodeURIComponent(query)}&page=${page}`
	);
	return {
		entries: (found.results ?? []).map((one) => ({ sourceMediaId: one.id, title: one.name }))
	};
}
```

Note the `?? []`. An API that answers `{}` on a bad query will otherwise throw
inside `.map`, and your plugin fails where the source merely had nothing.

## Scraping HTML

**There is no DOM.** `ctx` carries no HTML parser, and the engine subset does
not provide one — no `DOMParser`, no `document`, no `cheerio` unless you bring
it. You have two honest options.

**Regex, for something simple and well-shaped:**

```ts
async listEpisodes(sourceMediaId, ctx) {
	const page = await ctx.http.text(`https://example.test/show/${sourceMediaId}`);
	const episodes = [];
	const row = /<a[^>]+href="(\/watch\/[^"]+)"[^>]*>\s*Episode\s+(\d+)/gi;
	for (let found = row.exec(page); found !== null; found = row.exec(page)) {
		episodes.push({ number: Number(found[2]), sourceEpisodeId: found[1] });
	}
	return episodes;
}
```

Fine for an attribute you control the shape of. It will break when the markup
moves, and that is the trade you are making.

**Bundle a parser, for anything real.** Your plugin is bundled to one module
before it ships, so a dependency you `import` is compiled in:

```sh
npm install node-html-parser
```

```ts
import { parse } from 'node-html-parser';

const page = await ctx.http.text(url);
const links = parse(page).querySelectorAll('.episode-list a');
```

Pick one with no Node built-ins — the sandbox has no `fs`, no `path`, no
`Buffer`. If the bundle fails to build, that is usually why.

## A stream that needs headers

Extremely common: the file plays only when the request carries a `Referer`.

```ts
async resolve(sourceMediaId, episode, ctx) {
	const page = await ctx.http.text(`https://example.test/watch/${episode.sourceEpisodeId}`);
	const file = /file:\s*"([^"]+)"/.exec(page)?.[1];
	if (file === undefined) return [];

	return [
		{
			url: file,
			container: file.includes('.m3u8') ? 'hls' : 'mp4',
			headers: { Referer: 'https://example.test/' }
		}
	];
}
```

Put the headers on the `PlaybackSource`. The host carries them through its own
relay for the manifest and every segment — you do not proxy anything.

## A watch page that redirects to the file

```ts
const response = await ctx.http.send(url, { follow: false });
const file = response.headers['location'];
```

Without `follow: false` you get the destination's body and never see the
`Location`.

## A source with no episode list

Some sources answer about an episode but publish no list. Say so with a
placeholder rather than an empty array:

```ts
async listEpisodes(sourceMediaId) {
	return [{ number: 1, sourceEpisodeId: sourceMediaId }];
}

async resolve(sourceMediaId, episode, ctx) {
	// The host supplies `season` precisely because you published no list.
	const season = episode.season ?? 1;
	const found = await ctx.http.json<{ file: string }>(
		`https://api.example.test/stream/${sourceMediaId}/${season}/${episode.number}`
	);
	return [{ url: found.file, container: 'hls' }];
}
```

`[]` means "I have nothing for this show", which is a different claim.

## Peer-to-peer sources

If your source really is torrents, hand back the hash and stop:

```ts
return [
	{
		torrent: { infoHash: 'a1b2c3…', sources: trackers },
		label: '1080p WEB-DL'
	}
];
```

Deliberately not a magnet string: a magnet is a URL-shaped value nothing can
fetch, and everything downstream treats a URL as fetchable. Whether that hash
can become a stream is the host's question, behind its own consent and its own
engine — your plugin does not acquire anything.

Only reach for this if the source is genuinely peer-to-peer. A direct address
is better for a viewer every time.

## Hashing and encoding

No `atob`, no `btoa`, no `crypto` global. Use `ctx`:

```ts
const key = ctx.bytes.fromHex('00112233445566778899aabbccddeeff');
const plain = await ctx.crypto.decryptAesCbc(key, iv, data);
const text = ctx.text.decode(plain);
const digest = ctx.bytes.toHex(await ctx.crypto.digest('SHA-256', ctx.text.encode(value)));
```
