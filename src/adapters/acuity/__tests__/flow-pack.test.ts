/**
 * AcuityFlowPackLive assembly tests (design §7): the pack is built from the EXISTING
 * un-extracted pieces — selectors.ts in place, detectLandingStep adapted as
 * detectStation, the ServiceResolver scorers behind the shared matcher machinery —
 * with the three registered flows and the coupon-bypass payment-injection
 * declaration.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import { VendorFlowPack } from '../../../flow/vendor.js';
import {
	AcuityFlowPackLive,
	acuityFlowPack,
	acuitySelectorRegistry,
	detectAcuityStation,
} from '../flow-pack.js';
import { ACUITY_STATIONS } from '../flow-steps.js';
import { acuityFlows } from '../flows.js';
import { Selectors } from '../selectors.js';

/** Fake page: matches any selector for which `match` returns true. */
const fakePage = (match: (selector: string) => boolean): Page =>
	({
		$: async (selector: string) => (match(selector) ? {} : null),
		url: () => 'https://example.as.me/schedule/abc',
	}) as unknown as Page;

describe('AcuityFlowPackLive', () => {
	it('assembles the pack from the existing pieces', () => {
		expect(acuityFlowPack.backend).toBe('acuity');
		expect(acuityFlowPack.stations).toEqual(ACUITY_STATIONS);
		expect(acuityFlowPack.paymentInjection).toBe('coupon-bypass');
		expect(acuityFlowPack.flows).toBe(acuityFlows);
		expect(acuityFlowPack.matchers.service.threshold).toBeGreaterThan(0);
	});

	it('is provided behind the VendorFlowPack tag via Layer substitution', async () => {
		const pack = await Effect.runPromise(
			Effect.provide(VendorFlowPack, AcuityFlowPackLive),
		);
		expect(pack).toBe(acuityFlowPack);
	});

	it('matchers.service resolves through the ServiceResolver strategy cascade', async () => {
		const resolution = await Effect.runPromise(
			acuityFlowPack.matchers.service.match(
				{ serviceName: 'TMD Single Session' },
				[
					{ label: 'TMD single session', ref: '53178494' },
					{ label: 'Relaxation Massage', ref: '111' },
				],
			),
		);
		expect(resolution.strategy).toBe('normalized-exact');
		expect(resolution.value.ref).toBe('53178494');
		expect(resolution.alternates).toHaveLength(1);
	});

	it('selector registry resolves fallback chains from selectors.ts in place', () => {
		expect(acuitySelectorRegistry.resolve('firstNameInput')).toBe(
			Selectors.firstNameInput,
		);
		expect(acuitySelectorRegistry.resolve('nope-no-such-key')).toEqual([]);
	});

	it('selector registry probes and health-checks against a page', async () => {
		const primary = Selectors.firstNameInput[0];
		const page = fakePage((selector) => selector === primary);
		const probed = await Effect.runPromise(
			acuitySelectorRegistry.probe(page, 'firstNameInput'),
		);
		expect(probed).toBe(primary);

		const report = await Effect.runPromise(
			acuitySelectorRegistry.healthCheck(page, ['firstNameInput', 'timeSlot']),
		);
		expect(report.passed).toBe(1);
		expect(report.failed).toBe(1);
		expect(report.status).toBe('unhealthy');
		expect(report.selectors.map((s) => s.key)).toEqual([
			'firstNameInput',
			'timeSlot',
		]);
	});

	it('detectStation mirrors detectLandingStep probe order with evidence', async () => {
		const clientFormPage = fakePage((selector) =>
			(Selectors.firstNameInput as readonly string[]).includes(selector),
		);
		const observation = await Effect.runPromise(detectAcuityStation(clientFormPage));
		expect(observation.observed).toBe('acuity:client-form');
		expect(observation.confidence).toBe(1);
		expect(observation.evidence).toEqual([
			{ kind: 'selector', key: 'firstNameInput', matched: true },
		]);

		const blankPage = fakePage(() => false);
		const unknown = await Effect.runPromise(detectAcuityStation(blankPage));
		expect(unknown.observed).toBe('unknown');
		expect(unknown.confidence).toBe(0);
		expect(unknown.evidence.map((e) => e.key)).toEqual([
			'firstNameInput',
			'timeSlot',
			'calendarDay',
			'serviceList',
		]);
		expect(unknown.evidence.every((e) => !e.matched)).toBe(true);
	});
});
