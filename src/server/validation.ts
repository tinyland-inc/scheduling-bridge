/**
 * Request-body validation primitives.
 *
 * Extracted verbatim from `src/server/handler.ts` (handler decomposition
 * phase 1, TIN-2036 / docs/design/flow-dag-formalization.md section 8).
 * Pure code motion: parser semantics are unchanged.
 */

import type { SchedulingError } from '../core/types.js';

export const isSchedulingError = (error: unknown): error is SchedulingError =>
	typeof error === 'object' && error !== null && '_tag' in error;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

export const isNonEmptyString = (value: unknown): value is string =>
	typeof value === 'string' && value.trim().length > 0;

export const optionalString = (value: unknown): string | undefined | null => {
	if (value === undefined) return undefined;
	return typeof value === 'string' ? value : null;
};

export const YEAR_MONTH_RE = /^\d{4}-\d{2}$/;
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
