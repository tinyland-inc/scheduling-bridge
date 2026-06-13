/**
 * Flow step metadata and contracts.
 * Design: docs/design/flow-dag-formalization.md §4 (step.ts) and §5 (idempotency).
 */

import type { Effect, Schedule } from 'effect';
import type { FlowStateSpec, StateOf } from './state.js';
import type { LandingObservation, StationId } from './station.js';
import type { FuzzyResolution } from './fuzzy.js';

/**
 * THE resume/retry gate driver:
 * - 'read': re-run freely.
 * - 'replayable-write': session-local; safe to re-drive on a fresh session.
 * - 'effectful-once': external point of no return (submitBooking) — a `started` checkpoint
 *   without `completed` hard-maps to `reconcile_required`, never silent re-submit.
 */
export type IdempotencyClass = 'read' | 'replayable-write' | 'effectful-once';

export type StepTag = 'navigation' | 'mutation' | 'payment-injection' | 'extraction' | 'read';

/**
 * Error channel for step retry schedules. Steps are generic in E; Schedule input is
 * contravariant, so a `Schedule<unknown, FlowStepError>` composes with any step error type.
 */
export type FlowStepError = unknown;

export interface StepMeta<
	Spec extends FlowStateSpec,
	Needs extends keyof Spec & string,
	Provides extends keyof Spec & string,
> {
	/** e.g. 'acuity/navigate' */
	readonly id: string;
	/** Typed input keys (edges in). */
	readonly needs: readonly Needs[];
	/** Typed output keys (edges out). */
	readonly provides: readonly Provides[];
	/** Fuzzy-out: acceptable landings. */
	readonly expects: readonly StationId[];
	/** THE resume/retry gate driver. */
	readonly idempotency: IdempotencyClass;
	/** Scope region; one page session per segment. */
	readonly segment: string;
	readonly retry?: Schedule.Schedule<unknown, FlowStepError>;
	readonly tags: readonly StepTag[];
	/** Selector-drift audit surface. */
	readonly selectorKeys: readonly string[];
}

export interface StepOutcome<Spec extends FlowStateSpec, Provides extends keyof Spec & string> {
	readonly state: Pick<StateOf<Spec>, Provides>;
	readonly observed?: LandingObservation;
	readonly resolutions?: readonly FuzzyResolution<unknown>[];
	/** e.g. generated coupon code */
	readonly idempotencyToken?: string;
}

/**
 * Per-attempt execution context the fold threads into `run` (design §5 idempotency:
 * "a retried payment-injection segment reuses the journaled `idempotencyToken` …
 * instead of minting another"). Additive and optional — steps that mint nothing
 * ignore it; steps that mint MUST prefer `idempotencyToken` when present.
 */
export interface StepRunContext {
	/** Token minted by a prior attempt (re-attached in-run, or journal-seeded on resume). */
	readonly idempotencyToken?: string;
}

export interface FlowStep<
	Spec extends FlowStateSpec,
	Needs extends keyof Spec & string,
	Provides extends keyof Spec & string,
	E,
	R,
> {
	readonly meta: StepMeta<Spec, Needs, Provides>;
	readonly run: (
		input: Pick<StateOf<Spec>, Needs>,
		context?: StepRunContext,
	) => Effect.Effect<StepOutcome<Spec, Provides>, E, R>;
	/** Vendor-side cleanup only (e.g. admin-API cancel). NEVER payment refunds — kit's
	 * pipeline owns those (kit src/core/pipelines.ts:89). */
	readonly compensate?: (
		output: Pick<StateOf<Spec>, Provides>,
	) => Effect.Effect<void, never, R>;
}
