import {
	DEFAULT_BOOKING_SNAPSHOT_FRESHNESS_FLOOR_MS,
	DEFAULT_ON_DEMAND_REFRESH_WAIT_MS,
} from './types.js';
import type {
	AppointmentCommand,
	AvailabilityDatesRefreshCommand,
	AvailabilitySlotsRefreshCommand,
	BookingExecutionPath,
	BridgeJobFailure,
	BridgeJobRecord,
	BridgeJobStatus,
} from './types.js';
import type { BridgeAsyncStore } from './store.js';
import type { AvailableDate, Booking, TimeSlot } from '../core/types.js';

export class BridgeJobExecutionError extends Error {
	readonly status: Extract<BridgeJobStatus, 'failed_pre_submit' | 'reconcile_required'>;
	readonly code: string;
	readonly step?: string;
	readonly retryable: boolean;
	readonly artifactRefs?: readonly string[];

	constructor(options: {
		status?: Extract<BridgeJobStatus, 'failed_pre_submit' | 'reconcile_required'>;
		code: string;
		message: string;
		step?: string;
		retryable?: boolean;
		artifactRefs?: readonly string[];
	}) {
		super(options.message);
		this.name = 'BridgeJobExecutionError';
		this.status = options.status ?? 'failed_pre_submit';
		this.code = options.code;
		this.step = options.step;
		this.retryable = options.retryable ?? false;
		this.artifactRefs = options.artifactRefs;
	}
}

/**
 * Lease-time plan-hash skew signal (design docs/design/flow-dag-formalization.md §5
 * plan-hash pinning): thrown by a flow-runner executor when the planHash pinned at
 * enqueue does not match its constructed flow's hash and no effectful-once step has
 * started. `executeBridgeJob` maps it to a REQUEUE (not a terminal failure) so a
 * replica with the matching flow shape can drain the job during a rolling deploy.
 */
export class BridgeJobPlanSkewError extends Error {
	readonly code: string;
	readonly step?: string;

	constructor(options: { code?: string; message: string; step?: string }) {
		super(options.message);
		this.name = 'BridgeJobPlanSkewError';
		this.code = options.code ?? 'FLOW_PLAN_SKEW';
		this.step = options.step;
	}
}

/**
 * Additive lease context handed to executors (0.6.0): the record identity plus the
 * planHash/flowVersion pinned at enqueue, so flag-gated flow execution can key its
 * journal rows and run the lease-time skew check. Optional everywhere — legacy
 * executors ignore it.
 */
export interface BridgeJobLeaseContext {
	readonly operationId?: string;
	readonly planHash?: string;
	readonly flowVersion?: string;
}

export interface BridgeJobExecutor {
	refreshAvailabilityDates(
		command: AvailabilityDatesRefreshCommand,
		context?: BridgeJobLeaseContext,
	): Promise<readonly AvailableDate[]>;
	refreshAvailabilitySlots(
		command: AvailabilitySlotsRefreshCommand,
		context?: BridgeJobLeaseContext,
	): Promise<readonly TimeSlot[]>;
	createBookingWithPayment(
		command: AppointmentCommand,
		context: { executionPath: BookingExecutionPath } & BridgeJobLeaseContext,
	): Promise<Booking>;
}

export interface ExecuteBridgeJobOptions {
	readonly workerId: string;
	readonly leaseMs?: number;
	readonly now?: Date;
}

const dateFromAppointmentDateTime = (datetime: string): string => datetime.slice(0, 10);

const isSnapshotFresh = (
	observedAt: string,
	now: Date,
	freshnessFloorMs: number,
): boolean => {
	const observedMs = Date.parse(observedAt);
	if (!Number.isFinite(observedMs)) return false;
	return now.getTime() - observedMs <= freshnessFloorMs;
};

