/**
 * Everything you need to write a Yorozo source plugin, and nothing else.
 *
 * A plugin is one ES2020 module with a default export. It answers three
 * questions about a show — what matches a search, what episodes exist, and
 * where one plays — and it has no other powers: no screens, no storage of
 * urls, no background work, no way to reach the network except through the
 * `ctx` it is handed on each call.
 *
 * ```ts
 * import { defineSource } from '@yorozo/plugin-sdk';
 *
 * export default defineSource({
 *   id: 'com.example.plugins.example',
 *
 *   async searchCatalog(query, page, ctx) {
 *     const found = await ctx.http.json<{ items: { slug: string; name: string }[] }>(
 *       `https://example.test/search?q=${encodeURIComponent(query)}`
 *     );
 *     return { entries: found.items.map((one) => ({ sourceMediaId: one.slug, title: one.name })) };
 *   },
 *
 *   async listEpisodes(sourceMediaId, ctx) {
 *     const found = await ctx.http.json<{ episodes: { id: string; n: number }[] }>(
 *       `https://example.test/show/${sourceMediaId}`
 *     );
 *     return found.episodes.map((one) => ({ number: one.n, sourceEpisodeId: one.id }));
 *   },
 *
 *   async resolve(sourceMediaId, episode, ctx) {
 *     const found = await ctx.http.json<{ file: string }>(
 *       `https://example.test/watch/${episode.sourceEpisodeId}`
 *     );
 *     return [{ url: found.file, container: 'hls', label: '1080p' }];
 *   }
 * });
 * ```
 *
 * The full contract, including the parts this file cannot express in types —
 * the request policy, the byte pipeline, the engine subset — is `ABI.md` in
 * the Plugin Bridge repository. You do not need to read it to write a working
 * plugin. You will want it when you need something unusual.
 */

/* -------------------------------------------------------------------------
 * What a plugin answers with
 * ---------------------------------------------------------------------- */

/**
 * One show, as *this source* knows it.
 *
 * `sourceMediaId` is whatever this source calls it — a slug, a numeric id, a
 * path. It is handed back to `listEpisodes` and `resolve` unchanged, and it is
 * never shown to a viewer. Do not invent a canonical id: the host has its own,
 * from its metadata provider, and a plugin that mints one would be claiming to
 * know which show this is.
 */
export interface SourceCatalogEntry {
	readonly sourceMediaId: string;
	readonly title: string;
	/**
	 * Other names the same show goes by, which the matcher scores against.
	 *
	 * Worth filling. Titles are a weak key — one catalogue's *Knowing Bros* is
	 * another's *Men on a Mission* — and every extra spelling is a chance for
	 * a viewer's show to bind to your source instead of failing to.
	 */
	readonly alternativeTitles?: readonly string[];
	readonly posterImageUrl?: string;
	readonly year?: number;
	readonly episodeCount?: number;
}

/** A page of search or browse results. */
export interface CatalogPage {
	readonly entries?: readonly SourceCatalogEntry[];
}

/**
 * One episode this source holds.
 *
 * `number` is what a viewer would call it. `sourceEpisodeId` is your own
 * handle for it and comes back to `resolve` unchanged.
 *
 * Return `[]` only when the source genuinely has no episodes for that show.
 * If your source cannot enumerate — it answers about an episode when asked but
 * publishes no list — return a single `{ number: 1, sourceEpisodeId }` instead.
 * An empty list means "ask me anyway", and the host then drives `resolve` from
 * its own catalogue; returning nothing when you meant that is read as the show
 * being absent.
 */
export interface SourceEpisode {
	readonly number: number;
	readonly sourceEpisodeId: string;
	readonly title?: string;
	/** ISO 8601. A date that will not parse is dropped rather than guessed at. */
	readonly airedAt?: string;
	readonly isFiller?: boolean;
	readonly isRecap?: boolean;
	readonly thumbnailUrl?: string;
	readonly durationSeconds?: number;
}

/**
 * Which episode `resolve` is being asked about.
 *
 * The two optional fields are very nearly mutually exclusive, and the rule is
 * not guessable, so it is written down here:
 *
 * - `sourceEpisodeId` is present when **you** published an episode list and one
 *   of your rows matched. It is that row's id and it is the best thing to key
 *   on, because you minted it.
 * - `season` is present when you published **no** list. The host then supplies
 *   the season from its own catalogue, because a source addressed as
 *   `<id>:<season>:<episode>` cannot be asked without one.
 *
 * A plugin that uses `sourceEpisodeId` when it has one and falls back to
 * `season` with `number` when it does not works for both kinds of source.
 * Neither field may be assumed present.
 */
