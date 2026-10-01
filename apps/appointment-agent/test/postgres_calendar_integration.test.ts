import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCalendarWriter } from "../src/calendar/postgres_calendar.js";
import { PostgresOutboundLedgerStore } from "../src/outbound/postgres_outbound_ledger.js";
import { OutboundLedgerUnknownError } from "../src/outbound/outbound_ledger.js";
import { PostgresTenantRateLimiter } from "../src/rate_limit/tenant_rate_limiter.js";
import { PostgresDataLifecycleStore } from "../src/enterprise/data_lifecycle.js";
import { PostgresOperatorActionAudit } from "../src/enterprise/operator_actions.js";
import { PgSqlClient } from "../src/persistence/pg_client.js";
import type { SqlQueryResult, SqlTransactionClient, TransactionalSqlClient } from "../src/persistence/sql_client.js";
import {
  AppointmentNotFoundError,
  AppointmentNotReschedulableError,
  AppointmentVersionConflictError,
  HoldExpiredError,
  SlotUnavailableError,
} from "../src/tools/calendar.js";
import type { TimeSlot } from "../src/state.js";

const database_url = process.env["TEST_DATABASE_URL"];
const describe_with_database = database_url === undefined ? describe.skip : describe;
const SOURCE_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_SOURCE_ID = "10000000-0000-4000-8000-000000000002";
const SLOT_ONE: TimeSlot = {
  id: "slot-one",
  start_iso: "2026-10-01T09:00:00.000Z",
  end_iso: "2026-10-01T09:30:00.000Z",
  staff: "provider-7",
  resource_id: "7",
};
const SLOT_TWO: TimeSlot = {
  id: "slot-two",
  start_iso: "2026-10-01T10:00:00.000Z",
  end_iso: "2026-10-01T10:30:00.000Z",
  staff: "provider-7",
  resource_id: "7",
};

let pool: Pool;