const withTimeout = async <A>(
	promise: Promise<A>,
	timeoutMs: number,
): Promise<A | null> => {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<null>((resolve) => {
				timeout = setTimeout(() => resolve(null), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

export const selectBookingExecutionPath = (
	command: AppointmentCommand,
): BookingExecutionPath => {
	if (
		command.executionPreference === 'rest' &&
		command.adapterProfile.adminApiConfigured &&
		!command.couponBypassRequired
	) {
		return 'rest';
	}
	if (
		command.executionPreference === 'auto' &&
		command.adapterProfile.adminApiConfigured &&
		!command.couponBypassRequired
	) {
		return 'rest';
	}
	return 'browser';
};

const snapshotTimestamps = (observedAt: Date) => ({
	observedAt: observedAt.toISOString(),
	staleAt: new Date(observedAt.getTime() + 5 * 60_000).toISOString(),
	expiresAt: new Date(observedAt.getTime() + 30 * 60_000).toISOString(),
});

const failureFromUnknown = (error: unknown): BridgeJobFailure => {
	if (error instanceof BridgeJobExecutionError) {
		return {
			status: error.status,
			code: error.code,
			message: error.message,
			step: error.step,
			retryable: error.retryable,
			artifactRefs: error.artifactRefs,
		};
	}
	if (
		typeof error === 'object' &&
		error !== null &&
		'status' in error &&
		'code' in error &&
		'message' in error
	) {
		const bridgeError = error as {
			status: BridgeJobFailure['status'];
			code: string;
			message: string;
			step?: string;
			retryable?: boolean;
			artifactRefs?: readonly string[];
		};
		return {
			status: bridgeError.status,
			code: bridgeError.code,
			message: bridgeError.message,
			step: bridgeError.step,
			retryable: bridgeError.retryable ?? false,
			artifactRefs: bridgeError.artifactRefs,
		};
	}
	return {
		status: 'failed_pre_submit',
		code: 'UNKNOWN',
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
};

const ensureFreshSlotSnapshot = async (
	store: BridgeAsyncStore,
	record: BridgeJobRecord,
	command: AppointmentCommand,
	executor: BridgeJobExecutor,
	now: Date,
): Promise<BridgeJobRecord | null> => {
	const date = dateFromAppointmentDateTime(command.request.datetime);
	const freshnessFloorMs =
		command.snapshotFreshnessFloorMs ?? DEFAULT_BOOKING_SNAPSHOT_FRESHNESS_FLOOR_MS;
	const existing = await store.getAvailabilitySnapshot({
		kind: 'slots',
		serviceId: command.request.serviceId,
		scope: date,
		baseUrl: command.adapterProfile.baseUrl,
	});
	if (existing && isSnapshotFresh(existing.observedAt, now, freshnessFloorMs)) {
		return null;
	}

	const refreshWaitMs =
		command.onDemandRefreshWaitMs ?? DEFAULT_ON_DEMAND_REFRESH_WAIT_MS;
	const refreshCommand: AvailabilitySlotsRefreshCommand = {
		serviceId: command.request.serviceId,
		serviceName: command.serviceName,
		date,
		adapterProfile: command.adapterProfile,
	};
	const slots = await withTimeout(
		executor.refreshAvailabilitySlots(refreshCommand),
		refreshWaitMs,
	);
	if (!slots) {
		return store.requeueJob(record.operationId, {
			status: 'failed_pre_submit',
			code: 'SNAPSHOT_REFRESH_TIMEOUT',
			message: `Timed out after ${refreshWaitMs}ms waiting for fresh slot snapshot`,
			step: 'availability-refresh',
			retryable: true,
		});
	}
	await store.upsertAvailabilitySnapshot({
		kind: 'slots',
		serviceId: command.request.serviceId,
		scope: date,
		adapterProfile: command.adapterProfile,
		value: slots,
		sourceJobId: record.operationId,
		...snapshotTimestamps(new Date()),
	});
	return null;
};

export const executeBridgeJob = async (
	store: BridgeAsyncStore,
	record: BridgeJobRecord,
	executor: BridgeJobExecutor,
	options: ExecuteBridgeJobOptions,
): Promise<BridgeJobRecord | null> => {
	const startedAt = options.now ?? new Date();
	const leaseMs = options.leaseMs ?? 5 * 60_000;
	const running = await store.markJobRunning(record.operationId, {
		workerId: options.workerId,
		leasedUntil: new Date(startedAt.getTime() + leaseMs),
	});
	if (!running) return null;

	const leaseContext: BridgeJobLeaseContext = {
		operationId: record.operationId,
		planHash: record.planHash,
		flowVersion: record.flowVersion,
	};

	try {
		if (record.kind === 'availability_dates_refresh') {
			const command = record.command as AvailabilityDatesRefreshCommand;
			const dates = await executor.refreshAvailabilityDates(command, leaseContext);
			await store.upsertAvailabilitySnapshot({
				kind: 'dates',
				serviceId: command.serviceId,
				scope: command.month,
				adapterProfile: command.adapterProfile,
				value: dates,
				sourceJobId: record.operationId,
				...snapshotTimestamps(new Date()),
			});
			return store.completeJob(record.operationId, {
				kind: 'availability_dates_refresh',
				dates,
			});
		}

		if (record.kind === 'availability_slots_refresh') {
			const command = record.command as AvailabilitySlotsRefreshCommand;
			const slots = await executor.refreshAvailabilitySlots(command, leaseContext);
			await store.upsertAvailabilitySnapshot({
				kind: 'slots',
				serviceId: command.serviceId,
				scope: command.date,
				adapterProfile: command.adapterProfile,
				value: slots,
				sourceJobId: record.operationId,
				...snapshotTimestamps(new Date()),
			});
			return store.completeJob(record.operationId, {
				kind: 'availability_slots_refresh',
				slots,
			});
		}

		const command = record.command as AppointmentCommand;
		const requeued = await ensureFreshSlotSnapshot(
			store,
			record,
			command,
			executor,
			startedAt,
		);
		if (requeued) return requeued;
		const booking = await executor.createBookingWithPayment(command, {
			executionPath: selectBookingExecutionPath(command),
			...leaseContext,
		});
		return store.completeJob(record.operationId, {
			kind: 'booking_create_with_payment',
			booking,
		});
	} catch (error) {
		if (error instanceof BridgeJobPlanSkewError) {
			return store.requeueJob(record.operationId, {
				status: 'failed_pre_submit',
				code: error.code,
				message: error.message,
				step: error.step,
				retryable: true,
			});
		}
		return store.failJob(record.operationId, failureFromUnknown(error));
	}
};

export interface DrainBridgeJobsOptions extends ExecuteBridgeJobOptions {
	readonly limit?: number;
	readonly concurrency?: number;
}

const normalizeConcurrency = (value: number | undefined): number => {
	if (!Number.isFinite(value ?? Number.NaN)) return 1;
	return Math.max(1, Math.floor(value as number));
};

export const drainReadyBridgeJobs = async (
	store: BridgeAsyncStore,
	executor: BridgeJobExecutor,
	options: DrainBridgeJobsOptions,
): Promise<readonly BridgeJobRecord[]> => {
	const ready = await store.listReadyJobs(options.limit ?? 10, options.now);
	const concurrency = normalizeConcurrency(options.concurrency);
	const completed: BridgeJobRecord[] = [];
	for (let index = 0; index < ready.length; index += concurrency) {
		const chunk = ready.slice(index, index + concurrency);
		const results = await Promise.all(
			chunk.map((record) => executeBridgeJob(store, record, executor, options)),
		);
		for (const result of results) {
			if (result) completed.push(result);
		}
	}
	return completed;
};
