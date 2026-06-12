/**
 * ServiceResolver — Multi-Strategy Service Name Matching
 *
 * Effect Context.Tag providing resilient service resolution with
 * cascading fallback strategies and confidence scoring.
 *
 * Strategies (tried in order via Effect.orElse):
 * 1. ID match    (confidence 1.0)  — match by Acuity numeric ID in BUSINESS object
 * 2. Normalized  (confidence 0.95) — strip punctuation, collapse whitespace, exact match
 * 3. Token overlap (0.5-0.9)       — word-level intersection scoring
 * 4. Fuzzy/Levenshtein (0.3-0.7)   — edit-distance based matching
 */

import { Context, Effect, Layer } from 'effect';
import type { Page, ElementHandle } from 'playwright-core';
import { ServiceResolverError } from './errors.js';
import { Selectors } from './selectors.js';
import type { AcuityBusinessData } from './steps/extract-business.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ServiceResolution {
	/** The matched DOM element (the .select-item container) */
	readonly element: ElementHandle;
	/** Confidence score 0-1 */
	readonly confidence: number;
	/** Which strategy produced the match */
	readonly strategy: 'id-match' | 'normalized-exact' | 'token-overlap' | 'fuzzy';
	/** The name as it appears on the page */
	readonly matchedName: string;
}

export interface ServiceResolverShape {
	readonly resolve: (
		page: Page,
		serviceName: string,
		appointmentTypeId?: string,
	) => Effect.Effect<ServiceResolution, ServiceResolverError>;
}

// =============================================================================
// CONTEXT TAG
// =============================================================================

export class ServiceResolver extends Context.Tag('scheduling-bridge/ServiceResolver')<
	ServiceResolver,
	ServiceResolverShape
>() {}

// =============================================================================
// STRING MATCHING UTILITIES
// =============================================================================

/** Normalize a string: lowercase, strip non-alphanumeric (keep spaces), collapse whitespace. */
export const normalize = (s: string): string =>
	s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();

/** Tokenize: split on whitespace into lowercase words. */
const tokenize = (s: string): Set<string> =>
	new Set(normalize(s).split(' ').filter(Boolean));

/** Token overlap score: |intersection| / max(|a|, |b|). */
export const tokenOverlap = (a: string, b: string): number => {
	const setA = tokenize(a);
	const setB = tokenize(b);
	if (setA.size === 0 || setB.size === 0) return 0;

	let intersection = 0;
	for (const token of setA) {
		if (setB.has(token)) intersection++;
	}

	return intersection / Math.max(setA.size, setB.size);
};

/** Levenshtein edit distance between two strings. */
export const levenshtein = (a: string, b: string): number => {
	const m = a.length;
	const n = b.length;

	// Optimize for empty strings
	if (m === 0) return n;
	if (n === 0) return m;

	// Single-row DP
	const row = Array.from({ length: n + 1 }, (_, i) => i);

	for (let i = 1; i <= m; i++) {
		let prev = i;
		for (let j = 1; j <= n; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const val = Math.min(
				row[j] + 1,      // deletion
				prev + 1,         // insertion
				row[j - 1] + cost // substitution
			);
			row[j - 1] = prev;
			prev = val;
		}
		row[n] = prev;
	}

	return row[n];
};

/** Fuzzy match confidence: 1 - (distance / maxLen). */
export const fuzzyConfidence = (a: string, b: string): number => {
	const na = normalize(a);
	const nb = normalize(b);
	const maxLen = Math.max(na.length, nb.length);
	if (maxLen === 0) return 0;

	const dist = levenshtein(na, nb);
	return Math.max(0, 1 - dist / maxLen);
};

// =============================================================================
// SERVICE EXTRACTION FROM PAGE
// =============================================================================

interface PageService {
	name: string;
	element: ElementHandle;
}

/** Extract all service items and their names from the page DOM. */
const extractPageServices = (page: Page): Effect.Effect<PageService[], never> =>
	Effect.tryPromise({
		try: async () => {
			const items = await page.$$(Selectors.serviceList[0]);
			const services: PageService[] = [];

			for (const item of items) {
				const nameEl = await item.$(Selectors.serviceName[0]);
				const name = await nameEl?.textContent();
				if (name?.trim()) {
					services.push({ name: name.trim(), element: item });
				}
			}

			return services;
		},
		catch: () => [] as PageService[],
	}).pipe(Effect.orElseSucceed(() => [] as PageService[]));

