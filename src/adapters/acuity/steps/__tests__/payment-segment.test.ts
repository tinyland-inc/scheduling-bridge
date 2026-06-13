/**
 * Payment-injection sub-flow step unit tests (design §7; TIN-2095).
 *
 * The decomposed step programs — openCouponEntry, applyCoupon, verifyZeroTotal —
 * run against a substituted BrowserService with a fake Playwright page, so no
 * Chromium launches. Covers the /payment pre-guard (each sub-step is independently
 * re-drivable on a fresh session), the happy path of each, and the $0-proof
 * surface that drives PAYMENT_BYPASS_NOT_PROVEN.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { BrowserService, defaultBrowserConfig } from '../../../../shared/browser-service.js';
import {
	applyCoupon,
	openCouponEntry,
	verifyZeroTotal,
} from '../payment-segment.js';
import { bypassPayment } from '../bypass-payment.js';

const CODE = 'GIFT-100';

/** A minimal fake Playwright page parameterized by the order-summary body text. */
const fakePage = (opts: {
	readonly url?: string;
	readonly bodyText?: string;
	readonly errorTexts?: readonly string[];
}) => {
	const url = opts.url ?? 'https://example.as.me/schedule/x/datetime/2026-06-15/payment';
	const element = {
		click: async () => undefined,
		fill: async () => undefined,
	};
	return {
		url: () => url,
		waitForSelector: async () => element,
		waitForTimeout: async () => undefined,
		// resolveSelector probes via waitForSelector(state:'attached'); selectors.ts
		// uses page.waitForSelector then page.$. Provide both.
		$: async () => element,
		$$: async () =>
			(opts.errorTexts ?? []).map((text) => ({
				textContent: async () => text,
			})),
		evaluate: async () => opts.bodyText ?? '',
	} as never;
};

const provideFakeService = <A, E>(
	page: ReturnType<typeof fakePage>,
	effect: Effect.Effect<A, E, BrowserService>,
) => {
	const service = {
		acquirePage: Effect.succeed(page),
		screenshot: () => Effect.succeed(Buffer.from('')),
		config: { ...defaultBrowserConfig },
	};
	return effect.pipe(
		Effect.provideService(BrowserService, service as never),
		Effect.scoped,
	);
};

const withPage = <A, E>(
	page: ReturnType<typeof fakePage>,
	effect: Effect.Effect<A, E, BrowserService>,
): Promise<A> => Effect.runPromise(provideFakeService(page, effect));

/** Run to the typed error channel (CouponError) — never the FiberFailure wrapper. */
const errorOf = <A, E>(
	page: ReturnType<typeof fakePage>,
	effect: Effect.Effect<A, E, BrowserService>,
): Promise<E> => Effect.runPromise(Effect.flip(provideFakeService(page, effect)));

describe('payment sub-step pre-guard (each sub-step re-checks the /payment URL)', () => {
	it.each([
		['openCouponEntry', openCouponEntry],
		['applyCoupon', applyCoupon],
		['verifyZeroTotal', verifyZeroTotal],
	])('%s fails with CouponError when not on the payment page', async (_label, step) => {
		const page = fakePage({ url: 'https://example.as.me/schedule/x/datetime/2026-06-15' });
		const error = await errorOf(
			page,
			step(CODE) as Effect.Effect<unknown, unknown, BrowserService>,
		);
		expect(error).toMatchObject({ _tag: 'CouponError', code: CODE });
		expect((error as { message: string }).message).toContain('Not on payment page');
	});
});

describe('openCouponEntry', () => {
	it('expands the coupon section on the payment page', async () => {
		const result = await withPage(fakePage({}), openCouponEntry(CODE));
		expect(result).toEqual({ opened: true });
	});
});

describe('applyCoupon', () => {
	it('fills the coupon and clicks Apply on the payment page', async () => {
		const result = await withPage(fakePage({}), applyCoupon(CODE));
		expect(result).toEqual({ applied: true });
	});
});

describe('verifyZeroTotal ($0 proof surface, design §6)', () => {
	it('proves the bypass when the gift certificate + discount + total are present', async () => {
		const bodyText = `Order summary Gift certificate ${CODE} -$105.00 Total $0.00`;
		const result = await withPage(fakePage({ bodyText }), verifyZeroTotal(CODE));
		expect(result).toEqual({
			couponApplied: true,
			code: CODE,
			totalAfterCoupon: '$0.00',
		});
	});

	it('reports not-proven (couponApplied false) when no gift-certificate line appears', async () => {
		const bodyText = 'Order summary Total $105.00';
		const result = await withPage(fakePage({ bodyText }), verifyZeroTotal(CODE));
		expect(result.couponApplied).toBe(false);
		expect(result.totalAfterCoupon).toBe('$105.00');
	});

	it('fails with CouponError when the page surfaces a coupon rejection', async () => {
		const page = fakePage({
			bodyText: 'Order summary Total $105.00',
			errorTexts: ['Invalid gift certificate code'],
		});
		const error = await errorOf(page, verifyZeroTotal(CODE));
		expect(error).toMatchObject({ _tag: 'CouponError' });
		expect((error as { message: string }).message).toContain('Coupon rejected');
	});
});

describe('bypassPayment composition (back-compat over the three sub-steps)', () => {
	it('runs open → apply → verify and returns the verify result', async () => {
		const bodyText = `Gift certificate ${CODE} -$105.00 Total $0.00`;
		const result = await withPage(fakePage({ bodyText }), bypassPayment(CODE));
		expect(result).toEqual({
			couponApplied: true,
			code: CODE,
			totalAfterCoupon: '$0.00',
		});
	});
});
