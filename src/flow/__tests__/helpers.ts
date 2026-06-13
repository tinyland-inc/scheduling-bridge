/**
 * Shared stubs for flow primitive tests.
 */

import { Schema, type Effect, type Schedule } from 'effect';
import type { FlowStep, IdempotencyClass, StepOutcome, StepRunContext } from '../step.js';
import type { LandingObservation, StationId } from '../station.js';
import type { StateOf } from '../state.js';

export const spec = {
	bookingRef: Schema.String,
	navResult: Schema.String,
	formResult: Schema.String,
	confirmation: Schema.String,
} as const;

export type Spec = typeof spec;

export const observation = (
	observed: StationId | 'unknown',
	expected: readonly StationId[] = [],
	confidence = 1,
): LandingObservation => ({ expected, observed, confidence, evidence: [] });

export const makeStep = <
	N extends keyof Spec & string,
	P extends keyof Spec & string,
	E = never,
	R = never,
>(args: {
	readonly id: string;
	readonly needs: readonly N[];
	readonly provides: readonly P[];
	readonly segment?: string;
	readonly expects?: readonly StationId[];
	readonly idempotency?: IdempotencyClass;
	readonly retry?: Schedule.Schedule<unknown, unknown>;
	readonly run: (
		input: Pick<StateOf<Spec>, N>,
		context?: StepRunContext,
	) => Effect.Effect<StepOutcome<Spec, P>, E, R>;
	readonly compensate?: (output: Pick<StateOf<Spec>, P>) => Effect.Effect<void, never, R>;
}): FlowStep<Spec, N, P, E, R> => ({
	meta: {
		id: args.id,
		needs: args.needs,
		provides: args.provides,
		expects: args.expects ?? [],
		idempotency: args.idempotency ?? 'replayable-write',
		segment: args.segment ?? 'wizard',
		...(args.retry ? { retry: args.retry } : {}),
		tags: ['navigation'],
		selectorKeys: [],
	},
	run: args.run,
	...(args.compensate ? { compensate: args.compensate } : {}),
});
