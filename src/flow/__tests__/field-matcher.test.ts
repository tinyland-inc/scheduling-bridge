/**
 * FieldMatcher tests (design §6 fuzzy-in for intake fields; §11 property tests).
 *
 * Unit coverage proving result-equivalence with the legacy `fillRequiredTextareas`
 * keyword ladder, plus fast-check property suites for the §11 invariants: confidence
 * bounds [0,1], threshold monotonicity, and strategy-cascade ordering.
 */

import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import fc from 'fast-check';
import {
	DEFAULT_DEFERRED_VALUE,
	DEFAULT_FIELD_RULES,
	FieldMatcher,
	FieldMatcherLive,
	makeFieldMatcher,
	resolveFieldAnswer,
	scoreFieldRule,
	type FieldRule,
} from '../field-matcher.js';
import { FuzzyMatchError } from '../fuzzy.js';

describe('scoreFieldRule', () => {
	const workOn = DEFAULT_FIELD_RULES[0];
	const sleep = DEFAULT_FIELD_RULES[1];
	const fallback = DEFAULT_FIELD_RULES[2];

	it('substring keyword hit scores normalized-exact (0.95)', () => {
		expect(scoreFieldRule('What would you like to work on?', workOn)).toEqual({
			strategy: 'normalized-exact',
			confidence: 0.95,
		});
		expect(scoreFieldRule('Describe your session goals', workOn).strategy).toBe(
			'normalized-exact',
		);
		expect(scoreFieldRule('Hours of restful sleep?', sleep).strategy).toBe('normalized-exact');
	});

	it('the fallback rule always returns a low fuzzy floor', () => {
		expect(scoreFieldRule('anything at all', fallback)).toEqual({
			strategy: 'fuzzy',
			confidence: 0.1,
		});
	});

	it('a non-matching label against a keyword rule scores 0', () => {
		expect(scoreFieldRule('totally unrelated', sleep).confidence).toBe(0);
	});
});

describe('resolveFieldAnswer (result-equivalent to the legacy keyword ladder)', () => {
	const matcher = makeFieldMatcher();

	it('"work on"/"session" labels resolve to client notes, else "General wellness"', async () => {
		const withNotes = await Effect.runPromise(
			resolveFieldAnswer(matcher, 'What would you like to work on?', 'lower back'),
		);
		expect(withNotes.value).toBe('lower back');
		expect(withNotes.resolution?.value.id).toBe('work-on');

		const noNotes = await Effect.runPromise(
			resolveFieldAnswer(matcher, 'Goals for this session', undefined),
		);
		expect(noNotes.value).toBe(DEFAULT_DEFERRED_VALUE);
		expect(noNotes.value).toBe('General wellness');
	});

	it('"sleep" labels resolve to "7-8 hours"', async () => {
		const r = await Effect.runPromise(
			resolveFieldAnswer(matcher, 'How many hours of restful sleep?', 'ignored notes'),
		);
		expect(r.value).toBe('7-8 hours');
		expect(r.resolution?.value.id).toBe('sleep');
	});

	it('unrecognized labels fall to the "N/A" fallback (matcher stays total)', async () => {
		const r = await Effect.runPromise(
			resolveFieldAnswer(matcher, 'Any allergies?', 'lower back'),
		);
		expect(r.value).toBe('N/A');
		expect(r.resolution?.value.id).toBe('fallback');
		expect(r.resolution?.strategy).toBe('fuzzy');
	});

	it('keyword hits beat the fallback floor', async () => {
		const r = await Effect.runPromise(resolveFieldAnswer(matcher, 'sleep', 'x'));
		expect(r.resolution?.value.id).toBe('sleep');
		expect(r.resolution?.alternates.some((a) => a.label === 'N/A')).toBe(true);
	});

	it('a floorless ruleset degrades to the inline default without throwing', async () => {
		const floorless = makeFieldMatcher(
			[DEFAULT_FIELD_RULES[0], DEFAULT_FIELD_RULES[1]],
			0,
		);
		const r = await Effect.runPromise(resolveFieldAnswer(floorless, 'unknown label', undefined));
		expect(r.value).toBe('N/A');
		expect(r.resolution).toBeUndefined();
	});
});

