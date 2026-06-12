/**
 * Middleware HTTP Server
 *
 * Standalone Node.js HTTP server wrapping the Effect TS wizard programs.
 * Designed to run inside a Docker container with Playwright + Chromium
 * on Kubernetes, Docker, or any host.
 *
 * Endpoints:
 *   GET  /health                    - Health check
 *   GET  /services                  - List services (static/BUSINESS/scraper)
 *   GET  /services/:id              - Get service by ID
 *   POST /availability/dates        - Available dates for a service
 *   POST /availability/slots        - Time slots for a date
 *   POST /availability/check        - Check if a slot is available
 *   POST /availability/refresh      - Enqueue async availability refresh
 *   GET  /availability/snapshot     - Read latest availability snapshot
 *   GET  /internal/availability/snapshot-canary - Auth-gated durable snapshot proof
 *   POST /internal/availability/heartbeat - Auth-gated bounded refresh heartbeat
 *   GET  /internal/flows            - Auth-gated registered FlowPlans (read-only)
 *   POST /booking/create            - Create booking (standard)
 *   POST /booking/create-with-payment - Deprecated sync paid booking endpoint
 *   POST /booking/jobs              - Enqueue async paid booking job
 *   GET  /jobs/:operationId         - Read async job status
 *
 * Environment variables:
 *   PORT                - Server port (default: 3001)
 *   ACUITY_BASE_URL     - Acuity scheduling URL
 *   ACUITY_BYPASS_COUPON - 100% coupon code
 *   AUTH_TOKEN           - Required Bearer token for all endpoints
 *   PLAYWRIGHT_HEADLESS  - Browser headless mode (default: true)
 *   PLAYWRIGHT_TIMEOUT   - Page timeout in ms (default: 30000)
 *
 * Usage:
 *   node --import tsx/esm src/server/handler.ts
 *   # or after build:
 *   node dist/server/handler.js
 */

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { BrowserProcess } from '../shared/browser-service.js';
import {
	runBridgeReadCached,
	type BridgeReadCacheClient,
} from '../shared/bridge-read-cache.js';
import {
	metrics,
	recordAvailabilityReadinessCheck,
	recordAvailabilityReadinessScope,
	recordAvailabilityHeartbeatJob,
	recordAvailabilitySnapshotRead,
	recordAvailabilitySnapshotServed,
	renderMetrics,
	setAvailabilitySnapshotAge,
	setBridgeQueueDepth,
	setBridgeQueueOldestAge,
} from '../shared/metrics.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
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
import { acuityFlowEnqueuePinning, acuityFlows } from '../adapters/acuity/flows.js';
import { buildHealthPayload } from './health.js';
import { handleReady as _handleReady } from './ready.js';
import {
	buildAvailabilityDatesCacheKey,
	selectDatePrewarmMonths,
} from './date-prewarm.js';
import {
	buildAvailabilitySlotsCacheKey,
	selectSlotPrewarmDates,
} from './slot-prewarm.js';
import type {
	AvailabilitySnapshot,
	AvailabilitySnapshotKind,
	AvailabilityHeartbeatJob,
	AvailabilityHeartbeatResponse,
	AvailabilityReadinessFreshness,
	AvailabilityReadinessResponse,
	AvailabilityReadinessScope,
	AvailabilityWaitReadyResponse,
	AvailabilityHeartbeatSkipped,
	BridgeAdapterProfile,
	BridgeJobCommand,
	BridgeJobRecord,
	BridgeJobStatus,
	EnqueueBridgeJobResponse,
} from '../async/types.js';
import type {
	BookingRequest,
	AvailableDate,
	TimeSlot,
} from '../core/types.js';
import { Errors } from '../core/types.js';
import {
	ACUITY_BASE_URL,
	AUTH_TOKEN,
	browserConfig,
	COUPON_CODE,
	DATE_PREWARM_MONTHS,
	EMPTY_READ_CACHE_TTL_SECONDS,
	HEARTBEAT_DEFAULT_IDEMPOTENCY_WINDOW_MS,
	HEARTBEAT_DEFAULT_MAX_JOBS,
	HEARTBEAT_MAX_JOBS_CAP,
	PORT,
	READ_CACHE_LOCK_TTL_MS,
	READ_CACHE_TTL_SECONDS,
	READ_CACHE_WAIT_TIMEOUT_MS,
	READINESS_DEFAULT_FRESHNESS_FLOOR_MS,
	READINESS_DEFAULT_MAX_OLDEST_QUEUED_AGE_MS,
	READINESS_WAIT_DEFAULT_POLL_MS,
	READINESS_WAIT_DEFAULT_TIMEOUT_MS,
	SERVICE_CACHE_TTL_MS,
	SLOT_PREWARM_LIMIT,
} from './config.js';
import {
	createSlotReadTelemetryContext,
	describeLogValue,
	logEvent,
	logRequestEvent,
	parseBody,
	sendError,
	sendJson,
	sendSuccess,
	sendValidationError,
	type RequestContext,
} from './http.js';
import { browserRuntime, runEffect, type Result } from './runtime.js';
import {
	bridgeAsyncStore,
	disposeBridgeAsyncStore,
	disposeRedisClient,
	redisClient,
	serviceCatalog,
	startInlineWorker,
	stopInlineWorker,
} from './stores.js';
import {
	ISO_DATE_RE,
	isNonEmptyString,
	isRecord,
	isSchedulingError,
	optionalString,
	YEAR_MONTH_RE,
} from './validation.js';

const acuitySteps = {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	readAvailableDates,
	readTimeSlots,
	readDatesViaUrl,
	readSlotsViaUrl,
};

export const __setAcuityStepOverridesForTest = (
	overrides: Partial<typeof acuitySteps>,
) => {
	Object.assign(acuitySteps, overrides);
};

// Test seams moved by the handler decomposition (phase 1) keep their original
// import path: everything external (especially the server test suites)
// imports them from `./handler.js`, so they are re-exported here.
export {
	__runEffectWithoutBrowserForTest,
	__setEffectRunnerForTest,
} from './runtime.js';
export { __setBridgeAsyncStoreForTest } from './stores.js';

interface AvailabilityHeartbeatCandidate {
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly serviceName?: string;
	readonly scope: string;
	readonly weight: number;
	readonly order: number;
}

interface AvailabilityHeartbeatDemandGroup {
	readonly weight: number;
	readonly order: number;
	readonly candidates: readonly AvailabilityHeartbeatCandidate[];
}

interface AvailabilityHeartbeatDemandGroupCursor {
	readonly group: AvailabilityHeartbeatDemandGroup;
	readonly schedulingWeight: number;
	candidateIndex: number;
	served: number;
}

const heartbeatSchedulingWeight = (weight: number): number => {
	if (!Number.isFinite(weight)) return 1;
	return Math.max(1, Math.min(100, Math.floor(weight)));
};

const orderHeartbeatCandidateGroups = (
	groups: readonly AvailabilityHeartbeatDemandGroup[],
): readonly AvailabilityHeartbeatCandidate[] => {
	const orderedCandidates: AvailabilityHeartbeatCandidate[] = [];
	const cursors: AvailabilityHeartbeatDemandGroupCursor[] = groups
		.filter((group) => group.candidates.length > 0)
		.map((group) => ({
			group,
			schedulingWeight: heartbeatSchedulingWeight(group.weight),
			candidateIndex: 0,
			served: 0,
		}));

	while (cursors.some((cursor) => cursor.candidateIndex < cursor.group.candidates.length)) {
		const next = cursors
			.filter(
				(cursor) => cursor.candidateIndex < cursor.group.candidates.length,
			)
			.sort((a, b) => {
				const aShare = a.served / a.schedulingWeight;
				const bShare = b.served / b.schedulingWeight;
				return (
					aShare - bShare ||
					b.group.weight - a.group.weight ||
					a.group.order - b.group.order
				);
			})[0];
		const candidate = next?.group.candidates[next.candidateIndex];
		if (!next || !candidate) break;
		orderedCandidates.push(candidate);
		next.candidateIndex += 1;
		next.served += 1;
	}
	return orderedCandidates;
};

const parsePositiveInteger = (
	value: unknown,
	fallback: number,
	max: number,
): number => {
	if (value === undefined) return Math.min(fallback, max);
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return Math.min(fallback, max);
	return Math.min(Math.floor(parsed), max);
};

const parsePositiveMs = (value: unknown, fallback: number): number => {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
	return Math.floor(parsed);
};

