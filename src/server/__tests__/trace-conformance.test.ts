/**
 * Trace-conformance harness (TIN-2072; design §10 0.6.x bullet 1, §11 "Trace
 * conformance"). THE FLAG-FLIP GATE: a green run of this suite is the parity
 * evidence the BRIDGE_FLOW_RUNNER default flip requires. Evidence summary lives in
 * docs/design/parity-evidence.md.
 *
 * Mechanics: BOTH execution paths — the legacy production worker executor
 * (src/server/worker.ts, flag off) and the runFlow fold (src/server/flow-runner.ts,
 * flag on) — are driven over IDENTICAL substituted stub step sets. Every stub is
 * wrapped in a tracing decorator that records, in execution order:
 *
 *   - `scope-open` events: one per browser-session Scope acquisition (the legacy
 *     `runWizardStep` page-per-step lifecycle vs the fold's one-Scope-per-segment
 *     lifecycle), recorded by a counting session Layer on both paths;
 *   - `step` events: the underlying step program invoked + its outcome.
 *
 * The recorded trace (ordered step ids + per-step outcome + terminal job status) is
 * deep-compared between the two paths for all three job kinds, across happy paths,
 * the bypass-proof boundary (PAYMENT_BYPASS_NOT_PROVEN), pre-submit failures,
 * the submit/post-submit reconcile_required boundary, and job-level retry
 * (requeue + re-lease — the only retry the legacy path performs; no step has
 * `meta.retry`). The segment layout is pinned against the production worker's
 * page lifecycle by asserting scope-acquisition counts and step groupings.
 *
 * No production module is modified: stubs are substituted at the module boundary
 * (the flow-runner.test.ts seam style) and the browser layers are replaced with
 * counting succeed/sync Layers, so no Chromium is ever launched.
 */

import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// HOISTED HARNESS STATE (referenced from the vi.mock factories)
// =============================================================================

const harness = vi.hoisted(() => {
	const events: { kind: string; stepId?: string; outcome?: string }[] = [];
	/**
	 * Wrap a stub step program so its invocation + outcome land on the shared trace
	 * at EXECUTION time (Effect.suspend), i.e. inside whatever session Scope the
	 * executing path opened — this is what makes scope-open/step interleavings
	 * comparable across the two paths. `E` is the dynamically imported `effect`
	 * module (vi.mock factories run before static imports resolve).
	 */
	const traced =
		(E: any, stepId: string, mock: (...args: any[]) => any) =>
		(...args: any[]) =>
			E.suspend(() => {
				const entry = { kind: 'step', stepId, outcome: 'pending' };
				events.push(entry);
				return E.tapError(
					E.tap(
						mock(...args),
						() =>
							E.sync(() => {
								entry.outcome = 'ok';
							}),
					),
					(error: { _tag?: string } | undefined) =>
						E.sync(() => {
							entry.outcome = `error:${error?._tag ?? 'UNKNOWN'}`;
						}),
				);
			});
	return {
		events,
		traced,
		snapshot: () => events.map((event) => ({ ...event })),
	};
});

const stepMocks = vi.hoisted(() => ({
	navigateToBooking: vi.fn(),
	fillFormFields: vi.fn(),
	bypassPayment: vi.fn(),
	submitBooking: vi.fn(),
	extractConfirmation: vi.fn(),
	readAvailableDates: vi.fn(),
	readTimeSlots: vi.fn(),
	readDatesViaUrl: vi.fn(),
	readSlotsViaUrl: vi.fn(),
}));

// Both the legacy worker (direct imports) and the flow step wrappers
// (src/adapters/acuity/flow-steps.ts) resolve these modules, so ONE substitution
// feeds the identical stub set to BOTH execution paths.
vi.mock('../../adapters/acuity/steps/index.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../adapters/acuity/steps/index.js')>();
	const { Effect: E } = await import('effect');
	return {
		...actual,
		navigateToBooking: harness.traced(E, 'acuity/navigate', stepMocks.navigateToBooking),
		fillFormFields: harness.traced(E, 'acuity/fill-form', stepMocks.fillFormFields),
		bypassPayment: harness.traced(E, 'acuity/bypass-payment', stepMocks.bypassPayment),
		submitBooking: harness.traced(E, 'acuity/submit', stepMocks.submitBooking),
		extractConfirmation: harness.traced(
			E,
			'acuity/extract-confirmation',
			stepMocks.extractConfirmation,
		),
		readAvailableDates: harness.traced(
			E,
			'acuity/read-dates:wizard',
			stepMocks.readAvailableDates,
		),
		readTimeSlots: harness.traced(E, 'acuity/read-slots:wizard', stepMocks.readTimeSlots),
	};
});

