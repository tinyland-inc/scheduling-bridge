/**
 * HTTP response helpers, body parsing, and request logging.
 *
 * Extracted verbatim from `src/server/handler.ts` (handler decomposition
 * phase 1, TIN-2036 / docs/design/flow-dag-formalization.md section 8).
 * Pure code motion: wire formats and log shapes are unchanged. The Bearer
 * auth gate itself stays inline in the server dispatch (it belongs to
 * `server/router.ts` in a later phase).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ndjsonLog } from '../shared/logger.js';
import type { SchedulingError } from '../core/types.js';

export interface SuccessResponse<T> {
	success: true;
	data: T;
}

export interface ErrorResponse {
	success: false;
	error: {
		tag: string;
		code: string;
		message: string;
	};
}

export const sendJson = (
	res: ServerResponse,
	status: number,
	body: SuccessResponse<unknown> | ErrorResponse,
) => {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
};

export const sendSuccess = <T>(res: ServerResponse, data: T) =>
	sendJson(res, 200, { success: true, data });

export const sendError = (
	res: ServerResponse,
	status: number,
	err: SchedulingError,
) =>
	sendJson(res, status, {
		success: false,
		error: {
			tag: err._tag,
			code: 'code' in err ? (err as { code: string }).code : err._tag,
			message:
				'message' in err
					? (err as { message: string }).message
					: 'Unknown error',
		},
	});

export const sendValidationError = (
	res: ServerResponse,
	code: string,
	message: string,
) =>
	sendJson(res, 400, {
		success: false,
		error: {
			tag: 'ValidationError',
			code,
			message,
		},
	});

export const parseBody = async (req: IncomingMessage): Promise<unknown> => {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString('utf8');
	return raw ? JSON.parse(raw) : {};
};

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface RequestContext {
	readonly requestId: string;
	readonly method: string;
	readonly path: string;
	readonly startedAt: number;
}

export const runtimeLogFields = () => ({
	flowOwner: 'scheduling-bridge',
	backend: 'acuity',
	transport: 'http-json',
	modalEnvironment: process.env.MODAL_ENVIRONMENT,
	releaseSha: process.env.MIDDLEWARE_RELEASE_SHA,
	releaseVersion:
		process.env.MIDDLEWARE_RELEASE_VERSION ?? process.env.npm_package_version,
});

export const logEvent = (
	level: LogLevel,
	msg: string,
	data?: Record<string, unknown>,
) => {
	ndjsonLog(level, msg, {
		...runtimeLogFields(),
		...data,
	});
};

export const logRequestEvent = (
	level: LogLevel,
	msg: string,
	context: RequestContext,
	data?: Record<string, unknown>,
) => {
	logEvent(level, msg, {
		event: 'request',
		requestId: context.requestId,
		method: context.method,
		path: context.path,
		...data,
	});
};

export const describeLogValue = (value: unknown): string => {
	if (typeof value === 'string') return value;
	if (value instanceof Error) return value.message;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};

export const createServiceCatalogLogger = () => ({
	log: (...args: unknown[]) =>
		logEvent('INFO', 'Service catalog event', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
	warn: (...args: unknown[]) =>
		logEvent('WARN', 'Service catalog warning', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
	error: (...args: unknown[]) =>
		logEvent('ERROR', 'Service catalog error', {
			event: 'service_catalog',
			detail: args.map(describeLogValue).join(' '),
		}),
});

export const createSlotReadTelemetryContext = (
	context: RequestContext,
	endpoint: string,
) => ({
	requestId: context.requestId,
	endpoint,
	...runtimeLogFields(),
});
