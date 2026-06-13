/**
 * Wizard Step: Read Available Dates from Acuity Calendar
 *
 * Navigates to the service calendar via click-through (not query params)
 * and reads which calendar tiles are enabled (not disabled).
 *
 * Returns available dates for the currently visible month.
 * Callers should advance months if needed.
 */

import { Effect } from 'effect';
import type { Page, ElementHandle } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';
import { parseMonthLabel, parseYearMonthKey } from '../../../flow/date-matcher.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ReadAvailabilityParams {
	/** Service name to match against the service list */
	readonly serviceName: string;
	/** Appointment type ID (used to verify correct service selected) */
	readonly appointmentTypeId?: string;
	/** Target month (YYYY-MM) — navigates calendar if provided */
	readonly targetMonth?: string;
	/** How many months ahead to scan (default 2) */
	readonly monthsToScan?: number;
}

export interface AvailableDateResult {
	readonly date: string; // YYYY-MM-DD
	readonly slots: number; // estimated (1 = available, we don't know exact count without clicking)
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Read available dates by navigating through the Acuity wizard to the calendar.
 *
 * Flow:
 * 1. Load service page → find service → click "Book"
 * 2. Land on calendar page
 * 3. Read enabled (non-disabled) tiles for current month
 * 4. Optionally advance to next months and read more
 */
export const readAvailableDates = (params: ReadAvailabilityParams) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Failed to load service page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Step 1b: Bypass category view if present
		yield* Effect.tryPromise({
			try: async () => {
				const showAllBtn = await page.$('button:has-text("SHOW ALL APPOINTMENTS")');
				if (showAllBtn) {
					await showAllBtn.click();
					await page.waitForTimeout(1000);
				}
			},
			catch: () => undefined,
		});

		// Step 2: Click the target service's "Book" button
		yield* clickServiceBook(page, params.serviceName, params.appointmentTypeId);

		// Step 3: Read available dates from calendar
		const monthsToScan = params.monthsToScan ?? 2;
		const allDates: AvailableDateResult[] = [];

		// If a specific target month is requested, navigate to it first
		if (params.targetMonth) {
			yield* navigateToMonth(page, params.targetMonth);
		}

		for (let i = 0; i < monthsToScan; i++) {
			const dates = yield* readCalendarDates(page);
			allDates.push(...dates);

			// Advance to next month if more scanning needed
			if (i < monthsToScan - 1) {
				const advanced = yield* advanceMonth(page);
				if (!advanced) break; // No more months available
			}
		}

		return allDates;
	});

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Find a service by name and click its "Book" button.
 * Waits for calendar URL pattern after clicking.
 */
