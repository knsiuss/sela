/** Tenant deletion, customer data export, and cache eviction boundaries. */

import type { MetricsSink } from "../observability/metrics.js";
import {
  DEFAULT_DATA_RETENTION_POLICY,
  retention_policy_statement,
  type DataRetentionPolicy,
} from "./retention_policy.js";

/**
 * Erasure semantics.
 *
 * Quarantine halts the tenant and deletes content while preserving terminal
 * idempotency claims, terminal jobs, delivery evidence, and audit rows. Cascade
 * removes the tenant row so foreign keys take the remaining evidence with it.
 */
export type TenantErasureMode = "quarantine" | "cascade";

/** Per-category row counts for one tenant. */
export interface TenantDataCounts {
  inbound_messages: number;
  reschedule_sessions: number;
  jobs_active: number;
  jobs_terminal: number;
  outbound_records: number;
  dedupe_claims: number;
  audit_records: number;
  rate_limit_buckets: number;
}

/** One active legal hold affecting the tenant. */
export interface TenantHoldSummary {
  scope: string;
  reference: string;
  reason_code: string;
}

/** Customer data export: counts and metadata only, never content or PII. */
export interface TenantDataExport {
  tenant_id: string;
  exported_at_iso: string;
  retention_policy_statement: string[];
  counts: TenantDataCounts;
  active_legal_holds: TenantHoldSummary[];
  note: string;
}

/** Rows removed by one erasure pass. */
export interface TenantErasureDeletion {
  mode: TenantErasureMode;
  tenant_removed: boolean;
  deleted: TenantErasureDeletedCounts;
  preserved: TenantErasurePreservedCounts;
}

/** Explicitly removed rows per category. */
export interface TenantErasureDeletedCounts {
  inbound_messages: number;
  reschedule_sessions: number;
  jobs: number;
  rate_limit_buckets: number;
  outbound_records: number;
  dedupe_claims: number;
  audit_records: number;
}

/** Evidence intentionally retained by quarantine semantics. */
export interface TenantErasurePreservedCounts {
  dedupe_claims: number;
  terminal_jobs: number;
  outbound_records: number;
  audit_records: number;
}

/** Storage port for tenant erasure; implementations enforce legal holds. */
export interface TenantErasureStore {
  read_export_snapshot(tenant_id: string): Promise<TenantExportSnapshot>;
  quarantine_tenant(tenant_id: string, limit: number): Promise<TenantErasureDeletedCounts>;
  cascade_delete_tenant(tenant_id: string): Promise<{ jobs_deleted: number; tenant_removed: boolean }>;
}

/** Snapshot backing one customer data export. */
export interface TenantExportSnapshot {
  counts: TenantDataCounts;
  active_legal_holds: TenantHoldSummary[];
}

/** Cache, session, or registry boundary holding tenant state. */
export interface TenantCacheEvictor {
  evict_tenant(tenant_id: string): Promise<void>;
}

/** Audit sink for erasure attempts; reason codes only, never free text. */
export interface ErasureAuditSink {
  record_erasure(input: {
    tenant_id: string;
    mode: TenantErasureMode;
    outcome: "completed" | "blocked" | "failed";
    reason_code: string;
    request_id: string;
    actor_subject: string;
  }): Promise<void>;
}

/** Options for one tenant erasure pass. */
export interface EraseTenantOptions {
  mode: TenantErasureMode;
  limit?: number;
  evictors?: TenantCacheEvictor[];
  audit?: ErasureAuditSink;
  actor_subject?: string;
  request_id?: string;
  metrics?: MetricsSink;
  events?: (event: TenantErasureEvent) => void;
  clock?: () => Date;
  retention_policy?: DataRetentionPolicy;
}

/** PII-free structured event emitted once per erasure pass. */
export interface TenantErasureEvent {
  event: "tenant_erasure";
  mode: TenantErasureMode;
  outcome: "completed" | "blocked" | "failed";
  tenant_id: string;
  tenant_removed: boolean;
  evicted_caches: number;
  duration_ms: number;
  error_code?: string;
}

/** Result of one completed erasure pass with its export evidence. */
export interface TenantErasure {
  export: TenantDataExport;
  deletion: TenantErasureDeletion;
  evicted_caches: number;
  duration_ms: number;
}

/** Raised when a legal hold suppresses deletion for the held scope. */
export class TenantErasureBlockedError extends Error {
  readonly reason: "legal-hold-tenant" | "legal-hold-audit";

  /** Create a hold-suppressed erasure failure. */
  constructor(reason: "legal-hold-tenant" | "legal-hold-audit") {
    super(`tenant-erasure-blocked: ${reason}`);
    this.name = "TenantErasureBlockedError";
    this.reason = reason;
  }
}

