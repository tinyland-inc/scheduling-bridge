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
	FlowRunError,
	createInMemoryFlowJournal,
	createNoopFlowJournal,
	createPostgresFlowJournal,
	createRedisFlowJournal,
	parseFlowJournalSampleRate,
	parseFlowJournalTtlSeconds,
	runFlow,
	shouldJournalReadFlow,
	type Flow,
	type FlowCheckpoint,
	type FlowJournalShape,
	type FlowMetricsHook,
	type FlowOutcome,
	type FlowPlanNode,
	type LandingObservation,
} from '../flow/index.js';
import type { StateOf } from '../flow/state.js';
import {
	observeFlowStepDuration,
	recordFlowStepAttempt,
	recordFlowStepFailure,
	recordFlowStepLanding,
	recordFlowStepReroute,
} from '../shared/metrics.js';

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

	// The fold's resume-side idempotency backstop (design §5: a `started`
	// checkpoint without `completed` on an effectful-once step hard-maps to
	// reconcile_required — never silent re-submit). The confirmation-probe gate
	// normally intercepts before runFlow; this mapping covers any other entry.
	if (error instanceof FlowRunError && error.code === 'EFFECTFUL_ONCE_REPLAY') {
		return new BridgeJobExecutionError({
			status: 'reconcile_required',
			code: 'EFFECTFUL_ONCE_REPLAY',
			message: error.message,
			step: legacyStepLabel(lastStartedStepId) ?? 'flow-resume',
			retryable: false,
		});
	}

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

/**
 * Per-stepId metrics hook (design §10 0.6.x), backed by the `shared/metrics.ts`
 * prom-client collectors. Shared by booking and read paths — cardinality is bounded
 * by the registered plan step ids. Only ever invoked on the flagged path (the fold);
 * the default legacy path records nothing here.
 */
export const flowMetricsHook: FlowMetricsHook = {
	onAttempt: recordFlowStepAttempt,
	onFailure: recordFlowStepFailure,
	onReroute: recordFlowStepReroute,
	onDuration: observeFlowStepDuration,
	onLanding: (flowId, stepId, landing) =>
		recordFlowStepLanding(
			flowId,
			stepId,
			landing === 'on-track' ? 'on_track' : landing,
		),
};

interface RunFlowToOutcomeOptions {
	readonly resume?: boolean;
}

const runFlowToOutcome = async <Spec extends Record<string, any>>(
	deps: FlowExecutionDeps,
	flow: Flow<any, MiddlewareError | undefined, any>,
	initial: Record<string, unknown>,
	operationId: string,
	opts: RunFlowToOutcomeOptions = {},
): Promise<FlowOutcome<Partial<StateOf<Spec>>>> => {
	const trace = { lastStarted: undefined as string | undefined };
	const effect = runFlow(flow as Flow<Spec, MiddlewareError | undefined, any>, initial as never, {
		operationId,
		sessionLayer: deps.sessionLayer,
		resume: opts.resume ?? false,
		metrics: flowMetricsHook,
	}).pipe(
		Effect.provideService(FlowJournal, traceJournal(deps.journal, trace)),
	) as unknown as Effect.Effect<unknown, unknown, never>;
	const exit = await deps.runExit(effect);
	if (Exit.isFailure(exit)) {
		throw flowCauseToExecutionError(exit.cause, trace.lastStarted);
	}
	return exit.value as FlowOutcome<Partial<StateOf<Spec>>>;
};

// =============================================================================
// CONFIRMATION-PROBE GATE (design §5 idempotency, the resume side of
// effectful-once: "Resume of a booking flow first runs a cheap
// extractConfirmation probe: confirmation found ⇒ succeeded; ambiguous ⇒
// reconcile_required with the step trace, landing observation, and evidence
// attached" — NEVER silent re-submit)
// =============================================================================

const describeProbeError = (error: unknown): string => {
	if (typeof error === 'object' && error !== null) {
		const maybe = error as { _tag?: string; message?: string };
		return `${maybe._tag ?? 'UNKNOWN'}: ${maybe.message ?? JSON.stringify(error)}`;
	}
	return String(error);
};

const maxJournaledAttempt = (
	rows: readonly FlowCheckpoint[],
	stepId: string,
): number =>
	rows.reduce(
		(max, row) => (row.stepId === stepId && row.attempt > max ? row.attempt : max),
		1,
	);

/** Evidence-only journal append: a failed write never changes the gate's verdict. */
const appendEvidence = async (
	journal: FlowJournalShape,
	cp: Omit<FlowCheckpoint, 'seq'>,
): Promise<void> => {
	await Effect.runPromise(journal.append(cp)).catch(() => undefined);
};

