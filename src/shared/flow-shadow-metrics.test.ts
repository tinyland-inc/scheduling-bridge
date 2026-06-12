/**
 * Shadow-mode comparison metrics (design §10 0.6.0: "the plan projection runs
 * alongside and diffs predicted vs actual step sequence into shared/metrics.ts").
 * The registry is a module-level singleton shared across vitest files, so all
 * assertions are written as deltas.
 */

import { describe, expect, it } from 'vitest';
import { metrics, recordFlowShadowComparison } from './metrics.js';

const counterValue = async (
	counter: typeof metrics.flowShadowRunsTotal,
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

describe('recordFlowShadowComparison', () => {
	it('classifies an identical sequence as match', async () => {
		const before = await counterValue(metrics.flowShadowRunsTotal, {
			flow_id: 'shadow-test-flow',
			result: 'match',
		});
		const result = recordFlowShadowComparison(
			'shadow-test-flow',
			['a', 'b', 'c'],
			['a', 'b', 'c'],
		);
		expect(result).toBe('match');
		const after = await counterValue(metrics.flowShadowRunsTotal, {
			flow_id: 'shadow-test-flow',
			result: 'match',
		});
		expect(after - before).toBe(1);
	});

	it('classifies a failed run (proper prefix) as prefix and counts missing steps', async () => {
		const beforeMissing = await counterValue(metrics.flowShadowStepMismatchTotal, {
			flow_id: 'shadow-test-flow',
			step_id: 'c',
			kind: 'missing',
		});
		const result = recordFlowShadowComparison(
			'shadow-test-flow',
			['a', 'b', 'c'],
			['a', 'b'],
		);
		expect(result).toBe('prefix');
		const afterMissing = await counterValue(metrics.flowShadowStepMismatchTotal, {
			flow_id: 'shadow-test-flow',
			step_id: 'c',
			kind: 'missing',
		});
		expect(afterMissing - beforeMissing).toBe(1);
	});

	it('classifies unexpected and out-of-order executions as mismatch', async () => {
		expect(
			recordFlowShadowComparison('shadow-test-flow', ['a', 'b'], ['a', 'x']),
		).toBe('mismatch');
		const unexpected = await counterValue(metrics.flowShadowStepMismatchTotal, {
			flow_id: 'shadow-test-flow',
			step_id: 'x',
			kind: 'unexpected',
		});
		expect(unexpected).toBeGreaterThanOrEqual(1);

		expect(
			recordFlowShadowComparison('shadow-test-flow', ['a', 'b'], ['b', 'a']),
		).toBe('mismatch');
		const outOfOrder = await counterValue(metrics.flowShadowStepMismatchTotal, {
			flow_id: 'shadow-test-flow',
			step_id: 'b',
			kind: 'out_of_order',
		});
		expect(outOfOrder).toBeGreaterThanOrEqual(1);
	});

	it('treats executed sequences longer than the plan as mismatch, not prefix', () => {
		expect(
			recordFlowShadowComparison('shadow-test-flow', ['a'], ['a', 'b']),
		).toBe('mismatch');
	});
});
