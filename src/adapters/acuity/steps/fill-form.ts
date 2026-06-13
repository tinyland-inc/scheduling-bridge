/**
 * Wizard Step: Fill Client Form Fields
 *
 * Fills standard fields (name, email, phone), custom intake fields
 * (radio buttons, "How did you hear" checkboxes, medication, terms),
 * and advances past the client info step to the payment page.
 *
 * Acuity form requirements (verified 2026-02-26):
 *   - Standard: firstName, lastName, email, phone
 *   - 3 yes/no radio groups (aria-required, NO name/id attrs)
 *   - "How did you hear" multi-checkbox (at least 1 required)
 *   - Medication textarea (tenant custom field; selector lives in the profile)
 *   - Terms checkbox (tenant custom field; selector lives in the profile)
 *   - ALL must be filled before "Continue to Payment" advances
 *
 * De-tenanting (design §7, 0.7.0; TIN-2094): the tenant-customizable selectors
 * (terms / how-did-you-hear / medication) and the terms-field id excluded from
 * the referral fallback are selector-profile DATA (selector-profile.ts), keyed
 * by `BridgeAdapterProfile.selectorProfile`. This module names ZERO tenant
 * specifics; it reads the active profile's data.
 */

import { Effect } from 'effect';
import type { Page } from 'playwright-core';
import { BrowserService } from '../../../shared/browser-service.js';
import { WizardStepError } from '../errors.js';
import { resolveSelector, Selectors } from '../selectors.js';
import { DEFAULT_SELECTOR_PROFILE } from '../selector-profile.js';
import type { ClientInfo } from '../../../core/types.js';
import {
	makeFieldMatcher,
	resolveFieldAnswer,
	type FieldMatchQuery,
	type FieldRule,
} from '../../../flow/field-matcher.js';
import type { FuzzyMatcher, FuzzyResolution } from '../../../flow/fuzzy.js';

// =============================================================================
// TYPES
// =============================================================================

export interface FillFormParams {
	readonly client: ClientInfo;
	readonly customFields?: Record<string, string>;
	/** Answer for yes/no radio questions (default: "no") */
	readonly intakeRadioAnswer?: 'yes' | 'no';
	/** Which "How did you hear" checkbox to select. Defaults to the active
	 * selector profile's `defaultHowDidYouHear` intake option (profile DATA). */
	readonly howDidYouHear?: string;
	/** Medication text (default: "None") */
	readonly medication?: string;
	/**
	 * Fuzzy-in matcher for required-textarea label inference (design §6). Optional:
	 * the step builds the default FieldMatcher (DEFAULT_FIELD_RULES) when absent, so
	 * the wired behavior is byte-identical to the legacy keyword ladder; callers (and
	 * the VendorFlowPack) inject a tenant-tuned matcher to tighten/loosen the rules
	 * as DATA, never a code change.
	 */
	readonly fieldMatcher?: FuzzyMatcher<FieldMatchQuery, FieldRule>;
}

export interface FillFormResult {
	readonly fieldsCompleted: string[];
	readonly customFieldsCompleted: string[];
	readonly intakeFieldsCompleted: string[];
	readonly advanced: boolean;
	/**
	 * Fuzzy-in audit trail for the required-textarea label inference (design §6): one
	 * `FuzzyResolution` per required textarea the step answered, surfaced so the fold
	 * journals it per checkpoint (run.ts reads `outcome.resolutions` into rows +
	 * confidenceFloor). Empty when the page had no required textareas.
	 */
	readonly fieldResolutions: readonly FuzzyResolution<FieldRule>[];
}

// =============================================================================
// IMPLEMENTATION
// =============================================================================

/**
 * Fill the client information form and advance to the payment page.
 */
