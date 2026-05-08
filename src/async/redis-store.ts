import { randomBytes, randomUUID } from 'node:crypto';
import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis, RedisOptions } from 'ioredis';
import type {
	AvailabilitySnapshot,
	AvailabilitySnapshotQuery,
	BridgeJobCommand,
	BridgeJobFailure,
	BridgeJobRecord,
	BridgeJobResult,
	EnqueueBridgeJobOptions,
} from './types.js';
import type { BridgeAsyncStore } from './store.js';

const LUA_CAS_DEL = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const DEFAULT_PREFIX = 'bridge-async:v1';
const DEFAULT_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_SNAPSHOT_TTL_SECONDS = 24 * 60 * 60;

export interface RedisBridgeAsyncStoreOptions {
	readonly client?: IORedis;
	readonly url?: string;
	readonly redisOptions?: RedisOptions;
	readonly keyPrefix?: string;
	readonly jobTtlSeconds?: number;
	readonly snapshotTtlSeconds?: number;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const nowIso = (now = new Date()): string => now.toISOString();

const encodeKeyPart = (value: string): string => Buffer.from(value).toString('base64url');

const snapshotStorageKey = (prefix: string, query: AvailabilitySnapshotQuery): string =>
	[
		prefix,
		'snapshot',
		query.kind,
		encodeKeyPart(query.baseUrl),
		encodeKeyPart(query.serviceId),
		encodeKeyPart(query.scope),
	].join(':');

const jobStorageKey = (prefix: string, operationId: string): string =>
	`${prefix}:job:${operationId}`;

const idempotencyStorageKey = (prefix: string, idempotencyKey: string): string =>
	`${prefix}:idempotency:${encodeKeyPart(idempotencyKey)}`;

const readyJobsKey = (prefix: string): string => `${prefix}:jobs:ready`;

const claimLockKey = (prefix: string, operationId: string): string =>
	`${prefix}:claim:${operationId}`;

const readJson = async <A>(client: IORedis, key: string): Promise<A | null> => {
	const raw = await client.get(key);
	return raw ? (JSON.parse(raw) as A) : null;
};

const writeJson = async <A>(
	client: IORedis,
	key: string,
	value: A,
	ttlSeconds: number,
): Promise<void> => {
	await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
};

export const createRedisBridgeAsyncStore = (
	options: RedisBridgeAsyncStoreOptions,
): BridgeAsyncStore & {
	close?: () => Promise<void>;
	ready: () => Promise<void>;
} => {
	if (!options.client && !options.url) {
		throw new Error('createRedisBridgeAsyncStore requires client or url');
	}

	const ownsClient = !options.client;
	const client = options.client ?? new IORedisImpl(options.url!, options.redisOptions ?? {});
	const prefix = options.keyPrefix ?? DEFAULT_PREFIX;
	const jobTtlSeconds = options.jobTtlSeconds ?? DEFAULT_JOB_TTL_SECONDS;
	const snapshotTtlSeconds = options.snapshotTtlSeconds ?? DEFAULT_SNAPSHOT_TTL_SECONDS;

	const readJob = (operationId: string): Promise<BridgeJobRecord | null> =>
		readJson<BridgeJobRecord>(client, jobStorageKey(prefix, operationId));

	const writeJob = (job: BridgeJobRecord): Promise<void> =>
		writeJson(client, jobStorageKey(prefix, job.operationId), job, jobTtlSeconds);

	const store: BridgeAsyncStore & {
		close?: () => Promise<void>;
		ready: () => Promise<void>;
	} = {
		async enqueueJob(job: BridgeJobCommand, options?: EnqueueBridgeJobOptions) {
			if (options?.idempotencyKey) {
				const idempotencyKey = idempotencyStorageKey(prefix, options.idempotencyKey);
				const operationId = randomUUID();
				const claimed = await client.set(idempotencyKey, operationId, 'EX', jobTtlSeconds, 'NX');
				if (claimed !== 'OK') {
					const existingOperationId = await client.get(idempotencyKey);
					if (existingOperationId) {
						const existing = await readJob(existingOperationId);
						if (existing) return existing;
					}
					await client.del(idempotencyKey);
					return this.enqueueJob(job, options);
				}

				const timestamp = nowIso();
				const record: BridgeJobRecord = {
					operationId,
					kind: job.kind,
					status: 'queued',
					command: clone(job.command),
					idempotencyKey: options.idempotencyKey,
					attempts: 0,
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				await writeJob(record);
				await client.zadd(readyJobsKey(prefix), Date.parse(record.createdAt), operationId);
				return clone(record);
			}

			const operationId = randomUUID();
			const timestamp = nowIso();
			const record: BridgeJobRecord = {
				operationId,
				kind: job.kind,
				status: 'queued',
				command: clone(job.command),
				attempts: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			await writeJob(record);
			await client.zadd(readyJobsKey(prefix), Date.parse(record.createdAt), operationId);
			return clone(record);
		},

		async getJob(operationId) {
			const found = await readJob(operationId);
			return found ? clone(found) : null;
		},

		async listReadyJobs(limit, now = new Date()) {
			const operationIds = await client.zrangebyscore(
				readyJobsKey(prefix),
				'-inf',
				String(now.getTime()),
			);
			const ready: BridgeJobRecord[] = [];
			for (const operationId of operationIds) {
				if (ready.length >= limit) break;
				const job = await readJob(operationId);
				if (!job) {
					await client.zrem(readyJobsKey(prefix), operationId);
					continue;
				}
				if (job.status === 'queued') {
					ready.push(clone(job));
					continue;
				}
				if (
					(job.status === 'leased' || job.status === 'running') &&
					job.leasedUntil &&
					Date.parse(job.leasedUntil) <= now.getTime()
				) {
					ready.push(clone(job));
					continue;
				}
				await client.zrem(readyJobsKey(prefix), operationId);
			}
			return ready;
		},

		async markJobRunning(operationId, lease) {
			const token = randomBytes(16).toString('hex');
			const lockKey = claimLockKey(prefix, operationId);
			const claimed = await client.set(lockKey, token, 'PX', 5000, 'NX');
			if (claimed !== 'OK') return null;

			try {
				const found = await readJob(operationId);
				if (!found) return null;
				if (found.status !== 'queued' && found.status !== 'leased' && found.status !== 'running') {
					await client.zrem(readyJobsKey(prefix), operationId);
					return null;
				}
				if (
					found.status !== 'queued' &&
					found.leasedUntil &&
					Date.parse(found.leasedUntil) > Date.now()
				) {
					return null;
				}

				const next: BridgeJobRecord = {
					...found,
					status: 'running',
					attempts: found.attempts + 1,
					leasedBy: lease.workerId,
					leasedUntil: lease.leasedUntil.toISOString(),
					updatedAt: nowIso(),
				};
				await writeJob(next);
				await client.zadd(readyJobsKey(prefix), lease.leasedUntil.getTime(), operationId);
				return clone(next);
			} finally {
				await client.eval(LUA_CAS_DEL, 1, lockKey, token).catch(() => undefined);
			}
		},

		async completeJob(operationId, result) {
			const found = await readJob(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: 'succeeded',
				result: clone(result),
				failure: undefined,
				updatedAt: nowIso(),
			};
			await writeJob(next);
			await client.zrem(readyJobsKey(prefix), operationId);
			return clone(next);
		},

		async failJob(operationId, failure) {
			const found = await readJob(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: failure.status,
				failure: clone(failure),
				updatedAt: nowIso(),
			};
			await writeJob(next);
			await client.zrem(readyJobsKey(prefix), operationId);
			return clone(next);
		},

		async requeueJob(operationId, failure?: BridgeJobFailure) {
			const found = await readJob(operationId);
			if (!found) return null;
			const next: BridgeJobRecord = {
				...found,
				status: 'queued',
				failure: failure ? clone(failure) : found.failure,
				leasedBy: undefined,
				leasedUntil: undefined,
				updatedAt: nowIso(),
			};
			await writeJob(next);
			await client.zadd(readyJobsKey(prefix), Date.now(), operationId);
			return clone(next);
		},

		async upsertAvailabilitySnapshot(snapshot) {
			const query: AvailabilitySnapshotQuery = {
				kind: snapshot.kind,
				serviceId: snapshot.serviceId,
				scope: snapshot.scope,
				baseUrl: snapshot.adapterProfile.baseUrl,
			};
			const key = snapshotStorageKey(prefix, query);
			const previous = await readJson<AvailabilitySnapshot>(client, key);
			const next: AvailabilitySnapshot = {
				...clone(snapshot),
				snapshotId: previous?.snapshotId ?? randomUUID(),
				version: (previous?.version ?? 0) + 1,
			};
			await writeJson(client, key, next, snapshotTtlSeconds);
			return clone(next);
		},

		async getAvailabilitySnapshot(query) {
			const found = await readJson<AvailabilitySnapshot>(client, snapshotStorageKey(prefix, query));
			return found ? clone(found) : null;
		},

		async clear() {
			const keys = await client.keys(`${prefix}:*`);
			if (keys.length > 0) await client.del(...keys);
		},

		async ready() {
			await client.ping();
		},
	};

	if (ownsClient) {
		store.close = async () => {
			await client.quit().then(
				() => undefined,
				() => undefined,
			);
		};
	}

	return store;
};
