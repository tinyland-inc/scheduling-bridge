import type {
	AvailabilitySnapshot,
	EnqueueAvailabilityRefreshRequest,
	EnqueueBookingJobRequest,
	EnqueueBridgeJobResponse,
	BridgeJobRecord,
} from '../async/types.js';
import type { RemoteAdapterConfig } from './remote-adapter.js';

interface RemoteEnvelope<T> {
	readonly success: boolean;
	readonly data?: T;
	readonly error?: {
		readonly tag: string;
		readonly code: string;
		readonly message: string;
	};
}

const buildHeaders = (config: RemoteAdapterConfig): Record<string, string> => {
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	};
	if (config.authToken) {
		headers.Authorization = `Bearer ${config.authToken}`;
	}
	for (const [name, value] of Object.entries(config.headers ?? {})) {
		if (!['authorization', 'content-type'].includes(name.toLowerCase())) {
			headers[name] = value;
		}
	}
	return headers;
};

const request = async <T>(
	config: RemoteAdapterConfig,
	path: string,
	init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> => {
	const response = await fetch(`${config.baseUrl}${path}`, {
		method: init.method,
		headers: buildHeaders(config),
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
		signal: AbortSignal.timeout(config.timeout ?? 60_000),
	});

	const json = (await response.json().catch(() => ({}))) as RemoteEnvelope<T>;
	if (!response.ok || !json.success) {
		throw new Error(json.error?.message ?? `Bridge async request failed: HTTP ${response.status}`);
	}
	return json.data as T;
};

export interface BridgeAsyncClient {
	enqueueBookingJob(
		body: EnqueueBookingJobRequest,
	): Promise<EnqueueBridgeJobResponse>;
	getJob(operationId: string): Promise<BridgeJobRecord>;
	enqueueAvailabilityRefresh(
		body: EnqueueAvailabilityRefreshRequest,
	): Promise<EnqueueBridgeJobResponse>;
	getAvailabilitySnapshot(params: {
		kind: 'dates' | 'slots';
		serviceId: string;
		scope: string;
	}): Promise<AvailabilitySnapshot>;
}

export const createBridgeAsyncClient = (
	config: RemoteAdapterConfig,
): BridgeAsyncClient => ({
	enqueueBookingJob: (body) =>
		request<EnqueueBridgeJobResponse>(config, '/booking/jobs', {
			method: 'POST',
			body,
		}),
	getJob: (operationId) =>
		request<BridgeJobRecord>(
			config,
			`/jobs/${encodeURIComponent(operationId)}`,
			{ method: 'GET' },
		),
	enqueueAvailabilityRefresh: (body) =>
		request<EnqueueBridgeJobResponse>(config, '/availability/refresh', {
			method: 'POST',
			body,
		}),
	getAvailabilitySnapshot: ({ kind, serviceId, scope }) => {
		const query = new URLSearchParams({ kind, serviceId, scope });
		return request<AvailabilitySnapshot>(
			config,
			`/availability/snapshot?${query.toString()}`,
			{ method: 'GET' },
		);
	},
});
