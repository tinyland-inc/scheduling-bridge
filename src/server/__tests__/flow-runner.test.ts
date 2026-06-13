/**
 * Flow runner wiring tests (TIN-2036; flip TIN-2072; deletion gate TIN-2093; design
 * §5, §10 0.7.0). After the deletion gate `runFlow` is the ONLY execution path — the
 * `BRIDGE_FLOW_RUNNER` flag, the legacy executor, and shadow mode are deleted. These
 * tests exercise the fold directly:
 *
 * - Booking and availability jobs execute through runFlow with one session layer per
 *   segment, producing the documented status vocabulary the legacy path produced (the
 *   recorded golden fixtures + trace-conformance harness are the byte-level baseline).
 * - The bypass-proof boundary (Diverged ⇒ PAYMENT_BYPASS_NOT_PROVEN), the COUPON_REQUIRED
 *   and REST_BOOKING_NOT_WIRED executor guards, landing divergence, and read-flow
 *   journal sampling.
 * - Lease-time plan-hash skew: mismatch ⇒ requeue with FLOW_PLAN_SKEW; mismatch after
 *   an effectful-once 'started' journal row ⇒ reconcile_required.
 *
 * Step stubs are substituted at the module boundary (the same seam style the existing
 * server suites use); the browser layers are substituted with succeed-Layers so no
 * Chromium is ever launched.
 */

import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaymentCapabilities } from '@tummycrypt/scheduling-kit/payments';

