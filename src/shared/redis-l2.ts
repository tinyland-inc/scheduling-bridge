import { randomBytes } from 'node:crypto';

import { Context, Data, Effect, Layer } from 'effect';
import type { Redis as IORedis, RedisOptions } from 'ioredis';
import { Redis as IORedisImpl } from 'ioredis';

import { metrics } from './metrics.js';

/**
 * RedisL2 — Effect-wrapped ioredis client with SETNX single-flight `getCached`.
 *
 * Scope: this module is the L2 (networked) cache layer for the acuity-middleware
 * bridge. Paper-critical: correctness over brevity.
 *
 * Contract:
 *   - Values are JSON-serialized with `JSON.stringify` / `JSON.parse`.
 *     Dates are NOT revived — callers must parse ISO strings themselves.
 *   - Single-flight semantics are "degraded": after a 10s wait, a loser falls
 *     through to run `mk` itself rather than hang. Correctness > perfection.
 *   - Lock release uses a Lua CAS (GET-then-DEL if token matches) so expired
 *     holders cannot delete a successor's lock.
 */

// ─── Tagged errors ───────────────────────────────────────────────────────────
// Typed errors let retry schedules target RedisError specifically (instead of
// swallowing UnknownException from tryPromise with no catch).

export class RedisError extends Data.TaggedError('RedisError')<{
	readonly cause: unknown;
}> {}

export class CacheTimeoutError extends Data.TaggedError('CacheTimeoutError')<{
	readonly key: string;
}> {}

// ─── Service tag ─────────────────────────────────────────────────────────────

export class RedisL2 extends Context.Tag('scheduling-bridge/RedisL2')<RedisL2, IORedis>() {}

// ─── Layer ───────────────────────────────────────────────────────────────────
// `Layer.scoped` + `Effect.acquireRelease` ensures the ioredis connection's
// `quit()` runs when the scope closes. `Layer.effect` would leak the socket.
//
// Pitfalls avoided:
//   - `lazyConnect: true` → hides connection failures until first command.
//     Leave default so startup fails fast.
//   - Default `maxRetriesPerRequest` (20) amplifies Effect-schedule retries.
//     Cap to 3.

export const RedisL2Live = (url: string, opts?: RedisOptions) =>
	Layer.scoped(
		RedisL2,
		Effect.acquireRelease(
			Effect.sync(() => {
				const c = new IORedisImpl(url, { maxRetriesPerRequest: 3, ...opts });
				c.on('error', (e) => {
					// Forward client-level errors to stderr. Callers that want
					// structured logging should wrap RedisL2Live with their own
					// layer observer.
					console.error('[redis-l2] client error', e);
				});
				return c;
			}),
			(c) =>
				Effect.promise(() =>
					c.quit().then(
						() => undefined,
						() => undefined,
					),
				),
		),
	);

// ─── Lua CAS release ─────────────────────────────────────────────────────────
// Standard Redis single-flight release idiom. The Lua script runs server-side
// inside Redis (not JS eval). Compares token, deletes only if still owned —
// prevents expired holders from stomping on a successor's lock.

const LUA_CAS_DEL = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

// ─── Constants ───────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 30_000;
const POLL_INTERVAL_MS = 50;
const MAX_WAIT_MS = 10_000;
const lockKey = (k: string) => `lock:${k}`;

// ─── getCached — SETNX single-flight ─────────────────────────────────────────

/**
 * Cache-aside with single-flight coordination via Redis SETNX.
 *
 * Flow:
 *   1. Fast path: GET key. If hit, JSON.parse and return.
 *   2. Miss: try `SET lock:k <token> PX 30000 NX`.
 *      - "OK" → winner: run mk, write cache with `EX ttlSeconds`, release
 *        lock via server-side Lua CAS script.
 *      - null → loser: poll cache every 50ms for up to 10s.
 *   3. Loser timeout: fall through and run mk ourselves (degraded mode —
 *      logged so operators can see it).
 *
 * Release uses `Effect.ensuring` rather than try/finally so interrupts still
 * trigger the Lua CAS release.
 */
