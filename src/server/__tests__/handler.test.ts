/**
 * Tests for the /ready real-liveness probe.
 *
 * Tests are written against `runReadyChecks` and `sendReadyResponse` from
 * `src/server/ready.ts`, which accept injected dependencies so we avoid
 * launching a real browser or Redis connection.
 *
 * Integration-style HTTP tests (`GET /ready`) use the exported `server` from
 * `handler.ts` but rely on `vi.mock` to intercept the module-level singletons
 * before they are initialised.
 */

import { describe, expect, it } from 'vitest';
import { runReadyChecks, sendReadyResponse, handleReady } from '../ready.js';
import type { ReadyDeps, ReadyChecks } from '../ready.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal deps where every check passes. */
const happyDeps = (): ReadyDeps => ({
	redisPing: async () => 'PONG',
	browserConnected: async () => true,
	catalogL1Count: () => 3,
	catalogL2Exists: null,
	browserTimeoutMs: 500,
});

// We need a response mock that tracks status separately from the object literal
// so writtenStatus updates are visible after the call.
interface MockRes {
	status: number;
	body: () => unknown;
	raw: import('node:http').ServerResponse;
}

const makeRes = (): MockRes => {
	let status = 0;
	const chunks: string[] = [];
	const raw = {
		writeHead(s: number) {
			status = s;
		},
		end(chunk: string) {
			chunks.push(chunk);
		},
	} as unknown as import('node:http').ServerResponse;
	return {
		get status() {
			return status;
		},
		body: () => JSON.parse(chunks.join('')),
		raw,
	};
};

// ---------------------------------------------------------------------------
// runReadyChecks unit tests
// ---------------------------------------------------------------------------

describe('runReadyChecks', () => {
	it('returns all ok when browser + redis + catalog are healthy (L1)', async () => {
		const checks = await runReadyChecks(happyDeps());

		expect(checks.redis).toBe('ok');
		expect(checks.browser).toBe('ok');
		expect(checks.catalog).toEqual({ status: 'ok', size: 3, source: 'l1' });
	});

	it('returns redis: unreachable when redis ping fails', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			redisPing: async () => { throw new Error('ECONNREFUSED'); },
		};
		const checks = await runReadyChecks(deps);

		expect(checks.redis).toBe('unreachable');
		expect(checks.browser).toBe('ok');
		expect(checks.catalog.status).toBe('ok');
	});

	it('returns browser: unavailable when browser probe returns false', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			browserConnected: async () => false,
		};
		const checks = await runReadyChecks(deps);

		expect(checks.redis).toBe('ok');
		expect(checks.browser).toBe('unavailable');
	});

	it('returns browser: unavailable when browser probe rejects', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			browserConnected: async () => { throw new Error('browser crashed'); },
		};
		const checks = await runReadyChecks(deps);

		expect(checks.browser).toBe('unavailable');
	});

	it('returns browser: timeout when browser probe exceeds timeout', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			browserConnected: () =>
				new Promise((resolve) => setTimeout(() => resolve(true), 5000)),
			browserTimeoutMs: 50,
		};
		const checks = await runReadyChecks(deps);

		expect(checks.browser).toBe('timeout');
	});

	it('returns catalog: empty when L1 is empty and L2 is not configured', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: null,
		};
		const checks = await runReadyChecks(deps);

		expect(checks.catalog).toEqual({ status: 'empty' });
	});

	it('returns catalog: empty when L1 is empty and L2 key does not exist', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
		};
		const checks = await runReadyChecks(deps);

		expect(checks.catalog).toEqual({ status: 'empty' });
	});

	it('warms catalog when Redis and browser are ok but L1/L2 are empty', async () => {
		let warmCalls = 0;
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
			catalogWarm: async () => {
				warmCalls += 1;
				return 10;
			},
		};
		const checks = await runReadyChecks(deps);

		expect(warmCalls).toBe(1);
		expect(checks.catalog).toEqual({ status: 'ok', size: 10, source: 'warmup' });
	});

	it('does not warm catalog when Redis is unreachable', async () => {
		let warmCalls = 0;
		const deps: ReadyDeps = {
			...happyDeps(),
			redisPing: async () => { throw new Error('ECONNREFUSED'); },
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
			catalogWarm: async () => {
				warmCalls += 1;
				return 10;
			},
		};
		const checks = await runReadyChecks(deps);

		expect(warmCalls).toBe(0);
		expect(checks.redis).toBe('unreachable');
		expect(checks.catalog).toEqual({ status: 'empty' });
	});

	it('returns catalog error when cold-start warmup fails', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
			catalogWarm: async () => { throw new Error('acuity unavailable'); },
		};
		const checks = await runReadyChecks(deps);

		expect(checks.catalog).toEqual({ status: 'error', error: 'acuity unavailable' });
	});

	it('returns catalog ok with source l2 when L1 is empty but L2 has data', async () => {
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 1,
		};
		const checks = await runReadyChecks(deps);

		expect(checks.catalog).toEqual({ status: 'ok', size: 0, source: 'l2' });
	});

	it('skips redis check when redisPing is null (local dev mode)', async () => {
		const deps: ReadyDeps = { ...happyDeps(), redisPing: null };
		const checks = await runReadyChecks(deps);

		expect(checks.redis).toBe('ok');
	});
});

