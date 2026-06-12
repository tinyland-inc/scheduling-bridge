/**
 * StepMeta wrappers over the existing Acuity step programs.
 * Design: docs/design/flow-dag-formalization.md §5 (idempotency classes), §6 (fuzzy-out
 * mapping), §7 (Acuity 0.6.0 bullet), §10 (0.6.0 block). TIN-2036.
 *
 * Step BODIES are untouched: every wrapper adapts an existing Effect program
 * (src/adapters/acuity/steps/*) into a `FlowStep` with honest metadata —
 * needs/provides keys over JSON-encodable FlowStateSpecs, `acuity:*` StationIds from
 * the landing surfaces the steps actually observe, idempotency classes per design §5
 * (navigate/fill/apply-coupon = replayable-write; submitBooking = effectful-once;
 * reads = read), and selectorKeys listing the selector-registry entries each step
 * program actually resolves or probes.
 *
 * SEGMENTS deliberately mirror the PRODUCTION WORKER page-lifecycle semantics
 * (`runWizardStep`, src/server/worker.ts — each step runs in its own
 * `Effect.scoped(Effect.provide(BrowserSessionLive))` region, i.e. a fresh page per
 * step). The booking flow therefore declares five single-step segments, NOT the
 * single-segment wizard.ts layout. This is the verified scoping divergence the design
 * names (§2 item 3, Appendix B Judge 2); the 0.6.x trace-conformance harness pins the
 * flagged path against the worker, so the segment layout here is the worker-exact one
 * by explicit decision.
 */

import { Effect, Schema, type Scope } from 'effect';
import type { MiddlewareError } from './errors.js';
import type { BrowserService } from '../../shared/browser-service.js';
import type { FlowStep } from '../../flow/step.js';
import type { LandingObservation, StationId } from '../../flow/station.js';
import type { StateOf } from '../../flow/state.js';
import type { ClientInfo } from '../../core/types.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	readAvailableDates,
	readTimeSlots,
	type NavigateResult,
} from './steps/index.js';
import {
	readDatesViaUrl,
	readSlotsViaUrl,
} from './steps/read-via-url.js';
import {
	extractBusinessFromPage,
	businessToServices,
} from './steps/extract-business.js';

// =============================================================================
// STATIONS — acuity:* landing vocabulary (fuzzy-out)
// =============================================================================

/**
 * The Acuity landing vocabulary, drawn from the existing fuzzy-out probe surfaces:
 * `detectLandingStep` (steps/navigate.ts: client-form | service-selection | calendar |
 * time-slots | unknown), `waitForAvailabilitySurface` (steps/read-via-url.ts: calendar
 * | time-list), the payment page URL guard (steps/bypass-payment.ts), the bypass $0
 * verification (payment-bypassed), and the confirmation triple-probe
 * (steps/extract.ts / submit.ts 4-signal race).
 */
export const ACUITY_STATIONS = [
	'acuity:client-form',
	'acuity:service-selection',
	'acuity:calendar',
	'acuity:time-slots',
	'acuity:time-list',
	'acuity:payment',
	'acuity:payment-bypassed',
	'acuity:confirmation',
] as const satisfies readonly StationId[];

export type AcuityStation = (typeof ACUITY_STATIONS)[number];

/** Probe keys `detectLandingStep` (steps/navigate.ts) checks, in probe order. */
export const LANDING_PROBE_KEYS = {
	'client-form': 'firstNameInput',
	'time-slots': 'timeSlot',
	calendar: 'calendarDay',
	'service-selection': 'serviceList',
} as const;

/** Map a `NavigateResult.landingStep` onto the station vocabulary. */
export const landingStepToStation = (
	landingStep: NavigateResult['landingStep'],
): StationId | 'unknown' =>
	landingStep === 'unknown' ? 'unknown' : (`acuity:${landingStep}` as StationId);

/** Build a LandingObservation from a `detectLandingStep` result. */
export const landingObservation = (
	expected: readonly StationId[],
	landingStep: NavigateResult['landingStep'],
): LandingObservation =>
	landingStep === 'unknown'
		? {
				expected,
				observed: 'unknown',
				confidence: 0,
				evidence: Object.values(LANDING_PROBE_KEYS).map((key) => ({
					kind: 'selector' as const,
					key,
					matched: false,
				})),
			}
		: {
				expected,
				observed: `acuity:${landingStep}` as StationId,
				confidence: 1,
				evidence: [
					{
						kind: 'selector' as const,
						key: LANDING_PROBE_KEYS[landingStep],
						matched: true,
					},
				],
			};

