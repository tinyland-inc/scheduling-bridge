/**
 * Postgres flow-journal TTL purge (design §5 "PII hygiene": "a TTL purge job bounds
 * retention"; risk 9). Redis gets retention via EXPIRE-per-append; Postgres needs an
 * explicit periodic DELETE of rows older than the retention TTL. Covers the journal
 * method, the standalone ops helper, and the retention-cutoff arithmetic (a fake pool
 * captures the DELETE statement + bound interval).
 */

import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createPostgresFlowJournal,
	purgeFlowCheckpoints,
} from '../postgres-journal.js';
import {
	DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS,
	parseFlowJournalPurgeIntervalMs,
} from '../journal-config.js';

interface PurgeQuery {
	readonly text: string;
	readonly values: unknown[] | undefined;
}

/**
 * Fake pool implementing only what the purge issues: the bootstrap DDL (no-op) and
 * the bounded DELETE. `at` is a fixed wall clock so deletions are deterministic; the
 * DELETE arithmetic (`now() - make_interval(secs => $1)`) is evaluated in JS against
 * `nowMs` so the row-count is real.
 */
const createFakePurgePool = (rows: { at: number }[], nowMs = Date.now()) => {
	const queries: PurgeQuery[] = [];
	const pool = {
		async query(text: string, values?: unknown[]) {
			queries.push({ text, values });
			if (text.includes('create table if not exists flow_checkpoints')) {
				return { rows: [], rowCount: 0 };
			}
			if (text.includes('delete from flow_checkpoints')) {
				const retentionSeconds = (values as unknown[])[0] as number;
				const cutoff = nowMs - retentionSeconds * 1000;
				const before = rows.length;
				for (let i = rows.length - 1; i >= 0; i -= 1) {
					if (rows[i].at < cutoff) rows.splice(i, 1);
				}
				return { rows: [], rowCount: before - rows.length };
			}
			throw new Error(`fake purge pool: unexpected query ${text}`);
		},
		async end() {},
	};
	return { pool: pool as unknown as pg.Pool, queries, rows };
};

describe('flow journal TTL purge', () => {
	it('deletes rows older than the retention window (standalone ops helper)', async () => {
		const now = 1_000_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const rows = [
			{ at: now - 20 * day }, // older than 14d → purged
			{ at: now - 15 * day }, // older than 14d → purged
			{ at: now - 13 * day }, // within 14d → kept
			{ at: now - 1 * day }, // within 14d → kept
		];
		const fake = createFakePurgePool(rows, now);
		const retention = 14 * 24 * 60 * 60; // 14 days

		const deleted = await purgeFlowCheckpoints(fake.pool, retention);

		expect(deleted).toBe(2);
		expect(fake.rows).toHaveLength(2);
		const del = fake.queries.find((q) => q.text.includes('delete from flow_checkpoints'));
		expect(del?.text).toContain('make_interval(secs =>');
		expect(del?.values).toEqual([retention]);
	});

	it('is a no-op for a non-positive retention window', async () => {
		const fake = createFakePurgePool([{ at: 0 }]);
		expect(await purgeFlowCheckpoints(fake.pool, 0)).toBe(0);
		expect(await purgeFlowCheckpoints(fake.pool, -1)).toBe(0);
		expect(fake.queries.some((q) => q.text.includes('delete'))).toBe(false);
	});

	it('exposes purgeExpiredCheckpoints on the journal (waits for the ready gate)', async () => {
		const now = 2_000_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const fake = createFakePurgePool([{ at: now - 30 * day }, { at: now }], now);
		const journal = createPostgresFlowJournal({ pool: fake.pool });

		const deleted = await journal.purgeExpiredCheckpoints(14 * 24 * 60 * 60);

		expect(deleted).toBe(1);
		expect(fake.rows).toHaveLength(1);
	});

	it('purge runs independently of append/read (issues only the bounded DELETE)', async () => {
		// The purge is a self-contained DELETE; it must not require or interfere with
		// the insert/select statements. migrate:false so no DDL is issued first.
		const now = 3_000_000_000_000;
		const day = 24 * 60 * 60 * 1000;
		const fake = createFakePurgePool([{ at: now - 100 * day }, { at: now }], now);
		const journal = createPostgresFlowJournal({ pool: fake.pool, migrate: false });

		expect(await journal.purgeExpiredCheckpoints(14 * 24 * 60 * 60)).toBe(1);
		// Only the DELETE statement was issued (no DDL, no insert, no select).
		expect(fake.queries.every((q) => q.text.includes('delete from flow_checkpoints'))).toBe(true);
	});
});

describe('parseFlowJournalPurgeIntervalMs', () => {
	const ORIGINAL = process.env.BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS;
	beforeEach(() => {
		delete process.env.BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS;
	});
	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS;
		else process.env.BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS = ORIGINAL;
	});

	it('defaults to hourly when unset', () => {
		expect(parseFlowJournalPurgeIntervalMs({})).toBe(DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS);
		expect(DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS).toBe(60 * 60 * 1000);
	});

	it('reads a positive override and rejects junk', () => {
		expect(parseFlowJournalPurgeIntervalMs({ BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS: '90000' })).toBe(
			90000,
		);
		expect(parseFlowJournalPurgeIntervalMs({ BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS: '0' })).toBe(
			DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS,
		);
		expect(parseFlowJournalPurgeIntervalMs({ BRIDGE_FLOW_JOURNAL_PURGE_INTERVAL_MS: 'nope' })).toBe(
			DEFAULT_FLOW_JOURNAL_PURGE_INTERVAL_MS,
		);
	});

	it('uses fake timers for an interval-driven sweep (clock injection per repo conventions)', async () => {
		vi.useFakeTimers();
		try {
			const fake = createFakePurgePool(
				[{ at: 0 }, { at: 0 }, { at: Date.now() }],
				Date.now(),
			);
			let sweeps = 0;
			const timer = setInterval(() => {
				sweeps += 1;
				void purgeFlowCheckpoints(fake.pool, 14 * 24 * 60 * 60);
			}, 60_000);
			expect(sweeps).toBe(0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(sweeps).toBe(1);
			await vi.advanceTimersByTimeAsync(120_000);
			expect(sweeps).toBe(3);
			clearInterval(timer);
		} finally {
			vi.useRealTimers();
		}
	});
});
