import type {
	AvailabilityDatesRefreshCommand,
	AvailabilitySlotsRefreshCommand,
	BridgeJobRecord,
	BridgeQueueStats,
	BridgeQueueStatsFailedRefresh,
	BridgeQueueStatsKindStatus,
} from './types.js';

const isRetryableFailedJob = (job: BridgeJobRecord): boolean =>
	(job.status === 'failed_pre_submit' || job.status === 'reconcile_required') &&
	job.failure?.retryable === true;

const isReadyJob = (job: BridgeJobRecord, now: Date): boolean => {
	if (job.status === 'queued') return true;
	if (
		(job.status !== 'leased' && job.status !== 'running') ||
		!job.leasedUntil
	) {
		return false;
	}
	return Date.parse(job.leasedUntil) <= now.getTime();
};

const failedRefreshScope = (
	job: BridgeJobRecord,
): {
	kind: BridgeQueueStatsFailedRefresh['kind'];
	serviceId: string;
	scope: string;
} | null => {
	if (job.kind === 'availability_dates_refresh') {
		const command = job.command as AvailabilityDatesRefreshCommand;
		return {
			kind: 'availability_dates_refresh',
			serviceId: command.serviceId,
			scope: command.month,
		};
	}
	if (job.kind === 'availability_slots_refresh') {
		const command = job.command as AvailabilitySlotsRefreshCommand;
		return {
			kind: 'availability_slots_refresh',
			serviceId: command.serviceId,
			scope: command.date,
		};
	}
	return null;
};

const failedRefreshKey = (
	job: BridgeJobRecord,
	scope: { serviceId: string; scope: string },
): string =>
	[
		job.kind,
		job.status,
		scope.serviceId,
		scope.scope,
		job.failure?.code ?? 'UNKNOWN',
		job.failure?.step ?? '',
		String(job.failure?.retryable ?? false),
	].join('\u0000');

export const queueStatsFromJobs = (
	jobs: readonly BridgeJobRecord[],
	now = new Date(),
): BridgeQueueStats => {
	const buckets = new Map<string, BridgeQueueStatsKindStatus>();
	const failedRefreshes = new Map<string, BridgeQueueStatsFailedRefresh>();
	let ready = 0;
	let retryableFailed = 0;
	let oldestQueuedAgeMs: number | undefined;

	for (const job of jobs) {
		const key = `${job.kind}:${job.status}`;
		const ageMs = Math.max(0, now.getTime() - Date.parse(job.createdAt));
		const previous = buckets.get(key);
		buckets.set(key, {
			kind: job.kind,
			status: job.status,
			count: (previous?.count ?? 0) + 1,
			oldestAgeMs: Math.max(previous?.oldestAgeMs ?? 0, ageMs),
		});

		if (isReadyJob(job, now)) {
			ready += 1;
			oldestQueuedAgeMs = Math.max(oldestQueuedAgeMs ?? 0, ageMs);
		}
		if (isRetryableFailedJob(job)) {
			retryableFailed += 1;
		}

		if (
			(job.status === 'failed_pre_submit' ||
				job.status === 'reconcile_required') &&
			job.failure
		) {
			const scope = failedRefreshScope(job);
			if (scope) {
				const failedKey = failedRefreshKey(job, scope);
				const previousFailure = failedRefreshes.get(failedKey);
				failedRefreshes.set(failedKey, {
					kind: scope.kind,
					status: job.status,
					serviceId: scope.serviceId,
					scope: scope.scope,
					code: job.failure.code,
					step: job.failure.step,
					retryable: job.failure.retryable,
					count: (previousFailure?.count ?? 0) + 1,
					oldestAgeMs: Math.max(previousFailure?.oldestAgeMs ?? 0, ageMs),
				});
			}
		}
	}

	return {
		total: jobs.length,
		ready,
		retryableFailed,
		oldestQueuedAgeMs,
		byKindStatus: [...buckets.values()].sort((a, b) =>
			a.kind === b.kind
				? a.status.localeCompare(b.status)
				: a.kind.localeCompare(b.kind),
		),
		failedRefreshes: [...failedRefreshes.values()].sort((a, b) =>
			a.kind === b.kind
				? a.scope.localeCompare(b.scope) || a.code.localeCompare(b.code)
				: a.kind.localeCompare(b.kind),
		),
	};
};
