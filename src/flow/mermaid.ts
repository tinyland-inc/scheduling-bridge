/**
 * Mermaid emission — a read-only projection of a FlowPlan as a mermaid flowchart
 * (design: docs/design/flow-dag-formalization.md §5 "Plan vs execute", §10 0.6.x
 * "Mermaid emission with journal overlay"). Pure functions over plan data and
 * journal rows; NO execution, no browser, no journal writes.
 *
 * Rendering vocabulary:
 * - forward edges (`FlowPlanNode.dependsOn`) are solid arrows;
 * - recovery edges are dashed arrows annotated with their re-entry budget;
 * - the optional journal overlay marks per-step status (last checkpoint per stepId
 *   wins) via a label suffix and a `flow_<status>` class.
 */

import type { CheckpointStatus, FlowCheckpoint } from './journal.js';
import type { FlowPlan } from './plan.js';

/** Style per checkpoint status, emitted as `classDef flow_<status> ...`. */
const STATUS_STYLES: Record<CheckpointStatus, string> = {
	started: 'fill:#fff3bf,stroke:#f08c00,color:#000',
	completed: 'fill:#d3f9d8,stroke:#2f9e44,color:#000',
	failed: 'fill:#ffe3e3,stroke:#e03131,color:#000',
	compensated: 'fill:#f3f0ff,stroke:#7048e8,color:#000',
	skipped_resume: 'fill:#f1f3f5,stroke:#868e96,color:#000',
	rerouted: 'fill:#e7f5ff,stroke:#1c7ed6,color:#000',
};

/**
 * Fold journal rows into the latest status per stepId. Rows are seq-ordered by
 * journal contract (gapless, monotonic), so the last row for a step wins.
 */
export const journalStepStatuses = (
	rows: readonly Pick<FlowCheckpoint, 'stepId' | 'status'>[],
): ReadonlyMap<string, CheckpointStatus> => {
	const statuses = new Map<string, CheckpointStatus>();
	for (const row of rows) {
		statuses.set(row.stepId, row.status);
	}
	return statuses;
};

export interface RenderFlowMermaidOptions {
	/**
	 * Journal rows for ONE operationId (FlowJournalShape.read output). When present,
	 * each plan node executed in the journal is annotated with its latest status.
	 */
	readonly journal?: readonly Pick<FlowCheckpoint, 'stepId' | 'status'>[];
}

const escapeLabel = (text: string): string => text.replace(/"/g, '#quot;');

/**
 * Render a FlowPlan as a mermaid flowchart (text). Deterministic for a given plan
 * and journal: node ids are positional (`s0`, `s1`, ...), edges follow plan order.
 */
export const renderFlowMermaid = (
	plan: FlowPlan,
	options?: RenderFlowMermaidOptions,
): string => {
	const overlay = options?.journal ? journalStepStatuses(options.journal) : undefined;
	const nodeIds = new Map<string, string>(
		plan.nodes.map((node, index) => [node.stepId, `s${index}`]),
	);

	const lines: string[] = [
		`%% flow: ${plan.flowId} v${plan.version} (${plan.backend})`,
		'flowchart TD',
	];

	// Node declarations (with optional journal status suffix + class).
	for (const node of plan.nodes) {
		const id = nodeIds.get(node.stepId) as string;
		const status = overlay?.get(node.stepId);
		const label = escapeLabel(
			`${node.stepId} (segment: ${node.segment}, ${node.idempotency})${
				status ? ` [${status}]` : ''
			}`,
		);
		lines.push(`\t${id}["${label}"]${status ? `:::flow_${status}` : ''}`);
	}

	// Forward edges (solid): dependency -> dependent, in plan order.
	for (const node of plan.nodes) {
		for (const dependency of node.dependsOn) {
			const from = nodeIds.get(dependency);
			if (from) lines.push(`\t${from} --> ${nodeIds.get(node.stepId) as string}`);
		}
	}

	// Recovery edges (dashed, budget-annotated); may point backward.
	for (const node of plan.nodes) {
		for (const edge of node.recoveries ?? []) {
			const to = nodeIds.get(edge.to);
			if (to) {
				lines.push(
					`\t${nodeIds.get(node.stepId) as string} -.->|"recovery (budget ${edge.maxReentries})"| ${to}`,
				);
			}
		}
	}

	// classDefs only for statuses present in the overlay, in stable order.
	if (overlay) {
		const present = [...new Set(overlay.values())].sort();
		for (const status of present) {
			lines.push(`\tclassDef flow_${status} ${STATUS_STYLES[status]}`);
		}
	}

	return `${lines.join('\n')}\n`;
};
