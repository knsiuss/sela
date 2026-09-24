import {
  HoldExpiredError as SlotEngineHoldExpiredError,
  SlotService,
  SlotUnavailableError as SlotEngineSlotUnavailableError,
  type Appointment,
  type Hold,
} from "@repo/slot-engine";
import type { SlotHold, TimeSlot } from "../state.js";
import {
  HoldExpiredError,
  SlotUnavailableError,
  type CalendarPort,
} from "./calendar.js";
import { clamp_hold_ttl_seconds, HOLD_TTL_SECONDS } from "./hold_ttl.js";

/** Provider identifier used for legacy slots without staff or resource metadata. */
export const DEFAULT_PROVIDER_ID = "default-provider";

interface MappedSlot {
  slot: TimeSlot;
  provider_id: string;
}

/** Construction inputs for one tenant-scoped calendar adapter. */
export interface SlotServiceAdapterOptions {
  tenant_id: string;
  slots: readonly TimeSlot[];
  service?: SlotService;
  default_provider_id?: string;
  clock?: () => number;
}

/**
 * Adapt the app's CalendarPort contract to the shared SlotService.
 *
 * The current app models a provider as `TimeSlot.staff`. When that field is
 * absent, `resource` is treated as the provider id for compatibility with
 * resource-oriented calendars. Legacy slots without either field use the
 * explicit `DEFAULT_PROVIDER_ID`; a future calendar source should provide a
 * stable provider id rather than a display name.
 *
 * Args:
 *   options: Tenant scope, slot catalog, and optional injected service/clock.
 *
 * Returns:
 *   A tenant-scoped CalendarPort implementation.
 */
export class SlotServiceAdapter implements CalendarPort {
  private readonly tenant_id: string;
  private readonly service: SlotService;
  private readonly clock: () => number;
  private readonly slots_by_id: Map<string, MappedSlot>;
  private readonly hold_slot_by_id = new Map<string, string>();
  private readonly hold_by_idempotency_key = new Map<string, SlotHold>();
  private readonly appointment_id_by_booking_id = new Map<string, string>();

  constructor(options: SlotServiceAdapterOptions) {
    this.tenant_id = require_non_empty(options.tenant_id, "tenant_id");
    this.clock = options.clock ?? Date.now;
    this.service = options.service ?? new SlotService({ clock: this.clock });
    this.slots_by_id = map_slots(options.slots, options.default_provider_id ?? DEFAULT_PROVIDER_ID);
  }

  /**
   * List free catalog slots that overlap the requested half-open window.
   *
   * The catalog is local to the adapter; SlotService remains the authority
   * for whether each mapped provider/window is currently held or confirmed.
   *
   * Args:
   *   window_start_iso: Inclusive query-window start.
   *   window_end_iso: Exclusive query-window end.
   *
   * Returns:
   *   Copies of currently available TimeSlot values in catalog order.
   *
   * Raises:
   *   TypeError: If a window or catalog timestamp is invalid.
   *   RangeError: If the query window is empty.
   */
  async list_slots(window_start_iso: string, window_end_iso: string): Promise<TimeSlot[]> {
    const window_start_ms = parse_timestamp(window_start_iso, "window_start_iso");
    const window_end_ms = parse_timestamp(window_end_iso, "window_end_iso");
    if (window_end_ms <= window_start_ms) {
      throw new RangeError("availability window must have positive duration");
    }

    return [...this.slots_by_id.values()]
      .filter(({ slot }) => {
        const slot_start_ms = parse_timestamp(slot.start_iso, "slot.start_iso");
        const slot_end_ms = parse_timestamp(slot.end_iso, "slot.end_iso");
        return slot_start_ms < window_end_ms && window_start_ms < slot_end_ms;
      })
      .filter((mapped_slot) =>
        this.service.check_availability({
          tenant_id: this.tenant_id,
          ...this.to_package_window(mapped_slot),
        }),
      )
      .map(({ slot }) => ({ ...slot }));
  }

  /**
   * Hold one catalog slot through the shared tenant-scoped service.
   *
   * Args:
   *   slot_id: App slot identifier.
   *   ttl_seconds: Requested lifetime; capped at the package maximum.
   *   idempotency_key: Optional stable retry key. The process-local adapter
   *     returns its original live hold for the same key and slot.
   *
   * Returns:
   *   The app hold shape with the package-computed ISO expiry.
   *
   * Raises:
   *   SlotUnavailableError: If the slot is unknown, held, or confirmed.
   */
  async hold_slot(
    slot_id: string,
    ttl_seconds: number = HOLD_TTL_SECONDS,
    idempotency_key?: string,
  ): Promise<SlotHold> {
    const mapped_slot = this.require_slot(slot_id);
    const replay = this.replayed_hold(slot_id, idempotency_key);
    if (replay !== undefined) return replay;
    const requested_ttl_seconds = clamp_hold_ttl_seconds(ttl_seconds);
    let hold: Hold;
    try {
      hold = this.service.hold_slot({
        tenant_id: this.tenant_id,
        ...this.to_package_window(mapped_slot),
        ttl_seconds: requested_ttl_seconds,
      });
    } catch (error) {
      throw this.translate_error(error, slot_id, slot_id);
    }

    for (const [mapped_hold_id, mapped_slot_id] of this.hold_slot_by_id) {
      if (mapped_slot_id === slot_id) this.hold_slot_by_id.delete(mapped_hold_id);
    }
    this.hold_slot_by_id.set(hold.hold_id, slot_id);
    const app_hold = this.to_app_hold(slot_id, hold);
    if (idempotency_key !== undefined) this.hold_by_idempotency_key.set(idempotency_key, app_hold);
    return { ...app_hold };
  }