// ---------------------------------------------------------------------------
// sendReadyResponse unit tests
// ---------------------------------------------------------------------------

describe('sendReadyResponse', () => {
	it('writes HTTP 200 when all checks pass', () => {
		const mock = makeRes();
		const checks: ReadyChecks = {
			redis: 'ok',
			browser: 'ok',
			catalog: { status: 'ok', size: 5, source: 'l1' },
		};

		sendReadyResponse(mock.raw, checks);

		expect(mock.status).toBe(200);
		expect(mock.body()).toMatchObject({ status: 'ready' });
	});

	it('writes HTTP 503 when redis is unreachable', () => {
		const mock = makeRes();
		const checks: ReadyChecks = {
			redis: 'unreachable',
			browser: 'ok',
			catalog: { status: 'ok', size: 5, source: 'l1' },
		};

		sendReadyResponse(mock.raw, checks);

		expect(mock.status).toBe(503);
		expect(mock.body()).toMatchObject({ status: 'not_ready', checks: { redis: 'unreachable' } });
	});

	it('writes HTTP 503 when browser is unavailable', () => {
		const mock = makeRes();
		const checks: ReadyChecks = {
			redis: 'ok',
			browser: 'unavailable',
			catalog: { status: 'ok', size: 2, source: 'l1' },
		};

		sendReadyResponse(mock.raw, checks);

		expect(mock.status).toBe(503);
		expect(mock.body()).toMatchObject({ status: 'not_ready', checks: { browser: 'unavailable' } });
	});

	it('writes HTTP 503 when catalog is empty', () => {
		const mock = makeRes();
		const checks: ReadyChecks = {
			redis: 'ok',
			browser: 'ok',
			catalog: { status: 'empty' },
		};

		sendReadyResponse(mock.raw, checks);

		expect(mock.status).toBe(503);
		expect(mock.body()).toMatchObject({ status: 'not_ready', checks: { catalog: { status: 'empty' } } });
	});

	it('response body includes checks object', () => {
		const mock = makeRes();
		const checks: ReadyChecks = {
			redis: 'ok',
			browser: 'ok',
			catalog: { status: 'ok', size: 7, source: 'l2' },
		};

		sendReadyResponse(mock.raw, checks);

		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.checks).toEqual(checks);
	});
});

// ---------------------------------------------------------------------------
// handleReady integration (uses runReadyChecks + sendReadyResponse together)
// ---------------------------------------------------------------------------

describe('handleReady', () => {
	it('returns 200 with all checks passing when browser + redis + catalog healthy', async () => {
		const mock = makeRes();

		await handleReady(mock.raw, happyDeps());

		expect(mock.status).toBe(200);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.status).toBe('ready');
		expect(body.checks.redis).toBe('ok');
		expect(body.checks.browser).toBe('ok');
		expect(body.checks.catalog).toMatchObject({ status: 'ok' });
	});

	it('returns 503 with redis: unreachable when redis ping fails', async () => {
		const mock = makeRes();
		const deps: ReadyDeps = {
			...happyDeps(),
			redisPing: async () => { throw new Error('ECONNREFUSED'); },
		};

		await handleReady(mock.raw, deps);

		expect(mock.status).toBe(503);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.status).toBe('not_ready');
		expect(body.checks.redis).toBe('unreachable');
	});

	it('returns 503 with browser: unavailable when browser probe fails', async () => {
		const mock = makeRes();
		const deps: ReadyDeps = {
			...happyDeps(),
			browserConnected: async () => false,
		};

		await handleReady(mock.raw, deps);

		expect(mock.status).toBe(503);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.checks.browser).toBe('unavailable');
	});

	it('returns 503 with catalog: empty when catalog is empty and L2 also empty', async () => {
		const mock = makeRes();
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
		};

		await handleReady(mock.raw, deps);

		expect(mock.status).toBe(503);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.checks.catalog).toEqual({ status: 'empty' });
	});

	it('returns 200 after catalog cold-start warmup succeeds', async () => {
		const mock = makeRes();
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 0,
			catalogWarm: async () => 10,
		};

		await handleReady(mock.raw, deps);

		expect(mock.status).toBe(200);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.status).toBe('ready');
		expect(body.checks.catalog).toEqual({ status: 'ok', size: 10, source: 'warmup' });
	});

	it('returns 200 with catalog.source: "l2" when L1 empty but L2 has data', async () => {
		const mock = makeRes();
		const deps: ReadyDeps = {
			...happyDeps(),
			catalogL1Count: () => 0,
			catalogL2Exists: async () => 1,
		};

		await handleReady(mock.raw, deps);

		expect(mock.status).toBe(200);
		const body = mock.body() as { status: string; checks: ReadyChecks };
		expect(body.checks.catalog).toEqual({ status: 'ok', size: 0, source: 'l2' });
	});
});
