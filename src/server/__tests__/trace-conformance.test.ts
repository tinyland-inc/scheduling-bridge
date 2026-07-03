/**
 * Trace-conformance harness (TIN-2072 parity gate → TIN-2093 deletion gate; design
 * §10 0.7.0, §11 "Trace conformance"). THE PARITY GUARANTEE after the deletion gate:
 * the three legacy hand-written compositions are GONE, so `runFlow` (the fold) is the
 * only execution path. This harness asserts the fold reproduces the RECORDED GOLDEN
 * fixtures — captured from the REAL legacy path before deletion
 * (src/server/__tests__/__fixtures__/trace-golden/) — byte-for-byte, for every
 * scenario. A regression in fold step order / per-step outcome / terminal status /
 * scope layout turns this suite red.
 *
 * Mechanics: the fold executor (`createAcuityBridgeJobExecutor`) is driven over the
 * SAME substituted stub step set the goldens were captured under. Every stub is
 * wrapped in a tracing decorator that records, in execution order:
 *
 *   - `scope-open` events: one per browser-session Scope acquisition (the fold's
 *     one-Scope-per-segment lifecycle), recorded by a counting session Layer;
 *   - `step` events: the underlying step program invoked + its outcome.
 *
 * The recorded trace (ordered step ids + per-step outcome + terminal job status) is
 * deep-compared against the committed golden for all three job kinds, across happy
 * paths, the bypass-proof boundary (PAYMENT_BYPASS_NOT_PROVEN), pre-submit failures,
 * the submit/post-submit reconcile_required boundary, and job-level retry (requeue +
 * re-lease). The segment layout is pinned by asserting scope-acquisition counts and
 * step groupings against the golden and against the plan's declared segments.
 *
 * Two scenarios are KNOWN, INTENTIONAL fold-vs-legacy cutoff differences (the fold is
 * STRICTLY less vendor work for the same terminal — docs/design/parity-evidence.md):
 * COUPON_REQUIRED (the fold guards before any browser work) and ambiguous submit (the
 * fold Diverges AT submit instead of blindly probing extract). Their goldens are the
 * FOLD traces — the canonical behavior of the only surviving path.
 *
 * PAYMENT-SEGMENT GOLDEN UPDATE (design §7; TIN-2095): the single
 * `acuity/bypass-payment` step is decomposed into the reusable payment-injection
 * sub-flow — open-coupon-entry → apply-coupon → verify-zero-total — sharing ONE
 * 'bypass-payment' segment Scope. The payment portion of every booking golden
 * (happy-booking, bypass-not-proven-*, submit-failure, extract-failure,
 * retry-booking) was regenerated accordingly: one scope-open then the three
 * sub-steps, with the $0-proof outcome recorded on verify-zero-total (the
 * PAYMENT_BYPASS_NOT_PROVEN Diverged outcome moves from the monolith to that
 * terminal sub-step). This decomposition IS the intended new trace; the
 * non-payment golden scenarios are untouched.
 *
 * No production module is modified: stubs are substituted at the module boundary and
 * the browser layers are replaced with counting succeed/sync Layers, so no Chromium is
 * ever launched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
	 * comparable against the recorded golden. `E` is the dynamically imported `effect`
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
	// Payment-injection sub-flow (design §7; TIN-2095): the decomposed sub-steps
	// replace the single bypassPayment program at the trace mock boundary.
	openCouponEntry: vi.fn(),
	applyCoupon: vi.fn(),
	verifyZeroTotal: vi.fn(),
	submitBooking: vi.fn(),
	extractConfirmation: vi.fn(),
	readAvailableDates: vi.fn(),
	readTimeSlots: vi.fn(),
	readDatesViaUrl: vi.fn(),
	readSlotsViaUrl: vi.fn(),
}));

// The fold step wrappers (src/adapters/acuity/flow-steps.ts) resolve these modules,
// so this substitution feeds the identical stub set the goldens were captured under.
vi.mock('../../adapters/acuity/steps/index.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../adapters/acuity/steps/index.js')>();
	const { Effect: E } = await import('effect');
	return {
		...actual,
		navigateToBooking: harness.traced(E, 'acuity/navigate', stepMocks.navigateToBooking),
		fillFormFields: harness.traced(E, 'acuity/fill-form', stepMocks.fillFormFields),
		openCouponEntry: harness.traced(
			E,
			'acuity/open-coupon-entry',
			stepMocks.openCouponEntry,
		),
		applyCoupon: harness.traced(E, 'acuity/apply-coupon', stepMocks.applyCoupon),
		verifyZeroTotal: harness.traced(
			E,
			'acuity/verify-zero-total',
			stepMocks.verifyZeroTotal,
		),
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
// GOLDEN FIXTURES (recorded from the legacy path before deletion)
// =============================================================================

const GOLDEN_DIR = fileURLToPath(
	new URL('./__fixtures__/trace-golden/', import.meta.url),
);

const golden = (name: string): any =>
	JSON.parse(readFileSync(`${GOLDEN_DIR}${name}.json`, 'utf8'));

// =============================================================================
// FIXTURES (inputs)
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

/** Segment names the fold requested (one push per segment Scope entry). */
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

