import { describe, expect, it } from 'vitest';
import { Effect, Exit } from 'effect';
import fc from 'fast-check';
import {
	FuzzyMatchError,
	ServiceMatcher,
	ServiceMatcherLive,
	makeServiceMatcher,
	scoreLabel,
} from '../fuzzy.js';

const candidates = [
	{ label: 'Deep Tissue Massage', ref: '53178494' },
	{ label: 'Swedish Massage', ref: '11111111' },
	{ label: 'Acupuncture Consult', ref: '22222222' },
];

describe('scoreLabel cascade', () => {
	it('admits normalized-exact at 0.95 ahead of token overlap', () => {
		const score = scoreLabel('deep tissue massage!!', 'Deep Tissue Massage');
		expect(score).toEqual({ strategy: 'normalized-exact', confidence: 0.95 });
	});

	it('scales token overlap onto 0.5-0.9', () => {
		const score = scoreLabel('Deep Tissue', 'Deep Tissue Massage');
		expect(score.strategy).toBe('token-overlap');
		expect(score.confidence).toBeGreaterThanOrEqual(0.5);
		expect(score.confidence).toBeLessThanOrEqual(0.9);
	});

	it('scales Levenshtein fuzz onto 0.3-0.7 and floors hopeless queries at 0', () => {
		const fuzzy = scoreLabel('Massagee', 'Massage');
		expect(fuzzy.strategy).toBe('fuzzy');
		expect(fuzzy.confidence).toBeGreaterThanOrEqual(0.3);
		expect(fuzzy.confidence).toBeLessThanOrEqual(0.7);
		expect(scoreLabel('Yoga', 'Deep Tissue Massage').confidence).toBe(0);
	});
});

describe('makeServiceMatcher', () => {
	it('resolves by appointmentTypeId with confidence 1.0 (id-match)', async () => {
		const matcher = makeServiceMatcher();
		const resolution = await Effect.runPromise(
			matcher.match({ serviceName: 'whatever', appointmentTypeId: '53178494' }, candidates),
		);
		expect(resolution.strategy).toBe('id-match');
		expect(resolution.confidence).toBe(1.0);
		expect(resolution.value.ref).toBe('53178494');
		expect(resolution.alternates).toEqual([]);
	});

	it('falls through the cascade and reports alternates sorted by confidence', async () => {
		const matcher = makeServiceMatcher();
		const resolution = await Effect.runPromise(
			matcher.match({ serviceName: 'Deep Tissue Massage' }, candidates),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.matchedLabel).toBe('Deep Tissue Massage');
		expect(resolution.threshold).toBe(matcher.threshold);
		expect(resolution.alternates).toHaveLength(2);
		const confidences = resolution.alternates.map((a) => a.confidence);
		expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
	});

	it('fails with FuzzyMatchError when nothing clears the threshold', async () => {
		const matcher = makeServiceMatcher();
		const exit = await Effect.runPromiseExit(
			matcher.match({ serviceName: 'completely unrelated thing' }, candidates),
		);
		expect(Exit.isFailure(exit)).toBe(true);
		if (Exit.isFailure(exit) && exit.cause._tag === 'Fail') {
			expect(exit.cause.error).toBeInstanceOf(FuzzyMatchError);
			expect(exit.cause.error.threshold).toBe(matcher.threshold);
		}
	});

	it('keeps every admitted confidence within [threshold, 1]', async () => {
		const matcher = makeServiceMatcher();
		for (const query of ['Deep Tissue Massage', 'Deep Tissue', 'Swedish Massagee', 'acupuncture consult']) {
			const resolution = await Effect.runPromise(matcher.match({ serviceName: query }, candidates));
			expect(resolution.confidence).toBeGreaterThanOrEqual(matcher.threshold);
			expect(resolution.confidence).toBeLessThanOrEqual(1);
		}
	});

	it('is providable through the ServiceMatcherLive layer behind the scheduling-bridge tag', async () => {
		const resolution = await Effect.runPromise(
			Effect.gen(function* () {
				const matcher = yield* ServiceMatcher;
				return yield* matcher.match({ serviceName: 'Swedish Massage' }, candidates);
			}).pipe(Effect.provide(ServiceMatcherLive)),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(ServiceMatcher.key).toBe('scheduling-bridge/ServiceMatcher');
	});
});

// =============================================================================
// PROPERTY TESTS (design §11: bounds, threshold monotonicity, cascade ordering).
// The ServiceMatcher reuses the shared scorers; covered here alongside the new
// Date/Field matcher property suites so all three fuzzy lanes share the discipline.
// =============================================================================

const labelArb = fc.oneof(
	fc.constantFrom('Deep Tissue Massage', 'Swedish Massage', 'Acupuncture Consult', 'Massage'),
	fc.string({ maxLength: 24 }),
);

const candidatesArb = fc.array(
	fc.record({ label: fc.string({ minLength: 1, maxLength: 24 }), ref: fc.string({ minLength: 1, maxLength: 8 }) }),
	{ minLength: 0, maxLength: 6 },
);

describe('ServiceMatcher property tests (§11)', () => {
	it('scoreLabel confidence is always within [0,1]', () => {
		fc.assert(
			fc.property(labelArb, fc.string({ minLength: 1, maxLength: 24 }), (query, label) => {
				const { confidence } = scoreLabel(query, label);
				return confidence >= 0 && confidence <= 1;
			}),
		);
	});

	it('an admitted resolution confidence is within [threshold,1] and alternates sorted desc', () => {
		fc.assert(
			fc.property(
				labelArb,
				candidatesArb,
				fc.constantFrom(0, 0.3, 0.5, 0.95, 1),
				(serviceName, candidates, threshold) => {
					const matcher = makeServiceMatcher(threshold);
					const exit = Effect.runSyncExit(matcher.match({ serviceName }, candidates));
					if (Exit.isFailure(exit)) return true;
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
				labelArb,
				candidatesArb,
				fc.tuple(fc.constantFrom(0, 0.3, 0.5), fc.constantFrom(0.5, 0.95, 1)),
				(serviceName, candidates, [lo, hi]) => {
					const low = Math.min(lo, hi);
					const high = Math.max(lo, hi);
					const lowAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeServiceMatcher(low).match({ serviceName }, candidates)),
					);
					const highAdmits = Exit.isSuccess(
						Effect.runSyncExit(makeServiceMatcher(high).match({ serviceName }, candidates)),
					);
					return !highAdmits || lowAdmits;
				},
			),
		);
	});

	it('cascade ordering: a normalized-exact match outranks token-overlap and fuzzy strategies', () => {
		fc.assert(
			fc.property(labelArb, (label) => {
				// An identical label must resolve normalized-exact at 0.95 (id-match needs a ref).
				const exact = scoreLabel(label, label);
				if (normalizeForTest(label).length === 0) return true;
				return exact.strategy === 'normalized-exact' && exact.confidence === 0.95;
			}),
		);
	});
});

/** Mirror of the scorer's normalize (lowercase, strip punctuation) for the empty guard. */
const normalizeForTest = (s: string): string =>
	s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
