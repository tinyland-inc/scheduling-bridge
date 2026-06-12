/**
 * AcuityFlowPackLive — the VendorFlowPack Layer assembled from EXISTING, un-extracted
 * pieces (design §7, Acuity 0.6.0 bullet; §10 0.6.0 block). TIN-2036.
 *
 * - selectors: `selectors.ts` in place (registry lookup + probe + health check) — the
 *   physical SelectorRegistry extraction is 0.7.0.
 * - detectStation: `detectLandingStep` (steps/navigate.ts, module-private) ADAPTED in
 *   place — the same probe cascade over the same registry keys, producing a typed
 *   LandingObservation with per-probe StationEvidence. No module moves.
 * - matchers.service: the ServiceResolver cascade scorers as they stand, via the
 *   shared `makeServiceMatcher` machinery (src/flow/fuzzy.ts re-uses
 *   service-resolver.ts scorers verbatim). Wiring it into navigate is 0.6.x.
 * - flows: the three 0.6.0 flows (flows.ts).
 * - paymentInjection: 'coupon-bypass' (Acuity's implementation of the
 *   payment-injection segment).
 *
 * De-tenanting (MassageIthaca selector entries) is explicitly 0.7.0 (design §7) and
 * deliberately NOT attempted here.
 */

import { Context, Effect, Layer } from 'effect';
import type { Page } from 'playwright-core';
import { VendorFlowPack, type SelectorRegistry } from '../../flow/vendor.js';
import { makeServiceMatcher } from '../../flow/fuzzy.js';
import type { LandingObservation, StationEvidence, StationId } from '../../flow/station.js';
import type { SelectorHealthReport } from './selector-health.js';
import type { SelectorProbeResult } from './selector-health.js';
import { probeSelector, Selectors, type SelectorKey } from './selectors.js';
import { ACUITY_STATIONS, LANDING_PROBE_KEYS } from './flow-steps.js';
import { acuityFlows } from './flows.js';

/**
 * SelectorRegistry over the in-place `selectors.ts` registry. `resolve` returns the
 * fallback chain for a key; unknown keys resolve to an empty chain (the registry is
 * data, not a throw surface).
 */
export const acuitySelectorRegistry: SelectorRegistry = {
	resolve: (key) => (Selectors as Record<string, readonly string[]>)[key] ?? [],
	probe: (page, key) =>
		probeSelector(page, (Selectors as Record<string, readonly string[]>)[key] ?? []),
	healthCheck: (page, keys) =>
		Effect.gen(function* () {
			const start = Date.now();
			const selectors: SelectorProbeResult[] = [];
			for (const key of keys) {
				const probeStart = Date.now();
				const chain =
					(Selectors as Record<string, readonly string[]>)[key] ?? [];
				const matched = yield* probeSelector(page, chain);
				const matchedIndex = matched === null ? null : chain.indexOf(matched);
				selectors.push({
					key: key as SelectorKey,
					status:
						matched === null
							? 'failed'
							: matchedIndex === 0
								? 'passed'
								: 'degraded',
					matchedSelector: matched,
					matchedIndex,
					probeMs: Date.now() - probeStart,
				});
			}
			const passed = selectors.filter((s) => s.status === 'passed').length;
			const degraded = selectors.filter((s) => s.status === 'degraded').length;
			const failed = selectors.filter((s) => s.status === 'failed').length;
			const report: SelectorHealthReport = {
				status: failed > 0 ? 'unhealthy' : degraded > 0 ? 'degraded' : 'healthy',
				selectors,
				passed,
				degraded,
				failed,
				totalMs: Date.now() - start,
				pagesProbed: [page.url()],
				businessObjectAvailable: false,
				timestamp: new Date().toISOString(),
			};
			return report;
		}),
};

/**
 * `detectLandingStep` (steps/navigate.ts) adapted as the pack's station detector:
 * identical probe cascade and ordering (firstNameInput → timeSlot → calendarDay →
 * serviceList), returning a LandingObservation with the full probe-evidence trail
 * instead of a bare label. `expected` is filled in by the runner from
 * StepMeta.expects; standalone detection reports an empty expectation.
 */
export const detectAcuityStation = (
	page: Page,
): Effect.Effect<LandingObservation, never, never> =>
	Effect.gen(function* () {
		const probes: readonly { station: StationId; key: string }[] = [
			{ station: 'acuity:client-form', key: LANDING_PROBE_KEYS['client-form'] },
			{ station: 'acuity:time-slots', key: LANDING_PROBE_KEYS['time-slots'] },
			{ station: 'acuity:calendar', key: LANDING_PROBE_KEYS.calendar },
			{
				station: 'acuity:service-selection',
				key: LANDING_PROBE_KEYS['service-selection'],
			},
		];
		const evidence: StationEvidence[] = [];
		for (const { station, key } of probes) {
			const matched = yield* probeSelector(
				page,
				(Selectors as Record<string, readonly string[]>)[key] ?? [],
			);
			evidence.push({ kind: 'selector', key, matched: matched !== null });
			if (matched !== null) {
				return {
					expected: [],
					observed: station,
					confidence: 1,
					evidence,
				} satisfies LandingObservation;
			}
		}
		return {
			expected: [],
			observed: 'unknown',
			confidence: 0,
			evidence,
		} satisfies LandingObservation;
	});

/** The assembled Acuity pack service (plain object; Layer below). */
export const acuityFlowPack: Context.Tag.Service<VendorFlowPack> = {
	backend: 'acuity',
	stations: ACUITY_STATIONS,
	detectStation: detectAcuityStation,
	selectors: acuitySelectorRegistry,
	matchers: { service: makeServiceMatcher() },
	flows: acuityFlows,
	paymentInjection: 'coupon-bypass',
};

/** The VendorFlowPack Layer for Acuity (design §7; Layer substitution replaces the
 * mutable `acuitySteps` override seam over 0.6.x→0.8.0). */
export const AcuityFlowPackLive: Layer.Layer<VendorFlowPack> = Layer.succeed(
	VendorFlowPack,
	acuityFlowPack,
);
