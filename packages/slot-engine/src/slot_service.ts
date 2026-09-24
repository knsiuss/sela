/** Domain service for slot availability, holds, and confirmed writes.
 *
 * Booking order follows the proven pattern: lock the tenant-scoped slot
 * key, re-run availability for the exact window, write, then release.
 * Writes happen only through confirm_hold after an explicit customer
 * confirmation; nothing here auto-confirms or touches OPERATOR handoff.
 *
 * Production backstop (Postgres, migrations/0001_init.sql): the
 * UNIQUE(tenant_id, idempotency_key) constraint makes retry duplicates
 * structurally impossible, and the no_overlapping_slots exclusion
 * constraint rejects overlapping held/confirmed rows. This service checks
 * first for friendly domain errors; the constraints are the last defense.
 */

import { randomUUID } from "node:crypto";
import { HoldStore, type ReleaseHoldParams } from "./hold_store.js";
import {
  appointment_schema,
  availability_query_schema,
  build_slot_key,
  confirm_request_schema,
  hold_request_schema,
  reschedule_request_schema,
  type Appointment,
  type AvailabilityQuery,
  type ConfirmRequest,
  type Hold,
  type HoldRequest,
  type RescheduleRequest,
} from "./slot_types.js";

/** Thrown when the requested window is already held or confirmed. */
export class SlotUnavailableError extends Error {
  constructor(readonly slot_key: string) {
    super(`slot-unavailable: ${slot_key}`);
    this.name = "SlotUnavailableError";
  }
}

/** Thrown when a hold is missing, expired, or owned by another tenant. */
export class HoldExpiredError extends Error {
  constructor(readonly hold_id: string) {
    super(`hold-expired: ${hold_id}`);
    this.name = "HoldExpiredError";
  }
}

/** Thrown when an appointment id is unknown within the tenant. */
export class AppointmentNotFoundError extends Error {
  constructor(readonly appointment_id: string) {
    super(`appointment-not-found: ${appointment_id}`);
    this.name = "AppointmentNotFoundError";
  }
}

export interface SlotServiceOptions {
  hold_store?: HoldStore;
  clock?: () => number;
}

export interface GetAppointmentParams {
  appointment_id: string;
  tenant_id: string;
}

/** Tenant-scoped hold release request. */
export interface ReleaseHoldRequest extends ReleaseHoldParams {
  tenant_id: string;
}

interface OverlapWindow {
  start_time: string;
  end_time: string;
}

function log_event(event: string, details: Record<string, string>): void {
  console.info(JSON.stringify({ component: "slot-service", event, ...details }));
}

/**
 * Decide whether two half-open windows overlap.
 *
 * Half-open [start, end) matches the tstzrange(start, end, '[)') used by
 * the Postgres exclusion constraint, so back-to-back slots do not collide.
 */
function windows_overlap(first: OverlapWindow, second: OverlapWindow): boolean {
  return (
    Date.parse(first.start_time) < Date.parse(second.end_time) &&
    Date.parse(second.start_time) < Date.parse(first.end_time)
  );
}

/**
 * Coordinate slot holds and confirmed appointment writes per tenant.
 *
 * Availability, hold, and confirm share one overlap check, so the Booker
 * view and the writer can never disagree about what is free.
 */
export class SlotService {
  private readonly hold_store: HoldStore;
  private readonly clock: () => number;
  private readonly appointments = new Map<string, Appointment>();
  private readonly appointment_id_by_idempotency_key = new Map<string, string>();

  /**
   * Create a slot service.
   *
   * Args:
   *   options: Optional shared HoldStore and clock. The clock defaults to
   *     Date.now; tests inject a manual clock for deterministic TTL.
   */
  constructor(options: SlotServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.hold_store = options.hold_store ?? new HoldStore(this.clock);
  }

  /**
   * Check whether an exact window is free for a provider.
   *
   * A window is free when no live hold covers its slot key and no
   * held/confirmed appointment overlaps it.
   *
   * Args:
   *   params: Tenant, provider, and exact window to check.
   *
   * Returns:
   *   True when the window can be held.
   */
  check_availability(params: AvailabilityQuery): boolean {
    const query = availability_query_schema.parse(params);
    if (this.hold_store.is_held({ slot_key: build_slot_key(query) })) {
      return false;
    }
    return !this.has_blocking_appointment(query, undefined);
  }

  /**
   * Hold an exact window behind a TTL lease.
   *
   * Args:
   *   params: Tenant, provider, window, and optional requested TTL.
   *
   * Returns:
   *   The new hold with its server-computed expiry.
   *
   * Raises:
   *   SlotUnavailableError: If the window is already held or confirmed.
   */
  hold_slot(params: HoldRequest): Hold {
    const request = hold_request_schema.parse(params);
    const slot_key = build_slot_key(request);
    if (this.has_blocking_appointment(request, undefined)) {
      throw new SlotUnavailableError(slot_key);
    }
    const hold = this.hold_store.acquire(request);
    if (!hold) {
      throw new SlotUnavailableError(slot_key);
    }
    return hold;
  }

