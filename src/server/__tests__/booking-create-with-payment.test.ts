import { type AddressInfo } from 'node:net';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const stepMocks = vi.hoisted(() => ({
	navigateToBooking: vi.fn(),
	fillFormFields: vi.fn(),
	bypassPayment: vi.fn(),
	generateCouponCode: vi.fn(),
	submitBooking: vi.fn(),
	extractConfirmation: vi.fn(),
	toBooking: vi.fn(),
	readAvailableDates: vi.fn(),
	readTimeSlots: vi.fn(),
	fetchBusinessData: vi.fn(),
	businessToServices: vi.fn(),
}));

vi.mock('../../adapters/acuity/steps/index.js', () => stepMocks);

const service = {
	id: '53178494',
	name: 'TMD 1st Consultation & Session ',
	duration: 90,
	price: 15500,
	currency: 'USD',
	category: 'TMD',
	description: 'Consultation and treatment',
};

const bookingRequest = {
	serviceId: service.id,
	datetime: '2026-05-30T18:00:00.000Z',
	client: {
		firstName: 'Jess',
		lastName: 'Sullivan',
		email: 'jess@example.com',
		phone: '6075551212',
		notes: 'test booking',
		customFields: { pronouns: 'she/her' },
	},
};

const listen = async () => {
	const {
		server,
		__runEffectWithoutBrowserForTest,
		__setAcuityStepOverridesForTest,
		__setEffectRunnerForTest,
	} = await import('../handler.js');
	__setEffectRunnerForTest(__runEffectWithoutBrowserForTest);
	__setAcuityStepOverridesForTest({
		navigateToBooking: stepMocks.navigateToBooking,
		fillFormFields: stepMocks.fillFormFields,
		bypassPayment: stepMocks.bypassPayment,
		submitBooking: stepMocks.submitBooking,
		extractConfirmation: stepMocks.extractConfirmation,
		toBooking: stepMocks.toBooking,
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		server,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
};

describe('POST /booking/create-with-payment', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.SERVICES_JSON = JSON.stringify([service]);
		process.env.ACUITY_BYPASS_COUPON = 'TEST-100';
		delete process.env.REDIS_URL;
		delete process.env.AUTH_TOKEN;

		stepMocks.navigateToBooking.mockReturnValue(
			Effect.succeed({
				url: 'https://massageithaca.as.me/schedule/mock/datetime/2026-05-30T18:00:00.000Z',
				landingStep: 'client-form',
				appointmentTypeId: service.id,
				calendarId: '1234',
				selectedDate: '2026-05-30',
				selectedTime: '2:00 PM',
			}),
		);
		stepMocks.fillFormFields.mockReturnValue(
			Effect.succeed({ fieldsFilled: 3 }),
		);
		stepMocks.bypassPayment.mockReturnValue(Effect.succeed({ applied: true }));
		stepMocks.submitBooking.mockReturnValue(
			Effect.succeed({ submitted: true }),
		);
		stepMocks.extractConfirmation.mockReturnValue(
			Effect.succeed({
				appointmentId: 'apt_123',
				confirmationCode: 'confirm_123',
				serviceName: service.name.trim(),
				datetime: bookingRequest.datetime,
				providerName: null,
				rawText: 'Booking confirmed',
			}),
		);
		stepMocks.toBooking.mockReturnValue({
			id: 'apt_123',
			serviceId: service.id,
			serviceName: service.name.trim(),
			datetime: bookingRequest.datetime,
			duration: service.duration,
			price: service.price,
			currency: service.currency,
			client: bookingRequest.client,
			status: 'confirmed',
			confirmationCode: 'confirm_123',
			paymentStatus: 'paid',
			paymentRef: '[STRIPE] Transaction: pi_test_123',
			createdAt: '2026-05-03T00:00:00.000Z',
		});
	});

	afterEach(async () => {
		if (activeServer?.listening) {
			await new Promise<void>((resolve, reject) => {
				activeServer!.close((error) => (error ? reject(error) : resolve()));
			});
		}
		activeServer = null;
		delete process.env.SERVICES_JSON;
		delete process.env.ACUITY_BYPASS_COUPON;
	});

	it('rejects the synchronous paid booking endpoint so consumers migrate to async jobs', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/booking/create-with-payment`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					request: bookingRequest,
					paymentRef: 'pi_test_123',
					paymentProcessor: 'stripe',
				}),
			},
		);

		const body = await response.json();

		expect(response.status).toBe(410);
		expect(body).toMatchObject({
			success: false,
			error: {
				tag: 'Deprecated',
				code: 'ASYNC_REQUIRED',
			},
		});
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
		expect(stepMocks.bypassPayment).not.toHaveBeenCalled();
	});

	it('does not run the old sync endpoint even when a request-scoped coupon is present', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/booking/create-with-payment`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					request: bookingRequest,
					paymentRef: 'venmo_order_123',
					paymentProcessor: 'venmo',
					couponCode: 'REQUEST-100',
				}),
			},
		);

		expect(response.status).toBe(410);
		expect(stepMocks.bypassPayment).not.toHaveBeenCalled();
	});

	it('fails fast before sync paid booking validation when no bypass coupon is configured', async () => {
		delete process.env.ACUITY_BYPASS_COUPON;
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/booking/create-with-payment`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					request: bookingRequest,
					paymentRef: 'pi_test_123',
					paymentProcessor: 'stripe',
				}),
			},
		);

		const body = await response.json();

		expect(response.status).toBe(410);
		expect(body).toMatchObject({
			success: false,
			error: {
				tag: 'Deprecated',
				code: 'ASYNC_REQUIRED',
			},
		});
		expect(stepMocks.navigateToBooking).not.toHaveBeenCalled();
	});
});
