/**
 * FieldMatcher — fuzzy-in for intake fields (design §6 "Intake fields (0.7.0)").
 *
 * Generalizes the required-textarea label inference inlined in
 * `src/adapters/acuity/steps/fill-form.ts` (`fillRequiredTextareas`): the hardcoded
 * keyword chain that maps a textarea's `<label>` text onto a default answer —
 * "work on"/"session" → client notes (else "General wellness"), "sleep" → "7-8 hours",
 * else "N/A". That chain was built "because field ids change when Jen edits the Acuity
 * intake form" (fill-form.ts comment), so the inference keys off label TEXT, not ids.
 *
 * This module turns that ad-hoc `if/else` ladder into shared scoring over label text,
 * shaped as a `FuzzyMatcher<FieldMatchQuery, FieldRule>` exactly like `ServiceMatcher`
 * and `DateMatcher` (value/confidence/strategy/matchedLabel/threshold/alternates),
 * shipping as MACHINERY — a `makeFieldMatcher` factory + `FieldMatcherLive` Layer +
 * `FieldMatcher` Context.Tag. Each rule carries its own keyword set and a `minConfidence`
 * (thresholds are DATA, design §6); the catch-all "N/A" rule is the floor that always
 * admits, so the matcher is total — every label resolves to some answer, with an honest
 * confidence + strategy trail for the journal.
 *
 * The default ruleset is behavior-preserving with the inline ladder: the same labels
 * map to the same answers, now with a confidence score and a runners-up trail.
 */

import { Context, Effect, Layer } from 'effect';
import { normalize, tokenOverlap } from './fuzzy.js';
import {
	FuzzyMatchError,
	type FuzzyMatcher,
	type FuzzyResolution,
} from './fuzzy.js';

// =============================================================================
// RULE MODEL
// =============================================================================

/**
 * A field-answer rule: when a label's text matches `keywords`, the field is answered
 * with `value`. `value: null` defers to the caller's contextual value (e.g. client
 * notes) — the inline ladder's "work on"/"session" branch used `clientNotes` when set.
 */
export interface FieldRule {
	/** Stable rule id (e.g. 'work-on', 'sleep', 'fallback'). */
	readonly id: string;
	/** Human-facing label this rule targets (the matchedLabel surfaced in the audit). */
	readonly label: string;
	/** Keyword phrases that, present in the field label, fire this rule. */
	readonly keywords: readonly string[];
	/** Default answer; null = use the caller-supplied contextual value. */
	readonly value: string | null;
	/** Per-rule admitting threshold (DATA, design §6). */
	readonly minConfidence: number;
	/** True for the catch-all rule that always admits at the floor. */
	readonly fallback?: boolean;
}

/** A field-inference query: the label text read off the page. */
export interface FieldMatchQuery {
	/** The `<label>` text for the required field (may be empty). */
	readonly label: string;
}

/**
 * The default ruleset, lifted from `fillRequiredTextareas`'s keyword chain. Order is
 * irrelevant — scoring picks the best, with the fallback flooring at its threshold.
 * Keyword phrases are matched substring-first (the inline `.includes()` semantics),
 * then token-overlap as a tolerant backstop.
 */
export const DEFAULT_FIELD_RULES: readonly FieldRule[] = [
	{
		id: 'work-on',
		label: 'What would you like to work on?',
		keywords: ['work on', 'session'],
		value: null, // defer to client notes; falls back to 'General wellness'
		minConfidence: 0.5,
	},
	{
		id: 'sleep',
		label: 'How many hours of restful sleep?',
		keywords: ['sleep'],
		value: '7-8 hours',
		minConfidence: 0.5,
	},
	{
		id: 'fallback',
		label: 'N/A',
		keywords: [],
		value: 'N/A',
		minConfidence: 0,
		fallback: true,
	},
];

/** The contextual answer used when the resolved rule defers (`value: null`). */
export const DEFAULT_DEFERRED_VALUE = 'General wellness';

// =============================================================================
// PURE SCORING MACHINERY (label-text → rule)
// =============================================================================

/**
 * Score a field label against a rule's keywords, on a 0..1 scale:
 *  - substring hit (the inline `label.toLowerCase().includes(keyword)` semantics) →
 *    `normalized-exact`, confidence 0.95 (highest non-id strategy);
 *  - else best token-overlap of the label against any keyword phrase, scaled onto
 *    0.5–0.9 above the 0.6 overlap floor → `token-overlap`;
 *  - the fallback rule (no keywords) → `fuzzy`, confidence 0.1, so it always clears its
 *    own zero threshold but loses to any real keyword hit;
 *  - else 0.
 */
