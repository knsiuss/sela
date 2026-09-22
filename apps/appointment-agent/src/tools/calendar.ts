import type { TimeSlot } from "../state.js";

export class SlotUnavailableError extends Error {
  constructor(readonly slot_id: string) {
    super(`slot-unavailable: ${slot_id}`);
    this.name = "SlotUnavailableError";
  }
}

export class HoldExpiredError extends Error {
  constructor(readonly hold_id: string) {
    super(`hold-expired: ${hold_id}`);
    this.name = "HoldExpiredError";
  }
}

export interface CalendarPort {
  list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]>;
  hold_slot(slot_id: string, ttl_seconds: number): Promise<{ hold_id: string; expires_at_iso: string }>;
  confirm_hold(hold_id: string, idempotency_key: string): Promise<void>;
  release_hold(hold_id: string): Promise<void>;
  cancel_booking(booking_id: string): Promise<void>;
}

interface StoredHold {
  slot_id: string;
  expires_at_ms: number;
}

/** In-memory CalendarPort for tests and local dev. Replace with the Google Calendar adapter. */
export class InMemoryCalendar implements CalendarPort {
  private holds = new Map<string, StoredHold>();
  private confirmed = new Set<string>();

  constructor(private slots: TimeSlot[]) {}

  async list_slots(): Promise<TimeSlot[]> {
    const now = Date.now();
    const held_slot_ids = new Set(
      [...this.holds.values()]
        .filter((hold) => hold.expires_at_ms > now)
        .map((hold) => hold.slot_id),
    );
    return this.slots.filter(
      (slot) => !held_slot_ids.has(slot.id) && !this.confirmed.has(slot.id),
    );
  }

  async hold_slot(slot_id: string, ttl_seconds: number): Promise<{ hold_id: string; expires_at_iso: string }> {
    const available = await this.list_slots();
    if (!available.some((slot) => slot.id === slot_id)) {
      throw new SlotUnavailableError(slot_id);
    }
    const hold_id = `hold_${Date.now()}`;
    const expires_at_ms = Date.now() + ttl_seconds * 1000;
    this.holds.set(hold_id, { slot_id, expires_at_ms });
    return { hold_id, expires_at_iso: new Date(expires_at_ms).toISOString() };
  }

  async confirm_hold(hold_id: string, _idempotency_key: string): Promise<void> {
    const hold = this.holds.get(hold_id);
    if (!hold || hold.expires_at_ms <= Date.now()) {
      throw new HoldExpiredError(hold_id);
    }
    this.confirmed.add(hold.slot_id);
    this.holds.delete(hold_id);
  }

  async release_hold(hold_id: string): Promise<void> {
    this.holds.delete(hold_id);
  }

  async cancel_booking(booking_id: string): Promise<void> {
    this.confirmed.delete(booking_id);
  }
}
