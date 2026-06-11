import { Effect } from 'effect';
import {
	Counter,
	Gauge,
	Histogram,
	Registry,
	collectDefaultMetrics,
} from 'prom-client';

/**
 * Prometheus metrics registry for the acuity-middleware bridge.
 *
 * Scope: Kubernetes phase 1.0 observability. SLIs are the canonical set
 * enumerated in spec §6.1. TIN-92 adds page-limiter metrics so K8s HPA
 * decisions can distinguish browser-slot contention from upstream Acuity cost.
 *
 * The `Registry` is a module-level singleton. In tests, a shared registry
 * means counters accumulate across files — assertions should be written as
 * deltas (e.g. `after - before === 1`) rather than absolute values.
 */

const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'acuity_' });

const browserActiveSessions = new Gauge({
	name: 'acuity_browser_active_sessions',
	help: 'Current number of open Playwright browser contexts',
	registers: [registry],
});

const browserPageLimiterActive = new Gauge({
	name: 'acuity_browser_page_limiter_active',
	help: 'Current number of acquired browser page concurrency slots',
	registers: [registry],
});

const browserPageLimiterQueued = new Gauge({
	name: 'acuity_browser_page_limiter_queued',
	help: 'Current number of requests waiting for a browser page concurrency slot',
	registers: [registry],
});

