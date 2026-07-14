import { describe, expect, it } from 'vitest';
import {
	BRIDGE_PROTOCOL_CAPABILITIES,
	BRIDGE_PROTOCOL_ENDPOINTS,
	BRIDGE_PROTOCOL_VERSION,
	buildHealthPayload,
	buildPublicHealthPayload,
} from '../src/server/health.js';

describe('bridge health payload', () => {
	it('exposes release truth and versioned protocol metadata', () => {
		const payload = buildHealthPayload({
			baseUrl: 'https://MassageIthaca.as.me',
			hasCoupon: true,
			headless: true,
			staticServices: 8,
			serviceCacheTtlMs: 300000,
			releaseSha: 'abc123',
			releaseRef: 'refs/heads/main',
			releaseVersion: '0.4.2',
			releaseBuiltAt: '2026-04-16T12:00:00.000Z',
			modalEnvironment: 'main',
			timestamp: '2026-04-16T12:34:56.000Z',
		});

		expect(payload.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
		expect(payload.release).toEqual({
			sha: 'abc123',
			ref: 'refs/heads/main',
			version: '0.4.2',
			builtAt: '2026-04-16T12:00:00.000Z',
			modalEnvironment: 'main',
		});
		expect(payload.protocol).toEqual({
			version: BRIDGE_PROTOCOL_VERSION,
			flowOwner: 'scheduling-bridge',
			backend: 'acuity',
			transport: 'http-json',
			endpoints: BRIDGE_PROTOCOL_ENDPOINTS,
			capabilities: [...BRIDGE_PROTOCOL_CAPABILITIES],
		});
		expect(payload.timestamp).toBe('2026-04-16T12:34:56.000Z');
	});

	it('falls back to unknown release metadata when release env is absent', () => {
		const payload = buildHealthPayload({
			baseUrl: 'https://MassageIthaca.as.me',
			hasCoupon: false,
			headless: true,
			staticServices: 0,
			serviceCacheTtlMs: 300000,
			timestamp: '2026-04-16T12:34:56.000Z',
		});

		expect(payload.releaseSha).toBe('unknown');
		expect(payload.releaseRef).toBe('unknown');
		expect(payload.releaseVersion).toBe('unknown');
		expect(payload.releaseBuiltAt).toBeNull();
		expect(payload.release).toEqual({
			sha: 'unknown',
			ref: 'unknown',
			version: 'unknown',
			builtAt: null,
			modalEnvironment: null,
		});
	});
});

describe('public bridge health payload (TIN-2826)', () => {
	const verboseOptions = {
		baseUrl: 'https://MassageIthaca.as.me',
		hasCoupon: true,
		headless: true,
		staticServices: 8,
		serviceCacheTtlMs: 300000,
		releaseSha: 'abc123',
		releaseRef: 'refs/heads/main',
		releaseVersion: '0.7.1',
		releaseBuiltAt: '2026-07-13T12:00:00.000Z',
		modalEnvironment: 'main',
		timestamp: '2026-07-13T12:34:56.000Z',
	} as const;

	it('exposes ONLY status, protocolVersion, release, and timestamp', () => {
		const payload = buildPublicHealthPayload(verboseOptions);

		expect(Object.keys(payload).sort()).toEqual([
			'protocolVersion',
			'release',
			'status',
			'timestamp',
		]);
		expect(payload.status).toBe('ok');
		expect(payload.protocolVersion).toBe(BRIDGE_PROTOCOL_VERSION);
		expect(payload.release).toEqual({
			sha: 'abc123',
			ref: 'refs/heads/main',
			version: '0.7.1',
			builtAt: '2026-07-13T12:00:00.000Z',
			modalEnvironment: 'main',
		});
		expect(payload.timestamp).toBe('2026-07-13T12:34:56.000Z');
	});

	it('DROPS the information-disclosure fields the verbose payload carries', () => {
		const publicPayload = buildPublicHealthPayload(
			verboseOptions,
		) as Record<string, unknown>;

		// Upstream Acuity URL and the config-validity map.
		expect(publicPayload).not.toHaveProperty('baseUrl');
		expect(publicPayload).not.toHaveProperty('hasCoupon');
		expect(publicPayload).not.toHaveProperty('headless');
		expect(publicPayload).not.toHaveProperty('staticServices');
		expect(publicPayload).not.toHaveProperty('serviceCacheTtlMs');
		// The endpoint list + capability list (incl. booking:create /
		// payment:bypass-coupon) live under `protocol` on the verbose payload.
		expect(publicPayload).not.toHaveProperty('protocol');
		// Flat release duplicates are dropped in favour of the nested block.
		expect(publicPayload).not.toHaveProperty('releaseSha');
		expect(publicPayload).not.toHaveProperty('releaseVersion');

		const raw = JSON.stringify(publicPayload);
		expect(raw).not.toContain('booking:create');
		expect(raw).not.toContain('payment:bypass-coupon');
		expect(raw).not.toContain('MassageIthaca.as.me');
	});

	it('keeps the boot-smoke + probe invariant (status:ok on a 200 body)', () => {
		// scripts/docker-boot-smoke.sh greps the /health body for "status":"ok"
		// (and the sendSuccess wrapper supplies "success":true).
		const payload = buildPublicHealthPayload({
			baseUrl: 'https://MassageIthaca.as.me',
			hasCoupon: false,
			headless: true,
			staticServices: 0,
			serviceCacheTtlMs: 300000,
		});
		expect(payload.status).toBe('ok');
		expect(JSON.stringify(payload)).toContain('"status":"ok"');
	});

	it('serves the release block the estate drift audits read off the public surface', () => {
		// The MassageIthaca aggregator falls back to release.{sha,ref,version,
		// builtAt,modalEnvironment} and root.protocolVersion, so a minimal payload
		// still yields a usable BridgeHealthTuple for version reporting.
		const payload = buildPublicHealthPayload(verboseOptions);
		expect(payload.release.version).toBe('0.7.1');
		expect(payload.release.sha).toBe('abc123');
		expect(payload.protocolVersion).toBe('1.2.0');
	});
});
