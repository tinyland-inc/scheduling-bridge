import { describe, expect, it } from 'vitest';
import { Cause, Context, Effect, Exit, Layer, Option, Schedule } from 'effect';
import { makeFlow } from '../flow.js';
import { FlowJournal, JournalError, createInMemoryFlowJournal, type FlowJournalShape } from '../journal.js';
import { FlowDivergedError, FlowRunError, runFlow } from '../run.js';
import { makeStep, observation, spec } from './helpers.js';

const identity = { flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' } as const;
const options = { operationId: 'op-1', sessionLayer: () => Layer.empty } as const;

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	if (!Exit.isFailure(exit)) throw new Error('expected a failure exit');
	const failure = Cause.failureOption(exit.cause);
	if (Option.isNone(failure)) throw new Error('expected a typed failure');
	return failure.value;
};

class StepFailure extends Error {
	readonly _tag = 'StepFailure';
}

describe('runFlow', () => {
	it('journals the happy-path checkpoint sequence and lands on the intended terminal', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: (input) =>
						Effect.succeed({
							state: { navResult: `nav:${input.bookingRef}` },
							observed: observation('acuity:client-form', ['acuity:client-form']),
						}),
				}),
			)
			.add(
				makeStep({
					id: 'acuity/fill-form',
					needs: ['navResult'],
					provides: ['formResult'],
					run: (input) => Effect.succeed({ state: { formResult: `form:${input.navResult}` } }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-9' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);

		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.terminalStepId).toBe('acuity/fill-form');
		expect(outcome.confidenceFloor).toBe(1);
		expect(outcome.output.formResult).toBe('form:nav:ref-9');

		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => [r.seq, r.stepId, r.status, r.attempt])).toEqual([
			[0, 'acuity/navigate', 'started', 1],
			[1, 'acuity/navigate', 'completed', 1],
			[2, 'acuity/fill-form', 'started', 1],
			[3, 'acuity/fill-form', 'completed', 1],
		]);
		expect(rows.every((r) => r.planHash === flow.planHash && r.flowId === flow.plan.flowId)).toBe(true);
		expect(rows[1].landing?.observed).toBe('acuity:client-form');
	});

	it('honors the step retry schedule', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'flaky',
					needs: [],
					provides: ['navResult'],
					retry: Schedule.recurs(2),
					run: () =>
						Effect.suspend(() => {
							runs += 1;
							return runs < 3
								? Effect.fail(new StepFailure('not yet'))
								: Effect.succeed({ state: { navResult: 'ok' } });
						}),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(runs).toBe(3);
		expect(outcome.output.navResult).toBe('ok');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'completed']);
	});

	it('defaults to Schedule.stop (no retry) and journals the failure', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'fragile',
					needs: [],
					provides: ['navResult'],
					run: () =>
						Effect.suspend(() => {
							runs += 1;
							return Effect.fail(new StepFailure('boom'));
						}),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(runs).toBe(1);
		expect(failureOf(exit)).toBeInstanceOf(StepFailure);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'failed']);
		expect(rows[1].error?.code).toBe('StepFailure');
	});

	it('reroutes backward along a declared recovery edge, decrementing the journaled budget', async () => {
		const journal = createInMemoryFlowJournal();
		let landings = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.sync(() => {
							landings += 1;
							return {
								state: { navResult: 'ok' },
								observed:
									landings === 1
										? observation('acuity:service-selection', ['acuity:client-form'])
										: observation('acuity:client-form', ['acuity:client-form']),
							};
						}),
				}),
			)
			.recover(
				'acuity/navigate',
				(_state, observed) => (observed === 'acuity:service-selection' ? 'acuity/navigate' : undefined),
				[{ to: 'acuity/navigate', maxReentries: 1 }],
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.landed).toBe('alternate-terminal');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => [r.status, r.attempt])).toEqual([
			['started', 1],
			['rerouted', 1],
			['started', 2],
			['completed', 2],
		]);
		expect(rows[1].reroute).toEqual({ to: 'acuity/navigate', remaining: 0 });
		expect(rows[1].landing?.observed).toBe('acuity:service-selection');
	});

	it('escalates to Diverged with the observation attached once the re-entry budget is exhausted', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.sync(() => {
							runs += 1;
							return {
								state: { navResult: 'ok' },
								observed: observation('acuity:service-selection', ['acuity:client-form']),
							};
						}),
				}),
			)
			.recover(
				'acuity/navigate',
				(_state, observed) => (observed === 'acuity:service-selection' ? 'acuity/navigate' : undefined),
				[{ to: 'acuity/navigate', maxReentries: 2 }],
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const error = failureOf(exit) as FlowDivergedError;
		expect(error._tag).toBe('FlowDivergedError');
		expect(error.stepId).toBe('acuity/navigate');
		expect(error.observation.observed).toBe('acuity:service-selection');

		// Termination bound: |nodes| x (1 + sum maxReentries) = 1 x (1 + 2) = 3 executions.
		expect(runs).toBe(3);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual([
			'started',
			'rerouted',
			'started',
			'rerouted',
			'started',
			'failed',
		]);
		expect(rows.filter((r) => r.status === 'rerouted').map((r) => r.reroute?.remaining)).toEqual([1, 0]);
		expect(rows[5].error?.code).toBe('FLOW_DIVERGED');
	});

	it('diverges (never reroutes) when the observed landing is not claimed by the chooser', async () => {
		// Must-fix regression: a step expecting 'acuity:client-form' with a recovery edge
		// motivated by 'acuity:service-selection' lands on an UNRELATED known station.
		// Without the chooser this was masked into a budget-bounded reroute; it must diverge.
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.sync(() => {
							runs += 1;
							return {
								state: { navResult: 'ok' },
								observed: observation('acuity:fatal-error-page', ['acuity:client-form']),
							};
						}),
				}),
			)
			.recover(
				'acuity/navigate',
				(_state, observed) => (observed === 'acuity:service-selection' ? 'acuity/navigate' : undefined),
				[{ to: 'acuity/navigate', maxReentries: 1 }],
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const error = failureOf(exit) as FlowDivergedError;
		expect(error._tag).toBe('FlowDivergedError');
		expect(error.observation.observed).toBe('acuity:fatal-error-page');
		expect(runs).toBe(1); // never re-driven
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.map((r) => r.status)).toEqual(['started', 'failed']);
		expect(rows.some((r) => r.status === 'rerouted')).toBe(false);
	});

	it('diverges when the chooser names a target that is not a declared recovery edge', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					expects: ['acuity:client-form'],
					run: () =>
						Effect.succeed({
							state: { navResult: 'ok' },
							observed: observation('acuity:service-selection', ['acuity:client-form']),
						}),
				}),
			)
			.add(
				makeStep({
					id: 'acuity/fill-form',
					needs: ['navResult'],
					provides: ['formResult'],
					run: () => Effect.succeed({ state: { formResult: 'ok' } }),
				}),
			)
			// Chooser bug: names a real step that is NOT among the declared edges. Fail closed.
			.recover('acuity/navigate', () => 'acuity/fill-form', [
				{ to: 'acuity/navigate', maxReentries: 1 },
			])
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const error = failureOf(exit) as FlowDivergedError;
		expect(error._tag).toBe('FlowDivergedError');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.some((r) => r.status === 'rerouted')).toBe(false);
	});

	it('routes via the chooser by observed station (not declaration order) with accumulated state', async () => {
		const journal = createInMemoryFlowJournal();
		let finalRuns = 0;
		let stateSeenByChooser: Record<string, unknown> | undefined;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'seed',
					needs: [],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'ok' } }),
				}),
			)
			.add(
				makeStep({
					id: 'mid',
					needs: ['navResult'],
					provides: ['formResult'],
					run: () => Effect.succeed({ state: { formResult: 'ok' } }),
				}),
			)
			.add(
				makeStep({
					id: 'final',
					needs: ['formResult'],
					provides: ['confirmation'],
					expects: ['acuity:confirmation'],
					run: () =>
						Effect.sync(() => {
							finalRuns += 1;
							return {
								state: { confirmation: 'ok' },
								observed:
									finalRuns === 1
										? observation('acuity:lost-form', ['acuity:confirmation'])
										: observation('acuity:confirmation', ['acuity:confirmation']),
							};
						}),
				}),
			)
			// 'seed' is declared FIRST; the chooser must still pick 'mid' for 'acuity:lost-form'.
			.recover(
				'final',
				(state, observed) => {
					stateSeenByChooser = { ...state };
					if (observed === 'acuity:lost-session') return 'seed';
					if (observed === 'acuity:lost-form') return 'mid';
					return undefined;
				},
				[
					{ to: 'seed', maxReentries: 1 },
					{ to: 'mid', maxReentries: 1 },
				],
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.landed).toBe('alternate-terminal');
		expect(stateSeenByChooser?.formResult).toBe('ok');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.find((r) => r.status === 'rerouted')?.reroute).toEqual({ to: 'mid', remaining: 0 });
		expect(rows.map((r) => [r.stepId, r.status])).toEqual([
			['seed', 'started'],
			['seed', 'completed'],
			['mid', 'started'],
			['mid', 'completed'],
			['final', 'started'],
			['final', 'rerouted'],
			['mid', 'started'],
			['mid', 'completed'],
			['final', 'started'],
			['final', 'completed'],
		]);
	});

	it('leaves an effectful-once started-without-completed trail visible in the journal', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'acuity/submit',
					needs: [],
					provides: ['confirmation'],
					idempotency: 'effectful-once',
					run: () => Effect.fail(new StepFailure('browser died mid-submit')),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		const rows = await Effect.runPromise(journal.read('op-1'));
		const submitRows = rows.filter((r) => r.stepId === 'acuity/submit');
		expect(submitRows.some((r) => r.status === 'started')).toBe(true);
		expect(submitRows.some((r) => r.status === 'completed')).toBe(false);
	});

	it('compensates succeeded steps in reverse order of success on failure', async () => {
		const journal = createInMemoryFlowJournal();
		const compensated: string[] = [];
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'a-out' } }),
					compensate: (output) =>
						Effect.sync(() => {
							compensated.push(`a:${output.navResult}`);
						}),
				}),
			)
			.add(
				makeStep({
					id: 'b',
					needs: [],
					provides: ['formResult'],
					run: () => Effect.succeed({ state: { formResult: 'b-out' } }),
					compensate: (output) =>
						Effect.sync(() => {
							compensated.push(`b:${output.formResult}`);
						}),
				}),
			)
			.add(
				makeStep({
					id: 'c',
					needs: [],
					provides: ['confirmation'],
					run: () => Effect.fail(new StepFailure('late failure')),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(failureOf(exit)).toBeInstanceOf(StepFailure);
		expect(compensated).toEqual(['b:b-out', 'a:a-out']);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.filter((r) => r.status === 'compensated').map((r) => r.stepId)).toEqual(['b', 'a']);
	});

	it('tolerates journal append failures (evidence-only: a failed checkpoint never fails the flow)', async () => {
		const deadJournal: FlowJournalShape = {
			append: () => Effect.fail(new JournalError({ message: 'redis down' })),
			read: () => Effect.succeed([]),
		};
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'ok' } }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, deadJournal)),
		);
		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.output.navResult).toBe('ok');
	});

	it('accumulates the confidence floor from fuzzy resolutions and journals them', async () => {
		const journal = createInMemoryFlowJournal();
		const resolution = (confidence: number) => ({
			value: 'svc',
			confidence,
			strategy: 'token-overlap' as const,
			matchedLabel: 'Deep Tissue Massage',
			threshold: 0.3,
			alternates: [],
		});
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'a',
					needs: [],
					provides: ['navResult'],
					run: () =>
						Effect.succeed({ state: { navResult: 'ok' }, resolutions: [resolution(0.95)] }),
				}),
			)
			.add(
				makeStep({
					id: 'b',
					needs: [],
					provides: ['formResult'],
					run: () =>
						Effect.succeed({ state: { formResult: 'ok' }, resolutions: [resolution(0.7)] }),
				}),
			)
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.confidenceFloor).toBe(0.7);
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.find((r) => r.stepId === 'a' && r.status === 'completed')?.resolutions?.[0]?.confidence).toBe(0.95);
	});

	it('journals minted idempotency tokens and re-attaches them on re-entry', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'payment/apply-coupon',
					needs: [],
					provides: ['navResult'],
					expects: ['acuity:payment'],
					run: () =>
						Effect.sync(() => {
							runs += 1;
							return {
								state: { navResult: 'ok' },
								idempotencyToken: 'ALT-COUPON-1',
								observed:
									runs === 1
										? observation('acuity:service-selection', ['acuity:payment'])
										: observation('acuity:payment', ['acuity:payment']),
							};
						}),
				}),
			)
			.recover(
				'payment/apply-coupon',
				(_state, observed) => (observed === 'acuity:service-selection' ? 'payment/apply-coupon' : undefined),
				[{ to: 'payment/apply-coupon', maxReentries: 1 }],
			)
			.build(identity);

		await Effect.runPromise(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		const rows = await Effect.runPromise(journal.read('op-1'));
		// First started row: no token minted yet; re-entry started row reuses the journaled token.
		expect(rows[0].status).toBe('started');
		expect(rows[0].idempotencyToken).toBeUndefined();
		expect(rows[2].status).toBe('started');
		expect(rows[2].idempotencyToken).toBe('ALT-COUPON-1');
		expect(rows[3].idempotencyToken).toBe('ALT-COUPON-1');
	});

	it('provides the session layer once per segment Scope region', async () => {
		class TestSession extends Context.Tag('flow-test/Session')<TestSession, { readonly id: number }>() {}
		const journal = createInMemoryFlowJournal();
		let builds = 0;
		const seen: Record<string, number> = {};
		const sessionStep = (id: string, provides: 'navResult' | 'formResult' | 'confirmation', segment: string) =>
			makeStep({
				id,
				needs: [],
				provides: [provides],
				segment,
				run: () =>
					Effect.gen(function* () {
						const session = yield* TestSession;
						seen[id] = session.id;
						return { state: { [provides]: 'ok' } as never };
					}),
			});
		const flow = makeFlow(spec)
			.add(sessionStep('a1', 'navResult', 'seg-a'))
			.add(sessionStep('a2', 'formResult', 'seg-a'))
			.add(sessionStep('b1', 'confirmation', 'seg-b'))
			.build(identity);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, {
				operationId: 'op-1',
				sessionLayer: () =>
					Layer.sync(TestSession, () => {
						builds += 1;
						return { id: builds };
					}),
			}).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(outcome.landed).toBe('intended-terminal');
		expect(builds).toBe(2);
		expect(seen.a1).toBe(seen.a2);
		expect(seen.b1).not.toBe(seen.a1);
	});
});

