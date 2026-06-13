/**
 * CalComFlowPackLive — the VendorFlowPack Layer for the CalCom read-only REST pack.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom bullet), §10 (0.7.0 block;
 * risk-10). TIN-2097 (Lane E).
 *
 * This pack proves the VendorFlowPack abstraction is transport-agnostic: it satisfies
 * the SAME Context.Tag the Acuity browser pack does, but its flows are REST-backed and
 * its R channel is `CalComHttpClient`, never `BrowserService`. Read-only first (dates +
 * slots), reusing the Acuity availability flow ids.
 *
 * Browser-shaped pack fields, demoted for the REST modality (the friction the design
 * names in §7/§10 risk-10 — both demote to optional once GlossGenius freezes the
 * interface in 0.8.0):
 * - `detectStation`: a Page-typed shim that ignores the (absent) page; real landing is
 *   the response-shape probe inside the steps (station-detector.ts).
 * - `selectors`: an empty no-op registry (no DOM, no selectors).
 *
 * `matchers` reuse the SHARED `makeServiceMatcher` / `makeDateMatcher` / `makeFieldMatcher`
 * machinery (the fuzzy scorers are vendor-neutral pure functions) so CalCom event-type,
 * slot/date, and intake-field matching all score identically to the Acuity pack. The
 * date/field matchers became required pack fields in 0.7.0 (design §7); CalCom wires the
 * same vendor-neutral factories the Acuity pack does. `paymentInjection: 'native'` — CalCom takes payment natively
 * (Stripe), so there is no coupon-bypass segment to splice; the read-only pack never
 * exercises it.
 */

import { Context, Layer } from 'effect';
import { VendorFlowPack } from '../../flow/vendor.js';
import { makeServiceMatcher } from '../../flow/fuzzy.js';
import { makeDateMatcher } from '../../flow/date-matcher.js';
import { makeFieldMatcher } from '../../flow/field-matcher.js';
import { calcomSelectorRegistry } from './selector-registry.js';
import { detectCalComStation, CALCOM_STATIONS } from './station-detector.js';
import { calcomFlows } from './flows.js';

// Re-export the extracted pack pieces from their canonical homes so the established
// import path (`flow-pack.js`) mirrors the Acuity pack's surface for the pack tests.
export { calcomSelectorRegistry } from './selector-registry.js';
export {
	detectCalComStation,
	detectCalComStationFromResponse,
	CALCOM_STATIONS,
} from './station-detector.js';

/** The assembled CalCom pack service (plain object; Layer below). */
export const calcomFlowPack: Context.Tag.Service<VendorFlowPack> = {
	backend: 'calcom',
	stations: CALCOM_STATIONS,
	detectStation: detectCalComStation,
	selectors: calcomSelectorRegistry,
	matchers: {
		service: makeServiceMatcher(),
		date: makeDateMatcher(),
		field: makeFieldMatcher(),
	},
	flows: calcomFlows,
	paymentInjection: 'native',
};

/** The VendorFlowPack Layer for CalCom (design §7; Layer substitution selects the pack). */
export const CalComFlowPackLive: Layer.Layer<VendorFlowPack> = Layer.succeed(
	VendorFlowPack,
	calcomFlowPack,
);
