import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import {
	BrowserService,
	defaultBrowserConfig,
} from '../../../shared/browser-service.js';
import {
	dateEmptySettleTimeoutMs,
	parsePylonCalendarIdentity,
	readDatesViaUrl,
	readSlotsViaUrl,
	resolvePylonStartDate,
	toPylonAvailabilityDates,
	toPylonAvailabilitySlots,
	urlReadNetworkIdleTimeoutMs,
} from './read-via-url.js';

describe('URL read timing config', () => {
	it('uses a short network-idle settle by default', () => {
		expect(urlReadNetworkIdleTimeoutMs(30_000, {})).toBe(1500);
	});

	it('honors explicit network-idle settle config including zero', () => {
		expect(
			urlReadNetworkIdleTimeoutMs(30_000, {
				ACUITY_URL_READ_NETWORK_IDLE_MS: '750',
			}),
		).toBe(750);
		expect(
			urlReadNetworkIdleTimeoutMs(30_000, {
				ACUITY_URL_READ_NETWORK_IDLE_MS: '0',
			}),
		).toBe(0);
	});

	it('never exceeds the caller operation timeout', () => {
		expect(
			urlReadNetworkIdleTimeoutMs(500, {
				ACUITY_URL_READ_NETWORK_IDLE_MS: '2000',
			}),
		).toBe(500);
	});

	it('falls back when the env value is invalid', () => {
		expect(
			urlReadNetworkIdleTimeoutMs(30_000, {
				ACUITY_URL_READ_NETWORK_IDLE_MS: 'nope',
			}),
		).toBe(1500);
	});
});

describe('date empty settle timing config', () => {
	it('waits briefly for enabled dates by default', () => {
		expect(dateEmptySettleTimeoutMs(30_000, {})).toBe(2500);
	});

	it('honors explicit empty-date settle config including zero', () => {
		expect(
			dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: '1000' }),
		).toBe(1000);
		expect(
			dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: '0' }),
		).toBe(0);
	});

	it('never exceeds the caller operation timeout', () => {
		expect(
			dateEmptySettleTimeoutMs(500, { ACUITY_EMPTY_DATE_SETTLE_MS: '2500' }),
		).toBe(500);
	});

	it('falls back when the empty-date settle env value is invalid', () => {
		expect(
			dateEmptySettleTimeoutMs(30_000, { ACUITY_EMPTY_DATE_SETTLE_MS: 'nope' }),
		).toBe(2500);
	});
});

const makePylonReadPage = (
	payload: Record<string, Array<{ time?: string; slotsAvailable?: number }>>,
) => {
	const gotoUrls: string[] = [];
	const apiUrls: string[] = [];
	let currentUrl =
		'https://massageithaca.as.me/schedule/4671d709/category/X19hbGxfXw%3D%3D/appointment/53178494/calendar/8973181?appointmentTypeIds[]=53178494';

	const page = {
		goto: vi.fn(async (url: string) => {
			gotoUrls.push(url);
		}),
		waitForLoadState: vi.fn(async () => undefined),
		url: vi.fn(() => currentUrl),
		evaluate: vi.fn(async (_fn: unknown, url: string) => {
			apiUrls.push(url);
			return payload;
		}),
		__setUrl: (url: string) => {
			currentUrl = url;
		},
	} as unknown as Page & { __setUrl: (url: string) => void };

	return {
		page,
		gotoUrls,
		apiUrls,
	};
};

const provideBrowser = <A, E>(
	page: Page,
	effect: Effect.Effect<A, E, BrowserService>,
) =>
	Effect.runPromise(
		Effect.scoped(
			effect.pipe(
				Effect.provideService(BrowserService, {
					acquirePage: Effect.succeed(page),
					screenshot: () => Effect.succeed(Buffer.from('')),
					config: {
						...defaultBrowserConfig,
						baseUrl: 'https://MassageIthaca.as.me',
						timeout: 1_000,
					},
				}),
			),
		),
	);

const runDateRead = (page: Page, targetMonth?: string) =>
	provideBrowser(page, readDatesViaUrl('53178494', targetMonth));

const runSlotRead = (page: Page, date: string) =>
	provideBrowser(page, readSlotsViaUrl('53178494', date));