// =============================================================================
// SEGMENT-BOUNDARY stateDelta + SEGMENT-REPLAY RESUME (design §5 "Checkpoint
// persistence discipline" / "Resume = replay at segment boundaries")
// =============================================================================

describe('runFlow stateDelta at segment boundaries', () => {
	it('journals Schema-encoded Provides state on segment-boundary completed rows only', async () => {
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'a1',
					needs: ['bookingRef'],
					provides: ['navResult'],
					segment: 'seg-a',
					run: (input) => Effect.succeed({ state: { navResult: `nav:${input.bookingRef}` } }),
				}),
			)
			.add(
				makeStep({
					id: 'a2',
					needs: ['navResult'],
					provides: ['formResult'],
					segment: 'seg-a',
					run: () => Effect.succeed({ state: { formResult: 'form-ok' } }),
				}),
			)
			.add(
				makeStep({
					id: 'b1',
					needs: ['formResult'],
					provides: ['confirmation'],
					segment: 'seg-b',
					run: () => Effect.succeed({ state: { confirmation: 'confirmed' } }),
				}),
			)
			.build(identity);

		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-1' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);

		const rows = await Effect.runPromise(journal.read('op-1'));
		const byStep = (stepId: string, status: string) =>
			rows.find((r) => r.stepId === stepId && r.status === status);

		// Mid-segment completed rows carry NO stateDelta; boundary rows do.
		expect(byStep('a1', 'completed')?.stateDelta).toBeUndefined();
		expect(byStep('a2', 'completed')?.stateDelta).toEqual({
			navResult: 'nav:ref-1',
			formResult: 'form-ok',
		});
		// Boundary deltas are cumulative over PROVIDED keys (the last boundary alone
		// reconstructs everything) and never include initial keys.
		expect(byStep('b1', 'completed')?.stateDelta).toEqual({
			navResult: 'nav:ref-1',
			formResult: 'form-ok',
			confirmation: 'confirmed',
		});
		expect(
			rows.every((r) => r.stateDelta === undefined || !('bookingRef' in r.stateDelta)),
		).toBe(true);
		expect(rows.filter((r) => r.status === 'started').every((r) => r.stateDelta === undefined)).toBe(true);
	});
});

