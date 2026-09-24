import { createHash } from "node:crypto";
import {
  GoogleCalendarError,
  derive_event_id,
  type GoogleBusyPeriod,
  type GoogleCalendarClient,
  type GoogleCalendarEvent,
  type GoogleFreebusyResponse,
} from "@repo/mcp-gcal";
import type { SlotHold, TimeSlot } from "../state.js";
import { HoldExpiredError, SlotUnavailableError, type CalendarPort } from "./calendar.js";
import { clamp_hold_ttl_seconds } from "./hold_ttl.js";
import {
  build_working_slot_windows,
  type GoogleCalendarWorkingHoursConfig,
} from "./google_calendar_working_hours.js";

const DEFAULT_HOLD_TITLE = "Sela appointment hold";
const DEFAULT_BOOKING_TITLE = "Sela appointment";
const DEFAULT_HOLD_DESCRIPTION = "Sela appointment hold";
const MILLISECONDS_PER_SECOND = 1_000;
const MAX_HOLD_DESCRIPTION_LENGTH = 16_384;

type GoogleCalendarClientLike = Pick<
  GoogleCalendarClient,
  "calendar_id" | "freebusy_query" | "insert_event" | "patch_event" | "delete_event"
>;

/** Configuration for one tenant-scoped Google Calendar adapter. */
export interface GoogleCalendarAdapterOptions {
  tenant_id: string;
  client: GoogleCalendarClientLike;
  working_hours: GoogleCalendarWorkingHoursConfig;
  service_duration_minutes: number;
  slot_interval_minutes?: number;
  time_zone?: string;
  provider_id?: string;
  hold_title?: string;
  hold_description?: string;
  booking_title?: string;
  booking_description?: string;
  clock?: () => number;
}

interface StoredHold {
  hold_id: string;
  slot: TimeSlot;
  event_id: string;
  expires_at_ms: number;
  hold_description: string;
  status: "held" | "confirmed";
  idempotency_key?: string;
  insertion?: Promise<unknown>;
  confirmation?: Promise<void>;
}

/**
 * Maps the app CalendarPort to Google Calendar.
 *
 * Google Calendar freebusy contains busy intervals, not service-specific slots.
 * `list_slots` therefore divides configured working hours by service duration
 * and filters those approximations against freebusy. Google has no native
 * hold primitive: a hold is an ordinary event whose description contains an
 * expiry marker, then confirmation patches that event and release/cancel
 * deletes it. This convention is process-local metadata and is not a durable
 * distributed lock.
 */
export class GoogleCalendarAdapter implements CalendarPort {
  private readonly tenant_id: string;
  private readonly client: GoogleCalendarClientLike;
  private readonly working_hours: GoogleCalendarWorkingHoursConfig;
  private readonly service_duration_minutes: number;
  private readonly slot_interval_minutes: number | undefined;
  private readonly time_zone: string | undefined;
  private readonly provider_id: string | undefined;
  private readonly hold_title: string;
  private readonly hold_description: string;
  private readonly booking_title: string;
  private readonly booking_description: string | undefined;
  private readonly clock: () => number;
  private readonly slots_by_id = new Map<string, TimeSlot>();
  private readonly holds_by_id = new Map<string, StoredHold>();
  private readonly hold_id_by_slot = new Map<string, string>();
  private readonly hold_by_booking_id = new Map<string, StoredHold>();

  constructor(options: GoogleCalendarAdapterOptions) {
    this.tenant_id = require_non_empty(options.tenant_id, "tenant_id");
    this.client = require_client(options.client);
    this.working_hours = options.working_hours;
    this.service_duration_minutes = options.service_duration_minutes;
    this.slot_interval_minutes = options.slot_interval_minutes;
    this.time_zone = options.time_zone;
    this.provider_id = optional_non_empty(options.provider_id, "provider_id");
    this.hold_title = optional_non_empty(options.hold_title, "hold_title") ?? DEFAULT_HOLD_TITLE;
    this.hold_description = optional_non_empty(options.hold_description, "hold_description") ?? DEFAULT_HOLD_DESCRIPTION;
    this.booking_title = optional_non_empty(options.booking_title, "booking_title") ?? DEFAULT_BOOKING_TITLE;
    this.booking_description = optional_non_empty(options.booking_description, "booking_description");
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * List approximated service slots in a half-open availability window.
   *
   * @param window_start_iso - Inclusive RFC3339 window start.
   * @param window_end_iso - Exclusive RFC3339 window end.
   * @returns Slots that fit working hours and do not overlap freebusy blocks.
   * @throws TypeError for invalid timestamps.
   * @throws RangeError for an empty window or invalid working-hour config.
   * @throws SlotUnavailableError when Google cannot provide the calendar.
   */
  async list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]> {
    const slot_windows = build_working_slot_windows({
      window_start_iso,
      window_end_iso,
      working_hours: this.working_hours,
      service_duration_minutes: this.service_duration_minutes,
      slot_interval_minutes: this.slot_interval_minutes,
      time_zone: this.time_zone,
    });
    const response = await this.query_freebusy(window_start_iso, window_end_iso);
    const busy_intervals = read_busy_intervals(response, this.client.calendar_id, window_start_iso);
    const available_slots = slot_windows
      .filter(({ start_ms, end_ms }) => !overlaps_busy(start_ms, end_ms, busy_intervals))
      .map(({ start_ms, end_ms }) => this.to_time_slot(start_ms, end_ms));
    this.slots_by_id.clear();
    for (const slot of available_slots) this.slots_by_id.set(slot.id, slot);
    return available_slots.map((slot) => ({ ...slot }));
  }

