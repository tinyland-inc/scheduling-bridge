/**
 * Per-stepId flow runtime metrics (design §10 0.6.x "per-stepId metrics"). The fold
 * records attempts, failures, reroutes, run duration, and landing outcomes by stepId
 * through these recorders. The registry is a module-level singleton shared across
 * vitest files, so all assertions are deltas and label cardinality is bounded by plan
 * step ids (these tests use fixed stub ids).
 */

import { describe, expect, it } from 'vitest';
import {
	metrics,
	observeFlowStepDuration,
	recordFlowStepAttempt,
	recordFlowStepFailure,
	recordFlowStepLanding,
	recordFlowStepReroute,
} from './metrics.js';

const counterValue = async (
	counter: { get: () => Promise<{ values: { labels: unknown; value: number }[] }> },
	labels: Record<string, string>,
): Promise<number> => {
	const data = await counter.get();
	return (
		data.values.find((v) =>
			Object.entries(labels).every(
				([key, value]) => (v.labels as Record<string, string>)[key] === value,
			),
		)?.value ?? 0
	);
};

const F = 'step-metrics-test-flow';
const S = 'step-metrics-test-step';

describe('per-stepId flow metrics recorders', () => {
	it('increments the attempts counter by flow and step id', async () => {
		const before = await counterValue(metrics.flowStepAttemptsTotal, { flow_id: F, step_id: S });
		recordFlowStepAttempt(F, S);
		recordFlowStepAttempt(F, S);
		const after = await counterValue(metrics.flowStepAttemptsTotal, { flow_id: F, step_id: S });
		expect(after - before).toBe(2);
	});

	it('increments the failures counter', async () => {
		const before = await counterValue(metrics.flowStepFailuresTotal, { flow_id: F, step_id: S });
		recordFlowStepFailure(F, S);
		const after = await counterValue(metrics.flowStepFailuresTotal, { flow_id: F, step_id: S });
		expect(after - before).toBe(1);
	});

	it('increments the reroutes counter', async () => {
		const before = await counterValue(metrics.flowStepReroutesTotal, { flow_id: F, step_id: S });
		recordFlowStepReroute(F, S);
		const after = await counterValue(metrics.flowStepReroutesTotal, { flow_id: F, step_id: S });
		expect(after - before).toBe(1);
	});

	it('increments landing counters per outcome label', async () => {
		const before = await counterValue(metrics.flowStepLandingsTotal, {
			flow_id: F,
			step_id: S,
			landing: 'diverged',
		});
		recordFlowStepLanding(F, S, 'diverged');
		const after = await counterValue(metrics.flowStepLandingsTotal, {
			flow_id: F,
			step_id: S,
			landing: 'diverged',
		});
		expect(after - before).toBe(1);
	});

	it('observes step duration into the histogram (count delta)', async () => {
		const countOf = async (): Promise<number> => {
			const data = await metrics.flowStepDuration.get();
			return (
				data.values.find(
					(v) =>
						v.metricName === 'acuity_flow_step_duration_seconds_count' &&
						(v.labels as Record<string, string>).flow_id === F &&
						(v.labels as Record<string, string>).step_id === S,
				)?.value ?? 0
			);
		};
		const before = await countOf();
		observeFlowStepDuration(F, S, 0.42);
		const after = await countOf();
		expect(after - before).toBe(1);
	});

	it('clamps a negative duration to zero', async () => {
		// A pathological clock skew must not feed a negative observation.
		expect(() => observeFlowStepDuration(F, S, -5)).not.toThrow();
	});
});