const collectStringList = (
	value: unknown,
	pattern: RegExp,
	field: string,
):
	| { ok: true; value: readonly string[] }
	| { ok: false; field: string; message: string } => {
	if (value === undefined) return { ok: true, value: [] };
	if (!Array.isArray(value)) {
		return { ok: false, field, message: `${field} must be an array` };
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const [index, item] of value.entries()) {
		if (typeof item !== 'string' || !pattern.test(item)) {
			return {
				ok: false,
				field: `${field}[${index}]`,
				message: `${field}[${index}] has an invalid format`,
			};
		}
		if (!seen.has(item)) {
			seen.add(item);
			out.push(item);
		}
	}
	return { ok: true, value: out };
};

const collectHeartbeatCandidates = (
	rawBody: Record<string, unknown>,
):
	| { ok: true; value: readonly AvailabilityHeartbeatCandidate[] }
	| { ok: false; field: string; message: string } => {
	if (!Array.isArray(rawBody.demands)) {
		return { ok: false, field: 'demands', message: 'demands must be an array' };
	}
	const commonMonths = collectStringList(
		rawBody.months,
		YEAR_MONTH_RE,
		'months',
	);
	if (!commonMonths.ok) return commonMonths;
	const commonDates = collectStringList(rawBody.dates, ISO_DATE_RE, 'dates');
	if (!commonDates.ok) return commonDates;

	const groups: AvailabilityHeartbeatDemandGroup[] = [];
	for (const [demandIndex, demand] of rawBody.demands.entries()) {
		if (!isRecord(demand)) {
			return {
				ok: false,
				field: `demands[${demandIndex}]`,
				message: `demands[${demandIndex}] must be an object`,
			};
		}
		if (!isNonEmptyString(demand.serviceId)) {
			return {
				ok: false,
				field: `demands[${demandIndex}].serviceId`,
				message: 'serviceId is required',
			};
		}
		const serviceName = optionalString(demand.serviceName);
		if (serviceName === null) {
			return {
				ok: false,
				field: `demands[${demandIndex}].serviceName`,
				message: 'serviceName must be a string',
			};
		}
		const months = collectStringList(
			demand.months ?? commonMonths.value,
			YEAR_MONTH_RE,
			`demands[${demandIndex}].months`,
		);
		if (!months.ok) return months;
		const dates = collectStringList(
			demand.dates ?? commonDates.value,
			ISO_DATE_RE,
			`demands[${demandIndex}].dates`,
		);
		if (!dates.ok) return dates;
		if (months.value.length === 0 && dates.value.length === 0) {
			return {
				ok: false,
				field: `demands[${demandIndex}]`,
				message: 'each demand must include at least one month or date',
			};
		}
		const parsedWeight = Number(demand.weight ?? 0);
		const weight = Number.isFinite(parsedWeight) ? parsedWeight : 0;
		const demandCandidates: AvailabilityHeartbeatCandidate[] = [];
		for (const month of months.value) {
			demandCandidates.push({
				kind: 'dates',
				serviceId: demand.serviceId,
				serviceName,
				scope: month,
				weight,
				order: demandCandidates.length,
			});
		}
		for (const date of dates.value) {
			demandCandidates.push({
				kind: 'slots',
				serviceId: demand.serviceId,
				serviceName,
				scope: date,
				weight,
				order: demandCandidates.length,
			});
		}
		groups.push({
			weight,
			order: demandIndex,
			candidates: demandCandidates,
		});
	}

	return {
		ok: true,
		value: orderHeartbeatCandidateGroups(groups),
	};
};

const heartbeatIdempotencyBucket = (
	windowMs: number,
	now = Date.now(),
): number => Math.floor(now / Math.max(1, windowMs));

const runCachedBridgeRead = async <A>(
	context: RequestContext,
	cacheKind: string,
	cacheKey: string,
	read: () => Promise<Result<A>>,
	shouldCache?: (value: A) => boolean,
): Promise<Result<A>> => {
	return runBridgeReadCached({
		redisClient: redisClient as BridgeReadCacheClient | null,
		cacheKind,
		cacheKey,
		ttlSeconds: READ_CACHE_TTL_SECONDS,
		emptyTtlSeconds: EMPTY_READ_CACHE_TTL_SECONDS,
		lockTtlMs: READ_CACHE_LOCK_TTL_MS,
		waitTimeoutMs: READ_CACHE_WAIT_TIMEOUT_MS,
		waitTimeoutResult: (waitMs) => ({
			ok: false,
			error: Errors.infrastructure(
				'TIMEOUT',
				`Timed out after ${waitMs}ms waiting for ${cacheKind} cache fill`,
			),
		}),
		read,
		shouldCache,
		log: ({ event, cacheKind, waitMs, error }) => {
			logRequestEvent(
				error ? 'ERROR' : 'INFO',
				'Bridge read cache event',
				context,
				{
					event,
					cacheKind,
					...(waitMs === undefined ? {} : { waitMs }),
					...(error === undefined ? {} : { error: describeLogValue(error) }),
				},
			);
		},
	});
};

const resolveServiceName = async (
	serviceId: string,
	serviceName?: string,
): Promise<string> => {
	try {
		return await serviceCatalog.resolveServiceName(serviceId, serviceName);
	} catch (error) {
		logEvent('WARN', 'Service name resolution failed', {
			event: 'service_name_resolution_failed',
			serviceId,
			serviceName,
			error: describeLogValue(error),
		});
		return serviceName && !/^\d+$/.test(serviceName) ? serviceName : serviceId;
	}
};

const isAcuityAppointmentTypeId = (serviceId: string): boolean =>
	/^\d+$/.test(serviceId);

const adapterProfile = (): BridgeAdapterProfile => ({
	backend: 'acuity',
	baseUrl: ACUITY_BASE_URL,
	selectorProfile: process.env.ACUITY_SELECTOR_PROFILE,
	adminApiConfigured: process.env.ACUITY_ADMIN_API_CONFIGURED === 'true',
});

const jobStatusUrl = (operationId: string): string =>
	`/jobs/${encodeURIComponent(operationId)}`;

const toEnqueueResponse = (job: BridgeJobRecord): EnqueueBridgeJobResponse => ({
	operationId: job.operationId,
	status: job.status,
	statusUrl: jobStatusUrl(job.operationId),
});

const heartbeatRunnableStatuses = new Set<BridgeJobStatus>([
	'queued',
	'leased',
	'running',
]);

const isRetryableHeartbeatFailure = (record: BridgeJobRecord): boolean =>
	(record.status === 'failed_pre_submit' ||
		record.status === 'reconcile_required') &&
	record.failure?.retryable === true;

const sendAccepted = <T>(res: ServerResponse, data: T) =>
	sendJson(res, 202, { success: true, data });

const snapshotTimestamps = (observedAt = new Date()) => {
	const staleAfterMs = Number(
		process.env.BRIDGE_SNAPSHOT_STALE_MS ?? 5 * 60_000,
	);
	const expiresAfterMs = Number(
		process.env.BRIDGE_SNAPSHOT_EXPIRES_MS ?? 30 * 60_000,
	);
	return {
		observedAt: observedAt.toISOString(),
		staleAt: new Date(observedAt.getTime() + staleAfterMs).toISOString(),
		expiresAt: new Date(observedAt.getTime() + expiresAfterMs).toISOString(),
	};
};

const recordAvailabilitySnapshot = async (
	kind: AvailabilitySnapshotKind,
	serviceId: string,
	scope: string,
	value: readonly unknown[],
	context: RequestContext,
) => {
	try {
		await bridgeAsyncStore.upsertAvailabilitySnapshot({
			kind,
			serviceId,
			scope,
			adapterProfile: adapterProfile(),
			value: value as never,
			...snapshotTimestamps(),
		});
	} catch (error) {
		logRequestEvent('WARN', 'Availability snapshot write failed', context, {
			event: 'availability_snapshot_write_failed',
			kind,
			serviceId,
			scope,
			error: describeLogValue(error),
		});
	}
};