// =============================================================================
// STRATEGY IMPLEMENTATIONS
// =============================================================================

/** Strategy 1: Match by Acuity numeric ID via BUSINESS object. */
const tryIdMatch = (
	page: Page,
	pageServices: PageService[],
	appointmentTypeId: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> =>
	Effect.gen(function* () {
		// Try to get BUSINESS object from the page
		const business: AcuityBusinessData | null = yield* Effect.tryPromise({
			try: () => page.evaluate(() => (window as unknown as { BUSINESS?: AcuityBusinessData }).BUSINESS ?? null),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		if (!business) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName: appointmentTypeId,
				strategies: ['id-match'],
				message: 'BUSINESS object not available on page',
			}));
		}

		// Find the appointment type by ID
		let targetName: string | null = null;
		for (const types of Object.values(business.appointmentTypes ?? {})) {
			for (const apt of types as Array<{ id: number; name: string }>) {
				if (String(apt.id) === appointmentTypeId) {
					targetName = apt.name;
					break;
				}
			}
			if (targetName) break;
		}

		if (!targetName) {
			return yield* Effect.fail(new ServiceResolverError({
				serviceName: appointmentTypeId,
				strategies: ['id-match'],
				message: `Acuity ID ${appointmentTypeId} not found in BUSINESS object`,
			}));
		}

		// Now match the BUSINESS name to a DOM element
		const normalizedTarget = normalize(targetName);
		for (const svc of pageServices) {
			if (normalize(svc.name) === normalizedTarget) {
				return {
					element: svc.element,
					confidence: 1.0,
					strategy: 'id-match' as const,
					matchedName: svc.name,
				};
			}
		}

		return yield* Effect.fail(new ServiceResolverError({
			serviceName: appointmentTypeId,
			strategies: ['id-match'],
			message: `BUSINESS name "${targetName}" not found in DOM`,
		}));
	});

/** Strategy 2: Normalized exact match. */
const tryNormalizedMatch = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	const normalizedTarget = normalize(serviceName);

	for (const svc of pageServices) {
		if (normalize(svc.name) === normalizedTarget) {
			return Effect.succeed({
				element: svc.element,
				confidence: 0.95,
				strategy: 'normalized-exact' as const,
				matchedName: svc.name,
			});
		}
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['normalized-exact'],
		message: `No normalized match for "${serviceName}"`,
	}));
};

/** Strategy 3: Token overlap. */
const tryTokenOverlap = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	const TOKEN_THRESHOLD = 0.6;
	let bestMatch: PageService | null = null;
	let bestScore = 0;

	for (const svc of pageServices) {
		const score = tokenOverlap(serviceName, svc.name);
		if (score > bestScore) {
			bestScore = score;
			bestMatch = svc;
		}
	}

	if (bestMatch && bestScore >= TOKEN_THRESHOLD) {
		// Scale confidence: threshold maps to 0.5, perfect match maps to 0.9
		const confidence = 0.5 + (bestScore - TOKEN_THRESHOLD) / (1 - TOKEN_THRESHOLD) * 0.4;
		return Effect.succeed({
			element: bestMatch.element,
			confidence,
			strategy: 'token-overlap' as const,
			matchedName: bestMatch.name,
		});
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['token-overlap'],
		message: `Best token overlap score ${bestScore.toFixed(2)} below threshold ${TOKEN_THRESHOLD}`,
	}));
};

/** Strategy 4: Fuzzy/Levenshtein. */
const tryFuzzyMatch = (
	pageServices: PageService[],
	serviceName: string,
): Effect.Effect<ServiceResolution, ServiceResolverError> => {
	const FUZZY_THRESHOLD = 0.6; // distance/maxLen < 0.4 means confidence > 0.6
	let bestMatch: PageService | null = null;
	let bestConfidence = 0;

	for (const svc of pageServices) {
		const conf = fuzzyConfidence(serviceName, svc.name);
		if (conf > bestConfidence) {
			bestConfidence = conf;
			bestMatch = svc;
		}
	}

	if (bestMatch && bestConfidence >= FUZZY_THRESHOLD) {
		// Scale: 0.6 threshold -> 0.3 confidence, 1.0 -> 0.7
		const confidence = 0.3 + (bestConfidence - FUZZY_THRESHOLD) / (1 - FUZZY_THRESHOLD) * 0.4;
		return Effect.succeed({
			element: bestMatch.element,
			confidence,
			strategy: 'fuzzy' as const,
			matchedName: bestMatch.name,
		});
	}

	return Effect.fail(new ServiceResolverError({
		serviceName,
		strategies: ['fuzzy'],
		message: `Best fuzzy confidence ${bestConfidence.toFixed(2)} below threshold ${FUZZY_THRESHOLD}`,
	}));
};

