/**
 * Postgres FlowJournal — additive `flow_checkpoints` table, append-only, in a
 * separate table from `bridge_jobs` (design: docs/design/flow-dag-formalization.md
 * §4 storage layout, risk 1). Journal rows are NEVER embedded in the job record.
 *
 * Schema management mirrors `src/async/postgres-store.ts`: bootstrap DDL
 * (`create table if not exists`, idempotent) applied as one multi-statement
 * `pool.query`, gated behind a lazily-awaited `ready` promise; `migrate: false`
 * skips DDL for deployments that manage schema externally.
 *
 * Seq assignment — insert-select max+1 WITH PK-CONFLICT RETRY. The append is a
 * single statement (`insert ... select coalesce(max(seq)+1, 0) ... returning *`).
 * Under READ COMMITTED two racing appends for the same operation can both compute
 * the same `max(seq)+1`; `PRIMARY KEY (operation_id, seq)` then rejects the loser
 * with `23505 unique_violation` instead of ever committing a duplicate or
 * out-of-order seq, and the loser retries against the now-visible row. Chosen over
 * a sequence/INCR-style counter because a counter assigns seq BEFORE the insert
 * commits: an aborted insert burns a number (gap) and interleaved commits diverge
 * row order from seq order — exactly the lease-expiry race the design bans. The
 * composite PK makes the invariant declarative: monotonic, gapless, and insert
 * order ≡ seq order, with contention resolved by deterministic retry.
 */

import pg from 'pg';
import type { QueryResultRow } from 'pg';
import { Effect } from 'effect';
import {
	JournalError,
	type CheckpointStatus,
	type FlowCheckpoint,
	type FlowJournalShape,
} from './journal.js';
import type { LandingObservation } from './station.js';
import type { FuzzyResolution } from './fuzzy.js';

const { Pool } = pg;

export const FLOW_JOURNAL_SCHEMA_SQL = `
create table if not exists flow_checkpoints (
  operation_id uuid not null,
  seq integer not null,
  flow_id text not null,
  flow_version text not null,
  plan_hash text not null,
  step_id text not null,
  attempt integer not null,
  status text not null,
  at timestamptz not null,
  landing jsonb,
  resolutions jsonb,
  state_delta jsonb,
  idempotency_token text,
  reroute jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  primary key (operation_id, seq)
);
`;

interface FlowCheckpointRow extends QueryResultRow {
	operation_id: string;
	seq: number;
	flow_id: string;
	flow_version: string;
	plan_hash: string;
	step_id: string;
	attempt: number;
	status: CheckpointStatus;
	at: Date | string;
	landing: LandingObservation | null;
	resolutions: readonly FuzzyResolution<unknown>[] | null;
	state_delta: Record<string, unknown> | null;
	idempotency_token: string | null;
	reroute: FlowCheckpoint['reroute'] | null;
	error: FlowCheckpoint['error'] | null;
}

const iso = (value: Date | string): string =>
	value instanceof Date ? value.toISOString() : value;

const checkpointFromRow = (row: FlowCheckpointRow): FlowCheckpoint => ({
	operationId: row.operation_id,
	seq: row.seq,
	flowId: row.flow_id,
	flowVersion: row.flow_version,
	planHash: row.plan_hash,
	stepId: row.step_id,
	attempt: row.attempt,
	status: row.status,
	at: iso(row.at),
	landing: row.landing ?? undefined,
	resolutions: row.resolutions ?? undefined,
	stateDelta: row.state_delta ?? undefined,
	idempotencyToken: row.idempotency_token ?? undefined,
	reroute: row.reroute ?? undefined,
	error: row.error ?? undefined,
});

const isUniqueViolation = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	(error as { code?: unknown }).code === '23505';

const jsonbOrNull = (value: unknown): string | null =>
	value === undefined ? null : JSON.stringify(value);

/** Bounds the PK-conflict retry loop; contention per operation is a handful of
 * racing workers at most (lease-expiry overlap), so each retry round commits at
 * least one racer and the loop terminates well inside this budget. */
const DEFAULT_MAX_SEQ_CONFLICT_RETRIES = 32;

export interface PostgresFlowJournalOptions {
	/** Injected pool (shared with the async store or a test fake); never closed by this journal. */
	readonly pool?: pg.Pool;
	/** Owned connection; `close()` is exposed only in this mode. */
	readonly connectionString?: string;
	readonly ssl?: boolean | pg.PoolConfig['ssl'];
	readonly migrate?: boolean;
	readonly maxSeqConflictRetries?: number;
}

export type PostgresFlowJournal = FlowJournalShape & {
	close?: () => Promise<void>;
	ready: () => Promise<void>;
	/**
	 * TTL purge (design §5 "PII hygiene": "a TTL purge job bounds retention"; risk 9):
	 * delete checkpoint rows whose `at` is older than `retentionSeconds`. The Redis
	 * journal gets this for free via EXPIRE-per-append; Postgres needs an explicit
	 * periodic delete. Returns the number of rows deleted. Idempotent and safe to run
	 * concurrently across replicas (a plain bounded DELETE).
	 */
	purgeExpiredCheckpoints: (retentionSeconds: number) => Promise<number>;
};

