import { describe, expect, it } from 'vitest';
import { createPageConcurrencyLimiter } from './browser-service.js';
import { metrics } from './metrics.js';

const pageAcquireCount = async (outcome: string): Promise<number> => {
	const snap = await metrics.browserPageAcquireDuration.get();
	return (
		snap.values.find(
			(v) =>
				v.metricName === 'acuity_browser_page_acquire_duration_seconds_count' &&
				v.labels.outcome === outcome,
		)?.value ?? 0
	);
};

const timeoutCount = async (): Promise<number> => {
	const snap = await metrics.browserPageAcquireTimeoutsTotal.get();
	return (snap.values[0]?.value as number | undefined) ?? 0;
};

const limiterGauge = async (metricName: string): Promise<number> => {
	const metric = metrics.registry.getSingleMetric(metricName);
	const snap = await metric?.get();
	return (snap?.values[0]?.value as number | undefined) ?? 0;
};

describe('createPageConcurrencyLimiter', () => {
	it('queues page acquisition beyond the configured per-process cap', async () => {
		const limiter = createPageConcurrencyLimiter();
		const acquireBefore = await pageAcquireCount('success');
		const releaseFirst = await limiter.acquire(1, 1000);
		let secondAcquired = false;

		const second = limiter.acquire(1, 1000).then((release) => {
			secondAcquired = true;
			return release;
		});

		await Promise.resolve();
		expect(secondAcquired).toBe(false);
		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(1);
		expect(await limiterGauge('acuity_browser_page_limiter_active')).toBe(1);
		expect(await limiterGauge('acuity_browser_page_limiter_queued')).toBe(1);

		releaseFirst();
		const releaseSecond = await second;
		expect(secondAcquired).toBe(true);
		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(0);

		releaseSecond();
		expect(limiter.active()).toBe(0);
		expect(await limiterGauge('acuity_browser_page_limiter_active')).toBe(0);
		expect(await limiterGauge('acuity_browser_page_limiter_queued')).toBe(0);
		expect(await pageAcquireCount('success')).toBe(acquireBefore + 2);
	});

	it('times out queued page acquisition without leaking queue state', async () => {
		const limiter = createPageConcurrencyLimiter();
		const timeoutBefore = await timeoutCount();
		const releaseFirst = await limiter.acquire(1, 1000);

		await expect(limiter.acquire(1, 5)).rejects.toThrow(
			'Timed out waiting for bridge browser page slot',
		);

		expect(limiter.active()).toBe(1);
		expect(limiter.queued()).toBe(0);
		expect(await limiterGauge('acuity_browser_page_limiter_active')).toBe(1);
		expect(await limiterGauge('acuity_browser_page_limiter_queued')).toBe(0);
		expect(await timeoutCount()).toBe(timeoutBefore + 1);
		releaseFirst();
		expect(limiter.active()).toBe(0);
		expect(await limiterGauge('acuity_browser_page_limiter_active')).toBe(0);
	});
});
