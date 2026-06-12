/**
 * Server configuration (env knobs).
 *
 * Extracted verbatim from `src/server/handler.ts` (handler decomposition
 * phase 1, TIN-2036 / docs/design/flow-dag-formalization.md section 8).
 * Pure code motion: values, defaults, and parse semantics are unchanged.
 */

import type { ScraperConfig } from '../adapters/acuity/scraper.js';
import {
	type BrowserConfig,
	defaultBrowserConfig,
} from '../shared/browser-service.js';
import { getDatePrewarmMonths } from './date-prewarm.js';
import { getSlotPrewarmLimit } from './slot-prewarm.js';

export const PORT = Number(process.env.PORT ?? 3001);
export const AUTH_TOKEN = process.env.AUTH_TOKEN;
export const ACUITY_BASE_URL =
	process.env.ACUITY_BASE_URL ?? 'https://example.as.me';
export const COUPON_CODE = process.env.ACUITY_BYPASS_COUPON;
export const SERVICE_CACHE_TTL_MS = (() => {
	const parsed = Number(process.env.ACUITY_SERVICE_CACHE_TTL_MS ?? 5 * 60_000);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5 * 60_000;
})();
export const READ_CACHE_TTL_SECONDS = (() => {
	const parsed = Number(process.env.ACUITY_READ_CACHE_TTL_SECONDS ?? 20 * 60);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * 60;
})();
export const EMPTY_READ_CACHE_TTL_SECONDS = (() => {
	const parsed = Number(
		process.env.ACUITY_EMPTY_READ_CACHE_TTL_SECONDS ?? 2 * 60,
	);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 60;
})();
export const READ_CACHE_LOCK_TTL_MS = (() => {
	const parsed = Number(process.env.ACUITY_READ_CACHE_LOCK_TTL_MS ?? 90_000);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 90_000;
})();
export const READ_CACHE_WAIT_TIMEOUT_MS = (() => {
	const parsed = Number(
		process.env.ACUITY_READ_CACHE_WAIT_TIMEOUT_MS ?? 55_000,
	);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 55_000;
})();
export const DATE_PREWARM_MONTHS = getDatePrewarmMonths();
export const SLOT_PREWARM_LIMIT = getSlotPrewarmLimit();
export const HEARTBEAT_DEFAULT_MAX_JOBS = (() => {
	const parsed = Number(process.env.BRIDGE_HEARTBEAT_MAX_JOBS ?? 12);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 12;
})();
export const HEARTBEAT_MAX_JOBS_CAP = 100;
export const HEARTBEAT_DEFAULT_IDEMPOTENCY_WINDOW_MS = (() => {
	const parsed = Number(
		process.env.BRIDGE_HEARTBEAT_IDEMPOTENCY_WINDOW_MS ?? 5 * 60_000,
	);
	return Number.isFinite(parsed) && parsed > 0
		? Math.floor(parsed)
		: 5 * 60_000;
})();
export const READINESS_DEFAULT_FRESHNESS_FLOOR_MS = (() => {
	const parsed = Number(
		process.env.BRIDGE_READINESS_FRESHNESS_FLOOR_MS ?? 90_000,
	);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 90_000;
})();
export const READINESS_DEFAULT_MAX_OLDEST_QUEUED_AGE_MS = (() => {
	const parsed = Number(
		process.env.BRIDGE_READINESS_MAX_OLDEST_QUEUED_AGE_MS ?? 120_000,
	);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120_000;
})();
export const READINESS_WAIT_DEFAULT_TIMEOUT_MS = (() => {
	const parsed = Number(process.env.BRIDGE_READINESS_WAIT_TIMEOUT_MS ?? 60_000);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 60_000;
})();
export const READINESS_WAIT_DEFAULT_POLL_MS = (() => {
	const parsed = Number(process.env.BRIDGE_READINESS_WAIT_POLL_MS ?? 1000);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1000;
})();

export const browserConfig: BrowserConfig = {
	...defaultBrowserConfig,
	baseUrl: ACUITY_BASE_URL,
	headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
	timeout: Number(process.env.PLAYWRIGHT_TIMEOUT ?? 30000),
	executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
	launchArgs: process.env.CHROMIUM_LAUNCH_ARGS?.split(','),
};

export const scraperConfig: ScraperConfig = {
	baseUrl: ACUITY_BASE_URL,
	headless: browserConfig.headless,
	timeout: browserConfig.timeout,
	userAgent: browserConfig.userAgent,
	executablePath: browserConfig.executablePath,
	launchArgs: browserConfig.launchArgs
		? [...browserConfig.launchArgs]
		: undefined,
};
