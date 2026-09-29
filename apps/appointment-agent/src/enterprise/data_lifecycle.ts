/** Retention, legal-hold, and PII-minimizing data lifecycle boundaries. */

import { createHash } from "node:crypto";
import type { SqlClient, SqlQueryResult } from "../persistence/sql_client.js";
import {
  DEFAULT_DATA_RETENTION_POLICY,
  resolve_retention_policy,
  retention_policy_statement,
  type DataRetentionPolicy,
} from "./retention_policy.js";

export type { DataRetentionPolicy, ResolvedDataRetentionPolicy } from "./retention_policy.js";
export {
  AUDIT_RETENTION_DAYS,
  DEFAULT_DATA_RETENTION_POLICY,
  INBOUND_RETENTION_DAYS,
  JOB_RETENTION_DAYS,
  OUTBOUND_RETENTION_DAYS,
  RATE_LIMIT_BUCKET_RETENTION_DAYS,
  SESSION_RETENTION_DAYS,
  resolve_retention_policy,
  retention_policy_statement,
} from "./retention_policy.js";

/** One bounded purge or preview result. Audit rows are never purged. */
export interface PurgeResult {
  inbound_deleted: number;
  sessions_deleted: number;
  jobs_deleted: number;
  outbound_deleted: number;
  rate_limit_buckets_deleted: number;
}

/** One legal hold record. */
export interface LegalHoldInput {
  tenant_id: string;
  scope: "inbound" | "outbound" | "audit" | "tenant";
  reference: string;
  reason_code: string;
}

/** Lifecycle port used by scheduled maintenance and operator tooling. */
export interface DataLifecycleStore {
  set_legal_hold(input: LegalHoldInput): Promise<void>;
  release_legal_hold(tenant_id: string, scope: LegalHoldInput["scope"], reference: string): Promise<void>;
  /** Count purge-eligible rows per category without deleting anything. */
  preview_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult>;
  purge_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult>;
}

/** In-memory lifecycle adapter for deterministic privacy tests. */
export class InMemoryDataLifecycleStore implements DataLifecycleStore {
  private readonly holds = new Set<string>();
  private inbound_rows = 0;
  private session_rows = 0;
  private terminal_unclaimed_jobs = 0;
  private terminal_claimed_jobs = 0;
  private active_jobs = 0;
  private outbound_rows = 0;
  private rate_limit_buckets = 0;
  private dedupe_claims = 0;

  /** Seed opaque row counts without exposing content. */
  seed(counts: {
    inbound?: number;
    sessions?: number;
    jobs_terminal_unclaimed?: number;
    jobs_terminal_claimed?: number;
    jobs_active?: number;
    outbound?: number;
    rate_limit_buckets?: number;
    dedupe_claims?: number;
  }): void {
    this.inbound_rows = counts.inbound ?? this.inbound_rows;
    this.session_rows = counts.sessions ?? this.session_rows;
    this.terminal_unclaimed_jobs = counts.jobs_terminal_unclaimed ?? this.terminal_unclaimed_jobs;
    this.terminal_claimed_jobs = counts.jobs_terminal_claimed ?? this.terminal_claimed_jobs;
    this.active_jobs = counts.jobs_active ?? this.active_jobs;
    this.outbound_rows = counts.outbound ?? this.outbound_rows;
    this.rate_limit_buckets = counts.rate_limit_buckets ?? this.rate_limit_buckets;
    this.dedupe_claims = counts.dedupe_claims ?? this.dedupe_claims;
  }

  /** Report retained rows that purge must never delete. */
  retained_counts(): {
    jobs_active: number;
    jobs_terminal_claimed: number;
    dedupe_claims: number;
  } {
    return {
      jobs_active: this.active_jobs,
      jobs_terminal_claimed: this.terminal_claimed_jobs,
      dedupe_claims: this.dedupe_claims,
    };
  }

  /** Add an active hold key. */
  async set_legal_hold(input: LegalHoldInput): Promise<void> {
    this.holds.add(hold_key(input.tenant_id, input.scope, input.reference));
  }

  /** Remove a hold key. */
  async release_legal_hold(tenant_id: string, scope: LegalHoldInput["scope"], reference: string): Promise<void> {
    this.holds.delete(hold_key(tenant_id, scope, reference));
  }