  /**
   * Hold a listed slot by inserting a marked Google event.
   *
   * The optional hold idempotency key is used for the event id. When omitted,
   * the tenant and slot id form the stable fallback retry key, so a retry
   * reuses the same event id.
   * A concurrent or repeated active hold returns the existing hold.
   *
   * @param slot_id - Slot returned by the most recent list_slots call.
   * @param ttl_seconds - Requested application hold lifetime.
   * @returns The deterministic hold id and computed expiry.
   * @throws SlotUnavailableError for unknown, busy, or conflicting slots.
   */
  async hold_slot(
    slot_id: string,
    ttl_seconds: number,
    idempotency_key?: string,
  ): Promise<SlotHold> {
    const requested_slot_id = require_non_empty(slot_id, "slot_id");
    const requested_idempotency_key = optional_non_empty(idempotency_key, "idempotency_key");
    const ttl = clamp_hold_ttl_seconds(ttl_seconds);
    const existing_hold = this.find_hold_for_slot(requested_slot_id);
    if (existing_hold !== undefined) {
      if (existing_hold.status === "confirmed") throw new SlotUnavailableError(requested_slot_id);
      if (existing_hold.expires_at_ms > this.clock()) {
        return this.reuse_active_hold(existing_hold, requested_slot_id);
      }
      await this.remove_expired_hold(existing_hold);
    }
    const slot = this.slots_by_id.get(requested_slot_id);
    if (slot === undefined) throw new SlotUnavailableError(requested_slot_id);
    const stored_hold = this.create_stored_hold(slot, requested_slot_id, requested_idempotency_key, ttl);
    return this.insert_stored_hold(stored_hold, requested_slot_id);
  }

  /**
   * Confirm a hold by patching its event into the booking presentation.
   *
   * Confirmation is idempotent within this adapter instance: a retry with the
   * same key returns without a second patch. A missing, expired, or conflicting
   * Google event fails as HoldExpiredError.
   */
  async confirm_hold(hold_id: string, idempotency_key: string): Promise<void> {
    const requested_hold_id = require_non_empty(hold_id, "hold_id");
    const requested_key = require_non_empty(idempotency_key, "idempotency_key");
    const stored_hold = this.holds_by_id.get(requested_hold_id);
    if (stored_hold === undefined) throw new HoldExpiredError(requested_hold_id);
    if (stored_hold.status === "confirmed") {
      if (stored_hold.idempotency_key !== requested_key) throw new SlotUnavailableError(stored_hold.slot.id);
      return;
    }
    if (stored_hold.expires_at_ms <= this.clock()) {
      this.remove_hold(stored_hold);
      throw new HoldExpiredError(requested_hold_id);
    }

    if (stored_hold.confirmation !== undefined) {
      await stored_hold.confirmation;
      if (stored_hold.idempotency_key !== requested_key) throw new SlotUnavailableError(stored_hold.slot.id);
      return;
    }
    const confirmation = this.commit_confirmation(stored_hold, requested_key);
    stored_hold.confirmation = confirmation;
    try {
      await confirmation;
    } finally {
      stored_hold.confirmation = undefined;
    }
  }

  /** Delete a held event; releasing an unknown or already absent hold is safe. */
  async release_hold(hold_id: string): Promise<void> {
    const stored_hold = this.holds_by_id.get(require_non_empty(hold_id, "hold_id"));
    if (stored_hold === undefined || stored_hold.status === "confirmed") return;
    try {
      await this.client.delete_event({ event_id: stored_hold.event_id });
    } catch (error) {
      if (!is_upstream_status(error, 404) && !is_upstream_status(error, 409)) throw error;
    }
    this.remove_hold(stored_hold);
  }

