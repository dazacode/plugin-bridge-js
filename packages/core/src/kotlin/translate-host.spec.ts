/**
 * That translating off the main thread gives the same answer as translating on
 * it, and that the fallback is real.
 *
 * The fallback matters more than it looks. The specs run in Node, the registry
 * is constructed during SSR, and a host that required a `Worker` would turn a
 * scheduling optimisation into a portability failure — so "no worker" must be a
 * slower path, never an error. The contract is that only *where* the work
 * happened differs.
 *
 * The other half is the failure mode a worker introduces and inline code cannot
 * have: a worker that dies mid-translation leaves promises nobody will ever
 * settle, which is a check that never finishes and a spinner that never stops.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { convertKotlin } from './pipeline';
import { stopTranslating, translateKotlin } from './translate-host';

/**
 * The vendored parser artefacts, read the way a host reads them.
 *
 * Passed on every path here, because both paths need it and for the same
 * reason: a worker is its own realm and the inline fallback is the runtime,
 * and neither may resolve a file relative to a bundle (`HOST.md` §2.2).
 */
async function vendorWasm(name: string): Promise<Uint8Array> {
	const { readFile } = await import('node:fs/promises');
	const { fileURLToPath } = await import('node:url');
	return new Uint8Array(
		await readFile(fileURLToPath(new URL(`./vendor/${name}`, import.meta.url)))
	);
}

const SOURCE = `
class Demo : ParsedAnimeHttpSource() {
    override val name = "Demo"
    override val baseUrl = "https://watch.example.invalid"
    override fun popularAnimeSelector(): String = "li.card"
}
`;

const FILES = [{ path: 'Demo.kt', source: SOURCE }];

afterEach(() => {
	stopTranslating();
});

describe('translating inline', () => {
	it('answers exactly what the pipeline answers', async () => {
		const direct = await convertKotlin(FILES, { wasm: vendorWasm });
		const viaHost = await translateKotlin(FILES, {
			inline: true,
			wasm: vendorWasm
		});

		expect(viaHost.className).toBe(direct.className);
		expect(viaHost.js).toBe(direct.js);
		expect(viaHost.complete).toBe(direct.complete);
	}, 60_000);
});

describe('when there is no worker to be had', () => {
	it('falls back rather than failing', async () => {
		const conversion = await translateKotlin(FILES, {
			wasm: vendorWasm,
			createWorker: () => {
				throw new Error('this host has no Worker');
			}
		});

		// Same answer, slower path. A host without workers is a supported host.
		expect(conversion.className).toBe('Demo');
		expect(conversion.complete).toBe(true);
	}, 60_000);

	it('does not retry a construction that already failed', async () => {
		let attempts = 0;
		const createWorker = (): Worker => {
			attempts += 1;
			throw new Error('no');
		};

		await translateKotlin(FILES, { createWorker, wasm: vendorWasm });
		await translateKotlin(FILES, { createWorker, wasm: vendorWasm });

		// Remembered, so 254 listings do not each throw and catch their way to
		// the same conclusion.
		expect(attempts).toBe(1);
	}, 60_000);
});

describe('when a worker dies mid-translation', () => {
	it('fails the work it was carrying instead of leaving it pending', async () => {
		// A promise nobody settles is the worst outcome here: the check neither
		// finishes nor reports, and the only visible symptom is a spinner.
		let onerror: ((event: unknown) => void) | null = null;

		const fake = {
			set onmessage(_: unknown) {},
			set onerror(handler: (event: unknown) => void) {
				onerror = handler;
			},
			postMessage() {
				queueMicrotask(() => onerror?.(new Error('worker died')));
			},
			terminate() {}
		};

		await expect(
			translateKotlin(FILES, { createWorker: () => fake as unknown as Worker })
		).rejects.toThrow(/stopped before it answered/);
	});

	it('lets the next call start a fresh one', async () => {
		let created = 0;
		let onerror: ((event: unknown) => void) | null = null;

		const createWorker = (): Worker => {
			created += 1;
			return {
				set onmessage(_: unknown) {},
				set onerror(handler: (event: unknown) => void) {
					onerror = handler;
				},
				postMessage() {
					queueMicrotask(() => onerror?.(new Error('worker died')));
				},
				terminate() {}
			} as unknown as Worker;
		};

		await expect(translateKotlin(FILES, { createWorker })).rejects.toThrow();
		await expect(translateKotlin(FILES, { createWorker })).rejects.toThrow();

		// A dead worker is discarded, not reused. Reusing it would fail every
		// later listing for a reason that has nothing to do with them.
		expect(created).toBe(2);
	});
});
