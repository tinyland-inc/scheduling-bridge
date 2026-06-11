import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readBenchFile = (name: string): string =>
	readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

describe('k6 benchmark protocol', () => {
	it.each(['k6-load-1k.js', 'k6-load-10k.js'])(
		'%s uses the deployed POST availability protocol',
		(fileName) => {
			const source = readBenchFile(fileName);

			expect(source).toContain('http.post');
			expect(source).toContain('`${BASE_URL}/availability/dates`');
			expect(source).toContain('`${BASE_URL}/availability/slots`');
			expect(source).toContain(
				'JSON.stringify({ serviceId, startDate: month })',
			);
			expect(source).toContain('JSON.stringify({ serviceId, date })');
			expect(source).toContain("'Content-Type': 'application/json'");
			expect(source).not.toContain('/availability/slots?');
			expect(source).not.toContain('/availability/dates?');
		},
	);
});
