/** Map live Meta provider failure shapes to ledger error classification. */

import type { WaSendErrorCode } from "@repo/wa-sender";

/** Ledger-safe classification of one provider failure. */
export interface ProviderFailureClassification {
  /** Sanitized code persisted to the ledger; never carries provider text. */
  error_code: string;
  /** Whether a later retry with the same operation key is safe. */
  retryable: boolean;
  /** Whether the result is ambiguous and must fence as unknown. */
  ambiguous: boolean;
  /** Whether the failure means the 24h window closed and a template is required. */
  requires_template: boolean;
  /** Whether the credential is revoked or lacks privilege and needs rotation. */
  credential_revoked: boolean;
}

/** Untrusted provider failure observed at the transport boundary. */
export interface ProviderFailureInput {
  /** Stable sender code such as upstream_error or request_timeout. */
  code?: string;
  /** HTTP status when a provider response was received. */
  http_status?: number;
  /** Sanitized Meta error code or subcode, if one was parsed. */
  upstream_code?: string;
  /** True when the request timed out before a provider verdict. */
  timeout?: boolean;
  /** True when the request failed before any provider response. */
  network_failed?: boolean;
}

const RATE_LIMIT_CODES = new Set(["4", "17", "32", "130429", "131048", "80007"]);

const REVOKED_CODES = new Set(["10", "102", "190", "200", "298"]);

const WINDOW_CODES = new Set(["131047", "131051"]);

/**
 * Classify one provider failure into a ledger-safe retry decision.
 *
 * Timeout and network failures are ambiguous because the provider may have
 * accepted the message after the client gave up; callers must fence those
 * as unknown instead of resending. Every other shape fails closed as a
 * non-retryable terminal error unless it is an explicit rate limit or a
 * 5xx without a provider verdict.
 *
 * @param input - Untrusted failure fields from the transport boundary.
 * @returns Ledger-safe classification with a bounded error code.
 */
export function classify_provider_error(
  input: ProviderFailureInput,
): ProviderFailureClassification {
  const code = normalize_code(input.code);
  const upstream = normalize_upstream(input.upstream_code);
  const status = normalize_status(input.http_status);
  if (input.timeout === true || code === "request_timeout") {
    return make_result("provider_timeout", true, true, false, false);
  }
  if (input.network_failed === true || code === "request_failed") {
    return make_result("provider_timeout", true, true, false, false);
  }
  if (status === 429 || (upstream !== undefined && RATE_LIMIT_CODES.has(upstream))) {
    return make_result("provider_rate_limited", true, false, false, false);
  }
  if (
    status === 401
    || status === 403
    || (upstream !== undefined && REVOKED_CODES.has(upstream))
    || code.includes("revoked")
    || code.includes("auth")
  ) {
    return make_result("provider_token_revoked", false, false, false, true);
  }
  if (upstream !== undefined && WINDOW_CODES.has(upstream)) {
    return make_result("service_window_expired", false, false, true, false);
  }
  if (upstream !== undefined && (upstream.startsWith("132") || upstream.startsWith("133"))) {
    return make_result("provider_template_rejected", false, false, false, false);
  }
  if (upstream !== undefined && upstream.startsWith("131")) {
    return make_result("provider_message_rejected", false, false, false, false);
  }
  if (status !== undefined && status >= 500 && status <= 599 && code === "upstream_error") {
    return make_result("provider_unavailable", true, true, false, false);
  }
  if (code === "transport_error" || code === "upstream_error") {
    return make_result("provider_unavailable", true, true, false, false);
  }
  return make_result("provider_request_failed", false, false, false, false);
}

/**
 * Classify a sender error code without trusting its message text.
 *
 * @param code - Stable sender failure code.
 * @returns Ledger-safe classification for the code.
 */
export function classify_sender_code(code: WaSendErrorCode): ProviderFailureClassification {
  return classify_provider_error({ code });
}

function make_result(
  error_code: string,
  retryable: boolean,
  ambiguous: boolean,
  requires_template: boolean,
  credential_revoked: boolean,
): ProviderFailureClassification {
  return { error_code, retryable, ambiguous, requires_template, credential_revoked };
}

function normalize_code(value: string | undefined): string {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 64);
}

function normalize_upstream(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return undefined;
  return String(Number(trimmed));
}

function normalize_status(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isInteger(value) || value < 100 || value > 599) {
    return undefined;
  }
  return value;
}