/**
 * Resolve a started-without-completed effectful-once checkpoint WITHOUT re-running
 * the effectful step: run the first read-class plan node after it (for the Acuity
 * booking flow, `acuity/extract-confirmation`) standalone in its own segment Scope.
 * Confirmation found ⇒ the booking succeeded — return it with the extracted data.
 * Anything else is ambiguous ⇒ reconcile_required carrying the journal step trace,
 * the landing observation, and the probe evidence. The submit step is never re-run.
 */
const probeConfirmationGate = async (
	deps: FlowExecutionDeps,
	flow: Flow<AcuityBookingFlowSpec, MiddlewareError | undefined, any>,
	command: AppointmentCommand,
	initial: Record<string, unknown>,
	rows: readonly FlowCheckpoint[],
	pending: FlowPlanNode,
	operationId: string,
): Promise<Booking> => {
	const trace = rows.map((row) => `${row.stepId}:${row.status}`).join(' -> ');

	const reconcile = (detail: string, landing?: LandingObservation): BridgeJobExecutionError =>
		new BridgeJobExecutionError({
			status: 'reconcile_required',
			code: 'CONFIRMATION_PROBE_AMBIGUOUS',
			message:
				`Effectful-once step '${pending.stepId}' has a started-without-completed checkpoint and was NOT re-run; ${detail}` +
				(landing
					? `; landing: observed '${landing.observed}', expected [${landing.expected.join(', ')}]`
					: '') +
				`; journal trace: ${trace}`,
			step: legacyStepLabel(pending.stepId),
			retryable: false,
		});

	const pendingIndex = flow.plan.nodes.findIndex((node) => node.stepId === pending.stepId);
	const probeNode = flow.plan.nodes
		.slice(pendingIndex + 1)
		.find((node) => node.idempotency === 'read');
	const probeStep = probeNode ? flow.steps.get(probeNode.stepId) : undefined;
	if (!probeNode || !probeStep) {
		throw reconcile('no read-class confirmation-probe step exists after it');
	}

	// Best-effort probe input: initial command state + journaled segment-boundary
	// deltas (the probe step is read-class and self-contained; absent needs stay absent).
	const merged: Record<string, unknown> = { ...initial };
	for (const row of rows) {
		if (row.stateDelta) Object.assign(merged, row.stateDelta);
	}
	const input = Object.fromEntries(probeNode.needs.map((key) => [key, merged[key]]));

	const exit = await deps.runExit(
		Effect.scoped(
			Effect.provide(
				probeStep.run(input as never) as Effect.Effect<unknown, unknown, any>,
				deps.sessionLayer(probeNode.segment) as Layer.Layer<any, any, any>,
			),
		) as unknown as Effect.Effect<unknown, unknown, never>,
	);

	const evidenceBase = {
		operationId,
		flowId: flow.plan.flowId,
		flowVersion: flow.plan.version,
		planHash: flow.planHash,
	};

	if (Exit.isSuccess(exit)) {
		const outcome = exit.value as {
			readonly state?: Record<string, unknown>;
			readonly observed?: LandingObservation;
		};
		const confirmation = outcome.state?.confirmation;
		if (confirmation) {
			// Confirmation found ⇒ the effectful-once step DID land; journal the
			// resolution (evidence-only) and surface the booking as succeeded.
			await appendEvidence(deps.journal, {
				...evidenceBase,
				stepId: pending.stepId,
				attempt: maxJournaledAttempt(rows, pending.stepId),
				status: 'completed',
				at: new Date().toISOString(),
				...(outcome.observed ? { landing: outcome.observed } : {}),
			});
			await appendEvidence(deps.journal, {
				...evidenceBase,
				stepId: probeNode.stepId,
				attempt: maxJournaledAttempt(rows, probeNode.stepId),
				status: 'completed',
				at: new Date().toISOString(),
				...(outcome.observed ? { landing: outcome.observed } : {}),
			});
			return toBooking(
				confirmation as ConfirmationData,
				command.request,
				command.paymentRef,
				command.paymentProcessor,
			);
		}
		const landing: LandingObservation = outcome.observed ?? {
			expected: probeNode.expects,
			observed: 'unknown',
			confidence: 0,
			evidence: [],
		};
		throw reconcile('the confirmation probe returned no confirmation state', landing);
	}

	const failure = Cause.failureOption(exit.cause);
	const detail =
		failure._tag === 'Some'
			? describeProbeError(failure.value)
			: Cause.pretty(exit.cause);
	const landing: LandingObservation = {
		expected: probeNode.expects,
		observed: 'unknown',
		confidence: 0,
		evidence: [],
	};
	await appendEvidence(deps.journal, {
		...evidenceBase,
		stepId: probeNode.stepId,
		attempt: maxJournaledAttempt(rows, probeNode.stepId),
		status: 'failed',
		at: new Date().toISOString(),
		landing,
		error: { code: 'CONFIRMATION_PROBE_AMBIGUOUS', message: detail, retryable: false },
	});
	throw reconcile(`the confirmation probe ('${probeNode.stepId}') could not verify the outcome (${detail})`, landing);
};

