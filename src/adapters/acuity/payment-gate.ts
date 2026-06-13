/**
 * Payment-injection DOUBLE GATE (design §7; TIN-2095).
 *
 * The coupon-bypass payment segment splices into the booking flow ONLY when BOTH
 * halves admit it, and the check runs UPSTREAM of any browser work (before flow
 * selection / session provisioning):
 *
 *   (a) the VendorFlowPack declares `paymentInjection: 'coupon-bypass'`, AND
 *   (b) kit `PaymentCapabilities` admits the method.
 *
 * If either gate denies, the payment segment does NOT run (the booking is not
 * driven through the coupon-bypass flow). Venmo-via-coupon is Acuity's
 * implementation of the segment: the actual money movement stays in kit's payment
 * adapters; the bridge segment only proves the vendor charge was bypassed.
 *
 * KIT-SIDE PREDICATE (recon brief item 6 — kit gap 1): kit's `PaymentCapabilities`
 * (kit src/payments/types.ts "PAYMENT CAPABILITIES CONTRACT") ships NO
 * coupon-bypass field and NO `admitsCouponBypass` predicate today. Rather than
 * cut a kit minor (deferred — see design §10 0.7.0 "fuzzy scorers graduate to
 * kit"), the predicate is defined HERE over the existing kit capabilities, with
 * honest semantics: coupon-bypass is admitted exactly when an alternative
 * (non-card) money rail exists to settle the booking off the vendor — i.e. the
 * kit Venmo/PayPal capability is available (`venmo.available`). `cash` is a
 * type-level `false` in kit and never admits a rail; a card-only practitioner
 * (`stripe` only) pays the vendor directly and does NOT use coupon-bypass.
 */

import type { Context } from 'effect';
import type { PaymentCapabilities } from '@tummycrypt/scheduling-kit/payments';
import type { VendorFlowPack } from '../../flow/vendor.js';

/** The coupon-bypass declaration half of a pack (the only field the gate reads). */
type PackPaymentInjection = Pick<
	Context.Tag.Service<VendorFlowPack>,
	'paymentInjection'
>;

/**
 * Kit-capability half of the gate (bridge-defined over kit's existing contract,
 * recon item 6 gap 1). True when kit admits an alternative money rail for the
 * coupon-bypass segment — today, the Venmo/PayPal capability being available.
 */
export const admitsCouponBypass = (capabilities: PaymentCapabilities): boolean =>
	capabilities.venmo?.available === true;

/** The two reasons the double gate can deny, for honest diagnostics/logging. */
export type PaymentSegmentDenial =
	| 'pack-denies' // (a): the pack does not declare coupon-bypass
	| 'kit-capability-denies'; // (b): kit capabilities do not admit the method

export type PaymentSegmentGateResult =
	| { readonly admitted: true }
	| { readonly admitted: false; readonly reason: PaymentSegmentDenial };

/**
 * Capabilities supplied to the gate, eagerly OR as a thunk. The thunk form lets
 * the gate honor pack-first ordering: when the pack half denies, the kit
 * capability resolver is NEVER invoked (no env/DB read for a vendor that does not
 * even declare coupon-bypass).
 */
export type CapabilitiesInput =
	| PaymentCapabilities
	| (() => PaymentCapabilities);

const resolveCapabilities = (input: CapabilitiesInput): PaymentCapabilities =>
	typeof input === 'function' ? input() : input;

/**
 * The DOUBLE gate. Pure and synchronous so it can be evaluated upstream of any
 * browser/session work. The pack half is checked FIRST (so a vendor that does not
 * declare coupon-bypass never even consults payment capabilities — pass a thunk to
 * make that observable), then the kit capability half.
 */
export const paymentSegmentGate = (
	pack: PackPaymentInjection,
	capabilities: CapabilitiesInput,
): PaymentSegmentGateResult => {
	if (pack.paymentInjection !== 'coupon-bypass') {
		return { admitted: false, reason: 'pack-denies' };
	}
	if (!admitsCouponBypass(resolveCapabilities(capabilities))) {
		return { admitted: false, reason: 'kit-capability-denies' };
	}
	return { admitted: true };
};

/** Convenience boolean over `paymentSegmentGate` for call sites that only branch. */
export const admitsPaymentSegment = (
	pack: PackPaymentInjection,
	capabilities: CapabilitiesInput,
): boolean => paymentSegmentGate(pack, capabilities).admitted;
