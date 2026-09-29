/** OTel-compatible trace context and PII-free Langfuse event hooks. */

import { createHash, randomBytes } from "node:crypto";
import type { MetricsSink } from "./metrics.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** OTel-compatible trace context carried across HTTP/ingress/worker boundaries. */
export interface TraceContext {
  trace_id: string;
  span_id: string;
  sampled: boolean;
}

/** Active span handle; end() records duration exactly once. */
export interface ActiveSpan {
  context: TraceContext;
  end(result: string): void;
}

/** PII-free Langfuse-compatible turn/span event (allowlist fields only). */
export interface LangfuseTraceEvent {
  name: string;
  trace_id: string;
  span_id: string;
  observed_at_iso: string;
  tenant_id?: string;
  code?: string;
  duration_ms?: number;
}

/**
 * Generate a random OTel 128-bit trace id as 32 lowercase hex chars.
 *
 * @returns Fresh trace id.
 */
export function new_trace_id(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Generate a random OTel 64-bit span id as 16 lowercase hex chars.
 *
 * @returns Fresh span id.
 */
export function new_span_id(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Derive a deterministic trace id from a request id without schema changes.
 *
 * Boundaries that cannot carry a traceparent (queue rows, ledger keys) use
 * this so logs and metrics correlate on one stable id per request.
 *
 * @param request_id - Existing request correlation id (uuid or opaque).
 * @returns 32-char deterministic trace id.
 */
export function trace_id_from_request_id(request_id: string): string {
  if (typeof request_id !== "string" || request_id.length === 0 || request_id.length > 256) {
    throw new TypeError("request-id-invalid");
  }
  return createHash("sha256").update(request_id, "utf8").digest("hex").slice(0, 32);
}

/**
 * Parse a W3C traceparent header value, fail-open for propagation.
 *
 * @param value - Raw traceparent header value or undefined.
 * @returns Trace context, or null when absent/malformed (caller derives fresh).
 */
export function parse_traceparent(value: string | undefined): TraceContext | null {
  if (typeof value !== "string") return null;
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (match === null) return null;
  const trace_id = match[1]!;
  const span_id = match[2]!;
  if (trace_id === "0".repeat(32) || span_id === "0".repeat(16)) return null;
  return { trace_id, span_id, sampled: match[3] !== "00" };
}

/**
 * Format a W3C traceparent header value for downstream propagation.
 *
 * @param context - Trace context to encode.
 * @returns `00-<trace_id>-<span_id>-<flags>` value.
 */
export function format_traceparent(context: TraceContext): string {
  require_trace_context(context);
  return `00-${context.trace_id}-${context.span_id}-${context.sampled ? "01" : "00"}`;
}

/**
 * Continue an incoming trace or start a deterministic one for this request.
 *
 * The span id is always fresh so sibling boundaries never share a span;
 * the trace id is preserved from a valid incoming header, else derived
 * from the request id for stable cross-boundary correlation.
 *
 * @param incoming - Raw incoming traceparent header value.
 * @param request_id - Request correlation id used as derivation fallback.
 * @returns Trace context for this boundary.
 */
export function continue_trace(incoming: string | undefined, request_id: string): TraceContext {
  const parent = parse_traceparent(incoming);
  return {
    trace_id: parent === null ? trace_id_from_request_id(request_id) : parent.trace_id,
    span_id: new_span_id(),
    sampled: parent?.sampled ?? true,
  };
}

/**
 * Start a child span that observes its duration on end().
 *
 * @param metrics - Sink for the `<name>_duration_ms` histogram; undefined disables recording.
 * @param name - Span/operation name (metric-safe, no tenant or content).
 * @param parent - Parent trace context.
 * @param now_ms - Clock for tests; defaults to Date.now.
 * @returns Active span; end() is idempotent and validates the result label.
 */
export function start_span(
  metrics: MetricsSink | undefined,
  name: string,
  parent: TraceContext,
  now_ms: () => number = Date.now,
): ActiveSpan {
  if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) || name.length > 64) throw new TypeError("span-name-invalid");
  require_trace_context(parent);
  const context: TraceContext = { trace_id: parent.trace_id, span_id: new_span_id(), sampled: parent.sampled };
  const started = now_ms();
  let ended = false;
  return {
    context,
    end(result: string): void {
      if (ended) return;
      if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(result) || result.length > 64) throw new TypeError("span-result-invalid");
      ended = true;
      metrics?.observe(`${name}_duration_ms`, Math.max(0, now_ms() - started), { result });
    },
  };
}

/**
 * Build a Langfuse-compatible event with PII filtering by construction.
 *
 * Only allowlisted safe fields are copied; message text, recipients, phone
 * numbers, tokens, and raw payloads can never enter the event because there
 * is no parameter that accepts them.
 *
 * @param name - Event name (graph turn, tool call, provider send).
 * @param context - Trace context to attach.
 * @param safe - Optional allowlisted dimensions (ids and codes only).
 * @returns PII-free trace event.
 */
export function langfuse_event(
  name: string,
  context: TraceContext,
  safe: { tenant_id?: string; code?: string; duration_ms?: number } = {},
): LangfuseTraceEvent {
  if (!/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(name) || name.length > 64) throw new TypeError("trace-event-invalid");
  require_trace_context(context);
  const event: LangfuseTraceEvent = {
    name,
    trace_id: context.trace_id,
    span_id: context.span_id,
    observed_at_iso: new Date().toISOString(),
  };
  if (safe.tenant_id !== undefined) event.tenant_id = require_safe_token(safe.tenant_id, 128);
  if (safe.code !== undefined) event.code = require_safe_token(safe.code, 64);
  if (safe.duration_ms !== undefined) {
    if (!Number.isFinite(safe.duration_ms) || safe.duration_ms < 0) throw new TypeError("trace-duration-invalid");
    event.duration_ms = safe.duration_ms;
  }
  return event;
}

function require_trace_context(context: TraceContext): void {
  if (
    typeof context !== "object" ||
    context === null ||
    !TRACE_ID_PATTERN.test(context.trace_id) ||
    !SPAN_ID_PATTERN.test(context.span_id) ||
    typeof context.sampled !== "boolean"
  ) {
    throw new TypeError("trace-context-invalid");
  }
}

function require_safe_token(value: string, max_length: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max_length || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError("trace-field-invalid");
  }
  return value;
}
