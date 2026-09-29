import { describe, expect, it } from "vitest";
import { collect_runtime_gauges } from "../src/observability/collectors.js";
import { MetricsRegistry } from "../src/observability/metrics.js";

describe("runtime gauge collectors", () => {
  it("sets gauges from every healthy provider", () => {
    const metrics = new MetricsRegistry();
    const result = collect_runtime_gauges(metrics, {
      queue_depth: () => 7,
      db_pool_used: () => 3,
      db_pool_max: () => 10,
      worker_oldest_job_age_ms: () => 1_500,
      purge_lag_ms: () => 0,
      outbound_ledger_unknown: () => 2,
    });
    expect(result).toEqual({ collected: 6, skipped: 0 });
    expect(metrics.gauge_value("worker_queue_depth")).toBe(7);
    expect(metrics.gauge_value("db_pool_used")).toBe(3);
    expect(metrics.gauge_value("db_pool_max")).toBe(10);
    expect(metrics.gauge_value("worker_oldest_job_age_ms")).toBe(1_500);
    expect(metrics.gauge_value("purge_lag_ms")).toBe(0);
    expect(metrics.gauge_value("outbound_ledger_unknown")).toBe(2);
  });

  it("skips throwing or invalid providers without throwing", () => {
    const metrics = new MetricsRegistry();
    const result = collect_runtime_gauges(metrics, {
      queue_depth: () => {
        throw new Error("pool gone");
      },
      db_pool_used: () => Number.NaN,
      db_pool_max: () => -1,
      worker_oldest_job_age_ms: () => 100,
    });
    expect(result).toEqual({ collected: 1, skipped: 3 });
    expect(metrics.gauge_value("worker_oldest_job_age_ms")).toBe(100);
    expect(metrics.counter_value("collector_errors_total", { gauge: "worker_queue_depth" })).toBe(1);
    expect(metrics.counter_value("collector_errors_total", { gauge: "db_pool_used" })).toBe(1);
    expect(metrics.counter_value("collector_errors_total", { gauge: "db_pool_max" })).toBe(1);
  });

  it("ignores absent providers and an absent sink", () => {
    const metrics = new MetricsRegistry();
    expect(collect_runtime_gauges(metrics, {})).toEqual({ collected: 0, skipped: 0 });
    expect(collect_runtime_gauges(undefined, { queue_depth: () => 1 })).toEqual({ collected: 0, skipped: 0 });
  });
});