export const scoreFieldRule = (
	label: string,
	rule: FieldRule,
): { readonly strategy: FuzzyResolution<FieldRule>['strategy']; readonly confidence: number } => {
	const lower = label.toLowerCase();

	if (rule.fallback && rule.keywords.length === 0) {
		// Floor: always admits at its (zero) threshold, beaten by any keyword hit.
		return { strategy: 'fuzzy', confidence: 0.1 };
	}

	// Substring match preserves the inline ladder's `.includes()` behavior.
	for (const keyword of rule.keywords) {
		if (keyword && lower.includes(keyword.toLowerCase())) {
			return { strategy: 'normalized-exact', confidence: 0.95 };
		}
	}

	// Tolerant backstop: token overlap of the label vs each keyword phrase.
	let bestOverlap = 0;
	for (const keyword of rule.keywords) {
		const overlap = tokenOverlap(label, keyword);
		if (overlap > bestOverlap) bestOverlap = overlap;
	}
	const TOKEN_FLOOR = 0.6;
	if (bestOverlap >= TOKEN_FLOOR) {
		const confidence = 0.5 + ((bestOverlap - TOKEN_FLOOR) / (1 - TOKEN_FLOOR)) * 0.4;
		return { strategy: 'token-overlap', confidence };
	}

	return { strategy: 'fuzzy', confidence: 0 };
};

// =============================================================================
// MATCHER FACTORY + LAYER + TAG
// =============================================================================

/**
 * Build a FieldMatcher over a ruleset: scores the label against every rule, admits the
 * best whose confidence clears BOTH the matcher threshold AND the rule's own
 * `minConfidence`, and returns the `FuzzyResolution` (value = the matched rule). The
 * fallback rule keeps the matcher total: an unrecognized label still resolves (to "N/A")
 * with an honest low confidence + `fuzzy` strategy in the trail. Fails with
 * `FuzzyMatchError` only when even the fallback is absent (an empty/floorless ruleset).
 */
export const makeFieldMatcher = (
	rules: readonly FieldRule[] = DEFAULT_FIELD_RULES,
	threshold = 0,
): FuzzyMatcher<FieldMatchQuery, FieldRule> => ({
	threshold,
	match: (query, _candidates) =>
		Effect.suspend(() => {
			// Rules are the candidate space (the page provides label text, not rules), so
			// the matcher scores against its OWN ruleset; the `candidates` arg is accepted
			// for interface conformance and ignored.
			void _candidates;
			const scored = rules
				.map((rule) => ({ rule, score: scoreFieldRule(query.label, rule) }))
				// A rule only competes if it clears its own per-rule minConfidence.
				.filter(({ rule, score }) => score.confidence >= rule.minConfidence)
				.sort((a, b) => b.score.confidence - a.score.confidence);
			const best = scored[0];

			if (!best || best.score.confidence < threshold) {
				return Effect.fail(
					new FuzzyMatchError({
						query: query.label,
						threshold,
						bestConfidence: best?.score.confidence ?? 0,
						message: `No field rule cleared threshold ${threshold} for label '${query.label}'`,
					}),
				);
			}

			return Effect.succeed<FuzzyResolution<FieldRule>>({
				value: best.rule,
				confidence: best.score.confidence,
				strategy: best.score.strategy,
				matchedLabel: best.rule.label,
				threshold,
				alternates: scored
					.slice(1)
					.map(({ rule, score }) => ({ label: rule.label, confidence: score.confidence })),
			});
		}),
});

/**
 * Resolve a field label to its concrete answer string, applying the deferred-value
 * convention (`value: null` → caller's `deferredValue`, defaulting to "General
 * wellness"). Behavior-preserving with `fillRequiredTextareas`'s ladder:
 *  - "work on"/"session" label → client notes (else "General wellness");
 *  - "sleep" label → "7-8 hours";
 *  - else → "N/A".
 * Returns the chosen value AND the resolution, so the fill-form step can surface the
 * resolution in `StepOutcome.resolutions`.
 */
export const resolveFieldAnswer = (
	matcher: FuzzyMatcher<FieldMatchQuery, FieldRule>,
	label: string,
	deferredValue?: string,
): Effect.Effect<{ readonly value: string; readonly resolution?: FuzzyResolution<FieldRule> }> =>
	matcher.match({ label }, []).pipe(
		Effect.map((resolution) => {
			const ruleValue = resolution.value.value;
			const value =
				ruleValue ?? (deferredValue?.trim() ? deferredValue.trim() : DEFAULT_DEFERRED_VALUE);
			return { value, resolution };
		}),
		// A floorless ruleset (no fallback) degrades to the inline default, never throws.
		Effect.catchTag('FuzzyMatchError', () =>
			Effect.succeed({
				value: deferredValue?.trim() ? deferredValue.trim() : 'N/A',
			}),
		),
	);

export class FieldMatcher extends Context.Tag('scheduling-bridge/FieldMatcher')<
	FieldMatcher,
	FuzzyMatcher<FieldMatchQuery, FieldRule>
>() {}

/** Default FieldMatcher layer (Layer substitution replaces test-seam overrides). */
export const FieldMatcherLive: Layer.Layer<FieldMatcher> = Layer.sync(FieldMatcher, () =>
	makeFieldMatcher(),
);
