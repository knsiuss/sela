import type { SlotHold, TimeSlot } from "../state.js";

/** Domain error returned when a slot cannot be held or confirmed. */
export class SlotUnavailableError extends Error {
  constructor(readonly slot_id: string) {
    super(`slot-unavailable: ${slot_id}`);
    this.name = "SlotUnavailableError";
  }
}

/** Domain error returned when a hold is absent, expired, or foreign-tenant. */
export class HoldExpiredError extends Error {
  constructor(readonly hold_id: string) {
    super(`hold-expired: ${hold_id}`);
    this.name = "HoldExpiredError";
  }
}

/**
 * App-facing calendar mutation contract.
 *
 * Implementations own persistence, tenant scope, and concurrency.
 */
export interface CalendarPort {
  list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]>;
  hold_slot(
    slot_id: string,
    ttl_seconds: number,
  ): Promise<Pick<SlotHold, "hold_id" | "expires_at_iso">>;
  confirm_hold(hold_id: string, idempotency_key: string): Promise<void>;
  release_hold(hold_id: string): Promise<void>;
  cancel_booking(booking_id: string): Promise<void>;
}
