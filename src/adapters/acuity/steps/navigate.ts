/**
 * Wizard Step: Navigate Through Acuity Booking Wizard
 *
 * Acuity's React SPA (2026) does NOT support deep-linking via query params.
 * Instead, we click through the 5-step wizard:
 *   1. Service page (<tenant>.as.me) → find service → click "Book"
 *   2. Calendar page → navigate to target month → click target day
 *   3. Time slots → click matching slot → "Select and continue"
 *   4. Land on client form (fields empty — filling is a separate step)
 *
 * URL progression:
 *   /schedule/<hash>
 *   /schedule/<hash>/appointment/<aptId>/calendar/<calId>
 *   /schedule/<hash>/appointment/<aptId>/calendar/<calId>/datetime/<ISO>
 */

import { Effect } from 'effect';
import type { Page, ElementHandle } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { observePageOpEffect } from '../../../shared/metrics.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, probe, Selectors } from '../selectors.js';
import type { ClientInfo } from '../../../core/types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface NavigateParams {
	/** Appointment type name (matched against .appointment-type-name text) */
	readonly serviceName: string;
	/** Target datetime in ISO 8601 (e.g. "2026-03-15T10:00:00-05:00") */
	readonly datetime: string;
	/** Client info (not used for navigation — kept for API compat) */
	readonly client: ClientInfo;
	/** Appointment type ID — if known, verified against URL after "Book" click */
	readonly appointmentTypeId?: string;
}

export interface NavigateResult {
	readonly url: string;
	readonly landingStep: 'client-form' | 'service-selection' | 'calendar' | 'time-slots' | 'unknown';
	readonly appointmentTypeId: string | null;
	readonly calendarId: string | null;
	readonly selectedDate: string;
	readonly selectedTime: string;
}

export const normalizeServiceNameForMatch = (name: string): string =>
	name.trim().replace(/\s+/g, ' ').toLowerCase();

export const serviceNameMatches = (candidateName: string, requestedName: string): boolean => {
	const candidate = normalizeServiceNameForMatch(candidateName);
	const requested = normalizeServiceNameForMatch(requestedName);
	return candidate.length > 0 && requested.length > 0 && candidate.includes(requested);
};

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Navigate through the Acuity wizard to reach the client form.
 *
 * Flow: Service page → Book → Calendar → Time slot → Select and continue
 */
export const navigateToBooking = (params: NavigateParams) =>
	observePageOpEffect('wizard_navigate', Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		// Step 1: Load service selection page
		yield* Effect.tryPromise({
			try: () => page.goto(config.baseUrl, { waitUntil: 'networkidle', timeout: config.timeout }),
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Failed to load service page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Step 1b: Bypass category view if present
		// Acuity may show "Select Appointment Category" first. Click "SHOW ALL APPOINTMENTS"
		// to expand all services, then proceed with normal service selection.
		yield* Effect.tryPromise({
			try: async () => {
				const showAllBtn = await page.$('button:has-text("SHOW ALL APPOINTMENTS")');
				if (showAllBtn) {
					await showAllBtn.click();
					await page.waitForTimeout(1000);
				}
			},
			catch: () => undefined, // Ignore — page may not have categories
		});

		// Step 2: Find and click target service's "Book" button
		const { appointmentTypeId, calendarId } = yield* selectService(
			page,
			params.serviceName,
			params.appointmentTypeId,
		);

		// Step 3: Navigate calendar to target date and click
		const targetDate = parseDate(params.datetime);
		yield* navigateCalendar(page, targetDate);
		yield* selectDay(page, targetDate);

		// Step 4: Select matching time slot
		const targetTime = parseTime(params.datetime);
		yield* selectTimeSlot(page, targetTime);

		// Step 5: Click "Select and continue" → land on client form
		yield* clickSelectAndContinue(page);

		// Verify we landed on the client form
		const landingStep = yield* detectLandingStep(page);

		return {
			url: page.url(),
			landingStep,
			appointmentTypeId,
			calendarId,
			selectedDate: targetDate.toISOString().split('T')[0],
			selectedTime: targetTime,
		} satisfies NavigateResult;
	}));

// =============================================================================
// STEP 2: SERVICE SELECTION
// =============================================================================

/**
 * Find the service by name and click its "Book" button.
 * After clicking, waits for URL to include /appointment/<id>/calendar/<id>.
 */
