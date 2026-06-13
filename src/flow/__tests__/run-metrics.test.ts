/**
 * Per-stepId metrics recorded by the fold (design §10 0.6.x "per-stepId metrics").
 * The fold invokes the optional FlowMetricsHook by stepId for attempts, failures,
 * reroutes, run duration, and landing outcomes. Absent hook ⇒ no recording (flag-off
 * behavior unchanged). Recorded against the run's own state spec; the production
 * wiring backs the hook with shared/metrics.ts prom-client collectors.
 */

import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFlow } from '../flow.js';
import { FlowJournal, createInMemoryFlowJournal } from '../journal.js';
import { runFlow, type FlowMetricsHook } from '../run.js';
import { makeStep, observation, spec } from './helpers.js';

const identity = { flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' } as const;

const spyHook = () => {
	const calls = {
		attempt: [] as [string, string][],
		failure: [] as [string, string][],
		reroute: [] as [string, string][],
		duration: [] as [string, string, number][],
		landing: [] as [string, string, string][],
	};
	const hook: FlowMetricsHook = {
		onAttempt: (f, s) => calls.attempt.push([f, s]),
		onFailure: (f, s) => calls.failure.push([f, s]),
		onReroute: (f, s) => calls.reroute.push([f, s]),
		onDuration: (f, s, d) => calls.duration.push([f, s, d]),
		onLanding: (f, s, l) => calls.landing.push([f, s, l]),
	};
	return { hook, calls };
};

const runOptions = (metrics?: FlowMetricsHook) => ({
	operationId: 'op-metrics',
	sessionLayer: () => Layer.empty,
	...(metrics ? { metrics } : {}),
});

class StepFailure extends Error {
	readonly _tag = 'StepFailure';
}

describe('runFlow per-stepId metrics', () => {
	it('records attempt, duration, and on-track landing per step on the happy path', async () => {
		const { hook, calls } = spyHook();
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
							observed: observation('acuity:client-form', ['acuity:client-form']),
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
			.build(identity);

		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'r' }, runOptions(hook)).pipe(
				Effect.provideService(FlowJournal, createInMemoryFlowJournal()),
			),
		);

		expect(calls.attempt).toEqual([
			['booking_create_with_payment', 'acuity/navigate'],
			['booking_create_with_payment', 'acuity/fill-form'],
		]);
		expect(calls.duration.map(([f, s]) => [f, s])).toEqual([
			['booking_create_with_payment', 'acuity/navigate'],
			['booking_create_with_payment', 'acuity/fill-form'],
		]);
		expect(calls.duration.every(([, , d]) => typeof d === 'number' && d >= 0)).toBe(true);
		expect(calls.landing).toEqual([
			['booking_create_with_payment', 'acuity/navigate', 'on-track'],
			['booking_create_with_payment', 'acuity/fill-form', 'on-track'],
		]);
		expect(calls.failure).toEqual([]);
		expect(calls.reroute).toEqual([]);
	});

	it('records a failure (and its duration) when a step run errors', async () => {
		const { hook, calls } = spyHook();
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					run: () => Effect.fail(new StepFailure('boom')),
				}),
			)
			.build(identity);

		const exit = await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, runOptions(hook)).pipe(
				Effect.provideService(FlowJournal, createInMemoryFlowJournal()),
			),
		);
		expect(exit._tag).toBe('Failure');
		expect(calls.attempt).toEqual([['booking_create_with_payment', 'acuity/navigate']]);
		expect(calls.failure).toEqual([['booking_create_with_payment', 'acuity/navigate']]);
		expect(calls.duration).toHaveLength(1);
		expect(calls.landing).toEqual([]);
	});

	it('records a diverged landing when an unexpected, unrecoverable station is observed', async () => {
		const { hook, calls } = spyHook();
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
			.build(identity);

		await Effect.runPromiseExit(
			runFlow(flow, { bookingRef: 'r' }, runOptions(hook)).pipe(
				Effect.provideService(FlowJournal, createInMemoryFlowJournal()),
			),
		);
		expect(calls.landing).toEqual([
			['booking_create_with_payment', 'acuity/navigate', 'diverged'],
		]);
		expect(calls.failure).toEqual([]); // the run itself succeeded; classification diverged
	});

	it('records a recoverable landing and a reroute on a budgeted recovery edge', async () => {
		const { hook, calls } = spyHook();
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
				(_s, observed) => (observed === 'acuity:service-selection' ? 'acuity/navigate' : undefined),
				[{ to: 'acuity/navigate', maxReentries: 1 }],
			)
			.build(identity);

		await Effect.runPromise(
			runFlow(flow, { bookingRef: 'r' }, runOptions(hook)).pipe(
				Effect.provideService(FlowJournal, createInMemoryFlowJournal()),
			),
		);
		expect(calls.reroute).toEqual([['booking_create_with_payment', 'acuity/navigate']]);
		expect(calls.landing).toEqual([
			['booking_create_with_payment', 'acuity/navigate', 'recoverable'],
			['booking_create_with_payment', 'acuity/navigate', 'on-track'],
		]);
		expect(calls.attempt).toHaveLength(2);
	});

	it('records nothing when no metrics hook is supplied (flag-off behavior unchanged)', async () => {
		const flow = makeFlow(spec, ['bookingRef'])
			.add(
				makeStep({
					id: 'acuity/navigate',
					needs: ['bookingRef'],
					provides: ['navResult'],
					run: () => Effect.succeed({ state: { navResult: 'ok' } }),
				}),
			)
			.build(identity);
		// No metrics field ⇒ the fold never touches a hook (nothing to assert beyond
		// a clean run; this pins that the hook is optional and absence is safe).
		const outcome = await Effect.runPromise(
			runFlow(flow, { bookingRef: 'r' }, runOptions()).pipe(
				Effect.provideService(FlowJournal, createInMemoryFlowJournal()),
			),
		);
		expect(outcome.landed).toBe('intended-terminal');
	});
});
