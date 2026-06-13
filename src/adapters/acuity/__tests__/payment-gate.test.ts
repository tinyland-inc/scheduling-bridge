/**
 * Payment-injection DOUBLE GATE unit tests (design §7; TIN-2095).
 *
 * The pure gate: the coupon-bypass payment segment splices only if (a) the pack
 * declares paymentInjection 'coupon-bypass' AND (b) kit PaymentCapabilities admit
 * the method. Either denial skips the segment. The kit-side predicate
 * (`admitsCouponBypass`) is bridge-defined over kit's existing capabilities
 * (recon item 6 gap 1): admitted exactly when an off-platform Venmo/PayPal rail is
 * available.
 */

import { describe, expect, it } from 'vitest';
import type { PaymentCapabilities } from '@tummycrypt/scheduling-kit/payments';
import {
	admitsCouponBypass,
	admitsPaymentSegment,
	paymentSegmentGate,
} from '../payment-gate.js';
import { acuityFlowPack } from '../flow-pack.js';

const capabilities = (
	overrides: Partial<PaymentCapabilities> = {},
): PaymentCapabilities => ({
	methods: [],
	stripe: null,
	venmo: null,
	cash: false,
	...overrides,
});

const venmoAvailable = capabilities({
	venmo: { available: true, clientId: 'cid', environment: 'production' },
});
const cardOnly = capabilities({
	stripe: { available: true, publishableKey: 'pk_test' },
});

describe('admitsCouponBypass (kit-capability half; bridge-defined over kit)', () => {
	it('admits when the Venmo/PayPal rail is available', () => {
		expect(admitsCouponBypass(venmoAvailable)).toBe(true);
	});

	it('denies when no off-platform rail is available (default capabilities)', () => {
		expect(admitsCouponBypass(capabilities())).toBe(false);
	});

	it('denies a card-only practitioner (stripe pays the vendor directly)', () => {
		expect(admitsCouponBypass(cardOnly)).toBe(false);
	});

	it('denies an explicitly-unavailable Venmo capability', () => {
		expect(
			admitsCouponBypass(
				capabilities({
					venmo: { available: false, clientId: 'cid', environment: 'sandbox' },
				}),
			),
		).toBe(false);
	});
});

describe('paymentSegmentGate (the DOUBLE gate)', () => {
	it('BOTH admit → the segment runs (pack declares coupon-bypass AND kit admits)', () => {
		expect(paymentSegmentGate(acuityFlowPack, venmoAvailable)).toEqual({
			admitted: true,
		});
		expect(admitsPaymentSegment(acuityFlowPack, venmoAvailable)).toBe(true);
	});

	it('pack denies → skipped, and the kit half is NOT even consulted (pack checked first)', () => {
		// A pack that does not declare coupon-bypass denies regardless of capabilities.
		const nativePack = { paymentInjection: 'native' as const };
		expect(paymentSegmentGate(nativePack, venmoAvailable)).toEqual({
			admitted: false,
			reason: 'pack-denies',
		});
		const externalPack = { paymentInjection: 'external-link' as const };
		expect(paymentSegmentGate(externalPack, venmoAvailable)).toEqual({
			admitted: false,
			reason: 'pack-denies',
		});
	});

	it('kit capability denies → skipped (pack admits, capabilities do not)', () => {
		expect(paymentSegmentGate(acuityFlowPack, cardOnly)).toEqual({
			admitted: false,
			reason: 'kit-capability-denies',
		});
		expect(paymentSegmentGate(acuityFlowPack, capabilities())).toEqual({
			admitted: false,
			reason: 'kit-capability-denies',
		});
		expect(admitsPaymentSegment(acuityFlowPack, cardOnly)).toBe(false);
	});
});
