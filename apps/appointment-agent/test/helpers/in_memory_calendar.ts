import { randomUUID } from "node:crypto";
import {
  HoldExpiredError,
  SlotUnavailableError,
  type CalendarPort,
} from "../../src/tools/calendar.js";
import type { SlotHold, TimeSlot } from "../../src/state.js";

interface StoredHold {
  slot_id: string;
  expires_at_ms: number;
}

/** Small deterministic CalendarPort used only when a test needs a calendar stub. */
export class InMemoryCalendar implements CalendarPort {
  private readonly holds = new Map<string, StoredHold>();
  private readonly confirmed = new Set<string>();

  /**
   * Create a test calendar backed by a fixed slot catalog.
   *
   * Args:
   *   slots: Available slots for the test.
   */
  constructor(private readonly slots: TimeSlot[]) {}

  /** Return unheld and unconfirmed slots from the fixed test catalog. */
  async list_slots(): Promise<TimeSlot[]> {
    const now_ms = Date.now();
    const held_slot_ids = new Set(
      [...this.holds.values()]
        .filter((hold) => hold.expires_at_ms > now_ms)
        .map((hold) => hold.slot_id),
    );
    return this.slots
      .filter((slot) => !held_slot_ids.has(slot.id) && !this.confirmed.has(slot.id))
      .map((slot) => ({ ...slot }));
  }

  /** Create a short-lived test hold for an available slot. */
  async hold_slot(slot_id: string, ttl_seconds: number): Promise<SlotHold> {
    const available = await this.list_slots();
    if (!available.some((slot) => slot.id === slot_id)) {
      throw new SlotUnavailableError(slot_id);
    }
    const hold_id = `hold_${randomUUID()}`;
    const expires_at_ms = Date.now() + ttl_seconds * 1000;
    this.holds.set(hold_id, { slot_id, expires_at_ms });
    return {
      hold_id,
      slot_id,
      expires_at_iso: new Date(expires_at_ms).toISOString(),
    };
  }

  /** Confirm a live test hold; unknown or expired ids fail loudly. */
  async confirm_hold(hold_id: string, _idempotency_key: string): Promise<void> {
    const hold = this.holds.get(hold_id);
    if (!hold || hold.expires_at_ms <= Date.now()) {
      throw new HoldExpiredError(hold_id);
    }
    this.confirmed.add(hold.slot_id);
    this.holds.delete(hold_id);
  }

  /** Release a test hold; unknown ids are idempotent. */
  async release_hold(hold_id: string): Promise<void> {
    this.holds.delete(hold_id);
  }

  /** Remove a test booking from the confirmed set. */
  async cancel_booking(booking_id: string): Promise<void> {
    this.confirmed.delete(booking_id);
  }
}
