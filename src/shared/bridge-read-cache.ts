import { randomBytes } from "node:crypto";
import { metrics } from "./metrics.js";

export interface BridgeReadCacheClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    ...args: Array<string | number>
  ): Promise<unknown>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export type BridgeReadResult<A, E> =
  | { ok: true; value: A }
  | { ok: false; error: E };

export interface BridgeReadCacheEvent {
  readonly event:
    | "bridge_read_cache_hit"
    | "bridge_read_cache_wait"
    | "bridge_read_cache_wait_timeout"
    | "bridge_read_cache_get_failed"
    | "bridge_read_cache_set_failed"
    | "bridge_read_cache_lock_failed"
    | "bridge_read_cache_unlock_failed";
  readonly cacheKind: string;
  readonly waitMs?: number;
  readonly error?: unknown;
}

export interface RunBridgeReadCachedOptions<A, E> {
  readonly redisClient: BridgeReadCacheClient | null;
  readonly cacheKind: string;
  readonly cacheKey: string;
  readonly ttlSeconds: number;
  readonly emptyTtlSeconds: number;
  readonly read: () => Promise<BridgeReadResult<A, E>>;
  readonly shouldCache?: (value: A) => boolean;
  readonly log?: (event: BridgeReadCacheEvent) => void;
  readonly lockTtlMs?: number;
  readonly waitTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly waitTimeoutResult?: (waitMs: number) => BridgeReadResult<A, E>;
}

export const BRIDGE_READ_CACHE_DEFAULTS = {
  lockTtlMs: 90_000,
  waitTimeoutMs: 55_000,
  pollIntervalMs: 50,
} as const;

const LUA_CAS_DEL = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

const lockKey = (key: string): string => `lock:${key}`;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readCached = async <A>(
  client: BridgeReadCacheClient,
  cacheKey: string,
): Promise<A | undefined> => {
  const raw = await client.get(cacheKey);
  return raw ? (JSON.parse(raw) as A) : undefined;
};

const writeCached = async <A>(
  client: BridgeReadCacheClient,
  cacheKey: string,
  value: A,
  ttlSeconds: number,
): Promise<void> => {
  await client.set(cacheKey, JSON.stringify(value), "EX", ttlSeconds);
};

const valueTtlSeconds = <A>(
  value: A,
  ttlSeconds: number,
  emptyTtlSeconds: number,
): number =>
  Array.isArray(value) && value.length === 0 ? emptyTtlSeconds : ttlSeconds;

export const runBridgeReadCached = async <A, E>({
  redisClient,
  cacheKind,
  cacheKey,
  ttlSeconds,
  emptyTtlSeconds,
  read,
  shouldCache,
  log,
  lockTtlMs = BRIDGE_READ_CACHE_DEFAULTS.lockTtlMs,
  waitTimeoutMs = BRIDGE_READ_CACHE_DEFAULTS.waitTimeoutMs,
  pollIntervalMs = BRIDGE_READ_CACHE_DEFAULTS.pollIntervalMs,
  waitTimeoutResult,
}: RunBridgeReadCachedOptions<A, E>): Promise<BridgeReadResult<A, E>> => {
  const record = (event: string): void => {
    metrics.recordBridgeReadCacheEvent(cacheKind, event);
  };
  const observeRead = (): Promise<BridgeReadResult<A, E>> =>
    metrics.observeBridgeRead(cacheKind, read);

  if (!redisClient) {
    record("bypass");
    return observeRead();
  }

  try {
    const cached = await readCached<A>(redisClient, cacheKey);
    if (cached !== undefined) {
      record("hit");
      log?.({ event: "bridge_read_cache_hit", cacheKind });
      return { ok: true, value: cached };
    }
  } catch (error) {
    record("get_failed");
    log?.({ event: "bridge_read_cache_get_failed", cacheKind, error });
    return observeRead();
  }
  record("miss");

  const token = randomBytes(16).toString("hex");
  const keyLock = lockKey(cacheKey);
  let acquired = false;
  try {
    acquired =
      (await redisClient.set(keyLock, token, "PX", lockTtlMs, "NX")) === "OK";
  } catch (error) {
    record("lock_failed");
    log?.({ event: "bridge_read_cache_lock_failed", cacheKind, error });
    return observeRead();
  }

  if (acquired) {
    try {
      record("lock_winner");
      const result = await observeRead();
      if (!result.ok) return result;
      if (shouldCache && !shouldCache(result.value)) return result;

      try {
        await writeCached(
          redisClient,
          cacheKey,
          result.value,
          valueTtlSeconds(result.value, ttlSeconds, emptyTtlSeconds),
        );
      } catch (error) {
        record("set_failed");
        log?.({ event: "bridge_read_cache_set_failed", cacheKind, error });
      }

      return result;
    } finally {
      try {
        await redisClient.eval(LUA_CAS_DEL, 1, keyLock, token);
      } catch (error) {
        record("unlock_failed");
        log?.({ event: "bridge_read_cache_unlock_failed", cacheKind, error });
      }
    }
  }

  const startedAt = Date.now();
  const deadline = startedAt + waitTimeoutMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    try {
      const cached = await readCached<A>(redisClient, cacheKey);
      if (cached !== undefined) {
        const waitMs = Date.now() - startedAt;
        record("wait_hit");
        metrics.recordBridgeReadCacheWait(cacheKind, "hit", waitMs);
        log?.({
          event: "bridge_read_cache_wait",
          cacheKind,
          waitMs,
        });
        return { ok: true, value: cached };
      }
    } catch (error) {
      record("get_failed");
      log?.({ event: "bridge_read_cache_get_failed", cacheKind, error });
      break;
    }
  }

  const waitMs = Date.now() - startedAt;
  record("wait_timeout");
  metrics.recordBridgeReadCacheWait(cacheKind, "timeout", waitMs);
  log?.({
    event: "bridge_read_cache_wait_timeout",
    cacheKind,
    waitMs,
  });
  const timeoutResult = waitTimeoutResult?.(waitMs);
  if (timeoutResult) return timeoutResult;

  return observeRead();
};