const browserPageAcquireDuration = new Histogram({
	name: 'acuity_browser_page_acquire_duration_seconds',
	help: 'Time spent waiting to acquire a browser page concurrency slot',
	labelNames: ['outcome'],
	buckets: [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
	registers: [registry],
});

const browserPageAcquireTimeoutsTotal = new Counter({
	name: 'acuity_browser_page_acquire_timeouts_total',
	help: 'Browser page concurrency slot acquisition timeouts',
	registers: [registry],
});

const pageOperationsDuration = new Histogram({
	name: 'acuity_page_operations_duration_seconds',
	help: 'Duration of Playwright page operations',
	labelNames: ['operation'],
	buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
	registers: [registry],
});

const cacheHitRatio = new Gauge({
	name: 'acuity_cache_hit_ratio',
	help: 'Derived: l1_hits / (l1_hits + l2_hits + misses)',
	registers: [registry],
});

const serviceCatalogScrapeTotal = new Counter({
	name: 'acuity_service_catalog_scrape_total',
	help: 'Service catalog scrapes, labelled by whether this pod was the lock winner',
	labelNames: ['source'],
	registers: [registry],
});

const serviceCatalogRefreshDuration = new Histogram({
	name: 'acuity_service_catalog_refresh_duration_seconds',
	help: 'Wall time to scrape Acuity service catalog',
	buckets: [0.5, 1, 2, 5, 10, 30, 60],
	registers: [registry],
});

const bridgeReadCacheEventsTotal = new Counter({
	name: 'acuity_bridge_read_cache_events_total',
	help: 'Bridge availability read cache events by cache kind and event',
	labelNames: ['cache_kind', 'event'],
	registers: [registry],
});

const bridgeReadCacheWaitDuration = new Histogram({
	name: 'acuity_bridge_read_cache_wait_duration_seconds',
	help: 'Time spent waiting for another bridge reader to publish a cached value',
	labelNames: ['cache_kind', 'outcome'],
	buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
	registers: [registry],
});

const bridgeReadDuration = new Histogram({
	name: 'acuity_bridge_read_duration_seconds',
	help: 'Wall time for uncached bridge availability reads',
	labelNames: ['cache_kind'],
	buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
	registers: [registry],
});

const availabilitySnapshotServedTotal = new Counter({
	name: 'acuity_availability_snapshot_served_total',
	help: 'Availability snapshots served on the request path by kind and freshness',
	labelNames: ['kind', 'freshness'],
	registers: [registry],
});

const availabilitySnapshotReadDuration = new Histogram({
	name: 'acuity_availability_snapshot_read_duration_seconds',
	help: 'Wall time for durable availability snapshot store reads by kind, freshness, and outcome',
	labelNames: ['kind', 'freshness', 'outcome'],
	buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	registers: [registry],
});

const availabilityHeartbeatJobsTotal = new Counter({
	name: 'acuity_availability_heartbeat_jobs_total',
	help: 'Availability heartbeat decisions by snapshot kind and action',
	labelNames: ['kind', 'action'],
	registers: [registry],
});

const availabilityReadinessChecksTotal = new Counter({
	name: 'acuity_availability_readiness_checks_total',
	help: 'Availability readiness checks by result',
	labelNames: ['result'],
	registers: [registry],
});

const availabilityReadinessScopeTotal = new Counter({
	name: 'acuity_availability_readiness_scope_total',
	help: 'Availability readiness scope classifications by snapshot kind and freshness',
	labelNames: ['kind', 'freshness'],
	registers: [registry],
});

const bridgeQueueDepth = new Gauge({
	name: 'acuity_bridge_queue_depth',
	help: 'Bridge async queue depth by job kind and status',
	labelNames: ['kind', 'status'],
	registers: [registry],
});

const bridgeQueueOldestAgeSeconds = new Gauge({
	name: 'acuity_bridge_queue_oldest_age_seconds',
	help: 'Oldest ready bridge async queue item age by job kind',
	labelNames: ['kind'],
	registers: [registry],
});

const availabilitySnapshotAgeSeconds = new Gauge({
	name: 'acuity_availability_snapshot_age_seconds',
	help: 'Age of availability snapshots considered by readiness checks',
	labelNames: ['kind', 'service_id', 'scope'],
	registers: [registry],
});

// ─── Derived cache hit-ratio ─────────────────────────────────────────────────
//
// `cacheHitRatio` is a derived gauge — prom-client cannot compute it for us,
// so we keep module-scoped hit/miss counters and refresh the gauge on every
// mutation. A "hit" is either an L1 in-process cache return or an L2 GET
// that resolved to a cached value; a "miss" is any path that ended up
// running the scrape / mk closure.
//
// Counters are module-scoped by design: they must persist across requests so
// the gauge reflects steady-state behaviour rather than per-request bursts.
// Before any traffic has been observed the gauge is set to 1.0 so alerts that
// fire on `acuity_cache_hit_ratio < 0.8` do not page on a freshly-started pod
// with no samples.

let cacheHitCount = 0;
let cacheMissCount = 0;

cacheHitRatio.set(1);

const refreshCacheHitRatio = () => {
	const total = cacheHitCount + cacheMissCount;
	if (total === 0) {
		cacheHitRatio.set(1);
		return;
	}
	cacheHitRatio.set(cacheHitCount / total);
};

/** Record a cache hit (L1 in-process buffer or L2 networked cache). */
export const recordCacheHit = (): void => {
	cacheHitCount += 1;
	refreshCacheHitRatio();
};

/** Record a cache miss (fell through to scrape / mk closure). */
export const recordCacheMiss = (): void => {
	cacheMissCount += 1;
	refreshCacheHitRatio();
};

/**
 * Test-only helper to reset the hit/miss accumulators so assertions can pin
 * the initial ratio. Module-level singletons accumulate across vitest files,
 * so production code must never rely on this function.
 */
export const _resetCacheHitRatioForTests = (): void => {
	cacheHitCount = 0;
	cacheMissCount = 0;
	cacheHitRatio.set(1);
};

export const recordBridgeReadCacheEvent = (
	cacheKind: string,
	event: string,
): void => {
	bridgeReadCacheEventsTotal.inc({ cache_kind: cacheKind, event });
};

export const setBrowserPageLimiterState = (
	active: number,
	queued: number,
): void => {
	browserPageLimiterActive.set(Math.max(0, active));
	browserPageLimiterQueued.set(Math.max(0, queued));
};

export const recordBrowserPageAcquire = (
	outcome: 'success' | 'timeout',
	waitMs: number,
): void => {
	browserPageAcquireDuration.observe({ outcome }, Math.max(0, waitMs) / 1000);
	if (outcome === 'timeout') {
		browserPageAcquireTimeoutsTotal.inc();
	}
};

export const recordBridgeReadCacheWait = (
	cacheKind: string,
	outcome: 'hit' | 'timeout',
	waitMs: number,
): void => {
	bridgeReadCacheWaitDuration.observe(
		{ cache_kind: cacheKind, outcome },
		Math.max(0, waitMs) / 1000,
	);
};

export const observeBridgeRead = async <A>(
	cacheKind: string,
	fn: () => Promise<A>,
): Promise<A> => {
	const end = bridgeReadDuration.startTimer({ cache_kind: cacheKind });
	try {
		return await fn();
	} finally {
		end();
	}
};

export const recordAvailabilitySnapshotServed = (
	kind: string,
	freshness: 'fresh' | 'stale',
): void => {
	availabilitySnapshotServedTotal.inc({ kind, freshness });
};

export const recordAvailabilitySnapshotRead = (
	kind: string,
	freshness: 'fresh' | 'stale' | 'expired' | 'missing' | 'error',
	outcome: 'hit' | 'miss' | 'error',
	durationMs: number,
): void => {
	availabilitySnapshotReadDuration.observe(
		{ kind, freshness, outcome },
		Math.max(0, durationMs) / 1000,
	);
};

export const recordAvailabilityHeartbeatJob = (
	kind: string,
	action:
		| 'queued'
		| 'deduped'
		| 'requeued'
		| 'skipped_fresh'
		| 'skipped_limit'
		| 'skipped_terminal'
		| 'requeue_failed',
): void => {
	availabilityHeartbeatJobsTotal.inc({ kind, action });
};

export const recordAvailabilityReadinessCheck = (ready: boolean): void => {
	availabilityReadinessChecksTotal.inc({
		result: ready ? 'ready' : 'not_ready',
	});
};

export const recordAvailabilityReadinessScope = (
	kind: string,
	freshness: 'fresh' | 'stale' | 'expired' | 'missing',
): void => {
	availabilityReadinessScopeTotal.inc({ kind, freshness });
};

export const setBridgeQueueDepth = (
	kind: string,
	status: string,
	count: number,
): void => {
	bridgeQueueDepth.set({ kind, status }, Math.max(0, count));
};

export const setBridgeQueueOldestAge = (
	kind: string,
	ageMs: number | undefined,
): void => {
	bridgeQueueOldestAgeSeconds.set({ kind }, Math.max(0, ageMs ?? 0) / 1000);
};

export const setAvailabilitySnapshotAge = (
	kind: string,
	serviceId: string,
	scope: string,
	ageMs: number | undefined,
): void => {
	availabilitySnapshotAgeSeconds.set(
		{ kind, service_id: serviceId, scope },
		Math.max(0, ageMs ?? 0) / 1000,
	);
};

// ─── Page-operation timer helper ─────────────────────────────────────────────
//
// Keep label cardinality low: `operation` should be a small enum of
// high-level step names (e.g. `availability_dates`, `availability_slots`,
// `scrape_catalog`, `wizard_navigate`). Never label per-service_id or per-url.

/** Observe a Playwright/page operation's wall time. Handles Promise success + failure. */
export const observePageOp = async <A>(
	operation: string,
	fn: () => Promise<A>,
): Promise<A> => {
	const end = pageOperationsDuration.startTimer({ operation });
	try {
		return await fn();
	} finally {
		end();
	}
};

/**
 * Effect combinator variant of `observePageOp` — times an Effect program and
 * observes its wall time into `pageOperationsDuration`. Uses `Effect.acquireUseRelease`
 * so that interruption still records a sample.
 */
export const observePageOpEffect = <A, E, R>(
	operation: string,
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => pageOperationsDuration.startTimer({ operation })),
		() => effect,
		(end) => Effect.sync(() => end()),
	);

