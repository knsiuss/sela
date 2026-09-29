/** Storage adapters for tenant erasure with legal-hold enforcement. */

import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import type {
  TenantDataCounts,
  TenantErasureDeletedCounts,
  TenantErasureStore,
  TenantExportSnapshot,
  TenantHoldSummary,
} from "./tenant_erasure.js";
import { TenantErasureBlockedError } from "./tenant_erasure.js";

/** Seeded per-tenant content for deterministic erasure tests. */
export interface SeededTenantData {
  inbound_messages?: number;
  reschedule_sessions?: number;
  jobs_active?: number;
  jobs_terminal?: number;
  outbound_records?: number;
  dedupe_claims?: number;
  audit_records?: number;
  rate_limit_buckets?: number;
}

/** In-memory erasure adapter with the same hold semantics as Postgres. */
export class InMemoryTenantErasureStore implements TenantErasureStore {
  private readonly tenants = new Map<string, TenantDataCounts>();
  private readonly holds: Array<{ tenant_id: string; scope: string; reference: string; reason_code: string }> = [];

  /** Seed opaque per-tenant counts without exposing content. */
  seed_tenant(tenant_id: string, counts: SeededTenantData): void {
    require_tenant_id(tenant_id);
    this.tenants.set(tenant_id, {
      inbound_messages: counts.inbound_messages ?? 0,
      reschedule_sessions: counts.reschedule_sessions ?? 0,
      jobs_active: counts.jobs_active ?? 0,
      jobs_terminal: counts.jobs_terminal ?? 0,
      outbound_records: counts.outbound_records ?? 0,
      dedupe_claims: counts.dedupe_claims ?? 0,
      audit_records: counts.audit_records ?? 0,
      rate_limit_buckets: counts.rate_limit_buckets ?? 0,
    });
  }

  /** Add an active hold for deterministic hold-suppression tests. */
  set_hold(tenant_id: string, scope: string, reference: string, reason_code = "legal_request"): void {
    require_tenant_id(tenant_id);
    if (scope.trim() === "" || reference.trim() === "" || !/^[a-z0-9_]{1,64}$/.test(reason_code)) {
      throw new TypeError("tenant-erasure-hold-invalid");
    }
    this.holds.push({ tenant_id, scope, reference, reason_code });
  }

  /** Read current counts for assertions. */
  tenant_counts(tenant_id: string): TenantDataCounts | null {
    const counts = this.tenants.get(require_tenant_id(tenant_id));
    return counts === undefined ? null : { ...counts };
  }

  /** Read a hold-aware export snapshot for one tenant. */
  async read_export_snapshot(tenant_id: string): Promise<TenantExportSnapshot> {
    const tenant = require_tenant_id(tenant_id);
    const counts = this.tenants.get(tenant) ?? zero_counts();
    return {
      counts: { ...counts },
      active_legal_holds: this.holds
        .filter((hold) => hold.tenant_id === tenant)
        .map((hold) => ({ scope: hold.scope, reference: hold.reference, reason_code: hold.reason_code })),
    };
  }

  /** Delete content while preserving terminal and evidence rows. */
  async quarantine_tenant(tenant_id: string, limit: number): Promise<TenantErasureDeletedCounts> {
    const tenant = require_tenant_id(tenant_id);
    require_limit(limit);
    this.require_no_hold(tenant, "tenant");
    const counts = this.tenants.get(tenant) ?? zero_counts();
    const deleted = {
      inbound_messages: Math.min(counts.inbound_messages, limit),
      reschedule_sessions: Math.min(counts.reschedule_sessions, limit),
      jobs: Math.min(counts.jobs_active, limit),
      rate_limit_buckets: Math.min(counts.rate_limit_buckets, limit),
      outbound_records: 0,
      dedupe_claims: 0,
      audit_records: 0,
    };
    this.tenants.set(tenant, {
      ...counts,
      inbound_messages: counts.inbound_messages - deleted.inbound_messages,
      reschedule_sessions: counts.reschedule_sessions - deleted.reschedule_sessions,
      jobs_active: counts.jobs_active - deleted.jobs,
      rate_limit_buckets: counts.rate_limit_buckets - deleted.rate_limit_buckets,
    });
    return deleted;
  }

  /** Remove the tenant entry with all of its content and evidence. */
  async cascade_delete_tenant(tenant_id: string): Promise<{ jobs_deleted: number; tenant_removed: boolean }> {
    const tenant = require_tenant_id(tenant_id);
    this.require_no_hold(tenant, "tenant");
    if (this.has_hold(tenant, "audit")) throw new TenantErasureBlockedError("legal-hold-audit");
    const counts = this.tenants.get(tenant);
    const jobs_deleted = (counts?.jobs_active ?? 0) + (counts?.jobs_terminal ?? 0);
    const tenant_removed = this.tenants.delete(tenant);
    return { jobs_deleted, tenant_removed };
  }

