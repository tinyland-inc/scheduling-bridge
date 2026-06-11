import { describe, expect, it } from 'vitest';

import {
	buildAvailabilitySlotsCacheKey,
	getSlotPrewarmLimit,
	selectSlotPrewarmDates,
} from './slot-prewarm.js';

describe('slot prewarm helpers', () => {
	it('defaults to one slot prewarm and caps aggressive env values', () => {
		expect(getSlotPrewarmLimit({})).toBe(1);
		expect(getSlotPrewarmLimit({ ACUITY_SLOT_PREWARM_LIMIT: '2' })).toBe(2);
		expect(getSlotPrewarmLimit({ ACUITY_SLOT_PREWARM_LIMIT: '99' })).toBe(3);
	});

	it('allows disabling slot prewarm with zero or negative env values', () => {
		expect(getSlotPrewarmLimit({ ACUITY_SLOT_PREWARM_LIMIT: '0' })).toBe(0);
		expect(getSlotPrewarmLimit({ ACUITY_SLOT_PREWARM_LIMIT: '-1' })).toBe(0);
	});

	it('selects unique valid dates up to the configured limit', () => {
		const selected = selectSlotPrewarmDates(
			[
				{ date: '2026-08-02' },
				{ date: 'not-a-date' },
				{ date: '2026-08-02' },
				{ date: '2026-08-03' },
				{ date: '2026-08-04' },
			],
			2,
		);

		expect(selected).toEqual(['2026-08-02', '2026-08-03']);
	});

	it('builds the same slot cache key used by the public slot route', () => {
		expect(
			buildAvailabilitySlotsCacheKey(
				'https://MassageIthaca.as.me',
				'53178494',
				'2026-08-02',
			),
		).toBe('bridge-read:v2:slots:https://MassageIthaca.as.me:53178494:2026-08-02');
	});
});
