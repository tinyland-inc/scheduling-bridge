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
import type { BridgeBackend, LandingObservation, StationId } from './station.js';
import type { ServiceMatcher } from './fuzzy.js';
import type { DateMatcher } from './date-matcher.js';
import type { FieldMatcher } from './field-matcher.js';
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
			/** DateMatcher (TZ-norm + slot membership + month/day targeting), 0.7.0. */
			readonly date: Context.Tag.Service<DateMatcher>;
			/** FieldMatcher (intake-label inference), 0.7.0. */
			readonly field: Context.Tag.Service<FieldMatcher>;
		};
		/** E (and R) are erased to `any` at the pack boundary: a pack's flows carry
		 * vendor-specific error and requirement channels. The Acuity browser pack's
		 * honest E is `MiddlewareError | undefined` (the worker's `runWizardStep` channel,
		 * R = BrowserService | Scope); the CalCom REST pack's is `CalComRestError |
		 * undefined` (transport/shape, R = CalComHttpClient — no DOM). `any` here is the
		 * MINIMAL 0.7.0 widening that admits a typed-error REST pack through the SAME tag
		 * without inverting the flow→adapter layering (vendor.ts would otherwise import
		 * every vendor's error union). Runtime consumers narrow errors from `unknown`
		 * regardless (flow-runner `isMiddlewareError`), so no runtime behavior changes; a
		 * vendor-neutral flow-error type is a 0.8.0 surface-freeze concern (§9). */
		readonly flows: {
			readonly [flowId: string]: Flow<any, any, any>;
		};
		readonly paymentInjection: 'native' | 'coupon-bypass' | 'external-link';
	}
>() {}
