/**
 * POST /internal/flows/:flowId/plan — browser-free plan dry-run (design §5 "Plan vs
 * execute", §10 0.6.x). Covers: auth gating (401 + invisible 404), plan-safety (the
 * effect runner is poisoned — any browser-path invocation fails the request),
 * catalog-backed fuzzy resolution payloads, below-threshold warnings, and snapshot
 * freshness classification under observedAt/staleAt/expiresAt semantics.
 */

import { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';

const SERVICES = [
	{
		id: '53178494',
		name: 'TMD single session',
		duration: 30,
		price: 10500,
		currency: 'USD',
		category: null,
		active: true,
	},
	{
		id: 'svc-cervical',
		name: 'Cervical Medical Massage 30 minutes',
		duration: 30,
		price: 9000,
		currency: 'USD',
		category: null,
		active: true,
	},
];

const listen = async () => {
	const handler = await import('../handler.js');
	const store = createInMemoryBridgeAsyncStore();
	handler.__setBridgeAsyncStoreForTest(store);
	// Plan-safety proof: the dry-run never reaches the browser effect runner. Any
	// invocation fails loudly and turns the request into a 500.
	handler.__setEffectRunnerForTest((() => {
		throw new Error('browser path must not be invoked by the plan dry-run');
	}) as never);
	await new Promise<void>((resolve) => {
		handler.server.listen(0, '127.0.0.1', resolve);
	});
	const address = handler.server.address() as AddressInfo;
	return { server: handler.server, store, baseUrl: `http://127.0.0.1:${address.port}` };
};

const postPlan = (
	baseUrl: string,
	flowId: string,
	body: unknown,
	token?: string,
) =>
	fetch(`${baseUrl}/internal/flows/${encodeURIComponent(flowId)}/plan`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify(body),
	});

