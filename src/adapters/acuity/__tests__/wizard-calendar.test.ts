import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import {
	MAX_CALENDAR_NAVIGATION_STEPS,
	MONTH_NAMES,
	navigateToMonth,
	parseYearMonthKey,
	type CalendarMonth,
} from '../wizard-calendar.js';

const addMonths = (current: CalendarMonth, delta: number): CalendarMonth => {
	const date = new Date(current.year, current.month + delta, 1);
	return { year: date.getFullYear(), month: date.getMonth() };
};

const formatMonthLabel = (current: CalendarMonth): string => {
	const month = MONTH_NAMES[current.month];
	return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${current.year}`;
};

const makeCalendarPage = (start: CalendarMonth) => {
	let current = start;
	let navClicks = 0;

	const page = {
		waitForSelector: async (selector: string) => {
			if (selector.includes('prev-button')) {
				return {
					click: async () => {
						navClicks += 1;
						current = addMonths(current, -1);
					},
				};
			}

			if (selector.includes('next-button')) {
				return {
					click: async () => {
						navClicks += 1;
						current = addMonths(current, 1);
					},
				};
			}

			return {};
		},
		$eval: async () => formatMonthLabel(current),
		waitForTimeout: async () => undefined,
	} as unknown as Page;

	return {
		page,
		getCurrent: () => current,
		getNavClicks: () => navClicks,
	};
};

describe('MONTH_NAMES', () => {
	it('has 12 entries', () => {
		expect(MONTH_NAMES).toHaveLength(12);
	});

	it('starts with january', () => {
		expect(MONTH_NAMES[0]).toBe('january');
	});

	it('ends with december', () => {
		expect(MONTH_NAMES[11]).toBe('december');
	});

	it('all lowercase', () => {
		for (const m of MONTH_NAMES) {
			expect(m).toBe(m.toLowerCase());
		}
	});

	it('indexOf works for month lookup', () => {
		expect(MONTH_NAMES.indexOf('march')).toBe(2);
		expect(MONTH_NAMES.indexOf('december')).toBe(11);
		expect(MONTH_NAMES.indexOf('invalid')).toBe(-1);
	});
});

describe('parseYearMonthKey', () => {
	it('parses a YYYY-MM key to zero-based calendar month', () => {
		expect(parseYearMonthKey('2026-07')).toEqual({ year: 2026, month: 6 });
	});

	it('rejects malformed or out-of-range month keys', () => {
		expect(parseYearMonthKey('2026-7')).toBeNull();
		expect(parseYearMonthKey('2026-00')).toBeNull();
		expect(parseYearMonthKey('2026-13')).toBeNull();
		expect(parseYearMonthKey('july-2026')).toBeNull();
	});
});

describe('navigateToMonth', () => {
	it('can reach a future month beyond the old 12-step cap', async () => {
		const calendar = makeCalendarPage({ year: 2026, month: 4 });

		await Effect.runPromise(navigateToMonth(calendar.page, 6, 2027, 'read-availability'));

		expect(calendar.getCurrent()).toEqual({ year: 2027, month: 6 });
		expect(calendar.getNavClicks()).toBe(14);
	});

	it('fails clearly when the target exceeds the navigation budget', async () => {
		const calendar = makeCalendarPage({ year: 2026, month: 4 });

		await expect(
			Effect.runPromise(navigateToMonth(calendar.page, 5, 2030, 'read-availability')),
		).rejects.toThrow(`Could not navigate to june 2030 within ${MAX_CALENDAR_NAVIGATION_STEPS} steps`);

		expect(calendar.getNavClicks()).toBe(MAX_CALENDAR_NAVIGATION_STEPS);
	});
});