describe('Acuity pylon availability helpers', () => {
	it('does not ask Acuity pylon availability for past current-month dates', () => {
		expect(resolvePylonStartDate('2026-05', '2026-05-14')).toBe('2026-05-14');
		expect(resolvePylonStartDate('2026-06', '2026-05-14')).toBe('2026-06-01');
		expect(resolvePylonStartDate(undefined, '2026-05-14')).toBe('2026-05-14');
	});

	it('parses calendar identity from category and non-category URLs', () => {
		expect(
			parsePylonCalendarIdentity(
				'https://massageithaca.as.me/schedule/4671d709/category/X19hbGxfXw%3D%3D/appointment/53178494/calendar/8973181',
			),
		).toEqual({
			origin: 'https://massageithaca.as.me',
			owner: '4671d709',
			appointmentTypeId: '53178494',
			calendarId: '8973181',
		});
		expect(
			parsePylonCalendarIdentity(
				'https://massageithaca.as.me/schedule/4671d709/appointment/53178494/calendar/8973181',
			),
		).toMatchObject({
			owner: '4671d709',
			appointmentTypeId: '53178494',
			calendarId: '8973181',
		});
	});

	it('maps pylon times payloads to available dates and slot counts', () => {
		expect(
			toPylonAvailabilityDates({
				'2026-05-17': [
					{ time: '2026-05-17T09:00:00-0400', slotsAvailable: 1 },
					{ time: '2026-05-17T09:30:00-0400', slotsAvailable: 2 },
				],
				'2026-05-18': [
					{ time: '2026-05-18T09:00:00-0400', slotsAvailable: 0 },
				],
			}),
		).toEqual([{ date: '2026-05-17', slots: 3 }]);
	});

	it('maps pylon times payloads to local slot datetimes', () => {
		expect(
			toPylonAvailabilitySlots(
				{
					'2026-05-17': [
						{ time: '2026-05-17T09:00:00-0400', slotsAvailable: 1 },
						{ time: '2026-05-17T09:30:00-0400', slotsAvailable: 0 },
					],
				},
				'2026-05-17',
			),
		).toEqual([
			{ datetime: '2026-05-17T09:00:00', available: true },
			{ datetime: '2026-05-17T09:30:00', available: false },
		]);
	});
});

describe('readDatesViaUrl pylon API behavior', () => {
	it('reads dates from Acuity pylon availability/times instead of react-calendar DOM', async () => {
		const fake = makePylonReadPage({
			'2026-05-17': [
				{ time: '2026-05-17T09:00:00-0400', slotsAvailable: 1 },
				{ time: '2026-05-17T09:30:00-0400', slotsAvailable: 1 },
			],
		});

		const dates = await runDateRead(fake.page, '2026-05');

		expect(dates).toEqual([{ date: '2026-05-17', slots: 2 }]);
		expect(fake.gotoUrls[0]).toBe(
			'https://massageithaca.as.me/?appointmentType=53178494',
		);
		const apiUrl = new URL(fake.apiUrls[0]);
		expect(apiUrl.pathname).toBe('/api/scheduling/v1/availability/times');
		expect(apiUrl.searchParams.get('owner')).toBe('4671d709');
		expect(apiUrl.searchParams.get('appointmentTypeId')).toBe('53178494');
		expect(apiUrl.searchParams.get('calendarId')).toBe('8973181');
		expect(apiUrl.searchParams.get('startDate')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(apiUrl.searchParams.get('maxDays')).toBe('45');
	});

	it('reads slots from the same Acuity pylon API', async () => {
		const fake = makePylonReadPage({
			'2026-05-17': [
				{ time: '2026-05-17T09:00:00-0400', slotsAvailable: 1 },
			],
		});

		const slots = await runSlotRead(fake.page, '2026-05-17');

		expect(slots).toEqual([
			{ datetime: '2026-05-17T09:00:00', available: true },
		]);
		const apiUrl = new URL(fake.apiUrls[0]);
		expect(apiUrl.searchParams.get('startDate')).toBe('2026-05-17');
		expect(apiUrl.searchParams.get('maxDays')).toBe('1');
	});
});
