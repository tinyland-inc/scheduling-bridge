/**
 * CalComHttpClient — the Effect HTTP service the CalCom read-only pack's steps demand.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom: "its steps demand
 * `HttpClient`, not `BrowserService`; a REST flow never provisions a browser Layer").
 * TIN-2097 (Lane E).
 *
 * This is a SMALL Effect service (a Context.Tag), NOT `@effect/platform`'s HttpClient:
 * the bridge keeps "zero new runtime dependencies for src/flow/" (design §4) and the
 * established codebase pattern is `fetch` wrapped in `Effect.tryPromise` (used across
 * src/adapters/acuity/steps/*). The point of the lane is the R-channel PROOF — a REST
 * flow's R contains `CalComHttpClient`, never `BrowserService` — and a bridge-local tag
 * carries that proof without adding a dependency. The LIVE layer wraps global `fetch`;
 * tests substitute a cassette layer (recorded availability JSON) by Layer substitution.
 *
 * The service surface is deliberately read-shaped: `getJson(path, query)` GETs the
 * CalCom API v2 base, attaches the bearer + `cal-api-version` headers, and returns a
 * parsed JSON body OR a typed `CalComHttpError`. No write verbs exist — read-only first.
 */

import { Context, Effect, Layer } from 'effect';
import { CalComHttpError } from './errors.js';

/** CalCom API v2 base (public docs; read-only slots endpoint lives here). */
export const CALCOM_API_BASE = 'https://api.cal.com/v2';

/** The `cal-api-version` date pin CalCom requires on v2 requests. */
export const CALCOM_API_VERSION = '2024-09-04';

/** Connection config for the live client (bearer + base override for dev instances). */
export interface CalComClientConfig {
	/** Bearer API key. Read from deployment config; NEVER hardcoded. */
	readonly apiKey: string;
	/** Base URL override (a self-hosted dev instance); defaults to CALCOM_API_BASE. */
	readonly baseUrl?: string;
	/** `cal-api-version` override; defaults to CALCOM_API_VERSION. */
	readonly apiVersion?: string;
}

/**
 * The Effect HTTP service the CalCom steps require in their R channel. A successful
 * `getJson` yields the parsed JSON body as `unknown` (the slots parser, slots-api.ts,
 * narrows it); transport/non-2xx failures surface as a typed `CalComHttpError`.
 */
export interface CalComHttpClientShape {
	readonly getJson: (
		path: string,
		query?: Readonly<Record<string, string>>,
	) => Effect.Effect<unknown, CalComHttpError>;
}

export class CalComHttpClient extends Context.Tag('scheduling-bridge/CalComHttpClient')<
	CalComHttpClient,
	CalComHttpClientShape
>() {}

/** Build the query-string suffix (sorted for determinism), or '' when empty. */
const queryString = (query?: Readonly<Record<string, string>>): string => {
	if (!query) return '';
	const entries = Object.entries(query)
		.filter(([, value]) => value !== undefined && value !== '')
		.sort(([a], [b]) => a.localeCompare(b));
	if (entries.length === 0) return '';
	const params = new URLSearchParams();
	for (const [key, value] of entries) params.set(key, value);
	return `?${params.toString()}`;
};

/**
 * Live CalComHttpClient over global `fetch`. The bearer key stays in the Authorization
 * header (never in the path/query that the typed error echoes). A non-2xx response or a
 * thrown fetch maps to `CalComHttpError`.
 */
export const makeCalComHttpClient = (config: CalComClientConfig): CalComHttpClientShape => {
	const base = config.baseUrl ?? CALCOM_API_BASE;
	const apiVersion = config.apiVersion ?? CALCOM_API_VERSION;
	return {
		getJson: (path, query) =>
			Effect.tryPromise({
				try: async () => {
					const response = await fetch(`${base}${path}${queryString(query)}`, {
						method: 'GET',
						headers: {
							Authorization: `Bearer ${config.apiKey}`,
							'cal-api-version': apiVersion,
							Accept: 'application/json',
						},
					});
					if (!response.ok) {
						throw new CalComHttpError({
							path,
							status: response.status,
							message: `CalCom GET ${path} returned HTTP ${response.status}`,
						});
					}
					return (await response.json()) as unknown;
				},
				catch: (cause) =>
					cause instanceof CalComHttpError
						? cause
						: new CalComHttpError({
								path,
								status: null,
								message: `CalCom GET ${path} transport error`,
								cause,
							}),
			}),
	};
};

/** The live CalComHttpClient Layer (read deployment config; provide at the edge). */
export const CalComHttpClientLive = (
	config: CalComClientConfig,
): Layer.Layer<CalComHttpClient> =>
	Layer.succeed(CalComHttpClient, makeCalComHttpClient(config));

/**
 * A cassette-backed CalComHttpClient Layer for unit tests (and incident replay): a map
 * from request path to a recorded JSON body. Unknown paths fail with a transport-shaped
 * `CalComHttpError` (status 404) so a missing recording is loud, not silent. This is the
 * §11 "journal-as-cassette"/recorded-fixture mechanism applied to the REST modality —
 * proving the steps parse a real CalCom availability payload with NO live API.
 */
export const CalComHttpClientCassette = (
	recordings: Readonly<Record<string, unknown>>,
): Layer.Layer<CalComHttpClient> =>
	Layer.succeed(CalComHttpClient, {
		getJson: (path) =>
			path in recordings
				? Effect.succeed(recordings[path])
				: Effect.fail(
						new CalComHttpError({
							path,
							status: 404,
							message: `cassette miss: no recording for '${path}'`,
						}),
					),
	});