  /**
   * Confirm a live hold into an appointment (explicit customer confirm).
   *
   * Retries with the same tenant plus idempotency key return the original
   * appointment instead of writing a duplicate.
   *
   * Args:
   *   params: Hold id, tenant id, and idempotency key for the write.
   *
   * Returns:
   *   The confirmed appointment, new or replayed.
   *
   * Raises:
   *   HoldExpiredError: If the hold is missing, expired, or foreign-tenant.
   *   SlotUnavailableError: If the window was confirmed by a rival write.
   */
  confirm_hold(params: ConfirmRequest): Appointment {
    const request = confirm_request_schema.parse(params);
    const replayed = this.find_by_idempotency_key(request);
    if (replayed) {
      log_event("confirm_idempotent_replay", { appointment_id: replayed.id });
      return { ...replayed };
    }
    const hold = this.require_live_hold(request.hold_id, request.tenant_id);
    const slot_key = build_slot_key({
      tenant_id: hold.tenant_id,
      provider_id: hold.provider_id,
      start_time: hold.start_time,
    });
    if (this.has_blocking_appointment(hold, undefined)) {
      throw new SlotUnavailableError(slot_key);
    }
    const appointment = this.write_confirmed_appointment(hold, request.idempotency_key);
    this.hold_store.release({ hold_id: hold.hold_id });
    return { ...appointment };
  }

  /**
   * Release a hold without confirming it.
   *
   * Args:
   *   params: Hold id and owning tenant id.
   *
   * Returns:
   *   True when a hold was removed, false when it was already absent.
   */
  release_hold(params: ReleaseHoldRequest): boolean {
    const hold = this.hold_store.find_hold({ hold_id: params.hold_id });
    if (!hold || hold.tenant_id !== params.tenant_id) return false;
    return this.hold_store.release({ hold_id: params.hold_id });
  }

  /**
   * Cancel a confirmed appointment within its tenant.
   *
   * Unknown or foreign-tenant ids are treated as already absent so a
   * duplicate cancellation is safe and does not disclose another tenant's
   * appointment state.
   *
   * Args:
   *   params: Appointment id and tenant id.
   *
   * Returns:
   *   Nothing; the appointment is left unchanged when it is not found.
   */
  cancel_booking(params: GetAppointmentParams): void {
    const stored = this.appointments.get(params.appointment_id);
    if (!stored || stored.tenant_id !== params.tenant_id || stored.status === "cancelled") return;

    const cancelled = appointment_schema.parse({
      ...stored,
      status: "cancelled",
      updated_at: new Date(this.clock()).toISOString(),
    });
    this.appointments.set(cancelled.id, cancelled);
    log_event("appointment_cancelled", { appointment_id: cancelled.id });
  }

  /**
   * Move an existing appointment to a new window.
   *
   * Args:
   *   params: Appointment id, tenant id, and the new window.
   *
   * Returns:
   *   The updated appointment.
   *
   * Raises:
   *   AppointmentNotFoundError: If the id is unknown within the tenant.
   *   SlotUnavailableError: If the new window is already taken.
   */
  reschedule(params: RescheduleRequest): Appointment {
    const request = reschedule_request_schema.parse(params);
    const stored = this.appointments.get(request.appointment_id);
    if (!stored || stored.tenant_id !== request.tenant_id) {
      throw new AppointmentNotFoundError(request.appointment_id);
    }
    const candidate = { start_time: request.new_start_time, end_time: request.new_end_time };
    if (this.has_blocking_appointment({ ...stored, ...candidate }, stored.id)) {
      throw new SlotUnavailableError(build_slot_key({ ...stored, start_time: candidate.start_time }));
    }
    const updated: Appointment = {
      ...stored,
      start_time: request.new_start_time,
      end_time: request.new_end_time,
      updated_at: new Date(this.clock()).toISOString(),
    };
    this.appointments.set(updated.id, appointment_schema.parse(updated));
    log_event("appointment_rescheduled", { appointment_id: updated.id });
    return { ...updated };
  }

  /**
   * Look up an appointment within a tenant.
   *
   * Args:
   *   params: Appointment id and tenant id.
   *
   * Returns:
   *   A copy of the appointment, or undefined when unknown or foreign.
   */
  get_appointment(params: GetAppointmentParams): Appointment | undefined {
    const stored = this.appointments.get(params.appointment_id);
    if (!stored || stored.tenant_id !== params.tenant_id) {
      return undefined;
    }
    return { ...stored };
  }

  private find_by_idempotency_key(request: ConfirmRequest): Appointment | undefined {
    const id = this.appointment_id_by_idempotency_key.get(`${request.tenant_id}:${request.idempotency_key}`);
    const stored = id === undefined ? undefined : this.appointments.get(id);
    return stored === undefined ? undefined : { ...stored };
  }

  private require_live_hold(hold_id: string, tenant_id: string): Hold {
    const hold = this.hold_store.find_hold({ hold_id });
    if (!hold || hold.tenant_id !== tenant_id) {
      throw new HoldExpiredError(hold_id);
    }
    return hold;
  }

  private write_confirmed_appointment(hold: Hold, idempotency_key: string): Appointment {
    const now_iso = new Date(this.clock()).toISOString();
    const appointment = appointment_schema.parse({
      id: randomUUID(),
      tenant_id: hold.tenant_id,
      provider_id: hold.provider_id,
      start_time: hold.start_time,
      end_time: hold.end_time,
      status: "confirmed",
      idempotency_key,
      created_at: now_iso,
      updated_at: now_iso,
    });
    this.appointments.set(appointment.id, appointment);
    this.appointment_id_by_idempotency_key.set(`${appointment.tenant_id}:${idempotency_key}`, appointment.id);
    log_event("appointment_confirmed", { appointment_id: appointment.id, hold_id: hold.hold_id });
    return appointment;
  }

  private has_blocking_appointment(window: OverlapWindow, ignore_id: string | undefined): boolean {
    const scope = window as OverlapWindow & { tenant_id: string; provider_id: string };
    for (const stored of this.appointments.values()) {
      if (stored.id === ignore_id || stored.status === "cancelled") {
        continue;
      }
      if (stored.tenant_id !== scope.tenant_id || stored.provider_id !== scope.provider_id) {
        continue;
      }
      if (windows_overlap(window, stored)) {
        return true;
      }
    }
    return false;
  }
}