// =============================================================================
// LIVE LAYER
// =============================================================================

export const ServiceResolverLive: Layer.Layer<ServiceResolver> = Layer.succeed(
	ServiceResolver,
	{
		resolve: (page, serviceName, appointmentTypeId) =>
			Effect.gen(function* () {
				const pageServices = yield* extractPageServices(page);

				if (pageServices.length === 0) {
					return yield* Effect.fail(new ServiceResolverError({
						serviceName,
						strategies: [],
						message: 'No services found on page',
					}));
				}

				const strategies: string[] = [];

				// Strategy 1: ID match (only if appointmentTypeId provided)
				if (appointmentTypeId) {
					const idResult = yield* tryIdMatch(page, pageServices, appointmentTypeId).pipe(
						Effect.tap(() => Effect.sync(() => strategies.push('id-match:success'))),
						Effect.tapError(() => Effect.sync(() => strategies.push('id-match:failed'))),
						Effect.orElse(() => {
							// Strategy 2: Normalized exact match
							return tryNormalizedMatch(pageServices, serviceName).pipe(
								Effect.tap(() => Effect.sync(() => strategies.push('normalized-exact:success'))),
								Effect.tapError(() => Effect.sync(() => strategies.push('normalized-exact:failed'))),
							);
						}),
						Effect.orElse(() => {
							// Strategy 3: Token overlap
							return tryTokenOverlap(pageServices, serviceName).pipe(
								Effect.tap(() => Effect.sync(() => strategies.push('token-overlap:success'))),
								Effect.tapError(() => Effect.sync(() => strategies.push('token-overlap:failed'))),
							);
						}),
						Effect.orElse(() => {
							// Strategy 4: Fuzzy
							return tryFuzzyMatch(pageServices, serviceName).pipe(
								Effect.tap(() => Effect.sync(() => strategies.push('fuzzy:success'))),
								Effect.tapError(() => Effect.sync(() => strategies.push('fuzzy:failed'))),
							);
						}),
					);
					return idResult;
				}

				// No ID — start from strategy 2
				const result = yield* tryNormalizedMatch(pageServices, serviceName).pipe(
					Effect.tap(() => Effect.sync(() => strategies.push('normalized-exact:success'))),
					Effect.tapError(() => Effect.sync(() => strategies.push('normalized-exact:failed'))),
					Effect.orElse(() =>
						tryTokenOverlap(pageServices, serviceName).pipe(
							Effect.tap(() => Effect.sync(() => strategies.push('token-overlap:success'))),
							Effect.tapError(() => Effect.sync(() => strategies.push('token-overlap:failed'))),
						),
					),
					Effect.orElse(() =>
						tryFuzzyMatch(pageServices, serviceName).pipe(
							Effect.tap(() => Effect.sync(() => strategies.push('fuzzy:success'))),
							Effect.tapError(() => Effect.sync(() => strategies.push('fuzzy:failed'))),
						),
					),
					Effect.mapError(() => new ServiceResolverError({
						serviceName,
						strategies,
						message: `No match found for "${serviceName}" across ${pageServices.length} services (tried: ${strategies.join(', ')})`,
					})),
				);

				return result;
			}),
	},
);

// =============================================================================
// TEST LAYER
// =============================================================================

/**
 * A static ServiceResolver for tests that always returns a mock resolution.
 */
export const ServiceResolverTest = (
	mockResolution?: Partial<ServiceResolution>,
): Layer.Layer<ServiceResolver> =>
	Layer.succeed(ServiceResolver, {
		resolve: () =>
			Effect.succeed({
				element: null as unknown as ElementHandle,
				confidence: 1.0,
				strategy: 'normalized-exact' as const,
				matchedName: 'Test Service',
				...mockResolution,
			}),
	});
