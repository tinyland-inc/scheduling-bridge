/**
 * Flag-gated flow execution wiring for the bridge worker (TIN-2036).
 * Design: docs/design/flow-dag-formalization.md §5 (fold semantics, plan-hash
 * pinning, idempotency boundaries), §10 (0.6.0 block: execution through `runFlow`
 * only when BRIDGE_FLOW_RUNNER is on, default off).
 *
 * THE INVIOLABLE 0.6.0 CONSTRAINT: nothing in this module runs unless the flag is
 * on. The legacy executor path (src/server/worker.ts) is byte-for-byte preserved as
 * the default; flagged-path status transitions are mapped to EQUAL the legacy
 * transitions (`exitToValue` / `assertPaymentBypassProven` semantics), asserted by
 * the parity tests.
 */

import { randomUUID } from 'node:crypto';
import { Cause, Effect, Exit, type Layer } from 'effect';
import type { Redis as IORedis } from 'ioredis';
import {
	toSchedulingError,
	type MiddlewareError,
} from '../adapters/acuity/errors.js';
import { toBooking, type ConfirmationData } from '../adapters/acuity/steps/index.js';
import {
	toClientState,
	type AcuityBookingFlowSpec,
} from '../adapters/acuity/flow-steps.js';
import type { AppointmentCommand } from '../async/types.js';
import type { Booking } from '../core/types.js';
import {
	BridgeJobExecutionError,
	BridgeJobPlanSkewError,
	type BridgeJobLeaseContext,
} from '../async/worker.js';
import {
	FlowDivergedError,
	FlowJournal,
	createInMemoryFlowJournal,
	createPostgresFlowJournal,
	createRedisFlowJournal,
	parseFlowJournalTtlSeconds,
	runFlow,
	type Flow,
	type FlowJournalShape,
	type FlowOutcome,
} from '../flow/index.js';
import type { StateOf } from '../flow/state.js';

// =============================================================================
// FLAG
// =============================================================================

/**
 * BRIDGE_FLOW_RUNNER gate (design §10: `BRIDGE_FLOW_RUNNER=1`, default off). The
 * repo's boolean-knob convention is 'true'/'false' (BRIDGE_INLINE_WORKER_ENABLED),
 * so both spellings are accepted; everything else — including unset — is OFF.
 */
export const parseBridgeFlowRunnerEnabled = (
	env: Partial<Record<'BRIDGE_FLOW_RUNNER', string>> = process.env,
): boolean => env.BRIDGE_FLOW_RUNNER === '1' || env.BRIDGE_FLOW_RUNNER === 'true';

// =============================================================================
// JOURNAL SELECTION (rides the existing store selection order: Postgres → Redis →
// memory; src/server/stores.ts / src/server/worker.ts `createWorkerStore`)
// =============================================================================

export interface SelectFlowJournalOptions {
	/** Reuse an existing ioredis client (the inline worker's L2 client). */
	readonly redisClient?: IORedis | null;
	readonly env?: NodeJS.ProcessEnv;
}

export const selectFlowJournal = (
	options: SelectFlowJournalOptions = {},
): FlowJournalShape => {
	const env = options.env ?? process.env;
	if (env.BRIDGE_DATABASE_URL) {
		return createPostgresFlowJournal({
			connectionString: env.BRIDGE_DATABASE_URL,
			ssl: env.BRIDGE_DATABASE_SSL === 'true',
			migrate: env.BRIDGE_DATABASE_MIGRATE !== 'false',
		});
	}
	if (options.redisClient) {
		return createRedisFlowJournal({
			client: options.redisClient,
			ttlSeconds: parseFlowJournalTtlSeconds(
				env as Partial<Record<'BRIDGE_FLOW_JOURNAL_TTL_SECONDS', string>>,
			),
		});
	}
	if (env.REDIS_URL) {
		return createRedisFlowJournal({
			url: env.REDIS_URL,
			redisOptions: {
				password: env.REDIS_PASSWORD,
				maxRetriesPerRequest: 3,
			},
			ttlSeconds: parseFlowJournalTtlSeconds(
				env as Partial<Record<'BRIDGE_FLOW_JOURNAL_TTL_SECONDS', string>>,
			),
		});
	}
	return createInMemoryFlowJournal();
};