const makeExecutor = () => {
	const journal = createInMemoryFlowJournal();
	const fold = createAcuityBridgeJobExecutor({
		redisClient: null,
		flowJournal: journal,
		// One counting Layer per segment (the run.test.ts session-counting pattern):
		// each build = one fold Scope acquisition, recorded on the trace so the layout
		// is directly comparable to the recorded golden's scope-open events.
		sessionLayer: (segment) => {
			sessionSegments.push(segment);
			return Layer.sync(BrowserService, () => {
				harness.events.push({ kind: 'scope-open' });
				return fakeSessionService as never;
			});
		},
	});
	return { journal, fold };
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
	stepMocks.openCouponEntry.mockReturnValue(Effect.succeed({ opened: true }));
	stepMocks.applyCoupon.mockReturnValue(Effect.succeed({ applied: true }));
	stepMocks.verifyZeroTotal.mockReturnValue(
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
// HAPPY PATHS — all three job kinds (fold reproduces the recorded golden)
// =============================================================================

describe('trace conformance: happy paths (runFlow fold vs recorded golden)', () => {
	it('booking: reproduces the golden step trace, scope layout, terminal status, and booking result', async () => {
		const { fold, journal } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId: 'op-trace-happy',
		});
		const foldSegments = [...sessionSegments];

		// The gate: the fold reproduces the recorded golden byte-for-byte (ordered
		// step ids + per-step outcomes + scope acquisitions + terminal + result).
		expect(foldTrace).toEqual(golden('happy-booking'));

		// Pin the literal expected trace too, so a golden corrupted to match a broken
		// fold cannot slip through.
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			// Payment-injection sub-flow (design §7; TIN-2095): three sub-steps share
			// ONE 'bypass-payment' segment Scope (one scope-open, then the three steps).
			open,
			step('acuity/open-coupon-entry'),
			step('acuity/apply-coupon'),
			step('acuity/verify-zero-total'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation'),
		]);
		expect(foldTrace.terminal).toEqual({ status: 'succeeded' });
		expect((foldTrace.result as { id: string }).id).toBe('apt_123');

		// The fold entered one Scope per CONTIGUOUS plan segment, in plan order. The
		// payment-injection sub-flow's three sub-steps share ONE 'bypass-payment'
		// segment (design §7; TIN-2095), so contiguous-dedupe the per-node segments.
		const contiguousSegments = acuityFlows.booking_create_with_payment.plan.nodes
			.map((node) => node.segment)
			.filter((segment, index, all) => segment !== all[index - 1]);
		expect(foldSegments).toEqual(contiguousSegments);

		// Journal coherence: the evidence trail mirrors the recorded trace exactly
		// (started+completed per step, in the executed order).
		const rows = await Effect.runPromise(journal.read('op-trace-happy'));
		expect(rows.map((row) => [row.stepId, row.status])).toEqual([
			['acuity/navigate', 'started'],
			['acuity/navigate', 'completed'],
			['acuity/fill-form', 'started'],
			['acuity/fill-form', 'completed'],
			['acuity/open-coupon-entry', 'started'],
			['acuity/open-coupon-entry', 'completed'],
			['acuity/apply-coupon', 'started'],
			['acuity/apply-coupon', 'completed'],
			['acuity/verify-zero-total', 'started'],
			['acuity/verify-zero-total', 'completed'],
			['acuity/submit', 'started'],
			['acuity/submit', 'completed'],
			['acuity/extract-confirmation', 'started'],
			['acuity/extract-confirmation', 'completed'],
		]);
		expect(rows.filter((row) => row.status === 'started').map((row) => row.stepId)).toEqual(
			foldTrace.events
				.filter((event) => event.kind === 'step')
				.map((event) => event.stepId),
		);
	});

	it('availability dates: reproduces the golden for both dispatch arms (via-url and wizard)', async () => {
		const { fold } = makeExecutor();

		// Numeric appointment-type id → via-url read.
		const numeric = { serviceId: '53178494', month: '2026-06', adapterProfile };
		const foldNumeric = await runDatesTrace(fold, numeric);
		expect(foldNumeric).toEqual(golden('happy-dates-via-url'));
		expect(foldNumeric.events).toEqual([open, step('acuity/read-dates:via-url')]);
		expect(foldNumeric.terminal).toEqual({ status: 'succeeded' });
		expect(foldNumeric.result).toEqual(DATES_FIXTURE);

		// Non-numeric service id → wizard click-through read (worker dispatch parity).
		const named = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			month: '2026-06',
			adapterProfile,
		};
		const foldNamed = await runDatesTrace(fold, named);
		expect(foldNamed).toEqual(golden('happy-dates-wizard'));
		expect(foldNamed.events).toEqual([open, step('acuity/read-dates:wizard')]);
		expect(foldNamed.result).toEqual(WIZARD_DATES_FIXTURE);
	});

	it('availability slots: reproduces the golden for both dispatch arms (via-url and wizard)', async () => {
		const { fold } = makeExecutor();

		const numeric = { serviceId: '53178494', date: '2026-06-15', adapterProfile };
		const foldNumeric = await runSlotsTrace(fold, numeric);
		expect(foldNumeric).toEqual(golden('happy-slots-via-url'));
		expect(foldNumeric.events).toEqual([open, step('acuity/read-slots:via-url')]);
		expect(foldNumeric.result).toEqual(SLOTS_FIXTURE);

		const named = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			date: '2026-06-21',
			adapterProfile,
		};
		const foldNamed = await runSlotsTrace(fold, named);
		expect(foldNamed).toEqual(golden('happy-slots-wizard'));
		expect(foldNamed.events).toEqual([open, step('acuity/read-slots:wizard')]);
		expect(foldNamed.result).toEqual(WIZARD_SLOTS_FIXTURE);
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
			'bypass-not-proven-total',
		],
		[
			'coupon not applied',
			{ couponApplied: false, code: 'TEST-100', totalAfterCoupon: null },
			'bypass-not-proven-coupon',
		],
	])(
		'PAYMENT_BYPASS_NOT_PROVEN: reproduces the golden terminal AND step cutoff (%s)',
		async (_label, bypassResult, fixture) => {
			// The $0 proof now lives on the terminal sub-step verify-zero-total
			// (design §6; TIN-2095): open-coupon-entry + apply-coupon succeed, and the
			// proof fails at verify-zero-total → Diverged ⇒ PAYMENT_BYPASS_NOT_PROVEN.
			stepMocks.verifyZeroTotal.mockReturnValue(Effect.succeed(bypassResult));
			const { fold } = makeExecutor();

			const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
				executionPath: 'browser',
			});

			expect(foldTrace).toEqual(golden(fixture));
			// Same cutoff class: all three payment sub-steps ran (and "succeeded" as
			// programs — the PROOF failed at verify-zero-total), and the fold never
			// invoked submit or extract.
			expect(foldTrace.events).toEqual([
				open,
				step('acuity/navigate'),
				open,
				step('acuity/fill-form'),
				open,
				step('acuity/open-coupon-entry'),
				step('acuity/apply-coupon'),
				step('acuity/verify-zero-total'),
			]);
			expect(foldTrace.terminal).toEqual({
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
	it('navigate failure: reproduces the golden trace cutoff and retryable failed_pre_submit terminal', async () => {
		stepMocks.navigateToBooking.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'navigate', message: 'nav broke' })),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(foldTrace).toEqual(golden('navigate-failure'));
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate', 'error:WizardStepError'),
		]);
		expect(foldTrace.terminal.status).toBe('failed_pre_submit');
		expect(foldTrace.terminal.step).toBe('navigate');
		expect(foldTrace.terminal.retryable).toBe(true);
	});

	it('fill-form failure: reproduces the golden trace cutoff and terminal', async () => {
		stepMocks.fillFormFields.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'fill-form', message: 'form broke' })),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(foldTrace).toEqual(golden('fill-form-failure'));
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form', 'error:WizardStepError'),
		]);
		expect(foldTrace.terminal.status).toBe('failed_pre_submit');
		expect(foldTrace.terminal.step).toBe('fill-form');
		expect(foldTrace.terminal.retryable).toBe(true);
	});

	it('REST execution-path guard: reproduces the golden (empty) trace and terminal', async () => {
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'rest',
		});

		expect(foldTrace).toEqual(golden('rest-guard'));
		expect(foldTrace.events).toEqual([]);
		expect(foldTrace.terminal).toMatchObject({
			status: 'failed_pre_submit',
			code: 'REST_BOOKING_NOT_WIRED',
			step: 'execution-path',
			retryable: false,
		});
	});

	it('COUPON_REQUIRED guard: the fold guards BEFORE any browser work (documented cutoff vs the deleted legacy path)', async () => {
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand(undefined), {
			executionPath: 'browser',
		});

		// KNOWN, INTENTIONAL cutoff (docs/design/parity-evidence.md): the deleted legacy
		// worker only discovered the missing coupon after navigate + fill-form; the fold
		// executor guards before any browser work. Strictly less vendor work, same
		// terminal failure. The fold trace is the canonical behavior of the only path.
		expect(foldTrace.events).toEqual([]);
		expect(foldTrace.terminal).toMatchObject({
			status: 'failed_pre_submit',
			code: 'COUPON_REQUIRED',
			step: 'bypass-payment',
			retryable: false,
		});
	});
});

