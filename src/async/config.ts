export const DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

export const parseRedisAsyncJobTtlSeconds = (
	env: Partial<Record<'BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS', string>> = process.env,
): number | undefined => {
	const raw = env.BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS;
	if (!raw) return undefined;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
};