export const fillFormFields = (params: FillFormParams) =>
	Effect.gen(function* () {
		const { acquirePage } = yield* BrowserService;
		const page: Page = yield* acquirePage;

		const fieldsCompleted: string[] = [];
		const intakeFieldsCompleted: string[] = [];

		// Fill or verify each standard field
		yield* fillField(page, Selectors.firstNameInput, params.client.firstName, 'firstName');
		fieldsCompleted.push('firstName');

		yield* fillField(page, Selectors.lastNameInput, params.client.lastName, 'lastName');
		fieldsCompleted.push('lastName');

		yield* fillField(page, Selectors.emailInput, params.client.email, 'email');
		fieldsCompleted.push('email');

		if (params.client.phone) {
			yield* fillField(page, Selectors.phoneInput, params.client.phone, 'phone');
			fieldsCompleted.push('phone');
		}

		// Fill custom intake fields (by field ID)
		const customFieldsCompleted: string[] = [];
		if (params.customFields) {
			for (const [fieldId, value] of Object.entries(params.customFields)) {
				const filled = yield* fillCustomField(page, fieldId, value);
				if (filled) customFieldsCompleted.push(fieldId);
			}
		}

		// Fill any remaining required textareas that are still empty.
		// This catches mandatory intake questions (e.g., "What would you like
		// to work on?", "How many hours of restful sleep?") regardless of their
		// field IDs, which change when Jen edits the Acuity intake form. The
		// label→answer inference is the shared FieldMatcher (design §6); the
		// resolutions feed StepOutcome.resolutions via FillFormResult.
		const fieldMatcher = params.fieldMatcher ?? makeFieldMatcher();
		const fieldResolutions = yield* fillRequiredTextareas(
			page,
			fieldMatcher,
			params.client.notes,
		);
		intakeFieldsCompleted.push('requiredTextareas');

		// Fill intake radio buttons (yes/no questions)
		const radioAnswer = params.intakeRadioAnswer ?? 'no';
		yield* fillIntakeRadios(page, radioAnswer);
		intakeFieldsCompleted.push('radioButtons');

		// Fill "How did you hear" checkbox (may not exist on current form).
		// The default option name is profile DATA (tenant intake option), never a
		// constant in this generic step. Empty string when no profile default and
		// no caller value — the fallback path then handles selection.
		const hearOption =
			params.howDidYouHear ?? DEFAULT_SELECTOR_PROFILE.defaultHowDidYouHear ?? '';
		yield* fillHowDidYouHear(page, hearOption);
		intakeFieldsCompleted.push('howDidYouHear');

		// Fill medication textarea (may not exist on current form)
		const medication = params.medication ?? 'None';
		yield* fillMedication(page, medication);
		intakeFieldsCompleted.push('medication');

		// Fill terms checkbox (may not exist on current form)
		yield* fillTermsCheckbox(page);
		intakeFieldsCompleted.push('termsCheckbox');

		// Click continue/next to advance past client form
		const advanced = yield* advancePastForm(page);

		return {
			fieldsCompleted,
			customFieldsCompleted,
			intakeFieldsCompleted,
			advanced,
			fieldResolutions,
		} satisfies FillFormResult;
	}).pipe(
		Effect.catchTag('SelectorError', (e) =>
			Effect.fail(
				new WizardStepError({
					step: 'fill-form',
					message: `Form field not found: ${e.message}`,
					cause: e,
				}),
			),
		),
	);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Fill a form field. If the field already has the correct value
 * (from URL pre-fill), skip it. Otherwise clear and fill.
 */
