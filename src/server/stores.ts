/**
 * Redis L2 client + adapter shim, async store selection, and inline worker
 * lifecycle.
 *
 * Extracted verbatim from `src/server/handler.ts` (handler decomposition
 * phase 1, TIN-2036 / docs/design/flow-dag-formalization.md section 8).
 * Pure code motion: selection order (Postgres -> Redis -> memory), boot
 * logging, and the `__setBridgeAsyncStoreForTest` seam are unchanged
 * (the seam is re-exported from `handler.ts` for existing importers).
 *
 * `RedisL2.getCached` (from `shared/redis-l2.ts`) expects `mk: () => Promise<A>`
 * because its Effect.gen generator internally calls `Effect.tryPromise({ try:
 * () => mk(), ... })`. But `ServiceCatalogRedisL2.getCached` (the structural
 * interface the catalog depends on) takes `mk: Effect.Effect<A>` so that
 * non-Node callers and tests stay Effect-native.
 *
 * This shim bridges the two: the catalog hands us an Effect, we wrap it as a
 * Promise via `Effect.runPromise`, pass it into the real `getCached`, and
 * provide the `RedisL2` service via a module-level singleton ioredis client.
 *
 * If REDIS_URL is missing (local dev), `redisL2` stays `undefined` and the
 * catalog falls back to its in-process single-flight path.
 */

import { Effect } from 'effect';
import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis } from 'ioredis';
import {
	createAcuityServiceCatalog,
	parseStaticServicesJson,
	type ServiceCatalogRedisL2,
} from '../shared/acuity-service-catalog.js';
import { getCached as redisL2GetCached, RedisL2 } from '../shared/redis-l2.js';
import {
	createInMemoryBridgeAsyncStore,
	type BridgeAsyncStore,
} from '../async/store.js';
import { createPostgresBridgeAsyncStore } from '../async/postgres-store.js';
import { createRedisBridgeAsyncStore } from '../async/redis-store.js';
import { parseRedisAsyncJobTtlSeconds } from '../async/config.js';
import {
	createPostgresFlowJournal,
	parseFlowJournalPurgeIntervalMs,
	parseFlowJournalTtlSeconds,
	DEFAULT_FLOW_JOURNAL_TTL_SECONDS,
	type PostgresFlowJournal,
} from '../flow/index.js';
import {
	createAcuityBridgeJobExecutor,
	runBridgeWorkerLoop,
} from './worker.js';
import {
	ACUITY_BASE_URL,
	SERVICE_CACHE_TTL_MS,
	scraperConfig,
} from './config.js';
import {
	createServiceCatalogLogger,
	describeLogValue,
	logEvent,
} from './http.js';

const BRIDGE_DATABASE_URL = process.env.BRIDGE_DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const BRIDGE_INLINE_WORKER_ENABLED = (() => {
	const raw = process.env.BRIDGE_INLINE_WORKER_ENABLED;
	if (raw === 'true') return true;
	if (raw === 'false') return false;
	return Boolean(BRIDGE_DATABASE_URL || REDIS_URL);
})();

export const redisClient: IORedis | null = REDIS_URL
	? new IORedisImpl(REDIS_URL, {
			password: REDIS_PASSWORD,
			maxRetriesPerRequest: 3,
		})
	: null;

// Declare which cache tier is active at boot so operators can diagnose silent
// L1-only degradation (e.g. REDIS_URL accidentally unset in prod) from logs
// alone, without having to probe the running process.
logEvent('INFO', 'Cache mode selected', {
	event: 'cache_mode_selected',
	mode: redisClient ? 'l1+l2' : 'l1-only',
	redisConfigured: Boolean(process.env.REDIS_URL),
});

if (redisClient) {
	redisClient.on('error', (e) => {
		logEvent('ERROR', 'Redis L2 client error', {
			event: 'redis_client_error',
			error: describeLogValue(e),
		});
	});
}