// =============================================================================
// SUBMIT / POST-SUBMIT (reconcile_required boundary)
// =============================================================================

describe('trace conformance: submit/post-submit ambiguity (reconcile_required parity)', () => {
	it('submit failure: reproduces the golden trace cutoff, reconcile_required, non-retryable', async () => {
		stepMocks.submitBooking.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'submit', message: 'submit broke' })),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(foldTrace).toEqual(golden('submit-failure'));
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/open-coupon-entry'),
			step('acuity/apply-coupon'),
			step('acuity/verify-zero-total'),
			open,
			step('acuity/submit', 'error:WizardStepError'),
		]);
		expect(foldTrace.terminal.status).toBe('reconcile_required');
		expect(foldTrace.terminal.step).toBe('submit');
		expect(foldTrace.terminal.retryable).toBe(false);
		expect(stepMocks.extractConfirmation).not.toHaveBeenCalled();
	});

	it('extract-confirmation failure: reproduces the golden full-length trace, reconcile_required', async () => {
		stepMocks.extractConfirmation.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'extract', message: 'extract broke' })),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		expect(foldTrace).toEqual(golden('extract-failure'));
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/open-coupon-entry'),
			step('acuity/apply-coupon'),
			step('acuity/verify-zero-total'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation', 'error:WizardStepError'),
		]);
		expect(foldTrace.terminal.status).toBe('reconcile_required');
		expect(foldTrace.terminal.step).toBe('extract-confirmation');
		expect(foldTrace.terminal.retryable).toBe(false);
	});

	it('ambiguous submit (confirmation page not reached): the fold Diverges AT submit instead of probing extract (documented cutoff vs the deleted legacy path)', async () => {
		stepMocks.submitBooking.mockReturnValue(
			Effect.succeed({ submitted: true, confirmationPageReached: false }),
		);
		// The deleted legacy path discovered the ambiguity one step later, when
		// extractConfirmation failed its triple-probe on the non-confirmation page.
		stepMocks.extractConfirmation.mockReturnValue(
			Effect.fail(
				new WizardStepError({ step: 'extract', message: 'Not on confirmation page' }),
			),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		// reconcile_required parity with the deleted legacy path: terminal STATUS and
		// retryability agree (the legacy golden recorded the same status at extract).
		expect(foldTrace.terminal.status).toBe('reconcile_required');
		expect(foldTrace.terminal.retryable).toBe(false);

		// KNOWN, INTENTIONAL cutoff (docs/design/parity-evidence.md): the fold classifies
		// the unknown landing as Diverged AT submit (never blindly extracting from an
		// ambiguous page). The fold trace is a strict prefix of what the legacy path ran.
		expect(foldTrace.events).toEqual([
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/open-coupon-entry'),
			step('acuity/apply-coupon'),
			step('acuity/verify-zero-total'),
			open,
			step('acuity/submit'),
		]);
		expect(foldTrace.terminal.code).toBe('FLOW_DIVERGED');
		expect(foldTrace.terminal.step).toBe('submit');
		// The fold never invokes extract on the ambiguous page.
		expect(stepMocks.extractConfirmation).not.toHaveBeenCalled();
	});
});

