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
	const { server, __setBridgeAsyncStoreForTest, __setEffectRunnerForTest } =
		await import('../handler.js');
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
		const statusResponse = await fetch(
			`${running.baseUrl}/jobs/${operationId}`,
		);
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

	it('serves fresh date snapshots on the availability request path', async () => {
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
			observedAt: '2999-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;
		const runner = vi.fn(async () => ({
			ok: false as const,
			error: {
				_tag: 'InfrastructureError' as const,
				code: 'UNEXPECTED_BROWSER_READ',
				message: 'browser read should not run',
			},
		}));
		running.setEffectRunnerForTest(runner);

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
		expect(runner).not.toHaveBeenCalled();
	});

	it('serves stale slot snapshots and queues async refresh', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: service.id,
			scope: '2026-06-15',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ time: '4:00 PM', datetime: '2026-06-15T16:00:00-04:00' }],
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2000-01-01T00:01:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;
		const runner = vi.fn(async () => ({
			ok: false as const,
			error: {
				_tag: 'InfrastructureError' as const,
				code: 'UNEXPECTED_BROWSER_READ',
				message: 'browser read should not run',
			},
		}));
		running.setEffectRunnerForTest(runner);

		const response = await fetch(`${running.baseUrl}/availability/slots`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				serviceId: service.id,
				serviceName: service.name,
				date: '2026-06-15',
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: [{ time: '4:00 PM', datetime: '2026-06-15T16:00:00-04:00' }],
		});
		expect(runner).not.toHaveBeenCalled();

		await new Promise((resolve) => setImmediate(resolve));
		await expect(store.listReadyJobs(10)).resolves.toEqual(
			expect.arrayContaining([
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

	it('hides the internal snapshot canary unless bridge auth is configured', async () => {
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
			observedAt: '2999-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/snapshot-canary?kind=dates&serviceId=${service.id}&scope=2026-06`,
		);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			success: false,
			error: {
				code: 'NOT_FOUND',
			},
		});
	});

	it('hides the internal availability heartbeat unless bridge auth is configured', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/heartbeat`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					demands: [{ serviceId: service.id, months: ['2026-06'] }],
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body).toMatchObject({
			success: false,
			error: {
				code: 'NOT_FOUND',
			},
		});
	});

	it('hides internal availability readiness unless bridge auth is configured', async () => {
		const running = await listen();
		activeServer = running.server;

		for (const path of [
			'/internal/availability/readiness',
			'/internal/availability/wait-ready',
		]) {
			const response = await fetch(`${running.baseUrl}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					demands: [{ serviceId: service.id, months: ['2026-06'] }],
				}),
			});
			const body = await response.json();

			expect(response.status).toBe(404);
			expect(body).toMatchObject({
				success: false,
				error: {
					code: 'NOT_FOUND',
				},
			});
		}
	});

	it('reports availability readiness without mutating the queue', async () => {
		process.env.AUTH_TOKEN = 'readiness-token';
		const store = createInMemoryBridgeAsyncStore();
		const unrelated = await store.enqueueJob({
			kind: 'booking_create_with_payment',
			command: {
				request: bookingRequest,
				paymentRef: 'pi_unrelated_retry',
				paymentProcessor: 'stripe',
				adapterProfile: {
					backend: 'acuity',
					baseUrl: 'https://example.as.me',
				},
				couponBypassRequired: true,
				executionPreference: 'auto',
			},
		});
		await store.failJob(unrelated.operationId, {
			status: 'failed_pre_submit',
			code: 'UNRELATED_RETRYABLE',
			message: 'old unrelated retryable failure',
			retryable: true,
		});
		await store.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: service.id,
			scope: '2026-06',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ date: '2026-06-15' }],
			observedAt: '2999-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		await store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: service.id,
			scope: '2026-06-15',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ time: '4:00 PM', datetime: '2026-06-15T16:00:00-04:00' }],
			observedAt: '2999-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/readiness`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer readiness-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					demands: [
						{
							serviceId: service.id,
							serviceName: service.name,
							weight: 10,
							months: ['2026-06'],
							dates: ['2026-06-15'],
						},
					],
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: {
				layer: 'bridge_availability_readiness',
				ready: true,
				considered: 2,
				policy: {
					snapshotFreshnessFloorMs: 90_000,
					maxOldestQueuedAgeMs: 120_000,
				},
				scopes: [
					expect.objectContaining({
						kind: 'dates',
						serviceId: service.id,
						scope: '2026-06',
						freshness: 'fresh',
						ready: true,
						valueCount: 1,
					}),
					expect.objectContaining({
						kind: 'slots',
						serviceId: service.id,
						scope: '2026-06-15',
						freshness: 'fresh',
						ready: true,
						valueCount: 1,
					}),
				],
				queue: {
					total: 1,
					ready: 0,
					retryableFailed: 1,
				},
				blockers: [],
			},
		});
		await expect(store.listReadyJobs(10)).resolves.toEqual([]);
	});

	it('marks missing readiness scopes as not ready and leaves heartbeat to wait-ready', async () => {
		process.env.AUTH_TOKEN = 'readiness-token';
		const store = createInMemoryBridgeAsyncStore();
		const running = await listen(store);
		activeServer = running.server;
		const payload = {
			demands: [
				{
					serviceId: service.id,
					serviceName: service.name,
					months: ['2026-06'],
					dates: ['2026-06-15'],
				},
			],
		};

		const readinessResponse = await fetch(
			`${running.baseUrl}/internal/availability/readiness`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer readiness-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(payload),
			},
		);
		const readiness = await readinessResponse.json();

		expect(readinessResponse.status).toBe(409);
		expect(readiness.data).toMatchObject({
			ready: false,
			scopes: [
				expect.objectContaining({
					kind: 'dates',
					freshness: 'missing',
					ready: false,
				}),
				expect.objectContaining({
					kind: 'slots',
					freshness: 'missing',
					ready: false,
				}),
			],
			blockers: expect.arrayContaining([
				`dates:${service.id}:2026-06:missing`,
				`slots:${service.id}:2026-06-15:missing`,
			]),
		});
		await expect(store.listReadyJobs(10)).resolves.toEqual([]);

		const waitResponse = await fetch(
			`${running.baseUrl}/internal/availability/wait-ready`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer readiness-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					...payload,
					timeoutMs: 1,
					pollMs: 1,
					idempotencyKeyPrefix: 'test-wait-ready',
				}),
			},
		);
		const waitBody = await waitResponse.json();

		expect(waitResponse.status).toBe(409);
		expect(waitBody).toMatchObject({
			success: true,
			data: {
				layer: 'bridge_availability_wait_ready',
				ready: false,
				timedOut: true,
				heartbeat: {
					layer: 'bridge_availability_heartbeat',
					enqueued: [
						expect.objectContaining({
							kind: 'dates',
							scope: '2026-06',
							freshness: 'missing',
						}),
						expect.objectContaining({
							kind: 'slots',
							scope: '2026-06-15',
							freshness: 'missing',
						}),
					],
				},
				readiness: {
					ready: false,
				},
			},
		});
		await expect(store.listReadyJobs(10)).resolves.toHaveLength(2);
	});

	it('uses the readiness freshness floor when wait-ready schedules heartbeat work', async () => {
		process.env.AUTH_TOKEN = 'readiness-token';
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
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/wait-ready`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer readiness-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					demands: [{ serviceId: service.id, months: ['2026-06'] }],
					maxJobs: 1,
					timeoutMs: 1,
					pollMs: 1,
					snapshotFreshnessFloorMs: 90_000,
					idempotencyKeyPrefix: 'test-readiness-floor',
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.data.heartbeat.enqueued).toMatchObject([
			{
				action: expect.stringMatching(/^(queued|deduped)$/),
				kind: 'dates',
				serviceId: service.id,
				scope: '2026-06',
				freshness: 'stale',
			},
		]);
		await expect(store.listReadyJobs(10)).resolves.toMatchObject([
			{
				kind: 'availability_dates_refresh',
				status: 'queued',
			},
		]);
	});

	it('requeues stale terminal heartbeat work inside the same idempotency window', async () => {
		process.env.AUTH_TOKEN = 'readiness-token';
		const store = createInMemoryBridgeAsyncStore();
		const idempotencyWindowMs = 60_000;
		const bucket = Math.floor(Date.now() / idempotencyWindowMs);
		const idempotencyKey = [
			'test-terminal-refresh',
			'https://example.as.me',
			'dates',
			service.id,
			'2026-06',
			bucket,
		].join(':');
		const existing = await store.enqueueJob(
			{
				kind: 'availability_dates_refresh',
				command: {
					serviceId: service.id,
					serviceName: service.name,
					month: '2026-06',
					adapterProfile: {
						backend: 'acuity',
						baseUrl: 'https://example.as.me',
					},
				},
			},
			{ idempotencyKey },
		);
		await store.completeJob(existing.operationId, {
			kind: 'availability_dates_refresh',
			dates: [{ date: '2026-06-15' }],
		});
		await store.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: service.id,
			scope: '2026-06',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ date: '2026-06-15' }],
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/wait-ready`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer readiness-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					demands: [{ serviceId: service.id, months: ['2026-06'] }],
					maxJobs: 1,
					timeoutMs: 1,
					pollMs: 1,
					idempotencyWindowMs,
					snapshotFreshnessFloorMs: 90_000,
					idempotencyKeyPrefix: 'test-terminal-refresh',
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.data.heartbeat.enqueued).toMatchObject([
			{
				operationId: existing.operationId,
				action: expect.stringMatching(/^(requeued|deduped)$/),
				kind: 'dates',
				serviceId: service.id,
				scope: '2026-06',
				freshness: 'stale',
			},
		]);
		await expect(store.getJob(existing.operationId)).resolves.toMatchObject({
			status: 'queued',
		});
	});

	it('auth-gates the internal snapshot canary and records durable snapshot layer metrics', async () => {
		process.env.AUTH_TOKEN = 'canary-token';
		const store = createInMemoryBridgeAsyncStore();
		await store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: service.id,
			scope: '2026-06-15',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ time: '4:00 PM', datetime: '2026-06-15T16:00:00-04:00' }],
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2000-01-01T00:01:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;
		const { metrics } = await import('../../shared/metrics.js');
		const metricCount = async (
			metricName: string,
			labels: Record<string, string>,
		): Promise<number> => {
			const metric = metrics.registry.getSingleMetric(metricName);
			const snap = await metric?.get();
			const countName = `${metricName}_count`;
			return (
				snap?.values.find((v) => {
					if (v.metricName !== countName) return false;
					return Object.entries(labels).every(
						([key, value]) => v.labels[key] === value,
					);
				})?.value ?? 0
			);
		};
		const snapshotServedCount = async (): Promise<number> => {
			const snap = await metrics.availabilitySnapshotServedTotal.get();
			return (
				snap.values.find(
					(v) => v.labels.kind === 'slots' && v.labels.freshness === 'stale',
				)?.value ?? 0
			);
		};
		const durationBefore = await metricCount(
			'acuity_availability_snapshot_read_duration_seconds',
			{
				kind: 'slots',
				freshness: 'stale',
				outcome: 'hit',
			},
		);
		const servedBefore = await snapshotServedCount();
		const url = `${running.baseUrl}/internal/availability/snapshot-canary?kind=slots&serviceId=${service.id}&scope=2026-06-15`;

		const unauthorized = await fetch(url);
		expect(unauthorized.status).toBe(401);

		const response = await fetch(url, {
			headers: {
				Authorization: 'Bearer canary-token',
			},
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: {
				layer: 'bridge_durable_snapshot',
				kind: 'slots',
				serviceId: service.id,
				scope: '2026-06-15',
				freshness: 'stale',
				valueCount: 1,
				refreshQueued: false,
				metrics: {
					servedCounter: {
						name: 'acuity_availability_snapshot_served_total',
					},
					durationHistogram: {
						name: 'acuity_availability_snapshot_read_duration_seconds',
					},
				},
			},
		});
		expect(typeof body.data.durationMs).toBe('number');
		expect(await snapshotServedCount()).toBe(servedBefore + 1);
		expect(
			await metricCount('acuity_availability_snapshot_read_duration_seconds', {
				kind: 'slots',
				freshness: 'stale',
				outcome: 'hit',
			}),
		).toBe(durationBefore + 1);
		await expect(store.listReadyJobs(10)).resolves.toEqual([]);
	});

	it('enqueues weighted heartbeat refresh jobs without refreshing fresh snapshots', async () => {
		process.env.AUTH_TOKEN = 'heartbeat-token';
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
			observedAt: '2999-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		await store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: service.id,
			scope: '2026-06-15',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ time: '4:00 PM', datetime: '2026-06-15T16:00:00-04:00' }],
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2000-01-01T00:01:00.000Z',
			expiresAt: '2000-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;
		const url = `${running.baseUrl}/internal/availability/heartbeat`;
		const payload = {
			maxJobs: 2,
			idempotencyWindowMs: 60_000,
			idempotencyKeyPrefix: 'test-heartbeat',
			demands: [
				{
					serviceId: service.id,
					serviceName: service.name,
					weight: 10,
					months: ['2026-06', '2026-07'],
					dates: ['2026-06-15'],
				},
				{
					serviceId: service.id,
					weight: 1,
					months: ['2026-08'],
				},
			],
		};

		const unauthorized = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		expect(unauthorized.status).toBe(401);

		const firstResponse = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const first = await firstResponse.json();

		expect(firstResponse.status).toBe(202);
		expect(first).toMatchObject({
			success: true,
			data: {
				layer: 'bridge_availability_heartbeat',
				considered: 4,
				maxJobs: 2,
				idempotencyWindowMs: 60_000,
				enqueued: [
					{
						kind: 'dates',
						serviceId: service.id,
						scope: '2026-08',
						freshness: 'missing',
						weight: 1,
					},
					{
						kind: 'dates',
						serviceId: service.id,
						scope: '2026-07',
						freshness: 'missing',
						weight: 10,
					},
				],
				skipped: expect.arrayContaining([
					expect.objectContaining({
						kind: 'dates',
						serviceId: service.id,
						scope: '2026-06',
						reason: 'fresh',
						freshness: 'fresh',
					}),
					expect.objectContaining({
						kind: 'slots',
						serviceId: service.id,
						scope: '2026-06-15',
						reason: 'limit',
						weight: 10,
					}),
				]),
			},
		});

		const readyJobs = await store.listReadyJobs(10);
		expect(readyJobs).toHaveLength(2);
		expect(readyJobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat:https://example.as.me:dates:53178494:2026-08:',
					),
				}),
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat:https://example.as.me:dates:53178494:2026-07:',
					),
				}),
			]),
		);

		const secondResponse = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const second = await secondResponse.json();

		expect(secondResponse.status).toBe(202);
		expect(second.data.enqueued).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					operationId: first.data.enqueued[0].operationId,
					action: 'deduped',
					kind: 'dates',
					scope: '2026-08',
				}),
				expect.objectContaining({
					operationId: first.data.enqueued[1].operationId,
					action: 'deduped',
					kind: 'dates',
					scope: '2026-07',
				}),
				expect.objectContaining({
					action: 'queued',
					kind: 'slots',
					scope: '2026-06-15',
				}),
			]),
		);
		await expect(store.listReadyJobs(10)).resolves.toHaveLength(3);
	});

	it('uses the readiness freshness floor for normal heartbeat scheduling', async () => {
		process.env.AUTH_TOKEN = 'heartbeat-token';
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
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2999-01-01T00:05:00.000Z',
			expiresAt: '2999-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/availability/heartbeat`,
			{
				method: 'POST',
				headers: {
					Authorization: 'Bearer heartbeat-token',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					maxJobs: 1,
					idempotencyKeyPrefix: 'test-heartbeat-readiness-floor',
					demands: [{ serviceId: service.id, months: ['2026-06'] }],
				}),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body.data.enqueued).toMatchObject([
			{
				kind: 'dates',
				serviceId: service.id,
				scope: '2026-06',
				freshness: 'stale',
			},
		]);
		await expect(store.listReadyJobs(10)).resolves.toMatchObject([
			{
				kind: 'availability_dates_refresh',
				status: 'queued',
			},
		]);
	});

	it('requeues retryable heartbeat idempotency hits instead of reporting failed records as enqueued', async () => {
		process.env.AUTH_TOKEN = 'heartbeat-token';
		const store = createInMemoryBridgeAsyncStore();
		const running = await listen(store);
		activeServer = running.server;
		const url = `${running.baseUrl}/internal/availability/heartbeat`;
		const payload = {
			maxJobs: 1,
			idempotencyWindowMs: 60_000,
			idempotencyKeyPrefix: 'test-heartbeat-retry',
			demands: [
				{
					serviceId: 'svc-retry',
					serviceName: 'Retryable service',
					weight: 10,
					months: ['2026-06'],
				},
			],
		};

		const firstResponse = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const first = await firstResponse.json();
		const operationId = first.data.enqueued[0].operationId as string;

		expect(firstResponse.status).toBe(202);
		expect(first.data.enqueued).toMatchObject([
			{
				operationId,
				status: 'queued',
				action: 'queued',
				kind: 'dates',
				serviceId: 'svc-retry',
				scope: '2026-06',
			},
		]);

		await store.failJob(operationId, {
			status: 'failed_pre_submit',
			code: 'NETWORK',
			message: 'Browser error: PAGE_FAILED',
			step: 'refresh-availability-dates',
			retryable: true,
		});

		const retryResponse = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const retry = await retryResponse.json();

		expect(retryResponse.status).toBe(202);
		expect(retry.data.enqueued).toMatchObject([
			{
				operationId,
				status: 'queued',
				action: 'requeued',
				kind: 'dates',
				serviceId: 'svc-retry',
				scope: '2026-06',
			},
		]);
		await expect(store.listReadyJobs(10)).resolves.toMatchObject([
			{
				operationId,
				status: 'queued',
			},
		]);

		await store.failJob(operationId, {
			status: 'failed_pre_submit',
			code: 'PAYMENT_BYPASS_NOT_PROVEN',
			message: 'Non-retryable failure',
			step: 'bypass-payment',
			retryable: false,
		});

		const terminalResponse = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload),
		});
		const terminal = await terminalResponse.json();

		expect(terminalResponse.status).toBe(202);
		expect(terminal.data.enqueued).toEqual([]);
		expect(terminal.data.skipped).toEqual([
			expect.objectContaining({
				operationId,
				reason: 'terminal',
				status: 'failed_pre_submit',
				kind: 'dates',
				serviceId: 'svc-retry',
				scope: '2026-06',
			}),
		]);
		await expect(store.listReadyJobs(10)).resolves.toHaveLength(0);
	});

	it('fairly interleaves equal-priority heartbeat demand across services', async () => {
		process.env.AUTH_TOKEN = 'heartbeat-token';
		const store = createInMemoryBridgeAsyncStore();
		const running = await listen(store);
		activeServer = running.server;
		const url = `${running.baseUrl}/internal/availability/heartbeat`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				maxJobs: 4,
				idempotencyWindowMs: 60_000,
				idempotencyKeyPrefix: 'test-heartbeat-fairness',
				demands: [
					{
						serviceId: 'svc-a',
						weight: 10,
						months: ['2026-06', '2026-07', '2026-08'],
					},
					{
						serviceId: 'svc-b',
						weight: 10,
						months: ['2026-06', '2026-07', '2026-08'],
					},
					{
						serviceId: 'svc-c',
						weight: 10,
						months: ['2026-06', '2026-07', '2026-08'],
					},
				],
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body.data.enqueued).toMatchObject([
			{ kind: 'dates', serviceId: 'svc-a', scope: '2026-06' },
			{ kind: 'dates', serviceId: 'svc-b', scope: '2026-06' },
			{ kind: 'dates', serviceId: 'svc-c', scope: '2026-06' },
			{ kind: 'dates', serviceId: 'svc-a', scope: '2026-07' },
		]);
		expect(body.data.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					serviceId: 'svc-b',
					scope: '2026-07',
					reason: 'limit',
				}),
				expect.objectContaining({
					serviceId: 'svc-c',
					scope: '2026-07',
					reason: 'limit',
				}),
				expect.objectContaining({
					serviceId: 'svc-a',
					scope: '2026-08',
					reason: 'limit',
				}),
			]),
		);
		await expect(store.listReadyJobs(10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat-fairness:https://example.as.me:dates:svc-b:2026-06:',
					),
				}),
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat-fairness:https://example.as.me:dates:svc-c:2026-06:',
					),
				}),
			]),
		);
	});

	it('prevents high-weight heartbeat demand from monopolizing the enqueue budget', async () => {
		process.env.AUTH_TOKEN = 'heartbeat-token';
		const store = createInMemoryBridgeAsyncStore();
		const running = await listen(store);
		activeServer = running.server;
		const url = `${running.baseUrl}/internal/availability/heartbeat`;

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				Authorization: 'Bearer heartbeat-token',
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				maxJobs: 4,
				idempotencyWindowMs: 60_000,
				idempotencyKeyPrefix: 'test-heartbeat-weighted-fairness',
				demands: [
					{
						serviceId: 'svc-high',
						weight: 10,
						months: ['2026-06', '2026-07', '2026-08', '2026-09'],
					},
					{
						serviceId: 'svc-low-a',
						weight: 1,
						months: ['2026-06', '2026-07'],
					},
					{
						serviceId: 'svc-low-b',
						weight: 1,
						months: ['2026-06'],
					},
				],
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(202);
		expect(body.data.enqueued).toMatchObject([
			{ kind: 'dates', serviceId: 'svc-high', scope: '2026-06', weight: 10 },
			{ kind: 'dates', serviceId: 'svc-low-a', scope: '2026-06', weight: 1 },
			{ kind: 'dates', serviceId: 'svc-low-b', scope: '2026-06', weight: 1 },
			{ kind: 'dates', serviceId: 'svc-high', scope: '2026-07', weight: 10 },
		]);
		expect(body.data.skipped).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					serviceId: 'svc-high',
					scope: '2026-08',
					reason: 'limit',
				}),
				expect.objectContaining({
					serviceId: 'svc-low-a',
					scope: '2026-07',
					reason: 'limit',
				}),
			]),
		);
		await expect(store.listReadyJobs(10)).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat-weighted-fairness:https://example.as.me:dates:svc-low-a:2026-06:',
					),
				}),
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					idempotencyKey: expect.stringContaining(
						'test-heartbeat-weighted-fairness:https://example.as.me:dates:svc-low-b:2026-06:',
					),
				}),
			]),
		);
	});

	it('ignores expired request-path snapshots and refreshes from Acuity', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: service.id,
			scope: '2026-08',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
			},
			value: [{ date: '2026-08-01' }],
			observedAt: '2000-01-01T00:00:00.000Z',
			staleAt: '2000-01-01T00:01:00.000Z',
			expiresAt: '2000-01-01T00:30:00.000Z',
		});
		const running = await listen(store);
		activeServer = running.server;
		const runner = vi.fn(async () => ({
			ok: true as const,
			value: [{ date: '2026-08-15' }],
		}));
		running.setEffectRunnerForTest(runner);

		const response = await fetch(`${running.baseUrl}/availability/dates`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				serviceId: service.id,
				serviceName: service.name,
				startDate: '2026-08-01',
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toMatchObject({
			success: true,
			data: [{ date: '2026-08-15' }],
		});
		expect(runner).toHaveBeenCalledTimes(1);
		await expect(
			store.getAvailabilitySnapshot({
				kind: 'dates',
				serviceId: service.id,
				scope: '2026-08',
				baseUrl: 'https://example.as.me',
			}),
		).resolves.toMatchObject({
			value: [{ date: '2026-08-15' }],
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
