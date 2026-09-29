/** Scheduled, idempotent, and observable retention purge execution. */

import type { MetricsSink } from "../observability/metrics.js";
import {
  DEFAULT_DATA_RETENTION_POLICY,
  type DataLifecycleStore,
  type DataRetentionPolicy,
  type PurgeResult,
} from "./data_lifecycle.js";

/** Options for one bounded purge pass. */
export interface RetentionPurgeOptions {
  /** Maximum rows touched across all categories in this pass. */
  limit: number;
  /** When true, count eligible rows without deleting anything. */
  dry_run: boolean;
  /** Optional PII-free metrics sink. */
  metrics?: MetricsSink;
  /** Optional structured event sink; never receives tenant or content data. */
  events?: (event: RetentionPurgeEvent) => void;
  /** Clock used for duration measurement. */
  clock?: () => number;
}

/** PII-free structured event emitted once per purge pass. */
export interface RetentionPurgeEvent {
  event: "retention_purge";
  dry_run: boolean;
  outcome: "completed" | "failed";
  deleted: PurgeResult;
  duration_ms: number;
  error_code?: string;
}

/** Outcome of one purge pass, including the dry-run preview. */
export interface RetentionPurgeResult {
  dry_run: boolean;
  deleted: PurgeResult;
  duration_ms: number;
}

/**
 * Run one bounded retention purge pass with metrics and structured events.
 *
 * The pass is idempotent: repeated runs converge to zero eligible rows.
 * Dry runs report the same shape without mutating any store.
 *
 * @param store - Hold-aware lifecycle adapter.
 * @param policy - Per-category retention windows; defaults apply when omitted.
 * @param options - Bound, dry-run flag, and observability sinks.
 * @returns Deleted (or previewed) counts with the measured duration.
 */
export async function run_retention_purge(
  store: DataLifecycleStore,
  policy: DataRetentionPolicy = DEFAULT_DATA_RETENTION_POLICY,
  options: RetentionPurgeOptions,
): Promise<RetentionPurgeResult> {
  require_options(options);
  const started_at = (options.clock ?? Date.now)();
  try {
    const deleted = options.dry_run
      ? await store.preview_expired(policy, options.limit)
      : await store.purge_expired(policy, options.limit);
    const result = { dry_run: options.dry_run, deleted, duration_ms: elapsed_ms(options.clock, started_at) };
    record_success(options, result);
    return result;
  } catch (error) {
    record_failure(options, started_at, error);
    throw error;
  }
}

function require_options(options: RetentionPurgeOptions): void {
  if (typeof options !== "object" || options === null) throw new TypeError("retention-purge-options-invalid");
  if (typeof options.dry_run !== "boolean") throw new TypeError("retention-purge-dry-run-invalid");
  if (options.metrics !== undefined && !is_metrics_sink(options.metrics)) {
    throw new TypeError("retention-purge-metrics-invalid");
  }
  if (options.events !== undefined && typeof options.events !== "function") {
    throw new TypeError("retention-purge-events-invalid");
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("retention-purge-clock-invalid");
  }
}

function is_metrics_sink(value: unknown): value is MetricsSink {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate["increment"] === "function"
    && typeof candidate["observe"] === "function";
}

function elapsed_ms(clock: (() => number) | undefined, started_at: number): number {
  const finished_at = (clock ?? Date.now)();
  return Math.max(0, finished_at - started_at);
}

function empty_result(): PurgeResult {
  return {
    inbound_deleted: 0,
    sessions_deleted: 0,
    jobs_deleted: 0,
    outbound_deleted: 0,
    rate_limit_buckets_deleted: 0,
  };
}

function record_success(options: RetentionPurgeOptions, result: RetentionPurgeResult): void {
  options.metrics?.increment("retention_purge_runs_total", {
    outcome: "completed",
    dry_run: String(result.dry_run),
  });
  for (const [category, deleted] of purge_categories(result.deleted)) {
    options.metrics?.increment("retention_purged_total", { category, dry_run: String(result.dry_run) }, deleted);
  }
  options.metrics?.observe("retention_purge_duration_ms", result.duration_ms, { dry_run: String(result.dry_run) });
  options.events?.({
    event: "retention_purge",
    dry_run: result.dry_run,
    outcome: "completed",
    deleted: { ...result.deleted },
    duration_ms: result.duration_ms,
  });
}

function record_failure(options: RetentionPurgeOptions, started_at: number, error: unknown): void {
  const duration_ms = elapsed_ms(options.clock, started_at);
  options.metrics?.increment("retention_purge_runs_total", {
    outcome: "failed",
    dry_run: String(options.dry_run),
  });
  options.events?.({
    event: "retention_purge",
    dry_run: options.dry_run,
    outcome: "failed",
    deleted: empty_result(),
    duration_ms,
    error_code: safe_error_code(error),
  });
}

function *purge_categories(deleted: PurgeResult): Generator<[string, number]> {
  yield ["inbound", deleted.inbound_deleted];
  yield ["sessions", deleted.sessions_deleted];
  yield ["jobs", deleted.jobs_deleted];
  yield ["outbound", deleted.outbound_deleted];
  yield ["rate_limit_buckets", deleted.rate_limit_buckets_deleted];
}

function safe_error_code(error: unknown): string {
  if (error instanceof Error && error.name !== "Error") {
    return error.name.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 64) || "retention_purge_failed";
  }
  return "retention_purge_failed";
}
