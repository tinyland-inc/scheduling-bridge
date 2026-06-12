/**
 * StepMeta wrapper unit tests: the pure adaptation helpers (client state
 * normalization, landing observations, bypass-proof predicate) and the
 * business-extraction wrapper run against a substituted BrowserService.
 */

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { BrowserService, defaultBrowserConfig } from '../../../shared/browser-service.js';
import {
	acuityExtractBusinessStep,
	fromClientState,
	isAcuityAppointmentTypeId,
	isPaymentBypassProven,
	landingObservation,
	landingStepToStation,
	toClientState,
} from '../flow-steps.js';

describe('client state normalization', () => {
	it('round-trips ClientInfo through the JSON-encodable null-normalized shape', () => {
		const client = {
			firstName: 'Jess',
			lastName: 'Sullivan',
			email: 'jess@example.com',
			phone: '6075551212',
			customFields: { pronouns: 'she/her' },
		};
		const state = toClientState(client);
		expect(state).toEqual({
			firstName: 'Jess',
			lastName: 'Sullivan',
			email: 'jess@example.com',
			phone: '6075551212',
			notes: null,
			customFields: { pronouns: 'she/her' },
		});
		expect(fromClientState(state)).toEqual({
			firstName: 'Jess',
			lastName: 'Sullivan',
			email: 'jess@example.com',
			phone: '6075551212',
			notes: undefined,
			customFields: { pronouns: 'she/her' },
		});
	});
});

describe('landing observation mapping (fuzzy-out)', () => {
	it('maps known landing steps onto acuity:* stations with probe evidence', () => {
		expect(landingStepToStation('client-form')).toBe('acuity:client-form');
		expect(landingStepToStation('unknown')).toBe('unknown');

		const observation = landingObservation(['acuity:client-form'], 'time-slots');
		expect(observation.observed).toBe('acuity:time-slots');
		expect(observation.confidence).toBe(1);
		expect(observation.evidence).toEqual([
			{ kind: 'selector', key: 'timeSlot', matched: true },
		]);
	});

	it('reports an unknown landing with the full failed probe trail', () => {
		const observation = landingObservation(['acuity:client-form'], 'unknown');
		expect(observation.observed).toBe('unknown');
		expect(observation.confidence).toBe(0);
		expect(observation.evidence).toHaveLength(4);
		expect(observation.evidence.every((e) => !e.matched)).toBe(true);
	});
});

describe('isPaymentBypassProven (worker assertPaymentBypassProven parity)', () => {
	it('accepts only applied coupons with a parsed $0 total', () => {
		expect(
			isPaymentBypassProven({ couponApplied: true, totalAfterCoupon: '$0.00' }),
		).toBe(true);
		expect(
			isPaymentBypassProven({ couponApplied: true, totalAfterCoupon: '$5.00' }),
		).toBe(false);
		expect(
			isPaymentBypassProven({ couponApplied: false, totalAfterCoupon: '$0.00' }),
		).toBe(false);
		expect(
			isPaymentBypassProven({ couponApplied: true, totalAfterCoupon: null }),
		).toBe(false);
	});
});

describe('isAcuityAppointmentTypeId (worker dispatch parity)', () => {
	it('matches numeric appointment-type ids only', () => {
		expect(isAcuityAppointmentTypeId('53178494')).toBe(true);
		expect(isAcuityAppointmentTypeId('relaxation-massage')).toBe(false);
		expect(isAcuityAppointmentTypeId('')).toBe(false);
	});
});

describe('acuity/extract-business wrapper', () => {
	it('projects window.BUSINESS into the JSON service vocabulary (body untouched)', async () => {
		const fakePage = {
			goto: async () => null,
			evaluate: async () => ({
				id: 1,
				ownerKey: 'key',
				name: 'Biz',
				timezone: 'America/New_York',
				appointmentTypes: {
					'1 TMD': [
						{
							id: 53178494,
							name: 'TMD single session',
							active: true,
							private: false,
							description: '',
							duration: 30,
							price: '105.00',
							category: 'TMD',
							color: '',
							type: 'service',
							calendarIDs: [],
							formIDs: [],
							addonIDs: [],
							paddingAfter: 0,
							paddingBefore: 0,
							paymentRequired: true,
							classSize: null,
						},
					],
				},
				calendars: {},
				products: {},
				forms: [],
				addons: [],
			}),
			url: () => 'https://example.as.me',
		};
		const fakeService = {
			acquirePage: Effect.succeed(fakePage as never),
			screenshot: () => Effect.succeed(Buffer.from('')),
			config: { ...defaultBrowserConfig },
		};

		const outcome = await Effect.runPromise(
			acuityExtractBusinessStep.run({}).pipe(
				Effect.provideService(BrowserService, fakeService as never),
				Effect.scoped,
			),
		);

		expect(outcome.state.services).toEqual([
			{
				id: '53178494',
				name: 'TMD single session',
				duration: 30,
				price: 10500,
				currency: 'USD',
				category: 'TMD',
				active: true,
			},
		]);
	});
});
