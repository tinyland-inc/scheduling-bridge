import { type AddressInfo } from 'node:net';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserError } from '../../adapters/acuity/errors.js';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';

const readViaUrlMocks = vi.hoisted(() => ({
	readDatesViaUrl: vi.fn(),
	readSlotsViaUrl: vi.fn(),
}));

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

const redisState = vi.hoisted(() => ({
	values: new Map<string, string>(),
	instances: [] as Array<{
		get: ReturnType<typeof vi.fn>;
		set: ReturnType<typeof vi.fn>;
		eval: ReturnType<typeof vi.fn>;
		exists: ReturnType<typeof vi.fn>;
		ping: ReturnType<typeof vi.fn>;
		quit: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
	}>,
}));

vi.mock('../../adapters/acuity/steps/read-via-url.js', () => readViaUrlMocks);
vi.mock('../../adapters/acuity/steps/index.js', () => stepMocks);

vi.mock('ioredis', () => {
	class Redis {
		get = vi.fn(async (key: string) => redisState.values.get(key) ?? null);

		set = vi.fn(
			async (
				key: string,
				value: string,
				...args: Array<string | number>
			): Promise<'OK' | null> => {
				const flags = args.map((arg) => String(arg).toUpperCase());
				if (flags.includes('NX') && redisState.values.has(key)) {
					return null;
				}
				redisState.values.set(key, value);
				return 'OK';
			},
		);

		eval = vi.fn(
			async (
				_script: string,
				_numKeys: number,
				key: string,
				token: string,
			): Promise<number> => {
				if (redisState.values.get(key) !== token) return 0;
				redisState.values.delete(key);
				return 1;
			},
		);

		exists = vi.fn(async (key: string) => (redisState.values.has(key) ? 1 : 0));
		ping = vi.fn(async () => 'PONG');
		quit = vi.fn(async () => 'OK');
		on = vi.fn(() => this);

		constructor() {
			redisState.instances.push(this);
		}
	}

	return { Redis };
});

const serviceId = '53178494';
const baseUrl = 'https://MassageIthaca.as.me';

const mockAcuityModules = () => {
	vi.doMock('../../adapters/acuity/steps/read-via-url.js', () => readViaUrlMocks);
	vi.doMock('../../adapters/acuity/steps/index.js', () => stepMocks);
};

const listen = async () => {
	const {
		server,
		__runEffectWithoutBrowserForTest,
		__setEffectRunnerForTest,
		__setAcuityStepOverridesForTest,
		__setBridgeAsyncStoreForTest,
	} = await import('../handler.js');
	const store = createInMemoryBridgeAsyncStore();
	__setEffectRunnerForTest(__runEffectWithoutBrowserForTest);
	__setBridgeAsyncStoreForTest(store);
	__setAcuityStepOverridesForTest({
		readDatesViaUrl: readViaUrlMocks.readDatesViaUrl,
		readSlotsViaUrl: readViaUrlMocks.readSlotsViaUrl,
		readAvailableDates: stepMocks.readAvailableDates,
		readTimeSlots: stepMocks.readTimeSlots,
	});
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		server,
		store,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
};

const postAvailabilityDates = async (
	url: string,
	startDate: string,
	body: unknown = { serviceId, startDate },
): Promise<Response> =>
	fetch(`${url}/availability/dates`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

describe('POST /availability/dates cache prewarm', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		mockAcuityModules();
		vi.clearAllMocks();
		redisState.values.clear();
		redisState.instances.length = 0;

		process.env.ACUITY_BASE_URL = baseUrl;
		process.env.ACUITY_DATE_PREWARM_MONTHS = '1';
		process.env.ACUITY_SLOT_PREWARM_LIMIT = '0';
		process.env.REDIS_URL = 'redis://unit.test:6379';
		delete process.env.REDIS_PASSWORD;
		delete process.env.AUTH_TOKEN;

		readViaUrlMocks.readDatesViaUrl.mockImplementation(
			(_serviceId: string, targetMonth: string | undefined) =>
				Effect.succeed([{ date: `${targetMonth ?? 'current'}-15` }]),
		);
	});

	afterEach(async () => {
		if (activeServer?.listening) {
			await new Promise<void>((resolve, reject) => {
				activeServer!.close((error) => (error ? reject(error) : resolve()));
			});
		}
		activeServer = null;
		delete process.env.ACUITY_BASE_URL;
		delete process.env.ACUITY_DATE_PREWARM_MONTHS;
		delete process.env.ACUITY_SLOT_PREWARM_LIMIT;
		delete process.env.REDIS_URL;
		delete process.env.REDIS_PASSWORD;
		delete process.env.AUTH_TOKEN;
	});

	it('queues the next month after a successful date request', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await postAvailabilityDates(running.baseUrl, '2026-07-01');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			data: [{ date: '2026-07-15' }],
		});

		await new Promise((resolve) => setImmediate(resolve));
		expect(readViaUrlMocks.readDatesViaUrl).toHaveBeenCalledWith(
			serviceId,
			'2026-07',
		);
		expect(readViaUrlMocks.readDatesViaUrl).not.toHaveBeenCalledWith(
			serviceId,
			'2026-08',
		);
		await expect(running.store.listReadyJobs(10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					command: expect.objectContaining({
						serviceId,
						month: '2026-08',
					}),
				}),
			]),
		);
		expect(
			redisState.values.get(
				`bridge-read:v2:dates:${baseUrl}:${serviceId}:2026-08`,
			),
		).toBeUndefined();
	});

	it('serves a cached month from Redis and queues the following month', async () => {
		redisState.values.set(
			`bridge-read:v2:dates:${baseUrl}:${serviceId}:2026-08`,
			JSON.stringify([{ date: '2026-08-15' }]),
		);
		const running = await listen();
		activeServer = running.server;

		const response = await postAvailabilityDates(running.baseUrl, '2026-08-01');

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			data: [{ date: '2026-08-15' }],
		});
		expect(readViaUrlMocks.readDatesViaUrl).not.toHaveBeenCalledWith(
			serviceId,
			'2026-08',
		);
		await new Promise((resolve) => setImmediate(resolve));
		await expect(running.store.listReadyJobs(10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					command: expect.objectContaining({
						serviceId,
						month: '2026-09',
					}),
				}),
			]),
		);
	});

	it('rejects missing service id before cache lookup or Acuity reads', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await postAvailabilityDates(
			running.baseUrl,
			'2026-07-01',
			{ startDate: '2026-07-01' },
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			success: false,
			error: {
				tag: 'ValidationError',
				code: 'serviceId',
			},
		});
		expect(readViaUrlMocks.readDatesViaUrl).not.toHaveBeenCalled();
	});

	it('surfaces Acuity date-read failures without caching them as empty results', async () => {
		readViaUrlMocks.readDatesViaUrl.mockImplementationOnce(() =>
			Effect.fail(new BrowserError({ reason: 'PAGE_FAILED' })),
		);
		const running = await listen();
		activeServer = running.server;

		const response = await postAvailabilityDates(running.baseUrl, '2026-07-01');

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'NETWORK',
			},
		});
		expect(
			redisState.values.get(
				`bridge-read:v2:dates:${baseUrl}:${serviceId}:2026-07`,
			),
		).toBeUndefined();
	});
});
