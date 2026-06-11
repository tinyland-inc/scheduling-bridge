/**
 * Acuity CSS Selector Registry
 *
 * Single source of truth for all CSS selectors used by the wizard middleware.
 * Each selector has a primary pattern and fallback chain.
 * When Acuity changes their DOM, fix this ONE file.
 */

import { Effect } from 'effect';
import type { Page, ElementHandle } from 'playwright-core';
import { SelectorError } from './errors.js';

// =============================================================================
// SELECTOR DEFINITIONS
// =============================================================================

/**
 * Acuity Scheduling (2026 React SPA) CSS Selector Registry
 *
 * Verified against live DOM: 2026-02-25
 * Uses Emotion CSS-in-JS (css-* hashes are UNSTABLE — prefer semantic classes)
 *
 * Wizard flow:
 *   1. Service page: <tenant>.as.me → <li.select-item> list with "Book" buttons
 *   2. Calendar page: /schedule/<hash>/appointment/<aptId>/calendar/<calId>
 *      - react-calendar month grid + available-times-container
 *   3. Client form: (after selecting time slot) → input fields
 *   4. Payment/coupon: certificate input → Apply → verify $0
 *   5. Submit → confirmation
 *
 * URL pattern (no query params):
 *   /schedule/<hash>/appointment/<appointmentTypeId>/calendar/<calendarId>
 */