// =============================================================================
// RETRY BEHAVIOR (job-level requeue + re-lease — the only retry the worker performs)
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

	it('availability dates: reproduces the golden retry trace and status transitions across requeue + re-lease', async () => {
		const { fold } = makeExecutor();

		const foldRun = await runDatesRetry(fold);

		expect(foldRun).toEqual(golden('retry-dates'));
		expect(foldRun.events).toEqual([
			open,
			step('acuity/read-dates:via-url', 'error:WizardStepError'),
			open,
			step('acuity/read-dates:via-url'),
		]);
		expect(foldRun.transitions[0].status).toBe('failed_pre_submit');
		expect(foldRun.transitions[0].failure?.retryable).toBe(true);
		expect(foldRun.transitions[0].failure?.step).toBe('refresh-availability-dates');
		expect(foldRun.transitions[1].status).toBe('queued');
		expect(foldRun.transitions[2].status).toBe('succeeded');
		expect(foldRun.transitions[2].attempts).toBe(2);
	});

	/** Fail navigate once (retryable pre-submit), requeue, re-lease: the fold must
	 * re-run the whole booking from navigate (no resume in 0.6.x — design §5 states
	 * this honestly) and reproduce the recorded cross-attempt trace. */
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

	it('booking: reproduces the golden cross-attempt trace — re-lease re-runs from navigate', async () => {
		const { fold } = makeExecutor();

		const foldRun = await runBookingRetry(fold);

		expect(foldRun).toEqual(golden('retry-booking'));
		expect(foldRun.events).toEqual([
			// Attempt 1: navigate fails, retryable.
			open,
			step('acuity/navigate', 'error:WizardStepError'),
			// Attempt 2 (after requeue + re-lease): the full booking, from the top.
			open,
			step('acuity/navigate'),
			open,
			step('acuity/fill-form'),
			open,
			step('acuity/open-coupon-entry'),
			step('acuity/apply-coupon'),
			step('acuity/verify-zero-total'),
			open,
			step('acuity/submit'),
			open,
			step('acuity/extract-confirmation'),
		]);
		expect(foldRun.transitions[0].status).toBe('failed_pre_submit');
		expect(foldRun.transitions[0].failure?.retryable).toBe(true);
		expect(foldRun.transitions[1].status).toBe('queued');
		expect(foldRun.transitions[2].status).toBe('succeeded');
		expect(foldRun.transitions[2].attempts).toBe(2);
	});
});