  /** Delete a confirmed booking; an already absent Google event is a no-op. */
  async cancel_booking(booking_id: string): Promise<void> {
    const requested_booking_id = require_non_empty(booking_id, "booking_id");
    const stored_hold = this.hold_by_booking_id.get(requested_booking_id);
    if (stored_hold === undefined && requested_booking_id.length < 5) return;
    const event_id = stored_hold?.event_id ?? requested_booking_id;
    try {
      await this.client.delete_event({ event_id });
    } catch (error) {
      if (!is_upstream_status(error, 404) && !is_upstream_status(error, 409)) throw error;
    }
    if (stored_hold !== undefined) this.remove_hold(stored_hold);
  }

  private find_hold_for_slot(slot_id: string): StoredHold | undefined {
    const hold_id = this.hold_id_by_slot.get(slot_id);
    return hold_id === undefined ? undefined : this.holds_by_id.get(hold_id);
  }

  private async reuse_active_hold(stored_hold: StoredHold, slot_id: string): Promise<SlotHold> {
    if (stored_hold.insertion !== undefined) {
      try {
        await stored_hold.insertion;
      } catch (error) {
        throw translate_hold_write_error(error, slot_id);
      }
    }
    return this.to_slot_hold(stored_hold);
  }

  private async remove_expired_hold(stored_hold: StoredHold): Promise<void> {
    try {
      await this.client.delete_event({ event_id: stored_hold.event_id });
    } catch (error) {
      if (!is_upstream_status(error, 404) && !is_upstream_status(error, 409)) throw error;
    }
    this.remove_hold(stored_hold);
  }

  private create_stored_hold(
    slot: TimeSlot,
    slot_id: string,
    idempotency_key: string | undefined,
    ttl_seconds: number,
  ): StoredHold {
    const expires_at_ms = this.clock() + ttl_seconds * MILLISECONDS_PER_SECOND;
    const expires_at_iso = new Date(expires_at_ms).toISOString();
    const hold_id = createHash("sha256")
      .update(`${this.tenant_id}\u0000${idempotency_key ?? slot_id}`)
      .digest("hex")
      .slice(0, 32);
    const event_id = derive_event_id(
      this.client.calendar_id,
      `${this.tenant_id}:${idempotency_key ?? `hold:${slot_id}`}`,
    );
    const hold_description = append_hold_marker(
      this.hold_description,
      `sela_hold_${hold_id} expires_at=${expires_at_iso}`,
    );
    const stored_hold: StoredHold = {
      hold_id,
      slot,
      event_id,
      expires_at_ms,
      hold_description,
      status: "held",
    };
    this.holds_by_id.set(hold_id, stored_hold);
    this.hold_id_by_slot.set(slot_id, hold_id);
    this.hold_by_booking_id.set(event_id, stored_hold);
    this.hold_by_booking_id.set(slot.id, stored_hold);
    this.hold_by_booking_id.set(hold_id, stored_hold);
    return stored_hold;
  }

  private async insert_stored_hold(stored_hold: StoredHold, slot_id: string): Promise<SlotHold> {
    try {
      const insertion = this.client.insert_event({
        event: {
          id: stored_hold.event_id,
          summary: this.hold_title,
          description: stored_hold.hold_description,
          start: { dateTime: stored_hold.slot.start_iso },
          end: { dateTime: stored_hold.slot.end_iso },
        },
      });
      stored_hold.insertion = insertion;
      await insertion;
    } catch (error) {
      this.remove_hold(stored_hold);
      throw translate_hold_write_error(error, slot_id);
    } finally {
      stored_hold.insertion = undefined;
    }
    return this.to_slot_hold(stored_hold);
  }

  private async commit_confirmation(stored_hold: StoredHold, idempotency_key: string): Promise<void> {
    const event: GoogleCalendarEvent = {
      summary: this.booking_title,
      description: this.booking_description ?? strip_hold_marker(stored_hold.hold_description),
      start: { dateTime: stored_hold.slot.start_iso },
      end: { dateTime: stored_hold.slot.end_iso },
      extendedProperties: { private: { sela_idempotency_key: idempotency_key } },
    };
    try {
      await this.client.patch_event({ event_id: stored_hold.event_id, event });
    } catch (error) {
      if (is_upstream_status(error, 404) || is_upstream_status(error, 409)) {
        this.remove_hold(stored_hold);
        throw new HoldExpiredError(stored_hold.hold_id);
      }
      throw error;
    }
    stored_hold.status = "confirmed";
    stored_hold.idempotency_key = idempotency_key;
    this.hold_by_booking_id.set(stored_hold.event_id, stored_hold);
    this.hold_by_booking_id.set(stored_hold.slot.id, stored_hold);
  }