const serviceCatalogRedisL2: ServiceCatalogRedisL2 | undefined = redisClient
	? {
			getCached: <A>(
				key: string,
				ttlSeconds: number,
				mk: Effect.Effect<A>,
			): Effect.Effect<A> => {
				const mkPromise = (): Promise<A> => Effect.runPromise(mk);
				// Provide the RedisL2 service for the real `getCached`, then erase
				// the `RedisError | CacheTimeoutError` channel so the result fits
				// the `Effect.Effect<A>` shape expected by the catalog. Defects
				// propagate as rejections through `Effect.runPromise` in the
				// catalog, preserving the error-surface contract documented in
				// `acuity-service-catalog.ts`.
				return redisL2GetCached(key, ttlSeconds, mkPromise).pipe(
					Effect.provideService(RedisL2, redisClient),
					Effect.orDie,
				);
			},
		}
	: undefined;

export const serviceCatalog = createAcuityServiceCatalog({
	baseUrl: ACUITY_BASE_URL,
	cacheTtlMs: SERVICE_CACHE_TTL_MS,
	staticServices: parseStaticServicesJson(process.env.SERVICES_JSON),
	scraperConfig,
	logger: createServiceCatalogLogger(),
	redisL2: serviceCatalogRedisL2,
});

let closeBridgeAsyncStore: (() => Promise<void>) | null = null;

const createBridgeAsyncStore = (): BridgeAsyncStore => {
	if (BRIDGE_DATABASE_URL) {
		const store = createPostgresBridgeAsyncStore({
			connectionString: BRIDGE_DATABASE_URL,
			ssl: process.env.BRIDGE_DATABASE_SSL === 'true',
			migrate: process.env.BRIDGE_DATABASE_MIGRATE !== 'false',
		});
		closeBridgeAsyncStore = store.close;
		void store.ready().catch((error) => {
			logEvent('ERROR', 'Bridge async Postgres store migration failed', {
				event: 'bridge_async_store_ready_failed',
				error: describeLogValue(error),
			});
		});
		logEvent('INFO', 'Bridge async store selected', {
			event: 'bridge_async_store_selected',
			mode: 'postgres',
			migrate: process.env.BRIDGE_DATABASE_MIGRATE !== 'false',
		});
		return store;
	}
	if (redisClient) {
		const store = createRedisBridgeAsyncStore({
			client: redisClient,
			keyPrefix: process.env.BRIDGE_REDIS_ASYNC_PREFIX,
			jobTtlSeconds: parseRedisAsyncJobTtlSeconds(),
		});
		void store.ready().catch((error) => {
			logEvent('ERROR', 'Bridge async Redis store readiness failed', {
				event: 'bridge_async_store_ready_failed',
				error: describeLogValue(error),
			});
		});
		logEvent('INFO', 'Bridge async store selected', {
			event: 'bridge_async_store_selected',
			mode: 'redis',
		});
		return store;
	}
	logEvent('INFO', 'Bridge async store selected', {
		event: 'bridge_async_store_selected',
		mode: 'memory',
	});
	return createInMemoryBridgeAsyncStore();
};

export let bridgeAsyncStore: BridgeAsyncStore = createBridgeAsyncStore();
let inlineWorkerAbortController: AbortController | null = null;

// ─── Flow journal TTL purge (design §5 "PII hygiene": "a TTL purge job bounds
// retention"; risk 9) ────────────────────────────────────────────────────────
//
// Redis journal keys carry retention via EXPIRE-per-append (redis-journal.ts), so
// no sweep is needed there. The Postgres `flow_checkpoints` table needs an explicit
// periodic DELETE of rows older than the retention TTL. The sweep is tied to the
// inline worker lifecycle (only the replica running the worker owns this chore) and
// runs only when a Postgres journal is in play (BRIDGE_DATABASE_URL set). The
// interval handle is unref'd so it never holds the process open.
let flowJournalPurgeTimer: ReturnType<typeof setInterval> | null = null;
let flowJournalPurgeHandle: PostgresFlowJournal | null = null;

const flowJournalRetentionSeconds = (): number =>
	parseFlowJournalTtlSeconds() ?? DEFAULT_FLOW_JOURNAL_TTL_SECONDS;

/**
 * One-shot manual purge of expired Postgres flow-journal checkpoints — the
 * ops-facing entry point. Returns the deleted-row count (0 when no Postgres journal
 * is configured). Safe to call independently of the periodic sweep.
 */
