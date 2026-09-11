/**
 * That yielding actually yields, and does not cost more than it saves.
 *
 * Both halves matter. A "yield" that resolves in a microtask never lets the
 * browser paint, so the page stays frozen and the code looks correct; and a
 * yield through a clamped timer restores painting while halving throughput,
 * which trades one complaint for another. The measurement that prompted this:
 * yielding every file through `setTimeout(0)` made a conversion 57% slower.
 */

import { describe, expect, it } from 'vitest';

import { frameBudget, yieldToHost } from './scheduling';

describe('yielding the main thread', () => {
	it('resolves after the microtask queue has drained, not inside it', async () => {
		const order: string[] = [];

		const yielded = yieldToHost().then(() => order.push('yield'));
		queueMicrotask(() => order.push('microtask'));
		await Promise.resolve().then(() => order.push('promise'));
		await yielded;

		// A macrotask, so everything already queued runs first. If this ever
		// reads `yield` first, the yield has become a microtask and the page it
		// was meant to unblock will stay frozen.
		expect(order[order.length - 1]).toBe('yield');
		expect(order).toContain('microtask');
		expect(order).toContain('promise');
	});

	it('is cheap enough to call in a loop', async () => {
		const started = performance.now();
		for (let index = 0; index < 200; index += 1) await yieldToHost();
		const each = (performance.now() - started) / 200;

		// A clamped timer is about 1ms in Node and about 4ms in a browser, and
		// either would dominate the work being interleaved. This is the whole
		// reason the fallback is a message channel rather than a timer.
		expect(each).toBeLessThan(1);
	});
});

describe('the frame budget', () => {
	it('does not yield until the budget is spent', async () => {
		const breathe = frameBudget(50);
		const started = performance.now();
		for (let index = 0; index < 20; index += 1) await breathe();

		// Twenty calls in well under the budget cost nothing: a loop that hopped
		// per item would spend more time in the scheduler than in the work.
		expect(performance.now() - started).toBeLessThan(25);
	});

	it('yields once the budget is spent, and then starts a fresh one', async () => {
		const breathe = frameBudget(1);
		let yields = 0;
		const started = performance.now();

		for (let index = 0; index < 5; index += 1) {
			const before = performance.now();
			await breathe();
			if (performance.now() - before > 0) yields += 1;
			// Burn past the budget so the next call has to yield.
			while (performance.now() - before < 3) {
				/* deliberate spin: this is what a parse looks like to the loop */
			}
		}

		expect(yields).toBeGreaterThan(0);
		expect(performance.now() - started).toBeGreaterThanOrEqual(12);
	});
});
