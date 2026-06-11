/**
 * Wizard Steps: URL-Parameter-Based Availability Reading
 *
 * Navigate directly to a service's calendar via ?appointmentType={id}
 * query parameter, bypassing click-through category navigation
 * (which breaks with collapseCategories: true).
 *
 * These are the primary codepath for /availability/dates and
 * /availability/slots endpoints on the middleware server.
 */

import { Effect, Scope } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { ndjsonLog } from '../../../shared/logger.js';
import { observePageOpEffect } from '../../../shared/metrics.js';
import { WizardStepError } from '../errors.js';
import { Selectors } from '../selectors.js';
import { parseSlotText, buildIsoDatetime } from '../slot-parser.js';
import { navigateToMonth, parseYearMonthKey } from '../wizard-calendar.js';
import {
	buildSlotReadProfileEvent,
	createSlotReadProfile,
	getSlotReadProfileConfig,
	type SlotReadProfileContext,
	shouldLogSlotReadProfile,
} from './slot-read-profile.js';

// =============================================================================
// TYPES
// =============================================================================

export interface UrlDateResult {
	readonly date: string;  // YYYY-MM-DD
	readonly slots: number; // 1 = available (exact count unknown without clicking)
}

export interface UrlSlotResult {
	readonly datetime: string; // time string like "4:00 PM"
	readonly available: boolean;
}

export interface TimeSelectionEntry {
	readonly text: string;
	readonly ariaLabel: string;
	readonly disabled: boolean;
}

type AvailabilitySurface = 'calendar' | 'time-list';

const DEFAULT_URL_READ_NETWORK_IDLE_MS = 1500;
const DEFAULT_EMPTY_DATE_SETTLE_MS = 2500;
const DEFAULT_MORE_TIMES_CLICKS = 8;

const MONTH_INDEX_BY_NAME = new Map<string, number>(
	[
		['jan', 0],
		['january', 0],
		['feb', 1],
		['february', 1],
		['mar', 2],
		['march', 2],
		['apr', 3],
		['april', 3],
		['may', 4],
		['jun', 5],
		['june', 5],
		['jul', 6],
		['july', 6],
		['aug', 7],
		['august', 7],
		['sep', 8],
		['sept', 8],
		['september', 8],
		['oct', 9],
		['october', 9],
		['nov', 10],
		['november', 10],
		['dec', 11],
		['december', 11],
	] as const,
);

export const urlReadNetworkIdleTimeoutMs = (
	timeout: number,
	env: Record<string, string | undefined> = process.env,
): number => {
	const raw = env.ACUITY_URL_READ_NETWORK_IDLE_MS;
	const parsed = raw === undefined || raw === '' ? DEFAULT_URL_READ_NETWORK_IDLE_MS : Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return Math.min(timeout, DEFAULT_URL_READ_NETWORK_IDLE_MS);
	}
	return Math.min(timeout, Math.floor(parsed));
};

export const dateEmptySettleTimeoutMs = (
	timeout: number,
	env: Record<string, string | undefined> = process.env,
): number => {
	const raw = env.ACUITY_EMPTY_DATE_SETTLE_MS;
	const parsed = raw === undefined || raw === '' ? DEFAULT_EMPTY_DATE_SETTLE_MS : Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return Math.min(timeout, DEFAULT_EMPTY_DATE_SETTLE_MS);
	}
	return Math.min(timeout, Math.floor(parsed));
};

const navigateForUrlRead = async (page: Page, url: URL, timeout: number): Promise<void> => {
	// Acuity can leave background requests open long after the calendar DOM is
	// useful. Bound the network-idle wait so empty days do not become 30s 500s.
	await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout });
	const networkIdleTimeout = urlReadNetworkIdleTimeoutMs(timeout);
	if (networkIdleTimeout > 0) {
		await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }).catch(() => {});
	}
};

const postClickSlotSettleMs = (): number => {
	const raw = Number(process.env.ACUITY_POST_CLICK_SLOT_SETTLE_MS);
	return Number.isFinite(raw) && raw >= 0 ? raw : 900;
};