vi.mock('../../adapters/acuity/steps/read-via-url.js', async () => {
	const { Effect: E } = await import('effect');
	return {
		readDatesViaUrl: harness.traced(
			E,
			'acuity/read-dates:via-url',
			stepMocks.readDatesViaUrl,
		),
		readSlotsViaUrl: harness.traced(
			E,
			'acuity/read-slots:via-url',
			stepMocks.readSlotsViaUrl,
		),
	};
});

// The legacy path's page lifecycle: every `runWizardStep` call provides
// BrowserSessionLive once — replacing it with a counting Layer.sync records one
// `scope-open` per legacy page acquisition. (The flagged path gets an explicit
// counting sessionLayer in `makeExecutors` below.)
vi.mock('../../shared/browser-service.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../shared/browser-service.js')>();
	const { Effect: E, Layer: L } = await import('effect');
	const fakeService = {
		acquirePage: E.succeed({} as never),
		screenshot: () => E.succeed(Buffer.from('')),
		config: actual.defaultBrowserConfig,
	};
	return {
		...actual,
		BrowserProcessLive: () =>
			L.succeed(actual.BrowserProcess, {
				browser: {} as never,
				config: actual.defaultBrowserConfig,
			}),
		BrowserSessionLive: L.sync(actual.BrowserService, () => {
			harness.events.push({ kind: 'scope-open' });
			return fakeService as never;
		}),
	};
});

import { createAcuityBridgeJobExecutor } from '../worker.js';
import {
	BrowserService,
	defaultBrowserConfig,
} from '../../shared/browser-service.js';
import { createInMemoryFlowJournal } from '../../flow/index.js';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';
import {
	BridgeJobExecutionError,
	executeBridgeJob,
	type BridgeJobExecutor,
	type BridgeJobLeaseContext,
} from '../../async/worker.js';
import type {
	AppointmentCommand,
	AvailabilityDatesRefreshCommand,
	AvailabilitySlotsRefreshCommand,
	BridgeAdapterProfile,
	BridgeJobFailure,
	BridgeJobRecord,
	BookingExecutionPath,
} from '../../async/types.js';
import { WizardStepError } from '../../adapters/acuity/errors.js';
import { acuityFlows } from '../../adapters/acuity/flows.js';
import type { Flow } from '../../flow/index.js';

// =============================================================================
// FIXTURES
// =============================================================================

const adapterProfile: BridgeAdapterProfile = {
	backend: 'acuity',
	baseUrl: 'https://example.as.me',
};

const bookingCommand = (couponCode?: string): AppointmentCommand => ({
	request: {
		serviceId: '53178494',
		datetime: '2026-06-15T16:00:00.000Z',
		client: {
			firstName: 'Jess',
			lastName: 'Sullivan',
			email: 'jess@example.com',
			phone: '6075551212',
			customFields: { pronouns: 'she/her' },
		},
	},
	paymentRef: 'pi_test_123',
	paymentProcessor: 'stripe',
	couponCode,
	serviceName: 'TMD single session',
	adapterProfile,
	couponBypassRequired: true,
	executionPreference: 'auto',
});

const DATES_FIXTURE = [{ date: '2026-06-20', slots: 1 }];
const WIZARD_DATES_FIXTURE = [{ date: '2026-06-21', slots: 1 }];
const SLOTS_FIXTURE = [{ datetime: '2026-06-15T16:00:00.000Z', available: true }];
const WIZARD_SLOTS_FIXTURE = [
	{ datetime: '2026-06-21T15:00:00.000Z', available: true },
];

// =============================================================================
// TRACE VOCABULARY + RUNNERS
// =============================================================================

type TraceEvent = { kind: string; stepId?: string; outcome?: string };

const open = { kind: 'scope-open' };
const step = (stepId: string, outcome = 'ok'): TraceEvent => ({
	kind: 'step',
	stepId,
	outcome,
});

/** Segment names the flagged fold requested (one push per segment Scope entry). */
const sessionSegments: string[] = [];

const fakeSessionService = {
	acquirePage: Effect.succeed({} as never),
	screenshot: () => Effect.succeed(Buffer.from('')),
	config: defaultBrowserConfig,
};

const resetTrace = () => {
	harness.events.length = 0;
	sessionSegments.length = 0;
};

