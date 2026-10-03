/**
 * Server-issued authorization receipt for one audited operator action.
 *
 * The dashboard's action panel is a client component, so before this module the
 * entire authorization decision happened in the browser against a principal the
 * browser also supplied. That is a UI hint, not a control: any client could have
 * posted a principal with `owner` in whatever tenant it liked.
 *
 * The fix keeps the change small by not moving the panel to the server. Instead
 * the client must present a receipt that only this module can mint, and this
 * module mints one exclusively after the *server* has authorized the exact tuple
 * (tenant, action, target, reason) against the *session-derived* principal. The
 * browser's own preflight then acts as a usability hint that must agree with the
 * server, and a disagreement fails closed.
 *
 * The receipt is an HMAC over a canonical string with an expiry, so it cannot be
 * replayed into a different action, target a different tenant, or reused after it
 * expires. It authorizes; it does not execute.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { OAuthFlowError } from "appointment-agent/dist/src/enterprise/oauth/index.js";
import { authorize, authorize_privileged, type AuthenticatedPrincipal } from "appointment-agent/dist/src/enterprise/authorization.js";

/** Environment variable holding the receipt signing key. */
export const ACTION_RECEIPT_KEY_ENV = "STAFF_ACTION_RECEIPT_KEY_BASE64";

/** Receipt lifetime in seconds; long enough for one submit, short enough to matter. */
export const ACTION_RECEIPT_TTL_SECONDS = 120;

const RECEIPT_VERSION = "r1";
const MAX_RECEIPT_CHARS = 512;
const KEY_BYTES = 32;
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TENANT_PATTERN = /^[1-9]\d{0,18}$/;
const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** The exact request tuple a receipt authorizes. */
export interface ActionAuthorization {
  tenant_id: string;
  action: string;
  target_id: string;
  reason: string;
}

/** An issued receipt plus the instant it stops being valid. */
export interface ActionReceipt {
  receipt: string;
  expires_at_ms: number;
}

/**
 * Sign the receipt key from deployment configuration.
 *
 * @param encoded_key - Canonical base64 encoding of exactly 32 random bytes.
 * @returns A copy of the key bytes.
 * @throws OAuthFlowError when the key is absent or malformed.
 */
