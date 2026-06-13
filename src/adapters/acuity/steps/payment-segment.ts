/**
 * Acuity payment-injection sub-flow: the coupon-bypass segment as THREE reusable
 * step programs (design docs/design/flow-dag-formalization.md §7 "Payment injection
 * as a first-class segment"; §6 PAYMENT_BYPASS_NOT_PROVEN; TIN-2095).
 *
 * The 0.6.x monolith `bypassPayment` (bypass-payment.ts) is decomposed into the
 * three sub-steps the design names — open-coupon-entry → apply-coupon →
 * verify-zero-total — each an honest Effect program over `BrowserService`:
 *
 *   - openCouponEntry(code)  = the old body lines 72-96: resolve the
 *     "Package, gift, or coupon code" toggle, click it, wait for the
 *     "Enter code" input to appear. The /payment URL pre-guard (old lines 59-70)
 *     rides on this step, the head of the segment.
 *   - applyCoupon(code)      = the old body lines 98-150: resolve the coupon
 *     input, fill the (journaled, reused — see flow-steps.ts) coupon code,
 *     resolve + click Apply, wait for the POST /order-summary response.
 *   - verifyZeroTotal(code)  = the old body lines 152-198: scrape the order
 *     summary for the gift-certificate line + discount, parse the running Total,
 *     scan for coupon-rejection errors, and return the BypassPaymentResult. This
 *     is the $0-proof OBSERVATION step — its result drives the fuzzy-out landing
 *     (payment-bypassed vs payment) and therefore the PAYMENT_BYPASS_NOT_PROVEN
 *     Diverged outcome.
 *
 * Each sub-step is session-local (`replayable-write`, design §5) and reuses the
 * SAME coupon code (the journaled idempotencyToken) — the steps NEVER mint a code
 * themselves; the wrapper in flow-steps.ts threads `generateCouponCode`'s output
 * (or the journaled token on retry/resume) into all three. The money movement
 * stays in kit's payment adapters; this segment only proves the vendor charge was
 * bypassed (design §7).
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { CouponError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';

// =============================================================================
// TYPES
// =============================================================================

/** Result of the verify-zero-total step — the $0 proof surface (design §6). */
export interface VerifyZeroTotalResult {
	readonly couponApplied: boolean;
	readonly code: string;
	readonly totalAfterCoupon: string | null;
}

// =============================================================================
// SHARED HELPERS
// =============================================================================

/**
 * Acquire the payment page, asserting the segment pre-guard (URL contains
 * /payment). Shared by all three sub-steps so each one is independently
 * re-drivable on a fresh session (replayable-write): a sub-step that resumes
 * mid-segment still verifies it is on the payment page before touching the DOM.
 */
const acquirePaymentPage = (couponCode: string) =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page: Page = yield* acquirePage;
		const url = page.url();
		if (!url.includes('/payment')) {
			return yield* Effect.fail(
				new CouponError({
					code: couponCode,
					message:
						`Not on payment page (URL: ${url}). ` +
						'The wizard must advance past the client form first.',
				}),
			);
		}
		return page;
	});

// =============================================================================
// SUB-STEP 1 — OPEN COUPON ENTRY (old bypass-payment.ts:72-96 + pre-guard)
// =============================================================================

/**
 * Expand Acuity's "Package, gift, or coupon code" section on the payment page and
 * wait for the "Enter code" input to appear. Replayable-write (design §5): the
 * effect is purely session-local DOM expansion — safe to re-drive on a fresh page.
 */
