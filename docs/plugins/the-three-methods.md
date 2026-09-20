# The three methods

```ts
searchCatalog(query, page, ctx)      → CatalogPage
listEpisodes(sourceMediaId, ctx)     → SourceEpisode[]
resolve(sourceMediaId, episode, ctx) → PlaybackSource[]
```

That is the whole surface. There is an optional fourth, `browse(shelf, page,
ctx)`, for sources that publish named rows.

## `searchCatalog`

```ts
async searchCatalog(query, page, ctx) {
	if (page > 1) return { entries: [] };
	const found = await ctx.http.json<Row[]>(`https://api.example.test/search?q=${encodeURIComponent(query)}`);
	return {
		entries: found.map((one) => ({
			sourceMediaId: one.slug,
			title: one.title,
			alternativeTitles: one.aka,
			year: one.year
		}))
	};
}
```

`page` starts at 1. Return an empty page past the end rather than repeating the
last one — that is how the host knows to stop.

**Fill `alternativeTitles` if you have them.** Titles are a weak key: one
catalogue's _Knowing Bros_ is another's _Men on a Mission_, and the host has to
score a match. Every extra spelling is a chance for a viewer's show to bind to
your source instead of quietly failing to.

**`sourceMediaId` is yours.** A slug, an id, a path — whatever this source
calls that show. It comes back to the other two methods unchanged and a viewer
never sees it. Do not mint a canonical id: the host has one from its metadata
provider, and a source claiming to know which show this _is_ would be answering
a question nobody asked.

## `listEpisodes`

```ts
async listEpisodes(sourceMediaId, ctx) {
	const found = await ctx.http.json<Row[]>(`https://api.example.test/show/${sourceMediaId}`);
	return found.map((one) => ({ number: one.n, sourceEpisodeId: one.id, title: one.name }));
}
```

`number` is what a viewer would call it. `sourceEpisodeId` is your handle and
comes back to `resolve`.

**If your source cannot enumerate** — it will answer about an episode when
asked but publishes no list — return a single placeholder:

```ts
return [{ number: 1, sourceEpisodeId: sourceMediaId }];
```

Do **not** return `[]` to mean that. An empty list means "ask me anyway", and
the host then drives `resolve` from its own catalogue; but a source that
returns nothing when it meant "I have this, just not a list" reads as a source
that does not have the show. The placeholder says the true thing.

## `resolve`

```ts
async resolve(sourceMediaId, episode, ctx) {
	const page = await ctx.http.text(`https://api.example.test/watch/${episode.sourceEpisodeId}`);
	return [{ url: extractFile(page), container: 'hls', label: '1080p' }];
}
```

Called at play time, and its result is never stored — so a link that expires in
sixty seconds is fine.

Return **every** address you found, best first. The host tries them in order
and a viewer sees the first that opens, so a second-choice mirror is worth
returning rather than discarding.

### `episode` has two optional fields, and the rule is not guessable

```ts
interface ResolveTarget {
	number: number;
	sourceEpisodeId?: string; // only if you enumerated
	season?: number; // only if you did not
}
```

- `sourceEpisodeId` is there when **you** published a list and a row matched.
  Key on it — you minted it.
- `season` is there when you published **no** list. The host supplies it from
  its own catalogue, because a source addressed as `<id>:<season>:<episode>`
  cannot be asked without one.

A plugin that uses `sourceEpisodeId` when it has one and falls back to `season`
with `number` when it does not works for both kinds of source. Assume neither.

### `container` matters

`'mp4' | 'hls' | 'dash'`. Get it wrong and playback fails in a way that looks
exactly like a dead link. Read it from the URL or the response rather than
defaulting to one.