/**
 * Manual/periodic TTL purge against an arbitrary pool — the ops-facing entry point
 * (design §5 "TTL purge job"). Deletes `flow_checkpoints` rows older than
 * `retentionSeconds` and returns the deleted-row count. Exported standalone so an
 * operator can run a one-shot purge without constructing a full journal.
 */
export const purgeFlowCheckpoints = async (
	pool: pg.Pool,
	retentionSeconds: number,
): Promise<number> => {
	if (!Number.isFinite(retentionSeconds) || retentionSeconds <= 0) return 0;
	const result = await pool.query(
		`delete from flow_checkpoints where at < now() - make_interval(secs => $1)`,
		[retentionSeconds],
	);
	return result.rowCount ?? 0;
};

export const ensureFlowJournalSchema = async (pool: pg.Pool): Promise<void> => {
	await pool.query(FLOW_JOURNAL_SCHEMA_SQL);
};

export const createPostgresFlowJournal = (
	options: PostgresFlowJournalOptions,
): PostgresFlowJournal => {
	if (!options.pool && !options.connectionString) {
		throw new Error(
			'createPostgresFlowJournal requires pool or connectionString',
		);
	}

	const ownsPool = !options.pool;
	const pool =
		options.pool ??
		new Pool({
			connectionString: options.connectionString,
			ssl: options.ssl,
		});
	const maxRetries =
		options.maxSeqConflictRetries ?? DEFAULT_MAX_SEQ_CONFLICT_RETRIES;
	const ready =
		options.migrate === false
			? Promise.resolve()
			: ensureFlowJournalSchema(pool);
	const query = async <T extends QueryResultRow = QueryResultRow>(
		text: string,
		values?: unknown[],
	) => {
		await ready;
		return pool.query<T>(text, values);
	};

	const appendRow = async (
		cp: Omit<FlowCheckpoint, 'seq'>,
	): Promise<FlowCheckpoint> => {
		for (let attempt = 0; attempt < maxRetries; attempt += 1) {
			try {
				const inserted = await query<FlowCheckpointRow>(
					`
					insert into flow_checkpoints (
						operation_id,
						seq,
						flow_id,
						flow_version,
						plan_hash,
						step_id,
						attempt,
						status,
						at,
						landing,
						resolutions,
						state_delta,
						idempotency_token,
						reroute,
						error
					)
					select
						$1,
						coalesce(max(seq) + 1, 0),
						$2, $3, $4, $5, $6, $7, $8,
						$9::jsonb, $10::jsonb, $11::jsonb, $12, $13::jsonb, $14::jsonb
					from flow_checkpoints
					where operation_id = $1
					returning *
					`,
					[
						cp.operationId,
						cp.flowId,
						cp.flowVersion,
						cp.planHash,
						cp.stepId,
						cp.attempt,
						cp.status,
						cp.at,
						jsonbOrNull(cp.landing),
						jsonbOrNull(cp.resolutions),
						jsonbOrNull(cp.stateDelta),
						cp.idempotencyToken ?? null,
						jsonbOrNull(cp.reroute),
						jsonbOrNull(cp.error),
					],
				);
				return checkpointFromRow(inserted.rows[0]!);
			} catch (error) {
				if (!isUniqueViolation(error)) throw error;
				// PK conflict: a racing append committed the seq we computed.
				// Recompute against the now-committed row and try again.
			}
		}
		throw new Error(
			`flow journal seq conflict retries exhausted (${maxRetries}) for operation ${cp.operationId}`,
		);
	};

	const journal: PostgresFlowJournal = {
		append: (cp) =>
			Effect.tryPromise({
				try: () => appendRow(cp),
				catch: (cause) =>
					new JournalError({
						message: `Postgres flow journal append failed for operation ${cp.operationId}`,
						cause,
					}),
			}),
		read: (operationId) =>
			Effect.tryPromise({
				try: async () => {
					const found = await query<FlowCheckpointRow>(
						`
						select *
						from flow_checkpoints
						where operation_id = $1
						order by seq asc
						`,
						[operationId],
					);
					return found.rows.map(checkpointFromRow);
				},
				catch: (cause) =>
					new JournalError({
						message: `Postgres flow journal read failed for operation ${operationId}`,
						cause,
					}),
			}),
		ready: async () => {
			await ready;
		},
		purgeExpiredCheckpoints: async (retentionSeconds) => {
			await ready;
			return purgeFlowCheckpoints(pool, retentionSeconds);
		},
	};

	if (ownsPool) {
		journal.close = async () => {
			await pool.end();
		};
	}

	return journal;
};