const enqueueAvailabilityPrewarmJob = (
	context: RequestContext,
	options: {
		readonly kind: AvailabilitySnapshotKind;
		readonly serviceId: string;
		readonly serviceName?: string;
		readonly scope: string;
	},
) => {
	const idempotencyKey = [
		'availability-prewarm',
		ACUITY_BASE_URL,
		options.kind,
		options.serviceId,
		options.scope,
	].join(':');

	const job: BridgeJobCommand =
		options.kind === 'dates'
			? {
					kind: 'availability_dates_refresh',
					command: {
						serviceId: options.serviceId,
						serviceName: options.serviceName,
						month: options.scope,
						adapterProfile: adapterProfile(),
					},
				}
			: {
					kind: 'availability_slots_refresh',
					command: {
						serviceId: options.serviceId,
						serviceName: options.serviceName,
						date: options.scope,
						adapterProfile: adapterProfile(),
					},
				};

	void bridgeAsyncStore
		.enqueueJob(job, { idempotencyKey, ...acuityFlowEnqueuePinning(job.kind) })
		.then((record) => {
			logRequestEvent('INFO', 'Availability prewarm job enqueued', context, {
				event: 'availability_prewarm_job_enqueued',
				operationId: record.operationId,
				status: record.status,
				kind: options.kind,
				serviceId: options.serviceId,
				scope: options.scope,
			});
		})
		.catch((error) => {
			logRequestEvent('WARN', 'Availability prewarm enqueue failed', context, {
				event: 'availability_prewarm_enqueue_failed',
				kind: options.kind,
				serviceId: options.serviceId,
				scope: options.scope,
				error: describeLogValue(error),
			});
		});
};

type AvailabilitySnapshotFreshness = 'fresh' | 'stale' | 'expired';
type AvailabilitySnapshotReadMiss = 'missing' | 'expired' | 'error';

interface AvailabilitySnapshotLayerHit<A extends readonly unknown[]> {
	readonly ok: true;
	readonly freshness: Exclude<AvailabilitySnapshotFreshness, 'expired'>;
	readonly snapshot: AvailabilitySnapshot;
	readonly result: { readonly ok: true; readonly value: A };
	readonly durationMs: number;
}

interface AvailabilitySnapshotLayerMiss {
	readonly ok: false;
	readonly reason: AvailabilitySnapshotReadMiss;
	readonly snapshot?: AvailabilitySnapshot;
	readonly durationMs: number;
	readonly error?: unknown;
}

const classifyAvailabilitySnapshotFreshness = (
	snapshot: AvailabilitySnapshot,
	now = new Date(),
): AvailabilitySnapshotFreshness => {
	const nowMs = now.getTime();
	const expiresAtMs = Date.parse(snapshot.expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return 'expired';
	}

	const staleAtMs = Date.parse(snapshot.staleAt);
	return Number.isFinite(staleAtMs) && staleAtMs > nowMs ? 'fresh' : 'stale';
};

const classifyAvailabilityReadinessFreshness = (
	snapshot: AvailabilitySnapshot | null,
	now: Date,
	freshnessFloorMs: number,
): AvailabilityReadinessFreshness => {
	if (!snapshot) return 'missing';
	const nowMs = now.getTime();
	const expiresAtMs = Date.parse(snapshot.expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
		return 'expired';
	}
	const observedAtMs = Date.parse(snapshot.observedAt);
	if (!Number.isFinite(observedAtMs)) return 'stale';
	return nowMs - observedAtMs <= freshnessFloorMs ? 'fresh' : 'stale';
};

const snapshotAgeMs = (
	snapshot: AvailabilitySnapshot | null,
	now: Date,
): number | undefined => {
	if (!snapshot) return undefined;
	const observedAtMs = Date.parse(snapshot.observedAt);
	if (!Number.isFinite(observedAtMs)) return undefined;
	return Math.max(0, now.getTime() - observedAtMs);
};

const wait = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const notFoundInternalEndpoint = (res: ServerResponse) =>
	sendJson(res, 404, {
		success: false,
		error: {
			tag: 'InfrastructureError',
			code: 'NOT_FOUND',
			message: 'Not found',
		},
	});

const parseReadinessPolicy = (body: Record<string, unknown>) => ({
	snapshotFreshnessFloorMs: parsePositiveMs(
		body.snapshotFreshnessFloorMs,
		READINESS_DEFAULT_FRESHNESS_FLOOR_MS,
	),
	maxOldestQueuedAgeMs: parsePositiveMs(
		body.maxOldestQueuedAgeMs,
		READINESS_DEFAULT_MAX_OLDEST_QUEUED_AGE_MS,
	),
});

const evaluateAvailabilityReadiness = async (
	candidates: readonly AvailabilityHeartbeatCandidate[],
	policy: {
		readonly snapshotFreshnessFloorMs: number;
		readonly maxOldestQueuedAgeMs: number;
	},
	now = new Date(),
): Promise<AvailabilityReadinessResponse> => {
	const scopes: AvailabilityReadinessScope[] = [];
	const blockers: string[] = [];

	for (const candidate of candidates) {
		const snapshot = await bridgeAsyncStore.getAvailabilitySnapshot({
			kind: candidate.kind,
			serviceId: candidate.serviceId,
			scope: candidate.scope,
			baseUrl: ACUITY_BASE_URL,
		});
		const freshness = classifyAvailabilityReadinessFreshness(
			snapshot,
			now,
			policy.snapshotFreshnessFloorMs,
		);
		const ageMs = snapshotAgeMs(snapshot, now);
		const scopeBlockers =
			freshness === 'fresh' ? [] : [`snapshot_${freshness}`];
		recordAvailabilityReadinessScope(candidate.kind, freshness);
		setAvailabilitySnapshotAge(
			candidate.kind,
			candidate.serviceId,
			candidate.scope,
			ageMs,
		);
		if (scopeBlockers.length > 0) {
			blockers.push(
				`${candidate.kind}:${candidate.serviceId}:${candidate.scope}:${freshness}`,
			);
		}
		scopes.push({
			kind: candidate.kind,
			serviceId: candidate.serviceId,
			serviceName: candidate.serviceName,
			scope: candidate.scope,
			weight: candidate.weight,
			freshness,
			ready: freshness === 'fresh',
			blockers: scopeBlockers,
			ageMs,
			valueCount: snapshot?.value.length,
			snapshot: snapshot
				? {
						snapshotId: snapshot.snapshotId,
						version: snapshot.version,
						observedAt: snapshot.observedAt,
						staleAt: snapshot.staleAt,
						expiresAt: snapshot.expiresAt,
						sourceJobId: snapshot.sourceJobId,
					}
				: undefined,
		});
	}

	const queue = await bridgeAsyncStore.getQueueStats(now);
	for (const bucket of queue.byKindStatus) {
		setBridgeQueueDepth(bucket.kind, bucket.status, bucket.count);
		setBridgeQueueOldestAge(bucket.kind, bucket.oldestAgeMs);
	}
	if (
		queue.oldestQueuedAgeMs !== undefined &&
		queue.oldestQueuedAgeMs > policy.maxOldestQueuedAgeMs
	) {
		blockers.push(`queue_oldest_age:${queue.oldestQueuedAgeMs}`);
	}
	const ready = blockers.length === 0 && scopes.every((scope) => scope.ready);
	recordAvailabilityReadinessCheck(ready);

	return {
		layer: 'bridge_availability_readiness',
		ready,
		checkedAt: now.toISOString(),
		policy,
		considered: scopes.length,
		scopes,
		queue,
		blockers,
	};
};

const readAvailabilitySnapshotLayer = async <A extends readonly unknown[]>(
	context: RequestContext,
	options: {
		readonly kind: AvailabilitySnapshotKind;
		readonly serviceId: string;
		readonly serviceName?: string;
		readonly scope: string;
		readonly enqueueRefreshOnStale?: boolean;
	},
): Promise<AvailabilitySnapshotLayerHit<A> | AvailabilitySnapshotLayerMiss> => {
	const startedAt = Date.now();
	try {
		const snapshot = await bridgeAsyncStore.getAvailabilitySnapshot({
			kind: options.kind,
			serviceId: options.serviceId,
			scope: options.scope,
			baseUrl: ACUITY_BASE_URL,
		});
		if (!snapshot) {
			const durationMs = Date.now() - startedAt;
			recordAvailabilitySnapshotRead(
				options.kind,
				'missing',
				'miss',
				durationMs,
			);
			return { ok: false, reason: 'missing', durationMs };
		}

		const freshness = classifyAvailabilitySnapshotFreshness(snapshot);
		logRequestEvent('INFO', 'Availability snapshot considered', context, {
			event: 'availability_snapshot_considered',
			kind: options.kind,
			serviceId: options.serviceId,
			scope: options.scope,
			freshness,
			version: snapshot.version,
			observedAt: snapshot.observedAt,
			staleAt: snapshot.staleAt,
			expiresAt: snapshot.expiresAt,
		});

		const durationMs = Date.now() - startedAt;
		if (freshness === 'expired') {
			recordAvailabilitySnapshotRead(
				options.kind,
				'expired',
				'miss',
				durationMs,
			);
			return { ok: false, reason: 'expired', snapshot, durationMs };
		}

		recordAvailabilitySnapshotServed(options.kind, freshness);
		recordAvailabilitySnapshotRead(options.kind, freshness, 'hit', durationMs);
		if (freshness === 'stale' && options.enqueueRefreshOnStale !== false) {
			enqueueAvailabilityPrewarmJob(context, options);
		}

		return {
			ok: true,
			freshness,
			snapshot,
			result: { ok: true, value: snapshot.value as A },
			durationMs,
		};
	} catch (error) {
		const durationMs = Date.now() - startedAt;
		recordAvailabilitySnapshotRead(options.kind, 'error', 'error', durationMs);
		logRequestEvent('WARN', 'Availability snapshot read failed', context, {
			event: 'availability_snapshot_read_failed',
			kind: options.kind,
			serviceId: options.serviceId,
			scope: options.scope,
			error: describeLogValue(error),
		});
		return { ok: false, reason: 'error', durationMs, error };
	}
};

