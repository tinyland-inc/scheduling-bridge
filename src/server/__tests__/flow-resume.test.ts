/**
 * Re-lease resume semantics for the flagged worker path (TIN-2072; design §5
 * "Resume = replay at segment boundaries" / "Idempotency"):
 *
 * - READ flows: on re-lease of a job whose journal has rows, the fold decodes the
 *   last segment-boundary checkpoint, emits `skipped_resume` rows for prior
 *   segments, and re-runs the open segment from its head (read steps re-run
 *   freely). A fully-journaled read replays its output without re-driving the
 *   browser.
 * - Booking flows: a started-without-completed effectful-once checkpoint is gated
 *   by the cheap extract-confirmation probe FIRST — confirmation found ⇒ succeeded
 *   with the extracted data; ambiguous ⇒ reconcile_required with the step trace,
 *   landing observation, and evidence attached. The submit step is NEVER re-run.
 *   (The single-segment-per-step booking wizard otherwise resumes by skipping
 *   journaled segment boundaries and re-running the open segment — for a journal
 *   with no boundary this honestly degenerates to re-run-from-navigate.)
 * - Payment-injection token reuse: a resumed bypass segment threads the journaled
 *   idempotencyToken (the coupon code) back into the step instead of minting.
 *
 * Everything here is BRIDGE_FLOW_RUNNER-gated (flag-off behavior is pinned
 * untouched by flow-runner.test.ts's poison-journal tests and the
 * trace-conformance harness). Seams: the flow-runner.test.ts module-boundary
 * style — stub steps + succeed-Layer browser service, no Chromium.
 */

import { Effect, Layer } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../adapters/acuity/steps/index.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../adapters/acuity/steps/index.js')>();
	return {
		...actual,
		navigateToBooking: stepMocks.navigateToBooking,
		fillFormFields: stepMocks.fillFormFields,
		bypassPayment: stepMocks.bypassPayment,
		submitBooking: stepMocks.submitBooking,
		extractConfirmation: stepMocks.extractConfirmation,
		readAvailableDates: stepMocks.readAvailableDates,
		readTimeSlots: stepMocks.readTimeSlots,
	};
});

vi.mock('../../adapters/acuity/steps/read-via-url.js', () => ({
	readDatesViaUrl: stepMocks.readDatesViaUrl,
	readSlotsViaUrl: stepMocks.readSlotsViaUrl,
}));

vi.mock('../../shared/browser-service.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../shared/browser-service.js')>();
	const { Effect: E, Layer } = await import('effect');
	const fakeService = {
		acquirePage: E.succeed({} as never),
		screenshot: () => E.succeed(Buffer.from('')),
		config: actual.defaultBrowserConfig,
	};
	return {
		...actual,
		BrowserProcessLive: () =>
			Layer.succeed(actual.BrowserProcess, {
				browser: {} as never,
				config: actual.defaultBrowserConfig,
			}),
		BrowserSessionLive: Layer.succeed(actual.BrowserService, fakeService as never),
	};
});

import { createAcuityBridgeJobExecutor } from '../worker.js';
import { executeBookingThroughFlow } from '../flow-runner.js';
import {
	createInMemoryFlowJournal,
	type FlowCheckpoint,
	type FlowJournalShape,
} from '../../flow/index.js';
import { acuityFlows } from '../../adapters/acuity/flows.js';
import { BridgeJobExecutionError } from '../../async/worker.js';
import type { AppointmentCommand, BridgeAdapterProfile } from '../../async/types.js';
import { WizardStepError } from '../../adapters/acuity/errors.js';

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

const makeFlagged = () => {
	const journal = createInMemoryFlowJournal();
	const flagged = createAcuityBridgeJobExecutor({
		redisClient: null,
		flowRunner: true,
		flowJournal: journal,
	});
	return { journal, flagged };
};

const bookingFlow = acuityFlows.booking_create_with_payment;

/** Hand-seed a journal row (an earlier lease's evidence). */
const seedRow = async (
	journal: FlowJournalShape,
	operationId: string,
	stepId: string,
	status: FlowCheckpoint['status'],
	extra: Partial<Omit<FlowCheckpoint, 'seq'>> = {},
) =>
	Effect.runPromise(
		journal.append({
			operationId,
			flowId: bookingFlow.plan.flowId,
			flowVersion: bookingFlow.plan.version,
			planHash: bookingFlow.planHash,
			stepId,
			attempt: 1,
			status,
			at: new Date().toISOString(),
			...extra,
		}),
	);