/**
 * The production worker's payment-bypass proof predicate, mirrored verbatim from
 * `assertPaymentBypassProven` (src/server/worker.ts): coupon applied AND the parsed
 * total is exactly 0.
 */
export const isPaymentBypassProven = (result: {
	readonly couponApplied: boolean;
	readonly totalAfterCoupon: string | null;
}): boolean => {
	const numericTotal = result.totalAfterCoupon
		? Number(result.totalAfterCoupon.replace(/[^0-9.]/g, ''))
		: null;
	return result.couponApplied && numericTotal === 0;
};

/** Acuity numeric appointment-type id test, mirrored from src/server/worker.ts. */
export const isAcuityAppointmentTypeId = (serviceId: string): boolean =>
	/^\d+$/.test(serviceId);

// =============================================================================
// STATE SPECS — JSON-encodable vocabularies (design §4 state.ts; no optional
// properties: absent values are encoded as null so the Encoded side stays JsonValue)
// =============================================================================

const ClientStateSchema = Schema.Struct({
	firstName: Schema.String,
	lastName: Schema.String,
	email: Schema.String,
	phone: Schema.NullOr(Schema.String),
	notes: Schema.NullOr(Schema.String),
	customFields: Schema.NullOr(
		Schema.Record({ key: Schema.String, value: Schema.String }),
	),
});

export type ClientState = Schema.Schema.Type<typeof ClientStateSchema>;

/** Null-normalize a ClientInfo into the JSON-encodable client state shape. */
export const toClientState = (client: ClientInfo): ClientState => ({
	firstName: client.firstName,
	lastName: client.lastName,
	email: client.email,
	phone: client.phone ?? null,
	notes: client.notes ?? null,
	customFields: client.customFields ?? null,
});

/** Undefined-normalize the client state back into the step programs' ClientInfo. */
export const fromClientState = (state: ClientState): ClientInfo => ({
	firstName: state.firstName,
	lastName: state.lastName,
	email: state.email,
	phone: state.phone ?? undefined,
	notes: state.notes ?? undefined,
	customFields: state.customFields
		? { ...(state.customFields as Record<string, string>) }
		: undefined,
});

/** Booking flow state vocabulary (initial keys + per-step provides). */
export const acuityBookingFlowSpec = {
	serviceId: Schema.String,
	datetime: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	client: ClientStateSchema,
	couponCode: Schema.String,
	paymentRef: Schema.String,
	paymentProcessor: Schema.String,
	navigation: Schema.Struct({
		url: Schema.String,
		landingStep: Schema.Literal(
			'client-form',
			'service-selection',
			'calendar',
			'time-slots',
			'unknown',
		),
		appointmentTypeId: Schema.NullOr(Schema.String),
		calendarId: Schema.NullOr(Schema.String),
		selectedDate: Schema.String,
		selectedTime: Schema.String,
	}),
	form: Schema.Struct({
		fieldsCompleted: Schema.Array(Schema.String),
		customFieldsCompleted: Schema.Array(Schema.String),
		intakeFieldsCompleted: Schema.Array(Schema.String),
		advanced: Schema.Boolean,
	}),
	bypass: Schema.Struct({
		couponApplied: Schema.Boolean,
		code: Schema.String,
		totalAfterCoupon: Schema.NullOr(Schema.String),
	}),
	submission: Schema.Struct({
		submitted: Schema.Boolean,
		confirmationPageReached: Schema.Boolean,
	}),
	confirmation: Schema.Struct({
		appointmentId: Schema.NullOr(Schema.String),
		confirmationCode: Schema.NullOr(Schema.String),
		serviceName: Schema.NullOr(Schema.String),
		datetime: Schema.NullOr(Schema.String),
		providerName: Schema.NullOr(Schema.String),
		rawText: Schema.String,
	}),
} as const;

export type AcuityBookingFlowSpec = typeof acuityBookingFlowSpec;

/** State keys supplied as initial input to the booking flow (from the job command). */
export const ACUITY_BOOKING_INITIAL_KEYS = [
	'serviceId',
	'datetime',
	'serviceName',
	'client',
	'couponCode',
	'paymentRef',
	'paymentProcessor',
] as const;

