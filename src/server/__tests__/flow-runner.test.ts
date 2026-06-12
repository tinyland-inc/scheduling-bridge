/**
 * BRIDGE_FLOW_RUNNER wiring tests (TIN-2036; design §5, §10 0.6.0 block):
 *
 * - Flag OFF (the DEFAULT): the legacy executor path runs exactly as today, the flow
 *   journal is never touched (runFlow not invoked), and shadow mode diffs the
 *   plan-predicted step sequence vs the executed step ids into shared/metrics.ts.
 * - Flag ON: booking and availability jobs execute through runFlow with one session
 *   layer per segment, and every status transition EQUALS the legacy transition —
 *   asserted by running BOTH executors over the same substituted stub steps.
 * - Lease-time plan-hash skew (flagged path only): mismatch ⇒ requeue with
 *   FLOW_PLAN_SKEW; mismatch after an effectful-once 'started' journal row ⇒
 *   reconcile_required.
 *
 * Step stubs are substituted at the module boundary (the same seam style the
 * existing server suites use); the browser layers are substituted with succeed-Layers
 * so no Chromium is ever launched.
 */

import { Effect } from 'effect';
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
import { selectFlowJournal } from '../flow-runner.js';
import {
	createInMemoryFlowJournal,
	type FlowJournalShape,
	JournalError,
} from '../../flow/index.js';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';
import {
	BridgeJobExecutionError,
	executeBridgeJob,
} from '../../async/worker.js';
import type { AppointmentCommand, BridgeAdapterProfile } from '../../async/types.js';
import { WizardStepError } from '../../adapters/acuity/errors.js';
import { acuityFlowEnqueuePinning } from '../../adapters/acuity/flows.js';
import { metrics } from '../../shared/metrics.js';

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

/** A journal that must never be touched (proves runFlow is not invoked flag-off). */
const poisonJournal = (): FlowJournalShape & { touched: () => boolean } => {
	let appends = 0;
	return {
		append: () =>
			Effect.suspend(() => {
				appends += 1;
				return Effect.fail(
					new JournalError({ message: 'journal must not be touched flag-off' }),
				);
			}),
		read: () => Effect.succeed([]),
		touched: () => appends > 0,
	};
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
	});
	return { journal, legacy, flagged };
};

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

const transitionOf = (error: BridgeJobExecutionError) => ({
	status: error.status,
	code: error.code,
	step: error.step,
	retryable: error.retryable,
});

const shadowRunCount = async (
	flowId: string,
	result: string,
): Promise<number> => {
	const data = await metrics.flowShadowRunsTotal.get();
	return (
		data.values.find(
			(v) =>
				(v.labels as Record<string, string>).flow_id === flowId &&
				(v.labels as Record<string, string>).result === result,
		)?.value ?? 0
	);
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

describe('flag OFF (default): legacy path + shadow mode, zero behavior change', () => {
	it('executes the legacy booking path without touching the flow journal', async () => {
		const journal = poisonJournal();
		const executor = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
		});
		const before = await shadowRunCount('booking_create_with_payment', 'match');

		const booking = await executor.createBookingWithPayment(
			bookingCommand('TEST-100'),
			{ executionPath: 'browser' },
		);

		expect(booking.id).toBe('apt_123');
		expect(booking.status).toBe('confirmed');
		expect(journal.touched()).toBe(false);
		expect(stepMocks.navigateToBooking).toHaveBeenCalledTimes(1);
		expect(stepMocks.fillFormFields).toHaveBeenCalledTimes(1);
		expect(stepMocks.bypassPayment).toHaveBeenCalledTimes(1);
		expect(stepMocks.submitBooking).toHaveBeenCalledTimes(1);
		expect(stepMocks.extractConfirmation).toHaveBeenCalledTimes(1);

		const after = await shadowRunCount('booking_create_with_payment', 'match');
		expect(after - before).toBe(1);
	});

	it('records a shadow prefix when the legacy path fails part-way', async () => {
		stepMocks.submitBooking.mockReturnValue(
			Effect.fail(new WizardStepError({ step: 'submit', message: 'boom' })),
		);
		const executor = createAcuityBridgeJobExecutor({ redisClient: null });
		const before = await shadowRunCount('booking_create_with_payment', 'prefix');

		await captureExecutionError(
			executor.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);

		const after = await shadowRunCount('booking_create_with_payment', 'prefix');
		expect(after - before).toBe(1);
	});

	it('shadows the availability refresh flows too', async () => {
		const executor = createAcuityBridgeJobExecutor({ redisClient: null });
		const before = await shadowRunCount('availability_dates_refresh', 'match');

		const dates = await executor.refreshAvailabilityDates({
			serviceId: '53178494',
			month: '2026-06',
			adapterProfile,
		});

		expect(dates).toEqual([{ date: '2026-06-20', slots: 1 }]);
		expect(stepMocks.readDatesViaUrl).toHaveBeenCalledTimes(1);
		const after = await shadowRunCount('availability_dates_refresh', 'match');
		expect(after - before).toBe(1);
	});
});

