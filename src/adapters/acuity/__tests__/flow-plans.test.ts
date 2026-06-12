/**
 * Plan-shape snapshot tests for the three 0.6.0 Acuity flows (design §10/§11:
 * "FlowPlan is data — snapshot per flow per vendor; a plan diff in review IS the
 * flow-change review surface"), plus the state-schema conformance fence applied to
 * the registered FlowStateSpecs (design §4/§11).
 *
 * The expected plans below are EXPLICIT literals on purpose: any change to a flow's
 * shape must show up here as a reviewable diff, and the planHash assertions prove
 * the pinned hash is exactly the hash of the reviewed shape.
 */

import { describe, expect, it } from 'vitest';
import { computePlanHash, type FlowPlan } from '../../../flow/plan.js';
import { assertJsonEncodableSpec } from '../../../flow/state-conformance.js';
import {
	ACUITY_FLOW_VERSION,
	acuityAvailabilityDatesFlow,
	acuityAvailabilitySlotsFlow,
	acuityBookingFlow,
	acuityFlowEnqueuePinning,
	acuityFlowStepIds,
	acuityFlows,
} from '../flows.js';
import {
	acuityAvailabilityDatesFlowSpec,
	acuityAvailabilitySlotsFlowSpec,
	acuityBookingFlowSpec,
	acuityBusinessFlowSpec,
} from '../flow-steps.js';

const expectedBookingPlan: FlowPlan = {
	flowId: 'booking_create_with_payment',
	backend: 'acuity',
	version: ACUITY_FLOW_VERSION,
	nodes: [
		{
			stepId: 'acuity/navigate',
			needs: ['serviceId', 'datetime', 'serviceName', 'client'],
			provides: ['navigation'],
			dependsOn: [],
			expects: ['acuity:client-form'],
			idempotency: 'replayable-write',
			segment: 'navigate',
			tags: ['navigation'],
		},
		{
			stepId: 'acuity/fill-form',
			needs: ['client', 'navigation'],
			provides: ['form'],
			dependsOn: ['acuity/navigate'],
			expects: ['acuity:payment'],
			idempotency: 'replayable-write',
			segment: 'fill-form',
			tags: ['mutation'],
		},
		{
			stepId: 'acuity/bypass-payment',
			needs: ['couponCode', 'paymentRef', 'paymentProcessor', 'form'],
			provides: ['bypass'],
			dependsOn: ['acuity/fill-form'],
			expects: ['acuity:payment-bypassed'],
			idempotency: 'replayable-write',
			segment: 'bypass-payment',
			tags: ['payment-injection'],
		},
		{
			stepId: 'acuity/submit',
			needs: ['bypass'],
			provides: ['submission'],
			dependsOn: ['acuity/bypass-payment'],
			expects: ['acuity:confirmation'],
			idempotency: 'effectful-once',
			segment: 'submit',
			tags: ['mutation'],
		},
		{
			stepId: 'acuity/extract-confirmation',
			needs: ['submission'],
			provides: ['confirmation'],
			dependsOn: ['acuity/submit'],
			expects: ['acuity:confirmation'],
			idempotency: 'read',
			segment: 'extract-confirmation',
			tags: ['extraction'],
		},
	],
};

const expectedDatesPlan: FlowPlan = {
	flowId: 'availability_dates_refresh',
	backend: 'acuity',
	version: ACUITY_FLOW_VERSION,
	nodes: [
		{
			stepId: 'acuity/read-dates',
			needs: ['serviceId', 'month', 'serviceName'],
			provides: ['dates'],
			dependsOn: [],
			expects: ['acuity:calendar', 'acuity:time-list'],
			idempotency: 'read',
			segment: 'read-dates',
			tags: ['read'],
		},
	],
};

const expectedSlotsPlan: FlowPlan = {
	flowId: 'availability_slots_refresh',
	backend: 'acuity',
	version: ACUITY_FLOW_VERSION,
	nodes: [
		{
			stepId: 'acuity/read-slots',
			needs: ['serviceId', 'date', 'serviceName'],
			provides: ['slots'],
			dependsOn: [],
			expects: ['acuity:calendar', 'acuity:time-list'],
			idempotency: 'read',
			segment: 'read-slots',
			tags: ['read'],
		},
	],
};