export const Selectors = {
	// -- Service selection page --
	// Services are <li class="select-item select-item-box"> with NO <a> links
	// Categories use <div class="select-type"> with <div class="select-label">
	serviceList: ['.select-item', '.select-item-box', '.appointment-type-item'],
	serviceName: ['.appointment-type-name', '.type-name', 'h3'],
	serviceLink: ['.select-item', '.select-item-box'],
	// Price & duration are combined: <span>30 minutes @ $150.00</span> inside .duration-container
	servicePrice: ['.duration-container', '.duration-container span', '.price', '.cost'],
	serviceDuration: ['.duration-container', '.duration-container span', '.duration', '.time-duration'],
	serviceDescription: ['.type-description', '.description', 'p.type-description'],
	// "Book" button inside each service item
	serviceBookButton: ['button.btn', '.select-item button.btn'],
	// Category labels
	serviceCategory: ['.select-label', '.select-label p', '.select-type .select-label'],

	// -- Calendar page (react-calendar component) --
	// Wrapper: .monthly-calendar-v2 > .react-calendar.monthly-calendar-react-calendar
	calendar: ['.monthly-calendar-v2', '.react-calendar', '.monthly-calendar-react-calendar'],
	calendarMonth: ['.react-calendar__navigation__label', '.react-calendar__navigation__label__labelText'],
	calendarPrev: ['.react-calendar__navigation__prev-button'],
	calendarNext: ['.react-calendar__navigation__next-button'],
	// Day tiles are buttons: <button class="react-calendar__tile react-calendar__month-view__days__day">1</button>
	calendarDay: [
		'.react-calendar__tile',
		'.react-calendar__month-view__days__day',
		'button.react-calendar__tile',
	],
	// Active/selected day: react-calendar__tile--active + custom "activeday" class
	activeDay: [
		'.react-calendar__tile--active',
		'.activeday',
		'.react-calendar__tile:not(:disabled)',
	],

	// -- Time slot selection --
	// Container: .available-times-container
	// Slots: <button class="time-selection">10:00 AM1 spot left</button>
	// Selected: <button class="time-selection selected-time">
	timeSlotContainer: ['.available-times-container'],
	timeSlot: ['button.time-selection', '.time-selection', '.time-slot', '[data-time]'],
	timeSlotSelected: ['button.time-selection.selected-time', '.selected-time'],
	// "Select and continue" is an <li role="menuitem"> NOT a button
	selectAndContinue: [
		'li[role="menuitem"]',
		'[data-keyboard-navigable="keyboard-navigable-list-item"]',
		'text=Select and continue',
	],

	// -- Client form --
	// Field names use "client." prefix: client.firstName, client.lastName, etc.
	firstNameInput: ['input[name="client.firstName"]', '#client\\.firstName', 'input[name="firstName"]'],
	lastNameInput: ['input[name="client.lastName"]', '#client\\.lastName', 'input[name="lastName"]'],
	emailInput: ['input[name="client.email"]', '#client\\.email', 'input[name="email"]'],
	phoneInput: ['input[name="client.phone"]', '#client\\.phone', 'input[name="phone"]'],
	// "Continue to Payment" button on the form page
	continueToPayment: [
		'button.btn:has-text("Continue to Payment")',
		'button:has-text("Continue to Payment")',
		'button.btn[type="submit"]',
	],
	// "Check Code Balance" button for entering coupon codes
	checkCodeBalance: [
		'button:has-text("Check Code Balance")',
		'button.css-9zfkvr',
	],
	// Terms agreement checkbox (custom field)
	termsCheckbox: [
		'input[type="checkbox"][name*="field-13933959"]',
		'input[id*="13933959"]',
	],

	// -- Client form intake fields --
	// Radio buttons have NO name or id attrs; are purely React-controlled.
	// Strategy: click <label> wrapping the radio via locator().nth().
	// 3 yes/no question groups, each with aria-required="true".
	radioNoLabel: ['label:has(input[type="radio"][value="no"])'],
	radioYesLabel: ['label:has(input[type="radio"][value="yes"])'],
	// "How did you hear" multi-checkbox (REQUIRED — at least 1 must be checked)
	// Names: "Internet search", "google maps", "referral from Noha Acupuncture",
	//        "referral from dentist", "referral from PT or other practitioner"
	howDidYouHearCheckbox: [
		'input[type="checkbox"][name="Internet search"]',
		'label:has(input[type="checkbox"][name="Internet search"])',
	],
	// Medication textarea
	medicationField: [
		'textarea[name="fields[field-16606770]"]',
		'#fields\\[field-16606770\\]',
	],

	// -- Payment / coupon --
	// PAYMENT IS A SEPARATE PAGE at URL .../datetime/<ISO>/payment
	// Verified 2026-02-26: Square-powered (NOT Stripe).
	//
	// "Check Code Balance" modal on client form page is INFORMATIONAL ONLY.
	// The REAL coupon entry is on the PAYMENT page:
	//   "Package, gift, or coupon code" expandable section
	//
	// Client form modal selectors (kept for reference):
	couponField: ['#code', 'input#code', 'input[id="code"]'],
	couponTabByCode: [
		'button:has-text("Check by code")',
		'button.css-1jjp8vb:has-text("Check by code")',
	],
	couponConfirmButton: [
		'[role="dialog"] button:has-text("Confirm")',
		'button.css-qgmcoe',
		'button:has-text("Confirm")',
	],
	couponCloseButton: ['button:has-text("Close")', 'button.css-ve50y1'],
	couponError: [
		'[role="dialog"] p:has-text("weren\'t able to recognize")',
		'[role="dialog"] p:has-text("try entering it again")',
		'p.css-7bwtx1',
	],
	couponSuccess: [
		'[role="dialog"] p:has-text("balance")',
		'[role="dialog"] [class*="success"]',
		'.coupon-applied',
		'.certificate-success',
	],

	// -- Payment page (Square checkout) --
	// URL pattern: .../datetime/<ISO>/payment
	// "Package, gift, or coupon code" expandable section is the coupon entry point.
	paymentCouponToggle: [
		'button:has-text("Package, gift, or coupon code")',
		'text=Package, gift, or coupon code',
	],
	// After expanding: input placeholder="Enter code" (React id unstable like :r9:)
	// and an "Apply" button. Verified 2026-02-26.
	paymentCouponInput: ['input[placeholder="Enter code"]', 'input[placeholder*="code" i]', 'input[name*="coupon"]'],
	paymentCouponApply: ['button:has-text("Apply")', 'button:has-text("Redeem")'],
	// After applying, the certificate shows with a "REMOVE" link
	paymentCouponRemove: ['text=REMOVE', 'a:has-text("REMOVE")', 'button:has-text("REMOVE")'],
	// Order summary on payment page
	paymentTotal: ['.order-total', '.payment-total', '.total-amount', 'text=$0.00'],
	paymentSubtotal: ['text=Subtotal'],
	// Pay & Confirm button (the final submit on payment page)
	payAndConfirm: [
		'button:has-text("Pay & Confirm")',
		'button:has-text("PAY & CONFIRM")',
		'button:has-text("Confirm Appointment")',
	],

	// -- Checkout / submit (legacy — use payAndConfirm for payment page) --
	submitButton: [
		'button:has-text("Pay & Confirm")',
		'button:has-text("PAY & CONFIRM")',
		'button[type="submit"].confirm',
		'.complete-booking',
		'#submit-booking',
		'button:has-text("Complete Appointment")',
		'button:has-text("Book Now")',
		'button:has-text("Schedule")',
	],

	// -- Confirmation page --
	confirmationPage: ['.confirmation', '.booking-confirmed', '.thank-you', '#confirmation'],
	confirmationId: ['.confirmation-number', '.appointment-id', '[data-confirmation]'],
	confirmationService: ['.appointment-type', '.service-name', '.booked-service'],
	confirmationDatetime: ['.appointment-datetime', '.booked-time', '.booking-date'],
} as const;