const makeExecutors = () => {
	const journal = createInMemoryFlowJournal();
	const legacy = createAcuityBridgeJobExecutor({
		redisClient: null,
		flowRunner: false,
	});
	const flagged = createAcuityBridgeJobExecutor({
		redisClient: null,
		flowRunner: true,
		flowJournal: journal,
		// One counting Layer per segment (the run.test.ts session-counting pattern):
		// each build = one fold Scope acquisition, recorded on the SAME trace as the
		// legacy page acquisitions so the layouts are directly comparable.
		sessionLayer: (segment) => {
			sessionSegments.push(segment);
			return Layer.sync(BrowserService, () => {
				harness.events.push({ kind: 'scope-open' });
				return fakeSessionService as never;
			});
		},
	});
	return { journal, legacy, flagged };
};

interface Terminal {
	readonly status: string;
	readonly code?: string;
	readonly step?: string;
	readonly retryable?: boolean;
	readonly message?: string;
}

const terminalOf = (error: BridgeJobExecutionError): Terminal => ({
	status: error.status,
	code: error.code,
	step: error.step,
	retryable: error.retryable,
	message: error.message,
});

interface RunTrace {
	readonly events: TraceEvent[];
	readonly terminal: Terminal;
	readonly result?: unknown;
}

const runBookingTrace = async (
	executor: BridgeJobExecutor,
	command: AppointmentCommand,
	context: { executionPath: BookingExecutionPath } & BridgeJobLeaseContext,
): Promise<RunTrace> => {
	resetTrace();
	try {
		const booking = await executor.createBookingWithPayment(command, context);
		return {
			events: harness.snapshot(),
			terminal: { status: 'succeeded' },
			result: { ...booking, createdAt: 'pinned' },
		};
	} catch (error) {
		expect(error).toBeInstanceOf(BridgeJobExecutionError);
		return {
			events: harness.snapshot(),
			terminal: terminalOf(error as BridgeJobExecutionError),
		};
	}
};

const runDatesTrace = async (
	executor: BridgeJobExecutor,
	command: AvailabilityDatesRefreshCommand,
): Promise<RunTrace> => {
	resetTrace();
	try {
		const dates = await executor.refreshAvailabilityDates(command);
		return { events: harness.snapshot(), terminal: { status: 'succeeded' }, result: dates };
	} catch (error) {
		expect(error).toBeInstanceOf(BridgeJobExecutionError);
		return {
			events: harness.snapshot(),
			terminal: terminalOf(error as BridgeJobExecutionError),
		};
	}
};

const runSlotsTrace = async (
	executor: BridgeJobExecutor,
	command: AvailabilitySlotsRefreshCommand,
): Promise<RunTrace> => {
	resetTrace();
	try {
		const slots = await executor.refreshAvailabilitySlots(command);
		return { events: harness.snapshot(), terminal: { status: 'succeeded' }, result: slots };
	} catch (error) {
		expect(error).toBeInstanceOf(BridgeJobExecutionError);
		return {
			events: harness.snapshot(),
			terminal: terminalOf(error as BridgeJobExecutionError),
		};
	}
};

/** Steps grouped by the session Scope they executed in (groups = page lifetimes). */
const stepGroupings = (events: readonly TraceEvent[]): string[][] => {
	const groups: string[][] = [];
	for (const event of events) {
		if (event.kind === 'scope-open') {
			groups.push([]);
			continue;
		}
		const current = groups[groups.length - 1];
		if (!current) {
			throw new Error(`step '${event.stepId}' executed outside any session scope`);
		}
		current.push(event.stepId as string);
	}
	return groups;
};

/** The segment layout the plan DECLARES (contiguous segment runs, in plan order). */
const planSegmentGroupings = (
	flow: Flow<any, any, any>,
): { segment: string; steps: string[] }[] => {
	const groups: { segment: string; steps: string[] }[] = [];
	for (const node of flow.plan.nodes) {
		const last = groups[groups.length - 1];
		if (last && last.segment === node.segment) last.steps.push(node.stepId);
		else groups.push({ segment: node.segment, steps: [node.stepId] });
	}
	return groups;
};

const failureTuple = (failure: BridgeJobFailure | undefined) =>
	failure && {
		status: failure.status,
		code: failure.code,
		step: failure.step,
		retryable: failure.retryable,
		message: failure.message,
	};

/** One row of job-status evolution across the requeue + re-lease cycle. */
interface JobTransition {
	readonly status?: string;
	readonly failure?: ReturnType<typeof failureTuple>;
	readonly attempts?: number;
	readonly result?: unknown;
}

