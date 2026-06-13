import { setTimeout as delay } from 'node:timers/promises';
import { Effect, ManagedRuntime } from 'effect';
import { Redis as IORedisImpl } from 'ioredis';
import type { Redis as IORedis } from 'ioredis';
import {
	BrowserProcessLive,
	BrowserSessionLive,
	defaultBrowserConfig,
	type BrowserConfig,
} from '../shared/browser-service.js';
import type { MiddlewareError } from '../adapters/acuity/errors.js';
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
	type BridgeJobLeaseContext,
} from '../async/worker.js';
import { ndjsonLog } from '../shared/logger.js';
import { parseRedisAsyncJobTtlSeconds } from '../async/config.js';
import type { Context, Layer } from 'effect';
import type { VendorFlowPack } from '../flow/vendor.js';
import type { Flow, FlowJournalShape } from '../flow/index.js';
import { acuityFlowPack } from '../adapters/acuity/flow-pack.js';
import type { AcuityBookingFlowSpec } from '../adapters/acuity/flow-steps.js';
import { paymentSegmentGate } from '../adapters/acuity/payment-gate.js';
import {
	extractCapabilities,
	type PaymentCapabilities,
} from '@tummycrypt/scheduling-kit/payments';
import {
	executeBookingThroughFlow,
	executeReadThroughFlow,
	selectFlowJournal,
	type FlowExecutionDeps,
	type RunFlowExit,
} from './flow-runner.js';

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
	/** FlowJournal override for tests; default rides the store selection order. */
	readonly flowJournal?: FlowJournalShape;
	/** VendorFlowPack substitution seam (stub packs/steps in tests; design §7). */
	readonly flowPack?: Context.Tag.Service<VendorFlowPack>;
	/** Session-layer-per-segment override for tests; default BrowserSessionLive. */
	readonly sessionLayer?: (segment: string) => Layer.Layer<any, any, any>;
	/** Effect runner override for tests; default the worker's browser runtime. */
	readonly runFlowExit?: RunFlowExit;
	/**
	 * Payment-injection capability resolver (design §7 double gate; TIN-2095). The
	 * kit half of the gate: kit `PaymentCapabilities` for the booking. Default
	 * derives them from the platform env via kit `extractCapabilities` (no
	 * practitioner DB settings at the worker tier today). Tests substitute a fixed
	 * capability set to exercise both gate halves.
	 */
	readonly paymentCapabilities?: (
		command: AppointmentCommand,
	) => PaymentCapabilities;
}

/**
 * Default kit-capability resolver for the worker tier (design §7 double gate;
 * TIN-2095). Starts from the platform-env kit capabilities
 * (`extractCapabilities`, recognizing the PayPal/Venmo + Stripe env keys). When
 * the env declares no off-platform rail BUT the booking carries a coupon-bypass
 * code, it synthesizes an admitting Venmo capability: a per-booking coupon IS the
 * operator's declaration that this booking settles the vendor charge via the
 * gift-certificate bypass with the real money moving through an off-platform
 * (Venmo/PayPal) rail — exactly the "Venmo-via-coupon" rail the segment proves
 * was bypassed (design §7). This keeps the existing coupon-configured booking
 * posture admitting while leaving the strict kit-capability predicate
 * (`admitsCouponBypass`) authoritative whenever real capabilities are supplied.
 */
const defaultPaymentCapabilities = (
	command: AppointmentCommand,
): PaymentCapabilities => {
	const fromEnv = extractCapabilities({}, process.env as Record<string, string>);
	if (fromEnv.venmo?.available || !command.couponCode) return fromEnv;
	return {
		...fromEnv,
		venmo: {
			available: true,
			clientId: 'coupon-bypass',
			environment: 'production',
		},
	};
};

/**
 * The bridge job executor: `runFlow` is the ONLY execution path (design §10 0.7.0
 * deletion gate, the anti-renaming guarantee). The three legacy hand-written
 * compositions and the `BRIDGE_FLOW_RUNNER` flag have been deleted; the fold's parity
 * with the (now-removed) legacy path is locked in by the recorded golden fixtures and
 * the trace-conformance harness (src/server/__tests__/trace-conformance.test.ts).
 *
 * The REST-path and COUPON_REQUIRED guards stay here, in the executor, so their codes
 * are byte-identical to what the deleted legacy path produced (the fold path in
 * flow-runner.ts relies on these executor-level guards).
 */
