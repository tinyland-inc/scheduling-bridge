/**
 * CalComFlowPackLive assembly + registration tests (design §7): the REST pack satisfies
 * the SAME VendorFlowPack Context.Tag as the Acuity browser pack, with REST-backed
 * read-only flows, a response-shape detector, an empty (no-DOM) selector registry, the
 * shared service-matcher machinery, and the native payment-injection declaration.
 * TIN-2097 (Lane E).
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { VendorFlowPack } from '../../../flow/vendor.js';
import {
	CalComFlowPackLive,
	calcomFlowPack,
	calcomSelectorRegistry,
	detectCalComStation,
	detectCalComStationFromResponse,
	CALCOM_STATIONS,
} from '../flow-pack.js';
import { calcomFlows } from '../flows.js';

describe('CalComFlowPackLive', () => {
	it('assembles the read-only REST pack', () => {
		expect(calcomFlowPack.backend).toBe('calcom');
		expect(calcomFlowPack.stations).toEqual(CALCOM_STATIONS);
		expect(calcomFlowPack.paymentInjection).toBe('native');
		expect(calcomFlowPack.flows).toBe(calcomFlows);
		expect(calcomFlowPack.matchers.service.threshold).toBeGreaterThan(0);
	});

	it('is provided behind the VendorFlowPack tag via Layer substitution', async () => {
		const pack = await Effect.runPromise(Effect.provide(VendorFlowPack, CalComFlowPackLive));
		expect(pack).toBe(calcomFlowPack);
	});

	it('registers the read-only availability flows under the shared BridgeJobKind ids', () => {
		expect(Object.keys(calcomFlowPack.flows).sort()).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
		]);
	});

	it('matchers.service resolves through the shared ServiceResolver strategy cascade', async () => {
		const resolution = await Effect.runPromise(
			calcomFlowPack.matchers.service.match({ serviceName: 'Intro Call' }, [
				{ label: 'Intro Call', ref: 'evt-1' },
				{ label: 'Deep Dive', ref: 'evt-2' },
			]),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.value.ref).toBe('evt-1');
	});

	it('selector registry is an empty no-op (REST has no DOM)', async () => {
		expect(calcomSelectorRegistry.resolve('anything')).toEqual([]);
		const fakePage = {} as unknown as Page;
		expect(await Effect.runPromise(calcomSelectorRegistry.probe(fakePage, 'x'))).toBeNull();
		const report = await Effect.runPromise(
			calcomSelectorRegistry.healthCheck(fakePage, ['a', 'b']),
		);
		expect(report.status).toBe('healthy');
		expect(report.passed).toBe(2);
		expect(report.failed).toBe(0);
	});

	it('detectStation (browser-shaped shim) ignores the page and reports unknown', async () => {
		const observation = await Effect.runPromise(detectCalComStation({} as unknown as Page));
		expect(observation.observed).toBe('unknown');
		expect(observation.confidence).toBe(0);
	});

	it('the REAL detector is the response-shape probe at confidence 1.0', () => {
		const present = detectCalComStationFromResponse(
			['calcom:slots'],
			{ data: { slots: { '2026-07-02': [{ start: '2026-07-02T13:00:00.000Z' }] } } },
		);
		expect(present.observed).toBe('calcom:slots');
		expect(present.confidence).toBe(1);

		const absent = detectCalComStationFromResponse(['calcom:slots'], { error: 'nope' });
		expect(absent.observed).toBe('unknown');
		expect(absent.confidence).toBe(0);
	});
});