export const getCached = <A>(
	key: string,
	ttlSeconds: number,
	mk: () => Promise<A>,
): Effect.Effect<A, RedisError | CacheTimeoutError, RedisL2> =>
	Effect.gen(function* () {
		const client = yield* RedisL2;

		// ── Fast path: cache hit ──
		const hit = yield* Effect.tryPromise({
			try: () => client.get(key),
			catch: (e) => new RedisError({ cause: e }),
		});
		if (hit !== null) {
			// L2 hit: cached value served without running mk. Record as a cache
			// hit so the derived `acuity_cache_hit_ratio` gauge reflects actual
			// networked-cache effectiveness.
			metrics.recordCacheHit();
			return JSON.parse(hit) as A;
		}

		// ── Try to acquire single-flight lock ──
		const token = randomBytes(16).toString('hex');
		const acquired = yield* Effect.tryPromise({
			try: () => client.set(lockKey(key), token, 'PX', LOCK_TTL_MS, 'NX'),
			catch: (e) => new RedisError({ cause: e }),
		});

		if (acquired === 'OK') {
			// Winner path. Use Effect.ensuring so interrupts still release.
			const releaseLock = Effect.tryPromise({
				try: () => client.eval(LUA_CAS_DEL, 1, lockKey(key), token),
				catch: (e) => new RedisError({ cause: e }),
			}).pipe(Effect.ignore);

			// Record that this pod won the lock and is about to run mk.
			// prom-client's Histogram.startTimer returns `endTimer()` — we
			// invoke it once mk settles (success or failure) so duration
			// observations match wall-time cost of the scrape.
			yield* Effect.sync(() => {
				metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_winner' });
				// Winner path runs mk against the origin — this is a cache miss
				// from the ratio's perspective.
				metrics.recordCacheMiss();
			});
			const endTimer = metrics.serviceCatalogRefreshDuration.startTimer();

			return yield* Effect.gen(function* () {
				const value = yield* Effect.tryPromise({
					try: () => mk(),
					catch: (e) => new RedisError({ cause: e }),
				});
				yield* Effect.tryPromise({
					try: () => client.set(key, JSON.stringify(value), 'EX', ttlSeconds),
					catch: (e) => new RedisError({ cause: e }),
				});
				return value;
			}).pipe(
				Effect.ensuring(Effect.sync(() => endTimer())),
				Effect.ensuring(releaseLock),
			);
		}

		// ── Loser path: poll for cache ──
		const deadline = Date.now() + MAX_WAIT_MS;
		while (Date.now() < deadline) {
			yield* Effect.sleep(`${POLL_INTERVAL_MS} millis`);
			const v = yield* Effect.tryPromise({
				try: () => client.get(key),
				catch: (e) => new RedisError({ cause: e }),
			});
			if (v !== null) {
				// Cache became fresh while we polled — the winner in some other
				// pod ran mk on our behalf. Count this as a lock_loser scrape
				// so the SLI can distinguish "we scraped" vs "somebody else did".
				yield* Effect.sync(() => {
					metrics.serviceCatalogScrapeTotal.inc({ source: 'lock_loser' });
					// From this pod's perspective, another pod served us a
					// cached value — count as a cache hit.
					metrics.recordCacheHit();
				});
				return JSON.parse(v) as A;
			}
		}

		// ── Degraded single-flight: loser timed out, run mk itself ──
		// We log the path so operators can detect it in production. We do not
		// attempt to write the cache here — another winner may be about to.
		console.warn(
			`[redis-l2] loser timeout ${MAX_WAIT_MS}ms on key=${key}, falling through`,
		);
		yield* Effect.sync(() => metrics.recordCacheMiss());
		const fallback = yield* Effect.tryPromise({
			try: () => mk(),
			catch: (e) => new RedisError({ cause: e }),
		});
		return fallback;
	});
