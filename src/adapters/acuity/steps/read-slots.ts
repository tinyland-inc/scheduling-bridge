/**
 * Wizard Step: Read Time Slots from Acuity Calendar
 *
 * Navigates to the service calendar via click-through,
 * advances to the target date, clicks the day tile,
 * and reads all available time slot buttons.
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

export interface ReadSlotsParams {
	/** Service name to match against the service list */
	readonly serviceName: string;
	/** Appointment type ID (used to verify correct service selected) */
	readonly appointmentTypeId?: string;
	/** Target date (YYYY-MM-DD) */
	readonly date: string;
}

export interface SlotResult {
	readonly datetime: string; // ISO 8601
	readonly available: boolean;
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Read time slots for a specific date by navigating the Acuity wizard.
 *
 * Flow:
 * 1. Load service page → find service → click "Book"
 * 2. Navigate calendar to target month
 * 3. Click target day tile
 * 4. Read all time slot buttons
 */
export const readTimeSlots = (params: ReadSlotsParams) =>
	Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'read-slots',
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

		// Step 3: Navigate to the target month
		const targetDate = new Date(params.date + 'T12:00:00');
		const targetMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
		yield* navigateToTargetMonth(page, targetMonth);

		// Step 4: Click the target day
		yield* clickDay(page, targetDate.getDate());

		// Step 5: Read time slots
		const slots = yield* readSlotButtons(page, params.date);

		return slots;
	});

// =============================================================================
// HELPERS
// =============================================================================

const clickServiceBook = (
	page: Page,
	serviceName: string,
	expectedId?: string,
) =>
	Effect.gen(function* () {
		yield* resolveSelector(page, Selectors.serviceList, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-slots',
						message: 'Service list did not load',
					}),
				),
			),
		);

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
					step: 'read-slots',
					message: `Error searching services: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!serviceItem) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'read-slots',
					message: `Service "${serviceName}" not found`,
				}),
			);
		}

		const bookBtn = yield* Effect.tryPromise({
			try: () => serviceItem.$(Selectors.serviceBookButton[0]),
			catch: (e) =>
				new WizardStepError({
					step: 'read-slots',
					message: `Book button error: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!bookBtn) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'read-slots',
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
					step: 'read-slots',
					message: `Failed to navigate to calendar: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (expectedId) {
			const url = page.url();
			const match = url.match(/\/appointment\/(\d+)/);
			if (match && match[1] !== expectedId) {
				return yield* Effect.fail(
					new WizardStepError({
						step: 'read-slots',
						message: `Expected appointment type ${expectedId} but got ${match[1]}`,
					}),
				);
			}
		}
	});

const navigateToTargetMonth = (page: Page, targetMonth: string): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		yield* resolveSelector(page, Selectors.calendar, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-slots',
						message: 'Calendar did not load',
					}),
				),
			),
		);

		// DateMatcher month targeting (design §6): parse the YYYY-MM key via the shared
		// `parseYearMonthKey` (one of the three former month-parser copies).
		const parsedTarget = parseYearMonthKey(targetMonth);
		const [yearStr, monthStr] = targetMonth.split('-');
		const targetYear = parsedTarget?.year ?? parseInt(yearStr, 10);
		const targetMonthIdx = parsedTarget?.month ?? parseInt(monthStr, 10) - 1;

		for (let i = 0; i < 12; i++) {
			const current = yield* getCalendarMonth(page);
			if (!current) {
				return yield* Effect.fail(
					new WizardStepError({
						step: 'read-slots',
						message: 'Could not determine calendar month',
					}),
				);
			}

			if (current.month === targetMonthIdx && current.year === targetYear) return;

			const currentFirst = new Date(current.year, current.month, 1);
			const targetFirst = new Date(targetYear, targetMonthIdx, 1);
			const direction = targetFirst > currentFirst ? 'next' : 'prev';
			const selectors = direction === 'prev' ? Selectors.calendarPrev : Selectors.calendarNext;

			const btn = yield* resolveSelector(page, selectors, 3000).pipe(
				Effect.catchTag('SelectorError', () =>
					Effect.fail(
						new WizardStepError({
							step: 'read-slots',
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
						step: 'read-slots',
						message: `Calendar nav failed: ${e instanceof Error ? e.message : String(e)}`,
						cause: e,
					}),
			});
		}
	});

const getCalendarMonth = (
	page: Page,
): Effect.Effect<{ month: number; year: number } | null, never> =>
	Effect.gen(function* () {
		// Wait for calendar month label to appear
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(Selectors.calendarMonth[0], { timeout: 5000 }),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		// Retry up to 3 times — React may still be rendering. The "March 2026" label
		// parsing is the shared DateMatcher `parseMonthLabel` (design §6; consolidates
		// the three former month-parser copies).
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

		return null;
	});

/**
 * Click the calendar tile for a specific day number.
 */
const clickDay = (page: Page, dayOfMonth: number): Effect.Effect<void, WizardStepError> =>
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
					const num = parseInt(text?.trim() ?? '', 10);
					if (num === dayOfMonth) {
						await tile.click();
						return true;
					}
				}
				return false;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'read-slots',
					message: `Error clicking day ${dayOfMonth}: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!clicked) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'read-slots',
					message: `Day ${dayOfMonth} not available on calendar`,
				}),
			);
		}

		// Wait for time slots to appear
		yield* resolveSelector(page, Selectors.timeSlotContainer, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'read-slots',
						message: 'Time slots did not appear after clicking day',
					}),
				),
			),
		);
	});

/**
 * Read all time slot buttons and return structured data.
 * Slot text format: "10:00 AM1 spot left" or "2:30 PM"
 */
const readSlotButtons = (
	page: Page,
	dateStr: string,
): Effect.Effect<SlotResult[], WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const results: SlotResult[] = [];
			const slots = await page.$$(Selectors.timeSlot[0]);

			for (const slot of slots) {
				const text = await slot.textContent();
				if (!text) continue;

				// Extract time from slot text: "10:00 AM1 spot left" → "10:00 AM"
				const timeMatch = text.trim().match(/^(\d{1,2}:\d{2}\s*[AP]M)/i);
				if (!timeMatch) continue;

				const timeStr = timeMatch[1].trim();

				// Convert to ISO 8601 datetime
				const datetime = buildIsoDatetime(dateStr, timeStr);
				results.push({ datetime, available: true });
			}

			return results;
		},
		catch: (e) =>
			new WizardStepError({
				step: 'read-slots',
				message: `Error reading slots: ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

/**
 * Build ISO datetime from date string and time string.
 * "2026-03-15" + "10:00 AM" → "2026-03-15T10:00:00"
 */
const buildIsoDatetime = (dateStr: string, timeStr: string): string => {
	const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
	if (!match) return `${dateStr}T00:00:00`;

	let hours = parseInt(match[1], 10);
	const minutes = match[2];
	const ampm = match[3].toUpperCase();

	if (ampm === 'PM' && hours !== 12) hours += 12;
	if (ampm === 'AM' && hours === 12) hours = 0;

	return `${dateStr}T${String(hours).padStart(2, '0')}:${minutes}:00`;
};
