import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRemoteWizardAdapter, type RemoteAdapterConfig } from '../remote-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture the headers sent by makeRequest via a mocked global fetch. */
const capturedHeaders: Record<string, string>[] = [];

const mockFetchSuccess = (data: unknown = []) =>
	vi.fn(async (_url: string, init?: RequestInit) => {
		const raw = init?.headers ?? {};
		capturedHeaders.push(
			raw instanceof Headers
				? Object.fromEntries(raw.entries())
				: (raw as Record<string, string>),
		);
		return new Response(JSON.stringify({ success: true, data }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteAdapterConfig.headers', () => {
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		capturedHeaders.length = 0;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('includes custom headers in outgoing requests', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			headers: { 'x-request-id': 'req-abc-123', 'x-tenant': 'clinic-42' },
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders).toHaveLength(1);
		expect(capturedHeaders[0]['x-request-id']).toBe('req-abc-123');
		expect(capturedHeaders[0]['x-tenant']).toBe('clinic-42');
	});

	it('does not override Content-Type with custom headers', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			headers: { 'Content-Type': 'text/xml' },
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders[0]['Content-Type']).toBe('application/json');
	});

	it('ignores case-insensitive Content-Type override attempts', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			headers: { 'content-type': 'text/xml', 'CoNtEnT-TyPe': 'text/plain' },
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders[0]['Content-Type']).toBe('application/json');
		expect(capturedHeaders[0]['content-type']).toBeUndefined();
		expect(capturedHeaders[0]['CoNtEnT-TyPe']).toBeUndefined();
	});

	it('does not override Authorization with custom headers', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			authToken: 'real-token',
			headers: { Authorization: 'Bearer evil-token' },
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders[0]['Authorization']).toBe('Bearer real-token');
	});

	it('ignores case-insensitive Authorization override attempts', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			authToken: 'real-token',
			headers: { authorization: 'Bearer evil-token', AUTHORIZATION: 'Bearer worse-token' },
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders[0]['Authorization']).toBe('Bearer real-token');
		expect(capturedHeaders[0]['authorization']).toBeUndefined();
		expect(capturedHeaders[0]['AUTHORIZATION']).toBeUndefined();
	});

	it('works correctly when no custom headers are provided', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			authToken: 'some-token',
		};

		const adapter = createRemoteWizardAdapter(config);
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders[0]['Content-Type']).toBe('application/json');
		expect(capturedHeaders[0]['Authorization']).toBe('Bearer some-token');
		// No extra keys beyond Content-Type and Authorization
		expect(Object.keys(capturedHeaders[0])).toHaveLength(2);
	});

	it('preserves static custom headers across multiple requests', async () => {
		const fetchMock = mockFetchSuccess();
		globalThis.fetch = fetchMock as unknown as typeof fetch;

		const config: RemoteAdapterConfig = {
			baseUrl: 'https://bridge.test',
			headers: { 'x-request-id': 'persistent-id' },
		};

		const adapter = createRemoteWizardAdapter(config);

		await Effect.runPromise(adapter.getServices());
		await Effect.runPromise(adapter.getServices());

		expect(capturedHeaders).toHaveLength(2);
		expect(capturedHeaders[0]['x-request-id']).toBe('persistent-id');
		expect(capturedHeaders[1]['x-request-id']).toBe('persistent-id');
	});
});
