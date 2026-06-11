/**
 * Acuity Wizard Adapter
 *
 * Full SchedulingAdapter implementation that uses Effect TS middleware
 * to puppeteer the Acuity booking wizard.
 *
 * Read operations:
 * - getServices: returns static service catalog (if provided) or falls back to scraper
 * - getAvailableDates: Effect program navigates wizard calendar (verified selectors)
 * - getAvailableSlots: Effect program clicks day tile and reads time buttons
 *
 * Write operations:
 * - createBooking/createBookingWithPaymentRef: Effect TS middleware via Playwright
 *
 * This bridges Effect TS middleware errors to adapter-layer SchedulingError.
 */

import { Effect, pipe } from 'effect';

import type { SchedulingAdapter } from '../types.js';
import type { ScraperConfig } from './scraper.js';
import type {
	Booking,
	BookingRequest,
	Service,
	SchedulingError,
	SchedulingResult,
} from '../../core/types.js';
import { Errors } from '../../core/types.js';
import { BrowserServiceLive, type BrowserConfig, defaultBrowserConfig } from '../../shared/browser-service.js';
import { createAcuityServiceCatalog } from '../../shared/acuity-service-catalog.js';
import { toSchedulingError, type MiddlewareError } from './errors.js';
import { createRemoteWizardAdapter, type RemoteAdapterConfig } from '../../shared/remote-adapter.js';
import {
	navigateToBooking,
	fillFormFields,
	bypassPayment,
	generateCouponCode,
	submitBooking,
	extractConfirmation,
	toBooking,
	readAvailableDates,
	readTimeSlots,
	type NavigateResult,
	type ConfirmationData,
} from './steps/index.js';
import { readDatesViaUrl, readSlotsViaUrl } from './steps/read-via-url.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface WizardAdapterConfig extends Partial<BrowserConfig> {
	/** Base URL for the Acuity scheduling page */
	baseUrl: string;
	/** Pre-configured coupon code for payment bypass (from ACUITY_BYPASS_COUPON env) */
	couponCode?: string;
	/**
	 * Execution mode:
	 * - 'local': Run Playwright in-process (default, requires Chromium installed)
	 * - 'remote': Proxy all operations to a remote middleware server via HTTP
	 */
	mode?: 'local' | 'remote';
	/** Remote adapter config (required when mode is 'remote') */
	remote?: RemoteAdapterConfig;
	/**
	 * Static service catalog. If provided, getServices() returns this list
	 * without launching a browser. Recommended for known service sets to avoid
	 * expensive browser launches for read-only operations.
	 */
	services?: readonly Service[];
}

// =============================================================================
// EFFECT PROGRAMS
// =============================================================================

/**
 * Full booking creation via the Acuity wizard.
 *
 * Flow:
 * 1. Click through wizard: service → Book → calendar → time → continue
 * 2. Fill client form (standard + intake fields) → "Continue to Payment" → /payment page
 * 3. Apply 100% gift certificate on payment page (coupon toggle → enter code → Apply)
 * 4. Click "PAY & CONFIRM" at $0 total
 * 5. Extract confirmation data
 */
const createBookingWithPaymentRefProgram = (
	request: BookingRequest,
	paymentRef: string,
	paymentProcessor: string,
	couponCode: string,
	service?: Service,
) =>
	Effect.scoped(
		Effect.gen(function* () {
			// Step 1: Navigate through wizard to client form
			const serviceName = service?.name ?? request.serviceId;
			const nav: NavigateResult = yield* navigateToBooking({
				serviceName,
				datetime: request.datetime,
				client: request.client,
			});

			if (nav.landingStep !== 'client-form') {
				return yield* Effect.fail({
					_tag: 'WizardStepError' as const,
					step: 'navigate' as const,
					message: `Wizard landed on '${nav.landingStep}' instead of client form. Service or datetime may be unavailable.`,
				});
			}

			// Step 2: Fill form fields (standard + intake) and advance to /payment page
			yield* fillFormFields({
				client: request.client,
				customFields: request.client.customFields,
			});

			// Step 3: Apply gift certificate on the payment page (total → $0)
			yield* bypassPayment(couponCode);

			// Step 4: Click "PAY & CONFIRM" at $0 total
			yield* submitBooking();

			// Step 5: Extract confirmation
			const confirmation: ConfirmationData = yield* extractConfirmation();

			return toBooking(
				confirmation,
				request,
				paymentRef,
				paymentProcessor,
				service
					? {
							name: service.name,
							duration: service.duration,
							price: service.price,
							currency: service.currency,
						}
					: undefined,
			);
		}),
	);

const isAcuityAppointmentTypeId = (serviceId: string): boolean => /^\d+$/.test(serviceId);

