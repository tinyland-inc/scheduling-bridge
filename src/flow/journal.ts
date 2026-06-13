/**
 * FlowJournal — append-only checkpoint rows in a separate keyspace.
 * Design: docs/design/flow-dag-formalization.md §4 (journal.ts) and §5.
 *
 * This file ships the interface plus the MEMORY implementation (per-operation array,
 * serial seq). The durable implementations live beside it — Redis (atomic Lua
 * LLEN+RPUSH seq append, `redis-journal.ts`) and Postgres (`flow_checkpoints` table,
 * PRIMARY KEY (operation_id, seq), `postgres-journal.ts`) — implementing the same
 * `FlowJournalShape` behind the same Context tag.
 */

import { Context, Data, Effect, Layer } from 'effect';
import type { LandingObservation } from './station.js';
import type { FuzzyResolution } from './fuzzy.js';

export type CheckpointStatus =
	| 'started'
	| 'completed'
	| 'failed'
	| 'compensated'
	| 'skipped_resume'
	| 'rerouted';

export interface FlowCheckpoint {
	/** = BridgeJobRecord.operationId */
	readonly operationId: string;
	/** Monotonic per operation. */
	readonly seq: number;
	readonly flowId: string;
	readonly flowVersion: string;
	readonly planHash: string;
	readonly stepId: string;
	readonly attempt: number;
	readonly status: CheckpointStatus;
	/** ISO timestamp. */
	readonly at: string;
	readonly landing?: LandingObservation;
	readonly resolutions?: readonly FuzzyResolution<unknown>[];
	/** Schema-encoded Provides; segment boundaries only; redaction-annotated. */
	readonly stateDelta?: Record<string, unknown>;
	readonly idempotencyToken?: string;
	/** On 'rerouted' rows. */
	readonly reroute?: { readonly to: string; readonly remaining: number };
	readonly error?: {
		readonly code: string;
		readonly message: string;
		readonly retryable: boolean;
	};
}

export class JournalError extends Data.TaggedError('JournalError')<{
	readonly message: string;
	readonly cause?: unknown;
}> {}

export interface FlowJournalShape {
	readonly append: (
		cp: Omit<FlowCheckpoint, 'seq'>,
	) => Effect.Effect<FlowCheckpoint, JournalError>;
	readonly read: (
		operationId: string,
	) => Effect.Effect<readonly FlowCheckpoint[], JournalError>;
}

export class FlowJournal extends Context.Tag('scheduling-bridge/FlowJournal')<
	FlowJournal,
	FlowJournalShape
>() {}

/**
 * In-memory journal: one array per operationId; seq derived serially from the array length
 * at append time (the same guarantee the Redis Lua LLEN+RPUSH and Postgres composite PK
 * provide atomically).
 */
export const createInMemoryFlowJournal = (): FlowJournalShape => {
	const operations = new Map<string, FlowCheckpoint[]>();
	return {
		append: (cp) =>
			Effect.sync(() => {
				const rows = operations.get(cp.operationId) ?? [];
				const row: FlowCheckpoint = Object.freeze({ ...cp, seq: rows.length });
				rows.push(row);
				operations.set(cp.operationId, rows);
				return row;
			}),
		read: (operationId) =>
			Effect.sync(() => [...(operations.get(operationId) ?? [])] as readonly FlowCheckpoint[]),
	};
};

/** Memory journal layer (fresh, isolated journal per layer build). */
export const FlowJournalMemoryLive: Layer.Layer<FlowJournal> = Layer.sync(
	FlowJournal,
	createInMemoryFlowJournal,
);

/**
 * No-op journal: satisfies the FlowJournal Tag while writing nothing and reading
 * empty. Used for read (availability) flow runs that are SAMPLED OUT by
 * `BRIDGE_FLOW_JOURNAL_SAMPLE` (design §5 "Checkpoint persistence discipline"): the
 * fold's append/read calls are kept structurally identical, but no checkpoint row is
 * persisted. Booking flows never use this — they are unconditionally journaled.
 * `append` returns a synthetic seq-0 row so the fold's evidence-only contract holds.
 */
export const createNoopFlowJournal = (): FlowJournalShape => ({
	append: (cp) => Effect.sync(() => ({ ...cp, seq: 0 }) as FlowCheckpoint),
	read: () => Effect.sync(() => [] as readonly FlowCheckpoint[]),
});