  /** Count eligible rows per category without mutating state. */
  async preview_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult> {
    resolve_retention_policy(policy);
    const bounded = bounded_limit(limit);
    return distribute_budget(bounded, this.eligible_counts());
  }

  /** Delete bounded synthetic counts when no hold covers the scope. */
  async purge_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult> {
    const deleted = await this.preview_expired(policy, limit);
    this.inbound_rows -= deleted.inbound_deleted;
    this.session_rows -= deleted.sessions_deleted;
    this.terminal_unclaimed_jobs -= deleted.jobs_deleted;
    this.outbound_rows -= deleted.outbound_deleted;
    this.rate_limit_buckets -= deleted.rate_limit_buckets_deleted;
    return deleted;
  }

  private eligible_counts(): {
    inbound: number;
    sessions: number;
    jobs: number;
    outbound: number;
    rate_limit_buckets: number;
  } {
    return {
      inbound: this.has_hold_scope("inbound") ? 0 : this.inbound_rows,
      sessions: this.has_hold_scope("tenant") ? 0 : this.session_rows,
      jobs: this.has_hold_scope("tenant") ? 0 : this.terminal_unclaimed_jobs,
      outbound: this.has_hold_scope("outbound") ? 0 : this.outbound_rows,
      rate_limit_buckets: this.has_hold_scope("tenant") ? 0 : this.rate_limit_buckets,
    };
  }

  private has_hold_scope(scope: "inbound" | "outbound" | "tenant"): boolean {
    for (const key of this.holds) {
      const parsed = parse_hold_key(key);
      if (parsed !== null && (parsed.scope === scope || parsed.scope === "tenant")) return true;
    }
    return false;
  }
}

const SET_HOLD_SQL = `
  INSERT INTO public.legal_holds (tenant_id, scope, reference, reason_code, is_active)
  VALUES ($1, $2, $3, $4, true)
  ON CONFLICT (tenant_id, scope, reference) WHERE is_active
  DO UPDATE SET is_active = true, reason_code = EXCLUDED.reason_code, released_at = NULL, updated_at = now()
`;

const RELEASE_HOLD_SQL = `
  UPDATE public.legal_holds
  SET is_active = false, released_at = now(), updated_at = now()
  WHERE tenant_id = $1 AND scope = $2 AND reference = $3 AND is_active
`;

const PURGE_INBOUND_SQL = `
  DELETE FROM public.inbound_messages AS inbound
  WHERE inbound.id IN (
    SELECT candidate.id
    FROM public.inbound_messages AS candidate
    WHERE candidate.expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.legal_holds AS hold
        WHERE hold.tenant_id = candidate.tenant_id
          AND hold.is_active
          AND hold.scope IN ('inbound', 'tenant')
      )
    ORDER BY candidate.expires_at, candidate.id
    LIMIT $1
  )
  RETURNING inbound.id
`;

const PURGE_SESSIONS_SQL = `
  DELETE FROM public.reschedule_sessions AS session
  WHERE session.id IN (
    SELECT candidate.id
    FROM public.reschedule_sessions AS candidate
    WHERE candidate.expires_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.legal_holds AS hold
        WHERE hold.tenant_id = candidate.tenant_id
          AND hold.is_active
          AND hold.scope = 'tenant'
      )
    ORDER BY candidate.expires_at, candidate.id
    LIMIT $1
  )
  RETURNING session.id
`;

const PURGE_JOBS_SQL = `
  DELETE FROM public.webhook_jobs AS job
  WHERE job.id IN (
    SELECT candidate.id
    FROM public.webhook_jobs AS candidate
    WHERE candidate.tenant_id IS NOT NULL
      AND candidate.status IN ('completed', 'failed')
      AND candidate.created_at < now() - ($2::integer * interval '1 day')
      AND NOT EXISTS (
        SELECT 1 FROM public.processed_messages AS claim
        WHERE claim.tenant_id = candidate.tenant_id
          AND claim.wamid = candidate.wamid
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.legal_holds AS hold
        WHERE hold.tenant_id = candidate.tenant_id
          AND hold.is_active
          AND hold.scope = 'tenant'
      )
    ORDER BY candidate.created_at, candidate.id
    LIMIT $1
  )
  RETURNING job.id
`;