/** Availability dates flow state vocabulary. */
export const acuityAvailabilityDatesFlowSpec = {
	serviceId: Schema.String,
	month: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	dates: Schema.Array(
		Schema.Struct({ date: Schema.String, slots: Schema.Number }),
	),
} as const;

export type AcuityAvailabilityDatesFlowSpec = typeof acuityAvailabilityDatesFlowSpec;

export const ACUITY_DATES_INITIAL_KEYS = [
	'serviceId',
	'month',
	'serviceName',
] as const;

/** Availability slots flow state vocabulary. */
export const acuityAvailabilitySlotsFlowSpec = {
	serviceId: Schema.String,
	date: Schema.String,
	serviceName: Schema.NullOr(Schema.String),
	slots: Schema.Array(
		Schema.Struct({ datetime: Schema.String, available: Schema.Boolean }),
	),
} as const;

export type AcuityAvailabilitySlotsFlowSpec = typeof acuityAvailabilitySlotsFlowSpec;

export const ACUITY_SLOTS_INITIAL_KEYS = [
	'serviceId',
	'date',
	'serviceName',
] as const;

/** Business extraction state vocabulary (JSON projection of window.BUSINESS). */
export const acuityBusinessFlowSpec = {
	services: Schema.Array(
		Schema.Struct({
			id: Schema.String,
			name: Schema.String,
			duration: Schema.Number,
			price: Schema.Number,
			currency: Schema.String,
			category: Schema.NullOr(Schema.String),
			active: Schema.Boolean,
		}),
	),
} as const;

export type AcuityBusinessFlowSpec = typeof acuityBusinessFlowSpec;

// =============================================================================
// BOOKING STEP WRAPPERS (worker-exact: one segment per step)
// =============================================================================

type BookingStep<
	N extends keyof AcuityBookingFlowSpec & string,
	P extends keyof AcuityBookingFlowSpec & string,
> = FlowStep<
	AcuityBookingFlowSpec,
	N,
	P,
	MiddlewareError | undefined,
	BrowserService | Scope.Scope
>;

/** `navigateToBooking` (steps/navigate.ts) as a FlowStep. */
export const acuityNavigateStep: BookingStep<
	'serviceId' | 'datetime' | 'serviceName' | 'client',
	'navigation'
> = {
	meta: {
		id: 'acuity/navigate',
		needs: ['serviceId', 'datetime', 'serviceName', 'client'],
		provides: ['navigation'],
		expects: ['acuity:client-form'],
		idempotency: 'replayable-write',
		segment: 'navigate',
		tags: ['navigation'],
		selectorKeys: [
			'serviceList',
			'serviceName',
			'serviceBookButton',
			'calendar',
			'calendarDay',
			'calendarMonth',
			'calendarNext',
			'calendarPrev',
			'timeSlot',
			'timeSlotContainer',
			'selectAndContinue',
			'firstNameInput',
		],
	},
	run: (input) =>
		navigateToBooking({
			serviceName: input.serviceName ?? input.serviceId,
			datetime: input.datetime,
			client: fromClientState(input.client),
			appointmentTypeId: input.serviceId,
		}).pipe(
			Effect.map((nav) => ({
				state: {
					navigation: {
						url: nav.url,
						landingStep: nav.landingStep,
						appointmentTypeId: nav.appointmentTypeId,
						calendarId: nav.calendarId,
						selectedDate: nav.selectedDate,
						selectedTime: nav.selectedTime,
					},
				},
				observed: landingObservation(['acuity:client-form'], nav.landingStep),
			})),
		),
};

/** `fillFormFields` (steps/fill-form.ts) as a FlowStep. */
export const acuityFillFormStep: BookingStep<'client' | 'navigation', 'form'> = {
	meta: {
		id: 'acuity/fill-form',
		needs: ['client', 'navigation'],
		provides: ['form'],
		expects: ['acuity:payment'],
		idempotency: 'replayable-write',
		segment: 'fill-form',
		tags: ['mutation'],
		selectorKeys: [
			'firstNameInput',
			'lastNameInput',
			'emailInput',
			'phoneInput',
			'termsCheckbox',
			'radioYesLabel',
			'radioNoLabel',
			'medicationField',
			'continueToPayment',
		],
	},
	run: (input) =>
		fillFormFields({
			client: fromClientState(input.client),
			customFields: input.client.customFields
				? { ...(input.client.customFields as Record<string, string>) }
				: undefined,
		}).pipe(
			Effect.map((form) => ({
				state: {
					form: {
						fieldsCompleted: [...form.fieldsCompleted],
						customFieldsCompleted: [...form.customFieldsCompleted],
						intakeFieldsCompleted: [...form.intakeFieldsCompleted],
						advanced: form.advanced,
					},
				},
				observed: {
					expected: ['acuity:payment'],
					observed: form.advanced ? 'acuity:payment' : 'acuity:client-form',
					confidence: 1,
					evidence: [
						{
							kind: 'selector' as const,
							key: 'continueToPayment',
							matched: form.advanced,
						},
					],
				} satisfies LandingObservation,
			})),
		),
};

