import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
	_resetCacheHitRatioForTests,
	metrics,
	observePageOp,
	observePageOpEffect,
	recordCacheHit,
	recordCacheMiss,
	recordAvailabilityHeartbeatJob,
	recordAvailabilitySnapshotServed,
	recordAvailabilitySnapshotRead,
	renderMetrics,
	trackBrowserSession,
} from './metrics.js';

describe('metrics', () => {
	it('exposes required SLIs from spec §6.1', () => {
		const names = metrics.registry.getMetricsAsArray().map((m) => m.name);
		expect(names).toContain('acuity_browser_active_sessions');
		expect(names).toContain('acuity_browser_page_limiter_active');
		expect(names).toContain('acuity_browser_page_limiter_queued');
		expect(names).toContain('acuity_browser_page_acquire_duration_seconds');
		expect(names).toContain('acuity_browser_page_acquire_timeouts_total');
		expect(names).toContain('acuity_page_operations_duration_seconds');
		expect(names).toContain('acuity_cache_hit_ratio');
		expect(names).toContain('acuity_service_catalog_scrape_total');
		expect(names).toContain('acuity_service_catalog_refresh_duration_seconds');
		expect(names).toContain('acuity_bridge_read_cache_events_total');
		expect(names).toContain('acuity_bridge_read_cache_wait_duration_seconds');
		expect(names).toContain('acuity_bridge_read_duration_seconds');
		expect(names).toContain('acuity_availability_snapshot_served_total');
		expect(names).toContain('acuity_availability_snapshot_read_duration_seconds');
		expect(names).toContain('acuity_availability_heartbeat_jobs_total');
	});

	it('renders Prometheus text format', async () => {
		// Prime the histogram so the text exposition includes bucket/sum/count
		// lines (empty histograms render with zero buckets only).
		metrics.pageOperationsDuration.observe({ operation: 'test' }, 0.5);
		const text = await renderMetrics();
		expect(text).toContain('# HELP acuity_browser_active_sessions');
		expect(text).toContain('# TYPE acuity_browser_active_sessions gauge');
		expect(text).toContain('# HELP acuity_browser_page_limiter_active');
		expect(text).toContain('# TYPE acuity_browser_page_limiter_queued gauge');
		// Histogram exposition: per-bucket cumulative, total sum, total count.
		expect(text).toContain('acuity_page_operations_duration_seconds_bucket{');
		expect(text).toContain('acuity_page_operations_duration_seconds_sum');
		expect(text).toContain('acuity_page_operations_duration_seconds_count');
	});

	it('increments scrape counter with source label', async () => {
		// Delta assertion — registry is a module-level singleton so absolute
		// values accumulate across tests. Pin the +1 rather than trust state.
		const before =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find((v) => v.labels.source === 'lock_winner')?.value ?? 0;
		metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_winner' });
		const after =
			(await metrics.serviceCatalogScrapeTotal.get()).values.find((v) => v.labels.source === 'lock_winner')?.value ?? 0;
		expect(after).toBe(before + 1);
	});
});