const selectService = (
	page: Page,
	serviceName: string,
	expectedAppointmentTypeId?: string,
) =>
	Effect.gen(function* () {
		// Wait for service list to load
		yield* resolveSelector(page, Selectors.serviceList, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: 'Service list did not load within timeout',
					}),
				),
			),
		);

		// Find the service item matching our target name
		const serviceItem: ElementHandle | null = yield* Effect.tryPromise({
			try: async () => {
				const items = await page.$$(Selectors.serviceList[0]);
				for (const item of items) {
					const nameEl = await item.$(Selectors.serviceName[0]);
					const name = await nameEl?.textContent();
					if (name && serviceNameMatches(name, serviceName)) {
						return item;
					}
				}
				return null;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Error searching services: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!serviceItem) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `Service "${serviceName}" not found on the page`,
				}),
			);
		}

		// Click the "Book" button within this service item
		const bookBtn = yield* Effect.tryPromise({
			try: () => serviceItem.$(Selectors.serviceBookButton[0]),
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Error finding Book button: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!bookBtn) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `"Book" button not found for service "${serviceName}"`,
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
					step: 'navigate',
					message: `Failed to navigate after clicking Book: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		// Extract IDs from URL: /appointment/<aptId>/calendar/<calId>
		const url = page.url();
		const appointmentMatch = url.match(/\/appointment\/(\d+)/);
		const calendarMatch = url.match(/\/calendar\/(\d+)/);
		const appointmentTypeId = appointmentMatch?.[1] ?? null;
		const calendarId = calendarMatch?.[1] ?? null;

		// Verify appointment type ID if caller provided an expected value
		if (expectedAppointmentTypeId && appointmentTypeId !== expectedAppointmentTypeId) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `Expected appointment type ${expectedAppointmentTypeId} but got ${appointmentTypeId}`,
				}),
			);
		}

		return { appointmentTypeId, calendarId };
	});

// =============================================================================
// STEP 3: CALENDAR NAVIGATION
// =============================================================================

/**
 * Navigate the react-calendar to the target month using prev/next buttons.
 * Stops after 12 iterations to prevent infinite loops.
 */
const navigateCalendar = (page: Page, targetDate: Date) =>
	Effect.gen(function* () {
		// Wait for calendar to load
		yield* resolveSelector(page, Selectors.calendar, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: 'Calendar did not load within timeout',
					}),
				),
			),
		);

		// Wait for the month label to render (may lag behind calendar container)
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(Selectors.calendarMonth[0], { timeout: 5000 }),
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		const targetMonth = targetDate.getMonth();
		const targetYear = targetDate.getFullYear();

		for (let i = 0; i < 12; i++) {
			// Retry month detection up to 3 times with brief waits
			let current: { month: number; year: number } | null = null;
			for (let retry = 0; retry < 3; retry++) {
				current = yield* getCurrentCalendarMonth(page);
				if (current) break;
				yield* Effect.tryPromise({
					try: () => page.waitForTimeout(500),
					catch: () => null,
				}).pipe(Effect.orElseSucceed(() => null));
			}

			if (!current) {
				return yield* Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: 'Could not determine current calendar month after retries',
					}),
				);
			}

			if (current.month === targetMonth && current.year === targetYear) {
				return; // Already on the correct month
			}

			// Determine navigation direction
			const currentFirst = new Date(current.year, current.month, 1);
			const targetFirst = new Date(targetYear, targetMonth, 1);

			if (targetFirst > currentFirst) {
				yield* clickCalendarNav(page, 'next');
			} else {
				yield* clickCalendarNav(page, 'prev');
			}

			// Wait for calendar to re-render
			yield* Effect.tryPromise({
				try: () => page.waitForTimeout(500),
				catch: () =>
					new WizardStepError({ step: 'navigate', message: 'Calendar nav wait interrupted' }),
			});
		}
	});

const MONTH_NAMES = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
];

const getCurrentCalendarMonth = (
	page: Page,
): Effect.Effect<{ month: number; year: number } | null, never> =>
	Effect.tryPromise({
		try: async () => {
			for (const selector of Selectors.calendarMonth) {
				const text = await page
					.$eval(selector, (el) => el.textContent?.trim() ?? null)
					.catch(() => null);
				if (text) {
					// react-calendar label may contain nested spans — extract visible text
					// Patterns: "March 2026", "March\n2026", "March 2026 "
					const match = text.match(/([A-Za-z]+)\s+(\d{4})/);
					if (match) {
						const monthIndex = MONTH_NAMES.indexOf(match[1].toLowerCase());
						if (monthIndex >= 0) {
							return { month: monthIndex, year: parseInt(match[2], 10) };
						}
					}
				}
			}
			return null;
		},
		catch: () => null,
	}).pipe(Effect.orElseSucceed(() => null));

const clickCalendarNav = (
	page: Page,
	direction: 'prev' | 'next',
): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		const selectors = direction === 'prev' ? Selectors.calendarPrev : Selectors.calendarNext;
		const btn = yield* resolveSelector(page, selectors, 3000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: `Calendar ${direction} button not found`,
					}),
				),
			),
		);
		yield* Effect.tryPromise({
			try: () => btn.element.click(),
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Failed to click calendar ${direction}: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});
	});

// =============================================================================
// STEP 3B: DAY SELECTION
// =============================================================================

/**
 * Click the calendar tile matching our target day number.
 * Skips disabled tiles and neighboring-month tiles.
 */
const selectDay = (page: Page, targetDate: Date) =>
	Effect.gen(function* () {
		const dayOfMonth = targetDate.getDate();

		const clicked = yield* Effect.tryPromise({
			try: async () => {
				const tiles = await page.$$(Selectors.calendarDay[0]);
				for (const tile of tiles) {
					const isDisabled = await tile.evaluate((el) => (el as HTMLButtonElement).disabled);
					if (isDisabled) continue;

					// Skip neighboring-month tiles (e.g. Feb 28 showing in March view)
					const classes = await tile.getAttribute('class') ?? '';
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
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Error selecting day ${dayOfMonth}: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!clicked) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `Day ${dayOfMonth} not available on calendar`,
				}),
			);
		}

		// Wait for time slots to appear
		yield* resolveSelector(page, Selectors.timeSlotContainer, 10000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: 'Time slots did not appear after selecting day',
					}),
				),
			),
		);
	});

// =============================================================================
// STEP 4: TIME SLOT SELECTION
// =============================================================================

/**
 * Click the time slot matching our target time.
 * Slot text contains time + availability info: "10:00 AM1 spot left"
 */
const selectTimeSlot = (page: Page, targetTime: string) =>
	Effect.gen(function* () {
		const clicked = yield* Effect.tryPromise({
			try: async () => {
				const slots = await page.$$(Selectors.timeSlot[0]);
				for (const slot of slots) {
					const text = await slot.textContent();
					if (text && text.includes(targetTime)) {
						await slot.click();
						return true;
					}
				}
				return false;
			},
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Error selecting time slot: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		if (!clicked) {
			return yield* Effect.fail(
				new WizardStepError({
					step: 'navigate',
					message: `Time slot "${targetTime}" not available`,
				}),
			);
		}

		// Wait for the selection menu to appear
		yield* Effect.tryPromise({
			try: () => page.waitForTimeout(1000),
			catch: () =>
				new WizardStepError({ step: 'navigate', message: 'Timeout after time slot click' }),
		});
	});

// =============================================================================
// STEP 5: "SELECT AND CONTINUE"
// =============================================================================

/**
 * Click the "Select and continue" menu item.
 * This is an <li role="menuitem">, NOT a button.
 * After clicking, waits for URL to include /datetime/.
 */
const clickSelectAndContinue = (page: Page): Effect.Effect<void, WizardStepError> =>
	Effect.gen(function* () {
		const menuItem = yield* resolveSelector(page, Selectors.selectAndContinue, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'navigate',
						message: '"Select and continue" option not found after selecting time slot',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await menuItem.element.click();
				// Wait for navigation to client form page
				await page.waitForURL(/\/datetime\//, { timeout: 10000 });
			},
			catch: (e) =>
				new WizardStepError({
					step: 'navigate',
					message: `Failed to advance to client form: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});
	});