// =============================================================================
// SEGMENT LAYOUT PINNED AGAINST THE WORKER PAGE LIFECYCLE (design §5 step 1)
// =============================================================================

describe('segment layout: the fold opens session scopes exactly as the (recorded) worker did', () => {
	it('booking: five scopes (the bypass-payment segment groups its three sub-steps), golden groupings, plan-declared segments', async () => {
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});
		const foldGroups = stepGroupings(foldTrace.events);
		const foldSegments = [...sessionSegments];

		// Same step groupings as the recorded golden, and the canonical layout. The
		// payment-injection sub-flow (design §7; TIN-2095) keeps a SINGLE
		// 'bypass-payment' scope; its three sub-steps share that one page session.
		expect(foldGroups).toEqual(stepGroupings(golden('happy-booking').events));
		expect(foldGroups).toEqual([
			['acuity/navigate'],
			['acuity/fill-form'],
			['acuity/open-coupon-entry', 'acuity/apply-coupon', 'acuity/verify-zero-total'],
			['acuity/submit'],
			['acuity/extract-confirmation'],
		]);

		// And the layout the PLAN declares is the layout the recorded worker exhibited:
		// the page lifecycle is plan data, not coincidence (flow-steps.ts header —
		// worker-exact segments; the payment segment is one page across its sub-steps).
		const declared = planSegmentGroupings(acuityFlows.booking_create_with_payment);
		expect(declared.map((group) => group.steps)).toEqual(foldGroups);
		expect(foldSegments).toEqual(declared.map((group) => group.segment));
		expect(foldSegments).toEqual([
			'navigate',
			'fill-form',
			'bypass-payment',
			'submit',
			'extract-confirmation',
		]);
	});

	it('availability reads: exactly one scope (dates and slots)', async () => {
		const { fold } = makeExecutor();
		const datesCommand = { serviceId: '53178494', month: '2026-06', adapterProfile };
		const slotsCommand = { serviceId: '53178494', date: '2026-06-15', adapterProfile };

		const foldDates = await runDatesTrace(fold, datesCommand);
		expect(stepGroupings(foldDates.events)).toEqual([['acuity/read-dates:via-url']]);
		expect(stepGroupings(foldDates.events)).toEqual(
			stepGroupings(golden('happy-dates-via-url').events),
		);
		expect([...sessionSegments]).toEqual(['read-dates']);

		const foldSlots = await runSlotsTrace(fold, slotsCommand);
		expect(stepGroupings(foldSlots.events)).toEqual([['acuity/read-slots:via-url']]);
		expect(stepGroupings(foldSlots.events)).toEqual(
			stepGroupings(golden('happy-slots-via-url').events),
		);
		expect([...sessionSegments]).toEqual(['read-slots']);
	});

	it('failure cutoffs never open scopes past the failed segment', async () => {
		// The $0 proof diverges at verify-zero-total (design §6; TIN-2095). The
		// payment-injection sub-flow shares ONE 'bypass-payment' scope, so the cutoff
		// still opens exactly three scopes (navigate, fill-form, bypass-payment).
		stepMocks.verifyZeroTotal.mockReturnValue(
			Effect.succeed({ couponApplied: false, code: 'TEST-100', totalAfterCoupon: null }),
		);
		const { fold } = makeExecutor();

		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
		});

		const opens = (events: readonly TraceEvent[]) =>
			events.filter((event) => event.kind === 'scope-open').length;
		expect(opens(foldTrace.events)).toBe(3);
		expect(opens(golden('bypass-not-proven-coupon').events)).toBe(3);
		expect(stepGroupings(foldTrace.events)).toEqual(
			stepGroupings(golden('bypass-not-proven-coupon').events),
		);
	});
});

