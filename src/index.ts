/**
 * @tummycrypt/scheduling-bridge
 *
 * Backend-agnostic scheduling adapter hub.
 * Currently bridges Acuity Scheduling via Playwright automation.
 */

// Core types
export type {
	Service,
	Provider,
	TimeSlot,
	AvailableDate,
	Booking,
	BookingRequest,
	ClientInfo,
	SchedulingError,
	SchedulingResult,
	BookingStatus,
	PaymentStatus,
} from './core/types.js';
export { Errors } from './core/types.js';

// Adapter interface
export type { SchedulingAdapter } from './adapters/types.js';

// Acuity adapter
export {
	createWizardAdapter,
	type WizardAdapterConfig,
} from './adapters/acuity/wizard.js';

// Shared: remote adapter (HTTP client for remote mode)
export {
	createRemoteWizardAdapter,
	type RemoteAdapterConfig,
} from './shared/remote-adapter.js';
export {
	createBridgeAsyncClient,
	type BridgeAsyncClient,
} from './shared/async-client.js';
export {
	createInMemoryBridgeAsyncStore,
	type BridgeAsyncStore,
} from './async/store.js';
export {
	BRIDGE_ASYNC_SCHEMA_SQL,
	createPostgresBridgeAsyncStore,
	ensureBridgeAsyncSchema,
	type PostgresBridgeAsyncStoreOptions,
} from './async/postgres-store.js';
export {
	createRedisBridgeAsyncStore,
	type RedisBridgeAsyncStoreOptions,
} from './async/redis-store.js';
export {
	BridgeJobExecutionError,
	drainReadyBridgeJobs,
	executeBridgeJob,
	selectBookingExecutionPath,
	type BridgeJobExecutor,
	type DrainBridgeJobsOptions,
	type ExecuteBridgeJobOptions,
} from './async/worker.js';
export {
	DEFAULT_BOOKING_SNAPSHOT_FRESHNESS_FLOOR_MS,
	DEFAULT_ON_DEMAND_REFRESH_WAIT_MS,
} from './async/types.js';
export type {
	AppointmentCommand,
	AvailabilityDatesRefreshCommand,
	AvailabilityHeartbeatDemand,
	AvailabilityHeartbeatJob,
	AvailabilityHeartbeatRequest,
	AvailabilityHeartbeatResponse,
	AvailabilityHeartbeatSkipped,
	AvailabilityReadinessFreshness,
	AvailabilityReadinessPolicy,
	AvailabilityReadinessResponse,
	AvailabilityReadinessScope,
	AvailabilitySlotsRefreshCommand,
	AvailabilitySnapshot,
	AvailabilitySnapshotKind,
	AvailabilitySnapshotQuery,
	AvailabilityWaitReadyResponse,
	BridgeAdapterProfile,
	BookingExecutionPath,
	BookingExecutionPreference,
	BridgeJobCommand,
	BridgeJobFailure,
	BridgeJobKind,
	BridgeJobRecord,
	BridgeJobResult,
	BridgeJobStatus,
	BridgeQueueStats,
	BridgeQueueStatsKindStatus,
	EnqueueAvailabilityRefreshRequest,
	EnqueueBookingJobRequest,
	EnqueueBridgeJobResponse,
} from './async/types.js';

// Shared: browser service (Playwright lifecycle)
export {
	BrowserProcess,
	BrowserProcessLive,
	BrowserService,
	BrowserSessionLive,
	BrowserServiceLive,
	BrowserServiceTest,
	defaultBrowserConfig,
	type BrowserConfig,
	type BrowserProcessShape,
	type BrowserServiceShape,
} from './shared/browser-service.js';

// Acuity error types
export {
	BrowserError,
	SelectorError,
	WizardStepError,
	CouponError,
	toSchedulingError,
	type MiddlewareError,
} from './adapters/acuity/errors.js';

// Acuity selector registry
export {
	Selectors,
	resolveSelector,
	resolve,
	probeSelector,
	probe,
	healthCheck,
	type SelectorKey,
	type ResolvedSelector,
} from './adapters/acuity/selectors.js';

// Scraper
export {
	createScraperAdapter,
	AcuityScraper,
	type ScraperConfig,
} from './adapters/acuity/scraper.js';

// Server
export { server } from './server/handler.js';
export {
	BRIDGE_PROTOCOL_VERSION,
	BRIDGE_PROTOCOL_ENDPOINTS,
	BRIDGE_PROTOCOL_CAPABILITIES,
} from './server/health.js';
export {
	createAcuityBridgeJobExecutor,
	createWorkerStore,
	runBridgeWorkerLoop,
} from './server/worker.js';

// Payment capabilities extraction
export { extractCapabilities } from './capabilities.js';
