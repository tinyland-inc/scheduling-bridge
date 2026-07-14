export const BRIDGE_PROTOCOL_VERSION = '1.2.0' as const;

export const BRIDGE_PROTOCOL_ENDPOINTS = {
	health: '/health',
	services: '/services',
	service: '/services/:id',
	availabilityDates: '/availability/dates',
	availabilitySlots: '/availability/slots',
	availabilityCheck: '/availability/check',
	availabilityRefresh: '/availability/refresh',
	availabilitySnapshot: '/availability/snapshot',
	availabilityHeartbeat: '/internal/availability/heartbeat',
	availabilityReadiness: '/internal/availability/readiness',
	availabilityWaitReady: '/internal/availability/wait-ready',
	bookingCreate: '/booking/create',
	bookingCreateWithPayment: '/booking/create-with-payment',
	bookingJobs: '/booking/jobs',
	jobStatus: '/jobs/:operationId',
} as const;

export const BRIDGE_PROTOCOL_CAPABILITIES = [
	'services:list',
	'services:get',
	'availability:dates',
	'availability:slots',
	'availability:check',
	'availability:refresh-async',
	'availability:snapshot',
	'availability:heartbeat-internal',
	'availability:readiness-internal',
	'availability:wait-ready-internal',
	'booking:create',
	'booking:create-with-payment:deprecated',
	'booking:create-with-payment-async',
	'booking:job-status',
	'service-catalog:static-fallback',
	'service-catalog:business-extract',
	'service-catalog:scraper-fallback',
	'payment:bypass-coupon',
] as const;

export interface BuildHealthPayloadOptions {
	baseUrl: string;
	hasCoupon: boolean;
	headless: boolean;
	staticServices: number;
	serviceCacheTtlMs: number;
	releaseSha?: string | null;
	releaseRef?: string | null;
	releaseVersion?: string | null;
	releaseBuiltAt?: string | null;
	modalEnvironment?: string | null;
	timestamp?: string;
}

/**
 * Release identity block — low-sensitivity deploy provenance (sha/ref/version/
 * builtAt/modalEnvironment). Shared by the public and verbose projections
 * because deploy verification and the estate's drift audits read the live
 * deployed version from `/health` (the MassageIthaca aggregator reports the
 * bridge `releaseVersion`, and blahaj deploy gates compare `sha`). This is the
 * one internal block that intentionally stays on the public surface — it is a
 * git sha and a semver, not a capability or an in-cluster URL.
 */
type ReleaseFields = Pick<
	BuildHealthPayloadOptions,
	| 'releaseSha'
	| 'releaseRef'
	| 'releaseVersion'
	| 'releaseBuiltAt'
	| 'modalEnvironment'
>;

const normalizeRelease = ({
	releaseSha,
	releaseRef,
	releaseVersion,
	releaseBuiltAt,
	modalEnvironment,
}: ReleaseFields) => ({
	sha: releaseSha ?? 'unknown',
	ref: releaseRef ?? 'unknown',
	version: releaseVersion ?? 'unknown',
	builtAt: releaseBuiltAt ?? null,
	modalEnvironment: modalEnvironment ?? null,
});

/**
 * PUBLIC (unauthenticated) `/health` projection — TIN-2826.
 *
 * Minimal envelope returned to callers that do NOT present a valid Bearer
 * AUTH_TOKEN. It deliberately DROPS the information-disclosure fields that the
 * verbose payload carries:
 *   - `baseUrl` (upstream Acuity URL)
 *   - `hasCoupon` / `headless` / `staticServices` / `serviceCacheTtlMs`
 *     (the config-validity map)
 *   - `protocol` (endpoint list + capability list, incl. `booking:create` and
 *     `payment:bypass-coupon`)
 *
 * It KEEPS `status`, `protocolVersion`, the `release` block, and `timestamp`
 * so k8s/Docker probes stay green (200 + `status:ok`), boot-smoke keeps its
 * `success:true` + `status:ok` asserts, and deploy/drift audits can still read
 * the deployed version off the public surface.
 */
export const buildPublicHealthPayload = ({
	releaseSha,
	releaseRef,
	releaseVersion,
	releaseBuiltAt,
	modalEnvironment,
	timestamp = new Date().toISOString(),
}: BuildHealthPayloadOptions) => ({
	status: 'ok' as const,
	protocolVersion: BRIDGE_PROTOCOL_VERSION,
	release: normalizeRelease({
		releaseSha,
		releaseRef,
		releaseVersion,
		releaseBuiltAt,
		modalEnvironment,
	}),
	timestamp,
});

/**
 * VERBOSE `/health` projection — served ONLY to callers presenting a valid
 * Bearer AUTH_TOKEN (see `handleHealth` in handler.ts). Carries the full
 * operator/estate contract: upstream config, the protocol endpoint + capability
 * registry, and the release block. Unchanged shape from the pre-TIN-2826
 * payload so authed consumers (the MassageIthaca aggregator, which fetches
 * `/health` with `Authorization: Bearer ...`) keep every field they read.
 */
export const buildHealthPayload = ({
	baseUrl,
	hasCoupon,
	headless,
	staticServices,
	serviceCacheTtlMs,
	releaseSha,
	releaseRef,
	releaseVersion,
	releaseBuiltAt,
	modalEnvironment,
	timestamp = new Date().toISOString(),
}: BuildHealthPayloadOptions) => ({
	status: 'ok' as const,
	baseUrl,
	hasCoupon,
	headless,
	staticServices,
	serviceCacheTtlMs,
	releaseSha: releaseSha ?? 'unknown',
	releaseRef: releaseRef ?? 'unknown',
	releaseVersion: releaseVersion ?? 'unknown',
	releaseBuiltAt: releaseBuiltAt ?? null,
	modalEnvironment: modalEnvironment ?? null,
	protocolVersion: BRIDGE_PROTOCOL_VERSION,
	release: normalizeRelease({
		releaseSha,
		releaseRef,
		releaseVersion,
		releaseBuiltAt,
		modalEnvironment,
	}),
	protocol: {
		version: BRIDGE_PROTOCOL_VERSION,
		flowOwner: 'scheduling-bridge' as const,
		backend: 'acuity' as const,
		transport: 'http-json' as const,
		endpoints: BRIDGE_PROTOCOL_ENDPOINTS,
		capabilities: [...BRIDGE_PROTOCOL_CAPABILITIES],
	},
	timestamp,
});