const readUsableAvailabilitySnapshot = async <A extends readonly unknown[]>(
	context: RequestContext,
	options: {
		readonly kind: AvailabilitySnapshotKind;
		readonly serviceId: string;
		readonly serviceName?: string;
		readonly scope: string;
	},
): Promise<Result<A> | null> => {
	const snapshot = await readAvailabilitySnapshotLayer<A>(context, options);
	return snapshot.ok ? snapshot.result : null;
};

const scheduleDatePrewarm = (
	context: RequestContext,
	serviceId: string,
	serviceName: string | undefined,
	currentMonth: string | undefined,
): void => {
	if (
		!redisClient ||
		DATE_PREWARM_MONTHS <= 0 ||
		!isAcuityAppointmentTypeId(serviceId)
	) {
		return;
	}

	for (const month of selectDatePrewarmMonths(
		currentMonth,
		DATE_PREWARM_MONTHS,
	)) {
		enqueueAvailabilityPrewarmJob(context, {
			kind: 'dates',
			serviceId,
			serviceName,
			scope: month,
		});
	}
};

const scheduleSlotPrewarm = (
	context: RequestContext,
	serviceId: string,
	serviceName: string | undefined,
	dates: readonly { date?: unknown }[],
): void => {
	if (
		!redisClient ||
		SLOT_PREWARM_LIMIT <= 0 ||
		!isAcuityAppointmentTypeId(serviceId)
	) {
		return;
	}

	const prewarmDates = selectSlotPrewarmDates(dates, SLOT_PREWARM_LIMIT);
	if (prewarmDates.length === 0) return;

	logRequestEvent('INFO', 'Availability slot prewarm queued', context, {
		event: 'availability_slot_prewarm_queued',
		serviceId,
		dates: prewarmDates,
		limit: SLOT_PREWARM_LIMIT,
	});

	for (const date of prewarmDates) {
		enqueueAvailabilityPrewarmJob(context, {
			kind: 'slots',
			serviceId,
			serviceName,
			scope: date,
		});
	}
};

// =============================================================================
// ROUTE HANDLERS
// =============================================================================

/** The L2 Redis key used by the service catalog (must match acuity-service-catalog.ts). */
const CATALOG_REDIS_KEY = `acuity:services:v1:${ACUITY_BASE_URL}`;

/**
 * Real-liveness readiness handler wired to the module-level singletons.
 *
 * Checks:
 *  1. Redis ping
 *  2. Browser pool `isConnected()` via BrowserProcess Effect service
 *  3. Catalog has data in L1 (getCachedCount) or L2 (Redis EXISTS)
 *  4. If Redis + browser pass but catalog is cold, one bounded catalog warmup
 *
 * Returns HTTP 200 when all pass; 503 otherwise.
 */
const handleReady = (res: ServerResponse) =>
	_handleReady(res, {
		redisPing: redisClient ? () => redisClient!.ping() : null,
		browserConnected: () =>
			browserRuntime.runPromise(
				BrowserProcess.pipe(Effect.map(({ browser }) => browser.isConnected())),
			),
		catalogL1Count: () => serviceCatalog.getCachedCount(),
		catalogL2Exists: redisClient
			? () => redisClient!.exists(CATALOG_REDIS_KEY)
			: null,
		catalogWarm: async () => (await serviceCatalog.getServices()).length,
	});

const handleHealth = (_req: IncomingMessage, res: ServerResponse) => {
	sendSuccess(
		res,
		buildHealthPayload({
			baseUrl: ACUITY_BASE_URL,
			hasCoupon: !!COUPON_CODE,
			headless: browserConfig.headless,
			staticServices: serviceCatalog.staticServicesCount,
			serviceCacheTtlMs: SERVICE_CACHE_TTL_MS,
			releaseSha: process.env.MIDDLEWARE_RELEASE_SHA,
			releaseRef: process.env.MIDDLEWARE_RELEASE_REF,
			releaseVersion:
				process.env.MIDDLEWARE_RELEASE_VERSION ??
				process.env.npm_package_version,
			releaseBuiltAt:
				process.env.MIDDLEWARE_RELEASE_BUILT_AT ??
				process.env.MIDDLEWARE_BUILD_TIMESTAMP,
			modalEnvironment: process.env.MODAL_ENVIRONMENT,
		}),
	);
};

const handleGetServices = async (
	_req: IncomingMessage,
	res: ServerResponse,
) => {
	try {
		const services = await serviceCatalog.getServices();
		sendSuccess(res, services);
	} catch (error) {
		if (isSchedulingError(error)) {
			return sendError(res, 500, error);
		}
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message:
					error instanceof Error ? error.message : 'Service lookup failed',
			},
		});
	}
};

const handleGetService = async (serviceId: string, res: ServerResponse) => {
	try {
		const found = await serviceCatalog.getService(serviceId);
		if (!found) {
			return sendJson(res, 404, {
				success: false,
				error: {
					tag: 'AcuityError',
					code: 'NOT_FOUND',
					message: `Service ${serviceId} not found`,
				},
			});
		}
		sendSuccess(res, found);
	} catch (error) {
		if (isSchedulingError(error)) {
			return sendError(res, 500, error);
		}
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message:
					error instanceof Error ? error.message : 'Service lookup failed',
			},
		});
	}
};

const handleAvailableDates = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const rawBody = await parseBody(req);
	if (!isRecord(rawBody) || !isNonEmptyString(rawBody.serviceId)) {
		return sendValidationError(res, 'serviceId', 'serviceId is required');
	}
	const serviceName = optionalString(rawBody.serviceName);
	if (serviceName === null) {
		return sendValidationError(
			res,
			'serviceName',
			'serviceName must be a string',
		);
	}
	const startDate = optionalString(rawBody.startDate);
	if (startDate === null) {
		return sendValidationError(res, 'startDate', 'startDate must be a string');
	}
	const body = { serviceId: rawBody.serviceId, serviceName, startDate };
	const targetMonth = body.startDate?.slice(0, 7);
	logRequestEvent('INFO', 'Availability dates requested', context, {
		event: 'availability_dates_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		startDate: body.startDate,
	});
	const cacheKey = buildAvailabilityDatesCacheKey(
		ACUITY_BASE_URL,
		body.serviceId,
		targetMonth ?? 'current',
	);
	let observedFreshAvailability = false;
	let cacheReadResult = true;
	const result = await runCachedBridgeRead(
		context,
		'availability_dates',
		cacheKey,
		async () => {
			const snapshot = await readUsableAvailabilitySnapshot<
				readonly AvailableDate[]
			>(context, {
				kind: 'dates',
				serviceId: body.serviceId,
				serviceName: body.serviceName,
				scope: targetMonth ?? 'current',
			});
			if (snapshot) {
				cacheReadResult = false;
				return snapshot;
			}

			observedFreshAvailability = true;
			cacheReadResult = true;
			return isAcuityAppointmentTypeId(body.serviceId)
				? runEffect(acuitySteps.readDatesViaUrl(body.serviceId, targetMonth))
				: (async () => {
						const serviceName = await resolveServiceName(
							body.serviceId,
							body.serviceName,
						);
						logRequestEvent(
							'INFO',
							'Availability dates resolved service name',
							context,
							{
								event: 'availability_dates_resolved_service',
								serviceId: body.serviceId,
								serviceName,
								startDate: body.startDate,
							},
						);
						return runEffect(
							acuitySteps.readAvailableDates({
								serviceName,
								targetMonth,
								monthsToScan: 2,
							}),
						);
					})();
		},
		() => cacheReadResult,
	);

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability dates request failed', context, {
			event: 'availability_dates_failed',
			serviceId: body.serviceId,
			startDate: body.startDate,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage:
				'message' in err
					? (err as { message: string }).message
					: 'Availability lookup failed',
		});
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: err._tag ?? 'InfrastructureError',
				code: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
				message:
					'message' in err
						? (err as { message: string }).message
						: 'Availability lookup failed',
			},
		});
	}
	if (observedFreshAvailability) {
		await recordAvailabilitySnapshot(
			'dates',
			body.serviceId,
			targetMonth ?? 'current',
			Array.isArray(result.value) ? result.value : [],
			context,
		);
	}
	scheduleDatePrewarm(context, body.serviceId, body.serviceName, targetMonth);
	scheduleSlotPrewarm(context, body.serviceId, body.serviceName, result.value);
	sendSuccess(res, result.value);
};