const PURGE_OUTBOUND_SQL = `
  DELETE FROM public.outbound_ledger AS outbound
  WHERE outbound.tenant_id IS NOT NULL
    AND outbound.updated_at < now() - ($2::integer * interval '1 day')
    AND outbound.status IN ('sent', 'delivered', 'read', 'failed')
    AND NOT EXISTS (
      SELECT 1 FROM public.legal_holds AS hold
      WHERE hold.tenant_id = outbound.tenant_id
        AND hold.is_active
        AND hold.scope IN ('outbound', 'tenant')
    )
    AND outbound.ctid IN (
      SELECT candidate.ctid
      FROM public.outbound_ledger AS candidate
      ORDER BY candidate.updated_at, candidate.tenant_id, candidate.provider, candidate.operation_key
      LIMIT $1
    )
  RETURNING outbound.tenant_id
`;

const PURGE_RATE_BUCKETS_SQL = `
  DELETE FROM public.tenant_rate_limits AS limits
  WHERE limits.window_bucket < (extract(epoch FROM now()) / 86400 - $2)::bigint
    AND NOT EXISTS (
      SELECT 1 FROM public.legal_holds AS hold
      WHERE hold.tenant_id = limits.tenant_id
        AND hold.is_active
        AND hold.scope = 'tenant'
    )
    AND limits.tenant_id IN (
      SELECT candidate.tenant_id
      FROM public.tenant_rate_limits AS candidate
      ORDER BY candidate.window_bucket, candidate.tenant_id
      LIMIT $1
    )
  RETURNING limits.tenant_id
`;

const PREVIEW_ELIGIBLE_SQL = `
  SELECT
    (SELECT count(*) FROM public.inbound_messages AS candidate
      WHERE candidate.expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM public.legal_holds AS hold
          WHERE hold.tenant_id = candidate.tenant_id
            AND hold.is_active
            AND hold.scope IN ('inbound', 'tenant')
        )) AS inbound_eligible,
    (SELECT count(*) FROM public.reschedule_sessions AS candidate
      WHERE candidate.expires_at <= now()
        AND NOT EXISTS (
          SELECT 1 FROM public.legal_holds AS hold
          WHERE hold.tenant_id = candidate.tenant_id
            AND hold.is_active
            AND hold.scope = 'tenant'
        )) AS sessions_eligible,
    (SELECT count(*) FROM public.webhook_jobs AS candidate
      WHERE candidate.tenant_id IS NOT NULL
        AND candidate.status IN ('completed', 'failed')
        AND candidate.created_at < now() - ($1::integer * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM public.processed_messages AS claim
          WHERE claim.tenant_id = candidate.tenant_id
            AND claim.wamid = candidate.wamid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.legal_holds AS hold
          WHERE hold.tenant_id = candidate.tenant_id
            AND hold.is_active
            AND hold.scope = 'tenant'
        )) AS jobs_eligible,
    (SELECT count(*) FROM public.outbound_ledger AS candidate
      WHERE candidate.tenant_id IS NOT NULL
        AND candidate.updated_at < now() - ($2::integer * interval '1 day')
        AND candidate.status IN ('sent', 'delivered', 'read', 'failed')
        AND NOT EXISTS (
          SELECT 1 FROM public.legal_holds AS hold
          WHERE hold.tenant_id = candidate.tenant_id
            AND hold.is_active
            AND hold.scope IN ('outbound', 'tenant')
        )) AS outbound_eligible,
    (SELECT count(*) FROM public.tenant_rate_limits AS candidate
      WHERE candidate.window_bucket < (extract(epoch FROM now()) / 86400 - $3)::bigint
        AND NOT EXISTS (
          SELECT 1 FROM public.legal_holds AS hold
          WHERE hold.tenant_id = candidate.tenant_id
            AND hold.is_active
            AND hold.scope = 'tenant'
        )) AS rate_limit_buckets_eligible
`;

/** Server-side lifecycle adapter; every delete is bounded and hold-aware. */
export class PostgresDataLifecycleStore implements DataLifecycleStore {
  private readonly sql_client: SqlClient;

  /** Create the lifecycle adapter. */
  constructor(sql_client: SqlClient) {
    this.sql_client = sql_client;
  }

