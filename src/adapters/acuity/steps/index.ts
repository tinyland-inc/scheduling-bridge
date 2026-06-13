/**
 * Wizard Steps - Individual programs for each stage of the Acuity wizard.
 */

export { navigateToBooking, type NavigateParams, type NavigateResult } from './navigate.js';
export { fillFormFields, type FillFormParams, type FillFormResult } from './fill-form.js';
export {
	bypassPayment,
	generateCouponCode,
	type BypassPaymentResult,
} from './bypass-payment.js';
export {
	openCouponEntry,
	applyCoupon,
	verifyZeroTotal,
	type VerifyZeroTotalResult,
} from './payment-segment.js';
export { submitBooking, type SubmitResult } from './submit.js';
export {
	extractConfirmation,
	toBooking,
	type ConfirmationData,
} from './extract.js';
export {
	readAvailableDates,
	type ReadAvailabilityParams,
	type AvailableDateResult,
} from './read-availability.js';
export {
	readTimeSlots,
	type ReadSlotsParams,
	type SlotResult,
} from './read-slots.js';
export {
	extractBusinessFromPage,
	extractBusinessFromHtml,
	extractBusinessServices,
	fetchBusinessData,
	businessToServices,
	type AcuityAppointmentType,
	type AcuityCalendar,
	type AcuityBusinessData,
} from './extract-business.js';
