/**
 * `ABI.md` §9.1 as a host must read it, driven by the published vectors in
 * `contract/fixtures/level-3/image-headers.json` — the same file a client's
 * own conformance test imports, so the two hosts are held to one answer.
 */
import { describe, expect, it } from 'vitest';

import vectors from '../../../contract/fixtures/level-3/image-headers.json';
import {
	imageHeadersFor,
	readCatalogImages,
	readChapterImages,
	readImageHeadersByHost
} from './image-headers';

describe('image headers a level-3 host applies', () => {
	for (const one of vectors.apply as unknown as {
		name: string;
		url: string;
		own?: Record<string, string>;
		byHost?: Record<string, Record<string, string>>;
		expected: Record<string, string>;
	}[]) {
		it(one.name, () => {
			const byHost =
				one.byHost === undefined ? undefined : readImageHeadersByHost(one.byHost, 'byHost');
			expect(imageHeadersFor(one.url, one.own, byHost)).toEqual(one.expected);
		});
	}

	for (const one of vectors.refuse as { name: string; field: string; value: unknown }[]) {
		it(`refuses ${one.name}, naming the field`, () => {
			const read = one.field === 'chapter' ? readChapterImages : readCatalogImages;
			expect(() => read(one.value)).toThrow(/Image headers: /);
		});
	}

	it('reads a valid chapter and catalogue page through unchanged but for case', () => {
		expect(
			readChapterImages({
				pages: [{ index: 0, url: 'https://cdn.example.invalid/1.jpg', headers: { Referer: 'r' } }],
				headersByHost: { '*.example.invalid': { Accept: 'image/webp' } }
			})
		).toEqual({
			pages: [{ index: 0, url: 'https://cdn.example.invalid/1.jpg', headers: { referer: 'r' } }],
			headersByHost: { '*.example.invalid': { accept: 'image/webp' } }
		});
		expect(
			readCatalogImages({
				entries: [
					{
						posterImageUrl: 'https://cdn.example.invalid/c.jpg',
						posterImageHeaders: { Referer: 'r' }
					}
				]
			})
		).toEqual({
			entries: [
				{
					posterImageUrl: 'https://cdn.example.invalid/c.jpg',
					posterImageHeaders: { referer: 'r' }
				}
			]
		});
	});
});
