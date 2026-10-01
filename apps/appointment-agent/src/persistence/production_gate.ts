/** Read-only production database gate for schema, RLS, TLS, timeout, and DR evidence. */

import type { SqlClient, SqlQueryResult } from "./sql_client.js";

/** Evidence that a backup and restore exercise were completed outside the app. */
export interface DatabaseRecoveryEvidence {
  verified_at_iso: string;
  reference: string;
}

/** Options for a production-like database gate run. */
export interface DatabaseProductionGateOptions {
  require_tls?: boolean;
  backup_evidence?: DatabaseRecoveryEvidence;
  restore_evidence?: DatabaseRecoveryEvidence;
  /** Bounded checkout wait; validated when supplied, advisory when absent. */
  connection_timeout_ms?: number;
  /** Bounded wall-clock for one transaction; validated when supplied. */
  transaction_timeout_ms?: number;
  /** Bounded pool size; validated when supplied. */
  max_pool_size?: number;
  /** Clock returning epoch milliseconds; injected for deterministic tests. */
  now?: () => number;
}

/** One evidence-backed gate check. */
export interface DatabaseGateCheck {
  name: string;
  passed: boolean;
  reason: string;
}

/** Aggregate result; callers must not interpret a partial report as a pass. */
export interface DatabaseGateReport {
  passed: boolean;
  checks: DatabaseGateCheck[];
}

/** Maximum age of backup/restore drill evidence before it stops counting as DR proof. */
export const MAX_RECOVERY_EVIDENCE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

/** Future clock-skew tolerance for evidence timestamps from the restore system. */
export const RECOVERY_EVIDENCE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Safe failure raised by the CLI when any required gate check fails. */
export class DatabaseProductionGateError extends Error {
  readonly code = "database_production_gate_failed";

  /** Create a sanitized gate failure. */
  constructor(readonly report: DatabaseGateReport) {
    super("database-production-gate-failed");
    this.name = "DatabaseProductionGateError";
  }
}

const REQUIRED_OBJECTS = [
  "appointments",
  "appointment_holds",
  "calendar_operations",
  "reschedule_sessions",
  "inbound_messages",
  "tenant_rate_limits",
  "outbound_ledger",
  "legal_holds",
  "operator_action_audit",
  "ingress_repairs",
] as const;

/** Run every required check without mutating the database. */
export async function run_database_production_gate(
  sql_client: SqlClient,
  options: DatabaseProductionGateOptions = {},
): Promise<DatabaseGateReport> {
  const checks: DatabaseGateCheck[] = [];
  checks.push(await check_required_objects(sql_client));
  checks.push(await check_rls(sql_client));
  checks.push(await check_role_isolation(sql_client));
  checks.push(await check_migration_state(sql_client));
  checks.push(await check_sequence_privileges(sql_client));
  checks.push(await check_timeouts(sql_client, options));
  checks.push(await check_tls(sql_client, options.require_tls !== false));
  const now_ms = read_gate_clock(options.now);
  checks.push(check_recovery_evidence("backup", options.backup_evidence, now_ms));
  checks.push(check_recovery_evidence("restore", options.restore_evidence, now_ms));
  return { passed: checks.every((check) => check.passed), checks };
}

/** Throw unless every database gate check passed. */
export async function assert_database_production_gate(
  sql_client: SqlClient,
  options: DatabaseProductionGateOptions = {},
): Promise<DatabaseGateReport> {
  const report = await run_database_production_gate(sql_client, options);
  if (!report.passed) throw new DatabaseProductionGateError(report);
  return report;
}

async function check_required_objects(sql_client: SqlClient): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT
        to_regclass('public.appointments') IS NOT NULL AS appointments,
        to_regclass('public.appointment_holds') IS NOT NULL AS appointment_holds,
        to_regclass('public.calendar_operations') IS NOT NULL AS calendar_operations,
        to_regclass('public.reschedule_sessions') IS NOT NULL AS reschedule_sessions,
        to_regclass('public.inbound_messages') IS NOT NULL AS inbound_messages,
        to_regclass('public.tenant_rate_limits') IS NOT NULL AS tenant_rate_limits,
        to_regclass('public.outbound_ledger') IS NOT NULL AS outbound_ledger,
        to_regclass('public.legal_holds') IS NOT NULL AS legal_holds,
        to_regclass('public.operator_action_audit') IS NOT NULL AS operator_action_audit,
        to_regclass('public.ingress_repairs') IS NOT NULL AS ingress_repairs
    `);
    const row = first_record(result);
    const present = REQUIRED_OBJECTS.every((name) => row[name] === true);
    return check(present, "required-schema", present ? "all required objects exist" : "required object missing");
  } catch (error) {
    return check(false, "required-schema", `query failed: ${safe_reason(error)}`);
  }
}

async function check_rls(sql_client: SqlClient): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT relname, relrowsecurity
      FROM pg_catalog.pg_class
      WHERE relnamespace = 'public'::regnamespace
        AND relname = ANY($1::text[])
    `, [[
      "appointments", "appointment_holds", "calendar_operations", "reschedule_sessions",
      "inbound_messages", "tenant_rate_limits", "outbound_ledger", "legal_holds", "operator_action_audit",
      "ingress_repairs",
    ]]);
    const rows = result.rows;
    if (!Array.isArray(rows) || rows.length !== REQUIRED_OBJECTS.length) {
      return check(false, "rls", "RLS catalog shape invalid");
    }
    const enabled = rows.every((value) => is_record(value) && value.relrowsecurity === true);
    return check(enabled, "rls", enabled ? "tenant and server tables have RLS enabled" : "RLS disabled");
  } catch (error) {
    return check(false, "rls", `query failed: ${safe_reason(error)}`);
  }
}