const captureExecutionError = async (
	promise: Promise<unknown>,
): Promise<BridgeJobExecutionError> => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(BridgeJobExecutionError);
		return error as BridgeJobExecutionError;
	}
	throw new Error('expected the execution to fail');
};

beforeEach(() => {
	vi.clearAllMocks();
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
	stepMocks.readDatesViaUrl.mockReturnValue(
		Effect.succeed([{ date: '2026-06-20', slots: 1 }]),
	);
	stepMocks.readSlotsViaUrl.mockReturnValue(
		Effect.succeed([{ datetime: '2026-06-15T16:00:00.000Z', available: true }]),
	);
	stepMocks.readAvailableDates.mockReturnValue(
		Effect.succeed([{ date: '2026-06-21', slots: 1 }]),
	);
	stepMocks.readTimeSlots.mockReturnValue(
		Effect.succeed([{ datetime: '2026-06-21T15:00:00.000Z', available: true }]),
	);
});

// =============================================================================
// READ-FLOW RESUME (segment replay; both availability flows)
// =============================================================================

describe('read-flow resume on re-lease (flag on)', () => {
	it('replays a fully-journaled dates read from the boundary checkpoint without re-driving the browser', async () => {
		const { journal, flagged } = makeFlagged();
		const command = { serviceId: '53178494', month: '2026-06', adapterProfile };
		const context = { operationId: 'op-dates-replay' };

		const first = await flagged.refreshAvailabilityDates(command, context);
		expect(first).toEqual([{ date: '2026-06-20', slots: 1 }]);
		expect(stepMocks.readDatesViaUrl).toHaveBeenCalledTimes(1);

		// Re-lease: the journaled segment boundary replays the output; the read
		// step is NOT re-driven.
		const second = await flagged.refreshAvailabilityDates(command, context);
		expect(second).toEqual(first);
		expect(stepMocks.readDatesViaUrl).toHaveBeenCalledTimes(1);

		const rows = await Effect.runPromise(journal.read('op-dates-replay'));
		expect(rows.map((row) => [row.stepId, row.status])).toEqual([
			['acuity/read-dates', 'started'],
			['acuity/read-dates', 'completed'],
			['acuity/read-dates', 'skipped_resume'],
		]);
		// The boundary row carries the Schema-encoded Provides state.
		expect(rows[1].stateDelta).toEqual({
			dates: [{ date: '2026-06-20', slots: 1 }],
		});
	});

	it('re-runs the open segment from its head after a failed lease (read steps re-run freely)', async () => {
		const { journal, flagged } = makeFlagged();
		const command = { serviceId: '53178494', date: '2026-06-15', adapterProfile };
		const context = { operationId: 'op-slots-rerun' };

		stepMocks.readSlotsViaUrl.mockReturnValueOnce(
			Effect.fail(
				new WizardStepError({ step: 'read-availability', message: 'transient' }),
			),
		);
		const error = await captureExecutionError(
			flagged.refreshAvailabilitySlots(command, context),
		);
		expect(error.status).toBe('failed_pre_submit');
		expect(error.retryable).toBe(true);

		// Re-lease: no segment boundary was journaled, so the segment re-runs from
		// its head — full legacy-equivalent re-run, no skipped_resume rows.
		const slots = await flagged.refreshAvailabilitySlots(command, context);
		expect(slots).toEqual([{ datetime: '2026-06-15T16:00:00.000Z', available: true }]);
		expect(stepMocks.readSlotsViaUrl).toHaveBeenCalledTimes(2);

		const rows = await Effect.runPromise(journal.read('op-slots-rerun'));
		expect(rows.some((row) => row.status === 'skipped_resume')).toBe(false);
		expect(rows.map((row) => [row.status, row.attempt])).toEqual([
			['started', 1],
			['failed', 1],
			['started', 2],
			['completed', 2],
		]);
	});
});

// =============================================================================
// BOOKING RESUME — segment replay (no effectful-once evidence)
// =============================================================================

