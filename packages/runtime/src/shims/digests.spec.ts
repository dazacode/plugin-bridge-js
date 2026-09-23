/**
 * The bundle's own digests, against `node:crypto` as the oracle.
 *
 * Every length that sits on or beside a padding boundary is tried, because that
 * is where a hand-written Merkle-Damgard implementation goes wrong: 55 and 56
 * bytes for the 64-byte block, 111 and 112 for the 128-byte one, and the exact
 * block sizes either side.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { DIGESTS } from './digests';

type Digest = (bytes: Uint8Array) => Uint8Array;

const evaluated = new Function(
	`${DIGESTS}\nreturn { md5: __digestMd5, sha1: __digestSha1, sha256: __digestSha256, sha384: __digestSha384, sha512: __digestSha512 };`
)() as Record<'md5' | 'sha1' | 'sha256' | 'sha384' | 'sha512', Digest>;

const NODE_NAMES = {
	md5: 'md5',
	sha1: 'sha1',
	sha256: 'sha256',
	sha384: 'sha384',
	sha512: 'sha512'
};

const LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 127, 128, 129, 200, 1000];

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('hex');
}

describe('the digests a bundle computes itself', () => {
	for (const [name, nodeName] of Object.entries(NODE_NAMES)) {
		const digest = evaluated[name as keyof typeof evaluated];

		it(`${name} answers the standard vector for "abc"`, () => {
			const input = new TextEncoder().encode('abc');
			expect(hex(digest(input))).toBe(createHash(nodeName).update(input).digest('hex'));
		});

		it(`${name} agrees with node:crypto on every padding boundary`, () => {
			for (const length of LENGTHS) {
				const input = new Uint8Array(randomBytes(length));
				expect(hex(digest(input)), `length ${length}`).toBe(
					createHash(nodeName).update(input).digest('hex')
				);
			}
		});
	}

	it('md5 answers the RFC 1321 vectors', () => {
		const md5 = (text: string) => hex(evaluated.md5(new TextEncoder().encode(text)));
		expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
		expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
	});
});
