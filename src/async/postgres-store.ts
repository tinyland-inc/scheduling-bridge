import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueryResultRow } from 'pg';
import type {
	AvailabilitySnapshot,
	AvailabilitySnapshotQuery,
	BridgeJobCommand,
	BridgeJobFailure,
	BridgeJobRecord,
	BridgeJobResult,
	BridgeJobStatus,
	BridgeQueueStats,
	BridgeQueueStatsFailedRefresh,
	BridgeQueueStatsKindStatus,
	EnqueueBridgeJobOptions,
} from './types.js';
import type { BridgeAsyncStore } from './store.js';

const { Pool } = pg;

export const BRIDGE_ASYNC_SCHEMA_SQL = `
create table if not exists bridge_jobs (
  operation_id uuid primary key,
  kind text not null,
  status text not null,
  command jsonb not null,
  idempotency_key text unique,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  leased_by text,
  leased_until timestamptz,
  result jsonb,
  failure jsonb
);

create index if not exists bridge_jobs_ready_idx
  on bridge_jobs (status, created_at);

create table if not exists bridge_availability_snapshots (
  snapshot_id uuid primary key,
  kind text not null,
  service_id text not null,
  scope text not null,
  base_url text not null,
  adapter_profile jsonb not null,
  value jsonb not null,
  observed_at timestamptz not null,
  stale_at timestamptz not null,
  expires_at timestamptz not null,
  version integer not null default 1,
  source_job_id uuid references bridge_jobs(operation_id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (kind, service_id, scope, base_url)
);

create index if not exists bridge_availability_snapshots_freshness_idx
  on bridge_availability_snapshots (kind, service_id, scope, stale_at, expires_at);
`;

interface BridgeJobRow {
	operation_id: string;
	kind: BridgeJobRecord['kind'];
	status: BridgeJobStatus;
	command: BridgeJobRecord['command'];
	idempotency_key: string | null;
	attempts: number;
	created_at: Date | string;
	updated_at: Date | string;
	leased_by: string | null;
	leased_until: Date | string | null;
	result: BridgeJobResult | null;
	failure: BridgeJobFailure | null;
}

interface AvailabilitySnapshotRow {
	snapshot_id: string;
	kind: AvailabilitySnapshot['kind'];
	service_id: string;
	scope: string;
	adapter_profile: AvailabilitySnapshot['adapterProfile'];
	value: AvailabilitySnapshot['value'];
	observed_at: Date | string;
	stale_at: Date | string;
	expires_at: Date | string;
	version: number;
	source_job_id: string | null;
}

interface QueueStatsRow {
	kind: BridgeJobRecord['kind'];
	status: BridgeJobStatus;
	count: string | number;
	oldest_age_ms: string | number | null;
}

interface QueueTotalsRow {
	total: string | number;
	ready: string | number;
	retryable_failed: string | number;
	oldest_queued_age_ms: string | number | null;
}

interface QueueFailedRefreshRow {
	kind: BridgeQueueStatsFailedRefresh['kind'];
	status: BridgeQueueStatsFailedRefresh['status'];
	service_id: string;
	scope: string;
	code: string;
	step: string | null;
	retryable: boolean;
	count: string | number;
	oldest_age_ms: string | number | null;
}

const iso = (value: Date | string): string =>
	value instanceof Date ? value.toISOString() : value;

const jobFromRow = (row: BridgeJobRow): BridgeJobRecord => ({
	operationId: row.operation_id,
	kind: row.kind,
	status: row.status,
	command: row.command,
	idempotencyKey: row.idempotency_key ?? undefined,
	attempts: row.attempts,
	createdAt: iso(row.created_at),
	updatedAt: iso(row.updated_at),
	leasedBy: row.leased_by ?? undefined,
	leasedUntil: row.leased_until ? iso(row.leased_until) : undefined,
	result: row.result ?? undefined,
	failure: row.failure ?? undefined,
});

const snapshotFromRow = (
	row: AvailabilitySnapshotRow,
): AvailabilitySnapshot => ({
	snapshotId: row.snapshot_id,
	kind: row.kind,
	serviceId: row.service_id,
	scope: row.scope,
	adapterProfile: row.adapter_profile,
	value: row.value,
	observedAt: iso(row.observed_at),
	staleAt: iso(row.stale_at),
	expiresAt: iso(row.expires_at),
	version: row.version,
	sourceJobId: row.source_job_id ?? undefined,
});

const numberFromPg = (
	value: string | number | null | undefined,
): number | undefined => {
	if (value === null || value === undefined) return undefined;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
};

