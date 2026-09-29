/** Durable ingress state machine for inbound reconciliation and orphan repair. */

import type { MetricsSink } from "../observability/metrics.js";

/** Stable failure at the ingress reconciliation boundary. */
export class IngressReconciliationError extends Error {
  /** Create a safe reconciliation error. */
  constructor(reason = "ingress-reconciliation-failed", cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause });
    this.name = "IngressReconciliationError";
  }
}

/** Lifecycle state of one tenant-scoped inbound claim. */
export type IngressReconciliationStatus =
  | "accepted"
  | "duplicate"
  | "reconciling"
  | "needs_repair"
  | "failed";

/** Lifecycle state of the worker job half of one inbound claim. */
export type ReconciliationJobState = "missing" | "pending" | "claimed" | "completed" | "failed";

/** Durable evidence observed for one tenant-scoped inbound claim. */
export interface IngressStateInput {
  /** Whether a processed_messages claim exists for this tenant/wamid. */
  has_claim: boolean;
  /** Whether a retained inbound_messages row exists for this tenant/wamid. */
  has_inbound_row: boolean;
  /** Lifecycle state of the webhook_jobs row, or missing when absent. */
  job_status: ReconciliationJobState;
  /** Whether the retained row is marked processed. */
  inbound_processed: boolean;
}

/** Structural cause of one orphaned inbound claim. */
export type IngressOrphanKind = "claim_without_job" | "job_without_row" | "uncommitted_residue";

/** One tenant/wamid triple observed by the reconciliation scan. */
export interface IngressTriple {
  /** Owning tenant; joins are always tenant-scoped. */
  tenant_id: string;
  /** Stable provider message id; never message content. */
  wamid: string;
  /** Whether the idempotency claim exists. */
  has_claim: boolean;
  /** Whether the retained inbound row exists. */
  has_inbound_row: boolean;
  /** Worker job lifecycle state. */
  job_status: ReconciliationJobState;
  /** Whether the retained row is marked processed. */
  inbound_processed: boolean;
  /** ISO instant the triple was observed, used for repair-age alerts. */
  observed_at: string;
}

/** One orphan requiring operator attention or in-flight patience. */
export interface OrphanReport {
  /** Owning tenant. */
  tenant_id: string;
  /** Stable provider message id. */
  wamid: string;
  /** Structural cause. */
  kind: IngressOrphanKind;
  /** Classified lifecycle state. */
  status: IngressReconciliationStatus;
  /** ISO observation instant. */
  observed_at: string;
}

/** Default per-pass scan bound for the scheduled reconciliation job. */
export const DEFAULT_RECONCILIATION_BATCH_LIMIT = 100;

/** Hard cap for any single reconciliation scan. */
export const MAX_RECONCILIATION_BATCH_LIMIT = 1000;

/** Default age after which an unrepaired orphan pages the operator. */
export const DEFAULT_REPAIR_AGE_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Classify one claim into its reconciliation lifecycle state.
 *
 * Truth table: terminal job + retained row is a duplicate; an active job with
 * a processed row is accepted; an active job with an unprocessed row is still
 * reconciling; any missing half (claim without job, job without row, residue
 * between provider acceptance and local commit) needs repair; a claim that
 * was explicitly dead-lettered is failed.
 *
 * @param input - Durable evidence observed for one tenant/wamid.
 * @returns The lifecycle state driving repair, patience, or silence.
 * @throws IngressReconciliationError when the evidence shape is invalid.
 */
export function classify_ingress_state(input: IngressStateInput): IngressReconciliationStatus {
  validate_state_input(input);
  if (!input.has_claim) return "reconciling";
  if (input.job_status === "completed" || input.job_status === "failed") {
    return input.has_inbound_row ? "duplicate" : "needs_repair";
  }
  if (input.job_status === "missing") return "needs_repair";
  if (!input.has_inbound_row) return "needs_repair";
  return input.inbound_processed ? "accepted" : "reconciling";
}

/**
 * Detect orphans in one bounded batch of observed triples.
 *
 * Healthy (accepted/duplicate) triples are filtered out; only reconciling
 * and needs_repair rows produce reports. Claims are never deleted here.
 *
 * @param rows - Observed tenant-scoped triples.
 * @param options - Optional batch limit override.
 * @returns Orphan reports for non-healthy triples only.
 * @throws IngressReconciliationError on invalid rows or limits.
 */
export function detect_orphans(
  rows: readonly IngressTriple[],
  options: { limit?: number } = {},
): OrphanReport[] {
  if (!Array.isArray(rows)) throw new IngressReconciliationError("ingress-triples-invalid");
  const limit = normalize_limit(options.limit ?? DEFAULT_RECONCILIATION_BATCH_LIMIT);
  const reports: OrphanReport[] = [];
  for (const row of rows.slice(0, limit)) {
    const triple = validate_triple(row);
    const status = classify_ingress_state(triple);
    if (status === "accepted" || status === "duplicate" || status === "failed") continue;
    reports.push({
      tenant_id: triple.tenant_id,
      wamid: triple.wamid,
      kind: orphan_kind(triple),
      status,
      observed_at: triple.observed_at,
    });
  }
  return reports;
}

