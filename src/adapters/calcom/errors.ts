/**
 * CalCom REST error types — the read-only pack's honest error channel.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom bullet), §10 (0.7.0 block).
 * TIN-2097 (Lane E).
 *
 * The CalCom pack is REST-backed: its steps never touch a browser, so they never
 * raise `BrowserError`/`SelectorError`/`WizardStepError` (the Acuity DOM-automation
 * `MiddlewareError` family). Their honest failure modes are transport (`CalComHttpError`)
 * and response-shape (`CalComResponseError`) only. Keeping a CalCom-specific error union
 * — rather than reusing Acuity's `MiddlewareError` — is the type-level proof that the REST
 * lane shares no DOM machinery with the browser lane.
 */

import { Data } from 'effect';

/** Transport failure: the CalCom HTTP request never produced a usable response. */
export class CalComHttpError extends Data.TaggedError('CalComHttpError')<{
	/** Request path that failed (no query string with secrets). */
	readonly path: string;
	/** HTTP status when a response WAS received; null on a network/transport error. */
	readonly status: number | null;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Response-shape failure: a 2xx response whose body did not match the slots schema. */
export class CalComResponseError extends Data.TaggedError('CalComResponseError')<{
	readonly path: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** The CalCom read-only pack's error channel (mirrors the role of Acuity's MiddlewareError). */
export type CalComRestError = CalComHttpError | CalComResponseError;
