/**
 * Mermaid emission — pure projection of a FlowPlan (design §10 0.6.x: "Mermaid
 * emission with journal overlay"). Snapshot-pins the renderer output for a synthetic
 * plan with a backward recovery edge (the motivating §6 case), with and without the
 * journal overlay. No execution, no browser.
 */

import { describe, expect, it } from 'vitest';
import { journalStepStatuses, renderFlowMermaid } from '../mermaid.js';
import type { FlowPlan } from '../plan.js';

const plan: FlowPlan = {
	flowId: 'demo_flow',
	backend: 'acuity',
	version: '1.0.0',
	nodes: [
		{
			stepId: 'demo/navigate',
			needs: [],
			provides: ['navigation'],
			dependsOn: [],
			expects: ['acuity:client-form'],
			idempotency: 'replayable-write',
			segment: 'wizard',
			tags: ['navigation'],
		},
		{
			stepId: 'demo/submit',
			needs: ['navigation'],
			provides: ['submission'],
			dependsOn: ['demo/navigate'],
			recoveries: [{ to: 'demo/navigate', maxReentries: 2 }],
			expects: ['acuity:confirmation'],
			idempotency: 'effectful-once',
			segment: 'wizard',
			tags: ['mutation'],
		},
	],
};

describe('renderFlowMermaid', () => {
	it('renders forward edges solid and recovery edges dashed with budgets', () => {
		expect(renderFlowMermaid(plan)).toBe(
			[
				'%% flow: demo_flow v1.0.0 (acuity)',
				'flowchart TD',
				'\ts0["demo/navigate (segment: wizard, replayable-write)"]',
				'\ts1["demo/submit (segment: wizard, effectful-once)"]',
				'\ts0 --> s1',
				'\ts1 -.->|"recovery (budget 2)"| s0',
				'',
			].join('\n'),
		);
	});

	it('marks per-step status from journal rows (last checkpoint per step wins)', () => {
		const journal = [
			{ stepId: 'demo/navigate', status: 'started' as const },
			{ stepId: 'demo/navigate', status: 'completed' as const },
			{ stepId: 'demo/submit', status: 'started' as const },
			{ stepId: 'demo/submit', status: 'failed' as const },
		];

		expect(renderFlowMermaid(plan, { journal })).toBe(
			[
				'%% flow: demo_flow v1.0.0 (acuity)',
				'flowchart TD',
				'\ts0["demo/navigate (segment: wizard, replayable-write) [completed]"]:::flow_completed',
				'\ts1["demo/submit (segment: wizard, effectful-once) [failed]"]:::flow_failed',
				'\ts0 --> s1',
				'\ts1 -.->|"recovery (budget 2)"| s0',
				'\tclassDef flow_completed fill:#d3f9d8,stroke:#2f9e44,color:#000',
				'\tclassDef flow_failed fill:#ffe3e3,stroke:#e03131,color:#000',
				'',
			].join('\n'),
		);
	});

	it('leaves steps without journal rows unmarked and emits only present classDefs', () => {
		const journal = [{ stepId: 'demo/navigate', status: 'completed' as const }];
		const output = renderFlowMermaid(plan, { journal });

		expect(output).toContain(
			'\ts0["demo/navigate (segment: wizard, replayable-write) [completed]"]:::flow_completed',
		);
		expect(output).toContain('\ts1["demo/submit (segment: wizard, effectful-once)"]');
		expect(output).toContain('classDef flow_completed');
		expect(output).not.toContain('classDef flow_failed');
	});
});

describe('journalStepStatuses', () => {
	it('folds rows into the latest status per stepId', () => {
		const statuses = journalStepStatuses([
			{ stepId: 'a', status: 'started' },
			{ stepId: 'b', status: 'started' },
			{ stepId: 'a', status: 'completed' },
		]);
		expect(statuses.get('a')).toBe('completed');
		expect(statuses.get('b')).toBe('started');
		expect(statuses.get('c')).toBeUndefined();
	});
});