const freshSlotsSnapshot = (
	store: ReturnType<typeof createInMemoryBridgeAsyncStore>,
) =>
	store.upsertAvailabilitySnapshot({
		kind: 'slots',
		serviceId: '53178494',
		scope: '2026-06-15',
		adapterProfile,
		value: SLOTS_FIXTURE as never,
		observedAt: new Date().toISOString(),
		staleAt: new Date(Date.now() + 5 * 60_000).toISOString(),
		expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
	});

beforeEach(() => {
	vi.clearAllMocks();
	resetTrace();
	stepMocks.navigateToBooking.mockReturnValue(
		Effect.succeed({
			url: 'https://example.as.me/schedule/mock/datetime/2026-06-15T16:00:00.000Z',
			landingStep: 'client-form',
			appointmentTypeId: '53178494',
			calendarId: '1234',
			selectedDate: '2026-06-15',
			selectedTime: '12:00 PM',
		}),
	);
	stepMocks.fillFormFields.mockReturnValue(
		Effect.succeed({
			fieldsCompleted: ['firstName', 'lastName', 'email'],
			customFieldsCompleted: [],
			intakeFieldsCompleted: [],
			advanced: true,
		}),
	);
	stepMocks.bypassPayment.mockReturnValue(
		Effect.succeed({
			couponApplied: true,
			code: 'TEST-100',
			totalAfterCoupon: '$0.00',
		}),
	);
	stepMocks.submitBooking.mockReturnValue(
		Effect.succeed({ submitted: true, confirmationPageReached: true }),
	);
	stepMocks.extractConfirmation.mockReturnValue(
		Effect.succeed({
			appointmentId: 'apt_123',
			confirmationCode: 'confirm_123',
			serviceName: 'TMD single session',
			datetime: '2026-06-15T16:00:00.000Z',
			providerName: null,
			rawText: 'Booking confirmed',
		}),
	);
	stepMocks.readDatesViaUrl.mockReturnValue(Effect.succeed(DATES_FIXTURE));
	stepMocks.readSlotsViaUrl.mockReturnValue(Effect.succeed(SLOTS_FIXTURE));
	stepMocks.readAvailableDates.mockReturnValue(Effect.succeed(WIZARD_DATES_FIXTURE));
	stepMocks.readTimeSlots.mockReturnValue(Effect.succeed(WIZARD_SLOTS_FIXTURE));
});

// =============================================================================
// HAPPY PATHS — all three job kinds
// =============================================================================

describe('trace conformance: happy paths (legacy worker vs runFlow fold)', () => {
	it('booking: identical step trace, scope layout, terminal status, and booking result', async () => {
		const { legacy, flagged, journal } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId: 'op-trace-happy',
		});
		const flaggedSegments = [...sessionSegments];

		// The gate: byte-identical traces (ordered step ids + per-step outcomes +
		// scope acquisitions) and identical terminal status/result.
		expect(flaggedTrace).toEqual(legacyTrace);

		// Pin the literal expected trace so a both-paths-equally-wrong regression
		// cannot slip through the equality assertion.
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/bypass-payment'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation'),
		]);
		expect(legacyTrace.terminal).toEqual({ status: 'succeeded' });
		expect((legacyTrace.result as { id: string }).id).toBe('apt_123');

		// The fold entered one Scope per plan segment, in plan order.
		expect(flaggedSegments).toEqual(
			acuityFlows.booking_create_with_payment.plan.nodes.map((node) => node.segment),
		);

		// Journal coherence: the evidence trail mirrors the recorded trace exactly
		// (started+completed per step, in the executed order).
		const rows = await Effect.runPromise(journal.read('op-trace-happy'));
		expect(rows.map((row) => [row.stepId, row.status])).toEqual([
			['acuity/navigate', 'started'],
			['acuity/navigate', 'completed'],
			['acuity/fill-form', 'started'],
			['acuity/fill-form', 'completed'],
			['acuity/bypass-payment', 'started'],
			['acuity/bypass-payment', 'completed'],
			['acuity/submit', 'started'],
			['acuity/submit', 'completed'],
			['acuity/extract-confirmation', 'started'],
			['acuity/extract-confirmation', 'completed'],
		]);
		expect(rows.filter((row) => row.status === 'started').map((row) => row.stepId)).toEqual(
			legacyTrace.events
				.filter((event) => event.kind === 'step')
				.map((event) => event.stepId),
		);
	});

	it('availability dates: identical traces for both dispatch arms (via-url and wizard)', async () => {
		const { legacy, flagged } = makeExecutors();

		// Numeric appointment-type id → via-url read.
		const numeric = { serviceId: '53178494', month: '2026-06', adapterProfile };
		const legacyNumeric = await runDatesTrace(legacy, numeric);
		const flaggedNumeric = await runDatesTrace(flagged, numeric);
		expect(flaggedNumeric).toEqual(legacyNumeric);
		expect(legacyNumeric.events).toEqual([open, step('acuity/read-dates:via-url')]);
		expect(legacyNumeric.terminal).toEqual({ status: 'succeeded' });
		expect(legacyNumeric.result).toEqual(DATES_FIXTURE);

		// Non-numeric service id → wizard click-through read (worker dispatch parity).
		const named = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			month: '2026-06',
			adapterProfile,
		};
		const legacyNamed = await runDatesTrace(legacy, named);
		const flaggedNamed = await runDatesTrace(flagged, named);
		expect(flaggedNamed).toEqual(legacyNamed);
		expect(legacyNamed.events).toEqual([open, step('acuity/read-dates:wizard')]);
		expect(legacyNamed.result).toEqual(WIZARD_DATES_FIXTURE);
	});

	it('availability slots: identical traces for both dispatch arms (via-url and wizard)', async () => {
		const { legacy, flagged } = makeExecutors();

		const numeric = { serviceId: '53178494', date: '2026-06-15', adapterProfile };
		const legacyNumeric = await runSlotsTrace(legacy, numeric);
		const flaggedNumeric = await runSlotsTrace(flagged, numeric);
		expect(flaggedNumeric).toEqual(legacyNumeric);
		expect(legacyNumeric.events).toEqual([open, step('acuity/read-slots:via-url')]);
		expect(legacyNumeric.result).toEqual(SLOTS_FIXTURE);

		const named = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			date: '2026-06-21',
			adapterProfile,
		};
		const legacyNamed = await runSlotsTrace(legacy, named);
		const flaggedNamed = await runSlotsTrace(flagged, named);
		expect(flaggedNamed).toEqual(legacyNamed);
		expect(legacyNamed.events).toEqual([open, step('acuity/read-slots:wizard')]);
		expect(legacyNamed.result).toEqual(WIZARD_SLOTS_FIXTURE);
	});
});