const handleAvailableSlots = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const rawBody = await parseBody(req);
	if (!isRecord(rawBody) || !isNonEmptyString(rawBody.serviceId)) {
		return sendValidationError(res, 'serviceId', 'serviceId is required');
	}
	if (!isNonEmptyString(rawBody.date)) {
		return sendValidationError(res, 'date', 'date is required');
	}
	const serviceName = optionalString(rawBody.serviceName);
	if (serviceName === null) {
		return sendValidationError(
			res,
			'serviceName',
			'serviceName must be a string',
		);
	}
	const body = {
		serviceId: rawBody.serviceId,
		serviceName,
		date: rawBody.date,
	};
	logRequestEvent('INFO', 'Availability slots requested', context, {
		event: 'availability_slots_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		date: body.date,
	});
	const cacheKey = buildAvailabilitySlotsCacheKey(
		ACUITY_BASE_URL,
		body.serviceId,
		body.date,
	);
	let observedFreshAvailability = false;
	let cacheReadResult = true;
	const result = await runCachedBridgeRead(
		context,
		'availability_slots',
		cacheKey,
		async () => {
			const snapshot = await readUsableAvailabilitySnapshot<
				readonly TimeSlot[]
			>(context, {
				kind: 'slots',
				serviceId: body.serviceId,
				serviceName: body.serviceName,
				scope: body.date,
			});
			if (snapshot) {
				cacheReadResult = false;
				return snapshot;
			}

			observedFreshAvailability = true;
			cacheReadResult = true;
			return isAcuityAppointmentTypeId(body.serviceId)
				? runEffect(
						acuitySteps.readSlotsViaUrl(
							body.serviceId,
							body.date,
							createSlotReadTelemetryContext(context, 'availability_slots'),
						),
					)
				: (async () => {
						const serviceName = await resolveServiceName(
							body.serviceId,
							body.serviceName,
						);
						logRequestEvent(
							'INFO',
							'Availability slots resolved service name',
							context,
							{
								event: 'availability_slots_resolved_service',
								serviceId: body.serviceId,
								serviceName,
								date: body.date,
							},
						);
						return runEffect(
							acuitySteps.readTimeSlots({
								serviceName,
								date: body.date,
							}),
						);
					})();
		},
		() => cacheReadResult,
	);

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability slots request failed', context, {
			event: 'availability_slots_failed',
			serviceId: body.serviceId,
			date: body.date,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage:
				'message' in err
					? (err as { message: string }).message
					: 'Slot lookup failed',
		});
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: err._tag ?? 'InfrastructureError',
				code: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
				message:
					'message' in err
						? (err as { message: string }).message
						: 'Slot lookup failed',
			},
		});
	}
	if (observedFreshAvailability) {
		await recordAvailabilitySnapshot(
			'slots',
			body.serviceId,
			body.date,
			Array.isArray(result.value) ? result.value : [],
			context,
		);
	}
	sendSuccess(res, result.value);
};

const handleCheckSlot = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const body = (await parseBody(req)) as {
		serviceId: string;
		serviceName?: string;
		datetime: string;
	};
	const date = body.datetime.split('T')[0];
	logRequestEvent('INFO', 'Availability check requested', context, {
		event: 'availability_check_requested',
		serviceId: body.serviceId,
		serviceName: body.serviceName,
		datetime: body.datetime,
	});
	const result = isAcuityAppointmentTypeId(body.serviceId)
		? await runEffect(
				acuitySteps.readSlotsViaUrl(
					body.serviceId,
					date,
					createSlotReadTelemetryContext(context, 'availability_check'),
				),
			)
		: await (async () => {
				const serviceName = await resolveServiceName(
					body.serviceId,
					body.serviceName,
				);
				return runEffect(
					acuitySteps.readTimeSlots({
						serviceName,
						date,
					}),
				);
			})();

	if (!result.ok) {
		const err = result.error;
		logRequestEvent('ERROR', 'Availability check failed', context, {
			event: 'availability_check_failed',
			serviceId: body.serviceId,
			datetime: body.datetime,
			errorTag: err._tag,
			errorCode: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
			errorMessage:
				'message' in err
					? (err as { message: string }).message
					: 'Slot check failed',
		});
		return sendJson(res, 500, {
			success: false,
			error: {
				tag: err._tag ?? 'InfrastructureError',
				code: 'code' in err ? (err as { code: string }).code : 'UNKNOWN',
				message:
					'message' in err
						? (err as { message: string }).message
						: 'Slot check failed',
			},
		});
	}
	const available = result.value.some(
		(s: { datetime: string; available: boolean }) =>
			s.datetime === body.datetime && s.available,
	);
	sendSuccess(res, available);
};

const handleCreateBooking = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const body = (await parseBody(req)) as {
		request: BookingRequest;
		couponCode?: string;
	};
	const { request } = body;

	const serviceName = await resolveServiceName(request.serviceId);
	logRequestEvent('INFO', 'Booking create requested', context, {
		event: 'booking_create_requested',
		serviceId: request.serviceId,
		datetime: request.datetime,
	});

	const result = await runEffect(
		Effect.gen(function* () {
			yield* acuitySteps.navigateToBooking({
				serviceName: serviceName ?? request.serviceId,
				datetime: request.datetime,
				client: request.client,
				appointmentTypeId: request.serviceId,
			});
			yield* acuitySteps.fillFormFields({
				client: request.client,
				customFields: request.client.customFields,
			});
			yield* acuitySteps.submitBooking();
			const confirmation = yield* acuitySteps.extractConfirmation();
			return acuitySteps.toBooking(confirmation, request, '', 'acuity');
		}),
	);

	if (!result.ok) {
		logRequestEvent('ERROR', 'Booking create failed', context, {
			event: 'booking_create_failed',
			serviceId: request.serviceId,
			datetime: request.datetime,
			errorTag: result.error._tag,
			errorCode: 'code' in result.error ? result.error.code : 'UNKNOWN',
			errorMessage:
				'message' in result.error
					? result.error.message
					: 'Booking create failed',
		});
		return sendError(res, 500, result.error);
	}
	sendSuccess(res, result.value);
};

const handleDeprecatedSyncPaymentBooking = (res: ServerResponse) =>
	sendJson(res, 410, {
		success: false,
		error: {
			tag: 'Deprecated',
			code: 'ASYNC_REQUIRED',
			message: 'Use POST /booking/jobs and poll GET /jobs/:operationId',
		},
	});

const handleEnqueueBookingJob = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const rawBody = await parseBody(req);
	if (!isRecord(rawBody)) {
		return sendValidationError(res, 'body', 'Request body must be an object');
	}
	if (!isRecord(rawBody.request)) {
		return sendValidationError(res, 'request', 'request is required');
	}
	if (!isNonEmptyString(rawBody.paymentRef)) {
		return sendValidationError(res, 'paymentRef', 'paymentRef is required');
	}
	if (!isNonEmptyString(rawBody.paymentProcessor)) {
		return sendValidationError(
			res,
			'paymentProcessor',
			'paymentProcessor is required',
		);
	}
	const coupon = optionalString(rawBody.couponCode) ?? COUPON_CODE;
	const profile = adapterProfile();
	const couponBypassRequired = Boolean(coupon) || !profile.adminApiConfigured;
	if (couponBypassRequired && !coupon) {
		return sendJson(res, 400, {
			success: false,
			error: {
				tag: 'ValidationError',
				code: 'couponCode',
				message: 'Coupon code is required for payment bypass',
			},
		});
	}
	const idempotencyKey = optionalString(rawBody.idempotencyKey) ?? undefined;
	const request = rawBody.request as unknown as BookingRequest;
	const serviceName = await resolveServiceName(request.serviceId);
	const job: BridgeJobCommand = {
		kind: 'booking_create_with_payment',
		command: {
			request,
			paymentRef: rawBody.paymentRef,
			paymentProcessor: rawBody.paymentProcessor,
			couponCode: coupon,
			serviceName,
			adapterProfile: profile,
			couponBypassRequired,
			executionPreference: 'auto',
		},
	};
	const record = await bridgeAsyncStore.enqueueJob(job, {
		idempotencyKey,
		...acuityFlowEnqueuePinning(job.kind),
	});

	logRequestEvent('INFO', 'Booking async job enqueued', context, {
		event: 'booking_job_enqueued',
		operationId: record.operationId,
		status: record.status,
		serviceId: request.serviceId,
		datetime: request.datetime,
		idempotent: Boolean(idempotencyKey),
	});

	return sendAccepted(res, toEnqueueResponse(record));
};