/**
 * `bypassPayment` (steps/bypass-payment.ts) as the payment-injection FlowStep
 * (design §7: Acuity's coupon-bypass implementation of the payment-injection
 * segment). The journaled `idempotencyToken` carries the coupon code — reusing
 * `generateCouponCode` output (design §5 replayable-write token reuse) — and the
 * worker's bypass-proof predicate becomes the landing observation: not-proven lands
 * on 'acuity:payment' instead of the expected 'acuity:payment-bypassed', i.e. a
 * Diverged outcome on the payment-injection segment (design §6,
 * PAYMENT_BYPASS_NOT_PROVEN).
 */
export const acuityBypassPaymentStep: BookingStep<
	'couponCode' | 'paymentRef' | 'paymentProcessor' | 'form',
	'bypass'
> = {
	meta: {
		id: 'acuity/bypass-payment',
		needs: ['couponCode', 'paymentRef', 'paymentProcessor', 'form'],
		provides: ['bypass'],
		expects: ['acuity:payment-bypassed'],
		idempotency: 'replayable-write',
		segment: 'bypass-payment',
		tags: ['payment-injection'],
		selectorKeys: ['paymentCouponToggle', 'paymentCouponInput', 'paymentCouponApply'],
	},
	run: (input) =>
		Effect.suspend(() => {
			const token = generateCouponCode(
				input.paymentRef,
				input.paymentProcessor,
				input.couponCode,
			);
			return bypassPayment(token).pipe(
				Effect.map((bypass) => {
					const proven = isPaymentBypassProven(bypass);
					return {
						state: {
							bypass: {
								couponApplied: bypass.couponApplied,
								code: bypass.code,
								totalAfterCoupon: bypass.totalAfterCoupon,
							},
						},
						observed: {
							expected: ['acuity:payment-bypassed'],
							observed: proven ? 'acuity:payment-bypassed' : 'acuity:payment',
							confidence: 1,
							evidence: [
								{
									kind: 'text' as const,
									key: 'coupon-applied',
									matched: bypass.couponApplied,
								},
								{ kind: 'text' as const, key: 'zero-total', matched: proven },
							],
						} satisfies LandingObservation,
						idempotencyToken: token,
					};
				}),
			);
		}),
};

/** `submitBooking` (steps/submit.ts) as the effectful-once FlowStep (design §5). */
export const acuitySubmitStep: BookingStep<'bypass', 'submission'> = {
	meta: {
		id: 'acuity/submit',
		needs: ['bypass'],
		provides: ['submission'],
		expects: ['acuity:confirmation'],
		idempotency: 'effectful-once',
		segment: 'submit',
		tags: ['mutation'],
		selectorKeys: ['submitButton', 'confirmationPage'],
	},
	run: () =>
		submitBooking().pipe(
			Effect.map((result) => ({
				state: {
					submission: {
						submitted: result.submitted,
						confirmationPageReached: result.confirmationPageReached,
					},
				},
				observed: {
					expected: ['acuity:confirmation'],
					observed: result.confirmationPageReached
						? 'acuity:confirmation'
						: 'unknown',
					confidence: result.confirmationPageReached ? 1 : 0,
					evidence: [
						{
							kind: 'selector' as const,
							key: 'confirmationPage',
							matched: result.confirmationPageReached,
						},
					],
				} satisfies LandingObservation,
			})),
		),
};