const stepMocks = vi.hoisted(() => ({
	navigateToBooking: vi.fn(),
	fillFormFields: vi.fn(),
	// Payment-injection sub-flow (design §7; TIN-2095).
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

vi.mock('../../adapters/acuity/steps/index.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../adapters/acuity/steps/index.js')>();
	return {
		...actual,
		navigateToBooking: stepMocks.navigateToBooking,
		fillFormFields: stepMocks.fillFormFields,
		openCouponEntry: stepMocks.openCouponEntry,
		applyCoupon: stepMocks.applyCoupon,
		verifyZeroTotal: stepMocks.verifyZeroTotal,
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
} from '../../flow/index.js';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';
import {
	BridgeJobExecutionError,
	executeBridgeJob,
} from '../../async/worker.js';
import type { AppointmentCommand, BridgeAdapterProfile } from '../../async/types.js';
import { WizardStepError } from '../../adapters/acuity/errors.js';
import { acuityFlowEnqueuePinning } from '../../adapters/acuity/flows.js';
import { acuityFlowPack } from '../../adapters/acuity/flow-pack.js';

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

const makeExecutor = () => {
	const journal = createInMemoryFlowJournal();
	const fold = createAcuityBridgeJobExecutor({
		redisClient: null,
		flowJournal: journal,
	});
	return { journal, fold };
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

describe('runFlow execution: the fold is the only path (status vocabulary preserved)', () => {
	it('produces the booking and the full journal evidence trail on success', async () => {
		const { fold, journal } = makeExecutor();
		const booking = await fold.createBookingWithPayment(
			bookingCommand('TEST-100'),
			{ executionPath: 'browser', operationId: 'op-success' },
		);

		expect(booking.id).toBe('apt_123');
		expect(booking.status).toBe('confirmed');

		// The journal carries the full evidence trail: started+completed per step,
		// in plan order, with the coupon code as the payment-injection
		// idempotencyToken (design §5 replayable-write token reuse).
		const rows = await Effect.runPromise(journal.read('op-success'));
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
		// Every payment-injection sub-step journals the SAME reused coupon code as its
		// idempotencyToken (design §5 replayable-write token reuse; TIN-2095).
		const paymentTokens = rows
			.filter(
				(row) =>
					row.status === 'completed' &&
					['acuity/open-coupon-entry', 'acuity/apply-coupon', 'acuity/verify-zero-total'].includes(
						row.stepId,
					),
			)
			.map((row) => row.idempotencyToken);
		expect(paymentTokens).toEqual(['TEST-100', 'TEST-100', 'TEST-100']);
	});

	it.each([
		[
			'navigate failure',
			() =>
				stepMocks.navigateToBooking.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'navigate', message: 'nav broke' })),
				),
			{ status: 'failed_pre_submit', step: 'navigate', retryable: true },
		],
		[
			'fill-form failure',
			() =>
				stepMocks.fillFormFields.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'fill-form', message: 'form broke' })),
				),
			{ status: 'failed_pre_submit', step: 'fill-form', retryable: true },
		],
		[
			'submit failure (reconcile_required boundary)',
			() =>
				stepMocks.submitBooking.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'submit', message: 'submit broke' })),
				),
			{ status: 'reconcile_required', step: 'submit', retryable: false },
		],
		[
			'extract failure (reconcile_required boundary)',
			() =>
				stepMocks.extractConfirmation.mockReturnValue(
					Effect.fail(new WizardStepError({ step: 'extract', message: 'extract broke' })),
				),
			{ status: 'reconcile_required', step: 'extract-confirmation', retryable: false },
		],
	])(
		'maps step failures onto the legacy status boundaries: %s',
		async (_label, arrange, expected) => {
			arrange();
			const { fold } = makeExecutor();
			const error = await captureExecutionError(
				fold.createBookingWithPayment(bookingCommand('TEST-100'), {
					executionPath: 'browser',
				}),
			);
			expect(error.status).toBe(expected.status);
			expect(error.step).toBe(expected.step);
			expect(error.retryable).toBe(expected.retryable);
		},
	);

	it('preserves the exact PAYMENT_BYPASS_NOT_PROVEN failure (Diverged on the payment-injection segment)', async () => {
		// The $0 proof now diverges at verify-zero-total (design §6; TIN-2095).
		stepMocks.verifyZeroTotal.mockReturnValue(
			Effect.succeed({
				couponApplied: false,
				code: 'TEST-100',
				totalAfterCoupon: null,
			}),
		);
		const { fold } = makeExecutor();
		const error = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand('TEST-100'), {
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

	it('keeps the COUPON_REQUIRED and REST_BOOKING_NOT_WIRED executor guards', async () => {
		const { fold } = makeExecutor();

		const coupon = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand(undefined), {
				executionPath: 'browser',
			}),
		);
		expect(coupon.code).toBe('COUPON_REQUIRED');
		expect(coupon.status).toBe('failed_pre_submit');
		expect(coupon.step).toBe('bypass-payment');
		expect(coupon.retryable).toBe(false);

		const rest = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'rest',
			}),
		);
		expect(rest.code).toBe('REST_BOOKING_NOT_WIRED');
		expect(rest.status).toBe('failed_pre_submit');
		expect(rest.step).toBe('execution-path');
		expect(rest.retryable).toBe(false);
	});

	it('maps a landing divergence to failed_pre_submit (the status the legacy path reached in production)', async () => {
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
		const { fold } = makeExecutor();
		const error = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
			}),
		);
		expect(error.status).toBe('failed_pre_submit');
		expect(error.code).toBe('FLOW_DIVERGED');
		expect(error.step).toBe('navigate');
		expect(error.retryable).toBe(true);
	});

	it('refreshes availability and maps read failures to retryable failed_pre_submit', async () => {
		const { fold } = makeExecutor();
		const command = {
			serviceId: '53178494',
			month: '2026-06',
			adapterProfile,
		};
		const dates = await fold.refreshAvailabilityDates(command);
		expect(dates).toEqual([{ date: '2026-06-20', slots: 1 }]);

		stepMocks.readDatesViaUrl.mockReturnValue(
			Effect.fail(
				new WizardStepError({ step: 'read-availability', message: 'read broke' }),
			),
		);
		const error = await captureExecutionError(
			fold.refreshAvailabilityDates(command),
		);
		expect(error.status).toBe('failed_pre_submit');
		expect(error.step).toBe('refresh-availability-dates');
		expect(error.retryable).toBe(true);
	});

	it('dispatches non-numeric service ids through the wizard read steps (worker parity)', async () => {
		const { fold } = makeExecutor();
		const command = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			month: '2026-06',
			adapterProfile,
		};
		const dates = await fold.refreshAvailabilityDates(command);
		expect(dates).toEqual([{ date: '2026-06-21', slots: 1 }]);
		expect(stepMocks.readAvailableDates).toHaveBeenCalledTimes(1);
		expect(stepMocks.readDatesViaUrl).not.toHaveBeenCalled();

		const slotsCommand = {
			serviceId: 'relaxation-massage',
			serviceName: 'Relaxation Massage',
			date: '2026-06-21',
			adapterProfile,
		};
		const slots = await fold.refreshAvailabilitySlots(slotsCommand);
		expect(slots).toEqual([{ datetime: '2026-06-21T15:00:00.000Z', available: true }]);
		expect(stepMocks.readTimeSlots).toHaveBeenCalledTimes(1);
	});
});

