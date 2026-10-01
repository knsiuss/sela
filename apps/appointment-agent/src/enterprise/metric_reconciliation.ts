/** Operational/analytical metric reconciliation and archival/restore hooks. */

import { ANALYTICS_ACTIONS, ANALYTICS_OUTCOMES, APPROVED_METRICS } from "./analytics_contract.js";

/** One metric's counts from either the operational or analytical store. */
export type MetricCounts = Readonly<Record<string, number>>;

/** Difference for one metric key between the two stores. */
export interface MetricDelta {
  metric_key: string;
  operational_count: number;
  analytical_count: number;
  delta: number;
  is_within_tolerance: boolean;
}

/** Result of reconciling the operational store against the analytical store. */
export interface ReconciliationResult {
  is_within_tolerance: boolean;
  deltas: readonly MetricDelta[];
}

/** Retention and aggregation rules for long-term analytics storage. */
export interface ArchivePolicy {
  retention_days: number;
  granularity: "daily";
}

/** One archived, content-free aggregate snapshot for a tenant period. */
export interface AnalyticsSnapshot {
  tenant_id: string;
  period_start_iso: string;
  period_end_iso: string;
  counts: MetricCounts;
  archived_at_iso: string;
}

/** Storage port for archived snapshots; implementations must stay content-free. */
export interface AnalyticsSnapshotStore {
  save(snapshot: AnalyticsSnapshot): Promise<void>;
  load(tenant_id: string, period_start_iso: string): Promise<AnalyticsSnapshot | null>;
}

/** Explicit in-memory snapshot store for tests and pilot verification. */
export class InMemoryAnalyticsSnapshotStore implements AnalyticsSnapshotStore {
  private readonly snapshots = new Map<string, AnalyticsSnapshot>();

  /** Persist one snapshot, rejecting a duplicate for the same tenant period. */
  async save(snapshot: AnalyticsSnapshot): Promise<void> {
    const normalized = validate_snapshot(snapshot);
    const key = snapshot_key(normalized.tenant_id, normalized.period_start_iso);
    if (this.snapshots.has(key)) throw new ArchiveError("analytics-snapshot-duplicated");
    this.snapshots.set(key, normalized);
  }

  /** Read one snapshot, returning null when the period was never archived. */
  async load(tenant_id: string, period_start_iso: string): Promise<AnalyticsSnapshot | null> {
    return this.snapshots.get(snapshot_key(tenant_id_value(tenant_id), timestamp(period_start_iso))) ?? null;
  }
}

/** Safe failure for an unreconcilable or unarchivable metric contract. */
export class ArchiveError extends Error {
  readonly code = "analytics_archive_invalid";

  /** Create a sanitized archive or reconciliation failure. */
  constructor(reason: string) {
    super(reason);
    this.name = "ArchiveError";
  }
}

/**
 * Reconcile operational counts against analytical warehouse counts.
 *
 * Only approved metric keys are accepted, so a renamed or ad-hoc metric is
 * reported as a contract violation instead of silently drifting between stores.
 *
 * @param operational - Counts exported from the operational store.
 * @param analytical - Counts materialized in the analytical store.
 * @param tolerance - Maximum absolute per-metric difference, inclusive.
 * @returns Frozen result flagging every metric outside tolerance.
 */
export function reconcile_metrics(
  operational: MetricCounts,
  analytical: MetricCounts,
  tolerance: number,
): ReconciliationResult {
  const allowed_tolerance = non_negative_integer(tolerance, "reconciliation-tolerance-invalid");
  const operational_counts = validate_counts(operational, "reconciliation-operational-invalid");
  const analytical_counts = validate_counts(analytical, "reconciliation-analytical-invalid");
  const keys = [...new Set([...operational_counts.keys(), ...analytical_counts.keys()])].sort();
  const deltas = keys.map((key) => delta_for(key, operational_counts, analytical_counts, allowed_tolerance));
  return Object.freeze({
    is_within_tolerance: deltas.every((entry) => entry.is_within_tolerance),
    deltas: Object.freeze(deltas),
  });
}

/**
 * Build a content-free snapshot from an approved aggregate.
 *
 * Only counts cross into archival storage, so a restored snapshot can never
 * reintroduce message text, recipients, or conversation identifiers.
 *
 * @param input - Tenant, period, aggregate counts, and archive policy.
 * @returns Frozen snapshot ready to hand to a snapshot store.
 */
