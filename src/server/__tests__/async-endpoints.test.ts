import { type AddressInfo } from 'node:net';
import IORedisMock from 'ioredis-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';

const service = {
	id: '53178494',
	name: 'TMD single session',
	duration: 30,
	price: 10500,
	currency: 'USD',
	category: 'TMD',
	description: 'TMD appointment',
};

const bookingRequest = {
	serviceId: service.id,
	datetime: '2026-06-15T16:00:00.000Z',
	client: {
		firstName: 'Jess',
		lastName: 'Sullivan',
		email: 'jess@example.com',
		phone: '6075551212',
	},
};

const listen = async (store = createInMemoryBridgeAsyncStore()) => {
	const {
		server,
		__setBridgeAsyncStoreForTest,
		__setEffectRunnerForTest,
	} = await import('../handler.js');
	__setBridgeAsyncStoreForTest(store);
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	return {
		server,
		store,
		baseUrl: `http://127.0.0.1:${address.port}`,
		setEffectRunnerForTest: __setEffectRunnerForTest,
	};
};

describe('bridge async protocol endpoints', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		process.env.ACUITY_BASE_URL = 'https://example.as.me';
		process.env.SERVICES_JSON = JSON.stringify([service]);
		process.env.ACUITY_BYPASS_COUPON = 'TEST-100';
		delete process.env.REDIS_URL;
		delete process.env.AUTH_TOKEN;
	});

	afterEach(async () => {
		if (activeServer?.listening) {
			await new Promise<void>((resolve, reject) => {
				activeServer!.close((error) => (error ? reject(error) : resolve()));
			});
		}
		activeServer = null;
		delete process.env.ACUITY_BASE_URL;
		delete process.env.SERVICES_JSON;
		delete process.env.ACUITY_BYPASS_COUPON;
		delete process.env.ACUITY_DATE_PREWARM_MONTHS;
		delete process.env.ACUITY_SLOT_PREWARM_LIMIT;
		vi.doUnmock('ioredis');
	});

	it('enqueues paid booking commands without running browser automation in the request', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(`${running.baseUrl}/booking/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				request: bookingRequest,
				paymentRef: 'pi_test_123',
				paymentProcessor: 'stripe',
				idempotencyKey: 'booking:pi_test_123',
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body).toMatchObject({
			success: true,
			data: {
				status: 'queued',
				statusUrl: expect.stringMatching(/^\/jobs\//),
			},
		});

		const operationId = body.data.operationId as string;
		const statusResponse = await fetch(`${running.baseUrl}/jobs/${operationId}`);
		const statusBody = await statusResponse.json();

		expect(statusResponse.status).toBe(200);
		expect(statusBody).toMatchObject({
			success: true,
			data: {
				operationId,
				kind: 'booking_create_with_payment',
				status: 'queued',
				command: {
					paymentRef: 'pi_test_123',
					paymentProcessor: 'stripe',
					couponCode: 'TEST-100',
					serviceName: service.name,
					couponBypassRequired: true,
					executionPreference: 'auto',
					adapterProfile: {
						backend: 'acuity',
						baseUrl: 'https://example.as.me',
					},
				},
			},
		});
	});

	it('deduplicates async booking enqueue by idempotency key', async () => {
		const running = await listen();
		activeServer = running.server;
		const payload = {
			request: bookingRequest,
			paymentRef: 'pi_test_123',
			paymentProcessor: 'stripe',
			idempotencyKey: 'booking:pi_test_123',
		};

		const first = await fetch(`${running.baseUrl}/booking/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}).then((response) => response.json());
		const second = await fetch(`${running.baseUrl}/booking/jobs`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		}).then((response) => response.json());

		expect(second.data.operationId).toBe(first.data.operationId);
	});

	it('returns stored availability snapshots without scraping on the request path', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: service.id,
			scope: '2026-06',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ date: '2026-06-15' }],
			observedAt: '2026-05-08T12:00:00.000Z',
			staleAt: '2026-05-08T12:05:00.000Z',
			expiresAt: '2026-05-08T12:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/availability/snapshot?kind=dates&serviceId=${service.id}&scope=2026-06`,
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: {
				kind: 'dates',
				serviceId: service.id,
				scope: '2026-06',
				value: [{ date: '2026-06-15' }],
			},
		});
	});

	it('queues availability prewarm jobs instead of running prewarm browser work on the request path', async () => {
		vi.doMock('ioredis', () => ({
			Redis: IORedisMock,
			default: IORedisMock,
		}));
		process.env.REDIS_URL = 'redis://localhost:6379/0';
		process.env.ACUITY_DATE_PREWARM_MONTHS = '1';
		process.env.ACUITY_SLOT_PREWARM_LIMIT = '1';
		const store = createInMemoryBridgeAsyncStore();
		const running = await listen(store);
		activeServer = running.server;
		running.setEffectRunnerForTest(async () => ({
			ok: true,
			value: [{ date: '2026-06-15' }],
		}));

		const response = await fetch(`${running.baseUrl}/availability/dates`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				serviceId: service.id,
				serviceName: service.name,
				startDate: '2026-06-01',
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: [{ date: '2026-06-15' }],
		});

		await new Promise((resolve) => setImmediate(resolve));
		const readyJobs = await store.listReadyJobs(10);

		expect(readyJobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					command: expect.objectContaining({
						serviceId: service.id,
						month: '2026-07',
					}),
				}),
				expect.objectContaining({
					kind: 'availability_slots_refresh',
					command: expect.objectContaining({
						serviceId: service.id,
						date: '2026-06-15',
					}),
				}),
			]),
		);
	});
});
