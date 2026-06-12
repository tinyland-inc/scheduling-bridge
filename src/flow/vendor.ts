/**
 * Vendor adapter model — TYPES ONLY in 0.6.0.
 * Design: docs/design/flow-dag-formalization.md §7 (vendor.ts).
 *
 * `AcuityFlowPackLive` is assembled from the existing un-extracted pieces in a later lane;
 * the physical extraction of SelectorRegistry and the station detector is 0.7.0.
 */

import { Context, type Effect } from 'effect';
import type { Page } from 'playwright-core';
import type { SelectorHealthReport } from '../adapters/acuity/selector-health.js';
import type { MiddlewareError } from '../adapters/acuity/errors.js';
import type { BridgeBackend, LandingObservation, StationId } from './station.js';
import type { ServiceMatcher } from './fuzzy.js';
import type { Flow } from './flow.js';

/** Extracted over selectors.ts:34-308 (interface only; extraction is 0.7.0). */
export interface SelectorRegistry {
	/** Fallback chain. */
	readonly resolve: (key: string) => readonly string[];
	readonly probe: (page: Page, key: string) => Effect.Effect<string | null>;
	readonly healthCheck: (
		page: Page,
		keys: readonly string[],
	) => Effect.Effect<SelectorHealthReport>;
}

export class VendorFlowPack extends Context.Tag('scheduling-bridge/VendorFlowPack')<
	VendorFlowPack,
	{
		readonly backend: BridgeBackend;
		readonly stations: readonly StationId[];
		readonly detectStation: (page: Page) => Effect.Effect<LandingObservation, never, never>;
		/** Per-tenant entries come from selectorProfile data. */
		readonly selectors: SelectorRegistry;
		readonly matchers: {
			readonly service: Context.Tag.Service<ServiceMatcher>;
			/* date, field matchers are 0.7.0 */
		};
		/** E includes `undefined`: the existing step programs carry `catch: () =>
		 * undefined` branches, so their honest error channel is `MiddlewareError |
		 * undefined` (exactly the worker's `runWizardStep` E channel). */
		readonly flows: {
			readonly [flowId: string]: Flow<any, MiddlewareError | undefined, any>;
		};
		readonly paymentInjection: 'native' | 'coupon-bypass' | 'external-link';
	}
>() {}