const clickServiceBook = (
	page: Page,
	serviceName: string,
	expectedId?: string,
) =>
	Effect.gen(function* () {
		// Wait for service list
		yield* resolveSelector(page, Selectors.serviceList, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-availability',
						message: 'Service list did not load',
					}),
				),
			),
		);

		// Find matching service
		const serviceItem: ElementHandle | null = yield* Effect.tryPromise({
			try: async () => {
				const items = await page.$$(Selectors.serviceList[0]);
				for (const item of items) {
					const nameEl = await item.$(Selectors.serviceName[0]);
					const name = await nameEl?.textContent();
					if (name && name.trim().toLowerCase().includes(serviceName.toLowerCase())) {
						return item;
					}
				}
				return null;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Error searching services: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!serviceItem) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'read-availability',
					message: `Service "${serviceName}" not found`,
				}),
			);
		}

		// Click "Book" button
		const bookBtn = yield* Effect.tryPromise({
			try: () => serviceItem.$(Selectors.serviceBookButton[0]),
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Book button error: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!bookBtn) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'read-availability',
					message: `"Book" button not found for "${serviceName}"`,
				}),
			);
		}

		yield* Effect.tryPromise({
			try: async () => {
				await bookBtn.click();
				await page.waitForURL(/\/appointment\/\d+\/calendar\/\d+/, { timeout: 10000 });
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Failed to navigate to calendar: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Verify appointment type ID if provided
		if (expectedId) {
			const url = page.url();
			const match = url.match(/\/appointment\/(\d+)/);
			if (match && match[1] !== expectedId) {
				return yield* Effect.fail(
					new WizardStepError({
						step: 'read-availability',
						message: `Expected appointment type ${expectedId} but got ${match[1]}`,
					}),
				);
			}
		}
	});

/**
 * Read all available (non-disabled) dates from the currently visible calendar month.
 */
const readCalendarDates = (page: Page): Effect.Effect<AvailableDateResult[], WizardStepError> =>
	Effect.gen(function* () {
		// Wait for calendar
		yield* resolveSelector(page, Selectors.calendar, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-availability',
						message: 'Calendar did not load',
					}),
				),
			),
		);

		// Get current month/year from calendar label
		const monthInfo = yield* getCalendarMonthInfo(page);

		// Read all non-disabled, non-neighboring-month tiles
		const dates = yield* Effect.tryPromise({
			try: async () => {
				const results: AvailableDateResult[] = [];
				const tiles = await page.$$(Selectors.calendarDay[0]);

				for (const tile of tiles) {
					const isDisabled = await tile.evaluate((el) => (el as HTMLButtonElement).disabled);
					if (isDisabled) continue;

					const classes = (await tile.getAttribute('class')) ?? '';
					if (classes.includes('neighboringMonth')) continue;

					const text = await tile.textContent();
					const dayNum = parseInt(text?.trim() ?? '', 10);
					if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

					// Build YYYY-MM-DD from month info + day
					const dateStr = `${monthInfo.year}-${String(monthInfo.month + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
					results.push({ date: dateStr, slots: 1 });
				}

				return results;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Error reading calendar tiles: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return dates;
	});

/**
 * Get the currently displayed month and year from the calendar label.
 * Retries up to 3 times with brief waits for React rendering. The "March 2026" label
 * parsing is the shared DateMatcher `parseMonthLabel` (design §6; consolidates the
 * three former month-parser copies).
 */
const getCalendarMonthInfo = (
	page: Page,
): Effect.Effect<{ month: number; year: number }, WizardStepError> =>
	Effect.gen(function* () {
		// Wait for calendar month label to appear
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(Selectors.calendarMonth[0], { timeout: 5000 }),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		// Retry up to 3 times — React may still be rendering
		for (let retry = 0; retry < 3; retry++) {
			const info = yield* Effect.tryPromise({
				try: async () => {
					for (const selector of Selectors.calendarMonth) {
						const text = await page.$eval(selector, (el) => el.textContent?.trim() ?? null).catch(() => null);
						if (text) {
							const parsed = parseMonthLabel(text);
							if (parsed) return parsed;
						}
					}
					// Also try innerText which resolves visibility better than textContent
					for (const selector of Selectors.calendarMonth) {
						const text = await page.$eval(selector, (el) => (el as HTMLElement).innerText?.trim() ?? null).catch(() => null);
						if (text) {
							const parsed = parseMonthLabel(text);
							if (parsed) return parsed;
						}
					}
					return null;
				},
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (info) return info;

			// Wait before retrying
			yield* Effect.tryPromise({
				try: () => page.waitForTimeout(1000),
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));
		}

		return yield* Effect.fail(
			new WizardStepError({
				step: 'read-availability',
				message: 'Could not determine calendar month after 3 retries',
			}),
		);
	});

/**
 * Navigate the calendar to a specific target month (YYYY-MM format).
 */
const navigateToMonth = (page: Page, targetMonth: string): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		// DateMatcher month targeting (design §6): parse the YYYY-MM key via the shared
		// `parseYearMonthKey`.
		const parsedTarget = parseYearMonthKey(targetMonth);
		const [yearStr, monthStr] = targetMonth.split('-');
		const targetYear = parsedTarget?.year ?? parseInt(yearStr, 10);
		const targetMonthIdx = parsedTarget?.month ?? parseInt(monthStr, 10) - 1;

		for (let i = 0; i < 12; i++) {
			const current = yield* getCalendarMonthInfo(page);
			if (current.month === targetMonthIdx && current.year === targetYear) return;

			const currentFirst = new Date(current.year, current.month, 1);
			const targetFirst = new Date(targetYear, targetMonthIdx, 1);
			const direction = targetFirst > currentFirst ? 'next' : 'prev';
			const selectors = direction === 'prev' ? Selectors.calendarPrev : Selectors.calendarNext;

			const btn = yield* resolveSelector(page, selectors, 3000).pipe(
				Effect.catchTag('SelectorError', () =>
					Effect.fail(
						new WizardStepError({
							step: 'read-availability',
							message: `Calendar ${direction} button not found`,
						}),
					),
				),
			);

			yield* Effect.tryPromise({
				try: async () => {
					await btn.element.click();
					await page.waitForTimeout(500);
				},
				catch: (e) =>
					new WizardStepError({
						step: 'read-availability',
						message: `Calendar nav failed: ${e instanceof Error ? e.message : String(e)}`,
						cause: e,
					}),
			});
		}
	});

/**
 * Advance to the next month. Returns false if next button is not available.
 */
const advanceMonth = (page: Page): Effect.Effect<boolean, WizardStepError> =>
	Effect.gen(function* () {
		const btn = yield* Effect.tryPromise({
			try: () => page.$(Selectors.calendarNext[0]),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		if (!btn) return false;

		const isDisabled = yield* Effect.tryPromise({
			try: () => btn.evaluate((el) => (el as HTMLButtonElement).disabled),
			catch: () => true,
		}).pipe(Effect.orElseSucceed(() => true));

		if (isDisabled) return false;

		yield* Effect.tryPromise({
			try: async () => {
				await btn.click();
				await page.waitForTimeout(500);
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-availability',
					message: `Failed to advance month: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return true;
	});
