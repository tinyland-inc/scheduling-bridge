/**
 * DateMatcher — fuzzy-in for dates and time slots (design §6 "Dates/slots (0.7.0)").
 *
 * Formalizes two fragments that today live inline in the adapter:
 *  - the TZ-suffix normalization + slot-membership test duplicated in
 *    `src/adapters/acuity/wizard.ts` (`checkSlotAvailability`, both the numeric-id and
 *    service-name branches): strip a trailing `Z` or `±HH:MM` offset from both the
 *    requested datetime and each candidate slot, then test membership against the
 *    available slots;
 *  - the tolerant month/day targeting scattered across `wizard-calendar.ts`
 *    (`parseMonthLabel`/`parseYearMonthKey`/`navigateToMonth`), `read-availability.ts`,
 *    `read-slots.ts` (`getCalendarMonth`), and `read-via-url.ts` (`MONTH_INDEX_BY_NAME`):
 *    parse a "March 2026" calendar label, normalize a `YYYY-MM`/`YYYY-MM-DD` target.
 *
 * Shaped as a `FuzzyMatcher<DateMatchQuery, SlotCandidate>` exactly like `ServiceMatcher`
 * (value/confidence/strategy/matchedLabel/threshold/alternates), shipping as MACHINERY —
 * a `makeDateMatcher` factory + `DateMatcherLive` Layer + `DateMatcher` Context.Tag
 * (judge-mandated, design §4/§6; same posture as ServiceMatcher). Thresholds are data
 * (per-field `minConfidence`), never hardcoded into a step.
 *
 * The slot-membership result is behavior-preserving with the wizard inline test: an
 * exact (TZ-normalized) match is `strategy: 'normalized-exact'`, confidence 1.0; a
 * same-minute-different-suffix match is `normalized-exact` too (the suffix is stripped
 * before comparison); anything below the admitting threshold is a typed `FuzzyMatchError`.
 */

import { Context, Effect, Layer } from 'effect';
import {
	FuzzyMatchError,
	type FuzzyMatcher,
	type FuzzyResolution,
} from './fuzzy.js';

// =============================================================================
// PURE SCORING MACHINERY (date/TZ normalization + slot membership)
// =============================================================================

/** Calendar month names, lowercase, index 0 = january. SSOT for label parsing. */
export const MONTH_NAMES: readonly string[] = [
	'january',
	'february',
	'march',
	'april',
	'may',
	'june',
	'july',
	'august',
	'september',
	'october',
	'november',
	'december',
];

/** A parsed calendar position. `month` is 0-based (january = 0). */
export interface CalendarMonth {
	readonly month: number;
	readonly year: number;
}

/**
 * Strip a trailing `Z` or `±HH:MM` timezone suffix from an ISO datetime, leaving a
 * local-wall-clock string for comparison. Verbatim the normalizer duplicated in
 * `wizard.ts` (`(dt) => dt.replace(/([+-]\d{2}:\d{2}|Z)$/, '')`). The two adapter
 * copies of this regex collapse into this one function.
 */
export const stripTzSuffix = (datetime: string): string =>
	datetime.replace(/([+-]\d{2}:\d{2}|Z)$/, '');

/**
 * Parse a calendar month label like "March 2026", "March\n2026", or "March2026"
 * (nested spans) into a 0-based month + year. Consolidates the three identical
 * `text.match(/([A-Za-z]+)\s*(\d{4})/)` copies (wizard-calendar.ts `parseMonthLabel`,
 * read-availability.ts / read-slots.ts `getCalendarMonth` inline parsers).
 */
export const parseMonthLabel = (text: string): CalendarMonth | null => {
	const match = text.trim().match(/([A-Za-z]+)\s*(\d{4})/);
	if (!match) return null;

	const monthIdx = MONTH_NAMES.indexOf(match[1].toLowerCase());
	if (monthIdx === -1) return null;

	const year = parseInt(match[2], 10);
	if (!Number.isInteger(year)) return null;

	return { month: monthIdx, year };
};

