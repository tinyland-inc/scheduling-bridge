import { setTimeout as delay } from 'node:timers/promises';
import { Effect, Exit, Cause, ManagedRuntime, Scope } from 'effect';
import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis } from 'ioredis';
import {
	BrowserProcessLive,
	BrowserService,
	BrowserSessionLive,
	defaultBrowserConfig,
	type BrowserConfig,
} from '../shared/browser-service.js';
import { toSchedulingError, type MiddlewareError } from '../adapters/acuity/errors.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	submitBooking,
	extractConfirmation,
	toBooking,
	readAvailableDates,
	readTimeSlots,
} from '../adapters/acuity/steps/index.js';
import {
	readDatesViaUrl,
	readSlotsViaUrl,
} from '../adapters/acuity/steps/read-via-url.js';
import { buildAvailabilityDatesCacheKey } from './date-prewarm.js';
import { buildAvailabilitySlotsCacheKey } from './slot-prewarm.js';
import type {
	AppointmentCommand,
	AvailabilityDatesRefreshCommand,
	AvailabilitySlotsRefreshCommand,
} from '../async/types.js';
import type { BridgeAsyncStore } from '../async/store.js';
import { createInMemoryBridgeAsyncStore } from '../async/store.js';
import { createPostgresBridgeAsyncStore } from '../async/postgres-store.js';
import { createRedisBridgeAsyncStore } from '../async/redis-store.js';
import {
	BridgeJobExecutionError,
	drainReadyBridgeJobs,
	selectBookingExecutionPath,
	type BridgeJobExecutor,
} from '../async/worker.js';
import { ndjsonLog } from '../shared/logger.js';

const ACUITY_BASE_URL = process.env.ACUITY_BASE_URL ?? 'https://example.as.me';
const BRIDGE_DATABASE_URL = process.env.BRIDGE_DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const READ_CACHE_TTL_SECONDS = (() => {
	const parsed = Number(process.env.ACUITY_READ_CACHE_TTL_SECONDS ?? 20 * 60);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 20 * 60;
})();
const EMPTY_READ_CACHE_TTL_SECONDS = (() => {
	const parsed = Number(process.env.ACUITY_EMPTY_READ_CACHE_TTL_SECONDS ?? 2 * 60);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 2 * 60;
})();

const browserConfig: BrowserConfig = {
	...defaultBrowserConfig,
	baseUrl: ACUITY_BASE_URL,
	headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
	timeout: Number(process.env.PLAYWRIGHT_TIMEOUT ?? 30000),
	executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
	launchArgs: process.env.CHROMIUM_LAUNCH_ARGS?.split(','),
};

const browserRuntime = ManagedRuntime.make(BrowserProcessLive(browserConfig));

const createRedisClient = (): IORedis | null =>
	REDIS_URL
		? new IORedisImpl(REDIS_URL, {
				password: REDIS_PASSWORD,
				maxRetriesPerRequest: 3,
			})
		: null;

let defaultExecutorRedisClient: IORedis | null | undefined;

const getDefaultExecutorRedisClient = (): IORedis | null => {
	if (defaultExecutorRedisClient === undefined) {
		defaultExecutorRedisClient = createRedisClient();
	}
	return defaultExecutorRedisClient;
};

const logEvent = (
	level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
	msg: string,
	data?: Record<string, unknown>,
) => {
	ndjsonLog(level, msg, {
		flowOwner: 'scheduling-bridge',
		backend: 'acuity',
		transport: 'async-worker',
		modalEnvironment: process.env.MODAL_ENVIRONMENT,
		releaseSha: process.env.MIDDLEWARE_RELEASE_SHA,
		releaseVersion: process.env.MIDDLEWARE_RELEASE_VERSION ?? process.env.npm_package_version,
		...data,
	});
};

const isAcuityAppointmentTypeId = (serviceId: string): boolean => /^\d+$/.test(serviceId);

const schedulingErrorFields = (error: unknown) => {
	if (typeof error === 'object' && error !== null) {
		const maybe = error as { _tag?: string; code?: string; message?: string };
		return {
			code: maybe.code ?? maybe._tag ?? 'UNKNOWN',
			message: maybe.message ?? JSON.stringify(error),
		};
	}
	return {
		code: 'UNKNOWN',
		message: error instanceof Error ? error.message : String(error),
	};
};