// =============================================================================
// BYPASS-PROOF FAILURE (PAYMENT_BYPASS_NOT_PROVEN)
// =============================================================================

describe('trace conformance: bypass-proof failure (design §6 — Diverged on the payment-injection segment)', () => {
	it.each([
		[
			'coupon applied but total not zero',
			{ couponApplied: true, code: 'TEST-100', totalAfterCoupon: '$5.00' },
		],
		[
			'coupon not applied',
			{ couponApplied: false, code: 'TEST-100', totalAfterCoupon: null },
		],
	])(
		'PAYMENT_BYPASS_NOT_PROVEN: identical terminal status AND identical step cutoff (%s)',
		async (_label, bypassResult) => {
			stepMocks.bypassPayment.mockReturnValue(Effect.succeed(bypassResult));
			const { legacy, flagged } = makeExecutors();

			const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
				executionPath: 'browser',
			});
			const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
				executionPath: 'browser',
			});

			expect(flaggedTrace).toEqual(legacyTrace);
			// Same cutoff: the bypass step program ran (and "succeeded" as a program —
			// the PROOF failed), and neither path ever invoked submit or extract.
			expect(legacyTrace.events).toEqual([
				open,
				step('acuity/navigate'),
				open,
				step('acuity/fill-form'),
				open,
				step('acuity/bypass-payment'),
			]);
			expect(legacyTrace.terminal).toEqual({
				status: 'failed_pre_submit',
				code: 'PAYMENT_BYPASS_NOT_PROVEN',
				step: 'bypass-payment',
				retryable: false,
				message: 'Payment bypass was not proven before submit',
			});
			expect(stepMocks.submitBooking).not.toHaveBeenCalled();
			expect(stepMocks.extractConfirmation).not.toHaveBeenCalled();
		},
	);
});

// =============================================================================
// PRE-SUBMIT FAILURES (failed_pre_submit boundary)
// =============================================================================