const handleEnqueueAvailabilityRefresh = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	const rawBody = await parseBody(req);
	if (!isRecord(rawBody)) {
		return sendValidationError(res, 'body', 'Request body must be an object');
	}
	const kind = rawBody.kind;
	if (kind !== 'dates' && kind !== 'slots') {
		return sendValidationError(res, 'kind', 'kind must be "dates" or "slots"');
	}
	if (!isNonEmptyString(rawBody.serviceId)) {
		return sendValidationError(res, 'serviceId', 'serviceId is required');
	}
	const serviceName = optionalString(rawBody.serviceName);
	if (serviceName === null) {
		return sendValidationError(
			res,
			'serviceName',
			'serviceName must be a string',
		);
	}

	const idempotencyKeyOverride = optionalString(rawBody.idempotencyKey);
	if (idempotencyKeyOverride === null) {
		return sendValidationError(
			res,
			'idempotencyKey',
			'idempotencyKey must be a string',
		);
	}

	const month = rawBody.month;
	const date = rawBody.date;
	if (kind === 'dates' && !isNonEmptyString(month)) {
		return sendValidationError(
			res,
			'month',
			'month is required for date refresh jobs',
		);
	}
	if (kind === 'slots' && !isNonEmptyString(date)) {
		return sendValidationError(
			res,
			'date',
			'date is required for slot refresh jobs',
		);
	}

	const idempotencyKey =
		idempotencyKeyOverride ??
		[
			'availability-refresh',
			ACUITY_BASE_URL,
			kind,
			rawBody.serviceId,
			kind === 'dates' ? month : date,
		].join(':');

	const job: BridgeJobCommand =
		kind === 'dates'
			? {
					kind: 'availability_dates_refresh',
					command: {
						serviceId: rawBody.serviceId,
						serviceName,
						month: month as string,
						adapterProfile: adapterProfile(),
					},
				}
			: {
					kind: 'availability_slots_refresh',
					command: {
						serviceId: rawBody.serviceId,
						serviceName,
						date: date as string,
						adapterProfile: adapterProfile(),
					},
				};

	const record = await bridgeAsyncStore.enqueueJob(job, {
		idempotencyKey,
		...acuityFlowEnqueuePinning(job.kind),
	});

	logRequestEvent('INFO', 'Availability refresh job enqueued', context, {
		event: 'availability_refresh_enqueued',
		operationId: record.operationId,
		status: record.status,
		kind: record.kind,
		serviceId: rawBody.serviceId,
	});

	return sendAccepted(res, toEnqueueResponse(record));
};

const runAvailabilityHeartbeat = async (
	candidates: readonly AvailabilityHeartbeatCandidate[],
	options: {
		readonly maxJobs: number;
		readonly idempotencyWindowMs: number;
		readonly idempotencyKeyPrefix?: string;
		readonly snapshotFreshnessFloorMs?: number;
		readonly context: RequestContext;
	},
): Promise<AvailabilityHeartbeatResponse> => {
	const idempotencyBucket = heartbeatIdempotencyBucket(
		options.idempotencyWindowMs,
	);
	const idempotencyPrefix =
		options.idempotencyKeyPrefix ?? 'availability-heartbeat';
	const enqueued: AvailabilityHeartbeatJob[] = [];
	const skipped: AvailabilityHeartbeatSkipped[] = [];
	let submittedJobs = 0;

	for (const candidate of candidates) {
		const snapshot = await bridgeAsyncStore.getAvailabilitySnapshot({
			kind: candidate.kind,
			serviceId: candidate.serviceId,
			scope: candidate.scope,
			baseUrl: ACUITY_BASE_URL,
		});
		const freshness = snapshot
			? options.snapshotFreshnessFloorMs === undefined
				? classifyAvailabilitySnapshotFreshness(snapshot)
				: classifyAvailabilityReadinessFreshness(
						snapshot,
						new Date(),
						options.snapshotFreshnessFloorMs,
					)
			: 'missing';

		if (freshness === 'fresh') {
			recordAvailabilityHeartbeatJob(candidate.kind, 'skipped_fresh');
			skipped.push({
				kind: candidate.kind,
				serviceId: candidate.serviceId,
				scope: candidate.scope,
				reason: 'fresh',
				freshness,
				weight: candidate.weight,
			});
			continue;
		}

		if (submittedJobs >= options.maxJobs) {
			recordAvailabilityHeartbeatJob(candidate.kind, 'skipped_limit');
			skipped.push({
				kind: candidate.kind,
				serviceId: candidate.serviceId,
				scope: candidate.scope,
				reason: 'limit',
				weight: candidate.weight,
			});
			continue;
		}

		const job: BridgeJobCommand =
			candidate.kind === 'dates'
				? {
						kind: 'availability_dates_refresh',
						command: {
							serviceId: candidate.serviceId,
							serviceName: candidate.serviceName,
							month: candidate.scope,
							adapterProfile: adapterProfile(),
						},
					}
				: {
						kind: 'availability_slots_refresh',
						command: {
							serviceId: candidate.serviceId,
							serviceName: candidate.serviceName,
							date: candidate.scope,
							adapterProfile: adapterProfile(),
						},
					};
		const idempotencyKey = [
			idempotencyPrefix,
			ACUITY_BASE_URL,
			candidate.kind,
			candidate.serviceId,
			candidate.scope,
			idempotencyBucket,
		].join(':');
		const enqueueStartedAt = Date.now();
		let record = await bridgeAsyncStore.enqueueJob(job, {
			idempotencyKey,
			...acuityFlowEnqueuePinning(job.kind),
		});
		let action: AvailabilityHeartbeatJob['action'] =
			Date.parse(record.createdAt) < enqueueStartedAt ? 'deduped' : 'queued';
		if (isRetryableHeartbeatFailure(record)) {
			const requeued = await bridgeAsyncStore.requeueJob(record.operationId);
			if (!requeued) {
				recordAvailabilityHeartbeatJob(candidate.kind, 'requeue_failed');
				skipped.push({
					kind: candidate.kind,
					serviceId: candidate.serviceId,
					scope: candidate.scope,
					reason: 'requeue_failed',
					weight: candidate.weight,
					status: record.status,
					operationId: record.operationId,
					statusUrl: jobStatusUrl(record.operationId),
				});
				continue;
			}
			record = requeued;
			action = 'requeued';
		}
		if (action === 'deduped' && record.status === 'succeeded') {
			const requeued = await bridgeAsyncStore.requeueJob(record.operationId);
			if (!requeued) {
				recordAvailabilityHeartbeatJob(candidate.kind, 'requeue_failed');
				skipped.push({
					kind: candidate.kind,
					serviceId: candidate.serviceId,
					scope: candidate.scope,
					reason: 'requeue_failed',
					weight: candidate.weight,
					status: record.status,
					operationId: record.operationId,
					statusUrl: jobStatusUrl(record.operationId),
				});
				continue;
			}
			record = requeued;
			action = 'requeued';
		}
		if (action !== 'deduped') {
			submittedJobs += 1;
		}
		if (!heartbeatRunnableStatuses.has(record.status)) {
			recordAvailabilityHeartbeatJob(candidate.kind, 'skipped_terminal');
			skipped.push({
				kind: candidate.kind,
				serviceId: candidate.serviceId,
				scope: candidate.scope,
				reason: 'terminal',
				weight: candidate.weight,
				status: record.status,
				operationId: record.operationId,
				statusUrl: jobStatusUrl(record.operationId),
			});
			continue;
		}
		recordAvailabilityHeartbeatJob(candidate.kind, action);
		enqueued.push({
			operationId: record.operationId,
			status: record.status,
			statusUrl: jobStatusUrl(record.operationId),
			action,
			kind: candidate.kind,
			serviceId: candidate.serviceId,
			scope: candidate.scope,
			freshness,
			weight: candidate.weight,
		});
	}

	logRequestEvent('INFO', 'Availability heartbeat completed', options.context, {
		event: 'availability_heartbeat_completed',
		considered: candidates.length,
		enqueued: enqueued.length,
		skipped: skipped.length,
		maxJobs: options.maxJobs,
		idempotencyWindowMs: options.idempotencyWindowMs,
	});

	return {
		layer: 'bridge_availability_heartbeat',
		considered: candidates.length,
		enqueued,
		skipped,
		maxJobs: options.maxJobs,
		idempotencyWindowMs: options.idempotencyWindowMs,
	};
};

