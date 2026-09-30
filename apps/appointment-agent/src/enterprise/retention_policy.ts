/** Named retention periods for customer, operational, and evidence data. */

/*
 * Enterprise retention schedule (owner decision, Sept 2026): windows are
 * deliberately longer than the pilot minimums for audit/compliance needs.
 * Trade-off: longer retention enlarges the PII breach surface, since raw
 * inbound content and delivery evidence live longer; the enterprise audit
 * requirement wins per owner, and legal holds still suppress deletion.
 */

/**
 * Retention window for raw inbound content (message text, sender references,
 * encrypted reply targets). Shortest window because it carries raw PII.
 */
export const INBOUND_RETENTION_DAYS = 90;

/** Retention window for ephemeral reschedule session state. */
export const SESSION_RETENTION_DAYS = 30;

/**
 * Retention window for terminal worker jobs. Only jobs detached from their
 * idempotency claim are eligible; claimed or active jobs are never purged.
 */
export const JOB_RETENTION_DAYS = 180;

/** Retention window for terminal outbound ledger rows (delivery evidence). */
export const OUTBOUND_RETENTION_DAYS = 180;

/**
 * Retention window for append-only audit evidence. Audit rows are archived,
 * never hard-purged; they leave the system only through tenant erasure.
 */
export const AUDIT_RETENTION_DAYS = 730;

/** Retention window for fixed-window rate-limit buckets. */
export const RATE_LIMIT_BUCKET_RETENTION_DAYS = 7;

/** Per-category retention windows; audit evidence is archived, never purged. */
export interface DataRetentionPolicy {
  inbound_days: number;
  outbound_days: number;
  rate_limit_bucket_days: number;
  /** Ephemeral session window; defaults to SESSION_RETENTION_DAYS. */
  session_days?: number;
  /** Terminal detached-job window; defaults to JOB_RETENTION_DAYS. */
  job_days?: number;
  /** Audit archive window; defaults to AUDIT_RETENTION_DAYS. */
  audit_days?: number;
}

/** Fully resolved per-category retention windows. */
export interface ResolvedDataRetentionPolicy {
  inbound_days: number;
  outbound_days: number;
  rate_limit_bucket_days: number;
  session_days: number;
  job_days: number;
  audit_days: number;
}

/** Default policy aligned with the inbound retention contract. */
export const DEFAULT_DATA_RETENTION_POLICY: ResolvedDataRetentionPolicy = Object.freeze({
  inbound_days: INBOUND_RETENTION_DAYS,
  outbound_days: OUTBOUND_RETENTION_DAYS,
  rate_limit_bucket_days: RATE_LIMIT_BUCKET_RETENTION_DAYS,
  session_days: SESSION_RETENTION_DAYS,
  job_days: JOB_RETENTION_DAYS,
  audit_days: AUDIT_RETENTION_DAYS,
});

/**
 * Resolve a caller-supplied policy against the named tunable defaults.
 *
 * @param policy - Partial policy using the same per-category day counts.
 * @returns Fully resolved windows with every bound validated.
 */
export function resolve_retention_policy(policy: DataRetentionPolicy): ResolvedDataRetentionPolicy {
  if (typeof policy !== "object" || policy === null) throw new TypeError("retention-policy-invalid");
  return {
    inbound_days: positive_days(policy.inbound_days),
    outbound_days: positive_days(policy.outbound_days),
    rate_limit_bucket_days: positive_days(policy.rate_limit_bucket_days),
    session_days: policy.session_days === undefined ? SESSION_RETENTION_DAYS : positive_days(policy.session_days),
    job_days: policy.job_days === undefined ? JOB_RETENTION_DAYS : positive_days(policy.job_days),
    audit_days: policy.audit_days === undefined ? AUDIT_RETENTION_DAYS : positive_days(policy.audit_days),
  };
}

/**
 * Render quotable English sentences describing the retention behavior.
 *
 * A future customer-facing privacy policy can quote these lines verbatim;
 * they are derived from the same named constants the purge enforces.
 *
 * @param policy - Resolved or partial policy to describe.
 * @returns One sentence per category plus legal-hold and audit notes.
 */
export function retention_policy_statement(policy: DataRetentionPolicy): string[] {
  const resolved = resolve_retention_policy(policy);
  return [
    `Inbound message content is retained for ${resolved.inbound_days} days and then deleted.`,
    `Reschedule session state is retained for ${resolved.session_days} days and then deleted.`,
    `Terminal worker jobs detached from idempotency claims are retained for ${resolved.job_days} days and then deleted.`,
    `Outbound delivery records are retained for ${resolved.outbound_days} days and then deleted.`,
    `Rate-limit counters are retained for ${resolved.rate_limit_bucket_days} days and then deleted.`,
    `Audit evidence is retained for ${resolved.audit_days} days, archived rather than deleted, and removed only through tenant erasure.`,
    `Active legal holds suppress deletion and erasure for the held scope until released.`,
    `Idempotency claims are never deleted by retention cleanup.`,
  ];
}

function positive_days(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 36_500) throw new TypeError("retention-policy-invalid");
  return value;
}
