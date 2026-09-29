import { describe, expect, it } from "vitest";
import { run_database_production_gate } from "../src/persistence/production_gate.js";
import type { SqlClient } from "../src/persistence/sql_client.js";

function fake_client(overrides: Partial<SqlClient> = {}): SqlClient {
  return {
    query: async (sql) => {
      if (sql.includes("to_regclass")) {
        if (sql.includes("processed_messages_pkey")) {
          return { rows: [{
            processed_pk: true,
            jobs_tenant_key: true,
            appointments_tenant_key: true,
            version_trigger: true,
            calendar_operations: true,
            ingress_repairs: true,
          }] };
        }
        return { rows: [{
          appointments: true,
          appointment_holds: true,
          calendar_operations: true,
          reschedule_sessions: true,
          inbound_messages: true,
          tenant_rate_limits: true,
          outbound_ledger: true,
          legal_holds: true,
          operator_action_audit: true,
          ingress_repairs: true,
        }] };
      }
      if (sql.includes("pg_catalog.pg_class")) {
        return { rows: [
          { relname: "appointments", relrowsecurity: true },
          { relname: "appointment_holds", relrowsecurity: true },
          { relname: "calendar_operations", relrowsecurity: true },
          { relname: "reschedule_sessions", relrowsecurity: true },
          { relname: "inbound_messages", relrowsecurity: true },
          { relname: "tenant_rate_limits", relrowsecurity: true },
          { relname: "outbound_ledger", relrowsecurity: true },
          { relname: "legal_holds", relrowsecurity: true },
          { relname: "operator_action_audit", relrowsecurity: true },
          { relname: "ingress_repairs", relrowsecurity: true },
        ] };
      }
      if (sql.includes("has_sequence_privilege")) {
        return { rows: [{
          service_reschedule_seq: true,
          service_repairs_seq: true,
          service_audit_seq: true,
          service_legal_seq: true,
          app_services_seq: true,
          app_repairs_seq: false,
        }] };
      }
      if (sql.includes("has_table_privilege")) {
        return { rows: [{
          anon_processed: false,
          authenticated_processed: false,
          anon_calendar: false,
          authenticated_calendar: false,
          anon_outbound: false,
          authenticated_outbound: false,
          anon_rate_limits: false,
          authenticated_rate_limits: false,
          anon_operator_audit: false,
          authenticated_operator_audit: false,
          service_outbound: true,
          service_legal_holds: true,
          authenticated_reschedule_read: true,
          authenticated_repairs_read: true,
          authenticated_processed_insert: false,
          authenticated_calendar_insert: false,
        }] };
      }
      if (sql.includes("statement_timeout")) {
        return { rows: [{ statement_timeout_s: 10, lock_timeout_s: 2, idle_timeout_s: 60 }] };
      }
      if (sql.includes("current_setting('ssl'")) return { rows: [{ ssl: "on" }] };
      return { rows: [] };
    },
    ...overrides,
  };
}

const evidence = { verified_at_iso: "2026-09-25T00:00:00.000Z", reference: "restore-drill-001" };

describe("database production gate", () => {
  it("passes only with schema, RLS, role, migration, sequence, TLS, timeout, and recovery evidence", async () => {
    const report = await run_database_production_gate(fake_client(), {
      backup_evidence: evidence,
      restore_evidence: evidence,
      connection_timeout_ms: 5_000,
      transaction_timeout_ms: 10_000,
      max_pool_size: 10,
    });
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual([
      "required-schema", "rls", "role-isolation", "migration-state", "sequence-privileges",
      "timeouts", "tls", "backup", "restore",
    ]);
  });

  it("fails closed when recovery evidence is absent", async () => {
    const report = await run_database_production_gate(fake_client());
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.name === "backup")?.passed).toBe(false);
  });

  it("fails closed on unsafe pool bounds and incomplete migration state", async () => {
    const unsafe_pool = await run_database_production_gate(fake_client(), {
      backup_evidence: evidence,
      restore_evidence: evidence,
      max_pool_size: 0,
    });
    expect(unsafe_pool.passed).toBe(false);
    expect(unsafe_pool.checks.find((check) => check.name === "timeouts")?.passed).toBe(false);

    const stale_migration = await run_database_production_gate(fake_client({
      query: async (sql) => {
        if (sql.includes("processed_messages_pkey")) {
          return { rows: [{
            processed_pk: true,
            jobs_tenant_key: false,
            appointments_tenant_key: true,
            version_trigger: true,
            calendar_operations: true,
            ingress_repairs: true,
          }] };
        }
        return fake_client().query(sql);
      },
    }), { backup_evidence: evidence, restore_evidence: evidence });
    expect(stale_migration.passed).toBe(false);
    expect(stale_migration.checks.find((check) => check.name === "migration-state")?.passed).toBe(false);
  });
});
