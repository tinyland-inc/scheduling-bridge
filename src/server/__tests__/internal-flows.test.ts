/**
 * GET /internal/flows — auth + payload (design §5: "GET /internal/flows serves all
 * registered plans (auth-gated like existing /internal/* routes)").
 *
 * Conventions mirrored from the existing internal endpoints: the global Bearer gate
 * rejects bad tokens with 401, and the endpoint is INVISIBLE (404) when AUTH_TOKEN
 * is unconfigured.
 */

import { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';

const listen = async () => {
	const { server, __setBridgeAsyncStoreForTest } = await import('../handler.js');
	__setBridgeAsyncStoreForTest(createInMemoryBridgeAsyncStore());
	await new Promise<void>((resolve) => {
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address() as AddressInfo;
	return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

describe('GET /internal/flows', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		process.env.ACUITY_BASE_URL = 'https://example.as.me';
		process.env.SERVICES_JSON = JSON.stringify([]);
		delete process.env.REDIS_URL;
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

	it('serves all registered FlowPlans as JSON when authorized', async () => {
		process.env.AUTH_TOKEN = 'flows-token';
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(`${running.baseUrl}/internal/flows`, {
			headers: { Authorization: 'Bearer flows-token' },
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(body.data.layer).toBe('bridge_flow_plans');
		expect(body.data.backend).toBe('acuity');

		const flows = body.data.flows as readonly {
			flowId: string;
			backend: string;
			version: string;
			planHash: string;
			plan: { flowId: string; nodes: readonly { stepId: string }[] };
		}[];
		expect(flows.map((flow) => flow.flowId).sort()).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
			'booking_create_with_payment',
		]);
		for (const flow of flows) {
			expect(flow.backend).toBe('acuity');
			expect(flow.planHash).toMatch(/^[0-9a-f]{64}$/);
			expect(flow.plan.flowId).toBe(flow.flowId);
			expect(flow.plan.nodes.length).toBeGreaterThan(0);
		}
		const booking = flows.find(
			(flow) => flow.flowId === 'booking_create_with_payment',
		);
		expect(booking?.plan.nodes.map((node) => node.stepId)).toEqual([
			'acuity/navigate',
			'acuity/fill-form',
			'acuity/bypass-payment',
			'acuity/submit',
			'acuity/extract-confirmation',
		]);
	});

	it('rejects requests without the bearer token (401, like every guarded route)', async () => {
		process.env.AUTH_TOKEN = 'flows-token';
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(`${running.baseUrl}/internal/flows`);
		const body = await response.json();

		expect(response.status).toBe(401);
		expect(body.error.code).toBe('UNAUTHORIZED');
	});

	it('is invisible (404) when AUTH_TOKEN is unconfigured, like the other /internal routes', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(`${running.baseUrl}/internal/flows`);
		const body = await response.json();

		expect(response.status).toBe(404);
		expect(body.error.code).toBe('NOT_FOUND');
	});
});