  /** Create or reactivate a tenant-scoped legal hold. */
  async set_legal_hold(input: LegalHoldInput): Promise<void> {
    const normalized = normalize_hold(input);
    await this.sql_client.query(SET_HOLD_SQL, [
      normalized.tenant_id,
      normalized.scope,
      normalized.reference,
      normalized.reason_code,
    ]);
  }

  /** Release a hold without deleting its evidence row. */
  async release_legal_hold(tenant_id: string, scope: LegalHoldInput["scope"], reference: string): Promise<void> {
    if (!/^[1-9][0-9]{0,18}$/.test(tenant_id) || !scope_value(scope) || !safe_reference(reference)) {
      throw new TypeError("legal-hold-release-invalid");
    }
    await this.sql_client.query(RELEASE_HOLD_SQL, [tenant_id, scope, reference]);
  }

  /** Count purge-eligible rows without deleting; audit rows are never eligible. */
  async preview_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult> {
    const resolved = resolve_retention_policy(policy);
    const bounded = bounded_limit(limit);
    const result = await this.sql_client.query(PREVIEW_ELIGIBLE_SQL, [
      resolved.job_days,
      resolved.outbound_days,
      resolved.rate_limit_bucket_days,
    ]);
    return distribute_budget(bounded, preview_counts(result));
  }

  /**
   * Purge expired operational data in bounded batches.
   *
   * Audit evidence stays append-only and is never deleted here; terminal
   * idempotency claims in processed_messages and claimed or active jobs are
   * never eligible either.
   */
  async purge_expired(policy: DataRetentionPolicy, limit: number): Promise<PurgeResult> {
    const resolved = resolve_retention_policy(policy);
    const bounded = bounded_limit(limit);
    const inbound = await this.sql_client.query(PURGE_INBOUND_SQL, [bounded]);
    const after_inbound = Math.max(0, bounded - count_rows(inbound));
    const sessions = await this.sql_client.query(PURGE_SESSIONS_SQL, [after_inbound]);
    const after_sessions = Math.max(0, after_inbound - count_rows(sessions));
    const jobs = await this.sql_client.query(PURGE_JOBS_SQL, [after_sessions, resolved.job_days]);
    const after_jobs = Math.max(0, after_sessions - count_rows(jobs));
    const outbound = await this.sql_client.query(PURGE_OUTBOUND_SQL, [after_jobs, resolved.outbound_days]);
    const final_remaining = Math.max(0, after_jobs - count_rows(outbound));
    const rate_limits = await this.sql_client.query(PURGE_RATE_BUCKETS_SQL, [final_remaining, resolved.rate_limit_bucket_days]);
    return {
      inbound_deleted: count_rows(inbound),
      sessions_deleted: count_rows(sessions),
      jobs_deleted: count_rows(jobs),
      outbound_deleted: count_rows(outbound),
      rate_limit_buckets_deleted: count_rows(rate_limits),
    };
  }
}

/** Produce a safe operator view without message text, recipient, or ciphertext. */
export function redact_inbound_for_operator(input: {
  tenant_id: string;
  wamid: string;
  sender_ref: string;
  message_text: string;
}): Record<string, string> {
  return {
    tenant_id: input.tenant_id,
    wamid: input.wamid,
    sender_ref_hash: sha256(input.sender_ref),
    message_hash: sha256(input.message_text),
    redacted: "true",
  };
}

/** Bounded analytics input; raw content is accepted only to be hashed. */
export interface AnalyticsEventInput {
  tenant_id: string;
  action: string;
  outcome: string;
  sender_ref?: string;
  message_text?: string;
  conversation_id?: string;
}

/** PII-free analytics event safe for warehouses and dashboards. */
export interface AnalyticsEvent {
  tenant_id: string;
  action: string;
  outcome: string;
  sender_ref_hash: string | null;
  message_hash: string | null;
  message_length_bucket: "short" | "medium" | "long" | null;
  conversation_ref_hash: string | null;
}

/**
 * Build an analytics event that never carries raw content or PII.
 *
 * Identifiers leave this boundary only as one-way hashes and message length
 * only as a coarse bucket, so aggregates cannot be reversed into content.
 */