describe('makeFieldMatcher / FieldMatcherLive', () => {
	it('fails with FuzzyMatchError when even the floor cannot clear a positive threshold', async () => {
		const matcher = makeFieldMatcher([DEFAULT_FIELD_RULES[2]], 0.5); // fallback only, threshold 0.5
		const exit = await Effect.runPromiseExit(matcher.match({ label: 'whatever' }, []));
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
			expect(exit.cause.error).toBeInstanceOf(FuzzyMatchError);
			expect(exit.cause.error.threshold).toBe(0.5);
		}
	});

	it('is providable through FieldMatcherLive behind the scheduling-bridge tag', async () => {
		const resolution = await Effect.runPromise(
			Effect.gen(function* () {
				const matcher = yield* FieldMatcher;
				return yield* matcher.match({ label: 'work on' }, []);
			}).pipe(Effect.provide(FieldMatcherLive)),
		);
		expect(resolution.value.id).toBe('work-on');
		expect(FieldMatcher.key).toBe('scheduling-bridge/FieldMatcher');
	});
});

// =============================================================================
// PROPERTY TESTS (design §11: bounds, threshold monotonicity, cascade ordering)
// =============================================================================

const ruleArb: fc.Arbitrary<FieldRule> = fc.record({
	id: fc.string({ minLength: 1, maxLength: 8 }),
	label: fc.string({ minLength: 1, maxLength: 16 }),
	keywords: fc.array(fc.constantFrom('work on', 'session', 'sleep', 'allergy', ''), {
		maxLength: 3,
	}),
	value: fc.option(fc.string({ maxLength: 12 }), { nil: null }),
	minConfidence: fc.constantFrom(0, 0.25, 0.5, 0.95),
	fallback: fc.constant(false),
});

const labelArb = fc.oneof(
	fc.constantFrom(
		'What would you like to work on?',
		'How many hours of restful sleep?',
		'Goals for this session',
		'Any allergies?',
		'',
	),
	fc.string({ maxLength: 24 }),
);

describe('FieldMatcher property tests (§11)', () => {
	it('scoreFieldRule confidence is always within [0,1]', () => {
		fc.assert(
			fc.property(labelArb, ruleArb, (label, rule) => {
				const { confidence } = scoreFieldRule(label, rule);
				return confidence >= 0 && confidence <= 1;
			}),
		);
	});

	it('the default matcher is total (always admits) and resolution confidence is within [0,1]', () => {
		fc.assert(
			fc.property(labelArb, (label) => {
				const matcher = makeFieldMatcher();
				const exit = Effect.runSyncExit(matcher.match({ label }, []));
				if (Exit.isFailure(exit)) return false; // fallback keeps it total
				const r = exit.value;
				if (r.confidence < 0 || r.confidence > 1) return false;
				const confs = r.alternates.map((a) => a.confidence);
				for (let i = 1; i < confs.length; i++) {
					if (confs[i] > confs[i - 1]) return false; // sorted desc
				}
				return true;
			}),
		);
	});

	it('threshold monotonicity: a higher matcher threshold never admits where a lower one rejected', () => {
		const rules = [DEFAULT_FIELD_RULES[0], DEFAULT_FIELD_RULES[1]]; // no fallback ⇒ can reject
		fc.assert(
			fc.property(
				labelArb,
				fc.tuple(fc.constantFrom(0, 0.25, 0.5), fc.constantFrom(0.5, 0.95, 1)),
				(label, [lo, hi]) => {
					const low = Math.min(lo, hi);
					const high = Math.max(lo, hi);
					const lowAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeFieldMatcher(rules, low).match({ label }, [])),
					);
					const highAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeFieldMatcher(rules, high).match({ label }, [])),
					);
					return !highAdmits || lowAdmits;
				},
			),
		);
	});

	it('cascade ordering: a substring keyword hit (normalized-exact 0.95) outranks any token/fuzzy result', () => {
		fc.assert(
			fc.property(
				fc.constantFrom('work on', 'sleep', 'session'),
				(keyword) => {
					const rule: FieldRule = {
						id: 'k',
						label: 'k',
						keywords: [keyword],
						value: 'v',
						minConfidence: 0,
					};
					// A label containing the keyword substring must score normalized-exact 0.95,
					// strictly above any token-overlap (≤0.9) or fuzzy (≤0.1) result.
					const hit = scoreFieldRule(`prefix ${keyword} suffix`, rule);
					return hit.strategy === 'normalized-exact' && hit.confidence === 0.95;
				},
			),
		);
	});
});