// =============================================================================
// HELPERS
// =============================================================================

const detectLandingStep = (page: Page) =>
	Effect.gen(function* () {
		const hasClientForm = yield* probe(page, 'firstNameInput');
		if (hasClientForm) return 'client-form' as const;

		const hasTimeSlots = yield* probe(page, 'timeSlot');
		if (hasTimeSlots) return 'time-slots' as const;

		const hasCalendar = yield* probe(page, 'calendarDay');
		if (hasCalendar) return 'calendar' as const;

		const hasServiceList = yield* probe(page, 'serviceList');
		if (hasServiceList) return 'service-selection' as const;

		return 'unknown' as const;
	});

/**
 * Parse a Date from ISO 8601 datetime string.
 */
const parseDate = (datetime: string): Date => {
	const d = new Date(datetime);
	if (isNaN(d.getTime())) {
		throw new Error(`Invalid datetime: ${datetime}`);
	}
	return d;
};

/**
 * Extract formatted time from ISO 8601 for matching against slot text.
 * Returns "10:00 AM" format to match Acuity's "10:00 AM1 spot left" text.
 */
const parseTime = (datetime: string): string => {
	const d = new Date(datetime);
	const hours = d.getHours();
	const minutes = d.getMinutes();
	const ampm = hours >= 12 ? 'PM' : 'AM';
	const h = hours % 12 || 12;
	const m = minutes.toString().padStart(2, '0');
	return `${h}:${m} ${ampm}`;
};
