/**
 * CalCom v2 `/slots` response parsing — pure functions over the recorded shape.
 * Design: docs/design/flow-dag-formalization.md §7 (CalCom read-only), §10 risk-10
 * ("Landing observation degenerates to response-shape checks (confidence 1.0)").
 * TIN-2097 (Lane E).
 *
 * CalCom API v2 slots shape (public docs, read-only):
 *   GET /slots  (eventTypeId|eventTypeSlug+username, start, end, timeZone)
 *   → { status: 'success', data: { slots: { "YYYY-MM-DD": [{ start: ISO8601 }, ...] } } }
 *       (some deployments return `data` directly as the date→slots map)
 *
 * These mappings keep the SAME projection the Acuity availability steps produce, so the
 * CalCom flows can reuse the Acuity flow ids and state vocab:
 *   - dates: `{ date: string; slots: number }[]`  (date = the map key; slots = array length)
 *   - slots: `{ datetime: string; available: boolean }[]`  (datetime = each entry's start)
 */

import { CalComResponseError } from './errors.js';

/** A single CalCom slot entry (only `start` is load-bearing for read-only availability). */
export interface CalComSlotEntry {
	readonly start: string;
}

/** The date→slots map: keys are 'YYYY-MM-DD', values are arrays of slot entries. */
export type CalComSlotsByDate = Readonly<Record<string, readonly CalComSlotEntry[]>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isSlotEntry = (value: unknown): value is CalComSlotEntry =>
	isRecord(value) && typeof value.start === 'string';

/**
 * Response-shape probe (design §10 risk-10 / detectStation degeneration): is this a
 * well-formed CalCom slots response? A 2xx body with a reachable `slots` date→array map.
 * This is the REST analogue of the Acuity DOM landing probe — confidence is binary
 * (present ⇒ 1.0). Returns the located slots map, or null when the shape does not match.
 */
export const probeSlotsResponse = (body: unknown): CalComSlotsByDate | null => {
	if (!isRecord(body)) return null;
	// `data.slots` (documented envelope) or `data` directly (some deployments).
	const data = isRecord(body.data) ? body.data : body;
	const slotsCandidate = isRecord(data.slots) ? data.slots : data;
	if (!isRecord(slotsCandidate)) return null;
	// A slots map's values must all be arrays of slot entries; an empty map is valid
	// (no availability), but a map whose values are not slot arrays is NOT a slots map.
	const entries = Object.entries(slotsCandidate);
	if (entries.some(([, value]) => !Array.isArray(value) || !value.every(isSlotEntry))) {
		return null;
	}
	return slotsCandidate as CalComSlotsByDate;
};

/** Parse a slots response into the located date→slots map, or a typed shape error. */
export const parseSlotsResponse = (
	path: string,
	body: unknown,
): CalComSlotsByDate | CalComResponseError => {
	const slots = probeSlotsResponse(body);
	if (slots === null) {
		return new CalComResponseError({
			path,
			message: `CalCom ${path} response did not match the slots shape`,
		});
	}
	return slots;
};

/**
 * Project a CalCom slots map onto the Acuity-shaped DATES vocabulary: one entry per
 * date in the requested month window, `slots` = the count of available start times.
 * Sorted by date for deterministic snapshots/cassettes.
 */
export const slotsToDates = (
	slots: CalComSlotsByDate,
): readonly { readonly date: string; readonly slots: number }[] =>
	Object.entries(slots)
		.map(([date, entries]) => ({ date, slots: entries.length }))
		.sort((a, b) => a.date.localeCompare(b.date));

/**
 * Project the slot entries for a single requested date onto the Acuity-shaped SLOTS
 * vocabulary: `{ datetime, available }`. A CalCom slot present in the response IS an
 * available slot (the endpoint only returns bookable times), so `available` is true.
 * Dates absent from the response yield an empty list. Sorted by datetime.
 */
export const slotsForDate = (
	slots: CalComSlotsByDate,
	date: string,
): readonly { readonly datetime: string; readonly available: boolean }[] =>
	(slots[date] ?? [])
		.map((entry) => ({ datetime: entry.start, available: true }))
		.sort((a, b) => a.datetime.localeCompare(b.datetime));
