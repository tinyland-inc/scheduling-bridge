/**
 * AcuityFlowPackLive — the VendorFlowPack Layer (design §7; §10 0.7.0 block).
 * TIN-2036 (assembly), TIN-2094 (physical extraction + de-tenanting).
 *
 * As of 0.7.0 the pack consumes the PHYSICALLY EXTRACTED standalone modules:
 * - selectors: `acuitySelectorRegistry` from `selector-registry.ts` (the
 *   vendor-neutral selector data + resolution machinery merged with the active
 *   selector profile). The wrapper contract is byte-identical to the 0.6.0
 *   inline version; only its source moved out of this file.
 * - detectStation: `detectAcuityStation` from `station-detector.ts` (the probe
 *   cascade producing a typed LandingObservation with per-probe StationEvidence).
 * - matchers.service: the ServiceResolver cascade scorers via the shared
 *   `makeServiceMatcher` machinery (src/flow/fuzzy.ts).
 * - matchers.date: the DateMatcher (TZ-suffix normalization + slot membership +
 *   tolerant month/day targeting) via `makeDateMatcher` (src/flow/date-matcher.ts).
 * - matchers.field: the FieldMatcher (required-textarea label inference) via
 *   `makeFieldMatcher` (src/flow/field-matcher.ts).
 * - flows: the three flows (flows.ts).
 * - paymentInjection: 'coupon-bypass' (Acuity's implementation of the
 *   payment-injection segment).
 *
 * De-tenanting (design §7, 0.7.0): per-tenant selector entries no longer live
 * in generic code. They are isolated as selector-profile DATA
 * (selector-profile.ts), keyed by `BridgeAdapterProfile.selectorProfile`, and
 * merged onto the vendor-neutral base only when their profile is selected.
 */

import { Context, Layer } from 'effect';
import { VendorFlowPack } from '../../flow/vendor.js';
import { makeServiceMatcher } from '../../flow/fuzzy.js';
import { makeDateMatcher } from '../../flow/date-matcher.js';
import { makeFieldMatcher } from '../../flow/field-matcher.js';
import { acuitySelectorRegistry } from './selector-registry.js';
import { detectAcuityStation } from './station-detector.js';
import { ACUITY_STATIONS } from './flow-steps.js';
import { acuityFlows } from './flows.js';

// Re-export the extracted pack pieces from their canonical (0.7.0) homes so the
// established import path (`flow-pack.js`) — and the existing pack tests — keep
// working unchanged after the physical extraction.
export { acuitySelectorRegistry, makeAcuitySelectorRegistry } from './selector-registry.js';
export { detectAcuityStation } from './station-detector.js';

/** The assembled Acuity pack service (plain object; Layer below). */
export const acuityFlowPack: Context.Tag.Service<VendorFlowPack> = {
	backend: 'acuity',
	stations: ACUITY_STATIONS,
	detectStation: detectAcuityStation,
	selectors: acuitySelectorRegistry,
	matchers: {
		service: makeServiceMatcher(),
		date: makeDateMatcher(),
		field: makeFieldMatcher(),
	},
	flows: acuityFlows,
	paymentInjection: 'coupon-bypass',
};

/** The VendorFlowPack Layer for Acuity (design §7; Layer substitution replaces the
 * mutable `acuitySteps` override seam over 0.6.x→0.8.0). */
export const AcuityFlowPackLive: Layer.Layer<VendorFlowPack> = Layer.succeed(
	VendorFlowPack,
	acuityFlowPack,
);
