import { describe, expect, it, vi } from 'vitest';
import { createInMemoryBridgeAsyncStore } from './store.js';
import {
	BridgeJobExecutionError,
	drainReadyBridgeJobs,
	executeBridgeJob,
	selectBookingExecutionPath,
	type BridgeJobExecutor,
} from './worker.js';
import type { BridgeJobCommand } from './types.js';

const profile = {
	backend: 'acuity' as const,
	baseUrl: 'https://example.as.me',
};

const executor = (): BridgeJobExecutor => ({
	refreshAvailabilityDates: vi.fn(async () => [{ date: '2026-06-15' }]),
	refreshAvailabilitySlots: vi.fn(async () => [{
		datetime: '2026-06-15T16:00:00.000Z',
		available: true,
	}]),
	createBookingWithPayment: vi.fn(async (command, _context) => ({
		id: 'apt_123',
		serviceId: command.request.serviceId,
		serviceName: command.serviceName ?? command.request.serviceId,
		datetime: command.request.datetime,
		duration: 30,
		price: 10500,
		currency: 'USD',
		client: command.request.client,
		status: 'confirmed',
		confirmationCode: 'confirm_123',
		paymentStatus: 'paid',
		paymentRef: command.paymentRef,
		createdAt: '2026-05-08T12:00:00.000Z',
	})),
});