// =============================================================================
// DRIFT GATE — proof that the conformance comparator BITES (TIN-1993 / TIN-2092)
// =============================================================================
//
// EVIDENCE OF ABSENCE this closes: the 21 conformance tests above assert the fold
// REPRODUCES the 14 recorded goldens, but nothing above proves the comparator would
// REJECT a wrong trace. Until that is shown, every golden proof is unfalsified — a
// comparator that accepted everything would pass all 21. These tests deliberately
// feed the SAME comparator path (`runBookingTrace` → `expect(...).toEqual(golden)`)
// a drifted trace and prove it goes red.
//
// They live in THIS file (not a sibling) on purpose: the guarantee is about the
// EXACT comparator the 21 tests use — the same `runBookingTrace`, the same golden
// loader semantics, the same `toEqual`. A copy in another module could silently
// diverge from the real gate; reusing the in-file symbols cannot. The 21 tests and
// 14 goldens above are untouched — everything here is purely additive.

const DRIFTED_DIR = fileURLToPath(
	new URL('./__fixtures__/trace-golden-drifted/', import.meta.url),
);

/** Loads a DELIBERATELY-DRIFTED fixture the same way `golden()` loads a real one. */
const driftedGolden = (name: string): any =>
	JSON.parse(readFileSync(`${DRIFTED_DIR}${name}.json`, 'utf8'));