describe_with_database("PostgresCalendarWriter integration", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 8, connectionTimeoutMillis: 5_000 });
    await ensure_role(pool, "anon");
    await ensure_role(pool, "authenticated");
    await ensure_role(pool, "service_role");
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    const migration_dir = new URL("../../../packages/db/migrations/", import.meta.url);
    const migration_names = (await readdir(migration_dir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name))
      .sort();
    for (const name of migration_names) {
      await pool.query(await readFile(new URL(name, migration_dir), "utf8"));
    }
  }, 60_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE public.calendar_operations, public.audit_log, public.appointment_holds,
        public.appointments, public.resources, public.tenants CASCADE
    `);
    await pool.query("INSERT INTO public.tenants (id, name) OVERRIDING SYSTEM VALUE VALUES (42, 'Tenant A'), (43, 'Tenant B')");
    await pool.query("INSERT INTO public.resources (id, tenant_id, name) OVERRIDING SYSTEM VALUE VALUES (7, 42, 'Provider 7')");
    await pool.query(`
      INSERT INTO public.appointments (
        id, tenant_id, resource_id, customer_ref, status, starts_at, ends_at, idempotency_key
      ) VALUES
        ($1, 42, 7, 'customer-a', 'confirmed', $2, $3, 'source-key'),
        ($4, 42, 7, 'customer-b', 'confirmed', $5, $6, 'other-source-key')
    `, [
      SOURCE_ID,
      "2026-10-01T08:00:00.000Z",
      "2026-10-01T08:30:00.000Z",
      OTHER_SOURCE_ID,
      "2026-10-01T11:00:00.000Z",
      "2026-10-01T11:30:00.000Z",
    ]);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists idempotent holds across writer instances and releases them safely", async () => {
    const first = make_writer();
    const second = make_writer();
    const first_hold = await first.hold_slot(SLOT_ONE.id, 300, "hold-same-key");
    const replay = await second.hold_slot(SLOT_ONE.id, 300, "hold-same-key");

    expect(replay).toEqual(first_hold);
    await expect(first.list_slots("2026-10-01T08:00:00.000Z", "2026-10-01T12:00:00.000Z"))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: SLOT_TWO.id })]));
    expect(await available_slot_ids(first)).not.toContain(SLOT_ONE.id);
    await first.release_hold(first_hold.hold_id);
    await second.release_hold(first_hold.hold_id);
    expect(await available_slot_ids(second)).toContain(SLOT_ONE.id);
  });

  it("atomically moves the source and replays an ambiguous operation key", async () => {
    const writer = make_writer();
    const hold = await writer.hold_slot(SLOT_ONE.id, 300, "target-hold");
    const command = {
      tenant_id: "42",
      appointment_id: SOURCE_ID,
      expected_version: 1,
      hold_id: hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      idempotency_key: "reschedule-operation",
    };

    const first = await writer.reschedule_appointment(command);
    const replay = await make_writer().reschedule_appointment(command);

    expect(first).toEqual({
      appointment_id: SOURCE_ID,
      previous_version: 1,
      version: 2,
      hold_id: hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      status: "confirmed",
    });
    expect(replay).toEqual(first);
    const source = await pool.query(
      "SELECT status, version, starts_at, ends_at FROM public.appointments WHERE id = $1",
      [SOURCE_ID],
    );
    expect(source.rows[0]).toMatchObject({
      status: "confirmed",
      version: 2,
      starts_at: new Date(SLOT_ONE.start_iso),
      ends_at: new Date(SLOT_ONE.end_iso),
    });
    const audit = await pool.query(
      "SELECT count(*)::int AS count FROM public.audit_log WHERE action = 'appointment_rescheduled' AND entity_id = $1",
      [SOURCE_ID],
    );
    expect(audit.rows[0]?.count).toBe(1);
  });

  it("rejects missing, wrong-tenant, stale, and cancelled sources without moving them", async () => {
    const writer = make_writer();
    const missing_hold = await writer.hold_slot(SLOT_ONE.id, 300, "missing-source-hold");
    await expect(writer.reschedule_appointment({
      tenant_id: "42",
      appointment_id: "20000000-0000-4000-8000-000000000099",
      expected_version: 1,
      hold_id: missing_hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      idempotency_key: "missing-source",
    })).rejects.toBeInstanceOf(AppointmentNotFoundError);

    const wrong_tenant_hold = await writer.hold_slot(SLOT_TWO.id, 300, "wrong-tenant-hold");
    await expect(writer.reschedule_appointment({
      tenant_id: "43",
      appointment_id: SOURCE_ID,
      expected_version: 1,
      hold_id: wrong_tenant_hold.hold_id,
      target_slot_id: SLOT_TWO.id,
      idempotency_key: "wrong-tenant",
    })).rejects.toBeInstanceOf(AppointmentNotFoundError);

    await writer.release_hold(missing_hold.hold_id);
    const stale_hold = await writer.hold_slot(SLOT_ONE.id, 300, "stale-hold");
    await pool.query("UPDATE public.appointments SET starts_at = $2 WHERE id = $1", [
      SOURCE_ID,
      "2026-10-01T07:30:00.000Z",
    ]);
    await expect(writer.reschedule_appointment({
      tenant_id: "42",
      appointment_id: SOURCE_ID,
      expected_version: 1,
      hold_id: stale_hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      idempotency_key: "stale-source",
    })).rejects.toBeInstanceOf(AppointmentVersionConflictError);

    await pool.query("UPDATE public.appointments SET status = 'cancelled' WHERE id = $1", [SOURCE_ID]);
    await expect(writer.reschedule_appointment({
      tenant_id: "42",
      appointment_id: SOURCE_ID,
      expected_version: 2,
      hold_id: stale_hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      idempotency_key: "cancelled-source",
    })).rejects.toBeInstanceOf(AppointmentNotReschedulableError);
    expect((await source_row(SOURCE_ID)).status).toBe("cancelled");
  });

  it("rejects a catalog resource owned by another tenant at the database boundary", async () => {
    await pool.query("INSERT INTO public.resources (id, tenant_id, name) OVERRIDING SYSTEM VALUE VALUES (8, 43, 'Provider 8')");
    const foreign_slot = { ...SLOT_ONE, id: "foreign-resource-slot", resource_id: "8" };
    const writer = make_writer(undefined, [foreign_slot]);

    await expect(writer.hold_slot(foreign_slot.id, 300, "foreign-resource-hold"))
      .rejects.toMatchObject({ name: "CalendarStoreError" });
    const appointments = await pool.query(
      "SELECT count(*)::int AS count FROM public.appointments WHERE idempotency_key = 'foreign-resource-hold'",
    );
    expect(appointments.rows[0]?.count).toBe(0);
  });

  it("rejects expired and unavailable targets while preserving the source", async () => {
    let now = new Date("2026-10-01T08:00:00.000Z");
    const writer = make_writer(() => now);
    const hold = await writer.hold_slot(SLOT_ONE.id, 1, "expiring-hold");
    now = new Date("2026-10-01T08:00:02.000Z");
    await expect(writer.reschedule_appointment({
      tenant_id: "42",
      appointment_id: SOURCE_ID,
      expected_version: 1,
      hold_id: hold.hold_id,
      target_slot_id: SLOT_ONE.id,
      idempotency_key: "expired-target",
    })).rejects.toBeInstanceOf(HoldExpiredError);
    expect((await source_row(SOURCE_ID)).starts_at).toEqual(new Date("2026-10-01T08:00:00.000Z"));

    await pool.query("DELETE FROM public.appointment_holds");
    await pool.query("UPDATE public.appointments SET status = 'cancelled', deleted_at = now() WHERE status = 'held'");
    await pool.query(`
      INSERT INTO public.appointments (
        tenant_id, resource_id, customer_ref, status, starts_at, ends_at, idempotency_key
      ) VALUES (42, 7, 'rival', 'confirmed', $1, $2, 'rival-key')
    `, [SLOT_TWO.start_iso, SLOT_TWO.end_iso]);
    await expect(writer.hold_slot(SLOT_TWO.id, 300, "unavailable-target"))
      .rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("rolls back every mutation when the audit write fails", async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION public.test_reject_reschedule_audit()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'appointment_rescheduled' THEN
          RAISE EXCEPTION 'test audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER test_reject_reschedule_audit
        BEFORE INSERT ON public.audit_log
        FOR EACH ROW EXECUTE FUNCTION public.test_reject_reschedule_audit();
    `);
    const writer = make_writer();
    const hold = await writer.hold_slot(SLOT_ONE.id, 300, "rollback-hold");
    try {
      await expect(writer.reschedule_appointment({
        tenant_id: "42",
        appointment_id: SOURCE_ID,
        expected_version: 1,
        hold_id: hold.hold_id,
        target_slot_id: SLOT_ONE.id,
        idempotency_key: "rollback-reschedule",
      })).rejects.toMatchObject({ name: "CalendarStoreError" });
    } finally {
      await pool.query("DROP TRIGGER test_reject_reschedule_audit ON public.audit_log");
      await pool.query("DROP FUNCTION public.test_reject_reschedule_audit()");
    }

    expect((await source_row(SOURCE_ID)).starts_at).toEqual(new Date("2026-10-01T08:00:00.000Z"));
    const hold_row = await pool.query("SELECT status FROM public.appointment_holds WHERE token = $1", [hold.hold_id]);
    expect(hold_row.rows[0]?.status).toBe("held");
    const operation = await pool.query(
      "SELECT 1 FROM public.calendar_operations WHERE operation_key = 'rollback-reschedule'",
    );
    expect(operation.rowCount).toBe(0);
  });

  it("serializes concurrent moves so only one source version can win", async () => {
    const writer_one = make_writer();
    const writer_two = make_writer();
    const hold_one = await writer_one.hold_slot(SLOT_ONE.id, 300, "concurrent-hold-one");
    const hold_two = await writer_two.hold_slot(SLOT_TWO.id, 300, "concurrent-hold-two");
    const results = await Promise.allSettled([
      writer_one.reschedule_appointment({
        tenant_id: "42",
        appointment_id: SOURCE_ID,
        expected_version: 1,
        hold_id: hold_one.hold_id,
        target_slot_id: SLOT_ONE.id,
        idempotency_key: "concurrent-move-one",
      }),
      writer_two.reschedule_appointment({
        tenant_id: "42",
        appointment_id: SOURCE_ID,
        expected_version: 1,
        hold_id: hold_two.hold_id,
        target_slot_id: SLOT_TWO.id,
        idempotency_key: "concurrent-move-two",
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await source_row(SOURCE_ID)).version).toBe(2);
  });

  it("persists outbound leases and applies provider statuses across store instances", async () => {
    const first = make_ledger();
    const claim = await first.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "postgres-outbound-operation",
      request_fingerprint: "c".repeat(64),
      inbound_wamid: "wamid-postgres-outbound",
      turn_id: "0",
    });
    if (claim.kind !== "send") throw new Error("outbound claim setup failed");
    await first.mark_sent({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "postgres-outbound-operation",
      lease_token: claim.lease_token,
      provider_message_id: "wamid.postgres.outbound.1",
    });
    const second = make_ledger();
    const replay = await second.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "postgres-outbound-operation",
      request_fingerprint: "c".repeat(64),
      inbound_wamid: "wamid-postgres-outbound",
      turn_id: "0",
    });
    expect(replay).toMatchObject({ kind: "replay", record: { status: "sent" } });
    await expect(second.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.postgres.outbound.1",
      status: "delivered",
    })).resolves.toBe("updated");
    await expect(second.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.postgres.outbound.1",
      status: "delivered",
    })).resolves.toBe("duplicate");
    await expect(second.record_status("42", {
      provider: "whatsapp",
      provider_message_id: "wamid.postgres.outbound.1",
      status: "read",
    })).resolves.toBe("updated");
  });

  it("fences an expired outbound lease as unknown instead of permitting a duplicate", async () => {
    let now_ms = Date.parse("2026-10-01T08:00:00.000Z");
    const ledger = make_ledger(() => new Date(now_ms));
    const claim = await ledger.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "postgres-outbound-expired",
      request_fingerprint: "d".repeat(64),
      lease_seconds: 1,
    });
    if (claim.kind !== "send") throw new Error("outbound expiry setup failed");
    now_ms += 1_001;
    await expect(ledger.begin({
      tenant_id: "42",
      provider: "whatsapp",
      operation_key: "postgres-outbound-expired",
      request_fingerprint: "d".repeat(64),
      lease_seconds: 1,
    })).rejects.toBeInstanceOf(OutboundLedgerUnknownError);
    const row = await pool.query(
      "SELECT status, error_code FROM public.outbound_ledger WHERE tenant_id = 42 AND operation_key = 'postgres-outbound-expired'",
    );
    expect(row.rows[0]).toMatchObject({ status: "unknown", error_code: "lease_expired" });
  });

  it("serializes tenant rate counters in Postgres without cross-tenant leakage", async () => {
    const limiter = new PostgresTenantRateLimiter(new PgSqlClient({
      connection_string: database_url,
      pool,
      statement_timeout_ms: 5_000,
      transaction_timeout_ms: 5_000,
    }));
    const first = await Promise.all([
      limiter.consume({ tenant_id: "42", scope: "outbound", limit: 2, window_seconds: 60 }),
      limiter.consume({ tenant_id: "42", scope: "outbound", limit: 2, window_seconds: 60 }),
    ]);
    const other = await limiter.consume({ tenant_id: "43", scope: "outbound", limit: 2, window_seconds: 60 });
    expect(first.every((result) => result.allowed)).toBe(true);
    expect(other.allowed).toBe(true);
    await expect(limiter.consume({ tenant_id: "42", scope: "outbound", limit: 2, window_seconds: 60 }))
      .resolves.toMatchObject({ allowed: false });
  });

  it("persists legal holds and append-only operator audit evidence", async () => {
    const client = new PgSqlClient({
      connection_string: database_url,
      pool,
      statement_timeout_ms: 5_000,
      transaction_timeout_ms: 5_000,
    });
    const lifecycle = new PostgresDataLifecycleStore(client);
    await lifecycle.set_legal_hold({
      tenant_id: "42",
      scope: "inbound",
      reference: "matter-postgres-1",
      reason_code: "legal_request",
    });
    const active = await pool.query(
      "SELECT is_active FROM public.legal_holds WHERE tenant_id = 42 AND reference = 'matter-postgres-1'",
    );
    expect(active.rows[0]?.is_active).toBe(true);
    await lifecycle.release_legal_hold("42", "inbound", "matter-postgres-1");
    const released = await pool.query(
      "SELECT is_active, released_at FROM public.legal_holds WHERE tenant_id = 42 AND reference = 'matter-postgres-1'",
    );
    expect(released.rows[0]?.is_active).toBe(false);
    expect(released.rows[0]?.released_at).toBeTruthy();
    await expect(lifecycle.purge_expired({ inbound_days: 30, outbound_days: 90, rate_limit_bucket_days: 2 }, 10))
      .resolves.toEqual({
        inbound_deleted: 0,
        sessions_deleted: 0,
        jobs_deleted: 0,
        outbound_deleted: 0,
        rate_limit_buckets_deleted: 0,
      });

    const audit = new PostgresOperatorActionAudit(client);
    await audit.record({
      tenant_id: "42",
      actor_subject: "operator-postgres-1",
      action: "export_audit",
      target_id: "tenant-42",
      outcome: "succeeded",
      request_id: "request-postgres-1",
    });
    const evidence = await pool.query(
      "SELECT outcome, actor_subject FROM public.operator_action_audit WHERE tenant_id = 42 AND request_id = 'request-postgres-1'",
    );
    expect(evidence.rows[0]).toMatchObject({ outcome: "succeeded", actor_subject: "operator-postgres-1" });
  });
});