describe('runFlow segment-replay resume (options.resume)', () => {
	/** Two-segment flow with per-step run counters; seg-b has two steps so the
	 * open-segment-from-its-head replay is observable (b1 must re-run, a1 must not). */
	const makeResumableFlow = (counters: Record<string, number>, failB2First: { fail: boolean }) =>
		makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'a1',
					needs: ['bookingRef'],
					provides: ['navResult'],
					segment: 'seg-a',
					run: (input) =>
						Effect.suspend(() => {
							counters.a1 = (counters.a1 ?? 0) + 1;
							return Effect.succeed({ state: { navResult: `nav:${input.bookingRef}` } });
						}),
				}),
			)
			.add(
				makeStep({
					id: 'b1',
					needs: ['navResult'],
					provides: ['formResult'],
					segment: 'seg-b',
					run: (input) =>
						Effect.suspend(() => {
							counters.b1 = (counters.b1 ?? 0) + 1;
							return Effect.succeed({ state: { formResult: `form:${input.navResult}` } });
						}),
				}),
			)
			.add(
				makeStep({
					id: 'b2',
					needs: ['formResult'],
					provides: ['confirmation'],
					segment: 'seg-b',
					run: () =>
						Effect.suspend(() => {
							counters.b2 = (counters.b2 ?? 0) + 1;
							return failB2First.fail
								? Effect.fail(new StepFailure('b2 boom'))
								: Effect.succeed({ state: { confirmation: 'confirmed' } });
						}),
				}),
			)
			.build(identity);

	it('skips completed segments via skipped_resume rows, decodes the boundary state, and re-runs the open segment from its head', async () => {
		const journal = createInMemoryFlowJournal();
		const counters: Record<string, number> = {};
		const gate = { fail: true };
		const flow = makeResumableFlow(counters, gate);

		// Lease 1: seg-a completes (boundary journaled), seg-b dies at b2.
		const first = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'ref-7' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(Exit.isFailure(first)).toBe(true);
		expect(counters).toEqual({ a1: 1, b1: 1, b2: 1 });
		const firstRowCount = (await Effect.runPromise(journal.read('op-1'))).length;

		// Lease 2 (resume): b2 now succeeds.
		gate.fail = false;
		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-7' }, { ...options, resume: true }).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);

		// a1 was skipped (decoded from the boundary stateDelta); seg-b re-ran from its head.
		expect(counters).toEqual({ a1: 1, b1: 2, b2: 2 });
		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.output.navResult).toBe('nav:ref-7');
		expect(outcome.output.formResult).toBe('form:nav:ref-7');
		expect(outcome.output.confirmation).toBe('confirmed');

		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.slice(firstRowCount).map((r) => [r.stepId, r.status, r.attempt])).toEqual([
			['a1', 'skipped_resume', 1],
			['b1', 'started', 2],
			['b1', 'completed', 2],
			['b2', 'started', 2],
			['b2', 'completed', 2],
		]);
		// The resumed run's boundary row re-encodes the cumulative provides.
		const finalBoundary = rows[rows.length - 1];
		expect(finalBoundary.stateDelta).toEqual({
			navResult: 'nav:ref-7',
			formResult: 'form:nav:ref-7',
			confirmation: 'confirmed',
		});
	});

	it('re-runs from the head (no skipped_resume rows) when no segment boundary was journaled', async () => {
		const journal = createInMemoryFlowJournal();
		let runs = 0;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'only',
					needs: [],
					provides: ['navResult'],
					idempotency: 'read',
					run: () =>
						Effect.suspend(() => {
							runs += 1;
							return runs === 1
								? Effect.fail(new StepFailure('first lease boom'))
								: Effect.succeed({ state: { navResult: 'ok' } });
						}),
				}),
			)
			.build(identity);

		const first = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(Exit.isFailure(first)).toBe(true);

		const outcome = await Effect.runPromise(
			runFlow(flow, {}, { ...options, resume: true }).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(runs).toBe(2);
		expect(outcome.output.navResult).toBe('ok');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.some((r) => r.status === 'skipped_resume')).toBe(false);
		// Attempt numbering continues across leases (journal-seeded).
		expect(rows.map((r) => [r.status, r.attempt])).toEqual([
			['started', 1],
			['failed', 1],
			['started', 2],
			['completed', 2],
		]);
	});

	it('replays a fully-completed journal without re-running any step', async () => {
		const journal = createInMemoryFlowJournal();
		const counters: Record<string, number> = {};
		const flow = makeResumableFlow(counters, { fail: false });

		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-2' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(counters).toEqual({ a1: 1, b1: 1, b2: 1 });

		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-2' }, { ...options, resume: true }).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		// Nothing re-ran; every node got a skipped_resume row; output decoded from the journal.
		expect(counters).toEqual({ a1: 1, b1: 1, b2: 1 });
		expect(outcome.landed).toBe('intended-terminal');
		expect(outcome.output.confirmation).toBe('confirmed');
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.slice(-3).map((r) => [r.stepId, r.status])).toEqual([
			['a1', 'skipped_resume'],
			['b1', 'skipped_resume'],
			['b2', 'skipped_resume'],
		]);
	});

	it('threads the journaled idempotencyToken back into the re-run step (design §5 token reuse)', async () => {
		const journal = createInMemoryFlowJournal();
		const seenContexts: (string | undefined)[] = [];
		let mints = 0;
		let failT2 = true;
		const flow = makeFlow(spec)
			.add(
				makeStep({
					id: 'payment/apply-coupon',
					needs: [],
					provides: ['navResult'],
					run: (_input, context) =>
						Effect.suspend(() => {
							seenContexts.push(context?.idempotencyToken);
							const token =
								context?.idempotencyToken ??
								(() => {
									mints += 1;
									return `MINTED-${mints}`;
								})();
							return Effect.succeed({ state: { navResult: 'ok' }, idempotencyToken: token });
						}),
				}),
			)
			.add(
				makeStep({
					id: 't2',
					needs: ['navResult'],
					provides: ['formResult'],
					run: () =>
						Effect.suspend(() =>
							failT2
								? Effect.fail(new StepFailure('t2 boom'))
								: Effect.succeed({ state: { formResult: 'ok' } }),
						),
				}),
			)
			.build(identity);

		// Lease 1: the payment step mints and journals its token; the segment dies at t2
		// (same segment ⇒ no boundary ⇒ the whole segment re-runs on resume).
		const first = await Effect.runPromiseExit(
			runFlow(flow, {}, options).pipe(Effect.provideService(FlowJournal, journal)),
		);
		expect(Exit.isFailure(first)).toBe(true);
		expect(seenContexts).toEqual([undefined]);
		expect(mints).toBe(1);

		// Lease 2 (resume): the journaled token is threaded back in — no second mint.
		failT2 = false;
		await Effect.runPromise(
			runFlow(flow, {}, { ...options, resume: true }).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(seenContexts).toEqual([undefined, 'MINTED-1']);
		expect(mints).toBe(1);

		const rows = await Effect.runPromise(journal.read('op-1'));
		const resumedStarted = rows.filter(
			(r) => r.stepId === 'payment/apply-coupon' && r.status === 'started' && r.attempt === 2,
		);
		expect(resumedStarted).toHaveLength(1);
		expect(resumedStarted[0].idempotencyToken).toBe('MINTED-1');
	});

	it('refuses to re-run an effectful-once step with journaled execution evidence (EFFECTFUL_ONCE_REPLAY)', async () => {
		const journal = createInMemoryFlowJournal();
		let submits = 0;
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'a1',
					needs: ['bookingRef'],
					provides: ['navResult'],
					segment: 'seg-a',
					run: () => Effect.succeed({ state: { navResult: 'ok' } }),
				}),
			)
			.add(
				makeStep({
					id: 'submit',
					needs: ['navResult'],
					provides: ['formResult'],
					segment: 'seg-b',
					idempotency: 'effectful-once',
					run: () =>
						Effect.suspend(() => {
							submits += 1;
							return Effect.fail(new StepFailure('died mid-submit'));
						}),
				}),
			)
			.build(identity);

		const first = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'ref-3' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(Exit.isFailure(first)).toBe(true);
		expect(submits).toBe(1);

		const second = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'ref-3' }, { ...options, resume: true }).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		const error = failureOf(second);
		expect(error).toBeInstanceOf(FlowRunError);
		expect((error as FlowRunError).code).toBe('EFFECTFUL_ONCE_REPLAY');
		// The submit step was NEVER silently re-run.
		expect(submits).toBe(1);
	});

	it('without options.resume, existing journal rows are ignored (default behavior unchanged)', async () => {
		const journal = createInMemoryFlowJournal();
		const counters: Record<string, number> = {};
		const flow = makeResumableFlow(counters, { fail: false });

		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-4' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'ref-4' }, options).pipe(
				Effect.provideService(FlowJournal, journal),
			),
		);
		expect(counters).toEqual({ a1: 2, b1: 2, b2: 2 });
		const rows = await Effect.runPromise(journal.read('op-1'));
		expect(rows.some((r) => r.status === 'skipped_resume')).toBe(false);
	});
});
