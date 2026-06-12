/**
 * The three 0.6.0 Acuity flows, authored once through the FlowBuilder.
 * Design: docs/design/flow-dag-formalization.md §4 (flow.ts), §5, §10 (0.6.0 block).
 * TIN-2036.
 *
 * - `booking_create_with_payment` matches the PRODUCTION WORKER step sequence
 *   (`createBookingWithPayment`, src/server/worker.ts): navigate → fill-form →
 *   bypass-payment (payment-injection, $0-proof boundary) → submit (effectful-once,
 *   the reconcile_required boundary) → extract-confirmation. Segments mirror the
 *   worker's per-step page lifecycle (see flow-steps.ts header).
 * - `availability_dates_refresh` / `availability_slots_refresh` are the two
 *   availability refresh flows, each a single self-navigating read step with the
 *   worker's numeric-id dispatch.
 *
 * The flow ids equal the BridgeJobKind values so plan-hash pinning at enqueue
 * (design §5) maps one flow per job kind.
 */

import type { BridgeJobKind } from '../../async/types.js';
import { makeFlow, type Flow } from '../../flow/flow.js';
import type { MiddlewareError } from './errors.js';
import {
	ACUITY_BOOKING_INITIAL_KEYS,
	ACUITY_DATES_INITIAL_KEYS,
	ACUITY_SLOTS_INITIAL_KEYS,
	acuityAvailabilityDatesFlowSpec,
	acuityAvailabilitySlotsFlowSpec,
	acuityBookingFlowSpec,
	acuityBypassPaymentStep,
	acuityExtractConfirmationStep,
	acuityFillFormStep,
	acuityNavigateStep,
	acuityReadDatesStep,
	acuityReadSlotsStep,
	acuitySubmitStep,
	type AcuityAvailabilityDatesFlowSpec,
	type AcuityAvailabilitySlotsFlowSpec,
	type AcuityBookingFlowSpec,
} from './flow-steps.js';

/** Semver of the 0.6.0 flow shapes; bump when a flow's plan shape changes. */
export const ACUITY_FLOW_VERSION = '1.0.0';

export const acuityBookingFlow: Flow<AcuityBookingFlowSpec, MiddlewareError | undefined, any> =
	makeFlow(acuityBookingFlowSpec, ACUITY_BOOKING_INITIAL_KEYS)
		.add(acuityNavigateStep)
		.add(acuityFillFormStep)
		.add(acuityBypassPaymentStep)
		.add(acuitySubmitStep)
		.add(acuityExtractConfirmationStep)
		.build({
			flowId: 'booking_create_with_payment',
			backend: 'acuity',
			version: ACUITY_FLOW_VERSION,
		});

export const acuityAvailabilityDatesFlow: Flow<
	AcuityAvailabilityDatesFlowSpec,
	MiddlewareError | undefined,
	any
> = makeFlow(acuityAvailabilityDatesFlowSpec, ACUITY_DATES_INITIAL_KEYS)
	.add(acuityReadDatesStep)
	.build({
		flowId: 'availability_dates_refresh',
		backend: 'acuity',
		version: ACUITY_FLOW_VERSION,
	});

export const acuityAvailabilitySlotsFlow: Flow<
	AcuityAvailabilitySlotsFlowSpec,
	MiddlewareError | undefined,
	any
> = makeFlow(acuityAvailabilitySlotsFlowSpec, ACUITY_SLOTS_INITIAL_KEYS)
	.add(acuityReadSlotsStep)
	.build({
		flowId: 'availability_slots_refresh',
		backend: 'acuity',
		version: ACUITY_FLOW_VERSION,
	});

/** All registered Acuity flows, keyed by flow id (= BridgeJobKind). */
export const acuityFlows = {
	booking_create_with_payment: acuityBookingFlow,
	availability_dates_refresh: acuityAvailabilityDatesFlow,
	availability_slots_refresh: acuityAvailabilitySlotsFlow,
} as const;

/** Plan-predicted step-id sequence per flow (the shadow-mode comparison baseline). */
export const acuityFlowStepIds = (kind: BridgeJobKind): readonly string[] =>
	acuityFlows[kind].plan.nodes.map((node) => node.stepId);

/**
 * Enqueue pinning (design §5 plan-hash pinning): the `planHash`/`flowVersion` pair
 * written into every BridgeJobRecord at enqueue — additive and UNCONDITIONAL (not
 * gated by BRIDGE_FLOW_RUNNER; only the lease-time skew check is flag-gated).
 */
export const acuityFlowEnqueuePinning = (
	kind: BridgeJobKind,
): { readonly planHash: string; readonly flowVersion: string } => ({
	planHash: acuityFlows[kind].planHash,
	flowVersion: acuityFlows[kind].plan.version,
});
