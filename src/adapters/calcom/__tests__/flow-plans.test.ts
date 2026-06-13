/**
 * Plan-shape snapshot tests for the CalCom read-only flows (design §10/§11: "FlowPlan
 * is data — snapshot per flow per vendor; a plan diff in review IS the flow-change
 * review surface"), plus the state-schema conformance fence applied to the CalCom
 * FlowStateSpecs (design §4/§11). TIN-2097 (Lane E).
 *
 * The expected plans are EXPLICIT literals on purpose: any change to a CalCom flow's
 * shape must show up here as a reviewable diff, and the planHash assertions prove the
 * pinned hash is exactly the hash of the reviewed shape.
 */

import { describe, expect, it } from 'vitest';
import { computePlanHash, type FlowPlan } from '../../../flow/plan.js';
import { assertJsonEncodableSpec } from '../../../flow/state-conformance.js';
import {
	CALCOM_FLOW_VERSION,
	calcomAvailabilityDatesFlow,
	calcomAvailabilitySlotsFlow,
	calcomFlowStepIds,
	calcomFlows,
} from '../flows.js';
import {
	calcomAvailabilityDatesFlowSpec,
	calcomAvailabilitySlotsFlowSpec,
} from '../flow-steps.js';

const expectedDatesPlan: FlowPlan = {
	flowId: 'availability_dates_refresh',
	backend: 'calcom',
	version: CALCOM_FLOW_VERSION,
	nodes: [
		{
			stepId: 'calcom/read-dates',
			needs: ['serviceId', 'month'],
			provides: ['dates'],
			dependsOn: [],
			expects: ['calcom:slots'],
			idempotency: 'read',
			segment: 'read-dates',
			tags: ['read'],
		},
	],
};

const expectedSlotsPlan: FlowPlan = {
	flowId: 'availability_slots_refresh',
	backend: 'calcom',
	version: CALCOM_FLOW_VERSION,
	nodes: [
		{
			stepId: 'calcom/read-slots',
			needs: ['serviceId', 'date'],
			provides: ['slots'],
			dependsOn: [],
			expects: ['calcom:slots'],
			idempotency: 'read',
			segment: 'read-slots',
			tags: ['read'],
		},
	],
};

describe('calcom flow plan snapshots (the flow-change review surface)', () => {
	it('availability_dates_refresh matches the reviewed REST read plan', () => {
		expect(calcomAvailabilityDatesFlow.plan).toEqual(expectedDatesPlan);
	});

	it('availability_slots_refresh matches the reviewed REST read plan', () => {
		expect(calcomAvailabilitySlotsFlow.plan).toEqual(expectedSlotsPlan);
	});

	it('every CalCom node is a read (read-only pack: no mutation/effectful-once)', () => {
		for (const flow of Object.values(calcomFlows)) {
			for (const node of flow.plan.nodes) {
				expect(node.idempotency).toBe('read');
				expect(node.tags).toEqual(['read']);
			}
		}
	});

	it('CalCom flows reuse the Acuity availability flow ids (= BridgeJobKind)', () => {
		expect(Object.keys(calcomFlows).sort()).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
		]);
		for (const [kind, flow] of Object.entries(calcomFlows)) {
			expect(flow.plan.flowId).toBe(kind);
		}
	});

	it('the read-only pack registers NO booking flow', () => {
		expect('booking_create_with_payment' in calcomFlows).toBe(false);
	});

	it('planHash pins exactly the reviewed plan shape, deterministically', () => {
		expect(calcomAvailabilityDatesFlow.planHash).toBe(computePlanHash(expectedDatesPlan));
		expect(calcomAvailabilitySlotsFlow.planHash).toBe(computePlanHash(expectedSlotsPlan));
		expect(computePlanHash(calcomAvailabilityDatesFlow.plan)).toBe(
			calcomAvailabilityDatesFlow.planHash,
		);
	});

	it('exposes the plan-predicted step-id sequences', () => {
		expect(calcomFlowStepIds('availability_dates_refresh')).toEqual(['calcom/read-dates']);
		expect(calcomFlowStepIds('availability_slots_refresh')).toEqual(['calcom/read-slots']);
	});
});

describe('CalCom state-schema conformance (design §4 volatile-state fence)', () => {
	it('CalCom availability FlowStateSpecs encode to JSON primitives/arrays/records only', () => {
		expect(() => assertJsonEncodableSpec(calcomAvailabilityDatesFlowSpec)).not.toThrow();
		expect(() => assertJsonEncodableSpec(calcomAvailabilitySlotsFlowSpec)).not.toThrow();
	});

	it('every registered CalCom flow retains a JSON-encodable spec', () => {
		for (const flow of Object.values(calcomFlows)) {
			expect(() => assertJsonEncodableSpec(flow.spec)).not.toThrow();
		}
	});
});