describe('acuity flow plan snapshots (the flow-change review surface)', () => {
	it('booking_create_with_payment matches the production worker step sequence', () => {
		expect(acuityBookingFlow.plan).toEqual(expectedBookingPlan);
	});

	it('booking segments mirror the production worker page lifecycle: one segment per step', () => {
		const segments = acuityBookingFlow.plan.nodes.map((node) => node.segment);
		expect(new Set(segments).size).toBe(acuityBookingFlow.plan.nodes.length);
	});

	it('the payment-injection step is tagged and journaled as the design requires', () => {
		const bypass = acuityBookingFlow.plan.nodes.find(
			(node) => node.stepId === 'acuity/bypass-payment',
		);
		expect(bypass?.tags).toContain('payment-injection');
		expect(bypass?.idempotency).toBe('replayable-write');
	});

	it('submit is the only effectful-once node (the reconcile_required boundary driver)', () => {
		const effectfulOnce = acuityBookingFlow.plan.nodes.filter(
			(node) => node.idempotency === 'effectful-once',
		);
		expect(effectfulOnce.map((node) => node.stepId)).toEqual(['acuity/submit']);
	});

	it('availability_dates_refresh matches the worker single-step refresh', () => {
		expect(acuityAvailabilityDatesFlow.plan).toEqual(expectedDatesPlan);
	});

	it('availability_slots_refresh matches the worker single-step refresh', () => {
		expect(acuityAvailabilitySlotsFlow.plan).toEqual(expectedSlotsPlan);
	});

	it('planHash pins exactly the reviewed plan shape, deterministically', () => {
		expect(acuityBookingFlow.planHash).toBe(computePlanHash(expectedBookingPlan));
		expect(acuityAvailabilityDatesFlow.planHash).toBe(
			computePlanHash(expectedDatesPlan),
		);
		expect(acuityAvailabilitySlotsFlow.planHash).toBe(
			computePlanHash(expectedSlotsPlan),
		);
		// Determinism: recomputing over the frozen plan yields the same digest.
		expect(computePlanHash(acuityBookingFlow.plan)).toBe(acuityBookingFlow.planHash);
	});

	it('registers each flow under its BridgeJobKind id', () => {
		expect(Object.keys(acuityFlows).sort()).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
			'booking_create_with_payment',
		]);
		for (const [kind, flow] of Object.entries(acuityFlows)) {
			expect(flow.plan.flowId).toBe(kind);
		}
	});

	it('exposes the plan-predicted step-id sequences for shadow mode', () => {
		expect(acuityFlowStepIds('booking_create_with_payment')).toEqual([
			'acuity/navigate',
			'acuity/fill-form',
			'acuity/bypass-payment',
			'acuity/submit',
			'acuity/extract-confirmation',
		]);
		expect(acuityFlowStepIds('availability_dates_refresh')).toEqual([
			'acuity/read-dates',
		]);
		expect(acuityFlowStepIds('availability_slots_refresh')).toEqual([
			'acuity/read-slots',
		]);
	});

	it('enqueue pinning returns the registered planHash/flowVersion per job kind', () => {
		expect(acuityFlowEnqueuePinning('booking_create_with_payment')).toEqual({
			planHash: acuityBookingFlow.planHash,
			flowVersion: ACUITY_FLOW_VERSION,
		});
		expect(acuityFlowEnqueuePinning('availability_dates_refresh')).toEqual({
			planHash: acuityAvailabilityDatesFlow.planHash,
			flowVersion: ACUITY_FLOW_VERSION,
		});
		expect(acuityFlowEnqueuePinning('availability_slots_refresh')).toEqual({
			planHash: acuityAvailabilitySlotsFlow.planHash,
			flowVersion: ACUITY_FLOW_VERSION,
		});
	});
});

describe('state-schema conformance (design §4 volatile-state fence, applied to the registered specs)', () => {
	it('booking FlowStateSpec encodes to JSON primitives/arrays/records only', () => {
		expect(() => assertJsonEncodableSpec(acuityBookingFlowSpec)).not.toThrow();
	});

	it('availability FlowStateSpecs are JSON-encodable', () => {
		expect(() =>
			assertJsonEncodableSpec(acuityAvailabilityDatesFlowSpec),
		).not.toThrow();
		expect(() =>
			assertJsonEncodableSpec(acuityAvailabilitySlotsFlowSpec),
		).not.toThrow();
	});

	it('business FlowStateSpec is JSON-encodable', () => {
		expect(() => assertJsonEncodableSpec(acuityBusinessFlowSpec)).not.toThrow();
	});

	it('every registered flow retains its spec for conformance and stateDelta encoding', () => {
		for (const flow of Object.values(acuityFlows)) {
			expect(() => assertJsonEncodableSpec(flow.spec)).not.toThrow();
		}
	});
});
