const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_SLOT_PREWARM_LIMIT = 1;
const MAX_SLOT_PREWARM_LIMIT = 3;

export interface DateLike {
	readonly date?: unknown;
}

export const getSlotPrewarmLimit = (
	env: Record<string, string | undefined> = process.env,
): number => {
	const raw = env.ACUITY_SLOT_PREWARM_LIMIT;
	if (raw === undefined || raw === '') {
		return DEFAULT_SLOT_PREWARM_LIMIT;
	}

	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return DEFAULT_SLOT_PREWARM_LIMIT;
	}
	if (parsed <= 0) {
		return 0;
	}

	return Math.min(Math.floor(parsed), MAX_SLOT_PREWARM_LIMIT);
};

export const selectSlotPrewarmDates = (
	dates: readonly DateLike[],
	limit: number,
): string[] => {
	if (limit <= 0) return [];

	const selected: string[] = [];
	const seen = new Set<string>();
	for (const candidate of dates) {
		if (typeof candidate.date !== 'string') continue;
		if (!DATE_RE.test(candidate.date)) continue;
		if (seen.has(candidate.date)) continue;

		seen.add(candidate.date);
		selected.push(candidate.date);
		if (selected.length >= limit) break;
	}

	return selected;
};

export const buildAvailabilitySlotsCacheKey = (
	baseUrl: string,
	serviceId: string,
	date: string,
): string => `bridge-read:v2:slots:${baseUrl}:${serviceId}:${date}`;
