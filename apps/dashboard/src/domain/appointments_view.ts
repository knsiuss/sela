/**
 * Tenant-scoped, PII-free projection of the appointment list.
 *
 * The appointment snapshot carries no customer name, phone, or message text by
 * design, so this module only ever searches and renders the identifiers the
 * domain already treats as non-PII: `appointment_id`, `tenant_id`, and
 * `resource_id`.
 */

import type { CalendarAppointment, CalendarAppointmentStatus } from "appointment-agent/dist/src/tools/calendar.js";

export type { CalendarAppointment, CalendarAppointmentStatus };

/** One tenant-scoped appointment row as the workspace exposes it. */
export type AppointmentRow = CalendarAppointment;

/** Columns the operator may sort the list by, in table order. */
export type AppointmentSortKey =
  | "appointment_id"
  | "resource_id"
  | "version"
  | "starts_at_iso"
  | "ends_at_iso"
  | "status";

/** Sort direction applied to the active column. */
export type SortDirection = "asc" | "desc";

/** Every supported sort column, in the order the table renders them. */
export const APPOINTMENT_SORT_KEYS: readonly AppointmentSortKey[] = [
  "appointment_id", "resource_id", "version", "starts_at_iso", "ends_at_iso", "status",
];

/** Appointment statuses offered in the status filter. */
export const APPOINTMENT_STATUSES: readonly CalendarAppointmentStatus[] = ["held", "confirmed", "cancelled", "completed", "no_show"];

/** Longest accepted filter query, matching a defensive identifier-search bound. */
export const MAX_FILTER_QUERY_LENGTH = 64;

/** Default sort: soonest start first, which is what an operator triages on. */
export const DEFAULT_APPOINTMENT_SORT: { key: AppointmentSortKey; direction: SortDirection } = { key: "starts_at_iso", direction: "asc" };

/** Failure raised when a filter or sort argument cannot be trusted. */
export class AppointmentsViewError extends Error {
  readonly code: string;

  /** Create a sanitized appointments-view failure. */
  constructor(code: string) {
    super(code);
    this.name = "AppointmentsViewError";
    this.code = code;
  }
}

/** Operator-supplied list filters. */
export interface AppointmentFilter {
  /** Free-text match over `appointment_id` and `resource_id` only. */
  query: string;
  /** Status to restrict to, or `all`. */
  status: CalendarAppointmentStatus | "all";
}

/** Counts used by the overview page. */
export interface AppointmentSummary {
  total: number;
  by_status: Readonly<Record<CalendarAppointmentStatus, number>>;
}

/** Validate and normalize a filter at the boundary. */
export function parse_appointment_filter(value: unknown): AppointmentFilter {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AppointmentsViewError("appointments-filter-invalid");
  }
  const record = value as Record<string, unknown>;
  const status = record.status ?? "all";
  if (status !== "all" && !APPOINTMENT_STATUSES.includes(status as CalendarAppointmentStatus)) {
    throw new AppointmentsViewError("appointments-filter-status-invalid");
  }
  const query = typeof record.query === "string" ? record.query : "";
  if (query.length > MAX_FILTER_QUERY_LENGTH) throw new AppointmentsViewError("appointments-filter-query-too-long");
  return { query: query.trim().toLowerCase(), status: status as CalendarAppointmentStatus | "all" };
}

/** Keep only the rows a tenant may see, in their authoritative order. */
export function scope_to_tenant(rows: readonly CalendarAppointment[], tenant_id: string): CalendarAppointment[] {
  if (typeof tenant_id !== "string" || !/^[1-9]\d{0,18}$/.test(tenant_id)) {
    throw new AppointmentsViewError("appointments-tenant-invalid");
  }
  return rows.filter((row) => row.tenant_id === tenant_id).map((row) => ({ ...row }));
}

/** Count rows removed by tenant scoping so the UI can prove the boundary. */
export function count_hidden_by_tenant_scope(rows: readonly CalendarAppointment[], tenant_id: string): number {
  return rows.filter((row) => row.tenant_id !== tenant_id).length;
}

/** Apply the validated filter without mutating the input. */
export function filter_appointments(
  rows: readonly CalendarAppointment[],
  filter: AppointmentFilter,
): CalendarAppointment[] {
  const normalized = parse_appointment_filter(filter);
  return rows.filter((row) => matches_filter(row, normalized));
}

/** Sort stably, breaking ties on `appointment_id` so order is deterministic. */
export function sort_appointments(
  rows: readonly CalendarAppointment[],
  key: AppointmentSortKey,
  direction: SortDirection,
): CalendarAppointment[] {
  if (!APPOINTMENT_SORT_KEYS.includes(key)) throw new AppointmentsViewError("appointments-sort-key-invalid");
  if (direction !== "asc" && direction !== "desc") throw new AppointmentsViewError("appointments-sort-direction-invalid");
  const sign = direction === "asc" ? 1 : -1;
  return [...rows].sort((left, right) => sign * compare(left, right, key) || compare(left, right, "appointment_id"));
}

/** Count rows per status for the overview page. */
export function summarize_appointments(rows: readonly CalendarAppointment[]): AppointmentSummary {
  const by_status: Record<CalendarAppointmentStatus, number> = {
    held: 0, confirmed: 0, cancelled: 0, completed: 0, no_show: 0,
  };
  for (const row of rows) by_status[row.status] += 1;
  return { total: rows.length, by_status };
}

/** Toggle direction for a column header button. */
export function next_sort_direction(
  key: AppointmentSortKey,
  current_key: AppointmentSortKey,
  current_direction: SortDirection,
): SortDirection {
  if (key !== current_key) return "asc";
  return current_direction === "asc" ? "desc" : "asc";
}

function matches_filter(row: CalendarAppointment, filter: AppointmentFilter): boolean {
  if (filter.status !== "all" && row.status !== filter.status) return false;
  if (filter.query === "") return true;
  return row.appointment_id.toLowerCase().includes(filter.query)
    || row.resource_id.toLowerCase().includes(filter.query);
}

function compare(left: CalendarAppointment, right: CalendarAppointment, key: AppointmentSortKey): number {
  if (key === "version") return left.version - right.version;
  if (key === "starts_at_iso") return left.starts_at_iso.localeCompare(right.starts_at_iso);
  if (key === "ends_at_iso") return left.ends_at_iso.localeCompare(right.ends_at_iso);
  return String(left[key]).localeCompare(String(right[key]));
}