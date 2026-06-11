import { randomUUID } from 'node:crypto';
import type {
	AvailabilitySnapshot,
	AvailabilitySnapshotQuery,
	BridgeJobCommand,
	BridgeJobFailure,
	BridgeJobRecord,
	BridgeJobResult,
	BridgeQueueStats,
	EnqueueBridgeJobOptions,
} from './types.js';
import { queueStatsFromJobs } from './queue-stats.js';

export interface BridgeAsyncStore {
	enqueueJob(
		job: BridgeJobCommand,
		options?: EnqueueBridgeJobOptions,
	): Promise<BridgeJobRecord>;
	getJob(operationId: string): Promise<BridgeJobRecord | null>;
	listReadyJobs(limit: number, now?: Date): Promise<readonly BridgeJobRecord[]>;
	markJobRunning(
		operationId: string,
		lease: { workerId: string; leasedUntil: Date },
	): Promise<BridgeJobRecord | null>;
	completeJob(
		operationId: string,
		result: BridgeJobResult,
	): Promise<BridgeJobRecord | null>;
	failJob(
		operationId: string,
		failure: BridgeJobFailure,
	): Promise<BridgeJobRecord | null>;
	requeueJob(
		operationId: string,
		failure?: BridgeJobFailure,
	): Promise<BridgeJobRecord | null>;
	upsertAvailabilitySnapshot(
		snapshot: Omit<AvailabilitySnapshot, 'snapshotId' | 'version'>,
	): Promise<AvailabilitySnapshot>;
	getAvailabilitySnapshot(
		query: AvailabilitySnapshotQuery,
	): Promise<AvailabilitySnapshot | null>;
	getQueueStats(now?: Date): Promise<BridgeQueueStats>;
	clear?(): Promise<void>;
}

const snapshotKey = (query: AvailabilitySnapshotQuery): string =>
	[query.baseUrl, query.kind, query.serviceId, query.scope].join('::');

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const nowIso = (now = new Date()): string => now.toISOString();

export const createInMemoryBridgeAsyncStore = (): BridgeAsyncStore => {
	const jobs = new Map<string, BridgeJobRecord>();
	const idempotencyKeys = new Map<string, string>();
	const snapshots = new Map<string, AvailabilitySnapshot>();

	const getByOperationId = (operationId: string): BridgeJobRecord | null => {
		const found = jobs.get(operationId);
		return found ? clone(found) : null;
	};

	return {
		async enqueueJob(job, options) {
			const idempotencyKey = options?.idempotencyKey;
			if (idempotencyKey) {
				const existingOperationId = idempotencyKeys.get(idempotencyKey);
				if (existingOperationId) {
					const existing = getByOperationId(existingOperationId);
					if (existing) return existing;
				}
			}

			const operationId = randomUUID();
			const timestamp = nowIso();
			const record: BridgeJobRecord = {
				operationId,
				kind: job.kind,
				status: 'queued',
				command: clone(job.command),
				idempotencyKey,
				attempts: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			jobs.set(operationId, record);
			if (idempotencyKey) idempotencyKeys.set(idempotencyKey, operationId);
			return clone(record);
		},

		async getJob(operationId) {
			return getByOperationId(operationId);
		},

		async listReadyJobs(limit, now = new Date()) {
			const cutoff = now.getTime();
			return [...jobs.values()]
				.filter((job) => {
					if (job.status === 'queued') return true;
					if (
						(job.status !== 'leased' && job.status !== 'running') ||
						!job.leasedUntil
					) {
						return false;
					}
					return Date.parse(job.leasedUntil) <= cutoff;
				})
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				.slice(0, limit)
				.map(clone);
		},

		async markJobRunning(operationId, lease) {
			const found = jobs.get(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: 'running',
				attempts: found.attempts + 1,
				leasedBy: lease.workerId,
				leasedUntil: lease.leasedUntil.toISOString(),
				updatedAt: nowIso(),
			};
			jobs.set(operationId, next);
			return clone(next);
		},

		async completeJob(operationId, result) {
			const found = jobs.get(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: 'succeeded',
				result: clone(result),
				failure: undefined,
				updatedAt: nowIso(),
			};
			jobs.set(operationId, next);
			return clone(next);
		},

		async failJob(operationId, failure) {
			const found = jobs.get(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: failure.status,
				failure: clone(failure),
				updatedAt: nowIso(),
			};
			jobs.set(operationId, next);
			return clone(next);
		},

		async requeueJob(operationId, failure) {
			const found = jobs.get(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: 'queued',
				failure: failure ? clone(failure) : found.failure,
				leasedBy: undefined,
				leasedUntil: undefined,
				updatedAt: nowIso(),
			};
			jobs.set(operationId, next);
			return clone(next);
		},

		async upsertAvailabilitySnapshot(snapshot) {
			const key = snapshotKey({
				kind: snapshot.kind,
				serviceId: snapshot.serviceId,
				scope: snapshot.scope,
				baseUrl: snapshot.adapterProfile.baseUrl,
			});
			const previous = snapshots.get(key);
			const next: AvailabilitySnapshot = {
				...clone(snapshot),
				snapshotId: previous?.snapshotId ?? randomUUID(),
				version: (previous?.version ?? 0) + 1,
			};
			snapshots.set(key, next);
			return clone(next);
		},

		async getAvailabilitySnapshot(query) {
			const found = snapshots.get(snapshotKey(query));
			return found ? clone(found) : null;
		},

		async getQueueStats(now = new Date()) {
			return queueStatsFromJobs([...jobs.values()], now);
		},

		async clear() {
			jobs.clear();
			idempotencyKeys.clear();
			snapshots.clear();
		},
	};
};
