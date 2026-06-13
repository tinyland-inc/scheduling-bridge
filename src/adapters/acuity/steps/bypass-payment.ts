/**
 * Wizard Step: Bypass Payment
 *
 * Applies a 100% gift certificate code on Acuity's payment page to bypass
 * the credit card requirement. This allows the booking to complete at $0,
 * since actual payment is handled by our Venmo/Cash adapters.
 *
 * Strategy: A pre-configured gift certificate in Acuity admin covers the full amount.
 * The certificate code is passed as ACUITY_BYPASS_COUPON env var.
 *
 * Acuity's payment page coupon flow (verified 2026-02-26):
 *   1. Page is at URL .../datetime/<ISO>/payment
 *   2. Click "Package, gift, or coupon code" toggle to expand the coupon section
 *   3. Enter the gift certificate code in the "Enter code" input
 *   4. Click "Apply" to validate the code
 *   5. Acuity calls POST /api/scheduling/v1/appointments/order-summary
 *      with certificateCode in the body; response includes discount and total
 *   6. If successful: order summary shows "Gift certificate [CODE] -$X.XX"
 *      and total drops to $0.00
 *   7. "PAY & CONFIRM" button can now be clicked without entering card details
 *
 * Note: There IS a separate payment page (URL ends in /payment).
 * The "Check Code Balance" modal on the client form is INFORMATIONAL ONLY.
 *
 * DECOMPOSITION (TIN-2095, design §7): the body of this step is now the three
 * reusable sub-steps in `payment-segment.ts` — open-coupon-entry → apply-coupon →
 * verify-zero-total. The flow runs those three as separate FlowSteps (one
 * payment-injection segment); `bypassPayment` below is retained as a THIN
 * composition over them so the legacy step-program import surface
 * (`steps/index.js` → `bypassPayment`) stays stable for any non-flow caller.
 */

import { Effect } from 'effect';
import {
	applyCoupon,
	openCouponEntry,
	verifyZeroTotal,
	type VerifyZeroTotalResult,
} from './payment-segment.js';

// =============================================================================
// TYPES
// =============================================================================

/** @deprecated The segment now returns `VerifyZeroTotalResult`; identical shape. */
export type BypassPaymentResult = VerifyZeroTotalResult;

// =============================================================================
// COMPOSITION (over the decomposed sub-steps)
// =============================================================================

/**
 * Apply a gift certificate code on the payment page to bypass card entry.
 *
 * Prerequisite: The wizard must already be on the payment page
 * (URL contains /payment). Call after fillFormFields + advancePastForm.
 *
 * Thin composition of the three sub-steps (`payment-segment.ts`); the flow path
 * runs those sub-steps directly as FlowSteps. Kept for the legacy step-program
 * import surface.
 */
export const bypassPayment = (couponCode: string) =>
	openCouponEntry(couponCode).pipe(
		Effect.zipRight(applyCoupon(couponCode)),
		Effect.zipRight(verifyZeroTotal(couponCode)),
	);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Generate a unique coupon code for a payment reference.
 * Format: ALT-{PROCESSOR}-{SHORT_REF}
 *
 * Note: For MVP, we use a single reusable coupon code from env.
 * This function is here for future per-transaction coupon support.
 */
export const generateCouponCode = (
	_paymentRef: string,
	_processor: string,
	envCouponCode?: string,
): string => {
	// MVP: Use pre-configured reusable coupon
	if (envCouponCode) return envCouponCode;

	// Future: Generate per-transaction code
	// return `ALT-${processor.toUpperCase()}-${paymentRef.slice(0, 8)}`;
	throw new Error(
		'ACUITY_BYPASS_COUPON environment variable is required. ' +
			'Create a 100% gift certificate in Acuity admin and set this env var.',
	);
};