export interface ResolveTarget {
	readonly number: number;
	readonly sourceEpisodeId?: string;
	readonly season?: number;
}

/** A subtitle track, alongside a stream. */
export interface SubtitleTrack {
	readonly url: string;
	/** BCP-47 where you know it. */
	readonly language?: string;
	readonly label?: string;
	readonly format?: 'vtt' | 'srt' | 'ass';
}

/**
 * A playable address.
 *
 * `container` is what the player opens it as. Get it wrong and playback fails
 * in a way that looks like a dead link, so read it from the url or from the
 * response rather than defaulting.
 *
 * `headers` are sent with every request for this stream and its segments. This
 * is where a `Referer` goes — a very common requirement, and the host carries
 * it through its own relay rather than making you proxy anything.
 */
export interface PlaybackSource {
	readonly url: string;
	readonly container?: 'mp4' | 'hls' | 'dash';
	readonly label?: string;
	readonly quality?: string;
	readonly heightPx?: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly subtitles?: readonly SubtitleTrack[];
}

/**
 * A torrent, when that is genuinely what your source has.
 *
 * Deliberately not a url and deliberately not a magnet string: a magnet is a
 * url-shaped value that nothing can fetch, and everything downstream treats a
 * url as fetchable. Hand back the hash and stop — whether it can become a
 * stream is the host's question, behind its own consent and its own engine.
 *
 * Do not reach for this unless your source really is peer-to-peer. A direct
 * address is better for a viewer in every case.
 */
export interface TorrentDescriptor {
	/** Lowercased hex, 40 characters. */
	readonly infoHash: string;
	readonly fileIdx?: number;
	/** Trackers the source offered, verbatim. */
	readonly sources?: readonly string[];
}

/** What `resolve` answers with when the source is peer-to-peer. */
export interface TorrentPlaybackSource {
	readonly torrent: TorrentDescriptor;
	readonly label?: string;
	readonly quality?: string;
	readonly heightPx?: number;
	readonly subtitles?: readonly SubtitleTrack[];
}

/** Either kind of answer. Most sources only ever return the first. */
export type ResolvedSource = PlaybackSource | TorrentPlaybackSource;

/* -------------------------------------------------------------------------
 * `ctx` — the only capability a plugin has
 * ---------------------------------------------------------------------- */

export interface HttpResponse {
	readonly status: number;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	text(): Promise<string>;
	json<T = unknown>(): Promise<T>;
}

export interface HttpRequest {
	readonly method?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
	/**
	 * `false` returns a 3xx as the answer instead of taking it, so you can read
	 * its `Location` out of `response.headers`. Redirects are followed by
	 * default, and every hop is re-checked against your declared hosts.
	 */
	readonly follow?: boolean;
}

/**
 * A rule the host applies to your requests, rather than code you write.
 *
 * Declared once and enforced outside your plugin, so a retry, a rate limit or
 * a redirect that is *not* followed all happen whether or not your own code
 * remembered to. See `ABI.md` §2.1; most plugins never set one.
 */
export interface RateLimitRule {
	/** 1–1000. */
	readonly permits: number;
	/** 1–600000. */
	readonly periodMs: number;
}

/**
 * Rules the host applies to your requests, rather than code you write.
 *
 * Declared once and enforced outside your plugin, so a retry or a wait happens
 * whether or not your own code remembered to — and a limiter inside the isolate
 * would be one the isolate could decline to run. Most plugins never set one.
 *
 * Ordering needs no ceremony: a policy declared before a request is in force
 * for it whether or not you awaited this.
 */