describe('booking resume on re-lease (flag on, no effectful-once evidence)', () => {
	it('skips journaled segment boundaries and re-runs from the open segment', async () => {
		const { journal, flagged } = makeFlagged();
		const context = { executionPath: 'browser' as const, operationId: 'op-booking-resume' };

		stepMocks.fillFormFields.mockReturnValueOnce(
			Effect.fail(new WizardStepError({ step: 'fill-form', message: 'transient' })),
		);
		const error = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), context),
		);
		expect(error.status).toBe('failed_pre_submit');
		expect(error.step).toBe('fill-form');
		expect(error.retryable).toBe(true);

		// Re-lease: navigate's segment boundary is journaled — it is skipped; the
		// open fill-form segment re-runs from its head and the flow completes.
		const booking = await flagged.createBookingWithPayment(
			bookingCommand('TEST-100'),
			context,
		);
		expect(booking.id).toBe('apt_123');
		expect(stepMocks.navigateToBooking).toHaveBeenCalledTimes(1);
		expect(stepMocks.fillFormFields).toHaveBeenCalledTimes(2);
		expect(stepMocks.submitBooking).toHaveBeenCalledTimes(1);
		expect(stepMocks.extractConfirmation).toHaveBeenCalledTimes(1);

		const rows = await Effect.runPromise(journal.read('op-booking-resume'));
		const resumed = rows.slice(4); // lease 1: navigate started/completed, fill-form started/failed
		expect(resumed.map((row) => [row.stepId, row.status])).toEqual([
			['acuity/navigate', 'skipped_resume'],
			['acuity/fill-form', 'started'],
			['acuity/fill-form', 'completed'],
			['acuity/bypass-payment', 'started'],
			['acuity/bypass-payment', 'completed'],
			['acuity/submit', 'started'],
			['acuity/submit', 'completed'],
			['acuity/extract-confirmation', 'started'],
			['acuity/extract-confirmation', 'completed'],
		]);
	});

	it('a journal with no boundary degenerates to re-run-from-navigate (stated, not oversold)', async () => {
		const { journal, flagged } = makeFlagged();
		const context = { executionPath: 'browser' as const, operationId: 'op-booking-nav' };

		stepMocks.navigateToBooking.mockReturnValueOnce(
			Effect.fail(new WizardStepError({ step: 'navigate', message: 'transient' })),
		);
		await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), context),
		);

		const booking = await flagged.createBookingWithPayment(
			bookingCommand('TEST-100'),
			context,
		);
		expect(booking.id).toBe('apt_123');
		expect(stepMocks.navigateToBooking).toHaveBeenCalledTimes(2);
		const rows = await Effect.runPromise(journal.read('op-booking-nav'));
		expect(rows.some((row) => row.status === 'skipped_resume')).toBe(false);
	});
});

// =============================================================================
// CONFIRMATION-PROBE GATE (the resume side of effectful-once; design §5 and
// risk register #3: never silent re-submit)
// =============================================================================