// =============================================================================
// PAYMENT-INJECTION DOUBLE GATE, UPSTREAM OF BROWSER WORK (design §7; TIN-2095)
// =============================================================================

describe('payment-injection double gate (checked before any browser work)', () => {
	const capabilities = (
		overrides: Partial<PaymentCapabilities> = {},
	): PaymentCapabilities => ({
		methods: [],
		stripe: null,
		venmo: null,
		cash: false,
		...overrides,
	});

	const venmoAdmits = capabilities({
		venmo: { available: true, clientId: 'cid', environment: 'production' },
	});

	/** An executor with a session-layer spy: if the gate denies upstream, the spy
	 * (browser session provisioning) is NEVER invoked. */
	const makeGatedExecutor = (
		paymentCapabilities: () => PaymentCapabilities,
	) => {
		const journal = createInMemoryFlowJournal();
		const segments: string[] = [];
		const fold = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
			paymentCapabilities,
			sessionLayer: (segment) => {
				segments.push(segment);
				return Layer.succeed(
					// The session layer is only built when the fold opens a segment Scope.
					// (Tag identity is irrelevant here: a denied gate never reaches it.)
					{} as never,
					{} as never,
				);
			},
		});
		return { fold, segments };
	};

	it('both admit (pack coupon-bypass AND kit Venmo) → the booking runs through the fold', async () => {
		const { fold } = makeGatedExecutor(() => venmoAdmits);
		const booking = await fold.createBookingWithPayment(bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId: 'op-gate-both',
		});
		expect(booking.id).toBe('apt_123');
		expect(stepMocks.navigateToBooking).toHaveBeenCalledTimes(1);
		expect(stepMocks.verifyZeroTotal).toHaveBeenCalledTimes(1);
	});

	it('kit-capability denies → segment skipped UPSTREAM of browser work (no scope, no step ran)', async () => {
		const { fold, segments } = makeGatedExecutor(() => capabilities()); // no Venmo rail
		const error = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
				operationId: 'op-gate-kit-deny',
			}),
		);
		expect(error.code).toBe('PAYMENT_CAPABILITY_DENIED');
		expect(error.status).toBe('failed_pre_submit');
		expect(error.step).toBe('bypass-payment');
		expect(error.retryable).toBe(false);
		// Upstream of any browser work: the fold never opened a segment Scope and no
		// step program ran.
		expect(segments).toEqual([]);
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
		expect(stepMocks.openCouponEntry).not.toHaveBeenCalled();
		expect(stepMocks.verifyZeroTotal).not.toHaveBeenCalled();
	});

	it('pack denies (paymentInjection !== coupon-bypass) → segment skipped, kit half not consulted', async () => {
		const journal = createInMemoryFlowJournal();
		const segments: string[] = [];
		let capabilitiesConsulted = false;
		// A stub pack that does NOT declare coupon-bypass; reuse the real flows so the
		// executor can construct (only paymentInjection drives the pack half).
		const nativePack = {
			...acuityFlowPack,
			paymentInjection: 'native' as const,
		};
		const fold = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
			flowPack: nativePack,
			paymentCapabilities: () => {
				capabilitiesConsulted = true;
				return venmoAdmits;
			},
			sessionLayer: (segment) => {
				segments.push(segment);
				return Layer.succeed({} as never, {} as never);
			},
		});
		const error = await captureExecutionError(
			fold.createBookingWithPayment(bookingCommand('TEST-100'), {
				executionPath: 'browser',
				operationId: 'op-gate-pack-deny',
			}),
		);
		expect(error.code).toBe('PAYMENT_INJECTION_UNSUPPORTED');
		expect(error.status).toBe('failed_pre_submit');
		expect(error.retryable).toBe(false);
		// Pack half is checked FIRST: a denying pack short-circuits before the kit
		// capability resolver is even consulted, and no browser work happens.
		expect(capabilitiesConsulted).toBe(false);
		expect(segments).toEqual([]);
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
	});
});

