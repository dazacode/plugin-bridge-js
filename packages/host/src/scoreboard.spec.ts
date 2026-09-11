/**
 * That the instrument measures the thing it claims to measure.
 *
 * A scoreboard is only worth building if its columns cannot be quietly wrong, so
 * the tests here are the three distinctions ADR-0004 §5 and `FOREIGN.md` §4.1.5
 * turn on — and each of them is a mistake that has actually been made:
 *
 * 1. **Emit rate is not works rate.** A listing that converted and then failed
 *    at step three is not a success and is not the same failure as one that
 *    never converted at all.
 * 2. **Untestable is not failure.** A browse-only format has nothing to learn
 *    from, and counting it as broken makes a whole repository look dead.
 * 3. **Ranked by listings unblocked, not by frequency.** The reason this
 *    project has the number 4-of-254 rather than a coverage curve.
 */

import { describe, expect, it } from 'vitest';

import {
	bucketMessage,
	reachOf,
	renderScoreboard,
	renderWhy,
	score,
	type ScoredListing
} from './scoreboard';

function row(over: Partial<ScoredListing>): ScoredListing {
	return {
		id: 'app.example.one',
		name: 'One',
		format: 'sora',
		version: '1.0.0',
		status: 'works',
		failedAt: null,
		detail: null,
		obstacles: [],
		sites: [],
		searchHits: 0,
		episodeCount: 0,
		streamCount: 0,
		...over
	};
}

describe('what a tally separates', () => {
	it('does not count a conversion that never happened as a step that failed', () => {
		const board = score([
			row({
				id: 'a',
				status: 'broken',
				failedAt: null,
				detail: 'It uses a `super.` call.'
			}),
			row({
				id: 'b',
				status: 'broken',
				failedAt: 'episodes',
				detail: 'no episodes'
			})
		]);

		// The distinction the whole document rests on. One produced no bundle, so
		// none of the five steps ran; the other produced one and it did not work.
		// Merging them would hide whether translator work or runtime work is what
		// moves the number.
		expect(board.totals.wouldNotConvert).toBe(1);
		expect(board.totals.converted).toBe(1);
		expect(board.totals.failed.episodes).toBe(1);
		expect(board.totals.works).toBe(0);
	});

	it('counts a listing that works as converted as well', () => {
		const board = score([row({ status: 'works' })]);

		// `converted` is "a bundle existed", not "a bundle existed and failed".
		// Reading it the other way makes the works column look like a subset of
		// nothing.
		expect(board.totals.converted).toBe(1);
		expect(board.totals.works).toBe(1);
	});

	it('keeps untestable and untested out of the failure columns', () => {
		const board = score([
			row({ id: 'a', status: 'notTestable' }),
			row({ id: 'b', status: 'untested' })
		]);

		expect(board.totals.notTestable).toBe(1);
		expect(board.totals.untested).toBe(1);
		expect(board.totals.wouldNotConvert).toBe(0);
		expect(board.totals.converted).toBe(0);
	});

	it('tallies each format separately and sorts them so two runs diff', () => {
		const board = score([
			row({ id: 'a', format: 'sora' }),
			row({
				id: 'b',
				format: 'aniyomi',
				status: 'broken',
				failedAt: null,
				detail: 'no'
			}),
			row({ id: 'c', format: 'mangayomi', status: 'notTestable' })
		]);

		expect(Object.keys(board.formats)).toEqual(['aniyomi', 'mangayomi', 'sora']);
		expect(board.formats['sora'].works).toBe(1);
		expect(board.formats['aniyomi'].wouldNotConvert).toBe(1);
		expect(board.totals.listings).toBe(3);
	});
});