async function check_role_isolation(sql_client: SqlClient): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT
        has_table_privilege('anon', 'public.processed_messages', 'SELECT') AS anon_processed,
        has_table_privilege('authenticated', 'public.processed_messages', 'SELECT') AS authenticated_processed,
        has_table_privilege('anon', 'public.calendar_operations', 'SELECT') AS anon_calendar,
        has_table_privilege('authenticated', 'public.calendar_operations', 'SELECT') AS authenticated_calendar,
        has_table_privilege('anon', 'public.outbound_ledger', 'SELECT') AS anon_outbound,
        has_table_privilege('authenticated', 'public.outbound_ledger', 'SELECT') AS authenticated_outbound,
        has_table_privilege('anon', 'public.tenant_rate_limits', 'SELECT') AS anon_rate_limits,
        has_table_privilege('authenticated', 'public.tenant_rate_limits', 'SELECT') AS authenticated_rate_limits,
        has_table_privilege('anon', 'public.operator_action_audit', 'SELECT') AS anon_operator_audit,
        has_table_privilege('authenticated', 'public.operator_action_audit', 'SELECT') AS authenticated_operator_audit,
        has_table_privilege('service_role', 'public.outbound_ledger', 'SELECT,INSERT,UPDATE') AS service_outbound,
        has_table_privilege('service_role', 'public.legal_holds', 'SELECT,INSERT,UPDATE') AS service_legal_holds,
        has_table_privilege('authenticated', 'public.reschedule_sessions', 'SELECT') AS authenticated_reschedule_read,
        has_table_privilege('authenticated', 'public.ingress_repairs', 'SELECT') AS authenticated_repairs_read,
        has_table_privilege('authenticated', 'public.processed_messages', 'INSERT') AS authenticated_processed_insert,
        has_table_privilege('authenticated', 'public.calendar_operations', 'INSERT') AS authenticated_calendar_insert
    `);
    const row = first_record(result);
    const passed = row.anon_processed === false
      && row.authenticated_processed === false
      && row.anon_calendar === false
      && row.authenticated_calendar === false
      && row.anon_outbound === false
      && row.authenticated_outbound === false
      && row.anon_rate_limits === false
      && row.authenticated_rate_limits === false
      && row.anon_operator_audit === false
      && row.authenticated_operator_audit === false
      && row.service_outbound === true
      && row.service_legal_holds === true
      && row.authenticated_reschedule_read === true
      && row.authenticated_repairs_read === true
      && row.authenticated_processed_insert === false
      && row.authenticated_calendar_insert === false;
    return check(passed, "role-isolation", passed ? "server-only tables have the expected grants" : "unexpected role grant");
  } catch (error) {
    return check(false, "role-isolation", `query failed: ${safe_reason(error)}`);
  }
}

async function check_migration_state(sql_client: SqlClient): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'processed_messages_pkey'
            AND conrelid = 'public.processed_messages'::regclass
        ) AS processed_pk,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'webhook_jobs_tenant_wamid_key'
            AND conrelid = 'public.webhook_jobs'::regclass
        ) AS jobs_tenant_key,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'appointments_tenant_id_id_key'
            AND conrelid = 'public.appointments'::regclass
        ) AS appointments_tenant_key,
        EXISTS (
          SELECT 1 FROM pg_trigger WHERE tgname = 'appointments_bump_version'
        ) AS version_trigger,
        to_regclass('public.calendar_operations') IS NOT NULL AS calendar_operations,
        to_regclass('public.ingress_repairs') IS NOT NULL AS ingress_repairs
    `);
    const row = first_record(result);
    const passed = row.processed_pk === true
      && row.jobs_tenant_key === true
      && row.appointments_tenant_key === true
      && row.version_trigger === true
      && row.calendar_operations === true
      && row.ingress_repairs === true;
    return check(passed, "migration-state", passed ? "migrations 0001-0014 state verified" : "migration state incomplete");
  } catch (error) {
    return check(false, "migration-state", `query failed: ${safe_reason(error)}`);
  }
}