/** `extractConfirmation` (steps/extract.ts) as a read FlowStep. */
export const acuityExtractConfirmationStep: BookingStep<'submission', 'confirmation'> = {
	meta: {
		id: 'acuity/extract-confirmation',
		needs: ['submission'],
		provides: ['confirmation'],
		expects: ['acuity:confirmation'],
		idempotency: 'read',
		segment: 'extract-confirmation',
		tags: ['extraction'],
		selectorKeys: [
			'confirmationPage',
			'confirmationId',
			'confirmationService',
			'confirmationDatetime',
		],
	},
	run: () =>
		extractConfirmation().pipe(
			Effect.map((confirmation) => ({
				state: {
					confirmation: {
						appointmentId: confirmation.appointmentId,
						confirmationCode: confirmation.confirmationCode,
						serviceName: confirmation.serviceName,
						datetime: confirmation.datetime,
						providerName: confirmation.providerName,
						rawText: confirmation.rawText,
					},
				},
				// The step itself triple-probes the confirmation page and fails when it
				// is not there, so success IS the on-track landing.
				observed: {
					expected: ['acuity:confirmation'],
					observed: 'acuity:confirmation',
					confidence: 1,
					evidence: [
						{ kind: 'selector' as const, key: 'confirmationPage', matched: true },
					],
				} satisfies LandingObservation,
			})),
		),
};

// =============================================================================
// AVAILABILITY STEP WRAPPERS
// =============================================================================

type DatesStep<N extends keyof AcuityAvailabilityDatesFlowSpec & string> = FlowStep<
	AcuityAvailabilityDatesFlowSpec,
	N,
	'dates',
	MiddlewareError | undefined,
	BrowserService | Scope.Scope
>;

type SlotsStep<N extends keyof AcuityAvailabilitySlotsFlowSpec & string> = FlowStep<
	AcuityAvailabilitySlotsFlowSpec,
	N,
	'slots',
	MiddlewareError | undefined,
	BrowserService | Scope.Scope
>;

const datesOutcome = (
	dates: readonly { readonly date: string; readonly slots: number }[],
): { state: Pick<StateOf<AcuityAvailabilityDatesFlowSpec>, 'dates'> } => ({
	state: { dates: dates.map((d) => ({ date: d.date, slots: d.slots })) },
});

const slotsOutcome = (
	slots: readonly { readonly datetime: string; readonly available: boolean }[],
): { state: Pick<StateOf<AcuityAvailabilitySlotsFlowSpec>, 'slots'> } => ({
	state: { slots: slots.map((s) => ({ datetime: s.datetime, available: s.available })) },
});

/** `readDatesViaUrl` (steps/read-via-url.ts) as a FlowStep. */
export const acuityReadDatesViaUrlStep: DatesStep<'serviceId' | 'month'> = {
	meta: {
		id: 'acuity/read-dates-via-url',
		needs: ['serviceId', 'month'],
		provides: ['dates'],
		expects: ['acuity:calendar', 'acuity:time-list'],
		idempotency: 'read',
		segment: 'read-dates',
		tags: ['read'],
		selectorKeys: ['calendar', 'calendarDay', 'timeSlot'],
	},
	run: (input) =>
		readDatesViaUrl(input.serviceId, input.month).pipe(Effect.map(datesOutcome)),
};

/** `readAvailableDates` (steps/read-availability.ts, wizard click-through) as a FlowStep. */
export const acuityReadDatesWizardStep: DatesStep<
	'serviceId' | 'month' | 'serviceName'
> = {
	meta: {
		id: 'acuity/read-dates-wizard',
		needs: ['serviceId', 'month', 'serviceName'],
		provides: ['dates'],
		expects: ['acuity:calendar'],
		idempotency: 'read',
		segment: 'read-dates',
		tags: ['read', 'navigation'],
		selectorKeys: [
			'serviceList',
			'serviceName',
			'serviceBookButton',
			'calendar',
			'calendarDay',
			'calendarMonth',
			'calendarNext',
			'calendarPrev',
		],
	},
	run: (input) =>
		readAvailableDates({
			serviceName: input.serviceName ?? input.serviceId,
			targetMonth: input.month,
			monthsToScan: 2,
		}).pipe(Effect.map(datesOutcome)),
};

/**
 * The dates-refresh step as the production worker executes it
 * (`refreshAvailabilityDates`, src/server/worker.ts): numeric appointment-type ids go
 * via the URL-parameter read, anything else via the wizard click-through. The dispatch
 * lives in the wrapper; both step bodies are untouched.
 */
export const acuityReadDatesStep: DatesStep<'serviceId' | 'month' | 'serviceName'> = {
	meta: {
		id: 'acuity/read-dates',
		needs: ['serviceId', 'month', 'serviceName'],
		provides: ['dates'],
		expects: ['acuity:calendar', 'acuity:time-list'],
		idempotency: 'read',
		segment: 'read-dates',
		tags: ['read'],
		selectorKeys: [
			'serviceList',
			'serviceName',
			'serviceBookButton',
			'calendar',
			'calendarDay',
			'calendarMonth',
			'calendarNext',
			'calendarPrev',
			'timeSlot',
		],
	},
	run: (input) =>
		isAcuityAppointmentTypeId(input.serviceId)
			? acuityReadDatesViaUrlStep.run(input)
			: acuityReadDatesWizardStep.run(input),
};

