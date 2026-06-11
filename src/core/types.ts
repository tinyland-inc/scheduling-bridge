/**
 * Re-export core types from @tummycrypt/scheduling-kit.
 *
 * We selectively re-export only the types module (not utils/pipelines)
 * to keep the dependency surface minimal in the published package.
 */
export type {
  AcuityError,
  CalComError,
  PaymentError,
  ValidationError,
  ReservationError,
  IdempotencyError,
  InfrastructureError,
  SchedulingError,
  SchedulingResult,
  SchedulingReader,
  Service,
  Provider,
  TimeSlot,
  AvailableDate,
  ClientInfo,
  BookingRequest,
  Booking,
  BookingStatus,
  PaymentStatus,
  SlotSoftHold,
  PaymentIntent,
  PaymentResult,
  RefundResult,
  SchedulingConfig,
} from '@tummycrypt/scheduling-kit/core';

export { Errors } from '@tummycrypt/scheduling-kit/core';