export const purgeFlowJournalCheckpoints = async (): Promise<number> => {
	if (!BRIDGE_DATABASE_URL) return 0;
	const handle =
		flowJournalPurgeHandle ??
		createPostgresFlowJournal({
			connectionString: BRIDGE_DATABASE_URL,
			ssl: process.env.BRIDGE_DATABASE_SSL === 'true',
			// Ensure the flow_checkpoints table exists (idempotent `create table if not
			// exists`) so the purge never errors on a DB where the flow runner has not
			// yet created it; the ready gate runs the DDL before the first DELETE.
			migrate: process.env.BRIDGE_DATABASE_MIGRATE !== 'false',
		});
	flowJournalPurgeHandle ??= handle;
	return handle.purgeExpiredCheckpoints(flowJournalRetentionSeconds());
};

const startFlowJournalPurge = () => {
	if (!BRIDGE_DATABASE_URL || flowJournalPurgeTimer) return;
	const intervalMs = parseFlowJournalPurgeIntervalMs();
	const sweep = () => {
		void purgeFlowJournalCheckpoints()
			.then((deleted) => {
				if (deleted > 0) {
					logEvent('INFO', 'Flow journal TTL purge swept rows', {
						event: 'flow_journal_purge_swept',
						deleted,
						retentionSeconds: flowJournalRetentionSeconds(),
					});
				}
			})
			.catch((error) => {
				logEvent('ERROR', 'Flow journal TTL purge failed', {
					event: 'flow_journal_purge_failed',
					error: describeLogValue(error),
				});
			});
	};
	flowJournalPurgeTimer = setInterval(sweep, intervalMs);
	flowJournalPurgeTimer.unref?.();
	logEvent('INFO', 'Flow journal TTL purge started', {
		event: 'flow_journal_purge_started',
		intervalMs,
		retentionSeconds: flowJournalRetentionSeconds(),
	});
	// Kick an immediate first sweep so a long interval does not delay initial cleanup.
	sweep();
};

const stopFlowJournalPurge = () => {
	if (flowJournalPurgeTimer) {
		clearInterval(flowJournalPurgeTimer);
		flowJournalPurgeTimer = null;
	}
	if (flowJournalPurgeHandle?.close) {
		void flowJournalPurgeHandle.close().catch(() => undefined);
	}
	flowJournalPurgeHandle = null;
};

export const startInlineWorker = () => {
	if (!BRIDGE_INLINE_WORKER_ENABLED || inlineWorkerAbortController) return;
	inlineWorkerAbortController = new AbortController();
	const workerId = `${process.env.HOSTNAME ?? `pid-${process.pid}`}:inline`;
	void runBridgeWorkerLoop(
		bridgeAsyncStore,
		createAcuityBridgeJobExecutor({ redisClient }),
		{
			workerId,
			signal: inlineWorkerAbortController.signal,
		},
	).catch((error) => {
		if (inlineWorkerAbortController?.signal.aborted) return;
		logEvent('ERROR', 'Inline bridge worker failed', {
			event: 'bridge_inline_worker_failed',
			workerId,
			error: describeLogValue(error),
		});
	});
	logEvent('INFO', 'Inline bridge worker started', {
		event: 'bridge_inline_worker_started',
		workerId,
		store: BRIDGE_DATABASE_URL ? 'postgres' : redisClient ? 'redis' : 'memory',
	});
	// The replica running the inline worker also owns the Postgres journal TTL purge.
	startFlowJournalPurge();
};

export const stopInlineWorker = () => {
	stopFlowJournalPurge();
	if (!inlineWorkerAbortController) return;
	inlineWorkerAbortController.abort();
	inlineWorkerAbortController = null;
};

export const __setBridgeAsyncStoreForTest = (
	store: BridgeAsyncStore | null,
) => {
	stopInlineWorker();
	if (closeBridgeAsyncStore) {
		void closeBridgeAsyncStore().catch(() => undefined);
		closeBridgeAsyncStore = null;
	}
	bridgeAsyncStore = store ?? createInMemoryBridgeAsyncStore();
};

export const disposeRedisClient = () => {
	if (!redisClient) return;
	void redisClient.quit().catch(() => undefined);
};

export const disposeBridgeAsyncStore = () => {
	if (!closeBridgeAsyncStore) return;
	void closeBridgeAsyncStore().catch(() => undefined);
	closeBridgeAsyncStore = null;
};
