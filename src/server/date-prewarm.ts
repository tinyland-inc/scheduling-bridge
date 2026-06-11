const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^(\d{4})-(\d{2})-\d{2}$/;
const DEFAULT_DATE_PREWARM_MONTHS = 1;
const MAX_DATE_PREWARM_MONTHS = 2;

export const getDatePrewarmMonths = (
	env: Record<string, string | undefined> = process.env,
): number => {
	const raw = env.ACUITY_DATE_PREWARM_MONTHS;
	if (raw === undefined || raw === '') {
		return DEFAULT_DATE_PREWARM_MONTHS;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_DATE_PREWARM_MONTHS;
	}
	if (parsed <= 0) {
		return 0;
	}

	return Math.min(Math.floor(parsed), MAX_DATE_PREWARM_MONTHS);
};

export const buildAvailabilityDatesCacheKey = (
	baseUrl: string,
	serviceId: string,
	targetMonth: string,
): string => `bridge-read:v2:dates:${baseUrl}:${serviceId}:${targetMonth}`;

const parseYearMonth = (
	value: string | undefined,
	now = new Date(),
): { year: number; month: number } => {
	if (value && YEAR_MONTH_RE.test(value)) {
		return {
			year: Number.parseInt(value.slice(0, 4), 10),
			month: Number.parseInt(value.slice(5, 7), 10),
		};
	}

	const dateMatch = value?.match(DATE_RE);
	if (dateMatch) {
		return {
			year: Number.parseInt(dateMatch[1], 10),
			month: Number.parseInt(dateMatch[2], 10),
		};
	}

	return {
		year: now.getFullYear(),
		month: now.getMonth() + 1,
	};
};

const formatYearMonth = (year: number, month: number): string => {
	const normalized = new Date(Date.UTC(year, month - 1, 1));
	return `${normalized.getUTCFullYear()}-${String(normalized.getUTCMonth() + 1).padStart(2, '0')}`;
};

export const selectDatePrewarmMonths = (
	currentMonth: string | undefined,
	limit: number,
	now = new Date(),
): string[] => {
	if (limit <= 0) return [];

	const base = parseYearMonth(currentMonth, now);
	return Array.from({ length: limit }, (_, index) =>
		formatYearMonth(base.year, base.month + index + 1),
	);
};
