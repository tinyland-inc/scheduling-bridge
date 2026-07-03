import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { SchedulingError } from '../../core/types.js';
import { createWizardAdapter } from '../../adapters/acuity/wizard.js';
import { createRemoteWizardAdapter } from '../remote-adapter.js';

// =============================================================================
// TIN-945 G5 (parity matrix #113) — softHoldSlot is an intentional always-fail.
//
// Both Acuity SchedulingAdapters advertise `softHoldSlot` but neither backs an
// advisory reservation (the Acuity wizard has no soft-hold primitive), so the
// method is a *contract-level* always-fail:
//
//   wizard.ts:304          local  in-process Playwright adapter
//   shared/remote-adapter.ts:263  remote HTTP-proxy adapter
//
// Each yields `Effect.fail(Errors.reservation('BLOCK_FAILED', <msg>))`. The
// exact reservation error shape it must produce (from
// @tummycrypt/scheduling-kit `core/types` `ReservationError`) is:
//
//   {
//     _tag:      'ReservationError',
//     code:      'SLOT_TAKEN' | 'BLOCK_FAILED' | 'TIMEOUT',   // here BLOCK_FAILED
//     message:   string,
//     datetime?: string                                       // absent — no slot pinned
//   }
//
// This always-fail is SAFE because the kit booking pipeline treats the soft
// hold as an advisory checkout guard, not a correctness boundary, and tolerates
// the failure. In `@tummycrypt/scheduling-kit` `core/pipelines`
// (`completeBookingWithAltPayment`, Phase B) the call is wrapped:
//
//   const softHold = yield* pipe(
//     scheduler.softHoldSlot({ ... }),
//     Effect.map((r) => r),
//     Effect.catchAll(() => Effect.succeed(undefined)),   // ← BLOCK_FAILED degrades to `undefined`
//   );
//   // Phase C (payment) then runs unconditionally — the segment continues.
//
// These tests pin BOTH halves of the contract: (1) the exact failure shape at
// each adapter site, and (2) that the kit's tolerance combinator degrades that
// failure to `undefined` so the downstream booking segment still executes.
// =============================================================================

const SOFT_HOLD_PARAMS = {
	serviceId: 'svc-tmd-1st-consult',
	providerId: '1',
	datetime: '2026-03-15T10:00:00-05:00',
	duration: 60,
	notes: 'Payment pending: idem-abc-123',
} as const;

/** Run a `SchedulingResult` expected to fail and surface its typed error. */
const runFailure = <A>(eff: Effect.Effect<A, SchedulingError>): Promise<SchedulingError> =>
	Effect.runPromise(Effect.flip(eff));

/**
 * Mirror of the kit's Phase-B tolerance combinator
 * (`completeBookingWithAltPayment` in `@tummycrypt/scheduling-kit`
 * `core/pipelines`): a soft-hold effect is mapped through, then any error is
 * caught and degraded to `undefined` so the booking pipeline continues.
 */
const tolerateSoftHold = <A>(
	softHold: Effect.Effect<A, SchedulingError>,
): Effect.Effect<A | undefined, never> =>
	softHold.pipe(
		Effect.map((hold): A | undefined => hold),
		Effect.catchAll(() => Effect.succeed(undefined)),
	);

const adapters = [
	{
		site: 'wizard.ts:304 (local in-process adapter)',
		make: () => createWizardAdapter({ baseUrl: 'https://clinic.as.me/schedule/abc123' }),
	},
	{
		site: 'shared/remote-adapter.ts:263 (remote HTTP-proxy adapter)',
		make: () => createRemoteWizardAdapter({ baseUrl: 'https://bridge.test' }),
	},
] as const;

describe.each(adapters)('softHoldSlot always-fail contract — $site', ({ make }) => {
	it('fails with a ReservationError coded BLOCK_FAILED (never succeeds)', async () => {
		const error = await runFailure(make().softHoldSlot({ ...SOFT_HOLD_PARAMS }));

		expect(error._tag).toBe('ReservationError');
		// Narrow to the ReservationError branch of the SchedulingError union.
		if (error._tag !== 'ReservationError') throw new Error('unreachable');

		expect(error.code).toBe('BLOCK_FAILED');
		expect(typeof error.message).toBe('string');
		expect(error.message.length).toBeGreaterThan(0);
		expect(error.message).toMatch(/soft hold/i);
		// Advisory failure — no concrete slot is pinned, so no datetime is set.
		expect(error.datetime).toBeUndefined();
	});

	it('emits exactly the ReservationError shape (no stray keys)', async () => {
		const error = await runFailure(make().softHoldSlot({ ...SOFT_HOLD_PARAMS }));
		if (error._tag !== 'ReservationError') throw new Error('unreachable');

		// The kit `Errors.reservation(code, message)` factory populates _tag/code/
		// message and leaves datetime undefined; `toEqual` ignores the undefined key.
		expect(error).toEqual({
			_tag: 'ReservationError',
			code: 'BLOCK_FAILED',
			message: error.message,
			datetime: undefined,
		});
	});

	it('is tolerated by the kit pipeline combinator — segment continues', async () => {
		const adapter = make();
		let reachedNextPhase = false;

		// Reproduce Phase B → Phase C hand-off: the tolerated soft hold must NOT
		// abort the surrounding booking program.
		const program = Effect.gen(function* () {
			const softHold = yield* tolerateSoftHold(adapter.softHoldSlot({ ...SOFT_HOLD_PARAMS }));
			reachedNextPhase = true; // Phase C (payment) would run here.
			return softHold;
		});

		const result = await Effect.runPromise(program);

		// BLOCK_FAILED degraded to `undefined` — no advisory hold, no thrown error.
		expect(result).toBeUndefined();
		// The booking segment continued past the (failed) advisory hold.
		expect(reachedNextPhase).toBe(true);
	});

	it('releaseSoftHold is a no-op success (nothing to release after an always-fail)', async () => {
		await expect(Effect.runPromise(make().releaseSoftHold('nonexistent-hold-id'))).resolves
			.toBeUndefined();
	});
});
