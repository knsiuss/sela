/** Versioned, authenticated operator API boundary. */

import { randomUUID } from "node:crypto";
import {
  AuthorizationError,
  require_oidc_verifier,
  type OidcIdentityVerifier,
} from "../enterprise/authorization.js";
import { OperatorActionService, type OperatorActionRequest } from "../enterprise/operator_actions.js";
import {
  consume_or_throw,
  RateLimitExceededError,
  type TenantRateLimiter,
} from "../rate_limit/tenant_rate_limiter.js";

/** Maximum operator request body accepted by this small control-plane API. */
export const MAX_OPERATOR_BODY_BYTES = 16 * 1024;

/** Sanitized API response. */
export interface OperatorApiResponse {
  status: number;
  body: Record<string, unknown>;
}

/** Dependencies for the operator API. */
export interface OperatorApiOptions {
  verifier: OidcIdentityVerifier;
  service: OperatorActionService;
  rate_limiter?: TenantRateLimiter;
  operator_limit?: number;
  operator_window_seconds?: number;
  request_id?: string;
}

/** Handle one versioned operator action request. */
export async function handle_operator_action(
  method: string,
  path: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
  raw_body: Buffer | string,
  options: OperatorApiOptions,
): Promise<OperatorApiResponse> {
  if (path !== "/v1/operator/actions") return { status: 404, body: { error: "not_found" } };
  if (method !== "POST") return { status: 405, body: { error: "method_not_allowed" } };
  if (Buffer.byteLength(raw_body) > MAX_OPERATOR_BODY_BYTES) {
    return { status: 413, body: { error: "payload_too_large" } };
  }
  const token = bearer_token(headers.authorization);
  if (token === undefined) return { status: 401, body: { error: "unauthenticated" } };
  let principal;
  try {
    principal = await require_oidc_verifier(options.verifier).verify(token);
  } catch (error) {
    return { status: error instanceof AuthorizationError && error.code === "unauthenticated" ? 401 : 403, body: { error: "unauthenticated" } };
  }
  const parsed = parse_action_body(raw_body);
  if (parsed === null) return { status: 400, body: { error: "invalid_operator_action" } };
  const request: OperatorActionRequest = {
    principal,
    tenant_id: parsed.tenant_id,
    action: parsed.action,
    target_id: parsed.target_id,
    request_id: options.request_id ?? randomUUID(),
    reason: parsed.reason,
  };
  try {
    options.service.authorize(request);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      try {
        await options.service.record_denial(request);
      } catch {
        return { status: 500, body: { error: "operator_action_failed" } };
      }
      return { status: error.code === "unauthenticated" ? 401 : 403, body: { error: error.code } };
    }
    return { status: 500, body: { error: "operator_action_failed" } };
  }
  if (options.rate_limiter !== undefined) {
    try {
      await consume_or_throw(options.rate_limiter, {
        tenant_id: parsed.tenant_id,
        scope: "operator",
        limit: options.operator_limit ?? 60,
        window_seconds: options.operator_window_seconds ?? 60,
      });
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return { status: 429, body: { error: "rate_limited", retry_after_seconds: error.decision.retry_after_seconds } };
      }
      return { status: 503, body: { error: "operator_temporarily_unavailable" } };
    }
  }
  try {
    const result = await options.service.execute(request);
    return { status: 200, body: { outcome: result.outcome, action: result.action, target_id: result.target_id } };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { status: error.code === "unauthenticated" ? 401 : 403, body: { error: error.code } };
    }
    return { status: 500, body: { error: "operator_action_failed" } };
  }
}

function is_action(value: string): value is OperatorActionRequest["action"] {
  return value === "replay_outbound" || value === "reconcile_orphan" || value === "release_hold" || value === "resolve_conflict" || value === "export_audit";
}

function bearer_token(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([A-Za-z0-9._~=-]{1,4096})$/.exec(value);
  return match?.[1];
}

function parse_action_body(value: Buffer | string): {
  tenant_id: string;
  action: OperatorActionRequest["action"];
  target_id: string;
  reason: string;
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value.toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.tenant_id !== "string" ||
    !/^[1-9]\d{0,18}$/.test(record.tenant_id) ||
    typeof record.target_id !== "string" ||
    record.target_id.length < 1 || record.target_id.length > 256 || record.target_id.trim() !== record.target_id ||
    typeof record.reason !== "string" ||
    record.reason.trim().length < 1 || record.reason.length > 512 ||
    typeof record.action !== "string" ||
    !is_action(record.action)
  ) return null;
  return {
    tenant_id: record.tenant_id,
    action: record.action as OperatorActionRequest["action"],
    target_id: record.target_id,
    reason: record.reason,
  };
}