function make_ledger(clock: () => Date = () => new Date("2026-10-01T08:00:00.000Z")): PostgresOutboundLedgerStore {
  const client = new PgSqlClient({
    connection_string: database_url,
    pool,
    statement_timeout_ms: 5_000,
    transaction_timeout_ms: 5_000,
  });
  return new PostgresOutboundLedgerStore(client as TransactionalSqlClient, () => clock().getTime());
}

function make_writer(
  clock: () => Date = () => new Date("2026-10-01T08:00:00.000Z"),
  slots: readonly TimeSlot[] = [SLOT_ONE, SLOT_TWO],
): PostgresCalendarWriter {
  const client = new PgSqlClient({
    connection_string: database_url,
    pool,
    statement_timeout_ms: 5_000,
    transaction_timeout_ms: 5_000,
  });
  return new PostgresCalendarWriter({
    sql_client: client as TransactionalSqlClient,
    tenant_id: "42",
    slots,
    clock,
  });
}

async function ensure_role(pool: Pool, role: string): Promise<void> {
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
  if (exists.rowCount === 0) await pool.query(`CREATE ROLE ${role} NOLOGIN`);
}

async function available_slot_ids(writer: PostgresCalendarWriter): Promise<string[]> {
  const slots = await writer.list_slots("2026-10-01T08:00:00.000Z", "2026-10-01T12:00:00.000Z");
  return slots.map((slot) => slot.id);
}

async function source_row(appointment_id: string): Promise<Record<string, unknown>> {
  const result = await pool.query("SELECT * FROM public.appointments WHERE id = $1", [appointment_id]);
  return result.rows[0] as Record<string, unknown>;
}
