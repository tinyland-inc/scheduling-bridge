/**
 * CalCom slots-response parser tests (design §7 CalCom read-only; §11 recorded fixtures).
 * TIN-2097 (Lane E).
 *
 * Cassette-based: recorded CalCom availability JSON (no live API — see accountReality)
 * drives the pure parsers, proving the steps parse a real CalCom availability payload
 * into the Acuity-shaped dates/slots projections, and that the response-shape probe
 * (detectStation degeneration) accepts/rejects shapes at binary confidence.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parseSlotsResponse,
	probeSlotsResponse,
	slotsForDate,
	slotsToDates,
} from '../slots-api.js';
import { CalComResponseError } from '../errors.js';

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'),
	);

const monthBody = fixture('slots-month');
const dayBody = fixture('slots-day');
const dataDirectBody = fixture('slots-data-direct');
const errorBody = fixture('error-shape');

describe('probeSlotsResponse (the response-shape landing probe)', () => {
	it('accepts the documented data.slots envelope', () => {
		const slots = probeSlotsResponse(monthBody);
		expect(slots).not.toBeNull();
		expect(Object.keys(slots ?? {}).sort()).toEqual([
			'2026-07-02',
			'2026-07-05',
			'2026-07-09',
		]);
	});

	it('accepts the data-direct deployment shape (no slots key)', () => {
		expect(probeSlotsResponse(dataDirectBody)).not.toBeNull();
	});

	it('rejects an error-shaped response', () => {
		expect(probeSlotsResponse(errorBody)).toBeNull();
	});

	it('rejects non-objects and shapes whose values are not slot arrays', () => {
		expect(probeSlotsResponse(null)).toBeNull();
		expect(probeSlotsResponse('nope')).toBeNull();
		expect(probeSlotsResponse({ data: { slots: { '2026-07-02': 'not-an-array' } } })).toBeNull();
		expect(
			probeSlotsResponse({ data: { slots: { '2026-07-02': [{ noStart: true }] } } }),
		).toBeNull();
	});

	it('treats an empty slots map as a valid (no-availability) shape', () => {
		expect(probeSlotsResponse({ data: { slots: {} } })).toEqual({});
	});
});

describe('parseSlotsResponse', () => {
	it('returns the located slots map on a valid body', () => {
		const parsed = parseSlotsResponse('/slots', monthBody);
		expect(parsed).not.toBeInstanceOf(CalComResponseError);
	});

	it('returns a typed CalComResponseError on a malformed body', () => {
		const parsed = parseSlotsResponse('/slots', errorBody);
		expect(parsed).toBeInstanceOf(CalComResponseError);
		expect((parsed as CalComResponseError)._tag).toBe('CalComResponseError');
	});
});

describe('slotsToDates (DATES projection, Acuity-shaped)', () => {
	it('maps each date to its slot count, sorted by date', () => {
		const slots = probeSlotsResponse(monthBody);
		expect(slotsToDates(slots ?? {})).toEqual([
			{ date: '2026-07-02', slots: 3 },
			{ date: '2026-07-05', slots: 2 },
			{ date: '2026-07-09', slots: 1 },
		]);
	});
});

describe('slotsForDate (SLOTS projection, Acuity-shaped)', () => {
	it('maps a requested date to its available datetimes, sorted', () => {
		const slots = probeSlotsResponse(dayBody);
		expect(slotsForDate(slots ?? {}, '2026-07-05')).toEqual([
			{ datetime: '2026-07-05T16:00:00.000Z', available: true },
			{ datetime: '2026-07-05T17:00:00.000Z', available: true },
			{ datetime: '2026-07-05T18:30:00.000Z', available: true },
		]);
	});

	it('returns an empty list for a date with no slots in the response', () => {
		const slots = probeSlotsResponse(dayBody);
		expect(slotsForDate(slots ?? {}, '2026-07-06')).toEqual([]);
	});
});
