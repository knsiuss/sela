/** Sync production gauge collectors for queue, pool, purge, and ledger signals. */

import type { MetricsSink } from "./metrics.js";

/** Optional point-in-time providers owned by the deployment composition. */
export interface RuntimeGaugeProviders {
  queue_depth?: () => number;
  db_pool_used?: () => number;
  db_pool_max?: () => number;
  worker_oldest_job_age_ms?: () => number;
  purge_lag_ms?: () => number;
  outbound_ledger_unknown?: () => number;
}

/** Result of one collection pass; per-provider failures never throw. */
export interface GaugeCollectionResult {
  collected: number;
  skipped: number;
}

/**
 * Collect runtime gauges into the metrics sink without throwing.
 *
 * Each provider is optional and isolated: a throwing, non-finite, or
 * negative reading skips that gauge and increments
 * `collector_errors_total{gauge="<name>"}` so a blind collector is visible.
 * Gauges carry no tenant, message, or recipient labels.
 *
 * @param metrics - Sink receiving gauge values; undefined collects nothing.
 * @param providers - Point-in-time provider functions.
 * @returns Counts of collected vs skipped gauges.
 */
export function collect_runtime_gauges(
  metrics: MetricsSink | undefined,
  providers: RuntimeGaugeProviders,
): GaugeCollectionResult {
  if (metrics === undefined) return { collected: 0, skipped: 0 };
  const gauges: Array<{ name: string; read: (() => number) | undefined }> = [
    { name: "worker_queue_depth", read: providers.queue_depth },
    { name: "db_pool_used", read: providers.db_pool_used },
    { name: "db_pool_max", read: providers.db_pool_max },
    { name: "worker_oldest_job_age_ms", read: providers.worker_oldest_job_age_ms },
    { name: "purge_lag_ms", read: providers.purge_lag_ms },
    { name: "outbound_ledger_unknown", read: providers.outbound_ledger_unknown },
  ];
  let collected = 0;
  let skipped = 0;
  for (const gauge of gauges) {
    if (gauge.read === undefined) continue;
    const value = safe_read(gauge.read);
    if (value === null) {
      skipped += 1;
      metrics.increment("collector_errors_total", { gauge: gauge.name });
      continue;
    }
    metrics.set_gauge(gauge.name, value);
    collected += 1;
  }
  return { collected, skipped };
}

function safe_read(read: () => number): number | null {
  let value: number;
  try {
    value = read();
  } catch {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