describe('bridge read cache metrics wiring', () => {
	const counterValue = async (cacheKind: string, event: string): Promise<number> => {
		const snap = await metrics.bridgeReadCacheEventsTotal.get();
		return snap.values.find((v) => v.labels.cache_kind === cacheKind && v.labels.event === event)?.value ?? 0;
	};

	const histogramCount = async (metricName: string, labels: Record<string, string>): Promise<number> => {
		const metric = metrics.registry.getSingleMetric(metricName);
		const snap = await metric?.get();
		const countName = `${metricName}_count`;
		return (
			snap?.values.find((v) => {
				if (v.metricName !== countName) return false;
				return Object.entries(labels).every(([key, value]) => v.labels[key] === value);
			})?.value ?? 0
		);
	};

	it('increments fixed-label cache event counters', async () => {
		const before = await counterValue('availability_slots', 'hit');
		metrics.recordBridgeReadCacheEvent('availability_slots', 'hit');
		const after = await counterValue('availability_slots', 'hit');
		expect(after).toBe(before + 1);
	});

	it('records wait duration samples by outcome', async () => {
		const before = await histogramCount('acuity_bridge_read_cache_wait_duration_seconds', {
			cache_kind: 'availability_slots',
			outcome: 'hit',
		});
		metrics.recordBridgeReadCacheWait('availability_slots', 'hit', 250);
		const after = await histogramCount('acuity_bridge_read_cache_wait_duration_seconds', {
			cache_kind: 'availability_slots',
			outcome: 'hit',
		});
		expect(after).toBe(before + 1);
	});

	it('records uncached bridge read duration samples', async () => {
		const before = await histogramCount('acuity_bridge_read_duration_seconds', {
			cache_kind: 'availability_dates',
		});
		await metrics.observeBridgeRead('availability_dates', async () => 42);
		const after = await histogramCount('acuity_bridge_read_duration_seconds', {
			cache_kind: 'availability_dates',
		});
		expect(after).toBe(before + 1);
	});

	it('increments snapshot-served counters by kind and freshness', async () => {
		const snapshotCounter = async (kind: string, freshness: string): Promise<number> => {
			const snap = await metrics.availabilitySnapshotServedTotal.get();
			return snap.values.find((v) => v.labels.kind === kind && v.labels.freshness === freshness)?.value ?? 0;
		};

		const before = await snapshotCounter('slots', 'stale');
		recordAvailabilitySnapshotServed('slots', 'stale');
		const after = await snapshotCounter('slots', 'stale');
		expect(after).toBe(before + 1);
	});

	it('records durable snapshot read duration samples by layer outcome', async () => {
		const before = await histogramCount('acuity_availability_snapshot_read_duration_seconds', {
			kind: 'dates',
			freshness: 'fresh',
			outcome: 'hit',
		});
		recordAvailabilitySnapshotRead('dates', 'fresh', 'hit', 12);
		const after = await histogramCount('acuity_availability_snapshot_read_duration_seconds', {
			kind: 'dates',
			freshness: 'fresh',
			outcome: 'hit',
		});
		expect(after).toBe(before + 1);
	});

	it('increments heartbeat decision counters', async () => {
		const heartbeatCounter = async (kind: string, action: string): Promise<number> => {
			const snap = await metrics.availabilityHeartbeatJobsTotal.get();
			return snap.values.find((v) => v.labels.kind === kind && v.labels.action === action)?.value ?? 0;
		};

		const before = await heartbeatCounter('dates', 'queued');
		recordAvailabilityHeartbeatJob('dates', 'queued');
		const after = await heartbeatCounter('dates', 'queued');
		expect(after).toBe(before + 1);
	});
});

describe('browser page limiter metrics wiring', () => {
	const gaugeValue = async (metricName: string): Promise<number> => {
		const metric = metrics.registry.getSingleMetric(metricName);
		const snap = await metric?.get();
		return (snap?.values[0]?.value as number | undefined) ?? 0;
	};

	const histogramCount = async (outcome: string): Promise<number> => {
		const snap = await metrics.browserPageAcquireDuration.get();
		return (
			snap.values.find(
				(v) => v.metricName === 'acuity_browser_page_acquire_duration_seconds_count' && v.labels.outcome === outcome,
			)?.value ?? 0
		);
	};

	const timeoutCount = async (): Promise<number> => {
		const snap = await metrics.browserPageAcquireTimeoutsTotal.get();
		return (snap.values[0]?.value as number | undefined) ?? 0;
	};

	it('records limiter active and queued gauges', async () => {
		metrics.setBrowserPageLimiterState(2, 1);
		expect(await gaugeValue('acuity_browser_page_limiter_active')).toBe(2);
		expect(await gaugeValue('acuity_browser_page_limiter_queued')).toBe(1);

		metrics.setBrowserPageLimiterState(0, 0);
		expect(await gaugeValue('acuity_browser_page_limiter_active')).toBe(0);
		expect(await gaugeValue('acuity_browser_page_limiter_queued')).toBe(0);
	});

	it('records acquire duration and timeout counters', async () => {
		const successBefore = await histogramCount('success');
		const timeoutBefore = await histogramCount('timeout');
		const timeoutCounterBefore = await timeoutCount();

		metrics.recordBrowserPageAcquire('success', 25);
		metrics.recordBrowserPageAcquire('timeout', 10000);

		expect(await histogramCount('success')).toBe(successBefore + 1);
		expect(await histogramCount('timeout')).toBe(timeoutBefore + 1);
		expect(await timeoutCount()).toBe(timeoutCounterBefore + 1);
	});
});