/**
 * Decide whether an orphan has aged past the operator paging threshold.
 *
 * @param observed_at_iso - ISO instant the orphan was first observed.
 * @param now - Scheduler clock, injected for deterministic tests.
 * @param threshold_ms - Paging threshold in milliseconds.
 * @returns True when the orphan age exceeds the threshold.
 * @throws IngressReconciliationError on invalid timestamps or thresholds.
 */
export function repair_age_exceeded(
  observed_at_iso: string,
  now: Date,
  threshold_ms = DEFAULT_REPAIR_AGE_THRESHOLD_MS,
): boolean {
  const observed_ms = Date.parse(parse_timestamp(observed_at_iso, "ingress-observed-at-invalid"));
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IngressReconciliationError("ingress-clock-invalid");
  }
  const threshold = normalize_threshold(threshold_ms);
  return now.getTime() - observed_ms > threshold;
}

/**
 * Return operator-facing replay guidance for one orphan kind.
 *
 * The strings name the safe manual action only; they carry no tenant,
 * message, or recipient data.
 *
 * @param kind - Structural orphan cause.
 * @returns Support runbook hint for the manual replay path.
 * @throws IngressReconciliationError for an unknown kind.
 */
export function support_replay_guidance(kind: IngressOrphanKind): string {
  switch (kind) {
    case "claim_without_job":
      return "Requeue a fresh worker job from the retained inbound row, then mark the repair audited. Never delete the claim.";
    case "job_without_row":
      return "Quarantine the job and ask the customer to resend; the retained payload is missing and must not be reconstructed from logs.";
    case "uncommitted_residue":
      return "Hold for one more reconciliation pass; when the age threshold fires, quarantine and requeue from the retained row.";
    default:
      throw new IngressReconciliationError("ingress-orphan-kind-invalid");
  }
}

/** Record one handled outcome without tenant or message labels. */
export function emit_reconciliation_metrics(
  metrics: MetricsSink,
  reports: readonly OrphanReport[],
): void {
  for (const report of reports) {
    metrics.increment("ingress_reconciliation_total", {
      outcome: report.status,
      kind: report.kind,
    });
  }
  metrics.set_gauge("ingress_repairs_pending", reports.length);
}

function orphan_kind(triple: IngressTriple): IngressOrphanKind {
  if (!triple.has_inbound_row) {
    return triple.job_status === "missing" ? "claim_without_job" : "job_without_row";
  }
  return "uncommitted_residue";
}

function validate_state_input(input: IngressStateInput): void {
  if (typeof input !== "object" || input === null) {
    throw new IngressReconciliationError("ingress-state-invalid");
  }
  if (typeof input.has_claim !== "boolean" || typeof input.has_inbound_row !== "boolean") {
    throw new IngressReconciliationError("ingress-state-invalid");
  }
  if (typeof input.inbound_processed !== "boolean") {
    throw new IngressReconciliationError("ingress-state-invalid");
  }
  if (!is_job_state(input.job_status)) throw new IngressReconciliationError("ingress-job-state-invalid");
}

function validate_triple(row: IngressTriple): IngressTriple {
  if (typeof row !== "object" || row === null) {
    throw new IngressReconciliationError("ingress-triple-invalid");
  }
  validate_state_input(row);
  return {
    tenant_id: require_id(row.tenant_id, "tenant_id"),
    wamid: require_wamid(row.wamid),
    has_claim: row.has_claim,
    has_inbound_row: row.has_inbound_row,
    job_status: row.job_status,
    inbound_processed: row.inbound_processed,
    observed_at: parse_timestamp(row.observed_at, "ingress-observed-at-invalid"),
  };
}

function is_job_state(value: unknown): value is ReconciliationJobState {
  return (
    value === "missing" ||
    value === "pending" ||
    value === "claimed" ||
    value === "completed" ||
    value === "failed"
  );
}

function require_id(value: string, field_name: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 256) {
    throw new IngressReconciliationError(`ingress-${field_name}-invalid`);
  }
  return value;
}

function require_wamid(value: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw new IngressReconciliationError("ingress-wamid-invalid");
  }
  return value;
}

function parse_timestamp(value: unknown, reason: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new IngressReconciliationError(reason);
  }
  return value;
}

function normalize_limit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RECONCILIATION_BATCH_LIMIT) {
    throw new IngressReconciliationError("ingress-batch-limit-invalid");
  }
  return limit;
}

function normalize_threshold(threshold_ms: number): number {
  if (!Number.isSafeInteger(threshold_ms) || threshold_ms <= 0 || threshold_ms > 30 * 24 * 60 * 60 * 1000) {
    throw new IngressReconciliationError("ingress-threshold-invalid");
  }
  return threshold_ms;
}