export function anonymize_for_analytics(input: AnalyticsEventInput): AnalyticsEvent {
  if (typeof input !== "object" || input === null) throw new TypeError("analytics-event-invalid");
  if (!/^[1-9][0-9]{0,18}$/.test(input.tenant_id)) throw new TypeError("analytics-tenant-invalid");
  if (!/^[a-z0-9_]{1,64}$/.test(input.action)) throw new TypeError("analytics-action-invalid");
  if (!/^[a-z0-9_]{1,64}$/.test(input.outcome)) throw new TypeError("analytics-outcome-invalid");
  return {
    tenant_id: input.tenant_id,
    action: input.action,
    outcome: input.outcome,
    sender_ref_hash: input.sender_ref === undefined ? null : sha256(input.sender_ref),
    message_hash: input.message_text === undefined ? null : sha256(input.message_text),
    message_length_bucket: input.message_text === undefined ? null : length_bucket(input.message_text),
    conversation_ref_hash: input.conversation_id === undefined ? null : sha256(input.conversation_id),
  };
}

function normalize_hold(value: LegalHoldInput): LegalHoldInput {
  if (
    typeof value !== "object" || value === null ||
    !/^[1-9][0-9]{0,18}$/.test(value.tenant_id) ||
    !scope_value(value.scope) ||
    !safe_reference(value.reference) ||
    typeof value.reason_code !== "string" || !/^[a-z0-9_]{1,64}$/.test(value.reason_code)
  ) throw new TypeError("legal-hold-invalid");
  return { ...value };
}

function hold_key(tenant_id: string, scope: string, reference: string): string {
  return JSON.stringify([tenant_id, scope, reference]);
}

function parse_hold_key(key: string): { tenant_id: string; scope: string; reference: string } | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [tenant_id, scope, reference] = parsed;
    if (typeof tenant_id !== "string" || typeof scope !== "string" || typeof reference !== "string") return null;
    return { tenant_id, scope, reference };
  } catch {
    return null;
  }
}

function scope_value(value: unknown): value is LegalHoldInput["scope"] {
  return value === "inbound" || value === "outbound" || value === "audit" || value === "tenant";
}

function safe_reference(value: string): boolean {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value.trim() === value
    && !has_control_characters(value);
}

function has_control_characters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function bounded_limit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError("purge-limit-invalid");
  return value;
}

function distribute_budget(
  bounded: number,
  eligible: { inbound: number; sessions: number; jobs: number; outbound: number; rate_limit_buckets: number },
): PurgeResult {
  const inbound_deleted = Math.min(eligible.inbound, bounded);
  const sessions_deleted = Math.min(eligible.sessions, bounded - inbound_deleted);
  const jobs_deleted = Math.min(eligible.jobs, bounded - inbound_deleted - sessions_deleted);
  const outbound_deleted = Math.min(eligible.outbound, bounded - inbound_deleted - sessions_deleted - jobs_deleted);
  const rate_limit_buckets_deleted = Math.min(
    eligible.rate_limit_buckets,
    bounded - inbound_deleted - sessions_deleted - jobs_deleted - outbound_deleted,
  );
  return { inbound_deleted, sessions_deleted, jobs_deleted, outbound_deleted, rate_limit_buckets_deleted };
}

function preview_counts(result: SqlQueryResult): {
  inbound: number;
  sessions: number;
  jobs: number;
  outbound: number;
  rate_limit_buckets: number;
} {
  const row = Array.isArray(result.rows) && result.rows.length > 0 ? result.rows[0] : undefined;
  if (typeof row !== "object" || row === null) throw new Error("purge-preview-invalid");
  const record = row as Record<string, unknown>;
  return {
    inbound: parse_preview_count(record["inbound_eligible"]),
    sessions: parse_preview_count(record["sessions_eligible"]),
    jobs: parse_preview_count(record["jobs_eligible"]),
    outbound: parse_preview_count(record["outbound_eligible"]),
    rate_limit_buckets: parse_preview_count(record["rate_limit_buckets_eligible"]),
  };
}

function parse_preview_count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("purge-preview-invalid");
  return parsed;
}

function count_rows(result: SqlQueryResult): number {
  if (Array.isArray(result.rows)) return result.rows.length;
  if (typeof result.rowCount === "number") return result.rowCount;
  throw new Error("purge-result-invalid");
}

function length_bucket(message_text: string): "short" | "medium" | "long" {
  if (message_text.length <= 32) return "short";
  if (message_text.length <= 256) return "medium";
  return "long";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