describe('drift gate (a): the drifted fixture fails the SAME comparator the 21 conformance tests use', () => {
	it('happy-booking: pristine golden GREEN, drifted fixture RED — the real gate bites with a precise diff', async () => {
		const { fold } = makeExecutor();

		// The identical production of the fold trace the happy-path conformance test
		// runs (worker.js fold, over the substituted stub set, one Scope per segment).
		const foldTrace = await runBookingTrace(fold, bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId: 'op-trace-drift',
		});

		// CONTROL: the SAME `toEqual` comparator, given the PRISTINE golden, is GREEN.
		// This is what makes the red below meaningful — the fold is correct; only the
		// drifted fixture is wrong.
		expect(foldTrace).toEqual(golden('happy-booking'));

		// THE BITE: the SAME comparator, given the DRIFTED fixture, must reject it.
		const drifted = driftedGolden('happy-booking');
		expect(foldTrace).not.toEqual(drifted);
		// Run the literal conformance assertion (`expect(foldTrace).toEqual(golden)`),
		// pointed at the drift, and prove it THROWS — i.e. the gate would go red.
		let caught: Error | undefined;
		try {
			expect(foldTrace).toEqual(drifted);
		} catch (error) {
			caught = error as Error;
		}
		expect(
			caught,
			'the real conformance comparator MUST reject the drifted fixture',
		).toBeInstanceOf(Error);

		// PRECISE DIFF: prove the drift is exactly the three tampered sites and nothing
		// else — one step id, one terminal status, one scope grouping.
		//
		//   (1) step id       acuity/navigate → acuity/navigate-DRIFTED
		expect(foldTrace.events[1].stepId).toBe('acuity/navigate');
		expect(drifted.events[1].stepId).toBe('acuity/navigate-DRIFTED');
		//   (2) terminal      succeeded → failed_pre_submit
		expect(foldTrace.terminal.status).toBe('succeeded');
		expect(drifted.terminal.status).toBe('failed_pre_submit');
		//   (3) scope layout  the scope-open before submit is gone, so submit is
		//       regrouped into the bypass-payment page session.
		expect(stepGroupings(foldTrace.events)).toEqual([
			['acuity/navigate'],
			['acuity/fill-form'],
			['acuity/open-coupon-entry', 'acuity/apply-coupon', 'acuity/verify-zero-total'],
			['acuity/submit'],
			['acuity/extract-confirmation'],
		]);
		expect(stepGroupings(drifted.events)).toEqual([
			['acuity/navigate-DRIFTED'],
			['acuity/fill-form'],
			[
				'acuity/open-coupon-entry',
				'acuity/apply-coupon',
				'acuity/verify-zero-total',
				'acuity/submit',
			],
			['acuity/extract-confirmation'],
		]);
		expect(stepGroupings(drifted.events)).not.toEqual(stepGroupings(foldTrace.events));

		// EVIDENCE: surface the precise red the real gate produced, into the vitest
		// verbose log — this is the "drifted fixture red through the real gate"
		// captured inside an otherwise-green suite.
		const diffLines = [
			'=== DRIFT GATE BITES: real conformance comparator vs drifted fixture ===',
			`  step id     : '${foldTrace.events[1].stepId}' (fold) -> '${drifted.events[1].stepId}' (drifted)`,
			`  terminal    : '${foldTrace.terminal.status}' (fold) -> '${drifted.terminal.status}' (drifted)`,
			`  scope layout: submit regrouped into the bypass-payment session (one fewer scope-open)`,
			`  comparator  : ${caught?.name ?? 'Error'} thrown by expect(foldTrace).toEqual(drifted)`,
			'=== END DRIFT GATE ===',
		];
		console.log(`\n${diffLines.join('\n')}\n`);
	});
});

