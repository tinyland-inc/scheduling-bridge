import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS,
	parseRedisAsyncJobTtlSeconds,
} from './config.js';

describe('async config', () => {
	it('leaves Redis job TTL unset when no env override is configured', () => {
		expect(parseRedisAsyncJobTtlSeconds({})).toBeUndefined();
		expect(DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS).toBe(604800);
	});

	it('parses positive Redis job TTL seconds from env', () => {
		expect(parseRedisAsyncJobTtlSeconds({
			BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS: '900',
		})).toBe(900);
		expect(parseRedisAsyncJobTtlSeconds({
			BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS: '90.9',
		})).toBe(90);
	});

	it('ignores invalid Redis job TTL env values so store defaults apply', () => {
		expect(parseRedisAsyncJobTtlSeconds({
			BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS: '0',
		})).toBeUndefined();
		expect(parseRedisAsyncJobTtlSeconds({
			BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS: '-1',
		})).toBeUndefined();
		expect(parseRedisAsyncJobTtlSeconds({
			BRIDGE_REDIS_ASYNC_JOB_TTL_SECONDS: 'nope',
		})).toBeUndefined();
	});
});
