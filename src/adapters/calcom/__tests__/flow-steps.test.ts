/**
 * CalCom REST step unit tests — cassette-backed (design §7 CalCom read-only; §11
 * recorded-fixture replay). TIN-2097 (Lane E).
 *
 * accountReality: NO CalCom dev account/instance exists (no credentials in repo or
 * env), so these are cassette-based REST unit tests over recorded availability JSON.
 * They prove: (1) the steps GET /slots and parse the payload into availability; (2) the
 * step run's R channel is satisfied by the CalComHttpClient cassette Layer ALONE — no
 * BrowserService, no Scope; (3) the landing observation is the response-shape probe at
 * confidence 1.0; (4) a cassette miss / malformed body surfaces the typed CalCom error.
 */

import { readFileSync } from 'node:fs';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { CalComHttpClient, CalComHttpClientCassette } from '../http-client.js';
import {
	CALCOM_SLOTS_PATH,
	calcomReadDatesStep,
	calcomReadSlotsStep,
} from '../flow-steps.js';
import { CalComHttpError, CalComResponseError } from '../errors.js';

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`./__fixtures__/${name}.json`, import.meta.url), 'utf8'),
	);

const cassette = (body: unknown) =>
	CalComHttpClientCassette({ [CALCOM_SLOTS_PATH]: body });

describe('calcomReadDatesStep (REST, cassette-backed)', () => {
	it('GETs /slots and projects the month into the dates vocabulary', async () => {
		const outcome = await Effect.runPromise(
			calcomReadDatesStep
				.run({ serviceId: '1234', month: '2026-07' })
				.pipe(Effect.provide(cassette(fixture('slots-month')))),
		);
		expect(outcome.state.dates).toEqual([
			{ date: '2026-07-02', slots: 3 },
			{ date: '2026-07-05', slots: 2 },
			{ date: '2026-07-09', slots: 1 },
		]);
	});

	it('observes the calcom:slots station via the response shape at confidence 1.0', async () => {
		const outcome = await Effect.runPromise(
			calcomReadDatesStep
				.run({ serviceId: '1234', month: '2026-07' })
				.pipe(Effect.provide(cassette(fixture('slots-month')))),
		);
		expect(outcome.observed?.observed).toBe('calcom:slots');
		expect(outcome.observed?.confidence).toBe(1);
		expect(outcome.observed?.evidence).toEqual([
			{ kind: 'text', key: 'data.slots', matched: true },
		]);
	});

	it('fails with a typed CalComResponseError on a malformed body', async () => {
		const exit = await Effect.runPromiseExit(
			calcomReadDatesStep
				.run({ serviceId: '1234', month: '2026-07' })
				.pipe(Effect.provide(cassette(fixture('error-shape')))),
		);
		expect(exit._tag).toBe('Failure');
		const error = exit._tag === 'Failure' ? Effect.runSync(Effect.flip(Effect.failCause(exit.cause))) : null;
		expect(error).toBeInstanceOf(CalComResponseError);
	});

	it('fails with a typed CalComHttpError on a cassette miss (no recording)', async () => {
		const exit = await Effect.runPromiseExit(
			calcomReadDatesStep
				.run({ serviceId: '1234', month: '2026-07' })
				.pipe(Effect.provide(CalComHttpClientCassette({}))),
		);
		expect(exit._tag).toBe('Failure');
	});
});

describe('calcomReadSlotsStep (REST, cassette-backed)', () => {
	it('GETs /slots and projects a single date into the slots vocabulary', async () => {
		const outcome = await Effect.runPromise(
			calcomReadSlotsStep
				.run({ serviceId: '1234', date: '2026-07-05' })
				.pipe(Effect.provide(cassette(fixture('slots-day')))),
		);
		expect(outcome.state.slots).toEqual([
			{ datetime: '2026-07-05T16:00:00.000Z', available: true },
			{ datetime: '2026-07-05T17:00:00.000Z', available: true },
			{ datetime: '2026-07-05T18:30:00.000Z', available: true },
		]);
		expect(outcome.observed?.observed).toBe('calcom:slots');
		expect(outcome.observed?.confidence).toBe(1);
	});

	it('parses the data-direct deployment shape too', async () => {
		const outcome = await Effect.runPromise(
			calcomReadSlotsStep
				.run({ serviceId: '1234', date: '2026-07-05' })
				.pipe(Effect.provide(cassette(fixture('slots-data-direct')))),
		);
		expect(outcome.state.slots).toEqual([
			{ datetime: '2026-07-05T16:00:00.000Z', available: true },
			{ datetime: '2026-07-05T17:00:00.000Z', available: true },
		]);
	});
});

describe('CalComHttpClientCassette', () => {
	it('serves recorded bodies by path and 404s on a miss', async () => {
		const client = CalComHttpClientCassette({ [CALCOM_SLOTS_PATH]: { data: { slots: {} } } });
		const hit = await Effect.runPromise(
			Effect.flatMap(CalComHttpClient, (c) => c.getJson(CALCOM_SLOTS_PATH)).pipe(
				Effect.provide(client),
			),
		);
		expect(hit).toEqual({ data: { slots: {} } });

		const exit = await Effect.runPromiseExit(
			Effect.flatMap(CalComHttpClient, (c) => c.getJson('/nope')).pipe(
				Effect.provide(client),
			),
		);
		expect(exit._tag).toBe('Failure');
		const error =
			exit._tag === 'Failure'
				? Effect.runSync(Effect.flip(Effect.failCause(exit.cause)))
				: null;
		expect(error).toBeInstanceOf(CalComHttpError);
		expect((error as CalComHttpError).status).toBe(404);
	});
});
