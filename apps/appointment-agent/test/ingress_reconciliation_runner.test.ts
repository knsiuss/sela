import { describe, expect, it, vi } from "vitest";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { IngressReconciliationError } from "../src/ingress/reconciliation.js";
import { InMemoryIngressOrphanScanner } from "../src/ingress/reconciliation_store.js";
import { run_reconciliation_pass } from "../src/ingress/reconciliation_runner.js";
import { ingress_triple } from "./helpers/ingress_fixture.js";

const NOW = new Date("2026-09-24T08:30:00.000Z");

describe("run_reconciliation_pass", () => {
  it("summarizes one bounded pass and emits PII-free metrics", async () => {
    const scanner = new InMemoryIngressOrphanScanner([
      ingress_triple({ wamid: "wamid-ok", inbound_processed: true }),
      ingress_triple({ wamid: "wamid-orphan", has_inbound_row: false, job_status: "missing" }),
      ingress_triple({ wamid: "wamid-flight" }),
    ]);
    const metrics = new MetricsRegistry();
    const summary = await run_reconciliation_pass({
      scanner,
      metrics,
      clock: () => NOW,
      batch_limit: 10,
      repair_age_threshold_ms: 60 * 60 * 1000,
    });
    expect(summary).toEqual({
      scanned: 3,
      needs_repair: 1,
      reconciling: 1,
      repair_aged: 0,
      batch_limited: false,
    });
    expect(metrics.counter_value("ingress_reconciliation_total", {
      outcome: "needs_repair",
      kind: "claim_without_job",
    })).toBe(1);
    expect(metrics.gauge_value("ingress_repairs_pending", {})).toBe(2);
    expect(metrics.render_prometheus()).not.toContain("wamid");
  });

  it("flags repair-aged orphans and a saturated batch", async () => {
    const scanner = new InMemoryIngressOrphanScanner([
      ingress_triple({ wamid: "wamid-old", has_inbound_row: false, job_status: "missing" }),
    ]);
    const summary = await run_reconciliation_pass({
      scanner,
      clock: () => NOW,
      batch_limit: 1,
      repair_age_threshold_ms: 1000,
    });
    expect(summary).toMatchObject({
      scanned: 1,
      needs_repair: 1,
      repair_aged: 1,
      batch_limited: true,
    });
  });

  it("wraps scanner failures with safe codes", async () => {
    const scanner = {
      scan_orphans: vi.fn(async () => {
        throw new Error("connection password=secret");
      }),
    };
    const error = await run_reconciliation_pass({ scanner, clock: () => NOW })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect(String(error)).not.toMatch(/secret/);
    await expect(run_reconciliation_pass({} as never)).rejects.toBeInstanceOf(
      IngressReconciliationError,
    );
  });

  it("forwards the abort signal to the scanner", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const scanner = {
      scan_orphans: vi.fn(async (_limit: number, signal?: AbortSignal) => {
        seen.push(signal);
        return [];
      }),
    };
    await run_reconciliation_pass({ scanner, clock: () => NOW, signal: controller.signal });
    expect(scanner.scan_orphans).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe(controller.signal);
  });

  it("fails closed on a pre-aborted signal without scanning", async () => {
    const controller = new AbortController();
    controller.abort();
    const scanner = { scan_orphans: vi.fn(async () => []) };
    const error = await run_reconciliation_pass({ scanner, clock: () => NOW, signal: controller.signal })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect((error as Error).message).toBe("ingress-pass-aborted");
    expect(scanner.scan_orphans).not.toHaveBeenCalled();
  });

  it("maps scanner AbortError rejections to a safe abort code", async () => {
    const scanner = {
      scan_orphans: vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    };
    const error = await run_reconciliation_pass({ scanner, clock: () => NOW })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect((error as Error).message).toBe("ingress-pass-aborted");
  });

  it("restores the abort code when a cancelled scan surfaces as a scan failure", async () => {
    const controller = new AbortController();
    const scanner = {
      scan_orphans: vi.fn(async () => {
        controller.abort();
        throw new IngressReconciliationError("ingress-scan-failed");
      }),
    };
    const error = await run_reconciliation_pass({ scanner, clock: () => NOW, signal: controller.signal })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(IngressReconciliationError);
    expect((error as Error).message).toBe("ingress-pass-aborted");
  });
});

describe("MetricsRegistry fail-loud contract", () => {
  it("throws RangeError on invalid values instead of dropping them silently", () => {
    const metrics = new MetricsRegistry();
    expect(() => metrics.increment("dropped_total", {}, Number.NaN)).toThrow(RangeError);
    expect(() => metrics.increment("dropped_total", {}, -1)).toThrow(RangeError);
    expect(() => metrics.set_gauge("frozen_gauge", Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => metrics.observe("skewed_ms", -5)).toThrow(RangeError);
    expect(metrics.render_prometheus()).not.toContain("dropped_total");
  });
});