  private require_no_hold(tenant_id: string, scope: string): void {
    if (this.has_hold(tenant_id, scope)) throw new TenantErasureBlockedError("legal-hold-tenant");
  }

  private has_hold(tenant_id: string, scope: string): boolean {
    return this.holds.some((hold) => hold.tenant_id === tenant_id && (hold.scope === scope || hold.scope === "tenant"));
  }
}

const ERASE_HOLD_CHECK_SQL = `
  SELECT 1 FROM public.legal_holds
  WHERE tenant_id = $1 AND scope = $2 AND is_active
  LIMIT 1
`;

const EXPORT_COUNTS_SQL = `
  SELECT
    (SELECT count(*) FROM public.inbound_messages WHERE tenant_id = $1) AS inbound_messages,
    (SELECT count(*) FROM public.reschedule_sessions WHERE tenant_id = $1) AS reschedule_sessions,
    (SELECT count(*) FROM public.webhook_jobs WHERE tenant_id = $1 AND status IN ('pending', 'claimed')) AS jobs_active,
    (SELECT count(*) FROM public.webhook_jobs WHERE tenant_id = $1 AND status IN ('completed', 'failed')) AS jobs_terminal,
    (SELECT count(*) FROM public.outbound_ledger WHERE tenant_id = $1) AS outbound_records,
    (SELECT count(*) FROM public.processed_messages WHERE tenant_id = $1) AS dedupe_claims,
    ((SELECT count(*) FROM public.audit_log WHERE tenant_id = $1)
      + (SELECT count(*) FROM public.operator_action_audit WHERE tenant_id = $1)
      + (SELECT count(*) FROM public.ingress_repairs WHERE tenant_id = $1)) AS audit_records,
    (SELECT count(*) FROM public.tenant_rate_limits WHERE tenant_id = $1) AS rate_limit_buckets
`;

const EXPORT_HOLDS_SQL = `
  SELECT scope, reference, reason_code
  FROM public.legal_holds
  WHERE tenant_id = $1 AND is_active
  ORDER BY scope, reference
  LIMIT 100
`;

const QUARANTINE_INBOUND_SQL = `
  DELETE FROM public.inbound_messages
  WHERE id IN (SELECT id FROM public.inbound_messages WHERE tenant_id = $1 ORDER BY id LIMIT $2)
  RETURNING id
`;

const QUARANTINE_SESSIONS_SQL = `
  DELETE FROM public.reschedule_sessions
  WHERE id IN (SELECT id FROM public.reschedule_sessions WHERE tenant_id = $1 ORDER BY id LIMIT $2)
  RETURNING id
`;

const QUARANTINE_JOBS_SQL = `
  DELETE FROM public.webhook_jobs
  WHERE id IN (
    SELECT id FROM public.webhook_jobs
    WHERE tenant_id = $1 AND status IN ('pending', 'claimed')
    ORDER BY id LIMIT $2
  )
  RETURNING id
`;

const QUARANTINE_BUCKETS_SQL = `
  DELETE FROM public.tenant_rate_limits
  WHERE ctid IN (SELECT ctid FROM public.tenant_rate_limits WHERE tenant_id = $1 LIMIT $2)
  RETURNING tenant_id
`;

const CASCADE_JOBS_SQL = `
  DELETE FROM public.webhook_jobs WHERE tenant_id = $1 RETURNING id
`;

const CASCADE_TENANT_SQL = `
  DELETE FROM public.tenants WHERE id = $1 RETURNING id
`;

/** Server-side erasure adapter; every delete is bounded and hold-aware. */
export class PostgresTenantErasureStore implements TenantErasureStore {
  private readonly sql_client: SqlClient;

  /** Create the erasure adapter. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /** Read counts and active holds backing one customer data export. */
  async read_export_snapshot(tenant_id: string): Promise<TenantExportSnapshot> {
    const tenant = require_tenant_id(tenant_id);
    const counts_result = await this.sql_client.query(EXPORT_COUNTS_SQL, [tenant]);
    const holds_result = await this.sql_client.query(EXPORT_HOLDS_SQL, [tenant]);
    return { counts: parse_counts(counts_result), active_legal_holds: parse_holds(holds_result) };
  }

