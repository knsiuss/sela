import { describe, expect, it } from "vitest";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { evaluate_alerts, evaluate_slos } from "../src/observability/slo.js";

describe("service observability", () => {
  it("renders bounded counters and histograms in deterministic Prometheus text", () => {
    const metrics = new MetricsRegistry();
    metrics.increment("http_requests_total", { method: "POST", path: "/webhooks/whatsapp", status: "200" });
    metrics.observe("http_request_duration_ms", 125, { method: "POST", path: "/webhooks/whatsapp" });
    const rendered = metrics.render_prometheus();
    expect(rendered).toContain('http_requests_total{method="POST",path="/webhooks/whatsapp",status="200"} 1');
    expect(rendered).toContain('http_request_duration_ms_count{method="POST",path="/webhooks/whatsapp"} 1');
    expect(rendered).toContain('http_request_duration_ms_bucket{le="+Inf",method="POST",path="/webhooks/whatsapp"} 1');
  });

  it("calculates SLO health, error budget, and paging thresholds", () => {
    const healthy = evaluate_slos({
      webhook_total: 1000,
      webhook_accepted: 1000,
      webhook_ack_latency_p95_ms: 1200,
      worker_total: 1000,
      worker_succeeded: 997,
      worker_oldest_job_age_ms: 20_000,
      outbound_total: 1000,
      outbound_delivered: 995,
      outbound_delivery_latency_p95_ms: 120_000,
    });
    expect(healthy.every((item) => item.is_healthy)).toBe(true);
    expect(evaluate_alerts({
      webhook_total: 100,
      webhook_accepted: 80,
      webhook_ack_latency_p95_ms: 4_000,
      worker_total: 100,
      worker_succeeded: 80,
      worker_oldest_job_age_ms: 90_000,
      outbound_total: 100,
      outbound_delivered: 70,
      outbound_delivery_latency_p95_ms: 400_000,
    }).filter((alert) => alert.is_firing).length).toBeGreaterThanOrEqual(5);
  });
});
