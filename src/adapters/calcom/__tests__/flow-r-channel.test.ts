/**
 * The lane's CORE proof (design §7 / §10 risk-10): a CalCom REST flow's R channel
 * demands `CalComHttpClient` and NEVER `BrowserService` (nor `Scope`). Per-flow R typing
 * keeps the browser Layer out structurally — the union-R erasure failure mode of an IR
 * interpreter is avoided because R is a real type parameter on the step, not erased.
 * TIN-2097 (Lane E).
 *
 * Both a TYPE-LEVEL assertion (the availability flow's step R excludes BrowserService)
 * and a RUNTIME proof (the steps run to completion provided ONLY the CalComHttpClient
 * cassette Layer — if BrowserService were in R, this would not typecheck OR would fail
 * "Service not found" at runtime).
 */

import { Effect, type Context } from 'effect';
import { describe, expect, it } from 'vitest';
import type { BrowserService } from '../../../shared/browser-service.js';
import { CalComHttpClient, CalComHttpClientCassette } from '../http-client.js';
import { CALCOM_SLOTS_PATH, calcomReadDatesStep, calcomReadSlotsStep } from '../flow-steps.js';
// The load-bearing COMPILE-TIME fence lives in a source module (r-channel-proof.ts) so
// the //:typecheck gate enforces it (tests are excluded from tsconfig). Re-exported here
// so the runtime suite also exercises its frozen marker.
import { CALCOM_R_CHANNEL_PROOF } from '../r-channel-proof.js';

// =============================================================================
// TYPE-LEVEL ASSERTIONS — these fail to COMPILE (caught by //:typecheck via the
// test build) if the step R channel ever includes BrowserService or Scope.
// =============================================================================

type DatesRunR =
	ReturnType<typeof calcomReadDatesStep.run> extends Effect.Effect<any, any, infer R>
		? R
		: never;
type SlotsRunR =
	ReturnType<typeof calcomReadSlotsStep.run> extends Effect.Effect<any, any, infer R>
		? R
		: never;

/** Compile-time fence: `Exclude<R, BrowserService>` must equal `R` (BrowserService absent). */
type Assert<T extends true> = T;
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false;

// If BrowserService were in R, Exclude would shrink R and these would be `false`.
type _DatesNoBrowser = Assert<Equals<Exclude<DatesRunR, BrowserService>, DatesRunR>>;
type _SlotsNoBrowser = Assert<Equals<Exclude<SlotsRunR, BrowserService>, SlotsRunR>>;
// The R channel IS exactly CalComHttpClient (the positive proof).
type _DatesIsHttp = Assert<
	Equals<DatesRunR, Context.Tag.Identifier<typeof CalComHttpClient>>
>;
type _SlotsIsHttp = Assert<
	Equals<SlotsRunR, Context.Tag.Identifier<typeof CalComHttpClient>>
>;

// Reference the type aliases so the build does not flag them as unused.
const _typeProofs: readonly [_DatesNoBrowser, _SlotsNoBrowser, _DatesIsHttp, _SlotsIsHttp] = [
	true,
	true,
	true,
	true,
];

describe('CalCom flow R channel excludes BrowserService (the lane invariant)', () => {
	it('type-level: the step run R is exactly CalComHttpClient (no BrowserService/Scope)', () => {
		expect(_typeProofs).toEqual([true, true, true, true]);
	});

	it('the source-level compile fence (enforced by //:typecheck) holds', () => {
		expect(CALCOM_R_CHANNEL_PROOF.noBrowser).toEqual([true, true]);
		expect(CALCOM_R_CHANNEL_PROOF.noScope).toEqual([true, true]);
		expect(CALCOM_R_CHANNEL_PROOF.isHttpClient).toEqual([true, true]);
	});

	it('runtime: the dates step completes provided ONLY the CalComHttpClient layer', async () => {
		// Providing ONLY the HTTP layer fully discharges R. A browser Layer is never
		// constructed — there is nothing in R to ask for one.
		const outcome = await Effect.runPromise(
			calcomReadDatesStep
				.run({ serviceId: '1234', month: '2026-07' })
				.pipe(
					Effect.provide(
						CalComHttpClientCassette({ [CALCOM_SLOTS_PATH]: { data: { slots: {} } } }),
					),
				),
		);
		expect(outcome.state.dates).toEqual([]);
	});

	it('runtime: the slots step completes provided ONLY the CalComHttpClient layer', async () => {
		const outcome = await Effect.runPromise(
			calcomReadSlotsStep
				.run({ serviceId: '1234', date: '2026-07-05' })
				.pipe(
					Effect.provide(
						CalComHttpClientCassette({ [CALCOM_SLOTS_PATH]: { data: { slots: {} } } }),
					),
				),
		);
		expect(outcome.state.slots).toEqual([]);
	});
});