describe('trace conformance: pre-submit failures (failed_pre_submit parity)', () => {
	it('navigate failure: identical trace cutoff and retryable failed_pre_submit terminal', async () => {
		stepMocks.navigateToBooking.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'navigate', message: 'nav broke' })),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(flaggedTrace).toEqual(legacyTrace);
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate', 'error:WizardStepError'),
		]);
		expect(legacyTrace.terminal.status).toBe('failed_pre_submit');
		expect(legacyTrace.terminal.step).toBe('navigate');
		expect(legacyTrace.terminal.retryable).toBe(true);
	});

	it('fill-form failure: identical trace cutoff and terminal', async () => {
		stepMocks.fillFormFields.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'fill-form', message: 'form broke' })),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(flaggedTrace).toEqual(legacyTrace);
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form', 'error:WizardStepError'),
		]);
		expect(legacyTrace.terminal.status).toBe('failed_pre_submit');
		expect(legacyTrace.terminal.step).toBe('fill-form');
		expect(legacyTrace.terminal.retryable).toBe(true);
	});

	it('REST execution-path guard: identical (empty) trace and terminal on both paths', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'rest',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'rest',
		});

		expect(flaggedTrace).toEqual(legacyTrace);
		expect(legacyTrace.events).toEqual([]);
		expect(legacyTrace.terminal).toMatchObject({
			status: 'failed_pre_submit',
			code: 'REST_BOOKING_NOT_WIRED',
			step: 'execution-path',
			retryable: false,
		});
	});

	it('COUPON_REQUIRED guard: identical terminal; the flagged path front-loads the guard (documented cutoff difference)', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand(undefined), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand(undefined), {
			executionPath: 'browser',
		});

		// Terminal parity is exact.
		expect(flaggedTrace.terminal).toEqual(legacyTrace.terminal);
		expect(legacyTrace.terminal).toMatchObject({
			status: 'failed_pre_submit',
			code: 'COUPON_REQUIRED',
			step: 'bypass-payment',
			retryable: false,
		});
		// KNOWN, INTENTIONAL cutoff difference (docs/design/parity-evidence.md): the
		// legacy worker only discovers the missing coupon after navigate + fill-form;
		// the flagged executor guards BEFORE any browser work (src/server/worker.ts).
		// Strictly less vendor work, same terminal failure.
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
		]);
		expect(flaggedTrace.events).toEqual([]);
	});
});

// =============================================================================
// SUBMIT / POST-SUBMIT (reconcile_required boundary)
// =============================================================================