const waitForSlotUiAfterDateClick = async (
	page: Page,
	slotSelector: string,
	timeout: number,
): Promise<void> => {
	const waitMs = Math.min(timeout, postClickSlotSettleMs());
	if (waitMs <= 0) return;

	await Promise.race([
		page.waitForSelector(slotSelector, { timeout: waitMs }).then(() => undefined),
		page.waitForLoadState('networkidle', { timeout: waitMs }).then(() => undefined).catch(() => undefined),
		page.waitForTimeout(waitMs).then(() => undefined),
	]).catch(() => undefined);
};

const moreTimesClickLimit = (
	env: Record<string, string | undefined> = process.env,
): number => {
	const parsed = Number(env.ACUITY_MORE_TIMES_CLICK_LIMIT);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MORE_TIMES_CLICKS;
	return Math.floor(parsed);
};

const waitForMoreTimesSettle = async (page: Page, timeout: number): Promise<void> => {
	const waitMs = Math.min(timeout, postClickSlotSettleMs());
	if (waitMs <= 0) return;
	await page.waitForTimeout(waitMs).catch(() => undefined);
};

const inferYearForMonth = (
	monthIndex: number,
	targetMonth?: string,
	now = new Date(),
): number => {
	const parsedTarget = targetMonth?.match(/^(\d{4})-(\d{2})$/);
	if (parsedTarget) {
		const targetYear = Number(parsedTarget[1]);
		const targetMonthIndex = Number(parsedTarget[2]) - 1;
		const delta = monthIndex - targetMonthIndex;
		if (delta > 6) return targetYear - 1;
		if (delta < -6) return targetYear + 1;
		return targetYear;
	}

	const currentMonth = now.getMonth();
	const currentYear = now.getFullYear();
	return currentMonth - monthIndex > 6 ? currentYear + 1 : currentYear;
};