/**
 * Parse a `YYYY-MM` target into a 0-based month + year. Consolidates
 * `wizard-calendar.ts:parseYearMonthKey` and the inline `targetMonth.split('-')`
 * arithmetic in the read steps. Strictly anchored (`^…$`) — byte-equivalent to the
 * former wizard-calendar copy, so the read-via-url validation guards
 * (`!parseYearMonthKey(targetMonth)` → "Invalid target month") keep rejecting anything
 * that is not exactly `YYYY-MM` (a `YYYY-MM-DD` value still fails the guard, unchanged).
 */
export const parseYearMonthKey = (value: string): CalendarMonth | null => {
	const match = value.match(/^(\d{4})-(\d{2})$/);
	if (!match) return null;

	const year = Number(match[1]);
	const month = Number(match[2]) - 1;
	if (!Number.isInteger(year) || !Number.isInteger(month) || month < 0 || month > 11) {
		return null;
	}

	return { month, year };
};

/**
 * Confidence that a calendar `current` position targets `target`, on a tolerant 0..1
 * scale: exact month+year = 1.0, same year (off by ≤2 months) decays, otherwise floors
 * at 0. Mirrors `navigateToMonth`'s "are we there yet?" predicate as a scored, journalable
 * signal rather than a silent loop condition. Same-month is the only admit at the default
 * threshold; the decay surfaces "how far off the requested month the calendar landed" in
 * the audit trail.
 */
export const scoreMonthTarget = (current: CalendarMonth, target: CalendarMonth): number => {
	const currentAbs = current.year * 12 + current.month;
	const targetAbs = target.year * 12 + target.month;
	const delta = Math.abs(currentAbs - targetAbs);
	if (delta === 0) return 1;
	if (delta > 2) return 0;
	// 1 month off → 0.5, 2 months off → 0.25.
	return 0.5 / delta;
};

// =============================================================================
// MATCHER TYPES
// =============================================================================

/** A candidate time slot read from the page (TZ-suffixed or local). */
export interface SlotCandidate {
	/** ISO 8601, with or without a trailing `Z`/offset. */
	readonly datetime: string;
	readonly available: boolean;
}

/** A date/slot match query: the requested datetime + the admitting policy. */
export interface DateMatchQuery {
	/** Requested datetime (ISO 8601, with or without a TZ suffix). */
	readonly datetime: string;
}

/**
 * Default admitting threshold for slot membership. 1.0 by default so behavior is
 * byte-identical to the wizard inline membership test (which only admits an exact,
 * TZ-normalized equal). Flows loosen it as DATA (`minConfidence`) to tolerate
 * minute-level jitter; policy tightening/loosening is a diff, never a code change.
 */
export const DEFAULT_DATE_MIN_CONFIDENCE = 1.0;

// =============================================================================
// SLOT-MEMBERSHIP SCORING
// =============================================================================

/**
 * Score a candidate slot against the requested datetime through the date cascade:
 *  - `id-match` (1.0): byte-equal datetime strings (suffix included);
 *  - `normalized-exact` (1.0): equal after stripping the TZ suffix from both sides —
 *    this is the wizard inline test, lifted verbatim;
 *  - `token-overlap` (0.9): same calendar date AND same hour, minutes differ;
 *  - `fuzzy` (0.5): same calendar date, hour differs;
 *  - else 0.
 * Unavailable slots floor at 0 regardless of string match (the inline test ANDs on
 * `s.available`).
 */
