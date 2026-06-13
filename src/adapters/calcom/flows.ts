/**
 * The CalCom read-only availability flows, authored through the FlowBuilder.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom: "the same flow ids with
 * REST-backed steps"), §10 (0.7.0 block). TIN-2097 (Lane E).
 *
 * Read-only first (dates + slots), using the SAME flow ids as Acuity
 * (`availability_dates_refresh` / `availability_slots_refresh` = the BridgeJobKind
 * values) so plan-hash pinning maps one flow per job kind regardless of vendor. The
 * booking flow is intentionally absent: read-only flows prove transport-agnosticism
 * before any multi-vendor write is claimed.
 *
 * Each flow's R channel is `CalComHttpClient` — the type-level proof that a REST flow
 * never provisions a browser Layer (asserted in __tests__/flow-r-channel.test.ts).
 */

import { makeFlow, type Flow } from '../../flow/flow.js';
import { CalComHttpClient } from './http-client.js';
import { type CalComRestError } from './errors.js';
import {
	CALCOM_DATES_INITIAL_KEYS,
	CALCOM_SLOTS_INITIAL_KEYS,
	calcomAvailabilityDatesFlowSpec,
	calcomAvailabilitySlotsFlowSpec,
	calcomReadDatesStep,
	calcomReadSlotsStep,
	type CalComAvailabilityDatesFlowSpec,
	type CalComAvailabilitySlotsFlowSpec,
} from './flow-steps.js';

/** Semver of the CalCom 0.7.0 read-only flow shapes; bump when a plan shape changes. */
export const CALCOM_FLOW_VERSION = '1.0.0';

export const calcomAvailabilityDatesFlow: Flow<
	CalComAvailabilityDatesFlowSpec,
	CalComRestError | undefined,
	CalComHttpClient
> = makeFlow(calcomAvailabilityDatesFlowSpec, CALCOM_DATES_INITIAL_KEYS)
	.add(calcomReadDatesStep)
	.build({
		flowId: 'availability_dates_refresh',
		backend: 'calcom',
		version: CALCOM_FLOW_VERSION,
	});

export const calcomAvailabilitySlotsFlow: Flow<
	CalComAvailabilitySlotsFlowSpec,
	CalComRestError | undefined,
	CalComHttpClient
> = makeFlow(calcomAvailabilitySlotsFlowSpec, CALCOM_SLOTS_INITIAL_KEYS)
	.add(calcomReadSlotsStep)
	.build({
		flowId: 'availability_slots_refresh',
		backend: 'calcom',
		version: CALCOM_FLOW_VERSION,
	});

/**
 * The registered CalCom read-only flows, keyed by flow id (= BridgeJobKind). The
 * booking job kind is deliberately omitted (read-only first, design §7).
 */
export const calcomFlows = {
	availability_dates_refresh: calcomAvailabilityDatesFlow,
	availability_slots_refresh: calcomAvailabilitySlotsFlow,
} as const;

/** Plan-predicted step-id sequence per flow (the projection asserted by the plan tests). */
export const calcomFlowStepIds = (
	kind: keyof typeof calcomFlows,
): readonly string[] => calcomFlows[kind].plan.nodes.map((node) => node.stepId);