export interface RequestPolicy {
	readonly retry?: {
		/** Total attempts including the first, 1–5. */
		readonly attempts: number;
		/** Statuses worth asking again, 100–599. */
		readonly onStatus: readonly number[];
		/** Wait before the second attempt, 0–60000. */
		readonly backoffMs: number;
		/** Each further wait times this, 1–10. Default 1. */
		readonly multiplier?: number;
	};
	/** Every request this plugin makes. */
	readonly rateLimit?: RateLimitRule;
	/** And, in addition, per host. */
	readonly rateLimitByHost?: Readonly<Record<string, RateLimitRule>>;
	readonly headersByHost?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * The network, and the only one there is.
 *
 * Every address you reach must be declared in the manifest's `network.hosts`.
 * That is not a formality: a viewer is shown that list before installing, and
 * a request to anything else throws before a packet leaves. If your source
 * redirects to a host you did not declare, declare that one too.
 *
 * `text` and `json` are `send` with the obvious thing done to the response —
 * use them, and reach for `send` when you need the status or a header.
 */
export interface HttpClient {
	send(url: string, request?: HttpRequest): Promise<HttpResponse>;
	text(url: string, request?: HttpRequest): Promise<string>;
	json<T = unknown>(url: string, request?: HttpRequest): Promise<T>;
	policy(policy: RequestPolicy): Promise<void>;
}

/**
 * The viewer's answers to what your manifest declared, read by manifest id.
 *
 * Resolved once, before your plugin starts. There is no way to be told a value
 * changed — changing one restarts the plugin, which is the only way it is
 * coherent — so read them whenever you like.
 */
export interface SettingsView {
	/** `''` when unset. */
	string(id: string): string;
	/** `false` when unset. */
	boolean(id: string): boolean;
	/** `[]` when unset. */
	list(id: string): string[];
}

/** A small key/value store, yours alone, capped at 64 KiB. */
export interface KeyValueStore {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * Two levels, one string each. There is no `info` and no `error`.
 *
 * `console.log`, `console.warn` and friends also work and are routed to the
 * same place — the host captures the console rather than leaving it attached to
 * one, and caps how much a plugin may emit per load so that a noisy plugin
 * cannot flood the log it shares with everything else.
 */
export interface Logger {
	debug(message: string): void;
	warn(message: string): void;
}

export interface TextCodecs {
	encode(value: string): Uint8Array;
	decode(bytes: Uint8Array): string;
}

export interface ByteCodecs {
	toBase64(bytes: Uint8Array): string;
	fromBase64(value: string): Uint8Array;
	toHex(bytes: Uint8Array): string;
	fromHex(value: string): Uint8Array;
}

/** WebCrypto, one named operation at a time. */
export interface CryptoPrimitives {
	digest(algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512', data: Uint8Array): Promise<Uint8Array>;
	hmac(
		algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512',
		key: Uint8Array,
		data: Uint8Array
	): Promise<Uint8Array>;
	decryptAesCbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
}

/**
 * Everything your plugin is allowed to do, handed to it on every call.
 *
 * There are no ambient globals. No `fetch`, no `window`, no `document`, no
 * `localStorage`, no timers you can hold across calls. If it is not on this
 * object, your plugin does not have it — which is the property that lets a
 * viewer install a plugin without auditing it.
 */
export interface SourceContext {
	readonly http: HttpClient;
	readonly settings: SettingsView;
	readonly storage: KeyValueStore;
	readonly log: Logger;
	/** Aborted when the host gives up on this call. Pass it to long work. */
	readonly signal: AbortSignal;
	readonly text: TextCodecs;
	readonly bytes: ByteCodecs;
	readonly crypto: CryptoPrimitives;
	/** BCP-47, and it may lack a region. */
	readonly locale: string;
}

/* -------------------------------------------------------------------------
 * The plugin itself
 * ---------------------------------------------------------------------- */

export interface SourcePlugin {
	/** Must equal the manifest's `id`, exactly. */
	readonly id: string;

	/**
	 * What matches this query.
	 *
	 * `page` starts at 1. Return `{ entries: [] }` for a page past the end
	 * rather than repeating the last one, which is how the host knows to stop.
	 */
	searchCatalog(query: string, page: number, ctx: SourceContext): Promise<CatalogPage>;

	/** Every episode this source holds for that show. */
	listEpisodes(sourceMediaId: string, ctx: SourceContext): Promise<readonly SourceEpisode[]>;

	/**
	 * Where this episode plays, right now.
	 *
	 * Called at play time and its result is never stored, so a link that
	 * expires in sixty seconds is fine. Return every address you found, best
	 * first — the host tries them in order and a viewer sees the first that
	 * opens.
	 */
	resolve(
		sourceMediaId: string,
		episode: ResolveTarget,
		ctx: SourceContext
	): Promise<readonly ResolvedSource[]>;

	/** Optional. A named shelf, for sources that publish browsable rows. */
	browse?(shelf: string, page: number, ctx: SourceContext): Promise<CatalogPage>;
}

/**
 * Declares a plugin.
 *
 * Does nothing at runtime but give you types and a single obvious place for
 * the host to find your implementation. It exists so that a mistake in the
 * shape of your plugin is a red squiggle in your editor rather than a failure
 * on somebody's phone.
 */
export function defineSource(plugin: SourcePlugin): SourcePlugin {
	return plugin;
}
