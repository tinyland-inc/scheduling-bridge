// bench/k6-load-1k.js — ~1000 req ramped load test
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
	stages: [
		{ duration: '30s', target: 10 }, // ramp up to 10 VUs
		{ duration: '2m', target: 10 }, // hold at 10 VUs
		{ duration: '30s', target: 0 }, // ramp down
	],
	thresholds: {
		http_req_failed: ['rate<0.02'],
		http_req_duration: ['p(99)<10000'],
	},
};

const BASE_URL = __ENV.BASE_URL || 'http://ts-acuity-mw.ts.net:3001';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

const parseList = (value) =>
	value
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

// Massage Ithaca's TMD consultation appointment type. Override for other tenants.
const SERVICE_IDS = parseList(__ENV.SERVICE_IDS || '53178494');

// Simple date helper: YYYY-MM-DD for tomorrow
const tomorrow = () => {
	const d = new Date();
	d.setDate(d.getDate() + 1);
	return d.toISOString().slice(0, 10);
};

const monthOffset = (offset) => {
	const d = new Date();
	d.setUTCDate(1);
	d.setUTCMonth(d.getUTCMonth() + offset);
	return d.toISOString().slice(0, 7);
};

const DATE_MONTHS = parseList(
	__ENV.DATE_MONTHS || `${monthOffset(0)},${monthOffset(1)}`,
);
const SLOT_DATES = parseList(__ENV.SLOT_DATES || tomorrow());

const authHeaders = () =>
	AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {};

const jsonHeaders = () => ({
	...authHeaders(),
	'Content-Type': 'application/json',
});

const hasArrayPayload = (r) =>
	Array.isArray(r.json('data')) ||
	Array.isArray(r.json('services')) ||
	Array.isArray(r.json());

const serviceIdFor = (iterationGroup) =>
	SERVICE_IDS[iterationGroup % SERVICE_IDS.length];
const monthFor = (iterationGroup) =>
	DATE_MONTHS[iterationGroup % DATE_MONTHS.length];
const slotDateFor = (iterationGroup) =>
	SLOT_DATES[iterationGroup % SLOT_DATES.length];

export default function () {
	const target = __ENV.TARGET || 'unknown';

	// Alternate across service catalog, date cache, and slot cache paths.
	const iteration = __ITER % 3;
	const group = Math.floor(__ITER / 3);
	if (iteration === 0) {
		const res = http.get(`${BASE_URL}/services`, {
			headers: authHeaders(),
			tags: { target, endpoint: 'services' },
		});
		check(res, {
			'status 200': (r) => r.status === 200,
			'services array present': hasArrayPayload,
		});
	} else if (iteration === 1) {
		const serviceId = serviceIdFor(group);
		const month = monthFor(group);
		const res = http.post(
			`${BASE_URL}/availability/dates`,
			JSON.stringify({ serviceId, startDate: month }),
			{
				headers: jsonHeaders(),
				tags: { target, endpoint: 'availability_dates' },
			},
		);
		check(res, {
			'status 200': (r) => r.status === 200,
			'dates array present': hasArrayPayload,
		});
	} else {
		const serviceId = serviceIdFor(group);
		const date = slotDateFor(group);
		const res = http.post(
			`${BASE_URL}/availability/slots`,
			JSON.stringify({ serviceId, date }),
			{
				headers: jsonHeaders(),
				tags: { target, endpoint: 'availability_slots' },
			},
		);
		check(res, {
			'status 200': (r) => r.status === 200,
			'slots array present': hasArrayPayload,
		});
	}

	sleep(0.1);
}