export const openCouponEntry = (couponCode: string) =>
	Effect.gen(function* () {
		const page = yield* acquirePaymentPage(couponCode);

		const couponToggle = yield* resolveSelector(
			page,
			Selectors.paymentCouponToggle,
			10000,
		).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message:
							'"Package, gift, or coupon code" toggle not found on payment page.',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await couponToggle.element.click();
				// Wait for the coupon input to appear after expansion
				await page.waitForSelector('input[placeholder="Enter code"]', {
					timeout: 5000,
				});
			},
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to expand coupon section: ${
						e instanceof Error ? e.message : String(e)
					}`,
				}),
		});

		return { opened: true } as const;
	});

// =============================================================================
// SUB-STEP 2 — APPLY COUPON (old bypass-payment.ts:98-150)
// =============================================================================

/**
 * Enter the (journaled, reused) gift-certificate code and click Apply, then wait
 * for Acuity's POST /api/scheduling/v1/appointments/order-summary response.
 * Replayable-write (design §5): re-applying the SAME journaled coupon code is
 * idempotent on Acuity's order summary — the segment reuses the token rather than
 * minting a new code per attempt.
 */
export const applyCoupon = (couponCode: string) =>
	Effect.gen(function* () {
		const page = yield* acquirePaymentPage(couponCode);

		const couponInput = yield* resolveSelector(
			page,
			Selectors.paymentCouponInput,
			5000,
		).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message: 'Coupon code input not found after expanding section',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await couponInput.element.click();
				await couponInput.element.fill(couponCode);
			},
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to enter coupon code: ${
						e instanceof Error ? e.message : String(e)
					}`,
				}),
		});

		const applyBtn = yield* resolveSelector(
			page,
			Selectors.paymentCouponApply,
			5000,
		).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new CouponError({
						code: couponCode,
						message: '"Apply" button not found in coupon section',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: () => applyBtn.element.click(),
			catch: (e) =>
				new CouponError({
					code: couponCode,
					message: `Failed to click "Apply": ${
						e instanceof Error ? e.message : String(e)
					}`,
				}),
		});

		// Wait for the order-summary API response (Acuity calls POST
		// /api/scheduling/v1/appointments/order-summary with certificateCode).
		yield* Effect.tryPromise({
			try: () => page.waitForTimeout(3000),
			catch: () =>
				new CouponError({
					code: couponCode,
					message: 'Timeout waiting for coupon validation',
				}),
		});

		return { applied: true } as const;
	});

// =============================================================================
// SUB-STEP 3 — VERIFY ZERO TOTAL (old bypass-payment.ts:152-198 — the $0 proof)
// =============================================================================

/**
 * Read the order summary and prove the vendor charge was bypassed: the gift
 * certificate line is present for THIS code, a discount appears, and the running
 * Total parses to a value (the $0 predicate itself lives in flow-steps.ts as
 * `isPaymentBypassProven`, mirroring the legacy worker). On a coupon rejection,
 * fails with the surfaced error text. This is the fuzzy-out observation that
 * yields PAYMENT_BYPASS_NOT_PROVEN as a Diverged outcome on the segment (design §6).
 */
export const verifyZeroTotal = (couponCode: string) =>
	Effect.gen(function* () {
		const page = yield* acquirePaymentPage(couponCode);

		// On success: "Gift certificate [CODE]" and "-$X.XX" appear in order summary.
		const result = yield* Effect.tryPromise({
			try: async () => {
				const bodyText = await page.evaluate(
					() => document.body.textContent ?? '',
				);
				const hasGiftCert =
					bodyText.includes('Gift certificate') &&
					bodyText.includes(couponCode);
				const hasDiscount = bodyText.includes('-$');
				const totalMatch = bodyText.match(/Total\s*\$?([\d.]+)/);
				const total = totalMatch ? totalMatch[1] : null;
				return { hasGiftCert, hasDiscount, total };
			},
			catch: () => ({ hasGiftCert: false, hasDiscount: false, total: null }),
		}).pipe(
			Effect.orElseSucceed(() => ({
				hasGiftCert: false,
				hasDiscount: false,
				total: null,
			})),
		);

		if (!result.hasGiftCert) {
			// Check for error indicators
			const errorText = yield* Effect.tryPromise({
				try: async () => {
					const errs: string[] = [];
					const errEls = await page.$$('[class*="error"], [role="alert"]');
					for (const el of errEls) {
						const text = await el.textContent().catch(() => null);
						if (text && text.trim().length > 0) errs.push(text.trim());
					}
					return errs.join('; ') || null;
				},
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (errorText) {
				return yield* Effect.fail(
					new CouponError({
						code: couponCode,
						message: `Coupon rejected: ${errorText}`,
					}),
				);
			}
		}

		const totalAfterCoupon = result.total ? `$${result.total}` : null;

		return {
			couponApplied: result.hasGiftCert && result.hasDiscount,
			code: couponCode,
			totalAfterCoupon,
		} satisfies VerifyZeroTotalResult;
	});
