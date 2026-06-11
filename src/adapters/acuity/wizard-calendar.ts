/**
 * Wizard Calendar Operations (shared)
 *
 * Consolidated calendar month parsing, navigation, and day selection
 * previously duplicated across navigate.ts, read-availability.ts, read-slots.ts.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { WizardStepError } from './errors.js';
import { resolveSelector, Selectors } from './selectors.js';

// =============================================================================
// MONTH NAMES
// =============================================================================

export const MONTH_NAMES: readonly string[] = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
];

export interface CalendarMonth {
	readonly month: number;
	readonly year: number;
}

export const MAX_CALENDAR_NAVIGATION_STEPS = 36;

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

// =============================================================================
// CALENDAR MONTH PARSING
// =============================================================================

/**
 * Parse the current calendar month label (e.g. "March 2026").
 *
 * Retries up to 3 times with 1s wait between each attempt.
 * Tries textContent first, then innerText as fallback.
 * Returns null if the month cannot be determined after retries.
 */
export const getCurrentCalendarMonth = (
	page: Page,
): Effect.Effect<CalendarMonth | null, never> =>
	Effect.gen(function* () {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (attempt > 0) {
				yield* Effect.tryPromise({
					try: () => page.waitForSelector(Selectors.calendarMonth[0], { timeout: 3000 }),
					catch: () => null,
				}).pipe(Effect.ignore);

				yield* Effect.tryPromise({
					try: () => page.waitForTimeout(1000),
					catch: () => null,
				}).pipe(Effect.ignore);
			}

			// Try textContent first
			for (const sel of Selectors.calendarMonth) {
				const text: string | null = yield* Effect.tryPromise({
					try: () => page.$eval(sel, (el) => el.textContent),
					catch: () => null,
				}).pipe(Effect.orElseSucceed(() => null));

				if (text) {
					const result = parseMonthLabel(text);
					if (result) return result;
				}
			}

			// Fallback: try innerText
			for (const sel of Selectors.calendarMonth) {
				const text: string | null = yield* Effect.tryPromise({
					try: () => page.$eval(sel, (el) => (el as HTMLElement).innerText),
					catch: () => null,
				}).pipe(Effect.orElseSucceed(() => null));

				if (text) {
					const result = parseMonthLabel(text);
					if (result) return result;
				}
			}
		}

		return null;
	});

/**
 * Parse a month label string like "March 2026" or "March\n2026".
 */
const parseMonthLabel = (text: string): { month: number; year: number } | null => {
	const match = text.trim().match(/([A-Za-z]+)\s*(\d{4})/);
	if (!match) return null;

	const monthIdx = MONTH_NAMES.indexOf(match[1].toLowerCase());
	if (monthIdx === -1) return null;

	return { month: monthIdx, year: parseInt(match[2], 10) };
};

// =============================================================================
// CALENDAR NAVIGATION
// =============================================================================

/**
 * Click the prev or next calendar navigation button.
 */
export const clickCalendarNav = (
	page: Page,
	direction: 'prev' | 'next',
	step: string,
): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		const selectors = direction === 'prev' ? Selectors.calendarPrev : Selectors.calendarNext;

		const { element } = yield* resolveSelector(page, selectors, 3000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(new WizardStepError({
					step: step as WizardStepError['step'],
					message: `Calendar ${direction} button not found`,
				})),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await element.click();
				await page.waitForTimeout(500);
			},
			catch: (e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Failed to click calendar ${direction}: ${e}`,
			}),
		});
	});

/**
 * Navigate the calendar to a target month/year.
 * Clicks prev/next up to MAX_CALENDAR_NAVIGATION_STEPS times to reach the target.
 */
export const navigateToMonth = (
	page: Page,
	targetMonth: number,
	targetYear: number,
	step: string,
): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		// Ensure calendar is loaded
		yield* resolveSelector(page, Selectors.calendar, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(new WizardStepError({
					step: step as WizardStepError['step'],
					message: 'Calendar did not load within timeout',
				})),
			),
		);

		for (let i = 0; i <= MAX_CALENDAR_NAVIGATION_STEPS; i++) {
			const current = yield* getCurrentCalendarMonth(page);
			if (!current) {
				return yield* Effect.fail(new WizardStepError({
					step: step as WizardStepError['step'],
					message: 'Could not determine current calendar month',
				}));
			}

			if (current.month === targetMonth && current.year === targetYear) return;

			if (i === MAX_CALENDAR_NAVIGATION_STEPS) break;

			const currentFirst = new Date(current.year, current.month, 1);
			const targetFirst = new Date(targetYear, targetMonth, 1);
			const direction = targetFirst > currentFirst ? 'next' : 'prev';

			yield* clickCalendarNav(page, direction, step);
		}

		// If we exhausted the navigation budget, fail.
		return yield* Effect.fail(new WizardStepError({
			step: step as WizardStepError['step'],
			message: `Could not navigate to ${MONTH_NAMES[targetMonth]} ${targetYear} within ${MAX_CALENDAR_NAVIGATION_STEPS} steps`,
		}));
	});

// =============================================================================
// DAY SELECTION
// =============================================================================

/**
 * Click a specific day tile on the calendar.
 * Skips disabled tiles and neighboring-month tiles.
 * Waits for time slot container to appear after clicking.
 */
export const selectDay = (
	page: Page,
	dayOfMonth: number,
	step: string,
): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		const clicked = yield* Effect.tryPromise({
			try: async () => {
				const tiles = await page.$$(Selectors.calendarDay[0]);
				for (const tile of tiles) {
					const isDisabled = await tile.evaluate((el) => (el as HTMLButtonElement).disabled);
					if (isDisabled) continue;

					const classes = (await tile.getAttribute('class')) ?? '';
					if (classes.includes('neighboringMonth')) continue;

					const text = await tile.textContent();
					const dayNum = parseInt(text?.trim() ?? '', 10);
					if (dayNum === dayOfMonth) {
						await tile.click();
						return true;
					}
				}
				return false;
			},
			catch: (e) => new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Error selecting day ${dayOfMonth}: ${e}`,
			}),
		});

		if (!clicked) {
			return yield* Effect.fail(new WizardStepError({
				step: step as WizardStepError['step'],
				message: `Day ${dayOfMonth} not available on calendar`,
			}));
		}

		// Wait for time slots to appear
		yield* resolveSelector(page, Selectors.timeSlotContainer, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(new WizardStepError({
					step: step as WizardStepError['step'],
					message: 'Time slots did not appear after selecting day',
				})),
			),
		);
	});