// =============================================================================
// SELECTOR TYPE
// =============================================================================

export type SelectorKey = keyof typeof Selectors;

export interface ResolvedSelector {
	readonly selector: string;
	readonly element: ElementHandle;
}

// =============================================================================
// RESOLUTION UTILITIES
// =============================================================================

/**
 * Try selectors in order, return the first match.
 * Fails with SelectorError if none match.
 */
export const resolveSelector = (
	page: Page,
	candidates: readonly string[],
	timeout = 3000,
): Effect.Effect<ResolvedSelector, SelectorError> =>
	Effect.gen(function* () {
		for (const selector of candidates) {
			const el = yield* Effect.tryPromise({
				try: () =>
					page.waitForSelector(selector, { timeout, state: 'attached' }).then(
						(handle) => handle,
						() => null,
					),
				catch: () => null,
			}).pipe(Effect.orElseSucceed(() => null));

			if (el) {
				return { selector, element: el } as ResolvedSelector;
			}
		}

		return yield* Effect.fail(
			new SelectorError({
				candidates,
				message: `None of [${candidates.join(', ')}] found within ${timeout}ms`,
			}),
		);
	});

/**
 * Resolve a selector from the registry by key name.
 */
export const resolve = (
	page: Page,
	key: SelectorKey,
	timeout?: number,
): Effect.Effect<ResolvedSelector, SelectorError> =>
	resolveSelector(page, Selectors[key], timeout);

/**
 * Check if any selector in the candidates list exists on the page (non-blocking).
 * Returns the matching selector string or null.
 */
export const probeSelector = (
	page: Page,
	candidates: readonly string[],
): Effect.Effect<string | null, never> =>
	Effect.gen(function* () {
		for (const selector of candidates) {
			const exists = yield* Effect.tryPromise({
				try: () => page.$(selector).then((el) => el !== null),
				catch: () => false,
			}).pipe(Effect.orElseSucceed(() => false));

			if (exists) return selector;
		}
		return null;
	});

/**
 * Probe a selector from the registry by key name.
 */
export const probe = (page: Page, key: SelectorKey): Effect.Effect<string | null, never> =>
	probeSelector(page, Selectors[key]);

/**
 * Validate that all critical selectors can be resolved on the current page.
 * Returns a report of which selectors passed/failed.
 */
export const healthCheck = (
	page: Page,
	keys: readonly SelectorKey[],
): Effect.Effect<
	{ passed: SelectorKey[]; failed: SelectorKey[] },
	never
> =>
	Effect.gen(function* () {
		const passed: SelectorKey[] = [];
		const failed: SelectorKey[] = [];

		for (const key of keys) {
			const found = yield* probe(page, key);
			if (found) {
				passed.push(key);
			} else {
				failed.push(key);
			}
		}

		return { passed, failed };
	});
