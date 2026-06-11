import { describe, expect, it } from 'vitest';
import {
	normalizeServiceNameForMatch,
	serviceNameMatches,
} from './navigate.js';

describe('serviceNameMatches', () => {
	it('matches catalog service names with trailing whitespace against Acuity page text', () => {
		expect(
			serviceNameMatches(
				'TMD 1st Consultation & Session',
				'TMD 1st Consultation & Session ',
			),
		).toBe(true);
	});

	it('collapses repeated whitespace before comparing service names', () => {
		expect(
			serviceNameMatches(
				'TMD 1st Consultation & Session',
				'TMD   1st Consultation   &   Session',
			),
		).toBe(true);
	});

	it('does not match empty requested or candidate names', () => {
		expect(serviceNameMatches('TMD 1st Consultation & Session', '   ')).toBe(false);
		expect(serviceNameMatches('   ', 'TMD 1st Consultation & Session')).toBe(false);
	});
});

describe('normalizeServiceNameForMatch', () => {
	it('trims, lowercases, and normalizes inner whitespace', () => {
		expect(normalizeServiceNameForMatch('  TMD   1st Consultation & Session  ')).toBe(
			'tmd 1st consultation & session',
		);
	});
});
