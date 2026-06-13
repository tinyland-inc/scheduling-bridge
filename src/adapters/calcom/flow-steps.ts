/**
 * CalCom REST step wrappers — read-only availability (dates + slots) as FlowSteps.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom: "the same flow ids with
 * REST-backed steps … its steps demand `HttpClient`, not `BrowserService`"),
 * §10 (0.7.0 block: "CalCom read-only pack"). TIN-2097 (Lane E).
 *
 * Each step's `run` returns an Effect whose R channel is `CalComHttpClient` — NEVER
 * `BrowserService` and NEVER `Scope.Scope`. That per-flow R typing is the lane's core
 * proof: a REST flow provisions an HTTP layer, never a browser layer (the union-R
 * erasure failure mode of an IR interpreter is structurally avoided). The state vocab
 * and flow ids are IDENTICAL to Acuity's availability flows, so the plan/job-kind
 * mapping is vendor-agnostic; only the transport differs.
 *
 * `serviceId` in CalCom is the numeric `eventTypeId`; `month` (dates) / `date` (slots)
 * frame the requested window. Landing is observed via the response-shape probe
 * (`detectCalComStationFromResponse`), confidence 1.0 — not a DOM probe.
 */

import { Effect, Schema } from 'effect';
import type { FlowStep } from '../../flow/step.js';
import type { StateOf } from '../../flow/state.js';
import { CalComHttpClient } from './http-client.js';
import { type CalComRestError } from './errors.js';
import { parseSlotsResponse, slotsForDate, slotsToDates } from './slots-api.js';
import { detectCalComStationFromResponse } from './station-detector.js';

/** The CalCom v2 read-only slots endpoint. */
export const CALCOM_SLOTS_PATH = '/slots';

// =============================================================================
// STATE SPECS — IDENTICAL vocab to the Acuity availability flows (design §7: "same
// flow ids"); JSON-encodable (design §4 state.ts; absent values encoded as null).
// =============================================================================

/** Availability dates flow state vocabulary (matches acuityAvailabilityDatesFlowSpec). */
export const calcomAvailabilityDatesFlowSpec = {
	serviceId: Schema.String,
	month: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	dates: Schema.Array(Schema.Struct({ date: Schema.String, slots: Schema.Number })),
} as const;

export type CalComAvailabilityDatesFlowSpec = typeof calcomAvailabilityDatesFlowSpec;

export const CALCOM_DATES_INITIAL_KEYS = ['serviceId', 'month', 'serviceName'] as const;

/** Availability slots flow state vocabulary (matches acuityAvailabilitySlotsFlowSpec). */
export const calcomAvailabilitySlotsFlowSpec = {
	serviceId: Schema.String,
	date: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	slots: Schema.Array(
		Schema.Struct({ datetime: Schema.String, available: Schema.Boolean }),
	),
} as const;

export type CalComAvailabilitySlotsFlowSpec = typeof calcomAvailabilitySlotsFlowSpec;

export const CALCOM_SLOTS_INITIAL_KEYS = ['serviceId', 'date', 'serviceName'] as const;

// =============================================================================
// STEP TYPES — R is CalComHttpClient ONLY (no BrowserService, no Scope)
// =============================================================================

type DatesStep<N extends keyof CalComAvailabilityDatesFlowSpec & string> = FlowStep<
	CalComAvailabilityDatesFlowSpec,
	N,
	'dates',
	CalComRestError | undefined,
	CalComHttpClient
>;

type SlotsStep<N extends keyof CalComAvailabilitySlotsFlowSpec & string> = FlowStep<
	CalComAvailabilitySlotsFlowSpec,
	N,
	'slots',
	CalComRestError | undefined,
	CalComHttpClient
>;

/**
 * Read availability DATES for the requested month: GET /slots over the eventTypeId,
 * project the date→slots map to `{ date, slots }[]`. R = CalComHttpClient.
 */
export const calcomReadDatesStep: DatesStep<'serviceId' | 'month'> = {
	meta: {
		id: 'calcom/read-dates',
		needs: ['serviceId', 'month'],
		provides: ['dates'],
		expects: ['calcom:slots'],
		idempotency: 'read',
		segment: 'read-dates',
		tags: ['read'],
		// REST has no selector keys; the drift surface is the response shape, not a DOM.
		selectorKeys: [],
	},
	run: (input) =>
		Effect.gen(function* () {
			const http = yield* CalComHttpClient;
			const body = yield* http.getJson(CALCOM_SLOTS_PATH, {
				eventTypeId: input.serviceId,
				start: `${input.month}-01`,
				end: `${input.month}-31`,
			});
			const parsed = parseSlotsResponse(CALCOM_SLOTS_PATH, body);
			if (parsed instanceof Error) return yield* Effect.fail(parsed);
			return {
				state: { dates: slotsToDates(parsed) },
				observed: detectCalComStationFromResponse(['calcom:slots'], body),
			};
		}),
};

/**
 * Read availability SLOTS for the requested date: GET /slots over the eventTypeId,
 * project the date's entries to `{ datetime, available }[]`. R = CalComHttpClient.
 */
export const calcomReadSlotsStep: SlotsStep<'serviceId' | 'date'> = {
	meta: {
		id: 'calcom/read-slots',
		needs: ['serviceId', 'date'],
		provides: ['slots'],
		expects: ['calcom:slots'],
		idempotency: 'read',
		segment: 'read-slots',
		tags: ['read'],
		selectorKeys: [],
	},
	run: (input) =>
		Effect.gen(function* () {
			const http = yield* CalComHttpClient;
			const body = yield* http.getJson(CALCOM_SLOTS_PATH, {
				eventTypeId: input.serviceId,
				start: input.date,
				end: input.date,
			});
			const parsed = parseSlotsResponse(CALCOM_SLOTS_PATH, body);
			if (parsed instanceof Error) return yield* Effect.fail(parsed);
			return {
				state: { slots: slotsForDate(parsed, input.date) },
				observed: detectCalComStationFromResponse(['calcom:slots'], body),
			};
		}),
};

/** Convenience re-exports for tests/snapshots: the StateOf projections. */
export type CalComDatesState = StateOf<CalComAvailabilityDatesFlowSpec>;
export type CalComSlotsState = StateOf<CalComAvailabilitySlotsFlowSpec>;
