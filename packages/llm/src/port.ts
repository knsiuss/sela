/**
 * Provider-agnostic model port for the appointment understanding layer.
 *
 * The port is intentionally narrow: it takes a bounded, already-scrubbed
 * instruction payload and returns raw model text. It never parses intent,
 * never sees tenant identifiers, and never decides anything — the caller owns
 * schema validation and every downstream authorization decision.
 */

import { z } from "zod";
import {
  MAX_REDACTED_TEXT_CHARS,
  redact_pii,
} from "./redaction.js";

/** Longest prompt text accepted by any adapter; keeps cost and abuse bounded. */
export const MAX_PROMPT_CHARS = 4_000;

/** Maximum assistant tokens requested per call. */
export const MAX_OUTPUT_TOKENS = 512;

/** Default per-attempt deadline; the worker has a 3s ACK budget downstream. */
export const DEFAULT_TIMEOUT_MS = 2_000;

/** Hard ceiling on attempts so a retry storm cannot exhaust the worker loop. */
export const MAX_ATTEMPTS = 3;

/** Stable failure categories safe to record in metrics and audit events. */
export type ModelPortErrorCode =
  | "not_configured"
  | "invalid_request"
  | "timeout"
  | "provider_error"
  | "invalid_response";

/**
 * Sanitized adapter failure.
 *
 * Carries a stable code and HTTP status only. Provider response bodies and
 * credentials are deliberately not retained: an adapter must never be able to
 * leak either into a log line or a `process_job` failure code.
 */
export class ModelPortError extends Error {
  /** Stable sanitized failure code. */
  readonly code: ModelPortErrorCode;

  /** Provider HTTP status when one was received, never the response body. */
  readonly status?: number;

  /**
   * Create a sanitized adapter failure.
   *
   * @param code - Stable failure category.
   * @param message - Sanitized, PII-free description.
   * @param status - Provider HTTP status when known.
   */
  constructor(code: ModelPortErrorCode, message: string, status?: number) {
    super(message);
    this.name = "ModelPortError";
    this.code = code;
    this.status = status;
  }
}

/** One bounded completion request handed to a provider adapter. */
export const model_request_schema = z.object({
  /** Redacted customer text. Never an instruction the caller trusts. */
  user_text: z.string().min(1).max(MAX_PROMPT_CHARS),
  /** Redacted few-shot context or state summary. Optional. */
  context: z.string().max(MAX_PROMPT_CHARS).optional(),
  /** Positive token ceiling for the assistant turn. */
  max_output_tokens: z.number().int().min(1).max(MAX_OUTPUT_TOKENS),
  /** Per-call deadline; adapters must abort rather than hang. */
  timeout_ms: z.number().int().min(1).max(30_000),
}).strict();

/** A validated, bounded completion request. */
export type ModelRequest = z.infer<typeof model_request_schema>;

/** Provider-agnostic completion result. */
export interface ModelResponse {
  /** Raw assistant text. Untrusted until the caller schema-validates it. */
  text: string;
  /** Provider identifier, for example `anthropic`. */
  provider: string;
  /** Model identifier the provider actually served. */
  model: string;
  /** Prompt tokens consumed, when the provider reports them. */
  input_tokens?: number;
  /** Completion tokens consumed, when the provider reports them. */
  output_tokens?: number;
}

/** Optional metrics seam; labels must be bounded and PII-free. */
export interface ModelMetricsSink {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
  observe(name: string, value_ms: number, labels?: Readonly<Record<string, string>>): void;
}

/** Dependencies every adapter may accept. */
export interface ModelAdapterOptions {
  timeout_ms?: number;
  max_attempts?: number;
  metrics?: ModelMetricsSink;
}

/**
 * The single seam the agent calls for model work.
 *
 * Implementations must reject rather than silently succeed, must never return
 * unredacted text, and must never log request content or credentials.
 */
export interface ModelPort {
  /** Stable provider identifier used as a metric label. */
  readonly provider: string;

  /** True only when the adapter has everything it needs to serve a call. */
  is_configured(): boolean;

  /**
   * Run one bounded completion.
   *
   * @param request - Validated, bounded, already-redacted request.
   * @returns Raw provider text plus token accounting.
   * @throws ModelPortError on any failure, with no body or credential attached.
   */
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Validate and redact a caller-supplied request before any provider I/O.
 *
 * Redaction happens here rather than in each adapter so a new adapter cannot
 * accidentally ship an unscrubbed path.
 *
 * @param value - Untrusted request assembled by the caller.
 * @returns A bounded request whose every text field is PII-scrubbed.
 * @throws ModelPortError When the request violates a bound.
 */
export function build_model_request(value: unknown): ModelRequest {
  const parsed = model_request_schema.safeParse(value);
  if (!parsed.success) throw new ModelPortError("invalid_request", "model-request-invalid");
  return {
    ...parsed.data,
    user_text: redact_pii(parsed.data.user_text),
    ...(parsed.data.context === undefined ? {} : { context: redact_pii(parsed.data.context) }),
  };
}

/** Truncate provider text to the shared outbound bound. */
export function bound_model_text(text: string): string {
  if (text.length <= MAX_REDACTED_TEXT_CHARS) return text;
  return text.slice(0, MAX_REDACTED_TEXT_CHARS);
}

/** Resolve an optional positive attempt count inside a hard ceiling. */
export function resolve_max_attempts(value: number | undefined): number {
  if (value === undefined) return MAX_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ModelPortError("invalid_request", "max-attempts-invalid");
  }
  return Math.min(value, MAX_ATTEMPTS);
}