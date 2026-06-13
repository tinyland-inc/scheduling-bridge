import { describe, expect, it } from 'vitest';
import {
	DEFAULT_FLOW_JOURNAL_SAMPLE_RATE,
	DEFAULT_FLOW_JOURNAL_TTL_SECONDS,
	parseFlowJournalSampleRate,
	parseFlowJournalTtlSeconds,
	shouldJournalReadFlow,
} from '../journal-config.js';
import { DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS } from '../../async/config.js';

describe('flow journal config', () => {
	it('leaves journal TTL unset when no env override is configured', () => {
		expect(parseFlowJournalTtlSeconds({})).toBeUndefined();
		expect(DEFAULT_FLOW_JOURNAL_TTL_SECONDS).toBe(1209600);
	});

	it('is a dedicated knob, decoupled from the job-record TTL', () => {
		expect(DEFAULT_FLOW_JOURNAL_TTL_SECONDS).not.toBe(
			DEFAULT_REDIS_ASYNC_JOB_TTL_SECONDS,
		);
	});

	it('parses positive journal TTL seconds from env', () => {
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '900' }),
		).toBe(900);
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '90.9' }),
		).toBe(90);
	});

	it('ignores invalid journal TTL env values so the default applies', () => {
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '0' }),
		).toBeUndefined();
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: '-1' }),
		).toBeUndefined();
		expect(
			parseFlowJournalTtlSeconds({ BRIDGE_FLOW_JOURNAL_TTL_SECONDS: 'nope' }),
		).toBeUndefined();
	});
});

describe('read-flow journal sampling (BRIDGE_FLOW_JOURNAL_SAMPLE)', () => {
	it('defaults to 1.0 (journal every read flow — current behavior)', () => {
		expect(parseFlowJournalSampleRate({})).toBe(1);
		expect(DEFAULT_FLOW_JOURNAL_SAMPLE_RATE).toBe(1);
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '' })).toBe(1);
	});

	it('parses an in-range fraction', () => {
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '0' })).toBe(0);
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '0.25' })).toBe(0.25);
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '1' })).toBe(1);
	});

	it('falls back to the default for out-of-range or junk values', () => {
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '-0.1' })).toBe(1);
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: '1.5' })).toBe(1);
		expect(parseFlowJournalSampleRate({ BRIDGE_FLOW_JOURNAL_SAMPLE: 'nope' })).toBe(1);
	});

	it('decides per-run journaling deterministically with an injected draw', () => {
		// rate 1 always journals (the default — behavior unchanged).
		expect(shouldJournalReadFlow(1, () => 0.99)).toBe(true);
		// rate 0 never journals.
		expect(shouldJournalReadFlow(0, () => 0)).toBe(false);
		// fractional rate: draw < rate journals, draw >= rate skips.
		expect(shouldJournalReadFlow(0.5, () => 0.49)).toBe(true);
		expect(shouldJournalReadFlow(0.5, () => 0.5)).toBe(false);
		expect(shouldJournalReadFlow(0.5, () => 0.51)).toBe(false);
	});
});
