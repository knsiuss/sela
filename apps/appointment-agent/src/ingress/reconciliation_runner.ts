/** Scheduled bounded reconciliation pass over orphaned inbound claims. */

import type { MetricsSink } from "../observability/metrics.js";
import {
  DEFAULT_RECONCILIATION_BATCH_LIMIT,
  DEFAULT_REPAIR_AGE_THRESHOLD_MS,
  detect_orphans,
  emit_reconciliation_metrics,
  IngressReconciliationError,
  repair_age_exceeded,
  type OrphanReport,
} from "./reconciliation.js";
import type { IngressOrphanScanner } from "./reconciliation_store.js";

/** Summary of one bounded reconciliation pass for logs and dashboards. */
export interface ReconciliationPassSummary {
  /** Triples scanned in this pass. */
  scanned: number;
  /** Orphans classified as needing repair. */
  needs_repair: number;
  /** Orphans still in flight. */
  reconciling: number;
  /** Orphans older than the paging threshold. */
  repair_aged: number;
  /** True when the scan hit its batch bound and more work may remain. */
  batch_limited: boolean;
}

/** Dependencies for one scheduled reconciliation pass. */
export interface ReconciliationPassInput {
  /** Bounded orphan scanner. */
  scanner: IngressOrphanScanner;
  /** Optional metrics sink; labels never carry tenant or message data. */
  metrics?: MetricsSink;
  /** Scheduler clock, injected for deterministic tests. */
  clock?: () => Date;
  /** Maximum triples per pass. */
  batch_limit?: number;
  /** Age after which an orphan fires the repair-age alert. */
  repair_age_threshold_ms?: number;
}

/**
 * Run one bounded reconciliation pass: scan, classify, meter, and summarize.
 *
 * The pass never repairs or deletes anything; repair stays an explicit
 * audited operator command. Raw scanner failures surface as sanitized
 * reconciliation errors with safe codes only.
 *
 * @param input - Scanner, telemetry, clock, and bounds.
 * @returns Counts for logs, gauges, and the repair-age alert.
 * @throws IngressReconciliationError when the scan or classification fails.
 */
export async function run_reconciliation_pass(
  input: ReconciliationPassInput,
): Promise<ReconciliationPassSummary> {
  if (typeof input !== "object" || input === null || typeof input.scanner?.scan_orphans !== "function") {
    throw new IngressReconciliationError("ingress-pass-input-invalid");
  }
  const clock = input.clock ?? (() => new Date());
  const batch_limit = input.batch_limit ?? DEFAULT_RECONCILIATION_BATCH_LIMIT;
  const threshold_ms = input.repair_age_threshold_ms ?? DEFAULT_REPAIR_AGE_THRESHOLD_MS;
  const now = valid_now(clock());
  let reports: OrphanReport[];
  let scanned = 0;
  try {
    const triples = await input.scanner.scan_orphans(batch_limit);
    scanned = triples.length;
    reports = detect_orphans(triples, { limit: batch_limit });
  } catch (error) {
    if (error instanceof IngressReconciliationError) throw error;
    throw new IngressReconciliationError("ingress-pass-scan-failed", error);
  }
  const summary = summarize_reports(reports, now, threshold_ms, scanned, batch_limit);
  input.metrics?.increment("ingress_reconciliation_passes_total", {
    outcome: summary.repair_aged > 0 ? "repair_aged" : "ok",
  });
  emit_reconciliation_metrics(input.metrics ?? noop_metrics(), reports);
  input.metrics?.set_gauge("ingress_repair_age_firing", summary.repair_aged > 0 ? 1 : 0);
  return summary;
}

function summarize_reports(
  reports: readonly OrphanReport[],
  now: Date,
  threshold_ms: number,
  scanned: number,
  batch_limit: number,
): ReconciliationPassSummary {
  let needs_repair = 0;
  let reconciling = 0;
  let repair_aged = 0;
  for (const report of reports) {
    if (report.status === "needs_repair") needs_repair += 1;
    if (report.status === "reconciling") reconciling += 1;
    if (repair_age_exceeded(report.observed_at, now, threshold_ms)) repair_aged += 1;
  }
  return {
    scanned,
    needs_repair,
    reconciling,
    repair_aged,
    batch_limited: scanned >= batch_limit,
  };
}

function valid_now(now: Date): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new IngressReconciliationError("ingress-clock-invalid");
  }
  return now;
}

function noop_metrics(): MetricsSink {
  return {
    increment: () => undefined,
    set_gauge: () => undefined,
    observe: () => undefined,
  };
}