/** `readSlotsViaUrl` (steps/read-via-url.ts) as a FlowStep. */
export const acuityReadSlotsViaUrlStep: SlotsStep<'serviceId' | 'date'> = {
	meta: {
		id: 'acuity/read-slots-via-url',
		needs: ['serviceId', 'date'],
		provides: ['slots'],
		expects: ['acuity:calendar', 'acuity:time-list'],
		idempotency: 'read',
		segment: 'read-slots',
		tags: ['read'],
		selectorKeys: ['calendar', 'calendarDay', 'timeSlot'],
	},
	run: (input) =>
		readSlotsViaUrl(input.serviceId, input.date).pipe(Effect.map(slotsOutcome)),
};

/** `readTimeSlots` (steps/read-slots.ts, wizard click-through) as a FlowStep. */
export const acuityReadSlotsWizardStep: SlotsStep<
	'serviceId' | 'date' | 'serviceName'
> = {
	meta: {
		id: 'acuity/read-slots-wizard',
		needs: ['serviceId', 'date', 'serviceName'],
		provides: ['slots'],
		expects: ['acuity:time-slots'],
		idempotency: 'read',
		segment: 'read-slots',
		tags: ['read', 'navigation'],
		selectorKeys: [
			'serviceList',
			'serviceName',
			'serviceBookButton',
			'calendar',
			'calendarDay',
			'calendarMonth',
			'calendarNext',
			'calendarPrev',
			'timeSlot',
			'timeSlotContainer',
		],
	},
	run: (input) =>
		readTimeSlots({
			serviceName: input.serviceName ?? input.serviceId,
			date: input.date,
		}).pipe(Effect.map(slotsOutcome)),
};

/**
 * The slots-refresh step as the production worker executes it
 * (`refreshAvailabilitySlots`, src/server/worker.ts): same numeric-id dispatch as the
 * dates refresh.
 */
export const acuityReadSlotsStep: SlotsStep<'serviceId' | 'date' | 'serviceName'> = {
	meta: {
		id: 'acuity/read-slots',
		needs: ['serviceId', 'date', 'serviceName'],
		provides: ['slots'],
		expects: ['acuity:calendar', 'acuity:time-list'],
		idempotency: 'read',
		segment: 'read-slots',
		tags: ['read'],
		selectorKeys: [
			'serviceList',
			'serviceName',
			'serviceBookButton',
			'calendar',
			'calendarDay',
			'calendarMonth',
			'calendarNext',
			'calendarPrev',
			'timeSlot',
			'timeSlotContainer',
		],
	},
	run: (input) =>
		isAcuityAppointmentTypeId(input.serviceId)
			? acuityReadSlotsViaUrlStep.run(input)
			: acuityReadSlotsWizardStep.run(input),
};

// =============================================================================
// BUSINESS EXTRACTION WRAPPER
// =============================================================================

/**
 * `extractBusinessFromPage` (steps/extract-business.ts) as a FlowStep. The provides
 * key is the JSON service projection (`businessToServices`), not the raw BUSINESS
 * object — volatile/unknown-shaped fields stay out of durable state (design §4).
 * Not part of any 0.6.0 flow; wrapped for completeness of the step inventory.
 */
export const acuityExtractBusinessStep: FlowStep<
	AcuityBusinessFlowSpec,
	never,
	'services',
	MiddlewareError | undefined,
	BrowserService | Scope.Scope
> = {
	meta: {
		id: 'acuity/extract-business',
		needs: [],
		provides: ['services'],
		expects: ['acuity:service-selection'],
		idempotency: 'read',
		segment: 'extract-business',
		tags: ['read', 'extraction'],
		selectorKeys: [],
	},
	run: () =>
		extractBusinessFromPage.pipe(
			Effect.map((business) => ({
				state: {
					services: businessToServices(business).map((service) => ({
						id: service.id,
						name: service.name,
						duration: service.duration,
						price: service.price,
						currency: service.currency,
						category: service.category ?? null,
						active: service.active ?? true,
					})),
				},
			})),
		),
};