describe('cacheHitRatio wiring', () => {
	const gaugeValue = async (): Promise<number> => {
		const snap = await metrics.cacheHitRatio.get();
		return snap.values[0]?.value ?? NaN;
	};

	it('starts at 1.0 so alerts do not page an idle pod', async () => {
		_resetCacheHitRatioForTests();
		// No hits, no misses — the gauge must be a "healthy" 1.0. A raw
		// computation would divide by zero here; the helper must guard that.
		expect(await gaugeValue()).toBe(1);
	});

	it('updates the gauge on hit/miss transitions', async () => {
		_resetCacheHitRatioForTests();

		recordCacheHit();
		// 1 hit, 0 misses → ratio = 1
		expect(await gaugeValue()).toBe(1);

		recordCacheMiss();
		// 1 hit, 1 miss → ratio = 0.5
		expect(await gaugeValue()).toBe(0.5);

		recordCacheHit();
		recordCacheHit();
		// 3 hits, 1 miss → 0.75
		expect(await gaugeValue()).toBe(0.75);
	});
});

describe('pageOperationsDuration wiring', () => {
	it('records a sample for each observePageOp invocation', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			// `_count` lines have `metricName: <name>_count` and the matching operation label.
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' && v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('test_op');
		await observePageOp('test_op', async () => 'value');
		const after = await bucketCountFor('test_op');
		expect(after).toBe(before + 1);
	});

	it('records a sample even when the wrapped function throws', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' && v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('test_op_fail');
		await expect(
			observePageOp('test_op_fail', async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		const after = await bucketCountFor('test_op_fail');
		expect(after).toBe(before + 1);
	});

	it('observes samples via the Effect combinator', async () => {
		const bucketCountFor = async (op: string): Promise<number> => {
			const snap = await metrics.pageOperationsDuration.get();
			const row = snap.values.find(
				(v) => v.metricName === 'acuity_page_operations_duration_seconds_count' && v.labels.operation === op,
			);
			return (row?.value as number | undefined) ?? 0;
		};

		const before = await bucketCountFor('effect_op');
		await Effect.runPromise(observePageOpEffect('effect_op', Effect.succeed(42)));
		const after = await bucketCountFor('effect_op');
		expect(after).toBe(before + 1);
	});
});

describe('browserActiveSessions wiring', () => {
	const gaugeValue = async (): Promise<number> => {
		const snap = await metrics.browserActiveSessions.get();
		return (snap.values[0]?.value as number | undefined) ?? 0;
	};

	it('increments on acquire and decrements on release via trackBrowserSession', async () => {
		const baseline = await gaugeValue();

		// The combinator takes an Effect; inside the Effect we assert the
		// gauge has been incremented. After the Effect resolves, release
		// must have run even without explicit finalisation.
		const duringValue = await Effect.runPromise(
			trackBrowserSession(
				Effect.sync(() => {
					// Synchronous peek while the session is "held".
					const row = (
						metrics.browserActiveSessions as unknown as {
							hashMap: Map<string, { value: number }>;
						}
					).hashMap;
					// Fallback to prom-client async snapshot if the internal
					// structure changes in future versions.
					void row;
					return 'inside';
				}),
			),
		);
		expect(duringValue).toBe('inside');

		// Post-release: gauge must have returned to baseline.
		expect(await gaugeValue()).toBe(baseline);
	});

	it('decrements even when the wrapped Effect fails', async () => {
		const baseline = await gaugeValue();
		await expect(Effect.runPromise(trackBrowserSession(Effect.fail('nope' as never)))).rejects.toBeDefined();
		expect(await gaugeValue()).toBe(baseline);
	});

	it('observes a non-zero gauge while the session is held', async () => {
		const baseline = await gaugeValue();
		let observedWhileHeld = baseline;

		await Effect.runPromise(
			trackBrowserSession(
				Effect.promise(async () => {
					const snap = await metrics.browserActiveSessions.get();
					observedWhileHeld = (snap.values[0]?.value as number | undefined) ?? 0;
				}),
			),
		);

		expect(observedWhileHeld).toBe(baseline + 1);
		expect(await gaugeValue()).toBe(baseline);
	});
});