export const scoreSlot = (
	query: DateMatchQuery,
	candidate: SlotCandidate,
): { readonly strategy: FuzzyResolution<SlotCandidate>['strategy']; readonly confidence: number } => {
	if (!candidate.available) return { strategy: 'fuzzy', confidence: 0 };

	if (query.datetime === candidate.datetime) {
		return { strategy: 'id-match', confidence: 1 };
	}

	const reqNorm = stripTzSuffix(query.datetime);
	const candNorm = stripTzSuffix(candidate.datetime);
	if (reqNorm === candNorm) {
		return { strategy: 'normalized-exact', confidence: 1 };
	}

	// Same calendar date? (compare the YYYY-MM-DD prefix)
	const reqDate = reqNorm.slice(0, 10);
	const candDate = candNorm.slice(0, 10);
	if (reqDate.length === 10 && reqDate === candDate) {
		const reqHour = reqNorm.slice(11, 13);
		const candHour = candNorm.slice(11, 13);
		if (reqHour && reqHour === candHour) {
			return { strategy: 'token-overlap', confidence: 0.9 };
		}
		return { strategy: 'fuzzy', confidence: 0.5 };
	}

	return { strategy: 'fuzzy', confidence: 0 };
};

// =============================================================================
// MATCHER FACTORY + LAYER + TAG
// =============================================================================

/**
 * Build a DateMatcher: scores every candidate slot against the requested datetime
 * through `scoreSlot`, admits the best against `threshold`, and returns the
 * `FuzzyResolution` audit record (value = the matched slot, matchedLabel = its
 * datetime, alternates = the runners-up best-first). Fails with `FuzzyMatchError`
 * when nothing clears the threshold — the typed analogue of the inline membership
 * test returning `false`.
 */
export const makeDateMatcher = (
	threshold = DEFAULT_DATE_MIN_CONFIDENCE,
): FuzzyMatcher<DateMatchQuery, SlotCandidate> => ({
	threshold,
	match: (query, candidates) =>
		Effect.suspend(() => {
			const scored = candidates
				.map((candidate) => ({ candidate, score: scoreSlot(query, candidate) }))
				.sort((a, b) => b.score.confidence - a.score.confidence);
			const best = scored[0];

			if (!best || best.score.confidence < threshold) {
				return Effect.fail(
					new FuzzyMatchError({
						query: query.datetime,
						threshold,
						bestConfidence: best?.score.confidence ?? 0,
						message: `No slot candidate cleared threshold ${threshold} for '${query.datetime}'`,
					}),
				);
			}

			return Effect.succeed<FuzzyResolution<SlotCandidate>>({
				value: best.candidate,
				confidence: best.score.confidence,
				strategy: best.score.strategy,
				matchedLabel: best.candidate.datetime,
				threshold,
				alternates: scored
					.slice(1)
					.map(({ candidate, score }) => ({
						label: candidate.datetime,
						confidence: score.confidence,
					})),
			});
		}),
});

/**
 * Tolerant slot-membership test: TRUE iff some available slot clears the matcher's
 * admitting threshold against the requested datetime. Behavior-preserving drop-in for
 * the wizard inline `slots.some(s => s.available && normalize(s.datetime) === requestNorm)`
 * at the default threshold (1.0 admits only the TZ-normalized exact). Returns the
 * resolution too, so the calling step can surface it in `StepOutcome.resolutions`.
 */
export const matchSlotMembership = (
	matcher: FuzzyMatcher<DateMatchQuery, SlotCandidate>,
	datetime: string,
	slots: readonly SlotCandidate[],
): Effect.Effect<{ readonly member: boolean; readonly resolution?: FuzzyResolution<SlotCandidate> }> =>
	matcher.match({ datetime }, slots).pipe(
		Effect.map((resolution) => ({ member: true, resolution })),
		Effect.catchTag('FuzzyMatchError', () => Effect.succeed({ member: false })),
	);

export class DateMatcher extends Context.Tag('scheduling-bridge/DateMatcher')<
	DateMatcher,
	FuzzyMatcher<DateMatchQuery, SlotCandidate>
>() {}

/** Default DateMatcher layer (Layer substitution replaces test-seam overrides). */
export const DateMatcherLive: Layer.Layer<DateMatcher> = Layer.sync(DateMatcher, () =>
	makeDateMatcher(),
);
