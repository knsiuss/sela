/** Explicit SLO and paging thresholds for the appointment worker. */

export const SLO_TARGETS = Object.freeze({
  webhook_ack_availability: 0.999,
  webhook_ack_latency_ms: 3_000,
  ingress_acceptance: 0.9995,
  worker_processing: 0.995,
  worker_oldest_job_ms: 60_000,
  outbound_delivery: 0.99,
  outbound_delivery_latency_ms: 300_000,
});

/** One bounded point-in-time reliability snapshot. */
export interface SloSnapshot {
  webhook_total: number;
  webhook_accepted: number;
  webhook_ack_latency_p95_ms: number;
  worker_total: number;
  worker_succeeded: number;
  worker_oldest_job_age_ms: number;
  outbound_total: number;
  outbound_delivered: number;
  outbound_delivery_latency_p95_ms: number;
}

/** One evaluated service-level objective. */
export interface SloEvaluation {
  name: string;
  target: number;
  observed: number;
  is_healthy: boolean;
  error_budget_remaining: number;
  reason: string;
}

/** One alert candidate with a stable, low-cardinality identifier. */
export interface AlertEvaluation {
  name: string;
  severity: "warning" | "critical";
  is_firing: boolean;
  observed: number;
  threshold: number;
  reason: string;
}

/** Evaluate all service objectives without logging raw request content. */
export function evaluate_slos(snapshot: SloSnapshot): SloEvaluation[] {
  return [
    ratio_slo(
      "webhook_ack_availability",
      SLO_TARGETS.webhook_ack_availability,
      snapshot.webhook_accepted,
      snapshot.webhook_total,
      "signed webhook ACK failures",
    ),
    ratio_slo(
      "ingress_acceptance",
      SLO_TARGETS.ingress_acceptance,
      snapshot.webhook_accepted,
      snapshot.webhook_total,
      "webhook messages not accepted",
    ),
    ratio_slo(
      "worker_processing",
      SLO_TARGETS.worker_processing,
      snapshot.worker_succeeded,
      snapshot.worker_total,
      "worker processing failures",
    ),
    ratio_slo(
      "outbound_delivery",
      SLO_TARGETS.outbound_delivery,
      snapshot.outbound_delivered,
      snapshot.outbound_total,
      "outbound delivery failures",
    ),
  ];
}

/** Evaluate paging and ticket thresholds from the same bounded snapshot. */
export function evaluate_alerts(snapshot: SloSnapshot): AlertEvaluation[] {
  const results = evaluate_slos(snapshot);
  return [
    latency_alert(
      "webhook_ack_latency",
      snapshot.webhook_ack_latency_p95_ms,
      SLO_TARGETS.webhook_ack_latency_ms,
      "critical",
    ),
    queue_alert(snapshot.worker_oldest_job_age_ms),
    latency_alert(
      "outbound_delivery_latency",
      snapshot.outbound_delivery_latency_p95_ms,
      SLO_TARGETS.outbound_delivery_latency_ms,
      "warning",
    ),
    ...results
      .filter((result) => !result.is_healthy)
      .map((result) => ({
        name: `${result.name}_error_budget`,
        severity: "critical" as const,
        is_firing: true,
        observed: result.observed,
        threshold: result.target,
        reason: result.reason,
      })),
  ];
}

/** Convert a successful/total ratio to an error-budget evaluation. */
function ratio_slo(
  name: string,
  target: number,
  successful: number,
  total: number,
  failure_reason: string,
): SloEvaluation {
  if (![successful, total].every((value) => Number.isFinite(value) && value >= 0) || successful > total) {
    return {
      name,
      target,
      observed: 0,
      is_healthy: false,
      error_budget_remaining: 0,
      reason: "snapshot-invalid",
    };
  }
  const observed = total === 0 ? 1 : successful / total;
  const error_rate = 1 - observed;
  const budget_rate = 1 - target;
  return {
    name,
    target,
    observed,
    is_healthy: observed >= target,
    error_budget_remaining: budget_rate === 0 ? 0 : Math.max(0, 1 - error_rate / budget_rate),
    reason: observed >= target ? "within-target" : failure_reason,
  };
}

function latency_alert(
  name: string,
  observed: number,
  threshold: number,
  severity: "warning" | "critical",
): AlertEvaluation {
  const is_valid = Number.isFinite(observed) && observed >= 0;
  const is_firing = is_valid && observed > threshold;
  return {
    name,
    severity,
    is_firing,
    observed: is_valid ? observed : 0,
    threshold,
    reason: is_firing ? "latency-threshold-exceeded" : "within-threshold",
  };
}

function queue_alert(observed: number): AlertEvaluation {
  const is_valid = Number.isFinite(observed) && observed >= 0;
  const threshold = SLO_TARGETS.worker_oldest_job_ms;
  const is_firing = is_valid && observed > threshold;
  return {
    name: "worker_queue_age",
    severity: "critical",
    is_firing,
    observed: is_valid ? observed : 0,
    threshold,
    reason: is_firing ? "oldest-job-age-exceeded" : "within-threshold",
  };
}