export function build_snapshot(input: {
  tenant_id: string;
  period_start_iso: string;
  period_end_iso: string;
  counts: MetricCounts;
  policy: ArchivePolicy;
  archived_at_iso: string;
}): AnalyticsSnapshot {
  const period_start_iso = timestamp(input.period_start_iso);
  const period_end_iso = timestamp(input.period_end_iso);
  if (period_end_iso <= period_start_iso) throw new ArchiveError("archive-period-invalid");
  validate_archive_policy(input.policy);
  return validate_snapshot({
    tenant_id: tenant_id_value(input.tenant_id),
    period_start_iso,
    period_end_iso,
    counts: input.counts,
    archived_at_iso: timestamp(input.archived_at_iso),
  });
}

/** Validate retention rules; only daily granularity is approved today. */
export function validate_archive_policy(value: unknown): ArchivePolicy {
  if (typeof value !== "object" || value === null) throw new ArchiveError("archive-policy-invalid");
  const record = value as Record<string, unknown>;
  if (record.granularity !== "daily") throw new ArchiveError("archive-granularity-unapproved");
  return Object.freeze({
    retention_days: non_negative_integer(record.retention_days, "archive-retention-invalid"),
    granularity: "daily" as const,
  });
}

function delta_for(
  key: string,
  operational: Map<string, number>,
  analytical: Map<string, number>,
  tolerance: number,
): MetricDelta {
  assert_approved_metric_key(key);
  const operational_count = operational.get(key) ?? 0;
  const analytical_count = analytical.get(key) ?? 0;
  const delta = analytical_count - operational_count;
  return Object.freeze({
    metric_key: key,
    operational_count,
    analytical_count,
    delta,
    is_within_tolerance: Math.abs(delta) <= tolerance,
  });
}

/** Reject any metric key outside the approved taxonomy before comparing. */
function assert_approved_metric_key(key: string): void {
  const separator = key.indexOf("#");
  const metric_id = separator === -1 ? key : key.slice(0, separator);
  if (!APPROVED_METRICS.some((definition) => definition.metric_id === metric_id)) {
    throw new ArchiveError("reconciliation-metric-unapproved");
  }
  const dimensions = separator === -1 ? [] : key.slice(separator + 1).split("|");
  for (const dimension of dimensions) {
    if (!is_approved_dimension_value(dimension)) throw new ArchiveError("reconciliation-dimension-unapproved");
  }
}

function is_approved_dimension_value(dimension: string): boolean {
  const separator = dimension.indexOf("=");
  if (separator === -1) return false;
  const name = dimension.slice(0, separator);
  const value = dimension.slice(separator + 1);
  if (name === "action") return ANALYTICS_ACTIONS.includes(value);
  if (name === "outcome") return ANALYTICS_OUTCOMES.includes(value);
  if (name === "message_length_bucket") return value === "short" || value === "medium" || value === "long";
  return false;
}

function validate_counts(value: MetricCounts, reason: string): Map<string, number> {
  if (typeof value !== "object" || value === null) throw new ArchiveError(reason);
  const counts = new Map<string, number>();
  for (const [key, count] of Object.entries(value)) {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new ArchiveError(reason);
    counts.set(key, non_negative_integer(count, reason));
  }
  return counts;
}

function validate_snapshot(value: unknown): AnalyticsSnapshot {
  if (typeof value !== "object" || value === null) throw new ArchiveError("analytics-snapshot-invalid");
  const record = value as Record<string, unknown>;
  const counts = validate_counts(record.counts as MetricCounts, "analytics-snapshot-invalid");
  // Archived data outlives the operational store, so unapproved keys are
  // rejected here too rather than only at reconciliation time.
  for (const key of counts.keys()) assert_approved_metric_key(key);
  return Object.freeze({
    tenant_id: tenant_id_value(record.tenant_id),
    period_start_iso: timestamp(record.period_start_iso),
    period_end_iso: timestamp(record.period_end_iso),
    counts: Object.freeze(Object.fromEntries(counts)),
    archived_at_iso: timestamp(record.archived_at_iso),
  });
}

function tenant_id_value(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,18}$/.test(value)) throw new ArchiveError("analytics-tenant-invalid");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new ArchiveError("analytics-timestamp-invalid");
  return new Date(Date.parse(value)).toISOString();
}

function non_negative_integer(value: unknown, reason: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ArchiveError(reason);
  return value;
}

function snapshot_key(tenant_id: string, period_start_iso: string): string {
  return `${tenant_id}|${period_start_iso}`;
}