const exitToValue = <A>(
	exit: Exit.Exit<A, MiddlewareError | undefined>,
	step: string,
	status: 'failed_pre_submit' | 'reconcile_required',
): A => {
	if (Exit.isSuccess(exit)) return exit.value;
	const failure = Cause.failureOption(exit.cause);
	const error = failure._tag === 'Some' && failure.value !== undefined
		? toSchedulingError(failure.value)
		: { _tag: 'InfrastructureError', code: 'UNKNOWN', message: Cause.pretty(exit.cause) };
	const fields = schedulingErrorFields(error);
	throw new BridgeJobExecutionError({
		status,
		code: fields.code,
		message: fields.message,
		step,
		retryable: status === 'failed_pre_submit',
	});
};

const runWizardStep = async <A>(
	effect: Effect.Effect<A, MiddlewareError | undefined, BrowserService | Scope.Scope>,
	step: string,
	status: 'failed_pre_submit' | 'reconcile_required' = 'failed_pre_submit',
): Promise<A> => {
	const exit = await browserRuntime.runPromiseExit(
		Effect.scoped(effect.pipe(Effect.provide(BrowserSessionLive))),
	);
	return exitToValue(exit, step, status);
};

const assertPaymentBypassProven = (result: {
	readonly couponApplied: boolean;
	readonly totalAfterCoupon: string | null;
}) => {
	const numericTotal = result.totalAfterCoupon
		? Number(result.totalAfterCoupon.replace(/[^0-9.]/g, ''))
		: null;
	if (!result.couponApplied || numericTotal !== 0) {
		throw new BridgeJobExecutionError({
			status: 'failed_pre_submit',
			code: 'PAYMENT_BYPASS_NOT_PROVEN',
			message: 'Payment bypass was not proven before submit',
			step: 'bypass-payment',
			retryable: false,
		});
	}
};

const valueTtlSeconds = (value: readonly unknown[]): number =>
	value.length === 0 ? EMPTY_READ_CACHE_TTL_SECONDS : READ_CACHE_TTL_SECONDS;

const writeReadCache = async (
	redisClient: IORedis | null,
	cacheKind: 'availability_dates' | 'availability_slots',
	cacheKey: string,
	value: readonly unknown[],
) => {
	if (!redisClient) return;
	try {
		await redisClient.set(
			cacheKey,
			JSON.stringify(value),
			'EX',
			valueTtlSeconds(value),
		);
		logEvent('INFO', 'Bridge worker wrote read cache', {
			event: 'bridge_worker_read_cache_written',
			cacheKind,
			cacheKey,
			valueCount: value.length,
		});
	} catch (error) {
		logEvent('WARN', 'Bridge worker read cache write failed', {
			event: 'bridge_worker_read_cache_write_failed',
			cacheKind,
			cacheKey,
			error: error instanceof Error ? error.message : String(error),
		});
	}
};

export interface AcuityBridgeJobExecutorOptions {
	readonly redisClient?: IORedis | null;
}

export const createAcuityBridgeJobExecutor = (
	options: AcuityBridgeJobExecutorOptions = {},
): BridgeJobExecutor => {
	const readCacheRedisClient =
		options.redisClient === undefined
			? getDefaultExecutorRedisClient()
			: options.redisClient;

	return {
		refreshAvailabilityDates: async (command: AvailabilityDatesRefreshCommand) => {
			const dates = isAcuityAppointmentTypeId(command.serviceId)
				? await runWizardStep(
						readDatesViaUrl(command.serviceId, command.month),
						'refresh-availability-dates',
					)
				: await runWizardStep(
					readAvailableDates({
						serviceName: command.serviceName ?? command.serviceId,
						targetMonth: command.month,
						monthsToScan: 2,
					}),
					'refresh-availability-dates',
				);
			await writeReadCache(
				readCacheRedisClient,
				'availability_dates',
				buildAvailabilityDatesCacheKey(
					command.adapterProfile.baseUrl,
					command.serviceId,
					command.month,
				),
				dates,
			);
			return dates;
		},

		refreshAvailabilitySlots: async (command: AvailabilitySlotsRefreshCommand) => {
			const slots = isAcuityAppointmentTypeId(command.serviceId)
				? await runWizardStep(
						readSlotsViaUrl(command.serviceId, command.date),
						'refresh-availability-slots',
					)
				: await runWizardStep(
					readTimeSlots({
						serviceName: command.serviceName ?? command.serviceId,
						date: command.date,
					}),
					'refresh-availability-slots',
				);
			await writeReadCache(
				readCacheRedisClient,
				'availability_slots',
				buildAvailabilitySlotsCacheKey(
					command.adapterProfile.baseUrl,
					command.serviceId,
					command.date,
				),
				slots,
			);
			return slots;
		},

		createBookingWithPayment: async (command: AppointmentCommand, context) => {
			if (context.executionPath === 'rest') {
				throw new BridgeJobExecutionError({
					status: 'failed_pre_submit',
					code: 'REST_BOOKING_NOT_WIRED',
					message: 'Acuity REST booking execution is selected but not wired in this worker',
					step: 'execution-path',
					retryable: false,
				});
			}
			const serviceName = command.serviceName ?? command.request.serviceId;
			await runWizardStep(
				navigateToBooking({
					serviceName,
					datetime: command.request.datetime,
					client: command.request.client,
					appointmentTypeId: command.request.serviceId,
				}),
				'navigate',
			);
			await runWizardStep(
				fillFormFields({
					client: command.request.client,
					customFields: command.request.client.customFields,
				}),
				'fill-form',
			);
			if (!command.couponCode) {
				throw new BridgeJobExecutionError({
					status: 'failed_pre_submit',
					code: 'COUPON_REQUIRED',
					message: 'Browser booking execution requires a coupon bypass code',
					step: 'bypass-payment',
					retryable: false,
				});
			}
			const bypass = await runWizardStep(
				bypassPayment(command.couponCode),
				'bypass-payment',
			);
			assertPaymentBypassProven(bypass);
			await runWizardStep(
				submitBooking(),
				'submit',
				'reconcile_required',
			);
			const confirmation = await runWizardStep(
				extractConfirmation(),
				'extract-confirmation',
				'reconcile_required',
			);
			return toBooking(
				confirmation,
				command.request,
				command.paymentRef,
				command.paymentProcessor,
			);
		},
	};
};