describe('flag ON: status-transition parity with the legacy path (stub steps)', () => {
	it('produces the same booking as the legacy path on success', async () => {
		const { legacy, flagged, journal } = makeExecutors();
		const legacyBooking = await legacy.createBookingWithPayment(
			bookingCommand('TEST-100'),
			{ executionPath: 'browser' },
		);
		const flaggedBooking = await flagged.createBookingWithPayment(
			bookingCommand('TEST-100'),
			{ executionPath: 'browser', operationId: 'op-success' },
		);

		expect({ ...flaggedBooking, createdAt: 'pinned' }).toEqual({
			...legacyBooking,
			createdAt: 'pinned',
		});

		// The journal carries the full evidence trail: started+completed per step,
		// in plan order, with the coupon code as the payment-injection
		// idempotencyToken (design §5 replayable-write token reuse).
		const rows = await Effect.runPromise(journal.read('op-success'));
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
		const bypassCompleted = rows.find(
			(row) => row.stepId === 'acuity/bypass-payment' && row.status === 'completed',
		);
		expect(bypassCompleted?.idempotencyToken).toBe('TEST-100');
	});

	it.each([
		[
			'navigate failure',
			() =>
				stepMocks.navigateToBooking.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'navigate', message: 'nav broke' })),
				),
		],
		[
			'fill-form failure',
			() =>
				stepMocks.fillFormFields.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'fill-form', message: 'form broke' })),
				),
		],
		[
			'submit failure (reconcile_required boundary)',
			() =>
				stepMocks.submitBooking.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'submit', message: 'submit broke' })),
				),
		],
		[
			'extract failure (reconcile_required boundary)',
			() =>
				stepMocks.extractConfirmation.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'extract', message: 'extract broke' })),
				),
		],
		[
			'payment bypass not proven',
			() =>
				stepMocks.bypassPayment.mockReturnValue(
					Effect.succeed({
						couponApplied: true,
						code: 'TEST-100',
						totalAfterCoupon: '$5.00',
					}),
				),
		],
	])('matches legacy status transitions: %s', async (_label, arrange) => {
		arrange();
		const { legacy, flagged } = makeExecutors();
		const legacyError = await captureExecutionError(
			legacy.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);
		const flaggedError = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);
		expect(transitionOf(flaggedError)).toEqual(transitionOf(legacyError));
	});

	it('preserves the exact PAYMENT_BYPASS_NOT_PROVEN failure (Diverged on the payment-injection segment)', async () => {
		stepMocks.bypassPayment.mockReturnValue(
			Effect.succeed({
				couponApplied: false,
				code: 'TEST-100',
				totalAfterCoupon: null,
			}),
		);
		const { flagged } = makeExecutors();
		const error = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);
		expect(transitionOf(error)).toEqual({
			status: 'failed_pre_submit',
			code: 'PAYMENT_BYPASS_NOT_PROVEN',
			step: 'bypass-payment',
			retryable: false,
		});
		expect(error.message).toBe('Payment bypass was not proven before submit');
	});

	it('matches the legacy COUPON_REQUIRED and REST_BOOKING_NOT_WIRED guards', async () => {
		const { legacy, flagged } = makeExecutors();

		const legacyCoupon = await captureExecutionError(
			legacy.createBookingWithPayment(bookingCommand(undefined), {
				executionPath: 'browser',
			}),
		);
		const flaggedCoupon = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand(undefined), {
				executionPath: 'browser',
			}),
		);
		expect(transitionOf(flaggedCoupon)).toEqual(transitionOf(legacyCoupon));
		expect(flaggedCoupon.code).toBe('COUPON_REQUIRED');

		const legacyRest = await captureExecutionError(
			legacy.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'rest',
			}),
		);
		const flaggedRest = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'rest',
			}),
		);
		expect(transitionOf(flaggedRest)).toEqual(transitionOf(legacyRest));
		expect(flaggedRest.code).toBe('REST_BOOKING_NOT_WIRED');
	});

	it('maps a landing divergence to failed_pre_submit (the status the legacy path reaches in production)', async () => {
		stepMocks.navigateToBooking.mockReturnValue(
			Effect.succeed({
				url: 'https://example.as.me/schedule/mock',
				landingStep: 'service-selection',
				appointmentTypeId: null,
				calendarId: null,
				selectedDate: '2026-06-15',
				selectedTime: '12:00 PM',
			}),
		);
		const { flagged } = makeExecutors();
		const error = await captureExecutionError(
			flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);
		expect(error.status).toBe('failed_pre_submit');
		expect(error.code).toBe('FLOW_DIVERGED');
		expect(error.step).toBe('navigate');
		expect(error.retryable).toBe(true);
	});

	it('matches legacy availability refresh results and failure transitions', async () => {
		const { legacy, flagged } = makeExecutors();
		const command = {
			serviceId: '53178494',
			month: '2026-06',
			adapterProfile,
		};
		const legacyDates = await legacy.refreshAvailabilityDates(command);
		const flaggedDates = await flagged.refreshAvailabilityDates(command);
		expect(flaggedDates).toEqual(legacyDates);

		stepMocks.readDatesViaUrl.mockReturnValue(
			Effect.fail(
				new WizardStepError({ step: 'read-availability', message: 'read broke' }),
			),
		);
		const legacyError = await captureExecutionError(
			legacy.refreshAvailabilityDates(command),
		);
		const flaggedError = await captureExecutionError(
			flagged.refreshAvailabilityDates(command),
		);
		expect(transitionOf(flaggedError)).toEqual(transitionOf(legacyError));
		expect(flaggedError.step).toBe('refresh-availability-dates');
		expect(flaggedError.retryable).toBe(true);
	});

	it('dispatches non-numeric service ids through the wizard read steps (worker parity)', async () => {
		const { legacy, flagged } = makeExecutors();
		const command = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			month: '2026-06',
			adapterProfile,
		};
		const legacyDates = await legacy.refreshAvailabilityDates(command);
		const flaggedDates = await flagged.refreshAvailabilityDates(command);
		expect(flaggedDates).toEqual(legacyDates);
		expect(stepMocks.readAvailableDates).toHaveBeenCalledTimes(2);
		expect(stepMocks.readDatesViaUrl).not.toHaveBeenCalled();

		const slotsCommand = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			date: '2026-06-21',
			adapterProfile,
		};
		const legacySlots = await legacy.refreshAvailabilitySlots(slotsCommand);
		const flaggedSlots = await flagged.refreshAvailabilitySlots(slotsCommand);
		expect(flaggedSlots).toEqual(legacySlots);
		expect(stepMocks.readTimeSlots).toHaveBeenCalledTimes(2);
	});
});

