/**
 * Flow journal retention configuration.
 *
 * Design: docs/design/flow-dag-formalization.md §4 storage layout / risk 1 —
 * journal retention is a dedicated knob, deliberately DECOUPLED from the job-record
 * TTL (`BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS`): checkpoint rows are reconciliation
 * evidence and must be able to outlive the job record they explain.
 *
 * Parser shape mirrors `src/async/config.ts` (`parseRedisAsyncJobTtlSeconds`).
 */

/**
 * Default journal retention: 14 days (twice the 7-day job-record TTL), so
 * `reconcile_required` triage evidence survives past job-record expiry.
 * Tuning from production volume is a 0.8.0 item (design §10).
 */
export const DEFAULT_FLOW_JOURNAL_TTL_SECONDS = 14 * 24 * 60 * 60;

export const parseFlowJournalTtlSeconds = (
	env: Partial<Record<'BRIDGE_FLOW_JOURNAL_TTL_SECONDS', string>> = process.env,
): number | undefined => {
	const raw = env.BRIDGE_FLOW_JOURNAL_TTL_SECONDS;
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
};

/**
 * Default cadence for the Postgres TTL purge sweep: hourly. The purge deletes
 * checkpoint rows older than the retention TTL (design §5 "PII hygiene": "a TTL
 * purge job bounds retention"); Redis gets retention for free via EXPIRE-per-append.
 * Decoupled from the retention window itself so the sweep frequency can be tuned
 * (0.8.0, design §10) without changing how long evidence is kept.
 */
export const DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const parseFlowJournalPurgeIntervalMs = (
	env: Partial<Record<'BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS', string>> = process.env,
): number => {
	const raw = env.BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS;
	if (!raw) return DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS;
	return Math.floor(parsed);
};

/**
 * Default read-flow journal sample rate: 1.0 (journal every read flow) — so the
 * default behavior is byte-identical to the pre-sampling fold (design §5 / §10 0.6.x
 * "Default = current behavior").
 */
export const DEFAULT_FLOW_JOURNAL_SAMPLE_RATE = 1;

/**
 * `BRIDGE_FLOW_JOURNAL_SAMPLE` — the fraction of READ (availability) flow runs whose
 * checkpoints are journaled (design §5 "Checkpoint persistence discipline":
 * availability/read flows journal fire-and-forget with a sampling knob; booking flows
 * are ALWAYS awaited and ALWAYS journaled, never sampled). Clamped to [0, 1]; missing,
 * non-numeric, or out-of-range values fall back to the default 1.0 (journal all).
 * A value of 0 disables read-flow journaling entirely.
 */
export const parseFlowJournalSampleRate = (
	env: Partial<Record<'BRIDGE_FLOW_JOURNAL_SAMPLE', string>> = process.env,
): number => {
	const raw = env.BRIDGE_FLOW_JOURNAL_SAMPLE;
	if (raw === undefined || raw === '') return DEFAULT_FLOW_JOURNAL_SAMPLE_RATE;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		return DEFAULT_FLOW_JOURNAL_SAMPLE_RATE;
	}
	return parsed;
};

/**
 * Per-run sampling decision: should THIS read-flow run journal its checkpoints?
 * `rate >= 1` always journals (the default); `rate <= 0` never does; otherwise a
 * uniform draw (injectable for deterministic tests). Booking flows never call this —
 * they are unconditionally journaled.
 */
export const shouldJournalReadFlow = (
	rate: number,
	random: () => number = Math.random,
): boolean => {
	if (rate >= 1) return true;
	if (rate <= 0) return false;
	return random() < rate;
};
