import { describe, expect, it } from "vitest";
import {
  ANALYTICS_ACTIONS,
  AnalyticsContractError,
  APPROVED_METRICS,
  authorize_analytics_query,
  build_analytics_event,
  compute_approved_metric,
} from "../src/enterprise/analytics_contract.js";

const EVENT_INPUT = {
  tenant_id: "42",
  action: "appointment_booked",
  outcome: "succeeded",
  sender_ref: "opaque-sender",
  message_text: "I would like to book an appointment",
  conversation_id: "conversation-1",
};

describe("analytics event taxonomy", () => {
  it("emits a PII-free event for an approved action and outcome", () => {
    const event = build_analytics_event(EVENT_INPUT);
    expect(event).toMatchObject({
      tenant_id: "42",
      action: "appointment_booked",
      outcome: "succeeded",
      message_length_bucket: "medium",
    });
    expect(event.sender_ref_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never carries raw content, recipient, or conversation identifiers", () => {
    const serialized = JSON.stringify(build_analytics_event(EVENT_INPUT));
    expect(serialized).not.toContain("I would like to book an appointment");
    expect(serialized).not.toContain("opaque-sender");
    expect(serialized).not.toContain("conversation-1");
  });

  it("rejects an action outside the approved taxonomy", () => {
    expect(() => build_analytics_event({ ...EVENT_INPUT, action: "free_form_debug_label" }))
      .toThrow(AnalyticsContractError);
  });

  it("rejects an outcome outside the approved taxonomy", () => {
    expect(() => build_analytics_event({ ...EVENT_INPUT, outcome: "probably_fine" }))
      .toThrow(AnalyticsContractError);
  });

  it.each([
    ["non-object input", "event"],
    ["null input", null],
    ["missing tenant", { ...EVENT_INPUT, tenant_id: undefined }],
    ["non-numeric tenant", { ...EVENT_INPUT, tenant_id: "clinic" }],
  ])("rejects %s", (_label, input) => {
    expect(() => build_analytics_event(input)).toThrow();
  });

  it("keeps the action and outcome taxonomies closed", () => {
    expect(Object.isFrozen(ANALYTICS_ACTIONS)).toBe(true);
    expect(ANALYTICS_ACTIONS).toContain("appointment_booked");
    expect(ANALYTICS_ACTIONS).not.toContain("free_form_debug_label");
  });
});

describe("approved aggregate metrics", () => {
  const events = [
    build_analytics_event(EVENT_INPUT),
    build_analytics_event({ ...EVENT_INPUT, message_text: "hi", outcome: "failed" }),
    build_analytics_event({ ...EVENT_INPUT, action: "appointment_rescheduled" }),
  ];

  it("counts events and groups them by approved dimensions only", () => {
    const aggregate = compute_approved_metric("event_count", events);
    expect(aggregate.total).toBe(3);
    expect(aggregate.buckets).toContainEqual({ dimension: "action", value: "appointment_booked", count: 2 });
    expect(aggregate.buckets).toContainEqual({ dimension: "outcome", value: "failed", count: 1 });
  });

  it("restricts each metric to its approved dimensions", () => {
    const completions = compute_approved_metric("appointment_completions", events);
    expect(completions.buckets.every((bucket) => bucket.dimension === "action")).toBe(true);
    const mix = compute_approved_metric("message_length_mix", events);
    expect(mix.buckets.every((bucket) => bucket.dimension === "message_length_bucket")).toBe(true);
  });

  it("never exposes a hashed identifier as an aggregatable dimension", () => {
    const forbidden = ["sender_ref_hash", "message_hash", "conversation_ref_hash"];
    for (const definition of APPROVED_METRICS) {
      expect(definition.allowed_dimensions.some((dimension) => forbidden.includes(dimension))).toBe(false);
    }
  });

  it("rejects a metric outside the approved set", () => {
    expect(() => compute_approved_metric("revenue_by_customer", events)).toThrow(AnalyticsContractError);
  });

  it("rejects a malformed event instead of aggregating it", () => {
    expect(() => compute_approved_metric("event_count", [null as never])).toThrow(AnalyticsContractError);
  });

  it("keeps aggregates frozen and deterministic in order", () => {
    const first = compute_approved_metric("event_count", events);
    const second = compute_approved_metric("event_count", events);
    expect(first.buckets).toEqual(second.buckets);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.buckets)).toBe(true);
  });

  it("skips absent dimensions instead of inventing a bucket", () => {
    const no_text = build_analytics_event({
      tenant_id: "42",
      action: "handoff_requested",
      outcome: "needs_human",
    });
    const mix = compute_approved_metric("message_length_mix", [no_text]);
    expect(mix.buckets).toEqual([]);
  });
});

describe("analytics access controls", () => {
  it("allows an admin to read an approved metric", () => {
    expect(() => authorize_analytics_query({ role: "analytics_admin", tenant_id: "42", metric_id: "event_count" }))
      .not.toThrow();
  });

  it("allows a viewer to read a standard aggregate", () => {
    expect(() => authorize_analytics_query({ role: "analytics_viewer", tenant_id: "42", metric_id: "event_count" }))
      .not.toThrow();
  });

  it("denies a viewer the message-length mix metric", () => {
    expect(() => authorize_analytics_query({ role: "analytics_viewer", tenant_id: "42", metric_id: "message_length_mix" }))
      .toThrow(AnalyticsContractError);
  });

  it.each([
    ["unknown role", { role: "superuser", tenant_id: "42", metric_id: "event_count" }],
    ["missing role", { tenant_id: "42", metric_id: "event_count" }],
    ["non-numeric tenant", { role: "analytics_admin", tenant_id: "clinic", metric_id: "event_count" }],
    ["unapproved metric", { role: "analytics_admin", tenant_id: "42", metric_id: "revenue" }],
  ])("denies by default for %s", (_label, request) => {
    expect(() => authorize_analytics_query(request as never)).toThrow(AnalyticsContractError);
  });

  it("returns the same denial for an unknown tenant and an unknown metric", () => {
    const deniedByTenant = capture_reason({ role: "analytics_admin", tenant_id: "clinic", metric_id: "event_count" });
    const deniedByMetric = capture_reason({ role: "analytics_admin", tenant_id: "42", metric_id: "revenue" });
    expect(deniedByTenant).toBe(deniedByMetric);
  });
});

function capture_reason(request: unknown): string {
  try {
    authorize_analytics_query(request as never);
    return "allowed";
  } catch (error) {
    return (error as Error).message;
  }
}