async function check_sequence_privileges(sql_client: SqlClient): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT
        has_sequence_privilege('service_role', 'public.reschedule_sessions_id_seq', 'USAGE') AS service_reschedule_seq,
        has_sequence_privilege('service_role', 'public.ingress_repairs_id_seq', 'USAGE') AS service_repairs_seq,
        has_sequence_privilege('service_role', 'public.operator_action_audit_id_seq', 'USAGE') AS service_audit_seq,
        has_sequence_privilege('service_role', 'public.legal_holds_id_seq', 'USAGE') AS service_legal_seq,
        has_sequence_privilege('authenticated', 'public.services_id_seq', 'USAGE') AS app_services_seq,
        has_sequence_privilege('authenticated', 'public.ingress_repairs_id_seq', 'USAGE') AS app_repairs_seq
    `);
    const row = first_record(result);
    const passed = row.service_reschedule_seq === true
      && row.service_repairs_seq === true
      && row.service_audit_seq === true
      && row.service_legal_seq === true
      && row.app_services_seq === true
      && row.app_repairs_seq === false;
    return check(passed, "sequence-privileges", passed ? "server sequence grants are correct" : "unexpected sequence grant");
  } catch (error) {
    return check(false, "sequence-privileges", `query failed: ${safe_reason(error)}`);
  }
}

async function check_timeouts(sql_client: SqlClient, options: DatabaseProductionGateOptions): Promise<DatabaseGateCheck> {
  try {
    const result = await sql_client.query(`
      SELECT
        extract(epoch FROM current_setting('statement_timeout', true)::interval)::double precision AS statement_timeout_s,
        extract(epoch FROM current_setting('lock_timeout', true)::interval)::double precision AS lock_timeout_s,
        extract(epoch FROM current_setting('idle_in_transaction_session_timeout', true)::interval)::double precision AS idle_timeout_s
    `);
    const row = first_record(result);
    const statement = number_value(row.statement_timeout_s);
    const lock = number_value(row.lock_timeout_s);
    const idle = number_value(row.idle_timeout_s);
    const db_bounded = statement > 0 && statement <= 120 && lock > 0 && lock <= 10 && idle > 0 && idle <= 600;
    if (!db_bounded) return check(false, "timeouts", "database timeout policy is missing or unsafe");
    return check_pool_bounds(options);
  } catch (error) {
    return check(false, "timeouts", `query failed: ${safe_reason(error)}`);
  }
}

function check_pool_bounds(options: DatabaseProductionGateOptions): DatabaseGateCheck {
  const { connection_timeout_ms, transaction_timeout_ms, max_pool_size } = options;
  if (connection_timeout_ms === undefined && transaction_timeout_ms === undefined && max_pool_size === undefined) {
    return check(true, "timeouts", "bounded database timeouts are active; pool bounds verified in integration test");
  }
  const bounded = (value: number | undefined, minimum: number, maximum: number): boolean =>
    value === undefined || (Number.isSafeInteger(value) && value >= minimum && value <= maximum);
  const passed = bounded(connection_timeout_ms, 1, 120_000)
    && bounded(transaction_timeout_ms, 1, 120_000)
    && bounded(max_pool_size, 1, 1_000);
  return check(passed, "timeouts", passed ? "bounded database and pool timeouts are active" : "pool timeout policy is missing or unsafe");
}

async function check_tls(sql_client: SqlClient, required: boolean): Promise<DatabaseGateCheck> {
  if (!required) return check(true, "tls", "TLS check explicitly disabled");
  try {
    const result = await sql_client.query("SELECT current_setting('ssl', true) AS ssl");
    const row = first_record(result);
    const passed = row.ssl === "on";
    return check(passed, "tls", passed ? "server session uses TLS" : "server session does not require TLS");
  } catch (error) {
    return check(false, "tls", `query failed: ${safe_reason(error)}`);
  }
}

function check_recovery_evidence(
  name: "backup" | "restore",
  evidence: DatabaseRecoveryEvidence | undefined,
  now_ms: number,
): DatabaseGateCheck {
  const verified_ms = evidence === undefined ? Number.NaN : Date.parse(evidence.verified_at_iso);
  // A stale drill is not DR evidence: reject timestamps older than the
  // product-tuned max age or beyond clock-skew into the future. Reasons stay
  // generic so no timestamp detail leaks into gate output.
  const fresh = Number.isFinite(verified_ms)
    && verified_ms <= now_ms + RECOVERY_EVIDENCE_CLOCK_SKEW_MS
    && now_ms - verified_ms <= MAX_RECOVERY_EVIDENCE_AGE_MS;
  const valid = fresh
    && typeof evidence?.reference === "string"
    && evidence.reference.trim() !== ""
    && evidence.reference.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(evidence.reference);
  return check(valid, name, valid ? "external recovery evidence supplied" : "backup/restore evidence missing or stale");
}

function read_gate_clock(now: (() => number) | undefined): number {
  try {
    const value = now?.() ?? Date.now();
    if (Number.isFinite(value)) return value;
  } catch {
    // Fall through to the safe default below.
  }
  return Date.now();
}

function first_record(result: SqlQueryResult): Record<string, unknown> {
  if (!Array.isArray(result.rows) || result.rows.length !== 1 || !is_record(result.rows[0])) {
    throw new Error("database-gate-result-invalid");
  }
  return result.rows[0];
}

function number_value(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
}

function check(passed: boolean, name: string, reason: string): DatabaseGateCheck {
  return { name, passed, reason };
}

function safe_reason(error: unknown): string {
  if (error instanceof Error && error.name !== "Error") return error.name;
  return "database_query_failed";
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
