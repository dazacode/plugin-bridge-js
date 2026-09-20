# Networking

There is no `fetch`. The network arrives as `ctx.http`, and it is the only way
out.

```ts
interface HttpClient {
	send(url, request?): Promise<HttpResponse>;
	text(url, request?): Promise<string>;
	json<T>(url, request?): Promise<T>;
	policy(policy): Promise<void>;
}
```

`text` and `json` are `send` with the obvious thing done to the response, and
they throw on a non-2xx. Reach for `send` when you need the status or a header.

```ts
const body = await ctx.http.text('https://example.test/page');
const data = await ctx.http.json<{ items: Row[] }>('https://api.example.test/search?q=x');

const response = await ctx.http.send('https://example.test/maybe', {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ q: 'x' })
});
if (response.status === 404) return { entries: [] };
```

## Declared hosts

Every hostname you reach must be in `plugin.json`'s `network.hosts`. A request
elsewhere throws before a packet leaves. Redirects are re-checked at every hop,
so a host you _land_ on needs declaring too.

See [the manifest](manifest.md#networkhosts-is-the-important-one).

## Reading a redirect instead of taking it

Very common when a watch page bounces to the real file:

```ts
const response = await ctx.http.send(url, { follow: false });
const target = response.headers['location'];
```

Without `follow: false` you get the destination's body and never see the
`Location` you wanted.

## Rate limits and retries are declarative

You do not write a sleep loop. You declare a rule and the host holds the
windows and does the waiting — a limiter inside your plugin is one your plugin
could decline to run, so it lives outside.

```ts
await ctx.http.policy({
	rateLimit: { permits: 4, periodMs: 1000 },
	retry: { attempts: 3, onStatus: [429, 502, 503], backoffMs: 500, multiplier: 2 },
	headersByHost: {
		'cdn.example.test': { Referer: 'https://example.test/' }
	}
});
```

Ordering needs no ceremony: a policy declared before a request is in force for
it whether or not you awaited it. Declare it once, at the top of whichever
method runs first.

`headersByHost` is the tidy way to attach a `Referer` to every request to a
particular CDN without threading it through your own code.

## Headers on the _stream_, not the request

Different thing, and the one people miss. If the stream itself needs a header
to play — almost always a `Referer` — it goes on the `PlaybackSource`:

```ts
return [
	{
		url: file,
		container: 'hls',
		headers: { Referer: 'https://example.test/' }
	}
];
```

The host carries those through its own relay for the manifest _and_ every
segment. You do not need to proxy anything yourself.