describe('Bridge async worker', () => {
	it('executes refresh jobs into versioned availability snapshots', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const job = await store.enqueueJob({
			kind: 'availability_dates_refresh',
			command: {
				serviceId: '53178494',
				month: '2026-06',
				adapterProfile: profile,
			},
		});

		const result = await executeBridgeJob(store, job, executor(), {
			workerId: 'worker-a',
			now: new Date('2026-05-08T12:00:00.000Z'),
		});

		expect(result).toMatchObject({
			operationId: job.operationId,
			status: 'succeeded',
			result: {
				kind: 'availability_dates_refresh',
				dates: [{ date: '2026-06-15' }],
			},
		});
		await expect(store.getAvailabilitySnapshot({
			kind: 'dates',
			serviceId: '53178494',
			scope: '2026-06',
			baseUrl: profile.baseUrl,
		})).resolves.toMatchObject({
			sourceJobId: job.operationId,
			value: [{ date: '2026-06-15' }],
		});
	});

	it('marks post-submit booking failures as reconcile-required instead of pre-submit failures', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const job = await store.enqueueJob({
			kind: 'booking_create_with_payment',
			command: {
				request: {
					serviceId: '53178494',
					datetime: '2026-06-15T16:00:00.000Z',
					client: {
						firstName: 'Jess',
						lastName: 'Sullivan',
						email: 'jess@example.com',
						phone: '6075551212',
					},
				},
				paymentRef: 'pi_test_123',
				paymentProcessor: 'stripe',
				couponCode: 'TEST-100',
				serviceName: 'TMD single session',
				adapterProfile: profile,
				couponBypassRequired: true,
				executionPreference: 'auto',
			},
		} satisfies BridgeJobCommand);
		const failingExecutor = executor();
		vi.mocked(failingExecutor.createBookingWithPayment).mockRejectedValueOnce(
			new BridgeJobExecutionError({
				status: 'reconcile_required',
				code: 'SUBMIT_TIMEOUT',
				message: 'Timed out after submit click',
				step: 'submit',
				retryable: false,
				artifactRefs: ['artifact://trace/123'],
			}),
		);

		const result = await executeBridgeJob(store, job, failingExecutor, {
			workerId: 'worker-a',
		});

		expect(result).toMatchObject({
			status: 'reconcile_required',
			failure: {
				status: 'reconcile_required',
				code: 'SUBMIT_TIMEOUT',
				step: 'submit',
				retryable: false,
				artifactRefs: ['artifact://trace/123'],
			},
		});
	});

	it('drains ready jobs in created order', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.enqueueJob({
			kind: 'availability_dates_refresh',
			command: {
				serviceId: '53178494',
				month: '2026-06',
				adapterProfile: profile,
			},
		});
		await store.enqueueJob({
			kind: 'availability_slots_refresh',
			command: {
				serviceId: '53178494',
				date: '2026-06-15',
				adapterProfile: profile,
			},
		});

		const results = await drainReadyBridgeJobs(store, executor(), {
			workerId: 'worker-a',
			limit: 10,
		});

		expect(results.map((job) => job.kind)).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
		]);
		expect(results.every((job) => job.status === 'succeeded')).toBe(true);
	});

	it('can drain ready jobs with bounded concurrency', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.enqueueJob({
			kind: 'availability_dates_refresh',
			command: {
				serviceId: '53178494',
				month: '2026-06',
				adapterProfile: profile,
			},
		});
		await store.enqueueJob({
			kind: 'availability_slots_refresh',
			command: {
				serviceId: '53178494',
				date: '2026-06-15',
				adapterProfile: profile,
			},
		});

		const started: string[] = [];
		let releaseDates: (() => void) | undefined;
		let releaseSlots: (() => void) | undefined;
		const concurrentExecutor = executor();
		vi.mocked(concurrentExecutor.refreshAvailabilityDates).mockImplementationOnce(
			async () => {
				started.push('dates');
				await new Promise<void>((resolve) => {
					releaseDates = resolve;
				});
				return [{ date: '2026-06-15' }];
			},
		);
		vi.mocked(concurrentExecutor.refreshAvailabilitySlots).mockImplementationOnce(
			async () => {
				started.push('slots');
				await new Promise<void>((resolve) => {
					releaseSlots = resolve;
				});
				return [{
					datetime: '2026-06-15T16:00:00.000Z',
					available: true,
				}];
			},
		);

		const drain = drainReadyBridgeJobs(store, concurrentExecutor, {
			workerId: 'worker-a',
			limit: 2,
			concurrency: 2,
		});
		await vi.waitFor(() => {
			expect(started).toEqual(['dates', 'slots']);
		});

		releaseDates?.();
		releaseSlots?.();
		const results = await drain;

		expect(results.map((job) => job.kind)).toEqual([
			'availability_dates_refresh',
			'availability_slots_refresh',
		]);
		expect(results.every((job) => job.status === 'succeeded')).toBe(true);
	});

	it('requeues booking jobs when a fresh slot snapshot cannot be produced within the blocking window', async () => {
		const store = createInMemoryBridgeAsyncStore();
		const job = await store.enqueueJob({
			kind: 'booking_create_with_payment',
			command: {
				request: {
					serviceId: '53178494',
					datetime: '2026-06-15T16:00:00.000Z',
					client: {
						firstName: 'Jess',
						lastName: 'Sullivan',
						email: 'jess@example.com',
						phone: '6075551212',
					},
				},
				paymentRef: 'pi_test_123',
				paymentProcessor: 'stripe',
				couponCode: 'TEST-100',
				serviceName: 'TMD single session',
				adapterProfile: profile,
				couponBypassRequired: true,
				executionPreference: 'auto',
				onDemandRefreshWaitMs: 1,
			},
		} satisfies BridgeJobCommand);
		const slowExecutor = executor();
		vi.mocked(slowExecutor.refreshAvailabilitySlots).mockReturnValueOnce(
			new Promise(() => undefined),
		);

		const result = await executeBridgeJob(store, job, slowExecutor, {
			workerId: 'worker-a',
		});

		expect(result).toMatchObject({
			status: 'queued',
			failure: {
				code: 'SNAPSHOT_REFRESH_TIMEOUT',
				retryable: true,
			},
		});
		expect(slowExecutor.createBookingWithPayment).not.toHaveBeenCalled();
	});

	it('selects REST only when tenant admin API is configured and coupon bypass is not required', () => {
		const baseCommand = {
			request: {
				serviceId: '53178494',
				datetime: '2026-06-15T16:00:00.000Z',
				client: {
					firstName: 'Jess',
					lastName: 'Sullivan',
					email: 'jess@example.com',
					phone: '6075551212',
				},
			},
			paymentRef: 'pi_test_123',
			paymentProcessor: 'stripe',
			couponCode: 'TEST-100',
			serviceName: 'TMD single session',
			adapterProfile: profile,
			couponBypassRequired: false,
			executionPreference: 'auto' as const,
		};

		expect(selectBookingExecutionPath({
			...baseCommand,
			adapterProfile: { ...profile, adminApiConfigured: true },
		})).toBe('rest');
		expect(selectBookingExecutionPath({
			...baseCommand,
			adapterProfile: { ...profile, adminApiConfigured: true },
			couponBypassRequired: true,
		})).toBe('browser');
		expect(selectBookingExecutionPath({
			...baseCommand,
			adapterProfile: profile,
		})).toBe('browser');
	});

	it('returns failed refresh records with operation and scope data for worker logs', async () => {
		const store = createInMemoryBridgeAsyncStore();
		await store.enqueueJob({
			kind: 'availability_dates_refresh',
			command: {
				serviceId: '53178494',
				month: '2026-06',
				adapterProfile: profile,
			},
		});
		const failingExecutor = executor();
		vi.mocked(failingExecutor.refreshAvailabilityDates).mockRejectedValueOnce(
			new BridgeJobExecutionError({
				code: 'SCRAPE_FAILED',
				message: 'Calendar did not load within timeout',
				step: 'refresh-availability-dates',
				retryable: true,
			}),
		);

		const results = await drainReadyBridgeJobs(store, failingExecutor, {
			workerId: 'worker-a',
			limit: 10,
		});

		expect(results).toEqual([
			expect.objectContaining({
				operationId: expect.any(String),
				kind: 'availability_dates_refresh',
				status: 'failed_pre_submit',
				command: expect.objectContaining({
					serviceId: '53178494',
					month: '2026-06',
				}),
				failure: expect.objectContaining({
					code: 'SCRAPE_FAILED',
					step: 'refresh-availability-dates',
					retryable: true,
				}),
			}),
		]);
	});
});
