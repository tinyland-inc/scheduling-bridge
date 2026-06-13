/**
 * CalCom SelectorRegistry — a no-op registry for the REST modality.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom REST pack).
 * TIN-2097 (Lane E).
 *
 * The VendorFlowPack `selectors` field is browser-shaped (CSS selector chains probed
 * against a `Page`), frozen around the Acuity DOM modality. A REST pack has no DOM, so
 * its registry is empty by construction: every key resolves to an EMPTY fallback chain,
 * probes always miss, and a health check reports a clean (no-selectors) `healthy` report.
 * No CalCom step ever consults it — it exists only to satisfy the shared pack tag until
 * the interface optionalizes `selectors`/`detectStation` for non-browser packs (a frozen
 * decision deferred to the GlossGenius/0.8.0 exam, per §10 risk-10).
 */

import { Effect } from 'effect';
import type { SelectorRegistry } from '../../flow/vendor.js';
import type { SelectorHealthReport, SelectorProbeResult } from '../acuity/selector-health.js';

/** The CalCom (empty) selector registry: no DOM, no selectors. */
export const calcomSelectorRegistry: SelectorRegistry = {
	resolve: () => [],
	probe: () => Effect.succeed(null),
	healthCheck: (_page, keys) =>
		Effect.succeed({
			status: 'healthy',
			// REST has no DOM selectors; an arbitrary probe key is reported as a no-op
			// pass. `SelectorProbeResult.key` is the Acuity `SelectorKey` union, so the
			// caller-supplied string is cast through that result shape.
			selectors: keys.map(
				(key) =>
					({
						key,
						status: 'passed',
						matchedSelector: null,
						matchedIndex: null,
						probeMs: 0,
					}) as unknown as SelectorProbeResult,
			),
			passed: keys.length,
			degraded: 0,
			failed: 0,
			totalMs: 0,
			pagesProbed: [],
			businessObjectAvailable: false,
			timestamp: new Date(0).toISOString(),
		} satisfies SelectorHealthReport),
};