describe('POST /internal/flows/:flowId/plan', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		process.env.ACUITY_BASE_URL = 'https://example.as.me';
		process.env.SERVICES_JSON = JSON.stringify(SERVICES);
		delete process.env.REDIS_URL;
		delete process.env.BRIDGE_DATABASE_URL;
		delete process.env.AUTH_TOKEN;
	});

	afterEach(async () => {
		if (activeServer?.listening) {
			await new Promise<void>((resolve, reject) => {
				activeServer!.close((error) => (error ? reject(error) : resolve()));
			});
		}
		activeServer = null;
		delete process.env.ACUITY_BASE_URL;
		delete process.env.SERVICES_JSON;
		delete process.env.AUTH_TOKEN;
	});

	it('is invisible (404) when AUTH_TOKEN is unconfigured', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(running.baseUrl, 'booking_create_with_payment', {
			serviceId: '53178494',
		});
		expect(response.status).toBe(404);
		expect((await response.json()).error.code).toBe('NOT_FOUND');
	});

	it('rejects requests without the bearer token (401)', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(running.baseUrl, 'booking_create_with_payment', {
			serviceId: '53178494',
		});
		expect(response.status).toBe(401);
		expect((await response.json()).error.code).toBe('UNAUTHORIZED');
	});

	it('404s unknown flow ids', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(
			running.baseUrl,
			'no_such_flow',
			{ serviceId: '53178494' },
			'plan-token',
		);
		expect(response.status).toBe(404);
		const body = await response.json();
		expect(body.error.code).toBe('NOT_FOUND');
		expect(body.error.message).toContain('no_such_flow');
	});

	it('validates serviceId', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(
			running.baseUrl,
			'booking_create_with_payment',
			{},
			'plan-token',
		);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error.code).toBe('serviceId');
		expect(body.error.message).toContain('serviceId');
	});

	it('returns the FlowPlan with an id-match resolution, browser-free', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(
			running.baseUrl,
			'booking_create_with_payment',
			{
				serviceId: '53178494',
				serviceName: 'TMD single session',
				datetime: '2026-03-15T10:00:00-05:00',
			},
			'plan-token',
		);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);

		const data = body.data;
		expect(data.layer).toBe('bridge_flow_plan_dry_run');
		expect(data.mode).toBe('plan');
		expect(data.flowId).toBe('booking_create_with_payment');
		expect(data.planHash).toMatch(/^[0-9a-f]{64}$/);
		expect(data.plan.nodes.map((node: { stepId: string }) => node.stepId)).toEqual([
			'acuity/navigate',
			'acuity/fill-form',
			'acuity/bypass-payment',
			'acuity/submit',
			'acuity/extract-confirmation',
		]);

		// Resolution payload: FuzzyResolution shape, id-match at confidence 1.
		expect(data.resolutions).toHaveLength(1);
		expect(data.resolutions[0]).toMatchObject({
			field: 'service',
			confidence: 1,
			strategy: 'id-match',
			matchedLabel: 'TMD single session',
			value: { label: 'TMD single session', ref: '53178494' },
		});
		expect(data.summary).toContain('path acuity/navigate -> acuity/fill-form');
		expect(data.summary).toContain('service matched 1.00 id-match');

		// No snapshot was seeded: freshness classifies as missing and warns.
		expect(data.snapshot).toMatchObject({
			kind: 'slots',
			scope: '2026-03-15',
			freshness: 'missing',
		});
		expect(data.warnings).toContain('slots snapshot missing (scope 2026-03-15)');
	});

	it('reports tolerant matches with confidence/threshold/alternates and stale snapshots', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const now = Date.now();
		await running.store.upsertAvailabilitySnapshot({
			kind: 'slots',
			serviceId: 'svc-cervical',
			scope: '2026-03-15',
			adapterProfile: {
				backend: 'acuity',
				baseUrl: 'https://example.as.me',
				adminApiConfigured: false,
			},
			value: [],
			observedAt: new Date(now - 10 * 60_000).toISOString(),
			staleAt: new Date(now - 5 * 60_000).toISOString(),
			expiresAt: new Date(now + 20 * 60_000).toISOString(),
		});

		const response = await postPlan(
			running.baseUrl,
			'availability_slots_refresh',
			{
				serviceId: 'svc-cervical',
				serviceName: 'Cervical Medical Massage',
				date: '2026-03-15',
			},
			'plan-token',
		);
		expect(response.status).toBe(200);
		const data = (await response.json()).data;

		expect(data.resolutions).toHaveLength(1);
		expect(data.resolutions[0]).toMatchObject({
			field: 'service',
			strategy: 'token-overlap',
			matchedLabel: 'Cervical Medical Massage 30 minutes',
			threshold: 0.3,
		});
		expect(data.resolutions[0].confidence).toBeCloseTo(0.5, 10);
		expect(Array.isArray(data.resolutions[0].alternates)).toBe(true);
		expect(data.resolutions[0].alternates.length).toBeGreaterThan(0);

		expect(data.snapshot).toMatchObject({
			kind: 'slots',
			scope: '2026-03-15',
			freshness: 'stale',
		});
		expect(data.warnings).toContain('slots snapshot stale (scope 2026-03-15)');
		expect(
			data.warnings.some((warning: string) =>
				warning.includes('tolerant token-overlap match'),
			),
		).toBe(true);
	});

	it('reports below-threshold matches as warnings with empty resolutions', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const response = await postPlan(
			running.baseUrl,
			'availability_dates_refresh',
			{ serviceId: 'svc-x', serviceName: 'Yoga', month: '2026-03' },
			'plan-token',
		);
		expect(response.status).toBe(200);
		const data = (await response.json()).data;

		expect(data.resolutions).toEqual([]);
		expect(
			data.warnings.some((warning: string) =>
				warning.startsWith('service match failed below minConfidence'),
			),
		).toBe(true);
		expect(data.summary).toContain('service match failed');
		// Dates flow probes the dates snapshot keyed by month.
		expect(data.snapshot).toMatchObject({
			kind: 'dates',
			scope: '2026-03',
			freshness: 'missing',
		});
	});

	it('validates month/date formats', async () => {
		process.env.AUTH_TOKEN = 'plan-token';
		const running = await listen();
		activeServer = running.server;

		const badMonth = await postPlan(
			running.baseUrl,
			'availability_dates_refresh',
			{ serviceId: 'svc-x', month: 'March' },
			'plan-token',
		);
		expect(badMonth.status).toBe(400);

		const badDate = await postPlan(
			running.baseUrl,
			'availability_slots_refresh',
			{ serviceId: 'svc-x', date: '03/15/2026' },
			'plan-token',
		);
		expect(badDate.status).toBe(400);
	});
});