export const createWorkerStore = (): BridgeAsyncStore & {
	readonly close?: () => Promise<void>;
} => {
	if (BRIDGE_DATABASE_URL) {
		const store = createPostgresBridgeAsyncStore({
			connectionString: BRIDGE_DATABASE_URL,
			ssl: process.env.BRIDGE_DATABASE_SSL === 'true',
			migrate: process.env.BRIDGE_DATABASE_MIGRATE !== 'false',
		});
		return store;
	}
	if (REDIS_URL) {
		return createRedisBridgeAsyncStore({
			url: REDIS_URL,
			redisOptions: {
				password: REDIS_PASSWORD,
				maxRetriesPerRequest: 3,
			},
			keyPrefix: process.env.BRIDGE_REDIS_ASYNC_PREFIX,
		});
	}
	logEvent('WARN', 'Bridge worker using in-memory store', {
		event: 'bridge_worker_memory_store',
	});
	return createInMemoryBridgeAsyncStore();
};

export const runBridgeWorkerLoop = async (
	store = createWorkerStore(),
	executor = createAcuityBridgeJobExecutor(),
	options: {
		readonly workerId?: string;
		readonly intervalMs?: number;
		readonly limit?: number;
		readonly signal?: AbortSignal;
	} = {},
) => {
	const workerId = options.workerId ?? process.env.HOSTNAME ?? `worker-${process.pid}`;
	const intervalMs = options.intervalMs ?? Number(process.env.BRIDGE_WORKER_POLL_MS ?? 1000);
	const limit = options.limit ?? Number(process.env.BRIDGE_WORKER_BATCH_SIZE ?? 5);

	logEvent('INFO', 'Bridge worker loop started', {
		event: 'bridge_worker_started',
		workerId,
		intervalMs,
		limit,
	});

	while (!options.signal?.aborted) {
		const results = await drainReadyBridgeJobs(store, executor, {
			workerId,
			limit,
		});
		if (results.length > 0) {
			logEvent('INFO', 'Bridge worker drained jobs', {
				event: 'bridge_worker_drained_jobs',
				workerId,
				count: results.length,
				statuses: results.map((job) => job.status),
				executionPaths: results
					.filter((job) => job.kind === 'booking_create_with_payment')
					.map((job) => selectBookingExecutionPath(job.command as AppointmentCommand)),
			});
		}
		await delay(intervalMs, undefined, { signal: options.signal }).catch((error) => {
			if (options.signal?.aborted) return;
			throw error;
		});
	}
};

if (process.argv[1]?.match(/worker\.(ts|js|mjs)$/)) {
	runBridgeWorkerLoop().catch((error) => {
		logEvent('ERROR', 'Bridge worker failed', {
			event: 'bridge_worker_failed',
			error: error instanceof Error ? error.message : String(error),
		});
		process.exitCode = 1;
	});
}
