/** Strict row parsing and scalar validation for the durable calendar adapter. */

import type { SqlQueryResult } from "../persistence/sql_client.js";
import type { TimeSlot } from "../state.js";
import { CalendarStoreError, type RescheduleAppointmentCommand } from "../tools/calendar.js";
import {
  validate_appointment_id,
  validate_operation_key,
  validate_reschedule_command,
  validate_resource_id,
  type DurableSlot,
  type ValidatedRescheduleCommand,
} from "./calendar_models.js";

/** One active appointment window returned by the availability query. */
export interface CalendarBlocker {
  resource_id: string | null;
  starts_at_ms: number;
  ends_at_ms: number;
}

/** One locked v2 hold joined to its owned held appointment. */
export interface CalendarHoldRow {
  hold_id: string;
  slot_id: string;
  resource_id: string;
  starts_at_ms: number;
  ends_at_ms: number;
  expires_at_ms: number;
  is_live: boolean;
  hold_status: string;
  held_appointment_id: string;
  held_status: string;
  held_resource_id: string;
  held_starts_at_ms: number;
  held_ends_at_ms: number;
}

/** Validate and copy the bounded runtime slot catalog. */
export function map_calendar_slots(slots: readonly TimeSlot[]): Map<string, DurableSlot> {
  const mapped = new Map<string, DurableSlot>();
  for (const slot of slots) {
    try {
      const id = safe_calendar_text(slot.id, "slot_id");
      if (mapped.has(id)) throw new CalendarStoreError("calendar-slot-duplicate");
      if (timestamp(slot.end_iso, "slot.end_iso") <= timestamp(slot.start_iso, "slot.start_iso")) {
        throw new CalendarStoreError("calendar-slot-window-invalid");
      }
      mapped.set(id, { ...slot, resource_id: validate_resource_id(slot.resource_id ?? "") });
    } catch (error) {
      if (error instanceof CalendarStoreError) throw error;
      throw new CalendarStoreError("calendar-slot-invalid", error);
    }
  }
  return mapped;
}

/** Parse active database windows without trusting nullable resource scope. */
export function parse_calendar_blockers(result: SqlQueryResult): CalendarBlocker[] {
  if (!Array.isArray(result.rows)) throw new CalendarStoreError("calendar-blocker-result-invalid");
  return result.rows.map((value) => {
    if (typeof value !== "object" || value === null) throw new CalendarStoreError("calendar-blocker-row-invalid");
    const row = value as Record<string, unknown>;
    return {
      resource_id: row.resource_id === null ? null : row_string(row.resource_id, "resource_id"),
      starts_at_ms: timestamp(row_string(row.starts_at, "starts_at"), "starts_at"),
      ends_at_ms: timestamp(row_string(row.ends_at, "ends_at"), "ends_at"),
    };
  });
}

/** Parse one locked hold and its held appointment. */
export function parse_calendar_hold_row(row: Record<string, unknown>): CalendarHoldRow {
  return {
    hold_id: row_string(row.hold_id, "hold_id"),
    slot_id: row_string(row.slot_id, "slot_id"),
    resource_id: row_string(row.resource_id, "resource_id"),
    starts_at_ms: timestamp(row_string(row.slot_start, "slot_start"), "slot_start"),
    ends_at_ms: timestamp(row_string(row.slot_end, "slot_end"), "slot_end"),
    expires_at_ms: timestamp(row_string(row.expires_at, "expires_at"), "expires_at"),
    is_live: row_boolean(row.is_live, "is_live"),
    hold_status: row_string(row.hold_status, "hold_status"),
    held_appointment_id: validate_appointment_id(row_string(row.held_appointment_id, "held_appointment_id")),
    held_status: row_string(row.held_status, "held_status"),
    held_resource_id: row_string(row.held_resource_id, "held_resource_id"),
    held_starts_at_ms: timestamp(row_string(row.held_starts_at, "held_starts_at"), "held_starts_at"),
    held_ends_at_ms: timestamp(row_string(row.held_ends_at, "held_ends_at"), "held_ends_at"),
  };
}

/** Require one returned row or fail with a stable adapter reason. */
export async function require_calendar_row(
  result: SqlQueryResult | Promise<SqlQueryResult>,
  reason: string,
): Promise<Record<string, unknown>> {
  const row = first_calendar_row(await result);
  if (row === null) throw new CalendarStoreError(reason);
  return row;
}

/** Return one row or null after validating the result shape. */
export function first_calendar_row(result: SqlQueryResult): Record<string, unknown> | null {
  if (!Array.isArray(result.rows)) throw new CalendarStoreError("calendar-result-invalid");
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) throw new CalendarStoreError("calendar-row-invalid");
  return row as Record<string, unknown>;
}

/** Apply half-open overlap semantics to a catalog slot and database blocker. */
export function calendar_slot_overlaps(slot: DurableSlot, blocker: CalendarBlocker): boolean {
  if (blocker.resource_id !== null && blocker.resource_id !== slot.resource_id) return false;
  return timestamp(slot.start_iso, "slot.start_iso") < blocker.ends_at_ms
    && blocker.starts_at_ms < timestamp(slot.end_iso, "slot.end_iso");
}

/** Apply half-open query-window semantics to one slot. */
export function calendar_slot_in_window(slot: DurableSlot, starts_at_ms: number, ends_at_ms: number): boolean {
  return timestamp(slot.start_iso, "slot.start_iso") < ends_at_ms
    && starts_at_ms < timestamp(slot.end_iso, "slot.end_iso");
}

/** Validate a bounded externally supplied identifier. */
export function safe_calendar_text(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new CalendarStoreError(`calendar-${field_name}-invalid`);
  }
  return value;
}

/** Validate and sanitize an operation key. */
export function safe_calendar_operation_key(value: string): string {
  try {
    return validate_operation_key(value);
  } catch {
    throw new CalendarStoreError("calendar-operation-key-invalid");
  }
}

/** Validate and sanitize an appointment id. */
export function safe_calendar_appointment_id(value: string): string {
  try {
    return validate_appointment_id(value);
  } catch {
    throw new CalendarStoreError("calendar-appointment_id-invalid");
  }
}

/** Validate a complete reschedule command without exposing validation details. */
export function safe_reschedule_command(value: RescheduleAppointmentCommand): ValidatedRescheduleCommand {
  try {
    return validate_reschedule_command(value);
  } catch (error) {
    throw new CalendarStoreError("calendar-reschedule-request-invalid", error);
  }
}

/** Convert a clock value to a valid date. */
export function valid_calendar_date(value: number): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new CalendarStoreError("calendar-clock-invalid");
  return date;
}

/** Require a safe database integer. */
export function calendar_integer(value: unknown, field_name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CalendarStoreError(`calendar-${field_name}-invalid`);
  return parsed;
}

function timestamp(value: string, field_name: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new CalendarStoreError(`calendar-${field_name}-invalid`);
  return parsed;
}

function row_string(value: unknown, field_name: string): string {
  const normalized = value instanceof Date
    ? value.toISOString()
    : typeof value === "string" || typeof value === "number" || typeof value === "bigint"
      ? String(value)
      : "";
  if (normalized.trim() === "" || normalized.length > 256) {
    throw new CalendarStoreError(`calendar-${field_name}-invalid`);
  }
  return normalized;
}

function row_boolean(value: unknown, field_name: string): boolean {
  if (typeof value !== "boolean") throw new CalendarStoreError(`calendar-${field_name}-invalid`);
  return value;
}

export { row_string as calendar_row_string, timestamp as calendar_timestamp };
