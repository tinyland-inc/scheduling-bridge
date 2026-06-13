/**
 * PII-hygiene conformance (design §5 "PII hygiene", risk 9): the booking flow's
 * journaled `stateDelta` must carry NO raw client PII (names/emails/phone/intake
 * answers) nor raw confirmation page text — only the redaction placeholder. This
 * runs the REAL `acuityBookingFlowSpec` through the fold with PII-bearing state,
 * provided by stub steps (no browser), and scans every journaled row for raw PII.
 *
 * The redaction is applied by run.ts's segment-boundary encode using the
 * `redactable(...)` annotations on the spec (flow-steps.ts ClientStateSchema +
 * confirmation.rawText). Every booking segment carries a stateDelta on its LAST
 * node; the payment-injection sub-flow (design §7; TIN-2095) shares one
 * 'bypass-payment' segment, so its `bypass` delta is journaled on the terminal
 * sub-step (verify-zero-total). The scan still covers every provided key's encode.
 */

import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeFlow } from '../../../flow/flow.js';
import { FlowJournal, createInMemoryFlowJournal } from '../../../flow/journal.js';
import { REDACTED_PLACEHOLDER } from '../../../flow/redaction.js';
import { runFlow } from '../../../flow/run.js';
import type { FlowStep } from '../../../flow/step.js';
import {
	ACUITY_BOOKING_INITIAL_KEYS,
	acuityBookingFlowSpec,
	type AcuityBookingFlowSpec,
} from '../flow-steps.js';

type Step = FlowStep<AcuityBookingFlowSpec, any, any, never, never>;

// Distinctive raw PII values; if any reaches the journal verbatim the scan catches it.
const RAW = {
	firstName: 'Janet',
	lastName: 'Quibblesworth',
	email: 'janet.quibblesworth@example.test',
	phone: '+1-555-867-5309',
	notes: 'severe-lavender-allergy-and-l4l5-sciatica',
	customField: 'prefers-firm-pressure-secret-intake-answer',
	confirmationRaw:
		'Thanks Janet Quibblesworth! janet.quibblesworth@example.test booked Deep Tissue.',
} as const;

const step = (
	id: string,
	segment: string,
	needs: readonly string[],
	provides: readonly string[],
	state: Record<string, unknown>,
	idempotency: Step['meta']['idempotency'] = 'replayable-write',
): Step => ({
	meta: {
		id,
		needs: needs as never,
		provides: provides as never,
		expects: [],
		idempotency,
		segment,
		tags: ['mutation'],
		selectorKeys: [],
	},
	run: () => Effect.succeed({ state: state as never }),
});

