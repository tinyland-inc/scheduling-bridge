/**
 * GET /internal/flows/:flowId/mermaid — read-only mermaid projection (design §10
 * 0.6.x "Mermaid emission with journal overlay"). Pins the rendered booking flow
 * diagram with and without the `?operationId=` journal overlay; covers the auth
 * conventions shared by every /internal route.
 */

import { type AddressInfo } from 'node:net';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from '../../async/store.js';
import { createInMemoryFlowJournal } from '../../flow/journal.js';

// Payment-injection sub-flow (design §7; TIN-2095): the single bypass-payment node
// is now three sub-steps (s2/s3/s4) sharing the 'bypass-payment' segment.
const BOOKING_DIAGRAM = [
	'%% flow: booking_create_with_payment v1.0.0 (acuity)',
	'flowchart TD',
	'\ts0["acuity/navigate (segment: navigate, replayable-write)"]',
	'\ts1["acuity/fill-form (segment: fill-form, replayable-write)"]',
	'\ts2["acuity/open-coupon-entry (segment: bypass-payment, replayable-write)"]',
	'\ts3["acuity/apply-coupon (segment: bypass-payment, replayable-write)"]',
	'\ts4["acuity/verify-zero-total (segment: bypass-payment, replayable-write)"]',
	'\ts5["acuity/submit (segment: submit, effectful-once)"]',
	'\ts6["acuity/extract-confirmation (segment: extract-confirmation, read)"]',
	'\ts0 --> s1',
	'\ts1 --> s2',
	'\ts2 --> s3',
	'\ts3 --> s4',
	'\ts4 --> s5',
	'\ts5 --> s6',
	'',
].join('\n');

const BOOKING_DIAGRAM_WITH_OVERLAY = [
	'%% flow: booking_create_with_payment v1.0.0 (acuity)',
	'flowchart TD',
	'\ts0["acuity/navigate (segment: navigate, replayable-write) [completed]"]:::flow_completed',
	'\ts1["acuity/fill-form (segment: fill-form, replayable-write) [completed]"]:::flow_completed',
	'\ts2["acuity/open-coupon-entry (segment: bypass-payment, replayable-write) [completed]"]:::flow_completed',
	'\ts3["acuity/apply-coupon (segment: bypass-payment, replayable-write) [completed]"]:::flow_completed',
	'\ts4["acuity/verify-zero-total (segment: bypass-payment, replayable-write) [failed]"]:::flow_failed',
	'\ts5["acuity/submit (segment: submit, effectful-once)"]',
	'\ts6["acuity/extract-confirmation (segment: extract-confirmation, read)"]',
	'\ts0 --> s1',
	'\ts1 --> s2',
	'\ts2 --> s3',
	'\ts3 --> s4',
	'\ts4 --> s5',
	'\ts5 --> s6',
	'\tclassDef flow_completed fill:#d3f9d8,stroke:#2f9e44,color:#000',
	'\tclassDef flow_failed fill:#ffe3e3,stroke:#e03131,color:#000',
	'',
].join('\n');

const seedJournal = async (operationId: string) => {
	const journal = createInMemoryFlowJournal();
	const base = {
		operationId,
		flowId: 'booking_create_with_payment',
		flowVersion: '1.0.0',
		planHash: 'pinned-hash',
		attempt: 1,
	};
	// Payment-injection sub-flow (design §7; TIN-2095): open + apply complete, the
	// $0 proof fails at verify-zero-total.
	const rows: readonly { stepId: string; status: 'started' | 'completed' | 'failed' }[] = [
		{ stepId: 'acuity/navigate', status: 'started' },
		{ stepId: 'acuity/navigate', status: 'completed' },
		{ stepId: 'acuity/fill-form', status: 'started' },
		{ stepId: 'acuity/fill-form', status: 'completed' },
		{ stepId: 'acuity/open-coupon-entry', status: 'started' },
		{ stepId: 'acuity/open-coupon-entry', status: 'completed' },
		{ stepId: 'acuity/apply-coupon', status: 'started' },
		{ stepId: 'acuity/apply-coupon', status: 'completed' },
		{ stepId: 'acuity/verify-zero-total', status: 'started' },
		{ stepId: 'acuity/verify-zero-total', status: 'failed' },
	];
	for (const row of rows) {
		await Effect.runPromise(
			journal.append({
				...base,
				stepId: row.stepId,
				status: row.status,
				at: new Date().toISOString(),
			}),
		);
	}
	return journal;
};

const listen = async () => {
	const handler = await import('../handler.js');
	handler.__setBridgeAsyncStoreForTest(createInMemoryBridgeAsyncStore());
	await new Promise<void>((resolve) => {
		handler.server.listen(0, '127.0.0.1', resolve);
	});
	const address = handler.server.address() as AddressInfo;
	return {
		server: handler.server,
		setFlowJournal: handler.__setFlowJournalForTest,
		baseUrl: `http://127.0.0.1:${address.port}`,
	};
};

describe('GET /internal/flows/:flowId/mermaid', () => {
	let activeServer: Awaited<ReturnType<typeof listen>>['server'] | null = null;

	beforeEach(() => {
		vi.resetModules();
		process.env.ACUITY_BASE_URL = 'https://example.as.me';
		process.env.SERVICES_JSON = JSON.stringify([]);
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

	it('renders the booking FlowPlan as text/plain mermaid (no overlay)', async () => {
		process.env.AUTH_TOKEN = 'mermaid-token';
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/flows/booking_create_with_payment/mermaid`,
			{ headers: { Authorization: 'Bearer mermaid-token' } },
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/plain');
		expect(await response.text()).toBe(BOOKING_DIAGRAM);
	});

	it('overlays per-step journal status when ?operationId= is provided', async () => {
		process.env.AUTH_TOKEN = 'mermaid-token';
		const running = await listen();
		activeServer = running.server;
		running.setFlowJournal(await seedJournal('op-overlay-1'));

		const response = await fetch(
			`${running.baseUrl}/internal/flows/booking_create_with_payment/mermaid?operationId=op-overlay-1`,
			{ headers: { Authorization: 'Bearer mermaid-token' } },
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(BOOKING_DIAGRAM_WITH_OVERLAY);
	});

	it('renders an unmarked diagram for an operationId with no journal rows', async () => {
		process.env.AUTH_TOKEN = 'mermaid-token';
		const running = await listen();
		activeServer = running.server;
		running.setFlowJournal(createInMemoryFlowJournal());

		const response = await fetch(
			`${running.baseUrl}/internal/flows/booking_create_with_payment/mermaid?operationId=unknown-op`,
			{ headers: { Authorization: 'Bearer mermaid-token' } },
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(BOOKING_DIAGRAM);
	});

	it('404s unknown flow ids', async () => {
		process.env.AUTH_TOKEN = 'mermaid-token';
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(`${running.baseUrl}/internal/flows/nope/mermaid`, {
			headers: { Authorization: 'Bearer mermaid-token' },
		});
		expect(response.status).toBe(404);
	});

	it('rejects requests without the bearer token (401)', async () => {
		process.env.AUTH_TOKEN = 'mermaid-token';
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/flows/booking_create_with_payment/mermaid`,
		);
		expect(response.status).toBe(401);
	});

	it('is invisible (404) when AUTH_TOKEN is unconfigured', async () => {
		const running = await listen();
		activeServer = running.server;

		const response = await fetch(
			`${running.baseUrl}/internal/flows/booking_create_with_payment/mermaid`,
		);
		expect(response.status).toBe(404);
	});
});