/**
 * The flagged booking execution: the production worker's step sequence through the
 * fold, with the bypass-proof boundary (Diverged on the payment-injection step ⇒
 * PAYMENT_BYPASS_NOT_PROVEN) and the reconcile_required mapping preserved. The
 * REST-path and coupon guards stay in the executor (src/server/worker.ts) so their
 * legacy codes are byte-identical.
 *
 * Re-lease order (design §5): skew check first (FLOW_PLAN_SKEW semantics are
 * pinned), then the confirmation-probe gate when an effectful-once step has a
 * started-without-completed checkpoint (never reaches runFlow ⇒ never re-submits),
 * then segment-replay resume through the fold.
 */
export const executeBookingThroughFlow = async (
	deps: FlowExecutionDeps,
	flow: Flow<AcuityBookingFlowSpec, MiddlewareError | undefined, any>,
	command: AppointmentCommand,
	couponCode: string,
	context: BridgeJobLeaseContext | undefined,
): Promise<Booking> => {
	await checkFlowPlanSkew(flow, deps.journal, context);
	const operationId = context?.operationId ?? randomUUID();
	const initial: Record<string, unknown> = {
		serviceId: command.request.serviceId,
		datetime: command.request.datetime,
		serviceName: command.serviceName ?? null,
		client: toClientState(command.request.client),
		couponCode,
		paymentRef: command.paymentRef,
		paymentProcessor: command.paymentProcessor,
	};

	// Confirmation-probe gate (the resume side of effectful-once). Journal read is
	// evidence-tolerant: an unreadable journal degrades to a normal (resume-aware) run.
	const rows: readonly FlowCheckpoint[] = context?.operationId
		? await Effect.runPromise(deps.journal.read(context.operationId)).catch(
				() => [] as const,
			)
		: [];
	const pending = flow.plan.nodes.find(
		(node) =>
			node.idempotency === 'effectful-once' &&
			rows.some((row) => row.stepId === node.stepId && row.status === 'started') &&
			!rows.some((row) => row.stepId === node.stepId && row.status === 'completed'),
	);
	if (pending) {
		return probeConfirmationGate(deps, flow, command, initial, rows, pending, operationId);
	}

	// Booking flows ALWAYS await journaling and are never sampled out (design §5).
	const outcome = await runFlowToOutcome<AcuityBookingFlowSpec>(
		deps,
		flow,
		initial,
		operationId,
		{ resume: true },
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
 *
 * Segment-replay resume (design §5): on re-lease of a job whose journal already
 * has a segment-boundary checkpoint, prior segments are skipped (`skipped_resume`
 * rows) and their Provides decoded from the journaled stateDelta; a journal with
 * only failed attempts re-runs from the head (read steps re-run freely).
 */
export const executeReadThroughFlow = async <A>(
	deps: FlowExecutionDeps,
	flow: Flow<any, MiddlewareError | undefined, any>,
	initial: Record<string, unknown>,
	outputKey: string,
	context: BridgeJobLeaseContext | undefined,
): Promise<A> => {
	await checkFlowPlanSkew(flow, deps.journal, context);
	// Read-flow journal sampling (design §5 "Checkpoint persistence discipline" /
	// §10 0.6.x BRIDGE_FLOW_JOURNAL_SAMPLE): availability/read flows are sampled by
	// the knob; default rate 1.0 = journal every run (current behavior). Sampled OUT
	// ⇒ swap in a no-op journal so no rows persist (the skew check already ran against
	// the REAL journal above) and resume is skipped (a sampled-out read has nothing to
	// resume from; read steps re-run freely anyway). Sampled IN ⇒ journal as usual.
	//
	// Journaling stays AWAITED even for reads: the merged resume lane relies on read
	// journal rows being durably present, and the design's latency argument is already
	// satisfied because journal writes happen INSIDE job execution, never between the
	// request and the SETNX/snapshot path. The fold's read appends are still
	// failure-tolerant (log-and-continue), so a journal hiccup never fails a read.
	const sampleIn = shouldJournalReadFlow(parseFlowJournalSampleRate());
	const readDeps: FlowExecutionDeps = sampleIn
		? deps
		: { ...deps, journal: createNoopFlowJournal() };
	const outcome = await runFlowToOutcome(
		readDeps,
		flow,
		initial,
		context?.operationId ?? randomUUID(),
		{ resume: sampleIn },
	);
	return (outcome.output as Record<string, unknown>)[outputKey] as A;
};