describe('ranking refusals', () => {
	it('counts listings unblocked rather than how often a construct appears', () => {
		const board = score([
			row({
				id: 'a',
				status: 'broken',
				failedAt: null,
				detail: 'x',
				// The same kind twice in one listing is still one listing.
				obstacles: ['a `super.` call', 'a `super.` call', '.toUriPart()']
			}),
			row({
				id: 'b',
				status: 'broken',
				failedAt: null,
				detail: 'x',
				obstacles: ['.toUriPart()']
			}),
			row({
				id: 'c',
				status: 'broken',
				failedAt: null,
				detail: 'x',
				obstacles: ['.toUriPart()']
			})
		]);

		// By frequency `super.` and `toUriPart` would look comparable. By
		// listings unblocked — the number that chooses the next piece of work —
		// one of them is three times the other.
		expect(board.refusals).toEqual([
			{ reason: '.toUriPart()', listings: 3, kind: 'named' },
			{ reason: 'a `super.` call', listings: 1, kind: 'named' }
		]);
	});

	it('does not let a listing count twice for saying the same thing two ways', () => {
		const board = score([
			row({
				id: 'a',
				status: 'broken',
				failedAt: null,
				detail: 'It uses a `super.` call and one other thing.',
				obstacles: ['a `super.` call']
			})
		]);

		// The sentence is a rendering of the named kinds, so counting both would
		// double the weight of exactly the listings the ranking exists to tell
		// apart.
		expect(board.refusals).toHaveLength(1);
		expect(board.refusals[0].kind).toBe('named');
	});

	it('buckets a sentence only when there is nothing named to rank on', () => {
		const board = score([
			row({
				id: 'a',
				status: 'broken',
				failedAt: null,
				detail: 'The source for Example One could not be found at https://x.invalid/a. Try again.'
			}),
			row({
				id: 'b',
				status: 'broken',
				failedAt: null,
				detail: 'The source for Example One could not be found at https://y.invalid/b. Try again.'
			})
		]);

		// Two instances of one problem, written for a person and therefore
		// carrying different urls. Labelled `message` so a reader knows the
		// grouping is this file's guess and not the translator's word.
		expect(board.refusals).toHaveLength(1);
		expect(board.refusals[0]).toMatchObject({ listings: 2, kind: 'message' });
	});

	it('names the step when a listing converted and then failed', () => {
		const board = score([
			row({
				status: 'broken',
				failedAt: 'reach',
				detail: 'It resolved a stream, but nothing answered.'
			})
		]);

		// A translator problem and a source problem are not the same kind of
		// work, and a ranking that listed them side by side without saying which
		// was which would invite the wrong afternoon.
		expect(board.refusals[0].reason).toBe('at reach — It resolved a stream, but nothing answered.');
	});

	it('leaves a working listing out of the ranking entirely', () => {
		expect(
			score([row({ status: 'works' }), row({ id: 'b', status: 'notTestable' })]).refusals
		).toEqual([]);
	});
});

describe('bucketing a sentence', () => {
	it('removes the parts that make one problem look like several', () => {
		expect(bucketMessage('Example 12 could not be read at https://a.invalid/x.')).toBe(
			'Example <n> could not be read at <url>'
		);
		expect(bucketMessage('It uses `a lambda`, line 4. Converting anyway would be worse.')).toBe(
			'It uses <name>, line <n>.'
		);
	});
});

describe('the table a person reads', () => {
	it('reports the works proportion against what could be tested', () => {
		const rendered = renderScoreboard(
			score([
				row({ id: 'a', status: 'works' }),
				row({ id: 'b', status: 'broken', failedAt: null, detail: 'no' }),
				row({ id: 'c', status: 'broken', failedAt: null, detail: 'no' }),
				row({ id: 'd', status: 'notTestable' })
			])
		);

		// One of the three that could be tested, not one of four. Including the
		// untestable row in the denominator would make every browse-only format
		// drag the number down for a reason that is not about conversion.
		expect(rendered).toContain('33.3%');
	});

	it('says plainly when nothing that converted failed afterwards', () => {
		// `FOREIGN.md` §4.1.6's encouraging half, and the sentence that should
		// stop being printed on the day the losses move.
		expect(renderScoreboard(score([row({ status: 'works' })]))).toContain(
			'Nothing that converted failed afterwards.'
		);
	});

	it('names the step when something did', () => {
		expect(
			renderScoreboard(score([row({ status: 'broken', failedAt: 'reach', detail: 'nothing' })]))
		).toContain('reach 1');
	});
});

describe('the long form', () => {
	it('separates translator work from everything downstream of it', () => {
		const text = renderWhy([
			row({
				id: 'a',
				name: 'Alpha',
				status: 'broken',
				failedAt: null,
				detail: 'Alpha rewrites 1 part of its base class.',
				obstacles: ['object_literal'],
				sites: [
					{
						kind: 'object_literal',
						file: 'src/Alpha.kt',
						member: 'videoListParse',
						line: 12,
						text: 'return object : Video() {}',
						blocking: true
					}
				]
			}),
			row({
				id: 'b',
				name: 'Beta',
				status: 'broken',
				failedAt: 'search',
				detail: 'Nothing answered.',
				searchHits: 0
			})
		]);

		expect(text).toContain('Alpha — would not convert');
		expect(text).toContain('src/Alpha.kt:12  videoListParse  —  object_literal');
		expect(text).toContain('return object : Video() {}');

		expect(text).toContain('Beta — converted, then failed at search');
		// The counts are what tell "searched and found nothing" apart from
		// "never searched", which the step name alone does not.
		expect(text).toContain('reached: 0 search hits, 0 episodes, 0 streams');
	});

	it('puts what blocked it above what merely turned up', () => {
		const text = renderWhy([
			row({
				status: 'broken',
				failedAt: null,
				sites: [
					{
						kind: 'WebView',
						file: 'z.kt',
						member: 'other',
						line: 9,
						text: '',
						blocking: false
					},
					{
						kind: 'Injekt.get',
						file: 'a.kt',
						member: 'client',
						line: 3,
						text: '',
						blocking: true
					}
				]
			})
		]);
		expect(text.indexOf('Injekt.get')).toBeLessThan(text.indexOf('WebView'));
		expect(text).toContain('(not blocking)');
	});

	it('has nothing to say about a run in which nothing failed', () => {
		expect(renderWhy([row({ status: 'works' })])).toBe('Nothing failed.');
	});
});

