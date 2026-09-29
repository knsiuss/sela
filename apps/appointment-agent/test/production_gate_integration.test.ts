import { readFile, readdir } from "node:fs/promises";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgSqlClient } from "../src/persistence/pg_client.js";
import { run_database_production_gate } from "../src/persistence/production_gate.js";

const database_url = process.env["TEST_DATABASE_URL"];
const describe_with_database = database_url === undefined ? describe.skip : describe;

const TENANT_A = 9101;
const TENANT_B = 9102;
const EXPECTED_MIGRATIONS = [
  "0001_init.sql",
  "0002_rls.sql",
  "0003_rag.sql",
  "0004_webhook_jobs.sql",
  "0005_inbound_messages.sql",
  "0006_reply_target.sql",
  "0007_inbound_button_id.sql",
  "0008_worker_tenant_hardening.sql",
  "0009_worker_leases.sql",
  "0010_reschedule_sessions.sql",
  "0011_tenant_scoped_dedupe.sql",
  "0012_durable_calendar_reschedule.sql",
  "0013_rate_limit_outbound_ledger.sql",
  "0014_inbound_reconciliation.sql",
];
const RERUNNABLE = new Set([
  "0002_rls.sql",
  "0005_inbound_messages.sql",
  "0006_reply_target.sql",
  "0007_inbound_button_id.sql",
  "0008_worker_tenant_hardening.sql",
  "0009_worker_leases.sql",
  "0010_reschedule_sessions.sql",
  "0011_tenant_scoped_dedupe.sql",
  "0012_durable_calendar_reschedule.sql",
  "0013_rate_limit_outbound_ledger.sql",
  "0014_inbound_reconciliation.sql",
]);

let pool: Pool;
let lock_client: PoolClient | null = null;
let resource_ids: Map<number, number> = new Map();

async function ensure_role(name: string): Promise<void> {
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [name]);
  if (exists.rowCount === 0) await pool.query(`CREATE ROLE ${name} NOLOGIN`);
}