  /**
   * Confirm a hold using the adapter tenant and the caller idempotency key.
   *
   * Args:
   *   hold_id: Package hold identifier.
   *   idempotency_key: Stable key for safe write retries.
   *
   * Returns:
   *   Nothing; the CalendarPort intentionally keeps the existing void contract.
   *
   * Raises:
   *   HoldExpiredError: If the hold is missing, expired, or foreign-tenant.
   *   SlotUnavailableError: If a conflicting confirmed window blocks the write.
   */
  async confirm_hold(hold_id: string, idempotency_key: string): Promise<void> {
    let appointment: Appointment;
    try {
      appointment = this.service.confirm_hold({
        hold_id,
        tenant_id: this.tenant_id,
        idempotency_key,
      });
    } catch (error) {
      const slot_id = this.hold_slot_by_id.get(hold_id) ?? hold_id;
      const translated_error = this.translate_error(error, slot_id, hold_id);
      if (translated_error instanceof HoldExpiredError) this.forget_hold(hold_id);
      throw translated_error;
    }

    const slot_id = this.hold_slot_by_id.get(hold_id);
    if (slot_id !== undefined) this.appointment_id_by_booking_id.set(slot_id, appointment.id);
    this.forget_hold(hold_id);
  }

  /**
   * Release a hold without changing confirmed appointment state.
   *
   * Args:
   *   hold_id: Package hold identifier.
   *
   * Returns:
   *   Nothing; releasing an unknown id is idempotent.
   */
  async release_hold(hold_id: string): Promise<void> {
    this.service.release_hold({ hold_id, tenant_id: this.tenant_id });
    this.forget_hold(hold_id);
  }

  /**
   * Cancel a confirmed booking represented by an app slot or package id.
   *
   * Args:
   *   booking_id: App slot id normally; a package appointment id is also accepted.
   *
   * Returns:
   *   Nothing; unknown booking ids are treated as already absent.
   */
  async cancel_booking(booking_id: string): Promise<void> {
    const appointment_id = this.appointment_id_by_booking_id.get(booking_id) ?? booking_id;
    this.service.cancel_booking({ appointment_id, tenant_id: this.tenant_id });
    this.appointment_id_by_booking_id.delete(booking_id);
  }

  private replayed_hold(slot_id: string, idempotency_key: string | undefined): SlotHold | undefined {
    if (idempotency_key === undefined) return undefined;
    require_idempotency_key(idempotency_key);
    const cached = this.hold_by_idempotency_key.get(idempotency_key);
    if (cached === undefined) return undefined;
    if (cached.slot_id !== slot_id) throw new SlotUnavailableError(slot_id);
    if (Date.parse(cached.expires_at_iso) <= this.clock()) {
      this.forget_hold(cached.hold_id);
      return undefined;
    }
    return { ...cached };
  }

  private forget_hold(hold_id: string): void {
    this.hold_slot_by_id.delete(hold_id);
    for (const [key, hold] of this.hold_by_idempotency_key) {
      if (hold.hold_id === hold_id) this.hold_by_idempotency_key.delete(key);
    }
  }

  private to_package_window(mapped_slot: MappedSlot): {
    provider_id: string;
    start_time: string;
    end_time: string;
  } {
    return {
      provider_id: mapped_slot.provider_id,
      start_time: mapped_slot.slot.start_iso,
      end_time: mapped_slot.slot.end_iso,
    };
  }

  private to_app_hold(slot_id: string, hold: Hold): SlotHold {
    return {
      hold_id: hold.hold_id,
      slot_id,
      expires_at_iso: hold.expires_at,
    };
  }

  private require_slot(slot_id: string): MappedSlot {
    const mapped_slot = this.slots_by_id.get(slot_id);
    if (mapped_slot === undefined) throw new SlotUnavailableError(slot_id);
    return mapped_slot;
  }

  private translate_error(error: unknown, slot_id: string, hold_id: string): Error {
    if (error instanceof SlotEngineSlotUnavailableError) return new SlotUnavailableError(slot_id);
    if (error instanceof SlotEngineHoldExpiredError) return new HoldExpiredError(hold_id);
    return error instanceof Error ? error : new Error("slot-service-operation-failed");
  }
}

function map_slots(slots: readonly TimeSlot[], default_provider_id: string): Map<string, MappedSlot> {
  const mapped_slots = new Map<string, MappedSlot>();
  for (const slot of slots) {
    const slot_id = require_non_empty(slot.id, "slot.id");
    if (mapped_slots.has(slot_id)) throw new TypeError(`duplicate slot id: ${slot_id}`);
    const provider_id = slot.staff ?? slot.resource ?? default_provider_id;
    const start_ms = parse_timestamp(slot.start_iso, "slot.start_iso");
    const end_ms = parse_timestamp(slot.end_iso, "slot.end_iso");
    if (end_ms <= start_ms) throw new RangeError(`slot ${slot_id} must have positive duration`);
    mapped_slots.set(slot_id, {
      slot: { ...slot },
      provider_id: require_non_empty(provider_id, "provider_id"),
    });
  }
  return mapped_slots;
}

function require_non_empty(value: string, field_name: string): string {
  if (value.trim() === "") throw new TypeError(`${field_name} must not be empty`);
  return value;
}

function require_idempotency_key(value: string): string {
  if (value.trim() === "" || value.length > 256) {
    throw new TypeError("idempotency_key must contain between 1 and 256 characters");
  }
  return value;
}

function parse_timestamp(value: string, field_name: string): number {
  const timestamp_ms = Date.parse(value);
  if (!Number.isFinite(timestamp_ms)) {
    throw new TypeError(`${field_name} must be a valid ISO timestamp`);
  }
  return timestamp_ms;
}
