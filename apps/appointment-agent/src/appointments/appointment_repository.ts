/** Tenant-scoped read port for authoritative appointment snapshots. */

import { z } from "zod";
import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type { CalendarAppointment } from "../tools/calendar.js";

const MAX_APPOINTMENT_VERSION = 2_147_483_647;
const appointment_id_schema = z.string().uuid();
const tenant_id_schema = z.string().regex(/^[1-9]\d{0,18}$/);
const timestamp_schema = z.string().refine((value) => Number.isFinite(Date.parse(value)), "invalid timestamp");
const appointment_schema = z.object({
  appointment_id: appointment_id_schema,
  tenant_id: tenant_id_schema,
  version: z.number().int().min(1).max(MAX_APPOINTMENT_VERSION),
  status: z.enum(["held", "confirmed", "cancelled", "completed", "no_show"]),
  resource_id: z.string().regex(/^[1-9]\d{0,18}$/),
  starts_at_iso: timestamp_schema,
  ends_at_iso: timestamp_schema,
}).strict().refine((value) => Date.parse(value.ends_at_iso) > Date.parse(value.starts_at_iso), {
  message: "appointment end must follow start",
  path: ["ends_at_iso"],
});

/** Tenant and stable appointment identifier for one read. */
export interface AppointmentScope {
  tenant_id: string;
  appointment_id: string;
}

/** Narrow appointment read contract used before offering reschedule slots. */
export interface AppointmentRepository {
  /** Return one active appointment only when both tenant and id match. */
  get(scope: AppointmentScope): Promise<CalendarAppointment | null>;
}

/** Sanitized failure at the appointment read boundary. */
export class AppointmentRepositoryError extends Error {
  /** Create a safe repository error. */
  constructor(reason = "appointment-repository-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "AppointmentRepositoryError";
  }
}

const SELECT_APPOINTMENT_SQL = `
  SELECT id::TEXT AS appointment_id,
         tenant_id::TEXT AS tenant_id,
         version,
         status,
         resource_id::TEXT AS resource_id,
         starts_at,
         ends_at
  FROM appointments
  WHERE tenant_id = $1
    AND id = $2
    AND deleted_at IS NULL
    AND resource_id IS NOT NULL
  LIMIT 1
`;

/** Parameterized Postgres appointment reader. */
export class PostgresAppointmentRepository implements AppointmentRepository {
  private readonly sql_client: SqlClient;

  /** Create a repository over the server-side SQL boundary. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /** Load one tenant-scoped appointment without exposing driver errors. */
  async get(scope: AppointmentScope): Promise<CalendarAppointment | null> {
    const normalized = parse_scope(scope);
    try {
      const result = await this.sql_client.query(SELECT_APPOINTMENT_SQL, [
        normalized.tenant_id,
        normalized.appointment_id,
      ]);
      return first_appointment(result);
    } catch (error) {
      if (error instanceof AppointmentRepositoryError) throw error;
      throw new AppointmentRepositoryError("appointment-read-failed", error);
    }
  }
}

/** Explicit in-memory repository for local composition and focused tests. */
export class InMemoryAppointmentRepository implements AppointmentRepository {
  private readonly rows = new Map<string, CalendarAppointment>();

  /** Create an empty isolated appointment repository. */
  constructor(appointments: readonly CalendarAppointment[] = []) {
    for (const appointment of appointments) this.put(appointment);
  }

  /** Insert or replace a trusted test appointment snapshot. */
  put(appointment: CalendarAppointment): void {
    const parsed = parse_appointment(appointment);
    this.rows.set(appointment_key(parsed.tenant_id, parsed.appointment_id), parsed);
  }

  /** Return a defensive tenant-scoped snapshot. */
  async get(scope: AppointmentScope): Promise<CalendarAppointment | null> {
    const normalized = parse_scope(scope);
    const appointment = this.rows.get(appointment_key(normalized.tenant_id, normalized.appointment_id));
    return appointment === undefined ? null : { ...appointment };
  }
}

function parse_scope(scope: AppointmentScope): AppointmentScope {
  const parsed = z.object({
    tenant_id: tenant_id_schema,
    appointment_id: appointment_id_schema,
  }).strict().safeParse(scope);
  if (!parsed.success) throw new AppointmentRepositoryError("appointment-scope-invalid");
  return parsed.data;
}

function parse_appointment(value: unknown): CalendarAppointment {
  const parsed = appointment_schema.safeParse(value);
  if (!parsed.success) throw new AppointmentRepositoryError("appointment-invalid");
  return {
    ...parsed.data,
    starts_at_iso: new Date(Date.parse(parsed.data.starts_at_iso)).toISOString(),
    ends_at_iso: new Date(Date.parse(parsed.data.ends_at_iso)).toISOString(),
  };
}

function first_appointment(result: SqlQueryResult): CalendarAppointment | null {
  if (!Array.isArray(result.rows)) throw new AppointmentRepositoryError("appointment-result-invalid");
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (typeof row !== "object" || row === null) {
    throw new AppointmentRepositoryError("appointment-row-invalid");
  }
  return parse_appointment(normalize_row(row as Record<string, unknown>));
}

function normalize_row(row: Record<string, unknown>): unknown {
  return {
    appointment_id: string_value(row["appointment_id"], "appointment_id"),
    tenant_id: string_value(row["tenant_id"], "tenant_id"),
    version: integer_value(row["version"], "version"),
    status: row["status"],
    resource_id: string_value(row["resource_id"], "resource_id"),
    starts_at_iso: timestamp_value(row["starts_at"], "starts_at"),
    ends_at_iso: timestamp_value(row["ends_at"], "ends_at"),
  };
}

function string_value(value: unknown, field_name: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  throw new AppointmentRepositoryError(`appointment-${field_name}-invalid`);
}

function integer_value(value: unknown, field_name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new AppointmentRepositoryError(`appointment-${field_name}-invalid`);
  return parsed;
}

function timestamp_value(value: unknown, field_name: string): string {
  return string_value(value, field_name);
}

function appointment_key(tenant_id: string, appointment_id: string): string {
  return `${tenant_id}\u0000${appointment_id}`;
}
