import { describe, expect, it } from "vitest";
import { MetricsRegistry, NoopMetrics } from "../src/observability/metrics.js";
import {
  continue_trace,
  format_traceparent,
  langfuse_event,
  new_span_id,
  new_trace_id,
  parse_traceparent,
  start_span,
  trace_id_from_request_id,
} from "../src/observability/trace.js";

describe("trace context", () => {
  it("generates OTel-shaped random ids", () => {
    expect(new_trace_id()).toMatch(/^[0-9a-f]{32}$/);
    expect(new_span_id()).toMatch(/^[0-9a-f]{16}$/);
    expect(new_trace_id()).not.toBe(new_trace_id());
  });

  it("derives a deterministic trace id per request id", () => {
    const first = trace_id_from_request_id("request-1");
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(trace_id_from_request_id("request-1")).toBe(first);
    expect(trace_id_from_request_id("request-2")).not.toBe(first);
  });

  it("rejects an invalid request id without hashing", () => {
    expect(() => trace_id_from_request_id("")).toThrow("request-id-invalid");
  });

  it("round-trips a valid W3C traceparent", () => {
    const context = { trace_id: new_trace_id(), span_id: new_span_id(), sampled: true };
    const parsed = parse_traceparent(format_traceparent(context));
    expect(parsed).toEqual(context);
  });

  it("fails open on absent or malformed traceparent values", () => {
    expect(parse_traceparent(undefined)).toBeNull();
    expect(parse_traceparent("")).toBeNull();
    expect(parse_traceparent("00-short-trace")).toBeNull();
    expect(parse_traceparent(`00-${"0".repeat(32)}-${new_span_id()}-01`)).toBeNull();
    expect(parse_traceparent("99-abcdef-01")).toBeNull();
  });

  it("continues an incoming trace with a fresh span id", () => {
    const parent = { trace_id: new_trace_id(), span_id: new_span_id(), sampled: false };
    const continued = continue_trace(format_traceparent(parent), "request-9");
    expect(continued.trace_id).toBe(parent.trace_id);
    expect(continued.span_id).not.toBe(parent.span_id);
    expect(continued.sampled).toBe(false);
  });

  it("derives a fresh trace when the incoming header is unusable", () => {
    const continued = continue_trace("garbage", "request-9");
    expect(continued.trace_id).toBe(trace_id_from_request_id("request-9"));
    expect(continued.span_id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("records span duration once with a result label", () => {
    const metrics = new MetricsRegistry();
    let now = 1_000;
    const span = start_span(metrics, "webhook_handle", continue_trace(undefined, "request-1"), () => now);
    now += 250;
    span.end("accepted");
    span.end("accepted");
    expect(metrics.render_prometheus()).toContain(
      'webhook_handle_duration_ms_count{result="accepted"} 1',
    );
    expect(metrics.render_prometheus()).toContain('webhook_handle_duration_ms_sum{result="accepted"} 250');
  });

  it("rejects invalid span names, results, and contexts", () => {
    const metrics = new NoopMetrics();
    const parent = continue_trace(undefined, "request-1");
    expect(() => start_span(metrics, "has space", parent)).toThrow("span-name-invalid");
    expect(() => start_span(metrics, "ok", { trace_id: "bad", span_id: "bad", sampled: true })).toThrow(
      "trace-context-invalid",
    );
    expect(() => start_span(metrics, "ok", parent).end("bad result")).toThrow("span-result-invalid");
  });
});

describe("langfuse trace events", () => {
  it("builds a PII-free event with allowlisted fields only", () => {
    const context = continue_trace(undefined, "request-7");
    const event = langfuse_event("graph_turn", context, { tenant_id: "42", code: "slot_offered" });
    expect(event.name).toBe("graph_turn");
    expect(event.trace_id).toBe(context.trace_id);
    expect(event.tenant_id).toBe("42");
    expect(event.code).toBe("slot_offered");
    expect(JSON.stringify(event)).not.toContain("+1555");
    expect(Object.keys(event).sort()).toEqual(
      ["code", "name", "observed_at_iso", "span_id", "tenant_id", "trace_id"].sort(),
    );
  });

  it("rejects invalid names, contexts, and unsafe fields", () => {
    const context = continue_trace(undefined, "request-7");
    expect(() => langfuse_event("bad name", context)).toThrow("trace-event-invalid");
    expect(() => langfuse_event("ok", context, { tenant_id: "" })).toThrow("trace-field-invalid");
    expect(() => langfuse_event("ok", context, { duration_ms: Number.NaN })).toThrow("trace-duration-invalid");
  });
});