/** Raised when eviction or audit leaves erasure without full evidence. */
export class TenantErasureError extends Error {
  /** Create a safe erasure failure. */
  constructor(reason = "tenant-erasure-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "TenantErasureError";
  }
}

const EXPORT_NOTE = "Counts and metadata only; message content and PII are never included. "
  + "Full-content subject export requires a separately audited DSR path.";

/**
 * Erase one tenant with hold enforcement, export evidence, and cache eviction.
 *
 * Destructive use must be authorized before calling (operator RBAC with MFA);
 * this service guarantees the hold, export, eviction, and audit ordering.
 */
export async function erase_tenant(
  store: TenantErasureStore,
  tenant_id: string,
  options: EraseTenantOptions,
): Promise<TenantErasure> {
  const normalized = normalize_erase_options(options);
  const tenant = require_tenant_id(tenant_id);
  const started_at = normalized.clock().getTime();
  try {
    const snapshot = await store.read_export_snapshot(tenant);
    const deletion = await delete_for_mode(store, tenant, normalized);
    const evicted_caches = await evict_tenant_caches(normalized.evictors, tenant);
    await record_erasure_audit(normalized, tenant, "completed", completed_reason_code(normalized.mode));
    const result = {
      export: build_tenant_export(tenant, snapshot, normalized),
      deletion,
      evicted_caches,
      duration_ms: Math.max(0, normalized.clock().getTime() - started_at),
    };
    emit_erasure_event(normalized, tenant, "completed", deletion.tenant_removed, evicted_caches, result.duration_ms);
    return result;
  } catch (error) {
    await on_erase_failure(normalized, tenant, started_at, error);
    throw error;
  }
}

/**
 * Run every tenant cache evictor and report how many succeeded.
 *
 * All evictors run even when one fails so no cache is silently skipped; any
 * failure throws loudly because stale caches resurrect deleted tenant data.
 */