describe('read-flow journal sampling (BRIDGE_FLOW_JOURNAL_SAMPLE; flagged path)', () => {
	const ORIGINAL = process.env.BRIDGE_FLOW_JOURNAL_SAMPLE;
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.BRIDGE_FLOW_JOURNAL_SAMPLE;
		else process.env.BRIDGE_FLOW_JOURNAL_SAMPLE = ORIGINAL;
	});

	const datesCommand = {
		serviceId: '53178494',
		month: '2026-06',
		adapterProfile,
	};

	it('journals the read flow by default (sample rate 1.0 — current behavior)', async () => {
		delete process.env.BRIDGE_FLOW_JOURNAL_SAMPLE;
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
		});
		const dates = await flagged.refreshAvailabilityDates(datesCommand, {
			operationId: 'op-sample-in',
		});
		expect(dates).toEqual([{ date: '2026-06-20', slots: 1 }]);
		const rows = await Effect.runPromise(journal.read('op-sample-in'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'completed']);
	});

	it('sampled OUT (rate 0): the read returns data but journals ZERO rows', async () => {
		process.env.BRIDGE_FLOW_JOURNAL_SAMPLE = '0';
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
		});
		const dates = await flagged.refreshAvailabilityDates(datesCommand, {
			operationId: 'op-sample-out',
		});
		// Read result is unaffected by the sampling decision.
		expect(dates).toEqual([{ date: '2026-06-20', slots: 1 }]);
		// No checkpoint rows persisted for a sampled-out read.
		const rows = await Effect.runPromise(journal.read('op-sample-out'));
		expect(rows).toEqual([]);
	});

	it('booking flows are never sampled out (always journaled) even at rate 0', async () => {
		process.env.BRIDGE_FLOW_JOURNAL_SAMPLE = '0';
		const journal = createInMemoryFlowJournal();
		const flagged = createAcuityBridgeJobExecutor({
			redisClient: null,
			flowJournal: journal,
		});
		await flagged.createBookingWithPayment(bookingCommand('TEST-100'), {
			executionPath: 'browser',
			operationId: 'op-booking-not-sampled',
		});
		const rows = await Effect.runPromise(journal.read('op-booking-not-sampled'));
		expect(rows.length).toBeGreaterThan(0);
		expect(rows.some((r) => r.stepId === 'acuity/submit')).toBe(true);
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
		// 7 booking steps × (started + completed) after the payment-injection
		// decomposition (design §7; TIN-2095): navigate, fill-form, open-coupon-entry,
		// apply-coupon, verify-zero-total, submit, extract-confirmation.
		expect(rows.length).toBe(14);
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
