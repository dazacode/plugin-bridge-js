/**
 * What a Seanime provider is handed besides `fetch`: the host's document API
 * and the user's preferences.
 *
 * The document API is pinned where goquery and the shared parser disagree,
 * because those are the places a provider written against one reads the other
 * wrong without an error — a self-match in `find`, a normalised `text()`, an
 * empty string for a missing attribute. No real site appears here (AGENTS.md
 * rule 9).
 */
import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { seanimeEntrypoint, type SeanimePreference } from './seanime-entry';

let counter = 0;

function context(values: Record<string, string | boolean> = {}) {
	return {
		http: { send: async () => ({ status: 200, url: '', headers: {}, text: () => '' }) },
		settings: {
			string: (id: string) => (typeof values[id] === 'string' ? values[id] : ''),
			boolean: (id: string) => values[id] === true,
			list: () => []
		},
		log: { info: () => {}, warn: () => {}, error: () => {} }
	};
}

interface Loaded {
	searchCatalog(
		query: string,
		page: number,
		ctx: unknown
	): Promise<{ entries: { sourceMediaId: string; title: string }[] }>;
}

/**
 * A provider whose search answers whatever `probe` computes, as one row whose
 * title is the JSON of it — so a test reads back exactly what the payload saw.
 */
async function probe(body: string, preferences: SeanimePreference[] = [], values = {}) {
	const script = `class Provider {
  async search(opts) {
    const answer = (function () { ${body} })();
    return [{ id: 'x', title: JSON.stringify(answer === undefined ? null : answer) }];
  }
  async findEpisodes() { return []; }
  async findEpisodeServer() { return { sources: [] }; }
}`;
	const source = seanimeEntrypoint({
		pluginId: 'test.seanime',
		script,
		serves: 'anime',
		preferences
	});
	const dir = join(tmpdir(), 'seanime-spec');
	await mkdir(dir, { recursive: true });
	const path = join(dir, `bundle-${(counter += 1)}.mjs`);
	await writeFile(path, source);
	const loaded = (await import(path)).default as Loaded;
	const page = await loaded.searchCatalog('q', 1, context(values));
	return JSON.parse(page.entries[0].title) as unknown;
}

const HTML = `<html><body>
<div class="outer" data-kind="list"><div class="card" data-id="1"><a href="/one">  One <b>bold</b>
</a><img src="/1.jpg"></div><div class="card" data-id="2"><a href="/two">Two</a><!-- note --></div></div>
<ul><li class="a">a</li><li class="b">b</li><li class="c">c</li><li class="d">d</li></ul>
<script>var x = 1;</script>
</body></html>`;

describe('LoadDoc, as goquery answers', () => {
	it('finds below each element, never the element itself', async () => {
		expect(
			await probe(
				`const $ = LoadDoc(${JSON.stringify(HTML)}); return $('div.outer').find('div').length();`
			)
		).toBe(2);
	});

	it('reads text as written, across the selection, without comments', async () => {
		expect(
			await probe(
				`const $ = LoadDoc(${JSON.stringify(HTML)}); return [$('.card a').text(), $('.card').eq(1).text()];`
			)
		).toEqual(['  One bold\nTwo', 'Two']);
	});

	it('includes a script body in text, as goquery does', async () => {
		expect(await probe(`return LoadDoc(${JSON.stringify(HTML)})('script').text();`)).toBe(
			'var x = 1;'
		);
	});

	it('answers undefined for an attribute that is not there', async () => {
		expect(
			await probe(`const $ = LoadDoc(${JSON.stringify(HTML)});
return [$('.card').first().attr('data-id'), $('.card').attr('title') === undefined, $('.none').attr('x') === undefined];`)
		).toEqual(['1', true, true]);
	});

	it('walks with each and map, handing a selection and its index', async () => {
		expect(
			await probe(`const $ = LoadDoc(${JSON.stringify(HTML)});
const seen = [];
$('li').each((i, el) => { seen.push(i + ':' + el.text()); });
return [seen, $('li').map((i, el) => el.attr('class'))];`)
		).toEqual([
			['0:a', '1:b', '2:c', '3:d'],
			['a', 'b', 'c', 'd']
		]);
	});

	it('counts eq back from the end, and filters by selector or by function', async () => {
		expect(
			await probe(`const $ = LoadDoc(${JSON.stringify(HTML)});
return [
  $('li').eq(-1).text(),
  $('li').filter('.b, .c').length(),
  $('li').filter((i, el) => el.text() === 'd').text(),
  $('li').not('.a').length(),
  $('li').is('.c'),
  $('.card').has('img').attr('data-id')
];`)
		).toEqual(['d', 2, 'd', 3, true, '1']);
	});

	it('moves through the tree', async () => {
		expect(
			await probe(`const $ = LoadDoc(${JSON.stringify(HTML)});
return [
  $('li.a').next().text(),
  $('li.c').prev().text(),
  $('li.a').nextAll().length(),
  $('li.a').nextUntil('.c').length(),
  $('li.b').siblings().length(),
  $('img').parent().attr('data-id'),
  $('img').closest('.outer').data('kind'),
  $('.outer').children('.card').length(),
  $('a').first().parents('.outer').length(),
  $('li.a').next().end().text()
];`)
		).toEqual(['b', 'b', 3, 1, 3, '1', 'list', 2, 1, 'a']);
	});

	it('reads html and attrs of the first element only', async () => {
		expect(
			await probe(`const $ = LoadDoc(${JSON.stringify(HTML)});
return [$('li').html(), $('li').attrs(), $('.none').html()];`)
		).toEqual(['a', { class: 'a' }, null]);
	});

	it('answers new Doc(html) as a selection of the document', async () => {
		expect(await probe(`return new Doc(${JSON.stringify(HTML)}).find('li').length();`)).toBe(4);
	});
});