export async function evict_tenant_caches(
  evictors: TenantCacheEvictor[],
  tenant_id: string,
): Promise<number> {
  const tenant = require_tenant_id(tenant_id);
  let evicted = 0;
  const failures: unknown[] = [];
  for (const evictor of evictors) {
    try {
      await evictor.evict_tenant(tenant);
      evicted += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new TenantErasureError("tenant-erasure-eviction-failed", failures[0]);
  return evicted;
}

/**
 * Build a customer data export from a snapshot without content or PII.
 *
 * Only counts, hold metadata, and the quotable retention statement leave this
 * boundary, so the export is safe to store as erasure evidence.
 */
export function build_tenant_export(
  tenant_id: string,
  snapshot: TenantExportSnapshot,
  options: { clock?: () => Date; retention_policy?: DataRetentionPolicy } = {},
): TenantDataExport {
  const tenant = require_tenant_id(tenant_id);
  if (typeof snapshot !== "object" || snapshot === null) throw new TypeError("tenant-export-snapshot-invalid");
  return {
    tenant_id: tenant,
    exported_at_iso: (options.clock ?? (() => new Date()))().toISOString(),
    retention_policy_statement: retention_policy_statement(
      options.retention_policy ?? DEFAULT_DATA_RETENTION_POLICY,
    ),
    counts: { ...snapshot.counts },
    active_legal_holds: snapshot.active_legal_holds.map((hold) => ({ ...hold })),
    note: EXPORT_NOTE,
  };
}

async function delete_for_mode(
  store: TenantErasureStore,
  tenant_id: string,
  options: NormalizedEraseOptions,
): Promise<TenantErasureDeletion> {
  if (options.mode === "quarantine") {
    const deleted = await store.quarantine_tenant(tenant_id, options.limit);
    const snapshot = await store.read_export_snapshot(tenant_id);
    return {
      mode: "quarantine",
      tenant_removed: false,
      deleted,
      preserved: {
        dedupe_claims: snapshot.counts.dedupe_claims,
        terminal_jobs: snapshot.counts.jobs_terminal,
        outbound_records: snapshot.counts.outbound_records,
        audit_records: snapshot.counts.audit_records,
      },
    };
  }
  const snapshot = await store.read_export_snapshot(tenant_id);
  const cascade = await store.cascade_delete_tenant(tenant_id);
  return {
    mode: "cascade",
    tenant_removed: cascade.tenant_removed,
    deleted: {
      inbound_messages: snapshot.counts.inbound_messages,
      reschedule_sessions: snapshot.counts.reschedule_sessions,
      jobs: snapshot.counts.jobs_active + snapshot.counts.jobs_terminal,
      rate_limit_buckets: snapshot.counts.rate_limit_buckets,
      outbound_records: snapshot.counts.outbound_records,
      dedupe_claims: snapshot.counts.dedupe_claims,
      audit_records: snapshot.counts.audit_records,
    },
    preserved: { dedupe_claims: 0, terminal_jobs: 0, outbound_records: 0, audit_records: 0 },
  };
}

async function on_erase_failure(
  options: NormalizedEraseOptions,
  tenant_id: string,
  started_at: number,
  error: unknown,
): Promise<void> {
  const duration_ms = Math.max(0, options.clock().getTime() - started_at);
  const blocked = error instanceof TenantErasureBlockedError;
  if (options.audit !== undefined) {
    try {
      await options.audit.record_erasure({
        tenant_id,
        mode: options.mode,
        outcome: blocked ? "blocked" : "failed",
        reason_code: blocked ? error.reason.replace(/-/g, "_") : safe_error_code(error),
        request_id: options.request_id,
        actor_subject: options.actor_subject,
      });
    } catch (audit_error) {
      throw new TenantErasureError("tenant-erasure-audit-failed", audit_error);
    }
  }
  options.metrics?.increment("tenant_erasure_runs_total", { mode: options.mode, outcome: blocked ? "blocked" : "failed" });
  emit_erasure_event(options, tenant_id, blocked ? "blocked" : "failed", false, 0, duration_ms, error);
  if (!blocked && !(error instanceof TenantErasureError)) throw new TenantErasureError("tenant-erasure-failed", error);
}

async function record_erasure_audit(
  options: NormalizedEraseOptions,
  tenant_id: string,
  outcome: "completed",
  reason_code: string,
): Promise<void> {
  if (options.audit === undefined) return;
  try {
    await options.audit.record_erasure({
      tenant_id,
      mode: options.mode,
      outcome,
      reason_code,
      request_id: options.request_id,
      actor_subject: options.actor_subject,
    });
  } catch (error) {
    throw new TenantErasureError("tenant-erasure-audit-failed", error);
  }
  options.metrics?.increment("tenant_erasure_runs_total", { mode: options.mode, outcome });
}

function emit_erasure_event(
  options: NormalizedEraseOptions,
  tenant_id: string,
  outcome: TenantErasureEvent["outcome"],
  tenant_removed: boolean,
  evicted_caches: number,
  duration_ms: number,
  error?: unknown,
): void {
  options.events?.({
    event: "tenant_erasure",
    mode: options.mode,
    outcome,
    tenant_id,
    tenant_removed,
    evicted_caches,
    duration_ms,
    ...(error === undefined ? {} : { error_code: error instanceof TenantErasureBlockedError ? error.reason : safe_error_code(error) }),
  });
}

interface NormalizedEraseOptions {
  mode: TenantErasureMode;
  limit: number;
  evictors: TenantCacheEvictor[];
  audit?: ErasureAuditSink;
  actor_subject: string;
  request_id: string;
  metrics?: MetricsSink;
  events?: (event: TenantErasureEvent) => void;
  clock: () => Date;
  retention_policy: DataRetentionPolicy;
}

function normalize_erase_options(options: EraseTenantOptions): NormalizedEraseOptions {
  if (typeof options !== "object" || options === null) throw new TypeError("tenant-erasure-options-invalid");
  if (options.mode !== "quarantine" && options.mode !== "cascade") throw new TypeError("tenant-erasure-mode-invalid");
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new TypeError("tenant-erasure-limit-invalid");
  if (options.evictors !== undefined && !Array.isArray(options.evictors)) {
    throw new TypeError("tenant-erasure-evictors-invalid");
  }
  if (options.audit !== undefined) {
    if (typeof options.audit.record_erasure !== "function") throw new TypeError("tenant-erasure-audit-invalid");
    if (typeof options.actor_subject !== "string" || options.actor_subject.trim() === "") {
      throw new TypeError("tenant-erasure-actor-invalid");
    }
    if (typeof options.request_id !== "string" || options.request_id.trim() === "") {
      throw new TypeError("tenant-erasure-request-invalid");
    }
  }
  return {
    mode: options.mode,
    limit,
    evictors: options.evictors ?? [],
    audit: options.audit,
    actor_subject: options.actor_subject ?? "unrecorded",
    request_id: options.request_id ?? "unrecorded",
    metrics: options.metrics,
    events: options.events,
    clock: options.clock ?? (() => new Date()),
    retention_policy: options.retention_policy ?? DEFAULT_DATA_RETENTION_POLICY,
  };
}

function require_tenant_id(value: string): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) {
    throw new TypeError("tenant-erasure-tenant-invalid");
  }
  return value;
}

function completed_reason_code(mode: TenantErasureMode): string {
  return mode === "quarantine" ? "tenant_erasure_quarantined" : "tenant_erasure_cascade_deleted";
}

function safe_error_code(error: unknown): string {
  if (error instanceof Error && error.name !== "Error") {
    return error.name.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 64) || "tenant_erasure_failed";
  }
  return "tenant_erasure_failed";
}
