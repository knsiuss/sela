/**
 * Tenant-resolution observability for the WhatsApp ingress boundary.
 *
 * A delivery that returns HTTP 200 and queues nothing is a silent data-loss
 * class failure. Two different causes produce it: a channel account that could
 * not be read out of the payload at all, and a present account that names no
 * known tenant. Both are the documented fail-closed `unresolved_count`, but only
 * the first indicates a broken ingress, so they must stay distinguishable in
 * metrics and logs rather than collapsing into one counter.
 *
 * The account id, tenant id, phone number, and message content are never
 * recorded here; the series carry a bounded result token only, so they stay
 * low-cardinality and PII-free.
 */

import type { MetricsSink } from "../observability/metrics.js";

/** Running tenant-resolution outcome for one webhook delivery. */
export interface TenantResolutionTracker {
  /** Total unresolved events; the public `unresolved_count` contract value. */
  total: number;
  /** Unresolved events whose channel account could not be read at all. */
  missing_account_count: number;
  /** Unresolved events whose channel account named no known tenant. */
  unknown_channel_count: number;
  /** Record an unresolved event and classify why it could not be resolved. */
  record(channel_account_id: string): void;
  /** Record one event that resolved to a tenant. */
  record_resolved(): void;
}

/** Metric emitted for every tenant-resolution attempt. */
const RESOLUTION_METRIC = "webhook_tenant_resolution_total";

/**
 * Create the per-delivery tenant-resolution tracker.
 *
 * @param metrics - Optional metrics sink; resolution still counts without one.
 * @returns A tracker that meters resolved, missing-account, and unknown-channel outcomes.
 */
export function create_tenant_resolution_tracker(metrics: MetricsSink | undefined): TenantResolutionTracker {
  const tracker: TenantResolutionTracker = {
    total: 0,
    missing_account_count: 0,
    unknown_channel_count: 0,
    record(channel_account_id: string): void {
      tracker.total += 1;
      if (channel_account_id === "") {
        tracker.missing_account_count += 1;
        metrics?.increment(RESOLUTION_METRIC, { result: "channel_account_missing" });
        return;
      }
      tracker.unknown_channel_count += 1;
      metrics?.increment(RESOLUTION_METRIC, { result: "unknown_channel" });
    },
    record_resolved(): void {
      metrics?.increment(RESOLUTION_METRIC, { result: "resolved" });
    },
  };
  return tracker;
}

/**
 * Write one bounded PII-free line when a delivery resolved no tenant at all.
 *
 * Emitted once per delivery rather than once per message so a batch of
 * unresolved events cannot flood the log, and carries only the request id, the
 * reason tokens, and the count.
 *
 * @param request_id - Correlation id shared by every line of this delivery.
 * @param tracker - Tracker holding this delivery's classified outcomes.
 */
export function log_incomplete_tenant_resolution(request_id: string, tracker: TenantResolutionTracker): void {
  if (tracker.total === 0) return;
  const reasons: string[] = [];
  if (tracker.missing_account_count > 0) reasons.push("channel_account_missing");
  if (tracker.unknown_channel_count > 0) reasons.push("unknown_channel");
  console.warn(JSON.stringify({
    event: "webhook_tenant_resolution_incomplete",
    request_id,
    reason: reasons.join("+"),
    unresolved_count: tracker.total,
  }));
}