const queueKindStatusFromRow = (
	row: QueueStatsRow,
): BridgeQueueStatsKindStatus => ({
	kind: row.kind,
	status: row.status,
	count: numberFromPg(row.count) ?? 0,
	oldestAgeMs: numberFromPg(row.oldest_age_ms),
});

const queueFailedRefreshFromRow = (
	row: QueueFailedRefreshRow,
): BridgeQueueStatsFailedRefresh => ({
	kind: row.kind,
	status: row.status,
	serviceId: row.service_id,
	scope: row.scope,
	code: row.code,
	step: row.step ?? undefined,
	retryable: row.retryable,
	count: numberFromPg(row.count) ?? 0,
	oldestAgeMs: numberFromPg(row.oldest_age_ms),
});

export interface PostgresBridgeAsyncStoreOptions {
	readonly connectionString: string;
	readonly ssl?: boolean | pg.PoolConfig['ssl'];
	readonly migrate?: boolean;
}

export const ensureBridgeAsyncSchema = async (pool: pg.Pool): Promise<void> => {
	await pool.query(BRIDGE_ASYNC_SCHEMA_SQL);
};

export const createPostgresBridgeAsyncStore = (
	options: PostgresBridgeAsyncStoreOptions,
): BridgeAsyncStore & {
	close: () => Promise<void>;
	ready: () => Promise<void>;
} => {
	const pool = new Pool({
		connectionString: options.connectionString,
		ssl: options.ssl,
	});
	const ready =
		options.migrate === false
			? Promise.resolve()
			: ensureBridgeAsyncSchema(pool);
	const query = async <T extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: unknown[],
	) => {
		await ready;
		return pool.query<T>(text, values);
	};

	return {
		async enqueueJob(job: BridgeJobCommand, options?: EnqueueBridgeJobOptions) {
			const operationId = randomUUID();
			const inserted = await query<BridgeJobRow>(
				`
				insert into bridge_jobs (
					operation_id,
					kind,
					status,
					command,
					idempotency_key
				)
				values ($1, $2, 'queued', $3::jsonb, $4)
				on conflict (idempotency_key)
				do update set updated_at = bridge_jobs.updated_at
				returning *
				`,
				[
					operationId,
					job.kind,
					JSON.stringify(job.command),
					options?.idempotencyKey ?? null,
				],
			);
			return jobFromRow(inserted.rows[0]!);
		},

		async getJob(operationId) {
			const found = await query<BridgeJobRow>(
				'select * from bridge_jobs where operation_id = $1',
				[operationId],
			);
			return found.rows[0] ? jobFromRow(found.rows[0]) : null;
		},

		async listReadyJobs(limit, now = new Date()) {
			const found = await query<BridgeJobRow>(
				`
				select *
				from bridge_jobs
				where status = 'queued'
				   or (status in ('leased', 'running') and leased_until <= $1)
				order by created_at asc
				limit $2
				`,
				[now, limit],
			);
			return found.rows.map(jobFromRow);
		},

		async markJobRunning(operationId, lease) {
			const updated = await query<BridgeJobRow>(
				`
				update bridge_jobs
				set status = 'running',
				    attempts = attempts + 1,
				    leased_by = $2,
				    leased_until = $3,
				    updated_at = now()
				where operation_id = $1
				  and status in ('queued', 'leased', 'running')
				returning *
				`,
				[operationId, lease.workerId, lease.leasedUntil],
			);
			return updated.rows[0] ? jobFromRow(updated.rows[0]) : null;
		},

		async completeJob(operationId, result) {
			const updated = await query<BridgeJobRow>(
				`
				update bridge_jobs
				set status = 'succeeded',
				    result = $2::jsonb,
				    failure = null,
				    updated_at = now()
				where operation_id = $1
				returning *
				`,
				[operationId, JSON.stringify(result)],
			);
			return updated.rows[0] ? jobFromRow(updated.rows[0]) : null;
		},

		async failJob(operationId, failure) {
			const updated = await query<BridgeJobRow>(
				`
				update bridge_jobs
				set status = $2,
				    failure = $3::jsonb,
				    updated_at = now()
				where operation_id = $1
				returning *
				`,
				[operationId, failure.status, JSON.stringify(failure)],
			);
			return updated.rows[0] ? jobFromRow(updated.rows[0]) : null;
		},

		async requeueJob(operationId, failure) {
			const updated = await query<BridgeJobRow>(
				`
				update bridge_jobs
				set status = 'queued',
				    failure = coalesce($2::jsonb, failure),
				    leased_by = null,
				    leased_until = null,
				    updated_at = now()
				where operation_id = $1
				returning *
				`,
				[operationId, failure ? JSON.stringify(failure) : null],
			);
			return updated.rows[0] ? jobFromRow(updated.rows[0]) : null;
		},

		async upsertAvailabilitySnapshot(snapshot) {
			const inserted = await query<AvailabilitySnapshotRow>(
				`
				insert into bridge_availability_snapshots (
					snapshot_id,
					kind,
					service_id,
					scope,
					base_url,
					adapter_profile,
					value,
					observed_at,
					stale_at,
					expires_at,
					source_job_id
				)
				values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
				on conflict (kind, service_id, scope, base_url)
				do update set
					adapter_profile = excluded.adapter_profile,
					value = excluded.value,
					observed_at = excluded.observed_at,
					stale_at = excluded.stale_at,
					expires_at = excluded.expires_at,
					source_job_id = excluded.source_job_id,
					version = bridge_availability_snapshots.version + 1,
					updated_at = now()
				returning *
				`,
				[
					randomUUID(),
					snapshot.kind,
					snapshot.serviceId,
					snapshot.scope,
					snapshot.adapterProfile.baseUrl,
					JSON.stringify(snapshot.adapterProfile),
					JSON.stringify(snapshot.value),
					snapshot.observedAt,
					snapshot.staleAt,
					snapshot.expiresAt,
					snapshot.sourceJobId ?? null,
				],
			);
			return snapshotFromRow(inserted.rows[0]!);
		},

		async getAvailabilitySnapshot(snapshotQuery: AvailabilitySnapshotQuery) {
			const found = await query<AvailabilitySnapshotRow>(
				`
				select *
				from bridge_availability_snapshots
				where kind = $1
				  and service_id = $2
				  and scope = $3
				  and base_url = $4
				`,
				[
					snapshotQuery.kind,
					snapshotQuery.serviceId,
					snapshotQuery.scope,
					snapshotQuery.baseUrl,
				],
			);
			return found.rows[0] ? snapshotFromRow(found.rows[0]) : null;
		},

		async getQueueStats(now = new Date()): Promise<BridgeQueueStats> {
			const [totals, buckets, failedRefreshes] = await Promise.all([
				query<QueueTotalsRow>(
					`
					select
						count(*)::int as total,
						count(*) filter (
							where status = 'queued'
							   or (status in ('leased', 'running') and leased_until <= $1)
						)::int as ready,
						count(*) filter (
							where status in ('failed_pre_submit', 'reconcile_required')
							  and coalesce((failure->>'retryable')::boolean, false)
						)::int as retryable_failed,
						extract(epoch from ($1::timestamptz - min(created_at) filter (
							where status = 'queued'
							   or (status in ('leased', 'running') and leased_until <= $1)
						))) * 1000 as oldest_queued_age_ms
					from bridge_jobs
					`,
					[now],
				),
				query<QueueStatsRow>(
					`
					select
						kind,
						status,
						count(*)::int as count,
						extract(epoch from ($1::timestamptz - min(created_at))) * 1000 as oldest_age_ms
					from bridge_jobs
					group by kind, status
					order by kind, status
					`,
					[now],
				),
				query<QueueFailedRefreshRow>(
					`
					select
						kind,
						status,
						command->>'serviceId' as service_id,
						coalesce(command->>'month', command->>'date') as scope,
						failure->>'code' as code,
						failure->>'step' as step,
						coalesce((failure->>'retryable')::boolean, false) as retryable,
						count(*)::int as count,
						extract(epoch from ($1::timestamptz - min(created_at))) * 1000 as oldest_age_ms
					from bridge_jobs
					where kind in ('availability_dates_refresh', 'availability_slots_refresh')
					  and status in ('failed_pre_submit', 'reconcile_required')
					  and failure is not null
					group by kind, status, service_id, scope, code, step, retryable
					order by kind, scope, code
					`,
					[now],
				),
			]);
			const totalRow = totals.rows[0];
			return {
				total: numberFromPg(totalRow?.total) ?? 0,
				ready: numberFromPg(totalRow?.ready) ?? 0,
				retryableFailed: numberFromPg(totalRow?.retryable_failed) ?? 0,
				oldestQueuedAgeMs: numberFromPg(totalRow?.oldest_queued_age_ms),
				byKindStatus: buckets.rows.map(queueKindStatusFromRow),
				failedRefreshes: failedRefreshes.rows.map(queueFailedRefreshFromRow),
			};
		},

		async close() {
			await pool.end();
		},

		async ready() {
			await ready;
		},
	};
};