// -----------------------------------------------------------------------------
// (b) Parameterized meta-test: mutate loaded goldens in-memory, per mutation
// class, and assert the SAME `toEqual` comparator rejects EACH class. This
// generalizes the single drifted fixture into the space of drift the gate must
// catch: step reorder, status flip, scope regroup, trace truncation.
// -----------------------------------------------------------------------------

interface DriftMutation {
	readonly name: string;
	readonly apply: (golden: any) => any;
}

const deepClone = (value: any): any => JSON.parse(JSON.stringify(value));

const stepEventIndices = (events: TraceEvent[]): number[] =>
	events.flatMap((event, index) => (event.kind === 'step' ? [index] : []));

const scopeEventIndices = (events: TraceEvent[]): number[] =>
	events.flatMap((event, index) => (event.kind === 'scope-open' ? [index] : []));

const DRIFT_MUTATIONS: DriftMutation[] = [
	{
		// STEP REORDER: swap the first two executed steps' ids (fold executed them in
		// the wrong order). Terminal + scope layout untouched — isolates order drift.
		name: 'step-reorder',
		apply: (golden) => {
			const mutant = deepClone(golden);
			const [a, b] = stepEventIndices(mutant.events);
			[mutant.events[a].stepId, mutant.events[b].stepId] = [
				mutant.events[b].stepId,
				mutant.events[a].stepId,
			];
			return mutant;
		},
	},
	{
		// STATUS FLIP: the terminal job status changed (e.g. succeeded vs
		// failed_pre_submit vs reconcile_required) — a classification regression.
		name: 'status-flip',
		apply: (golden) => {
			const mutant = deepClone(golden);
			mutant.terminal.status = `${mutant.terminal.status}__DRIFTED`;
			return mutant;
		},
	},
	{
		// SCOPE REGROUP: drop the last scope-open so its step group merges into the
		// previous page session — a segment/page-lifecycle regression.
		name: 'scope-regroup',
		apply: (golden) => {
			const mutant = deepClone(golden);
			const scopes = scopeEventIndices(mutant.events);
			mutant.events.splice(scopes[scopes.length - 1], 1);
			return mutant;
		},
	},
	{
		// TRACE TRUNCATION: the fold stopped one step early (or ran one extra) — a
		// cutoff regression. Drop the terminal-most event.
		name: 'trace-truncation',
		apply: (golden) => {
			const mutant = deepClone(golden);
			mutant.events = mutant.events.slice(0, -1);
			return mutant;
		},
	},
];

// The booking-family goldens carry the rich {events (>=2 steps, >=2 scopes),
// terminal} shape every mutation class needs; the retry/availability goldens have
// a different top-level shape (retry) or a single-step trace, so this representative
// set exercises all four classes without touching any of the 14 goldens on disk.
const META_GOLDENS = [
	'happy-booking',
	'fill-form-failure',
	'submit-failure',
	'extract-failure',
	'bypass-not-proven-total',
	'bypass-not-proven-coupon',
] as const;

const META_CASES: [string, string, DriftMutation][] = META_GOLDENS.flatMap(
	(goldenName) =>
		DRIFT_MUTATIONS.map(
			(mutation) => [goldenName, mutation.name, mutation] as [string, string, DriftMutation],
		),
);

describe('drift gate (b): every mutation class fails the SAME toEqual comparator (meta-test)', () => {
	it.each(META_CASES)(
		'golden "%s" under mutation "%s" is rejected by the conformance comparator',
		(goldenName, _mutationName, mutation) => {
			const original = golden(goldenName);
			const mutant = mutation.apply(original);

			// The mutation actually drifted the trace (guards a no-op mutation).
			expect(mutant).not.toEqual(original);

			// THE GATE: the SAME `expect(actual).toEqual(golden)` the 21 tests use
			// throws on the drifted trace — the gate bites for this class.
			expect(() => expect(mutant).toEqual(original)).toThrow();

			// The on-disk golden was NOT mutated in place — the 14 goldens are inputs
			// only. `golden()` re-reads the file; it must still deep-equal `original`.
			expect(golden(goldenName)).toEqual(original);
		},
	);
});
