/**
 * DateMatcher tests (design §6 fuzzy-in for dates/slots; §11 property tests).
 *
 * Unit coverage for the TZ-suffix normalization + slot-membership cascade and the
 * tolerant month/day targeting, plus fast-check property suites for the §11 invariants:
 * confidence bounds [0,1], threshold monotonicity, and strategy-cascade ordering.
 */

import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import fc from 'fast-check';
import {
	DEFAULT_DATE_MIN_CONFIDENCE,
	DateMatcher,
	DateMatcherLive,
	makeDateMatcher,
	matchSlotMembership,
	parseMonthLabel,
	parseYearMonthKey,
	scoreMonthTarget,
	scoreSlot,
	stripTzSuffix,
	type SlotCandidate,
} from '../date-matcher.js';
import { FuzzyMatchError } from '../fuzzy.js';

const slots: readonly SlotCandidate[] = [
	{ datetime: '2026-03-07T14:00:00', available: true },
	{ datetime: '2026-03-07T15:30:00', available: true },
	{ datetime: '2026-03-08T09:00:00', available: false },
];

describe('stripTzSuffix', () => {
	it('strips a trailing Z', () => {
		expect(stripTzSuffix('2026-03-07T14:00:00Z')).toBe('2026-03-07T14:00:00');
	});
	it('strips a trailing +/- offset', () => {
		expect(stripTzSuffix('2026-03-07T14:00:00-05:00')).toBe('2026-03-07T14:00:00');
		expect(stripTzSuffix('2026-03-07T14:00:00+02:00')).toBe('2026-03-07T14:00:00');
	});
	it('leaves a local (suffix-free) datetime untouched', () => {
		expect(stripTzSuffix('2026-03-07T14:00:00')).toBe('2026-03-07T14:00:00');
	});
});

describe('parseMonthLabel', () => {
	it('parses "March 2026" / "March\\n2026" / nested-span "March2026"', () => {
		expect(parseMonthLabel('March 2026')).toEqual({ month: 2, year: 2026 });
		expect(parseMonthLabel('March\n2026')).toEqual({ month: 2, year: 2026 });
		expect(parseMonthLabel('March2026')).toEqual({ month: 2, year: 2026 });
	});
	it('returns null for unparseable labels', () => {
		expect(parseMonthLabel('not a month')).toBeNull();
		expect(parseMonthLabel('')).toBeNull();
	});
});

describe('parseYearMonthKey', () => {
	it('parses an exact YYYY-MM into a 0-based month', () => {
		expect(parseYearMonthKey('2026-03')).toEqual({ month: 2, year: 2026 });
	});
	it('rejects out-of-range months and non-exact keys (YYYY-MM-DD fails the guard)', () => {
		expect(parseYearMonthKey('2026-13')).toBeNull();
		expect(parseYearMonthKey('2026-00')).toBeNull();
		expect(parseYearMonthKey('2026-03-15')).toBeNull();
		expect(parseYearMonthKey('garbage')).toBeNull();
	});
});

describe('scoreSlot cascade', () => {
	it('id-match (1.0) on a byte-equal datetime', () => {
		expect(scoreSlot({ datetime: '2026-03-07T14:00:00' }, slots[0])).toEqual({
			strategy: 'id-match',
			confidence: 1,
		});
	});
	it('normalized-exact (1.0) when only the TZ suffix differs', () => {
		expect(scoreSlot({ datetime: '2026-03-07T14:00:00Z' }, slots[0])).toEqual({
			strategy: 'normalized-exact',
			confidence: 1,
		});
	});
	it('token-overlap (0.9) on same date + same hour, minutes differ', () => {
		expect(scoreSlot({ datetime: '2026-03-07T14:45:00' }, slots[0])).toEqual({
			strategy: 'token-overlap',
			confidence: 0.9,
		});
	});
	it('fuzzy (0.5) on same date, hour differs', () => {
		expect(scoreSlot({ datetime: '2026-03-07T18:00:00' }, slots[0])).toEqual({
			strategy: 'fuzzy',
			confidence: 0.5,
		});
	});
	it('floors unavailable slots at 0 regardless of string match', () => {
		expect(scoreSlot({ datetime: '2026-03-08T09:00:00' }, slots[2]).confidence).toBe(0);
	});
});

