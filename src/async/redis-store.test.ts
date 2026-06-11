import IORedisMock from 'ioredis-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createRedisBridgeAsyncStore } from './redis-store.js';
import type { BridgeJobCommand } from './types.js';

const profile = {
	backend: 'acuity' as const,
	baseUrl: 'https://example.as.me',
};

const datesJob: BridgeJobCommand = {
	kind: 'availability_dates_refresh',
	command: {
		serviceId: '53178494',
		month: '2026-06',
		adapterProfile: profile,
	},
};

const createStore = (redis: IORedisMock) =>
	createRedisBridgeAsyncStore({
		client: redis as never,
		keyPrefix: `test-bridge-async:${Date.now()}:${Math.random()}`,
	});

describe('RedisBridgeAsyncStore', () => {
	let redis: IORedisMock;

	beforeEach(async () => {
		redis = new IORedisMock();
		await redis.flushall();
	});

	it('deduplicates enqueue by idempotency key across store instances', async () => {
		const firstStore = createStore(redis);
		const secondStore = createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix: 'test-bridge-async:dedupe',
		});
		const thirdStore = createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix: 'test-bridge-async:dedupe',
		});
		await firstStore.clear?.();

		const first = await secondStore.enqueueJob(datesJob, {
			idempotencyKey: 'dates:53178494:2026-06',
		});
		const second = await thirdStore.enqueueJob(datesJob, {
			idempotencyKey: 'dates:53178494:2026-06',
		});

		expect(second.operationId).toBe(first.operationId);
		expect(second.status).toBe('queued');
	});

	it('leases a queued job to only one worker and re-exposes expired leases', async () => {
		const store = createStore(redis);
		const job = await store.enqueueJob(datesJob);
		const leasedUntil = new Date(Date.now() + 60_000);

		const leaseA = await store.markJobRunning(job.operationId, {
			workerId: 'worker-a',
			leasedUntil,
		});
		const leaseB = await store.markJobRunning(job.operationId, {
			workerId: 'worker-b',
			leasedUntil,
		});

		expect(leaseA).toMatchObject({
			operationId: job.operationId,
			status: 'running',
			leasedBy: 'worker-a',
		});
		expect(leaseB).toBeNull();

		await expect(
			store.listReadyJobs(10, new Date(leasedUntil.getTime() - 1000)),
		).resolves.toHaveLength(0);
		await expect(
			store.listReadyJobs(10, new Date(leasedUntil.getTime() + 1000)),
		).resolves.toMatchObject([{ operationId: job.operationId }]);
	});

	it('stores versioned snapshots shared across store instances', async () => {
		const keyPrefix = 'test-bridge-async:snapshots';
		const firstStore = createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix,
		});
		const secondStore = createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix,
		});
		await firstStore.clear?.();

		const first = await firstStore.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: '53178494',
			scope: '2026-06',
			adapterProfile: profile,
			value: [{ date: '2026-06-15' }],
			observedAt: '2026-05-08T12:00:00.000Z',
			staleAt: '2026-05-08T12:05:00.000Z',
			expiresAt: '2026-05-08T12:30:00.000Z',
		});
		const second = await secondStore.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: '53178494',
			scope: '2026-06',
			adapterProfile: profile,
			value: [{ date: '2026-06-16' }],
			observedAt: '2026-05-08T12:01:00.000Z',
			staleAt: '2026-05-08T12:06:00.000Z',
			expiresAt: '2026-05-08T12:31:00.000Z',
		});

		expect(second.snapshotId).toBe(first.snapshotId);
		expect(second.version).toBe(2);
		await expect(
			firstStore.getAvailabilitySnapshot({
				kind: 'dates',
				serviceId: '53178494',
				scope: '2026-06',
				baseUrl: profile.baseUrl,
			}),
		).resolves.toMatchObject({
			version: 2,
			value: [{ date: '2026-06-16' }],
		});
	});

	it('honors configured Redis job TTL for job and idempotency records', async () => {
		const keyPrefix = 'test-bridge-async:ttl';
		const store = createRedisBridgeAsyncStore({
			client: redis as never,
			keyPrefix,
			jobTtlSeconds: 30,
		});
		await store.clear?.();

		const job = await store.enqueueJob(datesJob, {
			idempotencyKey: 'dates:53178494:2026-06',
		});
		const jobTtlMs = await redis.pttl(`${keyPrefix}:job:${job.operationId}`);
		const idempotencyKeys = await redis.keys(`${keyPrefix}:idempotency:*`);
		const idempotencyTtlMs = await redis.pttl(idempotencyKeys[0] ?? '');

		expect(jobTtlMs).toBeGreaterThan(0);
		expect(jobTtlMs).toBeLessThanOrEqual(30_000);
		expect(idempotencyKeys).toHaveLength(1);
		expect(idempotencyTtlMs).toBeGreaterThan(0);
		expect(idempotencyTtlMs).toBeLessThanOrEqual(30_000);
	});

	it('reports failed refresh summaries without counting them as runnable work', async () => {
		const store = createStore(redis);
		const failed = await store.enqueueJob({
			kind: 'availability_slots_refresh',
			command: {
				serviceId: '53178494',
				date: '2026-06-15',
				adapterProfile: profile,
			},
		});
		await store.failJob(failed.operationId, {
			status: 'failed_pre_submit',
			code: 'NETWORK',
			message: 'Browser error: PAGE_FAILED',
			step: 'refresh-availability-slots',
			retryable: true,
		});

		const stats = await store.getQueueStats(
			new Date('2026-05-10T04:00:00.000Z'),
		);

		expect(stats.ready).toBe(0);
		expect(stats.retryableFailed).toBe(1);
		expect(stats.failedRefreshes).toEqual([{
			kind: 'availability_slots_refresh',
			status: 'failed_pre_submit',
			serviceId: '53178494',
			scope: '2026-06-15',
			code: 'NETWORK',
			step: 'refresh-availability-slots',
			retryable: true,
			count: 1,
			oldestAgeMs: expect.any(Number),
		}]);
	});
});
