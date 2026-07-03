import { describe, expect, it } from 'vitest';
import {
	normalizeServiceNameForMatch,
	serviceNameMatches,
} from './navigate.js';

// =============================================================================
// TIN-945 Row 2 — service-name whitespace hardening
//
// Failure mode: a Stripe payment settled, then the Acuity finalize step could
// not re-locate the paid service on the wizard page and threw
//   Service "TMD 1st Consultation & Session " not found on the page
// because the catalog/config service string carried a whitespace variant
// (here a trailing space) that did not byte-equal the page's rendered text.
//
// The guard is `normalizeServiceNameForMatch` — `trim()` (which drops every
// Unicode WhiteSpace/LineTerminator code point, U+00A0 included) followed by
// `replace(/\s+/g, ' ')` (JS `\s` also spans NBSP, tab, VT/FF, CR/LF, and the
// Unicode space separators). These tests pin that contract across EVERY
// whitespace class named in the ticket, and prove a genuinely different
// service still fails to match (no over-broad collapse).
// =============================================================================

const CANONICAL = 'TMD 1st Consultation & Session';
const NBSP = ' '; // U+00A0 NO-BREAK SPACE

describe('serviceNameMatches — TIN-945 Row 2 whitespace classes', () => {
	it('tolerates a trailing space (the reported "X " not-found failure)', () => {
		expect(serviceNameMatches(CANONICAL, `${CANONICAL} `)).toBe(true);
	});

	it('tolerates a leading space', () => {
		expect(serviceNameMatches(CANONICAL, ` ${CANONICAL}`)).toBe(true);
	});

	it('tolerates a leading AND trailing space', () => {
		expect(serviceNameMatches(CANONICAL, `  ${CANONICAL}  `)).toBe(true);
	});

	it('tolerates a non-breaking space (U+00A0) between words', () => {
		expect(
			serviceNameMatches(CANONICAL, `TMD${NBSP}1st Consultation & Session`),
		).toBe(true);
	});

	it('tolerates leading/trailing non-breaking spaces (U+00A0)', () => {
		expect(
			serviceNameMatches(CANONICAL, `${NBSP}${CANONICAL}${NBSP}`),
		).toBe(true);
	});

	it('tolerates tab characters', () => {
		expect(
			serviceNameMatches(CANONICAL, 'TMD\t1st Consultation\t&\tSession'),
		).toBe(true);
	});

	it('tolerates newline characters', () => {
		expect(
			serviceNameMatches(CANONICAL, 'TMD\n1st Consultation\n&\nSession'),
		).toBe(true);
	});

	it('tolerates doubled / repeated internal spaces', () => {
		expect(
			serviceNameMatches(CANONICAL, 'TMD   1st Consultation   &   Session'),
		).toBe(true);
	});

	it('tolerates a mix of every whitespace class at once', () => {
		expect(
			serviceNameMatches(
				CANONICAL,
				`${NBSP} TMD \t1st  Consultation \n & ${NBSP} Session  `,
			),
		).toBe(true);
	});

	it('is symmetric — whitespace noise on the page-text (candidate) side also matches', () => {
		expect(
			serviceNameMatches(`  TMD${NBSP}1st Consultation & Session \t`, CANONICAL),
		).toBe(true);
	});
});

describe('serviceNameMatches — negative cases (no over-broad collapse)', () => {
	it('does NOT match a genuinely different service', () => {
		expect(serviceNameMatches(CANONICAL, 'Reiki Energy Healing')).toBe(false);
	});

	it('does NOT match a different service even after whitespace normalization', () => {
		expect(
			serviceNameMatches(CANONICAL, `Reiki${NBSP}Energy   Healing \t`),
		).toBe(false);
	});

	it('does NOT match empty / whitespace-only requested or candidate names', () => {
		expect(serviceNameMatches(CANONICAL, '   ')).toBe(false);
		expect(serviceNameMatches(CANONICAL, `${NBSP}\t\n `)).toBe(false);
		expect(serviceNameMatches('   ', CANONICAL)).toBe(false);
	});
});

describe('normalizeServiceNameForMatch', () => {
	it('trims, lowercases, and collapses inner whitespace to a single space', () => {
		expect(normalizeServiceNameForMatch('  TMD   1st Consultation & Session  ')).toBe(
			'tmd 1st consultation & session',
		);
	});

	it('normalizes every whitespace class to the same canonical form', () => {
		const canonical = 'tmd 1st consultation & session';
		expect(normalizeServiceNameForMatch(`${CANONICAL} `)).toBe(canonical);
		expect(normalizeServiceNameForMatch(` ${CANONICAL}`)).toBe(canonical);
		expect(normalizeServiceNameForMatch(`TMD${NBSP}1st Consultation & Session`)).toBe(
			canonical,
		);
		expect(normalizeServiceNameForMatch('TMD\t1st Consultation\t&\tSession')).toBe(
			canonical,
		);
		expect(normalizeServiceNameForMatch('TMD\n1st Consultation\n&\nSession')).toBe(
			canonical,
		);
		expect(normalizeServiceNameForMatch('TMD   1st Consultation   &   Session')).toBe(
			canonical,
		);
		expect(
			normalizeServiceNameForMatch(`${NBSP} TMD \t1st  Consultation \n & ${NBSP} Session  `),
		).toBe(canonical);
	});
});