/**
 * Simple booking creation (no payment bypass needed).
 * For card payments that go through Acuity's normal flow.
 */
const createBookingProgram = (request: BookingRequest, serviceName?: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const nav: NavigateResult = yield* navigateToBooking({
				serviceName: serviceName ?? request.serviceId,
				datetime: request.datetime,
				client: request.client,
			});

			if (nav.landingStep !== 'client-form') {
				return yield* Effect.fail({
					_tag: 'WizardStepError' as const,
					step: 'navigate' as const,
					message: `Wizard landed on '${nav.landingStep}' instead of client form.`,
				});
			}

			yield* fillFormFields({
				client: request.client,
				customFields: request.client.customFields,
			});

			// No payment bypass - form fills and advances to payment page
			// where Acuity handles card payment normally
			yield* submitBooking();
			const confirmation: ConfirmationData = yield* extractConfirmation();

			return toBooking(confirmation, request, '', 'acuity');
		}),
	);

const isSchedulingError = (error: unknown): error is SchedulingError =>
	typeof error === 'object' && error !== null && '_tag' in error;

const toCatalogError = (error: unknown): SchedulingError =>
	isSchedulingError(error)
		? error
		: Errors.infrastructure(
				'UNKNOWN',
				error instanceof Error ? error.message : 'Service catalog lookup failed',
			);

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

/**
 * Create a full SchedulingAdapter that puppeteers the Acuity wizard.
 *
 * Read operations resolve through the shared Acuity service catalog.
 * Write operations use Effect TS middleware via Playwright.
 */