describe('trace conformance: submit/post-submit ambiguity (reconcile_required parity)', () => {
	it('submit failure: identical trace cutoff, reconcile_required, non-retryable', async () => {
		stepMocks.submitBooking.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'submit', message: 'submit broke' })),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(flaggedTrace).toEqual(legacyTrace);
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/bypass-payment'),
			open,
			step('acuity/submit', 'error:WizardStepError'),
		]);
		expect(legacyTrace.terminal.status).toBe('reconcile_required');
		expect(legacyTrace.terminal.step).toBe('submit');
		expect(legacyTrace.terminal.retryable).toBe(false);
		expect(stepMocks.extractConfirmation).not.toHaveBeenCalled();
	});

	it('extract-confirmation failure: identical full-length trace, reconcile_required', async () => {
		stepMocks.extractConfirmation.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'extract', message: 'extract broke' })),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(flaggedTrace).toEqual(legacyTrace);
		expect(legacyTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/bypass-payment'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation', 'error:WizardStepError'),
		]);
		expect(legacyTrace.terminal.status).toBe('reconcile_required');
		expect(legacyTrace.terminal.step).toBe('extract-confirmation');
		expect(legacyTrace.terminal.retryable).toBe(false);
	});

	it('ambiguous submit (confirmation page not reached): both paths land on reconcile_required; the fold halts at submit instead of probing extract (documented cutoff difference)', async () => {
		stepMocks.submitBooking.mockReturnValue(
			Effect.succeed({ submitted: true, confirmationPageReached: false }),
		);
		// In production the legacy path discovers the ambiguity one step later, when
		// extractConfirmation fails its triple-probe on the non-confirmation page.
		stepMocks.extractConfirmation.mockReturnValue(
			Effect.fail(
				new WizardStepError({ step: 'extract', message: 'Not on confirmation page' }),
			),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		// reconcile_required parity: the terminal STATUS and retryability agree.
		expect(flaggedTrace.terminal.status).toBe('reconcile_required');
		expect(legacyTrace.terminal.status).toBe('reconcile_required');
		expect(flaggedTrace.terminal.retryable).toBe(false);
		expect(legacyTrace.terminal.retryable).toBe(false);

		// KNOWN, INTENTIONAL cutoff difference (docs/design/parity-evidence.md): the
		// fold classifies the unknown landing as Diverged AT submit (never blindly
		// extracting from an ambiguous page); the legacy path runs extract and fails
		// there. The flagged trace is a strict prefix of the legacy trace.
		expect(flaggedTrace.events).toEqual(legacyTrace.events.slice(0, 8));
		expect(flaggedTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/bypass-payment'),
			open,
			step('acuity/submit'),
		]);
		expect(flaggedTrace.terminal.code).toBe('FLOW_DIVERGED');
		expect(flaggedTrace.terminal.step).toBe('submit');
		expect(legacyTrace.terminal.step).toBe('extract-confirmation');
		// extract ran exactly once — on the legacy path only.
		expect(stepMocks.extractConfirmation).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// RETRY BEHAVIOR (job-level requeue + re-lease — where the legacy path retries)
// =============================================================================

describe('trace conformance: retry behavior (requeue + re-lease, full job machinery)', () => {
	const workerId = 'trace-conformance-worker';

	/** Fail the via-url dates read once, then succeed; drive the job through
	 * executeBridgeJob → retryable failed_pre_submit → requeue (the heartbeat
	 * semantics for retryable failures) → re-lease → success. */
	const runDatesRetry = async (executor: BridgeJobExecutor) => {
		resetTrace();
		stepMocks.readDatesViaUrl.mockReset();
		stepMocks.readDatesViaUrl
			.mockReturnValueOnce(
				Effect.fail(
					new WizardStepError({
						step: 'read-availability',
						message: 'transient read failure',
					}),
				),
			)
			.mockReturnValue(Effect.succeed(DATES_FIXTURE));

		const store = createInMemoryBridgeAsyncStore();
		const record = await store.enqueueJob({
			kind: 'availability_dates_refresh',
			command: { serviceId: '53178494', month: '2026-06', adapterProfile },
		});
		const first = await executeBridgeJob(store, record, executor, { workerId });
		const requeued = await store.requeueJob(record.operationId);
		const [ready] = await store.listReadyJobs(10);
		const second = await executeBridgeJob(store, ready as BridgeJobRecord, executor, {
			workerId,
		});
		const transitions: JobTransition[] = [
			{ status: first?.status, failure: failureTuple(first?.failure) },
			{ status: requeued?.status },
			{ status: second?.status, attempts: second?.attempts, result: second?.result },
		];
		return { events: harness.snapshot(), transitions };
	};

	it('availability dates: identical retry trace and status transitions across requeue + re-lease', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyRun = await runDatesRetry(legacy);
		const flaggedRun = await runDatesRetry(flagged);

		expect(flaggedRun).toEqual(legacyRun);
		expect(legacyRun.events).toEqual([
			open,
			step('acuity/read-dates:via-url', 'error:WizardStepError'),
			open,
			step('acuity/read-dates:via-url'),
		]);
		expect(legacyRun.transitions[0].status).toBe('failed_pre_submit');
		expect(legacyRun.transitions[0].failure?.retryable).toBe(true);
		expect(legacyRun.transitions[0].failure?.step).toBe('refresh-availability-dates');
		expect(legacyRun.transitions[1].status).toBe('queued');
		expect(legacyRun.transitions[2].status).toBe('succeeded');
		expect(legacyRun.transitions[2].attempts).toBe(2);
	});

	/** Fail navigate once (retryable pre-submit), requeue, re-lease: BOTH paths must
	 * re-run the whole booking from navigate (no resume in 0.6.x — design §5 states
	 * this honestly) and produce identical cross-attempt traces. */
	const runBookingRetry = async (executor: BridgeJobExecutor) => {
		resetTrace();
		stepMocks.navigateToBooking.mockReset();
		stepMocks.navigateToBooking
			.mockReturnValueOnce(
				Effect.fail(
					new WizardStepError({ step: 'navigate', message: 'transient nav failure' }),
				),
			)
			.mockReturnValue(
				Effect.succeed({
					url: 'https://example.as.me/schedule/mock/datetime/2026-06-15T16:00:00.000Z',
					landingStep: 'client-form',
					appointmentTypeId: '53178494',
					calendarId: '1234',
					selectedDate: '2026-06-15',
					selectedTime: '12:00 PM',
				}),
			);

		const store = createInMemoryBridgeAsyncStore();
		await freshSlotsSnapshot(store);
		const record = await store.enqueueJob({
			kind: 'booking_create_with_payment',
			command: bookingCommand('TEST-100'),
		});
		const first = await executeBridgeJob(store, record, executor, { workerId });
		const requeued = await store.requeueJob(record.operationId);
		const [ready] = await store.listReadyJobs(10);
		const second = await executeBridgeJob(store, ready as BridgeJobRecord, executor, {
			workerId,
		});
		const result =
			second?.result?.kind === 'booking_create_with_payment'
				? {
						kind: second.result.kind,
						booking: { ...second.result.booking, createdAt: 'pinned' },
					}
				: second?.result;
		const transitions: JobTransition[] = [
			{ status: first?.status, failure: failureTuple(first?.failure) },
			{ status: requeued?.status },
			{ status: second?.status, attempts: second?.attempts, result },
		];
		return { events: harness.snapshot(), transitions };
	};

	it('booking: identical cross-attempt trace — re-lease re-runs from navigate on both paths', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyRun = await runBookingRetry(legacy);
		const flaggedRun = await runBookingRetry(flagged);

		expect(flaggedRun).toEqual(legacyRun);
		expect(legacyRun.events).toEqual([
			// Attempt 1: navigate fails, retryable.
			open,
			step('acuity/navigate', 'error:WizardStepError'),
			// Attempt 2 (after requeue + re-lease): the full booking, from the top.
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/bypass-payment'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation'),
		]);
		expect(legacyRun.transitions[0].status).toBe('failed_pre_submit');
		expect(legacyRun.transitions[0].failure?.retryable).toBe(true);
		expect(legacyRun.transitions[1].status).toBe('queued');
		expect(legacyRun.transitions[2].status).toBe('succeeded');
		expect(legacyRun.transitions[2].attempts).toBe(2);
	});
});

