/** Analytics event taxonomy, approved aggregate metrics, and access controls. */

import { AnalyticsEvent, anonymize_for_analytics } from "./data_lifecycle.js";

/**
 * Approved analytics actions.
 *
 * The set is closed so no free-form string can become a warehouse dimension or
 * smuggle customer content into a metric label.
 */
export const ANALYTICS_ACTIONS: readonly string[] = Object.freeze([
  "inbound_message",
  "outbound_message",
  "appointment_booked",
  "appointment_rescheduled",
  "appointment_cancelled",
  "appointment_no_show",
  "handoff_requested",
]);

/** Approved analytics outcomes; kept small to bound dashboard cardinality. */
export const ANALYTICS_OUTCOMES: readonly string[] = Object.freeze([
  "succeeded",
  "failed",
  "needs_human",
  "duplicate_suppressed",
  "rate_limited",
]);

/**
 * Dimensions an aggregate may be grouped by.
 *
 * Hashed identifiers are deliberately absent: grouping by them would rebuild
 * the per-sender and per-conversation linkage that hashing exists to break, so
 * only taxonomy and coarse bucket values may be aggregated.
 */
export type AnalyticsDimension = "action" | "outcome" | "message_length_bucket";

/** One approved aggregate metric and the dimensions it may be grouped by. */
export interface MetricDefinition {
  metric_id: string;
  allowed_dimensions: readonly AnalyticsDimension[];
}

/** Approved aggregate metrics; anything else is rejected as unapproved. */
export const APPROVED_METRICS: readonly MetricDefinition[] = Object.freeze<MetricDefinition[]>([
  { metric_id: "event_count", allowed_dimensions: ["action", "outcome", "message_length_bucket"] },
  { metric_id: "appointment_completions", allowed_dimensions: ["action"] },
  { metric_id: "message_length_mix", allowed_dimensions: ["message_length_bucket"] },
]);

/** Roles permitted to read analytics, resolved by deny-by-default checks. */
export type AnalyticsRole = "analytics_viewer" | "analytics_admin";

/** One requested analytics read. */
export interface AnalyticsAccessRequest {
  role: AnalyticsRole;
  tenant_id: string;
  metric_id: string;
}

/** One grouped aggregate bucket; counts only, never raw content. */
export interface MetricBucket {
  dimension: string;
  value: string;
  count: number;
}

/** Result of aggregating approved events into one approved metric. */
export interface MetricAggregate {
  metric_id: string;
  total: number;
  buckets: readonly MetricBucket[];
}

/** Safe failure for an unapproved analytics contract or unauthorized read. */
export class AnalyticsContractError extends Error {
  readonly code = "analytics_contract_invalid";

  /** Create a sanitized analytics-contract failure. */
  constructor(reason: string) {
    super(reason);
    this.name = "AnalyticsContractError";
  }
}

/**
 * Build an analytics event restricted to the approved taxonomy.
 *
 * Raw content is only ever accepted to be hashed by the shared redaction
 * boundary, so an event can carry a coarse length bucket but never the text,
 * recipient, or conversation it was derived from.
 *
 * @param input - Caller-supplied event candidate.
 * @returns PII-free event whose action and outcome are taxonomy members.
 */
export function build_analytics_event(input: unknown): AnalyticsEvent {
  if (typeof input !== "object" || input === null) throw new AnalyticsContractError("analytics-event-invalid");
  const record = input as Record<string, unknown>;
  if (!is_member(record.action, ANALYTICS_ACTIONS)) throw new AnalyticsContractError("analytics-action-unapproved");
  if (!is_member(record.outcome, ANALYTICS_OUTCOMES)) throw new AnalyticsContractError("analytics-outcome-unapproved");
  return anonymize_for_analytics({
    tenant_id: record.tenant_id as string,
    action: record.action as string,
    outcome: record.outcome as string,
    sender_ref: record.sender_ref as string | undefined,
    message_text: record.message_text as string | undefined,
    conversation_id: record.conversation_id as string | undefined,
  });
}

/**
 * Aggregate approved events into one approved metric.
 *
 * @param metric_id - Metric to compute; must be in the approved set.
 * @param events - Events previously produced by {@link build_analytics_event}.
 * @returns Frozen aggregate whose buckets use only allowed dimensions.
 */
export function compute_approved_metric(metric_id: string, events: readonly AnalyticsEvent[]): MetricAggregate {
  const definition = approved_metric(metric_id);
  if (!Array.isArray(events)) throw new AnalyticsContractError("analytics-events-invalid");
  const counts = new Map<string, MetricBucket>();
  for (const event of events) {
    if (typeof event !== "object" || event === null) throw new AnalyticsContractError("analytics-event-invalid");
    for (const dimension of definition.allowed_dimensions) {
      const value = dimension_value(event, dimension);
      if (value === null) continue;
      const key = `${dimension}=${value}`;
      const existing = counts.get(key);
      counts.set(key, Object.freeze({
        dimension,
        value,
        count: (existing?.count ?? 0) + 1,
      }));
    }
  }
  const buckets = [...counts.values()].sort(by_dimension_then_value);
  return Object.freeze({ metric_id: definition.metric_id, total: events.length, buckets: Object.freeze(buckets) });
}

/**
 * Authorize an analytics read before any aggregation runs.
 *
 * Rejection happens ahead of any lookup so an unauthorized caller cannot learn
 * whether a tenant or metric exists by observing a different error.
 *
 * @param request - Role, tenant, and metric the caller wants to read.
 */
export function authorize_analytics_query(request: AnalyticsAccessRequest): void {
  if (typeof request !== "object" || request === null) throw new AnalyticsContractError("analytics-access-denied");
  const role = request.role;
  if (role !== "analytics_viewer" && role !== "analytics_admin") {
    throw new AnalyticsContractError("analytics-access-denied");
  }
  if (!/^[1-9]\d{0,18}$/.test(request.tenant_id)) throw new AnalyticsContractError("analytics-access-denied");
  // Denials stay uniform so a caller cannot probe which tenants or metrics exist.
  if (!APPROVED_METRICS.some((definition) => definition.metric_id === request.metric_id)) {
    throw new AnalyticsContractError("analytics-access-denied");
  }
  if (role === "analytics_viewer" && request.metric_id === "message_length_mix") {
    throw new AnalyticsContractError("analytics-access-denied");
  }
}

function approved_metric(metric_id: string): MetricDefinition {
  const definition = APPROVED_METRICS.find((candidate) => candidate.metric_id === metric_id);
  if (definition === undefined) throw new AnalyticsContractError("analytics-metric-unapproved");
  return definition;
}

function dimension_value(event: AnalyticsEvent, dimension: AnalyticsDimension): string | null {
  const value = event[dimension];
  return typeof value === "string" ? value : null;
}

function by_dimension_then_value(left: MetricBucket, right: MetricBucket): number {
  if (left.dimension !== right.dimension) return left.dimension < right.dimension ? -1 : 1;
  if (left.value !== right.value) return left.value < right.value ? -1 : 1;
  return 0;
}

function is_member(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}