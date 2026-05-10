import { describe, expect, it } from 'vitest';
import { createInMemoryBridgeAsyncStore } from './store.js';
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

describe('BridgeAsyncStore in-memory contract', () => {
	it('deduplicates enqueue by idempotency key', async () => {
		const store = createInMemoryBridgeAsyncStore();

		const first = await store.enqueueJob(datesJob, {
			idempotencyKey: 'dates:53178494:2026-06',
		});
		const second = await store.enqueueJob(datesJob, {
			idempotencyKey: 'dates:53178494:2026-06',
		});

		expect(second.operationId).toBe(first.operationId);
		expect(second.status).toBe('queued');
	});

	it('returns expired leased jobs as ready work', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const job = await store.enqueueJob(datesJob);
		await store.markJobRunning(job.operationId, {
			workerId: 'worker-a',
			leasedUntil: new Date('2026-05-08T12:00:00.000Z'),
		});

		const notReady = await store.listReadyJobs(
			10,
			new Date('2026-05-08T11:59:00.000Z'),
		);
		const ready = await store.listReadyJobs(
			10,
			new Date('2026-05-08T12:00:01.000Z'),
		);

		expect(notReady).toHaveLength(0);
		expect(ready).toHaveLength(1);
		expect(ready[0]?.operationId).toBe(job.operationId);
	});

	it('reports queue stats for readiness gates', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const queued = await store.enqueueJob(datesJob);
		const running = await store.enqueueJob({
			kind: 'availability_slots_refresh',
			command: {
				serviceId: '53178494',
				date: '2026-06-15',
				adapterProfile: profile,
			},
		});
		await store.markJobRunning(running.operationId, {
			workerId: 'worker-a',
			leasedUntil: new Date('2026-05-08T12:00:00.000Z'),
		});
		const failed = await store.enqueueJob({
			kind: 'availability_slots_refresh',
			command: {
				serviceId: '53178494',
				date: '2026-06-16',
				adapterProfile: profile,
			},
		});
		await store.failJob(failed.operationId, {
			status: 'failed_pre_submit',
			code: 'NETWORK',
			message: 'temporary browser failure',
			retryable: true,
		});

		const stats = await store.getQueueStats(
			new Date('2026-05-08T12:00:01.000Z'),
		);

		expect(stats).toMatchObject({
			total: 3,
			ready: 2,
			retryableFailed: 1,
		});
		expect(stats.failedRefreshes).toEqual([{
			kind: 'availability_slots_refresh',
			status: 'failed_pre_submit',
			serviceId: '53178494',
			scope: '2026-06-16',
			code: 'NETWORK',
			retryable: true,
			count: 1,
			oldestAgeMs: expect.any(Number),
		}]);
		expect(stats.oldestQueuedAgeMs).toBeGreaterThanOrEqual(0);
		expect(stats.byKindStatus).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'availability_dates_refresh',
					status: 'queued',
					count: 1,
				}),
				expect.objectContaining({
					kind: 'availability_slots_refresh',
					status: 'running',
					count: 1,
				}),
				expect.objectContaining({
					kind: 'availability_slots_refresh',
					status: 'failed_pre_submit',
					count: 1,
				}),
			]),
		);
		expect(queued.status).toBe('queued');
	});

	it('versions availability snapshots per service and scope', async () => {
		const store = createInMemoryBridgeAsyncStore();

		const first = await store.upsertAvailabilitySnapshot({
			kind: 'dates',
			serviceId: '53178494',
			scope: '2026-06',
			adapterProfile: profile,
			value: [{ date: '2026-06-15' }],
			observedAt: '2026-05-08T12:00:00.000Z',
			staleAt: '2026-05-08T12:05:00.000Z',
			expiresAt: '2026-05-08T12:30:00.000Z',
		});
		const second = await store.upsertAvailabilitySnapshot({
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
			store.getAvailabilitySnapshot({
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
});