  private async query_freebusy(
    window_start_iso: string,
    window_end_iso: string,
  ): Promise<GoogleFreebusyResponse> {
    try {
      return await this.client.freebusy_query({
        time_min: window_start_iso,
        time_max: window_end_iso,
        calendar_ids: [this.client.calendar_id],
        ...(this.time_zone === undefined ? {} : { time_zone: this.time_zone }),
      });
    } catch (error) {
      if (is_upstream_status(error, 404) || is_upstream_status(error, 409)) {
        throw new SlotUnavailableError(window_start_iso);
      }
      throw error;
    }
  }

  private to_time_slot(start_ms: number, end_ms: number): TimeSlot {
    const start_iso = new Date(start_ms).toISOString();
    const end_iso = new Date(end_ms).toISOString();
    const slot_id = `gcal_${createHash("sha256")
      .update(`${this.tenant_id}\u0000${start_iso}\u0000${end_iso}`)
      .digest("hex")
      .slice(0, 32)}`;
    return {
      id: slot_id,
      start_iso,
      end_iso,
      ...(this.provider_id === undefined ? {} : { staff: this.provider_id }),
    };
  }

  private to_slot_hold(stored_hold: StoredHold): SlotHold {
    return {
      hold_id: stored_hold.hold_id,
      slot_id: stored_hold.slot.id,
      expires_at_iso: new Date(stored_hold.expires_at_ms).toISOString(),
    };
  }

  private remove_hold(stored_hold: StoredHold): void {
    this.holds_by_id.delete(stored_hold.hold_id);
    if (this.hold_id_by_slot.get(stored_hold.slot.id) === stored_hold.hold_id) {
      this.hold_id_by_slot.delete(stored_hold.slot.id);
    }
    this.hold_by_booking_id.delete(stored_hold.event_id);
    this.hold_by_booking_id.delete(stored_hold.slot.id);
    this.hold_by_booking_id.delete(stored_hold.hold_id);
  }
}

function read_busy_intervals(
  response: GoogleFreebusyResponse,
  calendar_id: string,
  fallback_id: string,
): GoogleBusyPeriod[] {
  const calendar = response.calendars?.[calendar_id] ?? Object.values(response.calendars ?? {})[0];
  if (calendar === undefined || (calendar.errors?.length ?? 0) > 0 || !Array.isArray(calendar.busy)) {
    throw new SlotUnavailableError(fallback_id);
  }
  return calendar.busy.map((period) => {
    if (typeof period.start !== "string" || typeof period.end !== "string") {
      throw new SlotUnavailableError(fallback_id);
    }
    return period;
  });
}

function overlaps_busy(start_ms: number, end_ms: number, busy_intervals: readonly GoogleBusyPeriod[]): boolean {
  return busy_intervals.some((busy) => {
    const busy_start_ms = Date.parse(busy.start);
    const busy_end_ms = Date.parse(busy.end);
    if (!Number.isFinite(busy_start_ms) || !Number.isFinite(busy_end_ms) || busy_end_ms <= busy_start_ms) {
      return true;
    }
    return start_ms < busy_end_ms && busy_start_ms < end_ms;
  });
}

function append_hold_marker(base_description: string, marker: string): string {
  const description = `${base_description}\n\n${marker}`;
  if (description.length > MAX_HOLD_DESCRIPTION_LENGTH) {
    throw new RangeError("hold description exceeds the supported length");
  }
  return description;
}

function strip_hold_marker(description: string): string {
  return description.replace(/\n\nsela_hold_[a-f0-9]+ expires_at=[^\n]+/g, "").trim();
}

function translate_hold_write_error(error: unknown, slot_id: string): Error {
  if (is_upstream_status(error, 404) || is_upstream_status(error, 409)) {
    return new SlotUnavailableError(slot_id);
  }
  return error instanceof Error ? error : new Error("calendar-hold-write-failed");
}

function is_upstream_status(error: unknown, status: number): boolean {
  if (error instanceof GoogleCalendarError) return error.status === status;
  if (typeof error !== "object" || error === null) return false;
  return (error as { status?: unknown }).status === status;
}

function require_client(client: GoogleCalendarClientLike): GoogleCalendarClientLike {
  if (client === undefined || typeof client.freebusy_query !== "function") {
    throw new TypeError("client must be a GoogleCalendarClient");
  }
  return client;
}

function require_non_empty(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${field_name} must not be empty`);
  return value;
}

function optional_non_empty(value: string | undefined, field_name: string): string | undefined {
  if (value === undefined) return undefined;
  return require_non_empty(value, field_name);
}

