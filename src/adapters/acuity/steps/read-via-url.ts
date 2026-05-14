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
	readonly slots: number;
}

export interface UrlSlotResult {
	readonly datetime: string; // local ISO datetime without offset
	readonly available: boolean;
}

interface PylonCalendarIdentity {
	readonly origin: string;
	readonly owner: string;
	readonly appointmentTypeId: string;
	readonly calendarId: string;
}

interface PylonAvailabilitySlot {
	readonly time?: string;
	readonly slotsAvailable?: number;
}

type PylonAvailabilityTimes = Record<string, readonly PylonAvailabilitySlot[]>;

const DEFAULT_URL_READ_NETWORK_IDLE_MS = 1500;
const DEFAULT_EMPTY_DATE_SETTLE_MS = 2500;

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

export const parsePylonCalendarIdentity = (
	rawUrl: string,
): PylonCalendarIdentity | null => {
	try {
		const url = new URL(rawUrl);
		const match = url.pathname.match(
			/\/schedule\/([^/]+)(?:\/category\/[^/]+)?\/appointment\/(\d+)\/calendar\/(\d+)/,
		);
		if (!match) return null;
		return {
			origin: url.origin,
			owner: decodeURIComponent(match[1]),
			appointmentTypeId: match[2],
			calendarId: match[3],
		};
	} catch {
		return null;
	}
};

export const resolvePylonStartDate = (
	targetMonth?: string,
	today = new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/New_York',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date()),
): string => {
	if (!targetMonth || !/^\d{4}-\d{2}$/.test(targetMonth)) {
		return today;
	}
	const monthStart = `${targetMonth}-01`;
	return monthStart < today ? today : monthStart;
};

const normalizeAcuityDatetime = (value: string): string =>
	value.replace(/([+-]\d{2}:?\d{2}|Z)$/u, '');

export const toPylonAvailabilityDates = (
	payload: PylonAvailabilityTimes,
): UrlDateResult[] =>
	Object.entries(payload)
		.filter(([date, slots]) => (
			/^\d{4}-\d{2}-\d{2}$/.test(date) &&
			Array.isArray(slots) &&
			slots.some((slot) => Number(slot.slotsAvailable ?? 1) > 0)
		))
		.map(([date, slots]) => ({
			date,
			slots: slots.reduce(
				(total, slot) => total + Math.max(0, Number(slot.slotsAvailable ?? 1)),
				0,
			),
		}))
		.sort((a, b) => a.date.localeCompare(b.date));

export const toPylonAvailabilitySlots = (
	payload: PylonAvailabilityTimes,
	date: string,
): UrlSlotResult[] =>
	(payload[date] ?? [])
		.filter((slot) => typeof slot.time === 'string' && slot.time.length > 0)
		.map((slot) => ({
			datetime: normalizeAcuityDatetime(slot.time!),
			available: Number(slot.slotsAvailable ?? 1) > 0,
		}));

const fetchPylonAvailabilityTimes = (
	page: Page,
	serviceId: string,
	startDate: string,
	maxDays: number,
	step: 'read-availability' | 'read-slots',
): Effect.Effect<PylonAvailabilityTimes, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const identity = parsePylonCalendarIdentity(page.url());
			if (!identity) {
				throw new Error(`Could not parse Acuity calendar identity from ${page.url()}`);
			}
			if (identity.appointmentTypeId !== serviceId) {
				throw new Error(
					`Expected appointment type ${serviceId} but got ${identity.appointmentTypeId}`,
				);
			}

			const apiUrl = new URL('/api/scheduling/v1/availability/times', identity.origin);
			apiUrl.searchParams.set('owner', identity.owner);
			apiUrl.searchParams.set('appointmentTypeId', serviceId);
			apiUrl.searchParams.set('calendarId', identity.calendarId);
			apiUrl.searchParams.set('startDate', startDate);
			apiUrl.searchParams.set('maxDays', String(maxDays));
			apiUrl.searchParams.set('timezone', 'America/New_York');

			return page.evaluate(async (url) => {
				const response = await fetch(url, {
					headers: { accept: 'application/json' },
				});
				if (!response.ok) {
					throw new Error(`Acuity availability API returned ${response.status}`);
				}
				return await response.json() as PylonAvailabilityTimes;
			}, apiUrl.toString());
		},
		catch: (e) =>
			new WizardStepError({
				step,
				message: `Acuity availability API read failed: ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

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
		const startDate = resolvePylonStartDate(targetMonth);
		const payload = yield* fetchPylonAvailabilityTimes(
			page,
			serviceId,
			startDate,
			45,
			'read-availability',
		);

		const dates = toPylonAvailabilityDates(payload);
		return targetMonth
			? dates.filter((date) => date.date.startsWith(`${targetMonth}-`))
			: dates;
	}));

// =============================================================================
// READ SLOTS VIA URL PARAM
// =============================================================================

/**
 * Read time slots by navigating directly to a service's calendar
 * via ?appointmentType={id}&date={YYYY-MM-DD} URL parameters,
 * then reading Acuity's pylon availability API from that browser session.
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
		const calendarReadyMs = 0;
		const dateSelectMs = 0;
		const postClickSettleMs = 0;
		const slotWaitMs = 0;
		let slotDomReadMs = 0;
		const parseMs = 0;
		let calendarTileCount = 0;
		let matchedDateFound = false;

		const url = new URL(config.baseUrl);
		url.searchParams.set('appointmentType', serviceId);
		url.searchParams.set('date', date);

		const navigationStartedAt = Date.now();
		yield* navigateToServiceCalendar(page, url, config.timeout, 'read-slots');
		navigationMs = Date.now() - navigationStartedAt;

		const slotDomReadStartedAt = Date.now();
		const payload = yield* fetchPylonAvailabilityTimes(
			page,
			serviceId,
			date,
			1,
			'read-slots',
		);
		const parsedSlots = toPylonAvailabilitySlots(payload, date);
		slotDomReadMs = Date.now() - slotDomReadStartedAt;
		calendarTileCount = Object.keys(payload).length;
		matchedDateFound = Object.prototype.hasOwnProperty.call(payload, date);

		const profile = createSlotReadProfile({
			serviceId,
			date,
			thresholdMs: profileConfig.thresholdMs,
			calendarTileCount,
			matchedDateFound,
			slotCount: parsedSlots.length,
			parsedSlotCount: parsedSlots.length,
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