const fillField = (
	page: Page,
	candidates: readonly string[],
	value: string,
	fieldName: string,
) =>
	Effect.gen(function* () {
		const { element, selector } = yield* resolveSelector(page, candidates, 5000);

		// Check current value
		const currentValue = yield* Effect.tryPromise({
			try: () => page.$eval(selector, (el) => (el as HTMLInputElement).value),
			catch: () => '',
		}).pipe(Effect.orElseSucceed(() => ''));

		// Skip if already correct
		if (currentValue.trim().toLowerCase() === value.trim().toLowerCase()) {
			return;
		}

		// Clear and fill
		yield* Effect.tryPromise({
			try: async () => {
				await element.click({ clickCount: 3 }); // Select all
				await element.fill(value);
			},
			catch: (e) =>
				new WizardStepError({
					step: 'fill-form',
					message: `Failed to fill ${fieldName}: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});
	});

/**
 * Fill a custom Acuity intake field by field ID.
 * Acuity custom fields use `field:XXXX` name pattern.
 */
const fillCustomField = (
	page: Page,
	fieldId: string,
	value: string,
): Effect.Effect<boolean, never> =>
	Effect.gen(function* () {
		const selectors = [
			`[name="fields[field-${fieldId}]"]`,
			`input[id*="${fieldId}"]`,
			`textarea[name*="${fieldId}"]`,
			`[data-field-id="${fieldId}"]`,
		];

		const result = yield* resolveSelector(page, selectors, 2000).pipe(
			Effect.map((resolved) => resolved),
			Effect.orElseSucceed(() => null),
		);

		if (!result) return false;

		yield* Effect.tryPromise({
			try: async () => {
				const tagName = await result.element.evaluate((el) => (el as Element).tagName.toLowerCase());
				if (tagName === 'select') {
					await page.selectOption(result.selector, value);
				} else if (tagName === 'textarea') {
					await result.element.fill(value);
				} else {
					const inputType = await result.element.evaluate(
						(el) => (el as HTMLInputElement).type,
					);
					if (inputType === 'checkbox') {
						const checked = await result.element.isChecked();
						if ((value === 'true') !== checked) {
							await result.element.click();
						}
					} else {
						await result.element.fill(value);
					}
				}
			},
			catch: () => null,
		}).pipe(Effect.orElseSucceed(() => null));

		return true;
	});

/**
 * Fill any required textareas that are still empty, inferring each answer from the
 * field's `<label>` text via the shared FieldMatcher (design §6 fuzzy-in for intake
 * fields). Acuity intake forms have mandatory custom fields (aria-required="true")
 * whose field IDs change when the practitioner edits the form, so the inference keys
 * off label TEXT, not ids.
 *
 * Result-equivalent to the legacy keyword ladder ("work on"/"session" → client notes
 * else "General wellness"; "sleep" → "7-8 hours"; else "N/A"), now producing a
 * `FuzzyResolution` per answered textarea for the journal. Structured in three phases —
 * scan (read empty required textareas + their labels), resolve (FieldMatcher, pure),
 * fill (write the resolved value) — so the matcher Effect threads cleanly between the
 * two DOM `tryPromise` boundaries.
 */
const fillRequiredTextareas = (
	page: Page,
	matcher: FuzzyMatcher<FieldMatchQuery, FieldRule>,
	clientNotes?: string,
): Effect.Effect<readonly FuzzyResolution<FieldRule>[], never> =>
	Effect.gen(function* () {
		// Phase 1: scan empty required textareas and their labels (one DOM round-trip).
		const fields = yield* Effect.tryPromise({
			try: async () => {
				const textareas = await page.$$('textarea[aria-required="true"]');
				const collected: { handle: (typeof textareas)[number]; label: string }[] = [];
				for (const textarea of textareas) {
					const currentValue = await textarea.evaluate(
						(el) => (el as HTMLTextAreaElement).value,
					);
					if (currentValue.trim()) continue; // Already filled

					const label = await textarea.evaluate((el) => {
						const container = el.closest('[class*="field"]') ?? el.parentElement;
						const labelEl = container?.querySelector('label');
						return labelEl?.textContent?.trim() ?? '';
					});
					collected.push({ handle: textarea, label });
				}
				return collected;
			},
			catch: () => [] as { handle: never; label: string }[],
		}).pipe(Effect.orElseSucceed(() => [] as { handle: never; label: string }[]));

		// Phase 2 + 3: resolve each label via the matcher, then fill the chosen value.
		const resolutions: FuzzyResolution<FieldRule>[] = [];
		for (const field of fields) {
			const { value, resolution } = yield* resolveFieldAnswer(matcher, field.label, clientNotes);
			if (resolution) resolutions.push(resolution);

			yield* Effect.tryPromise({
				try: async () => {
					await field.handle.scrollIntoViewIfNeeded();
					await field.handle.fill(value);
				},
				catch: () => undefined,
			}).pipe(Effect.orElseSucceed(() => undefined));
		}

		return resolutions;
	});

/**
 * Fill intake radio buttons.
 *
 * Acuity's radio buttons have NO name or id attributes — they are purely
 * React-controlled. The proven strategy is to click the <label> element
 * wrapping each radio via Playwright's locator().nth() API, which dispatches
 * OS-level mouse events that React's event delegation handles correctly.
 */
const fillIntakeRadios = (
	page: Page,
	answer: 'yes' | 'no',
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const selectorKey = answer === 'no' ? Selectors.radioNoLabel : Selectors.radioYesLabel;
			const labelLocator = page.locator(selectorKey[0]);
			const count = await labelLocator.count();

			for (let i = 0; i < count; i++) {
				await labelLocator.nth(i).scrollIntoViewIfNeeded();
				await labelLocator.nth(i).click({ timeout: 5000 });
				await page.waitForTimeout(200);
			}
		},
		catch: (e) =>
			new WizardStepError({
				step: 'fill-form',
				message: `Failed to fill radio buttons: ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

/**
 * Build the ":not(...)" exclusion fragment for the referral fallback. The terms
 * agreement checkbox must never be auto-checked as the referral answer; its
 * tenant custom-field id is profile DATA (`excludeFallbackFieldId`), not a
 * constant in this generic code. When the active profile names no exclusion,
 * the fallback matches any checkbox (vendor-neutral).
 */
const referralFallbackNot = (): string => {
	const fieldId = DEFAULT_SELECTOR_PROFILE.excludeFallbackFieldId;
	return fieldId ? `:not([name*="${fieldId}"])` : '';
};

/**
 * Select at least one "How did you hear" checkbox.
 *
 * These checkboxes have plain-text name attributes (the tenant intake option
 * names). Uses the same label-click locator strategy as radio buttons.
 */
const fillHowDidYouHear = (
	page: Page,
	option: string,
): Effect.Effect<void, WizardStepError> =>
	Effect.tryPromise({
		try: async () => {
			const labelLocator = page.locator(`label:has(input[type="checkbox"][name="${option}"])`);
			const count = await labelLocator.count();
			if (count > 0) {
				await labelLocator.first().scrollIntoViewIfNeeded();
				await labelLocator.first().click({ timeout: 3000 });
			} else {
				// Fallback: click the first checkbox that is not the terms field.
				const not = referralFallbackNot();
				const fallback = page.locator(`input[type="checkbox"]${not}`);
				const fallbackCount = await fallback.count();
				if (fallbackCount > 0) {
					const parent = page.locator(`label:has(input[type="checkbox"]${not})`);
					await parent.first().scrollIntoViewIfNeeded();
					await parent.first().click({ timeout: 3000 });
				}
			}
		},
		catch: (e) =>
			new WizardStepError({
				step: 'fill-form',
				message: `Failed to fill "How did you hear": ${e instanceof Error ? e.message : String(e)}`,
				cause: e,
			}),
	});

/**
 * Fill the medication textarea.
 */
const fillMedication = (
	page: Page,
	text: string,
): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: async () => {
			for (const selector of Selectors.medicationField) {
				const el = await page.$(selector);
				if (el) {
					await el.fill(text);
					return;
				}
			}
		},
		catch: () => undefined,
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Check the terms agreement checkbox via label click.
 */
const fillTermsCheckbox = (page: Page): Effect.Effect<void, never> =>
	Effect.tryPromise({
		try: async () => {
			const isChecked = await page
				.$eval(Selectors.termsCheckbox[0], (el) => (el as HTMLInputElement).checked)
				.catch(() => false);
			if (!isChecked) {
				const label = page.locator(`label:has(${Selectors.termsCheckbox[0]})`);
				await label.scrollIntoViewIfNeeded();
				await label.click({ timeout: 3000 });
			}
		},
		catch: () => undefined,
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Click "Continue to Payment" to advance past the client form.
 *
 * Verified 2026-02-26: "Continue to Payment" navigates to a SEPARATE
 * payment page at URL .../datetime/<ISO>/payment.
 */
const advancePastForm = (page: Page): Effect.Effect<boolean, WizardStepError> =>
	Effect.gen(function* () {
		const continueBtn = yield* resolveSelector(page, Selectors.continueToPayment, 5000).pipe(
			Effect.catchTag('SelectorError', () =>
				Effect.fail(
					new WizardStepError({
						step: 'fill-form',
						message: '"Continue to Payment" button not found after filling form',
					}),
				),
			),
		);

		yield* Effect.tryPromise({
			try: async () => {
				await continueBtn.element.click();
				// Wait for navigation to payment page (URL ends in /payment)
				// Increased timeout: Acuity's server-side validation can take 10-20s
				await page.waitForURL((url) => url.href.includes('/payment'), { timeout: 30000 });
			},
			catch: (e) =>
				new WizardStepError({
					step: 'fill-form',
					message: `Failed to advance to payment page: ${e instanceof Error ? e.message : String(e)}`,
					cause: e,
				}),
		});

		return true;
	});
