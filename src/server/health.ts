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
	release: {
		sha: releaseSha ?? 'unknown',
		ref: releaseRef ?? 'unknown',
		version: releaseVersion ?? 'unknown',
		builtAt: releaseBuiltAt ?? null,
		modalEnvironment: modalEnvironment ?? null,
	},
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