const handleAvailabilityHeartbeat = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	if (!AUTH_TOKEN) {
		return notFoundInternalEndpoint(res);
	}

	const rawBody = await parseBody(req);
	if (!isRecord(rawBody)) {
		return sendValidationError(res, 'body', 'Request body must be an object');
	}

	const candidates = collectHeartbeatCandidates(rawBody);
	if (!candidates.ok) {
		return sendValidationError(res, candidates.field, candidates.message);
	}

	const idempotencyKeyPrefix = optionalString(rawBody.idempotencyKeyPrefix);
	if (idempotencyKeyPrefix === null) {
		return sendValidationError(
			res,
			'idempotencyKeyPrefix',
			'idempotencyKeyPrefix must be a string',
		);
	}

	const maxJobs = parsePositiveInteger(
		rawBody.maxJobs,
		HEARTBEAT_DEFAULT_MAX_JOBS,
		HEARTBEAT_MAX_JOBS_CAP,
	);
	const idempotencyWindowMs = parsePositiveMs(
		rawBody.idempotencyWindowMs,
		HEARTBEAT_DEFAULT_IDEMPOTENCY_WINDOW_MS,
	);
	const snapshotFreshnessFloorMs = parsePositiveMs(
		rawBody.snapshotFreshnessFloorMs,
		READINESS_DEFAULT_FRESHNESS_FLOOR_MS,
	);

	const response = await runAvailabilityHeartbeat(candidates.value, {
		maxJobs,
		idempotencyWindowMs,
		idempotencyKeyPrefix,
		snapshotFreshnessFloorMs,
		context,
	});
	return sendAccepted(res, response);
};

const parseAvailabilityReadinessRequest = async (
	req: IncomingMessage,
): Promise<
	| {
			readonly ok: true;
			readonly body: Record<string, unknown>;
			readonly candidates: readonly AvailabilityHeartbeatCandidate[];
	  }
	| { readonly ok: false; readonly field: string; readonly message: string }
> => {
	const rawBody = await parseBody(req);
	if (!isRecord(rawBody)) {
		return {
			ok: false,
			field: 'body',
			message: 'Request body must be an object',
		};
	}
	const candidates = collectHeartbeatCandidates(rawBody);
	if (!candidates.ok) return candidates;
	return {
		ok: true,
		body: rawBody,
		candidates: candidates.value,
	};
};

const handleAvailabilityReadiness = async (
	req: IncomingMessage,
	res: ServerResponse,
) => {
	if (!AUTH_TOKEN) {
		return notFoundInternalEndpoint(res);
	}
	const parsed = await parseAvailabilityReadinessRequest(req);
	if (!parsed.ok) {
		return sendValidationError(res, parsed.field, parsed.message);
	}
	const readiness = await evaluateAvailabilityReadiness(
		parsed.candidates,
		parseReadinessPolicy(parsed.body),
	);
	return sendJson(res, readiness.ready ? 200 : 409, {
		success: true,
		data: readiness,
	});
};

const handleAvailabilityWaitReady = async (
	req: IncomingMessage,
	res: ServerResponse,
	context: RequestContext,
) => {
	if (!AUTH_TOKEN) {
		return notFoundInternalEndpoint(res);
	}
	const parsed = await parseAvailabilityReadinessRequest(req);
	if (!parsed.ok) {
		return sendValidationError(res, parsed.field, parsed.message);
	}
	const idempotencyKeyPrefix = optionalString(parsed.body.idempotencyKeyPrefix);
	if (idempotencyKeyPrefix === null) {
		return sendValidationError(
			res,
			'idempotencyKeyPrefix',
			'idempotencyKeyPrefix must be a string',
		);
	}
	const maxJobs = parsePositiveInteger(
		parsed.body.maxJobs,
		HEARTBEAT_DEFAULT_MAX_JOBS,
		HEARTBEAT_MAX_JOBS_CAP,
	);
	const idempotencyWindowMs = parsePositiveMs(
		parsed.body.idempotencyWindowMs,
		HEARTBEAT_DEFAULT_IDEMPOTENCY_WINDOW_MS,
	);
	const timeoutMs = parsePositiveMs(
		parsed.body.timeoutMs,
		READINESS_WAIT_DEFAULT_TIMEOUT_MS,
	);
	const pollMs = parsePositiveMs(
		parsed.body.pollMs,
		READINESS_WAIT_DEFAULT_POLL_MS,
	);
	const policy = parseReadinessPolicy(parsed.body);
	const startedAt = Date.now();
	let attempts = 0;

	let heartbeat = await runAvailabilityHeartbeat(parsed.candidates, {
		maxJobs,
		idempotencyWindowMs,
		idempotencyKeyPrefix,
		snapshotFreshnessFloorMs: policy.snapshotFreshnessFloorMs,
		context,
	});
	let readiness = await evaluateAvailabilityReadiness(
		parsed.candidates,
		policy,
	);
	attempts += 1;
	while (!readiness.ready && Date.now() - startedAt < timeoutMs) {
		await wait(
			Math.min(pollMs, Math.max(0, timeoutMs - (Date.now() - startedAt))),
		);
		heartbeat = await runAvailabilityHeartbeat(parsed.candidates, {
			maxJobs,
			idempotencyWindowMs,
			idempotencyKeyPrefix,
			snapshotFreshnessFloorMs: policy.snapshotFreshnessFloorMs,
			context,
		});
		readiness = await evaluateAvailabilityReadiness(parsed.candidates, policy);
		attempts += 1;
	}

	const elapsedMs = Date.now() - startedAt;
	const response: AvailabilityWaitReadyResponse = {
		layer: 'bridge_availability_wait_ready',
		ready: readiness.ready,
		timedOut: !readiness.ready,
		elapsedMs,
		attempts,
		heartbeat,
		readiness,
	};
	return sendJson(res, readiness.ready ? 200 : 409, {
		success: true,
		data: response,
	});
};

const handleGetAsyncJob = async (operationId: string, res: ServerResponse) => {
	const record = await bridgeAsyncStore.getJob(operationId);
	if (!record) {
		return sendJson(res, 404, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'NOT_FOUND',
				message: `Job ${operationId} not found`,
			},
		});
	}
	return sendSuccess(res, record);
};

const handleGetAvailabilitySnapshot = async (url: URL, res: ServerResponse) => {
	const kind = url.searchParams.get('kind');
	const serviceId = url.searchParams.get('serviceId');
	const scope = url.searchParams.get('scope');
	if (kind !== 'dates' && kind !== 'slots') {
		return sendValidationError(res, 'kind', 'kind must be "dates" or "slots"');
	}
	if (!serviceId) {
		return sendValidationError(res, 'serviceId', 'serviceId is required');
	}
	if (!scope) {
		return sendValidationError(res, 'scope', 'scope is required');
	}
	const snapshot = await bridgeAsyncStore.getAvailabilitySnapshot({
		kind,
		serviceId,
		scope,
		baseUrl: ACUITY_BASE_URL,
	});
	if (!snapshot) {
		return sendJson(res, 404, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'NOT_FOUND',
				message: `No ${kind} snapshot found for ${serviceId}/${scope}`,
			},
		});
	}
	return sendSuccess(res, snapshot);
};