const bookingFlow = makeFlow(acuityBookingFlowSpec, ACUITY_BOOKING_INITIAL_KEYS)
	.add(
		step('acuity/navigate', 'navigate', ['serviceId', 'datetime', 'serviceName', 'client'], ['navigation'], {
			navigation: {
				url: 'https://app.acuityscheduling.com/x',
				landingStep: 'client-form',
				appointmentTypeId: '53178494',
				calendarId: null,
				selectedDate: '2026-06-20',
				selectedTime: '10:00',
			},
		}),
	)
	.add(
		step('acuity/fill-form', 'fill-form', ['client', 'navigation'], ['form'], {
			form: {
				fieldsCompleted: ['firstName', 'lastName'],
				customFieldsCompleted: ['intake-1'],
				intakeFieldsCompleted: [],
				advanced: true,
			},
		}),
	)
	// Payment-injection sub-flow (design §7; TIN-2095): three sub-steps sharing the
	// 'bypass-payment' segment. Only the segment-boundary (last) sub-step carries a
	// stateDelta; the PII scan still covers `bypass` via verify-zero-total's row.
	.add(
		step(
			'acuity/open-coupon-entry',
			'bypass-payment',
			['couponCode', 'paymentRef', 'paymentProcessor', 'form'],
			['couponEntry'],
			{ couponEntry: { opened: true } },
		),
	)
	.add(
		step(
			'acuity/apply-coupon',
			'bypass-payment',
			['couponCode', 'paymentRef', 'paymentProcessor', 'couponEntry'],
			['couponApplication'],
			{ couponApplication: { applied: true } },
		),
	)
	.add(
		step(
			'acuity/verify-zero-total',
			'bypass-payment',
			['couponCode', 'paymentRef', 'paymentProcessor', 'couponApplication'],
			['bypass'],
			{ bypass: { couponApplied: true, code: 'COUPON', totalAfterCoupon: '$0.00' } },
		),
	)
	.add(
		step('acuity/submit', 'submit', ['bypass'], ['submission'], {
			submission: { submitted: true, confirmationPageReached: true },
		}, 'effectful-once'),
	)
	.add(
		step('acuity/extract-confirmation', 'extract-confirmation', ['submission'], ['confirmation'], {
			confirmation: {
				appointmentId: 'A-12345',
				confirmationCode: 'CONF-9',
				serviceName: 'Deep Tissue',
				datetime: '2026-06-20T10:00',
				providerName: 'Jen',
				rawText: RAW.confirmationRaw,
			},
		}),
	)
	.build({ flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' });

const initial = {
	serviceId: '53178494',
	datetime: '2026-06-20T10:00',
	serviceName: 'Deep Tissue',
	client: {
		firstName: RAW.firstName,
		lastName: RAW.lastName,
		email: RAW.email,
		phone: RAW.phone,
		notes: RAW.notes,
		customFields: { intake1: RAW.customField },
	},
	couponCode: 'COUPON',
	paymentRef: 'PR-1',
	paymentProcessor: 'stripe',
};

describe('booking flow PII-hygiene conformance', () => {
	it('journals no raw client PII or confirmation text in any stateDelta', async () => {
		const journal = createInMemoryFlowJournal();
		await Effect.runPromise(
			runFlow(bookingFlow, initial as never, {
				operationId: 'op-pii',
				sessionLayer: () => Layer.empty,
			}).pipe(Effect.provideService(FlowJournal, journal)),
		);

		const rows = await Effect.runPromise(journal.read('op-pii'));
		const serialized = JSON.stringify(rows);

		// Every raw PII value must be ABSENT from the entire journal.
		for (const value of Object.values(RAW)) {
			expect(serialized.includes(value)).toBe(false);
		}

		// The redaction actually fired (so the absence is not just a missing delta).
		expect(serialized).toContain(REDACTED_PLACEHOLDER);

		// stateDelta carries Provides only (never the initial `client` key), so the raw
		// client PII never even reaches a delta — and the provided confirmation PII is
		// redacted while its non-PII fields survive verbatim.
		const deltas = rows
			.filter((row) => row.status === 'completed' && row.stateDelta)
			.map((row) => row.stateDelta as Record<string, unknown>);
		expect(deltas.length).toBeGreaterThan(0);

		// The initial `client` key is input-only and is never journaled in any delta.
		expect(deltas.every((delta) => !('client' in delta))).toBe(true);

		const lastDelta = deltas[deltas.length - 1];
		expect(lastDelta.confirmation).toEqual({
			appointmentId: 'A-12345',
			confirmationCode: 'CONF-9',
			serviceName: 'Deep Tissue',
			datetime: '2026-06-20T10:00',
			providerName: REDACTED_PLACEHOLDER,
			rawText: REDACTED_PLACEHOLDER,
		});
	});

	it('redacts the client schema PII when a step DOES provide the client key', async () => {
		// Defends the client-field annotations directly: a (synthetic) step that
		// provides `client` must journal only the placeholder, never the raw values.
		const journal = createInMemoryFlowJournal();
		const flow = makeFlow(acuityBookingFlowSpec, ['serviceId', 'datetime', 'serviceName'])
			.add(
				step('acuity/echo-client', 'navigate', ['serviceId'], ['client'], {
					client: {
						firstName: RAW.firstName,
						lastName: RAW.lastName,
						email: RAW.email,
						phone: RAW.phone,
						notes: RAW.notes,
						customFields: { intake1: RAW.customField },
					},
				}),
			)
			.build({ flowId: 'booking_create_with_payment', backend: 'acuity', version: '1.0.0' });

		await Effect.runPromise(
			runFlow(
				flow,
				{ serviceId: '53178494', datetime: '2026-06-20T10:00', serviceName: 'Deep Tissue' } as never,
				{ operationId: 'op-client', sessionLayer: () => Layer.empty },
			).pipe(Effect.provideService(FlowJournal, journal)),
		);

		const rows = await Effect.runPromise(journal.read('op-client'));
		const serialized = JSON.stringify(rows);
		for (const value of Object.values(RAW)) {
			expect(serialized.includes(value)).toBe(false);
		}
		const delta = rows.find((row) => row.stateDelta)?.stateDelta as Record<string, unknown>;
		expect(delta.client).toEqual({
			firstName: REDACTED_PLACEHOLDER,
			lastName: REDACTED_PLACEHOLDER,
			email: REDACTED_PLACEHOLDER,
			phone: REDACTED_PLACEHOLDER,
			notes: REDACTED_PLACEHOLDER,
			customFields: REDACTED_PLACEHOLDER,
		});
	});
});
