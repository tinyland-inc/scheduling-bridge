import type {
	AvailableDate,
	Booking,
	BookingRequest,
	TimeSlot,
} from '../core/types.js';

export type BridgeJobKind =
	| 'availability_dates_refresh'
	| 'availability_slots_refresh'
	| 'booking_create_with_payment';

export type BridgeJobStatus =
	| 'queued'
	| 'leased'
	| 'running'
	| 'succeeded'
	| 'failed_pre_submit'
	| 'reconcile_required'
	| 'cancelled';

export type AvailabilitySnapshotKind = 'dates' | 'slots';
export type BookingExecutionPreference = 'auto' | 'browser' | 'rest';
export type BookingExecutionPath = 'browser' | 'rest';

export const DEFAULT_BOOKING_SNAPSHOT_FRESHNESS_FLOOR_MS = 90_000;
export const DEFAULT_ON_DEMAND_REFRESH_WAIT_MS = 10_000;

export interface BridgeAdapterProfile {
	readonly backend: 'acuity';
	readonly baseUrl: string;
	readonly selectorProfile?: string;
	readonly adminApiConfigured?: boolean;
}

export interface AppointmentCommand {
	readonly request: BookingRequest;
	readonly paymentRef: string;
	readonly paymentProcessor: string;
	readonly couponCode?: string;
	readonly serviceName?: string;
	readonly adapterProfile: BridgeAdapterProfile;
	readonly couponBypassRequired: boolean;
	readonly executionPreference: BookingExecutionPreference;
	readonly snapshotFreshnessFloorMs?: number;
	readonly onDemandRefreshWaitMs?: number;
}

export interface AvailabilityDatesRefreshCommand {
	readonly serviceId: string;
	readonly serviceName?: string;
	readonly month: string;
	readonly adapterProfile: BridgeAdapterProfile;
}

export interface AvailabilitySlotsRefreshCommand {
	readonly serviceId: string;
	readonly serviceName?: string;
	readonly date: string;
	readonly adapterProfile: BridgeAdapterProfile;
}

export type BridgeJobCommand =
	| {
			readonly kind: 'availability_dates_refresh';
			readonly command: AvailabilityDatesRefreshCommand;
	  }
	| {
			readonly kind: 'availability_slots_refresh';
			readonly command: AvailabilitySlotsRefreshCommand;
	  }
	| {
			readonly kind: 'booking_create_with_payment';
			readonly command: AppointmentCommand;
	  };

export interface BridgeJobFailure {
	readonly status: Exclude<
		BridgeJobStatus,
		'queued' | 'leased' | 'running' | 'succeeded' | 'cancelled'
	>;
	readonly code: string;
	readonly message: string;
	readonly step?: string;
	readonly retryable: boolean;
	readonly artifactRefs?: readonly string[];
}

export type BridgeJobResult =
	| {
			readonly kind: 'availability_dates_refresh';
			readonly dates: readonly AvailableDate[];
	  }
	| {
			readonly kind: 'availability_slots_refresh';
			readonly slots: readonly TimeSlot[];
	  }
	| {
			readonly kind: 'booking_create_with_payment';
			readonly booking: Booking;
	  };

export interface BridgeJobRecord {
	readonly operationId: string;
	readonly kind: BridgeJobKind;
	readonly status: BridgeJobStatus;
	readonly command: BridgeJobCommand['command'];
	readonly idempotencyKey?: string;
	readonly attempts: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly leasedBy?: string;
	readonly leasedUntil?: string;
	readonly result?: BridgeJobResult;
	readonly failure?: BridgeJobFailure;
}

export interface AvailabilitySnapshot {
	readonly snapshotId: string;
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly scope: string;
	readonly adapterProfile: BridgeAdapterProfile;
	readonly value: readonly AvailableDate[] | readonly TimeSlot[];
	readonly observedAt: string;
	readonly staleAt: string;
	readonly expiresAt: string;
	readonly version: number;
	readonly sourceJobId?: string;
}

export interface AvailabilitySnapshotQuery {
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly scope: string;
	readonly baseUrl: string;
}

export interface EnqueueBridgeJobOptions {
	readonly idempotencyKey?: string;
}

export interface EnqueueBookingJobRequest {
	readonly request: BookingRequest;
	readonly paymentRef: string;
	readonly paymentProcessor: string;
	readonly couponCode?: string;
	readonly idempotencyKey?: string;
}

export interface EnqueueAvailabilityRefreshRequest {
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly serviceName?: string;
	readonly month?: string;
	readonly date?: string;
	readonly idempotencyKey?: string;
}

export interface AvailabilityHeartbeatDemand {
	readonly serviceId: string;
	readonly serviceName?: string;
	readonly weight?: number;
	readonly months?: readonly string[];
	readonly dates?: readonly string[];
}

export interface AvailabilityHeartbeatRequest {
	readonly demands: readonly AvailabilityHeartbeatDemand[];
	readonly maxJobs?: number;
	readonly idempotencyWindowMs?: number;
	readonly idempotencyKeyPrefix?: string;
}

export interface EnqueueBridgeJobResponse {
	readonly operationId: string;
	readonly status: BridgeJobStatus;
	readonly statusUrl: string;
}

export interface AvailabilityHeartbeatJob {
	readonly operationId: string;
	readonly status: BridgeJobStatus;
	readonly statusUrl: string;
	readonly action: 'queued' | 'deduped' | 'requeued';
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly scope: string;
	readonly freshness: 'missing' | 'stale' | 'expired';
	readonly weight: number;
}

export interface AvailabilityHeartbeatSkipped {
	readonly kind: AvailabilitySnapshotKind;
	readonly serviceId: string;
	readonly scope: string;
	readonly reason: 'fresh' | 'limit' | 'terminal' | 'requeue_failed';
	readonly freshness?: 'fresh';
	readonly weight: number;
	readonly status?: BridgeJobStatus;
	readonly operationId?: string;
	readonly statusUrl?: string;
}

export interface AvailabilityHeartbeatResponse {
	readonly layer: 'bridge_availability_heartbeat';
	readonly considered: number;
	readonly enqueued: readonly AvailabilityHeartbeatJob[];
	readonly skipped: readonly AvailabilityHeartbeatSkipped[];
	readonly maxJobs: number;
	readonly idempotencyWindowMs: number;
}