// =============================================================================
// STATUS BOUNDARIES (legacy parity)
// =============================================================================

/**
 * The `reconcile_required` boundary, exactly as the legacy worker draws it
 * (`createBookingWithPayment`, src/server/worker.ts): submit and
 * extract-confirmation failures have crossed (or may have crossed) the external
 * point of no return; everything earlier is `failed_pre_submit`.
 */
export const RECONCILE_BOUNDARY_STEP_IDS: ReadonlySet<string> = new Set([
	'acuity/submit',
	'acuity/extract-confirmation',
]);

/** Legacy `runWizardStep` step labels, keyed by flow step id (failure `step` parity). */
export const LEGACY_STEP_LABELS: Readonly<Record<string, string>> = {
	'acuity/navigate': 'navigate',
	'acuity/fill-form': 'fill-form',
	'acuity/bypass-payment': 'bypass-payment',
	'acuity/submit': 'submit',
	'acuity/extract-confirmation': 'extract-confirmation',
	'acuity/read-dates': 'refresh-availability-dates',
	'acuity/read-slots': 'refresh-availability-slots',
};

const legacyStepLabel = (stepId: string | undefined): string | undefined =>
	stepId === undefined ? undefined : (LEGACY_STEP_LABELS[stepId] ?? stepId);

const statusForStep = (
	stepId: string | undefined,
): 'failed_pre_submit' | 'reconcile_required' =>
	stepId !== undefined && RECONCILE_BOUNDARY_STEP_IDS.has(stepId)
		? 'reconcile_required'
		: 'failed_pre_submit';

const MIDDLEWARE_ERROR_TAGS = new Set([
	'BrowserError',
	'SelectorError',
	'WizardStepError',
	'CouponError',
	'ServiceResolverError',
]);

const isMiddlewareError = (error: unknown): error is MiddlewareError =>
	typeof error === 'object' &&
	error !== null &&
	'_tag' in error &&
	MIDDLEWARE_ERROR_TAGS.has(String((error as { _tag: unknown })._tag));

/**
 * Map a failed flow exit onto the legacy `exitToValue` status vocabulary
 * (src/server/worker.ts): same status, same code derivation
 * (`SchedulingError.code ?? _tag ?? 'UNKNOWN'`), same retryable rule
 * (`status === 'failed_pre_submit'`), and the legacy step labels. The bypass-proof
 * divergence maps to the exact legacy `PAYMENT_BYPASS_NOT_PROVEN` failure
 * (`assertPaymentBypassProven`).
 */