describe('confirmation-probe gate on booking resume (flag on)', () => {
	const seedStartedSubmit = async (journal: FlowJournalShape, operationId: string) => {
		await seedRow(journal, operationId, 'acuity/navigate', 'started');
		await seedRow(journal, operationId, 'acuity/navigate', 'completed');
		await seedRow(journal, operationId, 'acuity/fill-form', 'started');
		await seedRow(journal, operationId, 'acuity/fill-form', 'completed');
		await seedRow(journal, operationId, 'acuity/bypass-payment', 'started');
		await seedRow(journal, operationId, 'acuity/bypass-payment', 'completed', {
			idempotencyToken: 'TEST-100',
		});
		await seedRow(journal, operationId, 'acuity/submit', 'started');
	};

	it('confirmation found: marks the job succeeded with the extracted data and never re-runs submit', async () => {
		const { journal, flagged } = makeFlagged();
		const operationId = 'op-probe-found';
		await seedStartedSubmit(journal, operationId);

		const booking = await flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId,
		});

		// The probe (extract-confirmation) ran; NOTHING else did — especially not submit.
		expect(booking.id).toBe('apt_123');
		expect(booking.confirmationCode).toBe('confirm_123');
		expect(stepMocks.extractConfirmation).toHaveBeenCalledTimes(1);
		expect(stepMocks.submitBooking).not.toHaveBeenCalled();
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
		expect(stepMocks.fillFormFields).not.toHaveBeenCalled();
		expect(stepMocks.bypassPayment).not.toHaveBeenCalled();

		// Evidence rows: the dangling effectful-once checkpoint is resolved to
		// completed, and the probe is journaled as completed.
		const rows = await Effect.runPromise(journal.read(operationId));
		expect(rows.slice(-2).map((row) => [row.stepId, row.status])).toEqual([
			['acuity/submit', 'completed'],
			['acuity/extract-confirmation', 'completed'],
		]);
	});

	it('ambiguous probe: reconcile_required with step trace, landing observation, and evidence — never re-submits', async () => {
		const { journal, flagged } = makeFlagged();
		const operationId = 'op-probe-ambiguous';
		await seedStartedSubmit(journal, operationId);

		stepMocks.extractConfirmation.mockReturnValue(
			Effect.fail(
				new WizardStepError({ step: 'extract', message: 'Not on confirmation page' }),
			),
		);

		const error = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
				operationId,
			}),
		);

		expect(error.status).toBe('reconcile_required');
		expect(error.code).toBe('CONFIRMATION_PROBE_AMBIGUOUS');
		expect(error.step).toBe('submit');
		expect(error.retryable).toBe(false);
		// Step trace, landing observation, and probe evidence are attached.
		expect(error.message).toContain('acuity/submit:started');
		expect(error.message).toContain("observed 'unknown'");
		expect(error.message).toContain('Not on confirmation page');

		// NEVER silent re-submit; the only browser work was the cheap probe.
		expect(stepMocks.submitBooking).not.toHaveBeenCalled();
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
		expect(stepMocks.extractConfirmation).toHaveBeenCalledTimes(1);

		// The ambiguity is journaled as probe evidence (failed row, evidence-only).
		const rows = await Effect.runPromise(journal.read(operationId));
		const last = rows[rows.length - 1];
		expect([last.stepId, last.status]).toEqual(['acuity/extract-confirmation', 'failed']);
		expect(last.error?.code).toBe('CONFIRMATION_PROBE_AMBIGUOUS');
		expect(last.landing?.observed).toBe('unknown');
	});

	it('probe success without confirmation state is ambiguous (reconcile_required), not succeeded', async () => {
		const journal = createInMemoryFlowJournal();
		const operationId = 'op-probe-empty';
		await seedRow(journal, operationId, 'acuity/submit', 'started');

		// A probe step that "succeeds" but yields no confirmation state: the gate
		// must treat it as ambiguous — never surface a booking, never re-submit.
		const steps = new Map(bookingFlow.steps);
		const extract = steps.get('acuity/extract-confirmation');
		if (!extract) throw new Error('extract step missing from the booking flow');
		steps.set('acuity/extract-confirmation', {
			...extract,
			run: () => Effect.succeed({ state: {} as never }),
		});
		const flow = { ...bookingFlow, steps };
		const deps = {
			journal,
			sessionLayer: () => Layer.empty,
			runExit: (effect: Effect.Effect<unknown, unknown, never>) =>
				Effect.runPromiseExit(effect),
		};

		const error = await captureExecutionError(
			executeBookingThroughFlow(
				deps as never,
				flow as never,
				bookingCommand('TEST-100'),
				'TEST-100',
				{ operationId },
			),
		);
		expect(error.status).toBe('reconcile_required');
		expect(error.code).toBe('CONFIRMATION_PROBE_AMBIGUOUS');
		expect(error.retryable).toBe(false);
		expect(error.message).toContain('no confirmation state');
		expect(stepMocks.submitBooking).not.toHaveBeenCalled();
	});
});

// =============================================================================
// COUPON idempotencyToken REUSE (design §5 replayable-write token reuse)
// =============================================================================

describe('payment-injection token reuse on resume (flag on)', () => {
	it('threads the journaled coupon token back into the bypass step instead of minting', async () => {
		const { journal, flagged } = makeFlagged();
		const operationId = 'op-token-reuse';
		// An earlier lease journaled the bypass token but no segment boundary
		// (boundary write lost): the bypass segment re-runs and MUST reuse the token.
		await seedRow(journal, operationId, 'acuity/bypass-payment', 'completed', {
			idempotencyToken: 'COUPON-X',
		});

		const booking = await flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId,
		});
		expect(booking.id).toBe('apt_123');

		// The journaled token — NOT the freshly minted command coupon — drove the bypass.
		expect(stepMocks.bypassPayment).toHaveBeenCalledTimes(1);
		expect(stepMocks.bypassPayment).toHaveBeenCalledWith('COUPON-X');

		// And the re-run's started row re-attaches the journaled token.
		const rows = await Effect.runPromise(journal.read(operationId));
		const started = rows.filter(
			(row) => row.stepId === 'acuity/bypass-payment' && row.status === 'started',
		);
		expect(started).toHaveLength(1);
		expect(started[0].idempotencyToken).toBe('COUPON-X');
	});
});