const parseTimeSelectionDate = (
	label: string,
	targetMonth?: string,
): string | null => {
	const match = label.match(
		/\b(?:Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)?\s*(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+([0-3]?\d)(?:,?\s+(\d{4}))?\b/i,
	);
	if (!match) return null;

	const monthIndex = MONTH_INDEX_BY_NAME.get(match[1].toLowerCase());
	if (monthIndex === undefined) return null;

	const day = Number(match[2]);
	if (!Number.isInteger(day) || day < 1 || day > 31) return null;

	const year = match[3] ? Number(match[3]) : inferYearForMonth(monthIndex, targetMonth);
	if (!Number.isInteger(year) || year < 2000) return null;

	return `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const parseTimeSelectionDates = (
	entries: readonly TimeSelectionEntry[],
	targetMonth?: string,
): UrlDateResult[] => {
	const seen = new Set<string>();
	const results: UrlDateResult[] = [];

	for (const entry of entries) {
		if (entry.disabled) continue;
		const date = parseTimeSelectionDate(entry.ariaLabel || entry.text, targetMonth);
		if (!date) continue;
		if (targetMonth && !date.startsWith(`${targetMonth}-`)) continue;
		if (seen.has(date)) continue;
		seen.add(date);
		results.push({ date, slots: 1 });
	}

	return results.sort((a, b) => a.date.localeCompare(b.date));
};

export const parseTimeSelectionSlots = (
	entries: readonly TimeSelectionEntry[],
	date: string,
): UrlSlotResult[] =>
	entries
		.filter((entry) => parseTimeSelectionDate(entry.ariaLabel || entry.text, date.slice(0, 7)) === date)
		.map((entry) => ({
			datetime: entry.text || entry.ariaLabel,
			available: !entry.disabled,
		}));

const collectTimeSelectionEntries = async (
	page: Page,
	selector: string,
): Promise<TimeSelectionEntry[]> =>
	page.evaluate((sel) => {
		return Array.from(document.querySelectorAll(sel)).map((node) => {
			const element = node as HTMLButtonElement;
			return {
				text: element.textContent?.trim() ?? '',
				ariaLabel: element.getAttribute('aria-label') ?? '',
				disabled:
					element.disabled ||
					element.hasAttribute('disabled') ||
					element.getAttribute('aria-disabled') === 'true',
			};
		});
	}, selector);

const clickMoreTimes = async (page: Page): Promise<boolean> =>
	page.evaluate(() => {
		const buttons = Array.from(document.querySelectorAll('button'));
		const button = buttons.find((candidate) => {
			const label = candidate.getAttribute('aria-label')?.trim().toLowerCase() ?? '';
			const text = candidate.textContent?.trim().toLowerCase() ?? '';
			return label === 'more times' || text === 'more times';
		}) as HTMLButtonElement | undefined;
		if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
			return false;
		}
		button.click();
		return true;
	});

const readDirectTimeSelectionDates = async (
	page: Page,
	selector: string,
	targetMonth: string | undefined,
	timeout: number,
): Promise<UrlDateResult[]> => {
	let entries = await collectTimeSelectionEntries(page, selector);
	let dates = parseTimeSelectionDates(entries, targetMonth);
	const clickLimit = targetMonth ? moreTimesClickLimit() : 0;

	for (let i = 0; dates.length === 0 && i < clickLimit; i += 1) {
		const clicked = await clickMoreTimes(page);
		if (!clicked) break;
		await waitForMoreTimesSettle(page, timeout);
		entries = await collectTimeSelectionEntries(page, selector);
		dates = parseTimeSelectionDates(entries, targetMonth);
	}

	return dates;
};

const readDirectTimeSelectionSlots = async (
	page: Page,
	selector: string,
	date: string,
	timeout: number,
): Promise<UrlSlotResult[]> => {
	let entries = await collectTimeSelectionEntries(page, selector);
	let slots = parseTimeSelectionSlots(entries, date);
	const clickLimit = moreTimesClickLimit();

	for (let i = 0; slots.length === 0 && i < clickLimit; i += 1) {
		const clicked = await clickMoreTimes(page);
		if (!clicked) break;
		await waitForMoreTimesSettle(page, timeout);
		entries = await collectTimeSelectionEntries(page, selector);
		slots = parseTimeSelectionSlots(entries, date);
	}

	return slots;
};

const navigateToServiceCalendar = (
	page: Page,
	url: URL,
	timeout: number,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: () => navigateForUrlRead(page, url, timeout),
		catch: (e) => new WizardStepError({ step, message: `Navigation failed: ${e}` }),
	});

const waitForAvailabilitySurface = (
	page: Page,
	timeout: number,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<AvailabilitySurface, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const waitMs = Math.min(timeout, 10_000);
			const calendarSelector = Selectors.calendar.join(', ');
			const timeListSelector = Selectors.timeSlot.join(', ');
			const surfaceSelector = `${calendarSelector}, ${timeListSelector}`;

			await page.waitForSelector(surfaceSelector, { timeout: waitMs });

			const calendar = await page.$(calendarSelector).catch(() => null);
			if (calendar) return 'calendar' as const;

			const timeList = await page.$(timeListSelector).catch(() => null);
			if (timeList) return 'time-list' as const;

			throw new Error('No known Acuity availability surface matched');
		},
		catch: () => new WizardStepError({
			step,
			message: 'Availability surface did not load within timeout',
		}),
	});

const navigateToTargetMonth = (
	page: Page,
	targetMonth: string | undefined,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<void, WizardStepError> => {
	if (!targetMonth) return Effect.void;

	const parsed = parseYearMonthKey(targetMonth);
	if (!parsed) {
		return Effect.fail(new WizardStepError({
			step,
			message: `Invalid target month: ${targetMonth}`,
		}));
	}

	return navigateToMonth(page, parsed.month, parsed.year, step);
};

const readEnabledCalendarDates = (
	page: Page,
	tileSelector: string,
): Effect.Effect<UrlDateResult[], WizardStepError> =>
	Effect.tryPromise({
		try: () => page.evaluate((sel) => {
			const results: Array<{ date: string; slots: number }> = [];
			const neighboringClass = 'react-calendar__tile--neighboringMonth';
			document.querySelectorAll(sel).forEach(tile => {
				if ((tile as HTMLButtonElement).disabled) return;
				if (tile.classList.contains(neighboringClass)) return;
				if (tile.classList.contains('neighboringMonth')) return;

				const abbr = tile.querySelector('abbr');
				const label = abbr?.getAttribute('aria-label') || tile.getAttribute('data-date') || '';
				if (label) {
					const d = new Date(label);
					if (!isNaN(d.getTime())) {
						results.push({ date: d.toISOString().slice(0, 10), slots: 1 });
					}
				}
			});
			return results;
		}, tileSelector),
		catch: (e) => new WizardStepError({ step: 'read-availability', message: `Calendar read failed: ${e}` }),
	});

const waitForEnabledCalendarDate = (
	page: Page,
	tileSelector: string,
	timeout: number,
): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: async () => {
			const waitMs = dateEmptySettleTimeoutMs(timeout);
			if (waitMs <= 0) return;

			await page.waitForFunction((sel) => {
				const neighboringClasses = [
					'react-calendar__tile--neighboringMonth',
					'neighboringMonth',
				];
				return Array.from(document.querySelectorAll(sel)).some(tile => {
					const button = tile as HTMLButtonElement;
					if (button.disabled || button.getAttribute('aria-disabled') === 'true') return false;
					if (neighboringClasses.some(className => tile.classList.contains(className))) return false;

					const abbr = tile.querySelector('abbr');
					const label = abbr?.getAttribute('aria-label') || tile.getAttribute('data-date') || '';
					if (!label) return false;

					return !Number.isNaN(new Date(label).getTime());
				});
			}, tileSelector, { timeout: waitMs }).catch(() => {});
		},
		catch: () => undefined,
	}).pipe(Effect.ignore);

// =============================================================================
// READ DATES VIA URL PARAM
// =============================================================================

/**
 * Read available dates by navigating directly to a service's calendar
 * via ?appointmentType={id} URL parameter.
 *
 * @param serviceId - Acuity numeric appointment type ID
 * @param targetMonth - Optional YYYY-MM to navigate to specific month
 */
export const readDatesViaUrl = (
	serviceId: string,
	targetMonth?: string,
): Effect.Effect<UrlDateResult[], WizardStepError, BrowserService | Scope.Scope> =>
	observePageOpEffect('availability_dates', Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-availability', message: `Browser error: ${e._tag}` })),
		);

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);

		yield* navigateToServiceCalendar(page, url, config.timeout, 'read-availability');
		const surface = yield* waitForAvailabilitySurface(
			page,
			config.timeout,
			'read-availability',
		);
		if (surface === 'calendar') {
			yield* navigateToTargetMonth(page, targetMonth, 'read-availability');
		} else if (targetMonth && !parseYearMonthKey(targetMonth)) {
			return yield* Effect.fail(new WizardStepError({
				step: 'read-availability',
				message: `Invalid target month: ${targetMonth}`,
			}));
		}

		// Wait for either the legacy react-calendar grid or the current direct
		// time-list view. Acuity may skip the grid when the service URL resolves
		// directly to upcoming times.
		const directTimeSelector = Selectors.timeSlot[0];

		const tileSelector = Selectors.calendarDay[0]; // .react-calendar__tile
		let dates = yield* readEnabledCalendarDates(page, tileSelector);
		if (dates.length > 0) {
			return dates;
		}

		dates = yield* Effect.tryPromise({
			try: () => readDirectTimeSelectionDates(page, directTimeSelector, targetMonth, config.timeout),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Direct time-list date read failed: ${e}` }),
		});
		if (dates.length > 0) {
			return dates;
		}

		// Acuity occasionally paints the calendar shell before enabled dates are attached.
		// Wait briefly for enabled tiles on the same page, but do not re-run a full
		// deep-month navigation when the target month is legitimately empty.
		yield* waitForEnabledCalendarDate(page, tileSelector, config.timeout);

		dates = yield* readEnabledCalendarDates(page, tileSelector);
		if (dates.length > 0) {
			return dates;
		}

		return yield* Effect.tryPromise({
			try: () => readDirectTimeSelectionDates(page, directTimeSelector, targetMonth, config.timeout),
			catch: (e) => new WizardStepError({ step: 'read-availability', message: `Direct time-list date read failed: ${e}` }),
		});
	}));