export const createAcuityBridgeJobExecutor = (
	options: AcuityBridgeJobExecutorOptions = {},
): BridgeJobExecutor => {
	const readCacheRedisClient =
		options.redisClient === undefined
			? getDefaultExecutorRedisClient()
			: options.redisClient;
	const flowPack = options.flowPack ?? acuityFlowPack;

	// Lazy so journal selection / flow-dep construction is deferred to first use.
	let flowDeps: FlowExecutionDeps | null = null;
	const getFlowDeps = (): FlowExecutionDeps => {
		flowDeps ??= {
			journal:
				options.flowJournal ??
				selectFlowJournal({ redisClient: readCacheRedisClient }),
			sessionLayer: options.sessionLayer ?? (() => BrowserSessionLive),
			runExit:
				options.runFlowExit ??
				((effect) =>
					browserRuntime.runPromiseExit(
						effect as Effect.Effect<unknown, unknown, never>,
					)),
		};
		return flowDeps;
	};

	return {
		refreshAvailabilityDates: async (
			command: AvailabilityDatesRefreshCommand,
			context?: BridgeJobLeaseContext,
		) => {
			const cacheKey = buildAvailabilityDatesCacheKey(
				command.adapterProfile.baseUrl,
				command.serviceId,
				command.month,
			);

			const dates = await executeReadThroughFlow<
				readonly { readonly date: string; readonly slots: number }[]
			>(
				getFlowDeps(),
				flowPack.flows.availability_dates_refresh,
				{
					serviceId: command.serviceId,
					month: command.month,
					serviceName: command.serviceName ?? null,
				},
				'dates',
				context,
			);
			await writeReadCache(
				readCacheRedisClient,
				'availability_dates',
				cacheKey,
				dates,
			);
			return dates;
		},

		refreshAvailabilitySlots: async (
			command: AvailabilitySlotsRefreshCommand,
			context?: BridgeJobLeaseContext,
		) => {
			const cacheKey = buildAvailabilitySlotsCacheKey(
				command.adapterProfile.baseUrl,
				command.serviceId,
				command.date,
			);

			const slots = await executeReadThroughFlow<
				readonly { readonly datetime: string; readonly available: boolean }[]
			>(
				getFlowDeps(),
				flowPack.flows.availability_slots_refresh,
				{
					serviceId: command.serviceId,
					date: command.date,
					serviceName: command.serviceName ?? null,
				},
				'slots',
				context,
			);
			await writeReadCache(
				readCacheRedisClient,
				'availability_slots',
				cacheKey,
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

			if (!command.couponCode) {
				throw new BridgeJobExecutionError({
					status: 'failed_pre_submit',
					code: 'COUPON_REQUIRED',
					message: 'Browser booking execution requires a coupon bypass code',
					step: 'bypass-payment',
					retryable: false,
				});
			}

			// DOUBLE GATE (design §7; TIN-2095), checked UPSTREAM of any browser work:
			// the coupon-bypass payment segment splices only if (a) the pack declares
			// paymentInjection 'coupon-bypass' AND (b) kit PaymentCapabilities admit
			// the method. Either denial means the payment segment does not run; for the
			// Acuity browser path the segment is required, so denial fails the booking
			// non-retryably BEFORE the fold provisions a browser session.
			const resolveCapabilities =
				options.paymentCapabilities ?? defaultPaymentCapabilities;
			const gate = paymentSegmentGate(flowPack, () =>
				resolveCapabilities(command),
			);
			if (!gate.admitted) {
				throw new BridgeJobExecutionError({
					status: 'failed_pre_submit',
					code:
						gate.reason === 'pack-denies'
							? 'PAYMENT_INJECTION_UNSUPPORTED'
							: 'PAYMENT_CAPABILITY_DENIED',
					message:
						gate.reason === 'pack-denies'
							? `Vendor pack '${flowPack.backend}' does not declare coupon-bypass payment injection`
							: 'Kit payment capabilities do not admit the coupon-bypass method',
					step: 'bypass-payment',
					retryable: false,
				});
			}

			return executeBookingThroughFlow(
				getFlowDeps(),
				flowPack.flows.booking_create_with_payment as Flow<
					AcuityBookingFlowSpec,
					MiddlewareError | undefined,
					any
				>,
				command,
				command.couponCode,
				context,
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
			jobTtlSeconds: parseRedisAsyncJobTtlSeconds(),
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
		readonly concurrency?: number;
		readonly signal?: AbortSignal;
	} = {},
) => {
	const workerId = options.workerId ?? process.env.HOSTNAME ?? `worker-${process.pid}`;
	const intervalMs = options.intervalMs ?? Number(process.env.BRIDGE_WORKER_POLL_MS ?? 1000);
	const limit = options.limit ?? Number(process.env.BRIDGE_WORKER_BATCH_SIZE ?? 5);
	const concurrency =
		options.concurrency ?? Number(process.env.BRIDGE_WORKER_CONCURRENCY ?? 1);

	logEvent('INFO', 'Bridge worker loop started', {
		event: 'bridge_worker_started',
		workerId,
		intervalMs,
		limit,
		concurrency,
	});

	while (!options.signal?.aborted) {
		const results = await drainReadyBridgeJobs(store, executor, {
			workerId,
			limit,
			concurrency,
		});
		if (results.length > 0) {
			const failedJobs = results
				.filter(
					(job) =>
						job.status === 'failed_pre_submit' ||
						job.status === 'reconcile_required',
				)
				.map((job) => ({
					operationId: job.operationId,
					kind: job.kind,
					status: job.status,
					serviceId:
						'serviceId' in job.command ? job.command.serviceId : undefined,
					scope:
						'month' in job.command
							? job.command.month
							: 'date' in job.command
								? job.command.date
								: undefined,
					code: job.failure?.code,
					step: job.failure?.step,
					retryable: job.failure?.retryable,
				}));
			logEvent('INFO', 'Bridge worker drained jobs', {
				event: 'bridge_worker_drained_jobs',
				workerId,
				count: results.length,
				statuses: results.map((job) => job.status),
				failedJobs,
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
