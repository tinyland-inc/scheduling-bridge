import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import {
	BrowserService,
	defaultBrowserConfig,
} from '../../../shared/browser-service.js';
import {
	dateEmptySettleTimeoutMs,
	parseTimeSelectionDates,
	parseTimeSelectionSlots,
	readDatesViaUrl,
	type TimeSelectionEntry,
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

const monthNames = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
] as const;

const formatMonthKey = (date: Date): string =>
	`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const makeUrlDateReadPage = (
	initialMonth: string,
	datesByMonth: Map<string, string[]>,
	onWaitForFunction?: () => void,
) => {
	const [year, month] = initialMonth.split('-').map(Number);
	const current = new Date(year, month - 1, 1);
	const navClicks: string[] = [];
	const gotoUrls: string[] = [];

	const navHandle = (direction: 'prev' | 'next') => ({
		click: vi.fn(async () => {
			current.setMonth(current.getMonth() + (direction === 'next' ? 1 : -1));
			navClicks.push(direction);
		}),
	});

	const page = {
		goto: vi.fn(async (url: string) => {
			gotoUrls.push(url);
		}),
		waitForLoadState: vi.fn(async () => undefined),
		waitForSelector: vi.fn(async (selector: string) => {
			if (selector.includes('prev-button')) return navHandle('prev');
			if (selector.includes('next-button')) return navHandle('next');
			return {};
		}),
		waitForTimeout: vi.fn(async () => undefined),
		waitForFunction: vi.fn(async () => {
			onWaitForFunction?.();
		}),
		$eval: vi.fn(async () => {
			const label = `${monthNames[current.getMonth()]} ${current.getFullYear()}`;
			return label;
		}),
		evaluate: vi.fn(async () => {
			const dates = datesByMonth.get(formatMonthKey(current)) ?? [];
			return dates.map((date) => ({ date, slots: 1 }));
		}),
	} as unknown as Page;

	return {
		page,
		gotoUrls,
		navClicks,
	};
};

const runDateRead = (page: Page, targetMonth?: string) =>
	Effect.runPromise(
		Effect.scoped(
			readDatesViaUrl('53178494', targetMonth).pipe(
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

describe('readDatesViaUrl DOM behavior', () => {
	it('derives available dates from the current Acuity time-selection list', () => {
		const entries: TimeSelectionEntry[] = [
			{
				text: '10:00 AM1 spot left',
				ariaLabel: '10:00 AM, 1 spot left, Sunday May 31',
				disabled: false,
			},
			{
				text: '10:30 AM1 spot left',
				ariaLabel: '10:30 AM, 1 spot left, Sunday May 31',
				disabled: false,
			},
			{
				text: '10:00 AM1 spot left',
				ariaLabel: '10:00 AM, 1 spot left, Sunday Jun 7',
				disabled: false,
			},
		];

		expect(parseTimeSelectionDates(entries, '2026-05')).toEqual([
			{ date: '2026-05-31', slots: 1 },
		]);
		expect(parseTimeSelectionDates(entries, '2026-06')).toEqual([
			{ date: '2026-06-07', slots: 1 },
		]);
	});

	it('filters direct time-selection slots to the requested date', () => {
		const entries: TimeSelectionEntry[] = [
			{
				text: '10:00 AM1 spot left',
				ariaLabel: '10:00 AM, 1 spot left, Sunday May 31',
				disabled: false,
			},
			{
				text: '10:00 AM1 spot left',
				ariaLabel: '10:00 AM, 1 spot left, Sunday Jun 7',
				disabled: false,
			},
			{
				text: '10:30 AM1 spot left',
				ariaLabel: '10:30 AM, 1 spot left, Sunday Jun 7',
				disabled: true,
			},
		];

		expect(parseTimeSelectionSlots(entries, '2026-06-07')).toEqual([
			{ datetime: '10:00 AM1 spot left', available: true },
			{ datetime: '10:30 AM1 spot left', available: false },
		]);
	});

	it('waits for enabled dates before returning an empty month', async () => {
		const datesByMonth = new Map<string, string[]>([['2026-07', []]]);
		const fake = makeUrlDateReadPage('2026-07', datesByMonth, () => {
			datesByMonth.set('2026-07', ['2026-07-15']);
		});

		const dates = await runDateRead(fake.page);

		expect(dates).toEqual([{ date: '2026-07-15', slots: 1 }]);
		expect(fake.page.evaluate).toHaveBeenCalledTimes(3);
		expect(fake.page.waitForFunction).toHaveBeenCalledTimes(1);
	});

	it('navigates to the requested target month before reading enabled dates', async () => {
		const datesByMonth = new Map<string, string[]>([
			['2026-07', ['2026-07-15']],
			['2026-09', ['2026-09-12']],
		]);
		const fake = makeUrlDateReadPage('2026-07', datesByMonth);

		const dates = await runDateRead(fake.page, '2026-09');

		expect(dates).toEqual([{ date: '2026-09-12', slots: 1 }]);
		expect(fake.navClicks).toEqual(['next', 'next']);
		expect(fake.gotoUrls[0]).toBe(
			'https://massageithaca.as.me/?appointmentType=53178494',
		);
	});
});