const handleAvailabilitySnapshotCanary = async (
	url: URL,
	res: ServerResponse,
	context: RequestContext,
) => {
	if (!AUTH_TOKEN) {
		return sendJson(res, 404, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'NOT_FOUND',
				message: 'Not found',
			},
		});
	}

	const kind = url.searchParams.get('kind');
	const serviceId = url.searchParams.get('serviceId');
	const scope = url.searchParams.get('scope');
	const serviceName = url.searchParams.get('serviceName') ?? undefined;
	if (kind !== 'dates' && kind !== 'slots') {
		return sendValidationError(res, 'kind', 'kind must be "dates" or "slots"');
	}
	if (!serviceId) {
		return sendValidationError(res, 'serviceId', 'serviceId is required');
	}
	if (!scope) {
		return sendValidationError(res, 'scope', 'scope is required');
	}

	const snapshot = await readAvailabilitySnapshotLayer<readonly unknown[]>(
		context,
		{
			kind,
			serviceId,
			serviceName,
			scope,
			enqueueRefreshOnStale: false,
		},
	);

	if (!snapshot.ok) {
		const status =
			snapshot.reason === 'expired'
				? 409
				: snapshot.reason === 'missing'
					? 404
					: 500;
		const code =
			snapshot.reason === 'expired'
				? 'SNAPSHOT_EXPIRED'
				: snapshot.reason === 'missing'
					? 'SNAPSHOT_NOT_FOUND'
					: 'SNAPSHOT_READ_FAILED';
		return sendJson(res, status, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code,
				message: `Durable ${kind} snapshot canary ${snapshot.reason} for ${serviceId}/${scope}`,
			},
		});
	}

	return sendSuccess(res, {
		layer: 'bridge_durable_snapshot',
		kind,
		serviceId,
		scope,
		freshness: snapshot.freshness,
		valueCount: snapshot.result.value.length,
		durationMs: snapshot.durationMs,
		refreshQueued: false,
		snapshot: {
			snapshotId: snapshot.snapshot.snapshotId,
			version: snapshot.snapshot.version,
			observedAt: snapshot.snapshot.observedAt,
			staleAt: snapshot.snapshot.staleAt,
			expiresAt: snapshot.snapshot.expiresAt,
			sourceJobId: snapshot.snapshot.sourceJobId,
		},
		metrics: {
			servedCounter: {
				name: 'acuity_availability_snapshot_served_total',
				labels: {
					kind,
					freshness: snapshot.freshness,
				},
			},
			durationHistogram: {
				name: 'acuity_availability_snapshot_read_duration_seconds',
				labels: {
					kind,
					freshness: snapshot.freshness,
					outcome: 'hit',
				},
			},
		},
	});
};

/**
 * GET /internal/flows — serve all registered FlowPlans as JSON (design
 * docs/design/flow-dag-formalization.md §5 "GET /internal/flows serves all
 * registered plans, auth-gated like existing /internal/* routes"). Read-only and
 * purely additive: plans are derived projections of the flow definitions
 * (src/adapters/acuity/flows.ts), never authored or mutated through this surface.
 */
const handleInternalFlows = (res: ServerResponse) => {
	if (!AUTH_TOKEN) {
		return notFoundInternalEndpoint(res);
	}
	sendSuccess(res, {
		layer: 'bridge_flow_plans',
		backend: 'acuity',
		flows: Object.values(acuityFlows).map((flow) => ({
			flowId: flow.plan.flowId,
			backend: flow.plan.backend,
			version: flow.plan.version,
			planHash: flow.planHash,
			plan: flow.plan,
		})),
	});
};

// =============================================================================
// SERVER
// =============================================================================

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method?.toUpperCase() ?? 'GET';
	const context: RequestContext = {
		requestId:
			typeof req.headers['x-request-id'] === 'string' &&
			req.headers['x-request-id'].length > 0
				? req.headers['x-request-id']
				: randomUUID(),
		method,
		path,
		startedAt: Date.now(),
	};

	res.setHeader('x-request-id', context.requestId);
	logRequestEvent('INFO', 'Request started', context, {
		event: 'request_started',
	});
	res.on('finish', () => {
		logRequestEvent('INFO', 'Request completed', context, {
			event: 'request_completed',
			statusCode: res.statusCode,
			durationMs: Date.now() - context.startedAt,
		});
	});

	// Auth check (skip health + observability endpoints)
	const unauthenticatedPaths = new Set(['/health', '/ready', '/metrics']);
	if (AUTH_TOKEN && !unauthenticatedPaths.has(path)) {
		const auth = req.headers.authorization;
		if (auth !== `Bearer ${AUTH_TOKEN}`) {
			logRequestEvent('WARN', 'Unauthorized request rejected', context, {
				event: 'request_rejected',
				reason: 'invalid_auth_token',
			});
			return sendJson(res, 401, {
				success: false,
				error: {
					tag: 'InfrastructureError',
					code: 'UNAUTHORIZED',
					message: 'Invalid auth token',
				},
			});
		}
	}

	try {
		// Observability endpoints are matched BEFORE the main dispatch so the
		// Prometheus scraper and k8s readiness probe never race with auth or
		// business-logic errors.
		if (path === '/metrics' && method === 'GET') {
			const body = await renderMetrics();
			res.writeHead(200, { 'Content-Type': metrics.registry.contentType });
			res.end(body);
			return;
		}

		if (path === '/ready' && method === 'GET') {
			return handleReady(res);
		}

		// Route matching
		if (path === '/health' && method === 'GET') {
			return handleHealth(req, res);
		}
		if (path === '/services' && method === 'GET') {
			return await handleGetServices(req, res);
		}
		if (path.startsWith('/services/') && method === 'GET') {
			const serviceId = decodeURIComponent(path.slice('/services/'.length));
			return await handleGetService(serviceId, res);
		}
		if (path === '/availability/dates' && method === 'POST') {
			return await handleAvailableDates(req, res, context);
		}
		if (path === '/availability/slots' && method === 'POST') {
			return await handleAvailableSlots(req, res, context);
		}
		if (path === '/availability/check' && method === 'POST') {
			return await handleCheckSlot(req, res, context);
		}
		if (path === '/availability/refresh' && method === 'POST') {
			return await handleEnqueueAvailabilityRefresh(req, res, context);
		}
		if (path === '/availability/snapshot' && method === 'GET') {
			return await handleGetAvailabilitySnapshot(url, res);
		}
		if (path === '/internal/availability/snapshot-canary' && method === 'GET') {
			return await handleAvailabilitySnapshotCanary(url, res, context);
		}
		if (path === '/internal/availability/heartbeat' && method === 'POST') {
			return await handleAvailabilityHeartbeat(req, res, context);
		}
		if (path === '/internal/availability/readiness' && method === 'POST') {
			return await handleAvailabilityReadiness(req, res);
		}
		if (path === '/internal/availability/wait-ready' && method === 'POST') {
			return await handleAvailabilityWaitReady(req, res, context);
		}
		if (path === '/internal/flows' && method === 'GET') {
			return handleInternalFlows(res);
		}
		if (path.startsWith('/jobs/') && method === 'GET') {
			const operationId = decodeURIComponent(path.slice('/jobs/'.length));
			return await handleGetAsyncJob(operationId, res);
		}
		if (path === '/booking/create' && method === 'POST') {
			return await handleCreateBooking(req, res, context);
		}
		if (path === '/booking/create-with-payment' && method === 'POST') {
			return handleDeprecatedSyncPaymentBooking(res);
		}
		if (path === '/booking/jobs' && method === 'POST') {
			return await handleEnqueueBookingJob(req, res, context);
		}
		if (path.startsWith('/booking/jobs/') && method === 'GET') {
			const operationId = decodeURIComponent(
				path.slice('/booking/jobs/'.length),
			);
			return await handleGetAsyncJob(operationId, res);
		}

		logRequestEvent('WARN', 'Unknown route requested', context, {
			event: 'request_not_found',
		});
		sendJson(res, 404, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'NOT_FOUND',
				message: `Unknown route: ${method} ${path}`,
			},
		});
	} catch (e) {
		logRequestEvent('ERROR', 'Unhandled request error', context, {
			event: 'request_failed',
			error: describeLogValue(e),
		});
		sendJson(res, 500, {
			success: false,
			error: {
				tag: 'InfrastructureError',
				code: 'UNKNOWN',
				message: e instanceof Error ? e.message : 'Internal server error',
			},
		});
	}
});

let browserRuntimeDisposed = false;

const disposeBrowserRuntime = () => {
	if (browserRuntimeDisposed) return;
	browserRuntimeDisposed = true;
	void browserRuntime.dispose().catch((error) => {
		logEvent('ERROR', 'Failed to dispose browser runtime', {
			event: 'runtime_dispose_failed',
			error: describeLogValue(error),
		});
	});
};

server.on('close', stopInlineWorker);
server.on('close', disposeBrowserRuntime);
server.on('close', disposeBridgeAsyncStore);
server.on('close', disposeRedisClient);

// Only start listening when this file is executed directly (not imported)
if (process.argv[1]?.match(/handler\.(ts|js|mjs)$/)) {
	server.listen(PORT, '0.0.0.0', () => {
		startInlineWorker();
		logEvent('INFO', 'Middleware server listening', {
			event: 'runtime_started',
			port: PORT,
			acuityBaseUrl: ACUITY_BASE_URL,
			couponConfigured: !!COUPON_CODE,
			authEnabled: !!AUTH_TOKEN,
			headless: browserConfig.headless,
		});
	});
}

export { server };