export const createWizardAdapter = (config: WizardAdapterConfig): SchedulingAdapter => {
	// Remote mode: delegate everything to the middleware server
	if (config.mode === 'remote') {
		if (!config.remote) {
			throw new Error('WizardAdapterConfig.remote is required when mode is "remote"');
		}
		return createRemoteWizardAdapter({
			...config.remote,
			couponCode: config.remote.couponCode ?? config.couponCode,
			services: config.services,
		});
	}

	// Local mode: run Playwright in-process
	const browserConfig: BrowserConfig = {
		...defaultBrowserConfig,
		...config,
	};

	const layer = BrowserServiceLive(browserConfig);

	// Provide browser layer and map MiddlewareError → SchedulingError
	const runWizard = <A>(
		effect: Effect.Effect<A, MiddlewareError>,
	): SchedulingResult<A> =>
		pipe(
			Effect.scoped(effect),
			Effect.provide(layer),
			Effect.mapError(toSchedulingError),
		);

	const staticServices: Service[] | null = config.services ? [...config.services] : null;

	const scraperConfig: ScraperConfig = {
		baseUrl: config.baseUrl,
		headless: browserConfig.headless,
		timeout: browserConfig.timeout,
		userAgent: browserConfig.userAgent,
		executablePath: browserConfig.executablePath,
		launchArgs: browserConfig.launchArgs ? [...browserConfig.launchArgs] : undefined,
	};
	const serviceCatalog = createAcuityServiceCatalog({
		baseUrl: config.baseUrl,
		staticServices,
		scraperConfig,
		logger: console,
	});

	return {
		name: 'acuity-wizard',

		// -----------------------------------------------------------------------
		// Read operations
		// -----------------------------------------------------------------------

		getServices: () =>
			Effect.tryPromise({
				try: () => serviceCatalog.getServices(),
				catch: toCatalogError,
			}),

		getService: (serviceId: string) =>
			pipe(
				Effect.tryPromise({
					try: () => serviceCatalog.getService(serviceId),
					catch: toCatalogError,
				}),
				Effect.flatMap((found) =>
					found
						? Effect.succeed(found)
						: Effect.fail(Errors.acuity('NOT_FOUND', `Service ${serviceId} not found`)),
				),
			),

		getProviders: () =>
			Effect.succeed([
				{
					id: '1',
					name: 'Default Provider',
					email: 'provider@example.com',
					description: 'Primary provider',
					timezone: 'America/New_York',
				},
			]),

		getProvider: () =>
			Effect.succeed({
				id: '1',
				name: 'Default Provider',
				email: 'provider@example.com',
				description: 'Primary provider',
				timezone: 'America/New_York',
			}),

		getProvidersForService: () =>
			Effect.succeed([
				{
					id: '1',
					name: 'Default Provider',
					email: 'provider@example.com',
					description: 'Primary provider',
					timezone: 'America/New_York',
				},
			]),

		getAvailableDates: (params) => {
			if (isAcuityAppointmentTypeId(params.serviceId)) {
				return runWizard(
					Effect.scoped(
						readDatesViaUrl(params.serviceId, params.startDate?.slice(0, 7)),
					) as Effect.Effect<Array<{ date: string; slots: number }>, MiddlewareError>,
				);
			}

			return pipe(
				Effect.tryPromise({
					try: () => serviceCatalog.resolveServiceName(params.serviceId),
					catch: toCatalogError,
				}),
				Effect.flatMap((serviceName) =>
					runWizard(
						Effect.scoped(
							readAvailableDates({
								serviceName,
								targetMonth: params.startDate?.slice(0, 7),
								monthsToScan: 2,
							}),
						) as Effect.Effect<Array<{ date: string; slots: number }>, MiddlewareError>,
					),
				),
			);
		},

		getAvailableSlots: (params) => {
			if (isAcuityAppointmentTypeId(params.serviceId)) {
				return runWizard(
					Effect.scoped(
						readSlotsViaUrl(params.serviceId, params.date),
					) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
				);
			}

			return pipe(
				Effect.tryPromise({
					try: () => serviceCatalog.resolveServiceName(params.serviceId),
					catch: toCatalogError,
				}),
				Effect.flatMap((serviceName) =>
					runWizard(
						Effect.scoped(
							readTimeSlots({
								serviceName,
								date: params.date,
							}),
						) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
					),
				),
			);
		},

		checkSlotAvailability: (params) => {
			if (isAcuityAppointmentTypeId(params.serviceId)) {
				return pipe(
					runWizard(
						Effect.scoped(
							readSlotsViaUrl(params.serviceId, params.datetime.split('T')[0]),
						) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
					),
					Effect.map((slots) => {
						const normalize = (dt: string) => dt.replace(/([+-]\d{2}:\d{2}|Z)$/, '');
						const requestNorm = normalize(params.datetime);
						return slots.some((s) => s.available && normalize(s.datetime) === requestNorm);
					}),
				);
			}

			return pipe(
				Effect.tryPromise({
					try: () => serviceCatalog.resolveServiceName(params.serviceId),
					catch: toCatalogError,
				}),
				Effect.flatMap((serviceName) =>
					runWizard(
						Effect.scoped(
							readTimeSlots({
								serviceName,
								date: params.datetime.split('T')[0],
							}),
						) as Effect.Effect<Array<{ datetime: string; available: boolean }>, MiddlewareError>,
					),
				),
				Effect.map((slots) => {
					// Slots return local time (no TZ suffix: "2026-03-07T14:00:00").
					// Request datetime should also be local, but normalize both by
					// stripping any trailing Z or offset for comparison.
					const normalize = (dt: string) => dt.replace(/([+-]\d{2}:\d{2}|Z)$/, '');
					const requestNorm = normalize(params.datetime);
					return slots.some((s) => s.available && normalize(s.datetime) === requestNorm);
				}),
			);
		},

		// -----------------------------------------------------------------------
		// Advisory soft hold - not supported (pipeline has graceful fallback)
		// -----------------------------------------------------------------------

		softHoldSlot: () =>
			Effect.fail(
				Errors.reservation(
					'BLOCK_FAILED',
					'Advisory soft holds are not supported by wizard adapter',
				),
			),

		releaseSoftHold: () => Effect.succeed(undefined),

		// -----------------------------------------------------------------------
		// Write operations - Effect TS middleware
		// -----------------------------------------------------------------------

		createBooking: (request) => {
			const serviceName = serviceCatalog.getCachedService(request.serviceId)?.name;
			return runWizard(
				createBookingProgram(request, serviceName) as Effect.Effect<Booking, MiddlewareError>,
			);
		},

		createBookingWithPaymentRef: (request, paymentRef, paymentProcessor) => {
			const coupon = config.couponCode ?? generateCouponCode(paymentRef, paymentProcessor);
			const service = serviceCatalog.getCachedService(request.serviceId);

			return runWizard(
				createBookingWithPaymentRefProgram(
					request,
					paymentRef,
					paymentProcessor,
					coupon,
					service,
				) as Effect.Effect<Booking, MiddlewareError>,
			);
		},

		getBooking: () =>
			Effect.fail(Errors.acuity('NOT_IMPLEMENTED', 'Get booking not yet supported via wizard')),

		cancelBooking: () =>
			Effect.fail(Errors.acuity('NOT_IMPLEMENTED', 'Cancel not yet supported via wizard')),

		rescheduleBooking: () =>
			Effect.fail(
				Errors.acuity('NOT_IMPLEMENTED', 'Reschedule not yet supported via wizard'),
			),

		// -----------------------------------------------------------------------
		// Client - pass-through (client data comes from our form, not Acuity)
		// -----------------------------------------------------------------------

		findOrCreateClient: (client) =>
			Effect.succeed({ id: `local-${client.email}`, isNew: true }),

		getClientByEmail: () => Effect.succeed(null),
	};
};