describe('what stands in the way, as against how far it got', () => {
	// The step a listing reached is the right question while the translator is
	// the thing moving, and the wrong one for deciding what is left: it files an
	// extension this build could support, an extension that needs a browser
	// engine, and an extension whose site is gone all under one heading.
	it('separates a boundary from a backlog item', () => {
		// One native capability is enough: supporting everything else would
		// still leave the listing refused.
		expect(reachOf(row({ status: 'broken', obstacles: ['WebView', '`.trim()`'] }))).toBe('native');
		expect(reachOf(row({ status: 'broken', obstacles: ['javax.crypto'] }))).toBe('native');
		expect(reachOf(row({ status: 'broken', obstacles: ['`.flatMapIndexed()`'] }))).toBe('widen');
	});

	// ADR-0006. Every one of these was already landing in `native` — on a
	// *different* obstacle the same listing happened to also carry, because an
	// extension elaborate enough to run a server usually also decrypts
	// something. Take the cipher away and it read as `widen`, which promises a
	// translator improvement that cannot arrive: the host has no port to bind.
	it('files a plugin that runs its own HTTP server as a boundary', () => {
		for (const obstacle of [
			'`super.getListeningPort()`',
			'`.createLocalUrl()`',
			'`.createProxyUrl()`',
			'`.segmentProxyUrl()`',
			'`.alwaysNeedsProxy()`'
		]) {
			expect(reachOf(row({ status: 'broken', obstacles: [obstacle] }))).toBe('native');
		}
	});

	// ADR-0005 §3 split cookies down the middle: the host now keeps a
	// per-plugin, per-host, in-memory jar, so installing one and saving to one
	// are ordinary conversions and must stop being counted as a boundary.
	// Reading a jar, and the WebView's cookie store, stay refused by design —
	// which is what this column is for.
	it('files only the cookie shapes the jar refuses as a boundary', () => {
		for (const obstacle of [
			'reading a cookie jar',
			'`.loadForRequest()`',
			'the WebView cookie store',
			'`.getCookie()`'
		]) {
			expect(reachOf(row({ status: 'broken', obstacles: [obstacle] }))).toBe('native');
		}
		for (const obstacle of ['`.cookieJar()`', '`.saveFromResponse()`']) {
			expect(reachOf(row({ status: 'broken', obstacles: [obstacle] }))).toBe('widen');
		}
	});

	it('does not count a site that is gone against the converter', () => {
		expect(
			reachOf(
				row({
					status: 'broken',
					failedAt: 'search',
					detail: 'The plugin proxy returned 502: could not reach x.'
				})
			)
		).toBe('unreachable');
		// A source that answered and simply had no results is not the same
		// claim, so it stays unproven rather than being blamed either way.
		expect(
			reachOf(
				row({
					status: 'broken',
					failedAt: 'search',
					detail: 'Searching this source returned nothing.'
				})
			)
		).toBe('unproven');
	});

	it('calls a listing portable only when it actually worked', () => {
		expect(reachOf(row({ status: 'works' }))).toBe('portable');
		expect(reachOf(row({ status: 'notTestable' }))).toBe('absent');
	});

	it('tallies the six alongside the steps', () => {
		const board = score([
			row({ status: 'works' }),
			row({ status: 'broken', obstacles: ['WebView'] }),
			row({ status: 'broken', obstacles: ['`.trim()`'] }),
			row({
				status: 'broken',
				failedAt: 'search',
				detail: 'Searching this source returned nothing.'
			})
		]);

		expect(board.totals.reach).toMatchObject({
			portable: 1,
			native: 1,
			widen: 1,
			unproven: 1
		});
		// And it reaches the rendered report, which is what a person reads.
		expect(renderScoreboard(board)).toContain('What stands in the way');
	});
});