describe('$getUserPreference', () => {
	const PREFERENCES: SeanimePreference[] = [
		{ key: 'apiUrl', id: 'apiurl', type: 'text' },
		{ key: 'dub-only', id: 'dub_only', type: 'switch' },
		{ key: 'quality', id: 'quality', type: 'select' }
	];

	it('reads each declared key from the settings the host resolved', async () => {
		expect(
			await probe(
				`return [$getUserPreference('apiUrl'), $getUserPreference('dub-only'), $getUserPreference('quality')];`,
				PREFERENCES,
				{ apiurl: 'https://alt.example.invalid', dub_only: true, quality: '720' }
			)
		).toEqual(['https://alt.example.invalid', 'true', '720']);
	});

	it("leaves an author's fallback to apply when nothing is set", async () => {
		expect(
			await probe(
				`return [$getUserPreference('apiUrl') ?? 'fallback', $getUserPreference('dub-only'), $getUserPreference('undeclared') === undefined];`,
				PREFERENCES
			)
		).toEqual(['fallback', 'false', true]);
	});
});

async function loadProvider(script: string, serves: 'anime' | 'torrent') {
	const source = seanimeEntrypoint({ pluginId: 'test.seanime', script, serves });
	const dir = join(tmpdir(), 'seanime-spec');
	await mkdir(dir, { recursive: true });
	const path = join(dir, `bundle-${(counter += 1)}.mjs`);
	await writeFile(path, source);
	return (await import(path)).default as {
		listEpisodes(id: string, ctx: unknown): Promise<{ number: number; sourceEpisodeId: string }[]>;
		resolve(
			id: string,
			episode: unknown,
			ctx: unknown
		): Promise<{ torrent: { infoHash: string }; label: string }[]>;
	};
}

describe('a torrent provider, handed the show the host bound', () => {
	// Answers one torrent whose name is what it was asked, so the test reads
	// back the query and the media id the provider saw.
	const TORRENT = `class Provider {
  async search(opts) {
    return [{ name: opts.query + '#' + opts.media.id, infoHash: '${'a'.repeat(40)}' }];
  }
}`;

	it("reads the AniList id out of the host's reference into media.id", async () => {
		const provider = await loadProvider(TORRENT, 'torrent');
		const sources = await provider.resolve(
			'anilist:21|One Piece',
			{ number: 5, sourceEpisodeId: 'anilist:21|One Piece', title: 'Episode 5' },
			context()
		);
		expect(sources.map((one) => one.label)).toEqual(['One Piece#21']);
	});

	it('searches by the bare title, id zero, when the host bound by title', async () => {
		const provider = await loadProvider(TORRENT, 'torrent');
		const sources = await provider.resolve(
			'One Piece',
			{ number: 1, sourceEpisodeId: 'One Piece', title: 'Episode 1' },
			context()
		);
		expect(sources.map((one) => one.label)).toEqual(['One Piece#0']);
	});
});

describe('episode numbers a provider did not state', () => {
	const list = (rows: unknown[]) => `class Provider {
  async search() { return []; }
  async findEpisodes() { return ${JSON.stringify(rows)}; }
  async findEpisodeServer() { return { sources: [] }; }
}`;

	it('places an unnumbered row between its numbered neighbours, never on one', async () => {
		const provider = await loadProvider(
			list([
				{ id: 'a', number: 1 },
				{ id: 'b', number: 2 },
				{ id: 'extra' },
				{ id: 'c', number: 3 }
			]),
			'anime'
		);
		const episodes = await provider.listEpisodes('x', context());
		expect(episodes.map((one) => [one.sourceEpisodeId, one.number])).toEqual([
			['a', 1],
			['b', 2],
			['extra', 2.5],
			['c', 3]
		]);
	});

	it('keeps a stated zero, and counts a list that states nothing from the start', async () => {
		const zero = await loadProvider(
			list([
				{ id: 'p', number: 0 },
				{ id: 'a', number: 1 }
			]),
			'anime'
		);
		expect((await zero.listEpisodes('x', context())).map((one) => one.number)).toEqual([0, 1]);

		const bare = await loadProvider(list([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), 'anime');
		expect(
			(await bare.listEpisodes('x', context())).map((one) => [one.sourceEpisodeId, one.number])
		).toEqual([
			['a', 1],
			['b', 2],
			['c', 3]
		]);
	});
});
