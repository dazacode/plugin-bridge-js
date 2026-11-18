/**
 * `ABI.md` §9.1 as a host must read it, driven by the published vectors in
 * `contract/fixtures/level-3/image-headers.json` — the same file a client's
 * own conformance test imports, so the two hosts are held to one answer.
 */
import { describe, expect, it } from 'vitest';

import vectors from '../../../contract/fixtures/level-3/image-headers.json';
import {
	grantedImageHeaders,
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

describe('the headers a host sends with one plugin image', () => {
	const grant = { declared: ['read.example.invalid', '*.cdn.example.invalid'] };
	const byHost = {
		'*.cdn.example.invalid': { referer: 'https://read.example.invalid/', cookie: 'k=v' }
	};

	it('applies them inside the grant and nowhere else', () => {
		expect(
			grantedImageHeaders('https://a.cdn.example.invalid/1.jpg', undefined, byHost, grant)
		).toEqual({ referer: 'https://read.example.invalid/' });
		expect(
			grantedImageHeaders('https://other.example.invalid/1.jpg', { referer: 'x' }, byHost, grant)
		).toBeNull();
		expect(
			grantedImageHeaders('http://read.example.invalid/1.jpg', { referer: 'x' }, undefined, grant)
		).toBeNull();
	});

	it('hands a credential out only through the image’s own map, never a wildcard', () => {
		expect(
			grantedImageHeaders('https://a.cdn.example.invalid/1.jpg', { cookie: 'mine' }, byHost, grant)
		).toEqual({ referer: 'https://read.example.invalid/', cookie: 'mine' });
	});

	it('applies them on a host the run learned, without a credential', () => {
		const learned = { ...grant, learned: ['k99.media.example.invalid'] };
		const own = { referer: 'https://read.example.invalid/', authorization: 'Bearer x' };

		expect(
			grantedImageHeaders('https://k99.media.example.invalid/1.jpg', own, undefined, learned)
		).toEqual({ referer: 'https://read.example.invalid/' });
		// Exact, never a sibling.
		expect(
			grantedImageHeaders('https://q73.media.example.invalid/1.jpg', own, undefined, learned)
		).toBeNull();
	});
});