// =============================================================================
// SEGMENT LAYOUT PINNED AGAINST THE WORKER PAGE LIFECYCLE (design §5 step 1)
// =============================================================================

describe('segment layout: the fold opens session scopes exactly as the production worker does', () => {
	it('booking: five single-step scopes on both paths, identical groupings, plan-declared segments', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const legacyGroups = stepGroupings(legacyTrace.events);

		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedGroups = stepGroupings(flaggedTrace.events);
		const flaggedSegments = [...sessionSegments];

		// Same number of scope acquisitions, same step groupings.
		expect(flaggedGroups).toEqual(legacyGroups);
		expect(legacyGroups).toEqual([
			['acuity/navigate'],
			['acuity/fill-form'],
			['acuity/bypass-payment'],
			['acuity/submit'],
			['acuity/extract-confirmation'],
		]);

		// And the layout the PLAN declares is the layout the legacy worker exhibits:
		// the page-per-step lifecycle is plan data, not coincidence (flow-steps.ts
		// header — worker-exact single-step segments by explicit decision).
		const declared = planSegmentGroupings(acuityFlows.booking_create_with_payment);
		expect(declared.map((group) => group.steps)).toEqual(legacyGroups);
		expect(flaggedSegments).toEqual(declared.map((group) => group.segment));
		expect(flaggedSegments).toEqual([
			'navigate',
			'fill-form',
			'bypass-payment',
			'submit',
			'extract-confirmation',
		]);
	});

	it('availability reads: exactly one scope on both paths (dates and slots)', async () => {
		const { legacy, flagged } = makeExecutors();
		const datesCommand = { serviceId: '53178494', month: '2026-06', adapterProfile };
		const slotsCommand = { serviceId: '53178494', date: '2026-06-15', adapterProfile };

		const legacyDates = await runDatesTrace(legacy, datesCommand);
		expect(stepGroupings(legacyDates.events)).toEqual([['acuity/read-dates:via-url']]);

		const flaggedDates = await runDatesTrace(flagged, datesCommand);
		expect(stepGroupings(flaggedDates.events)).toEqual([['acuity/read-dates:via-url']]);
		expect([...sessionSegments]).toEqual(['read-dates']);

		const legacySlots = await runSlotsTrace(legacy, slotsCommand);
		expect(stepGroupings(legacySlots.events)).toEqual([['acuity/read-slots:via-url']]);

		const flaggedSlots = await runSlotsTrace(flagged, slotsCommand);
		expect(stepGroupings(flaggedSlots.events)).toEqual([['acuity/read-slots:via-url']]);
		expect([...sessionSegments]).toEqual(['read-slots']);
	});

	it('failure cutoffs never open scopes past the failed segment on either path', async () => {
		stepMocks.bypassPayment.mockReturnValue(
			Effect.succeed({ couponApplied: false, code: 'TEST-100', totalAfterCoupon: null }),
		);
		const { legacy, flagged } = makeExecutors();

		const legacyTrace = await runBookingTrace(legacy, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const flaggedTrace = await runBookingTrace(flagged, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		const opens = (events: readonly TraceEvent[]) =>
			events.filter((event) => event.kind === 'scope-open').length;
		expect(opens(legacyTrace.events)).toBe(3);
		expect(opens(flaggedTrace.events)).toBe(3);
		expect(stepGroupings(flaggedTrace.events)).toEqual(
			stepGroupings(legacyTrace.events),
		);
	});
});