export function parse_receipt_key(encoded_key: string | undefined): Buffer {
  if (
    typeof encoded_key !== "string" ||
    !CANONICAL_BASE64_PATTERN.test(encoded_key) ||
    encoded_key.length === 0
  ) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const key = Buffer.from(encoded_key, "base64");
  if (key.byteLength !== KEY_BYTES || key.toString("base64") !== encoded_key) {
    key.fill(0);
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return key;
}

/**
 * Decide whether the server authorizes one operator action.
 *
 * Privileged permissions go through `authorize_privileged`, so an unverified MFA
 * claim is a denial rather than a UI hint. A caller may not request the
 * non-privileged path for a privileged permission, because the permission mapping
 * is private to the enterprise contract and re-deriving it here would let a future
 * permission silently skip the MFA gate.
 *
 * @param principal - Principal resolved from the verified session cookie.
 * @param request - The exact tuple to authorize.
 * @param privileged - Whether the action is privileged and needs MFA.
 * @returns Null when authorized, otherwise a sanitized domain code.
 */
export function authorize_operator_action(
  principal: AuthenticatedPrincipal,
  request: ActionAuthorization,
  privileged: boolean,
): string | null {
  try {
    const checked = require_request(request);
    if (privileged) authorize_privileged(principal, checked.tenant_id, permission_for(checked.action));
    else authorize(principal, checked.tenant_id, permission_for(checked.action));
    return null;
  } catch (error) {
    return error instanceof Error && error.name === "AuthorizationError" ? code_of(error.message) : "operator_action_preflight_failed";
  }
}

/**
 * Mint a receipt for an already-authorized action.
 *
 * The payload is base64url-encoded JSON rather than a delimited string, because
 * a subject or session id may legitimately contain the delimiter characters and a
 * naive join would let one field be shifted into another.
 *
 * @param key - Signing key bytes from `parse_receipt_key`.
 * @param principal - Session-backed principal the decision was made for.
 * @param request - The exact authorized tuple.
 * @param issued_at_ms - Current time, injected so tests stay deterministic.
 * @returns The opaque receipt and its expiry.
 * @throws OAuthFlowError when the request tuple is malformed.
 */
export function issue_action_receipt(
  key: Buffer,
  principal: AuthenticatedPrincipal,
  request: ActionAuthorization,
  issued_at_ms: number,
): ActionReceipt {
  const checked = require_request(request);
  const expires_at_ms = issued_at_ms + ACTION_RECEIPT_TTL_SECONDS * 1_000;
  const nonce = randomBytes(8).toString("base64url");
  const payload = encode_payload(canonical_claims(checked, principal, expires_at_ms));
  const body = [RECEIPT_VERSION, nonce, String(expires_at_ms), payload].join(".");
  const signature = createHmac("sha256", require_key(key)).update(body).digest("base64url");
  return { receipt: `${body}.${signature}`, expires_at_ms };
}

/**
 * Verify a receipt against a request and the session's principal.
 *
 * Every field is checked: the version, the HMAC over the exact bytes presented,
 * the expiry, and a payload recomputed from the caller's own principal and
 * request. The last check is what stops a valid receipt for one action from being
 * replayed into another, or a different principal's receipt being presented by a
 * session that happens to hold a valid cookie.
 *
 * @param key - Signing key bytes.
 * @param receipt - The receipt the client presented.
 * @param principal - Session-backed principal presenting the receipt.
 * @param request - The tuple the caller is about to run.
 * @param now_ms - Current time, injected so tests stay deterministic.
 * @throws OAuthFlowError when the receipt is malformed, forged, expired, or was
 * issued for a different principal, tenant, action, target, or reason.
 */
export function verify_action_receipt(
  key: Buffer,
  receipt: string,
  principal: AuthenticatedPrincipal,
  request: ActionAuthorization,
  now_ms: number,
): void {
  const segments = split_receipt(require_receipt(receipt));
  if (segments.version !== RECEIPT_VERSION) throw new OAuthFlowError("oauth_configuration_invalid");
  if (segments.expires_at_ms <= now_ms) throw new OAuthFlowError("oauth_session_unavailable");
  const expected = createHmac("sha256", require_key(key))
    .update([segments.version, segments.nonce, String(segments.expires_at_ms), segments.payload].join("."))
    .digest("base64url");
  if (!constant_time_equal(expected, segments.signature)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  const checked = require_request(request);
  const expected_payload = encode_payload(canonical_claims(checked, principal, segments.expires_at_ms));
  if (!constant_time_equal(expected_payload, segments.payload)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
}

/** One parsed receipt segment. */
interface ReceiptSegments {
  version: string;
  nonce: string;
  expires_at_ms: number;
  payload: string;
  signature: string;
}

/** Split and bound a receipt's five segments. */
function split_receipt(receipt: string): ReceiptSegments {
  const parts = receipt.split(".");
  if (parts.length !== 5) throw new OAuthFlowError("oauth_configuration_invalid");
  const expires_at_ms = Number(parts[2]);
  if (!Number.isSafeInteger(expires_at_ms) || expires_at_ms <= 0) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return {
    version: parts[0] as string,
    nonce: parts[1] as string,
    expires_at_ms,
    payload: parts[3] as string,
    signature: parts[4] as string,
  };
}

/** Bound a receipt string before parsing it. */
function require_receipt(receipt: string): string {
  if (typeof receipt !== "string" || receipt.length === 0 || receipt.length > MAX_RECEIPT_CHARS) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return receipt;
}

/** Constant-time comparison helper shared with tests. */
export function constant_time_equal(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}

/** Validate the tuple shape before it is signed or authorized. */
function require_request(request: ActionAuthorization): ActionAuthorization {
  if (typeof request !== "object" || request === null) throw new OAuthFlowError("oauth_configuration_invalid");
  if (typeof request.tenant_id !== "string" || !TENANT_PATTERN.test(request.tenant_id)) {
    throw new OAuthFlowError("oauth_tenant_mismatch");
  }
  if (typeof request.action !== "string" || !ACTION_PATTERN.test(request.action)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  // Resolving the permission here means an action outside the audited union can
  // never reach the HMAC, so a receipt can never be minted for an action the
  // authorization contract does not know about.
  permission_for(request.action);
  if (typeof request.target_id !== "string" || !TARGET_PATTERN.test(request.target_id)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  if (typeof request.reason !== "string" || !REASON_PATTERN.test(request.reason)) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return {
    tenant_id: request.tenant_id,
    action: request.action,
    target_id: request.target_id,
    reason: request.reason,
  };
}

/** Claims bound into a receipt payload. */
interface ReceiptClaims {
  subject_id: string;
  session_id: string;
  has_mfa: boolean;
  tenant_id: string;
  action: string;
  target_id: string;
  reason: string;
  expires_at_ms: number;
}

/** Build the claims a receipt binds the request to. */
function canonical_claims(
  request: ActionAuthorization,
  principal: AuthenticatedPrincipal,
  expires_at_ms: number,
): ReceiptClaims {
  return {
    subject_id: principal.subject_id,
    session_id: principal.session_id,
    has_mfa: principal.has_mfa,
    tenant_id: request.tenant_id,
    action: request.action,
    target_id: request.target_id,
    reason: request.reason,
    expires_at_ms,
  };
}

/** Encode claims as base64url JSON so no field can shift across a delimiter. */
function encode_payload(claims: ReceiptClaims): string {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

/** Map an audited action to the permission the contract checks. */
function permission_for(action: string): Parameters<typeof authorize>[2] {
  switch (action) {
    case "resolve_conflict":
    case "release_hold":
    case "reconcile_orphan":
      return "appointments:reschedule";
    case "replay_outbound":
      return "outbound:replay";
    case "export_audit":
      return "audit:read";
    default:
      throw new OAuthFlowError("oauth_configuration_invalid");
  }
}

/** Extract the sanitized domain code from an AuthorizationError message. */
function code_of(message: string): string {
  const match = /^authorization-([a-z-]+)$/u.exec(message);
  return match?.[1]?.replace(/-/gu, "_") ?? "forbidden";
}

/** Require usable key bytes. */
function require_key(key: Buffer): Buffer {
  if (!(key instanceof Buffer) || key.byteLength !== KEY_BYTES) {
    throw new OAuthFlowError("oauth_configuration_invalid");
  }
  return key;
}