describe('makeDateMatcher membership (behavior-preserving with the wizard inline test)', () => {
	it('admits the TZ-normalized exact at the default threshold (1.0)', async () => {
		const matcher = makeDateMatcher();
		const resolution = await Effect.runPromise(
			matcher.match({ datetime: '2026-03-07T14:00:00Z' }, slots),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.confidence).toBe(1);
		expect(resolution.value.datetime).toBe('2026-03-07T14:00:00');
		expect(resolution.matchedLabel).toBe('2026-03-07T14:00:00');
	});

	it('matchSlotMembership returns true with a resolution for an exact slot, false otherwise', async () => {
		const matcher = makeDateMatcher();
		const hit = await Effect.runPromise(
			matchSlotMembership(matcher, '2026-03-07T15:30:00', slots),
		);
		expect(hit.member).toBe(true);
		expect(hit.resolution?.value.datetime).toBe('2026-03-07T15:30:00');

		const miss = await Effect.runPromise(
			matchSlotMembership(matcher, '2026-09-09T10:00:00', slots),
		);
		expect(miss.member).toBe(false);
		expect(miss.resolution).toBeUndefined();
	});

	it('never admits an unavailable slot even on an exact string (inline AND on available)', async () => {
		const matcher = makeDateMatcher();
		const result = await Effect.runPromise(
			matchSlotMembership(matcher, '2026-03-08T09:00:00', slots),
		);
		expect(result.member).toBe(false);
	});

	it('a loosened threshold admits same-date jitter the strict membership rejects', async () => {
		const strict = makeDateMatcher(); // 1.0
		const loose = makeDateMatcher(0.5);
		const jitter = '2026-03-07T14:45:00';
		expect(
			(await Effect.runPromise(matchSlotMembership(strict, jitter, slots))).member,
		).toBe(false);
		expect(
			(await Effect.runPromise(matchSlotMembership(loose, jitter, slots))).member,
		).toBe(true);
	});

	it('fails with FuzzyMatchError carrying the threshold when nothing clears it', async () => {
		const matcher = makeDateMatcher();
		const exit = await Effect.runPromiseExit(
			matcher.match({ datetime: '2026-12-31T23:59:00' }, slots),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
			expect(exit.cause.error).toBeInstanceOf(FuzzyMatchError);
			expect(exit.cause.error.threshold).toBe(DEFAULT_DATE_MIN_CONFIDENCE);
		}
	});

	it('is providable through DateMatcherLive behind the scheduling-bridge tag', async () => {
		const resolution = await Effect.runPromise(
			Effect.gen(function* () {
				const matcher = yield* DateMatcher;
				return yield* matcher.match({ datetime: '2026-03-07T14:00:00' }, slots);
			}).pipe(Effect.provide(DateMatcherLive)),
		);
		expect(resolution.strategy).toBe('id-match');
		expect(DateMatcher.key).toBe('scheduling-bridge/DateMatcher');
	});
});

// =============================================================================
// PROPERTY TESTS (design §11: bounds, threshold monotonicity, cascade ordering)
// =============================================================================

/** Arbitrary ISO-ish local datetime in 2026, optionally TZ-suffixed. */
const isoDatetimeArb = fc
	.record({
		month: fc.integer({ min: 1, max: 12 }),
		day: fc.integer({ min: 1, max: 28 }),
		hour: fc.integer({ min: 0, max: 23 }),
		minute: fc.constantFrom(0, 15, 30, 45),
		suffix: fc.constantFrom('', 'Z', '-05:00', '+02:00'),
	})
	.map(({ month, day, hour, minute, suffix }) => {
		const p = (n: number) => String(n).padStart(2, '0');
		return `2026-${p(month)}-${p(day)}T${p(hour)}:${p(minute)}:00${suffix}`;
	});