export const flowCauseToExecutionError = (
	cause: Cause.Cause<unknown>,
	lastStartedStepId: string | undefined,
): BridgeJobExecutionError => {
	const failure = Cause.failureOption(cause);
	const error = failure._tag === 'Some' ? failure.value : undefined;

	if (error instanceof BridgeJobExecutionError) return error;

	if (error instanceof FlowDivergedError) {
		if (error.stepId === 'acuity/bypass-payment') {
			return new BridgeJobExecutionError({
				status: 'failed_pre_submit',
				code: 'PAYMENT_BYPASS_NOT_PROVEN',
				message: 'Payment bypass was not proven before submit',
				step: 'bypass-payment',
				retryable: false,
			});
		}
		const status = statusForStep(error.stepId);
		return new BridgeJobExecutionError({
			status,
			code: 'FLOW_DIVERGED',
			message: `Flow diverged at '${error.stepId}': landed on '${error.observation.observed}', expected [${error.observation.expected.join(', ')}]`,
			step: legacyStepLabel(error.stepId),
			retryable: status === 'failed_pre_submit',
		});
	}

	const status = statusForStep(lastStartedStepId);
	if (isMiddlewareError(error)) {
		// Same loose field extraction as the legacy worker's `schedulingErrorFields`
		// (not every SchedulingError variant carries `code`/`message`).
		const schedulingError = toSchedulingError(error) as {
			_tag?: string;
			code?: string;
			message?: string;
		};
		return new BridgeJobExecutionError({
			status,
			code: schedulingError.code ?? schedulingError._tag ?? 'UNKNOWN',
			message: schedulingError.message ?? JSON.stringify(schedulingError),
			step: legacyStepLabel(lastStartedStepId),
			retryable: status === 'failed_pre_submit',
		});
	}
	if (
		typeof error === 'object' &&
		error !== null &&
		'_tag' in error &&
		'message' in error
	) {
		return new BridgeJobExecutionError({
			status,
			code: String((error as { _tag: unknown })._tag),
			message: String((error as { message: unknown }).message),
			step: legacyStepLabel(lastStartedStepId),
			retryable: status === 'failed_pre_submit',
		});
	}
	return new BridgeJobExecutionError({
		status,
		code: 'UNKNOWN',
		message: Cause.pretty(cause),
		step: legacyStepLabel(lastStartedStepId),
		retryable: status === 'failed_pre_submit',
	});
};

// =============================================================================
// SKEW CHECK (design §5 plan-hash pinning; FLAGGED PATH ONLY)
// =============================================================================

/**
 * Lease-time skew check: when the record carries a pinned planHash that does not
 * match the constructed flow's hash, the job must NOT execute on this replica.
 * If any effectful-once step already has a 'started' journal row, the job hard-maps
 * to `reconcile_required` (never silent re-submit); otherwise it is requeued with a
 * skew code for a matching replica to drain.
 */
export const checkFlowPlanSkew = async (
	flow: Flow<any, MiddlewareError | undefined, any>,
	journal: FlowJournalShape,
	context: BridgeJobLeaseContext | undefined,
): Promise<void> => {
	if (!context?.planHash || context.planHash === flow.planHash) return;

	if (context.operationId) {
		const rows = await Effect.runPromise(journal.read(context.operationId)).catch(
			() => [] as const,
		);
		const effectfulOnce = new Set(
			flow.plan.nodes
				.filter((node) => node.idempotency === 'effectful-once')
				.map((node) => node.stepId),
		);
		if (
			rows.some(
				(row) => row.status === 'started' && effectfulOnce.has(row.stepId),
			)
		) {
			throw new BridgeJobExecutionError({
				status: 'reconcile_required',
				code: 'FLOW_PLAN_SKEW',
				message: `Plan hash skew on '${flow.plan.flowId}' after an effectful-once step started (pinned ${context.planHash}, constructed ${flow.planHash})`,
				step: 'flow-plan',
				retryable: false,
			});
		}
	}

	throw new BridgeJobPlanSkewError({
		message: `Plan hash skew on '${flow.plan.flowId}': pinned ${context.planHash}, constructed ${flow.planHash} (flow version ${flow.plan.version})`,
		step: 'flow-plan',
	});
};

// =============================================================================
// FLOW EXECUTION (one Scope region per segment; journal provided per run)
// =============================================================================

/** Runs the (journal-provided) flow effect to an Exit. Injectable for tests. */
export type RunFlowExit = (
	effect: Effect.Effect<unknown, unknown, never>,
) => Promise<Exit.Exit<unknown, unknown>>;

export interface FlowExecutionDeps {
	readonly journal: FlowJournalShape;
	/** One session layer per segment (design §5 step 1); the production wiring passes
	 * `() => BrowserSessionLive`, tests substitute stub layers. */
	readonly sessionLayer: (segment: string) => Layer.Layer<any, any, any>;
	readonly runExit: RunFlowExit;
}

