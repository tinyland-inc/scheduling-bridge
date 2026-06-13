/**
 * Compile-time R-channel fence for the CalCom read-only pack (the lane invariant).
 * Design: docs/design/flow-dag-formalization.md §7 ("its steps demand `HttpClient`, not
 * `BrowserService`; a REST flow never provisions a browser Layer"), §10 risk-10.
 * TIN-2097 (Lane E).
 *
 * This is a SOURCE module (not a test) so the `//:typecheck` tsc gate ENFORCES it — the
 * `__tests__` suites are excluded from tsconfig, so the matching runtime/type checks in
 * flow-r-channel.test.ts are belt-and-braces, not the enforcement point. If a CalCom
 * step's R channel ever gained `BrowserService` (or `Scope`), the `_AssertNoBrowser`
 * lines below would fail to compile, breaking the gate. The module exports a single
 * frozen marker so it participates in the build graph and is not tree-shaken to nothing.
 */

import type { Effect } from 'effect';
import type { Scope } from 'effect';
import type { BrowserService } from '../../shared/browser-service.js';
import type { CalComHttpClient } from './http-client.js';
import { calcomReadDatesStep, calcomReadSlotsStep } from './flow-steps.js';

/** Extract the R (requirements) channel of a step's `run` Effect. */
type RunR<Step extends { run: (...args: never[]) => Effect.Effect<unknown, unknown, unknown> }> =
	ReturnType<Step['run']> extends Effect.Effect<unknown, unknown, infer R> ? R : never;

type DatesR = RunR<typeof calcomReadDatesStep>;
type SlotsR = RunR<typeof calcomReadSlotsStep>;

/** Invariant type-equality probe (distributes correctly over unions/never). */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false;
type Assert<T extends true> = T;

// 1. Removing BrowserService from R must NOT change R ⇒ BrowserService is absent from R.
type _DatesNoBrowser = Assert<Equals<Exclude<DatesR, BrowserService>, DatesR>>;
type _SlotsNoBrowser = Assert<Equals<Exclude<SlotsR, BrowserService>, SlotsR>>;
// 2. Removing Scope from R must NOT change R ⇒ no browser session Scope is provisioned.
type _DatesNoScope = Assert<Equals<Exclude<DatesR, Scope.Scope>, DatesR>>;
type _SlotsNoScope = Assert<Equals<Exclude<SlotsR, Scope.Scope>, SlotsR>>;
// 3. R is EXACTLY CalComHttpClient (the positive proof a REST flow needs an HTTP client).
type _DatesIsHttp = Assert<Equals<DatesR, CalComHttpClient>>;
type _SlotsIsHttp = Assert<Equals<SlotsR, CalComHttpClient>>;

/**
 * Frozen marker keeping this fence in the build graph. The `true` literals are the
 * runtime echo of the compile-time assertions above (which carry no runtime value).
 */
export const CALCOM_R_CHANNEL_PROOF: {
	readonly noBrowser: readonly [_DatesNoBrowser, _SlotsNoBrowser];
	readonly noScope: readonly [_DatesNoScope, _SlotsNoScope];
	readonly isHttpClient: readonly [_DatesIsHttp, _SlotsIsHttp];
} = Object.freeze({
	noBrowser: [true, true],
	noScope: [true, true],
	isHttpClient: [true, true],
});