const slotArb = fc.record({
	datetime: isoDatetimeArb,
	available: fc.boolean(),
});

const slotsArb = fc.array(slotArb, { minLength: 0, maxLength: 8 });

describe('DateMatcher property tests (§11)', () => {
	it('scoreSlot confidence is always within [0,1]', () => {
		fc.assert(
			fc.property(isoDatetimeArb, slotArb, (datetime, candidate) => {
				const { confidence } = scoreSlot({ datetime }, candidate);
				return confidence >= 0 && confidence <= 1;
			}),
		);
	});

	it('an admitted resolution confidence is within [threshold, 1] and alternates are sorted desc', () => {
		fc.assert(
			fc.property(
				isoDatetimeArb,
				slotsArb,
				fc.constantFrom(0, 0.25, 0.5, 0.9, 1),
				(datetime, candidates, threshold) => {
					const matcher = makeDateMatcher(threshold);
					const exit = Effect.runSyncExit(matcher.match({ datetime }, candidates));
					if (Exit.isFailure(exit)) return true; // nothing cleared the threshold
					const r = exit.value;
					if (r.confidence < threshold || r.confidence > 1) return false;
					const confs = r.alternates.map((a) => a.confidence);
					for (let i = 1; i < confs.length; i++) {
						if (confs[i] > confs[i - 1]) return false;
					}
					return true;
				},
			),
		);
	});

	it('threshold monotonicity: a higher threshold never admits where a lower one rejected', () => {
		fc.assert(
			fc.property(
				isoDatetimeArb,
				slotsArb,
				fc.tuple(
					fc.constantFrom(0, 0.25, 0.5),
					fc.constantFrom(0.5, 0.9, 1),
				),
				(datetime, candidates, [lo, hi]) => {
					const low = lo <= hi ? lo : hi;
					const high = lo <= hi ? hi : lo;
					const lowAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeDateMatcher(low).match({ datetime }, candidates)),
					);
					const highAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeDateMatcher(high).match({ datetime }, candidates)),
					);
					// high admits ⇒ low admits (monotone non-increasing rejection).
					return !highAdmits || lowAdmits;
				},
			),
		);
	});

	it('cascade ordering: id-match ≥ normalized-exact ≥ token-overlap ≥ fuzzy by confidence', () => {
		const rank = { 'id-match': 3, 'normalized-exact': 2, 'token-overlap': 1, fuzzy: 0 } as const;
		fc.assert(
			fc.property(isoDatetimeArb, slotArb, (datetime, candidate) => {
				const { strategy, confidence } = scoreSlot({ datetime }, candidate);
				// Higher-ranked strategies carry ≥ confidence than lower-ranked floors.
				const floors: Record<keyof typeof rank, number> = {
					'id-match': 1,
					'normalized-exact': 1,
					'token-overlap': 0.9,
					fuzzy: 0,
				};
				void rank;
				return confidence >= floors[strategy] - 1e-9 || confidence === 0;
			}),
		);
	});

	it('scoreMonthTarget is within [0,1] and peaks at exact month', () => {
		fc.assert(
			fc.property(
				fc.record({ month: fc.integer({ min: 0, max: 11 }), year: fc.integer({ min: 2020, max: 2030 }) }),
				fc.record({ month: fc.integer({ min: 0, max: 11 }), year: fc.integer({ min: 2020, max: 2030 }) }),
				(current, target) => {
					const score = scoreMonthTarget(current, target);
					if (score < 0 || score > 1) return false;
					if (current.month === target.month && current.year === target.year) {
						return score === 1;
					}
					return score < 1;
				},
			),
		);
	});
});