describe('lease-time plan-hash skew (design §5 plan-hash pinning; flagged path only)', () => {
	const freshSlotsSnapshot = (store: ReturnType<typeof createInMemoryBridgeAsyncStore>) =>
		store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: '53178494',
			scope: '2026-06-15',
			adapterProfile,
			value: [{ datetime: '2026-06-15T16:00:00.000Z', available: true }] as never,
			observedAt: new Date().toISOString(),
			staleAt: new Date(Date.now() + 5 * 60_000).toISOString(),
			expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
		});

	it('requeues with FLOW_PLAN_SKEW when the pinned hash mismatches the constructed flow', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await freshSlotsSnapshot(store);
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowRunner: true,
			flowJournal: journal,
		});
		const record = await store.enqueueJob(
			{ kind: 'booking_create_with_payment', command: bookingCommand('TEST-100') },
			{ planHash: 'stale-hash', flowVersion: '0.0.1' },
		);

		const result = await executeBridgeJob(store, record, flagged, {
			workerId: 'worker-test',
		});

		expect(result?.status).toBe('queued');
		expect(result?.failure?.code).toBe('FLOW_PLAN_SKEW');
		expect(result?.failure?.retryable).toBe(true);
		expect(result?.failure?.step).toBe('flow-plan');
		// No step ever started.
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
		await expect(
			Effect.runPromise(journal.read(record.operationId)),
		).resolves.toEqual([]);
	});

	it('hard-maps to reconcile_required when an effectful-once started row exists', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await freshSlotsSnapshot(store);
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowRunner: true,
			flowJournal: journal,
		});
		const record = await store.enqueueJob(
			{ kind: 'booking_create_with_payment', command: bookingCommand('TEST-100') },
			{ planHash: 'stale-hash', flowVersion: '0.0.1' },
		);
		await Effect.runPromise(
			journal.append({
				operationId: record.operationId,
				flowId: 'booking_create_with_payment',
				flowVersion: '0.0.1',
				planHash: 'stale-hash',
				stepId: 'acuity/submit',
				attempt: 1,
				status: 'started',
				at: new Date().toISOString(),
			}),
		);

		const result = await executeBridgeJob(store, record, flagged, {
			workerId: 'worker-test',
		});

		expect(result?.status).toBe('reconcile_required');
		expect(result?.failure?.code).toBe('FLOW_PLAN_SKEW');
		expect(result?.failure?.retryable).toBe(false);
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
	});

	it('executes normally when the pinned hash matches (operationId threads into the journal)', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await freshSlotsSnapshot(store);
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowRunner: true,
			flowJournal: journal,
		});
		const record = await store.enqueueJob(
			{ kind: 'booking_create_with_payment', command: bookingCommand('TEST-100') },
			acuityFlowEnqueuePinning('booking_create_with_payment'),
		);

		const result = await executeBridgeJob(store, record, flagged, {
			workerId: 'worker-test',
		});

		expect(result?.status).toBe('succeeded');
		expect(result?.result?.kind).toBe('booking_create_with_payment');
		const rows = await Effect.runPromise(journal.read(record.operationId));
		expect(rows.length).toBe(10);
		expect(rows.every((row) => row.planHash === record.planHash)).toBe(true);
	});
});

describe('selectFlowJournal (rides the store selection order)', () => {
	it('falls back to the in-memory journal when no durable backend is configured', async () => {
		const journal = selectFlowJournal({ env: {} as NodeJS.ProcessEnv });
		const row = await Effect.runPromise(
			journal.append({
				operationId: 'op-mem',
				flowId: 'f',
				flowVersion: '1.0.0',
				planHash: 'h',
				stepId: 's',
				attempt: 1,
				status: 'started',
				at: new Date().toISOString(),
			}),
		);
		expect(row.seq).toBe(0);
		await expect(Effect.runPromise(journal.read('op-mem'))).resolves.toHaveLength(1);
	});
});