async function migration_names(): Promise<string[]> {
  const migration_dir = new URL("../../../packages/db/migrations/", import.meta.url);
  return (await readdir(migration_dir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

async function apply_migration(name: string): Promise<void> {
  const migration_dir = new URL("../../../packages/db/migrations/", import.meta.url);
  await pool.query(await readFile(new URL(name, migration_dir), "utf8"));
}

async function with_role<T>(
  role: string,
  tenant: number | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Role names are fixed code constants from the deployment matrix, never caller input.
    await client.query(`SET ROLE ${role}`);
    if (tenant !== null) await client.query("SELECT set_config('app.current_tenant', $1, true)", [String(tenant)]);
    try {
      return await work(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    try {
      await client.query("RESET ROLE");
    } catch {
      // The connection is unusable; releasing still returns it safely.
    }
    client.release();
  }
}

function text_column(result: { rows: unknown[] }, column: string): string[] {
  return result.rows.map((row) => String((row as Record<string, unknown>)[column]));
}

describe_with_database("database production gate integration", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: database_url, max: 8, connectionTimeoutMillis: 5_000 });
    lock_client = await pool.connect();
    await lock_client.query("SELECT pg_advisory_lock(9105001)");
    for (const role of ["anon", "authenticated", "service_role", "analytics_reader", "db_migrator"]) {
      await ensure_role(role);
    }
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    for (const name of await migration_names()) await apply_migration(name);
    await pool.query("GRANT USAGE ON SCHEMA public TO analytics_reader");
    await pool.query("GRANT SELECT ON public.appointments TO analytics_reader");
    await pool.query("GRANT CREATE, USAGE ON SCHEMA public TO db_migrator");
    const database_name = (await pool.query("SELECT current_database() AS name")).rows[0] as { name: string };
    await pool.query(`ALTER DATABASE "${database_name.name}" SET statement_timeout = '10s'`);
    await pool.query(`ALTER DATABASE "${database_name.name}" SET lock_timeout = '2s'`);
    await pool.query(`ALTER DATABASE "${database_name.name}" SET idle_in_transaction_session_timeout = '60s'`);
    await seed_tenants();
  }, 120_000);

  afterAll(async () => {
    if (pool !== undefined) {
      // Best effort: tenant FKs without cascade (webhook_jobs) may keep seed
      // rows in an ephemeral database; the next run reseeds from a clean schema.
      await pool.query("DELETE FROM public.tenants WHERE id IN (9101, 9102)").catch(() => undefined);
    }
    if (lock_client !== null) {
      await lock_client.query("SELECT pg_advisory_unlock(9105001)").catch(() => undefined);
      lock_client.release();
    }
    await pool?.end();
  });

  it("applies migrations 0001-0014 in filename order", async () => {
    expect(await migration_names()).toEqual(EXPECTED_MIGRATIONS);
    for (const table of ["tenants", "processed_messages", "calendar_operations", "ingress_repairs"]) {
      const exists = await pool.query("SELECT to_regclass($1) IS NOT NULL AS present", [`public.${table}`]);
      expect((exists.rows[0] as { present: boolean }).present).toBe(true);
    }
  });

  it("reruns idempotent migrations and fails closed on base-table reruns without data loss", async () => {
    for (const name of EXPECTED_MIGRATIONS) {
      if (RERUNNABLE.has(name)) await apply_migration(name);
      else await expect(apply_migration(name)).rejects.toThrow();
    }
    const tenants = await pool.query("SELECT count(*)::int AS count FROM public.tenants WHERE id IN (9101, 9102)");
    expect((tenants.rows[0] as { count: number }).count).toBe(2);
    expect(await migration_names()).toEqual(EXPECTED_MIGRATIONS);
  });

  it("enables RLS on every tenant-owned and server-only table", async () => {
    const result = await pool.query(
      `SELECT relname FROM pg_catalog.pg_class
       WHERE relnamespace = 'public'::regnamespace AND relrowsecurity = false AND relkind = 'r'`,
    );
    // Knowledge tables from 0003 carry no RLS by design and stay owner-only:
    // no grant to any client role, so the default-deny still holds.
    const without_rls = text_column(result, "relname").filter((name) => !name.startsWith("spatial_ref_sys"));
    expect(without_rls.sort()).toEqual(["knowledge_chunks", "knowledge_documents"]);
    for (const table of without_rls) {
      const grants = await pool.query(
        "SELECT has_table_privilege('anon', $1, 'SELECT') AS anon, has_table_privilege('authenticated', $1, 'SELECT,INSERT,UPDATE,DELETE') AS client",
        [`public.${table}`],
      );
      expect(grants.rows[0]).toMatchObject({ anon: false, client: false });
    }
  });

  it("enforces the deployment role matrix with least privilege", async () => {
    const matrix = await pool.query(
      `SELECT
        has_table_privilege('anon', 'public.appointments', 'SELECT,INSERT,UPDATE,DELETE') AS anon_appointments,
        has_table_privilege('anon', 'public.processed_messages', 'SELECT') AS anon_processed,
        has_table_privilege('authenticated', 'public.processed_messages', 'SELECT,INSERT,UPDATE,DELETE') AS app_processed,
        has_table_privilege('authenticated', 'public.calendar_operations', 'SELECT,INSERT') AS app_calendar,
        has_table_privilege('authenticated', 'public.outbound_ledger', 'SELECT') AS app_outbound,
        has_table_privilege('authenticated', 'public.tenant_rate_limits', 'SELECT') AS app_limits,
        has_table_privilege('authenticated', 'public.operator_action_audit', 'SELECT') AS app_audit,
        has_table_privilege('authenticated', 'public.appointments', 'SELECT,INSERT,UPDATE,DELETE') AS app_appointments,
        has_table_privilege('authenticated', 'public.outbox', 'DELETE') AS app_outbox_delete,
        has_table_privilege('service_role', 'public.outbound_ledger', 'SELECT,INSERT,UPDATE') AS service_outbound,
        has_table_privilege('service_role', 'public.inbound_messages', 'SELECT,INSERT,UPDATE,DELETE') AS service_inbound,
        has_table_privilege('analytics_reader', 'public.appointments', 'SELECT') AS analytics_read,
        has_table_privilege('analytics_reader', 'public.appointments', 'INSERT,UPDATE,DELETE') AS analytics_write,
        has_table_privilege('analytics_reader', 'public.processed_messages', 'SELECT') AS analytics_processed,
        has_schema_privilege('anon', 'public', 'CREATE') AS anon_ddl,
        has_schema_privilege('authenticated', 'public', 'CREATE') AS app_ddl,
        has_schema_privilege('db_migrator', 'public', 'CREATE') AS migrator_ddl`,
    );
    expect(matrix.rows[0]).toMatchObject({
      anon_appointments: false,
      anon_processed: false,
      app_processed: false,
      app_calendar: false,
      app_outbound: false,
      app_limits: false,
      app_audit: false,
      app_appointments: true,
      app_outbox_delete: false,
      service_outbound: true,
      service_inbound: true,
      analytics_read: true,
      analytics_write: false,
      analytics_processed: false,
      anon_ddl: false,
      app_ddl: false,
      migrator_ddl: true,
    });
  });

  it("isolates reads per tenant and denies every tenant-owned table without a tenant", async () => {
    for (const spec of READ_SPECS) {
      const as_tenant = await with_role("authenticated", TENANT_A, (client) => client.query(spec.read_sql));
      expect(text_column(as_tenant, spec.marker_column)).toEqual([spec.marker_a]);
      const without_tenant = await with_role("authenticated", null, (client) => client.query(spec.read_sql));
      expect(without_tenant.rows).toHaveLength(0);
    }
    for (const table of SERVER_ONLY_TABLES) {
      await expect(with_role("authenticated", TENANT_A, (client) => client.query(`SELECT * FROM ${table} LIMIT 1`))).rejects.toThrow();
    }
  });

  it("denies cross-tenant writes and tenant hopping for every tenant-owned table", async () => {
    for (const spec of WRITE_SPECS) {
      await expect(
        with_role("authenticated", TENANT_A, (client) => client.query(spec.insert_sql, [TENANT_B, "W"])),
      ).rejects.toThrow();
      if (spec.has_insert) {
        await expect(
          with_role("authenticated", TENANT_A, (client) => client.query(spec.insert_sql, [TENANT_A, "W"])),
        ).resolves.toBeDefined();
      } else {
        await expect(
          with_role("authenticated", TENANT_A, (client) => client.query(spec.insert_sql, [TENANT_A, "W"])),
        ).rejects.toThrow();
      }
      if (spec.has_update) {
        const cross_update = await with_role("authenticated", TENANT_A, (client) =>
          client.query(spec.cross_update_sql),
        );
        expect(cross_update.rowCount).toBe(0);
      } else {
        await expect(
          with_role("authenticated", TENANT_A, (client) => client.query(spec.cross_update_sql)),
        ).rejects.toThrow();
      }
      await expect(
        with_role("authenticated", TENANT_A, (client) => client.query(spec.hop_sql)),
      ).rejects.toThrow();
    }
  });

  it("keeps processed_messages server-only while service_role writes succeed", async () => {
    await expect(
      with_role("authenticated", TENANT_A, (client) =>
        client.query("INSERT INTO public.processed_messages (tenant_id, wamid) VALUES ($1, $2)", [TENANT_A, "p05-probe"]),
      ),
    ).rejects.toThrow();
    const inserted = await with_role("service_role", null, (client) =>
      client.query("INSERT INTO public.processed_messages (tenant_id, wamid) VALUES ($1, $2) RETURNING wamid", [
        TENANT_A,
        "p05-probe",
      ]),
    );
    expect(inserted.rows).toHaveLength(1);
  });

  it("grants sequences for server writes without opening server sequences to clients", async () => {
    const inserted = await with_role("service_role", null, (client) =>
      client.query(
        `INSERT INTO public.legal_holds (tenant_id, scope, reference, reason_code)
         VALUES ($1, 'inbound', 'p05-seq-probe', 'legal_request') RETURNING id`,
        [TENANT_A],
      ),
    );
    expect(Number((inserted.rows[0] as { id: number }).id)).toBeGreaterThan(0);
    const app_insert = await with_role("authenticated", TENANT_A, (client) =>
      client.query("INSERT INTO public.services (tenant_id, name, duration_min) VALUES ($1, 'p05-seq-svc', 30) RETURNING id", [
        TENANT_A,
      ]),
    );
    expect(Number((app_insert.rows[0] as { id: number }).id)).toBeGreaterThan(0);
    await expect(
      with_role("authenticated", TENANT_A, (client) =>
        client.query(
          "INSERT INTO public.ingress_repairs (tenant_id, wamid, action, actor, reason, resulting_state) VALUES ($1, $2, $3, $4, $5, $6)",
          [TENANT_A, "p05-seq-repair", "quarantine", "p05-actor", "p05 sequence probe reason", "needs_repair"],
        ),
      ),
    ).rejects.toThrow();
  });

  it("passes the production gate with evidence and fails closed without it", async () => {
    const gate_pool = new Pool({ connectionString: database_url, max: 2, connectionTimeoutMillis: 5_000 });
    const client = new PgSqlClient({
      pool: gate_pool,
      connection_string: database_url,
      statement_timeout_ms: 10_000,
      connection_timeout_ms: 5_000,
      transaction_timeout_ms: 10_000,
      max_pool_size: 2,
    });
    try {
      const evidence = { verified_at_iso: new Date().toISOString(), reference: "p05-integration-smoke" };
      const report = await run_database_production_gate(client, {
        require_tls: false,
        backup_evidence: evidence,
        restore_evidence: evidence,
        connection_timeout_ms: 5_000,
        transaction_timeout_ms: 10_000,
        max_pool_size: 2,
      });
      expect(report.checks.map((check) => check.name)).toEqual([
        "required-schema",
        "rls",
        "role-isolation",
        "migration-state",
        "sequence-privileges",
        "timeouts",
        "tls",
        "backup",
        "restore",
      ]);
      expect(report.checks.filter((check) => check.name !== "tls").every((check) => check.passed)).toBe(true);
      const ssl = await pool.query("SHOW ssl");
      const ssl_on = (ssl.rows[0] as { ssl: string }).ssl === "on";
      expect(report.checks.find((check) => check.name === "tls")?.passed).toBe(ssl_on);
      const without_evidence = await run_database_production_gate(client, { require_tls: false });
      expect(without_evidence.passed).toBe(false);
      expect(without_evidence.checks.find((check) => check.name === "backup")?.passed).toBe(false);
      expect(without_evidence.checks.find((check) => check.name === "restore")?.passed).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("fails closed when the pool is exhausted", async () => {
    const raw = new Pool({ connectionString: database_url, max: 1, connectionTimeoutMillis: 200 });
    const client = new PgSqlClient({
      pool: raw,
      statement_timeout_ms: 5_000,
      transaction_timeout_ms: 5_000,
      max_pool_size: 1,
    });
    try {
      const held = client.with_transaction(async (transaction) => {
        await transaction.query("SELECT pg_sleep(0.6)");
        return "held";
      });
      await expect(client.with_transaction(async () => "second")).rejects.toMatchObject({ name: "PgClientError" });
      await expect(held).resolves.toBe("held");
    } finally {
      await client.close();
    }
  }, 15_000);
});

interface ReadSpec {
  read_sql: string;
  marker_column: string;
  marker_a: string;
}

const READ_SPECS: ReadSpec[] = [
  { read_sql: "SELECT name FROM public.tenants WHERE name LIKE 'p05-tenant-%' ORDER BY 1", marker_column: "name", marker_a: "p05-tenant-A" },
  { read_sql: "SELECT user_id::text AS user_id FROM public.memberships WHERE user_id::text LIKE 'a0000000%' ORDER BY 1", marker_column: "user_id", marker_a: "a0000000-0000-4000-8000-000000009101" },
  { read_sql: "SELECT name FROM public.services WHERE name LIKE 'p05-%' ORDER BY 1", marker_column: "name", marker_a: "p05-svc-A" },
  { read_sql: "SELECT name FROM public.resources WHERE name LIKE 'p05-%' ORDER BY 1", marker_column: "name", marker_a: "p05-res-A" },
  { read_sql: "SELECT customer_ref FROM public.appointments WHERE customer_ref LIKE 'p05-%' ORDER BY 1", marker_column: "customer_ref", marker_a: "p05-appt-A" },
  { read_sql: "SELECT token FROM public.appointment_holds WHERE token LIKE 'p05-%' ORDER BY 1", marker_column: "token", marker_a: "p05-hold-A" },
  { read_sql: "SELECT idempotency_key FROM public.outbox WHERE idempotency_key LIKE 'p05-%' ORDER BY 1", marker_column: "idempotency_key", marker_a: "p05-outbox-A" },
  { read_sql: "SELECT entity_id FROM public.audit_log WHERE entity_id LIKE 'p05-%' ORDER BY 1", marker_column: "entity_id", marker_a: "p05-audit-A" },
  { read_sql: "SELECT wa_message_id FROM public.message_log WHERE wa_message_id LIKE 'p05-%' ORDER BY 1", marker_column: "wa_message_id", marker_a: "p05-msg-A" },
  { read_sql: "SELECT channel_account_id FROM public.tenant_channels WHERE channel_account_id LIKE 'p05-%' ORDER BY 1", marker_column: "channel_account_id", marker_a: "p05-chan-A" },
  { read_sql: "SELECT wamid FROM public.inbound_messages WHERE wamid LIKE 'p05-%' ORDER BY 1", marker_column: "wamid", marker_a: "p05-wamid-A" },
  { read_sql: "SELECT wamid FROM public.webhook_jobs WHERE wamid LIKE 'p05-%' ORDER BY 1", marker_column: "wamid", marker_a: "p05-wamid-A" },
  { read_sql: "SELECT conversation_id FROM public.reschedule_sessions WHERE conversation_id LIKE 'p05-%' ORDER BY 1", marker_column: "conversation_id", marker_a: "p05-conv-A" },
  { read_sql: "SELECT wamid FROM public.ingress_repairs WHERE wamid LIKE 'p05-%' ORDER BY 1", marker_column: "wamid", marker_a: "p05-repair-A" },
];

const SERVER_ONLY_TABLES = [
  "public.processed_messages",
  "public.calendar_operations",
  "public.tenant_rate_limits",
  "public.outbound_ledger",
  "public.legal_holds",
  "public.operator_action_audit",
];

interface WriteSpec {
  insert_sql: string;
  cross_update_sql: string;
  hop_sql: string;
  has_insert: boolean;
  has_update: boolean;
}

const WRITE_SPECS: WriteSpec[] = [
  {
    insert_sql: "INSERT INTO public.tenants (name) VALUES ('p05-w-tenant-' || $2)",
    cross_update_sql: "UPDATE public.tenants SET name = 'p05-hijack' WHERE id = 9102",
    hop_sql: "UPDATE public.tenants SET id = 9102 WHERE id = 9101",
    has_insert: false,
    has_update: true,
  },
  {
    insert_sql: "INSERT INTO public.memberships (tenant_id, user_id, role) VALUES ($1, gen_random_uuid(), 'viewer')",
    cross_update_sql: "UPDATE public.memberships SET role = 'staff' WHERE tenant_id = 9102",
    hop_sql: "UPDATE public.memberships SET tenant_id = 9102 WHERE tenant_id = 9101",
    has_insert: false,
    has_update: false,
  },
  {
    insert_sql: "INSERT INTO public.services (tenant_id, name, duration_min) VALUES ($1, 'p05-w-svc-' || $2, 30)",
    cross_update_sql: "UPDATE public.services SET name = 'p05-hijack' WHERE tenant_id = 9102 AND name = 'p05-svc-B'",
    hop_sql: "UPDATE public.services SET tenant_id = 9102 WHERE tenant_id = 9101 AND name = 'p05-svc-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: "INSERT INTO public.resources (tenant_id, name) VALUES ($1, 'p05-w-res-' || $2)",
    cross_update_sql: "UPDATE public.resources SET name = 'p05-hijack' WHERE tenant_id = 9102 AND name = 'p05-res-B'",
    hop_sql: "UPDATE public.resources SET tenant_id = 9102 WHERE tenant_id = 9101 AND name = 'p05-res-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: `INSERT INTO public.appointments (tenant_id, customer_ref, status, starts_at, ends_at, idempotency_key)
     VALUES ($1, 'p05-w-appt-' || $2, 'confirmed', '2026-11-05T09:00:00Z', '2026-11-05T09:30:00Z', 'p05-w-appt-' || $2)`,
    cross_update_sql: "UPDATE public.appointments SET customer_ref = 'p05-hijack' WHERE tenant_id = 9102 AND customer_ref = 'p05-appt-B'",
    hop_sql: "UPDATE public.appointments SET tenant_id = 9102 WHERE tenant_id = 9101 AND customer_ref = 'p05-appt-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: `INSERT INTO public.appointment_holds (tenant_id, resource_id, slot_start, slot_end, token, expires_at)
     VALUES ($1, 9101, '2026-11-06T09:00:00Z', '2026-11-06T09:30:00Z', 'p05-w-hold-' || $2, '2026-11-07T09:00:00Z')`,
    cross_update_sql: "UPDATE public.appointment_holds SET token = 'p05-hijack' WHERE tenant_id = 9102 AND token = 'p05-hold-B'",
    hop_sql: "UPDATE public.appointment_holds SET tenant_id = 9102 WHERE tenant_id = 9101 AND token = 'p05-hold-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: `INSERT INTO public.outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key)
     VALUES ($1, 'appointment', 'p05-agg', 'created', '{}', 'p05-w-outbox-' || $2)`,
    cross_update_sql: "UPDATE public.outbox SET event_type = 'p05-hijack' WHERE tenant_id = 9102 AND idempotency_key = 'p05-outbox-B'",
    hop_sql: "UPDATE public.outbox SET tenant_id = 9102 WHERE tenant_id = 9101 AND idempotency_key = 'p05-outbox-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: `INSERT INTO public.audit_log (tenant_id, actor, action, entity_type, entity_id, diff)
     VALUES ($1, 'p05-actor', 'test_action', 'appointment', 'p05-w-audit-' || $2, '{}')`,
    cross_update_sql: "UPDATE public.audit_log SET actor = 'p05-hijack' WHERE tenant_id = 9102 AND entity_id = 'p05-audit-B'",
    hop_sql: "UPDATE public.audit_log SET tenant_id = 9102 WHERE tenant_id = 9101 AND entity_id = 'p05-audit-A'",
    has_insert: true,
    has_update: false,
  },
  {
    insert_sql: "INSERT INTO public.message_log (tenant_id, wa_message_id, direction, status) VALUES ($1, 'p05-w-msg-' || $2, 'in', 'sent')",
    cross_update_sql: "UPDATE public.message_log SET status = 'failed' WHERE tenant_id = 9102 AND wa_message_id = 'p05-msg-B'",
    hop_sql: "UPDATE public.message_log SET tenant_id = 9102 WHERE tenant_id = 9101 AND wa_message_id = 'p05-msg-A'",
    has_insert: true,
    has_update: true,
  },
  {
    insert_sql: "INSERT INTO public.tenant_channels (tenant_id, channel, channel_account_id) VALUES ($1, 'whatsapp', 'p05-w-chan-' || $2)",
    cross_update_sql: "UPDATE public.tenant_channels SET channel_account_id = 'p05-hijack' WHERE tenant_id = 9102 AND channel_account_id = 'p05-chan-B'",
    hop_sql: "UPDATE public.tenant_channels SET tenant_id = 9102 WHERE tenant_id = 9101 AND channel_account_id = 'p05-chan-A'",
    has_insert: false,
    has_update: false,
  },
  {
    insert_sql: `INSERT INTO public.inbound_messages (tenant_id, wamid, conversation_id, message_type, sender_ref, message_text, received_at)
     VALUES ($1, 'p05-w-in-' || $2, 'p05-w-conv', 'text', 'p05-sender', 'probe', now())`,
    cross_update_sql: "UPDATE public.inbound_messages SET message_text = 'p05-hijack' WHERE tenant_id = 9102 AND wamid = 'p05-wamid-B'",
    hop_sql: "UPDATE public.inbound_messages SET tenant_id = 9102 WHERE tenant_id = 9101 AND wamid = 'p05-wamid-A'",
    has_insert: false,
    has_update: false,
  },
  {
    insert_sql: "INSERT INTO public.webhook_jobs (tenant_id, request_id, wamid, conversation_id, received_at_iso) VALUES ($1, 'p05-w-req-' || $2, 'p05-w-job-' || $2, 'p05-w-conv', now())",
    cross_update_sql: "UPDATE public.webhook_jobs SET last_error = 'p05-hijack' WHERE tenant_id = 9102 AND wamid = 'p05-wamid-B'",
    hop_sql: "UPDATE public.webhook_jobs SET tenant_id = 9102 WHERE tenant_id = 9101 AND wamid = 'p05-wamid-A'",
    has_insert: false,
    has_update: false,
  },
  {
    insert_sql: "INSERT INTO public.reschedule_sessions (tenant_id, conversation_id, phase, expires_at) VALUES ($1, 'p05-w-conv-' || $2, 'offered', now() + interval '1 hour')",
    cross_update_sql: "UPDATE public.reschedule_sessions SET phase = 'handoff' WHERE tenant_id = 9102 AND conversation_id = 'p05-conv-B'",
    hop_sql: "UPDATE public.reschedule_sessions SET tenant_id = 9102 WHERE tenant_id = 9101 AND conversation_id = 'p05-conv-A'",
    has_insert: false,
    has_update: false,
  },
  {
    insert_sql: `INSERT INTO public.ingress_repairs (tenant_id, wamid, action, actor, reason, resulting_state)
     VALUES ($1, 'p05-w-repair-' || $2, 'quarantine', 'p05-actor', 'p05 probe reason ABCD', 'needs_repair')`,
    cross_update_sql: "UPDATE public.ingress_repairs SET action = 'quarantine' WHERE tenant_id = 9102 AND wamid = 'p05-repair-B'",
    hop_sql: "UPDATE public.ingress_repairs SET tenant_id = 9102 WHERE tenant_id = 9101 AND wamid = 'p05-repair-A'",
    has_insert: false,
    has_update: false,
  },
];

async function seed_tenants(): Promise<void> {
  await pool.query(
    "INSERT INTO public.tenants (id, name) OVERRIDING SYSTEM VALUE VALUES (9101, 'p05-tenant-A'), (9102, 'p05-tenant-B')",
  );
  await pool.query(
    `INSERT INTO public.memberships (tenant_id, user_id, role) VALUES
     (9101, 'a0000000-0000-4000-8000-000000009101', 'viewer'),
     (9102, 'a0000000-0000-4000-8000-000000009102', 'viewer')`,
  );
  const resources = await pool.query(
    `INSERT INTO public.resources (id, tenant_id, name) OVERRIDING SYSTEM VALUE
     VALUES (9101, 9101, 'p05-res-A'), (9102, 9102, 'p05-res-B') RETURNING id, tenant_id`,
  );
  resource_ids = new Map(
    (resources.rows as { id: number; tenant_id: number }[]).map((row) => [row.tenant_id, row.id]),
  );
  await pool.query(
    `INSERT INTO public.services (tenant_id, name, duration_min) VALUES (9101, 'p05-svc-A', 30), (9102, 'p05-svc-B', 30)`,
  );
  await pool.query(
    `INSERT INTO public.appointments (tenant_id, customer_ref, status, starts_at, ends_at, idempotency_key) VALUES
     (9101, 'p05-appt-A', 'confirmed', '2026-11-01T09:00:00Z', '2026-11-01T09:30:00Z', 'p05-appt-A'),
     (9102, 'p05-appt-B', 'confirmed', '2026-11-01T09:00:00Z', '2026-11-01T09:30:00Z', 'p05-appt-B')`,
  );
  await pool.query(
    `INSERT INTO public.appointment_holds (tenant_id, resource_id, slot_start, slot_end, token, expires_at) VALUES
     (9101, $1, '2026-11-02T09:00:00Z', '2026-11-02T09:30:00Z', 'p05-hold-A', '2026-11-03T09:00:00Z'),
     (9102, $2, '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z', 'p05-hold-B', '2026-11-03T09:00:00Z')`,
    [resource_ids.get(9101), resource_ids.get(9102)],
  );
  await pool.query(
    `INSERT INTO public.outbox (tenant_id, aggregate_type, aggregate_id, event_type, payload, idempotency_key) VALUES
     (9101, 'appointment', 'p05-agg-A', 'created', '{}', 'p05-outbox-A'),
     (9102, 'appointment', 'p05-agg-B', 'created', '{}', 'p05-outbox-B')`,
  );
  await pool.query(
    `INSERT INTO public.audit_log (tenant_id, actor, action, entity_type, entity_id, diff) VALUES
     (9101, 'p05-actor', 'test_action', 'appointment', 'p05-audit-A', '{}'),
     (9102, 'p05-actor', 'test_action', 'appointment', 'p05-audit-B', '{}')`,
  );
  await pool.query(
    `INSERT INTO public.message_log (tenant_id, wa_message_id, direction, status) VALUES
     (9101, 'p05-msg-A', 'in', 'sent'), (9102, 'p05-msg-B', 'in', 'sent')`,
  );
  await pool.query(
    `INSERT INTO public.tenant_channels (tenant_id, channel, channel_account_id) VALUES
     (9101, 'whatsapp', 'p05-chan-A'), (9102, 'whatsapp', 'p05-chan-B')`,
  );
  await pool.query(
    `INSERT INTO public.inbound_messages (tenant_id, wamid, conversation_id, message_type, sender_ref, message_text, received_at) VALUES
     (9101, 'p05-wamid-A', 'p05-conv-A', 'text', 'p05-sender-A', 'hello A', now()),
     (9102, 'p05-wamid-B', 'p05-conv-B', 'text', 'p05-sender-B', 'hello B', now())`,
  );
  await pool.query(
    `INSERT INTO public.webhook_jobs (tenant_id, request_id, wamid, conversation_id, received_at_iso) VALUES
     (9101, 'p05-req-A', 'p05-wamid-A', 'p05-conv-A', now()),
     (9102, 'p05-req-B', 'p05-wamid-B', 'p05-conv-B', now())`,
  );
  await pool.query(
    `INSERT INTO public.processed_messages (tenant_id, wamid) VALUES (9101, 'p05-wamid-A'), (9102, 'p05-wamid-B')`,
  );
  await pool.query(
    `INSERT INTO public.reschedule_sessions (tenant_id, conversation_id, phase, expires_at) VALUES
     (9101, 'p05-conv-A', 'offered', now() + interval '1 hour'),
     (9102, 'p05-conv-B', 'offered', now() + interval '1 hour')`,
  );
  await pool.query(
    `INSERT INTO public.calendar_operations (tenant_id, operation_key, operation_type, request_fingerprint, result) VALUES
     (9101, 'p05-op-A', 'hold', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '{}'),
     (9102, 'p05-op-B', 'hold', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '{}')`,
  );
  await pool.query(
    `INSERT INTO public.tenant_rate_limits (tenant_id, scope, window_bucket, request_count, limit_count, window_seconds) VALUES
     (9101, 'webhook', 9101001, 1, 10, 60), (9102, 'webhook', 9102001, 1, 10, 60)`,
  );
  await pool.query(
    `INSERT INTO public.outbound_ledger (tenant_id, provider, operation_key, request_fingerprint, status) VALUES
     (9101, 'whatsapp', 'p05-op-A', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', 'pending'),
     (9102, 'whatsapp', 'p05-op-B', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'pending')`,
  );
  await pool.query(
    `INSERT INTO public.legal_holds (tenant_id, scope, reference, reason_code) VALUES
     (9101, 'inbound', 'p05-ref-A', 'legal_request'), (9102, 'inbound', 'p05-ref-B', 'legal_request')`,
  );
  await pool.query(
    `INSERT INTO public.operator_action_audit (tenant_id, actor_subject, action, target_type, target_id, outcome, request_id) VALUES
     (9101, 'p05-actor-A', 'export_audit', 'tenant', '9101', 'succeeded', 'p05-req-A'),
     (9102, 'p05-actor-B', 'export_audit', 'tenant', '9102', 'succeeded', 'p05-req-B')`,
  );
  await pool.query(
    `INSERT INTO public.ingress_repairs (tenant_id, wamid, action, actor, reason, resulting_state) VALUES
     (9101, 'p05-repair-A', 'quarantine', 'p05-actor-A', 'p05 repair reason ABCD', 'needs_repair'),
     (9102, 'p05-repair-B', 'quarantine', 'p05-actor-B', 'p05 repair reason EFGH', 'needs_repair')`,
  );
}