// ─── Browser session lifecycle helper ────────────────────────────────────────
//
// Tracks the number of currently-active Playwright pages / contexts by
// wrapping a scoped Effect with acquireUseRelease. Callers must use this
// combinator instead of calling `.inc()` / `.dec()` directly so the
// release path runs even on interrupt.

export const trackBrowserSession = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.acquireUseRelease(
		Effect.sync(() => browserActiveSessions.inc()),
		() => effect,
		() => Effect.sync(() => browserActiveSessions.dec()),
	);

export const metrics = {
	registry,
	browserActiveSessions,
	browserPageLimiterActive,
	browserPageLimiterQueued,
	browserPageAcquireDuration,
	browserPageAcquireTimeoutsTotal,
	pageOperationsDuration,
	cacheHitRatio,
	serviceCatalogScrapeTotal,
	serviceCatalogRefreshDuration,
	bridgeReadCacheEventsTotal,
	bridgeReadCacheWaitDuration,
	bridgeReadDuration,
	availabilitySnapshotServedTotal,
	availabilitySnapshotReadDuration,
	availabilityHeartbeatJobsTotal,
	availabilityReadinessChecksTotal,
	availabilityReadinessScopeTotal,
	bridgeQueueDepth,
	bridgeQueueOldestAgeSeconds,
	availabilitySnapshotAgeSeconds,
	recordCacheHit,
	recordCacheMiss,
	setBrowserPageLimiterState,
	recordBrowserPageAcquire,
	recordBridgeReadCacheEvent,
	recordBridgeReadCacheWait,
	observeBridgeRead,
	recordAvailabilitySnapshotServed,
	recordAvailabilitySnapshotRead,
	recordAvailabilityHeartbeatJob,
	recordAvailabilityReadinessCheck,
	recordAvailabilityReadinessScope,
	setBridgeQueueDepth,
	setBridgeQueueOldestAge,
	setAvailabilitySnapshotAge,
	observePageOp,
	observePageOpEffect,
	trackBrowserSession,
};

export const renderMetrics = (): Promise<string> => registry.metrics();
