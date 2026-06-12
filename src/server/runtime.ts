/**
 * Effect runner: ManagedRuntime over the browser process layer, plus the
 * runner test hook.
 *
 * Extracted verbatim from `src/server/handler.ts` (handler decomposition
 * phase 1, TIN-2036 / docs/design/flow-dag-formalization.md section 8).
 * Pure code motion: `runEffect` stays a mutable module binding so the
 * `__setEffectRunnerForTest` seam keeps working through ESM live bindings
 * (re-exported from `handler.ts` for existing importers).
 */

import { Effect, Exit, Cause, ManagedRuntime, Scope } from 'effect';
import {
	BrowserProcessLive,
	BrowserService,
	BrowserSessionLive,
} from '../shared/browser-service.js';
import {
	toSchedulingError,
	type MiddlewareError,
} from '../adapters/acuity/errors.js';
import type { SchedulingError } from '../core/types.js';
import { browserConfig } from './config.js';

export const browserRuntime = ManagedRuntime.make(
	BrowserProcessLive(browserConfig),
);

export type Result<A> =
	| { ok: true; value: A }
	| { ok: false; error: SchedulingError };

const exitToResult = <A>(
	exit: Exit.Exit<A, MiddlewareError | undefined>,
): Result<A> => {
	if (Exit.isSuccess(exit)) {
		return { ok: true, value: exit.value };
	}
	const failure = Cause.failureOption(exit.cause);
	if (failure._tag === 'Some' && failure.value !== undefined) {
		return { ok: false, error: toSchedulingError(failure.value) };
	}
	return {
		ok: false,
		error: {
			_tag: 'InfrastructureError',
			code: 'UNKNOWN',
			message: Cause.pretty(exit.cause),
		},
	};
};

export type RunEffect = <A>(
	effect: Effect.Effect<
		A,
		MiddlewareError | undefined,
		BrowserService | Scope.Scope
	>,
) => Promise<Result<A>>;

export const runEffectWithBrowser: RunEffect = async <A>(
	effect: Effect.Effect<
		A,
		MiddlewareError | undefined,
		BrowserService | Scope.Scope
	>,
): Promise<Result<A>> => {
	const exit = await browserRuntime.runPromiseExit(
		Effect.scoped(effect.pipe(Effect.provide(BrowserSessionLive))),
	);
	return exitToResult(exit);
};

export let runEffect: RunEffect = runEffectWithBrowser;

export const __runEffectWithoutBrowserForTest: RunEffect = async <A>(
	effect: Effect.Effect<
		A,
		MiddlewareError | undefined,
		BrowserService | Scope.Scope
	>,
): Promise<Result<A>> => {
	const exit = await Effect.runPromiseExit(
		effect as Effect.Effect<A, MiddlewareError | undefined, never>,
	);
	return exitToResult(exit);
};

export const __setEffectRunnerForTest = (runner: RunEffect | null) => {
	runEffect = runner ?? runEffectWithBrowser;
};
