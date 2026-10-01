import { describe, expect, it, vi } from "vitest";
import { validate_reschedule_command } from "../src/calendar/calendar_models.js";
import { PostgresCalendarWriter } from "../src/calendar/postgres_calendar.js";
import type { SqlQueryResult, SqlTransactionWork, TransactionalSqlClient } from "../src/persistence/sql_client.js";
import {
  AppointmentNotFoundError,
  CalendarOperationConflictError,
  CalendarStoreError,
  type RescheduleAppointmentCommand,
} from "../src/tools/calendar.js";
import type { TimeSlot } from "../src/state.js";

const SLOT: TimeSlot = {
  id: "slot-one",
  start_iso: "2026-10-01T09:00:00.000Z",
  end_iso: "2026-10-01T09:30:00.000Z",
  staff: "provider-7",
  resource_id: "7",
};
const APPOINTMENT_ID = "10000000-0000-4000-8000-000000000001";
const COMMAND: RescheduleAppointmentCommand = {
  tenant_id: "42",
  appointment_id: APPOINTMENT_ID,
  expected_version: 1,
  hold_id: "hold-one",
  target_slot_id: SLOT.id,
  idempotency_key: "reschedule-one",
};

function make_client(handler: (sql: string, values?: readonly unknown[]) => SqlQueryResult | Promise<SqlQueryResult>) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => handler(sql, values));
  const client: TransactionalSqlClient = {
    query,
    with_transaction: async <T>(work: SqlTransactionWork<T>) => work({ query }),
  };
  return { client, query };
}

describe("PostgresCalendarWriter boundaries", () => {
  it("requires a stable resource binding for every production slot", () => {
    const { client } = make_client(() => ({ rows: [] }));
    expect(() => new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] }))
      .not.toThrow();
    expect(() => new PostgresCalendarWriter({
      sql_client: client,
      tenant_id: "42",
      slots: [{ ...SLOT, resource_id: undefined }],
    })).toThrow(CalendarStoreError);
  });

  it("filters durable blockers and treats an unbound active row as blocking", async () => {
    const { client, query } = make_client((sql) => {
      if (sql.includes("FROM appointments")) {
        return {
          rows: [
            { resource_id: "7", starts_at: SLOT.start_iso, ends_at: SLOT.end_iso },
            { resource_id: null, starts_at: "2026-10-01T10:00:00.000Z", ends_at: "2026-10-01T10:30:00.000Z" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const writer = new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] });

    await expect(writer.list_slots("2026-10-01T08:00:00.000Z", "2026-10-01T11:00:00.000Z"))
      .resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status IN ('held', 'confirmed')"), [
      "42",
      "2026-10-01T08:00:00.000Z",
      "2026-10-01T11:00:00.000Z",
    ]);
  });

  it("replays a committed operation without touching the source appointment", async () => {
    const fingerprint = validate_reschedule_command(COMMAND).fingerprint;
    const result = {
      operation_type: "reschedule",
      appointment_id: APPOINTMENT_ID,
      previous_version: 1,
      version: 2,
      hold_id: COMMAND.hold_id,
      target_slot_id: COMMAND.target_slot_id,
      status: "confirmed",
    };
    const { client, query } = make_client((sql) => {
      if (sql.includes("FROM calendar_operations")) {
        return { rows: [{ operation_type: "reschedule", request_fingerprint: fingerprint, result }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const writer = new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] });

    await expect(writer.reschedule_appointment(COMMAND)).resolves.toEqual({
      appointment_id: APPOINTMENT_ID,
      previous_version: 1,
      version: 2,
      hold_id: COMMAND.hold_id,
      target_slot_id: COMMAND.target_slot_id,
      status: "confirmed",
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM appointments"))).toBe(false);
  });

  it("rejects operation-key reuse with a different request", async () => {
    const { client } = make_client((sql) => {
      if (sql.includes("FROM calendar_operations")) {
        return {
          rows: [{
            operation_type: "reschedule",
            request_fingerprint: "0".repeat(64),
            result: { operation_type: "reschedule" },
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const writer = new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] });

    await expect(writer.reschedule_appointment(COMMAND)).rejects.toBeInstanceOf(CalendarOperationConflictError);
  });

  it("fails closed for an adapter/command tenant mismatch before database access", async () => {
    const { client, query } = make_client(() => ({ rows: [] }));
    const writer = new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] });

    await expect(writer.reschedule_appointment({ ...COMMAND, tenant_id: "43" }))
      .rejects.toBeInstanceOf(AppointmentNotFoundError);
    expect(query).not.toHaveBeenCalled();
  });

  it("requires operation keys and treats an unknown release as idempotent", async () => {
    const { client, query } = make_client(() => ({ rows: [], rowCount: 0 }));
    const writer = new PostgresCalendarWriter({ sql_client: client, tenant_id: "42", slots: [SLOT] });

    await expect(writer.hold_slot(SLOT.id, 300)).rejects.toMatchObject({
      name: "CalendarStoreError",
      message: "calendar-operation-key-required",
    });
    await expect(writer.release_hold("missing-hold")).resolves.toBeUndefined();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("FROM appointment_holds"))).toBe(true);
  });
});
