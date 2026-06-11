/**
 * Real-liveness readiness probe for K8s /ready endpoint.
 *
 * All dependencies are injected so this module is fully unit-testable without
 * starting a real browser or Redis connection.
 */

import type { ServerResponse } from 'node:http';

// =============================================================================
// TYPES
// =============================================================================

export type RedisStatus = 'ok' | 'unreachable';
export type BrowserStatus = 'ok' | 'unavailable' | 'timeout';

export type CatalogResult =
	| { status: 'ok'; size: number; source: 'l1' | 'l2' | 'warmup' }
	| { status: 'empty' }
	| { status: 'error'; error: string };

export interface ReadyChecks {
	redis: RedisStatus;
	browser: BrowserStatus;
	catalog: CatalogResult;
}

export interface ReadyDeps {
	/** Ping Redis — resolves to 'PONG' on success, rejects on failure. */
	redisPing: (() => Promise<string>) | null;
	/** Probe browser liveness — resolves to true if browser is connected. */
	browserConnected: () => Promise<boolean>;
	/** Count of services in the L1 in-process cache (synchronous). */
	catalogL1Count: () => number;
	/** Check if the catalog key exists in L2 Redis (1 = yes, 0/null = no/error). */
	catalogL2Exists: (() => Promise<number | null>) | null;
	/** Populate the catalog when readiness sees a cold empty cache. Returns the warmed service count. */
	catalogWarm?: () => Promise<number>;
	/** Timeout in ms for the browser probe (default: 2000). */
	browserTimeoutMs?: number;
	/** Timeout in ms for the optional catalog warmup (default: 3000). */
	catalogWarmTimeoutMs?: number;
}

// =============================================================================
// PROBE HELPERS
// =============================================================================

const BROWSER_DEFAULT_TIMEOUT_MS = 2000;
const CATALOG_WARM_DEFAULT_TIMEOUT_MS = 3000;

const probeRedis = async (redisPing: (() => Promise<string>) | null): Promise<RedisStatus> => {
	if (!redisPing) return 'ok';
	try {
		const result = await redisPing();
		return result === 'PONG' ? 'ok' : 'unreachable';
	} catch {
		return 'unreachable';
	}
};

const probeBrowser = async (
	browserConnected: () => Promise<boolean>,
	timeoutMs: number,
): Promise<BrowserStatus> => {
	const check = browserConnected()
		.then((connected) => (connected ? ('ok' as const) : ('unavailable' as const)))
		.catch(() => 'unavailable' as const);

	const timer = new Promise<'timeout'>((resolve) =>
		setTimeout(() => resolve('timeout'), timeoutMs),
	);

	return Promise.race([check, timer]);
};

const probeCatalog = async (
	catalogL1Count: () => number,
	catalogL2Exists: (() => Promise<number | null>) | null,
): Promise<CatalogResult> => {
	try {
		const l1Count = catalogL1Count();
		if (l1Count > 0) {
			return { status: 'ok', size: l1Count, source: 'l1' };
		}

		if (catalogL2Exists) {
			const exists = await catalogL2Exists().catch(() => null);
			if (exists === 1) {
				// size: 0 on L2 hit — EXISTS does not deserialize the payload.
				// A consumer that needs the real size must GET the key; /ready stays cheap.
				return { status: 'ok', size: 0, source: 'l2' };
			}
		}

		return { status: 'empty' };
	} catch (e) {
		return { status: 'error', error: e instanceof Error ? e.message : String(e) };
	}
};

const withTimeout = async <A>(
	fn: () => Promise<A>,
	timeoutMs: number,
	onTimeout: () => A,
): Promise<A> => {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			fn(),
			new Promise<A>((resolve) => {
				timeout = setTimeout(() => resolve(onTimeout()), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
};

const probeCatalogWarm = async (
	catalogWarm: () => Promise<number>,
	timeoutMs: number,
): Promise<CatalogResult> => {
	try {
		const warmedCount = await withTimeout(
			catalogWarm,
			timeoutMs,
			() => Number.NaN,
		);

		if (!Number.isFinite(warmedCount)) {
			return { status: 'error', error: 'catalog warmup timed out' };
		}

		if (warmedCount > 0) {
			return { status: 'ok', size: warmedCount, source: 'warmup' };
		}

		return { status: 'empty' };
	} catch (e) {
		return { status: 'error', error: e instanceof Error ? e.message : String(e) };
	}
};

// =============================================================================
// READINESS CHECK
// =============================================================================

/**
 * Run all liveness sub-checks in parallel and return a structured result.
 * Never throws — all errors are captured in the returned checks object.
 */
export const runReadyChecks = async (deps: ReadyDeps): Promise<ReadyChecks> => {
	const timeoutMs = deps.browserTimeoutMs ?? BROWSER_DEFAULT_TIMEOUT_MS;
	const catalogWarmTimeoutMs =
		deps.catalogWarmTimeoutMs ?? CATALOG_WARM_DEFAULT_TIMEOUT_MS;

	const [redis, browser, catalog] = await Promise.all([
		probeRedis(deps.redisPing),
		probeBrowser(deps.browserConnected, timeoutMs),
		probeCatalog(deps.catalogL1Count, deps.catalogL2Exists),
	]);

	if (
		redis === 'ok' &&
		browser === 'ok' &&
		catalog.status === 'empty' &&
		deps.catalogWarm
	) {
		return {
			redis,
			browser,
			catalog: await probeCatalogWarm(deps.catalogWarm, catalogWarmTimeoutMs),
		};
	}

	return { redis, browser, catalog };
};

/**
 * Write a `/ready` HTTP response based on the provided checks result.
 * HTTP 200 when all checks pass; 503 otherwise.
 */
export const sendReadyResponse = (res: ServerResponse, checks: ReadyChecks): void => {
	const allOk =
		checks.redis === 'ok' && checks.browser === 'ok' && checks.catalog.status === 'ok';

	res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
	res.end(
		JSON.stringify({
			status: allOk ? 'ready' : 'not_ready',
			checks,
		}),
	);
};

/**
 * Full `/ready` handler: run checks then send HTTP response.
 */
export const handleReady = async (res: ServerResponse, deps: ReadyDeps): Promise<void> => {
	const checks = await runReadyChecks(deps);
	sendReadyResponse(res, checks);
};
