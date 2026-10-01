/** Calendar mutation contracts and sanitized scheduling errors. */

import type { SlotHold, TimeSlot } from "../state.js";

/** Persisted appointment lifecycle mirrored by the scheduling database. */
export type CalendarAppointmentStatus =
  | "held"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show";

/** Tenant-scoped appointment snapshot used for optimistic rescheduling. */
export interface CalendarAppointment {
  appointment_id: string;
  tenant_id: string;
  version: number;
  status: CalendarAppointmentStatus;
  resource_id: string;
  starts_at_iso: string;
  ends_at_iso: string;
}

/** Fully validated source appointment for one atomic reschedule request. */
export interface RescheduleAppointmentCommand {
  tenant_id: string;
  appointment_id: string;
  expected_version: number;
  hold_id: string;
  target_slot_id: string;
  idempotency_key: string;
}

/** Stable result committed with an atomic reschedule operation. */
export interface RescheduleAppointmentResult {
  appointment_id: string;
  previous_version: number;
  version: number;
  hold_id: string;
  target_slot_id: string;
  status: "confirmed";
}

/** Domain error returned when a slot cannot be held or confirmed. */
export class SlotUnavailableError extends Error {
  /** Create a slot conflict error. */
  constructor(readonly slot_id: string) {
    super(`slot-unavailable: ${slot_id}`);
    this.name = "SlotUnavailableError";
  }
}

/** Domain error returned when a hold is absent, expired, released, or foreign. */
export class HoldExpiredError extends Error {
  /** Create a hold lifecycle error. */
  constructor(readonly hold_id: string) {
    super(`hold-expired: ${hold_id}`);
    this.name = "HoldExpiredError";
  }
}

/** Domain error returned when an appointment is absent inside the tenant. */
export class AppointmentNotFoundError extends Error {
  /** Create a tenant-safe not-found error. */
  constructor(readonly appointment_id: string) {
    super(`appointment-not-found: ${appointment_id}`);
    this.name = "AppointmentNotFoundError";
  }
}

/** Domain error returned when the source appointment changed after the offer. */
export class AppointmentVersionConflictError extends Error {
  /** Create an optimistic concurrency error. */
  constructor(readonly appointment_id: string) {
    super(`appointment-version-conflict: ${appointment_id}`);
    this.name = "AppointmentVersionConflictError";
  }
}

/** Domain error returned for terminal, cancelled, or otherwise immutable sources. */
export class AppointmentNotReschedulableError extends Error {
  /** Create an invalid source-state error. */
  constructor(readonly appointment_id: string) {
    super(`appointment-not-reschedulable: ${appointment_id}`);
    this.name = "AppointmentNotReschedulableError";
  }
}

/** Domain error returned when one idempotency key is reused for another request. */
export class CalendarOperationConflictError extends Error {
  /** Create an operation-key conflict error. */
  constructor() {
    super("calendar-operation-conflict");
    this.name = "CalendarOperationConflictError";
  }
}

/** Safe failure for durable calendar persistence. */
export class CalendarStoreError extends Error {
  /** Create a sanitized persistence error. */
  constructor(reason = "calendar-store-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "CalendarStoreError";
  }
}

/** Safe failure for adapters that do not own an authoritative appointment store. */
export class RescheduleNotSupportedError extends Error {
  /** Create a fail-closed adapter capability error. */
  constructor() {
    super("atomic-reschedule-not-supported");
    this.name = "RescheduleNotSupportedError";
  }
}

/** App-facing calendar mutation contract. */
export interface CalendarPort {
  /** List available slots in a half-open UTC window. */
  list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]>;
  /** Hold one listed slot, optionally under a stable retry key. */
  hold_slot(
    slot_id: string,
    ttl_seconds: number,
    idempotency_key?: string,
  ): Promise<Pick<SlotHold, "hold_id" | "expires_at_iso">>;
  /** Confirm a new-booking hold under a stable operation key. */
  confirm_hold(hold_id: string, idempotency_key: string): Promise<void>;
  /** Atomically replace a source appointment with one live tenant-scoped hold. */
  reschedule_appointment(command: RescheduleAppointmentCommand): Promise<RescheduleAppointmentResult>;
  /** Release a held slot idempotently. */
  release_hold(hold_id: string): Promise<void>;
  /** Cancel a confirmed booking idempotently. */
  cancel_booking(booking_id: string): Promise<void>;
}