  /**
   * Delete tenant content while preserving terminal and evidence rows.
   *
   * A tenant-scoped hold blocks quarantine; the tenant row and all evidence
   * stay in place by design.
   */
  async quarantine_tenant(tenant_id: string, limit: number): Promise<TenantErasureDeletedCounts> {
    const tenant = require_tenant_id(tenant_id);
    const bounded = require_limit(limit);
    await this.require_no_hold(tenant, "tenant");
    const inbound = await this.sql_client.query(QUARANTINE_INBOUND_SQL, [tenant, bounded]);
    const sessions = await this.sql_client.query(QUARANTINE_SESSIONS_SQL, [tenant, bounded]);
    const jobs = await this.sql_client.query(QUARANTINE_JOBS_SQL, [tenant, bounded]);
    const buckets = await this.sql_client.query(QUARANTINE_BUCKETS_SQL, [tenant, bounded]);
    return {
      inbound_messages: count_rows(inbound),
      reschedule_sessions: count_rows(sessions),
      jobs: count_rows(jobs),
      rate_limit_buckets: count_rows(buckets),
      outbound_records: 0,
      dedupe_claims: 0,
      audit_records: 0,
    };
  }

  /**
   * Remove the tenant row after deleting non-cascading job rows.
   *
   * Remaining evidence follows through foreign-key cascades. A tenant hold
   * blocks cascade, and an audit hold blocks it too because audit evidence
   * would leave with the tenant row.
   */
  async cascade_delete_tenant(tenant_id: string): Promise<{ jobs_deleted: number; tenant_removed: boolean }> {
    const tenant = require_tenant_id(tenant_id);
    await this.require_no_hold(tenant, "tenant");
    if (await this.has_hold(tenant, "audit")) throw new TenantErasureBlockedError("legal-hold-audit");
    const jobs = await this.sql_client.query(CASCADE_JOBS_SQL, [tenant]);
    const removed = await this.sql_client.query(CASCADE_TENANT_SQL, [tenant]);
    return { jobs_deleted: count_rows(jobs), tenant_removed: count_rows(removed) > 0 };
  }

  private async require_no_hold(tenant_id: string, scope: string): Promise<void> {
    if (await this.has_hold(tenant_id, scope)) throw new TenantErasureBlockedError("legal-hold-tenant");
  }

  private async has_hold(tenant_id: string, scope: string): Promise<boolean> {
    const result = await this.sql_client.query(ERASE_HOLD_CHECK_SQL, [tenant_id, scope]);
    if (Array.isArray(result.rows)) return result.rows.length > 0;
    if (typeof result.rowCount === "number") return result.rowCount > 0;
    throw new Error("tenant-erasure-hold-invalid");
  }
}

function zero_counts(): TenantDataCounts {
  return {
    inbound_messages: 0,
    reschedule_sessions: 0,
    jobs_active: 0,
    jobs_terminal: 0,
    outbound_records: 0,
    dedupe_claims: 0,
    audit_records: 0,
    rate_limit_buckets: 0,
  };
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new TypeError("tenant-erasure-tenant-invalid");
  }
  return value;
}

function require_limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError("tenant-erasure-limit-invalid");
  return value;
}

function parse_counts(result: SqlQueryResult): TenantDataCounts {
  const row = Array.isArray(result.rows) && result.rows.length > 0 ? result.rows[0] : undefined;
  if (typeof row !== "object" || row === null) throw new Error("tenant-export-invalid");
  const record = row as Record<string, unknown>;
  return {
    inbound_messages: parse_count(record["inbound_messages"]),
    reschedule_sessions: parse_count(record["reschedule_sessions"]),
    jobs_active: parse_count(record["jobs_active"]),
    jobs_terminal: parse_count(record["jobs_terminal"]),
    outbound_records: parse_count(record["outbound_records"]),
    dedupe_claims: parse_count(record["dedupe_claims"]),
    audit_records: parse_count(record["audit_records"]),
    rate_limit_buckets: parse_count(record["rate_limit_buckets"]),
  };
}

function parse_holds(result: SqlQueryResult): TenantHoldSummary[] {
  if (!Array.isArray(result.rows)) throw new Error("tenant-export-invalid");
  return result.rows.map((row) => {
    if (typeof row !== "object" || row === null) throw new Error("tenant-export-invalid");
    const record = row as Record<string, unknown>;
    const scope = record["scope"];
    const reference = record["reference"];
    const reason_code = record["reason_code"];
    if (typeof scope !== "string" || typeof reference !== "string" || typeof reason_code !== "string") {
      throw new Error("tenant-export-invalid");
    }
    return { scope, reference, reason_code };
  });
}

function parse_count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("tenant-export-invalid");
  return parsed;
}

function count_rows(result: SqlQueryResult): number {
  if (Array.isArray(result.rows)) return result.rows.length;
  if (typeof result.rowCount === "number") return result.rowCount;
  throw new Error("tenant-erasure-result-invalid");
}
