import { describe, expect, it } from 'vitest';

import {
	buildAvailabilityDatesCacheKey,
	getDatePrewarmMonths,
	selectDatePrewarmMonths,
} from './date-prewarm.js';

describe('date prewarm helpers', () => {
	it('defaults to one month and caps aggressive env values', () => {
		expect(getDatePrewarmMonths({})).toBe(1);
		expect(getDatePrewarmMonths({ ACUITY_DATE_PREWARM_MONTHS: '2' })).toBe(2);
		expect(getDatePrewarmMonths({ ACUITY_DATE_PREWARM_MONTHS: '99' })).toBe(2);
	});

	it('allows disabling date prewarm with zero or negative env values', () => {
		expect(getDatePrewarmMonths({ ACUITY_DATE_PREWARM_MONTHS: '0' })).toBe(0);
		expect(getDatePrewarmMonths({ ACUITY_DATE_PREWARM_MONTHS: '-1' })).toBe(0);
	});

	it('selects months after the requested target month', () => {
		expect(selectDatePrewarmMonths('2026-07', 2)).toEqual([
			'2026-08',
			'2026-09',
		]);
	});

	it('accepts route startDate values when selecting prewarm months', () => {
		expect(selectDatePrewarmMonths('2026-12-01', 2)).toEqual([
			'2027-01',
			'2027-02',
		]);
	});

	it('falls back to the current month when no route month is provided', () => {
		expect(
			selectDatePrewarmMonths(undefined, 1, new Date(2026, 4, 15)),
		).toEqual(['2026-06']);
	});

	it('builds the same date cache key used by the public dates route', () => {
		expect(
			buildAvailabilityDatesCacheKey(
				'https://MassageIthaca.as.me',
				'53178494',
				'2026-08',
			),
		).toBe('bridge-read:v2:dates:https://MassageIthaca.as.me:53178494:2026-08');
	});
});
