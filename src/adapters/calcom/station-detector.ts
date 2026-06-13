/**
 * CalCom station detector — a RESPONSE-SHAPE probe, not a DOM probe.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom: "Landing observation
 * degenerates to response-shape checks (confidence 1.0)"), §10 risk-10
 * ("`detectStation` demotes to optional capability if it proves Acuity-shaped").
 * TIN-2097 (Lane E).
 *
 * The REST modality has no page to inspect, so landing detection is structurally a
 * check on the SHAPE of the CalCom slots response: a well-formed `data.slots` map IS
 * the `calcom:slots` station at confidence 1.0; anything else is `unknown` at 0.0.
 *
 * The VendorFlowPack `detectStation` slot is typed `(page: Page) => …` because it was
 * frozen around the Acuity browser modality (vendor.ts; the design names this exact
 * friction in §7/§10 risk-10 — the detector demotes to optional for a REST pack). To
 * honor the shared tag WITHOUT pretending a browser exists, the pack-facing
 * `detectCalComStation` accepts the `Page` parameter and IGNORES it, always returning
 * the `unknown` observation: a REST flow never lands via DOM, so a browser-shaped probe
 * has nothing to observe. The REAL detector is `detectCalComStationFromResponse`, the
 * response-shape probe the steps actually use.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import type { LandingObservation, StationEvidence, StationId } from '../../flow/station.js';
import { probeSlotsResponse } from './slots-api.js';

/** The CalCom landing vocabulary. Read-only first: a single availability station. */
export const CALCOM_STATIONS = ['calcom:slots'] as const satisfies readonly StationId[];

export type CalComStation = (typeof CALCOM_STATIONS)[number];

/**
 * THE CalCom landing detector: a response-shape probe. A body that parses as a CalCom
 * slots map lands on `calcom:slots` at confidence 1.0; otherwise `unknown` at 0.0. The
 * single piece of evidence is a `text`-kind probe over the response shape (no selector,
 * no url — there is no DOM).
 */
export const detectCalComStationFromResponse = (
	expected: readonly StationId[],
	body: unknown,
): LandingObservation => {
	const matched = probeSlotsResponse(body) !== null;
	const evidence: readonly StationEvidence[] = [
		{ kind: 'text', key: 'data.slots', matched },
	];
	return matched
		? { expected, observed: 'calcom:slots', confidence: 1, evidence }
		: { expected, observed: 'unknown', confidence: 0, evidence };
};

/**
 * Pack-facing `detectStation` conforming to the (browser-shaped) VendorFlowPack tag.
 * A REST pack has no page, so this IGNORES the `Page` and reports `unknown` — the honest
 * answer for "what DOM station did we land on?" when no DOM was ever loaded. Real
 * landing detection happens inside the steps via `detectCalComStationFromResponse`.
 */
export const detectCalComStation = (
	_page: Page,
): Effect.Effect<LandingObservation, never, never> =>
	Effect.succeed({
		expected: [],
		observed: 'unknown',
		confidence: 0,
		evidence: [{ kind: 'text', key: 'data.slots', matched: false }],
	} satisfies LandingObservation);