/** Journal interceptor: tracks the last 'started' stepId so step failures (which
 * carry no stepId of their own) can be mapped onto the legacy status boundaries. */
const traceJournal = (
	journal: FlowJournalShape,
	trace: { lastStarted: string | undefined },
): FlowJournalShape => ({
	append: (cp) =>
		Effect.suspend(() => {
			if (cp.status === 'started') trace.lastStarted = cp.stepId;
			return journal.append(cp);
		}),
	read: journal.read,
});

const runFlowToOutcome = async <Spec extends Record<string, any>>(
	deps: FlowExecutionDeps,
	flow: Flow<any, MiddlewareError | undefined, any>,
	initial: Record<string, unknown>,
	operationId: string,
): Promise<FlowOutcome<Partial<StateOf<Spec>>>> => {
	const trace = { lastStarted: undefined as string | undefined };
	const effect = runFlow(flow as Flow<Spec, MiddlewareError | undefined, any>, initial as never, {
		operationId,
		sessionLayer: deps.sessionLayer,
	}).pipe(
		Effect.provideService(FlowJournal, traceJournal(deps.journal, trace)),
	) as unknown as Effect.Effect<unknown, unknown, never>;
	const exit = await deps.runExit(effect);
	if (Exit.isFailure(exit)) {
		throw flowCauseToExecutionError(exit.cause, trace.lastStarted);
	}
	return exit.value as FlowOutcome<Partial<StateOf<Spec>>>;
};

/**
 * The flagged booking execution: the production worker's step sequence through the
 * fold, with the bypass-proof boundary (Diverged on the payment-injection step ⇒
 * PAYMENT_BYPASS_NOT_PROVEN) and the reconcile_required mapping preserved. The
 * REST-path and coupon guards stay in the executor (src/server/worker.ts) so their
 * legacy codes are byte-identical.
 */
export const executeBookingThroughFlow = async (
	deps: FlowExecutionDeps,
	flow: Flow<AcuityBookingFlowSpec, MiddlewareError | undefined, any>,
	command: AppointmentCommand,
	couponCode: string,
	context: BridgeJobLeaseContext | undefined,
): Promise<Booking> => {
	await checkFlowPlanSkew(flow, deps.journal, context);
	const outcome = await runFlowToOutcome<AcuityBookingFlowSpec>(
		deps,
		flow,
		{
			serviceId: command.request.serviceId,
			datetime: command.request.datetime,
			serviceName: command.serviceName ?? null,
			client: toClientState(command.request.client),
			couponCode,
			paymentRef: command.paymentRef,
			paymentProcessor: command.paymentProcessor,
		},
		context?.operationId ?? randomUUID(),
	);
	const confirmation = outcome.output.confirmation;
	if (!confirmation) {
		throw new BridgeJobExecutionError({
			status: 'reconcile_required',
			code: 'FLOW_OUTPUT_MISSING',
			message: 'Booking flow completed without confirmation state',
			step: 'extract-confirmation',
			retryable: false,
		});
	}
	return toBooking(
		confirmation as ConfirmationData,
		command.request,
		command.paymentRef,
		command.paymentProcessor,
	);
};

/**
 * The flagged availability execution (dates or slots): the single self-navigating
 * read step through the fold. Failure parity: legacy `runWizardStep` maps any
 * refresh failure to retryable `failed_pre_submit` — so does this.
 */
export const executeReadThroughFlow = async <A>(
	deps: FlowExecutionDeps,
	flow: Flow<any, MiddlewareError | undefined, any>,
	initial: Record<string, unknown>,
	outputKey: string,
	context: BridgeJobLeaseContext | undefined,
): Promise<A> => {
	await checkFlowPlanSkew(flow, deps.journal, context);
	const outcome = await runFlowToOutcome(
		deps,
		flow,
		initial,
		context?.operationId ?? randomUUID(),
	);
	return (outcome.output as Record<string, unknown>)[outputKey] as A;
};