// =============================================================================
// READ SLOTS VIA URL PARAM
// =============================================================================

/**
 * Read time slots by navigating directly to a service's calendar
 * via ?appointmentType={id}&date={YYYY-MM-DD} URL parameters,
 * then clicking the target date tile.
 *
 * @param serviceId - Acuity numeric appointment type ID
 * @param date - Target date in YYYY-MM-DD format
 */
export const readSlotsViaUrl = (
	serviceId: string,
	date: string,
	context?: SlotReadProfileContext,
): Effect.Effect<UrlSlotResult[], WizardStepError, BrowserService | Scope.Scope> =>
	observePageOpEffect('availability_slots', Effect.gen(function* () {
		const { acquirePage, config } = yield* BrowserService;
		const profileConfig = getSlotReadProfileConfig();
		const page = yield* acquirePage.pipe(
			Effect.mapError((e) => new WizardStepError({ step: 'read-slots', message: `Browser error: ${e._tag}` })),
		);

		let navigationMs = 0;
		let calendarReadyMs = 0;
		let dateSelectMs = 0;
		let postClickSettleMs = 0;
		let slotWaitMs = 0;
		let slotDomReadMs = 0;
		let parseMs = 0;
		let calendarTileCount = 0;
		let matchedDateFound = false;

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		url.searchParams.set('date', date);
		const targetMonth = date.slice(0, 7);
		const slotSelector = Selectors.timeSlot[0]; // button.time-selection
		const fallbackSelector = Selectors.timeSlot.join(', ');

		const navigationStartedAt = Date.now();
		yield* navigateToServiceCalendar(page, url, config.timeout, 'read-slots');
		const surface = yield* waitForAvailabilitySurface(
			page,
			config.timeout,
			'read-slots',
		);
		if (surface === 'calendar') {
			yield* navigateToTargetMonth(page, targetMonth, 'read-slots');
		} else if (!parseYearMonthKey(targetMonth)) {
			return yield* Effect.fail(new WizardStepError({
				step: 'read-slots',
				message: `Invalid target month: ${targetMonth}`,
			}));
		}
		navigationMs = Date.now() - navigationStartedAt;

		// Click the target date on the calendar. Disabled dates are a valid
		// "no availability" result, not a scrape failure.
		const tileSelector = Selectors.calendarDay[0];
		let clickedTargetDate = false;
		if (surface === 'calendar') {
			clickedTargetDate = yield* Effect.tryPromise({
				try: async () => {
					const calendarReadyStartedAt = Date.now();
					await page.waitForSelector(tileSelector, { timeout: 10000 }).catch(() => {});
					calendarReadyMs = Date.now() - calendarReadyStartedAt;

					const dateSelectStartedAt = Date.now();
					const tiles = await page.$$(tileSelector);
					calendarTileCount = tiles.length;
					for (const tile of tiles) {
						const abbr = await tile.$('abbr');
						const label = await abbr?.getAttribute('aria-label');
						if (label) {
							const d = new Date(label);
							if (d.toISOString().slice(0, 10) === date) {
								matchedDateFound = true;
								const disabled = await tile.evaluate((el) => {
									const button = el as HTMLButtonElement;
									return (
										button.disabled ||
										button.getAttribute('aria-disabled') === 'true' ||
										button.classList.contains('react-calendar__tile--disabled')
									);
								});
								if (disabled) {
									dateSelectMs = Date.now() - dateSelectStartedAt;
									return false;
								}
								await tile.click({ timeout: Math.min(config.timeout, 5000) });
								dateSelectMs = Date.now() - dateSelectStartedAt;

								const settleStartedAt = Date.now();
								await waitForSlotUiAfterDateClick(page, fallbackSelector, config.timeout);
								postClickSettleMs = Date.now() - settleStartedAt;
								return true;
							}
						}
					}
					dateSelectMs = Date.now() - dateSelectStartedAt;
					return false;
				},
				catch: (e) => new WizardStepError({ step: 'read-slots', message: `Date click failed: ${e}` }),
			});
		}

		if (!clickedTargetDate) {
			const directSlotReadStartedAt = Date.now();
			const directSlots = yield* Effect.tryPromise({
				try: () => readDirectTimeSelectionSlots(page, fallbackSelector, date, config.timeout),
				catch: (e) => new WizardStepError({ step: 'read-slots', message: `Direct time-list slots read failed: ${e}` }),
			});
			slotDomReadMs = Date.now() - directSlotReadStartedAt;
			if (directSlots.length > 0) {
				const parseStartedAt = Date.now();
				let parsedSlotCount = 0;
				const parsedSlots = directSlots.map(s => {
					const parsed = parseSlotText(s.datetime);
					if (parsed) parsedSlotCount += 1;
					return {
						datetime: parsed ? buildIsoDatetime(date, parsed.time) : s.datetime,
						available: s.available,
					};
				});
				parseMs = Date.now() - parseStartedAt;
				const profile = createSlotReadProfile({
					serviceId,
					date,
					thresholdMs: profileConfig.thresholdMs,
					calendarTileCount,
					matchedDateFound: true,
					slotCount: directSlots.length,
					parsedSlotCount,
					phases: {
						navigationMs,
						calendarReadyMs,
						dateSelectMs,
						postClickSettleMs,
						slotWaitMs,
						slotDomReadMs,
						parseMs,
					},
					context,
				});

				if (shouldLogSlotReadProfile(profile, profileConfig)) {
					ndjsonLog('INFO', 'Slot read profile', { ...buildSlotReadProfileEvent(profile) });
				}

				return parsedSlots;
			}

			const profile = createSlotReadProfile({
				serviceId,
				date,
				thresholdMs: profileConfig.thresholdMs,
				calendarTileCount,
				matchedDateFound,
				slotCount: 0,
				parsedSlotCount: 0,
				phases: {
					navigationMs,
					calendarReadyMs,
					dateSelectMs,
					postClickSettleMs,
					slotWaitMs,
					slotDomReadMs,
					parseMs,
				},
				context,
			});

			if (shouldLogSlotReadProfile(profile, profileConfig)) {
				ndjsonLog('INFO', 'Slot read profile', { ...buildSlotReadProfileEvent(profile) });
			}

			return [];
		}

			// Read time slots using the Selectors registry
			const slotWaitStartedAt = Date.now();
		yield* Effect.tryPromise({
			try: () => page.waitForSelector(fallbackSelector, { timeout: 10000 }),
			catch: () => null,
		}).pipe(Effect.ignore);
		slotWaitMs = Date.now() - slotWaitStartedAt;

		const slotDomReadStartedAt = Date.now();
		const slots = yield* Effect.tryPromise({
			try: () => page.evaluate((sel) => {
				const results: Array<{ datetime: string; available: boolean }> = [];
				document.querySelectorAll(sel).forEach(btn => {
					const raw = btn.textContent?.trim() || '';
					const disabled = btn.hasAttribute('disabled');
					if (raw) {
						results.push({ datetime: raw, available: !disabled });
					}
				});
				return results;
			}, slotSelector),
			catch: (e) => new WizardStepError({ step: 'read-slots', message: `Slots read failed: ${e}` }),
		});
		slotDomReadMs = Date.now() - slotDomReadStartedAt;

		// Parse slot text and build full ISO datetime (e.g., "4:00 PM" → "2026-04-01T16:00:00")
		const parseStartedAt = Date.now();
		let parsedSlotCount = 0;
		const parsedSlots = slots.map(s => {
			const parsed = parseSlotText(s.datetime);
			if (parsed) parsedSlotCount += 1;
			return {
				datetime: parsed ? buildIsoDatetime(date, parsed.time) : s.datetime,
				available: s.available,
			};
		});
		parseMs = Date.now() - parseStartedAt;
		const profile = createSlotReadProfile({
			serviceId,
			date,
			thresholdMs: profileConfig.thresholdMs,
			calendarTileCount,
			matchedDateFound,
			slotCount: slots.length,
			parsedSlotCount,
			phases: {
				navigationMs,
				calendarReadyMs,
				dateSelectMs,
				postClickSettleMs,
				slotWaitMs,
				slotDomReadMs,
				parseMs,
			},
			context,
		});

		if (shouldLogSlotReadProfile(profile, profileConfig)) {
			ndjsonLog('INFO', 'Slot read profile', { ...buildSlotReadProfileEvent(profile) });
		}

		return parsedSlots;
	}));
